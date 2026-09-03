#!/usr/bin/env node
/**
 * diagnose_affiliate_figures.js — read the live affiliate programme's numbers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mobile Home recap now carries two affiliate lines (PR #223 / #224): a
 * "(N via affiliate)" count on the paid-orders line, and a "¥N affiliate
 * commission" line of its own. Both are fed from tables no session working in a
 * build container can read — the live database is on the box, and this repo's
 * remote sessions have no SSH to it.
 *
 * So the question the recap raises — will either line ever have anything to
 * show on this shop — has been unanswerable from the code alone. It needs four
 * facts off the live database:
 *
 *   1. the stored affiliate settings, chiefly affiliate.lifetimeRatePercent,
 *      which is the on/off switch for the ongoing revenue share
 *      (creditLifetimeCommission returns early unless it is > 0)
 *   2. retail_referrals by status — how many one-shot bounties exist and how
 *      many actually rewarded
 *   3. retail_lifetime_commissions, and how many are reversed
 *   4. the affiliate rows in the wallet ledger, by payment_method
 *
 * WHAT IT DOES
 * ------------
 * Opens the live database read-only, PROVES read-only by attempting a write and
 * aborting if the write is accepted, and prints the four result sets raw.
 *
 * It writes nothing, restarts nothing, and touches no pm2 process. It reads the
 * MAIN database only (data/roots.db): Roots runs on the main DB —
 * data/tenants/1.db is absent by design and 2-7.db are dead residue, so this
 * never opens anything under data/tenants/.
 *
 * TWO DEVIATIONS FROM THE QUERIES AS HANDED OVER, both recorded here so the
 * output is not mistaken for something it is not:
 *
 *   - Query 1 was written `SELECT key, value FROM storefront_config`. That
 *     column is named `value_json` (database.js:1706); `value` does not exist
 *     and the query would abort. The column is resolved from table_info at run
 *     time and the name actually used is printed, rather than this file
 *     hard-coding a guess about the live schema.
 *
 *   - Query 4's method list omits 'lifetime_commission_clawback', the sixth
 *     affiliate payment_method (routes/retail.js, reverseLifetimeCommission).
 *     The query is run EXACTLY as handed over, and the missing method is then
 *     reported separately as query 5 so a reversal that exists cannot go unseen
 *     because of a five-item list. Neither result is edited.
 *
 * Run: node scripts/diagnose_affiliate_figures.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

if (!fs.existsSync(DB_PATH)) { console.error('FATAL: no database at ' + DB_PATH); process.exit(2); }

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }
console.log('db: ' + DB_PATH);

// Print a result set as-is. No rounding, no relabelling, no omissions — the
// column names are whatever the query returned and the values are printed
// exactly as SQLite handed them over, NULL included.
function show(rows) {
  if (!rows.length) { console.log('  (no rows)'); return; }
  for (const r of rows) {
    console.log('  ' + Object.entries(r)
      .map(([k, v]) => k + '=' + (v === null ? 'NULL' : String(v)))
      .join('  '));
  }
  console.log('  (' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ')');
}

// Run one query, surviving a missing table so a later section still reports.
function section(title, sql, params) {
  console.log('\n=== ' + title + ' ===');
  console.log(sql.trim().replace(/\n\s+/g, '\n  '));
  try { show(db.prepare(sql).all(...(params || []))); }
  catch (e) { console.log('  ERROR: ' + e.message); }
}

// ── 1. affiliate settings ───────────────────────────────────────────────────
// Resolve the value column off the live schema rather than assuming it.
let valueCol = null;
try {
  const cols = db.pragma('table_info(storefront_config)').map(c => c.name);
  valueCol = cols.includes('value_json') ? 'value_json' : (cols.includes('value') ? 'value' : null);
  console.log('\nstorefront_config columns: ' + cols.join(', '));
} catch (e) { console.log('\nstorefront_config: ' + e.message); }

if (valueCol) {
  section('1. storefront_config LIKE %affiliate%',
    `SELECT key, ${valueCol} FROM storefront_config WHERE key LIKE '%affiliate%' ORDER BY key`);
  // features.affiliate is the programme's single on/off switch and does not
  // match '%affiliate%' on its own prefix search above in every ordering, so it
  // is read explicitly too. Printed raw; absent means the default applies.
  section("1b. features.affiliate and affiliate.* read explicitly",
    `SELECT key, ${valueCol} FROM storefront_config
      WHERE key IN ('features.affiliate','affiliate.lifetimeRatePercent',
                    'affiliate.lifetimeMonths','affiliate.lifetimeMode',
                    'affiliate.rewardPerOrder','affiliate.rewardReferee',
                    'affiliate.codePrefix')
      ORDER BY key`);
} else {
  console.log('\n=== 1. storefront_config ===\n  ERROR: no value/value_json column found');
}

// ── 2. referrals by status ──────────────────────────────────────────────────
section('2. retail_referrals by status',
  `SELECT status, COUNT(*) AS n, MIN(joined_at) AS min_joined, MAX(joined_at) AS max_joined
     FROM retail_referrals GROUP BY status`);

// rewarded_at is what the recap's commission line actually reads, so its range
// is reported alongside the joined_at range the handover asked for.
section('2b. retail_referrals rewarded_at range (what the recap line reads)',
  `SELECT status, COUNT(*) AS n,
          SUM(rewarded_at IS NOT NULL) AS with_rewarded_at,
          MIN(rewarded_at) AS min_rewarded, MAX(rewarded_at) AS max_rewarded
     FROM retail_referrals GROUP BY status`);

// ── 3. lifetime commissions ─────────────────────────────────────────────────
section('3. retail_lifetime_commissions',
  `SELECT COUNT(*) AS total, SUM(reversed_at IS NOT NULL) AS reversed,
          MIN(created_at) AS min_created, MAX(created_at) AS max_created
     FROM retail_lifetime_commissions`);

// ── 4. wallet ledger, affiliate methods ─────────────────────────────────────
// EXACTLY the five-method list as handed over.
section('4. retail_topup_transactions by payment_method (list as handed over, 5 methods)',
  `SELECT payment_method, COUNT(*) AS n, ROUND(SUM(amount),2) AS total
     FROM retail_topup_transactions
    WHERE payment_method IN ('referral_reward','referral_welcome','lifetime_commission',
                             'referral_clawback','referral_welcome_clawback')
    GROUP BY payment_method`);

// The sixth affiliate method, reported separately so it cannot go unseen.
section('5. the sixth affiliate method, omitted from the list above',
  `SELECT payment_method, COUNT(*) AS n, ROUND(SUM(amount),2) AS total
     FROM retail_topup_transactions
    WHERE payment_method = 'lifetime_commission_clawback'
    GROUP BY payment_method`);

// Every distinct payment_method in the ledger, so the affiliate rows can be
// read against what else lives in this table.
section('6. every payment_method in the wallet ledger',
  `SELECT payment_method, COUNT(*) AS n, ROUND(SUM(amount),2) AS total,
          MIN(paid_at) AS min_paid, MAX(paid_at) AS max_paid
     FROM retail_topup_transactions
    GROUP BY payment_method ORDER BY n DESC`);

// ── 7-10: WHO can earn the ongoing share ────────────────────────────────────
// Added after run #82 showed retail_lifetime_commissions empty while the rate
// was set to 8%. The rate is only half the question: the programme runs in
// "selected" mode, where creditLifetimeCommission pays only a referrer flagged
// lifetime_eligible = 1 AND carrying a lifetime_eligible_since at or before the
// order's paid_at. An empty eligible set pays nobody at any rate, so the count
// below decides whether the fix shipped in #226 can ever move a number.

section('7. customers flagged lifetime_eligible = 1',
  `SELECT COUNT(*) AS eligible,
          MIN(lifetime_eligible_since) AS min_since,
          MAX(lifetime_eligible_since) AS max_since,
          SUM(lifetime_eligible_since IS NOT NULL) AS with_since,
          SUM(referral_code IS NOT NULL AND referral_code <> '') AS with_referral_code
     FROM retail_customers
    WHERE lifetime_eligible = 1`);

section('8. customers carrying a referrer (referred_by_customer_id NOT NULL)',
  `SELECT COUNT(*) AS referred FROM retail_customers
    WHERE referred_by_customer_id IS NOT NULL`);

// The status='ordered' rows are the referrals that actually paid a bounty. Each
// one names a referrer; this is the split of those referrers by whether they
// carry the flag that lets them earn anything further.
section("9. status='ordered' referrals, split by whether the REFERRER is lifetime_eligible",
  `SELECT COALESCE(c.lifetime_eligible, 0) AS referrer_lifetime_eligible,
          COUNT(*) AS n,
          COUNT(DISTINCT r.referrer_id) AS distinct_referrers
     FROM retail_referrals r
     LEFT JOIN retail_customers c ON c.id = r.referrer_id
    WHERE r.status = 'ordered'
    GROUP BY COALESCE(c.lifetime_eligible, 0)`);

// Row-by-row, since there are only a handful and the split alone hides which
// referrer is which (one referrer may hold several of these).
section("9b. the same rows, one line each",
  `SELECT r.id AS referral_id, r.referrer_id, r.invitee_id, r.rewarded_at,
          COALESCE(c.lifetime_eligible, 0) AS referrer_lifetime_eligible,
          c.lifetime_eligible_since AS referrer_since
     FROM retail_referrals r
     LEFT JOIN retail_customers c ON c.id = r.referrer_id
    WHERE r.status = 'ordered'
    ORDER BY r.id`);

if (valueCol) {
  section('10. every affiliate.* key with its stored value',
    `SELECT key, ${valueCol}, updated_at FROM storefront_config
      WHERE key LIKE 'affiliate.%' ORDER BY key`);
}

// ── 11-14: customer 306's invitees, order by order ──────────────────────────
// Run #83 found exactly one lifetime_eligible referrer (306) among the eight
// converted referrals. These sections walk that one referrer's invitees down to
// the individual order, because the aggregate cannot tell apart the three
// reasons a commission might be missing: no qualifying order exists, the order
// exists and the commission is genuinely absent, or the order is the FIRST paid
// one and therefore the bounty's by design rather than a miss.
//
// HOW THE SETTLEMENT PATH IS IDENTIFIED, and what each mark is worth:
//
//   activity_log — the admin PATCH /orders/:id/status route calls logActivity
//     with action='status_change' (retail.js:28124). markOrderPaid does NOT log
//     at all. So a status_change row whose details carry "to":"paid" is POSITIVE
//     evidence of the admin path. Its absence is weaker: activity_log is purged
//     at ACTIVITY_LOG_RETENTION_DAYS (default 90, database.js:4300), so an old
//     order could have lost its row. Every order here is from late August 2026,
//     inside that window, but the caveat is stated rather than assumed away.
//
//   retail_payments.out_trade_no LIKE 'MANUAL%' — the admin path mints that ref
//     when it has to INSERT a payment row (retail.js:28165). It does NOT when it
//     settles an already-open row in place, so this mark confirms the admin path
//     but its absence proves nothing.
//
//   retail_orders.payment_method in the OFFLINE set (cash, bank_transfer,
//     wechat_offline, alipay_offline, other — retail.js:27840) — written only
//     when the operator picked a tender. Same asymmetry.
//
// All three are reported side by side rather than collapsed into one verdict,
// because each is conclusive when present and inconclusive when absent, and a
// single column would hide which of those two situations produced a blank.
const HAS_ACTIVITY_LOG = (() => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_log'").get(); }
  catch { return false; }
})();
console.log('\nactivity_log table present: ' + HAS_ACTIVITY_LOG);

const REFERRER = 306;

section(`11. customers referred by ${REFERRER}`,
  `SELECT id, referral_applied_at, referred_by_customer_id, created_at
     FROM retail_customers WHERE referred_by_customer_id = ?
    ORDER BY id`, [REFERRER]);

// status='paid' OR paid_at set — the union, so an order that moved past 'paid'
// into preparing/dispatched/delivered still appears. Those are paid orders that
// simply advanced; restricting to status='paid' would hide them.
const ORDERS_SQL = `
  SELECT o.id AS order_id, o.customer_id, o.order_no, o.status, o.paid_at, o.total,
         o.payment_method, o.source, o.channel,
         (o.payment_method IN ('cash','bank_transfer','wechat_offline','alipay_offline','other')) AS offline_tender,
         (SELECT COUNT(*) FROM retail_payments p
           WHERE p.order_id = o.id AND COALESCE(p.out_trade_no,'') LIKE 'MANUAL%') AS manual_payment_rows,
         (SELECT GROUP_CONCAT(COALESCE(p.out_trade_no,'(null)'), ' | ') FROM retail_payments p
           WHERE p.order_id = o.id) AS payment_refs${HAS_ACTIVITY_LOG ? `,
         (SELECT COUNT(*) FROM activity_log a
           WHERE a.entity_type = 'retail_order' AND a.entity_id = o.id
             AND a.action = 'status_change' AND a.details LIKE '%"to":"paid"%') AS admin_statuschange_rows` : ''}
    FROM retail_orders o
   WHERE o.customer_id IN (SELECT id FROM retail_customers WHERE referred_by_customer_id = ?)
     AND (o.status = 'paid' OR o.paid_at IS NOT NULL)
   ORDER BY o.customer_id, o.paid_at, o.id`;

section(`12. paid orders from ${REFERRER}'s invitees, with settlement marks`, ORDERS_SQL, [REFERRER]);

// Matched / unmatched against the commission ledger, per order, plus whether
// the order is that customer's FIRST paid one (the bounty's, not a miss).
section(`13. those orders vs retail_lifetime_commissions`,
  `SELECT o.id AS order_id, o.customer_id, o.paid_at, o.total,
          (lc.id IS NOT NULL) AS has_commission,
          lc.commission_amount, lc.rate_percent, lc.reversed_at,
          (NOT EXISTS (SELECT 1 FROM retail_orders o2
                        WHERE o2.customer_id = o.customer_id
                          AND o2.paid_at IS NOT NULL
                          AND o2.paid_at < o.paid_at)) AS is_first_paid_order
     FROM retail_orders o
     LEFT JOIN retail_lifetime_commissions lc ON lc.order_id = o.id
    WHERE o.customer_id IN (SELECT id FROM retail_customers WHERE referred_by_customer_id = ?)
      AND (o.status = 'paid' OR o.paid_at IS NOT NULL)
    ORDER BY o.customer_id, o.paid_at, o.id`, [REFERRER]);

section(`13b. the same, counted`,
  `SELECT COUNT(*) AS paid_orders,
          SUM(lc.id IS NOT NULL) AS matched,
          SUM(lc.id IS NULL) AS unmatched
     FROM retail_orders o
     LEFT JOIN retail_lifetime_commissions lc ON lc.order_id = o.id
    WHERE o.customer_id IN (SELECT id FROM retail_customers WHERE referred_by_customer_id = ?)
      AND (o.status = 'paid' OR o.paid_at IS NOT NULL)`, [REFERRER]);

// Referral 12's bounty order: confirm it is the invitee's FIRST paid order and
// carries no commission row — excluded by design, not a miss.
section('14. referral 12 first_paid_order_id — is it the bounty order, or a miss?',
  `SELECT r.id AS referral_id, r.referrer_id, r.invitee_id, r.status,
          r.first_paid_order_id, r.reward_amount, r.referee_reward_amount, r.rewarded_at,
          o.paid_at AS bounty_order_paid_at, o.total AS bounty_order_total, o.status AS bounty_order_status,
          (lc.id IS NOT NULL) AS bounty_order_has_commission,
          (NOT EXISTS (SELECT 1 FROM retail_orders o2
                        WHERE o2.customer_id = o.customer_id
                          AND o2.paid_at IS NOT NULL
                          AND o2.paid_at < o.paid_at)) AS bounty_order_is_first_paid
     FROM retail_referrals r
     LEFT JOIN retail_orders o ON o.id = r.first_paid_order_id
     LEFT JOIN retail_lifetime_commissions lc ON lc.order_id = r.first_paid_order_id
    WHERE r.id = 12`);

db.close();
console.log('\ndone — nothing was written.');
