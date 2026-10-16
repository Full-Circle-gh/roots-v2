#!/usr/bin/env node
/**
 * §284 — "The courier couldn't reach the customer" stays on the card until
 * somebody rings them.
 *
 *   node scripts/test_no_contact_alert.js
 *
 * WHAT WENT WRONG. The alert existed and almost never showed. It was read off
 * the NEWEST tracking line only, and a courier who cannot get through writes
 * "无人接听" and then, minutes later, "再次派送" or "妥投" — so the line that
 * raised it was no longer newest by the next sync. And the pattern missed
 * common wordings (电话未接通, 联系客户未果, 关机), which raised nothing at all.
 *
 * READS AND AN IN-MEMORY DATABASE — no browser, so this is in the FAST shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const tracking = require('../lib/tracking');
const alerts = require('../lib/delivery-alerts');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DB_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const ORDERS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

console.log('the wording');

it('every way a courier says "nobody answered" is recognised, by all three readers', () => {
  for (const line of [
    '客户电话无人接听，将再次派送',
    '配送员联系客户未果，将再次派送',
    '联系收件人未果',
    '客户电话未接通',
    '电话无法接通',
    '联系不上收件人',
    '联系不到客户',
    '未能联系上客户',
    '客户电话关机',
    '客户拒接电话',
  ]) {
    assert.strictEqual(tracking.classifyDeliveryEvent(line)?.scenario, 'no_contact', line + ' → scenario');
    assert.strictEqual(tracking.statusFromEventText(line), 'exception', line + ' → status');
    assert.match(tracking.translateEventDescription(line), /could not reach you/i, line + ' → English');
  }
});

it('ordinary lines are not mistaken for it', () => {
  for (const line of ['正在派送', '派送员已联系客户，正在派送', '已妥投', '您的快件已到达广州黄埔营业部']) {
    assert.notStrictEqual(tracking.classifyDeliveryEvent(line)?.scenario, 'no_contact', line);
  }
});

console.log('holding the line');

it('the newest no-answer line anywhere in the trace is found, not just the newest line', () => {
  const ev = alerts.latestNoContactEvent([
    { time: '2026-09-27 15:40:00', description_cn: '配送员正在派送' },
    { time: '2026-09-27 15:10:00', description_cn: '客户电话无人接听，将再次派送' },
    { time: '2026-09-27 11:00:00', description_cn: '客户电话未接通' },
  ]);
  assert.deepStrictEqual(ev, { time: '2026-09-27 15:10:00', text: '客户电话无人接听，将再次派送' });
});

it('lines from before the feature started never raise it (no retroactive flood)', () => {
  assert.strictEqual(alerts.latestNoContactEvent([
    { time: '2026-09-01 10:00:00', description_cn: '客户电话无人接听' },
  ]), null);
});

function fixture() {
  const db = new Database(':memory:');
  const cols = `tracking_number TEXT, tracking_status TEXT, tracking_scenario TEXT, tracking_events_json TEXT,
      tracking_no_contact_event TEXT, tracking_no_contact_seen_at TEXT,
      tracking_no_contact_cleared TEXT, tracking_no_contact_cleared_by TEXT,
      tracking_no_contact_cleared_at TEXT, tracking_no_contact_first_event TEXT`;
  db.exec(`
    CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, status TEXT, ${cols});
    CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER,
      delivered_at TEXT, ${cols});`);
  return db;
}
const onCard = (db) => db.prepare(
  `SELECT id FROM retail_orders o WHERE ${alerts.carrierAlertSql('o')} ORDER BY id`
).all().map((r) => r.id);

const FAILED = [{ time: '2026-09-27 10:00:00', description_cn: '客户电话无人接听' }];
const LATER = [
  { time: '2026-09-27 10:20:00', description_cn: '配送员正在派送' },
  ...FAILED,
];

it('the stamp only moves forward: a re-sync changes nothing, a newer failed call moves it', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_shipments (id, order_id) VALUES (1, 1)").run();
  assert.strictEqual(alerts.stampNoContact(db, 'retail_shipments', 1, FAILED), true);
  assert.strictEqual(alerts.stampNoContact(db, 'retail_shipments', 1, LATER), false);
  assert.strictEqual(alerts.stampNoContact(db, 'retail_shipments', 1, [
    { time: '2026-09-27 16:00:00', description_cn: '客户电话关机' }, ...LATER,
  ]), true);
  assert.strictEqual(db.prepare('SELECT tracking_no_contact_event AS e FROM retail_shipments').get().e,
    '2026-09-27 16:00:00');
});

it('the alert survives the courier\'s next scan — the bug Ash reported', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status, tracking_status, tracking_scenario) VALUES (1, 'dispatched', 'out_for_delivery', 'out_for_delivery')").run();
  db.prepare("INSERT INTO retail_shipments (id, order_id, tracking_status, tracking_scenario) VALUES (1, 1, 'out_for_delivery', 'out_for_delivery')").run();
  assert.deepStrictEqual(onCard(db), [], 'nothing yet');
  alerts.stampNoContact(db, 'retail_shipments', 1, LATER);   // newest line is "正在派送"
  assert.deepStrictEqual(onCard(db), [1]);
});

it('"I called the customer" takes it off; a NEW failed call puts it back', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status) VALUES (1, 'dispatched')").run();
  db.prepare("INSERT INTO retail_shipments (id, order_id) VALUES (1, 1)").run();
  alerts.stampNoContact(db, 'retail_shipments', 1, FAILED);
  db.prepare(`UPDATE retail_shipments SET tracking_no_contact_cleared = tracking_no_contact_event
               WHERE ${alerts.noContactOpenSql()}`).run();
  assert.deepStrictEqual(onCard(db), [], 'answered');
  alerts.stampNoContact(db, 'retail_shipments', 1, [
    { time: '2026-09-27 17:00:00', description_cn: '客户电话未接通' }, ...LATER,
  ]);
  assert.deepStrictEqual(onCard(db), [1], 'a later failed call is a new incident');
});

it('the answered line does not linger as a generic "delivery issue" either', () => {
  // statusFromEventText files a no-answer line as 'exception', so without the
  // step-aside the tap would leave the order on the card for ever.
  const db = fixture();
  db.prepare(`INSERT INTO retail_orders (id, status, tracking_status, tracking_scenario,
      tracking_no_contact_event, tracking_no_contact_cleared)
    VALUES (1, 'dispatched', 'exception', 'no_contact', '2026-09-27 10:00:00', '2026-09-27 10:00:00')`).run();
  assert.deepStrictEqual(onCard(db), []);
});

it('a parcel that landed drops it; a delivered order is off the card', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status) VALUES (1, 'dispatched'), (2, 'delivered')").run();
  db.prepare("INSERT INTO retail_shipments (id, order_id, delivered_at) VALUES (1, 1, '2026-09-27 12:00:00'), (2, 2, NULL)").run();
  alerts.stampNoContact(db, 'retail_shipments', 1, FAILED);
  alerts.stampNoContact(db, 'retail_shipments', 2, FAILED);
  assert.deepStrictEqual(onCard(db), []);
});

it('an order already alerting before its first stamp does not blink off', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status, tracking_status, tracking_scenario) VALUES (1, 'dispatched', 'exception', 'no_contact')").run();
  assert.deepStrictEqual(onCard(db), [1]);
});

it('a plain carrier exception still raises the card as before', () => {
  const db = fixture();
  db.prepare("INSERT INTO retail_orders (id, status, tracking_status) VALUES (1, 'dispatched', 'exception')").run();
  assert.deepStrictEqual(onCard(db), [1]);
});

it('a missed call stamped on the order mirror leaves with the parcel it was on (§482, TC001153)', () => {
  // The mirror held the land waybill when that courier's calls failed, then
  // took the air waybill. The land parcel landed; the air one never failed.
  const db = fixture();
  db.prepare(`INSERT INTO retail_orders (id, status, tracking_number, tracking_status)
    VALUES (1, 'dispatched', 'LAND', 'in_transit')`).run();
  db.prepare(`INSERT INTO retail_shipments (id, order_id, tracking_number, tracking_status)
    VALUES (1, 1, 'LAND', 'in_transit'), (2, 1, 'AIR', 'in_transit')`).run();
  alerts.stampNoContact(db, 'retail_orders', 1, FAILED);
  alerts.stampNoContact(db, 'retail_shipments', 1, FAILED);
  assert.deepStrictEqual(onCard(db), [1], 'while the land parcel is out, it asks');
  db.prepare("UPDATE retail_shipments SET tracking_status = 'delivered' WHERE id = 1").run();
  db.prepare("UPDATE retail_orders SET tracking_number = 'AIR' WHERE id = 1").run();
  assert.deepStrictEqual(onCard(db), [], 'landed — the mirror now names the air parcel, which never failed');
  alerts.stampNoContact(db, 'retail_shipments', 2, [{ time: '2026-09-28 09:00:00', description_cn: '客户电话未接通' }]);
  assert.deepStrictEqual(onCard(db), [1], 'a real failed call on the air parcel still raises it');
});

it('an order whose waybill no parcel carries is read off its own row, as before', () => {
  const db = fixture();
  db.prepare(`INSERT INTO retail_orders (id, status, tracking_number, tracking_status)
    VALUES (1, 'dispatched', 'ONLY', 'in_transit'), (2, 'dispatched', NULL, 'in_transit')`).run();
  db.prepare("INSERT INTO retail_shipments (id, order_id, tracking_number) VALUES (1, 1, NULL), (2, 2, NULL)").run();
  alerts.stampNoContact(db, 'retail_orders', 1, FAILED);
  alerts.stampNoContact(db, 'retail_orders', 2, FAILED);
  assert.deepStrictEqual(onCard(db), [1, 2]);
});

it('the parcel view quotes the line and says whether it is still open', () => {
  const v = alerts.noContactView({
    tracking_no_contact_event: '2026-09-27 10:00:00', tracking_no_contact_cleared: null,
  }, FAILED);
  assert.strictEqual(v.open, true);
  assert.strictEqual(v.text_cn, '客户电话无人接听');
  assert.strictEqual(alerts.noContactView({}, FAILED), null);
});

it('a landed parcel asks for no call — the drawer agrees with the card (TC000919)', () => {
  const row = { tracking_no_contact_event: '2026-09-27 10:00:00', tracking_no_contact_cleared: null };
  assert.strictEqual(alerts.noContactView({ ...row, tracking_status: 'delivered' }, FAILED), null,
    'JD delivered: no delivered_at, status only');
  assert.strictEqual(alerts.noContactView({ ...row, delivered_at: '2026-09-27 03:00:00' }, FAILED), null);
});

it('a landed parcel somebody DID call keeps its quiet line', () => {
  const v = alerts.noContactView({ tracking_no_contact_event: '2026-09-27 10:00:00',
    tracking_no_contact_cleared: '2026-09-27 10:00:00', tracking_no_contact_cleared_by: 'mei',
    tracking_status: 'delivered' }, FAILED);
  assert.strictEqual(v.open, false);
  assert.strictEqual(v.cleared_by, 'mei');
});

console.log('the wiring');

it('both tracking writers stamp the line (JD pull and kd100 push)', () => {
  assert.match(RETAIL, /stampNoContact\(tdb\(\), table, rowId, norm\.events\)/);
  assert.match(RETAIL, /stampNoContact\(tdb\(\), 'retail_orders', order\.id, parsed\.events\)/);
  assert.match(RETAIL, /stampNoContact\(tdb\(\), 'retail_shipments', sh\.id, parsed\.events\)/);
});

it('the columns exist on both tracking tables', () => {
  assert.match(DB_JS, /for \(const t of \['retail_orders', 'retail_shipments'\]\) \{\s*addColumn\(t, 'tracking_no_contact_event'/);
});

it('the button has a route, and both screens call it', () => {
  assert.match(RETAIL, /router\.post\('\/api\/retail-admin\/orders\/:id\/no-contact\/ack'/);
  assert.match(ORDERS, /\/no-contact\/ack`/);
  assert.match(MHTML, /'\/no-contact\/ack'/);
});

it('the list, the drawer and Needs-you all name it, on both screens', () => {
  assert.match(RETAIL, /AS no_contact_open/);
  assert.match(ORDERS, /o\.no_contact_open/);
  assert.match(ORDERS, /renderNoContactBanner\(o, s\)/);
  assert.match(DASH, /da\.no_contact/);
  assert.match(MHTML, /r\.no_contact_open/);
  assert.match(MHTML, /\$\{noContactCard\(sp\)\}/);
  assert.match(MHTML, /delivery_alerts\.no_contact/);
});

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`);
