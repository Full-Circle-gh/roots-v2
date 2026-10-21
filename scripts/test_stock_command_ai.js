#!/usr/bin/env node
/**
 * Saying a stock change (§493) — what the model's answer is allowed to say.
 *
 *   node scripts/test_stock_command_ai.js
 *
 * lib/stock-command-ai.js asks the model to read a sentence through one
 * forced tool and then keeps only what exists. This file locks the keeping:
 * an id the catalogue does not hold is dropped, a store the operator does not
 * hold is dropped, a bad action or a negative quantity is dropped, one
 * candidate alone becomes the product, and the prompt carries the catalogue,
 * the stores, the bare-number meaning and the person's own mishearings.
 * No model is called.
 */
'use strict';

const ai = require('../lib/stock-command-ai');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

const products = [
  { id: 10, sku: '1-50', name_en: 'Hummus classic', name_cn: '鹰嘴豆泥' },
  { id: 11, sku: '1-51', name_en: 'Hummus spicy', name_cn: '辣味鹰嘴豆泥' },
  { id: 12, sku: 'PB-01', name_en: 'Pita bread', name_cn: '皮塔饼' },
];
const stores = [{ id: 1, code: 'TH', name_en: 'Tianhe', name_cn: '天河' }, { id: 2, code: 'YX', name_en: 'Yuexiu', name_cn: '越秀' }];

console.log('\nKeeping only what exists');
{
  let a = ai.coerceAnswer({ product_id: 10, candidate_ids: [], store_id: 2, action: 'set', qty: 0, confidence: 0.9, reason: 'sold out' }, products, stores);
  eq(a.product_id, 10, 'a real product is kept');
  eq(a.store_id, 2, 'a real store is kept');
  eq(a.action, 'set', 'set is kept');
  eq(a.qty, 0, 'zero is a quantity');
  eq(a.confidence, 0.9, 'confidence is kept');
  a = ai.coerceAnswer({ product_id: 999, candidate_ids: [10, 999, 11, 11], store_id: 7, action: 'delete', qty: -3, confidence: 4 }, products, stores);
  eq(a.product_id, null, 'an unknown product is dropped');
  eq(a.candidates.join(','), '10,11', 'unknown and duplicate candidates are dropped, order kept');
  eq(a.store_id, null, 'an unknown store is dropped');
  eq(a.action, null, 'an unknown action is dropped');
  eq(a.qty, null, 'a negative quantity is dropped');
  eq(a.confidence, null, 'an out-of-range confidence is dropped');
  a = ai.coerceAnswer({ product_id: null, candidate_ids: [12], store_id: null, action: 'add', qty: '5' }, products, stores);
  eq(a.product_id, 12, 'one candidate alone is the product');
  eq(a.candidates.length, 0, 'and no longer a candidate');
  eq(a.qty, 5, 'a quantity sent as a digit string is read');
  a = ai.coerceAnswer({ product_id: 10, candidate_ids: [10, 11] }, products, stores);
  eq(a.candidates.join(','), '11', 'the chosen product is not also a candidate');
  a = ai.coerceAnswer(null, products, stores);
  eq(a.product_id, null, 'nothing in, nothing out');
  eq(a.candidates.length, 0, 'and no candidates');
  a = ai.coerceAnswer('{"product_id":10}', products, stores);
  eq(a.product_id, null, 'a string is not an answer');
}

console.log('\nWhat the model is told');
{
  const cat = ai.catalogueText(products);
  ok(cat.indexOf('10 | 1-50 | Hummus classic | 鹰嘴豆泥') > -1, 'the catalogue carries id, sku and both names');
  const dyn = ai.dynamicText({ stores, storeId: 2, defaultAction: 'add', heard: { homeless: 10, 哈姆斯: 10 } });
  ok(dyn.indexOf('2 | YX | Yuexiu | 越秀') > -1, 'the stores carry id, code and both names');
  ok(dyn.indexOf('screen now: 2') > -1, 'the store on screen is named');
  ok(dyn.indexOf('bare number means action "add"') > -1, 'a bare number means what the screen means');
  ok(dyn.indexOf('"homeless" -> 10') > -1 && dyn.indexOf('"哈姆斯" -> 10') > -1, 'the person\'s own mishearings are passed on');
  const none = ai.dynamicText({ stores, storeId: null, defaultAction: 'set', heard: {} });
  ok(none.indexOf('mishearings') === -1, 'and left out when there are none');
  ok(ai.STATIC_PROMPT.indexOf('售罄') > -1 && ai.STATIC_PROMPT.indexOf('sold out') > -1, 'sold out is explained in both languages');
  eq(ai.TOOL.name, 'read_stock_change', 'the tool is the one the route reads');
  ok(ai.TOOL.input_schema.required.indexOf('qty') > -1, 'and must answer the quantity');
  eq(typeof ai.available(), 'boolean', 'availability is a plain yes or no');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
