#!/usr/bin/env node
/**
 * diagnose_refund_ceiling.js — are the two "over-refunded" orders a defect, or
 * was the check wrong?
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 *   Locally:  ROOTS_DB=/path/to/copy.db node scripts/diagnose_refund_ceiling.js
 *
 * READ-ONLY and proven so, same contract as every other diagnose_* here.
 *
 * WHY. diagnose_money_precision.js reported two orders "refunded for more than
 * the order total" and two "approved to refund more than the order total". That
 * check compared the refund against `retail_orders.total` — and reading the
 * approve handler afterwards says that is the wrong ceiling:
 *
 *     routes/retail.js:32439
 *     function orderTenders(o) {
 *       const P = points_amount, B = balance_used, C = total;
 *       return { P, B, C, G: P + B + C };
 *     }
 *
 * `total` is the CASH portion — what the customer paid with money once points
 * and wallet balance were applied. The refund ceiling is G, the GROSS value of
 * everything the customer handed over, and refunding it sends each part back to
 * the tender it came from. So on any order paid partly with points or store
 * credit, a refund LEGITIMATELY exceeds `total`, and the earlier check was
 * measuring the wrong thing.
 *
 * That is precisely the mistake the precision script's own header warns about —
 * "a guessed invariant reporting a scary number is worse than no invariant" —
 * so this script does not guess. It computes G the way the shipped handler
 * computes it, and it reports the timeline from retail_refund_events so a real
 * violation can be attributed to a person or to the code.
 *
 * NO CUSTOMER PII. Order numbers and amounts only; customer ids are reported as
 * present/absent, never as values, because this prints into an Actions log.
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
let Database;
try { Database = require('/root/roots-v2/node_modules/better-sqlite3'); }
catch (e) { Database = require('better-sqlite3'); }

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);

const CENT = 0.005;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
// The shipped ceiling, copied from routes/retail.js orderTenders().
const gross = (o) => r2(Math.max(0, o.points_amount || 0)
                      + Math.max(0, o.balance_used || 0)
                      + Math.max(0, o.total || 0));

const orders = db.prepare(
  `SELECT id, order_no, status, refund_status, total, points_amount, balance_used,
          refund_amount_requested, refund_amount_approved, refund_amount_paid,
          refund_cash_amount, refund_approved_at, refund_paid_at,
          refund_reviewer_id, refund_payer_id
     FROM retail_orders
    WHERE COALESCE(refund_amount_approved,0) > 0 OR COALESCE(refund_amount_paid,0) > 0`
).all();

console.log(`\n══ 1 · ORDERS WITH A REFUND ══════════════════════════════════════`);
console.log(`  ${orders.length} order(s) carry an approved or paid refund`);
const withCredit = orders.filter(o => (o.points_amount || 0) > 0 || (o.balance_used || 0) > 0);
console.log(`  ${withCredit.length} of them were paid partly with points or wallet balance`);
console.log('  (those are the ones where a correct refund can exceed `total`)');

// ── The WRONG check, reproduced, so the two orders can be identified ────────
const wrongPaid = orders.filter(o => (o.refund_amount_paid || 0) > (o.total || 0) + CENT);
const wrongAppr = orders.filter(o => (o.refund_amount_approved || 0) > (o.total || 0) + CENT);
console.log(`\n══ 2 · THE ORIGINAL CHECK (refund > total) ═══════════════════════`);
console.log(`  ${wrongPaid.length} paid over total, ${wrongAppr.length} approved over total`);

const flagged = [...new Set([...wrongPaid, ...wrongAppr].map(o => o.id))]
  .map(id => orders.find(o => o.id === id));
for (const o of flagged) {
  const G = gross(o);
  console.log(`\n  order ${o.order_no || o.id}  [${o.status} / refund ${o.refund_status}]`);
  console.log(`     total (cash)      ${r2(o.total)}`);
  console.log(`     points_amount     ${r2(o.points_amount)}`);
  console.log(`     balance_used      ${r2(o.balance_used)}`);
  console.log(`     GROSS (the ceiling) ${G}`);
  console.log(`     requested ${o.refund_amount_requested} · approved ${o.refund_amount_approved} · paid ${o.refund_amount_paid} · cash ${o.refund_cash_amount}`);
  const okAppr = (o.refund_amount_approved || 0) <= G + CENT;
  const okPaid = (o.refund_amount_paid || 0) <= G + CENT;
  const okCash = (o.refund_cash_amount == null) || (o.refund_cash_amount <= r2(o.total) + CENT);
  console.log(`     against GROSS: approved ${okAppr ? 'OK' : 'OVER'} · paid ${okPaid ? 'OK' : 'OVER'} · cash-vs-total ${okCash ? 'OK' : 'OVER'}`);
}

// ── The CORRECT check ──────────────────────────────────────────────────────
console.log(`\n══ 3 · THE CORRECT CHECK (refund > gross tender) ═════════════════`);
const realAppr = orders.filter(o => (o.refund_amount_approved || 0) > gross(o) + CENT);
const realPaid = orders.filter(o => (o.refund_amount_paid || 0) > gross(o) + CENT);
// Cash returned must never exceed the cash taken, whatever the gross allows.
const realCash = orders.filter(o => o.refund_cash_amount != null
  && o.refund_cash_amount > r2(o.total) + CENT);
console.log(`  approved over gross : ${realAppr.length}`);
console.log(`  paid over gross     : ${realPaid.length}`);
console.log(`  CASH refunded over the cash actually taken : ${realCash.length}`);
console.log('  (the third is the one that would be real money out of the door)');

const violations = [...new Set([...realAppr, ...realPaid, ...realCash].map(o => o.id))]
  .map(id => orders.find(o => o.id === id));

// ── Attribution: a person, or the code? ────────────────────────────────────
console.log(`\n══ 4 · ATTRIBUTION ═══════════════════════════════════════════════`);
if (!violations.length) {
  console.log('  Nothing violates the real ceiling. Nothing to attribute.');
} else {
  for (const o of violations) {
    console.log(`\n  order ${o.order_no || o.id} — gross ${gross(o)}, approved ${o.refund_amount_approved}, paid ${o.refund_amount_paid}`);
    let ev = [];
    try {
      ev = db.prepare(
        `SELECT event, amount, note, user_id, customer_id, created_at
           FROM retail_refund_events WHERE order_id = ? ORDER BY id`
      ).all(o.id);
    } catch (e) { console.log('     (refund events unreadable: ' + e.message + ')'); }
    if (!ev.length) {
      console.log('     NO refund events at all — the columns were written without going');
      console.log('     through the refund flow. That points at a script or a direct write,');
      console.log('     not at somebody clicking Approve.');
    }
    for (const e of ev) {
      const who = e.user_id != null ? `staff#${e.user_id}`
                : e.customer_id != null ? 'customer' : 'no actor recorded';
      console.log(`     ${e.created_at}  ${String(e.event).padEnd(10)} ${String(e.amount ?? '-').padStart(9)}  ${who}${e.note ? '  · ' + String(e.note).slice(0, 60) : ''}`);
    }
  }
}

// ── Is the ceiling reachable at all through the handler? ───────────────────
console.log(`\n══ 5 · HOW CLOSE DOES THE FLEET RUN TO ITS CEILING ═══════════════`);
let atCeiling = 0, over = 0;
for (const o of orders) {
  const G = gross(o), a = Number(o.refund_amount_approved || 0);
  if (a > G + CENT) over++;
  else if (a >= G - CENT) atCeiling++;
}
console.log(`  ${atCeiling} order(s) approved exactly at the gross ceiling (a full refund)`);
console.log(`  ${over} order(s) approved above it`);
console.log('  The approve handler clamps with Math.min(amount, remainingGross), so a');
console.log('  value above the ceiling cannot come from that handler on a fresh order.');

db.close();
