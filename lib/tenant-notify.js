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

module.exports = { notifyTenantOperators };
