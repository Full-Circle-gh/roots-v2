#!/usr/bin/env node
/**
 * The channel money breakdown panel on the order drawer — the two functions
 * that decide what it shows: channelMoneyBreakdown(o) (the arithmetic) and
 * renderChannelMoneyPanel(o) (what gets drawn from it).
 *
 *   node scripts/test_channel_money_panel.js
 *
 * EVALUATED, not paraphrased: both functions are sliced out of the shipped
 * public/retail-admin/04-orders.js and run under vm with stubs for cuT/acMoney,
 * so a rewrite of the panel moves these tests rather than leaving them testing
 * a memory of the old one.
 *
 * THE THING THIS GUARDS: "test the arithmetic gap, not column presence."
 * packing_fee and shipping_fee both DEFAULT to 0 (database.js), so an order
 * that never had its fees captured looks, by column presence alone, identical
 * to one that genuinely charged nothing — true of every Eleme row mirrored
 * before PR #200 taught ingest to write foodInfo.packageFee/deliveryFee into
 * those columns. A completeness test that only checks "is the column non-null"
 * would call such a row complete. Section 2 below builds exactly that row and
 * asserts the panel calls it incomplete anyway, because subtotal + packing +
 * shipping - discount does not add up to the order's own total.
 *
 * Eleme never gets a channel_discount write at all (routes/eleme-internal.js
 * has no such column in its INSERT or UPDATE — the discount is baked into
 * Eleme's own `total` with nothing separating it out). So an Eleme order
 * carrying a real merchant discount reconciles to nothing: the panel is
 * supposed to show what it has (subtotal/packing/delivery) plus the
 * "breakdown incomplete" note, never a fabricated discount figure standing in
 * for the missing column. Section 3 is that order, verified honest rather than
 * silently wrong.
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

/** A braced block (function): from `anchor` to its matching `}`. */
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

const BREAKDOWN_SRC = sliceBlock(ORDERS_JS, 'function channelMoneyBreakdown(o)');
const PANEL_SRC = sliceBlock(ORDERS_JS, 'function renderChannelMoneyPanel(o)');

// Stubs. acMoney prints in a symbol no test order text could produce by
// accident (£), so a stray hardcoded ¥ in the shipped function is caught by a
// plain string search rather than by chance. cuT mirrors the real
// window.cuT (01-core.js): one language back, chosen by the module-level
// _lang the tests flip between calls.
function makeSandbox(lang) {
  const sandbox = {
    _lang: lang,
    cuT: (en, cn) => (sandbox._lang === 'cn' ? cn : en),
    acMoney: (n) => '£' + Number(n || 0).toFixed(2),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${BREAKDOWN_SRC}\n${PANEL_SRC}`, sandbox);
  return sandbox;
}

// ── 1. Full data — the two worked examples from the spec ──────────────────
// Meituan  228.50 + 1.50 + 15.00 − 12.00 = 233.00 → −22.36 → 210.64
it('Meituan, full data: reconciles and shows both steps', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, true, 'a fully-populated Meituan order must reconcile');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('Settlement'), 'panel carries its section header');
  assert.ok(html.includes('Customer delivery fee'), 'shipping_fee renders under the locked delivery-fee label');
  assert.ok(html.includes('Merchant discount'), 'a real channel_discount renders');
  assert.ok(html.includes('Commission'), 'commission is shown');
  assert.ok(html.includes('Estimated income'), 'settle_amount is shown as estimated income');
  assert.ok(!html.includes('Breakdown incomplete'), 'a reconciled panel carries no incomplete note');
  assert.ok(html.includes('£210.64'), 'estimated income is the stored settle_amount, not a re-derived figure');
  assert.ok(!html.includes('¥'), 'money is drawn through acMoney, never a hardcoded ¥');
});

it('Chinese view: the same panel, one language, no glued bilingual text', () => {
  const sb = makeSandbox('cn');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('结算明细'), 'Chinese header renders');
  assert.ok(html.includes('顾客配送费'), 'Chinese delivery-fee label renders');
  assert.ok(html.includes('商家对顾客的活动补贴'), 'Chinese discount label renders');
  assert.ok(html.includes('佣金'), 'Chinese commission label renders');
  assert.ok(html.includes('预计收入'), 'Chinese estimated-income label renders');
  assert.ok(!html.includes('Settlement') && !html.includes('Commission'),
    'no English leaks into the Chinese view (no " · " glue, no fallback text)');
});

// ── 2. THE ARITHMETIC GAP — an Eleme row exactly as it looked before PR #200 ─
// packing_fee/shipping_fee sit at their column DEFAULT of 0 because nothing
// ever wrote them, not because the order was free to pack and ship. A
// column-presence check ("packing_fee is not null") is true here — 0 is not
// null — and would wrongly call this row complete.
it('Eleme, pre-#200 phantom-zero fees: flagged incomplete by the arithmetic, not by column presence', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'eleme', subtotal: 135.00, packing_fee: 0, shipping_fee: 0,
    channel_discount: null, total: 141.00,   // real total; 135 - 141 alone won't reconcile either
    channel_commission: 14.95, channel_settle_amount: 126.05,
  };
  // The naive, wrong test this guards against: presence alone says "complete".
  const naivelyComplete = o.packing_fee != null && o.shipping_fee != null;
  assert.strictEqual(naivelyComplete, true, 'sanity: the phantom zero really is column-present, not null');
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false, 'the real check must catch what column presence misses');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('Breakdown incomplete'), 'the incomplete note must show');
  assert.ok(html.includes('subtotal'), 'the one row we do have still renders');
  assert.ok(!html.includes('Commission') && !html.includes('Estimated income'),
    'step two never renders over an unreconciled step one');
});

// ── 3. Eleme with a real merchant discount — channel_discount is never
// written for Eleme (routes/eleme-internal.js), so this is honestly
// incomplete, not silently wrong. EL20260901417897: 267 + 1.5 + 18 - 17.5
// (uncaptured) = 269 — the components we hold don't reach the total we hold.
it('Eleme, real discount not captured in any column: honest incomplete, no fabricated discount row', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'eleme', subtotal: 267.00, packing_fee: 1.50, shipping_fee: 18.00,
    channel_discount: null, total: 269.00,
    channel_commission: 28.51, channel_settle_amount: 240.49,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false, 'discount is missing, so the arithmetic cannot reconcile');
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('subtotal') && html.includes('Customer delivery fee') && html.includes('packing'),
    'the rows we do have (items, packaging, delivery) still render');
  assert.ok(!html.includes('Merchant discount'), 'no discount figure is invented to force a reconcile');
  assert.ok(!html.includes('240.49') && !html.includes('Estimated income'),
    'estimated income never prints over an unreconciled total — no silent low number');
  assert.ok(html.includes('Breakdown incomplete'));
});

// ── 4. The majority Meituan case — pre-24 Aug orders with NULL commission/
// discount/settle_amount. Must be a clean state, not a crash or a broken row.
it('Meituan, pre-24-Aug order (commission/discount/settle all NULL): clean not-recorded state', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 98.00, packing_fee: 3.00, shipping_fee: 17.00,
    channel_discount: null, total: 118.00,
    channel_commission: null, channel_settle_amount: null,
  };
  const g = sb.channelMoneyBreakdown(o);
  assert.strictEqual(g.complete, false);
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(html.includes('Breakdown incomplete'));
  assert.ok(html.includes('subtotal') && html.includes('packing') && html.includes('Customer delivery fee'),
    'the components this order DOES carry still render');
  assert.ok(!html.includes('Commission') && !html.includes('Estimated income'),
    'no commission rate, no invented income — nothing to show for step two');
});

// ── 5. Zero rows hide; no ¥0.00 anywhere ───────────────────────────────────
it('a zero component is hidden, not printed as a zero row', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 100.00, packing_fee: 0, shipping_fee: 15.00,
    channel_discount: 0, total: 115.00,
    channel_commission: 10.00, channel_settle_amount: 105.00,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(!html.includes('packing'), 'a zero packing fee renders no row at all');
  assert.ok(!html.includes('Merchant discount'), 'a zero discount renders no row at all');
  assert.ok(!html.includes('£0.00') && !/−£0\.00/.test(html), 'no zero amount rendered anywhere in the output');
});

// ── 6. Non-channel and non-commission channels degrade to nothing ─────────
for (const channel of ['wechat', 'manual', null, undefined, '']) {
  it(`non-channel order (channel=${JSON.stringify(channel)}) renders no panel at all`, () => {
    const sb = makeSandbox('en');
    const o = { channel, subtotal: 50, total: 50, fulfillment_type: 'pickup' };
    assert.strictEqual(sb.renderChannelMoneyPanel(o), '');
  });
}
it('gzgrocery (wholesale, no per-order commission) renders no panel', () => {
  const sb = makeSandbox('en');
  const o = { channel: 'gzgrocery', subtotal: 50, total: 50 };
  assert.strictEqual(sb.renderChannelMoneyPanel(o), '');
});

// ── 7. No commission rate, no "estimated" marker bolted on ────────────────
it('never prints a commission rate or a second "estimated" marker', () => {
  const sb = makeSandbox('en');
  const o = {
    channel: 'meituan', subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
    channel_commission: 22.36, channel_settle_amount: 210.64,
  };
  const html = sb.renderChannelMoneyPanel(o);
  assert.ok(!/%/.test(html), 'no percentage anywhere — the rate is never shown');
  assert.ok(!/estimated/i.test(html.replace('Estimated income', '')),
    'no second "estimated" caveat beyond the one word already in the locked label');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
