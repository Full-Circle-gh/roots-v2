#!/usr/bin/env node
// A TACET PURCHASE ORDER CARRYING A MATERIAL LINE — the path Roots' purchasing
// moves onto when it leaves the kitchen app.
//
//   node scripts/test_retail_po_material_line.js
//
// WHY THIS EXISTS. §28 addendum point 2 made material purchase lines the one
// blocker on migrating Roots off the kitchen app: "Roots' only current path to
// purchase materials is through kitchen POs, and losing that with no
// replacement breaks live purchasing." Point 4 then recorded Phase 1b live and
// verified, adding that "no live retail PO has carried a material line yet."
//
// THAT LAST PART IS NO LONGER TRUE, and the correction matters more than the
// line it replaces: production has since run material POs in ordinary use —
// RPO-0031 carries eleven material lines, Ordered — so this path is not
// unproven, it is LOAD-BEARING and has been for a while. See the correction
// appended under §28 addendum point 4, and §77.
//
// What was missing was never the exercise; it was the AUTOMATED exercise.
// Nothing in scripts/ drove a material line through the retail router, so every
// guard below was protected only by production not having hit its edge yet —
// and §76's cutover leans on the whole path. This suite is that coverage:
// create → order → receive, through the real router, asserting what a material
// line must and must not do at each step.
//
// THE CONTRACT UNDER TEST is routes/retail-purchasing.js's own header:
//   "A line item references EITHER store_products (store_product_id) OR
//    ingredients (ingredient_id) — mutually exclusive, never both. A material
//    line is Phase 1b: buying a material still needs a PO, but a material has
//    no stock table, so its 'receiving' is a price write-back
//    (ingredient_price_history + the ±5% alert), never a call to
//    inventory.adjustStock."
//
// WHAT IS REAL AND WHAT IS STUBBED, because the distinction is the whole value.
// routes/purchases.js is REAL — firePriceAlertsForPO and postPOExpenses are the
// behaviour being proved, and a stub of either would leave this suite asserting
// that the router calls something, rather than that a price and an expense
// actually landed. lib/inventory.js is stubbed, but RECORDING: every
// adjustStock call is captured, because "a material line never touches this" is
// a claim about a call that must NOT happen and cannot be observed any other
// way. The operator gate and the tenant handle are stubbed as scaffolding.
//
// Cases:
//   1. a retail PO accepts a material line — ingredient_id set, no product id
//   2. a line carrying BOTH ids is refused 400 line_conflict, nothing written
//   3. placing the order posts an expense covering the material line
//   4. placing the order writes the material's price back + a history row
//   5. receiving a material line records the count and moves NO stock
//   6. a product line on the SAME PO does move stock — the skip is per LINE

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db. scripts/ is a deployed directory (see the allowlist in
// .github/workflows/deploy.yml), so this file exists on the production box and
// a test that reached for the app's real database path would be one stray
// `node` away from destroying it. database.js is copied into a scratch dir and
// required from there: it opens `__dirname/data`, which is now the copy's own.
// The scratch dir sits inside the repo so `require('better-sqlite3')` still
// resolves by walking up to node_modules.
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
// database.js's later migrations require('./lib/...'). Without these the ALTERs
// still run but several abort half-way and print SqliteErrors — a fixture that
// quietly diverges from a real boot is worth less than the noise suggests.
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const db = require(path.join(SCRATCH, 'database.js'));
// Both routers say `require('../database')`. Point that at the scratch handle
// so nothing in this process can open the real one.
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

// ── stubs, primed before the routers are required ─────────────────────────
function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };

// EVERY adjustStock call is recorded rather than dropped. Case 5 asserts a call
// that must not happen, and an absence is only provable against a record of
// what did.
const stockCalls = [];
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore:    id => STORES[id] || null,
  listStores:  () => Object.values(STORES),
  adjustStock: (...args) => { stockCalls.push(args); return { ok: true }; },
  enqueueChannelSync: () => {},
});
// requireDelete is in here because routes/purchases.js — which this suite loads
// for real — destructures it at require time; a missing export is not a failed
// assertion but an unmountable router.
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n(),
                             requireAdmin: (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });
// The recipe rollup is a costing cascade hanging off a material price change.
// It has its own suites; stubbing it keeps a failure here pointing at the
// purchase path rather than at recipe maths two layers away.
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });

// routes/purchases.js is deliberately NOT stubbed — see the header.
const express = require('express');
const router  = require(path.join(ROOT, 'routes/retail-purchasing.js'));
const app = express();
app.use(router);
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ──────────────────────────────────────────────────────────────────
// A bag-bought food material, the C-40 shape test_price_writeback.js uses:
// 500g to the bag, so a ¥26 bag prices the gram and the write-back has real
// arithmetic to do rather than a pass-through.
db.prepare(`INSERT INTO ingredients
  (id,name_en,name_cn,sku,unit,buy_unit,buy_pack_size,pack_contents_qty,pack_contents_unit,cost_per_unit,buy_price,is_active)
  VALUES (66,'Black Sesame Seeds','黑芝麻','C-40','g','bag',1,500,'g',15.8,15.8,1)`).run();

// A product for case 6. Only the columns the receive path reads are set.
try {
  db.prepare(`INSERT INTO store_products (id,name_en,name_cn,sku,is_active)
              VALUES (7,'Oat Milk 1L','燕麦奶1升','P-7',1)`).run();
} catch (e) {
  // Column set varies with migration order; fall back to the minimum.
  db.prepare(`INSERT INTO store_products (id,name_en,sku) VALUES (7,'Oat Milk 1L','P-7')`).run();
}

// ── tiny assert harness ───────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const lines = poId => db.prepare(
  'SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order, id').all(poId);

async function main() {
  console.log('\n══ 1 · a retail PO accepts a material line ══');
  let r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-08', store_id: 1, supplier: 'Fresh Co.',
    items: [{ ingredient_id: 66, name_en: 'Black Sesame Seeds', name_cn: '黑芝麻',
              sku: 'C-40', qty: 2, unit: 'bag', cost_per_unit: 26, total_cost: 52 }],
  });
  eq(r.status, 200, 'responds 200');
  ok(r.body && r.body.success, 'reports success');
  const poId = r.body && r.body.id;
  ok(!!poId, 'returns the new PO id');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  eq(po.scope, 'retail', 'the PO is retail-scoped');
  eq(po.status, 'Requested', 'and opens as a draft');
  ok(/^RPO-/.test(po.po_number), `numbered in the retail series (${po.po_number})`);
  let L = lines(poId);
  eq(L.length, 1, 'one line stored');
  eq(L[0].ingredient_id, 66, 'the line carries ingredient_id');
  ok(L[0].store_product_id === null || L[0].store_product_id === undefined,
     'and carries NO store_product_id');
  eq(Number(L[0].stock_applied_qty || 0), 0, 'nothing applied to stock yet');

  console.log('\n══ 2 · a line carrying BOTH subjects is refused ══');
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c;
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-08', store_id: 1,
    items: [{ ingredient_id: 66, store_product_id: 7, name_en: 'Confused line',
              qty: 1, unit: 'bag', cost_per_unit: 1, total_cost: 1 }],
  });
  eq(r.status, 400, 'refused 400');
  eq(r.body && r.body.error, 'line_conflict', 'names the conflict');
  eq(db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, beforeCount,
     'and NOTHING was written — the refusal is before the transaction');

  console.log('\n══ 3 · placing the order posts an expense for the material ══');
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/status`, { status: 'Ordered' });
  eq(r.status, 200, 'responds 200');
  eq(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(poId).status,
     'Ordered', 'the PO is Ordered');
  const exp = db.prepare('SELECT * FROM expense_entries WHERE po_id = ?').all(poId);
  ok(exp.length > 0, `an expense row was posted (${exp.length})`);
  const expTotal = exp.reduce((s, e) => s + Number(e.amount || 0), 0);
  ok(Math.abs(expTotal - 52) < 0.005,
     `the expense totals the material line, ¥52 (got ¥${expTotal})`);

  console.log('\n══ 4 · placing the order writes the price back ══');
  // 500g to a bag at ¥26 the bag → ¥0.052 the gram, the recipe unit.
  const ing = db.prepare('SELECT cost_per_unit, buy_price FROM ingredients WHERE id = 66').get();
  ok(Math.abs(Number(ing.cost_per_unit) - 0.052) < 0.0005,
     `cost_per_unit is the per-gram price (got ${ing.cost_per_unit})`);
  ok(Math.abs(Number(ing.buy_price) - 26) < 0.005,
     `buy_price is the pack price (got ${ing.buy_price})`);
  const hist = db.prepare(
    'SELECT * FROM ingredient_price_history WHERE ingredient_id = 66 ORDER BY id').all();
  ok(hist.length > 0, `a price-history row was written (${hist.length})`);

  console.log('\n══ 5 · receiving a material line moves NO stock ══');
  stockCalls.length = 0;
  L = lines(poId);
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/receive`, {
    receipts: [{ line_id: L[0].id, qty_received: 2 }],
  });
  eq(r.status, 200, 'responds 200');
  const matLine = lines(poId)[0];
  eq(Number(matLine.qty_received), 2, 'the arrival is recorded on the line');
  eq(Number(matLine.stock_applied_qty || 0), 0, 'stock_applied_qty stays 0');
  eq(stockCalls.length, 0, 'inventory.adjustStock was NEVER called');

  console.log('\n══ 6 · a product line on the same PO DOES move stock ══');
  // The skip must be per LINE, not per PO — a mixed order is the case that
  // tells the two apart, and the one a real kitchen order will look like.
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-08', store_id: 1, supplier: 'Fresh Co.',
    items: [
      { ingredient_id: 66, name_en: 'Black Sesame Seeds', sku: 'C-40',
        qty: 1, unit: 'bag', cost_per_unit: 26, total_cost: 26 },
      { store_product_id: 7, name_en: 'Oat Milk 1L', sku: 'P-7',
        qty: 3, unit: 'pcs', cost_per_unit: 9, total_cost: 27 },
    ],
  });
  eq(r.status, 200, 'the mixed PO is created');
  const mixId = r.body.id;
  await call('PUT', `/api/retail-admin/purchases/${mixId}/status`, { status: 'Ordered' });
  const mixLines = lines(mixId);
  const mat = mixLines.find(l => l.ingredient_id);
  const prod = mixLines.find(l => l.store_product_id);
  ok(!!mat && !!prod, 'the PO holds one material line and one product line');

  stockCalls.length = 0;
  r = await call('PUT', `/api/retail-admin/purchases/${mixId}/receive`, {
    receipts: [{ line_id: mat.id, qty_received: 1 },
               { line_id: prod.id, qty_received: 3 }],
  });
  eq(r.status, 200, 'the delivery is accepted');
  ok(stockCalls.length > 0, `adjustStock ran for the product line (${stockCalls.length}x)`);
  const after = lines(mixId);
  const matAfter  = after.find(l => l.ingredient_id);
  const prodAfter = after.find(l => l.store_product_id);
  eq(Number(matAfter.stock_applied_qty || 0), 0,
     'the material line STILL applied nothing to stock');
  ok(Number(prodAfter.stock_applied_qty || 0) > 0,
     `the product line applied its arrival (${prodAfter.stock_applied_qty})`);
  eq(Number(matAfter.qty_received), 1, 'and the material arrival was still recorded');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
