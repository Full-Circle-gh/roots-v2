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

// ── §260: a holder browser (闪购) ──────────────────────────────────────────
// The 越秀 Meituan store's stock goes through the 闪购 holder browser. Sign in
// for it must reach THAT browser's screen, never run the 外卖 login.
check('a 闪购 store resolves to the holder job and the holder’s own screen', () => {
  const db = storeDb();
  const st = signin.resolveStore(db, 'meituan', 'yuexiu');
  eq(st, { id: 2, code: 'yuexiu', job: 'shangou' }, 'the 闪购 store');
  eq(signin.jobChannel('meituan', st), 'shangou', 'the trigger is asked for');
  eq(signin.jobChannel('meituan', signin.resolveStore(db, 'meituan', 'tianhe')), 'meituan', 'a 外卖 store');
  eq(signin.screenFor('shangou'), { host: '127.0.0.1', port: 5902 }, 'the holder’s screen');
  eq(signin.screenFor('meituan'), signin.SCREEN, 'a login script’s screen');
  eq(signin.resolveStore(db, 'shangou', 'yuexiu'), null, 'the job name is not a channel a caller may send');
});

check('the relay shows the screen of the sign-in its grant is for', () => {
  const { screenOf } = require('../routes/channel-signin');
  eq(screenOf(null), signin.SCREEN, 'no grant');
  // screenOf reads the live Roots database; the store rows it needs are the
  // real ones, so only the mapping is asserted here, not the port per store.
  const src = read('routes/channel-signin.js');
  ok(/const screen = screenOf\(signin\.liveGrant\(\)\);/.test(src), 'the upgrade does not pick the screen from the grant');
  ok(/const vnc = net\.connect\(screen\);/.test(src), 'the pipe does not connect to that screen');
});

check('Done is only for a holder, and only for the person watching', () => {
  const src = read('routes/channel-signin.js');
  const fin = src.slice(src.indexOf("'/api/retail-admin/channel-signin/finish'"));
  ok(/const g = gate\(req, res, channel, code\);/.test(fin), 'finish skips the gate');
  ok(/if \(!g\.store\.job\) return res\.status\(400\)/.test(fin), 'finish accepts a non-holder');
  ok(/if \(!signin\.mayWatch\(g\.caller\.user\.id\)\) return res\.status\(409\)/.test(fin), 'finish accepts someone not watching');
});

check('the trigger runs a holder session: Done, the login page left, never a script', async () => {
  // A stand-in for the holder Chrome's /json/list.
  let tabs = [{ type: 'page', url: 'https://shangoue.meituan.com/' }];
  const cdp = http.createServer((q, r) => { r.end(JSON.stringify(tabs)); });
  await new Promise((res) => cdp.listen(0, '127.0.0.1', res));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'ops', 'ops-screen', 'login-trigger.js')],
    { env: { ...process.env, OPS_SCREEN_CTL_PORT: String(port), PM2_BIN: 'true', SHANGOU_CDP_PORT: String(cdp.address().port) },
      stdio: ['ignore', 'pipe', 'pipe'] });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('trigger did not start')), 5000);
      child.stdout.on('data', (d) => { if (String(d).includes('ops-screen control')) { clearTimeout(t); resolve(); } });
    });
    // Done ends it, and it is a success.
    eq((await req(port, 'POST', '/api/start', { channel: 'shangou', store: 'yuexiu' })).status, 200, 'start');
    const st = (await req(port, 'GET', '/api/status')).json;
    eq([st.running.channel, st.running.store, st.running.holder], ['shangou', 'yuexiu', true], 'the running session');
    eq((await req(port, 'POST', '/api/finish', { channel: 'shangou', store: 'tianhe' })).status, 409, 'Done for another store');
    eq((await req(port, 'POST', '/api/finish', { channel: 'shangou', store: 'yuexiu' })).status, 200, 'Done');
    const after = (await req(port, 'GET', '/api/status')).json;
    eq([after.running, after.last.ok, after.last.holder], [null, true, true], 'after Done');
    eq((await req(port, 'POST', '/api/finish', { channel: 'shangou', store: 'yuexiu' })).status, 409, 'Done twice');
    // Leaving the login page ends it too, without Done.
    tabs = [{ type: 'page', url: 'https://waimaie.meituan.com/logon/login_gw' }];
    eq((await req(port, 'POST', '/api/start', { channel: 'shangou', store: 'yuexiu' })).status, 200, 'second start');
    await sleep(3500);
    ok((await req(port, 'GET', '/api/status')).json.running, 'ended while still on the login page');
    tabs = [{ type: 'page', url: 'https://shangoue.meituan.com/#/home' }];
    await sleep(3500);
    const auto = (await req(port, 'GET', '/api/status')).json;
    eq([auto.running, auto.last.ok], [null, true], 'after the login page was left');
    // A holder job carries no script; a finish for a login script is refused.
    ok(!/scripts\/shangou-login/.test(read('ops/ops-screen/login-trigger.js')), 'a holder runs a script');
  } finally { child.kill(); cdp.close(); }
});

check('a timed-out holder session does not restart the daemon', () => {
  const src = read('ops/ops-screen/login-trigger.js');
  ok(/setTimeout\(\(\) => endHolder\(me, false\), LOCK_MS\)/.test(src), 'no lock on a holder session');
  ok(/if \(ok\) restartScript\(HOLDERS\[session\.channel\]\.daemonScript\)/.test(src), 'the restart is not gated on success');
});

check('the 闪购 daemon says signed-in on start, only for a sign-in fault', () => {
  const src = read('scripts/shangou-daemon.js');
  ok(/const SIGNIN_FAULTS = \['needs_login', 'verify_required'\];/.test(src), 'the faults it re-checks');
  ok(/if \(!block \|\| !SIGNIN_FAULTS\.includes\(block\.by\)\) return;/.test(src), 'it touches a store with no such fault');
  ok(/logSync\(storeCode, 'login_restored', 'ok'/.test(src), 'it does not log the recovery');
  // After the proxy and warm-up gates: never a call into a cold browser.
  const loop = src.slice(src.indexOf('async function main()'));
  ok(loop.indexOf('coldMsRemaining') < loop.indexOf('confirmSignedIn('), 'checked before the warm-up gate');
  // And login_restored is a Meituan clearing event, so the block does clear.
  ok(require('../lib/channel-block').CHANNELS.meituan.clearing.includes('login_restored'), 'not a clearing event');
});

check('the 闪购 holder draws on the display .env names, else the one it inherits', () => {
  const src = read('scripts/shangou-chrome.js');
  ok(/process\.env\.SHANGOU_DISPLAY\s*\?\s*\{ \.\.\.process\.env, DISPLAY: process\.env\.SHANGOU_DISPLAY \}\s*:\s*process\.env/.test(src), 'the display rule');
  ok(/spawn\(exe, args, \{ stdio: 'inherit', env: CHROME_ENV \}\)/.test(src), 'Chrome is not launched with it');
});

check('the page offers Done for a holder and says signed in only when the block clears', () => {
  const page = read('public/channel-signin.html');
  ok(/holder = !!r\.json\.holder;/.test(page), 'the page does not learn it is a holder');
  ok(/\/api\/retail-admin\/channel-signin\/finish/.test(page), 'Done does not call finish');
  ok(/if \(!s\.blocked\) \{\s*finished = true;\s*end\(S\.done, 'ok', false\);/.test(page), 'success is not the block clearing');
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
