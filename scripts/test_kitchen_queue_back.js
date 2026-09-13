#!/usr/bin/env node
/**
 * §115 — the two ways off a kitchen job, and the fact that neither one names
 * the screen it is already standing on.
 *
 *   node scripts/test_kitchen_queue_back.js
 *
 * Reported by Ash against a photograph of `PR-260913-001` open in the Kitchen
 * queue: "kit jen quote button is not clear." The chip under the title read
 * **Kitchen queue** — the same two words as the heading directly above it — and
 * it was the only door back to the list.
 *
 * WHAT IS PROTECTED HERE IS THAT THE DOORS KEEP DISAGREEING ABOUT WHERE THEY GO.
 * A label is one edit from being copied back onto the wrong control, and the
 * head's Back and the bar at the foot of the job are written in two different
 * places by two different mechanisms:
 *
 *   • the head is `SUBS.kitchenqueue` — `titleOf` (the request's number),
 *     `status` (its summary) and `cta` (Reprint), with NO `backLabel`, so Back
 *     keeps saying More and keeps meaning it;
 *   • the way back to the LIST is `kqBackBar()` at the foot of the body.
 *
 * AND THAT THE PHONE'S OWN BACK AGREES WITH THAT BAR. An open job is a state of
 * the queue screen, not a route, so it only closes on an edge swipe if
 * `layers()` says so — it did not, and the swipe threw the whole screen away and
 * landed on More, past the list. Both now call one function, and the last case
 * here is what stops a second copy of that logic appearing beside it.
 *
 * The functions are SLICED OUT OF THE SHIPPED FILE and run, not re-typed: a
 * restructure of the bar turns these red rather than leaving them passing
 * against a copy nobody ships.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

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

const ESC = "const escAttr=v=>String(v==null?'':v).replace(/&/g,'&amp;')"
  + ".replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');";

/* One job open, three more waiting behind it. The list rows carry only what the
   bar and the head read from them. */
const LIST = [{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
const ORDER = {
  id: 3,
  rs_number: 'PR-260913-001',
  purpose: 'shelf',
  sent_at: '2026-09-12 18:34:00',
  items: [{ id: 11, qty_requested: 2 }, { id: 12, qty_requested: 5 },
    { id: 13, qty_requested: 0 }],
};

/* The app's own globals that the sliced code reaches for, stubbed at the
   boundary: an icon is a mark of the right name, a tab bar is present or it is
   not, and T resolves the pair the way the shipped one does. */
function ctxFor(kq, { lang = 'en', tabs = 5 } = {}) {
  const ctx = {
    state: { kq: Object.assign({ tab: 'active', list: null, order: null, orderId: null, printing: false }, kq) },
    T: (en, cn) => (lang === 'en' ? en : cn),
    LANG: lang,
    ic: (name) => `<svg data-icon="${name}"></svg>`,
    navTabs: () => new Array(tabs).fill(0),
    /* kqWhen and krPurpose are §84/§61's and have their own suites; what this
       one asserts about the status line is that it is drawn from the request
       and only once the request has landed. */
    kqWhen: () => 'Yesterday 6:34 PM · ',
    krPurpose: () => (lang === 'en' ? 'For the shelf' : '上架备货'),
    xfrNum: (v) => Number(v || 0),
    SUBS: {},
    String, Number, Array, Boolean,
  };
  vm.createContext(ctx);
  return ctx;
}

const SRC = [ESC,
  sliceBlock(M, 'function kqItems(o)'),
  sliceBlock(M, 'function kqHeadOrder()'),
  sliceBlock(M, 'function kqDropOrder()'),
  sliceBlock(M, 'function kqBackBar()'),
  sliceBlock(M, 'SUBS.kitchenqueue='),
].join(';\n');

function run(kq, expr, opts) {
  const ctx = ctxFor(kq, opts);
  vm.runInContext(`${SRC};\nthis.__out = (${expr});`, ctx);
  return { out: ctx.__out, ctx };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the bar at the foot of the job');

it('goes back to the LIST, and says so by name', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST }, 'kqBackBar()');
  assert.ok(/APP\.cmd\('kqList'\)/.test(out), 'the bar closes the job rather than the screen');
  assert.ok(out.includes('Kitchen queue'), 'it names where it goes');
  assert.ok(/data-icon="chevron-left"/.test(out), 'and draws the mark that means back');
});

it('carries what is still waiting back there, this job excluded', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST }, 'kqBackBar()');
  assert.ok(/>3</.test(out), `three others are waiting, not four: ${out}`);
});

it('a job that is the last one on the list shows no count at all', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: [{ id: 3 }] }, 'kqBackBar()');
  assert.ok(!/class="num"/.test(out), 'nothing is waiting, so no numeral is drawn');
});

it('and nothing is counted on Done — a record is not a to-do', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST, tab: 'history' }, 'kqBackBar()');
  assert.ok(!/class="num"/.test(out), 'finished requests are not work waiting');
});

it('the safe area is paid for once: only where no tab bar holds it open', () => {
  const withBar = run({ orderId: 3, list: LIST }, 'kqBackBar()', { tabs: 5 }).out;
  const alone = run({ orderId: 3, list: LIST }, 'kqBackBar()', { tabs: 0 }).out;
  assert.ok(!/safe-area-inset-bottom/.test(withBar), 'the dock already holds that room');
  assert.ok(/safe-area-inset-bottom/.test(alone), 'with no dock the bar must hold it itself');
});

it('it speaks Chinese with the pair that is already live on this screen', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST }, 'kqBackBar()', { lang: 'zh' });
  assert.ok(out.includes('厨房制作队列'), out);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2 · the head of an open job');

it('the title is the request, not the name of the list it came from', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST }, 'SUBS.kitchenqueue.titleOf()');
  assert.strictEqual(out, 'PR-260913-001');
});

it('…and the list itself keeps the screen name', () => {
  const { out } = run({}, 'SUBS.kitchenqueue.titleOf()');
  assert.strictEqual(out, 'Kitchen queue');
});

it('the number is up before the fetch lands, read off the row in the list', () => {
  const { out } = run({ orderId: 3, order: null, list: [{ id: 3, rs_number: 'PR-260913-001' }] },
    'SUBS.kitchenqueue.titleOf()');
  assert.strictEqual(out, 'PR-260913-001', 'no flash of the screen\'s own name first');
});

it('the summary line is the head\'s, and counts only lines actually asked for', () => {
  const { out } = run({ orderId: 3, order: ORDER, list: LIST }, 'SUBS.kitchenqueue.status()');
  assert.ok(/2 items/.test(out), `a zero-qty line is not a line: ${out}`);
  assert.ok(/For the shelf/.test(out), 'what the request is for');
});

it('nothing is claimed about a request that has not arrived yet', () => {
  assert.strictEqual(run({ orderId: 3, order: null, list: LIST }, 'SUBS.kitchenqueue.status()').out, '');
  assert.strictEqual(run({}, 'SUBS.kitchenqueue.status()').out, '', 'nor over the list');
});

it('Reprint is the head\'s one action, and only over a job', () => {
  const open = run({ orderId: 3, order: ORDER, list: LIST }, 'SUBS.kitchenqueue.cta()').out;
  assert.ok(/APP\.cmd\('kqReprint'\)/.test(open));
  assert.ok(/Reprint/.test(open));
  assert.strictEqual(run({}, 'SUBS.kitchenqueue.cta()').out, '', 'the list has nothing to reprint');
});

it('mid-print it says so and refuses a second tap', () => {
  const out = run({ orderId: 3, order: ORDER, list: LIST, printing: true }, 'SUBS.kitchenqueue.cta()').out;
  assert.ok(/disabled/.test(out) && /Printing…/.test(out), out);
});

it('Back keeps saying More: the head must NOT claim the list', () => {
  // The whole defect was two controls naming one place. backLabel is the hook
  // that would put "Kitchen queue" back into the head, over a screen whose way
  // to the list is the bar at the foot of it.
  const sub = sliceBlock(M, 'SUBS.kitchenqueue=');
  assert.ok(!/backLabel/.test(sub), 'no backLabel — the head leaves for the menu it was opened from');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3 · the body between them');

it('the job carries no second control named after the screen', () => {
  const scr = sliceBlock(M, 'function screenKitchenQueue()');
  const body = scr.slice(scr.indexOf('if(k.orderId!=null){'), scr.indexOf('const seg='));
  assert.ok(!/Kitchen queue/.test(body),
    'the only thing that says Kitchen queue over a job is the bar, drawn by kqBackBar()');
  assert.ok(/kqBackBar\(\)/.test(body), 'and it is drawn');
});

it('there is a way back while the request is still coming', () => {
  const scr = sliceBlock(M, 'function screenKitchenQueue()');
  const loading = scr.slice(scr.indexOf('if(k.busy&&!k.order)'));
  assert.ok(/kqBackBar\(\)/.test(loading.slice(0, loading.indexOf('\n'))),
    'a slow network must not strand an operator who opened the wrong job');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4 · the phone\'s own Back lands where the bar does');

it('an open job is a layer, so the edge swipe closes it and not the screen', () => {
  const L = sliceBlock(M, 'function layers()');
  assert.ok(/if\(state\.kq\.orderId!=null\) L\.push\(kqDropOrder\)/.test(L),
    'without this the swipe lands on More, straight past the list');
});

it('the gesture and the bar call ONE function — no second copy to drift', () => {
  const L = sliceBlock(M, 'function layers()');
  assert.ok(!/state\.kq\.orderId=null/.test(L), 'layers() must not clear the job by hand');
  assert.ok(/reg\('kqList', \(\)=>\{ kqDropOrder\(\); render\(\); \}\);/.test(M),
    'the bar closes the job through the same function');
  // Exactly two places clear it: kqDropOrder, and entering the route (which
  // resets the whole screen by design — see the comment there).
  const clears = [...M.matchAll(/orderId=null/g)].length;
  const kqClears = [...M.matchAll(/k\.orderId=null/g)].length;
  assert.ok(kqClears >= 1, 'kqDropOrder clears it');
  assert.ok(clears > 0, `sanity: ${clears}`);
});

it('closing the job re-asks the queue, so the list is not the stale one', () => {
  const { ctx } = run({ orderId: 3, order: ORDER, list: LIST, tried: true }, 'kqDropOrder()');
  assert.strictEqual(ctx.state.kq.orderId, null);
  assert.strictEqual(ctx.state.kq.order, null);
  assert.strictEqual(ctx.state.kq.tried, false, '§71 — what arrived while the job was open');
});

it('…but Done is not re-asked: it is a record, and it did not change', () => {
  const { ctx } = run({ orderId: 3, order: ORDER, list: LIST, tried: true, tab: 'history' }, 'kqDropOrder()');
  assert.strictEqual(ctx.state.kq.tried, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
