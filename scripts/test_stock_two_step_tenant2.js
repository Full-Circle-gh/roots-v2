#!/usr/bin/env node
// Two-step warehouse → store movement — TENANT 2. Assertions 15-20 of
// docs/tacet-stock-movement-schema.md B9.
//
// ══ WHY THIS FILE EXISTS AND THE TENANT-1 SUITE IS NOT ENOUGH ══════════════
//
// lib/tenant-db.js returns mainDb for tenant 1, so on Roots the shared handle
// and the tenant handle are THE SAME CONNECTION: a query on the wrong one still
// reads and writes the right rows, and every tenant-1 assertion passes. Nothing
// in a single-database fixture can tell the two apart.
//
// That is not a hypothetical. Reverting the :333 fix left all 54 tenant-1
// restock assertions green while every non-Roots tenant silently double-moved
// its stock — the stamp was written through the shared handle from inside a
// transaction opened on the tenant handle, so it landed in a database where the
// order does not exist, matched zero rows, and reported success.
//
// The two-step model adds two new places for exactly that bug to live:
//
//   • TWO stamps now, not one — dispatched_at and received_confirmed_at — and
//     either landing in the wrong file re-opens the double-move;
//   • a CONFIG READ. stock.warehouseStoreId is per-tenant data. Read on the
//     shared handle it hands every tenant ROOTS' WAREHOUSE and moves their
//     stock at a location they do not own. Assertion 19 is that bug's direct
//     descendant and is the one that would fail loudest on careless code.
//
// Run:  npm run test:stock-movement
//       node scripts/test_stock_two_step_tenant2.js
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h, { pushEnabled: false });

const ACTOR = { id: 7, username: 't2wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };
F.stubAuth(h, ACTOR, PERMS);

const restock = require(path.join(h.REPO, 'routes/restock.js'));
const { T, raw: t2 } = F.openTenant(h, 2);

// ── tenant 1 (the shared database) gets its OWN warehouse and its own stock ──
// Different store ids on purpose: if the config read resolves on the shared
// handle, tenant 2's dispatch will move stock at store 1 — TENANT 1'S
// WAREHOUSE — and assertion 17 catches it.
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'t1-wh','T1 Warehouse',1)").run();
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'t1-shop','T1 Shop',1)").run();
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', '1')").run();
F.seedProduct(h.db, { id: 500, name: 'T1 Hummus', sku: 'T1-500' });
F.setShelf(h.db, 1, 500, 1000);
F.setShelf(h.db, 2, 500, 1000);

// ── tenant 2's data plane ───────────────────────────────────────────────────
// ITS WAREHOUSE IS STORE 3, NOT STORE 1. A shared-handle config read would
// return 1 and the dispatch would come out of the wrong location entirely.
t2.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (3,'t2-wh','T2 Warehouse',1)").run();
t2.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (4,'t2-shop','T2 Shop',1)").run();
t2.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', '3')").run();
F.seedProduct(t2, { id: 500, name: 'T2 Hummus',   sku: 'T2-500' });
F.seedProduct(t2, { id: 501, name: 'T2 Tortilla', sku: 'T2-501' });
F.setShelf(t2, 3, 500, 80); F.setShelf(t2, 4, 500, 3);
F.setShelf(t2, 3, 501, 60); F.setShelf(t2, 4, 501, 0);

// The warehouse-role user is control-plane: it lives in the SHARED database.
h.db.prepare(`INSERT OR IGNORE INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'t2wh','x','warehouse',3,1)`).run();

const T2_WH = 3, T2_SHOP = 4;
const shelf2 = (s, p) => F.shelf(t2, s, p);
const orderRow = (id) => t2.prepare('SELECT * FROM restock_orders WHERE id = ?').get(id);
const itemsOf  = (id) => t2.prepare('SELECT * FROM restock_items WHERE restock_id = ? ORDER BY id').all(id);

const inT2 = (fn) => F.inTenant(T, 2, fn);
const setStatus = (id, status) => inT2(() => F.callRoute(restock, 'put', '/api/restock/:id/status', {
  params: { id: String(id) }, body: { status }, user: ACTOR, permissions: PERMS }));
const receive = (id, counts) => inT2(() => F.callRoute(restock, 'put', '/api/restock/:id/receive', {
  params: { id: String(id) }, body: { counts }, user: ACTOR, permissions: PERMS }));
const inTransit2 = (productId) => {
  const r = inT2(() => F.callRoute(restock, 'get', '/api/restock/in-transit', {
    params: {}, body: {}, user: ACTOR, permissions: PERMS }));
  const row = ((r.body || {}).data || []).find(x => x.product_id === productId);
  return row ? row.qty_in_transit : 0;
};

t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
            VALUES (77,'T2-RS-001','2026-09-03','received','T2 Shop', 7, 'warehouse','store')`).run();
t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
            VALUES (77,500,'T2 Hummus','T2-500',12,9)`).run();
t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
            VALUES (77,501,'T2 Tortilla','T2-501',6,6)`).run();

// A snapshot of tenant 1, taken before tenant 2 does anything at all.
const t1Before = {
  wh: F.shelf(h.db, 1, 500), shop: F.shelf(h.db, 2, 500),
  ledger: h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n,
  orders: h.db.prepare('SELECT COUNT(*) AS n FROM restock_orders').get().n,
};

(() => {
  ok(t2 !== h.db, 'tenant 2 is a genuinely different database from the shared one');
  eq(inT2(() => T.currentTenantId()), 2, 'the ALS scope reports tenant 2');

  // ══ 19 — the config read, per tenant ═════════════════════════════════════
  // FIRST, because everything below depends on the dispatch having come out of
  // tenant 2's own warehouse rather than tenant 1's.
  section('19. stock.warehouseStoreId resolves per tenant');
  const t1Cfg = h.db.prepare("SELECT value_json FROM storefront_config WHERE key = 'stock.warehouseStoreId'").get();
  const t2Cfg = t2.prepare("SELECT value_json FROM storefront_config WHERE key = 'stock.warehouseStoreId'").get();
  eq(t1Cfg.value_json, '1', '19. tenant 1 says its warehouse is store 1');
  eq(t2Cfg.value_json, '3', '19. tenant 2 says its warehouse is store 3');

  // ══ 15 — dispatch on tenant 2 ════════════════════════════════════════════
  section('15. Dispatch writes into TENANT 2');
  const prep = setStatus(77, 'prepared');
  ok(prep.body && prep.body.success, '15. status → prepared handled inside the tenant scope');
  ok(!prep.body.stock_transfer, '15. no transfer error — tenant 2 resolved its own warehouse');

  const o = orderRow(77);
  ok(!!o.dispatched_at, '15. dispatched_at stamped IN TENANT 2');
  eq(o.goods_state, 'in_transit', '15. goods_state in_transit IN TENANT 2');
  ok(!o.received_confirmed_at, '15. received_confirmed_at still NULL — the two stamps are independent');

  // 19, proved by where the stock actually moved
  eq(shelf2(T2_WH, 500), 71, '19. the units left STORE 3 — tenant 2\'s warehouse (80 → 71)');
  eq(shelf2(T2_WH, 501), 54, '19. and store 3 for the second line too (60 → 54)');
  eq(shelf2(T2_SHOP, 500), 3, '15. tenant 2\'s destination is untouched at dispatch — in transit');

  // ══ 17 — tenant 1 is untouched ═══════════════════════════════════════════
  section('17. Tenant 1 is untouched by tenant 2\'s dispatch');
  eq(F.shelf(h.db, 1, 500), t1Before.wh,   '17. tenant 1 warehouse shelf unchanged');
  eq(F.shelf(h.db, 2, 500), t1Before.shop, '17. tenant 1 shop shelf unchanged');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, t1Before.ledger,
     '17. the shared database got no ledger rows');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM restock_orders').get().n, t1Before.orders,
     '17. the shared database has no copy of the order');

  // ══ 20 — derived in-transit counts only this tenant ══════════════════════
  section('20. Derived in-transit is per tenant');
  eq(inTransit2(500), 9, '20. tenant 2 sees its own 9 in transit');
  eq(inTransit2(501), 6, '20. …and its own 6 on the second line');
  // Tenant 1 has an in_transit order of its own, for the SAME product id, and
  // it must not leak into tenant 2's total.
  h.db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role, goods_state, dispatched_at)
                VALUES (900,'T1-RS-900','2026-09-03','prepared','T1 Shop',7,'warehouse','store','in_transit',CURRENT_TIMESTAMP)`).run();
  h.db.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
                VALUES (900,500,'T1 Hummus','T1-500',999,999)`).run();
  eq(inTransit2(500), 9, '20. tenant 1\'s 999 in transit does NOT appear in tenant 2\'s total');

  // ══ 16 — receipt on tenant 2 ═════════════════════════════════════════════
  section('16. Receipt writes qty_received and the stamp IN TENANT 2');
  const items = itemsOf(77);
  const partial = receive(77, [{ item_id: items[0].id, qty_received: 7 }]);
  eq(partial.body.settled, false, '16. one line counted does not settle a two-line order');
  eq(itemsOf(77)[0].qty_received, 7, '16. the count is saved in tenant 2');
  ok(itemsOf(77)[1].qty_received == null, '16. the uncounted line is still NULL in tenant 2');
  eq(shelf2(T2_SHOP, 500), 3, '16. nothing lands while a line is uncounted');

  const settled = receive(77, [{ item_id: items[1].id, qty_received: 6 }]);
  eq(settled.body.settled, true, '16. the order settles once every line is counted');
  const o2 = orderRow(77);
  eq(o2.goods_state, 'settled', '16. goods_state settled IN TENANT 2');
  ok(!!o2.received_confirmed_at, '16. received_confirmed_at stamped IN TENANT 2');
  eq(shelf2(T2_SHOP, 500), 10, '16. the destination gained the COUNTED 7, not the sent 9 (3 → 10)');
  eq(shelf2(T2_SHOP, 501), 6,  '16. and 6 on the line that matched');
  eq(shelf2(T2_WH, 500), 71,   '16. the warehouse is not touched again by the receipt');
  eq(inTransit2(500), 0, '16. derived in-transit for tenant 2 is back to 0');

  // 17 again, after the inbound half — the half that used to double-move.
  eq(F.shelf(h.db, 1, 500), t1Before.wh,   '17. tenant 1 warehouse STILL unchanged after the receipt');
  eq(F.shelf(h.db, 2, 500), t1Before.shop, '17. tenant 1 shop STILL unchanged after the receipt');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, t1Before.ledger,
     '17. the shared database still has no ledger rows');

  // Provenance landed in tenant 2's ledger, not the shared one.
  const t2Rows = t2.prepare(
    "SELECT reason, ref_table, ref_id FROM retail_stock_ledger WHERE ref_table = 'restock_orders' AND ref_id = 77").all();
  eq(t2Rows.length, 4, 'tenant 2 holds 4 ledger rows against order 77 — one OUT and one IN per line');
  eq(t2Rows.filter(r => r.reason === 'restock_transfer_out').length, 2, 'two outbound rows, written at dispatch');
  eq(t2Rows.filter(r => r.reason === 'restock_transfer_in').length, 2, 'two inbound rows, written hours later at receipt');
  ok(t2Rows.some(r => r.reason === 'restock_transfer_out') && t2Rows.some(r => r.reason === 'restock_transfer_in'),
     'both halves are recorded against the order in tenant 2');

  // ══ 18 — a failed receipt rolls back BOTH the stock and the stamp ════════
  section('18. A receipt that throws rolls back the stock AND the stamp');
  t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
              VALUES (78,'T2-RS-002','2026-09-03','received','T2 Shop', 7, 'warehouse','store')`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
              VALUES (78,500,'T2 Hummus','T2-500',5,5)`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
              VALUES (78,501,'T2 Tortilla','T2-501',4,4)`).run();
  setStatus(78, 'prepared');
  const beforeFail = { shop500: shelf2(T2_SHOP, 500), shop501: shelf2(T2_SHOP, 501) };

  // Abort the SECOND line's inbound row, so the first line's writes have
  // already succeeded when the failure lands.
  t2.exec(`CREATE TRIGGER _boom3 BEFORE INSERT ON retail_stock_ledger
           WHEN NEW.product_id = 501 AND NEW.reason = 'restock_transfer_in'
           BEGIN SELECT RAISE(ABORT,'simulated'); END`);
  const failed = receive(78, [
    { item_id: itemsOf(78)[0].id, qty_received: 5 },
    { item_id: itemsOf(78)[1].id, qty_received: 4 },
  ]);
  eq(failed.status, 409, '18. the failure is reported to the caller');
  eq(shelf2(T2_SHOP, 500), beforeFail.shop500, '18. line 1 rolled back although its writes had succeeded');
  eq(shelf2(T2_SHOP, 501), beforeFail.shop501, '18. line 2 rolled back');
  const failedRow = orderRow(78);
  ok(!failedRow.received_confirmed_at, '18. received_confirmed_at rolled back WITH the stock');
  eq(failedRow.goods_state, 'in_transit', '18. the order stays in_transit — and therefore retryable');
  // The counts themselves survive: they were written before the settlement was
  // attempted, so the person does not retype them.
  eq(itemsOf(78)[0].qty_received, 5, '18. the counts the person typed are kept');

  t2.exec('DROP TRIGGER _boom3');
  const retried = receive(78, [{ item_id: itemsOf(78)[0].id, qty_received: 5 }]);
  eq(retried.body.settled, true, '18. the receipt succeeds on retry once the cause is fixed');
  eq(shelf2(T2_SHOP, 500), beforeFail.shop500 + 5, '18. line 1 landed on the retry');
  eq(shelf2(T2_SHOP, 501), beforeFail.shop501 + 4, '18. line 2 landed on the retry');
  eq(orderRow(78).goods_state, 'settled', '18. and the order settled');

  // ══ 19, the loud version ═════════════════════════════════════════════════
  section('19. A tenant with NO warehouse setting refuses — it does not inherit tenant 1\'s');
  t2.prepare("DELETE FROM storefront_config WHERE key = 'stock.warehouseStoreId'").run();
  t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
              VALUES (79,'T2-RS-003','2026-09-03','received','T2 Shop', 7, 'warehouse','store')`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
              VALUES (79,500,'T2 Hummus','T2-500',3,3)`).run();
  const wh500Before = shelf2(T2_WH, 500);
  const refused = setStatus(79, 'prepared');
  ok(refused.body.stock_transfer && refused.body.stock_transfer.ok === false,
     '19. tenant 2 with no setting is REFUSED — it does not fall back to tenant 1\'s store 1');
  ok(/stock\.warehouseStoreId/.test(refused.body.stock_transfer.error), '19. and the message names the setting');
  eq(shelf2(T2_WH, 500), wh500Before, '19. no stock moved in tenant 2');
  eq(F.shelf(h.db, 1, 500), t1Before.wh, '19. and absolutely nothing moved in tenant 1');
  eq(orderRow(79).goods_state, 'none', '19. goods_state stays none');

  // BOTH SIDES ARE ADDITIONS AT THE SAME POINT, KEPT IN FULL. #243 appended the
  // clamp-removal sections here and #244 appended the retry sections; the merge
  // could not tell them apart, but they share no fixture and assert nothing in
  // common. The clamp sections run first because #244's makeOrder() re-seeds every
  // shelf it uses, so a negative one left behind cannot leak into a retry case.
  // ══ The clamp removal, on tenant 2 ═══════════════════════════════════════
  section('§39 ruling 7 — a negative balance is written in TENANT 2, not clamped');
  // The clamp lived in lib/inventory.js, which runs on tdb(). A tenant-1-only
  // suite cannot tell whether the negative landed in the right database — the
  // same blind spot that let the :333 bug through — so it is asserted here too.
  t2.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', '3')").run();
  const t1WhBefore = F.shelf(h.db, 1, 500);
  t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
              VALUES (80,'T2-RS-004','2026-09-03','received','T2 Shop', 7, 'warehouse','store')`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
              VALUES (80,501,'T2 Tortilla','T2-501',200,200)`).run();
  const t2WhBefore = shelf2(T2_WH, 501);
  const bust2 = setStatus(80, 'prepared');
  ok(bust2.body && bust2.body.success && !bust2.body.stock_transfer,
     'a dispatch larger than tenant 2\'s shelf is not refused');
  eq(shelf2(T2_WH, 501), t2WhBefore - 200,
     'tenant 2\'s warehouse goes NEGATIVE by the full amount — not floored at 0');
  ok(shelf2(T2_WH, 501) < 0, 'and the balance really is below zero in tenant 2');
  const negRow = t2.prepare(
    "SELECT delta, balance_after FROM retail_stock_ledger WHERE ref_id = 80 AND reason = 'restock_transfer_out'").get();
  eq(negRow.delta, -200, 'tenant 2\'s ledger records the full −200, discarding nothing');
  ok(negRow.balance_after < 0, 'and balance_after carries the negative');
  eq(F.shelf(h.db, 1, 500), t1WhBefore, 'tenant 1 is untouched by tenant 2 going negative');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, t1Before.ledger,
     'and the shared database still has no ledger rows at all');

  // A downward correction on tenant 2 — the PO-receiving case the ruling settles.
  const inv = require(path.join(h.REPO, 'lib/inventory.js'));
  F.setShelf(t2, T2_SHOP, 501, 1);
  const corrected = inT2(() => inv.adjustStock({ storeId: T2_SHOP, productId: 501, deltaQty: -2, reason: 'restock' }));
  eq(corrected.newQty, -1, 'a downward correction leaves −1 in tenant 2, not 0');
  eq(shelf2(T2_SHOP, 501), -1, 'and tenant 2\'s shelf holds it');
  // ══ Retry a failed dispatch, on TENANT 2 ═════════════════════════════════
  // The retry delegates to _applyDispatch, which writes stock through tdb() and
  // its stamps through the same connection. A tenant-1 suite cannot tell whether
  // either landed in the right file — the blind spot that let the :333 bug
  // through — so all three retry cases are asserted here too.
  section('Retry — a rolled-back dispatch is retryable in tenant 2');
  t2.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', '3')").run();
  t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
              VALUES (81,'T2-RS-005','2026-09-03','received','T2 Shop', 7, 'warehouse','store')`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested, qty_sent)
              VALUES (81,501,'T2 Tortilla','T2-501',8,8)`).run();
  const whBefore = shelf2(T2_WH, 501);
  const t1LedgerBefore = h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n;

  t2.exec(`CREATE TRIGGER _t2retryboom BEFORE INSERT ON retail_stock_ledger
           WHEN NEW.product_id = 501 AND NEW.reason = 'restock_transfer_out'
           BEGIN SELECT RAISE(ABORT,'simulated'); END`);
  const failed81 = setStatus(81, 'prepared');
  ok(failed81.body.stock_transfer && failed81.body.stock_transfer.ok === false, 'the tenant 2 dispatch failed');
  eq(shelf2(T2_WH, 501), whBefore, 'tenant 2 stock rolled back');
  eq(orderRow(81).goods_state, 'none', 'and goods_state rolled back to none in tenant 2');
  t2.exec('DROP TRIGGER _t2retryboom');

  const retry2 = (id) => inT2(() => F.callRoute(restock, 'post', '/api/restock/:id/retry-dispatch', {
    params: { id: String(id) }, body: {}, user: ACTOR, permissions: PERMS }));

  const retried81 = retry2(81);
  ok(retried81.body && retried81.body.success, 'the retry succeeds in tenant 2');
  eq(retried81.body.stock_moved, true, 'and reports that stock moved');
  eq(shelf2(T2_WH, 501), whBefore - 8, 'TENANT 2\'s warehouse is the one that moved');
  ok(!!orderRow(81).dispatched_at, 'dispatched_at stamped IN TENANT 2 by the retry');
  eq(orderRow(81).goods_state, 'in_transit', 'goods_state in_transit IN TENANT 2');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, t1LedgerBefore,
     'and the shared database got no ledger row from the retry');

  section('Retry — a double retry moves stock once, in tenant 2');
  const before2 = shelf2(T2_WH, 501);
  const twice2 = retry2(81);
  ok(twice2.body.success && twice2.body.already === true, 'the second retry reports already dispatched');
  eq(twice2.body.stock_moved, false, 'and moved nothing');
  eq(shelf2(T2_WH, 501), before2, 'tenant 2\'s shelf is unchanged by the second tap');
  eq(t2.prepare("SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_id = 81 AND reason = 'restock_transfer_out'").get().n,
     1, 'exactly one outbound ledger row in tenant 2');

  section('Retry — a completed dispatch cannot be retried, in tenant 2');
  // Order 77 dispatched and settled successfully at the top of this file.
  const settledBefore = shelf2(T2_WH, 500);
  const completed2 = retry2(77);
  eq(completed2.body.already, true, 'a settled order reports already, not a fresh dispatch');
  eq(completed2.body.stock_moved, false, 'and moves nothing');
  eq(shelf2(T2_WH, 500), settledBefore, 'tenant 2\'s warehouse shelf is untouched');

  done();
})();
