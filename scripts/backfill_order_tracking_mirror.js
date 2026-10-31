#!/usr/bin/env node
/**
 * Backfill the order-level tracking mirror for split orders whose FIRST-shipped
 * parcel was NOT the primary one.
 *
 * Why: the orders-list TRACKING cell + customer mini-app order list read the
 * legacy retail_orders.tracking_* columns. Those were only ever mirrored from
 * the PRIMARY parcel, so a split order whose non-primary parcel shipped first
 * (e.g. the land half of a fresh order, while the air/fresh parcel is made
 * later) left the order row empty → the list showed "⚠ missing" despite a real,
 * live-syncing waybill on a parcel. The code now mirrors the first parcel to
 * ship (primary or not); this fixes orders that shipped BEFORE that change.
 *
 * What it does: for each dispatched/delivered order whose order row has NO
 *   tracking_number but which HAS a shipment carrying one, copy that shipment's
 *   tracking_carrier / tracking_number / tracking_status / events / sync / kd100
 *   flag onto the order row. Picks the earliest-id shipment with a waybill.
 * What it does NOT touch: shipment rows, order status, dispatched_at, anything
 *   on orders whose order row already has a waybill.
 *
 * Safe by default: prints a plan and changes NOTHING unless --apply is passed.
 * On --apply it first backs up data/roots.db.
 *
 * Run ON THE SERVER, against data/roots.db:
 *   node scripts/backfill_order_tracking_mirror.js            # dry-run
 *   node scripts/backfill_order_tracking_mirror.js --apply    # write
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.slice(2).includes('--apply');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.${stamp}.bak`;
  fs.copyFileSync(DB_PATH, backup);
  console.log('Backed up DB →', backup);
}

const db = new Database(DB_PATH);

// Orders that are out the door but whose legacy mirror is empty.
const candidates = db.prepare(
  `SELECT id, order_no, status
     FROM retail_orders
    WHERE status IN ('dispatched','delivered')
      AND (tracking_number IS NULL OR tracking_number = '')`
).all();

const upd = db.prepare(
  `UPDATE retail_orders
      SET tracking_carrier             = @carrier,
          tracking_number              = @number,
          tracking_status              = @status,
          tracking_events_json         = @events,
          tracking_synced_at           = @synced,
          tracking_kd100_subscribed    = @kd100,
          updated_at                   = CURRENT_TIMESTAMP
    WHERE id = @id`
);

const plan = [];
for (const o of candidates) {
  const s = db.prepare(
    `SELECT tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at, tracking_kd100_subscribed
       FROM retail_shipments
      WHERE order_id = ? AND tracking_number IS NOT NULL AND tracking_number != ''
      ORDER BY id LIMIT 1`
  ).get(o.id);
  if (!s) continue;   // nothing shipped with a waybill — leave as-is
  plan.push({ o, s });
}

if (!plan.length) { console.log('Nothing to backfill — no split order has an orphaned waybill.'); process.exit(0); }

console.log(`\n${plan.length} order(s) to mirror:`);
for (const { o, s } of plan) {
  console.log(`  ${o.order_no} (${o.status}) ← ${String(s.tracking_carrier).toUpperCase()} ${s.tracking_number}`);
}

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); process.exit(0); }

const tx = db.transaction(() => {
  for (const { o, s } of plan) {
    upd.run({
      id: o.id,
      carrier: s.tracking_carrier, number: s.tracking_number, status: s.tracking_status,
      events: s.tracking_events_json, synced: s.tracking_synced_at,
      kd100: s.tracking_kd100_subscribed || 0,
    });
  }
});
tx();
console.log(`\n✓ Done. Mirrored ${plan.length} order(s).`);
