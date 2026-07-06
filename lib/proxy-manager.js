'use strict';

// Meituan-channel proxy failover manager + health model.
//
// The 2026-06-28 outage: the rented GZ datacenter proxy (tinyproxy on
// 8.163.120.72) silently wedged, and BOTH Meituan channels — which both routed
// through it — went dark for hours with no alert. The fix has two halves:
//   1) decouple the channels onto independent paths, and
//   2) make each channel auto-fail-over across an ORDERED list of proxies, so a
//      single proxy dying degrades gracefully instead of stopping sync.
//
// This module is the shared brain. scripts/proxy-watchdog.js runs the check loop
// (health-probes every path, writes the active choice to data/proxy-active.json,
// and pages the DEDICATED WeCom proxy bot — PROXY_WATCHDOG_WEBHOOK — on EVERY
// state change). The launchers read the active choice:
//   • lib/meituan-browser.js  (外卖 / tianhe)  via resolveProxy()
//   • scripts/shangou-chrome.js (闪购 / yuexiu) via readActive('yuexiu')
//
// Priority (first healthy wins):
//   tianhe (外卖):  residential → GZ → direct
//   yuexiu (闪购):  residential → GZ → direct
// 'direct' = '' (no proxy). residential = SOCKS5 (store Lenovo, real GD IP — best
// for anti-flag). GZ = authed HTTP (rented datacenter proxy, healthy fallback).

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const ENV_FILE   = path.join(ROOT, '.env');
const STATE_FILE = path.join(ROOT, 'data', 'proxy-active.json');
const PROBE_URL  = process.env.PROXY_PROBE_URL || 'https://e.waimai.meituan.com/';

// Read a key from process.env, falling back to .env directly (so a cron/pm2 run
// without dotenv still resolves config). Mirrors scripts/health-watchdog.js.
function envVal(key, fallback = '') {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)\\s*$', 'm'));
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  } catch (_) { /* no .env */ }
  return fallback;
}

// The residential SOCKS5 (store Lenovo over WireGuard). Playwright/Chrome want
// socks5://; the health probe uses socks5h:// for remote DNS.
function residentialUrl() { return envVal('PROXY_RESIDENTIAL', 'socks5://10.8.0.2:1080'); }
// The rented GZ authed-HTTP proxy. Reuse the Guanyi var (same proxy) so there is
// one source of truth; PROXY_GZ overrides if ever split.
function gzUrl()          { return envVal('PROXY_GZ', envVal('GUANYI_PROXY_URL', '')); }

// Ordered candidate list. Every channel now uses the SAME chain: residential (the
// store's real regional IP — best anti-flag) → GZ datacenter proxy (same-region
// fallback) → direct (last resort). yuexiu (闪购) previously skipped the GZ tier and
// dropped from residential straight to the box's Hong Kong IP; a cross-region
// datacenter IP is Meituan's dominant risk-control signal, so a brief residential
// flap would trip 验证中心. Holding GZ in the middle keeps the exit in-region — and
// it costs nothing when residential is healthy (first-healthy-wins) or when GZ is
// unconfigured/down (the health probe fails it and it falls through to direct, as
// before). channel is retained for signature/back-compat though the chain is now
// uniform. 'direct' is always the last resort.
function candidates(channel) {
  const res = residentialUrl();
  const gz  = gzUrl();
  const list = [
    { label: 'residential', url: res },
    { label: 'gz',          url: gz  },
    { label: 'direct',      url: ''  },
  ];
  // Drop proxy candidates with no URL configured; keep 'direct' always.
  return list.filter(c => c.label === 'direct' || c.url);
}

// curl one path to Meituan. true only on HTTP 200. A proxy that TCP-accepts but
// can't relay (the tinyproxy wedge) returns a non-200/000 and is treated as down.
function probe(url, timeoutSec = 10) {
  return new Promise((resolve) => {
    const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(timeoutSec)];
    if (url) {
      // socks5h = resolve DNS through the proxy (correct for a China exit).
      const probeUrl = url.startsWith('socks5://') ? 'socks5h://' + url.slice('socks5://'.length) : url;
      args.push('-x', probeUrl);
    }
    args.push(PROBE_URL);
    try {
      execFile('curl', args, { timeout: (timeoutSec + 5) * 1000 }, (_e, stdout) => {
        resolve((parseInt(String(stdout).trim(), 10) || 0) === 200);
      });
    } catch (_) { resolve(false); }
  });
}

// Evaluate a channel: probe every candidate, pick the first healthy one.
// Returns { active:{label,url}, health:{label:bool}, candidates:[...] }.
async function evaluate(channel) {
  const cands = candidates(channel);
  const health = {};
  let active = null;
  for (const c of cands) {
    const ok = await probe(c.url);
    health[c.label] = ok;
    if (ok && !active) active = c;
  }
  if (!active) active = cands[cands.length - 1]; // last resort = direct
  return { active, health, candidates: cands };
}

// ── State file (written by the watchdog, read by the launchers) ────────────────
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}
// Active proxy URL for a channel: '' = direct, undefined = no state yet (caller
// should fall back to its env default).
function readActive(channel) {
  const s = readState();
  const e = s && s[channel];
  return e && typeof e.url === 'string' ? e.url : undefined;
}
function writeState(stateByChannel) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateByChannel, null, 2));
    return true;
  } catch (e) { console.error('[proxy-manager] state write failed:', e.message); return false; }
}

// ── Alerting to the DEDICATED proxy WeCom bot ─────────────────────────────────
// Deliberately the proxy bot (PROXY_WATCHDOG_WEBHOOK), NOT the ops/order groups,
// so every proxy event lands in the channel the operator made for it.
const _lastSent = new Map();
const DEDUP_MS = 60_000;
function shTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
async function sendProxyAlert(text) {
  const raw = envVal('PROXY_WATCHDOG_WEBHOOK', '');
  if (!raw || !text) return false;
  const url = /^https?:\/\//i.test(raw)
    ? raw : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${raw}`;
  try { if (new URL(url).hostname !== 'qyapi.weixin.qq.com') return false; } catch (_) { return false; }
  const now = Date.now();
  if (_lastSent.get(text) && now - _lastSent.get(text) < DEDUP_MS) return false;
  _lastSent.set(text, now);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `[${shTime()}] ${text}` } }),
    });
    if (!res.ok) console.error(`[proxy-manager] webhook HTTP ${res.status}`);
    return res.ok;
  } catch (e) { console.error('[proxy-manager] alert failed:', e.message); return false; }
}

const CHANNELS = ['tianhe', 'yuexiu'];
const CHANNEL_CN = { tianhe: '天河 外卖', yuexiu: '越秀 闪购' };
const LABEL_CN   = { residential: '门店住宅代理', gz: 'GZ 机房代理', direct: '直连(香港)' };

module.exports = {
  STATE_FILE, CHANNELS, CHANNEL_CN, LABEL_CN,
  envVal, residentialUrl, gzUrl, candidates,
  probe, evaluate, readState, readActive, writeState, sendProxyAlert,
};
