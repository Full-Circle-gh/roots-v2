// Returns on money out — goods bought OUTSIDE a purchase order that went back
// to the seller, and the money that came back for them (§269).
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Ash, off the live Transactions screen: a staff claim for ¥19 of glass cups,
// approved and paid back, and then the cups went back to the shop they came
// from. Nothing on the screen could say so. Purchasing already has returns
// (lib/po-returns.js) — but only for goods bought on a purchase order. A claim
// or a hand-typed row had no way to record that the thing was given back.
//
// ── A RETURN IS ITS OWN ROW, NEVER AN EDIT ─────────────────────────────────
// The spend happened and, on a claim paid out of a pocket, the person was paid
// back for it. Editing the row to ¥0 would erase both facts, and the refund
// would land on somebody's card with nothing in the books to say where it went.
// So a return is a SECOND row on the date the money came back, and the original
// row is never touched.
//
// ── IT IS A NEGATIVE ROW IN `expense_entries`, ON PURPOSE ──────────────────
// Stored as money out with a negative amount, under the SAME category as the
// row it returns. That is the whole of how the totals come out right: every
// reader that sums `expense_entries` — the Summary, the category breakdown, the
// operating / non-operating split, the Transactions staircase, the CSV — nets
// the return against the spend without being told about it. The alternative, a
// side table, would need every one of those readers to remember to subtract it,
// and §87 part one records what happens on the day one of them forgets.
//
// It is NOT money in. A refund for cups is not revenue; filing it there would
// put ¥19 of "income" at the top of the Summary and leave ¥19 of cups in the
// costs, both wrong.
//
// ── WHAT IT CAN RETURN ─────────────────────────────────────────────────────
//   • a hand-typed money-out row      → `returns_entry_id` = that row's id
//   • a row posted by a staff claim   → `returns_claim_id` = the CLAIM's id
//
// THE CLAIM, NOT ITS LEDGER ROW. `postClaim` deletes and re-inserts a claim's
// row on every re-post (§146's re-filing among them), so the row's id changes
// under anything that points at it. The claim's id does not.
//
// NOT A PURCHASE-ORDER ROW. Those go back through Purchasing's own receive
// screen, which takes the units off stock as well as off the books. A second
// way to return the same thing would let one return be recorded twice.
//
// NOT A RETURN OF A RETURN, and not money in.
//
// ── WHO HOLDS THE MONEY (`return_settled`) ─────────────────────────────────
// Only meaningful on a claim the employee paid for themselves, because the
// seller refunds the card that paid — the employee's own.
//   • The claim NOT yet paid back: the return simply means the shop owes them
//     less. Nothing is waiting, so the return is stored settled (1).
//   • The claim ALREADY paid back: the employee now holds the shop's money.
//     The return is stored open (0) and shows as "owes the shop" in the owed
//     block until somebody marks it received.
// Settling or un-settling a claim (`/staff-expenses/:id/settle`) marks all its
// returns settled, which keeps one rule true: a return on an unsettled claim is
// always settled, so the owed arithmetic reads it exactly once.

'use strict';

const money = require('./money');
const { RETURN_REASONS } = require('./po-returns');

const ERR = {
  // Live, from routes/finance-transactions.js and routes/purchases.js.
  notFound:      'Not found · 未找到',
  date:          'date required · 日期必填',
  amount:        'amount must be positive · 金额必须大于零',
  reason:        'A return needs a reason · 退货需要填写原因',
  reasonInvalid: 'Unknown return reason · 退货原因无效',
  poEdit:        'PO-linked expenses cannot be edited directly · 关联采购单的支出不能直接编辑',
  // Composed by Claude, 2026-09-26 — see the vocabulary's §269 entry.
  tooMuch:       'A return cannot be more than was spent · 退货金额不能超过支出金额',
  hasReturns:    'This has a return recorded. Delete the return first · 该笔已登记退货，请先删除退货',
};

/** Is this ledger row itself a return? */
function isReturnRow(row) {
  return !!row && (row.returns_entry_id != null || row.returns_claim_id != null);
}

/** Which source a ledger row stands for: { claimId } or { entryId }. */
function sourceKey(row) {
  return row.claim_id != null ? { claimId: row.claim_id } : { entryId: row.id };
}

function whereFor(key) {
  return key.claimId != null
    ? { sql: 'returns_claim_id = ?', arg: key.claimId }
    : { sql: 'returns_entry_id = ?', arg: key.entryId };
}

/** How much has already gone back against a source, in MINOR units, positive. */
function returnedMinor(db, key) {
  const w = whereFor(key);
  const rows = db.prepare(`SELECT amount FROM expense_entries WHERE ${w.sql}`).all(w.arg);
  return -rows.reduce((t, r) => t + (money.toMinor(r.amount) || 0), 0);
}

function hasReturns(db, key) {
  const w = whereFor(key);
  return !!db.prepare(`SELECT 1 FROM expense_entries WHERE ${w.sql} LIMIT 1`).get(w.arg);
}

/** Validate a return payload. Returns { error } or the clean values. */
function readReturnBody(body) {
  const b = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { error: ERR.date };
  const minor = money.toMinor(b.amount);
  if (!(minor > 0)) return { error: ERR.amount };
  const reason = String(b.reason || '');
  if (!reason) return { error: ERR.reason };
  if (!RETURN_REASONS.has(reason)) return { error: ERR.reasonInvalid };
  const note = (b.note == null || String(b.note).trim() === '') ? null : String(b.note).slice(0, 500);
  return { date: String(b.date), minor, reason, note };
}

/**
 * Record a return against the money-out row `sourceId`.
 * Returns { error, status } or { id, amount }.
 */
function recordReturn(db, sourceId, body, userId) {
  if (!/^\d+$/.test(String(sourceId))) return { error: ERR.notFound, status: 404 };
  const src = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(sourceId);
  if (!src || isReturnRow(src)) return { error: ERR.notFound, status: 404 };
  if (src.po_id != null) return { error: ERR.poEdit, status: 400 };

  const v = readReturnBody(body);
  if (v.error) return { error: v.error, status: 400 };

  const key = sourceKey(src);
  let claim = null;
  if (key.claimId != null) {
    claim = db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(key.claimId);
    if (!claim || claim.status !== 'approved') return { error: ERR.notFound, status: 404 };
  }

  // WHAT IS LEFT TO RETURN, counted in minor units so ¥0.1 + ¥0.2 is ¥0.3.
  const left = (money.toMinor(src.amount) || 0) - returnedMinor(db, key);
  if (v.minor > left) return { error: ERR.tooMuch, status: 400 };

  // See the header: open only where an employee now holds a refund for a claim
  // they have already been paid back for.
  const open = claim && claim.paid_by === 'employee' && Number(claim.settled) === 1;

  const info = db.prepare(`
    INSERT INTO expense_entries
      (date, amount, category, description, payment_method, store_id,
       returns_entry_id, returns_claim_id, return_reason, return_settled, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(v.date, -money.fromMinor(v.minor), src.category || null,
         v.note || src.description || null, src.payment_method || null, src.store_id || null,
         key.entryId != null ? key.entryId : null,
         key.claimId != null ? key.claimId : null,
         v.reason, open ? 0 : 1, userId || null);
  return { id: info.lastInsertRowid, amount: money.fromMinor(v.minor), open };
}

/** Keep a source's returns on the source's category. */
function refileReturns(db, key, category) {
  const w = whereFor(key);
  db.prepare(`UPDATE expense_entries SET category = ? WHERE ${w.sql}`).run(category == null ? null : category, w.arg);
}

/** Settling or un-settling a claim absorbs every return on it (see header). */
function settleClaimReturns(db, claimId) {
  db.prepare('UPDATE expense_entries SET return_settled = 1 WHERE returns_claim_id = ?').run(claimId);
}

/**
 * What the shop owes each employee, NET of returns.
 *   unsettled claim → amount less everything returned on it
 *   settled claim   → minus whatever the employee still holds (open returns)
 * A negative total means the person owes the shop.
 */
const OWED_SQL = `
  SELECT c.submitted_by,
         SUM(CASE WHEN COALESCE(c.settled, 0) = 0
                  THEN c.amount + COALESCE(r.all_ret, 0)
                  ELSE COALESCE(r.open_ret, 0) END) AS total,
         COUNT(*) AS n,
         GROUP_CONCAT(c.id) AS ids
    FROM staff_expenses c
    LEFT JOIN (
      SELECT returns_claim_id AS cid,
             SUM(amount) AS all_ret,
             SUM(CASE WHEN COALESCE(return_settled, 1) = 0 THEN amount ELSE 0 END) AS open_ret
        FROM expense_entries
       WHERE returns_claim_id IS NOT NULL
       GROUP BY returns_claim_id) r ON r.cid = c.id
   WHERE c.status = 'approved' AND c.paid_by = 'employee'
     AND (COALESCE(c.settled, 0) = 0 OR COALESCE(r.open_ret, 0) <> 0)`;

/** Per claim: { returned, open } in yuan, positive, for the claims named. */
function returnsByClaim(db) {
  const out = new Map();
  for (const r of db.prepare(`
    SELECT returns_claim_id AS cid, -SUM(amount) AS returned,
           -SUM(CASE WHEN COALESCE(return_settled, 1) = 0 THEN amount ELSE 0 END) AS open
      FROM expense_entries WHERE returns_claim_id IS NOT NULL
     GROUP BY returns_claim_id`).all()) {
    out.set(r.cid, { returned: money.round(r.returned) || 0, open: money.round(r.open) || 0 });
  }
  return out;
}

module.exports = {
  ERR, isReturnRow, sourceKey, returnedMinor, hasReturns, readReturnBody,
  recordReturn, refileReturns, settleClaimReturns, OWED_SQL, returnsByClaim,
};
