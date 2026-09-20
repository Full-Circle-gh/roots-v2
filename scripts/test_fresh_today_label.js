#!/usr/bin/env node
/**
 * §80 follow-up — TODAY'S BATCH IS NOT A PRE-ORDER.
 *
 *   node scripts/test_fresh_today_label.js
 *
 * REPORTED BY ASH from the live mini app, 07:00 on a cooking morning, with a
 * Guangzhou address and a sold-out Quinoa Salad: he could order it, which is
 * §80 working, and the page said PRE-ORDER, which is §80 being contradicted by
 * its own label. The batch lands at 11:00, inside the lunch window he was about
 * to pick. *"it shouldn't show any message like this."*
 *
 * WHAT WENT WRONG IS NARROW AND IS WHAT THIS PINS. When §74/§80 opened the
 * local run to a dated fresh meal, every surface asked the same question —
 * "is there a batch date?" — and none asked "is that date TODAY?". So the
 * out-of-city word was applied to a shopper nothing was being shipped to.
 *
 * THREE STATES, and a suite that only proved "the word changed" would pass on a
 * change that dropped the word everywhere, including where it is correct:
 *
 *   local run + made today  → orderable, and SILENT
 *   local run + made later  → orderable, NEXT BATCH · 下批现做 (the grid's word)
 *   shipped                 → orderable, PRE-ORDER · 可预订, untouched
 *
 * AND THE ROW MUST STAY ALIVE. On two of the three surfaces the flag that
 * carries the word is the same flag that keeps the row out of SOLD OUT, so the
 * tempting one-line fix — turn the flag off — marks the meal sold out on the
 * one morning it is most available. That trap has its own cases below.
 *
 * §108 AMENDMENT — THE THIRD STATE IS GONE; THE OTHER TWO STAND.
 * The three states above are §80 as shipped, kept here as the record of what
 * this suite was built to pin. Ash's later ruling collapsed "shipped" into
 * "made later": a meal the kitchen has yet to make reads NEXT BATCH · 下批现做
 * to EVERY shopper, because the wait is the same fact wherever they are. What
 * still differs is the DATE — the run gets the make day, a courier order gets
 * make day plus transit — and that belongs in the checkout notice, which
 * states it, and not in a pill, which cannot.
 *
 *   local run + made today  → orderable, and SILENT          (unchanged)
 *   anything else reservable, fresh → NEXT BATCH · 下批现做    (was two states)
 *   anything else reservable, grocery → PRE-ORDER · 可预订     (the carve-out)
 *
 * THE CARVE-OUT IS DELIBERATE and has cases of its own on every surface: a
 * sold-out grocery row keeps PRE-ORDER because no batch is being cooked for
 * it, so "next batch" would name a thing that does not exist.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

function sliceBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

const SHOP = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
const MPROD = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
const MSHOP = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.js'), 'utf8');
const MSHOPX = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxml'), 'utf8');
const MFAV = fs.readFileSync(path.join(ROOT, 'miniapp/pages/favorites/favorites.js'), 'utf8');
const MFAVX = fs.readFileSync(path.join(ROOT, 'miniapp/pages/favorites/favorites.wxml'), 'utf8');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

// ── A mini-app page, loaded and RUN ────────────────────────────────────────
// Sections 5 and 6 execute the builders instead of describing them, which is
// the lesson of the band this suite once let through: a regex proves a line
// was written, never that the value it produces reaches a customer. Same
// shape as scripts/test_preorder_local.js, kept local because neither suite
// exports a harness.
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'getStorageSync') return () => null;
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
      return () => {};
    },
  });
  try {
    const full = path.join(ROOT, relPath);
    delete require.cache[require.resolve(full)];
    require(full);
    return captured;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}
function withToasts(fn) {
  const g = global, saved = { wx: g.wx, getApp: g.getApp };
  const said = [];
  g.wx = new Proxy({ showToast: (o) => said.push((o && o.title) || '') }, {
    get: (t, k) => (k in t ? t[k] : () => {}),
  });
  g.getApp = () => ({ globalData: { lang: 'en' }, authReady: Promise.resolve() });
  try { fn(); return said; }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } }
}
function makeCtx(initial) {
  return {
    data: JSON.parse(JSON.stringify(initial)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

// ── The web storefront's two deciders, run as shipped ──────────────────────
function webCtx(onRun, lang = 'en') {
  const ctx = {
    shopperOnLocalRun: () => onRun,
    oosBackorder: (m) => !!m.oos_preorder,
    // §127 — the server-flag branch of the real helper. Every fixture in this
    // file omits the field, so it reads false throughout and the cases below
    // go on testing the DATE exemption they were written for.
    oosPreorderLocal: (m) => !!(m && m.oos_preorder_local),
    state: { lang },
    esc: (v) => String(v == null ? '' : v),
  };
  vm.createContext(ctx);
  vm.runInContext(
    // §170 — the band is now the word PLUS the arrival, so the appender is part
    // of the decider path and has to run here too. Every fixture in this file
    // predates it and carries no `local_fresh_in_days`, so it returns the bare
    // word throughout and the cases below go on testing what they were written
    // for. scripts/test_fresh_batch_eta.js is where the dated shapes are pinned.
    sliceBlock(SHOP, 'function freshArrivalLabel(p,onRun)') + '\n' +
    sliceBlock(SHOP, 'function withFreshArrival(base,p,onRun)') + '\n' +
    'const SL_MONTHS_EN=[];\n' +
    sliceBlock(SHOP, 'function slStock(m)') + '\n' +
    sliceBlock(SHOP, 'function stockState(p)') + '\n' +
    'this.slStock = slStock; this.stockState = stockState;', ctx);
  return ctx;
}
const FRESH_TODAY = { stock: 0, oos_preorder: 1, is_batch_made: 1,
                      local_fresh_date: '2026-09-10', local_fresh_today: true };
const FRESH_LATER = { stock: 0, oos_preorder: 1, is_batch_made: 1,
                      local_fresh_date: '2026-09-12', local_fresh_today: false };
const GROCERY_OUT = { stock: 0, oos_preorder: 1, is_batch_made: 0,
                      local_fresh_date: null, local_fresh_today: false };

// ═══════════════════════════════════════════════════════════════════════════
section("1 · the web storefront — a Guangzhou shopper on a cooking morning");
{
  const gz = webCtx(true);
  it('says NOTHING about a batch that is today\'s', () => {
    const ss = gz.stockState({ ...FRESH_TODAY });
    assert.strictEqual(ss.badge, '', 'no badge');
    assert.strictEqual(ss.oos, false, 'and not flagged out of stock at all');
    assert.strictEqual(ss.soldOut, false);
  });
  it('…and the size row carries no word either', () => {
    const st = gz.slStock({ ...FRESH_TODAY });
    assert.strictEqual(st.preTxt, '');
    assert.strictEqual(st.preToday, true);
  });
  it('BUT THE ROW STAYS ALIVE — the trap this fix had to avoid', () => {
    const st = gz.slStock({ ...FRESH_TODAY });
    assert.strictEqual(st.pre, true, 'still orderable');
    assert.strictEqual(st.soldOut, false, 'and NOT sold out');
  });
  it('a batch on a LATER day still says NEXT BATCH, not PRE-ORDER', () => {
    assert.strictEqual(gz.stockState({ ...FRESH_LATER }).badge, 'NEXT BATCH');
    assert.strictEqual(gz.slStock({ ...FRESH_LATER }).preTxt, 'NEXT BATCH');
  });
  it('…in Chinese too', () => {
    const cn = webCtx(true, 'cn');
    assert.strictEqual(cn.stockState({ ...FRESH_LATER }).badge, '下批现做');
    assert.strictEqual(cn.slStock({ ...FRESH_LATER }).preTxt, '下批现做');
  });
  it('a sold-out grocery item is still plainly SOLD OUT on the run', () => {
    const ss = gz.stockState({ ...GROCERY_OUT });
    assert.strictEqual(ss.soldOut, true);
    assert.strictEqual(ss.badge, 'SOLD OUT');
  });
}

section('2 · the web storefront — an out-of-city shopper reads the SAME word (§108)');
{
  const away = webCtx(false);
  it('a fresh item says NEXT BATCH, today\'s batch or not — as it does on the run', () => {
    /* §108. This case used to demand PRE-ORDER here, and it was the size
       picker's own private answer: the card badge one function away said NEXT
       BATCH off `is_batch_made` for the very same row, so one product read two
       ways on one page, and the mini app disagreed with both. Ash's ruling is
       one word for one wait. The DATE still differs and is still the checkout
       notice's job. */
    assert.strictEqual(away.slStock({ ...FRESH_TODAY }).preTxt, 'NEXT BATCH');
    assert.strictEqual(away.slStock({ ...FRESH_LATER }).preTxt, 'NEXT BATCH');
    const cn = webCtx(false, 'cn');
    assert.strictEqual(cn.slStock({ ...FRESH_LATER }).preTxt, '下批现做');
  });
  it('…and the hero agrees with it, as it always did', () => {
    assert.strictEqual(away.stockState({ ...FRESH_LATER }).badge, 'NEXT BATCH');
    assert.strictEqual(away.stockState({ ...FRESH_TODAY }).badge, 'NEXT BATCH');
  });
  it('a GROCERY row is the carve-out: no batch is being cooked, so PRE-ORDER stands', () => {
    // §108 changed the word for a meal the kitchen makes. Nothing is being
    // made for a sold-out bag of rice, so it keeps the wording it had — the
    // picker's PRE-ORDER and the card's SHIPS SOON, both untouched.
    assert.strictEqual(away.slStock({ ...GROCERY_OUT }).preTxt, 'PRE-ORDER');
    assert.strictEqual(away.stockState({ ...GROCERY_OUT }).badge, 'SHIPS SOON');
  });
  it('the add toast uses the row\'s OWN word, not a second opinion (§108)', () => {
    // It used to re-derive "is this a reservation" at the toast
    // (`slStock(m).pre && !slStock(m).preToday`) and then say "pre-order"
    // whatever the card had said. Both toasts read `kind` now.
    assert.ok(/const kind=!pre\|\|preToday\?'':\(m\.is_batch_made\?'batch':'preorder'\)/.test(SHOP),
      'slStock decides the word once');
    assert.ok(/Added — next batch/.test(SHOP) && /已加入购物车，下批现做/.test(SHOP),
      'and a fresh meal is announced as the batch it is waiting on');
    assert.ok(/Added — pre-order/.test(SHOP), 'while a grocery reservation keeps its own');
  });
}

section('3 · the mini app — the surface the report came from');
{
  it('ONE copy of the rule, asked by the badge, the button, the sheet and the toast', () => {
    /* §108. The four used to answer it separately and had drifted three
       different ways — including the old `madeToday`, which read
       `local_fresh_today` with NO run check, so an out-of-city shopper on a
       cooking morning got a silent badge over a PRE-ORDER button. */
    const k = sliceBlock(MPROD, 'function _preKind(m, onLocalRun)');
    assert.ok(/if \(onLocalRun && m\.local_fresh_today\) return '';/.test(k),
      'silence belongs to the local run alone');
    assert.ok(/return m\.is_batch_made \? 'batch' : 'preorder';/.test(k),
      'the word is chosen by what the item IS, never by where the shopper is');
    assert.strictEqual((MPROD.match(/m\.is_batch_made \? 'batch'/g) || []).length, 1,
      'and exactly ONE place decides it');
    assert.ok(/preorder = !this\._onLocalRun;/.test(MPROD),
      'the ship-vs-run flag survives for the things that genuinely ask it');
  });
  it('the badge is empty on the run today, else NEXT BATCH — grocery keeps PRE-ORDER', () => {
    const b = sliceBlock(MPROD, 'if (reservable(p))');
    assert.ok(/preKind = _preKind\(p, this\._onLocalRun\)/.test(b), 'off the shared rule');
    assert.ok(/preKind === 'batch'/.test(b) && /'下批现做' : 'NEXT BATCH'/.test(b),
      'a fresh meal not yet made');
    assert.ok(/preKind === 'preorder'/.test(b) && /'可预订' : 'PRE-ORDER'/.test(b),
      'a grocery row names no batch');
    assert.ok(!/_onLocalRun \?/.test(b),
      'no address fork left in the badge at all');
  });
  it('the BUTTON says what the badge says, so the page cannot contradict itself', () => {
    // Before §108 the button read `preorder` (ship-vs-run) while the badge read
    // the batch, so a Guangzhou shopper waiting on a later batch was offered a
    // plain ADD TO BASKET under a NEXT BATCH badge.
    // Anchored on the computed one — the first `addBtnLabel:` in the file is
    // the `data` block's plain default.
    const at = MPROD.indexOf('addBtnLabel: soldOut');
    assert.notStrictEqual(at, -1, 'the computed button label is still where it was');
    // 500 was enough until §170 put a six-line comment inside this expression;
    // the window has to reach the preorder branch or the case passes vacuously.
    const btn = MPROD.slice(at, at + 1200);
    assert.ok(/preKind === 'batch'/.test(btn) && /'下批现做' : 'NEXT BATCH'/.test(btn));
    assert.ok(/preKind === 'preorder'/.test(btn) && /'预订' : 'PRE-ORDER'/.test(btn));
    assert.ok(!/: preorder$/m.test(btn), 'the button no longer forks on the run');
  });
  it('the size rows keep their OWN word, since one shared label cannot say two', () => {
    assert.ok(/const rowKind = _preKind\(m, this\._onLocalRun\);/.test(MPROD),
      'and they ask the same rule the hero does');
    // §170 hands the same word to the shared appender rather than drawing it
    // bare; the WORD, and that it is chosen by `rowKind`, is what this pins.
    assert.ok(/rowKind === 'batch'\s*\n\s*\? freshEta\.withFreshArrival\(L === 'cn' \? '下批现做' : 'NEXT BATCH'/.test(MPROD));
    assert.ok(/\{\{opt\.preTxt \|\| preLabel\}\}/.test(
      fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.wxml'), 'utf8')));
  });
  it('…and the PDP add toast asks it too, by size as well as by button', () => {
    assert.ok(/this\._finishAdd\(this\.data\.preKind\)/.test(MPROD), 'the buy button');
    assert.ok(/this\._finishAdd\(_preKind\(m, this\._onLocalRun\)\)/.test(MPROD),
      'and a size chosen from the sheet, which used to pass a different flag entirely');
    assert.ok(/'已加入购物车，下批现做' : 'Added — next batch'/.test(MPROD));
  });
  it('_preKind tests the SHELF itself, or an in-stock meal is announced as a wait', () => {
    /* `oos_preorder` is a POLICY flag — true on a batch-made product whether or
       not any is left — so the rule cannot assume its caller checked the shelf.
       The badge calls it inside a `stock <= 0` branch and would never have
       noticed; the add toast has no shelf test of its own and would have told a
       customer their in-stock wrap was waiting on the next batch. */
    const k = sliceBlock(MPROD, 'function _preKind(m, onLocalRun)');
    assert.ok(/if \(!\(stock != null && stock <= 0\)\) return '';/.test(k),
      'in stock, or untracked → no word at all');
    assert.ok(/if \(!m \|\| m\.ship_from_supplier\) return '';/.test(k),
      'and a supplier-direct row holds no stock of ours to be short of');
  });
  it('…and a size stays orderable — `soldOut` reads `orderable`, not the label', () => {
    assert.ok(/const soldOut = out && !orderable;/.test(MPROD),
      'the label flag must never be what marks a size sold out');
  });
  it('the list goes quiet for today while KEEPING the row alive', () => {
    assert.ok(/const today = preorder && !!onLocalRun && !!p\.local_fresh_today;/.test(MSHOP));
    assert.ok(/soldOut: out && !preorder/.test(MSHOP), 'preorder still gates sold-out');
    assert.ok(/preText: preToday \? ''/.test(MSHOP));
  });
  it('…and the TEMPLATE honours that silence rather than filling it in', () => {
    /* THE ASSERTION THAT WAS MISSING, AND THE WHOLE BUG. The case above proves
       shop.js sets preText to '' for a batch made today. It says nothing about
       what gets DRAWN, and the band was written "preText OR preLabel" — WXML
       counts '' as falsy, so the one state §80 exists to silence fell straight
       through to preLabel, which is the literal 'PRE-ORDER' / '可预订'. The row
       went from saying the wrong word to saying the FORBIDDEN one, on a
       tenant-verified suite that never opened the template. Reported again from
       the live app with a 天河 address, `_onLocalRun` true and the batch made
       that morning — the same Quinoa Salad as the report at the head of this
       file. A change that only proves the JS can be green while the customer
       reads PRE-ORDER. */
    const bands = MSHOPX.split('\n').filter(l => /class="(?:row|card|gal)-pre f-toni"/.test(l));
    assert.strictEqual(bands.length, 3, 'the list row, the grid card and the gallery tile');
    for (const b of bands) {
      assert.ok(/item\.preorder && item\.preText/.test(b),
        `the band is gated on the TEXT, not on the flag that keeps the row alive: ${b.trim()}`);
      assert.ok(!/\|\|\s*preLabel/.test(b),
        `an empty preText must draw nothing — no fallback to preLabel: ${b.trim()}`);
    }
    // …and the variant sheet is no longer the exception this case carved out.
    // The guard used to read "the size sheet still reads preLabel — do not
    // sweep it up with the grid bands", and it was right when it was written:
    // those rows carried no preText of their own, so dropping the fallback
    // would have left a blank pill where a word belonged. They carry one now
    // (section 5), which is what made it safe to finish the job — so NO band
    // anywhere in this template falls back to the literal word any more.
    assert.ok(!/\{\{[^}]*\|\|\s*preLabel[^}]*\}\}/.test(MSHOPX),
      'no binding in shop.wxml may fall back to preLabel — WXML reads \'\' as falsy');
  });
}

section('4 · the clock that decides is the SHOP\'s (§82)');
{
  it('the server sends the verdict; no client computes "today"', () => {
    assert.ok(/local_fresh_today = !!\(r\.local_fresh_date && isToday\)/.test(RETAIL), 'list rows');
    // The PDP used to carry its own copy of those two lines; it now runs the
    // same helper over the hero AND every sibling size, because the size
    // picker labels each row on its own. One stamp for three routes — the
    // route-body case below says why that consolidation was the fix.
    assert.ok(/decorateFreshBatch\(\[product, \.\.\.\(product\.variants \|\| \[\]\)\]\)/.test(RETAIL),
      'the PDP stamps its hero and its sizes');
    assert.strictEqual((RETAIL.match(/r.local_fresh_today =/g) || []).length, 1,
      'and exactly ONE place decides it');
    // §170 hoisted the zone into a local and reuses it for the two dates it
    // added; `toYmdLocal`'s default IS deliveryTz(), so passing it explicitly is
    // the same resolution said out loud, not a different one.
    assert.ok(/const todayIso = toYmdLocal\(new Date\(\), tz\)/.test(RETAIL) &&
              /const isToday = !!d && d === todayIso/.test(RETAIL),
      'and it is resolved in the tenant zone, through toYmdLocal');
    assert.ok(/const tz = deliveryTz\(\);/.test(RETAIL), 'from the tenant, never the host');
  });
  it('EVERY route that offers a reservation also dates the batch', () => {
    /* THE INVARIANT, not three spot checks. A route may stamp `oos_preorder`
       — "this sold-out row is still orderable" — only if it also stamps the
       day that reservation is for. The favourites list stamped the first and
       never the second, for as long as §80 has existed, and the failure was
       silent in the worst direction: with no `local_fresh_date` on the row the
       client's own guard read every sold-out favourite as dead, so a Guangzhou
       shopper got SOLD OUT and no + button for a meal coming out of the
       kitchen that morning. Nothing threw, nothing logged, and the page's own
       suite passed — it only ever fed the builder rows it made up itself. */
    for (const anchor of [
      "router.get('/api/retail/products', (req, res) =>",
      "router.get('/api/retail/products/:id', (req, res) =>",
      "router.get('/api/retail/favorites', requireRetailAuth,",
    ]) {
      const body = sliceBlock(RETAIL, anchor);
      assert.ok(/oos_preorder/.test(body), `${anchor} offers reservations`);
      assert.ok(/decorateFreshBatch\(/.test(body), `…so it must date them: ${anchor}`);
    }
  });
  it('no client compares a date against its own clock', () => {
    for (const [name, src] of [['shop.html', SHOP], ['product.js', MPROD], ['shop.js', MSHOP],
                               ['favorites.js', MFAV]]) {
      assert.ok(!/local_fresh_date\s*===/.test(src),
        `${name} must not compare the batch date itself — a handset clock is not entitled to`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The two surfaces §80 never reached. Both were found by grep, not reported:
// the ruling changed three files, and these two read the same rows down their
// own code paths.
section("5 · the shop page's SIZE SHEET — quick-add, off a grid card");
{
  const page = loadMiniPage('miniapp/pages/shop/shop.js');
  const sheet = (member, onLocalRun, L = 'en') => {
    const ctx = makeCtx({ lang: L, _raw: [] });
    ctx._onLocalRun = onLocalRun;
    page._openVariantPicker.call(ctx, 99, [{ id: 501, ...member }]);
    return ctx.data.vpOptions[0];
  };

  it('a size made TODAY carries no word at all', () => {
    assert.strictEqual(sheet({ ...FRESH_TODAY }, true).preText, '');
  });
  it('BUT THE ROW STAYS ALIVE — the same trap, on a third surface', () => {
    const o = sheet({ ...FRESH_TODAY }, true);
    assert.strictEqual(o.preorder, true, 'still orderable — vpChoose adds it');
    assert.strictEqual(o.soldOut, false, 'and NOT the dead pill');
  });
  it('a batch on a LATER day says NEXT BATCH · 下批现做', () => {
    assert.strictEqual(sheet({ ...FRESH_LATER }, true).preText, 'NEXT BATCH');
    assert.strictEqual(sheet({ ...FRESH_LATER }, true, 'cn').preText, '下批现做');
  });
  it('an out-of-city shopper reads the SAME NEXT BATCH · 下批现做 (§108)', () => {
    assert.strictEqual(sheet({ ...FRESH_TODAY }, false).preText, 'NEXT BATCH');
    assert.strictEqual(sheet({ ...FRESH_LATER }, false).preText, 'NEXT BATCH');
    assert.strictEqual(sheet({ ...FRESH_LATER }, false, 'cn').preText, '下批现做');
  });
  it('a sold-out grocery size is still plainly dead on the run', () => {
    const o = sheet({ ...GROCERY_OUT }, true);
    assert.strictEqual(o.soldOut, true);
    assert.strictEqual(o.preText, '');
  });
  it('…and off the run it is the carve-out: PRE-ORDER, no batch to name', () => {
    assert.strictEqual(sheet({ ...GROCERY_OUT }, false).preText, 'PRE-ORDER');
    assert.strictEqual(sheet({ ...GROCERY_OUT }, false, 'cn').preText, '可预订');
  });

  it('…and CHOOSING one hands the toast the row\'s OWN word (§108)', () => {
    /* The band going quiet is half the surface. Tapping the size runs
       _addRawToCart, which fires the add toast. It took a BOOLEAN — "is this a
       reservation" — so it could only ever say "pre-order", and a shopper who
       tapped a row reading NEXT BATCH was answered with the other word. It
       takes `_stockState`'s own `kind` now, so the row and the toast cannot
       disagree. */
    const choose = (member, onLocalRun) => {
      const ctx = makeCtx({ lang: 'en', _raw: [] });
      ctx._onLocalRun = onLocalRun;
      ctx._memberMap = { 99: [{ id: 501, ...member }] };
      ctx._vpRepId = 99;
      let kind = null;
      ctx._addRawToCart = (raw, originId, k) => { kind = k; };
      withToasts(() => page.vpChoose.call(ctx, { currentTarget: { dataset: { id: 501 } } }));
      return kind;
    };
    assert.strictEqual(choose({ ...FRESH_TODAY }, true), '',
      "today's batch is added like any other line");
    assert.strictEqual(choose({ ...FRESH_LATER }, true), 'batch',
      '…while a later batch is announced as the batch it is');
    assert.strictEqual(choose({ ...FRESH_TODAY }, false), 'batch',
      '…and so is a shipped one — same word, same wait (§108)');
    assert.strictEqual(choose({ ...GROCERY_OUT }, false), 'preorder',
      '…with grocery the one row still calling it a pre-order');
  });

  it('…and the TEMPLATE draws that word, not the page-wide preLabel', () => {
    /* THE ASSERTION THAT MATTERS, AND THE ONE THIS SUITE KEPT SKIPPING. The
       cases above prove the builder computes a word. The sheet used to render
       {{preLabel}} FLAT — one page-level string, 'PRE-ORDER' / '可预订' — so
       every reservable size read the forbidden word whatever the builder
       decided, and a suite that only ran the JS would have gone green anyway.
       Gated on the TEXT, because an empty preText is a value: for a batch made
       today it is the whole point, while `preorder` must stay true — that flag
       is what keeps the row out of SOLD OUT. */
    const band = MSHOPX.split('\n').filter(l => /class="vp-opt-pre f-toni"/.test(l));
    assert.strictEqual(band.length, 1, 'one size-sheet band');
    assert.ok(/opt\.preorder && opt\.preText/.test(band[0]),
      `gated on the text, not on the flag that keeps the row alive: ${band[0].trim()}`);
    assert.ok(/>\{\{opt\.preText\}\}</.test(band[0]),
      `and it draws the row's own word: ${band[0].trim()}`);
    assert.ok(!/preLabel/.test(band[0]),
      `a page-wide label cannot say three things: ${band[0].trim()}`);
  });
}

section('6 · the FAVOURITES page — §80 never reached it at all');
{
  const page = loadMiniPage('miniapp/pages/favorites/favorites.js');
  const tile = (p, onLocalRun, L = 'en') => {
    const ctx = makeCtx({ lang: L, all: [{ id: 601, ...p }], activeCat: 'All', copy: {} });
    page.applyLangCopy.call(ctx);          // the page's own COPY_EN / COPY_CN
    ctx._onLocalRun = onLocalRun;
    page.rebuildView.call(ctx);
    return ctx.data.visible[0];
  };

  it('a favourite made TODAY says nothing', () => {
    assert.strictEqual(tile({ ...FRESH_TODAY }, true).preText, '');
  });
  it('BUT THE TILE STAYS ALIVE — quick-add lives, SOLD OUT stays off', () => {
    const t = tile({ ...FRESH_TODAY }, true);
    assert.strictEqual(t.preorder, true, 'reservable, so the + button renders');
    assert.strictEqual(t.soldOut, false, 'and the dead pill does not');
  });
  it('…and it is still kept OUT of the bulk ADD ALL, which stays literal', () => {
    const ctx = makeCtx({ lang: 'en', all: [{ id: 601, ...FRESH_TODAY }], activeCat: 'All', copy: {} });
    page.applyLangCopy.call(ctx);
    ctx._onLocalRun = true;
    page.rebuildView.call(ctx);
    assert.strictEqual(ctx.data.inStockCount, 0,
      'silent is not the same as in stock — a sold-out row must not be swept up');
  });
  it('a batch on a LATER day says NEXT BATCH · 下批现做', () => {
    assert.strictEqual(tile({ ...FRESH_LATER }, true).preText, 'NEXT BATCH');
    assert.strictEqual(tile({ ...FRESH_LATER }, true, 'cn').preText, '下批现做');
  });
  it('an out-of-city shopper reads the SAME NEXT BATCH · 下批现做 (§108)', () => {
    assert.strictEqual(tile({ ...FRESH_TODAY }, false).preText, 'NEXT BATCH');
    assert.strictEqual(tile({ ...FRESH_LATER }, false, 'cn').preText, '下批现做');
  });
  it('a sold-out grocery favourite is dead on the run, as before', () => {
    const t = tile({ ...GROCERY_OUT }, true);
    assert.strictEqual(t.soldOut, true);
    assert.strictEqual(t.preText, '');
  });
  it('…and off the run it is the carve-out: PRE-ORDER, no batch to name', () => {
    assert.strictEqual(tile({ ...GROCERY_OUT }, false).preText, 'PRE-ORDER');
    assert.strictEqual(tile({ ...GROCERY_OUT }, false, 'cn').preText, '可预订');
  });

  it('…and the quick-add toast says the tile\'s own word (§108)', () => {
    const said = (p, onLocalRun) => {
      const ctx = makeCtx({ lang: 'en', all: [{ id: 601, ...p }], activeCat: 'All', copy: {} });
      page.applyLangCopy.call(ctx);
      ctx._onLocalRun = onLocalRun;
      return withToasts(() => page.onQuickAdd.call(ctx, { currentTarget: { dataset: { id: 601 } } }));
    };
    assert.ok(!said({ ...FRESH_TODAY }, true).some(t => /pre-order|next batch/i.test(t)),
      'a meal made this morning is added, not reserved — no word at all');
    assert.ok(said({ ...FRESH_LATER }, true).some(t => /next batch/i.test(t)),
      'a later batch is announced as the batch it is');
    assert.ok(said({ ...FRESH_LATER }, false).some(t => /next batch/i.test(t)),
      '…and a shipped one the same way — same wait, same word');
    assert.ok(said({ ...GROCERY_OUT }, false).some(t => /pre-order/i.test(t)),
      'grocery is the one row still calling it a pre-order');
  });

  it('…and the OLD case still holds where it should: a reservation is never silent', () => {
    const said = (p, onLocalRun) => {
      const ctx = makeCtx({ lang: 'en', all: [{ id: 601, ...p }], activeCat: 'All', copy: {} });
      page.applyLangCopy.call(ctx);
      ctx._onLocalRun = onLocalRun;
      return withToasts(() => page.onQuickAdd.call(ctx, { currentTarget: { dataset: { id: 601 } } }));
    };
    assert.ok(said({ ...FRESH_LATER }, true).some(t => /pre-order|next batch/i.test(t)),
      'a later batch is still announced, whatever the word');
    assert.ok(said({ ...FRESH_TODAY }, false).some(t => /pre-order|next batch/i.test(t)),
      '…and so is anything we are actually shipping');
  });

  it('…and BOTH templates draw the row word, not the page-wide copy.preorder', () => {
    const bands = MFAVX.split('\n').filter(l => /class="(?:tag|row)-pre f-gothic"/.test(l));
    assert.strictEqual(bands.length, 2, 'the grid tile and the list row');
    for (const b of bands) {
      assert.ok(/item\.preorder && item\.preText/.test(b),
        `gated on the text, not the flag that keeps the tile alive: ${b.trim()}`);
      assert.ok(!/copy\.preorder/.test(b),
        `one page-wide string cannot say three things: ${b.trim()}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// §108 reached the checkout too: the badge is not the only place a shopper is
// told about a batch. Two notices describe the SAME wait to two shoppers —
// computeBatchNotice to one we courier to, computeLocalFreshNotice to one on
// the run — and they were headed differently for no reason but the order they
// were written in. The DATES they carry still differ, and should: that is the
// real difference between the two shoppers, and it lives in the message.
section('7 · the two fresh-batch checkout notices head the same way (§108)');
{
  // Full signatures as anchors: `opts = {}` in the parameter list would
  // otherwise be the first brace sliceBlock finds, and it would return the
  // signature instead of the body.
  const BATCH = sliceBlock(RETAIL,
    'function computeBatchNotice(zone, productIds, now, slotId, slotKind, opts = {})');
  const LOCAL = sliceBlock(RETAIL,
    'function computeLocalFreshNotice(address, productIds, now, slotKind, opts = {})');
  const built = (body, key) => {
    const m = new RegExp(key + ":\\s*cfg\\.[a-z_]+\\s*\\|\\|\\s*'([^']*)'").exec(body);
    assert.ok(m, `a built-in default for ${key} is still there to compare`);
    return m[1];
  };

  for (const key of ['kicker_en', 'kicker_cn', 'title_en', 'title_cn']) {
    it(`${key} is the same on both`, () => {
      assert.strictEqual(built(BATCH, key), built(LOCAL, key));
    });
  }
  it('both still fall back to the OPERATOR\'s copy first', () => {
    assert.ok(/cfg\.kicker_en\s*\|\|/.test(BATCH) && /cfg\.local_kicker_en\s*\|\|/.test(LOCAL),
      'matching the defaults must not take the override away');
  });
  it('the local-run message still names its date, which the title no longer does', () => {
    assert.ok(/\$\{makeDate\}/.test(LOCAL),
      'the date moved into the message, it was not dropped');
    assert.ok(/make_date: makeDate/.test(LOCAL), 'and it still rides as a field');
  });
  /* §194 gave this notice the operator copy the two above it already had, so
     the heading is read through the same `cfg.x ||` chain they are. What this
     check is for is unchanged and still the point: the grocery notice names NO
     BATCH, because it has none — only a restock window the operator typed. */
  it('the GROCERY notice heads the same way, through the operator\'s copy', () => {
    const PRE = sliceBlock(RETAIL,
      'function computePreorderNotice(zone, address, productIds, slotId, slotKind)');
    assert.ok(/cfg\.kicker_en \|\| 'Pre-order'/.test(PRE), 'default kicker, operator first');
    assert.ok(/cfg\.title_en  \|\| 'Ships soon'/.test(PRE), 'default title, operator first');
    assert.ok(!/\{ship_date\}|\{delivery_date\}|\{make_date\}/.test(PRE),
      'and no batch date can be smuggled in through an operator field');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
