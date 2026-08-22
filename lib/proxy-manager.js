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
//   yuexiu (闪购):  residential → direct
// 'direct' = '' (no proxy). residential = SOCKS5 (store Lenovo, real GD IP — best
// for anti-flag). GZ = authed HTTP (rented datacenter proxy, healthy fallback).
//
// Two rules keep a channel from getting STUCK off the residential exit — both
// learned from 天河 sitting on 直连 while the residential path was fine:
//
//   1) One ruler for "healthy". probe() judges a path exactly the way every
//      channel daemon judges it (any real HTTP status = the proxy relayed; only
//      000/timeout = down). It used to demand a bare 200, which the merchant
//      portal only gives a logged-in request — so a perfectly good exit answering
//      302-to-login was condemned, tianhe failed over past GZ to 直连, and it
//      could never fail BACK, because the probe that would clear it could never
//      return 200. Running 外卖 from the HK datacenter IP is what risk-control
//      picks up, and a 验证中心 challenge is what the operator finally sees.
//      If you ever tighten this, tighten the daemons in the same commit.
//
//   2) The decision expires. See STATE_TTL_MS below.

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

// Ordered candidate list per channel. 'direct' is always the last resort.
function candidates(channel) {
  const res = residentialUrl();
  const gz  = gzUrl();
  const list = channel === 'tianhe'
    ? [ { label: 'residential', url: res }, { label: 'gz', url: gz }, { label: 'direct', url: '' } ]
    : [ { label: 'residential', url: res }, { label: 'direct', url: '' } ];
  // Drop proxy candidates with no URL configured; keep 'direct' always.
  return list.filter(c => c.label === 'direct' || c.url);
}

// curl one path to Meituan. ANY real HTTP status back from the origin proves the
// proxy relayed; only 000 (no reply / timeout) is down. This is the same ruler
// every channel daemon already uses (meituan/shangou/qingyun all accept
// 200..599) and it must stay that way — see the note above about a proxy being
// condemned here while the daemon sitting next to it reads the same path as fine.
//
// Why 200-only was wrong: PROBE_URL is a MERCHANT portal root. Unauthenticated —
// which the probe always is, it carries no cookies — it answers a 302 to the
// login page, and 403 while risk-control is holding the IP. Both are the origin
// talking, so both prove the proxy→Meituan path works.
//
// The wedged-proxy case that motivated the strict rule is still caught, because
// PROBE_URL is https: an HTTP proxy that can't complete the CONNECT tunnel, or a
// SOCKS5 exit whose handshake fails, never yields an origin status at all —
// curl reports the failure as 000 (the proxy's own CONNECT code lands in
// %{http_connect}, deliberately not read here). So a relay that can't relay
// still reads DOWN; a healthy exit that gets redirected no longer does.
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
        const code = parseInt(String(stdout).trim(), 10) || 0;
        resolve(code >= 200 && code < 600);
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
//
// The file is a CACHE of a live decision, so it is only worth obeying while
// something is still making that decision. A stopped/crashed proxy-watchdog used
// to leave its last word standing forever: whatever path it had failed over to
// (usually 直连) stayed pinned in every launcher, and because 'direct' is always
// "healthy" nothing ever alerted. Nothing watches the watchdog either —
// health-watchdog only probes the storefront — so the channel simply ran from the
// datacenter IP until risk-control noticed. Hence a TTL: an entry older than
// PROXY_STATE_TTL_MS reads as absent, callers fall back to their configured
// default, and ensureFresh() below re-elects a path from scratch.
const STATE_TTL_MS = Number(process.env.PROXY_STATE_TTL_MS || 300_000); // 10 watchdog ticks

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

// Age of one channel's entry in ms, or Infinity when it can't be dated (missing,
// or written by a build older than the `at` stamp — treated as stale so it gets
// re-elected and re-stamped on the next pass rather than trusted indefinitely).
// Legacy entries carry only `ts`, which is Shanghai WALL CLOCK with no zone on
// it, so it is read back as +08:00 — parsing it as UTC on a UTC box would date it
// 8h in the future and make a stale entry look brand new.
function entryAgeMs(entry, now = Date.now()) {
  if (!entry) return Infinity;
  if (Number.isFinite(entry.at)) return Math.max(0, now - entry.at);
  if (typeof entry.ts === 'string' && entry.ts) {
    const t = Date.parse(entry.ts.replace(' ', 'T') + '+08:00');
    if (Number.isFinite(t)) return Math.max(0, now - t);
  }
  return Infinity;
}
// True when no live decision stands for this channel — nothing has been written,
// or the writer stopped writing. Callers use it to say so out loud.
function isStale(channel, now = Date.now()) {
  return entryAgeMs(readState()[channel], now) > STATE_TTL_MS;
}

// Active proxy URL for a channel: '' = direct, undefined = no CURRENT state
// (caller should fall back to its env default).
function readActive(channel) {
  const s = readState();
  const e = s && s[channel];
  if (!e || typeof e.url !== 'string') return undefined;
  if (entryAgeMs(e) > STATE_TTL_MS) return undefined;
  return e.url;
}

// Merge one channel's decision into the file without disturbing the others, and
// stamp it so readers can tell how old it is.
function writeChannel(channel, entry) {
  const state = readState();
  state[channel] = { ...entry };
  return writeState(state);
}

function writeState(stateByChannel) {
  try {
    const now = Date.now();
    const stamped = {};
    for (const [k, v] of Object.entries(stateByChannel || {})) {
      // Re-stamp only what this writer is asserting now; entries it copied
      // through from the file keep the age they already had.
      stamped[k] = (v && Number.isFinite(v.at)) ? v : { ...v, at: now };
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stamped, null, 2));
    return true;
  } catch (e) { console.error('[proxy-manager] state write failed:', e.message); return false; }
}

// Re-elect a channel's path when no fresh decision stands, so a channel gets back
// onto the residential exit on its own instead of waiting for someone to notice
// the watchdog is gone. No-op (and no probes) while the watchdog is writing.
// Returns the elected candidate when it re-elected, else null.
//
// Whoever calls it first wins; concurrent callers share the one in-flight run,
// and a re-election is not retried more often than the TTL, so a proxy that is
// down end-to-end doesn't turn every daemon tick into a probe storm.
const _reelecting  = new Map();  // channel -> in-flight promise
const _lastReelect = new Map();  // channel -> epoch ms of the last attempt
async function ensureFresh(channel, now = Date.now()) {
  if (!isStale(channel, now)) return null;
  if (_reelecting.has(channel)) return _reelecting.get(channel);
  const last = _lastReelect.get(channel) || 0;
  if (last && now - last < STATE_TTL_MS) return null;
  _lastReelect.set(channel, now);
  const run = (async () => {
    try {
      const { active } = await evaluate(channel);
      writeChannel(channel, { url: active.url, label: active.label, ts: shStamp() });
      return active;
    } catch (e) {
      console.error('[proxy-manager] re-election failed:', e.message);
      return null;
    } finally { _reelecting.delete(channel); }
  })();
  _reelecting.set(channel, run);
  return run;
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
// The human-readable half of a state entry: Shanghai wall clock, no zone marker.
// Only ever read by a person — `at` is what code dates an entry by.
function shStamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19);
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
  STATE_FILE, STATE_TTL_MS, CHANNELS, CHANNEL_CN, LABEL_CN,
  envVal, residentialUrl, gzUrl, candidates,
  probe, evaluate, readState, readActive, writeState, writeChannel,
  entryAgeMs, isStale, ensureFresh, shStamp, sendProxyAlert,
};
