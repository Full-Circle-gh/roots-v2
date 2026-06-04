// One-off: bring the pre-existing 上海市 / 北京市 city zones in line with the
// rest of the flat-rate set (25¥ flat / 329¥ free, 0.8·cap10 packing, lead
// 3–15, day-only, active). Backs up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-shbj-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const REGIONS = ['上海市', '北京市'];

const db = new Database(DB_PATH);
const upd = db.prepare(
  `UPDATE retail_delivery_zones SET
     base_fee = 25, max_fee = NULL, free_threshold = 329,
     packing_fee_per_item = 0.8, packing_fee_cap = 10,
     is_active = 1, same_day_allowed = 1, same_day_surcharge = 0,
     min_lead_days = 1, max_lead_days = 15,
     slot_start_hour = 0, slot_end_hour = 0, slot_duration_minutes = 0,
     day_only = 1, updated_at = CURRENT_TIMESTAMP
   WHERE zone_type='city' AND match_city = ?`
);

let changed = 0;
const run = db.transaction(() => {
  for (const r of REGIONS) changed += upd.run(r).changes;
});
run();
console.log(`Updated ${changed} zone(s):`, REGIONS.join(', '));
