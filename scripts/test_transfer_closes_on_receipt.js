#!/usr/bin/env node
/**
 * THE PAPERWORK FOLLOWS THE GOODS (§211).
 *
 *   node scripts/test_transfer_closes_on_receipt.js
 *
 * Ash, having counted a real transfer in on the live phone: *"once received the
 * package at the location and record everything in receiving from another shop
 * Section . where it goes after that"*.
 *
 * THE GOODS WENT WHERE THEY SHOULD — onto the shelf, into the ledger, out to
 * every channel. THE ORDER WENT NOWHERE. `goods_state` settled and `status` sat
 * at 'prepared' for ever, because Active and History are split on STATUS and
 * only 'delivered' closes a transfer. Nothing had ever written that status: it
 * is the same dead column §208 found gating the Receive screen, biting a second
 * time one screen along. So a fully counted transfer stayed in Active looking
 * like open work, never reached History, and was never swept either — the daily
 * archive deliberately skips shop-to-shop rows (§198).
 *
 * WHAT THIS PINS, and each of these is a way the fix could go wrong quietly:
 *
 *   • The receipt CLOSES the order, and the order leaves Active for History.
 *   • IT MOVES NO STOCK DOING SO. 'delivered' stopped moving stock under the
 *     two-step model (§39 ruling 5); closing the order through it must not
 *     bring that back and book the delivery in twice.
 *   • THE SENDER IS TOLD ONCE. 'received' and 'delivered' push the SAME
 *     audience — `restock:pick` at the `from` store — so a closure that
 *     announced itself would send two notifications for one event. That is the
 *     whole reason `announce:false` exists.
 *   • AND THE WORDING KEPT IS THE TRUE ONE: *counted in · 已点收*, what actually
 *     happened, not 'delivered''s *已送达*, which is about a driver's leg.
 *   • The ordinary PUT /status path STILL announces. `announce` defaults on, so
 *     no existing caller changed.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
const notes = F.captureNotifications(h);
const ACTOR = { id: 7, username: 'wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };
F.stubAuth(h, ACTOR, PERMS);
const restock = require(path.join(h.REPO, 'routes/restock.js'));

const WH = 1, SHOP = 2;
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'wh','Yuexiu',1)").run();
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'shop','Tianhe',1)").run();
h.db.prepare("INSERT OR IGNORE INTO users (id,username,password,role,is_active) VALUES (7,'wh','x','warehouse',1)").run();
F.seedProduct(h.db, { id: 900, name: 'Banana', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key,value_json) VALUES ('stock.warehouseStoreId',?)")
  .run(String(WH));

const call = (m, p, params, body) =>
  F.callRoute(restock, m, p, { params, body, user: ACTOR, permissions: PERMS });
const row = id => h.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(id);

// callRoute hardcodes an empty query, so the tab filter is driven directly.
const inTab = (id, tab) => {
  const layer = restock.stack.find(l => l.route && l.route.path === '/api/restock' && l.route.methods.get);
  let out = null;
  const req = { params: {}, body: {}, query: { tab }, user: ACTOR, permissions: PERMS, ip: '::1' };
  const res = { json: b => { out = b; return res; }, status: () => res, set: () => res,
                setHeader: () => res, type: () => res, send: b => { out = b; return res; } };
  const hs = layer.route.stack.map(x => x.handle);
  hs[hs.length - 1](req, res, () => {});
  return ((out || {}).data || []).some(o => o.id === id);
};

// One shop-to-shop transfer, the shape of the one Ash counted in.
function mkTransfer(id, rs, toRole) {
  h.db.prepare(`INSERT INTO restock_orders (id,rs_number,date,status,store_name,created_by,from_role,to_role,from_store_id,to_store_id)
                VALUES (?,?,?,'received','Tianhe',7,'store',?,${WH},${SHOP})`).run(id, rs, '2026-09-20', toRole || 'warehouse');
  h.db.prepare("INSERT INTO restock_items (restock_id,product_id,product_name,qty_requested,qty_sent) VALUES (?,900,'Banana',1,1)").run(id);
  return h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ? ORDER BY id').all(id);
}
const setShelf = (s, p, q) => h.db.prepare(
  "INSERT OR REPLACE INTO retail_store_stock (store_id,product_id,physical_qty) VALUES (?,?,?)").run(s, p, q);
const shelf = (s, p) => F.shelf(h.db, s, p);

// ══ 1 ═══════════════════════════════════════════════════════════════════════
section('1. counting it in closes the order');
setShelf(WH, 900, 10); setShelf(SHOP, 900, 0);
const items = mkTransfer(5001, 'RS-A');
call('put', '/api/restock/:id/status', { id: '5001' }, { status: 'prepared' });
notes.operator.length = 0; notes.push.length = 0;      // only the receipt from here
const res = call('put', '/api/restock/:id/receive', { id: '5001' }, { counts: [{ item_id: items[0].id, qty_received: 1 }] });

eq(res.body.settled, true,              'the receipt settles');
eq(row(5001).goods_state, 'settled',    'goods_state is settled');
eq(row(5001).status, 'delivered',       'and the ORDER is closed — status delivered');
ok(!!row(5001).delivered_at,            'delivered_at is stamped');
ok(!!row(5001).received_confirmed_at,   'the receipt stamp stands alongside it, not instead of it');

section('2. it leaves Active for History');
ok(!inTab(5001, 'active'),  'gone from Active — it is not open work any more');
ok(inTab(5001, 'history'),  'and findable in History, where a finished job belongs');
ok(!inTab(5001, 'archived'), 'not archived — closed is not deleted');

section('3. closing the order moves no stock');
eq(shelf(SHOP, 900), 1, 'the destination shelf holds what was counted, once');
eq(shelf(WH, 900),   9, 'and the source shelf is untouched by the closure');
const inRows = h.db.prepare(
  `SELECT COUNT(*) c FROM retail_stock_ledger WHERE reason='restock_transfer_in' AND ref_table='restock_orders' AND ref_id=?`
).get(5001).c;
eq(inRows, 1, 'exactly ONE inbound ledger row — delivered did not re-run the transfer');

// ══ 4 ═══════════════════════════════════════════════════════════════════════
section('4. the sender is told once, in the true words');
const forSender = notes.operator.filter(o => (o.caps || '') === 'restock:pick');
eq(forSender.length, 1, 'one push to the sending shop, not two');
ok(/counted in|已点收/.test(JSON.stringify(forSender[0] && forSender[0].msg || {})),
   'and it says counted in · 已点收 — what happened, not a driver\'s leg');
ok(!/已送达/.test(JSON.stringify(forSender.map(o => o.msg))),
   'nothing tells the sender it was "delivered" as well');

// ══ 5 ═══════════════════════════════════════════════════════════════════════
section('5. the ordinary status door still announces');
setShelf(WH, 900, 10); setShelf(SHOP, 900, 0);
const it2 = mkTransfer(5002, 'RS-B');
call('put', '/api/restock/:id/status', { id: '5002' }, { status: 'prepared' });
notes.operator.length = 0;
call('put', '/api/restock/:id/status', { id: '5002' }, { status: 'delivered' });
ok(notes.operator.length > 0, 'PUT /status delivered still fans out — announce defaults on');
eq(row(5002).status, 'delivered', 'and still sets the status');

// ══ 6 ═══════════════════════════════════════════════════════════════════════
/* THE DRIVER AND THE COUNTER ARE CONCURRENT, and this is that case rather than
   a duplicate. Order 5002 was marked delivered through the status door and never
   counted, so its goods are still in transit: the receipt SHOULD settle it. What
   must not happen is the closure re-stamping a delivered_at that is already
   there — the forward-only guard (`fromIdx < indexOf('delivered')`) is what
   stops it, and an off-by-one there would silently move the closing time of
   every transfer somebody had marked delivered first. */
section('6. a receipt on an order already delivered settles it without re-closing it');
const before = row(5002).delivered_at;
const again = call('put', '/api/restock/:id/receive', { id: '5002' }, { counts: [{ item_id: it2[0].id, qty_received: 1 }] });
eq(again.body.settled, true,        'the count still lands — delivered is not a closed door to the counter');
eq(row(5002).goods_state, 'settled', 'and the goods settle');
eq(row(5002).delivered_at, before,  'but the delivered stamp is NOT rewritten — the forward-only guard holds');
eq(row(5002).status, 'delivered',   'and the status is where it was');

done();
