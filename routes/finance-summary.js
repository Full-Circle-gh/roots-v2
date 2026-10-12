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
//   • A revenue figure written FOR Finance, never inherited from the dashboard,
//     with the channels behind it folded out of that same read.
//   • An operating-expense sum over an arbitrary date range, which the kitchen
//     route cannot answer.
//   • A cost of goods over that same window, with the share of the period it
//     covers — one feature, never a figure alone (§56 as amended).
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
//     becomes revenue when an order consumes it, not when it arrives.
//
//     **AND THAT SENTENCE WAS NOT TRUE OF THE CODE UNDER IT UNTIL §182.** It
//     continued "— and `retail_orders.total` already excludes `balance_used`,
//     so the yuan is counted exactly once, at the sale", which inverts its own
//     premise: `total` is the CASH RESIDUAL, the gross a customer paid being
//     `points_amount + balance_used + total` (§93, and this file's own tax
//     block reads it that way twelve lines down). A revenue line summing
//     `total` alone therefore counted wallet money **never** — not at the
//     top-up, which this file rules out, and not at the sale, which `total`
//     had already netted off. §182 adds `balance_used` back at the sale, which
//     is where the header always said it belonged.
//
//     THE COST SIDE IS WHY IT MATTERED RATHER THAN A TIDINESS POINT. The cost
//     read below does not ask how a bill was settled, so a wallet-paid order
//     brought its full cost into this card and no revenue at all, and gross
//     profit was understated by the whole of store-credit spend, every period.
//
//     POINTS STAY OUT, and that is a decision rather than the same oversight
//     left half-fixed. `points_amount` is the yuan value of a discount the
//     shop granted itself; no customer ever paid it. A points-settled sale
//     earns no revenue and costs real stock, and showing it that way is the
//     truth about a giveaway — §182 records the reasoning.
//   • gzgrocery IS INCLUDED, on both halves, and the dashboard's exclusion is
//     NOT inherited (§36, *gzgrocery counts, on both halves*). That exclusion
//     exists to stop double-booking against takings this file never reads:
//     Finance does not touch `retail_stock_ledger`, so the condition it
//     protects against does not arise. A reader that "followed the revenue
//     side's exclusion" would drop a channel the dashboard's own headline
//     includes, by a different road.
//
// ── COST OF GOODS — PRESENT SINCE §56 WAS AMENDED, AND CONDITIONAL ─────────
// This file WAS the place that said nothing about cost. §56 (2026-09-07) held
// both cost rows blank and gated them on §31; §56 as amended 2026-09-14 by Ash
// lifts that gate **on one condition — the figure never appears without the
// share of the period it rests on.** So the reader lives here now, and so does
// `cost_coverage`, and they are one feature rather than a figure with a
// statistic beside it.
//
// §36's six miscount traps bind this build. Two are carried in the line
// formula (pack units, itemised refunds); three cannot be closed from the line
// at all (amount-only refunds, options with no cost counterpart, a bundle
// blanked by one unpriced component). The block that computes it carries each
// one at the point it bites.
//
// STILL NULL, NEVER ZERO, for a period with no costed line: "zero claims the
// goods were free". The amendment did not touch that and must not be read as
// having done so.
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
//   PAID_O      the same list, alias-qualified, for the cost read's own join
//   odateFor()  date(COALESCE(paid_at, placed_at), '<the shop's own shift>')
//   LEDGER_DATE the ledger's own DATE column, which takes no shift
const { PAID, PAID_O, odateFor, LEDGER_DATE, resolveWindow, fen } = require('../lib/finance-window');
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
// What the shop actually owes on a purchase-order line: what turned up, less
// what went back. REFERENCED, NEVER RESTATED — both expense posters bill on this
// expression, so a reader that re-derived it would show a returned item at a
// price that is not in the books, and would drift the first time a return rule
// changed. lib/po-returns.js carries the reasoning and tests its SQL half
// against its JS half.
const { billableQtySql } = require('../lib/po-returns');

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

    // ── Line 1 · Revenue, and the channels it arrived through ──
    // Every channel the order record carries, gzgrocery included. No ledger,
    // no top-ups. `orders` rides along so the screen can tell an empty period
    // from a zero-revenue one without a second call.
    //
    // **THE HEADLINE IS FOLDED OUT OF THE GROUPED READ, not summed beside it**,
    // which is the shape the operating-expense block below already uses and it
    // is here for the same reason. Revenue and its own disclosure have to add
    // up; a second `SUM(total)` over the same set is a second place the
    // arithmetic is done, and the day the two disagree the card shows a total
    // its own breakdown contradicts. One read, one total, by construction.
    //
    // Summed in MINOR UNITS and converted once. A running total of REAL yuan
    // accumulates the residue lib/finance-window.js's header records, and here
    // it would accumulate into a figure the lines beneath it must equal.
    //
    // ── THE CHANNEL IS THE ORDER RECORD'S OWN COLUMN ──────────────────────
    // Folded the one way the rest of this product folds it:
    // `COALESCE(NULLIF(channel,''),'wechat')`, which is
    // `/api/retail-admin/order-channel-counts`'s expression verbatim and the
    // Sales summary's beside it (both routes/retail.js). A mini-app order
    // placed before the checkout wrote the column carries NULL, and every
    // screen in this admin that counts channels already reads that as the mini
    // app. Minting a "Not recorded" bucket here instead would put this card at
    // odds with the chips on the orders list over the very same rows — and
    // unlike the expense category beneath, this column is not free text a
    // human typed: it is written by the checkout, from a known set.
    //
    // ── IT IS NOT THE SALES PAGE'S SIX BUCKETS, AND THAT IS DELIBERATE ────
    // That page splits counter sales out on `fulfillment_type='counter'` and
    // takes gzgrocery's revenue from the stock ledger through
    // `guanyiPickupSales()`. Finance reads neither — the ledger is the fold
    // this whole module exists to avoid (§36) — so borrowing its partition
    // would give a gzgrocery line that is not the one inside the total above
    // it. A till sale is written through the manual-order endpoint and carries
    // `channel='manual'`, so it lands on the Manual line here, which is what
    // the order record says it is. The rule is the expense breakdown's rule:
    // group what the total summed, and do not reshape it on the way out.
    //
    // ── THE FIGURE IS `total + balance_used`, NOT `total` (§182) ──────────
    // `total` is the CASH RESIDUAL of a bill, not the bill: §93 stores the
    // credit tenders BESIDE the cash (`points_amount`, `balance_used`) rather
    // than folded into it, precisely so a refund can return each ¥ to the
    // tender it came from. So a wallet-settled sale carries `total` = 0, and
    // a revenue line summing `total` alone showed nothing for it — while the
    // cost block below, which never asks how a bill was settled, charged the
    // card the full cost of the goods that left the shelf.
    //
    // `balance_used` IS REAL CUSTOMER MONEY, recognised HERE rather than at
    // the top-up, which is exactly the rule the header states: the cash landed
    // in the wallet earlier and becomes revenue when an order consumes it.
    // Counted once, at the sale, and the Reports card's cash-basis reading of
    // the same yuan at top-up time is the OTHER screen's question — see §182
    // on why the two are labelled apart rather than reconciled.
    //
    // `points_amount` IS DELIBERATELY ABSENT. It is a discount the shop
    // granted, not money anyone paid; adding it would book revenue against a
    // giveaway. The asymmetry is the point, not an omission to be tidied.
    //
    // BOTH TERMS COALESCE. `balance_used` is NULL on every order that predates
    // the column and on every order that used no credit, and `a + NULL` is
    // NULL in SQLite — one such row would have made the whole channel's SUM
    // null, and `COALESCE(SUM(...), 0)` on the outside cannot see that it did.
    const revGrouped = db.prepare(`
      SELECT COALESCE(NULLIF(channel, ''), 'wechat') AS channel,
             COALESCE(SUM(COALESCE(total, 0) + COALESCE(balance_used, 0)), 0) AS amount,
             COUNT(*) AS orders
        FROM retail_orders
       WHERE ${PAID} AND ${odateFor(sqlDayShiftForShop(tdb()))} BETWEEN ? AND ?
       GROUP BY COALESCE(NULLIF(channel, ''), 'wechat')
       ORDER BY amount DESC`).all(from, to);

    let revMinor = 0, revOrders = 0;
    const revenueBreakdown = revGrouped.map((r) => {
      revMinor += money.toMinor(r.amount) || 0;
      revOrders += r.orders;
      return { channel: r.channel, amount: fen(r.amount), orders: r.orders };
    });

    // ── Lines 2 and 3 · Cost of goods, and how much of the period it covers ──
    //
    // §56 AS AMENDED 2026-09-14 by Ash. These rows were blank from §56 until
    // that amendment, which lifts the "fill from §31 and nothing else" gate on
    // one condition: **the figure never appears without the share of the period
    // it rests on.** The coverage fraction below is not a decoration on the
    // number, it IS the amendment — a cost drawn from part of a period and
    // printed alone is the flattering fiction §56 refused, and printing the
    // fraction beside it is what makes the same arithmetic honest. A reader that
    // drops `cost_coverage` from this payload has undone a decision, not tidied
    // a response.
    //
    // MEASURED ON PRODUCTION BEFORE IT WAS BUILT, by
    // scripts/diagnose_cost_coverage.js on 2026-09-14: 29.1% of the last thirty
    // days' line revenue carried a cost, 56.7% of September's, 2.7% of August's
    // and none at all of July's. Those are the numbers the amendment was taken
    // against, and the reason the fraction ships in the same commit as the
    // figure rather than after it.
    //
    // ── THE LINE FORMULA CARRIES TWO OF §36's SIX TRAPS, AND THEY PULL APART ──
    //
    //   PACK UNITS. `unit_cost_at_sale` is per SINGLE UNIT; `line_total` beside
    //   it is per LINE. A Meituan qty of 1 against a 6瓶 listing is six units
    //   off the shelf with `pack_units` = 6. So the COST half takes the
    //   multiplier and the REVENUE half must not — §36 records the asymmetry
    //   explicitly because a reader treating them alike is wrong on one of them,
    //   and which one is not visible from either expression alone.
    //
    //   ITEMISED PARTIAL REFUNDS. `applyRefundedQty` stamps `refunded_qty` and
    //   stops: status stays `paid`, `qty` is never reduced, `line_total` is
    //   never reduced, and §36 records that nothing else in the codebase
    //   subtracts it from any aggregate. This is the first reader that does.
    //
    // ── AND TWO IT CANNOT, WHICH IS WHY THE FRACTION IS NOT A COMPLETENESS
    //    CLAIM ──
    //
    //   An AMOUNT-ONLY refund writes nothing to the line at all, so §36's
    //   "cannot be seen at any level of sophistication" holds here too — 7 such
    //   orders, ¥328, in the measured window. A BUNDLE line goes null when ONE
    //   component is unpriced, so a null here is not always the plain "never
    //   costed" the fraction reads it as. `cost_coverage` counts what carries a
    //   cost, not what carries a RIGHT one; §36's two accuracy findings are
    //   untouched by anything in this block.
    //
    // ── OPTIONS WERE THE THIRD, AND ARE NOW THE SECOND TERM OF THE SUM ──
    //
    // This paragraph read "OPTIONS carry a price delta with no cost counterpart",
    // and it was true: a chosen extra could draw down a real shelf
    // (`stock_product_id`, reserved one per unit bought by expandStockLines) while
    // contributing nothing at all to this figure. `options_cost_at_sale` is that
    // counterpart, written at the sale through lib/option-cost.js.
    //
    // IT TAKES THE REFUND FACTOR AND NOT THE PACK ONE. That asymmetry is the same
    // shape as the one above rather than an oversight: an extra is added ONCE PER
    // UNIT BOUGHT — `add(o.stock_product_id, r.qty)`, with no pack factor anywhere
    // in it — so a six-pack listing takes six products off the shelf and one oat
    // milk. Multiplying this term by `pack_units` would charge for six.
    //
    // A SEPARATE TERM RATHER THAN A WIDER unit_cost_at_sale, for precisely that
    // reason: one column cannot be multiplied by pack_units and left unmultiplied
    // by it in the same breath. database.js carries the warning at the other end.
    //
    // COVERAGE STILL MEASURES THE PRODUCT HALF ONLY. `line_rev_costed` below asks
    // whether `unit_cost_at_sale` is present and says nothing about the extras, so
    // a line whose product is costed and whose oat milk is not still counts as
    // covered. Left alone deliberately: the fraction has a published meaning and
    // redefining it quietly is worse than a gap that is written down.
    //
    // THE PREDICATE IS THE ONE ABOVE, ALIAS-QUALIFIED. `PAID_O` is the same
    // allow-list `PAID` is, and taking it from lib/finance-window.js rather than
    // writing `o.status IN (…)` here is the whole point of §36's finding that
    // the list was re-declared inline four times: revenue and cost must agree
    // about which orders exist, or the margin is a ratio of two different
    // populations.
    const costRow = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN i.unit_cost_at_sale IS NOT NULL
                  THEN i.unit_cost_at_sale
                       * (COALESCE(i.qty, 0) - COALESCE(i.refunded_qty, 0))
                       * COALESCE(i.pack_units, 1)
                  ELSE 0 END), 0)
           + COALESCE(SUM(CASE WHEN i.options_cost_at_sale IS NOT NULL
                  THEN i.options_cost_at_sale
                       * (COALESCE(i.qty, 0) - COALESCE(i.refunded_qty, 0))
                  ELSE 0 END), 0)                                     AS cogs,
             COALESCE(SUM(COALESCE(i.line_total, 0)), 0)              AS line_rev,
             COALESCE(SUM(CASE WHEN i.unit_cost_at_sale IS NOT NULL
                  THEN COALESCE(i.line_total, 0) ELSE 0 END), 0)      AS line_rev_costed
        FROM retail_order_items i
        JOIN retail_orders o ON o.id = i.order_id
       WHERE ${PAID_O} AND ${odateFor(sqlDayShiftForShop(tdb()))} BETWEEN ? AND ?`)
      .get(from, to) || {};

    // COVERAGE IS MEASURED IN MONEY, NOT IN LINES, and the difference is not
    // cosmetic: a line count treats a ¥4 sticker and a ¥400 hamper alike, while
    // the figure this fraction qualifies is money. The two came out close on the
    // measured window (28.4% by line, 29.1% by money) and there is no reason
    // they must.
    //
    // NULL WHEN THE WINDOW HOLDS NO LINES AT ALL — an empty period has no
    // fraction to state, which is a different fact from a period whose sales are
    // wholly uncosted, and the screen must not word the two alike.
    const lineRev = Number(costRow.line_rev) || 0;
    const costedRev = Number(costRow.line_rev_costed) || 0;
    const costCoverage = lineRev > 0 ? costedRev / lineRev : null;

    // ── THE THREE STATES, AND WHY ZERO COVERAGE STILL RENDERS BLANK ──
    //
    // NOTHING COSTED → the rows stay null and the screen keeps the treatment it
    // has had since §56. **The amendment does not reach this case, and letting
    // it would break the one rule §56 kept from §36 v4.113: zero claims the
    // goods were free.** July 2026 carries ¥56,792 of line revenue and not one
    // costed line; a ¥0.00 cost of goods there publishes a 100% margin for a
    // month whose costs were never captured and never can be. Blank is the
    // honest answer for that month and stays the honest answer.
    //
    // SOME COSTED → figure plus fraction. This is the amendment's case.
    //
    // ALL COSTED → figure, and the screen drops the fraction of its own accord.
    // **That is the amendment's own "and then the note goes away", built as a
    // consequence of the data rather than as a task somebody has to remember.**
    // A caveat that must be deleted by hand is the kind this repo's CLAUDE.md
    // opens by warning about; this one cannot go stale, because nothing keeps it
    // alive but the shortfall it describes.
    const cogs = costedRev > 0 ? Number(costRow.cogs) || 0 : null;

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
    //
    // `NULLIF(category, '')` FOLDS THE EMPTY STRING ONTO NULL, and it is the one
    // thing here that is not a bare GROUP BY. SQLite groups '' and NULL apart,
    // while the payload below maps both to `null` and the screen draws both as
    // "Not recorded" — so a tenant holding one of each rendered TWO identical
    // lines with different figures and no way to tell them apart. It also broke
    // the drill-down's whole contract: the detail read matches one bucket, and
    // there were two for it to disagree with. Folding is safe in a way that
    // trimming would not be — it merges only rows that already draw the same,
    // where TRIM would merge ' Ingredients' onto 'Ingredients' and silently
    // decide a question about typography that lib/category-text.js refuses to.
    // Nothing about the totals moves: the same rows are summed either way.
    const grouped = db.prepare(`
      SELECT NULLIF(category, '') AS category,
             COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n
        FROM expense_entries
       WHERE ${LEDGER_DATE} BETWEEN ? AND ?
       GROUP BY NULLIF(category, '')
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

    const revenue = money.fromMinor(revMinor);
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
    // cost_of_goods and gross_profit are computed above under §56 as amended,
    // and are NULL — not 0, and never omitted from the payload — for a period
    // with no costed line at all. A missing key is indistinguishable from a
    // failed read, and the screen must be able to tell a blank period from a
    // broken one.
    //
    // GROSS PROFIT IS THE HEADER REVENUE MINUS THE LINE COST, AND THE TWO ARE
    // NOT THE SAME MONEY. Revenue above is SUM(retail_orders.total); cost can
    // only be summed from order LINES, and shipping, order-level discounts and
    // tax sit on the header and never reach a line. The measured gap on
    // production runs from +¥18,033 (July) to −¥3,944 (September) — it changes
    // SIGN, so it is not a fixed adjustment anyone could net out later.
    //
    // **THE MISMATCH IS THE AMENDMENT'S, DELIBERATELY, AND IT IS WHY THE
    // STAIRCASE STAYS A STAIRCASE.** A gross profit computed on the costed
    // SUBSET would be the truer ratio, and it was put up and rejected on
    // 2026-09-14 for a structural reason rather than a numerical one: operating
    // expenses below are the whole business's, so a subset gross profit cannot
    // be continued into Net, and the card stops being five steps that follow
    // from one another. §36's *Finance Summary ships without a location filter*
    // refuses a store filter on exactly this shape — the top line scoped and the
    // bottom line not — and a subset gross profit is that same failure one row
    // higher. Recorded so a later reader meets a decision rather than a bug.
    //
    // NET IS STILL REVENUE MINUS OPERATING EXPENSES, WITH NO COST TAKEN OFF,
    // and the amendment does not change it: "Revenue, operating expenses and net
    // render normally from the data that exists." Cost of goods is NOT
    // subtracted from net, and must not become so on the strength of the row
    // above now carrying a figure — a partial cost taken off net would put a
    // known-incomplete number into the one figure on this card that nothing else
    // qualifies.
    res.json({
      success: true,
      data: {
        window: { from, to, span_days: win.span_days },
        revenue,
        orders: revOrders,
        // WHERE THE TOP LINE CAME FROM. One row per channel, heaviest first,
        // summing to `revenue` above because both are the same read — see the
        // note on it. Ordered by weight for the same reason the expense
        // breakdown is: an operator opening it is asking which channel earned
        // the money, not how the channels are spelled.
        //
        // EVERY CHANNEL THE WINDOW HOLDS, and no declared key set. The orders
        // list declares its chips so a quiet channel renders at zero instead of
        // vanishing; this is a breakdown of a figure, and a ¥0 line inside a
        // total would assert that a channel took nothing when what is true is
        // that it took no orders at all. §1.12 keeps a card free of rows that
        // only ever say nothing happened — and a channel this file has never
        // heard of still gets its line, carrying its own key, rather than being
        // dropped out of a total that counted it.
        revenue_breakdown: revenueBreakdown,
        cost_of_goods: cogs == null ? null : fen(cogs),
        gross_profit: cogs == null ? null : fen(revenue - cogs),
        // THE SHARE OF THE PERIOD THE TWO ROWS ABOVE REST ON, 0…1, or null for
        // a window holding no order lines. §56 as amended makes this a
        // CONDITION of those two figures rather than a companion to them: they
        // were blank precisely because a partial cost printed alone reads as a
        // whole one. Sent even at 1 — the screen decides what to draw at full
        // coverage, and a key that vanished when the news was good would make
        // "complete" and "failed to read" the same payload.
        cost_coverage: costCoverage,
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

// ── The category a purchase-order LINE was posted under ────────────────────
//
// The two posters group `po_line_items` by this expression and write one
// expense row per group, so a reader that wants the lines behind ONE of those
// rows has to ask the question the same way or it gets a different set.
//
// **THE FALLBACK DIFFERS BY REALM AND THAT IS NOT A TYPO.** A line with no
// category posts as `门店进货 Retail stock` from `postRetailPOExpenses`
// (routes/retail-purchasing.js) and as `未分类 Uncategorized` from
// `postPOExpenses` (routes/purchases.js). Both realms write into this one
// ledger and are told apart only by `purchase_orders.scope`, so the fallback is
// chosen per row rather than fixed here.
//
// THE LITERALS ARE COPIED, WHICH IS THE ONE THING THIS FILE TRIES NOT TO DO.
// The alternative was to lift them into a shared module and change both
// posters to import it — a behaviour-preserving refactor of code that WRITES
// MONEY, in a change that only reads. So they are copied and then held in place
// by a test that reads both shipped posters and fails if either string moves.
// That buys the drift protection without touching the write path. If a third
// poster ever appears, lift them properly.
const PO_CATEGORY_FALLBACK = {
  retail: '门店进货 Retail stock',
  kitchen: '未分类 Uncategorized',
};
// The posters' own expression, with the realm chosen in SQL from the order's own
// scope. Two bound parameters, retail first, so one read serves a set of rows
// holding both realms — which any window can, both posting into this one ledger.
const PO_CATEGORY_CASE = (line, po) =>
  `COALESCE(NULLIF(TRIM(${line}.expense_category),''),
            CASE WHEN COALESCE(${po}.scope,'kitchen') = 'retail' THEN ? ELSE ? END)`;

// ── GET /api/retail-admin/finance/summary/category?from=&to=&category= ─────
//
// THE ROWS BEHIND ONE LINE OF THE BREAKDOWN. The disclosure above says
// Ingredients cost ¥27,081; this says which rows make it up.
//
// **IT IS THE BREAKDOWN'S OWN QUERY WITH THE GROUP BY REMOVED, AND THAT IS THE
// WHOLE DESIGN.** Same table, same window expression, same category match —
// listed instead of summed. The detail therefore adds up to the figure that was
// clicked by construction rather than by agreement, and there is no second
// place for the two to drift apart.
//
// ── WHY NOT REUSE THE TRANSACTIONS LIST, WHICH ALREADY READS THIS TABLE ────
// Because it answers a different question and would show a smaller number.
// `routes/finance-transactions.js` COLLAPSES PO-derived rows to one row per
// purchase order — a purchase order buys several categories at once, so the
// collapsed row carries `category: null` and no category filter can match it.
// It also windows those rows on the PO's own date rather than the expense row's.
// A drill-down built on it would open ¥27,081 onto a list totalling whatever
// happened to be hand-typed, with the purchase orders — usually most of an
// ingredients line — missing and nothing on screen to say so. §36 treats a
// figure whose own breakdown does not add up as the worst thing this card can
// do, and borrowing a list reshaped for another purpose is how that happens.
//
// So the PO rows are listed INDIVIDUALLY here. PO-0050 appearing twice in one
// category is not a duplicate: it bought ingredients on two lines, and both are
// inside the total. The po_number rides along so the row can still say where it
// came from.
//
// ── THE MATCH IS ON RAW TEXT, AND DELIBERATELY NOT ON `spacingKey` ─────────
// The breakdown groups by the category column as stored. `Ingredients(Kitchen+
// Retail Use)` and `Ingredients (Kitchen + Retail Use)` are therefore TWO lines
// on the card, each with its own figure — lib/category-text.js resolves that
// pair for the is_operating flag and pointedly does not merge them for display.
// A detail read keyed on `spacingKey` would gather both spellings under either
// line and overshoot the figure clicked. The one rule that keeps this honest is
// *match what the GROUP BY grouped*: `=` against the raw text, which shares
// BINARY collation with it (`schema.sql:276`, no COLLATE on the column).
//
// ── NO ROW CEILING, and that is a decision rather than an oversight ────────
// A capped list is a list that does not add up, which is the one thing this
// endpoint exists to guarantee. `readTransactions` caps at 2,000 across a whole
// window because it is a browsable ledger; this is one category inside one
// window, bounded by how much a shop buys, and a cap here would trade the
// contract for a ceiling nothing is near. If that ever stops being true the fix
// is paging with the total stated, never a silent slice.
router.get('/api/retail-admin/finance/summary/category', requireRetailAdmin, (req, res) => {
  const win = resolveWindow(req.query);
  const { from, to } = win;
  if (win.inverted) {
    return res.status(400).json({ error: 'from is after to · 起始日期晚于结束日期' });
  }

  // The uncategorised bucket, addressed by an EMPTY `category` parameter.
  // NOT trimmed, on purpose: the grouping above folds '' onto NULL and folds
  // nothing else, so a category of one space is a real category there and has to
  // be a real category here too. Trimming on this side alone would send a
  // whitespace label to the NULL bucket and return the wrong rows for it.
  const raw = req.query.category;
  const uncategorised = raw === undefined || raw === null || String(raw) === '';
  const wanted = uncategorised ? null : String(raw);

  try {
    const db = tdb();

    // The two joins are LEFT joins and carry no filter of their own: a row's
    // provenance is a thing to REPORT, never a thing to select on. An inner join
    // on either would drop rows out of a total that counted them — a PO deleted
    // after its expenses posted would take its yuan off this list and leave them
    // on the line above.
    const rows = db.prepare(`
      SELECT e.id, e.${LEDGER_DATE} AS date, e.amount, e.description,
             e.po_id, po.po_number, COALESCE(po.scope, 'kitchen') AS po_scope,
             e.claim_id, c.paid_by, e.returns_entry_id, e.returns_claim_id
        FROM expense_entries e
   LEFT JOIN purchase_orders po ON po.id = e.po_id
   LEFT JOIN staff_expenses  c  ON c.id  = e.claim_id
       WHERE e.${LEDGER_DATE} BETWEEN ? AND ?
         AND ${uncategorised ? "NULLIF(e.category, '') IS NULL" : 'e.category = ?'}
       ORDER BY e.date DESC, e.id DESC`)
      .all(...(uncategorised ? [from, to] : [from, to, wanted]));

    // Summed in MINOR UNITS, for the reason the summary's own totals are: a
    // running total of REAL yuan accumulates a residue, and this figure exists
    // precisely so a caller can hold it against the breakdown line and find them
    // equal. Adding it up the sloppy way would be the one bug this endpoint
    // cannot afford.
    let minor = 0;
    const out = rows.map((r) => {
      minor += money.toMinor(r.amount) || 0;
      return {
        id: r.id,
        date: String(r.date),
        amount: fen(r.amount),
        note: r.description || null,
        // WHERE THE ROW CAME FROM, said the way Transactions says it, because an
        // operator meets these three kinds on that screen first. 'manual' is a
        // row somebody typed; 'claim' one an approved staff expense posted;
        // 'po' one a purchase order posted.
        // §269: 'return' is a negative row — goods that went back — netted
        // into this category's total like everything else here.
        source: r.po_id ? 'po' : r.claim_id ? 'claim'
          : (r.returns_entry_id != null || r.returns_claim_id != null) ? 'return' : 'manual',
        po_id: r.po_id || null,
        po_number: r.po_number || null,
        // Whether THIS admin's opener can serve that purchase order, not a fact
        // about the order. Both realms post into this table and share
        // `purchase_orders`; Purchasing's opener answers for retail scope only,
        // so a kitchen PO must not be offered a link that cannot complete (§36).
        po_open: r.po_id ? r.po_scope === 'retail' : null,
        claim_id: r.claim_id || null,
        // Whether the shop paid it or a person did — the difference between a
        // cost that is finished and one that is also a debt.
        paid_by: r.claim_id ? (r.paid_by || null) : null,
      };
    });

    // ── Which of these rows has items behind it ───────────────────────────
    // **A CHEVRON THAT OPENS ONTO NOTHING IS A CONTROL THAT LIES**, which is
    // already this screen's rule for the expenses disclosure. Most PO rows have
    // line items; the landed-cost row does NOT — freight, tax and handling post
    // as their own expense row against the purchase order with no
    // `po_line_items` behind them at all (`postRetailPOExpenses`). So the count
    // is reported and the client draws the control only where there is one.
    //
    // ONE GROUPED QUERY OVER THE WHOLE RESULT, not a count per row: a category
    // holding forty purchase orders would otherwise be forty round trips to
    // decide forty chevrons.
    //
    // THE FALLBACK IS RESOLVED PER ROW, IN SQL, from the order's own scope. A
    // set of rows can hold both realms — both post into this one ledger — and
    // binding either realm's label across the whole read would file the other's
    // blank-category lines under a name they were not posted with.
    const poIds = [...new Set(out.filter(r => r.po_id).map(r => r.po_id))];
    if (poIds.length) {
      const marks = new Map();
      const holes = poIds.map(() => '?').join(',');
      for (const r of db.prepare(`
        SELECT l.po_id, ${PO_CATEGORY_CASE('l', 'po')} AS category, COUNT(*) AS n
          FROM po_line_items l
          JOIN purchase_orders po ON po.id = l.po_id
         WHERE l.po_id IN (${holes}) AND ${billableQtySql('l')} > 0
         GROUP BY l.po_id, category`)
        .all(PO_CATEGORY_FALLBACK.retail, PO_CATEGORY_FALLBACK.kitchen, ...poIds)) {
        marks.set(`${r.po_id}\u0000${r.category}`, r.n);
      }
      const key = uncategorised ? '' : wanted;
      for (const r of out) {
        if (r.po_id) r.lines = marks.get(`${r.po_id}\u0000${key}`) || 0;
      }
    }

    // §469 — WHAT A STAFF-CLAIM ROW HERE MAY BE RE-FILED UNDER. The phone opens
    // a claim row onto a picker that posts to `/staff-expenses/:id/category`,
    // and that route snaps what it is sent onto this exact list (active
    // `accounting` categories, the tenant's own order) — the same read
    // `routes/finance-transactions.js` hands its own picker. Sent with the rows
    // so the sheet needs no second request; an empty list means no picker,
    // never a free-text field. A failed read is that empty list too: the rows
    // are the point of this endpoint and must not fail with it.
    let expenseCategories = [];
    try {
      expenseCategories = db.prepare(
        "SELECT name FROM categories WHERE kind = 'accounting' AND COALESCE(is_active, 1) = 1 ORDER BY sort_order, name"
      ).all().map(r => r.name);
    } catch (e) { expenseCategories = []; }

    res.json({
      success: true,
      data: {
        window: { from, to, span_days: win.span_days },
        expense_categories: expenseCategories,
        // Echoed back exactly as asked, so a caller can tell which line it holds
        // — and null for the uncategorised bucket, matching the breakdown row's
        // own null rather than an invented label. §36: Finance stores category
        // text raw, and a name minted here would be a second wrong one.
        category: uncategorised ? null : wanted,
        // THE ASSERTION THIS ENDPOINT IS FOR. It equals the `amount` on the
        // matching `expense_breakdown` row of the same window, always, because
        // both are the same rows added the same way. A test holds them together.
        total: money.fromMinor(minor),
        entries: out.length,
        rows: out,
      },
    });
  } catch (e) {
    console.error('[finance/summary/category]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/retail-admin/finance/summary/po-lines?entry_id= ───────────────
//
// THE ITEMS BEHIND ONE PURCHASE-ORDER ROW of a category drill-down. The row
// above says `RPO-0017 · 3 lines · ¥1,230`; this says which three.
//
// ── IT IS THE CATEGORY'S SLICE OF THE ORDER, NOT THE ORDER ────────────────
// **This is the whole trap, and it is §88's trap one level down.** A purchase
// order buys several categories at once, and the poster writes ONE EXPENSE ROW
// PER CATEGORY: RPO-0017 may hold twelve lines, of which three were
// Retail-Only Goods, and those three are the ¥1,230. Listing the order's twelve
// would show a list that does not add up to the row it opened from — the same
// defect §36 calls the worst thing this card can do, and the reason the level
// above this one is not built on the Transactions list.
//
// So the read is the poster's own grouped query with the GROUP BY removed and
// one group selected, which is exactly what §88's own endpoint is to the
// breakdown. Three levels, one rule, applied three times.
//
// ── THE ROW IS ADDRESSED BY ITS LEDGER ID, NOT BY (po_id, category) ───────
// One `expense_entries` row IS one (purchase order, category) pair, so its id
// names the group with nothing for a caller to get wrong. Passing the pair
// would let a client ask for a combination that no row was posted for and get
// a plausible list of lines totalling something no figure on the screen shows.
// The id is looked up, and the category comes off the ROW rather than the
// request.
//
// ── BILLABLE QUANTITY, NEVER `qty` ────────────────────────────────────────
// `billableQtySql` from lib/po-returns.js — what turned up less what went back,
// the expression both posters bill on. A reader using `qty` would price a
// returned item at what it cost before it was sent back, which is not what the
// row above it counted. Referenced, never restated.
//
// ── ROUNDING, STATED RATHER THAN DISCOVERED ───────────────────────────────
// The poster rounds ONCE over the group (`money.round(SUM(...))`, audit I-02),
// so `lines_total` here is computed the same way and equals the posted figure
// exactly — a test holds them together. The per-line figures are each rounded
// for display, so they can sum to a cent away from that total on a line whose
// unit cost carries a third decimal. The card renders whole yuan, so it does
// not surface; it is recorded here because the alternative — allocating the
// rounded total across the lines with `splitMinor` — would print a line at a
// price the supplier never charged, and a purchase-order line's truth is
// quantity times unit cost.
router.get('/api/retail-admin/finance/summary/po-lines', requireRetailAdmin, (req, res) => {
  const entryId = Number(req.query.entry_id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return res.status(400).json({ error: 'entry_id is required · 缺少条目编号' });
  }

  try {
    const db = tdb();

    // The ledger row, and the order behind it. `po_id IS NOT NULL` is the whole
    // gate: a hand-typed or claim-posted row has no purchase order and no lines,
    // and must not resolve to some other row's.
    const entry = db.prepare(`
      SELECT e.id, e.po_id, e.category, e.amount,
             po.po_number, po.date AS po_date, COALESCE(po.scope, 'kitchen') AS po_scope
        FROM expense_entries e
        JOIN purchase_orders po ON po.id = e.po_id
       WHERE e.id = ? AND e.po_id IS NOT NULL`).get(entryId);
    if (!entry) return res.status(404).json({ error: 'not_found' });

    const lines = db.prepare(`
      SELECT l.id, l.name_en, l.name_cn, l.sku, l.unit,
             ${billableQtySql('l')}                            AS qty,
             COALESCE(l.cost_per_unit, 0)                      AS unit_cost,
             ${billableQtySql('l')} * COALESCE(l.cost_per_unit, 0) AS amount
        FROM po_line_items l
        JOIN purchase_orders po ON po.id = l.po_id
       WHERE l.po_id = ?
         AND ${billableQtySql('l')} > 0
         AND ${PO_CATEGORY_CASE('l', 'po')} = ?
       ORDER BY l.sort_order, l.id`)
      .all(entry.po_id, PO_CATEGORY_FALLBACK.retail, PO_CATEGORY_FALLBACK.kitchen,
           entry.category == null ? '' : entry.category);

    // Summed the poster's way — over the raw products, rounded once — so this
    // figure and `posted` are the same arithmetic and cannot drift.
    let raw = 0;
    for (const l of lines) raw += l.qty * l.unit_cost;

    res.json({
      success: true,
      data: {
        entry_id: entry.id,
        po_id: entry.po_id,
        po_number: entry.po_number || null,
        // The category this slice was posted under, off the ROW. Null keeps its
        // null — §36 stores category text raw and a label minted here would be a
        // second wrong name on a known-dirty column.
        category: entry.category || null,
        // What the ledger row says, and what its lines come to. Equal, always.
        posted: fen(entry.amount),
        lines_total: money.round(raw),
        entries: lines.length,
        rows: lines.map((l) => ({
          id: l.id,
          // Two columns, picked by the reader's language with a fallback across
          // — the house pattern for bilingual DATA (`tmStoreLabel`). The client
          // does the picking; both halves ride so it can.
          name_en: l.name_en || null,
          name_cn: l.name_cn || null,
          sku: l.sku || null,
          qty: l.qty,
          unit: l.unit || null,
          // **NOT `fen()`.** A unit cost is a PRICE, not a money total, and it
          // can be sub-cent — lib/money keeps `toMicro`/`fromMicro` and acMoney
          // takes a `dp` override for exactly these. Rounding it to whole cents
          // here would destroy the value in the payload to save nothing: the
          // screen formats it at the tenant's decimals anyway, and a later
          // reader wanting the real per-unit figure would find it already gone.
          unit_cost: l.unit_cost,
          // The line's money, which IS a total and rounds like one.
          amount: fen(l.amount),
        })),
      },
    });
  } catch (e) {
    console.error('[finance/summary/po-lines]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
