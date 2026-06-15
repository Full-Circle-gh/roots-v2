// Correct already-placed ship-district orders (花都/番禺/南沙/从化/增城) that were
// wrongly fulfilled same-city/nearest when the customer didn't opt into same-day
// (delivery_slot_kind != 'today'). Re-point to the out-of-city store (Tianhe) and
// convert their 'local' same-city shipment to a 'land' courier parcel.
//
// SAFETY:
//   • Backs up the DB first.
//   • Only touches orders with NOTHING dispatched yet.
//   • Skips (warns) any order still holding active stock reservations at the
//     wrong store — those need a manual stock move, not a silent re-point.
//   • Idempotent: an order already on the out-of-city store with no 'local'
//     shipment is left untouched.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-shipdistrict-fix-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const db = new Database(DB_PATH);

const shipDistricts = new Set(
  db.prepare(
    `SELECT match_district FROM retail_delivery_zones
      WHERE zone_type = 'gz_district' AND (day_only = 1 OR same_day_surcharge > 0)`
  ).all().map(r => r.match_district).filter(Boolean)
);
const oocRow = db.prepare(`SELECT value_json FROM storefront_config WHERE key='printer.out_of_city_store_id'`).get();
let oocId = null;
try { const v = oocRow ? JSON.parse(oocRow.value_json) : null; if (v != null && /^\d+$/.test(String(v))) oocId = parseInt(v, 10); } catch {}
if (oocId == null) { console.log('!! No out_of_city_store_id configured. Aborting.'); process.exit(1); }
console.log('Ship-districts:', [...shipDistricts].join(', '), '| out-of-city store #', oocId);

const orders = db.prepare(
  `SELECT id, order_no, store_id, address_json, delivery_slot_kind
     FROM retail_orders
    WHERE fulfillment_type = 'delivery'
      AND (delivery_slot_kind IS NULL OR delivery_slot_kind != 'today')`
).all();

const shipmentsFor = db.prepare(`SELECT id, mode, dispatched_at, delivered_at FROM retail_shipments WHERE order_id = ?`);
const activeRes    = db.prepare(`SELECT COUNT(*) AS n FROM retail_stock_reservations WHERE order_id = ? AND status = 'active'`);
const setOrder     = db.prepare(`UPDATE retail_orders SET store_id = ?, routing_reason = 'scheduled_ship_district' WHERE id = ?`);
const setShipLand  = db.prepare(`UPDATE retail_shipments SET mode = 'land', label = 'Land shipment · 陆运', local_eta = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);

const fixed = [], skipped = [];
const tx = db.transaction(() => {
  for (const o of orders) {
    let district = '';
    try { district = (JSON.parse(o.address_json || '{}').district || '').trim(); } catch {}
    if (!shipDistricts.has(district)) continue;

    const sh = shipmentsFor.all(o.id);
    const hasLocal   = sh.some(s => s.mode === 'local');
    const wrongStore = o.store_id != null && o.store_id !== oocId;
    if (!hasLocal && !wrongStore) continue;                       // already correct

    if (sh.some(s => s.dispatched_at || s.delivered_at)) { skipped.push(`${o.order_no} (already dispatched)`); continue; }
    if (activeRes.get(o.id).n > 0)                       { skipped.push(`${o.order_no} (holds active reservations — fix stock manually)`); continue; }

    if (wrongStore) setOrder.run(oocId, o.id);
    for (const s of sh) if (s.mode === 'local') setShipLand.run(s.id);
    fixed.push(`${o.order_no} [${district}] store ${o.store_id}→${oocId}, local→land`);
  }
});
tx();

console.log(`\nFixed ${fixed.length}:`);   fixed.forEach(x => console.log('  ✓', x));
console.log(`Skipped ${skipped.length}:`); skipped.forEach(x => console.log('  •', x));
