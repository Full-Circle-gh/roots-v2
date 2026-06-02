// Collapse redundant delivery zones into the national default zone.
//
// Once the "Default delivery — rest of China" zone is enabled (admin →
// Delivery, stored as storefront_config['delivery.defaultZone']), any
// zone_type='city' row that delivers EXACTLY what the default would deliver is
// pure noise — the matcher's step-4 fallthrough already covers that address at
// the same price/lead-time. This deletes those rows so the operator's zone list
// shrinks to just the exceptions (cheaper provinces, Hong Kong, etc.).
//
// LEFT UNTOUCHED:
//   • any city/province row that differs from the default on ANY field
//     (e.g. 西藏/新疆 at ¥29, 广东 cities at ¥15, 香港 at ¥50) — kept verbatim,
//   • every gz_district row (Guangzhou same-day) — different zone_type,
//   • everything, if the default zone is OFF or unconfigured (aborts).
//
// Safe by default: prints a dry-run plan and changes nothing. Pass --apply to
// delete (backs the DB up first, runs in one transaction).
//
//   node scripts/collapse_zones_into_default.js            # dry run
//   node scripts/collapse_zones_into_default.js --apply    # delete
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const APPLY   = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const REGIONS = require(path.join(__dirname, '..', 'reference', 'china_regions.json'));

// Cost / behaviour fields that define "delivers the same thing". A city row
// matching the default on ALL of these is redundant.
const FIELDS = [
  'base_fee', 'free_threshold', 'max_fee', 'packing_fee_per_item', 'packing_fee_cap',
  'is_active', 'same_day_allowed', 'same_day_surcharge', 'min_lead_days', 'max_lead_days',
  'slot_start_hour', 'slot_end_hour', 'slot_duration_minutes', 'day_only',
];

// The set of province names (so we can label a row as province-wide vs a plain
// city, purely for the report — deletion logic is identical for both).
const provNames = new Set();
for (const c of (REGIONS.cities || [])) {
  if (c.province_cn) provNames.add(c.province_cn);
}

const db = new Database(DB_PATH);

// Read the saved default-zone config and rebuild the EFFECTIVE default exactly
// as routes/retail.js defaultDeliveryZone() would (same field defaults).
function readDefaultZone() {
  const row = db.prepare(
    `SELECT value_json FROM storefront_config WHERE key = 'delivery.defaultZone'`
  ).get();
  if (!row) return null;
  let c; try { c = JSON.parse(row.value_json); } catch { return null; }
  if (!c || !c.enabled) return null;
  return {
    base_fee:              Number(c.base_fee ?? 25),
    free_threshold:        c.free_threshold == null ? null : Number(c.free_threshold),
    max_fee:               null,
    packing_fee_per_item:  Number(c.packing_fee_per_item ?? 0),
    packing_fee_cap:       c.packing_fee_cap == null ? null : Number(c.packing_fee_cap),
    is_active:             1,
    same_day_allowed:      c.same_day_allowed ? 1 : 0,
    same_day_surcharge:    0,
    min_lead_days:         Number(c.min_lead_days ?? 3),
    max_lead_days:         Number(c.max_lead_days ?? 15),
    slot_start_hour:       Number(c.slot_start_hour ?? 0),
    slot_end_hour:         Number(c.slot_end_hour ?? 0),
    slot_duration_minutes: Number(c.slot_duration_minutes ?? 0),
    day_only:              c.day_only == null ? 1 : (c.day_only ? 1 : 0),
  };
}

const def = readDefaultZone();
if (!def) {
  console.error(
    '\nThe national default zone is OFF or unconfigured.\n' +
    'Enable it first (admin → Delivery → "Default delivery — rest of China"),\n' +
    'then re-run this script. Nothing changed.\n'
  );
  process.exit(1);
}

function sameAsDefault(z) {
  return FIELDS.every(f => (z[f] ?? null) === (def[f] ?? null));
}

const cityZones = db.prepare(
  `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city'`
).all();

const redundant = [];   // identical to default → delete
const kept = [];        // differs → keep
for (const z of cityZones) {
  const isProv = provNames.has(z.match_city);
  if (sameAsDefault(z)) redundant.push({ z, isProv });
  else kept.push({ z, isProv, diff: FIELDS.filter(f => (z[f] ?? null) !== (def[f] ?? null)) });
}

console.log('\nDefault zone (effective):',
  `¥${def.base_fee} · free over ${def.free_threshold == null ? '—' : '¥'+def.free_threshold}` +
  ` · pack ¥${def.packing_fee_per_item}/item` +
  ` cap ${def.packing_fee_cap == null ? '—' : '¥'+def.packing_fee_cap}` +
  ` · lead ${def.min_lead_days}d · day_only ${def.day_only}`);
console.log(`City zones examined: ${cityZones.length}`);

console.log(`\n── REDUNDANT (default already covers identically) ── ${redundant.length}`);
for (const { z, isProv } of redundant) {
  console.log(`  delete  ${z.match_city}${isProv ? '  (province-wide)' : ''}  ¥${z.base_fee}`);
}
console.log(`\n── KEPT (differs from default — left as is) ── ${kept.length}`);
for (const { z, isProv, diff } of kept) {
  console.log(`  keep    ${z.match_city}${isProv ? '  (province-wide)' : ''}  ¥${z.base_fee}  differs: ${diff.join(', ')}`);
}

if (!APPLY) {
  console.log(`\nDry run — nothing changed. Re-run with --apply to delete the ${redundant.length} redundant row(s).`);
  process.exit(0);
}

if (!redundant.length) { console.log('\nNothing to delete.'); process.exit(0); }

const backup = DB_PATH.replace(/\.db$/, `-pre-collapse-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${backup}`);

const del = db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?');
const run = db.transaction(() => { for (const { z } of redundant) del.run(z.id); });
run();
console.log(`Deleted ${redundant.length} redundant city zone(s). The national default now covers them.`);
