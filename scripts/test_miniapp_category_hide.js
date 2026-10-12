#!/usr/bin/env node
/**
 * §465 — A TOP CATEGORY CAN BE HIDDEN FROM THE MINI APP.
 *
 *   node scripts/test_miniapp_category_hide.js
 *
 * Ash, 2026-10-12, on "Restock-only, internal" and "Coffee & Milks" showing on
 * the mini app's Shop tab: *"hide them from there now"*. §288 gave the QR menu
 * an eye; the mini app had none.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. A TREE THAT HIDES NOTHING KEEPS ITS BYTES. The flag is stored only when
 *     true, so the §325 version of every existing tree is unchanged.
 *  2. THE PUBLIC TREE LEAVES THE HIDDEN TOP OUT; the admin tree keeps it.
 *  3. ITS PRODUCTS LEAVE BROWSING WITH IT — the list, search, a category grid,
 *     and the list's own total.
 *  4. A BY-ID READ STILL RETURNS THEM. Checkout re-reads the cart by id; a
 *     hidden category must not break an order already in a cart.
 *  5. THE ADMIN SAVE ROUND-TRIPS THE FLAG, so the desktop editor's eye sticks.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

const rawDb = require(path.join(ROOT, 'database.js'));
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const CT = require(path.join(ROOT, 'lib', 'category-tree.js'));
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

const TREE = [
  { id: 'mha', name: 'MAH Pantry', name_cn: '测试干货', subs: [] },
  { id: 'mhb', name: 'MAH Internal', name_cn: '测试内部', subs: [], hidden: true },
];

console.log('\nThe tree');
check('a tree that hides nothing keeps its exact bytes', () => {
  const plain = [{ id: 'a', name: 'A', name_cn: '', subs: [] }];
  assert.strictEqual(JSON.stringify(CT.sanitizeTree(plain)), JSON.stringify(plain));
  // Only a real `true` hides: a stray string or `false` is not stored.
  const noisy = [{ id: 'a', name: 'A', name_cn: '', subs: [], hidden: 'yes' }, { id: 'b', name: 'B', name_cn: '', subs: [], hidden: false }];
  assert.ok(CT.sanitizeTree(noisy).every(t => !('hidden' in t)));
});
check('the hidden flag survives sanitising', () => {
  assert.strictEqual(CT.sanitizeTree(TREE)[1].hidden, true);
});
check('publicTree drops the hidden top; hiddenTopNames names it', () => {
  assert.deepStrictEqual(CT.publicTree(TREE).map(t => t.name), ['MAH Pantry']);
  assert.deepStrictEqual(CT.hiddenTopNames(TREE), ['MAH Internal']);
  assert.deepStrictEqual(CT.hiddenTopNames(null), []);
});

// ── Real database, real router ─────────────────────────────────────────────
const OP = 8971;
const P = { shown: 8961, hidden: 8962 };
const PRODS = Object.values(P);
const saved = rawCfg('category.tree');

function setCfg(k, v) {
  db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(k, JSON.stringify(v));
}
function rawCfg(k) {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
  return r ? r.value_json : null;
}
function cleanup() {
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODS.map(() => '?').join(',')})`).run(...PRODS);
}
function seed() {
  cleanup();
  const prod = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category, sort_order)
    VALUES (?, ?, ?, ?, 10, 1, 1, ?, 0)`);
  prod.run(P.shown,  'Fixture MAH oats',   '测试燕麦', '__MAH-1', 'MAH Pantry');
  prod.run(P.hidden, 'Fixture MAH beans',  '测试豆子', '__MAH-2', 'MAH Internal');
}

let SESSION = null;
const app = express();
app.use((req, _res, next) => { req.session = SESSION; next(); });
app.use(retail);
let server, PORT;
function http(method, url, body) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, text: await r.text() }));
}
const json = async (url) => JSON.parse((await http('GET', url)).text);
const ids = (rows) => (rows.data || []).map(r => r.id);

(async () => {
  seed();
  setCfg('category.tree', TREE);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });
  try {
    console.log('\nThe shopper\'s side');
    await checkAsync('the public tree leaves the hidden top out, with or without counts', async () => {
      assert.deepStrictEqual((await json('/api/retail/category-tree')).data.map(t => t.name), ['MAH Pantry']);
      assert.deepStrictEqual((await json('/api/retail/category-tree?counts=1')).data.map(t => t.name), ['MAH Pantry']);
    });
    await checkAsync('the product list leaves its products out', async () => {
      const all = ids(await json('/api/retail/products?limit=500'));
      assert.ok(all.includes(P.shown), 'a shown product went missing');
      assert.ok(!all.includes(P.hidden), 'a product of a hidden category is still listed');
    });
    await checkAsync('so do search and a category grid', async () => {
      assert.ok(!ids(await json('/api/retail/products?q=Fixture%20MAH')).includes(P.hidden));
      assert.deepStrictEqual(ids(await json('/api/retail/products?category=' + encodeURIComponent('MAH Internal'))), []);
    });
    await checkAsync('the list\'s total does not count them', async () => {
      const r = await json('/api/retail/products?q=Fixture%20MAH');
      assert.strictEqual(r.meta && r.meta.total, 1);
    });
    await checkAsync('a by-id read still returns them — checkout reads the cart this way', async () => {
      assert.deepStrictEqual(ids(await json(`/api/retail/products?ids=${P.hidden},${P.shown}`)).sort(), [P.shown, P.hidden].sort());
    });

    console.log('\nThe admin side');
    rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(OP);
    rawDb.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
                   VALUES (?, 1, '__miniapp_hide_owner', 'x', 'owner', 1)`).run(OP);
    SESSION = { backendUserId: OP };
    await checkAsync('the admin tree keeps the hidden top', async () => {
      const t = (await json('/api/retail-admin/category-tree')).data;
      assert.deepStrictEqual(t.map(x => [x.name, !!x.hidden]), [['MAH Pantry', false], ['MAH Internal', true]]);
    });
    await checkAsync('a save round-trips the flag both ways', async () => {
      const off = TREE.map(t => { const c = { ...t }; delete c.hidden; return c; });
      let put = await http('PUT', '/api/retail-admin/category-tree', { tree: off });
      assert.strictEqual(put.status, 200, put.text);
      assert.ok(ids(await json('/api/retail/products?limit=500')).includes(P.hidden), 'unhiding did not bring it back');
      put = await http('PUT', '/api/retail-admin/category-tree', { tree: TREE });
      assert.strictEqual(put.status, 200, put.text);
      assert.strictEqual(JSON.parse(rawCfg('category.tree'))[1].hidden, true);
    });
  } finally {
    server.close();
    cleanup();
    try { rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(OP); } catch (e) {}
    if (saved === null) db.prepare("DELETE FROM storefront_config WHERE key = 'category.tree'").run();
    else db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES ('category.tree', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(saved);
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
