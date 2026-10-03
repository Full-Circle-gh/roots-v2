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

/* ── THE CLOCK THIS SUITE RUNS ON, AND WHY IT IS NOT THE WALL'S ────────────
 *
 * A local rider's promised arrival is stored as a bare `HH:MM` — no date — and
 * lib/delivery-alerts resolves it against TODAY before asking whether it has
 * passed. So a fixture that says "an hour ago" by subtracting an hour from the
 * real clock writes `23:xx` whenever it runs in the first hour after midnight,
 * and `23:xx` resolved against today is this EVENING: not overdue, no stuck
 * rider, and four of this suite's cases fail.
 *
 * It ran red every night between 00:00 and 01:00 Guangzhou — scripts/
 * run-suites.js pins TZ=Asia/Shanghai, so that is the hour that counts however
 * the host is set — and green every working day. Nobody who saw it fail could
 * reproduce it; nobody who could reproduce it was looking. Proven by running
 * this file under TZ=Etc/GMT+1, where the same four cases fail on demand.
 *
 * `localStuckRows(db, now)` and `alertFilter(db, alias, now)` both take the
 * instant to judge against — the parameter exists for exactly this — so the
 * fix is to use it. NOON, not "now minus an hour": a fixed midday is far from
 * both boundaries, so no arithmetic this fixture does can wrap a day, and the
 * suite answers the same at every hour of the real clock.
 *
 * WHAT STAYS ON THE REAL CLOCK, deliberately: every `datetime('now', …)` seed
 * below. Those are compared against SQLite's own `now` inside the queries under
 * test, so pinning one side of that comparison and not the other is how a
 * fixture starts lying. Only the JS-side wall-clock reading is pinned, because
 * only that one is resolved against a bare HH:MM.
 */
const NOON = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
const hhmmOf = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
/** A local ETA an hour before NOON — 11:00, whatever hour this suite runs at. */
const ETA_PAST = hhmmOf(new Date(NOON.getTime() - 3600e3));

// ── A tenant, shaped like the real one in the columns these queries touch ──
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, channel TEXT,
      tracking_status TEXT, tracking_scenario TEXT, channel_eta TEXT,
      channel_status_at TEXT, placed_at TEXT, fulfillment_type TEXT,
      scheduled_for TEXT, customer_id INTEGER, recipient_name TEXT, recipient_phone TEXT,
      tracking_no_contact_event TEXT, tracking_no_contact_cleared TEXT);
    CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT, phone TEXT);
    CREATE TABLE retail_shipments (
      id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT, dispatched_at TEXT,
      delivered_at TEXT, tracking_status TEXT, tracking_synced_at TEXT,
      local_eta TEXT, eta_source TEXT, air_delay_cleared_at TEXT,
      tracking_no_contact_event TEXT, tracking_no_contact_cleared TEXT,
      tracking_number TEXT, waybill_product TEXT, waybill_product_no TEXT);
    CREATE TABLE retail_delay_cases (id INTEGER PRIMARY KEY, shipment_id INTEGER, order_id INTEGER);
    CREATE TABLE delivery_jobs (id INTEGER PRIMARY KEY, retail_order_id INTEGER,
      order_status INTEGER, updated_at TEXT);`);
  const ord = (id, cols) => {
    const k = Object.keys(cols);
    db.prepare(`INSERT INTO retail_orders (id,order_no,${k.join(',')}) VALUES (?,?,${k.map(() => '?').join(',')})`)
      .run(id, 'A' + id, ...k.map((x) => cols[x]));
  };

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
    .run('local', ETA_PAST);
  db.prepare("INSERT INTO delivery_jobs VALUES (41,4,20,datetime('now','-2 minutes'))").run();
  // 5 — nothing wrong with it at all.
  ord(5, { status: 'dispatched', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare("UPDATE retail_orders SET placed_at = datetime('now','-1 hours') WHERE id=5").run();
  // 6 — same-city rider, but already carrying it. On its way, not stuck.
  ord(6, { status: 'dispatched', channel: 'web', fulfillment_type: 'delivery' });
  db.prepare('INSERT INTO retail_shipments (id,order_id,mode,local_eta) VALUES (60,6,?,?)')
    .run('local', ETA_PAST);
  db.prepare("INSERT INTO delivery_jobs VALUES (61,6,40,datetime('now','-2 minutes'))").run();
  return db;
}

const match = (db) => {
  const f = alerts.alertFilter(db, 'o', NOON);
  return db.prepare(`SELECT o.id FROM retail_orders o WHERE 1=1 AND ${f.sql} ORDER BY o.id`)
           .all(...f.params).map((r) => r.id);
};

console.log('\nthe fixture answers the same at every hour of the day');

it('the pinned clock is a fixed midday, not a reading of the wall', () => {
  // If this ever goes back to `new Date()`, the suite goes back to failing for
  // one hour a night and passing every time anybody looks at it.
  assert.strictEqual(NOON.getHours(), 12, 'NOON must be midday, whatever hour this runs at');
  assert.strictEqual(NOON.getMinutes(), 0);
});

it('the promised arrival is earlier the SAME day, so it can never read as tonight', () => {
  // The whole defect in one assertion: a bare HH:MM is resolved against today,
  // so an ETA that sorts AFTER the instant it is judged against is not overdue
  // at all — it is this evening.
  assert.ok(ETA_PAST < hhmmOf(NOON),
    `an ETA of ${ETA_PAST} is not in the past relative to ${hhmmOf(NOON)}`);
});

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
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map((r) => r.id), [4]);
});

it('no stuck riders still yields valid SQL — `id IN ()` is not a thing', () => {
  const db = fixture();
  db.prepare('DELETE FROM delivery_jobs').run();
  const f = alerts.alertFilter(db, 'o', NOON);
  assert.strictEqual(f.params.length, 0);
  db.prepare(`SELECT o.id FROM retail_orders o WHERE 1=1 AND ${f.sql}`).all();   // must not throw
});

it('a pre-migration tenant loses the rider check, not the other three', () => {
  const db = fixture();
  db.exec('DROP TABLE delivery_jobs');
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON), []);
  assert.deepStrictEqual(match(db), [1, 2, 3]);
});

it('the ids are bound, never interpolated', () => {
  const f = alerts.alertFilter(fixture(), 'o', NOON);
  assert.ok(f.params.length > 0, 'the fixture has a stuck rider to bind');
  assert.ok(f.params.every(Number.isInteger), 'only integer row ids may be bound');
});

console.log('\na time an operator typed means a person has this delivery');

/* Ash, 2026-09-21, off the live phone on TC000812: "we order delivery manually
   not from the system, and added a time manually — seems that the system
   ignores it."
   The Qingyun copy exists because auto-push created it, but nobody ever
   dispatched a carrier through it, so order_status stays 20 (待配送) for good.
   The stuck-rider rule read that as "a rider was requested and none grabbed
   it", and fifteen minutes after the typed time it put the order on the card —
   on every such order, for ever. */
const manual = (db, orderId, src) =>
  db.prepare('UPDATE retail_shipments SET eta_source = ? WHERE order_id = ? AND mode = ?')
    .run(src, orderId, 'local');

it('an operator-typed ETA takes the order off the card', () => {
  const db = fixture();
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map(r => r.id), [4], 'the fixture starts stuck');
  manual(db, 4, 'manual');
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON), [],
    'a person who types an arrival time has arranged the delivery');
  assert.deepStrictEqual(match(db), [1, 2, 3], 'and the card drops it with the list');
});

it('a COURIER-set ETA is untouched — the contrast that proves it is the flag', () => {
  const db = fixture();
  manual(db, 4, 'auto');
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map(r => r.id), [4],
    'the daemon stamped this one; nobody said they had it');
});

it('an ETA with no provenance still alerts — history is not muted', () => {
  // Rows written before eta_source existed carry NULL. Reading NULL as "manual"
  // would silence every one of them in a single deploy.
  const db = fixture();
  assert.strictEqual(
    db.prepare('SELECT eta_source FROM retail_shipments WHERE order_id = 4').get().eta_source, null);
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map(r => r.id), [4]);
});

it('the other three kinds of trouble are NOT exempted by a typed time', () => {
  // They are carrier-REPORTED facts. A typed ETA says nothing about an
  // exception, a late cold-chain leg, or a Meituan order past its time.
  const db = fixture();
  for (const id of [1, 2, 3]) {
    db.prepare("INSERT INTO retail_shipments (order_id,mode,local_eta,eta_source) VALUES (?,'local','08:00','manual')").run(id);
  }
  const got = match(db);
  for (const id of [1, 2, 3]) assert.ok(got.includes(id), `sub-type on order ${id} must survive`);
});

it('a tenant without the column keeps its rider check', () => {
  // The column arrived by addColumn. Letting its absence throw into the catch
  // would return [] and drop the whole rider check for that tenant — a bigger
  // hole than the one being closed.
  const db = fixture();
  db.exec(`CREATE TABLE tmp AS SELECT id, order_id, mode, dispatched_at, delivered_at,
             tracking_status, tracking_synced_at, local_eta, air_delay_cleared_at
             FROM retail_shipments;
           DROP TABLE retail_shipments;
           ALTER TABLE tmp RENAME TO retail_shipments;`);
  assert.ok(!db.prepare('PRAGMA table_info(retail_shipments)').all().some(c => c.name === 'eta_source'));
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map(r => r.id), [4]);
});

it('the time and its provenance are read off the SAME parcel', () => {
  // Two parcels, and only the one carrying the time is the one whose
  // provenance may speak for it. Sub-queries that ordered differently would
  // pair a time with another parcel's flag.
  const db = fixture();
  db.prepare("INSERT INTO retail_shipments (id,order_id,mode,local_eta,eta_source) VALUES (45,4,'local',NULL,'manual')").run();
  assert.deepStrictEqual(alerts.localStuckRows(db, NOON).map(r => r.id), [4],
    'a parcel with no time must not lend its flag to the parcel that has one');
});

console.log('\nthe card counts the SET, not the sum of its parts');

/** Order 2 is the overdue Meituan order. Give it the stuck Qingyun rider that a
 *  Meituan mirror row is in fact fulfilled by, so one order is two sub-types. */
function withOverlap(db) {
  db.prepare("INSERT INTO retail_shipments (id,order_id,mode,local_eta) VALUES (20,2,'local',?)").run(ETA_PAST);
  db.prepare("INSERT INTO delivery_jobs VALUES (21,2,20,datetime('now','-2 minutes'))").run();
  return db;
}

it('the four sub-types really do overlap — the fixture is not inventing it', () => {
  const db = withOverlap(fixture());
  const mt = db.prepare(`SELECT o.id FROM retail_orders o WHERE ${alerts.meituanAlertSql('o')}`).all().map((r) => r.id);
  const stuck = alerts.localStuckRows(db, NOON).map((r) => r.id);
  assert.ok(mt.includes(2), 'order 2 must still be the overdue Meituan order');
  assert.ok(stuck.includes(2), 'order 2 must now also be a stuck rider — that is the overlap');
});

it('an order that is two kinds of trouble at once is ONE call, not two', () => {
  // THE BUG THIS REPLACES: the card added its four sub-counts together while
  // the list ORs the same four predicates, so this order was 2 on the card and
  // 1 in the list the card opens. Ash saw the filter show everything; the next
  // thing he would have seen, once it filtered, is a number that did not match.
  const db = withOverlap(fixture());
  const f = alerts.alertFilter(db, 'o', NOON);
  const rows = db.prepare(`SELECT o.id FROM retail_orders o WHERE ${f.sql} ORDER BY o.id`).all(...f.params);

  const oldWay =
      db.prepare(`SELECT COUNT(*) AS n FROM retail_orders o WHERE ${alerts.carrierAlertSql('o')}`).get().n
    + db.prepare(`SELECT COUNT(*) AS n FROM retail_orders o WHERE ${alerts.airAlertSql('o')}`).get().n
    + db.prepare(`SELECT COUNT(*) AS n FROM retail_orders o WHERE ${alerts.meituanAlertSql('o')}`).get().n
    + alerts.localStuckRows(db, NOON).length;

  assert.strictEqual(alerts.alertCount(db, f), rows.length,
    'the card must count exactly the rows the list shows');
  assert.strictEqual(alerts.alertCount(db, f), 4, 'four distinct orders need a call');
  assert.strictEqual(oldWay, 5, 'the sum of the parts double-counts the overlapping order');
  assert.notStrictEqual(oldWay, alerts.alertCount(db, f),
    'if these ever agree the fixture has lost its overlap and this test proves nothing');
});

it('with no overlap the two ways agree — the fix does not undercount', () => {
  const db = fixture();
  const f = alerts.alertFilter(db, 'o', NOON);
  assert.strictEqual(alerts.alertCount(db, f), 4);
});

it('the filter hands back the stuck ROWS, so the card need not re-read them', () => {
  const f = alerts.alertFilter(fixture(), 'o', NOON);
  assert.ok(Array.isArray(f.stuck), 'alertFilter must return the stuck rows it already found');
  assert.ok(f.stuck.length > 0 && f.stuck.every((r) => Number.isInteger(r.id) && r.waiting_since),
    'a stuck row carries its id and the instant it went overdue');
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

it('the ops card counts the set and never sums its sub-types again', () => {
  // Anchored on the CARD, not on the first `delivery_alerts = {` in the file —
  // that one is the empty initialiser three hundred lines earlier.
  const from = RETAIL.indexOf('const ALERT_WHERE');
  assert.ok(from > 0, 'the ops card must still build its carrier predicate');
  const at = RETAIL.indexOf('delivery_alerts = {', from);
  assert.ok(at > from, 'the ops card must still build delivery_alerts');
  const body = RETAIL.slice(from, RETAIL.indexOf('};', at));
  assert.ok(/deliveryAlerts\.alertCount\(/.test(body),
    'the count must come from alertCount, or it is a sum of overlapping parts again');
  assert.ok(!/count:\s*\w+Count\s*\+/.test(body),
    'adding the sub-counts together is the double-count this test exists to stop');
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

/** Every value the hidden #orders-status select can actually hold. */
function statusOptions() {
  const at = ADMIN.indexOf('<select id="orders-status"');
  assert.ok(at > 0, 'the hidden status select is gone — setOrderStatus writes into it');
  const body = ADMIN.slice(at, ADMIN.indexOf('</select>', at));
  return [...body.matchAll(/<option value="([a-z_]*)"/g)].map((m) => m[1]);
}

it('EVERY chip on the row is a value the hidden select can hold', () => {
  // THE CHIP IS ONLY HALF THE WIRING. setOrderStatus writes the chip's
  // data-status into #orders-status and ordFilterQuery reads it back; a
  // <select> given a value it has no <option> for takes selectedIndex -1 and
  // returns '' — so the status param is NOT SENT and the list WIDENS to every
  // order while the chip sits there lit. Verified in Chromium, not assumed.
  //
  // That is what 'delayed' did from the day its chip was added until
  // 2026-09-14: §98 taught the server the name, the chip row was given the
  // chip, and this select was never told. Ash, off the live desktop: "need a
  // call filter doesnt filter anything it shows all orders."
  //
  // The general case, deliberately — the same shape as the two above it. A
  // missing option is silent in exactly the way a missing STATUS_PARAM key and
  // a missing chip were, and the next status added to that row must fail here
  // rather than in production.
  const opts = statusOptions();
  const chips = [...ADMIN.matchAll(/<div class="status-chip[^>]*data-status="([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(chips.length >= 8, 'expected the orders screen to still carry its chip row');
  const orphan = [...new Set(chips.filter((s2) => !opts.includes(s2)))];
  assert.deepStrictEqual(orphan, [],
    `chip(s) whose status #orders-status cannot hold, so the filter silently shows EVERY order: ${orphan}`);
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
