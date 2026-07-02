// Internal-only API for the meituan-daemon process.
// Only accepts requests from 127.0.0.1 with the correct X-Internal-Secret header.
// Mounted at /api/internal/meituan in server.js.

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const inventory = require('../lib/inventory');

const INTERNAL_SECRET = process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal';

// Guard: localhost only + secret header
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

// Collapse a name for comparison: drop spec parens, whitespace, punctuation and
// case so "巧克力榛棒 Premium Nutella Bars" and its map entry compare equal even
// across the CN/EN word order and stray spacing Meituan inserts.
function normName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')          // (300ml), (1-300) specs
    .replace(/[\s　]+/g, '')          // all spaces incl. full-width
    .replace(/[^\p{L}\p{N}]/gu, '')       // punctuation/symbols
    .toLowerCase();
}

// Resolve one parsed Meituan line-item to a store_product.
//
// Resolution order, most reliable first:
//   1. Inline "(\d+-\d+)" SKU token the merchant encodes in the spec name.
//   2. meituan_product_map — the SAME Roots↔Meituan bridge stock-push uses. The
//      operator maps each product to its exact Meituan listing title, so when the
//      listing carries no SKU token AND its display name differs from the Roots
//      product name (e.g. Meituan "巧克力榛棒 Premium Nutella Bars" vs Roots
//      "巧克力榛果棒 / Choco-Hazel Bars"), the map is the only thing that links
//      them. Without this, such lines silently failed to deduct stock.
//   3. UNIQUE active name match (CJK core, then English) as a last resort.
// Ambiguous/no match → productId null (not deducted, surfaced as unresolved).
function resolveProduct(item, storeId) {
  const qty = parseInt(item.qty, 10) || 0;
  const out = { name: item.name, sku: item.sku || null, qty, productId: null, nameCn: item.name, nameEn: item.name, matchBy: null };
  const apply = (p, by) => { out.productId = p.id; out.nameCn = p.name_cn; out.nameEn = p.name_en; out.matchBy = by; };

  // 1. Inline SKU token.
  if (item.sku) {
    const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(item.sku)
           || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(item.sku);
    if (p) { apply(p, 'sku'); return out; }
    // Token didn't resolve — fall through to the map/name strategies rather than
    // stranding the line on a stale or mistyped SKU code.
    out.matchBy = 'sku_unknown';
  }

  // 2. Product map by Meituan listing name (scoped to this store).
  if (storeId) {
    const wanted = normName(item.name);
    if (wanted) {
      const rows = db.prepare(`
        SELECT p.id, p.name_cn, p.name_en, m.meituan_name
          FROM meituan_product_map m
          JOIN store_products p ON p.id = m.product_id
         WHERE m.retail_store_id = ? AND p.is_active = 1 AND m.meituan_name IS NOT NULL
      `).all(storeId);
      let hit = rows.find(r => normName(r.meituan_name) === wanted);
      if (!hit) {
        // Substring either way (Meituan sometimes appends/trims a suffix), but
        // only when it's unambiguous.
        const cands = rows.filter(r => {
          const mn = normName(r.meituan_name);
          return mn && (mn.includes(wanted) || wanted.includes(mn));
        });
        if (cands.length === 1) hit = cands[0];
      }
      if (hit) { apply(hit, 'map'); return out; }
    }
  }

  // 3. Unique active name match.
  const clean = String(item.name || '').replace(/\([^)]*\)/g, ' ').trim();
  const cjk = (clean.match(/[一-鿿]+/) || [])[0];
  const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
  let matches = [];
  if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
  if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
  if (matches.length === 1) { apply(matches[0], 'name'); }
  else if (!out.matchBy || out.matchBy === 'sku_unknown') out.matchBy = matches.length > 1 ? 'ambiguous' : 'unmatched';
  return out;
}

// Map a Meituan platform status label → our internal `status` so the order
// shows OUR lifecycle vocabulary (Paid/Preparing/Dispatched/Delivered) and
// lands in the matching Orders tab, exactly like mini-app/web orders. The exact
// Meituan label is still kept in channel_status for the detail drawer. Ordered
// so pre-dispatch labels that happen to contain 配送 (待发起配送/待配送) classify
// as preparing, not dispatched. Returns null for unpaid/unknown → keep 'paid'.
function internalStatusForChannel(desc) {
  const d = String(desc || '');
  if (!d) return null;
  if (/退款|退货/.test(d))                                        return 'refunded';
  if (/取消|已关闭|交易关闭/.test(d))                             return 'cancelled';
  if (/已完成|交易完成|已送达|已收货|订单完成|已签收/.test(d))     return 'delivered';
  if (/待发起配送|待配送|待接单|已接单|待拣货|拣货|备货|待发货|制作/.test(d)) return 'preparing';
  if (/配送|派送|骑手|取货/.test(d))                              return 'dispatched';
  return null; // 待支付 / unknown → keep 'paid'
}

// POST /api/internal/meituan/ingest-order
// Mirrors a parsed Meituan order into roots: creates a retail_order and deducts
// store stock (ledgered, which re-pushes the corrected number to Meituan +
// Guanyi via enqueueChannelSync). Returns { orderId, deducted, unresolved }.
router.post('/ingest-order', (req, res) => {
  const { storeId, storeCode, order } = req.body || {};
  if (!storeId || !order) return res.status(400).json({ error: 'storeId and order required' });

  try {
    const now      = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand     = Math.floor(Math.random() * 900000) + 100000;
    const orderNo  = `MT${datePart}${rand}`;
    const ref      = order.meituanOrderNo || orderNo;

    const items = (order.items || []).map(it => resolveProduct(it, storeId)).filter(i => i.qty > 0);
    const total = parseFloat(order.total) || 0;
    // Real platform status label (拣货中 / 配送中 / 已完成 / 已取消 …). The internal
    // `status` stays 'paid' — this is a read-only mirror we never fulfil ourselves
    // — but channel_status carries Meituan's own lifecycle so the Orders list shows
    // the true state instead of a fixed "Paid". Refreshed on later polls via
    // /update-order-status.
    const channelStatus = (order.statusDesc && String(order.statusDesc).trim()) || null;
    const channelEta    = (order.eta && String(order.eta).trim()) || null;
    // A terminal Meituan label (已完成/已取消/退款…) maps to the matching internal
    // status so the order lands in the right tab; anything in-progress → 'paid'.
    const internalStatus = internalStatusForChannel(channelStatus) || 'paid';

    // 1. Create the order + its line items in one transaction.
    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method, subtotal, total,
          store_id, channel, fulfillment_type, placed_at, paid_at,
          channel_status, channel_status_at, channel_eta
        ) VALUES (?, ?, 'meituan', ?, ?, ?, 'meituan', 'delivery',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?)
      `).run(orderNo, internalStatus, total, total, storeId, channelStatus, channelStatus, channelEta);
      const oid = r.lastInsertRowid;
      for (const it of items) {
        // Snapshot the Meituan 货号 (SKU token) so the view-only order drawer can
        // show it per line — including UNMATCHED lines (productId null), which
        // have no store_products row for the detail route to pull a SKU from.
        db.prepare(`
          INSERT INTO retail_order_items
            (order_id, product_id, name_cn, name_en, sku, qty, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0)
        `).run(oid, it.productId, it.nameCn, it.nameEn, it.sku || null, it.qty);
      }
      return oid;
    })();

    // 2. Deduct stock via the ledgered adjuster (also re-pushes to Meituan +
    //    Guanyi). Clamp at 0 — a Meituan oversell shouldn't drive us negative.
    const unresolved = [];
    let deducted = 0;
    for (const it of items) {
      if (!it.productId) { unresolved.push({ name: it.name, sku: it.sku, qty: it.qty, reason: it.matchBy }); continue; }
      const cur  = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, it.productId);
      const oldQ = cur ? cur.physical_qty : 0;
      inventory.adjustStock({
        storeId, productId: it.productId,
        newPhysicalQty: Math.max(0, oldQ - it.qty),
        actorLabel: 'Meituan order',
        reason: 'meituan_order',
        note: `Meituan ${ref}${order.daySeq != null ? ` #${order.daySeq}` : ''} — ${it.nameEn} x${it.qty}`,
      });
      deducted++;
    }

    // 3. Surface unmatched line-items. Previously these were dropped silently —
    //    a combo component with no SKU token / map entry just vanished, leaving
    //    no ledger row and no trace (e.g. an un-mapped 套餐). Log every order's
    //    matched/unmatched breakdown so gaps are visible in the sync log and the
    //    operator can map what's missing instead of guessing.
    if (unresolved.length) {
      try {
        const matched = items.filter(i => i.productId)
          .map(i => ({ name: i.name, sku: i.sku, qty: i.qty, by: i.matchBy }));
        db.prepare(`
          INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_unsynced', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, deducted, matched, unresolved }),
          `${unresolved.length} item(s) not synced: ` +
            unresolved.map(u => `${u.name}${u.sku ? ` (${u.sku})` : ''} x${u.qty} [${u.reason}]`).join('; ')
        );
      } catch (logErr) {
        console.error('[meituan-internal] order_unsynced log failed:', logErr.message);
      }
    }

    res.json({ ok: true, orderId, orderNo, items: items.length, deducted, unresolved });
  } catch (err) {
    console.error('[meituan-internal] ingest-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/meituan/update-order-status
// Refresh the mirrored order's platform status label on later polls (an order
// moves 拣货中 → 配送中 → 已完成 while it stays in Meituan's hands). Idempotent:
// only writes when the label actually changed, and returns { changed }. Looked up
// by Meituan order no via meituan_order_import → retail_order_id.
router.post('/update-order-status', (req, res) => {
  const { meituanOrderNo, statusDesc, eta } = req.body || {};
  const desc = (statusDesc && String(statusDesc).trim()) || null;
  const etaVal = (eta && String(eta).trim()) || null;
  if (!meituanOrderNo || !desc) return res.status(400).json({ error: 'meituanOrderNo and statusDesc required' });

  try {
    const imp = db.prepare(
      'SELECT retail_order_id FROM meituan_order_import WHERE meituan_order_no = ?'
    ).get(String(meituanOrderNo));
    if (!imp || !imp.retail_order_id) return res.json({ ok: true, changed: false, reason: 'not_mirrored' });

    // A terminal label also advances the internal status so the order leaves the
    // Paid worklist for Delivered/Cancelled/Refunded; in-progress leaves it alone.
    const internal = internalStatusForChannel(desc);
    const r = db.prepare(`
      UPDATE retail_orders
         SET channel_status = ?, channel_status_at = CURRENT_TIMESTAMP,
             status = COALESCE(?, status),
             channel_eta = COALESCE(?, channel_eta)
       WHERE id = ?
         AND (COALESCE(channel_status,'') != ?
              OR status != COALESCE(?, status)
              OR (? IS NOT NULL AND COALESCE(channel_eta,'') != ?))
    `).run(desc, internal, etaVal, imp.retail_order_id, desc, internal, etaVal, etaVal);

    res.json({ ok: true, changed: r.changes > 0 });
  } catch (err) {
    console.error('[meituan-internal] update-order-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/internal/meituan/sync-status
// Quick health check the daemon can call to verify the server is reachable.
router.get('/sync-status', (_req, res) => {
  const queuePending = db.prepare(
    "SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='pending'"
  ).get()?.n || 0;
  const recentLogs = db.prepare(
    "SELECT * FROM meituan_sync_log ORDER BY created_at DESC LIMIT 10"
  ).all();
  res.json({ ok: true, queuePending, recentLogs });
});

module.exports = router;
