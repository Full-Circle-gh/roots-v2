#!/usr/bin/env node
/**
 * The number on a shop card's + is how many of that product are in the cart.
 *
 *   node scripts/test_shop_plus_qty.js
 *
 * WHY. Tapping + on the mini app shop flew the item to the cart and left the
 * card exactly as it was, so a shopper scrolling back could not tell what they
 * had already picked. Ash chose a number on the + and nothing else
 * (2026-10-06).
 *
 * WHAT IS RUN FOR REAL: utils/plus-qty, the counting. WHAT IS READ FROM
 * SOURCE: the shop page, which has no runtime here; each check names what it
 * holds.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const { plusQty, sameQty } = require(path.join(ROOT, 'miniapp', 'utils', 'plus-qty.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

console.log('plus-qty: counting');

check('empty cart → no badges', () => {
  assert.deepStrictEqual(plusQty([], {}), {});
  assert.deepStrictEqual(plusQty(undefined, undefined), {});
});

check('one line → its quantity, as text', () => {
  assert.deepStrictEqual(plusQty([{ product_id: 7, qty: 2 }], {}), { 7: '2' });
});

check('same product, different choices → summed on one card', () => {
  const items = [
    { product_id: 7, qty: 1, options: [{ choice_id: 3 }] },
    { product_id: 7, qty: 2, options: [{ choice_id: 4 }] },
  ];
  assert.deepStrictEqual(plusQty(items, {}), { 7: '3' });
});

check('sizes of a variant card count on the card, not on themselves', () => {
  const items = [{ product_id: 11, qty: 1 }, { product_id: 12, qty: 2 }, { product_id: 30, qty: 1 }];
  const repOf = { 10: 10, 11: 10, 12: 10 };
  assert.deepStrictEqual(plusQty(items, repOf), { 10: '3', 30: '1' });
});

check('past 99 reads 99+', () => {
  assert.deepStrictEqual(plusQty([{ product_id: 1, qty: 120 }], {}), { 1: '99+' });
});

check('zero, negative and id-less lines are ignored', () => {
  const items = [{ product_id: 1, qty: 0 }, { product_id: 2, qty: -1 }, { qty: 3 }, null];
  assert.deepStrictEqual(plusQty(items, {}), {});
});

check('string ids from storage match numeric card ids', () => {
  assert.deepStrictEqual(plusQty([{ product_id: '5', qty: 1 }], { 5: 4 }), { 4: '1' });
});

check('sameQty spots any change', () => {
  assert.ok(sameQty({}, {}));
  assert.ok(sameQty({ 1: '2' }, { 1: '2' }));
  assert.ok(!sameQty({ 1: '2' }, { 1: '3' }));
  assert.ok(!sameQty({ 1: '2' }, {}));
  assert.ok(!sameQty({}, { 1: '2' }));
});

console.log('shop page: source');

const js   = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'shop', 'shop.js'), 'utf8');
const wxml = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'shop', 'shop.wxml'), 'utf8');
const wxss = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'shop', 'shop.wxss'), 'utf8');

check('every + chip (list, grid, gallery) carries the number', () => {
  const chips = wxml.match(/class="(row|card|gal)-plus"[\s\S]*?<\/view>/g) || [];
  assert.strictEqual(chips.length, 3, 'expected the three + chips');
  for (const c of chips) assert.ok(/plusQty\[item\.id\]/.test(c), 'no number on: ' + c.slice(0, 40));
});

check('the page follows the cart from any screen, and lets go on unload', () => {
  assert.ok(/cart\.subscribe\(\s*\(\)\s*=>\s*this\._syncPlusQty\(\)\s*\)/.test(js));
  assert.ok(/onUnload\(\)\s*\{[\s\S]*?this\._unsubCart\(\)/.test(js));
});

check('a variant card maps every size to itself', () => {
  assert.ok(/this\._repOf\[Number\(m\.id\)\]\s*=\s*p\.id/.test(js));
});

check('the dot sets its own font size (the chip is font-size:0)', () => {
  const rule = (wxss.match(/\.plus-qty\s*\{[^}]*\}/) || [''])[0];
  assert.ok(/font-size:\s*20rpx/.test(rule), rule);
  assert.ok(/position:\s*absolute/.test(rule), rule);
});

console.log(`\n${passed} passed`);
