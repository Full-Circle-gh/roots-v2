#!/usr/bin/env node
/**
 * test_nutrition_rows.js — reading a nutrition column into drawable rows.
 *
 *   node scripts/test_nutrition_rows.js
 *
 * lib/nutrition-rows.js exists because the counter menu became the SECOND
 * reader of a structure that only the mini app knew how to interpret. What
 * makes "Saturated" indent under "Fat" is not in the column — it is two lists
 * of label names.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. THE MINI APP'S COPY STILL AGREES. It is a WeChat bundle and cannot
 *     require this file, so the duplication is real and permanent. This reads
 *     miniapp/pages/product/product.js and fails when the two lists diverge —
 *     the only thing standing between one shared rule and two silently
 *     different ones.
 *  2. AN UNKNOWN LABEL IS KEPT, not dropped. The office types these by hand;
 *     Fibre and Calcium must reach the customer the day they are typed, not
 *     the day somebody remembers to extend a list here.
 *  3. A ROW WITH A LABEL AND NO VALUE SURVIVES. "Salt —" is a statement about
 *     the product. Only a row that is empty on both sides is an editor's blank
 *     line.
 *  4. NOTHING is null-safe by accident: the column arrives as a string from
 *     SQLite and as an object from the mini app's API, and both must work.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { nutritionRows, classify, PARENT, CHILD } = require(path.join(ROOT, 'lib', 'nutrition-rows.js'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

section('The mini app still agrees');
check('its PARENT and CHILD lists are the same as this library\'s', () => {
  const src = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
  const pull = (name) => {
    const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
    assert.ok(m, `${name} has moved or been renamed in the mini app — this check is now blind`);
    return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
  };
  assert.deepStrictEqual(pull('PARENT').slice().sort(), PARENT.slice().sort(),
    'the mini app and lib/nutrition-rows.js disagree about which rows are parents');
  assert.deepStrictEqual(pull('CHILD').slice().sort(), CHILD.slice().sort(),
    'the mini app and lib/nutrition-rows.js disagree about which rows are children');
});

section('Classifying');
check('a parent, a child, and something neither', () => {
  assert.strictEqual(classify('Fat'), 'parent');
  assert.strictEqual(classify('Saturated'), 'child');
  assert.strictEqual(classify('Fibre'), 'normal');
});
check('case and padding do not decide it', () => {
  assert.strictEqual(classify('  ENERGY '), 'parent');
});
check('Chinese labels classify too — a row typed in one language still indents', () => {
  assert.strictEqual(classify('脂肪'), 'parent');
  assert.strictEqual(classify('饱和脂肪'), 'child');
});
check('nothing at all is normal, not a crash', () => {
  assert.strictEqual(classify(null), 'normal');
  assert.strictEqual(classify(undefined), 'normal');
});

section('Reading the column');
const RAW = JSON.stringify({
  basis_en: 'per 100 g', basis_cn: '每100克',
  rows: [
    { label_en: 'Energy', label_cn: '能量', value: '612 kcal' },
    { label_en: 'Saturated', label_cn: '饱和脂肪', value: '4.2 g' },
    { label_en: 'Fibre', label_cn: '膳食纤维', value: '11 g' },
    { label_en: 'Salt', label_cn: '盐', value: '' },
    { label_en: '', label_cn: '', value: '' },
  ],
});
check('a string from SQLite and an already-parsed object read the same', () => {
  assert.deepStrictEqual(nutritionRows(RAW), nutritionRows(JSON.parse(RAW)));
});
check('the rows come back classified, in order', () => {
  const n = nutritionRows(RAW);
  assert.deepStrictEqual(n.rows.map(r => r.kind), ['parent', 'child', 'normal', 'normal']);
  assert.strictEqual(n.basis_en, 'per 100 g');
});
check('AN UNKNOWN LABEL IS KEPT — Fibre reaches the customer', () => {
  const n = nutritionRows(RAW);
  assert.ok(n.rows.some(r => r.label_en === 'Fibre'),
    'a label the lists have not heard of was dropped, so a new nutrient never appears');
});
check('a label with no value survives; a row empty on both sides does not', () => {
  const n = nutritionRows(RAW);
  assert.ok(n.rows.some(r => r.label_en === 'Salt' && r.value === ''), '"Salt —" is a statement');
  assert.strictEqual(n.rows.length, 4, 'the editor\'s blank line was kept');
});

section('Nothing to draw returns null, never an empty shell');
for (const [label, input] of [
  ['null', null], ['undefined', undefined], ['an empty string', ''],
  ['whitespace', '   '], ['unparseable JSON', '{not json'],
  ['an empty object', '{}'], ['an array', '[]'],
  ['rows present but all blank', JSON.stringify({ rows: [{ label_en: '', value: '' }] })],
]) {
  check(`${label} → null`, () => {
    assert.strictEqual(nutritionRows(input), null,
      'a caller writing `if (n)` would draw a heading over no rows');
  });
}

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
