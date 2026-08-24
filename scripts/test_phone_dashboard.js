#!/usr/bin/env node
/**
 * Offline self-test for three things on the phone dashboard (public/m.html):
 * its money formatting, its Today deltas, and the amber half of the payment
 * queue on its Needs-you card.
 *
 *   node scripts/test_phone_dashboard.js
 *
 * SCOPE, deliberately narrow. m.html is a standalone app under active redesign
 * by its own line of work, and that work owns the shape of Home: opsFires(),
 * the row markup, the ordersGo doors, the Pending chip. This file asserts none
 * of that — scripts/test_mobile_screens.js renders every screen and is the
 * suite that guards it. What is asserted here is only what this change put in:
 *
 *   1. money() — it printed ¥3,271.4, one decimal, because the formatter capped
 *      the fraction without padding it.
 *   2. deltaText() — the tiles read "−23.8% vs a typical day": a raw unrounded
 *      delta against a baseline the line never named, and under Avg. order the
 *      comparison label with nothing beneath it at all.
 *   3. The `payment_unconfirmed` fire — the amber sibling of "Payment doesn't
 *      match", covering a proof that was verified-but-unflipped, unreadable, or
 *      never read. Asserted inside the REAL opsFires(), so a restructure of that
 *      function fails here rather than leaving this green against a copy.
 *
 * No network, no browser: each function is sliced out of the shipped file and
 * evaluated against stubs, the same technique as
 * scripts/test_needs_point_client.js.
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

/** A braced block — declaration or const arrow — anchor → its matching `}`. */
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

/** `anchor` through the end of the Nth line after it. */
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

// ── The shipped code under test, plus the helpers opsFires leans on ───────
const SRC = [
  sliceLines(M_HTML, 'const money=(cur,n)=>', 2),
  sliceLines(M_HTML, 'const money0=(cur,n)=>', 1),
  sliceLines(M_HTML, 'const DOW_ABBR_EN=', 2),
  sliceBlock(M_HTML, 'function deltaText(cur, base, bl)'),
  // _date is a const arrow, not a declaration, but its body is a braced block
  // all the same — so slice it by its braces. It was one line until the phone
  // learned to stamp zoneless timestamps with Z; a fixed line count silently
  // cut the body in half the moment it grew.
  sliceBlock(M_HTML, 'const _date=v=>'),
  sliceBlock(M_HTML, 'function oldestMins(items)'),
  sliceBlock(M_HTML, 'function oldestOf(items)'),
  sliceBlock(M_HTML, 'function opsFires()'),
].join(';\n');

function ctxWith(state) {
  const ctx = { state, T: (en) => en, Date, Math, Number, String, isNaN };
  vm.createContext(ctx);
  // `const` is block-scoped to the script and never lands on the context
  // object, unlike a function declaration — so the arrow helpers are published
  // explicitly. Without this they evaluate fine and are simply unreachable.
  new vm.Script(SRC + ';\nthis.money=money; this.money0=money0;').runInContext(ctx);
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
  assert.strictEqual(C.money0('¥', 3271.4), '¥3,271');
  assert.strictEqual(C.money0('¥', 7296.7), '¥7,297');
});

it('a missing or junk amount is ¥0, never NaN', () => {
  assert.strictEqual(C.money('¥', null), '¥0');
  assert.strictEqual(C.money('¥', undefined), '¥0');
  assert.strictEqual(C.money0('¥', null), '¥0');
});

it('the two glance surfaces are wired to the rounding one', () => {
  // The recap's own money helper. This used to name the "夜间营收" row, which was
  // the phone's INVENTED overnight-revenue metric — that card is gone (the Recap
  // now reads the activity feed since you left, like the desktop's). The rule it
  // was guarding is unchanged and still worth guarding: every yuan figure the
  // recap prints goes through money0, so none of them grows a decimal tail.
  assert.ok(/const m=n=>money0\(CUR,n\);/.test(M_HTML), 'the recap rows');
  assert.ok(/money0\(CUR,rev\), deltaText/.test(M_HTML), 'the Today revenue tile');
});

it('the recap prints no money any other way', () => {
  // Belt and braces on the above: inside recapRows, every amount is m(...) —
  // a bare money() there would put "¥3,271.40" back on the hero.
  const body = M_HTML.slice(M_HTML.indexOf('function recapRows()'), M_HTML.indexOf('function recapTitle()'));
  assert.ok(body.length > 200, 'found recapRows');
  assert.ok(!/[^0]money\(CUR/.test(body), 'recapRows uses only the rounding helper');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · the delta — the desktop’s rules, on a screen with no hover');

const BL = { days: 3, weekday: 6, clipped: false };   // three Saturdays behind us

/* deltaText mints its pair inside the vm realm, so the array carries THAT
   realm’s Array.prototype and deepStrictEqual refuses it on prototype alone.
   Copy it across before comparing; null (no baseline at all) passes through. */
const delta = (...a) => { const r = C.deltaText(...a); return Array.isArray(r) ? Array.from(r) : r; };

/* deltaText returns a bilingual PAIR now, not one resolved string. The Today
   tiles are built once at boot and only resolve it with T(...d) at render — a
   pre-resolved string froze every comparison in whatever language the app
   happened to boot in. Both halves are asserted here: a translation dropped on
   one side is the same bug wearing the other language. */
it('a whole percent, never the raw decimal', () => {
  // "−23.8%" claims a precision twenty orders cannot support.
  assert.deepStrictEqual(delta(20, { delta: -23.8 }, BL),
    ['▼ 24% vs last 3 Sat', '▼ 24% 较前 3 个周六']);
  assert.deepStrictEqual(delta(7296, { delta: 78.2 }, BL),
    ['▲ 78% vs last 3 Sat', '▲ 78% 较前 3 个周六']);
});

it('it names the baseline instead of saying "a typical day"', () => {
  assert.deepStrictEqual(delta(1, { delta: 5 }, { days: 1, weekday: 1, clipped: false }),
    ['▲ 5% vs last 1 Mon', '▲ 5% 较前 1 个周一']);
  // The CALL, not the phrase — the comment above deltaText quotes the old
  // label to explain what it replaced, and matching prose would fail on that.
  assert.ok(!/T\('vs a typical day'/.test(M_HTML), 'the vague label is back in the code');
});

it('a clipped baseline says so — a slow morning is not a collapse', () => {
  const [en, cn] = delta(1, { delta: -40 }, { ...BL, clipped: true });
  assert.ok(/ by now$/.test(en), en);
  assert.ok(/同一时段$/.test(cn), cn);
});

it('nothing yet today is a calm dash, never ▼100%', () => {
  assert.deepStrictEqual(delta(0, { delta: -100 }, BL),
    ['none yet today', '今日暂无']);
});

it('no same-weekday history reads as new, not as a percentage of nothing', () => {
  assert.deepStrictEqual(delta(5, { delta: null }, BL), ['new', '新']);
  assert.deepStrictEqual(delta(5, { delta: 10 }, null), ['new', '新']);
  assert.deepStrictEqual(delta(5, { delta: 10 }, { days: 0 }), ['new', '新']);
});

it('flat is ±0%, not an arrow in either direction', () => {
  assert.deepStrictEqual(delta(5, { delta: 0.2 }, BL),
    ['±0% vs last 3 Sat', '±0% 较前 3 个周六']);
});

it('a metric with NO baseline says nothing at all', () => {
  // Average order value has none. The tile used to print the comparison label
  // with no comparison under it, which reads as a broken tile. null, and the
  // renderer drops the whole line rather than reserving space for an empty one.
  assert.strictEqual(delta(270, undefined, BL), null);
  assert.strictEqual(delta(270, null, BL), null);
});

it('the Avg. order tile is wired to that silence, and renders no line for it', () => {
  assert.ok(/\['Avg\. order','客单价'\], money\(CUR, ord\? rev\/ord : 0\), null\]/.test(M_HTML),
    'Avg. order must pass an empty delta, not a bare label');
  assert.ok(/\$\{d\?`<span class="num"[^`]*`:''\}/.test(M_HTML),
    'the delta span must be conditional, or an empty one still takes the space');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · the amber payment fire, inside the real opsFires()');

const OPS0 = {
  payment_mismatch: { count: 0, items: [] }, payment_unconfirmed: { count: 0, unread: 0, items: [] },
  delivery_alerts: { count: 0, items: [] }, refunds: { count: 0, items: [] },
  unhandled: { count: 0, items: [] }, awaiting_restock: { count: 0, items: [] },
  invoices: { count: 0, items: [] }, low_stock: { count: 0, items: [] },
  out_of_stock: { count: 0, items: [] },
};
const firesFor = (o) => [...ctxWith({ ops: { ...OPS0, ...o } }).opsFires()];

it('a proof nobody has accepted lights an amber row', () => {
  const f = firesFor({ payment_unconfirmed: { count: 3, unread: 0, items: [] } });
  const row = f.find(x => x.label === 'Payments to confirm');
  assert.ok(row, `no such fire in: ${f.map(x => x.label).join(' | ')}`);
  assert.strictEqual(row.sev, 'amber', 'nothing here says the money is WRONG');
  assert.strictEqual(row.n, 3);
});

it('it names the unreadable ones rather than an age', () => {
  const row = firesFor({ payment_unconfirmed: { count: 5, unread: 2, items: [] } })
    .find(x => x.label === 'Payments to confirm');
  assert.strictEqual(row.meta, "2 couldn't be read");
});

it('all-readable says nothing about unreadable ones', () => {
  const row = firesFor({ payment_unconfirmed: { count: 5, unread: 0, items: [] } })
    .find(x => x.label === 'Payments to confirm');
  assert.ok(!/read/.test(row.meta || ''), `"0 couldn't be read" is a sentence nobody needs: ${row.meta}`);
});

it('zero never becomes a row, whatever the unread count says', () => {
  assert.strictEqual(firesFor({}).length, 0);
  assert.strictEqual(firesFor({ payment_unconfirmed: { count: 0, unread: 3, items: [] } }).length, 0);
});

it('it sorts below its brick sibling, not above it', () => {
  const f = firesFor({
    payment_mismatch: { count: 1, items: [] },
    payment_unconfirmed: { count: 9, unread: 0, items: [] },
  });
  assert.deepStrictEqual(f.map(x => x.sev), ['brick', 'amber'],
    'a bigger amber count must not outrank a brick one');
});

it('both payment fires open the same door — Pending, where both are sitting', () => {
  const f = firesFor({
    payment_mismatch: { count: 1, items: [] },
    payment_unconfirmed: { count: 1, unread: 0, items: [] },
  });
  for (const row of f) {
    assert.strictEqual(row.go, "APP.cmd('ordersGo','pending')", `wrong door on ${row.label}`);
  }
  // Non-vacuous: that door is a no-op for a filter this screen cannot serve.
  assert.ok(/pending:'pending_payment'/.test(M_HTML), 'no pending filter for the door to open');
});

it('a payload with no payment_unconfirmed key at all does not throw', () => {
  // An older server, or a tenant mid-deploy: the block is simply absent, and
  // the card must degrade to "one fewer fire" rather than to a blank screen.
  const bare = { ...OPS0 };
  delete bare.payment_unconfirmed;
  assert.strictEqual([...ctxWith({ ops: bare }).opsFires()].length, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
