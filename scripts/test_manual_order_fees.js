#!/usr/bin/env node
/**
 * A hand-keyed order charges the same delivery and packing the customer pays.
 *
 *   node scripts/test_manual_order_fees.js
 *
 * No network, no keys, no server. `routes/retail.js` cannot be required (it
 * opens a real database at load), so the REAL fee functions are sliced out of
 * the file and executed against an in-memory database carrying the REAL
 * `retail_delivery_zones` definition out of database.js — the technique
 * scripts/test_migration_credit_ledger.js uses. Nothing here is a reimplementation:
 * a harness that rebuilt the fee rule would be testing a different program, and
 * "the manual route priced it differently" is the exact defect that motivated
 * this suite.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 * `POST /api/retail-admin/orders` priced NEITHER fee. `shipping_fee` was
 * whatever the operator had typed (the box defaults to 0) and `packing_fee` was
 * never computed, never posted, and not even a column in its INSERT. So the same
 * cart, to the same address, cost less by phone than in the app — and the packing
 * the shop does was never charged on a manual order at all.
 *
 * Compounding it: the delivery editor hard-wrote `packing_fee_per_item: 0` for
 * every Guangzhou district, so a shop that packs GZ orders (¥1.5/item) had
 * nowhere to record it and BOTH surfaces charged nothing.
 *
 * ── WHAT THIS LOCKS DOWN ──────────────────────────────────────────────────
 *   • one engine, two surfaces: manualOrderFees returns what
 *     computeDeliveryAndPacking — the customer checkout's own function —
 *     returns for the same cart and zone;
 *   • a Guangzhou district CAN carry a packing fee, per item and capped;
 *   • pickup charges the flat store-pickup packing fee and no delivery;
 *   • counter charges neither;
 *   • an address in no configured zone returns `error` and NOT a fee of zero —
 *     it must not refuse staff, and it must not invent a free delivery either.
 *
 * TO PROVE THE SUITE CAN FAIL:  MOF_MUTANT=1 node scripts/test_manual_order_fees.js
 * The mutant restores the pre-fix behaviour — manualOrderFees answering zero for
 * everything — and the suite must go RED. Per decisions §24 the mutation
 * ASSERTS IT MODIFIED THE SOURCE before its red counts as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { openTablesDb, driver } = require('./test-support/memory-db');

const MUTANT = process.env.MOF_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const DB_SRC = read('database.js');
const RETAIL_SRC = read('routes/retail.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The real functions, lifted ────────────────────────────────────────────
// Whole-function slices by brace depth from the declaration, so a body that
// contains a nested `}` at column 0 inside a template literal can't truncate it.
// A DESTRUCTURED PARAMETER OPENS A BRACE BEFORE THE BODY DOES —
// `function manualOrderFees({ fulfillmentType, … })` — so the parameter list is
// walked to its closing paren FIRST. Taking the first `{` after the name grabs
// the destructuring instead, "closes" at `})`, and hands back a signature with
// no body: the same trap scripts/test_point_search.js records.
function grab(name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(RETAIL_SRC);
  assert.ok(m, `function ${name} not found in routes/retail.js`);
  let i = RETAIL_SRC.indexOf('(', m.index), depth = 0;
  for (; i < RETAIL_SRC.length; i++) {
    if (RETAIL_SRC[i] === '(') depth++;
    else if (RETAIL_SRC[i] === ')') { depth--; if (depth === 0) break; }
  }
  assert.strictEqual(depth, 0, `unterminated parameter list for ${name}`);
  i = RETAIL_SRC.indexOf('{', i);
  depth = 0;
  for (; i < RETAIL_SRC.length; i++) {
    const c = RETAIL_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  assert.strictEqual(depth, 0, `unterminated ${name}`);
  return RETAIL_SRC.slice(m.index, i + 1);
}

// The province tables normalizeChinaAddress reads, lifted by the same rule:
// hand-copying a list of 34 provinces into a test is how a fixture goes stale.
function grabConst(name) {
  const m = new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm').exec(RETAIL_SRC);
  assert.ok(m, `const ${name} not found in routes/retail.js`);
  return m[0];
}

const LIFTED = [
  'normalizeAreaName', 'isGuangzhou', 'provinceForCity', 'cfgValue',
  'defaultDeliveryZone', 'matchDeliveryZone', 'weightDeliveryFee',
  'computeDeliveryAndPacking', 'parseWeightToGrams', 'normalizeChinaAddress',
  'manualOrderFees',
];
let SRC = ['CN_PROVINCES', 'CN_PROVINCE_STEMS'].map(grabConst).concat(LIFTED.map(grab)).join('\n\n');

if (MUTANT) {
  // Restore the defect: manualOrderFees answers zero for every order, which is
  // precisely what the manual route did before it called this at all.
  const real = grab('manualOrderFees');
  assert.ok(SRC.includes(real), 'mutation anchor not found — a red run would prove nothing');
  const mutated = SRC.replace(real,
    'function manualOrderFees() { return { shippingFee: 0, packingFee: 0, freeShipping: false, zone: null }; }');
  assert.notStrictEqual(mutated, SRC, 'the mutant source is identical to the real source');
  // Anchored on the zone LOOKUP, which only manualOrderFees does. Checking for
  // `computeDeliveryAndPacking(zone,` matched that function's own declaration —
  // a guard that can never fire is not a guard.
  assert.ok(!mutated.includes('matchDeliveryZone(normalizeChinaAddress('),
            'the mutant still looks the zone up — the replacement did not take');
  SRC = mutated;
}

// ── Fixture ───────────────────────────────────────────────────────────────
const db = openTablesDb(DB_SRC, ['retail_delivery_zones', 'storefront_config']);

const sandbox = {
  console,
  tdb: () => db,
  /* THE `db` MODULE, NOT THE HANDLE — and deliberately carrying one property.
     computeDeliveryAndPacking reads db.FREE_SHIPPING_THRESHOLD_DEFAULT, the
     shipped default behind `fees.freeShippingThreshold`. In routes/retail.js
     `db` is the database MODULE, which is a handle and a bag of constants at
     once; this sandbox only ever provided the handle, through tdb(), so the
     lifted function threw "db is not defined" and two cases failed with that
     instead of a fee.

     Read out of database.js rather than typed, so a change to the shipped
     default cannot leave this test asserting against a number the product no
     longer uses. Only the constant is exposed: a lifted function that starts
     calling db.prepare() should fail loudly here rather than quietly query a
     handle nobody chose for it. */
  db: {
    FREE_SHIPPING_THRESHOLD_DEFAULT: (() => {
      const m = /^const FREE_SHIPPING_THRESHOLD_DEFAULT = (\d+);/m.exec(DB_SRC);
      assert.ok(m, 'FREE_SHIPPING_THRESHOLD_DEFAULT not found in database.js');
      return Number(m[1]);
    })(),
  },
  phoneCn: require(path.join(ROOT, 'lib', 'phone-cn')),
  CHINA_REGIONS: require(path.join(ROOT, 'reference', 'china_regions.json')),
  _cityProvinceMap: null,
};
vm.createContext(sandbox);
vm.runInContext(SRC + '\nthis.manualOrderFees = manualOrderFees;'
                    + '\nthis.computeDeliveryAndPacking = computeDeliveryAndPacking;'
                    + '\nthis.matchDeliveryZone = matchDeliveryZone;', sandbox);
const { manualOrderFees, computeDeliveryAndPacking, matchDeliveryZone } = sandbox;

const setCfg = (key, value) =>
  db.prepare('INSERT INTO storefront_config (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));

const addZone = (z) => db.prepare(
  `INSERT INTO retail_delivery_zones
     (zone_type, match_city, match_district, name_en, name_cn, base_fee, free_threshold,
      max_fee, packing_fee_per_item, packing_fee_cap, is_active)
   VALUES (@zone_type, @match_city, @match_district, @name_en, @name_cn, @base_fee, @free_threshold,
           @max_fee, @packing_fee_per_item, @packing_fee_cap, 1)`
).run({
  zone_type: 'gz_district', match_city: null, match_district: null,
  name_en: null, name_cn: null, base_fee: 0, free_threshold: null, max_fee: null,
  packing_fee_per_item: 0, packing_fee_cap: null, ...z,
});

// Tianhe, with the packing fee this shop actually charges: ¥1.5 per item.
addZone({ zone_type: 'gz_district', match_district: '天河区', name_en: 'Tianhe', name_cn: '天河区',
          base_fee: 15, free_threshold: 199, packing_fee_per_item: 1.5, packing_fee_cap: 20 });
// A district that packs nothing, so "GZ can pack" isn't read as "GZ always packs".
addZone({ zone_type: 'gz_district', match_district: '越秀区', name_en: 'Yuexiu', name_cn: '越秀区',
          base_fee: 15, free_threshold: 199 });
// A non-Guangzhou city zone — packing has always worked here; it must still.
addZone({ zone_type: 'city', match_city: '深圳', name_en: 'Shenzhen', name_cn: '深圳',
          base_fee: 25, free_threshold: null, packing_fee_per_item: 2, packing_fee_cap: 6 });

setCfg('fees.pickupPackingFee', 3);
setCfg('fees.freeShippingThreshold', 199);

const TIANHE  = { province: '广东省', city: '广州市', district: '天河区', address: '天河路 1 号' };
const YUEXIU  = { province: '广东省', city: '广州市', district: '越秀区', address: '中山五路 1 号' };
const SHENZHEN = { province: '广东省', city: '深圳市', district: '南山区', address: '科技园 1 号' };
const NOWHERE = { province: '西藏自治区', city: '拉萨市', district: '城关区', address: '某路 1 号' };

// One cart shape reused: `qty` items, ¥`subtotal` total, no usable weight.
const cart = (qty) => Array.from({ length: qty }, () => ({ size: null, qty: 1 }));
const fees = (over = {}) => manualOrderFees({
  fulfillmentType: 'delivery', address: TIANHE, subtotal: 100, totalQty: 2,
  lines: cart(2), deliveryMode: 'standard', ...over,
});

console.log(`\nmanual order fees — driver: ${driver}${MUTANT ? '  [MUTANT]' : ''}\n`);

console.log('a Guangzhou delivery packs, and is charged for it');
it('Tianhe charges ¥1.5 per item — the fee that had nowhere to be stored', () => {
  assert.strictEqual(fees().packingFee, 3);          // 2 items × ¥1.5
});
it('the per-item fee scales with quantity', () => {
  assert.strictEqual(fees({ totalQty: 6, lines: cart(6) }).packingFee, 9);
});
it('the cap holds — 20 items is ¥20, not ¥30', () => {
  assert.strictEqual(fees({ totalQty: 20, lines: cart(20) }).packingFee, 20);
});
it('a district with no packing fee still charges none', () => {
  assert.strictEqual(fees({ address: YUEXIU }).packingFee, 0);
});
it('packing is charged even when delivery is free', () => {
  // ¥250 clears Tianhe's ¥199 free-over. The box is still packed.
  const f = fees({ subtotal: 250 });
  assert.strictEqual(f.shippingFee, 0);
  assert.strictEqual(f.packingFee, 3);
});

console.log('\none engine — the manual quote IS the customer quote');
it('manualOrderFees returns computeDeliveryAndPacking, cent for cent', () => {
  for (const [addr, qty, sub] of [[TIANHE, 2, 100], [TIANHE, 9, 40], [SHENZHEN, 3, 500], [YUEXIU, 1, 10]]) {
    const zone = matchDeliveryZone(addr);
    const direct = computeDeliveryAndPacking(zone, sub, 'standard', qty, 0);
    const mine = manualOrderFees({ fulfillmentType: 'delivery', address: addr, subtotal: sub,
                                   totalQty: qty, lines: cart(qty), deliveryMode: 'standard' });
    assert.strictEqual(mine.shippingFee, direct.deliveryFee, `shipping for ${addr.district} ×${qty}`);
    assert.strictEqual(mine.packingFee, direct.packingFee, `packing for ${addr.district} ×${qty}`);
  }
});
it('a non-Guangzhou city zone is unaffected by the change', () => {
  const f = fees({ address: SHENZHEN, totalQty: 2, lines: cart(2) });
  assert.strictEqual(f.shippingFee, 25);
  assert.strictEqual(f.packingFee, 4);              // 2 × ¥2, under the ¥6 cap
});

console.log('\nthe other two fulfilments');
it('pickup charges the flat store-pickup packing fee and no delivery', () => {
  const f = manualOrderFees({ fulfillmentType: 'pickup', address: null, subtotal: 100, totalQty: 4, lines: cart(4) });
  assert.strictEqual(f.packingFee, 3);              // flat, NOT per item
  assert.strictEqual(f.shippingFee, 0);
});
it('a counter sale charges neither — nothing to ship, nothing to box', () => {
  const f = manualOrderFees({ fulfillmentType: 'counter', address: null, subtotal: 100, totalQty: 4, lines: cart(4) });
  assert.deepStrictEqual([f.shippingFee, f.packingFee], [0, 0]);
});

console.log('\nan unconfigured address says so — it does not quote zero');
it('no matching zone returns an error, not a free delivery', () => {
  const f = fees({ address: NOWHERE });
  assert.strictEqual(f.error, 'no_zone_match');
});
it('the error still carries zeros, so a careless read cannot charge a stray fee', () => {
  const f = fees({ address: NOWHERE });
  assert.deepStrictEqual([f.shippingFee, f.packingFee], [0, 0]);
});

console.log('\nthe wiring the fee engine cannot prove on its own');
it('the create route puts packing in the total and in the INSERT', () => {
  assert.ok(/let total = Math\.round\(\(subtotal \+ shippingFee \+ packingFee\)/.test(RETAIL_SRC),
            'the manual order total does not add packingFee');
  const insert = RETAIL_SRC.slice(RETAIL_SRC.indexOf('customer_note, staff_note, channel, channel_note, source, created_by') - 400);
  assert.ok(/subtotal, shipping_fee, packing_fee, total,/.test(insert.slice(0, 600)),
            'packing_fee is not a column of the manual order INSERT');
});
it('the delivery editor no longer wipes a Guangzhou packing fee', () => {
  const DLV = read('public/retail-admin/06-delivery.js');
  assert.ok(!/packing_fee_per_item:\s*isGz\s*\?/.test(DLV),
            'saveZoneDrawer still forces packing_fee_per_item to 0 for GZ zones');
  assert.ok(!/packing_fee_cap:\s*isGz\s*\?/.test(DLV),
            'saveZoneDrawer still forces packing_fee_cap to NULL for GZ zones');
});
it('the packing fields are no longer hidden from Guangzhou zones', () => {
  const HTML = read('public/retail-admin.html');
  const field = HTML.slice(HTML.indexOf('id="dz-city-pack"') - 300, HTML.indexOf('id="dz-city-pack"'));
  assert.ok(!/dz-only-city/.test(field), 'the packing field is still marked city-only');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (MUTANT) {
  if (fail === 0) {
    console.log('MUTANT RAN GREEN — the suite does not detect the defect it exists to catch.');
    process.exit(1);
  }
  console.log('MUTANT RED, as required.');
  process.exit(0);
}
process.exit(fail ? 1 : 0);
