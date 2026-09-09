#!/usr/bin/env node
/**
 * diagnose_delivery_zone_coverage.js — THE GATE for §82's refusal.
 *
 * §82 (docs/tacet-consolidation-decisions.md) rules that an address matching no
 * delivery zone is a configuration error and every order-creation path refuses
 * it, with no legacy fee fallback. That refusal cannot ship until the zone table
 * covers every district that has actually taken orders — otherwise Monday's real
 * orders start getting rejected.
 *
 * This measures the gap. It writes nothing.
 *
 * THE QUESTION THAT DECIDES THE SHAPE OF THE WORK is section 1: is
 * `delivery.defaultZone` enabled? matchDeliveryZone() falls back to a
 * synthesized national zone when nothing specific matches — but ONLY when that
 * config is enabled, and NEVER for a Guangzhou address once any gz_district row
 * exists (it returns null from inside the Guangzhou branch rather than falling
 * through). So:
 *
 *   enabled  → the only reachable null is a Guangzhou district. Small gap.
 *   disabled → every city without a row is a null. Potentially hundreds.
 *
 * WHAT THIS SCRIPT DOES NOT DO, said plainly because the difference matters.
 * It does not load routes/retail.js — that module registers routes and wants a
 * live tdb(). matchDeliveryZone's rule is TRANSCRIBED into `wouldMatch()` below
 * and marked as a transcription. It reproduces the structure that decides
 * matched-vs-null (Hong Kong, the Guangzhou district branch and its refusal,
 * exact city, province, blob substring, national default). It is a reading of
 * the code, not the code, and section 4 labels its output accordingly.
 *
 * SCOPE IS ONE TENANT. retail_delivery_zones has no tenant_id column: isolation
 * is DB-per-tenant (lib/tenant-db.js), so every row in THIS file is tenant 1
 * (Roots). Section 0 lists the tenants table and looks for other tenant DB files
 * so the report says what it did and did not measure.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 *   node scripts/diagnose_delivery_zone_coverage.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}

console.log('db:           ' + DB_PATH);
console.log('run at (UTC): ' + new Date().toISOString());
console.log('');

const J = (v) => JSON.stringify(v);
function cfg(key) {
  try {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!r) return { present: false, raw: null, value: null };
    let v; try { v = JSON.parse(r.value_json); } catch { v = r.value_json; }
    return { present: true, raw: r.value_json, value: v };
  } catch (e) { return { present: false, raw: null, value: null, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · scope — which tenant is this, and are there others ══');
{
  try {
    const t = db.prepare('SELECT id, name, status FROM tenants ORDER BY id').all();
    console.log(`tenants table: ${t.length} row(s)`);
    for (const r of t) console.log('  ' + J(r));
  } catch (e) { console.log('tenants table unreadable: ' + e.message); }
  // DB-per-tenant: other tenants live in their own files and are NOT in this one.
  const tdir = '/root/roots-v2/data/tenants';
  try {
    const files = fs.readdirSync(tdir).filter(f => f.endsWith('.db'));
    console.log(`data/tenants/: ${files.length} other tenant database(s) — NOT measured here: ${files.join(', ') || '(none)'}`);
  } catch (e) { console.log('data/tenants/: not present or unreadable (' + e.message + ')'); }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · THE DECIDING QUESTION — is delivery.defaultZone enabled? ══');
const dz = cfg('delivery.defaultZone');
const dEnabled = cfg('delivery.enabled');
{
  console.log('delivery.defaultZone present: ' + dz.present);
  console.log('delivery.defaultZone raw:     ' + (dz.raw == null ? '(absent)' : dz.raw));
  console.log('delivery.enabled raw:         ' + (dEnabled.raw == null ? '(absent)' : dEnabled.raw));
  const on = !!(dz.value && dz.value.enabled);
  console.log('');
  console.log('  →  defaultZone ENABLED: ' + on);
  console.log(on
    ? '     Out-of-city addresses fall back to the national zone. The only reachable\n'
      + '     null is a Guangzhou district with no gz_district row. Gap is SMALL.'
    : '     There is no national fallback. EVERY city without a row resolves null.\n'
      + '     Gap is potentially every city that has ever ordered. Gap is LARGE.');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · every row in retail_delivery_zones (raw) ══');
const zones = (() => {
  try { return db.prepare('SELECT * FROM retail_delivery_zones ORDER BY zone_type, sort_order, id').all(); }
  catch (e) { console.log('unreadable: ' + e.message); return []; }
})();
{
  console.log(`${zones.length} row(s). Tenant: 1 (Roots) — this table has no tenant_id column.`);
  for (const z of zones) console.log('  ' + J(z));
}
const activeZones = zones.filter(z => Number(z.is_active) === 1);
console.log(`\nactive: ${activeZones.length}  ·  gz_district: ${activeZones.filter(z => z.zone_type === 'gz_district').length}  ·  city: ${activeZones.filter(z => z.zone_type === 'city').length}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · every distinct district on historical orders (raw, whole history) ══');
// address_json is parsed in JS rather than with SQLite's JSON functions so a
// malformed row is reported instead of silently dropped by json_extract.
const orders = (() => {
  try {
    return db.prepare(
      `SELECT id, order_no, channel, fulfillment_type, status, address_json, placed_at
         FROM retail_orders`
    ).all();
  } catch (e) { console.log('unreadable: ' + e.message); return []; }
})();

const seen = new Map();   // "city|district" → {city, district, n, last, channels:Set, ftypes:Set, sample}
let unparseable = 0, noAddress = 0;
for (const o of orders) {
  let a = null;
  if (!o.address_json) { noAddress++; continue; }
  try { a = JSON.parse(o.address_json); } catch { unparseable++; continue; }
  if (!a || typeof a !== 'object') { unparseable++; continue; }
  const city = String(a.city || '').trim();
  const district = String(a.district || '').trim();
  const key = city + '|' + district;
  let e = seen.get(key);
  if (!e) { e = { city, district, n: 0, last: '', channels: new Set(), ftypes: new Set(), sample: o.order_no, pickup: !!a.pickup }; seen.set(key, e); }
  e.n++;
  if ((o.placed_at || '') > e.last) e.last = o.placed_at || '';
  e.channels.add(o.channel == null ? '(null)' : o.channel);
  e.ftypes.add(o.fulfillment_type == null ? '(null)' : o.fulfillment_type);
}
{
  console.log(`${orders.length} order row(s) scanned.`);
  console.log(`  with no address_json at all: ${noAddress}  (mirrored channels carry none)`);
  console.log(`  address_json unparseable:    ${unparseable}`);
  console.log(`  distinct (city, district):   ${seen.size}`);
  console.log('');
  const rows = [...seen.values()].sort((a, b) => b.n - a.n);
  for (const r of rows) {
    console.log('  ' + J({
      city: r.city, district: r.district, orders: r.n, most_recent: r.last,
      channels: [...r.channels], fulfillment_types: [...r.ftypes],
      pickup_snapshot: r.pickup, sample_order: r.sample,
    }));
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · the gap — order districts that resolve NO zone ══');
console.log('   NOTE: wouldMatch() below is a TRANSCRIPTION of routes/retail.js');
console.log('   matchDeliveryZone(), not the function itself. It reproduces the');
console.log('   matched-vs-null structure only. Treat its verdict as a reading.');
console.log('');
{
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/(市|区|县|省)$/u, '');
  const stripSuffix = (s) => String(s || '').replace(/(市|区|县|省)$/u, '');
  const GZ_ALIASES = new Set(['广州', '广州市', 'guangzhou', 'gz']);
  const isGz = (city) => {
    if (!city) return false;
    const n = String(city).trim().toLowerCase();
    return GZ_ALIASES.has(n) || norm(city) === 'guangzhou' || norm(city) === '广州';
  };
  const gzRows   = activeZones.filter(z => z.zone_type === 'gz_district');
  const cityRows = activeZones.filter(z => z.zone_type === 'city');
  const defaultOn = !!(dz.value && dz.value.enabled);

  // Transcribed from matchDeliveryZone(). `blob` here is only city+district —
  // the live matcher also folds in address/detail/province free text, so a real
  // address can match on street text this cannot see. That makes this verdict
  // PESSIMISTIC: it can report a null the live matcher would rescue, never the
  // other way round. Erring that way is the right direction for a gate.
  function wouldMatch(city, district) {
    const blob = [city, district].filter(Boolean).join(' ');
    if (/香港/.test(blob) || /hong\s*kong/i.test(blob)) {
      const hk = cityRows.find(z => z.match_city === '香港');
      if (hk) return { matched: true, via: 'hong_kong', zone: hk.id };
    }
    if (isGz(city) || /广州/.test(blob)) {
      if (gzRows.length) {
        for (const r of gzRows) {
          if (district && norm(r.match_district) === norm(district)) return { matched: true, via: 'gz_district_exact', zone: r.id };
          const full = r.match_district || '';
          if (full && blob.includes(full)) return { matched: true, via: 'gz_district_blob', zone: r.id };
          const st = stripSuffix(full);
          if (st && st.length >= 2 && blob.includes(st)) return { matched: true, via: 'gz_district_blob_stripped', zone: r.id };
        }
        // THE REFUSAL: a Guangzhou address with districts configured and no hit
        // returns null and does NOT fall through to the national default.
        return { matched: false, via: 'gz_district_no_match' };
      }
    }
    for (const r of cityRows) if (city && norm(r.match_city) === norm(city)) return { matched: true, via: 'city_exact', zone: r.id };
    for (const r of cityRows) {
      const full = r.match_city || '';
      if (full && blob.includes(full)) return { matched: true, via: 'city_blob', zone: r.id };
      const st = stripSuffix(full);
      if (st && st.length >= 2 && blob.includes(st)) return { matched: true, via: 'city_blob_stripped', zone: r.id };
    }
    if (defaultOn) return { matched: true, via: 'national_default' };
    return { matched: false, via: 'no_zone_and_no_default' };
  }

  const rows = [...seen.values()].sort((a, b) => b.n - a.n);
  const gaps = [];
  for (const r of rows) {
    // A pickup order carries a store snapshot, not a delivery address, and never
    // reaches matchDeliveryZone. Counted separately rather than reported as a gap.
    if (r.pickup) continue;
    const v = wouldMatch(r.city, r.district);
    if (!v.matched) gaps.push({ ...r, via: v.via });
  }
  console.log(`${gaps.length} distinct (city, district) combination(s) resolve NO zone:`);
  let affected = 0;
  for (const g of gaps) {
    affected += g.n;
    console.log('  ' + J({
      city: g.city, district: g.district, orders: g.n, most_recent: g.last,
      reason: g.via, channels: [...g.channels], sample_order: g.sample,
    }));
  }
  console.log('');
  console.log(`orders behind the gap: ${affected} of ${orders.length}`);
  console.log(gaps.length === 0
    ? '  → nothing in the order history would be refused. §82 can ship on this data.'
    : '  → these must gain a zone row BEFORE §82\'s refusal ships, or these\n'
      + '    addresses start being rejected at checkout.');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · what the address picker offers vs what the table covers ══');
// The picker is a STATIC national list (reference/china_regions.json via
// regionPickerRows()), not the zone table — so a customer can pick a place that
// has no row. This is the upper bound on the gap, independent of order history.
{
  let regions = null;
  for (const p of [path.join(HOME, 'reference', 'china_regions.json'), '/root/roots-v2/reference/china_regions.json']) {
    try { regions = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (_) { /* try next */ }
  }
  if (!regions) { console.log('reference/china_regions.json not readable from this host — skipped.'); }
  else {
    const gzOffered = (regions.guangzhou_districts || []).map(d => d.name_cn);
    const citiesOffered = (regions.cities || []).map(c => c.name_cn);
    const gzCovered = new Set(activeZones.filter(z => z.zone_type === 'gz_district').map(z => z.match_district));
    const cityCovered = new Set(activeZones.filter(z => z.zone_type === 'city').map(z => z.match_city));
    const gzMissing = gzOffered.filter(d => !gzCovered.has(d));
    const cityMissing = citiesOffered.filter(c => !cityCovered.has(c));
    console.log(`picker offers ${gzOffered.length} Guangzhou district(s); ${gzMissing.length} have no zone row:`);
    console.log('  ' + (gzMissing.join(' ') || '(none)'));
    console.log(`picker offers ${citiesOffered.length} mainland cities; ${cityMissing.length} have no zone row.`);
    console.log('  (each is a null only when defaultZone is OFF — see section 1)');
  }
}

console.log('\ndone — nothing was written.');
