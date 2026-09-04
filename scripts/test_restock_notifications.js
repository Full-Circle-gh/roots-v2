#!/usr/bin/env node
/**
 * WHO IS TOLD WHEN STOCK MOVES — the transfer notifications, end to end.
 *
 *   node scripts/test_restock_notifications.js
 *
 * THE DEFECT THIS LOCKS DOWN. Every push on /api/restock went out through
 * sendPushByPermission, which reads `permissions` rows on the kitchen `users`
 * table — the only realm these endpoints had when the notifications were
 * written. The screens then moved to Tacet (#261): the people who raise a
 * request, pick a run, dispatch it, count it in and work the kitchen queue are
 * `tenant_users` with CAPABILITIES, and their devices are subscribed in a
 * different table. Nothing addressed to a kitchen permission could reach any of
 * them. The kitchen was never told a request had arrived; neither end of a
 * transfer was told the goods were ready, gone, or counted. Counting a delivery
 * in — PUT /:id/receive — fired no push at all, in either realm.
 *
 * Two halves, because two things had to be true and only one of them is visible
 * from the route:
 *
 *   PART A  the ROUTE addresses the right audience for every event, at the
 *           right location, with a door onto the screen the work is on.
 *   PART B  the SENDER can actually find those people: capabilities resolved
 *           per operator, store scope honoured, the actor left alone, and a
 *           muted device still muted.
 *   PART C  the roles that do this work hold the capabilities being addressed.
 *           Part A and Part B were both green while every stock role held none
 *           of them, which is precisely how a notification reaches nobody.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
const notes = F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'wh', role: 'staff', display_name: 'WH' },
  { restock: 1, warehouse_inbox: 1, kitchen_inbox: 1 }, 'tacet');

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
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)").run(String(WH));
F.setShelf(h.db, WH, 900, 100);
F.setShelf(h.db, SHOP, 900, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const last = () => notes.operator[notes.operator.length - 1];
const capsOf = (n) => (Array.isArray(n.caps) ? n.caps : [n.caps]).join('+');

(async () => {
  section('Part A · the audience, per event');

  // ── A store asks another location for stock (#264's shape, and the one the
  //    "Ask for stock" tile posts): both ends named, from = who supplies.
  notes.operator.length = 0;
  const ask = await call('POST', '/api/restock', {
    from_store_id: WH, to_store_id: SHOP, status: 'sent',
    items: [{ product_id: 900, product_name: 'Hummus', sku: 'P-900', qty_requested: 6 }],
  });
  eq(ask.status, 200, 'a request is raised');
  const id = ask.body.id;
  eq(notes.operator.length, 1, 'raising it notified the operators');
  eq(capsOf(last()), 'restock:pick', 'the location that HAS the stock is asked to pick it');
  eq(last().opts.storeId, WH, 'at the supplying location, not the asking one');
  eq(last().msg.url, '/stock?go=pick', 'and the notification opens the run, not a menu');
  // The body names the end the reader is NOT at. store_name is free text that a
  // store→store ask never sets, so the order's own locations have to answer it.
  const shopName = h.db.prepare('SELECT name_en FROM retail_stores WHERE id = ?').get(SHOP).name_en;
  ok(last().msg.body.indexOf('For ' + shopName) === 0, 'and it says who the run is for — "' + last().msg.body + '"');
  eq(last().opts.excludeTenantUserId, 7, 'the person who pressed the button is left alone');

  // ── Picked and dispatched. The goods are on their way to whoever asked.
  await call('PUT', `/api/restock/${id}/status`, { status: 'received' });
  notes.operator.length = 0;
  eq((await call('PUT', `/api/restock/${id}/status`, { status: 'prepared' })).status, 200, 'the run is dispatched');
  eq(notes.operator.length, 1, 'dispatch notified the operators');
  eq(capsOf(last()), 'restock:receive', 'the far end is told to expect it');
  eq(last().opts.storeId, SHOP, 'at the destination');
  eq(last().msg.url, '/stock?go=receive', 'opening the delivery waiting to be counted');

  // ── THE ONE THAT SENT NOTHING AT ALL. Counting a delivery in is the close-out
  //    the sender waits for, and PUT /:id/receive had no push of any kind.
  notes.operator.length = 0;
  const item = h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ?').get(id);
  const got = await call('PUT', `/api/restock/${id}/receive`, { counts: [{ item_id: item.id, qty_received: 6 }] });
  eq(got.status, 200, 'the delivery is counted in');
  ok(got.body.settled, 'and settles');
  eq(notes.operator.length, 1, 'counting it in notified the sender — it used to notify nobody');
  eq(capsOf(last()), 'restock:pick', 'the sender gets the close-out');
  eq(last().opts.storeId, WH, 'at the location the goods left');

  section('Part B · a kitchen request');

  notes.operator.length = 0;
  const kitchen = await call('POST', '/api/restock', {
    to_role: 'kitchen', purpose: 'shelf', status: 'sent',
    items: [{ product_name: 'Falafel mix', qty_requested: 4 }],
  });
  eq(kitchen.status, 200, 'the kitchen is asked for something');
  const kid = kitchen.body.id;
  eq(capsOf(last()), 'restock:fulfil', 'the people who work the queue are told');
  eq(last().opts.storeId, null, 'the kitchen is not a store, so nothing is store-scoped');
  eq(last().msg.url, '/stock?go=queue', 'and it opens the queue');

  notes.operator.length = 0;
  eq((await call('PUT', `/api/restock/${kid}/status`, { status: 'prepared' })).status, 200, 'the kitchen makes it');
  eq(capsOf(last()), 'restock:request+restock:pick', 'the side that asked is told it is ready');
  ok(/is made|制作完成/.test(last().msg.title), 'and it says the food is made, not "ready to receive"');

  section('Part C · the sender can find those people');

  // The real function this time, over real rows. Its own tenant/user/sub set,
  // so nothing here depends on the fixture's stub.
  const webpushPath = require.resolve('web-push');
  const sends = [];
  require.cache[webpushPath] = {
    id: webpushPath, filename: webpushPath, path: path.dirname(webpushPath), loaded: true, children: [], paths: [],
    exports: {
      setVapidDetails: () => {},
      sendNotification: (sub, payload) => { sends.push({ endpoint: sub.endpoint, payload }); return Promise.resolve(); },
    },
  };
  process.env.VAPID_PUBLIC_KEY = 'test-public';
  process.env.VAPID_PRIVATE_KEY = 'test-private';
  delete require.cache[require.resolve(path.join(h.REPO, 'routes/push.js'))];
  const push = require(path.join(h.REPO, 'routes/push.js'));
  ok(push.ENABLED, 'push is on for this part');

  // The control-plane tables (tenants, tenant_users, the operator subscription
  // store) are created at load by the module that owns them, not by schema.sql.
  require(path.join(h.REPO, 'routes/backend-auth.js'));
  h.db.prepare("INSERT OR IGNORE INTO tenants (id, name, status) VALUES (9,'Test tenant','active')").run();
  const mkOp = (id, role, storeId, scopeAll) => {
    h.db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, retail_store_id, scope_all, is_active)
                  VALUES (?,9,?,'x',?,?,?,1)`).run(id, 'op' + id, role, storeId, scopeAll);
    h.db.prepare(`INSERT INTO tenant_operator_push_subs (endpoint, tenant_user_id, tenant_id, p256dh, auth)
                  VALUES (?,?,9,'k','a')`).run('ep-' + id, id);
  };
  mkOp(101, 'warehouse', WH, 1);       // picks and dispatches, sees every store
  mkOp(102, 'customer_service', null, 1); // holds no transfer capability at all
  mkOp(103, 'warehouse', SHOP, 0);     // pinned to the SHOP only
  h.db.prepare('INSERT INTO tenant_user_stores (tenant_user_id, store_id) VALUES (103, ?)').run(SHOP);

  const fired = async (opts) => {
    sends.length = 0;
    await push.sendPushToOperatorsWithCaps(9, 'restock:pick', { title: 't', body: 'b', url: '/stock' }, opts || {});
    return sends.map(s => s.endpoint).sort();
  };

  eq((await fired({})).join(','), 'ep-101,ep-103', 'every operator whose role picks is reached');
  ok((await fired({})).indexOf('ep-102') === -1, 'and one whose role does not is not');
  eq((await fired({ storeId: WH })).join(','), 'ep-101', 'a store-pinned operator is not told about another store');
  eq((await fired({ storeId: SHOP })).join(','), 'ep-101,ep-103', 'and IS told about their own');
  eq((await fired({ excludeTenantUserId: 101 })).join(','), 'ep-103', 'the actor is left out');

  // The mute goes through _sendMany like every other operator send.
  h.db.prepare("INSERT INTO push_optouts (scope, subject_id) VALUES ('operator', 103)").run();
  eq((await fired({})).join(','), 'ep-101', 'a device switched off stays off');
  h.db.prepare("DELETE FROM push_optouts WHERE scope='operator' AND subject_id=103").run();

  section('Part D · the roles that do the work hold the capabilities');

  const caps = require(path.join(h.REPO, 'lib/capabilities.js'));
  const held = (role) => caps.presetCapsFor(role).filter(k => k.startsWith('restock:')).sort();
  eq(held('warehouse').join(','), 'restock:pick,restock:receive,restock:request',
     'the stockroom picks, receives and asks — its description always said so');
  eq(held('store_manager').join(','), 'restock:pick,restock:receive,restock:request',
     'a store can be asked as well as ask, so it can pick too');
  eq(held('store_stock').join(','), 'restock:receive,restock:request',
     'the shelf clerk asks and counts in, and does not dispatch');
  ok(held('warehouse').indexOf('restock:fulfil') === -1,
     'and nobody but the kitchen works the kitchen queue — fulfil-without-pick is what confines them');

  // The backfill, for tenants seeded before the presets gained these.
  const roles = require(path.join(h.REPO, 'lib/roles.js'));
  roles.ensureSchema();
  h.db.prepare('DELETE FROM _migrations WHERE name = ?').run(roles.RESTOCK_CAP_MIGRATION);
  h.db.prepare(`INSERT OR REPLACE INTO tenant_roles (tenant_id, role_key, name_en, name_cn, caps_json, sort_order)
                VALUES (9,'warehouse','Warehouse','仓库',?,40)`).run(JSON.stringify(['dashboard:view', 'quickstock:recount']));
  const granted = roles.migrateRestockCaps();
  ok(granted >= 1, 'the backfill grants a role seeded before the capabilities existed');
  const after = JSON.parse(h.db.prepare("SELECT caps_json FROM tenant_roles WHERE tenant_id=9 AND role_key='warehouse'").get().caps_json);
  ok(['restock:request', 'restock:pick', 'restock:receive'].every(k => after.indexOf(k) !== -1),
     'and it holds all three afterwards');
  ok(after.indexOf('quickstock:recount') !== -1, 'without dropping what it already had');
  eq(roles.migrateRestockCaps(), 0, 'and it is once-only — a role ticked back off stays off');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
