#!/usr/bin/env node
/**
 * §437 — a parcel is late on the SHOP's calendar, and not at all if the
 * courier tried on time and nobody answered.
 *
 *   node scripts/test_late_shop_day.js
 *
 * WHAT WENT WRONG. TC000919, an air parcel, was flagged one day late. Two
 * holes, either enough on its own:
 *   1. The rule took the UTC date of UTC timestamps. Guangzhou's day starts
 *      eight hours earlier, so a parcel handed over before 08:00 was dated the
 *      day before and judged a day short.
 *   2. The courier rang on the due day and got no answer. The parcel landed
 *      after that, and the rule saw only the landing.
 *
 * THE PROPERTY THAT MATTERS: the SQL (card, list, customer message) and the
 * JS (drawer) give the same answer for every case here. And a case somebody
 * already started keeps the answer it was started under.
 *
 * READS AND AN IN-MEMORY DATABASE — no browser, so this is in the FAST shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dc = require('../lib/delay-case');
const alerts = require('../lib/delivery-alerts');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DBJS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const SH = 'Asia/Shanghai';
const SHIFT = '+480 minutes';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_shipments (
             id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT, dispatched_at TEXT,
             delivered_at TEXT, tracking_status TEXT, tracking_synced_at TEXT,
             tracking_number TEXT, waybill_product TEXT, waybill_product_no TEXT,
             tracking_events_json TEXT,
             tracking_no_contact_event TEXT, tracking_no_contact_seen_at TEXT,
             tracking_no_contact_first_event TEXT, running_late_contacted_at TEXT);
           CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, tracking_events_json TEXT,
             tracking_no_contact_event TEXT, tracking_no_contact_seen_at TEXT,
             tracking_no_contact_first_event TEXT);
           CREATE TABLE retail_delay_cases (
             id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, shipment_id INTEGER);`);
  return db;
}

const COLS = ['mode', 'dispatched_at', 'delivered_at', 'tracking_status', 'tracking_synced_at',
  'tracking_no_contact_first_event'];
function insert(db, row) {
  const r = db.prepare(
    `INSERT INTO retail_shipments (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`
  ).run(...COLS.map(c => row[c] == null ? null : row[c]));
  return r.lastInsertRowid;
}
const lateInSql = (db, id) => !!db.prepare(
  `SELECT 1 FROM retail_shipments WHERE id = ? AND ${dc.lateShipmentSql(null, SHIFT)}`).get(id);

// One parcel, both renderings. Returns the JS days; asserts the SQL agrees.
function judge(row, { withCase = false } = {}) {
  const db = fixture();
  const id = insert(db, row);
  if (withCase) db.prepare('INSERT INTO retail_delay_cases (order_id, shipment_id) VALUES (1, ?)').run(id);
  const days = dc.lateDays({ ...row, delay_case: withCase ? { id: 1 } : null }, SH);
  assert.strictEqual(lateInSql(db, id), days > 0,
    `SQL says ${lateInSql(db, id) ? 'late' : 'on time'}, JS says ${days} day(s)`);
  return days;
}

console.log('the shop\'s calendar');

it('handed over at 07:00 on the 4th, landed at 10:00 on the 5th: next day, on time', () => {
  // 07:00 Shanghai on the 4th is 23:00 UTC on the 3rd. By UTC days this was
  // "sent the 3rd, due the 4th, one day late" — the TC000919 shape.
  assert.strictEqual(judge({ mode: 'air', dispatched_at: '2026-10-03 23:00:00',
    delivered_at: '2026-10-05 02:00:00' }), 0);
});

it('a genuinely late parcel is still caught', () => {
  assert.strictEqual(judge({ mode: 'air', dispatched_at: '2026-10-04 02:00:00',
    delivered_at: '2026-10-06 02:00:00' }), 1);
});

it('a landing at 01:00 Shanghai counts on the shop\'s day, not UTC\'s', () => {
  // Sent 10:00 on the 4th, landed 01:00 on the 6th (17:00 UTC on the 5th).
  // UTC called that on time; the shop's day says one day late.
  assert.strictEqual(judge({ mode: 'air', dispatched_at: '2026-10-04 02:00:00',
    delivered_at: '2026-10-05 17:00:00' }), 1);
});

it('JD\'s delivered-without-delivered_at shape is read on the shop\'s day too', () => {
  assert.strictEqual(judge({ mode: 'air', dispatched_at: '2026-10-03 23:00:00',
    tracking_status: 'delivered', tracking_synced_at: '2026-10-05 02:00:00' }), 0);
});

it('land keeps its three days, on the shop\'s calendar', () => {
  assert.strictEqual(judge({ mode: 'land', dispatched_at: '2026-10-01 23:00:00',
    delivered_at: '2026-10-05 02:00:00' }), 0);
  assert.strictEqual(judge({ mode: 'land', dispatched_at: '2026-10-01 23:00:00',
    delivered_at: '2026-10-06 02:00:00' }), 1);
});

console.log('the courier tried on time');

const LANDED_LATE = { mode: 'air', dispatched_at: '2026-10-04 02:00:00',
  tracking_status: 'delivered', tracking_synced_at: '2026-10-06 03:00:00' };

it('a failed call on the due day means the parcel was not late', () => {
  assert.strictEqual(judge(LANDED_LATE), 1, 'without the call it is a day late');
  assert.strictEqual(judge({ ...LANDED_LATE, tracking_no_contact_first_event: '2026-10-05 17:30:00' }), 0);
});

it('a failed call before the due day counts too', () => {
  assert.strictEqual(judge({ ...LANDED_LATE, tracking_no_contact_first_event: '2026-10-04 19:00:00' }), 0);
});

it('a failed call AFTER the due day does not excuse it', () => {
  assert.strictEqual(judge({ ...LANDED_LATE, tracking_no_contact_first_event: '2026-10-06 09:00:00' }), 1);
});

it('the FIRST failed call is the one stamped, and a later one never moves it', () => {
  const db = fixture();
  const id = insert(db, { mode: 'air', dispatched_at: '2026-10-04 02:00:00' });
  const evs = [
    { time: '2026-10-07 10:00:00', description_cn: '快递员联系收件人无人接听' },
    { time: '2026-10-05 17:30:00', description_cn: '电话无人接听，请回电' },
    { time: '2026-10-05 09:00:00', description_cn: '正在派送' },
  ];
  assert.strictEqual(alerts.stampNoContact(db, 'retail_shipments', id, evs), true);
  const row = db.prepare('SELECT * FROM retail_shipments WHERE id = ?').get(id);
  assert.strictEqual(row.tracking_no_contact_event, '2026-10-07 10:00:00', '§284 still holds the newest');
  assert.strictEqual(row.tracking_no_contact_first_event, '2026-10-05 17:30:00');
  alerts.stampFirstNoContact(db, 'retail_shipments', id, [
    { time: '2026-10-08 10:00:00', description_cn: '无人接听' }]);
  assert.strictEqual(db.prepare('SELECT tracking_no_contact_first_event AS e FROM retail_shipments')
    .get().e, '2026-10-05 17:30:00', 'a later call never replaces the first');
});

it('a courier who only scanned "out for delivery" is not excused', () => {
  assert.strictEqual(alerts.firstNoContactEvent([
    { time: '2026-10-05 09:00:00', description_cn: '正在派送' }]), null);
});

console.log('a case already started keeps its answer');

it('a parcel the old rule called late, with a case open, stays late', () => {
  const row = { mode: 'air', dispatched_at: '2026-10-03 23:00:00', delivered_at: '2026-10-05 02:00:00' };
  assert.strictEqual(judge(row), 0, 'untouched, the new rule clears it');
  assert.strictEqual(judge(row, { withCase: true }), 1, 'started, the chase stays on the card');
});

it('the same holds for the courier-tried exception', () => {
  const row = { ...LANDED_LATE, tracking_no_contact_first_event: '2026-10-05 17:30:00' };
  assert.strictEqual(judge(row, { withCase: true }), 1);
});

console.log('running late');

it('running late counts the shop\'s today', () => {
  const s = { mode: 'air', dispatched_at: '2026-10-03 23:00:00' };   // the 4th, Shanghai
  assert.strictEqual(dc.runningLateDays(s, new Date('2026-10-05T15:00:00Z'), SH), 0, '23:00 on the 5th');
  assert.strictEqual(dc.runningLateDays(s, new Date('2026-10-05T16:30:00Z'), SH), 1, '00:30 on the 6th');
});

it('the SQL agrees, and a courier who tried on time is not running late', () => {
  const db = fixture();
  const plain = insert(db, { mode: 'air', dispatched_at: '2026-10-03 23:00:00' });
  const tried = insert(db, { mode: 'air', dispatched_at: '2026-10-03 23:00:00',
    tracking_no_contact_first_event: '2026-10-05 17:30:00' });
  const ids = db.prepare(`SELECT id FROM retail_shipments WHERE ${dc.runningLateSql(null, "'2026-10-06'", SHIFT)}`)
    .all().map(r => r.id);
  assert.deepStrictEqual(ids, [plain]);
  assert.strictEqual(dc.runningLateDays({ mode: 'air', dispatched_at: '2026-10-03 23:00:00',
    tracking_no_contact_first_event: '2026-10-05 17:30:00' }, new Date('2026-10-06T03:00:00Z'), SH), 0);
  assert.ok(tried);
});

it('running late starts at midnight on the shop\'s clock', () => {
  const db = fixture();
  insert(db, { mode: 'air', dispatched_at: '2026-10-03 23:00:00' });
  const since = db.prepare(`SELECT ${dc.runningLateSinceSql(null, SHIFT)} AS t FROM retail_shipments`).get().t;
  assert.strictEqual(since, '2026-10-05 16:00:00', '00:00 on the 6th in Shanghai');
});

console.log('wiring');

it('every late-rule query in the routes is given the shop\'s day', () => {
  const calls = RETAIL.match(/delayCase\.(lateShipmentSql|lateAfterSql|runningLateSql|runningLateNeedsCallSql|runningLateSinceSql)\([^)]*\)/g) || [];
  assert.ok(calls.length >= 8, `found ${calls.length}`);
  for (const c of calls) assert.match(c, /shopSqlShift\(\)/, c);
  assert.doesNotMatch(RETAIL, /julianday\(DATE\('now'\)\)/);
});

it('the drawer is given the shop\'s zone and the case', () => {
  assert.match(RETAIL, /late_days: delayCase\.lateDays\(\{ \.\.\.s, delay_case: delayCase\.readCase\(tdb\(\), s\.id\) \}, deliveryTz\(\)\)/);
  assert.doesNotMatch(RETAIL, /delayCase\.runningLateDays\(s\)/);
});

it('the column is migrated and back-filled from traces already stored', () => {
  assert.match(DBJS, /addColumn\(t, 'tracking_no_contact_first_event', 'TEXT'\)/);
  assert.match(DBJS, /no_contact_first_event_v1/);
});

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`);
