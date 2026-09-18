#!/usr/bin/env node
/**
 * A replacement sends the lines that spoiled — not the whole box (§98 add. 8).
 *
 *   node scripts/test_delay_replacement_lines.js
 *
 * WHY THIS EXISTS. Stage three copied every line of the late parcel at full
 * quantity, always. Ash reported it against TC000750 — a six-product box with
 * two spoiled salads put six products back on a van, and four of them left the
 * shelf for nothing. The pick is now the operator's, and the two things that
 * can go wrong with a pick are both silent: a quantity ABOVE what was ordered
 * turns a remedy into a giveaway nobody authorised, and a pick that resolves to
 * NOTHING would raise an empty order with a waybill and no goods in it.
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. An absent `items` is every line at full quantity. The old behaviour, and
 *      the contract for a client that has not been reloaded since the deploy —
 *      break it and a phone in a pocket starts refusing to send replacements.
 *   2. The original line is the CEILING. More than went out is refused.
 *   3. A line from another parcel is refused, not ignored. Silently sending
 *      nothing is the worse of the two failures.
 *   4. The cost is goods AT THE PICKED QUANTITY plus the typed freight — the
 *      figure the carrier's payment is set against. A partial replacement
 *      costed as the whole parcel is a comparison against a fiction.
 *   5. Nothing costed and no freight typed stays NULL, so the screen prints no
 *      cost at all rather than a ¥0 that reads as free.
 *
 * No network, no keys, no server, no database — the rule is a pure function in
 * lib/delay-case.js precisely so this file can be this short.
 */
'use strict';

const assert = require('assert');
const dc = require('../lib/delay-case');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// The late parcel: three lines, one of them ×3.
const LINES = [
  { id: 11, product_id: 501, qty: 1, name_en: 'Beet Salad' },
  { id: 12, product_id: 502, qty: 3, name_en: 'Yoghurt' },
  { id: 13, product_id: null, qty: 2, name_en: 'Hand-typed line' },
];
const COSTS = { 501: 12.5, 502: 4, 503: 99 };
const unitCost = (pid) => COSTS[pid] || 0;

console.log('\nWhich lines go back out');

it('absent items is every line at full quantity — the old behaviour, kept', () => {
  const r = dc.resolveReplacementLines(LINES, null);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.picked.map(p => [p.line.id, p.qty]), [[11, 1], [12, 3], [13, 2]]);
});

it('a pick sends only what was picked', () => {
  const r = dc.resolveReplacementLines(LINES, [{ item_id: 12, qty: 2 }]);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.picked.map(p => [p.line.id, p.qty]), [[12, 2]]);
});

it('a zero drops the line rather than sending it', () => {
  const r = dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: 0 }, { item_id: 12, qty: 1 }]);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.picked.map(p => [p.line.id, p.qty]), [[12, 1]]);
});

it('more than was ordered is refused — a remedy is not a giveaway', () => {
  assert.strictEqual(dc.resolveReplacementLines(LINES, [{ item_id: 12, qty: 4 }]).error, 'qty_too_high');
});

it('a line from another order is refused, not ignored', () => {
  assert.strictEqual(dc.resolveReplacementLines(LINES, [{ item_id: 99, qty: 1 }]).error, 'bad_item');
});

it('the same line twice is refused', () => {
  assert.strictEqual(
    dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: 1 }, { item_id: 11, qty: 1 }]).error,
    'duplicate_item');
});

it('a pick that comes to nothing never raises an empty order', () => {
  assert.strictEqual(dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: 0 }]).error, 'no_items');
  assert.strictEqual(dc.resolveReplacementLines(LINES, []).error, 'no_items');
});

it('a fractional or negative quantity is refused', () => {
  assert.strictEqual(dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: -1 }]).error, 'bad_qty');
  assert.strictEqual(dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: 'all' }]).error, 'bad_qty');
});

it('a parcel with no lines at all is refused before anything is created', () => {
  assert.strictEqual(dc.resolveReplacementLines([], null).error, 'no_items');
});

console.log('\nWhat putting it right cost');

it('goods are costed at the PICKED quantity, not the ordered one', () => {
  const whole  = dc.replacementCost(dc.resolveReplacementLines(LINES, null).picked, unitCost, 0);
  const partly = dc.replacementCost(
    dc.resolveReplacementLines(LINES, [{ item_id: 12, qty: 1 }]).picked, unitCost, 0);
  assert.strictEqual(whole.total, 24.5);        // 12.50 + 3×4, the uncosted line free
  assert.strictEqual(partly.total, 4);
});

it('the typed freight is part of the total, and kept separately as well', () => {
  const c = dc.replacementCost(
    dc.resolveReplacementLines(LINES, [{ item_id: 11, qty: 1 }]).picked, unitCost, 8.5);
  assert.strictEqual(c.goods, 12.5);
  assert.strictEqual(c.shipping, 8.5);
  assert.strictEqual(c.total, 21);
});

it('an uncosted product does not block the replacement', () => {
  const c = dc.replacementCost(
    dc.resolveReplacementLines(LINES, [{ item_id: 13, qty: 2 }]).picked, unitCost, 6);
  assert.strictEqual(c.goods, 0);
  assert.strictEqual(c.total, 6);
});

it('a unit cost that throws is a free line, never a failed send', () => {
  const boom = () => { throw new Error('no such product'); };
  const c = dc.replacementCost(dc.resolveReplacementLines(LINES, null).picked, boom, 0);
  assert.strictEqual(c.total, null);
});

it('nothing costed and no freight stays NULL — a ¥0 there would read as free', () => {
  const c = dc.replacementCost(
    dc.resolveReplacementLines(LINES, [{ item_id: 13, qty: 1 }]).picked, unitCost, 0);
  assert.strictEqual(c.total, null);
  assert.strictEqual(c.shipping, null);
});

it('money rounds to the fen, and the total is its own breakdown added up', () => {
  const c = dc.replacementCost([{ line: { product_id: 501 }, qty: 3 }], () => 2.5, 0.125);
  assert.strictEqual(c.goods, 7.5);
  assert.strictEqual(c.shipping, 0.13);
  // Not 7.625 rounded — the halves round first, or the screen prints a total a
  // fen away from the two numbers printed beside it.
  assert.strictEqual(c.total, 7.63);
  assert.strictEqual(c.total, Math.round((c.goods + c.shipping) * 100) / 100);
});

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  fails.forEach(([n, m]) => console.log(`  ✗ ${n}\n      ${m}`));
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
