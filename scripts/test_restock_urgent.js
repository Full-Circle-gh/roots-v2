#!/usr/bin/env node
/**
 * "Urgent order" — the third answer to "What is it for?", and the sort that
 * makes it mean something.
 *
 *   node scripts/test_restock_urgent.js
 *
 * THE ASK. Ash, on the warehouse account, looking at "Ask the kitchen": the two
 * options there — For an order, For the shelf — have no way to say *make this
 * one first*. So a request with a customer arriving in two hours and a routine
 * shelf top-up got the same sentence, and what decided the order the kitchen
 * worked in was the order the requests happened to land in.
 *
 * WHY THIS SUITE EXISTS AND IS IN THE FAST SHARD. The picker itself is covered
 * where the pickers are covered — scripts/test_stock_home.js drives the /stock
 * screen in Chromium — but that suite lives in the slow shard, which is not run
 * (see CLAUDE.md). The two facts asserted below are SERVER facts and need no
 * browser, so they belong in the gate that actually runs:
 *
 *   1. THE GATE TAKES THE NEW NAME. `purpose` is whitelisted by name in
 *      POST /api/restock and anything else becomes null and is refused. A third
 *      option in two front-ends and a whitelist of two on the server is a screen
 *      whose third button 400s.
 *
 *   2. THE LIST SORTS ON IT. This is the whole of what 'urgent' means (§65).
 *      Before it, GET /api/restock ordered by created_at DESC and nothing else,
 *      so an urgent request raised at 09:00 sat BELOW a routine one raised at
 *      09:05 — the kitchen found it by reading every card, or did not. A chip
 *      that does not move the row is decoration.
 *
 * AND THAT IT IS INERT FOR THE OTHER DIRECTION. That endpoint serves
 * store→warehouse rows too, whose purpose is NULL by design. A change to a
 * shared ORDER BY that quietly reorders the direction it was not about is a
 * change to two things, and the second one is the one nobody tests.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();

h.stub('routes/retail.js', {
  requireRetailAdmin: (req, _res, next) => {
    req.backendUser = req.user = { id: 7, username: 'wh', role: 'staff', display_name: 'WH' };
    req.caps = null; req.scopeStores = null;
    next();
  },
});
h.stub('middleware/auth.js', {
  requireAuth: (req, _res, next) => {
    req.user = { id: 7, username: 'wh', role: 'staff' };
    req.permissions = { restock: 1, warehouse_inbox: 1, kitchen_inbox: 1 };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
  requireDelete: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  logActivity: () => {},
});

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const WH = 1;
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'wh','x','warehouse',?,1)`).run(WH);
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)")
  .run(String(WH));
F.setShelf(h.db, WH, 900, 100);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const ask = (purpose, name) => call('POST', '/api/restock', {
  to_role: 'kitchen', purpose, status: 'sent',
  items: [{ product_id: null, product_name: name, sku: 'P-1', qty_requested: 6 }],
});

// created_at is a second-resolution stamp and this suite writes several rows
// inside one second, so the tie-break the route carries (id DESC) would decide
// the order rather than the clock. Age each row explicitly instead: the point
// being proved is that urgency beats the clock, which needs the clock to differ.
function age(id, minutesAgo) {
  h.db.prepare(`UPDATE restock_orders SET created_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${minutesAgo} minutes`, id);
}
const numbers = (rows) => (rows || []).map(r => r.rs_number);

(async () => {
  section('The gate takes the third name, and only the names it knows');

  const urgent = await ask('urgent', 'Hummus');
  eq(urgent.status, 200, "a kitchen request with purpose 'urgent' is accepted");
  const urgentRow = h.db.prepare('SELECT purpose FROM restock_orders WHERE id = ?').get(urgent.body.id);
  eq(urgentRow.purpose, 'urgent', 'and the word is what lands in the column, not a translation of it');

  eq((await ask('order', 'Hummus')).status, 200, "'order' still passes");
  eq((await ask('shelf', 'Hummus')).status, 200, "'shelf' still passes");

  /* THE WHITELIST IS STILL A WHITELIST. The third value widened it by one name,
     not into "anything truthy" — a stale client, or a typo in either front-end,
     must still come back 400 rather than writing a purpose the kitchen screens
     render as a blank. */
  const nonsense = await ask('URGENT', 'Hummus');
  eq(nonsense.status, 400, 'a near-miss is refused rather than stored — case is not forgiven');
  eq((await ask('rush', 'Hummus')).status, 400, 'and so is a plausible synonym nothing renders');
  eq((await ask(null, 'Hummus')).status, 400, 'no purpose at all is refused exactly as before');

  section('Urgent sorts to the front, and the clock still orders inside it');

  // A clean tenant for the ordering claim, so the rows above do not decide it.
  h.db.prepare('DELETE FROM restock_orders').run();

  const oldUrgent = (await ask('urgent', 'Hummus')).body.id;   // asked first
  const newRoutine = (await ask('order', 'Hummus')).body.id;   // asked later
  const newerUrgent = (await ask('urgent', 'Hummus')).body.id; // asked last
  age(oldUrgent, 60);
  age(newRoutine, 30);
  age(newerUrgent, 5);

  const rsOf = (id) => h.db.prepare('SELECT rs_number FROM restock_orders WHERE id = ?').get(id).rs_number;
  const list = await call('GET', '/api/restock?to_role=kitchen&tab=active');
  eq(list.status, 200, 'the kitchen reads its queue');
  const order = numbers(list.body.data);

  /* THE DEFECT THIS CLOSES, STATED AS AN ASSERTION. Under created_at DESC alone
     the routine request raised half an hour ago outranked the urgent one raised
     an hour ago, and the operator who marked it urgent had changed nothing. */
  ok(order.indexOf(rsOf(oldUrgent)) < order.indexOf(rsOf(newRoutine)),
     'an urgent request raised an HOUR ago outranks a routine one raised half an hour ago');
  ok(order.indexOf(rsOf(newerUrgent)) < order.indexOf(rsOf(oldUrgent)),
     'and between two urgent requests the clock still decides — newest first, as before');
  eq(order[order.length - 1], rsOf(newRoutine),
     'the routine request is last, not merely displaced');

  section('And it leaves the direction it is not about alone');

  /* store→warehouse rows carry no purpose at all. The sort key evaluates
     identically for every one of them, so their order must be the order they
     had before this change existed: created_at DESC, id DESC. */
  h.db.prepare('DELETE FROM restock_orders').run();
  const mk = (n, minutesAgo) => {
    const r = h.db.prepare(`INSERT INTO restock_orders
      (rs_number, date, status, from_role, to_role, purpose, created_by)
      VALUES (?, date('now'), 'sent', 'store', 'warehouse', NULL, 7)`).run(n);
    age(r.lastInsertRowid, minutesAgo);
    return n;
  };
  mk('RS-A', 90); mk('RS-B', 45); mk('RS-C', 10);

  const transfers = await call('GET', '/api/restock?to_role=warehouse&tab=active');
  eq(numbers(transfers.body.data).join(','), 'RS-C,RS-B,RS-A',
     'a queue with no purpose in it is ordered newest-first, exactly as it was');

  // The two directions share one endpoint and one ORDER BY. An urgent kitchen
  // request must not surface in the transfer list at all, sorted or otherwise.
  await ask('urgent', 'Hummus');
  const stillThree = await call('GET', '/api/restock?to_role=warehouse&tab=active');
  eq(numbers(stillThree.body.data).join(','), 'RS-C,RS-B,RS-A',
     'and an urgent KITCHEN request does not climb into it');

  server.close();
  done();
})();
