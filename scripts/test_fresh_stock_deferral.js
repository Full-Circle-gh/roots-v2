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
// AND THE SAME BUG ONE ROUTE OVER, 2026-09-11 (§58 ADDENDUM). TC000656 and
// TC000647, 小程序, Tianhe: three wraps and a salad off the count at 18:22 on
// food going out the next day. §58 had said the fresh line decrements at "the
// first forward transition into fulfilment ... a parcel dispatched", which is
// right for one parcel and wrong for two. A split order ships its 陆运 box days
// ahead so it ARRIVES with the 空运 box that carries the food; clicking 发货 on
// the land box handed the whole order to the commit and took the fresh half with
// it — and where the shelf was already at zero, to -1, which is §58's own stated
// failure reappearing through a door it had not looked at.
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

// routes/retail.js and everything moved out of it (decisions §477): expandStockLines
// and parseBundleItems are in lib/bundles.js.
const ROUTES_SRC = require('./test-support/retail-source').retailSource();
const INVENTORY_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory.js'), 'utf8');

const ROUTE_FNS = ['prepareCommitUnreservedOrder', 'freshLinesDeferred',
  'batchMadeProductIds', 'expandStockLines', 'parseBundleItems',
  'parcelsStillInTheBuilding',
  // §187 — the parked-products reader prepareCommitUnreservedOrder calls. Named
  // here rather than stubbed so the hold-back under test is the live one.
  'orderWaitingPids'];
const INV_FNS = ['commitUnreservedOrder', 'reverseCommittedLedger',
  'isStockPending', 'hasUndeductedFreshLine',
  // §491 — what a location's shop makes on the spot. commitUnreservedOrder
  // reads it for a counter sale; named rather than stubbed so the counter case
  // below runs the live one. Owned by test_counter_made_here_stock.js.
  'madeHereProductIds'];

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
    store_id INTEGER, channel TEXT,
    -- §187 — the products a parked order waits on. prepareCommitUnreservedOrder
    -- now reads it to hold those lines back from a parcel dispatch, so a table
    -- without it fails at prepare() rather than at an assertion. The whole
    -- §187 behaviour is owned by test_restock_parcel_dispatch.js; what this
    -- suite needs is the column, and one assertion that the hold-back does not
    -- disturb the §58 rules above.
    awaiting_restock_pids TEXT,
    -- commitUnreservedOrder reads it to tell a replacement parcel from a
    -- Meituan/Eleme order the ingest already deducted. Owned by
    -- test_platform_order_single_deduct.js; here it only has to exist.
    source TEXT
  );
  CREATE TABLE retail_order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER,
    options_json TEXT, shipment_id INTEGER
  );
  CREATE TABLE retail_shipments (
    id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    prepared_at DATETIME,           -- §180 — packed, and still here
    dispatched_at DATETIME, delivered_at DATETIME
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
  -- §491 — madeHereProductIds reads these for a counter sale. Empty here: no
  -- shop, so nothing at this location is made here and every line is a shelf.
  CREATE TABLE shops (id INTEGER PRIMARY KEY, location_id INTEGER);
  CREATE TABLE shop_listings (
    id INTEGER PRIMARY KEY, shop_id INTEGER, store_product_id INTEGER, fulfilment_mode TEXT
  );
`);

// The four products: a salad the kitchen makes, a wrap it also makes (sold out
// on the shelf, which is the case the fresh exemption exists for), a jar it does
// not, and a bundle wrapping the salad — the bundle row itself carrying NO
// batch-made flag, because the flag lives on what the kitchen actually makes.
const SALAD = 310, WRAP = 440, JAR = 700, BOX = 900;
// A second set, for the split-parcel assertions. Their own products so the
// running shelf counts of the four above stay readable line by line.
const SALAD2 = 311, WRAP2 = 441, JAR2 = 701, BOX2 = 901;
// §180's own fresh product, for the two-parked-boxes case. Separate again for
// the same reason: the shelf count below has to stay readable line by line.
const SALAD3 = 312;
const mkProduct = db.prepare(
  'INSERT INTO store_products (id, bundle_items, is_batch_made) VALUES (?,?,?)');
mkProduct.run(SALAD, null, 1);
mkProduct.run(WRAP, null, 1);
mkProduct.run(JAR, null, 0);
mkProduct.run(BOX, JSON.stringify([{ id: SALAD, qty: 2 }]), 0);
mkProduct.run(SALAD2, null, 1);
mkProduct.run(WRAP2, null, 1);
mkProduct.run(JAR2, null, 0);
mkProduct.run(BOX2, JSON.stringify([{ id: SALAD2, qty: 1 }]), 0);
mkProduct.run(SALAD3, null, 1);

const STORE = 1;
const setStock = db.prepare(
  'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)');
setStock.run(STORE, SALAD, 5);
setStock.run(STORE, WRAP, 0);
setStock.run(STORE, JAR, 3);
setStock.run(STORE, SALAD2, 5);
setStock.run(STORE, WRAP2, 0);   // sold out, pre-orderable — the screenshot's wrap
setStock.run(STORE, JAR2, 3);
setStock.run(STORE, SALAD3, 6);   // §180 — two parked boxes share this one

const qty = (pid) => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(STORE, pid).q;

let nextOrder = 5000;
function mkOrder(ft, lines, { channel = 'wechat', status = 'paid', parkedOn = null } = {}) {
  const id = ++nextOrder;
  db.prepare(
    'INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel, awaiting_restock_pids) VALUES (?,?,?,?,?,?,?)'
  ).run(id, 'TC00' + id, status, ft, STORE, channel, parkedOn ? JSON.stringify(parkedOn) : null);
  for (const [pid, n] of lines) {
    db.prepare(
      'INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,?)'
    ).run(id, pid, n, '[]');
  }
  return id;
}

// Parcels. `planShipments` fans a split order into 'air' + 'land'; here the two
// rows are made directly and the items pointed at them, which is what that
// function leaves behind in retail_order_items.shipment_id.
let nextShip = 8000;
function mkParcel(orderId, mode) {
  const id = ++nextShip;
  db.prepare('INSERT INTO retail_shipments (id, order_id, mode) VALUES (?,?,?)').run(id, orderId, mode);
  return id;
}
function putOnParcel(orderId, pid, sid) {
  db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ? AND product_id = ?')
    .run(sid, orderId, pid);
}
// The stamp every parcel-level route writes BEFORE it reaches the commit.
function shipParcel(sid) {
  db.prepare("UPDATE retail_shipments SET dispatched_at = '2026-09-11 18:22:00' WHERE id = ?").run(sid);
}
// §180 — the stamp the PREPARE route writes. A packed box has not left, so it
// keeps dispatched_at NULL; what it stops doing is holding other parcels' fresh
// lines back, because packing it is when its own food came out of the fridge.
function packParcel(sid) {
  db.prepare("UPDATE retail_shipments SET prepared_at = '2026-09-11 09:05:00' WHERE id = ?").run(sid);
}
// The kitchen making the batch. A sold-out fresh line is pre-ordered against a
// named day; on that day the food exists before the parcel leaves.
function addStock(pid, n) {
  db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty + ? WHERE store_id = ? AND product_id = ?')
    .run(n, STORE, pid);
}

if (!missing.length) {
  const syncCalls = [];
  const inventory = new Function('db', 'syncCalls', `
    const tdb = () => db;
    const enqueueChannelSync = (storeId, productId) => syncCalls.push(storeId + ':' + productId);
    const _bumpStockLive = () => {};
    // The below-zero merchant alert, stubbed for the same reason
    // enqueueChannelSync and _bumpStockLive above are: it is an outbound side
    // effect, not the arithmetic this suite is about, and the real one opens a
    // database and a webhook. Its wiring is held by test_batch_owed.js §9c.
    const _reportBelowZero = () => {};
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
  // ONE PARCEL going out, which is what the three parcel-level routes are.
  const atParcel = (id, sid) => routes.prepareCommitUnreservedOrder(id, { actorLabel: 'Auto · parcel', shipmentId: sid });

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

  // ── 10. §58 ADDENDUM — TC000656: the land box leaves, the food stays ──────
  // The order from the 2026-09-11 report. Fresh salad + sold-out fresh wrap ride
  // the 空运 parcel that leaves on the batch day; the jar rides the 陆运 parcel
  // that leaves days earlier so the two arrive together. Clicking 发货 on the
  // land box used to hand the WHOLE order to the commit.
  const split = mkOrder('delivery', [[SALAD2, 1], [WRAP2, 1], [JAR2, 1]]);
  const air  = mkParcel(split, 'air');
  const land = mkParcel(split, 'land');
  putOnParcel(split, SALAD2, air);
  putOnParcel(split, WRAP2,  air);
  putOnParcel(split, JAR2,   land);

  atPayment(split);
  check('a split order still commits its grocery line at payment and holds the kitchen\'s',
    [qty(JAR2), qty(SALAD2), qty(WRAP2)], [2, 5, 0]);

  shipParcel(land);
  const r10 = atParcel(split, land);
  // 'already_committed' and not 'fresh_on_another_parcel': the land box's own
  // jar came off at payment, so what survives the hold-back reaches
  // commitUnreservedOrder and ITS per-product guard answers. The by-name skip is
  // asserted below on a parcel that carries nothing of its own.
  check('the land parcel going out does NOT take the fresh food still in the fridge',
    [r10 && r10.skipped, qty(SALAD2)], ['already_committed', 5]);
  // THE SCREENSHOT'S OWN LINE. Pesto 'Chicken' Wrap read -1 because this path
  // has no availability check in front of it; §58 named that failure and this is
  // the door it came back through.
  check('and it cannot drive a sold-out fresh shelf negative', qty(WRAP2), 0);
  check('the order still reads "stock pending" while its fresh parcel waits',
    inventory.isStockPending(split, 'paid', 'wechat'), true);
  check('nothing was written to the ledger for the waiting fresh lines',
    db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_id = ? AND product_id IN (?,?)')
      .get(split, SALAD2, WRAP2).n, 0);

  // Batch day: the kitchen makes the wrap, then the air box goes.
  addStock(WRAP2, 2);
  shipParcel(air);
  atParcel(split, air);
  check('the fresh lines come off when THEIR parcel goes out',
    [qty(SALAD2), qty(WRAP2)], [4, 1]);
  check('and the grocery line is not taken a second time on the way through',
    db.prepare('SELECT COALESCE(SUM(delta),0) AS d FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ?')
      .get(split, JAR2).d, -1);
  check('nothing is owed once the last parcel has left',
    inventory.isStockPending(split, 'paid', 'wechat'), false);

  // ── §180: PACKING A BOX RELEASES WHAT IT WAS HOLDING BACK ────────────────
  // The reported case, and it only bites when ONE FRESH PRODUCT RIDES BOTH
  // BOXES — the hold-back is whole-product, so before §180 each parked box held
  // that product back on behalf of the other and it settled on NEITHER. It then
  // waited for a dispatch that may be days out, with the food already packed.
  // (A product sitting entirely on one box was the first shape tried here and
  // proves nothing: the other box has none of it to hold back.)
  const both = mkOrder('delivery', [[SALAD3, 1]]);
  const boxA = mkParcel(both, 'air');
  const boxB = mkParcel(both, 'land');
  // A second line of the SAME fresh product, so one unit rides each box.
  db.prepare("INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,1,'[]')")
    .run(both, SALAD3);
  const [rowA, rowB] = db.prepare(
    'SELECT rowid AS r FROM retail_order_items WHERE order_id = ? AND product_id = ? ORDER BY rowid'
  ).all(both, SALAD3).map((x) => x.r);
  const onParcel = db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE rowid = ?');
  onParcel.run(boxA, rowA);
  onParcel.run(boxB, rowB);

  atPayment(both);
  check('§180 — a fresh line riding both parked boxes is held whole at payment', qty(SALAD3), 6);

  // Box B is packed first. Box A is untouched, so ITS unit stays in the fridge —
  // and the hold-back is whole-product, so neither unit moves.
  packParcel(boxB);
  const rB = atParcel(both, boxB);
  check('§180 — packing one box takes nothing while the other is still unpacked',
    [rB && rB.skipped, qty(SALAD3)], ['fresh_on_another_parcel', 6]);
  // Packing did NOT ship it. Every guard asking whether it has left must keep
  // answering no — the reason prepared is a separate axis rather than a fourth
  // value of shipmentState().
  check('§180 — and a packed box has NOT been dispatched',
    db.prepare('SELECT dispatched_at FROM retail_shipments WHERE id = ?').get(boxB).dispatched_at, null);

  // Box A is packed too. Nothing is left in the fridge now, so the count settles
  // WITH NO DISPATCH AT ALL. This is the assertion the whole section exists for:
  // drop `prepared_at IS NULL` from parcelsStillInTheBuilding and box B is still
  // counted as holding its unit back, so this stays at 6 and the shelf lies for
  // as long as both boxes sit there packed.
  packParcel(boxA);
  atParcel(both, boxA);
  check('§180 — packing the last box settles BOTH units, with no dispatch at all',
    qty(SALAD3), 4);
  check('§180 — and the order stops reading "stock pending" once both are packed',
    inventory.isStockPending(both, 'dispatched', 'wechat'), false);

  // The hold-back says so BY NAME when it is the whole of what was asked for.
  // A "(to follow · 后补)" parcel really can carry no items of its own, so this
  // is the shape rather than a contrivance.
  const toFollow = mkOrder('delivery', [[SALAD2, 1]]);
  const tfAir   = mkParcel(toFollow, 'air');
  const tfLater = mkParcel(toFollow, 'land');
  putOnParcel(toFollow, SALAD2, tfAir);
  atPayment(toFollow);
  shipParcel(tfLater);
  const beforeTf = qty(SALAD2);
  const rTf = atParcel(toFollow, tfLater);
  check('a parcel carrying nothing of its own commits nothing, by name',
    [rTf && rTf.skipped, qty(SALAD2) - beforeTf], ['fresh_on_another_parcel', 0]);

  // ── 11. The fresh line on the parcel that IS leaving still commits ────────
  // The deferral is about WHICH box, not about fresh being untouchable: hold
  // back on a parcel dispatch what is not in that parcel, and nothing else.
  const flip = mkOrder('delivery', [[SALAD2, 1], [JAR2, 1]]);
  const fLand = mkParcel(flip, 'land');
  const fAir  = mkParcel(flip, 'air');
  putOnParcel(flip, SALAD2, fLand);   // fresh by ground — Guangdong / Fujian
  putOnParcel(flip, JAR2,   fAir);
  atPayment(flip);
  shipParcel(fLand);
  atParcel(flip, fLand);
  check('the fresh line rides out with the parcel it is actually in', qty(SALAD2), 3);

  // ── 12. One parcel, and the last parcel, both sweep up ────────────────────
  // An order with a single parcel has no "other parcel still here", so a parcel
  // dispatch is the whole order leaving and takes everything — the pre-addendum
  // behaviour, which was correct for exactly this shape and must not regress.
  const solo = mkOrder('delivery', [[SALAD2, 1]]);
  const sOnly = mkParcel(solo, 'land');
  putOnParcel(solo, SALAD2, sOnly);
  atPayment(solo);
  shipParcel(sOnly);
  atParcel(solo, sOnly);
  check('a single-parcel order takes its fresh line when that parcel goes out', qty(SALAD2), 2);

  // ── 13. A bundle on the waiting parcel is held by its COMPONENTS ──────────
  // The wrapper carries no batch-made flag. Reading the order-level ids alone
  // would ship the salad inside it straight off the count.
  const bundled = mkOrder('delivery', [[BOX2, 1], [JAR2, 1]]);
  const bAir  = mkParcel(bundled, 'air');
  const bLand = mkParcel(bundled, 'land');
  putOnParcel(bundled, BOX2, bAir);
  putOnParcel(bundled, JAR2, bLand);
  atPayment(bundled);
  shipParcel(bLand);
  atParcel(bundled, bLand);
  check('a bundle waiting on another parcel is held back on its components',
    qty(SALAD2), 2);
  shipParcel(bAir);
  atParcel(bundled, bAir);
  check('and expands to component demand when its own parcel leaves', qty(SALAD2), 1);

  // ── 14. An UNASSIGNED line is not held back ──────────────────────────────
  // shipment_id NULL means no parcel claims it (an add-on attached before the
  // re-plan ran). It is on no other parcel, so nothing defers it — the
  // pre-addendum behaviour, kept deliberately: this rule only ever moves a line
  // that is demonstrably somewhere else.
  const loose = mkOrder('delivery', [[SALAD2, 1], [JAR2, 1]]);
  const lLand = mkParcel(loose, 'land');
  const lAir  = mkParcel(loose, 'air');
  putOnParcel(loose, JAR2, lLand);     // SALAD2 left unassigned
  atPayment(loose);
  shipParcel(lLand);
  atParcel(loose, lLand);
  check('a line on no parcel at all is committed, not stranded',
    [qty(SALAD2), lAir > 0], [0, true]);

  // ── 15. A whole-order transition still takes everything ──────────────────
  // PATCH /status and the auto-deliver sweeps pass no shipmentId. They are the
  // backstop §58 built and the addendum must not have narrowed them.
  const whole = mkOrder('delivery', [[SALAD2, 1], [JAR2, 1]]);
  const wAir  = mkParcel(whole, 'air');
  putOnParcel(whole, SALAD2, wAir);
  atPayment(whole);
  atFulfilment(whole);
  check('Mark dispatched on the ORDER takes the fresh line whatever its parcel',
    qty(SALAD2), -1);

  /* ── 16. §137 — A WALK-IN CANNOT LEAVE THE SHELF OWING ANYTHING ────────
     Run against the real commit rather than asserted over its source: the
     failure this fixes was ARITHMETIC, and a regex over the function would have
     passed on the broken version. The shape lives in test_batch_owed.js §9d;
     the numbers live here.

     WRAP2 is batch-made — the exact kind of product whose negative the kitchen's
     owed block reads as units to cook.

     THE SHELF IS PINNED RATHER THAN INHERITED. Earlier cases in this block move
     WRAP2, so a fixture that assumed 0 here read whatever they left; the first
     draft did exactly that and asserted a correction of 3 against a shelf of 1.
     Naming the starting count makes the arithmetic below checkable by eye. */
  db.prepare('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = ? AND product_id = ?')
    .run(STORE, WRAP2);
  const counterSale = mkOrder('counter', [[WRAP2, 3]], { channel: 'shop' });
  atFulfilment(counterSale);
  // Three left in a customer's hand, so three were on the shelf: the record was
  // short by three and is now right, rather than owing three that are not owed.
  check('§137: a till sale that outruns the record lands the shelf at zero',
    qty(WRAP2), 0);
  // TWO ROWS, NOT ONE NETTED FIGURE. The sale really happened and the correction
  // really happened; a ledger showing only the difference would answer a
  // different question than the one asked of it.
  const counterRows = db.prepare(
    'SELECT reason, delta FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ? ORDER BY id'
  ).all(counterSale, WRAP2);
  check('…and says so in two rows: the sale, then the correction',
    counterRows.map((r) => `${r.reason}:${r.delta}`), ['order_prepare:-3', 'counter_miscount:3']);

  /* THE OTHER SIDE OF THE SAME COIN, and the case that proves §137 did not
     travel. A DELIVERY that outruns the shelf leaves the negative: those units
     were sold and never held, somebody is waiting for them, and the kitchen is
     supposed to read it. */
  // No reset needed, and that IS the setup: the correction above left WRAP2 at
  // exactly 0, which is where the previous case started.
  const post = mkOrder('delivery', [[WRAP2, 2]]);
  atFulfilment(post);
  check('…while a delivery that outruns it still leaves the honest negative',
    qty(WRAP2), -2);
  const postRows = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_id = ? AND reason = 'counter_miscount'"
  ).get(post).n;
  check('…and writes no correction for it', postRows, 0);

  /* ── 17. §187 — THE PARK HOLDS ITS OWN LINES BACK, AND NOTHING ELSE ──────
     The reason this suite gained `awaiting_restock_pids`. §187 lets a parked
     order send the parcel that carries none of its short lines, and that
     dispatch reaches the very function this file is about. If it committed the
     order whole it would decrement the product the shelf is SHORT of — an
     honest negative (§84) for units nobody picked, which lib/batch-owed.js
     reads as food to cook. The §187 suite owns the routes and the release; what
     is checked here is that the hold-back lands in the commit and stops there.

     JAR2 is not batch-made, so §58's own deferral has nothing to say about it —
     which is the point: before §187 it was the short product that committed
     anyway. */
  db.prepare('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = ? AND product_id = ?')
    .run(STORE, JAR2);
  db.prepare('UPDATE retail_store_stock SET physical_qty = 4 WHERE store_id = ? AND product_id = ?')
    .run(STORE, SALAD3);
  const parked = mkOrder('delivery', [[JAR2, 2], [SALAD3, 1]],
    { status: 'awaiting_restock', parkedOn: [JAR2] });
  const pAir  = mkParcel(parked, 'air');
  const pLand = mkParcel(parked, 'land');
  putOnParcel(parked, JAR2, pAir);
  putOnParcel(parked, SALAD3, pLand);
  shipParcel(pLand);
  atParcel(parked, pLand);
  check('§187: sending the land box of a parked order leaves the short line on the shelf',
    qty(JAR2), 0);
  check('§187: …and takes the line that box actually carries', qty(SALAD3), 3);
  check('§187: …writing no ledger row against the product the order waits on',
    db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_id = ? AND product_id = ?')
      .get(parked, JAR2).n, 0);

  // AND THE PARK IS THE ONLY THING THAT HOLDS IT. The same order, released to
  // 'preparing' the way the operator's "Restocked → Start preparing" does —
  // PATCH /status writes the new status BEFORE it calls the commit — must take
  // the line in full. A hold-back that outlived the park would strand the stock.
  db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(parked);
  db.prepare('UPDATE retail_store_stock SET physical_qty = 5 WHERE store_id = ? AND product_id = ?')
    .run(STORE, JAR2);
  atFulfilment(parked);
  check('§187: once released, the restocked line comes off the shelf in full',
    qty(JAR2), 3);
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
// ── §58 ADDENDUM: EVERY ROUTE THAT ACTS ON ONE PARCEL MUST SAY WHICH ────────
// Behaviour above, wiring here — and this half is the one that actually failed.
// The rule was right and complete; three call sites handed it the ORDER when
// what had left was a parcel. A further such route added later and wired the
// same way fails here rather than on a shelf — which is what happened: §180's
// prepare route is the fourth, and it is the first that acts on a parcel
// WITHOUT shipping it.
// A parcel-level call site is identified by the label in its OWN catch line, and
// the question asked of it is whether the call above that line named a parcel.
// An index scan rather than one long regex: the thing under test is a call-site
// property, and it should read as one.
const parcelSite = (label) => {
  const at = ROUTES_SRC.indexOf("[inventory.prepareCommit (" + label + ")]");
  if (at === -1) return 'no such call site';
  const call = ROUTES_SRC.slice(Math.max(0, at - 400), at);
  const last = call.lastIndexOf('prepareCommitUnreservedOrder(');
  if (last === -1) return 'label has no call before it';
  return /shipmentId: [A-Za-z.]+ \}\)/.test(call.slice(last));
};
check('the parcel-dispatch route names the parcel that left', parcelSite('parcel dispatch'), true);
check('so does the parcel-deliver route', parcelSite('parcel deliver'), true);
check('and minting a JD waybill for one parcel takes one parcel of stock', parcelSite('jd waybill'), true);
// §180 — packing one box is a forward step into fulfilment for THAT box, and
// the first parcel-scoped call site that is not a departure.
check('and packing one box takes one box of stock', parcelSite('parcel prepare'), true);
check('exactly four call sites are parcel-scoped — the ones that act on one box',
  (ROUTES_SRC.match(/shipmentId: [A-Za-z.]+ \}\)/g) || []).length, 4);
// The backstop, stated as a test because the deferral is only ever safe while
// something downstream takes what it held: the whole-order transition passes no
// shipmentId and therefore no parcel can narrow it.
check('the whole-order status transition still takes everything',
  /\['preparing', 'dispatched', 'delivered'\]\.includes\(status\)[\s\S]{0,300}?prepareCommitUnreservedOrder\(id, \{ actorUserId: req\.user\.id, actorLabel: req\.user\.display_name \|\| req\.user\.username \|\| null \}\)/.test(ROUTES_SRC), true);
// The parcel is excluded by ITS OWN STAMP, not by having been passed in: the
// three shipping routes write dispatched_at before they call, so a route that
// forgets to would still be caught by the id test, and vice versa. §180's
// prepare route stamps prepared_at instead and leans on the id test alone —
// which is the reason that test is there rather than implied.
check('a parcel that has already gone out never holds anything back',
  /dispatched_at IS NULL AND delivered_at IS NULL/.test(
    extractFn('parcelsStillInTheBuilding', ROUTES_SRC) || ''), true);

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
