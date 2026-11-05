#!/usr/bin/env node
/**
 * Same-city compare-courier card hoists to the drawer top when:
 *   • a rider is live (existing), or
 *   • the order has moved to preparing (staff pressed Start preparing).
 *
 *   node scripts/test_courier_card_hoist.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ORDERS_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js'), 'utf8');

function slice(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

const HOIST_FN = slice(ORDERS_JS, 'function courierCardHoisted(o, s)');

function hoist(order, shipment) {
  const ctx = { courierCardHoisted: null };
  vm.runInNewContext(HOIST_FN + '\ncourierCardHoisted = courierCardHoisted;', ctx);
  return ctx.courierCardHoisted(order, shipment);
}

const localParcel = { id: 10, mode: 'local', state: 'pending' };
const orderBase = {
  status: 'paid',
  shipments: [localParcel],
  courier: null,
};

it('paid with no rider stays inline (not hoisted)', () => {
  assert.strictEqual(hoist(orderBase, localParcel), false);
});

it('preparing with no rider hoists the first local parcel', () => {
  assert.strictEqual(hoist({ ...orderBase, status: 'preparing' }, localParcel), true);
});

it('preparing hoists only the first same-city parcel on a split order', () => {
  const firstLocal = { id: 10, mode: 'local', state: 'pending' };
  const secondLocal = { id: 12, mode: 'local', state: 'pending' };
  const o = { status: 'preparing', shipments: [firstLocal, secondLocal], courier: null };
  assert.strictEqual(hoist(o, firstLocal), true);
  assert.strictEqual(hoist(o, secondLocal), false);
});

it('live rider still hoists while paid', () => {
  const o = { ...orderBase, courier: { stage: 'heading_to_pickup' } };
  assert.strictEqual(hoist(o, localParcel), true);
});

it('dispatched parcel never hoists via this helper', () => {
  const gone = { ...localParcel, state: 'dispatched' };
  const o = { status: 'preparing', shipments: [gone], courier: null };
  assert.strictEqual(hoist(o, gone), false);
});

it('transition to preparing scrolls the drawer back to the top', () => {
  assert.match(ORDERS_JS, /openOrder\(id, \{ instant: true, \.\.\.\(status === 'preparing' \? \{ scrollTop: 0 \} : \{\}\) \}\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
