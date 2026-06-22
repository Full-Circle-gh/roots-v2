// Internal-only API for the meituan-daemon process.
// Only accepts requests from 127.0.0.1 with the correct X-Internal-Secret header.
// Mounted at /api/internal/meituan in server.js.

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');

const INTERNAL_SECRET = process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal';

// Guard: localhost only + secret header
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

// POST /api/internal/meituan/ingest-order
// Creates a retail_order from a parsed Meituan order object.
// The daemon calls this after accepting the order on Meituan.
router.post('/ingest-order', (req, res) => {
  const { storeId, storeCode, order } = req.body || {};
  if (!storeId || !order) return res.status(400).json({ error: 'storeId and order required' });

  try {
    // Generate order number
    const now   = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand  = Math.floor(Math.random() * 900000) + 100000;
    const orderNo = `MT${datePart}${rand}`;

    // Map Meituan items to roots-v2 products by name
    const items = (order.items || []).map(item => {
      const nameCn = (item.name || '').trim();
      // Match product by name_cn or name_en (case-insensitive)
      const product = db.prepare(`
        SELECT p.id, p.name_cn, p.name_en,
               COALESCE(s.physical_qty, 0) AS stock
          FROM products p
          LEFT JOIN retail_store_stock s ON s.product_id = p.id AND s.store_id = ?
         WHERE p.name_cn LIKE ? OR p.name_en LIKE ?
         LIMIT 1
      `).get(storeId, `%${nameCn}%`, `%${nameCn}%`);

      return {
        productId:  product?.id || null,
        nameCn:     nameCn,
        nameEn:     product?.name_en || nameCn,
        qty:        parseInt(item.qty) || 1,
        unitPrice:  parseFloat(item.price) || 0,
        lineTotal:  (parseFloat(item.price) || 0) * (parseInt(item.qty) || 1),
      };
    }).filter(i => i.qty > 0);

    const total    = parseFloat(order.total) || items.reduce((s, i) => s + i.lineTotal, 0);
    const subtotal = total;

    const tx = db.transaction(() => {
      // Insert order
      const orderResult = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method,
          subtotal, total,
          store_id, channel, fulfillment_type,
          placed_at, paid_at
        ) VALUES (?, 'paid', 'meituan', ?, ?, ?, 'meituan', 'delivery',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orderNo, subtotal, total, storeId);

      const orderId = orderResult.lastInsertRowid;

      // Insert order items + deduct stock
      for (const item of items) {
        db.prepare(`
          INSERT INTO retail_order_items
            (order_id, product_id, name_cn, name_en, qty, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(orderId, item.productId, item.nameCn, item.nameEn,
               item.qty, item.unitPrice, item.lineTotal);

        // Deduct from store stock
        if (item.productId) {
          db.prepare(`
            UPDATE retail_store_stock
               SET physical_qty = MAX(0, physical_qty - ?),
                   updated_at   = CURRENT_TIMESTAMP
             WHERE store_id = ? AND product_id = ?
          `).run(item.qty, storeId, item.productId);

          // Queue stock push back to Meituan (so listing reflects the deduction)
          db.prepare(`
            INSERT INTO meituan_sync_queue
              (retail_store_id, product_id, store_code, new_qty, status)
            SELECT ?, ?, ?, COALESCE(physical_qty, 0), 'pending'
              FROM retail_store_stock
             WHERE store_id = ? AND product_id = ?
          `).run(storeId, item.productId, storeCode, storeId, item.productId);
        }
      }

      return orderId;
    });

    const orderId = tx();

    res.json({ ok: true, orderId, orderNo });
  } catch (err) {
    console.error('[meituan-internal] ingest-order error:', err);
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
