#!/usr/bin/env node
/**
 * WHAT BECAME OF WHAT YOU ASKED ANOTHER SHOP FOR (§198).
 *
 *   node scripts/test_stock_request_mine.js
 *
 * THE REPORT THIS PINS, the half of it that paper does not fix. Ash, having
 * raised a request from Yuexiu against Tianhe: "i dont see it on my mobile".
 * He was right and there was nothing to see — between pressing Send and the
 * supplier dispatching, a stock request appeared on NO screen this app could
 * open, because Receive-from-another-shop lists only what is already in
 * transit. Ask to buy has answered back since §175; Ask for stock answered
 * nothing, which is two rows under one heading behaving differently for no
 * reason a reader could find.
 *
 * FIVE THINGS HAVE TO BE TRUE:
 *
 *   PART A  it is YOURS and nobody else's, and a draft is not a request. The
 *           scope is `created_by` plus the realm — a kitchen session's user id
 *           is a row in a DIFFERENT TABLE, so the integer alone would let two
 *           people with the same id read each other's requests.
 *   PART B  THE LINE carries the state, not the request. A picker ticks lines
 *           one at a time, so part-dispatched is the ordinary case and a single
 *           word across the whole request is wrong about at least one line.
 *   PART C  the header carries the shop it was asked OF, by id and not by the
 *           free text the phone never sends.
 *   PART D  no price reaches the screen, and neither does anything else the
 *           asker has no business reading.
 *   PART E  the screen and its DOOR went in together — the row, its capability
 *           gate and its SUBS entry. (The confined-role allowlist this also
 *           checked is gone, decisions §277.)
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
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Tortilla', sku: 'P-901' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('stock.warehouseStoreId', ?)")
  .run(String(TIANHE));

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const ITEMS = [
  { product_id: 900, product_name: 'Hummus', product_cn: '鹰嘴豆泥', sku: 'P-900', qty_requested: 20, unit: 'kg' },
  { product_id: 901, product_name: 'Tortilla', product_cn: '墨西哥薄饼', sku: 'P-901', qty_requested: 100, unit: 'pc' },
];

const ask = (extra = {}) => call('POST', '/api/restock', {
  status: 'sent', from_store_id: TIANHE, to_store_id: YUEXIU, items: ITEMS, ...extra,
});
const mine = async () => (await call('GET', '/api/restock/mine')).body.data;
const find = (rows, id) => rows.find(r => r.id === id);

(async () => {
  section('Part A · it is yours, and a draft is not a request');

  const r1 = (await ask()).body;
  let rows = await mine();
  ok(!!find(rows, r1.id), 'a request you raised comes back');

  const draft = (await ask({ status: 'draft' })).body;
  rows = await mine();
  ok(!find(rows, draft.id), 'a draft does not — nobody has been asked for anything yet');

  // Somebody else's, written straight to the table: created_by is the whole of
  // the scope and this is the only way to hold a second author in one session.
  h.db.prepare(`INSERT INTO restock_orders (rs_number, date, status, created_by, from_role, to_role,
                  from_store_id, to_store_id, sent_at)
                VALUES ('RS-OTHER-1', date('now'), 'sent', 99, 'store', 'warehouse', ?, ?, datetime('now'))`)
    .run(TIANHE, YUEXIU);
  rows = await mine();
  ok(!rows.some(r => r.rs_number === 'RS-OTHER-1'), "and somebody else's request never appears");

  // A kitchen request is a different screen with a different answer.
  const kitchen = (await call('POST', '/api/restock', {
    status: 'sent', to_role: 'kitchen', purpose: 'order', items: ITEMS,
  })).body;
  rows = await mine();
  ok(!find(rows, kitchen.id),
     'a kitchen request is excluded — "Ask the kitchen" has its own answer, and folding them would put a tray of food under one heading with a case of almonds');

  section('Part B · the line carries the state, not the request');

  let mineRow = find(await mine(), r1.id);
  eq(mineRow.items.length, 2, 'every line comes back');
  eq(mineRow.items.map(l => l.state).join(','), 'waiting,waiting', 'and starts waiting');

  /* THE TICK IS NOT THE SEND, and this assertion MOVED to say so (§202).
     It read 'sent' and asserted the line "reads as dispatched" — which was the
     small lie Ash caught on his banana: `is_checked` is written at the shelf
     while the goods are still in the supplier's shop, possibly hours from
     leaving. The state is 'picked' now, and the line below proves the
     difference is real rather than a rename. */
  const lineId = mineRow.items[0].id;
  await call('PUT', `/api/restock/${r1.id}/item/${lineId}`, { qty_sent: 12, is_checked: 1 });
  mineRow = find(await mine(), r1.id);
  eq(mineRow.items[0].state, 'picked',
     'a ticked line reads PICKED — somebody has it in their hand, it has not left');
  eq(mineRow.items[1].state, 'waiting',
     'AND THE ONE BESIDE IT STILL READS WAITING — part-picked is the ordinary case, not an edge');

  // Dispatch the run: the order's own fact, written once, for every line.
  h.db.prepare("UPDATE restock_orders SET goods_state='in_transit' WHERE id=?").run(r1.id);
  mineRow = find(await mine(), r1.id);
  eq(mineRow.items.map(l => l.state).join(','), 'transit,transit',
     'once the run is dispatched every line is ON ITS WAY — including one nobody ticked, because the van does not carry lines separately');

  // What actually left, where it is not what was asked for.
  eq(Number(mineRow.items[0].qty_sent), 12, 'the quantity that left rides along');
  eq(Number(mineRow.items[0].qty_requested), 20, 'beside the quantity that was asked for');

  // Arrival is request-level — a delivery is counted in as one event — and it
  // outranks dispatch on every line, because a delivered request's lines all
  // went out first.
  h.db.prepare("UPDATE restock_orders SET status='delivered', delivered_at=datetime('now') WHERE id=?").run(r1.id);
  mineRow = find(await mine(), r1.id);
  eq(mineRow.items.map(l => l.state).join(','), 'arrived,arrived',
     'once it is counted in, every line reads arrived rather than still on its way');

  section('Part C · the header says who it was asked of');

  const r2 = (await ask()).body;
  mineRow = find(await mine(), r2.id);
  eq(mineRow.from_name_cn, '天河', 'the supplying shop, resolved from its id');
  eq(mineRow.from_name_en, 'Tianhe', 'in both languages, so the phone picks');
  ok(!mineRow.store_name,
     'and NOT from store_name — the Ask-for-stock screen sends neither half of it, which is why the id had to answer');

  eq(mineRow.withdrawn, false, 'a live request is not withdrawn');
  h.db.prepare("UPDATE restock_orders SET archived_at=datetime('now') WHERE id=?").run(r2.id);
  mineRow = find(await mine(), r2.id);
  eq(mineRow.withdrawn, true,
     'an archived one is — archiving is how a request stops being outstanding, and it is the ONE genuinely request-level fact');

  section('Part D · nothing reaches the screen that should not');

  const json = JSON.stringify(await mine());
  ok(!/price|cost|unit_cost|total/i.test(json),
     'NO MONEY ANYWHERE — a transfer moves value between two shelves of one business (§51’s rule for the slip, applied to the screen)');

  section('Part E · the screen and its door went in together');

  const caps = require(path.join(h.REPO, 'lib/capabilities.js'));
  ok(caps.presetCapsFor('store_stock').includes('restock:request'),
     'store_stock holds the key the row is gated on — the role this screen was built for can open it');

  /* THE FOUR WORDS, AND THAT NONE OF THEM IS NEW (§202). Every state this
     screen can show must be a pair that already exists somewhere else in the
     tree — the rule the vocabulary document exists to keep. A rename that
     invents Chinese is the failure mode, and it is silent: the screen looks
     finished either way. Each half is counted across public/ and routes/, so a
     word used ONLY here fails. */
  const m = fs.readFileSync(path.join(h.REPO, 'public/m.html'), 'utf8');
  const admin = fs.readFileSync(path.join(h.REPO, 'public/retail-admin/04-orders.js'), 'utf8');
  const route = fs.readFileSync(path.join(h.REPO, 'routes/restock.js'), 'utf8');
  const corpus = m + admin + route;
  for (const [state, en, cn] of [
    ['waiting', 'Waiting', '待处理'],
    ['picked',  'Picked',  '已拣'],
    ['transit', 'On its way', '在途'],
    ['arrived', 'Counted in', '已点收'],
  ]) {
    ok(new RegExp(`${state}'?\\s*\\?\\s*T\\('${en}'`).test(m.replace(/\s+/g, ' '))
       || m.includes(`T('${en}','${cn}')`),
       `${state} shows "${en} · ${cn}"`);
    const uses = corpus.split(cn).length - 1;
    ok(uses >= 2,
       `${cn} is a live word, used ${uses}× — not minted for this screen`);
  }

  ok(/\['askstocksent','clipboard-list','Your stock requests','我的补货申请'\]/.test(m),
     'the More row exists');
  ok(/askstocksent:'restock:request'/.test(m),
     'gated on the same key the route scopes itself with — a row that 403s on the first tap is a trap, not a shortcut');
  ok(/SUBS\.askstocksent=/.test(m), 'and the route resolves to a screen');
  ok(m.indexOf("['askstocksent'") > m.indexOf("['askstock',"),
     'it sits directly beneath the screen it answers for, as askbuysent does under askbuy');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
