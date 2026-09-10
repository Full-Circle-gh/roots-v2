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
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

// ── The web storefront's two deciders, run as shipped ──────────────────────
function webCtx(onRun, lang = 'en') {
  const ctx = {
    shopperOnLocalRun: () => onRun,
    oosBackorder: (m) => !!m.oos_preorder,
    state: { lang },
    esc: (v) => String(v == null ? '' : v),
  };
  vm.createContext(ctx);
  vm.runInContext(
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

section('2 · the web storefront — an out-of-city shopper is UNTOUCHED');
{
  const away = webCtx(false);
  it('still gets PRE-ORDER on a fresh item, today\'s batch or not', () => {
    assert.strictEqual(away.slStock({ ...FRESH_TODAY }).preTxt, 'PRE-ORDER');
    assert.strictEqual(away.slStock({ ...FRESH_LATER }).preTxt, 'PRE-ORDER');
  });
  it('…and the hero still names the promise', () => {
    assert.strictEqual(away.stockState({ ...FRESH_LATER }).badge, 'NEXT BATCH');
    assert.strictEqual(away.stockState({ ...GROCERY_OUT }).badge, 'SHIPS SOON');
  });
  it('a shipped order is still called a pre-order when it is added', () => {
    assert.ok(/slStock\(m\)\.pre&&!slStock\(m\)\.preToday/.test(SHOP),
      'the toast asks whether it is today\'s batch before saying "pre-order"');
  });
}

section('3 · the mini app — the surface the report came from');
{
  it('the PDP asks whether the date is TODAY, not merely whether it exists', () => {
    assert.ok(/const madeToday = m => !!\(m && m\.local_fresh_today\)/.test(MPROD));
    assert.ok(/preorder = !this\._onLocalRun;/.test(MPROD),
      'a local-run shopper is never in the pre-order state, so the CTA reads ADD TO BASKET');
  });
  it('the badge is empty for today, NEXT BATCH for later, PRE-ORDER for shipped', () => {
    const b = sliceBlock(MPROD, 'if (reservable(p))');
    assert.ok(/stockTag = '';/.test(b), 'silent today');
    assert.ok(/'下批现做' : 'NEXT BATCH'/.test(b), 'named later');
    assert.ok(/'可预订' : 'PRE-ORDER'/.test(b), 'shipped keeps its word');
  });
  it('the size rows keep their OWN word, since one shared label cannot say two', () => {
    assert.ok(/const preTxt = !preorder \? ''/.test(MPROD));
    assert.ok(/\{\{opt\.preTxt \|\| preLabel\}\}/.test(
      fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.wxml'), 'utf8')));
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
    // …and the variant sheet keeps preLabel: its rows never set preText, so
    // there the fallback is the only thing standing between it and a blank pill.
    assert.ok(/class="vp-opt-pre f-toni">\{\{preLabel\}\}/.test(MSHOPX),
      'the size sheet still reads preLabel — do not sweep it up with the grid bands');
  });
}

section('4 · the clock that decides is the SHOP\'s (§82)');
{
  it('the server sends the verdict; no client computes "today"', () => {
    assert.ok(/local_fresh_today = !!\(r\.local_fresh_date && isToday\)/.test(RETAIL), 'list rows');
    assert.ok(/product\.local_fresh_today = !!\(product\.local_fresh_date && isToday\)/.test(RETAIL), 'the PDP');
    assert.ok(/const isToday = !!d && d === toYmdLocal\(new Date\(\)\)/.test(RETAIL),
      'and it is resolved in the tenant zone, through toYmdLocal');
  });
  it('no client compares a date against its own clock', () => {
    for (const [name, src] of [['shop.html', SHOP], ['product.js', MPROD], ['shop.js', MSHOP]]) {
      assert.ok(!/local_fresh_date\s*===/.test(src),
        `${name} must not compare the batch date itself — a handset clock is not entitled to`);
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
