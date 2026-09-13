#!/usr/bin/env node
// THE ANSWER THE EXPENSE FORM REMEMBERS — §111 part two, server side.
//
//   node scripts/test_finance_po_question.js
//
// What is ordered from a supplier belongs on a purchase order. The Transactions
// form cannot tell an ingredient from a month's rent, so it ASKS, once, and
// writes the answer onto the CATEGORY — `categories.needs_po`, beside the
// `is_operating` and `is_active` §87 put there.
//
// THE THREE STATES ARE THE WHOLE THING, and every case below is really about
// one of them. NULL is *nobody has been asked*, which is the state every
// category ships in and the only one that makes the form ask. 1 and 0 are
// answers a person gave. A column with a DEFAULT would have no null state, the
// question would never be asked, and this feature would be dead on arrival with
// every test still green — which is why the first case asserts the ABSENCE of a
// default rather than the presence of a column.
//
// Both routers run for real against a fixture database. The tenant handle and
// the operator gate are stubbed as scaffolding; nothing about the rules is.
//
// Cases:
//   1. a fresh category has no answer, and the ledger payload omits it
//   2. answering records it, and the payload then carries it
//   3. "not ordered" records as 0 — an answer, not an absence
//   4. a name the tenant's list does not hold is a no-op and creates nothing
//   5. a typed spelling snaps onto the listed category
//   6. the answer can be taken back to "not asked" — the way out of a mistake
//   7. a hidden category leaves the map with the list
//   8. none of this touches the ledger row itself

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
                             requireDelete: (q, s, n) => n(),
                             requireAdmin: (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });

const express = require('express');
const app = express();
// server.js parses every body at the top (`app.use(express.json(...))`, line
// 102) and the transactions router leans on that — its POST declares no parser
// of its own. A fixture app without it would 400 every write for a reason the
// product does not have.
app.use(express.json({ limit: '50mb' }));
app.use(require(path.join(ROOT, 'routes/finance-categories.js')));
app.use(require(path.join(ROOT, 'routes/finance-transactions.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

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
// The ledger payload the screen reads, over a window wide enough to hold the
// fixture rows whatever today is.
const ledger = async () => (await call('GET', '/api/retail-admin/finance/transactions?from=2020-01-01&to=2099-12-31')).body.data;
const answer = (name, needs_po) => call('PUT', '/api/retail-admin/finance/categories/answer', { name, needs_po });
const cats = () => db.prepare("SELECT id, name, needs_po FROM categories WHERE kind = 'accounting' ORDER BY id").all();

async function main() {
  // The tenant's own list, written the way the Categories screen writes it.
  for (const name of ['原料 Ingredients', '租金 Rent', '办公用品 Office supplies']) {
    await call('POST', '/api/retail-admin/finance/categories', { name });
  }

  console.log('\n══ 1 · a fresh category has no answer ══');
  const fresh = cats();
  eq(fresh.length, 3, 'three categories on the list');
  ok(fresh.every(c => c.needs_po == null), 'every one of them is NULL — nobody has been asked');
  let payload = await ledger();
  ok(payload.category_needs_po && typeof payload.category_needs_po === 'object',
     'the ledger payload carries the answer map');
  eq(Object.keys(payload.category_needs_po).length, 0, 'and it is empty, so the form will ask');
  eq(payload.expense_categories.length, 3, 'while the category list itself is full');

  console.log('\n══ 2 · answering records it ══');
  let r = await answer('原料 Ingredients', true);
  eq(r.status, 200, 'responds 200');
  ok(r.body && r.body.recorded === true, 'reports it was recorded');
  eq(cats().find(c => c.name === '原料 Ingredients').needs_po, 1, 'stored as 1');
  payload = await ledger();
  eq(payload.category_needs_po['原料 Ingredients'], 1, 'and the payload says so');
  ok(!('租金 Rent' in payload.category_needs_po), 'the unanswered ones are still absent');

  console.log('\n══ 3 · "not ordered" is an answer, not an absence ══');
  await answer('租金 Rent', false);
  eq(cats().find(c => c.name === '租金 Rent').needs_po, 0, 'stored as 0');
  payload = await ledger();
  eq(payload.category_needs_po['租金 Rent'], 0, 'the payload carries the 0');
  ok('租金 Rent' in payload.category_needs_po,
     'PRESENT with a 0 — which is what stops the form asking about rent again');

  console.log('\n══ 4 · a name the list does not hold is a no-op ══');
  const before = cats().length;
  r = await answer('Something Nobody Listed', true);
  eq(r.status, 200, 'responds 200 — the row was still recorded for the person who asked');
  ok(r.body && r.body.recorded === false, 'but reports it was NOT remembered');
  eq(cats().length, before, 'and NOTHING was created — the list is the tenant’s to grow');

  console.log('\n══ 5 · a typed spelling snaps onto the listed category ══');
  // storeCategory is the rule every writer of this vocabulary shares. Without it
  // an answer given against what somebody typed would miss the listed row and be
  // silently forgotten — the form would ask again forever.
  r = await answer('  办公用品   Office supplies  ', true);
  ok(r.body && r.body.recorded === true, 'the spacing-different spelling still lands');
  eq(r.body.name, '办公用品 Office supplies', 'on the listed name');
  eq(cats().find(c => c.name === '办公用品 Office supplies').needs_po, 1, 'and is stored there');

  console.log('\n══ 6 · an answer can be taken back ══');
  // The way out of a wrong "no": without it, one mistaken answer would send
  // every future ingredient purchase into the ledger forever with nothing on
  // screen to say why the question had stopped.
  const rentId = cats().find(c => c.name === '租金 Rent').id;
  r = await call('PATCH', '/api/retail-admin/finance/categories/' + rentId, { needs_po: true });
  eq(r.status, 200, 'the settings control can flip it');
  eq(cats().find(c => c.id === rentId).needs_po, 1, 'to 1');
  r = await call('PATCH', '/api/retail-admin/finance/categories/' + rentId, { needs_po: null });
  eq(r.status, 200, 'and back to not-asked');
  ok(cats().find(c => c.id === rentId).needs_po == null, 'NULL again — the form will ask once more');
  // A PATCH about something else must not wipe it.
  await answer('租金 Rent', false);
  await call('PATCH', '/api/retail-admin/finance/categories/' + rentId, { name: '租金 Rent' });
  eq(cats().find(c => c.id === rentId).needs_po, 0, 'a rename leaves the answer alone');

  console.log('\n══ 7 · a hidden category leaves the map with the list ══');
  const officeId = cats().find(c => c.name === '办公用品 Office supplies').id;
  await call('PATCH', '/api/retail-admin/finance/categories/' + officeId, { is_active: false });
  payload = await ledger();
  ok(!payload.expense_categories.includes('办公用品 Office supplies'), 'it is off the list');
  ok(!('办公用品 Office supplies' in payload.category_needs_po),
     'and out of the map — nothing can be filed under it, so its answer decides nothing');
  eq(cats().find(c => c.id === officeId).needs_po, 1, 'the stored answer survives for when it is restored');

  console.log('\n══ 8 · none of this touches the ledger row ══');
  r = await call('POST', '/api/retail-admin/finance/transactions',
                 { kind: 'out', date: '2026-09-13', amount: 88, category: '租金 Rent', note: 'September' });
  eq(r.status, 200, 'a typed expense still posts');
  const row = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(r.body.id);
  eq(Number(row.amount), 88, 'with its amount');
  eq(row.category, '租金 Rent', 'and its category');
  ok(row.po_id == null, 'and no po_id — a typed row is not a projection');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
