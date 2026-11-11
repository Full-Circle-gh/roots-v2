#!/usr/bin/env node
/**
 * Checkout quote must price points against the same base as /orders — after the
 * voucher, not before. A coupon plus points used to show the pre-coupon points
 * figure at the till while the ledger charged the post-coupon one.
 *
 *   node scripts/test_checkout_quote_voucher_points.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { pointsRedeemableBase, pointsRedeemCredit } = require(path.join(ROOT, 'lib', 'loyalty'));
const { resolveCheckoutVoucher } = require(path.join(ROOT, 'lib', 'vouchers'));

let pass = 0;
let fail = 0;
function it(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}

console.log('\n1 · Points credit follows voucher on the redeemable base');
it('855 pts cover ¥854.90 after a 15% coupon on ¥1004 + packing', () => {
  const subtotal = 1004;
  const packing = 1.5;
  const voucherDiscount = 150.6;
  const base = pointsRedeemableBase(subtotal, 0, packing, voucherDiscount, 0);
  assert.strictEqual(base, 854.9);
  const { pointsUsed, pointsAmount } = pointsRedeemCredit(999999, 3264, base);
  assert.strictEqual(pointsUsed, 855);
  assert.strictEqual(pointsAmount, 854.9);
});

console.log('\n2 · Quote route applies vouchers before pointsRedeemableBase');
const retailSrc = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const quoteAt = retailSrc.indexOf("router.post('/api/retail/checkout/quote'");
const quoteEnd = retailSrc.indexOf("router.get('/api/retail/topup-packages'", quoteAt);
const quoteBlock = retailSrc.slice(quoteAt, quoteEnd);
it('resolveCheckoutVoucher runs inside checkout/quote', () => {
  assert.ok(/resolveCheckoutVoucher\(/.test(quoteBlock));
});
it('pointsRedeemableBase in quote passes voucher discount', () => {
  assert.ok(/pointsRedeemableBase\([^)]*quoteVoucherDiscount/.test(quoteBlock));
});
it('quote does not still claim vouchers are absent', () => {
  assert.ok(!/Quote doesn't apply\s+vouchers/.test(quoteBlock));
});

console.log('\n3 · resolveCheckoutVoucher is exported');
it('lib/vouchers exports the helper', () => {
  assert.strictEqual(typeof resolveCheckoutVoucher, 'function');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
