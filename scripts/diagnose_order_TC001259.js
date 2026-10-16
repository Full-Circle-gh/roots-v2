#!/usr/bin/env node
/**
 * Read-only survey of ONE order — TC001259 — sitting in "Awaiting restock".
 *
 * Context (Ash, 2026-10-16): TC001259 shows "Waiting on stock at Yuexiu" for
 * Mix Berries Kombucha (2-100) ×5 and Passion Fruit Kombucha (2-80) ×1, "The
 * customer chose to wait". The question is why an out-of-stock item could be
 * ordered at all instead of showing as sold out.
 *
 * The menu's sold-out badge reads physical stock summed across every open shop
 * (inventory.sellableStockSql), with no reservations taken off. Checkout checks
 * the NEAREST shop only (inventory.analyzeShortage). This prints the numbers
 * each of those saw, so the answer is read rather than guessed: per-shop
 * stock, the holds against it, and the ledger around the order's placed_at.
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 */
'use strict';

const ORDER_NO = 'TC001259';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('');

const J = (x) => JSON.stringify(x, null, 2);
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return { ERROR: e.message }; } };
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { ERROR: e.message }; } };

// ════════════════════════════════════════════════════════════════════════════
// 0 — the order
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · order ══');
const row = one('SELECT * FROM retail_orders WHERE order_no = ?', ORDER_NO);
const KEEP = ['id', 'order_no', 'status', 'fallback_choice', 'routing_reason', 'store_id',
  'awaiting_restock_pids', 'delivery_slot_label', 'delivery_slot_kind', 'placed_at',
  'paid_at', 'channel', 'fulfillment_type', 'city', 'district'];
const o = row && !row.ERROR ? Object.fromEntries(KEEP.filter(k => k in row).map(k => [k, row[k]])) : row;
if (!o || o.ERROR) { console.log('NOT FOUND / ' + J(o)); process.exit(1); }
console.log(J(o));
const ID = o.id;
const AT = o.placed_at || o.paid_at;
console.log('');

console.log('══ 1 · items ══');
const items = all(
  `SELECT oi.product_id, oi.qty, sp.sku, sp.name_en, sp.oos_policy, sp.stock_qty AS legacy_stock_qty
     FROM retail_order_items oi
     LEFT JOIN store_products sp ON sp.id = oi.product_id
    WHERE oi.order_id = ? ORDER BY oi.id`, ID);
console.log(J(items));
console.log('');

console.log('══ 2 · shops ══');
console.log(J(all('SELECT id, code, name_en, is_active FROM retail_stores ORDER BY id')));
console.log('');

let pids = [];
try { pids = JSON.parse(o.awaiting_restock_pids || '[]'); } catch (_) { pids = []; }
if (!pids.length && Array.isArray(items)) pids = items.map(i => i.product_id);

for (const pid of pids) {
  const p = one('SELECT id, sku, name_en, oos_policy, is_published FROM store_products WHERE id = ?', pid);
  console.log('════════ product ' + pid + ' · ' + J(p));

  console.log('── 3 · per-shop stock NOW ──');
  console.log(J(all(
    `SELECT rs.code, rss.physical_qty, rss.safety_buffer, rss.wechat_quota, rss.updated_at
       FROM retail_store_stock rss JOIN retail_stores rs ON rs.id = rss.store_id
      WHERE rss.product_id = ? ORDER BY rs.id`, pid)));

  console.log('── 4 · active holds NOW ──');
  console.log(J(all(
    `SELECT rs.code, r.order_id, r.qty, r.channel, r.status, r.created_at, r.expires_at
       FROM retail_stock_reservations r JOIN retail_stores rs ON rs.id = r.store_id
      WHERE r.product_id = ? AND r.status = 'active' ORDER BY r.id`, pid)));

  console.log('── 5 · holds that were active at placed_at (' + AT + ') ──');
  console.log(J(all(
    `SELECT rs.code, r.order_id, r.qty, r.channel, r.status, r.created_at,
            r.committed_at, r.released_at
       FROM retail_stock_reservations r JOIN retail_stores rs ON rs.id = r.store_id
      WHERE r.product_id = ? AND r.created_at <= ?
        AND COALESCE(r.committed_at, r.released_at, '9999') > ?
      ORDER BY r.id`, pid, AT, AT)));

  console.log('── 6 · ledger, 3 days before placed_at to now ──');
  console.log(J(all(
    `SELECT rs.code, l.delta, l.reason, l.balance_after, l.ref_table, l.ref_id, l.note, l.created_at
       FROM retail_stock_ledger l JOIN retail_stores rs ON rs.id = l.store_id
      WHERE l.product_id = ? AND l.created_at >= datetime(?, '-3 days')
      ORDER BY l.id`, pid, AT)));
  console.log('');
}

console.log('══ 7 · activity_log ══');
console.log(J(all(
  `SELECT id, username, action, details, created_at
     FROM activity_log
    WHERE entity_type = 'retail_order' AND entity_id = ?
    ORDER BY id`, ID)));
