#!/usr/bin/env node
/**
 * Offline self-test for POI-first address resolution.
 * No network, no keys, no DB: the browser and the geocoder are stubs, and every
 * interesting case is a string.
 *
 *   node scripts/test_poi_first.js
 *
 * What it locks down:
 *   1. THE SPLIT — the findable half and the last-mile tail, including the
 *      '号' exception that keeps a street number out of the tail;
 *   2. THE HARD CONSTRAINT — recipientAddress on the wire is byte-identical to
 *      what it was before the split existed. The split is a LOOKUP concern and
 *      must never reach the waybill;
 *   3. THE CONFIDENCE TEST — one obvious hit is taken, an ambiguous pair is
 *      asked about, and a weak match is never taken silently;
 *   4. THE SAFETY GUARDS — poi_auto and poi_picked build a payload but are NOT
 *      trusted, so both stay subject to MAX_DROP_KM and ABS_MAX_KM;
 *   5. NO REGRESSION — every address the geocoder handles today still resolves
 *      the same way, by the same route, with the same source string.
 */
'use strict';

const assert = require('assert');
const {
  buildCreatePayload, splitFindable, nameScore, joinStreetDetail,
  POI_AUTO_SCORE, POI_MIN_SHARED, MAX_DROP_KM, ABS_MAX_KM,
} = require('../lib/qingyun-payload');
const qingyunQueue = require('../lib/qingyun-queue');
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

// ── Fixtures, same shapes as scripts/test_needs_point.js ──────────────────
const SHOP = { shopId: 'S1', cityId: 20, name: '测试门店', lat: 23.13, lng: 113.33 };
const ORDER = (addr) => ({
  order_no: 'TC000991', recipient_name: '张三', recipient_phone: '13000000868',
  address_json: JSON.stringify(addr), delivery_slot_label: '',
});
const stubGeo = (result, extra = {}) => ({
  configured: () => true,
  geocodeAddress: async () => result,
  isDeliverablePin: geocode.isDeliverablePin,
  ...extra,
});
// A geocoder that is present but finds nothing — an ANSWER, not a failure, so
// nothing holds.
const blindGeo = stubGeo(null);
// A browser with no POI index at all.
const noPoi = { searchPlaces: async () => [] };
// A browser returning a fixed list.
const poiList = (list) => ({ searchPlaces: async () => list });

const M = (lat, lng) => ({ lat: Math.round(lat * 1e6), lng: Math.round(lng * 1e6) });
// ~1.5km from SHOP — comfortably inside every limit.
const NEAR = M(23.14, 113.335);
// ~28km east of SHOP: past MAX_DROP_KM (25km), inside ABS_MAX_KM (50km).
const FAR = M(23.13, 113.60);
// ~90km out: past ABS_MAX_KM.
const MILES = M(23.13, 114.20);

const QIFU = { province: '广东省', city: '广州市', district: '番禺区', address: '祈福新村倚湖湾5座1106' };

(async () => {

// ─────────────────────────────────────────────────────────────────────────
console.log('\n1. the split — what a map can find vs what only a rider can');

it('lifts the 小区 name out from under the 座/室 tail', () => {
  const s = splitFindable('祈福新村倚湖湾5座1106', {});
  assert.strictEqual(s.findable, '祈福新村倚湖湾');
  assert.strictEqual(s.lastMile, '5座1106');
  assert.strictEqual(s.shape, 'named');
});

it('handles the 栋/层/室 form', () => {
  const s = splitFindable('品秀星越花园A栋18层1801室', {});
  assert.strictEqual(s.findable, '品秀星越花园');
  assert.strictEqual(s.lastMile, 'A栋18层1801室');
});

it('keeps a STREET NUMBER in the findable half — 号 is not a cut point', () => {
  // Cutting at a bare 号 deletes the house number off the very string the
  // geocoder fallback needs. Only 号楼 is a building.
  const s = splitFindable('中山一路1号', {});
  assert.strictEqual(s.findable, '中山一路1号', 'the number must survive');
  assert.strictEqual(s.lastMile, '');
});

it('cuts at 号楼, which IS a building', () => {
  const s = splitFindable('保利心语花园5号楼302', {});
  assert.strictEqual(s.findable, '保利心语花园');
  assert.strictEqual(s.lastMile, '5号楼302');
});

it('keeps a road+number prefix when an estate name follows it', () => {
  const s = splitFindable('联和街道科翔路104号岭南山畔11栋2805房', {});
  assert.strictEqual(s.findable, '联和街道科翔路104号岭南山畔');
  assert.strictEqual(s.lastMile, '11栋2805房');
  assert.strictEqual(s.shape, 'named');
});

it('files a bare road as a road, so it goes to the geocoder', () => {
  assert.strictEqual(splitFindable('科翔路', {}).shape, 'road');
  assert.strictEqual(splitFindable('中山一路1号', {}).shape, 'road');
  assert.strictEqual(splitFindable('黄埔大道西', {}).shape, 'road');
});

it('files a region-only address as region — neither index can help', () => {
  assert.strictEqual(splitFindable('广州市', { city: '广州市' }).shape, 'region');
  assert.strictEqual(splitFindable('', {}).shape, 'region');
});

it('handles Chinese numerals in the tail', () => {
  const s = splitFindable('碧桂园凤凰城二期三单元18楼', {});
  assert.strictEqual(s.findable, '碧桂园凤凰城二期');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2. the scorer — computed here, because neither API returns one');

it('an exact name scores 1', () => {
  assert.strictEqual(nameScore('祈福新村倚湖湾', '祈福新村倚湖湾').score, 1);
});

it('the containing ESTATE scores below the auto-take bar', () => {
  // 祈福新村 is the compound; 倚湖湾 is one tower in it. Taking the compound
  // silently would send a rider to the wrong end of a very large place.
  const s = nameScore('祈福新村倚湖湾', '祈福新村');
  assert.ok(s.score < POI_AUTO_SCORE, `expected < ${POI_AUTO_SCORE}, got ${s.score}`);
});

it('a coincidental shared word scores near zero', () => {
  const s = nameScore('祈福新村倚湖湾', '番禺区祈福医院');
  assert.ok(s.score < 0.4, `expected < 0.4, got ${s.score}`);
});

it('an unrelated place scores 0', () => {
  assert.strictEqual(nameScore('祈福新村倚湖湾', '广州南站').score, 0);
});

it('the absolute shared-character floor is what stops short-string inflation', () => {
  // Two 2-character names sharing both characters ratio to 1.00 on evidence
  // nobody would accept. POI_MIN_SHARED is the guard, not the ratio.
  const s = nameScore('东园', '东园');
  assert.strictEqual(s.score, 1);
  assert.ok(s.shared < POI_MIN_SHARED, 'a 2-char match must fall under the floor');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3. THE HARD CONSTRAINT — recipientAddress is untouched');

await itAsync('the wire address keeps the full string, tail and all', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...QIFU }), SHOP,
    poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '番禺区钟村街', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p.recipientAddress, '祈福新村倚湖湾5座1106',
    'the rider reads this field — the split must never reach it');
});

await itAsync('recipientAddress is byte-identical to joinStreetDetail, always', async () => {
  // The split is a lookup concern. Whatever it does to the search string, this
  // field is still exactly what it was before the split existed.
  const corpus = [
    { address: '祈福新村倚湖湾', detail: '5座1106' },
    { address: '品秀星越花园A栋', detail: 'A栋18层1801室' },
    { address: '中山一路1号', detail: '1号楼2单元' },
    { address: '联和街道科翔路104号岭南山畔11栋2805房', detail: '' },
    { address: '保利心语花园', detail: '5号楼302' },
  ];
  for (const c of corpus) {
    const p = await buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '番禺区', ...c }), SHOP,
      poiList([{ ...NEAR, name: '不匹配的地方', address: '', provider: 'qingyun' }]),
      { geocode: stubGeo({ ...deg(NEAR), precision: 'rooftop', provider: 'amap', cityMatch: true }) });
    assert.strictEqual(p.recipientAddress, joinStreetDetail(c.address, c.detail),
      `wire address drifted for ${c.address} + ${c.detail}`);
  }
});

await itAsync('doorInfo is untouched too', async () => {
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '番禺区', address: '祈福新村倚湖湾', detail: '5座1106' }),
    SHOP, poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p.doorInfo, '5座1106');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4. the confidence test — take one, ask about several');

await itAsync('THE CASE THIS BUILD EXISTS FOR: a named 小区 the geocoder cannot place', async () => {
  // Geocoding returns nothing for this string. The name search finds it.
  const p = await buildCreatePayload(
    ORDER({ ...QIFU }), SHOP,
    poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '番禺区钟村街祈福新村', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'poi_auto');
  assert.strictEqual(p.recipientLat, NEAR.lat);
  assert.strictEqual(p._geo.poi.name, '祈福新村倚湖湾');
  assert.strictEqual(p._geo.poi.query, '祈福新村倚湖湾', 'the query records the half it searched');
});

await itAsync('a single clear hit is taken without asking', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...QIFU }), SHOP,
    poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'poi_auto');
});

await itAsync('TWO similar names park for a choice instead of guessing', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU }), SHOP,
      poiList([
        { ...NEAR, name: '祈福新村倚湖湾', address: '番禺区A', provider: 'qingyun' },
        { ...M(23.15, 113.34), name: '祈福新村倚湖湾北', address: '番禺区B', provider: 'qingyun' },
      ]),
      { geocode: blindGeo }),
    (e) => {
      assert.strictEqual(e.pickPlace, true, 'must be flagged for a choice');
      assert.strictEqual(e.needsPoint, undefined, 'must NOT be the map state');
      assert.strictEqual(e.geoHold, undefined, 'must not be confused with an outage');
      assert.strictEqual(e.candidates.length, 2);
      assert.strictEqual(e.candidates[0].name, '祈福新村倚湖湾');
      return true;
    });
});

await itAsync('a weak top match is never taken silently', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU }), SHOP,
      poiList([{ ...NEAR, name: '番禺区祈福医院', address: '', provider: 'qingyun' }]),
      { geocode: blindGeo }),
    (e) => { assert.strictEqual(e.pickPlace, true); return true; });
});

await itAsync('candidates are capped at three, and keep the provider ranking', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU }), SHOP,
      poiList([1, 2, 3, 4, 5].map((n) => ({ ...NEAR, name: `祈福新村${n}期`, address: '', provider: 'qingyun' }))),
      { geocode: blindGeo }),
    (e) => {
      assert.strictEqual(e.candidates.length, 3, 'three is the cap');
      assert.strictEqual(e.candidates[0].name, '祈福新村1期', 'the provider ranked this first');
      assert.deepStrictEqual(e.candidates.map(c => c.rank), [0, 1, 2], 'ranks are the provider\'s, in order');
      return true;
    });
});

await itAsync('SAME-CITY WRONG-DISTRICT: a strong name match in a different district is not taken silently', async () => {
  // The real-world failure this guards: a generic/branded name ("XX新天地")
  // out-scores the actual estate while sitting in a different district of
  // the same city — a perfectly ordinary same-city distance, so MAX_DROP_KM
  // never sees it. Only one candidate is offered, so without the district
  // gate this would clear POI_AUTO_SCORE/MARGIN/MIN_SHARED outright.
  await assert.rejects(
    buildCreatePayload(
      ORDER({ province: '广东省', city: '广州市', district: '越秀区', address: '富力新天地' }),
      SHOP,
      poiList([{ ...FAR, name: '富力新天地', address: '广东省广州市天河区元岗街富力新天地', provider: 'qingyun' }]),
      { geocode: blindGeo }),
    (e) => { assert.strictEqual(e.pickPlace, true, 'must park for a person, not auto-ship the wrong district'); return true; });
});

await itAsync('same district name in the address text still auto-takes', async () => {
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '越秀区', address: '富力新天地' }),
    SHOP,
    poiList([{ ...NEAR, name: '富力新天地', address: '广东省广州市越秀区广州大道富力新天地', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'poi_auto');
});

await itAsync('no district on file, or none readable from the hit — undecidable, still auto-takes', async () => {
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '', address: '祈福新村倚湖湾' }),
    SHOP,
    poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'poi_auto');
});

await itAsync('a ROAD skips the name search and goes to the geocoder', async () => {
  // The name search would answer — with the road centroid or a shop on it —
  // and it must not be consulted, because geocoding indexes exactly this.
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '越秀区', address: '中山一路1号' }), SHOP,
    poiList([{ ...FAR, name: '中山一路', address: '', provider: 'qingyun' }]),
    { geocode: stubGeo({ ...deg(NEAR), precision: 'street', provider: 'amap', cityMatch: true }) });
  assert.strictEqual(p._geo.source, 'geocode:amap');
  assert.strictEqual(p._geo.precision, 'street');
  assert.strictEqual(p._geo.poi, null, 'no name-search provenance on a road');
});

await itAsync('nothing found by either index is still a REFUSAL, not a park', async () => {
  // Unchanged behaviour. A park is for a question a person can answer, and
  // there is nothing here to show them.
  await assert.rejects(
    buildCreatePayload(ORDER({ ...QIFU }), SHOP, noPoi, { geocode: blindGeo }),
    (e) => {
      assert.strictEqual(e.pickPlace, undefined);
      assert.strictEqual(e.needsPoint, undefined);
      assert.ok(/no pin, no precise match/.test(e.message));
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n5. the safety guards — resolved, but never trusted');

await itAsync('poi_auto is REFUSED past MAX_DROP_KM', async () => {
  // This is the net under an auto-take: the right-sounding name in the wrong
  // district fails by DISTANCE, and nothing else can see it.
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU }), SHOP,
      poiList([{ ...FAR, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
      { geocode: blindGeo }),
    (e) => {
      assert.ok(/drop-off is/.test(e.message), `expected a distance refusal, got: ${e.message}`);
      assert.ok(!/ceiling/.test(e.message), 'this one is the 25km limit, not the 50km ceiling');
      assert.strictEqual(e._geo.source, 'poi_auto', 'the refusal names the source');
      return true;
    });
});

await itAsync('poi_picked is REFUSED past MAX_DROP_KM too — a person choosing is not a person pointing', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU, ...deg(FAR), geo_source: 'poi_picked', geo_precision: null }),
      SHOP, noPoi, { geocode: blindGeo }),
    (e) => {
      assert.ok(/drop-off is/.test(e.message));
      assert.strictEqual(e._geo.source, 'poi_picked');
      return true;
    });
});

await itAsync('staff_pin at the same distance is ALLOWED — the contrast that proves the guard', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...QIFU, ...deg(FAR), geo_source: 'staff_pin', geo_precision: null }),
    SHOP, noPoi, { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'staff_pin');
  assert.ok(p._geo.dropKm > MAX_DROP_KM, 'the same distance that refused a picked place');
});

await itAsync('poi_picked builds a payload inside the limit', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...QIFU, ...deg(NEAR), geo_source: 'poi_picked', geo_precision: null }),
    SHOP, noPoi, { geocode: blindGeo });
  assert.strictEqual(p._geo.source, 'poi_picked');
  assert.strictEqual(p.recipientLat, NEAR.lat);
});

await itAsync('the ABS_MAX_KM ceiling still refuses everything', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...QIFU }), SHOP,
      poiList([{ ...MILES, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
      { geocode: blindGeo }),
    (e) => { assert.ok(/ceiling/.test(e.message), `expected the ceiling, got: ${e.message}`); return true; });
  assert.ok(ABS_MAX_KM > MAX_DROP_KM);
});

await itAsync('no precision grade is invented for an auto-take', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...QIFU }), SHOP,
    poiList([{ ...NEAR, name: '祈福新村倚湖湾', address: '', provider: 'qingyun' }]),
    { geocode: blindGeo });
  assert.strictEqual(p._geo.precision, null, 'nobody measured one');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n6. NO REGRESSION — what resolves today still resolves the same way');

await itAsync('a trusted customer_pin never reaches either lookup (D1)', async () => {
  const boom = { searchPlaces: async () => { throw new Error('must not be called'); } };
  const p = await buildCreatePayload(
    ORDER({ ...QIFU, ...deg(NEAR), geo_source: 'customer_pin' }), SHOP, boom,
    { geocode: stubGeo(null, { geocodeAddress: async () => { throw new Error('must not be called'); } }) });
  assert.strictEqual(p._geo.source, 'customer_pin');
});

await itAsync('a rooftop geocode still wins, by the same name, when the name search is quiet', async () => {
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '体育西路103号' }), SHOP, noPoi,
    { geocode: stubGeo({ ...deg(NEAR), precision: 'rooftop', provider: 'amap', cityMatch: true }) });
  assert.strictEqual(p._geo.source, 'geocode:amap');
  assert.strictEqual(p._geo.precision, 'rooftop');
});

await itAsync('the coarse-but-close rule still ships unconfirmed', async () => {
  const p = await buildCreatePayload(
    ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '某某路某某号' }), SHOP, noPoi,
    { geocode: stubGeo({ ...deg(NEAR), precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) });
  assert.ok(/\+coarse_near$/.test(p._geo.source), `expected coarse_near, got ${p._geo.source}`);
  assert.strictEqual(p._geo.unconfirmed, true);
});

await itAsync('a geocoder outage is still a HOLD, not a park', async () => {
  const holdGeo = {
    configured: () => true,
    isDeliverablePin: geocode.isDeliverablePin,
    geocodeAddressResult: async () => ({ result: null, failure: { code: 'network', message: 'down' } }),
  };
  await assert.rejects(
    buildCreatePayload(ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '某某路1号' }), SHOP, noPoi,
      { geocode: holdGeo }),
    (e) => { assert.strictEqual(e.geoHold, true); return true; });
});

await itAsync('candidates BEAT a geocoder outage — an answer is not nothing', async () => {
  // A hold means "we learned nothing". The name search is a different provider
  // and it answered, so sitting on three usable candidates until a quota reset
  // would be holding an answer.
  const holdGeo = {
    configured: () => true,
    isDeliverablePin: geocode.isDeliverablePin,
    geocodeAddressResult: async () => ({ result: null, failure: { code: 'quota', message: 'over', quota: true } }),
  };
  await assert.rejects(
    buildCreatePayload(ORDER({ ...QIFU }), SHOP,
      poiList([
        { ...NEAR, name: '祈福新村倚湖湾', address: 'A', provider: 'qingyun' },
        { ...M(23.15, 113.34), name: '祈福新村倚湖湾北', address: 'B', provider: 'qingyun' },
      ]),
      { geocode: holdGeo }),
    (e) => {
      assert.strictEqual(e.pickPlace, true, 'ask, do not hold');
      assert.strictEqual(e.geoHold, undefined);
      return true;
    });
});

await itAsync('an unplaceable address with no candidates still parks as needs_point', async () => {
  const p = ORDER({ province: '广东省', city: '广州市', district: '天河区', address: '某某路某某号',
    lat: 23.13, lng: 113.60, geo_source: 'geocode:amap', geo_precision: 'coarse' });
  await assert.rejects(
    buildCreatePayload(p, SHOP, noPoi,
      { geocode: stubGeo({ lat: 23.13, lng: 113.60, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true }) }),
    (e) => {
      assert.strictEqual(e.needsPoint, true, 'still the map state');
      assert.strictEqual(e.pickPlace, undefined);
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n7. the queue — a new parked state that behaves like its sibling');

it('shouldMarkAwaitingChoice fires only on the pickPlace marker', () => {
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice({ pickPlace: true }), true);
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice({ needsPoint: true }), false);
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice({ geoHold: true }), false);
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice(new Error('x')), false);
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice(null), false);
});

it('the two parked markers are mutually exclusive', () => {
  const pick = { pickPlace: true }, point = { needsPoint: true };
  assert.strictEqual(qingyunQueue.shouldMarkNeedsPoint(pick), false);
  assert.strictEqual(qingyunQueue.shouldMarkAwaitingChoice(point), false);
});

it('awaitingChoice needs the status AND no courier copy', () => {
  assert.strictEqual(qingyunQueue.awaitingChoice({ status: 'awaiting_choice' }), true);
  assert.strictEqual(qingyunQueue.awaitingChoice({ status: 'awaiting_choice', qingyun_order_id: '9' }), false);
  assert.strictEqual(qingyunQueue.awaitingChoice({ status: 'needs_point' }), false);
});

it('a parked-for-choice row is flagged and retryable, like its sibling', () => {
  const row = { status: 'awaiting_choice' };
  assert.strictEqual(qingyunQueue.needsAttention(row), true);
  assert.strictEqual(qingyunQueue.manualRetryEligible(row), true);
  assert.strictEqual(qingyunQueue.requeueEligible(row), true, 'an address edit re-runs the search');
});

it('readCandidates degrades to the map rather than to an empty question', () => {
  assert.deepStrictEqual(qingyunQueue.readCandidates({ candidates_json: null }), []);
  assert.deepStrictEqual(qingyunQueue.readCandidates({ candidates_json: '{oops' }), []);
  assert.deepStrictEqual(qingyunQueue.readCandidates({ candidates_json: '{"a":1}' }), []);
  assert.strictEqual(qingyunQueue.readCandidates({ candidates_json: '[{"name":"x"}]' }).length, 1);
});

it('each confirm statement is pinned to its OWN state', () => {
  // A statement that accepted either would let a stale drawer stamp the wrong
  // provenance — a map tap recorded as a chosen POI, or the reverse.
  assert.ok(/status = 'awaiting_choice'/.test(qingyunQueue.CONFIRM_CHOICE_SQL));
  assert.ok(!/needs_point'/.test(qingyunQueue.CONFIRM_CHOICE_SQL.split('WHERE')[1]));
  assert.ok(/status = 'needs_point'/.test(qingyunQueue.CONFIRM_POINT_SQL));
  assert.ok(!/awaiting_choice/.test(qingyunQueue.CONFIRM_POINT_SQL));
});

it('every parked statement carries the no-copy compare-and-swap guard', () => {
  for (const [n, sql] of [
    ['AWAITING_CHOICE_SQL', qingyunQueue.AWAITING_CHOICE_SQL],
    ['CONFIRM_CHOICE_SQL', qingyunQueue.CONFIRM_CHOICE_SQL],
    ['REJECT_CHOICE_SQL', qingyunQueue.REJECT_CHOICE_SQL],
  ]) assert.ok(/qingyun_order_id IS NULL/.test(sql), `${n} must not park a row that already has a copy`);
});

it('leaving a parked state clears the list that described it', () => {
  for (const [n, sql] of [
    ['CONFIRM_CHOICE_SQL', qingyunQueue.CONFIRM_CHOICE_SQL],
    ['REJECT_CHOICE_SQL', qingyunQueue.REJECT_CHOICE_SQL],
    ['REQUEUE_SQL', qingyunQueue.REQUEUE_SQL],
    ['MANUAL_RETRY_SQL', qingyunQueue.MANUAL_RETRY_SQL],
  ]) assert.ok(/candidates_json = NULL/.test(sql), `${n} must clear candidates_json`);
});

it('rejecting the list moves to needs_point and KEEPS the guess for the map', () => {
  assert.ok(/status = 'needs_point'/.test(qingyunQueue.REJECT_CHOICE_SQL));
  assert.ok(!/guessed_lat = NULL/.test(qingyunQueue.REJECT_CHOICE_SQL),
    'the guess is what the map opens on — it must survive');
});

// ─────────────────────────────────────────────────────────────────────────
// Section 7 above reads the SQL as TEXT, which proves a clause is present and
// nothing at all about whether the statement runs. These execute it against the
// real table definition lifted out of database.js — so a column added there and
// forgotten in the statement, or the reverse, fails here rather than at 2am on
// the box. Same harness as scripts/test_needs_point.js.
console.log('\n8. the SQL, actually executed against the real table');

const { openQueueTableDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);
const freshDb = () => openQueueTableDb(
  require('fs').readFileSync(require('path').join(__dirname, '..', 'database.js'), 'utf8'));
const seed = (db, row = {}) => {
  const r = { status: 'pending', attempts: 0, qy: null, ...row };
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, qingyun_order_id)
              VALUES (991, 'tianhe', ?, ?, ?)`).run(r.status, r.attempts, r.qy);
  return db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 991').get();
};
const read = (db) => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 991').get();
const CANDS = [
  { lat: 23140000, lng: 113335000, name: '祈福新村倚湖湾', address: 'A', score: 1, dropKm: 1.5 },
  { lat: 23150000, lng: 113340000, name: '祈福新村倚湖湾北', address: 'B', score: 0.88, dropKm: 2.6 },
];
// The drain's own sequence: take the attempt, then park with the pre-increment
// count — exactly as scripts/qingyun-daemon.js does it.
const parkChoice = (db, r) => {
  db.prepare("UPDATE qingyun_push_queue SET status='processing', attempts=attempts+1 WHERE id=?").run(r.id);
  return db.prepare(qingyunQueue.AWAITING_CHOICE_SQL)
    .run(r.attempts, JSON.stringify(CANDS), 23.14, 113.335, null, 'pick one', r.id);
};

it('parking for a choice stores the list and hands back the attempt', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  const after = read(db);
  assert.strictEqual(after.status, 'awaiting_choice');
  assert.strictEqual(after.attempts, 0, 'the attempt the drain spent is given back');
  assert.ok(after.needs_point_at, 'the wait is stamped');
  assert.strictEqual(qingyunQueue.readCandidates(after).length, 2);
  assert.strictEqual(qingyunQueue.readCandidates(after)[0].name, '祈福新村倚湖湾');
});

it('a row that already has a courier copy is never parked', () => {
  const db = freshDb();
  const r = seed(db, { qy: 'QY-9' });
  const res = db.prepare(qingyunQueue.AWAITING_CHOICE_SQL)
    .run(r.attempts, JSON.stringify(CANDS), null, null, null, 'pick one', r.id);
  assert.strictEqual(res.changes, 0, 'parking would hide a live delivery behind a question');
});

it('picking requeues with a FULL attempt budget and clears the list', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_CHOICE_SQL).run(991).changes, 1);
  const after = read(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.attempts, 0);
  assert.strictEqual(after.candidates_json, null, 'the list described the state we just left');
  assert.strictEqual(after.needs_point_at, null);
});

it('the confirm statements cannot cross states', () => {
  // A map tap must not be recordable against a row awaiting a choice, and a
  // pick must not be recordable against one awaiting a point.
  const db = freshDb();
  parkChoice(db, seed(db));
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(991).changes, 0,
    'confirm-point must not touch an awaiting_choice row');

  const db2 = freshDb();
  const r = seed(db2);
  db2.prepare("UPDATE qingyun_push_queue SET status='processing', attempts=attempts+1 WHERE id=?").run(r.id);
  db2.prepare(qingyunQueue.NEEDS_POINT_SQL).run(r.attempts, 23.14, 113.33, 'coarse', 'place it', r.id);
  assert.strictEqual(db2.prepare(qingyunQueue.CONFIRM_CHOICE_SQL).run(991).changes, 0,
    'confirm-place must not touch a needs_point row');
});

it('rejecting the list moves the row to the map state, guess intact', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  assert.strictEqual(db.prepare(qingyunQueue.REJECT_CHOICE_SQL).run('place it', 991).changes, 1);
  const after = read(db);
  assert.strictEqual(after.status, 'needs_point');
  assert.strictEqual(after.candidates_json, null, 'the rejected list is gone');
  assert.strictEqual(after.guessed_lat, 23.14, 'the guess is what the map opens on');
  assert.strictEqual(after.attempts, 0, 'no attempt is spent moving between parked states');
  // …and it is now answerable by the map endpoint, which is the whole point.
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(991).changes, 1);
});

it('rejecting twice is a no-op, not a second move', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  db.prepare(qingyunQueue.REJECT_CHOICE_SQL).run('place it', 991);
  assert.strictEqual(db.prepare(qingyunQueue.REJECT_CHOICE_SQL).run('place it', 991).changes, 0);
});

it('an address edit requeues a parked-for-choice row and drops its list', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  assert.strictEqual(db.prepare(qingyunQueue.REQUEUE_SQL).run('address edited', 991).changes, 1);
  const after = read(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.candidates_json, null, 'a list built from deleted text still looks answerable');
});

it('a cancel retires a parked-for-choice row like any other', () => {
  const db = freshDb();
  parkChoice(db, seed(db));
  assert.strictEqual(db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('order cancelled', 991).changes, 1);
  assert.strictEqual(read(db).status, 'skipped');
});

it('existing rows are untouched by the new column', () => {
  const db = freshDb();
  const r = seed(db);
  assert.strictEqual(r.candidates_json, null, 'NULL on every row that predates this');
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})();

// ×1e6 ints back to degrees, for the fixtures that seed an ORDER rather than a
// POI result. Declared after use deliberately — function hoisting applies, and
// it keeps the fixtures at the top where they are read.
function deg(m) { return { lat: m.lat / 1e6, lng: m.lng / 1e6 }; }
