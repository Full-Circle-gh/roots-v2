#!/usr/bin/env node
/**
 * The Official Account handshake, and the separation it exists to keep — §50.
 *
 *   node scripts/test_wechat_oa.js
 *
 * §50 rules that the QR menu takes WeChat payment in-page, and names what that
 * needs: a verified 服务号, because "the mini-program appid cannot serve a web
 * page." The trap this suite exists to hold is that the two appids look
 * interchangeable in code and are not — AN OPENID IDENTIFIES A PERSON TO ONE
 * APP. An openid issued by the Official Account cannot pay an order created
 * against the mini program's appid; WeChat refuses it, and the failure surfaces
 * as a payment that simply does not work rather than as anything a reader would
 * trace back to a credential. So the last check here is the load-bearing one:
 * the two credential sets resolve separately and never fall back to each other.
 *
 * THE #wechat_redirect FRAGMENT IS TESTED BECAUSE IT IS INVISIBLE. Without it
 * WeChat's browser performs no redirect at all and the customer gets a blank
 * page — there is no error, no log line and nothing on the order to find later.
 *
 * WECHAT ANSWERS 200 WITH AN ERRCODE BODY ON FAILURE, so an HTTP status check
 * would read every failure as a success. The exchange is therefore asserted to
 * throw on an errcode body that arrives with a perfectly healthy 200.
 *
 * No network: global.fetch is stubbed. No credentials: the values here are
 * fictional and the suite would pass identically on a machine that has never
 * seen a real one.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');

const oa = require(path.join(ROOT, 'lib', 'wechat-oa.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.error(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.error(`  ✗ ${label}\n      ${e.message}`); }
}
function throws(fn, label) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  assert.strictEqual(threw, true, label);
}
async function rejects(fn, label) {
  let threw = false;
  try { await fn(); } catch (_) { threw = true; }
  assert.strictEqual(threw, true, label);
}

const APP = { appId: 'wxoa0000000000test', appSecret: 'oasecret', };
const REDIRECT = 'https://food.example.com/s/abc123/pay/return';

(async function main() {
  console.log('\nWeChat Official Account OAuth (§50)\n');

  console.log('authorizeUrl');

  check('carries the appid, the code response type and the silent scope', () => {
    const u = new URL(oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'abc123' }).split('#')[0]);
    assert.strictEqual(u.searchParams.get('appid'), APP.appId);
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('state'), 'abc123');
    // snsapi_base and not snsapi_userinfo: an openid is all a payment needs,
    // and userinfo would put a consent sheet in front of a coffee.
    assert.strictEqual(u.searchParams.get('scope'), 'snsapi_base');
    assert.strictEqual(oa.SCOPE, 'snsapi_base');
  });

  check('round-trips the redirect_uri intact', () => {
    const u = new URL(oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'abc123' }).split('#')[0]);
    assert.strictEqual(u.searchParams.get('redirect_uri'), REDIRECT);
  });

  check('ends with #wechat_redirect — without it WeChat renders a blank page', () => {
    const url = oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'abc123' });
    assert.ok(url.endsWith('#wechat_redirect'), 'the fragment is missing: ' + url);
  });

  check('points at open.weixin.qq.com/connect/oauth2/authorize', () => {
    const url = oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'abc123' });
    assert.ok(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?'), url);
  });

  check('refuses to build a URL with no appid rather than emitting a broken one', () => {
    throws(() => oa.authorizeUrl({ appId: '', redirectUri: REDIRECT, state: 'abc123' }), 'built a URL with no appid');
  });

  check('refuses a missing redirect_uri', () => {
    throws(() => oa.authorizeUrl({ ...APP, redirectUri: '', state: 'abc123' }), 'built a URL with no redirect');
  });

  check('refuses a state WeChat would truncate or reject', () => {
    throws(() => oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: '' }), 'accepted an empty state');
    throws(() => oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'a'.repeat(129) }), 'accepted an over-long state');
    throws(() => oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'has spaces' }), 'accepted a state with spaces');
    throws(() => oa.authorizeUrl({ ...APP, redirectUri: REDIRECT, state: 'a#b' }), 'accepted a state with a fragment marker');
  });

  console.log('\nexchangeCodeForOpenid');

  const realFetch = global.fetch;
  let lastUrl = null;
  function stubFetch(body, status = 200) {
    global.fetch = async (url) => {
      lastUrl = String(url);
      return { status, json: async () => body };
    };
  }

  await checkAsync('returns the openid on a success body', async () => {
    stubFetch({ access_token: 'tok', openid: 'oABC123', scope: 'snsapi_base' });
    const r = await oa.exchangeCodeForOpenid('thecode', APP);
    assert.strictEqual(r.openid, 'oABC123');
  });

  await checkAsync('sends appid, secret, code and grant_type', async () => {
    stubFetch({ openid: 'oABC123' });
    await oa.exchangeCodeForOpenid('thecode', APP);
    const q = new URL(lastUrl).searchParams;
    assert.strictEqual(q.get('appid'), APP.appId);
    assert.strictEqual(q.get('secret'), APP.appSecret);
    assert.strictEqual(q.get('code'), 'thecode');
    assert.strictEqual(q.get('grant_type'), 'authorization_code');
  });

  await checkAsync('carries the unionid when WeChat sends one, and null when it does not', async () => {
    stubFetch({ openid: 'oABC123', unionid: 'uXYZ' });
    assert.strictEqual((await oa.exchangeCodeForOpenid('c', APP)).unionid, 'uXYZ');
    stubFetch({ openid: 'oABC123' });
    assert.strictEqual((await oa.exchangeCodeForOpenid('c', APP)).unionid, null);
  });

  await checkAsync('THROWS on an errcode body that arrives with HTTP 200', async () => {
    // The whole trap: WeChat does not use the status code to report failure.
    // A reused or expired code lands here as 40029 on a healthy 200.
    stubFetch({ errcode: 40029, errmsg: 'invalid code' }, 200);
    await rejects(() => oa.exchangeCodeForOpenid('stalecode', APP), 'a 200 errcode body was read as a customer');
  });

  await checkAsync('throws when the body carries no openid at all', async () => {
    stubFetch({ access_token: 'tok' }, 200);
    await rejects(() => oa.exchangeCodeForOpenid('c', APP), 'accepted a body with no openid');
  });

  await checkAsync('throws rather than calling WeChat with no credentials', async () => {
    let called = false;
    global.fetch = async () => { called = true; return { status: 200, json: async () => ({ openid: 'x' }) }; };
    await rejects(() => oa.exchangeCodeForOpenid('c', { appId: '', appSecret: '' }), 'called out with no creds');
    await rejects(() => oa.exchangeCodeForOpenid('', APP), 'called out with no code');
    assert.strictEqual(called, false, 'a request went out despite missing inputs');
  });

  global.fetch = realFetch;

  console.log('\ncredential separation (the load-bearing part)');

  // Required late and behind the pure checks: this one opens the database.
  const creds = require(path.join(ROOT, 'lib', 'tenant-creds.js'));
  const saved = {
    oaId: process.env.WECHAT_OA_APP_ID, oaSecret: process.env.WECHAT_OA_APP_SECRET,
    mpId: process.env.WECHAT_APP_ID,    mpSecret: process.env.WECHAT_APP_SECRET,
  };
  const restore = () => {
    for (const [k, v] of [['WECHAT_OA_APP_ID', saved.oaId], ['WECHAT_OA_APP_SECRET', saved.oaSecret],
                          ['WECHAT_APP_ID', saved.mpId], ['WECHAT_APP_SECRET', saved.mpSecret]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  };

  check('resolves the Official Account from its own env vars', () => {
    process.env.WECHAT_OA_APP_ID = 'wxoa_official';
    process.env.WECHAT_OA_APP_SECRET = 'oasecret';
    const b = creds.getTenantCreds(1);
    assert.strictEqual(b.oa.appId, 'wxoa_official');
    assert.strictEqual(b.oa.appSecret, 'oasecret');
    assert.strictEqual(b.oa.devMode, false);
  });

  check('THE TWO APPIDS ARE NEVER THE SAME VALUE and neither falls back to the other', () => {
    process.env.WECHAT_APP_ID = 'wxmp_miniprogram';
    process.env.WECHAT_APP_SECRET = 'mpsecret';
    process.env.WECHAT_OA_APP_ID = 'wxoa_official';
    process.env.WECHAT_OA_APP_SECRET = 'oasecret';
    const b = creds.getTenantCreds(1);
    assert.strictEqual(b.wechat.appId, 'wxmp_miniprogram', 'the mini program lost its own appid');
    assert.strictEqual(b.oa.appId, 'wxoa_official', 'the Official Account lost its own appid');
    assert.notStrictEqual(b.oa.appId, b.wechat.appId, 'the two registrations resolved to one appid');
  });

  check('an unset Official Account is devMode, and does NOT borrow the mini program', () => {
    process.env.WECHAT_APP_ID = 'wxmp_miniprogram';
    process.env.WECHAT_APP_SECRET = 'mpsecret';
    delete process.env.WECHAT_OA_APP_ID;
    delete process.env.WECHAT_OA_APP_SECRET;
    const b = creds.getTenantCreds(1);
    assert.strictEqual(b.oa.devMode, true, 'an unconfigured Official Account did not report devMode');
    assert.strictEqual(b.oa.appId, '', 'the Official Account borrowed the mini program appid');
    // The mini program is untouched by the absence — this is the regression
    // that would break every existing WeChat login if the wiring were shared.
    assert.strictEqual(b.wechat.devMode, false, 'the mini program broke when the OA was absent');
  });

  check('credsStatus reports oaReady separately from payReady', () => {
    delete process.env.WECHAT_OA_APP_ID;
    delete process.env.WECHAT_OA_APP_SECRET;
    assert.strictEqual(creds.credsStatus(1).oaReady, false);
    process.env.WECHAT_OA_APP_ID = 'wxoa_official';
    process.env.WECHAT_OA_APP_SECRET = 'oasecret';
    assert.strictEqual(creds.credsStatus(1).oaReady, true);
  });

  check('the stored key names are their own, not the mini program\'s', () => {
    assert.strictEqual(creds.KEYS.OA_APP_ID, 'wechat.oa.app_id');
    assert.strictEqual(creds.KEYS.OA_APP_SECRET, 'wechat.oa.app_secret');
    assert.notStrictEqual(creds.KEYS.OA_APP_SECRET, creds.KEYS.WX_APP_SECRET);
    // A non-Roots tenant stores them, so the writer must accept them.
    assert.strictEqual(creds.isValidCredKey('wechat.oa.app_id'), true);
    assert.strictEqual(creds.isValidCredKey('wechat.oa.app_secret'), true);
  });

  restore();

  console.log(failures ? `\n${failures} FAILED\n` : '\nall green\n');
  process.exit(failures ? 1 : 0);
})();
