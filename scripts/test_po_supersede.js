#!/usr/bin/env node
// One purchase, two rows — and only one of them in the books.
//
// "Copy from kitchen" brings a kitchen buying order (scope='kitchen', PO-####)
// into Tacet as an editable retail draft (scope='retail', RPO-####). Placing
// that copy used to put the SAME goods into expense_entries a second time and
// onto the 发票 chase a second time, line for line — which is exactly what a
// buyer reported: PO-0066 and RPO-0022 asking for the same three invoices, the
// only difference being the one quantity they had corrected on the copy.
//
// lib/po-supersede.js is the rule that fixes it — a placed copy stands its
// kitchen original down — and this exercises the rule end to end through the
// REAL routers, against a database database.js itself built.
//
// Run:  node scripts/test_po_supersede.js
//
// Cases:
//   1. before any copy: the kitchen order is in the chase and in the books
//   2. a DRAFT copy changes nothing — the original still stands alone
//   3. placing the copy hands over: the original leaves both chases and its
//      expense rows go; the copy's own (edited) figures take their place
//   4. the chase names where the original went, so it did not just vanish
//      — and the money is counted ONCE, at the copy's corrected total
//   5. it reverses: put the copy back to Draft and the original is live again
//   6. cancelling the copy hands the books back the same way
//   7. a 发票 already recorded against the original is reported on the copy,
//      never silently dropped
//   8. an unrelated kitchen order is untouched by any of it

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db — scripts/ is deployed, so this file exists on the
// production box (the reasoning is spelled out in test_kitchen_po_copy.js).
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* already linked */ }
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } };
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
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });

// routes/purchases.js is NOT stubbed — postPOExpenses IS the thing under test
// on the kitchen side, and a stub of it would prove nothing. What is replaced,
// after the real module has loaded, is only the two exports whose side effects
// belong to other tests: the price write-back (appends ingredient price history
// and fires alerts) and the landed-cost split (needs store data this fixture has
// no reason to carry). Everything else, postPOExpenses included, stays real.
const purchases = require(path.join(ROOT, 'routes/purchases.js'));
const purchasesPath = require.resolve(path.join(ROOT, 'routes/purchases.js'));
require.cache[purchasesPath].exports = Object.assign(
  Object.create(null), purchases, {
    firePriceAlertsForPO: () => ({ skips: [], landedSkips: [], landedExtras: 0 }),
    allocateLandedExtras: () => ({ perUnit: new Map(), skipped: [], extras: 0, totalGoods: 0 }),
  });
const { postPOExpenses } = purchases;

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
app.use(require(path.join(ROOT, 'routes/finance.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// PO-0100 is the buyer's case, shrunk: two coconut lines from one supplier,
// Ordered, its cost already in the books. PO-0101 is the control — a kitchen
// order nobody copies, which must read identically at the end of the run.
const insPO = db.prepare(`INSERT INTO purchase_orders
  (id,po_number,date,status,supplier,scope,store_id,tenant_id)
  VALUES (?,?,?,?,?,?,?,?)`);
insPO.run(100, 'PO-0100', '2026-08-24', 'Ordered', 'Taishigang', 'kitchen', null, 1);
insPO.run(101, 'PO-0101', '2026-08-24', 'Ordered', 'Huiyang',    'kitchen', null, 1);

const insLine = db.prepare(`INSERT INTO po_line_items
  (po_id,name_en,name_cn,sku,qty,unit,cost_per_unit,total_cost,expense_category,
   supplier_name,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
insLine.run(100, 'Kara Coconut Cream',  '佳乐 高浓度椰浆', 'F-6',  12, 'bottle', 32.33, 387.96, '厨房进货 Kitchen', 'Taishigang', 0);
insLine.run(100, 'Real Thai Coconut Milk', '丽尔泰 椰浆',  'F-15', 24, 'bottle', 24.88, 597.12, '厨房进货 Kitchen', 'Taishigang', 1);
insLine.run(101, 'Organic Pea Protein',  '有机豌豆蛋白粉', 'D-8',  20.4, 'kg',   45,    918,    '厨房进货 Kitchen', 'Huiyang',    0);

postPOExpenses(100);
postPOExpenses(101);

// ── tiny assert harness ────────────────────────────────────────────────────
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

const expensesFor  = poId => db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries WHERE po_id = ?').get(poId).t;
const round2 = n => Math.round(n * 100) / 100;

// Every line the retail 发票 chase is showing, flattened out of its supplier
// groups — the chase is the screen the buyer was reading.
async function chaseLines() {
  const r = await call('GET', '/api/retail-admin/purchasing/invoices/outstanding');
  const groups = (r.body && r.body.data && r.body.data.groups) || [];
  return { lines: groups.flatMap(g => g.lines), totals: r.body.data.totals };
}
const numbersIn = lines => [...new Set(lines.map(l => l.po_number))].sort();
// …and the kitchen's own chase, the other reader of the same rule. It must
// never come back empty by accident — an empty list would make every "the
// kitchen chase dropped it" assertion below pass for the wrong reason — so the
// shape is asserted here rather than defaulted away.
async function kitchenChasePOs() {
  const r = await call('GET', '/api/finance/outstanding-lines');
  const groups = r.body && r.body.data && r.body.data.groups;
  if (!Array.isArray(groups)) throw new Error('kitchen chase returned no groups: ' + JSON.stringify(r.body));
  return [...new Set(groups.flatMap(g => g.lines).map(l => l.po_number))].sort();
}

async function main() {
  console.log('\n══ 1 · before any copy, the kitchen order stands alone ══');
  let c = await chaseLines();
  ok(numbersIn(c.lines).includes('PO-0100'), 'PO-0100 is on the 发票 chase');
  eq(round2(c.lines.filter(l => l.po_number === 'PO-0100').reduce((s, l) => s + l.amount, 0)),
     985.08, 'for the full ¥985.08 it ordered');
  ok((await kitchenChasePOs()).includes('PO-0100'), "and on the kitchen's own chase");
  eq(round2(expensesFor(100)), 985.08, 'its cost is in the books once');

  console.log('\n══ 2 · a DRAFT copy changes nothing ══');
  let r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                     { po_ids: [100], store_id: 1 });
  eq(r.status, 200, 'the copy is made');
  const copyId = r.body.data[0].id;
  const copyNo = r.body.data[0].po_number;
  c = await chaseLines();
  ok(numbersIn(c.lines).includes('PO-0100'), 'the original is still on the chase');
  ok(!numbersIn(c.lines).includes(copyNo), 'the draft copy is not — a draft owes nobody a 发票');
  eq(round2(expensesFor(100)), 985.08, 'the original still holds the cost');
  eq(expensesFor(copyId), 0, 'the draft has posted nothing');

  console.log('\n══ 3 · the buyer corrects a quantity and places the copy ══');
  const copyLines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(copyId);
  r = await call('PUT', '/api/retail-admin/purchases/' + copyId, {
    date: '2026-08-24', supplier: 'Taishigang', store_id: 1,
    items: copyLines.map((l, i) => ({
      id: l.id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
      qty: i === 0 ? 10 : l.qty, unit: l.unit, cost_per_unit: l.cost_per_unit,
      expense_category: l.expense_category, supplier_name: l.supplier_name,
    })),
  });
  eq(r.status, 200, 'the edit is accepted (12 bottles → 10)');
  r = await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Ordered' });
  eq(r.status, 200, 'and the copy is placed');

  console.log('\n══ 4 · the copy takes over — the purchase is counted ONCE ══');
  c = await chaseLines();
  ok(!numbersIn(c.lines).includes('PO-0100'), 'PO-0100 has left the chase');
  ok(numbersIn(c.lines).includes(copyNo), `${copyNo} is on it instead`);
  const copyChase = c.lines.filter(l => l.po_number === copyNo);
  eq(round2(copyChase.reduce((s, l) => s + l.amount, 0)), 920.42,
     "at the copy's corrected total, not the original's");
  eq(copyChase[0].supersedes_po_number, 'PO-0100', 'and the chase names the order it replaced');
  eq(copyChase[0].supersedes_invoiced, 0, 'with nothing already invoiced against it');
  ok(!(await kitchenChasePOs()).includes('PO-0100'), "the kitchen's chase drops it too");
  eq(expensesFor(100), 0, 'the original holds no expense rows any more');
  eq(round2(expensesFor(copyId)), 920.42, 'the copy holds the cost, once');
  const orig = db.prepare('SELECT * FROM purchase_orders WHERE id = 100').get();
  eq(orig.status, 'Ordered', 'the kitchen row itself is untouched — still Ordered');
  eq(db.prepare('SELECT COUNT(*) AS n FROM po_line_items WHERE po_id = 100').get().n, 2,
     'still has both its lines');

  console.log('\n══ 5 · back to Draft hands the books straight back ══');
  r = await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Requested' });
  eq(r.status, 200, 'the copy drops back to Draft');
  c = await chaseLines();
  ok(numbersIn(c.lines).includes('PO-0100'), 'PO-0100 is on the chase again');
  ok(!numbersIn(c.lines).includes(copyNo), 'and the draft is not');
  eq(round2(expensesFor(100)), 985.08, 'its expense rows are back, at its own figures');
  eq(expensesFor(copyId), 0, 'and the draft holds none');

  console.log('\n══ 6 · cancelling a placed copy hands them back the same way ══');
  await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Ordered' });
  eq(expensesFor(100), 0, 'placed again → the original stands down again');
  r = await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Cancelled' });
  eq(r.status, 200, 'the copy is cancelled');
  eq(round2(expensesFor(100)), 985.08, 'a cancelled copy supersedes nothing');
  ok(numbersIn((await chaseLines()).lines).includes('PO-0100'), 'and the original is chased again');

  console.log('\n══ 7 · a 发票 already recorded against the original is reported, not lost ══');
  const invId = db.prepare(
    "INSERT INTO invoices (supplier, invoice_number, amount, date) VALUES ('Taishigang','INV-1',387.96,'2026-08-25')"
  ).run().lastInsertRowid;
  const origLine = db.prepare('SELECT id FROM po_line_items WHERE po_id = 100 ORDER BY sort_order').get();
  db.prepare('INSERT INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,387.96)')
    .run(invId, origLine.id);
  await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Ordered' });
  c = await chaseLines();
  const withInv = c.lines.filter(l => l.po_number === copyNo);
  eq(withInv[0].supersedes_invoiced, 387.96, 'the copy carries what was invoiced on the original');
  eq(db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE line_id = ?').get(origLine.id).n, 1,
     'and the allocation itself is untouched in the ledger');

  console.log('\n══ 8 · the kitchen order nobody copied is untouched throughout ══');
  c = await chaseLines();
  ok(numbersIn(c.lines).includes('PO-0101'), 'PO-0101 is still on the chase');
  eq(round2(expensesFor(101)), 918, 'and still holds its own cost');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
