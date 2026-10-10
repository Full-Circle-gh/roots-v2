#!/usr/bin/env node
/**
 * §450 — an international card adds 4% to what the card is charged.
 *
 *   node scripts/test_intl_card_surcharge.js
 *
 * No network, no keys, no server. The create route's half is proven through
 * the real handler in test_till_credit.js; this file holds the rest:
 *
 *   • the Mark-paid route (PATCH /orders/:id/status), which is how the till
 *     settles a QR order and how the office and the phone mark one paid — its
 *     §450 block is sliced out of routes/retail.js and run against a real
 *     retail_orders table built from database.js;
 *   • the till's on-screen preview, sliced out of public/till.html and run
 *     beside lib/card-surcharge.js over every amount from ¥0.01 to ¥300, so the
 *     number the cashier keys in is the number the server charges;
 *   • the wiring that has no arithmetic of its own: the tender is off-app (a
 *     refund is paid by hand, never pushed to the gateway), the receipt names
 *     the fee, and every list that names a tender knows this one.
 *
 * TO PROVE THE SUITE CAN FAIL:  ICS_MUTANT=1 node scripts/test_intl_card_surcharge.js
 * The mutant drops the "take the old fee out first" step from the Mark-paid
 * block, so a re-marked order is charged twice and a card order settled in cash
 * keeps its fee. The suite must go RED, and it asserts it changed the source.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const money = require('../lib/money');
const { cardSurcharge, INTL_CARD } = require('../lib/card-surcharge');

const MUTANT = process.env.ICS_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DB_SRC = read('database.js');
const RETAIL_SRC = read('routes/retail.js');
const TILL_SRC = read('public/till.html');
const FEIE_SRC = read('lib/feie.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// From the `{` at or after `from`, to its matching `}` (inclusive).
function braceSlice(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

// ── 1 · the Mark-paid route ───────────────────────────────────────────────
console.log('\n1 · marking an order paid on an international card');

const ROUTE = "router.patch('/api/retail-admin/orders/:id/status'";
const r0 = RETAIL_SRC.indexOf(ROUTE);
assert.notStrictEqual(r0, -1, 'the status route moved');
const ANCHOR = '/* §450 — the international-card 4%, on THIS path too';
const a0 = RETAIL_SRC.indexOf(ANCHOR, r0);
assert.notStrictEqual(a0, -1, 'the §450 block is gone from the status route');
let BLOCK = braceSlice(RETAIL_SRC, RETAIL_SRC.indexOf('if (offlinePay) {', a0));
if (MUTANT) {
  const before = BLOCK;
  BLOCK = BLOCK.replace('(Number(m.total) || 0) - oldFee', '(Number(m.total) || 0)');
  assert.notStrictEqual(BLOCK, before, 'the mutant did not modify the source');
}

function fixture(total, fee, method) {
  const d = openTablesDb(DB_SRC, ['retail_orders']);
  d.prepare(`INSERT INTO retail_orders (id, order_no, status, payment_method, subtotal, total, card_surcharge_fee)
             VALUES (1, 'TC1', 'pending_payment', ?, ?, ?, ?)`).run(method, total, total, fee);
  return d;
}
// The block plus the UPDATE the route builds from `sets`, exactly as it does.
function markPaid(d, offlinePay) {
  const sets = ['status = ?'];
  const params = ['paid'];
  new Function('tdb', 'money', 'cardSurcharge', 'offlinePay', 'id', 'sets', 'params', BLOCK)(
    () => d, money, cardSurcharge, offlinePay, 1, sets, params);
  params.push(1);
  d.prepare(`UPDATE retail_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return d.prepare('SELECT total, card_surcharge_fee, status FROM retail_orders WHERE id = 1').get();
}

it('a ¥50 QR order paid on an international card becomes ¥52', () => {
  const row = markPaid(fixture(50, 0, 'wechat'), 'intl_card');
  assert.deepStrictEqual([row.total, row.card_surcharge_fee], [52, 2]);
});
it('the same order paid in cash is the ¥50 it was', () => {
  const row = markPaid(fixture(50, 0, 'wechat'), 'cash');
  assert.deepStrictEqual([row.total, row.card_surcharge_fee], [50, 0]);
});
it('an order already carrying the fee is never charged it twice', () => {
  const row = markPaid(fixture(52, 2, 'intl_card'), 'intl_card');
  assert.deepStrictEqual([row.total, row.card_surcharge_fee], [52, 2]);
});
it('an order created on the card and settled in cash loses the fee', () => {
  const row = markPaid(fixture(52, 2, 'intl_card'), 'cash');
  assert.deepStrictEqual([row.total, row.card_surcharge_fee], [50, 0]);
});
it('a fully credit-paid order (¥0 left) carries no fee', () => {
  const row = markPaid(fixture(0, 0, 'points'), 'intl_card');
  assert.deepStrictEqual([row.total, row.card_surcharge_fee], [0, 0]);
});
it('the payment row is written AFTER the fee lands, so it records the ¥52', () => {
  const blockAt = RETAIL_SRC.indexOf(ANCHOR, r0);
  const update = RETAIL_SRC.indexOf('tdb().prepare(`UPDATE retail_orders SET ${sets.join', blockAt);
  const payRead = RETAIL_SRC.indexOf("SELECT total FROM retail_orders WHERE id = ?", blockAt);
  assert.ok(blockAt < update && update < payRead, 'the audit row reads total before the fee is written');
});
it('Mark paid is only ever reached from pending_payment, so a paid total never moves', () => {
  assert.ok(/paid:\s+\{ col: 'paid_at',\s+prev: \['pending_payment'\] \}/.test(RETAIL_SRC));
});

// ── 2 · the till's preview is the server's arithmetic ─────────────────────
console.log('\n2 · the number on the till is the number the server charges');
const fnAt = TILL_SRC.indexOf('function cardFee()');
assert.notStrictEqual(fnAt, -1, 'the till lost cardFee()');
const pctM = /var CARD_FEE_PCT = (\d+);/.exec(TILL_SRC);
const tillFee = (wallet, due) => new Function('S', 'cashDue', 'CARD_FEE_PCT',
  braceSlice(TILL_SRC, fnAt).slice(1, -1))({ wallet }, () => due, Number(pctM[1]));

it('the till and lib/card-surcharge.js agree on every amount from ¥0.01 to ¥300', () => {
  for (let fen = 1; fen <= 30000; fen++) {
    const due = fen / 100;
    const a = tillFee(INTL_CARD, due), b = cardSurcharge(INTL_CARD, due);
    if (a !== b) throw new Error(`¥${due}: till ${a}, server ${b}`);
  }
});
it('and the till charges nothing extra for any other wallet', () => {
  assert.strictEqual(tillFee('wechat_offline', 100), 0);
});
it('the big amount on the settle screen is the charge, fee included', () => {
  assert.ok(TILL_SRC.includes("'<div class=\"amt\">' + money(chargeDue()) + '</div>'"));
});
it('a recalled order\'s done screen reads the server\'s total back, not its own', () => {
  assert.ok(/total: row\.total != null \? Number\(row\.total\) : r\.total/.test(TILL_SRC));
});

// ── 3 · the wiring ────────────────────────────────────────────────────────
console.log('\n3 · the tender is known everywhere a tender is named');
it('it is off-app: a refund is paid by hand, never pushed to the gateway', () => {
  assert.ok(/const OFFLINE_PAY_METHODS = new Set\(\[[^\]]*'intl_card'/.test(RETAIL_SRC));
});
it('the create route accepts it, so a counter sale on it is not refused', () => {
  assert.ok(/const ALLOWED_PAY = \[[\s\S]*?'intl_card'[\s\S]*?\];/.test(RETAIL_SRC));
});
it('the receipt prints the fee as its own line, so the column adds up to TOTAL', () => {
  assert.ok(FEIE_SRC.includes("row('Card fee 4%', money(o.card_surcharge_fee))"));
});
for (const [file, needle] of [
  ['public/retail-admin/04-orders.js', "['intl_card',"],
  ['public/retail-admin/01-core.js', "intl_card: 'International card · 外卡'"],
  ['public/retail-admin/03-dashboard.js', "intl_card: ['International card', '外卡']"],
  ['public/m.html', "['intl_card','International card +4%','外卡 +4%']"],
  ['public/m.html', "intl_card:['International card','外卡']"],
]) {
  it(`${file} names it`, () => assert.ok(read(file).includes(needle)));
}
it('the money columns register the fee, so the census does not stop on it', () => {
  const M = require('../lib/money-columns');
  assert.strictEqual(M.classify('retail_orders', 'card_surcharge_fee').kind, 'source');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
