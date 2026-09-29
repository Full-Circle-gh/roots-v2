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
const P4 = 9914;   // never listed — the fixture the candidate SEARCH is run against
// Sixty more, none of them listed, for the one thing a smaller fixture cannot
// show: that an EMPTY box returns every addable product and not the first
// fifty of them. Sixty is the smallest number that fails against a LIMIT 50.
const BULK_FROM = 9920, BULK_N = 60;
const BULK_IDS = Array.from({ length: BULK_N }, (_, i) => BULK_FROM + i);
// A product with no English name — the column is NOT NULL, so in this
// catalogue that means the empty string. It has to sort by the name the picker
// prints, not sit in a nameless block at the head of the list.
const P_CN = 9990;
// A variant family: two sizes of one product, sharing a group. ONE of them is
// listed at shop A. The QR menu collapses siblings into a single card (§129),
// so the family is on that menu — and the product editor, which collapses them
// the same way, has to be told so while standing on the size that is NOT listed.
const V1 = 9995, V2 = 9996, VGROUP = 9995;
// A product with no listing anywhere, to tell "this tenant has no shops" apart
// from "this tenant has shops and none of them carry this".
const P_UNLISTED = 9997;

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
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?, ?, ?)').run(P1, P2, P3, P4);
  db.prepare(`DELETE FROM store_products WHERE id IN (${BULK_IDS.join(',')}, ${P_CN})`).run();
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?, ?)').run(V1, V2, P_UNLISTED);
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
// Two words in the name, an authored keyword and a tagline — the three things
// the candidate search has to reach. Never listed, so it is always a candidate.
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, keywords_en, tagline_en)
            VALUES (?, 'Fixture Peanut Butter Duo', '测试花生酱双拼', '__T-9914', 68, 1, 1, 'spreadable', 'Fixture slogan')`).run(P4);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, variant_group_id, variant_label)
            VALUES (?, 'Fixture jar', '测试罐装', '__T-9995', 30, 1, 1, ?, '250g')`).run(V1, VGROUP);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, variant_group_id, variant_label)
            VALUES (?, 'Fixture jar', '测试罐装', '__T-9996', 50, 1, 0, ?, '500g')`).run(V2, VGROUP);
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Fixture never listed', '测试从未上架', '__T-9997', 12, 1, 1)`).run(P_UNLISTED);
{
  const ins = db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
                          VALUES (?, ?, ?, ?, ?, 1, 1)`);
  // Numbered so their alphabetical order is known, and named from the far end
  // of the alphabet so a cap that kept the first fifty of the WHOLE catalogue
  // would drop them rather than happen to keep them.
  BULK_IDS.forEach((id, i) => {
    const n = String(i).padStart(2, '0');
    ins.run(id, `Zz fixture bulk ${n}`, `测试批量${n}`, `__T-${id}`, 5 + i);
  });
  db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
              VALUES (?, '', '测试无英文名', '__T-9990', 12, 1, 1)`).run(P_CN);
}

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
    // The picker's search is the OPERATOR'S way to find a product, and it was
    // one raw LIKE on the whole typed string against name and SKU only. So the
    // two most ordinary things a person does at a search box — type the words
    // in the order they think of them, and leave a space behind — returned
    // nothing, and looked exactly like "the product isn't there".
    await checkAsync('every word must match, but in any order and any spacing', async () => {
      const find = async q => (await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=${encodeURIComponent(q)}`))
        .json.data.map(x => x.id);
      assert.ok((await find('peanut butter')).includes(P4), 'the words as written');
      assert.ok((await find('butter peanut')).includes(P4), 'the words the other way round');
      assert.ok((await find('peanut  butter')).includes(P4), 'a doubled space between them');
      assert.ok((await find('  peanut butter  ')).includes(P4), 'a space left at either end');
      assert.ok((await find('duo peanut')).includes(P4), 'the first and last words, nothing between');
      assert.ok(!(await find('peanut marmalade')).includes(P4), 'a word that matches nothing still rules the row out');
    });
    await checkAsync('the keywords and the tagline are searched, as the storefront searches them', async () => {
      const find = async q => (await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=${encodeURIComponent(q)}`))
        .json.data.map(x => x.id);
      assert.ok((await find('spreadable')).includes(P4), 'the authored keyword');
      assert.ok((await find('slogan')).includes(P4), 'the tagline');
      assert.ok((await find('测试花生酱')).includes(P4), 'and the Chinese name');
    });
    await checkAsync('a wildcard typed into the box is a literal, not a wildcard', async () => {
      const r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=${encodeURIComponent('%')}`);
      assert.strictEqual(r.status, 200);
      assert.ok(!r.json.data.some(x => x.id === P4), 'a bare % matches nothing, rather than everything');
    });
    // AN EMPTY BOX IS THE WHOLE ADDABLE CATALOGUE. It used to be the first
    // fifty products in alphabetical order, with nothing on screen saying so,
    // which is why a catalogue of several hundred read as one that stopped in
    // the B's — and why the products missing from it read as the out-of-stock
    // ones being filtered out. Nothing here has ever looked at stock; the cap
    // was the whole of it.
    await checkAsync('an empty query returns every addable product, not the first fifty', async () => {
      const r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=`);
      assert.strictEqual(r.status, 200);
      const ids = new Set(r.json.data.map(x => x.id));
      const missing = BULK_IDS.filter(id => !ids.has(id));
      assert.strictEqual(missing.length, 0, `${missing.length} of ${BULK_N} bulk fixtures missing — ${missing.slice(0, 5).join(',')}`);
      assert.ok(ids.has(P4), 'and the searchable fixture is in the unfiltered list too');
      assert.ok(!ids.has(P3), 'an inactive product is still not a candidate');
    });
    await checkAsync('stock is not a filter — a product with none is still a candidate', async () => {
      db.prepare('UPDATE store_products SET stock_qty = 0 WHERE id = ?').run(BULK_IDS[0]);
      const r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=`);
      assert.ok(r.json.data.some(x => x.id === BULK_IDS[0]), 'a zero-stock product is addable to a menu');
    });
    await checkAsync('the list is ordered by the name the picker prints', async () => {
      const r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=`);
      const rows = r.json.data;
      const shown = rows.map(x => (x.name_en || '') || (x.name_cn || ''));
      const sorted = shown.slice().sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
      assert.deepStrictEqual(shown, sorted, 'rows come back in shown-name order');
      const at = rows.findIndex(x => x.id === P_CN);
      assert.ok(at > 0, 'a product with no English name sorts by its Chinese name, not to the head of the list');
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

    console.log('\nWhich menus carry one product — the question from the other side');
    await checkAsync('a product listed nowhere comes back empty, and says shops exist', async () => {
      const r = await call('GET', `/api/retail-admin/products/${P_UNLISTED}/shops`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.data.shops, [], 'a product on no menu must report no menus');
      // The distinction the editor draws its pill on: an empty list from a
      // tenant that HAS shops is information (nobody put this on a counter);
      // an empty list from one that never set the module up is noise.
      assert.strictEqual(r.json.data.tenant_has_shops, true);
    });
    await checkAsync('a listed product names the shop that carries it', async () => {
      await call('POST', `/api/retail-admin/shops/${shopA.id}/listings`, { store_product_id: V1 });
      const r = await call('GET', `/api/retail-admin/products/${V1}/shops`);
      assert.strictEqual(r.status, 200);
      const rows = r.json.data.shops;
      assert.strictEqual(rows.length, 1, 'expected exactly the one shop that lists it');
      assert.strictEqual(rows[0].shop_id, shopA.id);
      assert.strictEqual(rows[0].lists_this_product, true);
      assert.strictEqual(rows[0].reachable, true, 'an active shop at an active location is reachable');
    });
    await checkAsync('the SIBLING size is on that menu too, and knows it is the sibling', async () => {
      // V2 has no listing of its own. The menu collapses the family into one
      // card, so a customer at shop A is looking at this product — and an
      // editor answering "on no menu" here would be wrong about the shelf.
      const r = await call('GET', `/api/retail-admin/products/${V2}/shops`);
      assert.strictEqual(r.status, 200);
      const rows = r.json.data.shops;
      assert.strictEqual(rows.length, 1, 'the family is on this menu — the sibling must report it');
      assert.strictEqual(rows[0].shop_id, shopA.id);
      assert.strictEqual(rows[0].lists_this_product, false,
        'THIS row is not listed; only its sibling is, and the two are different answers');
    });
    await checkAsync('the Shop menu list and the add picker both carry the SIZE of a variant', async () => {
      // Two sizes share one name, so without the label the rows read "Fixture
      // jar" and "Fixture jar" and removing or adding the right one was a guess.
      const listing = (await call('GET', `/api/retail-admin/shops/${shopA.id}`)).json.data.listings
        .find(l => l.store_product_id === V1);
      assert.strictEqual(listing.variant_label, '250g', 'the listed size must name itself on the menu list');
      const cand = (await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=__T-9996`)).json.data
        .find(x => x.id === V2);
      assert.ok(cand, 'the unlisted sibling is a candidate');
      assert.strictEqual(cand.variant_label, '500g', 'the add picker must name the size it would add');
      assert.ok('variant_label_cn' in listing && 'variant_label_cn' in cand, 'the Chinese label is read too');
    });
    await checkAsync('a shop switched off is returned but not reachable', async () => {
      await call('PATCH', `/api/retail-admin/shops/${shopA.id}`, { is_active: 0 });
      const r = await call('GET', `/api/retail-admin/products/${V1}/shops`);
      assert.strictEqual(r.json.data.shops.length, 1, 'the listing still exists and is still reported');
      assert.strictEqual(r.json.data.shops[0].reachable, false,
        'a scan of a switched-off shop reaches the empty page — it must not be counted as live');
      await call('PATCH', `/api/retail-admin/shops/${shopA.id}`, { is_active: 1 });
    });
    await checkAsync('an archived or unknown product is 404, not an empty list', async () => {
      let r = await call('GET', `/api/retail-admin/products/${P3}/shops`);   // is_active = 0
      assert.strictEqual(r.status, 404, 'an archived product must not answer as "on no menu"');
      r = await call('GET', '/api/retail-admin/products/99999999/shops');
      assert.strictEqual(r.status, 404);
      r = await call('GET', '/api/retail-admin/products/not-a-number/shops');
      assert.strictEqual(r.status, 404);
    });
    await checkAsync('reading it needs no stores:edit — it reports, it never writes', async () => {
      CAPS = new Set(['stores:view']);
      const r = await call('GET', `/api/retail-admin/products/${V1}/shops`);
      assert.strictEqual(r.status, 200, 'a read-only operator must still see where a product is');
      CAPS = null;
      // Left as it was found, so the containment check below is unaffected.
      const lid = (await call('GET', `/api/retail-admin/shops/${shopA.id}`)).json.data.listings
        .find(l => l.store_product_id === V1).id;
      await call('DELETE', `/api/retail-admin/shops/${shopA.id}/listings/${lid}`);
    });

    console.log('\nAdd every Online store product in one tap (Ash, 2026-09-29)');
    await checkAsync('adds exactly what the mini app shows and this menu lacks, at catalogue price, stocked, at the end', async () => {
      const before = (await call('GET', `/api/retail-admin/shops/${shopA.id}`)).json.data.listings;
      const had = new Set(before.map(l => l.store_product_id));
      const maxSort = before.reduce((m, l) => Math.max(m, l.sort_position), -1);
      CAPS = new Set(['stores:view']);
      let r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings/add-published`);
      assert.strictEqual(r.status, 403, 'a read-only operator cannot bulk-add');
      CAPS = null;
      r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings/add-published`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const after = r.json.data.listings;
      const byProduct = new Map(after.map(l => [l.store_product_id, l]));
      for (const id of [P4, P_UNLISTED, P_CN, V1, ...BULK_IDS]) {
        assert.ok(byProduct.has(id), `published product ${id} was not added`);
      }
      assert.ok(!byProduct.has(P3), 'an inactive, unpublished product is not added');
      assert.ok(!byProduct.has(V2), 'an unpublished size is not added — the mini app does not show it either');
      const fresh = after.filter(l => !had.has(l.store_product_id));
      assert.strictEqual(r.json.data.added, fresh.length);
      assert.ok(fresh.every(l => l.fulfilment_mode === 'stocked'), 'every added row is stocked');
      assert.ok(fresh.every(l => l.sort_position > maxSort), 'every added row lands after what was there');
      assert.strictEqual(byProduct.get(P4).price, 68, 'price is the catalogue price');
      const p1 = before.find(l => l.store_product_id === P1);
      if (p1) assert.strictEqual(byProduct.get(P1).price, p1.price, 'a row already on the menu keeps its own price');
    });
    await checkAsync('a second tap adds nothing and the published candidates are gone', async () => {
      let r = await call('POST', `/api/retail-admin/shops/${shopA.id}/listings/add-published`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.data.added, 0, 'nothing left to add');
      r = await call('GET', `/api/retail-admin/shops/${shopA.id}/candidates?q=`);
      assert.ok(!r.json.data.some(x => x.is_published === 1), 'no published product is still a candidate');
      r = await call('POST', '/api/retail-admin/shops/99999999/listings/add-published');
      assert.strictEqual(r.status, 404, 'an unknown shop is 404');
      // Left as the rest of the run expects it: only the rows it had before.
      db.prepare(`DELETE FROM shop_listings WHERE shop_id = ? AND store_product_id NOT IN (?, ?)`).run(shopA.id, P1, P2);
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

    /* AMENDED 2026-09-16 (§150): the till is no longer unchanged. It fetches
       /api/retail-admin/stores/:id/counter-catalogue, which lives in
       routes/retail-shops.js precisely so that the table stays read where it
       always was — public/till.html never names it, and the allowlist below
       is untouched. The schema half of this heading still holds and is what
       the check under it proves. */
    console.log('\nStill read in one place — the till fetches a route, not the table');
    check('the location without a shop is unchanged: no shop row, no listing, same columns', () => {
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE location_id = ?').get(LOC_B).n, 0);
      for (const t of Object.keys(BEFORE)) assert.strictEqual(colsOf(t), BEFORE[t], `${t} columns changed`);
    });
    check('shop_listings is referenced only by its own route, the public menu, and this test', () => {
      const dirs = ['routes', 'lib', 'middleware', 'public'];
      // WIDENED 2026-09-06 for step 5a, deliberately and once. This guard was
      // written when nothing read these tables at all; the public QR menu is
      // the first reader §44 always said would come, so it is admitted BY NAME
      // rather than the guard being softened. Everything the line was for is
      // intact: the till, the storefront and every order path are still held
      // to reading nothing here, and the next unannounced reader still turns
      // this red and has to say so. §150 (2026-09-16) tested that line and did
      // NOT widen it: the counter till needed this table, and the route it
      // needed was built inside routes/retail-shops.js rather than the table
      // being reached for from public/till.html.
      const allowed = new Set([
        path.join('routes', 'retail-shops.js'),
        path.join('routes', 'shop-menu.js'),
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
