#!/usr/bin/env node
/**
 * Diagnose delivery-address PINS (read-only).
 *
 * Answers the question "how do we know the courier is being sent to the right
 * place?" for data that already exists. A geocoder always answers: when it
 * can't find the street it quietly returns the district's — or the city's —
 * centre, which looks exactly like a real result and can sit tens of km from
 * the door. This script re-resolves each address and reports what the provider
 * ACTUALLY matched, so bad pins can be found before a customer finds them.
 *
 * Per row it reports:
 *   • source     — where the stored pin came from (customer_pin = tapped on the
 *                  map, geocode:* = derived from text, none = never resolved)
 *   • precision  — rooftop / street / coarse, from the provider's own grading
 *   • city       — did the match land in the city the address claims?
 *   • latin      — does the street still carry English/pinyin (which is what
 *                  pushes a geocoder into a centroid answer)?
 *   • drift      — km between the STORED pin and a fresh re-resolve; a big
 *                  number means one of the two is wrong
 *
 * READ-ONLY. Writes nothing. Costs one geocode call per row when --verify is
 * passed and AMAP_MAPS_KEY / TENCENT_MAPS_KEY are set (bounded by --limit).
 *
 *   node scripts/diagnose_address_pins.js                 # stored state only, no API calls
 *   node scripts/diagnose_address_pins.js --verify        # + re-resolve each address
 *   node scripts/diagnose_address_pins.js --verify --limit 40
 *   node scripts/diagnose_address_pins.js --orders        # recent delivery ORDER snapshots
 *   node scripts/diagnose_address_pins.js --bad-only      # only rows that need attention
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const VERIFY   = has('--verify');
const ORDERS   = has('--orders');
const BAD_ONLY = has('--bad-only');
const LIMIT    = parseInt(flag('--limit', '60'), 10);

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* optional */ }
const geocode = require('../lib/geocode');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true });

const hasLatin = (s) => /[A-Za-z]/.test(String(s || ''));
const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

function rows() {
  if (!ORDERS) {
    return db.prepare(
      `SELECT id, province, city, district, address, detail, lat, lng, geo_source, geo_precision
         FROM retail_customer_addresses
        ORDER BY id DESC LIMIT ?`
    ).all(LIMIT).map(r => ({ ...r, label: `addr#${r.id}` }));
  }
  return db.prepare(
    `SELECT id, order_no, address_json
       FROM retail_orders
      WHERE fulfillment_type = 'delivery' AND address_json IS NOT NULL
      ORDER BY id DESC LIMIT ?`
  ).all(LIMIT).map(r => {
    let a = {}; try { a = JSON.parse(r.address_json) || {}; } catch { /* malformed */ }
    return {
      id: r.id, label: r.order_no || `order#${r.id}`,
      province: a.province, city: a.city, district: a.district,
      address: a.address, detail: a.detail,
      lat: a.lat, lng: a.lng, geo_source: a.geo_source, geo_precision: a.geo_precision,
      pickup: !!a.pickup,
    };
  }).filter(r => !r.pickup);
}

(async () => {
  const list = rows();
  if (!list.length) { console.log('No rows.'); return; }

  console.log(`\n${ORDERS ? 'Order ship-to snapshots' : 'Saved customer addresses'} — newest ${list.length}`);
  if (VERIFY && !geocode.configured()) {
    console.log('⚠  --verify needs AMAP_MAPS_KEY or TENCENT_MAPS_KEY; showing stored state only.\n');
  }
  console.log(`${pad('ROW', 12)} ${pad('SOURCE', 16)} ${pad('STORED', 9)} ${pad('RE-RESOLVED', 12)} ${pad('CITY', 6)} ${pad('LATIN', 6)} ${pad('DRIFT', 8)} ADDRESS`);
  console.log('-'.repeat(120));

  const tally = { total: 0, noPin: 0, coarse: 0, latin: 0, cityMismatch: 0, drifted: 0, customerPin: 0, unknownProvenance: 0 };

  for (const r of list) {
    tally.total++;
    const latin = hasLatin(r.address) || hasLatin(r.detail);
    if (latin) tally.latin++;
    const hasPin = r.lat != null && r.lng != null;
    if (!hasPin) tally.noPin++;
    if (r.geo_source === 'customer_pin') tally.customerPin++;
    if (r.geo_precision === 'coarse') tally.coarse++;

    let fresh = null, drift = null, cityOk = null;
    if (VERIFY && geocode.configured()) {
      fresh = await geocode.geocodeAddress({
        province: r.province, city: r.city, district: r.district,
        address: [r.address, r.detail].filter(Boolean).join(' '),
      });
      if (fresh) {
        cityOk = fresh.cityMatch;
        if (cityOk === false) tally.cityMismatch++;
        if (hasPin) {
          drift = geocode.haversineKm({ lat: Number(r.lat), lng: Number(r.lng) }, { lat: fresh.lat, lng: fresh.lng });
          if (drift != null && drift > 1) tally.drifted++;
        }
      }
    }

    // "Needs attention" = anything a courier should not be sent to on trust:
    // no pin at all, a centroid-grade pin, a wrong-city match, English text, or
    // a stored pin that no longer agrees with the address it belongs to. Also the two provenance states the courier
    // push will not take on trust: a pin with no recorded source at all (every
    // pre-provenance row, plus anything the old geocode-backfill wrote), and a
    // coordinate a client sent without saying it came from the map picker. Both
    // are re-resolved and corroborated at push time, and REFUSED if the address
    // can't back them up — so they are worth fixing before an order rides on one.
    const unknownProvenance = hasPin && !r.geo_source;
    const clientUnverified  = r.geo_source === 'client_unverified';
    const bad = !hasPin || r.geo_precision === 'coarse' || cityOk === false || latin
             || unknownProvenance || clientUnverified
             || (fresh && (fresh.precision === 'coarse')) || (drift != null && drift > 1);
    if (unknownProvenance) tally.unknownProvenance++;
    if (BAD_ONLY && !bad) continue;

    console.log(
      `${pad(r.label, 12)} ${pad(r.geo_source || (hasPin ? 'unknown' : 'none'), 16)} `
      + `${pad(r.geo_precision || (hasPin ? '?' : '—'), 9)} `
      + `${pad(fresh ? `${fresh.precision}/${fresh.provider}` : (VERIFY ? 'no result' : '—'), 12)} `
      + `${pad(cityOk === false ? 'WRONG' : cityOk === true ? 'ok' : '—', 6)} `
      + `${pad(latin ? 'YES' : '—', 6)} `
      + `${pad(drift == null ? '—' : `${drift.toFixed(1)}km`, 8)} `
      + `${bad ? '⚠ ' : '  '}${[r.city, r.district, r.address, r.detail].filter(Boolean).join(' ').slice(0, 46)}`
    );
  }

  console.log('-'.repeat(120));
  console.log(`${tally.total} rows · ${tally.customerPin} map-picked · ${tally.noPin} with NO pin · `
    + `${tally.unknownProvenance} pinned but unattributed · `
    + `${tally.coarse} stored coarse · ${tally.latin} still English`
    + (VERIFY ? ` · ${tally.cityMismatch} wrong city · ${tally.drifted} drifted >1km` : ''));
  console.log(
    '\nA "coarse" pin is a district or city centre the geocoder fell back to — it is NOT the address,\n'
    + 'and lib/qingyun-payload refuses to send a rider to one. A row with coordinates but NO source is a\n'
    + 'pre-provenance leftover: the push re-resolves the address and ships the stored pin only if the two\n'
    + 'agree, so these are the rows most likely to be refused. Fix them with the admin "Make address\n'
    + 'Chinese" tool, or by asking the customer to drop a pin on the map (which records provenance).\n');
})().catch(e => { console.error(e.message); process.exit(1); });
