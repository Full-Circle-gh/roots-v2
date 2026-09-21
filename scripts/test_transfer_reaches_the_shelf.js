#!/usr/bin/env node
/**
 * A STOCK REQUEST THAT SAYS "SENT" HAS ACTUALLY LEFT THE SHELF (§200).
 *
 *   node scripts/test_transfer_reaches_the_shelf.js
 *
 * THE REPORT THIS PINS, and it is the one §198 did not reach. Ash raised
 * RS-260920-001 — one banana, Yuexiu asking Tianhe. Tianhe picked it and
 * pressed Send. The request read PREPARED. Yuexiu's *Receive from another
 * shop* screen said "Nothing on its way", and would have said that for ever.
 *
 * THE CHAIN, AND EVERY LINK OF IT IS A PART BELOW:
 *
 *   PART A  the phone sent `product_id: null` on every line it raised. That is
 *           the cause, and it is one line of public/m.html.
 *   PART B  `_applyDispatch` moves only lines that carry a product id, so the
 *           order had ZERO movable lines — and returned ok:TRUE. That is the
 *           silence, and it is the half that matters most: whatever makes a
 *           line unmovable next time, the person who pressed Send must be told
 *           rather than the goods quietly not going.
 *   PART C  with an id, the stock actually leaves the supplier, `goods_state`
 *           becomes 'in_transit', and the order appears at the far end where
 *           somebody can count it in. This is the assertion that would have
 *           caught the whole thing.
 *   PART D  the repair for the rows already written. Fixing it forward leaves
 *           every request raised on that screen dead; the backfill links them
 *           by SKU, and REFUSES rather than guesses on anything ambiguous.
 *
 * PART C IS THE POINT OF THE SUITE. A and B are how it broke; C is the fact a
 * test should have been holding all along — "sent" means the units moved.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'jing', role: 'staff', display_name: 'Jing' },
  { restock: 1, warehouse_inbox: 1 }, 'tacet');

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const TIANHE = 1, YUEXIU = 2;
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
   VALUES (?,?,?,?,1,?)`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'jing','x','warehouse',?,1)`).run(YUEXIU);

// The banana, on both shelves — Tianhe holding ten, Yuexiu holding none.
const BANANA = 900;
F.seedProduct(h.db, { id: BANANA, name: 'Banana', sku: 'P-900' });
F.setShelf(h.db, TIANHE, BANANA, 10);
F.setShelf(h.db, YUEXIU, BANANA, 0);

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const settle = () => new Promise(r => setTimeout(r, 20));

// Yuexiu asks Tianhe for one banana — the shape the Ask-for-stock screen sends.
const ask = (line) => call('POST', '/api/restock', {
  status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU, items: [line],
});
const row = (id) => h.db.prepare(
  "SELECT status, COALESCE(goods_state,'none') AS goods_state, dispatched_at FROM restock_orders WHERE id = ?").get(id);
const shelf = (storeId) => F.shelf(h.db, storeId, BANANA);

(async () => {
  section('Part A · the phone sends the product id');

  const m = fs.readFileSync(path.join(h.REPO, 'public/m.html'), 'utf8');
  const items = m.slice(m.indexOf('function rqItems()'), m.indexOf('function rqItems()') + 400);
  ok(/product_id:\(p\.id==null\?null:Number\(p\.id\)\)/.test(items),
     'rqItems sends the chosen product’s id');
  ok(!/product_id:null,/.test(items),
     'and NOT a hardcoded null — which is the whole of what made the banana undeliverable');

  section('Part B · a dispatch that moves nothing is not a success');

  // The old shape, still reachable by any client that sends it.
  let r = await ask({ product_id: null, product_name: 'Banana', sku: 'P-900', qty_requested: 1, unit: 'pcs' });
  const blind = r.body.id;
  r = await call('PUT', `/api/restock/${blind}/status`, { status: 'prepared' });
  await settle();

  ok(r.body.stock_transfer && r.body.stock_transfer.ok === false,
     'pressing Send on a request whose lines name no product is REFUSED, out loud');
  ok(/is linked to a product/i.test((r.body.stock_transfer || {}).error || ''),
     'and says why, in words a picker can act on');
  eq(row(blind).goods_state, 'none', 'nothing moved, which was always true');
  eq(shelf(TIANHE), 10, 'and the supplier’s shelf is untouched');

  // An order with nothing asked for is a no-op, not a fault — the two must
  // stay distinguishable or every empty draft becomes an error.
  const empty = (await call('POST', '/api/restock', {
    status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU,
    items: [{ product_id: BANANA, product_name: 'Banana', qty_requested: 0 }],
  })).body.id;
  r = await call('PUT', `/api/restock/${empty}/status`, { status: 'prepared' });
  await settle();
  ok(!r.body.stock_transfer || r.body.stock_transfer.ok !== false,
     'an order with nothing asked for is still a no-op, not an error');

  section('Part C · "sent" means the units actually moved');

  r = await ask({ product_id: BANANA, product_name: 'Banana', sku: 'P-900', qty_requested: 1, unit: 'pcs' });
  const good = r.body.id;
  eq(row(good).goods_state, 'none', 'before Send, nothing has moved');

  r = await call('PUT', `/api/restock/${good}/status`, { status: 'prepared' });
  await settle();
  ok(!r.body.stock_transfer || r.body.stock_transfer.ok !== false, 'Send goes through');

  eq(row(good).goods_state, 'in_transit',
     'THE FACT THE RECEIVE SCREEN FILTERS ON — without this the goods exist nowhere anybody can count them');
  ok(!!row(good).dispatched_at, 'stamped with when they left');
  eq(shelf(TIANHE), 9, 'and the banana has actually left the supplier’s shelf');
  eq(shelf(YUEXIU), 0,
     'while the destination gains nothing yet — in transit belongs to neither shelf until it is counted in');

  // The whole point: it is now visible at the far end.
  const active = (await call('GET', '/api/restock?tab=active')).body.data;
  const mine = active.filter(o => o.goods_state === 'in_transit' && o.to_store_id === YUEXIU);
  ok(mine.some(o => o.id === good),
     'and it appears on the list Receive-from-another-shop reads — the screen that said "Nothing on its way"');

  // Counting it in closes the loop. `counts` is one entry per LINE — what the
  // counter actually saw — which is what makes a short delivery land as short.
  const lineId = h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ?').get(good).id;
  await call('PUT', `/api/restock/${good}/receive`, { counts: [{ item_id: lineId, qty_received: 1 }] });
  eq(shelf(YUEXIU), 1, 'counting it in puts the banana on the asking shop’s shelf');
  eq(shelf(TIANHE), 9, 'and the supplier is still down one — the unit moved, it was not copied');

  section('Part D · the rows already written are repaired, never guessed');

  const src = fs.readFileSync(path.join(h.REPO, 'database.js'), 'utf8');
  const mig = src.slice(src.indexOf("restock_line_product_id_backfill_v2"));
  ok(/dispatched_at IS NULL/.test(mig) && /goods_state, 'none'\) = 'none'/.test(mig)
     && /stock_applied_at IS NULL/.test(mig),
     'it touches ONLY orders whose stock never moved, so it cannot double-count anything');
  ok(/hits\.length > 1\)\s*\{ ambiguous\+\+; continue; \}/.test(mig),
     'a SKU matching two catalogue rows is left alone — a migration must not answer a question');
  ok(/hits\.length === 0\) \{ unmatched\+\+; continue; \}/.test(mig),
     'and so is one matching none');
  ok(/<> 'kitchen'/.test(mig), 'kitchen requests are excluded — they move no stock by design');
  ok(!/adjustStock|retail_store_stock/.test(mig),
     'IT MOVES NO STOCK ITSELF — it writes one integer per line and nothing else');

  section('Part E · a stuck order can be unstuck by somebody');

  /* THE ROUTE THAT HAD NO CALLER. `POST /:id/retry-dispatch` was built for
     exactly the state this section is about and was wired to NO screen, so a
     stuck order could not be unstuck by anybody — it sat at 'prepared' with
     goods_state 'none', off the Pick list (whose run is sent/received) and off
     the destination's Receive list (which filters on in_transit), for ever.
     That is the same defect as the rest of this section one layer up: a thing
     built, mapped, and never given a door. */
  const stuck = (await ask({ product_id: null, product_name: 'Banana', sku: 'P-900', qty_requested: 1, unit: 'pcs' })).body.id;
  await call('PUT', `/api/restock/${stuck}/status`, { status: 'prepared' });
  await settle();
  eq(row(stuck).goods_state, 'none', 'a refused dispatch leaves the order stuck, by construction');

  // Link it the way the backfill does, then retry — which is the live path for
  // every request already written before this shipped.
  h.db.prepare('UPDATE restock_items SET product_id = ? WHERE restock_id = ?').run(BANANA, stuck);
  const before = shelf(TIANHE);
  r = await call('POST', `/api/restock/${stuck}/retry-dispatch`);
  eq(r.status, 200, 'Send again goes through');
  eq(row(stuck).goods_state, 'in_transit', 'and the goods finally leave');
  eq(shelf(TIANHE), before - 1, 'one unit off the supplier’s shelf, exactly once');

  // Idempotent: the common second tap must not move anything twice.
  r = await call('POST', `/api/restock/${stuck}/retry-dispatch`);
  eq(shelf(TIANHE), before - 1, 'tapping it again moves nothing — the goods had already gone');

  const mm = fs.readFileSync(path.join(h.REPO, 'public/m.html'), 'utf8');
  ok(/retry-dispatch/.test(mm), 'and the phone actually calls it — the route has a door now');
  ok(/o\.status==='prepared' && \(!o\.goods_state\|\|o\.goods_state==='none'\)/.test(mm),
     'the Pick screen collects exactly the stuck shape');
  ok(/Did not leave the shelf/.test(mm), 'and says so in words, where the picker is');
  ok(!/var\(--brick/.test(mm.slice(mm.indexOf('Did not leave the shelf') - 900, mm.indexOf('Did not leave the shelf') + 900)),
     'in Amber, not Brick — it is work owed, not a fault by whoever is reading it');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
