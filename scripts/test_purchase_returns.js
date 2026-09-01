#!/usr/bin/env node
// Purchase returns — goods that arrived, were accepted, and went BACK.
//
// THE CASE THIS WAS BUILT FOR, in the words it was asked in: the flour arrived
// on the 25th, today is the 1st, it is the wrong thing and it is going back to
// the supplier. Before returns existed the only way to record that was to edit
// the arrived count down to zero — which asserts the flour never turned up,
// contradicts the receipt that says it did, and afterwards cannot be told apart
// from a supplier who never shipped. docs/purchase-returns.md is the design
// record; this file is the proof.
//
// The four things a return has to get right, and each is a case below:
//   • the money is RESTATED, not doubled — one set of expense rows, rewritten
//     in place, still dated to the purchase rather than to the return
//   • the shelf gives the units back, through the same delta mechanism a
//     corrected count uses, and REFUSES rather than clamps when it cannot
//   • the 发票 chase stops asking for goods we no longer have, and reports the
//     credit when a 发票 was already recorded for them
//   • a return is its OWN event in the record, never a correction to the
//     delivery it takes back
//
// Run:  node scripts/test_purchase_returns.js
//
// Cases:
//   1. the arithmetic — JS and SQL agree, on every shape of line
//   2. a return comes off the shelf and off the books, in one save
//   3. the books are RESTATED: one row per category, dated to the PO
//   4. the return is its own event, and the delivery is untouched
//   5. a material line — money moves, no stock does
//   6. the refusals, and that each one writes NOTHING
//   7. a shelf too short refuses the whole save
//   8. a caller that says nothing about returns changes nothing about them
//   9. the 发票 chase nets the return and reports the credit
//  10. re-saving the same figure is a no-op, not a second return
//  11. undo receiving clears the return with the counts

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

// THE SHELF IS THE REAL TABLE, not a Map — planReturnRemoval() reads
// retail_store_stock through tdb() to decide whether a return can be honoured,
// so a stub holding its own counter would let every return pass and case 7 could
// never be reached. Only adjustStock is stubbed, and it moves the same rows the
// planner reads. It CLAMPS AT ZERO exactly as lib/inventory.js does, which is
// the behaviour the refusal exists to keep out of the data.
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
const shelfQty = productId => db.prepare(
  'SELECT physical_qty FROM retail_store_stock WHERE store_id = 1 AND product_id = ?'
).get(productId)?.physical_qty ?? 0;
const setShelf = (productId, qty) => db.prepare(`
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1,?,?)
  ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`).run(productId, qty);
let stockCalls = 0;
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: ({ productId, deltaQty }) => {
    stockCalls++;
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
// routes/purchases.js is NOT stubbed here, unlike test_undo_receive_clears.js.
// recordReceipt is where a return becomes its own event, and planReturns is
// shared by both receive endpoints — stubbing that module would test the retail
// route against a fiction of the very seam this feature is built on. Only its
// price write-back is silenced, by seeding no ingredient price history for it
// to compare against.
const { billableQty, onHandQty, acceptedQty, billableQtySql } = require(path.join(ROOT, 'lib/po-returns.js'));

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// One order, placed and delivered on 25 August, holding both kinds of line —
// because the two halves of a return part company exactly there: a product line
// moves stock and money, a material line moves only money.
const PO_DATE = '2026-08-25';
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (90,'RPO-0090',?,'Delivered','Handan Chuanglan','retail',1,1)`).run(PO_DATE);
db.prepare("INSERT INTO store_products (id,name_en) VALUES (901,'Buckwheat Noodles')").run();
db.prepare("INSERT INTO ingredients (id,name_en,buy_unit) VALUES (801,'Pure Buckwheat Flour','kg')").run();
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,store_product_id,ingredient_id,name_en,sku,qty,unit,cost_per_unit,total_cost,
   qty_received,damaged_qty,stock_applied_qty,expense_category,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// A PRODUCT line: 20 ordered, 15 arrived, none damaged, 15 on the shelf.
insLine.run(1, 90, 901, null, 'Buckwheat Noodles', 'P-1', 20, 'pcs', 4, 80, 15, 0, 15, '门店进货 Retail stock', 0);
// A MATERIAL line: the flour itself. 15 kg ordered and 15 arrived, no shelf.
insLine.run(2, 90, null, 801, 'Pure Buckwheat Flour', 'M-1', 15, 'kg', 5.98, 89.7, 15, 0, 0, '厨房物料 Kitchen materials', 1);
// A third line nothing has been received against, for the refusal in case 6.
// NOTE it still bills at its ORDERED quantity — a placed order books what it
// asked for until a delivery says otherwise — which is why the expense totals
// below are 20 higher than the two delivered lines alone.
insLine.run(3, 90, 901, null, 'Buckwheat Noodles', 'P-1', 5, 'pcs', 4, 20, null, 0, 0, '门店进货 Retail stock', 2);
// A fourth, for the reason refusals in case 6, which need a line that has
// received something and returned nothing — a line that already carries a
// reason would inherit it and there would be nothing to refuse. Priced at zero
// so it cannot move a total any other case asserts on, and material so it
// cannot move the shelf.
insLine.run(4, 90, null, 801, 'Flour sample', 'M-2', 4, 'kg', 0, 0, 4, 0, 0, '样品 Samples', 3);
setShelf(901, 15);
// The delivery that brought them in, so the return has something to be a
// separate event FROM.
db.prepare(`INSERT INTO po_receipts (id,po_id,store_id,scope,actor_label,received_at,kind)
            VALUES (7,90,1,'retail','shun','2026-08-25 07:10:00','receipt')`).run();
const insRL = db.prepare(`INSERT INTO po_receipt_lines (receipt_id,line_id,qty_received,damaged_qty)
                          VALUES (?,?,?,?)`);
insRL.run(7, 1, 15, 0);
insRL.run(7, 2, 15, 0);

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
const po = () => db.prepare('SELECT * FROM purchase_orders WHERE id = 90').get();
const expenseRows = () => db.prepare('SELECT * FROM expense_entries WHERE po_id = 90 ORDER BY id').all();
const expenseTotal = () => db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries WHERE po_id = 90').get().t;
const receipts = kind => db.prepare(
  "SELECT * FROM po_receipts WHERE po_id = 90 AND COALESCE(kind,'receipt') = ? ORDER BY id").all(kind);
const round2 = n => Math.round(n * 100) / 100;
// Every save the desktop receive screen makes re-sends every row, which is what
// makes the present-vs-absent rule worth testing at all.
const receive = body => call('PUT', '/api/retail-admin/purchases/90/receive', body);

async function main() {
  console.log('\n══ 1 · the arithmetic — JS and SQL agree ══');
  // The two must not drift: Finance sums in SQL, the 发票 chase sums in JS, and
  // a purchase worth one figure on one screen and another on the next is the
  // defect this whole shared module exists to close.
  const shapes = [
    { qty: 20, qty_received: 15, damaged_qty: 0, returned_qty: 5 },
    { qty: 20, qty_received: 15, damaged_qty: 2, returned_qty: 3 },
    { qty: 20, qty_received: null, damaged_qty: 0, returned_qty: 0 },
    { qty: 20, qty_received: 4, damaged_qty: 4, returned_qty: 0 },
  ];
  const sqlBillable = db.prepare(`SELECT ${billableQtySql()} AS q FROM po_line_items WHERE id = ?`);
  let agreed = true;
  for (const sh of shapes) {
    db.prepare('UPDATE po_line_items SET qty=?, qty_received=?, damaged_qty=?, returned_qty=? WHERE id = 3')
      .run(sh.qty, sh.qty_received, sh.damaged_qty, sh.returned_qty);
    if (sqlBillable.get(3).q !== billableQty(sh)) agreed = false;
  }
  ok(agreed, 'billableQtySql and billableQty give the same answer on every shape');
  eq(billableQty({ qty: 20, qty_received: 15, damaged_qty: 0, returned_qty: 5 }), 10,
     'billable = arrived − returned');
  eq(billableQty({ qty: 20, qty_received: 15, damaged_qty: 2, returned_qty: 3 }), 12,
     'damaged units are still billed — pre-existing, and returns do not change it');
  eq(onHandQty({ qty_received: 15, damaged_qty: 2, returned_qty: 3 }), 10,
     'on the shelf = arrived − damaged − returned');
  eq(acceptedQty({ qty_received: 15, damaged_qty: 2 }), 13, 'accepted = arrived − damaged');
  eq(acceptedQty({ qty_received: null }), null, 'a line with no delivery has accepted nothing, not zero');
  eq(billableQty({ qty: 20, qty_received: null, returned_qty: 0 }), 20,
     'nothing received yet still bills at the ordered quantity');
  // Put line 3 back to untouched — case 6 needs it to have received nothing.
  db.prepare('UPDATE po_line_items SET qty=5, qty_received=NULL, damaged_qty=0, returned_qty=0 WHERE id = 3').run();

  console.log('\n══ 2 · a return comes off the shelf and off the books ══');
  let r = await receive({ receipts: [
    { line_id: 1, qty_received: 15, damaged_qty: 0, returned_qty: 5, return_reason: 'quality' },
  ] });
  eq(r.status, 200, 'the return is accepted');
  eq(r.body.returned_lines, 1, 'one line returned');
  eq(r.body.returned_units, 5, 'five units went back');
  eq(line(1).returned_qty, 5, 'the line records the return');
  eq(line(1).return_reason, 'quality', 'and why');
  ok(!!line(1).returned_at, 'and when — which is NOT the order date');
  eq(line(1).qty_received, 15, 'the arrived count is untouched — the goods did turn up');
  eq(shelfQty(901), 10, 'the shelf gave the units back (15 → 10)');
  eq(line(1).stock_applied_qty, 10, 'and the line agrees with the shelf');

  console.log('\n══ 3 · the books are RESTATED, not doubled ══');
  // Retail stock: 10 noodles kept × 4 = 40, plus the undelivered line still
  // billing at its ordered 5 × 4 = 20 → 60. Materials: 15 kg × 5.98 = 89.70.
  // Total 149.70, where before the return it was 160.
  const rows = expenseRows();
  eq(rows.length, 2, 'two expense rows — one per category, not one per event');
  eq(round2(expenseTotal()), 149.7, 'the total is the purchase less the 20 that went back');
  eq(round2(rows.find(x => x.category === '门店进货 Retail stock').amount), 60,
     'and it is the RETURNED line that moved — 40 kept plus 20 not yet delivered');
  ok(rows.every(x => x.date === PO_DATE),
     'and every row is still dated to the ORDER, not to the day of the return');
  ok(!rows.some(x => (x.amount || 0) < 0), 'no negative credit row was appended — the rows were rewritten');

  console.log('\n══ 4 · the return is its own event ══');
  const rets = receipts('return');
  eq(rets.length, 1, 'one return record');
  const retLines = db.prepare('SELECT * FROM po_receipt_lines WHERE receipt_id = ?').all(rets[0].id);
  eq(retLines.length, 1, 'covering the one line that moved, not every line sent');
  eq(retLines[0].returned_qty, 5, 'and holding the units that left ON THIS EVENT');
  eq(retLines[0].receipt_reason, 'quality', 'a return row carries the RETURN reason, not a shortfall reason');
  // TWO receipt rows, and the second is not the return. The desktop screen
  // re-sends every arrived count on every save, and recordReceipt has always
  // treated a re-asserted count as a receipt in its own right ("the save did
  // re-assert those numbers" — routes/purchases.js). That is pre-existing and
  // orthogonal to returns; what matters here is that the return did NOT become
  // one of them.
  eq(receipts('receipt').length, 2, 'the save re-asserted its arrived counts, as any save does');
  ok(receipts('receipt').every(x => x.kind !== 'return'), 'and neither of those rows is the return');
  eq(db.prepare('SELECT qty_received FROM po_receipt_lines WHERE receipt_id = 7 AND line_id = 1').get().qty_received, 15,
     'and the delivery still says 15 arrived');
  r = await call('GET', '/api/retail-admin/purchases/90/receipts');
  eq(r.body.data.deliveries.length, 2, 'both events are listed against the order');
  const journal = r.body.data.deliveries.map(d => d.kind);
  ok(journal.includes('receipt') && journal.includes('return'), 'and they are told apart by kind');
  const retRow = r.body.data.deliveries.find(d => d.kind === 'return');
  eq(JSON.stringify(retRow.flags), '["returned"]',
     'a return is flagged as a return and nothing else — never as the delivery’s shortfall');
  eq(retRow.returned_units, 5, 'and it reports what left');

  console.log('\n══ 5 · a material line — money moves, no stock does ══');
  const callsBefore = stockCalls;
  r = await receive({ receipts: [
    { line_id: 2, qty_received: 15, damaged_qty: 0, returned_qty: 15, return_reason: 'wrong_item' },
  ] });
  eq(r.status, 200, 'the flour goes back');
  eq(line(2).returned_qty, 15, 'all 15 kg of it');
  eq(stockCalls, callsBefore, 'no stock call was made — a material line has no shelf');
  eq(round2(expenseTotal()), 60, 'but the books lost the whole 89.70 it cost (149.70 → 60)');
  eq(expenseRows().length, 1, 'and the category that is now worth nothing dropped out entirely');

  console.log('\n══ 6 · the refusals, and that each writes nothing ══');
  const before = JSON.stringify([line(1), line(2), line(3), line(4), shelfQty(901), expenseTotal()]);
  r = await receive({ receipts: [{ line_id: 3, qty_received: null, returned_qty: 2, return_reason: 'quality' }] });
  eq(r.status, 400, 'a return against a line that has received nothing is refused');
  eq(r.body.error, 'return_before_receipt', 'and says which rule');
  r = await receive({ receipts: [{ line_id: 1, qty_received: 15, returned_qty: 99, return_reason: 'quality' }] });
  eq(r.status, 400, 'more than was accepted is refused');
  eq(r.body.error, 'return_exceeds_received', 'and says which rule');
  r = await receive({ receipts: [{ line_id: 4, qty_received: 4, returned_qty: 2 }] });
  eq(r.status, 400, 'a return with no reason is refused');
  eq(r.body.error, 'return_reason_required', 'and says which rule');
  r = await receive({ receipts: [{ line_id: 4, qty_received: 4, returned_qty: 2, return_reason: 'because' }] });
  eq(r.status, 400, 'a reason that is not one of the five is refused');
  eq(r.body.error, 'return_reason_invalid', 'and says which rule');
  r = await receive({ receipts: [{ line_id: 4, qty_received: 4, returned_qty: 0, return_reason: 'quality' }] });
  eq(r.status, 400, 'a reason with no return is refused');
  eq(r.body.error, 'return_reason_not_applicable', 'and says which rule');
  // The one a client that has never heard of returns can provoke: lowering the
  // arrived count below what has already gone back.
  r = await receive({ receipts: [{ line_id: 1, qty_received: 3 }] });
  eq(r.status, 400, 'an arrived count below what was already returned is refused');
  eq(r.body.error, 'return_exceeds_received', 'and says which rule');
  eq(JSON.stringify([line(1), line(2), line(3), line(4), shelfQty(901), expenseTotal()]), before,
     'and not one of those six refusals wrote anything at all');
  // The other half of the reason rule, and the reason the refusal above needed
  // a fresh line: a caller that moves only the QUANTITY of a return that
  // already has a reason keeps that reason rather than being refused for it.
  r = await receive({ receipts: [{ line_id: 1, qty_received: 15, returned_qty: 4 }] });
  eq(r.status, 200, 'a quantity-only change to an explained return is allowed');
  eq(line(1).return_reason, 'quality', 'and keeps the reason it already carried');
  r = await receive({ receipts: [
    { line_id: 1, qty_received: 15, returned_qty: 5, return_reason: 'quality' }] });
  eq(line(1).returned_qty, 5, 'put back to 5 for the cases below');

  console.log('\n══ 7 · a shelf too short refuses the whole save ══');
  // 10 noodles are on the shelf and 10 are booked to the line. Sell 8, then try
  // to send 5 back: adjustStock would clamp at 2 and record 5.
  setShelf(901, 2);
  const beforeShort = JSON.stringify([line(1), expenseTotal(), shelfQty(901)]);
  const returnsBefore = receipts('return').length;
  r = await receive({ receipts: [
    { line_id: 1, qty_received: 15, damaged_qty: 0, returned_qty: 10, return_reason: 'quality' },
  ] });
  eq(r.status, 409, 'the return is refused');
  eq(r.body.error, 'return_blocked', 'and says why');
  ok(Array.isArray(r.body.blocking) && r.body.blocking[0].short === 3,
     'naming the product and how far short the shelf is');
  eq(JSON.stringify([line(1), expenseTotal(), shelfQty(901)]), beforeShort,
     'and nothing was written — the line, the books and the shelf all stand');
  eq(receipts('return').length, returnsBefore, 'and no return event was recorded for it');
  setShelf(901, 10);

  console.log('\n══ 8 · a caller that says nothing about returns changes nothing ══');
  // The mobile receive screen sends arrived and damaged counts and has never
  // heard of returned_qty. It must not wipe a return recorded at the desk.
  r = await receive({ receipts: [{ line_id: 1, qty_received: 15, damaged_qty: 0 }] });
  eq(r.status, 200, 'the save is accepted');
  eq(line(1).returned_qty, 5, 'and the return it never mentioned is still there');
  eq(line(1).return_reason, 'quality', 'reason included');
  eq(shelfQty(901), 10, 'and the shelf did not move');

  console.log('\n══ 9 · the 发票 chase nets the return and reports the credit ══');
  // A 发票 for the full delivery was recorded before any of it went back — the
  // ordinary way round, and the reason credit_due has to exist.
  db.prepare(`INSERT INTO invoices (id,supplier,date,amount,tenant_id)
              VALUES (11,'Handan Chuanglan','2026-08-26',60,1)`).run();
  db.prepare('INSERT INTO invoice_lines (invoice_id,line_id,allocated_amount) VALUES (11,1,60)').run();
  r = await call('GET', '/api/retail-admin/purchasing/invoices/outstanding');
  const chase = r.body.data.groups.flatMap(g => g.lines).find(l => l.line_id === 1);
  eq(chase.amount, 40, 'the line is chased for what we kept (10 × 4), not what was ordered (20 × 4)');
  eq(chase.outstanding, 0, 'nothing is outstanding on it');
  eq(chase.credit_due, 20, 'and the 20 over-invoiced is reported as a credit the supplier owes');
  eq(r.body.data.totals.credit_due, 20, 'which reaches the totals');
  const flourLine = r.body.data.groups.flatMap(g => g.lines).find(l => l.line_id === 2);
  eq(flourLine.amount, 0, 'the fully returned flour is chased for nothing');

  console.log('\n══ 10 · re-saving the same figure is a no-op ══');
  const retCount = receipts('return').length;
  const shelfBefore = shelfQty(901), totalBefore = round2(expenseTotal());
  r = await receive({ receipts: [
    { line_id: 1, qty_received: 15, damaged_qty: 0, returned_qty: 5, return_reason: 'quality' },
  ] });
  eq(r.status, 200, 'the same save is accepted again');
  eq(receipts('return').length, retCount, 'and records no second return');
  eq(shelfQty(901), shelfBefore, 'the shelf did not move again');
  eq(round2(expenseTotal()), totalBefore, 'and neither did the books');
  eq(line(1).returned_qty, 5, 'the figure is a running total, not an addition');

  console.log('\n══ 11 · undo receiving clears the return with the counts ══');
  r = await call('PUT', '/api/retail-admin/purchases/90/undo-receive');
  eq(r.status, 200, 'the undo is accepted');
  eq(line(1).qty_received, null, 'the arrived count is cleared');
  eq(line(1).returned_qty, 0, 'and so is the return — goods that never arrived cannot have gone back');
  eq(line(1).return_reason, null, 'reason cleared');
  eq(line(1).returned_at, null, 'date cleared');
  eq(receipts('return').length, retCount, 'but the return EVENTS survive — the record is append-only');
  eq(po().status, 'Ordered', 'and the order is back at Sent');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
