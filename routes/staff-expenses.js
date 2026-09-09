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

    // The names, resolved in one read rather than per row. `tenant_users` lives
    // on the CONTROL-PLANE handle, not the tenant one — the claim carries only
    // the id, so a join is not available and would be wrong if it were.
    const names = new Map();
    try {
      // Every id either half of this payload will name. An owed person whose
      // last claim fell outside the 200-row queue would otherwise have a total
      // and no name against it.
      const ids = [...new Set(rows.map(r => r.submitted_by)
        .concat(db.prepare("SELECT DISTINCT submitted_by FROM staff_expenses WHERE status = 'approved' AND paid_by = 'employee' AND COALESCE(settled, 0) = 0").all().map(r => r.submitted_by))
        .filter(Boolean))];
      if (ids.length) {
        const q = require('../database').prepare(
          `SELECT id, display_name, username FROM tenant_users WHERE id IN (${ids.map(() => '?').join(',')})`);
        for (const u of q.all(...ids)) names.set(u.id, u.display_name || u.username);
      }
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
router.post('/api/retail-admin/staff-expenses/:id/decide', requireRetailAdmin, requireApprover, express.json(), (req, res) => {
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

    withTransaction(db, (tx) => {
      tx.prepare(`UPDATE staff_expenses
                     SET status = ?, decided_by = ?, decided_at = datetime('now'), decided_note = ?
                   WHERE id = ?`).run(status, decidedBy, note, claim.id);
      // Posted from the row AS IT NOW STANDS, not from the one read above: the
      // status this decision just wrote is what decides whether a row exists.
      const fresh = tx.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(claim.id);
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
