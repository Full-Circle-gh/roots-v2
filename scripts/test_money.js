#!/usr/bin/env node
/**
 * test_money.js — money, exactly (audit A-06, Stage 1).
 *
 *   node scripts/test_money.js
 *
 * lib/money.js is Stage 1 of docs/tacet-money-migration-plan.md: one module, no
 * schema change, no behaviour change. It exists so new arithmetic has somewhere
 * correct to happen and the storage migration has a vocabulary to move into.
 *
 * The properties below are the ones that cost real money when they fail, and
 * two of them caught real bugs in this module before it shipped:
 *
 *   - 1.005 must become 101 cents. `Math.round(1.005 * 100)` is 100, because
 *     1.005 * 100 is 100.49999999999999. That is the classic wrong penny.
 *   - splitMinor(-n) must mirror splitMinor(n) part for part. Working on the
 *     signed total puts the spare cent on the LAST part for a refund and the
 *     FIRST for a charge, so refunding a three-way split returns 33 to the
 *     tender that was charged 34.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/money');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nAmounts — the wrong penny');

it('1.005 is 101 cents, not 100', () => {
  assert.strictEqual(M.toMinor(1.005), 101);
  // The naive version, kept as the contrast:
  assert.strictEqual(Math.round(1.005 * 100), 100);
});

it('the everyday values are exact', () => {
  for (const [maj, min] of [[0, 0], [0.01, 1], [12.34, 1234], [45.99, 4599], [3467, 346700]]) {
    assert.strictEqual(M.toMinor(maj), min, String(maj));
  }
});

it('float arithmetic on the way in does not leak through', () => {
  assert.strictEqual(M.toMinor(0.1 + 0.2), 30);          // 0.30000000000000004
  assert.strictEqual(M.toMinor(1.1 * 3), 330);           // 3.3000000000000003
});

it('rounds half AWAY from zero, so a charge and its refund cancel', () => {
  // Math.round(-0.5) is -0 and Math.round(0.5) is 1 — asymmetric, so a pair
  // that should cancel does not.
  assert.strictEqual(M.toMinor(-1.005), -101);
  assert.strictEqual(M.sumMinor([M.toMinor(1.005), M.toMinor(-1.005)]), 0);
  assert.strictEqual(M.toMinor(0.005), 1);
  assert.strictEqual(M.toMinor(-0.005), -1);
});

it('a string amount is read, a non-amount is null, and zero is an amount', () => {
  assert.strictEqual(M.toMinor('12.34'), 1234);
  assert.strictEqual(M.toMinor(' 12.34 '), 1234);
  assert.strictEqual(M.toMinor(0), 0);            // not null
  for (const junk of [null, undefined, '', 'free', NaN, Infinity, {}]) {
    assert.strictEqual(M.toMinor(junk), null, String(junk));
  }
});

it('an amount too large to hold exactly THROWS rather than silently drifting', () => {
  assert.throws(() => M.toMinor(1e15), RangeError);
});

it('round-trips back for display', () => {
  assert.strictEqual(M.fromMinor(4599), 45.99);
  assert.strictEqual(M.fromMinor(0), 0);
  assert.strictEqual(M.fromMinor('x'), null);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nRates — where integer cents would destroy the data');

it('a per-gram cost keeps its precision', () => {
  // ingredients.cost_per_unit is 60% sub-cent in production because it is a
  // rate, not an amount. In cents 0.042 is 4.2, and rounding to 4 moves the
  // cost basis of every recipe by 5%.
  assert.strictEqual(M.toMicro(0.042), 420);
  assert.strictEqual(M.fromMicro(420), 0.042);
  assert.strictEqual(M.toMicro(0.9961857), 9962);       // four places, rounded once
});

it('rate × quantity rounds ONCE, at the end', () => {
  // 0.042/g × 350g = 14.70 exactly. Rounding the rate to cents first gives
  // 0.04 × 350 = 14.00 — a 5% error on every line.
  assert.strictEqual(M.extendMicro(M.toMicro(0.042), 350), 1470);
  assert.notStrictEqual(Math.round(0.04 * 350 * 100), 1470);
});

it('a fractional quantity is fine — weighed goods are sold that way', () => {
  assert.strictEqual(M.extendMicro(M.toMicro(12.5), 0.35), 438);   // 4.375 → 4.38
});

it('extendMicro refuses a non-integer rate rather than guessing', () => {
  assert.throws(() => M.extendMicro(0.042, 350), TypeError);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nSplitting — where the fractions actually come from');

it('an equal three-way split loses nothing', () => {
  assert.deepStrictEqual(M.splitMinor(100, [1, 1, 1]), [34, 33, 33]);
  assert.strictEqual(M.sumMinor(M.splitMinor(100, [1, 1, 1])), 100);
});

it('it is deterministic — the same order reconciles the same way twice', () => {
  const a = M.splitMinor(100, [1, 1, 1]);
  const b = M.splitMinor(100, [1, 1, 1]);
  assert.deepStrictEqual(a, b);
});

it('A REFUND MIRRORS THE CHARGE, part for part', () => {
  // The bug this caught: working on the signed total puts the spare cent on the
  // LAST part for a negative and the FIRST for a positive, so refunding a
  // three-way split returns 33 to the tender that was charged 34.
  assert.deepStrictEqual(M.splitMinor(-100, [1, 1, 1]), [-34, -33, -33]);
  const charge = M.splitMinor(4599, [3, 1, 1]);
  const refund = M.splitMinor(-4599, [3, 1, 1]);
  assert.deepStrictEqual(refund, charge.map((v) => -v));
});

it('the sum and the mirror hold across a wide sweep', () => {
  // Properties, not examples. Any total, any weighting.
  const WEIGHTS = [[1, 1, 1], [3, 1], [1, 2, 3, 4], [5], [7, 7, 7, 7, 7, 7, 7], [1, 0, 2]];
  for (let t = -999; t <= 999; t++) {
    for (const w of WEIGHTS) {
      const p = M.splitMinor(t, w);
      assert.strictEqual(M.sumMinor(p), t, `sum: ${t} over ${w}`);
      // `|| 0` on both sides: -(0) is -0, which deepStrictEqual separates from 0
      // and which is not a distinction money has.
      assert.deepStrictEqual(M.splitMinor(-t, w).map((v) => v || 0),
        p.map((v) => -v || 0), `mirror: ${t} over ${w}`);
      assert.strictEqual(p.length, w.length, `arity: ${t} over ${w}`);
    }
  }
});

it('a zero weight gets zero, and the rest still sums', () => {
  const p = M.splitMinor(100, [1, 0, 1]);
  assert.strictEqual(p[1], 0);
  assert.strictEqual(M.sumMinor(p), 100);
});

it('weights that are all zero do not LOSE the money', () => {
  // Losing it is never the right answer to an ambiguous split.
  assert.strictEqual(M.sumMinor(M.splitMinor(777, [0, 0, 0])), 777);
  assert.strictEqual(M.sumMinor(M.splitMinor(-777, [0, 0])), -777);
});

it('no parts at all is an empty split, not a throw', () => {
  assert.deepStrictEqual(M.splitMinor(100, []), []);
});

it('a non-integer total is refused — this takes minor units', () => {
  assert.throws(() => M.splitMinor(1.5, [1, 1]), TypeError);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nsumMinor refuses what it cannot add exactly');

it('skips nulls, refuses floats', () => {
  assert.strictEqual(M.sumMinor([100, null, 200, undefined]), 300);
  assert.throws(() => M.sumMinor([1.5]), TypeError);
  assert.strictEqual(M.sumMinor([]), 0);
  assert.strictEqual(M.sumMinor(null), 0);
});

it('a thousand cents added one at a time is exactly a thousand', () => {
  // The property the REAL columns do not have: 0.01 added 1000 times as a float
  // is 9.999999999999831, not 10.
  const ones = new Array(1000).fill(1);
  assert.strictEqual(M.sumMinor(ones), 1000);
  let f = 0; for (let i = 0; i < 1000; i++) f += 0.01;
  assert.notStrictEqual(f, 10);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe module stays what it says it is');

it('it touches no database and no network', () => {
  // CODE only. The header explains at length that this module touches no
  // database, and a check over raw source fails on the sentence saying so —
  // which is the same mistake as counting a comment as a declaration.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  assert.ok(!/\brequire\s*\(/.test(src), 'money.js must not require anything');
  for (const forbidden of ['tdb(', 'fetch(', 'db.prepare']) {
    assert.ok(!src.includes(forbidden), `money.js must not call ${forbidden}`);
  }
});

it('it converts no column — Stage 1 changes no behaviour', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  assert.ok(!/ALTER TABLE|UPDATE |INSERT /i.test(src), 'Stage 1 writes nothing');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
