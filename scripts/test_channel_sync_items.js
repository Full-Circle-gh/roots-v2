#!/usr/bin/env node
'use strict';

// Tests for lib/channel-sync-items.js — one verdict per item per channel (§103).
//
//   node scripts/test_channel_sync_items.js
//
// Touches nothing real: every case builds its own :memory: database. The
// tables are the SHAPE the module reads, cut down to the columns it touches —
// the same approach scripts/test_channel_drift_sweep.js takes, and the same
// warning: a column the module reads that this DDL lacks fails here rather
// than passing quietly.
//
// What is locked down, in order of how expensive it was to learn:
//
//   1. A mapped, switched-on row whose latest push FAILED reads `att`, not
//      Synced. This is the F4 row (docs/channel-mapping-findings.md): 196
//      failures on one product, green dot throughout.
//   2. A row the platform holds a different number for reads `att` even with
//      no queue row at all — the number a customer sees is wrong NOW, whatever
//      the sweep will do about it in two hours.
//   3. A push in flight reads `ok`/sending whatever its age: the channel's
//      card carries the stall, not forty items.
//   4. No mapping is `none`, quiet; sync off is `off`, quiet; an unread
//      catalogue is `unk`, not amber.
//   5. Worst store wins per channel; worst channel wins per item.
//   6. A store not trading on a channel is out of scope entirely.

const Database = require('better-sqlite3');
const mod = require('../lib/channel-sync-items');
const { channelSyncItems, channelSyncSummary } = mod;

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }

// ── Fixture ──────────────────────────────────────────────────────────────────

const TIANHE = 1, YUEXIU = 2;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_stores (
      id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name_en TEXT, name_cn TEXT,
      is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
      open_time TEXT, close_time TEXT, sync_start_time TEXT);
    INSERT INTO retail_stores (id, code, name_en, name_cn) VALUES
      (${TIANHE}, 'tianhe', 'Tianhe', '天河'), (${YUEXIU}, 'yuexiu', 'Yuexiu', '越秀');
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT, variant_label TEXT,
      variant_group_id INTEGER, is_active INTEGER DEFAULT 1, bundle_items TEXT, is_batch_made INTEGER DEFAULT 0);
    CREATE TABLE retail_store_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      physical_qty INTEGER NOT NULL DEFAULT 0, UNIQUE(store_id, product_id));
    -- lib/store-trading.js reads these two; absent rows mean "trading".
    CREATE TABLE channel_status (channel TEXT, store_code TEXT, is_open INTEGER, PRIMARY KEY (channel, store_code));
    CREATE TABLE store_business_status (store_code TEXT PRIMARY KEY, is_open INTEGER, target_open INTEGER, fulfillment_open INTEGER);
    CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);

    CREATE TABLE meituan_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT NOT NULL,
      listing_name TEXT NOT NULL, scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(store_code, listing_name));
    CREATE TABLE meituan_listing_specs (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, listing_name TEXT,
      spec TEXT, sku_code TEXT, sku_id TEXT);
    CREATE TABLE meituan_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, retail_store_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, meituan_name TEXT, sync_enabled INTEGER NOT NULL DEFAULT 1,
      spec_key TEXT NOT NULL DEFAULT '', units_per_pack INTEGER NOT NULL DEFAULT 1,
      meituan_sku_id TEXT, meituan_spec TEXT, last_pushed_qty INTEGER, last_pushed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE meituan_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER,
      bundle_id INTEGER, store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME);
    CREATE TABLE meituan_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, event_type TEXT,
      status TEXT, detail TEXT, error_msg TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

    CREATE TABLE eleme_shops (id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, shop_id TEXT, shop_name TEXT, UNIQUE(retail_store_id));
    CREATE TABLE eleme_catalogue_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT NOT NULL,
      name TEXT NOT NULL, item_global_id TEXT, stock INTEGER, specs TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(store_code, name));
    CREATE TABLE eleme_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, extend_code TEXT, eleme_name TEXT, item_id TEXT, spec_id TEXT, spec_name TEXT,
      last_pushed_qty INTEGER, last_pushed_at DATETIME, sync_enabled INTEGER NOT NULL DEFAULT 1,
      units_per_pack INTEGER NOT NULL DEFAULT 1, spec_key TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE eleme_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME);
    CREATE TABLE eleme_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, event_type TEXT,
      status TEXT, detail TEXT, error_msg TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

    CREATE TABLE guanyi_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT NOT NULL,
      guanyi_name TEXT NOT NULL, code TEXT, sku_id TEXT, current_qty INTEGER,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(store_code, sku_id));
    CREATE TABLE guanyi_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, guanyi_name TEXT, guanyi_code TEXT, guanyi_sku_id TEXT,
      last_pushed_qty INTEGER, last_delta INTEGER, last_pushed_at DATETIME,
      sync_enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(retail_store_id, product_id));
    CREATE TABLE guanyi_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, new_qty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME);
    CREATE TABLE guanyi_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, event_type TEXT,
      status TEXT, detail TEXT, error_msg TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  return db;
}

function product(db, id, { stock = 10, name = `Product ${id}`, sku = `SKU-${id}`, stores = [TIANHE] } = {}) {
  db.prepare('INSERT INTO store_products (id, sku, name_cn, name_en) VALUES (?, ?, ?, ?)').run(id, sku, `商品${id}`, name);
  for (const s of stores) {
    db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, ?)').run(s, id, stock);
  }
}
function mtCatalogue(db, store, names) {
  for (const n of names) db.prepare('INSERT OR IGNORE INTO meituan_listings (store_code, listing_name) VALUES (?, ?)').run(store, n);
}
function mtMap(db, pid, { store = 'tianhe', storeId = TIANHE, name = `听装${pid}`, on = 1, pushed = null, ago = 1, units = 1, specKey = '' } = {}) {
  db.prepare(`INSERT INTO meituan_product_map
      (product_id, retail_store_id, store_code, meituan_name, sync_enabled, spec_key, units_per_pack, last_pushed_qty, last_pushed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${pushed == null ? 'NULL' : "datetime('now', ?)"})`)
    .run(...[pid, storeId, store, name, on, specKey, units, pushed].concat(pushed == null ? [] : [`-${ago} hours`]));
}
function mtQueue(db, pid, { store = 'tianhe', storeId = TIANHE, status = 'pending', err = null, ago = 0 } = {}) {
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status, last_error, created_at)
              VALUES (?, ?, ?, 0, ?, ?, datetime('now', ?))`).run(storeId, pid, store, status, err, `-${ago} minutes`);
}
function elShop(db, storeId = TIANHE, store = 'tianhe') {
  db.prepare('INSERT INTO eleme_shops (retail_store_id, store_code, shop_id) VALUES (?, ?, ?)').run(storeId, store, 'shop-1');
}
function elCatalogue(db, store, entries) {
  for (const [n, specs] of entries) {
    db.prepare('INSERT OR IGNORE INTO eleme_catalogue_cache (store_code, name, specs) VALUES (?, ?, ?)')
      .run(store, n, specs ? JSON.stringify(specs) : null);
  }
}
function elMap(db, pid, { store = 'tianhe', storeId = TIANHE, name = `饿${pid}`, on = 1, pushed = null, units = 1, specKey = '' } = {}) {
  db.prepare(`INSERT INTO eleme_product_map
      (retail_store_id, product_id, store_code, eleme_name, sync_enabled, spec_key, units_per_pack, last_pushed_qty, last_pushed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${pushed == null ? 'NULL' : "datetime('now', '-1 hours')"})`)
    .run(storeId, pid, store, name, on, specKey, units, pushed);
}
function gyMap(db, pid, { on = 1, pushed = null, skuId = `gy-${pid}` } = {}) {
  db.prepare(`INSERT INTO guanyi_product_map (retail_store_id, product_id, store_code, guanyi_sku_id, sync_enabled, last_pushed_qty, last_pushed_at)
              VALUES (?, ?, 'tianhe', ?, ?, ?, ${pushed == null ? 'NULL' : "datetime('now', '-1 hours')"})`)
    .run(TIANHE, pid, skuId, on, pushed);
}
function gyQueue(db, pid, { status = 'pending', err = null } = {}) {
  db.prepare(`INSERT INTO guanyi_sync_queue (retail_store_id, product_id, store_code, new_qty, status, last_error)
              VALUES (?, ?, 'tianhe', 0, ?, ?)`).run(TIANHE, pid, status, err);
}
const cell = (r, pid, ch) => r.items.find(i => i.id === pid).channels[ch];
const worst = (r, pid) => r.items.find(i => i.id === pid).worst;

// ── 1. The verdict on a single Meituan row ───────────────────────────────────
section('1 · Meituan: the states, one change at a time');

check('no mapping → none / no_map, and the item is "not listed" everywhere', () => {
  const db = freshDb(); product(db, 1);
  const r = channelSyncItems(db);
  eq(cell(r, 1, 'meituan').k, 'none'); eq(cell(r, 1, 'meituan').reason, 'no_map');
  eq(cell(r, 1, 'eleme').k, 'none'); eq(cell(r, 1, 'guanyi').k, 'none');
  eq(worst(r, 1), 'none');
  eq(r.counts, { ok: 0, att: 0, off: 0, unk: 0, none: 1, all: 1 });
});

check('mapped, name verified, last push accepted the current number → ok / synced', () => {
  const db = freshDb(); product(db, 1, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 10 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'ok'); eq(c.reason, 'synced'); eq(c.last_pushed_qty, 10); eq(c.expected, 10);
});

check('F4: latest push FAILED → att / push_failed, with the channel\'s own sentence', () => {
  const db = freshDb(); product(db, 1, { stock: 3 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 18, ago: 1800 });
  mtQueue(db, 1, { status: 'error', err: 'update failed after retries · 多次重试仍失败', ago: 30 });
  const r = channelSyncItems(db); const c = cell(r, 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'push_failed');
  eq(c.error, 'update failed after retries · 多次重试仍失败');
  eq(c.last_pushed_qty, 18, 'what the platform still shows');
  eq(c.expected, 3, 'what the shelf holds');
  eq(worst(r, 1), 'att'); eq(r.attention.count, 1); eq(r.attention.by_channel, { meituan: 1 });
});

check('platform holds a different number, no queue row → att / wrong_number', () => {
  const db = freshDb(); product(db, 1, { stock: 3 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 18 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'wrong_number'); eq(c.last_pushed_qty, 18); eq(c.expected, 3);
});

check('a multipack option compares through packQty, not the raw shelf', () => {
  const db = freshDb(); product(db, 1, { stock: 13 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 2, units: 6, specKey: 'six' });
  eq(cell(channelSyncItems(db), 1, 'meituan').k, 'ok', 'floor(13/6) = 2 is in step');
});

check('never pushed, nothing queued → att / never_synced', () => {
  const db = freshDb(); product(db, 1);
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: null });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'never_synced');
});

check('a push in flight is ok / sending — even when the number differs and the row is old', () => {
  const db = freshDb(); product(db, 1, { stock: 3 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 18 });
  mtQueue(db, 1, { status: 'pending', ago: 600 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'ok'); eq(c.reason, 'sending');
});

check('the LATEST queue row decides: an old error under a later success is history', () => {
  const db = freshDb(); product(db, 1, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 10 });
  mtQueue(db, 1, { status: 'error', err: 'old', ago: 300 });
  mtQueue(db, 1, { status: 'done', ago: 5 });
  eq(cell(channelSyncItems(db), 1, 'meituan').k, 'ok');
});

check('a Meituan combo row (bundle_id set) does not stand in for the product\'s own push', () => {
  const db = freshDb(); product(db, 1, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 10 });
  db.prepare(`INSERT INTO meituan_sync_queue (retail_store_id, product_id, bundle_id, store_code, status, last_error)
              VALUES (?, 1, 7, 'tianhe', 'error', 'combo failed')`).run(TIANHE);
  eq(cell(channelSyncItems(db), 1, 'meituan').k, 'ok');
});

check('sync off → off / sync_off, and it is quiet (not att)', () => {
  const db = freshDb(); product(db, 1);
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { on: 0, pushed: 99 });
  const r = channelSyncItems(db);
  eq(cell(r, 1, 'meituan').k, 'off'); eq(worst(r, 1), 'off'); eq(r.attention.count, 0);
});

check('name not in a READ catalogue → att / name_not_found, before the switch is consulted', () => {
  const db = freshDb(); product(db, 1);
  mtCatalogue(db, 'tianhe', ['something else']); mtMap(db, 1, { on: 0, pushed: 10 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'name_not_found');
});

check('catalogue never read → unk / not_checked, neutral, not counted as attention', () => {
  const db = freshDb(); product(db, 1);
  mtMap(db, 1, { pushed: 10 });
  const r = channelSyncItems(db);
  eq(cell(r, 1, 'meituan').k, 'unk'); eq(cell(r, 1, 'meituan').reason, 'not_checked');
  eq(r.attention.count, 0); eq(r.counts.unk, 1);
});

check('a shared listing (a 货号 per option) with no option claimed → att / no_option', () => {
  const db = freshDb(); product(db, 1);
  mtCatalogue(db, 'tianhe', ['听装1']);
  db.prepare("INSERT INTO meituan_listing_specs (store_code, listing_name, spec, sku_code) VALUES ('tianhe','听装1','1瓶','A-1')").run();
  db.prepare("INSERT INTO meituan_listing_specs (store_code, listing_name, spec, sku_code) VALUES ('tianhe','听装1','6瓶','A-6')").run();
  mtMap(db, 1, { pushed: 10 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'no_option');
});

check('the 货号-linked store (闪购) with no name is a fact, not a job: none', () => {
  const db = freshDb(); product(db, 1, { stores: [TIANHE, YUEXIU] });
  mtMap(db, 1, { store: 'yuexiu', storeId: YUEXIU, name: null, pushed: 10 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.stores.find(s => s.code === 'yuexiu').k, 'none');
});

check('the by-hand store (外卖) with no name is work: att / no_name', () => {
  const db = freshDb(); product(db, 1);
  mtMap(db, 1, { store: 'tianhe', name: null, pushed: 10 });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.reason, 'no_name');
});

// ── 2. Worst store, worst channel ────────────────────────────────────────────
section('2 · folding: worst store wins, worst channel wins');

check('one store ok, the other failing → the channel cell is att and both stores are listed', () => {
  const db = freshDb(); product(db, 1, { stock: 10, stores: [TIANHE, YUEXIU] });
  mtCatalogue(db, 'tianhe', ['听装1']);
  mtMap(db, 1, { store: 'tianhe', storeId: TIANHE, pushed: 10 });
  mtMap(db, 1, { store: 'yuexiu', storeId: YUEXIU, pushed: 10 });
  mtQueue(db, 1, { store: 'yuexiu', storeId: YUEXIU, status: 'error', err: '商品正在审核中' });
  const c = cell(channelSyncItems(db), 1, 'meituan');
  eq(c.k, 'att'); eq(c.error, '商品正在审核中');
  eq(c.stores.map(s => [s.code, s.k]), [['tianhe', 'ok'], ['yuexiu', 'att']]);
});

check('one store ok, the other unmapped → ok (listed somewhere beats listed nowhere)', () => {
  const db = freshDb(); product(db, 1, { stock: 10, stores: [TIANHE, YUEXIU] });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 10 });
  eq(cell(channelSyncItems(db), 1, 'meituan').k, 'ok');
});

check('item worst = worst channel; counts and chips agree', () => {
  const db = freshDb();
  product(db, 1, { stock: 10 }); product(db, 2, { stock: 10 }); product(db, 3, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1', '听装2']);
  mtMap(db, 1, { pushed: 10 });                       // ok on Meituan
  elShop(db); elCatalogue(db, 'tianhe', [['饿1', null]]);
  elMap(db, 1, { pushed: 4 });                        // wrong on Eleme → item 1 att
  mtMap(db, 2, { on: 0, pushed: 10 });                // off → item 2 off
  const r = channelSyncItems(db);
  eq(worst(r, 1), 'att'); eq(worst(r, 2), 'off'); eq(worst(r, 3), 'none');
  eq(r.counts, { ok: 0, att: 1, off: 1, unk: 0, none: 1, all: 3 });
  eq(r.channels.find(c => c.key === 'meituan').counts, { ok: 1, att: 0, off: 1, unk: 0, none: 1 });
  eq(r.channels.find(c => c.key === 'eleme').counts,   { ok: 0, att: 1, off: 0, unk: 0, none: 2 });
  eq(r.attention.by_channel, { eleme: 1 });
});

// ── 3. Eleme and GZ Grocery specifics ────────────────────────────────────────
section('3 · Eleme and GZ Grocery');

check('Eleme: store with no shop linked → none / store_not_connected on every item, quietly', () => {
  const db = freshDb(); product(db, 1);
  elMap(db, 1, { pushed: 10 });
  const r = channelSyncItems(db); const c = cell(r, 1, 'eleme');
  eq(c.k, 'none'); eq(c.reason, 'store_not_connected');
  eq(r.channels.find(x => x.key === 'eleme').stores[0].connected, false);
});

check('Eleme: mapping with no name pushes to the wrong target → att / no_name', () => {
  const db = freshDb(); product(db, 1); elShop(db); elCatalogue(db, 'tianhe', [['饿1', null]]);
  elMap(db, 1, { name: null, pushed: 10 });
  eq(cell(channelSyncItems(db), 1, 'eleme').reason, 'no_name');
});

check('Eleme: multi-size listing with no size claimed → att / no_option', () => {
  const db = freshDb(); product(db, 1); elShop(db);
  elCatalogue(db, 'tianhe', [['饿1', [{ name: 'S' }, { name: 'L' }]]]);
  elMap(db, 1, { pushed: 10 });
  eq(cell(channelSyncItems(db), 1, 'eleme').reason, 'no_option');
});

check('Eleme: failed push → att / push_failed', () => {
  const db = freshDb(); product(db, 1, { stock: 5 }); elShop(db); elCatalogue(db, 'tianhe', [['饿1', null]]);
  elMap(db, 1, { pushed: 5 });
  db.prepare("INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, status, last_error) VALUES (?, 1, 'tianhe', 'error', 'transient push failure — retries exhausted')").run(TIANHE);
  const c = cell(channelSyncItems(db), 1, 'eleme');
  eq(c.k, 'att'); eq(c.reason, 'push_failed');
});

check('GZ Grocery: bound and reconciled → ok, and carries the ERP\'s own count', () => {
  const db = freshDb(); product(db, 1, { stock: 7 }); gyMap(db, 1, { pushed: 7 });
  db.prepare("INSERT INTO guanyi_listings (store_code, guanyi_name, sku_id, current_qty) VALUES ('tianhe', 'GVF 1-1', 'gy-1', 7)").run();
  const c = cell(channelSyncItems(db), 1, 'guanyi');
  eq(c.k, 'ok'); eq(c.platform_qty, 7);
});

check('GZ Grocery: reconciled to a different target → att / wrong_number; failed push → push_failed', () => {
  const db = freshDb(); product(db, 1, { stock: 7 }); product(db, 2, { stock: 7 });
  gyMap(db, 1, { pushed: 11 }); gyMap(db, 2, { pushed: 7 }); gyQueue(db, 2, { status: 'error', err: 'fetchListings returned null (not logged in?)' });
  const r = channelSyncItems(db);
  eq(cell(r, 1, 'guanyi').reason, 'wrong_number'); eq(cell(r, 2, 'guanyi').reason, 'push_failed');
});

check('GZ Grocery: a row without a sku id is not bound → none', () => {
  const db = freshDb(); product(db, 1); gyMap(db, 1, { skuId: null, pushed: 1 });
  eq(cell(channelSyncItems(db), 1, 'guanyi').k, 'none');
});

// ── 4. Scope and the channel cards ───────────────────────────────────────────
section('4 · scope and channel cards');

check('a store switched off on a channel is out of scope: its failing row is not counted', () => {
  const db = freshDb(); product(db, 1, { stock: 10 }); elShop(db); elCatalogue(db, 'tianhe', [['饿1', null]]);
  elMap(db, 1, { pushed: 99 });
  db.prepare("INSERT INTO channel_status (channel, store_code, is_open) VALUES ('eleme', 'tianhe', 0)").run();
  const r = channelSyncItems(db);
  eq(cell(r, 1, 'eleme').k, 'none');
  // The other store still trades (no row = trading), so the CARD stays; the
  // switched-off store is simply not on it.
  eq(r.channels.find(c => c.key === 'eleme').stores.map(s => s.code), ['yuexiu']);
});

check('the channel card carries waiting count and the stall from channel-sync-stale', () => {
  const db = freshDb(); product(db, 1, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 10 });
  mtQueue(db, 1, { status: 'pending', ago: 600 });
  const r = channelSyncItems(db);
  const mt = r.channels.find(c => c.key === 'meituan');
  eq(mt.waiting, 1);
  ok(mt.stale && mt.stale.waiting_count === 1, 'a 10-minute-old pending row past the 3-minute threshold is a stall');
  eq(cell(r, 1, 'meituan').reason, 'sending', 'and the ITEM stays quiet: one cause, shown once');
});

check('an inactive product is not in the list at all', () => {
  const db = freshDb(); product(db, 1);
  db.prepare('UPDATE store_products SET is_active = 0 WHERE id = 1').run();
  eq(channelSyncItems(db).items.length, 0);
});

check('summary = the page\'s own attention block, with the oldest wrong-since stamp', () => {
  const db = freshDb(); product(db, 1, { stock: 3 });
  mtCatalogue(db, 'tianhe', ['听装1']); mtMap(db, 1, { pushed: 18, ago: 48 });
  const s = channelSyncSummary(db);
  eq(s.count, 1); eq(s.by_channel, { meituan: 1 });
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s.oldest_at), 'SQLite-shaped UTC stamp, like every sibling');
});

check('an empty box (no channel tables at all) answers with every item not listed, never throws', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, name_en TEXT, name_cn TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
           INSERT INTO retail_stores (id, code) VALUES (1, 'tianhe');
           CREATE TABLE store_products (id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT, variant_label TEXT, variant_group_id INTEGER, is_active INTEGER DEFAULT 1);
           INSERT INTO store_products (id, name_en) VALUES (1, 'Lone');`);
  const r = channelSyncItems(db);
  eq(r.items.length, 1); eq(worst(r, 1), 'none'); eq(r.channels.length, 3);
});

// ── 5. The two projections the list and the drawer ask for ──────────────────
section('5 · compact and productIds are projections of the same read');

function twoProducts(db) {
  product(db, 1, { stock: 3 }); product(db, 2, { stock: 10 });
  mtCatalogue(db, 'tianhe', ['听装1', '听装2']);
  mtMap(db, 1, { pushed: 18 });            // wrong number  → att
  mtMap(db, 2, { pushed: 10 });            // in step       → ok
}

check('compact carries the verdict and drops everything the dots do not draw', () => {
  const db = freshDb(); twoProducts(db);
  const r = channelSyncItems(db, { compact: true });
  eq(r.items.map(i => i.id), [1, 2]);
  eq(r.items[0], { id: 1, worst: 'att', channels: {
    meituan: { k: 'att', reason: 'wrong_number' },
    eleme:   { k: 'none', reason: 'store_not_connected' },   // no eleme_shops row in this fixture
    guanyi:  { k: 'none', reason: 'no_map' } } });
  ok(!('shelf' in r.items[0]), 'no shelf'); ok(!('name_en' in r.items[0]), 'no names');
  ok(!('stores' in r.items[0].channels.meituan), 'no per-store detail');
  ok(!('last_pushed_qty' in r.items[0].channels.meituan), 'no push facts');
});

check('compact agrees with the full read, verdict for verdict', () => {
  const db = freshDb(); twoProducts(db);
  const full = channelSyncItems(db), thin = channelSyncItems(db, { compact: true });
  eq(thin.items.map(i => i.worst), full.items.map(i => i.worst));
  eq(thin.items.map(i => i.channels.meituan.k), full.items.map(i => i.channels.meituan.k));
  eq(thin.counts, full.counts, 'and the counts are the same counts');
});

check('productIds narrows to those products, with the full detail intact', () => {
  const db = freshDb(); twoProducts(db);
  const r = channelSyncItems(db, { productIds: [1] });
  eq(r.items.length, 1); eq(r.items[0].id, 1);
  eq(r.items[0].channels.meituan.reason, 'wrong_number', 'the drawer still gets its reason');
  eq(r.items[0].channels.meituan.last_pushed_qty, 18);
});

check('productIds answers for an INACTIVE product — the editor can be open on one', () => {
  const db = freshDb(); twoProducts(db);
  db.prepare('UPDATE store_products SET is_active = 0 WHERE id = 1').run();
  eq(channelSyncItems(db).items.length, 1, 'the catalogue-wide read still hides it');
  const r = channelSyncItems(db, { productIds: [1] });
  eq(r.items.length, 1, 'asked for by id, it answers');
  eq(r.items[0].channels.meituan.k, 'att', 'and its mapping is still pushing, so it still counts');
});

check('an empty or junk id list asks for nothing rather than everything', () => {
  const db = freshDb(); twoProducts(db);
  eq(channelSyncItems(db, { productIds: [] }).items.length, 0);
  eq(channelSyncItems(db, { productIds: ['x', null] }).items.length, 0);
});

check('the channel cards are unchanged by either projection', () => {
  const db = freshDb(); twoProducts(db);
  const full = channelSyncItems(db);
  for (const opts of [{ compact: true }, { productIds: [1] }]) {
    const r = channelSyncItems(db, opts);
    eq(r.channels.map(c => c.key), full.channels.map(c => c.key));
    eq(r.channels.map(c => c.stale), full.channels.map(c => c.stale));
  }
});

// ── 6. The channel's mark and name are bilingual on every surface ───────────
//
// Read out of the shipped client files, not re-implemented here: the regression
// this guards against is a table that looks fine in code and renders Chinese to
// an English reader, which no data test can see. §103 shipped with
// `GLYPH = { meituan: '美', ... }` — one character for both languages — so the
// Channels column and the channel cards showed 美 / 饿 in the English app;
// and the product editor took the channel's name from the server's
// English-only `label`, so the Chinese app offered "前往Meituan".
section('6 · the channel mark and name are bilingual in the shipped client files');

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CJK = /[\u4e00-\u9fff]/;

check('the glyph table is a pair per channel, never one character for both', () => {
  const src = read('public/retail-admin/29-channel-sync.js');
  const m = src.match(/const GLYPH = \{([^}]*)\}/);
  ok(m, 'GLYPH table not found — the anchor has drifted');
  const body = m[1];
  // Every entry is `key: ['EN', 'CN']`. A bare string entry is the bug.
  const entries = body.match(/\w+:\s*(\[[^\]]*\]|'[^']*')/g) || [];
  ok(entries.length >= 3, 'expected an entry per channel, got ' + entries.length);
  for (const e of entries) {
    ok(e.includes('['), 'glyph entry is not a pair: ' + e);
    const [en] = e.slice(e.indexOf('[') + 1).split(',');
    ok(!CJK.test(en), 'the ENGLISH side of a glyph carries Chinese: ' + e);
  }
});

check('the Products page takes the channel name from the shared table, not the server label', () => {
  const src = read('public/retail-admin/09-products.js');
  ok(/csChannelName/.test(src), 'the Products page should resolve names through csChannelName');
  ok(/csChannelGlyph/.test(src), 'and its glyph through csChannelGlyph');
  // The two display paths that used ch.label directly, and shipped English into
  // the Chinese app: the dot's tooltip and the editor card's row + button.
  ok(!/escapeHtml\(ch\.label\)/.test(src), 'a channel row still renders the raw English label');
  ok(!/'前往' \+ ch\.label/.test(src), 'the fix button still builds 前往 from the English label');
});

check('29-channel-sync exports the one name and glyph table it owns', () => {
  const src = read('public/retail-admin/29-channel-sync.js');
  ok(/window\.csChannelName\s*=/.test(src), 'csChannelName is not exported');
  ok(/window\.csChannelGlyph\s*=/.test(src), 'csChannelGlyph is not exported');
});

// ── 7. §103 step 5 · one vocabulary, and the tabs stopped minting their own ──
//
// The three channel tabs were written months apart and each minted its own
// phrases — eighteen between them — with two of them wording the SAME state
// differently and GZ Grocery carrying none at all. Step 5 folded them into one
// table in 01-core.js. These checks read the shipped files: the table is LIFTED
// and run, not re-declared here, so a rename in the product goes red here rather
// than passing against a copy.
section('7 · one channel-state vocabulary, read out of the shipped files');

const CORE = read('public/retail-admin/01-core.js');

// Lift the real table + chWord and run them under a cuT that picks a language.
function vocab(lang) {
  const m = CORE.match(/const CH_STATE_WORD = \{[\s\S]*?\nwindow\.chWord = chWord;/);
  ok(m, 'the shared vocabulary block was not found in 01-core.js — the anchor has drifted');
  const src = m[0].replace(/window\.\w+ = \w+;/g, '');
  const f = new Function('cuT', src + '; return { chWord, chStateWord };');
  return f((en, cn) => (lang === 'cn' ? cn : en));
}

check('the four words are the four words, in both languages', () => {
  const en = vocab('en'), cn = vocab('cn');
  eq(['ok', 'att', 'off', 'none'].map(en.chStateWord),
     ['Synced', 'Needs attention', 'Sync off', 'Not listed']);
  eq(['ok', 'att', 'off', 'none'].map(cn.chStateWord),
     ['已同步', '待处理', '已关闭', '未上架']);
  eq(en.chStateWord('unk'), 'Name not checked');
  eq(cn.chStateWord('unk'), 'Name not checked', 'unk is the EN placeholder on both sides, as on the tabs');
});

check('a named cause wins over the state word, and no_name differs by channel', () => {
  const en = vocab('en'), cn = vocab('cn');
  eq(en.chWord('eleme', 'att', 'name_not_found'), 'Listing not found');
  eq(cn.chWord('eleme', 'att', 'name_not_found'), '找不到该商品');
  eq(en.chWord('meituan', 'att', 'no_option'), 'No option picked');
  // The one cause that is genuinely two jobs: type a name here, vs a mapping
  // that pushes against the wrong name.
  eq(en.chWord('meituan', 'att', 'no_name'), 'Add name');
  eq(en.chWord('eleme', 'att', 'no_name'), 'No listing name');
  eq(cn.chWord('meituan', 'att', 'no_name'), '待填名称');
  // An unnamed cause falls back to the state's own word.
  eq(en.chWord('guanyi', 'ok', null), 'Synced');
  eq(en.chWord('guanyi', 'att', 'wrong_number'), 'Needs attention');
});

check('the three tabs and the Channel sync page all read the shared table', () => {
  for (const f of ['11-meituan.js', '14-eleme.js', '12-guanyi.js', '29-channel-sync.js']) {
    const src = read('public/retail-admin/' + f);
    ok(/chWord\(/.test(src), f + ' does not call the shared chWord()');
  }
});

check('the retired phrases are gone from every live string', () => {
  // Each of these was one tab's private word for a state another tab already
  // had a word for. Comments may still name them — that is the record of what
  // changed — so only cuT() literals are checked.
  const retired = [
    ['11-meituan.js', "cuT('Not linked'"],
    ['11-meituan.js', "cuT('Pick an option'"],
    ['11-meituan.js', 'MT_PENDING_CN.notInCat'],
    ['14-eleme.js', "cuT('Not on Eleme'"],
    ['14-eleme.js', "cuT('Ready, sync off'"],
    ['14-eleme.js', "cuT('Listing not found'"],
    ['14-eleme.js', "cuT('No option picked'"],
  ];
  for (const [f, lit] of retired) {
    ok(!read('public/retail-admin/' + f).includes(lit), f + ' still mints ' + lit);
  }
});

check('饿了么, not 饶了么 — the wrong character is out of every live string', () => {
  // 饶 (ráo) shipped where the platform is 饿 (è), in the Eleme tab's "not on
  // Eleme" label and in its no-listing-name sentence. The label is retired and
  // the sentence corrected. Comments recording that are not strings.
  const src = read('public/retail-admin/14-eleme.js');
  const live = src.split('\n').filter(l => !l.trim().startsWith('//') && l.includes('饶'));
  eq(live, [], 'a live string still carries 饶');
  ok(src.includes('饿了么商品名'), 'and the corrected sentence is present');
});

// ── 8. §103 addendum · the tabs learn whether the push landed ───────────────
//
// The overlay is LIFTED out of 01-core.js and run, not re-described here. Its
// whole value is a one-direction rule, and a rule is only worth having if
// something fails when it is broken: it may turn a green dot amber and must
// never do anything else.
section('8 · the server verdict overlays the tabs in one direction only');

function overlay() {
  const vocab = CORE.match(/const CH_STATE_WORD = \{[\s\S]*?\nwindow\.chWord = chWord;/);
  const over  = CORE.match(/const CH_VERDICT_TTL_MS[\s\S]*?\nwindow\.chApplyVerdict = chApplyVerdict;/);
  ok(vocab && over, 'the vocabulary or overlay block was not found in 01-core.js — an anchor has drifted');
  const src = (vocab[0] + '\n' + over[0]).replace(/window\.\w+ = \w+;/g, '');
  return new Function('cuT', 'fetch', 'console', src +
    '; return { chApplyVerdict, _seed:(c,by)=>{ _chVerdicts[c]={at:Date.now(),byProduct:by}; } };'
  )((en) => en, null, { warn() {} });
}
// Harissa's shape: failing on 天河, fine on 越秀.
const SEED = { 7: { k: 'att', reason: 'push_failed', stores: [
  { code: 'tianhe', k: 'att', reason: 'push_failed' },
  { code: 'yuexiu', k: 'ok',  reason: 'synced' }] } };
const S = (k, reason) => ({ k, reason, t: 'the tab\'s own word' });

check('a tab that says Synced where the push failed now says Needs attention', () => {
  const o = overlay(); o._seed('meituan', SEED);
  const r = o.chApplyVerdict('meituan', 7, 'tianhe', S('ok', 'synced'));
  eq([r.k, r.reason, r.t, !!r.fromPush], ['att', 'push_failed', 'Needs attention', true]);
});

check('PER STORE — the other store on the same product is untouched', () => {
  // Meituan has two. A folded verdict would light the wrong one's dot, which is
  // why the tabs ask for ?channel= rather than the compact projection.
  const o = overlay(); o._seed('meituan', SEED);
  const r = o.chApplyVerdict('meituan', 7, 'yuexiu', S('ok', 'synced'));
  eq([r.k, r.reason, !!r.fromPush], ['ok', 'synced', false]);
});

check('it never rewrites a state the tab already named', () => {
  // The operator is on that screen fixing the cause the tab named; replacing it
  // with another cause would be a worse screen, not a better one.
  const o = overlay(); o._seed('meituan', SEED);
  for (const [k, reason] of [['att', 'no_option'], ['off', 'sync_off'], ['none', 'no_map'], ['unk', 'not_checked']]) {
    const r = o.chApplyVerdict('meituan', 7, 'tianhe', S(k, reason));
    eq([r.k, r.reason], [k, reason], k + ' was rewritten');
  }
});

check('it never downgrades, and a silent read changes nothing', () => {
  const o = overlay();
  o._seed('guanyi', { 7: { k: 'ok', reason: 'synced', stores: [] } });
  eq(o.chApplyVerdict('guanyi', 7, null, S('att', 'wrong_number')).k, 'att', 'server ok upgraded an att');
  eq(o.chApplyVerdict('guanyi', 7, null, S('ok', 'synced')).k, 'ok');
  // A channel never read, and a product the read said nothing about: the tab
  // classifies exactly as it did before this existed. A failed fetch is the
  // same case, which is why it is not a separate branch.
  eq(o.chApplyVerdict('eleme', 7, 'tianhe', S('ok', 'synced')).k, 'ok', 'an unread channel changed a state');
  o._seed('meituan', SEED);
  eq(o.chApplyVerdict('meituan', 99, 'tianhe', S('ok', 'synced')).k, 'ok', 'an unknown product changed a state');
});

check('all three tabs apply it, and only at their ok', () => {
  for (const f of ['11-meituan.js', '14-eleme.js', '12-guanyi.js']) {
    const src = read('public/retail-admin/' + f);
    ok(/chApplyVerdict\(/.test(src), f + ' does not overlay the server verdict');
    ok(/chLoadVerdicts\(/.test(src), f + ' never reads the verdicts it overlays');
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
