#!/usr/bin/env node
/**
 * Saying a stock change (§493) — the sentence parser behind Quick Stock's
 * microphone.
 *
 *   node scripts/test_quick_stock_command.js
 *
 * "1-50 out of stock at yuexiu" has to become: product 1-50, store Yuexiu,
 * set the count to 0 — and "150" (what a recogniser writes for "1-50") has to
 * become the same thing, with the 150 NOT read as a quantity. This file locks
 * that, and the rest of what the parser decides:
 *   • a sku wins over a name, glued ("1 - 50") or not, and is never the qty;
 *   • a name matches by its words, in English or Chinese, and two products
 *     that match equally are handed back as candidates rather than guessed;
 *   • "sold out" means set to 0 whatever else is said; add words add; set
 *     words set; a bare number means what the screen means by a number;
 *   • quantities come as digits, English words or Chinese numerals;
 *   • the store is read by its English name, Chinese name or code, and the
 *     screen's own store stands in when none is said.
 *
 * No browser: the real functions are SLICED OUT OF THE SHIPPED public/m.html
 * and run under Node, the technique scripts/test_ask_stock_typed_qty.js uses.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in m.html`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}
function sliceConst(name) {
  const start = SRC.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in m.html`);
  const end = SRC.indexOf('};', start);
  return SRC.slice(start, end + 2);
}

// A one-line const (the verb lists are regexes, so sliceConst's `};` is wrong for them).
function sliceLine(name) {
  const start = SRC.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in m.html`);
  return SRC.slice(start, SRC.indexOf(';\n', start) + 1);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  sliceConst('QS_CMD_WORDS'), sliceConst('QS_CMD_CN_DIGITS'),
  ...['QS_CMD_ZERO_EN', 'QS_CMD_ZERO_CN', 'QS_CMD_ADD_EN', 'QS_CMD_ADD_CN', 'QS_CMD_SET_EN', 'QS_CMD_SET_CN'].map(sliceLine),
  sliceFn('qsCmdKey'), sliceFn('qsCmdCn'), sliceFn('qsCmdNumber'), sliceFn('qsCmdResidue'),
  sliceFn('qsCmdMatchProduct'), sliceFn('qsCmdParse'),
].join('\n'), ctx);
const { qsCmdParse, qsCmdCn } = ctx;

const stores = [
  { id: 1, code: 'TH', name_en: 'Tianhe', name_cn: '天河' },
  { id: 2, code: 'YX', name_en: 'Yuexiu', name_cn: '越秀' },
];
const products = [
  { product_id: 10, sku: '1-50', name_en: 'Hummus classic', name_cn: '鹰嘴豆泥', physical_qty: 12 },
  { product_id: 11, sku: '1-51', name_en: 'Hummus spicy', name_cn: '辣味鹰嘴豆泥', physical_qty: 4 },
  { product_id: 12, sku: 'PB-01', name_en: 'Pita bread', name_cn: '皮塔饼', physical_qty: 30 },
  { product_id: 13, sku: 'PC-02', name_en: 'Pita chips', name_cn: '皮塔脆片', physical_qty: 9 },
  { product_id: 14, sku: '12', name_en: 'Bagel plain', name_cn: '原味贝果', physical_qty: 2 },
  { product_id: 15, sku: '', name_en: 'Tahini jar', name_cn: '芝麻酱', physical_qty: 5 },
  { product_id: 16, sku: 'SA-1', name_en: 'Salmon fillet', name_cn: '三文鱼', physical_qty: 6 },
  { product_id: 17, sku: 'CR-1', name_en: 'California roll', name_cn: '加州卷', physical_qty: 8 },
];
const parse = (text, opts) => qsCmdParse(text, products, stores, Object.assign({ storeId: 1, defaultAction: 'set' }, opts || {}));

console.log('\nThe sentence Ash gave');
{
  const r = parse('1-50 out of stock at yuexiu location');
  eq(r.product && r.product.sku, '1-50', 'the sku is the product');
  eq(r.store && r.store.id, 2, 'Yuexiu is the store');
  eq(r.storeSaid, true, 'and it was said, not assumed');
  eq(r.action, 'set', 'out of stock sets');
  eq(r.qty, 0, 'to zero');
}

console.log('\nWhat a recogniser actually writes');
{
  let r = parse('150 sold out at yue xiu');
  eq(r.product && r.product.sku, '1-50', '"150" is 1-50');
  eq(r.qty, 0, 'and 150 is not read as a quantity');
  eq(r.store && r.store.id, 2, '"yue xiu" is Yuexiu');
  r = parse('1 - 50 sold out');
  eq(r.product && r.product.sku, '1-50', '"1 - 50" glues back into the sku');
  eq(r.qty, 0, 'still sold out');
  r = parse('one fifty is gone');
  eq(r.product, null, '"one fifty" is not matched as a sku (words are not glued)');
}

console.log('\nNames, English and Chinese');
{
  let r = parse('pita bread 7 left');
  eq(r.product && r.product.sku, 'PB-01', 'two of two name words finds Pita bread');
  eq(r.action, 'set', '"left" sets');
  eq(r.qty, 7, 'to 7');
  r = parse('pita 7 left');
  eq(r.product, null, '"pita" alone is not decided');
  eq(r.candidates.map(p => p.sku).sort().join(','), 'PB-01,PC-02', 'both pitas are offered');
  r = parse('鹰嘴豆泥 剩 3');
  eq(r.product && r.product.sku, '1-50', 'a whole Chinese name matches');
  eq(r.qty, 3, 'and 剩 3 sets to 3');
  r = parse('辣味鹰嘴豆泥 售罄 越秀');
  eq(r.product && r.product.sku, '1-51', 'the longer Chinese name beats the shorter one it contains');
  eq(r.qty, 0, '售罄 is sold out');
  eq(r.store && r.store.id, 2, '越秀 is the store');
  r = parse('tahini sold out');
  eq(r.product && r.product.product_id, 15, 'a product with no sku still matches by name');
}

console.log('\nAdd, set, and a bare number');
{
  let r = parse('made 12 pita bread', { defaultAction: 'add' });
  eq(r.action, 'add', '"made" adds');
  eq(r.qty, 12, 'twelve');
  eq(r.product && r.product.sku, 'PB-01', 'pita bread');
  r = parse('add five bagel plain at tianhe');
  eq(r.action, 'add', '"add" adds');
  eq(r.qty, 5, '"five" is 5');
  eq(r.product && r.product.sku, '12', 'the bagel, whose sku is 12');
  eq(r.store && r.store.id, 1, 'Tianhe');
  r = parse('set 1-50 to 7');
  eq(r.action, 'set', '"set" sets');
  eq(r.qty, 7, 'to 7, not to 150');
  r = parse('hummus classic 6', { defaultAction: 'add' });
  eq(r.action, 'add', 'a bare number on the kitchen screen is an add');
  r = parse('hummus classic 6', { defaultAction: 'set' });
  eq(r.action, 'set', 'and a count on the clerk screen');
  eq(r.qty, 6, 'six either way');
  r = parse('贝果 加 二十五');
  eq(r.action, 'add', '加 adds');
  eq(r.qty, 25, '二十五 is 25');
  r = parse('bagel plain twenty five');
  eq(r.qty, 25, '"twenty five" is 25');
  r = parse('add 0 pita bread', { defaultAction: 'add' });
  eq(r.qty, null, 'adding nothing is no quantity');
  r = parse('pita bread');
  eq(r.qty, null, 'a product and no number is no quantity');
}

console.log('\nChinese said without spaces, and names that look like numbers or verbs');
{
  let r = parse('鹰嘴豆泥剩3个');
  eq(r.product && r.product.sku, '1-50', 'the name is found inside one unspaced word');
  eq(r.action, 'set', '剩 sets');
  eq(r.qty, 3, 'and 3个 is 3');
  r = parse('三文鱼卖完了');
  eq(r.product && r.product.sku, 'SA-1', '三文鱼 is the salmon');
  eq(r.qty, 0, '卖完了 is sold out, and the 三 in the name is not a quantity');
  r = parse('加州卷剩两个');
  eq(r.product && r.product.sku, 'CR-1', '加州卷 is the roll');
  eq(r.action, 'set', 'and the 加 in its name is not an add');
  eq(r.qty, 2, '两个 is 2');
  r = parse('三文鱼加五', { defaultAction: 'set' });
  eq(r.action, 'add', '加 after the name adds');
  eq(r.qty, 5, 'five');
  r = parse('1-50越秀售罄');
  eq(r.product && r.product.sku, '1-50', 'sku, store and verb run together still read');
  eq(r.store && r.store.id, 2, 'Yuexiu');
  eq(r.qty, 0, 'sold out');
}

console.log('\nWhat this person has said before (§493 rule 7)');
{
  let r = parse('homeless sold out');
  eq(r.product, null, 'a mishearing nobody has corrected matches nothing');
  eq(r.heard, 'homeless', 'and the residue is the mishearing, verbs and all taken out');
  const heard = { mine: { homeless: 10 }, others: { 哈姆斯: 12 } };
  r = parse('homeless sold out', { heard });
  eq(r.product && r.product.sku, '1-50', 'once learned, the phrase is the product');
  eq(r.how, 'heard', 'and the reading says it came from memory');
  eq(r.qty, 0, 'sold out still reads');
  r = parse('homeless 5 left at yuexiu', { heard });
  eq(r.product && r.product.sku, '1-50', 'the same phrase with a count and a store');
  eq(r.qty, 5, 'the count is 5');
  eq(r.store && r.store.id, 2, 'the store is Yuexiu');
  eq(r.heard, 'homeless', 'the residue is still just the phrase');
  r = parse('哈姆斯卖完了', { heard });
  eq(r.product && r.product.sku, 'PB-01', 'a colleague\'s learned phrase counts too');
  eq(r.qty, 0, '卖完了 is sold out');
  r = parse('1-50 sold out', { heard: { mine: { '150': 12 } } });
  eq(r.product && r.product.sku, '1-50', 'a sku said plainly is never overridden by memory');
  eq(r.how, 'skuDigits', 'and the reading says sku (a short all-digit one)');
  r = parse('三文鱼剩三');
  eq(r.heard, '三文鱼', 'the residue keeps a numeral inside a name and drops the one standing alone');
  r = parse('made twenty five pita bread at tianhe', { defaultAction: 'add' });
  eq(r.heard, 'pitabread', 'word numbers, verbs and the store leave the residue');
}

console.log('\nThe store');
{
  let r = parse('1-50 sold out');
  eq(r.store && r.store.id, 1, 'nothing said: the screen\'s store');
  eq(r.storeSaid, false, 'and the plan says it was not said');
  r = parse('1-50 sold out YX');
  eq(r.store && r.store.id, 2, 'the code works');
  r = parse('1-50 sold out 天河');
  eq(r.store && r.store.id, 1, 'the Chinese name works');
}

console.log('\nChinese numerals');
{
  eq(qsCmdCn('十'), 10, '十');
  eq(qsCmdCn('十二'), 12, '十二');
  eq(qsCmdCn('二十'), 20, '二十');
  eq(qsCmdCn('两'), 2, '两');
  eq(qsCmdCn('一五零'), 150, '一五零 read digit by digit');
  eq(qsCmdCn('百'), null, '百 is not read');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
