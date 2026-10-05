#!/usr/bin/env node
/**
 * Every product on a receipt carries its SKU — including the ones chosen as an
 * answer (§434).
 *
 *   node scripts/test_receipt_option_sku.js
 *
 * Ash, 2026-10-05, holding receipt TC000939: "need sku on receipt always", then
 * "recipe has to have sku for each product". The line "Small Bites Selection"
 * printed its SKU; the three bites chosen under it (Mango Bites, Chocolate
 * Bites, Snackers) are products of their own, pulled off the shelf, and printed
 * as names only.
 *
 * What this locks down:
 *   - attachOptionSkus reads each linked answer's SKU from the product it is
 *     linked to (the order snapshot keeps the link, not the code)
 *   - the receipt prints that SKU under the answer, enlarged; with a count when
 *     the line is for more than one
 *   - the packing slip prints it with the count to pull
 *   - an answer with no link (a sugar level) prints no SKU line
 *
 * Real sqlite database for the lookup; lib/feie.js renders the slips.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { attachOptionSkus } = require(path.join(ROOT, 'routes', 'retail.js'));
const feie = require(path.join(ROOT, 'lib', 'feie.js'));
const db = tdb();

const A_MANGO = 9681, A_CHOC = 9682;
const IDS = [A_MANGO, A_CHOC];
function cleanup() {
  db.prepare(`DELETE FROM store_products WHERE id IN (${IDS.map(() => '?').join(',')})`).run(...IDS);
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

cleanup();
const prod = db.prepare(
  `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
   VALUES (?,?,?,?,?,1,0)`
);
prod.run(A_MANGO, 'Mango Protein Bites', '芒果蛋白球', '__RS-105', 8);
prod.run(A_CHOC,  'Choco Hemp Bites',    '巧克力火麻蛋白球', '__RS-106', 8);

// The order line's options_json, in the shape lib/product-options.js
// resolveAnswers snapshots: the link, not the code.
const opt = (label, label_cn, stock_product_id) => ({
  option_id: 1, choice_id: 1, question_en: 'Choose Your Bites', question_cn: '',
  label, label_cn, delta: 8, stock_product_id,
});
const line = (qty) => ({
  product_id: 1, name_en: 'Small Bites Selection', name_cn: '', sku: 'SB-1',
  qty, unit_price: 25.5, line_total: 25.5 * qty,
  options_json: JSON.stringify([
    opt('Mango Bites', '芒果蛋白球', A_MANGO),
    opt('Chocolate Bites', '巧克力火麻蛋白球', A_CHOC),
    opt('No sugar', '无糖', null),
  ]),
});
const order = { order_no: 'TC000939', total: 25.5, subtotal: 25.5, paid_at: '2026-10-05 12:42:00' };

const one = [line(1)];
attachOptionSkus(one);
const two = [line(2)];
attachOptionSkus(two);

console.log('\n── The lookup');
check('each linked answer gets its product\'s SKU; the unlinked one gets none', () => {
  const v = JSON.parse(one[0].options_json);
  assert.strictEqual(v[0].sku, '__RS-105');
  assert.strictEqual(v[1].sku, '__RS-106');
  assert.strictEqual(v[2].sku, undefined);
});
check('a line with no options is left alone', () => {
  const rows = [{ qty: 1, sku: 'X' }];
  attachOptionSkus(rows);
  assert.strictEqual(rows[0].options_json, undefined);
});

console.log('\n── The receipt');
const receipt = feie.renderOrder('receipt', order, one, 'Roots', []);
const receipt2 = feie.renderOrder('receipt', order, two, 'Roots', []);
check('the line\'s own SKU still prints', () => {
  assert.ok(receipt.includes('<B>SKU SB-1</B>'), receipt);
});
check('each chosen product prints its SKU, enlarged, right under its answer', () => {
  const lines = receipt.split('\n');
  const iM = lines.findIndex(l => l.includes('Mango Bites'));
  const iC = lines.findIndex(l => l.includes('Chocolate Bites'));
  assert.strictEqual(lines[iM + 1], '<B>SKU __RS-105</B>', `after mango: ${lines[iM + 1]}`);
  assert.strictEqual(lines[iC + 1], '<B>SKU __RS-106</B>', `after choc: ${lines[iC + 1]}`);
});
check('an answer that is not a product prints no SKU line', () => {
  const lines = receipt.split('\n');
  const i = lines.findIndex(l => l.includes('No sugar'));
  assert.ok(!/SKU/.test(lines[i + 1] || ''), `after no sugar: ${lines[i + 1]}`);
});
check('a line for two prints the count with each chosen product\'s SKU', () => {
  assert.ok(receipt2.includes('<B>x2  SKU __RS-105</B>'), receipt2);
});

console.log('\n── The packing slip');
const packing = feie.renderOrder('packing', order, two, 'Roots', []);
check('each chosen product prints its count and SKU under its answer', () => {
  const lines = packing.split('\n');
  const iM = lines.findIndex(l => l.includes('Mango Bites'));
  assert.strictEqual(lines[iM + 1], '<B>x2  SKU __RS-105</B>', `after mango: ${lines[iM + 1]}`);
  assert.ok(packing.includes('<B>x2  SKU __RS-106</B>'));
});

console.log('\n── The add-on slip');
check('an add-on slip prints them too', () => {
  const s = feie.renderAddon(order, one, 'Roots');
  assert.ok(s.includes('<B>SKU __RS-105</B>'), s);
});

cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
