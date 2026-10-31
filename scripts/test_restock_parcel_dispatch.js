#!/usr/bin/env node
/**
 * §187 — a parked order's parcels can still go out, when the parcel itself is
 * not what the order is short of.
 *
 *   node scripts/test_restock_parcel_dispatch.js
 *
 * WHAT THIS IS FIXING, so the assertions read as more than shape-checking.
 * TC000784 sat at 'Awaiting restock' with two parcels: an air box carrying the
 * fresh line the order was waiting on, and a land box of four shelf products —
 * almonds, pumpkin seeds, sunflower kernels, a crisp — that the shortage never
 * touched. The land box had NO shipping control at all. Not a hidden one: the
 * dispatch window is the literal list ['paid','preparing','dispatched'] and it
 * is written out five times (both parcel routes, the JD waybill route, the
 * desktop drawer, the phone), and none of the five named this status. What the
 * card did offer was "Ship part later", which splits a parcel it still cannot
 * send — so the operator could cut the box in two and be no nearer to posting
 * either half.
 *
 * THE FIX IS PER PARCEL, NOT PER ORDER, and that is the load-bearing claim here:
 * a box holding a short line stays refused, and `parcelHeldLines` is the single
 * place that asks. Section 2 pins it on the routes, section 5 on both screens.
 *
 * THE THREE CONSEQUENCES, which are most of this file, because each one is a way
 * the obvious version of this change goes wrong:
 *
 *   1. THE ORDER MUST NOT LEAVE ITS PARK. checkAwaitingRestockForRestock scans
 *      `status = 'awaiting_restock'` and nothing else. Flip the order to
 *      'dispatched' on the land box the way every other parcel dispatch does,
 *      and the fresh line's automatic release never runs again — the restock
 *      lands, the sweep looks past the order, and it sits "dispatched" forever
 *      with food nobody was told to make. Section 3.
 *   2. THE COMMIT MUST HOLD THE SHORT LINES BACK. A dispatch owes the shelf its
 *      parcel's stock, but the products the order is PARKED ON are by definition
 *      not there; committed anyway they write an honest negative (§84) for units
 *      nobody picked, which lib/batch-owed.js reads as food to cook. The numbers
 *      for that live in test_fresh_stock_deferral.js §17, which owns the commit;
 *      section 4 here owns the release on the other side of it.
 *   3. THE CANCEL MUST NOT CREDIT THE SHELF WITH WHAT HAS GONE. 'dispatched' is
 *      deliberately not in STATUS_TRANSITIONS.cancelled.prev; 'awaiting_restock'
 *      is, on a comment — "there's no committed stock to reverse" — that this
 *      change makes false. Section 6.
 *
 * Runs against a THROWAWAY database it creates and deletes itself, on the model
 * of test_fresh_stock_deferral.js: the functions under test are extracted from
 * the live sources and executed, never mirrored, because a mirror passes while
 * the product breaks. The route guards and the two screens have no runnable
 * shape, so those are read off the real files by name.
 *
 * TO PROVE THE SUITE CAN FAIL:  RESTOCK_PARCEL_SABOTAGE=1 node scripts/test_restock_parcel_dispatch.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// routes/retail.js and everything moved out of it (decisions §477): expandStockLines
// and parseBundleItems are in lib/bundles.js.
let ROUTES  = require('./test-support/retail-source').retailSource();
let INV     = read('lib/inventory.js');
let DESKTOP = read('public/retail-admin/04-orders.js');
let MOBILE  = read('public/m.html');

/* A sabotage mode, because a suite nobody has seen fail is a suite nobody should
   trust. Each mutation is one this change was genuinely at risk of — the parcel
   test dropped, the park flipped away, the release left gated, the screens left
   on the old window. */
const SABOTAGE = process.env.RESTOCK_PARCEL_SABOTAGE === '1';
if (SABOTAGE) {
  ROUTES  = ROUTES.replace(
    "if (o.status !== 'dispatched' && o.status !== 'awaiting_restock') {",
    "if (o.status !== 'dispatched') {");
  ROUTES  = ROUTES.replace(
    'function parcelHeldLines(orderId, shipmentId, waiting) {\n  if (!waiting || !waiting.size) return 0;',
    'function parcelHeldLines(orderId, shipmentId, waiting) {\n  if (true) return 0;\n  if (!waiting || !waiting.size) return 0;');
  INV     = INV.replace('if (goneOut.has(pid) && alreadyTaken.has(pid)) return true;', '');
  // The units-vs-ids regression: filtering the whole product back out.
  ROUTES  = ROUTES.replace('qty: r.qty - (gone.get(r.product_id) || 0)', 'qty: r.qty');  // now in the §191 helper
  DESKTOP = DESKTOP.replace("'dispatched', 'awaiting_restock'].includes(o.status)", "'dispatched'].includes(o.status)");
  MOBILE  = MOBILE.replace("'dispatched','awaiting_restock'].includes(o.rawStatus)", "'dispatched'].includes(o.rawStatus)");
}

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}
function section(t) { results.push({ heading: t }); }

// ── Extraction ──────────────────────────────────────────────────────────────
// The dumb-but-loud rule the sibling suites use: a top-level `function NAME(`
// through the first line that starts a `}` in column one. If either file
// reformats, the extraction check below fails BY NAME rather than the
// assertions failing mysteriously somewhere downstream.
function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

const ROUTE_FNS = ['orderWaitingPids', 'parcelHeldLines', 'orderShippedQty',
  'prepareCommitUnreservedOrder', 'freshLinesDeferred', 'batchMadeProductIds',
  'expandStockLines', 'parseBundleItems', 'parcelsStillInTheBuilding'];
const INV_FNS = ['checkAwaitingRestockForRestock', 'orderStockNeed',
  'orderCommittedPids', 'orderShippedOutPids', 'getAvailable',
  'sumActiveReservations', 'commitUnreservedOrder'];

const routeSrc = {};
for (const n of ROUTE_FNS) routeSrc[n] = extractFn(n, ROUTES);
const invSrc = {};
for (const n of INV_FNS) invSrc[n] = extractFn(n, INV);

section('── 0. Extraction');
check('every function under test was found in its source',
  [...ROUTE_FNS.filter((n) => !routeSrc[n]), ...INV_FNS.filter((n) => !invSrc[n])], []);

// ── Schema: only the columns these assertions read ──────────────────────────
const dbPath = path.join(os.tmpdir(), `restock-parcel-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, fulfillment_type TEXT,
    store_id INTEGER, channel TEXT, paid_at DATETIME, updated_at DATETIME,
    awaiting_restock_pids TEXT,
    source TEXT   -- read by commitUnreservedOrder (see test_platform_order_single_deduct.js)
  );
  CREATE TABLE retail_order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER,
    refunded_qty INTEGER DEFAULT 0, options_json TEXT, shipment_id INTEGER
  );
  CREATE TABLE retail_shipments (
    id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    prepared_at DATETIME, dispatched_at DATETIME, delivered_at DATETIME
  );
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, bundle_items TEXT, is_batch_made INTEGER DEFAULT 0,
    ship_from_supplier INTEGER DEFAULT 0
  );
  CREATE TABLE retail_store_stock (
    store_id INTEGER, product_id INTEGER, physical_qty INTEGER NOT NULL DEFAULT 0,
    safety_buffer INTEGER NOT NULL DEFAULT 0, wechat_quota INTEGER, meituan_quota INTEGER,
    updated_at DATETIME, UNIQUE(store_id, product_id)
  );
  CREATE TABLE retail_stock_ledger (
    id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER, delta INTEGER,
    reason TEXT, ref_table TEXT, ref_id INTEGER, balance_after INTEGER,
    actor_user_id INTEGER, actor_label TEXT, channel TEXT, note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE retail_stock_reservations (
    id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER, order_id INTEGER,
    qty INTEGER, channel TEXT, status TEXT, expires_at DATETIME,
    created_at DATETIME, committed_at DATETIME, released_at DATETIME
  );
`);

/* The order from the report, as close as a fixture gets to it: one fresh line
   the kitchen makes and is out of (the air box), four shelf products that are
   fine (the land box). PITA is what the order is parked on. */
const PITA = 251, ALMOND = 340, PUMPKIN = 390, SUNFLOWER = 190, CRISP = 800;
const STORE = 1;
const mkProduct = db.prepare(
  'INSERT INTO store_products (id, bundle_items, is_batch_made) VALUES (?,?,?)');
mkProduct.run(PITA, null, 1);
for (const p of [ALMOND, PUMPKIN, SUNFLOWER, CRISP]) mkProduct.run(p, null, 0);
const setStock = db.prepare(
  'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)');
setStock.run(STORE, PITA, 0);            // the shortage
setStock.run(STORE, ALMOND, 6);
setStock.run(STORE, PUMPKIN, 6);
setStock.run(STORE, SUNFLOWER, 6);
setStock.run(STORE, CRISP, 6);

const qty = (pid) => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(STORE, pid).q;
const statusOf = (id) => db.prepare('SELECT status AS s FROM retail_orders WHERE id = ?').get(id).s;

let nextOrder = 7000;
function mkOrder(lines, { status = 'awaiting_restock', parkedOn = null } = {}) {
  const id = ++nextOrder;
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel, awaiting_restock_pids)
     VALUES (?,?,?,'delivery',?,'wechat',?)`
  ).run(id, 'TC00' + id, status, STORE, parkedOn ? JSON.stringify(parkedOn) : null);
  for (const [pid, n] of lines) {
    db.prepare(
      'INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,?)'
    ).run(id, pid, n, '[]');
  }
  return id;
}
let nextShip = 9000;
function mkParcel(orderId, mode, pids) {
  const id = ++nextShip;
  db.prepare('INSERT INTO retail_shipments (id, order_id, mode) VALUES (?,?,?)').run(id, orderId, mode);
  for (const pid of pids) {
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ? AND product_id = ?')
      .run(id, orderId, pid);
  }
  return id;
}
// The stamp the dispatch route writes BEFORE it reaches the commit.
const shipParcel = (sid) => db.prepare(
  "UPDATE retail_shipments SET dispatched_at = '2026-09-19 10:00:00' WHERE id = ?").run(sid);

const syncCalls = [];
const inventory = new Function('db', 'syncCalls', `
  const tdb = () => db;
  const enqueueChannelSync = (storeId, productId) => syncCalls.push(storeId + ':' + productId);
  const _bumpStockLive = () => {};
  const _reportBelowZero = () => {};
  ${INV_FNS.map((n) => invSrc[n]).join('\n')}
  return { ${INV_FNS.join(', ')} };
`)(db, syncCalls);
const routes = new Function('db', 'inventory', 'isCounter', `
  const tdb = () => db;
  ${ROUTE_FNS.map((n) => routeSrc[n]).join('\n')}
  return { ${ROUTE_FNS.join(', ')} };
`)(db, inventory, require('../lib/fulfilment').isCounter);

const loadOrder = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);

// ─────────────────────────────────────────────────────────────────────────────
section('── 1. The parked order, and which of its boxes may go');

const tc = mkOrder([[PITA, 1], [ALMOND, 1], [PUMPKIN, 1], [SUNFLOWER, 2], [CRISP, 1]],
  { parkedOn: [PITA] });
const tcAir  = mkParcel(tc, 'air',  [PITA]);
const tcLand = mkParcel(tc, 'land', [ALMOND, PUMPKIN, SUNFLOWER, CRISP]);

check('the order names the product it is parked on',
  [...routes.orderWaitingPids(loadOrder(tc))], [PITA]);
check('the land box carries none of them — 0 is the licence to send it',
  routes.parcelHeldLines(tc, tcLand, routes.orderWaitingPids(loadOrder(tc))), 0);
check('the air box carries the short line and stays held',
  routes.parcelHeldLines(tc, tcAir, routes.orderWaitingPids(loadOrder(tc))), 1);

/* THE COLUMN IS KEPT AFTER THE ORDER RELEASES, as the audit trail. Read alone it
   would hold an order that shipped weeks ago, so every reader gates on the LIVE
   status — which is also what makes this whole section a no-op for orders that
   were never parked. */
const shipped = mkOrder([[PITA, 1]], { status: 'dispatched', parkedOn: [PITA] });
check('a released order still carrying the audit column waits on nothing',
  [...routes.orderWaitingPids(loadOrder(shipped))], []);
check('…so none of its parcels is held either',
  routes.parcelHeldLines(shipped, mkParcel(shipped, 'land', [PITA]),
    routes.orderWaitingPids(loadOrder(shipped))), 0);

// ─────────────────────────────────────────────────────────────────────────────
section('── 2. The routes ask the parcel, not just the order');

// Both parcel routes must name the status AND refuse a box holding a short line.
// The window is a literal list in five places; a change that widens one of them
// and forgets the guard is the failure this pair catches.
for (const [label, marker] of [['prepare', '/prepare'], ['dispatch', '/dispatch']]) {
  const at = ROUTES.indexOf(`router.post('/api/retail-admin/orders/:id/shipments/:sid${marker}'`);
  const body = at === -1 ? '' : ROUTES.slice(at, at + 3000);
  check(`the ${label} route admits a parked order`,
    /'paid', 'preparing', 'dispatched', 'awaiting_restock'/.test(body), true);
  check(`…and refuses the parcel that carries a short line`,
    /parcelHeldLines\(id, sid, orderWaitingPids\(o\)\)/.test(body), true);
  check(`…reading awaiting_restock_pids off the order to do it`,
    /SELECT id, status, awaiting_restock_pids FROM retail_orders/.test(body), true);
}
/* §193 REVERSES WHAT THIS BLOCK USED TO ASSERT, and the reversal is the point.
   It read "the JD waybill route keeps the narrow window — it ships the ORDER",
   on the reading that minting a label ships the whole order rather than one
   box. That reading was already false when it was written: the route resolves
   ONE shipment, stamps THAT shipment's tracking, and commits THAT shipment's
   stock with `shipmentId` (§58 addendum). What it ships is a box.

   The cost was the same order this file is named after. TC000784's ambient box
   got its dispatch button back from §187 and still could not be labelled: the
   drawer offers "Create JD label" on any parcel without a waybill, the operator
   fills the dialog, and the server answers 409 not_shippable — "That order is
   not ready to ship", about a box that is ready. The only way out was a waybill
   bought elsewhere, which is the free JD tracking this route exists to get.

   So the JD route now answers the same three questions the two above do, and
   two more that only it can get wrong. */
const jd = ROUTES.indexOf("router.post('/api/retail-admin/orders/:id/jd-waybill'");
const jdEnd = ROUTES.indexOf('\n});', jd);
const jdBody = ROUTES.slice(jd, jdEnd === -1 ? jd + 12000 : jdEnd);
check('the JD waybill route admits a parked order',
  /'paid', 'preparing', 'dispatched', 'awaiting_restock'/.test(jdBody), true);
check('…and refuses the parcel that carries a short line',
  /parcelHeldLines\(id, shipment\.id, orderWaitingPids\(o\)\)[\s\S]{0,140}parcel_awaiting_restock/.test(jdBody), true);
check('…reading awaiting_restock_pids off the order to do it',
  /awaiting_restock_pids\n\s+FROM retail_orders WHERE id = \?/.test(jdBody), true);
/* THE TWO ONLY THIS ROUTE CAN GET WRONG. A label is minted mid-handler and the
   order flip sits below it, so the tempting shape — "we just shipped it, mark
   it dispatched" — is right there; §187 section 3 is the whole reason it must
   not fire on a parked order. And the response is what both drawers re-render
   off, so a hard-coded 'dispatched' would show the order leaving its park on a
   screen the database disagrees with. */
check('…and leaves a parked order where it is, exactly as parcel dispatch does',
  /if \(o\.status !== 'dispatched' && o\.status !== 'awaiting_restock'\) \{/.test(jdBody), true);
check('…and answers with the status the order actually holds',
  /order_status: afterStatus \}/.test(jdBody), true);
// The customer push still rides on firstDispatch, which the guard above never
// sets for a parked order — §188 owns what that customer is told instead.
check('…telling the customer nothing on the "order dispatched" line',
  /if \(firstDispatch\) \{ try \{ notifyOrderStatusChange\(id, 'dispatched'\)/.test(jdBody), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 3. The park survives the parcel leaving');

/* The one reader that acts on 'awaiting_restock' is the release sweep, and it
   scans that status and nothing else. This is the assertion the whole section
   turns on: if the dispatch route flips the order the way every other parcel
   dispatch does, the fresh line is never released again. */
check('the release sweep finds parked orders by status alone',
  /WHERE o\.status = 'awaiting_restock' AND o\.store_id = \?/.test(INV), true);
const disp = ROUTES.indexOf("router.post('/api/retail-admin/orders/:id/shipments/:sid/dispatch'");
/* THE WINDOW IS SIZED FROM THE HANDLER'S END, NOT GUESSED. It was a flat 6000
   characters and §188 added a block inside this route, which pushed the
   response line past it — the assertion below went red on code that was
   perfectly correct, which is the rot this suite's siblings warn about. */
const dispEnd = ROUTES.indexOf('\n});', disp);
const dispBody = ROUTES.slice(disp, dispEnd === -1 ? disp + 9000 : dispEnd);
check('so the dispatch route leaves a parked order where it is',
  /if \(o\.status !== 'dispatched' && o\.status !== 'awaiting_restock'\) \{/.test(dispBody), true);
// The customer push rides on firstDispatch, which the guard above never sets for
// a parked order — "your order is on the way" is not true of one whose kitchen
// lines have not been made.
check('…and tells the customer nothing, the push riding on that same flag',
  /if \(firstDispatch\) \{\s*\n\s*try \{ notifyOrderStatusChange\(id, 'dispatched'\)/.test(dispBody), true);
// The response used to hard-code 'dispatched'. Both drawers re-render off it.
check('…and answers with the status the order actually holds',
  /order_status: after \}/.test(dispBody), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 4. The release, on the other side of a box that already went');

/* THE STRANDING CASE, and the reason section 4 exists at all. The land box has
   gone: its four products are off the count and out of the building. When the
   pita is finally baked, the sweep asks whether every product the order needs is
   covered — and the four that left are NOT on the shelf and never will be for
   this order. Gated on them, the order waits for a restock of goods the customer
   already has, forever, on a shelf behaving perfectly. */
routes.prepareCommitUnreservedOrder(tc, { actorLabel: 'Auto · parcel', shipmentId: tcLand });
shipParcel(tcLand);
check('the land box took its own four lines off the count',
  [qty(ALMOND), qty(PUMPKIN), qty(SUNFLOWER), qty(CRISP)], [5, 5, 4, 5]);
check('…and left the line the order is parked on alone', qty(PITA), 0);
check('…and the order is still parked', statusOf(tc), 'awaiting_restock');

// The shelf now cannot cover the four that left, which is the whole point.
db.prepare('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = ? AND product_id IN (?,?,?,?)')
  .run(STORE, ALMOND, PUMPKIN, SUNFLOWER, CRISP);
// The kitchen bakes the pita. One unit, which is exactly what the order needs.
db.prepare('UPDATE retail_store_stock SET physical_qty = 1 WHERE store_id = ? AND product_id = ?')
  .run(STORE, PITA);
const released = inventory.checkAwaitingRestockForRestock({ storeId: STORE, productId: PITA });
check('the restock releases the order although the shipped box cannot be re-covered',
  [released, statusOf(tc)], [[tc], 'paid']);
check('…taking the pita it waited for', qty(PITA), 0);
check('…and not taking the four that already left a second time',
  [qty(ALMOND), qty(PUMPKIN), qty(SUNFLOWER), qty(CRISP)], [0, 0, 0, 0]);

/* THE EXCUSE IS NARROW, AND THE AND IS THE CAREFUL HALF. Only a product that
   BOTH left and was already taken off the count is excused. A line the §58
   hold-back deliberately did not commit on that dispatch — batch-made, split
   across the box that went and one still here — is still owed to the shelf, so
   it stays gated. */
check('the release excuses only what left AND was already taken',
  /goneOut\.has\(pid\) && alreadyTaken\.has\(pid\)/.test(INV), true);
// A parked order with nothing shipped is UNCHANGED, which §136's operator park
// depends on: its stock is committed but entirely still in the building, and
// re-checking it is the whole point of that park.
const plain = mkOrder([[ALMOND, 1]], { parkedOn: [ALMOND] });
check('an order with no parcel out has nothing excused',
  [...inventory.orderShippedOutPids(plain)], []);
check('…so a shelf that cannot cover it does not release it',
  [inventory.checkAwaitingRestockForRestock({ storeId: STORE, productId: ALMOND }), statusOf(plain)],
  [[], 'awaiting_restock']);

// §180 — a PACKED box counts as gone here: packing is when the stock comes off
// the count, and it is not going back on the shelf for another order.
const packedOrder = mkOrder([[CRISP, 1]], { parkedOn: [CRISP] });
const packedBox = mkParcel(packedOrder, 'land', [CRISP]);
db.prepare("UPDATE retail_shipments SET prepared_at = '2026-09-19 09:00:00' WHERE id = ?").run(packedBox);
check('a packed box counts as out of the building for the release',
  [...inventory.orderShippedOutPids(packedOrder)], [CRISP]);

// ─────────────────────────────────────────────────────────────────────────────
section('── 5. Both screens, and the one number they gate on');

check('the payload ships a per-parcel held count',
  /held_lines: parcelHeldLines\(id, s\.id, waitingPids\)/.test(ROUTES), true);
check('the desktop drawer admits a parked order',
  /'dispatched', 'awaiting_restock'\]\.includes\(o\.status\)/.test(DESKTOP), true);
check('…gated on that parcel not being short',
  /!\(s\.held_lines > 0\) &&/.test(DESKTOP), true);
check('the phone admits it on the same two conditions',
  /'dispatched','awaiting_restock'\]\.includes\(o\.rawStatus\)[\s\S]{0,120}!\(sp\.held_lines>0\)/.test(MOBILE), true);
check('…and carries the number through its own parcel mapping',
  /held_lines:sp\.held_lines\|\|0/.test(MOBILE), true);
/* ONE NUMBER, NOT TWO. The hold pill used to count the parcel's waiting lines
   itself. Left that way it would read "Held — 1 line waiting" beside a live
   dispatch button the moment the two derivations disagreed — the same screen
   giving two answers about one box. */
check('the hold pill reads the server count rather than recounting the items',
  /const held = \(waiting && waiting\.size && state === 'pending'\) \? \(s\.held_lines \|\| 0\) : 0;/
    .test(DESKTOP), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 6. A cancel does not credit the shelf with what has gone');

/* 'dispatched' is not in cancelled.prev precisely because a cancel reverses the
   whole order's stock. 'awaiting_restock' IS in it, on a comment saying a parked
   order has no committed stock — true of the original checkout park, false since
   §136's operator park, and false in a new way here: a parked order can now have
   a box that is packed or gone. */
/* §191 MOVED THIS RULE INTO reverseOrderStockStillHere AND THE CANCEL NOW CALLS
   IT. The assertion follows the code rather than being deleted: what §187
   guarantees is that a cancel cannot credit the shelf with units that have
   gone, and that is still true — it is just enforced in one place for five
   callers instead of inline for one. */
check('the reversal knows how many units have left',
  /const gone = orderShippedQty\(orderId\);/.test(ROUTES), true);
check('…and the cancel reaches it through the shared scoping helper',
  /reverseOrderStockStillHere\(id, null, \{ \.\.\.actor, note: reason \|\| null \}\)/.test(ROUTES), true);
/* UNITS, NOT IDS. A product on BOTH parcels of a split order — one unit gone,
   one on the bench — is the case a set of ids gets wrong: it drops the whole
   product and the unit still here is never returned. Silent, and on the order
   least likely to be looked at again. */
check('…and subtracts them rather than dropping the whole product',
  /qty: r\.qty - \(gone\.get\(r\.product_id\) \|\| 0\)/.test(ROUTES), true);
/* AN EMPTY LIST IS NOT "REVERSE NOTHING" to reverseOrderStock — it falls through
   to reverseCommittedOrder, which reverses the WHOLE order. This is the sharpest
   edge in the section and the one a later refactor is most likely to file off. */
/* AN EMPTY LIST IS NOT "REVERSE NOTHING" to reverseOrderStock — it falls through
   to reverseCommittedOrder, which reverses the WHOLE order. §187 called this the
   sharpest edge in its branch; §191 gave it five callers, so it matters more,
   not less. */
check('…and skips the call entirely rather than passing an empty list',
  /if \(!lines\.length\) return;\s*\n\s*reverseOrderStock\(orderId, \{ lines, \.\.\.opts \}\);/.test(ROUTES), true);
check('…which the stale "no committed stock to reverse" note no longer claims',
  /there's no\s*\n?\s*\/\/ committed stock to reverse/.test(ROUTES), false);

// The real predicate, on the real fixture: the land box left, the air box did
// not. SUNFLOWER was ordered ×2 and both units rode the land box, so the count
// is what it is rather than one-per-product.
check('what has gone is the shipped box, counted in units',
  [...routes.orderShippedQty(tc).entries()].sort((a, b) => a[0] - b[0]),
  [[SUNFLOWER, 2], [ALMOND, 1], [PUMPKIN, 1], [CRISP, 1]].sort((a, b) => a[0] - b[0]));
check('…so the pita, still here, is what a cancel would put back',
  routes.orderShippedQty(tc).has(PITA), false);

/* THE SPLIT-PRODUCT CASE, which a set of ids gets wrong and a count gets right.
   One crisp in the box that went, one on the bench: exactly one comes back. */
const split = mkOrder([[CRISP, 2]], { parkedOn: [PITA] });
const splitGone = mkParcel(split, 'land', []);
const splitHere = mkParcel(split, 'air', []);
db.prepare('INSERT INTO retail_order_items (order_id, product_id, qty, options_json, shipment_id) VALUES (?,?,?,?,?)')
  .run(split, CRISP, 1, '[]', splitGone);
db.prepare('UPDATE retail_order_items SET qty = 1, shipment_id = ? WHERE order_id = ? AND shipment_id IS NULL')
  .run(splitHere, split);
shipParcel(splitGone);
check('a product split across a gone box and a parked one counts only the gone units',
  routes.orderShippedQty(split).get(CRISP), 1);

// ─────────────────────────────────────────────────────────────────────────────
section('── 7. The decision is on the record');

/* CLAUDE.md's rule, asserted rather than trusted: architectural decisions are
   written down before the code that depends on them. A reader who finds this
   window widened and wants to know why has one place to look. */
const DECIDE = read('docs/tacet-consolidation-decisions.md');
check('§187 is recorded', /\*\*§187 · A PARKED ORDER IS PARKED ON PRODUCTS, NOT ON PARCELS/.test(DECIDE), true);
check('…and names the order it was reported from', /TC000784/.test(DECIDE), true);
// The four things the section commits to, so a later reader cannot quietly drop
// one and leave the entry describing code that no longer exists.
check('…and states all four consequences it turns on',
  ['MUST NOT LEAVE ITS PARK', 'MUST HOLD THE SHORT LINES BACK',
   'MUST NOT BE GATED ON WHAT HAS LEFT', 'FOUND RATHER THAN DESIGNED']
    .filter((t) => !DECIDE.includes(t)), []);
/* §193 OVERRIDES ONE OF §187's CLAIMS, so the override has to be as findable as
   the claim. §187's entry is historical and says in so many words that the JD
   route is deliberately not widened; a reader who greps this file for "JD
   waybill" and stops at the first hit gets last week's answer. */
check('§193 is recorded', /\*\*§193 · A PARKED ORDER'S OTHER BOX GETS ITS JD LABEL/.test(DECIDE), true);
check('…and says it reverses §187 rather than quietly differing from it',
  /THIS REVERSES A DECISION §187 MADE EXPLICITLY/.test(DECIDE), true);
check('…and states the two things only this route can get wrong',
  ['THE PARK SURVIVES THE LABEL', 'SECOND DOOR'].filter((t) => !DECIDE.includes(t)), []);
// The Chinese is declared where every other string on this screen is declared.
const VOCAB = read('docs/tacet-delivery-vocabulary.md');
check('…and the error sentence is declared with its provenance',
  /该包裹正在等待补货。/.test(VOCAB) && /\*\*LIFTED\*\*, 2026-09-19/.test(VOCAB), true);
check('…and is the pair the admin dictionary actually ships',
  /parcel_awaiting_restock: \['That parcel is waiting on a restock\.', '该包裹正在等待补货。'\]/
    .test(read('public/retail-admin/01-core.js')), true);

// ── Report ──────────────────────────────────────────────────────────────────
db.close();
try { fs.unlinkSync(dbPath); } catch {}

for (const r of results) {
  if (r.heading) { console.log('\n' + r.heading); continue; }
  if (r.ok) console.log('  PASS  ' + r.name);
  else console.log('  FAIL  ' + r.name + '\n        expected ' + JSON.stringify(r.expected)
    + '\n        actual   ' + JSON.stringify(r.actual));
}
const total = results.filter((r) => !r.heading).length;
console.log(`\n${total - failures}/${total} passed`);
if (SABOTAGE) {
  console.log(failures ? 'SABOTAGE: the suite went red, as it must.'
    : 'SABOTAGE: the suite stayed GREEN — it is not testing what it claims.');
  process.exit(failures ? 0 : 1);
}
process.exit(failures ? 1 : 0);
