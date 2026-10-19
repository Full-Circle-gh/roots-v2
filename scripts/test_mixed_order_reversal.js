#!/usr/bin/env node
'use strict';

// §485 — an order that took stock through BOTH doors gives all of it back.
//
//   node scripts/test_mixed_order_reversal.js
//
// THE BUG THIS PINS, found by the stock-deduction audit of 2026-10-19
// (docs/surveys/stock-deduction-audit-2026-10-19.md, finding 1). An out-of-city
// basket reserves its bought-in lines at checkout — a drink or a jar is 'strict'
// by default — and sends its fresh lines straight to the ledger at 备货 (§58).
// reverseOrderStock tried the hold reverser first and STOPPED the moment it
// returned anything, so on a cancel or a full refund the jar came back and the
// salad never did. A partial refund naming both kinds of line did the same.
//
// AND THE OVER-RETURN THE NAIVE FIX WOULD HAVE MADE. Simply always calling the
// ledger reverser second hands back a held product TWICE on a partial refund:
// the hold reverser returns 1, the ledger then reads still_out as (taken −
// returned) = 1 and returns another. So the fix subtracts what the hold gave
// back, per product, before the ledger is asked, and this suite checks both
// halves: everything comes back, nothing comes back twice.
//
// RUN AGAINST THE REAL FUNCTIONS, extracted from lib/inventory.js and
// routes/retail.js and executed against a throwaway in-memory database. A
// mirror of the arithmetic would pass while the product broke.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── driver: better-sqlite3 where it is built, node:sqlite otherwise ─────────
let openDb;
try {
  const Better = require('better-sqlite3');
  const probe = new Better(':memory:'); probe.close();
  openDb = () => new Better(':memory:');
} catch (e1) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    openDb = () => {
      const raw = new DatabaseSync(':memory:');
      return {
        prepare: (sql) => raw.prepare(sql),
        exec: (sql) => raw.exec(sql),
        transaction: (fn) => (...args) => {
          raw.exec('BEGIN');
          try { const r = fn(...args); raw.exec('COMMIT'); return r; }
          catch (err) { try { raw.exec('ROLLBACK'); } catch {} throw err; }
        },
      };
    };
  } catch (e2) {
    console.error('[test_mixed_order_reversal] no usable SQLite driver.');
    process.exit(2);
  }
}

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}

function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

const ROUTES_SRC = require('./test-support/retail-source').retailSource();
const INV_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'inventory.js'), 'utf8');
const ROUTE_FNS = ['prepareCommitUnreservedOrder', 'freshLinesDeferred', 'batchMadeProductIds',
  'expandStockLines', 'parseBundleItems', 'parcelsStillInTheBuilding', 'orderWaitingPids',
  'reverseOrderStock', 'orderStockLinesForReversal', 'reverseOrderStockStillHere', 'orderShippedQty'];
const INV_FNS = ['sumActiveReservations', 'getAvailable', 'reserveForOrder', 'commitOrderReservations',
  'commitUnreservedOrder', 'reverseCommittedOrder', 'reverseCommittedLines', 'reverseCommittedLedger'];
const rs = {}; for (const n of ROUTE_FNS) rs[n] = extractFn(n, ROUTES_SRC);
const is = {}; for (const n of INV_FNS) is[n] = extractFn(n, INV_SRC);
const missing = [...ROUTE_FNS.filter((n) => !rs[n]), ...INV_FNS.filter((n) => !is[n])];
check('every function under test was found in its source (extraction is intact)', missing, []);

const db = openDb();
db.exec(`
  CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, fulfillment_type TEXT,
    store_id INTEGER, channel TEXT, awaiting_restock_pids TEXT, source TEXT);
  CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER,
    options_json TEXT, shipment_id INTEGER, refunded_qty INTEGER);
  CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    prepared_at DATETIME, dispatched_at DATETIME, delivered_at DATETIME);
  CREATE TABLE store_products (id INTEGER PRIMARY KEY, bundle_items TEXT, is_batch_made INTEGER DEFAULT 0,
    ship_from_supplier INTEGER DEFAULT 0, name_en TEXT, name_cn TEXT);
  CREATE TABLE retail_store_stock (store_id INTEGER, product_id INTEGER, physical_qty INTEGER NOT NULL DEFAULT 0,
    safety_buffer INTEGER DEFAULT 0, wechat_quota INTEGER, meituan_quota INTEGER, updated_at DATETIME,
    UNIQUE(store_id, product_id));
  CREATE TABLE retail_stock_ledger (id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER, delta INTEGER,
    reason TEXT, ref_table TEXT, ref_id INTEGER, balance_after INTEGER, actor_user_id INTEGER, actor_label TEXT,
    channel TEXT, note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE retail_stock_reservations (id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER,
    order_id INTEGER, qty INTEGER, channel TEXT, status TEXT, expires_at DATETIME, created_at DATETIME,
    committed_at DATETIME, released_at DATETIME);
`);

// A jar the shop buys in ('strict', so it reserves at checkout even when the
// stock gate is off) and a salad the kitchen makes (batch-made, held back by
// §58 until 备货). A box wrapping two salads, for the bundle case.
const JAR = 700, SALAD = 310, BOX = 900, STORE = 1;
const mkProduct = db.prepare('INSERT INTO store_products (id, bundle_items, is_batch_made, name_en) VALUES (?,?,?,?)');
mkProduct.run(JAR, null, 0, 'Jar');
mkProduct.run(SALAD, null, 1, 'Salad');
mkProduct.run(BOX, JSON.stringify([{ id: SALAD, qty: 2 }]), 0, 'Box');
const setStock = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)');
setStock.run(STORE, JAR, 10);
setStock.run(STORE, SALAD, 10);
const qty = (pid) => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(STORE, pid).q;
const ledger = (id) => db.prepare(
  'SELECT product_id p, delta d, reason r FROM retail_stock_ledger WHERE ref_table = ? AND ref_id = ? ORDER BY id'
).all('retail_orders', id).map((x) => `${x.p}:${x.d}:${x.r}`);

if (!missing.length) {
  const inventory = new Function('db', `
    const tdb = () => db;
    const enqueueChannelSync = () => {};
    const _bumpStockLive = () => {};
    const _reportBelowZero = () => {};
    const ttlMinutes = () => 15;
    ${INV_FNS.map((n) => is[n]).join('\n')}
    return { ${INV_FNS.join(', ')} };
  `)(db);
  const routes = new Function('db', 'inventory', 'isCounter', `
    const tdb = () => db;
    ${ROUTE_FNS.map((n) => rs[n]).join('\n')}
    return { ${ROUTE_FNS.join(', ')} };
  `)(db, inventory, require(path.join(ROOT, 'lib', 'fulfilment')).isCounter);

  let next = 100;
  // An out-of-city delivery order: the strict line reserves at checkout, the
  // paid transition commits it and holds the fresh line back, 备货 takes the
  // fresh line to the ledger. This is the shape markOrderPaid and PATCH /status
  // leave behind, made here directly.
  function mixedOrder(lines, strictPids) {
    const id = ++next;
    db.prepare("INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel) VALUES (?,?,'pending_payment','delivery',?,'wechat')")
      .run(id, 'TC' + id, STORE);
    for (const [pid, n] of lines) {
      db.prepare("INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,'[]')").run(id, pid, n);
    }
    const strict = lines.filter(([pid]) => strictPids.includes(pid)).map(([pid, n]) => ({ product_id: pid, qty: n }));
    if (strict.length) inventory.reserveForOrder({ storeId: STORE, orderId: id, items: strict, channel: 'wechat' });
    db.prepare("UPDATE retail_orders SET status = 'paid' WHERE id = ?").run(id);
    inventory.commitOrderReservations(id);
    routes.prepareCommitUnreservedOrder(id, { actorLabel: 'Auto · paid', atPayment: true });
    db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(id);
    routes.prepareCommitUnreservedOrder(id, { actorLabel: '备货' });
    return id;
  }

  // ── 1. Full cancel: both halves come back ───────────────────────────────
  {
    const o = mixedOrder([[JAR, 1], [SALAD, 1]], [JAR]);
    check('1a. the two doors were both used (one hold row, one ledger row)',
      ledger(o), ['700:-1:order_commit', '310:-1:order_prepare']);
    check('1b. shelf after 备货', [qty(JAR), qty(SALAD)], [9, 9]);
    const r = routes.reverseOrderStock(o, { actorLabel: 'cancel', note: 'cancel' });
    check('1c. the jar AND the salad are back on the shelf', [qty(JAR), qty(SALAD)], [10, 10]);
    check('1d. the ledger says so, once each',
      ledger(o).slice(2), ['700:1:order_reverse', '310:1:order_reverse_ledger']);
    check('1e. the result counts both halves', r.reversed, 2);
    // A second cancel (a retry, or a refund after a cancel) returns nothing more.
    routes.reverseOrderStockStillHere(o, null, { actorLabel: 'cancel again', note: 'retry' });
    check('1f. a second pass returns nothing', [qty(JAR), qty(SALAD)], [10, 10]);
  }

  // ── 2. Partial refund naming both kinds of line: exact, no over-return ──
  {
    const o = mixedOrder([[JAR, 2], [SALAD, 2]], [JAR]);
    check('2a. shelf after 备货', [qty(JAR), qty(SALAD)], [8, 8]);
    routes.reverseOrderStockStillHere(o, [{ product_id: JAR, qty: 1 }, { product_id: SALAD, qty: 1 }],
      { actorLabel: 'refund', note: 'partial' });
    check('2b. one jar and one salad back, not two jars', [qty(JAR), qty(SALAD)], [9, 9]);
    check('2c. ledger: the hold returned the jar, the ledger returned the salad',
      ledger(o).slice(2), ['700:1:order_reverse_partial', '310:1:order_reverse_ledger']);
    // The remainder, as the cancel-after-partial branch computes it.
    routes.reverseOrderStockStillHere(o, [{ product_id: JAR, qty: 1 }, { product_id: SALAD, qty: 1 }],
      { actorLabel: 'refund', note: 'rest' });
    check('2d. the rest comes back and the order is square', [qty(JAR), qty(SALAD)], [10, 10]);
    routes.reverseOrderStockStillHere(o, [{ product_id: JAR, qty: 1 }, { product_id: SALAD, qty: 1 }],
      { actorLabel: 'refund', note: 'over-ask' });
    check('2e. asking for more than was taken returns nothing', [qty(JAR), qty(SALAD)], [10, 10]);
  }

  // ── 3. The ordinary shapes are untouched ────────────────────────────────
  {
    // Hold-only (a same-day order): reversed by the hold reverser, ledger silent.
    const o = mixedOrder([[JAR, 1]], [JAR]);
    routes.reverseOrderStockStillHere(o, null, { actorLabel: 'cancel', note: 'cancel' });
    check('3a. a hold-only order still reverses under order_reverse alone',
      ledger(o), ['700:-1:order_commit', '700:1:order_reverse']);
    // Ledger-only (nothing strict): reversed by the ledger reverser alone.
    const p = mixedOrder([[SALAD, 1]], []);
    routes.reverseOrderStockStillHere(p, null, { actorLabel: 'cancel', note: 'cancel' });
    check('3b. a ledger-only order still reverses under order_reverse_ledger alone',
      ledger(p), ['310:-1:order_prepare', '310:1:order_reverse_ledger']);
    check('3c. shelf square after both', [qty(JAR), qty(SALAD)], [10, 10]);
  }

  // ── 4. A bundle line on a partly-held order ─────────────────────────────
  {
    // The box's two salads go to the ledger at 备货 (they are batch-made); the
    // jar is held. A partial refund of the BOX names the bundle id, which no
    // hold row carries — before §485 the hold reverser returned nothing for it
    // and that was the end; now the ledger half returns its components.
    const o = mixedOrder([[JAR, 1], [BOX, 1]], [JAR]);
    check('4a. shelf after 备货', [qty(JAR), qty(SALAD)], [9, 8]);
    routes.reverseOrderStockStillHere(o, [{ product_id: BOX, qty: 1 }], { actorLabel: 'refund', note: 'box' });
    check('4b. refunding the box returns its two salads and not the jar', [qty(JAR), qty(SALAD)], [9, 10]);
  }
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      got ${JSON.stringify(r.actual)}\n      want ${JSON.stringify(r.expected)}`}`);
}
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
