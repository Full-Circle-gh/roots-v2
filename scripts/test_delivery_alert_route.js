#!/usr/bin/env node
/**
 * "Delivery needs a call" — the card, and the door it opens.
 *
 *   node scripts/test_delivery_alert_route.js
 *
 * WHAT WENT WRONG, TWICE, AND WHY IT WAS INVISIBLE BOTH TIMES.
 *
 * §98 found the card navigating to the Dispatched tab, which by definition
 * cannot hold these orders (an air-delayed parcel is `delivered`). It gave the
 * destination a name — `delayed` — taught the SERVER that name, and pointed
 * both clients at it. Neither client had ever heard of it:
 *
 *   • the phone resolves a filter through STATUS_PARAM, and an unlisted key
 *     falls to '' — so the status param is simply NOT SENT and the screen loads
 *     every order. A missing key does not throw; it widens.
 *   • the desktop narrows by FINDING the chip carrying that data-status, and
 *     there was no such chip — so it jumped to Orders and left whatever filter
 *     happened to be there. A missing chip does not throw either; it no-ops.
 *
 * So from §98 until 2026-09-14 the card counted one set of orders and opened
 * onto everything, on both surfaces, silently. Ash reported it off the live
 * phone: "once clicking on delivery need a call it doesn't take me to the
 * delivery directly."
 *
 * Underneath that sat a second, quieter disagreement: the card counts FOUR
 * kinds of delivery trouble and `status=delayed` tested exactly ONE of them, so
 * even a wired-up filter would have shown a Meituan alert as an empty list.
 *
 * THE TWO GENERAL CASES BELOW ARE THE POINT OF THIS FILE. Every status either
 * client navigates with must be one that client can actually resolve — checked
 * for ALL of them, not just this card's, because the next card wired to a name
 * nobody implemented will fail exactly as quietly as this one did.
 *
 * READS AND AN IN-MEMORY DATABASE — no browser, so this is in the FAST shard
 * and part of the gate.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const alerts = require('../lib/delivery-alerts');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// ── A tenant, shaped like the real one in the columns these queries touch ──
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, channel TEXT,
      tracking_status TEXT, tracking_scenario TEXT, channel_eta TEXT,
      channel_status_at TEXT, placed_at TEXT, fulfillment_type TEXT,
      scheduled_for TEXT, customer_id INTEGER, recipient_name TEXT, recipient_phone TEXT);
    CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT, phone TEXT);
    CREATE TABLE retail_shipments (
      id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT, dispatched_at TEXT,
      delivered_at TEXT, tracking_status TEXT, tracking_synced_at TEXT,
      local_eta TEXT, air_delay_cleared_at TEXT);
    CREATE TABLE retail_delay_cases (id INTEGER PRIMARY KEY, shipment_id INTEGER, order_id INTEGER);
    CREATE TABLE delivery_jobs (id INTEGER PRIMARY KEY, retail_order_id INTEGER,
      order_status INTEGER, updated_at TEXT);`);
  const ord = (id, cols) => {
    const k = Object.keys(cols);
    db.prepare(`INSERT INTO retail_orders (id,order_no,${k.join(',')}) VALUES (?,?,${k.map(() => '?').join(',')})`)
      .run(id, 'A' + id, ...k.map((x) => cols[x]));
  };
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const now = new Date();

  // 1 — the carrier said it cannot deliver.
  ord(1, { status: 'dispatched', channel: 'web', tracking_status: 'exception', fulfillment_type: 'delivery' });
  // 2 — a Meituan order with no ETA, stalled well past the sweep's reach.
  ord(2, { status: 'dispatched', channel: 'meituan', fulfillment_type: 'delivery' });
  db.prepare("UPDATE retail_orders SET channel_status_at = datetime('now','-9 hours'), placed_at = datetime('now','-9 hours') WHERE id=2").run();
  // 3 — delivered, but the cold-chain leg landed late. Terminal, so no
  //     dispatched-only predicate can ever see it.
  ord(3, { status: 'delivered', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare("INSERT INTO retail_shipments (id,order_id,mode,dispatched_at,delivered_at,tracking_status) VALUES (30,3,'air',date('now','-5 day'),date('now','-1 day'),'delivered')").run();
  // 4 — our own rider was requested and nobody picked it up.
  ord(4, { status: 'dispatched', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare('INSERT INTO retail_shipments (id,order_id,mode,local_eta) VALUES (40,4,?,?)')
    .run('local', hhmm(new Date(now.getTime() - 3600e3)));
  db.prepare("INSERT INTO delivery_jobs VALUES (41,4,20,datetime('now','-2 minutes'))").run();
  // 5 — nothing wrong with it at all.
  ord(5, { status: 'dispatched', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare("UPDATE retail_orders SET placed_at = datetime('now','-1 hours') WHERE id=5").run();
  // 6 — same-city rider, but already carrying it. On its way, not stuck.
  ord(6, { status: 'dispatched', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare('INSERT INTO retail_shipments (id,order_id,mode,local_eta) VALUES (60,6,?,?)')
    .run('local', hhmm(new Date(now.getTime() - 3600e3)));
  db.prepare("INSERT INTO delivery_jobs VALUES (61,6,40,datetime('now','-2 minutes'))").run();
  return db;
}

const match = (db) => {
  const f = alerts.alertFilter(db, 'o');
  return db.prepare(`SELECT o.id FROM retail_orders o WHERE 1=1 AND ${f.sql} ORDER BY o.id`)
           .all(...f.params).map((r) => r.id);
};

console.log('\nlib/delivery-alerts — the set the card counts');

it('all four kinds of trouble are in it', () => {
  assert.deepStrictEqual(match(fixture()), [1, 2, 3, 4]);
});

it('a healthy order is not, and neither is a rider already carrying it', () => {
  const got = match(fixture());
  assert.ok(!got.includes(5), 'a clean dispatched order must not be an alert');
  assert.ok(!got.includes(6), 'a rider past pickup resolves on drop-off, not here');
});

it('each sub-type is exactly one order, so none of them is doing another\'s work', () => {
  const db = fixture();
  const one = (sql) => db.prepare(`SELECT o.id FROM retail_orders o WHERE ${sql}`).all().map((r) => r.id);
  assert.deepStrictEqual(one(alerts.carrierAlertSql('o')), [1]);
  assert.deepStrictEqual(one(alerts.meituanAlertSql('o')), [2]);
  assert.deepStrictEqual(one(alerts.airAlertSql('o')), [3]);
  assert.deepStrictEqual(alerts.localStuckRows(db).map((r) => r.id), [4]);
});

it('no stuck riders still yields valid SQL — `id IN ()` is not a thing', () => {
  const db = fixture();
  db.prepare('DELETE FROM delivery_jobs').run();
  const f = alerts.alertFilter(db, 'o');
  assert.strictEqual(f.params.length, 0);
  db.prepare(`SELECT o.id FROM retail_orders o WHERE 1=1 AND ${f.sql}`).all();   // must not throw
});

it('a pre-migration tenant loses the rider check, not the other three', () => {
  const db = fixture();
  db.exec('DROP TABLE delivery_jobs');
  assert.deepStrictEqual(alerts.localStuckRows(db), []);
  assert.deepStrictEqual(match(db), [1, 2, 3]);
});

it('the ids are bound, never interpolated', () => {
  const f = alerts.alertFilter(fixture(), 'o');
  assert.ok(f.params.length > 0, 'the fixture has a stuck rider to bind');
  assert.ok(f.params.every(Number.isInteger), 'only integer row ids may be bound');
});

console.log('\nroutes/retail.js — the orders list filters on that same set');

it('status=delayed asks the shared module, not a lone air-delay EXISTS', () => {
  const at = RETAIL.indexOf("} else if (status === 'delayed') {");
  assert.ok(at > 0, "buildOrderFilter must still carry a 'delayed' branch");
  const body = RETAIL.slice(at, RETAIL.indexOf('} else if', at + 10));
  assert.ok(/deliveryAlerts\.alertFilter\(/.test(body),
    'the branch must resolve through lib/delivery-alerts, or it is a quarter of its own card');
  assert.ok(!/lateShipmentSql/.test(body),
    'an inline air-delay predicate here is the drift this test exists to stop');
});

console.log('\npublic/m.html — the phone');

/** Every status the phone's STATUS_PARAM can resolve. */
function statusParam() {
  const at = MHTML.indexOf('const STATUS_PARAM={');
  const body = MHTML.slice(at, MHTML.indexOf('};', at));
  return [...body.matchAll(/([a-z_]+)\s*:\s*'/g)].map((m) => m[1]);
}

it('delayed is a key — an unlisted one widens to every order, silently', () => {
  assert.ok(statusParam().includes('delayed'),
    'STATUS_PARAM has no `delayed`, so the card opens the unfiltered Orders list');
});

it('EVERY status the phone navigates with is one it can resolve', () => {
  const keys = statusParam();
  const used = [...MHTML.matchAll(/APP\.cmd\('ordersGo','([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, 'expected the Needs-you rows to still navigate this way');
  const orphan = used.filter((s) => !keys.includes(s));
  assert.deepStrictEqual(orphan, [], `ordersGo uses status(es) STATUS_PARAM cannot resolve: ${orphan}`);
});

it('the filter says its own name — a narrowed list with nothing lit has no way back', () => {
  assert.ok(/state\.statusF==='delayed'\?`<div[^`]*APP\.cmd\('statusF','all'\)/.test(MHTML),
    'no clearable chip for the delayed pseudo-status');
});

it('one alert opens the order; more than one opens the list', () => {
  // The branch itself, lifted and run — a textual check would pass on a
  // condition that had been inverted.
  const at = MHTML.indexOf("const daIt=items('delivery_alerts');");
  assert.ok(at > 0, 'the delivery card must still choose its destination');
  const src = MHTML.slice(at, MHTML.indexOf('add(c(', at));
  const decide = (count, list) =>
    new Function('c', 'items', src + '; return daGo;')(() => count, () => list);

  assert.match(decide(1, [{ id: 7, order_no: 'A7' }]), /openDeliveryAlert/,
    'a single alert must open the delivery itself, not a list of one');
  assert.match(decide(3, [{ id: 7 }, { id: 8 }, { id: 9 }]), /ordersGo','delayed'/,
    'several alerts must open the filtered list');
  assert.match(decide(1, []), /ordersGo','delayed'/,
    'a count of one with no item to open must fall back to the list, not a blank sheet');
});

it('the command that opens it reads the id off the snapshot, not the DOM', () => {
  const at = MHTML.indexOf("reg('openDeliveryAlert'");
  assert.ok(at > 0, 'openDeliveryAlert is not registered');
  const body = MHTML.slice(at, MHTML.indexOf('\n});', at));
  assert.ok(/state\.ops&&state\.ops\.delivery_alerts/.test(body),
    'it must read the order off the ops snapshot the card was drawn from');
  assert.ok(/state\.detailFetch=true/.test(body),
    'the sheet must hold the screen while the read is in flight — the order is very often not in the loaded list');
  assert.ok(/state\.orderOverCust=false/.test(body),
    'nothing is under this sheet but Home; leaving it set pushes the next customer record under a sheet that is gone');
});

console.log('\npublic/retail-admin — the desktop');

it('EVERY status the desktop navigates with has a chip to find', () => {
  const chips = [...ADMIN.matchAll(/data-status="([a-z_]*)"/g)].map((m) => m[1]);
  const used = [...DASH.matchAll(/tdSecOpenOrders\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, 'expected the dashboard to still navigate this way');
  const orphan = [...new Set(used.filter((s) => !chips.includes(s)))];
  assert.deepStrictEqual(orphan, [],
    `tdSecOpenOrders uses status(es) with no chip, so the jump applies no filter: ${orphan}`);
});

it('the delivery chip is there, and it is the pseudo-status the server knows', () => {
  assert.ok(/data-status="delayed"/.test(ADMIN), 'no delayed chip on the orders screen');
});

it('the delivery card and its own footer agree on where the alerts live', () => {
  const at = DASH.indexOf("const alerts = ((DASH_OPS.delivery_alerts || {}).count) || 0;");
  assert.ok(at > 0, 'the delivery footer must still read the ops count');
  const foot = DASH.slice(at, at + 1200);
  assert.ok(!/tdSecOpenOrders\('dispatched'\)/.test(foot),
    'the footer still sends people to Dispatched, which cannot hold a delivered-late parcel');
});

it('a status with no chip is said out loud instead of doing nothing', () => {
  const at = DASH.indexOf('function tdSecOpenOrders(');
  const body = DASH.slice(at, DASH.indexOf('\n}', at));
  assert.ok(/console\.warn/.test(body),
    'a missing chip must not stay silent — that silence is how this bug survived §98');
});

console.log(`\n${n} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
