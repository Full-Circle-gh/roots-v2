#!/usr/bin/env node
/**
 * §325 step S2g — A STORE'S STOCK-STAFF SIGN-INS NEED A PERMISSION.
 *
 *   node scripts/test_store_staff_gates.js
 *
 * /api/backend/stores/:storeId/staff (routes/backend-team.js) adds, removes
 * and resets the password of a store's stock clerks. It sat behind a signed-in
 * session and nothing else, so anyone in the back office could mint or reset a
 * sign-in for any store in the shop. The three writes now take any of the keys
 * that open a screen making them today: the Settings tab's (Operations →
 * Stores draws "Stock staff" with no gate of its own), stores:edit and
 * team:manage (the phone's). The list stays open, as the Team roster does.
 *
 * The real router over a scratch database, real sessions, each operator's keys
 * real tenant_user_caps grants resolved the way requireCap resolves them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { storeStaffCap } = require(path.join(ROOT, 'lib', 'cap-routes'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const STORE = 1;
db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, 'tianhe', 'Tianhe', '天河', 1, 1)`).run(STORE);
let nextId = 7800;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2g_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
}
operator('orders', ['orders:view', 'orders:edit']);
operator('nothing', []);
operator('settingsShop', ['settings:shop']);
operator('storesView', ['stores:view']);
operator('storesEdit', ['stores:edit']);
operator('teamManage', ['team:manage']);
operator('owner', [], 'owner');

let clerkSeq = 0;
function clerk() {
  return Number(db.prepare(`INSERT INTO tenant_users (tenant_id, username, password, role, retail_store_id, is_active)
              VALUES (?, ?, 'old-hash', 'store_stock', ?, 1)`).run(TENANT, '__s2g_clerk' + (++clerkSeq), STORE).lastInsertRowid);
}
const row = (id) => db.prepare('SELECT is_active, password FROM tenant_users WHERE id = ?').get(id);

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')), tenantId: TENANT }; next(); });
  app.use(require(path.join(ROOT, 'routes', 'backend-team.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, method, p, body) => {
    const r = await fetch(base + '/api/backend/stores/' + STORE + '/staff' + p, {
      method, headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let n = 0;
  const add = (who) => call(who, 'POST', '', { display_name: 'Clerk', username: '__s2g_new' + (++n), password: 'long-enough-pw' });
  const madeCount = () => db.prepare("SELECT COUNT(*) AS c FROM tenant_users WHERE username LIKE '__s2g_new%'").get().c;

  try {
    section('1 · the rule');
    const need = storeStaffCap();
    for (const k of ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config', 'delivery:view', 'stores:edit', 'team:manage']) {
      ok(need.includes(k), 'admits ' + k);
    }
    ok(!need.includes('orders:edit') && !need.includes('quickstock:recount'), 'and not an orders or a stock-count key');
    const SRC = read('routes/backend-team.js');
    ok(/router\.get\('\/api\/backend\/stores\/:storeId\/staff', requireBackend,/.test(SRC), 'the list stays a plain signed-in read');
    for (const re of [/router\.post\('\/api\/backend\/stores\/:storeId\/staff', requireStoreStaffWrite,/,
      /router\.delete\('\/api\/backend\/stores\/:storeId\/staff\/:userId', requireStoreStaffWrite,/,
      /router\.post\('\/api\/backend\/stores\/:storeId\/staff\/:userId\/password', requireStoreStaffWrite,/]) {
      ok(re.test(SRC), 'gated: ' + re.source.slice(14, 70).replace(/\\/g, ''));
    }

    section('2 · refused: an account that can open no screen making these writes');
    for (const who of ['orders', 'nothing']) {
      let r = await add(who);
      is(r.status, 403, `${who}: adding a clerk is refused`);
      is(madeCount(), 0, '…and no sign-in was made');
      const c = clerk();
      r = await call(who, 'POST', '/' + c + '/password', { new_password: 'another-long-pw' });
      is(r.status, 403, `${who}: resetting a clerk's password is refused`);
      is(row(c).password, 'old-hash', '…and the password is unchanged');
      r = await call(who, 'DELETE', '/' + c);
      is(r.status, 403, `${who}: removing a clerk is refused`);
      is(row(c).is_active, 1, '…and the clerk is still active');
    }

    section('3 · let through: every screen that makes them today, and the owner');
    for (const who of ['settingsShop', 'storesView', 'storesEdit', 'teamManage', 'owner']) {
      const before = madeCount();
      let r = await add(who);
      is(r.status, 200, `${who}: adds a clerk`);
      is(madeCount(), before + 1, '…and the sign-in exists');
      const c = clerk();
      r = await call(who, 'POST', '/' + c + '/password', { new_password: 'another-long-pw' });
      is(r.status, 200, `${who}: resets a password`);
      ok(row(c).password !== 'old-hash', '…which changed');
      r = await call(who, 'DELETE', '/' + c);
      is(r.status, 200, `${who}: removes a clerk`);
      is(row(c).is_active, 0, '…who is deactivated, history kept');
    }

    section('4 · the list stays open, as the Team roster does');
    const r = await call('orders', 'GET', '');
    is(r.status, 200, 'an orders account still reads the list');
    ok(Array.isArray(r.body && r.body.staff), '…and gets the staff');
    const unauth = await fetch(base + '/api/backend/stores/' + STORE + '/staff', { headers: { 'x-op': '0' } });
    is(unauth.status, 401, 'nobody signed in still gets 401');

    section('5 · the callers');
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = d + '/' + e.name;
      if (e.isDirectory()) walk(rel); else if (/\.(html|js)$/.test(e.name)) files.push(rel);
    } };
    walk('public');
    const callers = files.filter((f) => /stores\/\$\{storeId\}\/staff|backend\/stores\/'\s*\+[^;\n]*'\/staff|\/staff'/.test(read(f)) && /backend\/stores/.test(read(f)));
    ok(callers.includes('public/retail-admin/02-settings-ops.js'), 'the desktop Operations → Stores panel calls them');
    ok(callers.every((f) => ['public/retail-admin/02-settings-ops.js', 'public/m.html'].includes(f)),
      'and nothing else but the phone does', callers.join(', '));
    const OPS = read('public/retail-admin/02-settings-ops.js');
    ok(/<button class="btn" onclick="_opsStoreStaff\(\$\{s\.id\}\)">/.test(OPS), 'its "Stock staff" button carries no gate of its own');
    const html = read('public/retail-admin.html');
    const at = html.indexOf('id="ops-store-staff"');
    ok(at > 0 && /id="sub-ops"/.test(html.slice(html.lastIndexOf('class="sub-panel', at), html.lastIndexOf('class="sub-panel', at) + 60)),
      '…and sits in Settings → Operations, which opens on the Settings keys');
    const M = read('public/m.html');
    if (/backend\/stores/.test(M) && /\/staff/.test(M)) {
      ok(/mCan\(\['stores:edit','team:manage'\]\)|mCan\('stores:edit'\)\s*\|\|\s*mCan\('team:manage'\)/.test(M),
        'the phone draws it for stores:edit or team:manage, both admitted');
    }
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
