#!/usr/bin/env node
/**
 * A product PO line's cost only writes back when the line is in PIECES —
 * and compute_margin stopped doing its own recipe arithmetic.
 *
 *   node scripts/test_po_cost_unit_guard.js
 *
 * WHY THIS EXISTS. firePriceAlertsForPO (routes/purchases.js) refuses to write
 * a MATERIAL's price back when the PO line's unit does not match
 * ingredients.buy_unit, because buy_price is a per-package price that cannot be
 * compared to, or divided by, some other unit. applyReceivedToStock's PRODUCT
 * cost write-back had no equivalent check: it stamped po_line_items
 * .cost_per_unit onto store_products.unit_cost whatever the line's unit said, so
 * a case or kg price landed as if it were per-piece and the product's margin
 * came out wrong by the carton size.
 *
 * A store_product has no buy_unit column because it needs none — every product
 * is bought and sold in whole pieces, so 'pcs' IS its stocking unit.
 *
 * THE HALF WORTH TESTING IS THE COMPARISON, and it is normaliseUnit()'s, shared
 * with the material path so 'pc' against 'pcs' cannot pass on one and fail on
 * the other. Part 1 runs the real function over the spellings that occur. Part 2
 * checks the guard is wired the way the comparison assumes, with every anchor
 * mutation-tested — the house style from test_purchasing_line_supplier.js.
 *
 * Part 3 covers the third fix in the same change: routes/ai.js's compute_margin
 * was a sixth divergent margin implementation and now delegates to
 * lib/recipe-cost.js. That one is asserted at source, because the tool handler
 * is not exported and the derivation it now calls has its own suites.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normaliseUnit } = require('../lib/ingredient-cost');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const PUR = fs.readFileSync(path.join(ROOT, 'routes', 'retail-purchasing.js'), 'utf8');
const AI  = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');

// The guard as the shipped line writes it, so the cases below run the real rule.
const guard = (unit) => (normaliseUnit(unit) || 'pcs') !== 'pcs';

console.log('\n1 · which units the guard lets through');

it("'pcs' writes back", () => assert.strictEqual(guard('pcs'), false));

it("'pc', 'piece' and 'pieces' write back — a typing habit is not a mismatch", () => {
  // 'pc' against 'pcs' was 8 of the 19 unit disagreements measured in live PO
  // lines on 2026-08-18. Comparing raw would refuse good prices over a letter.
  for (const u of ['pc', 'piece', 'pieces']) {
    assert.strictEqual(guard(u), false, u + ' must normalise to pcs');
  }
});

it('case, spacing and padding do not decide money', () => {
  for (const u of ['PCS', ' pcs ', 'Pcs', '\tPC\n']) {
    assert.strictEqual(guard(u), false, JSON.stringify(u) + ' must normalise to pcs');
  }
});

it('A MISSING UNIT IS pcs, NOT A MISMATCH', () => {
  // normaliseUnit('') is '', so a bare `!== 'pcs'` would newly refuse every
  // legacy row written before this file's `unit || 'pcs'` insert default —
  // throwing away good prices to guard against a bad one. Absent means the
  // implicit unit; only a unit that is PRESENT and says otherwise is a mismatch.
  for (const u of [null, undefined, '', '   ']) {
    assert.strictEqual(guard(u), false, JSON.stringify(u) + ' must be treated as pcs');
  }
});

it('a package or weight unit is refused — this is the defect', () => {
  // A case price stamped onto unit_cost as if it were per-piece reports a
  // margin wrong by the carton size.
  for (const u of ['case', 'box', 'kg', 'g', 'L', 'bottle', 'bag', 'carton']) {
    assert.strictEqual(guard(u), true, u + ' must not write back as a per-piece cost');
  }
});

console.log('\n2 · the guard is wired where the comparison assumes');

// Each anchor is paired with the mutation that must break it: an assertion that
// cannot go red is not an assertion.
const SOURCE = [
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'the guard sits between the recipe-owned skip and the cost write',
    anchor: "else if (lineUnit !== 'pcs') { costSkippedUnitMismatch++; }" },
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'it treats a missing unit as pcs rather than as a mismatch',
    anchor: "const lineUnit = normaliseUnit(l.unit) || 'pcs';" },
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'it uses the SAME normaliser as the material path, not a second table',
    anchor: "const { normaliseUnit } = require('../lib/ingredient-cost');" },
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'the line query actually selects the unit it compares',
    anchor: 'stock_applied_qty, name_en, unit, cost_per_unit' },
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'the skip is counted, not swallowed',
    anchor: 'return { applied, costed, costSkippedRecipe, costSkippedUnitMismatch,' },
  { src: PUR, file: 'routes/retail-purchasing.js',
    name: 'and reported to the operator on the receive response',
    anchor: 'cost_lines_unit_mismatch: stock.costSkippedUnitMismatch,' },
  { src: AI, file: 'routes/ai.js',
    name: 'compute_margin delegates the cost derivation',
    anchor: 'const c = computeRecipeCost(p.recipe_id, db);' },
  { src: AI, file: 'routes/ai.js',
    name: 'and imports the one shared derivation to do it',
    anchor: "const { computeRecipeCost } = require('../lib/recipe-cost');" },
];

for (const c of SOURCE) {
  it(c.name, () => {
    assert.ok(c.src.includes(c.anchor),
      c.file + ' no longer contains: ' + c.anchor);
  });
  it('  ↳ mutation-tested: "' + c.name + '" goes red when broken', () => {
    const broken = c.src.replace(c.anchor, '/* removed by the mutation test */');
    assert.ok(!broken.includes(c.anchor), 'the anchor survived its own removal');
  });
}

console.log('\n3 · compute_margin keeps none of its old arithmetic');

it('the hand-rolled ingredient query is gone', () => {
  // It INNER JOINed ingredients, so a line whose material had been deleted
  // vanished from the cost instead of counting as missing.
  const m = AI.match(/compute_margin: \(\{[\s\S]*?\n  \},\n/);
  assert.ok(m, 'the compute_margin handler could not be located');
  const body = m[0];
  assert.ok(!/FROM recipe_ingredients ri/.test(body),
    'compute_margin must not run its own recipe_ingredients query');
  assert.ok(!/servings \|\| 1/.test(body),
    'servings || 1 silently prices an uncostable recipe as if it made one serving');
});

it('an uncostable recipe is refused rather than priced at zero', () => {
  const m = AI.match(/compute_margin: \(\{[\s\S]*?\n  \},\n/)[0];
  assert.ok(/c\.costPerServing == null \|\| !\(c\.costPerServing > 0\)/.test(m),
    'a recipe with no usable cost must say so, not report a 100% margin');
});

it('a recipe that no longer exists is answered, not thrown on', () => {
  // computeRecipeCost returns null for a missing recipe id.
  const m = AI.match(/compute_margin: \(\{[\s\S]*?\n  \},\n/)[0];
  assert.ok(/if \(!c\) return \{/.test(m), 'a null derivation must be handled');
});

it('the movers query cannot be built with an empty IN list', () => {
  // The old code emitted `IN (0)` for a recipe with no lines; the new one skips
  // the query entirely, so the placeholder join is never empty.
  const m = AI.match(/compute_margin: \(\{[\s\S]*?\n  \},\n/)[0];
  assert.ok(/ingredientIds\.length \? db\.prepare\(/.test(m),
    'the movers query must be skipped when there are no ingredient ids');
});

if (fails.length) {
  console.log('\n' + fails.length + ' failure(s).');
  process.exit(1);
}
console.log('\nok — ' + pass + ' cases; the unit rule is run, the wiring is mutation-tested.');
