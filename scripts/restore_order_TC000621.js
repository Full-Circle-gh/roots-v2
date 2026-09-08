#!/usr/bin/env node
/**
 * One-off: bring order TC000621 (id 1727) back to life as PAID.
 *
 * Ash's instruction, 2026-09-08: "bring it back … not canceled and already paid
 * with points … i deduct the points manually … bring it back, status paid,
 * dont change the revenue."
 *
 * ── WHAT ACTUALLY HAPPENED TO IT ──────────────────────────────────────────
 * Read off the live database on 2026-09-08 (scripts/diagnose_order_TC000621.js,
 * ro-query run 34191558375). The drawer says "Cancelled", but this order was
 * never paid through the gateway and never reached `paid`:
 *
 *   placed_at        2026-09-08 05:16:19   pickup, Tianhe, booked Wed 9/9 11:00
 *   subtotal ¥935 · packing ¥1.50 · 10 pts redeemed (¥10) · TOTAL ¥926.50
 *   paid_at          NULL                  ← never settled
 *   cancelled_at     2026-09-08 05:32:02
 *   cancelled_reason 'reservation_expired' ← lib/inventory.js sweepExpiredReservations
 *
 * So this is an UNPAID order the reservation sweeper auto-cancelled sixteen
 * minutes after it was placed. The sweeper expired its stock reservations,
 * flipped the order to cancelled, set its pending payment row to 'cancelled',
 * and the redeemed 10 points were returned to the customer (points row 1333,
 * 'refund_redeem', 05:32:02).
 *
 * The money then came in off-app: at 05:33 and 05:34 the customer's wallet was
 * moved to points and 926 points were taken off by hand — points row 1335,
 * 'admin_adjust', −926, "[warehouse] order payment". THAT is the payment. It is
 * already done, and it is not this script's business.
 *
 * ── WHAT THIS WRITES — the order row, five columns ────────────────────────
 *
 *     status           'cancelled' -> 'paid'
 *     paid_at          NULL -> CURRENT_TIMESTAMP   (COALESCE'd: never overwritten)
 *     cancelled_at     -> NULL
 *     cancelled_reason -> NULL
 *     updated_at       -> CURRENT_TIMESTAMP
 *
 * and one activity_log row recording the flip, because the sweeper's cancel left
 * no log entry and a status change nobody can trace is how the next person gets
 * this wrong.
 *
 * ── WHAT IT DOES NOT TOUCH, AND WHY ───────────────────────────────────────
 *
 *   • MONEY. subtotal ¥935, total ¥926.50, points_amount ¥10 are read and
 *     printed, never written. "Don't change the revenue" — the order carries
 *     the same figures out of this as it carried in.
 *   • POINTS. The 10 returned on cancel and the 926 deducted by hand both stand.
 *     Ash is doing the points by hand; this touches no ledger row and no
 *     customer balance. It prints them so the manual side can be checked
 *     against real numbers.
 *   • THE PAYMENT ROW (retail_payments 1091: wechat, ¥926.50, status
 *     'cancelled', out_trade_no 'FCTC000621', no transaction_id, never
 *     completed). Left exactly as it is, and that is deliberate rather than
 *     lazy: settling it as a successful 'wechat' payment would make
 *     isGatewayPayment() true — non-offline method, WX-prefixed out_trade_no —
 *     and a later refund or cancel would then fire a REAL WeChat refund against
 *     a transaction WeChat has never seen. routes/retail.js documents exactly
 *     that failure (502 '订单不存在', order un-refundable by any amount). No
 *     money ever reached the gateway here, and the row should keep saying so.
 *   • STOCK. Nothing is deducted here. The sweeper expired this order's
 *     reservations, so it now holds none — it is an unreserved order, and the
 *     first forward click (Preparing / Dispatched) runs
 *     prepareCommitUnreservedOrder and takes the 12 units off then, the same
 *     path every scheduled-ahead order uses. That is the right seam for it;
 *     doing it here would double-count against that click.
 *
 * ── WHAT COMING BACK COSTS, said plainly ──────────────────────────────────
 * Revenue and order-count queries filter `status NOT IN ('cancelled','refunded',
 * 'pending_payment')` and sum `subtotal`. A restored order therefore adds ¥935
 * of subtotal to revenue — unavoidably, because that is what "not cancelled"
 * means here, and it is the ¥935 the order always carried. Nothing rewrites it.
 * The figure is printed before the write so it is a known number.
 *
 * Earn-points and lifetime_spend are NOT awarded (awardOrderPoints does not run
 * on this path), no receipt prints, and no WeCom/customer notification fires.
 * This is a repair, not a sale being rung up.
 *
 * Idempotent: the UPDATE is guarded `WHERE status = 'cancelled'`, so a second
 * run changes nothing and says so. Refuses outright if the order has acquired
 * any refund record since this was written.
 *
 * Run ON THE SERVER, against data/roots.db. Default is dry-run.
 *
 *   node scripts/restore_order_TC000621.js          # dry run — prints, writes nothing
 *   node scripts/restore_order_TC000621.js --apply  # write
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ORDER_NO = 'TC000621';
const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const J = (x) => JSON.stringify(x, null, 2);
const num = (x) => Math.round((Number(x) || 0) * 100) / 100;

const o = db.prepare('SELECT * FROM retail_orders WHERE order_no = ?').get(ORDER_NO);
if (!o) { console.error('NOT FOUND:', ORDER_NO, 'in', dbPath); process.exit(1); }

console.log('db: ' + dbPath);
console.log('');
console.log('BEFORE — order ' + ORDER_NO + ' (id ' + o.id + ', customer ' + o.customer_id + ')');
console.log(J({
  status: o.status,
  placed_at: o.placed_at, paid_at: o.paid_at,
  cancelled_at: o.cancelled_at, cancelled_reason: o.cancelled_reason,
  subtotal: o.subtotal, packing_fee: o.packing_fee, shipping_fee: o.shipping_fee,
  points_used: o.points_used, points_amount: o.points_amount, points_earned: o.points_earned,
  balance_used: o.balance_used, voucher_code: o.voucher_code, total: o.total,
  payment_method: o.payment_method, channel: o.channel,
  fulfillment_type: o.fulfillment_type, scheduled_for: o.scheduled_for,
  refund_status: o.refund_status, refund_amount_paid: o.refund_amount_paid,
}));
console.log('');

if (o.status !== 'cancelled') {
  console.log('Order is already "' + o.status + '" — nothing to do. '
    + '(This script only lifts THIS cancelled order to paid.)');
  process.exit(0);
}

// ── Refuse if the picture has moved since this was written ──────────────────
// Every refund column was NULL and the single payment row was 'cancelled' when
// this was surveyed. If any of that has changed, a refund happened in between
// and the right answer is no longer "flip the status" — stop and look.
const payments = db.prepare(
  `SELECT id, method, amount, status, out_trade_no, transaction_id,
          COALESCE(refunded_amount, 0) AS refunded_amount, completed_at
     FROM retail_payments WHERE order_id = ? ORDER BY id`
).all(o.id);
const refundTouched =
  !!o.refund_status || !!o.refund_payout_ref ||
  num(o.refund_amount_paid) > 0 || num(o.refund_amount_approved) > 0 ||
  num(o.refund_amount_requested) > 0 ||
  payments.some((p) => p.status === 'refunded' || num(p.refunded_amount) > 0);
if (refundTouched) {
  console.error('REFUSING — this order now carries a refund record, which it did not when this '
    + 'script was written. Flipping the status is no longer the whole answer. Look first.');
  console.error(J({
    refund_status: o.refund_status,
    refund_amount_requested: o.refund_amount_requested,
    refund_amount_approved: o.refund_amount_approved,
    refund_amount_paid: o.refund_amount_paid,
    refund_payout_ref: o.refund_payout_ref,
    payments,
  }));
  process.exit(1);
}

// ── The things that stay as they are, printed so they can be checked ────────
console.log('PAYMENT ROWS — left exactly as they are (no gateway money ever moved):');
console.log(J(payments));
console.log('');
console.log('POINTS LEDGER for this order — NOT touched here:');
console.log(J(db.prepare(
  `SELECT id, customer_id, delta, balance_after, source, note, created_at
     FROM retail_points_transactions WHERE order_id = ? ORDER BY id`).all(o.id)));
if (o.customer_id) {
  console.log('CUSTOMER standing — NOT touched here: ' + J(db.prepare(
    `SELECT id, phone, points_balance, balance, lifetime_spend, tier_key
       FROM retail_customers WHERE id = ?`).get(o.customer_id)));
  console.log('Their last 5 points rows — NOT touched here: ' + J(db.prepare(
    `SELECT id, order_id, delta, balance_after, source, note, created_at
       FROM retail_points_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 5`
  ).all(o.customer_id)));
}
console.log('');

const items = db.prepare(
  `SELECT product_id, name_en, qty FROM retail_order_items WHERE order_id = ? ORDER BY id`
).all(o.id);
console.log('UNITS — reservations already expired; NOT deducted here. The first Preparing/'
  + 'Dispatched click runs prepareCommitUnreservedOrder and takes them off then:');
console.log(J(items));
console.log('');

console.log('REVENUE EFFECT — this order re-enters revenue/order-count queries at subtotal ¥'
  + num(o.subtotal).toFixed(2) + ' (order total ¥' + num(o.total).toFixed(2) + '). Nothing rewrites it.');
console.log('');

if (!WRITE) {
  console.log('DRY RUN — would set status="paid", paid_at=now, cancelled_at=NULL, '
    + 'cancelled_reason=NULL, and log the flip. Re-run with --apply to write.');
  process.exit(0);
}

// ── Write ───────────────────────────────────────────────────────────────────
// tenant_id on activity_log is the account this history belongs to. This order
// lives in the shared roots.db, which is Roots — tenant 1, written NULL by
// everything older than that column (see schema.sql). Copy this order's own
// most recent log row where there is one, so the restore lands beside the acts
// it follows rather than guessing.
const priorLog = db.prepare(
  `SELECT tenant_id FROM activity_log
    WHERE entity_type = 'retail_order' AND entity_id = ? ORDER BY id DESC LIMIT 1`
).get(o.id);

let changes = 0;
db.transaction(() => {
  changes = db.prepare(
    `UPDATE retail_orders
        SET status           = 'paid',
            paid_at          = COALESCE(paid_at, CURRENT_TIMESTAMP),
            cancelled_at     = NULL,
            cancelled_reason = NULL,
            updated_at       = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'cancelled'`
  ).run(o.id).changes;
  if (changes) {
    db.prepare(
      `INSERT INTO activity_log (user_id, username, action, entity_type, entity_id, details, tenant_id)
       VALUES (NULL, 'script', 'status_change', 'retail_order', ?, ?, ?)`
    ).run(o.id, JSON.stringify({
      from: 'cancelled', to: 'paid',
      was_cancelled_reason: o.cancelled_reason,
      reason: 'restored_by_hand — paid off-app in points (admin_adjust −926, "[warehouse] order payment")',
      script: 'scripts/restore_order_TC000621.js',
      untouched: ['money', 'points ledger', 'retail_payments', 'stock'],
    }), priorLog ? priorLog.tenant_id : null);
  }
})();

console.log('Rows updated: ' + changes);
console.log('AFTER: ' + J(db.prepare(
  `SELECT id, order_no, status, placed_at, paid_at, cancelled_at, cancelled_reason,
          subtotal, total, points_used, points_amount, balance_used,
          refund_status, updated_at
     FROM retail_orders WHERE id = ?`).get(o.id)));
