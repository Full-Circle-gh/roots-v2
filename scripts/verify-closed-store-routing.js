'use strict';

// A closed shop must not be handed orders — not by routeOrder, not by
// analyzeShortage (the checkout out-of-stock modal), not by the pickup list.
// This walks all three with Yuexiu closed and asserts every one of them lands
// on Tianhe instead, and that reopening puts Yuexiu straight back.
//
//   node scripts/verify-closed-store-routing.js
//
// Runs against a THROWAWAY database it creates and deletes itself, seeded with
// the real schema copied out of the main DB's sqlite_master. It requires
// ../database (lib/inventory does), which opens the real roots.db and runs its
// migrations — but every read and write below goes to the throwaway connection
// through tenantAls, so the real database is never touched by the test.
//
// The functions under test are the REAL ones (lib/inventory), not mirrors, so
// this cannot pass against drifted routing logic. Addresses are deliberately
// left un-geocoded: routing then ranks by district match instead of calling the
// road-distance API, which keeps the run offline and deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const mainDb = require('../database');
const { tenantAls } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');

const dbPath = path.join(os.tmpdir(), `closed-store-routing-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Real schema, structure only — same trick lib/tenant-db uses to stand a fresh
// tenant up, so the queries under test run against the columns they ship with.
for (const o of mainDb.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') " +
  "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
).all()) {
  if (!o.name || o.name.startsWith('sqlite_')) continue;
  try { db.exec(o.sql); } catch (e) { /* incompatible/dependent object — not one we exercise */ }
}

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}

// ── Fixture: two shops, one product, both shelves stocked ────────────────────
const PRODUCT_ID = 1;
db.prepare(
  `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active)
   VALUES (?, 'Mango Kombucha', '芒果康普茶', 'KMB-MNG', 29, 1, 1)`
).run(PRODUCT_ID);

const addStore = db.prepare(
  `INSERT INTO retail_stores (code, name_en, name_cn, city, district, is_active, pickup_enabled, sort_order)
   VALUES (?, ?, ?, '广州市', ?, 1, 1, ?)`
);
const TIANHE_ID = addStore.run('tianhe', 'Roots Tianhe', '天河区', '天河区', 1).lastInsertRowid;
const YUEXIU_ID = addStore.run('yuexiu', 'Roots Yuexiu', '越秀区', '越秀区', 2).lastInsertRowid;

const setStock = (storeId, qty) => db.prepare(
  `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
   VALUES (?, ?, ?, 0)
   ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
).run(storeId, PRODUCT_ID, qty);
setStock(TIANHE_ID, 50);
setStock(YUEXIU_ID, 50);

// Closure switches, each written the way its own admin endpoint writes it.
const setShopOpen = (code, open) => db.prepare(
  `INSERT INTO store_business_status (store_code, fulfillment_open, updated_at)
   VALUES (?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(store_code) DO UPDATE SET fulfillment_open = excluded.fulfillment_open`
).run(code, open ? 1 : 0);
const setChannelOpen = (code, open) => {
  for (const ch of ['mini_app', 'web']) {
    db.prepare(
      `INSERT INTO channel_status (channel, store_code, is_open, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(channel, store_code) DO UPDATE SET is_open = excluded.is_open`
    ).run(ch, code, open ? 1 : 0);
  }
};
const openEverything = () => {
  for (const code of ['tianhe', 'yuexiu']) { setShopOpen(code, true); setChannelOpen(code, true); }
};

// A Yuexiu customer ordering for today: in Guangzhou + same-day, so the stock
// gate is live and the out-of-stock modal is reachable.
const ADDRESS = { city: '广州市', district: '越秀区', address: '广州市越秀区' };
const ITEMS = [{ product_id: PRODUCT_ID, qty: 2 }];
const SLOT = 'right_away';

const route = () => inventory.routeOrder({ address: ADDRESS, items: ITEMS, channel: 'wechat' });
const analyze = () => inventory.analyzeShortage({ address: ADDRESS, items: ITEMS, deliverySlotId: SLOT, channel: 'wechat' });

(async () => {
  await tenantAls.run(db, async () => {
    // 1. Baseline — nothing closed, the Yuexiu customer is served by Yuexiu.
    openEverything();
    check('open: routes to the district shop', (await route()).store?.code, 'yuexiu');
    check('open: modal would name the district shop', (await analyze()).nearest?.store?.code, 'yuexiu');

    // 2. Yuexiu closed shop-wide (POST /store-status/store/:code, and the Sales
    //    page's location master). This is the switch that used to be written and
    //    never read: the whole point of the fix.
    setShopOpen('yuexiu', false);
    check('shop closed: reroutes to tianhe',          (await route()).store?.code, 'tianhe');
    check('shop closed: nothing to confirm',          (await route()).error ?? null, null);
    const closedAnalysis = await analyze();
    check('shop closed: no out-of-stock gate',        closedAnalysis.gate, 'none');
    check('shop closed: modal names tianhe',          closedAnalysis.nearest?.store?.code, 'tianhe');
    check('shop closed: nothing reported missing',    closedAnalysis.missing_items.length, 0);
    check('shop closed: dropped from every channel',  inventory.channelClosedStores('mini_app').has('yuexiu'), true);
    check('shop closed: dropped from pickup',         inventory.onlineFullyClosedStores().has('yuexiu'), true);
    check('shop closed: tianhe still takes pickups',  inventory.onlineFullyClosedStores().has('tianhe'), false);

    // 3. Reopening restores it — the closure is a live read, nothing is stamped
    //    on the customer or the address that would outlive it.
    openEverything();
    check('reopened: routes to the district shop again', (await route()).store?.code, 'yuexiu');

    // 4. Closed the other way (per-channel cells) behaves identically.
    setChannelOpen('yuexiu', false);
    check('channels closed: reroutes to tianhe',      (await route()).store?.code, 'tianhe');
    check('channels closed: modal names tianhe',      (await analyze()).nearest?.store?.code, 'tianhe');

    // 5. Regression guard: an OPEN shop that is merely out of stock still raises
    //    the 5-option modal against itself. Closing must be the only thing that
    //    removes a shop from the pool — an empty shelf is a different question.
    openEverything();
    setStock(YUEXIU_ID, 0);
    const shortAnalysis = await analyze();
    check('open but empty: out-of-stock gate stands', shortAnalysis.gate, 'options_5');
    check('open but empty: modal names yuexiu',       shortAnalysis.nearest?.store?.code, 'yuexiu');
    check('open but empty: offers tianhe',            shortAnalysis.fallback?.store?.code, 'tianhe');
    setStock(YUEXIU_ID, 50);

    // 6. Both shops closed — there is nowhere to send the order, and checkout
    //    must hear that rather than silently pick a closed shop.
    setShopOpen('tianhe', false); setShopOpen('yuexiu', false);
    check('all closed: routing refuses',  (await route()).error, 'no_active_store');
    check('all closed: analysis refuses', (await analyze()).error, 'no_active_store');
    check('all closed: channel is down',  inventory.channelFullyClosed('mini_app'), true);
  });

  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}` + (r.ok ? '' : `\n        expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`));
  }
  console.log(`\n${results.length - failures}/${results.length} passed`);

  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch (_) {} }
  process.exit(failures ? 1 : 0);
})();
