#!/usr/bin/env node
/**
 * §325 step S2f — THE LAST OPEN WRITES, GATED ON THE SCREENS THAT MAKE THEM.
 *
 *   node scripts/test_last_open_writes.js
 *
 * Shop and channel open/close (/store-status/*, /channel-status/*), the manual
 * Alipay card, integration credentials, the fapiao settings, the printer, the
 * Qingyun courier request and auto-push, the setup guide's flags and product
 * page templates matched no rule, so any signed-in operator could make them.
 * Each now takes the keys that open every screen making it today (§325.3), and
 * every refusal here has its allow beside it.
 *
 * The real routers over a scratch database with enforcement on; each
 * operator's keys are real tenant_user_caps grants resolved by the real
 * requireRetailAdmin. The allow side asserts "not a refusal" — what a
 * permitted call then does (a missing store, an unreachable broker) is the
 * handler's business, not the gate's.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const cap = require(path.join(ROOT, 'lib', 'cap-routes'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = read('public/m.html');
const CORE = read('public/retail-admin/01-core.js');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);
let nextId = 7700;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2f_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
}
operator('orders', ['orders:view', 'orders:edit']);
operator('dash', ['dashboard:view']);
operator('meituan', ['meituan:view']);
operator('push', ['settings:push']);
operator('shop', ['settings:shop']);
operator('delivery', ['delivery:view']);
operator('products', ['products:view']);
operator('content', ['content:edit']);
operator('invoices', ['invoices:manage']);
operator('owner', [], 'owner');

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(retail);
  for (const r of ['meituan-admin.js', 'retail-setup.js', 'retail-page-templates.js']) app.use(require(path.join(ROOT, 'routes', r)));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, method, p, body) => {
    const r = await fetch(base + '/api/retail-admin' + p, {
      method, headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const refused = async (who, m, p, b, what) => {
    const r = await call(who, m, p, b);
    is(r.status, 403, what);
    return r;
  };
  const through = async (who, m, p, b, what) => {
    const r = await call(who, m, p, b);
    ok(r.status !== 403, `${what} (got ${r.status})`, JSON.stringify(r.body));
    return r;
  };

  try {
    section('1 · open and close');
    for (const p of ['/channel-status/cell', '/channel-status/channel', '/channel-status/location']) {
      await refused('orders', 'POST', p, { channel: 'meituan', storeCode: 'x', open: true }, `an orders account cannot POST ${p}`);
      await through('dash', 'POST', p, { channel: 'meituan', storeCode: 'zz-none', open: true }, `the phone's Sales (dashboard:view) can`);
      await through('meituan', 'POST', p, { channel: 'meituan', storeCode: 'zz-none', open: true }, '…and the desktop Sales page\'s meituan:view');
    }
    for (const p of ['/store-status/online', '/store-status/master', '/store-status/store/zz-none']) {
      await refused('orders', 'POST', p, { open: true }, `an orders account cannot POST ${p}`);
      await through('dash', 'POST', p, { open: true }, '…the Sales keys can');
      await through('shop', 'POST', p, { open: true }, '…and so can Settings\', where the desktop panel lives');
    }
    ok(/'settings:edit'\)\}/.test(read('public/retail-admin/02-settings-ops.js')) && !/'settings:edit'/.test(read('lib/capabilities.js')),
      'the desktop draws the /store-status buttons for settings:edit, which is no key, so nobody uses them today');

    section('2 · Settings: manual Alipay, the printer, the fapiao settings');
    await refused('orders', 'PUT', '/alipay-manual', {}, 'an orders account cannot change where Alipay takings land');
    await through('push', 'PUT', '/alipay-manual', {}, 'Settings → Push can');
    await through('shop', 'PUT', '/alipay-manual', {}, '…and the setup guide\'s settings:shop');
    await refused('orders', 'PUT', '/printer', { auto_print: true }, 'an orders account cannot change the printer');
    await through('shop', 'PUT', '/printer', { auto_print: true }, 'Settings (desktop card, phone Operations) can');
    await refused('push', 'PUT', '/fapiao-settings', {}, 'nobody writes the fapiao settings from a screen, so they close to…');
    await through('invoices', 'PUT', '/fapiao-settings', {}, '…invoices:manage');

    section('3 · integration credentials, per service');
    let r = await refused('orders', 'PUT', '/integrations', { wecom_app: { corp_id: 'x' } }, 'an orders account is refused at the choke point');
    r = await call('push', 'PUT', '/integrations', { wecom_app: { corp_id: null } });
    ok(r.status !== 403, `Settings → Push saves the WeCom app (got ${r.status})`);
    r = await call('push', 'PUT', '/integrations', { jd: { app_key: 'x' } });
    is([r.status, r.body && r.body.service], [403, 'jd'], 'but not the JD courier\'s keys — that form is on the Delivery panel');
    r = await call('delivery', 'PUT', '/integrations', { jd: { app_key: null } });
    ok(r.status !== 403, `the Delivery panel saves JD (got ${r.status})`);
    r = await call('delivery', 'PUT', '/integrations', { kd100: { customer: 'zz-s2f' }, nuonuo: { app_key: 'x' } });
    is([r.status, r.body && r.body.service], [403, 'nuonuo'], 'one service the operator may not write refuses the whole body');
    ok(!db.prepare("SELECT 1 FROM storefront_config WHERE value_json LIKE '%zz-s2f%'").get(), '…and the kd100 half of it was not written');
    r = await call('delivery', 'PUT', '/integrations', { wecom_app: { corp_id: null } });
    ok(r.status !== 403, `delivery:view opens Settings too, so it may save Settings → Push's WeCom app (got ${r.status})`);
    r = await call('push', 'PUT', '/integrations', { nuonuo: { app_key: 'x' } });
    is(r.status, 403, 'nuonuo, written by no screen, needs invoices:manage');
    is(cap.integrationServiceCap('feie'), cap.integrationServiceCap('wecom_app'), 'the printer vendors take Settings\' keys');
    is(cap.integrationServiceCap('kd100'), ['delivery:view', 'delivery:edit', 'shipping:config'], 'kd100: the Delivery panel and shipping:config');

    section('4 · Qingyun');
    for (const p of ['/integrations/qingyun/request', '/integrations/qingyun/autopush']) {
      await refused('push', 'POST', p, { storeCode: 'zz', enabled: false }, `${p}: Settings → Push cannot (it is the Delivery panel's)`);
      await through('delivery', 'POST', p, { storeCode: 'zz', enabled: false }, '…the Delivery panel can');
    }

    section('5 · the setup guide\'s flags');
    r = await call('orders', 'POST', '/setup', { welcomeSeen: true });
    is(r.status, 200, 'anybody may dismiss the first-login welcome');
    r = await call('orders', 'POST', '/setup', { storeOpened: true });
    is([r.status, r.body && r.body.flag], [403, 'storeOpened'], 'but not mark the store opened');
    r = await call('orders', 'POST', '/setup', { welcomeSeen: true, pickupConfirmed: true });
    is(r.status, 403, 'a body with one refused flag writes none');
    is(db.prepare("SELECT value_json FROM storefront_config WHERE key='setup.flags'").get().value_json.includes('"pickupConfirmed":true'), false,
      '…and pickup was not confirmed');
    r = await call('shop', 'POST', '/setup', { pickupConfirmed: true, storeOpened: true });
    is(r.status, 200, 'the setup pair (settings:shop) works the guide');
    is(cap.requiredCapFor('POST', '/api/retail-admin/setup'), null, 'the choke point leaves it to the handler, because the welcome is open');

    section('6 · product page templates');
    await refused('orders', 'POST', '/page-templates', { name: 'x', blocks: [] }, 'an orders account cannot save a page template');
    await refused('orders', 'DELETE', '/page-templates/1', null, '…or delete one');
    await through('products', 'POST', '/page-templates', { name: 'x', blocks: [] }, 'the product editor opened from Products can');
    await through('content', 'DELETE', '/page-templates/999999', null, '…and from the mini-app editor');

    section('7 · owner and enforcement off');
    await through('owner', 'PUT', '/alipay-manual', {}, 'the owner, holding nothing, is never refused');
    db.prepare('UPDATE tenants SET rbac_enforce = 0 WHERE id = ?').run(TENANT);
    await through('orders', 'POST', '/channel-status/cell', { channel: 'meituan', storeCode: 'zz', open: true }, 'enforcement off: nothing changes');
    await through('orders', 'POST', '/setup', { storeOpened: false }, '…in the handlers either');
    db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);

    section('8 · the screens and callers the gates are built from');
    ok(/sales: \['dashboard:view', 'meituan:view', 'guanyi:view', 'eleme:view', 'integrations:view'\]/.test(CORE), 'desktop Sales opens on the five keys');
    ok(/sales:'dashboard:view'/.test(M), 'phone Sales opens on dashboard:view');
    ok(/apiWrite\('\/channel-status\/cell'/.test(M) && /apiWrite\('\/channel-status\/location'/.test(M), 'the phone writes the cell and the shop switch');
    ok(/apiWrite\('\/printer',\{auto_print:next\},'PUT'\)/.test(M), 'the phone\'s auto-print switch writes /printer');
    ok(/settings:\['settings:shop','settings:push','settings:payments','stores:view','shipping:config'\]/.test(M), '…from Operations, reached from Settings');
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = d + '/' + e.name;
      if (e.isDirectory()) walk(rel); else if (/\.(html|js)$/.test(e.name)) files.push(rel);
    } };
    walk('public');
    const who = (re) => files.filter((f) => re.test(read(f))).sort();
    is(who(/store-status\/(online|master|store)/), ['public/retail-admin/02-settings-ops.js'], '/store-status: one desktop panel');
    is(who(/channel-status\/(cell|channel|location)/), ['public/m.html', 'public/retail-admin/01-core.js'], '/channel-status: desktop Sales and the phone');
    is(who(/retail-admin\/alipay-manual|'\/alipay-manual'/), ['public/m.html', 'public/retail-admin/02-settings-ops.js', 'public/retail-admin/17-setup-guide.js'],
      '/alipay-manual: Settings and the setup guide write, the phone reads');
    is(who(/fapiao-settings/), [], '/fapiao-settings: no screen');
    is(who(/qingyun\/(autopush|request)/), ['public/retail-admin/02-settings-ops.js'], 'Qingyun: the Delivery panel');
    is(who(/page-templates/), ['public/product-editor.html'], 'page templates: the product editor');
    is(who(/retail-admin\/setup['"`]/), ['public/retail-admin/17-setup-guide.js'], '/setup: the desktop guide (the phone only reads it)');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
