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

// ── GET /api/retail-admin/guanyi/pickups ────────────────────────────────────
// gzgrocery pickup inference surface: flagged (capped, awaiting an operator
// decision) + recent auto-applied pickups + current mode. The daemon infers a
// pickup from a drop in Guanyi stock; big/suspicious drops are 'capped' and wait
// here for Apply/Ignore so nothing is silently lost or silently slashed.
router.get('/api/retail-admin/guanyi/pickups', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const store = guanyiStore(db);
    const storeId = store ? store.id : -1;
    const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='guanyi_pickup_log'`).get();
    if (!has) return res.json({ success: true, mode: 'off', flagged: [], recent: [], summary: {} });

    const flagged = db.prepare(`
      SELECT pl.id, pl.product_id, pl.guanyi_name, pl.observed_qty, pl.baseline_qty,
             pl.drift, pl.inferred_pickup, pl.tianhe_qty, pl.created_at,
             p.name_cn, p.name_en, p.sku AS product_sku,
             COALESCE(ss.physical_qty, 0) AS current_qty
        FROM guanyi_pickup_log pl
        LEFT JOIN store_products p ON p.id = pl.product_id
        LEFT JOIN retail_store_stock ss ON ss.product_id = pl.product_id AND ss.store_id = ?
       WHERE pl.action = 'capped' AND COALESCE(pl.resolved, 0) = 0
       ORDER BY pl.created_at DESC LIMIT 100
    `).all(storeId);

    const recent = db.prepare(`
      SELECT pl.id, pl.product_id, pl.guanyi_name, pl.inferred_pickup,
             pl.baseline_qty, pl.observed_qty, pl.created_at,
             p.name_cn, p.name_en
        FROM guanyi_pickup_log pl
        LEFT JOIN store_products p ON p.id = pl.product_id
       WHERE pl.action = 'decremented'
       ORDER BY pl.created_at DESC LIMIT 25
    `).all();

    // The daemon stamps every row with the mode it ran in; the latest row is the
    // truest signal of whether it's live/shadow (process env here may be stale).
    const last = db.prepare(`SELECT mode FROM guanyi_pickup_log ORDER BY id DESC LIMIT 1`).get();
    const today = db.prepare(`
      SELECT COALESCE(SUM(inferred_pickup),0) units, COUNT(*) events
        FROM guanyi_pickup_log
       WHERE action='decremented' AND created_at >= datetime('now','-24 hours')`).get();

    res.json({
      success: true,
      mode: (last && last.mode) || process.env.GUANYI_PICKUP_MODE || 'off',
      flagged, recent,
      summary: { flaggedCount: flagged.length, appliedUnits24h: today.units, appliedEvents24h: today.events },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/guanyi/pickups/:id/apply ─────────────────────────
// Operator confirms a flagged drop WAS a real pickup → decrement our Tianhe
// stock by the inferred amount (through the canonical inventory path, so it's
// ledgered + fanned out to the other channels).
router.post('/api/retail-admin/guanyi/pickups/:id/apply', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare(`SELECT * FROM guanyi_pickup_log WHERE id = ? AND action='capped'`).get(id);
    if (!row) return res.status(404).json({ success: false, error: 'flagged pickup not found' });
    if (row.resolved) return res.json({ success: true, already: true });
    const store = guanyiStore(db);
    if (!store) return res.status(400).json({ success: false, error: 'no active store' });

    const cur = db.prepare('SELECT COALESCE(physical_qty,0) AS q FROM retail_store_stock WHERE store_id=? AND product_id=?').get(store.id, row.product_id);
    const curQty = cur ? cur.q : 0;
    const newQty = Math.max(0, curQty - (row.inferred_pickup || 0));
    const { adjustStock } = require('../lib/inventory');
    adjustStock({
      storeId: store.id, productId: row.product_id, newPhysicalQty: newQty,
      actorLabel: 'guanyi-pickup-manual', reason: 'guanyi_pickup',
      note: `operator-applied flagged gzgrocery pickup #${id}: −${row.inferred_pickup} (${row.baseline_qty}→${row.observed_qty})`,
    });
    db.prepare(`UPDATE guanyi_pickup_log SET resolved=1, resolution='applied', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    res.json({ success: true, newQty });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/guanyi/pickups/:id/ignore ────────────────────────
// Operator judges a flagged drop a glitch (not a real sale) → leave our stock
// alone and re-assert our true Tianhe qty onto Guanyi (correct the bad number).
router.post('/api/retail-admin/guanyi/pickups/:id/ignore', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare(`SELECT * FROM guanyi_pickup_log WHERE id = ? AND action='capped'`).get(id);
    if (!row) return res.status(404).json({ success: false, error: 'flagged pickup not found' });
    if (row.resolved) return res.json({ success: true, already: true });
    const store = guanyiStore(db);
    db.prepare(`UPDATE guanyi_pickup_log SET resolved=1, resolution='ignored', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    // Re-push our true stock so a glitched-low Guanyi number gets corrected back up.
    try { require('../lib/guanyi-sync').enqueueProductStock(db, store.id, row.product_id); } catch (e) {}
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/guanyi/analytics ──────────────────────────────────
// gzgrocery order analytics derived from the pickup ledger. A "billable" unit =
// an applied pickup (auto 'decremented', or a flagged 'capped' the operator
// Applied); a return ('drift_up') nets OUT. Money: owed = units × sell_price ×
// (1 − discount_pct); retail value = units × sell_price.
//   query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&period=day|week|month
router.get('/api/retail-admin/guanyi/analytics', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='guanyi_pickup_log'`).get())
      return res.json({ success: true, summary: {}, timeSeries: [], products: [], unpriced: [] });

    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const fromClause = from || "date('now','-90 days')";
    const toClause   = to   || "date('now','+1 day')";
    const bucket = period === 'month' ? "strftime('%Y-%m', pl.created_at)"
                 : period === 'week'  ? "strftime('%Y-W%W', pl.created_at)"
                 : "date(pl.created_at)";

    const rows = db.prepare(`
      SELECT ${bucket} AS bucket, pl.product_id,
             SUM(CASE WHEN pl.action='decremented' OR (pl.action='capped' AND pl.resolution='applied') THEN pl.inferred_pickup
                      WHEN pl.action='drift_up' THEN -ABS(COALESCE(pl.drift,0)) ELSE 0 END) AS units,
             sp.name_cn, sp.name_en, sp.sku, COALESCE(sp.sell_price,0) AS price,
             pp.discount_pct AS disc, pp.excel_retail AS xretail, pp.excel_gz_price AS xgz
        FROM guanyi_pickup_log pl
        LEFT JOIN store_products sp ON sp.id = pl.product_id
        LEFT JOIN guanyi_product_pricing pp ON pp.product_id = pl.product_id
       WHERE (pl.action IN ('decremented','drift_up') OR (pl.action='capped' AND pl.resolution='applied'))
         AND pl.created_at >= ${from ? '?' : fromClause} AND pl.created_at < ${to ? '?' : toClause}
       GROUP BY bucket, pl.product_id
    `).all(...[from, to].filter(Boolean));

    const tsMap = new Map();      // bucket -> {units,owed,retail}
    const prodMap = new Map();    // product_id -> {...}
    const unpriced = new Map();
    let tUnits = 0, tOwed = 0, tRetail = 0;
    for (const r of rows) {
      const units = r.units || 0;
      if (!units) continue;
      const disc = r.disc == null ? null : r.disc;
      // Bill what gzgrocery actually pays = the sheet's price. Fall back to our
      // sell_price (full retail, no discount) only for products the sheet omits.
      const unitRetail = r.xretail != null ? r.xretail : (r.price || 0);
      const unitOwed   = r.xgz != null ? r.xgz : unitRetail;
      const retail = units * unitRetail;
      const owed = units * unitOwed;
      tUnits += units; tOwed += owed; tRetail += retail;

      const t = tsMap.get(r.bucket) || { bucket: r.bucket, units: 0, owed: 0, retail: 0 };
      t.units += units; t.owed += owed; t.retail += retail; tsMap.set(r.bucket, t);

      const p = prodMap.get(r.product_id) || {
        product_id: r.product_id, sku: r.sku, name: [r.name_cn, r.name_en].filter(Boolean).join(' '),
        units: 0, owed: 0, retail: 0, price: r.price, discount: disc,
      };
      p.units += units; p.owed += owed; p.retail += retail; prodMap.set(r.product_id, p);
      if (disc == null && units > 0) unpriced.set(r.product_id, p.name);
    }

    const products = [...prodMap.values()].sort((a, b) => b.owed - a.owed);
    const timeSeries = [...tsMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    res.json({
      success: true,
      period,
      range: { from: from || null, to: to || null },
      summary: {
        units: tUnits, owed: tOwed, retail: tRetail,
        avgDiscount: tRetail > 0 ? (1 - tOwed / tRetail) : 0,
        products: products.length,
      },
      timeSeries, products,
      unpriced: [...unpriced.entries()].map(([id, name]) => ({ product_id: id, name })),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
