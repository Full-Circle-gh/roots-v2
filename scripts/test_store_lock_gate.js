#!/usr/bin/env node
/**
 * §520 — the store lock: a pinned login sees its own stores and nothing else.
 *
 *   node scripts/test_store_lock_gate.js
 *
 * Ash, with a phone screenshot of the Add stock pills still offering Tianhe
 * to a login pinned to Yuexiu: "anywhere in the app he shouldnt be able to
 * select any other store". The lock is one answer per side — req.scopeStores
 * on the server, the scoped store list on the clients — and this suite is the
 * gate that holds it: a frozen table of the pickers and route families it
 * covers, source assertions that each still joins the list, and behavioural
 * checks over the real routes that a pinned login is refused another store's
 * shelf, orders, waste, transfers and purchases.
 *
 * FROZEN COVERAGE TABLE — a new store picker or store-keyed route family
 * joins the lock by adding its line here AND its assertion below. A picker or
 * family that arrives without joining fails this suite, which is the point:
 * coverage that lives only in someone's memory is coverage the next screen
 * skips.
 *
 *   server lists   GET /api/retail-admin/stores            retail-inventory.js
 *                  GET /api/retail-admin/inventory/grid    retail-inventory.js
 *                  GET /api/retail-admin/quick-stock/context  retail-inventory.js
 *                  channel boards (meituan/eleme/guanyi/hub)  *-admin.js
 *   server guards  inventory per-store reads + writes      retail-inventory.js
 *                  orders list/counts/csv/create + :id gate  retail.js
 *                  dashboard/ops tile                      retail.js
 *                  waste list/recalc/create/bulk           retail-waste.js
 *                  purchases list/create/edit/invoices + :id  retail-purchasing.js
 *                  transfers list/create/ends + :id gate   restock.js
 *                  production log                          retail-production.js
 *                  counter catalogue, vouchers, staff list, eleme oauth
 *                                                          retail-shops.js,
 *                                                          retail/customers.js,
 *                                                          backend-team.js,
 *                                                          eleme-admin.js
 *   phone pickers  Add stock pills, orders chips, waste chips, ask-stock
 *                  pills, sent-request edit, pick chips, transfers, PO
 *                  deliver-to, kitchen-request sheet, coupon select
 *                                                          public/m.html
 *   desk pickers   orders filter, waste filter + record modal, purchasing
 *                  selects + wizard, products switcher, till switcher
 *                                                          public/retail-admin/*,
 *                                                          public/till.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const inventory = require(path.join(ROOT, 'routes', 'retail-inventory.js'));
const waste = require(path.join(ROOT, 'routes', 'retail-waste.js'));
const purchasing = require(path.join(ROOT, 'routes', 'retail-purchasing.js'));
const restock = require(path.join(ROOT, 'routes', 'restock.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const INV = read('routes/retail-inventory.js');
const RET = read('routes/retail.js');
const WST = read('routes/retail-waste.js');
const PUR = read('routes/retail-purchasing.js');
const RST = read('routes/restock.js');
const M = read('public/m.html');
const ORD = read('public/retail-admin/04-orders.js');
const WSTUI = read('public/retail-admin/20-waste.js');
const PURUI = read('public/retail-admin/16-purchasing.js');
const TILL = read('public/till.html');
const OPSUI = read('public/retail-admin/02-settings-ops.js');
const PRODUI = read('public/retail-admin/09-products.js');
const IG = read('public/retail-admin/15-integrations.js');
const SU = read('public/retail-admin/17-setup-guide.js');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const TIANHE = 1, YUEXIU = 2;
for (const [id, en, cn] of [[TIANHE, 'Tianhe', '天河'], [YUEXIU, 'Yuexiu', '越秀']]) {
  db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone)
              VALUES (?,?,?,?,1,?,'Asia/Shanghai')`).run(id, en.toLowerCase(), en, cn, id);
}

// One product on both shelves, so stock reads and writes have a subject.
let PROD = 0;
try {
  PROD = db.prepare(`INSERT INTO store_products (name_en, name_cn, sku, retail_price) VALUES ('Carrot', '胡萝卜', 'A-39', 10)`).run().lastInsertRowid;
  for (const s of [TIANHE, YUEXIU]) {
    db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)`).run(s, PROD, s === TIANHE ? 39 : 7);
  }
} catch (e) { console.log('  (stock seed skipped: ' + e.message + ')'); }

// One paid order per store, so the orders family has a row to refuse.
const ORD_T = 9401, ORD_Y = 9402;
for (const [id, store] of [[ORD_T, TIANHE], [ORD_Y, YUEXIU]]) {
  db.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, store_id, fulfillment_type,
                subtotal, shipping_fee, total, channel, payment_method, paid_at, placed_at)
              VALUES (?,?,null,'paid',?,'delivery',8,0,8,'wechat','wechat',datetime('now'),datetime('now'))`)
    .run(id, 'SL' + id, store);
}

// One waste row per store, one PO per store plus one business-wide, one
// transfer between the two — each family's refusal needs a subject.
try {
  db.prepare(`INSERT INTO waste_records (location_id, subject_type, store_product_id, qty, unit, reason_code, business_date, cost_total_cents)
              VALUES (?, 'product', ?, 1, 'unit', 'expired', date('now'), 100)`).run(TIANHE, PROD);
  db.prepare(`INSERT INTO waste_records (location_id, subject_type, store_product_id, qty, unit, reason_code, business_date, cost_total_cents)
              VALUES (?, 'product', ?, 1, 'unit', 'expired', date('now'), 100)`).run(YUEXIU, PROD);
} catch (e) { console.log('  (waste seed skipped: ' + e.message + ')'); }
try {
  db.prepare(`INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, store_id, tenant_id)
              VALUES (41, 'PO-41', date('now'), 'Open', 'S', 'retail', ?, ?)`).run(TIANHE, TENANT);
  db.prepare(`INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, store_id, tenant_id)
              VALUES (42, 'PO-42', date('now'), 'Open', 'S', 'retail', ?, ?)`).run(YUEXIU, TENANT);
  db.prepare(`INSERT INTO purchase_orders (id, po_number, date, status, supplier, scope, store_id, tenant_id)
              VALUES (43, 'PO-43', date('now'), 'Open', 'S', 'retail', NULL, ?)`).run(TENANT);
} catch (e) { console.log('  (PO seed skipped: ' + e.message + ')'); }
try {
  db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, from_store_id, to_store_id, created_by)
              VALUES (61, 'RS-61', date('now'), 'sent', ?, ?, 1)`).run(TIANHE, YUEXIU);
  db.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, from_store_id, to_store_id, created_by)
              VALUES (62, 'RS-62', date('now'), 'sent', ?, NULL, 1)`).run(TIANHE);
} catch (e) { console.log('  (restock seed skipped: ' + e.message + ')'); }

let nextId = 7700;
const ops = {};
function operator(name, { role = 'staff', stores = null } = {}) {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active, scope_all)
              VALUES (?, ?, ?, 'x', ?, 1, ?)`).run(id, TENANT, '__sl_' + name, role, stores ? 0 : 1);
  for (const s of stores || []) {
    db.prepare('INSERT INTO tenant_user_stores (tenant_user_id, store_id) VALUES (?, ?)').run(id, s);
  }
  ops[name] = id;
}
operator('owner', { role: 'owner' });
operator('yuexiu', { stores: [YUEXIU] });
operator('nowhere', { stores: [] });

(async () => {
  section('0 · the frozen table still holds in source');
  {
    ok(/let stores = inventory\.listStores\(\{ activeOnly: false \}\);\n  [\s\S]*?req\.scopeStores/.test(INV)
      && INV.includes('the lock rides the pin'),
      'the store list every picker builds from is filtered by the pin');
    ok(INV.includes('a scoped login\'s grid carries their stores only'), 'the cross-store grid is filtered too');
    ok(/stores = stores\.filter\(s => ok\.has\(Number\(s\.id\)\)\);/.test(INV) && INV.includes('full access still stops at the pin'),
      'quick-stock context stops at the pin for full-access operators');
    ok(/if \(Array\.isArray\(req\.scopeStores\)\) \{\n    return res\.status\(403\)/.test(INV),
      'opening a new location is refused to a pinned login');
    ok(RET.includes('function orderStoreGate') && RET.includes("router.use('/api/retail-admin/orders', orderStoreGate)"),
      'the orders family wears one gate instead of a check per action');
    ok(RET.includes('function buildOrderFilter(query, scope)') && RET.includes('with no store filter the list is the caller\'s own stores'),
      'the orders list, counts and CSV clamp to the pin');
    ok(RET.includes('const opsScope = !storeId ? operatorCaps.storeIdsOf(req) : null;'),
      'the dashboard ops tile clamps its all-stores sum');
    ok(WST.includes('function listFilter(q, scope)') && WST.includes('no store filter means the caller\'s OWN stores'),
      'the waste list and recalculation clamp to the pin');
    ok(WST.includes('waste is recorded AT a store, so every location_id stops at the pin'),
      'waste writes stop at the pin');
    ok(PUR.includes('function poInScope(req, po)') && PUR.includes('the caller\'s own stores plus the orders raised for no'),
      'the purchases list and every PO action stop at the pin');
    ok(RST.includes('function restockStoreGate') && RST.includes("router.use('/api/restock', restockStoreGate)"),
      'the transfer family wears one gate');
    ok(RST.includes('a scoped caller sees the requests that touch their stores'),
      'the transfer list clamps to the pin, sender or receiver');
    // Phone: every picker builds from the scoped list and hides at one store.
    ok(M.includes('const storeRow = stores.length>1 ?') , 'Add stock draws its pills only when there is a choice');
    ok(M.includes('stores.length>1?`<div style="height:8px"></div>${chipRow(st,state.storeF,\'storeF\')}`:\'\''),
      'the orders chips hide at one store');
    ok(M.includes('const storeChips = stores.length>1'), 'the waste chips hide at one store');
    ok(M.includes('if(stores.length<2) return') , 'ask-stock says nowhere-else-to-ask at one store');
    ok(M.includes('§520 — a picker that can pick one thing is not a choice: the store\'s\n           own name stands where the select was'),
      'the PO deliver-to picker becomes the store\'s name at one store');
    ok(M.includes('§520 — one store means no picker; the name stands instead'),
      'the kitchen-request sheet\'s store picker becomes the name at one store');
    ok(M.includes('${stores.length>1?`<div style="font-size:13px;font-weight:500;color:var(--text-secondary);margin-bottom:6px">${T(\'For which store?\',\'送到哪家门店？\')}</div>'),
      'the sent-request edit hides its store row at one store');
    ok(M.includes('if(stores.length===1){ k.at=stores[0].id; }'), 'pick & send auto-picks the only store');
    ok(M.includes('function xfrStoreIds(){ return (state.stores||[]).map(s=>s.id); }'),
      'transfers walk the scoped list');
    // Desktop + till.
    ok(ORD.includes('if (stores.length <= 1) { sel.style.display = \'none\'; return; }')
      && ORD.includes('else if (window.RA_STORE_LOCK) sel.value = String(window.RA_STORE_LOCK);'),
      'the desktop orders filter hides at one store and lands on the pin');
    ok(WSTUI.includes('_stores.length > 1 ? `<select id="wst-f-loc">') || WSTUI.includes('const locSel = _stores.length > 1 ?'),
      'the desktop waste filter hides at one store');
    ok(WSTUI.includes('§520 — one store means no picker: the name stands, the select'),
      'the waste record modal\'s store picker becomes the name at one store');
    ok((PURUI.match(/§520 — one store means no picker: the name stands, the select/g) || []).length >= 3,
      'the three purchasing pickers become the name at one store');
    ok(TILL.includes('var canSwitch = S.stores.length > 1'), 'the till switcher hides at one store');
    ok(M.includes('function tmStores(){ const sc=state.scopeStores;'),
      'the phone Team pickers offer the caller\'s own stores only');
    ok(OPSUI.includes('!Array.isArray(window.RA_SCOPE_STORES) || window.RA_SCOPE_STORES.includes(Number(s.id))'),
      'the desktop Team pickers offer the caller\'s own stores only');
    ok(PRODUI.includes('if (PA_STORE !== \'all\' && !PA_STORES.some(s => Number(s.id) === Number(PA_STORE)))'),
      'a persisted product-store pick outside the scope falls back');
    ok(IG.includes('window.igAddLocation = function () {\n    // §520: opening a location is a whole-business act.')
      && IG.includes('if (Array.isArray(window.RA_SCOPE_STORES)) return;'),
      'the integrations Add-location wizard no-ops for a pinned login');
    ok(SU.includes('if (Array.isArray(window.RA_SCOPE_STORES)) return;\n  suStoreWizOpen();'),
      'the setup guide\'s store wizard no-ops for a pinned login');
  }

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(retail);
  app.use(inventory);
  app.use(waste);
  app.use(purchasing);
  app.use(restock);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (who, url) => {
    const r = await fetch(base + url, { headers: { 'x-op': String(ops[who]) } });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  };
  const patch = async (who, url, body) => {
    const r = await fetch(base + url, {
      method: 'PATCH',
      headers: { 'x-op': String(ops[who]), 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  };

  try {
    section('1 · the list every picker builds from is the pin');
    {
      const all = await get('owner', '/api/retail-admin/stores');
      is(all.status, 200, 'owner reads the store list');
      is((all.j.data || []).map(s => s.id).sort(), [TIANHE, YUEXIU], '…both stores, as always');
      const pin = await get('yuexiu', '/api/retail-admin/stores');
      is(pin.status, 200, 'a pinned login reads the store list');
      is((pin.j.data || []).map(s => s.id), [YUEXIU], '…and it holds exactly their store — no Tianhe pill anywhere');
      const none = await get('nowhere', '/api/retail-admin/stores');
      is((none.j.data || []).length, 0, 'a pin to no store is offered no store');
    }

    section('2 · another store\'s shelf is refused, read and write');
    {
      const read = await get('yuexiu', `/api/retail-admin/stores/${TIANHE}/stock`);
      is(read.status, 403, 'reading Tianhe\'s shelf is forbidden_store');
      is(read.j && read.j.error, 'forbidden_store', '…with the refusal code the clients already speak');
      const own = await get('yuexiu', `/api/retail-admin/stores/${YUEXIU}/stock`);
      is(own.status, 200, 'their own shelf reads as before');
      const write = await patch('yuexiu', `/api/retail-admin/stores/${TIANHE}/stock/${PROD}`, { delta: 1, reason: 'kitchen_add' });
      is(write.status, 403, 'writing Tianhe\'s shelf is refused too');
      const grid = await get('yuexiu', '/api/retail-admin/inventory/grid');
      is(((grid.j && grid.j.data && grid.j.data.stores) || []).map(s => s.id).sort(), [YUEXIU],
        'the cross-store grid carries their stores only');
    }

    section('3 · orders: the list clamps, the detail gate refuses');
    {
      const all = await get('owner', '/api/retail-admin/orders?limit=50');
      is(all.status, 200, 'owner reads the order list');
      const pin = await get('yuexiu', '/api/retail-admin/orders?limit=50');
      is(pin.status, 200, 'a pinned login reads the order list');
      is(((pin.j && pin.j.data) || []).map(o => o.id).sort(), [ORD_Y], '…their store\'s orders only');
      const other = await get('yuexiu', `/api/retail-admin/orders?store_id=${TIANHE}&limit=50`);
      is(other.status, 403, 'filtering to another store is refused, not emptied');
      const detail = await get('yuexiu', `/api/retail-admin/orders/${ORD_T}`);
      is(detail.status, 403, 'opening another store\'s order is refused by the family gate');
      const own = await get('yuexiu', `/api/retail-admin/orders/${ORD_Y}`);
      is(own.status, 200, 'their own order opens as before');
      const counts = await get('yuexiu', '/api/retail-admin/order-status-counts');
      is(counts.j && counts.j.data && counts.j.data.paid, 1, 'the open-work chips count their store only');
    }

    section('3b · a fapiao at the other store is not this login\'s alert');
    {
      // Both orders asked for a fapiao. Home used to count every unissued one,
      // so a warehouse login pinned to Tianhe saw Yuexiu's "Invoices to issue".
      db.prepare(`UPDATE retail_orders SET needs_invoice = 1, invoice_status = 'requested' WHERE id IN (?, ?)`)
        .run(ORD_T, ORD_Y);
      const own = await get('yuexiu', '/api/retail-admin/dashboard/ops');
      const ownInv = own.j && own.j.data && own.j.data.invoices;
      is(own.status, 200, 'a pinned login reads the dashboard');
      is(ownInv && ownInv.count, 1, 'Home counts their store\'s unissued fapiao only');
      is((ownInv && ownInv.items || []).map(r => r.id), [ORD_Y], '…and the row is theirs, not the other store\'s');
      const picked = await get('yuexiu', `/api/retail-admin/dashboard/ops?store_id=${YUEXIU}`);
      is(picked.j && picked.j.data && picked.j.data.invoices && picked.j.data.invoices.count, 1,
        'passing their own store keeps that one');
      const other = await get('yuexiu', `/api/retail-admin/dashboard/ops?store_id=${TIANHE}`);
      is(other.status, 403, 'asking for the other store\'s dashboard is refused');
      const all = await get('owner', '/api/retail-admin/dashboard/ops');
      is(all.j && all.j.data && all.j.data.invoices && all.j.data.invoices.count, 2,
        'an unscoped login still sees both stores');
      const list = await get('yuexiu', '/api/retail-admin/invoices?status=requested');
      is((list.j && list.j.data || []).map(r => r.id), [ORD_Y], 'the invoices list is the same set');
      is(list.j && list.j.counts && list.j.counts.requested, 1, 'and its pending chip agrees');
      const dot = await get('yuexiu', '/api/retail-admin/invoices/unseen-count');
      is(dot.j && dot.j.data && dot.j.data.count, 1, 'the unseen dot does not count the other store');
    }

    section('4 · waste, purchases and transfers clamp the same way');
    {
      const w = await get('yuexiu', '/api/retail-admin/waste');
      is(w.status, 200, 'a pinned login reads the waste ledger');
      is(((w.j && w.j.data) || []).map(r => r.location_id).sort(), [YUEXIU], '…their store\'s losses only');
      const wOther = await get('yuexiu', `/api/retail-admin/waste?location_id=${TIANHE}`);
      is(wOther.status, 403, 'filtering the ledger to another store is refused');
      const p = await get('yuexiu', '/api/retail-admin/purchases');
      is(p.status, 200, 'a pinned login reads the purchase orders');
      is(((p.j && p.j.data) || []).map(o => o.id).sort(), [42, 43], '…their store\'s, plus the ones raised for no store');
      const pOther = await get('yuexiu', `/api/retail-admin/purchases?store_id=${TIANHE}`);
      is(pOther.status, 403, 'filtering purchases to another store is refused');
      const r = await get('yuexiu', '/api/restock?tab=all');
      is(r.status, 200, 'a pinned login reads the transfer list');
      is(((r.j && r.j.data) || []).map(o => o.id), [61], '…the transfer touching their store, sender or receiver');
      const rAct = await fetch(base + '/api/restock/62/status', {
        method: 'PUT',
        headers: { 'x-op': String(ops.yuexiu), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'delivered' }),
      });
      is(rAct.status, 403, 'a transfer between two other ends is not theirs to move');
      const rOwn = await fetch(base + '/api/restock/61/status', {
        method: 'PUT',
        headers: { 'x-op': String(ops.yuexiu), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'delivered' }),
      });
      const rOwnJ = await rOwn.json().catch(() => null);
      ok(rOwn.status !== 403 || (rOwnJ && rOwnJ.error !== 'forbidden_store'),
        '…while a transfer touching their store passes the gate', String(rOwn.status));
    }

    section('5 · the owner and the unscoped are unchanged');
    {
      const w = await get('owner', '/api/retail-admin/waste');
      is(((w.j && w.j.data) || []).length, 2, 'the owner still reads every store\'s ledger');
      const p = await get('owner', '/api/retail-admin/purchases');
      is(((p.j && p.j.data) || []).length, 3, '…and every purchase order');
    }
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
