#!/usr/bin/env node
/**
 * A pack that holds a COUNT, not a weight — §140.
 *
 *   node scripts/test_material_piece_pack.js
 *
 * WHY THIS EXISTS. lib/ingredient-cost.js keyed its whole decision on the
 * RECIPE unit: g or ml divides, pcs / bag / bottle / box does not, because a
 * recipe that calls for one bag consumes one bag whatever is inside it. That is
 * still right, and it left one shape unsayable. J-57 Label Paper is bought as a
 * roll of 1000 stickers for ¥9.27 and used one sticker at a time; the recipe
 * unit is pcs, so the derivation returned the roll price and every label cost
 * ¥9.27 — a thousand times its real cost, on every product that carries one.
 * Two rows in its live cost history say ¥9.27/pcs, both written by the PO
 * write-back, because the loop re-derived the same wrong number on every order.
 *
 * WHAT IS TESTED, and the split matters: Part 1 runs the REAL derivation over
 * the cases, so it is the shipped rule and not a copy of it. Part 2 asserts the
 * editor is wired to it — the fields that feed it exist and the figure it
 * produces is printed with the places it needs. Part 3 is the guard band: the
 * behaviours §140 promised not to touch, each one a row shape that exists in
 * the live catalogue today.
 *
 * Its sibling is scripts/test_price_writeback.js case 10, which drives the same
 * material through a real PO against a real database. This file is the rule;
 * that one is the loop that kept overwriting it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const COST = require('../lib/ingredient-cost');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const MAT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '18-materials.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');

// The material from the screenshot that started this, field for field.
const LABELS = {
  unit: 'pcs', buy_unit: 'pcs', buy_pack_size: 1,
  pack_contents_qty: 1000, pack_contents_unit: 'pcs',
};
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, m + ' — expected ' + b + ', got ' + a);

console.log('\n1 · a pack that holds a count');

it('a roll of 1000 labels at ¥9.27 costs ¥0.00927 a label', () => {
  const d = COST.deriveCostPerUnit(LABELS, 9.27);
  near(d.cpu, 0.00927, 'cpu');
  assert.strictEqual(d.reason, 'divided');
  assert.strictEqual(d.divisorSource, 'pack_pieces');
});

it('the divisor is reported, because the editor prints it', () => {
  assert.strictEqual(COST.deriveCostPerUnit(LABELS, 9.27).divisor, 1000);
  // The weight path reports it too, or the editor would print the arithmetic
  // for one kind of material and not the other.
  const sesame = { unit: 'g', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 500, pack_contents_unit: 'g' };
  assert.strictEqual(COST.deriveCostPerUnit(sesame, 15.8).divisor, 500);
});

it('buy_pack_size multiplies the count — a case of 4 rolls of 1000', () => {
  const d = COST.deriveCostPerUnit({ ...LABELS, buy_pack_size: 4 }, 37.08);
  near(d.cpu, 0.00927, 'cpu');
  assert.strictEqual(d.divisor, 4000);
});

it("'pc' and 'pieces' in the contents unit count as pcs", () => {
  // The same synonyms the PO write-back already treats as one unit. A row typed
  // by hand must not lose its divisor over a missing letter.
  for (const u of ['pc', 'piece', 'pieces', 'PCS']) {
    const d = COST.deriveCostPerUnit({ ...LABELS, pack_contents_unit: u }, 9.27);
    near(d.cpu, 0.00927, u);
  }
});

it('bag / bottle / box divide the same way — the rule is the count, not the word', () => {
  for (const u of ['bag', 'bottle', 'box']) {
    const d = COST.deriveCostPerUnit({ ...LABELS, unit: u, buy_unit: 'case', pack_contents_qty: 24 }, 48);
    near(d.cpu, 2, u);
  }
});

it('a zero pack size is refused, never waved through on a divisor of 1', () => {
  // Storing ¥9.27 here is the exact bug §140 closes. Null means write nothing.
  const d = COST.deriveCostPerUnit({ ...LABELS, buy_pack_size: 0 }, 9.27);
  assert.strictEqual(d.cpu, null);
  assert.strictEqual(d.reason, 'no_pack_size');
});

it('a count of zero, or none, is not a divisor', () => {
  for (const qty of [0, null, undefined, '', -5]) {
    const d = COST.deriveCostPerUnit({ ...LABELS, pack_contents_qty: qty }, 9.27);
    assert.strictEqual(d.reason, 'per_piece', 'qty ' + JSON.stringify(qty));
    near(d.cpu, 9.27, 'qty ' + JSON.stringify(qty));
  }
});

it('piecesPerBuyUnit answers only when the row says pcs', () => {
  assert.strictEqual(COST.piecesPerBuyUnit(LABELS), 1000);
  assert.strictEqual(COST.piecesPerBuyUnit({ ...LABELS, pack_contents_unit: 'g' }), 0);
  assert.strictEqual(COST.piecesPerBuyUnit({ ...LABELS, pack_contents_unit: null }), 0);
  assert.strictEqual(COST.piecesPerBuyUnit({}), 0);
  // Nothing about the word 'box' says how many are in one, so nothing infers it.
  assert.strictEqual(COST.piecesPerBuyUnit({ buy_unit: 'box', pack_contents_qty: 12 }), 0);
});

console.log('\n2 · the editor is wired to it');

it("the Contents unit dropdown offers pcs", () => {
  assert.ok(/\['g', 'kg', 'ml', 'L', 'pcs'\]\.map/.test(MAT),
    'pack_contents_unit options must include pcs — without it the divisor cannot be entered');
});

it('the editor derives through the shared module, not a copy of it', () => {
  // The one derivation. A browser-side re-implementation of this maths is what
  // let the old form store a pack price as a per-gram cost.
  assert.ok(/c\.deriveCostPerUnit\(draft, draft\.buy_price\)/.test(MAT));
  assert.ok(!/buy_price\s*\/\s*\(/.test(MAT), 'no second division in the editor');
});

it('the cost line prints the division that produced the figure', () => {
  assert.ok(/mat-costcalc/.test(MAT), 'the arithmetic must be shown');
  assert.ok(/d\.divisor > 1/.test(MAT), 'and only when there was a division');
  assert.ok(/#tab-materials-record \.mat-costcalc/.test(CSS), 'and it must be styled');
});

it('a sub-fen cost is shown to the places it needs, not rounded to ¥0.01', () => {
  // ¥0.00927 and ¥0.01 are eight percent apart. Both the record line and the
  // list column go through unitMoney for exactly that reason.
  assert.ok(/const unitMoney = /.test(MAT));
  assert.ok(/\$\{unitMoney\(d\.cpu\)\}/.test(MAT), 'the record line');
  assert.ok(/\$\{unitMoney\(cpu\)\}/.test(MAT), 'the list column');
});

console.log('\n3 · what §140 promised not to touch');

it('a per-piece row with no contents still takes the pack price', () => {
  // 29 live rows depend on this (decided 2026-08-17). A grinder bought at ¥135
  // a piece costs ¥135 a piece.
  const d = COST.deriveCostPerUnit({ unit: 'pcs', buy_unit: 'pcs', buy_pack_size: 1 }, 135);
  assert.strictEqual(d.reason, 'per_piece');
  near(d.cpu, 135, 'cpu');
});

it('a 300 g bag of chips used one bag at a time still costs ¥28', () => {
  // Contents in GRAMS on a per-piece recipe unit: recorded, and deliberately
  // not a divisor. Dividing by 300 was always wrong and still is.
  const d = COST.deriveCostPerUnit(
    { unit: 'bag', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 300, pack_contents_unit: 'g' }, 28);
  assert.strictEqual(d.reason, 'per_piece');
  near(d.cpu, 28, 'cpu');
});

it('a weighed food is unchanged — ¥15.80 for a 500 g bag is ¥0.0316/g', () => {
  const d = COST.deriveCostPerUnit(
    { unit: 'g', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 500, pack_contents_unit: 'g' }, 15.8);
  near(d.cpu, 0.0316, 'cpu');
  assert.strictEqual(d.divisorSource, 'pack_contents');
});

it('pcs contents cannot answer a weighed recipe unit', () => {
  // A count is not a weight. Asking how many grams are in 1000 labels has no
  // answer, and the row is told so rather than given a number.
  const d = COST.deriveCostPerUnit({ ...LABELS, unit: 'g' }, 9.27);
  assert.strictEqual(d.cpu, null);
  assert.strictEqual(d.reason, 'no_pack_contents');
});

it('free by design and a missing price still win over the divisor', () => {
  assert.strictEqual(COST.deriveCostPerUnit({ ...LABELS, free_by_design: 1 }, 9.27).reason, 'free_by_design');
  assert.strictEqual(COST.deriveCostPerUnit(LABELS, 0).reason, 'no_price');
  assert.strictEqual(COST.deriveCostPerUnit(LABELS, null).cpu, null);
});

it('the recipe-unit and buy-unit lists are unchanged', () => {
  // §140 adds a contents unit, not a new kind of material.
  assert.deepStrictEqual(COST.DIVISIBLE_RECIPE_UNITS, ['g', 'ml']);
  assert.deepStrictEqual(COST.PER_PIECE_RECIPE_UNITS, ['pcs', 'bag', 'bottle', 'box']);
});

if (fails.length) {
  console.log('\n' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('\nok — ' + pass + ' cases; the rule is run, the editor wiring is asserted at source.');
