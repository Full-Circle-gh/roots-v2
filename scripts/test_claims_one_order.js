#!/usr/bin/env node
// Several not-arrived claims approved onto ONE purchase order (§270), end to end
// over HTTP on the real schema. The harness is scripts/test_claim_purchase_order.js's.
//
//   node scripts/test_claims_one_order.js
//
//   1. three claims from two sellers become one order with three typed lines
//   2. each line keeps its own price and category; the order posts the money once
//   3. per-claim picks (category, who paid) apply as on /decide
//   4. a batch that does not fit is refused whole: one claim, a decided claim,
//      an arrived claim, two shops
//   5. each line is received on its own day
//   6. the gate is expenses:approve, above the generic prefix
'use strict';


const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const db = require(path.join(SCRATCH, 'database.js'));
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}
const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 },
                 2: { id: 2, name_en: 'Yuexiu', name_cn: '越秀店', is_active: 1 } };
const stockCalls = [];
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: (...a) => { stockCalls.push(a); return { ok: true }; },
  enqueueChannelSync: () => {},
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n(), requireAdmin: (q, s, n) => n() });
// The operator: an owner, so both the approve and the void gates pass. What
// those gates DO is scripts/test_staff_expenses.js's subject, not this one's.
stub('routes/retail.js', { requireRetailAdmin: (req, res, next) => {
  req.user = { id: 7, username: 'approver' };
  req.backendUser = { role: 'owner' };
  next();
} });
stub('lib/recipe-rollup.js', { recipeOwnsProductCost: () => false, planRollup: () => ({}),
                               fireRecompute: () => {} });
// Names come off the control plane; this suite is not about who is named.
stub('lib/user-names.js', { userNames: () => new Map() });

const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(require(path.join(ROOT, 'routes/staff-expenses.js')));
app.use(require(path.join(ROOT, 'routes/retail-purchasing.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const submit = (b) => call('POST', '/api/retail-admin/staff-expenses', b);
const claimRow = (id) => db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(id);

const together = (ids, extra) => call('POST', '/api/retail-admin/staff-expenses/approve-together', { ids, ...(extra || {}) });
const orders = () => db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c;
const item = (note, amount, extra) => submit({ date: '2026-09-26', amount, note, category: '其他费用',
  paid_by: 'employee', store_id: 1, awaiting_delivery: true, ...(extra || {}) });

async function main() {
  db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting','其他费用')").run();
  db.prepare("INSERT INTO categories (kind, name) VALUES ('accounting','Tableware')").run();

  console.log('\n══ 1 · three claims, one order ══');
  const a = (await item('Glass cups', 19.02)).body.id;
  const b = (await item('Jars', 16.24, { date: '2026-09-25' })).body.id;
  const c = (await item('Scoop', 4.88)).body.id;
  let r = await together([a, b, c], { categories: { [a]: 'Tableware' }, paid_by: { [c]: 'company' } });
  eq(r.status, 200, 'approved together');
  eq(orders(), 1, 'ONE order, not three');
  const poId = r.body.data.po_id;
  ok(/^RPO-/.test(r.body.data.po_number || ''), 'with a retail order number');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  eq(po.status, 'Ordered', 'Ordered, as a single claim would be');
  eq(po.store_id, 1, 'for the shop they are coming to');
  eq(po.date, '2026-09-25', 'dated by the earliest purchase');
  const lines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(poId);
  eq(lines.map(l => l.name_en), ['Jars', 'Glass cups', 'Scoop'], 'one typed line per claim');
  eq(lines.map(l => Number(l.cost_per_unit)), [16.24, 19.02, 4.88], 'each at its own price');
  ok(lines.every(l => l.store_product_id == null && l.ingredient_id == null), 'all typed lines — no material needed');

  console.log('\n══ 2 · the money, once ══');
  const claimRows = db.prepare(`SELECT COUNT(*) c FROM expense_entries WHERE claim_id IN (${a},${b},${c})`).get().c;
  eq(claimRows, 0, 'the claims posted nothing of their own');
  const total = db.prepare('SELECT ROUND(SUM(amount),2) t FROM expense_entries WHERE po_id = ?').get(poId).t;
  eq(total, 40.14, 'the order posted the three together');
  eq(db.prepare("SELECT ROUND(SUM(amount),2) t FROM expense_entries WHERE po_id = ? AND category = 'Tableware'").get(poId).t, 19.02,
     'and the cups under the category the approver picked');

  console.log('\n══ 3 · every claim is approved and points at the order ══');
  for (const id of [a, b, c]) {
    const row = claimRow(id);
    ok(row.status === 'approved' && row.po_id === poId, `claim ${id} approved, on the order`);
  }
  eq(claimRow(c).paid_by, 'company', 'who-paid picks apply per claim');
  eq(claimRow(a).paid_by, 'employee', 'and a claim without one keeps its own');

  console.log('\n══ 4 · a batch that does not fit is refused whole ══');
  const d = (await item('Tongs', 8.6)).body.id;
  eq((await together([d])).status, 400, 'one claim is not a batch');
  eq((await together([d, a])).status, 409, 'a claim already on an order is refused');
  eq(claimRow(d).status, 'submitted', 'and the other claim in that batch is untouched');
  const plain = (await submit({ date: '2026-09-26', amount: 38, note: 'Taxi', paid_by: 'employee', store_id: 1 })).body.id;
  eq((await together([d, plain])).status, 409, 'a claim whose goods arrived is refused');
  const other = (await item('Cloth', 11.54, { store_id: 2 })).body.id;
  r = await together([d, other]);
  eq(r.status, 409, 'two shops are refused');
  ok(/同一门店/.test(r.body.error || ''), 'and the refusal says why');
  eq(orders(), 1, 'no order was raised by any refusal');

  console.log('\n══ 5 · each line is received on its own day ══');
  stockCalls.length = 0;
  r = await call('PUT', `/api/retail-admin/purchases/${poId}/receive`,
                 { receipts: [{ line_id: lines[0].id, qty_received: 1 }] });
  eq(r.status, 200, 'the jars arrive first');
  eq(Number(db.prepare('SELECT qty_received FROM po_line_items WHERE id = ?').get(lines[1].id).qty_received || 0), 0,
     'the cups are still to come');
  eq(stockCalls.length, 0, 'and no stock moved — typed lines have no shelf');

  console.log('\n══ 6 · the gate ══');
  const capFor = require(path.join(ROOT, 'lib/cap-routes.js'));
  const fn = (m, p) => capFor.requiredCapFor(m, p);
  if (fn) eq(fn('POST', '/api/retail-admin/staff-expenses/approve-together'), 'expenses:approve', 'expenses:approve, not submit');
  else ok(/staff-expenses\/approve-together'\) return 'expenses:approve'/.test(require('fs').readFileSync(path.join(ROOT, 'lib/cap-routes.js'), 'utf8')),
          'expenses:approve, not submit');

  console.log('\n══ 7 · the screens ══');
  const fs2 = require('fs');
  const FIN = fs2.readFileSync(path.join(ROOT, 'public/retail-admin/22-finance.js'), 'utf8');
  const PHONE = fs2.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
  const VOCAB = fs2.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');
  ok(FIN.includes("'/api/retail-admin/staff-expenses/approve-together'"), 'the desktop calls it');
  ok(/const joinable = waiting && Number\(r\.awaiting_delivery\) && !r\.po_id;/.test(FIN), 'the desktop offers the tick only on not-arrived waiting claims');
  ok(FIN.includes('FIN_APR_JOIN.size >= 2'), 'and the button only at two or more');
  ok(PHONE.includes("apiWrite('/staff-expenses/approve-together'"), 'the phone calls it');
  ok(PHONE.includes('joinN>=2'), 'and shows the button only at two or more');
  ok(VOCAB.includes('只有同一门店、待审批且尚未到货的申请才能合并为一张采购单'), 'the composed refusal is declared');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });
