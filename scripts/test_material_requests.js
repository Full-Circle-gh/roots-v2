#!/usr/bin/env node
// The kitchen asks the buyer to BUY; the buyer turns the ask into a DRAFT
// purchase order. docs/tacet-consolidation-decisions.md §86.
//
//   POST /api/retail-admin/material-requests
//   GET  /api/retail-admin/material-requests/materials
//   GET  /api/retail-admin/material-requests/pending-lines
//   PUT  /api/retail-admin/material-requests/:id
//   PUT  /api/retail-admin/material-requests/:id/archive
//   PUT  /api/retail-admin/material-requests/lines/:lineId/decline
//   POST /api/retail-admin/purchases/from-material-requests
//   DELETE /api/retail-admin/purchases/:id            (releases the lines again)
//
// BOTH REAL ROUTERS, against a database database.js itself BUILT — so the new
// tables' migration is under test too, not only the handlers. Only the modules
// around the database are stubbed: the operator gate, the tenant handle, the
// store lookup, the price write-back, the expense poster and the recycle bin.
//
// Run:  node scripts/test_material_requests.js
//
// Cases:
//   1. the picker lists active materials with their BUY unit, and no price
//   2. a request stores buy_unit, merges a repeated material, and lands 'sent'
//   3. a bad line writes NOTHING — not the header, not the good lines
//   4. pending-lines offers sent lines only: never a draft, never an archived one
//   5. converting makes a DRAFT, carries qty/unit/ingredient_id, prices from the
//      material's own buy_price, and receives nothing
//   6. a line is sourced once — the same line again is refused 409
//   7. the request is the ROLLUP: part-sourced stays 'sent', fully sourced flips
//   8. deleting the draft gives the lines back and rolls the request BACK
//   9. archiving is refused while a line is on an order
//  10. a sent request cannot be edited underneath the buyer
//  11. the buyer strikes ONE line off: it leaves the list, cannot be ordered,
//      cannot be struck once it is on an order, and the rollup ignores it
//  12. every line struck off and nothing bought — the request is withdrawn

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db. scripts/ is a deployed directory, so this file exists on
// the production box and a test that reached for the app's real database path
// would be one stray `node` away from destroying it. Same scratch-copy trick,
// and the same reasoning, as scripts/test_kitchen_po_copy.js.
const SCRATCH = path.join(ROOT, `.test-scratch-mr-${process.pid}`);
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
                               req.user = { id: 7, username: 'cook', display_name: 'Mei' }; next(); } });
stub('routes/purchases.js', { firePriceAlertsForPO: () => {},
                              allocateLandedExtras: () => ({}),
                              postPOExpenses: () => ({ skipped: 'stubbed' }) });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}) });
// The recycle bin keeps a deleted draft for sixty days and is its own module
// with its own suite. Stubbed RECORDING rather than silently: case 8 is about
// what the delete gives BACK to the kitchen, and a delete that never reached
// the recycle path would be a different delete from the real one.
const recycled = [];
stub('lib/recycle.js', { capture: (h, kind, id) => { recycled.push({ kind, id }); } });

const express = require('express');
const mrRouter = require(path.join(ROOT, 'routes/retail-material-requests.js'));
const puRouter = require(path.join(ROOT, 'routes/retail-purchasing.js'));
const app = express();
app.use(mrRouter);
app.use(puRouter);
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed: three materials, one of them archived ───────────────────────────
db.prepare(`INSERT INTO ingredients (id,name_en,name_cn,sku,unit,buy_unit,buy_price,supplier,is_active)
            VALUES (11,'Flour','面粉','M-1','g','bag',26,'Fresh Co.',1)`).run();
db.prepare(`INSERT INTO ingredients (id,name_en,name_cn,sku,unit,buy_unit,buy_price,is_active)
            VALUES (12,'Olive Oil','橄榄油','M-2','ml','bottle',88,1)`).run();
db.prepare(`INSERT INTO ingredients (id,name_en,sku,unit,buy_unit,buy_price,is_active)
            VALUES (13,'Old Spice','M-3','g','bag',4,0)`).run();

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
  console.log('\n══ 1 · the picker offers active materials, their buy unit, and no price ══');
  let r = await call('GET', '/api/retail-admin/material-requests/materials');
  eq(r.status, 200, 'responds 200');
  const mats = r.body.data;
  eq(mats.length, 2, 'the archived material is not offered');
  const flour = mats.find(m => m.id === 11);
  eq(flour.buy_unit, 'bag', 'flour carries its BUY unit, not its recipe unit');
  eq(mats.find(m => m.id === 12).buy_unit, 'bottle', 'oil carries its own');
  // A cook holds neither materials:view nor materials:costs. The absence is the
  // server's, not a screen's discretion — so it is asserted on the payload.
  ok(mats.every(m => !('buy_price' in m) && !('cost_per_unit' in m)),
     'no cost column reaches the kitchen at all');

  console.log('\n══ 2 · a request stores the buy unit, merges a repeat, and is sent ══');
  r = await call('POST', '/api/retail-admin/material-requests',
                 { send: true, items: [{ ingredient_id: 11, qty: 4, notes: 'low' },
                                       { ingredient_id: 12, qty: 2 },
                                       { ingredient_id: 11, qty: 1 }] });
  eq(r.status, 200, 'responds 200');
  const req1 = r.body.data;
  eq(req1.mr_number, 'MR-0001', 'takes the first number in the series');
  eq(req1.status, 'sent', 'send:true lands it on the buyer, not in a drawer');
  ok(!!req1.sent_at, 'the send is stamped');
  eq(req1.created_by_name, 'Mei', 'records who asked');
  eq(req1.items.length, 2, 'the repeated material became ONE line, not two');
  const l11 = req1.items.find(i => i.ingredient_id === 11);
  eq(l11.qty, 5, 'its quantities were added');
  eq(l11.unit, 'bag', 'the line carries buy_unit — never the recipe unit');
  eq(l11.notes, 'low', 'the note survives the merge');
  eq(l11.sourced_po_id, null, 'nothing is on an order yet');

  console.log('\n══ 3 · a bad line writes nothing at all ══');
  const before = db.prepare('SELECT COUNT(*) AS c FROM material_requests').get().c;
  r = await call('POST', '/api/retail-admin/material-requests',
                 { items: [{ ingredient_id: 11, qty: 3 }, { ingredient_id: 999, qty: 1 }] });
  eq(r.status, 400, 'an unknown material is refused');
  eq(r.body.error, 'material_not_found', 'and named');
  r = await call('POST', '/api/retail-admin/material-requests',
                 { items: [{ ingredient_id: 11, qty: 0 }] });
  eq(r.status, 400, 'a zero quantity is refused');
  eq(r.body.error, 'qty_invalid', 'and named');
  r = await call('POST', '/api/retail-admin/material-requests', { items: [] });
  eq(r.status, 400, 'an empty request is refused rather than created empty');
  eq(db.prepare('SELECT COUNT(*) AS c FROM material_requests').get().c, before,
     'not one header was written by the three refusals');
  eq(db.prepare('SELECT COUNT(*) AS c FROM material_request_items').get().c, 2,
     'and not one line');

  console.log('\n══ 4 · the buyer sees SENT lines only ══');
  // A draft (still being typed) and an archived request (withdrawn) must not
  // reach the buyer's list.
  const draft = (await call('POST', '/api/retail-admin/material-requests',
                            { send: false, items: [{ ingredient_id: 12, qty: 9 }] })).body.data;
  eq(draft.status, 'draft', 'send:false stays a draft');
  const gone = (await call('POST', '/api/retail-admin/material-requests',
                           { send: true, items: [{ ingredient_id: 12, qty: 7 }] })).body.data;
  await call('PUT', `/api/retail-admin/material-requests/${gone.id}/archive`, { archived: true });
  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  const pending = r.body.data;
  eq(pending.length, 2, 'only the two live sent lines are offered');
  ok(pending.every(l => l.mr_number === 'MR-0001'), 'both belong to the sent request');
  ok(pending.every(l => l.unit), 'every offered line names the unit it is counted in');

  console.log('\n══ 5 · converting makes a DRAFT order, priced from the material ══');
  const flourLine = pending.find(l => l.ingredient_id === 11);
  r = await call('POST', '/api/retail-admin/purchases/from-material-requests',
                 { line_ids: [flourLine.id], store_id: 1 });
  eq(r.status, 200, 'responds 200');
  const made = r.body.data;
  eq(made.po_number, 'RPO-0001', 'takes the next retail number');
  eq(made.line_count, 1, 'holds the one ticked line');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(made.id);
  // THE WHOLE OF PART ONE OF §86 IS THIS ASSERTION. Ordered is what posts the
  // expense and writes the price back; a request that arrived already Ordered
  // would mean a cook had reached the books.
  eq(po.status, 'Requested', 'it lands as a Draft — nothing has posted to Finance');
  eq(po.scope, 'retail', 'it is a retail order');
  eq(po.store_id, 1, 'filed under the chosen store');
  eq(po.source, 'materialRequest', 'marked as raised from a request, not manual');
  const poLines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ?').all(made.id);
  eq(poLines.length, 1, 'one line');
  eq(poLines[0].ingredient_id, 11, 'the material link travels');
  eq(poLines[0].store_product_id, null, 'and never a product id beside it');
  eq(poLines[0].qty, 5, 'the kitchen’s quantity is unchanged');
  // If this ever reads 'g', firePriceAlertsForPO stops writing the price back
  // and nothing else in the product says so.
  eq(poLines[0].unit, 'bag', 'the unit is the material’s buy unit, unconverted');
  eq(poLines[0].cost_per_unit, 26, 'the last buy price is prefilled for the buyer');
  eq(poLines[0].supplier_name, 'Fresh Co.', 'the master supplier is prefilled');
  ok(poLines[0].qty_received === null, 'nothing is received');
  ok(!poLines[0].stock_applied_qty, 'no stock has been applied');

  console.log('\n══ 6 · a line is sourced once ══');
  r = await call('POST', '/api/retail-admin/purchases/from-material-requests',
                 { line_ids: [flourLine.id], store_id: 1 });
  eq(r.status, 409, 'the same line again is refused');
  eq(r.body.error, 'already_sourced', 'by name');
  eq(r.body.lines[0].po_number, 'RPO-0001', 'and it says which order already has it');
  eq(db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE scope='retail'").get().c, 1,
     'no second order was created');

  console.log('\n══ 7 · the request is the rollup, not the unit ══');
  let row = db.prepare('SELECT * FROM material_requests WHERE id = ?').get(req1.id);
  eq(row.status, 'sent', 'one of two lines sourced leaves the request open');
  const oilLine = pending.find(l => l.ingredient_id === 12);
  const second = (await call('POST', '/api/retail-admin/purchases/from-material-requests',
                             { line_ids: [oilLine.id], store_id: 1, supplier: 'Oil Ltd' })).body.data;
  eq(second.po_number, 'RPO-0002', 'the second half can go to a different supplier');
  row = db.prepare('SELECT * FROM material_requests WHERE id = ?').get(req1.id);
  eq(row.status, 'sourced', 'once every line is on an order the request closes');
  ok(!!row.sourced_at, 'and is stamped');
  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  eq(r.body.data.length, 0, 'nothing is left waiting on the buyer');

  console.log('\n══ 8 · deleting the draft gives the ask back ══');
  r = await call('DELETE', `/api/retail-admin/purchases/${second.id}`);
  eq(r.status, 200, 'the draft deletes');
  ok(recycled.some(x => x.kind === 'purchase_order' && x.id === second.id),
     'and still goes through the recycle bin');
  row = db.prepare('SELECT * FROM material_requests WHERE id = ?').get(req1.id);
  eq(row.status, 'sent', 'the request rolls BACK — it is outstanding again');
  eq(row.sourced_at, null, 'and its closing stamp is cleared');
  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  eq(r.body.data.length, 1, 'the released line is back on the buyer’s list');
  eq(r.body.data[0].ingredient_id, 12, 'and it is the right one');

  console.log('\n══ 9 · a request with a line on an order cannot be withdrawn ══');
  r = await call('PUT', `/api/retail-admin/material-requests/${req1.id}/archive`, { archived: true });
  eq(r.status, 409, 'archiving is refused');
  eq(r.body.error, 'already_sourced', 'by name');
  eq(db.prepare('SELECT archived_at FROM material_requests WHERE id = ?').get(req1.id).archived_at, null,
     'and nothing was archived');

  console.log('\n══ 10 · a sent request cannot be edited underneath the buyer ══');
  r = await call('PUT', `/api/retail-admin/material-requests/${draft.id}`,
                 { items: [{ ingredient_id: 12, qty: 3 }] });
  eq(r.status, 200, 'a draft edits');
  eq(r.body.data.items[0].qty, 3, 'and the new quantity sticks');
  await call('PUT', `/api/retail-admin/material-requests/${draft.id}/send`);
  r = await call('PUT', `/api/retail-admin/material-requests/${draft.id}`,
                 { items: [{ ingredient_id: 12, qty: 99 }] });
  eq(r.status, 409, 'once sent, an edit is refused');
  eq(r.body.error, 'not_draft', 'by name');
  eq(db.prepare('SELECT qty FROM material_request_items WHERE request_id = ?').get(draft.id).qty, 3,
     'and the line the buyer is reading is unchanged');

  console.log('\n══ 11 · the buyer strikes ONE line off, and the rollup ignores it ══');
  // §171. The grain is the line: this request has one line on an order and one
  // outstanding, and striking the outstanding one must not touch the other.
  const sourcedLine = db.prepare(
    'SELECT id FROM material_request_items WHERE request_id = ? AND sourced_po_id IS NOT NULL').get(req1.id);
  r = await call('PUT', `/api/retail-admin/material-requests/lines/${sourcedLine.id}/decline`);
  eq(r.status, 409, 'a line already on an order cannot be struck off');
  eq(r.body.error, 'already_sourced', 'by name');
  eq(db.prepare('SELECT declined_at FROM material_request_items WHERE id = ?').get(sourcedLine.id).declined_at,
     null, 'and nothing was struck');

  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  const live = r.body.data.find(l => l.request_id === req1.id);
  ok(!!live, 'the outstanding line is on the list before we strike it');
  r = await call('PUT', `/api/retail-admin/material-requests/lines/${live.id}/decline`);
  eq(r.status, 200, 'the outstanding line strikes off');
  const struckRow = db.prepare('SELECT * FROM material_request_items WHERE id = ?').get(live.id);
  ok(!!struckRow.declined_at, 'the refusal is stamped');
  eq(struckRow.declined_by_name, 'Mei', 'and records who refused it');
  eq(struckRow.sourced_po_id, null, 'striking it off did not put it on an order');
  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  ok(!r.body.data.some(l => l.id === live.id), 'it has left the buyer’s list');
  // The rollup counts only lines still outstanding. Counting a struck line as
  // DONE would say 'sourced' — "every line reached a purchase order" — over a
  // line nobody bought; leaving it in the total would hold the request open
  // forever against a line nobody will ever buy.
  row = db.prepare('SELECT * FROM material_requests WHERE id = ?').get(req1.id);
  eq(row.status, 'sourced', 'with the struck line out of the sum, the request closes on the one that WAS bought');
  eq(row.archived_at, null, 'and a request that bought something is not withdrawn');

  // A tick made before another buyer struck it off reaches the conversion.
  r = await call('POST', '/api/retail-admin/purchases/from-material-requests',
                 { line_ids: [live.id], store_id: 1 });
  eq(r.status, 409, 'a struck line cannot be turned into an order');
  eq(r.body.error, 'line_declined', 'by name');
  // Idempotent, like the send: a second press must not move the stamp that
  // records WHEN the buyer refused it.
  const stampWas = struckRow.declined_at;
  r = await call('PUT', `/api/retail-admin/material-requests/lines/${live.id}/decline`);
  eq(r.status, 200, 'a second press answers success');
  eq(db.prepare('SELECT declined_at FROM material_request_items WHERE id = ?').get(live.id).declined_at,
     stampWas, 'and leaves the original stamp alone');

  console.log('\n══ 12 · strike off every line and the ask is withdrawn ══');
  // Nothing bought, nothing outstanding — the request is withdrawn, which is
  // what archived_at has meant here since §86. Left open it would sit in the
  // buyer's list forever with nothing on it.
  const lastLine = db.prepare('SELECT id FROM material_request_items WHERE request_id = ?').get(draft.id);
  r = await call('PUT', `/api/retail-admin/material-requests/lines/${lastLine.id}/decline`);
  eq(r.status, 200, 'the last outstanding line strikes off');
  row = db.prepare('SELECT * FROM material_requests WHERE id = ?').get(draft.id);
  ok(!!row.archived_at, 'the request with nothing left on it is withdrawn');
  ok(row.status !== 'sourced', 'and is NOT called sourced — nobody bought anything');
  r = await call('GET', '/api/retail-admin/material-requests/pending-lines');
  eq(r.body.data.length, 0, 'the buyer’s list is empty');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
