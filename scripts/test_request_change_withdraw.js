#!/usr/bin/env node
/**
 * A STOCK REQUEST SENT THE WRONG WAY ROUND CAN BE CORRECTED OR WITHDRAWN (§498).
 *
 *   node scripts/test_request_change_withdraw.js
 *
 * THE REPORT THIS PINS. Ash raised RS-261026-003 with Tianhe as the shop
 * receiving, when Tianhe was meant to be supplying Yuexiu. Nothing could change
 * a request's two shops after it was sent and nothing could cancel it.
 *
 *   PART A  while nothing has happened to it, the asker can swap the shops and
 *           the order's own ids change, free-text names are cleared
 *   PART B  once a line is ticked, a quantity sent, or the run dispatched, both
 *           doors refuse — stock reads the ends at dispatch, so a late change
 *           would move goods between the wrong shelves
 *   PART C  only the person who asked (or an admin/owner) may use either door
 *   PART D  the refusals are named: same shop, unknown shop, kitchen request
 *   PART E  withdrawing archives it; the asker's list says so and drops the buttons
 *   PART F  the phone carries the two buttons, gated on the server's word, in
 *           strings that are live or declared
 */
'use strict';

const path = require('path');
const fs = require('fs');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);
const user = { id: 7, username: 'jing', role: 'staff', display_name: 'Jing' };
F.stubAuth(h, user, { restock: 1, warehouse_inbox: 1 }, 'tacet');

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: user.id }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const TIANHE = 1, YUEXIU = 2, PANYU = 3;
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order, timezone)
   VALUES (?,?,?,?,1,?,'Asia/Shanghai')`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');
store(PANYU, 'panyu', 'Panyu', '番禺');
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)")
  .run(String(TIANHE));

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ITEMS = [{ product_id: 900, product_name: 'Hummus', qty_requested: 5, unit: 'pc' }];
// The mistake as made: Yuexiu supplies, Tianhe receives.
const ask = (extra = {}) => call('POST', '/api/restock', {
  status: 'sent', from_store_id: YUEXIU, to_store_id: TIANHE, items: ITEMS, ...extra,
}).then(r => r.body.id);
const row = id => h.db.prepare('SELECT * FROM restock_orders WHERE id = ?').get(id);
const mineRow = async id => (await call('GET', '/api/restock/mine')).body.data.find(r => r.id === id);
const ends = (id, from, to) => call('PUT', `/api/restock/${id}/ends`, { from_store_id: from, to_store_id: to });

(async () => {
  section('Part A · the shops can be swapped while nothing has happened');
  const a = await ask();
  h.db.prepare("UPDATE restock_orders SET store_name='Tianhe', store_cn='天河店' WHERE id=?").run(a);
  eq((await mineRow(a)).can_change, true, 'a fresh request reads can_change');
  const r1 = await ends(a, TIANHE, YUEXIU);
  eq(r1.status, 200, 'the change is accepted');
  const o = row(a);
  eq([o.from_store_id, o.to_store_id].join(','), `${TIANHE},${YUEXIU}`, 'Tianhe now supplies and Yuexiu receives');
  ok(o.store_name === null && o.store_cn === null, 'the stale free-text destination is cleared so the slip reads the real one');
  eq(o.status, 'sent', 'and the request stays sent');
  eq((await ends(a, TIANHE, YUEXIU)).body.unchanged, true, 'asking for what it already is changes nothing');

  section('Part B · once anything has happened, both doors close');
  for (const [label, sql] of [
    ['a line is ticked', 'UPDATE restock_items SET is_checked=1 WHERE restock_id=?'],
    ['a quantity is sent', 'UPDATE restock_items SET qty_sent=3 WHERE restock_id=?'],
  ]) {
    const id = await ask();
    h.db.prepare(sql).run(id);
    eq((await mineRow(id)).can_change, false, `${label}: the list says no`);
    eq((await ends(id, TIANHE, YUEXIU)).status, 409, `${label}: change is refused`);
    eq((await call('PUT', `/api/restock/${id}/withdraw`)).status, 409, `${label}: withdraw is refused`);
  }
  const moved = await ask();
  h.db.prepare("UPDATE restock_orders SET goods_state='in_transit', dispatched_at=CURRENT_TIMESTAMP, status='prepared' WHERE id=?").run(moved);
  eq((await ends(moved, TIANHE, YUEXIU)).body.error, 'not_changeable', 'a dispatched run cannot be redirected');
  eq(row(moved).from_store_id, YUEXIU, 'and its ends are untouched');

  section('Part C · only the person who asked');
  const theirs = await ask();
  h.db.prepare('UPDATE restock_orders SET created_by = 99 WHERE id=?').run(theirs);
  eq((await ends(theirs, TIANHE, YUEXIU)).body.error, 'not_yours', "somebody else's request is refused");
  eq((await call('PUT', `/api/restock/${theirs}/withdraw`)).status, 403, 'and so is withdrawing it');
  user.role = 'owner';
  eq((await ends(theirs, TIANHE, YUEXIU)).status, 200, 'an owner may');
  user.role = 'staff';

  section('Part D · named refusals');
  const d = await ask();
  eq((await ends(d, TIANHE, TIANHE)).body.error, 'same_shop', 'the same shop at both ends');
  eq((await ends(d, TIANHE, 999)).body.error, 'unknown_shop', 'a shop that does not exist');
  eq((await ends(d, TIANHE, null)).body.error, 'bad_shops', 'a missing end');
  const k = (await call('POST', '/api/restock', { status: 'sent', to_role: 'kitchen', purpose: 'order', items: ITEMS })).body.id;
  eq((await ends(k, TIANHE, YUEXIU)).status, 409, 'a kitchen request has no shops to change');
  eq((await call('PUT', '/api/restock/9999/withdraw')).status, 404, 'a request that is not there');

  section('Part E · withdrawing');
  const w = await ask();
  eq((await call('PUT', `/api/restock/${w}/withdraw`)).status, 200, 'withdraw is accepted');
  ok(!!row(w).archived_at, 'it is archived');
  const wr = await mineRow(w);
  ok(wr.withdrawn === true && wr.can_change === false, 'the asker\'s list shows it withdrawn with no buttons');
  eq((await ends(w, TIANHE, YUEXIU)).status, 409, 'a withdrawn request cannot be revived by a change');

  section('Part F · the phone');
  const m = fs.readFileSync(path.join(h.REPO, 'public/m.html'), 'utf8');
  ok(m.includes("T('Change shops','更改门店')"), 'the change button is there');
  ok(m.includes("T('Withdraw','撤回')"), 'and the withdraw button');
  ok(/if\(!r\.can_change\|\|r\.withdrawn\) return ''/.test(m), 'both are drawn only on the server\'s word');
  for (const cn of ['送到哪家门店？', '向哪个地点申请？', '更改', '门店', '已撤回']) {
    ok(m.split(cn).length - 1 >= 2, `${cn} is live elsewhere, not minted for this screen`);
  }

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
