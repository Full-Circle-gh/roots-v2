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
  assert.strictEqual(joinStreetDetail('中山一路8号', '号楼302室'), '中山一路8号 号楼302室');
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
it('refuses nothing at all', () => {
  assert.strictEqual(geocode.isDeliverablePin(null).ok, false);
});

console.log('\ncityMatches — suffix-insensitive, undecidable when unknown');
it('广州 == 广州市', () => assert.strictEqual(geocode.cityMatches('广州', '广州市'), true));
it('广州市 != 佛山市', () => assert.strictEqual(geocode.cityMatches('广州市', '佛山市'), false));
it('unknown side is undecidable, not a mismatch', () => {
  assert.strictEqual(geocode.cityMatches('广州市', ''), null);
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
    const warns = [];
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '南沙区', address: '某某花园1栋',
              lat: 22.6, lng: 113.5, geo_source: 'customer_pin' }),
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

  await itAsync('a no-provenance pin the address cannot corroborate is REFUSED', async () => {
    await assert.rejects(
      buildCreatePayload(
        ORDER({ ...LEGACY, lat: 23.40, lng: 113.20 }),
        SHOP, noPoi,
        { geocode: stubGeo({ lat: 23.39, lng: 113.21, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) }),
      /could not be corroborated/);
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
  it('the requeue SQL only ever touches an errored, copy-less row', () => {
    assert.match(qingyunQueue.REQUEUE_SQL, /qingyun_order_id IS NULL/);
    assert.match(qingyunQueue.REQUEUE_SQL, /status = 'error'/);
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
