#!/usr/bin/env node
'use strict';

// Tests for §251 — signing a channel back in from Tacet.
//
//   node scripts/test_channel_signin.js
//
// What is locked down, most expensive first:
//
//   1. Who may start one: the Roots account only, the capability, the store
//      scope. The daemons serve Roots and nobody else.
//   2. Who may WATCH the screen: only the person whose sign-in is running, and
//      only while it runs. A relayed screen is a live browser on a channel
//      account, and nothing but this grant stands between a tab and it.
//   3. The login trigger's API refuses anything nginx forwarded, and anything
//      that is not exactly a channel, a store code and (Eleme) a numeric shop id.
//   4. The permission exists and only the '*' roles hold it by default.
//   5. Every surface gates its button on the permission and on a cause signing
//      in can actually clear.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let passed = 0;
const failures = [];
const pending = [];
function check(name, fn) {
  const run = async () => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
  };
  pending.push(run);
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const signin = require('../lib/channel-signin');
const { ROOTS_TENANT_ID } = require('../lib/tenant-db');

// ── 1. Who may start one ────────────────────────────────────────────────────
const caller = (caps, scopeStores = null) => ({ user: { id: 7 }, caps: new Set(caps), scopeStores });
const TIANHE = { id: 1, code: 'tianhe' };

check('nobody signed in is refused', () => eq(signin.refusal(null, ROOTS_TENANT_ID, TIANHE), 'not_signed_in'));
check('another business is refused, even holding the permission', () =>
  eq(signin.refusal(caller([signin.CAP]), ROOTS_TENANT_ID + 1, TIANHE), 'wrong_account'));
check('without the permission, refused', () =>
  eq(signin.refusal(caller(['integrations:manage']), ROOTS_TENANT_ID, TIANHE), 'no_permission'));
check('a store outside the operator’s scope is refused', () =>
  eq(signin.refusal(caller([signin.CAP], [2]), ROOTS_TENANT_ID, TIANHE), 'out_of_scope'));
check('a scoped operator with no store resolved is refused, not waved through', () =>
  eq(signin.refusal(caller([signin.CAP], [1]), ROOTS_TENANT_ID, null), 'out_of_scope'));
check('permission, Roots, in scope: allowed', () => {
  eq(signin.refusal(caller([signin.CAP], [1]), ROOTS_TENANT_ID, TIANHE), null);
  eq(signin.refusal(caller([signin.CAP]), ROOTS_TENANT_ID, TIANHE), null, 'unscoped');
});

function storeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER DEFAULT 1);
           INSERT INTO retail_stores (id, code) VALUES (1, 'tianhe'), (2, 'yuexiu');
           INSERT INTO retail_stores (id, code, is_active) VALUES (3, 'closed', 0);
           CREATE TABLE eleme_shops (retail_store_id INTEGER, shop_id TEXT);
           INSERT INTO eleme_shops VALUES (1, '1234567'), (2, 'not-a-number');`);
  return db;
}
check('only a known channel and an active store resolve', () => {
  const db = storeDb();
  eq(signin.resolveStore(db, 'meituan', 'tianhe'), { id: 1, code: 'tianhe' });
  eq(signin.resolveStore(db, 'wechat', 'tianhe'), null, 'unknown channel');
  eq(signin.resolveStore(db, 'meituan', 'closed'), null, 'inactive store');
  eq(signin.resolveStore(db, 'meituan', "tianhe'; --"), null, 'a code that is not a code');
});
check('Eleme needs a numeric shop id, because its login script takes one', () => {
  const db = storeDb();
  eq(signin.resolveStore(db, 'eleme', 'tianhe'), { id: 1, code: 'tianhe', shopId: '1234567' });
  eq(signin.resolveStore(db, 'eleme', 'yuexiu'), null, 'a shop id that is not a number');
});

// ── 2. Who may watch ────────────────────────────────────────────────────────
check('only the person whose sign-in is running may watch, and only while it runs', () => {
  const t0 = 1_000_000;
  signin.grantFor(7, 'guanyi', 'tianhe', t0);
  ok(signin.mayWatch(7, t0 + 1000), 'the starter');
  ok(!signin.mayWatch(8, t0 + 1000), 'somebody else');
  ok(!signin.mayWatch(7, t0 + signin.GRANT_MS + 1), 'after the grant ran out');
  signin.grantFor(7, 'guanyi', 'tianhe', t0);
  signin.endGrant();
  ok(!signin.mayWatch(7, t0 + 1000), 'after it ended');
});

check('the relay refuses a cross-origin upgrade before it looks at anything else', () => {
  const { screenRefusal } = require('../routes/channel-signin');
  eq(screenRefusal({ headers: { host: 'store.example', origin: 'https://evil.example' }, session: {} }), 'cross_origin');
  eq(screenRefusal({ headers: { host: 'store.example' }, session: {} }), 'cross_origin', 'no Origin at all');
});

check('the relay only ever connects to loopback', () => {
  eq(signin.SCREEN.host, '127.0.0.1');
  eq(signin.TRIGGER.host, '127.0.0.1');
});

check('the server authenticates the upgrade with its own session middleware', () => {
  const src = read('server.js');
  ok(/const sessionMiddleware = session\(/.test(src), 'the session middleware is not named');
  ok(/app\.use\(sessionMiddleware\)/.test(src), 'and still mounted for every request');
  ok(/attachScreenRelay\(httpServer, sessionMiddleware\)/.test(src), 'the relay is not attached with it');
});

// ── 3. The login trigger ────────────────────────────────────────────────────
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j, body: buf }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

check('the login trigger’s API: shape-checked, loopback-only, one at a time', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // PM2_BIN=true so a "successful" login's daemon restart is a no-op here.
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'ops', 'ops-screen', 'login-trigger.js')],
    { env: { ...process.env, OPS_SCREEN_CTL_PORT: String(port), PM2_BIN: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('trigger did not start')), 5000);
      child.stdout.on('data', (d) => { if (String(d).includes('ops-screen control')) { clearTimeout(t); resolve(); } });
    });
    eq((await req(port, 'GET', '/api/status')).json, { running: null, last: null }, 'idle');
    eq((await req(port, 'GET', '/api/status', null, { 'x-real-ip': '1.2.3.4' })).status, 404, 'forwarded by nginx');
    eq((await req(port, 'POST', '/api/start', { channel: 'meituan', store: 'tianhe' }, { 'x-forwarded-for': '1.2.3.4' })).status, 404,
      'forwarded start');
    eq((await req(port, 'POST', '/api/start', { channel: 'wechat', store: 'tianhe' })).status, 400, 'unknown channel');
    eq((await req(port, 'POST', '/api/start', { channel: 'meituan', store: 'tianhe; rm -rf /' })).status, 400, 'bad store');
    eq((await req(port, 'POST', '/api/start', { channel: 'eleme', store: 'tianhe', shopId: '12a' })).status, 400, 'bad shop id');
    eq((await req(port, 'POST', '/api/start', { channel: 'eleme', store: 'tianhe' })).status, 400, 'Eleme without a shop id');
    // The old phone page is still served.
    ok(/Ops Screen/.test((await req(port, 'GET', '/')).body), 'the ops page is gone');
  } finally { child.kill(); }
});

check('the trigger restarts only the daemons that do not reload a session themselves', () => {
  const src = read('ops/ops-screen/login-trigger.js');
  ok(/meituan:\s*\{[^}]*daemon: "meituan-sync"/.test(src), 'Meituan');
  ok(/eleme:\s*\{[^}]*daemon: "eleme-sync"/.test(src), 'Eleme');
  ok(/guanyi:\s*\{[^}]*daemon: null/.test(src), 'GZ Grocery reloads by itself');
  ok(/if \(code === 0\) restartDaemon\(job\.channel\)/.test(src), 'only after a successful login');
  ok(/SIGNIN_DISPLAY/.test(src) && /launch\(`signin-/.test(src), 'Tacet’s logins run on the private display');
});

// ── 4. The permission ───────────────────────────────────────────────────────
check('the permission exists, and only the * roles hold it by default', () => {
  const caps = require('../lib/capabilities');
  ok(caps.CAPABILITIES.some((c) => c.key === signin.CAP && c.labelCn === '重新登录渠道'), 'not in the catalogue');
  const holders = Object.keys(caps.PRESETS).filter((r) => caps.presetCapsFor(r).includes(signin.CAP));
  eq(holders, ['owner'], 'roles that hold it by default');
});

// ── 5. The buttons ──────────────────────────────────────────────────────────
check('every button is gated on the permission and on a cause signing in clears', () => {
  const core = read('public/retail-admin/01-core.js');
  ok(/can\('integrations:signin'\)/.test(core), 'desktop helper ignores the permission');
  ok(/CH_SIGNIN_CAUSES = \['needs_login', 'auth_required', 'binding_lost', 'verify_required'\]/.test(core), 'desktop causes');
  const phone = read('public/m.html');
  ok(/mCan\('integrations:signin'\)/.test(phone), 'phone helper ignores the permission');
  ok(/CS_SIGNIN_CAUSES=\['needs_login','auth_required','binding_lost','verify_required'\]/.test(phone), 'phone causes');
  ok(/chSignInBtn\(ch\.key, blk\.store/.test(read('public/retail-admin/29-channel-sync.js')), 'Channel sync card');
  ok(/chSignInBtn\('guanyi'/.test(read('public/retail-admin/12-guanyi.js')), 'GZ Grocery tab');
  ok(/chSignInBtn\('eleme'/.test(read('public/retail-admin/14-eleme.js')), 'Eleme tab');
  ok(/chSignInBtn\('meituan'/.test(read('public/retail-admin/11-meituan.js')), 'Meituan tab');
  ok(/csSignInBtn\(ch\.key,ch\.blocked\)/.test(phone), 'phone card');
  ok(/can\('integrations:signin'\)/.test(read('public/retail-admin/03-dashboard.js')), 'desktop Home');
});

check('the page draws states only; every check is on the server', () => {
  const page = read('public/channel-signin.html');
  ok(/from '\/novnc\/core\/rfb\.js'/.test(page), 'noVNC is not loaded from the pinned package');
  ok(/\/api\/retail-admin\/channel-signin\/screen/.test(page), 'the page does not use the relay');
  ok(!/password|credentials:\s*\{\s*password/i.test(page), 'a VNC password in the page');
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
