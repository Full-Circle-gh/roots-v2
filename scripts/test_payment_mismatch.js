#!/usr/bin/env node
/**
 * Offline self-test for the payment-mismatch notification — the dashboard fire
 * that surfaces an order whose Alipay proof was READ and REJECTED, and the
 * deep link from that fire into the order.
 *
 *   node scripts/test_payment_mismatch.js
 *
 * The hole it closes: validateAlipayProof returns 'mismatch', the auto-flip is
 * skipped, and the order stays in pending_payment looking exactly like an order
 * nobody ever paid for. The customer believes they have paid. Nothing retried
 * it, nothing timed it out, and no surface counted it — so it waited until
 * somebody happened to open that one order.
 *
 * No network, no keys, no browser. Both halves read the SHIPPED source:
 *   • the server half slices the real SQL out of routes/retail.js and runs it
 *     against an in-memory retail_orders built from database.js, so a change to
 *     the predicate moves these tests;
 *   • the client half slices the real functions out of public/retail-admin/*.js
 *     and evaluates them against stubs, same technique as
 *     scripts/test_needs_point_client.js.
 *
 * What it locks down:
 *   1. WHO IS IN THE QUEUE — a rejected proof on a pending order, and nothing
 *      else: not a match, not an unreadable 'error', not a mismatch a human has
 *      already judged (marked paid / cancelled), not a read-only channel mirror.
 *   2. SELF-CLEARING — the same rows leave the queue on the two actions an
 *      operator can take, with no "handled" flag to forget to set.
 *   3. NOT A STAGE — there is no pseudo-status, no chip and no badge for it,
 *      and the order is still plainly Pending. An earlier build gave it a
 *      "Payment check" chip beside Pending; that invented a status the order
 *      does not have, and an operator scanning Pending for the money they were
 *      owed no longer found it there. These assertions stop it coming back.
 *   4. THE CLOCK — the queue ages from the proof upload, and a row with no
 *      proof stamp still gets a never-null age (placed_at) rather than a NaN.
 *   5. THE ROW'S WORDS — the amount gap is stated only when we actually read an
 *      amount AND it differs; a mismatch on payee/time says nothing false.
 *   6. THE DOOR — the fire opens the PENDING list, the chip the order is
 *      already in. A rejected proof is not a stage: the order never moved, so
 *      neither does its place in the Orders list, and the row there carries the
 *      mark that says which one it is.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DASH_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

// ── Slicing the shipped source ────────────────────────────────────────────
// Three shapes are needed and each has its own reader, because a single clever
// one would be the thing that silently matches the wrong text. Every reader
// asserts it found its anchor: a rename produces "not found in the shipped
// file", never a quietly-passing test.

/** A statement: from `anchor` to the first `;` that is OUTSIDE a string. */
function sliceStatement(src, anchor, { from } = {}) {
  const base = from ? src.indexOf(from) : 0;
  assert.notStrictEqual(base, -1, `anchor comment not found: ${from}`);
  const start = src.indexOf(anchor, base);
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
function sliceBlock(src, anchor, { from } = {}) {
  const base = from ? src.indexOf(from) : 0;
  assert.notStrictEqual(base, -1, `anchor comment not found: ${from}`);
  const start = src.indexOf(anchor, base);
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

// ── The one predicate, lifted out of routes/retail.js ─────────────────────
// EVALUATED, not pattern-matched: what these tests run is the string the route
// will hand to SQLite.
//
// One, and only one. This suite briefly carried three — the dashboard block, an
// Orders pseudo-status and a chip badge — and section 3 exists to keep it that
// way: the queue is a notification, not a place an order goes.
const PM_WHERE_SRC = sliceStatement(RETAIL_JS, 'const pmWhere =');
const PM_ITEMS_SQL_SRC = sliceTemplate(RETAIL_JS, 'const pmItems = tdb().prepare(');
const pmItemsSql = (storeId) =>
  vm.runInNewContext(`(() => { ${PM_WHERE_SRC} return ${PM_ITEMS_SQL_SRC}; })()`, { storeId });

// Its sibling: a proof on file that was NOT rejected and is still unpaid.
const PU_WHERE_SRC = sliceStatement(RETAIL_JS, 'const puWhere =');
const PU_ITEMS_SQL_SRC = sliceTemplate(RETAIL_JS, 'const puItems = tdb().prepare(');
const puItemsSql = (storeId) =>
  vm.runInNewContext(`(() => { ${PU_WHERE_SRC} return ${PU_ITEMS_SQL_SRC}; })()`, { storeId });
const PU_UNREAD_SQL_SRC = sliceTemplate(RETAIL_JS, 'const puUnread = tdb().prepare(');
const puUnreadSql = (storeId) =>
  vm.runInNewContext(`(() => { ${PU_WHERE_SRC} return ${PU_UNREAD_SQL_SRC}; })()`, { storeId });

// The clause the stale-pending sweep exempts on — read from the sweep itself,
// so the coverage proof below is against the real rule and not a paraphrase.
const SWEEP_EXEMPT_SRC = sliceBlock(RETAIL_JS, 'function cancelStalePendingOrdersForTenant()');

// ── The database ──────────────────────────────────────────────────────────
const { openTablesDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

function freshDb() {
  return openTablesDb(DATABASE_JS, ['retail_orders', 'retail_customers']);
}

// One order, named by what it IS, so a failure names the case rather than a row
// id. Everything defaults to the case under test — a rejected proof on a
// pending order — and each fixture overrides the one field that makes it
// different, which is what keeps the "and nothing else" assertions honest.
let seq = 0;
function seed(db, row = {}) {
  const r = {
    status: 'pending_payment', verdict: 'mismatch', channel: 'wechat', store_id: 1,
    total: 318.20, ocr: { amount: 318.00, reasons: ['amount ¥318.00 < expected ¥318.20'] },
    proof_at: '2026-08-22 06:45:00', placed_at: '2026-08-22 06:40:00',
    // A proof on file by default — that is what every case here has in common,
    // and it is the exact column the stale-pending sweep exempts on. Pass
    // `proof: null` for an order nobody ever paid for.
    proof: 'data:image/jpeg;base64,/9j/EXAMPLE', ...row,
  };
  const no = 'TC0009' + String(++seq).padStart(2, '0');
  db.prepare(`INSERT INTO retail_orders
      (order_no, status, total, channel, store_id, placed_at,
       alipay_ocr_verdict, alipay_ocr_json, alipay_proof_at, alipay_proof_image,
       payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alipay')`)
    .run(no, r.status, r.total, r.channel, r.store_id, r.placed_at,
      r.verdict, r.ocr === null ? null : JSON.stringify(r.ocr), r.proof_at, r.proof);
  return no;
}
// What the block says about the table, as a set of order_nos.
const opsRows = (db, storeId = '') => db.prepare(pmItemsSql(storeId))
  .all(storeId ? { store_id: storeId, preview: 50 } : { preview: 50 });
const opsNos = (db, storeId = '') => opsRows(db, storeId).map(r => r.order_no);
const puRows = (db, storeId = '') => db.prepare(puItemsSql(storeId))
  .all(storeId ? { store_id: storeId, preview: 50 } : { preview: 50 });
const puNos = (db, storeId = '') => puRows(db, storeId).map(r => r.order_no);
const puUnread = (db) => db.prepare(puUnreadSql('')).get({}).n;

(async () => {

// ─────────────────────────────────────────────────────────────────────────
console.log('\n1 · who is in the queue');

it('a rejected proof on a pending order is in it', () => {
  const db = freshDb();
  const no = seed(db);
  assert.deepStrictEqual(opsNos(db), [no]);
});

it("a proof that MATCHED is not — the money was confirmed", () => {
  const db = freshDb();
  seed(db, { verdict: 'match' });
  assert.deepStrictEqual(opsNos(db), []);
});

it("an unreadable proof ('error') is not — that is a re-read, not a money dispute", () => {
  // It has its own button in the drawer ("Try reading again"). Putting it on the
  // same fire would make "Payment doesn't match" say something untrue about it.
  const db = freshDb();
  seed(db, { verdict: 'error', ocr: { error: 'vision timeout' } });
  assert.deepStrictEqual(opsNos(db), []);
});

it('an order with no proof at all is not', () => {
  const db = freshDb();
  seed(db, { verdict: null, ocr: null, proof_at: null });
  assert.deepStrictEqual(opsNos(db), []);
});

it('a read-only channel mirror is not — it is not our operator’s worklist', () => {
  const db = freshDb();
  seed(db, { channel: 'meituan' });
  seed(db, { channel: 'gzgrocery' });
  assert.deepStrictEqual(opsNos(db), []);
});

it('the queue is exactly the rejected-and-still-pending rows, among all of them', () => {
  // Non-vacuous: every neighbour above is present in one table, so a predicate
  // that lost a clause would show up here as an extra row.
  const db = freshDb();
  const wanted = seed(db);
  seed(db, { verdict: 'match' });
  seed(db, { verdict: 'error' });
  seed(db, { verdict: null, ocr: null });
  seed(db, { channel: 'meituan' });
  seed(db, { status: 'paid' });
  seed(db, { status: 'cancelled' });
  assert.deepStrictEqual(opsNos(db), [wanted]);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · it clears itself — there is no "handled" flag to forget');

it('marking it paid takes it out of the queue', () => {
  const db = freshDb();
  const no = seed(db);
  assert.deepStrictEqual(opsNos(db), [no], 'in the queue to begin with');
  db.prepare("UPDATE retail_orders SET status = 'paid' WHERE order_no = ?").run(no);
  assert.deepStrictEqual(opsNos(db), [], 'a human judged it — it is done work now');
});

it('cancelling it takes it out of the queue', () => {
  const db = freshDb();
  const no = seed(db);
  db.prepare("UPDATE retail_orders SET status = 'cancelled' WHERE order_no = ?").run(no);
  assert.deepStrictEqual(opsNos(db), []);
});

it('a re-read that now matches takes it out of the queue', () => {
  // rerunAlipayOcr overwrites the verdict; nothing else needs to happen.
  const db = freshDb();
  const no = seed(db);
  db.prepare("UPDATE retail_orders SET alipay_ocr_verdict = 'match' WHERE order_no = ?").run(no);
  assert.deepStrictEqual(opsNos(db), []);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · a rejected proof is NOT a stage of its own');

// The order never moved, so its place in the Orders list must not move either.
// This was briefly built the other way — a "Payment check" chip beside Pending
// — and that chip invented a status the order does not have: the same order
// appeared to be in two states, and an operator scanning Pending for the money
// they were owed no longer found it there. These tests are what stop it coming
// back.

it('the orders list has no payment_mismatch filter to reach', () => {
  assert.ok(!/status === 'payment_mismatch'/.test(RETAIL_JS),
    'a pseudo-status branch is back in the orders list route');
});

it('order-status-counts ships no badge for it', () => {
  assert.ok(!/out\.payment_mismatch/.test(RETAIL_JS),
    'a chip badge count is back on /order-status-counts');
});

it('the chip row carries no such chip', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
  assert.ok(!/data-status="payment_mismatch"/.test(html), 'the Payment check chip is back');
  assert.ok(!/oc-payment_mismatch/.test(html), 'its badge slot is back');
  // Non-vacuous: the chip the fire DOES point at has to be there.
  assert.ok(/data-status="pending_payment"/.test(html), 'the Pending chip is missing');
});

it('a rejected proof still sits in the plain Pending list, counted as pending', () => {
  // The point of the whole shape: nothing about the order changed, so the
  // Pending chip's own filter still finds it and its badge still counts it.
  const db = freshDb();
  const no = seed(db);
  const inPending = db.prepare(
    "SELECT order_no FROM retail_orders WHERE status = 'pending_payment'"
  ).all().map(r => r.order_no);
  assert.deepStrictEqual(inPending, [no]);
});

it('the fire follows the dashboard store picker, like every sibling on /dashboard/ops', () => {
  const db = freshDb();
  const mine = seed(db, { store_id: 1 });
  const theirs = seed(db, { store_id: 2 });
  assert.deepStrictEqual(opsNos(db, '1'), [mine], 'store-scoped fire sees one shelf');
  assert.deepStrictEqual(opsNos(db, '').slice().sort(), [mine, theirs].sort(),
    'all-stores view sees both');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4 · the clock');

it('ages from when the CUSTOMER uploaded the proof, not from when we noticed', () => {
  const db = freshDb();
  const no = seed(db, { proof_at: '2026-08-22 06:45:00', placed_at: '2026-08-22 02:00:00' });
  const row = opsRows(db).find(r => r.order_no === no);
  assert.strictEqual(row.waiting_since, '2026-08-22 06:45:00');
});

it('a row with no proof stamp still gets an age — never null, never NaN', () => {
  // A verdict written by a re-read on an older order, or a migrated row.
  const db = freshDb();
  const no = seed(db, { proof_at: null, placed_at: '2026-08-20 09:00:00' });
  const row = opsRows(db).find(r => r.order_no === no);
  assert.strictEqual(row.waiting_since, '2026-08-20 09:00:00');
  assert.strictEqual(row.alipay_proof_at, null, 'the raw column stays truthful');
});

it('the longest-waiting customer is first, so the card ages off the true oldest', () => {
  const db = freshDb();
  const recent = seed(db, { proof_at: '2026-08-22 06:45:00' });
  const oldest = seed(db, { proof_at: '2026-08-21 11:00:00' });
  const middle = seed(db, { proof_at: '2026-08-22 01:00:00' });
  assert.deepStrictEqual(opsNos(db), [oldest, middle, recent]);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n5 · what the row is allowed to say');

// The mapping half of the block — the part that turns a stored OCR blob into
// the two numbers the card prints. Sliced from the route so a change to the
// shape moves this test.
// Anchored WITHOUT the arrow's brace so the brace counter starts on it — with
// the brace inside the anchor it would start on the first `{` in the body and
// slice out a fragment. The closing `)` of .map( is put back by hand.
const PM_MAP_SRC = sliceBlock(RETAIL_JS, 'items: pmItems.map(o => ') + ')';
const mapOne = (row) => vm.runInNewContext(
  `(() => { const pmItems = [row]; const out = { ${PM_MAP_SRC} }; return out.items[0]; })()`,
  { row: { id: 1, order_no: 'TC000864', total: 318.20, alipay_proof_at: null, waiting_since: 'x', buyer: null, ...row } });

it('reads the paid amount off the stored OCR blob', () => {
  const r = mapOne({ alipay_ocr_json: JSON.stringify({ amount: 318.00, reasons: ['amount ¥318.00 < expected ¥318.20'] }) });
  assert.strictEqual(r.paid_amount, 318.00);
  assert.strictEqual(r.total, 318.20);
  assert.strictEqual(r.reason, 'amount ¥318.00 < expected ¥318.20');
});

it('an amount the read could not put a number on is null, never 0', () => {
  // ¥0.00 on the card would read as "they paid nothing", which is a different
  // and much worse claim than "we could not read it".
  const r = mapOne({ alipay_ocr_json: JSON.stringify({ reasons: ['amount unreadable < expected ¥318.20'] }) });
  assert.strictEqual(r.paid_amount, null);
});

it('a corrupt OCR blob does not take the block down', () => {
  const r = mapOne({ alipay_ocr_json: '{not json' });
  assert.strictEqual(r.paid_amount, null);
  assert.strictEqual(r.reason, null);
});

it('no reasons at all → null, never an empty string', () => {
  const r = mapOne({ alipay_ocr_json: JSON.stringify({ amount: 5 }) });
  assert.strictEqual(r.reason, null);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n6 · the fire the dashboard builds');

// The push, sliced out of tdAttnRender and run against stubs — so the words,
// the severity and the door are read off the shipped file.
const FIRE_SRC = sliceBlock(DASH_JS, 'if (pm.count && dashCardWants(\'orders\'))',
  { from: '// Payment read but rejected' });
function buildFire(payment_mismatch, { can = true } = {}) {
  const fires = [];
  vm.runInNewContext(
    `const pm = DASH_OPS.payment_mismatch || { count: 0, items: [] }; ${FIRE_SRC}`,
    {
      fires, DASH_OPS: { payment_mismatch },
      dashCardWants: () => can,
      cuT: (en) => en,                       // assert on the EN half
      dashMoney: (n, dp) => '¥' + Number(n).toFixed(dp),
      tdOldestMins: (items) => (items || []).length ? 240 : null,
    });
  return fires[0] || null;
}

it('one order → the row states the actual gap', () => {
  const f = buildFire({ count: 1, items: [{ id: 7, paid_amount: 318.00, total: 318.20 }] });
  assert.strictEqual(f.state, 'paid ¥318.00, order ¥318.20');
  assert.strictEqual(f.sev, 'brick', 'money in dispute is never amber');
  assert.strictEqual(f.n, 1);
});

it('several orders → a count and an age, because no pair of numbers is true of them all', () => {
  const f = buildFire({ count: 3, items: [{ id: 7, paid_amount: 1, total: 2 }, { id: 8 }] });
  assert.strictEqual(f.state, null);
  assert.strictEqual(f.n, 3);
  assert.strictEqual(f.mins, 240);
});

it('a mismatch that is NOT about the amount says nothing about amounts', () => {
  // Wrong payee, stale receipt, or a screenshot already spent on another order:
  // the two numbers agree, and printing "paid ¥50.00, order ¥50.00" would read
  // as a bug in our own arithmetic.
  const f = buildFire({ count: 1, items: [{ id: 7, paid_amount: 50, total: 50, reason: 'payee doesn’t match' }] });
  assert.strictEqual(f.state, null);
});

it('an amount we could not read says nothing either', () => {
  const f = buildFire({ count: 1, items: [{ id: 7, paid_amount: null, total: 50 }] });
  assert.strictEqual(f.state, null);
});

it('an operator who cannot see orders gets no fire they cannot act on', () => {
  assert.strictEqual(buildFire({ count: 2, items: [{ id: 7 }] }, { can: false }), null);
});

it('nothing rejected → no fire at all', () => {
  assert.strictEqual(buildFire({ count: 0, items: [] }), null);
});

// The row's own meta line — state and age together, which no fire before this
// one carried.
const META_SRC = sliceBlock(DASH_JS, 'function tdAttnRowHtml(f)');
function metaOf(f) {
  const ctx = {
    cuT: (en) => en, dashAgeShort: (m) => `${Math.round(m / 60)}h`,
    escapeHtml: (s) => s, escapeAttr: (s) => s, TD_ATTN_ICON: {},
  };
  vm.createContext(ctx);
  new vm.Script(`${META_SRC}; var __out = tdAttnRowHtml(${JSON.stringify(f)});`).runInContext(ctx);
  const m = /class="td-nmeta"[^>]*>([^<]*)</.exec(ctx.__out);
  return m ? m[1] : '';
}

it('a fire with both a state and an age prints both', () => {
  assert.strictEqual(metaOf({ sev: 'brick', label: 'x', n: 1, cta: 'y', state: 'paid ¥318.00, order ¥318.20', mins: 240 }),
    'paid ¥318.00, order ¥318.20, oldest 4h');
});

it('the fires that had only one of the two are unchanged', () => {
  // Restock states its condition and has no age; the queues have an age and no
  // state. Neither may gain a stray comma from the join.
  assert.strictEqual(metaOf({ sev: 'amber', label: 'x', n: 1, cta: 'y', state: 'out of stock', mins: null }), 'out of stock');
  assert.strictEqual(metaOf({ sev: 'amber', label: 'x', n: 1, cta: 'y', mins: 120 }), 'oldest 2h');
  assert.strictEqual(metaOf({ sev: 'amber', label: 'x', n: 1, cta: 'y', mins: null }), '');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n7 · the door — where a click on the fire lands');

// The fire's `go` is read off the shipped push rather than asserted as a
// string in two places, so renaming the destination moves this test.
const FIRE_GO = buildFire({ count: 2, items: [{ id: 864 }] });

it('the fire opens the Pending list — not a chip of its own, not a drawer', () => {
  assert.strictEqual(FIRE_GO.go, "tdSecOpenOrders('pending_payment')");
});

it('the destination is the chip that already exists', () => {
  // tdSecOpenOrders is a silent no-op when no chip carries the data-status it
  // is handed, so a typo here would be a dead click with nothing to show for
  // it. This is the assertion that makes the one above non-vacuous.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
  const target = /go: "tdSecOpenOrders\('([a-z_]+)'\)"/.exec(
    sliceBlock(DASH_JS, "if (pm.count && dashCardWants('orders'))", { from: '// Payment read but rejected' }));
  assert.ok(target, 'the fire no longer routes through tdSecOpenOrders');
  assert.ok(new RegExp(`data-status="${target[1]}"`).test(html),
    `the fire points at a chip that does not exist: ${target[1]}`);
});

it('nothing opens the order drawer from the dashboard any more', () => {
  // The build this replaced opened one order's drawer focused on its Alipay
  // card. That path and everything that served it is gone, not merely unused:
  // a dead helper reads as a live feature to the next person.
  assert.ok(!/dashOpenPaymentMismatch/.test(DASH_JS), 'the old opener is still here');
  assert.ok(!/odFocusPaymentSection/.test(ORDERS_JS), 'the scroll helper is still here');
  assert.ok(!/focus === 'payment'/.test(ORDERS_JS), "openOrder still honours focus: 'payment'");
  assert.ok(!/ap-proof-/.test(ORDERS_JS), 'the proof card still carries its scroll anchor');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n8 · the list row says why a pending order is still pending');

const LINE_SRC = sliceBlock(ORDERS_JS, 'function paymentCheckLine(o)');
function lineFor(o) {
  const ctx = {
    cuT: (en) => en, escapeAttr: (s) => s,
    ICON_PAY_CHECK: '<svg/>', ICON_PAY_OK: '<svg/>',
  };
  vm.createContext(ctx);
  new vm.Script(`${LINE_SRC}; var __out = paymentCheckLine(${JSON.stringify(o)});`).runInContext(ctx);
  return ctx.__out;
}

it('a rejected proof on a pending row is called out', () => {
  const html = lineFor({ alipay_ocr_verdict: 'mismatch', status: 'pending_payment' });
  assert.ok(/is-alert/.test(html), 'brick, not brass — this is money in dispute');
  assert.ok(/Payment doesn't match/.test(html));
});

it('an order a human already marked paid says nothing — the verdict is history', () => {
  assert.strictEqual(lineFor({ alipay_ocr_verdict: 'mismatch', status: 'paid' }), '');
});

it('a verified-but-unconfirmed proof asks for the click, in brass not brick', () => {
  const html = lineFor({ alipay_ocr_verdict: 'match', status: 'pending_payment', has_alipay_proof: 1 });
  assert.ok(/is-owed/.test(html), 'nothing is wrong here — it must not wear the brick');
  assert.ok(!/is-alert/.test(html));
  assert.ok(/Payment verified/.test(html));
});

it('a proof nobody could read, and one nobody ran, both say "not checked yet"', () => {
  for (const v of ['error', null]) {
    const html = lineFor({ alipay_ocr_verdict: v, status: 'pending_payment', has_alipay_proof: 1 });
    assert.ok(/Payment not checked yet/.test(html), `verdict ${v} says nothing`);
    assert.ok(/is-owed/.test(html), `verdict ${v} must not claim the money is wrong`);
  }
});

it('an order with NO proof says nothing — the Pending pill already covers it', () => {
  // The distinction has_alipay_proof exists to draw: "nobody ever paid" is not
  // "somebody paid and we have not looked".
  assert.strictEqual(lineFor({ status: 'pending_payment' }), '');
  assert.strictEqual(lineFor({ status: 'pending_payment', has_alipay_proof: 0 }), '');
});

it('the list SELECTs the proof-presence flag the row branches on', () => {
  assert.ok(/\(o\.alipay_proof_image IS NOT NULL\) AS has_alipay_proof/.test(RETAIL_JS),
    'without it every row falls to the no-proof branch and says nothing');
  // And never the blob itself — it is a data URI, one per row, through a poll.
  assert.ok(!/^\s*o\.alipay_proof_image,$/m.test(RETAIL_JS),
    'the screenshot itself must never ride the orders list');
});

it('the list actually SELECTs the column the row reads', () => {
  // The row is built from the list payload; without the column every row would
  // quietly render nothing, which is the bug this whole file is about.
  assert.ok(/^\s*o\.alipay_ocr_verdict,$/m.test(RETAIL_JS),
    'o.alipay_ocr_verdict is missing from the orders list SELECT');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n9 · the sibling queue — a proof nobody has accepted');

it('a verified proof on a still-unpaid order is in it (auto-flip off)', () => {
  // Nothing is wrong with this one. The read matched; the operator has chosen
  // to confirm payments by hand, so the money is only ours once they click.
  const db = freshDb();
  const no = seed(db, { verdict: 'match' });
  assert.deepStrictEqual(puNos(db), [no]);
});

it('a proof the read could not handle is in it', () => {
  const db = freshDb();
  const no = seed(db, { verdict: 'error', ocr: { error: 'vision timeout' } });
  assert.deepStrictEqual(puNos(db), [no]);
});

it('a proof the read never ran on is in it — the OCR-off tenant', () => {
  // The case that decided the COALESCE in the predicate: a bare
  // `alipay_ocr_verdict <> 'mismatch'` is NULL for this row, so SQL drops it —
  // and on a tenant with no vision key that is EVERY proof they receive.
  const db = freshDb();
  const no = seed(db, { verdict: null, ocr: null });
  assert.deepStrictEqual(puNos(db), [no], 'a NULL verdict must not fall through the predicate');
});

it('a REJECTED proof is not — its brick sibling owns it, one order one fire', () => {
  const db = freshDb();
  seed(db, { verdict: 'mismatch' });
  assert.deepStrictEqual(puNos(db), []);
});

it('an order nobody ever paid for is not — no proof, nothing to accept', () => {
  const db = freshDb();
  seed(db, { proof: null, verdict: null, ocr: null });
  assert.deepStrictEqual(puNos(db), []);
});

it('an order already marked paid is not', () => {
  const db = freshDb();
  seed(db, { verdict: 'match', status: 'paid' });
  assert.deepStrictEqual(puNos(db), []);
});

it('the unread count is exact and excludes the verified ones', () => {
  // The row says "N couldn't be read" in words, so this number can never be
  // derived from the capped preview.
  const db = freshDb();
  seed(db, { verdict: 'match' });
  seed(db, { verdict: 'match' });
  seed(db, { verdict: 'error' });
  seed(db, { verdict: null, ocr: null });
  assert.strictEqual(puNos(db).length, 4, 'all four are waiting on a person');
  assert.strictEqual(puUnread(db), 2, 'only the two nobody could read');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n10 · the two queues cover the sweep\u2019s blind spot exactly');

it('the sweep really does exempt every order with a proof on file', () => {
  // Read off cancelStalePendingOrdersForTenant, not asserted from memory — an
  // earlier version of this work claimed the opposite in a code comment.
  assert.ok(/NOT \(payment_method = 'alipay' AND alipay_proof_image IS NOT NULL\)/.test(SWEEP_EXEMPT_SRC),
    'the hours rule no longer exempts orders carrying a proof');
  assert.ok(/alipay_proof_image IS NULL/.test(SWEEP_EXEMPT_SRC),
    'the pay-window rule no longer restricts itself to orders with no proof');
});

it('every order the sweep will never reap lands in exactly one of the two', () => {
  // The property that makes this pair of blocks a complete answer rather than
  // two nice cards: nothing times these orders out, so anything not counted
  // here waits forever with a customer believing they have paid.
  const db = freshDb();
  const all = [
    seed(db, { verdict: 'mismatch' }),
    seed(db, { verdict: 'match' }),
    seed(db, { verdict: 'error' }),
    seed(db, { verdict: null, ocr: null }),
  ];
  // Neighbours that must NOT be in either: no proof, or already judged.
  seed(db, { proof: null, verdict: null, ocr: null });
  seed(db, { verdict: 'mismatch', status: 'paid' });
  seed(db, { verdict: 'match', status: 'cancelled' });

  // What the sweep leaves behind, by its own rule.
  const exempt = db.prepare(
    `SELECT order_no FROM retail_orders
      WHERE status = 'pending_payment' AND payment_method = 'alipay'
        AND alipay_proof_image IS NOT NULL`
  ).all().map(r => r.order_no).sort();
  assert.deepStrictEqual(exempt, all.slice().sort(), 'fixture check: these four are the exempt set');

  const covered = [...opsNos(db), ...puNos(db)].sort();
  assert.deepStrictEqual(covered, all.slice().sort(), 'an exempt order is uncounted, or counted twice');
  assert.strictEqual(new Set(covered).size, covered.length, 'no order may light both fires');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})();
