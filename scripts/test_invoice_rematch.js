#!/usr/bin/env node
// Putting a stranded 发票 back on the order that replaced the one it was filed
// against.
//
// scripts/test_invoice_recorded_off_chase.js pins the REPORT — that a 发票 whose
// PO line has left the chase is named rather than silently uncounted. This pins
// the CURE. A buyer copies a kitchen order into Tacet, corrects a quantity,
// places the copy; the original stands down (lib/po-supersede.js) and the 发票
// recorded against its lines is counted nowhere. Re-match moves the allocation
// onto the copy's matching lines, and the money is back in "Fully invoiced".
//
// lib/po-supersede.js declines to do this by itself, on a read, and says why:
// re-attributing line by line "needs the buyer to say which line covers which,
// and that is a screen, not a silent remap." So the shape under test here is
// that split — a plan that writes NOTHING, and an apply that only does what a
// freshly recomputed plan says.
//
// Run:  node scripts/test_invoice_rematch.js
//
// Cases:
//   1. the plan is read-only, pairs on identity, and warns about a credit due
//   2. applying it moves the money onto the copy and empties the strip
//   3. the ledger still holds the invoice whole, now pointing at the copy
//   4. it is idempotent — running it again moves nothing
//   5. a line the copy no longer carries is reported unmatched, never guessed
//   6. an order nothing has superseded is refused
//   7. pairing is by identity, NOT position — a line inserted at the top of the
//      copy must not drag every allocation onto the wrong goods

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── the fixture database ──────────────────────────────────────────────────
// NEVER data/roots.db — scripts/ is deployed, so this file exists on the
// production box. Same scratch-copy setup test_po_supersede.js uses.
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* already linked */ }
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
stub('lib/tenant-db.js',   { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js',   { getStore: id => STORES[id] || null,
                             listStores: () => Object.values(STORES),
                             adjustStock: () => {} });
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });
stub('routes/retail.js',   { requireRetailAdmin: (req, res, next) => {
                               req.user = { id: 1, username: 'tester' }; next(); } });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });

// Same two exports test_po_supersede.js replaces, and for the same reason:
// their side effects (price write-back, landed-cost split) belong to other
// tests and need store data this fixture has no reason to carry.
const purchases = require(path.join(ROOT, 'routes/purchases.js'));
require.cache[require.resolve(path.join(ROOT, 'routes/purchases.js'))].exports = Object.assign(
  Object.create(null), purchases, {
    firePriceAlertsForPO: () => ({ skips: [], landedSkips: [], landedExtras: 0 }),
    allocateLandedExtras: () => ({ perUnit: new Map(), skipped: [], extras: 0, totalGoods: 0 }),
  });

const express = require('express');
const app = express();
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ───────────────────────────────────────────────────────────────────
// One placed kitchen order, two lines from one supplier: ¥387.96 + ¥597.12.
const insPO = db.prepare(`INSERT INTO purchase_orders
  (id,po_number,date,status,supplier,scope,store_id,tenant_id)
  VALUES (?,?,?,?,?,?,?,?)`);
insPO.run(100, 'PO-0100', '2026-08-24', 'Ordered', 'Taishigang', 'kitchen', null, 1);

const insLine = db.prepare(`INSERT INTO po_line_items
  (po_id,name_en,name_cn,sku,qty,unit,cost_per_unit,total_cost,expense_category,supplier_name,sort_order)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
insLine.run(100, 'Kara Coconut Cream',     '佳乐 高浓度椰浆', 'F-6',  12, 'bottle', 32.33, 387.96, '厨房进货 Kitchen', 'Taishigang', 0);
insLine.run(100, 'Real Thai Coconut Milk', '丽尔泰 椰浆',     'F-15', 24, 'bottle', 24.88, 597.12, '厨房进货 Kitchen', 'Taishigang', 1);

// ── tiny assert harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// The screen the buyer reads: the figures across the top, and the strip.
async function screen() {
  const r = await call('GET', '/api/retail-admin/purchasing/invoices/outstanding');
  const d = (r.body && r.body.data) || {};
  return { totals: d.totals || {}, off: d.recorded_elsewhere || {} };
}
const linesOf = poId =>
  db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order, id').all(poId);
// Rounded: a SUM of REALs comes back as 985.0799999999999, and this test is
// asking "is the money there", not "how does IEEE 754 spell it".
const allocOn = poId => Math.round(db.prepare(`SELECT COALESCE(SUM(il.allocated_amount),0) AS a
    FROM invoice_lines il JOIN po_line_items pli ON pli.id = il.line_id WHERE pli.po_id = ?`)
  .get(poId).a * 100) / 100;

// Copy PO-0100 into Tacet, optionally edit the copy, then place it.
async function copyAndPlace(edit) {
  const r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                       { po_ids: [100], store_id: 1 });
  const id = r.body.data[0].id, po_number = r.body.data[0].po_number;
  if (edit) {
    const items = edit(linesOf(id));
    await call('PUT', '/api/retail-admin/purchases/' + id,
               { date: '2026-08-24', supplier: 'Taishigang', store_id: 1, items });
  }
  await call('PUT', '/api/retail-admin/purchases/' + id + '/status', { status: 'Ordered' });
  return { id, po_number };
}
async function copyAndPlaceOf(poId) {
  const r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                       { po_ids: [poId], store_id: 1 });
  const id = r.body.data[0].id, po_number = r.body.data[0].po_number;
  await call('PUT', '/api/retail-admin/purchases/' + id + '/status', { status: 'Ordered' });
  return { id, po_number };
}
const asItems = ls => ls.map(l => ({ id: l.id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
  qty: l.qty, unit: l.unit, cost_per_unit: l.cost_per_unit,
  expense_category: l.expense_category, supplier_name: l.supplier_name }));

async function main() {
  const [lineA, lineB] = linesOf(100).map(l => l.id);
  let r = await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Taishigang', invoice_number: 'INV-1', amount: 985.08, date: '2026-08-25',
    links: [{ line_id: lineA, allocated_amount: 387.96 },
            { line_id: lineB, allocated_amount: 597.12 }],
  });
  eq(r.status, 200, 'a 发票 is recorded across both lines of PO-0100');
  eq((await screen()).totals.fully_invoiced, 985.08, 'and the screen counts it');

  // The buyer corrects 12 bottles -> 10 on the copy, which is what a copy is for.
  const copy = await copyAndPlace(ls => asItems(ls).map((it, i) => (i === 0 ? { ...it, qty: 10 } : it)));
  let s = await screen();
  eq(s.totals.fully_invoiced, 0, 'placing the copy strands the 发票');
  eq(s.off.amount, 985.08, 'the strip carries it');
  eq(s.off.orders[0].po_id, 100, 'and hands the screen the order to act on');

  console.log('\n══ 1 · the plan is read-only, and pairs on identity ══');
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/100');
  eq(r.status, 200, 'the plan comes back');
  const plan = r.body.data;
  eq(plan.source.po_number, 'PO-0100', 'from the kitchen original the strip named');
  eq(plan.copy.po_number, copy.po_number, 'to the copy that replaced it');
  eq(plan.moves.length, 2, 'both allocations pair');
  eq(plan.unmatched.length, 0, 'nothing is left unpaired');
  eq(plan.movable, 985.08, 'all the money is movable');
  eq(plan.moves[0].basis, 'sku', 'paired on the line\'s own sku');
  eq(plan.moves[0].from.sku, plan.moves[0].to.sku, 'and the two sides really are the same goods');
  eq(plan.moves[0].credit_due, 64.66, 'the corrected quantity is declared up front as a credit due');
  eq(allocOn(100), 985.08, 'and the plan wrote NOTHING — the money is still on the original');

  console.log('\n══ 2 · applying it moves the money onto the copy ══');
  r = await call('POST', '/api/retail-admin/purchasing/invoices/rematch/100', {});
  eq(r.status, 200, 'the re-match is accepted');
  eq(r.body.data.moved, 2, 'two allocations moved');
  eq(r.body.data.to_po_number, copy.po_number, 'onto the copy');
  eq(allocOn(100), 0, 'nothing is left on the kitchen original');
  eq(allocOn(copy.id), 985.08, 'and the copy carries all of it');
  s = await screen();
  eq(s.off.amount, 0, 'the strip is empty');
  eq(s.totals.fully_invoiced, 920.42, 'the copy reads fully invoiced at ITS own corrected value');
  eq(s.totals.awaiting, 0, 'and there is nothing left to chase');
  eq(s.totals.credit_due, 64.66, 'the difference shows as a credit due — surfaced, not swallowed');

  console.log('\n══ 3 · the ledger still holds the invoice whole ══');
  const led = await call('GET', '/api/retail-admin/purchasing/invoices');
  const inv = led.body.data.find(i => i.invoice_number === 'INV-1');
  eq(inv.amount, 985.08, 'its header is untouched');
  eq(inv.allocated, 985.08, 'it is still fully allocated');
  eq(inv.unallocated, 0, 'with nothing left over');
  eq(inv.pos.length, 1, 'against one order');
  eq(inv.pos[0].po_number, copy.po_number, 'and that order is now the copy');

  console.log('\n══ 4 · running it again is a no-op ══');
  r = await call('POST', '/api/retail-admin/purchasing/invoices/rematch/100', {});
  eq(r.body.data.moved, 0, 'nothing moves the second time');
  eq((await screen()).totals.fully_invoiced, 920.42, 'and nothing changes');

  console.log('\n══ 5 · a line the copy no longer carries is reported, never guessed ══');
  // Fresh pair: PO-0102, two lines, a 发票 on each; the copy drops the second.
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,tenant_id)
              VALUES (900,'PO-0102','2026-08-24','Ordered','Huiyang','kitchen',1)`).run();
  const ins = db.prepare(`INSERT INTO po_line_items
    (po_id,name_en,name_cn,sku,qty,unit,cost_per_unit,total_cost,expense_category,supplier_name,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(900, 'Pea Protein', '豌豆蛋白粉', 'D-8', 2, 'kg', 45, 90, '厨房进货 Kitchen', 'Huiyang', 0);
  ins.run(900, 'Oat Flour',   '燕麦粉',     'D-9', 2, 'kg', 30, 60, '厨房进货 Kitchen', 'Huiyang', 1);
  const [p102a, p102b] = linesOf(900).map(l => l.id);
  await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Huiyang', invoice_number: 'INV-2', amount: 150, date: '2026-08-26',
    links: [{ line_id: p102a, allocated_amount: 90 }, { line_id: p102b, allocated_amount: 60 }] });
  let c2 = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen', { po_ids: [900], store_id: 1 });
  const c2id = c2.body.data[0].id;
  // the buyer keeps only the first line on the copy
  await call('PUT', '/api/retail-admin/purchases/' + c2id,
             { date: '2026-08-24', supplier: 'Huiyang', store_id: 1, items: [asItems(linesOf(c2id))[0]] });
  await call('PUT', '/api/retail-admin/purchases/' + c2id + '/status', { status: 'Ordered' });
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/900');
  eq(r.body.data.moves.length, 1, 'the line the copy still carries pairs');
  eq(r.body.data.unmatched.length, 1, 'the dropped one is reported unmatched');
  eq(r.body.data.movable, 90, 'and only its money is offered as movable');
  eq(r.body.data.total, 150, 'against the 150 sitting on the order');
  r = await call('POST', '/api/retail-admin/purchasing/invoices/rematch/900', {});
  eq(r.body.data.moved, 1, 'applying moves only the pair it was sure of');
  eq(r.body.data.unmatched, 1, 'and says what it left behind');
  eq(allocOn(900), 60, 'the unmatched ¥60 is still exactly where it was');

  console.log('\n══ 6 · an order nothing has superseded is refused ══');
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,tenant_id)
              VALUES (910,'PO-0103','2026-08-24','Ordered','Nobody','kitchen',1)`).run();
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/910');
  eq(r.status, 409, 'there is nowhere to move to, and the route says so');
  r = await call('POST', '/api/retail-admin/purchasing/invoices/rematch/910', {});
  eq(r.status, 409, 'and refuses to write');
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/99999');
  eq(r.status, 404, 'an order that does not exist is a 404');

  console.log('\n══ 7 · pairing is identity, not position ══');
  // PO-0104's copy gets a NEW line inserted at the top. Position-matching would
  // put the 发票 for the first item onto goods it never covered.
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,tenant_id)
              VALUES (920,'PO-0104','2026-08-24','Ordered','Taishigang','kitchen',1)`).run();
  ins.run(920, 'Coconut Cream', '椰浆', 'F-6', 1, 'bottle', 100, 100, '厨房进货 Kitchen', 'Taishigang', 0);
  const p104 = linesOf(920)[0].id;
  await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Taishigang', invoice_number: 'INV-3', amount: 100, date: '2026-08-26',
    links: [{ line_id: p104, allocated_amount: 100 }] });
  const c3 = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen', { po_ids: [920], store_id: 1 });
  const c3id = c3.body.data[0].id;
  await call('PUT', '/api/retail-admin/purchases/' + c3id, { date: '2026-08-24', supplier: 'Taishigang', store_id: 1,
    items: [{ name_en: 'Palm Sugar', name_cn: '棕榈糖', sku: 'F-99', qty: 3, unit: 'kg', cost_per_unit: 20,
              expense_category: '厨房进货 Kitchen', supplier_name: 'Taishigang' },
            ...asItems(linesOf(c3id))] });
  await call('PUT', '/api/retail-admin/purchases/' + c3id + '/status', { status: 'Ordered' });
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/920');
  const m = r.body.data.moves[0];
  eq(r.body.data.moves.length, 1, 'the one allocation pairs');
  eq(m.to.sku, 'F-6', 'onto the SAME goods, not onto whatever sits in that position now');
  eq(m.to.sort_order, 1, 'which the insert pushed down to position 1');
  ok(m.to.name_en !== 'Palm Sugar', 'the newly inserted line is not what it landed on');

  console.log('\n══ 8 · a 发票 already half-moved by hand folds together, never collides ══');
  // invoice_lines is UNIQUE(invoice_id, line_id). If somebody re-matched part
  // of an invoice by hand first, the row this move lands on is already there,
  // and the two allocations have to become one.
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,tenant_id)
              VALUES (930,'PO-0105','2026-08-24','Ordered','Taishigang','kitchen',1)`).run();
  ins.run(930, 'Rice Flour', '米粉', 'G-1', 4, 'kg', 25, 100, '厨房进货 Kitchen', 'Taishigang', 0);
  const p930 = linesOf(930)[0].id;
  await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Taishigang', invoice_number: 'INV-4', amount: 100, date: '2026-08-27',
    links: [{ line_id: p930, allocated_amount: 100 }] });
  const c4 = await copyAndPlaceOf(930);
  const invId = db.prepare("SELECT id FROM invoices WHERE invoice_number='INV-4'").get().id;
  // the buyer had already put ¥30 of it on the copy by hand
  db.prepare('INSERT INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,30)')
    .run(invId, linesOf(c4.id)[0].id);
  r = await call('GET', '/api/retail-admin/purchasing/invoices/rematch/930');
  eq(r.body.data.moves[0].merge, true, 'the plan sees the row already there and says it will fold');
  r = await call('POST', '/api/retail-admin/purchasing/invoices/rematch/930', {});
  eq(r.status, 200, 'and applying it does not collide on UNIQUE(invoice_id, line_id)');
  eq(db.prepare('SELECT COUNT(*) n FROM invoice_lines WHERE invoice_id = ?').get(invId).n, 1,
     'one row, not two');
  eq(allocOn(c4.id), 130, 'carrying both allocations added together');
  eq(allocOn(930), 0, 'and nothing left on the original');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
