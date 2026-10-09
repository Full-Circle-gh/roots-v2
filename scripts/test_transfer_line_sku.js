#!/usr/bin/env node
/**
 * THE LINE'S OWN SKU DECIDES WHICH BOTTLE MOVES (§445).
 *
 *   node scripts/test_transfer_line_sku.js
 *
 * RS-261008-002 and -003, Yuexiu asking for kombucha, were refused at Send
 * again: "the kitchen has 2-90 and the store has 2-80 under the same
 * reference". One product number was Passion Fruit Kombucha 300ml (2-80) in
 * the store list and the 1L (2-90) in the old list. The line itself said 2-80,
 * the bottle the shop tapped, so the store row was the right one.
 *
 *   PART A  line SKU = store SKU, old list disagrees  → moves, the right bottle
 *   PART B  line SKU ≠ store SKU                      → refused, nothing moves
 *   PART C  line with no SKU of its own               → the old check still holds
 *   PART D  the same rule at the receiving end
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
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
   VALUES (?,?,?,?,1,?)`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'jing','x','warehouse',?,1)`).run(YUEXIU);

// The shape on the live box: one number, two different bottles.
const PF = 283;
F.seedProduct(h.db, { id: PF, name: 'Passion Fruit Kombucha', sku: '2-90', storeSku: '2-80' });
F.setShelf(h.db, TIANHE, PF, 10);
F.setShelf(h.db, YUEXIU, PF, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const ask = (sku, qty) => call('POST', '/api/restock', {
  status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU,
  items: [{ product_id: PF, product_name: 'Passion Fruit Kombucha', sku, qty_requested: qty, unit: 'pcs' }],
});
const send = (id) => call('PUT', `/api/restock/${id}/status`, { status: 'prepared' });
const row = (id) => h.db.prepare(
  "SELECT COALESCE(goods_state,'none') AS goods_state FROM restock_orders WHERE id = ?").get(id);

(async () => {
  section('Part A · the line says 2-80 and the store row is 2-80');

  let r = await ask('2-80', 3);
  const good = r.body.id;
  r = await send(good);
  await settle();
  ok(!r.body.stock_transfer || r.body.stock_transfer.ok !== false,
     'Send goes through — the old list’s 2-90 under the same number no longer blocks it');
  eq(row(good).goods_state, 'in_transit', 'the order is on its way');
  eq(F.shelf(h.db, TIANHE, PF), 7, 'and three 300ml bottles left Tianhe');

  section('Part B · the line says 2-90 but the store row is 2-80');

  r = await ask('2-90', 2);
  const wrong = r.body.id;
  r = await send(wrong);
  await settle();
  ok(r.body.stock_transfer && r.body.stock_transfer.ok === false, 'Send is refused');
  ok(/request was for 2-90 but that reference is 2-80/.test((r.body.stock_transfer || {}).error || ''),
     'and says which bottle was asked for and which one the number points at');
  eq(row(wrong).goods_state, 'none', 'nothing moved');
  eq(F.shelf(h.db, TIANHE, PF), 7, 'Tianhe’s shelf is untouched');

  section('Part C · a line with no SKU of its own');

  r = await ask(null, 1);
  const blind = r.body.id;
  r = await send(blind);
  await settle();
  ok(r.body.stock_transfer && r.body.stock_transfer.ok === false,
     'still refused — with nothing to say which bottle, the two lists disagreeing is enough to stop');
  ok(/old product list has 2-90 and the store has 2-80/.test((r.body.stock_transfer || {}).error || ''),
     'in plain words, with no "kitchen" in it');
  ok(!/kitchen/i.test((r.body.stock_transfer || {}).error || ''), 'the word kitchen is gone from the message');

  section('Part D · the receiving end applies the same rule');

  const items = h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ?').all(good);
  r = await call('PUT', `/api/restock/${good}/receive`,
    { counts: items.map(it => ({ item_id: it.id, qty_received: 3 })) });
  ok(r.status === 200 && !(r.body && r.body.stock_transfer && r.body.stock_transfer.ok === false),
     'Yuexiu counts it in');
  eq(F.shelf(h.db, YUEXIU, PF), 3, 'and three 300ml bottles are on Yuexiu’s shelf');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
