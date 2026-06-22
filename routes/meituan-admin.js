// Admin API for Meituan bidirectional sync configuration.
// Mounted in server.js alongside retail-inventory.
//
// Auth: uses requireRetailAdmin (the dual-realm gate shared by every other
// /api/retail-admin/* endpoint). Using the kitchen-only requireAuth here would
// 401 backend operators, and that single 401 bounces retail-admin.html into a
// /backend/login → /retail-admin redirect (lands on the dashboard).
//
// Response shape: every endpoint returns { success: true, ... } because the
// admin api() helper treats a missing `success` flag as a thrown error.

'use strict';

const express = require('express');
const router  = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

// ── GET /api/retail-admin/meituan/products ─────────────────────────────────
// All products with their meituan_product_map entries per store.
router.get('/api/retail-admin/meituan/products', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const products = db.prepare(`
      SELECT p.id, p.name_cn, p.name_en, p.category, p.is_active
        FROM products p
       ORDER BY p.name_cn
    `).all();

    const maps = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code,
             m.meituan_name, m.sync_enabled,
             m.last_pushed_qty, m.last_pushed_at
        FROM meituan_product_map m
    `).all();

    const mapIndex = {};
    for (const m of maps) {
      if (!mapIndex[m.product_id]) mapIndex[m.product_id] = {};
      mapIndex[m.product_id][m.store_code] = m;
    }

    res.json({
      success: true,
      data: products.map(p => ({ ...p, stores: mapIndex[p.id] || {} })),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/stores ──────────────────────────────────
router.get('/api/retail-admin/meituan/stores', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(`
      SELECT id, code,
             COALESCE(name_cn, name_en, code) AS name
        FROM retail_stores
       ORDER BY sort_order, id
    `).all();
    res.json({ success: true, data: stores });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/products/:id/map ───────────────────────
// Upsert a product's meituan mapping for one store. Empty name → delete.
router.post('/api/retail-admin/meituan/products/:id/map', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const productId = parseInt(req.params.id);
  const { storeId, storeCode, meituanName, syncEnabled } = req.body || {};
  if (!storeId || !storeCode) return res.status(400).json({ success: false, error: 'storeId and storeCode required' });

  try {
    if (!meituanName || meituanName.trim() === '') {
      db.prepare('DELETE FROM meituan_product_map WHERE product_id = ? AND retail_store_id = ?')
        .run(productId, storeId);
      return res.json({ success: true, deleted: true });
    }

    db.prepare(`
      INSERT INTO meituan_product_map
        (product_id, retail_store_id, store_code, meituan_name, sync_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(retail_store_id, product_id) DO UPDATE SET
        meituan_name = excluded.meituan_name,
        store_code   = excluded.store_code,
        sync_enabled = excluded.sync_enabled,
        updated_at   = CURRENT_TIMESTAMP
    `).run(productId, storeId, storeCode, meituanName.trim(), syncEnabled ? 1 : 0);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/status ─────────────────────────────────
router.get('/api/retail-admin/meituan/status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queuePending = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='pending'").get()?.n || 0;
    const queueFailed  = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='failed'").get()?.n || 0;
    const recentLogs = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log ORDER BY created_at DESC LIMIT 20
    `).all();
    const lastOrder = db.prepare(`
      SELECT meituan_order_no, store_code, imported_at, status
        FROM meituan_order_import ORDER BY imported_at DESC LIMIT 5
    `).all();
    const mappedCount = db.prepare('SELECT COUNT(*) AS n FROM meituan_product_map WHERE sync_enabled=1').get()?.n || 0;

    res.json({ success: true, queuePending, queueFailed, recentLogs, lastOrder, mappedCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/push-all ──────────────────────────────
// Queue a stock push for every mapped product ("sync now").
router.post('/api/retail-admin/meituan/push-all', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const mapped = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code,
             COALESCE(s.physical_qty, 0) AS qty
        FROM meituan_product_map m
        LEFT JOIN retail_store_stock s
               ON s.product_id = m.product_id AND s.store_id = m.retail_store_id
       WHERE m.sync_enabled = 1
    `).all();

    const insert = db.prepare(`
      INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const tx = db.transaction(() => {
      for (const row of mapped) insert.run(row.retail_store_id, row.product_id, row.store_code, row.qty);
    });
    tx();

    res.json({ success: true, queued: mapped.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
