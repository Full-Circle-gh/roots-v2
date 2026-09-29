#!/usr/bin/env node
/**
 * A Meituan or Eleme order takes its stock off the shelf ONCE.
 *
 *   node scripts/test_platform_order_single_deduct.js
 *
 * THE BUG, seen live 2026-09-29 at Tianhe: Meituan order 3202322043879506982
 * (mirrored as MT20260929921565) had Garlic Powder, Onion Powder and Za'atar
 * taken off at 12:48 by the ingest, and all three taken off AGAIN at 12:52 when
 * the Qingyun rider picked the bag up. The activity screen showed the second
 * set as 小程序, because 'order_prepare' is read as the mini app.
 *
 * WHY: the ingest writes 'meituan_order' / 'eleme_order' ledger rows keyed to the
 * stock row, not to the order. commitUnreservedOrder's "already committed?"
 * guard only looks for 'order%' rows keyed to the order, so it saw nothing and
 * decremented again. Every forward transition reaches it — the rider-pickup
 * sweep, both delivered sweeps, staff moving the order on by hand.
 *
 * LOCKED DOWN HERE:
 *   1. a Meituan order that the ingest already deducted is NOT decremented again
 *   2. the same for Eleme
 *   3. a REPLACEMENT for a Meituan order (source = 'replacement', channel copied
 *      from the original) STILL commits — it is a new parcel no ingest saw
 *   4. an ordinary mini-app order still commits — the change is narrow
 *
 * Runs against a REAL sqlite database (data/roots.db, created by database.js on
 * require and gitignored). Every row it writes is namespaced to ids in the
 * 991000+ range and deleted on the way out, so it is re-runnable and leaves
 * nothing behind.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));

const db = tdb();
let pass = 0;
const ok = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  console.log('  ✓ ' + label);
  pass++;
};

// Ids well outside anything real, so a developer's own database is untouched.
const STORE = 991001;
const PROD  = 991002;
const BASE  = 991100;
const ids   = [];

function cleanup() {
  try {
    db.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(STORE);
    for (const id of ids) db.prepare('DELETE FROM retail_orders WHERE id = ?').run(id);
    db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
    db.prepare('DELETE FROM store_products WHERE id = ?').run(PROD);
    db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  } catch (e) { /* best effort — the fixture owns only its own ids */ }
}

process.on('exit', cleanup);
cleanup();   // in case a previous crashed run left rows behind

// ── Fixture ─────────────────────────────────────────────────────────────────
db.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
            VALUES (?, ?, ?, 1, 99)`).run(STORE, 'tst-plat-single', 'Fixture store');
db.prepare('INSERT INTO store_products (id, name_en, sku) VALUES (?,?,?)')
  .run(PROD, 'Fixture product', 'TST-PLAT-SINGLE');
db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)')
  .run(STORE, PROD, 100);

const onHand = () => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(STORE, PROD).q;
const prepareRows = (orderId) => db.prepare(
  `SELECT COUNT(*) AS n FROM retail_stock_ledger
    WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_prepare'`
).get(orderId).n;

let seq = 0;
function makeOrder({ channel, source = null }) {
  const id = BASE + (++seq);
  ids.push(id);
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, store_id, fulfillment_type, channel, source)
              VALUES (?, ?, 'paid', ?, 'delivery', ?, ?)`)
    .run(id, 'TPS' + id, STORE, channel, source);
  return id;
}

// What the ingest does: the ledgered adjuster, NOT keyed to the order. This is
// the exact call shape in routes/meituan-internal.js and routes/eleme-internal.js.
function ingestDeduct(reason, qty) {
  inventory.adjustStock({
    storeId: STORE, productId: PROD, deltaQty: -qty,
    actorLabel: 'fixture ingest', reason, note: 'fixture',
  });
}

// ── 1 & 2 · Platform orders ─────────────────────────────────────────────────
for (const [channel, reason] of [['meituan', 'meituan_order'], ['eleme', 'eleme_order']]) {
  console.log(`\n${channel}: an order the ingest already deducted:`);
  const before = onHand();
  const id = makeOrder({ channel });
  ingestDeduct(reason, 1);
  ok(`the ingest took 1 off`, onHand(), before - 1);

  // The forward transition — rider picks up, delivered, or staff move it on.
  const res = inventory.commitUnreservedOrder(id, [{ product_id: PROD, qty: 1 }], { note: 'TPS' + id });
  ok(`the commit step declines it`, res, { skipped: 'platform_deducted' });
  ok(`the shelf is still down by exactly 1, not 2`, onHand(), before - 1);
  ok(`no 'order_prepare' row was written for it`, prepareRows(id), 0);
}

// ── 3 · A replacement for a Meituan order ───────────────────────────────────
console.log('\na replacement parcel for a Meituan order:');
{
  const before = onHand();
  const id = makeOrder({ channel: 'meituan', source: 'replacement' });
  const res = inventory.commitUnreservedOrder(id, [{ product_id: PROD, qty: 1 }], { note: 'TPS' + id });
  ok('it still commits — no ingest ever saw these goods', res.committed, 1);
  ok('the shelf goes down by 1', onHand(), before - 1);
  ok("one 'order_prepare' row records it", prepareRows(id), 1);
}

// ── 4 · An ordinary order is unchanged ──────────────────────────────────────
console.log('\nan ordinary mini-app order:');
{
  const before = onHand();
  const id = makeOrder({ channel: 'wechat' });
  const res = inventory.commitUnreservedOrder(id, [{ product_id: PROD, qty: 1 }], { note: 'TPS' + id });
  ok('it commits as before', res.committed, 1);
  ok('the shelf goes down by 1', onHand(), before - 1);
}

console.log(`\nPASS — ${pass} assertions held\n`);
