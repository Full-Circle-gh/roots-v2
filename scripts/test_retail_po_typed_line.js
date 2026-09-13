#!/usr/bin/env node
// A TACET PURCHASE ORDER CARRYING A TYPED LINE — the box of gloves, the office
// chair, the deposit on a fridge.
//
//   node scripts/test_retail_po_typed_line.js
//
// WHY THIS EXISTS. A purchase order line has always referenced EITHER a store
// product OR a material, and `lineConflict` refuses one carrying both. It never
// refused one carrying NEITHER — the stock apply skips such a line, the price
// write-back skips it, and the expense poster groups it by its own
// `expense_category` like any other. So the storage was there from the start and
// nothing could produce it: the wizard's only way onto an order was a picker
// over the two catalogues, and a search that matched nothing ended at "No
// match". The cost that could not be ordered got typed into Finance instead, as
// a bare ledger row with no supplier, no receiving, no 发票 to match and nothing
// to return it against.
//
// This suite is the coverage for the line that closes that door. It drives the
// real router: create → refuse the nameless one → order → receive.
//
// WHAT IS REAL AND WHAT IS STUBBED is the sibling suite's arrangement
// (test_retail_po_material_line.js) and for its reasons. routes/purchases.js is
// REAL, because the expense posting is the behaviour under test. lib/inventory.js
// is stubbed but RECORDING: "a typed line never touches stock" is a claim about a
// call that must NOT happen, and an absence is only provable against a record of
// what did.
//
// Cases:
//   1. a retail PO accepts a line naming neither a product nor a material
//   2. a typed line with no name is refused 400 name_required, nothing written
//   3. the same refusal guards an EDIT, not only a create
//   4. placing the order posts the typed line under ITS OWN expense category
//   5. a typed line left uncategorised falls to the poster's default
//   6. receiving a typed line records the arrival and moves NO stock
//   7. a product line on the same PO does move stock — the skip is per LINE

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db — scripts/ is a deployed directory, so this file exists on
// the production box. database.js is copied into a scratch dir and required from
// there: it opens `__dirname/data`, which is now the copy's own.
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const db = require(path.join(SCRATCH, 'database.js'));
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
const stockCalls = [];
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore:    id => STORES[id] || null,
  listStores:  () => Object.values(STORES),
  adjustStock: (...args) => { stockCalls.push(args); return { ok: true }; },
  enqueueChannelSync: () => {},
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n(),
                             requireAdmin: (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });

const express = require('express');
const router  = require(path.join(ROOT, 'routes/retail-purchasing.js'));
const app = express();
app.use(router);
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ──────────────────────────────────────────────────────────────────
// The category the typed line files itself under. It is on the tenant's own
// kind='accounting' list because `storeCategory` snaps a written value onto that
// list — a category typed against a list that HOLDS it must come back as the
// listed spelling, and case 4 is worth nothing if it can pass on a near miss.
db.prepare("INSERT INTO categories (kind, name, sort_order) VALUES ('accounting','办公用品 Office supplies',10)").run();

// A product for case 7. Only the columns the receive path reads are set.
try {
  db.prepare(`INSERT INTO store_products (id,name_en,name_cn,sku,is_active)
              VALUES (7,'Oat Milk 1L','燕麦奶1升','P-7',1)`).run();
} catch (e) {
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
  console.log('\n══ 1 · a retail PO accepts a line naming neither catalogue ══');
  let r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1, supplier: 'Sunrise Stationery 晨光文具',
    items: [{ name_en: 'Desk chair', name_cn: '办公椅', qty: 2, unit: 'pcs',
              cost_per_unit: 340, total_cost: 680,
              expense_category: '办公用品 Office supplies' }],
  });
  eq(r.status, 200, 'responds 200');
  const poId = r.body && r.body.id;
  ok(!!poId, 'returns the new PO id');
  let L = lines(poId);
  eq(L.length, 1, 'one line stored');
  eq(L[0].name_en, 'Desk chair', 'the typed name is what was typed');
  eq(L[0].name_cn, '办公椅', 'and both halves are kept apart');
  ok(L[0].store_product_id == null, 'the line carries NO store_product_id');
  ok(L[0].ingredient_id == null,    'and NO ingredient_id');
  eq(L[0].expense_category, '办公用品 Office supplies',
     'its category snapped onto the tenant list');

  console.log('\n══ 2 · a typed line with no name is refused ══');
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c;
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1,
    items: [{ qty: 1, unit: 'pcs', cost_per_unit: 99, total_cost: 99 }],
  });
  eq(r.status, 400, 'refused 400');
  eq(r.body && r.body.error, 'name_required', 'names the missing name');
  eq(db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, beforeCount,
     'and NOTHING was written — the refusal is before the transaction');
  // Whitespace is not a name. `name_en` is NOT NULL and would accept "   ".
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1,
    items: [{ name_en: '   ', qty: 1, unit: 'pcs', cost_per_unit: 99 }],
  });
  eq(r.status, 400, 'a name of spaces is refused too');
  // A CATALOGUE line is NOT held to this — its name comes off its master record.
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1,
    items: [{ store_product_id: 7, name_en: '', qty: 1, unit: 'pcs', cost_per_unit: 9 }],
  });
  eq(r.status, 200, 'a product line with a blank name is still accepted');

  console.log('\n══ 3 · the same refusal guards an edit ══');
  r = await call('PUT', `/api/retail-admin/purchases/${poId}`, {
    date: '2026-09-13', store_id: 1,
    items: [{ id: L[0].id, name_en: '', name_cn: '', qty: 2, unit: 'pcs', cost_per_unit: 340 }],
  });
  eq(r.status, 400, 'rubbing the name out of a saved line is refused 400');
  eq(r.body && r.body.error, 'name_required', 'with the same code');
  eq(lines(poId)[0].name_en, 'Desk chair', 'and the stored line is untouched');

  console.log('\n══ 4 · placing the order posts it under its OWN category ══');
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/status`, { status: 'Ordered' });
  eq(r.status, 200, 'responds 200');
  const exp = db.prepare('SELECT * FROM expense_entries WHERE po_id = ?').all(poId);
  eq(exp.length, 1, 'one expense row was posted');
  ok(Math.abs(Number(exp[0].amount) - 680) < 0.005,
     `it totals the typed line, ¥680 (got ¥${exp[0].amount})`);
  eq(exp[0].category, '办公用品 Office supplies',
     'filed under the line’s category, NOT 门店进货 Retail stock');

  console.log('\n══ 5 · an uncategorised typed line falls to the default ══');
  // Stated rather than assumed: the poster COALESCEs a blank category onto
  // 门店进货 Retail stock. That is wrong for a chair and right for a shelf, and a
  // buyer who skips the field is no worse off than the Finance row this replaces
  // — but it must be a known fallback, not a surprise.
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1,
    items: [{ name_en: 'Repair call-out', qty: 1, unit: 'pcs', cost_per_unit: 150 }],
  });
  const bareId = r.body.id;
  await call('PUT', `/api/retail-admin/purchases/${bareId}/status`, { status: 'Ordered' });
  const bareExp = db.prepare('SELECT * FROM expense_entries WHERE po_id = ?').all(bareId);
  eq(bareExp.length, 1, 'it still posts');
  eq(bareExp[0].category, '门店进货 Retail stock', 'under the poster’s default');

  console.log('\n══ 6 · receiving a typed line moves NO stock ══');
  stockCalls.length = 0;
  L = lines(poId);
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/receive`, {
    receipts: [{ line_id: L[0].id, qty_received: 2 }],
  });
  eq(r.status, 200, 'responds 200');
  const typedLine = lines(poId)[0];
  eq(Number(typedLine.qty_received), 2, 'the arrival is recorded on the line');
  eq(Number(typedLine.stock_applied_qty || 0), 0, 'stock_applied_qty stays 0');
  eq(stockCalls.length, 0, 'inventory.adjustStock was NEVER called');

  console.log('\n══ 7 · a product line on the same PO DOES move stock ══');
  r = await call('POST', '/api/retail-admin/purchases', {
    date: '2026-09-13', store_id: 1, supplier: 'Sunrise Stationery 晨光文具',
    items: [
      { name_en: 'Gloves', name_cn: '手套', qty: 4, unit: 'box', cost_per_unit: 12 },
      { store_product_id: 7, name_en: 'Oat Milk 1L', sku: 'P-7', qty: 3, unit: 'pcs', cost_per_unit: 9 },
    ],
  });
  eq(r.status, 200, 'the mixed PO is created');
  const mixId = r.body.id;
  await call('PUT', `/api/retail-admin/purchases/${mixId}/status`, { status: 'Ordered' });
  const mixLines = lines(mixId);
  const typed = mixLines.find(l => !l.store_product_id && !l.ingredient_id);
  const prod  = mixLines.find(l => l.store_product_id);
  ok(!!typed && !!prod, 'the PO holds one typed line and one product line');

  stockCalls.length = 0;
  r = await call('PUT', `/api/retail-admin/purchases/${mixId}/receive`, {
    receipts: [{ line_id: typed.id, qty_received: 4 },
               { line_id: prod.id,  qty_received: 3 }],
  });
  eq(r.status, 200, 'the delivery is accepted');
  ok(stockCalls.length > 0, `adjustStock ran for the product line (${stockCalls.length}x)`);
  const after = lines(mixId);
  const typedAfter = after.find(l => !l.store_product_id && !l.ingredient_id);
  const prodAfter  = after.find(l => l.store_product_id);
  eq(Number(typedAfter.stock_applied_qty || 0), 0,
     'the typed line STILL applied nothing to stock');
  ok(Number(prodAfter.stock_applied_qty || 0) > 0,
     `the product line applied its arrival (${prodAfter.stock_applied_qty})`);
  eq(Number(typedAfter.qty_received), 4, 'and the typed arrival was still recorded');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
