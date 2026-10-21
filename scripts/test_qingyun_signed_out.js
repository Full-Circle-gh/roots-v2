#!/usr/bin/env node
/**
 * A Qingyun session that Qingyun has signed out reads as signed out.
 *
 *   node scripts/test_qingyun_signed_out.js
 *
 * No network, no DB, no browser. The browser class is driven with its page and
 * its _api stubbed; the daemon and the route are read from the shipped source.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-10-18: every order/list from yuexiu came back HTTP 200, code 901,
 * 获得登录信息失败:用户未登录 for 22 hours. Nothing reached Qingyun (TC001334 sat
 * "Queued for push…"), yet Settings said Connected and the scan-QR alert never
 * fired. isLoggedIn() held no captured request body, fell back to the page's
 * URL, and the order page keeps its URL when the session dies. The daemon read
 * the 901s as a page to self-heal, not as a logout.
 *
 * WHAT IS LOCKED
 *   1. a 901 / 未登录 answer is a logout; a request that got no answer is not;
 *   2. isLoggedIn() asks Qingyun before it trusts the URL — and still trusts
 *      the URL when the ask got no answer, so a network blip is not a logout;
 *   3. an order list refused as signed out says so, and the daemon routes it
 *      to the same logout handling as the gate, without the gate's next pass
 *      wiping the count that the alert waits on;
 *   4. Settings gets one of four states, and only a store never set up is
 *      offered Request setup.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const { QingyunBrowser, isSignedOutAnswer } = require(path.join(ROOT, 'lib', 'qingyun-browser.js'));
const DAEMON = fs.readFileSync(path.join(ROOT, 'scripts', 'qingyun-daemon.js'), 'utf8');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '02-settings-ops.js'), 'utf8');

function slice(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

// The exact answer production gave, and the two it must not be confused with.
const OUT_901 = { status: 200, code: 901, msg: '获得登录信息失败:用户未登录', data: null };
const NO_ANSWER = { status: 0, code: null, msg: 'TypeError: Failed to fetch', data: null };
const OK = (data) => ({ status: 200, code: 0, msg: '', data: data || { list: [] } });

// A browser whose page and API are stubs. `answers` maps an API path to its
// reply; `captured` is what the page's XHR hook holds.
function browser({ url = 'https://saas.cyanclouds.com/aggregator/saas/order', captured = null, answers = {} } = {}) {
  const br = new QingyunBrowser('yuexiu');
  br.calls = [];
  br.connect = async () => br.page;
  br.page = { url: () => url, isClosed: () => false };
  br._captured = async () => captured;
  br._api = async (p) => { br.calls.push(p); const a = answers[p]; return typeof a === 'function' ? a() : (a || NO_ANSWER); };
  br._recaptureOrderList = async () => false;
  return br;
}

(async () => {
  console.log('\n1 · What counts as signed out\n');

  await it('the production answer (code 901, 用户未登录) is a logout', () => {
    assert.strictEqual(isSignedOutAnswer(OUT_901), true);
    assert.strictEqual(isSignedOutAnswer({ status: 200, code: 500, msg: '获得登录信息失败' }), true, 'the words alone');
    assert.strictEqual(isSignedOutAnswer({ status: 401, code: null, msg: '' }), true, 'a plain 401');
  });

  await it('…and a request that got no answer, or an ordinary refusal, is not', () => {
    assert.strictEqual(isSignedOutAnswer(NO_ANSWER), false);
    assert.strictEqual(isSignedOutAnswer({ status: 200, code: 500, msg: '系统繁忙' }), false);
    assert.strictEqual(isSignedOutAnswer(OK()), false);
    assert.strictEqual(isSignedOutAnswer(null), false);
  });

  console.log('\n2 · isLoggedIn() asks before it trusts the URL\n');

  await it('no captured body + Qingyun says 901 → signed out, though the page is still on the dashboard URL', async () => {
    const br = browser({ answers: { 'merchant/shop/list': OUT_901 } });
    assert.strictEqual(await br.isLoggedIn(), false);
    assert.deepStrictEqual(br.calls, ['merchant/shop/list'], 'it asked Qingyun');
  });

  await it('no captured body + Qingyun answers → signed in', async () => {
    assert.strictEqual(await browser({ answers: { 'merchant/shop/list': OK() } }).isLoggedIn(), true);
  });

  await it('no captured body + no answer at all → the URL decides, as before (a blip is not a logout)', async () => {
    assert.strictEqual(await browser({}).isLoggedIn(), true, 'on the dashboard');
    assert.strictEqual(await browser({ url: 'https://saas.cyanclouds.com/' }).isLoggedIn(), false, 'on the QR page at the root');
  });

  await it('a captured body is replayed and its answer decides', async () => {
    const cap = { body: 'webVersion=4.5.25' };
    assert.strictEqual(await browser({ captured: cap, answers: { 'order/list/count': OK() } }).isLoggedIn(), true);
    assert.strictEqual(await browser({ captured: cap, answers: { 'order/list/count': OUT_901 } }).isLoggedIn(), false);
  });

  await it('the login page itself is signed out without asking anything', async () => {
    const br = browser({ url: 'https://passport.meituan.com/login' });
    assert.strictEqual(await br.isLoggedIn(), false);
    assert.deepStrictEqual(br.calls, []);
  });

  console.log('\n3 · An order list refused as signed out\n');

  await it('every tab refused with 901 → bootstrap, and it says signedOut', async () => {
    const r = await browser({ answers: { 'order/list': OUT_901 } }).getActiveDeliveries();
    assert.strictEqual(r.bootstrap, true);
    assert.strictEqual(r.signedOut, true);
    assert.ok(/code 901/.test(r.reason), 'the reason still carries the code for the ops alert');
  });

  await it('…while a list that simply got no answer is bootstrap but NOT signed out', async () => {
    const r = await browser({ answers: { 'order/list': NO_ANSWER } }).getActiveDeliveries();
    assert.strictEqual(r.bootstrap, true);
    assert.strictEqual(r.signedOut, false);
  });

  await it('orderListSignedIn(): false only on a signed-out answer', async () => {
    assert.strictEqual(await browser({ answers: { 'order/list': OUT_901 } }).orderListSignedIn(), false);
    assert.strictEqual(await browser({ answers: { 'order/list': OK({ dataList: [] }) } }).orderListSignedIn(), true);
    assert.strictEqual(await browser({ answers: { 'order/list': NO_ANSWER } }).orderListSignedIn(), true, 'no answer is not a logout');
  });

  await it('the daemon sends both signals to one logout handler', () => {
    const poll = slice(DAEMON, 'async function pollStore(storeCode)');
    assert.ok(/if \(!\(await br\.isLoggedIn\(\)\)\)[\s\S]{0,200}noteLoginDown\(storeCode/.test(poll), 'the gate does not use noteLoginDown');
    assert.ok(/if \(bootstrap && active\.signedOut\) \{\s*listSignedOut\[storeCode\] = true;\s*noteLoginDown\(storeCode/.test(poll),
      'a list refused as signed out is not treated as a logout');
    const helper = slice(DAEMON, 'function noteLoginDown(storeCode, why)');
    assert.ok(helper.includes("logSync(storeCode, 'needs_login'"), 'the needs_login event is gone');
    assert.ok(helper.includes('需要扫码重新登录'), 'the scan-QR alert is gone');
    assert.ok(helper.includes('heartbeat(storeCode, false)'), 'Settings would not hear of it');
  });

  await it('…and a gate that still says yes cannot wipe the logout count while the list says no', () => {
    const poll = slice(DAEMON, 'async function pollStore(storeCode)');
    const check = poll.indexOf('if (listSignedOut[storeCode])');
    const reset = poll.indexOf('loginFailStreak[storeCode] = 0');
    assert.ok(check !== -1, 'the re-check is gone');
    assert.ok(check < reset, 'the count is reset before the list is asked again — the alert could never fire');
    assert.ok(/if \(!\(await br\.orderListSignedIn\(\)\)\) \{ noteLoginDown\(/.test(poll), 'a second refusal is not counted');
  });

  console.log('\n4 · What Settings is told\n');

  // _qingyunStoreStatus run against a fake database and a fixed clock.
  function status(rows) {
    const NOW = Date.parse('2026-10-18T03:00:00Z');
    const ctx = {
      QY_FRESH_MS: 5 * 60 * 1000,
      Date: { now: () => NOW, parse: (s) => Date.parse(s) },
      tdb: () => ({ prepare: (sql) => ({
        all: () => (/FROM retail_stores/.test(sql)
          ? [{ code: 'tianhe' }, { code: 'yuexiu' }, { code: 'zz' }, { code: 'new' }]
          : rows),
      }) }),
    };
    vm.createContext(ctx);
    new vm.Script(`${slice(RETAIL, 'function _qingyunStoreStatus()')}\n_out = _qingyunStoreStatus();`).runInContext(ctx);
    return Object.fromEntries(ctx._out.map(s => [s.code, [s.state, s.connected]]));
  }

  await it('connected / signed_out / offline / not_set_up, and `connected` means what it always meant', () => {
    const got = status([
      { store_code: 'tianhe', logged_in: 1, updated_at: '2026-10-18 02:59:30' },
      { store_code: 'yuexiu', logged_in: 0, updated_at: '2026-10-18 02:59:30' },
      { store_code: 'zz', logged_in: 1, updated_at: '2026-10-18 01:00:00' },
    ]);
    assert.deepStrictEqual(got, {
      tianhe: ['connected', true],
      yuexiu: ['signed_out', false],
      zz: ['offline', false],
      new: ['not_set_up', false],
    });
  });

  await it('the order drawer is told when the store is signed out, from the same read', () => {
    assert.ok(/store_signed_out: _qingyunStoreState\(q\.store_code\) === 'signed_out'/.test(RETAIL));
    assert.ok(/function _qingyunStoreState\(storeCode\)[\s\S]{0,200}_qingyunStoreStatus\(\)/.test(RETAIL));
  });

  // The desktop Settings rows, rendered by the shipped function.
  async function desktopRows(data) {
    const box = { innerHTML: '' };
    const ctx = {
      document: { getElementById: (id) => (id === 'qy-stores' ? box : null) },
      fetch: async () => ({ ok: true, json: async () => ({ success: true, data, anyConnected: true, autoPush: true }) }),
      window: {},
      // §494: the pills are one language at a time, built with cuT and escaped.
      cuT: (en) => en, escapeHtml: (x) => String(x == null ? '' : x),
    };
    vm.createContext(ctx);
    new vm.Script(`${slice(SETTINGS, 'async function loadQingyunStores()')}\n_p = loadQingyunStores();`).runInContext(ctx);
    await ctx._p;
    return box.innerHTML;
  }

  await it('desktop: a signed-out store says Signed out and is not offered Request setup', async () => {
    const html = await desktopRows([
      { code: 'tianhe', name_en: 'Tianhe', connected: true, state: 'connected' },
      { code: 'yuexiu', name_en: 'Yuexiu', connected: false, state: 'signed_out' },
    ]);
    assert.ok(/td-pill td-pill-amber">Signed out</.test(html), 'the signed-out pill is missing');
    assert.ok(!html.includes('Not set up') && !html.includes('_requestQingyun'), 'a signed-out store is offered setup');
  });

  await it('desktop: offline says so; never-set-up keeps Request setup; an old server (no state) still works', async () => {
    const html = await desktopRows([
      { code: 'zz', name_en: 'Zhuzhou', connected: false, state: 'offline' },
      { code: 'new', name_en: 'New', connected: false, state: 'not_set_up' },
      { code: 'old', name_en: 'Old', connected: false },
    ]);
    assert.ok(/td-pill td-pill-amber">Sync service offline</.test(html));
    assert.strictEqual((html.match(/_requestQingyun/g) || []).length, 2, 'Request setup is for the two never set up');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
