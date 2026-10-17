'use strict';

const money = require('./money');

// ── Purchase returns — goods that arrived, were accepted, and went back ─────
//
// THE ONE DEFINITION SITE for what a return is and what it does to the three
// numbers a purchase line carries: the stock on the shelf, the money in the
// books, and the value we are still chasing a 发票 for. Four callers read this
// file — the retail receive route, the kitchen receive route, the invoice chase
// (routes/retail-purchasing.js) and the older finance summary (routes/
// finance.js) — and they must not each carry their own arithmetic. Before this
// existed the books and the invoice chase already disagreed: Finance billed
// COALESCE(qty_received, qty) while the chase billed the ORDERED qty, so a
// short delivery was expensed at what turned up and chased at what was asked
// for. Returns would have made a third answer. There is now one.
//
// ── The vocabulary, and it is deliberately small ────────────────────────────
//
//   ordered   po_line_items.qty            — what the order asked for
//   arrived   po_line_items.qty_received   — what turned up (NULL = not yet)
//   damaged   po_line_items.damaged_qty    — of what turned up, what was broken
//   accepted  arrived − damaged            — what we took onto the shelf
//   returned  po_line_items.returned_qty   — of what we accepted, what went back
//
// A RETURN IS DRAWN FROM `accepted`, NEVER FROM `damaged`. Both halves of that
// rule are load-bearing:
//
//   • Drawn from accepted, because those are the only units that were ever
//     ours to send back. Anything else double-counts: a unit that never
//     reached the shelf cannot leave it.
//   • Never from damaged, because a damaged unit is already its own quantity
//     and already excluded from stock. Letting a return draw from both would
//     need an allocation rule — "were those two the broken ones?" — that no
//     screen in this product can answer, and a wrong guess moves real stock.
//     Breakage the supplier makes good on is a CREDIT AGAINST THE DAMAGE, not a
//     return of stock; it is out of scope and recorded as such in
//     docs/purchase-returns.md rather than quietly folded in here.
//
// So a line can always be read straight down: ordered → arrived → damaged →
// returned, each one drawn from the one above it, and `accepted − returned` is
// what we still hold.
//
// ── The two derived quantities, and why they differ ─────────────────────────
//
//   billable  COALESCE(arrived, ordered) − returned   → Finance + the 发票 chase
//   onHand    arrived − damaged − returned            → the shelf
//
// They differ by `damaged`, and that gap is pre-existing, deliberate and NOT
// changed here: damaged units are kept out of stock and are still expensed in
// full, because the supplier was paid for them. Returns are subtracted from
// BOTH because a returned unit is neither on the shelf nor owed for.
//
// `billable` falls back to `ordered` while nothing has been received, which is
// what postPOExpenses has always done — a placed order books at what it asked
// for until a delivery says otherwise. Returns still subtract there, but the
// planner below makes that case unreachable: nothing can be returned before it
// has arrived.
//
// ── Cumulative, not incremental ─────────────────────────────────────────────
//
// returned_qty is the RUNNING TOTAL for the line, exactly as qty_received is.
// A payload states where the line now stands, never what to add, so re-saving a
// screen that already showed "3 returned" returns nothing further, and every
// consumer reads one column instead of replaying a history. The per-event
// movement is po_receipt_lines.returned_qty, written once per return.

// WHY it went back. Fixed and validated server-side, the same discipline
// RECEIPT_REASONS (routes/purchases.js) uses on a shortfall, so "what do we
// keep sending back to this supplier" is a countable question.
//
// DAMAGE IS NOT ON THIS LIST, for the reason the header gives — it is a
// quantity, not a reason, and this codebase has already refused it once for
// receipts (see the receipt_reason comment in database.js). `quality` is not a
// synonym for it: a returnable quality problem is one the goods arrived intact
// with, which is why it can be sent back at all.
const RETURN_REASONS = new Set([
  'wrong_item',     // not what was ordered
  'quality',        // arrived intact, not good enough to sell or cook with
  'expired',        // out of date, or too near it to use
  'over_delivery',  // more turned up than was ordered, surplus sent back
  'not_needed',     // ordered in error, supplier took it back
]);

// The present-vs-absent rule, once. An ABSENT key preserves what is stored; a
// key sent as null or '' clears the column. Every quantity on a receive payload
// obeys it, and it is the reason a caller that has never heard of returns — the
// mobile receive screen, an older client — can keep saving arrived counts
// without silently wiping a return somebody recorded on the desktop.
function resolveQty(stored, sent, { nullable = false } = {}) {
  if (sent === undefined) {
    if (stored == null) return nullable ? null : 0;
    return parseFloat(stored) || 0;
  }
  if (sent === null || sent === '') return nullable ? null : 0;
  return Math.max(0, parseFloat(sent) || 0);
}

// ── SQL ─────────────────────────────────────────────────────────────────────
// `billable` as a SQL expression, for the two places that sum money in the
// database rather than in JS. Takes the table alias so it can be dropped into a
// join or a bare FROM alike. Clamped at zero: the planner below refuses a
// return bigger than what arrived, but a row written before this rule existed
// must not be able to produce a negative expense.
const billableQtySql = (a = '') => {
  const p = a ? a + '.' : '';
  return `MAX(0, COALESCE(${p}qty_received, ${p}qty) - COALESCE(${p}returned_qty, 0))`;
};

// ── JS ──────────────────────────────────────────────────────────────────────
const num = v => parseFloat(v) || 0;

// What we accepted onto the shelf: what turned up, less what was broken. The
// ceiling on what can be returned, and null while nothing has been received —
// a line with no delivery has accepted nothing, which is not the same as zero.
function acceptedQty(line) {
  if (line.qty_received == null) return null;
  return Math.max(0, num(line.qty_received) - num(line.damaged_qty));
}

// What we owe the supplier for. Mirrors billableQtySql exactly; the two are
// tested against each other in scripts/test_purchase_returns.js.
function billableQty(line) {
  const base = line.qty_received == null ? num(line.qty) : num(line.qty_received);
  return Math.max(0, base - num(line.returned_qty));
}

// What of this line should be sitting on the shelf: accepted, less returned.
// applyReceivedToStock differences this against stock_applied_qty, so a return
// moves stock by exactly the same mechanism a corrected count does.
function onHandQty(line) {
  const accepted = acceptedQty(line);
  if (accepted == null) return null;
  return Math.max(0, accepted - num(line.returned_qty));
}

// ── What came back in money (§483) ──────────────────────────────────────────
//
// A return used to mean the supplier paid back every yuan the returned units
// cost. Often they do not: the goods go back and the freight stays with the
// supplier. Ash, off RPO-0092: one ¥47.80 tableware line sent back, freight not
// refunded, and Finance had taken the whole ¥47.80 off the order with no way
// to say otherwise — Finance shows order rows read-only, so the fix belongs on
// the order.
//
// po_line_items.return_refund is what actually came back for the returned
// units of the line. NULL means all of it, which is what every return meant
// before the column existed. Below the full value, the difference was KEPT by
// the supplier and is still a cost: the poster books it under 运费及杂费
// Freight & fees, beside the order's own landed extras, because that is what
// it is. The goods row itself still nets the full returned value — the units
// are gone either way — so the item's category says what the goods cost and
// the fee says what getting them back cost.

// The full value of what went back on a line, in MINOR units.
function returnValueMinor(line) {
  const q = num(line.returned_qty);
  if (!(q > 0)) return 0;
  const rate = money.toMicro(line.cost_per_unit);
  return rate == null ? 0 : (money.extendMicro(rate, q) || 0);
}

// What the supplier kept on a line's return, in MINOR units. Clamped at zero:
// the planner refuses a refund above the full value, but a later price edit
// must not turn a kept fee into a credit.
function keptOnReturnMinor(line) {
  if (line.return_refund == null) return 0;
  const refund = money.toMinor(line.return_refund) || 0;
  return Math.max(0, returnValueMinor(line) - refund);
}

// The kept part over every line of an order, in yuan — what the poster adds
// to the Freight & fees row.
function unrefundedReturns(h, poId) {
  const lines = h.prepare(`
    SELECT returned_qty, cost_per_unit, return_refund FROM po_line_items
     WHERE po_id = ? AND COALESCE(returned_qty, 0) > 0 AND return_refund IS NOT NULL`).all(poId);
  return money.fromMinor(money.sumMinor(lines.map(keptOnReturnMinor)));
}

// ── The planner ─────────────────────────────────────────────────────────────
// Resolves and REFUSES a payload's returns before the caller opens its write
// transaction, the same way planReceiptReasons does for shortfall reasons: a
// bad payload must never leave half a save behind.
//
// Returns { error, line_id } — the caller turns it into its own 400 shape — or
// { plans, increased, decreased, refunds }, where plans is a Map keyed by line_id:
//
//   { write, qty, reason, refund, delta, line }
//
// `write:false` means this payload said nothing about this line's returns and
// nothing about it may be written. `delta` is what moved on THIS save, which is
// what a return receipt records and what tells the caller a return happened at
// all. `refunds` counts lines whose refund (§483) changed, which moves money
// without moving a unit, so the caller must re-post on it too.
//
// TWO KINDS OF CALLER, AND THE SECOND IS WHY THE `write:false` BRANCH STILL
// VALIDATES. A returns-aware caller sends returned_qty and gets the rule
// enforced in both directions. A caller that has never heard of returns still
// sends arrived and damaged counts — and lowering either can push a stored
// return above what the line now says was accepted. That payload is refused
// rather than written, because the alternative is a line claiming it sent back
// more than it ever took in.
function planReturns(h, poId, receipts) {
  const plans = new Map();
  let increased = 0, decreased = 0, refunds = 0;
  // store_product_id / ingredient_id / stock_applied_qty ride along for the
  // caller that has to decide whether this return can come off a shelf before
  // it writes anything (planReturnRemoval, routes/retail-purchasing.js). They
  // are read here rather than re-read there so the check and the rule are
  // looking at one row, fetched once.
  const read = h.prepare(`
    SELECT id, qty, qty_received, damaged_qty, returned_qty, return_reason, name_en, name_cn,
           store_product_id, ingredient_id, stock_applied_qty, cost_per_unit, return_refund
      FROM po_line_items WHERE id = ? AND po_id = ?`);
  for (const r of receipts) {
    const lineId = parseInt(r.line_id, 10);
    if (!lineId) continue;
    const line = read.get(lineId, poId);
    if (!line) continue;

    // The line AS THIS SAVE WILL LEAVE IT — not as it stands now. A payload
    // that lowers the arrived count and records a return in the same breath has
    // to be judged against both, or the pair could pass one at a time and be
    // impossible together.
    const nextReceived = resolveQty(line.qty_received, r.qty_received, { nullable: true });
    const nextDamaged  = resolveQty(line.damaged_qty,  r.damaged_qty);
    const accepted = nextReceived == null ? null : Math.max(0, nextReceived - nextDamaged);

    const stored = num(line.returned_qty);
    // A payload that corrects only the refund (§483) restates the quantity it
    // leaves alone, so it is judged by the same rules as one that sent both.
    const sentQty = r.returned_qty === undefined && r.return_refund !== undefined
      ? stored : r.returned_qty;
    if (sentQty === undefined) {
      // Silent caller. Nothing to write — but a stored return it just
      // invalidated is still a refusal, not something to clamp away.
      if (stored > 0 && (accepted == null || stored > accepted)) {
        return { error: 'return_exceeds_received', line_id: lineId, line };
      }
      plans.set(lineId, { write: false, qty: stored, reason: line.return_reason, delta: 0, line,
                          next: { received: nextReceived, damaged: nextDamaged, accepted } });
      continue;
    }

    const qty = resolveQty(line.returned_qty, sentQty);
    if (!Number.isFinite(qty)) return { error: 'return_invalid', line_id: lineId, line };
    if (qty > 0 && accepted == null) {
      // Nothing has been received against this line, so there is nothing to
      // send back. Recording the return first and the delivery afterwards is
      // not a thing that happens in a warehouse, and allowing it would let a
      // negative expense stand on a line nobody has taken in.
      return { error: 'return_before_receipt', line_id: lineId, line };
    }
    if (accepted != null && qty > accepted) {
      return { error: 'return_exceeds_received', line_id: lineId, line };
    }

    // The reason, resolved the same way the quantity was: what the payload
    // says, else what the line already holds. A returns-aware screen re-sends
    // both on every save, so the stored fallback is for the caller that moves
    // only the quantity.
    const sentReason = r.return_reason;
    const reason = sentReason === undefined
      ? (line.return_reason || null)
      : ((sentReason == null || sentReason === '') ? null : String(sentReason));
    if (qty > 0) {
      if (!reason) return { error: 'return_reason_required', line_id: lineId, line };
      if (!RETURN_REASONS.has(reason)) return { error: 'return_reason_invalid', line_id: lineId, line };
    } else if (sentReason !== undefined && reason) {
      // A reason with nothing returned describes a return that did not happen.
      return { error: 'return_reason_not_applicable', line_id: lineId, line };
    }

    // What came back in money (§483). Same present-vs-absent rule as the
    // quantity: absent keeps what is stored, null or '' means "all of it".
    const sentRefund = r.return_refund;
    let refund = line.return_refund == null ? null : num(line.return_refund);
    if (sentRefund === null || sentRefund === '') refund = null;
    else if (sentRefund !== undefined) {
      const n = Number(sentRefund);
      if (!Number.isFinite(n) || n < 0) return { error: 'return_refund_invalid', line_id: lineId, line };
      refund = money.round(n);
    }
    if (qty > 0) {
      if (refund != null &&
          money.toMinor(refund) > returnValueMinor({ returned_qty: qty, cost_per_unit: line.cost_per_unit })) {
        return { error: 'return_refund_exceeds', line_id: lineId, line };
      }
    } else {
      // A refund with nothing returned describes money for a return that did
      // not happen — refused when sent, dropped with the return otherwise.
      if (sentRefund !== undefined && refund != null) {
        return { error: 'return_refund_not_applicable', line_id: lineId, line };
      }
      refund = null;
    }
    const storedRefund = line.return_refund == null ? null : num(line.return_refund);
    if (!money.sameMoney(refund, storedRefund) && !(refund == null && storedRefund == null)) refunds++;

    const delta = qty - stored;
    if (delta > 0) increased++;
    if (delta < 0) decreased++;
    // A line whose return is cleared loses its reason with it, so the two can
    // never contradict each other — the same pairing receipt_reason has with a
    // shortfall it no longer has.
    plans.set(lineId, { write: true, qty, reason: qty > 0 ? reason : null, refund, delta, line,
                        next: { received: nextReceived, damaged: nextDamaged, accepted } });
  }
  return { plans, increased, decreased, refunds };
}

// The lines of a PO that carry a return, for the screens that report them and
// for the stock pre-check below. Ordered as the PO reads.
function returnedLines(h, poId) {
  return h.prepare(`
    SELECT id, store_product_id, ingredient_id, name_en, name_cn, unit, cost_per_unit,
           qty, qty_received, damaged_qty, returned_qty, return_reason, returned_at
      FROM po_line_items
     WHERE po_id = ? AND COALESCE(returned_qty, 0) > 0
     ORDER BY sort_order, id`).all(poId);
}

module.exports = {
  RETURN_REASONS,
  resolveQty,
  billableQtySql,
  acceptedQty,
  billableQty,
  onHandQty,
  returnValueMinor,
  keptOnReturnMinor,
  unrefundedReturns,
  planReturns,
  returnedLines,
};
