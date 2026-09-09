// An approved claim becomes a ledger row (§87 step three).
//
// THIS IS THE ONE PLACE A STAFF CLAIM REACHES THE BOOKS, and it exists as a file
// so that a test can run it against an in-memory database rather than booting
// the app — the lesson lib/expense-claim.js's header records.
//
// ── THE SHAPE IS `postRetailPOExpenses`, DELIBERATELY ──────────────────────
// A purchase order posts by DELETING every `expense_entries` row carrying its
// id and re-inserting from the document, so the ledger always says what the
// document currently says and no state can drift between the two. A claim does
// exactly the same thing keyed on `claim_id`. That is why:
//
//   • `postClaim` is safe to call twice. Approving an already-approved claim
//     re-posts the same row rather than adding a second one — and a route that
//     tried to protect against double-posting with a status check instead would
//     be a second rule that has to agree with this one.
//   • Rejecting after approving REMOVES the row rather than writing a negative
//     one. §36 decided a hand-typed row is freely deletable because "mistakes
//     here are typos"; a claim approved by accident is the same kind of mistake,
//     and an offsetting entry would turn a two-row ledger into four rows nobody
//     can read.
//
// ── WHAT THE POSTED ROW IS, AND IS NOT ─────────────────────────────────────
// It is an ordinary operating expense: it sums into the Summary, it appears in
// the category breakdown, and if the tenant has marked its category
// non-operating (§87 part two) it drops out of the operating total exactly as a
// typed row would. **It is NOT editable on the Transactions screen** — it is a
// projection, and `routes/finance-transactions.js` refuses it for the reason it
// refuses a PO row: any value typed onto one is lost the next time the document
// it belongs to is re-posted.

'use strict';

const money = require('./money');

/** The description the ledger row carries. */
function claimDescription(claim) {
  // WHO SPENT IT IS PART OF WHAT THE ROW MEANS. A bookkeeper reading "¥38,
  // Transport" three months from now is looking at a line that has no supplier,
  // no invoice and no purchase order behind it; the name is what makes it
  // answerable. The note follows it when there is one.
  const who = claim.submitted_name || claim.submitted_by_name || null;
  const bits = [];
  if (who) bits.push(who);
  if (claim.note) bits.push(claim.note);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * Write (or re-write) the ledger row for an approved claim.
 *
 * `db` is any better-sqlite3-shaped handle — the tenant handle in production, a
 * fixture in a test. Returns the id of the row now standing for this claim.
 *
 * THE DELETE RUNS EVEN WHEN NOTHING IS RE-INSERTED, which is what makes this the
 * remove path too: `postClaim(db, claim)` for a claim whose status is no longer
 * 'approved' takes the row out and returns null.
 */
function postClaim(db, claim) {
  db.prepare('DELETE FROM expense_entries WHERE claim_id = ?').run(claim.id);
  if (claim.status !== 'approved') return null;

  // ROUNDED ONCE, HERE, for the reason postRetailPOExpenses states: the amount
  // has already been through fen() on the way in, and rounding again costs
  // nothing while a missing round on a REAL column is the seed of the next
  // discrepancy.
  const amount = money.round(claim.amount);
  if (!(amount > 0)) return null;

  const info = db.prepare(`
    INSERT INTO expense_entries
      (date, amount, category, description, payment_method, store_id, claim_id, created_by)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(claim.date, amount, claim.category || null, claimDescription(claim),
         claim.payment_method || null, claim.store_id || null, claim.id,
         // THE LEDGER ROW IS CREATED BY THE PERSON WHO APPROVED IT, not by the
         // person who spent the money. `created_by` on this table has always
         // meant "who put this in the books", and the approver is who did.
         // Who spent it is in the description and on the claim.
         claim.decided_by || null);
  return info.lastInsertRowid;
}

/** The ledger row standing for a claim right now, if there is one. */
function postedRow(db, claimId) {
  return db.prepare('SELECT id, amount, date, category FROM expense_entries WHERE claim_id = ?').get(claimId) || null;
}

module.exports = { postClaim, postedRow, claimDescription };
