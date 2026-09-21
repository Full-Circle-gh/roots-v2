#!/usr/bin/env node
/**
 * The courier block's three ways of saying "no rider yet".
 *
 *   node scripts/test_qingyun_wait_states.js
 *
 * No network, no DB, no browser. renderQyShipFrom is sliced out of
 * public/retail-admin/04-orders.js verbatim and evaluated against stubs, so
 * this reads the shipped source rather than a copy of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A queue row with no copy on the courier platform has four shapes, and until
 * 2026-09-21 three of them printed the same five words — "Queued for push…":
 *
 *   pending / processing  nobody has drained it yet
 *   ready                 checked, and deliberately held until staff call the
 *                         delivery. THE HEALTHY RESTING STATE of a booked order
 *   error / skipped       refused (already had its own surface)
 *
 * So an order working exactly as designed and an order nothing had looked at
 * were indistinguishable on screen. On 2026-09-21 that cost a store a call
 * during trading hours about a same-city delivery that was not broken: the
 * drawer was opened four minutes after payment, mid-geocode, and said the one
 * thing it says for everything.
 *
 * The queue wait now carries its AGE for the same reason — two minutes and two
 * hours are different facts and were the same sentence.
 *
 * WHAT IS LOCKED
 *   1. the four states render four different things, and each is non-vacuous:
 *      flip the one flag and the wording falls back;
 *   2. the parked surfaces (a point, a choice) still win over all of it;
 *   3. the new pair carries its Chinese, and the Chinese is the live one;
 *   4. the two fields the client reads are the two the server sends — a rename
 *      on either side of that seam is silent otherwise, and its failure mode is
 *      the bug this whole change exists to remove.
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

const ROOT = path.join(__dirname, '..');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

// Brace counting, deliberately naive: a mis-slice cannot make a test pass
// quietly, because the result is then fed to vm.Script and fails to parse.
function slice(src, anchor) {
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

const RENDER = slice(ORDERS_JS, 'function renderQyShipFrom(o)');

// Run the REAL renderer over one drawer payload. `lang` picks which half of
// every bilingual pair comes back, so the Chinese can be asserted too.
// `src` lets a test mutate the shipped source to prove it is not vacuous.
function render(shipFrom, { lang = 'en', src = RENDER, order = {} } = {}) {
  const ctx = {
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    // The drawer's own ago-renderer, stubbed to a fixed answer: this suite is
    // about WHICH sentence appears, not about how a duration is phrased.
    courierAgo: () => '4m ago',
    // The two parked surfaces are other files' business; a marker is enough to
    // prove the branch was taken.
    renderQyPointSurface: () => '<<POINT SURFACE>>',
    renderQyCandidateSurface: () => '<<CHOICE SURFACE>>',
  };
  vm.createContext(ctx);
  new vm.Script(`${src}\n_out = renderQyShipFrom(o);`).runInContext(
    Object.assign(ctx, { o: Object.assign({ id: 7, store_code: 'tianhe' }, order, { qingyun_ship_from: shipFrom }) })
  );
  return ctx._out;
}

// A queue row with no copy on the platform, in its healthiest shape. Each test
// below changes exactly one thing about it.
const base = () => ({
  store_code: 'tianhe', name_en: 'Tianhe', name_cn: '天河',
  qingyun_order_id: null, push_status: 'pending', push_attempts: 0,
  push_error: null, push_held: false, push_held_since: null,
  needs_attention: false, awaiting_point: false, awaiting_choice: false,
  candidates: [], awaiting_dispatch: false, push_since: '2026-09-21 02:09:07',
});

console.log('\nrenderQyShipFrom — the four ways to say "no rider yet"\n');

it('a booked order says no courier has been called, not that it is queued', () => {
  const html = render(Object.assign(base(), { push_status: 'ready', awaiting_dispatch: true }));
  assert.ok(html.includes('No courier called yet'), 'the booked wording is missing');
  assert.ok(!html.includes('Queued for push'), 'a booked order still reads as a queue wait');
});

it('…and that is not vacuous: without the flag it falls back to the queue wait', () => {
  const html = render(Object.assign(base(), { push_status: 'ready', awaiting_dispatch: false }));
  assert.ok(html.includes('Queued for push'), 'the fallback wording is missing');
  assert.ok(!html.includes('No courier called yet'), 'the booked wording leaked without its flag');
});

it('a booked order explains that comparing couriers is what calls the rider', () => {
  const html = render(Object.assign(base(), { push_status: 'ready', awaiting_dispatch: true }));
  assert.ok(/Compare couriers below/.test(html), 'the booked note does not say what to do next');
  assert.ok(/nothing is charged until you dispatch/.test(html), 'the booked note does not say it is free');
});

it('a plain queue wait carries its age', () => {
  const html = render(base());
  assert.ok(html.includes('Queued for push'), 'the queue wording is missing');
  assert.ok(html.includes('4m ago'), 'the queue wait does not say how long it has waited');
});

it('…and a row with no timestamp simply omits the age rather than printing junk', () => {
  const html = render(Object.assign(base(), { push_since: null }));
  assert.ok(html.includes('Queued for push'), 'the queue wording is missing');
  assert.ok(!/undefined|null|NaN/.test(html), 'a missing timestamp leaked into the page');
});

it('the age is spent only on the plain wait — a booked order does not carry one', () => {
  const html = render(Object.assign(base(), { push_status: 'ready', awaiting_dispatch: true }));
  assert.ok(!html.includes('4m ago'), 'the booked state printed a queue age');
});

it('a refusal still outranks everything and keeps its Retry', () => {
  const html = render(Object.assign(base(), {
    push_status: 'error', needs_attention: true, awaiting_dispatch: true, push_error: 'bad phone',
  }));
  assert.ok(html.includes('Push refused'), 'the refusal wording is missing');
  assert.ok(html.includes('qyRetryPush'), 'the Retry button is missing from a refused row');
  assert.ok(!html.includes('No courier called yet'), 'a refusal read as a booked order');
});

it('a geocoder hold still outranks the booked wording', () => {
  const html = render(Object.assign(base(), {
    push_held: true, push_held_since: '2026-09-21 02:09:07', awaiting_dispatch: true,
  }));
  assert.ok(html.includes('Held'), 'the hold wording is missing');
  assert.ok(!html.includes('No courier called yet'), 'a hold read as a booked order');
});

it('a row waiting on a delivery point still gets the map, not a status line', () => {
  const html = render(Object.assign(base(), { awaiting_point: true, awaiting_dispatch: true }));
  assert.strictEqual(html, '<<POINT SURFACE>>');
});

it('a row waiting on a choice still gets the list, not a status line', () => {
  const html = render(Object.assign(base(), {
    awaiting_choice: true, candidates: [{ idx: 0, lat: 23.09, lng: 113.26 }], awaiting_dispatch: true,
  }));
  assert.strictEqual(html, '<<CHOICE SURFACE>>');
});

console.log('\nThe Chinese half\n');

it('the booked pair carries Chinese, and it is the live 尚未呼叫运力', () => {
  const html = render(Object.assign(base(), { push_status: 'ready', awaiting_dispatch: true }), { lang: 'cn' });
  assert.ok(html.includes('尚未呼叫运力'), 'the booked state has no Chinese half');
});

it('尚未呼叫运力 and 不产生费用 were already live elsewhere — this mints neither', () => {
  // The ship-from confirm body has said both since §—, and reusing it is what
  // keeps this file from growing a second way to say the same thing. Counting
  // across the shipped tree is the same structural gate §202 introduced.
  for (const word of ['尚未呼叫运力', '不产生费用', '查看运力比价', '已核对']) {
    const n = (ORDERS_JS.match(new RegExp(word, 'g')) || []).length;
    assert.ok(n >= 2, `${word} appears ${n}× in the shipped drawer — it should be reused, not minted`);
  }
});

console.log('\nThe server/client seam\n');

it('the server sends the two fields the drawer reads', () => {
  // A rename on either side is silent, and its failure mode is precisely the
  // bug this change removes: the drawer falls back to the queue wait and a
  // healthy booked order reads as one nobody has touched.
  assert.ok(/awaiting_dispatch:\s*qingyunQueue\.awaitingDispatch\(q\)/.test(RETAIL_JS),
    'routes/retail.js no longer reports awaiting_dispatch from the shared predicate');
  assert.ok(/push_since:\s*q\.created_at/.test(RETAIL_JS),
    'routes/retail.js no longer reports push_since');
  assert.ok(RENDER.includes('sf.awaiting_dispatch'), 'the drawer no longer reads awaiting_dispatch');
  assert.ok(RENDER.includes('sf.push_since'), 'the drawer no longer reads push_since');
});

it('awaiting_dispatch is the queue module\'s predicate, not a second copy of the rule', () => {
  const qq = require(path.join(ROOT, 'lib', 'qingyun-queue.js'));
  assert.strictEqual(qq.awaitingDispatch({ status: 'ready', qingyun_order_id: null }), true);
  assert.strictEqual(qq.awaitingDispatch({ status: 'pending', qingyun_order_id: null }), false);
  // A row that already produced a copy is never "waiting to be called" — the
  // drawer takes the other branch entirely, and the predicate must agree.
  assert.strictEqual(qq.awaitingDispatch({ status: 'ready', qingyun_order_id: '21016' }), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
