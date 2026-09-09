// Staff expense claims — the submit half (§87 step two).
//
// An employee says what they spent on the shop's behalf. **NOTHING HERE REACHES
// THE BOOKS.** A claim lands in `staff_expenses` and waits; only approval writes
// a row into `expense_entries`, carrying the claim's id, on the projection shape
// a purchase order already uses. §87 part one records why a status column on the
// ledger was rejected — every reader of `expense_entries` would then have to
// remember to exclude the unapproved ones, and the day one forgets, money nobody
// approved is in the accounts with nothing on screen to say so.
//
// SO THIS FILE WRITES TO EXACTLY ONE TABLE, and a later edit that makes it touch
// `expense_entries` has undone the decision rather than extended it.
//
// ── WHAT IS NOT HERE, AND IS NOT MISSING ───────────────────────────────────
// APPROVAL, REJECTION AND SETTLEMENT. They are step three, with the screen that
// works them. The columns exist (`status`, `decided_by`, `settled`) because a
// claim's shape is decided; the verbs do not, and no route below can move a
// claim out of 'submitted'.
//
// EDITING A SUBMITTED CLAIM. Not built, deliberately: the manager sees what was
// sent, and a claim that changed under them after they read it is the defect the
// approval step exists to prevent. Withdrawing one is the shape that belongs
// here later, not editing.
//
// ── CAPABILITY ─────────────────────────────────────────────────────────────
// `lib/cap-routes.js` maps every mutation under `/api/retail-admin/staff-expenses`
// to `expenses:submit`. No gate is declared in this file, for the reason the
// finance-categories header gives: a second rule beside the map is how the two
// come to disagree.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { fen } = require('../lib/finance-window');
const { requireRetailAdmin } = require('./retail');
const { logActivity } = require('../middleware/auth');

const router = express.Router();

// THE VALIDATOR LIVES IN lib/expense-claim.js, and it is not here for a reason
// worth stating: the rules it holds are a closed set, a rounding and two size
// limits, and a suite that wanted to RUN them had to boot this route — which
// boots the express app and the database behind it. It did, and it left the dev
// database in a state that turned a neighbouring suite red. Pure rules belong in
// a pure file, the way lib/category-text.js already does it.
const { readBody } = require('../lib/expense-claim');

/* The rows one person can see: their own, whatever their capability.
   **A CLAIM IS PERSONAL UNTIL IT IS APPROVED**, and this is the read that says
   so. The approval list is a different screen with a different key, and it does
   not come through here — so an operator who holds `expenses:submit` and nothing
   else can never widen this into everybody's spending by editing a query string.

   RECEIPT BYTES ARE NOT SELECTED. A list of twenty claims would otherwise carry
   twenty photographs into a phone over a shop's wifi, to render nothing: the
   list draws a row, not an image. `has_receipt` is what the row needs. */
function listMine(db, userId) {
  return db.prepare(`
    SELECT id, date, amount, category, note, paid_by, store_id, status, settled,
           submitted_at, decided_at,
           CASE WHEN receipt_data IS NULL THEN 0 ELSE 1 END AS has_receipt
      FROM staff_expenses
     WHERE submitted_by IS ?
     ORDER BY date DESC, id DESC
     LIMIT 200`).all(userId);
}

// ── POST /api/retail-admin/staff-expenses ──────────────────────────────────
router.post('/api/retail-admin/staff-expenses', requireRetailAdmin, express.json({ limit: '4mb' }), (req, res) => {
  try {
    const db = tdb();
    const v = readBody(req.body, db);
    if (v.error) return res.status(400).json({ error: v.error });

    // STATUS IS NOT TAKEN FROM THE BODY. It is the column's default, written by
    // the table rather than by the caller, so no client can submit a claim that
    // arrives already approved — which is the one thing a submit route must not
    // let a submitter do.
    const info = db.prepare(`
      INSERT INTO staff_expenses
        (date, amount, category, note, paid_by, payment_method, store_id, receipt_data, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(v.date, v.amount, v.category, v.note, v.paidBy, v.method, v.storeId, v.receipt,
           req.user?.id || null);

    // The amount is logged; the photo is not. An activity row is read in a list
    // and a data URI in one would be unreadable — and the bytes are already in
    // the claim.
    logActivity(req.user?.id || null, req.user?.username || null, 'create', 'staff_expense',
      info.lastInsertRowid, { amount: v.amount, category: v.category, paid_by: v.paidBy }, req.ip);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error('[staff-expenses POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/retail-admin/staff-expenses/mine ──────────────────────────────
// What this person has sent, newest first, with what has become of each.
router.get('/api/retail-admin/staff-expenses/mine', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    const rows = listMine(db, req.user?.id || null).map(r => ({ ...r, amount: fen(r.amount) }));
    // WHAT THE BUSINESS OWES THIS PERSON, and it is not a sum of everything.
    // Only an APPROVED claim they paid for themselves and has not been settled
    // is a debt: a submitted one might be rejected, and a company-account one
    // owes nobody. Counted here rather than on the phone so the rule lives in
    // one place the day a second screen wants it.
    const owedMinor = rows
      .filter(r => r.paid_by === 'employee' && r.status === 'approved' && !r.settled)
      .reduce((t, r) => t + Math.round(r.amount * 100), 0);
    res.json({
      success: true,
      data: {
        rows,
        owed: fen(owedMinor / 100),
        waiting: rows.filter(r => r.status === 'submitted').length,
      },
    });
  } catch (e) {
    console.error('[staff-expenses mine]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/retail-admin/staff-expenses/meta ──────────────────────────────
// What the form needs to draw itself: the tenant's own expense categories and
// the stores this operator may file against.
//
// ITS OWN ENDPOINT RATHER THAN THE FINANCE ONE. `/finance/categories` answers
// the maintenance screen — usage counts, hidden entries, sort orders — and a
// phone that called it would be reading the tenant's bookkeeping to draw six
// chips. This answers the question the form actually asks: what may I pick.
router.get('/api/retail-admin/staff-expenses/meta', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    // ACTIVE ONLY, and in the tenant's own order. Hiding a category means it
    // stops being offered, and this is one of the surfaces that has to honour
    // it or hiding is a promise the product only half keeps.
    const categories = db.prepare(
      "SELECT name FROM categories WHERE kind = 'accounting' AND COALESCE(is_active, 1) = 1 ORDER BY sort_order, name"
    ).all().map(r => r.name);

    // The operator's own store scope, which the RBAC layer has already resolved
    // for this request. NULL scope means every store — the same meaning it
    // carries everywhere else — and a single-store tenant gets one row, which
    // the form renders as no control at all (§1.9: a picker that can only pick
    // one thing is not a choice).
    let stores = [];
    try {
      stores = db.prepare(
        'SELECT id, name_en, name_cn FROM retail_stores WHERE COALESCE(is_active, 1) = 1 ORDER BY sort_order, id'
      ).all();
      if (Array.isArray(req.scopeStores) && req.scopeStores.length) {
        const allowed = new Set(req.scopeStores.map(Number));
        stores = stores.filter(s => allowed.has(Number(s.id)));
      }
    } catch (e) { stores = []; }

    res.json({ success: true, data: { categories, stores } });
  } catch (e) {
    console.error('[staff-expenses meta]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/retail-admin/staff-expenses/:id/receipt ───────────────────────
// The photograph, on its own, for the one row that wants to show it. Served
// apart from the list for the reason the list gives: bytes travel when somebody
// asks to look at them, not when a list is drawn.
//
// **THE OWNERSHIP TEST IS IN THE QUERY, not a check after it.** A receipt is a
// picture of somebody's private spending; a route that fetched by id and then
// compared would be one early return away from serving anybody's.
router.get('/api/retail-admin/staff-expenses/:id/receipt', requireRetailAdmin, (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: 'Not found · 未找到' });
    const row = tdb().prepare(
      'SELECT receipt_data FROM staff_expenses WHERE id = ? AND submitted_by IS ?'
    ).get(req.params.id, req.user?.id || null);
    if (!row || !row.receipt_data) return res.status(404).json({ error: 'Not found · 未找到' });
    res.json({ success: true, data: { receipt_data: row.receipt_data } });
  } catch (e) {
    console.error('[staff-expenses receipt]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
