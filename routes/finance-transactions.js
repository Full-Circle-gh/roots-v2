// Finance — the Transactions ledger.
//
// docs/tacet-consolidation-decisions.md §36 (v4.118) governs what this reads.
// The screen is public/retail-admin/22-finance.js; the layout comes from
// reference/finance-transactions-mockup.html, with two approved departures
// recorded there and repeated below.
//
// THIS IS NOT `routes/finance.js`, the kitchen Finance API — seventeen routes
// on the module-level global handle, blocked-and-left-to-die under §36. It
// shares no route prefix and no code. Tacet's Finance is on `tdb()` from the
// first commit.
//
// ── WHAT IT READS, AND WHY NOT ORDERS ──────────────────────────────────────
// §36, *Transactions reads typed rows, not the order record*: this screen
// lists `income_entries` and `expense_entries`, and does NOT list orders.
//
// Reading money in from the order record would make Transactions a
// several-hundred-row-per-month restatement of the Orders screen — Roots ran
// 587 orders in August alone — while the Summary already carries order revenue
// as its top line. **Summary is the totals; Transactions is the ledger of what
// was entered by hand.** §36 says the same thing twice elsewhere: it calls this
// "the only surface where a person types", and it argues PO rows must not be
// hidden because "Transactions would then hold only what people typed".
//
// A CONSEQUENCE, RECORDED SO IT IS NOT READ AS A BUG: `income_entries` holds 26
// rows covering June and July 2026, and Tacet's Finance counts from 1 August.
// **So the money-in list is empty until somebody types a row.** That is the
// ordinary §1.12 empty state — something will arrive as soon as non-sale income
// is recorded — and NOT the seventh state, which is for information that was
// never captured and is not coming.
//
// ── TWO DIRECTIONS, AND THERE IS NO THIRD ──────────────────────────────────
// §36, *Settlement receipts are excluded from Finance entirely*: a platform
// payout is money the order record already counted, arriving in the bank. It
// has "no place in the staircase, no row in Transactions, and no income
// category". So there is no payout direction, no payout row and no payout
// filter here, and adding one would double-count revenue.
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
// LOCATION. Neither ledger table has a location column — `income_entries` is
// `schema.sql:217-227`, `expense_entries` is `:229-240`, and neither carries
// one. The mockup draws a Location column and an "All locations" filter; both
// would render empty on every row and the filter would silently drop the whole
// list when set. §36: "A filter that silently returns a wrong answer is worse
// than no filter." Same refusal, same reason, as the Summary's missing store
// select.
//
// THE WRITE HALF. §36 calls Transactions the only surface where a person types,
// and that is unbuilt. This endpoint is read-only and there is no POST here.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { LEDGER_DATE, resolveWindow, fen } = require('../lib/finance-window');
const { requireRetailAdmin } = require('./retail');

const router = express.Router();

// ── GET /api/retail-admin/finance/transactions?from=&to= ───────────────────
router.get('/api/retail-admin/finance/transactions', requireRetailAdmin, (req, res) => {
  const win = resolveWindow(req.query);
  const { from, to } = win;
  if (win.inverted) {
    return res.status(400).json({ error: 'from is after to · 起始日期晚于结束日期' });
  }

  try {
    const db = tdb();

    // ── Money in ──
    // Typed non-sale income only: sublet space, sold equipment, grants, supplier
    // rebates (§36's own examples). Sales are not here and must not be added.
    const income = db.prepare(`
      SELECT id, ${LEDGER_DATE} AS date, amount, category, description
        FROM income_entries
       WHERE ${LEDGER_DATE} BETWEEN ? AND ?
       ORDER BY date DESC, id DESC`).all(from, to);

    // ── Money out · hand-entered ──
    // Everything with no `po_id`. These are editable in principle — the write
    // half is unbuilt — so they carry `source: 'manual'`.
    const manual = db.prepare(`
      SELECT id, ${LEDGER_DATE} AS date, amount, category, description
        FROM expense_entries
       WHERE po_id IS NULL AND ${LEDGER_DATE} BETWEEN ? AND ?
       ORDER BY date DESC, id DESC`).all(from, to);

    // ── Money out · posted by Purchasing ──
    // COLLAPSED TO ONE ROW PER PURCHASE ORDER, per §36: "PO-derived expenses DO
    // appear in the Transactions list, collapsed to ONE row per purchase order,
    // not editable there, and linking through to the purchase order." Storage is
    // untouched — `postPOExpenses()` still writes one row per category and two
    // rows still exist for PO-0050; one row is drawn. That is a display decision
    // and this GROUP BY is the whole of it.
    //
    // THE DATE IS THE PURCHASE ORDER'S OWN, NEVER `created_at`. These rows are
    // delete-and-reinsert projections: both posters delete every row for a PO and
    // re-insert them on each status change, so `created_at` records the last
    // re-post rather than when the purchase happened — a PO flipped back and
    // forward in April carries April rows stamped with today. §36: "It must never
    // be presented as a purchase date, and never used as evidence of when
    // anything occurred." `created_at` is not selected here at all, so no later
    // edit can reach for it by accident.
    //
    // The window filters on the PO's date for the same reason: filtering on the
    // row's own date would move a purchase into whichever window it was last
    // re-posted in.
    //
    // `categories` counts the DISTINCT category subtotals behind the figure. §36:
    // the note it drives "vanishes entirely at n = 1 — it does not read '1
    // category'", because at one nothing was collapsed and a note would assert a
    // breakdown that does not exist. The client applies that rule; the count is
    // reported honestly either way.
    const posted = db.prepare(`
      SELECT e.po_id                       AS po_id,
             po.po_number                  AS po_number,
             po.date                       AS date,
             COALESCE(SUM(e.amount), 0)    AS amount,
             COUNT(DISTINCT e.category)    AS categories,
             COUNT(*)                      AS rows_collapsed
        FROM expense_entries e
        JOIN purchase_orders po ON po.id = e.po_id
       WHERE e.po_id IS NOT NULL AND po.date BETWEEN ? AND ?
       GROUP BY e.po_id, po.po_number, po.date
       ORDER BY po.date DESC, e.po_id DESC`).all(from, to);

    // ── One list, both directions ──
    // Sorted by date, newest first, the way the mockup draws it. `id` breaks a
    // tie so the order is stable across reloads rather than left to the engine.
    const rows = [
      ...income.map(r => ({
        kind: 'in', id: r.id, date: r.date,
        subject: r.description || r.category || null,
        category: r.category || null,
        amount: fen(r.amount),
        source: 'manual', po_id: null, po_number: null, categories: null,
      })),
      ...manual.map(r => ({
        kind: 'out', id: r.id, date: r.date,
        subject: r.category || r.description || null,
        category: r.category || null,
        amount: fen(r.amount),
        source: 'manual', po_id: null, po_number: null, categories: null,
      })),
      ...posted.map(r => ({
        kind: 'out', id: `po-${r.po_id}`, date: r.date,
        subject: r.po_number || `PO-${r.po_id}`,
        category: null,
        amount: fen(r.amount),
        source: 'po', po_id: r.po_id, po_number: r.po_number,
        categories: r.categories || 0,
      })),
    ].sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0)
                  || String(b.id).localeCompare(String(a.id)));

    const sum = (k) => fen(rows.filter(r => r.kind === k).reduce((t, r) => t + r.amount, 0));

    res.json({
      success: true,
      data: {
        window: { from, to, span_days: win.span_days },
        totals: { in: sum('in'), out: sum('out') },
        counts: {
          all: rows.length,
          in: rows.filter(r => r.kind === 'in').length,
          out: rows.filter(r => r.kind === 'out').length,
        },
        rows,
      },
    });
  } catch (e) {
    console.error('[finance/transactions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
