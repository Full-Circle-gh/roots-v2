// READ-ONLY. Find already-placed orders in the outer GZ "ship-districts"
// (花都/番禺/南沙/从化/增城) that were wrongly handled as same-city local /
// nearest-store fulfilment when the customer did NOT opt into same-day
// (delivery_slot_kind != 'today'). These should ship by courier from the
// out-of-city store (Tianhe).
//
// Affected = ship-district + non-same-day + (store_id != out_of_city_store_id
//            OR has a shipment row with mode='local').
// We split the report into FIXABLE (nothing dispatched yet) vs SHIPPED
// (already dispatched/delivered — left alone). Mutates nothing.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

// 1. Ship-districts = gz_district zones flagged day_only=1 OR surcharge>0.
const shipDistricts = new Set(
  db.prepare(
    `SELECT match_district FROM retail_delivery_zones
      WHERE zone_type = 'gz_district'
        AND (day_only = 1 OR same_day_surcharge > 0)`
  ).all().map(r => r.match_district).filter(Boolean)
);
console.log('Ship-districts:', [...shipDistricts].join(', ') || '(none)');

// 2. Out-of-city store id from printer prefs.
const oocRow = db.prepare(
  `SELECT value_json FROM storefront_config WHERE key = 'printer.out_of_city_store_id'`
).get();
let oocId = null;
try { const v = oocRow ? JSON.parse(oocRow.value_json) : null; if (v != null && /^\d+$/.test(String(v))) oocId = parseInt(v, 10); } catch {}
const storeName = (id) => {
  if (id == null) return '(none)';
  const s = db.prepare('SELECT code, name_en, name_cn FROM retail_stores WHERE id = ?').get(id);
  return s ? `${s.name_en || s.code || ''}${s.name_cn ? ' / ' + s.name_cn : ''} (#${id})` : `#${id}`;
};
console.log('out_of_city_store_id =', storeName(oocId));
if (oocId == null) { console.log('\n!! No out_of_city_store_id configured — cannot determine the correct target. Aborting.'); process.exit(1); }

// 3. Candidate orders: delivery, not-same-day.
const orders = db.prepare(
  `SELECT id, order_no, status, fulfillment_type, store_id, routing_reason,
          delivery_slot_kind, address_json, placed_at, paid_at
     FROM retail_orders
    WHERE fulfillment_type = 'delivery'
      AND (delivery_slot_kind IS NULL OR delivery_slot_kind != 'today')`
).all();

const shipmentsFor = db.prepare(
  `SELECT id, mode, local_eta, dispatched_at, delivered_at, tracking_number
     FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
);

const fixable = [], shipped = [];
for (const o of orders) {
  let district = '';
  try { district = (JSON.parse(o.address_json || '{}').district || '').trim(); } catch {}
  if (!shipDistricts.has(district)) continue;

  const sh = shipmentsFor.all(o.id);
  const hasLocal   = sh.some(s => s.mode === 'local');
  const wrongStore = o.store_id != null && o.store_id !== oocId;
  if (!hasLocal && !wrongStore) continue;  // already correct

  const anyDispatched = sh.some(s => s.dispatched_at || s.delivered_at);
  const rec = {
    order_no: o.order_no, id: o.id, status: o.status, district,
    slot_kind: o.delivery_slot_kind || '(null)',
    store: storeName(o.store_id), wrongStore,
    shipments: sh.map(s => `${s.mode}${s.local_eta ? '/eta=' + s.local_eta : ''}${s.tracking_number ? '/wb=' + s.tracking_number : ''}${s.dispatched_at ? '/DISPATCHED' : ''}`).join(', '),
    hasLocal,
  };
  (anyDispatched ? shipped : fixable).push(rec);
}

const dump = (title, arr) => {
  console.log(`\n=== ${title} (${arr.length}) ===`);
  for (const r of arr) {
    console.log(`${r.order_no}  [${r.status}]  ${r.district}  slot=${r.slot_kind}`);
    console.log(`   store: ${r.store}${r.wrongStore ? '  <-- WRONG (should be out-of-city)' : ''}`);
    console.log(`   shipments: ${r.shipments || '(none)'}`);
  }
};
dump('FIXABLE — not dispatched yet', fixable);
dump('ALREADY SHIPPED — leave alone', shipped);
console.log(`\nTotal candidates scanned: ${orders.length}  |  fixable: ${fixable.length}  |  shipped: ${shipped.length}`);
