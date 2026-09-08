#!/usr/bin/env node
/**
 * test_shop_events.js — who the counter's doorbell reaches, and who it must not.
 *
 *   node scripts/test_shop_events.js
 *
 * routes/shop-events.js pushes "an order just arrived" to open tills. It is a
 * SECOND SSE registry beside routes/events.js, and it exists because that one
 * is behind requireAuth (a global `users` row, which a tenant operator does not
 * have) and because its subscriber records carry no tenant at all.
 *
 * WHICH MAKES THE FAN-OUT THE WHOLE RISK. A registry that another tenant's
 * socket can be reached from is a data leak with a friendly name, and the bug
 * would be invisible on any single-tenant box — including every developer's.
 * So the targeting is driven here rather than read: real sockets, real HTTP,
 * four subscribers on two tenants, and an assertion about each one.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. A SECOND TENANT NEVER HEARS THE FIRST. The one that matters.
 *  2. A TILL LOCKED TO ANOTHER SHOP DOES NOT WAKE for a shop it is not at —
 *     two shops on one tenant share a process and a registry.
 *  3. THE EVENT CARRIES NO ORDER. Only a store id crosses the socket, so the
 *     till has to re-read through the endpoint that enforces the capability.
 *     If an order body ever appears on this channel, that guarantee is gone
 *     and this goes red.
 *  4. A CLOSED SOCKET IS FORGOTTEN, so a shift's worth of reconnects does not
 *     leave the process writing to dead sockets forever.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// Stub the two lazy requires BEFORE shop-events is loaded, so the real
// routes/retail.js (36k lines and a database) never has to boot for this.
let TENANT = 1;
const retailPath = path.join(ROOT, 'routes/retail.js');
require.cache[retailPath] = {
  id: retailPath, filename: retailPath, loaded: true, exports: {
    // Pass-through: authentication is not what this file is about.
    requireRetailAdmin: (req, res, next) => next(),
  },
};
const tenantDbPath = path.join(ROOT, 'lib/tenant-db.js');
require.cache[tenantDbPath] = {
  id: tenantDbPath, filename: tenantDbPath, loaded: true, exports: {
    currentTenantId: () => TENANT,
  },
};

const shopEvents = require(path.join(ROOT, 'routes/shop-events.js'));

let pass = 0, fail = 0;
function yes(cond, label, why) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (why ? '\n        ' + why : '')); }
}

// One subscriber: opens the SSE route and collects whatever the server writes.
function subscribe(port, tenant, storeId) {
  TENANT = tenant;                                   // read at subscribe time
  return new Promise((resolve) => {
    const q = storeId == null ? '' : '?store_id=' + storeId;
    const req = http.get({ port, path: '/api/retail-admin/shop-events' + q }, (res) => {
      const sub = { status: res.statusCode, chunks: [], res, req };
      res.setEncoding('utf8');
      res.on('data', (c) => sub.chunks.push(c));
      // Resolve on the ': connected' preamble, so the subscriber is REGISTERED
      // before the broadcast fires. Resolving on headers alone races it.
      const onFirst = () => { res.off('data', onFirst); resolve(sub); };
      res.on('data', onFirst);
    });
    req.on('error', () => resolve({ status: 0, chunks: [], req }));
  });
}
const events = (sub) => sub.chunks.join('').split('\n\n')
  .filter((b) => b.indexOf('event: shop-order') >= 0);

(async () => {
  const app = express();
  app.use(shopEvents);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  console.log('\nThe counter doorbell — fan-out targeting\n');

  const t1s7  = await subscribe(port, 1, 7);    // tenant 1, shop 7
  const t1s9  = await subscribe(port, 1, 9);    // tenant 1, a different shop
  const t1any = await subscribe(port, 1, null); // tenant 1, no shop chosen yet
  const t2s7  = await subscribe(port, 2, 7);    // ANOTHER TENANT, same shop id

  yes([t1s7, t1s9, t1any, t2s7].every((s) => s.status === 200),
    'every till gets a stream');

  // An order lands at shop 7 on tenant 1.
  shopEvents.shopOrderPlaced(1, 7);
  await new Promise((r) => setTimeout(r, 60));

  yes(events(t1s7).length === 1, 'the till AT that shop is rung');
  yes(events(t1s9).length === 0, 'a till at another shop on the same tenant is NOT',
    'two shops share one process; a doorbell on every counter is noise at best');
  yes(events(t1any).length === 1, 'a till with no shop chosen yet still hears it',
    'it has no list to filter, so it re-reads and finds out');
  yes(events(t2s7).length === 0, 'ANOTHER TENANT HEARS NOTHING, same store id or not',
    'store ids are per-tenant; matching on one alone would cross the boundary');

  // 3. The payload is a doorbell, not a delivery.
  const body = events(t1s7)[0] || '';
  yes(/data: \{"store_id":7\}/.test(body), 'the payload names the shop and nothing else');
  yes(!/order_no|total|recipient|items|shop_order_code/i.test(body),
    'no order data crosses the socket',
    'the till re-reads through the endpoint that enforces tenant + capability');

  // 4. A dropped socket is forgotten.
  const before = shopEvents.subscriberCount();
  t1s9.req.destroy();
  await new Promise((r) => setTimeout(r, 80));
  yes(shopEvents.subscriberCount() === before - 1,
    'a closed socket is dropped from the registry',
    `count went ${before} -> ${shopEvents.subscriberCount()}`);

  // A tenant that cannot be resolved must be refused, not silently unscoped:
  // an unscoped subscriber is the leak this whole file is about.
  TENANT = null;
  const orphan = await new Promise((resolve) => {
    http.get({ port, path: '/api/retail-admin/shop-events' }, (res) => {
      resolve(res.statusCode); res.resume();
    }).on('error', () => resolve(0));
  });
  yes(orphan === 409, 'a stream with no resolvable tenant is refused', `got ${orphan}`);

  // And a broadcast with no tenant reaches nobody, rather than everybody.
  TENANT = 1;
  const t1b = await subscribe(port, 1, 7);
  shopEvents.shopOrderPlaced(null, 7);
  await new Promise((r) => setTimeout(r, 60));
  yes(events(t1b).length === 0, 'a broadcast with no tenant reaches nobody');

  [t1s7, t1any, t2s7, t1b].forEach((s) => { try { s.req.destroy(); } catch (e) {} });
  server.close();

  console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
  process.exit(fail ? 1 : 0);
})();
