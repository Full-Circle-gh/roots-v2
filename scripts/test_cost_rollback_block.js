#!/usr/bin/env node
// Which material lines may refuse to take a purchase order off its placed state.
//
// THE DEADLOCK THIS CLOSES. Leaving a postable state has to give back what the
// order took, and an ingredient cost is only restorable if something recorded
// what it was BEFORE the order wrote it (an activity_log 'cost_update' row).
// planMaterialCostRollback demanded that record of every priced material line
// — including lines the order had never priced at all. On the live database
// that refused six retail orders, every one of them over packaging samples
// firePriceAlertsForPO had skipped (unit mismatch, no pack contents), and since
// the purchasing screen only opens a DRAFT for editing and the route refused to
// make one, those orders could not be edited by any means.
//
// The rule now: a line blocks only when this order's price is STILL STANDING on
// the ingredient and nothing recorded what preceded it. Everything else has
// nothing to give back and never did.
//
// Run:  node scripts/test_cost_rollback_block.js
//
// Cases:
//   1. a line the order never priced does not block it — ingredient_cost_skips
//   2. a price that has since been replaced does not block it either
//   3. a recorded prior value rolls back, as it always did
//   4. this order's price still standing, with no record, DOES block — and the
//      refusal names the material and writes nothing
//   5. the way out: set the price by hand, and the same order goes back

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// NEVER data/roots.db — scripts/ is deployed (see test_kitchen_po_copy.js).
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

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
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: () => ({ delta: 0 }),
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
                             req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });
// The price write-back itself is stubbed: this file is about what happens when
// an order LEAVES a postable state, and re-firing the forward write on the way
// out would be testing the other direction.
stub('routes/purchases.js', {
  firePriceAlertsForPO: () => ({ skips: [], landedSkips: [], landedExtras: 0 }),
  allocateLandedExtras: () => ({ perUnit: new Map(), skipped: [], extras: 0, totalGoods: 0 }),
  planReceiptReasons: () => ({ plans: new Map() }),
  recordReceipt: () => ({ receiptId: null }),
  appliedReceiptStore: (_db, po) => po.store_id,
  postPOExpenses: () => ({ skipped: 'stubbed' }),
});

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// One order carrying one of each kind of material line. All four are priced, so
// the OLD rule would have demanded a record for every one of them.
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (21,'RPO-0021','2026-08-23','Ordered','Handan Chuanglan','retail',1,1)`).run();
const insIng = db.prepare('INSERT INTO ingredients (id,name_en,buy_unit,buy_price,cost_per_unit) VALUES (?,?,?,?,?)');
// 1 · skipped by the write-back — a packaging sample in the wrong unit.
insIng.run(628, 'Bread Bag（Packaging Sample）', 'bag', 4, 4);
// 2 · priced by this order once, but something newer has moved it since.
insIng.run(629, 'Plastic Oil Bottle', 'pcs', 9.5, 9.5);
// 3 · priced by this order, with the prior value on record.
insIng.run(322, 'Vacuum bag', 'pcs', 0.39, 0.39);
// 4 · priced by this order, still standing, nothing recorded before it.
insIng.run(514, 'iron', 'bottle', 84.3, 84.3);
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,ingredient_id,name_en,qty,unit,cost_per_unit,total_cost,expense_category,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
insLine.run(1, 21, 628, 'Bread Bag',        10, 'pcs',    4,    40, '厨房物料 Kitchen materials', 0);
insLine.run(2, 21, 629, 'Plastic Oil Bottle', 10, 'pcs',  12,   120, '厨房物料 Kitchen materials', 1);
insLine.run(3, 21, 322, 'Vacuum bag',       100, 'pcs', 0.39,    39, '厨房物料 Kitchen materials', 2);
insLine.run(4, 21, 514, 'iron',               2, 'bottle', 84.3, 168.6, '厨房物料 Kitchen materials', 3);
// The write-back's own record that it refused line 1 — the proof this order
// never touched that ingredient's cost.
db.prepare(`INSERT INTO ingredient_cost_skips (ingredient_id,po_id,reason,line_unit,line_price)
            VALUES (628,21,'unit_mismatch','pcs',4)`).run();
// The prior value for line 3, exactly as firePriceAlertsForPO writes it.
// user_id NULL, not 1: activity_log FKs users(id) and this scratch database
// has no users. firePriceAlertsForPO writes NULL here too for any actor
// without a kitchen users row, so this is the shape the live table holds.
db.prepare(`INSERT INTO activity_log (user_id,username,action,entity_type,entity_id,details)
            VALUES (NULL,'system','cost_update','ingredient',322,?)`)
  .run(JSON.stringify({ from: { buy_price: 0.35, cost_per_unit: 0.35 },
                        to:   { buy_price: 0.39, cost_per_unit: 0.39 }, po_id: 21 }));

// ── harness ────────────────────────────────────────────────────────────────
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
const po = () => db.prepare('SELECT * FROM purchase_orders WHERE id = 21').get();
const ing = id => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
const toDraft = () => call('PUT', '/api/retail-admin/purchases/21/status', { status: 'Requested' });

async function main() {
  console.log('\n══ 1-4 · the order as seeded — one line of each kind ══');
  let r = await toDraft();
  eq(r.status, 409, 'the order is refused');
  eq(r.body.error, 'cost_not_recoverable', 'for a cost it cannot put back');
  const named = (r.body.ingredients || []).map(i => i.ingredient_id).sort();
  eq(JSON.stringify(named), '[514]',
     'and ONLY the material whose price this order set with nothing recorded before it');
  ok((r.body.ingredients || [])[0].name_en === 'iron', 'the refusal names it');
  eq((r.body.ingredients || [])[0].buy_price, 84.3, 'and says what it is carrying');
  eq(po().status, 'Ordered', 'the order did not move');
  eq(ing(322).buy_price, 0.39, 'and nothing was rolled back — a refusal writes nothing');

  console.log('\n══ 1 · a line the order never priced does not block it ══');
  // Proven by removing the OTHER blocker and leaving the skipped line in place.
  db.prepare('DELETE FROM po_line_items WHERE id = 4').run();
  r = await toDraft();
  eq(r.status, 200, 'with the standing-price line gone, the order goes back');
  eq(po().status, 'Requested', 'it is a draft');
  eq(ing(628).buy_price, 4, 'the skipped material was never touched, before or after');
  eq(ing(322).buy_price, 0.35, 'and the recorded one rolled back to what it cost before (case 3)');

  console.log('\n══ 2 · a price that has since been replaced does not block ══');
  // Line 2 asked 12; the ingredient carries 9.5, so this order's write — if it
  // ever landed — is not the one standing. Nothing to give back, nothing to
  // refuse. Put the order back and prove it on its own.
  db.prepare("UPDATE purchase_orders SET status = 'Ordered' WHERE id = 21").run();
  db.prepare('DELETE FROM po_line_items WHERE id IN (1,3)').run();
  eq(ing(629).buy_price, 9.5, 'the ingredient carries a newer price than this order asked');
  r = await toDraft();
  eq(r.status, 200, 'so the order is not held over it');
  eq(ing(629).buy_price, 9.5, 'and that newer price is left exactly alone');

  console.log('\n══ 5 · the way out of a real refusal ══');
  // Rebuild the genuine case: this order's price standing, nothing recorded.
  db.prepare("UPDATE purchase_orders SET status = 'Ordered' WHERE id = 21").run();
  insLine.run(5, 21, 514, 'iron', 2, 'bottle', 84.3, 168.6, '厨房物料 Kitchen materials', 4);
  r = await toDraft();
  eq(r.status, 409, 'refused, as it should be');
  // The operator does what the dialog says: sets the price themselves.
  db.prepare('UPDATE ingredients SET buy_price = 79, cost_per_unit = 79 WHERE id = 514').run();
  r = await toDraft();
  eq(r.status, 200, 'and once a person has set the price, the same order goes back');
  eq(po().status, 'Requested', 'it is a draft and can be edited');
  eq(ing(514).buy_price, 79, 'the price a person chose stands — nothing overwrote it');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
