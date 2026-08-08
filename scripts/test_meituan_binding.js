#!/usr/bin/env node
/**
 * Offline self-test for the Meituan STORE-BINDING logic (lib/meituan-browser).
 * No network, no browser, no DB: a fake Playwright page + a stubbed order-list
 * fetch drive the real methods.
 *
 *   node scripts/test_meituan_binding.js
 *
 * The failure this guards against: a session that is signed in but not bound to
 * a store (Meituan drops the acctId/region context while the cookies stay valid)
 * syncs NOTHING, yet looks healthy from every angle that only checks auth. It ran
 * for 18h undetected on 天河 (2026-07-09) and recurred on 2026-08-08.
 *
 * What it locks down:
 *   1. CLASSIFICATION — both live binding signatures are recognised, and an
 *      ordinary per-product rejection is not mistaken for one;
 *   2. the PROBE — a bound reply, an unbound reply, a captcha and a dead network
 *      are four different verdicts, so a network blip is never reported to a
 *      human as a binding problem;
 *   3. the LOGIN GATE — interactiveLogin does not save a session it hasn't proven
 *      bound (saving one is what makes a "fixed" store page ops again 5 min later);
 *   4. the ASYMMETRY — the business-status read may FLAG a lost binding but must
 *      never CLEAR one, because it answers off the wmPoiId cookie alone.
 */
'use strict';

const assert = require('assert');
const { MeituanBrowser } = require('../lib/meituan-browser');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// The two replies Meituan actually sends when the binding is gone (captured in
// the 2026-07-09 incident), plus the shapes that must NOT be read as one.
const UNBOUND_ORDER_READ = { status: 200, data: { code: 10002, msg: 'SET REGION QUERY ERROR' } };
const UNBOUND_STOCK_PUSH = { code: 30000, msg: '参数异常:acctId, 当前acctId为：【null】' };
const BOUND_ORDER_READ   = { status: 200, data: { code: 0, data: { orderList: [] } } };

// A fake page: enough surface for the methods under test, no Playwright.
function fakePage(opts = {}) {
  const main = { url: () => 'https://e.waimai.meituan.com/' };
  const content = { url: () => 'https://e.waimai.meituan.com/new_fe/orderbusiness' };
  return {
    url: () => opts.url || 'https://e.waimai.meituan.com/#/order',
    goto: async () => {},
    // Instant-ish: the real waits are seconds, and this test must not sleep.
    waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms, 3))),
    mainFrame: () => main,
    frames: () => [main, content],
    evaluate: async (fn) => (opts.evaluate ? opts.evaluate(fn) : false),
  };
}

function browser(storeCode = 'tianhe') {
  const b = new MeituanBrowser(storeCode);
  b.page = fakePage();
  b._log = () => {};            // quiet — the methods log a lot by design
  return b;
}

(async () => {
  console.log('\nMeituan store-binding — offline self-test\n');

  // ── 1. Classification ─────────────────────────────────────────────────────
  console.log('1. binding-error classification');
  await it('order-read signature (10002 / SET REGION QUERY ERROR) is a binding error', () => {
    const b = browser();
    assert.strictEqual(b._isBindingError(10002, 'SET REGION QUERY ERROR'), true);
  });
  await it('stock-push signature (30000 / acctId null) is a binding error', () => {
    const b = browser();
    assert.strictEqual(b._isBindingError(UNBOUND_STOCK_PUSH.code, UNBOUND_STOCK_PUSH.msg), true);
  });
  await it('an ordinary per-product rejection is NOT a binding error', () => {
    const b = browser();
    assert.strictEqual(b._isBindingError(10048, '套餐内商品库存不足'), false);
    assert.strictEqual(b._isBindingError(1, '商品不存在'), false);
  });
  await it('an acctId message WITHOUT null is not a binding error', () => {
    const b = browser();
    assert.strictEqual(b._isBindingError(30000, '参数异常:acctId 格式不正确'), false);
  });

  // ── 2. The probe ──────────────────────────────────────────────────────────
  console.log('\n2. probeBinding verdicts');
  await it('a code:0 order read reports BOUND', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b._fetchOrderListRaw = async () => { b.bindingLost = false; return BOUND_ORDER_READ; };
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, true);
  });
  await it('SET REGION QUERY ERROR reports NOT BOUND, with the code to show a human', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b._fetchOrderListRaw = async () => { b._flagBindingLost('test'); return UNBOUND_ORDER_READ; };
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, false);
    assert.strictEqual(r.code, 10002);
    assert.ok(/SET REGION/.test(r.msg), 'the message is passed through for the log');
    assert.ok(!r.verify && !r.unreachable, 'a definite verdict, not an unknown');
  });
  await it('a captcha is UNKNOWN, never reported as unbound', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b._fetchOrderListRaw = async () => { b._flagVerification('test'); return null; };
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, false);
    assert.strictEqual(r.verify, true);
    assert.strictEqual(r.code, undefined, 'no binding verdict was reached');
  });
  await it('a dead network is UNKNOWN, never reported as unbound', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b._fetchOrderListRaw = async () => null;   // nav/fetch failure, no reply at all
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, false);
    assert.strictEqual(r.unreachable, true);
    assert.strictEqual(r.code, undefined, 'no binding verdict was reached');
  });
  await it('a logged-out session says so instead of guessing at the binding', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => false;
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, false);
    assert.strictEqual(r.loggedIn, false);
  });

  // ── 3. The login gate ─────────────────────────────────────────────────────
  console.log('\n3. interactiveLogin refuses to save an unbound session');
  await it('signed in but never bound → nothing saved, returns false', async () => {
    const b = browser();
    let saves = 0, probes = 0;
    b._saveSession = async () => { saves++; };
    b.probeBinding = async () => { probes++; return { bound: false, code: 10002, msg: 'SET REGION QUERY ERROR' }; };
    const ok = await b.interactiveLogin(250);
    assert.strictEqual(ok, false, 'must not report success');
    assert.strictEqual(saves, 0, 'must not overwrite the session file with an unbound session');
    assert.ok(probes >= 1, 'it did check the binding');
    assert.strictEqual(b._loggedIn, false, 'left un-flagged, so close() cannot persist it either');
  });
  await it('bound only after the human switches stores → saved exactly once', async () => {
    const b = browser();
    let saves = 0, probes = 0;
    b._saveSession = async () => { saves++; };
    b.probeBinding = async () => (++probes < 3
      ? { bound: false, code: 10002, msg: 'SET REGION QUERY ERROR' }  // still on the other 门店
      : { bound: true, poi: '12345' });                                // picker switched
    const ok = await b.interactiveLogin(5000);
    assert.strictEqual(ok, true);
    assert.strictEqual(saves, 1);
    assert.strictEqual(b._loggedIn, true);
  });
  await it('a captcha during the check does not save either', async () => {
    const b = browser();
    let saves = 0;
    b._saveSession = async () => { saves++; };
    b.probeBinding = async () => ({ bound: false, verify: true });
    const ok = await b.interactiveLogin(250);
    assert.strictEqual(ok, false);
    assert.strictEqual(saves, 0);
  });

  // ── 4. The asymmetry ──────────────────────────────────────────────────────
  console.log('\n4. business-status read: may flag a lost binding, must never clear one');
  await it('a binding reply from the status endpoint FLAGS it', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b.page = fakePage({ evaluate: async () => ({ httpStatus: 200, json: { code: 10002, msg: 'SET REGION QUERY ERROR' } }) });
    await b.getBusinessStatus();
    assert.strictEqual(b.bindingLost, true);
  });
  await it('a clean status read does NOT clear a flag the order read set', async () => {
    const b = browser();
    b.ensureLoggedIn = async () => true;
    b.bindingLost = true;   // as set by a failed order read
    // The endpoint answers off the wmPoiId cookie, so an unbound session still
    // gets a code:0 here — this is exactly the reply that used to keep a dead
    // store looking healthy.
    b.page = fakePage({ evaluate: async () => ({ httpStatus: 200, json: { code: 0, status: 1, wmPoiStatusDesc: '营业中' } }) });
    const s = await b.getBusinessStatus();
    assert.strictEqual(s.ok, true, 'the status read itself still succeeds');
    assert.strictEqual(b.bindingLost, true, 'but it is not evidence of a binding');
  });
  await it('an order read IS allowed to clear it (through the real fetch path)', async () => {
    const b = browser();
    b.bindingLost = true;
    b.ensureLoggedIn = async () => true;
    // No stub on _fetchOrderListRaw here — the in-page fetch is what returns the
    // reply, so this exercises the real navigate-and-read path end to end.
    b.page.frames = () => [{
      url: () => 'https://e.waimai.meituan.com/new_fe/orderbusiness',
      evaluate: async () => BOUND_ORDER_READ,
    }];
    const r = await b.probeBinding();
    assert.strictEqual(r.bound, true);
    assert.strictEqual(b.bindingLost, false, 'a code:0 order read genuinely proves the binding');
  });

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test error:', e); process.exit(1); });
