#!/usr/bin/env node
//
// test_purchasing_line_supplier.js — red-proof for the way OUT of the
// "未指定 Unspecified" bucket on Purchasing → Invoices.
//
// THE DEFECT THIS COVERS. The Invoices screen groups purchase lines by the
// supplier chain (line → PO header → ingredient master → a literal fallback).
// Anything that falls all the way through lands in the Unspecified group, and
// the group's action cell said "Set a supplier on these lines first" — an
// instruction with nowhere to follow it: the order wizard only reopens DRAFTS,
// and most of those lines sit on placed, kitchen-scope orders the retail admin
// never opens. There was no route to write a line's supplier either.
//
// TWO KINDS OF ASSERTION, LABELLED, per the house rule in
// test_ledger_invariants.js — a suite that lets both read as proof is a suite
// that looks like evidence and is not:
//
//   BEHAVIOURAL  the SHIPPED handler, over a real (in-memory) SQLite carrying
//                the REAL table definitions from schema.sql + database.js.
//                routes/retail-purchasing.js is required with its collaborators
//                stubbed and mounted on a real express app, so what answers
//                these requests is the router that ships.
//   SOURCE       string checks over public/retail-admin/16-purchasing.js and
//                routes/retail-purchasing.js. They prove what is WRITTEN — that
//                the dead-end hint is gone, that the three entry points exist,
//                and that the write stays at line level — not what any of it
//                renders at runtime.
//
// EVERY SOURCE ANCHOR IS MUTATION-TESTED. A source check that cannot go red is
// a PASS line with nothing behind it.
//
// USAGE   node scripts/test_purchasing_line_supplier.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const ROUTE_PATH = path.join(ROOT, 'routes', 'retail-purchasing.js');
const UI_PATH = path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js');
const ROUTE_SRC = fs.readFileSync(ROUTE_PATH, 'utf8');
const UI_SRC = fs.readFileSync(UI_PATH, 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let fails = 0;
const ok = (kind, name, cond, got) => {
  if (cond) console.log(`  PASS  [${kind}] ${name}`);
  else { fails++; console.log(`  FAIL  [${kind}] ${name}${got === undefined ? '' : ' — got ' + JSON.stringify(got)}`); }
};

// ── SOURCE checks, each paired with the mutation that must break it ────────
// { file, src, name, anchor, present } — `present: false` asserts an ABSENCE,
// and its mutation ADDS the string back.
const SOURCE_CHECKS = [
  {
    file: 'routes/retail-purchasing.js', src: () => ROUTE_SRC,
    name: 'the route writes the LINE, never the PO header — the header sits ahead of the item master in the chain, so stamping it would move lines nobody picked',
    anchor: '  const upd = db.prepare(`UPDATE po_line_items SET supplier_name = ?',
    present: true,
  },
  {
    file: 'routes/retail-purchasing.js', src: () => ROUTE_SRC,
    name: 'the route never touches purchase_orders.supplier',
    anchor: 'UPDATE purchase_orders SET supplier = ?, updated_at',
    present: false,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'the dead-end hint is gone from the Unspecified group row',
    anchor: "Set a supplier on these lines first",
    present: false,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'the group row offers the button instead',
    anchor: 'onclick="puInvAssign()"',
    present: true,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'each order inside the bucket can be set in one go',
    anchor: 'onclick="puInvAssign([${po.lines.map(l => l.line_id).join(\',\')}])"',
    present: true,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'a single line can be set on its own',
    anchor: 'onclick="puInvAssign([${l.line_id}])"',
    present: true,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'the modal saves through the line-level route, never the PO header',
    anchor: "await api('/api/retail-admin/purchasing/lines/supplier', { method: 'PUT', body: { supplier: d.supplier, line_ids: ids } });",
    present: true,
  },
  {
    file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'the affordances are gated on the invoice capability',
    anchor: '<button class="pu2-btn sm" data-cap="purchasing:invoices" title="${esc(T(\'Nothing on these lines said who they came from',
    present: true,
  },
];

console.log('\n── SOURCE ──');
for (const c of SOURCE_CHECKS) {
  // NO ANCHOR MAY CARRY A LINE ENDING: an anchor spanning two lines with a bare
  // \n matches nothing on a CRLF checkout, and the failure is silent — the check
  // passes as a vacuous absence, or fails for a reason that reads like a defect.
  ok('SOURCE', `anchor carries no line ending (${c.name})`, !/[\r\n]/.test(c.anchor), c.anchor);
}
for (const c of SOURCE_CHECKS) {
  ok('SOURCE', `${c.file}: ${c.name}`, c.src().includes(c.anchor) === c.present, c.anchor);
}

console.log('\n── SOURCE, mutation red-proof ──');
for (const c of SOURCE_CHECKS) {
  const src = c.src();
  const mutated = c.present
    ? src.split(c.anchor).join('__REMOVED__')
    : src + '\n// ' + c.anchor + '\n';
  ok('SOURCE', `mutation changes the file (${c.name})`, mutated !== src);
  ok('SOURCE', `check goes red on the mutation (${c.name})`, mutated.includes(c.anchor) !== c.present);
}

// ── driver ────────────────────────────────────────────────────────────────
let openMemoryDb, addTables, driver;
try {
  ({ openMemoryDb, addTables, driver } = require('./test-support/memory-db'));
} catch (e) {
  console.error('[test_purchasing_line_supplier] no usable SQLite driver:', e.message);
  process.exit(2);
}

// The shipped handler calls db.transaction(). better-sqlite3 has it; node:sqlite
// does not, so supply the same surface there rather than editing the code under
// test to suit the driver.
function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (err) { try { db.exec('ROLLBACK'); } catch { /* rollback of a failed BEGIN */ } throw err; }
  };
  return db;
}

const handle = ensureTransactionMethod(
  addTables(openMemoryDb(), SCHEMA_SRC, DB_SRC, ['purchase_orders', 'po_line_items', 'suppliers']));

// Two tenants, so the scoping predicate has something to exclude. Tenant 1 owns
// PO 100 (two blank lines + one already attributed) and PO 101; tenant 2 owns
// PO 200, which tenant 1 must never be able to write.
handle.exec(`
INSERT INTO suppliers (id, name, tenant_id) VALUES (1, 'Dry Fruit 果干', 1), (2, 'Other Tenant Co', 2);
INSERT INTO purchase_orders (id, po_number, date, status, supplier, tenant_id)
  VALUES (100, 'PO-0100', '2026-08-24', 'Ordered', NULL, 1),
         (101, 'PO-0101', '2026-08-25', 'Ordered', 'Header Only Co', 1),
         (200, 'PO-0200', '2026-08-26', 'Ordered', NULL, 2);
INSERT INTO po_line_items (id, po_id, name_en, qty, cost_per_unit, supplier_name)
  VALUES (1, 100, 'Apple Banana', 1, 19,  NULL),
         (2, 100, 'Sesame Banana', 1, 25, NULL),
         (3, 100, 'Already Set',   1, 10, 'Dry Fruit 果干'),
         (4, 101, 'Header Line',   1, 12, NULL),
         (5, 200, 'Other Tenant',  1, 99, NULL);
`);

// ── the shipped router, with its collaborators stubbed ────────────────────
let TENANT = 1;
const logged = [];
const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: ROUTE_PATH, filename: ROUTE_PATH, paths: Module._nodeModulePaths(path.dirname(ROUTE_PATH)),
  });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
stub('../database', handle);
stub('../lib/tenant-db', { tdb: () => handle, currentTenantId: () => TENANT });
stub('../lib/inventory', { getStore: () => ({ id: 1 }), adjustStock: () => {} });
stub('../lib/category-text', { storeCategory: (c) => c });
stub('../middleware/auth', { logActivity: (...a) => logged.push(a) });
stub('./retail', {
  requireRetailAdmin: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
});
stub('./purchases', { firePriceAlertsForPO: () => {}, allocateLandedExtras: () => {} });
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false });

let express, router;
try {
  express = require('express');
  router = require(ROUTE_PATH);
} catch (e) {
  console.error('[test_purchasing_line_supplier] could not load the router:', e.message);
  process.exit(2);
}

const supplierOf = (lineId) =>
  handle.prepare('SELECT supplier_name FROM po_line_items WHERE id = ?').get(lineId).supplier_name;

(async () => {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/retail-admin/purchasing/lines/supplier`;
  const put = async (body) => {
    const r = await fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  console.log(`\n── BEHAVIOURAL: PUT …/purchasing/lines/supplier (${driver}) ──`);

  let r = await put({ supplier: 'Dry Fruit 果干', line_ids: [1, 2] });
  ok('BEHAVIOURAL', 'the picked lines get the name', r.status === 200 && r.json.updated === 2, r);
  ok('BEHAVIOURAL', 'line 1 moved', supplierOf(1) === 'Dry Fruit 果干', supplierOf(1));
  ok('BEHAVIOURAL', 'line 2 moved', supplierOf(2) === 'Dry Fruit 果干', supplierOf(2));

  // The reason the write is per line and not on the PO header: everything else
  // on that order has to stay exactly where it was.
  ok('BEHAVIOURAL', 'the PO HEADER is left blank — no other line on the order moves',
    handle.prepare('SELECT supplier FROM purchase_orders WHERE id = 100').get().supplier === null);
  ok('BEHAVIOURAL', 'an unpicked line on the same order is untouched', supplierOf(4) === null, supplierOf(4));
  ok('BEHAVIOURAL', 'one activity row for the assignment, carrying the ids',
    logged.length === 1 && logged[0][2] === 'set_line_supplier' && logged[0][5].updated === 2, logged.length);

  r = await put({ supplier: 'Header Only Co', line_ids: [4] });
  ok('BEHAVIOURAL', 'a name carried only by a PO header (never on the master) is accepted',
    r.status === 200 && supplierOf(4) === 'Header Only Co', r);

  r = await put({ supplier: 'Nobody We Buy From', line_ids: [1] });
  ok('BEHAVIOURAL', 'an unknown name is refused, so a typo cannot open a near-identical group',
    r.status === 400 && r.json.error === 'unknown_supplier', r);
  ok('BEHAVIOURAL', 'and the line it would have hit is unchanged', supplierOf(1) === 'Dry Fruit 果干', supplierOf(1));

  r = await put({ supplier: '   ', line_ids: [1] });
  ok('BEHAVIOURAL', 'a blank supplier is refused', r.status === 400 && r.json.error === 'supplier_required', r);

  r = await put({ supplier: 'Dry Fruit 果干', line_ids: [] });
  ok('BEHAVIOURAL', 'no lines is refused', r.status === 400 && r.json.error === 'lines_required', r);

  r = await put({ supplier: 'Dry Fruit 果干', line_ids: Array.from({ length: 401 }, (_, i) => i + 1) });
  ok('BEHAVIOURAL', 'an unbounded id list is refused', r.status === 400 && r.json.error === 'too_many_lines', r);

  // TENANT SCOPING — line 5 belongs to tenant 2. Tenant 1 asking for it must
  // change nothing and be told nothing was found.
  r = await put({ supplier: 'Dry Fruit 果干', line_ids: [5] });
  ok('BEHAVIOURAL', 'another tenant’s line is not writable', r.status === 404 && r.json.error === 'not_found', r);
  ok('BEHAVIOURAL', 'and it is still blank', supplierOf(5) === null, supplierOf(5));

  // A mixed list is not an all-or-nothing failure: the caller's own lines land,
  // the other tenant's do not.
  handle.exec("UPDATE po_line_items SET supplier_name = NULL WHERE id = 2");
  r = await put({ supplier: 'Dry Fruit 果干', line_ids: [2, 5] });
  ok('BEHAVIOURAL', 'a mixed list writes only this tenant’s line',
    r.status === 200 && r.json.updated === 1 && supplierOf(2) === 'Dry Fruit 果干' && supplierOf(5) === null, r);

  // The name is validated against the CALLER's tenant, never globally.
  r = await put({ supplier: 'Other Tenant Co', line_ids: [1] });
  ok('BEHAVIOURAL', 'a supplier belonging to another tenant is unknown here',
    r.status === 400 && r.json.error === 'unknown_supplier', r);

  server.close();

  console.log(fails ? `\n${fails} FAILED\n` : '\nAll assertions held.\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('[test_purchasing_line_supplier] crashed:', e);
  process.exit(2);
});
