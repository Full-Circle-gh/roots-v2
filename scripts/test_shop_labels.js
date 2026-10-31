#!/usr/bin/env node
/**
 * test_shop_labels.js — the labels, file names, stamps and small day counters
 * that wrote Guangzhou's clock as the shop's (decisions §82, the `+8` survey,
 * batch 2).
 *
 *   node scripts/test_shop_labels.js
 *
 * WHAT IT GUARDS. None of these is wrong for Roots, whose shops are in
 * Guangzhou. Each is wrong for a shop anywhere else:
 *   - five CSV exports headed their times "(UTC+8)" over values already shifted
 *     to the shop's own zone, and named the file by Guangzhou's date;
 *   - the article-view and AI-question counters bucketed by Guangzhou's day;
 *   - the storefront's activity curve read Guangzhou's hour;
 *   - staff alerts and GZ Grocery order cards were stamped in Guangzhou time;
 *   - Eleme and Meituan order numbers carried the UTC date, so Guangzhou's
 *     morning orders read as yesterday's — the one change Roots will see;
 *   - scripts/funnel_report.js bucketed by '+8 hours'.
 *
 * The real functions are lifted from the source and run against the real
 * lib/business-date.js, with the database handle under the test's control.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fnSrc = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const businessDate = require(path.join(ROOT, 'lib', 'business-date'));

// A tenant database with one active store in `zone` (null: a store with none).
function shop(zone) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, is_active INTEGER, sort_order INTEGER, timezone TEXT);
           CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);`);
  db.prepare('INSERT INTO retail_stores (id, is_active, sort_order, timezone) VALUES (1, 1, 0, ?)').run(zone);
  return db;
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const AT = new Date('2026-10-18T23:30:00Z');   // 07:30 on the 19th in Guangzhou

console.log('\n1. CSV exports: the header names the shop\'s offset, the file the shop\'s date');
it('the label is the offset the values were shifted by: UTC+8, UTC-4, UTC+5:30, UTC+0', () => {
  const label = (tz) => businessDate.utcLabel(parseInt(businessDate.sqlDayShift(tz, AT), 10));
  assert.strictEqual(label('Asia/Shanghai'), 'UTC+8', 'Roots\' exports read exactly as before');
  assert.strictEqual(label('America/New_York'), 'UTC-4');
  assert.strictEqual(label('Asia/Kolkata'), 'UTC+5:30');
  assert.strictEqual(label('Europe/London'), 'UTC+1');
  assert.strictEqual(businessDate.utcLabel(0), 'UTC+0');
  assert.strictEqual(businessDate.utcLabel(-570), 'UTC-9:30');
});
it('shop-clock builds the label and today from the shop\'s own clock', () => {
  const src = read('lib/shop-clock.js');
  assert.ok(/return parseInt\(shopSqlShift\(\), 10\);/.test(src), 'the offset is the SQL shift\'s');
  assert.ok(/return businessDate\.utcLabel\(shopOffsetMinutes\(\)\);/.test(src));
  assert.ok(/return businessDate\.businessDate\(businessDate\.shopTimezone\(tdb\(\)\)\);/.test(src));
});
it('no export is headed "(UTC+8)" or named by Guangzhou\'s date any more', () => {
  for (const f of ['routes/retail.js', 'routes/retail/customers.js']) {
    const src = strip(read(f));
    assert.ok(!/\(UTC\+8\)'/.test(src), f + ': a literal (UTC+8) header');
    assert.ok(!/const day = new Date\(Date\.now\(\) \+ 8 \* 3600 \* 1000\)/.test(src), f + ': a Guangzhou "day"');
  }
  const retail = read('routes/retail.js');
  for (const name of ['change_history', 'products', 'orders']) {
    const at = retail.indexOf(`filename="${name}_\${day}.csv"`);
    assert.ok(at > 0 && /const day = shopToday\(\);/.test(retail.slice(at - 200, at)), name + '.csv');
  }
  assert.strictEqual((retail.match(/\(\$\{shopUtcLabel\(\)\}\)/g) || []).length, 8, 'eight time columns over four exports');
  const cust = read('routes/retail/customers.js');
  assert.strictEqual((cust.match(/\(\$\{shopUtcLabel\(\)\}\)/g) || []).length, 3);
  assert.ok(/const day = shopToday\(\);\n[^\n]*\n[^\n]*customers_\$\{day\}\.csv/.test(cust));
});

console.log('\n2. day counters');
it('article views and the daily AI-question cap count the shop\'s day', () => {
  const src = read('routes/retail.js');
  const views = src.indexOf('INSERT OR IGNORE INTO retail_article_views');
  assert.ok(/const day = shopToday\(\);/.test(src.slice(views - 120, views)), 'article views');
  const ask = src.indexOf("router.post('/api/retail-admin/reports/ask'");
  assert.ok(/const day = shopToday\(\);/.test(src.slice(ask, ask + 800)), 'AI-question cap');
});

console.log('\n3. the storefront\'s activity curve');
const RETAIL = read('routes/retail.js');
const curve = (offset) => new Function('shopOffsetMinutes', 'DAY_CURVE',
  `${fnSrc(RETAIL, 'localHourFloat')}\n${fnSrc(RETAIL, 'dayIntensity')}\nreturn { localHourFloat, dayIntensity };`)(
  () => { if (offset == null) { const e = new Error('no zone'); e.code = 'shop_timezone_missing'; throw e; } return offset; },
  Array.from({ length: 24 }, (_, h) => h + 1));
it('it reads the hour on the shop\'s clock: 23:30 UTC is 07:30 in Guangzhou, 19:30 in New York', () => {
  assert.strictEqual(curve(480).localHourFloat(AT.getTime()), 7.5);
  assert.strictEqual(curve(-240).localHourFloat(AT.getTime()), 19.5);
});
it('a shop with no readable zone shows no synthetic activity, rather than Guangzhou\'s', () => {
  const c = curve(null);
  assert.strictEqual(c.localHourFloat(AT.getTime()), null);
  assert.strictEqual(c.dayIntensity(AT.getTime()), 0);
  assert.ok(/function dayElapsedFraction\(nowMs\) \{\n  const h = localHourFloat\(nowMs\);\n  if \(h == null\) return 0;/.test(RETAIL));
  assert.ok(!/HK_OFFSET_MS/.test(RETAIL));
});

console.log('\n4. message stamps');
it('a stamp is the shop\'s clock; a zone that cannot be read says UTC, never a guessed zone', () => {
  assert.strictEqual(businessDate.messageStamp('Asia/Shanghai', AT), '07:30');
  assert.strictEqual(businessDate.messageStamp('America/New_York', AT), '19:30');
  assert.strictEqual(businessDate.messageStamp(null, AT), '23:30 UTC');
  assert.strictEqual(businessDate.messageStamp('Mars/Olympus', AT), '23:30 UTC');
});
it('staff alerts read the account\'s zone through the read-only handle, and never throw for it', () => {
  const OPS = read('lib/ops-alert.js');
  const lift = (roHandle) => new Function('businessDate', 'roHandle', 'DB_FILE',
    `${fnSrc(OPS, 'shTime')}\nreturn shTime;`)(businessDate, roHandle, 'roots.db');
  const ny = shop('America/New_York');
  const files = [];
  const shTime = lift((f) => { files.push(f); return ny; });
  assert.ok(/^\d\d:\d\d$/.test(shTime('tenants/7.db')));
  assert.deepStrictEqual(files, ['tenants/7.db'], 'the account\'s own database');
  assert.strictEqual(shTime(), businessDate.messageStamp('America/New_York'));
  assert.ok(/ UTC$/.test(lift(() => { throw new Error('renamed'); })()), 'an unopenable database stamps UTC');
  assert.ok(/ UTC$/.test(lift(() => shop(null))()), 'a shop with no zone stamps UTC');
  assert.ok(OPS.includes('deliver(url, `[${shTime(tenantDbFile(tenantId))}] ${text}`)'), 'a merchant\'s alert carries the merchant\'s clock');
});
it('GZ Grocery order cards are stamped on the shop\'s clock', () => {
  const src = read('lib/gzgrocery-order-notify.js');
  const shTime = new Function('businessDate', 'tdb', `${fnSrc(src, 'shTime')}\nreturn shTime;`)(businessDate, () => shop('Europe/London'));
  assert.strictEqual(shTime(), businessDate.messageStamp('Europe/London'));
  assert.ok(!/8 \* 3600/.test(strip(src)));
});

console.log('\n5. Eleme and Meituan order numbers');
for (const [file, pre] of [['routes/eleme-internal.js', 'EL'], ['routes/meituan-internal.js', 'MT']]) {
  it(`${pre}: the date is the store's day — a 07:30 Guangzhou order is ${pre}20261019…, not …1018`, () => {
    const src = read(file);
    const orderNoDate = (db) => new Function('businessDate', 'db', `${fnSrc(src, 'orderNoDate')}\nreturn orderNoDate;`)(businessDate, db);
    assert.strictEqual(orderNoDate(shop('Asia/Shanghai'))(1, AT), '20261019');
    assert.strictEqual(orderNoDate(shop(null))(1, AT), '20261018', 'no zone keeps the UTC date, and the order');
    assert.ok(/const datePart = orderNoDate\(storeId, now\);/.test(src));
  });
}

console.log('\n6. the funnel report');
it('it buckets by the shop\'s day, not \'+8 hours\'', () => {
  const src = strip(read('scripts/funnel_report.js'));
  assert.ok(/const SHOP_TZ = businessDate\.shopTimezone\(db\);/.test(src));
  assert.ok(/const TZ {4}= businessDate\.sqlDayShift\(SHOP_TZ\);/.test(src));
  assert.ok(!/'\+8 hours'|8 \* 3600/.test(src));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
