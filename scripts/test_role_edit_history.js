#!/usr/bin/env node
// A role's version history — decisions §279, server half.
//
// The role screen has no Save button any more: every edit is a PUT after a
// short pause. Its way back is lib/edit-history.js, written around that PUT in
// routes/backend-team.js. Runs the REAL router against a database built by
// database.js, like scripts/test_tenant_roles.js; only the session is stubbed.
// The client half (the footer, the engine, Undo) is in
// scripts/test_role_editor_client.js.
//
// Run:  node scripts/test_role_edit_history.js
//
// Cases:
//   1. the first save lays down the Original, then the edit
//   2. a burst of autosaves from one person is ONE version, not forty
//   3. an Undo is its own version, and is never folded into, nor folds
//   4. the list is newest first and says what each version changed
//   5. a restore puts the old version back, and is itself a version
//   6. another tenant's role of the same name has its own history
//   7. deleting a role takes its history with it
//   8. nothing is recorded for a save that changed nothing

'use strict';

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }
function bad(msg, extra) { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
function is(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(msg); else bad(msg, 'expected ' + e + '\n      got      ' + a);
}
function section(t) { console.log('\n' + t); }

require('../routes/backend-auth');            // creates schema + seeds roles
const db = require('../database');
const roles = require('../lib/roles');
const teamRouter = require('../routes/backend-team');

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

function mkTenant(name) {
  return db.prepare("INSERT INTO tenants (name, status) VALUES (?, 'active')").run(name).lastInsertRowid;
}
function mkUser(tenantId, username, role) {
  return db.prepare(
    'INSERT INTO tenant_users (tenant_id, username, password, display_name, role) VALUES (?,?,?,?,?)'
  ).run(tenantId, username, 'x', username, role).lastInsertRowid;
}
const history = async key => (await call('GET', '/api/backend/roles/' + key + '/history')).body.versions || [];

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('role edit history — §279');

  const tA = mkTenant('History test A');
  const owner = mkUser(tA, 'h_owner', 'owner');
  mkUser(tA, 'h_staff', 'staff');
  roles.seedTenant(tA);
  SESSION = { tenantId: tA, backendUserId: owner };
  const before = roles.recordFor(tA, 'staff');

  section('1 · the first save lays down the Original');
  is((await history('staff')).length, 0, 'a role nobody has edited has no history yet');
  let r = await call('PUT', '/api/backend/roles/staff', { desc_en: 'Tills and the floor' });
  is(r.status, 200, 'the save goes through');
  let v = await history('staff');
  is(v.length, 2, 'two versions: the Original and the edit');
  is(v[1].isBaseline, true, 'the older one is the Original');
  is(v[1].snapshot.descEn, before.descEn || '', 'holding the description as it was');
  is(v[0].snapshot.descEn, 'Tills and the floor', 'the newer one holds the edit');
  is(v[0].by, 'h_owner', 'and says who made it');

  section('2 · a burst of autosaves is one version');
  for (const d of ['Tills and the floor, ', 'Tills and the floor, and', 'Tills and the floor, and the door']) {
    await call('PUT', '/api/backend/roles/staff', { desc_en: d });
  }
  v = await history('staff');
  is(v.length, 2, 'still two versions after three more saves in a row');
  is(v[0].snapshot.descEn, 'Tills and the floor, and the door', 'the one version holds where the typing ended');

  section('3 · an Undo is its own version');
  r = await call('PUT', '/api/backend/roles/staff', { desc_en: before.descEn || '', history_note: 'undo' });
  is(r.status, 200, 'the undo goes through');
  v = await history('staff');
  is(v.length, 3, 'it is a new version, not folded into the edit it took back');
  is(v[0].note, 'undo', 'marked as an undo');
  is(v[1].snapshot.descEn, 'Tills and the floor, and the door', 'so the edit it took back is still there to restore');
  await call('PUT', '/api/backend/roles/staff', { desc_en: 'After the undo' });
  v = await history('staff');
  is(v.length, 4, 'and the next edit does not fold into the undo either');
  r = await call('PUT', '/api/backend/roles/staff', { desc_en: 'After the undo', history_note: 'rewrite' });
  is(r.status, 200, 'an unknown note is ignored, not refused');

  section('4 · what each version changed');
  await call('PUT', '/api/backend/roles/staff', { name_en: 'Floor', caps: before.caps.filter(k => k !== 'orders:view') });
  v = await history('staff');
  is(v[0].changed.name, true, 'the name change is named');
  is(v[0].changed.removed, 1, 'one permission taken away is counted');
  is(v[0].changed.added, 0, 'and nothing counted as added');
  is(v[v.length - 1].isBaseline, true, 'newest first, the Original last');

  section('5 · a restore');
  const orig = v[v.length - 1].snapshot;
  r = await call('PUT', '/api/backend/roles/staff', {
    name_en: orig.nameEn, name_cn: orig.nameCn, desc_en: orig.descEn, desc_cn: orig.descCn,
    layout: orig.layout, caps: orig.caps, dashboard_cards: orig.dashboardCards, history_note: 'restore',
  });
  is(r.status, 200, 'the restore goes through');
  const now = roles.recordFor(tA, 'staff');
  is(now.nameEn, before.nameEn, 'the name is back');
  is([...now.caps].sort(), [...before.caps].sort(), 'every permission is back');
  v = await history('staff');
  is(v[0].note, 'restore', 'and the restore is itself a version');
  is(v[1].snapshot.nameEn, 'Floor', 'so what it replaced can be restored in turn');

  section('6 · another tenant, same role name, its own history');
  const tB = mkTenant('History test B');
  const ownerB = mkUser(tB, 'hb_owner', 'owner');
  roles.seedTenant(tB);
  SESSION = { tenantId: tB, backendUserId: ownerB };
  is((await history('staff')).length, 0, 'tenant B sees none of tenant A’s versions');
  SESSION = { tenantId: tA, backendUserId: owner };

  section('7 · deleting a role takes its history with it');
  r = await call('POST', '/api/backend/roles', { name_en: 'Weekend', caps: [] });
  const wk = r.body.role.key;
  await call('PUT', '/api/backend/roles/' + wk, { desc_en: 'Saturdays' });
  is((await history(wk)).length, 2, 'the new role has its two versions');
  r = await call('DELETE', '/api/backend/roles/' + wk, {});
  is(r.status, 200, 'it deletes');
  is(db.prepare("SELECT COUNT(*) c FROM edit_history WHERE tenant_id = ? AND entity_type = 'role' AND entity_key = ?").get(tA, wk).c, 0,
    'and no history is left behind for a new role to inherit');

  section('8 · a save that changed nothing records nothing');
  const n0 = (await history('staff')).length;
  await call('PUT', '/api/backend/roles/staff', { desc_en: roles.recordFor(tA, 'staff').descEn || '' });
  is((await history('staff')).length, n0, 'no new version');

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
