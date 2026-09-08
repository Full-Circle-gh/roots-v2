#!/usr/bin/env node
// ONE LINE, TAKEN BACK.
//
// The phone's receive screen records itself on a 1.2s pause (public/m.html
// RECV_PAUSE), and until this change that pause was the end of the road: an
// answer it had carried could not be un-answered, only CORRECTED to zero —
// which is a different statement, demands a shortage reason, and writes
// "nothing arrived" into the delivery journal. The window in which a mis-tap
// could be taken back was 1.2 seconds long. Reported from the floor on
// RPO-0030: press "All 16 arrived", change your mind, press again, and three
// lines stayed checked because the pause had already written them.
//
// So a NULL arrived count on the receive payload is now an undo. It asserts
// this product never came — the same assertion /undo-receive makes about a
// whole order — and it reverses through the same planner, on the same terms.
//
// The six things that has to get right, one case each:
//   1. an answered line books stock and moves the order to Delivered
//   2. clearing that line reverses the stock, clears the counts, and adds NO
//      row to the Received list — an undo is not a delivery
//   3. a REFUSED reversal writes nothing at all, counts included — the promise
//      undoBlocked makes in so many words
//   4. undoing the last recorded line returns the order to Sent, so it comes
//      back to To receive rather than vanishing after a mis-tap
//   5. the receipts keep their own numbers: what was taken and undone is still
//      readable in Receiving
//   6. one payload may undo one line and answer another — which is exactly what
//      the phone sends when the operator corrects themselves mid-count
//
// Run:  node scripts/test_receive_line_undo.js

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

// THE SHELF IS THE REAL TABLE, not a Map — the same reason
// test_undo_receive_clears.js gives. planPOReversal reads retail_store_stock
// through tdb() to decide whether a reversal can be honoured, so a stub holding
// its own counter would let every reversal pass and case 3 could never fail.
// adjustStock CLAMPS at zero here because the real one does; that clamp is the
// whole reason the refusal has to happen before anything is written.
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
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
// routes/purchases.js is NOT stubbed: planReceiptReasons and recordReceipt both
// have to see a null arrived count and do the right thing with it, and a
// fiction of either would prove nothing about the payload the phone sends.

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// One placed order, three product lines, nothing received — the shape the phone
// opens on. Every product is real: retail_store_stock carries a foreign key to
// store_products, so a fake id would make the shelf unreadable.
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (92,'RPO-0092','2026-09-08','Ordered','Green Farm','retail',1,1)`).run();
db.prepare("INSERT INTO store_products (id,name_en) VALUES (921,'Red lentils'),(922,'Goji berries'),(923,'Chickpea flour')").run();
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,store_product_id,name_en,sku,qty,unit,cost_per_unit,total_cost,
   qty_received,damaged_qty,stock_applied_qty,expense_category,sort_order)
  VALUES (?,92,?,?,?,?,'bag',1,?,NULL,0,0,'门店进货 Retail stock',?)`);
insLine.run(1, 921, 'Red lentils',    'C-5',  10, 10, 0);
insLine.run(2, 922, 'Goji berries',   'B-5',   4,  4, 1);
insLine.run(3, 923, 'Chickpea flour', 'D-11',  6,  6, 2);

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
const receive = body => call('PUT', '/api/retail-admin/purchases/92/receive', body);
const line = id => db.prepare('SELECT * FROM po_line_items WHERE id = ?').get(id);
const po = () => db.prepare('SELECT * FROM purchase_orders WHERE id = 92').get();
const receivedLines = () => db.prepare(
  'SELECT COUNT(*) AS n FROM po_line_items WHERE po_id = 92 AND qty_received IS NOT NULL').get().n;
// THE LIST AS THE OPERATOR SEES IT, through the real derivation — a
// SELECT COUNT(*) over po_receipts would agree with a broken one.
const deliveries = async () => (await call('GET', '/api/retail-admin/receiving/deliveries')).body.data
  .filter(d => d.po_id === 92);
const expenses = () => db.prepare(
  'SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries WHERE po_id = 92').get().t;

async function main() {
  console.log('\n══ 1 · an answered line books stock and delivers the order ══');
  let r = await receive({ receipts: [
    { line_id: 1, qty_received: 10, damaged_qty: 1, receipt_reason: null },
    { line_id: 2, qty_received: 4,  damaged_qty: 0, receipt_reason: null },
  ] });
  eq(r.status, 200, 'the save is accepted');
  eq(po().status, 'Delivered', 'the order is Delivered');
  eq(shelfQty(921), 9, '9 good bags of lentils went to the shelf (10 less 1 damaged)');
  eq(shelfQty(922), 4, 'and 4 of goji');
  eq(line(1).stock_applied_qty, 9, 'the line records what it booked');
  eq((await deliveries()).length, 1, 'one delivery is in the Received list');

  console.log('\n══ 2 · clearing a line reverses it, and is NOT a delivery ══');
  const receiptId = (await deliveries())[0].id;
  r = await receive({ receipts: [{ line_id: 1, qty_received: null, damaged_qty: 0, receipt_reason: null }] });
  eq(r.status, 200, 'the undo is accepted');
  eq(r.body.undone_lines, 1, 'and reports the line it reversed');
  eq(r.body.undone_units, 9, 'and the units it put back');
  eq(line(1).qty_received, null, 'the arrived count is cleared');
  eq(line(1).damaged_qty, 0, 'the damaged count goes with it');
  eq(line(1).stock_applied_qty, 0, 'the bookkeeping is zeroed');
  eq(shelfQty(921), 0, 'the 9 bags came off the shelf again');
  eq(shelfQty(922), 4, 'the line nobody touched is untouched');
  eq(line(2).qty_received, 4, 'and still holds its count');
  eq((await deliveries()).length, 1, 'no second row appeared in Received — an undo is not a delivery');
  eq(po().status, 'Delivered', 'the order stays Delivered while a line still claims one');

  console.log('\n══ 3 · a REFUSED reversal writes nothing — counts included ══');
  setShelf(922, 1);                     // sold; the undo needs 4 back
  r = await receive({ receipts: [{ line_id: 2, qty_received: null, damaged_qty: 0, receipt_reason: null }] });
  eq(r.status, 409, 'the undo is refused');
  eq(r.body.error, 'undo_blocked', 'and says why, in the code the screen renders');
  eq(r.body.blocking[0].product_id, 922, 'naming the product that cannot come back');
  eq(line(2).qty_received, 4, 'the arrived count is still there');
  eq(line(2).stock_applied_qty, 4, 'the applied stock is untouched');
  eq(shelfQty(922), 1, 'and nothing was returned to the shelf');
  eq(po().status, 'Delivered', 'the order did not move');

  console.log('\n══ 4 · undoing the last recorded line returns it to Sent ══');
  setShelf(922, 4);
  r = await receive({ receipts: [{ line_id: 2, qty_received: null, damaged_qty: 0, receipt_reason: null }] });
  eq(r.status, 200, 'accepted once the shelf can honour it');
  eq(r.body.status, 'Ordered', 'and says the order has gone back');
  eq(po().status, 'Ordered', 'the order is back at Sent, so it returns to To receive');
  eq(receivedLines(), 0, 'no line reports as received');
  eq(shelfQty(922), 0, 'the goji came off the shelf');
  // 10 + 4 + 6 at 1.00 each: a cleared line re-posts at the ORDERED quantity,
  // which is what a placed-but-undelivered order should carry.
  eq(expenses(), 20, 'the books hold the ordered quantity again');

  console.log('\n══ 5 · the receipts keep their own numbers ══');
  const rl = db.prepare(
    'SELECT line_id, qty_received, damaged_qty FROM po_receipt_lines WHERE receipt_id = ? ORDER BY line_id'
  ).all(receiptId);
  eq(rl.length, 2, 'both receipt lines survive the undo');
  eq(rl[0].qty_received, 10, 'the receipt still knows 10 lentils arrived');
  eq(rl[0].damaged_qty, 1, 'and that 1 was damaged');
  eq((await deliveries()).length, 1, 'the delivery is still readable in Receiving');

  console.log('\n══ 6 · one payload may undo one line and answer another ══');
  // The shape the phone sends when the operator corrects themselves mid-count:
  // the pause carries both the line they took back and the one they just
  // answered, in the same PUT.
  await receive({ receipts: [{ line_id: 1, qty_received: 10, damaged_qty: 0, receipt_reason: null }] });
  eq(shelfQty(921), 10, 'lentils are on the shelf again');
  r = await receive({ receipts: [
    { line_id: 1, qty_received: null, damaged_qty: 0, receipt_reason: null },
    { line_id: 3, qty_received: 6,    damaged_qty: 0, receipt_reason: null },
  ] });
  eq(r.status, 200, 'the mixed save is accepted');
  eq(line(1).qty_received, null, 'the undone line is cleared');
  eq(shelfQty(921), 0, 'and its stock reversed');
  eq(line(3).qty_received, 6, 'the answered line is recorded');
  eq(shelfQty(923), 6, 'and its stock booked, in the same save');
  eq(po().status, 'Delivered', 'the order is Delivered again on the strength of it');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
