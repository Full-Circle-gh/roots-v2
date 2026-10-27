#!/usr/bin/env node
/**
 * The till's payment methods all on screen, and the change on a cash sale — §500.
 *
 *   node scripts/test_till_cash_change.js
 *
 * Ash: "when selecting payment method i want to see all payment method without
 * clicking show more. also if i select cash i should be able to add how much
 * someone gave me and how much i need to give back".
 *
 * Held here:
 *   1. Every tender is drawn, with no "Other" fold, and the international card
 *      is last and set apart.
 *   2. The quick amounts are the exact bill and the next round figures.
 *   3. Change is what was handed over less the bill; a figure that does not
 *      cover the bill holds Mark paid; no figure at all does not.
 *   4. It is on screen only: nothing about the cash handed over is sent.
 *   5. The words: one copied pair, two composed and declared.
 *
 * The logic is lifted out of public/till.html and run here, so what is checked
 * is the code the till runs. Its drawing was checked by hand in Chromium.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const till = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

// A function from the till, by name, as source.
function lift(name) {
  const at = till.indexOf('  function ' + name + '(');
  assert.ok(at >= 0, name + ' is not in the till');
  const end = till.indexOf('\n  }\n', at);
  return till.slice(at, end + 4);
}

// The cash functions, run against a till state and a bill of our choosing.
function cashKit(state, due) {
  const src = ['cashGiven', 'cashShort', 'cashQuick'].map(lift).join('\n');
  return new Function('S', 'chargeDue', src + '\nreturn { cashGiven, cashShort, cashQuick };')(state, () => due);
}

console.log('\nEvery tender on screen');
check('the wallet list is drawn whole, with no fold and no "Other ›" button', () => {
  assert.match(till, /\(due > 0 \? WALLETS\.map\(walletBtn\)\.join\(''\) : ''\)/);
  assert.doesNotMatch(till, /data-more/);
  assert.doesNotMatch(till, /moreOpen/);
});
check('the international card is last and set apart', () => {
  const list = till.slice(till.indexOf('  var WALLETS = ['), till.indexOf('  ];', till.indexOf('  var WALLETS = [')));
  const vals = [...list.matchAll(/\{ v: '([a-z_]+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(vals, ['wechat_alipay_offline', 'cash', 'bank_transfer', 'other', 'intl_card']);
  assert.match(list, /v: 'intl_card',[^\n]*sep: true \}/);
  assert.match(till, /\.wal\.sep\{margin-top:16px\}/);
});

console.log('\nThe quick amounts');
check('¥73 offers 73, 80, 100 and 200', () => {
  assert.deepStrictEqual(cashKit({}, 73).cashQuick(73), [73, 80, 100, 200]);
});
check('¥164 offers 164, 170, 200 and 300', () => {
  assert.deepStrictEqual(cashKit({}, 164).cashQuick(164), [164, 170, 200, 300]);
});
check('a bill in fen still leads with itself, exactly', () => {
  assert.deepStrictEqual(cashKit({}, 27.5).cashQuick(27.5), [27.5, 30, 50, 100]);
});

console.log('\nChange, and a payment that does not cover the bill');
check('¥100 on ¥73 is not short', () => {
  const k = cashKit({ wallet: 'cash', cashIn: '100' }, 73);
  assert.strictEqual(k.cashGiven(), 100);
  assert.strictEqual(k.cashShort(), 0);
});
check('¥50 on ¥73 is ¥23 short', () => {
  assert.strictEqual(cashKit({ wallet: 'cash', cashIn: '50' }, 73).cashShort(), 23);
});
check('nothing typed is not short: exact cash needs no typing', () => {
  assert.strictEqual(cashKit({ wallet: 'cash', cashIn: '' }, 73).cashShort(), 0);
});
check('a figure left behind after switching away from cash holds nothing', () => {
  assert.strictEqual(cashKit({ wallet: 'wechat_alipay_offline', cashIn: '10' }, 73).cashShort(), 0);
});
check('a typed ¥ sign or space is ignored', () => {
  assert.strictEqual(cashKit({ wallet: 'cash', cashIn: '¥ 100.50' }, 73).cashGiven(), 100.5);
});
check('Mark paid is held while the cash is short', () => {
  assert.match(lift('canConfirm'), /&& !\(cashShort\(\) > 0\);/);
});
check('typing updates the screen in place, so the field keeps the keyboard', () => {
  const at = till.indexOf("$('settle').addEventListener('input'");
  assert.ok(at > 0);
  const body = till.slice(at, till.indexOf('});', at));
  assert.match(body, /e\.target\.id !== 'cash-in'/);
  assert.doesNotMatch(body, /render\(\)/);
});
check('the done screen names the change, for cash only', () => {
  assert.match(till, /w && w\.v === 'cash' && d\.cashIn != null && d\.cashIn >= cash/);
  assert.strictEqual((till.match(/cashIn: S\.wallet === 'cash' \? cashGiven\(\) : null/g) || []).length, 2,
    'both settle paths (a new sale and a recalled QR order) carry it to the done screen');
});

console.log('\nOn screen only');
check('nothing about the cash handed over reaches an order', () => {
  // The two payloads are the settle mode's, and they are unchanged.
  assert.match(till, /payload: function \(st\) \{ return \{ payment_method: st\.wallet \}; \}/);
  assert.match(till, /recallPayload: function \(st\) \{ return \{ status: 'paid', pay_method: st\.wallet \}; \}/);
  assert.doesNotMatch(till, /cash_in|cash_given|change_due/);
});

console.log('\nThe words');
check('one copied pair, two composed and declared', () => {
  assert.match(till, /cashGiven:\s+\['Amount received', '收到金额'\],\s+\/\/ admin: 04-orders\.js/);
  assert.match(till, /change:\s+\['Change', '找零'\],\s+\/\/ vocab: composed §500/);
  assert.match(till, /short:\s+\['Short', '还差'\]\s+\/\/ vocab: composed §500/);
  const admin = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
  assert.ok(admin.includes("cuT('Amount received', '收到金额')"), 'the copied pair is no longer live in the admin');
  const vocab = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
  assert.ok(vocab.includes('`找零`') && vocab.includes('`还差`'), 'a composed string is not declared');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
