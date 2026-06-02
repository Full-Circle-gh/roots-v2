// Collapse the per-city Guangdong rows and the per-district Hong Kong rows into
// ONE row each — same price everywhere within the region.
//
//   • Guangdong: the ~20 GD prefecture-city rows (深圳/佛山/东莞…, all ¥15) →
//     a single 广东省 province-wide row. Addresses resolve via the matcher's
//     province pass (province backfilled from city). 广州 is NOT a city row
//     (it's same-day gz_district) and is left untouched.
//   • Hong Kong: the 18 district rows (中西区/东区/…, all ¥50) → the single
//     existing 香港 row. The matcher's new HK fast-path routes any 香港 address
//     to that row, so per-district rows are redundant.
//
// SAFETY: refuses to touch a region unless every row in it is byte-identical on
// the operational FIELDS (so we never silently flatten a row that charges
// differently). Prints a dry-run plan; --apply backs up the DB and runs in one
// transaction.
//
//   node scripts/consolidate_guangdong_and_hk.js            # dry run
//   node scripts/consolidate_guangdong_and_hk.js --apply    # do it
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const APPLY   = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const REGIONS = require(path.join(__dirname, '..', 'reference', 'china_regions.json'));

const FIELDS = [
  'base_fee', 'free_threshold', 'max_fee', 'packing_fee_per_item', 'packing_fee_cap',
  'is_active', 'same_day_allowed', 'same_day_surcharge', 'min_lead_days', 'max_lead_days',
  'slot_start_hour', 'slot_end_hour', 'slot_duration_minutes', 'day_only',
];

// 18 Hong Kong districts (match_city values of the per-district rows).
const HK_DISTRICTS = new Set([
  '中西区','东区','九龙城区','观塘区','南区','深水埗区','黄大仙区','湾仔区','油尖旺区',
  '离岛区','葵青区','北区','西贡区','沙田区','屯门区','大埔区','荃湾区','元朗区',
]);

// Guangdong prefecture cities (province_cn === '广东省') from the catalogue.
const GD_CITIES = new Set();
for (const c of (REGIONS.cities || [])) {
  if (c.province_cn === '广东省' && c.name_cn) GD_CITIES.add(c.name_cn);
}

const db = new Database(DB_PATH);
const cityZones = db.prepare(
  `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city'`
).all();

const norm = s => String(s || '').replace(/(市|区|县|省)$/u, '');
const sameProfile = (a, b) => FIELDS.every(f => (a[f] ?? null) === (b[f] ?? null));

// ── Partition the rows ────────────────────────────────────────────────────
const gdRows = cityZones.filter(z =>
  GD_CITIES.has(z.match_city) || GD_CITIES.has(norm(z.match_city) + '市'));
const hkDistrictRows = cityZones.filter(z => HK_DISTRICTS.has(z.match_city));
const hkMainRow = cityZones.find(z => z.match_city === '香港');
const gdProvinceRow = cityZones.find(z => z.match_city === '广东省');

function checkUniform(label, rows) {
  if (rows.length <= 1) return true;
  const odd = rows.filter(r => !sameProfile(r, rows[0]));
  if (odd.length) {
    console.log(`\n!! ${label}: rows are NOT uniform — refusing to flatten. Differs:`);
    for (const r of odd) {
      const d = FIELDS.filter(f => (r[f] ?? null) !== (rows[0][f] ?? null));
      console.log(`     ${r.match_city}  differs from ${rows[0].match_city}: ${d.join(', ')}`);
    }
    return false;
  }
  return true;
}

const gdUniform = checkUniform('Guangdong', gdRows);
const hkUniform = checkUniform('Hong Kong districts', hkDistrictRows);

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n── GUANGDONG ──`);
if (!gdRows.length) {
  console.log('  no Guangdong city rows found — nothing to do.');
} else {
  const p = gdRows[0];
  console.log(`  ${gdRows.length} city row(s) @ ¥${p.base_fee} (free over ${p.free_threshold ?? '—'}) → one 广东省 row`);
  console.log(`  cities: ${gdRows.map(r => r.match_city).join(', ')}`);
  console.log(`  province row exists already: ${gdProvinceRow ? 'yes (will reuse, only delete cities)' : 'no (will create)'}`);
}

console.log(`\n── HONG KONG ──`);
if (!hkDistrictRows.length) {
  console.log('  no HK district rows found — nothing to do.');
} else if (!hkMainRow) {
  console.log(`  ${hkDistrictRows.length} district row(s) found but NO 香港 row to keep — refusing.`);
  console.log(`  (create a 香港 city zone first, then re-run.)`);
} else {
  console.log(`  ${hkDistrictRows.length} district row(s) @ ¥${hkDistrictRows[0].base_fee} → keep single 香港 row (¥${hkMainRow.base_fee})`);
  console.log(`  districts: ${hkDistrictRows.map(r => r.match_city).join(', ')}`);
}

// ── Decide actions ───────────────────────────────────────────────────────
const toDelete = [];
let createGd = null;
if (gdRows.length && gdUniform) {
  for (const r of gdRows) toDelete.push(r);
  if (!gdProvinceRow) {
    const p = gdRows[0];
    createGd = {
      zone_type: 'city', name_en: 'Guangdong', name_cn: '广东', match_city: '广东省', match_district: null,
    };
    for (const f of FIELDS) createGd[f] = p[f];
    createGd.sort_order = 0;
  }
}
let hkOk = false;
if (hkDistrictRows.length && hkUniform && hkMainRow) {
  for (const r of hkDistrictRows) toDelete.push(r);
  hkOk = true;
}

const blocked =
  (gdRows.length && !gdUniform) ||
  (hkDistrictRows.length && (!hkUniform || !hkMainRow));

console.log(`\nPlan: ${createGd ? 'create 1 广东省 row, ' : ''}delete ${toDelete.length} row(s) ` +
  `(${gdRows.length && gdUniform ? gdRows.length + ' GD cities' : '0 GD'}, ${hkOk ? hkDistrictRows.length + ' HK districts' : '0 HK'}).`);

if (blocked) {
  console.log('\nOne or more regions were NON-uniform or missing their keep-row — those were skipped above. Fix and re-run.');
}

if (!APPLY) {
  console.log(`\nDry run — nothing changed. Re-run with --apply to execute.`);
  process.exit(0);
}
if (!toDelete.length && !createGd) { console.log('\nNothing to do.'); process.exit(0); }

const backup = DB_PATH.replace(/\.db$/, `-pre-consolidate-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${backup}`);

const del = db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?');
const ins = db.prepare(
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
const run = db.transaction(() => {
  if (createGd) ins.run(createGd);
  for (const r of toDelete) del.run(r.id);
});
run();
console.log(`Done. ${createGd ? 'Created 广东省. ' : ''}Deleted ${toDelete.length} row(s).`);
