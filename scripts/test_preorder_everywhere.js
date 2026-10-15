#!/usr/bin/env node
/**
 * §128 — "Pre-order everywhere": the operator may open a sold-out product to
 * EVERY shopper, same-day Guangzhou included.
 *
 *   node scripts/test_preorder_everywhere.js
 *
 * THE ASK, from Ash, on the product editor's "When out of stock" control:
 * *"right now there is only 'pre order outside guangzhou' — i would like to add
 * an option of pre order for everyone"*.
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE IS THE PARK, not the dropdown. Adding a
 * third option to a <select> is one line. The reason Guangzhou was blocked in
 * the first place is that a same-day order is picked off the shop shelf and
 * leaves on today's run — there is nothing to put in the box — so "let them
 * order it" is only honest if the order STOPS being a same-day order. It does:
 * it parks as 'awaiting_restock' with no reservation, no delivery window and no
 * same-day surcharge, exactly where the customer's own wait_for_restock choice
 * already parks, and is promoted by checkAwaitingRestockForRestock() when the
 * count covers it. Every case below is one edge of that promise.
 *
 * A suite that only proved "the option exists" would pass on a change that sold
 * a sold-out item onto a van that cannot be loaded. The five load-bearing rules
 * are therefore:
 *
 *   1. The exemption is OPT-IN. A caller that cannot park the order — the
 *      add-on path, and anything written later — keeps the original refusal.
 *   2. Routing goes relaxed, or the shopper meets the shortage modal instead of
 *      the pre-order they were just offered.
 *   3. The park clears the window. An undated order must not keep a slot.
 *   4. …but a line TODAY'S BATCH covers is dated and must NOT strip it (§80's
 *      ruling survives a product carrying both settings).
 *   5. The clients only open the run for 'backorder_all'. 'backorder_gz' still
 *      draws the dead SOLD OUT there, because its checkout still refuses it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// routes/retail.js and everything moved out of it (decisions §477): the
// sold-out policy and its pre-order questions are in lib/product-rows.js.
const RETAIL = require('./test-support/retail-source').retailSource();
// Comments explain this design at length and must never be what satisfies a
// rule about the code. Every structural assertion below runs against this.
const CODE   = RETAIL.replace(/^\s*\/\/.*$/gm, '');
const SHOP   = read('public', 'shop.html');
const ADMIN  = read('public', 'retail-admin.html');
const PRODJS = read('public', 'retail-admin', '09-products.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log(`\n${t}`); }

// Brace-matched slice of a named function, so the functions under test are the
// ones that ship rather than a paraphrase maintained beside them.
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

/* ── 1 · the policy resolver, run as shipped ───────────────────────────── */
section('1 · the policy, and the two questions it is asked');

const polCtx = {};
vm.createContext(polCtx);
vm.runInContext(
  [grab(RETAIL, 'effectiveOosPolicy'), grab(RETAIL, 'isPreorderPolicy'), grab(RETAIL, 'isLocalRunPreorder'),
    'this.effectiveOosPolicy = effectiveOosPolicy;',
    'this.isPreorderPolicy = isPreorderPolicy;',
    'this.isLocalRunPreorder = isLocalRunPreorder;'].join('\n'),
  polCtx);
const { effectiveOosPolicy, isPreorderPolicy, isLocalRunPreorder } = polCtx;

it('the new mode survives the resolver instead of falling back to strict', () => {
  assert.strictEqual(effectiveOosPolicy({ oos_policy: 'backorder_all' }), 'backorder_all');
});
it('every mode that stood before it is untouched', () => {
  assert.strictEqual(effectiveOosPolicy({ oos_policy: 'backorder_gz' }), 'backorder_gz');
  assert.strictEqual(effectiveOosPolicy({ oos_policy: 'strict' }), 'strict');
  assert.strictEqual(effectiveOosPolicy({ oos_policy: 'always' }), 'always');
  assert.strictEqual(effectiveOosPolicy({}), 'strict');
  assert.strictEqual(effectiveOosPolicy({ is_batch_made: 1 }), 'backorder_gz');
  assert.strictEqual(effectiveOosPolicy({ oos_policy: 'nonsense' }), 'strict');
});
it('supplier-direct still outranks a stored policy, as it always did', () => {
  // The one case that could have been broken quietly: an operator setting the
  // new policy on a supplier item must not start it tracking stock.
  assert.strictEqual(
    effectiveOosPolicy({ ship_from_supplier: 1, oos_policy: 'backorder_all' }), 'always');
});
it('"may it be pre-ordered at all" is true of both backorder modes', () => {
  assert.ok(isPreorderPolicy('backorder_gz'));
  assert.ok(isPreorderPolicy('backorder_all'));
  assert.ok(!isPreorderPolicy('strict'));
  assert.ok(!isPreorderPolicy('always'));
});
it('…and "may the LOCAL RUN pre-order it" is true of exactly one', () => {
  /* THE WHOLE DISTINCTION. Collapsing these two questions into one flag is the
     mistake this policy invites: it would either open the run to backorder_gz
     (selling off a van with nothing on it) or keep it shut for backorder_all
     (the option would do nothing at all). */
  assert.ok(isLocalRunPreorder('backorder_all'));
  assert.ok(!isLocalRunPreorder('backorder_gz'));
  assert.ok(!isLocalRunPreorder('always'));
  assert.ok(!isLocalRunPreorder('strict'));
});

/* ── 2 · the operator's control ────────────────────────────────────────── */
section('2 · the control the operator actually sets');

it('the editor offers the third option, in both languages', () => {
  assert.ok(/<option value="backorder_all">Pre-order everywhere · 全国可预订（补货后发出）<\/option>/.test(ADMIN),
    'the option is on the When out of stock select');
});
it('…beside the two that stood before it, not instead of them', () => {
  assert.ok(/<option value="strict">/.test(ADMIN));
  assert.ok(/<option value="backorder_gz">/.test(ADMIN));
});
it('the help text says what it costs the shopper, not just what it does', () => {
  // A control that silently drops a delivery window is one an operator must be
  // able to read BEFORE setting it, not discover from a customer complaint.
  const tip = ADMIN.slice(ADMIN.indexOf('When out of stock · 缺货时'));
  const pop = tip.slice(0, tip.indexOf('</span></span></div>'));
  assert.ok(/Pre-order everywhere/.test(pop), 'the new mode is explained');
  assert.ok(/whole order waits and ships together/.test(pop), 'and the mixed-basket cost is named');
  assert.ok(/整单等补货后一并发货/.test(pop), 'and named in Chinese too');
});
it('the editor SAVES it — a select nothing persists is decoration', () => {
  assert.ok(/'backorder_all' \? 'backorder_all'/.test(PRODJS));
});
it('…and the route persists it rather than storing NULL', () => {
  assert.ok(/body\.oos_policy === 'backorder_all' \? 'backorder_all'/.test(CODE),
    'the whitelist in PATCH /products admits the new mode');
});
it('a supplier-direct product still forces "always", whatever the select says', () => {
  const at = PRODJS.indexOf("oos_policy: ckd('pd-ship-from-supplier') ? 'always'");
  assert.ok(at > -1, 'the supplier override still comes first');
});

/* ── 3 · the park, which is what makes the option honest ───────────────── */
section('3 · the checkout park — the promise behind the option');

it('RULE 2 — routing goes relaxed, or the shopper meets the shortage modal', () => {
  /* Without this the whole feature is invisible: routeOrder with the gate on
     hunts for a store holding the stock, finds none, and returns
     needs_fallback_confirmation — the 5-option modal — BEFORE the park below
     ever runs. The customer would be offered a pre-order and then told to pick
     a substitute. */
  assert.ok(/const preorderAllShort = !isPickup && resolved\.some\(/.test(CODE),
    'the short-line verdict is computed once, before routing');
  assert.ok(/ignoreStock: !stockGate \|\| preorderAllShort,/.test(CODE),
    'and routing reads it');
});
it('…and pickup is never relaxed by it', () => {
  // Collecting in person means the item is on the shelf; that is why pickup
  // gates stock even on a scheduled day.
  assert.ok(/const preorderAllShort = !isPickup &&/.test(CODE));
});
it('the park guard gained the third arm', () => {
  assert.ok(/\(!stockGate \|\| batchCoveredIds\.size \|\| preorderAllShort\)/.test(CODE),
    'a same-day order with such a line reaches the park at all');
  assert.ok(/shortHere\.every\(pid => isPreorderPolicy\(effectiveOosPolicy\(productById\.get\(pid\)\)\)\)/.test(CODE),
    'and only backorder lines may park, as before');
});
it('…and only a line the policy actually names may park past the gate', () => {
  assert.ok(/batchCoveredIds\.has\(pid\)\s*\|\| isLocalRunPreorder\(effectiveOosPolicy\(productById\.get\(pid\)\)\)/.test(CODE),
    'a short line that is neither dated nor opted-in still meets the modal');
});
it('RULE 3 — the park clears the window, the surcharge and the slot', () => {
  const at = CODE.indexOf("slotLabel         = 'Ships when restocked';");
  assert.ok(at > -1);
  const branch = CODE.slice(at - 260, at + 60);
  assert.ok(/if \(isWaitFlow \|\| isPreorderPark\) \{/.test(branch), 'the branch admits it');
  assert.ok(/scheduledFor      = null;/.test(branch), 'no delivery day is promised');
  assert.ok(/sameDaySurcharge  = 0;/.test(branch), 'and a same-day fee is refunded');
});
it('…and the persisted slot kind says restock, for the rider queue', () => {
  // planShipments and isQingyunSameCityToday both read this column; an undated
  // order that still said 'today' would enter the same-city rider queue.
  assert.ok(/: \(isWaitFlow \|\| isPreorderPark\) \? 'restock'/.test(CODE));
});
it('…and nothing is reserved, because nothing is on the shelf to hold', () => {
  assert.ok(/if \(!isWaitFlow && !isBatchPark && !isPreorderPark && \(stockGate \|\| strictItems\.length\)\) \{/.test(CODE));
});
it('RULE 4 — a line today\'s batch covers is DATED and keeps its window', () => {
  /* §80's ruling, which a product carrying BOTH settings could have silently
     undone: read off the policy alone, a batch-made 'backorder_all' row would
     strip the window from a park the batch was about to fill. */
  const at = CODE.indexOf('parkedForPreorderAll = shortHere.some(');
  assert.ok(at > -1);
  const body = CODE.slice(at, at + 200);
  assert.ok(/!batchCoveredIds\.has\(pid\)/.test(body), 'covered lines do not make the park undated');
  assert.ok(/isBatchPark = !isWaitFlow && stockGate && !!awaitingRestockPids && !parkedForPreorderAll;/.test(CODE),
    'and the two parks stay mutually exclusive');
});

/* ── 4 · the flag that reaches the clients ─────────────────────────────── */
section('4 · oos_preorder_local — the flag, and the rule that it travels');

it('every route that stamps oos_preorder stamps its companion', () => {
  /* THE §80 FAILURE MODE, REPEATED DELIBERATELY. `local_fresh_date` was added
     beside `oos_preorder` and one route forgot it; nothing threw, and a saved
     Quinoa Salad read as dead stock on the morning it was being cooked. The
     same shape of bug is available here, so the same shape of rule: if you
     stamp one, stamp the other. */
  const one   = (RETAIL.match(/\.oos_preorder = /g) || []).length;
  const other = (RETAIL.match(/\.oos_preorder_local = /g) || []).length;
  assert.ok(one > 0, 'the flag is stamped somewhere');
  assert.strictEqual(other, one,
    `oos_preorder stamped ${one}× but oos_preorder_local ${other}× — a client cannot tell the modes apart on the short route`);
});
it('the size rows read the policy BEFORE it is deleted off them', () => {
  // GET /products/:id deletes oos_policy from each variant, so a flag computed
  // after that delete would be silently false for every size.
  const at = CODE.indexOf('const vPol = effectiveOosPolicy(v);');
  const del = CODE.indexOf('delete v.oos_policy;');
  assert.ok(at > -1 && del > -1 && at < del, 'the policy is read first');
});
it('the checkout notice reaches a local-run shopper for this mode only', () => {
  const fn = CODE.slice(CODE.indexOf('function computePreorderNotice'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/localRunOnly = true;/.test(body),
    'the local run narrows the notice rather than killing it outright');
  assert.ok(/if \(localRunOnly && !isLocalRunPreorder\(pol\)\) return false;/.test(body),
    'a backorder_gz row beside it still says nothing, since its checkout still refuses it');
});

/* ── 5 · the storefront, run as shipped ────────────────────────────────── */
section('5 · the web storefront — RULE 5, the run opens for one mode only');

const shopCtx = { state: { lang: 'en', customer: null }, console };
vm.createContext(shopCtx);
vm.runInContext(
  // stockState builds the band, so both of its appenders come in AS SHIPPED
  // rather than stubbed — a stub here would let this suite and the page
  // disagree about the one thing the band says. The sandbox's `state` carries
  // no config, so slPreorderWindow answers null and nothing is appended: every
  // case below reads exactly as it did before §195.
  [grab(SHOP, 'oosBackorder'), grab(SHOP, 'oosPreorderLocal'),
    grab(SHOP, 'shopperOnLocalRun'),
    grab(SHOP, 'freshArrivalLabel'), grab(SHOP, 'withFreshArrival'),
    grab(SHOP, 'restockWindowLabel'), grab(SHOP, 'withRestockWindow'),
    grab(SHOP, 'slPreorderWindow'),
    'const SL_MONTHS_EN=[];',
    grab(SHOP, 'stockState')].join('\n'),
  shopCtx);

// A shopper whose default address rides the same-day local run.
const onRun = (v) => { shopCtx.state.customer = { addresses: [{ is_default: 1, local_run: v }] }; };
const ALL = { stock: 0, oos_policy: 'backorder_all', oos_preorder: 1, oos_preorder_local: 1 };
const GZO = { stock: 0, oos_policy: 'backorder_gz',  oos_preorder: 1, oos_preorder_local: 0 };

it('a local-run shopper may pre-order the new mode — live row, no dead pill', () => {
  onRun(true);
  const ss = shopCtx.stockState({ ...ALL });
  assert.strictEqual(ss.soldOut, false, 'the row stays alive');
  assert.strictEqual(ss.badge, 'PRE-ORDER');   // §195 renamed the band; the row is what is asserted
});
it('…and the SAME shopper still gets a dead SOLD OUT for the old mode', () => {
  onRun(true);
  const ss = shopCtx.stockState({ ...GZO });
  assert.strictEqual(ss.soldOut, true, 'backorder_gz is still refused on the run');
  assert.strictEqual(ss.badge, 'SOLD OUT');
});
it('an out-of-city shopper reads both as pre-orders, as they always did', () => {
  onRun(false);
  assert.strictEqual(shopCtx.stockState({ ...ALL }).soldOut, false);
  assert.strictEqual(shopCtx.stockState({ ...GZO }).soldOut, false);
});
it('a strict sold-out row is dead for everyone, whoever is reading', () => {
  const STRICT = { stock: 0, oos_policy: 'strict', oos_preorder: 0, oos_preorder_local: 0 };
  onRun(true);  assert.strictEqual(shopCtx.stockState({ ...STRICT }).soldOut, true);
  onRun(false); assert.strictEqual(shopCtx.stockState({ ...STRICT }).soldOut, true);
});
it('the new mode is never mistaken for a dated fresh meal', () => {
  // localFresh drives the shipping note's wording; a pre-order with no date
  // claiming it would promise a production day that does not exist.
  onRun(true);
  assert.strictEqual(shopCtx.stockState({ ...ALL }).localFresh, false);
});
it('the note on the page stops saying "outside Guangzhou" when it is not true', () => {
  assert.ok(/Out of stock now — pre-order; your whole order ships together once it’s back in stock\./.test(SHOP));
  assert.ok(/当前缺货，可预订，整单等补货后一并发货。/.test(SHOP));
  assert.ok(/orderable outside Guangzhou/.test(SHOP), 'and the backorder_gz note is untouched');
});
it('the client mirror falls back to the policy for an older payload', () => {
  assert.strictEqual(shopCtx.oosPreorderLocal({ oos_policy: 'backorder_all' }), true);
  assert.strictEqual(shopCtx.oosPreorderLocal({ oos_policy: 'backorder_gz' }), false);
  assert.strictEqual(shopCtx.oosPreorderLocal({}), false);
  assert.strictEqual(shopCtx.oosPreorderLocal(null), false);
  // …and the SERVER's answer wins where both are present.
  assert.strictEqual(shopCtx.oosPreorderLocal({ oos_policy: 'strict', oos_preorder_local: 1 }), true);
});

/* ── 6 · the mini app reads the same rule ──────────────────────────────── */
section('6 · the mini app — the same OR, on every surface that draws the pill');

const MINI = [
  ['pages/product/product.js',     2],
  ['pages/shop/shop.js',           1],
  ['pages/favorites/favorites.js', 2],
];
for (const [rel, n] of MINI) {
  it(`${rel} opens the run on the flag, ${n} site(s)`, () => {
    const src = read('miniapp', ...rel.split('/'));
    const hits = (src.match(/oos_preorder_local/g) || []).length;
    assert.strictEqual(hits, n, `expected ${n} site(s), found ${hits}`);
    // …and never INSTEAD of the date: a fresh meal keeps its own exemption.
    assert.ok(/local_fresh_date/.test(src), 'the §80 date exemption is still there');
  });
}
it('the add-on picker is deliberately NOT given the exemption', () => {
  /* RULE 1, at the surface. The add-on path hangs a line on an order whose day
     is already fixed and often already paid — there is no park to move it to,
     so localPreorderLine keeps refusing and this picker must not imply
     otherwise by learning the flag. */
  const src = read('miniapp', 'pages', 'add-to-order', 'add-to-order.js');
  assert.ok(!/oos_preorder_local/.test(src), 'the picker learns no local-run pre-order');
});

/* ── 7 · the Chinese is declared, per CLAUDE.md ────────────────────────── */
section('7 · the Chinese, declared rather than composed in silence');

it('every string §128 composed is written down in the vocabulary', () => {
  const vocab = read('docs', 'tacet-delivery-vocabulary.md');
  for (const s of ['全国可预订（补货后发出）', '当前缺货，可预订，整单等补货后一并发货。',
    '“全国可预订”不拦截广州当日']) {
    assert.ok(vocab.includes(s), `undeclared: ${s}`);
  }
});
it('…and the decision itself is recorded before the code that depends on it', () => {
  const dec = read('docs', 'tacet-consolidation-decisions.md');
  assert.ok(/## §128 —/.test(dec), '§128 has a section');
  assert.ok(/backorder_all/.test(dec), 'and it names the policy value');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
