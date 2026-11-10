'use strict';

// A customer asked for a 发票. The details go to their own WeCom group, never
// the new-order group and never the WeCom app. The address is
// storefront_config `notifications.wecom_invoice_webhook` (Settings → Push).
// Blank, or any host other than qyapi.weixin.qq.com, means nothing is sent.
//
// WHEN. A 发票 is issued against payment, so a request made at checkout is
// sent when the order is paid. A request made later — the order page, or the
// till's fapiao code — is sent when it is saved, and a second save says the
// details changed. A Meituan poll is not a request: invoiceNotifyReason sends
// once when the platform first asks, and again only when a title or tax ID
// arrives that the first card did not carry.

const KEY = 'notifications.wecom_invoice_webhook';

function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 200);
}

function validWebhook(url) {
  const u = oneLine(url, 500);
  if (!u) return '';
  try {
    if (new URL(u).hostname !== 'qyapi.weixin.qq.com') return '';
    return u;
  } catch { return ''; }
}

// The same company test the accounting copy uses: a set type wins, and a tax
// ID on an older row that never stored a type is still a company.
function isCompany(o) {
  if (!o) return false;
  if (o.invoice_type) return o.invoice_type === 'company';
  return !!oneLine(o.invoice_tax_id);
}

// 'new' | 'updated' | null. For a poll that may repeat, not for a person who
// just pressed the button — that press always sends.
function invoiceNotifyReason(before, after) {
  if (!after || !Number(after.needs_invoice)) return null;
  if (after.invoice_status === 'issued') return null;
  const st = String(after.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'pending_payment') return null;
  const had = !!(before && Number(before.needs_invoice));
  const arrived = (field) => !oneLine(before && before[field]) && !!oneLine(after[field]);
  if (!had) return 'new';
  if (arrived('invoice_title') || arrived('invoice_tax_id') || arrived('invoice_email')) return 'updated';
  return null;
}

function buildInvoiceCard(o, opts) {
  const updated = !!(opts && opts.updated);
  const company = isCompany(o);
  const amount = '¥' + Number(o && o.total || 0).toFixed(2);
  const lines = updated
    ? ['**开票资料已更新**', '**Invoice details updated**']
    : ['**开票申请**', '**Invoice request**'];
  lines.push(
    `> 订单号 Order: \`${oneLine(o && (o.order_no || o.id), 40)}\``,
    `> 金额 Amount: <font color="warning">${amount}</font>`,
    `> 类型 Type: ${company ? '企业 Company' : '个人 Personal'}`,
    `> 抬头 Title: ${oneLine(o && o.invoice_title)}`,
  );
  if (company) lines.push(`> 税号 Tax ID: ${oneLine(o && o.invoice_tax_id, 40)}`);
  const email = oneLine(o && o.invoice_email, 80);
  if (email) lines.push(`> 邮箱 Email: ${email}`);
  return lines.join('\n');
}

function testCard() {
  return [
    '**测试**',
    '**Test message**',
    '> 收到本条说明开票申请已接通 ✅',
    '> Receiving this means invoice requests are connected ✅',
  ].join('\n');
}

function readSavedWebhook() {
  try {
    const n = require('./store-config').loadConfig().notifications || {};
    return validWebhook(n.wecom_invoice_webhook);
  } catch { return ''; }
}

async function postMarkdown(url, content) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
    const j = await resp.json().catch(() => ({}));
    if (j.errcode === 0) return { ok: true };
    return { ok: false, msg: j.errmsg || ('errcode ' + j.errcode) };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// Fire-and-forget. Returns { sent: false } when there is nothing to post, so
// a caller can tell a missing webhook from a card that left. Never throws.
function notifyOrder(db, orderId, opts, deps) {
  const d = deps || {};
  try {
    const url = d.webhook != null ? validWebhook(d.webhook) : readSavedWebhook();
    if (!url) return { sent: false };
    const id = parseInt(orderId, 10);
    if (!id) return { sent: false };
    const o = db.prepare(
      `SELECT id, order_no, total, status, needs_invoice, invoice_status,
              invoice_type, invoice_title, invoice_tax_id, invoice_email
         FROM retail_orders WHERE id = ?`
    ).get(id);
    if (!o || !Number(o.needs_invoice)) return { sent: false };
    if (o.invoice_status === 'issued') return { sent: false };
    const st = String(o.status || '').toLowerCase();
    if (st === 'cancelled' || st === 'pending_payment') return { sent: false };
    const updated = !!(opts && opts.updated);
    const content = buildInvoiceCard(o, { updated });
    const post = d.post || postMarkdown;
    Promise.resolve(post(url, content)).then((r) => {
      const ok = !!(r && r.ok);
      if (!ok) console.warn('[wecom invoice]', id, (r && r.msg) || 'failed');
      // A caller that hands in its own post (a test) is not a real send.
      if (d.post) return;
      try {
        require('./notify-log').logNotification({
          channel: 'wecom',
          kind: updated ? 'invoice_request_updated' : 'invoice_request',
          subject: o.order_no || String(id),
          entityType: 'order',
          entityId: id,
          ok,
          error: ok ? null : ((r && r.msg) || 'failed'),
        });
      } catch (e) { /* the log must never be able to fail a send */ }
    }).catch((e) => console.warn('[wecom invoice]', id, e.message));
    return { sent: true };
  } catch (e) {
    console.warn('[wecom invoice]', orderId, e.message);
    return { sent: false };
  }
}

module.exports = {
  KEY, validWebhook, invoiceNotifyReason, buildInvoiceCard, testCard,
  readSavedWebhook, postMarkdown, notifyOrder,
};
