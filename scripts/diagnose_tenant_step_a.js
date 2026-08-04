#!/usr/bin/env node
/**
 * Step A of the tenant step, verified against live data.
 *
 * Step A introduced the raw accessors (rawTenantDb / rawTdb), a guarded ALS facade,
 * and made currentTenantId() throw instead of guessing. Its only intended behaviour
 * change was that throw, and that branch is unreachable in normal operation.
 *
 * STEP B HAS SINCE LANDED, so tdb() and getTenantDb() now return seam-wrapped
 * handles. This file's §1 was updated to assert the invariants that survive that —
 * the raw accessors staying raw — rather than the "nothing is wrapped" checks it
 * originally carried. The wrapping itself is asserted by
 * scripts/diagnose_tenant_step_b.js.
 *
 * WHAT CHANGED, EXACTLY
 * ---------------------
 * Before:  return dbToId.get(store) || ROOTS_TENANT_ID;
 * After:   an unidentifiable scope throws instead of answering "Roots".
 *
 * The old fallback turned a handle this module never created into a confident
 * wrong answer, and currentTenantId() selects a tenant's credentials. The two
 * legitimate paths to Roots — no scope at all, and a scope explicitly entered with
 * mainDb — are unchanged and are asserted here to still return 1.
 *
 * The database is opened read-only and PROVEN read-only. database.js is never
 * executed; it is replaced in the module cache by the read-only handle, which also
 * makes it play the role of mainDb inside tenant-db.js.
 *
 * NOT EXERCISED HERE, DELIBERATELY: rawTenantDb(id) for id >= 2. That opens (and
 * on first call CREATES) data/tenants/<id>.db and runs DDL into it. A read-only
 * diagnostic must not do that on the live box. Non-Roots identification is covered
 * on a local fixture instead; on live there is only Roots and TENANT_DATA_ISOLATION
 * is off, so no other tenant handle can enter the ALS in production today.
 *
 * Run: node scripts/diagnose_tenant_step_a.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
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

// Load tenant-db with the read-only handle standing in for database.js, so the
// module's `mainDb` IS that handle and identity comparisons behave normally.
for (const id of [DATABASE_JS, TENANT_DB_JS, DB_SEAM_JS]) delete require.cache[id];
require.cache[DATABASE_JS] = {
  id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: db,
};
const T = require(TENANT_DB_JS);
const { seam, isWrapped } = require(DB_SEAM_JS);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · Step A\'s durable invariants — still true after the Step B flip ══');
// This section originally asserted that NOTHING was wrapped, which was Step A's
// whole point. Step B has since wrapped tdb() and getTenantDb() deliberately, so
// those assertions were retired rather than left to fail. What remains is what must
// hold in every step: the raw accessors stay raw, and the ALS holds raw handles.
// scripts/diagnose_tenant_step_b.js asserts the wrapping itself.

if (typeof T.rawTenantDb === 'function') ok('rawTenantDb() is exported');
else fail('rawTenantDb() is not exported');

if (typeof T.rawTdb === 'function') ok('rawTdb() is exported');
else fail('rawTdb() is not exported');

if (T.rawTenantDb(1) === db) ok('rawTenantDb(1) is the raw shared handle');
else fail('rawTenantDb(1) is not the raw shared handle — the ALS accessor must never be wrapped');

if (!isWrapped(T.rawTenantDb(1))) ok('rawTenantDb(1) is not seam-wrapped');
else fail('rawTenantDb(1) IS seam-wrapped — the ALS would receive a wrapper');

if (T.rawTdb() === db) ok('rawTdb() returns the raw handle outside a scope');
else fail('rawTdb() is not the raw handle outside a scope');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · the two legitimate routes to Roots still answer 1 ══');
console.log('   (these are the paths normal operation actually takes)');

try {
  const v = T.currentTenantId();
  if (v === 1) ok('no scope at all → 1 (public endpoints, module load, daemons)');
  else fail(`no scope → ${v}, expected 1`);
} catch (e) { fail('no scope THREW: ' + e.message); }

try {
  const v = T.tenantAls.run(db, () => T.currentTenantId());
  if (v === 1) ok('scope entered with mainDb → 1 (every Roots request today)');
  else fail(`mainDb scope → ${v}, expected 1`);
} catch (e) { fail('mainDb scope THREW: ' + e.message); }

try {
  const v = T.tenantAls.run(T.rawTenantDb(1), () => T.currentTenantId());
  if (v === 1) ok('scope entered with rawTenantDb(1) → 1');
  else fail(`rawTenantDb(1) scope → ${v}, expected 1`);
} catch (e) { fail('rawTenantDb(1) scope THREW: ' + e.message); }

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · the new throw — an unidentifiable scope is refused, not guessed ══');

const strayPath = path.join(os.tmpdir(), `tenant-step-a-${process.pid}.db`);
let stray = null;
try {
  try { fs.unlinkSync(strayPath); } catch (_) { /* fresh anyway */ }
  stray = new Database(strayPath);

  let threw = null, value;
  try { value = T.tenantAls.run(stray, () => T.currentTenantId()); }
  catch (e) { threw = e; }

  if (threw) {
    ok('a handle tenant-db never handed out now THROWS: ' + threw.message.slice(0, 80) + '…');
  } else {
    fail(`an unidentifiable scope returned ${value} instead of throwing — this is the old ` +
         'silent fallback, and it is the behaviour this step exists to remove');
  }

  // The guard on the facade: a wrapped handle must never enter the ALS.
  let guardThrew = null;
  try { T.tenantAls.run(seam(db), () => T.currentTenantId()); }
  catch (e) { guardThrew = e; }
  if (guardThrew && /wrapped/i.test(guardThrew.message)) {
    ok('tenantAls.run() refuses a seam-wrapped handle');
  } else if (guardThrew) {
    fail('tenantAls.run() threw, but not the guard message: ' + guardThrew.message.slice(0, 90));
  } else {
    fail('tenantAls.run() ACCEPTED a wrapped handle — the guard is not working, and Step B ' +
         'would put wrappers into the ALS silently');
  }
} finally {
  try { if (stray) stray.close(); } catch (_) { /* best effort */ }
  try { fs.unlinkSync(strayPath); } catch (_) { /* best effort */ }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · what could reach the throw in normal operation ══');

// Every handle that can legitimately enter the ALS comes from rawTenantDb(), which
// is the sole writer of dbToId — so anything it hands out is identifiable. The
// throw is reachable only for a handle created elsewhere. Enumerate who could do
// that: openTenantDb() is exported, and a direct `new Database(...)` is possible.
const strayProducers = [];
for (const dir of ['routes', 'lib', 'middleware', 'scripts']) {
  const abs = path.join(HOME, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith('.js')) continue;
    const rel = `${dir}/${f}`;
    const src = fs.readFileSync(path.join(HOME, rel), 'utf8');
    if (!/tenantAls\s*\.\s*run\s*\(/.test(src)) continue;
    if (/openTenantDb\s*\(/.test(src) || /new\s+Database\s*\(/.test(src)) strayProducers.push(rel);
  }
}
if (strayProducers.length) {
  console.log('   files that both enter the ALS and can create a handle themselves:');
  for (const f of strayProducers) console.log(`     - ${f}`);
  console.log('   These are the only places the throw can originate. Each must be checked by hand.');
} else {
  ok('no file both enters the ALS and creates its own handle');
}

console.log('\n' + '═'.repeat(72));
if (FAILURES === 0) {
  console.log('RESULT: PASS — the raw accessors are still raw, Roots resolves to 1 by both');
  console.log('        routes, and an unidentifiable scope is refused instead of guessed.');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
