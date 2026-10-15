#!/usr/bin/env node
/**
 * test_delivery_zones.js — which delivery zone an address lands in, which store
 * a parcel leaves from, and the names and province a zone is shown under.
 *
 *   node scripts/test_delivery_zones.js
 *
 * WHAT IT GUARDS. A mutation sweep of routes/retail.js (2026-10-15) broke the
 * zone code and almost nothing noticed: matchDeliveryZone 1 of 3,
 * fulfillingStoreFor 1 of 3, defaultDeliveryZone 1 of 2, zoneEnglishName and
 * zoneProvince 0 of 6. The zone decides the fee (test_delivery_fees.js) and the
 * slots; matching the wrong one charges the wrong price or refuses a good
 * address. The store decides where the parcel ships from. The name and province
 * are what the delivery settings screen shows the operator.
 *
 * HOW. The real code is lifted from the source (retailSource(), so it is found
 * in routes/retail.js or in lib/ after decisions §477 moves it) and run over the
 * real retail_delivery_zones table and the real reference/china_regions.json.
 * The store choice runs with the real Guangzhou-address check from
 * lib/inventory.js and stand-ins for the store list, so what is tested is its
 * own rules.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const CHINA_REGIONS = require(path.join(ROOT, 'reference', 'china_regions.json'));

// A top-level declaration by name: a function to its closing brace, a one-line
// const/let to its semicolon, a multi-line object to its closing "};".
function declSrc(name) {
  const at = SRC.search(new RegExp(`^(function ${name}\\(|(const|let) ${name}\\b)`, 'm'));
  assert.ok(at >= 0, `${name} not found`);
  const firstLineEnd = SRC.indexOf('\n', at);
  const first = SRC.slice(at, firstLineEnd);
  if (!first.startsWith('function') && /;\s*$/.test(first)) return first;
  const close = first.startsWith('function') ? '\n}' : '\n};';
  return SRC.slice(at, SRC.indexOf(close, at) + close.length);
}

let db = openTablesDb(DB_SRC, ['retail_delivery_zones']);
let CFG = {};
const cfgValue = (k, d) => (k in CFG ? CFG[k] : d);
const realInventory = require(path.join(ROOT, 'lib', 'inventory'));

// Stand-ins for the store list the store choice reads.
const W = { optIn: false, closed: new Set(), stores: [{ id: 1, code: 'tianhe' }, { id: 9, code: 'warehouse' }], ooc: 9 };
const inventory = {
  isGuangzhouAddress: realInventory.isGuangzhouAddress,
  orderChannelKey: realInventory.orderChannelKey,
  isOptInSameDayDistrict: () => W.optIn,
  channelClosedStores: () => W.closed,
  listStores: () => W.stores,
};

const NAMES = ['GZ_CITY_ALIASES', 'normalizeAreaName', 'isGuangzhou', 'defaultDeliveryZone', 'matchDeliveryZone',
  'noZoneMatchPayload', 'fulfillingStoreFor', 'HK_DISTRICTS_EN', '_zoneEnMap', 'zoneEnglishName', '_zoneProvMap',
  'HK_CN', 'zoneProvince'];
const EXPOSE = NAMES.filter((n) => !n.startsWith('_') && n !== 'HK_CN' && n !== 'GZ_CITY_ALIASES');
const Z = new Function('cfgValue', 'tdb', 'inventory', 'loadPrinterPrefs', 'CHINA_REGIONS',
  `${NAMES.map(declSrc).join('\n')}\nreturn { ${EXPOSE.join(', ')} };`)(
  cfgValue, () => db, inventory, () => ({ out_of_city_store_id: W.ooc }), CHINA_REGIONS);

const zone = db.prepare(`INSERT INTO retail_delivery_zones (zone_type, name_en, name_cn, match_city, match_district, base_fee, is_active)
                         VALUES (?, ?, ?, ?, ?, 10, ?)`);
const ids = {};
const add = (key, type, city, district, active = 1) => { ids[key] = zone.run(type, key, key, city, district, active).lastInsertRowid; };
add('tianhe', 'gz_district', '广州市', '天河区');
add('yuexiu', 'gz_district', '广州市', '越秀区');
add('shenzhen', 'city', '深圳市', null);
add('jiangsu', 'city', '江苏省', null);
add('taiyuan', 'city', '太原市', null);
add('shanxi', 'city', '山西省', null);
add('hk', 'city', '香港', null);
add('dongguan_off', 'city', '东莞市', null, 0);

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(() => {
  CFG = {};
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;
const match = (a) => { const z = Z.matchDeliveryZone(a); return z ? (z.name_en || z.id) : null; };

// ══ 1. names of places ═════════════════════════════════════════════════════
section('1. a place name is compared without its 市/区/县/省, and Guangzhou is recognised');

it('the suffix and case go; nothing else does', () => {
  assert.strictEqual(Z.normalizeAreaName('天河区'), '天河');
  assert.strictEqual(Z.normalizeAreaName(' Jiangsu省 '), 'jiangsu');
  assert.strictEqual(Z.normalizeAreaName('区'), '');
  assert.strictEqual(Z.normalizeAreaName(null), '');
});
it('Guangzhou in any of its spellings; nowhere else', () => {
  for (const c of ['广州', '广州市', 'Guangzhou', ' GZ ', 'guangzhou市']) assert.strictEqual(Z.isGuangzhou(c), true, c);
  for (const c of ['深圳市', '广东省', '', null, 'guangzhouxi']) assert.strictEqual(Z.isGuangzhou(c), false, String(c));
});

// ══ 2. the rest-of-China zone ══════════════════════════════════════════════
section('2. the rest-of-China zone, built from settings, or none');

it('switched off or not set → none', () => {
  assert.strictEqual(Z.defaultDeliveryZone(), null);
  CFG = { 'delivery.defaultZone': { enabled: false, base_fee: 5 } };
  assert.strictEqual(Z.defaultDeliveryZone(), null);
});
it('switched on with nothing else set: ¥25, no free option, 1-15 days out, whole days only', () => {
  CFG = { 'delivery.defaultZone': { enabled: true } };
  const d = Z.defaultDeliveryZone();
  assert.deepStrictEqual([d.id, d.zone_type, d.name_en, d.name_cn], ['default', 'city', 'Rest of China', '其他地区']);
  assert.deepStrictEqual([d.base_fee, d.free_threshold, d.weight, d.max_fee, d.packing_fee_per_item, d.packing_fee_cap],
    [25, null, null, null, 0, null]);
  assert.deepStrictEqual([d.min_lead_days, d.max_lead_days, d.day_only, d.same_day_allowed], [1, 15, 1, 0]);
});
it('what the settings say comes through, numbers as numbers; a free-over of 0 stays 0', () => {
  CFG = { 'delivery.defaultZone': { enabled: true, base_fee: '18', free_threshold: 0, packing_fee_per_item: 1,
    packing_fee_cap: '6', min_lead_days: 2, max_lead_days: 7, day_only: false, same_day_allowed: true,
    weight: { first_kg_fee: 12, extra_kg_fee: 5 } } };
  const d = Z.defaultDeliveryZone();
  assert.deepStrictEqual([d.base_fee, d.free_threshold, d.packing_fee_per_item, d.packing_fee_cap], [18, 0, 1, 6]);
  assert.deepStrictEqual([d.min_lead_days, d.max_lead_days, d.day_only, d.same_day_allowed], [2, 7, 0, 1]);
  assert.deepStrictEqual(d.weight, { first_kg_fee: 12, extra_kg_fee: 5 });
});
it('a weight rule with no first-kg fee is no weight rule', () => {
  CFG = { 'delivery.defaultZone': { enabled: true, weight: { extra_kg_fee: 5 } } };
  assert.strictEqual(Z.defaultDeliveryZone().weight, null);
});

// ══ 3. matching an address to a zone ═══════════════════════════════════════
section('3. an address lands in the most specific zone, or is refused');

it('no address → none', () => assert.strictEqual(match(null), null));
it('Guangzhou: the district, with or without 区', () => {
  assert.strictEqual(match({ city: '广州市', district: '天河区' }), 'tianhe');
  assert.strictEqual(match({ city: '广州', district: '天河' }), 'tianhe');
});
it('Guangzhou with the district only in the address text (a WeChat import)', () => {
  assert.strictEqual(match({ address: '广东省广州市越秀区北京路1号' }), 'yuexiu');
});
it('Guangzhou with the district written without 区 in the address text', () => {
  assert.strictEqual(match({ address: '广州天河体育中心东门' }), 'tianhe');
});
it('Guangzhou in a district with no zone is refused — never sent to rest of China', () => {
  CFG = { 'delivery.defaultZone': { enabled: true } };
  assert.strictEqual(match({ city: '广州市', district: '番禺区' }), null);
});
it('a city zone by its city', () => {
  assert.strictEqual(match({ province: '广东省', city: '深圳市', district: '南山区' }), 'shenzhen');
});
it('a city zone beats its province\'s zone (太原 over 山西)', () => {
  assert.strictEqual(match({ province: '山西省', city: '太原市' }), 'taiyuan');
  assert.strictEqual(match({ province: '山西省', city: '大同市' }), 'shanxi');
});
it('a province zone by the address\'s province', () => {
  assert.strictEqual(match({ province: '江苏省', city: '苏州市' }), 'jiangsu');
});
it('a province zone from the address text alone', () => {
  assert.strictEqual(match({ address: '江苏南京市玄武区中山路1号' }), 'jiangsu');
});
it('Hong Kong: the one HK zone, from the SAR name or "Hong Kong"', () => {
  assert.strictEqual(match({ province: '香港特别行政区', city: '香港', district: '湾仔区' }), 'hk');
  assert.strictEqual(match({ address: '1 Queen\'s Road, Hong Kong' }), 'hk');
});
it('a switched-off zone is never matched', () => {
  assert.strictEqual(match({ province: '广东省', city: '东莞市' }), null);
});
it('no zone matches: rest of China when it is on, refused when it is off', () => {
  assert.strictEqual(match({ province: '四川省', city: '成都市' }), null);
  CFG = { 'delivery.defaultZone': { enabled: true } };
  assert.strictEqual(match({ province: '四川省', city: '成都市' }), 'Rest of China');
});
it('a shop with no Guangzhou districts treats Guangzhou as an ordinary city', () => {
  const real = db;
  db = openTablesDb(DB_SRC, ['retail_delivery_zones']);
  try {
    db.prepare("INSERT INTO retail_delivery_zones (zone_type, name_en, match_city, base_fee) VALUES ('city', 'gzcity', '广州市', 8)").run();
    assert.strictEqual(match({ city: '广州市', district: '番禺区' }), 'gzcity');
    db.prepare("DELETE FROM retail_delivery_zones").run();
    CFG = { 'delivery.defaultZone': { enabled: true } };
    assert.strictEqual(match({ city: '广州市', district: '番禺区' }), 'Rest of China', 'every Guangzhou address refused');
  } finally { db = real; }
});

it('a refused address names the place to add a zone for', () => {
  assert.deepStrictEqual(Z.noZoneMatchPayload({ province: '四川省', city: '成都市', district: '武侯区' }),
    { success: false, error: 'no_zone_match', province: '四川省', city: '成都市', district: '武侯区', unmatched: '四川省 成都市 武侯区' });
  assert.deepStrictEqual(Z.noZoneMatchPayload({ city: '成都市' }),
    { success: false, error: 'no_zone_match', province: null, city: '成都市', district: null, unmatched: '成都市' });
  assert.deepStrictEqual(Z.noZoneMatchPayload(null),
    { success: false, error: 'no_zone_match', province: null, city: null, district: null, unmatched: null });
});

// ══ 4. which store ships it ════════════════════════════════════════════════
section('4. the store a delivery leaves from: the out-of-city warehouse, or the router\'s pick');

const ship = (o) => {
  const r = Z.fulfillingStoreFor({ address: { city: '深圳市', district: '南山区' }, ...o });
  return r ? [r.store.id, r.reason] : null;
};
const GZ = { city: '广州市', district: '番禺区' };
const reset = () => { W.optIn = false; W.closed = new Set(); W.ooc = 9; W.stores = [{ id: 1, code: 'tianhe' }, { id: 9, code: 'warehouse' }]; };
it('an out-of-city delivery leaves from the warehouse', () => { reset(); assert.deepStrictEqual(ship({}), [9, 'out_of_city']); });
it('pickup, or an ordinary Guangzhou delivery, keeps the router\'s pick', () => {
  reset();
  assert.strictEqual(ship({ isPickup: true }), null);
  assert.strictEqual(ship({ address: GZ }), null);
});
it('a scheduled Guangzhou ship-district leaves from the warehouse — unless same-day was bought', () => {
  reset(); W.optIn = true;
  assert.deepStrictEqual(ship({ address: GZ, slotKind: 'scheduled' }), [9, 'scheduled_ship_district']);
  assert.deepStrictEqual(ship({ address: GZ }), [9, 'scheduled_ship_district']);
  assert.strictEqual(ship({ address: GZ, slotKind: 'today' }), null);
});
it('no warehouse set, the router already picked it, it is closed for the channel, or switched off → the router\'s pick', () => {
  reset(); W.ooc = null; assert.strictEqual(ship({}), null);
  reset(); assert.strictEqual(ship({ baseStoreId: 9 }), null);
  reset(); assert.deepStrictEqual(ship({ baseStoreId: 1 }), [9, 'out_of_city']);
  reset(); W.closed = new Set(['warehouse']); assert.strictEqual(ship({}), null);
  reset(); W.stores = [{ id: 1, code: 'tianhe' }]; assert.strictEqual(ship({}), null);
});

// ══ 5. how a zone is shown ═════════════════════════════════════════════════
section('5. a zone\'s English name and the province it is listed under');

it('its own English name wins; a blank one is filled from the regions list', () => {
  assert.strictEqual(Z.zoneEnglishName({ name_en: 'Mine', match_city: '苏州市' }), 'Mine');
  assert.strictEqual(Z.zoneEnglishName({ name_en: '  ', match_city: '苏州市' }), 'Suzhou');
  assert.strictEqual(Z.zoneEnglishName({ match_city: '江苏省' }), 'Jiangsu');
  assert.strictEqual(Z.zoneEnglishName({ match_city: '广州市', match_district: '天河区' }), 'Tianhe', 'the district, before the city');
  assert.strictEqual(Z.zoneEnglishName({ match_city: '香港', match_district: '湾仔区' }), 'Wan Chai');
  assert.strictEqual(Z.zoneEnglishName({ match_city: '香港' }), 'Hong Kong');
  assert.strictEqual(Z.zoneEnglishName({ match_city: '不存在市' }), null);
});
it('province: Guangzhou districts their own group; Hong Kong; a city\'s province; a province itself; else Other', () => {
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'gz_district', match_city: '广州市', match_district: '天河区' }), { cn: '广州市', en: 'Guangzhou' });
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '香港', match_district: '湾仔区' }), { cn: '香港特别行政区', en: 'Hong Kong' });
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '香港' }), { cn: '香港特别行政区', en: 'Hong Kong' });
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '苏州市' }), { cn: '江苏省', en: 'Jiangsu' });
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '深圳市', match_district: '南山区' }), { cn: '广东省', en: 'Guangdong' },
    'a district on a mainland city row is not Hong Kong');
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '江苏省' }), { cn: '江苏省', en: 'Jiangsu' });
  assert.deepStrictEqual(Z.zoneProvince({ zone_type: 'city', match_city: '不存在市' }), { cn: '其他', en: 'Other' });
});

for (const step of pending) step();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
