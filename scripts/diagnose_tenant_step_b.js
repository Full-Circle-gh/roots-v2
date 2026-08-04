#!/usr/bin/env node
/**
 * Step B of the tenant step, verified against live data.
 *
 * Step B is two lines: tdb() and getTenantDb() now return seam(...) instead of the
 * raw handle. That moves ~1,333 statement sites — about half the in-scope
 * application — onto the covered side in one change. Everything that makes it safe
 * was built in Step A: the ALS holds raw handles via rawTenantDb()/rawTdb(), a guard
 * throws if a wrapper reaches it, and a gate enumerates every call site.
 *
 * THE PROPERTY THE WHOLE STEP TURNS ON
 * ------------------------------------
 * For every tenant, entering a scope must still identify that tenant:
 *
 *     tenantAls.run(rawTenantDb(id), () => currentTenantId()) === id
 *
 * asserted with the seam active AND with it stubbed to the identity function, so a
 * difference between the two is visible rather than assumed away. currentTenantId()
 * selects a tenant's credentials; if the flip broke it, one account would act with
 * another's WeChat and payment configuration. Nothing else in this file matters as
 * much as §3.
 *
 * WHERE THE TENANT DATABASES GO, AND WHY THAT IS SAFE HERE
 * -------------------------------------------------------
 * rawTenantDb(id) for a non-Roots id OPENS — and on first call CREATES —
 * data/tenants/<id>.db and writes schema into it. That path is resolved relative to
 * tenant-db.js's own location, so when this runs from the ro-query staging directory
 * it lands in the scratch tree, not the live one. That is asserted in §0 before any
 * non-Roots handle is opened, and the sweep refuses to run if the resolved directory
 * is inside the live application. The live roots.db itself is opened read-only and
 * proven so; only schema, never rows, is copied into the scratch tenant files.
 *
 * Run: node scripts/diagnose_tenant_step_b.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const LIVE_APP = '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

const DATABASE_JS = path.join(HOME, 'database.js');
const TENANT_DB_JS = path.join(HOME, 'lib', 'tenant-db.js');
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');

for (const f of [DATABASE_JS, TENANT_DB_JS, DB_SEAM_JS]) {
  if (!fs.existsSync(f)) { console.error('FATAL: missing ' + f); process.exit(2); }
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }
console.log('db: ' + DB_PATH);

let FAILURES = 0;
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const ok = (m) => console.log('   ok    ' + m);

// Load lib/tenant-db.js with the read-only handle standing in for database.js, so
// its `mainDb` IS that handle. `identitySeam` gives the pre-flip behaviour.
function loadTenantDb({ identitySeam }) {
  for (const id of Object.keys(require.cache)) if (id.startsWith(HOME)) delete require.cache[id];
  require.cache[DATABASE_JS] = {
    id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: db,
  };
  if (identitySeam) {
    require.cache[DB_SEAM_JS] = {
      id: DB_SEAM_JS, filename: DB_SEAM_JS, loaded: true, children: [], paths: [],
      exports: { seam: (h) => h, unwrap: (h) => h, isWrapped: () => false, currentConverter: () => null },
    };
  }
  return require(TENANT_DB_JS);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 0 · where would tenant databases be created? ══');

const TENANTS_DIR = path.resolve(path.dirname(TENANT_DB_JS), '..', 'data', 'tenants');
console.log('   resolved tenants dir: ' + TENANTS_DIR);
const insideLiveApp = TENANTS_DIR === path.join(LIVE_APP, 'data', 'tenants');
let SWEEP_NON_ROOTS = true;
if (insideLiveApp) {
  SWEEP_NON_ROOTS = false;
  console.log('   !     this is the LIVE tenants directory — non-Roots ids will NOT be opened,');
  console.log('         because doing so would create and alter real tenant databases.');
} else {
  ok('scratch location, outside the live application — safe to materialise tenant DBs');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · the flip actually happened ══');

const T = loadTenantDb({ identitySeam: false });
const { isWrapped } = require(DB_SEAM_JS);

if (isWrapped(T.getTenantDb(1))) ok('getTenantDb(1) returns a seam-wrapped handle');
else fail('getTenantDb(1) is NOT wrapped — the flip did not take effect');

if (isWrapped(T.tdb())) ok('tdb() returns a seam-wrapped handle');
else fail('tdb() is NOT wrapped — the flip did not take effect');

if (!isWrapped(T.rawTenantDb(1))) ok('rawTenantDb(1) is still RAW');
else fail('rawTenantDb(1) is wrapped — the ALS accessor must never be');

if (!isWrapped(T.rawTdb())) ok('rawTdb() is still RAW');
else fail('rawTdb() is wrapped — the ALS accessor must never be');

// Two separate calls, held in two variables: comparing the call expressions
// inline reads as a self-comparison to eslint, and it is the two RESULTS that
// must be identical — seam() caches one wrapper per raw handle, so a fresh
// object each call would mean identity comparisons elsewhere silently stop working.
const handleA = T.getTenantDb(1);
const handleB = T.getTenantDb(1);
if (handleA === handleB) ok('getTenantDb(1) has a stable identity across calls');
else fail('getTenantDb(1) returns a different object each call — seam() is not caching');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · the guard stayed quiet — no wrapper reached the ALS ══');

try {
  T.tenantAls.run(T.rawTenantDb(1), () => T.currentTenantId());
  ok('entering a scope the way the application does raises nothing');
} catch (e) { fail('the guard fired on a normal scope entry: ' + e.message); }

// And it must still bite when it should.
let bit = false;
try { T.tenantAls.run(T.getTenantDb(1), () => T.currentTenantId()); }
catch (e) { bit = /wrapped/i.test(e.message); }
if (bit) ok('the guard still refuses a wrapped handle (getTenantDb is now one)');
else fail('the guard did NOT refuse getTenantDb(1), which is wrapped after the flip');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · every tenant still identifies as itself — raw AND wrapped ══');
console.log('   tenantAls.run(rawTenantDb(id), () => currentTenantId()) === id');

let tenantRows = [];
try {
  tenantRows = db.prepare('SELECT id, COALESCE(name, ?) AS name FROM tenants ORDER BY id').all('(unnamed)');
} catch (e) {
  try { tenantRows = db.prepare('SELECT id FROM tenants ORDER BY id').all().map(r => ({ id: r.id, name: '(n/a)' })); }
  catch (e2) { fail('could not read the tenants table: ' + e2.message); }
}
console.log(`   ${tenantRows.length} tenant row(s): ${JSON.stringify(tenantRows.map(r => r.id))}`);

const RAW_T = loadTenantDb({ identitySeam: true });    // pre-flip behaviour
const WRAP_T = loadTenantDb({ identitySeam: false });  // post-flip behaviour

let swept = 0, skipped = [];
for (const row of tenantRows) {
  const id = Number(row.id);
  if (id !== 1 && !SWEEP_NON_ROOTS) { skipped.push(id); continue; }

  let rawAns, wrapAns, rawErr = null, wrapErr = null;
  try { rawAns = RAW_T.tenantAls.run(RAW_T.rawTenantDb(id), () => RAW_T.currentTenantId()); }
  catch (e) { rawErr = e; }
  try { wrapAns = WRAP_T.tenantAls.run(WRAP_T.rawTenantDb(id), () => WRAP_T.currentTenantId()); }
  catch (e) { wrapErr = e; }

  if (rawErr) { fail(`tenant ${id} (${row.name}): RAW path threw: ${rawErr.message.slice(0, 90)}`); continue; }
  if (wrapErr) { fail(`tenant ${id} (${row.name}): WRAPPED path threw: ${wrapErr.message.slice(0, 90)}`); continue; }

  swept++;
  if (rawAns !== id) fail(`tenant ${id} (${row.name}): RAW currentTenantId() = ${rawAns}, expected ${id}`);
  else if (wrapAns !== id) fail(`tenant ${id} (${row.name}): WRAPPED currentTenantId() = ${wrapAns}, expected ${id}`);
  else if (rawAns !== wrapAns) fail(`tenant ${id}: raw ${rawAns} vs wrapped ${wrapAns}`);
  else ok(`tenant ${id} (${row.name}) → ${wrapAns}, identical raw and wrapped`);
}
if (!swept) fail('no tenant was actually swept — this check proved nothing');
if (skipped.length) {
  console.log(`   !     ${skipped.length} non-Roots tenant(s) NOT swept here: ${JSON.stringify(skipped)}`);
  console.log('         opening them would create real tenant databases. Covered on the local fixture.');
}

// Unscoped and mainDb-scoped must still be Roots, through both paths.
for (const [label, fn] of [
  ['no scope', (M) => M.currentTenantId()],
  ['mainDb scope', (M) => M.tenantAls.run(db, () => M.currentTenantId())],
]) {
  const a = fn(RAW_T), b = fn(WRAP_T);
  if (a === 1 && b === 1) ok(`${label} → 1, raw and wrapped`);
  else fail(`${label}: raw ${a}, wrapped ${b}, expected 1 and 1`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · queries through the wrapped accessors return identical results ══');

const PROBES = [
  ['tenants count', 'SELECT COUNT(*) AS c FROM tenants'],
  ['stores', 'SELECT code, open_time, close_time FROM retail_stores ORDER BY code'],
  ['sqlite version', 'SELECT sqlite_version() AS v'],
];
for (const [name, sql] of PROBES) {
  let a, b, ea = null, eb = null;
  try { a = RAW_T.tdb().prepare(sql).all(); } catch (e) { ea = e; }
  try { b = WRAP_T.tdb().prepare(sql).all(); } catch (e) { eb = e; }
  if (ea || eb) { fail(`${name}: raw ${ea ? ea.message : 'ok'} / wrapped ${eb ? eb.message : 'ok'}`); continue; }
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`tdb() · ${name}: identical (${a.length} row(s))`);
  else {
    fail(`tdb() · ${name}: results differ`);
    console.log('         RAW     : ' + JSON.stringify(a).slice(0, 200));
    console.log('         WRAPPED : ' + JSON.stringify(b).slice(0, 200));
  }
  // Types, not just values.
  const sig = (rows) => rows.map(r => Object.keys(r).sort()
    .map(k => `${k}:${r[k] === null ? 'null' : typeof r[k]}`).join(',')).join('|');
  if (sig(a) !== sig(b)) fail(`tdb() · ${name}: column value types differ`);
}

// getTenantDb(1) is the same handle the application queries through.
{
  const sql = 'SELECT COUNT(*) AS c FROM tenants';
  const a = RAW_T.getTenantDb(1).prepare(sql).get();
  const b = WRAP_T.getTenantDb(1).prepare(sql).get();
  if (JSON.stringify(a) === JSON.stringify(b)) ok('getTenantDb(1) · tenants count: identical');
  else fail(`getTenantDb(1): raw ${JSON.stringify(a)} vs wrapped ${JSON.stringify(b)}`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · no converter is installed ══');
{
  delete require.cache[DB_SEAM_JS];
  const seamMod = require(DB_SEAM_JS);
  if (seamMod.currentConverter() === null) ok('seam is still a passthrough — no conversion is happening');
  else fail('a converter is installed; this step must ship with none');
}

console.log('\n' + '═'.repeat(72));
if (FAILURES === 0) {
  console.log('RESULT: PASS — tdb() and getTenantDb() are wrapped, the ALS still holds raw');
  console.log('        handles, and every swept tenant identifies as itself both ways.');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
