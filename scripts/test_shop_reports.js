#!/usr/bin/env node
/**
 * test_shop_reports.js — a report's default "today" is the shop's day, the same
 * day its SQL already buckets by (decisions §82, the `+8` survey, batch 3).
 *
 *   node scripts/test_shop_reports.js
 *
 * WHAT IT GUARDS. The report queries bucket rows by the shop's own shift
 * (shopSqlShift), but their default window was computed in JavaScript as
 * Guangzhou's day. For Roots the two agree. For a shop anywhere else, "today"
 * on the dashboard, Sales, Finance, the product highlights, a product's sales
 * card, the stock-activity list and the 30-day sales column asked the SQL for a
 * day the shop was not on — a New York shop at 20:00 on the 18th was shown the
 * 19th, which had not started. The dashboard's live "today vs the same weekday"
 * clip and its activity feed's "since midnight" read Guangzhou's clock too.
 *
 * The real functions are lifted and run against the real lib/business-date.js.
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
const financeWindow = require(path.join(ROOT, 'lib', 'finance-window'));

function shop(zone) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, is_active INTEGER, sort_order INTEGER, timezone TEXT);
           CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);`);
  db.prepare('INSERT INTO retail_stores (id, is_active, sort_order, timezone) VALUES (1, 1, 0, ?)').run(zone);
  return db;
}
const back = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. the shop clock\'s trailing windows');
const CLOCK = read('lib/shop-clock.js');
const clock = (zone, todayStub) => new Function('businessDate', 'tdb',
  `${fnSrc(CLOCK, 'shopToday')}\n${fnSrc(CLOCK, 'shopDaysAgo')}\n${fnSrc(CLOCK, 'shopMidnightMs')}\n`
  + (todayStub ? `shopToday = () => ${JSON.stringify(todayStub)};\n` : '')
  + 'return { shopToday, shopDaysAgo, shopMidnightMs };')(businessDate, () => shop(zone));
it('"N days ago" counts back from the shop\'s today, across a month and a year', () => {
  const c = clock('Asia/Shanghai', '2026-03-01');
  assert.strictEqual(c.shopDaysAgo(0), '2026-03-01');
  assert.strictEqual(c.shopDaysAgo(1), '2026-02-28');
  assert.strictEqual(c.shopDaysAgo(60), '2025-12-31');
});
it('today and "since midnight" are the shop\'s, for Guangzhou and for New York', () => {
  for (const tz of ['Asia/Shanghai', 'America/New_York']) {
    const c = clock(tz);
    const today = businessDate.businessDate(tz);
    assert.strictEqual(c.shopToday(), today, tz);
    assert.strictEqual(c.shopDaysAgo(29), back(today, 29), tz);
    assert.strictEqual(c.shopMidnightMs(), businessDate.dateInZone(tz, today, 0, 0).getTime(), tz);
  }
  const gz = clock('Asia/Shanghai');
  assert.strictEqual(gz.shopMidnightMs(), Date.parse(gz.shopToday() + 'T00:00:00+08:00'), 'Roots\' midnight is unchanged');
});

console.log('\n2. Finance\'s window');
it('the default 30 days end on the shop\'s today', () => {
  for (const tz of ['Asia/Shanghai', 'America/New_York', 'Asia/Kolkata']) {
    const w = financeWindow.resolveWindow({}, tz);
    const today = businessDate.businessDate(tz);
    assert.deepStrictEqual([w.from, w.to, w.span_days, w.inverted], [back(today, 29), today, 30, false], tz);
  }
});
it('given both bounds it needs no zone; missing one with no zone is refused by name', () => {
  assert.deepStrictEqual(financeWindow.resolveWindow({ from: '2026-10-01', to: '2026-10-07' }),
    { from: '2026-10-01', to: '2026-10-07', span_days: 7, inverted: false });
  assert.strictEqual(financeWindow.resolveWindow({ from: '2026-10-09', to: '2026-10-07' }).inverted, true);
  assert.throws(() => financeWindow.resolveWindow({ from: '2026-10-01' }), (e) => e.code === 'shop_timezone_missing');
});
it('every caller hands it the shop\'s zone', () => {
  const sum = read('routes/finance-summary.js');
  const tx = read('routes/finance-transactions.js');
  assert.strictEqual((sum.match(/resolveWindow\(req\.query, shopTimezone\(tdb\(\)\)\)/g) || []).length, 2);
  assert.strictEqual((tx.match(/resolveWindow\((req\.)?query, shopTimezone\(tdb\(\)\)\)/g) || []).length, 3);
  assert.ok(!/resolveWindow\((req\.)?query\)/.test(sum + tx), 'a caller with no zone');
});

console.log('\n3. the report screens');
const RETAIL = read('routes/retail.js');
const route = (marker, len = 9000) => {
  const at = RETAIL.indexOf(marker);
  assert.ok(at >= 0, marker + ' not found');
  return strip(RETAIL.slice(at, at + len));
};
it('Sales overview: today is the shop\'s', () => {
  assert.ok(/const today = shopToday\(\);/.test(route("router.get('/api/retail-admin/sales/summary'", 800)));
});
it('Dashboard: the default window, and the live clip\'s "now", are on the shop\'s clock', () => {
  const r = route("const toDefault   = shopToday();", 12000);
  assert.ok(/const fromDefault = shopDaysAgo\(29\);/.test(r));
  assert.ok(/const nowHms {2}= new Date\(Date\.now\(\) \+ shopOffsetMinutes\(\) \* 60000\)\.toISOString\(\)\.slice\(11, 19\);/.test(r),
    'the clip reads the same shift as its time(…, TZ) comparison');
});
it('Dashboard activity feed: "since midnight" is the shop\'s midnight', () => {
  assert.ok(/\|\| shopMidnightMs\(\);/.test(route("router.get('/api/retail-admin/dashboard/activity'", 1200)));
});
it('Highlights, a product\'s sales card, the 30-day column and stock activity default to the shop\'s days', () => {
  assert.ok(/const today {4}= shopToday\(\);\n {2}const d = shopDaysAgo;/.test(RETAIL), 'highlights');
  const card = route("const toDefault = shopToday();", 1500);
  assert.ok(/: shopDaysAgo\(29\);/.test(card) && /fromDefault = shopDaysAgo\(days - 1\);/.test(card), 'product sales card');
  assert.ok(/const to = shopToday\(\);\n {4}const from = shopDaysAgo\(29\);/.test(RETAIL), 'sales30');
  assert.ok(/const from = isDate\(q\.from\) \? q\.from : shopToday\(\);/.test(fnSrc(RETAIL, 'buildActivityQuery')), 'stock activity');
});
it('no report computes Guangzhou\'s day any more', () => {
  const src = strip(RETAIL);
  assert.ok(!/\bnowGz\b|\bgzToday\b|\bgzMidnightMs\b/.test(src), 'a Guangzhou "now" survived');
  assert.ok(!/8 \* 3600/.test(strip(read('lib/finance-window.js'))), 'finance-window');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
