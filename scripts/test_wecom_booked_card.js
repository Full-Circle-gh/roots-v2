#!/usr/bin/env node
/**
 * The WeCom new-order card says when a delivery is BOOKED FOR A LATER DAY.
 *
 *   node scripts/test_wecom_booked_card.js
 *
 * No network, no keys, no server, no database. bookedLaterDay and
 * buildWecomOrderCard are sliced out of routes/retail.js, and _gzDateStr out of
 * lib/inventory.js (requiring that module would load the database), then run
 * with the real lib/fulfilment isCounter.
 *
 * Before this, a delivery card carried no day at all, so an order booked for
 * Thursday read exactly like one that had to go out now.
 *
 * TO PROVE THE SUITE CAN FAIL:  WBC_MUTANT=1 node scripts/test_wecom_booked_card.js
 * The mutant lets an Express order through, whose scheduled_for is the
 * system's earliest day and not a day the customer chose. The suite must go RED.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isCounter } = require('../lib/fulfilment');

const MUTANT = process.env.WBC_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const RETAIL_SRC = read('routes/retail.js');
const INV_SRC = read('lib/inventory.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`${name} not found`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`${name} has no closing brace`);
}

let bookedSrc = extractFn('bookedLaterDay', RETAIL_SRC);
if (MUTANT) bookedSrc = bookedSrc.replace("if (kind && kind !== 'schedule') return null;", '');

const { bookedLaterDay, buildWecomOrderCard } = new Function('isCounter', `
  ${extractFn('_gzDateStr', INV_SRC)}
  const inventory = { gzDateStr: _gzDateStr };
  ${bookedSrc}
  ${extractFn('buildWecomOrderCard', RETAIL_SRC)}
  return { bookedLaterDay, buildWecomOrderCard };
`)(isCounter);

// Paid 2026-10-12 08:43 Guangzhou = 00:43 UTC, as SQLite CURRENT_TIMESTAMP stores it.
const PAID = '2026-10-12 00:43:00';
const base = {
  order_no: 'TC001090', total: 829.5, paid_at: PAID, fulfillment_type: 'delivery',
  recipient_name: 'miki', address_full: '广州市 黄埔区 水西路',
};

console.log('bookedLaterDay');

it('a checkout pick for a later day, with a window, gives the day and window', () => {
  const o = { ...base, delivery_slot_kind: 'schedule',
    scheduled_for: '2026-10-14T02:00:00.000Z', delivery_slot_label: '10:00–12:00' };
  assert.strictEqual(bookedLaterDay(o, PAID), '2026-10-14 10:00–12:00');
});

it('a day-only later pick gives the bare day', () => {
  const o = { ...base, delivery_slot_kind: 'schedule',
    scheduled_for: '2026-10-13T16:00:00.000Z', delivery_slot_label: '2026-10-14' };
  assert.strictEqual(bookedLaterDay(o, PAID), '2026-10-14');
});

it('an operator-moved later day (null kind, bare date) counts', () => {
  const o = { ...base, delivery_slot_kind: null,
    scheduled_for: '2026-10-15', delivery_slot_label: '2026-10-15' };
  assert.strictEqual(bookedLaterDay(o, PAID), '2026-10-15');
});

it('Express does not count — its day is the earliest, not the customer\'s choice', () => {
  const o = { ...base, delivery_slot_kind: 'express',
    scheduled_for: '2026-10-13T16:00:00.000Z', delivery_slot_label: '2026-10-14' };
  assert.strictEqual(bookedLaterDay(o, PAID), null);
});

it('same day, right away, restock and no date do not count', () => {
  for (const [kind, sf] of [['today', '2026-10-12T06:00:00.000Z'], ['right_away', null],
                            ['restock', '2026-10-20'], ['schedule', null]]) {
    assert.strictEqual(bookedLaterDay({ ...base, delivery_slot_kind: kind, scheduled_for: sf }, PAID), null, kind);
  }
});

it('a scheduled day equal to the paid day (GZ calendar) is not "later"', () => {
  // 2026-10-11 16:00 UTC is 2026-10-12 00:00 in Guangzhou — the paid day.
  const o = { ...base, delivery_slot_kind: 'schedule', scheduled_for: '2026-10-11T16:00:00.000Z' };
  assert.strictEqual(bookedLaterDay(o, PAID), null);
});

it('pickup and counter are left alone', () => {
  const later = { delivery_slot_kind: 'schedule', scheduled_for: '2026-10-20' };
  assert.strictEqual(bookedLaterDay({ ...base, ...later, fulfillment_type: 'pickup' }, PAID), null);
  assert.strictEqual(bookedLaterDay({ ...base, ...later, fulfillment_type: 'counter' }, PAID), null);
});

console.log('buildWecomOrderCard');

it('a booked order\'s card carries the Booked line in the live wording', () => {
  const card = buildWecomOrderCard({ ...base, booked_day: '2026-10-14 10:00–12:00' }, false);
  assert.ok(card.includes('> 顾客预约 Booked: <font color="warning">2026-10-14 10:00–12:00</font>'), card);
});

it('a deliver-now card is unchanged — no Booked line', () => {
  const card = buildWecomOrderCard({ ...base }, false);
  assert.ok(!/顾客预约|Booked/.test(card), card);
});

it('sendWecomOrderAlert reads the slot columns and sets booked_day before building', () => {
  const fn = extractFn('sendWecomOrderAlert', RETAIL_SRC);
  assert.ok(/o\.scheduled_for, o\.delivery_slot_kind/.test(fn), 'SELECT lacks the slot columns');
  const set = fn.indexOf('o.booked_day = bookedLaterDay(o, o.paid_at)');
  const build = fn.indexOf('buildWecomOrderCard(o,');
  assert.ok(set > 0 && build > set, 'booked_day must be set before the card is built');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
