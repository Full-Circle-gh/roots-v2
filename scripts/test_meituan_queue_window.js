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

it('the admin queue counter counts the status the daemon writes', () => {
  assert.ok(!/status='failed'/.test(ADMIN), "nothing ever writes 'failed' — that tile read 0 forever");
  assert.match(ADMIN, /status='error'/);
  assert.match(ADMIN, /queueOldestMin/, 'a stuck queue and a busy one must not be the same number');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
