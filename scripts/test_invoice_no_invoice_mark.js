#!/usr/bin/env node
// 不开发票 STAYS 不开发票 — and 恢复 stays restored.
//
// THE DEFECT THIS COVERS. Whether a purchase line will ever have a 发票 was
// stored in two columns that no writer kept in step:
//
//   po_line_items.no_invoice_expected  the mark — THE ONLY ONE ANY SCREEN
//                                      READS (routes/retail-purchasing.js
//                                      lineStatus, routes/finance.js)
//   po_line_items.invoice_status       the buyer's note on the receive row,
//                                      whose 'no_invoice' value says the same
//                                      thing a second time
//
// The Invoices tab's 不开发票 / 恢复 buttons wrote the mark alone. The kitchen
// report's picker wrote the status alone. Editing an order's lines re-defaulted
// the status to 'not_received' whether or not the payload mentioned invoicing.
// Nothing looked wrong until a THIRD writer re-derived one column from the
// other — database.js re-ran its reconciliation on EVERY BOOT, and Confirm
// delivery derives the mark from whatever status the receive row sends. So the
// buyer's decision was silently reversed some time later, which is exactly what
// was reported from the floor, in both directions:
//
//   • press 不开发票, come back later, the line reads 等待开票 again
//   • press 恢复 on a line that does need chasing, come back later, it reads
//     不开发票 — and a real 发票 stops being chased at all
//
// THE RULE NOW. One fact, written through one place (lib/invoice-mark.js):
// marking sets both columns, unmarking clears a note that says no_invoice and
// leaves 'received' alone, a save that says nothing about invoicing writes
// neither column, and the boot-time reconciliation runs ONCE behind a
// _migrations marker instead of re-deriving on every start.
//
// USAGE   node scripts/test_invoice_no_invoice_mark.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no SQLite driver

'use strict';

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT        = path.join(__dirname, '..');
const RETAIL_PATH = path.join(ROOT, 'routes', 'retail-purchasing.js');
const KITCHEN_REL = './purchases';
const UI_PATH     = path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js');
const DB_PATH     = path.join(ROOT, 'database.js');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

let openMemoryDb, addTables, driver;
let addForkedStoreProducts;
try { ({ openMemoryDb, addTables, addForkedStoreProducts, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_invoice_no_invoice_mark] no usable SQLite driver:', e.message); process.exit(2); }

const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DB_SRC     = fs.readFileSync(DB_PATH, 'utf8');
const UI_SRC     = fs.readFileSync(UI_PATH, 'utf8');

function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (err) { try { db.exec('ROLLBACK'); } catch { /* rollback of a failed BEGIN */ } throw err; }
  };
  return db;
}

const handle = ensureTransactionMethod(addTables(
  addTables(openMemoryDb(), SCHEMA_SRC, DB_SRC,
    ['purchase_orders', 'po_line_items', 'suppliers', 'ingredients', 'expense_entries',
     'ingredient_price_history', 'activity_log']),
  DB_SRC, DB_SRC, ['invoices', 'invoice_lines', 'po_receipts', 'po_receipt_lines']));
// The receive route books stock through store_products, which is forked from
// products rather than declared — same builder the other suites use.
addForkedStoreProducts(handle, SCHEMA_SRC, DB_SRC);

// Two orders, one supplier. RPO-0100 line 1 is the line the buyer keeps
// marking; line 2 already has its 发票 in hand and must survive every toggle.
handle.exec(`
INSERT INTO suppliers (id, name, tenant_id, is_active) VALUES (1, 'Shaanxi Huiyang 汇阳', 1, 1);
INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, store_id, tenant_id)
  VALUES (100, 'RPO-0100', '2026-08-24', 'Ordered', 'Shaanxi Huiyang 汇阳', 'retail', 1, 1),
         (200, 'PO-0200',  '2026-08-24', 'Ordered', 'Shaanxi Huiyang 汇阳', 'kitchen', NULL, 1);
INSERT INTO po_line_items (id, po_id, name_en, qty, unit, cost_per_unit, total_cost, supplier_name,
                           invoice_status, no_invoice_expected, sort_order)
  VALUES (1, 100, 'Organic Goji Berries 有机枸杞', 1, 'bag', 408, 408, 'Shaanxi Huiyang 汇阳', 'not_received', 0, 0),
         (2, 100, 'Organic Hibiscus 玫瑰茄',       1, 'bag',  51,  51, 'Shaanxi Huiyang 汇阳', 'received',     0, 1),
         (3, 200, 'Organic Onion Powder 有机洋葱粉', 1, 'bag', 38.4, 38.4, 'Shaanxi Huiyang 汇阳', 'not_received', 0, 0);
`);

const lineOf = id => handle.prepare(
  'SELECT invoice_status, no_invoice_expected AS mark FROM po_line_items WHERE id = ?').get(id);

// What database.js does at boot — the reconciliation, verbatim from source, run
// on demand. §5 proves it is now behind a marker; every other section runs it
// to stand in for the restart that used to undo the buyer's press.
const rebootReconcile = () => {
  const marked = handle.prepare(`UPDATE po_line_items SET invoice_status = 'no_invoice'
                                  WHERE COALESCE(no_invoice_expected, 0) = 1
                                    AND COALESCE(invoice_status, '') <> 'no_invoice'`).run();
  const freed  = handle.prepare(`UPDATE po_line_items SET invoice_status = 'not_received'
                                  WHERE COALESCE(no_invoice_expected, 0) = 0
                                    AND invoice_status = 'no_invoice'`).run();
  return (marked.changes || 0) + (freed.changes || 0);
};
// The rule the OLD boot exec applied, kept here as the thing that must no
// longer have anything to bite on: mark ← status, every start.
const legacyReboot = () => handle.prepare(`UPDATE po_line_items SET no_invoice_expected = 1
                                            WHERE invoice_status = 'no_invoice'
                                              AND COALESCE(no_invoice_expected, 0) = 0`).run().changes;

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: RETAIL_PATH, filename: RETAIL_PATH, paths: Module._nodeModulePaths(path.dirname(RETAIL_PATH)),
  });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
stub('../database', handle);
stub('../lib/tenant-db', { tdb: () => handle, currentTenantId: () => 1 });
stub('../lib/inventory', { getStore: () => ({ id: 1 }), adjustStock: () => {} });
stub('../lib/category-text', { storeCategory: (_db, c) => c || null });
stub('../middleware/auth', {
  logActivity: () => {},
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
  requirePermission: () => (_req, _res, next) => next(),
  requireDelete: (_req, _res, next) => next(),
});
stub('./retail', { requireRetailAdmin: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); } });
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false, fireRecompute: () => {} });
stub('../middleware/block-kitchen-cost-writes', {
  blockCostWrite: () => (_req, _res, next) => next(), blockCostWriteIf: () => (_req, _res, next) => next(),
});

let express, retailRouter, kitchenRouter;
try {
  express = require('express');
  kitchenRouter = require(Module._resolveFilename(KITCHEN_REL, {
    id: RETAIL_PATH, filename: RETAIL_PATH, paths: Module._nodeModulePaths(path.dirname(RETAIL_PATH)) }));
  retailRouter = require(RETAIL_PATH);
} catch (e) {
  console.error('[test_invoice_no_invoice_mark] could not load the routers:', e.message);
  process.exit(2);
}

const { setNoInvoiceMark, setLineInvoiceStatus } = require('../lib/invoice-mark');

(async () => {
  console.log(`\n1. the invariant itself (${driver}) — lib/invoice-mark.js`);
  setNoInvoiceMark(handle, 1, true);
  ok(lineOf(1).mark === 1 && lineOf(1).invoice_status === 'no_invoice',
     'marking a line writes BOTH columns, never the mark alone', lineOf(1));
  setNoInvoiceMark(handle, 1, false);
  ok(lineOf(1).mark === 0 && lineOf(1).invoice_status === 'not_received',
     '恢复 clears both, so no stale note is left to overturn it', lineOf(1));
  setNoInvoiceMark(handle, 2, false);
  ok(lineOf(2).invoice_status === 'received' && lineOf(2).mark === 0,
     '恢复 on a line whose 发票 is already in hand leaves that note alone — the toggle '
     + 'clears a note that says no_invoice, it does not blank the buyer\'s other answer', lineOf(2));
  setLineInvoiceStatus(handle, 1, 'no_invoice');
  ok(lineOf(1).mark === 1, 'the picker raises the mark, which is the column every screen reads', lineOf(1));
  setLineInvoiceStatus(handle, 1, 'not_received');
  ok(lineOf(1).mark === 0, 'and lowers it again', lineOf(1));

  const app = express();
  // server.js parses JSON app-wide; both routers are written against that.
  app.use(express.json());
  app.use(retailRouter);
  app.use(kitchenRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  console.log('\n2. the Invoices tab — the buyer presses 不开发票, and it holds');
  const mark = await send('PUT', '/api/retail-admin/purchasing/po/100/line/1/no-invoice',
                          { no_invoice_expected: true });
  ok(mark.status === 200, 'the toggle answers', mark.status);
  ok(lineOf(1).mark === 1 && lineOf(1).invoice_status === 'no_invoice',
     'both columns now say 不开发票', lineOf(1));
  ok(legacyReboot() === 0 && rebootReconcile() === 0,
     'a restart finds nothing to re-derive — THE REVERSAL THAT WAS REPORTED', lineOf(1));
  ok(lineOf(1).mark === 1, 'so after the restart the line still reads 不开发票', lineOf(1));

  console.log('\n3. …and 恢复 holds too — the line that DOES need chasing');
  const restore = await send('PUT', '/api/retail-admin/purchasing/po/100/line/1/no-invoice',
                             { no_invoice_expected: false });
  ok(restore.status === 200, 'the toggle answers', restore.status);
  ok(lineOf(1).mark === 0 && lineOf(1).invoice_status === 'not_received',
     'the note is cleared with the mark, not left reading no_invoice', lineOf(1));
  ok(legacyReboot() === 0, 'so the old boot rule has nothing to put back', lineOf(1));
  ok(lineOf(1).mark === 0, 'and the line is still awaiting its 发票 after a restart', lineOf(1));

  console.log('\n4. the kitchen report writes the same fact, not half of it');
  const kStatus = await send('PUT', '/api/purchases/200/line/3/invoice', { invoice_status: 'no_invoice' });
  ok(kStatus.status === 200, 'the kitchen picker answers', kStatus.status);
  ok(lineOf(3).mark === 1,
     'setting 不开发票 there raises the mark, so the Invoices tab stops chasing it', lineOf(3));
  const kRestore = await send('PUT', '/api/purchases/200/line/3/no-invoice', { no_invoice_expected: false });
  ok(kRestore.status === 200, 'the kitchen 恢复 answers', kRestore.status);
  ok(lineOf(3).mark === 0 && lineOf(3).invoice_status === 'not_received',
     'and clearing the mark there clears the note with it', lineOf(3));
  ok(legacyReboot() === 0 && rebootReconcile() === 0, 'nothing for a restart to reverse on either screen');
  const bad = await send('PUT', '/api/purchases/200/line/3/invoice', { invoice_status: 'whatever' });
  ok(bad.status === 400, 'an invalid status is still refused', bad.status);

  console.log('\n5. an order edit that says nothing about invoicing changes nothing');
  await send('PUT', '/api/retail-admin/purchasing/po/100/line/1/no-invoice', { no_invoice_expected: true });
  const edit = await send('PUT', '/api/retail-admin/purchases/100', {
    date: '2026-08-24', supplier: 'Shaanxi Huiyang 汇阳', store_id: 1,
    items: [{ id: 1, name_en: 'Organic Goji Berries 有机枸杞', qty: 1, unit: 'bag', cost_per_unit: 408 },
            { id: 2, name_en: 'Organic Hibiscus 玫瑰茄', qty: 1, unit: 'bag', cost_per_unit: 51 }],
  });
  ok(edit.status === 200, 'the retail order edit answers', edit.status);
  ok(lineOf(1).mark === 1 && lineOf(1).invoice_status === 'no_invoice',
     'a payload with no invoice_status hands the stored pair back untouched', lineOf(1));
  ok(lineOf(2).invoice_status === 'received', 'and does not re-default the other line either', lineOf(2));
  const kEdit = await send('PUT', '/api/purchases/200', {
    date: '2026-08-24', status: 'Ordered', supplier: 'Shaanxi Huiyang 汇阳',
    items: [{ id: 3, name_en: 'Organic Onion Powder 有机洋葱粉', qty: 1, unit: 'bag', cost_per_unit: 38.4 }],
  });
  ok(kEdit.status === 200, 'the kitchen order edit answers', kEdit.status);
  await send('PUT', '/api/purchases/200/line/3/no-invoice', { no_invoice_expected: true });
  await send('PUT', '/api/purchases/200', {
    date: '2026-08-24', status: 'Ordered', supplier: 'Shaanxi Huiyang 汇阳',
    items: [{ id: 3, name_en: 'Organic Onion Powder 有机洋葱粉', qty: 1, unit: 'bag', cost_per_unit: 38.4 }],
  });
  ok(lineOf(3).mark === 1 && lineOf(3).invoice_status === 'no_invoice',
     'the kitchen edit preserves the pair the same way', lineOf(3));

  console.log('\n6. Confirm delivery on a tab left open cannot undo a mark set elsewhere');
  const stale = await send('PUT', '/api/retail-admin/purchases/100/receive', {
    receipts: [{ line_id: 1, qty_received: 1, damaged_qty: 0, tracking_number: '' }],
  });
  ok(stale.status === 200, 'the receive route answers', stale.status);
  ok(lineOf(1).mark === 1 && lineOf(1).invoice_status === 'no_invoice',
     'a receipt that names no invoice_status writes NEITHER column', lineOf(1));
  ok(UI_SRC.includes("ri.value !== (ri.dataset ? ri.dataset.saved : undefined)"),
     'and the screen omits the field when its picker still shows what it was rendered with');
  const explicit = await send('PUT', '/api/retail-admin/purchases/100/receive', {
    receipts: [{ line_id: 1, qty_received: 1, invoice_status: 'not_received' }],
  });
  ok(explicit.status === 200 && lineOf(1).mark === 0,
     'while a receipt that DOES name one still moves both columns', lineOf(1));

  console.log('\n7. the boot-time reconciliation runs once, not on every start');
  ok(!/^db\.exec\(`UPDATE po_line_items SET no_invoice_expected = 1/m.test(DB_SRC),
     'the unguarded every-boot re-derive is gone from database.js');
  ok(DB_SRC.includes("po_invoice_mark_sync_v1") && DB_SRC.includes("INSERT INTO _migrations (name) VALUES (?)"),
     'and what replaced it is a one-shot behind a _migrations marker');
  // What that one-shot repairs: the contradictions the old writers left behind.
  handle.exec(`INSERT INTO po_line_items (id, po_id, name_en, qty, cost_per_unit, total_cost,
                                          invoice_status, no_invoice_expected)
               VALUES (90, 100, 'legacy tab press',   1, 1, 1, 'not_received', 1),
                      (91, 100, 'legacy 恢复 press',  1, 1, 1, 'no_invoice',   0),
                      (92, 100, 'legacy paid + mark', 1, 1, 1, 'received',     1)`);
  const repaired = rebootReconcile();
  ok(repaired === 3, 'it squares every row the two half-writers left contradicting', repaired);
  ok(lineOf(90).invoice_status === 'no_invoice' && lineOf(90).mark === 1,
     'a tab press that only marked keeps its mark and gains the note', lineOf(90));
  ok(lineOf(91).invoice_status === 'not_received' && lineOf(91).mark === 0,
     'a 恢复 that only cleared the mark keeps the line in the chase list — never silently out of it',
     lineOf(91));
  ok(lineOf(92).invoice_status === 'no_invoice' && lineOf(92).mark === 1,
     'and the mark decides, because it is what every screen was already showing', lineOf(92));
  ok(rebootReconcile() === 0, 'a second run changes nothing — idempotent');

  server.close();
  console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
  process.exit(fail ? 1 : 0);
})();
