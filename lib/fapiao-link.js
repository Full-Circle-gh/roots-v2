// The counter's fapiao code (§526).
//
// A till sale is paid before anyone asks for a 发票, so the order has no title
// and no tax ID. The cashier shows a code for THAT order. The customer scans
// it and types the details. They land on the same columns checkout already
// stores, and the order joins the queue the shop already issues from.
//
// The code is not a wall poster and it does not ask for an order number. The
// token is the order. A QR-menu sale, a mini-app order and a cancelled sale
// have no code: those customers already have a place to ask, or there is no
// sale to put a document on.
//
// This file does not issue the tax document. The shop's provider still issues
// nothing for us (§99 addendum 2). Staff issue it on the tax site afterwards.
'use strict';

const crypto = require('crypto');
const { publicOriginFor } = require('./shop-qr');

// 18 bytes, same width as pay_token. Hex keeps the QR payload inside the
// versions lib/qrpng.js can draw, on the shop domains this platform records.
const TOKEN_RE = /^[a-f0-9]{36}$/;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return '¥' + v.toFixed(2);
}

function loadByToken(db, token) {
  const t = String(token || '');
  if (!TOKEN_RE.test(t)) return null;
  return db.prepare(
    `SELECT id, order_no, status, total, shop_entry_method, invoice_status,
            needs_invoice, invoice_type, invoice_title, invoice_tax_id, invoice_email,
            fapiao_token
       FROM retail_orders WHERE fapiao_token = ?`
  ).get(t);
}

function loadById(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare(
    `SELECT id, order_no, status, total, shop_entry_method, invoice_status,
            needs_invoice, invoice_type, invoice_title, invoice_tax_id, invoice_email,
            fapiao_token
       FROM retail_orders WHERE id = ?`
  ).get(n);
}

// null when a code may be shown. A code for an issued, cancelled or unpaid
// sale would be a form that cannot save.
function staffBlock(order) {
  if (!order) return 'not_found';
  if (order.shop_entry_method !== 'till') return 'not_till';
  const st = String(order.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'pending_payment') return 'not_open';
  if (order.invoice_status === 'issued') return 'already_issued';
  return null;
}

// What the public page is allowed to say. A token that is not a till sale
// reads as missing, the same as a token that is not an order: the page must
// not confirm that some other order exists.
function publicView(order) {
  if (!order || order.shop_entry_method !== 'till') return { kind: 'missing' };
  const st = String(order.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'pending_payment') return { kind: 'closed' };
  if (order.invoice_status === 'issued') {
    return { kind: 'issued', orderNo: order.order_no || '' };
  }
  return {
    kind: 'open',
    orderNo: order.order_no || '',
    total: Number(order.total) || 0,
    type: order.invoice_type === 'company' ? 'company' : 'personal',
    title: order.invoice_title || '',
    taxId: order.invoice_tax_id || '',
    email: order.invoice_email || '',
    saved: !!order.needs_invoice && !!order.invoice_title,
  };
}

function statusOf(order) {
  const linked = !!(order && Number(order.needs_invoice) && String(order.invoice_title || '').trim());
  return {
    linked,
    title: linked ? String(order.invoice_title) : '',
    type: linked ? (order.invoice_type || '') : '',
    email: linked ? (order.invoice_email || '') : '',
    status: order && order.invoice_status ? order.invoice_status : (linked ? 'requested' : null),
  };
}

function ensureToken(db, order) {
  if (order.fapiao_token && TOKEN_RE.test(order.fapiao_token)) return order.fapiao_token;
  for (let i = 0; i < 5; i++) {
    const token = crypto.randomBytes(18).toString('hex');
    try {
      const r = db.prepare(
        `UPDATE retail_orders SET fapiao_token = ?
          WHERE id = ? AND (fapiao_token IS NULL OR fapiao_token = '')`
      ).run(token, order.id);
      if (r.changes) return token;
      const cur = db.prepare('SELECT fapiao_token FROM retail_orders WHERE id = ?').get(order.id);
      if (cur && cur.fapiao_token) return cur.fapiao_token;
    } catch (e) { /* another order drew this token; draw again */ }
  }
  throw new Error('fapiao_token');
}

function publicUrl(tenantId, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const origin = publicOriginFor(tenantId);
  return origin ? `${origin}/fapiao/${token}` : null;
}

// The same checks as POST /api/retail/orders/:id/invoice-request. A company
// needs a tax ID. An email is required so the issued file has somewhere to go.
function applyDetails(db, orderId, body) {
  const b = body || {};
  const type = b.invoice_type === 'company' ? 'company' : 'personal';
  const title = String(b.invoice_title || '').trim();
  const taxId = type === 'company' ? String(b.invoice_tax_id || '').trim() : null;
  const email = String(b.invoice_email || '').trim();
  if (!title) return { ok: false, error: 'title_required' };
  if (type === 'company' && !taxId) return { ok: false, error: 'tax_id_required' };
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, error: 'email_invalid' };
  const wrote = db.prepare(
    `UPDATE retail_orders
        SET needs_invoice = 1, invoice_type = ?, invoice_title = ?,
            invoice_tax_id = ?, invoice_email = ?
      WHERE id = ? AND shop_entry_method = 'till'
        AND IFNULL(invoice_status, '') != 'issued'
        AND status NOT IN ('cancelled', 'pending_payment')`
  ).run(type, title, taxId, email, orderId);
  if (!wrote.changes) return { ok: false, error: 'not_open' };
  return { ok: true };
}

const PAGE_ERR = {
  title_required: '请填写发票抬头 · Enter the invoice title',
  tax_id_required: '请填写企业税号 · Enter the tax ID',
  email_invalid: '请填写有效邮箱 · Enter a valid email',
};

function pageHtml(view, opts) {
  const o = opts || {};
  const err = PAGE_ERR[o.error] || '';
  let body;
  if (!view || view.kind === 'missing' || view.kind === 'closed') {
    body = `<h1>此链接没有可开的订单</h1><p class="sub">This link is not an open order.</p>`;
  } else if (view.kind === 'issued') {
    body = `<h1>此订单已开票</h1><p class="sub">This order already has a fapiao.</p>
      <p class="meta">${esc(view.orderNo)}</p>`;
  } else if (o.saved && !o.edit) {
    body = `<h1>已保存</h1><p class="sub">门店将开具发票。<br>Saved. The shop will issue it.</p>
      <div class="meta">
        <div class="row"><span class="k">订单号 · Order</span><span>${esc(view.orderNo)}</span></div>
        <div class="row"><span class="k">抬头 · Title</span><span>${esc(view.title)}</span></div>
      </div>
      <a class="text" href="?edit=1">修改 · Change</a>`;
  } else {
    const draft = o.draft || {};
    const type = (draft.invoice_type || view.type) === 'company' ? 'company' : 'personal';
    const title = draft.invoice_title != null ? draft.invoice_title : view.title;
    const taxId = draft.invoice_tax_id != null ? draft.invoice_tax_id : view.taxId;
    const email = draft.invoice_email != null ? draft.invoice_email : view.email;
    body = `<h1>发票资料 · Fapiao details</h1>
      <p class="sub">门店按你填写的内容开具发票。<br>The shop issues the fapiao from what you type here.</p>
      <div class="meta">
        <div class="row"><span class="k">订单号 · Order</span><span>${esc(view.orderNo)}</span></div>
        <div class="row"><span class="k">金额 · Amount</span><span>${esc(money(view.total))}</span></div>
      </div>
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
      <form method="post">
        <div class="seg">
          <label><input type="radio" name="invoice_type" value="personal" ${type === 'personal' ? 'checked' : ''}>个人 · Personal</label>
          <label><input type="radio" name="invoice_type" value="company" ${type === 'company' ? 'checked' : ''}>企业 · Company</label>
        </div>
        <label class="lbl" for="ft">抬头 · Title</label>
        <input id="ft" name="invoice_title" maxlength="100" autocomplete="organization" value="${esc(title)}" required>
        <div class="tax">
          <label class="lbl" for="fx">税号 · Tax ID</label>
          <input id="fx" name="invoice_tax_id" maxlength="40" autocomplete="off" value="${esc(taxId)}">
        </div>
        <label class="lbl" for="fe">邮箱 · Email</label>
        <input id="fe" name="invoice_email" type="email" inputmode="email" maxlength="80" autocomplete="email" value="${esc(email)}" required>
        <button type="submit">申请发票 · Request an invoice</button>
      </form>`;
  }
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>发票</title>
<style>
  body{margin:0;background:#f6f4ef;color:#1a1a17;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif}
  main{max-width:420px;margin:0 auto;padding:28px 20px 48px}
  h1{font-size:22px;font-weight:560;margin:0 0 8px}
  .sub{color:#5c5a54;font-size:14px;line-height:1.5;margin:0 0 18px}
  .meta{background:#fff;border:1px solid #e4e0d6;border-radius:14px;padding:14px 16px;margin-bottom:16px}
  .row{display:flex;justify-content:space-between;gap:12px;font-size:15px;margin-top:8px}
  .row:first-child{margin-top:0}
  .k{color:#5c5a54}
  .err{color:#8a3a2a;background:#f6e6e1;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:14px}
  .seg{display:flex;gap:8px;margin-bottom:14px}
  .seg label{flex:1;text-align:center;padding:12px 8px;border-radius:12px;border:1px solid #d8d4c8;background:#fff;font-size:15px}
  .seg label:has(input:checked){border-color:#1a1a17;font-weight:560}
  .seg input{margin-right:6px}
  .lbl{display:block;font-size:13px;color:#5c5a54;margin:0 0 6px}
  input[type=text],input[type=email],input:not([type]){width:100%;box-sizing:border-box;font-size:16px;padding:14px;border-radius:12px;border:1px solid #d8d4c8;margin:0 0 14px;font-family:inherit}
  button{width:100%;height:52px;border:0;border-radius:14px;background:#1a1a17;color:#fff;font-size:16px;font-family:inherit}
  a.text{color:#1a1a17}
  form:not(:has(input[value="company"]:checked)) .tax{display:none}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

module.exports = {
  TOKEN_RE, loadByToken, loadById, staffBlock, publicView, statusOf,
  ensureToken, publicUrl, applyDetails, pageHtml,
};
