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

// ── The PDP page, loaded and RUN ───────────────────────────────────────────
// Section 8 below executes the builder rather than describing it. A regex
// proves a line was written; only a run proves the value reaches the button.
// Same shape as the harness in scripts/test_fresh_today_label.js, kept local
// because neither suite exports one.
function runPdp(product, lang, onLocalRun, cfg) {
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  let page = null;
  g.Page = (o) => { page = o; return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, { get: (t, k) => {
    // §195 reads the operator's restock window off the cached storefront
    // config, so a case that wants a window hands one in here.
    if (k === 'getStorageSync') return (key) =>
      (key === 'config_cache_v1' ? { data: cfg || {}, at: Date.now() } : null);
    if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
    if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
    return () => {};
  } });
  try {
    const full = path.join(ROOT, 'miniapp/pages/product/product.js');
    // config caches its hydrate, so it is reloaded with the page — otherwise
    // the first case's window would be every later case's window too.
    for (const m of ['miniapp/utils/config.js', 'miniapp/pages/product/product.js']) {
      delete require.cache[require.resolve(path.join(ROOT, m))];
    }
    require(full);
    const ctx = {
      data: Object.assign({}, page.data, { product, lang }),
      _variants: [],
      _onLocalRun: onLocalRun,
      setData(patch) { Object.assign(this.data, patch); },
      recomputeFlashCountdown() {},
    };
    for (const k of Object.keys(page)) if (typeof page[k] === 'function') ctx[k] = page[k];
    ctx.recomputeDisplay.call(ctx);
    return { label: ctx.data.addBtnLabel, word: ctx.data.addBtnWord,
             qual: ctx.data.addBtnQual, price: ctx.data.price };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}
// A fresh meal the kitchen has yet to make, as the server decorates it.
const pdpRow = (extra) => Object.assign({
  id: 1, name_en: 'Quinoa Salad', name_cn: '藜麦沙拉', price: 44,
  stock: 0, oos_preorder: 1, is_batch_made: 1,
  local_fresh_in_days: 0, local_fresh_date: '2026-09-20', fresh_ship_date: '2026-09-21',
}, extra || {});

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
    // §195 gave the non-batch branch an appender of its own, so these two
    // expressions wrapped onto three lines. Matched across the break: what is
    // asserted is that a BATCH row still reaches withFreshArrival, which is
    // §170's decision and is unchanged.
    assert.ok(/batchTxt=p\.is_batch_made\s*\?withFreshArrival\(/.test(WEB), 'card');
    assert.ok(/preTxt=kind==='batch'\?withFreshArrival\(/.test(WEB), 'size sheet');
    assert.ok(/badge:p\.is_batch_made\s*\?withFreshArrival\(/.test(WEB), 'the badge two functions down');
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
  it('a reservable GROCERY row still reads PRE-ORDER, and still names no DATE', () => {
    /* §170's point stands and is what is asserted: a grocery row names no
       batch, so no batch DATE may reach it. §195 gave it the other appender —
       the operator's restock window, which is a typed estimate and not a date
       — so the bare literal became a call. The word is unchanged. */
    assert.ok(/kind === 'preorder'\s*\n?\s*\? freshEta\.withRestockWindow\(L === 'cn' \? '可预订' : 'PRE-ORDER'/
      .test(SHOP), 'the word is the same; only the appender is new');
    assert.ok(!/kind === 'preorder'[\s\S]{0,120}withFreshArrival/.test(SHOP),
      'and the DATED appender must never reach it');
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
    // §195 adds `天`, the live day counter, for the restock window. Declared in
    // docs/tacet-delivery-vocabulary.md v1.144 — which is what this guard is
    // for: a form in the helper that is not in the record is undeclared, and
    // an undeclared string is indistinguishable from a locked one.
    const allowed = new Set(['今天', '明天', '月', '日', '供应商直发', '单独送达', '下批现做', '天']);
    for (const s of cn) {
      assert.ok(allowed.has(s), `undeclared Chinese in the helper: ${s}`);
    }
  });
}

// ── The dated band has to FIT on the surface that draws it ──────────────────
// §170 roughly doubled the band: `NEXT BATCH` became `NEXT BATCH · SEP 21`,
// and nothing checked that the longest of the seven surfaces still had a line
// wide enough for it. The shop list did not. Its text column sits between a
// 184rpx category rail, a 176rpx thumbnail and the price column — under 200rpx
// of the 750 — so the band broke in two and the date landed on its own line
// under the word, which is the §170 report back again in a new shape: a date
// the shopper has to reassemble. Reported by Ash from the shop list,
// 2026-09-19.
//
// The fix is width, not type size: at a readable size the band needs about
// 275rpx and no font that fits 200rpx can be read at arm's length. So the band
// is a wrapped flex item on .row taking the whole row's width, with the pill
// inside it. These cases pin the three pieces that make that true — take any
// one away and the band silently folds again.
section('6 · THE SHOP LIST HAS A LINE WIDE ENOUGH TO DRAW IT ON');
{
  const WXML = read('miniapp/pages/shop/shop.wxml');
  const WXSS = read('miniapp/pages/shop/shop.wxss');
  const rowPre = WXSS.match(/^\.row-pre \{[^}]*\}/m);
  const rowPreTag = WXSS.match(/^\.row-pre-tag \{[^}]*\}/m);

  it('the band is a child of .row, not of the narrow .row-body', () => {
    // The body block ends before the band begins; if the band is ever moved
    // back inside it, this ordering breaks and so does the layout.
    const body = WXML.indexOf('<view class="row-body">');
    const bodyEnd = WXML.indexOf('<view class="row-right">', body);
    const band = WXML.indexOf('class="row-pre f-toni"');
    assert.ok(body > 0 && bodyEnd > body && band > bodyEnd,
      'the list band must sit outside .row-body, where the full row width is');
  });
  it('.row wraps, so the band drops to a line of its own', () => {
    const r = WXSS.match(/^\.row \{[^}]*\}/m);
    assert.ok(r && /flex-wrap:\s*wrap/.test(r[0]),
      'without wrap the band is squeezed onto the first line beside the price');
  });
  it('…and the band claims that whole line', () => {
    assert.ok(rowPre && /flex-basis:\s*100%/.test(rowPre[0]),
      '.row-pre is the LINE — a full basis is what pushes it below the row');
    assert.ok(!/background/.test(rowPre[0]),
      'the line paints nothing; the pill inside it does');
  });
  it('the pill inside still shrinks to its text, and never breaks in two', () => {
    assert.ok(rowPreTag, '.row-pre-tag must exist — it is the pill itself');
    assert.ok(/display:\s*inline-block/.test(rowPreTag[0]),
      'a full-width olive bar on every batch row is not what this is');
    assert.ok(/white-space:\s*nowrap/.test(rowPreTag[0]),
      'the line is wide enough; say so, so no later tightening folds it again');
  });
}

// ── …AND SO DOES THE PDP'S BUY BUTTON ──────────────────────────────────────
// The same §170 length, one surface further on. The PDP's sticky bar puts the
// label on the left of the buy button and the price on its right, and the
// button is flex:1 inside that bar. A flex item's default min-width is auto,
// so the button could not be squeezed below its own min-content width — a
// nowrap label plus the price — and instead pushed the BAR wider than the
// 750rpx screen. The price went over the right edge: `NEXT BATCH · TOMORROW¥4`,
// with the second 4 off-screen. Reported by Ash from the PDP, 2026-09-20.
//
// Two things had to be true and neither was: the button may not grow past the
// bar (min-width:0), and when the label is too long for the room it must be
// the LABEL that gives, never the price — a clipped word is still readable,
// a clipped number is a different number. These cases pin both, plus the
// length test that decides which labels step down.
section('8 · THE PDP BUY BUTTON FITS THE BAND BESIDE EVERY PRICE IT DRAWS');
{
  const WXSS = read('miniapp/pages/product/product.wxss');
  const WXML = read('miniapp/pages/product/product.wxml');
  const JS = read('miniapp/pages/product/product.js');
  // app.wxss ships this on `page`, and every `calc(Nrpx * var(--font-scale))`
  // in the file is multiplied by it. Read, never assumed: raising it is a real
  // way to make a label stop fitting.
  const SCALE = Number(read('miniapp/app.wxss').match(/--font-scale:\s*([\d.]+)/)[1]);
  const btn = WXSS.match(/^\.add-btn \{[^}]*\}/m);
  const label = WXSS.match(/^\.add-label \{[^}]*\}/m);
  const stack = WXSS.match(/^\.add-label-stack \{[^}]*\}/m);
  const word = WXSS.match(/^\.add-word \{[^}]*\}/m);
  const qual = WXSS.match(/^\.add-qual \{[^}]*\}/m);
  const prices = WXSS.match(/^\.add-prices \{[^}]*\}/m);

  it('the button cannot push the sticky bar past the screen', () => {
    assert.ok(btn, '.add-btn must exist');
    assert.ok(/min-width:\s*0/.test(btn[0]),
      'without min-width:0 a nowrap label widens the bar and the price falls off the edge');
  });
  it('the label and the price can never touch', () => {
    assert.ok(/gap:\s*\d+rpx/.test(btn[0]),
      'the child margins were the only spacing; a gap is what survives a shrink');
  });
  it('the price never gives — the label does', () => {
    assert.ok(prices && /flex-shrink:\s*0/.test(prices[0]),
      'a clipped price is a wrong price');
    assert.ok(label && /min-width:\s*0/.test(label[0]) && /text-overflow:\s*ellipsis/.test(label[0]),
      'the label is the half that yields, and it yields visibly');
  });
  it('the appended answer stacks under the word rather than competing for the line', () => {
    assert.ok(stack, '.add-label-stack must exist — it is the whole fix');
    assert.ok(/flex-direction:\s*column/.test(stack[0]),
      'the word and what the appender added are stacked; side by side is the bug');
    assert.ok(/min-width:\s*0/.test(stack[0]),
      'the stack yields before the price does, like the single label');
    assert.ok(word && qual, '.add-word and .add-qual must both exist');
    const n = (r) => Number(r[0].match(/font-size:\s*calc\((\d+)rpx/)[1]);
    assert.ok(n(qual) < n(word),
      'the qualifier informs and the word is what you tap — it reads quieter');
    for (const r of [word, qual]) {
      assert.ok(/white-space:\s*nowrap/.test(r[0]),
        'neither line may fold — folding is what put the date under the word');
    }
  });
  it('the markup stacks, and only when an appender added something', () => {
    assert.ok(/wx:if="\{\{addBtnQual\}\}"[\s\S]{0,240}add-word[\s\S]{0,140}add-qual/.test(WXML),
      'a row with an appended answer draws the word and that answer as two lines');
    assert.ok(/<text wx:else class="add-label">\{\{addBtnLabel\}\}<\/text>/.test(WXML),
      'every other row still draws the single label it always did');
  });
  it('the qualifier is SPLIT off the built label, never derived a second time', () => {
    // §195's lesson, kept: "did the appender add anything" never asks WHICH
    // appender, so neither does this. Taking the qualifier off the one label
    // the appenders already built means it cannot disagree with it, and a
    // third appender needs no edit here. A second fork would be two things to
    // change together tomorrow, which is the same defect early.
    assert.ok(/addBtnLabel\.indexOf\(addBtnBare \+ BAND_SEP\) === 0/.test(JS),
      'the split is anchored on the bare word plus the shared separator');
    assert.ok(/addBtnLabel\.slice\(addBtnBare\.length \+ BAND_SEP\.length\)/.test(JS),
      'and the qualifier is the remainder of that same string');
    assert.ok(!/addBtnQual[\s\S]{0,200}freshEta\./.test(JS),
      'no second call to an appender — that is the drift this avoids');
    assert.ok(/const addBtnBare = preKind === 'batch'[\s\S]{0,200}'下批现做' : 'NEXT BATCH'/.test(JS),
      'and the bare word is still the one the label is built from (§195)');
  });
  it('RUN: every appended answer the builder can produce gets its own line', () => {
    // Both appenders, both languages, every shape each can return — straight
    // off recomputeDisplay, not off a regex.
    const W = (lo, hi) => ({ notice: { preorder: { min_days: lo, max_days: hi } } });
    const grocery = { id: 9, name_en: 'Tea', name_cn: '茶', price: 30, stock: 0, oos_preorder: 1 };
    const cases = [
      // §170 — the batch arrival
      [pdpRow(), 'en', false, null, 'NEXT BATCH', 'TOMORROW'],
      [pdpRow(), 'en', true, null, 'NEXT BATCH', 'TODAY'],
      [pdpRow(), 'cn', false, null, '下批现做', '明天'],
      [pdpRow({ local_fresh_in_days: 2, local_fresh_date: '2026-09-22',
                fresh_ship_date: '2026-09-23' }), 'en', false, null, 'NEXT BATCH', 'SEP 23'],
      [pdpRow({ local_fresh_in_days: 2, local_fresh_date: '2026-09-22',
                fresh_ship_date: '2026-09-23' }), 'cn', false, null, '下批现做', '9月23日'],
      // §195 — the operator's restock window
      [grocery, 'en', false, W(3, 5), 'PRE-ORDER', '3-5 DAYS'],
      [grocery, 'en', false, W(10, 14), 'PRE-ORDER', '10-14 DAYS'],
      [grocery, 'en', false, W(1, 1), 'PRE-ORDER', '1 DAY'],
      [grocery, 'cn', false, W(10, 14), '预订', '10-14 天'],
    ];
    for (const [p, lang, onRun, cfg, expectWord, expectQual] of cases) {
      const got = runPdp(p, lang, onRun, cfg);
      assert.strictEqual(got.word, expectWord, `word for ${lang}`);
      assert.strictEqual(got.qual, expectQual, `qualifier for ${lang}`);
      // The two pieces must rejoin to exactly the joined form, or this button
      // is saying something no other surface says.
      assert.strictEqual(`${got.word} · ${got.qual}`, got.label,
        `the stacked pieces must rebuild ${got.label}`);
    }
  });
  it('RUN: …and a row no appender touched stays one line', () => {
    const inStock = { id: 2, name_en: 'Quinoa Salad', name_cn: '藜麦沙拉', price: 44, stock: 5 };
    const grocery = { id: 3, name_en: 'Tea', name_cn: '茶', price: 30, stock: 0, oos_preorder: 1 };
    const gone = { id: 4, name_en: 'Gone', name_cn: '没了', price: 10, stock: 0 };
    const cases = [
      [inStock, 'en', true, null, 'ADD TO BASKET'],
      [inStock, 'cn', true, null, '加入购物车'],
      // No window configured, and §195's zero-day window, which names no wait.
      [grocery, 'en', false, {}, 'PRE-ORDER'],
      [grocery, 'en', false, { notice: { preorder: { min_days: 0, max_days: 0 } } }, 'PRE-ORDER'],
      [gone, 'en', false, null, 'SOLD OUT'],
    ];
    for (const [p, lang, onRun, cfg, expected] of cases) {
      const got = runPdp(p, lang, onRun, cfg);
      assert.strictEqual(got.label, expected, `label for ${lang}`);
      assert.strictEqual(got.qual, '', `${expected} stays a single line`);
      assert.strictEqual(got.word, '', `${expected} draws no stacked word`);
    }
  });
  it('RUN: the button price is the one every other surface shows', () => {
    // `¥44.00` here and `¥44` in the list was the 75rpx that made two attempts
    // at this label too small. A non-round price still keeps its decimals.
    assert.strictEqual(runPdp({ id: 5, name_en: 'W', price: 44, stock: 5 }, 'en', true, null).price, '¥44');
    assert.strictEqual(runPdp({ id: 6, name_en: 'W', price: 44.5, stock: 5 }, 'en', true, null).price, '¥44.50');
  });
  // ── DOES IT ACTUALLY FIT — measured, not asserted about ─────────────────
  // Every case above pins that the RULE is written. None of them pins that the
  // result FITS, and that is exactly how this bug survived two fixes. The
  // first sized the label against `¥44`, which is what the shop LIST draws,
  // while this button drew `¥44.00` — 164rpx against 89. §195 then inherited
  // that sizing, so `PRE-ORDER · 10-14 DAYS` was over the edge on the very
  // surface §170 was reported from. Nothing was watching either time.
  //
  // So this reads the shipped fonts and adds up the real strings: every label
  // recomputeDisplay can build, beside every price column it can draw. Sizes
  // and tracking come FROM product.wxss rather than being repeated here, so a
  // change to a rule is a change to the sum.
  const FONTS = {
    toni: 'public/fonts/ToniGroteskPro.otf',   // .f-toni — the label
    price: 'public/fonts/LilitaOne.ttf',       // Bear Serif maps digits and ¥ here
  };
  // The bar's fixed furniture, in rpx of the 750 design width (product.wxss).
  const SCREEN = 750, BAR_PADDING = 64, STEPPER = 198, BAR_GAP = 20;
  const BTN_PADDING = 48, BTN_GAP = 16;
  const ROOM = SCREEN - BAR_PADDING - STEPPER - BAR_GAP - BTN_PADDING - BTN_GAP;

  function rule(selector) {
    const m = WXSS.match(new RegExp('^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*\\}', 'm'));
    assert.ok(m, `${selector} must exist in product.wxss`);
    const size = m[0].match(/font-size:\s*calc\((\d+(?:\.\d+)?)rpx/);
    const track = m[0].match(/letter-spacing:\s*(-?\d*\.?\d+)em/);
    assert.ok(size, `${selector} must state a font-size in rpx`);
    return { size: Number(size[1]), track: track ? Number(track[1]) : null };
  }

  it('the sizes this measures are the ones product.wxss actually ships', () => {
    // If a rule stops stating its own size or tracking, the sums below would
    // quietly measure something the page does not draw.
    assert.strictEqual(rule('.add-label').size, 32);
    assert.strictEqual(rule('.add-word').size, 28);
    assert.strictEqual(rule('.add-qual').size, 20);
    assert.strictEqual(rule('.add-qual').track, 0.06);
    assert.strictEqual(rule('.add-price').size, 36);
    assert.ok(/letter-spacing:\s*0\.1em/.test(btn[0]),
      'the word and the plain label inherit the button tracking; the sums assume it');
  });

  it('MEASURED: every label fits beside every price the button can draw', () => {
    const { textWidthRpx } = require(path.join(ROOT, 'scripts/lib/font-advance.js'));
    const w = (font, text, r) => textWidthRpx(path.join(ROOT, FONTS[font]), text, r.size, r.track, SCALE);

    const plain = { size: rule('.add-label').size, track: 0.1 };        // inherited
    const wordR = { size: rule('.add-word').size, track: 0.1 };         // inherited
    const qualR = rule('.add-qual');
    const priceR = { size: rule('.add-price').size, track: 0.1 };
    const wasR = { size: rule('.add-was').size, track: 0.1 };
    const saveR = { size: rule('.add-save').size, track: 0.04 };

    // The price column is as wide as its widest row: the live price, or the
    // struck compare-at plus its SAVE badge on the line above it.
    const columns = [
      ['¥44', w('price', '¥44', priceR)],
      ['¥128', w('price', '¥128', priceR)],
      ['¥44.50', w('price', '¥44.50', priceR)],
      ['¥58 struck + SAVE ¥14',
        w('price', '¥58', wasR) + w('toni', 'SAVE ¥14', saveR) + 10 * SCALE],
      // The widest the column gets: three integer digits AND two decimals on
      // both rows. This is the case that kills every single-line size.
      ['¥158.50 struck + SAVE ¥30.50',
        w('price', '¥158.50', wasR) + w('toni', 'SAVE ¥30.50', saveR) + 10 * SCALE],
    ];
    // A single label costs its own width; a stacked one costs the WIDER of its
    // two lines, which is the whole reason it fits.
    const single = (t) => [t, () => w('toni', t, plain)];
    const stacked = (a, b) => [`${a} / ${b}`,
      () => Math.max(w('toni', a, wordR), w('toni', b, qualR))];
    const labels = [
      single('ADD TO BASKET'), single('CHOOSE A SIZE'), single('SOLD OUT'),
      single('PRE-ORDER'), single('加入购物车'), single('选择规格'),
      // §170's arrivals
      stacked('NEXT BATCH', 'TOMORROW'), stacked('NEXT BATCH', 'TODAY'),
      stacked('NEXT BATCH', 'SEP 23'),
      stacked('下批现做', '明天'), stacked('下批现做', '9月23日'),
      // §195's windows, including the widest a 365-day cap allows
      stacked('PRE-ORDER', '1 DAY'), stacked('PRE-ORDER', '10-14 DAYS'),
      stacked('PRE-ORDER', '100-365 DAYS'),
      stacked('预订', '10-14 天'), stacked('预订', '100-365 天'),
    ];

    const over = [];
    for (const [label, width] of labels) {
      for (const [priceName, priceW] of columns) {
        const slack = ROOM - priceW - width();
        if (slack < 0) over.push(`${label} beside ${priceName}: ${slack.toFixed(1)}rpx over`);
      }
    }
    // ONE PAIR IS KNOWN NOT TO FIT, AND IT IS OLDER THAN §170: an ordinary
    // `ADD TO BASKET` beside a deeply discounted, non-round price. That column
    // is 231rpx of the 404 and the plain label is 223, so it was already 50rpx
    // over before any appender existed — it simply had no min-width:0 to make
    // it visible, and pushed the price off the screen instead. Recorded here
    // rather than fixed: fixing it means resizing the compare-at row, which is
    // not this change, and the case below proves it now degrades safely. A
    // THIRD pair joining this list means something regressed.
    const KNOWN = [
      'ADD TO BASKET beside ¥158.50 struck + SAVE ¥30.50',
      'CHOOSE A SIZE beside ¥158.50 struck + SAVE ¥30.50',
    ];
    const unexpected = over.filter(o => !KNOWN.some(k => o.startsWith(k)));
    assert.deepStrictEqual(unexpected, [],
      `these pairs do not fit in the ${ROOM}rpx the button has:\n      ` + unexpected.join('\n      '));
    // And every STACKED label — what the appenders add, and what this change
    // is for — fits outright, with nothing on the known list.
    assert.ok(!over.some(o => o.includes(' / ')),
      `a stacked label must fit every price column:\n      ` + over.join('\n      '));
  });

  it('when a label cannot fit, the PRICE is what survives', () => {
    // The known pair above is only tolerable because of this. Before it, an
    // over-wide label pushed the bar past the screen and took the price with
    // it — which is the bug that started all of this.
    assert.ok(/min-width:\s*0/.test(btn[0]),
      'the button must be squeezable, or the bar grows past the 750 instead');
    assert.ok(/flex-shrink:\s*0/.test(prices[0]),
      'the price column never gives — a clipped price is a wrong price');
    for (const sel of ['.add-label', '.add-word', '.add-qual']) {
      const r = WXSS.match(new RegExp('^\\' + sel + ' \\{[^}]*\\}', 'm'));
      assert.ok(r && /overflow:\s*hidden/.test(r[0]) && /text-overflow:\s*ellipsis/.test(r[0]),
        `${sel} clips itself rather than pushing the price out`);
    }
  });

  it('MEASURED: …and the price the button draws is the one every other surface does', () => {
    // The 75rpx that made two attempts at this label too small.
    const builder = JS.slice(JS.indexOf('recomputeDisplay()'));
    assert.ok(/price: v > 0 \? money\(v\) : '—'/.test(builder),
      'the button price goes through the page-wide money(), not its own toFixed(2)');
    assert.ok(!/price: v > 0 \? '¥' \+ v\.toFixed\(2\)/.test(builder),
      'and may not go back to forcing two decimals');
    assert.strictEqual((JS.match(/^const money = /gm) || []).length, 1,
      'one money() for the page — three local copies and a fourth rule is how they drifted');
    const { textWidthRpx } = require(path.join(ROOT, 'scripts/lib/font-advance.js'));
    const at = (t) => textWidthRpx(path.join(ROOT, FONTS.price), t, 36, 0.1, SCALE);
    assert.ok(at('¥44.00') - at('¥44') > 60,
      'the decimals are worth more than 60rpx — that is why this case exists');
  });

  it('and the bare word it compares against is the one the label is built from', () => {
    // If the two ever drift the flag silently goes always-on or always-off,
    // and nothing else would catch it: the button would just be the wrong
    // size. Both spellings live in this file, so pin that there is one pair.
    const words = JS.match(/'下批现做' : 'NEXT BATCH'/g) || [];
    assert.ok(words.length >= 2,
      'the label builds from this pair and the flag compares against it');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
