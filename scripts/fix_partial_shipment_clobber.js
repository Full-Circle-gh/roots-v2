#!/usr/bin/env node
/**
 * Un-clobber a PARTIAL shipment whose un-shipped parcel was wrongly stamped
 * "dispatched".
 *
 * Why: the order-detail back-fill (routes/retail.js, GET /orders/:id) used to
 * stamp dispatched_at on EVERY parcel of any dispatched order that still had an
 * un-stamped parcel — which is exactly the signature of a legitimate partial
 * shipment (one parcel got a waybill, a fresh-food parcel ships later). That
 * killed the "Partially shipped" pill in admin and the customer's "rest to
 * follow" banner, making a half-shipped order look fully shipped. The code is
 * now fixed (back-fill only fires when NO parcel is stamped), but orders opened
 * BEFORE the fix already carry the bad stamp in the DB. This clears it.
 *
 * What it clears:  dispatched_at (and delivered_at) on parcels of the target
 *   order that have NO tracking waybill, are NOT local same-city (those never
 *   carry a waybill by design — they use a local ETA), and are NOT delivered.
 * Safety guard:  only un-stamps such a parcel when a SIBLING parcel genuinely
 *   shipped (has a tracking_number) — i.e. the order really is mid-partial. An
 *   order where every parcel lacks a waybill is left untouched (could be a
 *   legit fully-dispatched-no-waybill case; don't guess).
 * What it does NOT touch:  the shipped parcel, local-ETA parcels, the order row
 *   status (stays 'dispatched' — it IS dispatched, just partially), tracking,
 *   points, or anything else.
 *
 * Target:
 *   --order <order_no>   default: R260615000010
 *
 * Safe by default: prints a plan and changes NOTHING unless --apply is passed.
 * On --apply it first backs up data/roots.db.
 *
 * Run ON THE SERVER, against data/roots.db:
 *   node scripts/fix_partial_shipment_clobber.js                      # dry-run
 *   node scripts/fix_partial_shipment_clobber.js --apply              # fix R260615000010
 *   node scripts/fix_partial_shipment_clobber.js --order R26... --apply
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const ORDER_NO = arg('--order', 'R260615000010');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.${stamp}.bak`;
  fs.copyFileSync(DB_PATH, backup);
  console.log('Backed up DB →', backup);
}

const db = new Database(DB_PATH);

const o = db.prepare(
  `SELECT id, order_no, status, dispatched_at FROM retail_orders WHERE order_no = ?`
).get(ORDER_NO);
if (!o) { console.error('Order not found:', ORDER_NO); process.exit(1); }

const ships = db.prepare(
  `SELECT id, mode, tracking_number, dispatched_at, delivered_at
     FROM retail_shipments WHERE order_id = ? ORDER BY id`
).all(o.id);

console.log(`\nOrder ${o.order_no}  (status=${o.status})  — ${ships.length} parcel(s)`);
for (const s of ships) {
  console.log(`  parcel #${s.id}  mode=${s.mode}  waybill=${s.tracking_number || '—'}` +
    `  dispatched_at=${s.dispatched_at || '—'}  delivered_at=${s.delivered_at || '—'}`);
}

const anyShipped = ships.some(s => s.tracking_number);
if (!anyShipped) {
  console.log('\nNo parcel carries a waybill — not a confirmable partial shipment. Leaving untouched.');
  process.exit(0);
}

// Clobber victims: stamped, but no waybill, not local, not delivered.
const victims = ships.filter(s =>
  s.dispatched_at &&
  !s.tracking_number &&
  (s.mode || 'local') !== 'local' &&
  !s.delivered_at
);

if (victims.length === 0) {
  console.log('\nNothing to fix — no un-shipped parcel is wrongly stamped.');
  process.exit(0);
}

console.log(`\nWill clear dispatched_at on ${victims.length} un-shipped parcel(s): ` +
  victims.map(v => `#${v.id}`).join(', '));

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write the change.');
  process.exit(0);
}

const upd = db.prepare(
  `UPDATE retail_shipments SET dispatched_at = NULL, delivered_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`
);
const tx = db.transaction(() => { for (const v of victims) upd.run(v.id); });
tx();

const after = db.prepare(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN dispatched_at IS NOT NULL OR delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS dispatched
     FROM retail_shipments WHERE order_id = ?`
).get(o.id);
console.log(`\n✓ Done. Order is now Partially shipped (${after.dispatched}/${after.total}).`);
