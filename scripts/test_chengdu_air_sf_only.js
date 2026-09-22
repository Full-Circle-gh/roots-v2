#!/usr/bin/env node
/**
 * AIR INTO CHENGDU CAN ONLY BE BOUGHT FROM SF EXPRESS (§218).
 *
 * WHAT THIS IS ABOUT, and it is the same distinction test_jd_waybill_land_default.js
 * opens with because the same mistake is available here: this is a WAYBILL rule.
 * It decides who the label is bought from. It does NOT touch planShipments,
 * bucketForItem, or anything that decides how an order splits into parcels — a
 * Chengdu parcel whose mode is 'air' STAYS 'air' and keeps the plan the system
 * made for it. What changes is that the operator is told, twice, that the label
 * has to come from SF rather than JD.
 *
 * THE RULE: Roots' air lane into Chengdu is SF's. SF has no API here, so the
 * operator books it on SF's own system and pastes the number back onto the
 * order — which works because `sf` (顺丰速运) has been in lib/tracking.js's
 * carrier registry since it was written.
 *
 * CHENGDU CITY, NOT SICHUAN. Ash was asked and answered: "only chengdu". Part 2
 * exists to make a later session that widens it to 四川省 go red rather than
 * quietly ship a bigger rule than the one that was agreed.
 *
 * A WARNING, NOT A BLOCK. Nothing refuses a JD air waybill for Chengdu. Part 5
 * pins that, because a "fix" that hard-blocks it would be a different decision
 * than the one Ash made ("message plus are you sure").
 *
 * NO CLIENT COPY OF THE CITY LIST, and Part 4 is where that is enforced. The
 * province rule needs a whole drift assertion because it is written twice; this
 * one is computed once on the server and sent as a flag, so the correct
 * assertion is the opposite one — that the browser has NO city list to drift.
 *
 * THE REAL lib/jd.js IS REQUIRED, not stubbed.
 *
 * Offline. No network, no install, no production database.
 *   node scripts/test_chengdu_air_sf_only.js
 *   CSA_SABOTAGE=province node scripts/test_chengdu_air_sf_only.js   (expect RED)
 *   CSA_SABOTAGE=equality node scripts/test_chengdu_air_sf_only.js   (expect RED)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const jd = require(path.join(ROOT, 'lib', 'jd.js'));
const CLIENT_SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const VOCAB = fs.readFileSync(
  path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
const SABOTAGE = process.env.CSA_SABOTAGE || '';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The predicate, under sabotage where asked ───────────────────────────────
// 'province' widens the rule to the whole of Sichuan — the change a later
// session is most likely to make on the reasoning that an airport serves a
// province. Part 2 must go red and Part 1 must stay green, which is what makes
// it a real mutation rather than a switch that breaks everything.
//
// 'equality' rebuilds the predicate as an equality test on the bare name, the
// way the first attempt at the province rule was written. 成都 survives it and
// 成都市 — the string a real address actually carries — does not.
function isSfOnlyAirCity(city) {
  if (SABOTAGE === 'province') {
    const c = String(city || '').trim();
    if (!c) return false;
    return ['成都', '四川'].some(x => c.startsWith(x))
      || ['chengdu', 'sichuan'].includes(c.toLowerCase().replace(/\s+/g, ''));
  }
  if (SABOTAGE === 'equality') {
    const c = String(city || '').trim();
    return c === '成都' || c.toLowerCase() === 'chengdu';
  }
  if (SABOTAGE) throw new Error(`unknown CSA_SABOTAGE=${SABOTAGE}`);
  return jd.isSfOnlyAirCity(city);
}

// The string a REAL address carries. routes/retail.js's own address normaliser
// adds the 市 suffix, and miniapp/pages/checkout captures the full official
// name — a bare '成都' is the convenience form, not production data.
const CHENGDU_STORED = '成都市';

// The server clause, extracted once so every assertion about it reads the same
// text the route actually runs.
function sfClause() {
  const at = RETAIL_SRC.indexOf('o.sf_only_air =');
  assert.notStrictEqual(at, -1, 'the order GET no longer computes o.sf_only_air');
  return RETAIL_SRC.slice(at, RETAIL_SRC.indexOf(';', at) + 1);
}

// One whole function, top to its closing brace at column 0 — not a fixed
// character count, which silently truncates the moment the function grows and
// turns every assertion past the cut into a false failure.
function clientFn(name) {
  const i = CLIENT_SRC.indexOf(name);
  assert.notStrictEqual(i, -1, `${name} is gone from 04-orders.js`);
  const j = CLIENT_SRC.indexOf('\n}\n', i);
  assert.notStrictEqual(j, -1, `${name} has no closing brace`);
  return CLIENT_SRC.slice(i, j);
}

function main() {
  console.log('\nChengdu air ships with SF Express only (§218)\n');

  // ── 1. The ruling, against the strings production actually stores ─────────
  for (const [label, city] of [
    ['成都市 (as stored)', CHENGDU_STORED],
    ['成都 (bare)', '成都'],
    ['Chengdu (English)', 'Chengdu'],
    ['chengdu (lower case)', 'chengdu'],
    [' chengdu  (padded)', ' chengdu  '],
  ]) {
    it(`${label} is an SF-only air city`, () => {
      assert.strictEqual(isSfOnlyAirCity(city), true);
    });
  }

  // ── 2. CHENGDU CITY, NOT SICHUAN — Ash's answer, pinned ──────────────────
  // "only chengdu", asked and answered 2026-09-22. A session that widens this
  // to the province is making a decision that is not its to make.
  for (const [label, city] of [
    ['四川省 (the province)', '四川省'],
    ['四川 (bare province)', '四川'],
    ['sichuan (English province)', 'sichuan'],
    ['绵阳市 (another Sichuan city)', '绵阳市'],
    ['成华区 (a Chengdu DISTRICT, not the city field)', '成华区'],
  ]) {
    it(`${label} is NOT an SF-only air city`, () => {
      assert.strictEqual(isSfOnlyAirCity(city), false);
    });
  }

  it('the city list is exactly 成都 and nothing else', () => {
    assert.deepStrictEqual(jd.SF_ONLY_AIR_CITIES, ['成都'],
      'the SF-only city list has grown — that is Ash\'s decision, not a session\'s');
  });

  // ── 3. Everywhere else, and the empty case ───────────────────────────────
  for (const city of ['广州市', '上海市', '北京市', '杭州市', '', null, undefined]) {
    it(`${city || '(no city)'} is untouched`, () => {
      assert.strictEqual(isSfOnlyAirCity(city), false);
    });
  }

  // ── 4. The server computes it, with all three conditions ─────────────────
  const clause = sfClause();

  it('the flag is gated on the ROOTS tenant', () => {
    assert.ok(/currentTenantId\(\)\s*===\s*ROOTS_TENANT_ID/.test(clause),
      'o.sf_only_air is not tenant-gated — every tenant on the platform would be '
      + 'told to use a courier they have no account with');
  });

  it('the flag asks lib/jd.js rather than testing the city itself', () => {
    assert.ok(/jd\.isSfOnlyAirCity\(/.test(clause),
      'the route hand-writes its own city test instead of calling lib/jd.js');
    assert.ok(!/成都/.test(clause),
      'the route carries the city string itself — that is a second copy of the rule');
  });

  it('the flag reads BOTH city and city_en', () => {
    assert.ok(/a\.city\b/.test(clause) && /a\.city_en\b/.test(clause),
      'only one of city / city_en is consulted, so an address that filled in the '
      + 'other reads as not-Chengdu');
  });

  it('the flag requires the order to actually HAVE an air parcel', () => {
    assert.ok(/shipments[\s\S]{0,60}mode\s*===\s*'air'/.test(clause),
      'a Chengdu order shipping entirely by road would be warned about a click '
      + 'that is not available on it');
  });

  it('the flag is computed AFTER the shipments are built', () => {
    const shipAt = RETAIL_SRC.indexOf('o.shipment_suggestion =');
    const sfAt   = RETAIL_SRC.indexOf('o.sf_only_air =');
    assert.ok(shipAt !== -1 && sfAt > shipAt,
      'o.sf_only_air is computed before o.shipments exists, so the air test is '
      + 'always false');
  });

  // ── 5. A WARNING, NOT A BLOCK ────────────────────────────────────────────
  // Ash asked for "message plus are you sure". A server-side refusal would be a
  // bigger rule than the one agreed, and would strand the operator on the day
  // SF cannot take the parcel.
  it('the JD waybill route does not refuse a Chengdu air label', () => {
    const at = RETAIL_SRC.indexOf("router.post('/api/retail-admin/orders/:id/jd-waybill'");
    assert.notStrictEqual(at, -1, 'the JD waybill route is gone');
    const body = RETAIL_SRC.slice(at, RETAIL_SRC.indexOf('\n});', at));
    assert.ok(!/isSfOnlyAirCity|sf_only_air/.test(body),
      'the waybill route now blocks or branches on the SF rule — this was asked '
      + 'for as a warning the operator can overrule, not a lock');
  });

  // ── 6. The browser holds NO city list of its own ─────────────────────────
  // The inverse of the province rule's drift assertion, and deliberately so: a
  // rule computed once and sent as a flag cannot drift, and the way to keep it
  // that way is to fail the moment a second copy appears.
  it('04-orders.js carries no copy of the city list', () => {
    assert.ok(!/SF_ONLY_AIR_CITIES/.test(CLIENT_SRC),
      'the client has grown its own copy of the city list — one rule, one home');
    assert.ok(!/isSfOnlyAirCity/.test(CLIENT_SRC),
      'the client has grown its own copy of the predicate — it should read the '
      + 'server\'s o.sf_only_air flag instead');
  });

  it('the client reads the server flag', () => {
    assert.ok(/sf_only_air/.test(CLIENT_SRC),
      '04-orders.js never reads o.sf_only_air, so nothing is shown at all');
  });

  // ── 7. The banner, on the air parcel and only there ─────────────────────
  const card = clientFn('function renderShipmentTrackingCard');

  it('the banner is narrowed from the order to the AIR parcel', () => {
    assert.ok(/const sfOnlyAir = !!\(o\.sf_only_air && s\.mode === 'air'\)/.test(card),
      'the card does not narrow the order-level flag to this parcel — the land '
      + 'parcel beside it would carry an air warning');
  });

  it('the banner names SF Express in both languages', () => {
    const i = CLIENT_SRC.indexOf('const sfBanner');
    assert.notStrictEqual(i, -1, 'sfBanner is gone');
    const banner = CLIENT_SRC.slice(i, i + 1200);
    assert.ok(/SF Express/.test(banner), 'the English half does not name SF Express');
    assert.ok(/顺丰速运/.test(banner), 'the Chinese half does not name 顺丰速运');
    assert.ok(/cuT\(/.test(banner), 'the banner is not bilingual through cuT()');
  });

  it('the banner is mounted in the card', () => {
    assert.ok(/\$\{sfBanner\}/.test(CLIENT_SRC),
      'sfBanner is built and never rendered');
  });

  // ── 8. The manual-entry dropdown opens on SF ─────────────────────────────
  it('the carrier dropdown pre-selects sf for such a parcel', () => {
    assert.ok(/has \? t\.carrier_code : \(sfOnlyAir \? 'sf' : 'jd'\)/.test(card),
      'the dropdown still opens on JD for a parcel only SF can carry');
  });

  it('an existing waybill still shows its OWN carrier', () => {
    assert.ok(/has \? t\.carrier_code :/.test(card),
      'the pre-selection now overrides the carrier a saved waybill was filed '
      + 'under, which is a fact about the parcel and not a suggestion');
  });

  // ── 9. The question, at the moment the JD air label is sent ─────────────
  const dlg = clientFn('function createJdLabel');

  it('the dialog reads the flag off the open order', () => {
    assert.ok(/const sfOnlyAir = !!\(ord && ord\.sf_only_air\)/.test(dlg),
      'createJdLabel no longer knows whether this order is an SF-only air city');
  });

  it('the question fires on the AIR product only', () => {
    assert.ok(/sfOnlyAir && product === 'LL-SD-M'/.test(dlg),
      'the question does not key on the JD air product (LL-SD-M) — either it '
      + 'never fires, or it fires on a ground label nobody needs to confirm');
  });

  it('declining the question sends nothing', () => {
    assert.ok(/if \(!go\) return;/.test(dlg),
      'the handler carries on after a declined confirm and creates the label anyway');
  });

  it('the question is asked BEFORE submitJdLabel, not after', () => {
    const q = dlg.indexOf("sfOnlyAir && product === 'LL-SD-M'");
    const s = dlg.indexOf('await submitJdLabel(');
    assert.ok(q !== -1 && s !== -1 && q < s,
      'the waybill is created before the operator is asked about it');
  });

  it('the submit button is captured before the first await', () => {
    // askConfirm yields, and currentTarget is nulled the moment a handler does.
    // Passing e.currentTarget to submitJdLabel after the confirm would silently
    // stop the button showing its busy state.
    assert.ok(/const btn = e\.currentTarget;/.test(dlg),
      'the button reference is not captured up front');
    assert.ok(/submitJdLabel\(orderId, shipmentId, product, btn, pieces\)/.test(dlg),
      'submitJdLabel is still handed e.currentTarget across an await');
  });

  it('the wording is bilingual and reuses the live air-waybill phrasing', () => {
    assert.ok(/仍要生成空运运单/.test(dlg),
      'the Chinese confirm no longer uses the live 仍要生成空运运单 phrasing');
    assert.ok(/顺丰速运/.test(dlg), 'the Chinese question does not name 顺丰速运');
    assert.ok(/SF Express only/.test(dlg), 'the English title does not name SF Express');
  });

  // ── 10. The parcel plan is untouched, same as the province rule ─────────
  it('the label dialog never rewrites the parcel mode', () => {
    assert.ok(!/\bmode\s*=[^=]/.test(dlg),
      'createJdLabel assigns to mode — the waybill must not change the parcel plan');
  });

  it('planShipments knows nothing about this rule', () => {
    const at = RETAIL_SRC.indexOf('function planShipments');
    const body = RETAIL_SRC.slice(at, RETAIL_SRC.indexOf('\n}', at));
    assert.ok(!/sf_only_air|isSfOnlyAirCity|成都/.test(body),
      'planShipments has been taught the SF rule — this is a waybill rule and '
      + 'must not change how an order splits into parcels');
  });

  // ── 11. The composed Chinese is declared ────────────────────────────────
  // CLAUDE.md: a composed string goes into the vocabulary doc in the same commit
  // as the code that uses it. An undeclared string is indistinguishable from a
  // locked one to everyone who comes after.
  for (const s of ['成都空运仅限顺丰速运', '仅顺丰速运']) {
    it(`${s} is declared in docs/tacet-delivery-vocabulary.md`, () => {
      assert.ok(VOCAB.includes(s),
        `${s} is used in the code and never declared — undeclared reads as locked`);
    });
  }

  it('the vocabulary entry cites §218', () => {
    assert.ok(/§218/.test(VOCAB), 'the vocabulary doc does not mention §218');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main();
