#!/usr/bin/env node
/**
 * The customer receipt prints each chosen option as its ANSWER only.
 *
 *   node scripts/test_receipt_answers_only.js
 *
 * Ash, 2026-10-14, holding receipt TC001171 (Iced Americano): the line
 * "加点配料? / Beans Type: Blend" should read "Blend" — "we don't need the
 * question itself on the receipt, only the answer".
 *
 * What this locks down:
 *   - the receipt prints the answer, bilingual as stored, with no question
 *   - the packing slip and the add-on slip KEEP the question: two same-SKU
 *     items differ only by their option, and the packer must know which
 *     question each answer belongs to
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const feie   = require(path.join(__dirname, '..', 'lib', 'feie.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const ans = (q_en, q_cn, label, label_cn) => ({
  option_id: 1, choice_id: 1, question_en: q_en, question_cn: q_cn, label, label_cn, delta: 0,
});
const items = [{
  product_id: 1, name_en: 'Americano', name_cn: '美式咖啡', sku: 'TS-116',
  qty: 1, unit_price: 20, line_total: 20,
  options_json: JSON.stringify([
    ans('Beans Type', '加点配料?', 'Blend', ''),
    ans('Hot or Iced?', '热饮还是冰饮?', 'Iced', '冰饮'),
    ans('Size', '杯型', 'Regular (360ml)', '中杯(360毫升)'),
  ]),
}];
const order = { order_no: 'TC001171', total: 20, subtotal: 20, paid_at: '2026-10-14 12:30:00' };

console.log('\n── The customer receipt');
const receipt = feie.renderOrder('receipt', order, items, 'Roots', []);
check('each answer prints, bilingual as stored', () => {
  assert.ok(receipt.includes('  Blend\n'), receipt);
  assert.ok(receipt.includes('  冰饮 / Iced\n'), receipt);
  assert.ok(receipt.includes('  中杯(360毫升) / Regular (360ml)\n'), receipt);
});
check('no question text prints', () => {
  for (const q of ['Beans Type', '加点配料', 'Hot or Iced', '热饮还是冰饮', '杯型']) {
    assert.ok(!receipt.includes(q), `"${q}" still on the receipt:\n${receipt}`);
  }
});

console.log('\n── Slips a packer reads keep the question');
const packing = feie.renderOrder('packing', order, items, 'Roots', []);
check('the packing slip still names the question', () => {
  assert.ok(packing.includes('Beans Type: Blend'), packing);
});
check('the add-on slip still names the question', () => {
  assert.ok(feie.renderAddon(order, items, 'Roots').includes('Beans Type: Blend'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
