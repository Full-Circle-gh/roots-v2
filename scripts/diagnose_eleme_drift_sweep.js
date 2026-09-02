#!/usr/bin/env node
/**
 * diagnose_eleme_drift_sweep.js — did the Eleme drift sweep run, and what did it do?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_drift_sweep.js
 *
 * Post-deploy verification for lib/channel-drift-sweep.js, shipped in PR #222
 * (merge d0efbe2, deployed 2026-09-02 13:29 UTC). Six questions, each answered
 * from the box rather than inferred:
 *
 *   1  is eleme-sync running under pm2, and did it restart at the deploy?
 *   2  did the sweep fire on the FIRST tick after start (lastDriftSweep = 0)?
 *   3  the first ('drift_sweep','ok') row since the deploy — count and items,
 *      then the RAW map/stock rows behind each item it enqueued.
 *   4  any ('drift_sweep','error') rows — the failure path this module added
 *      because lib/meituan-drift-sweep.js only console.errors.
 *   5  anything chronic (>= 24h), and PROOF no latch was set — ELEME.alert is
 *      null until the Chinese copy exists, and the code must not latch while
 *      suppressed or the first real alert is swallowed.
 *   6  negative physical_qty on a Meituan-mapped product. This is the one read
 *      that decides whether docs/meituan-findings.md finding 20 (the sweep's
 *      Math.trunc vs the daemon's packQty, which can never agree below zero) is
 *      urgent or theoretical. Finding 20 was written from code, not data.
 *
 * READ-ONLY, AND IT PROVES IT. Same discipline as diagnose_channel_queue.js:
 * every database is opened `readonly: true, fileMustExist: true` and a write is
 * attempted and REQUIRED to fail before a single row is read; if any connection
 * accepts a write the script aborts with exit 2. There is no INSERT, UPDATE,
 * DELETE, ALTER or CREATE anywhere in this file except that one probe, which
 * exists to be rejected.
 *
 * It reads two things outside the database, both read-only:
 *   • `pm2 jlist` — a status read. It starts, stops and restarts nothing.
 *   • the tail of eleme-sync's pm2 out/error logs, with fs.readFileSync.
 *   • the alert-latch DIRECTORY listing, to prove no drift latch file exists.
 *
 * EVERY TENANT DATABASE IS SCANNED, not just data/roots.db — the daemon writes
 * through the seam and a script that only opened the main file could report a
 * confident zero from the wrong database. Same candidate list as
 * diagnose_channel_queue.js.
 *
 * Sections are independently guarded: one missing column or older schema drops
 * that section and prints why, rather than losing the rest of a production
 * query that is expensive to re-run.
 *
 * EXIT CODES
 *   0  ran. Whether the sweep found drift or not, the rows are the output —
 *      "nothing enqueued" is a valid and interesting answer, not a failure.
 *   2  REFUSED: a connection accepted a write, or no database could be read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const NOW = Date.now();
const sha256File = (p) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch (e) { return 'unreadable'; }
};

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' with no zone marker and IS
// UTC. Parsing it bare reads hours off — the trap lib/channel-sync-stale.js
// parseUtc() and the Eleme activity log both had to fix.
function parseUtc(stamp) {
  if (stamp == null) return null;
  const s = String(stamp);
  const t = Date.parse(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}
const sh = (stamp) => {
  const t = parseUtc(stamp);
  return t == null ? String(stamp) : new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08';
};
const ageOf = (stamp) => {
  const t = parseUtc(stamp);
  if (t == null) return 'unparseable';
  const m = Math.round((NOW - t) / 60_000);
  return m < 60 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
const J = (v) => (v === null ? 'NULL' : v === undefined ? '(absent)' : JSON.stringify(v));
const section = (t) => console.log('\n══ ' + t + ' ' + '═'.repeat(Math.max(0, 70 - t.length)));

console.log('diagnose_eleme_drift_sweep.js — did the Eleme drift sweep run, and what did it do?');
console.log('run at (UTC):  ' + new Date(NOW).toISOString());
console.log('run at (+08):  ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('primary db:    ' + DB_PATH);
console.log('deploy root:   ' + DEPLOY_ROOT);
console.log('deployed lib/channel-drift-sweep.js sha256: '
  + sha256File(path.join(DEPLOY_ROOT, 'lib', 'channel-drift-sweep.js')));
console.log('deployed scripts/eleme-daemon.js    sha256: '
  + sha256File(path.join(DEPLOY_ROOT, 'scripts', 'eleme-daemon.js')));

// ════════════════════════════════════════════════════════════════════════════
// 1 · pm2: is eleme-sync running, and when did it start?
// ════════════════════════════════════════════════════════════════════════════
section('1 · pm2 — is eleme-sync running');

let elemeProc = null;
try {
  const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const list = JSON.parse(raw);
  console.log('   all pm2 processes:');
  for (const p of list) {
    const e = p.pm2_env || {};
    const up = e.pm_uptime ? Math.round((NOW - e.pm_uptime) / 60_000) : null;
    console.log(`     ${String(p.name).padEnd(24)} ${String(e.status).padEnd(10)}`
      + ` restarts=${String(e.restart_time).padStart(4)} unstable=${e.unstable_restarts || 0}`
      + ` up=${up == null ? '?' : up + ' min'}`);
  }
  elemeProc = list.find(p => p.name === 'eleme-sync') || null;
  if (!elemeProc) console.log('\n   !! eleme-sync NOT FOUND in pm2');
  else {
    const e = elemeProc.pm2_env || {};
    console.log('\n   eleme-sync:');
    console.log('     status            ' + J(e.status));
    console.log('     pid               ' + J(elemeProc.pid));
    console.log('     restart_time      ' + J(e.restart_time));
    console.log('     unstable_restarts ' + J(e.unstable_restarts));
    console.log('     started at        ' + (e.pm_uptime ? new Date(e.pm_uptime).toISOString() + ' UTC  ('
      + Math.round((NOW - e.pm_uptime) / 60_000) + ' min ago)' : '?'));
    console.log('     script            ' + J(e.pm_exec_path));
    // The decisive one: a file on disk is not code in memory. If the process
    // started AFTER the new module landed, it is running the new code.
    try {
      const mtime = fs.statSync(path.join(DEPLOY_ROOT, 'lib', 'channel-drift-sweep.js')).mtimeMs;
      console.log('     lib/channel-drift-sweep.js mtime  ' + new Date(mtime).toISOString() + ' UTC');
      console.log('     process started AFTER that file?  '
        + ((e.pm_uptime || 0) > mtime ? 'YES — it is running the new code' : 'NO — STALE PROCESS'));
    } catch (e2) { console.log('     (could not stat the module: ' + e2.message + ')'); }
  }
} catch (e) {
  console.log('   pm2 jlist failed: ' + e.message);
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · the daemon's own log — did the sweep fire on the first tick?
// ════════════════════════════════════════════════════════════════════════════
section('2 · eleme-sync pm2 log — the sweep firing');

function tailFile(p, n) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch (e) { return null; }
}

const logDir = '/root/.pm2/logs';
for (const which of ['out', 'error']) {
  const f = path.join(logDir, `eleme-sync-${which}.log`);
  const lines = tailFile(f, 400);
  if (!lines) { console.log(`   ${f} — unreadable`); continue; }
  console.log(`\n   ${f} — last ${Math.min(lines.length, 60)} of ${lines.length} line(s):`);
  for (const l of lines.slice(-60)) console.log('     ' + l);
  // Anything the sweep itself would have written, anywhere in the tail.
  const hits = lines.filter(l => /drift|channel-drift-sweep/i.test(l));
  console.log(`\n   lines mentioning drift in this file: ${hits.length}`);
  for (const h of hits.slice(-40)) console.log('     >> ' + h);
}

// ════════════════════════════════════════════════════════════════════════════
// The databases
// ════════════════════════════════════════════════════════════════════════════
function candidates() {
  const dataDir = path.dirname(DB_PATH);
  const list = [DB_PATH];
  try {
    const tenants = path.join(dataDir, 'tenants');
    for (const f of fs.readdirSync(tenants)) if (f.endsWith('.db')) list.push(path.join(tenants, f));
  } catch (e) { /* single tenant — no tenants dir */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

const files = candidates();
section('database files to scan (' + files.length + ')');
for (const f of files) console.log('   ' + f);
if (!files.length) {
  console.error('FATAL: no readable database file. Refusing to report zero rows from nothing.');
  process.exit(2);
}

let examined = 0;

for (const file of files) {
  section('DATABASE  ' + file);

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log('   cannot open: ' + e.message + ' — skipped'); continue; }

  // ── read-only proof, before a single row is read ────────────────────────
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('   read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write on ' + file + '. Aborting.');
    process.exit(2);
  }
  examined++;

  const has = (t) => {
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
    catch (e) { return false; }
  };
  const cols = (t) => {
    try { return new Set(db.pragma(`table_info(${t})`).map(c => c.name)); }
    catch (e) { return new Set(); }
  };
  const guard = (title, fn) => {
    try { fn(); }
    catch (e) { console.log('   SECTION FAILED (' + title + '): ' + e.message); }
  };
  const rows = (sql, ...a) => db.prepare(sql).all(...a);

  if (!has('eleme_sync_log')) {
    console.log('   no eleme_sync_log table — not the Eleme database, skipping sections 3-5');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3 · the drift_sweep 'ok' rows
  // ══════════════════════════════════════════════════════════════════════════
  guard('3 · drift_sweep ok', () => {
    console.log('\n   ── 3 · ("drift_sweep","ok") rows ──');
    if (!has('eleme_sync_log')) { console.log('      (no table)'); return; }

    const all = rows(`SELECT id, store_code, event_type, status, detail, error_msg, created_at
                        FROM eleme_sync_log
                       WHERE event_type = 'drift_sweep'
                       ORDER BY id ASC`);
    console.log(`      ${all.length} drift_sweep row(s) in total (all statuses, all time)`);
    if (!all.length) {
      console.log('      NONE. Either the sweep has not run yet, it found no drift (it writes');
      console.log('      nothing when it enqueues nothing), or it is not running.');
    }
    for (const r of all) {
      console.log(`\n      id=${r.id}  store=${J(r.store_code)}  status=${J(r.status)}`);
      console.log(`        created_at  ${r.created_at} UTC  →  ${sh(r.created_at)}  (${ageOf(r.created_at)})`);
      console.log(`        error_msg   ${J(r.error_msg)}`);
      let d = null;
      try { d = JSON.parse(r.detail); } catch (e) { /* print raw below */ }
      if (d && typeof d === 'object') {
        console.log(`        count       ${J(d.count)}`);
        const items = Array.isArray(d.items) ? d.items : [];
        console.log(`        items       ${items.length} recorded (capped at 20 by the module)`);
        for (const it of items) console.log('          · ' + JSON.stringify(it));
      } else {
        console.log('        detail(raw) ' + J(r.detail));
      }
    }

    // The queue rows the sweep itself created, by its own marker string.
    if (has('eleme_sync_queue')) {
      console.log('\n      ── queue rows the sweep created (by its marker last_error) ──');
      const q = rows(`SELECT * FROM eleme_sync_queue
                       WHERE last_error = 'drift sweep — last push never landed'
                       ORDER BY id ASC`);
      console.log(`      ${q.length} row(s)`);
      for (const r of q) {
        console.log('        ' + JSON.stringify(r));
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3b · RAW rows behind anything enqueued — sku, name, last_pushed_qty,
  //      current physical_qty, hours since last push. Not a summary.
  // ══════════════════════════════════════════════════════════════════════════
  guard('3b · raw rows behind the enqueued targets', () => {
    console.log('\n   ── 3b · RAW map + stock rows for every enqueued target ──');
    if (!has('eleme_sync_queue') || !has('eleme_product_map')) { console.log('      (tables missing)'); return; }
    const mc = cols('eleme_product_map');
    const targets = rows(`SELECT DISTINCT retail_store_id, product_id, store_code
                            FROM eleme_sync_queue
                           WHERE last_error = 'drift sweep — last push never landed'
                           ORDER BY store_code, product_id`);
    if (!targets.length) { console.log('      nothing was enqueued by the sweep — no rows to show'); return; }
    for (const t of targets) {
      console.log(`\n      ── store=${J(t.store_code)} product_id=${t.product_id} ──`);
      if (has('store_products')) {
        const sel = ['id'];
        for (const c of ['sku', 'name_cn', 'name_en', 'is_active', 'bundle_items']) if (cols('store_products').has(c)) sel.push(c);
        const p = db.prepare(`SELECT ${sel.join(', ')} FROM store_products WHERE id = ?`).get(t.product_id);
        console.log('        store_products : ' + (p ? JSON.stringify(p) : 'NO ROW'));
      }
      if (has('retail_store_stock')) {
        const s = db.prepare('SELECT * FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
          .get(t.retail_store_id, t.product_id);
        console.log('        stock          : ' + (s ? JSON.stringify(s) : 'NO ROW (reads as 0)'));
      }
      // Every claim — the map is one row per 规格 since the spec_key migration.
      const want = ['id', 'store_code', 'sync_enabled', 'last_pushed_qty', 'last_pushed_at',
                    'units_per_pack', 'spec_key', 'eleme_name', 'spec_id', 'spec_name',
                    'extend_code', 'item_id', 'created_at'];
      const sel = want.filter(c => mc.has(c));
      const claims = db.prepare(
        `SELECT ${sel.join(', ')} FROM eleme_product_map WHERE retail_store_id = ? AND product_id = ?`
      ).all(t.retail_store_id, t.product_id);
      console.log(`        claims         : ${claims.length}`);
      for (const c of claims) {
        console.log('          ' + JSON.stringify(c));
        const ref = c.last_pushed_at || c.created_at;
        console.log(`            hours since last push: ${ref ? ((NOW - parseUtc(ref)) / 3600_000).toFixed(1) : 'n/a'}`
          + `   (from ${c.last_pushed_at ? 'last_pushed_at' : 'created_at — NEVER PUSHED'} = ${J(ref)})`);
      }
      // Its queue history, newest first — what the channel last said about it.
      const qh = rows('SELECT * FROM eleme_sync_queue WHERE retail_store_id=? AND product_id=? ORDER BY id DESC LIMIT 8',
        t.retail_store_id, t.product_id);
      console.log(`        queue history  : ${qh.length} row(s), newest first`);
      for (const r of qh) console.log('          ' + JSON.stringify(r));
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4 · drift_sweep ERROR rows — the failure path this module added
  // ══════════════════════════════════════════════════════════════════════════
  guard('4 · drift_sweep error', () => {
    console.log('\n   ── 4 · ("drift_sweep","error") rows ──');
    if (!has('eleme_sync_log')) { console.log('      (no table)'); return; }
    const e = rows(`SELECT id, store_code, detail, error_msg, created_at
                      FROM eleme_sync_log
                     WHERE event_type = 'drift_sweep' AND status = 'error'
                     ORDER BY id ASC`);
    console.log(`      ${e.length} row(s)`);
    for (const r of e) {
      console.log(`        id=${r.id} store=${J(r.store_code)} at=${sh(r.created_at)} (${ageOf(r.created_at)})`);
      console.log(`          error_msg ${J(r.error_msg)}`);
      console.log(`          detail    ${J(r.detail)}`);
    }
    if (!e.length) console.log('      none — the sweep has not thrown.');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5 · chronic drift, and proof no latch was set
  // ══════════════════════════════════════════════════════════════════════════
  guard('5 · chronic + latch', () => {
    console.log('\n   ── 5 · ("drift_chronic", …) rows ──');
    if (!has('eleme_sync_log')) { console.log('      (no table)'); return; }
    const c = rows(`SELECT id, store_code, status, detail, error_msg, created_at
                      FROM eleme_sync_log
                     WHERE event_type = 'drift_chronic'
                     ORDER BY id ASC`);
    console.log(`      ${c.length} row(s)`);
    for (const r of c) {
      console.log(`\n        id=${r.id} store=${J(r.store_code)} status=${J(r.status)} at=${sh(r.created_at)} (${ageOf(r.created_at)})`);
      console.log(`          error_msg ${J(r.error_msg)}`);
      let d = null;
      try { d = JSON.parse(r.detail); } catch (e2) { /* raw */ }
      if (d && typeof d === 'object') {
        console.log(`          count     ${J(d.count)}`);
        for (const it of (d.items || [])) console.log('            · ' + JSON.stringify(it));
      } else {
        console.log(`          detail    ${J(r.detail)}`);
      }
    }
    if (!c.length) console.log('      none — nothing has been chronic (>= 24h) since the deploy.');
  });

  db.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 5b · the latch directory — ELEME.alert is null, so NO drift latch may exist
// ════════════════════════════════════════════════════════════════════════════
section('5b · alert-latch files — no eleme drift latch may exist');
console.log('   ELEME.alert is null in lib/channel-drift-sweep.js, so alertChronic() takes the');
console.log('   `!d.alert` branch: it logs drift_chronic and CONTINUES WITHOUT setting alerts[key].');
console.log('   A latch file named eleme--drift_<store>.json would mean that guard failed and the');
console.log('   first real alert would be swallowed once the Chinese copy lands.');
for (const dir of [path.join(DEPLOY_ROOT, 'data', 'alert-latch')]) {
  let entries = null;
  try { entries = fs.readdirSync(dir); } catch (e) { console.log(`   ${dir} — unreadable/absent (${e.code || e.message})`); continue; }
  console.log(`\n   ${dir} — ${entries.length} file(s):`);
  for (const f of entries.sort()) {
    let body = '';
    try { body = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (e) { body = '(unreadable)'; }
    console.log(`     ${f}  ${body}`);
  }
  const drift = entries.filter(f => /^eleme--drift/i.test(f));
  console.log(`\n   eleme drift latch files: ${drift.length}`
    + (drift.length ? '  ← !! LATCH WAS SET, the suppression guard did not hold' : '  ← correct, no latch set'));
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · finding 20: negative stock on a Meituan-mapped product
// ════════════════════════════════════════════════════════════════════════════
section('6 · finding 20 — negative physical_qty on a Meituan-mapped product');
console.log('   docs/meituan-findings.md finding 20: lib/meituan-drift-sweep.js:146 computes the');
console.log('   expected box quantity with Math.trunc(qty/units) while the daemon WRITES');
console.log('   packQty(), which clamps a non-positive shelf count to 0. They agree at 0 and');
console.log('   above and can never agree below zero, so such a row drifts for ever, costs a row');
console.log('   of the 40-row budget every 2h, and at 24h holds that store\'s chronic latch shut.');
console.log('   Finding 20 was written from code. THIS is the read that decides whether it is');
console.log('   urgent or theoretical. The query is the one in the brief, verbatim.\n');

for (const file of files) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log(`   ${file}: cannot open (${e.message})`); continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; }
  if (!proven) { console.error('FATAL: connection accepted a write on ' + file); process.exit(2); }

  console.log(`   ${file}`);

  // The query AS BRIEFED, run verbatim and first, so its result — including a
  // failure — is on the record rather than quietly replaced. retail_store_stock
  // names its store column `store_id` (database.js:3071); the brief wrote
  // `s.retail_store_id`, which is the name the two *_product_map tables use. The
  // join side is right, the stock side is not.
  const VERBATIM = `
      SELECT s.retail_store_id, s.product_id, s.physical_qty, m.last_pushed_qty
        FROM retail_store_stock s
        JOIN meituan_product_map m ON m.retail_store_id = s.retail_store_id AND m.product_id = s.product_id
       WHERE s.physical_qty < 0 AND m.sync_enabled = 1`;
  try {
    const v = db.prepare(VERBATIM).all();
    console.log(`     [as briefed] rows: ${v.length}`);
    for (const r of v) console.log('       ' + JSON.stringify(r));
  } catch (e) {
    console.log(`     [as briefed] FAILED — ${e.message}`);
    console.log('       retail_store_stock names its store column store_id, not retail_store_id.');
    console.log('       Re-running with that one identifier corrected; predicate unchanged.');
  }

  // Same predicate, same join, same projection — only the stock-side column name
  // corrected. Nothing about which rows qualify is altered.
  try {
    const neg = db.prepare(`
      SELECT s.store_id AS retail_store_id, s.product_id, s.physical_qty, m.last_pushed_qty
        FROM retail_store_stock s
        JOIN meituan_product_map m ON m.retail_store_id = s.store_id AND m.product_id = s.product_id
       WHERE s.physical_qty < 0 AND m.sync_enabled = 1
    `).all();
    console.log(`     [corrected] rows: ${neg.length}`);
    for (const r of neg) console.log('       ' + JSON.stringify(r));
    if (!neg.length) console.log('       → finding 20 is THEORETICAL on this database today.');
    else console.log('       → finding 20 is LIVE on this database: each row above drifts for ever.');

    // Context the briefed query does not carry, and which changes the reading: a
    // mapped count of zero against a large unmapped count means the defect is one
    // mapping away rather than absent.
    const anyNeg = db.prepare('SELECT COUNT(*) n FROM retail_store_stock WHERE physical_qty < 0').get();
    console.log(`     negative physical_qty rows overall (mapped or not): ${anyNeg.n}`);
    const elemeNeg = db.prepare(`
      SELECT COUNT(*) n FROM retail_store_stock s
        JOIN eleme_product_map m ON m.retail_store_id = s.store_id AND m.product_id = s.product_id
       WHERE s.physical_qty < 0 AND m.sync_enabled = 1`).get();
    console.log(`     negative and ELEME-mapped (the new module clamps these correctly): ${elemeNeg.n}`);
  } catch (e) {
    console.log(`     [corrected] query failed — ${e.message}`);
  }
  db.close();
}

console.log('\n' + '═'.repeat(74));
console.log(`examined ${examined} database(s), all read-only and proven so.`);
console.log('Nothing was written, started, stopped or restarted by this script.');
