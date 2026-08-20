#!/usr/bin/env node
//
// g20-categories.js — the first execution of application code against Postgres.
//
// ══ WHAT THIS IS ═════════════════════════════════════════════════════════
// G20 says no checkout, and no code of any kind, has ever run against the
// Postgres cluster. This is the smallest thing that changes that sentence.
//
// It runs ONE statement — the body of GET /api/retail/categories — through the
// real chain: lib/db-driver selects the driver, database.js returns the alien
// pooled handle, lib/tenant-db's tdb() hands it back, lib/db-seam passes it
// through, and the statement executes on the cluster. It then serialises the
// result exactly as express's res.json() would and prints the sha256, so the
// body can be compared byte-for-byte with what the live SQLite app serves.
//
// The statement it runs, verbatim from routes/retail.js:341:
//
//     SELECT id, name FROM categories WHERE kind = 'product' ORDER BY sort_order, name
//
// ══ WHY THIS SHAPE, AND NOT A ROUTE ══════════════════════════════════════
// The route cannot run yet, and the reason is not the 800 unconverted call
// sites. `routes/retail.js` requires `lib/tenant-creds` at load, and that file
// calls `mainDb.exec(...)` at MODULE LOAD — one of ELEVEN top-level `.exec()`
// calls across ten files. Under Postgres the handle is deliberately alien and
// has no `.exec`, so the require throws before any handler is reached. The same
// file is reached from server.js:281, 631 lines before app.listen(), so the
// whole application cannot boot on Postgres either.
//
// This probe's load-time closure is four modules and contains none of them:
//
//     database.js  ->  lib/db-driver, lib/pg, lib/pg-handle
//     lib/tenant-db.js  ->  database.js, lib/db-seam
//
// So it runs today, against production, with ZERO changes to application code.
// That is the whole point: an instrument before a conversion, not alongside it.
//
// ══ IT REFUSES TO RUN ON SQLITE, AND THAT IS A SAFETY PROPERTY ═══════════
// Requiring database.js WITHOUT TACET_DB=postgres does not just read — it opens
// data/roots.db, sets pragmas, execs schema.sql and runs 305 addColumn()
// migrations. On the production box that is a WRITE to the live database, from
// a probe whose entire job is to be read-only. So this file refuses.
//
// The SQLite half of the comparison comes from curl against the running app,
// never from re-opening the file. See --expect below.
//
// ══ USAGE ════════════════════════════════════════════════════════════════
//   TACET_DB=postgres node g20-categories.js
//   TACET_DB=postgres node g20-categories.js --expect <sha256-of-the-sqlite-body>
//   TACET_DB=postgres node g20-categories.js --json      (body only, no banner)
//
//   TACET_APP=/root/roots-v2   where the application lives. Defaults to the
//                              repo root two levels up, then /root/roots-v2.
//
// EXIT  0 ran, and matched --expect if one was given
//       1 ran, and did NOT match --expect
//       2 could not run at all (refused, misconfigured, or the query failed)
//
// ══ WHERE THIS FILE LIVES, AND WHY IT IS NOT IN scripts/ ═════════════════
// The deploy allowlist is public/ routes/ lib/ middleware/ scripts/ plus
// server.js, database.js, schema.sql and the two package files. A file under
// scripts/ therefore SHIPS AND BOUNCES pm2 — a production restart, to install a
// diagnostic. eval/ is outside the allowlist, so this is committed and recorded
// but never deployed. To run it on the box, copy it there by hand; it requires
// the application by absolute path and needs nothing from its own directory.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const JSON_ONLY = has('--json');

// Banner goes to stderr when --json is set, so stdout carries the body alone and
// can be piped into sha256sum without a second serialisation deciding anything.
const say = (s) => (JSON_ONLY ? console.error(s) : console.log(s));
const die = (s) => { console.error(s); process.exit(2); };

// ── Where the application lives ──────────────────────────────────────────
const APP = process.env.TACET_APP
  || [path.resolve(__dirname, '..', '..'), '/root/roots-v2']
    .find((p) => fs.existsSync(path.join(p, 'database.js')))
  || '/root/roots-v2';

if (!fs.existsSync(path.join(APP, 'database.js'))) {
  die(`[g20] no database.js under ${APP}. Set TACET_APP to the application root.`);
}

// ── The .env loader ──────────────────────────────────────────────────────
// Same shape as scripts/health-watchdog.js envVal(): an existing process.env
// value wins, otherwise the key is read out of .env with a per-key regex and
// surrounding quotes are stripped.
//
// THIS IS THE WHOLE REASON THE PROBE NEEDS ONE. The .env parser lives inside
// server.js as an IIFE, so it runs for the server and for nothing else. A plain
// node process — this one, cron, or an ssh command — sees no TACET_PG_* at all,
// and lib/pg throws at load rather than connecting to a guess. That gap is why
// `node scripts/check_ledger_invariants.js --pg` exits 2 on the box today.
const ENV_FILE = path.join(APP, '.env');
let ENV_TEXT = '';
try { ENV_TEXT = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) { /* no .env */ }

function envVal(key) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  const m = ENV_TEXT.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+)\\s*$', 'm'));
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, '').trim();
}

// Hoisted into process.env BEFORE database.js is required, because lib/db-driver
// and lib/pg both read process.env once at module load.
const NEEDED = [
  'TACET_DB',
  'TACET_PG_HOST', 'TACET_PG_DATABASE', 'TACET_PG_USER',
  'TACET_PG_PASSWORD', 'TACET_PG_PORT', 'TACET_PG_APPNAME',
];
const fromEnvFile = [];
for (const k of NEEDED) {
  const had = process.env[k] != null && process.env[k] !== '';
  const v = envVal(k);
  if (v !== undefined) process.env[k] = v;
  if (!had && v !== undefined) fromEnvFile.push(k);
}
// Name this process in pg_stat_activity so a connection from a probe is
// distinguishable from one from the application, in the logs and to anyone
// watching the cluster while it runs.
if (!process.env.TACET_PG_APPNAME) process.env.TACET_PG_APPNAME = 'g20-probe';

// ── REFUSE ON SQLITE ─────────────────────────────────────────────────────
// Before anything is required. See the header: requiring database.js on the
// SQLite path runs schema.sql and 305 addColumn() migrations against the live
// file, which is a write, from a read-only probe, on production.
const driverAsked = String(process.env.TACET_DB || '').trim().toLowerCase();
if (driverAsked !== 'postgres') {
  die(
    `[g20] REFUSING TO RUN: TACET_DB is ${driverAsked ? JSON.stringify(driverAsked) : 'not set'}, not "postgres".\n` +
    '  This probe only runs on the Postgres path, on purpose. Requiring database.js on the\n' +
    '  SQLite path opens data/roots.db and runs schema.sql plus 305 addColumn() migrations —\n' +
    '  writes, against the live database, from a probe whose whole job is to be read-only.\n' +
    '  The SQLite half of the comparison comes from curl against the running app instead:\n' +
    '    curl -s http://127.0.0.1:4000/api/retail/categories | sha256sum'
  );
}

say('── G20 probe — first application code against Postgres ──');
say(`  app root : ${APP}`);
say(`  .env     : ${ENV_TEXT ? ENV_FILE : '(none found — relying on process.env)'}`);
say(`  from .env: ${fromEnvFile.length ? fromEnvFile.join(', ') : '(nothing — all were already in process.env)'}`);

// ── The real chain ───────────────────────────────────────────────────────
// Required in this order and no other. database.js prints the [db-driver] line
// as a side effect of its own require, which is the boot line the runbook's flip
// step asserts on — so it appears in this output too, for the same reason.
let tdb;
try {
  require(path.join(APP, 'database.js'));            // selects the driver, builds the pooled handle
  ({ tdb } = require(path.join(APP, 'lib', 'tenant-db.js')));
} catch (e) {
  die(`[g20] could not load the application database layer:\n  ${e.message}`);
}

const handle = tdb();
say(`  handle   : driver=${handle.driver} ${handle.description}`);
if (handle.driver !== 'postgres') {
  die(`[g20] tdb() returned a ${handle.driver} handle. Refusing to report a Postgres result from it.`);
}
// The alien-shape contract, checked here rather than assumed. If any of these
// ever appear, lib/pg-handle's guarantee has been broken and every unconverted
// call site silently receives a Promise instead of a row.
for (const n of ['prepare', 'exec', 'transaction', 'pragma']) {
  if (n in handle) die(`[g20] the handle exposes .${n} — see the header of lib/pg-handle.js. Refusing.`);
}

// The statement. Copied verbatim from routes/retail.js — no parameters, no
// dynamic fragments, so what this exercises is knowable by reading it.
const SQL = "SELECT id, name FROM categories WHERE kind = 'product' ORDER BY sort_order, name";

(async () => {
  let rows;
  const t0 = process.hrtime.bigint();
  try {
    const result = await handle.query(SQL);
    rows = result.rows;
  } catch (e) {
    console.error(`[g20] the statement FAILED on Postgres:\n  ${e.message}`);
    console.error(`  sql: ${SQL}`);
    await end();
    process.exit(2);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  // Serialised exactly as the route does it: res.json({ success: true, data: rows }).
  // express calls JSON.stringify with no spacing unless `json spaces` is set, and
  // it is not. So this is the same bytes the route would put on the wire.
  const body = JSON.stringify({ success: true, data: rows });
  const sha = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  say(`  statement: ${SQL}`);
  say(`  rows     : ${rows.length}   (${ms.toFixed(1)} ms)`);
  say(`  bytes    : ${Buffer.byteLength(body, 'utf8')}`);
  say(`  sha256   : ${sha}`);

  if (JSON_ONLY) process.stdout.write(body);
  else say(`  body     : ${body.length > 220 ? body.slice(0, 220) + '…' : body}`);

  const expect = valueOf('--expect');
  let code = 0;
  if (expect) {
    const want = expect.trim().toLowerCase();
    if (want === sha) {
      say('');
      say(`  MATCH — Postgres returned the same ${Buffer.byteLength(body, 'utf8')} bytes SQLite serves.`);
    } else {
      say('');
      say('  MISMATCH');
      say(`    expected (sqlite) : ${want}`);
      say(`    got      (postgres): ${sha}`);
      say('    A mismatch is NOT automatically a driver fault. The Postgres copy is the');
      say('    2026-08-04 rehearsal and drifts; a category added since then differs here');
      say('    for that reason alone. Compare the bodies before concluding anything.');
      code = 1;
    }
  }

  await end();
  process.exitCode = code;
})();

// The pool holds the process open. database.js exports the handle, not the pool,
// so the pool is reached through lib/pg — the same module instance out of the
// require cache, not a second one.
async function end() {
  try { await require(path.join(APP, 'lib', 'pg.js')).pool.end(); } catch (_) { /* already closed */ }
}
