#!/usr/bin/env node
// Purchasing → Invoices carries NO ACCOUNTS PAYABLE. This asserts the removal
// holds, on both sides — public/retail-admin/16-purchasing.js and
// routes/retail-purchasing.js.
//
// THE DEFECT THIS COVERS. The screen inherited a due-date / "Mark paid" /
// aging apparatus from the earlier Bills port, and it does not describe how
// Roots buys: the money goes out first and the 发票 turns up afterwards. So
// every invoice that could be recorded on this screen had already been paid
// for, which made "Mark paid" a button asking the operator to assert something
// always true — and made the aging strip built from its absence actively
// wrong. On live data it announced ¥5,246.48 "Not due": a debt to suppliers on
// money that had already left the account. A screen may not report a figure
// that is false about the business it runs.
//
// WHAT REPLACED IT ON THE SUPPLIER PAGE. That page's "Owed now" tile summed
// unpaid invoices — the same non-figure. It now reports what the supplier
// still owes us on PAPER, and §3 pins the reason it is computed beside the
// tab's own rules rather than near the tile: one supplier, one number, on both
// screens. Compute it any other way (scope-filtered, ordered rather than
// billable qty, superseded copies left standing) and the two disagree.
//
// WHAT DID NOT GO. invoices.due_date and invoices.paid_at keep every value
// they hold — this is a UI removal, not a migration — and an edit still hands
// back the due date it loaded rather than clearing a field nobody can see.
//
// USAGE   node scripts/test_invoice_no_payables.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no SQLite driver

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');

const ROOT       = path.join(__dirname, '..');
const ROUTE_PATH = path.join(ROOT, 'routes', 'retail-purchasing.js');
const UI_PATH    = path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

// ── DOM stub ──────────────────────────────────────────────────────────────
// Same stub test_invoice_supplier_search.js uses: getElementById hands back a
// node for any id, because the module paints a shell and then looks the ids
// inside it back up.
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, hidden: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    setSelectionRange() {},
    getBoundingClientRect: () => ({ left: 40, top: 300, right: 340, bottom: 330, width: 300, height: 30 }),
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    appendChild(child) { if (child && child.id) nodes.set(child.id, child); this.children.push(child); return child; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}
const node = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
const document = {
  getElementById: id => node(id),
  createElement: () => makeNode(''),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  body: makeNode('body'),
};

// ── the server, faked ─────────────────────────────────────────────────────
// Two recorded invoices, both carrying a stored due_date — one of them long
// past, which is exactly the row the old strip would have called overdue.
const LEDGER = [
  { id: 41, supplier: 'Nut House 坚果屋', invoice_number: 'F-1', date: '2026-08-26', due_date: '2026-09-30',
    amount: 60.44, allocated: 60.44, unallocated: 0, pos: [{ po_number: 'PO-0054' }], lines: [] },
  { id: 42, supplier: 'Dry Fruit 果干', invoice_number: 'F-2', date: '2026-08-25', due_date: '2026-07-01',
    amount: 15.64, allocated: 0, unallocated: 15.64, pos: [{ po_number: 'PO-0059' }], lines: [] },
];
const OUTSTANDING = {
  month: null,
  groups: [{
    supplier: 'Dry Fruit 果干', supplier_cn: '果干', total: 44, fully_invoiced: 0, partially_invoiced: 0,
    awaiting: 44, no_invoice_expected: 0, credit_due: 0, line_count: 1, po_numbers: ['RPO-0001'], reach: null,
    lines: [{ line_id: 11, po_id: 5, po_number: 'RPO-0001', date: '2026-08-27', name_en: 'Apple Banana',
              qty: 1, cost_per_unit: 44, amount: 44, covered: 0, outstanding: 44, credit_due: 0,
              status: 'awaiting', line_no_invoice: false, po_no_invoice: false }],
  }],
  totals: { total: 44, fully_invoiced: 0, partially_invoiced: 0, awaiting: 44,
            no_invoice_expected: 0, credit_due: 0, line_count: 1 },
};
async function fakeApi(p, opts) {
  const q = p.split('?')[0];
  if (q === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, code: 'TH', name_en: 'Tianhe', is_active: 1 }] };
  if (q === '/api/retail-admin/purchasing/invoices/outstanding') return { success: true, data: OUTSTANDING };
  if (q === '/api/retail-admin/purchasing/invoices/41') return { success: true, data: { ...LEDGER[0], allocated: 60.44 } };
  if (q === '/api/retail-admin/purchasing/invoices') {
    if (opts && opts.method) return { success: true, id: 7 };
    return { success: true, data: LEDGER };
  }
  if (q.startsWith('/api/retail-admin/suppliers')) return { success: true, data: [] };
  return { success: true, data: [] };
}

const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  isFinite, String, URLSearchParams,
  api: fakeApi, toast: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  innerHeight: 900, innerWidth: 1200,
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en, fmt: n => String(n), acMoney: n => '¥' + n, acCurrencySymbol: () => '¥',
  applyCapGates: () => {}, askConfirm: async () => true,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(UI_PATH, 'utf8'), sandbox, { filename: '16-purchasing.js' });

// ── the router, with its collaborators stubbed ────────────────────────────
let openMemoryDb, addTables, driver;
try { ({ openMemoryDb, addTables, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_invoice_no_payables] no usable SQLite driver:', e.message); process.exit(2); }

const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DB_SRC     = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (err) { try { db.exec('ROLLBACK'); } catch { /* rollback of a failed BEGIN */ } throw err; }
    };
  return db;
}
// invoices and invoice_lines are declared in database.js, not schema.sql, so
// they are built from that source instead.
const handle = ensureTransactionMethod(addTables(
  addTables(openMemoryDb(), SCHEMA_SRC, DB_SRC,
    ['purchase_orders', 'po_line_items', 'suppliers', 'supplier_documents', 'ingredients']),
  DB_SRC, DB_SRC, ['invoices', 'invoice_lines']));

// One supplier, one kitchen-scope order, one line in each of the three states
// the tile has to tell apart: ¥20 awaiting, ¥30 fully invoiced, ¥5 never
// getting a 发票. Only the ¥20 is the supplier's outstanding paperwork.
handle.exec(`
INSERT INTO suppliers (id, name, tenant_id, is_active) VALUES (1, 'Dry Fruit 果干', 1, 1);
INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, tenant_id)
  VALUES (100, 'PO-0100', '2026-08-24', 'Ordered', 'Dry Fruit 果干', 'kitchen', 1);
INSERT INTO po_line_items (id, po_id, name_en, qty, cost_per_unit, total_cost, supplier_name, no_invoice_expected)
  VALUES (1, 100, 'Apple',  2, 10, 20, 'Dry Fruit 果干', 0),
         (2, 100, 'Banana', 1, 30, 30, 'Dry Fruit 果干', 0),
         (3, 100, 'Cherry', 1,  5,  5, 'Dry Fruit 果干', 1);
INSERT INTO invoices (id, supplier, invoice_number, date, due_date, amount, paid_at, scope, tenant_id)
  VALUES (7, 'Dry Fruit 果干', 'F-7', '2026-08-25', '2026-07-01', 30, NULL, 'retail', 1);
INSERT INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (7, 2, 30);
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
stub('./retail', { requireRetailAdmin: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); } });
stub('./purchases', { firePriceAlertsForPO: () => {}, allocateLandedExtras: () => {}, postPOExpenses: () => ({}) });
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false });

let express, router;
try { express = require('express'); router = require(ROUTE_PATH); }
catch (e) { console.error('[test_invoice_no_payables] could not load the router:', e.message); process.exit(2); }

(async () => {
  await sandbox.puInit();
  sandbox.puTab('invoices');
  // paintInvoices loads in the background; let its promises settle.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  console.log('\n1. the tab does not report a payables balance');
  const body = node('pu2-inv-body').innerHTML;
  ok(!body.includes('Not due'), 'no "Not due" figure — the ¥5,246.48 that was never owed');
  ok(!body.includes('Due soon'), 'no "Due soon" figure');
  ok(!body.includes('Overdue'), 'no "Overdue" figure');
  ok(body.includes('Awaiting'), 'AWAITING is still the headline — the chase survives the removal');
  ok(!fs.readFileSync(UI_PATH, 'utf8').includes('_invOut.aging'), 'and nothing reads an aging block off the response');

  console.log('\n2. the recorded ledger offers no payment affordance');
  sandbox.puInvView('recorded');
  const led = node('pu2-invledger').innerHTML;
  ok(led.includes('F-1') && led.includes('F-2'), 'both recorded invoices still render');
  ok(!led.includes('Mark paid') && !led.includes('puInvPaid'), 'no Mark paid button');
  ok(!/>Paid</.test(led), 'no Paid pill');
  ok(!led.includes('No due date') && !led.includes('2026-09-30'), 'no due-date pill, and a stored due date is not shown');
  ok(!led.includes('Overdue'), 'a due date two months past does not raise an overdue pill');
  ok(led.includes('puInvEdit') && led.includes('puInvDelete'), 'Edit and delete survive');
  ok(sandbox.puInvPaid === undefined, 'the puInvPaid handler is gone from the window');

  console.log('\n3. the form drops the field but never clears the value');
  await sandbox.puInvEdit(41);
  const modal = node('pu2-modal-host').innerHTML;
  ok(!modal.includes('Due date'), 'no due-date input on the form');
  ok(fs.readFileSync(UI_PATH, 'utf8').includes('date: d.date, due_date: d.due_date || null'),
     'but the save still carries the due date the edit loaded, so re-saving cannot wipe it');

  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  console.log(`\n4. the supplier tile reports PAPER, and agrees with the tab (${driver})`);
  const sup = await get('/api/retail-admin/suppliers/1');
  ok(sup.status === 200, 'the supplier detail route answers', sup.status);
  const sc = (sup.json.data || {}).scorecard || {};
  ok(!('owed' in sc) && !('owed_count' in sc), 'the unpaid-invoice balance is gone from the payload', sc);
  ok(sc.awaiting === 20, 'awaiting is the one uninvoiced line — not the ¥30 invoiced, not the ¥5 marked no-invoice', sc.awaiting);
  ok(sc.awaiting_lines === 1, 'and it counts that one line', sc.awaiting_lines);

  const out = await get('/api/retail-admin/purchasing/invoices/outstanding');
  ok(out.status === 200, 'the outstanding route answers', out.status);
  ok(!('aging' in (out.json.data || {})), 'and serves no aging block', Object.keys(out.json.data || {}));
  const g = (out.json.data.groups || []).find(x => x.supplier === 'Dry Fruit 果干') || {};
  // THE POINT OF §3 in the header: two screens, one supplier, one number.
  ok(g.awaiting === sc.awaiting, `the tab's group total equals the tile (${g.awaiting} = ${sc.awaiting})`);
  ok(g.fully_invoiced === 30 && g.no_invoice_expected === 5, 'the other two states are untouched by the change', g);

  console.log('\n5. the paid write is gone, and the stored values are not');
  const put = await fetch(base + '/api/retail-admin/purchasing/invoices/7/paid', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"paid":true}',
  });
  ok(put.status === 404, 'PUT …/invoices/:id/paid is no longer routed', put.status);
  const stored = handle.prepare('SELECT due_date, paid_at FROM invoices WHERE id = 7').get();
  ok(stored.due_date === '2026-07-01', 'the stored due date is untouched', stored.due_date);
  ok(stored.paid_at === null, 'and nothing wrote a paid stamp', stored.paid_at);
  const ledger = await get('/api/retail-admin/purchasing/invoices');
  const row = (ledger.json.data || [])[0] || {};
  ok(!('paid' in row) && !('overdue' in row), 'the ledger row carries no paid/overdue flag any more',
     Object.keys(row).filter(k => /paid|overdue/.test(k)));
  ok(row.due_date === '2026-07-01', 'but due_date still reaches the client, for the edit round-trip', row.due_date);

  server.close();
  console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
  process.exit(fail ? 1 : 0);
})();
