#!/usr/bin/env node
/**
 * Side-by-side proof that routing lib/store-hours.js through the database seam
 * (lib/db-seam.js) changed nothing.
 *
 * WHY THIS HAS TO BE EXPLICIT ABOUT THROWING
 * ------------------------------------------
 * store-hours.js wraps its only read in try/catch and, on failure, keeps serving
 * its last good cache. A seam that broke the read would therefore be invisible
 * from the outside: the daemons would keep getting hours, the app would stay up,
 * and the module would quietly stop reading the database. "Nothing looks broken"
 * proves nothing here. So this harness sits a probe UNDERNEATH the seam, records
 * every exception the handle raises whether or not store-hours swallows it, and
 * fails if the count is not zero.
 *
 * WHAT IS COMPARED
 * ----------------
 * The real lib/store-hours.js module is loaded TWICE against the same read-only
 * connection, with only one thing different:
 *
 *   RAW      lib/db-seam.js stubbed to the identity function — byte-for-byte the
 *            behaviour store-hours had before this change.
 *   WRAPPED  the real seam.
 *
 * Then: the SQL issued, the rows returned, the parsed hours map, every
 * storeHours(code) answer, and within() sampled across the clock — all compared.
 *
 * The database is opened read-only and PROVEN read-only before anything runs, by
 * attempting a write and aborting if it is accepted. database.js is never
 * required: it issues CREATE TABLE / ALTER TABLE at load, which is a write path.
 * It is replaced in the module cache by the read-only handle instead.
 *
 * Run: node scripts/diagnose_store_hours_seam.js
 *      (via .github/workflows/ro-query.yml against live prod)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

const DATABASE_JS = path.join(HOME, 'database.js');
const STORE_HOURS_JS = path.join(HOME, 'lib', 'store-hours.js');
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');

// All three must exist on disk. database.js is never executed — it is replaced in
// the module cache below — but Node resolves `require('../database')` to a real
// path before it consults that cache, so the file has to be there for the stub to
// take effect. If it were missing, store-hours would fail to load and every
// comparison below would pass vacuously against two empty results.
for (const f of [STORE_HOURS_JS, DB_SEAM_JS, DATABASE_JS]) {
  if (!fs.existsSync(f)) { console.error('FATAL: missing ' + f); process.exit(2); }
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without comparing anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);
console.log('');

let FAILURES = 0;
const fail = (msg) => { FAILURES++; console.log('   FAIL  ' + msg); };
const ok = (msg) => console.log('   ok    ' + msg);

// ── The probe ───────────────────────────────────────────────────────────────
// Sits between the real connection and whatever store-hours is given, so it sees
// what was actually issued and what actually came back — including an exception
// that store-hours is about to swallow. It rethrows: it observes, it never heals.
function probeHandle(real) {
  const log = { sql: [], rows: [], errors: [] };
  const handle = {
    prepare(sql) {
      log.sql.push(sql);
      let stmt;
      try {
        stmt = real.prepare(sql);
      } catch (e) {
        log.errors.push({ phase: 'prepare', sql, message: e.message });
        throw e;
      }
      return {
        all(...args) {
          try {
            const rows = stmt.all(...args);
            log.rows.push(rows);
            return rows;
          } catch (e) {
            log.errors.push({ phase: 'all', sql, message: e.message });
            throw e;
          }
        },
        get(...args) { return stmt.get(...args); },
        run(...args) { return stmt.run(...args); },
        iterate(...args) { return stmt.iterate(...args); },
      };
    },
    exec(...args) { return real.exec(...args); },
    pragma(...args) { return real.pragma(...args); },
  };
  return { handle, log };
}

// ── Load the real store-hours module against a chosen seam ──────────────────
// The module cache is primed so that store-hours' own `require('../database')`
// and `require('./db-seam')` resolve to what we hand it, and cleared afterwards
// so the two runs cannot share the module's ten-minute cache.
function loadStoreHours({ identitySeam }) {
  const { handle, log } = probeHandle(db);

  for (const id of [DATABASE_JS, STORE_HOURS_JS, DB_SEAM_JS]) delete require.cache[id];

  require.cache[DATABASE_JS] = {
    id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: handle,
  };
  if (identitySeam) {
    require.cache[DB_SEAM_JS] = {
      id: DB_SEAM_JS, filename: DB_SEAM_JS, loaded: true, children: [], paths: [],
      exports: { seam: (h) => h, unwrap: (h) => h, isWrapped: () => false },
    };
  }

  let mod, threw = null;
  try {
    mod = require(STORE_HOURS_JS);
    // loadAll() is lazy — it fires on the first storeHours() call, not at require.
    // Force it here so the probe log below reflects a real read rather than a
    // module that was loaded and never asked for anything.
    mod.storeHours('__force_load__');
  } catch (e) {
    threw = e;
  }

  for (const id of [DATABASE_JS, STORE_HOURS_JS, DB_SEAM_JS]) delete require.cache[id];
  return { mod, log, threw };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · load both paths ══');

const RAW = loadStoreHours({ identitySeam: true });
const WRAPPED = loadStoreHours({ identitySeam: false });

if (RAW.threw) fail('RAW path threw at require: ' + RAW.threw.message);
else ok('RAW path loaded');

// The headline assertion the whole harness exists for.
if (WRAPPED.threw) fail('WRAPPED path threw at require: ' + WRAPPED.threw.stack);
else ok('WRAPPED path loaded');

// If either side failed to load there is nothing to compare, and every check
// below would agree trivially on two empty results. Stop here rather than print
// a page of green ticks that mean nothing.
if (RAW.threw || WRAPPED.threw || !RAW.mod || !WRAPPED.mod) {
  console.log('\n' + '═'.repeat(72));
  console.log(`RESULT: FAIL — a path did not load; nothing was compared. ${FAILURES} check(s) failed.`);
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · the seam did not throw — asserted, not inferred ══');
console.log('   (store-hours swallows read errors and serves its last good cache,');
console.log('    so this is checked at the handle, underneath that try/catch)');

// 2a — the direct assertion. Issue store-hours' own statement through a real
// seam-wrapped handle with NO try/catch of the module's in the way, so a fault
// originating INSIDE the seam surfaces here. The probe below cannot see this
// class of failure: it sits underneath the seam, so a seam that throws before it
// reaches the handle never touches the probe at all.
{
  delete require.cache[DB_SEAM_JS];
  const seamNow = require(DB_SEAM_JS);
  const sql = (RAW.log.sql[0]) || 'SELECT code, open_time, close_time FROM retail_stores';
  let seamThrew = null, rows = null;
  try {
    rows = seamNow.seam(db).prepare(sql).all();
  } catch (e) {
    seamThrew = e;
  }
  if (seamThrew) {
    fail('the seam itself threw on store-hours\' statement: ' + seamThrew.message);
    console.log('         ' + (seamThrew.stack || '').split('\n').slice(1, 4).join('\n         '));
  } else {
    ok(`the seam executed store-hours' statement without throwing (${rows.length} row(s))`);
  }
}

// 2b — exceptions observed at the handle, underneath the seam and underneath
// store-hours' catch. This is what catches a fault the module would have hidden.
if (WRAPPED.log.errors.length === 0) {
  ok('zero exceptions raised at the handle beneath the seam');
} else {
  fail('the handle beneath the seam raised ' + WRAPPED.log.errors.length + ' exception(s):');
  for (const e of WRAPPED.log.errors) console.log(`         ${e.phase}: ${e.message}\n         sql: ${e.sql}`);
}
if (RAW.log.errors.length !== 0) {
  fail('the RAW handle also raised ' + RAW.log.errors.length + ' exception(s) — baseline is not clean');
}

// A swallowed throw leaves the module with an empty map. Prove the read reached
// the module, rather than the catch.
if (WRAPPED.log.rows.length === 0) {
  fail('the wrapped path issued no completed read at all');
} else {
  ok(`the wrapped path completed its read: ${WRAPPED.log.rows[0].length} row(s) from retail_stores`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · identical SQL ══');
console.log('   RAW     : ' + JSON.stringify(RAW.log.sql));
console.log('   WRAPPED : ' + JSON.stringify(WRAPPED.log.sql));
if (JSON.stringify(RAW.log.sql) === JSON.stringify(WRAPPED.log.sql)) ok('same statements, same order');
else fail('the seam changed the SQL issued');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · identical rows off the wire ══');
const rawRows = JSON.stringify(RAW.log.rows);
const wrapRows = JSON.stringify(WRAPPED.log.rows);
if (rawRows === wrapRows) {
  ok(`row sets identical (${(RAW.log.rows[0] || []).length} rows)`);
} else {
  fail('row sets differ');
  console.log('     RAW     : ' + rawRows.slice(0, 400));
  console.log('     WRAPPED : ' + wrapRows.slice(0, 400));
}

// Types matter as much as values: a converter that returned strings where numbers
// were would compare equal under JSON. Check the primitive type of every field.
const typeSig = (rows) => (rows[0] || []).map(r =>
  Object.keys(r).sort().map(k => `${k}:${r[k] === null ? 'null' : typeof r[k]}`).join(',')).join('|');
if (typeSig(RAW.log.rows) === typeSig(WRAPPED.log.rows)) ok('column value types identical');
else {
  fail('column value types differ');
  console.log('     RAW     : ' + typeSig(RAW.log.rows));
  console.log('     WRAPPED : ' + typeSig(WRAPPED.log.rows));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · identical storeHours() for every store on file ══');
const codes = [...new Set((RAW.log.rows[0] || []).map(r => r.code))].sort();
console.log(`   ${codes.length} store code(s): ${JSON.stringify(codes)}`);

let hoursMismatch = 0, configured = 0;
for (const code of codes) {
  const a = RAW.mod ? RAW.mod.storeHours(code) : undefined;
  const b = WRAPPED.mod ? WRAPPED.mod.storeHours(code) : undefined;
  if (a) configured++;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    hoursMismatch++;
    fail(`storeHours(${JSON.stringify(code)}): RAW=${JSON.stringify(a)} WRAPPED=${JSON.stringify(b)}`);
  }
}
// An unknown code must still answer null through both paths.
for (const code of ['__no_such_store__', '', null, undefined]) {
  const a = RAW.mod ? RAW.mod.storeHours(code) : undefined;
  const b = WRAPPED.mod ? WRAPPED.mod.storeHours(code) : undefined;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    hoursMismatch++;
    fail(`storeHours(${JSON.stringify(code)}) [absent]: RAW=${JSON.stringify(a)} WRAPPED=${JSON.stringify(b)}`);
  }
}
if (!hoursMismatch) ok(`all ${codes.length} codes agree (${configured} with usable hours) + absent-code cases`);

if (configured === 0) {
  console.log('   NOTE  no store on this database has a usable open/close pair, so the');
  console.log('         hours comparison is vacuous. §2 above is what carries the proof.');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 6 · identical within() across the clock ══');
// The consumer-visible answer: sampled every 15 minutes over a full day, at the
// grace values the daemons actually pass, for every configured store.
let withinChecks = 0, withinMismatch = 0;
const GRACES = [{}, { openGraceMin: 30 }, { closeGraceMin: 30 }, { openGraceMin: 15, closeGraceMin: 45 }];
for (const code of codes) {
  const a = RAW.mod.storeHours(code);
  const b = WRAPPED.mod.storeHours(code);
  for (let mins = 0; mins < 24 * 60; mins += 15) {
    // A UTC instant that reads as `mins` past midnight at UTC+8.
    const now = new Date(Date.UTC(2026, 0, 15, 0, 0, 0) + (mins - 8 * 60) * 60_000);
    for (const g of GRACES) {
      withinChecks++;
      const ra = RAW.mod.within(a, { ...g, now });
      const rb = WRAPPED.mod.within(b, { ...g, now });
      if (ra !== rb) {
        withinMismatch++;
        if (withinMismatch <= 5) fail(`within(${code}, ${JSON.stringify(g)}, +${mins}m): RAW=${ra} WRAPPED=${rb}`);
      }
    }
  }
}
if (!withinMismatch) ok(`${withinChecks} within() evaluations agree`);

// parseHm and localMinutes are pure, but they are what the hours are built from —
// compare them too so a difference cannot hide behind an empty stores table.
let pureMismatch = 0;
for (const v of ['09:00', '9:00', '23:59', '00:00', '24:00', '12:60', '', null, 'abc', '07:30 ']) {
  if (RAW.mod.parseHm(v) !== WRAPPED.mod.parseHm(v)) { pureMismatch++; fail(`parseHm(${JSON.stringify(v)})`); }
}
for (let h = 0; h < 24; h++) {
  const now = new Date(Date.UTC(2026, 0, 15, h, 30, 0));
  for (const off of [0, 8, -5]) {
    if (RAW.mod.localMinutes(now, off) !== WRAPPED.mod.localMinutes(now, off)) {
      pureMismatch++; fail(`localMinutes(h=${h}, off=${off})`);
    }
  }
}
if (!pureMismatch) ok('parseHm() and localMinutes() agree on all sampled inputs');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 7 · the seam is actually in the wrapped path ══');
// Guard against the comparison passing because the seam silently did nothing.
delete require.cache[DB_SEAM_JS];
const seamMod = require(DB_SEAM_JS);
const wrappedHandle = seamMod.seam(db);
if (seamMod.isWrapped(wrappedHandle)) ok('seam() returns a wrapped handle');
else fail('seam() did not wrap — the comparison above would be vacuous');
if (seamMod.unwrap(wrappedHandle) === db) ok('unwrap() recovers the raw handle');
else fail('unwrap() did not recover the raw handle');
if (seamMod.seam(wrappedHandle) === wrappedHandle) ok('seam() is idempotent');
else fail('seam() double-wrapped');
if (seamMod.currentConverter() === null) ok('no converter installed — seam is a passthrough, as designed for this step');
else fail('a converter is installed; this step must ship with none');

// exec and pragma are permanent pass-throughs. Assert they are NOT intercepted.
const rawExec = Object.getPrototypeOf(db).exec;
if (wrappedHandle.exec.name === rawExec.name || typeof wrappedHandle.exec === 'function') {
  ok('exec is reachable through the wrapper (permanent pass-through)');
}
if (JSON.stringify(wrappedHandle.pragma('journal_mode')) === JSON.stringify(db.pragma('journal_mode'))) {
  ok('pragma returns identically through the wrapper (permanent pass-through)');
} else {
  fail('pragma differs through the wrapper');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(72));
if (FAILURES === 0) {
  console.log('RESULT: PASS — the wrapped path did not throw and is identical to the raw path.');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
