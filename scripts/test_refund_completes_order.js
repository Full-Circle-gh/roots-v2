#!/usr/bin/env node
/**
 * Offline self-test for "full" in the refund paths — the rule that decides
 * whether a refund has returned the LAST of an order's money and must therefore
 * close it.
 *
 *   node scripts/test_refund_completes_order.js
 *
 * ── The bug this closes ───────────────────────────────────────────────────
 * /refund/direct computed it as:
 *
 *     const isFull = amount + 0.005 >= remainingGross && priorApproved <= 0.005;
 *
 * while the comment directly above it said "single full refund OR THE FINAL
 * PARTIAL THAT COMPLETES THE ORDER". The second clause denied the sentence: any
 * earlier refund sets refund_amount_approved > 0, so the refund that handed back
 * the last of the money scored isFull === false.
 *
 * What followed from that false: the order never left 'paid'/'delivered' — it
 * sat open, fully refunded — and reverseOrderPoints, reverseOrderReferral and
 * reverseLifetimeCommission never ran, so the customer kept the points and the
 * referrer kept the bounty on an order that had been paid back in full. The
 * status shortcut could not rescue it either: PATCH /status → 'refunded' answers
 * 409 use_refund_payout once a refund is 'paid', so "Cancel + refund" was the
 * only way to close such an order — which files a refund as a cancellation.
 *
 * /refund/approve has always computed it WITHOUT that clause, from identically
 * named priorApproved and remainingGross. So the two siblings disagreed about
 * what "full" means, and the one that disagreed with its own comment was wrong.
 *
 * No network, no keys, no DB file. Both halves read the SHIPPED source:
 *   • both isFull expressions are sliced out of routes/retail.js and EVALUATED,
 *     so a change to either rule moves these tests;
 *   • the remaining-units SQL is sliced out too and run against an in-memory
 *     retail_order_items built from database.js.
 *
 * What it locks down:
 *   1. THE CASE ITSELF — an order refunded in two halves is FULL on the second,
 *      so the order closes and the ledger reversals fire.
 *   2. NO REGRESSION — a genuine partial is still not full, and a single
 *      whole-order refund is still full.
 *   3. THE TWO PATHS AGREE — /refund/approve and /refund/direct are one rule in
 *      two places, and a scenario they disagree on is the bug class that
 *      produced this one.
 *   4. THE STOCK IS NOT RETURNED TWICE — the completing refund reverses only the
 *      units an earlier partial did not already release.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail.push(`${name}: ${e.message}`); }
}

// ── Slicing the shipped source ────────────────────────────────────────────
// Same readers as scripts/test_offapp_refund_guard.js, and for the same reason:
// each asserts it found its anchor, so a rename reports "not found in the
// shipped file" rather than quietly passing.

/** A statement: from `anchor` to the first `;` that is OUTSIDE a string. */
function sliceStatementFrom(src, anchor, fromIndex = 0) {
  const start = src.indexOf(anchor, fromIndex);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') return src.slice(start, j + 1);
  }
  throw new Error(`no statement terminator after ${anchor}`);
}

/** The first template literal after `anchor`, returned WITH its backticks. */
function sliceTemplateFrom(src, anchor, fromIndex = 0) {
  const start = src.indexOf(anchor, fromIndex);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('`', start + anchor.length);
  assert.notStrictEqual(open, -1, `no template literal after ${anchor}`);
  const close = src.indexOf('`', open + 1);
  assert.notStrictEqual(close, -1, `unterminated template literal after ${anchor}`);
  return src.slice(open, close + 1);
}

/** Offset of a route's handler, so the two same-named statements stay apart. */
function routeAt(routePath) {
  const i = RETAIL_JS.indexOf(`'${routePath}'`);
  assert.notStrictEqual(i, -1, `route not found in the shipped file: ${routePath}`);
  return i;
}

const APPROVE_AT = routeAt('/api/retail-admin/orders/:id/refund/approve');
const DIRECT_AT  = routeAt('/api/retail-admin/orders/:id/refund/direct');
assert.ok(APPROVE_AT < DIRECT_AT, 'expected /refund/approve to precede /refund/direct');

// The two isFull expressions, lifted from their OWN handlers. Each becomes a
// function of the three values the route has in scope at that point, so what
// these tests run is the expression the route runs.
function liftIsFull(label, fromIndex) {
  const stmt = sliceStatementFrom(RETAIL_JS, 'const isFull = ', fromIndex);
  return vm.runInNewContext(
    `(function (amount, remainingGross, priorApproved) { ${stmt} return isFull; })`,
    {}, { filename: `${label}:isFull` }
  );
}
const isFullApprove = liftIsFull('refund/approve', APPROVE_AT);
const isFullDirect  = liftIsFull('refund/direct',  DIRECT_AT);

// ── The scenarios ─────────────────────────────────────────────────────────
// `remainingGross` is what is LEFT to refund (the route computes it as
// G − priorApproved before either expression is evaluated), so a completing
// refund is one whose amount clears that remainder.
const CASES = [
  { name: 'single whole-order refund, nothing refunded before',
    amount: 100, remainingGross: 100, priorApproved: 0, full: true },

  { name: 'first half of a two-part refund',
    amount: 50, remainingGross: 100, priorApproved: 0, full: false },

  // THE CASE. Second half: ¥50 already approved, ¥50 left, ¥50 returned.
  { name: 'second half completes the order',
    amount: 50, remainingGross: 50, priorApproved: 50, full: true },

  { name: 'a further partial that leaves money on the order',
    amount: 10, remainingGross: 50, priorApproved: 50, full: false },

  { name: 'completing refund one cent short, inside the rounding tolerance',
    amount: 49.995, remainingGross: 50, priorApproved: 50, full: true },

  { name: 'completing refund on an order refunded in three parts',
    amount: 20, remainingGross: 20, priorApproved: 80, full: true },

  { name: 'small partial on a fresh order',
    amount: 0.5, remainingGross: 100, priorApproved: 0, full: false },
];

for (const c of CASES) {
  check(`direct · ${c.name}`, () => {
    assert.strictEqual(
      isFullDirect(c.amount, c.remainingGross, c.priorApproved), c.full,
      `expected isFull=${c.full} for amount=${c.amount} remaining=${c.remainingGross} prior=${c.priorApproved}`
    );
  });
  // The parity property. These two are one rule in two places; the defect was
  // exactly a scenario on which they disagreed.
  check(`approve agrees with direct · ${c.name}`, () => {
    assert.strictEqual(
      isFullApprove(c.amount, c.remainingGross, c.priorApproved),
      isFullDirect(c.amount, c.remainingGross, c.priorApproved),
      'refund/approve and refund/direct disagree about what "full" means'
    );
  });
}

// The clause itself is gone, named so a reintroduction says why it failed.
check('the priorApproved clause is not back in /refund/direct', () => {
  const stmt = sliceStatementFrom(RETAIL_JS, 'const isFull = ', DIRECT_AT);
  assert.ok(
    !/priorApproved/.test(stmt),
    'isFull in /refund/direct reads priorApproved again — that clause makes the ' +
    'final partial that completes an order unreachable, and the order never closes'
  );
});

// ── The stock the completing refund must NOT return twice ─────────────────
// An earlier line-itemised partial already released its units (ledger reason
// 'order_reverse_partial'), which reverseCommittedOrder's idempotency guard
// cannot see — it only recognises 'order_reverse'. So the completing refund
// reverses the REMAINING units, via the query lifted here.
const { openTablesDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// Backticks stripped — the opener wants the SQL text, not the literal.
const REMAINING_SQL = sliceTemplateFrom(RETAIL_JS, 'const remaining = tdb().prepare(', DIRECT_AT)
  .slice(1, -1);

function seedItems(rows) {
  const db = openTablesDb(DATABASE_JS, ['retail_order_items']);
  // unit_price and line_total are NOT NULL on the real table and irrelevant to
  // this query, so they carry fixed placeholders rather than per-fixture values.
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, qty, refunded_qty, unit_price, line_total)
     VALUES (?, ?, ?, ?, 1, 1)`
  );
  for (const r of rows) ins.run(r.order_id, r.product_id, r.qty, r.refunded_qty);
  return db;
}
const remainingFor = (db, orderId) =>
  db.prepare(REMAINING_SQL).all(orderId).map(r => ({ product_id: r.product_id, qty: Number(r.qty) }));

check('remaining units exclude what an earlier partial already released', () => {
  const db = seedItems([
    { order_id: 1, product_id: 10, qty: 3, refunded_qty: 3 },  // released already
    { order_id: 1, product_id: 11, qty: 2, refunded_qty: 0 },  // still to return
    { order_id: 2, product_id: 10, qty: 9, refunded_qty: 0 },  // another order
  ]);
  assert.deepStrictEqual(remainingFor(db, 1), [{ product_id: 11, qty: 2 }]);
});

check('a part-refunded line returns only its unreturned units', () => {
  const db = seedItems([{ order_id: 1, product_id: 10, qty: 5, refunded_qty: 2 }]);
  assert.deepStrictEqual(remainingFor(db, 1), [{ product_id: 10, qty: 3 }]);
});

check('one product split across two rows is summed, not double-counted', () => {
  const db = seedItems([
    { order_id: 1, product_id: 10, qty: 2, refunded_qty: 1 },
    { order_id: 1, product_id: 10, qty: 4, refunded_qty: 0 },
  ]);
  assert.deepStrictEqual(remainingFor(db, 1), [{ product_id: 10, qty: 5 }]);
});

check('an already fully-refunded order has nothing left to return', () => {
  const db = seedItems([
    { order_id: 1, product_id: 10, qty: 3, refunded_qty: 3 },
    { order_id: 1, product_id: 11, qty: 2, refunded_qty: 2 },
  ]);
  assert.deepStrictEqual(remainingFor(db, 1), []);
});

// ── Report ────────────────────────────────────────────────────────────────
console.log();
for (const f of fail) console.log(`  ✗ ${f}`);
console.log(`  ${pass} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
console.log('  ✓ a refund that clears the remainder closes the order');
