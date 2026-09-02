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
// LOCATION, on the write side too. The form offers no location field, because
// there is no column to put one in.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { LEDGER_DATE, resolveWindow, fen } = require('../lib/finance-window');
const { storeCategory } = require('../lib/category-text');
const { requireRetailAdmin } = require('./retail');
const { logActivity } = require('../middleware/auth');

const router = express.Router();

// ── The write half ─────────────────────────────────────────────────────────
// §36 calls Transactions "the only surface where a person types". This is that.
//
// TWO TABLES, ONE FORM. `kind` picks which — 'in' writes `income_entries`, 'out'
// writes `expense_entries`. **The direction is CHOSEN by the person and never
// inferred**: a negative amount does not silently become money out, because a
// typo in a minus sign would then rewrite which half of the ledger a row belongs
// to without saying so.
const TABLE = { in: 'income_entries', out: 'expense_entries' };

// Every error string here is REUSED verbatim from routes/finance.js, which
// already ships them bilingual in this exact domain. Rule 4 of the vocabulary
// forbids composing Chinese; it does not ask for a second way to say a thing
// that is already said.
const ERR = {
  date:     'date required · 日期必填',
  amount:   'amount must be positive · 金额必须大于零',
  notFound: 'Not found · 未找到',
  poEdit:   'PO-linked expenses cannot be edited directly · 关联采购单的支出不能直接编辑',
  poDelete: 'PO-linked expenses cannot be deleted directly · 关联采购单的支出不能直接删除',
};

/** Validate and normalise a submitted row. Returns { error } or the clean values. */
function readBody(body, db) {
  const b = body || {};
  const kind = String(b.kind || '');
  // An unknown direction names no ledger, so this is `Not found` rather than a
  // validation message of its own. The form always sends one of the two, so an
  // absent `kind` is a malformed request and not something an operator can
  // produce — and minting a bilingual pair for a state the UI cannot reach would
  // be composing Chinese under Rule 4 for nobody to read.
  if (!TABLE[kind]) return { error: ERR.notFound };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { error: ERR.date };
  // fen() BEFORE the row is stored, not after it is read. #194's suite caught a
  // raw REAL sum returning 1257.6799999999998; that residue must never be what
  // gets saved, because every later reader inherits it.
  const amount = fen(b.amount);
  if (!(amount > 0)) return { error: ERR.amount };

  // §36, *Categories are normalised on write*: "Finance calls `storeCategory` on
  // every write. The same function Purchasing already uses… Finance stops being
  // the exception." Without it, three rent payments typed by three people become
  // three lines that read identically on the Summary's breakdown — **the total is
  // right and every line beneath it is wrong**, which is worse than a visibly
  // broken number because nothing on the screen looks wrong.
  //
  // BOTH DIRECTIONS, SINCE 2026-09-02. §36's *Income categories move server-side
  // and the list ships empty* gives money in a list of its own — `kind='income'`
  // in the same `categories` table, added to `routes/lookups.js` — so income now
  // has a category to store and the same rule reaches it. The sentence in §36 is
  // about Finance, not about the expense half of Finance.
  //
  // **THE KIND IS PASSED, AND THE TWO LISTS ARE NEVER CROSSED.** Money in snaps
  // against 'income' and money out against 'accounting'. Letting an income value
  // reach the expense list would file it under a name the tenant keeps for what
  // it spends, and it would read as a match on every screen afterwards.
  //
  // A value with no entry on its own list still stores NORMALISED, exactly as an
  // unlisted expense category does. The empty list §36 ships is what keeps a
  // wrong option off the screen; it is not a closed vocabulary the writer
  // enforces, and Finance has never had one in either direction.
  const category = storeCategory(db, b.category, kind === 'in' ? 'income' : 'accounting');

  const note = (b.note == null || b.note === '') ? null : String(b.note);
  return { kind, date: String(b.date), amount, category, note };
}

/** The stored row behind a typed id, with the PO refusal applied. */
function loadTyped(db, kind, id, refusal) {
  if (!TABLE[kind] || !/^\d+$/.test(String(id))) return { error: ERR.notFound, status: 404 };
  const row = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id);
  if (!row) return { error: ERR.notFound, status: 404 };
  // §36: PO-derived rows are projections both posters delete and re-insert on
  // every status change, so no human-authored value may accumulate on one. The
  // refusal is unchanged from what `routes/finance.js` already enforces and what
  // the screen already shows — this path does not weaken it, and a typed row can
  // never acquire a `po_id` because nothing below ever writes one.
  if (kind === 'out' && row.po_id != null) return { error: refusal, status: 400 };
  return { row };
}

// ── POST /api/retail-admin/finance/transactions ────────────────────────────
router.post('/api/retail-admin/finance/transactions', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    const v = readBody(req.body, db);
    if (v.error) return res.status(400).json({ error: v.error });

    // NOTE THE COLUMN LIST. `po_id` is absent by construction, so a typed row
    // cannot acquire one and can never be mistaken for a Purchasing projection —
    // the property `routes/finance.js` has today and that §36's display decision
    // rests on. Adding it here would make a hand-typed row uneditable.
    const info = v.kind === 'in'
      ? db.prepare('INSERT INTO income_entries (date, amount, category, description, created_by) VALUES (?,?,?,?,?)')
          .run(v.date, v.amount, v.category, v.note, req.user?.id || null)
      : db.prepare('INSERT INTO expense_entries (date, amount, category, description, created_by) VALUES (?,?,?,?,?)')
          .run(v.date, v.amount, v.category, v.note, req.user?.id || null);

    logActivity(req.user?.id || null, req.user?.username || null, 'create',
      v.kind === 'in' ? 'income' : 'expense', info.lastInsertRowid,
      { amount: v.amount, category: v.category }, req.ip);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error('[finance/transactions POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/retail-admin/finance/transactions/:kind/:id ───────────────────
// §36 states no constraint on editing a TYPED row, and its reasoning for the PO
// refusal — "no human-authored value can ever accumulate on one of these rows
// and be lost when it is regenerated" — does not apply to a row nothing
// regenerates. DECIDED 2026-09-02: hand-typed rows are freely editable and
// deletable. Roots enters rows by hand and mistakes are typos; forcing an
// offsetting entry to correct one turns a two-row ledger into four rows nobody
// can read.
router.put('/api/retail-admin/finance/transactions/:kind/:id', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    const { kind, id } = req.params;
    const found = loadTyped(db, kind, id, ERR.poEdit);
    if (found.error) return res.status(found.status).json({ error: found.error });
    // The direction is fixed at creation: a row lives in one table, and moving it
    // between them would be a delete and an insert wearing an edit's clothes.
    const v = readBody({ ...req.body, kind }, db);
    if (v.error) return res.status(400).json({ error: v.error });

    db.prepare(`UPDATE ${TABLE[kind]} SET date = ?, amount = ?, category = ?, description = ? WHERE id = ?`)
      .run(v.date, v.amount, v.category, v.note, id);
    logActivity(req.user?.id || null, req.user?.username || null, 'update',
      kind === 'in' ? 'income' : 'expense', Number(id),
      { amount: v.amount, category: v.category }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[finance/transactions PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/retail-admin/finance/transactions/:kind/:id ────────────────
router.delete('/api/retail-admin/finance/transactions/:kind/:id', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    const { kind, id } = req.params;
    const found = loadTyped(db, kind, id, ERR.poDelete);
    if (found.error) return res.status(found.status).json({ error: found.error });

    db.prepare(`DELETE FROM ${TABLE[kind]} WHERE id = ?`).run(id);
    logActivity(req.user?.id || null, req.user?.username || null, 'delete',
      kind === 'in' ? 'income' : 'expense', Number(id),
      { amount: found.row.amount, category: found.row.category }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[finance/transactions DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    //
    // `scope` IS SELECTED BECAUSE NOT EVERY PO ON THIS ROW CAN BE OPENED. The
    // kitchen and retail realms SHARE the `purchase_orders` table and are told
    // apart only by this column — `COALESCE(scope,'kitchen')`, the same
    // expression `getRetailPO` filters on. Both realms' posters write
    // `expense_entries.po_id`, so a kitchen order (PO-0050) lands in this ledger
    // exactly as a retail one (RPO-0003) does, and it belongs here: it is real
    // money out. But Purchasing's own opener serves retail scope only and
    // answers `not_found` for the rest, so the row must not offer an action that
    // cannot complete — §36: "the row explains its own constraint instead of
    // merely enforcing it", and a link that fails is the fault that rule names.
    // The row still renders, still counts, and still says Posted by Purchasing.
    const posted = db.prepare(`
      SELECT e.po_id                       AS po_id,
             po.po_number                  AS po_number,
             po.date                       AS date,
             COALESCE(SUM(e.amount), 0)    AS amount,
             COUNT(DISTINCT e.category)    AS categories,
             COUNT(*)                      AS rows_collapsed,
             COALESCE(po.scope, 'kitchen') AS po_scope
        FROM expense_entries e
        JOIN purchase_orders po ON po.id = e.po_id
       WHERE e.po_id IS NOT NULL AND po.date BETWEEN ? AND ?
       GROUP BY e.po_id, po.po_number, po.date, COALESCE(po.scope, 'kitchen')
       ORDER BY po.date DESC, e.po_id DESC`).all(from, to);

    // ── The income category list ──
    // §36, *Income categories move server-side, and the list ships empty*: the
    // tenant's own list, hydrated from the server on load, on the same mechanism
    // as expense. It rides the ledger payload rather than a second endpoint
    // because the screen needs it at exactly the moment it already has this —
    // the form reads its suggestions off this same object.
    //
    // **IT IS EMPTY ON EVERY TENANT TODAY, AND THAT IS THE DECISION, NOT A GAP.**
    // "The list ships empty. No defaults." Nothing seeds it: the boot seed in
    // database.js covers 'recipe' and 'product' only. An empty list is what makes
    // the form's category field ABSENT for money in — §36's own rule for the
    // screen — and "an empty list cannot offer a wrong option".
    //
    // Same ORDER BY as `routes/lookups.js` reads it with, so the one list does not
    // come back in two orders depending on which endpoint asked.
    const incomeCategories = db.prepare(
      "SELECT name FROM categories WHERE kind = 'income' ORDER BY sort_order, name"
    ).all().map(r => r.name);

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
        // Whether THIS screen's link can reach it, not a fact about the order.
        po_open: r.po_scope === 'retail',
      })),
    ].sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0)
                  || String(b.id).localeCompare(String(a.id)));

    const sum = (k) => fen(rows.filter(r => r.kind === k).reduce((t, r) => t + r.amount, 0));

    res.json({
      success: true,
      data: {
        window: { from, to, span_days: win.span_days },
        income_categories: incomeCategories,
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
