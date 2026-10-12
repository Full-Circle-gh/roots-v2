#!/usr/bin/env node
// diagnose_disk_usage.js — what is filling the HK box's disk, measured.
//
// The health watchdog pages when / crosses its disk line. The working guess is
// that the local database backups (/root/backups, written hourly by the
// untracked /root/scripts/roots-backup.sh) are most of it. This measures that
// guess instead of acting on it: sizes and counts per backup tier, the other
// usual suspects beside them, and the retention lines the LIVE backup script
// actually carries (it lives outside the deploy tree, so the copy in
// scripts/install-backup-cron.sh is not evidence of what runs).
//
// READ-ONLY. It runs df, du, ls and reads two files. It opens no database,
// writes nothing, deletes nothing and restarts nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return (e.stdout || '').toString().trim() || `(failed: ${cmd} ${args.join(' ')})`; }
}
const mb = (bytes) => (bytes / 1048576).toFixed(0) + 'MB';
function duBytes(p) {
  if (!fs.existsSync(p)) return null;
  const out = run('du', ['-sb', p]);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

console.log('=== df -h / ===');
console.log(run('df', ['-h', '/']));

console.log('\n=== largest top-level directories on / (same filesystem) ===');
console.log(run('sh', ['-c', 'du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -25']));

console.log('\n=== /root/backups by tier ===');
const BK = '/root/backups';
if (fs.existsSync(BK)) {
  const groups = {};
  for (const name of fs.readdirSync(BK)) {
    const key = name.startsWith('deploy-') ? 'deploy-* (code copies from each deploy)' : name;
    const b = duBytes(path.join(BK, name)) || 0;
    groups[key] = groups[key] || { bytes: 0, n: 0 };
    groups[key].bytes += b; groups[key].n += 1;
  }
  for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${k.padEnd(45)} ${mb(v.bytes).padStart(8)}  (${v.n} entr${v.n === 1 ? 'y' : 'ies'})`);
  }
  for (const tier of ['hourly', 'daily']) {
    const dir = path.join(BK, tier);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('roots-')).sort();
    const sizes = files.map((f) => fs.statSync(path.join(dir, f)).size);
    const avg = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    console.log(`  ${tier}: ${files.length} files, avg ${mb(avg)} each, oldest ${files[0] || '-'}, newest ${files[files.length - 1] || '-'}`);
  }
} else {
  console.log('  (no /root/backups)');
}

console.log('\n=== other usual suspects ===');
for (const p of [
  '/root/roots-v2/data', '/root/roots-v2/data/roots.db', '/root/roots-v2/data/roots.db-wal',
  '/root/roots-v2/data/tenants', '/root/roots-v2/logs', '/root/.pm2/logs', '/var/log',
  '/var/log/journal', '/tmp', '/root/.cache', '/root/.npm',
]) {
  const b = duBytes(p);
  console.log(`  ${p.padEnd(40)} ${b == null ? '(absent)' : mb(b)}`);
}

console.log('\n=== live backup script: retention lines ===');
const LIVE = '/root/scripts/roots-backup.sh';
if (fs.existsSync(LIVE)) {
  const lines = fs.readFileSync(LIVE, 'utf8').split('\n');
  lines.forEach((l, i) => { if (/tail -n \+|RETAIN|retain|mtime/.test(l)) console.log(`  ${LIVE}:${i + 1}: ${l.trim()}`); });
} else {
  console.log(`  ${LIVE} not found`);
}

console.log('\n=== crontab -l (backup-related lines) ===');
console.log(run('sh', ['-c', "crontab -l 2>/dev/null | grep -i -E 'backup|health' || echo '(none)'"]));

console.log('\n=== last 3 lines of /var/log/roots-backup.log ===');
console.log(run('tail', ['-n', '3', '/var/log/roots-backup.log']));

// The off-site tier (scripts/db-backup.sh -> OSS, RETAIN_DAYS=14) is what makes a
// short LOCAL retention safe. Whether it is actually succeeding is the question.
console.log('\n=== off-site backup (db-backup.sh): last 5 runs ===');
console.log(run('tail', ['-n', '5', '/root/roots-v2/logs/db-backup.log']));
console.log('--- /var/log/tacet-db-backup.log (last 5) ---');
console.log(run('tail', ['-n', '5', '/var/log/tacet-db-backup.log']));

console.log('\n=== every file in hourly/ and daily/, with size ===');
for (const tier of ['hourly', 'daily']) {
  const dir = path.join(BK, tier);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    console.log(`  ${tier}/${f.padEnd(34)} ${mb(fs.statSync(path.join(dir, f)).size).padStart(8)}`);
  }
}

console.log('\n=== /root/backups/oneoff-*.db ===');
console.log(run('sh', ['-c', 'ls -la /root/backups/oneoff-*.db 2>/dev/null || echo none']));
