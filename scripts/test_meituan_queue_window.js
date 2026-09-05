#!/usr/bin/env node
/**
 * The Meituan stock-push drain must never starve a store it owns.
 *
 *   node scripts/test_meituan_queue_window.js
 *
 * In-memory SQLite, no network, no box.
 *
 * THE BUG THIS PINS
 * -----------------
 * meituan_sync_queue is SHARED between the 外卖 daemon (tianhe) and the 闪购
 * daemon (yuexiu). The 外卖 drain selected the 40 oldest pending rows across
 * EVERY store and only then dropped the ones it does not own:
 *
 *     WHERE status='pending' AND attempts < 3 ORDER BY created_at LIMIT 40
 *
 * That is not a filter, it is starvation. On 2026-08-22 天河 had 114 rows waiting
 * behind 137 yuexiu rows whose oldest was three days old: yuexiu filled all 40
 * slots, the 外卖 daemon skipped every one of them, the batch did nothing, and the
 * next cycle selected the identical 40. Nineteen hours with no stock push, and
 * nothing looked broken anywhere — the rows sat at attempts=0 with no last_error,
 * because they were never tried, and the admin tile called them "sending…".
 *
 * The fix filters inside the query, before the LIMIT. These tests hold the
 * difference in place: the first two demonstrate the mechanism on real SQL, the
 * rest assert the shipped code still has the property.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// A queue shaped like the live one: a big older backlog for the store this
// daemon does NOT own, and newer rows for the one it does.
function seed({ blockers = 40, mine = 5 } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE meituan_sync_queue (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             store_code TEXT NOT NULL,
             product_id INTEGER NOT NULL,
             status TEXT NOT NULL DEFAULT 'pending',
             attempts INTEGER NOT NULL DEFAULT 0,
             created_at DATETIME)`);
  const ins = db.prepare('INSERT INTO meituan_sync_queue (store_code, product_id, created_at) VALUES (?,?,?)');
  // yuexiu rows are older — three days, as on the live box.
  for (let i = 0; i < blockers; i++) ins.run('yuexiu', 1000 + i, `2026-08-19 0${i % 6}:00:00`);
  for (let i = 0; i < mine; i++)     ins.run('tianhe', 2000 + i, `2026-08-22 0${i % 6}:00:00`);
  return db;
}

const OLD_SQL = `SELECT * FROM meituan_sync_queue
                  WHERE status='pending' AND attempts < 3
                  ORDER BY created_at LIMIT 40`;
const NEW_SQL = (ph) => `SELECT * FROM meituan_sync_queue
                          WHERE status='pending' AND attempts < 3
                            AND store_code IN (${ph})
                          ORDER BY created_at LIMIT 40`;

console.log('\nmeituan stock-push drain window\n');

it('the old window is 100% rows this daemon must skip — the starvation', () => {
  const db = seed();
  const rows = db.prepare(OLD_SQL).all();
  assert.strictEqual(rows.length, 40);
  assert.ok(rows.every(r => r.store_code === 'yuexiu'), 'every slot taken by the other channel');
  assert.strictEqual(rows.filter(r => r.store_code === 'tianhe').length, 0,
    'tianhe gets no slot at all, on this cycle or any other — its rows never age out of the way');
});

it('filtering inside the query gets the owned store served immediately', () => {
  const db = seed();
  const rows = db.prepare(NEW_SQL('?')).all('tianhe');
  assert.strictEqual(rows.length, 5);
  assert.ok(rows.every(r => r.store_code === 'tianhe'));
});

it('a backlog far larger than the window still cannot crowd the owned store out', () => {
  const db = seed({ blockers: 500, mine: 12 });
  const rows = db.prepare(NEW_SQL('?')).all('tianhe');
  assert.strictEqual(rows.length, 12, '500 foreign rows, and the owned store still drains');
});

it('rows the drain already burned through are still excluded', () => {
  const db = seed({ blockers: 0, mine: 4 });
  db.prepare("UPDATE meituan_sync_queue SET attempts=3 WHERE product_id=2000").run();
  const rows = db.prepare(NEW_SQL('?')).all('tianhe');
  assert.strictEqual(rows.length, 3, 'attempts>=3 stays out of the window');
});

// ── The shipped code must actually have these properties ────────────────────
const DAEMON = fs.readFileSync(path.join(__dirname, 'meituan-daemon.js'), 'utf8');
const ADMIN  = fs.readFileSync(path.join(__dirname, '..', 'routes', 'meituan-admin.js'), 'utf8');
const SHANGOU = fs.readFileSync(path.join(__dirname, 'shangou-daemon.js'), 'utf8');

it('the daemon filters by store inside the query, before the LIMIT', () => {
  const q = DAEMON.match(/FROM meituan_sync_queue q[\s\S]*?LIMIT 40/);
  assert.ok(q, 'drain query not found');
  assert.match(q[0], /q\.store_code IN \(/, 'the window must be store-filtered in SQL, not after it');
  assert.ok(q[0].indexOf('store_code IN') < q[0].indexOf('LIMIT 40'),
    'filtering after the LIMIT is the bug, not the fix');
});

it('eligibility is resolved before the query, not per row after it', () => {
  assert.match(DAEMON, /function pushableStores\(/);
  for (const gate of ['SKIP_STORES.includes', 'isStoreOpen', 'inVerifyCooldown', 'bindingSuspected']) {
    const fn = DAEMON.match(/function pushableStores\([\s\S]*?\n}/)[0];
    assert.ok(fn.includes(gate), `pushableStores must account for ${gate}`);
  }
});

it('a queue that stops draining raises an alert on its own', () => {
  assert.match(DAEMON, /function queueStallTick\(/, 'no stock-write counterpart to the order heartbeat');
  assert.match(DAEMON, /queue_stalled/);
  assert.match(DAEMON, /queueStallTick\(stores\)/, 'the canary must actually be called from the loop');
});

it('the 闪购 daemon resolves eligibility before its LIMIT too', () => {
  // Same window, same shape of mistake available: 闪购 used to take the 40 oldest
  // rows for its stores and only then skip the ones that were closed or cooling
  // down. With one store that is invisible; the day a second 闪购 store exists, a
  // shut store's backlog owns the window and the trading one never drains.
  const q = SHANGOU.match(/FROM meituan_sync_queue q[\s\S]*?LIMIT 40/);
  assert.ok(q, 'drain query not found');
  assert.ok(q[0].indexOf('store_code IN') < q[0].indexOf('LIMIT 40'),
    'the window must be store-filtered in SQL, before the LIMIT');
  const fn = SHANGOU.match(/function pushableStores\([\s\S]*?\n}/);
  assert.ok(fn, '闪购 must resolve its pushable set up front, like 外卖');
  for (const gate of ['isStoreOpen', 'inVerifyCooldown']) {
    assert.ok(fn[0].includes(gate), `pushableStores must account for ${gate}`);
  }
  assert.ok(!/for \(const \[storeCode, items\][\s\S]{0,200}?if \(!isStoreOpen\(storeCode\)\) continue;/.test(SHANGOU),
    'the open-hours skip must not be the per-row filter after the window');
});

it('the admin queue counter counts the status the daemon writes', () => {
  assert.ok(!/status='failed'/.test(ADMIN), "nothing ever writes 'failed' — that tile read 0 forever");
  assert.match(ADMIN, /status='error'/);
  assert.match(ADMIN, /queueOldestMin/, 'a stuck queue and a busy one must not be the same number');
});

// ── Enqueue side: the queue must not grow without bound ─────────────────────
// A store that is shut is not being pushed, so every edit used to append another
// row for as long as the closure lasted. 越秀 was closed indefinitely and had 137
// rows across 3 days, climbing. Nothing is lost by collapsing them: the drain
// already keeps only the latest qty per target, and the drift sweep re-queues
// whatever actually drifted once the store opens.
const bundlesLib = require('../lib/meituan-bundles');

function enqueueDb({ active = 1 } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE meituan_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER, product_id INTEGER,
      store_code TEXT, new_qty INTEGER, status TEXT DEFAULT 'pending', meituan_name TEXT,
      bundle_id INTEGER, last_error TEXT, attempts INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE meituan_product_map (retail_store_id INTEGER, product_id INTEGER, store_code TEXT, sync_enabled INTEGER);
    CREATE TABLE retail_store_stock (store_id INTEGER, product_id INTEGER, physical_qty INTEGER);
    CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER);
    CREATE TABLE meituan_bundles (id INTEGER PRIMARY KEY, retail_store_id INTEGER, store_code TEXT, sync_enabled INTEGER, meituan_name TEXT, max_qty INTEGER);
    CREATE TABLE meituan_bundle_components (bundle_id INTEGER, product_id INTEGER, qty INTEGER);
    /* store_products, WHICH THIS FIXTURE OUTGREW.
       enqueueProductStock reaches lib/bundle-stock through lib/meituan-bundles
       now, and that reads bundle_items off store_products to answer what a ROOTS
       bundle can be assembled from — a feature that landed after this schema was
       written. The read is wrapped in a try/catch, so a missing table did not
       throw: it logged "no such table: store_products" and returned nothing,
       and five cases here failed with 0 !== 1 about queue rows, which points at
       the queue and not at the shelf underneath it.
       is_active carries its default because bundlesContaining filters on
       COALESCE(is_active, 1) — a column absent from the fixture would make every
       bundle invisible rather than error. */
    CREATE TABLE store_products (id INTEGER PRIMARY KEY, bundle_items TEXT, is_active INTEGER DEFAULT 1);
  `);
  db.prepare('INSERT INTO retail_stores (id, code, is_active) VALUES (7, ?, ?)').run('yuexiu', active);
  db.prepare('INSERT INTO meituan_product_map VALUES (7, 42, ?, 1)').run('yuexiu');
  db.prepare('INSERT INTO retail_store_stock VALUES (7, 42, 5)').run();
  return db;
}
const qcount = (db) => db.prepare("SELECT COUNT(*) n FROM meituan_sync_queue WHERE status='pending'").get().n;

it('twenty edits to one product while a store is shut leave ONE waiting row', () => {
  const db = enqueueDb();
  for (let i = 1; i <= 20; i++) {
    db.prepare('UPDATE retail_store_stock SET physical_qty=? WHERE store_id=7 AND product_id=42').run(i);
    bundlesLib.enqueueProductStock(db, 7, 42);
  }
  assert.strictEqual(qcount(db), 1, 'one row per target, not one per edit');
  assert.strictEqual(db.prepare("SELECT new_qty q FROM meituan_sync_queue").get().q, 20,
    'and it carries the LATEST quantity, not the first');
});

it('the waiting row keeps its age, so a stuck row cannot hide behind new edits', () => {
  const db = enqueueDb();
  bundlesLib.enqueueProductStock(db, 7, 42);
  db.prepare("UPDATE meituan_sync_queue SET created_at='2026-08-19 01:00:00'").run();
  bundlesLib.enqueueProductStock(db, 7, 42);
  assert.strictEqual(db.prepare('SELECT created_at c FROM meituan_sync_queue').get().c, '2026-08-19 01:00:00',
    'bumping created_at would reset the FIFO position and the stall canary age');
});

it('a row already being pushed is left alone and the new value queues behind it', () => {
  const db = enqueueDb();
  bundlesLib.enqueueProductStock(db, 7, 42);
  db.prepare("UPDATE meituan_sync_queue SET status='processing'").run();
  db.prepare('UPDATE retail_store_stock SET physical_qty=9 WHERE store_id=7 AND product_id=42').run();
  bundlesLib.enqueueProductStock(db, 7, 42);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM meituan_sync_queue WHERE status='processing'").get().n, 1);
  assert.strictEqual(qcount(db), 1, 'the in-flight push owns its value; the change needs its own row');
});

it('an inactive location enqueues nothing at all', () => {
  const db = enqueueDb({ active: 0 });
  bundlesLib.enqueueProductStock(db, 7, 42);
  assert.strictEqual(qcount(db), 0, 'a store that is not trading gets no rows nobody will push');
});

it('an unknown store still enqueues — never silently drop a real update', () => {
  const db = enqueueDb();
  db.prepare('DELETE FROM retail_stores').run();
  bundlesLib.enqueueProductStock(db, 7, 42);
  assert.strictEqual(qcount(db), 1);
});

it('bundles collapse the same way', () => {
  const db = enqueueDb();
  db.prepare("INSERT INTO meituan_bundles VALUES (3, 7, 'yuexiu', 1, 'combo', NULL)").run();
  db.prepare('INSERT INTO meituan_bundle_components VALUES (3, 42, 1)').run();
  const b = db.prepare('SELECT * FROM meituan_bundles WHERE id=3').get();
  for (let i = 0; i < 10; i++) bundlesLib.enqueueBundle(db, b);
  assert.strictEqual(qcount(db), 1);
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
