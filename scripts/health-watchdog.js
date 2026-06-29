#!/usr/bin/env node
// Health watchdog — the 2026-06-28 outage was a box that wedged after 47 days of
// uptime (sshd/nginx/app all accepting TCP but returning zero bytes; low CPU,
// disk fine, no OOM) and then stayed dark because PM2 had no boot autostart.
//
// This cron-run probe does two jobs every few minutes:
//   1. APP LIVENESS — hits the local app on :4000. After FAIL_THRESHOLD
//      consecutive failures it runs `pm2 restart roots-v2` and pages the ops
//      WeCom group, then pages again on recovery. (Self-heals the common case
//      where only the node app dies — NOT a full kernel wedge, which freezes
//      cron too; for that you need the Aliyun-side monitor.)
//   2. LEAK TREND — appends fd/proc/thread/load/mem/disk to a log every run so a
//      slow resource leak (the suspected root cause) is visible as a rising
//      curve, and pages PRE-EMPTIVELY when fd/disk/mem cross a soft threshold —
//      i.e. before the box wedges, not after.
//
// Install (cron, every 2 min):
//   */2 * * * * cd /root/roots-v2 && /usr/bin/node scripts/health-watchdog.js >> /var/log/roots-health.log 2>&1
//
// Tunables via env (.env or shell): HEALTH_APP_URL, HEALTH_FAILS,
//   HEALTH_FD_WARN, HEALTH_DISK_WARN_PCT, HEALTH_MEM_WARN_MB.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const STATE_FILE = path.join(ROOT, 'data', '.health_watchdog_state.json');

// Read a key out of .env without pulling in dotenv (cron has no env loaded).
function envVal(key, fallback) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+)\\s*$', 'm'));
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  } catch (_) { /* no .env */ }
  return fallback;
}

// Make the webhook visible to lib/ops-alert before requiring it.
if (!process.env.WECOM_ALERT_WEBHOOK) {
  const wh = envVal('WECOM_ALERT_WEBHOOK', '');
  if (wh) process.env.WECOM_ALERT_WEBHOOK = wh;
}
let sendOpsAlert = async () => false;
try { ({ sendOpsAlert } = require(path.join(ROOT, 'lib', 'ops-alert'))); } catch (_) { /* alert optional */ }

const APP_URL = envVal('HEALTH_APP_URL', 'http://127.0.0.1:4000/');
const FAIL_THRESHOLD = parseInt(envVal('HEALTH_FAILS', '2'), 10);
const FD_WARN = parseInt(envVal('HEALTH_FD_WARN', '50000'), 10);
const DISK_WARN_PCT = parseInt(envVal('HEALTH_DISK_WARN_PCT', '85'), 10);
const MEM_WARN_MB = parseInt(envVal('HEALTH_MEM_WARN_MB', '200'), 10);
// Above this 1-min load-per-core, a probe timeout is treated as box overload
// (thrashing) rather than a dead app, and the auto-restart is suppressed.
const LOAD_SKIP_PER_CORE = parseFloat(envVal('HEALTH_LOAD_SKIP_PER_CORE', '4'));
const PROBE_TIMEOUT_MS = 8000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { fails: 0, down: false, warned: {} }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (e) { console.error('[health] state write failed:', e.message); }
}

function readInt(file) {
  try { return parseInt(fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0], 10); }
  catch (_) { return -1; }
}
function countLines(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n').length; }
  catch (_) { return -1; }
}
function diskPctUsed(mount) {
  try {
    const out = execFileSync('df', ['-P', mount], { encoding: 'utf8' }).trim().split('\n');
    const m = out[out.length - 1].match(/(\d+)%/);
    return m ? parseInt(m[1], 10) : -1;
  } catch (_) { return -1; }
}
function memAvailMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : -1;
  } catch (_) { return Math.round(os.freemem() / 1048576); }
}

async function probeApp() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(APP_URL, { redirect: 'manual', signal: ctrl.signal });
    // Any HTTP response (200/302/4xx) means the app is alive and listening.
    return res.status > 0;
  } catch (_) { return false; } finally { clearTimeout(t); }
}

(async () => {
  const state = loadState();
  state.warned = state.warned || {};

  // --- metrics trend (always logged) ---
  const fdAlloc = readInt('/proc/sys/fs/file-nr');
  const procs = countLines('ps', ['-e', '--no-headers']);
  const threads = countLines('ps', ['-eLf', '--no-headers']);
  const load = os.loadavg().map((n) => n.toFixed(2)).join('/');
  const memMb = memAvailMb();
  const diskPct = diskPctUsed('/');
  const stamp = new Date().toISOString();
  console.log(`[health] ${stamp} fd=${fdAlloc} procs=${procs} threads=${threads} load=${load} memAvailMB=${memMb} disk%=${diskPct}`);

  // --- pre-emptive resource warnings (page once per crossing) ---
  const warn = async (key, cond, msg) => {
    if (cond && !state.warned[key]) { state.warned[key] = true; await sendOpsAlert(msg); }
    else if (!cond && state.warned[key]) { state.warned[key] = false; }
  };
  await warn('fd', fdAlloc > FD_WARN, `⚠️ roots-v2-hk file descriptors high: ${fdAlloc} (>${FD_WARN}). Possible leak — the 2026-06-28 wedge pattern. Check before it stalls services.`);
  await warn('disk', diskPct >= DISK_WARN_PCT, `⚠️ roots-v2-hk disk ${diskPct}% used (>=${DISK_WARN_PCT}%). Free space before writes stall.`);
  await warn('mem', memMb >= 0 && memMb < MEM_WARN_MB, `⚠️ roots-v2-hk memory low: ${memMb}MB available (<${MEM_WARN_MB}MB).`);

  // --- app liveness + self-heal ---
  const alive = await probeApp();
  if (alive) {
    if (state.down) await sendOpsAlert('✅ roots-v2 storefront RECOVERED — app responding on :4000 again.');
    state.fails = 0; state.down = false;
    saveState(state);
    return;
  }

  state.fails = (state.fails || 0) + 1;
  console.error(`[health] app probe FAILED (${state.fails}/${FAIL_THRESHOLD}) ${APP_URL}`);
  if (state.fails >= FAIL_THRESHOLD && !state.down) {
    state.down = true;
    // A probe timeout while the box is thrashing (CPU starved) usually means the
    // event loop can't answer in time — NOT that the app died. Restarting then
    // only adds load and blanks :4000 for a beat, turning overload into a 502
    // loop (2026-06-29 incident: load hit 20 on 2 cores from too many browser
    // daemons → watchdog restart-looped roots-v2). A genuinely dead app leaves
    // load LOW, so high load-per-core is the tell: alert, don't restart.
    const cores = os.cpus().length || 1;
    const load1 = os.loadavg()[0];
    const perCore = load1 / cores;
    if (perCore >= LOAD_SKIP_PER_CORE) {
      await sendOpsAlert(`🟠 roots-v2 probe timed out but the box is OVERLOADED — load ${load1.toFixed(2)} on ${cores} cores (${perCore.toFixed(1)}/core), memAvail ${memMb}MB. Skipping auto-restart: restarting under load makes it worse. Likely too many browser daemons — shed load (stop a channel) or upsize the box.`);
    } else {
      let restartMsg = '';
      try {
        execFileSync('pm2', ['restart', 'roots-v2'], { encoding: 'utf8' });
        restartMsg = 'auto-ran `pm2 restart roots-v2`';
      } catch (e) {
        restartMsg = 'pm2 restart FAILED: ' + e.message;
      }
      await sendOpsAlert(`🔴 roots-v2 storefront DOWN — app not responding on :4000 after ${state.fails} checks. ${restartMsg}. If this repeats, the box may be wedging (see 2026-06-28 incident).`);
    }
  }
  saveState(state);
})();
