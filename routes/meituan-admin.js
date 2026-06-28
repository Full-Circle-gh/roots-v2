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
const bundleLib = require('../lib/meituan-bundles');

// ── GET /api/retail-admin/meituan/products ─────────────────────────────────
// All products with their meituan_product_map entries per store.
router.get('/api/retail-admin/meituan/products', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    // Mapping list wants active products only; the bundle-component picker passes
    // ?includeInactive=1 so an operator can attach a paused/unpublished variant.
    const includeInactive = req.query.includeInactive === '1';
    // store_products is the storefront's OWN catalog (forked from kitchen
    // `products`, own id space) and is what retail_store_stock / the editor
    // key off — so variants created in the store editor live here, not in
    // `products`. Read it so every sellable variant shows in the mapping +
    // bundle picker.
    const products = db.prepare(`
      SELECT p.id, p.name_cn, p.name_en, p.category, p.is_active,
             p.variant_label, p.variant_group_id
        FROM store_products p
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY p.name_cn, p.variant_group_id, p.id
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
    // Stock changes only (per-product pushes) — what the operator actually reads:
    // name + SKU + in/out. Queried on its own so system noise (restart, opening
    // hours, proxy) can't push these off the 20-row window.
    const recentStock = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log WHERE event_type='stock_push'
        ORDER BY created_at DESC LIMIT 25
    `).all();
    // System/status events (everything that is NOT a per-product push), kept few.
    const recentSystem = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log WHERE event_type<>'stock_push'
        ORDER BY created_at DESC LIMIT 6
    `).all();
    const lastOrder = db.prepare(`
      SELECT meituan_order_no, store_code, imported_at, status
        FROM meituan_order_import ORDER BY imported_at DESC LIMIT 5
    `).all();
    const mappedCount = db.prepare('SELECT COUNT(*) AS n FROM meituan_product_map WHERE sync_enabled=1').get()?.n || 0;

    res.json({ success: true, queuePending, queueFailed, recentLogs, recentStock, recentSystem, lastOrder, mappedCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/orders ──────────────────────────────────
// Read-only record of orders that arrived from Meituan. The daemon mirrors
// every Meituan order into retail_orders (channel='meituan') to deduct stock;
// this surfaces them as a plain ledger in the Meituan tab. The storefront does
// NOT manage these — no status workflow, no printing — so the list is just
// "an order came in": when, how much, what, and (when Meituan exposes it) who.
// Deliberately excluded from the main Orders worklist + count badges.
router.get('/api/retail-admin/meituan/orders', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const orders = db.prepare(`
      SELECT o.id, o.order_no, o.total, o.placed_at,
             o.recipient_name, o.recipient_phone, o.address_full,
             s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
        FROM retail_orders o
        LEFT JOIN retail_stores s ON s.id = o.store_id
       WHERE o.channel = 'meituan'
       ORDER BY o.placed_at DESC
       LIMIT ?
    `).all(limit);

    const itemStmt = db.prepare(`
      SELECT name_cn, name_en, qty FROM retail_order_items
       WHERE order_id = ? ORDER BY id
    `);
    for (const o of orders) o.items = itemStmt.all(o.id);

    res.json({ success: true, data: orders });
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
    let bundleCount = 0;
    const tx = db.transaction(() => {
      for (const row of mapped) insert.run(row.retail_store_id, row.product_id, row.store_code, row.qty);
      bundleCount = bundleLib.enqueueAllBundles(db);
    });
    tx();

    res.json({ success: true, queued: mapped.length + bundleCount, products: mapped.length, bundles: bundleCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Bundles (Meituan-only combos) ──────────────────────────────────────────
// GET list with components + live computed availability.
router.get('/api/retail-admin/meituan/bundles', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const bundles = db.prepare('SELECT * FROM meituan_bundles ORDER BY store_code, meituan_name').all();
    const comps = db.prepare(`
      SELECT c.bundle_id, c.product_id, c.qty, p.name_cn, p.name_en, p.variant_label
        FROM meituan_bundle_components c
        JOIN store_products p ON p.id = c.product_id
    `).all();
    const byBundle = {};
    for (const c of comps) (byBundle[c.bundle_id] = byBundle[c.bundle_id] || []).push(c);
    const data = bundles.map(b => ({
      ...b,
      components: byBundle[b.id] || [],
      available: bundleLib.bundleStock(db, b),
    }));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upsert a bundle + its components. body: { id?, storeId, storeCode, meituanName,
// maxQty?, syncEnabled?, components: [{ productId, qty }] }
router.post('/api/retail-admin/meituan/bundles', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { id, storeId, storeCode, meituanName, maxQty, syncEnabled, components } = req.body || {};
  if (!storeId || !storeCode || !meituanName || !meituanName.trim()) {
    return res.status(400).json({ success: false, error: 'storeId, storeCode and meituanName are required' });
  }
  const sync = syncEnabled === undefined ? 1 : (syncEnabled ? 1 : 0);
  const cap  = (maxQty === undefined || maxQty === null || maxQty === '') ? null : parseInt(maxQty, 10);
  try {
    const tx = db.transaction(() => {
      let bundleId = id ? parseInt(id, 10) : null;
      if (bundleId) {
        db.prepare(`
          UPDATE meituan_bundles
             SET meituan_name=?, store_code=?, retail_store_id=?, max_qty=?, sync_enabled=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?
        `).run(meituanName.trim(), storeCode, storeId, cap, sync, bundleId);
      } else {
        db.prepare(`
          INSERT INTO meituan_bundles (retail_store_id, store_code, meituan_name, max_qty, sync_enabled)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(retail_store_id, meituan_name) DO UPDATE SET
            store_code=excluded.store_code, max_qty=excluded.max_qty,
            sync_enabled=excluded.sync_enabled, updated_at=CURRENT_TIMESTAMP
        `).run(storeId, storeCode, meituanName.trim(), cap, sync);
        bundleId = db.prepare('SELECT id FROM meituan_bundles WHERE retail_store_id=? AND meituan_name=?')
          .get(storeId, meituanName.trim()).id;
      }
      db.prepare('DELETE FROM meituan_bundle_components WHERE bundle_id=?').run(bundleId);
      const ins = db.prepare('INSERT OR IGNORE INTO meituan_bundle_components (bundle_id, product_id, qty) VALUES (?, ?, ?)');
      for (const c of (components || [])) {
        if (c && c.productId) ins.run(bundleId, parseInt(c.productId, 10), c.qty > 0 ? parseInt(c.qty, 10) : 1);
      }
      return bundleId;
    });
    const bundleId = tx();
    res.json({ success: true, id: bundleId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/api/retail-admin/meituan/bundles/:id', requireRetailAdmin, (req, res) => {
  const db = tdb();
  const id = parseInt(req.params.id, 10);
  try {
    db.prepare('DELETE FROM meituan_bundle_components WHERE bundle_id=?').run(id);
    db.prepare('DELETE FROM meituan_bundles WHERE id=?').run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Enqueue a single bundle's stock now.
router.post('/api/retail-admin/meituan/bundles/:id/push', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const b = db.prepare('SELECT * FROM meituan_bundles WHERE id=?').get(parseInt(req.params.id, 10));
    if (!b) return res.status(404).json({ success: false, error: 'bundle not found' });
    const qty = bundleLib.enqueueBundle(db, b);
    if (qty == null) return res.json({ success: false, error: 'Bundle has no components yet — add at least one product first.' });
    res.json({ success: true, qty });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/listings/refresh ───────────────────────
// Enqueue a listing-scrape job per store for the daemon to run. Skips stores
// that already have a pending/processing job so repeated clicks don't pile up.
router.post('/api/retail-admin/meituan/listings/refresh', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(
      `SELECT code FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();

    const pending = db.prepare(
      `SELECT store_code FROM meituan_listing_jobs WHERE status IN ('pending','processing')`
    ).all().map(r => r.store_code);

    const insert = db.prepare(
      `INSERT INTO meituan_listing_jobs (store_code, status) VALUES (?, 'pending')`
    );
    const queued = [];
    for (const s of stores) {
      if (pending.includes(s.code)) continue;
      insert.run(s.code);
      queued.push(s.code);
    }

    res.json({ success: true, queued, alreadyRunning: pending });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/listings ────────────────────────────────
// Cached listing names per store + the latest job status per store (so the UI
// can poll until the scrape finishes).
router.get('/api/retail-admin/meituan/listings', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const rows = db.prepare(
      `SELECT store_code, listing_name FROM meituan_listings ORDER BY store_code, listing_name`
    ).all();
    const listings = {};
    for (const r of rows) (listings[r.store_code] = listings[r.store_code] || []).push(r.listing_name);

    // Latest job per store
    const jobs = db.prepare(`
      SELECT j.store_code, j.status, j.result_count, j.error, j.created_at, j.completed_at
        FROM meituan_listing_jobs j
        JOIN (SELECT store_code, MAX(id) AS mx FROM meituan_listing_jobs GROUP BY store_code) m
          ON m.store_code = j.store_code AND m.mx = j.id
    `).all();

    const running = db.prepare(
      `SELECT COUNT(*) AS n FROM meituan_listing_jobs WHERE status IN ('pending','processing')`
    ).get()?.n || 0;

    res.json({ success: true, listings, jobs, running });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
