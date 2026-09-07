#!/usr/bin/env node
// The kitchen queue split — decisions §61.
//
//   node scripts/test_kitchen_queue_item_split.js
//
// Ash's report, against a screenshot of the Kitchen queue detail screen (four
// items, one "Start making" button): "they can split what they start making,
// what was made. its all one batch. need to fix that." Each restock_items row
// now carries its own status; restock_orders.status stays a ROLLUP that only
// catches up once every line has reached the same point — which is what keeps
// dispatch/push/print, all keyed on the order's own status, firing exactly
// once, exactly as they did before a single line could move on its own.
//
// Cases:
//   1. one line moving does not move the order
//   2. the order rolls to 'received' the moment the LAST line catches up —
//      and 'received' fires no push, same as the whole-order door
//   3. and again to 'prepared', where the push fan-out DOES fire
//   4. a line cannot move backward, or to a status the kitchen queue never
//      asks an item for
//   5. a transfer (non-kitchen) order refuses the per-item door — splitting
//      is a kitchen-queue idea, not a transfer one
//   6. the whole-order endpoint (transfers; the legacy kitchen app) still
//      carries every line forward with it, so the two doors can never fall
//      out of step
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();                 // must come before any route require
const notes = F.captureNotifications(h);
F.stubAuth(h, { id: 9, username: 'kop', role: 'kitchen' },
  { restock: 1, kitchen_inbox: 1 });

const restock = require(path.join(h.REPO, 'routes/restock.js'));

const ACTOR = { id: 9, username: 'kop', role: 'kitchen' };
const PERMS = { restock: 1, kitchen_inbox: 1 };

const putItem = (orderId, itemId, status) => F.callRoute(restock, 'put', '/api/restock/:id/item/:item_id/status', {
  params: { id: String(orderId), item_id: String(itemId) }, body: { status }, user: ACTOR, permissions: PERMS,
});
const putOrder = (orderId, status) => F.callRoute(restock, 'put', '/api/restock/:id/status', {
  params: { id: String(orderId) }, body: { status }, user: ACTOR, permissions: PERMS,
});

const orderRow = (id) => h.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(id);
const itemRow  = (id) => h.db.prepare('SELECT * FROM restock_items WHERE id = ?').get(id);

let nextOrderId = 1000;
// A kitchen request, already 'sent' (the state it is in by the time it
// reaches the queue), with N items of qty 4. No store ids: _transferContext
// skips a kitchen order before it ever asks for a from/to store.
function seedKitchenOrder(names, { toRole = 'kitchen' } = {}) {
  const id = nextOrderId++;
  h.db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, from_role, to_role)
                VALUES (?, ?, '2026-09-07', 'sent', 'warehouse', ?)`).run(id, 'PR-TEST-' + id, toRole);
  const itemIds = names.map((name, i) => {
    const r = h.db.prepare(`INSERT INTO restock_items (restock_id, product_name, sku, qty_requested)
                             VALUES (?, ?, ?, 4)`).run(id, name, 'SKU-' + id + '-' + i);
    return r.lastInsertRowid;
  });
  return { id, itemIds };
}

// ── 1 & 2. The order is a rollup, and 'received' pushes nobody ─────────────
section('Cases 1-2 — the order only moves once every line has caught up');

const o1 = seedKitchenOrder(['Almond butter', 'Wraps']);

let r = putItem(o1.id, o1.itemIds[0], 'received');
ok(r.body && r.body.success, 'line 1 moves to received');
eq(itemRow(o1.itemIds[0]).status, 'received', 'line 1 is received');
eq(itemRow(o1.itemIds[1]).status, 'sent', 'line 2 is untouched');
eq(orderRow(o1.id).status, 'sent', 'the order has not moved — one line is still behind');
eq(r.body.order_status, 'sent', "the response reports the order's own (unmoved) status");

r = putItem(o1.id, o1.itemIds[1], 'received');
ok(r.body && r.body.success, 'line 2 moves to received');
eq(orderRow(o1.id).status, 'received', 'the order rolls forward the moment the LAST line catches up');
ok(!!orderRow(o1.id).received_at, "the order's own received_at is stamped by the rollup");
eq(r.body.order_status, 'received', "the response reports the order's new status");
eq(notes.operator.length, 0, "'received' is internal warehouse state — nothing pushed (matches the whole-order door)");
eq(notes.sse.length, 0, "'received' broadcasts nothing either");

// ── 3. 'prepared' rolls the same way, and this time the push fires ─────────
section("Case 3 — 'prepared' rolls the order and fires the push/print the single button used to");

r = putItem(o1.id, o1.itemIds[0], 'prepared');
ok(r.body && r.body.success, 'line 1 moves to prepared');
eq(orderRow(o1.id).status, 'received', 'the order stays received — line 2 has not reached prepared yet');
eq(notes.operator.length, 0, 'still nothing pushed — the order has not rolled');

r = putItem(o1.id, o1.itemIds[1], 'prepared');
ok(r.body && r.body.success, 'line 2 — the LAST one — moves to prepared');
eq(orderRow(o1.id).status, 'prepared', 'the order rolls to prepared with the last line');
ok(!!orderRow(o1.id).prepared_at, "the order's own prepared_at is stamped");
eq(itemRow(o1.itemIds[0]).status, 'prepared', 'line 1 reads prepared');
eq(itemRow(o1.itemIds[1]).status, 'prepared', 'line 2 reads prepared');
eq(r.body.order_status, 'prepared', "the response reports the order's rolled status");
ok(!r.body.stock_transfer, 'no stock_transfer error — a kitchen order is excluded from dispatch (_transferContext)');
eq(notes.operator.length, 1, 'the push fan-out fires exactly once, the moment the order actually rolls to prepared');
eq(notes.sse.length, 1, 'and the broadcast fires exactly once alongside it');

// ── 4. Forward-only, and only the two statuses the queue asks for ──────────
section('Case 4 — a line cannot move backward, or sideways to a status the queue never asks it for');

const o2 = seedKitchenOrder(['Zhoug dip']);
r = putItem(o2.id, o2.itemIds[0], 'prepared');
ok(r.body && r.body.success, 'line reaches prepared directly (sent → prepared is a valid forward jump)');
r = putItem(o2.id, o2.itemIds[0], 'received');
eq(r.status, 400, 'moving a prepared line back to received is refused');
eq(itemRow(o2.itemIds[0]).status, 'prepared', 'the line is unchanged by the refused call');

const o3 = seedKitchenOrder(['Peanut butter']);
r = putItem(o3.id, o3.itemIds[0], 'sent');
eq(r.status, 400, "'sent' is not a status this door advances an item TO — every item starts there");
r = putItem(o3.id, o3.itemIds[0], 'delivered');
eq(r.status, 400, "'delivered' is a warehouse/store idea and never applies to a kitchen line");
r = putItem(o3.id, o3.itemIds[0], 'nonsense');
eq(r.status, 400, 'an unrecognised status is refused outright');

// ── 5. A transfer order has no per-item door ────────────────────────────────
section('Case 5 — splitting is a kitchen-queue idea; a transfer between locations refuses it');

const o4 = seedKitchenOrder(['Boxes'], { toRole: 'store' });
r = putItem(o4.id, o4.itemIds[0], 'received');
eq(r.status, 403, 'a store-bound transfer 403s on the per-item door');
eq(itemRow(o4.itemIds[0]).status, 'sent', 'the line is untouched');

// ── 6. The whole-order door still carries every line forward with it ───────
section('Case 6 — the whole-order door (transfers; the legacy kitchen app) keeps items in step');

const o5 = seedKitchenOrder(['Hummus', 'Tortillas', 'Falafel']);
// One line worked through the split door first, exactly as a kitchen
// operator using the new screen would leave it mid-request...
putItem(o5.id, o5.itemIds[0], 'received');
// ...and then the OLD, whole-order door is called directly — the shape the
// legacy kitchen app and every transfer still use, which knows nothing about
// per-item state.
r = putOrder(o5.id, 'received');
ok(r.body && r.body.success, 'whole-order advance to received succeeds');
eq(orderRow(o5.id).status, 'received', 'the order is received');
eq(itemRow(o5.itemIds[0]).status, 'received', 'the line already ahead is left at received (no downgrade)');
eq(itemRow(o5.itemIds[1]).status, 'received', 'a line that was still behind is carried forward to received');
eq(itemRow(o5.itemIds[2]).status, 'received', 'so is the third');

r = putOrder(o5.id, 'prepared');
ok(r.body && r.body.success, 'whole-order advance to prepared succeeds');
eq(itemRow(o5.itemIds[0]).status, 'prepared', 'every line is carried to prepared with the order');
eq(itemRow(o5.itemIds[1]).status, 'prepared', 'every line is carried to prepared with the order');
eq(itemRow(o5.itemIds[2]).status, 'prepared', 'every line is carried to prepared with the order');
// The per-item door, called after the whole order has already closed, must
// not re-fire the side effects a second time.
const pushedBefore = notes.operator.length;
r = putItem(o5.id, o5.itemIds[0], 'prepared');
eq(r.status, 400, 'and the split door now refuses that same line — it has nothing left to move to');
eq(notes.operator.length, pushedBefore, 'no second push fired');

done();
