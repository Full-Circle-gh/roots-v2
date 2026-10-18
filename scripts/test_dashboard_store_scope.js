#!/usr/bin/env node
/**
 * §325 step S2b — THE DASHBOARD ANSWERS FOR THE STORE IT IS ASKED ABOUT.
 *
 *   node scripts/test_dashboard_store_scope.js
 *
 * GET /api/retail-admin/dashboard read `store_id` into its cache key and
 * nowhere else. The desktop's store picker and store lock and the phone
 * Trend's store select (§317) all named one store and showed every store's
 * figures — which also made §317's "this closes a leak" untrue: a store-scoped
 * operator pinned to their store still read the whole shop.
 *
 * Two stores with different takings, over the real routes/retail.js on a
 * scratch database:
 *   1. every store: the answer is the sum of the two plus the shop's wallet
 *      top-up cash, and carries no store_scope block (unchanged shape);
 *   2. one store: only that store's orders, top-up cash left out, conversion
 *      null, and a store_scope block naming what was covered;
 *   3. a store-scoped operator: held to their store whatever they ask for,
 *      and an operator scoped to no store sees nothing;
 *   4. the cache never answers one store with another's copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router = require(path.join(ROOT, 'routes', 'retail.js'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);
const near = (a, e, m) => ok(Math.abs(Number(a) - Number(e)) < 0.005, m, `expected ${e}, got ${a}`);

/* ── fixtures ──────────────────────────────────────────────────────────── */
const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const TIANHE = 1, YUEXIU = 2;
for (const [id, en] of [[TIANHE, 'Tianhe'], [YUEXIU, 'Yuexiu']]) {
  // Zoned as Roots' real stores are: the dashboard's default window is the
  // shop's day, and a shop with no zone has none (§82).
  db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone)
              VALUES (?,?,?,?,1,?,'Asia/Shanghai')`).run(id, en.toLowerCase(), en, en, id);
}
db.prepare(`INSERT INTO retail_customers (id, openid, nickname) VALUES (501, 'o-501', 'A'), (502, 'o-502', 'B')`).run();
let oid = 8100;
function order(storeId, total, customer, extra = {}) {
  const id = ++oid;
  db.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, store_id, fulfillment_type,
                subtotal, shipping_fee, total, channel, payment_method, paid_at, placed_at)
              VALUES (?,?,?,?,?,?,?,0,?,?,?,datetime('now','-1 hour'),datetime('now','-1 hour'))`)
    .run(id, 'DS' + id, customer, extra.status || 'paid', storeId, extra.fulfillment || 'delivery',
      total, total, extra.channel || 'wechat', extra.pay || 'wechat');
  return id;
}
// Tianhe: 3 paid orders, ¥300. Yuexiu: 1 paid order, ¥1000, one refund.
order(TIANHE, 100, 501); order(TIANHE, 120, 501); order(TIANHE, 80, 502, { pay: 'cash' });
order(YUEXIU, 1000, 502);
order(YUEXIU, 55, 502, { status: 'refunded' });
// ¥200 of wallet top-up cash, paid to the shop, not to a store.
let hasTopups = true;
try {
  db.prepare(`INSERT INTO retail_topup_transactions (customer_id, amount, status, payment_method, paid_at)
              VALUES (501, 200, 'success', 'wechat', datetime('now','-1 hour'))`).run();
} catch (e) { hasTopups = false; console.log("  (no top-up table: " + e.message + ")"); }
const TOPUP = hasTopups ? 200 : 0;
// A mini-app session, shop-wide.
try { db.prepare(`INSERT INTO retail_visits (session_id, created_at) VALUES ('s1', datetime('now','-1 hour'))`).run(); } catch (e) { /* optional */ }

let nextId = 7400;
const ops = {};
function operator(name, { role = 'owner', stores = null } = {}) {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active, scope_all)
              VALUES (?, ?, ?, 'x', ?, 1, ?)`).run(id, TENANT, '__s2b_' + name, role, stores ? 0 : 1);
  for (const s of stores || []) db.prepare('INSERT INTO tenant_user_stores (tenant_user_id, store_id) VALUES (?, ?)').run(id, s);
  ops[name] = id;
}
operator('owner');
operator('office', { role: 'admin' });
operator('tianheManager', { role: 'store_manager', stores: [TIANHE] });
operator('nowhere', { role: 'store_manager', stores: [] });

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const dash = async (who, qs = '') => {
    const r = await fetch(base + '/api/retail-admin/dashboard?' + qs, { headers: { 'x-op': String(ops[who]) } });
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || !j || !j.data) throw new Error('dashboard ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    return j.data;
  };

  try {
    section('0 · the route reads the store, and the every-store SQL is what it was');
    {
      const route = RETAIL.slice(RETAIL.indexOf("router.get('/api/retail-admin/dashboard'"));
      const body = route.slice(0, route.indexOf("router.get('", 10));
      ok(/const dashStores = dashStoreScope\(req\);/.test(body), 'the handler resolves its stores');
      ok(/const PAID_ALL = scopedP\(financeWindow\.PAID\);/.test(body), 'the paid predicate is narrowed through one helper');
      ok(/const scopedP  = \(w\) => \(SCOPED \? `\(\$\{w\}\) AND \$\{STORE_IN\}` : w\);/.test(body),
        '…which returns the predicate untouched when no store is chosen');
      ok(!/req\.query\.store_id \|\| ''/.test(body), 'the cache key no longer carries the raw query');
    }

    section('1 · every store: the shop\'s answer, unchanged in shape');
    ok(hasTopups, 'the shop has ¥200 of wallet top-up cash in the window (the fixture took)');
    const all = await dash('owner');
    is(all.kpis.orders, 4, 'four paid orders across the two stores');
    near(all.kpis.revenue, 300 + 1000 + TOPUP, 'revenue is both stores plus the shop\'s top-up cash');
    ok(!('store_scope' in all), 'no store_scope block on the every-store answer');
    is(all.stores.map((s) => s.store_id).sort(), [TIANHE, YUEXIU], 'the store breakdown lists both');
    near(all.topups.received, TOPUP, 'top-up cash is reported');
    const allAgain = await dash('owner', 'store_id=all');
    is(allAgain.kpis, all.kpis, 'store_id=all is every store');

    section('2 · one store');
    const th = await dash('office', 'store_id=' + TIANHE);
    is(th.kpis.orders, 3, 'Tianhe: its three orders');
    near(th.kpis.revenue, 300, 'Tianhe: ¥300, with no top-up cash folded in');
    near(th.kpis.aov, 100, 'Tianhe: its own average');
    is(th.stores.map((s) => s.store_id), [TIANHE], 'the store breakdown is Tianhe alone');
    is(th.kpis.refunded_orders, 0, 'Yuexiu\'s refund is not Tianhe\'s');
    near(th.topups.received, 0, 'top-up cash is left out of a store');
    is(th.kpis.conversion_rate, null, 'conversion is null: a store\'s orders over the shop\'s sessions would mix populations');
    is(th.mini_app.conversion_rate, null, '…in the mini-app block too');
    is(th.store_scope && th.store_scope.store_ids, [TIANHE], 'store_scope names the store covered');
    ok(th.store_scope && th.store_scope.shop_wide.includes('sessions') && th.store_scope.left_out.includes('topups_received'),
      '…and says which figures are shop-wide and which were left out');
    const payTotal = th.payments.reduce((s, p) => s + p.revenue, 0);
    near(payTotal, 300, 'the payment split adds up to the store\'s takings');
    near(th.trend.reduce((s, t) => s + Number(t.revenue || 0), 0), 300, 'the trend adds up to it too');
    ok(th.topCustomers.every((c) => [501, 502].includes(c.customer_id)) && th.topCustomers.length === 2, 'top customers are Tianhe\'s buyers');

    const yx = await dash('office', 'store_id=' + YUEXIU);
    is(yx.kpis.orders, 1, 'Yuexiu: one order');
    near(yx.kpis.revenue, 1000, 'Yuexiu: ¥1000');
    is(yx.kpis.refunded_orders, 1, 'Yuexiu: its refund');
    near(th.kpis.revenue + yx.kpis.revenue + TOPUP, all.kpis.revenue, 'the two stores and the top-up cash add up to the shop');

    section('3 · a store-scoped operator is held to their store');
    const mine = await dash('tianheManager');
    is(mine.kpis.orders, 3, 'asking for nothing, the Tianhe manager reads Tianhe');
    is(mine.store_scope.store_ids, [TIANHE], '…and is told so');
    const other = await dash('tianheManager', 'store_id=' + YUEXIU);
    is(other.kpis.orders, 3, 'asking for Yuexiu, they still read Tianhe — never another store');
    is(other.store_scope.store_ids, [TIANHE], '…and the answer says which store it is');
    const none = await dash('nowhere');
    is(none.kpis.orders, 0, 'an operator scoped to no store sees no orders');
    near(none.kpis.revenue, 0, '…and no revenue');

    section('4 · the cache keeps stores apart');
    const th2 = await dash('office', 'store_id=' + TIANHE);
    const yx2 = await dash('office', 'store_id=' + YUEXIU);
    const all2 = await dash('owner');
    is([th2.kpis.orders, yx2.kpis.orders, all2.kpis.orders], [3, 1, 4], 'three answers from three cache entries');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
