// Force min_lead_days = 0 on every Guangzhou-district zone. All of Guangzhou
// is same-day-capable (the same-day surcharge, not a lead day, is how the
// exception districts 花都/番禺/南沙/从化/增城 are gated), so a GZ district
// must never carry a >=1 lead — that would push its earliest slot to
// tomorrow and hide today's time-slots (the bug seen on Huadu).
//
// Touches ONLY min_lead_days; day_only / surcharge / fees / hours are left
// exactly as configured. Idempotent. Backs up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-gzlead-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

const db = new Database(DB_PATH);
const rows = db.prepare(
  `SELECT id, match_district, min_lead_days, day_only
     FROM retail_delivery_zones WHERE zone_type = 'gz_district'`
).all();

const update = db.prepare(
  `UPDATE retail_delivery_zones
      SET min_lead_days = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`
);

const fixed = [];
const run = db.transaction(() => {
  for (const r of rows) {
    if (r.min_lead_days !== 0) { update.run(r.id); fixed.push(`${r.match_district}(was ${r.min_lead_days})`); }
  }
});
run();

console.log(`Scanned ${rows.length} GZ district zone(s).`);
if (fixed.length) console.log(`Set min_lead_days=0 on ${fixed.length}:`, fixed.join(', '));
else console.log('All GZ district zones already had min_lead_days=0.');
