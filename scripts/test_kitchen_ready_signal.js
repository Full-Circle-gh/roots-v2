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
 * THERE IS NOTHING TO COLLECT, and the first cut of this assumed there was. It
 * counted unarchived rows and cleared on a "Collected" button, which invented a
 * step Roots does not have: the kitchen puts what it makes straight on the shelf
 * and records the stock itself. Ash, reading the tile on the warehouse account:
 * "the only thing needed is that the warehouse knows the kitchen handled his
 * request." So the fact is SEEN, not done.
 *
 * WHAT IS ASSERTED HERE is the endpoint the dot reads, and the single property
 * that makes a dot worth drawing — THAT IT CAN GO OUT, AND EVERYWHERE AT ONCE.
 * `seen_at` is a server-side fact rather than a per-device stamp, so one person
 * opening the list clears it on every other phone. A localStorage stamp would
 * have gone out on one handset and lit again on the next, sending the next
 * person to check on something the team already knew — which is the defect
 * scripts/test_mobile_dots.js exists because of.
 *
 * AND THAT IT ONLY CLEARS WHAT WAS ACTUALLY SHOWN. The kitchen can finish
 * something in the seconds between the list rendering and the stamp landing, and
 * a blanket "mark everything seen" would silently clear a request nobody has
 * laid eyes on — the one failure that would make the dot worth ignoring.
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

  /* THE WHOLE POINT. Reading it is the acknowledgement, and the read is a row in
     the database rather than a stamp in one browser: the next poll on every
     OTHER phone reads the same zero. */
  const seen = await call('POST', '/api/restock/kitchen-ready/seen', { ids: [id] });
  eq(seen.status, 200, 'somebody opens the list');
  eq(seen.body.data.seen, 1, 'and the one they were shown is marked read');
  eq(await readyCount(), 0, 'so the dot goes out for everyone at once');

  // Nobody is asked to confirm anything, so re-opening the screen must be free.
  const again = await call('POST', '/api/restock/kitchen-ready/seen', { ids: [id] });
  eq(again.body.data.seen, 0, 'looking twice changes nothing');
  eq(await readyCount(), 0, 'and does not re-light it');

  /* BEING READ IS NOT BEING HIDDEN. Archiving is a different fact and this
     screen is a RECORD — "what did the kitchen make today" has to still answer
     the day after somebody glanced at it. */
  const hist = await call('GET', '/api/restock?to_role=kitchen&tab=history');
  ok((hist.body.data || []).some(o => o.id === id),
     'and the request is still in the history it was read from');

  section('Two requests, and only the finished one counts');

  const other = await askTheKitchen('Tortilla');
  eq(await readyCount(), 0, 'a second request still in the queue adds nothing');
  await call('PUT', `/api/restock/${other}/status`, { status: 'received' });
  await call('PUT', `/api/restock/${other}/status`, { status: 'prepared' });
  eq(await readyCount(), 1, 'and lights the dot once the kitchen has made it too');

  section('It marks what was on the screen, and nothing else');

  /* THE RACE THIS EXISTS FOR. The kitchen can finish something between the list
     rendering and the stamp landing. A blanket "mark everything seen" would
     clear a request nobody has laid eyes on — a dot that lies once is a dot
     everybody learns to ignore. So the client sends the ids it drew. */
  const late = await askTheKitchen('Pita');
  await call('PUT', `/api/restock/${late}/status`, { status: 'received' });
  await call('PUT', `/api/restock/${late}/status`, { status: 'prepared' });
  eq(await readyCount(), 2, 'two are unread — one of them arrived a moment ago');

  const partial = await call('POST', '/api/restock/kitchen-ready/seen', { ids: [other] });
  eq(partial.body.data.seen, 1, 'the screen stamps only the one it showed');
  eq(await readyCount(), 1, 'and the one that landed after it is still unread');

  // An empty list is not "mark everything": it is a screen with nothing on it.
  const none = await call('POST', '/api/restock/kitchen-ready/seen', { ids: [] });
  eq(none.body.data.seen, 0, 'an empty screen marks nothing');
  eq(await readyCount(), 1, 'and leaves the unread one alone');

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
  eq(await readyCount(), 1, 'a dispatched transfer does not light the kitchen dot');

  section('The maker is not the audience');

  /* An operator holding fulfil and NOT pick is the person who marked it made.
     Telling them their own work is unread is telling them about themselves —
     and an honest zero rather than a 403, because this is polled in the
     background and a refusal there bounces a phone to the login screen out of
     somebody's pocket. */
  CAPS = new Set(['restock:fulfil', 'quickstock:add']);
  eq(await readyCount(), 0, 'the kitchen is not told about its own output');
  eq((await call('GET', '/api/restock/kitchen-ready')).status, 200,
     'and is answered rather than refused — a 403 in a heartbeat is a logout');

  // And it cannot mark the asker's dot read on their behalf, which would put the
  // signal out for a warehouse that has still not been told.
  const makerSeen = await call('POST', '/api/restock/kitchen-ready/seen', { ids: [late] });
  eq(makerSeen.body.data.seen, 0, 'nor can it read the news on the asker\'s behalf');

  CAPS = new Set(['restock:request', 'restock:pick']);
  eq(await readyCount(), 1, 'the side that asked is still the side that is told');

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
