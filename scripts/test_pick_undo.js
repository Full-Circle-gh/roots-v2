#!/usr/bin/env node
/**
 * PUTTING A PICKED LINE BACK (§214).
 *
 *   node scripts/test_pick_undo.js
 *
 * Ash, looking at a ticked line with a green circle and nothing else on it:
 * *"no way to undo , change"*. Ticking was a one-way door — pick 2 when you
 * meant 1, or tick the wrong row, and the only way out was to dispatch it wrong
 * and fix it at the far end as a receipt discrepancy.
 *
 * THE HALF THAT IS NOT OBVIOUS IS THE QUANTITY. Un-ticking alone leaves a stale
 * `qty_sent` on an unchecked line, and dispatch reads
 * `COALESCE(qty_sent, qty_requested)` WITHOUT EVER LOOKING AT `is_checked` — so
 * a picker who undid "1 of 2" and dispatched without re-picking would move 1,
 * silently. Un-ticked-with-a-quantity is a state this table has never held, and
 * `clear_qty_sent` is what keeps it that way.
 *
 * `clear_qty_sent` NEEDS ITS OWN FLAG because `COALESCE(?, qty_sent)` cannot
 * express "put it back": a missing `qty_sent` and an explicit null are the same
 * request on the wire, and every existing caller relies on both meaning leave
 * it alone. So this suite also pins that they still do.
 *
 * AND THE DOOR STAYS SHUT AFTER THE VAN LEAVES. The guard that refuses any line
 * edit once `goods_state` leaves 'none' is on this same endpoint, so an undo
 * after dispatch is a 409 rather than a quantity that has already moved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
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
const putItem = (orderId, itemId, body) =>
  call('put', '/api/restock/:id/item/:item_id', { id: String(orderId), item_id: String(itemId) }, body);
const itemRow = id => h.db.prepare('SELECT * FROM restock_items WHERE id = ?').get(id);

function mkOrder(id, rs) {
  h.db.prepare(`INSERT INTO restock_orders (id,rs_number,date,status,store_name,created_by,from_role,to_role,from_store_id,to_store_id)
                VALUES (?,?,?,'received','Tianhe',7,'store','warehouse',${WH},${SHOP})`).run(id, rs, '2026-09-21');
  h.db.prepare("INSERT INTO restock_items (restock_id,product_id,product_name,qty_requested) VALUES (?,900,'Banana',2)").run(id);
  return h.db.prepare('SELECT id FROM restock_items WHERE restock_id = ? ORDER BY id').all(id)[0].id;
}
h.db.prepare("INSERT OR REPLACE INTO retail_store_stock (store_id,product_id,physical_qty) VALUES (?,?,?)").run(WH, 900, 50);

// ══════════════════════════════════════════════════════════════════════════
section('1. picking short, then putting it back');
const o1 = 7001, i1 = mkOrder(o1, 'RS-U1');
putItem(o1, i1, { qty_sent: 1, is_checked: 1 });            // "Short · 1 of 2"
eq(itemRow(i1).qty_sent, 1,    'the short figure is on the line');
eq(itemRow(i1).is_checked, 1,  'and the line is ticked');

const undo = putItem(o1, i1, { is_checked: 0, clear_qty_sent: true });
eq(undo.status, 200,           'undo is accepted before dispatch');
eq(itemRow(i1).is_checked, 0,  'the tick is gone');
eq(itemRow(i1).qty_sent, null, 'AND the quantity is gone — undone means untouched');

/* The whole reason the flag exists: dispatch never reads is_checked, so a
   stale qty_sent on an un-ticked line would move the old figure silently. */
section('2. and dispatching now sends what was asked, not what was undone');
call('put', '/api/restock/:id/status', { id: String(o1) }, { status: 'prepared' });
const moved = h.db.prepare(
  `SELECT delta FROM retail_stock_ledger WHERE reason='restock_transfer_out' AND ref_table='restock_orders' AND ref_id=?`
).get(o1);
eq(moved && moved.delta, -2, 'two left the shelf — the asked figure, not the undone 1');

// ══════════════════════════════════════════════════════════════════════════
section('3. every other caller is untouched — both ways of saying "leave it"');
const o2 = 7002, i2 = mkOrder(o2, 'RS-U2');
putItem(o2, i2, { qty_sent: 2, is_checked: 1 });
putItem(o2, i2, { is_checked: 0 });                          // no qty_sent key at all
eq(itemRow(i2).qty_sent, 2,   'a body with no qty_sent leaves it alone, as it always has');
putItem(o2, i2, { is_checked: 1, qty_sent: null });          // explicit null
eq(itemRow(i2).qty_sent, 2,   'and an explicit null still means leave it alone');
eq(itemRow(i2).is_checked, 1, 'while the other field in the same body still applies');

// ══════════════════════════════════════════════════════════════════════════
section('4. the door shuts once the van leaves');
call('put', '/api/restock/:id/status', { id: String(o2) }, { status: 'prepared' });
const after = putItem(o2, i2, { is_checked: 0, clear_qty_sent: true });
eq(after.status, 409,          'undo after dispatch is refused');
eq(itemRow(i2).qty_sent, 2,    'and the quantity that already moved is untouched');
eq(itemRow(i2).is_checked, 1,  'as is the tick');
ok(/already left/.test((after.body && after.body.error) || ''),
   'with the reason the picker needs — record it at the receipt instead');

// ══════════════════════════════════════════════════════════════════════════
section('5. the screen offers it, in a word it already had');
const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');
ok(/onclick="APP\.cmd\('pikUndo','\$\{L\.key\}'\)"/.test(M), 'a picked line carries an Undo');
ok(/T\('Undo','撤销'\)/.test(M), "labelled with the live pair 'Undo · 撤销' — nothing composed");
ok(/\{is_checked:0,clear_qty_sent:true\}/.test(M), 'and it clears the quantity as well as the tick');
ok(/ic\('circle-check',20\)/.test(M) && /pikUndo/.test(M),
   'the tick stays as the status — a destructive tap does not sit where the thumb just was');

done();
