#!/usr/bin/env node
/**
 * §195 — THE RESTOCK WINDOW REACHES THE BROWSE BAND, AND FOUR COPIES OF ONE
 * FOLD ARE HELD TO THE SAME ANSWER.
 *
 *   node scripts/test_preorder_band.js
 *
 * §194 gave the operator somewhere to type a restock window and printed it in
 * the checkout popup. A customer decides whether to tap on the CARD, which is
 * §170's own argument for bringing the batch date forward out of the checkout,
 * so the window comes forward the same way.
 *
 * THE RISK THIS SUITE EXISTS FOR IS NOT THE FEATURE, IT IS THE ARITHMETIC.
 * The same pair of day numbers is now folded into a label in FOUR places:
 *
 *   routes/retail.js            preorderWindowLabel   the checkout popup
 *   public/retail-admin/06-…    poWindowLabel         the operator's preview
 *   miniapp/utils/fresh-eta.js  restockWindowLabel    every mini-app surface
 *   public/shop.html            restockWindowLabel    the web storefront
 *
 * Four is three too many to trust to care, and §108 exists in this codebase
 * because TWO surfaces disagreed and it took a screenshot pair to notice. So
 * §1 below runs all four over the same pairs and fails if any two differ.
 * They cannot be collapsed into one: the server has no DOM, the admin page has
 * no `require`, shop.html is a single standalone file, and the mini app cannot
 * reach any of them.
 *
 * §2 holds the vocabulary decision: the band now says ONE word for this state
 * everywhere. It used to say SHIPS SOON on the shop grid and the web card and
 * PRE-ORDER on the PDP, its button, its size rows and favourites — the same
 * product reading two ways depending on which screen you were on.
 *
 * §3 holds the width rule §170 needed and §195 had to widen, because
 * `PRE-ORDER · 2-4 DAYS` is wider than the label whose overflow was reported.
 * That rule was a font step-down when §195 was written and is a stacked line
 * now — the step-down never actually fit. What §3 pins is unchanged: whatever
 * the treatment is, a window gets it on the same terms a date does.
 *
 * No network, no DB, no WeChat runtime: every function is lifted from source
 * and run in a vm sandbox.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log(`\n${t}`); }

const ROOT = path.join(__dirname, '..');
const RETAIL   = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
const DELIVERY = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');
const SHOPHTML = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
const SHOPJS   = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.js'), 'utf8');
const PDPJS    = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
const FAVJS    = fs.readFileSync(path.join(ROOT, 'miniapp/pages/favorites/favorites.js'), 'utf8');
const ATOJS    = fs.readFileSync(path.join(ROOT, 'miniapp/pages/add-to-order/add-to-order.js'), 'utf8');

// Brace-matched lift, so a function containing a nested `\n}` still comes out whole.
function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} not found`);
  const open = src.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* ── 1 · four folds, one answer ─────────────────────────────────────────── */
section('1 · the same pair folds the same way in all four copies');

// (a) the real mini-app module, required as shipped.
const freshEta = require(path.join(ROOT, 'miniapp/utils/fresh-eta.js'));

// (b) the server.
const srv = { cfgValue: () => null, console };
vm.createContext(srv);
vm.runInContext(grab(RETAIL, 'preorderWindowLabel'), srv);

// (c) the admin preview, over a stubbed pair of inputs.
const adminFields = { '#po-min-days': { value: '' }, '#po-max-days': { value: '' } };
const admin = { $: (s) => adminFields[s] || null, console };
vm.createContext(admin);
vm.runInContext(grab(DELIVERY, 'poWindowLabel'), admin);

// (d) the web storefront's standalone copy.
const web = { state: { lang: 'en' }, console };
vm.createContext(web);
vm.runInContext(grab(SHOPHTML, 'restockWindowLabel'), web);

// Every copy answers in its own shape; normalise to one string per language so
// the comparison is about the NUMBERS and the WORDS, not the return type.
//   server + admin → {en, cn} | null      (a sentence fragment, lower case)
//   mini app + web → 'X DAYS' | ''        (a band, upper case)
// The case difference is a register difference and is deliberate (Rule 1), so
// it is folded out here and asserted on its own in §2.
const norm = (v) => (!v ? '' : String(v)).toUpperCase();

const PAIRS = [
  [null, null], [2, 4], [4, 2], [3, 3], [3, null], [null, 7],
  [1, 1], [0, 0], [0, 2], [-1, -1], [900, 900], [7, 14],
];

for (const [lo, hi] of PAIRS) {
  it(`min=${lo} max=${hi} reads the same everywhere`, () => {
    const cfg = { min_days: lo, max_days: hi };

    const a = freshEta.restockWindowLabel(cfg, 'en');
    const aCn = freshEta.restockWindowLabel(cfg, 'cn');

    const s = srv.preorderWindowLabel(
      // The server takes an ALREADY-NORMALISED cfg (preorderNoticeCfg folds the
      // pair first), so hand it the same folding the others do internally.
      (() => {
        const day = (v) => {
          const n = parseInt(v, 10);
          return (Number.isFinite(n) && n >= 0 && n <= 365) ? n : null;
        };
        let x = day(lo), y = day(hi);
        if (x == null) x = y;
        if (y == null) y = x;
        if (x != null && y != null && x > y) { const t = x; x = y; y = t; }
        return { min_days: x, max_days: y };
      })());

    adminFields['#po-min-days'].value = lo == null ? '' : String(lo);
    adminFields['#po-max-days'].value = hi == null ? '' : String(hi);
    const ad = admin.poWindowLabel();

    web.state.lang = 'en';
    const w = web.restockWindowLabel(cfg);
    web.state.lang = 'cn';
    const wCn = web.restockWindowLabel(cfg);

    assert.strictEqual(norm(a), norm(s && s.en), 'mini app vs server (EN)');
    assert.strictEqual(norm(a), norm(ad && ad.en), 'mini app vs admin preview (EN)');
    assert.strictEqual(norm(a), norm(w), 'mini app vs web storefront (EN)');
    assert.strictEqual(norm(aCn), norm(s && s.cn), 'mini app vs server (CN)');
    assert.strictEqual(norm(aCn), norm(ad && ad.cn), 'mini app vs admin preview (CN)');
    assert.strictEqual(norm(aCn), norm(wCn), 'mini app vs web storefront (CN)');
  });
}

it('an unset window appends nothing at all — the bare word survives', () => {
  for (const cfg of [null, undefined, {}, 'nonsense', [], { min_days: null }]) {
    assert.strictEqual(freshEta.withRestockWindow('PRE-ORDER', cfg, 'en'), 'PRE-ORDER');
    assert.strictEqual(freshEta.withRestockWindow('可预订', cfg, 'cn'), '可预订');
  }
});

it('a zero-day window names no wait, so it names nothing', () => {
  // "PRE-ORDER · 0 DAYS" is §80's defect — a band describing a wait that is
  // not happening — and "within 0 days" is not a sentence anyone writes.
  assert.strictEqual(freshEta.withRestockWindow('PRE-ORDER', { min_days: 0, max_days: 0 }, 'en'),
    'PRE-ORDER');
  assert.strictEqual(srv.preorderWindowLabel({ min_days: 0, max_days: 0 }), null);
  // …but a range that merely STARTS at zero is a real window.
  assert.strictEqual(freshEta.withRestockWindow('PRE-ORDER', { min_days: 0, max_days: 2 }, 'en'),
    'PRE-ORDER · 0-2 DAYS');
});

it('the band is upper case and the popup is not — Rule 1, not drift', () => {
  assert.strictEqual(freshEta.restockWindowLabel({ min_days: 2, max_days: 4 }, 'en'), '2-4 DAYS');
  assert.strictEqual(srv.preorderWindowLabel({ min_days: 2, max_days: 4 }).en, '2-4 days');
  // Chinese has no case, so the two must be identical there.
  assert.strictEqual(freshEta.restockWindowLabel({ min_days: 2, max_days: 4 }, 'cn'),
    srv.preorderWindowLabel({ min_days: 2, max_days: 4 }).cn);
});

it('the separator is the band’s own, shared with the dated appender', () => {
  const dated = freshEta.withFreshArrival('NEXT BATCH', { local_fresh_in_days: 0 }, true, 'en');
  const windowed = freshEta.withRestockWindow('PRE-ORDER', { min_days: 2, max_days: 4 }, 'en');
  assert.ok(dated.includes(' · ') && windowed.includes(' · '),
    'a reader comparing two rows must not be able to tell which function drew which');
});

/* ── 2 · one word for one state, on every surface ───────────────────────── */
section('2 · the band says one word for this state, everywhere');

it('SHIPS SOON · 现订现发 no longer appears on any browse surface', () => {
  /* Judged on what the code DRAWS, not on prose about the change: the notes
     explaining why the word was retired name it, and a test that counted those
     would force the reasoning to be deleted to stay green. Comments are
     stripped first and the assertion is on what remains. */
  const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
  for (const [name, src] of [['shop.js', SHOPJS], ['product.js', PDPJS],
    ['favorites.js', FAVJS], ['add-to-order.js', ATOJS], ['shop.html', SHOPHTML]]) {
    const c = code(src);
    assert.ok(!/SHIPS SOON/.test(c), `${name} still draws SHIPS SOON`);
    assert.ok(!/现订现发/.test(c), `${name} still draws 现订现发`);
  }
  // …and the retirement is recorded, not merely done.
  assert.ok(/SHIPS SOON/.test(SHOPJS), 'the note explaining the retirement is still there');
});

it('…and the popup TITLE keeps it — a different register, deliberately kept', () => {
  // The band names the STATE a shopper is browsing; the popup titles the
  // PROMISE at checkout. Retiring it there was never the change.
  assert.ok(/title_en:  cfg\.title_en  \|\| 'Ships soon'/.test(RETAIL),
    'the checkout popup still titles itself Ships soon by default');
});

it('every browse surface appends through the one shared helper', () => {
  for (const [name, src] of [['shop.js', SHOPJS], ['product.js', PDPJS],
    ['favorites.js', FAVJS]]) {
    assert.ok(/freshEta\.withRestockWindow\(/.test(src), `${name} works the window out itself`);
  }
  assert.ok(/withRestockWindow\(/.test(SHOPHTML), 'shop.html works the window out itself');
});

it('add-to-order takes the WORD and not the window — §170\'s carve-out, kept', () => {
  /* An add-on picker is not a browse surface, which is the reason §170 gave
     for keeping its date off this screen and pinned in test_fresh_batch_eta
     §6. The word still has to travel, because this screen lifts the grid's
     pairs precisely so one product does not read two ways in one app; an
     appender arriving without §170's would leave the list saying
     `PRE-ORDER · 2-4 DAYS` beside a bare `NEXT BATCH`. Both or neither, and
     that is §170's call to revisit. */
  assert.ok(/preorder: 'PRE-ORDER'/.test(ATOJS) && /preorder: '可预订'/.test(ATOJS),
    'the renamed word travels');
  assert.ok(!/fresh-eta/.test(ATOJS), 'and neither appender does');
});

it('the window is hoisted into a local, never read at the row', () => {
  /* The rule is not "read it once in the file" — shop.js legitimately reads it
     in two builders (the card grid and the variant sheet), each once per pass.
     The rule is that the read is never INSIDE the row expression, because a
     per-row read could only ever differ from the row beside it by being wrong
     and it drags the config module into a hot loop.

     Stated as: every read is assigned to a named local, and no read shares a
     line with the appender that consumes it. That catches the inlined call at
     the row without counting legitimate per-builder hoists as a defect —
     which is exactly the mistake this assertion made on its first draft, and
     it caught two real per-row reads on the way to being corrected. */
  for (const [name, src] of [['shop.js', SHOPJS], ['product.js', PDPJS],
    ['favorites.js', FAVJS]]) {
    const reads = src.match(/config\.get\('notice\.preorder'[^)]*\)/g) || [];
    assert.ok(reads.length >= 1, `${name} never reads the window`);
    for (const line of src.split('\n')) {
      if (!/config\.get\('notice\.preorder'/.test(line)) continue;
      assert.ok(/^\s*const \w+ = config\.get\('notice\.preorder'/.test(line),
        `${name} reads the window inline rather than hoisting it: ${line.trim()}`);
    }
    assert.ok(/withRestockWindow\([^)]*preWin/.test(src.replace(/\n\s+/g, ' ')),
      `${name} does not pass the hoisted value to the appender`);
  }
});

it('shop.html reads it from the config the page already holds', () => {
  const fn = grab(SHOPHTML, 'slPreorderWindow');
  assert.ok(/state\.config/.test(fn) && /notice/.test(fn) && /preorder/.test(fn));
});

/* ── 3 · the PDP buy button, which §170 already had to measure ──────────── */
section('3 · the buy button’s width rule covers BOTH appenders');

it('the rule is not gated on the batch kind alone', () => {
  /* §195 WIDENED A FONT STEP-DOWN; THE STEP-DOWN IS NOW A STACK, and this case
     keeps what it was written to protect — that a pre-order label carrying a
     window is treated exactly like a batch label carrying a date, whatever
     that treatment is.

     The step-down is gone because it never worked: it was sized against `¥44`
     while the button drew `¥44.00`, so `PRE-ORDER · 10-14 DAYS` was 6rpx over
     the edge beside an ordinary price and 73 beside a discounted one. The
     qualifier takes a line of its own instead, which needs only the wider of
     the two pieces and fits every price this page can draw. §8 of
     test_fresh_batch_eta.js measures that from the shipped font files. */
  assert.ok(/addBtnLabel\.indexOf\(addBtnBare \+ BAND_SEP\) === 0/.test(PDPJS),
    'the split is anchored on the bare word, whichever appender supplied the rest');
  assert.ok(!/preKind === 'batch'[\s\S]{0,80}addBtnQual/.test(PDPJS),
    'and it must not be re-gated on one kind');
  assert.ok(!/addBtnLong/.test(PDPJS),
    'the step-down it replaces is gone, not left beside it');
});

it('the bare word it compares against is built per kind', () => {
  const at = PDPJS.indexOf('const addBtnBare =');
  assert.ok(at > -1, 'the bare word is a value, not re-derived inside the flag');
  const win = PDPJS.slice(at, at + 400);
  assert.ok(/'下批现做' : 'NEXT BATCH'/.test(win), 'batch bare word');
  assert.ok(/'预订' : 'PRE-ORDER'/.test(win), 'pre-order bare word');
});

it('the button label itself is built from that same word', () => {
  // §108's rule: the button says what the badge says. Both still come off one
  // `preKind`, and now both appenders hang off the same bare word.
  assert.ok(/withRestockWindow\(L === 'cn' \? '预订' : 'PRE-ORDER'/.test(PDPJS));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
