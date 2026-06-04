// Batch 3: Hong Kong + its 18 districts at 50¥ flat / 500¥ free, same
// packing/lead/slot config. Idempotent — skips any already-present city zone.
// Backs up first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-zones3-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const REGIONS = [
  '香港', '中西区', '东区', '九龙城区', '观塘区', '南区', '深水埗区', '黄大仙区',
  '湾仔区', '油尖旺区', '离岛区', '葵青区', '北区', '西贡区', '沙田区', '屯门区',
  '大埔区', '荃湾区', '元朗区',
];

const SHARED = {
  base_fee: 50,
  max_fee: null,
  free_threshold: 500,
  packing_fee_per_item: 0.8,
  packing_fee_cap: 10,
  is_active: 1,
  sort_order: 0,
  same_day_allowed: 1,
  same_day_surcharge: 0,
  min_lead_days: 1,
  max_lead_days: 15,
  slot_start_hour: 0,
  slot_end_hour: 0,
  slot_duration_minutes: 0,
  day_only: 1,
};

const db = new Database(DB_PATH);
const exists = db.prepare(
  `SELECT 1 FROM retail_delivery_zones WHERE zone_type='city' AND match_city=?`
);
const insert = db.prepare(
  `INSERT INTO retail_delivery_zones
     (zone_type, name_en, name_cn, match_city, match_district, base_fee, max_fee,
      free_threshold, packing_fee_per_item, packing_fee_cap, is_active, sort_order,
      same_day_allowed, same_day_surcharge, min_lead_days, max_lead_days,
      slot_start_hour, slot_end_hour, slot_duration_minutes, day_only)
   VALUES (@zone_type,@name_en,@name_cn,@match_city,@match_district,@base_fee,@max_fee,
      @free_threshold,@packing_fee_per_item,@packing_fee_cap,@is_active,@sort_order,
      @same_day_allowed,@same_day_surcharge,@min_lead_days,@max_lead_days,
      @slot_start_hour,@slot_end_hour,@slot_duration_minutes,@day_only)`
);

let added = 0, skipped = [];
const run = db.transaction(() => {
  for (const region of REGIONS) {
    if (exists.get(region)) { skipped.push(region); continue; }
    insert.run({
      zone_type: 'city',
      name_en: null,
      name_cn: region.replace(/(市|区|县)$/u, '') || region,
      match_city: region,
      match_district: null,
      ...SHARED,
    });
    added++;
  }
});
run();
console.log(`Added ${added} zone(s).`);
if (skipped.length) console.log(`Skipped ${skipped.length} already present:`, skipped.join(', '));
