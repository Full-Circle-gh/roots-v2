// One-off: add flat-rate city delivery zones (25¥ flat / 329¥ free) for a
// fixed region list. Idempotent — skips any region that already has a
// zone_type='city' row with the same match_city. Backs up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-zones-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const REGIONS = [
  '上海市','江苏省','浙江省','湖北省','甘肃省','青海省','宁夏回族自治区','安徽省',
  '福建省','江西省','河南省','湖南省','广西壮族自治区','海南省','重庆市','四川省',
  '贵州省','云南省','内蒙古自治区','吉林省','黑龙江省','北京市','天津市','河北省',
  '山西省','太原市','大同市','阳泉市','长治市','晋城市','朔州市','晋中市','运城市',
  '忻州市','临汾市','吕梁市','辽宁省','山东省','陕西省',
];

const SHARED = {
  base_fee: 25,
  max_fee: null,
  free_threshold: 329,
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
      // Mirror the admin UI's auto-name: strip a trailing 市/区/县 only.
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
