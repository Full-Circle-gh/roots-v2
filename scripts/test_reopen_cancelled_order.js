#!/usr/bin/env node
/**
 * A cancelled order can be put back to awaiting payment (§529).
 *
 *   node scripts/test_reopen_cancelled_order.js
 *
 * The drawer button and the TC002837 repair both call
 * lib/reopen-cancelled-order.js. This is that function, on an in-memory
 * database, including the refusals that must write nothing.
 */
'use strict';

const assert = require('assert');
const { openMemoryDb } = require('./test-support/memory-db');
const { reopenCancelledOrder } = require('../lib/reopen-cancelled-order');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

function db() {
  const h = openMemoryDb();
  // better-sqlite3 has transaction(); Node's built-in sqlite does not. The
  // live app is the first. The fallback is the same BEGIN/COMMIT.
  if (typeof h.transaction !== 'function') {
    h.transaction = (fn) => () => {
      h.exec('BEGIN');
      try { const r = fn(); h.exec('COMMIT'); return r; }
      catch (e) { try { h.exec('ROLLBACK'); } catch (_) { /* already closed */ } throw e; }
    };
  }
  h.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, channel TEXT,
      fulfillment_type TEXT, customer_id INTEGER, payment_method TEXT,
      total REAL, voucher_code TEXT, voucher_reversed INTEGER DEFAULT 0,
      refund_status TEXT, paid_at TEXT, cancelled_at TEXT, cancelled_reason TEXT,
      payment_reopened_at TEXT, updated_at TEXT
    );
    CREATE TABLE retail_payments (
      id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, amount REAL,
      status TEXT, transaction_id TEXT, refunded_amount REAL DEFAULT 0
    );
    CREATE TABLE retail_order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
      qty REAL, refunded_qty REAL DEFAULT 0
    );
    CREATE TABLE retail_stock_reservations (
      id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER,
      order_id INTEGER, qty REAL, status TEXT, released_at TEXT,
      expires_at TEXT, committed_at TEXT, channel TEXT
    );
    CREATE TABLE retail_stock_ledger (
      id INTEGER PRIMARY KEY, ref_table TEXT, ref_id INTEGER,
      product_id INTEGER, reason TEXT, delta REAL
    );
    CREATE TABLE retail_customers (
      id INTEGER PRIMARY KEY, points_balance INTEGER DEFAULT 0, balance REAL DEFAULT 0
    );
    CREATE TABLE retail_points_transactions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, delta INTEGER,
      balance_after INTEGER, source TEXT, order_id INTEGER, note TEXT
    );
    CREATE TABLE retail_topup_transactions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL,
      bonus_points INTEGER, payment_method TEXT, status TEXT,
      paid_at TEXT, out_trade_no TEXT, raw_callback_json TEXT
    );
    CREATE TABLE retail_vouchers (
      id INTEGER PRIMARY KEY, code TEXT, max_uses INTEGER, used_count INTEGER DEFAULT 0
    );
    CREATE TABLE retail_customer_vouchers (
      id INTEGER PRIMARY KEY, customer_id INTEGER, voucher_id INTEGER,
      used_at TEXT, used_order_id INTEGER
    );
  `);
  return h;
}

function seed(h, extra) {
  h.prepare(
    `INSERT INTO retail_orders
       (id, order_no, status, channel, fulfillment_type, customer_id, payment_method,
        total, cancelled_at, cancelled_reason)
     VALUES (7, 'TC002837', 'cancelled', 'wechat', 'delivery', 1448, 'wechat',
             312.40, '2026-11-12 05:50:00', 'customer_cancelled')`
  ).run();
  h.prepare(
    `INSERT INTO retail_payments (id, order_id, method, amount, status)
     VALUES (1, 7, 'wechat', 312.40, 'cancelled')`
  ).run();
  if (extra) extra(h);
}

check('an unpaid cancelled order waits for payment again', () => {
  const h = db();
  seed(h);
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, true);
  const o = h.prepare('SELECT status, cancelled_at, cancelled_reason, paid_at, payment_reopened_at FROM retail_orders WHERE id = 7').get();
  assert.strictEqual(o.status, 'pending_payment');
  assert.strictEqual(o.cancelled_at, null);
  assert.strictEqual(o.cancelled_reason, null);
  assert.strictEqual(o.paid_at, null);
  assert.ok(o.payment_reopened_at);
  assert.strictEqual(h.prepare('SELECT status FROM retail_payments WHERE id = 1').get().status, 'pending');
});

check('a second call changes nothing', () => {
  const h = db();
  seed(h);
  reopenCancelledOrder(h, 7, { apply: true });
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.already, true);
  assert.strictEqual(h.prepare('SELECT COUNT(*) AS n FROM retail_payments').get().n, 1);
});

check('a dry run writes nothing', () => {
  const h = db();
  seed(h);
  const r = reopenCancelledOrder(h, 7, { apply: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, undefined);
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
  assert.strictEqual(h.prepare('SELECT status FROM retail_payments WHERE id = 1').get().status, 'cancelled');
});

check('an order that is not cancelled is refused', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_orders SET status = 'paid' WHERE id = 7").run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'not_cancelled');
});

check('a marketplace order is refused', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_orders SET channel = 'meituan' WHERE id = 7").run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'readonly_channel');
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
});

check('money we still hold refuses the move', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_payments SET status = 'success', amount = 312.40, refunded_amount = 0 WHERE id = 1").run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'money_still_held');
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
});

check('a settled row stays settled and a new pending row is opened', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_payments SET status = 'refunded', transaction_id = '4200', refunded_amount = 312.40 WHERE id = 1").run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.prepare('SELECT status FROM retail_payments WHERE id = 1').get().status, 'refunded');
  const open = h.prepare("SELECT status, amount FROM retail_payments WHERE order_id = 7 AND status = 'pending'").get();
  assert.strictEqual(open.status, 'pending');
  assert.strictEqual(open.amount, 312.40);
});

check('a released hold is held again, past now', () => {
  const h = db();
  seed(h);
  h.prepare(
    `INSERT INTO retail_stock_reservations
       (id, store_id, product_id, order_id, qty, status, released_at, expires_at)
     VALUES (3, 1, 9, 7, 1, 'released', '2026-11-12 05:50:00', '2026-11-12 05:50:00')`
  ).run();
  reopenCancelledOrder(h, 7, { apply: true });
  const r = h.prepare('SELECT status, released_at, expires_at FROM retail_stock_reservations WHERE id = 3').get();
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(r.released_at, null);
  assert.ok(r.expires_at > new Date().toISOString().replace('T', ' ').slice(0, 19));
});

check('stock that was returned is held again, and can be returned once more', () => {
  const h = db();
  seed(h);
  h.prepare(
    `INSERT INTO retail_stock_reservations
       (id, store_id, product_id, order_id, qty, status, committed_at)
     VALUES (4, 1, 9, 7, 2, 'committed', '2026-11-12 05:40:00')`
  ).run();
  h.prepare(
    `INSERT INTO retail_stock_ledger (id, ref_table, ref_id, product_id, reason, delta)
     VALUES (1, 'retail_orders', 7, 9, 'order_reverse', 2)`
  ).run();
  reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(h.prepare('SELECT status FROM retail_stock_reservations WHERE id = 4').get().status, 'active');
  assert.strictEqual(
    h.prepare("SELECT reason FROM retail_stock_ledger WHERE id = 1").get().reason,
    'order_reverse_reopened'
  );
});

check('points the cancel gave back are taken again', () => {
  const h = db();
  seed(h);
  h.prepare('INSERT INTO retail_customers (id, points_balance, balance) VALUES (1448, 80, 0)').run();
  h.prepare(
    `INSERT INTO retail_points_transactions (id, customer_id, delta, balance_after, source, order_id)
     VALUES (1, 1448, -40, 40, 'order_redeem', 7), (2, 1448, 40, 80, 'refund_redeem', 7)`
  ).run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.prepare('SELECT points_balance FROM retail_customers WHERE id = 1448').get().points_balance, 40);
  const back = h.prepare("SELECT delta FROM retail_points_transactions WHERE source = 'refund_redeem' AND delta < 0").get();
  assert.strictEqual(back.delta, -40);
});

check('points already spent refuse the move and leave the order cancelled', () => {
  const h = db();
  seed(h);
  h.prepare('INSERT INTO retail_customers (id, points_balance, balance) VALUES (1448, 10, 0)').run();
  h.prepare(
    `INSERT INTO retail_points_transactions (id, customer_id, delta, balance_after, source, order_id)
     VALUES (1, 1448, -40, 40, 'order_redeem', 7), (2, 1448, 40, 80, 'refund_redeem', 7)`
  ).run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'points_spent');
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
  assert.strictEqual(h.prepare('SELECT points_balance FROM retail_customers WHERE id = 1448').get().points_balance, 10);
});

check('a voucher the cancel gave back is used on this order again', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_orders SET voucher_code = 'SAVE10', voucher_reversed = 1 WHERE id = 7").run();
  h.prepare("INSERT INTO retail_vouchers (id, code, max_uses, used_count) VALUES (3, 'SAVE10', 5, 1)").run();
  h.prepare('INSERT INTO retail_customer_vouchers (id, customer_id, voucher_id, used_at, used_order_id) VALUES (1, 1448, 3, NULL, NULL)').run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.prepare('SELECT used_count FROM retail_vouchers WHERE id = 3').get().used_count, 2);
  assert.strictEqual(h.prepare('SELECT voucher_reversed FROM retail_orders WHERE id = 7').get().voucher_reversed, 0);
  assert.strictEqual(h.prepare('SELECT used_order_id FROM retail_customer_vouchers WHERE id = 1').get().used_order_id, 7);
});

check('a voucher already used on another order refuses the move', () => {
  const h = db();
  seed(h);
  h.prepare("UPDATE retail_orders SET voucher_code = 'SAVE10', voucher_reversed = 1 WHERE id = 7").run();
  h.prepare("INSERT INTO retail_vouchers (id, code, max_uses, used_count) VALUES (3, 'SAVE10', 5, 2)").run();
  h.prepare("INSERT INTO retail_customer_vouchers (id, customer_id, voucher_id, used_at, used_order_id) VALUES (1, 1448, 3, '2026-11-12 06:00:00', 99)").run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'voucher_used');
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
});

check('wallet balance the cancel gave back is taken again', () => {
  const h = db();
  seed(h);
  h.prepare('INSERT INTO retail_customers (id, points_balance, balance) VALUES (1448, 0, 30)').run();
  h.prepare(
    `INSERT INTO retail_topup_transactions
       (id, customer_id, amount, bonus_points, payment_method, status, out_trade_no)
     VALUES (1, 1448, -20, 0, 'order_redeem', 'success', 'orderspend:7'),
            (2, 1448, 20, 0, 'refund_reverse', 'success', 'orderrefund:7:1')`
  ).run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.prepare('SELECT balance FROM retail_customers WHERE id = 1448').get().balance, 10);
});

check('a line already refunded on its own refuses the move', () => {
  const h = db();
  seed(h);
  h.prepare('INSERT INTO retail_order_items (id, order_id, product_id, qty, refunded_qty) VALUES (1, 7, 9, 2, 1)').run();
  const r = reopenCancelledOrder(h, 7, { apply: true });
  assert.strictEqual(r.error, 'partial_refund');
  assert.strictEqual(h.prepare('SELECT status FROM retail_orders WHERE id = 7').get().status, 'cancelled');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
