'use strict';

// Best-effort ops alerting to a WeCom group robot (企业微信群机器人) webhook.
//
// The destination is configured in retail-admin → Settings → Push notifications →
// "System Alerts" — a DEDICATED WeCom group, deliberately kept SEPARATE from the
// order group. Stored in storefront_config as `system_alerts.enabled` +
// `system_alerts.wecom_webhook`. Disabled or unset = silently no-op: alerting NEVER
// blocks or crashes a daemon, and it NEVER falls back to the order webhook. Used to
// page ops the moment a Meituan/闪购 channel disconnects (login expired, risk-control,
// proxy down) or the storefront stops responding, and again on recovery.
//
// Set it up: create a NEW WeCom group → ··· → 添加群机器人 → copy the Webhook URL, paste
// it in Settings, toggle System Alerts on, and use "Send test" to verify it lands.
//
// Config is read via a lightweight READ-ONLY sqlite open — NOT require('../database'),
// which runs schema+migrations on load and would do so on every health-watchdog tick.

const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data', 'roots.db');
let _ro = null; // cached read-only connection (per-process)

function roConfig(key) {
  try {
    if (!_ro) {
      const Database = require('better-sqlite3');
      _ro = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    }
    const row = _ro.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : null;
  } catch (_) { return null; }
}

// Resolve the System-Alerts webhook from settings. Returns '' when the feature is
// off, unconfigured, or points anywhere other than qyapi.weixin.qq.com.
function webhookUrl() {
  try {
    if (roConfig('system_alerts.enabled') !== true) return '';
    const raw = String(roConfig('system_alerts.wecom_webhook') || '').trim();
    if (!raw) return '';
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${raw}`;
    if (new URL(url).hostname !== 'qyapi.weixin.qq.com') return '';
    return url;
  } catch (_) { return ''; }
}

// Anti-spam: drop an identical message seen within DEDUP_MS (a safety net on top
// of the daemons' own once-per-transition latches).
const DEDUP_MS = 60_000;
const lastSent = new Map(); // text -> epochMs

// Asia/Shanghai HH:mm, independent of server TZ — staff read local time.
function shTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Fire-and-forget. Returns a promise that resolves true/false; callers may ignore.
async function sendOpsAlert(text) {
  const url = webhookUrl();
  if (!text) return false;
  if (!url) {
    // A disabled webhook used to be an invisible no-op. That is fine for a
    // recovery notice and wrong for everything else: the callers that reach here
    // are reporting something nobody else will report — an order the courier
    // push gave up on, a channel that logged out. Losing the message silently
    // means the only record is a daemon log nobody is watching. Say so, at error
    // level, with the text intact, so it is still recoverable from the log.
    console.error(`[ops-alert] SUPPRESSED (alerts disabled): ${text}`);
    return false;
  }
  const now = Date.now();
  const prev = lastSent.get(text);
  if (prev && now - prev < DEDUP_MS) return false;
  lastSent.set(text, now);
  const content = `[${shTime()}] ${text}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
    });
    if (!res.ok) console.error(`[ops-alert] webhook HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error('[ops-alert] send failed:', e.message);
    return false;
  }
}

function alertEnabled() { return !!webhookUrl(); }

module.exports = { sendOpsAlert, alertEnabled };
