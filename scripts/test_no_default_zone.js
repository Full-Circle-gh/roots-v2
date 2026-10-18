#!/usr/bin/env node
/**
 * test_no_default_zone.js — there is no house time zone (decisions §82, step 3
 * full, 2026-10-18).
 *
 *   node scripts/test_no_default_zone.js
 *
 * WHAT IT GUARDS. Until step 3 full, every place that turned an instant into a
 * shop's day or hour answered a missing or unreadable zone with Guangzhou's —
 * lib/business-date.js, the pickup clock in routes/retail.js, the opening-hours
 * gate the channel daemons use (lib/store-hours.js, a fixed +8), the
 * stale-sync count (lib/channel-sync-stale.js, a fixed +8), the finance day
 * boundary (lib/finance-window.js, '+8 hours'), and the delay-case SQL builders
 * (a Guangzhou shift computed at module load). That is how a shop with no zone
 * ran looking right. Now:
 *   • a zone is the location's own when readable, else the shop's;
 *   • neither is NoShopTimezoneError (code shop_timezone_missing), which a
 *     screen answers with 503 by name and without paging ops;
 *   • customer pages degrade (no batch line, no reschedule button) rather than
 *     fail; QR-menu orders are refused in checkout's words;
 *   • hours with no zone are CLOSED to the channel daemons.
 * The places that fall back are pinned here, and so is their absence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const B = require(path.join(ROOT, 'lib', 'business-date'));
const DB_SRC = read('database.js');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const refused = (fn) => assert.throws(fn, (e) => e.code === 'shop_timezone_missing');

(async () => {
  console.log('\n1. the date helpers have no house zone');
  await it('null, blank and misspelt zones are refused by every helper, by name', () => {
    for (const z of [null, undefined, '', ' ', 'Asia/Shangai', 'Asia/Guangzhou']) {
      refused(() => B.businessDate(z));
      refused(() => B.zoneParts(z));
      refused(() => B.dateInZone(z, '2026-10-18', 9, 0));
      refused(() => B.zoneOffsetMinutes(z));
      refused(() => B.sqlDayShift(z));
      refused(() => B.wallClockOnDay(z, new Date(), 9, 0));
    }
  });
  await it('a real zone still answers exactly as before', () => {
    assert.strictEqual(B.businessDate('Asia/Shanghai', new Date('2026-10-18T17:00:00Z')), '2026-10-19');
    assert.strictEqual(B.sqlDayShift('Asia/Shanghai'), '+480 minutes');
    assert.strictEqual(B.zoneParts('Europe/London', new Date('2026-10-18T12:00:00Z')).hour, 13);
  });
  await it('the source carries no fallback zone any more', () => {
    const src = strip(read('lib/business-date.js'));
    assert.ok(!/:\s*SYSTEM_DEFAULT_TZ/.test(src), 'a "? … : SYSTEM_DEFAULT_TZ" fallback is back');
    assert.ok(!/8 \* 3600000/.test(src), 'a hand-applied +8 is back');
  });

  console.log('\n2. a location\'s zone is its own, else the shop\'s');
  const db = addTables(openMemoryDb(), DB_SRC, DB_SRC, ['retail_stores', 'storefront_config']);
  db.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone) VALUES (1, 'a', 'A', 'A', 1, 0, 'Europe/London')").run();
  db.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone) VALUES (2, 'b', 'B', 'B', 1, 1, NULL)").run();
  db.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone) VALUES (3, 'c', 'C', 'C', 1, 2, 'Mars/Olympus')").run();
  await it('a store naming a zone keeps it; one with none, or a misspelt one, is in the shop\'s', () => {
    assert.strictEqual(B.zoneForLocation(db, 1), 'Europe/London');
    assert.strictEqual(B.zoneForLocation(db, 2), 'Europe/London', 'the shop\'s zone is its first zoned store\'s');
    assert.strictEqual(B.zoneForLocation(db, 3), 'Europe/London');
  });
  await it('and with no zone anywhere, a location\'s business date is refused — waste, production, QR order codes', () => {
    const bare = addTables(openMemoryDb(), DB_SRC, DB_SRC, ['retail_stores', 'storefront_config']);
    bare.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn, is_active) VALUES (1, 'a', 'A', 'A', 1)").run();
    refused(() => B.businessDateForLocation(bare, 1));
  });

  console.log('\n3. the places that would have broken Roots itself');
  await it('lib/delay-case.js computes nothing at load — it used to work out Guangzhou\'s shift there', () => {
    const src = strip(read('lib/delay-case.js'));
    assert.ok(!/sqlDayShift\(null\)/.test(src));
    const dc = require(path.join(ROOT, 'lib', 'delay-case'));
    assert.throws(() => dc.lateShipmentSql('s'), /pass the shop's day shift/, 'a builder called without the shop\'s shift says so');
    assert.ok(/\+480 minutes/.test(dc.lateShipmentSql('s', '+480 minutes')), 'and with it, builds');
  });
  await it('the checkout stock check takes the shop\'s zone when its caller passes none', () => {
    const src = read('lib/inventory.js');
    assert.ok(/isSameDayDelivery\(deliverySlotId, now, tz === undefined \? businessDate\.shopTimezone\(tdb\(\)\) : tz\)/.test(src));
  });
  await it('the pickup clock reads the store\'s zone only when readable, else the tenant\'s, else refuses', () => {
    const src = read('routes/retail.js');
    assert.ok(/const tz = businessDate\.zoneProblem\(own\) \? deliveryTz\(\) : String\(own\)\.trim\(\);/.test(src));
    const lp = src.slice(src.indexOf('function localPartsInTz'), src.indexOf('\n}\n', src.indexOf('function localPartsInTz')));
    assert.ok(/businessDate\.requireZone\(tz\)/.test(lp) && !/SYSTEM_DEFAULT_TZ/.test(strip(lp)));
  });
  await it('the store-stock screen\'s "added today" uses the store\'s zone, else the shop\'s', () => {
    assert.ok(/const tz = zoneForLocation\(tdb\(\), id\);/.test(read('routes/retail-inventory.js')));
  });

  console.log('\n4. the fixed +8s that stood in for a zone');
  await it('opening hours carry the store\'s zone; hours with none are CLOSED to the daemons', () => {
    const sh = require(path.join(ROOT, 'lib', 'store-hours'));
    const noon = new Date('2026-10-18T04:00:00Z');            // 12:00 Guangzhou
    assert.strictEqual(sh.within({ open: 600, close: 1200, tz: 'Asia/Shanghai' }, { now: noon }), true);
    assert.strictEqual(sh.within({ open: 600, close: 1200, tz: 'Europe/London' }, { now: noon }), false, '05:00 in London');
    assert.strictEqual(sh.within({ open: 600, close: 1200 }, { now: noon }), false, 'no zone: closed, not Guangzhou');
    assert.throws(() => sh.localMinutes(noon), /an offset is required/);
    assert.ok(!/utcOffsetHours = 8/.test(strip(read('lib/store-hours.js'))));
  });
  await it('the daemons\' built-in Guangzhou hours name their zone rather than assume it', () => {
    for (const f of ['scripts/meituan-daemon.js', 'scripts/shangou-daemon.js']) {
      const block = read(f).split('const LEGACY_STORE_HOURS = {')[1].split('};')[0];
      for (const line of block.split('\n').filter((l) => /open:/.test(l))) {
        assert.ok(/tz: 'Asia\/Shanghai'/.test(line), f + ': ' + line.trim());
      }
    }
  });
  await it('the stale-sync count walks the store\'s own days, not fixed +8 ones', () => {
    const src = strip(read('lib/channel-sync-stale.js'));
    assert.ok(!/8 \* 3600_000/.test(src), 'a fixed +8 is back');
    const stale = require(path.join(ROOT, 'lib', 'channel-sync-stale'));
    const t = (iso) => Date.parse(iso);
    assert.strictEqual(stale.pushableElapsedMs(t('2026-10-18T03:00:00Z'), t('2026-10-18T05:00:00Z'),
      { open: 600, close: 1200, syncStart: null }, 0), 0, 'hours with no zone push nothing — the gate is closed');
  });
  await it('the finance day boundary is required, not \'+8 hours\'', () => {
    const fw = require(path.join(ROOT, 'lib', 'finance-window'));
    assert.throws(() => fw.odateFor(), /no default boundary/);
    assert.ok(!/shift \|\| TZ/.test(strip(read('lib/gzgrocery-billing.js'))));
  });

  console.log('\n5. what a shop with no zone sees');
  await it('a screen that reaches it answers 503 by name, and does not page', () => {
    const { routeErrorHandler } = require(path.join(ROOT, 'lib', 'route-error'));
    let paged = 0, code = null, body = null;
    const res = { headersSent: false, status(c) { code = c; return this; }, json(b) { body = b; return this; }, send() { return this; } };
    const err = new B.NoShopTimezoneError(null);
    routeErrorHandler({ page: () => { paged++; } })(err, { method: 'GET', originalUrl: '/api/x', path: '/api/x' }, res, () => {});
    assert.deepStrictEqual([code, body.error, paged], [503, 'shop_timezone_missing', 0]);
  });
  await it('customer pages leave the time-bound piece off rather than fail', () => {
    const src = read('routes/retail.js');
    const dfb = src.slice(src.indexOf('function decorateFreshBatch'), src.indexOf('function decorateFreshBatch') + 600);
    assert.ok(/if \(businessDate\.zoneProblem\(tz\)\) return rows;/.test(dfb), 'the product card carries no batch line');
    const re = src.slice(src.indexOf('function rescheduleEligibility'), src.indexOf('function rescheduleEligibility') + 1200);
    assert.ok(/if \(businessDate\.zoneProblem\(tz\)\) return block\('shop_timezone_missing', false\);/.test(re), 'the order page offers no reschedule');
  });
  await it('a QR-menu order is refused in checkout\'s words, with nothing written', () => {
    const src = read('routes/shop-menu.js');
    const at = src.indexOf("if (e && e.code === 'shop_timezone_missing')");
    assert.ok(at > 0);
    assert.ok(src.slice(at, at + 600).includes("message_cn: '本店当前已打烊,暂停接单,敬请谅解。'"));
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
