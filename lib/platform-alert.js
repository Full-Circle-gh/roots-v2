'use strict';

// Platform-level ops alerting — pages the FULL CIRCLE platform team (not a
// tenant's own ops group) about cross-tenant integration events: a "Get help"
// request from a tenant's setup wizard, or an integration falling into error.
//
// Deliberately SEPARATE from lib/ops-alert.js, which reads a tenant's own
// storefront_config webhook and pages that tenant's staff. This one reads a
// single PLATFORM webhook from env (PLATFORM_OPS_WEBHOOK) so it works the same
// regardless of which tenant triggered it. Unset = silent no-op. Best-effort:
// alerting NEVER blocks or crashes a request, and NEVER falls back to a tenant
// webhook (that would leak one tenant's issue into another's group).

function webhookUrl() {
  try {
    const raw = String(process.env.PLATFORM_OPS_WEBHOOK || '').trim();
    if (!raw) return '';
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${raw}`;
    if (new URL(url).hostname !== 'qyapi.weixin.qq.com') return '';
    return url;
  } catch (_) { return ''; }
}

// Asia/Shanghai HH:mm, independent of server TZ.
function shTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Fire-and-forget. Resolves true/false; callers may ignore. Never throws.
async function sendPlatformAlert(text) {
  const url = webhookUrl();
  if (!url || !text) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `[${shTime()}] ${text}` } }),
    });
    if (!res.ok) console.error(`[platform-alert] webhook HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error('[platform-alert] send failed:', e.message);
    return false;
  }
}

function alertEnabled() { return !!webhookUrl(); }

module.exports = { sendPlatformAlert, alertEnabled };
