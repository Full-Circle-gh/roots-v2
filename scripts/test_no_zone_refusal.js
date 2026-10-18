#!/usr/bin/env node
/**
 * test_no_zone_refusal.js — a shop with no readable timezone does no work on a
 * shop-local clock (decisions §82, step 3).
 *
 *   node scripts/test_no_zone_refusal.js
 *
 * WHAT IT GUARDS. Until step 3, a shop with no zone had every date, cutoff and
 * reminder judged on Guangzhou's clock, and nothing looked wrong. Now:
 *   • customer checkout refuses — the quote, placing an order, and both halves
 *     of a reschedule — with the live "store is closed" wording, before
 *     anything is reserved or written;
 *   • every job that acts at a shop-local hour does nothing for that shop
 *     (ship-day reminder, 发票 reminder, low-stock digest, booked-day reminder,
 *     kitchen prep preview, kitchen morning request, auto-deliver off an ETA),
 *     and says so ONCE, not every minute.
 * The sweeps' own suites run each one with and without a zone; this one pins
 * the shared guard, the checkout refusal, and that every job asks it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DB_SRC = read('database.js');
const zoneCheck = require(path.join(ROOT, 'lib', 'tenant-zone-check'));

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const quiet = () => { const said = []; return { said, warn: (s) => said.push(s) }; };

(async () => {
  console.log('\n1. the shared guard');
  await it('a real zone passes; none, blank or a misspelling is refused', () => {
    const log = quiet();
    assert.strictEqual(zoneCheck.zoneRefused('Asia/Shanghai', 1, 't1', log), false);
    assert.strictEqual(zoneCheck.zoneRefused(null, 1, 't1', log), true);
    assert.strictEqual(zoneCheck.zoneRefused('', 1, 't1', log), true);
    assert.strictEqual(zoneCheck.zoneRefused('Asia/Shangai', 1, 't1', log), true);
  });
  await it('it says so ONCE per shop and job — these jobs tick every minute', () => {
    const log = quiet();
    for (let i = 0; i < 5; i++) zoneCheck.zoneRefused(null, 9, 'job.a', log);
    zoneCheck.zoneRefused(null, 9, 'job.b', log);
    zoneCheck.zoneRefused(null, 10, 'job.a', log);
    assert.strictEqual(log.said.length, 3, log.said.join('\n'));
    assert.ok(/job\.a is not running for tenant 9: its timezone is missing/.test(log.said[0]), log.said[0]);
    assert.ok(/Settings → Stores/.test(log.said[0]), 'and names where to fix it');
  });

  console.log('\n2. customer checkout refuses');
  const SRC = read('routes/retail.js');
  const i = SRC.indexOf('function refuseWithoutShopZone(res)');
  const fnSrc = SRC.slice(i, SRC.indexOf('\n}\n', i) + 2);
  let TZ = null;
  const refuse = new Function('zoneCheck', 'deliveryTz', 'currentTenantId', fnSrc + '\nreturn refuseWithoutShopZone;')(
    zoneCheck, () => TZ, () => 1);
  const res = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  await it('a shop with no zone: 503, its own error code, and the live "closed" wording in both languages', () => {
    TZ = null;
    const r = res();
    assert.strictEqual(refuse(r), true);
    assert.strictEqual(r.code, 503);
    assert.strictEqual(r.body.error, 'shop_timezone_missing');
    assert.strictEqual(r.body.message_cn, '本店当前已打烊,暂停接单,敬请谅解。');
    assert.ok(SRC.includes("message_cn: _m.message_cn || '本店当前已打烊,暂停接单,敬请谅解。'"),
      'the Chinese is the store_closed refusal\'s own, not a new string');
  });
  await it('a misspelt zone is refused the same way; a real one is let through untouched', () => {
    TZ = 'Asia/Shangai';
    assert.strictEqual(refuse(res()), true);
    TZ = 'Asia/Shanghai';
    const r = res();
    assert.strictEqual(refuse(r), false);
    assert.strictEqual(r.code, null, 'nothing is sent');
  });
  const routeHead = (sig) => {
    const at = SRC.indexOf(sig);
    assert.ok(at > 0, 'route not found: ' + sig);
    return SRC.slice(at, at + 1600);
  };
  for (const [sig, what] of [
    ["router.post('/api/retail/checkout/quote',", 'the checkout quote (its delivery slots)'],
    ["router.get('/api/retail/orders/:id/reschedule-options',", 'the reschedule options'],
    ["router.post('/api/retail/orders/:id/reschedule',", 'the reschedule itself'],
  ]) {
    await it(what + ' refuses first, before reading anything', () => {
      const head = routeHead(sig);
      const firstLine = head.split('\n')[1];
      assert.ok(/if \(refuseWithoutShopZone\(res\)\) return;/.test(firstLine), firstLine);
    });
  }
  await it('placing an order refuses before anything is reserved or written', () => {
    const head = routeHead("router.post('/api/retail/orders', requireRetailAuth");
    const at = head.indexOf('if (refuseWithoutShopZone(res)) return;');
    assert.ok(at > 0, 'the order route asks');
    assert.ok(at < head.indexOf('const items'), 'before the basket is even read');
  });

  console.log('\n3. every shop-local job asks first');
  for (const [file, job] of [
    ['lib/delivery-reminders.js', 'ship.reminder'], ['lib/fapiao-reminders.js', 'fapiao.reminder'],
    ['lib/low-stock-digest.js', 'lowstock.digest'], ['lib/booked-day-reminder.js', 'booked.reminder'],
    ['lib/kitchen-prep-preview.js', 'kitchen.prep.preview'], ['lib/kitchen-morning-request.js', 'kitchen.morning.request'],
    ['routes/retail.js', 'auto.deliver'],
  ]) {
    await it(`${job} (${file})`, () => {
      assert.ok(read(file).includes(`zoneRefused(`) && read(file).includes(`'${job}')`), job + ' does not ask the guard');
    });
  }
  await it('the ship-day reminder, run for real on a shop with no zone, sends nothing', () => {
    const db = addTables(openMemoryDb(), DB_SRC, DB_SRC, ['retail_orders', 'retail_stores', 'storefront_config']);
    db.prepare(`INSERT INTO retail_orders (id, order_no, status, fulfillment_type, subtotal, total, scheduled_for)
                VALUES (1, 'TC1', 'paid', 'delivery', 10, 10, '2026-10-18')`).run();
    const dr = require(path.join(ROOT, 'lib', 'delivery-reminders'));
    assert.strictEqual(dr.sweepDbOnce(db, new Date('2026-10-18T05:00:00Z'), 77), 0);
    assert.strictEqual(db.prepare('SELECT reminder_ship_sent_at AS s FROM retail_orders WHERE id = 1').get().s, null,
      'and claims nothing, so it goes the day the zone is set');
  });
  await it('the booked-day reminder and the kitchen morning request skip it, by name', async () => {
    const db = addTables(openMemoryDb(), DB_SRC, DB_SRC, ['retail_stores', 'storefront_config']);
    const booked = require(path.join(ROOT, 'lib', 'booked-day-reminder'));
    const r = await booked.runBookedReminder(db, { ready: () => true, send: () => Promise.resolve({ ok: true }), zone: null });
    assert.deepStrictEqual(r, { skipped: 'no_timezone' });
    const morning = require(path.join(ROOT, 'lib', 'kitchen-morning-request'));
    assert.deepStrictEqual(morning.raiseMorningRequest(db, { genRsNumber: () => 'X' }), { skipped: 'no_timezone' });
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
