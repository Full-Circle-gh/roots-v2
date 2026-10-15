#!/usr/bin/env node
/**
 * test_delivery_fees.js — what a customer pays for delivery and packing, when
 * shipping is free, and whether delivery is offered at all.
 *
 *   node scripts/test_delivery_fees.js
 *
 * WHAT IT GUARDS. A mutation sweep of routes/retail.js (2026-10-15) broke the
 * delivery-fee code 18 ways and no suite noticed any of them:
 *
 *   • weightDeliveryFee — a 1.5 kg parcel charged as 3 kg; the extra-kg rate
 *     dropped;
 *   • computeDeliveryAndPacking — "0 = always free shipping" starting to charge;
 *     a zone's free-over waiving a weight fee it had not reached; the packing
 *     cap ignored;
 *   • freeShippingTargetFor — the "spend ¥X more for free delivery" prompt
 *     promising free delivery the cart can never get;
 *   • parseWeightToGrams — "1公斤" or "0g" read wrong, which feeds the weight fee;
 *   • deliveryIsAvailable — delivery hidden or offered wrongly.
 *
 * Every expected figure here is worked out by hand from the rule the code's own
 * comments state, not read back from the code.
 *
 * HOW. The real functions are lifted from the source (retailSource(), so they
 * are found in routes/retail.js or in lib/ after decisions §477 moves them) and
 * run with a stand-in settings reader and the real retail_delivery_zones table.
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

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}

// The shop's own default, read from database.js rather than restated.
const DEFAULT_FREE = Number(/^const FREE_SHIPPING_THRESHOLD_DEFAULT = (\d+(?:\.\d+)?);/m.exec(DB_SRC)[1]);

let CFG = {};
const cfgValue = (k, d) => (k in CFG ? CFG[k] : d);
let zonesDb = openTablesDb(DB_SRC, ['retail_delivery_zones']);
const NAMES = ['weightDeliveryFee', 'computeDeliveryAndPacking', 'freeShippingTargetFor', 'parseWeightToGrams', 'deliveryIsAvailable'];
const F = new Function('cfgValue', 'db', 'tdb', `${NAMES.map(fnSrc).join('\n')}\nreturn { ${NAMES.join(', ')} };`)(
  cfgValue, { FREE_SHIPPING_THRESHOLD_DEFAULT: DEFAULT_FREE }, () => zonesDb);

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(() => {
  CFG = {};
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;

// ══ 1. the weight fee ══════════════════════════════════════════════════════
section('1. weight pricing: the first kg, then each started kg after it');

const W = { first_kg_fee: 12, extra_kg_fee: 5 };
it('up to 1 kg is the first-kg fee; no weight known is the first-kg fee too', () => {
  for (const g of [1, 500, 1000, 0, undefined, null]) assert.strictEqual(F.weightDeliveryFee(W, g, 99), 12, String(g));
});
it('each started kg after the first adds one extra fee: 1.001 kg → 17, 1.5 → 17, 2 → 17, 2.001 → 22', () => {
  assert.strictEqual(F.weightDeliveryFee(W, 1001), 17);
  assert.strictEqual(F.weightDeliveryFee(W, 1500), 17, 'a 1.5 kg parcel is one extra kg, not three');
  assert.strictEqual(F.weightDeliveryFee(W, 2000), 17);
  assert.strictEqual(F.weightDeliveryFee(W, 2001), 22);
  assert.strictEqual(F.weightDeliveryFee(W, 4800), 32);
});
it('no extra-kg rate means the first-kg fee at any weight', () => {
  assert.strictEqual(F.weightDeliveryFee({ first_kg_fee: 12 }, 5000), 12);
});
it('rounded to the cent: ¥9.90 + 2 × ¥0.15 = ¥10.20', () => {
  assert.strictEqual(F.weightDeliveryFee({ first_kg_fee: 9.9, extra_kg_fee: 0.15 }, 2500), 10.2);
});
it('a rule with no usable first-kg fee: the flat fee passed in, or nothing', () => {
  assert.strictEqual(F.weightDeliveryFee({}, 2000, 8), 8);
  assert.strictEqual(F.weightDeliveryFee({ first_kg_fee: 'x' }, 2000, '6'), 6);
  assert.strictEqual(F.weightDeliveryFee({}, 2000), 0);
});

// ══ 2. delivery and packing fees ═══════════════════════════════════════════
section('2. the delivery and packing fee on a cart');

const fee = (zone, subtotal, mode = 'standard', qty = 0, grams = 0) =>
  F.computeDeliveryAndPacking(zone, subtotal, mode, qty, grams);
const FLAT = { zone_type: 'city', base_fee: 10, free_threshold: 100 };

it('no zone → refused, nothing charged', () => {
  assert.deepStrictEqual(fee(null, 50), { error: 'no_zone_match', deliveryFee: 0, packingFee: 0, freeShipping: false });
});
it('a zone\'s own free-over: ¥99.99 pays ¥10, ¥100 is free', () => {
  assert.deepStrictEqual(fee(FLAT, 99.99), { deliveryFee: 10, packingFee: 0, freeShipping: false });
  assert.deepStrictEqual(fee(FLAT, 100), { deliveryFee: 0, packingFee: 0, freeShipping: true });
});
it('a zone free-over of 0 means no free option, whatever is spent', () => {
  assert.strictEqual(fee({ ...FLAT, free_threshold: 0 }, 10000).deliveryFee, 10);
});
it('no zone free-over: the shop setting decides — ¥149 pays, ¥150 is free', () => {
  CFG = { 'fees.freeShippingThreshold': 150 };
  const z = { ...FLAT, free_threshold: null };
  assert.strictEqual(fee(z, 149).deliveryFee, 10);
  assert.strictEqual(fee(z, 150).deliveryFee, 0);
});
it('the shop setting at 0 means ALWAYS free, as its own help text says', () => {
  CFG = { 'fees.freeShippingThreshold': 0 };
  assert.deepStrictEqual(fee({ ...FLAT, free_threshold: null }, 1), { deliveryFee: 0, packingFee: 0, freeShipping: true });
});
it('no setting at all: the shop default from database.js', () => {
  const z = { ...FLAT, free_threshold: null };
  assert.strictEqual(fee(z, DEFAULT_FREE - 1).deliveryFee, 10);
  assert.strictEqual(fee(z, DEFAULT_FREE).deliveryFee, 0);
});
it('Guangzhou MAX: its own flat price, never shown as free, refused where not offered', () => {
  const gz = { zone_type: 'gz_district', base_fee: 10, max_fee: 25, free_threshold: 100 };
  assert.deepStrictEqual(fee(gz, 500, 'max'), { deliveryFee: 25, packingFee: 0, freeShipping: false });
  assert.strictEqual(fee({ ...gz, max_fee: null }, 500, 'max').error, 'max_not_offered');
  assert.strictEqual(fee({ ...FLAT, max_fee: 25 }, 50, 'max').deliveryFee, 10, 'MAX is a Guangzhou option only');
});
it('weight pricing (zone row columns): 1.5 kg on 12 + 5/kg is ¥17', () => {
  const z = { zone_type: 'city', base_fee: 12, free_threshold: null, weight_first_kg_fee: 12, weight_extra_kg_fee: 5 };
  assert.strictEqual(fee(z, 50, 'standard', 1, 1500).deliveryFee, 17);
});
it('weight pricing (default-zone object) works the same', () => {
  const z = { zone_type: 'city', base_fee: 12, free_threshold: null, weight: { first_kg_fee: 12, extra_kg_fee: 5 } };
  assert.strictEqual(fee(z, 50, 'standard', 1, 2500).deliveryFee, 22);
});
it('a zone\'s own free-over waives a weight fee once reached, and only then', () => {
  const z = { zone_type: 'city', base_fee: 12, free_threshold: 100, weight_first_kg_fee: 12, weight_extra_kg_fee: 5 };
  assert.strictEqual(fee(z, 120, 'standard', 1, 1500).deliveryFee, 0);
  assert.strictEqual(fee(z, 50, 'standard', 1, 1500).deliveryFee, 17, 'waived before the free-over was reached');
});
it('the shop-wide free setting never waives a weight fee (a courier rate stays charged)', () => {
  CFG = { 'fees.freeShippingThreshold': 0 };
  const z = { zone_type: 'city', base_fee: 12, free_threshold: null, weight_first_kg_fee: 12, weight_extra_kg_fee: 5 };
  assert.deepStrictEqual(fee(z, 1000, 'standard', 1, 1500), { deliveryFee: 17, packingFee: 0, freeShipping: false });
});
it('a weight rate whose first kg is free still prices by weight: 0 + 5/kg on 1.5 kg is ¥5', () => {
  const z = { zone_type: 'city', base_fee: 12, free_threshold: null, weight_first_kg_fee: 0, weight_extra_kg_fee: 5 };
  assert.strictEqual(fee(z, 50, 'standard', 1, 1500).deliveryFee, 5);
});
it('weight-priced: a zone free-over of 0 means no free option; exactly reaching it waives', () => {
  const z = { zone_type: 'city', base_fee: 12, weight_first_kg_fee: 12, weight_extra_kg_fee: 5 };
  assert.strictEqual(fee({ ...z, free_threshold: 0 }, 10000, 'standard', 1, 1500).deliveryFee, 17);
  assert.strictEqual(fee({ ...z, free_threshold: 100 }, 100, 'standard', 1, 1500).deliveryFee, 0);
});
it('the free badge: a Guangzhou zone in standard mode can be free; a MAX asked of a city zone too', () => {
  const gz = { zone_type: 'gz_district', base_fee: 10, max_fee: 25, free_threshold: 100 };
  assert.strictEqual(fee(gz, 150, 'standard').freeShipping, true);
  assert.strictEqual(fee(FLAT, 150, 'max').freeShipping, true, 'only Guangzhou MAX is never free');
});
it('packing: per item × items, held to the cap; no cap, no items or no rate as they read', () => {
  const p = (o, qty) => fee({ ...FLAT, ...o }, 0, 'standard', qty).packingFee;
  assert.strictEqual(p({ packing_fee_per_item: 2 }, 3), 6);
  assert.strictEqual(p({ packing_fee_per_item: 2, packing_fee_cap: 5 }, 3), 5);
  assert.strictEqual(p({ packing_fee_per_item: 2, packing_fee_cap: 10 }, 3), 6);
  assert.strictEqual(p({ packing_fee_per_item: 2 }, 0), 0);
  assert.strictEqual(p({ packing_fee_per_item: 0 }, 3), 0);
  assert.strictEqual(p({ packing_fee_per_item: 1.15 }, 3), 3.45);
});

// ══ 3. the free-shipping prompt ════════════════════════════════════════════
section('3. "spend ¥X more for free delivery": the amount, and whether it is true');

it('a zone free-over of ¥100 → ¥100, reachable', () => {
  assert.deepStrictEqual(F.freeShippingTargetFor(FLAT), { threshold: 100, reachable: true });
});
it('no zone free-over: the shop setting, reachable', () => {
  CFG = { 'fees.freeShippingThreshold': 150 };
  assert.deepStrictEqual(F.freeShippingTargetFor({ ...FLAT, free_threshold: null }), { threshold: 150, reachable: true });
});
it('a weight-priced zone the shop setting cannot waive → not reachable, so no promise', () => {
  CFG = { 'fees.freeShippingThreshold': 150 };
  const z = { zone_type: 'city', base_fee: 12, free_threshold: null, weight_first_kg_fee: 12, weight_extra_kg_fee: 5 };
  assert.deepStrictEqual(F.freeShippingTargetFor(z), { threshold: 150, reachable: false });
});
it('Guangzhou MAX is never free → not reachable', () => {
  const gz = { zone_type: 'gz_district', base_fee: 10, max_fee: 25, free_threshold: 100 };
  assert.deepStrictEqual(F.freeShippingTargetFor(gz, 'max'), { threshold: 100, reachable: false });
  assert.deepStrictEqual(F.freeShippingTargetFor({ ...gz, max_fee: null }, 'max'), { threshold: 100, reachable: false });
});
it('a zone free-over of 0 (no free option) → not reachable', () => {
  assert.deepStrictEqual(F.freeShippingTargetFor({ ...FLAT, free_threshold: 0 }), { threshold: 0, reachable: false });
});
it('no zone, or a setting that is not a number → no target', () => {
  assert.deepStrictEqual(F.freeShippingTargetFor(null), { threshold: null, reachable: false });
  CFG = { 'fees.freeShippingThreshold': 'lots' };
  assert.deepStrictEqual(F.freeShippingTargetFor({ ...FLAT, free_threshold: null }), { threshold: null, reachable: false });
});

// ══ 4. reading a weight ════════════════════════════════════════════════════
section('4. a product\'s weight text, read as grams');

it('grams and kilograms, in English or Chinese, any case, with or without a space', () => {
  const cases = { '500g': 500, ' 500G ': 500, '250 grams': 250, '1gram': 1, '1kg': 1000, '1.5 kg': 1500,
    '0.5kg': 500, '1.234KG': 1234, '2公斤': 2000, '1千克': 1000, '300克': 300, '1kg/袋': 1000 };
  for (const [s, g] of Object.entries(cases)) assert.strictEqual(F.parseWeightToGrams(s), g, s);
});
it('not a weight → null: no unit, zero, words, a unit run on into another word', () => {
  for (const s of ['5', '0g', '0kg', 'abc', '', null, undefined, '2kgs', '1kg装', 'g500']) {
    assert.strictEqual(F.parseWeightToGrams(s), null, String(s));
  }
});

// ══ 5. is delivery offered at all ══════════════════════════════════════════
section('5. delivery is offered when it is switched on, has a default zone, or has a zone');

it('switched on in settings → offered', () => {
  CFG = { 'delivery.enabled': true };
  assert.strictEqual(F.deliveryIsAvailable(), true);
});
it('a default zone that is enabled → offered; one that is not → not by itself', () => {
  CFG = { 'delivery.defaultZone': { enabled: true } };
  assert.strictEqual(F.deliveryIsAvailable(), true);
  CFG = { 'delivery.defaultZone': { enabled: false } };
  assert.strictEqual(F.deliveryIsAvailable(), false);
});
it('nothing switched on: offered only if an active zone exists', () => {
  assert.strictEqual(F.deliveryIsAvailable(), false);
  zonesDb.prepare("INSERT INTO retail_delivery_zones (name_en, zone_type, is_active) VALUES ('off', 'city', 0)").run();
  assert.strictEqual(F.deliveryIsAvailable(), false, 'a switched-off zone offers nothing');
  zonesDb.prepare("INSERT INTO retail_delivery_zones (name_en, zone_type, is_active) VALUES ('on', 'city', 1)").run();
  assert.strictEqual(F.deliveryIsAvailable(), true);
});
it('"enabled" means exactly true, not any truthy text', () => {
  zonesDb = openTablesDb(DB_SRC, ['retail_delivery_zones']);
  CFG = { 'delivery.enabled': 'false' };
  assert.strictEqual(F.deliveryIsAvailable(), false);
});
it('the zone table cannot be read → offered (it fails open, never hides delivery on an error)', () => {
  const real = zonesDb;
  zonesDb = { prepare() { throw new Error('no such table'); } };
  try { assert.strictEqual(F.deliveryIsAvailable(), true); } finally { zonesDb = real; }
});

for (const step of pending) step();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
