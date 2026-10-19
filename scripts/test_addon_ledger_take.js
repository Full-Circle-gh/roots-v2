#!/usr/bin/env node
'use strict';

// §488 — an add-on on an order whose stock went straight to the ledger takes
// its units, including one more of a product the order already carried.
//
//   node scripts/test_addon_ledger_take.js
//
// THE BUG THIS PINS, from the stock-deduction audit of 2026-10-19
// (docs/surveys/stock-deduction-audit-2026-10-19.md, finding 4).
// finalizeOrderAddon deducted the add-on only when the order held committed
// reservations — the pre-2026-08-31 reading of "tracks stock". Every paid order
// deducts since then, the out-of-city ones straight to the ledger with no hold,
// so an add-on on one was skipped here; and the per-product guard at the next
// transition then skipped any product the order already carried. One more jar
// on a Beijing order never came off the shelf.
//
// TWO KINDS OF ASSERTION, labelled. BEHAVIOURAL ones run the real helpers,
// extracted from routes/retail.js and lib/inventory.js, against a throwaway
// database. SOURCE ones check that finalizeOrderAddon is wired to the helper in
// the branch where the order holds no reservation — the wiring is the fix, and
// a helper nobody calls is a PASS with nothing behind it.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let openDb;
try {
  const Better = require('better-sqlite3');
  const probe = new Better(':memory:'); probe.close();
  openDb = () => new Better(':memory:');
} catch (e1) {
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
}

let failures = 0;
const results = [];
function check(kind, name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, kind, name, actual, expected });
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
  'addonTakeToLedger', 'orderTracksStock'];
const INV_FNS = ['commitUnreservedOrder', 'commitAddonLines', 'orderCommittedPids', 'reverseCommittedLedger',
  'isStockPending', 'hasUndeductedFreshLine'];
const rs = {}; for (const n of ROUTE_FNS) rs[n] = extractFn(n, ROUTES_SRC);
const is = {}; for (const n of INV_FNS) is[n] = extractFn(n, INV_SRC);
const missing = [...ROUTE_FNS.filter((n) => !rs[n]), ...INV_FNS.filter((n) => !is[n])];
check('SOURCE', 'every function under test was found in its source', missing, []);

// ── SOURCE: the wiring ─────────────────────────────────────────────────────
const fin = extractFn('finalizeOrderAddon', ROUTES_SRC) || '';
check('SOURCE', 'finalizeOrderAddon still reserves+commits for an order that holds reservations',
  /if \(orderTracksStock\(order\.id\)\) \{[\s\S]*?inventory\.commitOrderReservations\(order\.id/.test(fin), true);
check('SOURCE', 'and takes the add-on to the ledger for one that does not',
  /\} else \{\s*\n\s*addonTakeToLedger\(order\.id, stockLines/.test(fin), true);
check('SOURCE', 'the stock block no longer gates the WHOLE deduction on orderTracksStock',
  /if \(orderTracksStock\(order\.id\) && order\.store_id\)/.test(fin), false);

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
const JAR = 700, SALAD = 310, STORE = 1;
db.prepare('INSERT INTO store_products (id, is_batch_made, name_en) VALUES (?,?,?)').run(JAR, 0, 'Jar');
db.prepare('INSERT INTO store_products (id, is_batch_made, name_en) VALUES (?,?,?)').run(SALAD, 1, 'Salad');
db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(STORE, JAR, 10);
db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(STORE, SALAD, 10);
const qty = (pid) => db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id=? AND product_id=?').get(STORE, pid).q;
const ledger = (id) => db.prepare(
  "SELECT product_id p, delta d, reason r FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ? ORDER BY id"
).all(id).map((x) => `${x.p}:${x.d}:${x.r}`);

if (!missing.length) {
  const inventory = new Function('db', `
    const tdb = () => db;
    const enqueueChannelSync = () => {};
    const _bumpStockLive = () => {};
    const _reportBelowZero = () => {};
    ${INV_FNS.map((n) => is[n]).join('\n')}
    return { ${INV_FNS.join(', ')} };
  `)(db);
  const routes = new Function('db', 'inventory', 'isCounter', `
    const tdb = () => db;
    ${ROUTE_FNS.map((n) => rs[n]).join('\n')}
    return { ${ROUTE_FNS.join(', ')} };
  `)(db, inventory, require(path.join(ROOT, 'lib', 'fulfilment')).isCounter);

  let next = 500;
  // An out-of-city delivery order with no strict line, paid: the jar goes to
  // the ledger at payment, the salad waits for 备货 (§58).
  function paidOrder(lines, ft = 'delivery') {
    const id = ++next;
    db.prepare("INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel) VALUES (?,?,'paid',?,?,'wechat')")
      .run(id, 'TC' + id, ft, STORE);
    for (const [pid, n] of lines) {
      db.prepare("INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,'[]')").run(id, pid, n);
    }
    routes.prepareCommitUnreservedOrder(id, { actorLabel: 'Auto · paid', atPayment: true });
    return id;
  }
  // The add-on's lines land on retail_order_items (finalizeOrderAddon inserts
  // them) and then the stock block runs; both halves are done here by hand.
  function addOn(id, lines) {
    for (const [pid, n] of lines) {
      db.prepare("INSERT INTO retail_order_items (order_id, product_id, qty, options_json) VALUES (?,?,?,'[]')").run(id, pid, n);
    }
    const stockLines = routes.expandStockLines(lines.map(([pid, n]) => ({
      product: { id: pid, bundle_items: null }, qty: n, options: [],
    })));
    return routes.addonTakeToLedger(id, stockLines, { actorLabel: 'order add-on' });
  }

  // 1. One more of the same jar on a paid out-of-city order.
  {
    const o = paidOrder([[JAR, 1], [SALAD, 1]]);
    check('BEHAVIOURAL', '1a. at payment the jar is taken and the salad held (§58)', ledger(o), ['700:-1:order_prepare']);
    check('BEHAVIOURAL', '1b. the order holds no reservation, so the old gate said "not tracked"', routes.orderTracksStock(o), false);
    const r = addOn(o, [[JAR, 1]]);
    check('BEHAVIOURAL', '1c. the add-on jar comes off the shelf now', [r.committed, qty(JAR)], [1, 8]);
    check('BEHAVIOURAL', '1d. under order_addon, an order% reason', ledger(o).slice(1), ['700:-1:order_addon']);
    // 备货 — the whole-order commit takes the salad and nothing else.
    db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(o);
    routes.prepareCommitUnreservedOrder(o, { actorLabel: '备货' });
    check('BEHAVIOURAL', '1e. 备货 takes the salad once and does not touch the jar again',
      ledger(o).slice(2), ['310:-1:order_prepare']);
    check('BEHAVIOURAL', '1f. shelf: jar 8, salad 9', [qty(JAR), qty(SALAD)], [8, 9]);
    // A refund of the whole order returns all three units.
    inventory.reverseCommittedLedger(o, [{ product_id: JAR, qty: 2 }, { product_id: SALAD, qty: 1 }], {});
    check('BEHAVIOURAL', '1g. a refund returns the add-on jar too', [qty(JAR), qty(SALAD)], [10, 10]);
  }

  // 2. A fresh add-on on an order still holding its fresh line waits with it.
  {
    const o = paidOrder([[JAR, 1], [SALAD, 1]]);
    const r = addOn(o, [[SALAD, 1]]);
    check('BEHAVIOURAL', '2a. a fresh add-on on a paid order is held back (§58)', [r.skipped, qty(SALAD)], ['fresh_deferred', 10]);
    check('BEHAVIOURAL', '2b. the stock-pending note still shows', inventory.isStockPending(o, 'paid', 'wechat'), true);
    db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(o);
    routes.prepareCommitUnreservedOrder(o, { actorLabel: '备货' });
    check('BEHAVIOURAL', '2c. 备货 takes both salads, the order\'s and the add-on\'s', [qty(SALAD), ledger(o).slice(1)],
      [8, ['310:-2:order_prepare']]);
    inventory.reverseCommittedLedger(o, [{ product_id: JAR, qty: 1 }, { product_id: SALAD, qty: 2 }], {});
  }

  // 3. A fresh add-on on an order already in preparing (its fresh line taken).
  {
    const o = paidOrder([[JAR, 1], [SALAD, 1]]);
    db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(o);
    routes.prepareCommitUnreservedOrder(o, { actorLabel: '备货' });
    check('BEHAVIOURAL', '3a. after 备货 both lines are taken', [qty(JAR), qty(SALAD)], [9, 9]);
    const r = addOn(o, [[SALAD, 1]]);
    check('BEHAVIOURAL', '3b. one more salad on a preparing order is taken now', [r.committed, qty(SALAD)], [1, 8]);
    routes.prepareCommitUnreservedOrder(o, { actorLabel: 'dispatch' });
    check('BEHAVIOURAL', '3c. the later dispatch takes nothing more', [qty(JAR), qty(SALAD)], [9, 8]);
    inventory.reverseCommittedLedger(o, [{ product_id: JAR, qty: 1 }, { product_id: SALAD, qty: 2 }], {});
    check('BEHAVIOURAL', '3d. square after a full refund', [qty(JAR), qty(SALAD)], [10, 10]);
  }
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.name}${r.ok ? '' : `\n      got ${JSON.stringify(r.actual)}\n      want ${JSON.stringify(r.expected)}`}`);
}
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
