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
             p.variant_label, p.variant_group_id, p.sku, p.updated_at,
             CASE WHEN (p.image_data IS NOT NULL AND p.image_data != '')
                    OR (p.image_url  IS NOT NULL AND p.image_url  != '')
                  THEN 1 ELSE 0 END AS has_image
        FROM store_products p
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY p.name_cn, p.variant_group_id, p.id
    `).all();

    // multiSize = the mapped listing holds more than one 规格. Read from the
    // specs the listing job captures, so the page can offer a "Multi-size"
    // filter and, later, say which size a product is. 15 of 265 listings at
    // 天河 are multi-size; those are the ones where stock can go wrong.
    const maps = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code,
             m.meituan_name, m.sync_enabled,
             m.last_pushed_qty, m.last_pushed_at,
             (SELECT COUNT(*) FROM meituan_listing_specs ls
               WHERE ls.store_code = m.store_code AND ls.listing_name = m.meituan_name) AS specCount
        FROM meituan_product_map m
    `).all();

    const mapIndex = {};
    for (const m of maps) {
      if (!mapIndex[m.product_id]) mapIndex[m.product_id] = {};
      mapIndex[m.product_id][m.store_code] = m;
    }

    res.json({
      success: true,
      // image = small lazy thumbnail URL, never the blob (list-image footgun);
      // the public /image route serves store_products images on demand.
      data: products.map(p => ({
        ...p,
        has_image: undefined,
        image: p.has_image
          ? `/api/retail/products/${p.id}/image?v=${encodeURIComponent(p.updated_at || '')}&w=96`
          : null,
        stores: mapIndex[p.id] || {},
      })),
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

// ── Channel switch ─────────────────────────────────────────────────────────
// Mirrors the Eleme switch (storefront_config 'eleme.enabled'), which the Eleme
// daemon, lib/eleme-sync and the inventory fan-out all honour. Meituan had no
// switch at all: the only way to stop the channel was to kill the daemon.
//
// ⚠️ DEFAULTS TO ON when the key is absent. Meituan is live for every tenant
// that has it set up today, so an absent key must not read as "off" and
// silently stop a working channel the first time this ships.
function meituanEnabled(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'meituan.enabled'").get();
    return row ? JSON.parse(row.value_json) !== false : true;
  } catch (e) { return true; }
}

router.get('/api/retail-admin/meituan/config', requireRetailAdmin, (req, res) => {
  try { res.json({ success: true, enabled: meituanEnabled(tdb()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/api/retail-admin/meituan/enable', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  try {
    const enabled = !!(req.body && req.body.enabled);
    db.prepare(`
      INSERT INTO storefront_config (key, value_json, updated_at)
      VALUES ('meituan.enabled', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(enabled));
    res.json({ success: true, enabled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Per-store health, derived from what the daemons actually recorded.
//
// The page used to report one "Sync · Active" for the whole channel, and that
// word only ever meant "this HTTP call succeeded" — it never looked at a daemon
// or a login. On 2026-08-23 越秀 had been signed out for 24 days behind a
// verification challenge while the page showed green.
//
// Truth lives in meituan_sync_log. A store is BLOCKED when its most recent
// health event is a blocking one and no stock has pushed successfully since.
// That last clause matters: 天河 logs a queue_stalled now and then and recovers
// on its own, and a store that is visibly still pushing is not blocked.
// ⚠️ Only rows the daemon wrote with status='error' count. poll_paused is
// logged with status 'ok' and means "outside opening hours" — a closed store,
// not a broken one. Treating the event type alone as blocking turned 天河 amber
// the moment it shut for the night. Any future informational event is now
// harmless here for the same reason.
const MT_BLOCKING = ['needs_login', 'verify_required', 'queue_stalled', 'proxy_stale'];
const MT_CLEARING = ['verify_cleared', 'queue_resumed', 'poll_resumed', 'proxy_elected'];

function meituanStoreHealth(db) {
  const stores = db.prepare(`
    SELECT id, code, COALESCE(name_cn, name_en, code) AS name
      FROM retail_stores ORDER BY sort_order, id
  `).all();

  // Latest genuine failure, and latest thing that would clear one.
  const lastFault = db.prepare(`
    SELECT event_type, status, error_msg, created_at
      FROM meituan_sync_log
     WHERE store_code = ? AND status = 'error'
       AND event_type IN (${MT_BLOCKING.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1
  `);
  const lastClear = db.prepare(`
    SELECT MAX(created_at) AS t FROM meituan_sync_log
     WHERE store_code = ? AND event_type IN (${MT_CLEARING.map(() => '?').join(',')})
  `);
  // Shop hours. poll_paused/poll_resumed are a normal nightly pair; a closed
  // store is reported plainly, never as a fault.
  const lastPause  = db.prepare("SELECT MAX(created_at) AS t FROM meituan_sync_log WHERE store_code = ? AND event_type = 'poll_paused'");
  const lastResume = db.prepare("SELECT MAX(created_at) AS t FROM meituan_sync_log WHERE store_code = ? AND event_type = 'poll_resumed'");
  const lastOkPush = db.prepare(`
    SELECT MAX(created_at) AS t FROM meituan_sync_log
     WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok'
  `);
  const queueRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'error' AND processed_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS failed
      FROM meituan_sync_queue WHERE store_code = ?
  `);
  const lastOrder = db.prepare(
    'SELECT MAX(imported_at) AS t FROM meituan_order_import WHERE store_code = ?');
  const ordersToday = db.prepare(
    "SELECT COUNT(*) AS n FROM meituan_order_import WHERE store_code = ? AND date(imported_at) = date('now')");
  // 营业/休息 as Meituan itself reports it, written by the daemon's status read.
  // This was only ever visible in the Configure panel; the page it describes
  // never showed it. read_ok guards against reporting a stale/failed read as
  // "closed", which would be a worse lie than saying nothing.
  const bizStatus = db.prepare(
    'SELECT is_open, read_ok FROM store_business_status WHERE store_code = ?');
  const liveCount = db.prepare(`
    SELECT COUNT(*) AS n FROM meituan_product_map m
      JOIN store_products p ON p.id = m.product_id
     WHERE m.store_code = ? AND m.meituan_name IS NOT NULL AND m.sync_enabled = 1 AND p.is_active = 1
  `);
  const activeProducts = db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE is_active = 1').get()?.n || 0;

  return stores.map(st => {
    const ev  = lastFault.get(st.code, ...MT_BLOCKING) || null;
    const ok  = lastOkPush.get(st.code)?.t || null;
    const cleared = lastClear.get(st.code, ...MT_CLEARING)?.t || null;
    const blockedEvent = ev;
    // Recovered on its own if anything good happened after the fault: a
    // successful push, or an explicit clearing event.
    const recovered = !!(blockedEvent && (
      (ok      && String(ok)      > String(blockedEvent.created_at)) ||
      (cleared && String(cleared) > String(blockedEvent.created_at))));
    const pausedAt  = lastPause.get(st.code)?.t || null;
    const resumedAt = lastResume.get(st.code)?.t || null;
    const closed = !!(pausedAt && (!resumedAt || String(pausedAt) > String(resumedAt)));
    const q = queueRow.get(st.code) || {};
    const live = liveCount.get(st.code)?.n || 0;
    return {
      id: st.id,
      code: st.code,
      name: st.name,
      blocked:    !!blockedEvent && !recovered,
      blockedBy:  blockedEvent && !recovered ? blockedEvent.event_type : null,
      blockedAt:  blockedEvent && !recovered ? blockedEvent.created_at : null,
      blockedMsg: blockedEvent && !recovered ? (blockedEvent.error_msg || null) : null,
      closed,
      lastPushAt: ok,
      pending:    Number(q.pending    || 0),
      // Rows the daemon claimed and never finished. Counted nowhere before, so
      // 40 stranded pushes showed up in neither "sending" nor "failed".
      processing: Number(q.processing || 0),
      failed:     Number(q.failed     || 0),
      lastOrderAt: lastOrder.get(st.code)?.t || null,
      ordersToday: ordersToday.get(st.code)?.n || 0,
      openOnMeituan: (() => {
        let b = null;
        try { b = bizStatus.get(st.code); } catch (e) { b = null; }
        return (b && b.read_ok) ? b.is_open === 1 : null;   // null = not read yet
      })(),
      live,
      unmatched: Math.max(0, activeProducts - live),
    };
  });
}

// ── GET /api/retail-admin/meituan/status ─────────────────────────────────
router.get('/api/retail-admin/meituan/status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queuePending = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='pending'").get()?.n || 0;
    // 'error' is the status the daemon actually writes on a terminal push failure.
    // This counted 'failed', which nothing in the system has ever written, so the
    // tile read 0 no matter how badly pushes were going.
    //
    // Scoped to the last day on purpose: the column holds every terminal failure
    // ever recorded (1276 of them on 天河 as of 2026-08-22, the oldest 55 days
    // old), and a tile pinned to a permanent four-figure number is a tile nobody
    // reads. What an operator needs is "is something failing NOW".
    const queueFailed  = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='error' AND processed_at >= datetime('now','-1 day')").get()?.n || 0;
    // How long the oldest waiting push has been waiting. Without this a stuck
    // queue and a busy one are the same number on the screen — which is how a
    // 19-hour stock freeze presented as "107 sending…", the display the UI
    // describes as normal and clearing in seconds.
    const oldestPending = db.prepare("SELECT MIN(created_at) AS t FROM meituan_sync_queue WHERE status='pending'").get()?.t || null;
    const queueOldestMin = oldestPending
      ? Math.max(0, Math.round((Date.now() - (Date.parse(String(oldestPending).replace(' ', 'T') + 'Z') || Date.now())) / 60000))
      : 0;
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

    let stores = [];
    try { stores = meituanStoreHealth(db); } catch (e) { stores = []; }
    res.json({ success: true, enabled: meituanEnabled(db), stores,
               queuePending, queueFailed, queueOldestMin, recentLogs, recentStock, recentSystem, lastOrder, mappedCount });
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

    // 货号 → listing name per store, from the captured specs, so Match names can
    // link by SKU before falling back to name similarity. A 货号 that appears on
    // more than one listing is ambiguous and left out (name matching handles it).
    const skus = {};
    try {
      const specRows = db.prepare(`
        SELECT store_code, sku_code, MIN(listing_name) AS listing_name,
               COUNT(DISTINCT listing_name) AS names
          FROM meituan_listing_specs
         WHERE sku_code IS NOT NULL AND TRIM(sku_code) <> ''
         GROUP BY store_code, sku_code
      `).all();
      for (const r of specRows) {
        if (r.names !== 1) continue;
        (skus[r.store_code] = skus[r.store_code] || {})[r.sku_code.trim()] = r.listing_name;
      }
    } catch (_) { /* specs table may predate this feature on old boxes */ }

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

    res.json({ success: true, listings, skus, jobs, running });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Store open/closed (Meituan 营业/休息) ──────────────────────────────────
// The daemon that owns each store's logged-in session reads the live status into
// store_business_status and applies target_open. The web server can't drive
// Playwright, so this just reads that row and (for the toggle) writes target_open.

// GET current open/closed status for every active store.
router.get('/api/retail-admin/meituan/business-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(
      `SELECT code, COALESCE(name_cn, name_en, code) AS name FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();
    const rows = db.prepare('SELECT * FROM store_business_status').all();
    const byCode = {};
    for (const r of rows) byCode[r.store_code] = r;
    const data = stores.map((s) => {
      const r = byCode[s.code] || {};
      let lastResult = null;
      try { lastResult = r.last_result ? JSON.parse(r.last_result) : null; } catch (_) {}
      return {
        storeCode: s.code, name: s.name,
        isOpen: r.is_open === 1,
        mtStatus: r.mt_status != null ? r.mt_status : null,
        subStatus: r.sub_status != null ? r.sub_status : null,
        statusDesc: r.status_desc || null,
        detailDesc: r.detail_desc || null,
        hoursDesc: r.hours_desc || null,
        readOk: r.read_ok === 1,
        readAt: r.read_at || null,
        pending: r.target_open != null,
        targetOpen: r.target_open === 1 ? true : (r.target_open === 0 ? false : null),
        lastResult,
        updatedAt: r.updated_at || null,
      };
    });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST a target: { storeCode, open }. Queues the flip for the daemon to apply.
router.post('/api/retail-admin/meituan/business-status', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { storeCode, open } = req.body || {};
  if (!storeCode || typeof open !== 'boolean') {
    return res.status(400).json({ success: false, error: 'storeCode and open (boolean) are required' });
  }
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code = ? AND is_active = 1').get(storeCode);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    db.prepare(`
      INSERT INTO store_business_status (store_code, target_open, target_by, target_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(store_code) DO UPDATE SET
        target_open = excluded.target_open, target_by = excluded.target_by,
        target_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `).run(storeCode, open ? 1 : 0, by);
    res.json({ success: true, storeCode, target: open ? 'open' : 'closed',
      note: 'Queued — the sync daemon applies it within ~1 min and refreshes the live status.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Master store status (online storefront + Meituan) ─────────────────────────
// One panel over every sales channel we control: the online storefront (mini-app +
// web, a storefront_config 'store_status' flag enforced at POST /api/retail/orders)
// + each Meituan store (置休 via store_business_status, applied by the sync daemons).
// gzgrocery is a read-only B2B mirror, so it's not a closable channel here.

function readOnlineStatus(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key='store_status'").get();
    const v = row ? JSON.parse(row.value_json) : {};
    return {
      online_open: !(v.online_open === false || v.online_open === 0),
      message_en: v.message_en || '',
      message_cn: v.message_cn || '',
    };
  } catch (e) { return { online_open: true, message_en: '', message_cn: '' }; }
}
function writeOnlineStatus(db, val, by) {
  db.prepare(`
    INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
      VALUES ('store_status', ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
  `).run(JSON.stringify(val), by || 'backend');
}

// GET the whole panel: online storefront + each Meituan store + derived master.
router.get('/api/retail-admin/store-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const online = readOnlineStatus(db);
    const stores = db.prepare(
      `SELECT code, COALESCE(name_cn, name_en, code) AS name FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();
    const rows = db.prepare('SELECT * FROM store_business_status').all();
    const byCode = {};
    for (const r of rows) byCode[r.store_code] = r;
    const meituan = stores.map((s) => {
      const r = byCode[s.code] || {};
      return {
        storeCode: s.code, name: s.name,
        isOpen: r.is_open === 1, readOk: r.read_ok === 1,
        pending: r.target_open != null, statusDesc: r.status_desc || null,
        fulfillmentOpen: r.fulfillment_open !== 0, // whether it still ships online orders
      };
    });
    // Master reflects the union: open only if EVERYTHING is open, closed only if
    // EVERYTHING is closed, else 'mixed'.
    const flags = [online.online_open, ...meituan.map((m) => m.isOpen)];
    const master = flags.every(Boolean) ? 'open' : (flags.every((f) => !f) ? 'closed' : 'mixed');
    res.json({ success: true, online, meituan, master });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Flip just the online storefront (mini-app + web). Optional custom closed message.
router.post('/api/retail-admin/store-status/online', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { open, message_en, message_cn } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    const cur = readOnlineStatus(db);
    const val = {
      online_open: open,
      message_en: message_en != null ? String(message_en).slice(0, 300) : cur.message_en,
      message_cn: message_cn != null ? String(message_cn).slice(0, 300) : cur.message_cn,
    };
    writeOnlineStatus(db, val, by);
    res.json({ success: true, online: val });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Master flip: EVERY sales channel at once — online storefront + queue every
// Meituan store closed/open (the daemons apply the Meituan side within ~1 min).
router.post('/api/retail-admin/store-status/master', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { open } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    const cur = readOnlineStatus(db);
    const val = { online_open: open, message_en: cur.message_en, message_cn: cur.message_cn };
    const stores = db.prepare('SELECT code FROM retail_stores WHERE is_active = 1').all();
    // Master flips the whole store: Meituan POI (target_open, daemon-applied) AND
    // online fulfillment (fulfillment_open, immediate) together.
    const queueMeituan = db.prepare(`
      INSERT INTO store_business_status (store_code, target_open, fulfillment_open, target_by, target_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(store_code) DO UPDATE SET
        target_open = excluded.target_open, fulfillment_open = excluded.fulfillment_open,
        target_by = excluded.target_by, target_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `);
    db.transaction(() => {
      writeOnlineStatus(db, val, by);
      for (const s of stores) queueMeituan.run(s.code, open ? 1 : 0, open ? 1 : 0, by);
    })();
    res.json({ success: true, online: val, meituanQueued: stores.map((s) => s.code), target: open ? 'open' : 'closed' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Close/open a WHOLE store: its Meituan POI (置休, daemon-applied within ~1 min)
// AND its online fulfillment (fulfillment_open, effective immediately — reroutes
// its pickup + deliveries + out-of-city shipping to the other store). This is the
// per-store "the shop isn't operating" switch, distinct from the Meituan-channel-
// only toggle on the Meituan tab.
router.post('/api/retail-admin/store-status/store/:code', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const code = req.params.code;
  const { open } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code = ? AND is_active = 1').get(code);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    db.prepare(`
      INSERT INTO store_business_status (store_code, target_open, fulfillment_open, target_by, target_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(store_code) DO UPDATE SET
        target_open = excluded.target_open, fulfillment_open = excluded.fulfillment_open,
        target_by = excluded.target_by, target_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `).run(code, open ? 1 : 0, open ? 1 : 0, by);
    res.json({
      success: true, storeCode: code, target: open ? 'open' : 'closed',
      note: 'Fulfillment reroute is immediate; the Meituan close applies within ~1 min.',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Channel × location status matrix (Sales grid) ─────────────────────────────
// The sales grid is channel × location. mini_app/web/eleme/gzgrocery live in
// channel_status (absent row = open); meituan uses store_business_status (the
// daemon applies 置休). gzgrocery is tianhe-only. This drives the Sales-page cards:
// per-channel popup (Yuexiu/Tianhe/close-all) + the two location masters.
// 'pos' is the counter till (/till). It joins the grid rather than getting a
// switch of its own because a shop closing its counter is the same KIND of
// act as closing Meituan — and the location master, which closes every
// channel at a store, would otherwise leave the till selling from a shop the
// operator had just marked shut. It needs no special-casing anywhere below:
// it stores in channel_status like mini_app/web/eleme, and serves every
// active store (unlike gzgrocery, which is tianhe-only).
//
// eleme used to be excluded from `integrated` below (OAuth was dead, so there
// was no real channel to open/close) — it's browser automation now
// (lib/eleme-browser.js), stores in channel_status exactly like mini_app/web/
// gzgrocery/pos with no special-casing needed here, and eleme-daemon.js
// already reads this same table via channelClosedStores('eleme') to gate
// stock pushes. Marking it integrated is what the Sales-page card needs to
// unlock its toggle and show the per-location rows.
const GRID_CHANNELS = ['mini_app', 'web', 'meituan', 'eleme', 'gzgrocery', 'pos'];
function csStores(db, channel) {
  const all = db.prepare("SELECT code, name_en, name_cn, COALESCE(name_cn,name_en,code) AS name FROM retail_stores WHERE is_active=1 ORDER BY sort_order,id").all();
  return channel === 'gzgrocery' ? all.filter(s => s.code === 'tianhe') : all;
}
function csCellOpen(db, channel, storeCode) {
  if (channel === 'meituan') {
    // The Meituan cell is the POI's own 营业/停业 state, read back off the merchant
    // site — a shop-wide fulfilment close doesn't change what Meituan reports.
    const r = db.prepare('SELECT is_open FROM store_business_status WHERE store_code=?').get(storeCode);
    return r && r.is_open != null ? r.is_open === 1 : true; // unknown → assume open
  }
  // Shop-wide close (fulfillment_open = 0) beats the per-channel cell: the routing
  // in lib/inventory drops the store from every channel, so the grid says so too
  // rather than showing cells "open" that can no longer receive an order.
  const f = db.prepare('SELECT fulfillment_open FROM store_business_status WHERE store_code=?').get(storeCode);
  if (f && f.fulfillment_open === 0) return false;
  const r = db.prepare('SELECT is_open FROM channel_status WHERE channel=? AND store_code=?').get(channel, storeCode);
  return r ? r.is_open === 1 : true; // absent = open
}
function csSetCell(db, channel, storeCode, open, by) {
  if (channel === 'meituan') {
    db.prepare(`INSERT INTO store_business_status (store_code, target_open, target_by, target_at, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(store_code) DO UPDATE SET target_open=excluded.target_open, target_by=excluded.target_by, target_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`)
      .run(storeCode, open ? 1 : 0, by);
  } else {
    db.prepare(`INSERT INTO channel_status (channel, store_code, is_open, updated_at, updated_by)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(channel, store_code) DO UPDATE SET is_open=excluded.is_open, updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by`)
      .run(channel, storeCode, open ? 1 : 0, by);
  }
}
function csBy(req) { return (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend'; }

// GET the whole matrix: each channel's per-location cells + card state, plus the
// two location masters.
router.get('/api/retail-admin/channel-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare("SELECT code, name_en, name_cn, COALESCE(name_cn,name_en,code) AS name FROM retail_stores WHERE is_active=1 ORDER BY sort_order,id").all();
    const mt = {}; for (const r of db.prepare('SELECT * FROM store_business_status').all()) mt[r.store_code] = r;
    const channels = GRID_CHANNELS.map((ch) => {
      const cells = csStores(db, ch).map((s) => {
        const cell = { storeCode: s.code, name: s.name, nameEn: s.name_en || s.name, nameCn: s.name_cn || s.name, open: csCellOpen(db, ch, s.code) };
        if (ch === 'meituan') { const r = mt[s.code] || {}; cell.readOk = r.read_ok === 1; cell.pending = r.target_open != null; cell.statusDesc = r.status_desc || null; }
        return cell;
      });
      return { channel: ch, integrated: true, single: ch === 'gzgrocery' ? 'tianhe' : null,
               cells, cardOpen: cells.some((c) => c.open) };
    });
    const locations = stores.map((s) => {
      const applies = GRID_CHANNELS.filter((ch) => ch !== 'gzgrocery' || s.code === 'tianhe');
      return { storeCode: s.code, name: s.name, nameEn: s.name_en || s.name, nameCn: s.name_cn || s.name, allOpen: applies.every((ch) => csCellOpen(db, ch, s.code)) };
    });
    res.json({ success: true, stores, channels, locations });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Set one cell (channel × store).
router.post('/api/retail-admin/channel-status/cell', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { channel, storeCode, open } = req.body || {};
  if (!GRID_CHANNELS.includes(channel) || !storeCode || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'channel, storeCode, open (boolean) required' });
  if (channel === 'gzgrocery' && storeCode !== 'tianhe') return res.status(400).json({ success: false, error: 'gzgrocery is tianhe-only' });
  try { csSetCell(db, channel, storeCode, open, csBy(req)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Set every location of one channel (the popup's "close all").
router.post('/api/retail-admin/channel-status/channel', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { channel, open } = req.body || {};
  if (!GRID_CHANNELS.includes(channel) || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'channel, open (boolean) required' });
  try {
    const by = csBy(req); const stores = csStores(db, channel);
    db.transaction(() => { for (const s of stores) csSetCell(db, channel, s.code, open, by); })();
    res.json({ success: true, stores: stores.map((s) => s.code) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Location master: set EVERY channel for one location, plus the shop-wide
// fulfilment switch. "Close this location" means the shop isn't operating, so it
// must also stop being a routing/pickup candidate (fulfillment_open) — leaving
// that at 1 while every channel cell reads closed is the state that let a closed
// shop keep being named as the customer's nearest store at checkout.
router.post('/api/retail-admin/channel-status/location', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { storeCode, open } = req.body || {};
  if (!storeCode || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'storeCode, open (boolean) required' });
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code=? AND is_active=1').get(storeCode);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = csBy(req);
    const applies = GRID_CHANNELS.filter((ch) => ch !== 'gzgrocery' || storeCode === 'tianhe');
    db.transaction(() => {
      for (const ch of applies) csSetCell(db, ch, storeCode, open, by);
      db.prepare(`
        INSERT INTO store_business_status (store_code, fulfillment_open, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(store_code) DO UPDATE SET
          fulfillment_open = excluded.fulfillment_open, updated_at = CURRENT_TIMESTAMP
      `).run(storeCode, open ? 1 : 0);
    })();
    res.json({ success: true, channels: applies });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
