// Align Guangzhou-district zones to the same-day spec.
//
//  • ALL GZ districts → min_lead_days = 0 (Guangzhou is same-day-capable;
//    a >=1 lead wrongly hid today's slots — the Huadu bug).
//  • The five EXCEPTION districts → "Panyu style": day-only mode with a
//    flat same-day surcharge the customer pays to get it today. Same-day
//    allowed, kitchen 10-20, 2h slots, max lead 14.
//      番禺 ¥20 · 花都 ¥30 · 南沙 ¥40 · 从化 ¥40 · 增城 ¥40
//  • The 6 core districts keep their existing mode (time-slot, no surcharge);
//    only their lead is normalized to 0.
//
// FEE fields (base_fee / max_fee / free_threshold / packing_*) are left
// untouched everywhere. Idempotent. Backs up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-gzsameday-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const SURCHARGE = {
  '番禺区': 20,
  '花都区': 30,
  '南沙区': 40,
  '从化区': 40,
  '增城区': 40,
};

const db = new Database(DB_PATH);
const rows = db.prepare(
  `SELECT id, match_district, min_lead_days, day_only, same_day_surcharge
     FROM retail_delivery_zones WHERE zone_type = 'gz_district'`
).all();

// Lead-only normalization for every GZ district.
const setLead = db.prepare(
  `UPDATE retail_delivery_zones SET min_lead_days = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
);
// Full Panyu-style profile for an exception district (fees untouched).
const setPanyuStyle = db.prepare(
  `UPDATE retail_delivery_zones SET
     same_day_allowed = 1, same_day_surcharge = @surcharge,
     min_lead_days = 0, max_lead_days = 14,
     slot_start_hour = 10, slot_end_hour = 20, slot_duration_minutes = 120,
     day_only = 1, updated_at = CURRENT_TIMESTAMP
   WHERE id = @id`
);

const leadFixed = [];
const styled = [];
const run = db.transaction(() => {
  for (const r of rows) {
    if (SURCHARGE.hasOwnProperty(r.match_district)) {
      setPanyuStyle.run({ id: r.id, surcharge: SURCHARGE[r.match_district] });
      styled.push(`${r.match_district}=¥${SURCHARGE[r.match_district]}`);
    } else if (r.min_lead_days !== 0) {
      setLead.run(r.id);
      leadFixed.push(`${r.match_district}(was ${r.min_lead_days})`);
    }
  }
});
run();

console.log(`Scanned ${rows.length} GZ district zone(s).`);
console.log(`Panyu-style (day-only + surcharge) applied to ${styled.length}:`, styled.join(', ') || '(none)');
console.log(`Lead normalized to 0 on ${leadFixed.length} core district(s):`, leadFixed.join(', ') || '(none — already 0)');
