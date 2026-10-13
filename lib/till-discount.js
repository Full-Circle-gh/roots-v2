// §474 — a manager's hand discount at the counter till.
//
// Decided by Ash, 2026-10-13: "go, managers only, max 20%, reason required".
//
// PURE. No database, no request. The order route asks it one question — given
// what was posted and what the goods come to, how much comes off? — and the
// till asks the same arithmetic of its own copy (public/till.html,
// tillDiscountOff) so the figure on the glass is the figure charged. This file
// is the authority; the till's copy is a preview.
//
// THE BASE IS THE GOODS AFTER ANY VOUCHER, BEFORE TAX. A located voucher (§426)
// comes off first, because it is the shop's standing promotion, and the hand
// discount is a person's decision about what is left. Tax is then worked on
// what was actually charged, the same order the checkout uses.
//
// THE CEILING IS 20% OF THAT BASE, WHICHEVER WAY IT WAS ASKED FOR. A percentage
// above 20 is refused, and so is an amount worth more than 20% of the base —
// otherwise typing ¥40 off a ¥43 bill walks straight past the limit.

'use strict';

const MAX_PCT = 20;

// The fixed list a reason is picked from. 'other' needs a note in the cashier's
// own words; the rest are complete as they stand.
const REASONS = ['damaged', 'friends_family', 'complaint', 'other'];
const NOTE_MAX = 120;

const round2 = (n) => Math.round(n * 100) / 100;

// `input` is the body's `manual_discount`: { percent } or { amount }, plus
// { reason, note }. `base` is the goods after any voucher, in yuan.
// Returns { error } or { amount, percent, reason, note }. `percent` is null
// when an amount was typed.
function resolveManualDiscount(input, base) {
  if (!input || typeof input !== 'object') return { error: 'bad_manual_discount' };
  const reason = String(input.reason || '');
  if (REASONS.indexOf(reason) === -1) return { error: 'manual_discount_reason_required' };
  const note = String(input.note == null ? '' : input.note).trim().slice(0, NOTE_MAX);
  if (reason === 'other' && !note) return { error: 'manual_discount_reason_required' };

  const b = round2(Math.max(0, Number(base) || 0));
  if (!(b > 0)) return { error: 'bad_manual_discount' };
  const ceiling = round2(b * MAX_PCT / 100);

  const hasPct = input.percent != null && input.percent !== '';
  const hasAmt = input.amount != null && input.amount !== '';
  if (hasPct === hasAmt) return { error: 'bad_manual_discount' };   // exactly one

  let amount, percent = null;
  if (hasPct) {
    const p = Number(input.percent);
    if (!Number.isFinite(p) || p <= 0) return { error: 'bad_manual_discount' };
    if (p > MAX_PCT) return { error: 'manual_discount_over_limit', max_pct: MAX_PCT };
    percent = p;
    amount = round2(b * p / 100);
  } else {
    const a = Number(input.amount);
    if (!Number.isFinite(a) || a <= 0) return { error: 'bad_manual_discount' };
    amount = round2(a);
    if (amount > ceiling) return { error: 'manual_discount_over_limit', max_pct: MAX_PCT };
  }
  if (!(amount > 0)) return { error: 'bad_manual_discount' };
  return { amount, percent, reason, note: note || null };
}

module.exports = { MAX_PCT, REASONS, NOTE_MAX, resolveManualDiscount };
