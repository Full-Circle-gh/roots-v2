// Admin API for Guanyi (gzgrocery) stock sync. Mounted in server.js alongside
// retail-inventory + meituan-admin. Same auth gate (requireRetailAdmin) and
// { success: true, ... } response shape as the Meituan admin routes.
//
// The matching trick: Guanyi's own code is not our SKU, but our SKU ("1-180")
// is embedded in the Guanyi product name ("GVF 1-180 …"). Auto-match extracts
// that SKU from the cached listing names and binds each Roots product to its
// Guanyi entry, caching Guanyi's internal ids for the daemon to write with.

'use strict';

const express = require('express');
const router  = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

// Which Roots store mirrors to Guanyi (gzgrocery has a single 天河 warehouse).
const GUANYI_STORE_CODE = process.env.GUANYI_STORE_CODE || 'tianhe';

// Extract the Roots SKU from a Guanyi product name. The SKU is the first
// <digits>-<digits> token (e.g. "GVF 1-180 纯素…" → "1-180"). Combo names carry
// extra tokens ("… + 1-320 D 酱") but the FIRST match is always the product's own.
function skuFromGuanyiName(name) {
  const m = String(name || '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// Resolve the configured Guanyi store row (id + code). Falls back to the first
// active store if the configured code isn't found.
function guanyiStore(db) {
  let s = db.prepare('SELECT id, code FROM retail_stores WHERE code = ? AND is_active = 1').get(GUANYI_STORE_CODE);
  if (!s) s = db.prepare('SELECT id, code FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1').get();
  return s || null;
}

// ── GET /api/retail-admin/guanyi/products ───────────────────────────────────
// All products with their guanyi_product_map entry + (when present) the
// auto-match suggestion from the cached listings.
router.get('/api/retail-admin/guanyi/products', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const includeInactive = req.query.includeInactive === '1';
    const store = guanyiStore(db);
    const storeId = store ? store.id : -1;
    const products = db.prepare(`
      SELECT p.id, p.name_cn, p.name_en, p.category, p.is_active,
             p.variant_label, p.variant_group_id, p.sku AS product_sku,
             COALESCE(ss.physical_qty, 0) AS our_qty
        FROM store_products p
        LEFT JOIN retail_store_stock ss ON ss.product_id = p.id AND ss.store_id = ?
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY p.name_cn, p.variant_group_id, p.id
    `).all(storeId);

    const maps = db.prepare(`
      SELECT product_id, retail_store_id, store_code, guanyi_name, guanyi_code,
             guanyi_sku_id, sync_enabled, last_pushed_qty, last_delta, last_pushed_at
        FROM guanyi_product_map
    `).all();
    const mapByProduct = {};
    for (const m of maps) mapByProduct[m.product_id] = m;

    // Build a sku → listing index from the cache so the UI can show what each
    // product WOULD match to even before mapping is saved.
    const listings = db.prepare('SELECT guanyi_name, code, sku_id, current_qty FROM guanyi_listings WHERE store_code = ?').all(GUANYI_STORE_CODE);
    const listingBySku = {};
    for (const l of listings) {
      const sku = skuFromGuanyiName(l.guanyi_name);
      if (sku && !listingBySku[sku]) listingBySku[sku] = l;
    }

    res.json({
      success: true,
      storeCode: GUANYI_STORE_CODE,
      data: products.map(p => ({
        ...p,
        map: mapByProduct[p.id] || null,
        suggestion: (p.product_sku && listingBySku[String(p.product_sku).trim()]) || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/guanyi/stores ─────────────────────────────────────
router.get('/api/retail-admin/guanyi/stores', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(`
      SELECT id, code, COALESCE(name_cn, name_en, code) AS name
        FROM retail_stores ORDER BY sort_order, id
    `).all();
    res.json({ success: true, data: stores, guanyiStoreCode: GUANYI_STORE_CODE });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/guanyi/products/:id/map ──────────────────────────
// Upsert/clear one product's Guanyi mapping. body: { skuId?, ... } — when skuId
// is empty the mapping is removed; otherwise we bind to the chosen listing and
// cache its ids. If only sync_enabled toggles, the ids are preserved.
router.post('/api/retail-admin/guanyi/products/:id/map', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const productId = parseInt(req.params.id, 10);
  const { skuId, syncEnabled } = req.body || {};
  try {
    const store = guanyiStore(db);
    if (!store) return res.status(400).json({ success: false, error: 'no active store' });

    if (skuId === '' || skuId === null) {
      db.prepare('DELETE FROM guanyi_product_map WHERE product_id = ? AND retail_store_id = ?').run(productId, store.id);
      return res.json({ success: true, deleted: true });
    }

    // Bind by a specific Guanyi listing (sku_id) chosen by the operator.
    if (skuId) {
      const l = db.prepare('SELECT * FROM guanyi_listings WHERE store_code = ? AND sku_id = ?').get(store.code, String(skuId));
      if (!l) return res.status(404).json({ success: false, error: 'Guanyi listing not found — refresh the list first' });
      upsertMap(db, store, productId, l, syncEnabled);
      return res.json({ success: true });
    }

    // No skuId in body → just toggle sync_enabled on an existing mapping.
    db.prepare('UPDATE guanyi_product_map SET sync_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND retail_store_id = ?')
      .run(syncEnabled ? 1 : 0, productId, store.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function upsertMap(db, store, productId, listing, syncEnabled) {
  const sync = syncEnabled === undefined ? 1 : (syncEnabled ? 1 : 0);
  db.prepare(`
    INSERT INTO guanyi_product_map
      (product_id, retail_store_id, store_code, guanyi_name, guanyi_code,
       guanyi_sku_id, guanyi_item_id, guanyi_item_sku_id, sync_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(retail_store_id, product_id) DO UPDATE SET
      store_code         = excluded.store_code,
      guanyi_name        = excluded.guanyi_name,
      guanyi_code        = excluded.guanyi_code,
      guanyi_sku_id      = excluded.guanyi_sku_id,
      guanyi_item_id     = excluded.guanyi_item_id,
      guanyi_item_sku_id = excluded.guanyi_item_sku_id,
      sync_enabled       = excluded.sync_enabled,
      updated_at         = CURRENT_TIMESTAMP
  `).run(productId, store.id, store.code, listing.guanyi_name, listing.code,
         listing.sku_id, listing.item_id, listing.item_sku_id, sync);
}

// ── POST /api/retail-admin/guanyi/auto-match ────────────────────────────────
// Bind every Roots product to its Guanyi listing by the SKU embedded in the
// listing name. Only fills products that have a confident single match; reports
// ambiguous (sku→multiple listings) and unmatched for operator review.
router.post('/api/retail-admin/guanyi/auto-match', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const store = guanyiStore(db);
    if (!store) return res.status(400).json({ success: false, error: 'no active store' });

    const listings = db.prepare('SELECT * FROM guanyi_listings WHERE store_code = ?').all(store.code);
    if (!listings.length) return res.json({ success: true, matched: 0, note: 'No cached Guanyi listings — click Refresh first.' });

    // sku → [listings]. A combo and its base product can share a leading sku, so
    // track multiplicity and only auto-bind unambiguous matches.
    const bySku = {};
    for (const l of listings) {
      const sku = skuFromGuanyiName(l.guanyi_name);
      if (sku) (bySku[sku] = bySku[sku] || []).push(l);
    }

    const products = db.prepare("SELECT id, sku FROM store_products WHERE is_active = 1 AND sku IS NOT NULL AND TRIM(sku) <> ''").all();
    let matched = 0; const ambiguous = []; const unmatched = [];
    const tx = db.transaction(() => {
      for (const p of products) {
        const cands = bySku[String(p.sku).trim()];
        if (!cands || !cands.length) { unmatched.push(p.sku); continue; }
        if (cands.length > 1) { ambiguous.push({ sku: p.sku, count: cands.length }); continue; }
        upsertMap(db, store, p.id, cands[0], 1);
        matched++;
      }
    });
    tx();

    res.json({ success: true, matched, ambiguous, unmatched: unmatched.length, ambiguousList: ambiguous, listings: listings.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/guanyi/listings/refresh ──────────────────────────
router.post('/api/retail-admin/guanyi/listings/refresh', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const code = GUANYI_STORE_CODE;
    const pending = db.prepare("SELECT 1 FROM guanyi_listing_jobs WHERE store_code = ? AND status IN ('pending','processing')").get(code);
    if (pending) return res.json({ success: true, queued: [], alreadyRunning: [code] });
    db.prepare("INSERT INTO guanyi_listing_jobs (store_code, status) VALUES (?, 'pending')").run(code);
    res.json({ success: true, queued: [code], alreadyRunning: [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/guanyi/listings ───────────────────────────────────
// Cached Guanyi product rows + latest refresh-job status (so the UI can poll).
router.get('/api/retail-admin/guanyi/listings', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const rows = db.prepare(`
      SELECT guanyi_name, code, sku_id, current_qty, warehouse_name
        FROM guanyi_listings WHERE store_code = ? ORDER BY guanyi_name
    `).all(GUANYI_STORE_CODE);
    const job = db.prepare(`
      SELECT status, result_count, error, created_at, completed_at
        FROM guanyi_listing_jobs WHERE store_code = ? ORDER BY id DESC LIMIT 1
    `).get(GUANYI_STORE_CODE);
    const running = db.prepare("SELECT COUNT(*) AS n FROM guanyi_listing_jobs WHERE status IN ('pending','processing')").get()?.n || 0;
    res.json({ success: true, listings: rows, job: job || null, running });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/guanyi/status ─────────────────────────────────────
router.get('/api/retail-admin/guanyi/status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queuePending = db.prepare("SELECT COUNT(*) AS n FROM guanyi_sync_queue WHERE status='pending'").get()?.n || 0;
    const queueError   = db.prepare("SELECT COUNT(*) AS n FROM guanyi_sync_queue WHERE status='error'").get()?.n || 0;
    const mappedCount  = db.prepare('SELECT COUNT(*) AS n FROM guanyi_product_map WHERE sync_enabled=1').get()?.n || 0;
    const recentLogs = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM guanyi_sync_log ORDER BY created_at DESC LIMIT 20
    `).all();
    res.json({ success: true, queuePending, queueError, mappedCount, recentLogs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/guanyi/push-all ──────────────────────────────────
// Queue a reconcile for every mapped, enabled product.
router.post('/api/retail-admin/guanyi/push-all', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const mapped = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code,
             COALESCE(s.physical_qty, 0) AS qty
        FROM guanyi_product_map m
        LEFT JOIN retail_store_stock s
               ON s.product_id = m.product_id AND s.store_id = m.retail_store_id
       WHERE m.sync_enabled = 1
    `).all();
    const insert = db.prepare(`
      INSERT INTO guanyi_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const tx = db.transaction(() => { for (const r of mapped) insert.run(r.retail_store_id, r.product_id, r.store_code, r.qty); });
    tx();
    res.json({ success: true, queued: mapped.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
