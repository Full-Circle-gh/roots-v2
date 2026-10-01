#!/usr/bin/env node
/**
 * §325 step S2l — BILLING NEEDS A PERMISSION.
 *
 *   node scripts/test_billing_gates.js
 *
 * Every /api/backend/billing* route (routes/billing.js, routes/billing-pay.js)
 * took any signed-in operator, so anyone in the back office could raise an
 * invoice, change the shop's plan or start a checkout. They now take the keys
 * that open a screen using them today: billing:view (the desktop Settings link
 * to the Billing page, whose page then draws Choose for whoever is on it) or
 * billing:pay (the phone's Choose). The owner holds every key. Two doors reach
 * the desktop Billing page with no key at all — a suspended shop and the
 * provisioning hold both send EVERY operator there to pay — and they stay open,
 * so nobody who can pay from a screen today loses it.
 *
 * The real routers over a scratch database, real sessions, each operator's keys
 * real tenant_user_caps grants resolved the way requireCap resolves them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { billingCap } = require(path.join(ROOT, 'lib', 'cap-routes'));
const tenantDb = require(path.join(ROOT, 'lib', 'tenant-db'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const ROOTS = tenantDb.ROOTS_TENANT_ID;
if (!db.prepare('SELECT id FROM tenants WHERE id = ?').get(ROOTS)) db.prepare("INSERT INTO tenants (id, status) VALUES (?, 'active')").run(ROOTS);
db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(ROOTS);
const OTHER = Number(db.prepare("INSERT INTO tenants (name, status) VALUES ('__s2l_other', 'active')").run().lastInsertRowid);

let nextId = 7900;
const ops = {};
function operator(name, caps, role = 'custom', tenant = ROOTS) {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, tenant, '__s2l_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(tenant, id, k);
  }
  ops[name] = { id, tenant };
}
operator('orders', ['orders:view', 'orders:edit']);
operator('nothing', []);
operator('view', ['billing:view']);
operator('pay', ['billing:pay']);
operator('owner', [], 'owner');
operator('admin', [], 'admin');        // the preset: billing:view, not billing:pay
operator('staff', [], 'staff');        // the preset: neither
operator('otherStaff', [], 'staff', OTHER);

const invoices = () => db.prepare('SELECT COUNT(*) AS c FROM billing_invoices').get().c;
const PLAN = () => db.prepare("SELECT code FROM billing_plans WHERE is_active = 1 AND is_public = 1 ORDER BY sort_order LIMIT 1").get();

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => {
    const o = Object.values(ops).find((x) => x.id === Number(req.get('x-op')));
    req.session = o ? { backendUserId: o.id, tenantId: o.tenant } : {};
    next();
  });
  app.use(require(path.join(ROOT, 'routes', 'billing.js')));
  app.use(require(path.join(ROOT, 'routes', 'billing-pay.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', 'x-op': String(who ? ops[who].id : 0) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const plan = PLAN();
  const ROUTES = () => [
    ['GET', '/api/backend/billing'], ['GET', '/api/backend/plans'], ['GET', '/api/backend/billing/providers'],
    ['POST', '/api/backend/billing/select-plan', { plan_code: plan ? plan.code : 'starter' }],
    ['POST', '/api/backend/billing/checkout', { invoice_id: 999999, provider: 'manual' }],
    ['GET', '/api/backend/billing/invoices/999999/payment-status'],
  ];

  try {
    section('1 · the rule, and where it is applied');
    is(billingCap(), ['billing:view', 'billing:pay'], 'billing:view (the desktop link) or billing:pay (the phone\'s Choose)');
    ok(/<a href="\/backend\/billing" data-cap="billing:view">/.test(read('public/retail-admin.html')), 'the desktop door is billing:view');
    const M = read('public/m.html');
    ok(/billing:'billing:view',/.test(M) && M.includes("mCanKnown('billing:pay')"), 'the phone opens on billing:view and chooses on billing:pay');
    for (const [file, re] of [['routes/billing.js', /router\.get\('\/api\/backend\/billing', requireBillingAccess,/],
      ['routes/billing.js', /router\.get\('\/api\/backend\/plans', requireBillingAccess,/],
      ['routes/billing-pay.js', /router\.get\('\/api\/backend\/billing\/providers', requireBillingAccess,/],
      ['routes/billing-pay.js', /router\.post\('\/api\/backend\/billing\/select-plan', requireBillingAccess,/],
      ['routes/billing-pay.js', /router\.post\('\/api\/backend\/billing\/checkout', requireBillingAccess,/],
      ['routes/billing-pay.js', /router\.get\('\/api\/backend\/billing\/invoices\/:id\/payment-status', requireBillingAccess,/]]) {
      ok(re.test(read(file)), 'gated: ' + re.source.replace(/\\/g, '').slice(13, 70));
    }
    ok(!/requireBackend/.test(read('routes/billing.js')) && !/requireBackend/.test(read('routes/billing-pay.js')), 'no billing route is left on a bare session check');
    ok(/router\.post\('\/api\/backend\/billing\/invoices\/:id\/mark-paid', requireSaasAdmin,/.test(read('routes/billing-pay.js')), 'mark-paid stays SaaS-admin only');

    section('2 · refused: an operator who can open no Billing screen, in an active shop');
    for (const who of ['orders', 'nothing', 'staff']) {
      const before = invoices();
      for (const [m, p, b] of ROUTES()) {
        const r = await call(who, m, p, b);
        is(r.status, 403, `${who}: ${m} ${p.replace('/api/backend', '')} is refused`);
      }
      is(invoices(), before, `${who}: …and no invoice was raised`);
    }

    section('3 · let through: both screens\' keys, the admin preset that has the desktop link, and the owner');
    for (const who of ['view', 'pay', 'admin', 'owner']) {
      for (const [m, p, b] of ROUTES()) {
        const r = await call(who, m, p, b);
        ok(r.status !== 403 && r.status !== 401, `${who}: ${m} ${p.replace('/api/backend', '')} is not refused (${r.status})`);
      }
    }
    const r1 = await call('view', 'GET', '/api/backend/billing');
    ok(r1.status === 200 && r1.body && r1.body.success === true, 'and a permitted read answers');

    section('4 · the keyless doors stay open');
    db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run(ROOTS);
    for (const [m, p, b] of ROUTES()) {
      const r = await call('staff', m, p, b);
      ok(r.status !== 403, `a suspended shop's staff (sent to Billing to pay): ${m} ${p.replace('/api/backend', '')} (${r.status})`);
    }
    db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(ROOTS);
    is((await call('staff', 'GET', '/api/backend/billing')).status, 403, 'back to active, the door shuts again');
    if (!tenantDb.DATA_ISOLATION_READY) {
      const before = invoices();
      const r = await call('otherStaff', 'POST', '/api/backend/billing/select-plan', { plan_code: plan.code });
      ok(r.status === 200, `the provisioning hold sends every operator of a new shop to Billing, so they still pass (${r.status})`);
      is(invoices(), before + 1, '…and their invoice is raised');
    } else {
      ok(true, 'isolation is on here, so the provisioning hold is not a door');
    }
    ok(/redirect\('\/backend\/billing\?suspended=1'\)/.test(read('server.js')) && /redirect\('\/backend\/billing\?provisioning=1'\)/.test(read('server.js')),
      'the two doors these keep open are still the server\'s own redirects');

    section('5 · nobody signed in');
    for (const [m, p, b] of ROUTES()) is((await call(null, m, p, b)).status, 401, `${m} ${p.replace('/api/backend', '')} is 401`);
  } catch (e) {
    fail++; console.log('  ✗ threw: ' + (e && e.stack || e));
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
