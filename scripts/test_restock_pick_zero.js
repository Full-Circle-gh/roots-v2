#!/usr/bin/env node
/**
 * OUT OF STOCK IS PICKED AS 0 (§444).
 *
 *   node scripts/test_restock_pick_zero.js
 *
 * Ash: "补货清单，如果缺货，无法选择0". The phone refused a 0 on the Short
 * field, so a product the shelf did not have could never be ticked. The phone
 * now sends it; this pins what the server does with it.
 *
 *   PART A  some lines 0, some not: the 0 lines move nothing, the rest move,
 *           and the order is in transit as usual.
 *   PART B  every line 0: nothing moves, and the order CLOSES ('settled')
 *           instead of sitting under "Did not leave the shelf" for ever.
 *   PART C  the retry door on such an order says nothing was sent, and does
 *           not claim stock moved.
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

const BANANA = 900, MANGO = 901;
F.seedProduct(h.db, { id: BANANA, name: 'Banana', sku: 'P-900' });
F.seedProduct(h.db, { id: MANGO, name: 'Mango', sku: 'P-901' });
F.setShelf(h.db, TIANHE, BANANA, 10);
F.setShelf(h.db, TIANHE, MANGO, 0);
F.setShelf(h.db, YUEXIU, BANANA, 0);
F.setShelf(h.db, YUEXIU, MANGO, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const line = (id, name, sku, qty) => ({ product_id: id, product_name: name, sku, qty_requested: qty, unit: 'pcs' });
const ask = (items) => call('POST', '/api/restock', {
  status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU, items,
});
const itemsOf = (id) => h.db.prepare('SELECT id, product_id FROM restock_items WHERE restock_id = ?').all(id);
const pick = (orderId, itemId, qty) =>
  call('PUT', `/api/restock/${orderId}/item/${itemId}`, { qty_sent: qty, is_checked: 1 });
const row = (id) => h.db.prepare(
  `SELECT status, COALESCE(goods_state,'none') AS goods_state, dispatched_at, received_confirmed_at
     FROM restock_orders WHERE id = ?`).get(id);

(async () => {
  section('Part A · a 0 line beside a real one');

  let r = await ask([line(BANANA, 'Banana', 'P-900', 2), line(MANGO, 'Mango', 'P-901', 3)]);
  const mixed = r.body.id;
  for (const it of itemsOf(mixed)) {
    r = await pick(mixed, it.id, it.product_id === MANGO ? 0 : 2);
    ok(r.status === 200, `the line for ${it.product_id === MANGO ? 'Mango' : 'Banana'} saves${it.product_id === MANGO ? ' as 0' : ''}`);
  }
  r = await call('PUT', `/api/restock/${mixed}/status`, { status: 'prepared' });
  await settle();
  ok(!r.body.stock_transfer || r.body.stock_transfer.ok !== false, 'Send goes through');
  eq(row(mixed).goods_state, 'in_transit', 'the order is on its way');
  eq(F.shelf(h.db, TIANHE, BANANA), 8, 'the banana left the shelf');
  eq(F.shelf(h.db, TIANHE, MANGO), 0, 'the mango, picked as 0, did not — and did not go negative');

  section('Part B · every line 0 closes the order');

  r = await ask([line(MANGO, 'Mango', 'P-901', 4)]);
  const none = r.body.id;
  for (const it of itemsOf(none)) await pick(none, it.id, 0);
  r = await call('PUT', `/api/restock/${none}/status`, { status: 'prepared' });
  await settle();
  ok(!r.body.stock_transfer || r.body.stock_transfer.ok !== false,
     'Send is not refused — out of stock is an answer, not a fault');
  eq(row(none).goods_state, 'settled', 'the order closes, so it is not left under "Did not leave the shelf"');
  ok(!!row(none).dispatched_at, 'stamped with when it was sent');
  ok(!row(none).received_confirmed_at, 'and NOT marked counted — nobody counted anything');
  eq(F.shelf(h.db, TIANHE, MANGO), 0, 'nothing moved');

  const active = (await call('GET', '/api/restock?tab=active')).body.data || [];
  ok(!active.some(o => o.id === none && o.goods_state === 'in_transit'),
     'and the asking shop has nothing to count in');

  section('Part C · the retry door on a closed all-0 order');

  // An order already closed this way reports itself as gone, never as moved.
  r = await call('POST', `/api/restock/${none}/retry-dispatch`);
  ok(r.status === 200 && r.body.stock_moved === false, 'a retry moves nothing and says so');
  eq(F.shelf(h.db, TIANHE, MANGO), 0, 'still nothing moved');

  // A row left at prepared/none (the shape before this change) is closed by the retry.
  r = await ask([line(MANGO, 'Mango', 'P-901', 1)]);
  const stuck = r.body.id;
  for (const it of itemsOf(stuck)) h.db.prepare('UPDATE restock_items SET qty_sent = 0, is_checked = 1 WHERE id = ?').run(it.id);
  h.db.prepare("UPDATE restock_orders SET status = 'prepared' WHERE id = ?").run(stuck);
  r = await call('POST', `/api/restock/${stuck}/retry-dispatch`);
  ok(r.status === 200 && r.body.stock_moved === false && /nothing was sent/i.test(r.body.message || ''),
     'a retry on an all-0 order closes it and says nothing was sent');
  eq(row(stuck).goods_state, 'settled', 'and it leaves the stuck band');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
