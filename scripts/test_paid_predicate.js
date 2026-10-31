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

// §98 stage three appended one clause to every one of these. The status half is
// still byte-for-byte what shipped; the new half is asserted separately so the
// two can never be confused for one another in a future edit.
const NOTREP  = " AND COALESCE(replacement_for_order_id, 0) = 0";
const NOTREPO = " AND COALESCE(o.replacement_for_order_id, 0) = 0";

it('the status half is byte-for-byte what shipped', () => {
  assert.ok(fw.PAID.startsWith(BARE), fw.PAID);
  assert.ok(fw.PAID_O.startsWith(ALIAS), fw.PAID_O);
});

it('every rendering excludes a replacement order (§98 stage three)', () => {
  assert.strictEqual(fw.PAID, BARE + NOTREP);
  assert.strictEqual(fw.PAID_O, ALIAS + NOTREPO);
  assert.strictEqual(fw.paidWhere('x'), 'x.' + BARE + ' AND COALESCE(x.replacement_for_order_id, 0) = 0');
});

it('the exclusion is COALESCE, so every pre-existing order still counts', () => {
  // An order written before the column existed has NULL there. `IS NULL` would
  // have been correct too; `= 0` alone would have silently dropped every order
  // in the history of the product.
  assert.ok(fw.PAID.includes('COALESCE('), fw.PAID);
  assert.ok(!/replacement_for_order_id\s*=\s*0/.test(fw.PAID.replace(/COALESCE\([^)]*\)/g, '')),
    'the raw column must never be compared to 0 without COALESCE');
});

it('the alias-qualified twin is the same list, qualified', () => {
  assert.strictEqual(fw.PAID_O, ALIAS + NOTREPO);
  assert.strictEqual(fw.paidWhere('o'), fw.PAID_O);
  assert.strictEqual(fw.paidWhere(), fw.PAID);
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

// ── The exclusion, run against a database rather than read ─────────────────
// Everything above compares strings. This runs the predicate, because the whole
// point of §98 stage three is what the numbers come out as.
it('a replacement is excluded from revenue, count and average — a real query', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_orders (
             id INTEGER PRIMARY KEY, status TEXT, total REAL,
             replacement_for_order_id INTEGER)`);
  const ins = db.prepare(
    'INSERT INTO retail_orders (id,status,total,replacement_for_order_id) VALUES (?,?,?,?)');
  ins.run(1, 'delivered', 800, null);   // a real sale
  ins.run(2, 'delivered', 200, null);   // another
  ins.run(3, 'preparing',   0, 1);      // the ¥0 replacement for order 1
  ins.run(4, 'cancelled', 500, null);   // never counted, before or after

  const agg = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue,
            COALESCE(AVG(total),0) AS aov
       FROM retail_orders WHERE ${fw.PAID}`).get();

  assert.strictEqual(agg.orders, 2, 'the replacement must not be counted as an order');
  assert.strictEqual(agg.revenue, 1000, 'revenue is unchanged either way');
  // THE ONE THAT WOULD HAVE BEEN WRONG. With the replacement counted the average
  // is 1000/3 = 333.33 instead of 500 — a third off, on every dashboard.
  assert.strictEqual(agg.aov, 500, 'a ¥0 replacement must not drag the average down');

  // And the alias form, since six of the consolidated sites use it.
  const aliased = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_orders o WHERE ${fw.PAID_O}`).get();
  assert.strictEqual(aliased.n, 2);

  // A legacy order with NULL in the column counts exactly as it always did —
  // which is every order that existed before §98 stage three shipped.
  const legacy = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_orders WHERE replacement_for_order_id IS NULL AND status='delivered'").get();
  assert.strictEqual(legacy.n, 2);
});

console.log('');
if (fails.length) {
  console.log(`  ${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed`);
