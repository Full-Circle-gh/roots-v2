#!/usr/bin/env node
/**
 * Read-only survey of ONE order — TC001037 — before it is brought back.
 *
 * Context (Ash, 2026-10-10): the drawer shows TC001037 — a counter sale at
 * Yuexiu, ¥87, offline payment, placed Oct 10 1:36 PM — as "Cancelled". It
 * should not be cancelled; it has to come back as UNPAID (pending_payment).
 *
 * The suspected cause is the counter clock in lib/inventory.js
 * (sweepExpiredReservations, cancelled_reason 'counter_unpaid_timeout'): a
 * counter order still pending_payment N minutes after placed_at is cancelled.
 * That matters for the restore, because placed_at does not move — an order put
 * back to pending_payment is already past the clock and the next sweep would
 * cancel it again. This prints the live setting so that is a known number.
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 */
'use strict';

const ORDER_NO = 'TC001037';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('');

const J = (x) => JSON.stringify(x, null, 2);
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return { ERROR: e.message }; } };
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { ERROR: e.message }; } };

// ════════════════════════════════════════════════════════════════════════════
// 0 — find the order. Exact match first, then a LIKE in case the displayed
//     "#TC001037" carries a prefix/suffix the drawer strips.
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · locate ══');
let o = one('SELECT * FROM retail_orders WHERE order_no = ?', ORDER_NO);
if (!o) {
  const near = all("SELECT id, order_no, status FROM retail_orders WHERE order_no LIKE ? ORDER BY id", '%' + ORDER_NO + '%');
  console.log('exact miss; LIKE %' + ORDER_NO + '%: ' + J(near));
  if (Array.isArray(near) && near.length === 1) o = one('SELECT * FROM retail_orders WHERE id = ?', near[0].id);
}
if (!o || o.ERROR) { console.log('NOT FOUND / ' + J(o)); process.exit(1); }
const ID = o.id;
console.log('order id = ' + ID);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 1 — the order row, in full
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · retail_orders row ══');
console.log(J(o));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 2 — money + tenders, the figures "don't change the revenue" is about
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 2 · tenders ══');
console.log(J(one(
  `SELECT subtotal, shipping_fee, voucher_code, voucher_amount,
          points_used, points_amount, points_earned, balance_used, total,
          payment_method, source, store_id
     FROM retail_orders WHERE id = ?`, ID)));
console.log('revenue queries count an order when status NOT IN (cancelled, refunded, pending_payment);');
console.log('the figure they sum is `subtotal` (see routes/retail.js dashboard/analytics blocks).');
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 3 — items (refunded_qty tells us whether a partial refund ever ran)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 3 · retail_order_items ══');
console.log(J(all(
  `SELECT * FROM retail_order_items WHERE order_id = ? ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 4 — payments
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 4 · retail_payments ══');
console.log(J(all(
  `SELECT id, method, amount, status, out_trade_no, transaction_id,
          COALESCE(refunded_amount,0) AS refunded_amount, completed_at
     FROM retail_payments WHERE order_id = ? ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 5 — points ledger for this order + the customer's current standing
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 5 · points ══');
console.log('order rows: ' + J(all(
  `SELECT id, customer_id, delta, balance_after, source, note, expires_at, created_at
     FROM retail_points_transactions WHERE order_id = ? ORDER BY id`, ID)));
if (o.customer_id) {
  console.log('customer: ' + J(one(
    `SELECT id, name, phone, points_balance, balance, lifetime_spend, tier_key
       FROM retail_customers WHERE id = ?`, o.customer_id)));
  console.log('last 15 points rows for the customer: ' + J(all(
    `SELECT id, order_id, delta, balance_after, source, note, created_at
       FROM retail_points_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 15`, o.customer_id)));
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 6 — wallet ledger touching this order
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 6 · wallet (retail_topup_transactions) ══');
console.log(J(all(
  `SELECT id, customer_id, amount, bonus_points, payment_method, status, out_trade_no, paid_at
     FROM retail_topup_transactions
    WHERE out_trade_no = ? OR out_trade_no LIKE ?
    ORDER BY id`, 'orderspend:' + ID, 'orderrefund:' + ID + ':%')));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 7 — refund event log
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 7 · refund events ══');
console.log(J(all(
  `SELECT * FROM retail_refund_events WHERE order_id = ? ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 8 — what the cancel wrote to the activity log
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 8 · activity_log ══');
console.log(J(all(
  `SELECT id, user_id, username, action, entity_type, entity_id, details, created_at
     FROM activity_log
    WHERE entity_type = 'retail_order' AND entity_id = ?
    ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 9 — stock ledger rows this order moved (deduct at pay, release at cancel)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 9 · stock ledger ══');
for (const t of ['stock_ledger', 'retail_stock_ledger', 'inventory_ledger']) {
  const r = all(`SELECT * FROM ${t} WHERE order_id = ? ORDER BY id`, ID);
  if (!r.ERROR) { console.log(t + ': ' + J(r)); }
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 10 — shipments (a restore must not resurrect a parcel state that never was)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 10 · shipments ══');
console.log(J(all(
  `SELECT id, mode, tracking_carrier, tracking_number, dispatched_at, delivered_at
     FROM retail_shipments WHERE order_id = ? ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 11 — stock reservations (the counter clock releases them on cancel)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 11 · retail_stock_reservations ══');
console.log(J(all(
  `SELECT * FROM retail_stock_reservations WHERE order_id = ? ORDER BY id`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 12 — the counter clock setting, and how long ago this order was placed
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 12 · counter clock ══');
console.log('orders.counterAutoCancelMinutes row: ' + J(one(
  "SELECT key, value_json FROM storefront_config WHERE key = 'orders.counterAutoCancelMinutes'")));
console.log('(no row = the code default, COUNTER_CANCEL_MIN_DEFAULT in lib/inventory.js)');
console.log('now / placed_at / minutes since placed: ' + J(one(
  `SELECT CURRENT_TIMESTAMP AS now, placed_at,
          ROUND((julianday('now') - julianday(placed_at)) * 1440, 1) AS minutes_since_placed,
          ROUND((julianday(cancelled_at) - julianday(placed_at)) * 1440, 1) AS minutes_placed_to_cancel
     FROM retail_orders WHERE id = ?`, ID)));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// 13 — other counter orders the clock cancelled today (is this one alone?)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 13 · counter orders cancelled today ══');
console.log(J(all(
  `SELECT id, order_no, status, payment_method, placed_at, cancelled_at, cancelled_reason, total
     FROM retail_orders
    WHERE COALESCE(fulfillment_type,'') = 'counter'
      AND status = 'cancelled'
      AND cancelled_at >= datetime('now', '-1 day')
    ORDER BY id`)));
console.log('');
console.log('done.');
