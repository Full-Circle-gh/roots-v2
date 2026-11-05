#!/usr/bin/env node
/**
 * §519 — Sales honours the store pin Dashboard already honours.
 *
 *   node scripts/test_sales_store_scope.js
 *
 * A shop-floor login pinned to Yuexiu still read every shop's takings on
 * Sales, and every location on the board painted from /channel-status. The
 * pin was on; those two routes ignored it.
 *
 * Two stores with different takings, over the real routes (retail.js,
 * meituan-admin.js, retail-shops.js) on a scratch database:
 *   1. unscoped: both stores, plus the shop's wallet top-up cash;
 *   2. Yuexiu-only: Yuexiu's orders only, top-up cash left out;
 *   3. a pin to no store: zeros;
 *   4. channel-status lists and writes only the pinned shop;
 *   5. the shops list the Sales cards use is held to the same pin;
 *   6. Add location is hidden when the login is pinned.
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
const meituan = require(path.join(ROOT, 'routes', 'meituan-admin.js'));
const shops = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const MEITUAN = fs.readFileSync(path.join(ROOT, 'routes', 'meituan-admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);
const near = (a, e, m) => ok(Math.abs(Number(a) - Number(e)) < 0.005, m, `expected ${e}, got ${a}`);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const TIANHE = 1, YUEXIU = 2;
for (const [id, en, cn] of [[TIANHE, 'Tianhe', '天河'], [YUEXIU, 'Yuexiu', '越秀']]) {
  db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone)
              VALUES (?,?,?,?,1,?,'Asia/Shanghai')`).run(id, en.toLowerCase(), en, cn, id);
}
db.prepare(`INSERT INTO retail_customers (id, openid, nickname) VALUES (601, 'o-601', 'A'), (602, 'o-602', 'B')`).run();

let oid = 9200;
function order(storeId, total, extra = {}) {
  const id = ++oid;
  db.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, store_id, fulfillment_type,
                subtotal, shipping_fee, total, channel, payment_method, paid_at, placed_at)
              VALUES (?,?,?,?,?,?,?,0,?,?,?,datetime('now','-1 hour'),datetime('now','-1 hour'))`)
    .run(id, 'SS' + id, extra.customer || 601, extra.status || 'paid', storeId,
      extra.fulfillment || 'delivery', total, total, extra.channel || 'wechat', extra.pay || 'wechat');
  return id;
}
// Tianhe: 2 mini-app orders, ¥200. Yuexiu: 1 mini-app ¥80, 1 till ¥27.
order(TIANHE, 120); order(TIANHE, 80);
order(YUEXIU, 80);
order(YUEXIU, 27, { fulfillment: 'counter', channel: 'shop', pay: 'cash' });

let hasTopups = true;
try {
  db.prepare(`INSERT INTO retail_topup_transactions (customer_id, amount, status, payment_method, paid_at)
              VALUES (601, 50, 'success', 'wechat', datetime('now','-1 hour'))`).run();
} catch (e) { hasTopups = false; console.log('  (no top-up table: ' + e.message + ')'); }
const TOPUP = hasTopups ? 50 : 0;

let nextId = 7600;
const ops = {};
function operator(name, { role = 'owner', stores = null } = {}) {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active, scope_all)
              VALUES (?, ?, ?, 'x', ?, 1, ?)`).run(id, TENANT, '__ss_' + name, role, stores ? 0 : 1);
  for (const s of stores || []) {
    db.prepare('INSERT INTO tenant_user_stores (tenant_user_id, store_id) VALUES (?, ?)').run(id, s);
  }
  ops[name] = id;
}
operator('owner');
operator('yuexiuFloor', { role: 'staff', stores: [YUEXIU] });
operator('nowhere', { role: 'staff', stores: [] });

(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(retail);
  app.use(meituan);
  app.use(shops);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (who, url) => {
    const r = await fetch(base + url, { headers: { 'x-op': String(ops[who]) } });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  };
  const post = async (who, url, body) => {
    const r = await fetch(base + url, {
      method: 'POST',
      headers: { 'x-op': String(ops[who]), 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  };

  try {
    section('0 · the routes read the pin');
    {
      const at = RETAIL.indexOf("router.get('/api/retail-admin/sales/summary'");
      const body = RETAIL.slice(at, RETAIL.indexOf('\nrouter.', at + 10));
      ok(/const salesStores = operatorCaps\.storeIdsOf\(req\)/.test(body), 'sales/summary resolves the pin');
      ok(/const scopedP  = \(w\) => \(SCOPED \? `\$\{w\} AND \$\{STORE_IN\}` : w\)/.test(body)
        || /const scopedP  = \(w\) => \(SCOPED \? `\(\$\{w\}\) AND \$\{STORE_IN\}` : w\)/.test(body),
        '…and wraps every channel predicate with it');
      ok(/storeAgg\(scopedP\(/.test(body) && /storeItems\(scopedPO\(/.test(body),
        'storeAgg and storeItems are called through the wrap, so the SQL template stays the one §186 pins');
      ok(MEITUAN.includes('csStoresInScope') && MEITUAN.includes('csRefuseStore'),
        'channel-status filters the grid and refuses a write outside the pin');
      ok(/Array\.isArray\(window\.RA_SCOPE_STORES\)/.test(CORE) && /salesAddLocation/.test(CORE),
        'Add location is hidden and refused when the login is pinned');
    }

    section('1 · unscoped: both stores, as before');
    const all = await get('owner', '/api/retail-admin/sales/summary');
    is(all.status, 200, 'owner can read Sales');
    is(all.j && all.j.summary && all.j.summary.orders, 4, 'four paid orders across the two stores');
    near(all.j && all.j.summary && all.j.summary.revenue, 120 + 80 + 80 + 27 + TOPUP,
      'revenue is both stores' + (TOPUP ? ' plus the shop\'s top-up cash' : ''));
    ok(!('store_scope' in (all.j || {})), 'no store_scope block on the every-store answer');
    is(all.j && all.j.channels && all.j.channels.wechat && all.j.channels.wechat.orders, 3,
      'mini-app card is the three wechat deliveries');
    is(all.j && all.j.channels && all.j.channels.pos && all.j.channels.pos.orders, 1,
      'POS card is the one till sale');

    section('2 · Yuexiu-only: Yuexiu\'s orders, no Tianhe, no top-up cash');
    const yx = await get('yuexiuFloor', '/api/retail-admin/sales/summary');
    is(yx.status, 200, 'the Yuexiu login can read Sales');
    is(yx.j && yx.j.summary && yx.j.summary.orders, 2, 'Yuexiu: its two orders');
    near(yx.j && yx.j.summary && yx.j.summary.revenue, 80 + 27, 'Yuexiu: ¥107, with no top-up cash folded in');
    is(yx.j && yx.j.channels && yx.j.channels.wechat && yx.j.channels.wechat.orders, 1,
      'mini-app card is Yuexiu\'s one delivery');
    is(yx.j && yx.j.channels && yx.j.channels.pos && yx.j.channels.pos.orders, 1,
      'POS card is Yuexiu\'s till sale');
    is(yx.j && yx.j.store_scope && yx.j.store_scope.store_ids, [YUEXIU], 'store_scope names Yuexiu');
    ok(yx.j && yx.j.store_scope && yx.j.store_scope.left_out.includes('topups_received'),
      '…and says the shop-wide cash was left out');
    near(yx.j && yx.j.summary && yx.j.summary.topups_received, 0, 'top-up cash is zero on a pinned answer');

    section('3 · a pin to no store sees zeros');
    const none = await get('nowhere', '/api/retail-admin/sales/summary');
    is(none.j && none.j.summary && none.j.summary.orders, 0, 'no orders');
    near(none.j && none.j.summary && none.j.summary.revenue, 0, 'no revenue');

    section('4 · channel-status lists only the pinned shop');
    const gridAll = await get('owner', '/api/retail-admin/channel-status');
    const ownerLocs = ((gridAll.j && gridAll.j.locations) || []).map((l) => l.storeCode).sort();
    ok(ownerLocs.indexOf('tianhe') !== -1 && ownerLocs.indexOf('yuexiu') !== -1,
      'unscoped locations name both shops');
    const gridYx = await get('yuexiuFloor', '/api/retail-admin/channel-status');
    is(((gridYx.j && gridYx.j.locations) || []).map((l) => l.storeCode), ['yuexiu'],
      'Yuexiu login: one location card, Yuexiu');
    const wechatCells = (((gridYx.j && gridYx.j.channels) || []).find((c) => c.channel === 'mini_app') || {}).cells || [];
    is(wechatCells.map((c) => c.storeCode), ['yuexiu'],
      '…and each channel\'s where-line is Yuexiu alone');
    const gridNone = await get('nowhere', '/api/retail-admin/channel-status');
    is(((gridNone.j && gridNone.j.locations) || []).length, 0, 'a pin to no store lists no locations');

    section('5 · a write outside the pin is refused');
    const cellOther = await post('yuexiuFloor', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'tianhe', open: false });
    is([cellOther.status, cellOther.j && cellOther.j.error], [403, 'forbidden_store'],
      'closing Tianhe POS from the Yuexiu login is refused');
    const locOther = await post('yuexiuFloor', '/api/retail-admin/channel-status/location',
      { storeCode: 'tianhe', open: false });
    is([locOther.status, locOther.j && locOther.j.error], [403, 'forbidden_store'],
      'closing Tianhe whole from the Yuexiu login is refused');
    const cellMine = await post('yuexiuFloor', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: true });
    is(cellMine.status, 200, 'the same login can still switch Yuexiu');
    const chAll = await post('yuexiuFloor', '/api/retail-admin/channel-status/channel',
      { channel: 'web', open: false });
    is(chAll.status, 200, 'a channel-wide write is allowed');
    is(chAll.j && chAll.j.stores, ['yuexiu'], '…and only names Yuexiu');

    section('6 · the shops list the Sales cards use is held to the same pin');
    const shopsAll = await get('owner', '/api/retail-admin/shops');
    const allCodes = ((shopsAll.j && shopsAll.j.data) || []).map((r) => r.location && r.location.code);
    ok(allCodes.indexOf('tianhe') !== -1 && allCodes.indexOf('yuexiu') !== -1,
      'unscoped shops list names both locations');
    const shopsYx = await get('yuexiuFloor', '/api/retail-admin/shops');
    is(((shopsYx.j && shopsYx.j.data) || []).map((r) => r.location && r.location.code), ['yuexiu'],
      'Yuexiu login: the shops list is Yuexiu alone');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
