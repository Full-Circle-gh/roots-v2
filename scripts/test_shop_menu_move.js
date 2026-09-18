#!/usr/bin/env node
/**
 * Moving a menu to another location — §177.
 *
 *   node scripts/test_shop_menu_move.js
 *
 * docs/tacet-consolidation-decisions.md §177 (2026-09-18), built in
 * routes/retail-shops.js (POST /api/retail-admin/shops/:id/move) and driven
 * from public/retail-admin/28-shops.js. Ash's brief was "the shop menu should
 * move form tianhe to yuexiu" and the shape chosen was B: the listings move,
 * the source's menu is emptied.
 *
 * Everything runs against a REAL sqlite database (database.js opens
 * data/roots.db and applies the migration on require) and the REAL express
 * router, mounted and called over HTTP, so every status and body printed here
 * is observed. The auth choke point is stubbed the way test_shop_listings.js
 * stubs it, and logActivity is stubbed to a RECORDER rather than a no-op,
 * because two of its entries are part of what this section promises.
 *
 * SIX THINGS ARE HELD HERE THAT A READING OF THE CODE CANNOT PROVE.
 *
 *   1. THE SHOP RECORD AND ITS CODE DO NOT MOVE. Both shops keep the
 *      `location_id` and `public_code` they had, the destination's code is its
 *      own and not the source's, and nothing in this route writes either
 *      column — asserted against the source as well as the data, because §44
 *      rests on a printed QR still meaning what it meant.
 *   2. THE LISTINGS ARRIVE VERBATIM. Price, fulfilment mode, the daily
 *      availability switch and `sort_position` all come across unchanged, with
 *      the positions deliberately NON-CONTIGUOUS in the fixture (0, 3, 7, 11)
 *      so a route that re-sequenced them would be caught rather than flattered.
 *   3. THE SOURCE IS EMPTIED AND SWITCHED OFF, NOT DELETED. The row, its code
 *      and its history survive; `is_active` is 0, which is what stops the
 *      public page serving it.
 *   4. AN EMPTY SHOP AT THE DESTINATION IS REUSED AND ITS SWITCH IS NOT
 *      TOUCHED. A shop that was off before the move is off after it, carrying
 *      its new menu — §177's rule, and v4.312's reason: a setting changed as a
 *      side effect stays invisible until somebody at a counter notices.
 *   5. EVERY REFUSAL MOVES NOTHING. Each of the six is asserted with the
 *      source menu re-counted afterwards, because a refusal that had already
 *      half-run would be indistinguishable from this one on the status alone.
 *   6. THE PUBLIC PAGE NEEDS NO NEW BEHAVIOUR. The moved-away code fails
 *      `resolveShop()`'s own predicate and the destination's passes it, so the
 *      dead QR serves the not-found page that was already there.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// The auth seam — stubbed BEFORE the route loads, named from this file
// (require.resolve is relative to the caller) and keyed on the absolute path
// the route's own require('./retail') resolves to.
function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
// A RECORDER, not a no-op: §177 says the move is logged against both shops,
// and the source's entry is the only record of why a live menu went empty and
// a printed code went dead.
const LOGGED = [];
stub('../middleware/auth', {
  logActivity: (userId, username, action, subject, subjectId, detail) =>
    LOGGED.push({ action, subject, subjectId, detail }),
});

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { isShopCode } = require(path.join(ROOT, 'lib', 'shop-code.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the 98xx blocks the sibling shop suites already use
// (9811/9812 in test_shop_listings.js, 9841/9842, 9861–9864).
const SRC       = 9871;   // the menu that moves — four listings
const SRC2      = 9872;   // a second menu, for the reuse case
const FRESH     = 9873;   // no shop at all: the move mints one
const OFF_DEST  = 9874;   // a shop, no listings, switched OFF: reused, left off
const HAS_MENU  = 9875;   // a shop with a listing of its own: refused
const LOCS = [SRC, SRC2, FRESH, OFF_DEST, HAS_MENU];
const P1 = 9891, P2 = 9892, P3 = 9893, P4 = 9894;
const PRODUCTS = [P1, P2, P3, P4];

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
  const inLocs = LOCS.join(',');
  db.prepare(`DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id IN (${inLocs}))`).run();
  db.prepare(`DELETE FROM shops WHERE location_id IN (${inLocs})`).run();
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODUCTS.join(',')})`).run();
  db.prepare(`DELETE FROM retail_stores WHERE id IN (${inLocs})`).run();
}
cleanup();

const insLoc = db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
                           VALUES (?, ?, ?, ?, 1, ?)`);
insLoc.run(SRC,      '__test_move_src',   'Move fixture source', '测试迁出门店', 90);
insLoc.run(SRC2,     '__test_move_src2',  'Move fixture source 2', '测试迁出门店二', 91);
insLoc.run(FRESH,    '__test_move_fresh', 'Move fixture fresh',  '测试全新门店', 92);
insLoc.run(OFF_DEST, '__test_move_off',   'Move fixture off',    '测试已停用门店', 93);
insLoc.run(HAS_MENU, '__test_move_full',  'Move fixture full',   '测试已有商品门店', 94);

const insProd = db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
                            VALUES (?, ?, ?, ?, ?, 1, 1)`);
insProd.run(P1, 'Move fixture latte',   '测试拿铁',   '__M-9891', 32);
insProd.run(P2, 'Move fixture granola', '测试格兰诺拉', '__M-9892', 48.5);
insProd.run(P3, 'Move fixture bun',     '测试面包',   '__M-9893', 12);
insProd.run(P4, 'Move fixture tea',     '测试茶',     '__M-9894', 25);

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

const shopAt = loc => db.prepare('SELECT * FROM shops WHERE location_id = ?').get(loc) || null;
const listingsOf = shopId => db.prepare(
  'SELECT store_product_id, price, fulfilment_mode, is_available, sort_position'
  + ' FROM shop_listings WHERE shop_id = ? ORDER BY sort_position ASC, id ASC').all(shopId);
const countAt = loc => { const s = shopAt(loc); return s ? listingsOf(s.id).length : 0; };
// resolveShop()'s OWN predicate, copied from routes/shop-menu.js rather than
// described: what the public page can serve is the question this answers.
const resolvesPublicly = code => !!db.prepare(`
  SELECT s.id FROM shops s JOIN retail_stores l ON l.id = s.location_id
   WHERE s.public_code = ? AND s.is_active = 1 AND COALESCE(l.is_active, 1) = 1`).get(code);

// The source menu, as the fixture lays it down. Positions are NON-CONTIGUOUS
// on purpose (see the header): a route that re-sequenced them on the way over
// would pass a 0,1,2,3 fixture and fail a customer reading the menu.
const MENU = [
  { product: P1, price: 32,   mode: 'stocked',   available: 1, sort: 0 },
  { product: P2, price: 48.5, mode: 'made_here', available: 0, sort: 3 },
  { product: P3, price: 12,   mode: 'made_here', available: 1, sort: 7 },
  { product: P4, price: 9.99, mode: 'stocked',   available: 1, sort: 11 },
];

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    // ── Set-up through the real API, so the fixture is a shop the admin built
    let srcShop, src2Shop, fullShop, offShop;

    await checkAsync('fixture: four shops set up through the API, one location left bare', async () => {
      for (const loc of [SRC, SRC2, OFF_DEST, HAS_MENU]) {
        const r = await call('POST', '/api/retail-admin/shops', { location_id: loc });
        assert.strictEqual(r.status, 201, `${loc}: ${JSON.stringify(r.json)}`);
      }
      srcShop = shopAt(SRC); src2Shop = shopAt(SRC2); fullShop = shopAt(HAS_MENU); offShop = shopAt(OFF_DEST);
      assert.ok(srcShop && src2Shop && fullShop && offShop);
      assert.strictEqual(shopAt(FRESH), null, 'FRESH must have no shop');

      const ins = db.prepare(`INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
                              VALUES (?, ?, ?, ?, ?, ?)`);
      for (const m of MENU) ins.run(srcShop.id, m.product, m.price, m.mode, m.available, m.sort);
      ins.run(src2Shop.id, P1, 20, 'stocked', 1, 0);
      ins.run(src2Shop.id, P2, 30, 'made_here', 0, 4);
      ins.run(fullShop.id, P3, 15, 'stocked', 1, 0);
      // The destination that is set up and switched off, holding no menu.
      db.prepare('UPDATE shops SET is_active = 0 WHERE id = ?').run(offShop.id);
      offShop = shopAt(OFF_DEST);
      assert.strictEqual(offShop.is_active, 0);
      assert.strictEqual(countAt(SRC), 4);
      assert.strictEqual(countAt(OFF_DEST), 0);
    });

    // ── Every refusal moves nothing ─────────────────────────────────────────
    console.log('\nThe refusals — and each one is asked again of the data');

    const srcUntouched = (note) => {
      assert.strictEqual(countAt(SRC), 4, `${note}: the source menu changed`);
      assert.strictEqual(shopAt(SRC).is_active, 1, `${note}: the source shop was switched off`);
      assert.strictEqual(shopAt(SRC).public_code, srcShop.public_code, `${note}: the code changed`);
    };

    await checkAsync('a destination that already has a menu is refused, with the count, and nothing moves', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: HAS_MENU });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'destination_has_menu');
      assert.strictEqual(r.json.listing_count, 1);
      assert.strictEqual(countAt(HAS_MENU), 1, 'the destination menu changed');
      srcUntouched('destination_has_menu');
    });

    await checkAsync('the location the menu is already at is refused', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: SRC });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'same_location');
      srcUntouched('same_location');
    });

    await checkAsync('a location that does not exist is 404, not a silent no-op', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: 987654 });
      assert.strictEqual(r.status, 404, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'location_not_found');
      srcUntouched('location_not_found');
    });

    await checkAsync('a shop that does not exist is 404', async () => {
      const r = await call('POST', '/api/retail-admin/shops/987654/move', { to_location_id: FRESH });
      assert.strictEqual(r.status, 404, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'not_found');
    });

    await checkAsync('no destination at all is refused, and so is a junk one', async () => {
      for (const body of [{}, { to_location_id: 0 }, { to_location_id: 'yuexiu' }, { to_location_id: -3 }]) {
        const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, body);
        assert.strictEqual(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.json)}`);
        assert.strictEqual(r.json.error, 'to_location_id_required');
      }
      srcUntouched('to_location_id_required');
    });

    await checkAsync('an operator without stores:edit cannot move a menu', async () => {
      CAPS = new Set(['orders:view']);
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: FRESH });
      assert.strictEqual(r.status, 403, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'forbidden');
      srcUntouched('forbidden');
      assert.strictEqual(shopAt(FRESH), null, 'a refused move minted a shop anyway');
      CAPS = null;
    });

    // ── The move, onto a location with no shop ──────────────────────────────
    console.log('\nThe move — the listings go, the record and the code stay (§177)');

    let toShop;
    await checkAsync('the move answers 200, reports what it moved, and says it created the shop', async () => {
      LOGGED.length = 0;
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: FRESH });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.data.moved, 4);
      assert.strictEqual(r.json.data.created, true);
      assert.strictEqual(r.json.data.from.id, srcShop.id);
      assert.strictEqual(r.json.data.from.is_active, 0);
      assert.strictEqual(r.json.data.to.location_id, FRESH);
      assert.strictEqual(r.json.data.listings.length, 4);
      toShop = shopAt(FRESH);
      assert.ok(toShop, 'no shop was created at the destination');
    });

    check('every listing arrived verbatim — price, mode, switch and position', () => {
      const got = listingsOf(toShop.id);
      assert.strictEqual(got.length, 4);
      MENU.forEach((m, i) => {
        assert.strictEqual(got[i].store_product_id, m.product, `row ${i} product`);
        assert.strictEqual(got[i].price, m.price, `row ${i} price`);
        assert.strictEqual(got[i].fulfilment_mode, m.mode, `row ${i} mode`);
        assert.strictEqual(got[i].is_available, m.available, `row ${i} availability`);
        assert.strictEqual(got[i].sort_position, m.sort, `row ${i} position`);
      });
    });

    check('the non-contiguous positions were NOT re-sequenced', () => {
      assert.deepStrictEqual(listingsOf(toShop.id).map(r => r.sort_position), [0, 3, 7, 11]);
    });

    check('the made-here mode and the off switch survived the trip', () => {
      const got = listingsOf(toShop.id);
      assert.strictEqual(got.filter(r => r.fulfilment_mode === 'made_here').length, 2);
      assert.strictEqual(got.filter(r => r.is_available === 0).length, 1);
    });

    check('the source menu is empty and its shop is switched off, not deleted', () => {
      assert.strictEqual(countAt(SRC), 0);
      const after = shopAt(SRC);
      assert.ok(after, 'the source shop row was deleted');
      assert.strictEqual(after.is_active, 0);
    });

    check('NEITHER code moved: the source keeps its own, the destination has a different one', () => {
      assert.strictEqual(shopAt(SRC).public_code, srcShop.public_code, 'the source code changed');
      assert.notStrictEqual(toShop.public_code, srcShop.public_code, 'the destination inherited the code');
      assert.ok(isShopCode(toShop.public_code), toShop.public_code);
    });

    check('neither location_id moved, and a location still has at most one shop', () => {
      assert.strictEqual(shopAt(SRC).location_id, SRC);
      assert.strictEqual(toShop.location_id, FRESH);
      for (const loc of LOCS) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM shops WHERE location_id = ?').get(loc).n;
        assert.ok(n <= 1, `location ${loc} has ${n} shops`);
      }
    });

    check('the move is logged against BOTH shops, with where it went and where it came from', () => {
      const mine = LOGGED.filter(e => e.subject === 'shop');
      const from = mine.find(e => e.subjectId === srcShop.id);
      const to = mine.find(e => e.subjectId === toShop.id);
      assert.ok(from, 'nothing logged against the source shop');
      assert.ok(to, 'nothing logged against the destination shop');
      assert.strictEqual(from.detail.moved_to_location_id, FRESH);
      assert.strictEqual(from.detail.listings, 4);
      assert.strictEqual(from.detail.switched_off, true);
      assert.strictEqual(to.detail.moved_from_shop_id, srcShop.id);
      assert.strictEqual(to.detail.shop_created, true);
    });

    await checkAsync('a menu with nothing on it has nothing to move', async () => {
      const r = await call('POST', `/api/retail-admin/shops/${srcShop.id}/move`, { to_location_id: OFF_DEST });
      assert.strictEqual(r.status, 409, JSON.stringify(r.json));
      assert.strictEqual(r.json.error, 'nothing_to_move');
      assert.strictEqual(countAt(OFF_DEST), 0, 'an empty move still wrote something');
    });

    // ── The destination that was already set up, and switched off ───────────
    console.log('\nAn empty shop at the destination is reused, and its switch is left alone');

    await checkAsync('the move reuses it rather than minting a second shop', async () => {
      const before = offShop.public_code;
      const r = await call('POST', `/api/retail-admin/shops/${src2Shop.id}/move`, { to_location_id: OFF_DEST });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.data.moved, 2);
      assert.strictEqual(r.json.data.created, false, 'it claimed to have created a shop');
      const after = shopAt(OFF_DEST);
      assert.strictEqual(after.id, offShop.id, 'a different shop row answered');
      assert.strictEqual(after.public_code, before, 'the reused shop was re-coded');
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE location_id = ?').get(OFF_DEST).n, 1);
      assert.strictEqual(countAt(OFF_DEST), 2);
    });

    check('the destination was off before the move and is off after it (§177)', () => {
      assert.strictEqual(shopAt(OFF_DEST).is_active, 0, 'the move switched the destination on');
    });

    check('and the second source is emptied and switched off the same way', () => {
      assert.strictEqual(countAt(SRC2), 0);
      assert.strictEqual(shopAt(SRC2).is_active, 0);
    });

    // ── What the public page sees ───────────────────────────────────────────
    console.log('\nThe public page needs no new behaviour — the dead code simply stops resolving');

    check('the moved-away code no longer resolves, so the printed QR serves the not-found page', () => {
      assert.strictEqual(resolvesPublicly(srcShop.public_code), false);
      assert.strictEqual(resolvesPublicly(src2Shop.public_code), false);
    });

    check('the destination that the move created resolves, and serves the moved menu', () => {
      assert.strictEqual(resolvesPublicly(toShop.public_code), true);
      assert.strictEqual(listingsOf(toShop.id).length, 4);
    });

    check('a destination left switched off does NOT resolve, menu or no menu', () => {
      assert.strictEqual(resolvesPublicly(shopAt(OFF_DEST).public_code), false);
      assert.strictEqual(countAt(OFF_DEST), 2, 'the menu is there; only the switch is off');
    });

    // ── The lock, read off the source ──────────────────────────────────────
    console.log('\nThe lock §44 rests on — asserted against the source, not only the data');

    check('nothing in the shops API ever writes location_id or public_code on an existing row', () => {
      const src = fs.readFileSync(path.join(ROOT, 'routes', 'retail-shops.js'), 'utf8');
      const updates = src.match(/UPDATE\s+shops\s+SET[^`']*/gi) || [];
      assert.ok(updates.length, 'no UPDATE shops found — has this route moved?');
      for (const u of updates) {
        assert.ok(!/location_id\s*=/.test(u), `an UPDATE writes location_id: ${u}`);
        assert.ok(!/public_code\s*=/.test(u), `an UPDATE writes public_code: ${u}`);
      }
    });

    check('the move mints its destination code through mintShop, not a second minter', () => {
      const src = fs.readFileSync(path.join(ROOT, 'routes', 'retail-shops.js'), 'utf8');
      // newShopCode() is called in exactly one place: the shared minter. A
      // second call site is a second set of properties for a code §44 says
      // has one.
      assert.strictEqual((src.match(/newShopCode\(\)/g) || []).length, 1);
      assert.match(src, /function mintShop\(/);
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
