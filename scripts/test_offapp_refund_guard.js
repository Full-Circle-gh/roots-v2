#!/usr/bin/env node
/**
 * Offline self-test for the off-app refund guard — the rule that decides whether
 * an order's money is sitting at the WeChat gateway (refund it there) or was
 * taken off-app (record it; the operator hands the money back).
 *
 *   node scripts/test_offapp_refund_guard.js
 *
 * ── The bug this closes ───────────────────────────────────────────────────
 * Order TC000482 was keyed by staff in the back office (source='manual',
 * channel='wechat_chat' — a customer who messaged the shop) and the operator
 * picked plain 'wechat' as the tender, because that is how the customer paid:
 * a WeChat transfer, in a chat. No gateway charge was ever raised.
 *
 * Both guards read that row as gateway money anyway. 'wechat' is not in
 * OFFLINE_PAY_METHODS, and the row's out_trade_no is the bare order number
 * ('TC000482'), which does not start with 'MANUAL'. So a refund fired a real
 * WeChat Pay v3 refund against a transaction WeChat had never seen, got
 * '订单不存在' back, and 502'd the whole request — leaving the order
 * un-refundable by ANY amount and by ANY mode, full or partial, since the
 * status shortcut runs the same settle path.
 *
 * The discriminator is the ref itself. The two ORDER-create paths seed the
 * payment row with the bare order_no as a placeholder; only a PAY-create
 * overwrites it with the WX_OUT_TRADE_PREFIX'd ref actually sent to the
 * provider. A bare ref therefore means no charge was ever raised.
 *
 * No network, no keys, no DB file. Both halves read the SHIPPED source:
 *   • the predicates are sliced out of routes/retail.js and evaluated, so a
 *     change to the rule moves these tests;
 *   • the SQL mirror is sliced out too and run against an in-memory
 *     retail_payments built from database.js.
 *
 * What it locks down:
 *   1. THE CASE ITSELF — TC000482's exact row is not gateway money, and the
 *      ¥91 partial lands as a manual payout instead of a WeChat call.
 *   2. NO REGRESSION — every row that really did reach the gateway still does:
 *      the prefixed ref, and the legacy rows that predate it but carry callback
 *      evidence (transaction_id / raw_callback_json).
 *   3. THE TWO GUARDS AGREE — isGatewayPayment (JS) and
 *      orderHasRefundableGatewayMoney (SQL) are one rule in two languages, and
 *      a row they disagree on is the bug class that produced this one.
 *   4. THE BACKSTOP — a phantom transaction that still slips through degrades
 *      to a manual payout rather than failing the refund, and a REAL gateway
 *      error is still thrown so money problems stay loud.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail.push(`${name}: ${e.message}`); }
}

// ── Slicing the shipped source ────────────────────────────────────────────
// Same three readers as scripts/test_payment_mismatch.js, and for the same
// reason: each asserts it found its anchor, so a rename reports "not found in
// the shipped file" rather than quietly passing.

/** A statement: from `anchor` to the first `;` that is OUTSIDE a string. */
function sliceStatement(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') return src.slice(start, j + 1);
  }
  throw new Error(`no statement terminator after ${anchor}`);
}

/** A braced block (function or `if`): from `anchor` to its matching `}`. */
function sliceBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

/** The first template literal after `anchor`, returned WITH its backticks. */
function sliceTemplate(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('`', start + anchor.length);
  assert.notStrictEqual(open, -1, `no template literal after ${anchor}`);
  const close = src.indexOf('`', open + 1);
  assert.notStrictEqual(close, -1, `unterminated template literal after ${anchor}`);
  return src.slice(open, close + 1);
}

// ── The predicates, lifted out of routes/retail.js ────────────────────────
// EVALUATED, not pattern-matched: what these tests run is the code the route
// runs. The four are evaluated together because they close over each other
// (isGatewayPayment calls hasGatewayRef; both read the two constants).
const SRC = [
  sliceStatement(RETAIL_JS, 'const WX_OUT_TRADE_PREFIX ='),
  sliceStatement(RETAIL_JS, 'const OFFLINE_PAY_METHODS ='),
  sliceBlock(RETAIL_JS, 'function hasGatewayRef('),
  sliceBlock(RETAIL_JS, 'function isGatewayPayment('),
  sliceBlock(RETAIL_JS, 'function planRefundAllocation('),
  sliceBlock(RETAIL_JS, 'function isMissingTransactionError('),
].join('\n');
const R = vm.runInNewContext(
  `${SRC}
   ({ WX_OUT_TRADE_PREFIX, OFFLINE_PAY_METHODS, hasGatewayRef, isGatewayPayment,
      planRefundAllocation, isMissingTransactionError })`,
  {}
);

// The SQL mirror, with the same ${ph} the route builds it with.
const OFFLINE = [...R.OFFLINE_PAY_METHODS];
const GATEWAY_SQL = vm.runInNewContext(
  `(() => { const ph = ${JSON.stringify(OFFLINE.map(() => '?').join(','))};
            return ${sliceTemplate(RETAIL_JS, 'function orderHasRefundableGatewayMoney(')}; })()`,
  {}
);

// ── The database ──────────────────────────────────────────────────────────
const { openTablesDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// One payment row, named by what it IS. Everything defaults to TC000482's shape
// — the case under test — and each fixture overrides the one field that makes
// it different, which is what keeps the "and nothing else" assertions honest.
let seq = 0;
function row(over = {}) {
  return {
    id: ++seq, order_id: 1, method: 'wechat', amount: 356.60, status: 'success',
    out_trade_no: 'TC000482', transaction_id: null, raw_callback_json: null,
    refunded_amount: 0, ...over,
  };
}
// The row as isGatewayPayment sees it — i.e. the shape
// settleOrderRefundAcrossTenders' SELECT produces (has_callback, not the blob).
const asJs = (r) => ({
  id: r.id, method: r.method, amount: r.amount, out_trade_no: r.out_trade_no,
  transaction_id: r.transaction_id, has_callback: r.raw_callback_json != null ? 1 : 0,
  refunded_amount: r.refunded_amount,
});
// The same row through the SQL guard, alone in its own order.
function sqlSaysGateway(r) {
  const db = openTablesDb(DATABASE_JS, ['retail_payments']);
  db.prepare(
    `INSERT INTO retail_payments
       (order_id, method, amount, status, out_trade_no, transaction_id,
        raw_callback_json, refunded_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.order_id, r.method, r.amount, r.status, r.out_trade_no,
    r.transaction_id, r.raw_callback_json, r.refunded_amount);
  const hit = db.prepare(GATEWAY_SQL).get(r.order_id, ...OFFLINE, R.WX_OUT_TRADE_PREFIX + '%');
  db.close();
  return !!hit;
}

// ── 1. The case itself ────────────────────────────────────────────────────
// TC000482: staff-keyed, tender 'wechat', ref = the bare order number. The
// customer's money never reached the gateway, so nothing there can be refunded.
const TC482 = row();

check('TC000482 is not gateway money (JS)', () => {
  assert.strictEqual(R.isGatewayPayment(asJs(TC482)), false);
});
check('TC000482 is not gateway money (SQL)', () => {
  assert.strictEqual(sqlSaysGateway(TC482), false);
});
check('the ¥91 partial plans as a manual payout, not a WeChat call', () => {
  const { plan, unallocated } = R.planRefundAllocation([asJs(TC482)], 91);
  assert.strictEqual(plan.length, 1, 'the refund still allocates against the row');
  assert.strictEqual(plan[0].take, 91, 'for the full ¥91');
  assert.strictEqual(plan[0].gateway, false, 'but NOT through the gateway');
  assert.strictEqual(unallocated, 0, 'and nothing is left stranded');
});
check('a FULL refund of TC000482 is a manual payout too', () => {
  // The status shortcut refunds the whole total down this same path, so the
  // fix has to cover it — this order was un-refundable by every mode.
  const { plan, unallocated } = R.planRefundAllocation([asJs(TC482)], 356.60);
  assert.strictEqual(plan[0].gateway, false);
  assert.strictEqual(plan[0].take, 356.60);
  assert.strictEqual(unallocated, 0);
});

// ── 2. No regression: real gateway money still refunds at the gateway ─────
const REAL_GATEWAY = [
  ['mini-app order (prefixed ref)', row({ out_trade_no: 'FCTC000123' })],
  ['settled by async callback', row({ out_trade_no: 'FCTC000124', transaction_id: '42000012' })],
  // The poll-settled path (payment/status) stamps the prefix but never a
  // transaction_id — the prefix alone has to carry it, or those stop refunding.
  ['settled by status poll (prefix only)', row({ out_trade_no: 'FCTC000125' })],
  // Legacy rows minted before the prefix existed: the bare ref looks exactly
  // like TC000482's, and only the callback evidence separates them.
  ['legacy bare ref + transaction_id', row({ out_trade_no: 'R260618156719', transaction_id: '42000099' })],
  ['legacy bare ref + raw_callback_json', row({ out_trade_no: 'R260618156720', raw_callback_json: '{"trade_state":"SUCCESS"}' })],
  ['alipay via the same prefix', row({ method: 'alipay', out_trade_no: 'FCTC000126' })],
];
for (const [name, r] of REAL_GATEWAY) {
  check(`still gateway money: ${name} (JS)`, () => {
    assert.strictEqual(R.isGatewayPayment(asJs(r)), true);
  });
  check(`still gateway money: ${name} (SQL)`, () => {
    assert.strictEqual(sqlSaysGateway(r), true);
  });
}

// Rows that were already correctly off-app stay off-app.
const OFF_APP = [
  ['manual "Mark paid" ref', row({ method: 'cash', out_trade_no: 'MANUAL7-123456' })],
  ['off-app WeChat tender', row({ method: 'wechat_offline', out_trade_no: 'FCTC000127' })],
  ['bank transfer', row({ method: 'bank_transfer', out_trade_no: 'MANUAL8-123456' })],
  ['staff-keyed alipay, bare ref', row({ method: 'alipay', out_trade_no: 'TC000483' })],
  ['fully refunded already', row({ out_trade_no: 'FCTC000128', refunded_amount: 356.60 })],
];
for (const [name, r] of OFF_APP) {
  check(`not gateway money: ${name} (SQL)`, () => {
    assert.strictEqual(sqlSaysGateway(r), false);
  });
}

// ── 3. The two guards are one rule ────────────────────────────────────────
// The original defect was exactly this disagreement class, so assert it
// directly across every fixture above rather than trusting the pairs to drift
// together. (The refunded_amount case is JS-side out of scope — the SQL guard
// owns the remaining-balance test, planRefundAllocation owns it in JS — so it
// is compared on the money-holding rows only.)
for (const [name, r] of [['TC000482', TC482], ...REAL_GATEWAY, ...OFF_APP.slice(0, 4)]) {
  check(`JS and SQL agree on: ${name}`, () => {
    assert.strictEqual(R.isGatewayPayment(asJs(r)), sqlSaysGateway(r),
      'isGatewayPayment and orderHasRefundableGatewayMoney disagree');
  });
}

// ── 4. The backstop ───────────────────────────────────────────────────────
// A phantom transaction that still reaches WeChat must degrade to a manual
// payout; anything else must keep throwing so real money problems stay loud.
check('ORDERNOTEXIST by v3 error code degrades', () => {
  assert.strictEqual(R.isMissingTransactionError(
    Object.assign(new Error('wechat_refund_failed: ...'), { wxCode: 'ORDERNOTEXIST' })), true);
});
check('RESOURCE_NOT_EXISTS degrades', () => {
  assert.strictEqual(R.isMissingTransactionError(
    Object.assign(new Error('wechat_refund_failed: ...'), { wxCode: 'RESOURCE_NOT_EXISTS' })), true);
});
check('the Chinese message alone degrades', () => {
  assert.strictEqual(R.isMissingTransactionError(new Error('wechat_refund_failed: 订单不存在')), true);
});
check('insufficient balance still THROWS', () => {
  assert.strictEqual(R.isMissingTransactionError(
    Object.assign(new Error('wechat_refund_failed: 余额不足'), { wxCode: 'NOTENOUGH' })), false);
});
check('a signature error still THROWS', () => {
  assert.strictEqual(R.isMissingTransactionError(
    Object.assign(new Error('wechat_refund_failed: signature error'), { wxCode: 'SIGN_ERROR' })), false);
});
check('a network failure still THROWS', () => {
  assert.strictEqual(R.isMissingTransactionError(new Error('fetch failed')), false);
});
check('no error object is not a missing transaction', () => {
  assert.strictEqual(R.isMissingTransactionError(null), false);
});

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\n  ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  ✓ off-app refund guard holds');
