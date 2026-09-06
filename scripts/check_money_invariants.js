#!/usr/bin/env node
require('../lib/load-env').loadEnv();
//
// check_money_invariants.js — the oracle for the money migration (audit A-06,
// Stage 0 of docs/tacet-money-migration-plan.md).
//
// WHAT IT IS FOR
// --------------
// Converting 90-odd REAL money columns to integers is a change nothing in the
// schema can check. There is no constraint to violate: a column that comes out
// of the conversion 100× wrong is still a valid REAL, and a report built on it
// still renders. So the only way to know the conversion was faithful is to
// measure the database BEFORE, measure it AFTER, and require the two to agree.
//
// This file is that measurement. It is run four times per rung of the ladder:
// against a copy before the migration, against the copy after it, against
// production before, and against production after.
//
// TWO HALVES, AND THEY ANSWER DIFFERENT QUESTIONS
// -----------------------------------------------
//   INVARIANTS  do the numbers still agree with each other? An order's total
//               against its parts, a refund against what was tendered, a
//               lifetime total against the orders it rolls up.
//   CENSUS      is every stored value still the same value? Per column: how
//               many, their exact sum in cents, the extremes. A conversion that
//               loses a row or shifts a decimal changes this and cannot not.
//
// The invariants can pass while the census moves — that is a conversion that
// kept the relationships and changed the money. The census can hold while an
// invariant breaks — that is a writer that was missed. Both are needed.
//
// RECORD THE BASELINE BEFORE ANYTHING CHANGES
// -------------------------------------------
// Some invariants may not hold today. That is what a half-cent tolerance in the
// refund path implies. If the current failure set is not written down first,
// every pre-existing discrepancy gets attributed to the migration and the
// migration gets rolled back for a bug it did not cause.
//
//   node scripts/check_money_invariants.js --db <copy> --json > baseline.json
//   …migrate…
//   node scripts/check_money_invariants.js --db <copy> --baseline baseline.json
//
// With --baseline it exits non-zero on any DELTA, not on any failure — which is
// the right gate for a migration. A check that was already red stays red and
// says so; a check that goes red because of the migration fails the run.
//
// READ-ONLY, AND ENFORCED RATHER THAN PROMISED
// --------------------------------------------
// The handle is opened with the driver's read-only flag, so a write is refused
// by the driver, not by this file being careful. Same two-driver fallback as
// check_ledger_invariants.js, which this file deliberately mirrors so the three
// stay maintainable together.
//
// RUN IT AGAINST A COPY ANYWAY. Read-only is not zero-impact: a full-table scan
// against the live file competes with the application for page cache.
// /root/backups/hourly holds a gzipped snapshot every hour.
//
// USAGE
//   node scripts/check_money_invariants.js --db /tmp/copy.db
//   node scripts/check_money_invariants.js --db /tmp/copy.db --json
//   node scripts/check_money_invariants.js --db /tmp/copy.db --baseline before.json
//
// EXIT CODE
//   0  every invariant held (or, with --baseline, nothing moved)
//   1  an invariant failed (or, with --baseline, something moved)
//   2  the run could not happen at all

'use strict';

const fs = require('fs');
const path = require('path');
const moneyColumns = require('../lib/money-columns');

const DEFAULT_LIMIT = 20;

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  if (!argv[at + 1]) {
    console.error(`[check_money_invariants] ${name} needs an argument.`);
    process.exit(2);
  }
  return argv[at + 1];
};
const AS_JSON = argv.includes('--json');
const BASELINE = flag('--baseline');
const LIMIT = Math.max(1, parseInt(flag('--limit'), 10) || DEFAULT_LIMIT);
const dbPath = flag('--db') || path.join(__dirname, '..', 'data', 'roots.db');

function openSqlite(file) {
  if (!fs.existsSync(file)) {
    console.error(`[check_money_invariants] no database at ${file}`);
    console.error('  Pass --db <path> to a COPY.');
    process.exit(2);
  }
  // The native driver is probed by CONSTRUCTING, not by requiring:
  // better-sqlite3 is plain JavaScript and requires fine with no binding built,
  // throwing only when a database is opened.
  try {
    const Better = require('better-sqlite3');
    const db = new Better(file, { readonly: true });
    db.prepare('SELECT 1').get();
    return { name: `better-sqlite3 (read-only) ${file}`, all: (s, p = []) => db.prepare(s).all(...p), close: () => db.close() };
  } catch (e) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e2) {
      console.error('[check_money_invariants] no usable SQLite driver.');
      console.error(`  better-sqlite3: ${String(e.message).split('\n')[0]}`);
      console.error(`  node:sqlite:    ${e2.message}  (needs Node 22+)`);
      process.exit(2);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    return { name: `node:sqlite (read-only) ${file}`, all: (s, p = []) => db.prepare(s).all(...p), close: () => db.close() };
  }
}

// ── THE INVARIANTS ────────────────────────────────────────────────────────
// Each carries a count query returning a single column `n`, and a detail query
// returning the rows behind it so a non-zero result can be triaged without
// writing SQL by hand.
//
// EVERY COMPARISON IS TO THE CENT, deliberately: `ROUND(x * 100)` on both sides
// rather than `ABS(a - b) < 0.005`. The tolerance is the thing this migration
// exists to delete, and an oracle that uses it cannot tell whether the
// migration worked.
//
// THE REFUND CEILING IS THE GROSS, NOT THE TOTAL. `retail_orders.total` is the
// CASH tender only; the real ceiling is points_amount + balance_used + total
// (routes/retail.js orderTenders). Getting this wrong reported two correct
// orders as over-refunded once already, which is recorded in the plan.
/* WHAT AN ORDER'S TOTAL IS, WRITTEN ONCE.
 *
 * Invariant A's count and detail queries both need it, and a formula this
 * fiddly restated twice is a formula that will disagree with itself. It is
 * interpolated into both below.
 *
 * TWO SHAPES, BECAUSE THERE ARE TWO KINDS OF ORDER, and conflating them is
 * what made this check wrong for a year of Meituan and Eleme trading.
 *
 * A CHANNEL ORDER is not created here — the Meituan and Eleme ingests mirror
 * it in, and the platform has already done the arithmetic. Its identity is
 * `subtotal + packing + delivery − merchant discount = total`, stated in
 * lib/channel-settlement.js and enforced one order at a time by the admin's
 * Settlement panel since PR #206. Asking such a row for `− voucher − points −
 * balance` asks it for terms the platform never sends, so every discounted
 * channel order failed this check by exactly its own promotion. Seventeen of
 * the twenty-three failures in the 2026-09-06 production rehearsal were this.
 *
 * AN OWN ORDER is created by routes/retail.js, and its total is FLOORED TWICE:
 *
 *     grossTotal = MAX(0, subtotal + shipping + packing − voucher) + taxAdded
 *     total      = MAX(0, grossTotal − points − balance)
 *
 * (retail.js:10832 and :10925.) The floors are why TC000207 and R260630163496
 * failed: points and a voucher covered more than the order was worth, the
 * arithmetic goes to −0.78 and −0.60, and the stored total is correctly 0.
 * A check without the floors reports the shop's own clamp as a defect.
 *
 * THE TAX TERM IS THE ADDED HALF, NOT THE WHOLE. `tax_amount` records how much
 * of the order IS tax; what the total goes UP by is that figure on an
 * exclusive shop and ZERO on an inclusive one, where it was already inside the
 * prices (lib/tax.js: `addedMinor = taxMinor` exclusive, `0` inclusive). Adding
 * tax_amount unconditionally would break every inclusive shop the day it
 * switched tax on. No production order carries tax today, so this term is
 * currently proven only by the fixture — which is the point of having one.
 *
 * The surcharge stays out: shipping_fee already contains it. See the note on
 * the check itself. */
const EXPECTED_TOTAL = `
  CASE WHEN COALESCE(NULLIF(TRIM(channel), ''), 'wechat') IN ('meituan', 'eleme')
       THEN COALESCE(subtotal,0) + COALESCE(packing_fee,0) + COALESCE(shipping_fee,0)
            - COALESCE(channel_discount,0)
       ELSE MAX(0,
              MAX(0, COALESCE(subtotal,0) + COALESCE(shipping_fee,0) + COALESCE(packing_fee,0)
                     - COALESCE(voucher_amount,0))
              + CASE WHEN tax_mode = 'exclusive' THEN COALESCE(tax_amount,0) ELSE 0 END
              - COALESCE(points_amount,0) - COALESCE(balance_used,0))
  END`;

const CHECKS = [
  {
    id: 'A', kind: 'invariant',
    title: 'an order total is its parts',
    blurb: 'an own order: MAX(0, MAX(0, subtotal + shipping + packing − voucher) + tax added − points − balance) = total. '
      + 'A Meituan or Eleme order: subtotal + packing + delivery − channel discount = total.',
    notes: [
      'Skips orders with a NULL subtotal — a draft that was never priced is not a broken order.',
      'TWO SHAPES, ONE CHECK. A channel order is mirrored in by the Meituan/Eleme ingest and '
      + 'obeys the identity lib/channel-settlement.js states — the platform has already done the '
      + 'arithmetic, and it sends no voucher, points or balance. Asking it for those terms failed '
      + 'every discounted channel order by exactly its own promotion: 17 of the 23 failures in the '
      + 'first production rehearsal, 2026-09-06. Run scripts/diagnose_channel_settlement.js to see '
      + 'a remaining channel failure classified by cause — that script and this check read the '
      + 'same identity from the same module.',
      'THE TOTAL IS FLOORED AT ZERO, TWICE (routes/retail.js:10832 and :10925), and this check '
      + 'now floors it too. An order whose points and voucher exceed its value computes to a small '
      + 'negative and is correctly stored as 0; without the floors the shop\'s own clamp is '
      + 'reported as a broken order. TC000207 (−0.78) and R260630163496 (−0.60) were exactly this.',
      'The tax term is the ADDED half. tax_amount is how much of the order is tax; the total goes '
      + 'up by it on an EXCLUSIVE shop and by nothing on an inclusive one, where it was already '
      + 'inside the prices (lib/tax.js). No production order carries tax yet, so the fixture is '
      + 'what holds this arm.',
      'The same-day surcharge is NOT added: it is already inside shipping_fee. routes/retail.js '
      + 'does `shippingFee += sameDaySurcharge` at order creation ("added to the shipping line so '
      + 'totals reconcile without a new fee column"), and same_day_surcharge_fee is the BREAKDOWN '
      + 'of how much of that line is surcharge — the waiver path subtracts it back out for the '
      + 'same reason. Adding it here counted it twice, so every same-day order failed this check '
      + 'by exactly its own surcharge. Found by the first production rehearsal, 2026-09-06: three '
      + 'storefront orders short by exactly 15.00, which was their surcharge to the cent.',
    ],
    count: `SELECT COUNT(*) AS n FROM retail_orders
             WHERE subtotal IS NOT NULL AND total IS NOT NULL
               AND ROUND((${EXPECTED_TOTAL}) * 100) <> ROUND(COALESCE(total,0) * 100)`,
    /* The detail carries `channel` and the expected figure, because the first
       question about any row here is which of the two identities was applied
       to it, and the second is what the check thought the total should be.
       Both used to require re-deriving the arithmetic by hand from the
       components — which is how the surcharge double-count survived. */
    detail: `SELECT id, order_no, channel, subtotal, shipping_fee, packing_fee,
                    same_day_surcharge_fee, voucher_amount, points_amount, balance_used,
                    channel_discount, tax_amount, tax_mode, total,
                    ROUND((${EXPECTED_TOTAL}) * 100) / 100.0 AS expected
               FROM retail_orders
              WHERE subtotal IS NOT NULL AND total IS NOT NULL
                AND ROUND((${EXPECTED_TOTAL}) * 100) <> ROUND(COALESCE(total,0) * 100)
              ORDER BY id DESC LIMIT ?`,
  },
  {
    id: 'B', kind: 'invariant',
    title: 'a line total is its unit price times its quantity',
    blurb: 'ROUND(unit_price × qty) = ROUND(line_total), to the cent.',
    notes: ['This is the check that would catch a rate column converted as an amount.'],
    count: `SELECT COUNT(*) AS n FROM retail_order_items
             WHERE unit_price IS NOT NULL AND line_total IS NOT NULL
               AND ROUND(unit_price * COALESCE(qty,0) * 100) <> ROUND(line_total * 100)`,
    detail: `SELECT id, order_id, sku, qty, unit_price, line_total
               FROM retail_order_items
              WHERE unit_price IS NOT NULL AND line_total IS NOT NULL
                AND ROUND(unit_price * COALESCE(qty,0) * 100) <> ROUND(line_total * 100)
              ORDER BY id DESC LIMIT ?`,
  },
  {
    id: 'C', kind: 'invariant',
    title: 'nothing is refunded above what the customer tendered',
    blurb: 'refund_amount_paid ≤ points_amount + balance_used + total — the GROSS, not the cash.',
    notes: [
      'The ceiling is the gross. An order paid partly in points or store credit can',
      'correctly be refunded for more than `total`, which is cash only.',
    ],
    count: `SELECT COUNT(*) AS n FROM retail_orders
             WHERE COALESCE(refund_amount_paid,0) > 0
               AND ROUND(COALESCE(refund_amount_paid,0) * 100)
                 > ROUND((COALESCE(points_amount,0) + COALESCE(balance_used,0) + COALESCE(total,0)) * 100)`,
    detail: `SELECT id, order_no, total, points_amount, balance_used,
                    (COALESCE(points_amount,0)+COALESCE(balance_used,0)+COALESCE(total,0)) AS gross,
                    refund_amount_paid
               FROM retail_orders
              WHERE COALESCE(refund_amount_paid,0) > 0
                AND ROUND(COALESCE(refund_amount_paid,0) * 100)
                  > ROUND((COALESCE(points_amount,0) + COALESCE(balance_used,0) + COALESCE(total,0)) * 100)
              ORDER BY id DESC LIMIT ?`,
  },
  {
    id: 'D', kind: 'invariant',
    title: 'no more CASH goes back than cash came in',
    blurb: 'refund_cash_amount ≤ total. This is the one that would actually cost money.',
    notes: ['Cash is the half that leaves the business. Points and credit returning is not a loss.'],
    count: `SELECT COUNT(*) AS n FROM retail_orders
             WHERE COALESCE(refund_cash_amount,0) > 0
               AND ROUND(COALESCE(refund_cash_amount,0) * 100) > ROUND(COALESCE(total,0) * 100)`,
    detail: `SELECT id, order_no, total, refund_cash_amount
               FROM retail_orders
              WHERE COALESCE(refund_cash_amount,0) > 0
                AND ROUND(COALESCE(refund_cash_amount,0) * 100) > ROUND(COALESCE(total,0) * 100)
              ORDER BY id DESC LIMIT ?`,
  },
  {
    id: 'E', kind: 'invariant',
    title: 'a payment is never refunded for more than it took',
    blurb: 'retail_payments.refunded_amount ≤ retail_payments.amount.',
    notes: [],
    count: `SELECT COUNT(*) AS n FROM retail_payments
             WHERE ROUND(COALESCE(refunded_amount,0) * 100) > ROUND(COALESCE(amount,0) * 100)`,
    detail: `SELECT id, order_id, method, status, amount, refunded_amount
               FROM retail_payments
              WHERE ROUND(COALESCE(refunded_amount,0) * 100) > ROUND(COALESCE(amount,0) * 100)
              ORDER BY id DESC LIMIT ?`,
  },
  {
    id: 'F', kind: 'invariant',
    title: 'no negative money where none is possible',
    blurb: 'An order total, a payment amount and a wallet balance are never below zero.',
    notes: ['A negative here after conversion is an overflow or a sign error, not a business event.'],
    count: `SELECT (SELECT COUNT(*) FROM retail_orders   WHERE total < 0)
                 + (SELECT COUNT(*) FROM retail_payments WHERE amount < 0)
                 + (SELECT COUNT(*) FROM retail_customers WHERE balance < 0) AS n`,
    detail: `SELECT 'order' AS kind, id, total AS amount FROM retail_orders WHERE total < 0
              UNION ALL SELECT 'payment', id, amount FROM retail_payments WHERE amount < 0
              UNION ALL SELECT 'wallet', id, balance FROM retail_customers WHERE balance < 0
              LIMIT ?`,
  },
  {
    id: 'G', kind: 'reconciliation',
    title: 'a customer’s lifetime spend against their orders',
    blurb: 'lifetime_spend vs the sum of that customer’s non-cancelled order subtotals.',
    notes: [
      'RECONCILIATION, not an invariant: lifetime_spend is only reversed by a FULL',
      'refund and is never reduced by a partial one, so a customer who has had a',
      'partial refund legitimately sits above the live sum. Non-zero is expected.',
      'What matters for the migration is that this number does not MOVE.',
    ],
    count: `SELECT COUNT(*) AS n FROM (
              SELECT c.id,
                     ROUND(COALESCE(c.lifetime_spend,0) * 100) AS stored,
                     ROUND(COALESCE((SELECT SUM(o.subtotal) FROM retail_orders o
                                      WHERE o.customer_id = c.id
                                        AND o.status NOT IN ('cancelled','refunded','pending_payment')),0) * 100) AS live
                FROM retail_customers c)
             WHERE stored <> live`,
    detail: `SELECT * FROM (
              SELECT c.id, c.nickname, COALESCE(c.lifetime_spend,0) AS stored,
                     COALESCE((SELECT SUM(o.subtotal) FROM retail_orders o
                                WHERE o.customer_id = c.id
                                  AND o.status NOT IN ('cancelled','refunded','pending_payment')),0) AS live
                FROM retail_customers c)
             WHERE ROUND(stored * 100) <> ROUND(live * 100)
             ORDER BY ABS(stored - live) DESC LIMIT ?`,
  },
  {
    id: 'H', kind: 'forensic',
    title: 'stored values that are not a whole number of cents',
    blurb: 'The measurement the whole migration is about. A number, not a verdict.',
    notes: [
      'FORENSIC. Non-zero is the finding, not a failure — it is why this work exists.',
      'It is concentrated in the RATE columns, which is why they convert to micro',
      'units rather than cents. See lib/money-columns.js.',
    ],
    dynamic: 'dirty',
  },
];

// ── THE CENSUS ────────────────────────────────────────────────────────────
// Per classified column: how many non-null values, their exact total in cents,
// and the extremes. This is the fingerprint the migration must not change.
//
// SUM IS TAKEN IN CENTS, NOT IN YUAN. `SUM(col)` over REALs is itself subject to
// the drift being migrated away from, so it would not compare stably even
// against itself. `SUM(ROUND(col * 100))` is an integer sum of integers and is
// exact — which is the only kind of number worth putting in a baseline.
// UNRESOLVED COLUMNS ARE MEASURED TOO, and that is not a detail. A column
// nobody has classified is a column the migration must not touch — so its
// fingerprint moving is the strongest possible signal that something converted
// it anyway. Leaving them out of the census is how retail_vouchers.value gets
// multiplied by 100 with nothing to notice.
function census(db) {
  const out = {};
  for (const c of [...moneyColumns.columnsOfUnit('amount'), ...moneyColumns.columnsOfUnit('rate'),
                   ...moneyColumns.columnsOfUnit('unresolved')]) {
    try {
      const scale = c.unit === 'rate' ? 10000 : 100;
      const r = db.all(
        `SELECT COUNT(${c.column}) AS n,
                COALESCE(SUM(CAST(ROUND(${c.column} * ${scale}) AS INTEGER)), 0) AS sum_scaled,
                MIN(${c.column}) AS lo, MAX(${c.column}) AS hi,
                SUM(CASE WHEN ${c.column} IS NOT NULL
                          AND ABS(${c.column} * ${scale} - CAST(ROUND(${c.column} * ${scale}) AS INTEGER)) > 1e-6
                         THEN 1 ELSE 0 END) AS not_exact
           FROM ${c.table}`
      )[0];
      out[c.key] = {
        unit: c.unit, n: r.n, sum_scaled: r.sum_scaled,
        lo: r.lo, hi: r.hi, not_exact: r.not_exact || 0,
      };
    } catch (e) {
      // A table this database does not have is not a failure: guanyi_product_pricing
      // is created by an import script and is absent from a fresh schema.
      out[c.key] = { unit: c.unit, absent: true, why: String(e.message).split('\n')[0] };
    }
  }
  return out;
}

// The "not a whole number of cents" count, over every AMOUNT column. Rates are
// excluded on purpose: a rate that is not a whole cent is not a defect, it is a
// rate, and counting it here is what made the earlier scan's number unreadable.
function dirtyCount(db) {
  let dirty = 0, total = 0;
  for (const c of moneyColumns.columnsOfUnit('amount')) {
    try {
      const r = db.all(
        `SELECT COUNT(${c.column}) AS n,
                SUM(CASE WHEN ${c.column} IS NOT NULL
                          AND ABS(${c.column} * 100 - CAST(ROUND(${c.column} * 100) AS INTEGER)) > 1e-6
                         THEN 1 ELSE 0 END) AS d
           FROM ${c.table}`
      )[0];
      total += r.n || 0; dirty += r.d || 0;
    } catch (e) { /* table absent on this database — counted nowhere, said in the census */ }
  }
  return { dirty, total };
}

// ── Run ───────────────────────────────────────────────────────────────────
function run() {
  const db = openSqlite(dbPath);
  const report = { db: dbPath, at: new Date().toISOString(), checks: {}, census: {}, inventory: {} };

  const inv = moneyColumns.scan({ prepare: (s) => ({ all: (...p) => db.all(s, p) }) });
  report.inventory = { unclassified: inv.unclassified.map((u) => u.key), missing: inv.missing };

  const details = {};
  for (const c of CHECKS) {
    if (c.dynamic === 'dirty') {
      const d = dirtyCount(db);
      report.checks[c.id] = { kind: c.kind, title: c.title, n: d.dirty, of: d.total };
      continue;
    }
    try {
      const n = db.all(c.count)[0].n || 0;
      report.checks[c.id] = { kind: c.kind, title: c.title, n };
      if (n > 0 && c.detail) { try { details[c.id] = db.all(c.detail, [LIMIT]); } catch (e) { details[c.id] = []; } }
    } catch (e) {
      report.checks[c.id] = { kind: c.kind, title: c.title, error: String(e.message).split('\n')[0] };
    }
  }
  report.census = census(db);
  db.close();
  return { report, details };
}

// Required rather than run: a red-proof test imports CHECKS and seeds a break
// into a fixture for each one. A check set with no failing case is not a check
// set, and a test that copies the queries instead of importing them proves
// nothing about the file that ships.
if (require.main !== module) {
  module.exports = { CHECKS, census, dirtyCount, openSqlite };
  return;
}

const { report, details } = run();

// ── Output ────────────────────────────────────────────────────────────────
if (AS_JSON && !BASELINE) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

const line = (s) => console.log(s);
line('');
line('═'.repeat(72));
line(`MONEY INVARIANTS · ${dbPath}`);
line('═'.repeat(72));

let failed = 0;
for (const c of CHECKS) {
  const r = report.checks[c.id];
  if (r.error) { line(`\n  ⚠ ${c.id}  ${c.title}\n      could not run: ${r.error}`); continue; }
  const bad = c.kind === 'invariant' && r.n > 0;
  if (bad) failed++;
  const mark = c.kind !== 'invariant' ? '·' : (r.n === 0 ? '✓' : '✗');
  const num = r.of != null ? `${r.n} of ${r.of}` : String(r.n);
  line(`\n  ${mark} ${c.id}  ${c.title}  —  ${num}`);
  line(`      ${c.blurb}`);
  for (const n of c.notes || []) line(`      ${n}`);
  if (details[c.id] && details[c.id].length) {
    for (const row of details[c.id]) line('        ' + JSON.stringify(row));
    if (r.n > details[c.id].length) line(`        …and ${r.n - details[c.id].length} more (raise --limit)`);
  }
}

line('');
line('─'.repeat(72));
const censusRows = Object.entries(report.census).filter(([, v]) => !v.absent);
const absent = Object.entries(report.census).filter(([, v]) => v.absent);
line(`CENSUS · ${censusRows.length} column(s) measured, ${absent.length} not on this database`);
const values = censusRows.reduce((a, [, v]) => a + (v.n || 0), 0);
line(`  ${values.toLocaleString()} non-null money values`);
if (report.inventory.unclassified.length) {
  line('');
  line(`  ⚠ ${report.inventory.unclassified.length} money-named column(s) NOT classified in lib/money-columns.js:`);
  for (const k of report.inventory.unclassified) line(`      ${k}`);
  line('    A column nobody has decided about cannot be migrated. Classify it first.');
  failed++;
}

// ── Baseline comparison ───────────────────────────────────────────────────
// The gate for a migration is not "everything passes", it is "nothing moved".
if (BASELINE) {
  let before;
  try { before = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); }
  catch (e) { console.error(`\n[check_money_invariants] could not read ${BASELINE}: ${e.message}`); process.exit(2); }
  line('');
  line('─'.repeat(72));
  line(`AGAINST THE BASELINE · ${BASELINE}`);
  const moved = [];
  for (const id of Object.keys(report.checks)) {
    const a = before.checks[id], b = report.checks[id];
    if (!a) { moved.push(`${id}: not in the baseline`); continue; }
    if ((a.n || 0) !== (b.n || 0)) moved.push(`${id} ${b.title}: ${a.n} → ${b.n}`);
  }
  for (const key of Object.keys(report.census)) {
    const a = before.census[key], b = report.census[key];
    if (!a) { moved.push(`census ${key}: not in the baseline`); continue; }
    if (!!a.absent !== !!b.absent) { moved.push(`census ${key}: table appeared or vanished`); continue; }
    if (a.absent) continue;
    if (a.n !== b.n) moved.push(`census ${key}: ${a.n} → ${b.n} value(s)`);
    if (a.sum_scaled !== b.sum_scaled) moved.push(`census ${key}: total ${a.sum_scaled} → ${b.sum_scaled} (scaled)`);
  }
  if (!moved.length) {
    line('  ✓ nothing moved. Every check and every column total is identical.');
  } else {
    line(`  ✗ ${moved.length} thing(s) moved:`);
    for (const m of moved) line(`      ${m}`);
    line('');
    line('  A MOVED CENSUS TOTAL IS THE MIGRATION LOSING MONEY. A moved check is a');
    line('  relationship it broke. Neither is acceptable; roll back and find out why.');
  }
  line('');
  process.exit(moved.length ? 1 : 0);
}

line('');
line(failed ? `  ${failed} invariant(s) FAILED.` : '  Every invariant held.');
line('  Record this as the baseline before migrating:  --json > baseline.json');
line('');
process.exit(failed ? 1 : 0);
