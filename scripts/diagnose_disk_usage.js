#!/usr/bin/env node
/**
 * diagnose_disk_usage.js — measure what is actually using the disk on
 * roots-v2-hk, and separate throwaway from must-keep. It DELETES NOTHING.
 *
 * WHY THIS EXISTS
 * ---------------
 * The health watchdog pages at 85% used (`HEALTH_DISK_WARN_PCT`, see
 * scripts/health-watchdog.js) on a 40GB ESSD. The alert says the box is filling
 * up; it does not say what filled it. Answering that from a laptop is not
 * possible — nothing outside the box has SSH — so the question has to be asked
 * the same way every other live-server question in this project is asked: a
 * committed, reviewable, read-only diagnostic run through
 * .github/workflows/ro-query.yml.
 *
 * The specific suspicion this run tests is that the 2026-08-04/05 Postgres
 * migration work left working directories behind — /root/tmp-migration-full,
 * /root/tmp-migration-rehearsal, /root/tmp-money-scale, /root/decimal-rebuild —
 * plus loose dumps at /root/*.sql and /root/*.db, and that Postgres itself is
 * holding WAL or dropped-database storage it no longer needs. Every one of
 * those is a hypothesis. This script measures them; it does not assume them.
 *
 * READ-ONLY, AND PROVEN SO
 * ------------------------
 * Two mechanisms, not one:
 *
 *   1. FILESYSTEM. Every shell command goes through run(), which refuses any
 *      binary not in READ_ONLY_BINARIES. That list holds df, du, ls, stat,
 *      find, wc and psql only. There is no rm, no mv, no truncate, no
 *      redirection (execFileSync with an argv array, never a shell string), and
 *      no code path in this file that opens a file for writing.
 *
 *   2. POSTGRES. psql is invoked with PGOPTIONS=-c default_transaction_read_only=on,
 *      which makes the SERVER reject any write on this connection rather than
 *      relying on the queries below being well behaved. That is then PROVEN on
 *      every connection the same way scripts/postgres-full-copy/ proves its
 *      SQLite reads: probeReadOnly() attempts a real CREATE TABLE first and
 *      aborts the whole run if the write is accepted.
 *
 * The one thing it cannot promise is that `du` is free: walking /var/lib/postgresql
 * and /root costs I/O on a box that is already tight. Each command carries a
 * timeout and a failure is reported inline rather than aborting the run, so a
 * slow mount degrades one line of the report instead of losing all of it.
 *
 * WHAT IT REPORTS
 * ---------------
 *   1. df for the real filesystems, and the inode picture (a disk can be "full"
 *      on inodes with bytes to spare; the two are worth telling apart).
 *   2. du -sh for each named suspect, each with a one-level breakdown of what is
 *      inside it and the newest mtime in the tree — because "left over from
 *      tonight" is a claim about time, not only about size.
 *   3. Loose /root/*.sql and /root/*.db files, with size and mtime.
 *   4. The live SQLite set (data/roots.db + data/tenants/*.db and their WAL
 *      sidecars) — the thing that must NOT be touched, sized so it can be told
 *      apart from a scratch copy of itself.
 *   5. Local backup snapshots and the /tmp staging db-backup.sh uses.
 *   6. Postgres: per-database size, pg_wal bytes and segment count, whatever is
 *      pinning WAL (replication slots, prepared transactions, archive backlog),
 *      base/ directories with no matching row in pg_database (real
 *      dropped-database leftovers), and the largest relations in tacet.
 *   7. A backstop sweep: the largest directories anywhere on the root
 *      filesystem, so something nobody thought to name still shows up.
 *
 * Usage (via .github/workflows/ro-query.yml):
 *   Actions -> "Read-only prod query" -> script: scripts/diagnose_disk_usage.js
 */

'use strict';

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Read-only command gate
// ---------------------------------------------------------------------------

// Nothing outside this set may be executed. sudo is permitted ONLY as a prefix
// for psql (checked below), because the Postgres superuser role is reached as
// `sudo -u postgres psql` everywhere else in this repository.
const READ_ONLY_BINARIES = new Set(['df', 'du', 'ls', 'stat', 'find', 'wc', 'psql', 'sudo']);

function assertReadOnlyArgv(bin, args) {
  if (!READ_ONLY_BINARIES.has(bin)) {
    throw new Error(`refusing to run non-read-only binary: ${bin}`);
  }
  if (bin === 'sudo') {
    // Only `sudo -u postgres psql ...` is allowed through.
    if (args[0] !== '-u' || args[1] !== 'postgres' || args[2] !== 'psql') {
      throw new Error(`refusing sudo invocation that is not "sudo -u postgres psql": ${args.join(' ')}`);
    }
  }
}

/**
 * Run a read-only command. Never a shell string — argv array only, so there is
 * no path by which a filename could become a redirection or a second command.
 * Failure is a returned marker, not a thrown error: one unreadable mount should
 * cost one line of the report, not the report.
 */
function run(bin, args, { timeout = 120000, allowFail = true, env } = {}) {
  assertReadOnlyArgv(bin, args);
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\s+$/, '');
  } catch (err) {
    const msg = err.killed || err.signal
      ? `(timed out after ${timeout}ms)`
      : `(failed: ${String(err.stderr || err.message).trim().split('\n')[0]})`;
    if (!allowFail) throw err;
    return `!! ${msg}`;
  }
}

function section(title) {
  console.log('');
  console.log('='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}

function sub(title) {
  console.log('');
  console.log(`-- ${title}`);
}

function exists(path) {
  const out = run('stat', ['-c', '%F', path], { timeout: 10000 });
  return !out.startsWith('!!');
}

// ---------------------------------------------------------------------------
// Postgres, read-only and proven
// ---------------------------------------------------------------------------

// default_transaction_read_only is set on the CONNECTION, server-side. A write
// does not merely go unwritten — it is refused with 25006 before it touches
// anything. This is the same posture the migration scripts take with SQLite's
// mode=ro, and like those scripts it is proven rather than trusted.
const PG_ENV = Object.assign({}, process.env, {
  PGOPTIONS: '-c default_transaction_read_only=on',
});

let PG_AVAILABLE = null;

function psql(sql, { db = 'postgres', timeout = 60000 } = {}) {
  return run('sudo', ['-u', 'postgres', 'psql', '-d', db, '-tAX', '-F', '|',
    '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout, env: PG_ENV });
}

/**
 * Attempt a real write and demand that it be refused. If Postgres ACCEPTS the
 * CREATE TABLE then the read-only guarantee this script advertises is not in
 * force, and it must not go on to run anything else against the cluster.
 */
function probeReadOnly() {
  const probe = 'CREATE TABLE _diag_disk_usage_write_probe (x int)';
  const out = psql(probe, { timeout: 30000 });
  if (!out.startsWith('!!')) {
    console.log('');
    console.log('*** ABORTING: a write probe was ACCEPTED by Postgres. ***');
    console.log('*** default_transaction_read_only is not in force; this script will not');
    console.log('*** query a cluster it cannot prove it is only reading.');
    console.log(`*** probe output: ${out}`);
    process.exit(2);
  }
  console.log(`write probe refused as required -> ${out.slice(0, 160)}`);
  return true;
}

function pgAvailable() {
  if (PG_AVAILABLE === null) {
    const v = psql('select 1', { timeout: 20000 });
    PG_AVAILABLE = v.trim() === '1';
    if (!PG_AVAILABLE) {
      console.log(`Postgres not reachable as the postgres role -> ${v.slice(0, 200)}`);
    }
  }
  return PG_AVAILABLE;
}

// ---------------------------------------------------------------------------
// The suspects
// ---------------------------------------------------------------------------

const NAMED_PATHS = [
  '/root/decimal-rebuild',
  '/root/tmp-money-scale',
  '/root/tmp-migration-rehearsal',
  '/root/tmp-migration-full',
  '/var/lib/postgresql',
];

const APP_DIR = '/root/roots-v2';

// ---------------------------------------------------------------------------

console.log('diagnose_disk_usage.js — READ ONLY. This script deletes nothing.');
console.log(`host: ${run('ls', ['-d', '/'], { timeout: 5000 }) === '/' ? 'reachable' : '?'}`);
console.log(`utc:  ${new Date().toISOString()}`);

// --- 1. Filesystem -----------------------------------------------------------

section('1. FILESYSTEM');

sub('df -h /   (the alert is about this one)');
console.log(run('df', ['-h', '/'], { timeout: 20000 }));

sub('df -h  (all real filesystems)');
console.log(run('df', ['-hT', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs'],
  { timeout: 20000 }));

sub('df -i /  (inodes — a disk can be full on inodes with bytes free)');
console.log(run('df', ['-i', '/'], { timeout: 20000 }));

// --- 2. The named suspects ---------------------------------------------------

section('2. NAMED SUSPECTS — size, contents, and age');

for (const p of NAMED_PATHS) {
  sub(p);
  if (!exists(p)) {
    console.log('  (does not exist — nothing to reclaim here)');
    continue;
  }

  const total = run('du', ['-sh', '--one-file-system', p], { timeout: 300000 });
  console.log(`  TOTAL: ${total}`);

  // Bytes as well as the human figure, so the freed-space arithmetic in the
  // report is done on numbers rather than on rounded strings.
  const bytes = run('du', ['-sb', '--one-file-system', p], { timeout: 300000 });
  console.log(`  bytes: ${bytes}`);

  // One level down: WHAT is big, not just that something is.
  const inside = run('du', ['-h', '--max-depth=1', '--one-file-system', p], { timeout: 300000 });
  console.log('  breakdown (depth 1, largest last):');
  console.log(inside.split('\n').map((l) => `    ${l}`).join('\n'));

  // Age. "Left over from tonight" is a claim about mtime; check it rather than
  // inferring it from the directory name.
  const newest = run('find', [p, '-xdev', '-type', 'f', '-printf', '%T+ %p\\n'], { timeout: 120000 });
  if (!newest.startsWith('!!') && newest.trim()) {
    const lines = newest.trim().split('\n').sort();
    console.log(`  oldest file: ${lines[0]}`);
    console.log(`  newest file: ${lines[lines.length - 1]}`);
    console.log(`  file count : ${lines.length}`);
  } else {
    console.log(`  mtimes: ${newest}`);
  }

  // The ten largest individual files in the tree.
  const big = run('find', [p, '-xdev', '-type', 'f', '-size', '+10M', '-printf', '%s %TY-%Tm-%Td %p\\n'],
    { timeout: 120000 });
  if (!big.startsWith('!!') && big.trim()) {
    const rows = big.trim().split('\n')
      .map((l) => { const m = l.match(/^(\d+) (\S+) (.*)$/); return m ? { b: +m[1], d: m[2], p: m[3] } : null; })
      .filter(Boolean)
      .sort((a, b) => b.b - a.b)
      .slice(0, 12);
    console.log('  files >10MB (largest first):');
    for (const r of rows) console.log(`    ${(r.b / 1048576).toFixed(1).padStart(9)} MB  ${r.d}  ${r.p}`);
  } else {
    console.log('  files >10MB: none');
  }
}

// --- 3. Loose dumps at /root -------------------------------------------------

section('3. LOOSE FILES AT /root  (*.sql, *.db, and other big strays)');

sub('/root/*.sql and /root/*.db (top level only)');
const loose = run('find', ['/root', '-maxdepth', '1', '-type', 'f',
  '(', '-name', '*.sql', '-o', '-name', '*.db', '-o', '-name', '*.db-wal', '-o',
  '-name', '*.db-shm', '-o', '-name', '*.dump', '-o', '-name', '*.sql.gz', '-o',
  '-name', '*.tar.gz', '-o', '-name', '*.gz', ')',
  '-printf', '%s %TY-%Tm-%Td_%TH:%TM %p\\n'], { timeout: 60000 });
if (!loose.startsWith('!!') && loose.trim()) {
  const rows = loose.trim().split('\n')
    .map((l) => { const m = l.match(/^(\d+) (\S+) (.*)$/); return m ? { b: +m[1], d: m[2], p: m[3] } : null; })
    .filter(Boolean)
    .sort((a, b) => b.b - a.b);
  let sum = 0;
  for (const r of rows) { sum += r.b; console.log(`  ${(r.b / 1048576).toFixed(1).padStart(10)} MB  ${r.d}  ${r.p}`); }
  console.log(`  ---- ${rows.length} file(s), ${(sum / 1073741824).toFixed(2)} GB total`);
} else {
  console.log('  none found');
}

sub('everything at /root top level (so nothing unnamed hides)');
console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', '/root'], { timeout: 300000 }));

// --- 4. What must NOT be touched --------------------------------------------

section('4. MUST-KEEP — the live SQLite data');

sub(`${APP_DIR}/data  (live database + per-tenant databases)`);
console.log(run('du', ['-h', '--max-depth=2', '--one-file-system', `${APP_DIR}/data`], { timeout: 120000 }));

sub('the database files themselves, with WAL sidecars');
const liveDbs = run('find', [`${APP_DIR}/data`, '-maxdepth', '2', '-type', 'f',
  '(', '-name', '*.db', '-o', '-name', '*.db-wal', '-o', '-name', '*.db-shm', ')',
  '-printf', '%s %TY-%Tm-%Td_%TH:%TM %p\\n'], { timeout: 60000 });
console.log(liveDbs.split('\n').map((l) => {
  const m = l.match(/^(\d+) (\S+) (.*)$/);
  return m ? `  ${(+m[1] / 1048576).toFixed(1).padStart(10)} MB  ${m[2]}  ${m[3]}` : `  ${l}`;
}).join('\n'));

sub(`${APP_DIR} top level (app tree, node_modules, logs)`);
console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', APP_DIR], { timeout: 300000 }));

sub(`${APP_DIR}/logs`);
console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', `${APP_DIR}/logs`], { timeout: 60000 }));

// --- 5. Backups and staging --------------------------------------------------

section('5. BACKUPS AND STAGING  (db-backup.sh / roots-backup.sh)');

for (const p of ['/root/backups', '/root/scripts', '/var/backups', '/root/db-backups']) {
  if (exists(p)) {
    sub(p);
    console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', p], { timeout: 120000 }));
  }
}

sub('/tmp — db-backup.sh stages its snapshots here (WORK=/tmp) before upload');
console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', '/tmp'], { timeout: 120000 }));

sub('/tmp files >10MB, with age (STALE_TMP_DAYS=2 in db-backup.sh)');
const tmpBig = run('find', ['/tmp', '-maxdepth', '2', '-xdev', '-type', 'f', '-size', '+10M',
  '-printf', '%s %TY-%Tm-%Td_%TH:%TM %p\\n'], { timeout: 60000 });
console.log(tmpBig.trim() ? tmpBig.split('\n').map((l) => {
  const m = l.match(/^(\d+) (\S+) (.*)$/);
  return m ? `  ${(+m[1] / 1048576).toFixed(1).padStart(10)} MB  ${m[2]}  ${m[3]}` : `  ${l}`;
}).join('\n') : '  none');

sub('/var/log');
console.log(run('du', ['-h', '--max-depth=1', '--one-file-system', '/var/log'], { timeout: 120000 }));

// --- 6. Postgres -------------------------------------------------------------

section('6. POSTGRES — is tacet itself the problem, and is WAL bloated?');

if (pgAvailable()) {
  probeReadOnly();

  sub('version and data directory');
  console.log(psql("select version()"));
  console.log(`data_directory: ${psql('show data_directory')}`);

  sub('every database, with size (this answers "is tacet significant?")');
  console.log('  NAME | OWNER | SIZE | BYTES');
  console.log(psql(
    "select d.datname, pg_get_userbyid(d.datdba), " +
    "pg_size_pretty(pg_database_size(d.datname)), pg_database_size(d.datname) " +
    "from pg_database d where datallowconn order by pg_database_size(d.datname) desc"
  ).split('\n').map((l) => `  ${l}`).join('\n'));

  sub('WAL — total bytes, segment count, and the settings that bound it');
  console.log(`  pg_wal on disk : ${psql("select pg_size_pretty(sum(size)) from pg_ls_waldir()")}`);
  console.log(`  pg_wal bytes   : ${psql("select coalesce(sum(size),0) from pg_ls_waldir()")}`);
  console.log(`  segment count  : ${psql("select count(*) from pg_ls_waldir()")}`);
  console.log(`  oldest segment : ${psql("select name || ' @ ' || modification from pg_ls_waldir() order by modification asc limit 1")}`);
  console.log(`  newest segment : ${psql("select name || ' @ ' || modification from pg_ls_waldir() order by modification desc limit 1")}`);
  console.log('  settings:');
  console.log(psql(
    "select name || ' = ' || setting || coalesce(' ' || unit, '') from pg_settings " +
    "where name in ('max_wal_size','min_wal_size','wal_keep_size','wal_level'," +
    "'archive_mode','archive_command','checkpoint_timeout','wal_compression')"
  ).split('\n').map((l) => `    ${l}`).join('\n'));

  sub('what could be PINNING WAL (a slot or a stuck transaction stops recycling)');
  console.log('  replication slots:');
  console.log(psql(
    "select coalesce(string_agg(slot_name || ' active=' || active || ' retained=' || " +
    "pg_size_pretty(coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn),0)), E'\\n'), " +
    "'    (none)') from pg_replication_slots"
  ).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('  prepared transactions:');
  console.log(psql("select coalesce(string_agg(gid || ' since ' || prepared, E'\\n'), '    (none)') from pg_prepared_xacts")
    .split('\n').map((l) => `    ${l}`).join('\n'));
  console.log(`  archive_status backlog: ${run('find', ['/var/lib/postgresql', '-xdev', '-type', 'd', '-name', 'archive_status'], { timeout: 60000 })}`);

  sub('DROPPED-DATABASE LEFTOVERS — base/ dirs with no row in pg_database');
  // A clean DROP DATABASE removes base/<oid>. A directory in base/ whose name is
  // not an oid in pg_database is storage nothing can reach through SQL.
  const dataDir = psql('show data_directory').trim();
  if (dataDir && !dataDir.startsWith('!!')) {
    const baseDirs = run('ls', ['-1', `${dataDir}/base`], { timeout: 30000 });
    const oids = psql('select oid from pg_database');
    if (!baseDirs.startsWith('!!') && !oids.startsWith('!!')) {
      const known = new Set(oids.split('\n').map((s) => s.trim()).filter(Boolean));
      const dirs = baseDirs.split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      const orphans = dirs.filter((d) => !known.has(d));
      console.log(`  base/ has ${dirs.length} numeric dir(s); pg_database has ${known.size} oid(s)`);
      if (orphans.length) {
        for (const o of orphans) {
          console.log(`  ORPHAN base/${o}: ${run('du', ['-sh', `${dataDir}/base/${o}`], { timeout: 120000 })}`);
        }
      } else {
        console.log('  no orphaned base/ directories — every one maps to a live database');
      }
      // pgsql_tmp is spill from sorts/hashes; a crashed session can strand it.
      console.log(`  pgsql_tmp: ${run('find', [dataDir, '-xdev', '-type', 'd', '-name', 'pgsql_tmp', '-printf', '%p\\n'], { timeout: 60000 }) || '(none)'}`);
    } else {
      console.log(`  could not compare: base=${baseDirs.slice(0, 80)} oids=${oids.slice(0, 80)}`);
    }
  }

  sub('the 20 largest relations in tacet (is the DATA big, or is it bloat?)');
  console.log('  RELATION | TOTAL | TABLE | INDEXES | LIVE ROWS | DEAD ROWS');
  console.log(psql(
    "select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)), " +
    "pg_size_pretty(pg_table_size(c.oid)), pg_size_pretty(pg_indexes_size(c.oid)), " +
    "coalesce(s.n_live_tup,0), coalesce(s.n_dead_tup,0) " +
    "from pg_class c join pg_namespace n on n.oid=c.relnamespace " +
    "left join pg_stat_user_tables s on s.relid=c.oid " +
    "where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema') " +
    "order by pg_total_relation_size(c.oid) desc limit 20",
    { db: 'tacet' }
  ).split('\n').map((l) => `  ${l}`).join('\n'));

  sub('tacet: total size vs the sum of its relations (the gap is bloat/free space)');
  console.log(`  pg_database_size(tacet): ${psql("select pg_size_pretty(pg_database_size('tacet'))")}`);
  console.log(`  sum of relations       : ${psql("select pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)),0)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema')", { db: 'tacet' })}`);
  console.log('  tables never vacuumed / with the most dead tuples:');
  console.log(psql(
    "select relname || ' dead=' || n_dead_tup || ' live=' || n_live_tup || " +
    "' last_autovacuum=' || coalesce(last_autovacuum::text,'never') " +
    "from pg_stat_user_tables where n_dead_tup > 0 order by n_dead_tup desc limit 10",
    { db: 'tacet' }
  ).split('\n').map((l) => `    ${l}`).join('\n'));

  sub('/var/lib/postgresql on disk, by cluster subdirectory');
  console.log(run('du', ['-h', '--max-depth=3', '--one-file-system', '/var/lib/postgresql'], { timeout: 300000 }));
} else {
  console.log('SKIPPED — could not reach Postgres as the postgres role.');
  sub('/var/lib/postgresql on disk anyway');
  console.log(run('du', ['-h', '--max-depth=3', '--one-file-system', '/var/lib/postgresql'], { timeout: 300000 }));
}

// --- 7. Backstop sweep -------------------------------------------------------

section('7. BACKSTOP — largest directories anywhere on /, in case something unnamed is the real cause');

sub('top 40 directories by size (root filesystem only)');
const sweep = run('du', ['-x', '--max-depth=4', '-B1', '/'], { timeout: 420000 });
if (!sweep.startsWith('!!')) {
  const rows = sweep.split('\n')
    .map((l) => { const m = l.match(/^(\d+)\s+(.*)$/); return m ? { b: +m[1], p: m[2] } : null; })
    .filter(Boolean)
    .sort((a, b) => b.b - a.b)
    .slice(0, 40);
  for (const r of rows) {
    console.log(`  ${(r.b / 1073741824).toFixed(2).padStart(8)} GB  ${r.p}`);
  }
} else {
  console.log(`  ${sweep}`);
}

sub('single files >100MB anywhere on / (excluding the app node_modules)');
const bigFiles = run('find', ['/', '-xdev', '-type', 'f', '-size', '+100M',
  '-not', '-path', '*/node_modules/*', '-printf', '%s %TY-%Tm-%Td_%TH:%TM %p\\n'], { timeout: 300000 });
if (!bigFiles.startsWith('!!') && bigFiles.trim()) {
  const rows = bigFiles.trim().split('\n')
    .map((l) => { const m = l.match(/^(\d+) (\S+) (.*)$/); return m ? { b: +m[1], d: m[2], p: m[3] } : null; })
    .filter(Boolean)
    .sort((a, b) => b.b - a.b)
    .slice(0, 40);
  for (const r of rows) console.log(`  ${(r.b / 1073741824).toFixed(2).padStart(8)} GB  ${r.d}  ${r.p}`);
} else {
  console.log('  none');
}

console.log('');
console.log('='.repeat(78));
console.log('END. Nothing was deleted, moved, or modified by this run.');
console.log('='.repeat(78));
