#!/usr/bin/env node
// .env is parsed here, before anything reaches for a connection, so a missing
// variable is reported as a missing variable rather than as a data finding.
// Extracted from server.js as lib/load-env.js because .env is NOT shell-
// sourceable -- see that file's header. (This began as GAP G27 of the Postgres
// migration, cancelled 2026-08-23; the loader outlived it and is still right.)
require('../lib/load-env').loadEnv();
//
// check_ledger_invariants.js — the twelve checks that say whether the money
// and points ledgers still agree with the balances they are supposed to
// explain.
//
// WHY THIS EXISTS, AND WHY IT IS NOT check_points_invariants.js
// -------------------------------------------------------------
// check_points_invariants.js answers one question well: did every paid order
// get its award. It compares retail_orders.points_earned against the ledger.
// It never compares the CUSTOMER's balance against the ledger, it never reads
// retail_topup_transactions at all, and the word `balance` does not appear in
// it. So the entire wallet — every ¥ of store credit, every referral payout,
// every commission, every clawback — has no standing check of any kind.
//
// This file is that check. The two are siblings and neither replaces the other:
// that one is scoped to orders, this one to balances.
//
// NOTHING IN THE SCHEMA HOLDS THESE INVARIANTS — READ THIS BEFORE TRUSTING ONE
// ---------------------------------------------------------------------------
// Every invariant below is held by a transaction boundary, not by a constraint.
// Verified against the cluster's own as-built record rather than inferred:
//
//   retail_points_transactions   NO unique constraint of any kind
//   retail_topup_transactions    NO unique constraint of any kind
//   retail_order_addons          none
//   retail_refund_events         none
//
// Only retail_lifetime_commissions(order_id) and retail_referrals(invitee_id)
// are real DB-level guards. In particular retail_topup_transactions.out_trade_no
// carries a PLAIN index on SQLite and NOTHING on Postgres, while five writers
// treat it as an idempotency key — which is why check J exists.
//
// So a break here does not announce itself. It cannot: there is no constraint
// to violate. This file is the only thing that would notice.
//
// THREE KINDS OF RESULT, AND THEY MUST NOT BE READ THE SAME WAY
// -------------------------------------------------------------
//   INVARIANT      (E F G H I J K L N O)  non-zero is a DEFECT. Sets exit 1.
//   RECONCILIATION (M)                    non-zero is EXPECTED. Never exit 1.
//   FORENSIC       (P)                    a measurement, not a verdict.
//
// M and P print their own caveats in the OUTPUT, not just here in a comment,
// because the person who runs this will read the output and not this header.
// A reconciliation reported as a pass/fail is a false alarm with a number
// attached, and the second false alarm is when people stop reading the file.
//
// READ-ONLY, AND ENFORCED RATHER THAN PROMISED
// --------------------------------------------
// Every statement issued is a SELECT. On SQLite the handle is opened with the
// driver's read-only flag, so a write is refused by the driver itself. On
// PostgreSQL the checks run inside a READ ONLY transaction, so a write is
// refused by the server. Neither relies on this file being careful.
//
// RUN IT AGAINST A COPY ANYWAY. Read-only is not the same as zero-impact: a
// long scan against the live file competes with the application for page cache
// and locks. /root/backups/hourly holds a gzipped snapshot taken every hour by
// scripts/db-backup.sh through sqlite3's online .backup API; gunzip one of
// those and point --db at it. There is no reason to touch data/roots.db.
//
// PORTABLE ACROSS THE CUTOVER, BY CONSTRUCTION
// --------------------------------------------
// Same rules as check_points_invariants.js, which this file deliberately
// mirrors so the two stay maintainable together:
//   * string literals are single-quoted — PostgreSQL reads "x" as an IDENTIFIER
//   * every subquery in FROM is aliased — PostgreSQL requires it, SQLite doesn't
//   * no date/time functions at all — only MIN/MAX over the stored column
//   * COUNT(*) is coerced with Number() — node-pg returns bigint as a STRING
//
// And one rule this file adds, because it compares money and that one does not:
//   * NO CAST(x * 100 AS INTEGER) TO GET CENTS. SQLite truncates toward zero on
//     that cast and PostgreSQL rounds half away from zero, so the same data
//     gives two answers. Money is compared with an absolute tolerance instead
//     (MONEY_EPS below), which behaves identically on both engines.
//
// Money is numeric(14,6) on the cluster and REAL on SQLite — the same SCALE on
// both, yuan either way. Nothing here rescales, and nothing here should ever
// start to: see §24 on the *_cents columns, which are a different case.
//
// USAGE
//   node scripts/check_ledger_invariants.js --db /tmp/a-copy-of-roots.db
//   node scripts/check_ledger_invariants.js --db <path> --limit 40
//
// EXIT CODE
//   0  every INVARIANT passed (M and P cannot affect this)
//   1  at least one INVARIANT failed — see the detail block under it
//   2  the checks could not run at all (no driver, no database, bad arguments)

'use strict';

const fs = require('fs');
const path = require('path');

// Half a fen. Below this a difference is float dust in a SQLite REAL column,
// not a customer being short. Named rather than inlined so the threshold is
// one decision in one place, and printed in the output so a reader knows a
// tolerance was applied at all.
const MONEY_EPS = 0.005;

// How many detail rows to print under a failing check before truncating. The
// truncation is always announced — a silently capped list reads as a complete
// one, which is how a 200-row break gets remembered as a 20-row break.
const DEFAULT_LIMIT = 20;

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--pg')) {
  // The Postgres migration was cancelled 2026-08-23 and lib/pg.js is gone.
  // This REFUSES rather than falling back to SQLite: a check that silently
  // answers a different question than the one asked is the failure mode this
  // whole script exists to avoid. See docs/tacet-operating-findings.md.
  console.error('[check_ledger_invariants] --pg is gone. Tacet is on SQLite; there is no Postgres to check.');
  process.exit(2);
}
const dbFlagAt = argv.indexOf('--db');
if (dbFlagAt !== -1 && !argv[dbFlagAt + 1]) {
  console.error('[check_ledger_invariants] --db needs a path argument.');
  process.exit(2);
}
const limitAt = argv.indexOf('--limit');
if (limitAt !== -1 && !argv[limitAt + 1]) {
  console.error('[check_ledger_invariants] --limit needs a number argument.');
  process.exit(2);
}
const LIMIT = limitAt !== -1 ? Math.max(1, parseInt(argv[limitAt + 1], 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
const dbPath = dbFlagAt !== -1
  ? argv[dbFlagAt + 1]
  : path.join(__dirname, '..', 'data', 'roots.db');

// ── Backends ──────────────────────────────────────────────────────────────
// Both expose query(sql, params) -> Promise<rows[]>. Async even on SQLite,
// because that was the contract pg would have needed and §24's point is that call
// sites should not change shape at the cutover.

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
    console.error(`[check_ledger_invariants] no database at ${file}`);
    console.error('  Pass --db <path> to a COPY.');
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
      console.error('[check_ledger_invariants] no usable SQLite driver.');
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

// ── THE CHECKS ────────────────────────────────────────────────────────────
// Each carries: a count query returning a single column `n`, and a detail
// query returning the rows behind that count so a non-zero result can be
// triaged without writing SQL by hand. `kind` decides how the result is read
// and whether it can set the exit code.
//
// `notes` are printed in the OUTPUT, under the result, every time. For M and P
// they are load-bearing: they are the difference between a number that means
// something and a number that gets misread.

const CHECKS = [

  { id: 'E', kind: 'invariant',
    title: 'the points ledger sums to points_balance',
    blurb: 'Per customer: SUM(delta) over every points row must equal the stored balance.',
    notes: [
      'This is the check check_points_invariants.js does not make. Six writers move',
      'points_balance and each writes a row; no constraint ties the two together.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT c.id AS cid,
               COALESCE(c.points_balance, 0) AS bal,
               (SELECT COALESCE(SUM(pt.delta), 0)
                  FROM retail_points_transactions pt
                 WHERE pt.customer_id = c.id) AS led
          FROM retail_customers c
      ) AS cmp
       WHERE cmp.bal <> cmp.led`,
    detail: `
      SELECT cmp.cid AS customer_id, cmp.bal AS points_balance, cmp.led AS ledger_sum,
             (cmp.bal - cmp.led) AS drift, cmp.rows AS ledger_rows,
             cmp.first_row, cmp.last_row
        FROM (
        SELECT c.id AS cid,
               COALESCE(c.points_balance, 0) AS bal,
               (SELECT COALESCE(SUM(pt.delta), 0)
                  FROM retail_points_transactions pt
                 WHERE pt.customer_id = c.id) AS led,
               (SELECT COUNT(*) FROM retail_points_transactions pt
                 WHERE pt.customer_id = c.id) AS rows,
               (SELECT MIN(pt.created_at) FROM retail_points_transactions pt
                 WHERE pt.customer_id = c.id) AS first_row,
               (SELECT MAX(pt.created_at) FROM retail_points_transactions pt
                 WHERE pt.customer_id = c.id) AS last_row
          FROM retail_customers c
      ) AS cmp
       WHERE cmp.bal <> cmp.led
       ORDER BY cmp.last_row` },

  { id: 'F', kind: 'invariant',
    title: 'the wallet ledger sums to balance',
    blurb: `Per customer: SUM(amount) over successful topup rows must equal the stored balance, within ¥${MONEY_EPS}.`,
    notes: [
      'The first standing check of any kind on the wallet. Every ¥ of store credit',
      'moves through retail_topup_transactions — top-ups, order spend, referral',
      'payouts, commissions, clawbacks, refunds — and balance is the running total.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT c.id AS cid,
               COALESCE(c.balance, 0) AS bal,
               (SELECT COALESCE(SUM(tt.amount), 0)
                  FROM retail_topup_transactions tt
                 WHERE tt.customer_id = c.id AND tt.status = 'success') AS led
          FROM retail_customers c
      ) AS cmp
       WHERE ABS(cmp.bal - cmp.led) > ?`,
    countParams: [MONEY_EPS],
    detail: `
      SELECT cmp.cid AS customer_id, cmp.bal AS balance, cmp.led AS ledger_sum,
             (cmp.bal - cmp.led) AS drift, cmp.rows AS ledger_rows,
             cmp.first_row, cmp.last_row
        FROM (
        SELECT c.id AS cid,
               COALESCE(c.balance, 0) AS bal,
               (SELECT COALESCE(SUM(tt.amount), 0)
                  FROM retail_topup_transactions tt
                 WHERE tt.customer_id = c.id AND tt.status = 'success') AS led,
               (SELECT COUNT(*) FROM retail_topup_transactions tt
                 WHERE tt.customer_id = c.id AND tt.status = 'success') AS rows,
               (SELECT MIN(tt.created_at) FROM retail_topup_transactions tt
                 WHERE tt.customer_id = c.id AND tt.status = 'success') AS first_row,
               (SELECT MAX(tt.created_at) FROM retail_topup_transactions tt
                 WHERE tt.customer_id = c.id AND tt.status = 'success') AS last_row
          FROM retail_customers c
      ) AS cmp
       WHERE ABS(cmp.bal - cmp.led) > ?
       ORDER BY cmp.last_row`,
    detailParams: [MONEY_EPS] },

  { id: 'G', kind: 'invariant',
    title: 'balance_after matches the running ledger sum',
    blurb: 'Each points row stamps the balance it left behind; it must equal the sum of every delta up to it.',
    notes: [
      'balance_after is read INSIDE the writing transaction. Under one writer that',
      'is the truth. Under two it is the truth FOR THAT ROW\'S POSITION, and the',
      'stamp order and the row order can diverge with nothing erroring anywhere.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT pt.id AS rid,
               pt.balance_after AS stamped,
               (SELECT COALESCE(SUM(p2.delta), 0)
                  FROM retail_points_transactions p2
                 WHERE p2.customer_id = pt.customer_id AND p2.id <= pt.id) AS running
          FROM retail_points_transactions pt
      ) AS cmp
       WHERE cmp.stamped <> cmp.running`,
    detail: `
      SELECT cmp.rid AS ledger_row, cmp.cid AS customer_id, cmp.source, cmp.delta,
             cmp.stamped AS balance_after, cmp.running AS should_be,
             (cmp.stamped - cmp.running) AS drift, cmp.created_at
        FROM (
        SELECT pt.id AS rid, pt.customer_id AS cid, pt.source, pt.delta,
               pt.created_at,
               pt.balance_after AS stamped,
               (SELECT COALESCE(SUM(p2.delta), 0)
                  FROM retail_points_transactions p2
                 WHERE p2.customer_id = pt.customer_id AND p2.id <= pt.id) AS running
          FROM retail_points_transactions pt
      ) AS cmp
       WHERE cmp.stamped <> cmp.running
       ORDER BY cmp.created_at` },

  { id: 'H', kind: 'invariant',
    title: 'no customer balance is negative',
    blurb: 'Neither points_balance nor balance may be below zero.',
    notes: [
      'Every clawback path clamps at the available balance and says so in a comment.',
      'A negative value means a clamp was skipped or a reversal outran its credit.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM retail_customers c
       WHERE COALESCE(c.points_balance, 0) < 0 OR COALESCE(c.balance, 0) < 0`,
    detail: `
      SELECT c.id AS customer_id, c.balance, c.points_balance, c.lifetime_spend,
             c.tier_key, c.created_at
        FROM retail_customers c
       WHERE COALESCE(c.points_balance, 0) < 0 OR COALESCE(c.balance, 0) < 0
       ORDER BY c.id` },

  { id: 'I', kind: 'invariant',
    title: 'no ledger row is orphaned from its customer',
    blurb: 'A points or topup row whose customer_id matches no customer.',
    notes: [
      'This is exactly the condition fix_orphan_customer_fks_v1 DELETED at boot on',
      '2026-06-09. Non-zero here means NEW orphans have appeared since — the',
      'hardened FK is not holding, and that is a LIVE path, not history.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT pt.id AS rid FROM retail_points_transactions pt
         WHERE NOT EXISTS (SELECT 1 FROM retail_customers c WHERE c.id = pt.customer_id)
        UNION ALL
        SELECT tt.id AS rid FROM retail_topup_transactions tt
         WHERE NOT EXISTS (SELECT 1 FROM retail_customers c WHERE c.id = tt.customer_id)
      ) AS orphans`,
    detail: `
      SELECT 'retail_points_transactions' AS ledger, pt.id AS row_id,
             pt.customer_id, pt.source AS kind, pt.delta AS amount, pt.created_at
        FROM retail_points_transactions pt
       WHERE NOT EXISTS (SELECT 1 FROM retail_customers c WHERE c.id = pt.customer_id)
      UNION ALL
      SELECT 'retail_topup_transactions' AS ledger, tt.id AS row_id,
             tt.customer_id, tt.payment_method AS kind, tt.amount, tt.created_at
        FROM retail_topup_transactions tt
       WHERE NOT EXISTS (SELECT 1 FROM retail_customers c WHERE c.id = tt.customer_id)
       ORDER BY 6` },

  { id: 'J', kind: 'invariant',
    title: 'no out_trade_no is used twice in the wallet ledger',
    blurb: 'Duplicate out_trade_no in retail_topup_transactions.',
    notes: [
      'FIVE writers key idempotency on this column — creditWallet, debitWallet,',
      'creditLifetimeCommission, reverseLifetimeCommission, reverseOrderBalance.',
      'It carries a PLAIN index on SQLite and NO constraint on the cluster, so a',
      'duplicate is possible and each one is a double credit or a double clawback.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT tt.out_trade_no AS otn
          FROM retail_topup_transactions tt
         WHERE tt.out_trade_no IS NOT NULL
         GROUP BY tt.out_trade_no
        HAVING COUNT(*) > 1
      ) AS dupes`,
    detail: `
      SELECT tt.out_trade_no, COUNT(*) AS times, SUM(tt.amount) AS total_amount,
             MIN(tt.customer_id) AS customer_id, MIN(tt.payment_method) AS method,
             MIN(tt.created_at) AS first_seen, MAX(tt.created_at) AS last_seen
        FROM retail_topup_transactions tt
       WHERE tt.out_trade_no IS NOT NULL
       GROUP BY tt.out_trade_no
      HAVING COUNT(*) > 1
       ORDER BY MAX(tt.created_at)` },

  { id: 'K', kind: 'invariant',
    title: 'every lifetime commission has its wallet ledger row',
    blurb: 'A commission row with money on it must have the matching credit in the wallet ledger.',
    notes: [
      'creditLifetimeCommission writes the commission row and the wallet row in one',
      'transaction. A commission with no ledger row is a half-committed transaction —',
      'the only way this can go non-zero.',
    ],
    count: `
      SELECT COUNT(*) AS n
        FROM retail_lifetime_commissions lc
       WHERE lc.commission_amount > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_topup_transactions tt
            WHERE tt.customer_id = lc.referrer_id
              AND tt.payment_method = 'lifetime_commission'
              AND tt.out_trade_no = 'lifetime:' || lc.order_id)`,
    detail: `
      SELECT lc.id AS commission_row, lc.order_id, lc.referrer_id AS customer_id,
             lc.commission_amount, lc.rate_percent, lc.reversed_at, lc.created_at
        FROM retail_lifetime_commissions lc
       WHERE lc.commission_amount > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_topup_transactions tt
            WHERE tt.customer_id = lc.referrer_id
              AND tt.payment_method = 'lifetime_commission'
              AND tt.out_trade_no = 'lifetime:' || lc.order_id)
       ORDER BY lc.created_at` },

  { id: 'L', kind: 'invariant',
    title: 'every paid-out referral has its reward ledger row',
    blurb: "A referral flipped to 'ordered' with a reward on it must have the matching wallet credit.",
    notes: [
      'The status flip and the wallet credit happen in one transaction in',
      'creditReferralReward. They must agree.',
    ],
    count: `
      SELECT COUNT(*) AS n
        FROM retail_referrals r
       WHERE r.status = 'ordered' AND r.reward_amount > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_topup_transactions tt
            WHERE tt.customer_id = r.referrer_id
              AND tt.payment_method = 'referral_reward'
              AND tt.out_trade_no = 'referral:' || r.id || ':' || r.first_paid_order_id)`,
    detail: `
      SELECT r.id AS referral_row, r.referrer_id AS customer_id, r.invitee_id,
             r.reward_amount, r.referee_reward_amount, r.first_paid_order_id,
             r.rewarded_at, r.joined_at
        FROM retail_referrals r
       WHERE r.status = 'ordered' AND r.reward_amount > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_topup_transactions tt
            WHERE tt.customer_id = r.referrer_id
              AND tt.payment_method = 'referral_reward'
              AND tt.out_trade_no = 'referral:' || r.id || ':' || r.first_paid_order_id)
       ORDER BY r.rewarded_at` },

  { id: 'M', kind: 'reconciliation',
    title: 'lifetime_spend against the boot migration formula',
    blurb: 'Compares lifetime_spend to SUM(subtotal) over non-cancelled / non-refunded / non-pending orders.',
    notes: [
      'NOT A PASS/FAIL, AND A NON-ZERO RESULT IS EXPECTED. This number cannot set',
      'the exit code. backfill_lifetime_spend_v1 set lifetime_spend ONCE from this',
      'formula; every writer since moves it by DELTAS, and three of them legitimately',
      'diverge from it:',
      '',
      '  1. finalizeOrderAddon bumps lifetime_spend by the GATEWAY CHARGE (a.amount)',
      '     while also bumping the order subtotal by the items value. When freed',
      '     shipping nets off the charge those two are different numbers, so stored',
      '     runs BELOW derived by the netted amount. Legitimate.',
      '  2. reverseOrderPoints clamps with MAX(0, lifetime_spend - spend). The clamp',
      '     is LOSSY AND PERMANENT — spend below zero is discarded, not carried — so',
      '     a customer refunded past zero stays below derived forever. Legitimate.',
      '  3. The formula counts every order not cancelled / refunded / pending, which',
      '     includes awaiting_restock orders. awardOrderPoints has not credited those',
      '     yet, so stored runs BELOW derived until the restock promotes them.',
      '     Legitimate, and it resolves on its own.',
      '  4. A PAID order CANCELLED with no gateway refund reversed nothing — the',
      '     status handler called none of the six reversal helpers on that branch.',
      '     awardOrderPoints added the subtotal at payment, nothing took it back, and',
      '     the formula excludes cancelled orders. NOT LEGITIMATE — a defect (status',
      '     doc item 44), and the only reason on this list that puts stored ABOVE',
      '     derived.',
      '',
      '     *** FIXED AND DEPLOYED 2026-08-17 (f4a689e4). ***  The five reversals are',
      '     hoisted out of the gateway-refund branch and now run for every paid',
      '     cancel. Reason 4 NO LONGER ACCRUES. It is kept on this list, not deleted,',
      '     because the 20 orders it already produced are still in the data and are',
      '     still the explanation for customer 233 — a drift that predates the fix',
      '     needs the reason that caused it. A positive drift on an order cancelled',
      '     AFTER 2026-08-17 is something new and is not this.',
      '',
      'READ IT AS A LIST TO EXPLAIN, NOT A FAILURE TO FIX. Reasons 1-3 are legitimate',
      'and permanent; reason 4 was a defect and is now closed. A positive drift is',
      'still worth chasing and a negative one usually is not.',
      '',
      'CORRECTED 2026-08-13. This note shipped saying stored could never run ABOVE',
      'derived. That was true of reasons 1-3 and wrong as a general claim: the first',
      'live run found customer 233 at +899.00, which is reason 4 to the fen across 20',
      'orders. Recorded rather than quietly edited, because a diagnostic that asserted',
      'something impossible and then met it is exactly the failure this file warns',
      'about elsewhere — a comment that answers for the code.',
      '',
      '*** CUSTOMER 233 IS THE TESTER ACCOUNT. DO NOT CHASE IT AS AN INCIDENT. ***',
      'Identified 2026-08-13 by openid, not by the name on the row. 233 carries',
      'openid oeqDi5KI8Mex…, and the two _reset_-archived rows left behind by',
      '/api/retail-admin/customers/:id/reset-test — customers 57 and 64 — carry',
      '_reset_<ts>_oeqDi5KI8… . Same WeChat identity, three incarnations, 233 being',
      'the live one (created 2026-06-15, the day after 64 was archived).',
      '',
      'Its order mix says the same thing: 63 CANCELLED, 4 delivered, 2 refunded. The',
      'formula figure of 780.00 is exactly the 4 delivered, and the +899.00 drift is',
      'the paid-then-cancelled QA churn that reason 4 never reversed.',
      '',
      'READ THIS PRECISELY, BECAUSE IT IS TWO CLAIMS AND ONLY ONE OF THEM IS',
      'REASSURING. The ACCOUNT is test data, so nobody is owed anything and no',
      'customer is in a tier they did not earn. The DEFECT is real code on a live',
      'path open to everyone — reason 4 above, status doc item 44 — and it stays',
      'open. A tester found it first because a tester cancels sixty-three orders and',
      'a customer cancels one; that is a statement about who exercises the path,',
      'not about whether the path is broken.',
      '',
      'The OTHER row this check returns is not the tester. 839 carries a different',
      'openid stem and a −15.00 drift, which is one of reasons 1-3 and legitimate.',
      '',
      'RE-MEASURED 2026-08-17, ACROSS EVERY CANCELLED ORDER IN THE DATABASE, AND THE',
      'ANSWER IS THE SAME ONE: reason 4 produced 20 orders, and ALL TWENTY BELONG TO',
      '233. REAL CUSTOMERS AFFECTED: ZERO. Established by openid rather than by the',
      'name on the row — a customer counts as a tester incarnation when some',
      '_reset_-archived openid ENDS WITH theirs, which is the shape',
      '/customers/:id/reset-test writes. Nobody is owed anything and no tier is wrong,',
      'so 233 is left as it stands. Do not re-open it as a customer incident.',
      '',
      'ONE FIGURE IN THE 08-13 RECORD WAS WRONG WHEN WRITTEN, AND IS CORRECTED HERE',
      'RATHER THAN QUIETLY: the ¥38.80 of wallet balance on order 324 was reported as',
      'never returned. It read the order_redeem spend row and did not net off the two',
      'refund_reverse rows beside it (¥23.11 + ¥15.20), both stamped BEFORE the',
      'cancel. The outstanding figure is ¥0.49. The ¥899.00 re-measured identically.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT c.id AS cid,
               COALESCE(c.lifetime_spend, 0) AS stored,
               (SELECT COALESCE(SUM(o.subtotal), 0)
                  FROM retail_orders o
                 WHERE o.customer_id = c.id
                   AND o.status NOT IN ('cancelled', 'refunded', 'pending_payment')) AS derived
          FROM retail_customers c
      ) AS cmp
       WHERE ABS(cmp.stored - cmp.derived) > ?`,
    countParams: [MONEY_EPS],
    detail: `
      SELECT cmp.cid AS customer_id, cmp.stored AS lifetime_spend,
             cmp.derived AS formula_says, (cmp.stored - cmp.derived) AS drift,
             cmp.tier_key, cmp.orders AS counted_orders, cmp.last_order
        FROM (
        SELECT c.id AS cid, c.tier_key,
               COALESCE(c.lifetime_spend, 0) AS stored,
               (SELECT COALESCE(SUM(o.subtotal), 0)
                  FROM retail_orders o
                 WHERE o.customer_id = c.id
                   AND o.status NOT IN ('cancelled', 'refunded', 'pending_payment')) AS derived,
               (SELECT COUNT(*) FROM retail_orders o
                 WHERE o.customer_id = c.id
                   AND o.status NOT IN ('cancelled', 'refunded', 'pending_payment')) AS orders,
               (SELECT MAX(o.placed_at) FROM retail_orders o
                 WHERE o.customer_id = c.id) AS last_order
          FROM retail_customers c
      ) AS cmp
       WHERE ABS(cmp.stored - cmp.derived) > ?
       ORDER BY (cmp.stored - cmp.derived) DESC`,
    detailParams: [MONEY_EPS],
    alwaysDetail: true },

  { id: 'N', kind: 'invariant',
    title: 'every settled add-on has its order_addon_earn row',
    blurb: "A retail_order_addons row at status='success' carrying earn_points must have its ledger row.",
    notes: [
      'finalizeOrderAddon claims the add-on row and writes the earn ledger row in',
      'the same transaction. A settled add-on with no earn row is a half-commit.',
    ],
    count: `
      SELECT COUNT(*) AS n
        FROM retail_order_addons a
       WHERE a.status = 'success' AND a.earn_points > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_points_transactions pt
            WHERE pt.order_id = a.order_id AND pt.source = 'order_addon_earn')`,
    detail: `
      SELECT a.id AS addon_row, a.order_id, a.customer_id, a.amount,
             a.earn_points, a.paid_at, a.created_at
        FROM retail_order_addons a
       WHERE a.status = 'success' AND a.earn_points > 0
         AND NOT EXISTS (
           SELECT 1 FROM retail_points_transactions pt
            WHERE pt.order_id = a.order_id AND pt.source = 'order_addon_earn')
       ORDER BY a.paid_at` },

  { id: 'O', kind: 'invariant',
    title: 'every swept earn batch has its expiry ledger row',
    blurb: 'A customer with earn rows marked expired_at must have at least one expiry row.',
    notes: [
      'sweepExpiredPoints marks the earn row AND writes the negative expiry row in',
      'one transaction — but only when take > 0, so a batch clamped to zero',
      'legitimately marks without writing. Scoped to the customer rather than the',
      'row for exactly that reason: it asks whether the sweep wrote ANYTHING.',
    ],
    count: `
      SELECT COUNT(*) AS n FROM (
        SELECT pt.customer_id AS cid,
               (SELECT COUNT(*) FROM retail_points_transactions x
                 WHERE x.customer_id = pt.customer_id AND x.source = 'expiry') AS expiries
          FROM retail_points_transactions pt
         WHERE pt.expired_at IS NOT NULL
         GROUP BY pt.customer_id
      ) AS cmp
       WHERE cmp.expiries = 0`,
    detail: `
      SELECT cmp.cid AS customer_id, cmp.marked AS batches_marked_swept,
             cmp.first_sweep, cmp.last_sweep
        FROM (
        SELECT pt.customer_id AS cid, COUNT(*) AS marked,
               MIN(pt.expired_at) AS first_sweep, MAX(pt.expired_at) AS last_sweep,
               (SELECT COUNT(*) FROM retail_points_transactions x
                 WHERE x.customer_id = pt.customer_id AND x.source = 'expiry') AS expiries
          FROM retail_points_transactions pt
         WHERE pt.expired_at IS NOT NULL
         GROUP BY pt.customer_id
      ) AS cmp
       WHERE cmp.expiries = 0
       ORDER BY cmp.last_sweep` },

  { id: 'P', kind: 'forensic',
    title: 'id gaps in the two ledgers only one migration ever deleted from',
    blurb: 'MAX(id) - MIN(id) + 1 - COUNT(*) over retail_points_transactions.',
    notes: [
      'A MEASUREMENT, NOT A VERDICT, and it cannot set the exit code.',
      '',
      'DELETE FROM retail_points_transactions and DELETE FROM retail_topup_transactions',
      'appear in EXACTLY ONE place in the whole tree — the boot migration',
      'fix_orphan_customer_fks_v1 in database.js, which ran once on 2026-06-09 and',
      'purged rows whose customer no longer existed. So a gap in the id sequence is',
      'attributable to THAT MIGRATION ALONE and to nothing else.',
      '',
      'IT IS AN UPPER BOUND, NOT A COUNT. A gap can also come from a rolled-back',
      'INSERT — SQLite AUTOINCREMENT and Postgres sequences both burn the id either',
      'way — so the true number deleted is AT MOST this figure and may be far less.',
      '',
      'This exists because the migration used db.exec(), which returns no change',
      'count, and logged only "orphan customer FKs repaired". The exact number of',
      'ledger rows it deleted was never recorded and cannot be recovered. This is',
      'the closest thing to it that still exists.',
      '',
      'retail_customer_vouchers is deliberately NOT measured this way: it has three',
      'other deleters (reconcileSignupVouchers and both branches of the admin',
      'grant-delete route), so a gap there is not attributable to anything.',
    ],
    count: `
      SELECT (MAX(pt.id) - MIN(pt.id) + 1 - COUNT(*)) AS n
        FROM retail_points_transactions pt`,
    detail: `
      SELECT MIN(pt.id) AS lowest_id, MAX(pt.id) AS highest_id, COUNT(*) AS rows_present,
             (MAX(pt.id) - MIN(pt.id) + 1 - COUNT(*)) AS ids_missing,
             MIN(pt.created_at) AS oldest_row, MAX(pt.created_at) AS newest_row
        FROM retail_points_transactions pt`,
    alwaysDetail: true },
];

// ── Output ────────────────────────────────────────────────────────────────
let failures = 0;
const results = [];

const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

function printRows(rows, limit) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  const widths = cols.map((c) => Math.max(c.length,
    ...shown.map((r) => String(r[c] === null || r[c] === undefined ? '' : r[c]).length)));
  console.log('        ' + cols.map((c, i) => pad(c, widths[i])).join('  '));
  console.log('        ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of shown) {
    console.log('        ' + cols.map((c, i) => pad(r[c], widths[i])).join('  '));
  }
  if (rows.length > shown.length) {
    // Announced, never silent. A capped list that does not say it was capped
    // reads as the whole population.
    console.log(`        … ${rows.length - shown.length} more row(s) not shown — re-run with --limit ${rows.length}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = openSqlite(dbPath);

  console.log('');
  console.log('LEDGER INVARIANTS');
  console.log(`  backend:         ${db.name}`);
  console.log(`  money tolerance: ¥${MONEY_EPS} (half a fen — below this is float dust, not a shortfall)`);
  console.log('');
  console.log('  INVARIANT      non-zero is a DEFECT and sets the exit code');
  console.log('  RECONCILIATION non-zero is EXPECTED — read the notes, not the number');
  console.log('  FORENSIC       a measurement, not a verdict');
  console.log('');

  try {
    // Context first, so every number below is scoped and a shrinking population
    // is visible rather than silently covering less than it used to.
    const [ctx] = await db.query(
      `SELECT (SELECT COUNT(*) FROM retail_customers) AS customers,
              (SELECT COUNT(*) FROM retail_points_transactions) AS points_rows,
              (SELECT COUNT(*) FROM retail_topup_transactions) AS topup_rows,
              (SELECT COUNT(*) FROM retail_orders) AS orders`
    );
    const [span] = await db.query(
      `SELECT MIN(pt.created_at) AS first_ledger_row, MAX(pt.created_at) AS last_ledger_row
         FROM retail_points_transactions pt`
    );
    console.log('[CONTEXT] population these checks are scoped to');
    console.log(`        customers        = ${Number(ctx.customers)}`);
    console.log(`        points rows      = ${Number(ctx.points_rows)}`);
    console.log(`        topup rows       = ${Number(ctx.topup_rows)}`);
    console.log(`        orders           = ${Number(ctx.orders)}`);
    console.log(`        ledger spans     = ${span.first_ledger_row || '(none)'}  ..  ${span.last_ledger_row || '(none)'}`);
    console.log('');

    for (const c of CHECKS) {
      const [row] = await db.query(c.count, c.countParams || []);
      const n = Number(row.n || 0);
      const isInvariant = c.kind === 'invariant';
      if (isInvariant && n !== 0) failures++;
      results.push({ id: c.id, kind: c.kind, title: c.title, n });

      const verdict = isInvariant ? (n === 0 ? 'PASS' : 'FAIL') : (c.kind === 'reconciliation' ? 'INFO' : 'MEAS');
      console.log(`[${c.id}] ${c.title.toUpperCase()}`);
      console.log(`     ${c.blurb}`);
      console.log(`  ${verdict}  count = ${n}   (${c.kind})`);
      for (const line of c.notes) console.log(`        ${line}`);

      if (n !== 0 || c.alwaysDetail) {
        const rows = await db.query(c.detail, c.detailParams || []);
        if (rows.length) {
          console.log('');
          printRows(rows, LIMIT);
        }
      }
      console.log('');
    }

    // ── Verdict ──
    const inv = results.filter((r) => r.kind === 'invariant');
    const bad = inv.filter((r) => r.n !== 0);
    console.log('─'.repeat(72));
    if (!bad.length) {
      console.log(`ALL ${inv.length} INVARIANTS PASSED — every balance is explained by its ledger.`);
    } else {
      console.log(`${bad.length} OF ${inv.length} INVARIANTS FAILED: ${bad.map((r) => r.id).join(', ')}`);
      console.log('Investigate before dismissing. Read the detail block under each one:');
      console.log('  I non-zero  -> NEW orphans since 2026-06-09; the hardened FK is not holding, a LIVE path');
      console.log('  I zero, P non-zero -> the gap is historical and belongs to fix_orphan_customer_fks_v1');
      console.log('  age is the discriminator: a break dated June is the migration, last week is a live path');
    }
    const recon = results.find((r) => r.id === 'M');
    const forensic = results.find((r) => r.id === 'P');
    console.log(`M (reconciliation) = ${recon ? recon.n : '?'} — expected to be non-zero; not a defect, see its notes.`);
    console.log(`P (forensic)       = ${forensic ? forensic.n : '?'} — an upper bound on fix_orphan_customer_fks_v1's deletes.`);
    console.log('─'.repeat(72));
    console.log('');
  } finally {
    await db.close();
  }

  // exitCode rather than exit(): process.exit() can truncate buffered stdout
  // when the output is piped, and this script's whole value is what it printed.
  process.exitCode = failures === 0 ? 0 : 1;
}

module.exports = { CHECKS, MONEY_EPS };

if (require.main === module) {
  main().catch((e) => {
    console.error('[check_ledger_invariants]', e && e.message ? e.message : e);
    // 2, not 1: the checks did not run. A caller must not read this as "passed".
    process.exitCode = 2;
  });
}
