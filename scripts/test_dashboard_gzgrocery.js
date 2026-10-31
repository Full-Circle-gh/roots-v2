#!/usr/bin/env node
/* §184 — gzgrocery is read from the ORDER RECORD on the Reports dashboard, and
   the stock-ledger valuation beside it is gone.

   WHAT WAS WRONG. scripts/gzgrocery-order-daemon.js writes TWO records for one
   order, in one branch, always together: a `retail_stock_ledger` row (reason
   `gzgrocery_order`) and a display mirror in `retail_orders`. Finance reads the
   mirror. The dashboard excluded the mirror from every revenue SUM and folded
   `guanyiPickupSales()` back in instead — which values the LEDGER, and a ledger
   row carries no price, so the figure was looked up LIVE on each request. Change
   a gz price and a past month's reported revenue moved. The two screens were two
   readings of one channel.

   WHAT IS ASSERTED. The route's own SQL, sliced out and run — never
   transcribed, because a test carrying its own copy of a formula goes on passing
   after the route's copy changes.

   THE LEGACY HALF IS THE POINT OF THE SPLIT. `guanyi_pickup_log` holds drift
   pickups inferred before the order read existed; they have no order behind them
   to mirror, so deleting the fold outright would have deleted real history. The
   suite proves that half survives and that it no longer reaches for the ledger. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const financeWindow = require(path.join(ROOT, 'lib', 'finance-window'));

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = codeOnly(ROUTE);

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const TZ = '+8 hours';
const PAID_ALL = financeWindow.PAID;
const PDATE = `date(COALESCE(paid_at, placed_at), '${TZ}')`;
// Resolved even though the shipped query no longer uses it, ON PURPOSE: if the
// CASE ever comes back, the slice below must still RUN so the assertion fails on
// the number it produces. A placeholder left unbound would blow up in SQLite
// instead, and a suite that reports a crash where it means "the figure is wrong
// again" teaches the next reader to distrust it.
const NOTGZ = "COALESCE(channel,'') != 'gzgrocery'";
const FROM = '2026-08-01', TO = '2026-08-31';

/** The dashboard's own headline query, with its interpolations resolved. */
function shippedKpiSql() {
  const m = ROUTE.match(/const kpiSql = `([\s\S]*?)`;/);
  assert.ok(m, 'the dashboard headline query is no longer where the test reads it');
  return m[1].replace(/\$\{PAID_ALL\}/g, PAID_ALL)
    .replace(/\$\{PDATE\}/g, PDATE)
    .replace(/\$\{NOTGZ\}/g, NOTGZ);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    customer_id INTEGER, fulfillment_type TEXT,
    paid_at DATETIME, placed_at DATETIME, replacement_for_order_id INTEGER);
`);
[// id  status       channel      total  customer
  [1, 'paid',      'wechat',    1000, 11],
  [2, 'paid',      'meituan',    400, 12],
  [3, 'delivered', 'gzgrocery',  500, null],   // the mirror — excluded before §184
  [4, 'delivered', 'gzgrocery',  300, null],
  [5, 'cancelled', 'gzgrocery',  999, null],   // a voided mirror, out by PAID_ALL
].forEach(([id, st, ch, t, cid]) => db.prepare(
  `INSERT INTO retail_orders (id,status,channel,total,customer_id,paid_at,placed_at)
   VALUES (?,?,?,?,?,'2026-08-10 03:00:00',NULL)`).run(id, st, ch, t, cid));

console.log('\n1 · the headline reads gzgrocery off the order record');

const kpi = db.prepare(shippedKpiSql()).get(FROM, TO);

it('a gzgrocery mirror order is INSIDE the revenue headline', () => {
  // 1000 + 400 + 500 + 300 = 2200. Before §184 this read 1400 and the missing
  // 800 came back from the ledger, valued at today's price instead of the
  // order's own.
  assert.strictEqual(kpi.revenue, 2200, 'gzgrocery is missing from the headline');
});

it('a cancelled mirror is out, by the shared allow-list and not by channel', () => {
  assert.ok(kpi.revenue !== 2200 + 999, 'a voided gzgrocery mirror was counted');
  assert.strictEqual(kpi.orders, 4);
});

it('AOV and the headline finally describe ONE set of rows', () => {
  // `orders` counted gzgrocery mirrors all along (PAID_ALL), so an AOV that
  // skipped them was a mean over a different population than its own
  // denominator. Now revenue ÷ orders and the AVG agree exactly.
  assert.strictEqual(+kpi.aov.toFixed(2), +(kpi.revenue / kpi.orders).toFixed(2));
});

console.log('\n2 · the ledger valuation is gone from this route');

it('the dashboard folds the LEGACY reader, never guanyiPickupSales', () => {
  const dash = ROUTE_CODE.slice(ROUTE_CODE.indexOf("router.get('/api/retail-admin/dashboard'"));
  const body = dash.slice(0, dash.indexOf("router.get('", 10));
  assert.ok(!/guanyiPickupSales\(/.test(body),
    'the dashboard is valuing the stock ledger again — that is the §184 defect');
  assert.ok(/guanyiLegacyPickupSales\(/.test(body),
    'the legacy drift fold is gone, which deletes pre-order-read history');
});

it('no revenue SUM on this route blanks gzgrocery any more', () => {
  const dash = ROUTE_CODE.slice(ROUTE_CODE.indexOf("router.get('/api/retail-admin/dashboard'"));
  const body = dash.slice(0, dash.indexOf("router.get('", 10));
  assert.ok(!/SUM\(CASE WHEN \$\{NOTGZ\} THEN total/.test(body),
    'a revenue SUM still excludes the mirror rows the headline now counts');
});

it('the channel breakdown reads the SAME rows the headline summed', () => {
  const m = ROUTE.match(/const channelRows = tdb\(\)\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the channel breakdown query moved');
  assert.ok(/\$\{PAID_ALL\}/.test(m[1]),
    'the breakdown still excludes gzgrocery while the total includes it');
});

console.log('\n3 · the legacy half survives, and reaches for nothing else');

const LEGACY_SRC = (() => {
  const at = ROUTE.indexOf('function guanyiLegacyPickupSales');
  assert.ok(at > 0, 'the legacy reader is gone');
  return ROUTE.slice(at, ROUTE.indexOf('\nfunction ', at + 10));
})();

it('it reads guanyi_pickup_log and NOT the stock ledger', () => {
  assert.ok(/guanyi_pickup_log/.test(LEGACY_SRC), 'the legacy source is not read');
  assert.ok(!/retail_stock_ledger/.test(codeOnly(LEGACY_SRC)),
    'the ledger is back in the fold — the double valuation returns');
});

it('drift pickups still carry revenue, so old history is not deleted', () => {
  const ldb = new Database(':memory:');
  ldb.exec(`
    CREATE TABLE guanyi_pickup_log (
      id INTEGER PRIMARY KEY, product_id INTEGER, action TEXT, resolution TEXT,
      inferred_pickup REAL, drift REAL, created_at DATETIME);
    CREATE TABLE store_products (id INTEGER PRIMARY KEY, sell_price REAL);
  `);
  ldb.prepare('INSERT INTO store_products VALUES (1, 25)').run();
  ldb.prepare(`INSERT INTO guanyi_pickup_log (product_id,action,resolution,inferred_pickup,drift,created_at)
               VALUES (1,'decremented',NULL,4,NULL,'2026-08-10 03:00:00')`).run();
  // The shipped function, lifted and run against a real database.
  // eslint-disable-next-line no-new-func
  // The slice carries the comment block that follows the function, and those are
  // `//` lines — so the return MUST start on a line of its own or it is swallowed
  // by the last of them and the lift silently yields undefined.
  const fn = new Function('shopSqlShift',
    `${LEGACY_SRC}\nreturn guanyiLegacyPickupSales;`)(() => TZ);
  const out = fn(ldb, FROM, TO, {});
  assert.strictEqual(out.revenue, 100, '4 units × ¥25 of drift went missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
