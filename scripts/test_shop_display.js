#!/usr/bin/env node
/**
 * test_shop_display.js — printed slips, the customer's slot line and served
 * order times read the shop's clock (decisions §82, the `+8` survey, batch 5).
 *
 *   node scripts/test_shop_display.js
 *
 * WHAT IT GUARDS. Each of these shifted by a fixed +8h, which is right for
 * Roots and wrong for a shop anywhere else:
 *   - the Feieyun slip's time, its slot date, its "Tomorrow" → date swap and
 *     its date-only test (lib/feie.js);
 *   - the customer's "Today / Tomorrow" slot line (lib/slot-label.js — its
 *     own harness, scripts/slot-label-check.js, holds the day logic);
 *   - order timestamps served to the screens (routes/retail.js toShopLocalTs).
 * With no readable zone none of them guesses one: the slip prints UTC and says
 * so, the slot line shows the stored label, the timestamp is served as stored.
 *
 * The real functions are lifted from the source and run against the real
 * lib/business-date.js, with the shop's zone under the test's control.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fnSrc = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const businessDate = require(path.join(ROOT, 'lib', 'business-date'));

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. the printed slip');
const FEIE = read('lib/feie.js');
const slip = (zone) => new Function('businessDate', '_MON', '_pad2',
  `const slipZone = () => ${JSON.stringify(zone)};\n`
  + ['slipWall', 'fmtTime', 'isGzMidnight', 'fmtSlotDate', 'absolutizeSlot'].map((n) => fnSrc(FEIE, n)).join('\n')
  + '\nreturn { fmtTime, isGzMidnight, fmtSlotDate, absolutizeSlot };')(
  businessDate, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], (n) => String(n).padStart(2, '0'));
const GZ = slip('Asia/Shanghai'), NY = slip('America/New_York'), NONE = slip(null);
it('the time paid: Guangzhou\'s as before, New York\'s for a New York shop, UTC and saying so with none', () => {
  assert.strictEqual(GZ.fmtTime('2026-10-18 23:30:00'), '2026-10-19 07:30');
  assert.strictEqual(NY.fmtTime('2026-10-18 23:30:00'), '2026-10-18 19:30');
  assert.strictEqual(NONE.fmtTime('2026-10-18 23:30:00'), '2026-10-18 23:30 UTC');
});
it('a date-only pick is the shop\'s midnight; its slip shows the date alone', () => {
  const gzMidnight = '2026-06-22T16:00:00.000Z';   // 00:00 on the 23rd in Guangzhou
  const nyMidnight = '2026-06-23T04:00:00.000Z';   // 00:00 on the 23rd in New York
  assert.strictEqual(GZ.isGzMidnight(gzMidnight), true);
  assert.strictEqual(GZ.fmtSlotDate(gzMidnight), 'Jun 23', 'Roots\' slips unchanged');
  assert.strictEqual(NY.isGzMidnight(nyMidnight), true, 'New York\'s own midnight is a date-only pick');
  assert.strictEqual(NY.isGzMidnight(gzMidnight), false);
  assert.strictEqual(NY.fmtSlotDate(nyMidnight), 'Jun 23');
  assert.strictEqual(NY.fmtSlotDate('2026-06-23T14:00:00.000Z'), 'Jun 23 10:00');
  assert.strictEqual(GZ.fmtSlotDate('2026-06-23'), 'Jun 23', 'a bare date is the date');
  assert.strictEqual(NONE.fmtSlotDate('2026-06-23T08:00:00.000Z'), 'Jun 23 08:00 UTC');
});
it('"Tomorrow" on a slip becomes the delivery date on the shop\'s clock', () => {
  const at = '2026-08-09T02:00:00.000Z';   // 10:00 on the 9th in Guangzhou, 22:00 on the 8th in New York
  assert.strictEqual(GZ.absolutizeSlot('Tomorrow 10:00–12:00', at), 'Aug 09 10:00–12:00');
  assert.strictEqual(GZ.absolutizeSlot('明天 10:00–12:00', at), '8月9日 10:00–12:00');
  assert.strictEqual(NY.absolutizeSlot('Tomorrow 10:00–12:00', at), 'Aug 08 10:00–12:00');
  assert.strictEqual(GZ.absolutizeSlot('Tomorrow', '2026-08-09'), 'Aug 09', 'a bare date is the date');
});
it('the slip reads the zone checkout uses, and no +8h is left in it', () => {
  assert.ok(/return require\('\.\/delivery-calendar'\)\.deliveryTz\(\);/.test(fnSrc(FEIE, 'slipZone')));
  assert.ok(!/8 \* 3600/.test(strip(FEIE)));
});

console.log('\n2. the customer\'s slot line');
it('every caller passes the shop\'s zone', () => {
  const RETAIL = read('routes/retail.js');
  const calls = strip(RETAIL).match(/(attachSlotDisplay|deliverySlotDisplay)\([^)\n][^\n]*\)/g);
  assert.strictEqual(calls.length, 5, calls.join('\n'));
  for (const c of calls) assert.ok(/deliveryTz\(\)\)/.test(c), c);
  assert.ok(!/GZ_OFFSET_MS|8 \* 3600/.test(strip(read('lib/slot-label.js'))));
});

console.log('\n3. order times served to the screens');
const RETAIL = read('routes/retail.js');
const toShopLocalTs = new Function('businessDate', 'deliveryTz', 'BARE_UTC_TS_RE',
  `${fnSrc(RETAIL, 'toShopLocalTs')}\nreturn toShopLocalTs;`)(
  businessDate, () => 'Asia/Shanghai', /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
it('a stored UTC stamp is served on the shop\'s clock, daylight saving included', () => {
  assert.strictEqual(toShopLocalTs('2026-10-18 23:30:00'), '2026-10-19 07:30:00', 'Roots\' unchanged');
  assert.strictEqual(toShopLocalTs('2026-07-01 12:00:00', 'America/New_York'), '2026-07-01 08:00:00');
  assert.strictEqual(toShopLocalTs('2026-12-01 12:00:00', 'America/New_York'), '2026-12-01 07:00:00');
  assert.strictEqual(toShopLocalTs('2026-10-18 23:30:00', null), '2026-10-18 23:30:00', 'no zone: as stored');
  assert.strictEqual(toShopLocalTs('2026-10-18T23:30:00Z'), '2026-10-18T23:30:00Z', 'an ISO instant passes through');
  assert.ok(/const tz = deliveryTz\(\);\n {2}for \(const f of fields\) \{\n {4}if \(row\[f\] != null\) row\[f\] = toShopLocalTs\(row\[f\], tz\);/.test(fnSrc(RETAIL, 'localizeTimes')),
    'a row reads the zone once');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
