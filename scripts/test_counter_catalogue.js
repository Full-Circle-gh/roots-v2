#!/usr/bin/env node
/**
 * What the counter till may sell — §150.
 *
 *   node scripts/test_counter_catalogue.js
 *
 * THE BUG THIS SUITE EXISTS FOR. The till built its product list from
 * `/api/retail-admin/products?published=1` — the ONLINE STORE's flag. A product
 * on a location's own menu is not a website product and is not published, so it
 * reached no till, and a cashier searching "hummus" at Tianhe found one row
 * where the menu carried several. §42 draws the line the other way round and
 * the public QR menu has always honoured it: is_published governs the website,
 * a shop listing governs the shop.
 *
 * Everything runs against a REAL sqlite database (database.js opens
 * data/roots.db and applies the migration on require) and the REAL express
 * router, mounted and called over HTTP, so every status and body printed here
 * is observed. Only the auth choke point is stubbed, exactly as its sibling
 * scripts/test_shop_listings.js does it and for the same reason.
 *
 * Six things are held here that a reading of the code cannot prove:
 *   1. A made-here menu item reaches the till at all — unpublished, never
 *      counted, and still sellable, because that is what "made here" means.
 *   2. It is never stock-gated. `stock: null`, so no shelf figure is invented
 *      for a thing that is built when it is ordered.
 *   3. A listing governs its product absolutely: switched off for the day, the
 *      row is ABSENT rather than reappearing two rows down at catalogue price.
 *   4. The price is the LISTING's (§42), not the product's.
 *   5. The change is ADDITIVE — every tile a cashier could see before is still
 *      there, including a published product with nothing on the shelf.
 *   6. One location's menu never leaks into another's till.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../middleware/auth', { logActivity: () => {} });

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the blocks the other suites use.
const LOC_A = 9841;   // has a shop, so it has a menu
const LOC_B = 9842;   // no shop record at all — the §41 "unchanged" case
const SHOP_A = 9851;

const P_MADE    = 9961;  // on the menu, made here, unpublished, never counted
const P_OFF     = 9962;  // on the menu, switched off for the day — and published
const P_STOCKED = 9963;  // on the menu, stocked, and priced differently there
const P_PUB     = 9964;  // published, no shelf row here — the till showed it before
const P_LOCAL   = 9965;  // unpublished, but counted on this location's shelf
const P_NEITHER = 9966;  // unpublished, uncounted, unlisted — in the catalogue only
const P_RESTOCK = 9967;  // published, in stock, and a receiving record, not a sale
const P_FREE    = 9968;  // published, in stock, no price — not a thing to ring up
const P_BUFFER  = 9969;  // published, 10 on the shelf, 4 of them held back

const ALL_PRODUCTS = [P_MADE, P_OFF, P_STOCKED, P_PUB, P_LOCAL, P_NEITHER,
                      P_RESTOCK, P_FREE, P_BUFFER];

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id = ?').run(SHOP_A);
  db.prepare('DELETE FROM shops WHERE id = ? OR location_id IN (?, ?)').run(SHOP_A, LOC_A, LOC_B);
  db.prepare(`DELETE FROM retail_store_stock WHERE store_id IN (?, ?)`).run(LOC_A, LOC_B);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ALL_PRODUCTS.join(',')})`).run();
  db.prepare('DELETE FROM retail_stores WHERE id IN (?, ?)').run(LOC_A, LOC_B);
}
cleanup();

db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_till_a', 'Till fixture A', '测试收银A', 1, 96)`).run(LOC_A);
db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_till_b', 'Till fixture B', '测试收银B', 1, 97)`).run(LOC_B);
db.prepare(`INSERT INTO shops (id, location_id, public_code, is_active)
            VALUES (?, ?, '__TILLFX', 1)`).run(SHOP_A, LOC_A);

const insProduct = db.prepare(`
  INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category,
                              is_active, is_published, is_restock_only)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
insProduct.run(P_MADE,    'Fixture iced latte',  '测试冰拿铁',   '__C-9961', 0,  'Drinks',      0, 0);
insProduct.run(P_OFF,     'Fixture soup',        '测试汤',       '__C-9962', 26, 'Ready to Eat', 1, 0);
insProduct.run(P_STOCKED, 'Fixture bottle',      '测试瓶装',     '__C-9963', 18, 'Drinks',      1, 0);
insProduct.run(P_PUB,     'Fixture hummus',      '测试鹰嘴豆泥', '__C-9964', 38, 'Fresh & Deli', 1, 0);
insProduct.run(P_LOCAL,   'Fixture warehouse',   '测试仓库品',   '__C-9965', 22, 'Dry & Pantry', 0, 0);
insProduct.run(P_NEITHER, 'Fixture elsewhere',   '测试他处',     '__C-9966', 15, 'Dry & Pantry', 0, 0);
insProduct.run(P_RESTOCK, 'Fixture ingredient',  '测试原料',     '__C-9967', 9,  'Dry & Pantry', 1, 1);
insProduct.run(P_FREE,    'Fixture priceless',   '测试无价',     '__C-9968', 0,  'Dry & Pantry', 1, 0);
insProduct.run(P_BUFFER,  'Fixture buffered',    '测试预留',     '__C-9969', 40, 'Snacks & Treats', 1, 0);

const insStock = db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
                             VALUES (?, ?, ?, ?)`);
insStock.run(LOC_A, P_STOCKED, 7, 0);
insStock.run(LOC_A, P_LOCAL,   3, 0);
insStock.run(LOC_A, P_RESTOCK, 5, 0);
insStock.run(LOC_A, P_FREE,    5, 0);
insStock.run(LOC_A, P_BUFFER, 10, 4);
// The same unpublished product, counted at the OTHER location. It must not
// reach A's till on B's shelf.
insStock.run(LOC_B, P_NEITHER, 9, 0);

const insListing = db.prepare(`
  INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
  VALUES (?, ?, ?, ?, ?, ?)`);
insListing.run(SHOP_A, P_STOCKED, 25,   'stocked',   1, 0);   // 25 on the menu, 18 in the catalogue
insListing.run(SHOP_A, P_MADE,    32,   'made_here', 1, 1);
insListing.run(SHOP_A, P_OFF,     30,   'made_here', 0, 2);

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => { req.user = { id: 3, username: 'mei' }; req.caps = null; next(); });
app.use(router);

let server, PORT;
function call(url) {
  return fetch(`http://127.0.0.1:${PORT}${url}`)
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}
const rowFor = (rows, id) => rows.filter(r => r.product_id === id)[0] || null;

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    const a = await call(`/api/retail-admin/stores/${LOC_A}/counter-catalogue`);
    const b = await call(`/api/retail-admin/stores/${LOC_B}/counter-catalogue`);
    const rowsA = (a.json && a.json.data && a.json.data.rows) || [];
    const rowsB = (b.json && b.json.data && b.json.data.rows) || [];

    console.log('\nThe route answers');
    check('200, and it says whether the location has a shop', () => {
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.json.success, true);
      assert.strictEqual(a.json.data.has_shop, true);
      assert.strictEqual(a.json.data.shop_id, SHOP_A);
      assert.strictEqual(b.json.data.has_shop, false);
      assert.strictEqual(b.json.data.shop_id, null);
    });
    check('a location that does not exist is 404, not an empty list', async () => {
      assert.strictEqual((await call('/api/retail-admin/stores/99999991/counter-catalogue')).status, 404);
    });

    console.log('\nThe menu — what the location MAKES (§42, §47)');
    check('a made-here item reaches the till though it is unpublished', () => {
      const r = rowFor(rowsA, P_MADE);
      assert.ok(r, 'the made-here menu item is missing — this is the reported bug');
      assert.strictEqual(r.on_menu, true);
      assert.strictEqual(r.fulfilment_mode, 'made_here');
    });
    check('it is never stock-gated: stock is null, not 0', () => {
      // 0 would draw a disabled, greyed "Sold out" tile for a drink the machine
      // behind the cashier can make all day.
      assert.strictEqual(rowFor(rowsA, P_MADE).stock, null);
    });
    check('it is priced at the listing, not at the product (§42)', () => {
      assert.strictEqual(rowFor(rowsA, P_MADE).price, 32);
      const r = rowFor(rowsA, P_STOCKED);
      assert.strictEqual(r.price, 25, 'a listed product must quote the menu price, not sell_price 18');
    });
    check('a stocked listing still counts the shelf', () => {
      assert.strictEqual(rowFor(rowsA, P_STOCKED).stock, 7);
    });
    check('switched off for the day is ABSENT, not shown at catalogue price', () => {
      // P_OFF is published, so a merge that simply concatenated the two halves
      // would put it back on the screen at 26 — the price nobody chose.
      assert.strictEqual(rowFor(rowsA, P_OFF), null);
    });
    check('menu rows come first, in the order the operator arranged them', () => {
      const menu = rowsA.filter(r => r.on_menu).map(r => r.product_id);
      assert.deepStrictEqual(menu, [P_STOCKED, P_MADE], 'menu order is sort_position');
      const firstShelf = rowsA.findIndex(r => !r.on_menu);
      assert.ok(firstShelf >= menu.length, 'a shelf row sorted above a menu row');
    });

    console.log('\nThe shelf — what the location HAS');
    check('an unpublished product counted here is sellable at the counter', () => {
      const r = rowFor(rowsA, P_LOCAL);
      assert.ok(r, 'stock on this shelf and no tile to sell it from');
      assert.strictEqual(r.on_menu, false);
      assert.strictEqual(r.price, 22);
      assert.strictEqual(r.stock, 3);
    });
    check('stock is net of the safety buffer, as the till always drew it', () => {
      assert.strictEqual(rowFor(rowsA, P_BUFFER).stock, 6);   // 10 physical − 4 held
    });
    check('one location\'s shelf is not another\'s', () => {
      assert.strictEqual(rowFor(rowsA, P_NEITHER), null, "B's stock reached A's till");
      assert.ok(rowFor(rowsB, P_NEITHER), "B's own stock is missing from B's till");
    });
    check('one location\'s menu is not another\'s', () => {
      assert.strictEqual(rowsB.filter(r => r.on_menu).length, 0);
      assert.strictEqual(rowFor(rowsB, P_MADE), null, "A's made-here item reached B");
    });

    console.log('\nAdditive — nothing a cashier could see before has gone');
    check('a published product with nothing on the shelf is still there, at 0', () => {
      const r = rowFor(rowsA, P_PUB);
      assert.ok(r, 'the published catalogue disappeared from the till');
      assert.strictEqual(r.stock, 0);
      assert.strictEqual(r.price, 38);
    });
    check('and at the location with no shop at all, unchanged', () => {
      assert.ok(rowFor(rowsB, P_PUB), 'a plain location lost its catalogue');
      assert.strictEqual(rowFor(rowsB, P_PUB).on_menu, false);
    });
    check('a restock-only product is still not a thing to sell', () => {
      assert.strictEqual(rowFor(rowsA, P_RESTOCK), null);
    });
    check('a product with no price is still not a thing to sell', () => {
      assert.strictEqual(rowFor(rowsA, P_FREE), null);
    });
    check('in the catalogue but neither published nor counted here: absent', () => {
      assert.strictEqual(rowFor(rowsA, P_NEITHER), null);
    });

    console.log('\nThe till asks the new question, and posts the menu price');
    const till = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
    check('loadCatalogue reads counter-catalogue', () => {
      assert.match(till, /counter-catalogue/);
    });
    check('and no longer filters its own list by the website flag', () => {
      assert.doesNotMatch(till, /products\?published=1/,
        'the till is back to asking the online store what the counter may sell');
    });
    check('a menu line posts unit_price; a catalogue line does not', () => {
      // The order endpoint prices from sell_price unless told otherwise, and
      // §42 puts a listing's price somewhere it cannot see. Posting unit_price
      // on EVERY line would charge a stale figure whenever the office corrects
      // a catalogue price between two reloads of this tablet.
      // §183 CHANGED WHAT IS POSTED AND NOT WHETHER IT IS POSTED. The line's
      // own `price` now carries the chosen extras (an extra shot, oat milk) so
      // the bill on the glass adds up; the server adds those same deltas back
      // from its own price_delta columns. Posting the summed figure would have
      // the till pricing the extras AND the server pricing them again, which
      // is a double charge on every answered line. So the BASE goes up, and
      // `l.base` is the base — falling back to `l.price` for a line born
      // before it existed, and for every line that answered nothing.
      assert.match(till, /if \(l\.menu\) it\.unit_price = \(l\.base != null \? l\.base : l\.price\);/);
      assert.doesNotMatch(till, /product_id: l\.id, qty: l\.qty, unit_price/);
    });

    console.log('\nContainment — the till still never names the table');
    check('public/till.html does not read shop_listings', () => {
      assert.doesNotMatch(till, /shop_listings/,
        'the till names the table directly; scripts/test_shop_listings.js is the guard that must then be widened');
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
