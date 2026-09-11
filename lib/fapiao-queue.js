'use strict';

// WHICH CUSTOMER FAPIAO ARE ACTUALLY WAITING — asked here and nowhere else.
//
// (Not to be confused with lib/invoice-mark.js, which is the SUPPLIER side:
// whether a purchase line will ever have a 发票 from the people we buy from.
// This file is the other direction — 发票 our customers asked US for.)
//
// ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
// Three screens asked "what is pending?" and one of them asked it wrong:
//
//   /dashboard/ops            needs_invoice=1, not issued, AND the order is
//   (Home's "Needs you" row)  not cancelled and not awaiting payment.
//   /invoices/unseen-count    the same three clauses. The dot agreed with Home.
//   /invoices  (THE LIST)     needs_invoice = 1. That was the whole predicate.
//
// So the list counted a fapiao request attached to a CANCELLED order as
// pending work, and Home did not. On 2026-09-11 an operator's phone showed
// "Pending 2" on the Invoices screen with nothing on Home to match it, and
// both figures were sincere: the list was counting requests that came in on
// orders that were later cancelled, and Home was correctly ignoring them.
//
// The operator's read of that was the worse of the two possible ones — not
// "the list is wrong" but "the ALERT is broken" — and it is the reasonable
// read. Two numbers that disagree teach you to trust neither.
//
// ── WHY CANCELLED AND UNPAID ARE EXCLUDED, AND WHY THEY ARE NOT THE SAME ──
// Both are "you cannot act on this", for different reasons, and a queue that
// folds them together tells the operator to go and do something impossible.
//
//   cancelled        There is no sale. Issuing a 发票 against it would put a
//                    fiscal document behind a transaction that did not happen.
//   pending_payment  The money has not arrived. A 发票 is issued against
//                    payment received, not against an intention to pay.
//
// NEITHER IS DELETED FROM THE LIST. They are excluded from the PENDING count
// and shown under All wearing the order's own status — the phone already has
// live words for both (ORDER_STATUS in m.html: 已取消 / 待付款). A request that
// silently vanishes is the failure mode this file exists to stop; a request
// that is present and labelled unactionable is the finished answer.
//
// ── EVERY CALLER TAKES ITS PREDICATE FROM HERE ────────────────────────────
// The clauses are exported as SQL text rather than as a query, because the
// four callers select different columns, join differently and order
// differently. What they must share is the WHERE, and sharing it as a string
// is what makes a future divergence a one-line edit instead of a silent one.

// Order statuses a fapiao cannot be issued against. Inclusion list, never
// fall-through (§1.17 rule 2): a status added to the system later is treated
// as issuable until somebody decides otherwise, which fails towards showing
// the operator work rather than towards hiding it.
const UNISSUABLE_STATUSES = ['cancelled', 'pending_payment'];

const inList = (arr) => arr.map((s) => `'${s}'`).join(',');

/**
 * The customer asked for a fapiao on this order. Nothing about whether it has
 * been issued, or whether it still can be.
 */
function requestedSql(alias = 'o') {
  return `${alias}.needs_invoice = 1`;
}

/**
 * The order is in a state a fapiao can be issued against. On its own, so the
 * Orders tab's `needs_invoice` pseudo-filter can pair it with requestedSql:
 * that view deliberately keeps ISSUED rows browsable (they sort below the open
 * work) while still dropping the dead ones, which is neither pendingSql nor
 * unissuedSql.
 */
function issuableSql(alias = 'o') {
  return `${alias}.status NOT IN (${inList(UNISSUABLE_STATUSES)})`;
}

/**
 * Asked for, and not yet issued. Includes the ones nobody can act on — this is
 * the clause the ALL tab and the per-order lookups want.
 */
function unissuedSql(alias = 'o') {
  return `${alias}.needs_invoice = 1
         AND COALESCE(${alias}.invoice_status, 'requested') <> 'issued'`;
}

/**
 * THE PENDING QUEUE. Asked for, not issued, and the order is in a state where
 * issuing one is a legal thing to do.
 *
 * This is the definition Home's "Needs you" row has always used and the one
 * every other surface now reads. If a number anywhere claims to count pending
 * fapiao and was not built from this, the two will drift apart again.
 */
function pendingSql(alias = 'o') {
  return `${unissuedSql(alias)}
         AND ${issuableSql(alias)}`;
}

/**
 * Asked for, not issued, and the order has moved somewhere that makes issuing
 * impossible. The difference between `unissuedSql` and `pendingSql` — shown,
 * never counted as work.
 */
function blockedSql(alias = 'o') {
  return `${unissuedSql(alias)}
         AND ${alias}.status IN (${inList(UNISSUABLE_STATUSES)})`;
}

/** Already issued. Kept here so all four live in one place. */
function issuedSql(alias = 'o') {
  return `${alias}.needs_invoice = 1 AND ${alias}.invoice_status = 'issued'`;
}

/**
 * Can a fapiao be issued against an order in this state? The row-level twin of
 * pendingSql's last clause, for callers holding a row rather than writing SQL.
 */
function isIssuableStatus(status) {
  return !UNISSUABLE_STATUSES.includes(String(status || '').toLowerCase());
}

module.exports = {
  UNISSUABLE_STATUSES,
  requestedSql,
  issuableSql,
  unissuedSql,
  pendingSql,
  blockedSql,
  issuedSql,
  isIssuableStatus,
};
