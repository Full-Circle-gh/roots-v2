#!/usr/bin/env node
'use strict';

// Tests for §252 — signing a channel back in from Tacet.
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

// First live use, 2026-09-24: Ash pressed Sign in, closed the tab, and the
// warehouse — granted the permission to finish it — was told "someone is
// already signing in" for minutes. The login window was still open and was
// exactly the one they needed.
check('a press joins the login already open for the same channel and store', () => {
  eq(signin.startDecision(null, 'eleme', 'tianhe'), 'start', 'nothing running');
  eq(signin.startDecision({ channel: 'eleme', store: 'tianhe' }, 'eleme', 'tianhe'), 'join', 'same channel and store');
  eq(signin.startDecision({ channel: 'eleme', store: 'yuexiu' }, 'eleme', 'tianhe'), 'busy', 'another store');
  eq(signin.startDecision({ channel: 'meituan', store: 'tianhe' }, 'eleme', 'tianhe'), 'busy', 'another channel');
});
check('taking a sign-in over hands the screen to the new person and off the old one', () => {
  signin.grantFor(7, 'eleme', 'tianhe');
  signin.grantFor(9, 'eleme', 'tianhe');
  ok(signin.mayWatch(9), 'the person who joined');
  ok(!signin.mayWatch(7), 'the person who left');
  signin.endGrant();
});
check('the start route asks what is running, not whose grant is live', () => {
  const src = read('routes/channel-signin.js');
  ok(/signin\.startDecision\(st\.json\.running/.test(src), 'start does not decide from the trigger');
  ok(!/live\.userId !== g\.caller\.user\.id/.test(src), 'a live grant alone still blocks the next person');
  ok(/signin\.mayWatch\(userId\)/.test(src), 'an open relay does not close when its viewer is replaced');
});

// Ash, the same day: both channel cards read "Not syncing since…" and only the
// small print said Eleme was signed out.
check('a stopped channel’s headline names the cause a person can act on', () => {
  const vm = require('vm');
  const core = read('public/retail-admin/01-core.js');
  const fn = core.slice(core.indexOf('function chHeadState'), core.indexOf('window.chHeadState'));
  const ctx = {}; vm.runInNewContext(fn + ';this.f=chHeadState;', ctx);
  for (const by of ['needs_login', 'auth_required', 'binding_lost']) eq(ctx.f(by), ['signed out', '已退出登录'], by);
  eq(ctx.f('verify_required'), ['waiting for a captcha', '需要人工验证']);
  eq(ctx.f('queue_stalled'), null, 'a stalled queue stays "not syncing"');
  const page = read('public/retail-admin/29-channel-sync.js');
  ok(/filter\(ch => ch\.stale \|\| ch\.blocked\)/.test(page), 'the summary ignores a signed-out channel whose queue has not stalled');
  ok(/Signed out since \$\{at\}/.test(page), 'the card headline');
  ok(/function csHeadline\(ch\)/.test(read('public/m.html')) && /\$\{csHeadline\(ch\)\}/.test(read('public/m.html')), 'the phone card title');
});

// §256 — Alibaba's slider rejected every human drag on the Eleme login inside a
// Playwright-launched window; the login now opens a genuine Chrome and attaches
// only after the dashboard is reached.
check('the Eleme login opens a genuine Chrome and attaches only after login', () => {
  const src = read('scripts/eleme-login.js');
  ok(/launchGenuineChrome\(/.test(src), 'the login does not use the genuine Chrome');
  ok(!/new ElemeBrowser|\.init\(\{ headed/.test(src), 'the login still launches a Playwright browser');
  const watch = src.indexOf('listTabs(port)'), attach = src.indexOf('connectOverCDP(');
  ok(watch !== -1 && attach > watch, 'the login attaches before it has seen the dashboard');
  ok(/process\.exit\(ok \? 0 : 1\)/.test(src), 'the trigger reads the exit code to decide success');
  const lib = read('lib/genuine-chrome.js');
  ok(!/chromium\.launch\(/.test(lib), 'the genuine Chrome is launched through Playwright');
  ok(/\/json\/list/.test(lib), 'the tab list is not read from Chrome’s own HTTP listing');
});

// §257 — the Integrations wizard stored a merchant's channel password for a
// login no driver could ever run. The password steps and their endpoints are
// gone, and a one-off deletes what they stored.
check('no screen or endpoint takes a channel password any more', () => {
  const ui = read('public/retail-admin/15-integrations.js');
  ok(!/id="rl_pass"|igRelayStart|igRelaySms|session\/start|session\/sms/.test(ui), 'the wizard still asks for a password');
  ok(/igRelayBoxRequest/.test(ui), 'the box request went with it, and it should have stayed');
  const route = read('routes/integrations-admin.js');
  ok(!/session\/start|session\/sms|relay\.startLogin|relay\.submitSms/.test(route), 'an endpoint still takes a password');
  const relay = require('../lib/integrations/session-relay');
  ok(!relay.startLogin && !relay.submitSms && !relay.registerDriver, 'the login driver is still exported');
  ok(typeof relay.summary === 'function', 'the cards lost their session read');
  const wipe = read('scripts/oneoff_wipe_relay_channel_passwords.js');
  ok(/\^\(meituan\|qingyun\)\\\.\[a-z0-9\]/.test(wipe), 'the wipe does not target only the per-store family');
});

// The 越秀 Meituan store is served by 闪购, whose faults land in the Meituan
// log; Sign in runs the 外卖 login, which cannot clear them.
check('a Meituan store served by 闪购 is never offered or granted Sign in', () => {
  const db = storeDb();
  eq(signin.resolveStore(db, 'meituan', 'yuexiu'), null, 'the server grants it');
  const items = require('../lib/channel-sync-items');
  const sdb = new Database(':memory:');
  sdb.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, name_cn TEXT, name_en TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
    INSERT INTO retail_stores (id, code) VALUES (1, 'tianhe'), (2, 'yuexiu');
    CREATE TABLE channel_status (channel TEXT, store_code TEXT, is_open INTEGER);
    CREATE TABLE store_business_status (store_code TEXT PRIMARY KEY, is_open INTEGER, target_open INTEGER, fulfillment_open INTEGER);
    CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE meituan_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, event_type TEXT, status TEXT, detail TEXT, error_msg TEXT, created_at TEXT);
    INSERT INTO meituan_sync_log (store_code, event_type, status, created_at) VALUES ('yuexiu', 'needs_login', 'error', '2026-09-24 01:00:00');`);
  const mt = items.channelBlocks(sdb).find((c) => c.key === 'meituan');
  eq([mt.blocked.store, mt.blocked.signable], ['yuexiu', false], 'the block does not say Sign in cannot clear it');
  ok(/if \(signable === false\) return '';/.test(read('public/retail-admin/01-core.js')), 'the desktop button ignores it');
  ok(/blk\.signable===false/.test(read('public/m.html')), 'the phone button ignores it');
  ok(/b\.blocked\.signable !== false/.test(read('public/retail-admin/03-dashboard.js')), 'the Home button ignores it');
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
  // The Home row can name two channels above one button; the button says which.
  ok(/cuT\(`Sign in to \$\{chName\(signable\.key\)\}`, `重新登录\$\{chName\(signable\.key\)\}`\)/
    .test(read('public/retail-admin/03-dashboard.js')), 'the Home button does not name its channel');
});

check('the Meituan tab no longer offers the relay wizard, which cannot sign anyone in', () => {
  // §250 PR 4. The wizard fails in production with `no_worker_attached` — no
  // login-relay driver is registered — so it was a button that could not do
  // what it said, on the one line an operator reads during an outage.
  ok(!/igRelayWizard/.test(read('public/retail-admin/11-meituan.js')), 'the Meituan tab still reaches for the wizard');
});

check('the page draws states only; every check is on the server', () => {
  const page = read('public/channel-signin.html');
  ok(/import\('\/novnc\/core\/rfb\.js'\)/.test(page), 'noVNC is not loaded from the pinned package');
  // The deploy's installer runs this exact checker on every staged .html and
  // aborts on a failure — a static `import` in the inline script did exactly
  // that to the first deploy of this page.
  const r = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'check-html-js.js'), path.join(__dirname, '..', 'public', 'channel-signin.html')], { encoding: 'utf8' });
  eq(r.status, 0, `the deploy's inline-script gate rejects the page: ${r.stdout}${r.stderr}`);
  ok(/\/api\/retail-admin\/channel-signin\/screen/.test(page), 'the page does not use the relay');
  ok(!/password|credentials:\s*\{\s*password/i.test(page), 'a VNC password in the page');
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
