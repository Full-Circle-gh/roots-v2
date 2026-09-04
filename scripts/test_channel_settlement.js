#!/usr/bin/env node
/**
 * lib/channel-settlement.js — the identity every channel order's money has to
 * satisfy, and the names it gives the ways one doesn't.
 *
 *   node scripts/test_channel_settlement.js
 *
 * WHAT THIS IS PROTECTING. routes/eleme-internal.js logs an
 * order_settlement_mismatch row from these figures at ingest, and
 * scripts/diagnose_channel_settlement.js groups live orders by the `kind` values
 * below. Both are read by a human deciding whether a row is a platform quirk or
 * a parser bug, so a classifier that quietly renames a case, or calls a
 * reconciling order broken, sends that person to the wrong place. Every kind
 * here is pinned to the shape that produced it.
 *
 * Pure arithmetic — no database, no network, no fixtures.
 */
'use strict';

const assert = require('assert');
const { settlementGap, describeSettlementGap } = require('../lib/channel-settlement');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Orders that close ───────────────────────────────────────────────────────
// null is the happy path and has to stay null, or every reconciling order in the
// table writes a warning row and the log stops being worth reading.

it('a fully reconciling order reports nothing at all', () => {
  assert.strictEqual(settlementGap({
    subtotal: 228.50, packing_fee: 1.50, shipping_fee: 15.00,
    channel_discount: 12.00, total: 233.00,
  }), null);
});

it('EL20260901417897 — the live order that does reconcile — reports nothing', () => {
  // 267 + 1.5 + 18 - 17.5 = 269, the figure Eleme's customerPaidInfo carried.
  assert.strictEqual(settlementGap({
    subtotal: 267.00, packing_fee: 1.50, shipping_fee: 18.00,
    channel_discount: 17.50, total: 269.00,
  }), null);
});

it('no discount and no fees, goods only, still closes', () => {
  assert.strictEqual(settlementGap({
    subtotal: 40.00, packing_fee: 0, shipping_fee: 0, channel_discount: null, total: 40.00,
  }), null);
});

it('a cent of float drift is not a disagreement', () => {
  // 0.1 + 0.2 arithmetic: the components must be compared at cent resolution,
  // not by ===, or a third of the table reports a gap of 4e-15.
  assert.strictEqual(settlementGap({
    subtotal: 0.1, packing_fee: 0.2, shipping_fee: 0, channel_discount: 0, total: 0.3,
  }), null);
});

it('an order with no total is left to the ingest\'s own total check, not reported twice', () => {
  assert.strictEqual(settlementGap({
    subtotal: 45.00, packing_fee: 1.50, shipping_fee: 5.00, channel_discount: null, total: 0,
  }), null);
});

it('a missing row is not a gap', () => {
  assert.strictEqual(settlementGap(null), null);
});

// ── Orders that don't, each named ───────────────────────────────────────────

it('EL20260903163199: components overshoot by exactly the delivery fee', () => {
  const g = settlementGap({
    subtotal: 45.00, packing_fee: 1.50, shipping_fee: 5.00,
    channel_discount: 5.50, total: 41.00,
  });
  assert.ok(g, 'this order must not pass silently');
  assert.strictEqual(g.expected, 46.00);
  assert.strictEqual(g.gap, 5.00);
  assert.strictEqual(g.kind, 'delivery_not_billed');
  // The message has to carry the numbers, not just the label: whoever reads the
  // log is checking the arithmetic themselves.
  const msg = describeSettlementGap(g);
  assert.ok(msg.includes('¥46.00') && msg.includes('¥41.00') && msg.includes('¥5.00'), msg);
  assert.ok(msg.includes('delivery_not_billed'), msg);
});

it('a packing fee the customer was never charged is named as its own case', () => {
  const g = settlementGap({
    subtotal: 45.00, packing_fee: 1.50, shipping_fee: 0,
    channel_discount: 0, total: 45.00,
  });
  assert.strictEqual(g.kind, 'packaging_not_billed');
  assert.strictEqual(g.gap, 1.50);
});

it('an uncaptured promotion (discount column NULL) is separated from an understated one', () => {
  // Every Eleme row mirrored before PR #209: a real discount, no column holding it.
  const g = settlementGap({
    subtotal: 267.00, packing_fee: 1.50, shipping_fee: 18.00,
    channel_discount: null, total: 269.00,
  });
  assert.strictEqual(g.kind, 'discount_unrecorded');
  assert.strictEqual(g.gap, 17.50);
  assert.strictEqual(g.discount, null, 'NULL is preserved, never flattened to 0');
});

it('a discount that IS recorded but is too small is a different fault, and says so', () => {
  const g = settlementGap({
    subtotal: 100.00, packing_fee: 2.00, shipping_fee: 6.00,
    channel_discount: 3.00, total: 90.00,
  });
  assert.strictEqual(g.kind, 'discount_understated');
  assert.strictEqual(g.discount, 3.00);
});

it('a total LARGER than everything we hold is not described as a discount', () => {
  const g = settlementGap({
    subtotal: 50.00, packing_fee: 1.00, shipping_fee: 4.00,
    channel_discount: 0, total: 60.00,
  });
  assert.strictEqual(g.kind, 'total_above_components');
  assert.strictEqual(g.gap, -5.00);
});

it('a ×100 unit slip is caught before it is called a discount the size of a house', () => {
  // The whole point of naming this one: a scale bug and a promotion need
  // completely different fixes, and by gap alone they look identical.
  const g = settlementGap({
    subtotal: 4500.00, packing_fee: 0, shipping_fee: 0, channel_discount: 0, total: 45.00,
  });
  assert.strictEqual(g.kind, 'scale_x100');
});

it('a ÷100 slip is named too', () => {
  const g = settlementGap({
    subtotal: 0.45, packing_fee: 0, shipping_fee: 0, channel_discount: 0, total: 45.00,
  });
  assert.strictEqual(g.kind, 'scale_div100');
});

it('an exact fee match wins over "something is missing" — order of diagnosis matters', () => {
  // delivery 5.00 AND no discount recorded. Both rules match; the specific one
  // must win, because "the fee wasn't billed" is checkable against the payload
  // and "a discount is missing somewhere" is not.
  const g = settlementGap({
    subtotal: 45.00, packing_fee: 0, shipping_fee: 5.00,
    channel_discount: null, total: 45.00,
  });
  assert.strictEqual(g.kind, 'delivery_not_billed');
});

// ── The wiring ──────────────────────────────────────────────────────────────
// A classifier nothing calls catches nothing. These read the shipped ingest
// rather than a copy of it, because the failure being guarded against is a
// refactor that keeps the module and drops the call — which is exactly how the
// panel came to be the only place this identity was ever checked.
//
// Source-level assertions, and honest about it: they prove the check is wired
// in, not that SQLite accepted the row. The arithmetic itself is proven above.

const fs = require('fs');
const path = require('path');
const INGEST = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eleme-internal.js'), 'utf8');

it('the Eleme ingest calls the identity and logs when it fails', () => {
  assert.ok(/require\('\.\.\/lib\/channel-settlement'\)/.test(INGEST),
    'ingest must use the shared module, not its own copy of the arithmetic');
  assert.ok(/settlementGap\(\{/.test(INGEST), 'and must actually call it');
  assert.ok(INGEST.includes("'order_settlement_mismatch'"),
    'a failing identity must reach eleme_sync_log under a searchable event_type');
  assert.ok(INGEST.includes('describeSettlementGap(settleGap)'),
    'the log line must carry the numbers, not a bare label');
});

it('the ingest checks what it WROTE, not what it parsed', () => {
  // The INSERT COALESCEs both fees to 0 and leaves the discount NULL. Checking
  // the parser's nullable values instead would ask the identity of a row that
  // does not exist, and could pass while the stored row does not reconcile.
  const call = INGEST.slice(INGEST.indexOf('const settleGap = settlementGap({'));
  const body = call.slice(0, call.indexOf('});') + 3);
  assert.ok(/packing_fee:\s*packingFee\s*!=\s*null\s*\?\s*packingFee\s*:\s*0/.test(body),
    'packing_fee must be read as the column stores it (0, never null)');
  assert.ok(/shipping_fee:\s*shippingFee\s*!=\s*null\s*\?\s*shippingFee\s*:\s*0/.test(body),
    'shipping_fee likewise');
  assert.ok(/channel_discount:\s*shopDiscount/.test(body),
    'channel_discount must stay nullable — NULL is the diagnosis, not a zero');
});

it('the log carries the field each figure was read out of', () => {
  assert.ok(/keyPaths:\s*order\.moneyKeyPaths/.test(INGEST),
    'without the key paths, three different faults look identical in the log');
  const PARSER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eleme-browser.js'), 'utf8');
  assert.ok(/moneyKeyPaths:\s*\{/.test(PARSER), 'and the parser has to produce them');
  for (const k of ['total', 'packagingFee', 'deliveryFee', 'shopDiscount', 'commission', 'merchantIncome']) {
    assert.ok(new RegExp(`${k}:\\s*\\w+(Hit\\.path|\\.path)`).test(PARSER),
      `moneyKeyPaths must name a source for ${k}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
