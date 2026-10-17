#!/usr/bin/env node
/**
 * test_low_stock_digest_clock.js — the morning low-stock digest goes out at the
 * SHOP's hour, once per SHOP's day, on any server clock (§82).
 *
 *   node scripts/test_low_stock_digest_clock.js
 *
 * WHAT IT GUARDS. lib/low-stock-digest.js sends one "N products are running
 * low" push a day, at a configured hour (09:00 by default), so the ordering for
 * the day can be done. It read the hour and the day off the server's clock. On
 * a China-time server that is Guangzhou's hour; on the UTC server §82 requires,
 * a 09:00 digest went out at 17:00 and the once-a-day key rolled over at 08:00.
 * Nothing tested its timing at all.
 *
 * HOW. The real sweep runs over real tables (store_products, retail_stores,
 * retail_store_stock, storefront_config) in memory; only the push is a recorder.
 * The suite re-runs itself on UTC, New York and Shanghai server clocks, because
 * scripts/run-suites.js pins every suite to Asia/Shanghai — the one clock under
 * which a host-clock read looks right.
 */
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

if (!process.env.LOWSTOCK_CLOCK_CHILD) {
  let bad = 0;
  for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    const r = cp.spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: tz, LOWSTOCK_CLOCK_CHILD: '1' }, encoding: 'utf8',
    });
    const last = (r.stdout || '').trim().split('\n').pop();
    console.log(`server clock ${tz.padEnd(18)} ${last}`);
    if (r.status !== 0) { bad++; console.log(r.stdout.split('\n').filter((l) => /✗|^\s{6}/.test(l)).join('\n')); console.log(r.stderr); }
  }
  process.exit(bad ? 1 : 0);
}

const ROOT = path.join(__dirname, '..');
const { openMemoryDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const businessDate = require(path.join(ROOT, 'lib', 'business-date'));

// The push is recorded, never sent: swap the module the digest caches at load.
const SENT = [];
const pushPath = require.resolve('../routes/push');
require.cache[pushPath] = {
  id: pushPath, filename: pushPath, loaded: true,
  exports: {
    sendPushToOperatorsWithCaps: (t, caps, p) => { SENT.push(p); return Promise.resolve({ sent: 1 }); },
    sendPushByPermission: () => Promise.resolve({ sent: 0 }),
  },
};
const digest = require(path.join(ROOT, 'lib', 'low-stock-digest'));

const db = openMemoryDb();
addTables(db, DB_SRC, DB_SRC, ['retail_stores', 'retail_store_stock', 'storefront_config']);
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
db.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn, is_active) VALUES (1, 'tianhe', 'Tianhe', '天河', 1)").run();
db.prepare(`INSERT INTO store_products (id, sku, name_en, name_cn, status, is_active, is_published, low_stock_threshold)
            VALUES (1, '1-440', 'Pesto Wrap', '香蒜卷', 'Active', 1, 1, 5)`).run();
db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, 1, 2)').run();

const at = (ymd, h, m = 0, tz = 'Asia/Shanghai') => businessDate.dateInZone(tz, ymd, h, m);
const sentKey = () => {
  const r = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'inventory.lowStockDigestLastSent'").get();
  return r ? JSON.parse(r.value_json) : null;
};
function fresh(cfg = null, storeTz = null) {
  db.exec("DELETE FROM storefront_config");
  if (cfg) db.prepare("INSERT INTO storefront_config (key, value_json) VALUES ('inventory.lowStockDigest', ?)").run(JSON.stringify(cfg));
  db.prepare('UPDATE retail_stores SET timezone = ? WHERE id = 1').run(storeTz);
  SENT.length = 0;
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. the digest\'s hour is the shop\'s hour');
it('at 08:59 in Guangzhou it is too early; at 09:00 it goes out, naming what is low', () => {
  fresh();
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 8, 59), 1), 0);
  assert.strictEqual(sentKey(), null, 'too early claims nothing');
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 9, 0), 1), 1);
  assert.strictEqual(SENT.length, 1);
  assert.ok(/Pesto Wrap \(2\)/.test(SENT[0].body), SENT[0].body);
});
it('a configured hour is the shop\'s too: 07:00 means 07:00 in Guangzhou', () => {
  fresh({ enabled: true, hour: 7 });
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 6, 59), 1), 0);
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 7, 0), 1), 1);
});

console.log('\n2. once per shop\'s day');
it('the day it is claimed for is Guangzhou\'s, and a later tick that day sends nothing', () => {
  fresh();
  digest.sweepDbOnce(db, at('2026-10-17', 9, 0), 1);
  assert.strictEqual(sentKey(), '2026-10-17');
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 23, 30), 1), 0);
});
it('the next Guangzhou morning it goes out again — not at 08:00, when the UTC day turns', () => {
  fresh();
  digest.sweepDbOnce(db, at('2026-10-17', 9, 0), 1);
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-18', 8, 30), 1), 0);
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-18', 9, 5), 1), 1);
  assert.strictEqual(sentKey(), '2026-10-18');
});
it('just after midnight in Guangzhou is the new day (hour 0): it is still the 18th in Guangzhou, the 17th in UTC', () => {
  fresh({ enabled: true, hour: 0 });
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-18', 0, 30), 1), 1);
  assert.strictEqual(sentKey(), '2026-10-18');
});

console.log('\n3. a shop elsewhere reads its own clock');
it('a shop in London: 09:00 Guangzhou is 02:00 there — too early; 09:00 London sends', () => {
  fresh(null, 'Europe/London');
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 9, 0), 1), 0);
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 9, 0, 'Europe/London'), 1), 1);
  assert.strictEqual(sentKey(), '2026-10-17');
});

console.log('\n4. switched off, or nothing low');
it('switched off: never', () => {
  fresh({ enabled: false, hour: 9 });
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 12, 0), 1), 0);
});
it('nothing low: the day is claimed and nothing is sent', () => {
  fresh();
  db.prepare('UPDATE retail_store_stock SET physical_qty = 50').run();
  assert.strictEqual(digest.sweepDbOnce(db, at('2026-10-17', 9, 0), 1), 0);
  assert.strictEqual(sentKey(), '2026-10-17');
  assert.strictEqual(SENT.length, 0);
  db.prepare('UPDATE retail_store_stock SET physical_qty = 2').run();
});

console.log('\n5. no host-local read');
it('the sweep reads no host-local date part', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'low-stock-digest.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const hit = /\.(getHours|getMinutes|getDate|getDay|getMonth|getFullYear)\(/.exec(src);
  assert.strictEqual(hit && hit[0], null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
