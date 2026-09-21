#!/usr/bin/env node
/**
 * A SHORT DELIVERY SAYS SO (§216).
 *
 *   node scripts/test_short_delivery_alert.js
 *
 * Ash, on being shown that a counted-short transfer books the COUNTED figure —
 * Tianhe −2, Yuexiu +1, the business quietly one short — and that nobody is
 * told: *"ok build it"*.
 *
 * THE GAP WAS ALWAYS LEGIBLE AND NEVER SURFACED. asked, sent and counted have
 * sat side by side on the row since §39; what nobody does is open a transfer
 * that already closed. So the sender was told the boxes were counted and not
 * what the count said.
 *
 * THIS CHANGES THAT PUSH RATHER THAN ADDING ONE, and that is the design. A
 * second notification would go to the SAME audience the first already reaches —
 * `restock:pick` at the `from` store — which is the two-for-one-event mistake
 * §211 exists to avoid. So:
 *
 *   • EXACTLY ONE push to the sender, short or not.
 *   • Its TITLE carries the state, in the live pair `Short · 短少`.
 *   • Its BODY names the lines as `<product> <counted>/<sent>`, the Chinese
 *     product name where there is one — bodies on this fan-out are English by
 *     existing convention, and a numeral needs no translating.
 *   • AN OVER-COUNT IS NOT AN ALARM. Nothing is missing, and a notification per
 *     extra unit teaches people to swipe these away.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
const notes = F.captureNotifications(h);
const ACTOR = { id: 7, username: 'wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };
F.stubAuth(h, ACTOR, PERMS);
const restock = require(path.join(h.REPO, 'routes/restock.js'));

const TIANHE = 1, YUEXIU = 2;
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'th','Tianhe',1)").run();
h.db.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'yx','Yuexiu',1)").run();
h.db.prepare("INSERT OR IGNORE INTO users (id,username,password,role,is_active) VALUES (7,'wh','x','warehouse',1)").run();
F.seedProduct(h.db, { id: 900, name: 'Mint', sku: 'P-900' });
F.seedProduct(h.db, { id: 901, name: 'Dates', sku: 'P-901' });
h.db.prepare("INSERT OR REPLACE INTO storefront_config (key,value_json) VALUES ('stock.warehouseStoreId',?)").run(String(TIANHE));

const call = (m, p, params, body) =>
  F.callRoute(restock, m, p, { params, body, user: ACTOR, permissions: PERMS });
const setShelf = (s, p, q) => h.db.prepare(
  "INSERT OR REPLACE INTO retail_store_stock (store_id,product_id,physical_qty) VALUES (?,?,?)").run(s, p, q);

function mk(id, rs, lines) {
  h.db.prepare(`INSERT INTO restock_orders (id,rs_number,date,status,store_name,created_by,from_role,to_role,from_store_id,to_store_id)
                VALUES (?,?,?,'received','Yuexiu',7,'store','warehouse',${TIANHE},${YUEXIU})`).run(id, rs, '2026-09-21');
  lines.forEach(l => h.db.prepare(
    "INSERT INTO restock_items (restock_id,product_id,product_name,product_cn,qty_requested,qty_sent) VALUES (?,?,?,?,?,?)")
    .run(id, l.pid, l.name, l.cn || null, l.asked, l.sent));
  return h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ? ORDER BY id').all(id).map(r => r.id);
}
// Only the sender's own fan-out — restock:pick at the from store.
const toSender = () => notes.operator.filter(o => (o.caps || '') === 'restock:pick');

// ══════════════════════════════════════════════════════════════════════════
section('1. a short delivery tells the sender what the count said');
setShelf(TIANHE, 900, 20); setShelf(TIANHE, 901, 20);
setShelf(YUEXIU, 900, 0);  setShelf(YUEXIU, 901, 0);
const its = mk(8001, 'RS-S1', [{ pid: 900, name: 'Mint', cn: '薄荷', asked: 5, sent: 5 },
                               { pid: 901, name: 'Dates',              asked: 2, sent: 2 }]);
call('put', '/api/restock/:id/status', { id: '8001' }, { status: 'prepared' });
notes.operator.length = 0;
call('put', '/api/restock/:id/receive', { id: '8001' },
  { counts: [{ item_id: its[0], qty_received: 4 }, { item_id: its[1], qty_received: 0 }] });

const sent1 = toSender();
eq(sent1.length, 1, 'exactly ONE push to the sender — the gap changes it, never doubles it');
const m1 = (sent1[0] || {}).msg || {};
ok(/short/.test(m1.title || '') && /短少/.test(m1.title || ''),
   "the title says short · 短少 — the live pair, not a new word");
ok(/RS-S1/.test(m1.title || ''), 'and names the transfer');
ok(/2 short/.test(m1.body || ''), 'the body counts the short lines');
ok(/薄荷 4\/5/.test(m1.body || ''), 'names the line in Chinese where the product has it — 薄荷 4/5');
ok(/Dates 0\/2/.test(m1.body || ''), 'and falls back to the English name where it does not');
ok(!/counted in/.test(m1.title || ''), 'it does not also claim a clean count');

section('2. the shelves still follow §39 — the alert reports, it does not correct');
eq(F.shelf(h.db, YUEXIU, 900), 4, 'Yuexiu holds what Yuexiu counted');
eq(F.shelf(h.db, TIANHE, 900), 15, 'Tianhe lost what Tianhe sent');
eq(F.shelf(h.db, YUEXIU, 901), 0, 'a line counted zero moves nothing');

// ══════════════════════════════════════════════════════════════════════════
section('3. a clean delivery is unchanged');
setShelf(TIANHE, 900, 20); setShelf(YUEXIU, 900, 0);
const its2 = mk(8002, 'RS-S2', [{ pid: 900, name: 'Mint', cn: '薄荷', asked: 3, sent: 3 }]);
call('put', '/api/restock/:id/status', { id: '8002' }, { status: 'prepared' });
notes.operator.length = 0;
call('put', '/api/restock/:id/receive', { id: '8002' }, { counts: [{ item_id: its2[0], qty_received: 3 }] });
const m2 = (toSender()[0] || {}).msg || {};
eq(toSender().length, 1, 'still one push');
ok(/counted in/.test(m2.title || '') && /已点收/.test(m2.title || ''), 'and it is the ordinary counted-in one');
ok(!/short|短少/.test(m2.title || ''), 'nothing says short when nothing is');

// ══════════════════════════════════════════════════════════════════════════
section('4. an over-count is not an alarm');
setShelf(TIANHE, 900, 20); setShelf(YUEXIU, 900, 0);
const its3 = mk(8003, 'RS-S3', [{ pid: 900, name: 'Mint', cn: '薄荷', asked: 3, sent: 3 }]);
call('put', '/api/restock/:id/status', { id: '8003' }, { status: 'prepared' });
notes.operator.length = 0;
call('put', '/api/restock/:id/receive', { id: '8003' }, { counts: [{ item_id: its3[0], qty_received: 5 }] });
const m3 = (toSender()[0] || {}).msg || {};
ok(!/short|短少/.test(m3.title || ''), 'more than was sent is not a short delivery');
eq(F.shelf(h.db, YUEXIU, 900), 5, 'and the counted figure still stands — §39 either way');

done();
