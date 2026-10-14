// The Nuonuo 发票 auto-issue: the tenant's invoice settings, the invoice sent to
// Nuonuo for a paid order, issuing it once, and finishing it when the tax
// bureau is done. Dormant until a tenant saves Nuonuo credentials AND turns
// fapiao.autoIssue on (§99 addendum 2). Moved out of routes/retail.js unchanged
// (decisions §477). Pinned by scripts/test_fapiao_auto_issue_flow.js.
'use strict';

const _nuonuo = require('./nuonuo');
const { tdb, currentTenantId, tenantAls, rawTenantDb } = require('./tenant-db');
const { cfgValue } = require('./store-config');
const { integ } = require('./tenant-creds');
const { notifyForOrder } = require('./customer-notify');

// ── Nuonuo auto-issue (dormant until creds + fapiao.autoIssue) ──────────────
// Seller (销方) details for the fapiao come from config; the tax NUMBER comes
// from the saved Nuonuo credential (saler_tax). taxRate/taxCode default here but
// are configurable per tenant. invoiceLine 'pc' = 增值税普通发票(电子).
function fapiaoSettings() {
  const saler = cfgValue('fapiao.saler', {}) || {};
  return {
    autoIssue:   !!cfgValue('fapiao.autoIssue', false),
    invoiceLine: cfgValue('fapiao.invoiceLine', 'pc'),
    taxRate:     String(cfgValue('fapiao.taxRate', '0.06')),
    taxCode:     cfgValue('fapiao.taxCode', '') || '',
    clerk:       cfgValue('fapiao.clerk', '') || '',
    saler:       { name: saler.name || '', tel: saler.tel || '', address: saler.address || '', account: saler.account || '' },
  };
}

// Build the normalized Nuonuo order from a paid retail order + its items.
// Unit price is derived tax-inclusive (our prices include tax) as line_total/qty.
function buildNuonuoOrder(order, items, settings, salerTaxNum) {
  return {
    orderNo:     order.order_no,
    senid:       'inv' + order.id,                       // idempotency: one per order
    buyerName:   order.invoice_title || '',
    buyerTaxNum: order.invoice_type === 'company' ? (order.invoice_tax_id || '') : '',
    buyerEmail:  order.invoice_email || '',
    buyerPhone:  '',
    invoiceLine: settings.invoiceLine,
    clerk:       settings.clerk,
    saler:       { taxNum: salerTaxNum, ...settings.saler },
    items: (items || []).map((it) => {
      const qty = Number(it.qty) || 1;
      const unit = qty ? (Number(it.line_total) || 0) / qty : Number(it.line_total) || 0;
      return {
        name:    it.name_cn || it.name_en || 'Goods',
        price:   unit,
        num:     qty,
        taxRate: settings.taxRate,
        taxCode: settings.taxCode,
      };
    }),
  };
}

// Query Nuonuo for an already-submitted serial and, once issued, store the
// number + PDF url, flip the order to 'issued', and fire the existing
// "invoice issued" notification. Idempotent: a no-op if already issued or no
// serial. Returns { done } so the caller / poller knows whether to retry.
async function finalizeInvoiceResult(orderId) {
  const o = tdb().prepare(
    'SELECT id, order_no, invoice_status, invoice_serial FROM retail_orders WHERE id = ?'
  ).get(orderId);
  if (!o || !o.invoice_serial || o.invoice_status === 'issued') return { done: true };
  const creds = integ().nuonuo;
  if (!_nuonuo.nuonuoEnabled(creds)) return { done: false };
  const r = await _nuonuo.queryResult(o.invoice_serial, creds);
  if (!r.ok) {
    tdb().prepare('UPDATE retail_orders SET invoice_auto_error = ? WHERE id = ?').run(String(r.error || 'query_failed'), orderId);
    return { done: false };
  }
  if (!r.done) return { done: false };   // still 开具中 — poll again later
  tdb().prepare(
    `UPDATE retail_orders
        SET invoice_status = 'issued', invoice_file_url = ?, invoice_number = ?,
            invoice_issued_at = CURRENT_TIMESTAMP, invoice_auto_error = NULL
      WHERE id = ?`
  ).run(r.pdfUrl || null, r.number || null, orderId);
  notifyForOrder(orderId, (ord) => ({
    category: 'invoice', type: 'invoice_issued', ref_type: 'invoice',
    title_en: 'Invoice issued', title_cn: '发票已开具',
    body_en: `The invoice for order ${ord.order_no} is ready`,
    body_cn: `订单 ${ord.order_no} 的发票已开具`,
  }));
  return { done: true };
}

// Fire-and-forget auto-issue for a paid order that wants a fapiao. Guarded so
// it stays DORMANT until both the Nuonuo creds are saved AND fapiao.autoIssue is
// on; on ANY failure it records the reason and leaves the order in the manual
// office queue (current behaviour) — nothing is ever lost. Issuance is async at
// the tax bureau, so we store the serial then poll a few times for the result;
// Nuonuo itself emails the PDF to the buyer when it completes.
async function maybeAutoIssueInvoice(orderId) {
  try {
    const settings = fapiaoSettings();
    const creds = integ().nuonuo;
    if (!settings.autoIssue || !_nuonuo.nuonuoEnabled(creds)) return;   // dormant
    const o = tdb().prepare(
      `SELECT id, order_no, status, needs_invoice, invoice_type, invoice_title,
              invoice_tax_id, invoice_email, invoice_status, invoice_serial
         FROM retail_orders WHERE id = ?`
    ).get(orderId);
    if (!o || !o.needs_invoice) return;
    if (o.status === 'pending_payment' || o.status === 'cancelled') return;   // must be paid
    if (o.invoice_status === 'issued' || o.invoice_serial) return;            // already done / submitted
    if (!o.invoice_email) {                                                   // can't push without an email
      tdb().prepare('UPDATE retail_orders SET invoice_auto_error = ? WHERE id = ?').run('no_email', orderId);
      return;
    }
    const items = tdb().prepare(
      'SELECT name_en, name_cn, qty, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id ASC'
    ).all(orderId);
    const payload = buildNuonuoOrder(o, items, settings, creds.salerTaxNum);
    const r = await _nuonuo.issueInvoice(payload, creds);
    if (!r.ok) {
      tdb().prepare('UPDATE retail_orders SET invoice_auto_error = ? WHERE id = ?').run(String(r.error || 'issue_failed'), orderId);
      return;
    }
    // Persist the serial FIRST — it's the idempotency marker that stops a retry
    // (or the next markOrderPaid) from issuing a second fapiao.
    tdb().prepare('UPDATE retail_orders SET invoice_serial = ?, invoice_auto_error = NULL WHERE id = ?').run(r.serialNo, orderId);
    // Poll for the result a few times (issuance is usually done within ~1 min).
    // The serial is persisted, so a server restart mid-poll loses nothing — the
    // admin "Check result" endpoint (or a later finalize) completes it. The
    // timers fire OUTSIDE the request's ALS scope, so re-enter the tenant's data
    // context (getTenantDb(tid)) before finalize so tdb()/integ() hit the right tenant.
    const tid = currentTenantId();
    for (const delay of [5000, 20000, 60000]) {
      setTimeout(() => {
        tenantAls.run(rawTenantDb(tid), () => finalizeInvoiceResult(orderId).catch(() => {}));
      }, delay);
    }
  } catch (e) {
    console.error('[maybeAutoIssueInvoice]', orderId, e.message);
    try { tdb().prepare('UPDATE retail_orders SET invoice_auto_error = ? WHERE id = ?').run('exception: ' + e.message, orderId); } catch {}
  }
}

module.exports = { fapiaoSettings, buildNuonuoOrder, finalizeInvoiceResult, maybeAutoIssueInvoice };
