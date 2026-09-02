#!/usr/bin/env node
// Restock, end to end, on tenant 1 — the REGRESSION half.
//
// READ THIS BEFORE TRUSTING A GREEN RUN HERE.
// -------------------------------------------
// Every assertion in this file passes on the pre-1588d18 code, which read and
// wrote restock through the shared global handle while the stock movement it
// triggers went through inventory.adjustStock on tdb(). For tenant 1 those are
// the same connection, so a query on the wrong handle still hits the right
// rows. This suite cannot see that bug, and no tenant-1 suite can.
//
// scripts/test_restock_tenant2_split.js is the half that catches it. This file
// exists for the other job: proving the handle change did not alter behaviour —
// the quantities, the ledger, the idempotency stamp, the catalogue guard and
// the notification audiences are all still exactly what they were.
//
// Run:  npm run test:restock-handles     (both suites)
//       node scripts/test_restock_tenant_handle.js
//
// Cases:
//   1. warehouse → store, draft → sent → received → prepared, then a
//      delivered retry that must move nothing
//   2. the cross-catalogue id guard refuses a SKU mismatch, all-or-nothing
//   3. SSE + push fire to the audiences they fired to before
//   4. a mid-transfer failure rolls back the stock AND the stamp
//   5. the handle split itself: only control-plane queries left on `db`
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();                      // must come before any route require
const notes = F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'wh', role: 'warehouse', display_name: 'WH' });

const express = require('express');
const app = express();
app.use(express.json());
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

// ── seed ────────────────────────────────────────────────────────────────────
// Both stores exist already on a fresh database: seed_default_store_v1 creates
// id 1, seed_yuexiu_store_v1 creates id 2.
const WH = 1, SHOP = 2;
const SHOP_NAME = h.db.prepare('SELECT name_en FROM retail_stores WHERE id = ?').get(SHOP).name_en;

// _resolveWarehouseStoreId finds the source through a warehouse-role user's
// binding. `users` is control-plane, so this row goes in the shared database.
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'wh','x','warehouse',?,1)`).run(WH);

F.seedProduct(h.db, { id: 900, name: 'Hummus',   sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Tortilla', sku: 'P-901' });
// Same id on both sides, different SKU: the trap _checkTransferIds is for. The
// FK is satisfied either way, so nothing errors — the units would simply land
// on the wrong product's shelf.
F.seedProduct(h.db, { id: 902, name: 'Falafel', sku: 'P-902', storeName: 'Pickles', storeSku: 'S-902' });

F.setShelf(h.db, WH, 900, 100); F.setShelf(h.db, WH, 901, 50); F.setShelf(h.db, WH, 902, 20);
F.setShelf(h.db, SHOP, 900,  5); F.setShelf(h.db, SHOP, 901, 0); F.setShelf(h.db, SHOP, 902, 1);

const shelf  = (s, p) => F.shelf(h.db, s, p);
const ledger = (s, p) => F.ledgerFor(h.db, s, p);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  section('Case 1 — warehouse → store, draft → sent → received → prepared');
  const created = await call('POST', '/api/restock', {
    to_role: 'store', store_name: SHOP_NAME,
    items: [
      { product_id: 900, product_name: 'Hummus',   sku: 'P-900', qty_requested: 12 },
      { product_id: 901, product_name: 'Tortilla', sku: 'P-901', qty_requested: 30 },
    ],
  });
  eq(created.status, 200, 'order created');
  const id = created.body.id;
  const dir = h.db.prepare('SELECT from_role, to_role FROM restock_orders WHERE id = ?').get(id);
  eq(dir.from_role, 'warehouse', 'from_role');
  eq(dir.to_role,   'store',     'to_role');

  for (const s of ['sent', 'received']) {
    eq((await call('PUT', `/api/restock/${id}/status`, { status: s })).status, 200, `status → ${s}`);
  }
  eq(shelf(WH, 900),  100, 'source untouched before prepared');
  eq(shelf(SHOP, 900),  5, 'destination untouched before prepared');

  // Short-ship line 1: 10 of the 12 requested. qty_sent must win over qty_requested.
  const item900 = h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ? AND product_id = 900').get(id);
  await call('PUT', `/api/restock/${id}/item/${item900.id}`, { is_checked: 1, qty_sent: 10 });

  const prepared = await call('PUT', `/api/restock/${id}/status`, { status: 'prepared' });
  eq(prepared.status, 200, 'status → prepared');
  ok(!prepared.body.stock_transfer, 'no stock_transfer error returned');

  eq(shelf(WH,   900), 90, 'source 900 decremented by qty_sent (100 − 10)');
  eq(shelf(SHOP, 900), 15, 'destination 900 incremented by qty_sent (5 + 10)');
  eq(shelf(WH,   901), 20, 'source 901 decremented by qty_requested (50 − 30)');
  eq(shelf(SHOP, 901), 30, 'destination 901 incremented by qty_requested (0 + 30)');

  const lOut = ledger(WH, 900), lIn = ledger(SHOP, 900);
  eq(lOut.length, 1, 'one ledger row at source for 900');
  eq(lIn.length,  1, 'one ledger row at destination for 900');
  eq(lOut[0].delta, -10, 'source delta');
  eq(lOut[0].reason, 'restock_transfer_out', 'source reason');
  eq(lOut[0].balance_after, 90, 'source balance_after');
  eq(lIn[0].delta, 10, 'destination delta');
  eq(lIn[0].reason, 'restock_transfer_in', 'destination reason');
  eq(lIn[0].balance_after, 15, 'destination balance_after');
  eq(lOut[0].actor_user_id, 7, 'ledger records the actor');
  const rs = h.db.prepare('SELECT rs_number FROM restock_orders WHERE id = ?').get(id).rs_number;
  eq(lOut[0].note, rs, 'ledger note carries the RS number');

  const stampedAt = h.db.prepare('SELECT stock_applied_at FROM restock_orders WHERE id = ?').get(id).stock_applied_at;
  ok(!!stampedAt, 'stock_applied_at is set');

  eq((await call('PUT', `/api/restock/${id}/status`, { status: 'delivered' })).status, 200, 'status → delivered');
  eq(shelf(WH, 900),  90, 'source unchanged by the delivered retry');
  eq(shelf(SHOP, 900), 15, 'destination unchanged by the delivered retry');
  eq(ledger(WH, 900).length,  1, 'no extra source ledger row from the retry');
  eq(ledger(SHOP, 900).length, 1, 'no extra destination ledger row from the retry');
  eq(h.db.prepare('SELECT stock_applied_at FROM restock_orders WHERE id = ?').get(id).stock_applied_at,
     stampedAt, 'stock_applied_at not re-stamped');

  section('Case 2 — the cross-catalogue guard refuses a SKU mismatch');
  const whBefore = shelf(WH, 902), shopBefore = shelf(SHOP, 902);
  const bad = await call('POST', '/api/restock', {
    to_role: 'store', store_name: SHOP_NAME,
    items: [
      { product_id: 900, product_name: 'Hummus',  sku: 'P-900', qty_requested: 1 },
      { product_id: 902, product_name: 'Falafel', sku: 'P-902', qty_requested: 3 },
    ],
  });
  const badId = bad.body.id;
  for (const s of ['sent', 'received']) await call('PUT', `/api/restock/${badId}/status`, { status: s });
  const badPrep = await call('PUT', `/api/restock/${badId}/status`, { status: 'prepared' });
  ok(badPrep.body.stock_transfer && badPrep.body.stock_transfer.ok === false,
     'transfer refused and reported to the caller');
  const err = badPrep.body.stock_transfer.error || '';
  ok(/P-902/.test(err) && /S-902/.test(err), 'error names both conflicting SKUs');
  eq(shelf(WH, 902),   whBefore,   'mismatched line moved nothing at source');
  eq(shelf(SHOP, 902), shopBefore, 'mismatched line moved nothing at destination');
  eq(shelf(WH, 900), 90, 'the GOOD line in a refused order also moved nothing (all-or-nothing)');
  ok(!h.db.prepare('SELECT stock_applied_at FROM restock_orders WHERE id = ?').get(badId).stock_applied_at,
     'refused order is NOT stamped, so it stays retryable');

  section('Case 3 — SSE + push audience');
  const kinds = notes.sse.filter(c => c.payload && c.payload.id === id).map(c => c.payload.kind);
  ok(kinds.includes('sent') && kinds.includes('prepared') && kinds.includes('delivered'),
     'SSE fired for sent + prepared + delivered');
  ok(!kinds.includes('received'), 'SSE did NOT fire for received (internal warehouse state)');
  const permFor = (k) => {
    const c = notes.sse.find(x => x.payload && x.payload.id === id && x.payload.kind === k);
    return c && c.opts && c.opts.perms ? c.opts.perms[0] : undefined;
  };
  eq(permFor('sent'),      'restock',         'SSE audience for sent');
  eq(permFor('prepared'),  'warehouse_inbox', 'SSE audience for prepared');
  eq(permFor('delivered'), 'warehouse_inbox', 'SSE audience for delivered');
  const perms = notes.push.map(c => c.perm);
  ok(perms.includes('restock') && perms.includes('warehouse_inbox'),
     'push fired to the restock + warehouse_inbox audiences');
  const sentPush = notes.push.find(c => /New restock/.test(c.msg.title));
  ok(sentPush && /2 items/.test(sentPush.msg.body), 'push body carries the item summary');

  section('Case 4 — a mid-transfer failure rolls back the stock AND the stamp');
  // A trigger that aborts the SECOND line's inbound ledger row, so the first
  // line's writes have already succeeded when the failure lands.
  h.db.exec(`CREATE TRIGGER _boom BEFORE INSERT ON retail_stock_ledger
             WHEN NEW.product_id = 901 AND NEW.reason = 'restock_transfer_in'
             BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END`);
  const a = { wh900: shelf(WH, 900), sh900: shelf(SHOP, 900), wh901: shelf(WH, 901), sh901: shelf(SHOP, 901) };
  const boom = await call('POST', '/api/restock', {
    to_role: 'store', store_name: SHOP_NAME,
    items: [
      { product_id: 900, product_name: 'Hummus',   sku: 'P-900', qty_requested: 4 },
      { product_id: 901, product_name: 'Tortilla', sku: 'P-901', qty_requested: 7 },
    ],
  });
  const boomId = boom.body.id;
  for (const s of ['sent', 'received']) await call('PUT', `/api/restock/${boomId}/status`, { status: s });
  const boomPrep = await call('PUT', `/api/restock/${boomId}/status`, { status: 'prepared' });
  ok(boomPrep.body.stock_transfer && boomPrep.body.stock_transfer.ok === false,
     'mid-transfer failure reported to the caller');
  eq(shelf(WH, 900),   a.wh900, 'line 1 source rolled back (its writes had already succeeded)');
  eq(shelf(SHOP, 900), a.sh900, 'line 1 destination rolled back');
  eq(shelf(WH, 901),   a.wh901, 'line 2 source rolled back');
  eq(shelf(SHOP, 901), a.sh901, 'line 2 destination rolled back');
  ok(!h.db.prepare('SELECT stock_applied_at FROM restock_orders WHERE id = ?').get(boomId).stock_applied_at,
     'stock_applied_at rolled back with the stock — the order stays retryable');
  h.db.exec('DROP TRIGGER _boom');
  eq((await call('PUT', `/api/restock/${boomId}/status`, { status: 'delivered' })).status, 200,
     'retry at delivered succeeds once the cause is fixed');
  eq(shelf(WH, 901),   a.wh901 - 7, 'retry moved line 2 out of source');
  eq(shelf(SHOP, 901), a.sh901 + 7, 'retry moved line 2 into destination');

  section('Case 5 — the handle split itself');
  const T = require(path.join(h.REPO, 'lib/tenant-db.js'));
  // tdb() is a seam-wrapped handle (lib/db-seam.js), not the raw object, so the
  // identity check is against rawTdb(). Same underlying connection either way,
  // which is what makes the transaction boundary and adjustStock's writes one unit.
  ok(T.rawTdb() === h.db, 'tdb() wraps the same connection as the shared db for tenant 1');
  const src = require('fs').readFileSync(path.join(h.REPO, 'routes/restock.js'), 'utf8').split('\n');
  const stray = src.map((l, i) => ({ n: i + 1, l }))
                   .filter(o => /(^|[^t])\bdb\.(prepare|transaction|exec)\b/.test(o.l));
  const stmtAt = (n) => src.slice(n - 1, n + 3).join(' ');
  ok(stray.length > 0 && stray.every(o => /\busers\b/.test(stmtAt(o.n))),
     'every remaining shared-handle call in routes/restock.js is a control-plane `users` query');
  console.log('    remaining shared-handle lines: ' + stray.map(o => o.n).join(', '));

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
