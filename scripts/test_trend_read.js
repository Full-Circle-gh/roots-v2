#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { medianDays, daysBetween } = require('../lib/trend-read');

let failed = 0;
function it(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n    ' + e.message); }
}

console.log('\nmedian gap, and days between two dates');

it('an empty list is silence', () => assert.strictEqual(medianDays([]), null));
it('a same-day pair is not a gap', () => assert.strictEqual(medianDays([0, 0]), null));
it('the middle of an odd list', () => assert.strictEqual(medianDays([2, 9, 4]), 4));
it('the two middle gaps average, then round', () => assert.strictEqual(medianDays([2, 9]), 6));
it('days between two shop dates', () => assert.strictEqual(daysBetween('2026-11-01', '2026-11-08'), 7));
it('a missing date is silence', () => assert.strictEqual(daysBetween(null, '2026-11-08'), null));

console.log('\nthe dashboard read keeps the populations apart');

const ROUTE = fs.readFileSync(path.join(__dirname, '../routes/retail.js'), 'utf8');
const at = ROUTE.indexOf('[dashboard/trend-read]');
const block = ROUTE.slice(ROUTE.lastIndexOf('let returnEveryDays', at), at);

it('the block is there', () => assert.ok(at > 0 && block.length > 200));
it('shops and wholesale use the bar population', () => {
  assert.ok(block.includes('PAIDO_ALL'), 'places dropped wholesale');
});
it('people stay on the customer predicate', () => {
  assert.ok(/\$\{PAIDO\}/.test(block) && /customer_id IS NOT NULL/.test(block));
});
it('a stored zero is not a free recipe', () => {
  assert.ok(/cost > 0/.test(block));
});
it('a refund is the placed day, and not a wholesale mirror', () => {
  assert.ok(/o\.status = 'refunded'/.test(block));
  assert.ok(/NOTGZO/.test(block));
  assert.ok(/date\(o\.placed_at/.test(block));
});
it('a stockout is a ledger zero on a weekday the product sells', () => {
  assert.ok(/balance_after <= 0/.test(block) && /delta < 0/.test(block));
  assert.ok(/strftime\('%w'/.test(block));
});
it('the headline breakdown is a new object, and the old composition stays', () => {
  assert.ok(/money_of: moneyOf/.test(ROUTE));
  assert.ok(/aov_change:/.test(ROUTE));
  assert.ok(/composition,/.test(ROUTE));
});

if (failed) { console.error('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
