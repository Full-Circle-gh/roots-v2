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
// §129 — the counter menu reads the prose blocks too, so the same drift check
// has to cover them. Held against the mini app for the same reason as the rest:
// this file is a SECOND implementation of one contract and nothing but this
// test notices when the first one moves.
check('the PROSE type names are the ones it renders', () => {
  for (const t of R.PROSE_TYPES) {
    assert.ok(MINI.includes(`'${t}'`), `the mini app no longer knows the type ${t}`);
  }
});
check('the FIELD names are the ones it reads', () => {
  for (const f of ['contains_en', 'contains_cn', 'may_contain_en', 'may_contain_cn',
                   'name_en', 'name_cn', 'lead', 'pct',
                   // §129's prose blocks. BOTH field names, because the mini
                   // app does not use one shape: hero_intro says body_*, and
                   // notes_callout says text_*. A reader that assumed one would
                   // drop every block of the other kind in silence.
                   'body_en', 'body_cn', 'kicker_en', 'kicker_cn',
                   'text_en', 'text_cn']) {
    assert.ok(MINI.includes(f), `the mini app no longer reads ${f} — the shape has moved`);
  }
});
/* §132 — THE WHOLE BLOCK SET, AND THE DRIFT GUARD THAT MATTERS MOST HERE.
   pageBlocks() is a second implementation of the component's normaliser for
   thirteen types rather than two, so there is thirteen times as much to go
   quietly out of step. Everything below is held against the component's own
   source: the type names, the field names, the headings and the icon table. */
section('\u00a7132 — every block the office wrote');
check('every PAGE block type is one the mini app renders', () => {
  const TYPES = ['spec_strip', 'hero_intro', 'why', 'ingredients_chips', 'ingredients_line',
    'allergen_card', 'how_to_use', 'storage_box', 'notes_callout', 'big_stat', 'stat_callout',
    'pull_quote', 'image_band', 'recipe_steps', 'pairings', 'faq', 'nutrition_facts'];
  for (const t of TYPES) {
    assert.ok(MINI.includes(`'${t}'`), `the mini app no longer knows the type ${t}`);
  }
});
check('every FIELD pageBlocks reads is one the mini app reads', () => {
  for (const f of ['k_en', 'k_cn', 'v_en', 'v_cn', 'highlight_en', 'rows_en', 'rows_cn',
    'claim_en', 'claim_cn', 'tiles', 'label_en', 'sub_en', 'head_en', 'num_en', 'unit_en',
    'note_en', 'stat', 'what_en', 'who_en', 'caption_en', 'ratio', 'steps', 'time_en',
    'title_en', 'q_en', 'a_en', 'basis_en', 'value', 'alt', 'icon']) {
    assert.ok(MINI.includes(f), `the mini app no longer reads ${f} — the shape has moved`);
  }
});
check('the HEADINGS are the mini app\'s own words, not composed here', () => {
  const H = R.HEADS;
  for (const k of Object.keys(H)) {
    assert.ok(MINI.includes(`'${H[k].en}'`), `"${H[k].en}" is not the mini app's wording`);
    assert.ok(MINI.includes(`'${H[k].cn}'`), `"${H[k].cn}" is not the mini app's wording`);
  }
});
/* THE ICON TABLE IS THE ONE COPY THAT IS NOT OPTIONAL. The office picks icons
   from a general-purpose set and this is a plant-based brand; a swap table that
   drifts puts a rasher of bacon on the menu of a shop that does not sell it. */
check('the non-vegan icon swaps match the mini app ENTRY FOR ENTRY', () => {
  const mini = {};
  const block = /const PB_ICON_FIX = \{([\s\S]*?)\};/.exec(MINI);
  assert.ok(block, 'the mini app no longer has PB_ICON_FIX at all');
  const re = /'([^']+)'\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1]))) mini[m[1]] = m[2];
  assert.ok(Object.keys(mini).length >= 15, `only ${Object.keys(mini).length} swaps parsed`);
  assert.deepStrictEqual(R.ICON_FIX, mini,
    'the icon swap table has drifted from the mini app\'s');
});
check('the blocks come back in the office\'s order, and empty ones are dropped', () => {
  const got = R.pageBlocks(JSON.stringify([
    { type: 'notes_callout', text_en: 'Last in the array.' },
    { type: 'why', rows: [] },
    { type: 'spec_strip', cells: [{ k_en: 'Origin', v_en: 'Guangzhou' }] },
    { type: 'storage_box' },
    { type: 'faq', items: [{ q_en: 'Q?' }] },
  ]));
  assert.deepStrictEqual(got.map(b => b.type), ['notes_callout', 'spec_strip'],
    `order or emptiness handling is wrong: ${JSON.stringify(got.map(b => b.type))}`);
});
check('BOTH why shapes are understood — the editor\'s and the legacy one', () => {
  const modern = R.pageBlocks(JSON.stringify([
    { type: 'why', rows: [{ claim_en: 'A', claim_cn: '\u7532' }] }]))[0];
  const legacy = R.pageBlocks(JSON.stringify([
    { type: 'why', rows_en: 'A\nB', rows_cn: '\u7532\n\u4e59' }]))[0];
  assert.deepStrictEqual(modern.rows, [{ en: 'A', cn: '\u7532' }]);
  assert.deepStrictEqual(legacy.rows, [{ en: 'A', cn: '\u7532' }, { en: 'B', cn: '\u4e59' }],
    'the legacy newline shape was dropped, which is half the catalogue');
});
check('a storage card promotes a lone phrase and strips a repeated scale', () => {
  const b = R.pageBlocks(JSON.stringify([{ type: 'storage_box',
    left: { num_en: '0\u20134\u00b0', unit_en: '\u00b0C at all times' },
    right: { unit_en: 'Cool, dry place' } }]))[0];
  assert.strictEqual(b.left.unit.en, 'at all times',
    `the caption still repeats the figure's own scale: ${JSON.stringify(b.left.unit)}`);
  assert.strictEqual(b.right.num.en, 'Cool, dry place',
    'a lone phrase was left in the caption slot, where it renders as tiny type');
  assert.ok(b.right.long, 'the promoted phrase kept the hero numeral size and would clip');
  assert.ok(!b.left.long, 'a short figure was treated as a phrase');
});
check('NOTHING IS PICKED — both languages survive every block', () => {
  const b = R.pageBlocks(JSON.stringify([
    { type: 'pull_quote', text_en: 'EN', text_cn: '\u4e2d' }]))[0];
  assert.strictEqual(b.text.en, 'EN');
  assert.strictEqual(b.text.cn, '\u4e2d',
    'a language was chosen in the reader; this page ships both and lets CSS decide');
});

section('§129 — the product\'s own words');
check('the prose blocks come back in the office\'s own order', () => {
  const blocks = [
    { type: 'notes_callout', text_en: 'Stir before use.', text_cn: '食用前搅拌。' },
    { type: 'hero_intro', body_en: 'Fermented cashews.', body_cn: '发酵腰果。', kicker_en: 'K' },
  ];
  const got = R.proseOf(JSON.stringify(blocks));
  assert.deepStrictEqual(got.map(b => b.type), ['notes_callout', 'hero_intro'],
    'proseOf re-ranked the blocks; the order on the product is the order on the page');
  assert.strictEqual(got[1].kicker_en, 'K');
  assert.strictEqual(got[1].kicker_cn, '');
});
check('a block that exists and is EMPTY is dropped, not rendered as a gap', () => {
  // The editor leaves skeletons behind: the live read found `why`,
  // `how_to_use` and `storage_box` present with zero characters in both
  // languages on most products.
  assert.deepStrictEqual(R.proseOf(JSON.stringify([
    { type: 'why', body_en: '', body_cn: '' },
    { type: 'storage_box', body_en: '   ', body_cn: '' },
  ])), []);
});
check('one language alone is enough to keep a block', () => {
  const got = R.proseOf(JSON.stringify([{ type: 'hero_intro', body_en: '', body_cn: '只有中文' }]));
  assert.strictEqual(got.length, 1, 'a Chinese-only paragraph was dropped');
  assert.strictEqual(got[0].body_cn, '只有中文');
});
/* EACH TYPE'S OWN FIELD NAME, which is the one thing about this function that
   is easy to get wrong and impossible to see going wrong. hero_intro carries
   body_*; notes_callout carries text_*. The first draft read body_* for both
   and dropped every notes_callout in the catalogue — 231 of them — while
   looking exactly like a working reader. */
check('notes_callout is read from text_*, not from body_*', () => {
  const got = R.proseOf(JSON.stringify([
    { type: 'notes_callout', text_en: 'Stir before use.', text_cn: '食用前搅拌。' },
  ]));
  assert.strictEqual(got.length, 1, 'a notes_callout was dropped — it says text_en, not body_en');
  assert.strictEqual(got[0].body_en, 'Stir before use.');
  assert.strictEqual(got[0].body_cn, '食用前搅拌。');
});
check('hero_intro is read from body_*, and a text_* on it is not mistaken for one', () => {
  assert.deepStrictEqual(
    R.proseOf(JSON.stringify([{ type: 'hero_intro', text_en: 'not the paragraph' }])), [],
    'hero_intro was read from text_*, which is notes_callout\'s field');
});
/* THE STRUCTURED TYPES STAY OUT. `why` is a list of claims, `how_to_use` is
   tiles, `storage_box` is two cards, `big_stat` is a figure. Naming any of them
   a prose type without reading its shape would return nothing for it forever
   while looking like it was covered. */
check('a claim list, a tile set and a stat are NOT prose', () => {
  assert.deepStrictEqual(R.proseOf(JSON.stringify([
    { type: 'why', rows: [{ claim_en: 'Neutral enough to go sweet or savory.' }] },
    { type: 'why', rows_en: ['Legacy shape'] },
    { type: 'how_to_use', tiles: [{ text_en: 'Spoon it over oats' }] },
    { type: 'big_stat', num_en: '92', caption_en: 'percent coconut' },
  ])), []);
});
check('nothing is invented from absence', () => {
  for (const raw of [null, '', '   ', 'not json', '{}', JSON.stringify([{ type: 'allergen_card' }])]) {
    assert.deepStrictEqual(R.proseOf(raw), [], `proseOf invented prose from ${JSON.stringify(raw)}`);
  }
});
check('the LABELS are copied from it, not composed', () => {
  for (const [en, cn] of [[R.LABELS.ingredients.en, R.LABELS.ingredients.cn],
                          [R.LABELS.allergens.en, R.LABELS.allergens.cn],
                          [R.LABELS.contains.en, R.LABELS.contains.cn],
                          [R.LABELS.mayContain.en, R.LABELS.mayContain.cn],
                          [R.LABELS.madeWithout.en, R.LABELS.madeWithout.cn],
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

section('A block the office switched off for the counter menu');
// ONE FLAG, ONE SURFACE. hide_qr is read HERE and nowhere else: the mini app
// and the web storefront render the same array through their own components
// and ignore a field they do not know, which is what makes a trim on this page
// invisible to them. These checks are the whole guarantee — nothing else in
// the repo notices if the flag starts being honoured (or ignored) elsewhere.
const HIDDEN = [
  { type: 'hero_intro', body_en: 'Brewed slowly', body_cn: '慢慢酿' },
  { type: 'why', rows: [{ claim_en: 'Live cultures' }], hide_qr: true },
  { type: 'faq', items: [{ q_en: 'How long?', a_en: 'Three weeks.' }] },
];
check('it is dropped from the counter menu, and its neighbours are not', () => {
  assert.deepStrictEqual(R.pageBlocks(HIDDEN).map(b => b.type), ['hero_intro', 'faq'],
    'hiding one section took another with it, or failed to hide anything');
});
check('the same array read as JSON behaves identically', () => {
  assert.deepStrictEqual(R.pageBlocks(JSON.stringify(HIDDEN)).map(b => b.type),
    ['hero_intro', 'faq'], 'the flag is honoured for an array and not for the stored string');
});
check('an absent flag means shows — no product has to be re-ticked', () => {
  const plain = [{ type: 'why', rows: [{ claim_en: 'Live cultures' }] }];
  assert.strictEqual(R.pageBlocks(plain).length, 1,
    'a catalogue that predates the flag would have gone blank at the counter');
});
check('hide_qr: false is not hiding — only a true hides', () => {
  const off = [{ type: 'why', rows: [{ claim_en: 'Live cultures' }], hide_qr: false }];
  assert.strictEqual(R.pageBlocks(off).length, 1);
});

/* ── §230 · THE TENANT'S ALLOW-LIST, AND THE THIRD STATE IT NEEDED ─────────
   Ash: the blocks Quinoa Salad shows are the blocks every product shows. A
   rule like that can only exist if "nobody has said" is distinguishable from
   "somebody said show it", so the flag went from a boolean to three states.

   IT IS AN ALLOW-LIST. The first draft read the ask as a block-list — the two
   types Quinoa Salad has switched off, switched off everywhere — and that is
   a weaker rule: it answers for nothing Quinoa Salad does not carry, so
   `pull_quote`, `recipe_steps` and every type the editor gains later keep
   drawing. These checks pin the stronger reading.

   THE LIST IS THE CALLER'S, ALWAYS. This module holds no database handle and
   no seed of its own — a second copy of the seed here is exactly the drift
   §132's two implementations were written to avoid. */
const DEFAULTED = [
  { type: 'hero_intro', body_en: 'Brewed slowly' },
  { type: 'storage_box', left: { head_en: 'Chill', num_en: '0–4°' } },
  { type: 'notes_callout', text_en: 'Stir before use.' },
];
const ALLOW = ['hero_intro', 'allergen_card'];

check('a type OFF the allow-list does not draw, although no block says so', () => {
  assert.deepStrictEqual(R.pageBlocks(DEFAULTED, ALLOW).map(b => b.type), ['hero_intro'],
    'the allow-list was not applied — 216 products would still print the storage card');
});
check('A TYPE NOBODY LISTED IS ALSO OFF — the block-list reading would show it', () => {
  /* The whole correction. `pull_quote` is on no allow-list here and is not one
     of the types the office ever switched off, so a rule built from "what is
     switched off" would draw it. An allow-list answers for it without anybody
     having named it. */
  const quote = [{ type: 'pull_quote', text_en: 'Best soup in town.', who_en: 'A regular' }];
  assert.strictEqual(R.pageBlocks(quote, ALLOW).length, 0,
    'a type the allow-list never mentions still drew — this is the block-list bug');
  assert.strictEqual(R.pageBlocks(quote, ALLOW.concat('pull_quote')).length, 1,
    'and listing it did not bring it back');
});
check('NO LIST MEANS NO RULE — the pre-§230 reading, exactly', () => {
  assert.strictEqual(R.pageBlocks(DEFAULTED).length, 3,
    'a caller that passes nothing now hides blocks it never asked to hide');
  assert.strictEqual(R.pageBlocks(DEFAULTED, null).length, 3,
    'null is not "allow nothing" — it is "no rule in force"');
});
check('AN EMPTY LIST IS DIFFERENT AGAIN — allow nothing, and it is honoured', () => {
  assert.strictEqual(R.pageBlocks(DEFAULTED, []).length, 0,
    'an empty allow-list drew blocks — the two empty states have been conflated');
});
check('an explicit FALSE beats the allow-list: this one product shows it', () => {
  const kept = [
    { type: 'storage_box', hide_qr: false, left: { head_en: 'Chill', num_en: '0–4°' } },
    { type: 'notes_callout', text_en: 'Stir before use.' },
  ];
  assert.deepStrictEqual(R.pageBlocks(kept, ALLOW).map(b => b.type), ['storage_box'],
    'the office switched this one back on and the allow-list overruled them');
});
check('an explicit TRUE still hides a type the allow-list allows', () => {
  const off = [{ type: 'hero_intro', body_en: 'Brewed slowly', hide_qr: true }];
  assert.strictEqual(R.pageBlocks(off, ALLOW).length, 0,
    'an allowed type could no longer be switched off on one product');
});
check('hiddenHere resolves the three states on its own', () => {
  assert.strictEqual(R.hiddenHere({ type: 'storage_box' }, ALLOW), true, 'absent did not ask the list');
  assert.strictEqual(R.hiddenHere({ type: 'storage_box', hide_qr: false }, ALLOW), false, 'false did not win');
  assert.strictEqual(R.hiddenHere({ type: 'hero_intro', hide_qr: true }, ALLOW), true, 'true did not win');
  assert.strictEqual(R.hiddenHere({ type: 'hero_intro' }, ALLOW), false, 'an allowed type was hidden');
  assert.strictEqual(R.hiddenHere({ type: 'storage_box' }, undefined), false, 'no list still hid something');
  assert.strictEqual(R.hiddenHere(null, ALLOW), false, 'a missing block threw or hid');
});
check('a nutrition block held back by the allow-list still blocks the column fallback', () => {
  /* The same trap as the flag's own version above, one level down: the
     fallback asks the UNFILTERED source, so a nutrition block held back by the
     ALLOW-LIST rather than by a flag must also stop the column printing. */
  const nut = [{ type: 'nutrition_facts', basis_en: 'Per 100ml',
                 rows: [{ label_en: 'Energy', value: '98kJ' }] }];
  assert.strictEqual(R.pageBlocks(nut, ALLOW).length, 0, 'the allow-list did not hold it back');
  assert.strictEqual(R.hasNutritionBlock(nut), true,
    'the column fallback would print the table the allow-list just held back');
});
check('THE WORDS ARE NOT DELETED — the block is untouched in the source', () => {
  R.pageBlocks(HIDDEN);
  assert.deepStrictEqual(HIDDEN[1].rows, [{ claim_en: 'Live cultures' }],
    'reading the page for one surface edited what the office wrote');
});

section('A hidden nutrition block does not come back out of the column');
// THE FALLBACK IS THE TRAP. routes/shop-menu.js prints retail_products.nutrition
// when no nutrition BLOCK said it — and a block just switched off is absent
// from pageBlocks(), so asking the filtered list would read "no block" and
// print the very table the office had hidden. hasNutritionBlock answers from
// the unfiltered source, which is the only reason the switch works on that one
// block type.
check('hasNutritionBlock sees a block that pageBlocks has dropped', () => {
  const nut = [{ type: 'nutrition_facts', basis_en: 'Per 100ml',
                 rows: [{ label_en: 'Energy', value: '98kJ' }], hide_qr: true }];
  assert.strictEqual(R.pageBlocks(nut).length, 0, 'the hidden table still rendered');
  assert.strictEqual(R.hasNutritionBlock(nut), true,
    'the column fallback would print the table the office just hid');
});
check('...and says no when the office wrote no nutrition block at all', () => {
  assert.strictEqual(R.hasNutritionBlock([{ type: 'why', rows: [] }]), false);
  assert.strictEqual(R.hasNutritionBlock(null), false);
  assert.strictEqual(R.hasNutritionBlock('{oops'), false);
});

/* ── HOW TO USE: THE LAST ROW IS NEVER SHORT ──────────────────────────────
   The office types as many usage tiles as the product has moments, and four
   and five are as common as six. The old rule — four across at eight tiles or
   more, three otherwise — drew four tiles as a row of three and a row of one,
   and because the grid's gutter IS its background showing through, the two
   cells nobody filled read as a grey slab on the live sheet (Arugula-Basil
   Pesto, 2026-09-22).

   ONE RULE, FIVE COPIES. lib/product-blocks-read.js owns it; the shop sheet,
   the editor's preview and the mini app carry their own copies because none of
   them can require this one, and each stylesheet has to grow the tile into
   whatever the last row leaves. Nothing but this test notices when one of the
   five moves. */
section('How to use fills its last row, whatever the tile count');

const SHOP_JS   = fs.readFileSync(path.join(ROOT, 'public/shop/product-blocks.js'), 'utf8');
const SHOP_CSS  = fs.readFileSync(path.join(ROOT, 'public/shop/product-blocks.css'), 'utf8');
const EDITOR    = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');
const ADMIN_CSS = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');
const MENU      = fs.readFileSync(path.join(ROOT, 'routes/shop-menu.js'), 'utf8');
const SHOP_HTML = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
const MINI_PAGE = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.wxml'), 'utf8');
const MINI_SHOP = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.js'), 'utf8');
const WXSS      = fs.readFileSync(
  path.join(ROOT, 'miniapp/components/product-blocks/product-blocks.wxss'), 'utf8');
const WXML      = fs.readFileSync(
  path.join(ROOT, 'miniapp/components/product-blocks/product-blocks.wxml'), 'utf8');

check('the count picks the row width that divides most evenly', () => {
  const want = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 3, 10: 4, 11: 4, 12: 4 };
  for (const [n, cols] of Object.entries(want)) {
    assert.strictEqual(R.howToUseCols(Number(n)), cols,
      `${n} tiles should run ${cols} across`);
  }
});
check('four tiles are 2 + 2, not 3 + 1 — the case that shipped the grey slab', () => {
  const tiles = ['Spread on bread', 'Toss with pasta', 'Finish vegetables', 'Dress a bowl']
    .map(label_en => ({ label_en }));
  const [b] = R.pageBlocks([{ type: 'how_to_use', tiles }]);
  assert.strictEqual(b.cols, 2, 'four tiles still ask for a three-wide row');
  assert.strictEqual(b.tiles.length, 4, 'a tile was dropped on the way');
});
check('nothing is padded, dropped or reordered to make a row fit', () => {
  const tiles = Array.from({ length: 5 }, (_, i) => ({ label_en: 'Moment ' + (i + 1) }));
  const [b] = R.pageBlocks([{ type: 'how_to_use', tiles }]);
  assert.strictEqual(b.cols, 3, 'five tiles should be 3 + 2');
  assert.deepStrictEqual(b.tiles.map(t => t.lbl.en),
    ['Moment 1', 'Moment 2', 'Moment 3', 'Moment 4', 'Moment 5']);
});
check('no renderer still carries the "eight or more" rule', () => {
  for (const [name, src] of [['the shop sheet', SHOP_JS], ['the editor preview', EDITOR],
                             ['the mini app', MINI], ['the reader', String(R.howToUseCols)]]) {
    assert.ok(!/>=\s*8\s*\?\s*4\s*:\s*3/.test(src),
      `${name} still picks its columns the old way — four tiles will draw a hole`);
  }
});
check('every copy of the rule agrees on the two counts that broke', () => {
  for (const [name, src] of [['the shop sheet', SHOP_JS], ['the editor preview', EDITOR],
                             ['the mini app', MINI]]) {
    assert.ok(/===\s*4\s*(\?|\))\s*(return\s*)?2/.test(src),
      `${name} no longer runs four tiles two across`);
    assert.ok(/===\s*9\s*(\?|\))\s*(return\s*)?3/.test(src),
      `${name} no longer runs nine tiles three across`);
  }
});
check('the width reaches the markup in all four renderers', () => {
  assert.ok(SHOP_JS.includes("'<div class=\"spb-how-grid cols-' + cols +"),
    'the shop sheet drops the width on the floor');
  assert.ok(EDITOR.includes('pa-prev-how-grid cols-${cols}'),
    'the editor preview drops the width on the floor');
  assert.ok(MENU.includes('`<div class="pb-how c${b.cols'),
    'the QR menu drops the width on the floor');
  assert.ok(WXML.includes('pb-how-grid cols-{{item.cols}}'),
    'the mini app drops the width on the floor');
});
check('the tile grows into the last row in every stylesheet', () => {
  const sheets = [['the shop sheet', SHOP_CSS, 'spb-how-grid', 'cols-'],
                  ['the QR menu', MENU, 'pb-how{', 'c'],
                  ['the editor preview', EDITOR, 'pa-prev-how-grid', 'cols-'],
                  ['the back office', ADMIN_CSS, 'pa-prev-how-grid', 'cols-'],
                  ['the mini app', WXSS, 'pb-how-grid', 'cols-']];
  for (const [name, src, sel, prefix] of sheets) {
    const at = src.indexOf(sel);
    assert.ok(at > -1, `${name} no longer styles the how-to-use grid`);
    const rule = src.slice(at, at + 400);
    assert.ok(/display:\s*flex/.test(rule) && /flex-wrap:\s*wrap/.test(rule),
      `${name} is back on a fixed grid — an unfilled cell will show as a slab`);
    for (const n of [1, 2, 3, 4]) {
      assert.ok(src.includes(prefix + n),
        `${name} has no width for ${n} across`);
    }
  }
});

/* ── FREE OF: THE CARD WINS ────────────────────────────────────────────────
   §232. free_of is the storefront's filter tag set, assigned in bulk from a
   label sheet — never a sentence the kitchen wrote about one product. It may
   not ADD an allergen; it may only show a flag the office set AND the card is
   silent about.

   THE NUMBERS THAT MADE THE RULE, measured on the live catalogue 2026-09-22:
   of 45 products carrying both a free_of value and an allergen card, 34 had a
   flag the card ALSO listed under "may contain traces of" and 4 had one the
   card listed under "contains". Seitan is tagged free of soy and its card says
   it contains soy. Printed raw, the row would have contradicted the card on
   eight products in ten — which is why every fixture below is a real product,
   with the values it carried that day.

   §241 NARROWED WHICH ROW CANCELS A FLAG. Every product now carries the
   shared-facility trace line (nuts, soy, gluten), so the row reads "Made
   without" — a recipe claim — and a TRACE warning no longer contradicts it.
   Only the CONTAINS row cancels a flag. The fixtures keep their real values;
   what survives changed where the overlap was only in may-contain. */
section('Made without — a flag the card says the food CONTAINS never prints');

const FREE_OF_CASES = [
  // [name, free_of, card, what should survive]
  ['Garlic Dill Sour Cream', 'soy, gluten',
   { contains_en: ['Tree nuts (cashew)'], contains_cn: [], may_en: ['Soy', 'Gluten'], may_cn: [] }, ['Soy', 'Gluten']],
  ['Mix Color Quinoa', 'nuts, soy, gluten, 5 spice',
   { contains_en: ['None declared'], contains_cn: [], may_en: ['Tree nuts', 'Soy', 'Gluten'], may_cn: [] },
   ['Nuts', 'Soy', 'Gluten', '5 Spice']],
  ['Mango Protein Bites', 'soy, gluten, 5 spice',
   { contains_en: ['Cashews', 'Walnuts', 'Coconut'], contains_cn: ['腰果', '核桃', '椰子'], may_en: [], may_cn: [] },
   ['Soy', 'Gluten', '5 Spice']],
  ['Seitan', 'nuts, soy',
   { contains_en: ['Gluten (wheat)', 'soy'], contains_cn: [], may_en: ['Nuts'], may_cn: [] }, ['Nuts']],
  ['Minced meat', 'nuts',
   { contains_en: ['Wheat', 'Soy'], contains_cn: ['麸质', '大豆'], may_en: [], may_cn: [] }, ['Nuts']],
];

check('every live case resolves the way the card says', () => {
  for (const [name, raw, card, want] of FREE_OF_CASES) {
    assert.deepStrictEqual(R.freeOfChips(raw, card).map(c => c.en), want,
      `${name} would print the wrong Made without row`);
  }
});
check('THE ONE THAT MUST NEVER REGRESS — a card saying "contains soy" kills the soy flag', () => {
  const card = { contains_en: ['Gluten (wheat)', 'soy'], contains_cn: [], may_en: [], may_cn: [] };
  assert.deepStrictEqual(R.freeOfChips('soy', card), [],
    'the sheet would have told a customer avoiding soy that Seitan is free of it');
});
check('a card written only in Chinese is read too', () => {
  const card = { contains_en: [], contains_cn: ['腰果'], may_en: [], may_cn: ['大豆'] };
  assert.deepStrictEqual(R.freeOfChips('nuts, soy', card).map(c => c.en), ['Soy'],
    'the English half was empty, so the Chinese allergens went unseen');
});
check('§241 — a trace warning does not cancel a recipe claim', () => {
  // Quinoa Salad, the product Ash was looking at: flags nuts, soy, 5 spice and
  // a card whose may-contain names nuts and soy. §232 showed only 5 Spice.
  const card = { contains_en: [], contains_cn: [], may_en: ['Nuts', 'Soy'], may_cn: ['坚果', '大豆'] };
  assert.deepStrictEqual(R.freeOfChips('nuts,soy,5 spice', card).map(c => c.en),
    ['Nuts', 'Soy', '5 Spice'], 'the may-contain row still cancels the made-without row');
});
check('both spellings of the 5-spice token mean the one flag', () => {
  const card = { contains_en: ['Salt'], contains_cn: [], may_en: [], may_cn: [] };
  for (const raw of ['5 spice', '5spice', '5 Spice']) {
    assert.deepStrictEqual(R.freeOfChips(raw, card).map(c => c.en), ['5 Spice'],
      `"${raw}" did not resolve to the 5-spice flag`);
  }
});
check('a retired flag, or anything else parked in the column, prints nothing', () => {
  const card = { contains_en: ['Salt'], contains_cn: [], may_en: [], may_cn: [] };
  assert.deepStrictEqual(R.freeOfChips('animal products, dairy, egg, palm oil', card), [],
    'a value the four-flag list does not know reached a customer');
});
check('no card, no row — and an empty column is not a claim', () => {
  assert.deepStrictEqual(R.freeOfChips('nuts, soy', null), []);
  assert.deepStrictEqual(R.freeOfChips('', { contains_en: ['Salt'], contains_cn: [], may_en: [], may_cn: [] }), []);
  assert.deepStrictEqual(R.freeOfChips(null, { contains_en: [], contains_cn: [], may_en: [], may_cn: [] }), []);
});
check('the list is still closed at four, in every copy of it', () => {
  assert.deepStrictEqual(R.FREE_OF_FLAGS.map(f => f.id), ['nuts', 'soy', 'gluten', '5 spice'],
    'the reader knows a flag the back office cannot set');
  for (const [name, src] of [['the shop sheet', SHOP_JS], ['the mini app', MINI]]) {
    const ids = [...src.matchAll(/\{ id: '([^']+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(ids, ['nuts', 'soy', 'gluten', '5 spice'],
      `${name} carries a different set of free-of flags`);
  }
});
check('every copy drops on the same words — the lists cannot drift apart', () => {
  for (const f of R.FREE_OF_FLAGS) {
    for (const w of f.words) {
      for (const [name, src] of [['the shop sheet', SHOP_JS], ['the mini app', MINI]]) {
        assert.ok(src.includes(`'${w}'`),
          `${name} does not drop the ${f.id} flag on "${w}"`);
      }
    }
  }
});
check('the QR menu asks for the column, and subtracts the card before printing it', () => {
  assert.ok(/p\.free_of/.test(MENU), 'the QR menu no longer reads free_of at all');
  assert.ok(/blockRead\.freeOfChips\(it\.free_of, a\)/.test(MENU),
    'the QR menu prints free_of without subtracting what the card says');
  assert.ok(/\.achip\.free\{/.test(MENU), 'the free-of chip has no style of its own');
});
check('the shop sheet is handed the column by its host page', () => {
  assert.ok(/freeOf:p\.free_of/.test(SHOP_HTML), 'shop.html renders blocks without the column');
  assert.ok(/spb-al-chip-free/.test(SHOP_JS) && /spb-al-chip-free/.test(SHOP_CSS),
    'the shop sheet has no free-of chip');
});
check('the mini app is handed the column by its product page', () => {
  assert.ok(/free-of="\{\{product\.free_of\}\}"/.test(MINI_PAGE),
    'the mini app renders blocks without the column');
  assert.ok(/pb-al-chip-free/.test(WXML) && /pb-al-chip-free/.test(WXSS),
    'the mini app has no free-of chip');
});

/* ── §236: ONE SHAPE, AND THE FILL IS THE DIFFERENCE ──────────────────────
   Ash, on the dietary badge row under a product's name — squared outline
   boxes, caps, one shape repeated: "what about this style". The allergen card
   carried three shapes at once (a filled pill, a dashed pill, a solid green
   one) and centred all of them, so three statements shared no edge.

   THE CARD IS NOW THAT BADGE: a square box, and the FILL says whether the
   thing is in the food or not. Two states, no third colour. May-contain
   leaves the boxes entirely — it holds a 90-character facility warning on
   some products, and a box around a sentence is a box with a paragraph in it.

   THE SAME THREE RENDERERS AS EVER, none of which can require the others. */
section('The allergen card is one shape, and the fill is the difference');

const PRODUCT_PAGE_JS = fs.readFileSync(
  path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

check('no renderer still draws a pill', () => {
  // The selector is named per file rather than guessed: the editor also has a
  // `.pa-allergen-chip` — the picker the office ticks allergens from, a
  // different control on a different screen that keeps its own look.
  for (const [name, src, sel] of [['the shop sheet', SHOP_CSS, '.spb-al-chip {'],
                                  ['the mini app', WXSS, '.pb-al-chip {'],
                                  ['the editor preview', EDITOR, '.pa-prev-allergen-chip {'],
                                  ['the back office', ADMIN_CSS, '.pa-prev-allergen-chip {']]) {
    const at = src.indexOf(sel);
    assert.ok(at > -1, `${name} no longer styles the allergen chip`);
    const rule = src.slice(at, at + 420);
    assert.ok(/border-radius:\s*0/.test(rule),
      `${name} still rounds the allergen chip — the card is back to pills`);
    assert.ok(/text-transform:\s*uppercase/.test(rule) && /letter-spacing/.test(rule),
      `${name} lost the badge's caps`);
  }
  assert.ok(/\.achip\{[^}]*border-radius:0/.test(MENU.replace(/\s+/g, '')),
    'the QR menu still rounds the allergen chip');
});
check('the two states are a fill and an outline, and nothing else', () => {
  for (const [name, src] of [['the QR menu', MENU], ['the shop sheet', SHOP_CSS],
                             ['the mini app', WXSS], ['the editor preview', EDITOR],
                             ['the back office', ADMIN_CSS]]) {
    assert.ok(!/chip-soft|chip\.soft|achip\.may/.test(src),
      `${name} still carries the third chip style the card was reduced from`);
  }
});
check('may-contain is set as a sentence in every renderer', () => {
  assert.ok(/class="aline"/.test(MENU), 'the QR menu still boxes the may-contain list');
  assert.ok(/spb-allergen-line/.test(SHOP_JS) && /spb-allergen-line/.test(SHOP_CSS),
    'the shop sheet still boxes the may-contain list');
  assert.ok(/pb-allergen-line/.test(WXML) && /pb-allergen-line/.test(WXSS),
    'the mini app still boxes the may-contain list');
  assert.ok(/pa-prev-allergen-line/.test(EDITOR), 'the editor preview still boxes it');
});
check('and it is rejoined with the comma the office typed', () => {
  // splitChips eats 、 and , alike; an ASCII comma between two Chinese words
  // is the wrong punctuation, so each renderer puts back the right one.
  assert.ok(/'、'/.test(MENU) && /run\(en, ', '\)/.test(MENU),
    'the QR menu rejoins both languages on an ASCII comma');
  assert.ok(/names\.join\('、'\)/.test(SHOP_JS) && /names\.join\(', '\)/.test(SHOP_JS),
    'the shop sheet does not');
  assert.ok(/names\.join\('、'\)/.test(MINI) && /names\.join\(', '\)/.test(MINI),
    'the mini app does not');
});

/* ── §241: ONE TRACE LINE FOR THE WHOLE SHOP ──────────────────────────────
   Ash, 2026-09-23: every product is made in one shared facility, the warning
   is required by law, and "may contain traces of" reads the same on every
   product — nuts, soy, gluten (shared facility). Of the extras the live read
   found (scripts/diagnose_may_contain_list.js), peanuts, sesame and seeds are
   kept where a card names them; dairy and celery are not, on Ash's word. */
section('May contain traces of — the facility line');

check('every product reads the same three, whatever its card says', () => {
  for (const card of [null,
    { may_en: [], may_cn: [] },
    { may_en: ['Tree nuts', 'Soy', 'Gluten'], may_cn: ['坚果', '大豆', '麸质'] },
    // Office text parked in the wrong field, as found on the live catalogue.
    { may_en: ['Nut-free · Soy-free · Gluten-free'], may_cn: [] },
    { may_en: ['Dairy-free', 'fully plant-based'], may_cn: ['不含乳制品'] },
    // The two extras Ash dropped.
    { may_en: ['dairy', 'Celery'], may_cn: ['乳', '芹菜'] }]) {
    const t = R.facilityTraces(card);
    assert.deepStrictEqual(t.en, ['Nuts', 'Soy', 'Gluten'], JSON.stringify(card));
    assert.deepStrictEqual(t.cn, ['坚果', '大豆', '麸质'], JSON.stringify(card));
  }
});
check('peanuts, sesame and seeds are added where the card names them, in either language', () => {
  assert.deepStrictEqual(R.facilityTraces({ may_en: ['Peanuts'], may_cn: [] }).en,
    ['Nuts', 'Soy', 'Gluten', 'Peanuts'], 'the walnuts lost their peanut warning');
  assert.deepStrictEqual(R.facilityTraces({ may_en: [], may_cn: ['芝麻'] }).en,
    ['Nuts', 'Soy', 'Gluten', 'Sesame'], 'a Chinese-only sesame warning went unseen');
  assert.deepStrictEqual(R.facilityTraces({ may_en: ['Other seeds'], may_cn: ['其他籽类'] }).cn,
    ['坚果', '大豆', '麸质', '种子类']);
});
check('the note and the lists are the same in every renderer', () => {
  assert.deepStrictEqual(R.FACILITY_NOTE, { en: '(shared facility)', cn: '（共用生产环境）' });
  for (const [name, src] of [['the shop sheet', SHOP_JS], ['the mini app', MINI], ['the editor preview', EDITOR]]) {
    for (const x of R.FACILITY_TRACES.concat(R.TRACE_EXTRAS)) {
      assert.ok(src.includes(`en: '${x.en}'`) && src.includes(`cn: '${x.cn}'`),
        `${name} does not carry ${x.en} / ${x.cn}`);
      for (const w of x.words || []) {
        assert.ok(src.includes(`'${w}'`), `${name} does not match ${x.en} on "${w}"`);
      }
    }
    assert.ok(src.includes("'(shared facility)'") && src.includes("'（共用生产环境）'"),
      `${name} does not carry the shared-facility note`);
  }
  assert.ok(/blockRead\.facilityTraces\(a\)/.test(MENU) && /blockRead\.FACILITY_NOTE/.test(MENU),
    'the QR menu does not print the facility line');
});
check('the row is "Made without" in every renderer, and "Free of" is gone from the card', () => {
  for (const [name, src] of [['the shop sheet', SHOP_JS], ['the mini app', MINI]]) {
    assert.ok(src.includes("'Made without'") && src.includes("'配方不含'"), `${name} lacks the new label`);
    assert.ok(!src.includes("'Free of'"), `${name} still says Free of`);
  }
  assert.ok(/L\.madeWithout/.test(MENU), 'the QR menu does not use the new label');
});
check('every row starts at the same left edge', () => {
  for (const [name, src, sel] of [['the shop sheet', SHOP_CSS, '.spb-allergen-row {'],
                                  ['the mini app', WXSS, '.pb-allergen-row {'],
                                  ['the back office', ADMIN_CSS, '.pa-prev-allergen-row {']]) {
    const at = src.indexOf(sel);
    assert.ok(at > -1, `${name} no longer styles the allergen row`);
    const rule = src.slice(at, at + 260);
    assert.ok(/flex-direction:\s*column/.test(rule) && /align-items:\s*flex-start/.test(rule),
      `${name} is back to a label column beside its values`);
  }
  assert.ok(/\.arow\{[^}]*align-items:flex-start/.test(MENU.replace(/\s+/g, '')),
    'the QR menu centres the allergen rows again');
});

/* THE BADGE ROW UNDER THE PRODUCT NAME SAYS IT ONCE, AND THE CARD SAYS IT.
   NUT FREE / SOY FREE / GLUTEN FREE / 5-SPICE FREE sat under the name while
   §232 put the same four flags in the card's own Free of row — where they are
   checked against the card and these were not. Ash: "drop the three free
   badges". PLANT-BASED stays: it is a statement about the shop rather than an
   allergen, true of every product, with no row on the card to hold it. */
/* §242 — and then the row itself. Ash, on the PLANT-BASED badge §236 kept:
   "its not neccesary can drop that from all products". */
check('the product page draws no badge row at all', () => {
  assert.ok(!/const badges =/.test(PRODUCT_PAGE_JS), 'the product page still builds a badge row');
  assert.ok(!PRODUCT_PAGE_JS.includes("'PLANT-BASED'"), 'the PLANT-BASED badge came back');
  assert.ok(!/class="badges"/.test(MINI_PAGE), 'the product page still draws a badge row');
  for (const dead of ['NUT FREE', 'SOY FREE', 'GLUTEN FREE', '5-SPICE FREE']) {
    assert.ok(!PRODUCT_PAGE_JS.includes(dead),
      `the product page still badges "${dead}" beside the card that says it`);
  }
});
check('...and the LISTING filters keep every one of them, worded as MADE WITHOUT (§244)', () => {
  // The shop's own filter chips are a different control on a different screen:
  // they pick products, they do not describe one. Cutting these would have
  // been the easy over-reach. §244 rewords them to agree with the card: one
  // MADE WITHOUT label and the four bare names, no "FREE" promise.
  for (const [name, src] of [['the web shop', SHOP_HTML], ['the mini app', MINI_SHOP]]) {
    for (const key of ['nuts', 'soy', 'gluten', '5spice']) {
      assert.ok(new RegExp(`key: ?'${key}'`).test(src), `${name} lost the "${key}" listing filter`);
    }
    for (const w of ["'MADE WITHOUT'", "'配方不含'", "'NUTS'", "'SOY'", "'GLUTEN'", "'5-SPICE'"]) {
      assert.ok(src.includes(w), `${name} does not say ${w}`);
    }
    for (const dead of ['NUT FREE', 'SOY FREE', 'GLUTEN FREE', '5-SPICE FREE']) {
      assert.ok(!src.includes(`'${dead}'`), `${name} still promises "${dead}"`);
    }
  }
});
check('§244 — the 5-spice chip selects the token that is actually stored, and only food', () => {
  // Every product stores "5 spice"; the chip's key is "5spice". The old filter
  // compared the two directly, so the chip always came back empty.
  const load = (src, fn) => new Function(
    src.slice(src.indexOf(src.includes('const SL_DIET_LABEL') ? 'const SL_DIET=' : 'const DIETARY_FILTERS'),
              src.indexOf('\n}\n', src.indexOf(`function ${fn}`)) + 2) + `;return ${fn};`)();
  for (const [name, f] of [['the web shop', load(SHOP_HTML, 'slMadeWithout')],
                           ['the mini app', load(MINI_SHOP, 'madeWithout')]]) {
    assert.strictEqual(f({ free_of: 'nuts, soy, gluten, 5 spice', is_food: true }, '5spice'), true,
      `${name}: the 5-spice chip still finds nothing`);
    assert.strictEqual(f({ free_of: 'Nuts,Soy', is_food: true }, 'nuts'), true, `${name}: case or spacing defeats the match`);
    assert.strictEqual(f({ free_of: 'gluten', is_food: true }, 'soy'), false, `${name}: an unset flag matched`);
    assert.strictEqual(f({ free_of: 'nuts, soy, gluten, 5 spice', is_food: false }, 'nuts'), false,
      `${name}: a floor cleaner is listed as made without nuts`);
  }
  const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  assert.ok(/for \(const r of rows\) r\.is_food = isFoodCategory\(r\.category\)/.test(RETAIL),
    'the product list does not say which rows are food');
});
check('the back office still offers the four flags to tick', () => {
  for (const id of ['nuts', 'soy', 'gluten', '5 spice']) {
    assert.ok(ADMIN_HTML.includes(`data-freeof-id="${id}"`),
      `the details panel can no longer set "${id}"`);
  }
});

/* ── "NOTHING HERE" IS NOT AN ALLERGEN ────────────────────────────────────
   §236 made the contains value a filled box. Half the catalogue writes that
   field as "None declared" — 21 of the 45 cards sampled on 2026-09-22, with
   the Chinese half spelling it four ways — so without this the loudest object
   on the card would be a black box announcing that there is no risk. */
section('A contains field that says "nothing" is drawn quietly');

check('every spelling the catalogue actually uses is recognised', () => {
  for (const said of ['None declared', 'None', '未声明常见致敏原', '本产品不含已知致敏原',
                      '无已知致敏原', '无', 'none declared.', ' None Declared ']) {
    assert.strictEqual(R.saysNone([said]), said.trim(),
      `"${said}" would have printed as a filled allergen box`);
  }
});
check('THE ONE THAT MUST NEVER REGRESS — a real allergen is never swallowed', () => {
  for (const said of ['Soy', 'Oats (gluten)', 'None declared except soy',
                      'Tree nuts (cashew)', '大豆', '无麸质谷物以外的坚果']) {
    assert.strictEqual(R.saysNone([said]), '',
      `"${said}" would have been hidden as an empty state`);
  }
  // Two values are a list, whatever either one says.
  assert.strictEqual(R.saysNone(['None', 'Soy']), '');
  assert.strictEqual(R.saysNone([]), '');
  assert.strictEqual(R.saysNone(null), '');
});
check('the office keeps its own words — the phrase is not swapped for ours', () => {
  assert.strictEqual(R.saysNone(['本产品不含已知致敏原']), '本产品不含已知致敏原',
    'a food label was edited to save a lookup');
});
check('every renderer asks before it draws a box', () => {
  assert.ok(/blockRead\.saysNone\(a\.contains_en\)/.test(MENU), 'the QR menu does not');
  assert.ok(/saysNone\(contains\)/.test(SHOP_JS), 'the shop sheet does not');
  assert.ok(/_saysNone\(contains\)/.test(MINI), 'the mini app does not');
  assert.ok(/saysNone\(contains\)/.test(EDITOR), 'the editor preview does not');
});
check('and every copy of the list holds the same phrases', () => {
  for (const phrase of R.NONE_PHRASES) {
    for (const [name, src] of [['the shop sheet', SHOP_JS], ['the mini app', MINI],
                               ['the editor preview', EDITOR]]) {
      assert.ok(src.includes(`'${phrase}'`),
        `${name} does not know "${phrase}" means nothing to declare`);
    }
  }
});

/* ── §243: EVERY FOOD PRODUCT CARRIES THE CARD, NOTHING ELSE DOES ─────────
   Ash, 2026-09-23: by category — food gets the card with the trace line even
   when the office wrote none; home care, beauty and internal restock rows get
   no card at all; bought-in powders are food ("packed in our facility"). The
   categories are the live ones (scripts/diagnose_product_categories.js). */
section('Which products carry the card');

check('the three non-food categories, spelled the way the office typed them', () => {
  for (const c of ['Home & Body', 'home  &  body', 'Personal Care', 'Restock- only，internal', 'Restock-only, internal']) {
    assert.strictEqual(R.isFoodCategory(c), false, `"${c}" would carry a food warning`);
  }
});
check('everything else is food — including powders, supplements, and no category at all', () => {
  for (const c of ['Ready to Eat', 'Wellness', 'Drinks', 'Dry & Pantry', 'Fresh & Deli', 'Toasts',
                   'Snacks & Treats', 'Platters', '', null, undefined, 'A category added next month']) {
    assert.strictEqual(R.isFoodCategory(c), true, `"${c}" would lose the trace line`);
  }
});
check('the product API hands every surface the one answer', () => {
  const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  assert.ok(/product\.is_food = require\('\.\.\/lib\/product-blocks-read'\)\.isFoodCategory\(product\.category\)/.test(RETAIL),
    'GET /api/retail/products/:id no longer says whether a product is food');
});
check('the shop sheet adds the card to food with none, and strips it from anything else', () => {
  const sandbox = {};
  new Function('window', SHOP_JS + '\n;')(sandbox);
  const SPB = sandbox.ShopProductBlocks;
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const bare = text(SPB.render([], { lang: 'en', freeOf: 'nuts', food: true }));
  assert.ok(bare.includes('Nuts, Soy, Gluten (shared facility)'), 'food with no card shows no trace line');
  assert.ok(bare.includes('Made without'), 'food with no card lost its made-without row');
  assert.ok(!bare.includes('Contains') && !bare.includes('None declared'),
    'a card nobody wrote claims something about what the product contains');
  assert.strictEqual(SPB.render([{ type: 'allergen_card', contains_en: 'Soy' }], { lang: 'en', food: false }), '',
    'a product that is not food still draws an allergen card');
  const written = text(SPB.render([{ type: 'allergen_card', contains_en: 'Sesame' }], { lang: 'en', food: true }));
  assert.ok(written.includes('Contains') && written.includes('Sesame'), "the office's own card was replaced");
  assert.strictEqual((written.match(/Allergens/g) || []).length, 1, 'food with a card got a second one');
  assert.ok(/food:p\.is_food===true/.test(SHOP_HTML) && /ShopProductBlocks\.render\(\[\],blockOpts\)/.test(SHOP_HTML),
    'shop.html does not hand the sheet is_food, or skips the card on a page with no blocks');
});
check('the QR menu opens every food product and draws the card built from nothing', () => {
  assert.ok(/const food = blockRead\.isFoodCategory\(it\.category\)/.test(MENU), 'the QR menu does not ask');
  assert.ok(/if \(!food && !blocks\.length/.test(MENU), 'a food product with no blocks still does not open');
  assert.ok(/const algHtml = !food \? ''/.test(MENU), 'a non-food product still draws its card');
  assert.ok(/wroteNothing \? '' : containsRow/.test(MENU), 'a card nobody wrote still claims "None declared"');
});
check('the mini app does the same, on block pages and on plain ones', () => {
  assert.ok(/p\.is_food === false\) pageBlocks = noCard\(pageBlocks\)/.test(PRODUCT_PAGE_JS), 'non-food keeps its card');
  assert.ok(/facilityBlocks = \(p\.is_food === true && !useBlocks\)/.test(PRODUCT_PAGE_JS),
    'a food page with no blocks gets no card');
  assert.ok(/blocks="\{\{facilityBlocks\}\}"/.test(MINI_PAGE), 'the product page never draws the facility card');
  assert.ok(/const facilityOnly = !!b\._facility/.test(MINI) && /wx:if="\{\{!item\.facilityOnly\}\}"/.test(WXML),
    'the component draws a Contains row on a card nobody wrote');
});

/* ── §246: ON THE COUNTER MENU THE CARD SITS UNDER THE INGREDIENTS ───────
   Ash, after §245's trial: "alergin block should go under ingridents". The
   head is the name alone again; §245's spec-strip hoist is undone. */
section('QR menu — where the allergen card sits');
check('the card follows the first ingredients block, and nothing is hoisted into the head', () => {
  assert.ok(!/specHtml|specAt/.test(MENU), '§245 spec-strip hoist is still in place');
  assert.ok(/<div class="dt-nm">\$\{bi\(it\.name_en, it\.name_cn\)\}<\/div><\/div>/.test(MENU),
    'the sheet head still carries more than the name');
  assert.ok(/x\.b\.type === 'ingredients_chips' \|\| x\.b\.type === 'ingredients_line'/.test(MENU) &&
            /ingAt !== -1 \? ingAt \+ 1/.test(MENU), 'the card is not placed after the ingredients');
  assert.ok(/bodyBands\.splice\(cardAt, 0, algHtml\)/.test(MENU), 'the card is not placed into the body');
});

/* ── §247: THE WEB SHOP DRAWS THE NUTRITION COLUMN WHEN THERE IS NO BLOCK ──
   The QR menu and the mini app both fall back to the product's nutrition
   column; the web shop read blocks only, so a column-only product showed no
   nutrition there. Ash: "for webshop, fix it". */
section('Web shop — nutrition from the column');
check('the column is drawn as a nutrition block, once, and only when no block exists', () => {
  const sandbox = {};
  new Function('window', SHOP_JS + '\n;')(sandbox);
  const SPB = sandbox.ShopProductBlocks;
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const nut = { basis_en: 'Per 100g', rows: [{ label_en: 'Energy', value: '520 kJ' }] };
  assert.ok(text(SPB.render([], { lang: 'en', nutrition: nut })).includes('520 kJ'),
    'a column-only product still has no nutrition on the web shop');
  const both = SPB.render([{ type: 'nutrition_facts', basis_en: 'Per serving',
    rows: [{ label_en: 'Energy', value: '1 kJ' }] }], { lang: 'en', nutrition: nut });
  assert.ok(both.includes('1 kJ') && !both.includes('520 kJ'), 'the table printed twice, or the column beat the block');
  assert.strictEqual(SPB.render([], { lang: 'en', nutrition: null }), '', 'something was drawn from nothing');
  assert.ok(/nutrition:p\.nutrition\|\|null/.test(SHOP_HTML), 'shop.html does not hand the sheet the column');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
