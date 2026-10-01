#!/usr/bin/env node
/**
 * §325 S1a — A PERMISSION REFUSAL NO LONGER LOGS THE PHONE OUT.
 *
 *   node scripts/test_mobile_refusal_not_logout.js
 *
 * `api()`, `apiRaw()` and `apiWrite()` in public/m.html sent every 403 to
 * /backend/login exactly as they sent a 401, so with permissions switched on a
 * refused tap threw a shift worker out of the app. Only a 401 means the session
 * is gone now; a 403 becomes an error that the caller shows in words.
 *
 * The code is RUN, sliced out of public/m.html into a sandbox with a fake
 * fetch. No browser — fast shard. What it pins:
 *   1. 401 still goes to the login page, from all three helpers and both uploads;
 *   2. 403 does not — it throws the refusal, with the server's code and body;
 *   3. the words: forbidden_capability / forbidden_store are the desktop's own
 *      (01-core.js TD_ERR), a bilingual server sentence is kept, and a 403 that
 *      says nothing gets lib/require-cap.js's own pair;
 *   4. callers say it where the operator is looking — the order sheet, a review
 *      switch, the media upload — and their busy flags come back;
 *   5. no write's catch answers a refusal with "did not save — try again".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const REQCAP = fs.readFileSync(path.join(ROOT, 'lib/require-cap.js'), 'utf8');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(from, to) {
  const a = M.indexOf(from);
  const b = M.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
  return M.slice(a, b);
}
const SRC = [
  slice("const API='/api/retail-admin';", '/* The surface\'s language picks'),
  slice('async function apiRaw(path){', '/* The roster is ordered'),
  slice('async function apiWrite(path, body, method){', 'function orderErrorText(e){'),
  slice('function orderErrorText(e){', '/* printer.* is private config'),
  slice('function revWrite(r,visible){', '/* Mark a feedback thread handled'),
  slice('const MEDIA_ERR={', '/* The Affiliate screen used to state'),
].join('\n');

const EN_CAP = 'Your role does not include this action. An owner can grant it on the Team page.';
const ZH_CAP = '你的角色不包含此操作。可由负责人在团队页授权。';
const EN_STORE = 'You can only do that in a location you are assigned to.';
const ZH_STORE = '只能在你被分配的门店执行该操作。';

function res(status, body) {
  return { status, ok: status >= 200 && status < 300,
    json: async () => { if (body === undefined) throw new Error('no body'); return body; } };
}
function mk(opts = {}) {
  const calls = { fetches: [], toasts: [], renders: 0, refreshed: 0, media: 0 };
  const CMD = {};
  const queue = (opts.answers || []).slice();
  const ctx = {
    LANG: opts.lang || 'en',
    location: { href: '/m' },
    state: { orderBusy: null, orderErr: null, revBusy: null, revErr: null, mediaBusy: null, mediaErr: null, media: [], mediaTried: true },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    refreshOrders: () => { calls.refreshed++; },
    loadMedia: () => { calls.media++; },
    revKey: (r) => 'r' + r.id,
    mCan: () => true,   // every key held: this suite is about the server's refusal, S1b's about the client's
    FormData: class { append() {} },
    fetch: async (u, o) => {
      calls.fetches.push({ u, method: (o && o.method) || 'GET', body: o && o.body });
      const a = queue.length ? queue.shift() : opts.answer;
      return res(a[0], a[1]);
    },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Date, URLSearchParams, setImmediate,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
async function caught(p) { try { await p; } catch (e) { return e; } throw new Error('did not throw'); }

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · a 401 is a lost session: the login page, as before');
{
  for (const [name, call] of [
    ['api()', (c) => c.api('/orders')],
    ['apiRaw()', (c) => c.apiRaw('/orders')],
    ['apiWrite()', (c) => c.apiWrite('/orders/7/status', { status: 'paid' }, 'PATCH')],
  ]) {
    it(name + ' sends a 401 to /backend/login and throws "auth"', async () => {
      const h = mk({ answer: [401, { error: 'Not authenticated' }] });
      const e = await caught(call(h.ctx));
      assert.strictEqual(e.message, 'auth');
      assert.strictEqual(h.ctx.location.href, '/backend/login');
    });
  }
  it('the server answers a lost session with 401, which is what the phone reads', () => {
    assert.ok(/return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\);/.test(RETAIL));
  });
  it('the media upload sends a 401 to the login page', async () => {
    const h = mk({ answer: [401, {}] });
    await h.ctx.uploadMedia([{ type: 'image/jpeg' }]);
    assert.strictEqual(h.ctx.location.href, '/backend/login');
  });
}

section('2 · a 403 is a refusal: no login page, an error with the reason');
{
  for (const [name, call] of [
    ['api()', (c) => c.api('/stores/3/stock')],
    ['apiRaw()', (c) => c.apiRaw('/stores/3/stock')],
    ['apiWrite()', (c) => c.apiWrite('/orders/7/refund/approve', {})],
  ]) {
    it(name + ' stays on the page and throws the refusal', async () => {
      const h = mk({ answer: [403, { error: 'forbidden_capability', need: 'orders:refund' }] });
      const e = await caught(call(h.ctx));
      assert.strictEqual(h.ctx.location.href, '/m', 'it left for the login page');
      assert.strictEqual(e.message, EN_CAP);
      assert.strictEqual(e.code, 'forbidden_capability');
      assert.strictEqual(e.status, 403);
      assert.strictEqual(e.refused, true);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(e.body)), { error: 'forbidden_capability', need: 'orders:refund' });
    });
  }
  it('the write still went out once, with its method and body', async () => {
    const h = mk({ answer: [403, { error: 'forbidden_capability', need: 'orders:edit' }] });
    await caught(h.ctx.apiWrite('/orders/7/status', { status: 'paid', pay_method: 'cash' }, 'PATCH'));
    assert.strictEqual(h.calls.fetches.length, 1);
    assert.strictEqual(h.calls.fetches[0].u, '/api/retail-admin/orders/7/status');
    assert.strictEqual(h.calls.fetches[0].method, 'PATCH');
    assert.deepStrictEqual(JSON.parse(h.calls.fetches[0].body), { status: 'paid', pay_method: 'cash' });
  });
  it('a 500 is unchanged: the server\'s own words, no refusal flag', async () => {
    const h = mk({ answer: [500, { error: 'db_busy', message: 'Try later' }] });
    const e = await caught(h.ctx.apiWrite('/orders/7/note', {}));
    assert.strictEqual(e.message, 'Try later'); assert.strictEqual(e.code, 'db_busy'); assert.ok(!e.refused);
    const h2 = mk({ answer: [500, {}] });
    assert.strictEqual((await caught(h2.ctx.api('/orders'))).message, 'HTTP 500');
  });
}

section('3 · the words');
{
  it('forbidden_capability: the desktop\'s sentence, in each language', async () => {
    const en = mk({ answer: [403, { error: 'forbidden_capability' }] });
    assert.strictEqual((await caught(en.ctx.apiWrite('/x', {}))).message, EN_CAP);
    const zh = mk({ lang: 'zh', answer: [403, { error: 'forbidden_capability' }] });
    assert.strictEqual((await caught(zh.ctx.apiWrite('/x', {}))).message, ZH_CAP);
  });
  it('forbidden_store: the desktop\'s sentence, in each language', async () => {
    const en = mk({ answer: [403, { error: 'forbidden_store', store: 3 }] });
    assert.strictEqual((await caught(en.ctx.api('/stores/3/x'))).message, EN_STORE);
    const zh = mk({ lang: 'zh', answer: [403, { error: 'forbidden_store', store: 3 }] });
    assert.strictEqual((await caught(zh.ctx.api('/stores/3/x'))).message, ZH_STORE);
  });
  it('the three pairs are copied whole from the desktop\'s TD_ERR', () => {
    for (const k of ['forbidden_capability', 'forbidden_store', 'store_not_assigned']) {
      const m = CORE.match(new RegExp(k + ":\\s*\\[('[^']*'),\\s*('[^']*')\\]"));
      assert.ok(m, 'desktop lost ' + k);
      assert.ok(M.includes(k + ':[' + m[1] + ',' + m[2] + ']'), 'the phone\'s ' + k + ' is not the desktop\'s pair');
    }
  });
  it('a bilingual server sentence is kept, one language shown', async () => {
    const body = { error: 'You can’t grant a role with more access than your own · 不能授予超出自己权限的角色' };
    const en = mk({ answer: [403, body] });
    assert.strictEqual((await caught(en.ctx.apiWrite('/api/backend/team/4', {}, 'PUT'))).message,
      'You can’t grant a role with more access than your own');
    const zh = mk({ lang: 'zh', answer: [403, body] });
    assert.strictEqual((await caught(zh.ctx.apiWrite('/api/backend/team/4', {}, 'PUT'))).message, '不能授予超出自己权限的角色');
  });
  it('a 403 with nothing readable gets lib/require-cap.js\'s own pair', async () => {
    const h = mk({ answer: [403, undefined] });
    assert.strictEqual((await caught(h.ctx.apiWrite('/x', {}))).message, 'You don’t have permission for this');
    assert.ok(REQCAP.includes("'You don’t have permission for this · 你没有此操作的权限'"));
    assert.ok(M.includes("const REFUSAL_ANY=['You don’t have permission for this','你没有此操作的权限'];"));
  });
}

section('4 · said where the operator is looking');
{
  it('an order action: the sheet says why, and the button comes back', async () => {
    const h = mk({ answer: [403, { error: 'forbidden_capability', need: 'orders:refund' }] });
    await h.ctx.orderWrite('refund', async () => { await h.ctx.apiWrite('/orders/7/refund/approve', {}); return 'Refund approved'; });
    assert.strictEqual(h.ctx.state.orderBusy, null);
    assert.strictEqual(String(h.ctx.state.orderErr), EN_CAP);
    assert.deepStrictEqual(h.calls.toasts, [], 'a toast reported a failure');
    assert.strictEqual(h.ctx.location.href, '/m');
  });
  it('a review switch: the refusal replaces "try again", in the language on screen', async () => {
    const h = mk({ answer: [403, { error: 'forbidden_capability', need: 'reviews:moderate' }] });
    h.ctx.revWrite({ id: 5, source: 'real' }, false);
    await tick(); await tick(); await tick();
    assert.strictEqual(h.ctx.state.revBusy, null);
    assert.strictEqual(String(h.ctx.state.revErr), EN_CAP);
    h.ctx.LANG = 'zh';
    assert.strictEqual(String(h.ctx.state.revErr), ZH_CAP, 'the stored error did not follow the language');
    assert.deepStrictEqual(JSON.parse(h.calls.fetches[0].body), { is_visible: false, source: 'real' });
    assert.strictEqual(h.calls.fetches[0].method, 'PATCH');
  });
  it('a review switch that fails for another reason still says "try again"', async () => {
    const h = mk({ answer: [500, {}] });
    h.ctx.revWrite({ id: 5, source: 'real' }, true);
    await tick(); await tick(); await tick();
    assert.ok(/^That did not save/.test(String(h.ctx.state.revErr)));
  });
  it('the media upload: stops at the refusal, counts what landed, says why', async () => {
    const h = mk({ answers: [[200, { success: true }], [403, { error: 'forbidden_capability', need: 'media:upload' }]] });
    await h.ctx.uploadMedia([{ type: 'image/png' }, { type: 'image/png' }, { type: 'image/png' }]);
    assert.strictEqual(h.calls.fetches.length, 2, 'it kept sending after a refusal');
    assert.strictEqual(h.ctx.location.href, '/m');
    assert.strictEqual(h.ctx.state.mediaErr, '1 of 3 uploaded. ' + EN_CAP);
    assert.strictEqual(h.ctx.state.mediaBusy, null);
  });
  it('the category banner upload says the refusal on the card', () => {
    const b = slice('async function catBannerUpload(file){', '\n}\n');
    assert.ok(/if\(r\.status===401\)\{ location\.href='\/backend\/login'; return; \}/.test(b));
    assert.ok(/if\(r\.status===403\)\{ state\.catBannerErr=\(await apiRefusal\(r\)\)\.message; return; \}/.test(b));
  });
  it('a new order refused on the customer box keeps its own sentence; any other refusal is the general one', () => {
    const b = slice("const custRefused=e.code==='forbidden_capability'", 'render();');
    assert.ok(/e\.body&&e\.body\.need==='customers:edit'/.test(b));
    assert.ok(/msg:\(e\.refused&&!custRefused\)\?E\(\.\.\.e\.words\):onwErrText\(/.test(b));
  });
}

section('5 · nothing sends a 403 to the login page, and no catch hides a refusal');
{
  it('no status===403 redirect left in the phone', () => {
    assert.ok(!/status===403\)\{ location\.href/.test(M));
    assert.ok(!/r\.status===401\|\|r\.status===403/.test(M));
  });
  it('every write catch with a "did not save / send / go through" fallback asks e.refused first', () => {
    const L = M.split('\n'); const bad = [];
    L.forEach((l, i) => {
      if (!/==='auth'/.test(l)) return;
      let out = [l]; for (let j = i + 1; j < Math.min(L.length, i + 25); j++) { out.push(L[j]); if (/^\s*\}\);|\}\);\s*$|^\s*\}\s*$/.test(L[j])) break; }
      const after = out.join('\n').slice(out.join('\n').indexOf("'auth'") + 6);
      if (/did not (save|send|go through)|didn.t save|did not take/.test(after) &&
          !/e\.refused|ErrFor\(e|ErrText\(e|Words\(e|Msg\(e|e\.message/.test(after)) bad.push(i + 1);
    });
    assert.deepStrictEqual(bad, [], 'lines ' + bad.join(', '));
  });
  it('the error-text helpers say a refusal before their own "try again"', () => {
    for (const f of ['orderErrorText', 'csErrText', 'recvErrText', 'pwErrFor', 'pkErrFor', 'pinvErrFor']) {
      const b = slice('function ' + f + '(e){', '\n}');
      assert.ok(/if\(e&&e\.refused\) return T\(\.\.\.e\.words\);/.test(b), f);
    }
    assert.ok(/const psupErrMsg=e=>e&&e\.refused\?T\(\.\.\.e\.words\):/.test(M));
    assert.ok(/state\.custErr=e\.refused\?T\(\.\.\.e\.words\)/.test(M));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
