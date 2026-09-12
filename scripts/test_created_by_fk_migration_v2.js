#!/usr/bin/env node
// drop_created_by_user_fk_v2 — rebuild income_entries + expense_entries
// without the created_by → users(id) foreign key, losing nothing.
//
// Same two-process shape as test_created_by_fk_migration.js (v1), for the same
// reason: database.js runs its migrations at require time, once per process,
// so stage 1 builds a pre-migration database in a child process (a real,
// fully-migrated database, then rebuilt to put the FK back and the v2 marker
// removed, then populated), and stage 2 is this process requiring that same
// file, which fires the migration for real against populated data.
//
// This is the Finance Transactions bug directly: routes/finance-transactions.js
// stamps created_by with req.user.id, which for a Mini App Backend operator
// (requireRetailAdmin's backendUserId branch) is a tenant_users id, not a
// users id — the old FK rejected every such insert with exactly
// "FOREIGN KEY constraint failed". The assertions below are the ones that
// matter for the rebuild, plus one that reproduces the reported bug directly:
//   * every row survives, and its VALUES survive (not just the count)
//   * expense_entries KEEPS po_id → purchase_orders(id)
//   * the created_by FK is gone from both tables
//   * a created_by value with no matching users row is now accepted
//   * re-running is a no-op, and v1's own migration is untouched
//
// Run:  node scripts/test_created_by_fk_migration_v2.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const F = require('./test-support/tenant-fixture');
const { ok, eq, section, done } = F.counters();

const SCRATCH = path.join(REPO, `.fkmig2-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(REPO, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(REPO, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(REPO, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

const N_INCOME  = 60;
const N_EXPENSE = 90;

// ── stage 1 (child process): a populated database that still has the FK ─────
const stage1 = `
'use strict';
const db = require(${JSON.stringify(path.join(SCRATCH, 'database.js'))});
db.pragma('foreign_keys = OFF');
db.pragma('legacy_alter_table = ON');
const readd = (t, fkSql) => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t).map(r => r.sql);
  const withFk = sql.replace(/\\n?\\)\\s*$/, ',\\n  ' + fkSql + '\\n)');
  const tmp = '_pre2_' + t;
  db.exec(withFk.replace(new RegExp('(CREATE\\\\s+TABLE\\\\s+)' + t), '$1' + tmp));
  db.exec('INSERT INTO ' + tmp + ' SELECT * FROM ' + t);
  db.exec('DROP TABLE ' + t);
  db.exec('ALTER TABLE ' + tmp + ' RENAME TO ' + t);
  for (const s of idx) db.exec(s);
};
readd('income_entries',  'FOREIGN KEY (created_by) REFERENCES users(id)');
readd('expense_entries', 'FOREIGN KEY (created_by) REFERENCES users(id)');
db.prepare("DELETE FROM _migrations WHERE name = 'drop_created_by_user_fk_v2'").run();
db.pragma('legacy_alter_table = OFF');
db.pragma('foreign_keys = ON');

for (const id of [1, 2, 3]) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, role) VALUES (?,?,?,?)')
    .run(id, 'u' + id, 'x', 'kitchen');
}
db.prepare("INSERT INTO purchase_orders (po_number, date, status) VALUES ('PO-FIX-0001','2026-09-01','received')").run();

const insIn  = db.prepare('INSERT INTO income_entries (date, amount, category, description, created_by) VALUES (?,?,?,?,?)');
const insOut = db.prepare('INSERT INTO expense_entries (date, amount, category, description, po_id, created_by) VALUES (?,?,?,?,?,?)');
db.transaction(() => {
  for (let i = 1; i <= ${N_INCOME}; i++) {
    insIn.run('2026-09-0' + (i % 9 + 1), i * 1.5, 'Rent rebate', 'row ' + i, (i % 7 === 0 ? null : (i % 3) + 1));
  }
  for (let i = 1; i <= ${N_EXPENSE}; i++) {
    insOut.run('2026-09-0' + (i % 9 + 1), i * 2.25, 'Supplies', 'row ' + i,
               (i % 11 === 0 ? 1 : null), (i % 5 === 0 ? null : (i % 3) + 1));
  }
})();

const snap = {
  income:  db.prepare('SELECT COUNT(*) AS n FROM income_entries').get().n,
  expense: db.prepare('SELECT COUNT(*) AS n FROM expense_entries').get().n,
  incomeFk:  db.pragma('foreign_key_list(income_entries)').map(f => f.from + '->' + f.table),
  expenseFk: db.pragma('foreign_key_list(expense_entries)').map(f => f.from + '->' + f.table),
  incomeIdx:  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='income_entries' ORDER BY name").all().map(r => r.name),
  expenseIdx: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='expense_entries' ORDER BY name").all().map(r => r.name),
  incomeSum:  db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(COALESCE(created_by,0)),0) AS c FROM income_entries').get(),
  expenseSum: db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(COALESCE(created_by,0)),0) AS c, COALESCE(SUM(COALESCE(po_id,0)),0) AS p FROM expense_entries').get(),
  incomeNullCb:  db.prepare('SELECT COUNT(*) AS n FROM income_entries WHERE created_by IS NULL').get().n,
  expenseNullCb: db.prepare('SELECT COUNT(*) AS n FROM expense_entries WHERE created_by IS NULL').get().n,
  firstIncome: db.prepare('SELECT * FROM income_entries ORDER BY id LIMIT 1').get(),
  lastExpense: db.prepare('SELECT * FROM expense_entries ORDER BY id DESC LIMIT 1').get(),
  v1Marker: db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'drop_created_by_user_fk_v1'").get().n,
};
process.stdout.write('@@SNAP@@' + JSON.stringify(snap));
`;

const stage1Path = path.join(SCRATCH, 'stage1.js');
fs.writeFileSync(stage1Path, stage1);
const raw = execFileSync(process.execPath, [stage1Path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const before = JSON.parse(raw.slice(raw.indexOf('@@SNAP@@') + 8));

section('Before — a populated database that still carries the FK');
eq(before.income,  N_INCOME,  'income_entries rows seeded');
eq(before.expense, N_EXPENSE, 'expense_entries rows seeded');
ok(before.incomeFk.includes('created_by->users'),  'income_entries HAS the created_by FK before');
ok(before.expenseFk.includes('created_by->users'), 'expense_entries HAS the created_by FK before');
eq(before.v1Marker, 1, 'v1 migration already ran on this database (it is a normal, up-to-date one)');

// ── stage 2 (this process): require it, which runs the migration ────────────
const db = require(path.join(SCRATCH, 'database.js'));

const after = {
  income:  db.prepare('SELECT COUNT(*) AS n FROM income_entries').get().n,
  expense: db.prepare('SELECT COUNT(*) AS n FROM expense_entries').get().n,
  incomeFk:  db.pragma('foreign_key_list(income_entries)').map(f => f.from + '->' + f.table),
  expenseFk: db.pragma('foreign_key_list(expense_entries)').map(f => f.from + '->' + f.table),
  incomeIdx:  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='income_entries' ORDER BY name").all().map(r => r.name),
  expenseIdx: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='expense_entries' ORDER BY name").all().map(r => r.name),
  incomeSum:  db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(COALESCE(created_by,0)),0) AS c FROM income_entries').get(),
  expenseSum: db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(COALESCE(created_by,0)),0) AS c, COALESCE(SUM(COALESCE(po_id,0)),0) AS p FROM expense_entries').get(),
  incomeNullCb:  db.prepare('SELECT COUNT(*) AS n FROM income_entries WHERE created_by IS NULL').get().n,
  expenseNullCb: db.prepare('SELECT COUNT(*) AS n FROM expense_entries WHERE created_by IS NULL').get().n,
  firstIncome: db.prepare('SELECT * FROM income_entries ORDER BY id LIMIT 1').get(),
  lastExpense: db.prepare('SELECT * FROM expense_entries ORDER BY id DESC LIMIT 1').get(),
};

section('After — row counts');
eq(after.income,  before.income,  'income_entries row count unchanged');
eq(after.expense, before.expense, 'expense_entries row count unchanged');

section('After — row CONTENT, not just the count');
eq(JSON.stringify(after.incomeSum),  JSON.stringify(before.incomeSum),  'income_entries id/amount/created_by sums preserved');
eq(JSON.stringify(after.expenseSum), JSON.stringify(before.expenseSum), 'expense_entries id/amount/created_by/po_id sums preserved');
eq(after.incomeNullCb,  before.incomeNullCb,  'NULL created_by rows preserved on income_entries');
eq(after.expenseNullCb, before.expenseNullCb, 'NULL created_by rows preserved on expense_entries');
eq(JSON.stringify(after.firstIncome), JSON.stringify(before.firstIncome), 'first income_entries row is byte-identical');
eq(JSON.stringify(after.lastExpense), JSON.stringify(before.lastExpense), 'last expense_entries row is byte-identical');

section('After — indexes');
eq(JSON.stringify(after.incomeIdx),  JSON.stringify(before.incomeIdx),  'income_entries indexes survived');
eq(JSON.stringify(after.expenseIdx), JSON.stringify(before.expenseIdx), 'expense_entries indexes survived');

section('After — the foreign keys');
ok(!after.incomeFk.some(f => f.endsWith('->users')),  'income_entries created_by FK is GONE');
ok(!after.expenseFk.some(f => f.endsWith('->users')), 'expense_entries created_by FK is GONE');
ok(after.expenseFk.includes('po_id->purchase_orders'), 'expense_entries KEPT po_id → purchase_orders(id)');
eq(db.pragma('foreign_key_check(income_entries)').length, 0,  'no FK violations on income_entries');
eq(db.pragma('foreign_key_check(expense_entries)').length, 0, 'no FK violations on expense_entries');
eq(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys pragma restored to ON afterwards');

section('After — reproduces the reported bug being fixed');
// A tenant_users id with no row in `users` at all — exactly a Mini App Backend
// operator posting through routes/finance-transactions.js's POST handler.
// Under the old FK this INSERT is precisely "FOREIGN KEY constraint failed".
let backendOperatorOk = true, why = '';
try {
  db.prepare("INSERT INTO income_entries (date, amount, category, description, created_by) VALUES ('2026-09-20', 296, '原材料（厨房及零售通用）', '新鲜水果', 88888)").run();
  db.prepare("INSERT INTO expense_entries (date, amount, category, description, created_by) VALUES ('2026-09-20', 296, '原材料（厨房及零售通用）', '新鲜水果', 88888)").run();
} catch (e) { backendOperatorOk = false; why = e.message; }
ok(backendOperatorOk, 'a Mini App Backend operator id with no users row is accepted' + (backendOperatorOk ? '' : ` — ${why}`));
eq(db.prepare("SELECT created_by FROM income_entries WHERE description = '新鲜水果'").get().created_by, 88888,
   'and it reads back — still a real audit value for §92 to resolve, just unenforced');

section('Idempotency, and v1 stays untouched');
eq(db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'drop_created_by_user_fk_v2'").get().n, 1,
   'v2 migration marker written exactly once');
eq(db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'drop_created_by_user_fk_v1'").get().n, 1,
   'v1 migration marker untouched by v2 running');

done();
