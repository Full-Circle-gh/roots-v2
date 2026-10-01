#!/usr/bin/env node
/**
 * §325 X9b — THE WECHAT MINI PROGRAM ON THE PHONE: ITS SETUP WIZARD, ITS
 * FINISH PAGE AND ITS CONFIGURATION.
 *
 *   node scripts/test_mobile_wechat_miniapp.js
 *
 * The desktop's Mini App pages (15-integrations.js igMiniappConfig,
 * igMiniappSetup, igMwVerifyLogin, igMwSaveMch, igMwVerifyPay, igMwFinish,
 * igMiniappConfigFull, igSaveMiniappCreds).
 *
 * What is asserted: which page opens, by the desktop's rule; every write's
 * method, path and body, against the desktop's own; each check the desktop
 * makes before sending; what each of WeChat's answers says; that no saved
 * secret is ever drawn or kept, and a typed one is sent only as typed and
 * dropped once saved; the key the server asks, and nothing sent without it;
 * refusals in place; a failed read; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const IG = fs.readFileSync(path.join(ROOT, 'public/retail-admin/15-integrations.js'), 'utf8');
const cap = require('../lib/cap-routes.js');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  slice(M, 'const PILL = {', 'const KIND2PILL'),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x6Words('),
  line(M, 'const x6En='),
  line(M, 'const x6Zh='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X9a — THE CHANNEL HUB', '/* §325 X9b ends */'),
].join('\n');

const MANAGE = ['dashboard:view', 'integrations:view', 'integrations:manage'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const CODE = (c) => { const e = new Error(c); e.code = c; return e; };
const APPID = 'wx1234567890abcdef';
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
const V3 = 'abcdefghijklmnopqrstuvwxyz012345';
/* A new account: nothing set. */
const NEW = () => ({ success: true, source: 'tenant', appId: '', appSecretSet: false,
  pay: { mchId: '', serialNo: '', apiV3KeySet: false, privateKeySet: false, platformPubKeySet: false },
  status: { wxAppIdSet: false, wechatLoginReady: false, payReady: false } });
/* A finished account — and, as a trap, the secrets themselves, which the
   server never sends; if it ever did, the phone must neither keep nor draw them. */
const DONE = () => ({ success: true, source: 'tenant', appId: APPID, appSecretSet: true, appSecret: 'LEAK-APP-SECRET',
  pay: { mchId: '1230000109', serialNo: 'SER-77', apiV3KeySet: true, privateKeySet: true, platformPubKeySet: false,
    apiV3Key: 'LEAK-V3-KEY', privateKey: 'LEAK-PRIVATE-PEM' },
  status: { wxAppIdSet: true, wechatLoginReady: true, payReady: true } });
const LEAKS = ['LEAK-APP-SECRET', 'LEAK-V3-KEY', 'LEAK-PRIVATE-PEM'];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [], pops: 0 };
  const CMD = {};
  const store = Object.assign({}, opts.ls || {});
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    state: { caps: opts.caps === undefined ? MANAGE : opts.caps, ask: null, askErr: null, stack: [{ route: 'chhub' }],
      hub: { cards: [], stores: [], tried: true, err: null, busy: null, note: {}, boxKind: null, elStores: null, elTried: false, elErr: null, shopIds: {} },
      wxm: { cfg: null, tried: false, err: null, mode: null, step: 1, d: {}, open: {}, showPub: false, busy: null, msg: null, finishAnyway: false, done: null } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); ctx.state.stack.push({ route: r }); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.canRoute=canRoute;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const s = () => ctx.state.wxm;
  const html = () => ctx.SUBS.wxmini.render();
  return { ctx, CMD, calls, text, s, html, t: () => text(html()), store };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const CFG = '/channel-hub/miniapp/wechat-config';
const CREDS = '/channel-hub/miniapp/wechat-creds';
const PAY = '/channel-hub/miniapp/wechat-pay-verify';
async function answer(h, p, v) {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
}
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function open(cfg, opts) {
  const h = mk(opts); h.CMD.wxmOpen(); h.html();
  await answer(h, CFG, cfg);
  return h;
}
const type = (h, k, v) => h.CMD.wxmIn(k, v);
/* The keys of the desktop's body object in one of its functions. */
function deskKeys(fnAnchor, bodyAnchor) {
  const f = block(IG, fnAnchor);
  const b = f.slice(f.indexOf(bodyAnchor));
  const obj = block(b, '{');
  return [...obj.matchAll(/([a-zA-Z0-9]+)\s*:/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · keys');
{
  it('each write is the server\'s key; the read is open, as the hub\'s is', () => {
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin' + CREDS), 'integrations:manage');
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin' + PAY), 'integrations:manage');
    assert.strictEqual(cap.requiredCapFor('GET', '/api/retail-admin' + CFG), null);
  });
  it('without integrations:manage: the page, read-only — no wizard, no Save, no Replace, nothing sent', async () => {
    const h = await open(NEW(), { caps: ['dashboard:view', 'integrations:view'] });
    assert.strictEqual(h.s().mode, 'full', 'the wizard is nothing but saves');
    const html = h.html();
    assert.ok(!h.t().includes('Save & verify') && !h.t().includes('Setup guide') && !h.t().includes('Get help'));
    assert.ok((html.match(/readonly/g) || []).length >= 4, 'every box read-only');
    for (const c of ['wxmSave', 'wxmLogin', 'wxmMch', 'wxmPay', 'wxmGuide']) h.CMD[c]();
    h.s().mode = 'wizard'; h.s().step = 1; type(h, 'appId', APPID); type(h, 'appSecret', 'x'); h.CMD.wxmLogin();
    assert.strictEqual(h.calls.writes.length, 0);
    const d = await open(DONE(), { caps: ['integrations:view'] });
    assert.ok(d.t().includes('•••••••• Saved') && !d.t().includes('Replace'));
  });
  it('its door: the mini program\'s card in the channel hub', () => {
    const h = mk();
    assert.strictEqual(h.ctx.hubOpenFor('wechat_miniapp'), "APP.cmd('wxmOpen')");
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.hubOpenFor('wechat_miniapp'), '');
  });
}

section('2 · which page opens (the desktop\'s igMiniappConfig)');
{
  it('a new account gets the wizard at step 1; login done, step 2; merchant id there, step 3', async () => {
    assert.ok(block(IG, 'function mwResumeStep()').includes('return 2;'));
    let h = await open(NEW());
    assert.strictEqual(h.s().mode, 'wizard'); assert.strictEqual(h.s().step, 1);
    assert.strictEqual(h.ctx.SUBS.wxmini.titleOf(), 'Set up your WeChat');
    const c2 = NEW(); c2.status.wechatLoginReady = true;
    h = await open(c2); assert.strictEqual(h.s().step, 2);
    const c3 = NEW(); c3.status.wechatLoginReady = true; c3.pay.mchId = '1230000109';
    h = await open(c3); assert.strictEqual(h.s().step, 3);
    assert.ok(h.t().includes('✓ Link mini program › ✓ Merchant account › 3. Payment keys'));
  });
  it('login and pay ready, or pay put off on this device, or the server\'s own config: the page', async () => {
    let h = await open(DONE()); assert.strictEqual(h.s().mode, 'full');
    assert.strictEqual(h.ctx.SUBS.wxmini.titleOf(), 'WeChat configuration');
    const c = NEW(); c.status.wechatLoginReady = true;
    h = await open(c, { ls: { fc_miniapp_pay_skip: '1' } }); assert.strictEqual(h.s().mode, 'full');
    assert.ok(IG.includes("const MW_SKIP_KEY = 'fc_miniapp_pay_skip'"), 'the desktop\'s own key');
    const e = NEW(); e.source = 'env';
    h = await open(e); assert.strictEqual(h.s().mode, 'full');
    assert.ok(h.t().includes('Filled from the server config for this account.') && !h.t().includes('Setup guide'));
  });
  it('a failed read', async () => {
    const h = mk(); h.CMD.wxmOpen(); h.html();
    const c = h.calls.api[0]; c.done = true; c.rej(new Error('HTTP 500')); await tick();
    assert.ok(h.t().includes('Could not load this.'));
    h.CMD.wxmRetry(); h.html();
    assert.strictEqual(h.calls.api.filter((x) => x.p === CFG).length, 2);
  });
}

section('3 · secrets');
{
  it('a saved secret is never kept or drawn: only its dots and "Saved"', async () => {
    const h = await open(DONE());
    const html = h.html(), all = JSON.stringify(h.s());
    for (const x of LEAKS) { assert.ok(!html.includes(x), 'drawn: ' + x); assert.ok(!all.includes(x), 'kept: ' + x); }
    assert.strictEqual((h.t().match(/•••••••• Saved/g) || []).length, 3, 'AppSecret, the v3 key, the private key');
    assert.ok(html.includes(`value="${APPID}"`) && html.includes('value="1230000109"') && html.includes('value="SER-77"'), 'the plain values fill in');
  });
  it('Replace opens an empty password box; Keep saved value throws away what was typed', async () => {
    const h = await open(DONE());
    h.CMD.wxmReplace('appSecret');
    const html = h.html();
    assert.ok(/<input type="password" value=""[^>]*autocomplete="new-password"[^>]*wxmIn','appSecret'/.test(html));
    type(h, 'appSecret', 'typed-secret'); h.CMD.wxmKeep('appSecret');
    assert.strictEqual(h.s().d.appSecret, '');
    assert.ok(!h.html().includes('typed-secret'));
  });
  it('the wizard\'s secret boxes are password boxes, never filled from the server', async () => {
    const c = DONE(); c.status.payReady = false;
    const h = await open(c);
    assert.strictEqual(h.s().mode, 'wizard'); assert.strictEqual(h.s().step, 3);
    const html = h.html();
    assert.ok(/<input type="password" value=""[^>]*placeholder="Saved — leave blank to keep it"/.test(html));
    for (const x of LEAKS) assert.ok(!html.includes(x));
  });
}

section('4 · the configuration page: Save & verify');
{
  it('sends the desktop\'s seven fields, a secret only as typed', async () => {
    const h = await open(DONE());
    h.CMD.wxmReplace('apiV3Key'); type(h, 'apiV3Key', '  ' + V3 + ' ');
    h.CMD.wxmSave();
    const w = W(h, 0);
    assert.strictEqual(w.p, CREDS); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { appId: APPID, appSecret: '', mchId: '1230000109', apiV3Key: V3, serialNo: 'SER-77', privateKey: '', platformPubKey: '' });
    assert.deepStrictEqual(Object.keys(w.body).sort(), deskKeys('window.igSaveMiniappCreds = async function', 'const body =').sort());
    assert.ok(h.t().includes('Verifying…'));
    w.res({ success: true, verified: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved — WeChat accepted the credentials.']);
    h.html();
    assert.strictEqual(h.calls.api.filter((x) => x.p === CFG).length, 2, 'read again, as the desktop does');
    assert.ok(h.calls.api.some((x) => x.p === '/channel-hub'), 'and the hub, as igLoad');
    await answer(h, CFG, DONE());
    assert.strictEqual(h.s().d.apiV3Key, '', 'what was typed is dropped once saved');
    assert.ok(!h.html().includes(V3));
  });
  it('saved, but WeChat said no: said in place, with WeChat\'s words', async () => {
    const h = await open(DONE());
    h.CMD.wxmSave(); W(h, 0).res({ success: true, verified: false, error: 'invalid appsecret' }); await tick();
    assert.ok(h.t().includes('Saved, but WeChat rejected the login pair: invalid appsecret'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a taken AppID, a wrong one, a refusal, and a failure, each in place', async () => {
    for (const [err, words] of [[CODE('appid_taken'), 'That AppID is already in use.'],
      [CODE('bad_appid'), 'That does not look like a Mini Program AppID.'],
      [REFUSED(), 'You don’t have permission for this'], [new Error('HTTP 500'), 'Save failed']]) {
      const h = await open(DONE());
      h.CMD.wxmReplace('appSecret'); type(h, 'appSecret', 'kept-for-retry');
      h.CMD.wxmSave(); W(h, 0).rej(err); await tick();
      assert.ok(h.t().includes(words), words);
      assert.strictEqual(h.s().d.appSecret, 'kept-for-retry', 'nothing was saved, so the box keeps what was typed');
    }
  });
  it('Setup guide reopens the wizard and forgets "later"', async () => {
    const h = await open(DONE(), { ls: { fc_miniapp_pay_skip: '1' } });
    h.CMD.wxmGuide();
    assert.strictEqual(h.s().mode, 'wizard'); assert.strictEqual(h.s().step, 3);
    assert.ok(!('fc_miniapp_pay_skip' in h.store));
  });
}

section('5 · the wizard');
{
  it('step 1 checks the AppID and the secret before sending', async () => {
    const h = await open(NEW());
    type(h, 'appId', 'wx123'); h.CMD.wxmLogin();
    assert.ok(h.t().includes('AppID should be “wx” followed by 16 letters or numbers.'));
    type(h, 'appId', APPID); h.CMD.wxmLogin();
    assert.ok(h.t().includes('Paste the AppSecret too.'));
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.html().includes('href="https://mp.weixin.qq.com"'));
  });
  it('step 1 sends {appId, appSecret}; WeChat\'s yes moves on, and the secret is gone from the page', async () => {
    const h = await open(NEW());
    type(h, 'appId', ' ' + APPID); type(h, 'appSecret', 'the-app-secret');
    h.CMD.wxmLogin();
    assert.ok(h.t().includes('Checking with WeChat…'));
    const w = W(h, 0);
    assert.strictEqual(w.p, CREDS); assert.deepStrictEqual(w.body, { appId: APPID, appSecret: 'the-app-secret' });
    assert.ok(block(IG, 'window.igMwVerifyLogin = async function').includes('body: { appId, appSecret: secret }'));
    w.res({ success: true, verified: true, creds: { wxAppIdSet: true, wechatLoginReady: true, payReady: false } }); await tick();
    assert.strictEqual(h.s().step, 2);
    assert.ok(!JSON.stringify(h.s()).includes('the-app-secret'));
    assert.ok(h.t().includes('Your WeChat Pay merchant account'));
  });
  it('step 1: WeChat\'s no is said with its words; the secret, stored anyway, is dropped', async () => {
    const h = await open(NEW());
    type(h, 'appId', APPID); type(h, 'appSecret', 'wrong-secret'); h.CMD.wxmLogin();
    W(h, 0).res({ success: true, verified: false, error: 'invalid appsecret' }); await tick();
    assert.strictEqual(h.s().step, 1);
    assert.ok(h.t().includes('WeChat did not accept this pair — check both values and try again. WeChat said: invalid appsecret'));
    assert.ok(!h.html().includes('wrong-secret'));
    assert.ok(h.html().includes('placeholder="Saved — leave blank to keep it"'));
    const t = await open(NEW());
    type(t, 'appId', APPID); type(t, 'appSecret', 's'); t.CMD.wxmLogin(); W(t, 0).rej(CODE('appid_taken')); await tick();
    assert.ok(t.t().includes('That AppID is already used by another account here.'));
  });
  it('step 2 checks the merchant id, then sends {mchId}', async () => {
    const c = NEW(); c.status.wechatLoginReady = true;
    const h = await open(c);
    type(h, 'mchId', '12ab'); h.CMD.wxmMch();
    assert.ok(h.t().includes('The merchant ID is a number, usually 10 digits.'));
    type(h, 'mchId', '1230000109'); h.CMD.wxmMch();
    const w = W(h, 0); assert.strictEqual(w.p, CREDS); assert.deepStrictEqual(w.body, { mchId: '1230000109' });
    assert.ok(block(IG, 'window.igMwSaveMch = async function').includes("body: { mchId }"));
    w.res({ success: true }); await tick();
    assert.strictEqual(h.s().step, 3);
    h.CMD.wxmBack(); assert.strictEqual(h.s().step, 2);
    assert.ok(h.html().includes('value="1230000109"'));
  });
  async function step3() {
    const c = NEW(); c.status.wechatLoginReady = true; c.pay.mchId = '1230000109';
    return open(c);
  }
  it('step 3 checks the serial, the key\'s length and the key file before sending', async () => {
    const h = await step3();
    h.CMD.wxmPay(); assert.ok(h.t().includes('Fill in the certificate serial.'));
    type(h, 'serialNo', 'SER'); h.CMD.wxmPay(); assert.ok(h.t().includes('Fill in the API v3 key.'));
    type(h, 'apiV3Key', 'short'); h.CMD.wxmPay(); assert.ok(h.t().includes('The API v3 key is exactly 32 characters — this one isn’t.'));
    type(h, 'apiV3Key', V3); h.CMD.wxmPay(); assert.ok(h.t().includes('Paste the private key file’s contents.'));
    type(h, 'privateKey', 'not a key'); h.CMD.wxmPay(); assert.ok(h.t().includes('That doesn’t look like the key file'));
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('step 3 sends the four keys; WeChat Pay\'s yes finishes: connected', async () => {
    const h = await step3();
    type(h, 'serialNo', 'SER'); type(h, 'apiV3Key', V3); type(h, 'privateKey', PEM);
    h.CMD.wxmPub(); assert.ok(h.t().includes('WeChat platform public key Optional'));
    h.CMD.wxmPay();
    const w = W(h, 0); assert.strictEqual(w.p, PAY);
    assert.deepStrictEqual(w.body, { serialNo: 'SER', apiV3Key: V3, privateKey: PEM, platformPubKey: '' });
    assert.deepStrictEqual(Object.keys(w.body), deskKeys('window.igMwVerifyPay = async function', 'const body ='));
    w.res({ success: true, verified: true, v3KeyOk: true }); await tick();
    assert.strictEqual(h.s().mode, 'done');
    const t = h.t();
    assert.ok(t.includes('✓ Your mini app is connected') && t.includes('Everything checked out with WeChat.') && t.includes('WeChat Pay ready'));
    assert.ok(!JSON.stringify(h.s()).includes(V3) && !JSON.stringify(h.s()).includes('BEGIN PRIVATE'));
    assert.ok(h.calls.api.some((x) => x.p === '/channel-hub'), 'the hub is read again');
    h.CMD.wxmFull(); h.html(); assert.strictEqual(h.s().mode, 'full');
    assert.strictEqual(h.calls.api.filter((x) => x.p === CFG).length, 2);
  });
  it('step 3: a wrong v3 key, a wrong key file, and WeChat Pay\'s own no; then Finish anyway', async () => {
    for (const [r, words] of [[{ verified: true, v3KeyOk: false }, 'Almost: WeChat accepted the merchant ID, serial and private key, but the API v3 key is wrong'],
      [{ verified: false, error: 'bad_private_key' }, 'The private key doesn’t look right'],
      [{ verified: false, error: 'missing_fields' }, 'Fill in the serial, the v3 key and the private key first.'],
      [{ verified: false, error: 'SIGN_ERROR' }, 'WeChat Pay did not accept the keys. WeChat said: SIGN_ERROR']]) {
      const h = await step3();
      type(h, 'serialNo', 'SER'); type(h, 'apiV3Key', V3); type(h, 'privateKey', PEM); h.CMD.wxmPay();
      W(h, 0).res(Object.assign({ success: true }, r)); await tick();
      assert.ok(h.t().includes(words), words);
      assert.ok(h.t().includes('Finish anyway'));
      assert.ok(!h.html().includes(V3), 'the stored key is not drawn back');
    }
    const h = await step3();
    type(h, 'serialNo', 'SER'); type(h, 'apiV3Key', V3); type(h, 'privateKey', PEM); h.CMD.wxmPay();
    W(h, 0).res({ success: true, verified: false, error: 'x' }); await tick();
    h.CMD.wxmAnyway();
    const t = h.t();
    assert.ok(t.includes('Saved — a couple of things left for later') && t.includes('WeChat Pay saved — not verified yet') && t.includes('Fix the payment keys and verify again'));
  });
  it('Do it later: on step 1 it closes; on step 2 it puts payments off, and the finish page leads back', async () => {
    let h = await open(NEW());
    h.CMD.wxmSkip(); assert.strictEqual(h.calls.pops, 1);
    const c = NEW(); c.status.wechatLoginReady = true;
    h = await open(c);
    h.CMD.wxmSkip();
    assert.strictEqual(h.store.fc_miniapp_pay_skip, '1');
    const t = h.t();
    assert.ok(t.includes('WeChat Pay — later') && t.includes('Merchant account — later') && t.includes('Add your WeChat Pay merchant ID')
      && t.includes('Add the payment keys so the store can take money') && t.includes('Until payments are set up, customers can browse and sign in but not pay.'));
    h.CMD.wxmStep(2); assert.strictEqual(h.s().mode, 'wizard'); assert.strictEqual(h.s().step, 2);
  });
  it('a refused write is said in place', async () => {
    const c = NEW(); c.status.wechatLoginReady = true;
    const h = await open(c);
    type(h, 'mchId', '1230000109'); h.CMD.wxmMch(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.t().includes('You don’t have permission for this')); assert.strictEqual(h.s().step, 2);
  });
  it('Get help asks for wechat_miniapp', async () => {
    const h = await open(NEW());
    assert.ok(h.html().includes(`APP.cmd('hubHelp','wechat_miniapp')`));
  });
}

section('6 · in Chinese');
{
  it('reads in Chinese', async () => {
    let h = await open(NEW(), { lang: 'zh' });
    for (const w of ['三个小步骤', '绑定你的小程序', '在哪里找到它们？', '打开小程序后台', '验证并继续', '稍后再做', '想直接填表？打开完整配置页']) assert.ok(h.t().includes(w), w);
    assert.strictEqual(h.ctx.SUBS.wxmini.titleOf(), '设置你的小程序');
    h = await open(DONE(), { lang: 'zh' });
    for (const w of ['小程序已绑定', '顾客登录可用', '微信支付可用', '商户号', '证书序列号', '已保存', '更换', '保存并验证', '设置向导']) assert.ok(h.t().includes(w), w);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
