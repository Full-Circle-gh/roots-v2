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

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
