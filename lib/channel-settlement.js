'use strict';

// ONE statement of what a channel order's money has to add up to, and one
// vocabulary for the ways it doesn't.
//
//     subtotal + packing + delivery − merchant discount = total
//
// The identity is not a nicety. `total` is the refund ceiling (routes/retail.js
// orderTenders) and the figure the drawer banners, while the four components are
// what the Settlement panel prints; when they disagree the operator is shown a
// sum that is not the number they can act on. The admin panel
// (public/retail-admin/04-orders.js channelMoneyBreakdown) has enforced this
// since PR #206 by refusing to print a commission or an income figure over an
// unreconciled total — correctly, but silently: "Breakdown incomplete" named
// neither which term was wrong nor that anything had gone wrong at all until
// somebody happened to open that one order's drawer.
//
// EL20260903163199 is why this file exists. 45.00 + 1.50 + 5.00 − 5.50 = 46.00
// against a recorded total of 41.00: a ¥5.00 gap, exactly the delivery fee, and
// 45.00 + 1.50 − 5.50 = 41.00 to the cent. Three different faults produce that
// row — a delivery fee the customer was never charged, a discount larger than
// the one term we capture, or a `total` read out of a delivery-free field — and
// nothing on the row, in the log or in the archive could tell them apart weeks
// later. classify() below names the shape at ingest, while the payload that
// produced it is still in hand.
//
// Server-side (CommonJS) on purpose. The browser panel keeps its own copy of the
// arithmetic because retail-admin loads plain <script> tags with no module
// system; scripts/test_channel_money_panel.js runs both over the same table of
// cases so the two cannot drift apart unnoticed.

// Money is compared at cent resolution everywhere in this codebase; a float sum
// of four decimals lands on 45.999999999999996 often enough to matter.
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Two figures are the same money if they agree to the cent. Not `===`: the
// components are summed, the total is stored, and the two arrive by different
// arithmetic.
const CENT = 0.005;
const sameMoney = (a, b) => Math.abs(a - b) < CENT;

// Does this order's own money close? Returns null when it does — the caller's
// happy path is "nothing to report" — and otherwise the gap with a name for its
// shape.
//
// Takes the row as the DATABASE holds it (snake_case, channel_discount NULL when
// no promotion was ever recorded), not the parser's camelCase order, because the
// row is what the drawer reads and therefore what has to reconcile. A missing
// discount is 0 for the arithmetic and still `null` for the diagnosis: "no
// promotion" and "a promotion nobody captured" produce the same sum and need
// very different fixes.
function settlementGap(row) {
  if (!row) return null;
  const items    = num(row.subtotal);
  const packing  = num(row.packing_fee);
  const delivery = num(row.shipping_fee);
  const discount = num(row.channel_discount);
  const total    = num(row.total);
  // A row with no total is not a disagreement about money, it is the absence of
  // one — ingest has its own order_total_mismatch path for that and reporting it
  // twice under two names helps nobody.
  if (total <= 0) return null;

  const expected = r2(items + packing + delivery - discount);
  const gap      = r2(expected - total);
  if (sameMoney(gap, 0)) return null;

  return {
    items, packing, delivery, total,
    // Preserved as given: null means "never recorded", which is the distinction
    // the classifier turns on.
    discount: row.channel_discount == null ? null : discount,
    expected, gap,
    kind: classify({ items, packing, delivery, total, gap, discount: row.channel_discount }),
  };
}

// Which fault produced this gap. Ordered most specific first: an exact match
// against a term we actually hold is stronger evidence than "something is
// missing", and a scale slip has to be caught before it is described as a
// discount the size of a house.
//
// These names are written to eleme_sync_log and read by
// scripts/diagnose_channel_settlement.js. They are a diagnosis, not a verdict —
// every one of them still needs the archived payload to confirm — so each is a
// hypothesis the log entry carries alongside the numbers that suggested it.
function classify({ items, packing, delivery, total, gap, discount }) {
  // A ×100 / ÷100 unit slip anywhere in the components. Named first because it
  // dwarfs every other explanation and needs none of them.
  if (total > 0) {
    const ratio = r2(items + packing + delivery) / total;
    if (Math.abs(ratio - 100) < 1)      return 'scale_x100';
    if (Math.abs(ratio - 0.01) < 0.0001) return 'scale_div100';
  }
  // The components overshoot the total by exactly one fee we recorded. The fee
  // is real — the platform sent it — but the customer was not charged it, so it
  // does not belong in a sum that is supposed to reach what they paid. Free
  // delivery and merchant-borne 配送费 both land here.
  if (delivery > 0 && sameMoney(gap, delivery)) return 'delivery_not_billed';
  if (packing  > 0 && sameMoney(gap, packing))  return 'packaging_not_billed';
  // The components overshoot and no promotion was ever recorded. The single
  // term that reduces a bill is the one we don't have.
  if (gap > 0 && discount == null) return 'discount_unrecorded';
  // A promotion IS recorded and the components still overshoot: the platform
  // discounted more than the one field we read (a delivery-fee waiver sits
  // outside merchantActivityInfo, for instance).
  if (gap > 0) return 'discount_understated';
  // The total is LARGER than everything we hold adds up to — a component that
  // was never captured at all, or a total read off the wrong field.
  return 'total_above_components';
}

// One line for a human, for the sync log's error_msg column and any diagnostic
// that prints these. The numbers first: whoever reads this needs to check the
// arithmetic themselves, and a label they can't verify is worth nothing.
function describeSettlementGap(g) {
  if (!g) return '';
  const m = (n) => `¥${Number(n).toFixed(2)}`;
  const disc = g.discount == null ? 'no discount recorded' : `− ${m(g.discount)} discount`;
  return `${m(g.items)} + ${m(g.packing)} packing + ${m(g.delivery)} delivery (${disc})` +
         ` = ${m(g.expected)}, but the order records ${m(g.total)}` +
         ` — ${m(Math.abs(g.gap))} ${g.gap > 0 ? 'unaccounted for' : 'unexplained on the total'} (${g.kind})`;
}

module.exports = { settlementGap, describeSettlementGap, r2, sameMoney };
