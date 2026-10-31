// Remove individual city delivery zones that are fully redundant — i.e. their
// province already has a province-wide ('全省') row AND that province row
// matches the city on EVERY operational field, so the city row delivers
// nothing the province row wouldn't. Cities that differ in any field (a
// different fee, lead time, same-day rule, etc.) or whose province has no
// province-wide row (e.g. Guangdong) are LEFT UNTOUCHED.
//
// Safe by default: prints a dry-run plan and changes nothing. Pass --apply to
// actually delete (backs the DB up first, runs in one transaction).
//
//   node scripts/dedupe_province_covered_cities.js            # dry run
//   node scripts/dedupe_province_covered_cities.js --apply    # delete
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const REGIONS = require(path.join(__dirname, '..', 'reference', 'china_regions.json'));

// Fields that define "same cost / same behaviour". If a city row matches the
// province row on all of these, it's redundant.
const FIELDS = [
  'base_fee', 'free_threshold', 'max_fee', 'packing_fee_per_item', 'packing_fee_cap',
  'is_active', 'same_day_allowed', 'same_day_surcharge', 'min_lead_days', 'max_lead_days',
  'slot_start_hour', 'slot_end_hour', 'slot_duration_minutes', 'day_only',
];

// province_cn for any city name, + the set of province names themselves.
const cityProv = new Map();
const provNames = new Set();
for (const c of (REGIONS.cities || [])) {
  if (c.name_cn && c.province_cn) cityProv.set(c.name_cn, c.province_cn);
  if (c.province_cn) provNames.add(c.province_cn);
}
function provinceOf(z) {
  if (provNames.has(z.match_city)) return z.match_city;       // a 省-named row → itself
  return cityProv.get(z.match_city) || null;
}
function sameCost(a, b) {
  return FIELDS.every(f => (a[f] ?? null) === (b[f] ?? null));
}

const db = new Database(DB_PATH);
const cityZones = db.prepare(
  `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city'`
).all();

// province_cn → the province-wide row (match_city IS its own province)
const provinceRow = new Map();
for (const z of cityZones) {
  if (provNames.has(z.match_city)) provinceRow.set(z.match_city, z);
}

const redundant = [];   // covered identically → delete
const kept = [];        // a city under a province row, but differs → keep
for (const z of cityZones) {
  if (provNames.has(z.match_city)) continue;        // skip the province rows themselves
  const prov = provinceOf(z);
  const pRow = prov && provinceRow.get(prov);
  if (!pRow) continue;                              // no province-wide row (e.g. Guangdong) → leave
  if (sameCost(z, pRow)) redundant.push({ z, prov });
  else kept.push({ z, prov, diff: FIELDS.filter(f => (z[f] ?? null) !== (pRow[f] ?? null)) });
}

console.log(`\nProvince-wide rows found: ${provinceRow.size}`);
console.log(`City rows under a province-wide row: ${redundant.length + kept.length}`);

console.log(`\n── REDUNDANT (covered identically by their province) ── ${redundant.length}`);
for (const { z, prov } of redundant) {
  console.log(`  delete  ${z.match_city}  (under ${prov})  ¥${z.base_fee}`);
}
console.log(`\n── KEPT (differs from province row — left as is) ── ${kept.length}`);
for (const { z, prov, diff } of kept) {
  console.log(`  keep    ${z.match_city}  (under ${prov})  differs: ${diff.join(', ')}`);
}

if (!APPLY) {
  console.log(`\nDry run — nothing changed. Re-run with --apply to delete the ${redundant.length} redundant row(s).`);
  process.exit(0);
}

if (!redundant.length) { console.log('\nNothing to delete.'); process.exit(0); }

const backup = DB_PATH.replace(/\.db$/, `-pre-dedupe-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${backup}`);

const del = db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?');
const run = db.transaction(() => { for (const { z } of redundant) del.run(z.id); });
run();
console.log(`Deleted ${redundant.length} redundant city zone(s).`);
