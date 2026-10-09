#!/usr/bin/env node
/**
 * test_products_no_category_chip.js — Products has a "No category yet" chip.
 *
 *   node scripts/test_products_no_category_chip.js
 *
 * The category chips only listed categories that exist, so a product with no
 * category at all could be found from All and nowhere else. The last chip,
 * "No category yet · 尚未分类" (the live pair the product editor already uses
 * for the same state), lists exactly those products.
 *
 * Driven in a sandbox against the real functions, because the match is the
 * part that is easy to get wrong: blank and whitespace-only categories are
 * both "none", and a product with a legacy kitchen category but no storefront
 * one still has a category.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));

const PROD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const slice = (from, to) => {
  const a = PROD.indexOf(from), b = PROD.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('could not find ' + from + ' … ' + to);
  return PROD.slice(a, b);
};

const PRODUCTS = [
  { id: 1, top_category: 'Drinks' },
  { id: 2, top_category: '', category: 'Kitchen' },   // legacy category still counts
  { id: 3, top_category: '', category: '' },          // none
  { id: 4, top_category: '   ' },                     // whitespace is none too
  { id: 5 },                                          // missing fields: none
];

const els = {
  'pa-filter':    { value: 'all', innerHTML: '', options: [] },
  'pa-subfilter': { value: 'all', innerHTML: '', options: [], style: {} },
  'pa-chips':     { innerHTML: '' },
};
// innerHTML on a <select> becomes its options, so `sel.value = …` can be checked.
for (const id of ['pa-filter', 'pa-subfilter']) {
  let html = '';
  Object.defineProperty(els[id], 'innerHTML', {
    get: () => html,
    set: (v) => { html = v; els[id].options = [...v.matchAll(/value="([^"]*)"/g)].map(m => ({ value: m[1] })); },
  });
}

const sandbox = {
  console,
  PA_PRODUCTS: PRODUCTS,
  PA_CAT_TREE: [],
  PA_PAGE: 1,
  document: { getElementById: (id) => els[id] || null },
  cuT: (en) => en,
  escapeHtml: (s) => String(s),
  escapeAttr: (s) => String(s),
  // Every product here is its own display unit; variant grouping is not under test.
  _paUnits: (rows) => rows,
  paRender: () => {},
};
vm.createContext(sandbox);
vm.runInContext(
  slice('function _paCatOf(', '// "Has designer sections?"')
  + '\nthis.__PA_NO_CAT = PA_NO_CAT;',
  sandbox, { filename: '09-products.js' });

const NONE = sandbox.__PA_NO_CAT;

console.log('\n1 · which products count as having no category');
const none = PRODUCTS.filter(p => sandbox._paCatMatch(p, NONE)).map(p => p.id);
is(none.join(','), '3,4,5', 'blank, whitespace-only and missing categories are all "none"');
is(sandbox._paCatMatch(PRODUCTS[1], NONE), false, 'a legacy kitchen category still counts as a category');
is(sandbox._paCatMatch(PRODUCTS[0], 'Drinks'), true, 'a named category still matches itself');
is(sandbox._paCatMatch(PRODUCTS[2], 'Drinks'), false, 'picking a named category never sweeps in uncategorised products');

console.log('\n2 · the chip row');
sandbox.paFillCatFilter();
const chips = els['pa-chips'].innerHTML;
yes(chips.includes(`paPickCat('${NONE}')`), 'a "No category yet" chip is rendered');
yes(/No category yet<span class="pa-chip-n">3<\/span>/.test(chips), 'it shows the count of uncategorised products (3)', chips);
yes(chips.lastIndexOf('paPickCat(') === chips.indexOf(`paPickCat('${NONE}')`), 'it sits last, after every real category');
yes(els['pa-filter'].options.some(o => o.value === NONE), 'the hidden category select carries the option, so the pick sticks');

console.log('\n3 · picking it');
sandbox.paPickCat(NONE);
is(els['pa-filter'].value, NONE, 'the filter holds the "none" value');
yes(/class="pa-chip is-on" onclick="paPickCat\('__none__'\)"/.test(els['pa-chips'].innerHTML), 'its chip is the one shown as on');
is(els['pa-subfilter'].style.display, 'none', 'no subcategory picker — there is nothing to narrow');

console.log('\n4 · still there at zero');
sandbox.PA_PRODUCTS = PRODUCTS.slice(0, 2);
els['pa-filter'].value = 'all';
sandbox.paFillCatFilter();
yes(/No category yet<span class="pa-chip-n">0<\/span>/.test(els['pa-chips'].innerHTML),
  'shows 0 when everything is filed — a zero is the answer, not a missing control');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
