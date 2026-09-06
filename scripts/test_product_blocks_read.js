#!/usr/bin/env node
/**
 * test_product_blocks_read.js — reading the office's product blocks.
 *
 *   node scripts/test_product_blocks_read.js
 *
 * description_blocks is an array the office authors in the product editor.
 * miniapp/components/product-blocks renders eleven types of it; the counter
 * menu reads TWO — the ingredients and the allergen card.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. THE MINI APP'S COMPONENT STILL AGREES. It is a WeChat bundle and cannot
 *     be required from Node, so lib/product-blocks-read.js is a SECOND
 *     implementation of one contract. This reads that component's source and
 *     fails when the type names, the field names or the labels drift.
 *  2. BOTH INGREDIENT BLOCKS ARE UNDERSTOOD. ingredients_chips and
 *     ingredients_line carry identical items and differ only in how the mini
 *     app draws them; a reader that knew one would go blank for half the
 *     catalogue for a purely visual reason.
 *  3. CONTAINS AND MAY-CONTAIN NEVER MERGE, and each language is split on its
 *     OWN separators — the office types 大豆、坚果 with CJK commas.
 *  4. NOTHING IS INVENTED FROM ABSENCE. A product with no allergen card
 *     returns null; the sheet then says nothing, rather than deriving an
 *     allergen from free_of, which an earlier draft did and which would have
 *     told a customer a product contained something nobody declared.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'lib', 'product-blocks-read.js'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

const MINI = fs.readFileSync(
  path.join(ROOT, 'miniapp/components/product-blocks/product-blocks.js'), 'utf8');

section('The mini app still agrees');
check('the block TYPE names are the ones it renders', () => {
  for (const t of ['ingredients_chips', 'ingredients_line', 'allergen_card']) {
    assert.ok(MINI.includes(`'${t}'`), `the mini app no longer knows the type ${t}`);
  }
});
check('the FIELD names are the ones it reads', () => {
  for (const f of ['contains_en', 'contains_cn', 'may_contain_en', 'may_contain_cn',
                   'name_en', 'name_cn', 'lead', 'pct']) {
    assert.ok(MINI.includes(f), `the mini app no longer reads ${f} — the shape has moved`);
  }
});
check('the LABELS are copied from it, not composed', () => {
  for (const [en, cn] of [[R.LABELS.ingredients.en, R.LABELS.ingredients.cn],
                          [R.LABELS.allergens.en, R.LABELS.allergens.cn],
                          [R.LABELS.contains.en, R.LABELS.contains.cn],
                          [R.LABELS.mayContain.en, R.LABELS.mayContain.cn],
                          [R.LABELS.none.en, R.LABELS.none.cn]]) {
    assert.ok(MINI.includes(`'${en}'`), `"${en}" is not the mini app's wording`);
    assert.ok(MINI.includes(`'${cn}'`), `"${cn}" is not the mini app's wording`);
  }
});
check('it still splits chips on the same three separators', () => {
  assert.ok(/split\(\/\[,、，\]\/g\)/.test(MINI),
    'the mini app changed how it splits an allergen list; lib/product-blocks-read.js has not');
});

section('Ingredients');
const CHIPS = [{ type: 'ingredients_chips', items: [
  { name_en: 'Coconut milk', name_cn: '椰奶', pct: 92, lead: true },
  { name_en: 'Natural starch', name_cn: '天然淀粉' },
] }];
check('the lead ingredient and a stated percentage survive', () => {
  const g = R.ingredientsOf(JSON.stringify(CHIPS));
  assert.strictEqual(g.items[0].lead, true);
  assert.strictEqual(g.items[0].pct, 92);
  assert.strictEqual(g.items[1].lead, false);
  assert.strictEqual(g.items[1].pct, null, 'an absent percentage became a number');
});
check('ingredients_line reads the same as ingredients_chips', () => {
  const line = JSON.stringify([{ ...CHIPS[0], type: 'ingredients_line' }]);
  assert.deepStrictEqual(R.ingredientsOf(line), R.ingredientsOf(JSON.stringify(CHIPS)));
});
check('an item with no name at all is dropped; one with a single language is kept', () => {
  const g = R.ingredientsOf(JSON.stringify([{ type: 'ingredients_chips', items: [
    { name_en: '', name_cn: '' }, { name_cn: '益生菌' }] }]));
  assert.strictEqual(g.items.length, 1);
  assert.strictEqual(g.items[0].name_cn, '益生菌');
});
check('other block types are ignored, not mistaken for ingredients', () => {
  assert.strictEqual(R.ingredientsOf(JSON.stringify(
    [{ type: 'why', items: [{ name_en: 'Not an ingredient' }] }])), null);
});

section('The allergen card');
const CARD = JSON.stringify([{ type: 'allergen_card',
  contains_en: 'Coconut', contains_cn: '椰子',
  may_contain_en: 'Soy, Nuts, Gluten', may_contain_cn: '大豆、坚果、麸质' }]);
check('contains and may-contain come back as two separate lists', () => {
  const a = R.allergensOf(CARD);
  assert.deepStrictEqual(a.contains_en, ['Coconut']);
  assert.deepStrictEqual(a.may_en, ['Soy', 'Nuts', 'Gluten']);
});
check('EACH LANGUAGE IS SPLIT ON ITS OWN SEPARATORS — 、 and ，, not only ,', () => {
  const a = R.allergensOf(CARD);
  assert.deepStrictEqual(a.contains_cn, ['椰子']);
  assert.deepStrictEqual(a.may_cn, ['大豆', '坚果', '麸质'],
    'a Chinese list typed with CJK commas came back as one long chip');
});
check('a card with a contains and no may-contain is still a card', () => {
  const a = R.allergensOf(JSON.stringify([{ type: 'allergen_card', contains_en: 'Milk' }]));
  assert.deepStrictEqual(a.contains_en, ['Milk']);
  assert.deepStrictEqual(a.may_en, []);
});

section('Nothing declared returns null — nothing is inferred from absence');
for (const [label, input] of [
  ['no blocks at all', null], ['an empty array', '[]'], ['unparseable JSON', '{oops'],
  ['blocks with no allergen card', JSON.stringify([{ type: 'why' }])],
  ['an allergen card that is empty on all four', JSON.stringify(
    [{ type: 'allergen_card', contains_en: '', may_contain_cn: '  ' }])],
]) {
  check(`${label} → null`, () => {
    assert.strictEqual(R.allergensOf(input), null,
      'the sheet would draw an allergen card asserting nothing');
    assert.strictEqual(R.ingredientsOf(input), null);
  });
}

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
