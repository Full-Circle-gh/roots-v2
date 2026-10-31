#!/usr/bin/env node
/**
 * Signing a Qingyun store back in from a picture of its browser (§484).
 *
 *   node scripts/test_qingyun_signin.js
 *
 * No network, no browser. The browser is a stub; the route runs on a real
 * Express server with its session, database and picture-taker stubbed.
 *
 * WHAT IS LOCKED, most expensive first
 *   1. The signed-in dashboard is never pictured. It holds customers'
 *      addresses and phone numbers. A picture is only taken after Qingyun has
 *      said signed out, and only of the login page.
 *   2. Signed in means both reads the daemon trusts say so (#1222): the shop
 *      list and one order-list page.
 *   3. The browser is only moved to the QR page once Qingyun has said signed
 *      out, and only when it is not already there (or a new code was asked).
 *   4. Who may: the channel sign-in gate (§250), before anything else, and only
 *      a store Qingyun is set up for.
 *   5. Settings offers the button only on a signed-out store, only to someone
 *      holding the permission; every Chinese string on the page is declared.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const { QingyunBrowser } = require(path.join(ROOT, 'lib', 'qingyun-browser.js'));
const qy = require(path.join(ROOT, 'lib', 'qingyun-signin.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const LOGIN = 'https://saas.cyanclouds.com/';
const DASH = 'https://saas.cyanclouds.com/aggregator/saas/order';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// A stub browser. `loggedIn` and `listOk` are the two reads; `goTo` is where
// openLoginPage lands (Qingyun can bounce a dead session back to the dashboard).
function fake({ url = LOGIN, loggedIn = false, listOk = false, goTo = LOGIN, verify = false } = {}) {
  const br = new QingyunBrowser('yuexiu');
  br.log = [];
  br.page = { url: () => br._url, isClosed: () => false,
    screenshot: async () => { br.log.push('shot:' + br._url); return JPEG; } };
  br._url = url;
  br.connect = async () => br.page;
  br.isLoggedIn = async () => { br.log.push('isLoggedIn'); br.verificationRequired = verify; return loggedIn; };
  br.orderListSignedIn = async () => { br.log.push('orderList'); return listOk; };
  br.openLoginPage = async () => { br.log.push('goto'); br._url = goTo; };
  return br;
}
const deps = (br, now) => ({ getBrowser: async () => br, now });

(async () => {
  console.log('\n1 · The dashboard is never pictured\n');

  await it('the login page is the site root or Meituan\'s passport; the dashboard is not', () => {
    const br = fake();
    const at = (u) => { br._url = u; return br.onLoginPage(); };
    assert.strictEqual(at(LOGIN), true);
    assert.strictEqual(at('https://saas.cyanclouds.com'), true);
    assert.strictEqual(at('https://passport.meituan.com/account/unitivelogin'), true);
    assert.strictEqual(at(DASH), false);
    assert.strictEqual(at('https://saas.cyanclouds.com/aggregator/saas'), false);
    assert.strictEqual(at('about:blank'), false);
    assert.strictEqual(at('https://evil.example/?saas.cyanclouds.com'), false);
  });

  await it('loginPicture takes nothing off the dashboard', async () => {
    const br = fake({ url: DASH });
    assert.strictEqual(await br.loginPicture(), null);
    assert.deepStrictEqual(br.log, []);
  });

  await it('a signed-in store answers signed in, with no picture and no move', async () => {
    qy._reset();
    const br = fake({ url: DASH, loggedIn: true, listOk: true });
    const out = await qy.open('yuexiu', false, deps(br));
    assert.deepStrictEqual(out, { signedIn: true });
    assert.ok(!br.log.some((x) => x.startsWith('shot') || x === 'goto'), br.log.join(','));
  });

  await it('the 901 state: the browser bounces back to the dashboard and nothing is pictured', async () => {
    qy._reset();
    // isLoggedIn can pass while the order list is refused (#1222).
    const br = fake({ url: DASH, loggedIn: true, listOk: false, goTo: DASH });
    const out = await qy.open('yuexiu', false, deps(br));
    assert.strictEqual(out.signedIn, false);
    assert.strictEqual(out.noCode, true);
    assert.ok(br.log.includes('goto'), 'it did not try the QR page');
    assert.ok(!br.log.some((x) => x.startsWith('shot')), 'it pictured the dashboard');
  });

  console.log('\n2 · Signed in means both reads say so\n');

  await it('the order list is asked only once the shop list passes', async () => {
    qy._reset();
    const br = fake({ loggedIn: false });
    await qy.open('yuexiu', false, deps(br));
    assert.ok(!br.log.includes('orderList'));
  });

  await it('the moment the scan lands, the picture call answers signed in', async () => {
    qy._reset();
    const br = fake();
    let t = 0;
    const first = await qy.picture('yuexiu', deps(br, () => t));
    assert.ok(first.picture, 'no picture while signed out');
    br.isLoggedIn = async () => true; br.orderListSignedIn = async () => true; br._url = DASH;
    t += qy.PICTURE_MS;
    assert.deepStrictEqual(await qy.picture('yuexiu', deps(br, () => t)), { signedIn: true });
  });

  console.log('\n3 · The browser is moved only when it should be\n');

  await it('already on the QR page: Start takes the picture where it is', async () => {
    qy._reset();
    const br = fake({ url: LOGIN });
    const out = await qy.open('yuexiu', false, deps(br));
    assert.ok(out.picture);
    assert.ok(!br.log.includes('goto'));
  });

  await it('elsewhere: Start sends it to the QR page, then pictures that', async () => {
    qy._reset();
    const br = fake({ url: 'https://saas.cyanclouds.com/aggregator/saas/home', goTo: LOGIN });
    const out = await qy.open('yuexiu', false, deps(br));
    assert.ok(out.picture);
    assert.deepStrictEqual(br.log.filter((x) => x === 'goto' || x.startsWith('shot')), ['goto', 'shot:' + LOGIN]);
  });

  await it('Show a new code reloads the QR page even when it is on it', async () => {
    qy._reset();
    const br = fake({ url: LOGIN });
    await qy.open('yuexiu', true, deps(br));
    assert.ok(br.log.includes('goto'));
  });

  await it('the picture poll never moves the browser', async () => {
    qy._reset();
    const br = fake({ url: 'https://saas.cyanclouds.com/aggregator/saas/home' });
    const out = await qy.picture('yuexiu', deps(br, () => 0));
    assert.strictEqual(out.noCode, true);
    assert.ok(!br.log.includes('goto'));
  });

  await it('two people watching share one picture a second', async () => {
    qy._reset();
    const br = fake();
    let t = 1000;
    await qy.picture('yuexiu', deps(br, () => t));
    await qy.picture('yuexiu', deps(br, () => t + 500));
    assert.strictEqual(br.log.filter((x) => x.startsWith('shot')).length, 1);
    t += qy.PICTURE_MS;
    await qy.picture('yuexiu', deps(br, () => t));
    assert.strictEqual(br.log.filter((x) => x.startsWith('shot')).length, 2);
  });

  await it('a security check is passed through with the picture', async () => {
    qy._reset();
    const out = await qy.open('yuexiu', false, deps(fake({ verify: true })));
    assert.strictEqual(out.verify, true);
    assert.ok(out.picture);
  });

  await it('the real openLoginPage goes to the site root', async () => {
    const br = new QingyunBrowser('yuexiu');
    const went = [];
    br.page = { goto: async (u) => went.push(u), isClosed: () => false, url: () => '' };
    br.connect = async () => br.page;
    await br.openLoginPage();
    assert.deepStrictEqual(went, [LOGIN]);
  });

  console.log('\n4 · Who may, through the real route\n');

  // The route with its session, database and picture-taker stubbed through
  // the require cache, on a real Express server.
  const ROOTS = 1;
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER);
           CREATE TABLE qingyun_status (store_code TEXT, logged_in INTEGER, updated_at TEXT);
           INSERT INTO retail_stores VALUES (1,'yuexiu',1),(2,'tianhe',1),(3,'shut',0);
           INSERT INTO qingyun_status VALUES ('yuexiu',0,'2026-10-18 00:00:00');`);
  let caller = null;
  const opened = [];
  const stub = (rel, exports) => {
    const f = require.resolve(path.join(ROOT, rel));
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  stub('lib/tenant-db.js', { ROOTS_TENANT_ID: ROOTS, getTenantDb: () => db });
  stub('lib/require-cap.js', { loadCaller: () => caller });
  stub('lib/qingyun-signin.js', {
    open: async (store, fresh) => { opened.push([store, fresh]); return { signedIn: false, picture: JPEG }; },
    picture: async () => ({ signedIn: false, noCode: true }),
  });
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'channel-signin.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'routes', 'qingyun-signin.js'))];
  const express = require('express');
  const app = express();
  let tenantId = ROOTS;
  app.use((req, _res, next) => { req.session = { tenantId }; next(); });
  app.use(require(path.join(ROOT, 'routes', 'qingyun-signin.js')));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* page */ } resolve({ status: res.statusCode, json: j, body: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const who = (caps, scopeStores = null) => ({ user: { id: 7 }, caps: new Set(caps), scopeStores });

  try {
    await it('not signed in, another account, no permission, out of scope: refused, nothing opened', async () => {
      const cases = [
        [null, ROOTS, 401, 'not_signed_in'],
        [who(['integrations:signin']), 2, 403, 'wrong_account'],
        [who([]), ROOTS, 403, 'no_permission'],
        [who(['integrations:signin'], [2]), ROOTS, 403, 'out_of_scope'],
      ];
      for (const [c, t, status, error] of cases) {
        caller = c; tenantId = t;
        const r = await req('POST', '/api/retail-admin/qingyun-signin/open', { store: 'yuexiu' });
        assert.deepStrictEqual([r.status, r.json && r.json.error], [status, error]);
        const p = await req('GET', '/api/retail-admin/qingyun-signin/picture?store=yuexiu');
        assert.deepStrictEqual([p.status, p.json && p.json.error], [status, error], 'picture: ' + error);
      }
      assert.deepStrictEqual(opened, []);
      tenantId = ROOTS;
    });

    await it('a store Qingyun is not set up for, a closed one, or a bad code is refused', async () => {
      caller = who(['integrations:signin']);
      for (const store of ['tianhe', 'shut', '../x', '']) {
        const r = await req('POST', '/api/retail-admin/qingyun-signin/open', { store });
        assert.strictEqual(r.status, 400, store);
      }
      assert.deepStrictEqual(opened, []);
    });

    await it('allowed: Start opens, a new code is fresh, the picture comes back as an image', async () => {
      caller = who(['integrations:signin'], [1]);
      const r = await req('POST', '/api/retail-admin/qingyun-signin/open', { store: 'yuexiu' });
      assert.strictEqual(r.status, 200);
      assert.ok(/^data:image\/jpeg;base64,/.test(r.json.picture));
      await req('POST', '/api/retail-admin/qingyun-signin/open', { store: 'yuexiu', fresh: true });
      assert.deepStrictEqual(opened, [['yuexiu', false], ['yuexiu', true]]);
      const p = await req('GET', '/api/retail-admin/qingyun-signin/picture?store=yuexiu');
      assert.deepStrictEqual([p.json.signedIn, p.json.noCode, p.json.picture], [false, true, null]);
    });

    await it('the page is served, uncached', async () => {
      const r = await req('GET', '/qingyun-signin?store=yuexiu');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('qingyun-signin/picture'));
    });
  } finally { server.close(); }

  console.log('\n5 · The button and the words\n');

  await it('server.js mounts the route', () => {
    assert.ok(/app\.use\(require\('\.\/routes\/qingyun-signin'\)\)/.test(read('server.js')));
  });

  await it('desktop Settings: Sign in again only on a signed-out store, only with the permission', () => {
    const src = read('public', 'retail-admin', '02-settings-ops.js');
    assert.ok(/state === 'signed_out' && \(typeof can !== 'function' \|\| can\('integrations:signin'\)\)\s*\?\s*`<button[^`]*_qingyunSignIn\(/.test(src));
    assert.ok(/window\.open\('\/qingyun-signin\?store='/.test(src));
  });

  await it('phone Settings: the same', () => {
    const src = read('public', 'm.html');
    assert.ok(/qyState\(st\)!=='signed_out'\|\|!mCan\('integrations:signin'\)\?''/.test(src));
    assert.ok(/reg\('x7QySignIn'/.test(src) && /location\.href='\/qingyun-signin\?store='/.test(src));
  });

  await it('every Chinese string on the page is declared in the vocabulary', () => {
    const page = read('public', 'qingyun-signin.html');
    const vocab = read('docs', 'tacet-delivery-vocabulary.md');
    const zh = [...page.matchAll(/T\(\s*`?['`][^]*?['`]\s*,\s*['`]([^'`]+)['`]\s*\)/g)].map((m) => m[1]);
    assert.ok(zh.length >= 10, 'found only ' + zh.length + ' strings');
    for (const s of zh) {
      const bare = s.replace(/\$\{[^}]+\}/g, '').replace(/[ ·]+$/, '');
      assert.ok(vocab.includes(bare.split(/[，。]/)[0]), 'not declared: ' + s);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
