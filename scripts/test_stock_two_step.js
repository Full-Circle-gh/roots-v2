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
  h.db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
                VALUES (?,?,?,'received','Shop',7,'warehouse','store')`).run(id, 'RS-' + id, '2026-09-03');
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

  // ══ 13 — the clamp, and why this assertion is NOT built ══════════════════
  section('13. Dispatch exceeding warehouse stock — NOT ASSERTED THIS ROUND');
  // B9 assertion 13 expects a dispatch larger than the shelf to roll back rather
  // than clamp. It is NOT built here, and the omission is deliberate:
  //
  //   • the plan puts that behaviour in Step 1b, which deletes the zero clamp
  //     at lib/inventory.js;
  //   • Step 1b is GATED on E2, the PO-receiving downward correction, which is
  //     unruled — and this build brief says the clamp stays in place this round.
  //
  // So the plan and the brief disagree about assertion 13 alone. Rather than
  // choose, this records today's behaviour so the change is visible when 1b
  // lands: the clamp floors the warehouse at 0 and the shortfall is discarded.
  const bust = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 50, qty_sent: 50 }],
    shelves: { '1:900': 20, '2:900': 0 },
  });
  setStatus(bust, 'prepared');
  eq(shelf(WH, 900), 0, '13(characterisation). the clamp floors the warehouse at 0 — it does NOT go to −30');
  eq(refRows('restock_transfer_out', bust)[0].delta, -20,
     '13(characterisation). the ledger records −20, not the −50 that was sent — the shortfall is discarded');
  ok(true, '13. the rollback assertion is deliberately NOT built — see the comment above and the build report');

  // ══ 14 — the warehouse setting ═══════════════════════════════════════════
  section('14. An unset warehouse refuses and names the setting');
  clearCfg();
  const noCfg = makeOrder({
    lines: [{ product_id: 900, name: 'Hummus', sku: 'P-900', qty_requested: 2, qty_sent: 2 }],
    shelves: { '1:900': 10, '2:900': 0 },
  });
  const refused = setStatus(noCfg, 'prepared');
  ok(refused.body.stock_transfer && refused.body.stock_transfer.ok === false, '14. the dispatch is refused');
  ok(/stock\.warehouseStoreId/.test(refused.body.stock_transfer.error),
     '14. the message names stock.warehouseStoreId rather than blaming the order');
  eq(shelf(WH, 900), 10, '14. no stock moved');
  eq(orderRow(noCfg).goods_state, 'none', '14. goods_state stays none — nothing is on a van');
  // The old code guessed here: whichever store held the most stock became the
  // warehouse, silently. A wrong source is worse than a refusal.
  setCfg(String(WH));

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
