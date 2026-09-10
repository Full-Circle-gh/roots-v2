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
// ── SETTLEMENT POSTS NOTHING, AND THAT IS THE WHOLE OF IT ──────────────────
// Paying the employee back moves money between the business and a person. The
// ¥38 was recorded once, at approval; a system that wrote a second row for the
// repayment would report ¥76 of taxis. So `/settle` writes one column on the
// claim and touches `expense_entries` in no way at all — the suite asserts it.
//
// WHAT IT IS FOR is the question "who are we still out of pocket to", which the
// ledger cannot answer: the ledger knows the shop spent ¥38 on transport, not
// that the ¥38 is still in a driver's pocket.
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

const ERR = {
  notFound: 'Not found · 未找到',
  decision: 'approve or reject · 请选择通过或拒绝',
  settled:  'this claim has already been paid back · 该申请已完成付款',
  notApproved: 'only an approved claim can be paid back · 仅审批通过的申请可标记付款',
  notOwed:  'this one was paid from the company account · 该笔由公司账户支付',
  forbidden:'this account cannot approve expense claims · 此账号无法审批费用申请',
  // §90.
  notApprovedVoid: 'only an approved claim can be voided · 仅审批通过的申请可以作废',
  forbiddenVoid:   'this account cannot void expense claims · 此账号无法作废费用申请',
};

/* WHO MAY DECIDE. `lib/cap-routes.js` gates the decide route on
   `expenses:approve` — but ONLY where the tenant has switched enforcement on,
   which is the fail-open contract every route in this product inherits and is
   right for a screen somebody is mid-shift on.

   THAT CONTRACT IS WRONG FOR THIS ONE ROUTE, and this is the exception rather
   than a second copy of the rule. Everything else that falls open is a screen
   somebody could already reach; falling open here would let any operator who can
   raise a claim approve their own, on every tenant that has not turned
   enforcement on — which is all of them. §87 part five allows an APPROVER to
   approve their own claim. It does not make everyone an approver.

   The read half is gated too: the approval list is everybody's spending. */
function requireApprover(req, res, next) {
  // The owner always passes, as everywhere else in this product.
  if (req.backendUser && req.backendUser.role === 'owner') return next();
  // No resolved capability set means the RBAC layer could not answer. It answers
  // for every backend operator, so this is a control-plane failure rather than a
  // permission one — and a money route does not fall open on an unanswered
  // question.
  if (!req.caps || typeof req.caps.has !== 'function') {
    return res.status(403).json({ error: ERR.forbidden });
  }
  if (!req.caps.has('expenses:approve')) return res.status(403).json({ error: ERR.forbidden });
  return next();
}

/* WHO MAY VOID (§90). Same fail-closed shape as requireApprover and for the
   same reason: this reverses money already in the books, so a route this can
   reach must not fall open on a question the RBAC layer could not answer. It is
   its own function, checking `expenses:cancel` rather than `expenses:approve`,
   because that is the whole point of the split — an owner can hand a
   bookkeeper the power to undo a mistaken approval without also making them an
   approver (lib/capabilities.js). */
function requireCanceller(req, res, next) {
  if (req.backendUser && req.backendUser.role === 'owner') return next();
  if (!req.caps || typeof req.caps.has !== 'function') {
    return res.status(403).json({ error: ERR.forbiddenVoid });
  }
  if (!req.caps.has('expenses:cancel')) return res.status(403).json({ error: ERR.forbiddenVoid });
  return next();
}

// THE VALIDATOR LIVES IN lib/expense-claim.js, and it is not here for a reason
// worth stating: the rules it holds are a closed set, a rounding and two size
// limits, and a suite that wanted to RUN them had to boot this route — which
// boots the express app and the database behind it. It did, and it left the dev
// database in a state that turned a neighbouring suite red. Pure rules belong in
// a pure file, the way lib/category-text.js already does it.
const { readBody } = require('../lib/expense-claim');
// The one place a claim reaches the books, and a file for the same reason: it is
// runnable against a fixture without an app behind it.
const { postClaim } = require('../lib/expense-posting');
const { withTransaction } = require('../lib/db-transaction');

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

/* The names behind `submitted_by`, resolved in ONE read for however many ids.

   IT IS A CROSS-HANDLE LOOKUP AND A JOIN IS NOT AVAILABLE. `tenant_users` lives
   on the CONTROL-PLANE handle; `staff_expenses` lives on the tenant one and
   carries the id alone. Two readers need this — the approval queue, which names
   a screenful, and the decide route, which names exactly one on its way to the
   ledger — so it is one function rather than two lookups that would drift.

   A MISSING NAME IS NOT A FAILURE. The map simply has no entry: a claim without
   a name still decides, and a ledger row without one still carries its money. */
function submitterNames(ids) {
  const names = new Map();
  const want = [...new Set((ids || []).filter(Boolean))];
  if (!want.length) return names;
  try {
    const q = require('../database').prepare(
      `SELECT id, display_name, username FROM tenant_users WHERE id IN (${want.map(() => '?').join(',')})`);
    for (const u of q.all(...want)) names.set(u.id, u.display_name || u.username);
  } catch (e) { /* a name is a nicety; a claim without one still decides */ }
  return names;
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

    // ── What THIS person has claimed under before (§87 amendment) ──
    // The picker's top section. **THEIR OWN, NEVER THE SHOP'S**: a driver and an
    // office manager do not want the same six, and a shop-wide "most used" would
    // hand the driver whatever the office manager files most.
    //
    // Filtered against the active list rather than trusted as-is: a category the
    // tenant has since hidden must not come back through a person's history,
    // which is the one way a retired name could still reach a new claim.
    let recent = [];
    try {
      const active = new Set(categories);
      recent = db.prepare(`
        SELECT category, MAX(id) AS last
          FROM staff_expenses
         WHERE submitted_by IS ? AND category IS NOT NULL AND TRIM(category) <> ''
         GROUP BY category
         ORDER BY last DESC
         LIMIT 12`).all(req.user?.id || null)
        .map(r => r.category)
        .filter(c => active.has(c))
        .slice(0, 5);
    } catch (e) { recent = []; }

    res.json({ success: true, data: { categories, stores, recent } });
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

// ── GET /api/retail-admin/staff-expenses/pending ───────────────────────────
// THE APPROVAL LIST. Everybody's claims, which is exactly what `/mine` refuses
// to be — so this is a different route with a different key, and the two are not
// one endpoint with a flag. A flag is one typo away from handing every submitter
// the whole shop's spending.
//
// SUBMITTED FIRST AND OLDEST FIRST WITHIN IT, which is the opposite of every
// other list in this product and is right here: a queue is worked from the front,
// and the claim that has waited longest is the one somebody is waiting on. The
// decided ones follow, newest first, because that half is a record rather than a
// queue.
router.get('/api/retail-admin/staff-expenses/pending', requireRetailAdmin, requireApprover, (req, res) => {
  try {
    const db = tdb();
    const rows = db.prepare(`
      SELECT e.id, e.date, e.amount, e.category, e.note, e.paid_by, e.store_id,
             e.status, e.settled, e.submitted_at, e.decided_at, e.submitted_by,
             CASE WHEN e.receipt_data IS NULL THEN 0 ELSE 1 END AS has_receipt
        FROM staff_expenses e
       ORDER BY CASE WHEN e.status = 'submitted' THEN 0 ELSE 1 END,
                CASE WHEN e.status = 'submitted' THEN e.date END ASC,
                CASE WHEN e.status = 'submitted' THEN e.id END ASC,
                e.decided_at DESC, e.id DESC
       LIMIT 200`).all();

    // The names, resolved in one read rather than per row, through the same
    // `submitterNames` the decide route posts with — one lookup, so the name on
    // this queue and the name in the books cannot disagree.
    let names = new Map();
    try {
      // Every id either half of this payload will name. An owed person whose
      // last claim fell outside the 200-row queue would otherwise have a total
      // and no name against it.
      names = submitterNames(rows.map(r => r.submitted_by)
        .concat(db.prepare("SELECT DISTINCT submitted_by FROM staff_expenses WHERE status = 'approved' AND paid_by = 'employee' AND COALESCE(settled, 0) = 0").all().map(r => r.submitted_by)));
    } catch (e) { /* a name is a nicety; a claim without one still decides */ }

    // ── WHAT THE SHOP STILL OWES, BY PERSON (§87 step four) ──
    // ITS OWN QUERY, over every claim rather than the 200 above. A debt does not
    // stop existing because it fell off the end of a list, and a queue capped for
    // the screen's sake would quietly under-report what is owed — which is the
    // one number on this screen that is about money already spent.
    //
    // GROUPED BY PERSON, because that is how it is paid: one transfer to Wei,
    // not four. The rows behind each total travel with it so the screen can mark
    // them settled together.
    let owed = [];
    try {
      owed = db.prepare(`
        SELECT submitted_by, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n,
               GROUP_CONCAT(id) AS ids
          FROM staff_expenses
         WHERE status = 'approved' AND paid_by = 'employee' AND COALESCE(settled, 0) = 0
         GROUP BY submitted_by
         ORDER BY total DESC`).all();
    } catch (e) { owed = []; }

    res.json({
      success: true,
      data: {
        owed: owed.map(o => ({
          submitted_by: o.submitted_by,
          who: names.get(o.submitted_by) || null,
          total: fen(o.total),
          claims: o.n,
          // The rows behind the total, so the screen can settle them together —
          // one transfer to Wei, not four taps.
          ids: String(o.ids || ''),
        })),
        // WHOSE CLAIM IT IS, decided HERE rather than on the phone. §87 part
        // five allows an approver to approve their own claim and makes the
        // record the guard — so the row has to say so, and the server is the
        // only side that knows both facts for certain. The phone holds no
        // operator id at all (`state.me` carries a name and a role), so a client
        // that tried would quietly mark nothing, forever.
        rows: rows.map(r => ({
          ...r,
          amount: fen(r.amount),
          who: names.get(r.submitted_by) || null,
          mine: r.submitted_by != null && r.submitted_by === (req.user?.id || null),
        })),
        waiting: rows.filter(r => r.status === 'submitted').length,
      },
    });
  } catch (e) {
    console.error('[staff-expenses pending]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/retail-admin/staff-expenses/:id/decide ───────────────────────
// **THE TAP THAT PUTS MONEY IN THE BOOKS.** Approving posts one row into
// `expense_entries` carrying this claim's id; rejecting takes it back out. Both
// happen inside ONE transaction with the claim's own status, because a claim
// that says approved with no row behind it — or a row with no claim — is a
// discrepancy nobody would find until the month did not add up.
//
// SELF-APPROVAL IS ALLOWED, and it is Ash's decision (§87 part five): in a shop
// with one manager the person who spends and the person who approves are the
// same person, and a rule forbidding it produces an unusable screen rather than
// a second approver. **The guard is the record, not the refusal** — the approver
// is stored on the claim, shown on the row, and logged.
router.post('/api/retail-admin/staff-expenses/:id/decide', requireRetailAdmin, requireApprover, express.json(), async (req, res) => {
  try {
    const db = tdb();
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: ERR.notFound });
    const decision = String((req.body || {}).decision || '');
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: ERR.decision });
    }
    const claim = db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: ERR.notFound });

    // A SETTLED CLAIM IS FINISHED. Money has changed hands outside this system
    // — the employee has been paid back — and un-approving it would take the
    // expense out of the books while leaving the payment made. That is the one
    // state this route refuses, and it refuses it rather than warning.
    if (claim.settled) return res.status(409).json({ error: ERR.settled });

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const note = (req.body.note == null || req.body.note === '') ? null : String(req.body.note).slice(0, 500);
    const decidedBy = req.user?.id || null;

    // WHO SPENT IT, RESOLVED BEFORE THE TRANSACTION OPENS. §87: "who spent it is
    // in the description, because a ¥38 line with no supplier, no invoice and no
    // purchase order behind it is answerable months later only if it says whose
    // taxi it was." `claimDescription` has always read `submitted_name` — and
    // nothing ever set it, a `staff_expenses` row carrying only the integer id,
    // so every posted row in the books so far says the note and no name. The
    // fixture at scripts/test_staff_expenses.js passed the field by hand, which
    // is why the lib looked covered while the route was not.
    //
    // OUTSIDE THE TRANSACTION because it reads the CONTROL-PLANE handle: a
    // cross-handle read held open inside a tenant write is a second database's
    // latency added to a lock this one is holding, for a value the write does
    // not depend on.
    const submittedName = submitterNames([claim.submitted_by]).get(claim.submitted_by) || null;

    // AWAITED (§90's fix). This route was never `async` and never awaited this
    // call, which looked harmless because better-sqlite3 is synchronous — but
    // `withTransaction`'s outermost-transaction queue (lib/db-transaction.js
    // `acquire`) always defers the body to a later microtask via `.then()`, even
    // when nothing is queued ahead of it. Unawaited, `logActivity` and the
    // `after` read below ran on the SAME tick as this call, before a single
    // statement inside the transaction had executed — reporting the claim's
    // PRE-decision state back to the caller — and a throw inside it (the FK
    // ordering bug just above, on the reject-after-approve path) became an
    // unhandled rejection outside this function's own try/catch, bypassing
    // both the 500 response and the console.error below entirely.
    await withTransaction(db, (tx) => {
      // `expense_id` IS CLEARED HERE TOO (§90's fix, same root cause): rejecting
      // a claim that was PREVIOUSLY approved has this row's `expense_id` still
      // pointing at the `expense_entries` row postClaim is about to delete, and
      // schema.sql's FK on that column (REFERENCES expense_entries(id)) refuses
      // the delete while a live reference stands. Harmless on the ordinary path
      // (first-time approve or reject, where expense_id is already NULL) and set
      // back to the real value below when postClaim posts one.
      tx.prepare(`UPDATE staff_expenses
                     SET status = ?, decided_by = ?, decided_at = datetime('now'), decided_note = ?, expense_id = NULL
                   WHERE id = ?`).run(status, decidedBy, note, claim.id);
      // Posted from the row AS IT NOW STANDS, not from the one read above: the
      // status this decision just wrote is what decides whether a row exists.
      const fresh = tx.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(claim.id);
      // Set ONTO `fresh` rather than spread into a copy: the name is the one
      // fact the claim row cannot carry itself, and `postClaim(tx, fresh)` is
      // the shape the suite asserts — a `{ ...fresh }` here would fail it for no
      // behavioural reason at all.
      fresh.submitted_name = submittedName;
      const expenseId = postClaim(tx, fresh);
      tx.prepare('UPDATE staff_expenses SET expense_id = ? WHERE id = ?').run(expenseId, claim.id);
    });

    logActivity(req.user?.id || null, req.user?.username || null,
      decision === 'approve' ? 'approve' : 'reject', 'staff_expense', claim.id,
      { amount: fen(claim.amount), category: claim.category, self: claim.submitted_by === decidedBy },
      req.ip);
    const after = db.prepare('SELECT status, expense_id FROM staff_expenses WHERE id = ?').get(claim.id);
    res.json({ success: true, data: after });
  } catch (e) {
    console.error('[staff-expenses decide]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/retail-admin/staff-expenses/:id/void ─────────────────────────
// §90 — REVERSING A CLAIM THAT HAS ALREADY POSTED. Requested by Ash off the
// live Transactions screen: a "Staff claim" row carried no way to undo a
// mistaken approval, because `/finance/transactions` refuses to edit or delete
// a claim-posted row directly (routes/finance-transactions.js `claimEdit` /
// `claimDelete`) — any value typed there would be lost the next time the claim
// was decided. This is the route that undoes the DECISION instead, the same
// way `/decide` made it in the first place.
//
// STATUS BECOMES `voided`, NEVER `rejected`. Reusing `rejected` would read as
// though the claim was never approved — and would overwrite `decided_by`, the
// one field that says who approved it, the moment somebody reversed that call.
// `voided_by` / `voided_at` / `void_note` carry the reversal instead, beside
// the untouched approval record.
//
// GATED ON `expenses:cancel`, NOT `expenses:approve` — see requireCanceller.
router.post('/api/retail-admin/staff-expenses/:id/void', requireRetailAdmin, requireCanceller, express.json(), async (req, res) => {
  try {
    const db = tdb();
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: ERR.notFound });
    const claim = db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: ERR.notFound });

    // ONLY AN APPROVED, POSTED CLAIM CAN BE VOIDED — a submitted or already-
    // rejected one has nothing in the books to take back out, and `/decide`
    // is the route that handles either.
    if (claim.status !== 'approved') return res.status(409).json({ error: ERR.notApprovedVoid });
    // A SETTLED CLAIM IS FINISHED, for the same reason `/decide` refuses one:
    // the employee has already been paid back outside this system, and voiding
    // it would take the expense out of the books while leaving the payment
    // made.
    if (claim.settled) return res.status(409).json({ error: ERR.settled });

    const note = (req.body && req.body.note != null && req.body.note !== '')
      ? String(req.body.note).slice(0, 500) : null;
    const voidedBy = req.user?.id || null;

    // AWAITED — see the identical note on `/decide` above. Without it, the
    // response below reports the claim's PRE-void state (the exact bug Ash
    // reported: the client is told "voided", the row is still on the ledger,
    // and voiding it again is offered), and the FK error this route used to
    // throw before the fix above became an unhandled rejection nobody caught.
    await withTransaction(db, (tx) => {
      // `expense_id` IS CLEARED IN THE SAME UPDATE, BEFORE postClaim RUNS —
      // schema.sql's `FOREIGN KEY (expense_id) REFERENCES expense_entries(id)`
      // means the row postClaim is about to DELETE is still referenced by this
      // very column until it is nulled, and SQLite (foreign_keys=ON) refuses to
      // delete a row a live foreign key still points at. Found by actually
      // exercising this route end-to-end rather than trusting the unit-level
      // fixture, which declares no such constraint and so never caught it.
      tx.prepare(`UPDATE staff_expenses
                     SET status = 'voided', voided_by = ?, voided_at = datetime('now'), void_note = ?, expense_id = NULL
                   WHERE id = ?`).run(voidedBy, note, claim.id);
      // Posted from the row AS IT NOW STANDS, exactly as /decide does: the
      // status this just wrote is what decides whether a row exists, and
      // 'voided' takes the same branch 'rejected' does in postClaim — it
      // deletes the expense_entries row (now unreferenced) and returns null.
      const fresh = tx.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(claim.id);
      postClaim(tx, fresh);
    });

    logActivity(req.user?.id || null, req.user?.username || null, 'void', 'staff_expense', claim.id,
      { amount: fen(claim.amount), category: claim.category }, req.ip);
    const after = db.prepare('SELECT status, expense_id FROM staff_expenses WHERE id = ?').get(claim.id);
    res.json({ success: true, data: after });
  } catch (e) {
    console.error('[staff-expenses void]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/retail-admin/staff-expenses/:id/settle ───────────────────────
// Marks an approved own-money claim as paid back — or un-marks one.
//
// **IT WRITES ONE COLUMN AND POSTS NOTHING.** See the header.
//
// GATED ON `expenses:approve` RATHER THAN A KEY OF ITS OWN, and that is a
// decision rather than a shortcut: a third capability would gate a single toggle
// and would have to be granted to the same people, one more row in a matrix
// somebody has to understand. Saying "we have paid Wei back" is an assertion
// about money by the person who already decides money on this screen. If it ever
// needs to belong to a bookkeeper who is not an approver, that is when the key
// earns its place.
router.post('/api/retail-admin/staff-expenses/:id/settle', requireRetailAdmin, requireApprover, express.json(), (req, res) => {
  try {
    const db = tdb();
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: ERR.notFound });
    const claim = db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: ERR.notFound });

    // ONLY A DEBT CAN BE SETTLED. An approved claim paid on the company account
    // owes nobody; a claim still waiting might be rejected. Marking either as
    // paid back would put a number in the "we owe" column that was never owed —
    // and the refusal names which of the two it is, because "cannot settle" on
    // its own sends somebody looking for a permission problem.
    if (claim.status !== 'approved') return res.status(409).json({ error: ERR.notApproved });
    if (claim.paid_by !== 'employee') return res.status(409).json({ error: ERR.notOwed });

    // The default is TRUE so a bare call settles; the phone sends the flag
    // explicitly either way.
    const settled = req.body && req.body.settled === false ? 0 : 1;
    db.prepare("UPDATE staff_expenses SET settled = ?, settled_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?")
      .run(settled, settled, claim.id);

    logActivity(req.user?.id || null, req.user?.username || null,
      settled ? 'settle' : 'unsettle', 'staff_expense', claim.id,
      { amount: fen(claim.amount), owed_to: claim.submitted_by }, req.ip);
    res.json({ success: true, data: { id: claim.id, settled } });
  } catch (e) {
    console.error('[staff-expenses settle]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
