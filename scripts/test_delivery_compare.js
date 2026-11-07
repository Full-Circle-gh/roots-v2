#!/usr/bin/env node
// What a Guangzhou order shows beside the delivery fee.
//   node scripts/test_delivery_compare.js
'use strict';

const assert = require('assert');
const { deliveryCompare } = require('../lib/delivery-compare');

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};

it('customer paid less: we covered the gap', () => {
  const r = deliveryCompare(15, 28);
  assert.strictEqual(r.customer, 15);
  assert.strictEqual(r.we, 28);
  assert.strictEqual(r.gap, 13);
});
it('free delivery still shows what the rider cost', () => {
  const r = deliveryCompare(0, 22);
  assert.strictEqual(r.customer, 0);
  assert.strictEqual(r.gap, 22);
});
it('customer paid more', () => {
  assert.strictEqual(deliveryCompare(35, 22).gap, -13);
});
it('the same amount', () => {
  assert.strictEqual(deliveryCompare(22, 22).gap, 0);
});
it('no rider yet leaves our side blank', () => {
  const r = deliveryCompare(15, null);
  assert.strictEqual(r.we, null);
  assert.strictEqual(r.gap, null);
});
it('a missing fee is not zero', () => {
  assert.strictEqual(deliveryCompare(15, '').we, null);
});

console.log(fail ? `\n${fail} failed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
