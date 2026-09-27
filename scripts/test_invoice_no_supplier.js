#!/usr/bin/env node
//
// test_invoice_no_supplier.js — a 发票 for a one-off purchase needs no supplier.
//
// THE DEFECT THIS COVERS. Staff: 它必须设置供应商才能添加发票。仅仅购买一次的
// 物品不需要设置供应商信息。 Lines nobody attributed sit in the "未指定
// Unspecified" group on Purchasing → Invoices, and POST/PUT
// /api/retail-admin/purchasing/invoices refused any invoice without a supplier
// (400 supplier_required). So a 发票 for something bought once — a market
// stall, a shop passed on the way — could only be recorded after inventing a
// supplier for it, which put a name on the book that would never be used again.
//
// Now an empty supplier is filed under the Unspecified literal, the same one the
// grouping falls back to. The screen's side (the button on the Unspecified row,
// the optional field) is covered in test_invoice_supplier_search.js §16–21.
//
// BEHAVIOURAL: the SHIPPED router over a real in-memory SQLite carrying the
// REAL table definitions from schema.sql + database.js, collaborators stubbed —
// the same harness as test_purchasing_line_supplier.js.
//
// USAGE   node scripts/test_invoice_no_supplier.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const ROUTE_PATH = path.join(ROOT, 'routes', 'retail-purchasing.js');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const UNSPEC = '未指定 Unspecified';

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}${got === undefined ? '' : ' — got ' + JSON.stringify(got)}`); }
};

let openMemoryDb, addTables, driver;
try {
  ({ openMemoryDb, addTables, driver } = require('./test-support/memory-db'));
} catch (e) {
  console.error('[test_invoice_no_supplier] no usable SQLite driver:', e.message);
  process.exit(2);
}

// The shipped handler calls db.transaction(); node:sqlite lacks it.
function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (err) { try { db.exec('ROLLBACK'); } catch { /* rollback of a failed BEGIN */ } throw err; }
  };
  return db;
}

// The order tables are defined in schema.sql; the invoice tables only in
// database.js.
const handle = ensureTransactionMethod(addTables(
  addTables(openMemoryDb(), SCHEMA_SRC, DB_SRC, ['purchase_orders', 'po_line_items', 'suppliers']),
  DB_SRC, DB_SRC, ['invoices', 'invoice_lines']));

// PO 100 is a one-off buy: no supplier anywhere in the chain.
handle.exec(`
INSERT INTO purchase_orders (id, po_number, date, status, supplier, tenant_id)
  VALUES (100, 'RPO-0059', '2026-09-26', 'Ordered', NULL, 1);
INSERT INTO po_line_items (id, po_id, name_en, qty, cost_per_unit, supplier_name)
  VALUES (1, 100, 'samples', 1, 8.6, NULL),
         (2, 100, 'cup cakes baking paper', 1, 19.02, NULL);
`);

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: ROUTE_PATH, filename: ROUTE_PATH, paths: Module._nodeModulePaths(path.dirname(ROUTE_PATH)),
  });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
stub('../database', handle);
stub('../lib/tenant-db', { tdb: () => handle, currentTenantId: () => 1 });
stub('../lib/inventory', { getStore: () => ({ id: 1 }), adjustStock: () => {} });
stub('../lib/category-text', { storeCategory: (c) => c });
stub('../middleware/auth', { logActivity: () => {} });
stub('./retail', {
  requireRetailAdmin: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
});
stub('./purchases', { firePriceAlertsForPO: () => {}, allocateLandedExtras: () => {},
                      postPOExpenses: () => ({ skipped: 'stubbed' }) });
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false });

let express, router;
try {
  express = require('express');
  router = require(ROUTE_PATH);
} catch (e) {
  console.error('[test_invoice_no_supplier] could not load the router:', e.message);
  process.exit(2);
}

const invoiceRow = (id) => handle.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

(async () => {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/retail-admin/purchasing/invoices`;
  const send = async (method, url, body) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  console.log(`\n── BEHAVIOURAL: invoices with no supplier (${driver}) ──`);

  let r = await send('POST', base, {
    supplier: '', amount: 8.6, date: '2026-09-27', notes: 'market stall',
    links: [{ line_id: 1, allocated_amount: 8.6 }],
  });
  ok('an invoice with an EMPTY supplier is accepted', r.status === 200 && r.json.id > 0, r);
  const id = r.json.id;
  ok('it is filed under the Unspecified literal the grouping uses', invoiceRow(id) && invoiceRow(id).supplier === UNSPEC,
     invoiceRow(id) && invoiceRow(id).supplier);
  ok('and it covers the one-off line',
     (handle.prepare('SELECT allocated_amount FROM invoice_lines WHERE invoice_id = ? AND line_id = 1').get(id) || {}).allocated_amount === 8.6);

  r = await send('POST', base, { amount: 19.02, date: '2026-09-27', links: [{ line_id: 2, allocated_amount: 19.02 }] });
  ok('a MISSING supplier is treated the same as an empty one',
     r.status === 200 && invoiceRow(r.json.id).supplier === UNSPEC, r);

  r = await send('POST', base, { supplier: '   ', amount: 5, date: '2026-09-27', links: [] });
  ok('whitespace alone counts as empty', r.status === 200 && invoiceRow(r.json.id).supplier === UNSPEC, r);

  r = await send('POST', base, { supplier: 'Dry Fruit 果干', amount: 5, date: '2026-09-27', links: [] });
  ok('a named supplier is still stored as given', r.status === 200 && invoiceRow(r.json.id).supplier === 'Dry Fruit 果干', r);

  r = await send('PUT', `${base}/${id}`, { supplier: '', amount: 8.6, date: '2026-09-27', links: [{ line_id: 1, allocated_amount: 8.6 }] });
  ok('an edit with an empty supplier is accepted', r.status === 200, r);
  ok('and stays under Unspecified', invoiceRow(id).supplier === UNSPEC, invoiceRow(id).supplier);

  // What still has to be there.
  r = await send('POST', base, { supplier: '', amount: 0, date: '2026-09-27', links: [] });
  ok('the amount is still required', r.status === 400 && r.json.error === 'amount_required', r);
  r = await send('POST', base, { supplier: '', amount: 5, links: [] });
  ok('the date is still required', r.status === 400 && r.json.error === 'date_required', r);

  server.close();
  console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
