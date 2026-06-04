// Normalize the SCHEDULING profile of every outside-Guangzhou zone
// (zone_type='city') to the standard outside-GZ rules, leaving all FEE
// fields (base_fee, free_threshold, packing_*) untouched.
//
// Why: some city zones were added via the admin UI (which defaults to
// same-day TIME-SLOT mode, kitchen 10-20h, lead 0). The idempotent batch
// seed scripts skip an already-present match_city, so those pre-existing
// zones never received the day-only / 1-day-lead profile — and checkout
// wrongly offered "Today 10am-8pm" / "Right away" for e.g. Xinjiang.
//
// gz_district zones are NOT touched (those keep their same-day time-slot
// config). Idempotent: re-running just re-asserts the same values. Backs
// up the DB first.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const backup  = DB_PATH.replace(/\.db$/, `-pre-slotfix-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log('Backed up DB →', backup);

// Outside-GZ scheduling profile (matches the batch seed scripts):
//   day-only, no same-day, earliest 1 day out, furthest 15, no kitchen
//   hours / time-slots. Lead is 1 (earliest = tomorrow) to match the
//   customer-facing "Express delivery (1–2 days)" copy in checkout.
const PROFILE = {
  same_day_allowed:      1,   // suppressed anyway by day_only + 0-0 hours
  same_day_surcharge:    0,
  min_lead_days:         1,
  max_lead_days:         15,
  slot_start_hour:       0,
  slot_end_hour:         0,
  slot_duration_minutes: 0,
  day_only:              1,
};

const db = new Database(DB_PATH);
const rows = db.prepare(
  `SELECT id, match_city, day_only, min_lead_days, slot_start_hour, slot_end_hour
     FROM retail_delivery_zones WHERE zone_type = 'city'`
).all();

const update = db.prepare(
  `UPDATE retail_delivery_zones SET
     same_day_allowed=@same_day_allowed, same_day_surcharge=@same_day_surcharge,
     min_lead_days=@min_lead_days, max_lead_days=@max_lead_days,
     slot_start_hour=@slot_start_hour, slot_end_hour=@slot_end_hour,
     slot_duration_minutes=@slot_duration_minutes, day_only=@day_only,
     updated_at=CURRENT_TIMESTAMP
   WHERE id=@id`
);

let changed = 0;
const fixed = [];
const run = db.transaction(() => {
  for (const r of rows) {
    const needsFix =
      r.day_only !== 1 || r.min_lead_days !== 1 ||
      r.slot_start_hour !== 0 || r.slot_end_hour !== 0;
    update.run({ ...PROFILE, id: r.id });
    changed++;
    if (needsFix) fixed.push(r.match_city);
  }
});
run();
console.log(`Re-asserted profile on ${changed} city zone(s).`);
if (fixed.length) console.log(`Corrected ${fixed.length} that were off-profile:`, fixed.join(', '));
else console.log('All city zones were already on-profile.');
