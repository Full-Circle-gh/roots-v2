// Put a cancelled order back to awaiting payment (§529).
//
// Staff do this from the order drawer. The same function is what the one-off
// for a named order calls, so the button and the repair cannot disagree.
//
// What a cancel undid, this puts back, in one transaction:
//   • the order is pending_payment, the cancel stamps are cleared, and
//     payment_reopened_at is now — the unpaid clocks read that instead of
//     the original placed_at, or a restore of an old order dies on the next tick
//   • a payment row that was cancelled before any money moved is pending again;
//     a row that actually settled stays as it is, and a fresh pending row is
//     added when none is open
//   • stock that was only held is held again; stock that was taken and then
//     returned is held again, and the return marker is renamed so a later
//     cancel can return it once more
//   • points, wallet balance and a voucher the cancel gave back are taken
//     again, and the move is refused when the customer has already used them
//
// Refused, and nothing is written: a marketplace order, money we still hold,
// a refund that is mid-flight, a line already refunded on its own, or a
// voucher / points / balance the customer no longer has.
//
// `apply` false runs every check and writes nothing. A second call on an
// order that is already awaiting payment changes nothing.
'use strict';

const READONLY_CHANNELS = new Set(['meituan', 'eleme', 'gzgrocery']);

function fail(error, message, http) {
  return { ok: false, error, message, http: http || 409 };
}

function configNumber(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!row || row.value_json == null || row.value_json === '') return fallback;
    const n = Number(JSON.parse(row.value_json));
    return Number.isFinite(n) ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

// How long the restored hold lasts: the same window the unpaid clock gives
// the order, so the hold and the order end together. A checkout's fifteen
// minutes would cancel a restored order before anyone could pay it.
function holdUntilUtc(db, fulfillmentType) {
  const counter = String(fulfillmentType || '') === 'counter';
  const minutes = counter
    ? configNumber(db, 'orders.counterAutoCancelMinutes', 120)
    : configNumber(db, 'orders.autoCancelHours', 6) * 60;
  const span = minutes > 0 ? minutes : (counter ? 120 : 6 * 60);
  return new Date(Date.now() + span * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

function moneyStillHeld(p) {
  if (!p) return false;
  if (p.status === 'late_paid') return true;
  if (p.status === 'success') {
    return Number(p.refunded_amount || 0) + 0.005 < Number(p.amount || 0);
  }
  return false;
}

function readPlan(db, orderId) {
  const order = db.prepare(
    `SELECT id, order_no, status, channel, fulfillment_type, customer_id,
            payment_method, total, voucher_code, voucher_reversed, refund_status, paid_at
       FROM retail_orders WHERE id = ?`
  ).get(orderId);
  if (!order) return fail('not_found', 'No such order.', 404);
  if (order.status === 'pending_payment') return { ok: true, already: true, order };
  if (order.status !== 'cancelled') {
    return fail('not_cancelled', 'Only a cancelled order can be put back to awaiting payment.');
  }
  if (READONLY_CHANNELS.has(String(order.channel || '').toLowerCase())) {
    return fail('readonly_channel', 'This order belongs to the marketplace. Change it there.');
  }
  if (order.refund_status === 'paying' || order.refund_status === 'approved') {
    return fail('refund_in_progress', 'A refund is still in progress on this order.');
  }

  const payments = db.prepare(
    `SELECT id, method, amount, status, transaction_id,
            COALESCE(refunded_amount, 0) AS refunded_amount
       FROM retail_payments WHERE order_id = ? ORDER BY id`
  ).all(orderId);
  if (payments.some(moneyStillHeld)) {
    return fail('money_still_held', 'This order still holds a payment that has not been refunded.');
  }

  const partialLine = db.prepare(
    `SELECT 1 FROM retail_order_items
      WHERE order_id = ? AND COALESCE(refunded_qty, 0) > 0 LIMIT 1`
  ).get(orderId);
  if (partialLine) {
    return fail('partial_refund', 'Part of this order was already refunded line by line.');
  }
  const partialStock = db.prepare(
    `SELECT 1 FROM retail_stock_ledger
      WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_reverse_partial'
      LIMIT 1`
  ).get(orderId);
  if (partialStock) {
    return fail('partial_refund', 'Part of this order\'s stock was already returned line by line.');
  }

  const points = planPoints(db, order);
  if (points.error) return points.error;
  const wallet = planWallet(db, order);
  if (wallet.error) return wallet.error;
  const voucher = planVoucher(db, order);
  if (voucher.error) return voucher.error;

  return {
    ok: true,
    already: false,
    order,
    payments,
    points,
    wallet,
    voucher,
    details: {
      from: 'cancelled',
      to: 'pending_payment',
      was_paid_at: order.paid_at || null,
      points_taken_back: points.take || 0,
      wallet_taken_back: wallet.take || 0,
      voucher_taken_back: !!voucher.take,
    },
  };
}

function planPoints(db, order) {
  const sum = db.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM retail_points_transactions
      WHERE order_id = ? AND source = 'refund_redeem'`
  ).get(order.id).s;
  const take = Math.round(Number(sum) || 0);
  if (take <= 0) return { take: 0 };
  const redeem = db.prepare(
    `SELECT customer_id FROM retail_points_transactions
      WHERE order_id = ? AND source = 'order_redeem' AND delta < 0`
  ).get(order.id);
  const customerId = (redeem && redeem.customer_id) || order.customer_id;
  if (!customerId) {
    return { error: fail('points_spent', 'The points this cancel gave back have already been spent.') };
  }
  const row = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId);
  if (!row || (Number(row.points_balance) || 0) < take) {
    return { error: fail('points_spent', 'The points this cancel gave back have already been spent.') };
  }
  return { take, customerId };
}

function planWallet(db, order) {
  const prior = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n
       FROM retail_topup_transactions
      WHERE payment_method = 'refund_reverse' AND out_trade_no LIKE ?`
  ).get('orderrefund:' + order.id + ':%');
  const take = Math.round((Number(prior.s) || 0) * 100) / 100;
  if (take <= 0.005) return { take: 0 };
  const spend = db.prepare(
    `SELECT customer_id FROM retail_topup_transactions
      WHERE out_trade_no = ? AND payment_method = 'order_redeem'`
  ).get('orderspend:' + order.id);
  const customerId = (spend && spend.customer_id) || order.customer_id;
  if (!customerId) {
    return { error: fail('wallet_spent', 'The wallet balance this cancel gave back has already been spent.') };
  }
  const row = db.prepare('SELECT balance FROM retail_customers WHERE id = ?').get(customerId);
  if (!row || (Number(row.balance) || 0) + 0.005 < take) {
    return { error: fail('wallet_spent', 'The wallet balance this cancel gave back has already been spent.') };
  }
  return { take, customerId, n: Number(prior.n) || 0 };
}

function planVoucher(db, order) {
  if (!order.voucher_code || !Number(order.voucher_reversed)) return { take: false };
  const code = String(order.voucher_code).trim().toUpperCase();
  const voucher = db.prepare(
    'SELECT id, max_uses, used_count FROM retail_vouchers WHERE UPPER(code) = ?'
  ).get(code);
  if (!voucher) {
    return { error: fail('voucher_used', 'The voucher on this order is no longer in the shop.') };
  }
  if (voucher.max_uses != null && Number(voucher.used_count) >= Number(voucher.max_uses)) {
    return { error: fail('voucher_used', 'The voucher on this order has been used up since the cancel.') };
  }
  let grantId = null;
  if (order.customer_id) {
    const grant = db.prepare(
      `SELECT id, used_at FROM retail_customer_vouchers
        WHERE customer_id = ? AND voucher_id = ?`
    ).get(order.customer_id, voucher.id);
    if (grant && grant.used_at) {
      return { error: fail('voucher_used', 'The voucher this cancel gave back has already been used on another order.') };
    }
    if (grant) grantId = grant.id;
  }
  return { take: true, voucherId: voucher.id, grantId };
}

function writePlan(db, plan) {
  const order = plan.order;
  const changed = db.prepare(
    `UPDATE retail_orders
        SET status = 'pending_payment',
            cancelled_at = NULL,
            cancelled_reason = NULL,
            paid_at = NULL,
            payment_reopened_at = CURRENT_TIMESTAMP,
            voucher_reversed = CASE WHEN ? THEN 0 ELSE voucher_reversed END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'cancelled'`
  ).run(plan.voucher.take ? 1 : 0, order.id).changes;
  if (!changed) return { ok: true, already: true, order };

  let paymentsReopened = 0;
  for (const p of plan.payments) {
    if (p.status === 'cancelled' && !p.transaction_id) {
      paymentsReopened += db.prepare(
        `UPDATE retail_payments SET status = 'pending' WHERE id = ? AND status = 'cancelled'`
      ).run(p.id).changes;
    }
  }
  const open = db.prepare(
    `SELECT id FROM retail_payments
      WHERE order_id = ? AND status IN ('pending', 'created') LIMIT 1`
  ).get(order.id);
  if (!open) {
    db.prepare(
      `INSERT INTO retail_payments (order_id, method, amount, status) VALUES (?, ?, ?, 'pending')`
    ).run(order.id, order.payment_method || 'wechat', Number(order.total) || 0);
    paymentsReopened += 1;
  }

  const until = holdUntilUtc(db, order.fulfillment_type);
  const holds = db.prepare(
    `UPDATE retail_stock_reservations
        SET status = 'active', released_at = NULL, expires_at = ?
      WHERE order_id = ? AND status IN ('released', 'expired')`
  ).run(until, order.id).changes;
  let recommitted = 0;
  const reversed = db.prepare(
    `SELECT 1 FROM retail_stock_ledger
      WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_reverse' LIMIT 1`
  ).get(order.id);
  if (reversed) {
    recommitted = db.prepare(
      `UPDATE retail_stock_reservations
          SET status = 'active', committed_at = NULL, released_at = NULL, expires_at = ?
        WHERE order_id = ? AND status = 'committed'`
    ).run(until, order.id).changes;
    db.prepare(
      `UPDATE retail_stock_ledger SET reason = 'order_reverse_reopened'
        WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_reverse'`
    ).run(order.id);
  }

  if (plan.points.take > 0) {
    db.prepare(
      'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ?'
    ).run(plan.points.take, plan.points.customerId);
    const after = db.prepare(
      'SELECT points_balance FROM retail_customers WHERE id = ?'
    ).get(plan.points.customerId).points_balance;
    db.prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note)
       VALUES (?, ?, ?, 'refund_redeem', ?, ?)`
    ).run(plan.points.customerId, -plan.points.take, after, order.id,
      'Redemption taken back — order put back to awaiting payment');
  }

  if (plan.wallet.take > 0) {
    db.prepare(
      'UPDATE retail_customers SET balance = ROUND(COALESCE(balance, 0) - ?, 2) WHERE id = ?'
    ).run(plan.wallet.take, plan.wallet.customerId);
    db.prepare(
      `INSERT INTO retail_topup_transactions
         (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
       VALUES (?, ?, 0, 'refund_reverse', 'success', CURRENT_TIMESTAMP, ?, ?)`
    ).run(plan.wallet.customerId, -plan.wallet.take,
      'orderrefund:' + order.id + ':' + (plan.wallet.n + 1),
      JSON.stringify({ order_id: order.id, note: 'wallet taken back — order put back to awaiting payment' }));
  }

  if (plan.voucher.take) {
    db.prepare('UPDATE retail_vouchers SET used_count = used_count + 1 WHERE id = ?').run(plan.voucher.voucherId);
    if (plan.voucher.grantId) {
      db.prepare(
        `UPDATE retail_customer_vouchers
            SET used_at = CURRENT_TIMESTAMP, used_order_id = ?
          WHERE id = ? AND used_at IS NULL`
      ).run(order.id, plan.voucher.grantId);
    }
  }

  return {
    ok: true,
    applied: true,
    order,
    details: Object.assign({}, plan.details, {
      payments_reopened: paymentsReopened,
      holds_reactivated: holds,
      committed_reheld: recommitted,
    }),
  };
}

function reopenCancelledOrder(db, orderId, opts) {
  const apply = !!(opts && opts.apply);
  const plan = readPlan(db, orderId);
  if (!plan.ok || plan.already || !apply) return plan;
  return db.transaction(() => {
    const again = readPlan(db, orderId);
    if (!again.ok || again.already) return again;
    return writePlan(db, again);
  })();
}

module.exports = { reopenCancelledOrder, READONLY_CHANNELS };
