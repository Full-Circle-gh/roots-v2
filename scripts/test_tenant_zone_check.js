#!/usr/bin/env node
/**
 * test_tenant_zone_check.js — a tenant with no timezone is named loudly at
 * every start, and the server still starts (decisions §82).
 *
 *   node scripts/test_tenant_zone_check.js
 *
 * WHAT IT GUARDS. §82 rules that a tenant with no zone must fail loudly at
 * startup rather than quietly run on Guangzhou's clock. Every tenant shares one
 * process, so the ruling is applied as loud about the ONE tenant — a log line
 * naming it and an alert to its group — never the server going down. Production
 * on 2026-10-17: Roots, the one real tenant, has no zone at all.
 *
 * HOW. lib/tenant-zone-check.js runs over the REAL tenants, retail_stores and
 * storefront_config tables (routes/backend-auth.js and database.js) in memory.
 * The alert is a recorder. Last, the server is checked to run it at start inside
 * a try, so a check that throws cannot stop the boot.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'backend-auth.js'), 'utf8');
const check = require(path.join(ROOT, 'lib', 'tenant-zone-check'));

const mainDb = addTables(openMemoryDb(), AUTH_SRC, AUTH_SRC, ['tenants']);
const DBS = new Map();
function tenant(id, name, { status = 'active', storeZones = [], shopTz } = {}) {
  mainDb.prepare('INSERT INTO tenants (id, name, status) VALUES (?, ?, ?)').run(id, name, status);
  const db = addTables(openMemoryDb(), DB_SRC, DB_SRC, ['retail_stores', 'storefront_config']);
  storeZones.forEach((tz, i) => db.prepare(
    "INSERT INTO retail_stores (code, name_en, name_cn, is_active, timezone) VALUES (?, ?, ?, 1, ?)")
    .run('s' + id + '_' + i, 'Store ' + i, '店' + i, tz));
  if (shopTz !== undefined) db.prepare("INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', ?)").run(JSON.stringify(shopTz));
  DBS.set(id, db);
}
function reset() { mainDb.exec('DELETE FROM tenants'); DBS.clear(); }
const getTenantDb = (id) => { if (!DBS.has(id)) throw new Error('no database for tenant ' + id); return DBS.get(id); };
function run() {
  const logged = { log: [], warn: [], error: [] };
  const log = { log: (s) => logged.log.push(s), warn: (s) => logged.warn.push(s), error: (s) => logged.error.push(s) };
  const alerts = [];
  const found = check.runAtStartup({ mainDb, getTenantDb, log, alert: (id, text) => { alerts.push([id, text]); return Promise.resolve(true); } });
  return { found, logged, alerts };
}

let pass = 0, fail = 0;
function it(name, fn) {
  reset();
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. which zones count');
it('a real zone is fine; nothing, blank or a misspelling is not', () => {
  assert.strictEqual(check.zoneProblem('Asia/Shanghai'), null);
  assert.strictEqual(check.zoneProblem('Europe/London'), null);
  assert.strictEqual(check.zoneProblem(null), 'missing');
  assert.strictEqual(check.zoneProblem('  '), 'missing');
  assert.strictEqual(check.zoneProblem('Asia/Shangai'), 'invalid');
});

console.log('\n2. what is reported');
it('production today: Roots, two stores, no zone anywhere — named, logged and paged', () => {
  tenant(1, 'Roots', { storeZones: [null, null] });
  const { found, logged, alerts } = run();
  assert.deepStrictEqual(found.map((f) => [f.tenantId, f.problem]), [[1, 'missing']]);
  assert.strictEqual(logged.error.length, 1);
  assert.ok(/\[tz\] ⛔ tenant 1 "Roots" HAS NO TIMEZONE/.test(logged.error[0]), logged.error[0]);
  assert.ok(/Asia\/Shanghai by default/.test(logged.error[0]), 'it says what the tenant is running on meanwhile');
  assert.deepStrictEqual(alerts.map((a) => a[0]), [1], 'one alert, to that tenant');
});
it('a zone on a store is enough', () => {
  tenant(1, 'Roots', { storeZones: ['Asia/Shanghai', null] });
  const { found, logged, alerts } = run();
  assert.deepStrictEqual(found, []);
  assert.deepStrictEqual(logged.error, []);
  assert.deepStrictEqual(alerts, []);
  assert.ok(/every active tenant has a readable timezone/.test(logged.log[0]));
});
it('so is the tenant-wide shop.timezone a sign-up seeds, before any store exists', () => {
  tenant(8, 'New shop', { shopTz: 'Europe/London' });
  assert.deepStrictEqual(run().found, []);
});
it('a misspelt zone is reported, not quietly read as Guangzhou', () => {
  tenant(1, 'Roots', { storeZones: ['Asia/Shangai'] });
  const { found } = run();
  assert.deepStrictEqual(found.map((f) => f.problem), ['invalid']);
  assert.ok(/Asia\/Shangai/.test(found[0].detail));
});
it('a second store\'s bad zone is caught even when the first store\'s is good', () => {
  tenant(1, 'Roots', { storeZones: ['Asia/Shanghai', 'Asia/Guangzhou'] });
  const { found } = run();
  assert.deepStrictEqual(found.map((f) => f.problem), ['invalid']);
  assert.ok(/Asia\/Guangzhou/.test(found[0].detail), found[0].detail);
});
it('each tenant is judged on its own: one good, one missing, one suspended (ignored)', () => {
  tenant(1, 'Roots', { storeZones: ['Asia/Shanghai'] });
  tenant(8, 'No zone yet');
  tenant(9, 'Closed down', { status: 'suspended' });
  const { found, alerts } = run();
  assert.deepStrictEqual(found.map((f) => f.tenantId), [8]);
  assert.deepStrictEqual(alerts.map((a) => a[0]), [8]);
});

console.log('\n3. it never stops the server');
it('a tenant whose database cannot be opened is reported, and the rest are still checked', () => {
  tenant(1, 'Roots');
  mainDb.prepare("INSERT INTO tenants (id, name, status) VALUES (7, 'Gone', 'active')").run();
  const { found } = run();
  assert.deepStrictEqual(found.map((f) => [f.tenantId, f.problem]), [[1, 'missing'], [7, 'unreadable']]);
});
it('A CHECK WRITES NOTHING: a tenant with no database file is reported, and never opened (opening creates one)', () => {
  tenant(1, 'Roots', { storeZones: ['Asia/Shanghai'] });
  mainDb.prepare("INSERT INTO tenants (id, name, status) VALUES (7, 'Never provisioned', 'active')").run();
  const opened = [];
  const found = check.checkTenantZones({ mainDb, getTenantDb: (id) => { opened.push(id); return getTenantDb(id); },
    hasTenantDb: (id) => DBS.has(id) });
  assert.deepStrictEqual(found.map((f) => [f.tenantId, f.problem, f.detail]), [[7, 'unreadable', 'it has no database file']]);
  assert.deepStrictEqual(opened, [1], 'only the tenant whose file exists was opened');
});
it('the server answers "has a file" without opening: Roots is the main database, anyone else by path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(/hasTenantDb: \(id\) => Number\(id\) === tenantDb\.ROOTS_TENANT_ID \|\| fs\.existsSync\(tenantDb\.pathForTenant\(id\)\)/.test(src));
});
it('a check that cannot run at all says it was skipped and returns', () => {
  const warned = [];
  const r = check.runAtStartup({ mainDb: { prepare() { throw new Error('no tenants table'); } }, getTenantDb,
    log: { log() {}, warn: (s) => warned.push(s), error() {} }, alert: () => Promise.resolve() });
  assert.strictEqual(r, null);
  assert.ok(/\[tz\] tenant timezone check skipped: no tenants table/.test(warned[0]), warned[0]);
});
it('an alert that throws or rejects does not stop it either', () => {
  tenant(1, 'Roots');
  tenant(8, 'Other');
  const errs = [];
  const found = check.runAtStartup({ mainDb, getTenantDb, log: { log() {}, warn() {}, error: (s) => errs.push(s) },
    alert: (id) => { if (id === 1) throw new Error('webhook down'); return Promise.reject(new Error('later')); } });
  assert.strictEqual(found.length, 2);
  assert.strictEqual(errs.length, 2, 'both tenants still logged');
});
it('the server runs it at every start, inside a try, after listen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const listen = src.indexOf('app.listen(PORT');
  const at = src.indexOf("require('./lib/tenant-zone-check').runAtStartup(");
  assert.ok(listen > 0 && at > listen, 'called inside the listen callback');
  const before = src.slice(Math.max(0, at - 200), at);
  assert.ok(/try \{\s*$/.test(before), 'wrapped in a try, so a throw cannot stop the boot');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
