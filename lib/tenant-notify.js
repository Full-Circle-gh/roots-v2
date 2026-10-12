'use strict';

// Tenant-facing operator notifications (Phase — category 2).
//
// When something needs the MERCHANT's attention — a channel session expired, a
// store box went offline — the tenant's own operators should hear about it, not
// just the platform ops desk. The best fit is the per-tenant WeCom app the
// merchant already uses for new-order alerts (wecom_app creds in tenant-creds):
// it pushes to everyone in the app's visible range without needing per-user IDs.
//
// This is a thin, dependency-light sender (no require of routes/retail.js, which
// would be circular) that mirrors that path. Best-effort by design: a tenant
// with no WeCom app configured, or a transient send failure, never throws —
// notifications are advisory, never load-bearing.

const { getTenantCreds } = require('./tenant-creds');

const QYAPI = 'https://qyapi.weixin.qq.com';

async function wecomAppToken(corpId, secret) {
  const res = await fetch(`${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('wecom_token: ' + (j.errmsg || j.errcode || 'no token'));
  return j.access_token;
}

// Send a markdown message to a tenant's WeCom app (touser '@all'). Resolves to
// { ok } or { ok:false, error } — never rejects. `content` is WeCom markdown.
async function notifyTenantOperators(tenantId, content) {
  try {
    const wa = (getTenantCreds(tenantId).integrations || {}).wecom_app || {};
    if (!wa.corpId || !wa.agentId || !wa.secret) return { ok: false, error: 'wecom_app_not_configured' };
    const token = await wecomAppToken(wa.corpId, wa.secret);
    const res = await fetch(`${QYAPI}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: '@all',
        msgtype: 'markdown',
        agentid: Number(wa.agentId) || wa.agentId,
        markdown: { content: String(content).slice(0, 2000) },
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.errcode && j.errcode !== 0) return { ok: false, error: 'wecom_send: ' + (j.errmsg || j.errcode) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The new-order group's own channel, for ONE named tenant, from outside a
// request scope (lib/delivery-reminders.js runs on a bare timer with a tenant
// id and that tenant's handle). The same choice routes/retail.js's
// sendWecomOrderAlert makes: the WeCom app when configured, else the group-bot
// webhook saved at `notifications.wecom_order_webhook` in the tenant's own
// storefront_config. That function reads both through tdb(), which on a bare
// timer answers the MAIN handle, so it cannot be called from here.
//
// `db` is the tenant's handle. Resolves to { ok } or { ok:false, error } and
// never rejects; 'not_configured' when the tenant has neither channel.
function orderGroupWebhook(db) {
  let raw = '';
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'notifications.wecom_order_webhook'").get();
    if (row) { try { raw = JSON.parse(row.value_json); } catch (e) { raw = row.value_json; } }
    if (!raw) {
      const obj = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'notifications'").get();
      if (obj) raw = (JSON.parse(obj.value_json) || {}).wecom_order_webhook || '';
    }
  } catch (e) { return null; /* no config table on an un-migrated account: no webhook */ }
  try {
    const u = String(raw || '').trim();
    if (!u || new URL(u).hostname !== 'qyapi.weixin.qq.com') return null;
    return u;
  } catch (e) { return null; /* not a URL: treated as unset, as wecomWebhookUrl does */ }
}

function orderGroupConfigured(tenantId, db) {
  let wa = {};
  try { wa = (getTenantCreds(tenantId).integrations || {}).wecom_app || {}; } catch (e) { wa = {}; }
  return !!(wa.corpId && wa.agentId && wa.secret) || !!orderGroupWebhook(db);
}

async function notifyOrderGroup(tenantId, db, content) {
  let wa = {};
  try { wa = (getTenantCreds(tenantId).integrations || {}).wecom_app || {}; } catch (e) { wa = {}; }
  if (wa.corpId && wa.agentId && wa.secret) return notifyTenantOperators(tenantId, content);
  const url = orderGroupWebhook(db);
  if (!url) return { ok: false, error: 'not_configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: String(content).slice(0, 2000) } }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.errcode && j.errcode !== 0) return { ok: false, error: 'wecom_webhook: ' + (j.errmsg || j.errcode) };
    return res.ok ? { ok: true } : { ok: false, error: 'wecom_webhook: HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyTenantOperators, notifyOrderGroup, orderGroupConfigured, orderGroupWebhook };
