#!/usr/bin/env node
/**
 * test_shop_today.js — "today" is the SHOP's day, and no runtime code reads the
 * host's clock (decisions §82).
 *
 *   node scripts/test_shop_today.js
 *
 * WHAT IT GUARDS. Four places took "today" as the UTC day
 * (`new Date().toISOString().slice(0, 10)`) and two read the host's local clock
 * (`getFullYear()` / `getMonth()` / `getDate()`). For Guangzhou, UTC's day is
 * the previous day until 08:00, so a restock raised at 07:30 on the 19th was
 * dated the 18th, and so was a batch logged as made that morning. On a UTC
 * host, restock numbers (RS-YYMMDD) and the date parts of new SKUs read
 * yesterday too. Now all of them read the shop's clock.
 *
 * The last section is the guard: no runtime file under lib/, routes/, server.js
 * or the daemons reads a host-local date part. A new one fails here.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^\n'"`]*$/gm, '');
const fnSrc = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const RESTOCK = read('routes/restock.js');
console.log('\n1. restock');
it('a request number carries the shop\'s date — 07:30 on the 19th in Guangzhou is RS-261019, not RS-261018', () => {
  const rows = [];
  const tdb = () => ({ prepare: () => ({ get: (prefix, ymd) => { rows.push(ymd); return { c: 0 }; } }) });
  const gen = new Function('tdb', 'shopToday', fnSrc(RESTOCK, 'genRsNumber') + '\nreturn genRsNumber;')(tdb, () => '2026-10-19');
  assert.strictEqual(gen('RS'), 'RS-261019-001');
  assert.strictEqual(gen('PR'), 'PR-261019-001');
  assert.deepStrictEqual(rows, ['261019', '261019'], 'and counts that day\'s numbers');
});
it('shopToday is the shop\'s business date, and "N days ago" counts back from it', () => {
  const head = RESTOCK.slice(0, RESTOCK.indexOf('shopDaysAgo') + 400);
  assert.ok(/const shopToday = \(\) => businessDate\.businessDate\(businessDate\.shopTimezone\(tdb\(\)\)\);/.test(head));
  const ago = new Function('shopToday', /const shopDaysAgo = (\(n\) => \{[\s\S]*?\n\});/.exec(head)[0].replace('const shopDaysAgo = ', 'return '))(() => '2026-03-01');
  assert.strictEqual(ago(1), '2026-02-28');
  assert.strictEqual(ago(60), '2025-12-31');
});
it('a new request with no date given, and the suggestions\' window and "today", all use it', () => {
  const src = strip(RESTOCK);
  assert.ok(/const today = date \|\| shopToday\(\);/.test(src), 'POST /api/restock default date');
  const sugg = strip(fnSrc(RESTOCK, 'buildRestockSuggestions'));
  assert.ok(/const since = shopDaysAgo\(daysWindow\);/.test(sugg) && /const today = shopToday\(\);/.test(sugg));
  assert.ok(!/toISOString\(\)\.slice\(0, ?10\)/.test(sugg), 'no UTC day left in the suggestions');
});

console.log('\n2. production');
it('"made today" is the day at the store that made it, not the UTC day', () => {
  const src = strip(read('routes/retail-production.js'));
  assert.ok(/const today = businessDateForLocation\(conn, storeId\);/.test(src));
  assert.ok(!/const today = new Date\(\)\.toISOString\(\)/.test(src));
});

console.log('\n3. SKU date parts');
it('{YYYY}{MM}{DD} is the shop\'s date: 23:30 UTC on 30 Sep is 1 Oct in Guangzhou', () => {
  const fmt = require(path.join(ROOT, 'lib', 'sku-format'));
  const at = new Date('2026-09-30T23:30:00Z');
  assert.strictEqual(fmt.render('{YYYY}{MM}{DD}', { seq: 1, date: at, tz: 'Asia/Shanghai' }), '20261001');
  assert.strictEqual(fmt.render('{YY}{MM}{DD}', { seq: 1, date: at, tz: 'America/New_York' }), '260930');
  assert.throws(() => fmt.render('{YYYY}', { seq: 1, date: at }), (e) => e.code === 'shop_timezone_missing',
    'a date part with no zone is refused, not read off the host');
  assert.strictEqual(fmt.render('B{SEQ:2}', { seq: 3 }), 'B03', 'a pattern with no date part needs no zone');
});
it('both callers pass the shop\'s zone', () => {
  const rules = read('lib/sku-rules.js');
  assert.strictEqual((rules.match(/tz: shopTz\(db\)/g) || []).length, 2, 'peek and claim');
  assert.ok(/tz: require\('\.\.\/lib\/business-date'\)\.shopTimezone\(tdb\(\)\)/.test(read('routes/sku.js')), 'the pattern preview');
});

console.log('\n4. no runtime code reads the host\'s clock');
it('no host-local date part in lib/, routes/, server.js or the daemons', () => {
  const HOST = /\.(getHours|getMinutes|getSeconds|getDate|getDay|getMonth|getFullYear)\(\)|\.toDateString\(\)|\.toLocale(Date|Time)String\(\s*\)/;   // a NUMBER's toLocaleString() is thousands separators, not a clock
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, f.name);
      if (f.isDirectory()) walk(rel);
      else if (f.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('lib'); walk('routes');
  files.push('server.js', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /daemon\.js$/.test(f)).map((f) => 'scripts/' + f));
  const hits = [];
  for (const f of files) {
    strip(read(f)).split('\n').forEach((line, i) => { if (HOST.test(line)) hits.push(f + ': ' + line.trim().slice(0, 100)); });
  }
  assert.deepStrictEqual(hits, [], '\n        ' + hits.join('\n        '));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
