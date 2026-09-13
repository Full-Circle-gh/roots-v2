#!/usr/bin/env node
// A CLAIM WHOSE GOODS HAVE NOT ARRIVED RAISES THE ORDER THAT TRACKS THEM — §113.
//
//   node scripts/test_claim_purchase_order.js
//
// THE CASE THIS EXISTS FOR, in Ash's words: *"an employee use the company money
// to buy a food processor. it wasn't the person that do purchasing... the item
// didn't arrive and it need tracking"*. §111 part three had left claims alone on
// the reasoning that a claim is money already out of a pocket — nothing to
// order, nothing to receive. True of a cook buying ginger; false of an appliance
// still in transit, and §113 reverses it for that case.
//
// WHAT IS ACTUALLY AT RISK HERE IS DOUBLE-COUNTING. A claim posts one row keyed
// on `claim_id`; an order posts rows keyed on `po_id`. A purchase that went
// through both would be in the books twice, and nothing on any screen would say
// which was the real one. Case 3 is the whole suite in one assertion: ONE row,
// owned by the order.
//
// Both routers run for real. lib/inventory.js is stubbed but RECORDING, because
// a typed line must never move stock and an absence is only provable against a
// record of what did.
//
// Cases:
//   1. a claim awaiting delivery must say where, and what
//   2. approving it raises an Ordered purchase order with a typed line
//   3. the money is in the books ONCE, and the order owns it
//   4. approving twice raises one order, not two
//   5. an ordinary claim is untouched — it still posts its own row
//   6. own money: the order owns the cost AND the employee is still owed
//   7. reject and void are refused while the order stands
//   8. the delivery is received like any other, and moves no stock

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const db = require(path.join(SCRATCH, 'database.js'));
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
const stockCalls = [];
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: (...a) => { stockCalls.push(a); return { ok: true }; },
  enqueueChannelSync: () => {},
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n(), requireAdmin: (q, s, n) => n() });
// The operator: an owner, so both the approve and the void gates pass. What
// those gates DO is scripts/test_staff_expenses.js's subject, not this one's.
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
  req.user = { id: 7, username: 'approver' };
  req.backendUser = { role: 'owner' };
  next();
} });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });
// Names come off the control plane; this suite is not about who is named.
stub('lib/user-names.js', { userNames: () => new Map() });

const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(require(path.join(ROOT, 'routes/staff-expenses.js')));
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const submit = (b) => call('POST', '/api/retail-admin/staff-expenses', b);
const decide = (id, decision) => call('POST', `/api/retail-admin/staff-expenses/${id}/decide`, { decision });
const claimRow = (id) => db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(id);
const expensesFor = (poId) => db.prepare('SELECT * FROM expense_entries WHERE po_id = ?').all(poId);

const FOOD_PROCESSOR = {
  date: '2026-09-13', amount: 1280, category: '设备 Equipment',
  note: 'Food processor 食品加工机', paid_by: 'company', store_id: 1,
  awaiting_delivery: true,
};

async function main() {
  db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting','设备 Equipment')").run();

  console.log('\n══ 1 · a claim awaiting delivery must say where, and what ══');
  let r = await submit({ ...FOOD_PROCESSOR, store_id: null });
  eq(r.status, 400, 'no store is refused — goods arrive at a door');
  ok(/delivered|收货/.test(r.body.error || ''), 'and the refusal says so');
  r = await submit({ ...FOOD_PROCESSOR, note: '' });
  eq(r.status, 400, 'no description is refused — it becomes a line on an order');
  // The ordinary claim keeps both as optional, which is what this proves.
  r = await submit({ date: '2026-09-13', amount: 38, paid_by: 'employee', note: null });
  eq(r.status, 200, 'an ordinary claim still needs neither');

  console.log('\n══ 2 · approving raises an Ordered purchase order ══');
  r = await submit(FOOD_PROCESSOR);
  eq(r.status, 200, 'the claim is accepted');
  const claimId = r.body.id;
  eq(claimRow(claimId).awaiting_delivery, 1, 'and is stored as awaiting its delivery');
  ok(claimRow(claimId).po_id == null, 'with no order yet — submitting is not approving');

  r = await decide(claimId, 'approve');
  eq(r.status, 200, 'approving responds 200');
  const poId = claimRow(claimId).po_id;
  ok(!!poId, 'the claim now carries an order');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  eq(po.status, 'Ordered', 'raised as Ordered, NOT a draft — the money has already gone');
  eq(po.scope, 'retail', 'in the retail series');
  eq(po.store_id, 1, 'against the store the goods are coming to');
  eq(po.date, '2026-09-13', 'dated when the money was spent');
  ok(po.supplier == null, 'with NO invented supplier — the buyer fills that in');
  const lines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ?').all(poId);
  eq(lines.length, 1, 'one line');
  eq(lines[0].name_en, 'Food processor 食品加工机', 'named as the employee described it');
  ok(lines[0].store_product_id == null && lines[0].ingredient_id == null,
     'a TYPED line — §111 part one, the reason this could not be built before');
  eq(Number(lines[0].qty), 1, 'one unit');
  eq(Number(lines[0].cost_per_unit), 1280, 'at the whole amount');
  eq(lines[0].expense_category, '设备 Equipment', 'under the category the employee chose');

  console.log('\n══ 3 · the money is in the books ONCE, and the order owns it ══');
  const byClaim = db.prepare('SELECT * FROM expense_entries WHERE claim_id = ?').all(claimId);
  eq(byClaim.length, 0, 'the CLAIM posted nothing');
  const byPo = expensesFor(poId);
  eq(byPo.length, 1, 'the ORDER posted one row');
  ok(Math.abs(Number(byPo[0].amount) - 1280) < 0.005, `for ¥1280 (got ¥${byPo[0].amount})`);
  eq(byPo[0].category, '设备 Equipment', 'under the same category');
  ok(claimRow(claimId).expense_id == null, 'and the claim points at no ledger row of its own');

  console.log('\n══ 4 · approving twice raises one order ══');
  r = await decide(claimId, 'approve');
  eq(r.status, 200, 'a second approval is accepted');
  eq(claimRow(claimId).po_id, poId, 'and lands on the SAME order');
  eq(db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 1, 'only one order exists');
  eq(expensesFor(poId).length, 1, 'and the money is still counted once');

  console.log('\n══ 5 · an ordinary claim is untouched ══');
  r = await submit({ date: '2026-09-13', amount: 38, category: '设备 Equipment',
                     paid_by: 'employee', note: 'Taxi' });
  const plainId = r.body.id;
  await decide(plainId, 'approve');
  const plainRows = db.prepare('SELECT * FROM expense_entries WHERE claim_id = ?').all(plainId);
  eq(plainRows.length, 1, 'it still posts its own ledger row');
  ok(claimRow(plainId).po_id == null, 'and raises no order');
  eq(db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 1, 'no second order appeared');

  console.log('\n══ 6 · own money: the order owns the cost, the employee is still owed ══');
  r = await submit({ date: '2026-09-13', amount: 450, category: '设备 Equipment',
                     note: 'Mixer 搅拌机', paid_by: 'employee', store_id: 1,
                     awaiting_delivery: true });
  const ownId = r.body.id;
  await decide(ownId, 'approve');
  const ownPo = claimRow(ownId).po_id;
  ok(!!ownPo, 'an order was raised for it too');
  eq(expensesFor(ownPo).length, 1, 'the order owns the cost');
  eq(db.prepare('SELECT COUNT(*) c FROM expense_entries WHERE claim_id = ?').get(ownId).c, 0,
     'and the claim posted nothing');
  // The owed figure reads status + paid_by + settled and never expense_id, which
  // is what makes this cost nothing. Asserted, not assumed.
  const owed = db.prepare(
    "SELECT COUNT(*) c FROM staff_expenses WHERE status = 'approved' AND paid_by = 'employee' AND COALESCE(settled,0) = 0 AND id = ?"
  ).get(ownId).c;
  eq(owed, 1, 'the employee is still owed the money they laid out');
  r = await call('POST', `/api/retail-admin/staff-expenses/${ownId}/settle`, { settled: true });
  eq(r.status, 200, 'and Mark paid still settles it');
  eq(expensesFor(ownPo).length, 1, 'paying them back posts nothing — the cost was recorded once');

  console.log('\n══ 7 · reject and void are refused while the order stands ══');
  r = await decide(claimId, 'reject');
  eq(r.status, 409, 'rejecting is refused');
  ok(/purchase order|采购单/.test(r.body.error || ''), 'and the refusal names the way out');
  eq(claimRow(claimId).status, 'approved', 'the claim is untouched');
  eq(expensesFor(poId).length, 1, 'and the money is still in the books');
  r = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/void`, {});
  eq(r.status, 409, 'voiding is refused for the same reason');

  console.log('\n══ 8 · the delivery is received like any other ══');
  stockCalls.length = 0;
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/receive`,
                 { receipts: [{ line_id: lines[0].id, qty_received: 1 }] });
  eq(r.status, 200, 'the food processor is ticked in');
  eq(Number(db.prepare('SELECT qty_received FROM po_line_items WHERE id = ?').get(lines[0].id).qty_received), 1,
     'the arrival is recorded');
  eq(stockCalls.length, 0, 'and NO stock moved — a typed line has no shelf');
  eq(expensesFor(poId).length, 1, 'the cost is unchanged by receiving it');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });
