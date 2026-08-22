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

// ── 5. Is the channel actually trading? ──────────────────────────────────────
// The proxy is only half the question. "Is 天河 live" means: is the session
// signed in, is stock pushing, are orders arriving. Same signals, and the same
// ruler, routes/integrations-admin.js uses for the admin card, so this answer
// and the screen an operator looks at cannot disagree.
//
// The daemon writes through `database.js` (the main DB) while the routes read
// through tdb() (a per-tenant file), so both are checked and the source of the
// numbers is named rather than assumed.
head('Is 天河 trading?');
let Database = null;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (_) { say('  (better-sqlite3 not loadable here — skipping the database section)'); }

function dbCandidates() {
  const list = [path.join(APP, 'data', 'roots.db')];
  try {
    const dir = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.db')) list.push(path.join(dir, f));
  } catch (_) { /* single-tenant box */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

const STORE = process.env.PROXY_DIAG_STORE || 'tianhe';
const found = [];   // databases that actually hold this store's Meituan history
const quiet = [];   // …and the ones that hold none, named but not printed
if (Database) {
  for (const file of dbCandidates()) {
    let db;
    try { db = new Database(file, { readonly: true, fileMustExist: true }); }
    catch (e) { say(`  ${file}: cannot open (${e.message})`); continue; }

    // Prove read-only on the connection, do not assume it — same gate every
    // other diagnostic in this directory applies before reading anything.
    let proven = false;
    try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
    catch (_) { proven = true; }
    if (!proven) { say(`  ${file}: FATAL — the connection accepted a write, reading nothing from it`); try { db.close(); } catch (_) {} continue; }

    const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (_) { return null; } };
    const has = (t) => !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t);
    if (!has('meituan_sync_log')) { try { db.close(); } catch (_) {} continue; }

    const lastOk  = one("SELECT event_type, created_at FROM meituan_sync_log WHERE store_code=? AND status='ok' ORDER BY id DESC LIMIT 1", STORE);
    const lastErr = one("SELECT event_type, error_msg, created_at FROM meituan_sync_log WHERE store_code=? AND status='error' ORDER BY id DESC LIMIT 1", STORE);
    const lastLogin = one("SELECT event_type, created_at FROM meituan_sync_log WHERE store_code=? AND status='error' AND event_type IN ('needs_login','verify_required') ORDER BY id DESC LIMIT 1", STORE);
    const lastPush = one("SELECT created_at FROM meituan_sync_log WHERE store_code=? AND event_type='stock_push' AND status='ok' ORDER BY id DESC LIMIT 1", STORE);
    const biz = has('store_business_status') ? one('SELECT is_open, read_ok, read_at FROM store_business_status WHERE store_code=?', STORE) : null;
    const lastOrder = has('meituan_order_import') ? one('SELECT meituan_order_no, imported_at FROM meituan_order_import WHERE store_code=? ORDER BY id DESC LIMIT 1', STORE) : null;
    const today = has('meituan_order_import') ? one("SELECT COUNT(*) n FROM meituan_order_import WHERE store_code=? AND date(imported_at)=date('now')", STORE) : null;
    const q = has('meituan_sync_queue')
      ? one("SELECT SUM(status='pending') pending, SUM(status='failed') failed FROM meituan_sync_queue WHERE store_code=?", STORE)
      : null;

    // UTC in the log, UTC here — the daemon writes CURRENT_TIMESTAMP.
    const utc = (t) => (t ? Date.parse(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z')) || 0 : 0);
    const okAt = Math.max(utc(lastOk && lastOk.created_at), (biz && biz.read_ok) ? utc(biz.read_at) : 0);
    const errAt = utc(lastLogin && lastLogin.created_at);
    const signedIn = errAt && errAt > okAt ? false : (okAt ? true : null);

    try { db.close(); } catch (_) {}

    // A tenant that has never touched Meituan prints nothing: on a box with
    // several tenant files the empty ones are pure noise, and they push the
    // answer off the end of a log that is only ever read by its tail.
    const active = !!(lastOk || lastErr || lastOrder || (q && ((q.pending || 0) + (q.failed || 0) > 0)));
    if (!active) { quiet.push(path.basename(file)); continue; }

    found.push({
      file, signedIn,
      okAt: utc(lastOk && lastOk.created_at),
      pushAt: utc(lastPush && lastPush.created_at),
      orderAt: utc(lastOrder && lastOrder.imported_at),
      orderNo: lastOrder && lastOrder.meituan_order_no,
      today: today ? today.n : null,
      lastOk, lastErr, lastLogin, biz, q, utc,
    });

    say(`  ${file}`);
    say(`      signed in: ${signedIn === true ? 'YES' : signedIn === false ? `NO — ${lastLogin.event_type}` : 'unknown (no activity either way)'}`);
    say(`      last ok event:   ${lastOk ? `${lastOk.event_type} ${ago(utc(lastOk.created_at))}` : 'never'}`);
    say(`      last stock push: ${lastPush ? ago(utc(lastPush.created_at)) : 'never'}`);
    say(`      last error:      ${lastErr ? `${lastErr.event_type} ${ago(utc(lastErr.created_at))} — ${String(lastErr.error_msg || '').slice(0, 90)}` : 'none'}`);
    if (biz) say(`      shop on Meituan: ${biz.read_ok ? (biz.is_open === 1 ? 'OPEN' : 'CLOSED (置休)') : 'last status read FAILED'} (read ${ago(utc(biz.read_at))})`);
    say(`      last order:      ${lastOrder ? `${lastOrder.meituan_order_no} ${ago(utc(lastOrder.imported_at))}` : 'never'}`);
    say(`      orders today:    ${today ? today.n : '?'}`);
    if (q) say(`      push queue:      ${q.pending || 0} pending, ${q.failed || 0} failed`);
  }
  if (quiet.length) say(`  (${quiet.length} database(s) with no ${STORE} Meituan activity, not shown: ${quiet.join(', ')})`);
  if (!found.length) say(`  no database on this box holds any ${STORE} Meituan activity`);
}

// ── The answer, last ─────────────────────────────────────────────────────────
// Everything above is evidence. A reader who sees only the last few lines — and
// with a log viewer that tails, that is every reader — still gets the verdict.
head(`VERDICT — ${STORE} 外卖`);
const entry = (() => {
  try { return JSON.parse(read(STATE_FILE) || '{}')[STORE] || null; } catch (_) { return null; }
})();
const exitLabel = entry ? entry.label : null;
say(`  exit in use:  ${exitLabel || 'unknown'}${exitLabel && exitLabel !== 'residential' ? '  (NOT the residential exit)' : ''}`);

const primary = found.slice().sort((a, b) => Math.max(b.okAt, b.orderAt) - Math.max(a.okAt, a.orderAt))[0];
if (!primary) {
  say('  trading:      UNKNOWN — no Meituan history in any database on this box');
} else {
  const sig = primary.signedIn;
  say(`  signed in:    ${sig === true ? 'YES' : sig === false ? 'NO — needs a human to sign in / pass 验证中心' : 'unknown'}`);
  say(`  last activity: ${primary.okAt ? ago(primary.okAt) : 'never'}` +
      `${primary.pushAt ? `, last stock push ${ago(primary.pushAt)}` : ', no stock push on record'}`);
  say(`  orders today: ${primary.today === null ? '?' : primary.today}` +
      `${primary.orderAt ? ` (last ${primary.orderNo || ''} ${ago(primary.orderAt)})` : ''}`);
  if (primary.biz) {
    say(`  shop status:  ${primary.biz.read_ok ? (primary.biz.is_open === 1 ? 'OPEN on Meituan' : 'CLOSED on Meituan (置休)') : 'last status read FAILED'}`);
  }
  // "Live" means the daemon reached Meituan recently AND is not locked out.
  const recentMs = 45 * 60_000;
  const live = sig === true && primary.okAt && (Date.now() - primary.okAt) < recentMs;
  say('');
  say(`  → ${live ? `LIVE — reaching Meituan, last ok ${ago(primary.okAt)}` : sig === false
        ? 'NOT LIVE — the session is locked out; a human has to sign in on the box'
        : `NOT CONFIRMED LIVE — no successful Meituan call in the last ${recentMs / 60000} min`}`);
}

say('');
console.log(out.join('\n'));
