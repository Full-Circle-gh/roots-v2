#!/usr/bin/env node
/**
 * §300 step F0b — TWO SERVER GATES IN PURCHASING THAT LET THE WRONG PERSON IN.
 *
 *   node scripts/test_purchasing_cap_gates.js
 *
 * docs/tacet-phone-parity-recipes-purchasing-finance.md §3:
 *
 *   1. PUT /purchases/:id/status accepted `purchasing:receive` for ANY status,
 *      so a receive-only account could cancel an order or stand it down to
 *      draft through the API. Now only Delivered ("everything arrived", the
 *      receiver's one tap — the phone's purchase-order sheet sends it) takes
 *      either key; every other status is the buyer's `purchasing:edit`.
 *   2. Striking a kitchen-request line off (PUT /material-requests/lines/:id/
 *      decline) sat under `production:request`, so the buyer the desktop draws
 *      its ✕ for was refused and any cook was not. It is `purchasing:edit`.
 *
 * A permission change is only right if it refuses the right people and
 * NOBODY ELSE, so every refusal here has its allow beside it, and the cook's
 * own way to take an ask back (withdraw the whole request) is asserted open.
 *
 * Two layers, both run: the gate functions in lib/cap-routes.js, and the real
 * routers mounted behind a stand-in for requireRetailAdmin that applies the
 * choke point exactly as routes/retail.js does (requiredCapFor, any-of), so
 * the in-handler narrowing is proven against the path gate it sits behind.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// NEVER data/roots.db — scripts/ is deployed (see test_kitchen_po_copy.js).
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'), path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* linked */ }
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

const db = require(path.join(SCRATCH, 'database.js'));
const realDbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[realDbPath] = { id: realDbPath, filename: realDbPath, path: ROOT,
                              loaded: true, children: [], paths: [], exports: db };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, path: path.dirname(p), loaded: true,
                       children: [], paths: [], exports };
}

const capRoutes = require(path.join(ROOT, 'lib', 'cap-routes'));
const { requiredCapFor, capDenied, purchaseStatusCap } = capRoutes;

const STORES = { 1: { id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 } };
stub('lib/tenant-db.js', { tdb: () => db, currentTenantId: () => 1 });
stub('lib/inventory.js', {
  getStore: id => STORES[id] || null,
  listStores: () => Object.values(STORES),
  adjustStock: () => ({ delta: 0 }),
});
stub('middleware/auth.js', { logActivity: () => {}, requireAuth: (q, s, n) => n(),
                             requirePermission: () => (q, s, n) => n(),
                             requireDelete: (q, s, n) => n() });

/* THE CHOKE POINT, AS routes/retail.js RUNS IT. Who is asking comes from two
   headers: x-caps (comma list; absent = unresolved), x-role, and x-enforce for
   the tenant's switch. Everything after the operator is resolved is the real
   code's conditions, line for line — asserted against its source below. */
function requireRetailAdmin(req, res, next) {
  const role = req.get('x-role') || 'staff';
  req.user = { id: 5, username: 'op', role };
  req.backendUser = { id: 5, role };
  req.tenant = { id: 1, rbac_enforce: req.get('x-enforce') === '0' ? 0 : 1 };
  const raw = req.get('x-caps');
  req.caps = raw == null ? null : new Set(raw.split(',').filter(Boolean));
  if (req.tenant.rbac_enforce && role !== 'owner' && req.caps) {
    const need = requiredCapFor(req.method, req.path);
    if (need) {
      const ok = Array.isArray(need) ? need.some(k => req.caps.has(k)) : req.caps.has(need);
      if (!ok) return res.status(403).json({ error: 'forbidden_capability', need });
    }
  }
  next();
}
stub('routes/retail.js', { requireRetailAdmin });
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
app.use(require(path.join(ROOT, 'routes/retail-material-requests.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

async function call(method, p, body, who = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (who.caps) headers['x-caps'] = who.caps.join(',');
  if (who.role) headers['x-role'] = who.role;
  if (who.enforce === false) headers['x-enforce'] = '0';
  const r = await fetch(base() + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const RECEIVER = { caps: ['purchasing:view', 'purchasing:receive'] };
const BUYER = { caps: ['purchasing:view', 'purchasing:edit'] };
const COOK = { caps: ['production:request', 'production:log'] };
const VIEWER = { caps: ['purchasing:view'] };

let poSeq = 100;
function seedPO(status) {
  const id = ++poSeq;
  db.prepare(`INSERT INTO purchase_orders (id,po_number,date,status,supplier,scope,store_id,tenant_id)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, 'RPO-' + id, '2026-09-30', status, 'Fresh Co.', 'retail', 1, 1);
  return id;
}
const poStatus = id => db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id).status;
const setStatus = (id, status, who) => call('PUT', `/api/retail-admin/purchases/${id}/status`, { status }, who);

let mrSeq = 0;
function seedLine() {
  const n = ++mrSeq;
  const r = db.prepare(`INSERT INTO material_requests (mr_number, date, status, sent_at, created_by, created_by_name)
                        VALUES (?,?,?,CURRENT_TIMESTAMP,7,'Cook')`).run('MR-' + String(n).padStart(4, '0'), '2026-09-30', 'sent');
  const l = db.prepare(`INSERT INTO material_request_items (request_id, name_en, qty, unit, sort_order)
                        VALUES (?,?,?,?,0)`).run(r.lastInsertRowid, 'Oat flour', 5, 'kg');
  return { requestId: Number(r.lastInsertRowid), lineId: Number(l.lastInsertRowid) };
}
const declined = lineId => !!db.prepare('SELECT declined_at FROM material_request_items WHERE id = ?').get(lineId).declined_at;

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  section('0 · the stand-in choke point is the real one');
  {
    const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    const choke = RETAIL.slice(RETAIL.indexOf('RBAC ENFORCEMENT (Phase 2)'), RETAIL.indexOf('Store scope —'));
    ok(/tenant\.rbac_enforce && u\.role !== 'owner' && req\.caps/.test(choke), 'gated on enforce-on + not-owner + caps-resolved');
    ok(/const ok = Array\.isArray\(need\) \? need\.some\(k => req\.caps\.has\(k\)\) : req\.caps\.has\(need\);/.test(choke),
      'an array is any-of, as here');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('1 · the gate functions');
  is(requiredCapFor('PUT', '/api/retail-admin/purchases/7/status'), ['purchasing:edit', 'purchasing:receive'],
    'the status path still lets either key past the choke point — the body decides the rest');
  is(purchaseStatusCap('Delivered'), ['purchasing:edit', 'purchasing:receive'], 'Delivered: either key');
  for (const s of ['Ordered', 'Requested', 'Cancelled']) is(purchaseStatusCap(s), 'purchasing:edit', `${s}: the buyer's key`);
  is(requiredCapFor('PUT', '/api/retail-admin/purchases/7/receive'), 'purchasing:receive', 'per-line receive is unchanged');
  is(requiredCapFor('PUT', '/api/retail-admin/purchases/7'), 'purchasing:edit', 'editing an order is unchanged');

  is(requiredCapFor('PUT', '/api/retail-admin/material-requests/lines/42/decline'), 'purchasing:edit',
    'striking a kitchen line off is the buyer\'s');
  for (const [m, p] of [
    ['POST', '/api/retail-admin/material-requests'],
    ['PUT', '/api/retail-admin/material-requests/3'],
    ['PUT', '/api/retail-admin/material-requests/3/send'],
    ['PUT', '/api/retail-admin/material-requests/3/archive'],
  ]) is(requiredCapFor(m, p), 'production:request', `${m} ${p.replace('/api/retail-admin', '')} is still the kitchen's`);
  is(requiredCapFor('POST', '/api/retail-admin/purchases/from-material-requests'), 'purchasing:edit',
    'turning asks into an order is still the buyer\'s');
  is(requiredCapFor('PUT', '/api/retail-admin/material-requests/lines/42/decline/x'), 'production:request',
    'the rule is anchored: nothing longer rides on it');

  const enforced = caps => ({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'staff' }, caps: new Set(caps) });
  is(capDenied(enforced(['purchasing:receive']), 'purchasing:edit'), true, 'capDenied: a missing key is refused');
  is(capDenied(enforced(['purchasing:receive']), ['purchasing:edit', 'purchasing:receive']), false, 'capDenied: any-of, one held, passes');
  is(capDenied(enforced(['purchasing:view']), ['purchasing:edit', 'purchasing:receive']), true, 'capDenied: any-of, none held, refused');
  is(capDenied(enforced(['orders:refund']), 'orders:refund'), false, 'capDenied: a string still reads as before');
  is(capDenied(enforced([]), []), false, 'capDenied: an empty list gates nothing');
  is(capDenied({ tenant: { rbac_enforce: 0 }, backendUser: { role: 'staff' }, caps: new Set() }, ['purchasing:edit']), false,
    'capDenied: enforcement off, never refused');
  is(capDenied({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'owner' }, caps: new Set() }, ['purchasing:edit']), false,
    'capDenied: the owner bypasses');
  is(capDenied({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'staff' }, caps: null }, ['purchasing:edit']), false,
    'capDenied: unresolved caps fail open, like the choke point');

  // ───────────────────────────────────────────────────────────────────────
  section('2 · a receive-only account may say "everything arrived", and nothing else');
  {
    const id = seedPO('Ordered');
    // Exactly what the phone's sheetPO sends (scripts/test_mobile_finance_guards.js pins that side).
    const r = await setStatus(id, 'Delivered', RECEIVER);
    is(r.status, 200, 'the phone\'s Everything arrived: PUT {status:"Delivered"} goes through');
    is(poStatus(id), 'Delivered', 'and the order is received');
  }
  for (const [from, to] of [['Ordered', 'Cancelled'], ['Ordered', 'Requested'], ['Requested', 'Ordered'], ['Requested', 'Cancelled']]) {
    const id = seedPO(from);
    const r = await setStatus(id, to, RECEIVER);
    is(r.status, 403, `${from} → ${to} is refused`);
    is(r.body && r.body.error, 'forbidden_capability', '…in the choke point\'s own words');
    is(r.body && r.body.need, 'purchasing:edit', '…naming the key it needs');
    is(poStatus(id), from, '…and the order is exactly as it was');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('3 · the buyer still moves an order anywhere');
  for (const [from, to] of [['Requested', 'Ordered'], ['Ordered', 'Delivered'], ['Requested', 'Cancelled']]) {
    const id = seedPO(from);
    const r = await setStatus(id, to, BUYER);
    is(r.status, 200, `${from} → ${to} by purchasing:edit`);
    is(poStatus(id), to, `…lands at ${to}`);
  }
  {
    const id = seedPO('Ordered');
    const r = await setStatus(id, 'Delivered', VIEWER);
    is(r.status, 403, 'view-only is refused even Delivered, at the choke point');
    is(r.body && r.body.need, ['purchasing:edit', 'purchasing:receive'], '…which names either key');
    is(poStatus(id), 'Ordered', '…and nothing moved');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('4 · nobody else is newly refused');
  {
    const a = seedPO('Ordered');
    is((await setStatus(a, 'Cancelled', { caps: [], role: 'owner' })).status, 200, 'the owner, holding nothing, still cancels');
    const b = seedPO('Ordered');
    is((await setStatus(b, 'Cancelled', { caps: ['purchasing:receive'], enforce: false })).status, 200,
      'a shop with enforcement off sees no change at all');
    const c = seedPO('Ordered');
    is((await setStatus(c, 'Cancelled', { role: 'staff' })).status, 200, 'unresolved caps fail open, as everywhere else');
    const d = seedPO('Ordered');
    is((await setStatus(d, 'Shipped', RECEIVER)).status, 400, 'a status that does not exist is still a 400, not a 403');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('5 · striking a kitchen line off is the buyer\'s; withdrawing the ask stays the cook\'s');
  {
    const { lineId } = seedLine();
    const r = await call('PUT', `/api/retail-admin/material-requests/lines/${lineId}/decline`, {}, BUYER);
    is(r.status, 200, 'the buyer (purchasing:edit) strikes the line off — the desktop\'s ✕');
    ok(declined(lineId), '…and it is struck off');
  }
  {
    const { lineId } = seedLine();
    const r = await call('PUT', `/api/retail-admin/material-requests/lines/${lineId}/decline`, {}, COOK);
    is(r.status, 403, 'a cook (production:request) no longer can');
    is(r.body && r.body.need, 'purchasing:edit', '…and is told which key it takes');
    ok(!declined(lineId), '…and the line still stands');
  }
  {
    const { lineId } = seedLine();
    is((await call('PUT', `/api/retail-admin/material-requests/lines/${lineId}/decline`, {}, RECEIVER)).status, 403,
      'nor a receiver');
  }
  {
    const { requestId } = seedLine();
    const r = await call('PUT', `/api/retail-admin/material-requests/${requestId}/archive`, { archived: true }, COOK);
    is(r.status, 200, 'the cook still withdraws their own whole request');
    ok(!!db.prepare('SELECT archived_at FROM material_requests WHERE id = ?').get(requestId).archived_at, '…and it is withdrawn');
  }
  {
    const r = await call('POST', '/api/retail-admin/material-requests', { items: [] }, BUYER);
    is(r.status, 403, 'and raising an ask is still the kitchen\'s, not the buyer\'s');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('6 · the desktop draws these controls on the same keys');
  {
    const PU = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js'), 'utf8');
    ok(/data-cap="purchasing:edit"\s+title="[^"]*"\s+onclick="event\.stopPropagation\(\); puMrDecline/.test(PU.replace(/\$\{esc\(T\('Remove', '移除'\)\)\}/, 'Remove')),
      'the ✕ on a kitchen line is data-cap="purchasing:edit"');
    ok(/data-cap="purchasing:edit" onclick="puSetStatus\('Cancelled'\)"/.test(PU), 'Cancel order is purchasing:edit');
    ok(/data-cap="purchasing:edit" onclick="puSetStatus\('Requested'\)"/.test(PU), 'Back to draft is purchasing:edit');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
