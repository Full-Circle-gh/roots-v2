#!/usr/bin/env node
/**
 * Returns on money out (§269), end to end over HTTP, on the REAL schema.
 *
 *   node scripts/test_expense_returns_routes.js
 *
 * database.js and schema.sql are copied into a scratch folder and booted for
 * real, so the four new `expense_entries` columns come from the shipped
 * migration rather than a hand-written fixture. The routes are the shipped
 * ones; only auth, names and the tenant handle are stubbed (the same harness
 * scripts/test_claim_purchase_order.js uses).
 *
 * The story is the one reported: a ¥19 staff claim for glass cups, paid out of
 * the employee's pocket, approved, paid back — then the cups went back.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const db = require(path.join(SCRATCH, 'database.js'));
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };
function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n(), requireAdmin: (q, s, n) => n() });
// An owner: every gate passes. The gates themselves are cap-routes' subject.
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
  req.user = { id: 7, username: 'asher' };
  req.backendUser = { role: 'owner' };
  next();
} });
stub('lib/user-names.js', { userNames: () => new Map() });

const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(require(path.join(ROOT, 'routes/staff-expenses.js')));
app.use(require(path.join(ROOT, 'routes/finance-transactions.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ledger = async () => (await call('GET', '/api/retail-admin/finance/transactions?from=2026-09-01&to=2026-09-30')).body.data;
const owed = async () => (await call('GET', '/api/retail-admin/staff-expenses/pending')).body.data.owed;
const catTotal = (cat) => db.prepare('SELECT ROUND(COALESCE(SUM(amount),0),2) AS t FROM expense_entries WHERE category = ?').get(cat).t;

async function main() {
  console.log('\n══ 1 · the migration ══');
  const cols = db.prepare("SELECT name FROM pragma_table_info('expense_entries')").all().map(c => c.name);
  for (const c of ['returns_entry_id', 'returns_claim_id', 'return_reason', 'return_settled']) {
    ok(cols.includes(c), `expense_entries.${c} exists`);
  }

  console.log('\n══ 2 · the ¥19 cups: claimed, approved, paid back ══');
  db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting','其他费用')").run();
  let r = await call('POST', '/api/retail-admin/staff-expenses',
    { date: '2026-09-20', amount: 19, category: '其他费用', note: 'glass cups for smoothie new location', paid_by: 'employee' });
  eq(r.status, 200, 'claim submitted');
  const claimId = r.body.id;
  eq((await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' })).status, 200, 'approved');
  eq((await call('POST', `/api/retail-admin/staff-expenses/${claimId}/settle`, { settled: true })).status, 200, 'paid back');
  let L = await ledger();
  const row = L.rows.find(x => x.source === 'claim' && x.claim_id === claimId);
  ok(!!row, 'the claim row is on the ledger');
  eq(L.totals.out, 19, 'money out is ¥19');
  eq(await owed(), [], 'nothing owed — already paid back');

  console.log('\n══ 3 · the cups go back ══');
  r = await call('POST', `/api/retail-admin/finance/transactions/out/${row.id}/return`,
    { date: '2026-09-26', amount: 25, reason: 'not_needed' });
  eq(r.status, 400, 'more than was spent is refused');
  r = await call('POST', `/api/retail-admin/finance/transactions/out/${row.id}/return`,
    { date: '2026-09-26', amount: 19, reason: '' });
  eq(r.status, 400, 'no reason is refused');
  r = await call('POST', `/api/retail-admin/finance/transactions/out/${row.id}/return`,
    { date: '2026-09-26', amount: 19, reason: 'not_needed' });
  eq(r.status, 200, 'the return is recorded');
  eq(r.body.open, true, 'and the employee holds the refund');

  L = await ledger();
  eq(L.totals.out, 0, 'money out nets to ¥0');
  eq(catTotal('其他费用'), 0, 'the category nets to ¥0 — the Summary reads the same table');
  const ret = L.rows.find(x => x.source === 'return');
  ok(!!ret && ret.amount === -19 && ret.held_by_staff === true && ret.reason === 'not_needed',
    'the return row: −19 stored, held by staff, with its reason');
  const src = L.rows.find(x => x.source === 'claim' && x.claim_id === claimId);
  eq(src.returned, 19, 'the claim row says ¥19 went back');
  ok(L.rows.filter(x => x.source === 'manual').length === 0, 'the return is NOT listed as a typed row (no Edit)');

  let o = await owed();
  eq(o.map(x => Math.round(x.total * 100) / 100), [-19], 'the owed block: the employee owes the shop ¥19');

  console.log('\n══ 4 · the claim is locked while the return stands ══');
  eq((await call('POST', `/api/retail-admin/staff-expenses/${claimId}/void`, {})).status, 409, 'void refused');
  eq((await call('PUT', `/api/retail-admin/finance/transactions/out/${ret.id}`,
    { date: '2026-09-26', amount: 5, category: '其他费用' })).status, 404, 'a return is not editable');
  r = await call('POST', `/api/retail-admin/finance/transactions/out/${row.id}/return`,
    { date: '2026-09-26', amount: 1, reason: 'quality' });
  eq(r.status, 400, 'nothing left to return');

  console.log('\n══ 5 · the refund is handed over ══');
  for (const id of String(o[0].ids).split(',')) {
    await call('POST', `/api/retail-admin/staff-expenses/${id}/settle`, { settled: true });
  }
  eq(await owed(), [], 'Mark recovered clears it');
  L = await ledger();
  eq(L.rows.find(x => x.source === 'return').held_by_staff, false, 'and the row stops saying so');

  console.log('\n══ 6 · a typed row, returned in part ══');
  r = await call('POST', '/api/retail-admin/finance/transactions',
    { kind: 'out', date: '2026-09-10', amount: 100, category: 'Supplies', note: 'jars' });
  const typedId = r.body.id;
  r = await call('POST', `/api/retail-admin/finance/transactions/out/${typedId}/return`,
    { date: '2026-09-12', amount: 30, reason: 'wrong_item' });
  eq(r.status, 200, 'part-return recorded');
  eq(r.body.open, false, 'nobody holds anything — the shop paid');
  eq(catTotal('Supplies'), 70, 'Supplies nets to ¥70');
  eq((await call('DELETE', `/api/retail-admin/finance/transactions/out/${typedId}`)).status, 409,
    'the typed row cannot be deleted while its return stands');
  eq((await call('PUT', `/api/retail-admin/finance/transactions/out/${typedId}`,
    { kind: 'out', date: '2026-09-10', amount: 20, category: 'Supplies' })).status, 400,
    'nor cut below what went back');
  eq((await call('PUT', `/api/retail-admin/finance/transactions/out/${typedId}`,
    { kind: 'out', date: '2026-09-10', amount: 100, category: 'Kitchen' })).status, 200,
    're-filed to another category');
  eq([catTotal('Supplies'), catTotal('Kitchen')], [0, 70], 'and the return moved with it');

  console.log('\n══ 7 · undo ══');
  const typedRet = (await ledger()).rows.find(x => x.source === 'return' && x.returns_entry_id === typedId);
  eq((await call('DELETE', `/api/retail-admin/finance/transactions/out/${typedRet.id}`)).status, 200, 'the return is deleted');
  eq(catTotal('Kitchen'), 100, 'the spend is whole again');
  eq(db.prepare("SELECT COUNT(*) AS n FROM deleted_records WHERE kind = 'finance_out'").get().n, 0,
    'and it was not copied to the recycle bin');
  eq((await call('DELETE', `/api/retail-admin/finance/transactions/out/${typedId}`)).status, 200,
    'now the typed row can go');

  console.log('\n══ 8 · a PO row is Purchasing\'s ══');
  db.prepare("INSERT INTO purchase_orders (id, po_number, date, status) VALUES (900, 'RPO-0900', '2026-09-05', 'Ordered')").run();
  const poRow = db.prepare("INSERT INTO expense_entries (date, amount, category, po_id) VALUES ('2026-09-05', 50, 'Kitchen', 900)").run().lastInsertRowid;
  eq((await call('POST', `/api/retail-admin/finance/transactions/out/${poRow}/return`,
    { date: '2026-09-06', amount: 10, reason: 'quality' })).status, 400, 'refused');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
