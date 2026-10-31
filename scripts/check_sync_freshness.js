#!/usr/bin/env node
'use strict';

/**
 * check_sync_freshness.js — is the WRITE path alive?
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other probe in this tree reads. `scripts/health-watchdog.js` asks four
 * routes whether they answer; `checks.py` asks Postgres to validate its own
 * constraints; `verify.py` compares rows that are already there. None of them
 * proves the application can still WRITE, and PART H's own note says so: "No
 * probe on this panel writes anything."
 *
 * The obvious fix is a probe that writes something and cleans it up. That was
 * rejected: a probe that leaves rows behind when it dies mid-way is worse than
 * no probe, and it puts test data in a production database on the one night
 * nobody wants surprises in it.
 *
 * So this observes a write that ALREADY HAPPENS. The channel daemons append to
 * their sync logs continuously — measured on 2026-08-23, `qingyun_sync_log` took
 * 128 rows in an hour, 19 in ten minutes, and the LARGEST gap between
 * consecutive rows across 24 hours was 133 SECONDS. If the newest row stops
 * moving, the write path is broken, and no row had to be manufactured to find
 * that out.
 *
 * N = 15 MINUTES, and the 133 s worst observed gap is why: roughly seven times
 * the worst case, which is tight enough to catch a stalled write inside a couple
 * of minutes of looking and loose enough to survive a daemon restart or a
 * channel cool-down without crying wolf.
 *
 * WHY IT IS NOT IN health-watchdog
 * --------------------------------
 * Because a daemon can be running and correctly not writing. The 闪购 channel
 * goes quiet after 20:15 BY DESIGN; a deploy bounces the daemons; an operator
 * pauses a channel on purpose. A standing check cannot tell those from a broken
 * write path, and `pm2 status` does not help — the 20:15 case is a process that
 * is up and correctly silent. Wired into the watchdog it would eventually
 * restart the app because a channel was deliberately paused.
 *
 * During PART H the operator KNOWS which daemons are meant to be running, so the
 * question that makes it unworkable as a standing check does not arise. It is a
 * runbook instrument, called by a human who can answer it.
 *
 * IT REPORTS. IT NEVER RESTARTS ANYTHING, and it writes nothing anywhere.
 *
 * EXIT CODES
 *   0  every log checked is fresh within the window
 *   1  at least one log is STALE — the write path may be stopped
 *   2  REFUSED — the source could not be read, so freshness is unmeasurable.
 *      Not a pass. A check that cannot run must refuse.
 *
 * USAGE
 *   node scripts/check_sync_freshness.js                 # the live SQLite file
 *   node scripts/check_sync_freshness.js --db /path/to/roots.db
 *   node scripts/check_sync_freshness.js --minutes 30
 *
 * THE EXIT CODES ARE THE POINT: 0 fresh, 1 stale, 2 REFUSED. Two is not a pass.
 * A source that is absent or unreadable is reported as such and never as
 * silence-means-fine — see docs/tacet-operating-findings.md, PART 2.
 *
 * This read Postgres as well until 2026-08-23. That cluster is gone and the
 * branch with it; nothing else about the check changed.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

// SQLite is the ONLY source. Tacet's Postgres cluster was dropped 2026-08-23
// (decisions §24, THE POSTGRES MIGRATION IS CANCELLED). `--sqlite` is accepted
// and ignored so existing callers and runbook notes do not break; there is no
// longer anything else to select.
void argv.includes('--sqlite');
const at = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };

const DB_PATH = at('--db') || path.join(ROOT, 'data', 'roots.db');
const WINDOW_MIN = Number(at('--minutes') || 15);
if (!Number.isFinite(WINDOW_MIN) || WINDOW_MIN <= 0) {
  console.error('[freshness] --minutes needs a positive number.');
  process.exit(2);
}

// One row per log worth asking about. `why` is printed with the result so the
// reader knows what a stale answer would MEAN, not just that it is stale.
const LOGS = [
  { table: 'qingyun_sync_log', col: 'created_at', why: 'Qingyun delivery tracking' },
  { table: 'guanyi_sync_log',  col: 'created_at', why: 'Guanyi/gzgrocery stock push' },
  { table: 'meituan_sync_log', col: 'created_at', why: 'Meituan 外卖 stock and orders' },
];

function refuse(msg) {
  console.error('');
  console.error('REFUSED — freshness is unmeasurable, which is NOT the same as fresh.');
  console.error('  ' + msg);
  process.exit(2);
}

// ── readers ────────────────────────────────────────────────────────────────
function readSqlite() {
  if (!fs.existsSync(DB_PATH)) {
    refuse(`no database at ${DB_PATH}. After F1 the live file is renamed — point `
      + '--db at the renamed copy, or use the Postgres mode, but do not read this as fresh.');
  }
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (e) { refuse(`better-sqlite3 will not load: ${e.message}`); }
  let db;
  try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch (e) { refuse(`cannot open ${DB_PATH}: ${e.message}`); }
  const out = [];
  for (const l of LOGS) {
    try {
      const row = db.prepare(
        `SELECT MAX(${l.col}) AS newest,
                CAST((julianday('now') - julianday(MAX(${l.col}))) * 86400 AS INTEGER) AS age
         FROM ${l.table}`).get();
      out.push({ ...l, newest: row && row.newest, age: row && row.age });
    } catch (e) {
      out.push({ ...l, error: e.message });
    }
  }
  db.close();
  return out;
}

// ── report ─────────────────────────────────────────────────────────────────
const source = `SQLite ${DB_PATH}`;
console.log('══ sync-log freshness ══');
console.log(`  source : ${source}`);
console.log(`  window : ${WINDOW_MIN} minutes`);
console.log('  (window is ~7x the largest gap observed between consecutive rows over 24h,');
console.log('   which was 133 seconds on qingyun_sync_log, measured 2026-08-23)');
console.log('');

const rows = readSqlite();

// Every log erroring means the source is not answering at all — refuse rather
// than report three stale lines and a verdict, which would read as a finding.
if (rows.every((r) => r.error)) {
  refuse('every log failed to read: ' + rows.map((r) => `${r.table}: ${r.error}`).join('; '));
}

let stale = 0;
let unreadable = 0;
for (const r of rows) {
  if (r.error) {
    unreadable++;
    console.log(`  ??  ${r.table.padEnd(20)} UNREADABLE — ${r.error}`);
    continue;
  }
  if (r.newest === null || r.newest === undefined || r.age === null) {
    unreadable++;
    console.log(`  ??  ${r.table.padEnd(20)} EMPTY — no rows at all, so freshness says nothing`);
    continue;
  }
  const mins = (r.age / 60);
  const ok = mins <= WINDOW_MIN;
  if (!ok) stale++;
  console.log(`  ${ok ? 'ok ' : '!! '} ${r.table.padEnd(20)} newest ${r.newest} `
    + `(${r.age}s ago, ${mins.toFixed(1)} min) — ${ok ? 'fresh' : 'STALE'}   [${r.why}]`);
}

console.log('');
if (unreadable) {
  console.log(`  ${unreadable} log(s) could not be judged. That is not a pass for them.`);
}
if (stale) {
  console.log(`  ${stale} log(s) STALE beyond ${WINDOW_MIN} minutes.`);
  console.log('  Before calling this a broken write path, confirm the daemon that owns each');
  console.log('  one is MEANT to be running: the 闪购 channel goes quiet after 20:15 by design,');
  console.log('  a deploy bounces the daemons, and an operator may have paused a channel.');
  console.log('  This check cannot tell those apart. You can.');
  process.exit(1);
}
console.log('  every log checked is writing within the window.');
process.exit(0);
