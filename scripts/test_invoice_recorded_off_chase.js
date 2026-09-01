#!/usr/bin/env node
// "I've already got that 发票. Why does the top of the screen say ¥0.00?"
//
// Purchasing → Invoices counts a recorded 发票 through ONE path and no other:
// the PO LINE its allocation points at. lineStatus() reads `covered`, `covered`
// comes from the lines /invoices/outstanding selects, and the five figures
// across the top are those lines added up by state. So an allocation whose
// line falls out of that selection is counted NOWHERE — and because the four
// states still add up to the total, nothing on the screen looks wrong. The
// headline just reads "Fully invoiced ¥0.00" over a ledger of real, fully
// allocated invoices, and the buyer is told to chase 发票 they already hold.
//
// The ordinary way to get there is "Copy from kitchen". Record a 发票 against
// PO-0100's lines, then place the RPO copy of that order: the copy stands the
// original down (lib/po-supersede.js), the original's lines leave the chase,
// and the allocation goes with them. lib/po-supersede.js is explicit that this
// must not happen — "the chase never asks for a 发票 somebody has already
// filed" — and scripts/test_po_supersede.js §7 already pins the per-line half
// of the answer (the copy carries `supersedes_invoiced`). This pins the half
// that was missing: the money is named at the top of the screen too.
//
// Run:  node scripts/test_invoice_recorded_off_chase.js
//
// Cases:
//   1. an allocation on a placed order counts, and nothing is off-chase
//   2. placing the copy takes it off the chase — and the screen says so,
//      naming the order it is stranded on and the copy that replaced it
//   3. dropping the copy back to Draft hands the money straight back
//   4. cancelling the order a 发票 was recorded against is reported too,
//      under its own reason
//   5. an unallocated invoice is not "off-chase" — it never claimed a line

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
const firstLine = db.prepare('SELECT id FROM po_line_items WHERE po_id = 100 ORDER BY sort_order').get().id;

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

// The screen, read the way the buyer reads it: the figures across the top and
// the strip beneath them.
async function screen() {
  const r = await call('GET', '/api/retail-admin/purchasing/invoices/outstanding');
  const d = (r.body && r.body.data) || {};
  return { totals: d.totals || {}, off: d.recorded_elsewhere || {} };
}

async function main() {
  console.log('\n══ 1 · a 发票 recorded against a placed order counts ══');
  let r = await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Taishigang', invoice_number: 'INV-1', amount: 387.96, date: '2026-08-25',
    links: [{ line_id: firstLine, allocated_amount: 387.96 }],
  });
  eq(r.status, 200, 'the invoice is recorded against the first line');
  let s = await screen();
  eq(s.totals.fully_invoiced, 387.96, 'the top of the screen counts it as fully invoiced');
  eq(s.totals.awaiting, 597.12, 'and chases only the line it did not cover');
  eq(s.off.amount, 0, 'nothing is stranded off the chase');
  eq(s.off.order_count, 0, 'so no order is named');

  console.log('\n══ 2 · placing a copy strands it — and the screen says where ══');
  r = await call('POST', '/api/retail-admin/purchases/copy-from-kitchen',
                 { po_ids: [100], store_id: 1 });
  eq(r.status, 200, 'the kitchen order is copied into Tacet');
  const copyId = r.body.data[0].id;
  const copyNo = r.body.data[0].po_number;
  r = await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Ordered' });
  eq(r.status, 200, 'and the copy is placed, superseding the original');
  s = await screen();
  eq(s.totals.fully_invoiced, 0, 'the four states can no longer see the 发票');
  eq(s.off.amount, 387.96, 'so the strip carries it instead — the money is not lost');
  eq(s.off.by_reason.superseded, 387.96, 'under "an order that has been replaced"');
  eq(s.off.order_count, 1, 'on one order');
  eq(s.off.orders[0].po_number, 'PO-0100', 'named, so the buyer can find it');
  eq(s.off.orders[0].copy_po_number, copyNo, 'along with the copy that replaced it');
  eq(db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE line_id = ?').get(firstLine).n, 1,
     'and the allocation itself is untouched in the ledger');

  console.log('\n══ 3 · it reverses — back to Draft and the money is upstairs again ══');
  await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Requested' });
  s = await screen();
  eq(s.totals.fully_invoiced, 387.96, 'the original is chased again, and its 发票 counts again');
  eq(s.off.amount, 0, 'the strip is empty');

  console.log('\n══ 4 · a cancelled order reports under its own reason ══');
  await call('PUT', '/api/retail-admin/purchases/' + copyId + '/status', { status: 'Cancelled' });
  db.prepare("UPDATE purchase_orders SET status = 'Cancelled' WHERE id = 100").run();
  s = await screen();
  eq(s.totals.total, 0, 'a cancelled order is off the chase entirely');
  eq(s.off.amount, 387.96, 'and the 发票 recorded against it is still reported');
  eq(s.off.by_reason.not_placed, 387.96, 'under "not a placed order"');
  eq(s.off.orders[0].status, 'Cancelled', 'saying what the order became');
  db.prepare("UPDATE purchase_orders SET status = 'Ordered' WHERE id = 100").run();

  console.log('\n══ 5 · an invoice that claimed no line was never on the chase ══');
  r = await call('POST', '/api/retail-admin/purchasing/invoices', {
    supplier: 'Taishigang', invoice_number: 'INV-2', amount: 50, date: '2026-08-26', links: [],
  });
  eq(r.status, 200, 'an unallocated invoice is recorded');
  s = await screen();
  eq(s.off.amount, 0, 'and is not counted as stranded — it points at no line at all');
  const led = await call('GET', '/api/retail-admin/purchasing/invoices');
  const inv2 = led.body.data.find(i => i.invoice_number === 'INV-2');
  eq(inv2.unallocated, 50, 'the ledger row already reports it as unallocated, as it always did');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); server.close(); process.exit(2); });
