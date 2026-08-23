#!/usr/bin/env node
// .env is parsed here, before anything reaches for a connection, so a missing
// variable is reported as a missing variable rather than as a data finding.
// Extracted from server.js as lib/load-env.js because .env is NOT shell-
// sourceable -- see that file's header. (This began as GAP G27 of the Postgres
// migration, cancelled 2026-08-23; the loader outlived it and is still right.)
require('../lib/load-env').loadEnv();
//
// check_points_invariants.js — the three invariants that prove no customer is
// silently short of loyalty points.
//
// WHY THIS EXISTS
// ---------------
// awardOrderPoints is wrapped in a swallowing try/catch, and so is every one of
// its three callers (markOrderPaid, reverseOrderReferral, and the admin
// PATCH /api/retail-admin/orders/:id/status). A failure there therefore looks
// EXACTLY like a success: the order completes, the admin sees nothing, and the
// only trace is one console.error line in a log with no timestamps. A real
// points loss would be invisible until a customer complained.
//
// One such failure has already happened (2026-08-08, order 1013 / TC000195 —
// see docs/tacet-consolidation-decisions.md §24). It cost nothing because that
// order had no customer, but the same swallow would have hidden a real loss
// just as completely. These checks are the standing detector for that class of
// fault, so it is never again found by reading a log by hand.
//
// The missing-guard fix itself belongs to the money-cluster conversion of
// awardOrderPoints. This file does not fix anything; it tells you whether the
// damage has occurred.
//
// THE LOAD-BEARING DETAIL: WHY A MISSING LEDGER ROW IS THE SIGNAL
// ---------------------------------------------------------------
// awardOrderPoints inserts its `order_earn` row EVEN WHEN THE AWARD IS ZERO
// POINTS. Its own comment says why: the row is the single idempotency marker
// for both the points award and the lifetime_spend bump, so a sub-threshold
// order cannot be double-counted on a retry.
//
// That is what makes check B decisive. A paid order belonging to a real
// customer with NO order_earn row is not an order that earned nothing — it is
// an order whose award never completed. Conversely a row carrying delta 0 is
// proof the calculation RAN and legitimately produced zero. Do not "simplify"
// check B into a points_earned = 0 test; that conflates the two and is exactly
// the mistake this file exists to prevent.
//
// *** CHECK D MUST INCLUDE order_addon_earn — THIS IS NOT OPTIONAL ***
// -------------------------------------------------------------------
// retail_orders.points_earned is CUMULATIVE. finalizeOrderAddon (a customer
// paying for an add-on after the order was placed) INCREMENTS it and writes a
// SEPARATE ledger row with source `order_addon_earn`, not `order_earn`. So
// points_earned must be compared against the SUM of both sources.
//
// WORKED EXAMPLE — ORDER 229. Comparing points_earned against `order_earn`
// alone reports it as a mismatch: the order says 2, the order_earn row says 1.
// It is not a mismatch. Its full ledger is order_earn +1, order_addon_earn +1,
// refund_reverse -2 — the add-on earned the second point, and the later refund
// correctly reversed both. Omitting order_addon_earn produced exactly this
// false positive during the original investigation. If a future source is added
// that also moves points_earned, add it to EARN_SOURCES below.
//
// READ-ONLY, AND ENFORCED RATHER THAN PROMISED
// --------------------------------------------
// Every statement issued is a SELECT. On SQLite the handle is opened with the
// driver's read-only flag, so a write is refused by the driver itself. On
// PostgreSQL the checks run inside a READ ONLY transaction, so a write is
// refused by the server. Neither relies on this file being careful.
//
// PORTABLE ACROSS THE CUTOVER, BY CONSTRUCTION
// --------------------------------------------
// This must keep working after the PostgreSQL migration (§24), so the SQL below
// avoids everything the two dialects disagree about:
//   * string literals are single-quoted — PostgreSQL reads "x" as an IDENTIFIER
//   * every subquery in FROM is aliased — PostgreSQL requires it, SQLite doesn't
//   * no ROUND() on a floating column — PostgreSQL has no round(double, int);
//     totals are summed raw and formatted in JavaScript instead
//   * no date/time functions at all — only MIN/MAX over the stored column
//   * COUNT(*) is coerced with Number() — node-pg returns bigint as a STRING
//
// USAGE
//   node scripts/check_points_invariants.js                  # SQLite, data/roots.db
//   node scripts/check_points_invariants.js --db /path/to/roots.db
//
// EXIT CODE
//   0  every check passed
//   1  at least one check FAILED — a customer may be short; investigate before
//      dismissing it, and see §24 for how the first case was traced
//   2  the script could not run at all (no driver, no database, bad arguments)

'use strict';

const fs = require('fs');
const path = require('path');

// Sources that move retail_orders.points_earned. See the header — omitting
// order_addon_earn makes check D report false positives (order 229).
const EARN_SOURCES = ['order_earn', 'order_addon_earn'];

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--pg')) {
  // The Postgres migration was cancelled 2026-08-23 and lib/pg.js is gone.
  // This REFUSES rather than falling back to SQLite: a check that silently
  // answers a different question than the one asked is the failure mode this
  // whole script exists to avoid. See docs/tacet-operating-findings.md.
  console.error('[check_points_invariants] --pg is gone. Tacet is on SQLite; there is no Postgres to check.');
  process.exit(2);
}
const dbFlagAt = argv.indexOf('--db');
if (dbFlagAt !== -1 && !argv[dbFlagAt + 1]) {
  console.error('[check_points_invariants] --db needs a path argument.');
  process.exit(2);
}
const dbPath = dbFlagAt !== -1
  ? argv[dbFlagAt + 1]
  : path.join(__dirname, '..', 'data', 'roots.db');

// ── Backends ──────────────────────────────────────────────────────────────
// Both expose the same shape: query(sql, params) -> Promise<rows[]>. Async even
// on SQLite, because that was the contract pg would have needed and §24's point is
// that call sites should not change shape at the cutover.

/**
 * SQLite, opened read-only. Tries the application's driver first and falls back
 * to Node's built-in — the same split scripts/test-support/memory-db.js
 * documents: the box has the native binding on Node 20, this machine has
 * node:sqlite on Node 24, and neither has both.
 *
 * The native require is probed by CONSTRUCTING, not by requiring: better-sqlite3
 * is plain JavaScript and requires fine with no binding built, throwing only
 * when a database is opened. A try around the require alone silently never
 * falls back — the bug memory-db.js was created to stop.
 */
function openSqlite(file) {
  if (!fs.existsSync(file)) {
    console.error(`[check_points_invariants] no database at ${file}`);
    console.error('  Pass --db <path>.');
    process.exit(2);
  }
  try {
    const Better = require('better-sqlite3');
    const db = new Better(file, { readonly: true });
    return {
      name: `better-sqlite3 (read-only) ${file}`,
      query: async (sql, params = []) => db.prepare(sql).all(...params),
      close: async () => db.close(),
    };
  } catch (e) {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (e2) {
      console.error('[check_points_invariants] no usable SQLite driver.');
      console.error(`  better-sqlite3: ${e.message.split('\n')[0]}`);
      console.error(`  node:sqlite:    ${e2.message}  (needs Node 22+)`);
      process.exit(2);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      name: `node:sqlite (read-only) ${file}`,
      query: async (sql, params = []) => db.prepare(sql).all(...params),
      close: async () => db.close(),
    };
  }
}

// ── The population every check is scoped to ───────────────────────────────
// A paid order belonging to a real customer. paid_at rather than status,
// because status keeps moving (preparing -> dispatched -> delivered) while
// paid_at is stamped once at the moment the award should have fired.
const POPULATION = 'o.customer_id IS NOT NULL AND o.paid_at IS NOT NULL';

const EARN_LIST = EARN_SOURCES.map((s) => `'${s}'`).join(', ');

// ── Output helpers ────────────────────────────────────────────────────────
let failures = 0;

function report(label, count, detail) {
  const passed = count === 0;
  if (!passed) failures++;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        count = ${count}${detail ? `   ${detail}` : ''}`);
}

const money = (v) => (Number(v) || 0).toFixed(2);

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = openSqlite(dbPath);

  console.log('');
  console.log('POINTS INVARIANTS');
  console.log(`  backend: ${db.name}`);
  console.log('');

  try {
    // [A] CONTEXT ONLY — not a pass/fail. Scopes every number below, and makes
    // a shrinking population visible: if this drops, something deleted orders
    // and the checks are quietly covering less than they used to.
    const [a] = await db.query(
      `SELECT COUNT(*) AS n, MIN(o.paid_at) AS first_paid, MAX(o.paid_at) AS last_paid,
              SUM(o.total) AS value
         FROM retail_orders o
        WHERE ${POPULATION}`
    );
    console.log('[A] POPULATION (context, not a check)');
    console.log(`        paid orders with a customer = ${Number(a.n)}`);
    console.log(`        first paid_at               = ${a.first_paid || '(none)'}`);
    console.log(`        last  paid_at               = ${a.last_paid || '(none)'}`);
    console.log(`        total order value           = ${money(a.value)}`);
    console.log('');

    console.log('[B] EVERY PAID ORDER HAS ITS order_earn LEDGER ROW');
    console.log('    A missing row means the award never completed — NOT that the');
    console.log('    order earned nothing. Zero-point awards still write a row.');
    const [b] = await db.query(
      `SELECT COUNT(*) AS n
         FROM retail_orders o
        WHERE ${POPULATION}
          AND NOT EXISTS (SELECT 1 FROM retail_points_transactions pt
                           WHERE pt.order_id = o.id AND pt.source = 'order_earn')`
    );
    report('no paid order is missing its award', Number(b.n),
      Number(b.n) ? '<-- these customers may be short' : '');
    console.log('');

    // [C] The earn rule is 1 point per `earnSpend` of the earn base, floored,
    // times the customer's tier multiplier. A tier multiplier can only ever
    // RAISE the award, so "total >= threshold but zero points" is a
    // conservative test: everything it flags is wrong at any multiplier, and a
    // sub-threshold order it stays silent about may still be legitimately zero.
    // Deliberately conservative — this check must never cry wolf.
    const threshold = await earnThreshold(db);
    console.log('[C] NO ZERO-POINT ORDER AT OR ABOVE THE EARN THRESHOLD');
    console.log(`    threshold = ${money(threshold)} per point (from storefront_config)`);
    const [c] = await db.query(
      `SELECT COUNT(*) AS n
         FROM retail_orders o
        WHERE ${POPULATION}
          AND COALESCE(o.points_earned, 0) = 0
          AND o.total >= ?`,
      [threshold]
    );
    report('no order earned zero when it should have earned', Number(c.n));
    console.log('');

    console.log('[D] points_earned MATCHES THE LEDGER');
    console.log(`    summed over ${EARN_SOURCES.join(' + ')} — see the header for why`);
    console.log('    order_addon_earn must be included (order 229).');
    const [d] = await db.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT COALESCE(o.points_earned, 0) AS pe,
                (SELECT COALESCE(SUM(pt.delta), 0)
                   FROM retail_points_transactions pt
                  WHERE pt.order_id = o.id AND pt.source IN (${EARN_LIST})) AS earned
           FROM retail_orders o
          WHERE ${POPULATION}
       ) AS cmp
        WHERE cmp.pe <> cmp.earned`
    );
    report('order total and ledger agree', Number(d.n));
    console.log('');

    console.log(failures === 0
      ? 'ALL CHECKS PASSED — no customer is short.'
      : `${failures} CHECK(S) FAILED — investigate before dismissing; see §24.`);
    console.log('');
  } finally {
    await db.close();
  }

  // exitCode rather than exit(): process.exit() can truncate buffered stdout
  // when the output is piped, and this script's whole value is what it printed.
  process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * The spend that earns one point, read from storefront_config rather than
 * hardcoded so an operator changing the rule does not turn this check into a
 * lie. Mirrors pointsEarnedFor(): `points.earnSpend` wins, `points.earnRate` is
 * the legacy fallback, 100 is the default in both.
 */
async function earnThreshold(db) {
  const rows = await db.query(
    `SELECT key, value_json FROM storefront_config
      WHERE key IN ('points.earnSpend', 'points.earnRate')`
  );
  const read = (k) => {
    const row = rows.find((r) => r.key === k);
    if (!row) return null;
    try {
      const v = Number(JSON.parse(row.value_json));
      return v > 0 ? v : null;
    } catch (e) {
      return null;
    }
  };
  return read('points.earnSpend') || read('points.earnRate') || 100;
}

main().catch((e) => {
  console.error('[check_points_invariants]', e && e.message ? e.message : e);
  // 2, not 1: the checks did not run. A caller must not read this as "passed".
  process.exitCode = 2;
});
