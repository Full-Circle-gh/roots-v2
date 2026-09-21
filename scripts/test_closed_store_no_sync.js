#!/usr/bin/env node
'use strict';

// A CLOSED LOCATION IS NOT SYNCED ON ANY CHANNEL.
//
//   node scripts/test_closed_store_no_sync.js
//
// THE FINDING. On 2026-09-21 at 23:20 the ops group was paged about 越秀:
//
//   🔴 美团闪购 yuexiu: 4 listing(s) stuck out of sync for over 24h — needs a human
//
// 越秀 was closed. Nothing about a shut shop's listings needed a human that night,
// and the four "stuck" pushes were ones the system had queued for itself.
//
// The loop, in order:
//
//   1. The operator closes the location. lib/store-close.js does the right thing
//      and DELETES every queued push for it — pending, processing and error —
//      because a quantity queued before a standing closure describes a shop that
//      no longer exists.
//   2. Thirty minutes later the drift sweep runs. It was the only channel-sync
//      path in the tree with NO trading gate at all, so it compared every listing
//      against last_pushed_qty, found them all wrong, and queued them again.
//   3. processStockQueue refused to push them, correctly — its own gate holds a
//      switched-off store. So the rows sat pending forever.
//   4. Every listing aged past CHRONIC_HOURS and the latched alert fired.
//
// Three things are checked:
//
//   §1  the Meituan/闪购 sweep skips a location that is not trading — no queue
//       rows, no page — and still does its job for one that is
//   §2  the shared sweep (Eleme today) does the same, through channel_status
//   §3  the push gates read ONE predicate, so "closed" cannot mean two things —
//       in particular the shop-wide fulfillment_open master now counts
//
// Everything runs against a throwaway :memory: database. Safe on the live box.

const path = require('path');
const fs   = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const eq  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);

// ── §3 first: it needs no database, so it reports even where better-sqlite3
//    is not built (the same fallback scripts/test_channel_shop_close.js uses).
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

section('3 · one predicate decides whether a location is trading');

for (const [rel, what] of [
  ['scripts/meituan-daemon.js', 'the 外卖 daemon'],
  ['scripts/shangou-daemon.js', 'the 闪购 daemon'],
  ['lib/meituan-bundles.js',    'the enqueue path'],
  ['routes/meituan-admin.js',   'the admin screen'],
  ['lib/meituan-drift-sweep.js','the Meituan drift sweep'],
  ['lib/channel-drift-sweep.js','the shared drift sweep'],
]) {
  const s = src(rel);
  yes(/isStoreTradingOnChannel/.test(s) && /store-trading/.test(s),
    `${what} asks lib/store-trading`, rel);
  // The regression: a local re-read of the two POI columns is how the shop-wide
  // master stopped counting. lib/store-trading reads them; nobody else may.
  yes(!/SELECT target_open, is_open FROM store_business_status/.test(s),
    `${what} does not re-read target_open/is_open itself`,
    'a second copy of the read is a second answer to "is this shop closed"');
}

// ── The database half ────────────────────────────────────────────────────────
let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  console.log('\n  ! better-sqlite3 is not built here — skipping the database half');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

const meituanSweep = require('../lib/meituan-drift-sweep');
const channelSweep = require('../lib/channel-drift-sweep');
const { isStoreTradingOnChannel } = require('../lib/store-trading');
const bundleLib = require('../lib/meituan-bundles');

const STORE_ID = 1, STORE = 'yuexiu';

// The shape the sweeps read, not the whole schema — columns copied from
// database.js (meituan_product_map :6119, meituan_sync_queue :6155,
// meituan_bundles :6520, store_business_status :6268, channel_status :6306).
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT,
      is_active INTEGER DEFAULT 1, bundle_items TEXT
    );
    CREATE TABLE retail_store_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, physical_qty INTEGER NOT NULL DEFAULT 0,
      UNIQUE(store_id, product_id)
    );
    CREATE TABLE meituan_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, store_code TEXT NOT NULL, meituan_name TEXT,
      meituan_sku TEXT, meituan_spec TEXT, units_per_pack INTEGER DEFAULT 1,
      spec_key TEXT DEFAULT '', last_pushed_qty INTEGER, last_pushed_at DATETIME,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE meituan_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      product_id INTEGER, store_code TEXT NOT NULL, new_qty INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      meituan_name TEXT, bundle_id INTEGER, last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME
    );
    CREATE TABLE meituan_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      store_code TEXT NOT NULL, meituan_name TEXT NOT NULL, max_qty INTEGER,
      sync_enabled INTEGER NOT NULL DEFAULT 1, last_pushed_qty INTEGER,
      last_pushed_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE store_business_status (
      store_code TEXT PRIMARY KEY, is_open INTEGER, target_open INTEGER,
      fulfillment_open INTEGER DEFAULT 1, updated_at DATETIME
    );
    CREATE TABLE channel_status (
      channel TEXT NOT NULL, store_code TEXT NOT NULL, is_open INTEGER DEFAULT 1,
      PRIMARY KEY (channel, store_code)
    );
    -- Eleme's own two, from scripts/test_channel_drift_sweep.js's fixture.
    CREATE TABLE eleme_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, store_code TEXT NOT NULL, extend_code TEXT,
      eleme_name TEXT, item_id TEXT, spec_id TEXT, spec_name TEXT,
      last_pushed_qty INTEGER, last_pushed_at DATETIME,
      sync_enabled INTEGER NOT NULL DEFAULT 1, units_per_pack INTEGER NOT NULL DEFAULT 1,
      spec_key TEXT NOT NULL DEFAULT '',
      -- The sweep ages a never-pushed row off created_at. Leaving it out made the
      -- query throw, which the sweep catches — so the two closed-location cases
      -- below passed for the wrong reason until the trading case above went red.
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE eleme_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, store_code TEXT NOT NULL, new_qty INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME
    );
    CREATE TABLE eleme_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, event_type TEXT,
      status TEXT, detail TEXT, error_msg TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

// One listing that has been wrong for three days: shelf 7, Meituan holding 3,
// last pushed 72 hours ago. Chronic by any reading.
function seedDrift(db, id, { store = STORE, channel = 'meituan' } = {}) {
  db.prepare(`INSERT INTO store_products (id, sku, name_cn, name_en, is_active)
              VALUES (?,?,?,?,1)`).run(id, `SKU-${id}`, `商品${id}`, `Product ${id}`);
  db.prepare('INSERT OR IGNORE INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)')
    .run(STORE_ID, id, 7);
  if (channel === 'meituan') {
    db.prepare(`INSERT INTO meituan_product_map
        (retail_store_id, product_id, store_code, meituan_name, last_pushed_qty,
         last_pushed_at, sync_enabled, units_per_pack)
        VALUES (?,?,?,?,3,datetime('now','-72 hours'),1,1)`)
      .run(STORE_ID, id, store, `听装${id}`);
  } else {
    db.prepare(`INSERT INTO eleme_product_map
        (retail_store_id, product_id, store_code, eleme_name, last_pushed_qty,
         last_pushed_at, sync_enabled, units_per_pack, spec_key)
        VALUES (?,?,?,?,3,datetime('now','-72 hours'),1,1,'')`)
      .run(STORE_ID, id, store, `听装${id}`);
  }
}

function recorder() {
  const sent = [], lines = [], logs = [];
  return {
    sent, lines, logs,
    log: (sc, msg) => lines.push({ sc, msg }),
    logSync: (sc, type, status, detail, msg) => logs.push({ sc, type, status, detail, msg }),
    notifyMerchant: (msg) => sent.push(msg),
  };
}
// Stands in for lib/alert-latch's Proxy: an unset key reads false, never undefined.
function latchStub() {
  const mem = new Map();
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? !!mem.get(k) : undefined),
    set: (_t, k, v) => { if (typeof k === 'string') mem.set(k, !!v); return true; },
    has: (_t, k) => (typeof k === 'string' ? !!mem.get(k) : false),
  });
}

const mtQueue = (db) => db.prepare('SELECT COUNT(*) n FROM meituan_sync_queue').get().n;
const elQueue = (db) => db.prepare('SELECT COUNT(*) n FROM eleme_sync_queue').get().n;

function runMeituan(db, rec) {
  return meituanSweep.sweepStockDrift(db, {
    storeCodes: [STORE], channelKey: 'shangou', channel: '闪购',
    log: rec.log, logSync: rec.logSync,
    notifyMerchant: rec.notifyMerchant, alerts: latchStub(),
  });
}

// ── §1 · Meituan / 闪购 ───────────────────────────────────────────────────────

section('1 · the 闪购 sweep leaves a shut location alone');

{
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 101);
  const res = runMeituan(db, rec);
  yes(res.enqueued === 1, 'a TRADING location still gets its stranded push re-queued',
    `enqueued ${res.enqueued}`);
  yes(rec.sent.length === 1 && /闪购/.test(rec.sent[0]),
    'and a listing wrong for three days still pages a human');
}

for (const [label, sql] of [
  ['the shop-wide switch (fulfillment_open = 0)',
   `INSERT INTO store_business_status (store_code, fulfillment_open) VALUES ('${STORE}', 0)`],
  ['the POI reading 停业 (is_open = 0)',
   `INSERT INTO store_business_status (store_code, is_open) VALUES ('${STORE}', 0)`],
  ['a close the daemon has not applied yet (target_open = 0, is_open = 1)',
   `INSERT INTO store_business_status (store_code, is_open, target_open) VALUES ('${STORE}', 1, 0)`],
]) {
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 101);
  db.exec(sql);
  const res = runMeituan(db, rec);
  eq([res.enqueued, mtQueue(db), rec.sent.length], [0, 0, 0],
     `${label}: nothing queued, nobody paged`);
  yes(rec.lines.some(l => l.sc === STORE && /not trading/.test(l.msg)),
    '  …and the skip is said out loud in the daemon log, not silent');
}

{
  // Starvation, the other way round: the shut shop must not take the trading
  // shop's turn, and must not take it down either.
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 101, { store: 'tianhe' });
  seedDrift(db, 102, { store: STORE });
  db.exec(`INSERT INTO store_business_status (store_code, fulfillment_open) VALUES ('${STORE}', 0)`);
  const res = meituanSweep.sweepStockDrift(db, {
    storeCodes: ['tianhe', STORE], channelKey: 'meituan', channel: '外卖',
    log: rec.log, logSync: rec.logSync, notifyMerchant: rec.notifyMerchant, alerts: latchStub(),
  });
  eq(res.enqueued, 1, 'one shut location among two does not mute the one still trading');
  eq(db.prepare('SELECT DISTINCT store_code FROM meituan_sync_queue').all().map(r => r.store_code),
     ['tianhe'], 'and only the trading store has rows');
}

{
  // The fail-open direction every reader of these tables takes: a missing table
  // must never mute a live channel.
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 101);
  db.exec('DROP TABLE store_business_status');
  yes(runMeituan(db, rec).enqueued === 1,
    'a missing status table reads as TRADING — never silently mute a live channel');
}

// ── §2 · the shared sweep (Eleme) ────────────────────────────────────────────

section('2 · the shared sweep reads the same switch');

function runEleme(db, rec) {
  return channelSweep.sweepStockDrift(db, channelSweep.ELEME, {
    storeCodes: [STORE], log: rec.log, logSync: rec.logSync,
    notifyMerchant: rec.notifyMerchant, alerts: latchStub(),
  });
}

{
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 201, { channel: 'eleme' });
  yes(runEleme(db, rec).enqueued === 1, 'a trading location still gets its push re-queued');
}
for (const [label, sql] of [
  ['the Eleme cell closed (channel_status.is_open = 0)',
   `INSERT INTO channel_status (channel, store_code, is_open) VALUES ('eleme','${STORE}',0)`],
  ['the shop-wide switch (fulfillment_open = 0)',
   `INSERT INTO store_business_status (store_code, fulfillment_open) VALUES ('${STORE}', 0)`],
]) {
  const db = freshDb(); const rec = recorder();
  seedDrift(db, 201, { channel: 'eleme' });
  db.exec(sql);
  const res = runEleme(db, rec);
  eq([res.enqueued, elQueue(db), res.chronic.length], [0, 0, 0],
     `${label}: nothing queued, nothing recorded as chronic`);
}

// ── §3 (database half) · the enqueue path ────────────────────────────────────

section('3b · the enqueue path answers the same way');

{
  const db = freshDb();
  db.exec(`INSERT INTO store_business_status (store_code, is_open, fulfillment_open) VALUES ('${STORE}', 1, 0)`);
  yes(bundleLib.storePushEnabled(db, STORE) === false,
    'storePushEnabled says NO for a shop closed by the location master, even with the POI open',
    'this is the case the old two-column read got wrong');
  yes(isStoreTradingOnChannel(db, STORE, 'shangou') === false,
    'and 闪购 reads the same row, so both Meituan channels agree');
  db.exec(`UPDATE store_business_status SET fulfillment_open = 1 WHERE store_code = '${STORE}'`);
  yes(bundleLib.storePushEnabled(db, STORE) === true, 'reopening the master lets pushes queue again');
}

{
  // enqueueBundle carried no per-location gate at all — only "is the retail store
  // row active". A component moving at a shut location queued a combo push.
  const s = src('lib/meituan-bundles.js');
  const body = s.slice(s.indexOf('function enqueueBundle(db, bundle)'),
                       s.indexOf('function enqueueBundlesForProduct'));
  yes(/storePushEnabled\(db, bundle\.store_code\)/.test(body),
    'enqueueBundle applies the same per-location gate enqueueProductStock does');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
