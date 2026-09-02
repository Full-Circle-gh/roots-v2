// Finance — the window, the predicates, and the money rounding, declared ONCE.
//
// docs/tacet-consolidation-decisions.md §36, *The aggregation predicate and the
// order date are both inconsistent today*, is a finding about copy-paste:
// thirteen sites read `retail_order_items` in aggregate, an allow-list is
// declared once and re-declared inline four more times, a non-equivalent
// deny-list is live at two more, and four date conventions run simultaneously —
// so an order placed 31 July at 22:00 Guangzhou and paid 1 August lands in
// August on one screen and July on another. It ends:
//
//   "Which predicate and which date column the cost reader adopts is a decision
//    to be taken when it is built, deliberately. It must not be inherited by
//    copying whichever site is nearest."
//
// This module is that decision, taken once, for every Finance surface. Both
// `routes/finance-summary.js` and `routes/finance-transactions.js` reference
// these and declare none of their own. **Editing a constant here is the only
// way to change what Finance counts** — which is the property §36 asks for and
// the reason this is a module rather than two matching pairs of consts.

'use strict';

// ── Orders ─────────────────────────────────────────────────────────────────
// The ALLOW-LIST, not the deny-list. A deny-list admits any status added later;
// this excludes one until somebody decides it belongs.
const PAID = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";

// Guangzhou local. The business runs at +8 and its day boundary must too.
const TZ = '+8 hours';

// The dominant convention of the four, and the only correct one here. `paid_at`
// alone drops orders that have none and puts the day boundary in UTC;
// `placed_at` alone books a sale on the day it was keyed rather than paid.
const ODATE = `date(COALESCE(paid_at, placed_at), '${TZ}')`;

// ── The ledger ─────────────────────────────────────────────────────────────
// `income_entries.date` and `expense_entries.date` are both DATE — a business
// day already, with no clock on it — so neither takes a shift. Naming that
// here stops a later reader "fixing" the asymmetry with the order side by
// adding one, which would move every ledger row back a day.
//
// It is a bare column name rather than an expression for exactly that reason:
// there is nothing to wrap, and wrapping it would imply there was.
const LEDGER_DATE = 'date';

/** A day string, `YYYY-MM-DD`. Anything else is not a window bound. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a `from`/`to` query pair into a business-local window.
 *
 * Defaults to the trailing 30 days in Guangzhou local time, matching the
 * Reports range bar's own default so "30 days" means the same span on every
 * Finance screen and on Reports. A malformed bound falls back rather than
 * erroring: a truncated query string should show the default window, not a 400.
 */
function resolveWindow(query) {
  const q = query || {};
  const nowGz = new Date(Date.now() + 8 * 3600 * 1000);
  const to = DAY.test(q.to || '') ? q.to : nowGz.toISOString().slice(0, 10);
  const from = DAY.test(q.from || '')
    ? q.from
    : new Date(nowGz.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  return {
    from, to,
    span_days: Math.round((new Date(to) - new Date(from)) / 86400000) + 1,
    inverted: from > to,
  };
}

/**
 * Round to the fen. Money is REAL yuan in this schema — see
 * docs/tacet-money-model-survey.md — so a sum of REALs carries float residue
 * that must not reach a screen.
 */
const fen = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = { PAID, TZ, ODATE, LEDGER_DATE, DAY, resolveWindow, fen };
