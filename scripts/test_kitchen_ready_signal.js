#!/usr/bin/env node
/**
 * "The kitchen finished it" — the signal the warehouse never got.
 *
 *   node scripts/test_kitchen_ready_signal.js
 *
 * THE COMPLAINT. Ash, on the warehouse account: the kitchen prepares the goods
 * the warehouse asked for, the products are ready, and nothing anywhere says so.
 *
 * WHY IT WAS SILENT. warehouse→kitchen is the one direction with no second leg.
 * Nothing travels, so there is no dispatch, no van and no delivery to count in:
 * 'prepared' IS the closure (see the tab split in GET /api/restock). The request
 * simply stops moving, and the only announcement was a push — one moment, on one
 * phone, regularly in a pocket, on silent, or swiped off a lock screen. After
 * that neither app carried the fact at all: the person who raised it found out
 * by remembering to go and look, and there was nowhere to look.
 *
 * WHAT IS ASSERTED HERE is the endpoint the dot reads, and the single property
 * that makes a dot worth drawing — THAT IT CAN GO OUT, AND EVERYWHERE AT ONCE.
 * The count is a server-side fact (prepared, addressed to the kitchen, not
 * archived) rather than a per-device "last seen" stamp, so one person collecting
 * the tray clears it on every other phone. A localStorage stamp would have gone
 * out on one handset and lit again on the next, over work already done — which
 * is the defect scripts/test_mobile_dots.js exists because of.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);

/* THE OPERATOR THIS IS FOR, and the one it is not. A Tacet session's caps decide
 * whether routes/restock.js reads them as the person who ASKS (pick/request) or
 * as the person who MAKES (fulfil without pick — _kitchenScopedSession). The
 * fixture's own stubAuth pins req.caps to null, so this suite writes its own to
 * move an operator between the two sides mid-run. */
let CAPS = null;   // null = the tenant has not switched RBAC on: an owner
h.stub('routes/retail.js', {
  requireRetailAdmin: (req, _res, next) => {
    req.backendUser = req.user = { id: 7, username: 'wh', role: 'staff', display_name: 'WH' };
    req.caps = CAPS; req.scopeStores = null;
    next();
  },
});
h.stub('middleware/auth.js', {
  requireAuth: (req, _res, next) => {
    req.user = { id: 7, username: 'wh', role: 'staff' };
    req.permissions = { restock: 1, warehouse_inbox: 1, kitchen_inbox: 1 };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
  requireDelete: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  logActivity: () => {},
});

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const WH = 1, SHOP = 2;
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'wh','x','warehouse',?,1)`).run(WH);
// A real product on a real shelf, so the location→location case below can be
// created and dispatched for real rather than 500ing its way to a green tick.
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)")
  .run(String(WH));
F.setShelf(h.db, WH, 900, 100);
F.setShelf(h.db, SHOP, 900, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const readyCount = async () => (await call('GET', '/api/restock/kitchen-ready')).body?.data?.count;

// The warehouse asks the kitchen to make something — the shape "Ask the
// kitchen" posts (purpose is mandatory; the server refuses one without it).
async function askTheKitchen(name) {
  const r = await call('POST', '/api/restock', {
    to_role: 'kitchen', purpose: 'shelf', status: 'sent',
    items: [{ product_id: null, product_name: name, sku: 'P-1', qty_requested: 6 }],
  });
  return r.body.id;
}

(async () => {
  section('Nothing is waiting until the kitchen says so');

  eq(await readyCount(), 0, 'an empty tenant lights no dot');

  const id = await askTheKitchen('Hummus');
  ok(id > 0, 'the warehouse asks the kitchen for something');
  eq(await readyCount(), 0, 'asking is not the same as being told it is ready');

  eq((await call('PUT', `/api/restock/${id}/status`, { status: 'received' })).status, 200,
     'the kitchen picks the request up');
  eq(await readyCount(), 0, '"we have seen it" is still not "it is made"');

  section('It is made');

  eq((await call('PUT', `/api/restock/${id}/status`, { status: 'prepared' })).status, 200,
     'the kitchen marks it made');
  eq(await readyCount(), 1, 'and the dot lights for the side that asked');

  const latest = (await call('GET', '/api/restock/kitchen-ready')).body.data.latest;
  ok(!!latest, 'with the time it was made, so a screen can say when');

  section('And it can go out — everywhere, not just here');

  /* THE WHOLE POINT. Archiving is what "we have it" already means on this route,
     and it is a row in the database rather than a stamp in one browser: the next
     poll on every OTHER phone reads the same zero. */
  eq((await call('PUT', `/api/restock/${id}/archive`, { archived: true })).status, 200,
     'somebody collects it');
  eq(await readyCount(), 0, 'and the dot goes out for everyone at once');

  eq((await call('PUT', `/api/restock/${id}/archive`, { archived: false })).status, 200,
     'un-archiving is the same switch, backwards');
  eq(await readyCount(), 1, 'so a collection undone lights it again');

  section('Two requests, and only the finished one counts');

  const other = await askTheKitchen('Tortilla');
  eq(await readyCount(), 1, 'a second request still in the queue adds nothing');
  await call('PUT', `/api/restock/${other}/status`, { status: 'received' });
  await call('PUT', `/api/restock/${other}/status`, { status: 'prepared' });
  eq(await readyCount(), 2, 'and counts once the kitchen has made it too');

  section('A transfer between locations is not a kitchen request');

  // Same table, same statuses, different direction — and store→warehouse work
  // has its own screens, its own dot and its own audience. Counting it here
  // would put "the kitchen finished something" over a van.
  const transfer = await call('POST', '/api/restock', {
    from_store_id: WH, to_store_id: SHOP, status: 'sent',
    items: [{ product_id: 900, product_name: 'Hummus', sku: 'P-900', qty_requested: 6 }],
  });
  eq(transfer.status, 200, 'a store asks another location for stock');
  await call('PUT', `/api/restock/${transfer.body.id}/status`, { status: 'received' });
  await call('PUT', `/api/restock/${transfer.body.id}/status`, { status: 'prepared' });
  eq(await readyCount(), 2, 'a dispatched transfer does not light the kitchen dot');

  section('The maker is not the audience');

  /* An operator holding fulfil and NOT pick is the person who marked it made.
     Telling them their own work is waiting is telling them about themselves —
     and an honest zero rather than a 403, because this is polled in the
     background and a refusal there bounces a phone to the login screen out of
     somebody's pocket. */
  CAPS = new Set(['restock:fulfil', 'quickstock:add']);
  eq(await readyCount(), 0, 'the kitchen is not told its own output is waiting');
  eq((await call('GET', '/api/restock/kitchen-ready')).status, 200,
     'and is answered rather than refused — a 403 in a heartbeat is a logout');

  CAPS = new Set(['restock:request', 'restock:pick']);
  eq(await readyCount(), 2, 'the side that asked still sees all of it');

  section('The route is reachable at all');

  // /api/restock/:id sits directly below this one and would happily match the
  // word 'kitchen-ready', answer 404 for a row with that id, and leave the dot
  // permanently dark with nothing anywhere saying why.
  const r = await call('GET', '/api/restock/kitchen-ready');
  eq(r.status, 200, 'the name is not swallowed by /api/restock/:id');
  ok(r.body && r.body.data && typeof r.body.data.count === 'number', 'and it answers a number');

  server.close();
  done();
})();
