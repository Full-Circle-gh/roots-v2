#!/usr/bin/env node
// Proxy watchdog — the Meituan/Guanyi daemons push stock through a single remote
// HTTP proxy on the GZ box (GUANYI_PROXY_URL / MEITUAN_PROXY_URL). If that proxy
// dies, the daemons keep retrying but stock stops flowing to both channels with
// no visible signal. This cron-run probe tests the proxy and, after a sustained
// outage, raises a CRITICAL banner in the admin (platform_broadcasts) so the
// operator knows. It auto-clears the banner once the proxy recovers.
//
// It does NOT restart anything — the proxy lives on a different machine. It is a
// notifier only. Run from cron every few minutes:
//   */3 * * * * cd /root/roots-v2 && node scripts/proxy-watchdog.js >> /var/log/proxy-watchdog.log 2>&1
//
// Alert fires after FAIL_THRESHOLD consecutive failures (default 3 ≈ 9 min on a
// 3-min cron) so a single transient blip — which the daemons self-heal from —
// does not page anyone.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', '.proxy_watchdog_state.json');
const ENV_FILE = path.join(ROOT, '.env');
const FAIL_THRESHOLD = parseInt(process.env.PROXY_WATCHDOG_FAILS || '3', 10);
const PROBE_URL = process.env.PROXY_WATCHDOG_TARGET || 'https://www.guanyierp.com';
const TIMEOUT_S = 12;

// Read a key out of .env without pulling in dotenv (cron has no env loaded).
function envVal(key) {
  if (process.env[key]) return process.env[key];
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+)\\s*$', 'm'));
    if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
  } catch (e) { /* no .env */ }
  return null;
}

// Open the SQLite file directly (don't require ../database — that would re-run
// every migration on each cron tick). Same path resolution the daemons use.
function openDb() {
  const Database = require('better-sqlite3');
  const dbPath = envVal('DB_PATH') || path.join(ROOT, 'data', 'roots.db');
  return new Database(dbPath);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { fails: 0, alerted: false }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (e) { console.error('state write failed:', e.message); }
}

function stamp() { return new Date().toISOString(); }

// Optional push alert to a WeChat Work group bot (or any webhook that accepts the
// same {msgtype:text} body). Configured via PROXY_WATCHDOG_WEBHOOK in .env; no-op
// when unset, so the banner stays the baseline alert and the push is additive.
function notifyWebhook(content) {
  const url = envVal('PROXY_WATCHDOG_WEBHOOK');
  if (!url) return;
  try {
    execFileSync('curl', [
      '-s', '-o', '/dev/null',
      '--max-time', '10',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ msgtype: 'text', text: { content } }),
      url,
    ], { timeout: 13000 });
  } catch (e) { console.error('webhook send failed:', e.message); }
}

// curl the probe URL through the proxy; any HTTP response (even 3xx/4xx) means
// the proxy itself is alive. Only a transport failure counts as "down".
function proxyOk(proxyUrl) {
  try {
    const out = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(TIMEOUT_S),
      '-x', proxyUrl, PROBE_URL,
    ], { encoding: 'utf8', timeout: (TIMEOUT_S + 3) * 1000 }).trim();
    return /^[1-5]\d\d$/.test(out) && out !== '000';
  } catch (e) {
    return false;
  }
}

// Raise (or refresh) the single watchdog banner. Idempotent: one active row.
function raiseAlert(db) {
  const open = db.prepare(
    "SELECT id FROM platform_broadcasts WHERE created_by = 'proxy-watchdog' AND active = 1"
  ).get();
  if (open) return; // already showing
  db.prepare(`
    INSERT INTO platform_broadcasts
      (title_en, title_cn, body_en, body_cn, level, audience, active, created_by, created_at)
    VALUES (?, ?, ?, ?, 'critical', 'all', 1, 'proxy-watchdog', CURRENT_TIMESTAMP)
  `).run(
    'Stock-sync proxy unreachable',
    '库存同步代理不可达',
    'The Meituan/Guanyi stock-sync proxy is not responding. Stock pushes to both channels are paused and will resume automatically when the proxy is back. If this persists, restart the proxy on the GZ box.',
    '美团/管易库存同步代理无响应，两渠道的库存推送已暂停，代理恢复后将自动继续。若持续不恢复，请在广州服务器上重启代理。'
  );
}
function clearAlert(db) {
  db.prepare("UPDATE platform_broadcasts SET active = 0 WHERE created_by = 'proxy-watchdog' AND active = 1").run();
}

function main() {
  const proxyUrl = envVal('GUANYI_PROXY_URL') || envVal('MEITUAN_PROXY_URL');
  if (!proxyUrl) { console.log(`${stamp()} no proxy URL configured — nothing to watch`); return; }

  const ok = proxyOk(proxyUrl);
  const state = loadState();

  if (ok) {
    if (state.alerted) {
      try { const db = openDb(); clearAlert(db); db.close(); } catch (e) { console.error('clear failed:', e.message); }
      notifyWebhook(`✅ Stock-sync proxy RECOVERED — Meituan/Guanyi pushes resuming. (${stamp()})`);
      console.log(`${stamp()} proxy RECOVERED — alert cleared`);
    }
    saveState({ fails: 0, alerted: false });
    return;
  }

  // failure
  state.fails = (state.fails || 0) + 1;
  console.log(`${stamp()} proxy probe FAILED (${state.fails}/${FAIL_THRESHOLD})`);
  if (state.fails >= FAIL_THRESHOLD && !state.alerted) {
    try { const db = openDb(); raiseAlert(db); db.close(); state.alerted = true; console.log(`${stamp()} ALERT raised (banner)`); }
    catch (e) { console.error('raise failed:', e.message); }
    notifyWebhook(`⚠️ Stock-sync proxy UNREACHABLE for ${state.fails} checks — Meituan/Guanyi stock pushes are paused. Check tinyproxy on the GZ box (8.163.120.72). (${stamp()})`);
  }
  saveState(state);
}

main();
