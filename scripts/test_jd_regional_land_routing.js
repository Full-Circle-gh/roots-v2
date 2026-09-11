#!/usr/bin/env node
/**
 * Fujian / Guangxi ship JD land, not air, for "Air only" items.
 *
 * Every non-Guangdong destination used to bucket an "Air only" (fresh) item
 * into an air shipment (`bucketForItem` → 'air'), which forces JD's pricier
 * 生鲜特快 (LL-SD-M) service. JD's own printed 时效产品 confirms 生鲜标快
 * (LL-HD-M, fresh-ground) reaches next-day into Fujian and Guangxi too, so
 * routing those two provinces the same way Guangdong already is — a single
 * land shipment, no forced air lane — keeps the delivery promise at a lower
 * freight cost. `isJdLandNextDayProvince` (routes/retail.js) is the new
 * check; this suite pins what it does to `planShipments`'s output, and that
 * Guangdong and every other province are unaffected.
 *
 * THE REAL planShipments AND ITS HELPERS ARE UNDER TEST, extracted from
 * routes/retail.js exactly like the sibling suite
 * scripts/test_mirrored_channel_parcels.js does, so a stub could not hide a
 * regression here.
 *
 * MUTATIONS MUST PROVE THEY MUTATED (v4.27): the sabotage below asserts the
 * source actually changed before its red counts as evidence. No anchor
 * contains a newline — the tree is checked out CRLF.
 *
 * Offline. No network, no install, no production database.
 *   node scripts/test_jd_regional_land_routing.js
 *   JLR_SABOTAGE=revert node scripts/test_jd_regional_land_routing.js   (expect RED)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SABOTAGE = process.env.JLR_SABOTAGE || '';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling — the string-aware stripper the sibling suites use ──────
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const RETAIL = stripComments(RETAIL_SRC);

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  if (!m) throw new Error(`function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

const MUTATIONS = {
  // Revert planShipments to only special-case Guangdong — the pre-fix shape.
  // Every Fujian/Guangxi assertion below must go red; Guangdong must stay
  // green (proving the harness broke the right thing, not everything).
  revert: {
    why: 'drops the isJdLandNextDayProvince OR-clause from planShipments',
    find: /isGuangdong\(destProvince, destCity\) \|\| isJdLandNextDayProvince\(destProvince, destCity\)/,
    replace: 'isGuangdong(destProvince, destCity)',
  },
};

function planShipmentsSource() {
  let src = extractFunction(RETAIL, 'planShipments');
  if (!SABOTAGE) return src;
  const m = MUTATIONS[SABOTAGE];
  if (!m) throw new Error(`unknown JLR_SABOTAGE=${SABOTAGE}`);
  const before = src;
  src = src.replace(m.find, m.replace);
  assert.notStrictEqual(src, before,
    `SABOTAGE '${SABOTAGE}' (${m.find}) matched NOTHING — it changed no source, `
    + 'so every failure below would be meaningless');
  return src;
}

/**
 * The REAL planShipments, with its real helpers — isGuangzhou / isGuangdong /
 * isJdLandNextDayProvince / parseShipModes / bucketForItem all lifted from the
 * same file. `provinceForCity` is the one stub: it answers the province for a
 * city-only address (no explicit province string), backed by a tiny fixture
 * table rather than the real served-cities catalogue.
 */
function realPlanner(cityToProvince) {
  const parts = ['isGuangzhou', 'isGuangdong', 'isJdLandNextDayProvince', 'parseShipModes', 'bucketForItem']
    .map((n) => extractFunction(RETAIL, n)).join('\n');
  const planShipments = planShipmentsSource();
  return new Function('provinceForCity', 'inventory',
    `${parts}\n${planShipments}\nreturn planShipments;`)(
    (city) => (cityToProvince && cityToProvince[city]) || null,
    { isOptInSameDayDistrict: () => false });
}

const AIR_ONLY = { id: 1, ship_modes: 'air' };
const LAND_ONLY = { id: 2, ship_modes: 'land' };
const ANY_MODE = { id: 3, ship_modes: 'air,land' };

function main() {
  console.log(`\nJD regional land routing — Fujian / Guangxi (§jd-regional-delivery-optimization)\n`);

  const plan = realPlanner({ '厦门': '福建省', '南宁': '广西壮族自治区', '上海': '上海市' });

  // ── 1. The ruling itself ──────────────────────────────────────────────────
  for (const [label, province] of [['福建 (bare)', '福建'], ['福建省 (full, as stored)', '福建省'], ['fujian (English)', 'fujian']]) {
    it(`Fujian (${label}) with an Air-only item ships ONE land parcel, not air`, () => {
      const rows = plan([AIR_ONLY], 'F市', province, {});
      assert.strictEqual(rows.length, 1, 'Fujian split into more than one shipment');
      assert.strictEqual(rows[0].mode, 'land', 'Fujian did not fall back to land');
      assert.deepStrictEqual(rows[0].item_ids, [1], 'the air-only item was not on the land parcel');
    });
  }

  // 广西壮族自治区 is the string a REAL address carries (scripts/miniapp_import.json,
  // and miniapp checkout captures the full official name) — the bare '广西' below
  // never occurs in production. An equality-on-normalised test passed the bare form
  // while the real one fell through to air, so the full name is pinned here first.
  for (const [label, province] of [['广西壮族自治区 (full, as stored)', '广西壮族自治区'], ['广西 (bare)', '广西'], ['guangxi (English)', 'guangxi']]) {
    it(`Guangxi (${label}) with an Air-only item ships ONE land parcel, not air`, () => {
      const rows = plan([AIR_ONLY], 'G市', province, {});
      assert.strictEqual(rows.length, 1, 'Guangxi split into more than one shipment');
      assert.strictEqual(rows[0].mode, 'land', 'Guangxi did not fall back to land');
    });
  }

  it('a mixed Air-only + Land-only cart into Fujian is ONE land parcel, not split', () => {
    const rows = plan([AIR_ONLY, LAND_ONLY, ANY_MODE], 'F市', '福建', {});
    assert.strictEqual(rows.length, 1, 'Fujian still split air/land for a mixed cart');
    assert.strictEqual(rows[0].mode, 'land');
    assert.deepStrictEqual(rows[0].item_ids.sort(), [1, 2, 3], 'not every item rode the one parcel');
  });

  it('a city-only Fujian address (no province string) still resolves via provinceForCity', () => {
    const rows = plan([AIR_ONLY], '厦门', '', {});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mode, 'land', 'city-only Fujian address fell through to air/land split');
  });

  it('a city-only Guangxi address (no province string) still resolves via provinceForCity', () => {
    const rows = plan([AIR_ONLY], '南宁', '', {});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mode, 'land');
  });

  // ── 2. The control — every OTHER out-of-Guangdong province is unaffected ──
  it('an unrelated province (Shanghai) with an Air-only item still ships AIR', () => {
    const rows = plan([AIR_ONLY], '上海', '上海', {});
    assert.strictEqual(rows.length, 1, 'Shanghai unexpectedly split into multiple shipments');
    assert.strictEqual(rows[0].mode, 'air', 'Shanghai stopped shipping an air-only item by air');
  });

  it('an unrelated province (Shanghai) with a mixed cart still splits air/land', () => {
    const rows = plan([AIR_ONLY, LAND_ONLY], '上海', '上海', {});
    assert.strictEqual(rows.length, 2, 'Shanghai stopped splitting a mixed cart');
    const byMode = Object.fromEntries(rows.map(r => [r.mode, r.item_ids]));
    assert.deepStrictEqual(byMode.air, [1]);
    assert.deepStrictEqual(byMode.land, [2]);
  });

  // ── 3. Guangdong is untouched by the added OR-clause ──────────────────────
  it('Guangdong still ships ONE land parcel regardless of item flags (unchanged)', () => {
    const rows = plan([AIR_ONLY, LAND_ONLY], 'G市', '广东', {});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mode, 'land');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
