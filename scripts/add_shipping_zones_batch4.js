// Batch 4: Guangdong cities outside Guangzhou — city zones, 15¥ flat / 299¥
// free, standard outside-GZ profile (0.8·cap10 packing, lead 3–15, day-only,
// active). Idempotent — skips any already-present city zone. Backs up first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-zones4-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const REGIONS = [
  '韶关市', '深圳市', '珠海市', '汕头市', '佛山市', '江门市', '湛江市', '茂名市',
  '肇庆市', '惠州市', '梅州市', '汕尾市', '河源市', '阳江市', '清远市', '东莞市',
  '中山市', '潮州市', '揭阳市', '云浮市',
];

const SHARED = {
  base_fee: 15,
  max_fee: null,
  free_threshold: 299,
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
