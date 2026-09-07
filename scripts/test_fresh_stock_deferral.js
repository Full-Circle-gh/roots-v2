'use strict';

// §58 — a fresh line on an order that is not going out today is deducted when it
// goes out, not when it is paid.
//
//   node scripts/test_fresh_stock_deferral.js
//
// Runs against a THROWAWAY database it creates and deletes itself. It never
// opens the real one, and it does not require ../database (which would).
//
// THE BUG THIS PINS, in the words of the order that found it: TC000578, 空运 to
// 北京, paid, unshipped, going out tomorrow — and its 鲜食 already off the count.
// The kitchen makes that food on the batch day; the shop sold it on exactly that
// promise. Taking it out of today's count says "sold out" to today's shoppers
// over food still sitting in the fridge, and where the shelf is already at zero
// — which the fresh pre-order exemption deliberately permits — the same
// decrement drives physical_qty negative, that path having no availability check
// at all.
//
// AND THE HALF THAT MUST NOT MOVE WITH IT. The 2026-08-31 rule that every paid
// order decrements whatever its address is what stops a shelf-stable jar being
// sold to five out-of-city shoppers off one unit. A jar has no batch behind it.
// So a grocery line on the very same order still decrements at payment, and half
// of these assertions exist to catch a later change that widens the deferral to
// it.
//
// RUN AGAINST THE REAL FUNCTIONS. Both halves of the rule are extracted from the
// live sources and executed here — the route half (which lines are held back)
// from routes/retail.js, the inventory half (the decrement, the reversal, the
// operator's note) from lib/inventory.js. Extraction rather than require()
// because both open the real database at load, which is the one thing this file
// must never do. A mirror would pass while the product broke.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// lib/fulfilment.js is pure — no DB, no network — so the counter-sale exclusion
// is tested through the real predicate rather than a re-spelling of it.
const F = require('../lib/fulfilment');

const dbPath = path.join(os.tmpdir(), `fresh-deferral-${process.pid}.sqlite`);
const db = new Database(dbPath);

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}

// ── Extraction ──────────────────────────────────────────────────────────────
// The dumb-but-loud rule the sibling suites use: a top-level `function NAME(`
// through the first line that starts a `}` in column one. If either file
// reformats, the extraction check below fails by name rather than the
// assertions failing mysteriously.
function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

const ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');
const INVENTORY_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory.js'), 'utf8');

const ROUTE_FNS = ['prepareCommitUnreservedOrder', 'freshLinesDeferred',
  'batchMadeProductIds', 'expandStockLines', 'parseBundleItems'];
const INV_FNS = ['commitUnreservedOrder', 'reverseCommittedLedger',
  'isStockPending', 'hasUndeductedFreshLine'];

const routeSrc = {};
for (const n of ROUTE_FNS) routeSrc[n] = extractFn(n, ROUTES_SRC);
const invSrc = {};
for (const n of INV_FNS) invSrc[n] = extractFn(n, INVENTORY_SRC);

const missing = [...ROUTE_FNS.filter((n) => !routeSrc[n]), ...INV_FNS.filter((n) => !invSrc[n])];
check('every function under test was found in its source (extraction is intact)', missing, []);

// ── Schema: only the columns these assertions read ──────────────────────────
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, fulfillment_type TEXT,
    store_id INTEGER, channel TEXT
  );
  CREATE TABLE retail_order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER,
    options_json TEXT
  );
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, bundle_items TEXT, is_batch_made INTEGER DEFAULT 0,
    ship_from_supplier INTEGER DEFAULT 0
  );
  CREATE TABLE retail_store_stock (
    store_id INTEGER, product_id INTEGER, physical_qty INTEGER NOT NULL DEFAULT 0,
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

// The four products: a salad the kitchen makes, a wrap it also makes (sold out
// on the shelf, which is the case the fresh exemption exists for), a jar it does
// not, and a bundle wrapping the salad — the bundle row itself carrying NO
// batch-made flag, because the flag lives on what the kitchen actually makes.
const SALAD = 310, WRAP = 440, JAR = 700, BOX = 900;
const mkProduct = db.prepare(
  'INSERT INTO store_products (id, bundle_items, is_batch_made) VALUES (?,?,?)');
mkProduct.run(SALAD, null, 1);
mkProduct.run(WRAP, null, 1);
mkProduct.run(JAR, null, 0);
mkProduct.run(BOX, JSON.stringify([{ id: SALAD, qty: 2 }]), 0);

const STORE = 1;
const setStock = db.prepare(
  'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)');
setStock.run(STORE, SALAD, 5);
setStock.run(STORE, WRAP, 0);
setStock.run(STORE, JAR, 3);

const qty = (pid) => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(STORE, pid).q;

let nextOrder = 5000;
function mkOrder(ft, lines, { channel = 'wechat', status = 'paid' } = {}) {
  const id = ++nextOrder;
  db.prepare(
    'INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel) VALUES (?,?,?,?,?,?)'
  ).run(id, 'TC00' + id, status, ft, STORE, channel);
  for (const [pid, n] of lines) {
    db.prepare(
      'INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,?)'
    ).run(id, pid, n, '[]');
  }
  return id;
}

if (!missing.length) {
  const syncCalls = [];
  const inventory = new Function('db', 'syncCalls', `
    const tdb = () => db;
    const enqueueChannelSync = (storeId, productId) => syncCalls.push(storeId + ':' + productId);
    const _bumpStockLive = () => {};
    ${INV_FNS.map((n) => invSrc[n]).join('\n')}
    return { ${INV_FNS.join(', ')} };
  `)(db, syncCalls);

  // isCounter is handed in from the real lib/fulfilment, not re-spelled: the
  // counter exclusion is the one place this rule turns on a fulfilment type, and
  // a private copy of that predicate here is how the two would drift apart.
  const routes = new Function('db', 'inventory', 'isCounter', `
    const tdb = () => db;
    ${ROUTE_FNS.map((n) => routeSrc[n]).join('\n')}
    return { ${ROUTE_FNS.join(', ')} };
  `)(db, inventory, F.isCounter);

  const atPayment = (id) => routes.prepareCommitUnreservedOrder(id, { actorLabel: 'Auto · paid', atPayment: true });
  const atFulfilment = (id) => routes.prepareCommitUnreservedOrder(id, { actorLabel: 'Auto · preparing' });

  // ── 1. The order from the screenshot: one fresh line, one grocery line ─────
  const mixed = mkOrder('delivery', [[SALAD, 1], [JAR, 1]]);
  atPayment(mixed);
  check('at payment the grocery line comes off the shelf and the fresh line does not',
    [qty(JAR), qty(SALAD)], [2, 5]);
  check('the deferred fresh line wrote no ledger row at payment',
    db.prepare("SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ?")
      .get(mixed, SALAD).n, 0);
  // The operator's note has to survive the split, or it vanishes on exactly the
  // orders it was written for: the order now carries a ledger row AND still owes
  // the shelf its fresh half.
  check('a mixed order still reads "stock pending" once its grocery half committed',
    inventory.isStockPending(mixed, 'paid', 'wechat'), true);

  // ── 2. The fresh line lands on the first fulfilment transition ─────────────
  atFulfilment(mixed);
  check('Start preparing takes the fresh line off the shelf',
    [qty(SALAD), qty(JAR)], [4, 2]);
  check('and does not take the grocery line a second time',
    db.prepare("SELECT COALESCE(SUM(delta),0) AS d FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ?")
      .get(mixed, JAR).d, -1);
  check('nothing is owed once both halves committed',
    inventory.isStockPending(mixed, 'paid', 'wechat'), false);
  check('the deferred decrement told the channels when it finally fired',
    syncCalls.includes(STORE + ':' + SALAD), true);

  // ── 3. A counter sale is excluded BY FULFILMENT TYPE ───────────────────────
  // The goods left in the same instant the money arrived. isCounter is the test
  // rather than "has no address", which a counter sale is forbidden to carry —
  // and so is every other address-less order, which is why that would be wrong.
  const till = mkOrder('counter', [[SALAD, 1]], { channel: 'shop' });
  atPayment(till);
  check('a walk-in still takes its fresh unit at payment', qty(SALAD), 3);

  // ── 4. An all-fresh order defers whole, and says so by name ────────────────
  const allFresh = mkOrder('delivery', [[SALAD, 2]]);
  const r4 = atPayment(allFresh);
  check('an order whose every line is fresh commits nothing at payment, by name',
    [r4 && r4.skipped, qty(SALAD)], ['fresh_deferred', 3]);

  // ── 5. THE ZERO CASE, which is the whole reason the rule is narrow ─────────
  // The wrap is sold out. The fresh exemption still lets it be pre-ordered,
  // because the kitchen makes the next batch. Before §58 this decrement ran with
  // no availability check in front of it and put the shelf at -2.
  const sold = mkOrder('delivery', [[WRAP, 2]]);
  atPayment(sold);
  check('a pre-ordered sold-out fresh line does not drive the shelf negative', qty(WRAP), 0);

  // ── 6. A bundle is judged by what the kitchen makes, not by its wrapper ────
  // The BOX row carries no batch-made flag; its component does. The deferral
  // reads the EXPANDED lines, so the salad inside is held back.
  const boxed = mkOrder('delivery', [[BOX, 1]]);
  const r6 = atPayment(boxed);
  check('a bundle of fresh components defers on the components, not the wrapper',
    [r6 && r6.skipped, qty(SALAD)], ['fresh_deferred', 3]);
  atFulfilment(boxed);
  check('and the bundle expands to its component demand when it does commit',
    qty(SALAD), 1);

  // ── 7. A refund of a deferred line returns nothing, without a new flag ─────
  // The cap is arithmetic over the ledger: a line never decremented has nothing
  // still out, so the reverser computes zero. This is asserted rather than
  // assumed because "give it back" is the obvious wrong behaviour here.
  const refunded = mkOrder('delivery', [[SALAD, 1], [JAR, 1]]);
  atPayment(refunded);
  const back = inventory.reverseCommittedLedger(refunded,
    [{ product_id: SALAD, qty: 1 }, { product_id: JAR, qty: 1 }], { note: 'refund (full)' });
  check('refunding before the fresh line ever committed returns the jar alone',
    [back.reversed, qty(JAR), qty(SALAD)], [1, 2, 1]);

  // ── 8. Re-firing at payment cannot double-count the grocery half ──────────
  // markOrderPaid runs twice on a gateway retry, and the admin Mark paid path
  // calls the same helper.
  const retried = mkOrder('delivery', [[JAR, 1]]);
  atPayment(retried);
  atPayment(retried);
  check('a payment retry takes the grocery units once',
    db.prepare("SELECT COALESCE(SUM(delta),0) AS d FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ?")
      .get(retried, JAR).d, -1);

  // ── 9. A reserved fresh line is NOT the deferral's business ───────────────
  // Guangzhou same-day reserves at checkout and commits on payment. Those orders
  // never reach this helper with unreserved lines, and the per-product guard
  // skips a product that holds a reservation even if they do.
  const reserved = mkOrder('delivery', [[SALAD, 1]]);
  db.prepare(
    "INSERT INTO retail_stock_reservations (store_id, product_id, order_id, qty, channel, status) VALUES (?,?,?,?,'wechat','committed')"
  ).run(STORE, SALAD, reserved, 1);
  const r9 = atFulfilment(reserved);
  check('a fresh line that reserved at checkout is left to the reservation path',
    [r9 && r9.skipped, qty(SALAD)], ['reserved', 1]);
  check('and an order holding only reserved lines owes the shelf nothing',
    inventory.isStockPending(reserved, 'paid', 'wechat'), false);
}

// ── The rule as it is spelled at the two call sites ─────────────────────────
// Behaviour above, wiring here: the deferral only reaches production if the paid
// routes actually ask for it, and only those two may.
check('the gateway paid route asks for the deferral',
  /prepareCommitUnreservedOrder\(orderId, \{ actorLabel: 'Auto · paid', atPayment: true \}\)/.test(ROUTES_SRC), true);
check('exactly two call sites pass atPayment — the two ways an order is paid',
  (ROUTES_SRC.match(/atPayment: true/g) || []).length, 2);
check('the fulfilment-transition call sites pass no atPayment at all',
  /\['preparing', 'dispatched', 'delivered'\]\.includes\(status\)[\s\S]{0,240}?prepareCommitUnreservedOrder\(id, \{ actorUserId: req\.user\.id/.test(ROUTES_SRC), true);
// EVERY WAY AN ORDER LEAVES 'paid' MUST TAKE THE HELD-BACK LINES. The two
// auto-deliver sweeps claim straight out of 'paid' (AUTO_DELIVER_FROM_STATUSES),
// so before §58 they never owed a decrement — markOrderPaid had always taken it.
// Now they can be the forward transition for a fresh line, and a sweep that
// closes the order without committing would strand those units on the count with
// nothing left to fire.
check('the ETA auto-deliver sweep commits the stock it closes over',
  /Auto · delivered \(ETA\)/.test(ROUTES_SRC), true);
check('the rider auto-deliver sweep does too',
  /Auto · delivered \(rider\)/.test(ROUTES_SRC), true);
check('both sweeps claim from paid, which is why they owe it',
  /AUTO_DELIVER_FROM_STATUSES = \['paid', 'preparing', 'dispatched', 'rider_pickup'\]/.test(ROUTES_SRC), true);
// The narrow flag, and it is narrow on purpose: oos_policy 'backorder_gz' opens
// any product to out-of-city pre-order, shelf goods included, and a jar opened
// that way has no batch behind it. §58 rule 3.
check('the deferral keys on is_batch_made, not on the broader oos_policy',
  /is_batch_made = 1/.test(extractFn('batchMadeProductIds', ROUTES_SRC) || '')
  && !/oos_policy/.test(extractFn('batchMadeProductIds', ROUTES_SRC) || ''), true);

// ── Report ─────────────────────────────────────────────────────────────────
db.close();
try { fs.unlinkSync(dbPath); } catch (e) { /* best effort */ }
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) {
    console.log(`      expected ${JSON.stringify(r.expected)}`);
    console.log(`      actual   ${JSON.stringify(r.actual)}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
