#!/usr/bin/env node
'use strict';

// Tests for lib/channel-sync-write.js — the two repairs the Channel sync page
// makes itself (§117 part two).
//
//   node scripts/test_channel_sync_write.js
//
// Touches nothing real: every case builds its own :memory: database, the same
// approach scripts/test_channel_sync_items.js takes.
//
// What is locked down, in order of how expensive it would be to learn the hard
// way:
//
//   1. GZ GROCERY'S PRE-ORDER KEY IS `gzgrocery`, NOT `guanyi`. Every other
//      surface calls that channel `guanyi`; lib/channel-publish knows it only
//      as `gzgrocery`. Get it wrong and §85's allowance is silently dropped
//      from every GZ Grocery push — which looks like nothing at all until a
//      pre-order window closes itself. Asserted against the string
//      routes/guanyi-admin.js's own push-all passes, so the two cannot drift.
//   2. A pending row is REFRESHED, never duplicated. routes/meituan-admin.js
//      carries the scar — "877 pending for 208 products" — and this button sits
//      next to a red row, so it gets pressed twice.
//   3. One push per (store, product), however many 规格 rows the product has.
//      The queue is keyed by product, not by option.
//   4. A dead error row is what the button is for: the daemon only picks up
//      `pending` (docs/meituan-findings.md #6), so the push must leave a
//      pending row behind whatever the last attempt did.
//   5. Meituan's 套餐 rows (bundle_id set, product_id NULL) are never collapsed
//      onto by a product's push.
//   6. Both writes are GATED. lib/cap-routes.js fails OPEN for a mutation it
//      does not know, so a route missing from it has no gate at all.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'lib', 'channel-sync-write'));
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(a, b, what) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`);
}
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TIANHE = 1, YUEXIU = 2, PROD = 10;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_stores (
      id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name_en TEXT, name_cn TEXT,
      is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
    INSERT INTO retail_stores (id, code, name_en, name_cn) VALUES
      (${TIANHE}, 'tianhe', 'Tianhe', '天河'), (${YUEXIU}, 'yuexiu', 'Yuexiu', '越秀');
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT, variant_label TEXT,
      variant_group_id INTEGER, is_active INTEGER DEFAULT 1, bundle_items TEXT, is_batch_made INTEGER DEFAULT 0);
    INSERT INTO store_products (id, sku, name_en) VALUES (${PROD}, 'GVF-1', 'Black Beans');
    CREATE TABLE retail_store_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      physical_qty INTEGER NOT NULL DEFAULT 0, UNIQUE(store_id, product_id));
    INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES
      (${TIANHE}, ${PROD}, 7), (${YUEXIU}, ${PROD}, 3);
    CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);

    CREATE TABLE meituan_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, retail_store_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, meituan_name TEXT, sync_enabled INTEGER NOT NULL DEFAULT 1,
      spec_key TEXT NOT NULL DEFAULT '', units_per_pack INTEGER NOT NULL DEFAULT 1,
      last_pushed_qty INTEGER, last_pushed_at DATETIME);
    CREATE TABLE meituan_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER,
      bundle_id INTEGER, store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME);

    CREATE TABLE eleme_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, eleme_name TEXT, spec_key TEXT NOT NULL DEFAULT '',
      units_per_pack INTEGER NOT NULL DEFAULT 1, sync_enabled INTEGER NOT NULL DEFAULT 1,
      last_pushed_qty INTEGER, last_pushed_at DATETIME);
    CREATE TABLE eleme_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME);

    CREATE TABLE guanyi_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, guanyi_name TEXT, guanyi_sku_id TEXT,
      sync_enabled INTEGER NOT NULL DEFAULT 1, last_pushed_qty INTEGER, last_pushed_at DATETIME,
      UNIQUE(retail_store_id, product_id));
    CREATE TABLE guanyi_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME);
  `);
  return db;
}
const mtMap = (db, storeId, code, sync = 1, spec = '') => db.prepare(
  `INSERT INTO meituan_product_map (product_id, retail_store_id, store_code, meituan_name, sync_enabled, spec_key)
   VALUES (?, ?, ?, 'Black Beans', ?, ?)`).run(PROD, storeId, code, sync, spec);
const queue = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();

// ── 1. the switch ────────────────────────────────────────────────────────────
section('1 · the switch');

check('turning sync off writes every one of the product’s map rows', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe'); mtMap(db, YUEXIU, 'yuexiu');
  const r = W.setSync(db, 'meituan', PROD, false);
  eq(r.ok, true, 'ok'); eq(r.rows, 2, 'rows'); eq(r.on, false, 'on');
  eq(db.prepare('SELECT COUNT(*) n FROM meituan_product_map WHERE sync_enabled = 1').get().n, 0, 'still enabled');
});

check('a named store is the only one touched', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe'); mtMap(db, YUEXIU, 'yuexiu');
  eq(W.setSync(db, 'meituan', PROD, false, 'tianhe').rows, 1, 'rows');
  eq(db.prepare("SELECT sync_enabled e FROM meituan_product_map WHERE store_code='yuexiu'").get().e, 1, 'yuexiu moved');
});

check('every 规格 row of the same store moves together', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe', 1, ''); mtMap(db, TIANHE, 'tianhe', 1, 'large');
  eq(W.setSync(db, 'meituan', PROD, false).rows, 2, 'rows');
});

check('an unmapped product is refused, not silently done', () => {
  const db = freshDb();
  eq(W.setSync(db, 'meituan', PROD, true), { ok: false, code: 'not_mapped' }, 'result');
});

check('an unknown channel cannot reach a table name', () => {
  const db = freshDb();
  eq(W.setSync(db, 'nope', PROD, true).code, 'unknown_channel', 'channel');
  eq(W.pushNow(db, 'nope', PROD).code, 'unknown_channel', 'channel');
  // The channel key reaches SQL as a table name, so anything not in the table
  // must be refused before it gets there rather than escaped on the way.
  eq(W.pushNow(db, 'meituan_product_map; DROP TABLE store_products; --', PROD).code, 'unknown_channel', 'injection');
  ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='store_products'").get(), 'products table survived');
});

check('a product id that is not a number is refused', () => {
  const db = freshDb();
  eq(W.setSync(db, 'meituan', 'abc', true).code, 'bad_product', 'setSync');
  eq(W.pushNow(db, 'meituan', 'abc').code, 'bad_product', 'pushNow');
});

// ── 2. the push ──────────────────────────────────────────────────────────────
section('2 · the push');

check('one queue row per mapped, switched-on store, carrying the shelf count', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe'); mtMap(db, YUEXIU, 'yuexiu');
  const r = W.pushNow(db, 'meituan', PROD);
  eq(r.ok, true, 'ok'); eq(r.queued, 2, 'queued'); eq(r.refreshed, 0, 'refreshed');
  const q = queue(db, 'meituan_sync_queue');
  eq(q.length, 2, 'rows');
  eq(q.map(x => [x.store_code, x.new_qty, x.status]),
     [['tianhe', 7, 'pending'], ['yuexiu', 3, 'pending']], 'contents');
});

check('a store whose switch is off is not pushed', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe', 1); mtMap(db, YUEXIU, 'yuexiu', 0);
  eq(W.pushNow(db, 'meituan', PROD).queued, 1, 'queued');
  eq(queue(db, 'meituan_sync_queue').map(x => x.store_code), ['tianhe'], 'stores');
});

check('three 规格 claims at one store are ONE push, not three', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe', 1, ''); mtMap(db, TIANHE, 'tianhe', 1, 'large'); mtMap(db, TIANHE, 'tianhe', 1, 'xl');
  eq(W.pushNow(db, 'meituan', PROD).queued, 1, 'queued');
  eq(queue(db, 'meituan_sync_queue').length, 1, 'rows');
});

check('pressing it twice refreshes the pending row rather than duplicating it', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe');
  W.pushNow(db, 'meituan', PROD);
  db.prepare('UPDATE retail_store_stock SET physical_qty = 99 WHERE store_id = ? AND product_id = ?').run(TIANHE, PROD);
  const r = W.pushNow(db, 'meituan', PROD);
  eq([r.queued, r.refreshed], [0, 1], 'second press');
  const q = queue(db, 'meituan_sync_queue');
  eq(q.length, 1, 'still one row');
  eq(q[0].new_qty, 99, 'and it carries the new count');
});

check('a dead error row is not refreshed — a fresh pending row is added beside it', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe');
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status, last_error)
              VALUES (?, ?, 'tianhe', 4, 'error', 'Meituan refused it')`).run(TIANHE, PROD);
  const r = W.pushNow(db, 'meituan', PROD);
  eq(r.queued, 1, 'queued');
  const q = queue(db, 'meituan_sync_queue');
  eq(q.length, 2, 'rows');
  eq(q[1].status, 'pending', 'the newest row is pending');
  // The verdict reads the LATEST row per (store, product), so this is what
  // takes the item out of "needs attention".
  ok(q[1].id > q[0].id, 'the pending row is the newest');
});

check('refreshing a pending row clears the error it was carrying', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe');
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status, last_error)
              VALUES (?, ?, 'tianhe', 4, 'pending', 'timed out once')`).run(TIANHE, PROD);
  W.pushNow(db, 'meituan', PROD);
  eq(queue(db, 'meituan_sync_queue')[0].last_error, null, 'last_error');
});

/* The 套餐 guard is BELT AND BRACES and this case says so rather than
   pretending otherwise. A bundle row as the app writes it carries bundle_id
   with a NULL product_id, so `AND product_id = ?` misses it on its own and the
   guard changes nothing. What the guard buys is the row below: a bundle row
   that ALSO carries the product it was built from — not a shape anything
   writes today, and exactly the shape a later change would introduce without
   noticing. lib/meituan-bundles.js's own refreshPending carries the same guard
   for the same reason. */
check('a 套餐 row is never collapsed onto, even when it names the product too', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe');
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, bundle_id, store_code, new_qty, status)
              VALUES (?, ?, 3, 'tianhe', 5, 'pending')`).run(TIANHE, PROD);
  const r = W.pushNow(db, 'meituan', PROD);
  eq([r.queued, r.refreshed], [1, 0], 'the product got its own row, the bundle was left alone');
  const q = queue(db, 'meituan_sync_queue');
  eq(q.length, 2, 'the bundle row survived alongside a new product row');
  eq([q[0].bundle_id, q[0].new_qty], [3, 5], 'the bundle row was not overwritten');
});

check('a plain bundle row (no product_id) is untouched as well', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe');
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, bundle_id, store_code, new_qty, status)
              VALUES (?, NULL, 3, 'tianhe', 5, 'pending')`).run(TIANHE);
  W.pushNow(db, 'meituan', PROD);
  const q = queue(db, 'meituan_sync_queue');
  eq(q.length, 2, 'rows');
  eq(q[0].new_qty, 5, 'the bundle row was not overwritten');
});

check('a product mapped but switched off everywhere is refused', () => {
  const db = freshDb();
  mtMap(db, TIANHE, 'tianhe', 0);
  eq(W.pushNow(db, 'meituan', PROD), { ok: false, code: 'not_syncing' }, 'result');
  eq(queue(db, 'meituan_sync_queue').length, 0, 'nothing queued');
});

check('Eleme and GZ Grocery queue through the same rule', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO eleme_product_map (retail_store_id, product_id, store_code, eleme_name, sync_enabled)
              VALUES (?, ?, 'tianhe', 'Black Beans', 1)`).run(TIANHE, PROD);
  db.prepare(`INSERT INTO guanyi_product_map (retail_store_id, product_id, store_code, guanyi_sku_id, sync_enabled)
              VALUES (?, ?, 'tianhe', 'SKU9', 1)`).run(TIANHE, PROD);
  eq(W.pushNow(db, 'eleme', PROD).queued, 1, 'eleme queued');
  eq(W.pushNow(db, 'guanyi', PROD).queued, 1, 'guanyi queued');
  eq(queue(db, 'eleme_sync_queue')[0].new_qty, 7, 'eleme qty');
  eq(queue(db, 'guanyi_sync_queue')[0].new_qty, 7, 'guanyi qty');
  eq(W.pushNow(db, 'eleme', PROD).refreshed, 1, 'eleme refreshes rather than duplicates');
  eq(W.pushNow(db, 'guanyi', PROD).refreshed, 1, 'guanyi refreshes rather than duplicates');
});

// ── 3. the key that is not the channel's name ────────────────────────────────
section('3 · GZ Grocery’s pre-order key');

check('guanyi publishes as `gzgrocery`, the string its own push-all passes', () => {
  eq(W.CHANNELS.guanyi.publishKey, 'gzgrocery', 'publishKey');
  // Pinned to the route rather than to a literal repeated here: if GZ Grocery's
  // own push-all ever changes the string, this fails instead of the two
  // silently disagreeing about which channel the pre-order window belongs to.
  const src = read('routes/guanyi-admin.js');
  const m = src.match(/publishableAt\([^)]*channel:\s*'([a-z]+)'/);
  ok(m, 'guanyi push-all no longer names a channel to channelPublish');
  eq(m[1], W.CHANNELS.guanyi.publishKey, 'the two disagree about GZ Grocery’s publish key');
});

check('meituan and eleme publish under their own names', () => {
  eq(W.CHANNELS.meituan.publishKey, 'meituan', 'meituan');
  eq(W.CHANNELS.eleme.publishKey, 'eleme', 'eleme');
});

check('only Meituan claims a bundle column, because only Meituan has one', () => {
  eq([W.CHANNELS.meituan.bundleColumn, W.CHANNELS.eleme.bundleColumn, W.CHANNELS.guanyi.bundleColumn],
     [true, false, false], 'bundleColumn');
});

// ── 4. both writes are gated ─────────────────────────────────────────────────
section('4 · the gate');

check('push answers {channel}:sync and the switch answers {channel}:map', () => {
  for (const ch of ['meituan', 'eleme', 'guanyi']) {
    eq(requiredCapFor('POST', `/api/retail-admin/channel-sync/${ch}/products/12/push`), `${ch}:sync`, `${ch} push`);
    eq(requiredCapFor('POST', `/api/retail-admin/channel-sync/${ch}/products/12/sync`), `${ch}:map`, `${ch} sync`);
  }
});

check('the read stays open, so no dashboard or picker can 403 on it', () => {
  eq(requiredCapFor('GET', '/api/retail-admin/channel-sync'), null, 'GET');
});

check('every capability the gate names is a real one', () => {
  const caps = new Set(require(path.join(ROOT, 'lib', 'capabilities')).CAPABILITIES.map(c => c.key));
  for (const ch of ['meituan', 'eleme', 'guanyi']) {
    for (const v of ['sync', 'map']) ok(caps.has(`${ch}:${v}`), `${ch}:${v} is not a capability`);
  }
});

// ── 5. the page ──────────────────────────────────────────────────────────────
section('5 · what the page does and does not do itself');

check('the Channel sync page calls both writes', () => {
  const src = read('public/retail-admin/29-channel-sync.js');
  ok(/window\.csSetSync\s*=/.test(src), 'csSetSync is not exported');
  ok(/window\.csPushNow\s*=/.test(src), 'csPushNow is not exported');
  ok(/channel-sync\/'\s*\+\s*encodeURIComponent\(chKey\)/.test(src), 'the channel key reaches the URL unescaped');
  ok(/'立即同步'/.test(src) && /'同步开关'/.test(src), 'the two live pairs are not on the buttons');
});

// THE LINE §117 DREW. Naming a listing and claiming a 规格 need the channel's
// own catalogue picker; faking either here would put the channels' differences
// back on the one page that exists to take them off it.
check('the page does NOT try to name a listing or claim an option itself', () => {
  const src = read('public/retail-admin/29-channel-sync.js');
  ok(!/products\/'\s*\+[^;]*\/map/.test(src) && !/\/claim/.test(src),
     'the page has started calling a channel’s /map or /claim');
  ok(/csFix\(/.test(src), 'the way out to the channel’s own tab is gone');
});

check('the switch is the channel panels’ switch, not a second one', () => {
  ok(/class="toggle-label"/.test(read('public/retail-admin/29-channel-sync.js')),
     'the card mints its own switch class');
  const css = read('public/retail-admin.css');
  /* EVERY rule in the switch group carries all three halves AT THE SAME SUFFIX.
     Asserted one suffix at a time rather than by a "did anything break" regex,
     because widening this group by hand once produced
     `.el-panel .toggle-label, #tab-… .toggle-label input` — the Eleme half
     stripped back to the bare label while the new half kept ` input`, which
     would have styled the label itself as the switch track. A per-suffix check
     names which rule lost its half; a blanket one only says something did. */
  for (const sfx of ['', ' input', ' input::after', ' input:checked',
                     ' input:checked::after', ' input:focus-visible']) {
    const want = `.mt-panel .toggle-label${sfx}, .el-panel .toggle-label${sfx}, ` +
                 `#tab-channel-sync .cs-dcard .toggle-label${sfx} {`;
    ok(css.includes(want), `the switch rule for "${sfx || '(no suffix)'}" is not shared three ways`);
  }
});

check('the refusals are worded from the shared table, not composed on the page', () => {
  const core = read('public/retail-admin/01-core.js');
  for (const code of ['not_mapped', 'not_syncing']) {
    ok(new RegExp(`\\n\\s*${code}:\\s*\\[`).test(core), `${code} has no sentence in TD_ERR`);
  }
  // Both carry row_moved's pair verbatim — same fact, so the same words.
  const pair = "['Somebody else changed this while you had it open — reload and try again.', '该记录已被他人修改,请刷新后重试。']";
  eq((core.match(new RegExp(pair.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 3,
     'row_moved, not_mapped and not_syncing should share one pair');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
