#!/usr/bin/env node
/**
 * §412.3 — CHOOSING A BILLING PLAN DOES NOT MAKE A PAID SHOP PAST DUE.
 *
 *   node scripts/test_billing_plan_keeps_paid_period.js
 *
 * POST /api/backend/billing/select-plan (routes/billing-pay.js) used to set the
 * subscription to past_due the moment it raised the new plan's invoice — even
 * for a shop paid up to a date weeks away. Now a subscription that is active
 * and paid to a date still ahead keeps that status and period; the new plan's
 * invoice covers the period starting when the paid one ends, and is owed from
 * then. The lifecycle's renewal at that date raises no second invoice. Any
 * other shop is unchanged: the invoice starts now and it waits as past_due.
 *
 * The real routers and the real lifecycle over a scratch database.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

(async () => {
  const express = require('express');
  const app = express();
  let who = null;
  app.use((req, _res, next) => { req.session = who ? { backendUserId: who.id, tenantId: who.tenant } : {}; next(); });
  app.use(require(path.join(ROOT, 'routes', 'billing.js')));
  app.use(require(path.join(ROOT, 'routes', 'billing-pay.js')));
  const { runBillingLifecycle } = require(path.join(ROOT, 'lib', 'billing-lifecycle'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const plan = (code) => db.prepare('SELECT * FROM billing_plans WHERE code = ?').get(code);
  let n = 0;
  function shop(sub) {
    const t = Number(db.prepare("INSERT INTO tenants (name, status) VALUES (?, 'active')").run('__q3_' + (++n)).lastInsertRowid);
    const u = Number(db.prepare("INSERT INTO tenant_users (tenant_id, username, password, role, is_active) VALUES (?, ?, 'x', 'owner', 1)").run(t, '__q3_owner' + n).lastInsertRowid);
    let subId = null;
    if (sub) {
      subId = Number(db.prepare(`INSERT INTO billing_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, is_internal)
                                 VALUES (?, ?, ?, ?, ?, 0)`).run(t, plan('starter').id, sub.status, sub.start || '2026-01-01 00:00:00', sub.end || null).lastInsertRowid);
    }
    return { tenant: t, id: u, subId };
  }
  const choose = async (s, code) => {
    who = s;
    const r = await fetch(base + '/api/backend/billing/select-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_code: code }) });
    return { status: r.status, body: await r.json() };
  };
  const sub = (s) => db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(s.tenant);
  const invoices = (s) => db.prepare('SELECT * FROM billing_invoices WHERE tenant_id = ? ORDER BY id').all(s.tenant);

  try {
    section('1 · a shop paid up to a date ahead');
    const END = '2099-03-01 00:00:00';
    const paid = shop({ status: 'active', end: END });
    let r = await choose(paid, 'growth');
    is(r.status, 200, 'the plan is chosen');
    is(sub(paid).status, 'active', 'the subscription stays active — not past due');
    is(sub(paid).current_period_end, END, 'and keeps its paid period');
    is(sub(paid).plan_id, plan('growth').id, 'it renews onto the new plan');
    const inv = invoices(paid);
    is(inv.length, 1, 'one invoice is raised');
    is([inv[0].period_start, inv[0].due_date, inv[0].status], [END, END, 'open'], 'it covers the period from the paid end, and is owed from then');
    is(inv[0].period_end, '2099-04-01 00:00:00', '…for one month of the new plan');
    is(inv[0].amount_cents, plan('growth').price_cents, '…at the new plan\'s price');
    is([r.body.deferred, r.body.owedFrom], [true, END], 'the answer says so');

    section('2 · choosing again for the same next period replaces the first choice');
    r = await choose(paid, 'pro');
    const inv2 = invoices(paid);
    is(inv2.map((x) => x.status), ['void', 'open'], 'the earlier choice\'s invoice is voided, the new one open');
    is(inv2[1].amount_cents, plan('pro').price_cents, 'the open one is the latest plan');
    is(sub(paid).status, 'active', 'still active');

    section('3 · at the paid end, the lifecycle raises nothing more, and the ladder runs as for any renewal');
    runBillingLifecycle(new Date('2099-03-02T00:00:00Z'));
    is(invoices(paid).filter((x) => x.status === 'open').length, 1, 'no second invoice for the same period');
    is(sub(paid).status, 'past_due', 'unpaid when the paid period ends: past due, as any unpaid renewal');

    section('4 · every other shop is unchanged: the invoice starts now, and it waits as past due');
    for (const [label, s] of [['no subscription', null], ['trialing', { status: 'trialing', end: END }], ['already past due', { status: 'past_due', end: END }],
      ['active with its paid period already over', { status: 'active', end: '2020-01-01 00:00:00' }]]) {
      const x = shop(s);
      r = await choose(x, 'growth');
      is(r.status, 200, label + ': chosen');
      is(sub(x).status, 'past_due', label + ': waits on the invoice as past due');
      const i = invoices(x)[0];
      ok(i && Math.abs(new Date(i.period_start.replace(' ', 'T') + 'Z') - Date.now()) < 60000, label + ': the invoice starts now');
      is(r.body.deferred, false, label + ': not deferred');
    }

    section('5 · an internal subscription is still refused');
    const roots = shop({ status: 'active', end: END });
    db.prepare('UPDATE billing_subscriptions SET is_internal = 1 WHERE id = ?').run(roots.subId);
    r = await choose(roots, 'growth');
    is(r.status, 400, 'internal plans are managed by Tacet');
  } catch (e) {
    fail++; console.log('  ✗ threw: ' + (e && e.stack || e));
  } finally {
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
