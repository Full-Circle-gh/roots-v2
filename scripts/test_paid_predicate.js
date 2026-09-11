#!/usr/bin/env node
/**
 * What Finance counts is decided in ONE place, and it still says what it said.
 *
 *   node scripts/test_paid_predicate.js
 *
 * WHY THIS EXISTS. `lib/finance-window.js` has always claimed, in its own
 * header, that "editing a constant here is the only way to change what Finance
 * counts". That was true of the two Finance routes and quietly false of
 * everything else: `routes/retail.js` carried ELEVEN hand-written copies of the
 * paid-status allow-list — five bare, six alias-qualified — and none of them
 * imported this module. Consolidating them (2026-09-11) is the change this
 * suite guards, in both directions:
 *
 *   1. THE STRING DID NOT CHANGE. The predicate is now GENERATED from a list
 *      rather than typed, and generated output is exactly the characters that
 *      shipped. The literals below are a deliberate second copy, frozen here on
 *      purpose: if somebody reorders the list or adds a status, this file fails
 *      and makes them say so, instead of every money figure in the product
 *      quietly restating itself. This is the one place a duplicate is correct.
 *
 *   2. THE COPIES DID NOT COME BACK. A new hand-written copy in routes/ or lib/
 *      re-creates the drift, and the next person to change what counts would
 *      change it in one place and miss the rest.
 *
 * WHAT IT DOES NOT CLAIM. Five nearby predicates are genuinely different —
 * ('paid','awaiting_restock'), ('paid','preparing'), ('paid','preparing',
 * 'rider_pickup'), and the two channel-internal ones — and must NOT be folded
 * in. They answer different questions and the test allows them by construction:
 * it matches the full five-status list only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fw = require('../lib/finance-window');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// The characters that were in production before the consolidation. Frozen.
const BARE  = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";
const ALIAS = "o." + BARE;

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

it('the generated predicate is byte-for-byte what shipped', () => {
  assert.strictEqual(fw.PAID, BARE);
});

it('the alias-qualified twin is the same list, qualified', () => {
  assert.strictEqual(fw.PAID_O, ALIAS);
  assert.strictEqual(fw.paidWhere('o'), ALIAS);
  assert.strictEqual(fw.paidWhere(), BARE);
  assert.strictEqual(fw.paidWhere('x'), 'x.' + BARE);
});

it('the list behind it is the five statuses, in order', () => {
  assert.deepStrictEqual([...fw.PAID_STATUSES],
    ['paid', 'preparing', 'dispatched', 'delivered', 'awaiting_restock']);
});

it('the list cannot be mutated by a caller', () => {
  assert.throws(() => { fw.PAID_STATUSES.push('cancelled'); });
});

// ── The drift guard ────────────────────────────────────────────────────────
// Everything under routes/ and lib/, except this predicate's own home.
function sourceFiles() {
  const out = [];
  for (const dir of ['routes', 'lib']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.js')) out.push(rel);
      }
    };
    walk(dir);
  }
  return out.filter(f => f !== path.join('lib', 'finance-window.js'));
}

it('no file hand-writes the allow-list any more — lib/finance-window.js owns it', () => {
  const guilty = [];
  for (const f of sourceFiles()) {
    const src = read(f);
    // Both renderings. A comment mentioning it in prose is not a copy; only the
    // exact SQL is, and prose does not contain the closing paren run.
    const n = src.split(BARE).length - 1;
    if (n > 0) guilty.push(`${f} (${n})`);
  }
  assert.deepStrictEqual(guilty, [],
    'these re-introduce a copy of the paid allow-list — import ' +
    "financeWindow.PAID / .PAID_O instead:\n      " + guilty.join('\n      '));
});

it('routes/retail.js asks the module for it, rather than declaring its own', () => {
  const src = read(path.join('routes', 'retail.js'));
  assert.ok(/require\('\.\.\/lib\/finance-window'\)/.test(src),
    'routes/retail.js must import lib/finance-window');
  // The eleven sites, now nine references (two builders share a line shape).
  const uses = src.split('financeWindow.PAID').length - 1;
  assert.ok(uses >= 11, `expected at least 11 uses, found ${uses}`);
});

it('the genuinely different predicates are left alone', () => {
  const src = read(path.join('routes', 'retail.js'));
  // These answer different questions and folding them in would be a behaviour
  // change wearing a refactor's clothes. Their continued presence is the proof
  // the consolidation was surgical.
  for (const other of ["status IN ('paid','awaiting_restock')",
                       "status IN ('paid','preparing')",
                       "status IN ('paid','preparing','rider_pickup')"]) {
    assert.ok(src.includes(other), 'should still be present untouched: ' + other);
  }
});

console.log('');
if (fails.length) {
  console.log(`  ${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed`);
