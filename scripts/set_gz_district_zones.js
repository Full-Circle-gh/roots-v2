// Guangzhou same-day districts: base 15 / free 199, flat 1.5/order packing
// (per-item 1.5 capped at 1.5 → effectively flat per order), lead 0–15,
// kitchen 10–20, slot 120, same-day on, day-only off, active.
// Upsert by match_district. Backs up first.
//
// NOTE: packing fee is NOT yet charged on gz_district zones — that's a pending
// code fix in computeDeliveryAndPacking (currently city-only). Value is stored
// here so it takes effect the moment that fix ships.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-gzdist-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const DISTRICTS = ['越秀区', '黄埔区', '荔湾区', '天河区', '海珠区', '白云区'];

const V = {
  base_fee: 15,
  max_fee: 0,
  free_threshold: 199,
  packing_fee_per_item: 1.5,
  packing_fee_cap: 1.5,
  is_active: 1,
  same_day_allowed: 1,
  same_day_surcharge: 0,
  min_lead_days: 0,
  max_lead_days: 15,
  slot_start_hour: 10,
  slot_end_hour: 20,
  slot_duration_minutes: 120,
  day_only: 0,
};

const db = new Database(DB_PATH);
const find = db.prepare(
  `SELECT id FROM retail_delivery_zones WHERE zone_type='gz_district' AND match_district=?`
);
const update = db.prepare(
  `UPDATE retail_delivery_zones SET
     base_fee=@base_fee, max_fee=@max_fee, free_threshold=@free_threshold,
     packing_fee_per_item=@packing_fee_per_item, packing_fee_cap=@packing_fee_cap,
     is_active=@is_active, same_day_allowed=@same_day_allowed,
     same_day_surcharge=@same_day_surcharge, min_lead_days=@min_lead_days,
     max_lead_days=@max_lead_days, slot_start_hour=@slot_start_hour,
     slot_end_hour=@slot_end_hour, slot_duration_minutes=@slot_duration_minutes,
     day_only=@day_only, updated_at=CURRENT_TIMESTAMP
   WHERE id=@id`
);
const insert = db.prepare(
  `INSERT INTO retail_delivery_zones
     (zone_type, name_en, name_cn, match_city, match_district, base_fee, max_fee,
      free_threshold, packing_fee_per_item, packing_fee_cap, is_active, sort_order,
      same_day_allowed, same_day_surcharge, min_lead_days, max_lead_days,
      slot_start_hour, slot_end_hour, slot_duration_minutes, day_only)
   VALUES ('gz_district', NULL, @name_cn, '广州市', @match_district, @base_fee, @max_fee,
      @free_threshold, @packing_fee_per_item, @packing_fee_cap, @is_active, 0,
      @same_day_allowed, @same_day_surcharge, @min_lead_days, @max_lead_days,
      @slot_start_hour, @slot_end_hour, @slot_duration_minutes, @day_only)`
);

let updated = 0, inserted = 0;
const run = db.transaction(() => {
  for (const d of DISTRICTS) {
    const row = find.get(d);
    if (row) { update.run({ ...V, id: row.id }); updated++; }
    else {
      insert.run({ ...V, match_district: d, name_cn: d.replace(/(市|区|县)$/u, '') || d });
      inserted++;
    }
  }
});
run();
console.log(`Updated ${updated}, inserted ${inserted} GZ district zone(s).`);
