// The finance-category normaliser stops snapping income onto the expense
// list, and skips income (never refuses, never runs silent) while its own
// master list is empty (npm run test:normalise-finance-categories).
//
// §36 v4.119: scripts/normalise_finance_categories.js read ONE master
// (`categories` where kind='accounting') and matched all four of its target
// columns against it, income_entries.category included — so an income value
// one spacing/radical edit from an expense category would snap onto the
// expense spelling. Fixed by giving each target its own master by `kind`.
// Ash's ruling, 2026-09-02: income is SKIPPED (not refused, not silent, not
// an error) while `kind='income'` is empty — the shipped state, not a fault.
//
// Each case below runs the REAL script, as a child process, against a
// scratch DB built from schema.sql's / database.js's own DDL (the same
// helper scripts/test-support/memory-db.js gives every other suite), with
// `require('better-sqlite3')` replaced by a node:sqlite-backed shim through a
// --require preload — the same technique test_eleme_fee_backfill.js uses,
// needed because this box has no built better-sqlite3 binding. Every line of
// logic under test is the shipped file's own; only the SQLite driver is a
// double.
//
// Run: node scripts/test_normalise_finance_categories.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { addTables } = require('./test-support/memory-db');

const REPO    = path.join(__dirname, '..');
const SCRIPT  = path.join(REPO, 'scripts', 'normalise_finance_categories.js');
const WORK    = fs.mkdtempSync(path.join(os.tmpdir(), 'normalise-fin-cat-'));
const PRELOAD = path.join(WORK, 'preload.js');

const SCHEMA_SQL  = fs.readFileSync(path.join(REPO, 'schema.sql'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');

// 'recipes' is not read by this script at all — it is here only because
// database.js's ingredients.source_recipe_id column is added with an inline
// REFERENCES recipes(id), which SQLite validates against the schema at
// ALTER TABLE time even with FK enforcement off. addTables extracts its real
// (empty-bodied-enough) CREATE the same way it does the other four.
const TABLES = ['categories', 'recipes', 'ingredients', 'po_line_items', 'expense_entries', 'income_entries'];

// A fresh scratch DB, the real table shapes (schema.sql's CREATEs plus every
// addColumn() database.js has bolted on since — accounting_category among
// them, which schema.sql does not carry on its own).
function seed() {
  const file = path.join(WORK, `db-${Math.random().toString(36).slice(2)}.db`);
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  addTables(raw, SCHEMA_SQL, DATABASE_JS, TABLES);
  raw.close();
  return file;
}

function insertCategory(file, kind, name) {
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO categories (kind, name) VALUES (?, ?)').run(kind, name);
  raw.close();
}
function insertIngredient(file, category) {
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO ingredients (name_en, accounting_category) VALUES ('x', ?)").run(category);
  raw.close();
}
function insertExpense(file, category, amount) {
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO expense_entries (date, amount, category) VALUES ('2026-09-01', ?, ?)").run(amount, category);
  raw.close();
}
function insertIncome(file, category, amount) {
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO income_entries (date, amount, category) VALUES ('2026-09-01', ?, ?)").run(amount, category);
  raw.close();
}
function readIncomeCategories(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  const rows = raw.prepare('SELECT category FROM income_entries ORDER BY id').all();
  raw.close();
  return rows.map(r => r.category);
}
function readExpenseCategories(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  const rows = raw.prepare('SELECT category FROM expense_entries ORDER BY id').all();
  raw.close();
  return rows.map(r => r.category);
}

// ── The preload: better-sqlite3 replaced by a node:sqlite-backed shim ──────
// Not resolvable via require.resolve() (the package genuinely is not
// installed here), so this hooks Module._load directly rather than the
// require.cache-injection trick a resolvable relative path allows.
fs.writeFileSync(PRELOAD, `
'use strict';
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

class BetterSqlite3Shim {
  constructor(file, opts) {
    this._raw = new DatabaseSync(file, { readOnly: !!(opts && opts.readonly) });
  }
  pragma(s) { return this._raw.exec('PRAGMA ' + s); }
  exec(s) { return this._raw.exec(s); }
  prepare(sql) {
    const st = this._raw.prepare(sql);
    return {
      all: (...a) => st.all(...a),
      get: (...a) => st.get(...a),
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    };
  }
  transaction(fn) {
    const raw = this._raw;
    return (...a) => {
      raw.exec('BEGIN');
      try { const r = fn(...a); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    };
  }
  close() { this._raw.close(); }
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') return BetterSqlite3Shim;
  return origLoad.apply(this, arguments);
};
`);

function run(file, args) {
  try {
    const out = execFileSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...args], {
      env: { ...process.env, ROOTS_DB: file },
      stdio: 'pipe', encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA · income master empty, accounting master populated — dry run');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  insertCategory(f, 'accounting', 'Rent 房租');
  insertIngredient(f, 'Rent  房租');           // double space — a real variant
  insertIncome(f, 'Sublet 转租收入', 500);
  insertIncome(f, 'Sublet 转租收入', 300);

  const r = run(f, []);
  check('exits 0 — not a refusal', r.code === 0, r.out.slice(-800));
  check('accounting side still gets a plan', /Rent 房租/.test(r.out), r.out.slice(-800));
  check('SKIPPED block names income_entries.category',
    /SKIPPED[\s\S]*income_entries\.category\s+2 row/.test(r.out), r.out.slice(-1200));
  check('the skip reason names the empty income master, not an error',
    /income master list.*kind='income'.*empty/.test(r.out.replace(/\s+/g, ' ')), r.out.slice(-1200));
  check('says DRY RUN, not REFUSING', /DRY RUN — nothing was written/.test(r.out), r.out.slice(-300));
  check('never says REFUSING TO RUN', !/REFUSING TO RUN/.test(r.out), r.out);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nB · same state, --apply: accounting rewritten, income untouched byte for byte');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  insertCategory(f, 'accounting', 'Rent 房租');
  insertIngredient(f, 'Rent  房租');
  insertIncome(f, 'Sublet 转租收入', 500);

  const before = readIncomeCategories(f);
  const r = run(f, ['--apply']);
  check('exits 0', r.code === 0, r.out.slice(-800));
  check('reports the accounting row rewritten', /1 row\(s\) rewritten/.test(r.out), r.out.slice(-500));
  const after = readIncomeCategories(f);
  check('income_entries.category is byte-for-byte unchanged',
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC · both masters populated: income snaps to ITS OWN list, never the accounting one');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  // Same word, same spacing defect, on BOTH lists — with DIFFERENT canonical
  // spellings. Before the fix, income_entries.category would snap to
  // whichever list's masterByKey the script built last (the accounting one) —
  // the exact cross-list collision §36 v4.119 names.
  insertCategory(f, 'accounting', 'Refund 退款（账目）');
  insertCategory(f, 'income',     'Refund 退款（收入）');
  insertIncome(f, 'Refund  退款（收入）', 200);        // double space — snaps within income
  insertExpense(f, 'Refund  退款（账目）', 150);        // double space — snaps within accounting
  const r = run(f, ['--apply']);
  check('exits 0', r.code === 0, r.out.slice(-1000));
  const income = readIncomeCategories(f);
  const expense = readExpenseCategories(f);
  check('income landed on the INCOME master spelling', income.includes('Refund 退款（收入）'), JSON.stringify(income));
  check('income never landed on the accounting spelling',
    !income.includes('Refund 退款（账目）'), JSON.stringify(income));
  check('expense landed on the ACCOUNTING master spelling', expense.includes('Refund 退款（账目）'), JSON.stringify(expense));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nD · a colliding income master refuses the whole run, same as a colliding accounting one');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  insertCategory(f, 'accounting', 'Rent 房租');
  insertCategory(f, 'income', 'Sublet 转租收入');
  insertCategory(f, 'income', 'Sublet  转租收入');   // double space — collides with the one above
  insertIngredient(f, 'Rent  房租');                  // would otherwise have a plan

  const r = run(f, []);
  check('refuses (nonzero exit)', r.code !== 0, `exit ${r.code}`);
  check('names the collision as the reason', /REFUSING TO RUN/.test(r.out), r.out.slice(-800));
  check(`names kind='income'`, /kind='income'/.test(r.out), r.out.slice(-800));
  check('no plan was produced even for the clean accounting side',
    !/Rent 房租/.test(r.out) || /No plan was produced/.test(r.out), r.out.slice(-800));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nE · an empty ACCOUNTING master still refuses entirely — unchanged regression');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  insertCategory(f, 'income', 'Sublet 转租收入');   // income populated; must not rescue the run
  insertIngredient(f, 'Rent  房租');

  const r = run(f, []);
  check('refuses (nonzero exit)', r.code !== 0, `exit ${r.code}`);
  check('names the accounting master as empty', /kind=accounting.*EMPTY/.test(r.out), r.out.slice(-500));
  check('never reaches SKIPPED (never gets that far)', !/SKIPPED/.test(r.out), r.out);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nF · no rows anywhere: says so, does not crash, exits 0');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = seed();
  insertCategory(f, 'accounting', 'Rent 房租');
  const r = run(f, []);
  check('exits 0', r.code === 0, r.out.slice(-500));
  check('SKIPPED still fires on an empty income master with zero rows',
    /SKIPPED[\s\S]*income_entries\.category\s+0 row/.test(r.out), r.out.slice(-1200));
  check('nothing to change on the accounting side', /Nothing to change/.test(r.out), r.out.slice(-500));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}\n`);
process.exit(failures ? 1 : 0);
