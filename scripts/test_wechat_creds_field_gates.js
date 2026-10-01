#!/usr/bin/env node
/**
 * §412.2 — THE MINI APP'S CREDENTIALS SPLIT BY FIELD: THE LOGIN PAIR IS
 * integrations:manage, THE WECHAT PAY DETAILS ARE settings:payments.
 *
 *   node scripts/test_wechat_creds_field_gates.js
 *
 * POST /channel-hub/miniapp/wechat-creds (routes/integrations-admin.js) saves
 * either half; the choke point admits either key and the handler asks per
 * field, before anything is written. A field counts only when this save would
 * CHANGE it (a typed secret, or a plain value differing from the stored one),
 * because the configuration page sends all seven fields pre-filled.
 * POST /channel-hub/miniapp/wechat-pay-verify is all WeChat Pay: payments only.
 *
 * The real routers over a scratch database with enforcement on, real
 * tenant_user_caps grants, a self-serve (non-env) tenant; WeChat's servers are
 * stubbed so nothing leaves the machine.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

// Tenant secrets are encrypted at rest (lib/secret-box); a throwaway key for this run only.
process.env.TENANT_SECRET_KEY = process.env.TENANT_SECRET_KEY || require('crypto').randomBytes(32).toString('hex');
const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
// The column the SaaS console adds at boot (routes/saas-admin.js), which a mini
// program's AppID is stored in; this scratch database never loaded that router.
try { db.exec('ALTER TABLE tenants ADD COLUMN wx_appid TEXT'); } catch (e) { /* already there */ }
const creds = require(path.join(ROOT, 'lib', 'tenant-creds'));
const cap = require(path.join(ROOT, 'lib', 'cap-routes'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => (/weixin\.qq\.com/.test(String(u))
  ? Promise.resolve({ ok: true, status: 200, json: async () => ({ errcode: 40001, errmsg: 'stubbed' }) })
  : realFetch(u, o));

// A self-serve tenant: its credentials live in the database, not the server's env.
const T = Number(db.prepare("INSERT INTO tenants (name, status, rbac_enforce) VALUES ('__q2_shop', 'active', 1)").run().lastInsertRowid);
let nextId = 8400;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active) VALUES (?, ?, ?, 'x', ?, 1)`).run(id, T, '__q2_' + name, role);
  for (const k of caps) db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode) VALUES (?, ?, ?, 'grant')`).run(T, id, k);
  ops[name] = id;
}
operator('login', ['integrations:manage']);
operator('pay', ['settings:payments']);
operator('shop', ['settings:shop', 'integrations:view']);
operator('owner', [], 'owner');

const stored = () => { creds.invalidate(T); const c = creds.getTenantCreds(T); return { appId: c.wechat.appId, mchId: c.pay.mchId, serialNo: c.pay.serialNo, v3: c.pay.apiV3Key }; };

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')), tenantId: T }; next(); });
  app.use(retail);
  app.use(require(path.join(ROOT, 'routes', 'integrations-admin.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, p, body) => {
    const r = await realFetch(base + '/api/retail-admin/channel-hub/miniapp/' + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) }, body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const APPID = 'wx0123456789abcdef', APPID2 = 'wxfedcba9876543210';

  try {
    section('0 · the fixture is a self-serve tenant');
    is(creds.getTenantCreds(T).source, 'db', 'credentials live in the database');

    section('1 · the login pair: integrations:manage');
    let r = await call('login', 'wechat-creds', { appId: APPID, appSecret: 'sec-1' });
    is(r.status, 200, 'integrations:manage saves the AppID and AppSecret');
    is(stored().appId, APPID, '…which are stored');
    r = await call('pay', 'wechat-creds', { appId: APPID2 });
    is(r.status, 403, 'settings:payments alone may not change the AppID');
    is(r.body && r.body.field, 'appId', '…and the refusal names the field');
    is(stored().appId, APPID, '…which is unchanged');
    r = await call('pay', 'wechat-creds', { appSecret: 'sec-2' });
    is(r.status, 403, '…nor type a new AppSecret');

    section('2 · the WeChat Pay half: settings:payments');
    r = await call('login', 'wechat-creds', { mchId: '1230000109' });
    is(r.status, 403, 'integrations:manage alone may not set the merchant ID (§412.2 takes it away)');
    is(r.body && r.body.need, 'settings:payments', '…naming the key it needs');
    is(stored().mchId, '', '…and nothing was written');
    r = await call('pay', 'wechat-creds', { mchId: '1230000109', serialNo: 'SER-1', apiV3Key: 'k'.repeat(32) });
    is(r.status, 200, 'settings:payments sets the merchant ID, serial and v3 key');
    is([stored().mchId, stored().serialNo, stored().v3], ['1230000109', 'SER-1', 'k'.repeat(32)], '…which are stored');
    for (const f of ['apiV3Key', 'privateKey', 'platformPubKey']) {
      r = await call('login', 'wechat-creds', { [f]: 'x' });
      is(r.status, 403, `integrations:manage may not type ${f}`);
    }
    r = await call('login', 'wechat-pay-verify', { serialNo: 'SER-2' });
    is(r.status, 403, 'nor run the payment keys\' check, which saves them');
    is(stored().serialNo, 'SER-1', '…the serial unchanged');
    r = await call('pay', 'wechat-pay-verify', {});
    ok(r.status !== 403 && r.status !== 401, `settings:payments runs it (${r.status})`);

    section('3 · a whole-page save counts only what it changes');
    const page = { appId: APPID, appSecret: '', mchId: '1230000109', apiV3Key: '', serialNo: 'SER-1', privateKey: '', platformPubKey: '' };
    r = await call('login', 'wechat-creds', page);
    is(r.status, 200, 'integrations:manage saves the page with the pay details pre-filled and unchanged');
    r = await call('login', 'wechat-creds', { ...page, mchId: '9999999999' });
    is(r.status, 403, '…but not with the merchant ID changed');
    is(stored().mchId, '1230000109', '…which stays');
    r = await call('pay', 'wechat-creds', page);
    is(r.status, 200, 'settings:payments saves the page with the login pair pre-filled and unchanged');
    r = await call('pay', 'wechat-creds', { ...page, appId: APPID2 });
    is(r.status, 403, '…but not with the AppID changed');
    r = await call('login', 'wechat-creds', { ...page, appId: APPID2, mchId: '9999999999' });
    is(r.status, 403, 'a save mixing a permitted and a refused change is refused whole');
    is(stored().appId, APPID, '…writing neither half');

    section('4 · neither key, and the owner');
    r = await call('shop', 'wechat-creds', { appId: APPID2 });
    is(r.status, 403, 'a Settings account holding neither key is refused at the door');
    r = await call('shop', 'wechat-pay-verify', {});
    is(r.status, 403, '…and from the check');
    r = await call('owner', 'wechat-creds', { appId: APPID2, mchId: '9999999999' });
    is(r.status, 200, 'the owner always passes');
    is([stored().appId, stored().mchId], [APPID2, '9999999999'], '…and both halves are written');

    section('5 · the rule as written');
    is(cap.requiredCapFor('POST', '/api/retail-admin/channel-hub/miniapp/wechat-creds'), ['integrations:manage', 'settings:payments'], 'the choke point admits either half');
    is(cap.requiredCapFor('POST', '/api/retail-admin/channel-hub/miniapp/wechat-pay-verify'), 'settings:payments', 'the payment check is payments only');
    is(cap.requiredCapFor('POST', '/api/retail-admin/channel-hub/web/site'), 'integrations:manage', 'the rest of the hub is unchanged');

    section('6 · the desktop hides what the server would refuse');
    const fs = require('fs');
    const IG = fs.readFileSync(path.join(ROOT, 'public/retail-admin/15-integrations.js'), 'utf8');
    const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
    const GUIDE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/17-setup-guide.js'), 'utf8');
    ok(IG.includes("if (mwCanLogin()) Object.assign(body, { appId: v('mc_appid'), appSecret: v('mc_secret') });")
      && IG.includes("if (mwCanPay()) Object.assign(body, { mchId: v('mc_mchid')"), 'the configuration page sends each half only for its key');
    ok(IG.includes("const roLogin = env || !mwCanLogin(), roPay = env || !mwCanPay();"), '…and draws each half read-only without it');
    ok(IG.includes("if (!mwCanPay()) { igMiniappConfigFull(); return; }"), 'the wizard ends after the login pair without the payments key');
    for (const h3 of ['<h3>Currency · 货币</h3>', '<h3>Tax · 税费', '<h3>Alipay manual收款']) {
      const at = HTML.indexOf(h3);
      const card = HTML.lastIndexOf('<div class="group-card"', at);
      ok(HTML.slice(card, HTML.indexOf('>', card)).includes('data-cap="settings:payments"'), h3.replace(/<[^>]+>/g, '') + ' card is hidden without settings:payments');
    }
    ok(GUIDE.includes("const noKey = s.key === 'payment' && typeof can === 'function' && !can('settings:payments');"), 'the setup guide\'s payment step has no button without it');
  } catch (e) {
    fail++; console.log('  ✗ threw: ' + (e && e.stack || e));
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
