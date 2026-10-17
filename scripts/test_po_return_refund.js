#!/usr/bin/env node
// What a supplier actually paid back on a purchase return (§483).
//
// THE CASE THIS WAS BUILT FOR, as Ash put it off RPO-0092: one tableware line
// at ¥47.80 went back to the supplier, the freight could not be refunded, and
// Finance took the whole ¥47.80 off the order with no way to say otherwise.
// The order now carries what came back (po_line_items.return_refund), and the
// part the supplier kept stays in the books under 运费及杂费 Freight & fees.
//
// Run:  node scripts/test_po_return_refund.js
//
// Cases:
//   1. the arithmetic — full value, kept part, the empty box meaning "all of it"
//   2. RPO-0092: a smaller refund keeps the difference in Freight & fees
//   3. an empty refund is the old behaviour exactly — no fee row
//   4. a refund corrected on its own re-posts the books, and is no new return
//   5. the refusals, and that each one writes nothing
//   6. the kept part joins the order's own freight in ONE row
//   7. a caller that says nothing about the refund keeps it
//   8. lowering a return under its stored refund is refused, not clamped
//   9. clearing the return clears the refund
//  10. undo receiving clears it with the counts

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// NEVER data/roots.db — scripts/ is deployed (see test_kitchen_po_copy.js).
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
const cleanup = () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

const db = require(path.join(SCRATCH, 'database.js'));
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}

// The shelf is the real table, as in test_purchase_returns.js: a return still
// has to be honoured by stock before its money is looked at.
const STORES = { 1: { id: 1, name_en: 'Yuexiu', name_cn: '越秀店', is_active: 1 } };
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
const shelfQty = productId => db.prepare(
  'SELECT physical_qty FROM retail_store_stock WHERE store_id = 1 AND product_id = ?'
).get(productId)?.physical_qty ?? 0;
const setShelf = (productId, qty) => db.prepare(`
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1,?,?)
  ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`).run(productId, qty);
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: ({ productId, deltaQty }) => {
    const have = shelfQty(productId);
    const delta = deltaQty < 0 ? -Math.min(have, -deltaQty) : deltaQty;
    setShelf(productId, have + delta);
    return { delta };
  },
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
                             req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });
const { returnValueMinor, keptOnReturnMinor } = require(path.join(ROOT, 'lib/po-returns.js'));

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// RPO-0092's shape: delivered, one pcs of each, tableware is the one going back.
const PO_DATE = '2026-10-05';
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (92,'RPO-0092',?,'Delivered','','retail',1,1)`).run(PO_DATE);
db.prepare("INSERT INTO store_products (id,name_en) VALUES (921,'tableware new location')").run();
db.prepare("INSERT INTO store_products (id,name_en) VALUES (922,'new location shelf')").run();
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,store_product_id,name_en,qty,unit,cost_per_unit,total_cost,
   qty_received,damaged_qty,stock_applied_qty,expense_category,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
insLine.run(1, 92, 921, 'tableware new location', 1, 'pcs', 47.8, 47.8, 1, 0, 1, '餐具 Tableware', 0);
insLine.run(2, 92, 922, 'new location shelf',     1, 'pcs', 100,  100,  1, 0, 1, '设备 Equipment', 1);
setShelf(921, 1);
setShelf(922, 1);

// ── harness ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const line = id => db.prepare('SELECT * FROM po_line_items WHERE id = ?').get(id);
const FEES = '运费及杂费 Freight & fees';
const rows = () => db.prepare('SELECT * FROM expense_entries WHERE po_id = 92 ORDER BY id').all();
const row = cat => rows().find(r => r.category === cat);
const total = () => Math.round(db.prepare(
  'SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries WHERE po_id = 92').get().t * 100) / 100;
const returnEvents = () => db.prepare(
  "SELECT COUNT(*) AS n FROM po_receipts WHERE po_id = 92 AND kind = 'return'").get().n;
const receive = receipts => call('PUT', '/api/retail-admin/purchases/92/receive', { receipts });
// What the desktop sends for the tableware row on Confirm delivery.
const tableware = extra => ({ line_id: 1, qty_received: 1, damaged_qty: 0, ...extra });

async function main() {
  console.log('\n══ 1 · the arithmetic ══');
  eq(returnValueMinor({ returned_qty: 1, cost_per_unit: 47.8 }), 4780, 'one tableware back is worth ¥47.80');
  eq(returnValueMinor({ returned_qty: 0.35, cost_per_unit: 5.98 }), 209, 'a fractional return rounds once, to the fen');
  eq(keptOnReturnMinor({ returned_qty: 1, cost_per_unit: 47.8, return_refund: null }), 0,
     'an empty refund means all of it came back — nothing kept');
  eq(keptOnReturnMinor({ returned_qty: 1, cost_per_unit: 47.8, return_refund: 40 }), 780,
     'a ¥40 refund on ¥47.80 leaves ¥7.80 kept');
  eq(keptOnReturnMinor({ returned_qty: 1, cost_per_unit: 30, return_refund: 40 }), 0,
     'a refund above the value (a later price edit) is never a credit');

  console.log('\n══ 2 · RPO-0092: the freight stays in the books ══');
  eq(total(), 0, 'nothing posted before the first save (the seed wrote no rows)');
  let r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: 40 })]);
  eq(r.status, 200, 'the return with a ¥40 refund is accepted');
  eq(line(1).return_refund, 40, 'the line holds what actually came back');
  eq(row('餐具 Tableware'), undefined, 'the tableware goods row is gone — the unit went back');
  eq(row(FEES) && row(FEES).amount, 7.8, 'the ¥7.80 the supplier kept is under Freight & fees');
  ok(/return not refunded/.test(row(FEES).description), 'and the row says what it is');
  eq(row(FEES).date, PO_DATE, 'dated to the order, like every row of it');
  eq(total(), 107.8, 'the order now costs the shelf plus the freight lost (100 + 7.80)');
  eq(shelfQty(921), 0, 'and the tableware left the shelf');

  console.log('\n══ 3 · an empty refund is the old behaviour ══');
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: null })]);
  eq(r.status, 200, 'clearing the refund box is accepted');
  eq(line(1).return_refund, null, 'the line goes back to "all of it came back"');
  eq(row(FEES), undefined, 'and no fee row is posted');
  eq(total(), 100, 'the whole ¥47.80 came off, exactly as before §483');

  console.log('\n══ 4 · a refund corrected on its own ══');
  const events = returnEvents();
  r = await receive([{ line_id: 1, return_refund: 45 }]);
  eq(r.status, 200, 'a refund-only payload is accepted');
  eq(line(1).return_refund, 45, 'and written');
  eq(line(1).returned_qty, 1, 'the quantity it did not mention stands');
  eq(row(FEES) && row(FEES).amount, 2.8, 'the books followed it (47.80 − 45)');
  eq(returnEvents(), events, 'and no second return was recorded — no unit moved');

  console.log('\n══ 5 · the refusals write nothing ══');
  const before = JSON.stringify([line(1), rows()]);
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: 50 })]);
  eq(r.status, 400, 'a refund above what the returned units cost is refused');
  eq(r.body.error, 'return_refund_exceeds', 'and says which rule');
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: -1 })]);
  eq(r.body.error, 'return_refund_invalid', 'a negative refund is refused');
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: 'abc' })]);
  eq(r.body.error, 'return_refund_invalid', 'so is one that is not a number');
  r = await receive([{ line_id: 2, qty_received: 1, damaged_qty: 0, returned_qty: 0, return_refund: 10 }]);
  eq(r.body.error, 'return_refund_not_applicable', 'a refund on a line with no return is refused');
  eq(JSON.stringify([line(1), rows()]), before, 'and none of the four wrote anything');

  console.log('\n══ 6 · one fee row, not two ══');
  db.prepare('UPDATE purchase_orders SET extra_freight = 12 WHERE id = 92').run();
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed', return_refund: 40 })]);
  eq(r.status, 200, 'saved with the order carrying its own ¥12 freight');
  eq(rows().filter(x => x.category === FEES).length, 1, 'one Freight & fees row');
  eq(row(FEES).amount, 19.8, 'holding the order freight and the kept ¥7.80 together');
  ok(/shipping & fees \+ return not refunded/.test(row(FEES).description), 'and saying both');
  db.prepare('UPDATE purchase_orders SET extra_freight = 0 WHERE id = 92').run();

  console.log('\n══ 7 · a caller that says nothing about the refund keeps it ══');
  r = await receive([tableware({ returned_qty: 1, return_reason: 'not_needed' })]);
  eq(r.status, 200, 'an older client\'s save is accepted');
  eq(line(1).return_refund, 40, 'and the refund it never mentioned is still there');
  eq(row(FEES) && row(FEES).amount, 7.8, 'and so is the kept part');

  console.log('\n══ 8 · lowering a return under its stored refund ══');
  // Two of a ¥10 item, ¥18 refunded; then a caller lowers the return to one
  // without restating the refund. ¥18 back on one ¥10 unit is impossible.
  db.prepare("INSERT INTO store_products (id,name_en) VALUES (923,'cups')").run();
  insLine.run(3, 92, 923, 'cups', 2, 'pcs', 10, 20, 2, 0, 2, '餐具 Tableware', 2);
  setShelf(923, 2);
  r = await receive([{ line_id: 3, qty_received: 2, returned_qty: 2, return_reason: 'quality', return_refund: 18 }]);
  eq(r.status, 200, 'two cups back, ¥18 refunded');
  const cupsBefore = JSON.stringify(line(3));
  r = await receive([{ line_id: 3, qty_received: 2, returned_qty: 1 }]);
  eq(r.status, 400, 'lowering the return to one under an ¥18 refund is refused');
  eq(r.body.error, 'return_refund_exceeds', 'and says which rule');
  eq(JSON.stringify(line(3)), cupsBefore, 'nothing written');

  console.log('\n══ 9 · clearing the return clears the refund ══');
  r = await receive([{ line_id: 3, qty_received: 2, returned_qty: 0, return_reason: null }]);
  eq(r.status, 200, 'the cups return is cleared');
  eq(line(3).return_refund, null, 'and its refund with it');
  eq(rows().filter(x => x.category === FEES).length, 1, 'the tableware fee row is untouched');

  console.log('\n══ 10 · undo receiving clears it with the counts ══');
  r = await call('PUT', '/api/retail-admin/purchases/92/undo-receive');
  eq(r.status, 200, 'the undo is accepted');
  eq(line(1).returned_qty, 0, 'the return is cleared');
  eq(line(1).return_refund, null, 'and so is the refund');
  eq(row(FEES), undefined, 'and no fee is left behind for goods that never arrived');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
