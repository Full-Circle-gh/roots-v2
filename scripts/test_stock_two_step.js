#!/usr/bin/env node
// Two-step warehouse → store movement — tenant 1.
//
// Assertions 1-14 of docs/tacet-stock-movement-schema.md B9. The tenant-2 half
// (15-20) lives in scripts/test_stock_two_step_tenant2.js and is the one that
// catches a handle bug; this file catches a semantics bug.
//
// WHAT CHANGED, AND THEREFORE WHAT THIS FILE IS FOR. The single movement that
// used to fire at 'prepared' is now two halves, hours apart:
//
//   prepared            OUT of the warehouse, at qty_sent      → goods_state in_transit
//   (van moves)         the units belong to NEITHER location   → in-transit is DERIVED
//   delivered           the driver's leg ends. NO STOCK.
//   PUT …/receive       IN to the store, at qty_received       → goods_state settled
//
// Each half is idempotent on its OWN stamp. One stamp guarding a pair of writes
// was the old shape, and it implied the inbound half had run whenever the
// outbound one had — which is exactly what stops being true once they are hours
// apart.
//
// Run:  npm run test:stock-movement    (both suites)
//       node scripts/test_stock_two_step.js
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h, { pushEnabled: false });

const ACTOR = { id: 7, username: 'wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };
F.stubAuth(h, ACTOR, PERMS);

const restock = require(path.join(h.REPO, 'routes/restock.js'));

const WH = 1, SHOP = 2;
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'wh','Warehouse',1)").run();
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'shop','Shop',1)").run();
h.db.prepare(`INSERT OR IGNORE INTO users (id, username, password, role, is_active) VALUES (7,'wh','x','warehouse',1)`).run();

F.seedProduct(h.db, { id: 900, name: 'Hummus',   sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Tortilla', sku: 'P-901' });

const setCfg = (v) => h.db.prepare(
  "INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)").run(v);
const clearCfg = () => h.db.prepare("DELETE FROM storefront_config WHERE key = 'stock.warehouseStoreId'").run();
setCfg(String(WH));

const shelf  = (s, p) => F.shelf(h.db, s, p);
const ledger = (s, p) => F.ledgerFor(h.db, s, p);
const orderRow = (id) => h.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(id);
const itemsOf  = (id) => h.db.prepare('SELECT * FROM restock_items WHERE restock_id = ? ORDER BY id').all(id);

const call = (method, routePath, params, body) =>
  F.callRoute(restock, method, routePath, { params, body, user: ACTOR, permissions: PERMS });
const setStatus = (id, status) => call('put', '/api/restock/:id/status', { id: String(id) }, { status });
const receive   = (id, counts)  => call('put', '/api/restock/:id/receive', { id: String(id) }, { counts });

// A ledger row's provenance, read back the way a reconciliation would.
const refRows = (reason, orderId) => h.db.prepare(
  `SELECT * FROM retail_stock_ledger WHERE reason = ? AND ref_table = 'restock_orders' AND ref_id = ?`
).all(reason, orderId);

// Derived in-transit, through the real endpoint rather than a copy of its query.
const inTransit = (productId) => {
  const r = call('get', '/api/restock/in-transit', {}, {});
  const row = ((r.body || {}).data || []).find(x => x.product_id === productId);
  return row ? row.qty_in_transit : 0;
};

let nextId = 100;
function makeOrder({ lines, shelves = {} }) {
  const id = nextId++;
  for (const [k, qty] of Object.entries(shelves)) {
    const [store, product] = k.split(':').map(Number);
    F.setShelf(h.db, store, product, qty);
  }
  h.db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role,
                -- The pair is on the ORDER now, not inferred at dispatch: an order that
                -- does not say where its goods come from and go to is refused, which is
                -- what lets Tianhe ask Yuexiu without banning Tianhe→Tianhe.
                from_store_id, to_store_id)
                VALUES (?,?,?,'received','Shop',7,'warehouse','store',${WH},${SHOP})`).run(id, 'RS-' + id, '2026-09-03');
  for (const l of lines) {
    h.db.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
                  VALUES (?,?,?,?,?,?)`)
      .run(id, l.product_id, l.name || 'x', l.sku || null, l.qty_requested, l.qty_sent ?? null);
  }
  return id;
}

(() => {
  // ══ 1, 2, 3, 7 — the outbound half ═══════════════════════════════════════
  section('Dispatch — the OUT half, and only the OUT half');
  const id = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 12, qty_sent: 10 }],
    shelves: { '1:900': 100, '2:900': 5 },
  });
  const prep = setStatus(id, 'prepared');
  ok(prep.body && prep.body.success && !prep.body.stock_transfer, 'dispatch accepted with no transfer error');

  // 1
  eq(shelf(WH, 900), 90, '1. prepared decrements the warehouse (100 → 90)');
  eq(shelf(SHOP, 900), 5, '1. prepared leaves the DESTINATION UNCHANGED (still 5)');
  // 2
  const afterDispatch = orderRow(id);
  eq(afterDispatch.goods_state, 'in_transit', '2. goods_state = in_transit after prepared');
  ok(!!afterDispatch.dispatched_at, '2. dispatched_at is stamped');
  ok(!afterDispatch.received_confirmed_at, '2. received_confirmed_at is still NULL — the halves are independent');
  // 3
  eq(inTransit(900), 10, '3. derived in-transit equals qty_sent (10)');
  // 7 (outbound half)
  const outRows = refRows('restock_transfer_out', id);
  eq(outRows.length, 1, '7. exactly one restock_transfer_out row');
  eq(outRows[0].ref_table, 'restock_orders', '7. ref_table names the order table');
  eq(outRows[0].ref_id, id, '7. ref_id is the order id — provenance, not a note match');
  eq(outRows[0].delta, -10, '7. outbound delta is negative qty_sent');
  eq(ledger(SHOP, 900).length, 0, '7. no destination ledger row yet');

  // ══ 11 — double dispatch ═════════════════════════════════════════════════
  section('11. Double-dispatch is a no-op');
  // STATUS_FLOW refuses a backward move, so a second 'prepared' can never reach
  // _applyDispatch through the front door — which would make a test that only
  // re-sends the status prove nothing about the stock guard. The status is
  // rewound in the fixture so the SECOND dispatch genuinely runs against an
  // order whose dispatched_at is already set. That is the guard under test, and
  // it is what a network retry or a double-tap would hit.
  const before11 = { wh: shelf(WH, 900), rows: refRows('restock_transfer_out', id).length };
  h.db.prepare("UPDATE restock_orders SET status = 'received' WHERE id = ?").run(id);
  const second = setStatus(id, 'prepared');
  ok(second.body && second.body.success, '11. the second prepared is accepted');
  eq(shelf(WH, 900), before11.wh, '11. warehouse unchanged by the second dispatch');
  eq(refRows('restock_transfer_out', id).length, before11.rows, '11. still exactly one OUT row');
  eq(orderRow(id).goods_state, 'in_transit', '11. goods_state is still in_transit, not re-stamped');

  // The belt-and-braces guard for tenant files, where the goods_state backfill
  // never ran: an order carrying the OLD stamp must not dispatch again even
  // though its goods_state reads 'none'.
  // On product 901 so it cannot disturb the 900 shelves the next section reads.
  const legacy = makeOrder({
    lines: [{ product_id: 901, name: 'Tortilla', sku: 'P-901', qty_requested: 9, qty_sent: 9 }],
    shelves: { '1:901': 40, '2:901': 0 },
  });
  h.db.prepare("UPDATE restock_orders SET stock_applied_at = CURRENT_TIMESTAMP, goods_state = 'none' WHERE id = ?").run(legacy);
  setStatus(legacy, 'prepared');
  eq(shelf(WH, 901), 40, '11. an order already applied under the OLD model does not move stock again');
  eq(refRows('restock_transfer_out', legacy).length, 0, '11. and writes no ledger row');

  // ══ 4 — delivered moves nothing ══════════════════════════════════════════
  section('4. delivered moves no stock');
  eq(shelf(WH, 900), 90, '4. warehouse unchanged by delivered');
  eq(shelf(SHOP, 900), 5, '4. destination unchanged by delivered');
  eq(orderRow(id).goods_state, 'in_transit', '4. delivered leaves goods_state in_transit');
  ok(!orderRow(id).received_confirmed_at, '4. delivered does not stamp the receipt');

  // ══ 12 — line edits refused after dispatch ═══════════════════════════════
  section('12. Editing a line after dispatch is refused');
  const it = itemsOf(id)[0];
  const edit = call('put', '/api/restock/:id/item/:item_id', { id: String(id), item_id: String(it.id) }, { qty_sent: 99 });
  eq(edit.status, 409, '12. the edit is refused with 409');
  eq(itemsOf(id)[0].qty_sent, 10, '12. qty_sent is unchanged — in-transit is derived from it');

  // ══ 9 — an uncounted line prevents settling ══════════════════════════════
  section('9. A line left uncounted prevents settling');
  const two = makeOrder({
    lines: [
      { product_id: 900, name: 'Hummus',   sku: 'P-900', qty_requested: 6, qty_sent: 6 },
      { product_id: 901, name: 'Tortilla', sku: 'P-901', qty_requested: 4, qty_sent: 4 },
    ],
    shelves: { '1:900': 50, '2:900': 0, '1:901': 50, '2:901': 0 },
  });
  setStatus(two, 'prepared');
  const partial = receive(two, [{ item_id: itemsOf(two)[0].id, qty_received: 6 }]);
  eq(partial.body.settled, false, '9. a partial count does not settle the order');
  eq(partial.body.counted, 1, '9. the response tallies the counted lines');
  eq(partial.body.total, 2, '9. …against the total');
  eq(orderRow(two).goods_state, 'in_transit', '9. goods_state stays in_transit');
  eq(shelf(SHOP, 900), 0, '9. nothing lands while a line is uncounted');
  eq(itemsOf(two)[0].qty_received, 6, '9. but the count that WAS taken is saved — a resumable count');
  ok(itemsOf(two)[1].qty_received == null, '9. the uncounted line is still NULL, not 0');

  // ══ 5, 6, 7(in) — short receipt settles at the counted figure ════════════
  section('5, 6. Receipt at less than was sent');
  const done5 = receive(two, [{ item_id: itemsOf(two)[1].id, qty_received: 1 }]);
  eq(done5.body.settled, true, '5. the order settles once every line is counted');
  eq(shelf(SHOP, 900), 6, '5. line 1 landed at its counted figure (6)');
  eq(shelf(SHOP, 901), 1, '5. line 2 landed at qty_received (1), NOT qty_sent (4)');
  eq(shelf(WH, 901), 46, '5. the warehouse is not touched again by the receipt');
  // 6
  eq(orderRow(two).goods_state, 'settled', '6. goods_state = settled');
  ok(!!orderRow(two).received_confirmed_at, '6. received_confirmed_at is stamped');
  eq(inTransit(901), 0, '6. derived in-transit for that product is back to 0');
  // 7 (inbound half)
  const inRows = refRows('restock_transfer_in', two);
  eq(inRows.length, 2, '7. one restock_transfer_in row per moved line');
  eq(inRows.every(r => r.ref_id === two && r.ref_table === 'restock_orders'), true,
     '7. every inbound row carries the order provenance');

  // The counted figure is what moved; the discrepancy lives on the row.
  const short = itemsOf(two)[1];
  eq(short.qty_sent, 4, '5. sent is still 4 on the row');
  eq(short.qty_received, 1, '5. counted is 1 — the gap is legible without a reason field');
  ok(short.auto_settled_at == null, '5. auto_settled_at is NULL — a person counted this line');

  // ══ 10 — double receipt ══════════════════════════════════════════════════
  section('10. Double-calling receipt is a no-op');
  const before10 = { shop900: shelf(SHOP, 900), shop901: shelf(SHOP, 901), rows: refRows('restock_transfer_in', two).length };
  const again = receive(two, [{ item_id: itemsOf(two)[1].id, qty_received: 1 }]);
  ok(again.body.already === true, '10. the second call reports it was already received');
  eq(shelf(SHOP, 900), before10.shop900, '10. no second increment on line 1');
  eq(shelf(SHOP, 901), before10.shop901, '10. no second increment on line 2');
  eq(refRows('restock_transfer_in', two).length, before10.rows, '10. no duplicate inbound ledger rows');

  // ══ 8 — over-receipt ═════════════════════════════════════════════════════
  section('8. Over-receipt is accepted, not blocked');
  const over = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 5, qty_sent: 5 }],
    shelves: { '1:900': 50, '2:900': 0 },
  });
  setStatus(over, 'prepared');
  const overRes = receive(over, [{ item_id: itemsOf(over)[0].id, qty_received: 7 }]);
  eq(overRes.body.settled, true, '8. more arrived than was sent, and it settles anyway');
  eq(shelf(SHOP, 900), 7, '8. the destination gains the COUNTED figure (7), not the sent one (5)');
  eq(orderRow(over).goods_state, 'settled', '8. goods_state settled on an over-receipt');

  // A counted ZERO is an observation, not an absence.
  section('A counted zero settles the line and moves nothing');
  const zero = makeOrder({
    lines: [{ product_id: 901, name: 'Tortilla', sku: 'P-901', qty_requested: 3, qty_sent: 3 }],
    shelves: { '1:901': 30, '2:901': 2 },
  });
  setStatus(zero, 'prepared');
  const zeroRes = receive(zero, [{ item_id: itemsOf(zero)[0].id, qty_received: 0 }]);
  eq(zeroRes.body.settled, true, 'a zero count settles the order');
  eq(shelf(SHOP, 901), 2, 'nothing landed — but the line is counted, not outstanding');
  eq(itemsOf(zero)[0].qty_received, 0, 'qty_received is 0, which is not NULL');
  eq(refRows('restock_transfer_in', zero).length, 0, 'no ledger row — the ledger records movements');

  // ══ 13 — a dispatch larger than the shelf goes NEGATIVE ══════════════════
  section('13. Dispatch exceeding warehouse stock goes negative, and is not clamped');
  // FLIPPED 2026-09-03. This assertion previously CHARACTERISED the clamp — it
  // recorded that the warehouse floored at 0 and the shortfall was discarded,
  // because E2 was unruled and the clamp had to stay. E2 is now ruled (§39
  // ruling 7) and the clamp is gone, so the assertion states the real behaviour.
  //
  // B9's original wording expected a ROLLBACK. Ash ruled the other way for the
  // dispatch: the send is never blocked, because the picker's hands are right
  // and the record is wrong. So this asserts the ruled outcome, not B9's
  // anticipated one, and the difference is deliberate.
  const bust = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 50, qty_sent: 50 }],
    shelves: { '1:900': 20, '2:900': 0 },
  });
  const inTransitBefore = inTransit(900);   // an earlier order in this file is still on a van
  const bustRes = setStatus(bust, 'prepared');
  ok(bustRes.body && bustRes.body.success && !bustRes.body.stock_transfer,
     '13. the dispatch is NOT refused — the send goes through');
  eq(shelf(WH, 900), -30, '13. the warehouse goes to −30, not floored at 0');
  eq(refRows('restock_transfer_out', bust)[0].delta, -50,
     '13. the ledger records the full −50 that was sent — no shortfall is discarded');
  eq(refRows('restock_transfer_out', bust)[0].balance_after, -30,
     '13. balance_after records the negative honestly');
  eq(orderRow(bust).goods_state, 'in_transit', '13. and the transfer proceeds normally');
  eq(inTransit(900) - inTransitBefore, 50,
     '13. all 50 are in transit — the units physically exist even though the record did not');

  // The receipt half settles it the same way, at whatever the store counted.
  receive(bust, [{ item_id: itemsOf(bust)[0].id, qty_received: 50 }]);
  eq(shelf(SHOP, 900), 50, '13. the destination receives the full counted 50');
  eq(shelf(WH, 900), -30, '13. and the warehouse stays at −30 — a standing statement that the record undercounted');

  section('A downward correction may take a shelf negative (§39 ruling 7)');
  // The PO-receiving case the ruling actually settles, exercised through
  // adjustStock directly — routes/retail-purchasing.js reaches it with exactly
  // this shape (deltaQty = good − alreadyApplied, negative on a correction).
  const inv = require(path.join(h.REPO, 'lib/inventory.js'));
  F.setShelf(h.db, SHOP, 901, 1);
  const corrected = inv.adjustStock({ storeId: SHOP, productId: 901, deltaQty: -2, reason: 'restock' });
  eq(corrected.newQty, -1, 'correcting 10 arrived down to 8 when 9 were sold leaves −1, not 0');
  eq(corrected.delta, -2, 'the full −2 is recorded — the shortfall is not silently discarded');
  eq(shelf(SHOP, 901), -1, 'the shelf itself holds the negative');

  // ══ 14 — an order that cannot say where its goods go ═════════════════════
  section('14. A transfer with no source or destination refuses, and names why');
  // REWRITTEN when the pair moved onto the order. This assertion used to clear
  // stock.warehouseStoreId and expect the dispatch to refuse, because the
  // setting WAS the source: every dispatch read it at run time.
  //
  // It is not the source any more. The order records where its goods come from
  // and go to, and the setting is only a default consulted ONCE at creation. So
  // clearing it can no longer stop a dispatch — the order already knows — and
  // the refusal this assertion protects moved with the fact it was protecting.
  //
  // What is asserted instead is the same guarantee at its new home: an order
  // that cannot name both ends does not move stock, and says so rather than
  // guessing. The old guess is what put a Tianhe request on a van to Yuexiu.
  const noPair = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 2, qty_sent: 2 }],
    shelves: { '1:900': 10, '2:900': 0 },
  });
  h.db.prepare('UPDATE restock_orders SET from_store_id = NULL, to_store_id = NULL WHERE id = ?').run(noPair);
  const refused = setStatus(noPair, 'prepared');
  ok(refused.body.stock_transfer && refused.body.stock_transfer.ok === false, '14. the dispatch is refused');
  ok(/leave from|arrive at/.test(refused.body.stock_transfer.error),
     '14. the message says the order does not name its locations, rather than blaming a setting');
  eq(shelf(WH, 900), 10, '14. no stock moved');
  eq(orderRow(noPair).goods_state, 'none', '14. goods_state stays none — nothing is on a van');

  section('14b. A transfer cannot leave from and arrive at the same location');
  // The rule that replaces "the destination is never the warehouse". That form
  // banned Yuexiu→Tianhe as a side effect of catching Tianhe→Tianhe; this one
  // catches only the thing that is actually wrong. It is the case Roots creates
  // by having one building be both a store and the warehouse.
  const sameEnds = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 2, qty_sent: 2 }],
    shelves: { '1:900': 10 },
  });
  h.db.prepare('UPDATE restock_orders SET from_store_id = ?, to_store_id = ? WHERE id = ?').run(WH, WH, sameEnds);
  const loop = setStatus(sameEnds, 'prepared');
  ok(loop.body.stock_transfer && loop.body.stock_transfer.ok === false, '14b. it is refused');
  ok(/same location/.test(loop.body.stock_transfer.error), '14b. and says the two ends are the same place');
  eq(shelf(WH, 900), 10, '14b. no stock moved');

  section('14c. Goods can flow INTO the warehouse — Tianhe asking Yuexiu');
  // The request the old model could not express at all. Source and destination
  // are simply the other way round, and every downstream half works unchanged
  // because both halves read the pair off the order rather than the setting.
  const inbound = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 4, qty_sent: 4 }],
    shelves: { '1:900': 10, '2:900': 20 },
  });
  h.db.prepare('UPDATE restock_orders SET from_store_id = ?, to_store_id = ? WHERE id = ?').run(SHOP, WH, inbound);
  const back = setStatus(inbound, 'prepared');
  ok(back.body && back.body.success && !back.body.stock_transfer, '14c. the dispatch goes through');
  eq(shelf(SHOP, 900), 16, '14c. Yuexiu is decremented — it is the source now');
  eq(orderRow(inbound).goods_state, 'in_transit', '14c. and the goods are on a van');
  receive(inbound, [{ item_id: itemsOf(inbound)[0].id, qty_received: 4 }]);
  eq(shelf(WH, 900), 14, '14c. and Tianhe RECEIVES them — the direction the old resolver refused');

  // BOTH SIDES ARE ADDITIONS AT THE SAME POINT, KEPT IN FULL. #243 appended the
  // clamp-removal sections here and #244 appended the retry sections; the merge
  // could not tell them apart, but they share no fixture and assert nothing in
  // common. The clamp sections run first because #244's makeOrder() re-seeds every
  // shelf it uses, so a negative one left behind cannot leak into a retry case.
  section('The Kitchen Quick Stock delta path refuses a negative');
  // With the floor gone, an unguarded negative delta here would write a negative
  // balance through a door whose whole contract is "I made N more". The guard
  // states that contract; the absolute path is where a reduction belongs.
  const invRoute = require(path.join(h.REPO, 'routes/retail-inventory.js'));
  const STOCK_ROUTE = '/api/retail-admin/stores/:storeId/stock/:productId';
  F.setShelf(h.db, SHOP, 900, 12);
  const stockCall = (body) => F.callRoute(invRoute, 'patch', STOCK_ROUTE, {
    params: { storeId: String(SHOP), productId: '900' }, body,
    user: { ...ACTOR, role: 'admin' }, permissions: { retail_admin: 1, inventory: 1 },
  });
  const negRes = stockCall({ delta: -5 });
  eq(negRes.status, 400, 'a negative delta is refused');
  eq((negRes.body || {}).error, 'delta_must_be_positive', 'and refused by name, not silently absorbed');
  eq(shelf(SHOP, 900), 12, 'the shelf is untouched by the refused request');
  const posRes = stockCall({ delta: 5 });
  ok(posRes.status !== 400, 'a positive delta still works');
  eq(shelf(SHOP, 900), 17, 'and adds as it always did');

  section('A negative shelf appears on the dashboard "Needs you" panel');
  // FOUR CLAUSES, not one: count and preview are separate queries per card, so
  // a partial fix gives a card whose number and list disagree. Under the old
  // `= 0` a negative matched neither the low card nor the out-of-stock one and
  // vanished from the panel entirely — shipping negatives while hiding them
  // would have been worse than the clamp.
  const retail = require(path.join(h.REPO, 'routes/retail.js'));
  h.db.prepare(`UPDATE store_products SET status='Active', is_active=1, is_published=1 WHERE id IN (900,901)`).run();
  F.setShelf(h.db, WH, 901, -4);
  F.setShelf(h.db, SHOP, 901, 0);
  const ops = F.callRoute(retail, 'get', '/api/retail-admin/dashboard/ops', {
    params: {}, body: {}, user: { ...ACTOR, role: 'admin' }, permissions: { retail_admin: 1 },
  });
  const oos = ((ops.body || {}).data || ops.body || {}).out_of_stock || {};
  const negItem = (oos.items || []).find(i => i.id === 901);
  ok(!!negItem, 'the negative product is listed on the out-of-stock card (clause 4)');
  eq(negItem && negItem.stock_qty, -4,
     'and it is listed WITH its negative figure — proof the row came through, not a coincidence');
  eq(oos.count, (oos.items || []).length,
     'the COUNT clause (clause 3) agrees with the list — a partial fix would show them disagreeing');
  const lowIds = ((((ops.body || {}).data || ops.body || {}).low) || {}).items || [];
  ok(!lowIds.map(i => i.id).includes(901),
     'and it does NOT also appear on the low-stock card — a product must not be on both');
  // ══ Retry a failed dispatch ══════════════════════════════════════════════
  section('A rolled-back dispatch can be retried by the picker');
  const retryOrder = makeOrder({
    lines: [{ product_id: 901, name: 'Tortilla', sku: 'P-901', qty_requested: 8, qty_sent: 8 }],
    shelves: { '1:901': 30, '2:901': 0 },
  });
  // Abort the outbound ledger row so the dispatch rolls back exactly as a real
  // failure would — stock back, stamps back, order still dispatchable.
  h.db.exec(`CREATE TRIGGER _retryboom BEFORE INSERT ON retail_stock_ledger
             WHEN NEW.product_id = 901 AND NEW.reason = 'restock_transfer_out'
             BEGIN SELECT RAISE(ABORT, 'simulated'); END`);
  const failedPrep = setStatus(retryOrder, 'prepared');
  ok(failedPrep.body.stock_transfer && failedPrep.body.stock_transfer.ok === false, 'the dispatch failed');
  eq(shelf(WH, 901), 30, 'nothing moved');
  eq(orderRow(retryOrder).goods_state, 'none', 'and the order rolled back to none');

  const retry = (id) => call('post', '/api/restock/:id/retry-dispatch', { id: String(id) }, {});

  // Retrying while the cause is still there fails again, and says so plainly.
  const stillBroken = retry(retryOrder);
  eq(stillBroken.status, 409, 'retrying while the cause remains is refused');
  eq((stillBroken.body || {}).stock_moved, false, 'and says plainly that no stock moved');

  h.db.exec('DROP TRIGGER _retryboom');
  const retried = retry(retryOrder);
  ok(retried.body && retried.body.success, 'the retry succeeds once the cause is fixed');
  eq(retried.body.stock_moved, true, 'and says plainly that stock DID move');
  eq(retried.body.moved, 1, 'reporting how many lines went');
  ok(/left the warehouse/.test(retried.body.message), 'in words, not a status code');
  eq(shelf(WH, 901), 22, 'the stock actually moved (30 → 22)');
  eq(orderRow(retryOrder).goods_state, 'in_transit', 'and the order is in transit');
  eq(refRows('restock_transfer_out', retryOrder).length, 1, 'exactly one outbound ledger row');

  section('A second retry moves stock once');
  const beforeSecond = { wh: shelf(WH, 901), rows: refRows('restock_transfer_out', retryOrder).length };
  const twice = retry(retryOrder);
  ok(twice.body.success, 'the second tap is a success, not an error');
  eq(twice.body.already, true, 'reported as already dispatched');
  eq(twice.body.stock_moved, false, 'and it says no stock moved this time');
  eq(shelf(WH, 901), beforeSecond.wh, 'the shelf is unchanged by the second tap');
  eq(refRows('restock_transfer_out', retryOrder).length, beforeSecond.rows, 'still exactly one outbound row');

  section('A completed dispatch cannot be retried');
  // `id` was dispatched successfully at the top of this file.
  const beforeDone = { wh: shelf(WH, 900), rows: refRows('restock_transfer_out', id).length };
  const completed = retry(id);
  eq(completed.body.already, true, 'a dispatched order reports already, not a fresh dispatch');
  eq(completed.body.stock_moved, false, 'and moves nothing');
  eq(shelf(WH, 900), beforeDone.wh, 'its warehouse shelf is untouched');
  eq(refRows('restock_transfer_out', id).length, beforeDone.rows, 'and it gains no ledger row');

  section('An order that was never packed cannot be retried');
  const unpacked = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 3, qty_sent: 3 }],
    shelves: { '1:900': 20, '2:900': 0 },
  });
  const tooEarly = retry(unpacked);
  eq(tooEarly.status, 409, 'retrying an unpacked order is refused');
  eq((tooEarly.body || {}).error, 'not_dispatched_yet', 'by name — this is not a second way to send goods');
  eq(shelf(WH, 900), 20, 'and nothing moved');

  section('The receipt refuses an order that never left');
  const never = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 2, qty_sent: 2 }],
    shelves: { '1:900': 10, '2:900': 0 },
  });
  const early = receive(never, [{ item_id: itemsOf(never)[0].id, qty_received: 2 }]);
  eq(early.status, 409, 'receiving an undispatched order is refused');
  eq(shelf(SHOP, 900), 0, 'nothing landed');
  ok(itemsOf(never)[0].qty_received == null,
     'and NO count was written — a count on an order that never left is not an observation to keep');

  section('A settled order does not accept a rewritten count');
  // The dangerous version of a double receipt: not a duplicate movement, but a
  // count overwritten after the stock it justified has already moved, leaving
  // the row and the ledger disagreeing with nothing to reconcile them.
  const settledId = over;   // settled above at a counted 7
  // Read the shelf immediately before, rather than assuming a figure — later
  // fixtures in this file reseed product 900's shelves for their own cases.
  const shelfBeforeRewrite = shelf(SHOP, 900);
  const rewrite = receive(settledId, [{ item_id: itemsOf(settledId)[0].id, qty_received: 999 }]);
  ok(rewrite.body.already === true, 'the call reports the order was already received');
  eq(itemsOf(settledId)[0].qty_received, 7, 'qty_received still reads what was actually counted');
  eq(shelf(SHOP, 900), shelfBeforeRewrite, 'and the shelf is unchanged by the rewrite attempt');

  done();
})();
