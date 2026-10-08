#!/usr/bin/env node
/**
 * A counter sale marked paid through the status route ends at Completed, the
 * same as one rung up and paid at the till.
 *
 *   node scripts/test_counter_mark_paid_completes.js
 *
 * No network, no keys, no server. `routes/retail.js` cannot be required (it
 * opens a real database at load), so the REAL block is sliced out of the route
 * and run against an in-memory `retail_orders` built from database.js — the
 * technique test_till_credit.js uses.
 *
 * ── WHAT WAS WRONG (§441) ─────────────────────────────────────────────────
 * markOrderPaid flips a counter sale to 'delivered' ("Completed · 已完成") the
 * moment it is paid. PATCH /api/retail-admin/orders/:id/status did not, and it
 * is the path the till settles a QR order through (confirmRecall) and the path
 * the order drawer's Mark paid uses. So every QR order paid at the till sat at
 * "Paid" for good — docs/tacet-pos-counter-survey.md §6, filed 2026-08-20.
 *
 * ── WHAT THIS LOCKS DOWN ──────────────────────────────────────────────────
 *   • a counter sale moved pending → paid by the route lands at 'delivered',
 *     delivered_at stamped at the moment of payment;
 *   • a delivery or pickup order is left at 'paid' — it still has work to do;
 *   • the flip runs AFTER the referral credits, which return early unless the
 *     order reads 'paid' — flipping first would pay the referrer nothing;
 *   • the till's QR settle really does go through this route.
 *
 * §442 (same day): markOrderPaid made the same flip BEFORE its referral
 * credits, so a till sale by a referred customer paid the referrer nothing.
 * The flip now follows them; the last section runs the real markOrderPaid
 * with recorders and checks what status each step saw.
 *
 * TO PROVE THE SUITE CAN FAIL:  CMP_MUTANT=1 node scripts/test_counter_mark_paid_completes.js
 * The mutant restores both old behaviours — the route making no flip, and
 * markOrderPaid flipping before the credits — and the suite must go RED. It asserts it modified the source first.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { isTerminalOnPaid } = require('../lib/fulfilment');

const MUTANT = process.env.CMP_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DB_SRC = read('database.js');
const RETAIL_SRC = read('routes/retail.js');
const TILL_SRC = read('public/till.html');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// From the `{` at or after `from`, to its matching `}` (inclusive).
function braceSlice(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  assert.ok(i >= 0, 'no opening brace');
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.strictEqual(depth, 0, 'unterminated block');
  return { start, end: i + 1, text: src.slice(start, i + 1) };
}

// ── The route, its paid block, and the §441 block inside it ─────────────────
const ROUTE_HEAD = "router.patch('/api/retail-admin/orders/:id/status'";
const routeAt = RETAIL_SRC.indexOf(ROUTE_HEAD);
assert.ok(routeAt >= 0, 'status route not found in routes/retail.js');
const route = braceSlice(RETAIL_SRC, RETAIL_SRC.indexOf('=>', routeAt)).text;

const paidAt = route.indexOf("if (status === 'paid') {");
assert.ok(paidAt >= 0, "the route's paid block not found");
const paidBlock = braceSlice(route, paidAt).text;

const markAt = paidBlock.indexOf('§441 — A COUNTER SALE MARKED PAID HERE IS COMPLETE');
assert.ok(markAt >= 0, 'the §441 block is missing from the paid block');
const guardAt = paidBlock.indexOf("if (o.status !== 'paid') {", markAt);
assert.ok(guardAt >= 0, 'the §441 guard not found after its comment');
let flipSrc = "if (o.status !== 'paid') " + braceSlice(paidBlock, guardAt).text;

if (MUTANT) {
  const mutated = flipSrc.replace('if (isTerminalOnPaid(ft))', 'if (false && isTerminalOnPaid(ft))');
  assert.notStrictEqual(mutated, flipSrc, 'mutation anchor not found — a red run would prove nothing');
  flipSrc = mutated;
}
const runFlip = new Function('tdb', 'isTerminalOnPaid', 'o', 'id', flipSrc);

// ── An in-memory retail_orders, the real table definition ───────────────────
const db = openTablesDb(DB_SRC, ['retail_orders']);
const tdb = () => db;
let seq = 0;
function order(fulfillmentType) {
  const no = 'T' + (++seq);
  const info = db.prepare(
    `INSERT INTO retail_orders (order_no, status, fulfillment_type, total, paid_at)
     VALUES (?, 'pending_payment', ?, 10, NULL)`
  ).run(no, fulfillmentType);
  return Number(info.lastInsertRowid);
}
// What the route's own UPDATE does just before the paid block runs.
function routeMarksPaid(id) {
  db.prepare(
    "UPDATE retail_orders SET status = 'paid', paid_at = '2026-10-08 09:15:00', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
}
const row = (id) => db.prepare('SELECT status, paid_at, delivered_at FROM retail_orders WHERE id = ?').get(id);

console.log('\nA counter sale marked paid through the status route');

it('a counter sale lands at delivered (Completed), stamped at the moment it was paid', () => {
  const id = order('counter');
  routeMarksPaid(id);
  runFlip(tdb, isTerminalOnPaid, { status: 'pending_payment' }, id);
  const r = row(id);
  assert.strictEqual(r.status, 'delivered');
  assert.strictEqual(r.delivered_at, '2026-10-08 09:15:00');
});

it('a delivery order stays at paid — it still has to be packed and sent', () => {
  const id = order('delivery');
  routeMarksPaid(id);
  runFlip(tdb, isTerminalOnPaid, { status: 'pending_payment' }, id);
  assert.strictEqual(row(id).status, 'paid');
  assert.strictEqual(row(id).delivered_at, null);
});

it('a pickup order stays at paid — the customer has not collected it yet', () => {
  const id = order('pickup');
  routeMarksPaid(id);
  runFlip(tdb, isTerminalOnPaid, { status: 'pending_payment' }, id);
  assert.strictEqual(row(id).status, 'paid');
});

it('an order that has already moved past paid is not touched', () => {
  const id = order('counter');
  routeMarksPaid(id);
  db.prepare("UPDATE retail_orders SET status = 'cancelled' WHERE id = ?").run(id);
  runFlip(tdb, isTerminalOnPaid, { status: 'pending_payment' }, id);
  assert.strictEqual(row(id).status, 'cancelled');
});

console.log('\nWhere the flip sits');

it('it is the LAST thing in the paid block, after the referral credits that need "paid"', () => {
  for (const call of ['awardOrderPoints(id)', 'creditReferralReward(id)', 'creditLifetimeCommission(id)',
                      'autoPrintOrder(id)', 'sendWecomOrderAlert(id)']) {
    const at = paidBlock.indexOf(call);
    assert.ok(at >= 0, `${call} not found in the paid block`);
    assert.ok(at < markAt, `${call} runs after the §441 flip — it would see 'delivered', not 'paid'`);
  }
});

it('the referral credits really do require "paid" (the reason the order above matters)', () => {
  for (const fn of ['creditReferralReward', 'creditLifetimeCommission']) {
    const at = RETAIL_SRC.search(new RegExp(`^function ${fn}\\(`, 'm'));
    assert.ok(at >= 0, `${fn} not found`);
    const body = braceSlice(RETAIL_SRC, at).text;
    assert.ok(/o\.status !== 'paid'\) return/.test(body), `${fn} no longer returns early off 'paid' — revisit §441's placement`);
  }
});

it("the till settles a QR order through this route with status 'paid'", () => {
  assert.ok(/'\/api\/retail-admin\/orders\/' \+ r\.id \+ '\/status'/.test(TILL_SRC), 'confirmRecall no longer PATCHes the status route');
  assert.ok(/recallPayload: function \(st\) \{ return \{ status: 'paid'/.test(TILL_SRC), "the till's recall no longer sends status 'paid'");
});

it('a QR order is a counter sale, so the flip applies to it', () => {
  const ins = read('routes/shop-menu.js');
  assert.ok(/'shop', 'counter', shop\.location_id,\s*\n\s*'qr'/.test(ins), "the QR menu no longer writes fulfillment_type 'counter'");
});

// ── §442 · markOrderPaid: the till's own sale pays the referrer ─────────────
// The REAL function, run against the same in-memory table with every side
// effect replaced by a recorder that notes the order's status at the moment it
// is called. creditReferralReward and creditLifetimeCommission return early
// unless the order reads 'paid', so what they SEE is the whole question.
console.log('\nmarkOrderPaid — a till sale by a referred customer (§442)');

const mopAt = RETAIL_SRC.search(/^function markOrderPaid\(/m);
assert.ok(mopAt >= 0, 'markOrderPaid not found');
let mopSrc = RETAIL_SRC.slice(mopAt, braceSlice(RETAIL_SRC, RETAIL_SRC.indexOf(')', mopAt)).end);
if (MUTANT) {
  // The pre-§442 order: flip to delivered before anything else runs.
  const anchor = "      if (isTerminalOnPaid(ft)) {\n        counterTerminal = true;\n";
  const mutated = mopSrc.replace(anchor, anchor +
    "        tdb().prepare(\"UPDATE retail_orders SET status = 'delivered' WHERE id = ? AND status = 'paid'\").run(orderId);\n");
  assert.notStrictEqual(mutated, mopSrc, 'markOrderPaid mutation anchor not found — a red run would prove nothing');
  mopSrc = mutated;
}
const seen = {};
const statusNow = (id) => db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(id).status;
const rec = (name) => (id) => { seen[name] = statusNow(id); };
const STUBS = {
  tdb, isTerminalOnPaid,
  prepareCommitUnreservedOrder: rec('prepareCommitUnreservedOrder'),
  inventory: { commitOrderReservations: () => {} },
  expressEarliestIso: () => '2026-10-08',
  awardOrderPoints: rec('awardOrderPoints'),
  creditReferralReward: rec('creditReferralReward'),
  creditLifetimeCommission: rec('creditLifetimeCommission'),
  _push: null,
  currentTenantId: () => 1,
  sendWecomOrderAlert: rec('sendWecomOrderAlert'),
  autoPrintOrder: rec('autoPrintOrder'),
  maybeAutoIssueInvoice: () => Promise.resolve(),
  notifySupplierDirectItems: () => {},
  maybeEnqueueQingyunPush: () => {},
  notifyOrderStatusChange: () => { throw new Error('a counter sale must not notify a hand-over'); },
  checkAwaitingRestockForRestock: () => {},
};
const names = Object.keys(STUBS);
const markOrderPaid = new Function(...names, `${mopSrc}\nreturn markOrderPaid;`)(...names.map((n) => STUBS[n]));

// retail_payments is touched by markOrderPaid; give it the real table too.
for (const t of ['retail_payments']) {
  const one = openTablesDb(DB_SRC, [t]);
  const ddl = one.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
  db.exec(ddl);
}

it('the referral credits see "paid", and the sale still ends at delivered', () => {
  const id = order('counter');
  for (const k of Object.keys(seen)) delete seen[k];
  markOrderPaid(id);
  assert.strictEqual(seen.creditReferralReward, 'paid', 'creditReferralReward saw ' + seen.creditReferralReward);
  assert.strictEqual(seen.creditLifetimeCommission, 'paid', 'creditLifetimeCommission saw ' + seen.creditLifetimeCommission);
  assert.strictEqual(statusNow(id), 'delivered');
  assert.ok(row(id).delivered_at, 'delivered_at not stamped');
  assert.strictEqual(row(id).delivered_at, row(id).paid_at, 'delivered_at is not the moment of payment');
});

it('the stock still moves for it, and the print and the alert still see delivered, as before', () => {
  const id = order('counter');
  for (const k of Object.keys(seen)) delete seen[k];
  markOrderPaid(id);
  assert.ok('prepareCommitUnreservedOrder' in seen, 'the counter sale\'s stock was not committed');
  assert.strictEqual(seen.autoPrintOrder, 'delivered');
  assert.strictEqual(seen.sendWecomOrderAlert, 'delivered');
});

it('a delivery order paid the same way stays at paid', () => {
  const id = order('delivery');
  for (const k of Object.keys(seen)) delete seen[k];
  markOrderPaid(id);
  assert.strictEqual(statusNow(id), 'paid');
  assert.strictEqual(seen.creditReferralReward, 'paid');
});

console.log(`\n${pass} passed, ${fail} failed${MUTANT ? ' (MUTANT run — must be red)' : ''}\n`);
process.exit(fail ? 1 : 0);
