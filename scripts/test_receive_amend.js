#!/usr/bin/env node
// ONE VISIT TO THE RECEIVE SCREEN IS ONE DELIVERY.
//
// The phone's receive screen has no Save button: it writes on a pause as the
// operator answers products, so counting a van in is not one PUT any more, it
// is one per pause in the counting (public/m.html recvFlush).
//
// That collides with the shape of the Received list, which is the thing this
// file exists to protect. That list shows one row per receipt that brought a
// line for the FIRST time (routes/retail-purchasing.js DELIVERY_SQL) — the
// derivation that makes a delivery a van-load rather than a save. Left alone,
// a screen that writes six times would put six deliveries in the journal for
// one van, and the operator would be the only person who knew it was one.
//
// So a save may name the receipt to add its lines to. The first write of a
// visit opens the delivery and answers with its id; every later write names it
// and amends it. The desktop screen passes nothing and is untouched.
//
// The four things that has to get right, one case each:
//   1. an amend adds to the delivery instead of opening another
//   2. a line answered twice in one visit is REPLACED on it, not listed twice
//   3. a save that names nothing still opens its own — the desktop's behaviour
//   4. a named receipt that no longer qualifies opens a new one rather than
//      refusing: a delivery lost at the door is worse than a blemish in the
//      journal, and the desk CAN undo a receive while the door is still counting
//
// Run:  node scripts/test_receive_amend.js

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

const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
const shelf = new Map();
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: ({ productId, deltaQty }) => {
    shelf.set(productId, (shelf.get(productId) || 0) + deltaQty);
    return { delta: deltaQty };
  },
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
                             req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });
// routes/purchases.js is NOT stubbed: recordReceipt is the seam this whole file
// is about, and testing the route against a fiction of it would prove nothing.

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// One placed order, three product lines, nothing received against any of them —
// the shape the phone opens on, so every write below is a first-time line and
// would earn its own row in Received without the amend.
db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
            VALUES (91,'RPO-0091','2026-09-08','Ordered','Green Farm','retail',1,1)`).run();
db.prepare("INSERT INTO store_products (id,name_en) VALUES (911,'Mint'),(912,'Coriander'),(913,'Red lentils')").run();
const insLine = db.prepare(`INSERT INTO po_line_items
  (id,po_id,store_product_id,name_en,sku,qty,unit,cost_per_unit,total_cost,
   qty_received,damaged_qty,stock_applied_qty,expense_category,sort_order)
  VALUES (?,91,?,?,?,?,'kg',1,?,NULL,0,0,'门店进货 Retail stock',?)`);
insLine.run(1, 911, 'Mint',        'HRB-MNT',  5,  5, 0);
insLine.run(2, 912, 'Coriander',   'HRB-COR',  3,  3, 1);
insLine.run(3, 913, 'Red lentils', 'DRY-RLN', 25, 25, 2);

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
const receive = body => call('PUT', '/api/retail-admin/purchases/91/receive', body);
// THE LIST AS THE OPERATOR SEES IT, not a count of receipt rows. Every
// assertion below about "how many deliveries" goes through the real endpoint,
// because the derivation is the whole point and a SELECT COUNT(*) over
// po_receipts would agree with a broken one.
const deliveries = async () => (await call('GET', '/api/retail-admin/receiving/deliveries')).body.data;
const receiptLines = id => db.prepare(
  'SELECT line_id, qty_received, damaged_qty FROM po_receipt_lines WHERE receipt_id = ? ORDER BY line_id').all(id);
const receiptCount = () => db.prepare(
  "SELECT COUNT(*) AS n FROM po_receipts WHERE po_id = 91 AND COALESCE(kind,'receipt') = 'receipt'").get().n;

async function main() {
  console.log('\n══ 1 · the second write amends the delivery the first opened ══');
  // The van is on the step. The operator answers the mint, pauses to find the
  // next box, answers the coriander. Two writes, one van.
  let r = await receive({ receipts: [{ line_id: 1, qty_received: 5, damaged_qty: 0, receipt_reason: null }] });
  eq(r.status, 200, 'the first answer is recorded');
  const visit = r.body.receipt_id;
  ok(Number.isInteger(visit) && visit > 0, 'and the delivery it opened is named back to the screen');
  eq((await deliveries()).length, 1, 'one delivery so far');

  r = await receive({ receipts: [{ line_id: 2, qty_received: 3, damaged_qty: 0, receipt_reason: null }],
                      receipt_id: visit });
  eq(r.status, 200, 'the second answer is recorded');
  eq(r.body.receipt_id, visit, 'onto the SAME delivery');
  eq(receiptCount(), 1, 'no second receipt was opened');
  eq((await deliveries()).length, 1, 'and the list still shows one van, not two');
  eq(receiptLines(visit).length, 2, 'the delivery now holds both lines');
  eq(r.body.receipt_lines, 2, 'and reports the size of the DELIVERY, not of the last write');
  // The lines themselves are booked exactly as an unamended save books them —
  // the amend is about which receipt they hang off, and nothing else.
  eq(db.prepare('SELECT qty_received FROM po_line_items WHERE id = 2').get().qty_received, 3,
     'the arrived count is on the line');
  eq(shelf.get(912), 3, 'and the shelf has the goods');

  console.log('\n══ 2 · a line answered twice in one visit is replaced, not listed twice ══');
  // The operator miscounted the mint: five on the button, four in the crate.
  // The delivery brought four. It did not bring "five, then four".
  r = await receive({ receipts: [{ line_id: 1, qty_received: 4, damaged_qty: 0, receipt_reason: 'short_delivery' }],
                      receipt_id: visit });
  eq(r.status, 200, 'the correction is accepted');
  eq(receiptLines(visit).length, 2, 'the delivery still holds two lines, not three');
  eq(receiptLines(visit).find(l => l.line_id === 1).qty_received, 4, 'and the mint line reads the corrected count');
  eq((await deliveries()).length, 1, 'still one van');
  eq(shelf.get(911), 4, 'the shelf followed the correction down');

  console.log('\n══ 3 · a save that names nothing opens its own — the desktop, unchanged ══');
  // The one behaviour that must NOT change: every desktop save is a delivery,
  // as it always was. This is also the proof that case 1 is the amend working
  // rather than the route having stopped writing receipts at all.
  r = await receive({ receipts: [{ line_id: 3, qty_received: 25, damaged_qty: 0, receipt_reason: null }] });
  eq(r.status, 200, 'it is recorded');
  ok(r.body.receipt_id !== visit, 'on a receipt of its own');
  eq(receiptCount(), 2, 'so there are two receipts now');
  eq((await deliveries()).length, 2, 'and the list shows the second van');

  console.log('\n══ 4 · a named receipt that no longer qualifies opens a new one ══');
  // The desk undoes the receive while the door is still counting, and the next
  // pause names a receipt that is gone. The answer to "I cannot amend that" is
  // never "then nothing is recorded" — a delivery lost at the door is the one
  // failure this screen may not have.
  const before = receiptCount();
  r = await receive({ receipts: [{ line_id: 2, qty_received: 2, damaged_qty: 0, receipt_reason: 'short_delivery' }],
                      receipt_id: 999999 });
  eq(r.status, 200, 'the save is not refused');
  eq(receiptCount(), before + 1, 'it opened a receipt of its own instead');
  eq(db.prepare('SELECT qty_received FROM po_line_items WHERE id = 2').get().qty_received, 2,
     'and the count reached the line, which is what mattered');
  // A receipt on ANOTHER order is refused the same way, and for a sharper
  // reason: amending it would hang this order's boxes off that one's delivery.
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
              VALUES (92,'RPO-0092','2026-09-08','Ordered','Sun Oils','retail',1,1)`).run();
  const other = db.prepare(`INSERT INTO po_receipts (po_id,store_id,scope,actor_label,kind)
                            VALUES (92,1,'retail','someone else','receipt')`).run().lastInsertRowid;
  const n = receiptCount();
  r = await receive({ receipts: [{ line_id: 3, qty_received: 24, damaged_qty: 0, receipt_reason: 'short_delivery' }],
                      receipt_id: other });
  eq(r.status, 200, 'a receipt belonging to another order is not amended');
  eq(receiptCount(), n + 1, 'this order got its own receipt');
  eq(receiptLines(other).length, 0, "and the other order's delivery was left alone");

  server.close();
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(1); });
