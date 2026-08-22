#!/usr/bin/env node
/**
 * diagnose_proxy_state.js — what proxy is each Meituan channel ACTUALLY on, and
 * is the process that decides it running the code we think it is?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_proxy_state.js
 *
 * READ-ONLY. fs.readFileSync and fs.readdirSync only. It opens no database,
 * spawns nothing, touches no pm2 process, and writes nothing anywhere.
 *
 * WHY THIS EXISTS
 * ---------------
 * 天河 外卖 was running on 直连 with a healthy residential exit first in its
 * priority list, and answering that question took a source read, because the
 * live evidence was spread across three places nobody can see at once:
 *
 *   1. data/proxy-active.json — the decision. Obeyed by every launcher, and
 *      (before the TTL) obeyed no matter how old it was.
 *   2. the deployed bytes — whether the box holds the current failover model.
 *   3. the RUNNING processes — whether they were restarted after those bytes
 *      landed. A daemon left running stale is invisible: the deploy reports
 *      SUCCESS while the old code keeps executing. That is exactly what a
 *      deploy does to proxy-watchdog when the installer that ran predates its
 *      addition to the bounce list.
 *
 * A process older than the file it runs is the finding this script exists for.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = process.env.ROOTS_APP || '/root/roots-v2';
const STATE_FILE = path.join(APP, 'data', 'proxy-active.json');
const PM2_LOGS = process.env.PM2_LOG_DIR || '/root/.pm2/logs';

const out = [];
const say = (s = '') => out.push(s);
const head = (s) => { say(''); say(s); say('─'.repeat(s.length)); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

// ── 1. What the box holds ────────────────────────────────────────────────────
// Marker strings, not hashes: this must keep working as the files evolve, and
// the question is only "does the deployed copy contain the current model?".
const WATCHED = [
  { file: 'lib/proxy-manager.js',      marker: 'STATE_TTL_MS',   means: 'state entries expire' },
  { file: 'lib/proxy-manager.js',      marker: 'code < 600',     means: 'probe uses the daemons’ ruler' },
  { file: 'scripts/proxy-watchdog.js', marker: 'function say(',  means: 'watchdog logs locally' },
  { file: 'scripts/meituan-daemon.js', marker: 'ensureProxyFresh', means: 'daemon re-elects when stale' },
  { file: 'scripts/deploy-apply.sh',   marker: 'bounce_daemon proxy-watchdog', means: 'deploy bounces the watchdog' },
];

head('Deployed bytes');
const srcCache = {};
for (const w of WATCHED) {
  const full = path.join(APP, w.file);
  if (!(w.file in srcCache)) srcCache[w.file] = read(full);
  const src = srcCache[w.file];
  const mark = src === null ? '  ?' : (src.includes(w.marker) ? '  ✓' : '  ✗');
  const note = src === null ? 'FILE NOT FOUND' : (src.includes(w.marker) ? w.means : `MISSING — ${w.means}`);
  say(`${mark} ${w.file} · ${note}`);
}

// ── 2. What is actually running ──────────────────────────────────────────────
// /proc only. starttime (field 22 of /proc/<pid>/stat) is in clock ticks since
// boot; btime in /proc/stat is the boot epoch. USER_HZ is 100 on every kernel
// this runs on, so the arithmetic is exact enough for a minutes-scale answer.
function bootEpochMs() {
  const m = (read('/proc/stat') || '').match(/^btime\s+(\d+)/m);
  return m ? Number(m[1]) * 1000 : null;
}
function procStartMs(pid) {
  const st = read(`/proc/${pid}/stat`);
  const b = bootEpochMs();
  if (!st || !b) return null;
  // comm can contain spaces and parens — everything after the LAST ')' is safe.
  const rest = st.slice(st.lastIndexOf(')') + 2).split(/\s+/);
  const ticks = Number(rest[19]); // field 22 overall = index 19 after pid+comm+state
  return Number.isFinite(ticks) ? b + (ticks / 100) * 1000 : null;
}
// Match on an argv element whose BASENAME is exactly the script, never on a
// substring of the whole command line: a shell whose argv happens to contain
// these names (a deploy script, an editor, this file's own test harness) would
// otherwise report as every daemon at once.
function running(scriptName) {
  const hits = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch (_) { return hits; }
  for (const pid of pids) {
    if (pid === String(process.pid)) continue;
    const cmd = read(`/proc/${pid}/cmdline`);
    if (!cmd) continue;
    const argv = cmd.split('\0').filter(Boolean);
    if (!argv.some(a => a.split('/').pop() === scriptName)) continue;
    hits.push({ pid, cmd: argv.join(' '), startedAt: procStartMs(pid) });
  }
  return hits;
}

const ago = (ms) => {
  if (!ms) return '?';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

head('Running processes vs the bytes they run');
for (const script of ['proxy-watchdog.js', 'meituan-daemon.js', 'shangou-daemon.js', 'qingyun-daemon.js']) {
  const procs = running(script);
  if (!procs.length) { say(`  ✗ ${script} — NOT RUNNING`); continue; }
  let mtime = null;
  try { mtime = fs.statSync(path.join(APP, 'scripts', script)).mtimeMs; } catch (_) {}
  for (const p of procs) {
    const stale = mtime && p.startedAt && p.startedAt < mtime;
    say(`  ${stale ? '✗' : '✓'} ${script} pid ${p.pid} started ${ago(p.startedAt)}` +
        (mtime ? `, file written ${ago(mtime)}` : ', file mtime unknown') +
        (stale ? '  ← STALE: running code older than the file on disk, bounce it' : ''));
  }
}

// ── 3. The decision itself ───────────────────────────────────────────────────
head('data/proxy-active.json — the live choice');
const raw = read(STATE_FILE);
if (!raw) {
  say(`  ✗ no state file at ${STATE_FILE} — every launcher is on its env default`);
} else {
  // The TTL the deployed code actually enforces, read from the deployed source
  // rather than assumed, so this reports what the box does and not what we hope.
  const pmSrc = srcCache['lib/proxy-manager.js'] || '';
  const ttlM = pmSrc.match(/PROXY_STATE_TTL_MS\s*\|\|\s*([\d_]+)/);
  const ttl = ttlM ? Number(ttlM[1].replace(/_/g, '')) : null;
  say(`  TTL enforced by the deployed proxy-manager: ${ttl ? `${ttl / 60000} min` : 'NONE — a stale choice is obeyed forever'}`);
  let state = null;
  try { state = JSON.parse(raw); } catch (e) { say(`  ✗ unparseable: ${e.message}`); }
  for (const [channel, e] of Object.entries(state || {})) {
    const at = Number.isFinite(e.at) ? e.at
      : (e.ts ? Date.parse(String(e.ts).replace(' ', 'T') + '+08:00') : null);
    const ageMs = at ? Date.now() - at : null;
    const stale = ttl && ageMs !== null ? ageMs > ttl : null;
    const url = String(e.url || '').replace(/:[^:@/]+@/, ':****@') || '(direct)';
    say(`  ${channel}: ${e.label || '?'} → ${url}`);
    say(`      written ${at ? ago(at) : 'undateable'}${e.at ? '' : '  (legacy ts-only entry)'}` +
        (stale === null ? '' : stale ? '  ← STALE, readers ignore it' : '  ← current'));
    if (e.label && e.label !== 'residential') {
      say('      ⚠ not on the residential exit — 外卖 running from a datacenter IP is what draws 验证中心');
    }
  }
}

// ── 4. What the watchdog has been saying ─────────────────────────────────────
head('pm2 log tail — proxy-watchdog');
const wlog = read(path.join(PM2_LOGS, 'proxy-watchdog-out.log'));
if (wlog === null) {
  say('  (no proxy-watchdog-out.log — either it has never run, or logs live elsewhere)');
} else {
  const lines = wlog.trim().split('\n').filter(Boolean).slice(-12);
  if (!lines.length) say('  (empty — a watchdog that logs nothing is the gap this file documents)');
  for (const l of lines) say('  ' + l);
}

head('pm2 log tail — meituan-sync, proxy lines only');
const mlog = read(path.join(PM2_LOGS, 'meituan-sync-out.log'));
if (mlog === null) say('  (no meituan-sync-out.log)');
else {
  const lines = mlog.trim().split('\n').filter(l => /proxy|PROXY|代理/.test(l)).slice(-10);
  if (!lines.length) say('  (no proxy lines in the current log)');
  for (const l of lines) say('  ' + l);
}

say('');
console.log(out.join('\n'));
