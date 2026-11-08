#!/usr/bin/env node
/**
 * test_option_ask.js — the required-option refusal names the answers.
 *
 *   node scripts/test_option_ask.js
 *
 * "Please choose: Shots" names the heading. House Blend and SOE are the
 * choice. This is the rule in lib/option-ask.js, and the same function text
 * on every sheet that has the answers in front of it. The QR menu does not
 * keep a second copy: it pastes askWhat.toString() into the page.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { askWhat } = require('../lib/option-ask');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const shots = [
  { en: 'House Blend', cn: '拼配' },
  { en: 'SOE', cn: '单一产地' },
];

check('two answers are named, in both languages', () => {
  const n = askWhat(shots, 'Shots', '浓缩');
  assert.strictEqual(n.en, 'House Blend or SOE');
  assert.strictEqual(n.cn, '拼配或单一产地');
});

check('a sold-out answer is not named', () => {
  const n = askWhat([
    { en: 'House Blend', cn: '拼配' },
    { en: 'SOE', cn: '单一产地', out: 1 },
  ], 'Shots', '浓缩');
  assert.strictEqual(n.en, 'House Blend');
  assert.strictEqual(n.cn, '拼配');
});

check('three or four take a list, with or before the last', () => {
  const n = askWhat([
    { en: 'Full sugar', cn: '全糖' },
    { en: 'Half sugar', cn: '半糖' },
    { en: 'No sugar', cn: '无糖' },
  ], 'Sugar level', '糖度');
  assert.strictEqual(n.en, 'Full sugar, Half sugar or No sugar');
  assert.strictEqual(n.cn, '全糖、半糖或无糖');
});

check('yes / no stays the question', () => {
  const n = askWhat([
    { en: 'Yes', cn: '是' },
    { en: 'No', cn: '否' },
  ], 'Heat up?', '加热吗?');
  assert.strictEqual(n.en, 'Heat up?');
  assert.strictEqual(n.cn, '加热吗?');
});

check('YES / No is still a yes/no pair', () => {
  const n = askWhat([
    { en: 'YES', cn: '是' },
    { en: 'No', cn: '否' },
  ], 'Heat up?', '加热吗?');
  assert.strictEqual(n.en, 'Heat up?');
  assert.strictEqual(n.cn, '加热吗?');
});

check('five answers stay the question', () => {
  const choices = [1, 2, 3, 4, 5].map(i => ({ en: 'Side ' + i, cn: '配菜' + i }));
  const n = askWhat(choices, 'Sides', '配菜');
  assert.strictEqual(n.en, 'Sides');
  assert.strictEqual(n.cn, '配菜');
});

check('every answer sold out falls back to the question', () => {
  const n = askWhat([{ en: 'House Blend', cn: '拼配', out: 1 }], 'Shots', '浓缩');
  assert.strictEqual(n.en, 'Shots');
  assert.strictEqual(n.cn, '浓缩');
});

check('the pasted source is the same function', () => {
  const fn = new Function(askWhat.toString() + '\nreturn askWhat;')();
  const n = fn(shots, 'Shots', '浓缩');
  assert.strictEqual(n.en, 'House Blend or SOE');
  assert.strictEqual(n.cn, '拼配或单一产地');
});

const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'option-ask.js'), 'utf8');
const fnStart = libSrc.indexOf('function askWhat(choices, qEn, qCn)');
const fnEnd = libSrc.indexOf('\nmodule.exports');
const fnText = libSrc.slice(fnStart, fnEnd).trim();

const COPIES = [
  'public/shop.html',
  'public/till.html',
  'public/m.html',
  'public/retail-admin/04-orders.js',
  'miniapp/utils/options.js',
];

check('every sheet that has the answers carries the same function', () => {
  for (const rel of COPIES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes(fnText), rel + ' has drifted from lib/option-ask.js');
  }
});

check('the QR menu pastes that function instead of keeping a second copy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'shop-menu.js'), 'utf8');
  assert.ok(src.includes('askWhat=${optionAsk.askWhat.toString()}'),
    'the QR menu is not pasting askWhat');
  assert.ok(src.includes('askWhat(miss.choices,miss.q_en,miss.q_cn)'),
    'the refusal is not asking askWhat');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
