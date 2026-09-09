// Finance — the Summary staircase.
//
// docs/tacet-consolidation-decisions.md §36 (v4.115) governs every figure here.
// The screen is public/retail-admin/22-finance.js; the layout it renders comes
// from reference/finance-summary-mockup.html.
//
// THIS IS NOT `routes/finance.js`. That file is the KITCHEN app's Finance API:
// seventeen routes on the module-level global database handle, none of them
// calling `tdb()`, blocked-and-left-to-die under §36 rather than repaired. It
// shares no route prefix and no code with this one. §36: "Tacet's Finance
// routes are built on `tdb()` from the first commit. There is no migration step
// here to forget, because there is nothing to migrate."
//
// WHAT THIS FILE IS RESPONSIBLE FOR, IN ONE LINE EACH
//   • A revenue figure written FOR Finance, never inherited from the dashboard.
//   • An operating-expense sum over an arbitrary date range, which the kitchen
//     route cannot answer.
//   • Saying nothing at all about cost of goods, because nothing reads it yet.
//
// ── WHY REVENUE IS NOT THE DASHBOARD'S ─────────────────────────────────────
// §36, *Finance does not reuse the dashboard revenue aggregator*. The Reports
// handler's `kpi.revenue` is a cash-basis blend of THREE sources: the order
// SUM, gzgrocery takings read from `retail_stock_ledger` through
// `guanyiPickupSales()`, and wallet top-up cash from
// `retail_topup_transactions`. Calling it would silently import both folds.
//
//   • Wallet top-ups are EXCLUDED here. A top-up is money received before any
//     sale. §36 defines revenue as coming from the order record and rules
//     settlement receipts out entirely; a top-up is a third thing. Money
//     becomes revenue when an order consumes it, not when it arrives — and
//     `retail_orders.total` already excludes `balance_used`, so the yuan is
//     counted exactly once, at the sale.
//   • gzgrocery IS INCLUDED, on both halves, and the dashboard's exclusion is
//     NOT inherited (§36, *gzgrocery counts, on both halves*). That exclusion
//     exists to stop double-booking against takings this file never reads:
//     Finance does not touch `retail_stock_ledger`, so the condition it
//     protects against does not arise. A reader that "followed the revenue
//     side's exclusion" would drop a channel the dashboard's own headline
//     includes, by a different road.
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
// COST OF GOODS. There is no cost reader, and this file does not become one.
// `unit_cost_at_sale` is written on all six sale paths and read by nothing;
// §36 records six ways a reader will silently miscount and binds them on its
// build. Until that is built, cost is reported as null and the screen renders
// the §1.12 seventh state. Null, never zero: "zero claims the goods were free".
//
// LOCATION. `expense_entries` has NO location column — verified against
// `schema.sql:229`, which carries id, date, amount, category, description,
// po_id, created_at, created_by and nothing else. §36's *An expense may carry a
// location* decides that the dimension exists and says in terms that "where the
// column goes, and its shape, are NOT decided here". So this endpoint takes no
// store filter, and that is a refusal rather than an omission: orders carry
// `store_id` and expenses do not, so a store-scoped call could only scope the
// top line and not the bottom one — reporting a shop's full revenue against the
// whole business's expenses. §36 names that failure and rejects it: "A filter
// that silently returns a wrong answer is worse than no filter." When the
// column lands, this is where the filter goes, and CONTRIBUTION rather than NET
// is what the last row must then be called.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

const router = express.Router();

// ── The predicates, referenced not re-declared ─────────────────────────────
// They live in lib/finance-window.js, which carries the reasoning: §36 records
// that the allow-list is declared once and re-declared inline four more times
// across the existing aggregators, and that a reader must not inherit one by
// copying whichever site is nearest. Finance has exactly one copy, shared with
// routes/finance-transactions.js, and this file adds none of its own.
//
//   PAID        the order status ALLOW-list
//   odateFor()  date(COALESCE(paid_at, placed_at), '<the shop's own shift>')
//   LEDGER_DATE the ledger's own DATE column, which takes no shift
const { PAID, odateFor, LEDGER_DATE, resolveWindow, fen } = require('../lib/finance-window');
const { sqlDayShiftForShop } = require('../lib/business-date');
// Sales tax / VAT (audit I-03). The refunded half is proportional arithmetic
// this file must not invent a second copy of.
const tax = require('../lib/tax');
const money = require('../lib/money');
// The one rule for when two category strings are the same category (§87 part
// two). Referenced, never re-implemented — a second almost-identical comparison
// is how the writer and the reader come to disagree about which category a row
// is in.
const { spacingKey } = require('../lib/category-text');

// ── GET /api/retail-admin/finance/summary?from=&to= ────────────────────────
router.get('/api/retail-admin/finance/summary', requireRetailAdmin, (req, res) => {
  // The window, resolved the one way Finance resolves windows.
  const win = resolveWindow(req.query);
  const { from, to } = win;
  if (win.inverted) {
    return res.status(400).json({ error: 'from is after to · 起始日期晚于结束日期' });
  }

  try {
    const db = tdb();

    // ── Line 1 · Revenue ──
    // Every channel the order record carries, gzgrocery included. No ledger,
    // no top-ups. `orders` rides along so the screen can tell an empty period
    // from a zero-revenue one without a second call.
    const rev = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
        FROM retail_orders
       WHERE ${PAID} AND ${odateFor(sqlDayShiftForShop(tdb()))} BETWEEN ? AND ?`).get(from, to);

    // ── Line 4 · Operating expenses ──
    // The kitchen route groups by `substr(date,1,7)`, a calendar-month string,
    // which cannot answer an arbitrary range at all — a 30-day window crossing
    // a month boundary has no month to ask for. It is left alone (§36 blocks
    // and retires that file); this is the range sum Finance needs.
    //
    // **IT IS NO LONGER EVERY ROW IN THE WINDOW, and that is §87 part two.**
    // A tenant may now mark one of its own expense categories as NOT an
    // operating expense — the case being an owner's private transfer, which is
    // real money leaving the account and is not a cost of running the shop.
    // Summed with rent it takes ¥5,000 off the month's Net and nothing on the
    // screen looks wrong.
    //
    // Both figures are therefore folded out of the ONE grouped read below,
    // rather than each getting a sum of its own. Two queries over one set is two
    // places for the split to be applied, and the day they disagree the screen
    // shows a total its own breakdown does not add up to.
    //
    // The breakdown is also what sits behind the disclosure on the expenses row.
    // Ordered by weight, because the operator opening it is asking where the
    // money went.
    //
    // An uncategorised row keeps its own line and is NOT folded into a bucket
    // with a made-up name: §36 records that Finance stores category text raw
    // and un-normalised, so inventing a label here would put a second wrong
    // name on top of a known-dirty column. The client renders the null.
    const grouped = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n
        FROM expense_entries
       WHERE ${LEDGER_DATE} BETWEEN ? AND ?
       GROUP BY category
       ORDER BY amount DESC`).all(from, to);

    // ── Which categories the tenant has marked non-operating ──
    // **RESOLVED ON `spacingKey`, WHICH IS THE KEY `storeCategory` SNAPS ON, and
    // not on a SQL join.** The expense row holds the category as free text and
    // the flag lives on the `categories` record, so the two are matched by name
    // — and the one rule in this product for when two category strings are the
    // same category is `lib/category-text.js`. A `=` join would count
    // `Private expense` and `private expense` as two different things and quietly
    // put one of them back into operating expenses, which is the exact failure
    // the flag exists to prevent. One rule, referenced, not a second one here.
    //
    // A category with no entry on the list — free text, or a row typed before the
    // list existed — is OPERATING. That is the safe default in both directions:
    // an unlisted cost is a real cost until somebody says otherwise, and nothing
    // leaves the operating total without a tenant having deliberately marked it.
    const flags = new Map();
    for (const c of db.prepare(
      "SELECT name, COALESCE(is_operating, 1) AS is_operating FROM categories WHERE kind = 'accounting'"
    ).all()) {
      const key = spacingKey(c.name);
      if (key !== null) flags.set(key, c.is_operating ? 1 : 0);
    }
    const operatingFlag = (category) => {
      const key = spacingKey(category);
      if (key === null || !flags.has(key)) return 1;
      return flags.get(key);
    };

    // Summed in MINOR UNITS and converted once, never by adding REALs and
    // rounding at the end — the residue lib/finance-window.js's header records
    // (1257.6799999999998) is exactly what a running total of REAL yuan
    // accumulates, and here it would accumulate into two figures that must add
    // up to a third.
    let opMinor = 0, nonOpMinor = 0, opRows = 0, nonOpRows = 0;
    const breakdown = grouped.map((r) => {
      const isOperating = operatingFlag(r.category);
      const minor = money.toMinor(r.amount) || 0;
      if (isOperating) { opMinor += minor; opRows += r.n; }
      else { nonOpMinor += minor; nonOpRows += r.n; }
      return { category: r.category || null, amount: fen(r.amount), entries: r.n, is_operating: isOperating };
    });

    const revenue = fen(rev.revenue);
    const expenses = money.fromMinor(opMinor);
    // **SHOWN ON ITS OWN LINE, NEVER DROPPED.** §87: a number that disappears
    // from a total without saying so is the same defect the flag exists to
    // prevent, wearing different clothes. ZERO rather than null when nothing is
    // flagged, which is every tenant on the day this ships: the tenant has
    // marked nothing, so the excluded amount really is nothing — this is not the
    // §1.12 seventh state, where a figure was never captured.
    const nonOperating = money.fromMinor(nonOpMinor);

    // ── Tax collected, and tax handed back (audit I-03) ──
    // NOT the merchant's money. On a shop that charges tax exclusively it is
    // inside the revenue figure above — the customer paid it to the shop, and
    // the shop owes it on — and a report that shows revenue without showing
    // this is a report somebody will pay their own tax out of.
    //
    // NULL, not zero, for a shop that has never charged tax: absence must mean
    // "there is no tax here", never "the tax was nothing" (§1.12). That is why
    // the row is counted as well as summed.
    let taxBlock = null;
    const taxCollected = db.prepare(`
      SELECT COALESCE(SUM(tax_amount), 0) AS collected, COUNT(tax_amount) AS taxed
        FROM retail_orders
       WHERE ${PAID} AND ${odateFor(sqlDayShiftForShop(tdb()))} BETWEEN ? AND ?`).get(from, to);
    if (taxCollected.taxed > 0) {
      // The refunded half, proportional to the gross each refund came out of.
      // Bounded: only orders that carry tax AND were refunded, which is a
      // fraction of a fraction. The gross is the one orderTenders() defines —
      // points and wallet were tenders on that bill too, and a refund
      // proportional to the CASH alone would return too much tax on any order
      // partly paid in points.
      const refunded = db.prepare(`
        SELECT tax_amount,
               COALESCE(points_amount, 0) + COALESCE(balance_used, 0) + COALESCE(total, 0) AS gross,
               COALESCE(refund_amount_paid, 0) AS refund
          FROM retail_orders
         WHERE ${PAID} AND ${odateFor(sqlDayShiftForShop(tdb()))} BETWEEN ? AND ?
           AND tax_amount IS NOT NULL AND COALESCE(refund_amount_paid, 0) > 0`).all(from, to);
      let backMinor = 0;
      for (const r of refunded) {
        backMinor += tax.taxInRefund({
          taxMinor: money.toMinor(r.tax_amount) || 0,
          grossMinor: money.toMinor(r.gross) || 0,
          refundMinor: money.toMinor(r.refund) || 0,
        });
      }
      const collected = fen(taxCollected.collected);
      const back = money.fromMinor(backMinor);
      taxBlock = {
        collected,
        refunded: back,
        net: fen(collected - back),
        orders: taxCollected.taxed,
      };
    }

    // ── Lines 2, 3 and 5 ──
    // cost_of_goods and gross_profit are null and always will be until a cost
    // reader exists. NULL, not 0, and not omitted from the payload: the screen
    // must render both rows in the seventh state, and a missing key is
    // indistinguishable from a failed read.
    //
    // NET IS REVENUE MINUS OPERATING EXPENSES, WITH NO COST TAKEN OFF, and that
    // is §36's decision rather than an oversight: "Revenue, operating expenses
    // and net render normally from the data that exists." It follows that net
    // is HIGHER than the business's real net for every period without cost —
    // which is exactly what the two Not-recorded rows above it are on the
    // screen to say. Do not silence them and leave this figure standing alone.
    res.json({
      success: true,
      data: {
        window: { from, to, span_days: win.span_days },
        revenue,
        orders: rev.orders || 0,
        cost_of_goods: null,
        gross_profit: null,
        operating_expenses: expenses,
        // §87: the money that left the account and is not a cost of running the
        // shop. It is NOT subtracted from net — a drawing is not a business
        // expense, and taking it off net would put it back in the profit line by
        // another road. The screen states it beneath the staircase so the yuan
        // is visible without being counted.
        non_operating_expenses: nonOperating,
        non_operating_entries: nonOpRows,
        net: fen(revenue - expenses),
        // NULL for a shop that charges no tax — see the block above. The screen
        // renders the row only when there is one, so nothing changes for a shop
        // that has never turned tax on.
        tax: taxBlock,
        // Every row, both kinds, each carrying its own flag — the disclosure
        // shows where the money went and the client separates the two. A
        // breakdown that listed only the operating half would be a second place
        // the split is applied, and the excluded line above would have nothing
        // to open.
        expense_breakdown: breakdown,
        expense_entries: opRows,
      },
    });
  } catch (e) {
    console.error('[finance/summary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
