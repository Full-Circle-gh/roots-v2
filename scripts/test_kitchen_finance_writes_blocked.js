#!/usr/bin/env node
// routes/finance.js — the kitchen app's finance WRITE routes are blocked.
//
// §36, "`routes/finance.js` is not fixed — it is blocked and left to die":
// this file has no tenant handling anywhere. All seventeen routes use the
// module-level global database handle and none calls tdb(), so a second tenant
// reaching them would read and write Roots' ledger. §36 rules that the fix is
// NOT to thread tdb() through a file scheduled for deletion — it is to block
// the WRITE routes at the route layer, using the same middleware already
// applied to the kitchen cost writes, and to LEAVE THE READS ALONE.
//
// WHAT THIS FILE USED TO BE, and why it is not that any more. It was
// test_finance_category_normalization.js, and it proved that the four
// category-bearing endpoints here — POST/PUT on /api/finance/expenses and
// /api/finance/income — ran their category text through lib/category-text.js.
// §36's block removes the subject: those endpoints no longer write at all, so
// every one of those five cases asserted behaviour that can no longer happen.
// The cases are not skipped or quarantined — the contract they guarded moved.
//   · The LIVE writer's normalisation contract is proved by
//     scripts/test_finance_transactions.js, "§36 is honoured: storeCategory
//     runs on every write", against routes/finance-transactions.js. That is
//     the surviving writer and it is unaffected by any of this.
//   · What this file proves now is the stronger property that replaced it:
//     these paths cannot write anything, correct or otherwise.
//
// Cases:
//   1. all NINE write routes refuse with 403 — POST/PUT/DELETE across income,
//      expenses and invoices alike
//   2. the refusal carries both languages and names Tacet, so an operator is
//      told where the entry lives now rather than meeting a bare error code
//   3. nothing reaches the database — row counts are identical afterwards
//   4. all EIGHT read routes still answer 200: §36 leaves reads alone, and the
//      kitchen Finance screens must still display what is already recorded
//   5. the block is the SHARED middleware, not a second mechanism invented here
//
// Run:  node scripts/test_kitchen_finance_writes_blocked.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// NEVER data/roots.db — scripts/ is deployed (see test_kitchen_po_copy.js).
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
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
// Auth is stubbed WIDE OPEN on purpose. The block must not depend on a
// permission failing — an operator who legitimately holds `finance` is exactly
// who used to type these rows, and is who must now be refused.
stub('middleware/auth.js', {
  requireAuth: (req, res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
  requirePermission: () => (req, res, next) => next(),
  requireDelete: (req, res, next) => next(),
  logActivity: () => {},
});

// ── seed ─────────────────────────────────────────────────────────────────
db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting', ?)").run('Ingredients(Kitchen+Retail Use)');
// One row in each ledger, so the PUT and DELETE attempts below aim at
// something real. A refusal on a missing id would pass for the wrong reason.
const seedIncome = db.prepare(
  "INSERT INTO income_entries (date,amount,category,description) VALUES ('2026-08-01',10,'Sublet','seed')"
).run().lastInsertRowid;
const seedExpense = db.prepare(
  "INSERT INTO expense_entries (date,amount,category,description) VALUES ('2026-08-01',10,'Rent','seed')"
).run().lastInsertRowid;
const seedInvoice = db.prepare(
  "INSERT INTO invoices (supplier,invoice_number,amount,date) VALUES ('Acme','INV-1',10,'2026-08-01')"
).run().lastInsertRowid;

const express = require('express');
const app = express();
app.use(express.json());
app.use(require(path.join(ROOT, 'routes/finance.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const count = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const row = (t, id) => db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);

// Every write route in the file, with a body that WOULD have succeeded before
// the block. Kept as data so a route added later without a block shows up as a
// gap here rather than being discovered in production.
const WRITES = [
  ['POST',   '/api/finance/income',                  { date: '2026-08-05', amount: 200, category: 'Sublet Income' }],
  ['PUT',    `/api/finance/income/${seedIncome}`,    { date: '2026-08-06', amount: 999, category: 'Changed' }],
  ['DELETE', `/api/finance/income/${seedIncome}`,    undefined],
  ['POST',   '/api/finance/expenses',                { date: '2026-08-05', amount: 100, category: 'Rent' }],
  ['PUT',    `/api/finance/expenses/${seedExpense}`, { date: '2026-08-06', amount: 999, category: 'Changed' }],
  ['DELETE', `/api/finance/expenses/${seedExpense}`, undefined],
  ['POST',   '/api/finance/invoices',                { supplier: 'Acme', invoice_number: 'INV-2', amount: 50, date: '2026-08-05', links: [] }],
  ['PUT',    `/api/finance/invoices/${seedInvoice}`, { supplier: 'Acme', invoice_number: 'INV-9', amount: 99, date: '2026-08-06', links: [] }],
  ['DELETE', `/api/finance/invoices/${seedInvoice}`, undefined],
];

// Every read route. §36: "Reads are to be left alone."
const READS = [
  '/api/finance/income',
  '/api/finance/expenses',
  '/api/finance/summary',
  '/api/finance/invoice-summary',
  '/api/finance/invoices',
  `/api/finance/invoices/${seedInvoice}`,
  '/api/finance/outstanding-lines',
  '/api/finance/outstanding-pos',
];

async function main() {
  console.log('\n══ 1 · every write route refuses ══');

  const before = {
    income:   count('income_entries'),
    expenses: count('expense_entries'),
    invoices: count('invoices'),
  };

  const messages = [];
  for (const [method, p, body] of WRITES) {
    const r = await call(method, p, body);
    eq(r.status, 403, `${method} ${p} refuses`);
    eq(r.body && r.body.error, 'kitchen_cost_write_blocked', `${method} ${p} refuses with the shared error code`);
    if (r.body && r.body.message) messages.push(r.body.message);
  }
  eq(WRITES.length, 9, 'all nine write routes are covered — §36 counted nine, and a tenth must fail here');

  console.log('\n══ 2 · the refusal is bilingual and names Tacet ══');
  {
    const m = messages[0] || '';
    ok(/Tacet/.test(m), 'the message names Tacet, so the operator is told where the entry lives now');
    ok(/[一-鿿]/.test(m), 'the message carries a Chinese half');
    ok(/[A-Za-z]{4,}/.test(m), 'the message carries an English half');
    ok(/无法在此编辑/.test(m), 'the Chinese half says it can no longer be edited here');
    ok(messages.length === 9 && new Set(messages).size <= 2,
      'the nine refusals speak with one voice — at most two subjects, the ledger and the invoice list');
  }

  console.log('\n══ 3 · nothing reached the database ══');
  eq(count('income_entries'),  before.income,   'no income row was added or removed');
  eq(count('expense_entries'), before.expenses, 'no expense row was added or removed');
  eq(count('invoices'),        before.invoices, 'no invoice row was added or removed');
  eq(row('income_entries', seedIncome).amount,   10, 'the seeded income row is untouched by the refused PUT');
  eq(row('expense_entries', seedExpense).amount, 10, 'the seeded expense row is untouched by the refused PUT');
  eq(row('invoices', seedInvoice).amount,        10, 'the seeded invoice is untouched by the refused PUT');

  console.log('\n══ 4 · every read route still answers — §36 leaves reads alone ══');
  for (const p of READS) {
    const r = await call('GET', p);
    eq(r.status, 200, `GET ${p} still answers`);
  }
  eq(READS.length, 8, 'all eight read routes are covered — seventeen routes, nine blocked, eight open');

  console.log('\n══ 5 · the block is the shared middleware, not a second mechanism ══');
  {
    const CODE = fs.readFileSync(path.join(ROOT, 'routes/finance.js'), 'utf8');
    ok(/require\('\.\.\/middleware\/block-kitchen-cost-writes'\)/.test(CODE),
      'routes/finance.js imports the same middleware routes/ingredients.js and friends use');
    eq((CODE.match(/blockCostWrite\(/g) || []).length - (CODE.match(/\/\/[^\n]*blockCostWrite\(/g) || []).length, 9,
      'it is applied exactly nine times, once per write route');
    ok(!/res\.status\(403\)/.test(CODE),
      'and the file rolls no 403 of its own — the refusal has ONE definition site');
  }

  console.log('\n══ 6 · no kitchen UI control still posts into a blocked route ══');
  {
    // A control that posts into a blocked route is a lie to the operator: it
    // looks like the entry was possible and fails only after they have typed
    // it. public/app.html must carry none.
    const UI = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
    const DEAD = ['addIncomeEntry', 'editIncomeEntry', 'deleteIncomeEntry',
                  'addExpenseEntry', 'editExpenseEntry', 'deleteExpenseEntry',
                  'showAddInvoiceModal', 'deleteInvoice'];
    for (const fn of DEAD) {
      ok(!new RegExp(`onclick="[^"]*\\b${fn}\\s*\\(`).test(UI),
        `no onclick calls ${fn}()`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
