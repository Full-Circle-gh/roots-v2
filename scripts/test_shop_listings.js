#!/usr/bin/env node
/**
 * Shops and shop listings — the record, the code, the join, and the promise
 * that nothing else reads them yet.
 *
 *   node scripts/test_shop_listings.js
 *
 * docs/tacet-consolidation-decisions.md §41, §42, §44 (2026-09-05), built in
 * database.js (SHOPS and SHOP LISTINGS), lib/shop-code.js and
 * routes/retail-shops.js. This is step 2 of the location commerce module:
 * schema plus admin screen, no public route, no behaviour change to the till.
 *
 * Everything runs against a REAL sqlite database (database.js opens
 * data/roots.db and applies the migration on require) and the REAL express
 * router, mounted and called over HTTP, so every status and body printed here
 * is observed. Only the auth choke point is stubbed: requireRetailAdmin lives in
 * routes/retail.js, which is 35k lines and would need a session; the harness
 * sets req.user and req.caps per request instead, exactly as it would.
 *
 * Four things are held here that a reading of the code cannot prove:
 *   1. A shop's public code is eight confusable-free characters and is not the
 *      location's code, id, or shop id in any dressing — the property §44 rests
 *      on. Ten mints, ten distinct codes.
 *   2. A location has at most one shop, and a product is on a menu at most once
 *      — both enforced by the database, not only by the route's pre-check.
 *   3. A listing's price defaults to the catalogue price and is then its own;
 *      a bad price, mode or sort is refused, never coerced to 0.
 *   4. shop_listings is referenced by NOTHING outside its own route, its own
 *      migration and this test — grep of the source tree, so the day something
 *      starts reading it, this line goes red and the reader has to say so.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// The auth seam — stubbed BEFORE the route loads. Named from this file
// (require.resolve is relative to the caller) and keyed on the absolute path
// the route's own require('./retail') resolves to.
function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../middleware/auth', { logActivity: () => {} });

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { SHOP_CODE_ALPHABET, SHOP_CODE_LEN, isShopCode, newShopCode } = require(path.join(ROOT, 'lib', 'shop-code.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the 91xx–97xx blocks other suites use.
const LOC_A = 9811;   // gets a shop
const LOC_B = 9812;   // stays a plain location — the §41 "unchanged" case
const P1 = 9911, P2 = 9912, P3 = 9913;

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id IN (?, ?))').run(LOC_A, LOC_B);
  db.prepare('DELETE FROM shops WHERE location_id IN (?, ?)').run(LOC_A, LOC_B);
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?, ?)').run(P1, P2, P3);
  db.prepare('DELETE FROM retail_stores WHERE id IN (?, ?)').run(LOC_A, LOC_B);
}
cleanup();
db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_shop_a', 'Shop fixture A', '测试门店A', 1, 98)`).run(LOC_A);
db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_shop_b', 'Shop fixture B', '测试门店B', 1, 99)`).run(LOC_B);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Fixture oat latte', '测试燕麦拿铁', '__T-9911', 32, 1, 1)`).run(P1);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Fixture granola', '测试格兰诺拉', '__T-9912', 48.5, 1, 1)`).run(P2);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Fixture retired', '测试已下架', '__T-9913', 10, 0, 0)`).run(P3);

// Column set of the tables the till reads, captured now so the end of the run
// can prove the migration added nothing to them.
const colsOf = t => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r => r.name).join(',');
const BEFORE = { retail_stores: colsOf('retail_stores'), store_products: colsOf('store_products'),
                 retail_store_stock: colsOf('retail_store_stock'), retail_orders: colsOf('retail_orders') };

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
let CAPS = null;   // null = kitchen realm (RBAC dark); a Set = backend operator
app.use((req, res, next) => {
  req.user = { id: 3, username: 'mei', display_name: 'Mei' };
  req.caps = CAPS;
  next();
});
app.use(router);

let server, PORT;
function call(method, url, body) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    console.log('\nSchema — the migration is additive');
    check('shops and shop_listings exist', () => {
      for (const t of ['shops', 'shop_listings']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), `${t} missing`);
    });
    check('shop_listings points at store_products, not products', () => {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='shop_listings'").get().sql;
      assert.match(sql, /REFERENCES store_products\(id\)/);
      assert.doesNotMatch(sql, /REFERENCES products\(/);
    });

    console.log('\nThe code — opaque, eight characters, never derived (§44)');
    check(`newShopCode mints ${SHOP_CODE_LEN} characters from the confusable-free alphabet`, () => {
      const seen = new Set();
      for (let i = 0; i < 10; i++) {
        const c = newShopCode();
        assert.strictEqual(c.length, SHOP_CODE_LEN, c);
        for (const ch of c) assert.ok(SHOP_CODE_ALPHABET.includes(ch), `${ch} in ${c}`);
        assert.ok(isShopCode(c));
        seen.add(c);
      }
      assert.strictEqual(seen.size, 10, 'ten mints should be ten distinct codes');
      for (const bad of ['0OIL1234', 'abcdefgh', 'ABCDEFG', 'ABCDEFGHJ', '', null]) assert.ok(!isShopCode(bad), String(bad));
    });
    check('the alphabet has no 0, O, 1 or I', () => {
      for (const ch of '0O1I') assert.ok(!SHOP_CODE_ALPHABET.includes(ch), ch);
      assert.strictEqual(SHOP_CODE_ALPHABET.length, 32);
    });

    console.log('\nShops — one per location (§41)');
    let shopA;
    await checkAsync('POST creates a shop with a minted code', async () => {
      const r = await call('POST', '/api/retail-admin/shops', { location_id: LOC_A });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      shopA = r.json.data.shop;
      assert.strictEqual(shopA.location_id, LOC_A);
      assert.ok(isShopCode(shopA.public_code), shopA.public_code);
      assert.strictEqual(shopA.is_active, 1);
      assert.deepStrictEqual(r.json.data.listings, []);
    });
    check('the code is not the location code, the location id or the shop id', () => {
      const c = shopA.public_code;
      // Equality, not containment: a single digit such as a shop id of 7 will
      // legitimately appear somewhere in a random 8-character code.
      assert.notStrictEqual(c, '__test_shop_a');
      assert.notStrictEqual(c, '__TEST_SHOP_A');
      assert.notStrictEqual(c, String(LOC_A));
      assert.notStrictEqual(c, String(shopA.id));
      assert.doesNotMatch(c, /^\d+$/, 'a purely numeric code would read as an id');
      assert.notStrictEqual(c, String(LOC_A).padStart(SHOP_CODE_LEN, '2'));
      assert.notStrictEqual(c, String(shopA.id).padStart(SHOP_CODE_LEN, '2'));
    });
    await checkAsync('a second shop on the same location is refused 409 by the route', async () => {
      const r = await call('POST', '/api/retail-admin/shops', { location_id: LOC_A });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'shop_exists');
    });
    check('…and by the database, without the route', () => {
      assert.throws(() => db.prepare("INSERT INTO shops (location_id, public_code) VALUES (?, 'ZZZZZZZ2')").run(LOC_A), /UNIQUE/);
    });
    await checkAsync('an unknown location is 404', async () => {
      const r = await call('POST', '/api/retail-admin/shops', { location_id: 999999 });
      assert.strictEqual(r.status, 404);
    });
    await checkAsync('GET /shops lists every location, with or without a shop', async () => {
      const r = await call('GET', '/api/retail-admin/shops');
      assert.strictEqual(r.status, 200);
      const a = r.json.data.find(x => x.location.id === LOC_A);
      const b = r.json.data.find(x => x.location.id === LOC_B);
      assert.ok(a && a.shop && a.shop.public_code === shopA.public_code, 'A carries its shop');
      assert.ok(b && b.shop === null, 'B has no shop and is listed anyway');
    });
    await checkAsync('PATCH edits names and the active flag, and cannot touch the code', async () => {
      const r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}`,
        { display_name_en: 'Corner shop', display_name_cn: '街角店', is_active: 0, public_code: 'HACKED22', location_id: LOC_B });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = r.json.data.shop;
      assert.strictEqual(s.display_name_en, 'Corner shop');
      assert.strictEqual(s.display_name_cn, '街角店');
      assert.strictEqual(s.is_active, 0);
      assert.strictEqual(s.public_code, shopA.public_code, 'code unchanged');
      assert.strictEqual(s.location_id, LOC_A, 'location unchanged');
      await call('PATCH', `/api/retail-admin/shops/${shopA.id}`, { is_active: 1 });
    });

    console.log('\nListings — the join, its price and its mode (§42)');
    let l1;
    await checkAsync('POST adds a product; price defaults to the catalogue price', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: P1 });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      l1 = r.json.data;
      assert.strictEqual(l1.price, 32);
      assert.strictEqual(l1.fulfilment_mode, 'stocked');
      assert.strictEqual(l1.is_available, 1);
      assert.strictEqual(l1.sort_position, 0);
      assert.strictEqual(l1.name_cn, '测试燕麦拿铁');
    });
    await checkAsync('a typed price and made_here are kept; sort lands at the end', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`,
        { store_product_id: P2, price: '45.5', fulfilment_mode: 'made_here' });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assert.strictEqual(r.json.data.price, 45.5);
      assert.strictEqual(r.json.data.fulfilment_mode, 'made_here');
      assert.strictEqual(r.json.data.sort_position, 1);
    });
    await checkAsync('the same product twice is 409, and the database agrees', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: P1 });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'already_listed');
      assert.throws(() => db.prepare('INSERT INTO shop_listings (shop_id, store_product_id, price) VALUES (?, ?, 1)').run(shopA.id, P1), /UNIQUE/);
    });
    await checkAsync('a bad mode, a negative price and a bad sort are refused 400', async () => {
      let r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: P3, fulfilment_mode: 'delivered' });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'bad_fulfilment_mode');
      r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: P3, price: -1 });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'bad_price');
      r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}/listings/${l1.id}`, { price: 'abc' });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'bad_price');
      r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}/listings/${l1.id}`, { sort_position: -3 });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'bad_sort_position');
      assert.throws(() => db.prepare("UPDATE shop_listings SET fulfilment_mode = 'x' WHERE id = ?").run(l1.id), /CHECK/);
    });
    await checkAsync('PATCH flips availability and changes the price; the catalogue price is untouched', async () => {
      const r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}/listings/${l1.id}`, { is_available: 0, price: 35 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.data.is_available, 0);
      assert.strictEqual(r.json.data.price, 35);
      assert.strictEqual(db.prepare('SELECT sell_price FROM store_products WHERE id = ?').get(P1).sell_price, 32);
    });
    await checkAsync('candidates exclude listed and inactive products, and search by name or SKU', async () => {
      let r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=__T-99`);
      assert.strictEqual(r.status, 200);
      const ids = r.json.data.map(x => x.id);
      assert.ok(!ids.includes(P1) && !ids.includes(P2), 'listed products are not candidates');
      assert.ok(!ids.includes(P3), 'an inactive product is not a candidate');
      r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=测试燕麦`);
      assert.strictEqual(r.json.data.length, 0, 'P1 is listed, so a CN search for it finds nothing');
    });
    await checkAsync('reorder rewrites sort_position in the order given', async () => {
      const before = (await call('GET', `/api/retail-admin/shops/${shopA.id}`)).json.data.listings.map(x => x.id);
      const r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings/reorder`, { ids: before.slice().reverse() });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.data.map(x => x.id), before.slice().reverse());
      assert.deepStrictEqual(r.json.data.map(x => x.sort_position), [0, 1]);
    });
    await checkAsync('DELETE removes the listing and the product can be added again', async () => {
      let r = await call('DELETE', `/api/retail-admin/shops/${shopA.id}/listings/${l1.id}`);
      assert.strictEqual(r.status, 200);
      r = await call('DELETE', `/api/retail-admin/shops/${shopA.id}/listings/${l1.id}`);
      assert.strictEqual(r.status, 404);
      r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: P1 });
      assert.strictEqual(r.status, 201);
    });

    console.log('\nThe gate — writes need stores:edit for a backend operator');
    await checkAsync('a backend operator without stores:edit reads but cannot write', async () => {
      CAPS = new Set(['stores:view']);
      let r = await call('GET', `/api/retail-admin/shops/${shopA.id}`);
      assert.strictEqual(r.status, 200);
      r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}`, { is_active: 0 });
      assert.strictEqual(r.status, 403);
      r = await call('POST', '/api/retail-admin/shops', { location_id: LOC_B });
      assert.strictEqual(r.status, 403);
      CAPS = new Set(['stores:edit']);
      r = await call('PATCH', `/api/retail-admin/shops/${shopA.id}`, { is_active: 1 });
      assert.strictEqual(r.status, 200);
      CAPS = null;
    });

    console.log('\nNothing else reads these tables yet — the till is unchanged');
    check('the location without a shop is unchanged: no shop row, no listing, same columns', () => {
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE location_id = ?').get(LOC_B).n, 0);
      for (const t of Object.keys(BEFORE)) assert.strictEqual(colsOf(t), BEFORE[t], `${t} columns changed`);
    });
    check('shop_listings is referenced only by its own route, its migration and this test', () => {
      const dirs = ['routes', 'lib', 'middleware', 'public'];
      const allowed = new Set([
        path.join('routes', 'retail-shops.js'),
        path.join('public', 'retail-admin', '28-shops.js'),
        /* THE MONEY REGISTRY, which NAMES the column rather than reading it.
           lib/money-columns.js is one line per money column in the schema, and
           `shop_listings.price` is decimal yuan, so it has to appear there or
           the migration scanner reports it as a column nobody has decided
           about — which is exactly what the first production rehearsal did
           report, on 2026-09-06. An entry there is a classification, not a
           reader: nothing in that file queries this table, and the containment
           this check exists to hold is unaffected. */
        path.join('lib', 'money-columns.js'),
      ]);
      const hits = [];
      const walk = d => {
        for (const ent of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
          const rel = path.join(d, ent.name);
          if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(rel); continue; }
          if (!/\.(js|html)$/.test(ent.name)) continue;
          if (allowed.has(rel)) continue;
          const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          if (/shop_listings/.test(src)) hits.push(rel);
        }
      };
      for (const d of dirs) walk(d);
      assert.deepStrictEqual(hits, [], 'unexpected readers of shop_listings: ' + hits.join(', '));
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
