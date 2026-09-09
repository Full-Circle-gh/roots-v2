// What a staff expense claim must be, before it is a row (§87 step two).
//
// PURE, AND THAT IS THE POINT OF IT BEING A FILE. The rules below are a closed
// set, a rounding and two size limits — the kind of thing a grep can be made to
// pass while the code is wrong — so they have to be runnable by a test without
// booting an express app and a database behind it. `routes/staff-expenses.js`
// requires this; nothing else here knows the route exists.
//
// The one argument that is not a value is `dbHandle`, and it is passed rather
// than opened: `storeCategory` snaps a typed category onto the tenant's own
// list, which means reading it. Any better-sqlite3-shaped handle does, and a
// handle that cannot answer is not fatal — the category still normalises, which
// is the half that matters (see lib/category-text.js).

'use strict';

const { storeCategory } = require('./category-text');
const { fen } = require('./finance-window');

// WHO PAID, and there are exactly two answers. It is the field that decides
// whether the business owes somebody money, so it is a closed set rather than
// free text: a third spelling of "my own money" would be a debt nobody could
// query for.
const PAID_BY = new Set(['company', 'employee']);

// A receipt rides in the row as a base64 data URI, the shape
// `supplier_documents.data` already uses in this schema. THE CEILING IS HERE
// RATHER THAN NOWHERE: a phone camera writes 4–8 MB by default, base64 adds a
// third again, and a year of those is a tenant database nobody can copy. The
// phone downscales before it sends; this is the backstop for a client that does
// not, and it REFUSES rather than truncating — half a photograph stored is a
// receipt that cannot be read and a claim that looks like it has one.
const RECEIPT_MAX = 2 * 1024 * 1024;
const RECEIPT_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;

// A note is a line about one purchase, not a document.
const NOTE_MAX = 500;

const ERR = {
  date:    'date required · 日期必填',
  amount:  'amount must be positive · 金额必须大于零',
  paidBy:  'say who paid · 请选择付款方式',
  receipt: 'that photo is not an image the app can read · 无法读取该照片',
  tooBig:  'that photo is too large · 照片过大',
};

/**
 * Validate and normalise a submitted claim.
 * Returns `{ error }` or the clean values ready for the INSERT.
 */
function readBody(body, dbHandle) {
  const b = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { error: ERR.date };

  // fen() BEFORE the row is stored, never after it is read — the rule
  // routes/finance-transactions.js states and the reason it states it: a REAL
  // residue saved once is inherited by every later reader, and this row is
  // destined to become a ledger row.
  const amount = fen(b.amount);
  if (!(amount > 0)) return { error: ERR.amount };

  const paidBy = String(b.paid_by || '');
  if (!PAID_BY.has(paidBy)) return { error: ERR.paidBy };

  // The same normalisation every finance category gets, snapped against the
  // tenant's own `kind='accounting'` list (§87 part two). A claim typed against
  // a category the tenant has not listed still STORES — the list is what the
  // form offers, never a vocabulary the writer enforces — but it stores
  // normalised, so it can never arrive as a second spelling of a listed one.
  const category = storeCategory(dbHandle, b.category, 'accounting');

  let receipt = null;
  if (b.receipt_data) {
    receipt = String(b.receipt_data);
    if (!RECEIPT_RE.test(receipt)) return { error: ERR.receipt };
    if (receipt.length > RECEIPT_MAX) return { error: ERR.tooBig };
  }

  const note = (b.note == null || b.note === '') ? null : String(b.note).slice(0, NOTE_MAX);
  const storeId = /^\d+$/.test(String(b.store_id || '')) ? Number(b.store_id) : null;
  const method = (b.payment_method == null || b.payment_method === '') ? null : String(b.payment_method);
  return { date: String(b.date), amount, category, note, paidBy, storeId, method, receipt };
}

module.exports = { readBody, PAID_BY, RECEIPT_MAX, RECEIPT_RE, NOTE_MAX, ERR };
