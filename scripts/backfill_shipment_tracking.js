#!/usr/bin/env node
/**
 * Backfill kd100 tracking events from retail_orders onto retail_shipments.
 *
 * Why: kd100's push callback historically wrote pulled events ONLY to
 * retail_orders, but the Mini App Backend order drawer (and the customer
 * split-parcel view) read tracking off retail_shipments via
 * buildShipmentTrackingView. So every kd100-tracked order showed an empty
 * timeline + the save-time "In transit" placeholder on the backend. The
 * callback now mirrors onto shipment rows (routes/retail.js handleKd100Callback),
 * but orders that already received their events before that fix shipped still
 * have empty shipment rows. This fills them in one pass.
 *
 * What it does: for every shipment that carries the SAME waybill as its order
 * and has NO events yet, copy the order row's status/events/scenario across.
 * Only touches event-less shipment rows, so it's safe + idempotent.
 *
 * Scope note: this can only fill shipments whose waybill matches the order-row
 * mirror — i.e. single-shipment orders and the PRIMARY leg of split orders. A
 * split order's SECONDARY legs never had their events stored on the order row
 * (the old callback no-op'd them), so there's nothing local to copy; those fill
 * on their next live kd100 push, which now lands via the shipment lookup.
 *
 * Run ON the server (where data/roots.db lives):
 *   node scripts/backfill_shipment_tracking.js --dry-run
 *   node scripts/backfill_shipment_tracking.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

const db = new Database(DB_PATH);

const EMPTY = "(tracking_events_json IS NULL OR tracking_events_json = '' OR tracking_events_json = '[]')";
const HAS   = "(o.tracking_events_json IS NOT NULL AND o.tracking_events_json <> '' AND o.tracking_events_json <> '[]')";

// Preview the shipment rows we'd fill.
const candidates = db.prepare(
  `SELECT s.id AS shipment_id, s.order_id, o.order_no, s.tracking_number,
          o.tracking_status AS status, o.tracking_events_json AS events_json
     FROM retail_shipments s
     JOIN retail_orders o ON o.id = s.order_id
    WHERE s.tracking_number IS NOT NULL
      AND s.tracking_number = o.tracking_number
      AND ${HAS}
      AND ${EMPTY.replace(/tracking_events_json/g, 's.tracking_events_json')}
    ORDER BY s.order_id DESC`
).all();

console.log(`[backfill] DB: ${DB_PATH}`);
console.log(`[backfill] ${candidates.length} shipment row(s) to fill:`);
for (const c of candidates) {
  let n = 0; try { n = (JSON.parse(c.events_json) || []).length; } catch {}
  console.log(`  - ${c.order_no} (order ${c.order_id}) shipment ${c.shipment_id} ${c.tracking_number} → ${n} event(s), status=${c.status}`);
}

if (DRY) { console.log('[backfill] DRY RUN — no changes written.'); db.close(); process.exit(0); }
if (!candidates.length) { console.log('[backfill] nothing to do.'); db.close(); process.exit(0); }

const upd = db.prepare(
  `UPDATE retail_shipments
      SET tracking_status             = o.tracking_status,
          tracking_events_json        = o.tracking_events_json,
          tracking_scenario           = o.tracking_scenario,
          tracking_scenario_data_json = o.tracking_scenario_data_json,
          tracking_synced_at          = o.tracking_synced_at,
          updated_at                  = CURRENT_TIMESTAMP
     FROM retail_orders o
    WHERE retail_shipments.order_id = o.id
      AND retail_shipments.tracking_number = o.tracking_number
      AND ${HAS}
      AND ${EMPTY.replace(/tracking_events_json/g, 'retail_shipments.tracking_events_json')}`
);

const tx = db.transaction(() => upd.run());
const res = tx();
console.log(`[backfill] done — ${res.changes} shipment row(s) updated.`);
db.close();
