#!/usr/bin/env node
/**
 * §285 — a late parcel is flagged while it is still on the road.
 *
 *   node scripts/test_running_late_alert.js
 *
 * WHAT WENT WRONG. The late-parcel alert asked "did it ARRIVE late?", which
 * can only be answered once it has arrived — so the shop heard about a late
 * delivery when the customer already had the box. Ash: "we should know it
 * before."
 *
 * THE PROPERTY THAT MATTERS MOST is the handoff: a parcel "running late N days"
 * today that lands today is exactly a parcel the §98 late case opens on, N days
 * late. Same deadline, same day arithmetic — the two rules can never disagree
 * about where the line is.
 *
 * READS AND AN IN-MEMORY DATABASE — no browser, so this is in the FAST shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
// Every shop in this suite is a Guangzhou shop, and says so (§82): the rules
// take the shop's zone and day shift, and there is no default to lean on. The
// real module, with Guangzhou passed wherever a call here leaves it out.
const GZ_TZ = 'Asia/Shanghai';
const GZ_SHIFT = require('../lib/business-date').sqlDayShift(GZ_TZ);
const dc = Object.assign(Object.create(require('../lib/delay-case')), {
  lateDays: (s, tz = GZ_TZ) => require('../lib/delay-case').lateDays(s, tz),
  runningLateDays: (s, now = new Date(), tz = GZ_TZ) => require('../lib/delay-case').runningLateDays(s, now, tz),
  lateAfterSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').lateAfterSql(a, sh),
  attemptedOnTimeSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').attemptedOnTimeSql(a, sh),
  lateShipmentSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').lateShipmentSql(a, sh),
  runningLateSql: (a, today = null, sh = GZ_SHIFT) => require('../lib/delay-case').runningLateSql(a, today, sh),
  runningLateSinceSql: (a, sh = GZ_SHIFT) => require('../lib/delay-case').runningLateSinceSql(a, sh),
  runningLateNeedsCallSql: (a, today = null, now = "datetime('now')", sh = GZ_SHIFT) =>
    require('../lib/delay-case').runningLateNeedsCallSql(a, today, now, sh),
});
const alerts = require('../lib/delivery-alerts');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const ORDERS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// Every date here is fixed: the rule is about calendar days, and a suite that
// reads the wall clock answers differently at midnight.
const NOW = new Date('2026-09-28T03:00:00Z');   // 11:00 Shanghai, the 28th
const TODAY_SQL = "'2026-09-28'";

console.log('the rule');

it('an air parcel sent on the 26th is on time on the 27th and one day late on the 28th', () => {
  const s = { mode: 'air', dispatched_at: '2026-09-26 02:00:00' };
  assert.strictEqual(dc.runningLateDays(s, new Date('2026-09-27T09:00:00Z')), 0);
  assert.strictEqual(dc.runningLateDays(s, NOW), 1);
});

it('land keeps its three days', () => {
  assert.strictEqual(dc.runningLateDays({ mode: 'land', dispatched_at: '2026-09-25 02:00:00' }, NOW), 0);
  assert.strictEqual(dc.runningLateDays({ mode: 'land', dispatched_at: '2026-09-24 02:00:00' }, NOW), 1);
});

it('a delivered parcel is never running late — the late case owns it then', () => {
  assert.strictEqual(dc.runningLateDays({ mode: 'air', dispatched_at: '2026-09-20', delivered_at: '2026-09-27' }, NOW), 0);
  assert.strictEqual(dc.runningLateDays({ mode: 'air', dispatched_at: '2026-09-20', tracking_status: 'delivered' }, NOW), 0);
});

it('a supplier parcel, or one never sent, never counts', () => {
  assert.strictEqual(dc.runningLateDays({ mode: 'supplier', dispatched_at: '2026-09-20' }, NOW), 0);
  assert.strictEqual(dc.runningLateDays({ mode: 'air' }, NOW), 0);
});

it('old parcels nobody closed do not flood the card (the cutover)', () => {
  assert.strictEqual(dc.runningLateDays({ mode: 'air', dispatched_at: '2026-09-01' }, NOW), 0);
});

console.log('the database says the same thing');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE retail_delay_cases (id INTEGER PRIMARY KEY, shipment_id INTEGER);
    CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
      dispatched_at TEXT, delivered_at TEXT, tracking_status TEXT, tracking_synced_at TEXT,
      tracking_number TEXT, waybill_product TEXT, waybill_product_no TEXT,
      running_late_contacted_at TEXT, running_late_contacted_by TEXT,
      tracking_no_contact_first_event TEXT);`);
  return db;
}
const PARCELS = [
  { mode: 'air',   dispatched_at: '2026-09-26 02:00:00' },   // 1 day late
  { mode: 'air',   dispatched_at: '2026-09-27 02:00:00' },   // on time
  { mode: 'local', dispatched_at: '2026-09-25 02:00:00' },   // 2 days late
  { mode: 'land',  dispatched_at: '2026-09-24 02:00:00' },   // 1 day late
  { mode: 'land',  dispatched_at: '2026-09-26 02:00:00' },   // on time
  { mode: 'air',   dispatched_at: '2026-09-20 02:00:00', delivered_at: '2026-09-27 02:00:00' },
  { mode: 'air',   dispatched_at: '2026-09-01 02:00:00' },   // before the cutover
];

it('runningLateSql and runningLateDays agree on every parcel', () => {
  const db = fixture();
  const ins = db.prepare('INSERT INTO retail_shipments (id, order_id, mode, dispatched_at, delivered_at) VALUES (?,?,?,?,?)');
  PARCELS.forEach((p, i) => ins.run(i + 1, i + 1, p.mode, p.dispatched_at, p.delivered_at || null));
  const sqlHits = db.prepare(`SELECT id FROM retail_shipments s WHERE ${dc.runningLateSql('s', TODAY_SQL)} ORDER BY id`)
    .all().map((r) => r.id);
  const jsHits = PARCELS.map((p, i) => (dc.runningLateDays(p, NOW) > 0 ? i + 1 : null)).filter(Boolean);
  assert.deepStrictEqual(sqlHits, jsHits);
  assert.deepStrictEqual(sqlHits, [1, 3, 4]);
});

it('the handoff: running late N days today, and landing today, is exactly N days late', () => {
  // Parcels inside the cutover: an old one is out of scope for the warning by
  // design, and the §98 case has its own cutover for the same reason.
  for (const p of PARCELS.filter((x) => !x.delivered_at && x.dispatched_at >= '2026-09-20')) {
    const running = dc.runningLateDays(p, NOW);
    const landed = dc.lateDays({ ...p, delivered_at: '2026-09-28 05:00:00' });
    assert.strictEqual(landed, running, JSON.stringify(p));
  }
});

it('the card counts the order while it is dispatched, and drops it once it lands', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status) VALUES (1, 'dispatched'), (2, 'delivered')").run();
  db.prepare("INSERT INTO retail_shipments (order_id, mode, dispatched_at) VALUES (1, 'air', '2026-09-26 02:00:00'), (2, 'air', '2026-09-26 02:00:00')").run();
  // The route's SQL reads DATE('now'); swap in the pinned day to judge it.
  const sql = alerts.runningLateAlertSql('o', GZ_SHIFT).replace("DATE('now')", TODAY_SQL);
  assert.deepStrictEqual(db.prepare(`SELECT id FROM retail_orders o WHERE ${sql}`).all().map((r) => r.id), [1]);
});

it('it is one of the parts of "Delivery needs a call", so the list and the count include it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delivery-alerts.js'), 'utf8');
  assert.match(src, /const parts = \[[^\]]*runningLateAlertSql\(alias, shift\)/);
});

console.log('"customer contacted" (§427)');

// The card's SQL reads the wall clock twice; pin both to NOW.
const pinned = (sql) => sql.replace(/DATE\('now'\)/g, TODAY_SQL).replace(/datetime\('now'\)/g, "'2026-09-28 03:00:00'");

it('a contacted order leaves the card, and comes back 48 hours later if still on the road', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status) VALUES (1, 'dispatched'), (2, 'dispatched'), (3, 'dispatched')").run();
  db.prepare(`INSERT INTO retail_shipments (order_id, mode, dispatched_at, running_late_contacted_at, running_late_contacted_by) VALUES
    (1, 'air', '2026-09-26 02:00:00', NULL, NULL),
    (2, 'air', '2026-09-26 02:00:00', '2026-09-27 03:00:01', 'lily'),
    (3, 'air', '2026-09-26 02:00:00', '2026-09-26 03:00:00', 'lily')`).run();
  const sql = pinned(alerts.runningLateAlertSql('o', GZ_SHIFT));
  // 1: nobody rang. 2: rung 47h59m ago, still answers. 3: rung 48h ago, asks again.
  assert.deepStrictEqual(db.prepare(`SELECT id FROM retail_orders o WHERE ${sql}`).all().map((r) => r.id), [1, 3]);
});

it('the contact stays on the parcel whether or not it is current, so the screen can say who rang last', () => {
  assert.strictEqual(dc.runningLateContact({}, NOW), null);
  assert.deepStrictEqual(
    dc.runningLateContact({ running_late_contacted_at: '2026-09-27 03:00:01', running_late_contacted_by: 'lily' }, NOW),
    { at: '2026-09-27 03:00:01', by: 'lily', current: true });
  assert.strictEqual(dc.runningLateContact({ running_late_contacted_at: '2026-09-26 03:00:00' }, NOW).current, false);
});

it('runningLateNeedsCallSql and runningLateContact agree on where 48 hours ends', () => {
  const db = fixture();
  const stamps = [null, '2026-09-28 02:59:00', '2026-09-27 03:00:01', '2026-09-26 03:00:00', '2026-09-20 00:00:00'];
  const ins = db.prepare("INSERT INTO retail_shipments (id, order_id, mode, dispatched_at, running_late_contacted_at) VALUES (?, 1, 'air', '2026-09-26 02:00:00', ?)");
  stamps.forEach((t, i) => ins.run(i + 1, t));
  const sqlHits = db.prepare(`SELECT id FROM retail_shipments s WHERE ${pinned(dc.runningLateNeedsCallSql('s'))} ORDER BY id`)
    .all().map((r) => r.id);
  const jsHits = stamps.map((t, i) => {
    const c = dc.runningLateContact({ running_late_contacted_at: t }, NOW);
    return c && c.current ? null : i + 1;
  }).filter(Boolean);
  assert.deepStrictEqual(sqlHits, jsHits);
  assert.deepStrictEqual(sqlHits, [1, 4, 5]);
});

it('the stamp answers the call, not the lateness: the parcel is still running late', () => {
  const s = { mode: 'air', dispatched_at: '2026-09-26 02:00:00', running_late_contacted_at: '2026-09-28 02:00:00' };
  assert.strictEqual(dc.runningLateDays(s, NOW), 1);
});

it('the route stamps only parcels running late, and the undo is the same route', () => {
  assert.match(RETAIL, /router\.post\('\/api\/retail-admin\/orders\/:id\/running-late\/ack'/);
  const route = RETAIL.slice(RETAIL.indexOf("orders/:id/running-late/ack'"));
  assert.match(route.slice(0, 2500), /const LATE = delayCase\.runningLateSql\(null, null, shopSqlShift\(\)\);/);
  assert.match(route.slice(0, 2500), /running_late_contacted_by = \?/);
  assert.match(route.slice(0, 2500), /running_late_contacted_at = NULL/);
});

it('both screens have the button and the undo, and the list says "customer contacted"', () => {
  assert.match(ORDERS, /ackRunningLate\(\$\{Number\(o\.id\)\}, true, event\)/);
  assert.match(ORDERS, /ackRunningLate\(\$\{Number\(o\.id\)\}, false, event\)/);
  assert.match(ORDERS, /o\.running_late_contacted/);
  assert.match(MHTML, /APP\.cmd\('ackRunningLate',1\)/);
  assert.match(MHTML, /APP\.cmd\('ackRunningLate',0\)/);
  assert.match(MHTML, /\/running-late\/ack/);
  assert.match(MHTML, /r\.running_late_contacted/);
  assert.match(MHTML, /runningLateContact:sp\.running_late_contact/);
  assert.match(RETAIL, /AS running_late_contacted,/);
  assert.match(RETAIL, /running_late_contact: o\.status === 'dispatched'/);
});

console.log('the wiring');

it('the server sends it to the card, the list and the parcel', () => {
  assert.match(RETAIL, /running_late:\s*1,/);
  assert.match(RETAIL, /running_late: tdb\(\)\.prepare/);
  assert.match(RETAIL, /AS running_late_days,/);
  assert.match(RETAIL, /running_late_days: o\.status === 'dispatched' \? delayCase\.runningLateDays\(s, new Date\(\), deliveryTz\(\)\) : 0/);
});

it('both screens show it on Needs-you, the list and the parcel', () => {
  assert.match(DASH, /da\.running_late/);
  assert.match(ORDERS, /o\.running_late_days/);
  assert.match(ORDERS, /\$\{runningLateBanner\}/);
  assert.match(MHTML, /delivery_alerts\.running_late/);
  assert.match(MHTML, /r\.running_late_days/);
  assert.match(MHTML, /runningLate:sp\.running_late_days/);
});

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`);
