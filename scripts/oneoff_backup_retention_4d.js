#!/usr/bin/env node
// oneoff_backup_retention_4d.js — local daily backups keep 4 days, not 14 (§466).
//
// Ash, 2026-10-12: the box sits at 84% and the alerts are about backups, not
// orders — "need to cut that to 3-4 days backup". Measured the same day with
// scripts/diagnose_disk_usage.js: /root/backups is 20G of the 32G used. daily/
// holds 14 copies of roots.db at ~630MB each (8.8G). hourly/ holds 12 (7.7G)
// plus two UNCOMPRESSED files from the 2026-09-23 disk-full outage (898MB and a
// truncated 485MB) that the hourly prune can never reach, because it only lists
// roots-*.db.gz.
//
// WHY 4 DAYS LOSES NO HISTORY. scripts/db-backup.sh uploads a verified copy to
// OSS every night at 03:30 and keeps 14 days there; its log showed OK on every
// night checked. So the deepest recovery point stays 14 days, off the box. This
// script refuses to cut anything if that off-site run has not succeeded in the
// last 48 hours.
//
// WHAT IT DOES, all in one place it can show first:
//   1. /root/scripts/roots-backup.sh (outside git and the deploy — the only way
//      to change it from CI is this workflow): the daily prune keeps 4, not 14,
//      and a new line sweeps stray uncompressed roots-*.db{,-wal,-shm} out of
//      hourly/ once they are over two hours old. The old script is kept beside
//      it as roots-backup.sh.bak-<timestamp>. The new one is checked with
//      `bash -n` before it replaces the old, and replaces it atomically.
//   2. Applies that retention now: deletes daily copies beyond the newest 4 and
//      the two stray hourly files.
//   Hourly retention (12) is NOT changed.
//
// Dry run by default. Writes only with --apply. Opens no database.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const SCRIPT = '/root/scripts/roots-backup.sh';
const BASE = '/root/backups';
const DAILY = path.join(BASE, 'daily');
const HOURLY = path.join(BASE, 'hourly');
const OFFSITE_LOG = '/root/roots-v2/logs/db-backup.log';
const KEEP_DAILY = 4;
const STRAY_MIN_AGE_MS = 2 * 60 * 60 * 1000;

const mb = (b) => (b / 1048576).toFixed(0) + 'MB';
const df = () => execFileSync('df', ['-h', '/'], { encoding: 'utf8' }).trim().split('\n').pop();
function die(msg) { console.error('ABORT: ' + msg + '\nNothing was changed.'); process.exit(1); }

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`disk before: ${df()}`);

// --- guard 1: the off-site copy must be alive, or a short local tier is the only history ---
let last = '';
try { last = fs.readFileSync(OFFSITE_LOG, 'utf8').trim().split('\n').pop() || ''; }
catch (_) { die(`cannot read ${OFFSITE_LOG}; cannot prove the off-site backup is running`); }
const m = last.match(/^(\S+)\s+(OK|FAIL)\b/);
if (!m || m[2] !== 'OK') die(`last off-site backup did not succeed: "${last}"`);
const ageH = (Date.now() - Date.parse(m[1])) / 3600000;
if (!(ageH >= 0 && ageH < 48)) die(`last off-site backup is ${ageH.toFixed(1)}h old (needs < 48h): "${last}"`);
console.log(`off-site backup OK, ${ageH.toFixed(1)}h ago: ${last}`);

// --- guard 2: the local tier must itself be current, or deleting old copies deletes the newest we have ---
const daily = fs.readdirSync(DAILY).filter((f) => /^roots-\d{8}\.db\.gz$/.test(f)).sort().reverse();
if (daily.length === 0) die('daily/ has no snapshots');
const newestDay = daily[0].slice(6, 14);
const newestAgeH = (Date.now() - Date.parse(`${newestDay.slice(0, 4)}-${newestDay.slice(4, 6)}-${newestDay.slice(6, 8)}T00:00:00+08:00`)) / 3600000;
if (!(newestAgeH < 48)) die(`newest daily snapshot ${daily[0]} is ${newestAgeH.toFixed(0)}h old; local backups may have stopped`);

// --- 1. the script edit ---
const src = fs.readFileSync(SCRIPT, 'utf8');
const DAILY_RE = /^(\s*ls -1t "\$BASE\/daily"\/roots-\*\.db\.gz\s+2>\/dev\/null \| tail -n \+)(\d+)( \| xargs -r rm -f)$/m;
const hits = src.match(new RegExp(DAILY_RE.source, 'gm')) || [];
if (hits.length !== 1) die(`expected exactly one daily prune line in ${SCRIPT}, found ${hits.length}`);
const SWEEP = `find "$BASE/hourly" -maxdepth 1 \\( -name 'roots-*.db' -o -name 'roots-*.db-wal' -o -name 'roots-*.db-shm' \\) -mmin +120 -delete  # stray uncompressed leftovers (§466)`;

let out = src.replace(DAILY_RE, `$1${KEEP_DAILY + 1}$3`);
out = out.replace(/retains the most recent \d+ days/, `retains the most recent ${KEEP_DAILY} days`);
if (!out.includes('# stray uncompressed leftovers (§466)')) {
  out = out.replace(DAILY_RE, (line) => `${line}\n${SWEEP}`);
}
if (!out.includes(SWEEP)) die('could not place the stray-file sweep line');

if (out === src) {
  console.log(`\n${SCRIPT}: already at ${KEEP_DAILY} days with the sweep — no edit needed`);
} else {
  console.log(`\n${SCRIPT}: changes`);
  const a = src.split('\n'), b = out.split('\n');
  for (const l of a) if (!b.includes(l)) console.log(`  - ${l}`);
  for (const l of b) if (!a.includes(l)) console.log(`  + ${l}`);
}

// --- 2. what the new retention removes now ---
const dropDaily = daily.slice(KEEP_DAILY).map((f) => path.join(DAILY, f));
const now = Date.now();
const strays = fs.readdirSync(HOURLY)
  .filter((f) => /^roots-.*\.db(-wal|-shm)?$/.test(f))
  .map((f) => path.join(HOURLY, f))
  .filter((p) => now - fs.statSync(p).mtimeMs > STRAY_MIN_AGE_MS);
const victims = [...dropDaily, ...strays];
let freed = 0;
console.log(`\nkeep daily: ${daily.slice(0, KEEP_DAILY).join(', ')}`);
console.log('delete:');
for (const p of victims) { const s = fs.statSync(p).size; freed += s; console.log(`  ${p}  ${mb(s)}`); }
if (victims.length === 0) console.log('  (nothing)');
console.log(`would free: ${mb(freed)}`);

if (!APPLY) { console.log('\nDRY RUN — nothing changed.'); process.exit(0); }

// --- apply ---
if (out !== src) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const bak = `${SCRIPT}.bak-${ts}`;
  fs.copyFileSync(SCRIPT, bak);
  const tmp = `${SCRIPT}.new-${process.pid}`;
  fs.writeFileSync(tmp, out, { mode: fs.statSync(SCRIPT).mode & 0o7777 });
  try { execFileSync('bash', ['-n', tmp]); }
  catch (e) { fs.unlinkSync(tmp); die(`edited script fails bash -n: ${e.message}`); }
  fs.renameSync(tmp, SCRIPT);
  console.log(`\nwrote ${SCRIPT} (old copy kept at ${bak})`);
}
let removed = 0;
for (const p of victims) { try { fs.unlinkSync(p); removed++; } catch (e) { console.error(`  could not delete ${p}: ${e.message}`); } }
console.log(`deleted ${removed}/${victims.length} files`);
console.log(`disk after: ${df()}`);
if (removed !== victims.length) process.exit(2);
