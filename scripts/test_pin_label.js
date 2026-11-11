#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { addressFindable } = require('../lib/qingyun-payload');
const {
  resolvePinLabel,
  pinAdviceAgrees,
  sharedHanCore,
  findableVariants,
} = require('../lib/pin-label');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, e) { fail++; console.log('  ✗ ' + m + '\n      ' + (e && e.message || e)); }
function it(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }

const POLY_ADDR = {
  province: '广东省', city: '广州市', district: '海珠区',
  address: '宸悦路保利天悦三期 Mo公寓', detail: '3栋2402',
};
const MISLEADING_FORMATTED = '广东省广州市海珠区琶洲街道广州会展中心礼宾府公寓琶洲岛';

it('neighbour formatted_address does not block when a nearby POI matches the order', () => {
  const out = resolvePinLabel({
    addr: POLY_ADDR,
    formatted: MISLEADING_FORMATTED,
    nearbyPois: [{ name: '保利天悦MO公寓', distance: 15 }],
    regeoPois: [{ name: '3栋', distance: 8 }],
  });
  assert.strictEqual(out.agrees, true);
  assert.ok(/保利天悦/.test(out.pinLabel));
  assert.ok(!/礼宾府/.test(out.pinLabel));
});

it('relaxed match shares a 4-character estate core across phase wording', () => {
  const f = addressFindable(POLY_ADDR);
  assert.strictEqual(pinAdviceAgrees(f, '保利天悦MO公寓'), true);
  assert.strictEqual(pinAdviceAgrees(f, MISLEADING_FORMATTED), false);
});

it('strips a leading road name for variant matching', () => {
  const v = findableVariants('宸悦路保利天悦三期 Mo公寓');
  assert.ok(v.includes('保利天悦三期 Mo公寓'));
});

it('sharedHanCore needs four Han characters, not two', () => {
  assert.strictEqual(sharedHanCore('祈福新村倚湖湾', '祈福医院'), '');
  assert.ok(sharedHanCore('保利天悦三期', '保利天悦MO公寓'));
});

it('with no agreeing POI the misleading formatted label is still shown last', () => {
  const out = resolvePinLabel({
    addr: POLY_ADDR,
    formatted: MISLEADING_FORMATTED,
    nearbyPois: [{ name: '广州会展中心礼宾府公寓', distance: 20 }],
    regeoPois: [],
  });
  assert.strictEqual(out.agrees, false);
  assert.strictEqual(out.pinLabel, '广州会展中心礼宾府公寓');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
