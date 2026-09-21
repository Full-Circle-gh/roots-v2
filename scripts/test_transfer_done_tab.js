#!/usr/bin/env node
/**
 * WHERE A SHOP SEES WHAT IT HAS ALREADY COUNTED IN (§212).
 *
 *   node scripts/test_transfer_done_tab.js
 *
 * Ash: *"where can I see history deliveries"*. The honest answer was ONE screen
 * — *Your stock requests* — and it is scoped `WHERE created_by = you`, so it
 * shows what you ASKED for and says nothing about what you RECEIVED. A
 * colleague raising the request put the delivery you counted out of your reach
 * entirely, and the sending shop had no history at all.
 *
 * WHY THIS COULD NOT HAVE BEEN BUILT AN HOUR EARLIER. The tab reads
 * `?tab=history`, which is `status = 'delivered'` — and until §211 nothing had
 * ever written that status, so the tab would have been permanently empty. This
 * suite therefore also guards §211 from the far end: if the closure regresses,
 * the Done tab silently empties and these checks go red.
 *
 * WHAT MUST HOLD:
 *
 *   • SETTLED, NOT MERELY DELIVERED. A run a driver marked delivered without
 *     anybody counting is still countable and belongs on the On-its-way tab.
 *     Filtering on the RECEIPT rather than the status keeps one order out of
 *     two tabs at once — the bug this filter exists to prevent.
 *   • The two tabs are disjoint, and a counted delivery moves between them.
 *   • Kitchen requests never appear: *Ask the kitchen* is a different screen
 *     with a different answer.
 *   • The tab labels and the receipt are live pairs; exactly ONE string on this
 *     screen is composed, and it is declared.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h, { pushEnabled: false });
const ACTOR = { id: 7, username: 'wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };
F.stubAuth(h, ACTOR, PERMS);
const restock = require(path.join(h.REPO, 'routes/restock.js'));

const WH = 1, SHOP = 2;
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'wh','Yuexiu',1)").run();
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'shop','Tianhe',1)").run();
h.db.prepare("INSERT OR IGNORE INTO users (id,username,password,role,is_active) VALUES (7,'wh','x','warehouse',1)").run();
F.seedProduct(h.db, { id: 900, name: 'Banana', sku: 'P-900' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key,value_json) VALUES ('stock.warehouseStoreId',?)").run(String(WH));

const call = (m, p, params, body) =>
  F.callRoute(restock, m, p, { params, body, user: ACTOR, permissions: PERMS });
const setShelf = (s, p, q) => h.db.prepare(
  "INSERT OR REPLACE INTO retail_store_stock (store_id,product_id,physical_qty) VALUES (?,?,?)").run(s, p, q);

// callRoute hardcodes an empty query, so the tab filter is driven directly.
const tab = t => {
  const layer = restock.stack.find(l => l.route && l.route.path === '/api/restock' && l.route.methods.get);
  let out = null;
  const req = { params: {}, body: {}, query: { tab: t }, user: ACTOR, permissions: PERMS, ip: '::1' };
  const res = { json: b => { out = b; return res; }, status: () => res, set: () => res,
                setHeader: () => res, type: () => res, send: b => { out = b; return res; } };
  const hs = layer.route.stack.map(x => x.handle);
  hs[hs.length - 1](req, res, () => {});
  return ((out || {}).data || []);
};
// What the Done tab actually draws — the screen's own filter, in one place.
const doneTab = () => tab('history').filter(o =>
  (o.to_role || 'warehouse') !== 'kitchen'
  && (o.goods_state === 'settled' || o.received_confirmed_at));
// The screen fetches tab=all and filters on goods_state, never on status —
// a delivered-but-uncounted run is still in transit and still this list's.
const activeTab = () => tab('all').filter(o => o.goods_state === 'in_transit');

function mkTransfer(id, rs, toRole) {
  h.db.prepare(`INSERT INTO restock_orders (id,rs_number,date,status,store_name,created_by,from_role,to_role,from_store_id,to_store_id)
                VALUES (?,?,?,'received','Tianhe',7,'store',?,${WH},${SHOP})`).run(id, rs, '2026-09-20', toRole || 'warehouse');
  h.db.prepare("INSERT INTO restock_items (restock_id,product_id,product_name,qty_requested,qty_sent) VALUES (?,900,'Banana',1,1)").run(id);
  return h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ? ORDER BY id').all(id);
}
const has = (rows, id) => rows.some(o => o.id === id);

// ══════════════════════════════════════════════════════════════════════════
section('1. a delivery moves from one tab to the other when it is counted');
setShelf(WH, 900, 10); setShelf(SHOP, 900, 0);
const a = mkTransfer(6001, 'RS-A');
call('put', '/api/restock/:id/status', { id: '6001' }, { status: 'prepared' });
ok(has(activeTab(), 6001), 'on its way while it is on the road');
ok(!has(doneTab(), 6001),  'and not in Done before anybody counts it');

call('put', '/api/restock/:id/receive', { id: '6001' }, { counts: [{ item_id: a[0].id, qty_received: 1 }] });
ok(has(doneTab(), 6001),   'counted in — now in Done');
ok(!has(activeTab(), 6001), 'and gone from On its way — the tabs are disjoint');

// ══════════════════════════════════════════════════════════════════════════
/* THE CASE THE FILTER EXISTS FOR. A driver marking a run delivered is not a
   shop counting it: the goods are still in transit and still countable, so the
   order must stay on the tab where the WORK is. Filtering Done on `status`
   alone would put this one order on both tabs at once. */
section('2. delivered-but-not-counted stays where the work is');
setShelf(WH, 900, 10);
const b = mkTransfer(6002, 'RS-B');
call('put', '/api/restock/:id/status', { id: '6002' }, { status: 'prepared' });
call('put', '/api/restock/:id/status', { id: '6002' }, { status: 'delivered' });
ok(has(tab('history'), 6002), 'the raw history tab does carry it — its status IS delivered');
ok(!has(doneTab(), 6002),     'but the Done tab does not — it filters on the receipt');
ok(has(activeTab(), 6002),    'and it is still on its way, because it still needs counting');

call('put', '/api/restock/:id/receive', { id: '6002' }, { counts: [{ item_id: b[0].id, qty_received: 1 }] });
ok(has(doneTab(), 6002),    'once counted it reaches Done');
ok(!has(activeTab(), 6002), 'and leaves the other tab');

// ══════════════════════════════════════════════════════════════════════════
section('3. a kitchen request is never on either tab');
h.db.prepare(`INSERT INTO restock_orders (id,rs_number,date,status,store_name,created_by,from_role,to_role)
              VALUES (6003,'RS-K','2026-09-20','prepared','Kitchen',7,'warehouse','kitchen')`).run();
ok(!doneTab().some(o => o.id === 6003), 'Ask the kitchen is a different screen with a different answer');

// ══════════════════════════════════════════════════════════════════════════
section('4. the screen says it in words that already existed');
const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');
const V = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
ok(/seg\('active',T\('On its way','在途'\)\)/.test(M), "first tab is 'On its way · 在途' — a live pair");
ok(/api\('\/api\/restock\?tab=all'\)/.test(M),
   'and it reads tab=all — a status filter must never hide an in-transit run from the screen that counts it');
ok(/seg\('done',T\('Done','已完成'\)\)/.test(M),        "second tab is 'Done · 已完成' — the kitchen queue's own");
ok(/T\('Nothing finished yet','暂无已完成'\)/.test(M),  'the empty heading is live too');
ok(/T\('What you count in shows up here\.','已清点入库的调拨会显示在这里。'\)/.test(M),
   'and the one composed line is on the empty Done tab');
ok(/\|\s*What you count in shows up here\.\s*\|\s*已清点入库的调拨会显示在这里。\s*\|/.test(V),
   'declared in the vocabulary, with what it was built on and what was rejected');

section('5. a finished delivery opens on its receipt, not on a sentence');
ok(/const lines=done\?xfrItems\(\):\[\];/.test(M), 'a settled order draws its lines');
ok(/color:\$\{full\?'var\(--text-primary\)':'var\(--amber-ink\)'\}/.test(M),
   'and a line that came up short is drawn in Amber, where the gap is the point');

done();
