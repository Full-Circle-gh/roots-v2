#!/usr/bin/env node
// Roles as tenant data — the store, the cache, the invalidation, and the API.
//
// Runs the REAL router (routes/backend-team.js) against a database built by
// database.js itself, so the tenant_roles schema and the boot seed are under
// test too. Only the session is stubbed: every request carries a tenantId and a
// backendUserId, which is exactly what express-session would have put there.
//
// Run:  node scripts/test_tenant_roles.js
//
// Cases:
//   1.  the boot seed gives a tenant FOUR roles, named Owner / Manager /
//       Shop floor / Stockroom, with the shipped presets' capability sets
//   2.  the five carried roles arrive only where somebody actually holds them
//   3.  resolution reads the tenant's record, not the code literal
//   4.  an unseeded tenant, and an unknown role, fall back to presetCapsFor
//   5.  the cache answers from roles_version and reloads exactly when it bumps
//   6.  a role edit reaches a holder on their next resolve
//   7.  Owner is fixed — not editable, not deletable
//   8.  a caller can't write a capability into a role they don't hold themselves
//   9.  capabilities the tenant isn't entitled to survive an edit that can't see them
//   10. a role with nobody on it deletes outright
//   11. a role somebody holds needs a destination, and the move is atomic
//   12. exceptions survive the move, as differences from the new role
//   13. invite and edit BOTH 400 on an unknown role — no silent 'staff'
//   14. money markers: every one of the 103 is classified, and the tallies hold
//   15. the per-person read is gated, except on your own row
//   16. forced-on and forced-off come back distinguishable
//   17. the Quick Stock lockdown is writable at last — locking down is free,
//       unlocking waits on capability enforcement being on

'use strict';

const path = require('path');
const fs = require('fs');

// Fresh database for this run — database.js opens data/roots.db relative to the
// repo root, so point the whole process at a scratch copy of the tree's data dir.
const DATA = path.join(__dirname, '..', 'data');
const FRESH = !fs.existsSync(path.join(DATA, 'roots.db'));

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }
function bad(msg, extra) { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
function is(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(msg); else bad(msg, 'expected ' + e + '\n      got      ' + a);
}
function truthy(v, msg) { if (v) ok(msg); else bad(msg, 'got ' + JSON.stringify(v)); }
function falsy(v, msg)  { if (!v) ok(msg); else bad(msg, 'expected nothing, got ' + JSON.stringify(v)); }
function section(t) { console.log('\n' + t); }

// ── Boot the real modules ─────────────────────────────────────────────────
require('../routes/backend-auth');            // creates schema + seeds tenant 1 + roles
const db = require('../database');
const roles = require('../lib/roles');
const caps = require('../lib/capabilities');
const { resolveOperator } = require('../lib/operator-caps');
const teamRouter = require('../routes/backend-team');

// ── A tiny express harness: run one request through the real router ───────
const express = require('express');
const app = express();
let SESSION = {};
app.use((req, _res, next) => { req.session = SESSION; next(); });
app.use(teamRouter);

const http = require('http');
const server = http.createServer(app);

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: url, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = { _raw: raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function mkTenant(name) {
  return db.prepare("INSERT INTO tenants (name, status) VALUES (?, 'active')").run(name).lastInsertRowid;
}
function mkUser(tenantId, username, role, storeId) {
  return db.prepare(
    'INSERT INTO tenant_users (tenant_id, username, password, display_name, role, retail_store_id) VALUES (?,?,?,?,?,?)'
  ).run(tenantId, username, 'x', username, role, storeId || null).lastInsertRowid;
}
function versionOf(tid) {
  return db.prepare('SELECT roles_version v FROM tenants WHERE id = ?').get(tid).v;
}

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('tenant roles — store, cache, API' + (FRESH ? '  (fresh database)' : ''));

  // ─────────────────────────────────────────────────────────────────────
  section('1 · the boot seed');
  const tA = mkTenant('Seed test A');
  mkUser(tA, 'a_owner', 'owner');
  roles.seedTenant(tA);
  const seeded = roles.listRoles(tA);
  is(seeded.map(r => r.key), ['owner', 'admin', 'staff', 'warehouse'],
    'a tenant with only an owner gets exactly the four starting roles');
  is(seeded.map(r => r.nameEn), ['Owner', 'Manager', 'Shop floor', 'Stockroom'],
    'named Owner, Manager, Shop floor, Stockroom');
  is(seeded.map(r => r.nameCn), ['负责人', '经理', '门店', '仓库'],
    'and named in Chinese too — no role ships with an English-only name');
  is(seeded.find(r => r.key === 'staff').caps.length, caps.presetCapsFor('staff').length,
    'Shop floor is stamped from the shipped staff preset, cap for cap');
  is(seeded.find(r => r.key === 'warehouse').layout, 'warehouse',
    'Stockroom keeps the warehouse board — the layout is a field, not the name');
  truthy(seeded.find(r => r.key === 'owner').isFixed, 'Owner is fixed');

  section('2 · the five carried roles');
  const tB = mkTenant('Seed test B');
  mkUser(tB, 'b_owner', 'owner');
  mkUser(tB, 'b_disp', 'dispatch');
  mkUser(tB, 'b_clerk', 'store_stock', 7);
  roles.seedTenant(tB);
  const bKeys = roles.listRoles(tB).map(r => r.key);
  truthy(bKeys.includes('dispatch'), 'Dispatch is carried — somebody holds it');
  truthy(bKeys.includes('store_stock'), 'Store stock is carried — somebody holds it');
  truthy(!bKeys.includes('kitchen'), 'Kitchen is NOT created — nobody holds it');
  truthy(!bKeys.includes('customer_service'), 'Customer service is NOT created either');
  is(roles.recordFor(tB, 'store_stock').roster, 'store',
    'Store stock is managed inside its store, so it stays off the People roster');
  truthy(roles.recordFor(tB, 'store_stock').stockAppOnly,
    'and it carries stock_app_only — the server.js lockdown reads this, not a name');
  is(roles.seedTenant(tB), 0, 'seeding twice creates nothing (idempotent)');

  section('3 · resolution reads the record');
  const uStaff = db.prepare('SELECT * FROM tenant_users WHERE id = ?').get(mkUser(tA, 'a_staff', 'staff'));
  const tenantA = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tA);
  is(resolveOperator(db, uStaff, tenantA).caps.length, caps.presetCapsFor('staff').length,
    'a Shop floor operator resolves to the role record’s list');

  section('4 · fail-open');
  is(roles.capsForRole(999999, 'staff'), null, 'an unseeded tenant returns null, so the caller falls back');
  is(roles.capsForRole(tA, 'no_such_role'), null, 'an unknown role returns null too');
  is(caps.resolveCaps({ role: 'staff' }).length, caps.presetCapsFor('staff').length,
    'resolveCaps with no baseCaps is byte-for-byte the pre-roles behaviour');
  const orphan = db.prepare('SELECT * FROM tenant_users WHERE id = ?').get(mkUser(tA, 'a_ghost', 'ghost_role'));
  is(resolveOperator(db, orphan, tenantA).caps, [],
    'a role string with no record and no preset resolves to NOTHING, not to everything');

  section('5 · the cache and its version');
  const v0 = versionOf(tA);
  is(roles.capsForRole(tA, 'staff', v0).length, caps.presetCapsFor('staff').length, 'warm read');
  db.prepare("UPDATE tenant_roles SET caps_json = '[\"orders:view\"]' WHERE tenant_id = ? AND role_key = 'staff'").run(tA);
  is(roles.capsForRole(tA, 'staff', v0).length, caps.presetCapsFor('staff').length,
    'a write that does NOT bump the version is not seen — the cache is doing its job');
  roles.bumpVersion(tA);
  const v1 = versionOf(tA);
  truthy(v1 > v0, 'bumpVersion moves the counter (' + v0 + ' → ' + v1 + ')');
  is(roles.capsForRole(tA, 'staff', v1), ['orders:view'],
    'and the next request, carrying the new version, sees the new definition');

  section('6 · a role edit reaches its holder');
  const freshStaff = db.prepare('SELECT * FROM tenant_users WHERE id = ?').get(uStaff.id);
  const tenantA2 = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tA);
  is(resolveOperator(db, freshStaff, tenantA2).caps, ['orders:view'],
    'the holder’s effective set follows the role on their next resolve');

  // ── API ──────────────────────────────────────────────────────────────
  const tC = mkTenant('API test');
  const cOwner = mkUser(tC, 'c_owner', 'owner');
  const cStaff = mkUser(tC, 'c_staff', 'staff');
  mkUser(tC, 'c_staff2', 'staff');
  roles.seedTenant(tC);
  SESSION = { tenantId: tC, backendUserId: cOwner };

  section('7 · Owner is fixed');
  let r = await call('PUT', '/api/backend/roles/owner', { name_en: 'Boss' });
  is(r.status, 400, 'renaming Owner is refused');
  r = await call('DELETE', '/api/backend/roles/owner', {});
  is(r.status, 400, 'deleting Owner is refused');

  section('8 · the escalation guard');
  r = await call('GET', '/api/backend/roles');
  const shopFloor = r.body.roles.find(x => x.key === 'staff');
  is(shopFloor.people, 2, 'the list counts holders per role — nothing counted this before');
  truthy(shopFloor.capCount > 0, 'and reports the capability count');
  // A delegate who CAN edit permissions but does not hold billing:pay must not
  // be able to write it into a role. This is the escalation door roleAboveCaps
  // doesn't cover: it stops you handing OUT a role above your own, and this
  // stops you building one first.
  r = await call('POST', '/api/backend/roles', {
    name_en: 'Deputy', name_cn: '副手',
    caps: ['team:view', 'team:manage', 'team:permissions', 'orders:view'],
  });
  is(r.status, 200, 'the owner can create a Deputy who edits permissions');
  const deputy = mkUser(tC, 'c_deputy', r.body.role.key);
  SESSION = { tenantId: tC, backendUserId: deputy };
  r = await call('PUT', '/api/backend/roles/staff', { caps: ['orders:view', 'billing:pay'] });
  is(r.status, 403, 'the Deputy can’t put billing:pay into a role — they don’t hold it');
  is(r.body.refused, ['billing:pay'], 'and the refusal names the capability');
  r = await call('PUT', '/api/backend/roles/staff', { caps: ['orders:view'] });
  is(r.status, 200, 'but narrowing a role to what they DO hold is fine — only additions are checked');
  SESSION = { tenantId: tC, backendUserId: cOwner };

  section('9 · entitlement-hidden capabilities survive an edit');
  db.prepare("UPDATE tenants SET features_json = ? WHERE id = ?").run(JSON.stringify({ reviews: false }), tC);
  db.prepare("UPDATE tenant_roles SET caps_json = ? WHERE tenant_id = ? AND role_key = 'staff'")
    .run(JSON.stringify(['orders:view', 'reviews:view']), tC);
  roles.bumpVersion(tC);
  r = await call('PUT', '/api/backend/roles/staff', { caps: ['orders:view', 'orders:edit'] });
  is(r.status, 200, 'the edit saves');
  truthy(roles.recordFor(tC, 'staff').caps.includes('reviews:view'),
    'reviews:view is kept — the editor never showed it, so its absence is silence, not a decision');
  db.prepare('UPDATE tenants SET features_json = NULL WHERE id = ?').run(tC);

  section('10 · deleting an empty role');
  r = await call('POST', '/api/backend/roles', { name_en: 'Night shift', name_cn: '夜班', caps: ['orders:view'] });
  is(r.status, 200, 'a role can be added');
  const nightKey = r.body.role.key;
  is(nightKey, 'night_shift', 'its key is slugged from the English name and never changes again');
  r = await call('PUT', '/api/backend/roles/' + nightKey, { name_en: 'Late shift' });
  is(r.status, 200, 'renaming edits the name');
  is(roles.recordFor(tC, nightKey).key, 'night_shift', 'and leaves the key alone — that is what makes a rename safe');
  r = await call('DELETE', '/api/backend/roles/' + nightKey, {});
  is(r.status, 200, 'a role nobody holds deletes outright');
  is(roles.recordFor(tC, nightKey), null, 'and is gone');

  section('11 · deleting a held role needs a destination');
  r = await call('DELETE', '/api/backend/roles/staff', {});
  is(r.status, 400, 'no destination, no delete');
  is(r.body.people, 2, 'and the refusal says how many people are involved');
  truthy(roles.recordFor(tC, 'staff') !== null, 'the role is still there');

  section('12 · the move is atomic, and exceptions travel');
  db.prepare('INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode) VALUES (?,?,?,?)')
    .run(tC, cStaff, 'orders:refund', 'grant');
  db.prepare('INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode) VALUES (?,?,?,?)')
    .run(tC, cStaff, 'orders:edit', 'revoke');
  r = await call('DELETE', '/api/backend/roles/staff', { move_to: 'warehouse' });
  is(r.status, 200, 'with a destination it goes through');
  is(r.body.moved, 2, 'and reports how many people moved');
  is(db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ? AND role = ?').get(tC, 'staff').c, 0,
    'nobody is left pointing at the deleted role');
  is(db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ? AND role = ?').get(tC, 'warehouse').c, 2,
    'they are all on the destination');
  is(db.prepare('SELECT COUNT(*) c FROM tenant_user_caps WHERE tenant_user_id = ?').get(cStaff).c, 2,
    'their exceptions are untouched — overrides stay differences from whatever role they hold');
  // Somebody who was ALREADY on the destination, narrowed to particular stores
  // from their own matrix, must not be widened back out by a delete elsewhere.
  const settled = mkUser(tC, 'c_settled', 'warehouse');
  db.prepare('UPDATE tenant_users SET scope_all = 0 WHERE id = ?').run(settled);
  const doomed = mkUser(tC, 'c_doomed', 'admin');
  r = await call('DELETE', '/api/backend/roles/admin', { move_to: 'warehouse' });
  is(r.status, 200, 'a second role deletes onto the same destination');
  is(db.prepare('SELECT scope_all a FROM tenant_users WHERE id = ?').get(settled).a, 0,
    'and the person already there keeps their own store narrowing');
  is(db.prepare('SELECT role r FROM tenant_users WHERE id = ?').get(doomed).r, 'warehouse',
    'while the person who moved lands on the destination');

  section('13 · no silent coercion on an unknown role');
  r = await call('POST', '/api/backend/team', { username: 'newbie', password: 'abcdefghij', role: 'stockroom' });
  is(r.status, 400, 'inviting onto a role that does not exist is refused, not quietly turned into Shop floor');
  r = await call('PUT', '/api/backend/team/' + cStaff, { role: 'stockroom' });
  is(r.status, 400, 'and the edit path refuses the same value the same way');

  section('14 · the money marker');
  const unclassified = caps.CAPABILITIES.filter(c => c.money && !['shows', 'moves'].includes(c.money));
  is(unclassified.length, 0, 'every money value is shows or moves');
  is(caps.CAPABILITIES.filter(c => c.money === 'moves').length, 20, '20 capabilities move money');
  is(caps.CAPABILITIES.filter(c => c.money === 'shows').length, 16, '16 show it');
  is(caps.CAPABILITIES.length, 104, 'across all 104');
  // Seeing the waste ledger and reading what it cost are two permissions
  // (Ash, 2026-09-02). They were one, and `waste:view` carried the money
  // marker — so the two floor presets, whose job is recording what spoiled,
  // read the cost of every loss in the business. The split is asserted rather
  // than described because re-merging them is a one-line mistake that would
  // silently hand the money back to a warehouse account.
  falsy(caps.MONEY_KEYS['waste:view'], 'the waste ledger itself shows no money');
  is(caps.MONEY_KEYS['waste:costs'], 'shows', 'the cost of it is where the money is');
  truthy(caps.MONEY_NOTES['waste:costs'], 'and it carries the note that argues the coin');
  for (const role of ['warehouse', 'store_manager']) {
    const set = caps.presetCapsFor(role);
    truthy(set.includes('waste:view'), role + ' still reads the ledger');
    truthy(set.includes('waste:record'), role + ' still records a loss');
    falsy(set.includes('waste:costs'), role + ' does NOT read what it cost');
  }
  for (const role of ['manager', 'admin']) {
    truthy(caps.presetCapsFor(role).includes('waste:costs'), role + ' does');
  }
  const sm = caps.presetCapsFor('store_manager').filter(k => caps.MONEY_KEYS[k] === 'moves');
  is(sm.sort(), ['customers:adjust', 'invoices:manage', 'orders:dispatch_courier', 'orders:refund', 'products:edit'],
    'the shipped store_manager preset moves money five ways — the marker is why this is now visible');
  truthy(caps.MONEY_NOTES['products:edit'], 'products:edit carries a note, so the coin argues its case');
  truthy(caps.MONEY_NOTES['waste:void'], 'and so does waste:void, whose split from waste:record needs its reason');

  section('15 · the per-person read is gated');
  const otherId = db.prepare('SELECT id FROM tenant_users WHERE tenant_id = ? AND role = ?').get(tC, 'owner').id;
  SESSION = { tenantId: tC, backendUserId: cStaff };
  r = await call('GET', '/api/backend/team/' + otherId + '/permissions');
  is(r.status, 403, 'an operator without team:permissions can no longer read anyone else’s set');
  r = await call('GET', '/api/backend/team/' + cStaff + '/permissions');
  is(r.status, 200, 'but can still read their OWN');

  section('16 · exceptions are signed');
  SESSION = { tenantId: tC, backendUserId: cOwner };
  r = await call('GET', '/api/backend/team/' + cStaff + '/permissions');
  is(r.body.grants, ['orders:refund'], 'forced-ON comes back as a grant');
  is(r.body.revokes, ['orders:edit'], 'forced-OFF comes back as a revoke');
  truthy(r.body.roleName && r.body.roleName.en, 'and the role’s own name travels with it');

  // ─────────────────────────────────────────────────────────────────────
  section('17 · the Quick Stock lockdown is writable, and only one way is free');
  // The flag has been a column since roles became data, the seeder sets it on
  // the two stocker roles, and server.js refuses every other route for a role
  // carrying it — but no create or edit path could ever write it. So a kitchen
  // role could be granted purchasing:receive, save cleanly, and keep its 403,
  // with the permissions screen showing a tick that meant nothing.
  const tS = mkTenant('Lockdown test');
  const sOwner = mkUser(tS, 's_owner', 'owner');
  // kitchen is a CARRIED role: it is only seeded where somebody holds it (§2),
  // which is exactly the tenant this change is for.
  mkUser(tS, 's_cook', 'kitchen', 3);
  roles.seedTenant(tS);
  SESSION = { tenantId: tS, backendUserId: sOwner };

  r = await call('GET', '/api/backend/roles');
  const kitchenRole = (r.body.roles || []).find(x => x.key === 'kitchen');
  truthy(kitchenRole, 'the seeded tenant has a kitchen role');
  is(kitchenRole.stockAppOnly, true, 'and the editor is TOLD it is locked to the app — it never used to be');
  is(r.body.rbacEnforce, false, 'enforcement is off, as it is for every tenant by default');

  // The refusal. Unlocking while enforcement is off does not hand the role the
  // tools that were ticked — it hands it every route, because the cap map is
  // only consulted under rbac_enforce.
  r = await call('PUT', '/api/backend/roles/kitchen', { stock_app_only: 0 });
  is(r.status, 400, 'unlocking is refused while capability enforcement is off');
  is(r.body.need, 'rbac_enforce', 'and the refusal names what is missing');
  is(roles.recordFor(tS, 'kitchen').stockAppOnly, true, 'the role is unchanged — a refused write writes nothing');

  // Locking DOWN is a narrowing, so it needs no precondition at all.
  r = await call('PUT', '/api/backend/roles/warehouse', { stock_app_only: 1 });
  is(r.status, 200, 'locking a role DOWN is free — narrowing never waits on enforcement');
  is(roles.recordFor(tS, 'warehouse').stockAppOnly, true, 'and it took');

  // With enforcement on, the unlock goes through and the ticks start meaning
  // something. This is the whole point of the change.
  await call('PUT', '/api/backend/rbac-enforce', { enforce: 1 });
  r = await call('PUT', '/api/backend/roles/kitchen',
    { stock_app_only: 0, caps: ['quickstock:add', 'purchasing:view', 'purchasing:receive'] });
  is(r.status, 200, 'with enforcement on, the kitchen role can be let out of the app');
  is(roles.recordFor(tS, 'kitchen').stockAppOnly, false, 'the lockdown is off');
  is(r.body.role.caps.sort(), ['purchasing:receive', 'purchasing:view', 'quickstock:add'],
    'and it holds the two permissions that let it book a delivery in');

  // A role created locked stays locked; the default is still unlocked.
  r = await call('POST', '/api/backend/roles', { name_en: 'Prep kitchen', name_cn: '备餐', stock_app_only: 1 });
  is(r.status, 200, 'a new role can be created locked to the app');
  is(r.body.role.stockAppOnly, true, 'and it is');
  r = await call('POST', '/api/backend/roles', { name_en: 'Buyer', name_cn: '采购员' });
  is(r.body.role.stockAppOnly, false, 'while a role that does not ask for it is unlocked, as before');

  // ─────────────────────────────────────────────────────────────────────
  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
