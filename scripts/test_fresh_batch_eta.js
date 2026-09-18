#!/usr/bin/env node
/**
 * §170 — THE WAIT GETS A DATE, AND THE SEVEN SURFACES SAY THE SAME ONE.
 *
 *   node scripts/test_fresh_batch_eta.js
 *
 * REPORTED BY ASH from the live mini app, 10:04 on a batch morning, reading
 * Shop from a SHENZHEN address: a sold-out Tabbouleh Bowl carrying NEXT BATCH
 * on the day the kitchen was cooking it. *"the word alone sounds like an
 * indefinite wait."*
 *
 * NOTHING WAS BROKEN, WHICH IS WHY THIS SUITE PINS A DECISION AND NOT A FIX.
 * The shelf was at zero, today genuinely was on the cadence, the hour was
 * before the 11:00 ready hour, and the address was outside Guangzhou — so
 * §108's silence (which belongs to the local run alone) correctly did not
 * fire. The label was honest. It was still the wrong thing to show, because a
 * customer decides whether to tap on the CARD and the date was three screens
 * away in the checkout notice.
 *
 * §108's FIRST HALF STANDS AND IS RE-PINNED HERE: the word describes the ITEM,
 * so a fresh meal not yet made is NEXT BATCH to everybody. Its SECOND half —
 * that a date "belongs in the checkout notice ... not in a pill, which cannot"
 * — is what §170 overturns. A suite that only proved "a date appears" would
 * pass on a change that dated the grid and left the PDP bare, which is the
 * §108 bug with new numbers, so the surfaces are counted here by name.
 *
 * THE TWO DATES ARE NOT THE SAME DATE, and that is the case most likely to be
 * broken by someone simplifying this later:
 *
 *   on the same-day local run → served the day the batch is MADE
 *   couriered                 → the day AFTER it
 *
 * THE CLIENT MUST NOT COMPUTE EITHER (§82). It is handed an integer and two
 * strings; a `new Date(ymd)` anywhere in the label path reads the handset's
 * zone back into an answer the server already settled, and there is a case
 * below that greps for exactly that.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const freshEta = require(path.join(ROOT, 'miniapp/utils/fresh-eta.js'));
const { freshArrivalLabel, withFreshArrival } = freshEta;

// A decorated row as decorateFreshBatch stamps it: the make day, the couriered
// arrival one day later, and the whole-day count to the make day.
const row = (inDays, makeYmd, shipYmd) => ({
  local_fresh_in_days: inDays,
  local_fresh_date: makeYmd,
  fresh_ship_date: shipYmd,
  is_batch_made: 1,
});

section('1 · THE TWO SHOPPERS GET TWO DATES FROM ONE ROW');
{
  const today = row(0, '2026-09-18', '2026-09-19');
  it('a couriered order on a batch morning arrives TOMORROW', () => {
    assert.strictEqual(freshArrivalLabel(today, false, 'en'), 'TOMORROW');
    assert.strictEqual(freshArrivalLabel(today, false, 'cn'), '明天');
  });
  it('…and the local run would be served TODAY — the transit day is the whole difference', () => {
    assert.strictEqual(freshArrivalLabel(today, true, 'en'), 'TODAY');
    assert.strictEqual(freshArrivalLabel(today, true, 'cn'), '今天');
  });

  const later = row(2, '2026-09-20', '2026-09-21');
  it('past two days the DATE is printed, not a count the shopper must work out', () => {
    assert.strictEqual(freshArrivalLabel(later, true, 'en'), 'SEP 20');
    assert.strictEqual(freshArrivalLabel(later, false, 'en'), 'SEP 21');
  });
  it('…and the Chinese form is the live `M月D日`, lifted from the checkout day picks', () => {
    assert.strictEqual(freshArrivalLabel(later, true, 'cn'), '9月20日');
    assert.strictEqual(freshArrivalLabel(later, false, 'cn'), '9月21日');
  });
  it('the courier reads one day off the SHIP date, never the make date + guesswork', () => {
    // A row whose ship date is NOT make+1 (a server that changed its mind) must
    // still print what the server sent — the client is not entitled to a view.
    const odd = row(2, '2026-09-20', '2026-09-25');
    assert.strictEqual(freshArrivalLabel(odd, false, 'en'), 'SEP 25');
  });
}

section('2 · A ROW THAT NAMES NO BATCH NAMES NO DATE');
{
  it('a grocery row (no fields stamped) returns the empty string', () => {
    assert.strictEqual(freshArrivalLabel({}, false, 'en'), '');
    assert.strictEqual(freshArrivalLabel({ local_fresh_in_days: null }, false, 'en'), '');
  });
  it('…and withFreshArrival leaves such a band exactly as §108 drew it', () => {
    assert.strictEqual(withFreshArrival('SHIPS SOON', {}, false, 'en'), 'SHIPS SOON');
    assert.strictEqual(withFreshArrival('现订现发', {}, false, 'cn'), '现订现发');
    assert.strictEqual(withFreshArrival('PRE-ORDER', { local_fresh_in_days: null }, false, 'en'), 'PRE-ORDER');
  });
  it('a malformed date is silence, never a half-printed one', () => {
    assert.strictEqual(freshArrivalLabel(row(2, 'not-a-date', 'not-a-date'), true, 'en'), '');
    assert.strictEqual(freshArrivalLabel(row(2, '2026-13-99', '2026-13-99'), true, 'en'), '');
  });
  it('null / undefined row does not throw', () => {
    assert.strictEqual(freshArrivalLabel(null, false, 'en'), '');
    assert.strictEqual(withFreshArrival('NEXT BATCH', null, false, 'en'), 'NEXT BATCH');
  });
}

section('3 · THE BAND IS §108\'s WORD PLUS THE DATE — THE WORD IS NOT REPLACED');
{
  const today = row(0, '2026-09-18', '2026-09-19');
  it('the English band keeps NEXT BATCH and appends', () => {
    assert.strictEqual(withFreshArrival('NEXT BATCH', today, false, 'en'), 'NEXT BATCH · TOMORROW');
  });
  it('the Chinese band keeps 下批现做 and appends', () => {
    assert.strictEqual(withFreshArrival('下批现做', today, false, 'cn'), '下批现做 · 明天');
  });
  it('the separator is the live ` · `, not a comma or a dash', () => {
    assert.ok(withFreshArrival('下批现做', today, false, 'cn').includes(' · '));
  });
}

section('4 · THE SERVER OWNS BOTH DATES (§82) — THE CLIENT READS NO CLOCK');
{
  const RETAIL = read('routes/retail.js');
  const block = RETAIL.slice(RETAIL.indexOf('function decorateFreshBatch(rows)'),
                             RETAIL.indexOf('function decorateFreshBatch(rows)') + 3000);
  it('decorateFreshBatch stamps fresh_ship_date and local_fresh_in_days', () => {
    assert.ok(/r\.fresh_ship_date\s*=/.test(block), 'fresh_ship_date must be stamped');
    assert.ok(/r\.local_fresh_in_days\s*=/.test(block), 'local_fresh_in_days must be stamped');
  });
  it('…both null wherever local_fresh_date is, so a grocery row carries neither', () => {
    assert.ok(/r\.fresh_ship_date\s*=\s*r\.local_fresh_date\s*\?/.test(block));
    assert.ok(/r\.local_fresh_in_days\s*=\s*r\.local_fresh_date\s*\?/.test(block));
  });
  it('the day count is measured between MIDDAY anchors, so DST cannot round it wrong', () => {
    assert.ok(/parseYmdLocal\(d, tz\)/.test(block) && /parseYmdLocal\(todayIso, tz\)/.test(block),
      'parseYmdLocal pins 12:00 — raw Date maths across a DST boundary is the bug this stops');
  });
  it('the ship date is the make day + one whole day in the TENANT\'s zone', () => {
    assert.ok(/toYmdLocal\(new Date\(parseYmdLocal\(d, tz\)\.getTime\(\) \+ 86400000\), tz\)/.test(block));
  });

  // The one grep that matters on the client: a phone must never parse a date.
  // COMMENTS ARE STRIPPED FIRST and that is not a loosening — the helper's own
  // comment warns against `new Date(ymd)` in those words, so a check that read
  // the prose would fail on the warning and pass on a file that dropped it.
  const CLIENT = read('miniapp/utils/fresh-eta.js');
  const CLIENT_CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('the client label path constructs no Date at all', () => {
    assert.ok(!/new Date\(/.test(CLIENT_CODE),
      'a handset in another zone must not be what decides whether a date is "tomorrow" (§82)');
  });
  it('…nor reads a clock by any other name', () => {
    assert.ok(!/Date\.now\(|getTime\(|toLocaleDateString\(/.test(CLIENT_CODE),
      'the server settled this; the client formats what it was handed');
  });
  it('…and reads the whole-day count the server sent rather than counting itself', () => {
    assert.ok(/local_fresh_in_days/.test(CLIENT));
  });
}

section('5 · ALL SEVEN BROWSE SURFACES, BY NAME — §108\'s LESSON IS THE POINT');
{
  const SHOP = read('miniapp/pages/shop/shop.js');
  const PDP  = read('miniapp/pages/product/product.js');
  const FAV  = read('miniapp/pages/favorites/favorites.js');
  const WEB  = read('public/shop.html');

  it('shop grid card', () => {
    assert.ok(/preText: preToday \? ''[\s\S]{0,400}?freshEta\.withFreshArrival/.test(SHOP));
  });
  it('shop size sheet', () => {
    assert.ok(/const preText = kind === 'batch'\s*\n\s*\? freshEta\.withFreshArrival/.test(SHOP));
  });
  it('PDP hero badge', () => {
    assert.ok(/stockTag = freshEta\.withFreshArrival\(/.test(PDP));
  });
  it('PDP add button — the tap that commits carries it too', () => {
    assert.ok(/\? freshEta\.withFreshArrival\(\s*\n\s*L === 'cn' \? '下批现做' : 'NEXT BATCH', p, this\._onLocalRun, L\)/.test(PDP));
  });
  it('PDP size rows', () => {
    assert.ok(/const preTxt = rowKind === 'batch'\s*\n\s*\? freshEta\.withFreshArrival/.test(PDP));
  });
  it('favourites tile', () => {
    assert.ok(/freshEta\.withFreshArrival\(copy\.nextBatch/.test(FAV));
  });
  it('web storefront card AND its size sheet', () => {
    assert.ok(/batchTxt=p\.is_batch_made\?withFreshArrival\(/.test(WEB), 'card');
    assert.ok(/preTxt=kind==='batch'\?withFreshArrival\(/.test(WEB), 'size sheet');
    assert.ok(/badge:p\.is_batch_made\?withFreshArrival\(/.test(WEB), 'the badge two functions down');
  });

  it('every miniapp surface goes through the ONE helper — no second derivation', () => {
    for (const [name, src] of [['shop', SHOP], ['product', PDP], ['favorites', FAV]]) {
      assert.ok(/require\('\.\.\/\.\.\/utils\/fresh-eta'\)/.test(src),
        `${name} must require the shared helper rather than work the dates out again`);
      assert.ok(!/local_fresh_in_days/.test(src),
        `${name} reads the raw day count — that is a second derivation and §108 is about exactly this`);
    }
  });
}

section('6 · WHAT §170 DELIBERATELY DID NOT TOUCH');
{
  const SHOP = read('miniapp/pages/shop/shop.js');
  const PDP  = read('miniapp/pages/product/product.js');
  const ADD  = read('miniapp/pages/add-to-order/add-to-order.js');

  it('the add TOASTS keep their bare word — read after the decision, not before it', () => {
    assert.ok(/'已加入购物车，下批现做' : 'Added — next batch'/.test(SHOP));
    assert.ok(/'已加入购物车，下批现做' : 'Added — next batch'/.test(PDP));
  });
  it('add-to-order keeps §108\'s own carve-out — an add-on picker is not a browse surface', () => {
    assert.ok(/nextBatch: '下批现做'/.test(ADD));
    assert.ok(!/fresh-eta/.test(ADD));
  });
  it('the local run\'s SILENCE is untouched: today\'s batch still says nothing at all', () => {
    assert.ok(/preText: preToday \? ''/.test(SHOP),
      'a date must not be what brings the band back on the one morning §80 silenced it');
  });
  it('a reservable GROCERY row still reads PRE-ORDER, undated', () => {
    assert.ok(/: kind === 'preorder' \? \(L === 'cn' \? '可预订' : 'PRE-ORDER'\)/.test(SHOP));
  });
}

section('7 · THE VOCABULARY IS LIFTED, NOT COMPOSED');
{
  const CLIENT = read('miniapp/utils/fresh-eta.js');
  const CHECKOUT_WXML = read('miniapp/pages/checkout/checkout.wxml');
  const CHECKOUT_JS   = read('miniapp/pages/checkout/checkout.js');
  const VOCAB = read('docs/tacet-delivery-vocabulary.md');

  it('今天 / 明天 are live pairs in the checkout slot-day chip', () => {
    assert.ok(/'明天' : 'TOMORROW'/.test(CHECKOUT_WXML), 'the source pair must still exist');
    assert.ok(/'今天' : 'TODAY'/.test(CHECKOUT_WXML));
    assert.ok(/明天/.test(CLIENT) && /今天/.test(CLIENT));
  });
  it('`M月D日` is the live express-slot form', () => {
    assert.ok(/label_cn: `\$\{m\}月\$\{d\}日`/.test(CHECKOUT_JS), 'the source form must still exist');
    assert.ok(/\$\{m\}月\$\{d\}日/.test(CLIENT));
  });
  it('the lift is declared, so it can be found from the vocabulary end too', () => {
    assert.ok(/v1\.123/.test(VOCAB), '§170 must appear in the vocabulary record');
    assert.ok(/§170/.test(VOCAB));
  });
  it('no Chinese beyond those three forms entered the helper', () => {
    const cn = (CLIENT.match(/[一-鿿]+/g) || []);
    const allowed = new Set(['今天', '明天', '月', '日', '供应商直发', '单独送达', '下批现做']);
    for (const s of cn) {
      assert.ok(allowed.has(s), `undeclared Chinese in the helper: ${s}`);
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
