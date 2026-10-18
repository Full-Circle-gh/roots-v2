#!/usr/bin/env node
//
// test_supplier_account.js — a supplier who gives us credit has an account (§286).
//
// WHAT THIS HOLDS. A few suppliers deliver now and are paid later, and the shop
// tracked what it owed them on a spreadsheet. The account replaces the sheet:
//
//   owed = starting balance + goods DELIVERED after its date − payments + corrections
//
// and the rules §286 records around that figure:
//   * goods come from purchase orders, valued the invoice screen's way
//     (billable qty × unit cost; superseded originals stood down; the line's
//     own supplier first)
//   * an order still on the way is reported beside the figure, not in it
//   * orders dated on or before the starting balance are already in it
//   * a payment is NOT an expense — it writes nothing to expense_entries,
//     because the purchase is already expensed from its order
//   * a new starting balance replaces the old; a wrong entry is voided, kept
//   * only a supplier switched to credit takes entries
//
// BEHAVIOURAL: the SHIPPED router over a real in-memory SQLite carrying the
// REAL table definitions from schema.sql + database.js, collaborators stubbed —
// the same harness as test_invoice_no_supplier.js.
//
// USAGE   node scripts/test_supplier_account.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const ROUTE_PATH = path.join(ROOT, 'routes', 'retail-purchasing.js');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}${got === undefined ? '' : ' — got ' + JSON.stringify(got)}`); }
};

let openMemoryDb, addTables, driver;
try {
  ({ openMemoryDb, addTables, driver } = require('./test-support/memory-db'));
} catch (e) {
  console.error('[test_supplier_account] no usable SQLite driver:', e.message);
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

const handle = ensureTransactionMethod(addTables(
  addTables(openMemoryDb(), SCHEMA_SRC, DB_SRC,
    ['purchase_orders', 'po_line_items', 'suppliers', 'ingredients', 'expense_entries']),
  DB_SRC, DB_SRC, ['supplier_account_entries']));

// Tofu Co gives us credit. Pay First never does. One order of each kind:
//   RPO-1  2026-09-01  Delivered   10 × 30 = 300, 2 returned → 8 × 30 = 240
//   RPO-2  2026-09-10  Delivered   a MIXED order: one Tofu line (5 × 20 = 100)
//                                  and one Pay First line, which is not ours
//   RPO-3  2026-09-20  Ordered     50 on the way, not owed yet
//   RPO-4  2026-09-05  Requested   a draft — not placed, never counted
//   PO-9   2026-09-12  Delivered   a kitchen original stood down by its placed
//                                  retail copy RPO-5 — counted once, not twice
//   RPO-5  2026-09-12  Delivered   the copy: 3 × 10 = 30
//   RPO-6  2026-09-15  Cancelled   never counted
// A store in the shop's zone, as Roots' are: an entry typed without a date is
// dated by the shop's day, and a shop with no zone has none (§82).
// Only the columns the zone is read from (lib/business-date.js shopTimezone).
handle.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER, sort_order INTEGER, timezone TEXT);
             INSERT INTO retail_stores VALUES (1, 'tianhe', 1, 1, 'Asia/Shanghai');`);
handle.exec(`
INSERT INTO suppliers (id, name, name_cn, tenant_id) VALUES (1, 'Tofu Co', '豆腐坊', 1), (2, 'Pay First', NULL, 1);
INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, tenant_id, copied_from_po_id) VALUES
  (1, 'RPO-1', '2026-09-01', 'Delivered', 'Tofu Co',   'retail',  1, NULL),
  (2, 'RPO-2', '2026-09-10', 'Delivered', 'Pay First', 'retail',  1, NULL),
  (3, 'RPO-3', '2026-09-20', 'Ordered',   'Tofu Co',   'retail',  1, NULL),
  (4, 'RPO-4', '2026-09-05', 'Requested', 'Tofu Co',   'retail',  1, NULL),
  (9, 'PO-9',  '2026-09-12', 'Delivered', 'Tofu Co',   'kitchen', 1, NULL),
  (5, 'RPO-5', '2026-09-12', 'Delivered', 'Tofu Co',   'retail',  1, 9),
  (6, 'RPO-6', '2026-09-15', 'Cancelled', 'Tofu Co',   'retail',  1, NULL);
INSERT INTO po_line_items (id, po_id, name_en, qty, qty_received, returned_qty, cost_per_unit, supplier_name) VALUES
  (1, 1, 'firm tofu', 10, 10, 2, 30, NULL),
  (2, 2, 'silken tofu', 5, 5, 0, 20, 'Tofu Co'),
  (3, 2, 'boxes', 4, 4, 0, 50, NULL),
  (4, 3, 'firm tofu', 5, NULL, 0, 10, NULL),
  (5, 4, 'firm tofu', 99, NULL, 0, 10, NULL),
  (6, 9, 'soy milk', 3, 3, 0, 10, NULL),
  (7, 5, 'soy milk', 3, 3, 0, 10, NULL),
  (8, 6, 'firm tofu', 7, NULL, 0, 10, NULL);
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
  console.error('[test_supplier_account] could not load the router:', e.message);
  process.exit(2);
}

(async () => {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/retail-admin`;
  const send = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
                                        body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const acct = async () => (await send('GET', '/suppliers/1/account')).json.data;

  console.log(`\n── BEHAVIOURAL: supplier accounts (${driver}) ──`);

  // ── The switch ──────────────────────────────────────────────────────────
  let r = await send('POST', '/suppliers/1/account/entries', { kind: 'payment', amount: 100, date: '2026-09-21' });
  ok('a supplier NOT on credit takes no entries', r.status === 409 && r.json.error === 'not_on_credit', r);
  r = await send('GET', '/supplier-accounts');
  ok('and is not on the list of suppliers we owe', r.status === 200 && r.json.data.suppliers.length === 0, r.json);

  r = await send('PUT', '/suppliers/1/account', { on_credit: true });
  ok('the switch turns credit on', r.status === 200 && r.json.data.on_credit === true, r.json);

  // ── The figure, from orders ─────────────────────────────────────────────
  let a = await acct();
  ok('goods = delivered orders only, billable qty × cost: 240 + 100 + 30',
     a.goods === 370, a.goods);
  ok('a returned quantity is not owed (RPO-1 counts 8, not 10)',
     (a.orders.find(o => o.po_number === 'RPO-1') || {}).amount === 240, a.orders);
  ok('a mixed order counts only this supplier\'s line',
     (a.orders.find(o => o.po_number === 'RPO-2') || {}).amount === 100, a.orders);
  ok('a superseded kitchen original is not counted beside its copy',
     !a.orders.some(o => o.po_number === 'PO-9') && a.orders.some(o => o.po_number === 'RPO-5'), a.orders.map(o => o.po_number));
  ok('drafts and cancelled orders are never counted',
     !a.orders.some(o => o.po_number === 'RPO-4' || o.po_number === 'RPO-6'), a.orders.map(o => o.po_number));
  ok('an order still on the way is reported beside the figure, not in it',
     a.on_the_way === 50 && a.owed === 370, { on_the_way: a.on_the_way, owed: a.owed });

  // ── A payment ───────────────────────────────────────────────────────────
  const expBefore = handle.prepare('SELECT COUNT(*) AS n FROM expense_entries').get().n;
  r = await send('POST', '/suppliers/1/account/entries',
                 { kind: 'payment', amount: '120', date: '2026-09-21', method: 'WeChat', note: 'part' });
  ok('a lump-sum payment is recorded', r.status === 200 && r.json.id > 0, r);
  ok('and lowers what we owe: 370 − 120 = 250', r.json.data.owed === 250, r.json.data);
  ok('A PAYMENT IS NOT AN EXPENSE — nothing written to expense_entries',
     handle.prepare('SELECT COUNT(*) AS n FROM expense_entries').get().n === expBefore);
  ok('the last payment is reported', r.json.data.last_payment && r.json.data.last_payment.amount === 120, r.json.data.last_payment);

  for (const [body, err, name] of [
    [{ kind: 'payment', amount: 0 }, 'amount_must_be_positive', 'a zero payment is refused'],
    [{ kind: 'payment', amount: -5 }, 'amount_must_be_positive', 'a negative payment is refused'],
    [{ kind: 'payment', amount: 'abc' }, 'invalid_amount', 'a non-number is refused'],
    [{ kind: 'payment', amount: '' }, 'invalid_amount', 'an empty amount is refused'],
    [{ kind: 'adjustment', amount: 0 }, 'invalid_amount', 'a zero correction is refused'],
    [{ kind: 'expense', amount: 5 }, 'invalid_kind', 'an unknown kind is refused'],
    [{ kind: 'payment', amount: 5, date: '21/09/2026' }, 'invalid_date', 'a malformed date is refused'],
  ]) {
    r = await send('POST', '/suppliers/1/account/entries', body);
    ok(name, r.status === 400 && r.json.error === err, r);
  }

  // ── A correction ────────────────────────────────────────────────────────
  r = await send('POST', '/suppliers/1/account/entries', { kind: 'adjustment', amount: -10, date: '2026-09-22', note: 'rounded off' });
  ok('a negative correction (a discount) lowers what we owe: 250 − 10 = 240', r.status === 200 && r.json.data.owed === 240, r.json.data);

  // ── The starting balance ────────────────────────────────────────────────
  r = await send('POST', '/suppliers/1/account/entries', { kind: 'opening', amount: 500, date: '2026-09-05' });
  a = r.json.data;
  ok('a starting balance is recorded', r.status === 200 && a.opening && a.opening.amount === 500, a.opening);
  ok('orders dated on or before it are taken as already in it (RPO-1 drops out)',
     !a.orders.some(o => o.po_number === 'RPO-1') && a.goods === 130, { goods: a.goods, orders: a.orders.map(o => o.po_number) });
  ok('owed = 500 + 130 − 120 − 10 = 500', a.owed === 500, a.owed);

  r = await send('POST', '/suppliers/1/account/entries', { kind: 'opening', amount: 300, date: '2026-09-11' });
  a = r.json.data;
  ok('a new starting balance REPLACES the old one', a.opening.amount === 300 && a.entries.filter(e => e.kind === 'opening' && !e.voided_at).length === 1, a.entries);
  ok('the old one is kept, voided', a.entries.some(e => e.kind === 'opening' && e.amount === 500 && e.voided_at), a.entries);
  ok('owed = 300 + RPO-5 30 − 120 − 10 = 200', a.owed === 200, a.owed);

  // ── Voiding ─────────────────────────────────────────────────────────────
  const payId = a.entries.find(e => e.kind === 'payment').id;
  r = await send('POST', `/suppliers/1/account/entries/${payId}/void`);
  ok('a wrong payment is voided and stops counting: 200 + 120 = 320', r.status === 200 && r.json.data.owed === 320, r.json.data);
  ok('the voided row is kept with who voided it',
     (handle.prepare('SELECT voided_at, voided_by_name FROM supplier_account_entries WHERE id = ?').get(payId) || {}).voided_by_name === 'tester');
  r = await send('POST', `/suppliers/1/account/entries/${payId}/void`);
  ok('voiding twice is refused', r.status === 409 && r.json.error === 'already_voided', r);
  r = await send('POST', '/suppliers/2/account/entries/' + payId + '/void');
  ok('an entry cannot be voided through another supplier', r.status === 404, r);

  // ── The list ────────────────────────────────────────────────────────────
  r = await send('GET', '/supplier-accounts');
  const row = r.json.data.suppliers[0] || {};
  ok('the list carries each credit supplier with what we owe',
     r.json.data.suppliers.length === 1 && row.name === 'Tofu Co' && row.owed === 320 && r.json.data.total_owed === 320, r.json.data);

  // ── Switching off keeps the account ─────────────────────────────────────
  await send('PUT', '/suppliers/1/account', { on_credit: false });
  r = await send('GET', '/supplier-accounts');
  ok('switched off, the supplier leaves the list', r.json.data.suppliers.length === 0, r.json.data);
  await send('PUT', '/suppliers/1/account', { on_credit: true });
  ok('switched back on, the account is exactly as it was', (await acct()).owed === 320);

  r = await send('GET', '/suppliers/999/account');
  ok('an unknown supplier is a 404', r.status === 404, r);

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
