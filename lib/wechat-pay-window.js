// A WeChat payment for an order is only accepted while the order still exists
// (decisions §478). Two halves:
//
//   1. THE WINDOW. Every WeChat charge we raise for an order carries a
//      `time_expire`, set to the moment our own sweepers will cancel that order
//      if it is still unpaid, less a minute. WeChat then refuses a payment that
//      would land after the order is gone. Before this, a charge stayed payable
//      on WeChat's side for hours after a 15-minute reservation had cancelled
//      the order underneath it.
//
//   2. THE SAFETY NET. Money can still arrive on a cancelled order: a payment in
//      the last seconds whose notify lands after the sweep, a WeChat floor of one
//      minute on time_expire, or an order a person or a new checkout cancelled at
//      a moment no clock predicts. The payment callback used to look such a
//      payment up as 'pending', not find it (the cancel had flipped the row), and
//      answer WeChat "OK" — the shop kept the money and nobody was told. Order
//      TC001211 (2026-10-15) is the case that surfaced it. Now that payment is
//      recorded, refunded in full straight away, and the shop is told.
//
// The deadline mirrors the three sweeps that cancel an unpaid order on a clock:
//   • lib/inventory.js sweepExpiredReservations — any ACTIVE reservation past
//     its expires_at cancels a non-counter order (counter orders are exempt);
//   • the same sweeper's counter clock — placed_at + counter minutes;
//   • routes/retail.js cancelStalePendingOrdersForTenant — placed_at +
//     orders.autoCancelHours for every non-counter order.
// The earliest that applies is the order's deadline. Customer cancels, staff
// cancels and supersede-on-new-order have no clock; the safety net covers them.
'use strict';

const { tdb } = require('./tenant-db');

// How long before our own cancel WeChat stops taking the money. One sweeper
// tick (lib/inventory.js runs every 60s), so a payment made at the last allowed
// moment has a full tick for its notify to land before the order can go.
const PAY_EXPIRE_MARGIN_MS = 60_000;

// SQLite CURRENT_TIMESTAMP and the reservation expiry are both UTC
// 'YYYY-MM-DD HH:MM:SS' with no zone. Anything already carrying a zone is
// taken as written.
function parseDbUtc(s) {
  if (!s) return null;
  const str = String(s).trim().replace(' ', 'T');
  const t = Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(str) ? str : str + 'Z');
  return Number.isFinite(t) ? t : null;
}

// RFC 3339 in Beijing time, the shape WeChat Pay v3 documents for time_expire
// ("2015-05-20T13:29:35+08:00"). Seconds precision.
function wechatTimeExpire(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';
}

// Pure: the moment (ms) the earliest applicable sweep cancels this order if it
// is still unpaid, or null when no clock applies to it.
function payDeadlineMs({ fulfillmentType, placedAt, reservationExpiresAt, autoCancelHours, counterMinutes }) {
  const placed = parseDbUtc(placedAt);
  const candidates = [];
  if (fulfillmentType === 'counter') {
    if (placed != null && Number(counterMinutes) > 0) candidates.push(placed + Number(counterMinutes) * 60_000);
  } else {
    const res = parseDbUtc(reservationExpiresAt);
    if (res != null) candidates.push(res);
    if (placed != null && Number(autoCancelHours) > 0) candidates.push(placed + Number(autoCancelHours) * 3600_000);
  }
  return candidates.length ? Math.min(...candidates) : null;
}

// The time_expire to send with a WeChat charge for this order, or null to send
// none. The caller passes the two settings, read where they are owned.
//
// Deterministic from stored values on purpose: a customer who taps Pay twice
// raises the same out_trade_no twice, and WeChat may refuse a repeat whose
// parameters differ. A time already in the past is still sent — WeChat moves
// anything under a minute up to one minute rather than rejecting it, and the
// safety net below covers that minute.
function orderWechatTimeExpire(orderId, { autoCancelHours, counterMinutes }) {
  const o = tdb().prepare('SELECT fulfillment_type, placed_at FROM retail_orders WHERE id = ?').get(orderId);
  if (!o) return null;
  const r = tdb().prepare(
    "SELECT MIN(expires_at) AS e FROM retail_stock_reservations WHERE order_id = ? AND status = 'active'"
  ).get(orderId);
  const deadline = payDeadlineMs({
    fulfillmentType: o.fulfillment_type || '',
    placedAt: o.placed_at,
    reservationExpiresAt: r && r.e,
    autoCancelHours, counterMinutes,
  });
  return deadline == null ? null : wechatTimeExpire(deadline - PAY_EXPIRE_MARGIN_MS);
}

// ── The safety net ─────────────────────────────────────────────────────────

// A payment row that WeChat has just told us was paid, on an order that is
// already cancelled. 'pending' is here because a staff cancel of an unpaid
// order does not flip the payment row (only the sweeps and the customer cancel
// do), and the old callback would then have marked it 'success' on a cancelled
// order and kept the money. 'late_paid' is a row whose refund was tried and
// failed; WeChat re-sends the notify, and that is the retry.
function findLatePayment(outTradeNo) {
  if (!outTradeNo) return null;
  return tdb().prepare(
    `SELECT p.id, p.order_id, p.amount, p.status, p.out_trade_no, o.order_no
       FROM retail_payments p
       JOIN retail_orders o ON o.id = p.order_id
      WHERE p.out_trade_no = ?
        AND o.status = 'cancelled'
        AND p.status IN ('pending', 'cancelled', 'late_paid')
      ORDER BY p.id DESC LIMIT 1`
  ).get(outTradeNo) || null;
}

// The same refund number every time for one payment row, so a re-sent notify,
// or two arriving at once, asks WeChat for the same refund rather than a
// second one. WeChat treats a repeated out_refund_no as the same refund.
function lateRefundNo(row) {
  return ('LP' + row.id + 'X' + row.out_trade_no).slice(0, 64);
}

// Every Chinese fragment here is live elsewhere in the product; none is
// composed (docs/tacet-delivery-vocabulary.md, "A payment that arrives after
// the order was cancelled").
function lateAlertText(row, amount, ok) {
  const money = '¥' + Number(amount).toFixed(2);
  return [
    ok ? '⚠️ 微信支付 · 已取消 · 已退款' : '⚠️ 微信支付 · 已取消 · 退款失败',
    ok ? 'WeChat payment on a cancelled order — refunded automatically'
       : 'WeChat payment on a cancelled order — the automatic refund failed',
    `订单号 Order: ${row.order_no}`,
    `金额 Amount: ${money}`,
    ok ? null : '请手动退款给顾客',
    ok ? null : 'Refund the customer by hand in the WeChat Pay merchant platform',
  ].filter(Boolean).join('\n');
}

// Refund a payment that arrived on a cancelled order. Runs inside the tenant's
// data scope (the caller's tenantAls.run), so wechatPayRefund charges back
// against the merchant that took the money.
//
// Returns { ok, retry }. retry=true asks the caller to answer WeChat with a
// non-200, so WeChat re-sends the notify and the refund is tried again.
async function refundLatePayment(row, txn, plain, deps) {
  const { wechatPayRefund, sendAlert, logRefundEvent, logActivity } = deps;
  // What WeChat actually took is what goes back — not what we expected to take.
  const paidCents = Math.round(Number(txn && txn.amount && txn.amount.total));
  if (!(paidCents > 0)) return { ok: false, retry: false };
  const paid = paidCents / 100;

  // The money is real; the row says so before anything is tried, so a crash
  // between here and the refund leaves a row that shows money held.
  tdb().prepare(
    `UPDATE retail_payments
        SET status = 'late_paid',
            transaction_id = COALESCE(?, transaction_id),
            raw_callback_json = ?,
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND status IN ('pending', 'cancelled', 'late_paid')`
  ).run(txn.transaction_id || null, plain || null, row.id);

  let refund;
  try {
    refund = await wechatPayRefund({
      outTradeNo: row.out_trade_no,
      outRefundNo: lateRefundNo(row),
      refundCents: paidCents,
      totalCents: paidCents,
      reason: 'Order cancelled before payment arrived',
    });
    if (refund.status === 'ABNORMAL' || refund.status === 'CLOSED') {
      throw new Error('wechat_refund_' + String(refund.status).toLowerCase());
    }
  } catch (e) {
    console.error('[late-payment] refund failed', row.out_trade_no, e.message);
    try {
      logActivity(null, 'system', 'late_payment_refund_failed', 'retail_order', row.order_id,
        { amount: paid, out_trade_no: row.out_trade_no, error: String(e.message || e).slice(0, 200) }, null);
    } catch (_) { /* the alert below still goes */ }
    // The alert is the only thing that can fail quietly here: the refund has
    // already failed and the non-200 below brings the notify back regardless.
    try { Promise.resolve(sendAlert(lateAlertText(row, paid, false))).catch(() => { /* message lost; notify retries */ }); }
    catch (_) { /* message lost; the non-200 brings the notify back */ }
    return { ok: false, retry: true };
  }

  // Only the writer that moves the row on records and alerts, so two notifies
  // arriving together produce one refund event and one message.
  const won = tdb().prepare(
    `UPDATE retail_payments SET status = 'refunded', refunded_amount = ?
      WHERE id = ? AND status = 'late_paid'`
  ).run(paid, row.id).changes === 1;
  if (won) {
    const ref = refund.refund_id + (refund.status ? ' (' + refund.status + ')' : '');
    logRefundEvent({
      orderId: row.order_id, event: 'paid', amount: paid,
      note: 'payment arrived after the order was cancelled — refunded automatically',
      meta: { method: 'wechat', reference: ref, out_trade_no: row.out_trade_no, transaction_id: txn.transaction_id || null },
    });
    try {
      logActivity(null, 'system', 'late_payment_refunded', 'retail_order', row.order_id,
        { amount: paid, out_trade_no: row.out_trade_no, refund: ref }, null);
    } catch (_) { /* the refund itself is done */ }
    // A lost message must not undo a refund that went through; the refund
    // event and the activity row above still record it.
    try { Promise.resolve(sendAlert(lateAlertText(row, paid, true))).catch(() => { /* message lost; refund recorded */ }); }
    catch (_) { /* message lost; the refund is recorded above */ }
  }
  return { ok: true, retry: false };
}

module.exports = {
  PAY_EXPIRE_MARGIN_MS,
  parseDbUtc, wechatTimeExpire, payDeadlineMs, orderWechatTimeExpire,
  findLatePayment, lateRefundNo, lateAlertText, refundLatePayment,
};
