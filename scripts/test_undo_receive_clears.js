#!/usr/bin/env node
// Undo receiving clears the arrived counts — and clears nothing else.
//
// An undo asserts THE GOODS NEVER ARRIVED. It used to leave qty_received and
// damaged_qty in place so a re-confirm re-applied the same delta without the
// operator re-typing anything; the cost was an order sitting at Sent with every
// ARRIVED box filled, which reads as fully received (the box shows the ordered
// qty as a grey placeholder when nothing is recorded and a solid value when
// something is). RPO-0001 went to Delivered and back three times on 2026-08-27
// and looked received for days. So the counts now go with the undo.
//
// The three things this has to get right, and each is a separate case below:
//   • the counts really are cleared, and the order stops reporting lines "in"
//   • the RECEIPT survives — po_receipts / po_receipt_lines keep their own copy
//     of every number, so the delivery is still readable in Receiving
//   • a REFUSED reversal still writes nothing at all, counts included — that is
//     what undoBlocked promises in so many words
//     (docs/tacet-delivery-vocabulary.md, LOCKED 2026-08-27)
//
// Run:  node scripts/test_undo_receive_clears.js
//
// Cases:
//   1. a delivered order holds counts, stock and expenses at the received qty
//   2. undo clears qty_received / damaged_qty and returns the order to Sent
//   3. the receipt history is untouched and still reads back its own numbers
//   4. expenses re-post at the ORDERED quantity once the counts are gone
//   5. stock is returned and stock_applied_qty zeroed (unchanged behaviour)
//   6. a reversal refused for want of stock writes NOTHING — the counts stay
//   7. "All arrived as ordered" refills in one click, so nothing is lost for good

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

// THE SHELF IS THE REAL TABLE, not a Map. planPOReversal() reads
// retail_store_stock directly through tdb() to decide whether a reversal can be
// honoured, so a stub holding its own counter would let every reversal pass and
// case 6 — the refusal — could never be reached. Only adjustStock is stubbed,
// and it moves the same rows the planner reads.
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
stub('routes/purchases.js', {
  firePriceAlertsForPO: () => ({ skips: [], landedSkips: [], landedExtras: 0 }),
  allocateLandedExtras: () => ({ perUnit: new Map(), skipped: [], extras: 0, totalGoods: 0 }),
  planReceiptReasons: () => ({ errors: [], plan: [] }),
  recordReceipt: () => ({ receiptId: null }),
  appliedReceiptStore: (_db, po) => po.store_id,
  postPOExpenses: () => ({ skipped: 'stubbed' }),
});

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (70,'RPO-0070','2026-08-27','Delivered','Dikala','retail',1,1)`).run();
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,store_product_id,name_en,sku,qty,unit,cost_per_unit,total_cost,
   qty_received,damaged_qty,stock_applied_qty,expense_category,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// Ordered 5, received 4 with 1 damaged → 3 good units went to the shelf.
insLine.run(1, 70, 900, 'Refined Coconut Oil', 'F-1', 5, 'kg', 27.6, 138, 4, 1, 3, '门店进货 Retail stock', 0);
// A second line, received in full, so the clear has to reach every line.
insLine.run(2, 70, null, 'Dry Blueberries', 'F-2', 3, 'kg', 110, 330, 3, 0, 0, '门店进货 Retail stock', 1);

// The receipt this delivery wrote — its OWN copy of the numbers, which the undo
// must not touch.
// The shelf the delivery landed on. Store id 1 already exists — database.js's
// seed_default_store_v1 migration creates it on a fresh database — so only the
// product and its stock row are seeded here. retail_store_stock carries a
// foreign key to store_products, so the product has to be real.
db.prepare("INSERT INTO store_products (id,name_en) VALUES (900,'Refined Coconut Oil')").run();
setShelf(900, 10);

db.prepare(`INSERT INTO po_receipts (id,po_id,store_id,actor_label,received_at)
            VALUES (5,70,1,'jass','2026-08-27 06:25:00')`).run();
const insRL = db.prepare(`INSERT INTO po_receipt_lines (receipt_id,line_id,qty_received,damaged_qty)
                          VALUES (?,?,?,?)`);
insRL.run(5, 1, 4, 1);
insRL.run(5, 2, 3, 0);

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
const po = () => db.prepare('SELECT * FROM purchase_orders WHERE id = 70').get();
const expenses = () => db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries WHERE po_id = 70').get().t;
const round2 = n => Math.round(n * 100) / 100;
const receivedLines = () => db.prepare(
  'SELECT COUNT(*) AS n FROM po_line_items WHERE po_id = 70 AND qty_received IS NOT NULL').get().n;

async function main() {
  console.log('\n══ 1 · the delivered order, before any undo ══');
  eq(po().status, 'Delivered', 'it is Delivered');
  eq(line(1).qty_received, 4, 'line 1 recorded 4 arrived');
  eq(line(1).damaged_qty, 1, 'and 1 damaged');
  eq(receivedLines(), 2, 'both lines report as received');

  console.log('\n══ 2 · undo clears the counts and returns it to Sent ══');
  let r = await call('PUT', '/api/retail-admin/purchases/70/undo-receive');
  eq(r.status, 200, 'the undo is accepted');
  eq(po().status, 'Ordered', 'the order is back at Sent');
  eq(line(1).qty_received, null, 'line 1 arrived count is cleared');
  eq(line(1).damaged_qty, 0, 'line 1 damaged count is cleared');
  eq(line(2).qty_received, null, 'line 2 is cleared too — every line, not just the stocked one');
  eq(receivedLines(), 0, 'the order no longer reports any line as received');

  console.log('\n══ 3 · the receipt itself is untouched ══');
  const rl = db.prepare('SELECT * FROM po_receipt_lines WHERE receipt_id = 5 ORDER BY line_id').all();
  eq(rl.length, 2, 'both receipt lines survive');
  eq(rl[0].qty_received, 4, 'the receipt still knows 4 arrived');
  eq(rl[0].damaged_qty, 1, 'and that 1 was damaged');
  eq(db.prepare('SELECT COUNT(*) AS n FROM po_receipts WHERE po_id = 70').get().n, 1,
     'the delivery is still in Receiving');

  console.log('\n══ 4 · expenses re-post at the ORDERED quantity ══');
  // 5 × 27.60 + 3 × 110 = 468.00, where the received figures gave 4×27.6 + 3×110.
  eq(round2(expenses()), 468, 'the books hold the ordered quantity, not the received one');

  console.log('\n══ 5 · stock came back and the bookkeeping was zeroed ══');
  eq(shelfQty(900), 7, 'the 3 good units left the shelf again (10 → 7)');
  eq(line(1).stock_applied_qty, 0, 'stock_applied_qty is zeroed');

  console.log('\n══ 6 · a REFUSED reversal writes nothing — counts included ══');
  // Put it back to Delivered with counts and applied stock, then sell the goods
  // so the shelf cannot honour the reversal.
  db.prepare("UPDATE purchase_orders SET status = 'Delivered' WHERE id = 70").run();
  db.prepare('UPDATE po_line_items SET qty_received = 4, damaged_qty = 1, stock_applied_qty = 3 WHERE id = 1').run();
  db.prepare('UPDATE po_line_items SET qty_received = 3 WHERE id = 2').run();
  setShelf(900, 1);                        // only 1 left; the undo needs 3
  r = await call('PUT', '/api/retail-admin/purchases/70/undo-receive');
  eq(r.status, 409, 'the undo is refused');
  eq(r.body.error, 'undo_blocked', 'and says why');
  eq(po().status, 'Delivered', 'the order did NOT move');
  eq(line(1).qty_received, 4, 'the arrived count is still there');
  eq(line(1).damaged_qty, 1, 'the damaged count is still there');
  eq(line(1).stock_applied_qty, 3, 'and the applied stock is untouched');
  eq(shelfQty(900), 1, 'nothing was returned to the shelf');

  console.log('\n══ 7 · the counts are one click away again ══');
  setShelf(900, 10);
  await call('PUT', '/api/retail-admin/purchases/70/undo-receive');
  eq(line(1).qty_received, null, 'cleared again once the shelf allows it');
  // "All arrived as ordered" is puSetStatus('Delivered'), which seeds
  // qty_received = qty on every line — the same path that filled them first.
  r = await call('PUT', '/api/retail-admin/purchases/70/status', { status: 'Delivered' });
  eq(r.status, 200, '"All arrived as ordered" is accepted');
  eq(line(1).qty_received, 5, 'line 1 refilled at the ordered quantity');
  eq(line(2).qty_received, 3, 'line 2 refilled too — nothing has to be retyped');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
