#!/usr/bin/env node
/**
 * The public QR menu — /s/:shopCode. Step 5a of the location commerce module.
 *
 *   node scripts/test_shop_menu.js
 *
 * docs/tacet-consolidation-decisions.md §41, §42, §44, §45, §47, built in
 * routes/shop-menu.js — the page, and the order endpoint behind it. The PAGE
 * still carries no cart; that is the next piece of Step 5b, and the last
 * section of this file holds it to that.
 *
 * Everything runs against a REAL sqlite database and the REAL express router,
 * mounted and called over HTTP, so every status and body asserted here is
 * observed rather than reasoned about. routes/retail.js is loaded for real too
 * — the menu borrows its photo fallback and its money format, and a stub would
 * prove nothing about either.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. §47. A stocked listing with NO shelf record at its location reads SOLD
 *     OUT, not available. That is the whole of the ruling and it is the one
 *     assertion that would silently invert if somebody "fixed" the menu to
 *     match the online store's opposite fallback.
 *  2. The page is not an oracle. A malformed code, an unknown code, a
 *     switched-off shop and a switched-off location return BYTE-IDENTICAL
 *     bodies at 404, and none of them names a shop.
 *  3. A malformed code never becomes a shops query — counted, not assumed.
 *  4. Nothing branches on the user agent. The bytes inside WeChat, in a plain
 *     mobile browser and on a desktop are identical. WeChat is where this page
 *     lives, so the temptation to special-case it will recur; this is the line
 *     that makes doing so visible.
 *  5. No Roots literal. Rendered under a non-Roots theme the page carries that
 *     tenant's colours and name and NONE of Roots' — the §0 property the whole
 *     design rests on, and one a reading of the file cannot establish because
 *     the values arrive at runtime.
 *  6. The `/s` mount does not swallow /stock, /stock-login, /storefront or
 *     /shop-preview. Four live routes share that prefix as a string and must
 *     not share it as a path.
 *  7. scripts/check_shop_listing_names.js actually goes RED, and names the
 *     product and the missing language. The checker passes on an empty
 *     database by design, so without this it could pass by doing nothing.
 *  8. A PRICE POSTED BY THE CUSTOMER IS NOT A PRICE. The listing price is
 *     moved away from the catalogue price and a contradicting price is posted
 *     alongside the order; the total must be the shop's. No reading of the
 *     handler proves this, because the proof is that a field was IGNORED.
 *  9. A submit that is refused — sold out, over the shelf, off the menu, or
 *     over the rate limit — leaves NOTHING behind. Counted rows before and
 *     after, because a half-written order is a ticket in a kitchen for
 *     something nobody ordered.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the 91xx–98xx blocks the sibling suites use.
const LOC_LIVE = 9861;   // active location, active shop — the menu under test
const LOC_EMPTY = 9862;  // active location, active shop, zero listings
const LOC_OFF = 9863;    // active location, shop switched OFF
const LOC_DEAD = 9864;   // location switched OFF, shop switched on
const LOCS = [LOC_LIVE, LOC_EMPTY, LOC_OFF, LOC_DEAD];

const P_STOCK_OK   = 9951;  // stocked, shelf 5            → available
const P_STOCK_ZERO = 9952;  // stocked, shelf 0            → sold out
const P_STOCK_NONE = 9953;  // stocked, NO shelf row       → sold out (§47)
const P_STOCK_OFF  = 9954;  // stocked, shelf 9, switch off → sold out
const P_MADE_ON    = 9955;  // made_here, no shelf row      → available
const P_MADE_ZERO  = 9956;  // made_here, shelf 0           → available anyway
const P_MADE_OFF   = 9957;  // made_here, switch off        → sold out
const P_LOOSE      = 9958;  // no top_category              → unlabelled group
const P_UNPUB      = 9959;  // listed but NOT published     → photo must serve
const P_NONAME     = 9960;  // no name_cn                   → the checker's red
const PRODS = [P_STOCK_OK, P_STOCK_ZERO, P_STOCK_NONE, P_STOCK_OFF, P_MADE_ON,
               P_MADE_ZERO, P_MADE_OFF, P_LOOSE, P_UNPUB, P_NONAME];

// A 1x1 gif as a data URI — real bytes, so the photo route is exercised end to
// end rather than short-circuited by an empty column.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const CODES = {};   // location id -> minted public_code

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

const CFG_KEYS = ['theme.palette', 'theme.fonts', 'brand.me_footer', 'currency'];

// THIS SUITE CREATES THE FIRST STORE ROWS AND THE FIRST SHELF ROWS A FRESH
// DATABASE HAS EVER SEEN, and that has a consequence nobody would predict from
// the change that causes it — the same class of thing §43 records three of.
//
// database.js's pin_warehouse_store_id_v1 runs at REQUIRE time and, with no
// warehouse-role user to go on, pins the warehouse to "the active store holding
// the most stock". This suite spawns check_shop_listing_names.js as a child
// process WHILE its fixtures are live, that child boots the database, and the
// migration pins a fixture store — then stamps itself done so it never
// reconsiders. Cleanup then deletes the store and the pin is left naming a row
// that does not exist. scripts/test_warehouse_store_pin.js catches it two
// suites later, a long way from the cause.
//
// So the residue is undone here: both the pinned value and the _migrations
// stamp are put back exactly as they were found, which leaves the migration
// free to make its real decision on a later boot against real stores. Restoring
// only the value would be worse than leaving it — the stamp would say the
// question had been answered when it had not.
const PIN_KEY = 'stock.warehouseStoreId';
const PIN_MIGRATION = 'pin_warehouse_store_id_v1';
let PIN_BEFORE = null, PIN_STAMPED_BEFORE = false;
function savePin() {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(PIN_KEY);
  PIN_BEFORE = r ? r.value_json : null;
  PIN_STAMPED_BEFORE = !!db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(PIN_MIGRATION);
}
function restorePin() {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(PIN_KEY);
  const now = r ? r.value_json : null;
  if (now === PIN_BEFORE) return;                       // nothing this suite did
  const pinned = parseInt(String(now).replace(/[^0-9]/g, ''), 10);
  if (!LOCS.includes(pinned)) return;                   // a real store — leave it
  if (PIN_BEFORE === null) db.prepare('DELETE FROM storefront_config WHERE key = ?').run(PIN_KEY);
  else db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(PIN_KEY, PIN_BEFORE);
  if (!PIN_STAMPED_BEFORE) db.prepare('DELETE FROM _migrations WHERE name = ?').run(PIN_MIGRATION);
  console.log(`  · undid a warehouse pin this suite's fixtures caused (was ${now})`);
}
const CFG_SAVED = new Map();
function saveConfig() {
  for (const k of CFG_KEYS) {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
    CFG_SAVED.set(k, r ? r.value_json : null);
  }
}
function setConfig(k, v) {
  db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(k, JSON.stringify(v));
}
function restoreConfig() {
  for (const [k, v] of CFG_SAVED) {
    if (v === null) db.prepare('DELETE FROM storefront_config WHERE key = ?').run(k);
    else db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(k, v);
  }
}

function cleanup() {
  const qs = LOCS.map(() => '?').join(',');
  db.prepare(`DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id IN (${qs}))`).run(...LOCS);
  db.prepare(`DELETE FROM shops WHERE location_id IN (${qs})`).run(...LOCS);
  db.prepare(`DELETE FROM retail_store_stock WHERE store_id IN (${qs})`).run(...LOCS);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODS.map(() => '?').join(',')})`).run(...PRODS);
  db.prepare(`DELETE FROM retail_stores WHERE id IN (${qs})`).run(...LOCS);
}

function seed() {
  cleanup();
  const store = db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
                            VALUES (?, ?, ?, ?, ?, 97)`);
  store.run(LOC_LIVE,  '__test_menu_live',  'Menu fixture', '测试菜单店', 1);
  store.run(LOC_EMPTY, '__test_menu_empty', 'Empty fixture', '测试空店', 1);
  store.run(LOC_OFF,   '__test_menu_off',   'Off fixture', '测试停用店', 1);
  store.run(LOC_DEAD,  '__test_menu_dead',  'Dead fixture', '测试关闭店', 0);

  const prod = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category, image_data)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  //                                                                     published  category         image
  prod.run(P_STOCK_OK,   'Fixture cold brew',  '测试冷萃',   '__M-51', 28,   1, 'Drinks',       PIXEL);
  prod.run(P_STOCK_ZERO, 'Fixture kombucha',   '测试康普茶', '__M-52', 26,   1, 'Drinks',       null);
  prod.run(P_STOCK_NONE, 'Fixture uncounted',  '测试未盘点', '__M-53', 30,   1, 'Drinks',       null);
  prod.run(P_STOCK_OFF,  'Fixture switched',   '测试已关闭', '__M-54', 22,   1, 'Drinks',       null);
  prod.run(P_MADE_ON,    'Fixture oat latte',  '测试燕麦拿铁', '__M-55', 32, 1, 'Ready to Eat', null);
  prod.run(P_MADE_ZERO,  'Fixture flat white', '测试馥芮白', '__M-56', 30,   1, 'Ready to Eat', null);
  prod.run(P_MADE_OFF,   'Fixture soy latte',  '测试豆奶拿铁', '__M-57', 31, 1, 'Ready to Eat', null);
  prod.run(P_LOOSE,      'Fixture unfiled',    '测试未分类', '__M-58', 12,   1, null,           null);
  prod.run(P_UNPUB,      'Fixture unpublished', '测试未上架', '__M-59', 19,  0, 'Drinks',       PIXEL);
  prod.run(P_NONAME,     'Fixture nameless',   null,         '__M-60', 15,   1, 'Drinks',       null);

  const mkShop = db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, ?)');
  const codes = { [LOC_LIVE]: 'MENUAAA2', [LOC_EMPTY]: 'MENUBBB3', [LOC_OFF]: 'MENUCCC4', [LOC_DEAD]: 'MENUDDD5' };
  mkShop.run(LOC_LIVE,  codes[LOC_LIVE],  1);
  mkShop.run(LOC_EMPTY, codes[LOC_EMPTY], 1);
  mkShop.run(LOC_OFF,   codes[LOC_OFF],   0);   // shop switched off
  mkShop.run(LOC_DEAD,  codes[LOC_DEAD],  1);   // location switched off
  Object.assign(CODES, codes);

  const shopIdOf = (loc) => db.prepare('SELECT id FROM shops WHERE location_id = ?').get(loc).id;
  const liveShop = shopIdOf(LOC_LIVE);
  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // sort_position deliberately puts the Drinks rows FIRST, so the rendered
  // order proves the category tree decides group order, not insertion order.
  add.run(liveShop, P_STOCK_OK,   28,   'stocked',   1, 0);
  add.run(liveShop, P_STOCK_ZERO, 26,   'stocked',   1, 1);
  add.run(liveShop, P_STOCK_NONE, 30,   'stocked',   1, 2);
  add.run(liveShop, P_STOCK_OFF,  22,   'stocked',   0, 3);
  add.run(liveShop, P_UNPUB,      19.5, 'stocked',   1, 4);
  add.run(liveShop, P_MADE_ON,    32,   'made_here', 1, 5);
  add.run(liveShop, P_MADE_ZERO,  30,   'made_here', 1, 6);
  add.run(liveShop, P_MADE_OFF,   31,   'made_here', 0, 7);
  add.run(liveShop, P_LOOSE,      12,   'stocked',   1, 8);
  // P_LOOSE is stocked and must have a shelf row, or §47 would make it sold
  // out and the grouping assertion would be reading a greyed row.
  const shelf = db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
                            VALUES (?, ?, ?, 0)`);
  shelf.run(LOC_LIVE, P_STOCK_OK, 5);
  shelf.run(LOC_LIVE, P_STOCK_ZERO, 0);
  shelf.run(LOC_LIVE, P_STOCK_OFF, 9);
  shelf.run(LOC_LIVE, P_UNPUB, 3);
  shelf.run(LOC_LIVE, P_MADE_ZERO, 0);      // made-here ignores this entirely
  shelf.run(LOC_LIVE, P_LOOSE, 4);
  // P_STOCK_NONE gets NO ROW ANYWHERE. That absence is §47's subject.
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(router);
let server, PORT;

function get(url, headers) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, { headers: headers || {} })
    .then(async r => ({ status: r.status, body: await r.text(), type: r.headers.get('content-type') || '' }));
}
function getBuf(url) {
  return fetch(`http://127.0.0.1:${PORT}${url}`)
    .then(async r => ({ status: r.status, bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' }));
}

// Text between an item's opening div and its close, so an assertion can ask
// "is THIS product's row greyed" rather than "does the page contain 售罄".
function rowFor(html, nameEn) {
  const at = html.indexOf(nameEn);
  assert.ok(at > -1, `product "${nameEn}" is not on the page at all`);
  const start = html.lastIndexOf('<div class="it', at);
  assert.ok(start > -1, `no row wrapper before "${nameEn}"`);
  const end = html.indexOf('<div class="it', at);
  return html.slice(start, end === -1 ? html.length : end);
}
const soldOut = (row) => /class="sold"/.test(row);

(async () => {
  saveConfig();
  savePin();
  seed();
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });
  try {
    const LIVE = CODES[LOC_LIVE];

    console.log('\n§47 — availability, and the absent shelf record');
    await checkAsync('stocked with units on the shelf is available', async () => {
      const { status, body } = await get(`/s/${LIVE}`);
      assert.strictEqual(status, 200);
      assert.ok(!soldOut(rowFor(body, 'Fixture cold brew')), 'shelf of 5 read as sold out');
    });
    await checkAsync('stocked at zero is sold out', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(soldOut(rowFor(body, 'Fixture kombucha')), 'shelf of 0 read as available');
    });
    await checkAsync('§47 — stocked with NO shelf record at this location is SOLD OUT', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(soldOut(rowFor(body, 'Fixture uncounted')),
        'a product this location has never counted rendered as available — §47 says sold out, ' +
        'and the online store\'s opposite fallback is not to be copied here');
    });
    await checkAsync('the staff switch alone sells a stocked item out', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(soldOut(rowFor(body, 'Fixture switched')), 'is_available=0 with 9 on the shelf read as available');
    });
    await checkAsync('made-here is available with no shelf record at all', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(!soldOut(rowFor(body, 'Fixture oat latte')), 'made-here read stock it is not supposed to have');
    });
    await checkAsync('made-here ignores a shelf record reading zero', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(!soldOut(rowFor(body, 'Fixture flat white')), 'made-here was sold out by a stock row §43 says is irrelevant');
    });
    await checkAsync('made-here obeys its own switch', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(soldOut(rowFor(body, 'Fixture soy latte')), 'the §42 manual switch did not sell it out');
    });
    await checkAsync('sold-out items are SHOWN, never hidden', async () => {
      const { body } = await get(`/s/${LIVE}`);
      for (const n of ['Fixture kombucha', 'Fixture uncounted', 'Fixture switched', 'Fixture soy latte']) {
        assert.ok(body.includes(n), `${n} was hidden rather than badged`);
      }
    });

    await checkAsync('a product with no photo gets the empty frame, never a broken <img>', async () => {
      // Found by looking at the rendered page: an <img> pointing at a route
      // that 404s is drawn by the phone as a broken-image glyph, which reads
      // as a fault in the shop rather than a product nobody photographed.
      const { body } = await get(`/s/${LIVE}`);
      const withPhoto = rowFor(body, 'Fixture cold brew');
      // Available AND photoless, so the frame is empty rather than holding a
      // sold-out bar — the case that would otherwise draw a broken glyph.
      const without = rowFor(body, 'Fixture oat latte');
      assert.ok(/<img /.test(withPhoto), 'a product WITH a photo lost its image');
      assert.ok(!/<img /.test(without), 'a product with no photo still emits an <img> that will 404');
      assert.ok(/<div class="ph"><\/div>/.test(without), 'the empty photo frame is missing');
    });

    console.log('\nThe page is not an oracle — every unresolvable code answers the same');
    await checkAsync('malformed, unknown, shop-off and location-off are byte-identical 404s', async () => {
      const bad = await get('/s/nope');                       // malformed
      const unknown = await get('/s/ZZZZZZZ9');               // well-formed, no shop
      const shopOff = await get(`/s/${CODES[LOC_OFF]}`);      // shop switched off
      const locOff = await get(`/s/${CODES[LOC_DEAD]}`);      // location switched off
      for (const r of [bad, unknown, shopOff, locOff]) assert.strictEqual(r.status, 404);
      assert.strictEqual(unknown.body, bad.body, 'unknown code differs from malformed');
      assert.strictEqual(shopOff.body, bad.body, 'a switched-off shop is distinguishable from a bad code');
      assert.strictEqual(locOff.body, bad.body, 'a switched-off location is distinguishable from a bad code');
    });
    await checkAsync('no 404 body names a shop', async () => {
      for (const u of ['/s/nope', '/s/ZZZZZZZ9', `/s/${CODES[LOC_OFF]}`, `/s/${CODES[LOC_DEAD]}`]) {
        const { body } = await get(u);
        for (const n of ['Off fixture', 'Dead fixture', '测试停用店', '测试关闭店', CODES[LOC_OFF], CODES[LOC_DEAD]]) {
          assert.ok(!body.includes(n), `${u} leaked "${n}"`);
        }
      }
    });
    await checkAsync('a malformed code never becomes a shops query', async () => {
      const real = db.prepare.bind(db);
      let shopQueries = 0;
      db.prepare = (sql) => { if (/\bFROM\s+shops\b/i.test(sql)) shopQueries++; return real(sql); };
      try { await get('/s/lower123'); await get('/s/TOOLONGCODE9'); await get('/s/SH0RT'); }
      finally { db.prepare = real; }
      assert.strictEqual(shopQueries, 0, `${shopQueries} shops quer(ies) ran for a code that cannot exist`);
    });

    await checkAsync('and that sameness is not vacuous — a LIVE shop looks different', async () => {
      const live = await get(`/s/${LIVE}`);
      const bad = await get('/s/nope');
      assert.strictEqual(live.status, 200);
      assert.notStrictEqual(live.body, bad.body,
        'every page is identical, so the identical-404 assertion above proves nothing');
    });
    await checkAsync('neither a menu nor a 404 may be cached by an intermediary', async () => {
      for (const u of [`/s/${LIVE}`, '/s/nope']) {
        const r = await fetch(`http://127.0.0.1:${PORT}${u}`);
        assert.ok(/no-store/.test(r.headers.get('cache-control') || ''),
          `${u} is cacheable — it carries live prices and availability`);
      }
    });

    console.log('\nThe empty menu — the launch state, since no shop has a listing yet');
    await checkAsync('a shop with no listings renders the empty state at 200', async () => {
      const { status, body } = await get(`/s/${CODES[LOC_EMPTY]}`);
      assert.strictEqual(status, 200);
      assert.ok(body.includes('No products yet.') && body.includes('暂无商品'), 'empty title missing');
      assert.ok(body.includes('Check back soon.') && body.includes('请稍后再来'), 'empty subtitle missing');
      assert.ok(body.includes('Empty fixture') && body.includes('测试空店'), 'the shop still names itself');
      assert.ok(!body.includes('class="it'), 'an empty menu rendered item rows');
    });

    console.log('\nGrouping');
    await checkAsync('groups follow the category tree order, not the menu sort order', async () => {
      const { body } = await get(`/s/${LIVE}`);
      const ready = body.indexOf('Ready to Eat');
      const drinks = body.indexOf('Drinks');
      assert.ok(ready > -1 && drinks > -1, 'both group headings should render');
      assert.ok(ready < drinks,
        'Drinks sorted first in the menu, so insertion order won — the tree decides group order');
    });
    await checkAsync('the uncategorised band is last, and its labels are the shop\'s own', async () => {
      const { body } = await get(`/s/${LIVE}`);
      const loose = body.indexOf('Fixture unfiled');
      assert.ok(loose > body.indexOf('Fixture oat latte'), 'the unfiled band is not last');
      // OTHER / 其他 and ALL / 全部 are copied from miniapp/pages/shop/shop.js,
      // so the rail mints nothing. The unfiled band's own section heading stays
      // EMPTY rather than inventing a word for it.
      assert.ok(body.includes('OTHER') && body.includes('其他'), 'the OTHER band lost its live label');
      assert.ok(body.includes('ALL') && body.includes('全部'), 'the ALL tab lost its live label');
      const band = body.slice(body.lastIndexOf('<section class="cat"', loose), loose);
      assert.ok(/<div class="kick"><\/div>/.test(band), 'the unfiled band grew a section heading');
    });
    await checkAsync('the rail lists every category holding something, and the count is padded', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(/<nav class="rail">/.test(body), 'no category rail');
      assert.ok(/class="cnt">0\d</.test(body), 'the section count is not zero-padded to two digits');
    });

    console.log('\nLanguage — both sides present, CSS chooses, detection never re-runs');
    await checkAsync('both languages ship in the DOM', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(body.includes('Fixture cold brew') && body.includes('测试冷萃'), 'a name is missing a side');
      assert.ok(body.includes('class="l-en"') && body.includes('class="l-cn"'), 'the bilingual span pair is missing');
      assert.ok(body.includes('.lang-en .l-cn') && body.includes('.lang-cn .l-en'), 'the CSS switch is missing');
    });
    await checkAsync('the toggle is present and the strings are the storefront\'s own', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(body.includes('data-lang="en"') && body.includes('data-lang="cn"'), 'no toggle');
      assert.ok(body.includes('>EN<') && body.includes('>中<'), 'toggle labels are not the live pair');
    });
    await checkAsync('the sold-out badge is the live 售罄 pair', async () => {
      const { body } = await get(`/s/${LIVE}`);
      const row = rowFor(body, 'Fixture kombucha');
      assert.ok(row.includes('售罄') && row.includes('Sold out'), 'the badge is not the live pair');
    });
    await checkAsync('opens English by default and Chinese on ?lang=cn', async () => {
      const en = await get(`/s/${LIVE}`);
      const cn = await get(`/s/${LIVE}?lang=cn`);
      assert.ok(en.body.includes('class="lang-en"'), 'default is not English');
      assert.ok(cn.body.includes('class="lang-cn"'), '?lang=cn did not open in Chinese');
      assert.ok(cn.body.includes('lang="zh-CN"'), 'the document language attribute did not follow');
    });
    await checkAsync('the session choice is read before anything is inferred', async () => {
      const { body } = await get(`/s/${LIVE}`);
      const script = body.slice(body.indexOf('<script>'), body.indexOf('</script>'));
      assert.ok(script.includes('sessionStorage'), 'the opening script does not consult the session choice');
      assert.ok(script.indexOf('sessionStorage') < script.indexOf('navigator.language'),
        'detection is consulted before the reader\'s own choice — §26\'s narrowing forbids that');
    });
    await checkAsync('an explicit ?lang= suppresses detection entirely', async () => {
      const { body } = await get(`/s/${LIVE}?lang=en`);
      const script = body.slice(body.indexOf('<script>'), body.indexOf('</script>'));
      assert.ok(!script.includes('navigator.language'),
        'the client language was still sniffed over an explicit request');
    });

    console.log('\nNothing branches on the user agent');
    await checkAsync('WeChat, plain mobile and desktop get byte-identical pages', async () => {
      const wechat = await get(`/s/${LIVE}`, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2f) NetType/WIFI Language/zh_CN' });
      const mobile = await get(`/s/${LIVE}`, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' });
      const desktop = await get(`/s/${LIVE}`, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
      assert.strictEqual(wechat.status, 200);
      assert.strictEqual(mobile.body, wechat.body, 'the page differs inside WeChat');
      assert.strictEqual(desktop.body, wechat.body, 'the page differs on desktop');
    });
    await checkAsync('the WeChat language header does not move the opening language either', async () => {
      const zh = await get(`/s/${LIVE}`, { 'accept-language': 'zh-CN,zh;q=0.9' });
      assert.ok(zh.body.includes('class="lang-en"'),
        'the server guessed from Accept-Language — detection is the CLIENT\'s job (§44), ' +
        'so that a cached page can never carry somebody else\'s language');
    });

    console.log('\nTenant-themed, not Roots-hardcoded (§0)');
    await checkAsync('renders a non-Roots theme, and carries no Roots value', async () => {
      setConfig('theme.palette', { primary: '#123456', accent: '#654321', surface: '#abcdef', ink: '#101010', muted: '#202020' });
      setConfig('theme.fonts', { display: { source: 'library', family: 'Inter' }, body: { source: 'library', family: 'Work Sans' } });
      setConfig('brand.me_footer', { wordmark_text: 'Fixture Tenant' });
      setConfig('currency', { code: 'GBP', symbol: '£', decimals: 2, position: 'before' });
      const { body } = await get(`/s/${LIVE}`);
      for (const v of ['#123456', '#654321', '#abcdef', '#101010', '#202020', 'Inter', 'Work Sans', 'Fixture Tenant']) {
        assert.ok(body.includes(v), `the tenant's own ${v} did not reach the page`);
      }
      for (const v of ['Roots', '#365329', '#F2E7DF', '#CCD900', '#6A6E2D', '#1a1a17', 'Bear Serif', 'Aleo']) {
        assert.ok(!body.includes(v), `a Roots value survived a non-Roots theme: ${v}`);
      }
    });
    await checkAsync('money is the tenant\'s own currency, not a ¥ literal', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(body.includes('£28.00'), 'the tenant\'s symbol and decimals did not reach the price');
      assert.ok(!body.includes('¥'), 'a hardcoded yuan symbol reached a page under a GBP tenant');
    });
    await checkAsync('a tenant on a stock system font ships no @font-face at all', async () => {
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(!body.includes('@font-face'), 'font bytes were offered for a family this app does not host');
    });
    await checkAsync('...and a tenant on an installed family DOES get its @font-face', async () => {
      // The other half, so the assertion above is a real distinction rather
      // than a page that never emits a face at all.
      setConfig('theme.fonts', { display: { source: 'library', family: 'League Gothic' },
                                 body: { source: 'library', family: 'Lilita One' } });
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(body.includes('@font-face'), 'an installed family got no face');
      assert.ok(body.includes('/assets/fonts/LeagueGothic.ttf'), 'the display face is not served');
      assert.ok(body.includes('/assets/fonts/LilitaOne.ttf'), 'the body face is not served');
    });
    await checkAsync('a tenant\'s own uploaded face is served from its own https url', async () => {
      setConfig('theme.fonts', { display: { source: 'upload', family: 'Tenant Display', url: 'https://cdn.example.com/x.woff2' },
                                 body: { source: 'library', family: 'Inter' } });
      const { body } = await get(`/s/${LIVE}`);
      assert.ok(body.includes("url('https://cdn.example.com/x.woff2') format('woff2')"), 'the upload face is not served');
      restoreConfig();
    });

    await checkAsync('a hostile theme value cannot close the <style> element', async () => {
      // brand-theme's cleanHex passes any "rgb…" string through whole and
      // cleanFont keeps 80 characters of a family name. Both are fine for their
      // own consumers, which set CSS variables from JavaScript; this page is the
      // first to inline them into markup. An operator must not be able to put
      // script on their own public menu through the palette editor.
      setConfig('theme.palette', { primary: 'rgb(0,0,0)</style><script>window.__pwned=1</script>', accent: '#654321', surface: '#abcdef', ink: '#101010', muted: '#202020' });
      setConfig('theme.fonts', { display: { source: 'library', family: 'x</style><script>1</script>' }, body: { source: 'library', family: 'Inter' } });
      const { body } = await get(`/s/${LIVE}`);
      assert.strictEqual((body.match(/<style>/g) || []).length, 1, 'the stylesheet was split in two');
      assert.strictEqual((body.match(/<\/style>/g) || []).length, 1, 'the stylesheet was closed twice');
      const sheet = body.slice(body.indexOf('<style>') + 7, body.indexOf('</style>'));
      // The invariant is that no markup can be BUILT out of a config value —
      // not that the characters vanish. What is left of the payload sits inside
      // the stylesheet as an invalid declaration, which is inert.
      assert.ok(!/[<>]/.test(sheet), 'an angle bracket reached the stylesheet');
      assert.ok(!/<script[^>]*>window\.__pwned/.test(body), 'the payload became a script tag');
      restoreConfig();
    });

    console.log('\nThe menu photo — listed at an active shop, NOT is_published');
    await checkAsync('an UNPUBLISHED but listed product serves its photo', async () => {
      const r = await getBuf(`/s/${LIVE}/i/${P_UNPUB}?w=80`);
      assert.strictEqual(r.status, 200, 'is_published leaked into the menu\'s gate');
      assert.ok(r.bytes.length > 0 && /^image\//.test(r.type), `not image bytes: ${r.type}`);
    });
    await checkAsync('a published, listed product serves its photo', async () => {
      const r = await getBuf(`/s/${LIVE}/i/${P_STOCK_OK}?w=80`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.bytes.length > 0);
    });
    await checkAsync('a product not listed at this shop is refused', async () => {
      const r = await getBuf(`/s/${LIVE}/i/${P_NONAME}`);
      assert.strictEqual(r.status, 404, 'an unlisted product\'s photo was served through a shop menu');
    });
    await checkAsync('a listed product is refused through another shop\'s code', async () => {
      const r = await getBuf(`/s/${CODES[LOC_EMPTY]}/i/${P_UNPUB}`);
      assert.strictEqual(r.status, 404, 'one shop\'s code served another shop\'s photo');
    });
    await checkAsync('a switched-off shop serves no photos', async () => {
      const r = await getBuf(`/s/${CODES[LOC_OFF]}/i/${P_UNPUB}`);
      assert.strictEqual(r.status, 404);
    });
    await checkAsync('a malformed code serves no photos', async () => {
      const r = await getBuf(`/s/lower123/i/${P_UNPUB}`);
      assert.strictEqual(r.status, 404);
    });

    console.log('\nThe /s mount does not swallow the routes that share its prefix');
    await checkAsync('/stock, /stock-login, /storefront and /shop-preview are untouched', async () => {
      const probe = express();
      const hit = [];
      probe.use('/s', (req, res, next) => { hit.push('SCOPE:' + req.originalUrl); next(); });
      probe.use(router);
      for (const p of ['/stock', '/stock-login', '/storefront', '/shop-preview', '/stock-manifest.webmanifest']) {
        probe.get(p, (req, res) => res.type('text').send('own handler ' + p));
      }
      const srv = await new Promise(r => { const s = probe.listen(0, '127.0.0.1', () => r(s)); });
      try {
        const port = srv.address().port;
        for (const p of ['/stock', '/stock-login', '/storefront', '/shop-preview', '/stock-manifest.webmanifest']) {
          const res = await fetch(`http://127.0.0.1:${port}${p}`);
          const txt = await res.text();
          assert.strictEqual(res.status, 200, `${p} stopped resolving`);
          assert.strictEqual(txt, 'own handler ' + p, `${p} was answered by the menu`);
        }
        assert.deepStrictEqual(hit, [], `the /s tenant scope ran for: ${hit.join(', ')}`);
      } finally { srv.close(); }
    });

    console.log('\nThe pre-launch name gate goes red, and says which product and which language');
    check('a listing missing name_cn blocks, naming the product and Chinese', () => {
      const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC_LIVE).id;
      db.prepare(`INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, sort_position)
                  VALUES (?, ?, 15, 'stocked', 20)`).run(shopId, P_NONAME);
      try {
        const r = spawnSync(process.execPath, [path.join(__dirname, 'check_shop_listing_names.js')],
          { cwd: ROOT, encoding: 'utf8' });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\n${out}`);
        assert.ok(out.includes(String(P_NONAME)), 'the blocked product is not named');
        assert.ok(out.includes('__M-60'), 'the blocked product\'s SKU is not named');
        assert.ok(/Chinese/.test(out), 'the missing language is not named');
      } finally {
        db.prepare('DELETE FROM shop_listings WHERE shop_id = ? AND store_product_id = ?').run(shopId, P_NONAME);
      }
    });
    check('with both names present it does not block that product', () => {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'check_shop_listing_names.js')],
        { cwd: ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(!out.includes('__M-60'), `the fixture is still blocked after being unlisted:\n${out}`);
    });

    console.log('\nSubmitting an order (§44, §45)');
    const post = (u, body) => fetch(`http://127.0.0.1:${PORT}${u}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

    // The handler rate-limits a single caller to 12 orders a minute, and this
    // whole section posts more than that from one address. The count is cleared
    // between checks so a limiter working correctly cannot be mistaken for a
    // handler that has stopped creating orders; the limiter itself is proved at
    // the end of the section, where the clearing stops.
    const resetOrderLimit = async () => {
      for (const k of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
        await router.orderLimiter.resetKey(k);
      }
    };

    await checkAsync('a valid order is created, priced from the LISTING, with a short code', async () => {
      await resetOrderLimit();
      const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_STOCK_OK, qty: 2 }] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      const d = r.json.data;
      assert.strictEqual(d.name, 'Mei');
      assert.strictEqual(d.status, 'pending_payment', 'a status no screen understands would hide the order');
      assert.ok(Number.isInteger(d.order_code) && d.order_code >= 1, `short code: ${d.order_code}`);
      // The listing price is 28; the catalogue price is also 28 in this fixture,
      // so the next check is the one that proves WHICH was used.
      assert.strictEqual(d.items[0].unit_price, 28);
      assert.strictEqual(d.total, 56);
      const row = db.prepare('SELECT channel, source, fulfillment_type, shop_entry_method, store_id, customer_id FROM retail_orders WHERE order_no = ?').get(d.order_no);
      assert.strictEqual(row.channel, 'shop');
      assert.strictEqual(row.source, 'qr');
      assert.strictEqual(row.fulfillment_type, 'counter', 'not counter → the twenty-minute clock and §45 both miss it');
      assert.strictEqual(row.shop_entry_method, 'qr');
      assert.strictEqual(row.customer_id, null, 'a QR order has no account, by §44');
      db.prepare('DELETE FROM retail_stock_reservations WHERE order_id IN (SELECT id FROM retail_orders WHERE order_no = ?)').run(d.order_no);
      db.prepare('DELETE FROM retail_order_items WHERE order_id IN (SELECT id FROM retail_orders WHERE order_no = ?)').run(d.order_no);
      db.prepare('DELETE FROM retail_payments WHERE order_id IN (SELECT id FROM retail_orders WHERE order_no = ?)').run(d.order_no);
      db.prepare('DELETE FROM retail_orders WHERE order_no = ?').run(d.order_no);
    });

    await checkAsync('THE PRICE IS THE SHOP\'S, NOT THE CLIENT\'S', async () => {
      await resetOrderLimit();
      // The single most important assertion in this file. A customer posting a
      // price must never be charged it.
      const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC_LIVE).id;
      db.prepare('UPDATE shop_listings SET price = 99 WHERE shop_id = ? AND store_product_id = ?').run(shopId, P_STOCK_OK);
      const r = await post(`/s/${LIVE}/order`, {
        name: 'Mei',
        items: [{ store_product_id: P_STOCK_OK, qty: 1, price: 1, unit_price: 1, line_total: 1 }],
      });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.json.data.total, 99, 'a price posted by the customer was honoured');
      db.prepare('UPDATE shop_listings SET price = 28 WHERE shop_id = ? AND store_product_id = ?').run(shopId, P_STOCK_OK);
      db.prepare('DELETE FROM retail_stock_reservations WHERE order_id IN (SELECT id FROM retail_orders WHERE order_no = ?)').run(r.json.data.order_no);
      db.prepare('DELETE FROM retail_orders WHERE order_no = ?').run(r.json.data.order_no);
    });

    await checkAsync('a sold-out item is refused WHOLE, not silently shortened', async () => {
      await resetOrderLimit();
      const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_STOCK_NONE, qty: 1 }] });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'unavailable');
      assert.ok(r.json.items.some(i => i.store_product_id === P_STOCK_NONE));
    });
    await checkAsync('more than the shelf holds is refused', async () => {
      await resetOrderLimit();
      // P_STOCK_OK has 5 on the shelf. Asking for 6 must not sell the sixth.
      const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_STOCK_OK, qty: 6 }] });
      assert.strictEqual(r.status, 409, 'oversold past the shelf');
    });
    await checkAsync('a product not on THIS menu is refused', async () => {
      await resetOrderLimit();
      const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_NONAME, qty: 1 }] });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.error, 'not_on_this_menu');
    });
    await checkAsync('a name is required, and junk quantities are refused', async () => {
      await resetOrderLimit();
      assert.strictEqual((await post(`/s/${LIVE}/order`, { items: [{ store_product_id: P_STOCK_OK, qty: 1 }] })).json.error, 'name_required');
      assert.strictEqual((await post(`/s/${LIVE}/order`, { name: 'Mei', items: [] })).json.error, 'no_items');
      for (const qty of [0, -1, 999, 'x']) {
        const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_STOCK_OK, qty }] });
        assert.strictEqual(r.json.error, 'bad_qty', `qty ${qty} was accepted`);
      }
    });
    await checkAsync('a switched-off shop and a bad code take no orders', async () => {
      await resetOrderLimit();
      assert.strictEqual((await post(`/s/${CODES[LOC_OFF]}/order`, { name: 'Mei', items: [{ store_product_id: P_STOCK_OK, qty: 1 }] })).status, 404);
      assert.strictEqual((await post('/s/lower123/order', { name: 'Mei', items: [{ store_product_id: P_STOCK_OK, qty: 1 }] })).status, 404);
    });
    await checkAsync('a made-here line reserves nothing; a stocked line reserves', async () => {
      await resetOrderLimit();
      const r = await post(`/s/${LIVE}/order`, {
        name: 'Mei',
        items: [{ store_product_id: P_MADE_ON, qty: 1 }, { store_product_id: P_STOCK_OK, qty: 1 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      const oid = db.prepare('SELECT id FROM retail_orders WHERE order_no = ?').get(r.json.data.order_no).id;
      const res = db.prepare('SELECT product_id FROM retail_stock_reservations WHERE order_id = ?').all(oid).map(x => x.product_id);
      assert.deepStrictEqual(res, [P_STOCK_OK],
        'a made-here item reserved stock it has none of, or a stocked one reserved nothing (§43, §45)');
      db.prepare('DELETE FROM retail_stock_reservations WHERE order_id = ?').run(oid);
      db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(oid);
      db.prepare('DELETE FROM retail_payments WHERE order_id = ?').run(oid);
      db.prepare('DELETE FROM retail_orders WHERE id = ?').run(oid);
    });
    await checkAsync('the short code counts up per shop, per day', async () => {
      await resetOrderLimit();
      const made = [];
      for (let i = 0; i < 3; i++) {
        const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_MADE_ON, qty: 1 }] });
        assert.strictEqual(r.status, 201);
        made.push(r.json.data.order_code);
      }
      assert.deepStrictEqual(made, [made[0], made[0] + 1, made[0] + 2], `codes did not count up: ${made}`);
      for (const on of made) {
        const oid = db.prepare('SELECT id FROM retail_orders WHERE shop_order_code = ? AND store_id = ?').get(on, LOC_LIVE).id;
        db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(oid);
        db.prepare('DELETE FROM retail_payments WHERE order_id = ?').run(oid);
        db.prepare('DELETE FROM retail_orders WHERE id = ?').run(oid);
      }
    });

    await checkAsync('the tender is one the rest of the system already knows', async () => {
      // A QR order is unpaid at create and staff's Mark-paid writes the real
      // tender over this. What it must NOT carry meanwhile is a value invented
      // here: routes/retail.js's ALLOWED_PAY is the list every reader of this
      // column shares, and a value outside it reconciles against nothing.
      await resetOrderLimit();
      const src = require('fs').readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
      const m = src.match(/const ALLOWED_PAY = \[([\s\S]*?)\];/);
      assert.ok(m, 'ALLOWED_PAY has moved or been renamed — this check cannot see it any more');
      const allowed = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
      const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_MADE_ON, qty: 1 }] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      const oid = db.prepare('SELECT id FROM retail_orders WHERE order_no = ?').get(r.json.data.order_no).id;
      const o = db.prepare('SELECT payment_method, status FROM retail_orders WHERE id = ?').get(oid);
      const pay = db.prepare('SELECT method, status FROM retail_payments WHERE order_id = ?').get(oid);
      assert.ok(allowed.includes(o.payment_method), `tender '${o.payment_method}' is not in ALLOWED_PAY`);
      assert.strictEqual(pay.method, o.payment_method, 'the order and its payment row disagree on the tender');
      assert.strictEqual(pay.status, 'pending', 'a QR order is unpaid until the counter says otherwise');
      db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(oid);
      db.prepare('DELETE FROM retail_payments WHERE order_id = ?').run(oid);
      db.prepare('DELETE FROM retail_orders WHERE id = ?').run(oid);
    });

    await checkAsync('a flood from one phone is stopped, and stopped WITHOUT creating orders', async () => {
      // No reset here — that is the point. A refused submit must leave nothing
      // behind: an order counted against the limiter but written to the table
      // anyway would fill the kitchen with tickets nobody ordered.
      await resetOrderLimit();
      const before = db.prepare('SELECT COUNT(*) AS n FROM retail_orders WHERE store_id = ?').get(LOC_LIVE).n;
      let refused = 0, made = [];
      for (let i = 0; i < 15; i++) {
        const r = await post(`/s/${LIVE}/order`, { name: 'Mei', items: [{ store_product_id: P_MADE_ON, qty: 1 }] });
        if (r.status === 429) refused++;
        else { assert.strictEqual(r.status, 201, JSON.stringify(r.json)); made.push(r.json.data.order_code); }
      }
      assert.strictEqual(made.length, 12, `the limiter let ${made.length} through, not 12`);
      assert.strictEqual(refused, 3);
      const after = db.prepare('SELECT COUNT(*) AS n FROM retail_orders WHERE store_id = ?').get(LOC_LIVE).n;
      assert.strictEqual(after - before, 12, 'a refused submit still wrote an order');
      for (const on of made) {
        const oid = db.prepare('SELECT id FROM retail_orders WHERE shop_order_code = ? AND store_id = ?').get(on, LOC_LIVE).id;
        db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(oid);
        db.prepare('DELETE FROM retail_payments WHERE order_id = ?').run(oid);
        db.prepare('DELETE FROM retail_orders WHERE id = ?').run(oid);
      }
      await resetOrderLimit();
    });

    console.log('\nThe page still offers no ordering surface — that is step 5b\'s cart, not this page');
    await checkAsync('the page offers no cart, no quantity control and no submit', async () => {
      const { body } = await get(`/s/${LIVE}`);
      for (const s of ['<form', '<input', 'type="submit"', 'addToCart', '/api/retail/orders']) {
        assert.ok(!body.includes(s), `the menu grew an ordering surface: ${s}`);
      }
    });
    await checkAsync('the page sets no cookie', async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/s/${LIVE}`);
      assert.strictEqual(r.headers.get('set-cookie'), null, 'the menu set a cookie');
    });

  } finally {
    server.close();
    restoreConfig();
    cleanup();
    restorePin();
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})();
