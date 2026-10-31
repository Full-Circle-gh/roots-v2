#!/usr/bin/env node
/**
 * One-off: bring counter order TC001037 (id 2441) back from Cancelled to UNPAID.
 *
 * Ash's instruction, 2026-10-10: "not cancelled bring it back on unpaid".
 *
 * ── WHAT ACTUALLY HAPPENED TO IT ──────────────────────────────────────────
 * Read off the live database on 2026-10-10 (scripts/diagnose_order_TC001037.js,
 * ro-query run 38030207186):
 *
 *   counter sale, Yuexiu (store 2), QR from a table, pick-up number 4
 *   subtotal ¥87 · total ¥87 · payment_method 'offline' · no customer
 *   placed_at        2026-10-10 05:36:34  (1:36 PM local)
 *   paid_at          NULL                 ← never settled
 *   cancelled_at     2026-10-10 05:57:23  (20.8 minutes later)
 *   cancelled_reason 'counter_unpaid_timeout'
 *
 * Nobody cancelled it. The counter clock in lib/inventory.js
 * (sweepExpiredReservations, Ash's 20-minute ruling of 2026-09-06) did: a
 * counter order still pending_payment 20 minutes after placed_at is cancelled.
 * In the same step it set the offline payment row (1506) to 'cancelled' and
 * released the order's four stock holds (Small Bites Selection and the three
 * bites picked inside it). No points, voucher or wallet money was on the order,
 * so the reversal helpers had nothing to give back.
 *
 * ── THE CLOCK HAS TO BE RESET, OR THIS UNDOES ITSELF IN A MINUTE ──────────
 * The sweeper runs every 60 seconds and keys on placed_at, which is already 20
 * minutes past. Put back to pending_payment with placed_at untouched, the very
 * next tick cancels it again. So placed_at is moved to the moment of this
 * repair, which gives the till a fresh 20 minutes to take the payment. The old
 * value is kept in the activity_log row this writes. The drawer's "Order
 * placed" line will show the repair time, not 1:36 PM.
 *
 * If the order is still unpaid 20 minutes after this runs, the clock cancels
 * it again, exactly as it would any counter order. That is the rule working;
 * this script does not exempt the order from it.
 *
 * ── WHAT THIS WRITES ──────────────────────────────────────────────────────
 *
 *   retail_orders 2441
 *     status            'cancelled' -> 'pending_payment'
 *     cancelled_at      -> NULL
 *     cancelled_reason  -> NULL
 *     placed_at         -> CURRENT_TIMESTAMP   (see above)
 *     updated_at        -> CURRENT_TIMESTAMP
 *
 *   retail_payments (this order's one offline row)
 *     status            'cancelled' -> 'pending'   (what it was before the clock)
 *
 *   retail_stock_reservations (the rows the clock released at cancelled_at)
 *     status            'released' -> 'active', released_at -> NULL
 *     Counter orders are exempt from the reservation-expiry sweep, so the
 *     stale expires_at on these rows does not matter; the counter clock
 *     releases them again if the order is cancelled again.
 *
 *   one activity_log row recording the flip and the old placed_at.
 *
 * ── WHAT IT DOES NOT TOUCH ────────────────────────────────────────────────
 *   • MONEY. subtotal and total are read and printed, never written. An unpaid
 *     order is not in revenue (status pending_payment is filtered out), so
 *     revenue does not change until the order is paid at the till.
 *   • pick-up number (shop_order_code 4, shop_order_date 2026-10-10), items,
 *     options, print status. The kitchen ticket already printed at 1:36 PM.
 *
 * Refuses if the order is not cancelled by the counter clock, or has picked up
 * any refund record or a non-cancelled payment since the survey.
 *
 * Idempotent: every UPDATE is guarded on the state it expects, so a second run
 * changes nothing and says so.
 *
 * Run through .github/workflows/oneoff.yml. Default is dry-run.
 *
 *   node scripts/oneoff_restore_order_TC001037.js          # dry run — prints, writes nothing
 *   node scripts/oneoff_restore_order_TC001037.js --apply  # write
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ORDER_NO = 'TC001037';
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
console.log('BEFORE — order ' + ORDER_NO + ' (id ' + o.id + ')');
console.log(J({
  status: o.status, payment_method: o.payment_method,
  fulfillment_type: o.fulfillment_type, store_id: o.store_id,
  placed_at: o.placed_at, paid_at: o.paid_at,
  cancelled_at: o.cancelled_at, cancelled_reason: o.cancelled_reason,
  subtotal: o.subtotal, total: o.total,
  shop_order_code: o.shop_order_code, shop_order_date: o.shop_order_date,
}));
console.log('');

if (o.status !== 'cancelled') {
  console.log('Order is already "' + o.status + '" — nothing to do. '
    + '(This script only lifts THIS cancelled order back to unpaid.)');
  process.exit(0);
}
if (o.cancelled_reason !== 'counter_unpaid_timeout' || o.fulfillment_type !== 'counter') {
  console.error('REFUSING — this script was written for a counter order cancelled by the counter '
    + 'clock. This one reads cancelled_reason=' + J(o.cancelled_reason)
    + ', fulfillment_type=' + J(o.fulfillment_type) + '. Look first.');
  process.exit(1);
}

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
const paymentMoved = payments.some((p) => p.status !== 'cancelled' || p.method !== 'offline');
if (refundTouched || paymentMoved) {
  console.error('REFUSING — the order\'s money rows are not what they were when this was written '
    + '(one offline payment, cancelled, no refund). Look first.');
  console.error(J({ refund_status: o.refund_status, payments }));
  process.exit(1);
}

console.log('PAYMENT ROWS — will go back to "pending":');
console.log(J(payments));
console.log('');

const reservations = db.prepare(
  `SELECT id, store_id, product_id, qty, status, released_at
     FROM retail_stock_reservations
    WHERE order_id = ? AND status = 'released' AND released_at = ?
    ORDER BY id`
).all(o.id, o.cancelled_at);
console.log('STOCK HOLDS released by the clock — will be re-activated:');
console.log(J(reservations));
// Printed, not enforced: the hold is the order's own and goes back on either
// way, but if the shelf moved in the meantime this is where it shows.
for (const r of reservations) {
  try {
    const s = db.prepare(
      `SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?`
    ).get(r.store_id, r.product_id);
    const held = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS q FROM retail_stock_reservations
        WHERE store_id = ? AND product_id = ? AND status = 'active'`
    ).get(r.store_id, r.product_id);
    console.log('  product ' + r.product_id + ': on shelf ' + (s ? s.physical_qty : 'n/a')
      + ', already held by others ' + held.q);
  } catch (e) { console.log('  product ' + r.product_id + ': stock read failed — ' + e.message); }
}
console.log('');

console.log('REVENUE EFFECT — none now. An unpaid order is outside revenue; ¥'
  + num(o.subtotal).toFixed(2) + ' enters when the till marks it paid.');
console.log('');

if (!WRITE) {
  console.log('DRY RUN — would set status="pending_payment", clear cancelled_at/cancelled_reason, '
    + 'move placed_at to now (fresh 20-minute counter clock), set ' + payments.length
    + ' payment row(s) to "pending", re-activate ' + reservations.length
    + ' stock hold(s), and log it. Re-run with --apply to write.');
  process.exit(0);
}

// ── Write ───────────────────────────────────────────────────────────────────
const priorLog = db.prepare(
  `SELECT tenant_id FROM activity_log
    WHERE entity_type = 'retail_order' AND entity_id = ? ORDER BY id DESC LIMIT 1`
).get(o.id);

let changes = 0, payChanges = 0, resChanges = 0;
db.transaction(() => {
  changes = db.prepare(
    `UPDATE retail_orders
        SET status           = 'pending_payment',
            cancelled_at     = NULL,
            cancelled_reason = NULL,
            placed_at        = CURRENT_TIMESTAMP,
            updated_at       = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'cancelled' AND cancelled_reason = 'counter_unpaid_timeout'`
  ).run(o.id).changes;
  if (!changes) return;
  payChanges = db.prepare(
    `UPDATE retail_payments SET status = 'pending'
      WHERE order_id = ? AND status = 'cancelled' AND method = 'offline'`
  ).run(o.id).changes;
  resChanges = db.prepare(
    `UPDATE retail_stock_reservations SET status = 'active', released_at = NULL
      WHERE order_id = ? AND status = 'released' AND released_at = ?`
  ).run(o.id, o.cancelled_at).changes;
  db.prepare(
    `INSERT INTO activity_log (user_id, username, action, entity_type, entity_id, details, tenant_id)
     VALUES (NULL, 'script', 'status_change', 'retail_order', ?, ?, ?)`
  ).run(o.id, JSON.stringify({
    from: 'cancelled', to: 'pending_payment',
    was_cancelled_reason: o.cancelled_reason,
    was_cancelled_at: o.cancelled_at,
    was_placed_at: o.placed_at,
    reason: 'restored_by_hand — cancelled by the counter clock, not by staff; Ash: "bring it back on unpaid"',
    script: 'scripts/oneoff_restore_order_TC001037.js',
    payments_reopened: payChanges, holds_reactivated: resChanges,
  }), priorLog ? priorLog.tenant_id : null);
})();

console.log('Rows updated — order: ' + changes + ', payments: ' + payChanges + ', holds: ' + resChanges);
console.log('AFTER: ' + J(db.prepare(
  `SELECT id, order_no, status, placed_at, paid_at, cancelled_at, cancelled_reason,
          subtotal, total, payment_method, updated_at
     FROM retail_orders WHERE id = ?`).get(o.id)));
console.log('');
console.log('The till now has 20 minutes from placed_at to take the payment before the counter '
  + 'clock cancels it again.');
