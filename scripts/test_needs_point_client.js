#!/usr/bin/env node
/**
 * Client half of the delivery-point suite — the dashboard card's link into the
 * order drawer. Server half is scripts/test_needs_point.js; this file is to it
 * what test_address_clients.js is to test_address_pin.js.
 *
 *   node scripts/test_needs_point_client.js
 *
 * No network, no DB, no browser. The two functions under test are sliced out of
 * public/retail-admin/04-orders.js verbatim and evaluated against stubs, so
 * this reads the shipped source rather than a copy of it — editing the real
 * selector or the real openOrder is what makes these tests move.
 *
 * What it locks down:
 *   1. THE BUG — a click on .dp-work-row must not reach the outside-click
 *      dismisser. openOrder() adds .open synchronously, the same click then
 *      bubbles to that listener, and before this fix the drawer was closed
 *      inside the very dispatch that opened it: the card's order code read as
 *      a dead link. Asserted non-vacuously: with .dp-work-row removed from the
 *      selector the dismisser fires on that same row.
 *   2. what must NOT change — the three sibling dashboard rows stay exempt, a
 *      genuine click on empty page area still dismisses, and the selector is
 *      not broadened to anything generic (.td-block, [data-block], button)
 *      which would quietly kill outside-click dismiss across the page.
 *   3. THE LANDING — openOrder under `focus: 'point'` scrolls #qp-<id> into
 *      view; with no such node it must degrade to "the drawer just opened"
 *      rather than throw; and with no opt it must not scroll at all.
 *
 * NOT covered here, and only observable in a browser (see the report):
 *   the real event ORDER — that a live click on the row runs the inline
 *   onclick before this document listener. That is DOM dispatch, not our code.
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
async function itAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DASH_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');

// ── Slice a function / statement out of the shipped file ──────────────────
// Brace counting, deliberately naive: a mis-slice cannot make a test pass
// quietly, because the result is then fed to vm.Script and fails to parse.
// Counting starts at the first `{` AFTER the anchor, not after its start —
// `openOrder(id, opts = {})` has a default-value brace inside its own
// signature, so anchors must always include the whole parameter list.
function slice(src, anchor, { from } = {}) {
  const base = from ? src.indexOf(from) : 0;
  assert.notStrictEqual(base, -1, `anchor comment not found: ${from}`);
  const start = src.indexOf(anchor, base);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

// ── A DOM small enough to be honest about ─────────────────────────────────
// Only what the listener actually calls: closest(), isConnected, parentNode.
// The matcher understands `tag`, `.class` and `tag.class` — the forms the real
// selector uses — and THROWS on anything else, so a future attribute or
// pseudo selector is reported rather than silently treated as "no match".
function matches(el, sel) {
  return sel.split(',').map(s => s.trim()).filter(Boolean).some((part) => {
    const m = part.match(/^([a-z]*)((?:\.[\w-]+)*)$/);
    if (!m) throw new Error(`the stub matcher does not understand the selector part: ${part}`);
    if (m[1] && m[1] !== el.tag) return false;
    return (m[2].match(/[\w-]+/g) || []).every(c => el.classes.has(c));
  });
}
function makeNode(desc, parentNode) {
  const m = desc.match(/^([a-z]*)((?:\.[\w-]+)*)$/);
  assert.ok(m, `bad fixture descriptor: ${desc}`);
  const el = { tag: m[1] || '', classes: new Set(m[2].match(/[\w-]+/g) || []), parentNode, isConnected: true };
  el.closest = (sel) => {
    for (let n = el; n; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  };
  return el;
}
// Outermost first; returns the leaf, which is what a real click targets.
function chain(...descs) {
  let cur = null;
  for (const d of descs) cur = makeNode(d, cur);
  return cur;
}

// ── The listener under test, run against a stubbed page ───────────────────
const LISTENER = slice(ORDERS_JS, "document.addEventListener('click'", {
  from: '// Click-outside-to-close for the read drawers',
}) + ');';

// Runs the REAL listener body over one click. `src` lets a test mutate the
// shipped source (to prove a test is not vacuous) before it is evaluated.
function clickWith(target, { src = LISTENER, drawerOpen = true, selection = '' } = {}) {
  const seen = { dismissed: 0 };
  const drawer = { id: 'order-drawer' };
  const ctx = {
    document: {
      _handler: null,
      addEventListener(ev, fn) { if (ev === 'click') this._handler = fn; },
      querySelectorAll: () => (drawerOpen ? [drawer] : []),
    },
    window: { getSelection: () => ({ toString: () => selection }) },
    topmostOpenDrawer: (open) => open[0] || null,
    dismissTopDrawer: (top) => { if (top) seen.dismissed++; },
  };
  vm.createContext(ctx);
  new vm.Script(src).runInContext(ctx);
  assert.ok(ctx.document._handler, 'the listener did not register');
  ctx.document._handler({ target, isConnected: target.isConnected });
  return seen.dismissed > 0;
}

// The dashboard worklist row, exactly as dashNeedsPointRender builds it: a
// <button class="dp-work-row"> holding three spans. A real click usually lands
// on the order-code span, so that is what these fire at.
const dpRowCodeSpan = () => chain('main', 'div.td-block.dp-work', 'div.dp-work-list', 'button.dp-work-row', 'span.dp-work-no');

// CommonJS has no top-level await — the sync and async checks share one tally
// inside a single pass, same shape as scripts/test_needs_point.js.
(async () => {

console.log('\nB1 · the opening click must survive the outside-click dismisser');

it('a click on the delivery-point row does NOT dismiss the drawer it just opened', () => {
  assert.strictEqual(clickWith(dpRowCodeSpan()), false);
});

it('and that is not vacuous: drop .dp-work-row and the dismisser fires on the same click', () => {
  const without = LISTENER.replace('.dp-work-row, ', '');
  assert.notStrictEqual(without, LISTENER, '.dp-work-row is missing from the exemption selector');
  assert.strictEqual(clickWith(dpRowCodeSpan(), { src: without }), true,
    'the fixture must be able to trigger the bug, or the test above proves nothing');
});

it('a click on the row itself, not the code span, is exempt too', () => {
  assert.strictEqual(clickWith(chain('div.dp-work-list', 'button.dp-work-row')), false);
});

console.log('\nB1 · what must not change');

it('the three sibling dashboard rows are still exempt', () => {
  for (const row of ['div.db-feed-row', 'div.td-nrow', 'div.td-attn-row']) {
    assert.strictEqual(clickWith(chain('div', row)), false, row);
  }
});

it('an orders-list row is still exempt (it switches records)', () => {
  assert.strictEqual(clickWith(chain('table', 'tr.order-row', 'td')), false);
});

it('empty page area still dismisses — the feature is intact', () => {
  assert.strictEqual(clickWith(chain('main', 'div.td-block', 'p')), true);
});

it('a click inside the drawer still never dismisses', () => {
  assert.strictEqual(clickWith(chain('aside.side-drawer', 'div.order-card', 'button')), false);
});

it('with no dw-dismiss drawer open nothing is dismissed', () => {
  assert.strictEqual(clickWith(chain('main', 'p'), { drawerOpen: false }), false);
});

it('a drag-to-copy selection still suppresses the dismiss', () => {
  assert.strictEqual(clickWith(chain('main', 'p'), { selection: 'TC000218' }), false);
});

it('the exemption selector was not broadened to anything generic', () => {
  // Widening this to a container or to `button` would disable outside-click
  // dismiss across most of the page — the fix must cost exactly one class.
  const sel = LISTENER.match(/closest\('([^']*dp-work-row[^']*)'\)/);
  assert.ok(sel, 'could not read the exemption selector');
  const parts = sel[1].split(',').map(s => s.trim());
  for (const bad of ['.td-block', '[data-block]', 'button', 'div', '*', '.bn-card']) {
    assert.ok(!parts.includes(bad), `must not exempt ${bad}`);
  }
  assert.ok(parts.includes('.dp-work-row'));
});

console.log('\nB2 · landing on the action');

// openOrder, sliced whole, over a page stubbed down to what it touches.
const OPEN_ORDER = slice(ORDERS_JS, 'async function openOrder(id, opts = {})');
const FOCUS_FN = slice(ORDERS_JS, 'function odFocusPointSection(orderId)');

const PARKED = (id) => ({
  id, order_no: 'TC000218', address: { city: '广州市' },
  qingyun_ship_from: { awaiting_point: true, guess: { lat: 23.1, lng: 113.3 }, date_posture: null },
});

// Returns what the run did, so a test can assert on the scroll AND on whether
// openOrder's own catch swallowed a throw (it renders "Failed" into the mount).
// `threw` is the error that escaped openOrder, if any — the distinction the
// move-out-of-the-try hardening exists to make.
async function runOpenOrder(order, opts, { qpNodeExists = true, scrollThrows = false, apiFails = false } = {}) {
  const seen = { scrolls: [], qpInit: 0, rendered: 0, drawerOpened: 0, threw: null };
  const mount = { innerHTML: '', children: [], classList: { add() {}, remove() {}, contains: () => false } };
  const qpNode = { scrollIntoView: (arg) => {
    seen.scrolls.push(arg);
    if (scrollThrows) throw new Error('scroll blew up');
  } };
  const ctx = {
    console,
    setTimeout,
    requestAnimationFrame: (fn) => fn(),
    Promise,
    document: {
      getElementById: (elId) => {
        if (elId === 'order-detail-mount') return mount;
        if (elId === 'order-drawer') return { classList: { contains: () => false } };
        if (elId === 'order-drawer-foot') return { innerHTML: '' };
        if (elId === `qp-${order.id}`) return qpNodeExists ? qpNode : null;
        return null;
      },
      querySelector: () => null,
    },
    window: { scrollTo() {} },
    $: () => mount,
    api: async () => { if (apiFails) throw new Error('network down'); return { data: order }; },
    ensureTrackingCarriers: async () => {},
    openDrawer: () => { seen.drawerOpened++; },
    renderOpenOrder: () => { seen.rendered++; },
    mountCourierMap: () => {},
    qpInitMap: () => { seen.qpInit++; },
    escapeHtml: (s) => String(s),
  };
  vm.createContext(ctx);
  new vm.Script(`${FOCUS_FN}\n${OPEN_ORDER}`).runInContext(ctx);
  try { await ctx.openOrder(order.id, opts); } catch (e) { seen.threw = e; }
  seen.mount = mount.innerHTML;
  return seen;
}

await itAsync("focus:'point' scrolls the #qp-<id> section into view", async () => {
  const seen = await runOpenOrder(PARKED(988), { focus: 'point' });
  assert.strictEqual(seen.rendered, 1, 'the drawer still rendered');
  assert.strictEqual(seen.qpInit, 1, 'and the map still mounted');
  assert.strictEqual(seen.scrolls.length, 1, 'exactly one scroll');
  // Field by field, not deepStrictEqual: the object literal was built inside
  // the vm realm, so its prototype is a different Object and a deep-strict
  // compare fails on identical values.
  assert.strictEqual(seen.scrolls[0].block, 'start', 'same idiom as the pager scroll');
  assert.strictEqual(seen.scrolls[0].behavior, 'smooth');
});

await itAsync('a missing .qp node degrades to "the drawer just opened" — no throw', async () => {
  // The real case: someone else confirmed the point between the dashboard's
  // poll and this click, so the drawer renders no confirm surface at all.
  const seen = await runOpenOrder(PARKED(988), { focus: 'point' }, { qpNodeExists: false });
  assert.strictEqual(seen.scrolls.length, 0);
  assert.strictEqual(seen.drawerOpened, 1, 'the drawer still opened');
  assert.strictEqual(seen.rendered, 1, 'and still rendered the order');
  // Both failure shapes, because the focus call moved OUT of openOrder's
  // try/catch. Before the move a null-guard slip was swallowed and showed up
  // only as the failure card; now it escapes as a rejection. Assert on each,
  // or dropping `if (!el) return false` stops being caught by anything.
  assert.strictEqual(seen.threw, null, 'the guard must skip the scroll, not throw past it');
  assert.doesNotMatch(seen.mount, /Failed/, 'and must not be swallowed into a failure card either');
});

await itAsync('the default path does not scroll — every existing caller is untouched', async () => {
  for (const opts of [undefined, {}, { instant: true }]) {
    const seen = await runOpenOrder(PARKED(988), opts);
    assert.strictEqual(seen.scrolls.length, 0, `opts=${JSON.stringify(opts)}`);
    assert.strictEqual(seen.rendered, 1);
  }
});

await itAsync('an unrelated focus value is inert', async () => {
  const seen = await runOpenOrder(PARKED(988), { focus: 'items' });
  assert.strictEqual(seen.scrolls.length, 0);
});

await itAsync('a throwing scroll surfaces as a real error, NOT a swallowed "Failed" card', async () => {
  // The hardening this asserts: the focus call sits OUTSIDE openOrder's
  // try/catch. Inside it, this throw was caught and painted as
  // "Failed · 失败: …" OVER a drawer that had already rendered correctly — a
  // scroll bug wearing the costume of a load failure, and the order the
  // operator asked for destroyed on screen. Out here it escapes as a rejection.
  const seen = await runOpenOrder(PARKED(988), { focus: 'point' }, { scrollThrows: true });
  assert.ok(seen.threw, 'the error must escape openOrder');
  assert.match(seen.threw.message, /scroll blew up/);
  assert.strictEqual(seen.rendered, 1, 'and the drawer still rendered');
  assert.doesNotMatch(seen.mount, /Failed/, 'the rendered drawer must not be replaced by a failure card');
});

it('the focus call is positioned after the catch block, not inside the try', () => {
  // Positional, so a future edit that drags it back into the try is caught
  // even if no test happens to throw from the scroll.
  const fn = slice(ORDERS_JS, 'async function openOrder(id, opts = {})');
  const catchAt = fn.indexOf('} catch (e) {');
  const failCard = fn.indexOf('order-card err">Failed');
  const call = fn.indexOf("if (opts.focus === 'point'");
  assert.ok(catchAt > -1 && failCard > catchAt, 'could not locate openOrder\'s catch');
  assert.ok(call > -1, 'the focus call is gone');
  assert.ok(call > failCard, 'the focus call must come AFTER the catch that paints the Failed card');
});

await itAsync('a failed fetch never scrolls — there is nothing rendered to scroll to', async () => {
  const seen = await runOpenOrder(PARKED(988), { focus: 'point' }, { apiFails: true });
  assert.strictEqual(seen.scrolls.length, 0);
  assert.strictEqual(seen.threw, null, 'a load failure is still handled, not thrown');
  assert.match(seen.mount, /Failed/, 'and still reported as one');
});

await itAsync('an order with no delivery-point surface never scrolls, opt or not', async () => {
  const plain = { id: 42, order_no: 'TC000042', address: {}, qingyun_ship_from: null };
  const seen = await runOpenOrder(plain, { focus: 'point' }, { qpNodeExists: false });
  assert.strictEqual(seen.qpInit, 0, 'no map for an order that is not parked');
  assert.strictEqual(seen.scrolls.length, 0);
  assert.doesNotMatch(seen.mount, /Failed/);
});

console.log('\nB3 · the id the card passes');

it('the row passes the internal numeric id, and shows order_no separately', () => {
  // The card has both. Passing order_no would open nothing (openOrder fetches
  // /orders/<retail_orders.id>), and the failure would look like this bug.
  assert.match(DASH_JS, /onclick="dashOpenNeedsPoint\(\$\{Number\(it\.id\)\}\)"/,
    'the onclick must carry Number(it.id)');
  assert.doesNotMatch(DASH_JS, /dashOpenNeedsPoint\(\$\{[^}]*order_no/,
    'order_no must never be the argument');
  assert.match(DASH_JS, /class="dp-work-no"[^>]*>\$\{escapeHtml\(it\.order_no/,
    'order_no is display text only');
});

it('dashOpenNeedsPoint asks for the point section', () => {
  const fn = slice(DASH_JS, 'function dashOpenNeedsPoint(orderId)');
  assert.match(fn, /openOrder\(orderId, \{ focus: 'point' \}\)/);
  assert.doesNotMatch(fn, /stopPropagation/,
    'the self-close is solved by the exemption list, like the three sibling rows');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})();
