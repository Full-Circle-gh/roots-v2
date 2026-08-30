#!/usr/bin/env node
/**
 * Offline self-test for the delivery-address pin pipeline. No DB, no network,
 * no keys — pure logic, safe to run anywhere:
 *
 *   node scripts/test_address_pin.js
 *
 * Covers the three things that put a rider in the wrong place:
 *   1. the street/detail join that used to print a building twice
 *      ('品秀星越花园A栋 A栋18层1801室') and feed that doubled text to the geocoder;
 *   2. the precision gate that tells a real building match apart from a
 *      district centroid the geocoder returned because it found nothing;
 *   3. buildCreatePayload's pin chain — customer pin wins, a coarse geocode is
 *      refused rather than sent, and an out-of-range weak pin is refused.
 */
'use strict';

const assert = require('assert');
const { buildCreatePayload, joinStreetDetail } = require('../lib/qingyun-payload');
const geocode = require('../lib/geocode');
// Shared with scripts/test_needs_point.js. This file used to require
// better-sqlite3 directly with no fallback, so the G1/round-4 suites below
// failed outright on any machine where the native binding had not been built —
// reported as if the statements under test were broken.
const { openQueueTableDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// The round-1 rule, kept verbatim as a reference so the de-duplication tests can
// assert a real DIFFERENCE rather than a property both versions happen to share.
// It stripped ANY shared head of two or more characters, which is how
// '中山一路1号' + '1号楼2单元' lost building 1.
function naiveJoinV1(street, detail) {
  const s = String(street || '').trim(), d = String(detail || '').trim();
  if (!s) return d;
  if (!d) return s;
  if (s.includes(d)) return s;
  if (d.includes(s)) return d;
  let rest = d;
  for (let n = Math.min(s.length, d.length); n >= 2; n--) {
    if (s.slice(-n) === d.slice(0, n)) {
      rest = d.slice(n).replace(/^[\s,，、.。;；:：\-–—]+/u, '').trim();
      break;
    }
  }
  return rest ? `${s} ${rest}` : s;
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function itAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\njoinStreetDetail — street + floor/unit without repeating the overlap');
it('drops the building repeated at the head of the detail', () => {
  assert.strictEqual(
    joinStreetDetail('品秀星越花园，A栋', 'A栋，18层，1801室'),
    '品秀星越花园，A栋 18层，1801室');
});
it('keeps a detail that shares nothing with the street', () => {
  assert.strictEqual(joinStreetDetail('珠江西路15号', '3层302室'), '珠江西路15号 3层302室');
});
it('collapses a detail already spelled out in the street', () => {
  assert.strictEqual(joinStreetDetail('珠江西路15号3层302室', '3层302室'), '珠江西路15号3层302室');
});
it('takes the detail when it is the fuller of the two', () => {
  assert.strictEqual(joinStreetDetail('珠江西路15号', '珠江西路15号3层302室'), '珠江西路15号3层302室');
});
it('never trims on a single shared character', () => {
  // '中山一路8号' ends in 号 and '号楼302室' begins with it — a ONE-character
  // overlap. Asserted against a reference implementation of the naive rule so
  // this can't quietly become vacuous: the two must AGREE here (neither strips a
  // lone char) and DISAGREE on the two-character street-number case below, which
  // is the defect that actually shipped.
  assert.strictEqual(joinStreetDetail('中山一路8号', '号楼302室'), '中山一路8号 号楼302室');
  assert.strictEqual(naiveJoinV1('中山一路8号', '号楼302室'), '中山一路8号 号楼302室',
    'the naive rule also leaves a single shared char alone — this case alone proves nothing');
  assert.notStrictEqual(
    joinStreetDetail('中山一路1号', '1号楼2单元'),
    naiveJoinV1('中山一路1号', '1号楼2单元'),
    'the current rule must differ from the naive one on a shared STREET NUMBER');
  assert.strictEqual(naiveJoinV1('中山一路1号', '1号楼2单元'), '中山一路1号 楼2单元',
    '…because the naive rule ate the building number');
});
it('survives an empty side', () => {
  assert.strictEqual(joinStreetDetail('', '302室'), '302室');
  assert.strictEqual(joinStreetDetail('珠江西路15号', ''), '珠江西路15号');
});

console.log('\nisDeliverablePin — a centroid is not an address');
it('accepts a building match in the right city', () => {
  const v = geocode.isDeliverablePin({ lat: 23.1, lng: 113.3, precision: 'rooftop', cityMatch: true });
  assert.strictEqual(v.ok, true);
});
it('accepts a street match', () => {
  assert.strictEqual(geocode.isDeliverablePin({ lat: 23.1, lng: 113.3, precision: 'street', cityMatch: null }).ok, true);
});
it('refuses a district centroid', () => {
  const v = geocode.isDeliverablePin({ lat: 23.1, lng: 113.3, precision: 'coarse', level: '区县', cityMatch: true });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /precision_coarse/);
});
it('refuses a precise match in the WRONG city', () => {
  const v = geocode.isDeliverablePin({ lat: 30.2, lng: 120.1, precision: 'rooftop', cityMatch: false });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'city_mismatch');
});
it('refuses a precise match in the WRONG district of the RIGHT city', () => {
  // Same city, so cityMatch is true — this is exactly the failure MAX_DROP_KM
  // cannot catch, because a wrong district is a normal same-city distance.
  const v = geocode.isDeliverablePin({ lat: 23.1, lng: 113.3, precision: 'rooftop', cityMatch: true, districtMatch: false });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'district_mismatch');
});
it('an unknown district is undecidable, not a mismatch', () => {
  const v = geocode.isDeliverablePin({ lat: 23.1, lng: 113.3, precision: 'rooftop', cityMatch: true, districtMatch: null });
  assert.strictEqual(v.ok, true);
});
it('refuses nothing at all', () => {
  assert.strictEqual(geocode.isDeliverablePin(null).ok, false);
});

console.log('\ncityMatches — suffix-insensitive, undecidable when unknown');
it('广州 == 广州市', () => assert.strictEqual(geocode.cityMatches('广州', '广州市'), true));
it('广州市 != 佛山市', () => assert.strictEqual(geocode.cityMatches('广州市', '佛山市'), false));
it('unknown side is undecidable, not a mismatch', () => {
  assert.strictEqual(geocode.cityMatches('广州市', ''), null);
});

console.log('\ndistrictMatches — same idea one level down');
it('天河区 == 天河', () => assert.strictEqual(geocode.districtMatches('天河区', '天河'), true));
it('天河区 != 越秀区', () => assert.strictEqual(geocode.districtMatches('天河区', '越秀区'), false));
it('unknown side is undecidable, not a mismatch', () => {
  assert.strictEqual(geocode.districtMatches('天河区', ''), null);
});

// ── buildCreatePayload ────────────────────────────────────────────────────
// Guangzhou Tianhe-ish shop; distances below are real enough for the gate.
const SHOP = { shopId: 'S1', cityId: 20, name: '测试门店', lat: 23.13, lng: 113.33 };
const ORDER = (addr) => ({
  order_no: 'TC000166', recipient_name: '张三', recipient_phone: '13000000868',
  address_json: JSON.stringify(addr), delivery_slot_label: '',
});
const stubGeo = (result) => ({
  configured: () => true,
  geocodeAddress: async () => result,
  isDeliverablePin: geocode.isDeliverablePin,
});
const noPoi = { geocode: async () => null };

(async () => {
  console.log('\nbuildCreatePayload — where the pin comes from');

  await itAsync('uses the customer pin from the order snapshot, no geocoding', async () => {
    let called = false;
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号', detail: '3层302室',
              lat: 23.12, lng: 113.32, geo_source: 'customer_pin', geo_precision: 'rooftop' }),
      SHOP, noPoi,
      { geocode: { configured: () => true, geocodeAddress: async () => { called = true; return null; }, isDeliverablePin: geocode.isDeliverablePin } });
    assert.strictEqual(called, false, 'must not geocode when a pin is present');
    assert.strictEqual(p.recipientLat, 23120000);
    assert.strictEqual(p.recipientLng, 113320000);
    assert.strictEqual(p._geo.source, 'customer_pin');
    assert.strictEqual(p.recipientAddress, '珠江西路15号 3层302室');
  });

  await itAsync('accepts a rooftop geocode when there is no pin', async () => {
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号' }),
      SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.12, lng: 113.32, precision: 'rooftop', provider: 'amap', cityMatch: true }) });
    assert.strictEqual(p._geo.source, 'geocode:amap');
    assert.strictEqual(p._geo.precision, 'rooftop');
  });

  await itAsync('REFUSES a district-centroid geocode instead of sending a rider', async () => {
    await assert.rejects(
      buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '白云区', address: '品秀星越花园' }),
        SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.4, lng: 113.2, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) }),
      /geocode failed/);
  });

  await itAsync('REFUSES a weak pin that lands outside same-city range', async () => {
    await assert.rejects(
      buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园' }),
        SHOP, noPoi,
        // ~60km south of the shop, matched only to a road → weak + far.
        { geocode: stubGeo({ lat: 22.6, lng: 113.5, precision: 'street', provider: 'amap', cityMatch: true }) }),
      /drop-off is .*km from/);
  });

  await itAsync('allows a far delivery when the pin is precise, but warns', async () => {
    // 30km: past MAX_DROP_KM (25) but inside the absolute ceiling (50).
    const warns = [];
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园1栋',
              lat: 22.86, lng: 113.33, geo_source: 'customer_pin' }),
      SHOP, noPoi, { geocode: stubGeo(null), onWarn: m => warns.push(m) });
    assert.ok(p.recipientLat, 'payload still built');
    assert.ok(warns.some(w => /sending anyway/.test(w)), 'operator is told');
  });

  await itAsync('translates an English address before it reaches the waybill', async () => {
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '15 Zhujiang West Road', detail: 'Room 302' }),
      SHOP, noPoi,
      {
        geocode: stubGeo({ lat: 23.12, lng: 113.32, precision: 'rooftop', provider: 'amap', cityMatch: true }),
        translateCn: async () => ({ province: '广东省', city: '广州市', district: '天河区', street: '珠江西路15号302室' }),
      });
    assert.strictEqual(p.recipientAddress, '珠江西路15号302室');
    assert.strictEqual(p._geo.translated, true);
  });

  await itAsync('keeps the original text when translation is unavailable', async () => {
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '15 Zhujiang West Road' }),
      SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.12, lng: 113.32, precision: 'rooftop', provider: 'amap', cityMatch: true }),
        translateCn: async () => null });
    assert.strictEqual(p.recipientAddress, '15 Zhujiang West Road');
  });

  await itAsync('does not fall back to Qingyun POI search on English text', async () => {
    let poiCalled = false;
    await assert.rejects(
      buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '15 Zhujiang West Road' }),
        SHOP, { geocode: async () => { poiCalled = true; return { lng: 113320000, lat: 23120000 }; } },
        { geocode: stubGeo(null) }),
      /geocode failed/);
    assert.strictEqual(poiCalled, false, 'POI search is weak on English — must not be tried');
  });

  await itAsync('still refuses an order with no address at all', async () => {
    await assert.rejects(
      buildCreatePayload(ORDER({}), SHOP, noPoi, { geocode: stubGeo(null) }),
      /missing recipient/);
  });

  await itAsync('refuses a region-only address (no street) rather than pinning the city', async () => {
    // '广州市' alone can only ever geocode to the city centre — the exact answer
    // that used to reach a rider as a real address.
    await assert.rejects(
      buildCreatePayload(ORDER({ province: '广东省', city: '广州市' }), SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.13, lng: 113.26, precision: 'coarse', level: '市', provider: 'amap', cityMatch: true }) }),
      /geocode failed/);
  });

  await extraSuites();
  await roundThreeSuites();
  await roundFourSuites();
  await coarseNearSuite();

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

// ─────────────────────────────────────────────────────────────────────────
// Regression suites added after the verification survey. Each block names the
// failure it locks down; every one of these was a real defect on this branch.
// ─────────────────────────────────────────────────────────────────────────
async function extraSuites() {
  const addressPin = require('../lib/address-pin');
  const addressCn  = require('../lib/address-cn');
  const qingyunQueue = require('../lib/qingyun-queue');
  const { execFileSync } = require('child_process');
  const path = require('path');

  // ── F5 · a blank city must not be compared against a returned city ──────
  console.log('\nregionMatches — compare like with like (F5)');
  it('blank city + 广东省 accepts a 广州 match', () => {
    // The bug: expected fell back to the PROVINCE and was compared against the
    // returned CITY, so '广东省' vs '广州' looked like a wrong-city hit and a
    // perfectly good Guangzhou address was refused.
    assert.notStrictEqual(
      geocode.regionMatches({ province: '广东省' }, { province: '广东省', city: '广州市' }),
      false);
  });
  it('blank city still catches a genuinely wrong province', () => {
    assert.strictEqual(
      geocode.regionMatches({ province: '广东省' }, { province: '浙江省', city: '杭州市' }), false);
  });
  it('city present is still compared city-to-city', () => {
    assert.strictEqual(geocode.regionMatches({ city: '广州市' }, { city: '佛山市' }), false);
    assert.strictEqual(geocode.regionMatches({ city: '广州市' }, { city: '广州' }), true);
  });
  it('municipality with an empty returned city stays undecidable', () => {
    assert.strictEqual(geocode.regionMatches({ city: '北京市' }, { city: '', province: '北京市' }), null);
  });
  it('no region asked for at all is undecidable', () => {
    assert.strictEqual(geocode.regionMatches({}, { city: '广州市' }), null);
  });

  // ── F6 · only strip a real building token ───────────────────────────────
  console.log('\njoinStreetDetail — building tokens only (F6)');
  it('中山一路1号 + 1号楼2单元 keeps the building number', () => {
    // '1号' is a STREET number, not a building. Stripping it turned building 1
    // into a bare '楼2单元' and deleted the building off the waybill.
    assert.strictEqual(
      joinStreetDetail('中山一路1号', '1号楼2单元'), '中山一路1号 1号楼2单元');
  });
  it('翠湖花园1栋 + 1栋1单元101室 still de-duplicates', () => {
    assert.strictEqual(
      joinStreetDetail('翠湖花园1栋', '1栋1单元101室'), '翠湖花园1栋 1单元101室');
  });
  it('a 号楼 building written in both is de-duplicated', () => {
    assert.strictEqual(
      joinStreetDetail('翠湖花园1号楼', '1号楼2单元'), '翠湖花园1号楼 2单元');
  });
  it('a 座 building is de-duplicated', () => {
    assert.strictEqual(joinStreetDetail('保利中心3座', '3座2801室'), '保利中心3座 2801室');
  });
  it('never strips down to an orphaned unit word', () => {
    // Even if the head looked like a token, a remainder starting with 楼/单元/室
    // means we cut something load-bearing.
    assert.strictEqual(joinStreetDetail('某某苑2栋', '2栋楼下'), '某某苑2栋 2栋楼下');
  });

  // ── F4 · an unknown-provenance pin is not a trusted pin ─────────────────
  console.log('\nbuildCreatePayload — legacy pins must earn trust (F4)');
  const LEGACY = { province: '广东省', city: '广州市', district: '白云区', address: '品秀星越花园A栋' };

  await itAsync('a pin with no provenance is corroborated against the text', async () => {
    const p = await buildCreatePayload(
      ORDER({ ...LEGACY, lat: 23.135, lng: 113.335 }),          // ~0.2km from the resolve
      SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.1365, lng: 113.3365, precision: 'rooftop', provider: 'amap', cityMatch: true }) });
    assert.match(p._geo.source, /\+verified$/);
    assert.strictEqual(p.recipientLat, 23135000, 'ships the STORED pin, not the resolve');
  });

  await itAsync('a no-provenance pin that DISAGREES with the address is not shipped', async () => {
    // The pre-branch regression: a district centroid sitting in an old row was
    // shipped as if the customer had tapped it.
    const p = await buildCreatePayload(
      ORDER({ ...LEGACY, lat: 23.40, lng: 113.20 }),            // ~20km from the resolve
      SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.1365, lng: 113.3365, precision: 'rooftop', provider: 'amap', cityMatch: true }) });
    assert.strictEqual(p._geo.source, 'geocode:amap');
    assert.strictEqual(p.recipientLat, 23136500, 'uses the resolved address instead');
  });

  await itAsync('a no-provenance pin the address cannot place ASKS FOR A POINT', async () => {
    // Was a flat refusal, which is what this test locked down: five identical
    // retries, a page, and a row nobody could revive. The pin is still not
    // trusted and still never sent — that part is unchanged and is what this
    // suite exists to protect — but the outcome is now a parked row carrying
    // the point it would have sent, for a person to confirm. The state model
    // lives in scripts/test_needs_point.js.
    await assert.rejects(
      buildCreatePayload(
        ORDER({ ...LEGACY, lat: 23.40, lng: 113.20 }),
        SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.39, lng: 113.21, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) }),
      (e) => {
        assert.strictEqual(e.needsPoint, true, 'parked, not refused');
        assert.deepStrictEqual(e.point, { lat: 23.40, lng: 113.20, precision: null });
        return true;
      });
  });

  await itAsync('a geocoded pin already graded rooftop is trusted without re-resolving', async () => {
    let called = false;
    const p = await buildCreatePayload(
      ORDER({ ...LEGACY, lat: 23.135, lng: 113.335, geo_source: 'geocode:amap', geo_precision: 'rooftop' }),
      SHOP, noPoi,
      { geocode: { configured: () => true, isDeliverablePin: geocode.isDeliverablePin,
                   geocodeAddress: async () => { called = true; return null; } } });
    assert.strictEqual(called, false);
    assert.strictEqual(p._geo.source, 'geocode:amap');
  });

  await itAsync('with no geocoder at all an unverified pin ships, loudly', async () => {
    const warns = [];
    const p = await buildCreatePayload(
      ORDER({ ...LEGACY, lat: 23.135, lng: 113.335 }), SHOP, noPoi,
      { geocode: { configured: () => false, isDeliverablePin: geocode.isDeliverablePin,
                   geocodeAddress: async () => null }, onWarn: m => warns.push(m) });
    assert.match(p._geo.source, /\+unverifiable$/);
    assert.ok(warns.some(w => /UNVERIFIED/.test(w)));
  });

  await itAsync('a refusal still carries the pin provenance for the log', async () => {
    // F9a — the push log prints [pin …] on refusals, from this.
    let err = null;
    try {
      await buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园' }),
        SHOP, noPoi,
        { geocode: stubGeo({ lat: 22.6, lng: 113.5, precision: 'street', provider: 'amap', cityMatch: true }) });
    } catch (e) { err = e; }
    assert.ok(err, 'it refused');
    assert.ok(err._geo, 'the refusal carries _geo');
    assert.strictEqual(err._geo.refused, true);
    assert.strictEqual(err._geo.source, 'geocode:amap');
    assert.ok(err._geo.dropKm > 25);
  });

  // ── F3a · provenance laundering ─────────────────────────────────────────
  console.log('\ndecidePinAction — only a tap mints a customer pin (F3a)');
  const STORED = { province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号', detail: '302室',
                   lat: 23.12, lng: 113.32, geo_source: 'geocode:amap', geo_precision: 'coarse' };

  it('a fresh map pick becomes customer_pin/rooftop', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.5, lng: 113.5, fresh: true }, existing: STORED, incoming: {} });
    assert.deepStrictEqual([d.action, d.source, d.precision], ['set', 'customer_pin', 'rooftop']);
  });
  it('round-tripped coordinates CANNOT mint a customer pin', () => {
    // The laundering bug: editing a phone number re-sent the saved coordinates,
    // and the server relabelled a coarse geocode as a customer tap.
    const d = addressPin.decidePinAction({
      pin: { lat: 23.12, lng: 113.32, fresh: false }, existing: STORED, incoming: { phone: '13000000000' } });
    assert.strictEqual(d.action, 'keep');
    assert.notStrictEqual(d.source, 'customer_pin');
  });
  it('a name-only edit keeps the pin instead of dropping it', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.12, lng: 113.32, fresh: false }, existing: STORED,
      incoming: { province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号', detail: '302室' } });
    assert.strictEqual(d.action, 'keep');
  });
  it('unflagged coordinates we have never seen are client_unverified, not a pin', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.9, lng: 113.9, fresh: false }, existing: STORED, incoming: {} });
    assert.deepStrictEqual([d.action, d.source, d.precision], ['set', 'client_unverified', null]);
  });
  it('a street edit clears the pin and its provenance', () => {
    const d = addressPin.decidePinAction({ pin: null, existing: STORED, incoming: { address: '中山一路9号' } });
    assert.strictEqual(d.action, 'clear');
    assert.strictEqual(d.regeocode, true);
  });
  it('same coords + changed street is stale, so it clears', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.12, lng: 113.32, fresh: false }, existing: STORED, incoming: { address: '中山一路9号' } });
    assert.strictEqual(d.action, 'clear');
  });
  it('a kept customer pin is never re-geocoded behind the customer’s back', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.12, lng: 113.32, fresh: false },
      existing: { ...STORED, geo_source: 'customer_pin', geo_precision: 'rooftop' }, incoming: {} });
    assert.strictEqual(d.action, 'keep');
    assert.strictEqual(d.regeocode, false);
  });
  it('a pin outside mainland China is rejected outright', () => {
    assert.strictEqual(addressPin.readClientPin({ lat: 51.5, lng: -0.12, pin_source: 'map' }), null);
  });

  // ── F3b · a tapped pin survives a text-only rewrite ─────────────────────
  console.log('\nkeepsPinThroughTextEdit — translation rewrites words, not places (F3b)');
  it('customer_pin survives "Make address Chinese"', () => {
    assert.strictEqual(
      addressPin.keepsPinThroughTextEdit({ geo_source: 'customer_pin', lat: 23.1, lng: 113.3 }), true);
  });
  it('a geocoded pin does not survive it', () => {
    assert.strictEqual(
      addressPin.keepsPinThroughTextEdit({ geo_source: 'geocode:amap', lat: 23.1, lng: 113.3 }), false);
  });
  it('a phantom customer_pin with no coordinates does not count', () => {
    assert.strictEqual(
      addressPin.keepsPinThroughTextEdit({ geo_source: 'customer_pin', lat: null, lng: null }), false);
  });

  // ── F7 · translation adoption ───────────────────────────────────────────
  console.log('\nshouldAdoptTranslation — strictly better, or not at all (F7)');
  const street = (p, extra) => ({ lat: 23.1, lng: 113.3, precision: p, cityMatch: true, ...extra });
  it('a tie does NOT adopt the rewrite', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: street('street'), retry: street('street'), mergedAddress: '珠江东路15号' }), false);
  });
  it('strictly better precision does adopt', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: street('street'), retry: street('rooftop'), mergedAddress: '珠江西路15号' }), true);
  });
  it('a wrong-city translation is never adopted', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: street('coarse'), retry: street('rooftop', { cityMatch: false }), mergedAddress: '珠江西路15号' }), false);
  });
  it('a half-translated street is never adopted', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: street('coarse'), retry: street('rooftop'), mergedAddress: '珠江West路15号' }), false);
  });
  it('nothing resolved originally → anything that resolves is an improvement', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: null, retry: street('coarse'), mergedAddress: '广州市白云区' }), true);
  });
  it('a retry that resolved nothing is never adopted', () => {
    assert.strictEqual(addressCn.shouldAdoptTranslation({
      first: street('street'), retry: null, mergedAddress: '珠江西路15号' }), false);
  });

  // ── F2b · a refused push must become retryable ──────────────────────────
  console.log('\nrequeueEligible — a refused order is not a dead order (F2b)');
  it('an errored row with no courier copy is requeued', () => {
    assert.strictEqual(qingyunQueue.requeueEligible({ status: 'error', qingyun_order_id: null }), true);
  });
  it('a row that already created a copy is NEVER re-pushed', () => {
    // Re-pushing would make a second 待配送 order and a second rider to pay for.
    assert.strictEqual(qingyunQueue.requeueEligible({ status: 'error', qingyun_order_id: '9001' }), false);
  });
  it('a pending row is left to the daemon', () => {
    assert.strictEqual(qingyunQueue.requeueEligible({ status: 'pending', qingyun_order_id: null }), false);
  });
  it('a deliberately skipped row is not auto-requeued', () => {
    assert.strictEqual(qingyunQueue.requeueEligible({ status: 'skipped', qingyun_order_id: null }), false);
  });
  it('but an operator MAY retry a skipped row by hand', () => {
    assert.strictEqual(qingyunQueue.manualRetryEligible({ status: 'skipped', qingyun_order_id: null }), true);
    assert.strictEqual(qingyunQueue.manualRetryEligible({ status: 'error', qingyun_order_id: '9001' }), false);
  });
  it('the requeue SQL only ever touches a copy-less row an edit could fix', () => {
    assert.match(qingyunQueue.REQUEUE_SQL, /qingyun_order_id IS NULL/);
    // 'needs_point' joined 'error' here, and 'awaiting_choice' joined both: a
    // corrected address is precisely what might place an order we could not
    // place, and it is equally what changes the text the name search runs on —
    // a candidate list built from an address that no longer exists is worse
    // than none, because it still looks answerable.
    //
    // 'skipped' deliberately did NOT join them — it means cancelled / refunded
    // / delivered or not-same-city, and an edit is no evidence about either.
    // That exclusion is the invariant this test exists for; the membership list
    // grows as parked states are added.
    assert.match(qingyunQueue.REQUEUE_SQL, /status IN \('error', 'needs_point', 'awaiting_choice'\)/);
    assert.doesNotMatch(qingyunQueue.REQUEUE_SQL, /'skipped'/);
    assert.match(qingyunQueue.REQUEUE_SQL, /attempts = 0/);
  });

  // ── Every geocoded pin is stored WITH its provenance ────────────────────
  console.log('\ngeocodedPinFields / GEOCODED_PIN_SQL — no pin is stored anonymously');
  it('a provider result maps to a source and a grade', () => {
    assert.deepStrictEqual(
      addressPin.geocodedPinFields({ provider: 'amap', precision: 'rooftop' }),
      { source: 'geocode:amap', precision: 'rooftop' });
  });
  it('an unnamed provider still records that it was a geocode, not a tap', () => {
    // The admin geocode-backfill used to store lat/lng with NO source, minting
    // the unattributed rows the courier push then has to corroborate.
    const f = addressPin.geocodedPinFields({ precision: 'street' });
    assert.match(f.source, /^geocode:/);
    assert.notStrictEqual(f.source, 'customer_pin');
  });
  it('the shared write statement records provenance and guards a tapped pin', () => {
    assert.match(addressPin.GEOCODED_PIN_SQL, /geo_source = \?/);
    assert.match(addressPin.GEOCODED_PIN_SQL, /geo_precision = \?/);
    assert.match(addressPin.GEOCODED_PIN_SQL, /geo_source <> 'customer_pin'/);
  });

  // ── F8 · a bad env value must not silently change the rule ──────────────
  console.log('\nQINGYUN_MAX_DROP_KM — bad values fall back, they do not disable (F8)');
  const readMaxDropKm = (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.QINGYUN_MAX_DROP_KM; else env.QINGYUN_MAX_DROP_KM = value;
    const out = execFileSync(process.execPath, ['-e',
      "process.stdout.write(String(require(process.argv[1]).MAX_DROP_KM))",
      path.join(__dirname, '..', 'lib', 'qingyun-payload.js')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out);
  };
  it('unset → 25', () => assert.strictEqual(readMaxDropKm(undefined), 25));
  it('"0" → 25, not "refuse everything"', () => assert.strictEqual(readMaxDropKm('0'), 25));
  it('"abc" → 25, not "check disabled"', () => assert.strictEqual(readMaxDropKm('abc'), 25));
  it('"" → 25', () => assert.strictEqual(readMaxDropKm(''), 25));
  it('"-5" → 25', () => assert.strictEqual(readMaxDropKm('-5'), 25));
  it('a real value is honoured', () => assert.strictEqual(readMaxDropKm('12'), 12));
}

// ─────────────────────────────────────────────────────────────────────────
// Round-3 suites. Where a rule lives in a library but is USED by a route, the
// library test is not enough — round 2 found four defects that library-only
// tests would have missed entirely. Each block below therefore pairs the logic
// test with a call-site guard, and the guards say in their name when they are
// source checks rather than behaviour.
// ─────────────────────────────────────────────────────────────────────────
async function roundThreeSuites() {
  const fs = require('fs');
  const path = require('path');
  const qingyunQueue = require('../lib/qingyun-queue');
  const addressPin = require('../lib/address-pin');
  const payload = require('../lib/qingyun-payload');

  const ROOT = path.join(__dirname, '..');
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // ── G1 · the retry race, against a real database ────────────────────────
  // Not a mock: an in-memory SQLite carrying the REAL table definition, lifted
  // out of database.js so the two cannot drift, running the REAL statement the
  // endpoint runs.
  console.log('\nG1 · retry-push cannot resurrect a completed row (real sqlite)');
  // Real DDL + every addColumn() bolted onto it since. This used to hardcode a
  // single bolt-on (geo_held_at), which went stale the moment the
  // delivery-point build added needs_point_at / guessed_*.
  const makeQueueDb = () => openQueueTableDb(src('database.js'));

  it('resets an errored, copy-less row', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, last_error) VALUES (7,'tianhe','error',5,'refused')").run();
    const r = db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(7);
    assert.strictEqual(r.changes, 1);
    const row = db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 7').get();
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 0);
  });

  it('THE RACE: the daemon completes between the read and the write → 0 rows', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts) VALUES (7,'tianhe','error',5)").run();
    // …the endpoint reads the row here and sees no qingyun_order_id…
    const seen = db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 7').get();
    assert.strictEqual(seen.qingyun_order_id, null);
    assert.strictEqual(qingyunQueue.manualRetryEligible(seen), true, 'JS check would have said yes');
    // …the daemon finishes the push and stamps the copy…
    db.prepare("UPDATE qingyun_push_queue SET status='done', qingyun_order_id='QY9001' WHERE retail_order_id = 7").run();
    // …and only then does the endpoint's UPDATE land.
    const r = db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(7);
    assert.strictEqual(r.changes, 0, 'the statement must refuse — otherwise a SECOND rider is dispatched');
    const row = db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 7').get();
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.qingyun_order_id, 'QY9001');
  });

  it('a skipped row may be retried by hand; a pending one is left alone', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status) VALUES (1,'tianhe','skipped'),(2,'tianhe','pending')").run();
    assert.strictEqual(db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(1).changes, 1);
    assert.strictEqual(db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(2).changes, 0);
  });

  it('call site (source check): the endpoint runs MANUAL_RETRY_SQL, not its own UPDATE', () => {
    const retail = src('routes/retail.js');
    const at = retail.indexOf("qingyun/retry-push");
    assert.ok(at > -1, 'retry-push route not found');
    const body = retail.slice(at, at + 1800);
    assert.ok(/qingyunQueue\.MANUAL_RETRY_SQL/.test(body),
      'the retry endpoint must use the guarded shared statement');
    assert.ok(!/UPDATE qingyun_push_queue\s+SET status = 'pending'/.test(body),
      'no hand-rolled unguarded reset in the endpoint');
    assert.ok(/already_created/.test(body), 'a 0-row result must tell the operator the push already succeeded');
  });

  // ── G2 · a provider outage holds, it does not refuse ─────────────────────
  console.log('\nG2 · geocoder failure holds the order; a coarse ANSWER still refuses');
  const failGeo = (failure) => ({
    configured: () => true,
    isDeliverablePin: geocode.isDeliverablePin,
    geocodeAddress: async () => null,
    geocodeAddressResult: async () => ({ result: null, failure }),
  });
  const LEGACY_PIN = { province: '广东省', city: '广州市', district: '白云区', address: '品秀星越花园A栋',
                       lat: 23.135, lng: 113.335 };

  await itAsync('quota exhaustion HOLDS an unattributed-pin order', async () => {
    let err = null;
    try {
      await buildCreatePayload(ORDER(LEGACY_PIN), SHOP, noPoi,
        { geocode: failGeo({ code: '121', message: 'daily limit', quota: true }) });
    } catch (e) { err = e; }
    assert.ok(err, 'it did not ship');
    assert.strictEqual(err.geoHold, true, 'and it is a HOLD, not a refusal');
    assert.strictEqual(err._geo.held, true);
  });

  await itAsync('a timeout HOLDS an order with no pin at all', async () => {
    let err = null;
    try {
      await buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号' }),
        SHOP, noPoi, { geocode: failGeo({ code: 'network', message: 'timeout' }) });
    } catch (e) { err = e; }
    assert.strictEqual(err && err.geoHold, true);
  });

  // ~17km east of SHOP: past COARSE_OK_KM (12.5) so the coarse-near rule
  // cannot vouch for it, but inside MAX_DROP_KM (25) so it is THIS gate
  // refusing and not the distance ceiling.
  const LEGACY_PIN_FAR = { ...LEGACY_PIN, lat: 23.13, lng: 113.50 };

  await itAsync('a COARSE ANSWER still refuses — an outage and a bad address differ', async () => {
    let err = null;
    try {
      await buildCreatePayload(ORDER(LEGACY_PIN_FAR), SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.39, lng: 113.21, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) });
    } catch (e) { err = e; }
    assert.ok(err, 'a pin too far from the store to vouch for still parks');
    assert.notStrictEqual(err.geoHold, true, 'a provider that answered is evidence — refuse, do not hold');
    assert.strictEqual(err._geo.refused, true);
  });

  await itAsync('recovery: the same order ships once the provider answers again', async () => {
    const p = await buildCreatePayload(ORDER(LEGACY_PIN), SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.1365, lng: 113.3365, precision: 'rooftop', provider: 'amap', cityMatch: true }) });
    assert.match(p._geo.source, /\+verified$/);
  });

  it('shouldHoldForGeocoder only fires on the hold marker', () => {
    assert.strictEqual(qingyunQueue.shouldHoldForGeocoder({ geoHold: true }), true);
    assert.strictEqual(qingyunQueue.shouldHoldForGeocoder(new Error('bad address')), false);
    assert.strictEqual(qingyunQueue.shouldHoldForGeocoder(null), false);
  });

  it('HOLD_SQL writes attempts back — a held push must not spend one', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts) VALUES (7,'tianhe','processing',3)").run();
    db.prepare(qingyunQueue.HOLD_SQL).run(2, 'held', 1);       // 2 = the value before the drain incremented it
    const row = db.prepare('SELECT * FROM qingyun_push_queue WHERE id = 1').get();
    assert.strictEqual(row.attempts, 2, 'the attempt is given back');
    assert.strictEqual(row.status, 'pending');
    assert.ok(row.geo_held_at, 'and the hold is stamped');
  });

  it('HOLD_SQL keeps the FIRST hold time, so the alert measures the outage', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, geo_held_at) VALUES (7,'tianhe','pending',0,'2026-08-06 09:00:00')").run();
    db.prepare(qingyunQueue.HOLD_SQL).run(0, 'held again', 1);
    assert.strictEqual(
      db.prepare('SELECT geo_held_at FROM qingyun_push_queue WHERE id = 1').get().geo_held_at,
      '2026-08-06 09:00:00');
  });

  console.log('\nG2 · the outage alert pages once, then clears');
  const MIN = 60_000;
  it('says nothing while the hold is young', () => {
    assert.strictEqual(qingyunQueue.geoHoldAlertDecision({
      heldCount: 3, oldestHeldMs: 0, now: 5 * MIN, thresholdMin: 10 }).alert, null);
  });
  it('pages once the outage outlasts the threshold', () => {
    const d = qingyunQueue.geoHoldAlertDecision({ heldCount: 3, oldestHeldMs: 0, now: 12 * MIN, thresholdMin: 10 });
    assert.strictEqual(d.alert, 'page');
    assert.strictEqual(d.heldCount, 3);
  });
  it('does NOT page again inside the throttle window', () => {
    assert.strictEqual(qingyunQueue.geoHoldAlertDecision({
      heldCount: 3, oldestHeldMs: 0, now: 20 * MIN, thresholdMin: 10, everyMin: 15,
      alerted: true, lastAlertMs: 12 * MIN }).alert, null);
  });
  it('pages again once the throttle window has passed', () => {
    assert.strictEqual(qingyunQueue.geoHoldAlertDecision({
      heldCount: 3, oldestHeldMs: 0, now: 30 * MIN, thresholdMin: 10, everyMin: 15,
      alerted: true, lastAlertMs: 12 * MIN }).alert, 'page');
  });
  it('sends one all-clear when the held queue drains', () => {
    assert.strictEqual(qingyunQueue.geoHoldAlertDecision({ heldCount: 0, alerted: true }).alert, 'clear');
    assert.strictEqual(qingyunQueue.geoHoldAlertDecision({ heldCount: 0, alerted: false }).alert, null);
  });
  it('call site (source check): the daemon holds instead of counting an attempt', () => {
    const daemon = src('scripts/qingyun-daemon.js');
    assert.ok(/qingyunQueue\.shouldHoldForGeocoder\(e\)/.test(daemon), 'the catch must test for a hold');
    assert.ok(/qingyunQueue\.HOLD_SQL/.test(daemon), 'and use the shared hold statement');
    assert.ok(/checkGeoHoldAlert\(storeCode\)/.test(daemon), 'and run the outage check each drain');
  });

  // ── G3 · the absolute ceiling ────────────────────────────────────────────
  console.log('\nG3 · nothing ships beyond the same-city ceiling');
  assert.strictEqual(payload.ABS_MAX_KM, 50, 'default is 2 × MAX_DROP_KM');

  await itAsync('a customer pin 30km out still ships (inside the ceiling)', async () => {
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园1栋',
              lat: 22.86, lng: 113.33, geo_source: 'customer_pin', geo_precision: 'rooftop' }),
      SHOP, noPoi, { geocode: stubGeo(null) });
    assert.ok(p.recipientLat);
  });

  await itAsync('a customer pin 66km out is REFUSED despite being "tapped"', async () => {
    // The mitigation for a client-asserted customer_pin: past the ceiling the
    // claim buys nothing, because the server cannot verify a tap.
    await assert.rejects(
      buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园1栋',
                lat: 22.53, lng: 113.33, geo_source: 'customer_pin', geo_precision: 'rooftop' }),
        SHOP, noPoi, { geocode: stubGeo(null) }),
      /beyond the 50km same-city ceiling/);
  });

  it('the ceiling validates its env like MAX_DROP_KM does', () => {
    const { execFileSync } = require('child_process');
    const read = (value) => {
      const env = { ...process.env, QINGYUN_ABS_MAX_KM: value };
      return Number(execFileSync(process.execPath, ['-e',
        "process.stdout.write(String(require(process.argv[1]).ABS_MAX_KM))",
        path.join(ROOT, 'lib', 'qingyun-payload.js')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    };
    assert.strictEqual(read('0'), 50);
    assert.strictEqual(read('abc'), 50);
    assert.strictEqual(read('80'), 80);
  });

  // ── G6 · row 4 of the decidePinAction enumeration ────────────────────────
  console.log('\nG6 · unflagged coordinates never displace a tapped pin');
  const TAPPED = { province: '广东省', city: '广州市', district: '天河区', address: '珠江西路15号', detail: '302室',
                   lat: 23.12, lng: 113.32, geo_source: 'customer_pin', geo_precision: 'rooftop' };
  it('different coords with no pin_source are IGNORED on a customer_pin row', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.9, lng: 113.9, fresh: false }, existing: TAPPED, incoming: {} });
    assert.strictEqual(d.action, 'keep', 'the tapped pin stands');
    assert.strictEqual(d.regeocode, false, 'and is not re-derived behind the customer’s back');
    assert.strictEqual(d.ignoredUnflaggedPin, true);
  });
  it('…but a FRESH pick does replace it', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.9, lng: 113.9, fresh: true }, existing: TAPPED, incoming: {} });
    assert.deepStrictEqual([d.action, d.source], ['set', 'customer_pin']);
  });
  it('…and a street edit still clears it', () => {
    const d = addressPin.decidePinAction({ pin: null, existing: TAPPED, incoming: { address: '别的路9号' } });
    assert.strictEqual(d.action, 'clear');
  });
  it('a NON-tapped row still records unflagged coords as client_unverified', () => {
    const d = addressPin.decidePinAction({
      pin: { lat: 23.9, lng: 113.9, fresh: false },
      existing: { ...TAPPED, geo_source: 'geocode:amap', geo_precision: 'coarse' }, incoming: {} });
    assert.deepStrictEqual([d.action, d.source], ['set', 'client_unverified']);
  });

  // ── G5 · call-site guards for the round-2 finding ────────────────────────
  console.log('\nG5 · the routes still go through the shared decisions (source checks)');
  it('call site (source check): translation adoption goes through shouldAdoptTranslation', () => {
    const retail = src('routes/retail.js');
    assert.ok(/addressCn\.shouldAdoptTranslation\(\{\s*first,\s*retry,\s*mergedAddress/.test(retail),
      'geocodeAddressAsync must call the shared adoption rule');
    assert.ok(!/GEO_RANK\[retry\.precision\]/.test(retail),
      'no inline rank comparison for the retry — that was the >= bug');
  });
  it('call site (source check): the address PUT goes through decidePinAction', () => {
    const retail = src('routes/retail.js');
    assert.ok(/addressPin\.decidePinAction\(\{ pin, existing, incoming: a \}\)/.test(retail));
    assert.ok(!/pinSource = pin\.fresh \? 'customer_pin'/.test(retail),
      'the PUT must not hand-roll provenance');
  });
  it('call site (source check): the backfill uses the shared pin-write statement', () => {
    const inv = src('routes/retail-inventory.js');
    assert.ok(/addressPin\.GEOCODED_PIN_SQL/.test(inv));
    assert.ok(/addressPin\.geocodedPinFields\(c\)/.test(inv));
    assert.ok(!/UPDATE retail_customer_addresses SET lat = \?, lng = \?, geocoded_at/.test(inv),
      'no provenance-less UPDATE left behind');
  });
  it('call site (source check): the admin address PUT uses the shared text-changed rule', () => {
    const retail = src('routes/retail.js');
    assert.ok(/addressPin\.addressTextChanged\(a, existing\)/.test(retail));
    assert.ok(!/const adminTextChanged = \['province'/.test(retail), 'the inline copy is gone');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Round-4 suites: no push for an order that is over, the all-clear latch, and
// the classification the whole hold mechanism rests on.
// ─────────────────────────────────────────────────────────────────────────
async function roundFourSuites() {
  const fs = require('fs');
  const path = require('path');
  const qingyunQueue = require('../lib/qingyun-queue');
  const ROOT = path.join(__dirname, '..');
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // Same builder as G1 above — see the note there.
  const makeQueueDb = () => openQueueTableDb(src('database.js'));
  // The drain's decision, exactly as scripts/qingyun-daemon.js sequences it: the
  // closed-order gate first, then the same-city gate, then the push. Mirrors the
  // real order of operations so the assertions below are about the RULE, not
  // about this harness.
  const drainDecision = (order) => {
    if (qingyunQueue.isClosedOrderStatus(order.status)) return 'retire';
    if (!order.sameCityToday) return 'skip';
    return 'push';
  };

  console.log('\nH1 · an order that is over never gets a rider');
  it('the closed set is the schema’s terminal statuses', () => {
    for (const s of ['cancelled', 'refunded', 'delivered']) {
      assert.strictEqual(qingyunQueue.isClosedOrderStatus(s), true, s);
    }
    for (const s of ['paid', 'preparing', 'dispatched', 'pending_payment', '', null, undefined]) {
      assert.strictEqual(qingyunQueue.isClosedOrderStatus(s), false, String(s));
    }
  });

  it('HELD row + order cancelled → the recovery drain retires it, does NOT push', () => {
    const db = makeQueueDb();
    // A row held through a geocoder outage: pending, stamped, attempts unspent.
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, geo_held_at) VALUES (7,'tianhe','pending',0,'2026-08-06 09:00:00')").run();
    // The customer cancels while it is held. The geocoder then recovers, so the
    // address WOULD now resolve — the only thing standing between this order and
    // a dispatched rider is the closed-order gate.
    const decision = drainDecision({ status: 'cancelled', sameCityToday: true });
    assert.strictEqual(decision, 'retire', 'must not reach the push');
    db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('order cancelled', 7);
    const row = db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 7').get();
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.geo_held_at, null, 'and stops counting as held');
    assert.strictEqual(row.qingyun_order_id, null, 'no courier job was created');
  });

  it('manual retry on a skipped-because-cancelled row → the drain re-retires it', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, last_error) VALUES (7,'tianhe','skipped','order cancelled')").run();
    // The endpoint lets a 'skipped' row be retried — that is deliberate, because
    // most skip reasons are fixable. The safety net is the drain, not the button.
    assert.strictEqual(db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(7).changes, 1);
    assert.strictEqual(db.prepare('SELECT status FROM qingyun_push_queue WHERE retail_order_id = 7').get().status, 'pending');
    assert.strictEqual(drainDecision({ status: 'cancelled', sameCityToday: true }), 'retire',
      'the drain must send it straight back to skipped — no Qingyun create');
  });

  it('a live order still pushes — the gate is not a blanket stop', () => {
    assert.strictEqual(drainDecision({ status: 'paid', sameCityToday: true }), 'push');
    assert.strictEqual(drainDecision({ status: 'preparing', sameCityToday: true }), 'push');
    assert.strictEqual(drainDecision({ status: 'paid', sameCityToday: false }), 'skip');
  });

  it('cancel-side: a PENDING row is retired at once, not at next drain', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, geo_held_at) VALUES (7,'tianhe','pending','2026-08-06 09:00:00')").run();
    db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('order refunded', 7);
    const held = db.prepare(
      `SELECT COUNT(*) AS n FROM qingyun_push_queue
        WHERE geo_held_at IS NOT NULL AND status = 'pending' AND qingyun_order_id IS NULL`).get();
    assert.strictEqual(held.n, 0, 'excluded from the hold-alert count immediately');
  });

  it('cancel-side: a row that DID create a copy is left for the delete path', () => {
    const db = makeQueueDb();
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, qingyun_order_id) VALUES (7,'tianhe','done','QY9001')").run();
    assert.strictEqual(db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('order cancelled', 7).changes, 0,
      'retiring it here would orphan a live 待配送 order nobody deletes');
  });

  it('call site (source check): the drain checks order status before building a payload', () => {
    const daemon = src('scripts/qingyun-daemon.js');
    assert.ok(/SELECT id, order_no, status, channel/.test(daemon), 'status must be fetched');
    const gateAt  = daemon.indexOf('qingyunQueue.isClosedOrderStatus(order.status)');
    const buildAt = daemon.indexOf('await pushPayload(order, shop, br, storeCode)');
    assert.ok(gateAt > -1 && buildAt > -1, 'both the gate and the build must exist');
    assert.ok(gateAt < buildAt, 'the gate must come BEFORE the payload is built');
    assert.ok(/qingyunQueue\.RETIRE_CLOSED_SQL/.test(daemon));
  });

  it('call site (source check): cancel retires a copy-less row instead of returning', () => {
    const retail = src('routes/retail.js');
    const at = retail.indexOf('function qingyunDropCopyForClosedOrder');
    const body = retail.slice(at, at + 1400);
    assert.ok(!/if \(!q \|\| !q\.qingyun_order_id\) return;/.test(body),
      'the old early-return dropped pending and held rows on the floor');
    assert.ok(/qingyunQueue\.RETIRE_CLOSED_SQL/.test(body));
  });

  // ── H2 · the latch when auto-push is switched off ────────────────────────
  console.log('\nH2 · turning auto-push off resets the outage latch');
  it('call site (source check): the disabled-exit clears the latch, and does not lie', () => {
    const daemon = src('scripts/qingyun-daemon.js');
    const at = daemon.indexOf("cfg('delivery.qingyunAutoPush', false) !== true");
    const body = daemon.slice(at, at + 900);
    assert.ok(/geoHoldAlerted = false/.test(body), 'the latch is reset');
    assert.ok(/geoHoldLastAlertMs = null/.test(body), 'and so is the throttle');
    assert.ok(!/sendOpsAlert/.test(body),
      'no all-clear here — the held pushes have NOT gone out, nobody is draining them');
  });
  it('after the reset, the next outage pages immediately', () => {
    // alerted:false + lastAlertMs:null is the state the reset leaves behind; a
    // stale throttle would have swallowed the next outage's first page.
    const d = qingyunQueue.geoHoldAlertDecision({
      heldCount: 4, oldestHeldMs: 0, now: 11 * 60_000, thresholdMin: 10,
      alerted: false, lastAlertMs: null });
    assert.strictEqual(d.alert, 'page');
  });

  // ── H3 · the classification the hold rests on ────────────────────────────
  console.log('\nH3 · an unfindable address is an ANSWER, never a hold');
  it('empty geocodes[] with status 1 classifies as an answer, not a failure', () => {
    // lib/geocode geocodeAmap returns exactly this shape when Amap replies OK
    // with nothing in geocodes[]. Classing it as a failure would hold a
    // genuinely unfindable address forever instead of refusing it once.
    assert.strictEqual(geocode.isProviderFailure({ code: 'no_result', message: 'no geocode' }), false);
    assert.strictEqual(geocode.isProviderFailure({ code: 'bad_coords', message: 'bad coords' }), false);
  });
  it('quota and network stay failures', () => {
    assert.strictEqual(geocode.isProviderFailure({ code: 'network', message: 'timeout' }), true);
    assert.strictEqual(geocode.isProviderFailure({ code: '121', message: '此key每日调用量已达到上限' }), true);
    assert.strictEqual(geocode.isProviderFailure({ code: '10003', message: 'DAILY_QUERY_OVER_LIMIT' }), true);
    assert.strictEqual(geocode.isProviderFailure({ code: '10004', message: 'ACCESS_TOO_FREQUENT' }), true);
  });
  await itAsync('a no_result reaches the REFUSE path, not the hold path', async () => {
    // End to end through buildCreatePayload, not just the classifier.
    let err = null;
    try {
      await buildCreatePayload(
        ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '不存在的路999号' }),
        SHOP, noPoi,
        { geocode: { configured: () => true, isDeliverablePin: geocode.isDeliverablePin,
                     geocodeAddress: async () => null,
                     geocodeAddressResult: async () => ({ result: null, failure: null }) } });
    } catch (e) { err = e; }
    assert.ok(err, 'it did not ship');
    assert.notStrictEqual(err.geoHold, true, 'must REFUSE — holding would park it forever');
    assert.strictEqual(err._geo.refused, true);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Coarse, but close. A vague point near the collecting store ships instead of
// parking: its error is bounded by its distance, and the rider finishes the
// job from the address text. Everything that made the gate worth having —
// the far pin, the wrong city, the address with no street — still refuses.
// ─────────────────────────────────────────────────────────────────────────
async function coarseNearSuite() {
  const { COARSE_OK_KM } = require('../lib/qingyun-payload');
  console.log('\ncoarse but close — a nearby vague pin ships unconfirmed');

  // SHOP sits at 23.13/113.33. The real order this was built for (TC000208,
  // 岭南山畔 in 黄埔区) had a provenance-less pin ~5.6km from the Tianhe store
  // and an address the map has no house number for.
  const NEAR = { province: '广东省', city: '广州市', district: '黄埔区',
                 address: '联和街道科翔路104号岭南山畔11栋2805房', lat: 23.155, lng: 113.375 };
  const coarseGeo = stubGeo({ lat: 23.18, lng: 113.45, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true });

  it('the threshold is half the refusal limit', () => {
    assert.strictEqual(COARSE_OK_KM, 12.5);
  });

  await itAsync('a provenance-less pin close to the store ships, unconfirmed', async () => {
    const p = await buildCreatePayload(ORDER(NEAR), SHOP, noPoi, { geocode: coarseGeo });
    assert.match(p._geo.source, /\+coarse_near$/, 'the source says how it got out');
    assert.strictEqual(p._geo.unconfirmed, true);
    assert.strictEqual(p.recipientLat, Math.round(23.155 * 1e6), 'it ships the pin it had, not the centroid');
  });

  await itAsync('no precision grade is invented on the way through', async () => {
    const p = await buildCreatePayload(ORDER(NEAR), SHOP, noPoi, { geocode: coarseGeo });
    assert.notStrictEqual(p._geo.precision, 'rooftop');
    assert.notStrictEqual(p._geo.source, 'customer_pin');
    assert.notStrictEqual(p._geo.source, 'staff_pin');
  });

  await itAsync('with NO stored pin, a coarse resolve near the store ships too', async () => {
    const { lat, lng, ...noPin } = NEAR;                                    // eslint-disable-line no-unused-vars
    const near = stubGeo({ lat: 23.15, lng: 113.37, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true });
    const p = await buildCreatePayload(ORDER(noPin), SHOP, noPoi, { geocode: near });
    assert.strictEqual(p._geo.source, 'geocode:amap+coarse_near');
    assert.strictEqual(p._geo.unconfirmed, true);
  });

  await itAsync('a WRONG-CITY match is never admitted, however close it lands', async () => {
    const { lat, lng, ...noPin } = NEAR;                                    // eslint-disable-line no-unused-vars
    const wrongCity = stubGeo({ lat: 23.15, lng: 113.37, precision: 'street', provider: 'amap', cityMatch: false });
    let err = null;
    try { await buildCreatePayload(ORDER(noPin), SHOP, noPoi, { geocode: wrongCity }); } catch (e) { err = e; }
    assert.ok(err, 'a confident answer in the wrong city is not a vague answer nearby');
  });

  await itAsync('a store with no coordinates cannot vouch for anything', async () => {
    const blindShop = { shopId: 'S1', cityId: 20, name: '测试门店' };
    let err = null;
    try { await buildCreatePayload(ORDER(NEAR), blindShop, noPoi, { geocode: coarseGeo }); } catch (e) { err = e; }
    assert.ok(err, 'with nothing to measure against, the order parks');
    assert.strictEqual(err.needsPoint, true);
  });

  await itAsync('an address with no street line still refuses, close or not', async () => {
    let err = null;
    try {
      await buildCreatePayload(ORDER({ province: '广东省', city: '广州市', lat: 23.135, lng: 113.335 }), SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.13, lng: 113.26, precision: 'coarse', level: '市', provider: 'amap', cityMatch: true }) });
    } catch (e) { err = e; }
    assert.ok(err, 'being near the store does not conjure a door for the rider');
  });

  await itAsync('the ceiling is untouched — a near-but-absurd pin is still refused', async () => {
    const farShop = { shopId: 'S1', cityId: 20, name: '测试门店', lat: 23.13, lng: 114.20 };
    let err = null;
    try { await buildCreatePayload(ORDER(NEAR), farShop, noPoi, { geocode: coarseGeo }); } catch (e) { err = e; }
    assert.ok(err, 'past ABS_MAX_KM nothing ships whatever the pin claims');
  });
}
