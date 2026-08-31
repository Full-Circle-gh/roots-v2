#!/usr/bin/env node
// Exercises "Copy from kitchen" — the bridge that brings a kitchen buying
// order (purchase_orders.scope='kitchen', PO-####) into Tacet as an editable
// retail draft (scope='retail', RPO-####).
//
//   GET  /api/retail-admin/purchases/kitchen-source
//   POST /api/retail-admin/purchases/copy-from-kitchen
//
// Runs the REAL router against a fresh database built by database.js itself
// (data/roots.db in a clean checkout), so the copied_from_po_id migration is
// under test too. Only the modules the router reaches around the database are
// stubbed: the operator gate, the tenant handle, the store lookup, the price
// write-back and the activity log.
//
// Run:  node scripts/test_kitchen_po_copy.js
//
// Cases:
//   1. kitchen-source lists kitchen POs only — never a retail one
//   2. a copy lands as a Draft, scope retail, RPO-####, pointing at its source
//   3. its lines carry qty / cost / ingredient_id over, and NOTHING received:
//      qty_received, stock_applied_qty and the invoice mark all start clean
//   4. the kitchen original is byte-for-byte unchanged, still in the kitchen list
//   5. the copy is editable — a quantity change through the normal PUT sticks
//   6. copying the same kitchen PO twice is refused (409 already_copied)
//   7. a batch is all-or-nothing: one bad id copies none of them
//   8. kitchen-source reports the copy it already has, so the picker can grey it
//   9. no store, or no ids → 400, nothing written

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db. scripts/ is a deployed directory (see the allowlist in
// .github/workflows/deploy.yml), so this file exists on the production box, and
// a test that reached for the app's real database path would be one stray
// `node` away from destroying it.
//
// It still has to be a database database.js BUILT, though — the point of the
// copy_from_po_id assertions is that the migration ran. So database.js is copied
// into a scratch directory and required from there: it opens `__dirname/data`,
// which is now the scratch copy's own. The scratch dir sits inside the repo so
// that `require('better-sqlite3')` still resolves by walking up to node_modules.
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const db = require(path.join(SCRATCH, 'database.js'));
// The router says `require('../database')`. Point that at the scratch handle,
// so nothing in this process can open the real one.
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

// ── stubs, primed before the router is required ───────────────────────────
function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
stub('lib/tenant-db.js',   { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js',   { getStore: id => STORES[id] || null,
                             listStores: () => Object.values(STORES),
                             adjustStock: () => {} });
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });
stub('routes/purchases.js', { firePriceAlertsForPO: () => {},
                              allocateLandedExtras: () => ({}) });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}) });

const express = require('express');
const router  = require(path.join(ROOT, 'routes/retail-purchasing.js'));
const app = express();
app.use(router);
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed: two kitchen POs + one retail PO that must never show up ──────────
db.prepare(`INSERT INTO ingredients (id,name_en,name_cn,sku,unit,buy_unit,cost_per_unit)
            VALUES (66,'Black Sesame','黑芝麻','C-40','g','bag',15.8)`).run();
db.prepare(`INSERT INTO ingredients (id,name_en,sku,unit,buy_unit,cost_per_unit)
            VALUES (139,'Red Lentils','C-5','g','bag',10.21)`).run();

const insPO = db.prepare(`INSERT INTO purchase_orders
  (id,po_number,date,delivery_date,status,supplier,warehouse,notes,scope,store_id,tenant_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
insPO.run(48, 'PO-0048', '2026-08-01', '2026-08-05', 'Ordered', 'Fresh Co.', 'Main', 'Back door before 9.', 'kitchen', null, 1);
insPO.run(49, 'PO-0049', '2026-08-02', null,         'Requested', null,      null,   null,                  'kitchen', null, 1);
insPO.run(90, 'RPO-0001','2026-08-03', null,         'Ordered',   'Oat Works', null,  null,                  'retail',  1,    1);

const insLine = db.prepare(`INSERT INTO po_line_items
  (po_id,ingredient_id,name_en,name_cn,sku,qty,unit,cost_per_unit,total_cost,
   supplier_name,purchase_channel,note,qty_received,stock_applied_qty,invoice_status,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// The kitchen original is fully received and already marked invoiced — none of
// that may travel with the copy.
insLine.run(48, 66,  'Black Sesame', '黑芝麻', 'C-40', 4, 'bag', 26,   104, 'Fresh Co.', 'Taobao', 'ask for fresh', 4, 4, 'received', 0);
insLine.run(48, 139, 'Red Lentils',  null,    'C-5',  2, 'bag', 10.5, 21,  'Fresh Co.', null,     null,            2, 2, 'received', 1);
insLine.run(49, 66,  'Black Sesame', '黑芝麻', 'C-40', 1, 'bag', 27,   27,  null,        null,     null,            null, 0, 'not_received', 0);

// ── tiny assert harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok  = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                             else { fail++; console.log('  ✗ ' + msg); } };
const eq  = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log('\n══ 1 · kitchen-source lists kitchen POs, and only those ══');
  let r = await call('GET', '/api/retail-admin/purchases/kitchen-source');
  eq(r.status, 200, 'responds 200');
  const nums = (r.body.data || []).map(p => p.po_number);
  ok(nums.includes('PO-0048') && nums.includes('PO-0049'), 'both kitchen orders are offered');
  ok(!nums.includes('RPO-0001'), 'the retail PO is not offered');
  const src48 = r.body.data.find(p => p.po_number === 'PO-0048');
  eq(src48.line_count, 2, 'PO-0048 reports its 2 lines');
  eq(src48.total_cost, 125, 'PO-0048 totals its lines');
  eq(src48.copy_id, null, 'it has no copy yet');

  console.log('\n══ 2 · a copy lands as an editable retail draft ══');
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                 { po_ids: [48], store_id: 1 });
  eq(r.status, 200, 'responds 200');
  const made = r.body.data[0];
  eq(made.po_number, 'RPO-0002', 'takes the next RPO number');
  eq(made.from_po_number, 'PO-0048', 'reports which kitchen order it came from');
  const copy = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(made.id);
  eq(copy.status, 'Requested', 'lands as a Draft — nothing posts to Finance yet');
  eq(copy.scope, 'retail', 'is a retail order');
  eq(copy.store_id, 1, 'is filed under the chosen store');
  eq(copy.copied_from_po_id, 48, 'remembers its source');
  eq(copy.source, 'kitchenCopy', 'is marked as a kitchen copy, not manual');
  eq(copy.supplier, 'Fresh Co.', 'carries the supplier over');
  eq(copy.date, '2026-08-01', 'carries the order date over');
  eq(copy.delivery_date, '2026-08-05', 'carries the delivery date over');
  eq(copy.notes, 'Back door before 9.', 'carries the notes over');

  console.log('\n══ 3 · the lines come over, with nothing received ══');
  const lines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(made.id);
  eq(lines.length, 2, 'both lines copied');
  eq(lines[0].ingredient_id, 66, 'the material link survives');
  eq(lines[0].qty, 4, 'quantity copied');
  eq(lines[0].cost_per_unit, 26, 'unit cost copied');
  eq(lines[0].total_cost, 104, 'line total recomputed from qty × cost');
  eq(lines[0].unit, 'bag', 'unit copied');
  eq(lines[0].note, 'ask for fresh', 'line note copied');
  eq(lines[0].purchase_channel, 'Taobao', 'purchase channel copied');
  ok(lines.every(l => l.qty_received === null), 'nothing is marked received');
  ok(lines.every(l => !l.stock_applied_qty), 'no stock has been applied');
  ok(lines.every(l => l.invoice_status === 'not_received'), 'the invoice mark starts clean');
  ok(lines.every(l => l.store_product_id === null), 'no line carries a product id (never both)');

  console.log('\n══ 4 · the kitchen original is untouched ══');
  const orig = db.prepare("SELECT * FROM purchase_orders WHERE po_number = 'PO-0048'").get();
  eq(orig.scope, 'kitchen', 'still kitchen-scope');
  eq(orig.status, 'Ordered', 'still Ordered');
  eq(orig.copied_from_po_id, null, 'the original points at nothing');
  const origLines = db.prepare('SELECT * FROM po_line_items WHERE po_id = 48').all();
  eq(origLines.length, 2, 'still has its own 2 lines');
  eq(origLines[0].qty_received, 4, 'its received counts are intact');

  console.log('\n══ 5 · the copy is re-quantifiable — the whole point ══');
  r = await call('PUT', '/api/retail-admin/purchases/' + made.id, {
    date: copy.date, supplier: copy.supplier, store_id: 1,
    items: lines.map(l => ({ id: l.id, ingredient_id: l.ingredient_id, name_en: l.name_en,
                             sku: l.sku, qty: l.id === lines[0].id ? 10 : l.qty,
                             unit: l.unit, cost_per_unit: l.cost_per_unit })),
  });
  eq(r.status, 200, 'the edit is accepted');
  const edited = db.prepare('SELECT * FROM po_line_items WHERE id = ?').get(lines[0].id);
  eq(edited.qty, 10, 'the new quantity stuck');
  eq(edited.total_cost, 260, 'the line total followed it');
  const origAfter = db.prepare('SELECT qty FROM po_line_items WHERE po_id = 48 ORDER BY sort_order').get();
  eq(origAfter.qty, 4, "and the kitchen original's quantity did not move");

  console.log('\n══ 5b · the retail ledger names where the copy came from ══');
  r = await call('GET', '/api/retail-admin/purchases');
  const listed = (r.body.data || []).find(p => p.po_number === 'RPO-0002');
  ok(!!listed, 'the copy is in the retail list');
  eq(listed.copied_from_po_number, 'PO-0048', 'and the row carries its source PO number');
  const native = (r.body.data || []).find(p => p.po_number === 'RPO-0001');
  eq(native.copied_from_po_number, null, 'a natively-created order carries none');

  console.log('\n══ 6 · the same kitchen order cannot be copied twice ══');
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                 { po_ids: [48], store_id: 1 });
  eq(r.status, 409, 'refused');
  eq(r.body.error, 'already_copied', 'and says why');
  eq(r.body.copies[0].copy_po_number, 'RPO-0002', 'naming the copy that already exists');

  console.log('\n══ 7 · a batch is all-or-nothing ══');
  const before = db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n;
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                 { po_ids: [49, 4242], store_id: 1 });
  eq(r.status, 404, 'an unknown id fails the batch');
  ok((r.body.missing || []).includes(4242), 'and names the id it could not find');
  eq(db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n, before,
     'PO-0049 was not copied either — nothing half-written');

  console.log('\n══ 8 · the picker can see what is already copied ══');
  r = await call('GET', '/api/retail-admin/purchases/kitchen-source');
  const again48 = r.body.data.find(p => p.po_number === 'PO-0048');
  eq(again48.copy_po_number, 'RPO-0002', 'PO-0048 reports its copy');
  const again49 = r.body.data.find(p => p.po_number === 'PO-0049');
  eq(again49.copy_id, null, 'PO-0049 is still free to copy');

  console.log('\n══ 9 · bad requests write nothing ══');
  const n0 = db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n;
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen', { po_ids: [49] });
  eq(r.status, 400, 'no store → 400');
  eq(r.body.error, 'store_required', 'and says which field');
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen', { po_ids: [], store_id: 1 });
  eq(r.status, 400, 'no ids → 400');
  eq(r.body.error, 'po_ids_required', 'and says which field');
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen', { po_ids: [90], store_id: 1 });
  eq(r.status, 404, 'a retail PO is not a copy source');
  eq(db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n, n0,
     'none of those wrote a row');

  console.log('\n══ 10 · another tenant\'s kitchen orders are not on offer ══');
  db.prepare("UPDATE purchase_orders SET tenant_id = 2 WHERE po_number = 'PO-0049'").run();
  r = await call('GET', '/api/retail-admin/purchases/kitchen-source');
  ok(!(r.body.data || []).some(p => p.po_number === 'PO-0049'), 'it is gone from the picker');
  const n1 = db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n;
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                 { po_ids: [49], store_id: 1 });
  eq(r.status, 404, 'and it cannot be copied by id either');
  eq(db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE scope = 'retail'").get().n, n1,
     'nothing was written');
  db.prepare("UPDATE purchase_orders SET tenant_id = 1 WHERE po_number = 'PO-0049'").run();

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
