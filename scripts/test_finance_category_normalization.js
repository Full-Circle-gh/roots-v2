#!/usr/bin/env node
// routes/finance.js — category normalisation on the four legacy write paths.
//
// §36 says "Finance calls storeCategory on every write" and
// routes/finance-transactions.js (the Tacet ledger) already does it. The four
// endpoints here — POST/PUT /api/finance/expenses and POST/PUT
// /api/finance/income — are the kitchen Finance API's own writers of
// expense_entries.category / income_entries.category, and until now none of
// them ran the value through lib/category-text.js at all: no trim, no glyph
// repair, no snap to the tenant's master list.
//
// Each write site is kind-fixed, never inferred: the two expense endpoints
// always snap against kind='accounting', the two income endpoints always
// against kind='income' — same rule finance-transactions.js already proved
// out with `kind === 'in' ? 'income' : 'accounting'`.
//
// Cases:
//   1. POST /api/finance/expenses repairs a pasted Kangxi radical, and snaps
//      a spacing/case variant onto the tenant's accounting master spelling
//   2. POST /api/finance/income, against an EMPTY income master list (the
//      production shape — §36 ships that list empty by decision): the value
//      still stores, normalised, and the write does not throw
//   3. PUT with category omitted entirely leaves the stored value untouched
//      on both expenses and income — the existing pickOptional "undefined
//      means don't touch it" contract must survive the added normalisation
//   4. PUT with an explicit blank category clears the field to NULL, same as
//      a fresh insert would
//   5. income and expense snapping never cross: an income-list entry must
//      not be offered to an expense write and vice versa
//
// Run:  node scripts/test_finance_category_normalization.js

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
stub('middleware/auth.js', {
  requireAuth: (req, res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
  requirePermission: () => (req, res, next) => next(),
  requireDelete: (req, res, next) => next(),
  logActivity: () => {},
});

// ── seed ─────────────────────────────────────────────────────────────────
// A user row for created_by's FK — the stubbed requireAuth below hands every
// request req.user = { id: 1 }.
db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'tester', 'x')").run();
// The accounting list carries one entry with the canonical spacing. The
// income list is left EMPTY — §36 ships it that way in production, and this
// is exactly the shape that must not throw on write.
db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting', ?)").run('Ingredients(Kitchen+Retail Use)');

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
const expense = id => db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(id);
const income  = id => db.prepare('SELECT * FROM income_entries WHERE id = ?').get(id);

async function main() {
  console.log('\n══ 1 · storeCategory runs on every write, kind fixed per endpoint ══');

  // ── expenses: snap onto the accounting master list ────────────────────
  {
    const variant = 'Ingredients (Kitchen + Retail Use) 原材料（厨房及零售通⽤）';
    const r = await call('POST', '/api/finance/expenses',
      { date: '2026-08-05', amount: 100, category: variant });
    eq(r.status, 200, 'POST expenses accepts a variant category');
    const row = expense(r.body.id);
    // Only the ENGLISH half is a spacing/case variant of the seeded master
    // entry; the radical in the Chinese half is repaired by normaliseCategory
    // regardless, but the snap only fires when the whole normalised string
    // matches by spacingKey. Assert the piece that actually proves the write
    // path: the master entry's own spelling wins over ASCII spacing noise
    // when the two otherwise agree.
    ok(row.category !== variant, 'the raw, unnormalised variant must not survive to storage');
    ok(!/⽤/.test(row.category), 'the Kangxi radical must be repaired on write');
  }

  // ── expenses: a spacing + case variant snaps to the master's own spelling ──
  {
    const r = await call('POST', '/api/finance/expenses',
      { date: '2026-08-05', amount: 50, category: ' ingredients (kitchen+retail use) ' });
    eq(r.status, 200, 'POST expenses accepts a lower-case, differently-spaced match');
    eq(expense(r.body.id).category, 'Ingredients(Kitchen+Retail Use)',
      'a spacing/case-only variant snaps onto the tenant’s own master spelling');
  }

  console.log('\n══ 2 · income, against the production shape — an EMPTY income list ══');
  {
    const r = await call('POST', '/api/finance/income',
      { date: '2026-08-05', amount: 200, category: '  Sublet   Income  ' });
    eq(r.status, 200, 'POST income does not throw against an empty income master list');
    eq(income(r.body.id).category, 'Sublet Income',
      'with nothing to snap onto, the value still stores normalised (whitespace collapsed)');
  }

  console.log('\n══ 3 · PUT with category omitted leaves the stored value untouched ══');
  {
    const seeded = db.prepare(
      "INSERT INTO expense_entries (date,amount,category,description) VALUES ('2026-08-01',10,'Rent',NULL)"
    ).run().lastInsertRowid;
    const r = await call('PUT', `/api/finance/expenses/${seeded}`,
      { date: '2026-08-02', amount: 20 }); // no `category` key at all
    eq(r.status, 200, 'PUT expenses without category succeeds');
    eq(expense(seeded).category, 'Rent', 'an omitted category is not renormalised or cleared');
  }
  {
    const seeded = db.prepare(
      "INSERT INTO income_entries (date,amount,category,description) VALUES ('2026-08-01',10,'Sublet',NULL)"
    ).run().lastInsertRowid;
    const r = await call('PUT', `/api/finance/income/${seeded}`,
      { date: '2026-08-02', amount: 20 }); // no `category` key at all
    eq(r.status, 200, 'PUT income without category succeeds');
    eq(income(seeded).category, 'Sublet', 'an omitted category is not renormalised or cleared');
  }

  console.log('\n══ 4 · PUT with an explicit blank category clears it to NULL ══');
  {
    const seeded = db.prepare(
      "INSERT INTO expense_entries (date,amount,category,description) VALUES ('2026-08-01',10,'Rent',NULL)"
    ).run().lastInsertRowid;
    const r = await call('PUT', `/api/finance/expenses/${seeded}`,
      { date: '2026-08-02', amount: 20, category: '   ' });
    eq(r.status, 200, 'PUT expenses with a blank category succeeds');
    eq(expense(seeded).category, null, 'a blank category clears to NULL, same as storeCategory promises');
  }

  console.log('\n══ 5 · the two lists are never crossed ══');
  {
    db.prepare("INSERT INTO categories (kind, name) VALUES ('income', 'Grant Income')").run();
    const rIn = await call('POST', '/api/finance/income',
      { date: '2026-08-06', amount: 300, category: ' grant income ' });
    eq(income(rIn.body.id).category, 'Grant Income', 'income snaps onto its own list');
    const rOut = await call('POST', '/api/finance/expenses',
      { date: '2026-08-06', amount: 30, category: ' grant income ' });
    ok(expense(rOut.body.id).category !== 'Grant Income',
      'an expense write must never snap onto an entry from the income list');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
