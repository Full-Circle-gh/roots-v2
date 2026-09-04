#!/usr/bin/env node
// drop_created_by_user_fk_v1 — rebuild restock_orders + production_batches
// without the created_by → users(id) foreign key, losing nothing.
//
// WHAT THIS PROVES, AND WHY IT NEEDS TWO PROCESSES
// ------------------------------------------------
// The migration only does anything on a database that still HAS the FK, and
// database.js runs its migrations at require time, once per process. So stage 1
// builds a pre-migration database in a child process — a real, fully-migrated
// database.js database, then rebuilt to put the FK back and the migration
// marker removed, then populated. Stage 2 is this process requiring that same
// file, which fires the migration for real against populated data.
//
// That stands in for "run it against a copy of live Roots data": this checkout
// carries no database, so the closest honest equivalent is a database built by
// the same schema.sql and the same migration chain, with rows in it.
//
// The assertions are the ones that matter for a table rebuild:
//   * every row survives, and its VALUES survive (not just the count)
//   * explicit indexes come back; the auto-index behind rs_number UNIQUE does too
//   * the created_by FK is gone from both tables
//   * production_batches KEEPS recipe_id → recipes(id) — that table is
//     data-plane and cloned per tenant, so that FK resolves fine
//   * the column still exists and still accepts writes, including a value with
//     no matching users row, which is the whole point
//   * re-running is a no-op
//
// Run:  npm run test:created-by-fk
'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const F = require('./test-support/tenant-fixture');
const { ok, eq, section, done } = F.counters();

const SCRATCH = path.join(REPO, `.fkmig-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(REPO, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(REPO, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(REPO, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

const N_ORDERS = 250;
const N_ITEMS  = 400;
const N_BATCH  = 180;

// ── stage 1 (child process): a populated database that still has the FK ─────
// Re-adds the FK by the same rebuild mechanic the migration uses in reverse, so
// the starting state is exactly the shape a deployed database is in today.
const stage1 = `
'use strict';
const db = require(${JSON.stringify(path.join(SCRATCH, 'database.js'))});
db.pragma('foreign_keys = OFF');
db.pragma('legacy_alter_table = ON');
const readd = (t, fkSql) => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t).map(r => r.sql);
  // Put the FK back as the last table constraint.
  const withFk = sql.replace(/\\n?\\)\\s*$/, ',\\n  ' + fkSql + '\\n)');
  const tmp = '_pre_' + t;
  db.exec(withFk.replace(new RegExp('(CREATE\\\\s+TABLE\\\\s+)' + t), '$1' + tmp));
  db.exec('INSERT INTO ' + tmp + ' SELECT * FROM ' + t);
  db.exec('DROP TABLE ' + t);
  db.exec('ALTER TABLE ' + tmp + ' RENAME TO ' + t);
  for (const s of idx) db.exec(s);
};
readd('restock_orders',     'FOREIGN KEY (created_by) REFERENCES users(id)');
readd('production_batches', 'FOREIGN KEY (created_by) REFERENCES users(id)');
db.prepare("DELETE FROM _migrations WHERE name = 'drop_created_by_user_fk_v1'").run();
db.pragma('legacy_alter_table = OFF');
db.pragma('foreign_keys = ON');

// Users the FK can actually point at, plus NULLs, plus a recipe for the kept FK.
for (const id of [1, 2, 3]) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, role) VALUES (?,?,?,?)')
    .run(id, 'u' + id, 'x', 'kitchen');
}
db.prepare("INSERT INTO recipes (id, name_en, sku) VALUES (9001,'Batch Recipe','R-9001')").run();
// restock_items.product_id → products(id), so the line items need real products.
for (let p = 900; p <= 904; p++) {
  db.prepare('INSERT INTO products (id, name_en, sku) VALUES (?,?,?)').run(p, 'P' + p, 'SKU-P' + p);
}

const insO = db.prepare('INSERT INTO restock_orders (rs_number, date, status, store_name, created_by, from_role, to_role) VALUES (?,?,?,?,?,?,?)');
const insI = db.prepare('INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested) VALUES (?,?,?,?,?)');
const insB = db.prepare('INSERT INTO production_batches (date, recipe_id, recipe_name, recipe_sku, batches_made, servings_made, staff_name, created_by) VALUES (?,?,?,?,?,?,?,?)');
db.transaction(() => {
  for (let i = 1; i <= ${N_ORDERS}; i++) {
    insO.run('RS-FIX-' + String(i).padStart(4,'0'), '2026-09-0' + (i % 9 + 1),
             ['draft','sent','received','prepared','delivered'][i % 5],
             'Shop ' + (i % 4), (i % 7 === 0 ? null : (i % 3) + 1), 'warehouse', 'store');
  }
  for (let i = 1; i <= ${N_ITEMS}; i++) {
    insI.run((i % ${N_ORDERS}) + 1, 900 + (i % 5), 'Item ' + i, 'SKU-' + i, (i % 20) + 1);
  }
  for (let i = 1; i <= ${N_BATCH}; i++) {
    insB.run('2026-09-0' + (i % 9 + 1), 9001, 'Batch Recipe', 'R-9001',
             (i % 6) + 1, ((i % 6) + 1) * 10, 'staff' + (i % 3), (i % 5 === 0 ? null : (i % 3) + 1));
  }
})();

const snap = {
  orders:  db.prepare('SELECT COUNT(*) AS n FROM restock_orders').get().n,
  items:   db.prepare('SELECT COUNT(*) AS n FROM restock_items').get().n,
  batches: db.prepare('SELECT COUNT(*) AS n FROM production_batches').get().n,
  ordersFk:  db.pragma('foreign_key_list(restock_orders)').map(f => f.from + '->' + f.table),
  batchesFk: db.pragma('foreign_key_list(production_batches)').map(f => f.from + '->' + f.table),
  ordersIdx:  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='restock_orders' ORDER BY name").all().map(r => r.name),
  batchesIdx: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='production_batches' ORDER BY name").all().map(r => r.name),
  // Content fingerprints, so this proves the ROWS survived and not just a count.
  ordersSum:  db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(COALESCE(created_by,0)),0) AS c, COUNT(DISTINCT rs_number) AS u FROM restock_orders').get(),
  batchesSum: db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(batches_made),0) AS b, COALESCE(SUM(COALESCE(created_by,0)),0) AS c FROM production_batches').get(),
  ordersNullCb:  db.prepare('SELECT COUNT(*) AS n FROM restock_orders WHERE created_by IS NULL').get().n,
  batchesNullCb: db.prepare('SELECT COUNT(*) AS n FROM production_batches WHERE created_by IS NULL').get().n,
  firstOrder: db.prepare('SELECT * FROM restock_orders ORDER BY id LIMIT 1').get(),
  lastBatch:  db.prepare('SELECT * FROM production_batches ORDER BY id DESC LIMIT 1').get(),
};
process.stdout.write('@@SNAP@@' + JSON.stringify(snap));
`;

const stage1Path = path.join(SCRATCH, 'stage1.js');
fs.writeFileSync(stage1Path, stage1);
const raw = execFileSync(process.execPath, [stage1Path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const before = JSON.parse(raw.slice(raw.indexOf('@@SNAP@@') + 8));

section('Before — a populated database that still carries the FK');
eq(before.orders,  N_ORDERS, 'restock_orders rows seeded');
eq(before.items,   N_ITEMS,  'restock_items rows seeded');
eq(before.batches, N_BATCH,  'production_batches rows seeded');
ok(before.ordersFk.includes('created_by->users'),  'restock_orders HAS the created_by FK before');
ok(before.batchesFk.includes('created_by->users'), 'production_batches HAS the created_by FK before');
ok(before.batchesFk.includes('recipe_id->recipes'), 'production_batches HAS the recipe_id FK before');
console.log('    restock_orders indexes before:     ' + JSON.stringify(before.ordersIdx));
console.log('    production_batches indexes before: ' + JSON.stringify(before.batchesIdx));

// ── stage 2 (this process): require it, which runs the migration ────────────
const db = require(path.join(SCRATCH, 'database.js'));

const after = {
  orders:  db.prepare('SELECT COUNT(*) AS n FROM restock_orders').get().n,
  items:   db.prepare('SELECT COUNT(*) AS n FROM restock_items').get().n,
  batches: db.prepare('SELECT COUNT(*) AS n FROM production_batches').get().n,
  ordersFk:  db.pragma('foreign_key_list(restock_orders)').map(f => f.from + '->' + f.table),
  batchesFk: db.pragma('foreign_key_list(production_batches)').map(f => f.from + '->' + f.table),
  ordersIdx:  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='restock_orders' ORDER BY name").all().map(r => r.name),
  batchesIdx: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='production_batches' ORDER BY name").all().map(r => r.name),
  ordersSum:  db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(COALESCE(created_by,0)),0) AS c, COUNT(DISTINCT rs_number) AS u FROM restock_orders').get(),
  batchesSum: db.prepare('SELECT COALESCE(SUM(id),0) AS s, COALESCE(SUM(batches_made),0) AS b, COALESCE(SUM(COALESCE(created_by,0)),0) AS c FROM production_batches').get(),
  ordersNullCb:  db.prepare('SELECT COUNT(*) AS n FROM restock_orders WHERE created_by IS NULL').get().n,
  batchesNullCb: db.prepare('SELECT COUNT(*) AS n FROM production_batches WHERE created_by IS NULL').get().n,
  firstOrder: db.prepare('SELECT * FROM restock_orders ORDER BY id LIMIT 1').get(),
  lastBatch:  db.prepare('SELECT * FROM production_batches ORDER BY id DESC LIMIT 1').get(),
};

section('After — row counts');
eq(after.orders,  before.orders,  'restock_orders row count unchanged');
eq(after.items,   before.items,   'restock_items row count unchanged (not rebuilt, must be untouched)');
eq(after.batches, before.batches, 'production_batches row count unchanged');

section('After — row CONTENT, not just the count');
eq(JSON.stringify(after.ordersSum),  JSON.stringify(before.ordersSum),  'restock_orders id/created_by sums + rs_number uniqueness preserved');
eq(JSON.stringify(after.batchesSum), JSON.stringify(before.batchesSum), 'production_batches id/batches_made/created_by sums preserved');
eq(after.ordersNullCb,  before.ordersNullCb,  'NULL created_by rows preserved on restock_orders');
eq(after.batchesNullCb, before.batchesNullCb, 'NULL created_by rows preserved on production_batches');
eq(JSON.stringify(after.firstOrder), JSON.stringify(before.firstOrder), 'first restock_orders row is byte-identical');
eq(JSON.stringify(after.lastBatch),  JSON.stringify(before.lastBatch),  'last production_batches row is byte-identical');

section('After — indexes');
eq(JSON.stringify(after.ordersIdx),  JSON.stringify(before.ordersIdx),  'restock_orders indexes survived');
eq(JSON.stringify(after.batchesIdx), JSON.stringify(before.batchesIdx), 'production_batches indexes survived');
console.log('    restock_orders indexes after:     ' + JSON.stringify(after.ordersIdx));
console.log('    production_batches indexes after: ' + JSON.stringify(after.batchesIdx));
// The auto-index is what enforces rs_number UNIQUE — prove the constraint still bites.
let dupRejected = false;
try {
  const n = db.prepare('SELECT rs_number FROM restock_orders LIMIT 1').get().rs_number;
  db.prepare("INSERT INTO restock_orders (rs_number, date) VALUES (?, '2026-09-02')").run(n);
} catch { dupRejected = true; }
ok(dupRejected, 'rs_number UNIQUE still enforced after the rebuild');

section('After — the foreign keys');
ok(!after.ordersFk.some(f => f.endsWith('->users')),  'restock_orders created_by FK is GONE');
ok(!after.batchesFk.some(f => f.endsWith('->users')), 'production_batches created_by FK is GONE');
ok(after.batchesFk.includes('recipe_id->recipes'),    'production_batches KEPT recipe_id → recipes(id)');
eq(db.pragma('foreign_key_check(restock_orders)').length, 0,     'no FK violations on restock_orders');
eq(db.pragma('foreign_key_check(production_batches)').length, 0, 'no FK violations on production_batches');
eq(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys pragma restored to ON afterwards');

section('After — the column still works, including a dangling actor id');
eq(db.pragma('table_info(restock_orders)').filter(c => c.name === 'created_by').length, 1,
   'restock_orders.created_by column still exists');
eq(db.pragma('table_info(production_batches)').filter(c => c.name === 'created_by').length, 1,
   'production_batches.created_by column still exists');
// 99999 has no users row. Under the old FK this was rejected; that rejection is
// exactly what broke tenant operators, whose ids live in tenant_users.
let danglingOk = true, why = '';
try {
  db.prepare("INSERT INTO restock_orders (rs_number, date, created_by) VALUES ('RS-DANGLE','2026-09-02', 99999)").run();
  db.prepare("INSERT INTO production_batches (date, recipe_name, batches_made, created_by) VALUES ('2026-09-02','X',1, 99999)").run();
} catch (e) { danglingOk = false; why = e.message; }
ok(danglingOk, 'an actor id with no users row is accepted' + (danglingOk ? '' : ` — ${why}`));
eq(db.prepare("SELECT created_by FROM restock_orders WHERE rs_number = 'RS-DANGLE'").get().created_by, 99999,
   'and it reads back — still a real audit value, just unenforced');

section('Idempotency');
eq(db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'drop_created_by_user_fk_v1'").get().n, 1,
   'migration marker written exactly once');

done();
