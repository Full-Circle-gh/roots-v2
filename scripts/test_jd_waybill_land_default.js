#!/usr/bin/env node
/**
 * The JD WAYBILL defaults to ground for Fujian / Guangxi.
 *
 * WHAT THIS IS ABOUT, because a previous attempt got it wrong and shipped:
 * this is a WAYBILL setting. It decides which JD 时效产品 code a label is
 * booked on. It does NOT touch planShipments, bucketForItem, or anything that
 * decides how an order is split into parcels — a parcel whose mode is 'air'
 * STAYS 'air' and keeps riding whatever plan the system made for it. The only
 * thing that changes is the product printed on its waybill.
 *
 * The rule: 生鲜标快 (LL-HD-M, ground) is next-day into Fujian and Guangxi per
 * JD's printed 时效产品, so booking 生鲜特快 (LL-SD-M, air) there costs more and
 * arrives no sooner. Ground becomes the DEFAULT for those two provinces —
 * explicitly a default and not a lock, so the operator can still choose air.
 *
 * THE REAL lib/jd.js IS REQUIRED, not stubbed. The client-side copy of the
 * province list is read out of public/retail-admin/04-orders.js and asserted
 * EQUAL to the server's, because two hand-written copies of one rule is exactly
 * how a fix half-works — the pre-existing bug this file also guards against.
 *
 * Offline. No network, no install, no production database.
 *   node scripts/test_jd_waybill_land_default.js
 *   JWL_SABOTAGE=equality node scripts/test_jd_waybill_land_default.js   (expect RED)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const jd = require(path.join(ROOT, 'lib', 'jd.js'));
const CLIENT_SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const SABOTAGE = process.env.JWL_SABOTAGE || '';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The province predicate, under sabotage where asked ──────────────────────
// 'equality' rebuilds the predicate the way the FIRST attempt wrote it — an
// equality test against the bare name after a suffix strip. 福建省 survives
// that; 广西壮族自治区 does not. The Guangxi assertions below must go red and
// the Fujian ones must stay green, which is what makes this a real mutation
// rather than a switch that breaks everything.
function isLandDefaultProvince(p) {
  if (SABOTAGE === 'equality') {
    const norm = s => String(s || '').trim().toLowerCase().replace(/省$|市$|自治区$/g, '');
    const n = norm(p);
    return n === '福建' || n === 'fujian' || n === '广西' || n === 'guangxi';
  }
  if (SABOTAGE) throw new Error(`unknown JWL_SABOTAGE=${SABOTAGE}`);
  return jd.isLandDefaultProvince(p);
}
function defaultWaybillProduct(mode, province, isFresh) {
  if (SABOTAGE === 'equality') {
    if (mode === 'air') return isLandDefaultProvince(province) ? 'LL-HD-M' : 'LL-SD-M';
    return isFresh ? 'LL-HD-M' : 'ed-m-0001';
  }
  return jd.defaultWaybillProduct(mode, province, isFresh);
}

// The strings a REAL address carries. scripts/miniapp_import.json stores
// 广西壮族自治区, and miniapp/pages/checkout/checkout.js captures the full
// official name — the bare '广西' is a convenience form, not production data.
const FUJIAN_STORED  = '福建省';
const GUANGXI_STORED = '广西壮族自治区';

function main() {
  console.log('\nJD waybill — ground by default for Fujian / Guangxi\n');

  // ── 1. The ruling, against the strings production actually stores ─────────
  for (const [label, prov] of [
    ['福建省 (as stored)', FUJIAN_STORED],
    ['广西壮族自治区 (as stored)', GUANGXI_STORED],
    ['福建 (bare)', '福建'],
    ['广西 (bare)', '广西'],
    ['fujian (English)', 'fujian'],
    ['guangxi (English)', 'guangxi'],
  ]) {
    it(`an AIR parcel to ${label} books ground 生鲜标快 (LL-HD-M)`, () => {
      assert.strictEqual(defaultWaybillProduct('air', prov, false), 'LL-HD-M');
    });
  }

  // ── 2. Every other province is untouched ─────────────────────────────────
  for (const prov of ['广东省', '上海市', '北京市', '浙江省', '内蒙古自治区', '']) {
    it(`an AIR parcel to ${prov || '(no province)'} still books air 生鲜特快 (LL-SD-M)`, () => {
      assert.strictEqual(defaultWaybillProduct('air', prov, false), 'LL-SD-M');
    });
  }

  it('广东 is NOT caught by the 广西 prefix', () => {
    assert.strictEqual(isLandDefaultProvince('广东省'), false);
    assert.strictEqual(isLandDefaultProvince('广东'), false);
  });

  // ── 3. Non-air modes keep the exact product they had before ──────────────
  // These reproduce the old JD_DEFAULT_BY_MODE table the route used to carry,
  // so a regression here means the refactor changed something it should not.
  for (const prov of ['广东省', FUJIAN_STORED, GUANGXI_STORED, '上海市']) {
    it(`a LAND parcel to ${prov} still books ambient ground (ed-m-0001)`, () => {
      assert.strictEqual(defaultWaybillProduct('land', prov, false), 'ed-m-0001');
    });
    it(`a LOCAL parcel to ${prov} still books ambient ground (ed-m-0001)`, () => {
      assert.strictEqual(defaultWaybillProduct('local', prov, false), 'ed-m-0001');
    });
  }

  // ── 4. The server route applies it, and only as a DEFAULT ────────────────
  const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  const route = RETAIL.slice(RETAIL.indexOf("router.post('/api/retail-admin/orders/:id/jd-waybill'"));
  const routeBody = route.slice(0, route.indexOf('\n});'));

  it('the waybill route reads the province from address_json', () => {
    assert.ok(/address_json/.test(routeBody.split('const JD_ALLOWED')[0]),
      'the route no longer selects address_json, so it cannot know the province');
    assert.ok(/JSON\.parse\(o\.address_json[^)]*\)\.province/.test(routeBody),
      'the route does not parse a province out of address_json');
  });

  it('the waybill route defaults through jd.defaultWaybillProduct', () => {
    assert.ok(/jd\.defaultWaybillProduct\(/.test(routeBody),
      'the route hand-writes its own default table again instead of calling lib/jd.js');
  });

  it('an explicitly chosen product still wins — this is a default, not a lock', () => {
    // reqProduct is consulted BEFORE the default, so air stays reachable.
    const m = /const product = reqProduct[\s\S]{0,200}?;/.exec(routeBody);
    assert.ok(m, 'could not find the product resolution in the route');
    assert.ok(/^const product = reqProduct\s*\|\|/.test(m[0].trim()),
      'the route no longer lets an explicit product override the default');
  });

  it('the route no longer carries the old hard-coded air default', () => {
    assert.ok(!/JD_DEFAULT_BY_MODE/.test(routeBody),
      'the superseded JD_DEFAULT_BY_MODE table is still in the route');
  });

  // ── 5. Client and server must not drift ──────────────────────────────────
  it('the client province list is IDENTICAL to lib/jd.js', () => {
    const m = /const JD_LAND_DEFAULT_PROVINCES = \[([^\]]*)\]/.exec(CLIENT_SRC);
    assert.ok(m, 'JD_LAND_DEFAULT_PROVINCES not found in 04-orders.js');
    const client = m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepStrictEqual(client, jd.JD_LAND_DEFAULT_PROVINCES,
      `client ${JSON.stringify(client)} != server ${JSON.stringify(jd.JD_LAND_DEFAULT_PROVINCES)} `
      + '— two copies of one rule have drifted, which is how a fix half-works');
  });

  it('the client matches on PREFIX, so 广西壮族自治区 is caught there too', () => {
    assert.ok(/startsWith/.test(
      CLIENT_SRC.slice(CLIENT_SRC.indexOf('function jdIsLandDefaultProvince'),
                       CLIENT_SRC.indexOf('function jdIsLandDefaultProvince') + 400)),
      'the client predicate is not prefix-matching — 广西壮族自治区 will miss');
  });

  // THE WHOLE FUNCTION, not a fixed character count. This used to slice the
  // first 2400 characters, and on 2026-09-22 §218 added a comment block above
  // `preset` that pushed it out of the window — a green rule reported as a
  // broken one, which is the worse of the two failures. The closing brace at
  // column 0 is the real end and does not move when the body grows.
  const jdLabelBody = (() => {
    const i = CLIENT_SRC.indexOf('function createJdLabel');
    assert.notStrictEqual(i, -1, 'createJdLabel is gone from 04-orders.js');
    const j = CLIENT_SRC.indexOf('\n}\n', i);
    assert.notStrictEqual(j, -1, 'createJdLabel has no closing brace');
    return CLIENT_SRC.slice(i, j);
  })();

  it('the label dialog offers BOTH fresh services for these provinces', () => {
    const body = jdLabelBody;
    assert.ok(/landDefault\s*\?\s*'LL-HD-M'/.test(body),
      'ground is not pre-selected for the land-default provinces');
    assert.ok(/landDefault[\s\S]{0,200}LL-HD-M[\s\S]{0,80}LL-SD-M/.test(body),
      'the dialog does not offer air alongside ground — that would be a lock, not a default');
  });

  it('the parcel mode is never rewritten by the label dialog', () => {
    const body = jdLabelBody;
    assert.ok(!/\bmode\s*=[^=]/.test(body),
      'createJdLabel assigns to mode — the waybill must not change the parcel plan');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main();
