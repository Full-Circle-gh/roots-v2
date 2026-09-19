#!/usr/bin/env node
/* §186 — the Sales page reads gzgrocery from the order record, and the ledger
   reader is deleted.

   §184 moved the Reports dashboard off `retail_stock_ledger` and FLAGGED this
   screen, which carried the identical flaw on its own endpoint. This is that
   change. A ledger row has no price, so its value was looked up LIVE on every
   request — change a gz price and yesterday's card moved — and it is dated by
   when the daemon wrote the row rather than by the order, which on a TODAY card
   decides whether a sale shows at all.

   THE FUNCTION IS GONE, NOT MERELY UNUSED. With both callers moved,
   `guanyiPickupSales()` had none; an unused revenue reader is one the next
   session finds and calls, and calling it is the defect §184 and §186 removed.

   WHAT SURVIVES, AND WHY THAT IS NOT VESTIGIAL. `guanyi_pickup_log` holds drift
   pickups with no order behind them. `scripts/guanyi-daemon.js` STILL WRITES IT;
   only `GUANYI_PICKUP_MODE` (default `off`) decides whether it does. So the fold
   is dormant, not dead, and dropping it would under-report silently the day that
   switch is turned on. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DAEMON = fs.readFileSync(path.join(ROOT, 'scripts', 'guanyi-daemon.js'), 'utf8');
const financeWindow = require(path.join(ROOT, 'lib', 'finance-window'));

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const TZ = '+8 hours';
const TODAY = '2026-08-10';
const SALES = (() => {
  const at = ROUTE.indexOf("router.get('/api/retail-admin/sales/summary'");
  assert.ok(at > 0, 'the sales summary route moved');
  return ROUTE.slice(at, ROUTE.indexOf('\nrouter.', at + 10));
})();

/** The card's own aggregate, with its interpolations resolved. */
function storeAggSql(whereChan) {
  const m = SALES.match(/const storeAgg = \(whereChan\) => tdb\(\)\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the storeAgg helper moved');
  return m[1]
    .replace(/\$\{whereChan\}/g, whereChan)
    .replace(/\$\{PAID\}/g, financeWindow.PAID)
    .replace(/\$\{PDATE\}/g, `date(COALESCE(paid_at, placed_at), '${TZ}')`);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    fulfillment_type TEXT, paid_at DATETIME, placed_at DATETIME,
    replacement_for_order_id INTEGER);
`);
[[1, 'delivered', 'gzgrocery', 500],
 [2, 'delivered', 'gzgrocery', 300],
 [3, 'cancelled', 'gzgrocery', 999],   // a reversed mirror — out by the allow-list
 [4, 'paid', 'wechat', 100],
].forEach(([id, st, ch, t]) => db.prepare(
  `INSERT INTO retail_orders (id,status,channel,total,paid_at)
   VALUES (?,?,?,?,'${TODAY} 03:00:00')`).run(id, st, ch, t));

console.log('\n1 · the gzgrocery card is an order-record read');

it('it uses storeAgg on the channel, like every other card here', () => {
  assert.match(SALES, /const gy = storeAgg\("channel='gzgrocery'"\)/,
    'the card is not reading the order rows');
});

it('the figures are the mirror rows, cancellations excluded', () => {
  const row = db.prepare(storeAggSql("channel='gzgrocery'")).get(TODAY);
  assert.strictEqual(row.revenue, 800, '500 + 300');
  assert.strictEqual(row.orders, 2, 'the reversed mirror must not count');
  assert.strictEqual(row.aov, 400);
});

it("the 4th metric is UNITS now, not a count of ledger rows", () => {
  // It was `gy.lines` — ledger ROWS — under the heading the mini app, web and
  // POS cards all fill with units sold.
  assert.match(SALES, /const gyItems = storeItems\("o\.channel='gzgrocery'"\)/,
    'the units read is missing');
  assert.ok(!/extra: gy\.lines/.test(SALES), 'the card still reports ledger rows as its 4th metric');
});

console.log('\n2 · the ledger reader is deleted, not merely unused');

it('guanyiPickupSales is gone from the route', () => {
  assert.ok(!/function guanyiPickupSales/.test(ROUTE),
    'the ledger reader is still defined — the next session will call it');
  assert.ok(!/guanyiPickupSales\(/.test(codeOnly(ROUTE)),
    'something still calls the ledger reader');
});

it('no revenue on this page is valued off the stock ledger', () => {
  assert.ok(!/retail_stock_ledger/.test(codeOnly(SALES)),
    'the Sales page is valuing the ledger again');
});

console.log('\n3 · the drift fold survives, because it is dormant and not dead');

it('the card still folds the legacy drift reader', () => {
  assert.match(SALES, /guanyiLegacyPickupSales\(tdb\(\), today, today\)/,
    'drift revenue would vanish the day GUANYI_PICKUP_MODE is switched on');
});

it('drift lifts REVENUE only — never the order count or the AOV', () => {
  // An inferred pickup is not an order. Folding it into `orders` would divide
  // real money by a count that never happened.
  assert.match(SALES, /const gyAov = \+Number\(gy\.aov \|\| 0\)\.toFixed\(2\)/,
    'the AOV is being computed from drift-inflated revenue');
  assert.match(SALES, /orders: gy\.orders \|\| 0/, 'drift reached the order count');
});

it('the daemon really does still write that log, and a switch gates it', () => {
  // The claim the fold rests on, asserted against the daemon rather than
  // believed: if this ever stops being true the fold can go, and until then a
  // future reader must not delete it as dead history.
  assert.ok(/INSERT INTO guanyi_pickup_log/.test(DAEMON),
    'nothing writes the drift log any more — the fold can be retired');
  assert.match(DAEMON, /GUANYI_PICKUP_MODE \|\| 'off'/,
    'the mode gate moved; the dormancy claim in §186 needs re-checking');
});

console.log('\n4 · the six buckets are still a partition');

it('Direct still refuses the gzgrocery rows the card now claims', () => {
  const m = SALES.match(/const claimedBy = \(p\) => `\(([\s\S]*?)\)`;/);
  assert.ok(m, 'the residual predicate moved');
  assert.ok(/channel='gzgrocery'/.test(m[1]),
    'gzgrocery would be counted twice — once on its card and once in Direct');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
