#!/usr/bin/env node
/**
 * Offline self-test for the phone dashboard (public/m.html) — its money
 * formatting, its Today deltas, and its Needs-you card.
 *
 *   node scripts/test_phone_dashboard.js
 *
 * Why this file exists. m.html is a standalone app: its own renderer, its own
 * state, no module boundary with public/retail-admin/. That freedom is how it
 * drifted. Three things were shipping wrong at once and all three were visible
 * in a single screenshot:
 *
 *   1. ¥3,271.4 — money with ONE decimal, because the formatter capped the
 *      fraction without padding it.
 *   2. "−23.8% vs a typical day" — a raw unrounded delta against a baseline the
 *      line never named, and under Avg. order the comparison label with no
 *      comparison at all beneath it.
 *   3. A "Needs you" card of three hardcoded rows whose fallback values were
 *      SAMPLE NUMBERS, so an unloaded phone stated a confident 2 that meant
 *      nothing — while the fires that matter (a payment nobody accepted, a
 *      delivery gone wrong, a refund waiting) were not on the screen at all.
 *
 * No network, no browser. Every function under test is sliced out of the
 * shipped m.html and evaluated against stubs, so editing the real file is what
 * moves these tests — the same technique as scripts/test_needs_point_client.js.
 *
 * What it locks down:
 *   1. MONEY — whole or to the fen, never one decimal; glance cards round.
 *   2. THE DELTA — whole percents, a named baseline, and silence where there is
 *      nothing to compare. The desktop's rules (dashSetDelta), reproduced.
 *   3. THE CARD — built from /dashboard/ops, brick before amber, no row for a
 *      zero count, and "not loaded" told apart from "all clear".
 *   4. THE DOORS — every fire points at a filter this screen actually has.
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
const M_HTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

/** A braced block (function or const arrow), anchor → its matching `}`. */
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

/** From `anchor` to the end of the line the terminating `;` sits on. */
function sliceLines(src, anchor, lines) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  let i = start;
  for (let n = 0; n < lines; n++) {
    i = src.indexOf('\n', i + 1);
    assert.notStrictEqual(i, -1, `ran off the end after ${anchor}`);
  }
  return src.slice(start, i);
}

// ── The shipped functions, lifted out of m.html ───────────────────────────
const MONEY_SRC = sliceLines(M_HTML, 'const money=(cur,n)=>', 2);
const MONEY0_SRC = sliceLines(M_HTML, 'const money0=(cur,n)=>', 1);
const DOW_SRC = sliceLines(M_HTML, "const DOW_ABBR_EN=", 2);
const DELTA_SRC = sliceBlock(M_HTML, 'function deltaText(cur, base, bl)');
const AGE_SRC = sliceLines(M_HTML, 'const AGE=(m)=>', 1);
const OLDEST_SRC = sliceBlock(M_HTML, 'function oldestMins(items)');
const FIRES_SRC = sliceBlock(M_HTML, 'function homeFires()');
const BLOCK_SRC = sliceBlock(M_HTML, 'function attnBlock(fires)');

// One context carrying the real functions and the smallest honest stubs: T
// resolves to the English half (the assertions read it), ic() is an icon.
function ctxWith(state) {
  const ctx = { state, T: (en) => en, ic: () => '<svg/>', Date, Math, Number, String, JSON, isNaN };
  vm.createContext(ctx);
  // `const` is block-scoped to the script and never lands on the context object,
  // unlike a function declaration — so the arrow-function helpers are published
  // explicitly. Without this they evaluate fine and are simply unreachable.
  new vm.Script([MONEY_SRC, MONEY0_SRC, DOW_SRC, DELTA_SRC, AGE_SRC, OLDEST_SRC, FIRES_SRC, BLOCK_SRC]
    .join(';\n') + ';\nthis.money=money; this.money0=money0; this.AGE=AGE;').runInContext(ctx);
  return ctx;
}
const C = ctxWith({});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n1 · money — whole, or to the fen, never in between');

it('a value with a single decimal digit is padded, not truncated', () => {
  // The exact figures from the screenshot that started this.
  assert.strictEqual(C.money('¥', 3271.4), '¥3,271.40');
  assert.strictEqual(C.money('¥', 7296.7), '¥7,296.70');
});

it('a whole value stays whole — no ".00" tax on every price', () => {
  assert.strictEqual(C.money('¥', 12840), '¥12,840');
  assert.strictEqual(C.money('¥', 0), '¥0');
});

it('two decimals survive', () => {
  assert.strictEqual(C.money('¥', 270.25), '¥270.25');
});

it('the glance cards round to whole yuan', () => {
  // A day's takings on a phone tile is read, not reconciled.
  assert.strictEqual(C.money0('¥', 3271.4), '¥3,271');
  assert.strictEqual(C.money0('¥', 7296.7), '¥7,297');
});

it('a missing or junk amount is ¥0, never NaN', () => {
  assert.strictEqual(C.money('¥', null), '¥0');
  assert.strictEqual(C.money('¥', undefined), '¥0');
  assert.strictEqual(C.money0('¥', null), '¥0');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · the delta — the desktop’s rules, on a screen with no hover');

const BL = { days: 3, weekday: 6, clipped: false };   // three Saturdays behind us

it('a whole percent, never the raw decimal', () => {
  // "−23.8%" claims a precision twenty orders cannot support.
  assert.strictEqual(C.deltaText(20, { delta: -23.8 }, BL), '▼ 24% vs last 3 Sat');
  assert.strictEqual(C.deltaText(7296, { delta: 78.2 }, BL), '▲ 78% vs last 3 Sat');
});

it('it names the baseline instead of saying "a typical day"', () => {
  assert.ok(/vs last 3 Sat$/.test(C.deltaText(1, { delta: 5 }, BL)));
  assert.strictEqual(C.deltaText(1, { delta: 5 }, { days: 1, weekday: 1, clipped: false }),
    '▲ 5% vs last 1 Mon');
});

it('a clipped baseline says so — a slow morning is not a collapse', () => {
  const t = C.deltaText(1, { delta: -40 }, { ...BL, clipped: true });
  assert.ok(/by now/.test(t), `no "by now" in: ${t}`);
});

it('nothing yet today is a calm dash, never ▼100%', () => {
  assert.strictEqual(C.deltaText(0, { delta: -100 }, BL), 'none yet today');
});

it('no same-weekday history reads as new, not as a percentage of nothing', () => {
  assert.strictEqual(C.deltaText(5, { delta: null }, BL), 'new');
  assert.strictEqual(C.deltaText(5, { delta: 10 }, null), 'new');
  assert.strictEqual(C.deltaText(5, { delta: 10 }, { days: 0 }), 'new');
});

it('flat is ±0%, not an arrow in either direction', () => {
  assert.strictEqual(C.deltaText(5, { delta: 0.2 }, BL), '±0% vs last 3 Sat');
});

it('a metric with NO baseline says nothing at all', () => {
  // Average order value has none. The tile used to print the comparison label
  // with no comparison under it, which reads as a broken tile.
  assert.strictEqual(C.deltaText(270, undefined, BL), '');
  assert.strictEqual(C.deltaText(270, null, BL), '');
});

it('the Avg. order tile is wired to that silence', () => {
  assert.ok(/T\('Avg\. order','客单价'\), money\(CUR, ord\? rev\/ord : 0\), ''\]/.test(M_HTML),
    'Avg. order must pass an empty delta, not a bare label');
});

it('a tile with no delta renders no line for one', () => {
  // Anchored on the conditional, not on the tile's styling — the phone's markup
  // is redesigned often and this assertion is about the logic.
  assert.ok(/\$\{d\?`<span class="num"[^`]*`:''\}/.test(M_HTML),
    'the delta span must be conditional, or an empty one still takes the space');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · Needs you — the same fires the desktop shows');

const opsWith = (o) => ctxWith({ liveOps: o, liveAttn: {} });
const OPS0 = {
  payment_mismatch: { count: 0, items: [] }, payment_unconfirmed: { count: 0, unread: 0, items: [] },
  delivery_alerts: { count: 0, items: [] }, refunds: { count: 0, items: [] },
  awaiting_restock: { count: 0, items: [] }, invoices: { count: 0, items: [] },
  low_stock: { count: 0, items: [] }, out_of_stock: { count: 0, items: [] },
};

it('not loaded is null — which is not the same as all clear', () => {
  const c = ctxWith({ liveOps: null });
  assert.strictEqual(c.homeFires(), null);
  assert.ok(/Checking/.test(c.attnBlock(null)), 'an unloaded card must say it is still looking');
});

it('all clear removes the block from the screen entirely', () => {
  const c = opsWith(OPS0);
  assert.strictEqual(c.homeFires().length, 0);
  assert.strictEqual(c.attnBlock([]), '', 'a shorter Home IS the good news');
});

it('a zero count never becomes a row', () => {
  const c = opsWith({ ...OPS0, refunds: { count: 0, items: [] } });
  assert.strictEqual(c.homeFires().length, 0);
});

it('the payment fires are on this screen at all — they were not before', () => {
  const c = opsWith({ ...OPS0,
    payment_mismatch: { count: 1, items: [{ waiting_since: new Date(Date.now() - 4 * 3600e3).toISOString() }] },
    payment_unconfirmed: { count: 3, unread: 2, items: [] } });
  const labels = c.homeFires().map(f => f.label);
  assert.ok(labels.includes("Payment doesn't match"), labels.join(' | '));
  assert.ok(labels.includes('Payments to confirm'), labels.join(' | '));
});

it('brick sorts above amber', () => {
  const c = opsWith({ ...OPS0,
    refunds: { count: 2, items: [] },
    delivery_alerts: { count: 1, items: [] },
    payment_mismatch: { count: 1, items: [] } });
  assert.deepStrictEqual([...c.homeFires().map(f => f.sev)], ['brick', 'brick', 'amber']);
});

it('the unconfirmed row names the unreadable ones', () => {
  const c = opsWith({ ...OPS0, payment_unconfirmed: { count: 5, unread: 2, items: [] } });
  const f = c.homeFires().find(x => x.label === 'Payments to confirm');
  assert.strictEqual(f.sub, "2 couldn't be read");
  assert.strictEqual(f.n, 5);
});

it('all-readable says nothing about unreadable ones', () => {
  const c = opsWith({ ...OPS0, payment_unconfirmed: { count: 5, unread: 0, items: [] } });
  const f = c.homeFires().find(x => x.label === 'Payments to confirm');
  assert.ok(!/read/.test(f.sub || ''), `"0 couldn't be read" is a sentence nobody needs: ${f.sub}`);
});

it('a queue states the age of its oldest, and a clockless row does not vote', () => {
  const c = opsWith({ ...OPS0, refunds: { count: 2, items: [
    { waiting_since: new Date(Date.now() - 30 * 60e3).toISOString() },
    { waiting_since: null },
    { waiting_since: new Date(Date.now() - 5 * 3600e3).toISOString() },
  ] } });
  assert.strictEqual(c.homeFires()[0].sub, '5h', 'the oldest wins, and the null one is skipped');
});

it('stock states its condition, never an age', () => {
  const c = opsWith({ ...OPS0, out_of_stock: { count: 3, items: [] }, low_stock: { count: 8, items: [] } });
  const f = c.homeFires().find(x => x.label === 'Restock needed');
  assert.strictEqual(f.n, 3, 'the pill counts what is actually OUT');
  assert.strictEqual(f.sub, 'out of stock, 8 running low');
});

it('the rendered row carries the count and the severity tint', () => {
  const c = opsWith({ ...OPS0, payment_mismatch: { count: 2, items: [] } });
  const html = c.attnBlock(c.homeFires());
  assert.ok(/var\(--brick\)/.test(html), 'a brick fire must be tinted brick');
  assert.ok(/>2</.test(html), 'the count is missing from the row');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4 · the doors — every fire lands somewhere that exists');

it('no fire points at a filter this screen does not have', () => {
  // goStatus sets state.statusF, which ordersFiltered matches against o.kind
  // (or 'all'/'new'). A key with no chip is a row that appears to do nothing.
  const c = opsWith({ ...OPS0,
    payment_mismatch: { count: 1, items: [] }, payment_unconfirmed: { count: 1, unread: 0, items: [] },
    delivery_alerts: { count: 1, items: [] }, refunds: { count: 1, items: [] },
    awaiting_restock: { count: 1, items: [] } });
  const wanted = c.homeFires()
    .map(f => (/goStatus','([a-z_]+)'/.exec(f.cmd) || [])[1])
    .filter(Boolean);
  assert.ok(wanted.length >= 5, `expected every queue fire to deep-link, got ${wanted.length}`);
  for (const key of new Set(wanted)) {
    assert.ok(new RegExp(`\\{key:'${key}'`).test(M_HTML), `no chip with key '${key}' on the Orders screen`);
  }
});

it('Pending has a chip now — the payment fires had nowhere to land', () => {
  assert.ok(/\{key:'pending',en:'Pending'/.test(M_HTML));
  assert.ok(/sCount\('pending_payment'/.test(M_HTML), 'its badge must read the real count');
});

it('goStatus switches tab, narrows, AND refetches', () => {
  const src = (/reg\('goStatus',[^\n]*/.exec(M_HTML) || [''])[0];
  assert.ok(/state\.tab='orders'/.test(src), 'it must land on Orders');
  assert.ok(/state\.statusF=f/.test(src), 'a door that only switched tabs shows the whole list');
  // The filter is the SERVER's on this screen, so setting statusF alone would
  // leave whatever page was last fetched on display under a new chip.
  assert.ok(/loadOrdersPage\(\)/.test(src), 'the narrowed list must be refetched');
});

it('the sample-number fallbacks are gone', () => {
  // The card used to fall back to 2 / 3 / 1 — confident numbers that meant
  // nothing. Nothing may put a literal count on this card again.
  assert.ok(!/A\.ship!=null\?A\.ship:2/.test(M_HTML), 'the fake shipment count is back');
  assert.ok(!/A\.reviews!=null\?A\.reviews:3/.test(M_HTML), 'the fake review count is back');
  assert.ok(!/A\.low!=null\?A\.low:1/.test(M_HTML), 'the fake low-stock count is back');
});

it('the card is fed by the same endpoint the desktop card uses', () => {
  assert.ok(/api\('\/dashboard\/ops\?preview=8'\)/.test(M_HTML),
    'the phone must read /dashboard/ops, or the two screens can disagree');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
