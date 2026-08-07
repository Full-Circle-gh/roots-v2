#!/usr/bin/env node
/**
 * cleanup-disk-tier1.js — the approved Tier 1 reclaim on roots-v2-hk.
 *
 * WHY THIS EXISTS
 * ---------------
 * roots-v2-hk crossed the watchdog's 85% disk threshold. scripts/diagnose_disk_usage.js
 * measured the box (Actions run 31132215868) and the operator approved exactly
 * five actions against that measurement. This script is those five actions and
 * nothing else.
 *
 * It is a SIBLING of the diagnostic, not an extension of it. The diagnostic runs
 * through ro-query.yml, which promises to ship nothing and change nothing; a
 * script that deletes files has no business travelling down that path, and
 * naming it diagnose_* to get through that workflow's filename gate would defeat
 * a deliberate safety control. It runs through maintenance.yml instead, which is
 * manual-dispatch only and says plainly that it mutates the box.
 *
 * WHAT IS APPROVED (and this file may do nothing else)
 * ---------------------------------------------------
 *   1. The three roots.db.bak-20260804-* files in the live data directory  1.42 GB
 *   2. /root/backups/deploy-* directories older than 30 days               ~1.47 GB
 *   3. journalctl --vacuum-size=200M                                       ~0.67 GB
 *   4. /root/tmp-migration-full, /root/tmp-migration-rehearsal,
 *      and three loose /root/*.sql files                                    ~1.5 MB
 *   5. DROP TABLE postgres.public._diag_disk_usage_write_probe              8 KB
 *      (left by the first diagnostic run, whose read-only guard was itself
 *      broken — see the header of scripts/diagnose_disk_usage.js)
 *
 * WHAT IS FORBIDDEN, EXPLICITLY
 * -----------------------------
 * /root/backups/hourly, /root/backups/daily, every live *.db under
 * /root/roots-v2/data, the Postgres `tacet` database, /swapfile, the scraper
 * chrome profiles, and /root/decimal-rebuild. These are not merely "not in the
 * list" — every single path is checked against FORBIDDEN below immediately
 * before it is unlinked, so a bug in the target-selection logic still cannot
 * reach them. The check is on the resolved real path, so a symlink cannot smuggle
 * a protected location past it.
 *
 * DRY RUN BY DEFAULT
 * ------------------
 * Without --apply it prints precisely what it would remove, with sizes, and
 * touches nothing. maintenance.yml passes --apply only when the dispatcher asks
 * for it and types the confirmation phrase.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// The approved target set, written out literally.
// ---------------------------------------------------------------------------

const BAK_FILES = [
  '/root/roots-v2/data/roots.db.bak-20260804-000154',
  '/root/roots-v2/data/roots.db.bak-20260804-000242',
  '/root/roots-v2/data/roots.db.bak-20260804-094722',
];

const SCRATCH_DIRS = [
  '/root/tmp-migration-full',
  '/root/tmp-migration-rehearsal',
];

const LOOSE_SQL = [
  '/root/tacet-phase1-schema.sql',
  '/root/proposed-postgres-schema.sql',
  '/root/yuexiu-map-backup-20260628-164506.sql',
];

const BACKUPS_DIR = '/root/backups';
const DEPLOY_DIR_RE = /^deploy-\d{8}-\d{6}$/;   // NOT dash-*, NOT hourly, NOT daily
const DEPLOY_AGE_DAYS = 30;

// Anything at or under one of these is untouchable, whatever the logic above
// concluded. Checked per path, on the resolved real path, at the moment of use.
const FORBIDDEN = [
  '/root/backups/hourly',
  '/root/backups/daily',
  '/root/decimal-rebuild',
  '/swapfile',
  '/root/.qingyun-chrome-profile',
  '/root/.qingyun-chrome-profile-yuexiu',
  '/root/.shangou-chrome-profile',
  '/root/roots-v2/data/roots.db',
  '/root/roots-v2/data/roots.db-wal',
  '/root/roots-v2/data/roots.db-shm',
  '/root/roots-v2/data/tenants',
  '/root/roots-v2/data/sessions.db',
  '/var/lib/postgresql',
];

/** True when `p` is exactly a forbidden path or sits underneath one. */
function isForbidden(p) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch (_) {
    real = path.resolve(p);
  }
  return FORBIDDEN.some((f) => real === f || real.startsWith(f + path.sep));
}

/**
 * A live SQLite database must never be caught by this script, and the .bak files
 * sit in the same directory as one. Anything ending .db/.db-wal/.db-shm is
 * refused outright — the approved files all end in a -HHMMSS timestamp.
 */
function looksLikeLiveDatabase(p) {
  return /\.db(-wal|-shm)?$/.test(p);
}

// ---------------------------------------------------------------------------

function sh(bin, args, { timeout = 120000 } = {}) {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\s+$/, '');
  } catch (err) {
    return `!! ${String(err.stderr || err.message).trim().split('\n')[0]}`;
  }
}

function df() {
  return sh('df', ['-h', '/'], { timeout: 20000 });
}

function sizeOf(p) {
  const out = sh('du', ['-sb', '--one-file-system', p], { timeout: 300000 });
  const m = out.match(/^(\d+)/);
  return m ? +m[1] : 0;
}

const gb = (b) => (b / 1073741824).toFixed(3) + ' GB';
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

let removedBytes = 0;
let removedCount = 0;
const failures = [];

/** The single choke point. Every deletion in this file goes through here. */
function remove(p, { dir = false } = {}) {
  if (!fs.existsSync(p)) {
    console.log(`    SKIP (absent)   ${p}`);
    return;
  }
  if (isForbidden(p)) {
    console.log(`    REFUSED (protected) ${p}`);
    failures.push(`refused-protected: ${p}`);
    return;
  }
  if (!dir && looksLikeLiveDatabase(p)) {
    console.log(`    REFUSED (looks like a live database) ${p}`);
    failures.push(`refused-livedb: ${p}`);
    return;
  }
  const bytes = sizeOf(p);
  if (!APPLY) {
    console.log(`    would remove    ${mb(bytes).padStart(10)}  ${p}`);
    removedBytes += bytes; removedCount += 1;
    return;
  }
  try {
    fs.rmSync(p, { recursive: dir, force: false });
    console.log(`    removed         ${mb(bytes).padStart(10)}  ${p}`);
    removedBytes += bytes; removedCount += 1;
  } catch (err) {
    console.log(`    FAILED          ${p}: ${err.message}`);
    failures.push(`failed: ${p}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------

console.log('cleanup-disk-tier1.js');
console.log(APPLY ? 'MODE: APPLY — this run deletes.' : 'MODE: DRY RUN — nothing will be deleted. Pass --apply to act.');
console.log(`utc: ${new Date().toISOString()}`);

console.log('');
console.log('=== df -h / BEFORE ===');
const dfBefore = df();
console.log(dfBefore);

// --- 1. The migration-night .bak copies in the live data directory -----------

console.log('');
console.log('=== 1. roots.db.bak-20260804-* in the live data directory ===');
for (const f of BAK_FILES) remove(f);

// --- 2. deploy-* older than 30 days -----------------------------------------

console.log('');
console.log(`=== 2. ${BACKUPS_DIR}/deploy-* older than ${DEPLOY_AGE_DAYS} days ===`);
const cutoffMs = Date.now() - DEPLOY_AGE_DAYS * 86400000;
console.log(`    cutoff: anything modified before ${new Date(cutoffMs).toISOString()}`);

let entries = [];
try {
  entries = fs.readdirSync(BACKUPS_DIR);
} catch (err) {
  console.log(`    cannot read ${BACKUPS_DIR}: ${err.message}`);
  failures.push(`readdir ${BACKUPS_DIR}: ${err.message}`);
}

const deployTargets = [];
let keptRecent = 0;
for (const name of entries) {
  if (!DEPLOY_DIR_RE.test(name)) continue;      // leaves hourly, daily, dash-* alone
  const full = path.join(BACKUPS_DIR, name);
  let st;
  try { st = fs.lstatSync(full); } catch (_) { continue; }
  if (!st.isDirectory()) continue;
  if (st.mtimeMs >= cutoffMs) { keptRecent += 1; continue; }
  deployTargets.push(full);
}
deployTargets.sort();
console.log(`    matched ${deployTargets.length} deploy-* dir(s) older than the cutoff; keeping ${keptRecent} newer one(s)`);
console.log(`    (entries in ${BACKUPS_DIR} not matching /^deploy-\\d{8}-\\d{6}$/ are untouched — hourly, daily, dash-*)`);
for (const d of deployTargets) remove(d, { dir: true });

// --- 3. Migration scratch and loose dumps -----------------------------------

console.log('');
console.log('=== 3. migration scratch directories ===');
for (const d of SCRATCH_DIRS) remove(d, { dir: true });

console.log('');
console.log('=== 4. loose /root/*.sql dumps ===');
for (const f of LOOSE_SQL) remove(f);

// --- 5. systemd journal ------------------------------------------------------

console.log('');
console.log('=== 5. journalctl --vacuum-size=200M ===');
const journalBefore = sizeOf('/var/log/journal');
console.log(`    /var/log/journal before: ${mb(journalBefore)}`);
if (APPLY) {
  console.log(sh('journalctl', ['--vacuum-size=200M'], { timeout: 180000 })
    .split('\n').map((l) => `    ${l}`).join('\n'));
  const journalAfter = sizeOf('/var/log/journal');
  console.log(`    /var/log/journal after : ${mb(journalAfter)}`);
  removedBytes += Math.max(0, journalBefore - journalAfter);
} else {
  console.log('    would run: journalctl --vacuum-size=200M');
}

// --- 6. The diagnostic's leftover probe table --------------------------------

console.log('');
console.log('=== 6. DROP TABLE postgres.public._diag_disk_usage_write_probe ===');
console.log('    (left by diagnostic run 31131790202, whose read-only guard was broken)');

function psqlPostgres(sql, { timeout = 60000 } = {}) {
  return sh('sudo', ['-u', 'postgres', 'psql', '-q', '-d', 'postgres', '-tAX',
    '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout });
}

const presentBefore = psqlPostgres(
  "select count(*) from pg_tables where schemaname='public' and tablename='_diag_disk_usage_write_probe'");
console.log(`    present before (1 = yes): ${presentBefore}`);

// Refuse to touch it unless it is what it claims to be: zero rows, no dependants.
const rowCount = psqlPostgres('select count(*) from public._diag_disk_usage_write_probe');
console.log(`    rows in it (expected 0) : ${rowCount}`);

if (APPLY) {
  if (presentBefore.trim() !== '1') {
    console.log('    nothing to drop.');
  } else if (rowCount.trim() !== '0') {
    console.log('    REFUSED: the table is not empty. Not dropping something that holds data.');
    failures.push('probe table not empty — not dropped');
  } else {
    console.log(`    ${psqlPostgres('DROP TABLE public._diag_disk_usage_write_probe')}`);
    const presentAfter = psqlPostgres(
      "select count(*) from pg_tables where schemaname='public' and tablename='_diag_disk_usage_write_probe'");
    console.log(`    present after (0 = dropped): ${presentAfter}`);
    if (presentAfter.trim() !== '0') failures.push('probe table still present after DROP');
  }
  // The tacet database is never opened by this script; state that it was not.
  console.log('    tacet: not opened by this script at any point.');
} else {
  console.log('    would run: DROP TABLE public._diag_disk_usage_write_probe');
}

// --- Result ------------------------------------------------------------------

console.log('');
console.log('=== df -h / AFTER ===');
const dfAfter = df();
console.log(dfAfter);

console.log('');
console.log('=== SUMMARY ===');
console.log(`  entries ${APPLY ? 'removed' : 'that would be removed'}: ${removedCount}`);
console.log(`  bytes   ${APPLY ? 'reclaimed' : 'that would be reclaimed'}: ${gb(removedBytes)}`);
console.log(`  before: ${dfBefore.split('\n').pop()}`);
console.log(`  after : ${dfAfter.split('\n').pop()}`);
if (failures.length) {
  console.log('');
  console.log(`  ${failures.length} PROBLEM(S):`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  no refusals, no failures.');
}
console.log('');
console.log('Untouched by design: /root/backups/hourly, /root/backups/daily, the live');
console.log('data/*.db set, the Postgres tacet database, /swapfile, the scraper chrome');
console.log('profiles, and /root/decimal-rebuild.');
