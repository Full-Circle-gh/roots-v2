#!/usr/bin/env node
/**
 * A SHOP CAN TRANSFER SOMETHING THE KITCHEN DOES NOT MAKE (§201).
 *
 *   node scripts/test_transfer_store_only_product.js
 *
 * THE FAULT THIS PINS, and it is the one three earlier suites walked past.
 * `restock_items.product_id` holds a `store_products` id — that is what the
 * shelf is keyed on and what `_applyDispatch` moves stock through — and its
 * foreign key pointed at `products`, the KITCHEN catalogue, from the day the
 * two split. `store_products_seed_fk_v1` repointed every other store-owned
 * table and missed this one.
 *
 * IT HID BECAUSE NOBODY WROTE THE COLUMN. The phone sent `product_id: null` on
 * every line (§200), and the ids older clients wrote happened to exist in both
 * tables. §200 made the phone send the real id and turned a latent fault into
 * a live one: on Roots, 72 of 370 active store products have no `products` row,
 * so every request naming one threw a foreign-key error and did not save.
 *
 * AND THE TEST FIXTURE IS PART OF THE STORY. `seedProduct` put every product
 * into BOTH tables under one id, so no suite in this repo could express a
 * store-only product — the ordinary shape for anything a shop sells and a
 * kitchen does not make. It takes `storeOnly` now, and this suite is the first
 * caller.
 *
 *   PART A  a request naming a store-only product SAVES.
 *   PART B  it dispatches, and the units leave the shelf.
 *   PART C  the repair links such a line rather than throwing on it — which is
 *           what §200's backfill did, silently, while recording success.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'jing', role: 'staff', display_name: 'Jing' },
  { restock: 1, warehouse_inbox: 1 }, 'tacet');

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const TIANHE = 1, YUEXIU = 2;
// Guangzhou shops, zoned as Roots' are (§82).
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone)
   VALUES (?,?,?,?,1,?,'Asia/Shanghai')`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'jing','x','warehouse',?,1)`).run(YUEXIU);

// Ash's banana: on the shop's catalogue, absent from the kitchen's — and with
// an id above everything in `products`, exactly as store_products 393 is.
const BANANA = 393;
F.seedProduct(h.db, { id: BANANA, name: 'Banana', sku: 'A-3', storeOnly: true });
F.setShelf(h.db, TIANHE, BANANA, 10);
F.setShelf(h.db, YUEXIU, BANANA, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const shelf = (s) => F.shelf(h.db, s, BANANA);
const row = (id) => h.db.prepare(
  "SELECT COALESCE(goods_state,'none') AS goods_state FROM restock_orders WHERE id = ?").get(id);

(async () => {
  section('Part A · a request naming a store-only product saves');

  // The table must name the catalogue it actually holds ids from.
  const sql = h.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='restock_items'").get().sql;
  ok(/REFERENCES\s+store_products\s*\(/i.test(sql),
     'restock_items.product_id references store_products — the table the shelf is keyed on');
  ok(!/REFERENCES\s+products\s*\(/i.test(sql),
     'and NOT products, the kitchen catalogue it pointed at since the split');
  eq(h.db.pragma('foreign_keys', { simple: true }), 1,
     'with foreign keys ON, so the wrong key really did refuse the write');

  ok(!h.db.prepare('SELECT 1 FROM products WHERE id = ?').get(BANANA),
     'the banana is in NO products row — the shape the fixture could not express before');

  const r1 = await call('POST', '/api/restock', {
    status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU,
    items: [{ product_id: BANANA, product_name: 'Banana', sku: 'A-3', qty_requested: 1, unit: 'pcs' }],
  });
  await settle();
  eq(r1.status, 200, 'the request is created rather than failing on a foreign key');
  const id = r1.body.id;
  eq(h.db.prepare('SELECT product_id FROM restock_items WHERE restock_id = ?').get(id).product_id, BANANA,
     'and the line keeps the id it was sent — not nulled, not dropped');

  section('Part B · it dispatches, and the units leave the shelf');

  const r2 = await call('PUT', `/api/restock/${id}/status`, { status: 'prepared' });
  await settle();
  ok(!r2.body.stock_transfer || r2.body.stock_transfer.ok !== false,
     'Send goes through for a product the kitchen has never heard of');
  eq(row(id).goods_state, 'in_transit', 'the goods are on their way');
  eq(shelf(TIANHE), 9, 'and one has actually left the supplier');

  section('Part C · the repair links such a line rather than throwing on it');

  /* §200's backfill did exactly this UPDATE and it violated the old key, so the
     transaction rolled back and the migration recorded itself as done. The
     write is the part to pin — if the key is wrong again, this throws. */
  const orphan = h.db.prepare(`INSERT INTO restock_orders
      (rs_number, date, status, created_by, from_role, to_role, from_store_id, to_store_id, sent_at)
    VALUES ('RS-ORPHAN-1', date('now'), 'sent', 7, 'store', 'warehouse', ?, ?, datetime('now'))`)
    .run(TIANHE, YUEXIU).lastInsertRowid;
  h.db.prepare(`INSERT INTO restock_items (restock_id, product_name, sku, qty_requested, unit)
                VALUES (?, 'Banana', 'A-3', 1, 'pcs')`).run(orphan);
  const lineId = h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ?').get(orphan).id;

  let threw = null;
  try {
    h.db.prepare('UPDATE restock_items SET product_id = ? WHERE id = ?').run(BANANA, lineId);
  } catch (e) { threw = e.message; }
  ok(!threw, `linking a store-only product must not throw${threw ? ' — it threw: ' + threw : ''}`);
  eq(h.db.prepare('SELECT product_id FROM restock_items WHERE id = ?').get(lineId).product_id, BANANA,
     'and the link sticks, which is what makes an already-written request recoverable');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
