#!/usr/bin/env node
/**
 * "View full tracking" on the second parcel of a split order.
 *
 *   node scripts/test_split_parcel_tracking.js
 *
 * THE DEFECT. An order that ships as two parcels renders one card per
 * parcel on the customer's order page, each with its own waybill and its
 * own "View full tracking" tap. That tap calls openShipmentLink
 * (miniapp/pages/order/order.js), which navigates to pages/track carrying
 * THAT PARCEL'S waybill number.
 *
 * Both tracking routes then looked the number up like this:
 *
 *     FROM retail_orders WHERE order_no = ? AND tracking_number = ?
 *
 * and retail_orders mirrors ONLY THE PRIMARY waybill. A split order's
 * second parcel exists solely on its own retail_shipments row. So the
 * lookup missed, the endpoint returned 404, and the screen rendered its
 * "Unable to load tracking · Please go back to the order page and try
 * again" error state — for a parcel that is being tracked perfectly well
 * and whose events are sitting in the database one table over.
 *
 * WHAT MAKES THIS WORTH A SUITE RATHER THAN A ONE-LINE FIX. The kd100
 * webhook ALREADY carried this exact fallback. It was added when
 * secondary-leg pushes were found to be silently dropped — the WRITE path
 * learned that retail_orders is not the index of all waybills, and the
 * READ path never did. The same wrong assumption, fixed once, left
 * standing twice. A test that only drove the JSON API would leave the
 * legacy /track HTML page — still reachable — broken in the same way, so
 * both call the one resolver and the resolver is what is tested.
 *
 * THE OWNERSHIP CHECK IS THE PART THAT MUST NOT REGRESS. The JSON API is
 * customer-scoped: it compares the resolved row's customer_id against the
 * session. Widening a lookup is exactly the kind of change that quietly
 * drops a scope, so section 3 proves the shipment-resolved row still
 * carries the owning order's customer_id and that a stranger's waybill
 * cannot be read by guessing an order number.
 *
 * Runs against a REAL sqlite database built from database.js's own CREATE
 * TABLE text via the shared in-memory opener, so the statements under
 * test run verbatim. No install, no network.
 *
 * TO PROVE THE SUITE CAN FAIL:  SPLIT_TRACK_SABOTAGE=1 node scripts/test_split_parcel_tracking.js
 *
 * Not a browser suite — fast shard.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const tracking = require('../lib/tracking');

const SABOTAGE = process.env.SPLIT_TRACK_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

// Sabotage restores the pre-fix lookup — order row only. Every assertion
// about a secondary parcel must go red under it, or the suite is proving
// nothing about the defect it was written for.
const resolve = SABOTAGE
  ? (db, orderNo, number) => db.prepare(
      `SELECT order_no, status, customer_id, tracking_carrier, tracking_number,
              tracking_status, tracking_events_json, tracking_synced_at
         FROM retail_orders WHERE order_no = ? AND tracking_number = ?`
    ).get(orderNo, number) || null
  : tracking.resolveTrackedParcel;

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
}
function eq(label, got, want) {
  ok(label, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

// ── Fixture: one split order (two parcels), one plain order, two owners ──
const db = openTablesDb(DB_SRC, ['retail_orders', 'retail_shipments']);

const EV_PRIMARY   = '[{"time":"2026-09-17 10:00","description_cn":"您的快件已揽收","location":"广州市"}]';
const EV_SECONDARY = '[{"time":"2026-09-17 11:00","description_cn":"您的快件已到达【天津散货分拣中心】","location":"天津市"}]';

db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, tracking_carrier, tracking_number,
   tracking_status, tracking_events_json, tracking_synced_at)
  VALUES (1,'TC000999',7,'dispatched','jd','JD-PRIMARY-001','in_transit',?, '2026-09-17T11:05:00')`)
  .run(EV_PRIMARY);
db.prepare(`INSERT INTO retail_shipments
  (id, order_id, mode, label, tracking_carrier, tracking_number, tracking_status, tracking_events_json)
  VALUES (1,1,'air','Parcel 1','jd','JD-PRIMARY-001','in_transit','[]')`).run();
db.prepare(`INSERT INTO retail_shipments
  (id, order_id, mode, label, tracking_carrier, tracking_number, tracking_status, tracking_events_json)
  VALUES (2,1,'air','Parcel 2','jd','JD-SECOND-002','arrived_local',?)`).run(EV_SECONDARY);

// A different customer's order, to prove scoping below.
db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, tracking_carrier, tracking_number, tracking_status, tracking_events_json)
  VALUES (2,'TC001000',99,'dispatched','sf','SF-OTHER-003','in_transit','[]')`).run();
db.prepare(`INSERT INTO retail_shipments
  (id, order_id, mode, label, tracking_carrier, tracking_number, tracking_status, tracking_events_json)
  VALUES (3,2,'air','Parcel 1','sf','SF-OTHER-003','in_transit','[]')`).run();

// ── 1. The primary waybill must keep resolving off the order row ────
// The regression risk of widening a lookup is that the common case
// changes shape. It carries the ORDER's status, which is authoritative.
const primary = resolve(db, 'TC000999', 'JD-PRIMARY-001');
ok('primary resolves', !!primary);
if (primary) {
  eq('primary · order_no',        primary.order_no,             'TC000999');
  eq('primary · waybill',         primary.tracking_number,      'JD-PRIMARY-001');
  eq('primary · customer_id',     primary.customer_id,          7);
  eq('primary · carrier',         primary.tracking_carrier,     'jd');
  eq('primary · events',          primary.tracking_events_json, EV_PRIMARY);
  eq('primary · synced_at',       primary.tracking_synced_at,   '2026-09-17T11:05:00');
}

// ── 2. THE DEFECT — the secondary parcel must resolve too ───────────
const second = resolve(db, 'TC000999', 'JD-SECOND-002');
ok('SECONDARY PARCEL RESOLVES (the defect)', !!second,
   'resolved null → the endpoint 404s → pages/track shows "Unable to load tracking"');
if (second) {
  eq('secondary · waybill',   second.tracking_number,      'JD-SECOND-002');
  // Its OWN events, not the order row's — the whole point of the screen.
  eq('secondary · events',    second.tracking_events_json, EV_SECONDARY);
  // Its OWN status, not the order's: parcel 2 is further along than parcel 1.
  eq('secondary · status',    second.tracking_status,      'arrived_local');
  // Order-level fields still come from the owning order.
  eq('secondary · order_no',  second.order_no,             'TC000999');
  eq('secondary · order status', second.status,            'dispatched');
}

// ── 3. Ownership must survive the widening ──────────────────────────
// The JSON API rejects on customer_id mismatch. A shipment-resolved row
// with no customer_id would compare undefined !== id and 404 the owner;
// worse, a resolver that ignored order_no would hand parcel data to
// anyone who guessed a waybill.
eq('secondary carries the owning customer', second && second.customer_id, 7);
ok('a stranger’s waybill is not reachable under my order number',
   resolve(db, 'TC000999', 'SF-OTHER-003') === null,
   'resolved non-null → a customer could read another order’s parcel');
ok('my waybill is not reachable under a stranger’s order number',
   resolve(db, 'TC001000', 'JD-SECOND-002') === null);

// ── 4. Misses stay misses ───────────────────────────────────────────
ok('unknown waybill → null',      resolve(db, 'TC000999', 'NOPE-404') === null);
ok('unknown order → null',        resolve(db, 'NOSUCH', 'JD-SECOND-002') === null);
ok('empty waybill → null',        resolve(db, 'TC000999', '') === null);

// ── 5. A parcel with no waybill yet must not match an empty string ──
// ensureShipments creates parcels before a number is attached, so NULL
// tracking_number rows exist in quantity. If '' or NULL matched them, a
// blank waybill would resolve to an arbitrary parcel.
db.prepare(`INSERT INTO retail_shipments
  (id, order_id, mode, label, tracking_carrier, tracking_number)
  VALUES (4,1,'land','Parcel 3','jd',NULL)`).run();
ok('NULL-waybill parcel is not matched by an empty lookup',
   resolve(db, 'TC000999', '') === null);
ok('NULL-waybill parcel is not matched by a null lookup',
   resolve(db, 'TC000999', null) === null);

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} check(s) failed, ${pass} passed  [driver: ${driver}]\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`PASS — split-parcel tracking: ${pass} checks  [driver: ${driver}]`);
