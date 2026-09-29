#!/usr/bin/env node
/**
 * §288 — THE QR MENU HAS ITS OWN CATEGORY ORDER, AND CAN HIDE A CATEGORY.
 *
 *   node scripts/test_qr_menu_category_order.js
 *
 * Ash, 2026-09-29: *"tenant should be able to organize the left menu as he
 * pleased regardless the way its organized on the mini app"*; *"same order in
 * every location"*; yes to hiding a category on the QR menu only.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. UNSET MEANS THE MINI APP'S ORDER, exactly. Nothing moves on the day this
 *     ships.
 *  2. A STORED ORDER MOVES THE QR RAIL AND THE SECTIONS, rendered through the
 *     real router against a real database.
 *  3. THE TREE IS NOT TOUCHED. The mini app reads category.tree; its bytes are
 *     the same after every write this suite makes.
 *  4. A HIDDEN CATEGORY TAKES ITS PRODUCTS WITH IT. They do not fall into the
 *     OTHER band, which is where a product with an unknown category goes and
 *     where a careless filter would send them.
 *  5. A CATEGORY THE ORDER DOES NOT NAME (added later) SHOWS AT THE BOTTOM, and
 *     an id the tree no longer has is skipped rather than breaking the menu.
 *  6. THE ADMIN WRITE is gated on categories:edit and refuses a body with no
 *     `tops` — `tops: null` is "follow the mini app", a real answer.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

const rawDb = require(path.join(ROOT, 'database.js'));
// Creates tenants / tenant_users at require time. Loaded here so the admin half
// does not depend on some earlier suite having created them on this database.
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const O = require(path.join(ROOT, 'lib', 'qr-menu-category-order.js'));
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));
const menuRouter = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

// ── Pure: the resolver ─────────────────────────────────────────────────────
const TREE = [
  { id: 'qa', name: 'QRO Toasts', name_cn: '测试吐司', subs: [
    { id: 'qa1', name: 'QRO Sweet', name_cn: '测试甜' },
    { id: 'qa2', name: 'QRO Savoury', name_cn: '测试咸' },
  ] },
  { id: 'qb', name: 'QRO Drinks', name_cn: '测试饮品', subs: [] },
  { id: 'qc', name: 'QRO Wellness', name_cn: '测试健康', subs: [] },
];
const names = (t) => t.map(x => x.name);

console.log('\nThe resolver');
check('no order follows the tree exactly', () => {
  const r = O.applyToTree(TREE, O.normalise(null));
  assert.deepStrictEqual(names(r.tree), ['QRO Toasts', 'QRO Drinks', 'QRO Wellness']);
  assert.strictEqual(r.hiddenNames.size, 0);
});
check('a stored order reorders tops and subs', () => {
  const r = O.applyToTree(TREE, { tops: ['qc', 'qa', 'qb'], subs: { qa: ['qa2', 'qa1'] } });
  assert.deepStrictEqual(names(r.tree), ['QRO Wellness', 'QRO Toasts', 'QRO Drinks']);
  assert.deepStrictEqual(r.tree[1].subs.map(s => s.id), ['qa2', 'qa1']);
});
check('the tree passed in is not mutated', () => {
  const before = JSON.stringify(TREE);
  O.applyToTree(TREE, { tops: ['qc', 'qb', 'qa'], subs: { qa: ['qa2', 'qa1'] }, hidden: ['qb'] });
  assert.strictEqual(JSON.stringify(TREE), before);
});
check('a node the order does not name goes last; an unknown id is skipped', () => {
  const r = O.applyToTree(TREE, { tops: ['gone', 'qc', 'qb'] });
  assert.deepStrictEqual(names(r.tree), ['QRO Wellness', 'QRO Drinks', 'QRO Toasts']);
});
check('hidden tops are dropped and their names returned', () => {
  const r = O.applyToTree(TREE, { tops: null, hidden: ['qb'] });
  assert.deepStrictEqual(names(r.tree), ['QRO Toasts', 'QRO Wellness']);
  assert.ok(r.hiddenNames.has('QRO Drinks'));
});
check('malformed values fall back to "follow, hide nothing", never to an empty menu', () => {
  for (const bad of [null, 7, 'x', [], { tops: 'no' }, { tops: [], subs: [1], hidden: 'qb' }]) {
    const n = O.normalise(bad);
    assert.strictEqual(n.tops, null, JSON.stringify(bad));
    assert.deepStrictEqual(n.hidden, []);
    assert.strictEqual(O.applyToTree(TREE, n).tree.length, 3);
  }
});

console.log('\nThe admin write');
check('PUT is gated on categories:edit, GET is a read', () => {
  assert.strictEqual(requiredCapFor('PUT', '/api/retail-admin/category-tree/qr-order'), 'categories:edit');
  assert.strictEqual(requiredCapFor('GET', '/api/retail-admin/category-tree/qr-order'), null);
});

// ── Real database, real routers ────────────────────────────────────────────
const LOC = 8871;
const OP = 8891;     // the operator the admin half signs in as
const P = { sweet: 8881, savoury: 8882, drink: 8883, well: 8884, later: 8885 };
const PRODS = Object.values(P);
const CODE = 'QRXRDER2';   // no O or I: lib/shop-code.js's alphabet leaves them out
const KEYS = ['category.tree', O.CONFIG_KEY];
const saved = new Map();

function setCfg(k, v) {
  db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(k, JSON.stringify(v));
}
function delCfg(k) { db.prepare('DELETE FROM storefront_config WHERE key = ?').run(k); }
function rawCfg(k) {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
  return r ? r.value_json : null;
}

function cleanup() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODS.map(() => '?').join(',')})`).run(...PRODS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}
function seed() {
  cleanup();
  db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
              VALUES (?, '__test_qr_order', 'QR order fixture', '测试顺序店', 1, 97)`).run(LOC);
  const prod = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category, subcategory)
    VALUES (?, ?, ?, ?, 10, 1, 1, ?, ?)`);
  prod.run(P.sweet,   'Fixture QRO sweet',   '测试甜品', '__QRO-1', 'QRO Toasts',   'QRO Sweet');
  prod.run(P.savoury, 'Fixture QRO savoury', '测试咸品', '__QRO-2', 'QRO Toasts',   'QRO Savoury');
  prod.run(P.drink,   'Fixture QRO drink',   '测试饮料', '__QRO-3', 'QRO Drinks',   null);
  prod.run(P.well,    'Fixture QRO well',    '测试健康品', '__QRO-4', 'QRO Wellness', null);
  prod.run(P.later,   'Fixture QRO later',   '测试新品', '__QRO-5', 'QRO Later',    null);
  db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, 10, 'made_here', 1, ?)`);
  PRODS.forEach((id, i) => add.run(shopId, id, i));
}

let SESSION = null;
const app = express();
app.use((req, _res, next) => { req.session = SESSION; next(); });
app.use(menuRouter);
app.use(retail);
let server, PORT;
function http(method, url, body) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, text: await r.text() }));
}
// The rail's labels in order, read off the rendered page.
async function rail() {
  const { status, text } = await http('GET', `/s/${CODE}`);
  assert.strictEqual(status, 200);
  const nav = text.slice(text.indexOf('<nav class="rail">'), text.indexOf('</nav>'));
  return { html: text, order: ['QRO Toasts', 'QRO Drinks', 'QRO Wellness', 'QRO Later', 'OTHER']
    .filter(n => nav.includes(n)).sort((a, b) => nav.indexOf(a) - nav.indexOf(b)) };
}

(async () => {
  for (const k of KEYS) saved.set(k, rawCfg(k));
  seed();
  setCfg('category.tree', TREE);
  delCfg(O.CONFIG_KEY);
  const treeBytes = rawCfg('category.tree');
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });
  try {
    console.log('\nThe QR page');
    await checkAsync('unset: the rail is the mini app\'s order', async () => {
      const { order } = await rail();
      // QRO Later is in no tree node, so it is OTHER's.
      assert.deepStrictEqual(order, ['QRO Toasts', 'QRO Drinks', 'QRO Wellness', 'OTHER']);
    });
    await checkAsync('a stored order moves the rail and the sections', async () => {
      setCfg(O.CONFIG_KEY, { tops: ['qc', 'qb', 'qa'], subs: { qa: ['qa2', 'qa1'] }, hidden: [] });
      const { html, order } = await rail();
      assert.deepStrictEqual(order, ['QRO Wellness', 'QRO Drinks', 'QRO Toasts', 'OTHER']);
      assert.ok(html.indexOf('QRO Savoury') < html.indexOf('QRO Sweet'), 'subcategory order not applied');
    });
    await checkAsync('a hidden category is gone, and its products are not in OTHER', async () => {
      setCfg(O.CONFIG_KEY, { tops: null, subs: {}, hidden: ['qb'] });
      const { html, order } = await rail();
      assert.deepStrictEqual(order, ['QRO Toasts', 'QRO Wellness', 'OTHER']);
      assert.ok(!html.includes('Fixture QRO drink'), 'a product of a hidden category is still on the page');
      assert.ok(html.includes('Fixture QRO later'), 'OTHER lost its own product');
    });
    await checkAsync('a category added after the order was set shows at the bottom', async () => {
      setCfg('category.tree', TREE.concat([{ id: 'qd', name: 'QRO Later', name_cn: '测试新类', subs: [] }]));
      setCfg(O.CONFIG_KEY, { tops: ['qc', 'qb', 'qa'], subs: {}, hidden: [] });
      const { order } = await rail();
      assert.deepStrictEqual(order, ['QRO Wellness', 'QRO Drinks', 'QRO Toasts', 'QRO Later']);
      setCfg('category.tree', TREE);
    });

    console.log('\nThe admin endpoint');
    // An owner of our own on tenant 1, the tenant whose data lives in the main
    // database this suite seeded — on the control-plane handle, as
    // scripts/test_retail_admin_gate.js does. Never skipped: a fresh database
    // has no owner, and a suite that skips there protects nothing in CI.
    rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(OP);
    rawDb.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
                   VALUES (?, 1, '__qr_order_owner', 'x', 'owner', 1)`).run(OP);
    SESSION = { backendUserId: OP };
    await checkAsync('PUT stores the order and GET reads it back, normalised', async () => {
      const put = await http('PUT', '/api/retail-admin/category-tree/qr-order',
        { tops: ['qb', 'qb', ' qa '], subs: { qa: ['qa2'] }, hidden: ['qc'] });
      assert.strictEqual(put.status, 200, put.text);
      const got = JSON.parse((await http('GET', '/api/retail-admin/category-tree/qr-order')).text).data;
      assert.deepStrictEqual(got, { tops: ['qb', 'qa'], subs: { qa: ['qa2'] }, hidden: ['qc'] });
    });
    await checkAsync('tops: null is accepted; a body with no tops is refused', async () => {
      assert.strictEqual((await http('PUT', '/api/retail-admin/category-tree/qr-order', { tops: null, hidden: [] })).status, 200);
      assert.strictEqual((await http('PUT', '/api/retail-admin/category-tree/qr-order', { hidden: ['qa'] })).status, 400);
      assert.strictEqual((await http('PUT', '/api/retail-admin/category-tree/qr-order', { tops: 'qa' })).status, 400);
    });
    check('the mini app\'s tree was never written', () => {
      assert.strictEqual(rawCfg('category.tree'), treeBytes);
    });
  } finally {
    server.close();
    cleanup();
    try { rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(OP); } catch (e) {}
    for (const [k, v] of saved) { if (v === null) delCfg(k); else db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(k, v); }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
