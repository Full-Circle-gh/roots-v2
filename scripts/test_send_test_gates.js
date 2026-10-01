#!/usr/bin/env node
/**
 * §325 step S2h — THE TEST BUTTONS THAT SEND SOMETHING REAL NEED A PERMISSION.
 *
 *   node scripts/test_send_test_gates.js
 *
 * POST /printer/test prints a ticket; /integrations/aliyun_sms/test sends an
 * SMS; /wecom/test and /system-alerts/test post into a WeCom group;
 * /integrations/kd100/test and /integrations/jd/test call a courier's API.
 * None matched a rule, so anyone signed in could make them. Each now takes the
 * keys of the panel its button sits on — the same keys as the save beside it —
 * and nobody who can press one today loses it.
 *
 * The real router over a scratch database, enforcement on, each operator's
 * keys real tenant_user_caps grants resolved by the real requireRetailAdmin.
 * The allow side asserts "not a refusal": with no printer, courier or webhook
 * configured, what a permitted test then says is the handler's business.
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
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);
let nextId = 7950;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2h_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
}
operator('orders', ['orders:view', 'orders:edit']);
operator('push', ['settings:push']);
operator('shop', ['settings:shop']);
operator('delivery', ['delivery:view']);
operator('shipping', ['shipping:config']);
operator('owner', [], 'owner');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config', 'delivery:view'];
const DELIVERY = ['delivery:view', 'delivery:edit', 'shipping:config'];
// [path, keys, body, an account that may, an account that may not]
const CASES = [
  ['/printer/test', SETTINGS, { store_id: 999999 }, 'shop', 'orders', 'the printer card, Settings → Operations'],
  ['/integrations/aliyun_sms/test', SETTINGS, { phone: '13800000000' }, 'push', 'orders', 'SMS, Settings → Push'],
  ['/wecom/test', SETTINGS, { webhook: '' }, 'push', 'orders', 'the WeCom webhook, Settings → Push'],
  ['/system-alerts/test', SETTINGS, { webhook: '' }, 'push', 'orders', 'system alerts, Settings → Push'],
  ['/integrations/kd100/test', DELIVERY, null, 'delivery', 'push', 'kd100, the Delivery panel'],
  ['/integrations/jd/test', DELIVERY, null, 'shipping', 'push', 'JD, the Delivery panel'],
];

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(retail);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, p, body) => {
    const r = await fetch(base + '/api/retail-admin' + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    section('1 · the rules');
    for (const [p, keys, , , , what] of CASES) is(requiredCapFor('POST', '/api/retail-admin' + p), keys, `${p}: ${what}`);
    is(requiredCapFor('POST', '/api/retail-admin/integrations/kd100/test/x'), null, 'the rules are exact');
    is(requiredCapFor('GET', '/api/retail-admin/printer/test'), null, 'reads stay open');

    section('2 · refused, and let through, over HTTP');
    for (const [p, , body, may, mayNot] of CASES) {
      const no = await call(mayNot, p, body);
      is(no.status, 403, `${p}: the ${mayNot} account is refused`);
      is(no.body && no.body.error, 'forbidden_capability', '…in the choke point\'s words');
      const yes = await call(may, p, body);
      ok(yes.status !== 403, `${p}: the ${may} account gets past the gate (got ${yes.status})`, JSON.stringify(yes.body));
      const own = await call('owner', p, body);
      ok(own.status !== 403, `${p}: the owner is never refused (got ${own.status})`);
    }
    db.prepare('UPDATE tenants SET rbac_enforce = 0 WHERE id = ?').run(TENANT);
    const off = await call('orders', '/wecom/test', { webhook: '' });
    ok(off.status !== 403, `enforcement off: nothing changes (got ${off.status})`);
    db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);

    section('3 · the buttons, on the panels the gates name');
    const html = read('public/retail-admin.html');
    const panelOf = (needle) => {
      const at = html.indexOf(needle);
      const p = html.lastIndexOf('class="sub-panel', at);
      const v = html.lastIndexOf('class="dlv-view"', at);
      return { at, sub: (html.slice(p, p + 60).match(/id="(sub-[a-z]+)"/) || [])[1], dlv: v > p ? (html.slice(v, v + 80).match(/data-dlv="([a-z]+)"/) || [])[1] : null };
    };
    is(panelOf('onclick="testWecomWebhook()"').sub, 'sub-push', 'the WeCom test sits in Settings → Push');
    is(panelOf('onclick="_testAliyunSms()"').sub, 'sub-push', 'the SMS test sits in Settings → Push');
    is(panelOf('onclick="_testSystemAlert()"').sub, 'sub-push', 'the system-alert test sits in Settings → Push');
    is(panelOf('onclick="_testKd100()"').sub, 'sub-delivery', 'the kd100 test sits on the Delivery panel');
    is(panelOf('onclick="_testJd()"').sub, 'sub-delivery', 'the JD test sits on the Delivery panel');
    is(panelOf('id="feie-stores"').sub, 'sub-ops', 'the printer test is drawn into the printer card, Settings → Operations');
    ok(/data-sub="delivery" data-cap="delivery:view"/.test(html), 'the Delivery panel opens on delivery:view');
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = d + '/' + e.name;
      if (e.isDirectory()) walk(rel); else if (/\.(html|js)$/.test(e.name)) files.push(rel);
    } };
    walk('public');
    const who = (re) => files.filter((f) => re.test(read(f))).sort();
    is(who(/printer\/test|kd100\/test|jd\/test|aliyun_sms\/test|wecom\/test|system-alerts\/test/).filter((f) => f !== 'public/m.html'),
      ['public/retail-admin/02-settings-ops.js', 'public/retail-admin/05-marketing.js'], 'the desktop callers are the two settings modules');
    const M = read('public/m.html');
    if (/printer\/test/.test(M)) {
      ok(/ROUTE_CAP=\{[\s\S]*settings:\['settings:shop','settings:push','settings:payments','stores:view','shipping:config'\]/.test(M),
        'the phone\'s test print sits behind Settings, whose keys are all admitted');
    }
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
