// A carrier's compensation becomes a ledger row (§98 stage four).
//
// THIS IS THE ONE PLACE A DELAY CASE REACHES THE BOOKS, and it is a file for
// the same reason `lib/expense-posting.js` is one: so a test can run it against
// an in-memory database instead of booting the app.
//
// ── THE SHAPE IS `postClaim`, DELIBERATELY ─────────────────────────────────
// A staff claim posts by DELETING every `expense_entries` row carrying its id
// and re-inserting from the document, so the ledger always says what the
// document currently says and no state can drift between the two. A delay case
// does exactly the same thing on `income_entries`, keyed on `delay_case_id`.
// That is why:
//
//   • `postDelayCase` is safe to call twice. Recording the same settlement
//     again re-posts the same row rather than adding a second one — and a route
//     guarding against double-posting with a status check instead would be a
//     second rule that has to agree with this one.
//   • Correcting a settlement REMOVES the row rather than writing a negative
//     one. A carrier that pays, then claws it back, then pays a different
//     figure would otherwise leave three rows for one payment; the case already
//     carries that history in `retail_delay_case_events`, and the ledger's job
//     is to say what is true now.
//
// ── NOT INCOME UNTIL IT LANDS, WHICH IS THE WHOLE POINT ────────────────────
// Only `dispute_state = 'paid'` posts. A claim that is merely FILED posts
// nothing, and one later rejected or withdrawn has its row taken out again.
// This is §87's rule for money out — a claim is not an expense because somebody
// asked — restated for money in, and it is the reason `income_entries` needed a
// `delay_case_id` at all rather than the case simply being summed somewhere.
//
// ── WHAT THE POSTED ROW IS, AND IS NOT ─────────────────────────────────────
// It is ordinary non-sale income, exactly the kind §36 names for this ledger
// (sublet space, sold equipment, supplier rebates). **It is NOT editable on the
// Transactions screen** — it is a projection, and `routes/finance-transactions.js`
// refuses it for the reason it refuses a purchase-order row and a claim row:
// any value typed onto one is lost the next time the document behind it is
// re-posted.
//
// **IT CARRIES NO CATEGORY, AND THAT IS THE DECISION.** The income category
// list "ships empty. No defaults" (§36, recorded in `routes/finance-transactions.js`)
// precisely so the form cannot offer a wrong option, and seeding one here to
// label carrier compensation would be this file quietly deciding a question
// that document says is the tenant's. The description carries the meaning.

'use strict';

const money = require('./money');
const { carrierByCode } = require('./tracking');

/**
 * The description the ledger row carries.
 *
 * WHAT IT COST US IS NOT IN HERE, and that is deliberate. Whether the carrier's
 * payment covered the replacement is a question about the CASE, which holds
 * both figures; a ledger row that quoted one of them would be asserting a
 * comparison the books cannot keep true when the case is later corrected.
 */
function caseDescription(c, order) {
  // WHICH CARRIER, WHICH CLAIM, WHICH ORDER. A bookkeeper reading "¥250" three
  // months from now has a row with no customer, no invoice and no purchase
  // order behind it; these three are what make it answerable.
  const bits = [];
  const carrier = c.dispute_carrier ? carrierByCode(c.dispute_carrier) : null;
  if (carrier) bits.push(carrier.name_en ? `${carrier.name_en} · ${carrier.name_cn}` : c.dispute_carrier);
  else if (c.dispute_carrier) bits.push(String(c.dispute_carrier));
  if (order && order.order_no) bits.push(String(order.order_no));
  if (c.dispute_ref) bits.push(String(c.dispute_ref));
  return bits.length ? bits.join(' · ') : null;
}

/** The business date the money is booked on. */
function caseDate(c) {
  // THE DAY THE CARRIER SETTLED, not the day the claim was filed and not today.
  // A claim filed in August and paid in September is September's income, and
  // `dispute_settled_at` is the only stamp that says so. DATE() because
  // `income_entries.date` is a DATE and a datetime here would sort oddly
  // against every hand-typed row beside it.
  const stamp = c.dispute_settled_at || c.dispute_filed_at || null;
  return stamp ? String(stamp).slice(0, 10) : null;
}

/**
 * Write (or re-write, or remove) the ledger row for one delay case.
 *
 * `db` is any better-sqlite3-shaped handle. `order` is optional and only
 * supplies the order number for the description. Returns the id of the row now
 * standing for this case, or null when there should not be one.
 *
 * THE DELETE RUNS EVEN WHEN NOTHING IS RE-INSERTED, which is what makes this
 * the remove path too: calling it for a case whose state is no longer 'paid'
 * takes the row out and returns null.
 */
function postDelayCase(db, c, order) {
  if (!c || !c.id) return null;
  db.prepare('DELETE FROM income_entries WHERE delay_case_id = ?').run(c.id);
  if (c.dispute_state !== 'paid') return null;

  // Rounded once, here, for the reason postClaim states: the figure has already
  // been through lib/delay-case.js's own rounding on the way in, and rounding
  // again costs nothing while a missing round on a REAL column is the seed of
  // the next discrepancy.
  const amount = money.round(c.dispute_received);
  if (!(amount > 0)) return null;

  const date = caseDate(c);
  if (!date) return null;

  const info = db.prepare(`
    INSERT INTO income_entries (date, amount, category, description, delay_case_id, created_by)
    VALUES (?,?,?,?,?,?)`)
    .run(date, amount, null, caseDescription(c, order), c.id,
         // WHO PUT IT IN THE BOOKS is whoever recorded the settlement — §92's
         // rule, and the same choice postClaim makes with the approver.
         c.settled_by_user_id || null);
  return info.lastInsertRowid;
}

/** The ledger row standing for a case right now, if there is one. */
function postedRow(db, caseId) {
  return db.prepare(
    'SELECT id, amount, date, description FROM income_entries WHERE delay_case_id = ?'
  ).get(caseId) || null;
}

module.exports = { postDelayCase, postedRow, caseDescription, caseDate };
