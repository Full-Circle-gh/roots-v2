// Admin endpoints for dual-location retail inventory.
//
// Gated by the existing `retail` permission. Manages:
//   - retail_stores            (CRUD)
//   - retail_store_stock       (read + per-product layer updates + adjust)
//   - retail_stock_reservations (read for visibility)
//   - retail_stock_ledger      (read for audit)

const express = require('express');
// `db` is the shared global handle (always Roots) — use it ONLY for
// control-plane tables (users). Tenant data-plane tables (retail_stores,
// store_products, retail_store_stock, retail_customer_addresses,
// retail_product_substitutes, storefront_config, …) MUST go through the
// request-scoped tdb(); for Roots/kitchen sessions tdb()===db so this is a
// no-op today, and it closes the cross-tenant leak before data isolation is on.
const db = require('../database');
const { tdb } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
const geocode = require('../lib/geocode');
const { requireAuth, logActivity } = require('../middleware/auth');

// Background geocode for a store row. Called after create + update when
// an address-y field changed and the admin didn't supply explicit lat/lng.
// The caller passes its tenant connection (captured synchronously while the
// request's tenant context is still active) because this runs in setImmediate,
// off the request's async chain, where tdb() could no longer resolve it.
function geocodeStoreAsync(storeId, conn) {
  if (!geocode.configured()) return;
  setImmediate(async () => {
    try {
      const s = conn.prepare('SELECT city, district, address FROM retail_stores WHERE id = ?').get(storeId);
      if (!s) return;
      const coords = await geocode.geocodeAddress({
        city: s.city, district: s.district, address: s.address,
      });
      if (!coords) return;
      conn.prepare('UPDATE retail_stores SET lat = ?, lng = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(coords.lat, coords.lng, storeId);
    } catch (e) { console.warn('[geocodeStoreAsync]', e.message); }
  });
}

const router = express.Router();
// Dual-realm gate (Mini App Backend operator OR kitchen user with `retail`),
// shared with the rest of /api/retail-admin/*. Using the kitchen-only guard
// here meant backend operators 401'd on the inventory routes — and that single
// 401 (from the orders store-filter on load) bounced retail-admin.html into a
// /backend/login → /retail-admin redirect loop.
const { requireRetailAdmin } = require('./retail');

// Read-only access to inventory data. A Mini App Backend operator passes the
// same dual-realm gate as everywhere else; a kitchen session is allowed for
// admins, the `retail` permission, OR an assigned `retail_store_id` (store
// staff browsing the cross-store grid in app.html). Edits stay gated below.
function requireInventoryRead(req, res, next) {
  if (req.session?.backendUserId) return requireRetailAdmin(req, res, next);
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.role === 'admin') return next();
    if (req.permissions?.retail) return next();
    const u = db.prepare('SELECT retail_store_id FROM users WHERE id = ?').get(req.user.id);
    if (u?.retail_store_id) return next();
    return res.status(403).json({ error: 'no_inventory_access' });
  });
}

// ─── Stores ─────────────────────────────────────────────────────────────
router.get('/api/retail-admin/stores', requireInventoryRead, (req, res) => {
  const stores = inventory.listStores({ activeOnly: false });
  res.json({ success: true, data: stores });
});

router.post('/api/retail-admin/stores', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.code || typeof b.code !== 'string') return res.status(400).json({ success: false, error: 'code_required' });
  const existing = tdb().prepare('SELECT id FROM retail_stores WHERE code = ?').get(b.code);
  if (existing) return res.status(409).json({ success: false, error: 'code_taken' });

  const info = tdb().prepare(`
    INSERT INTO retail_stores (code, name_en, name_cn, address, city, district, lat, lng, phone,
                               meituan_account_id, is_active, pickup_enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.code.trim(),
    b.name_en || null, b.name_cn || null,
    b.address || null, b.city || null, b.district || null,
    b.lat != null ? Number(b.lat) : null,
    b.lng != null ? Number(b.lng) : null,
    b.phone || null,
    b.meituan_account_id || null,
    b.is_active === false ? 0 : 1,
    b.pickup_enabled ? 1 : 0,
    Number.isFinite(b.sort_order) ? b.sort_order : 0,
  );
  // Background geocode the new store unless the admin provided coords.
  if (b.lat == null || b.lng == null) geocodeStoreAsync(info.lastInsertRowid, tdb());
  logActivity(req.user.id, req.user.username, 'create', 'retail_store', info.lastInsertRowid, b, req.ip);
  res.json({ success: true, data: inventory.getStore(info.lastInsertRowid) });
});

router.patch('/api/retail-admin/stores/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = inventory.getStore(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const allowed = ['name_en','name_cn','address','city','district','lat','lng','phone','meituan_account_id','is_active','pickup_enabled','sort_order'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      sets.push(`${k} = ?`);
      let v = req.body[k];
      if (k === 'is_active' || k === 'pickup_enabled') v = v ? 1 : 0;
      if (k === 'sort_order') v = Number.isFinite(v) ? v : 0;
      vals.push(v);
    }
  }
  if (!sets.length) return res.json({ success: true, data: existing });
  vals.push(id);
  tdb().prepare(`UPDATE retail_stores SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
  // If the address-shaped fields changed AND no explicit lat/lng was sent,
  // re-geocode in the background so coordinates stay in sync.
  const touchedAddr = ['address','city','district'].some(k => k in req.body);
  const explicitLatLng = ('lat' in req.body) || ('lng' in req.body);
  if (touchedAddr && !explicitLatLng) geocodeStoreAsync(id, tdb());
  logActivity(req.user.id, req.user.username, 'update', 'retail_store', id, req.body, req.ip);
  res.json({ success: true, data: inventory.getStore(id) });
});

router.delete('/api/retail-admin/stores/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Soft-delete via is_active=0 so historical orders keep the reference.
  const r = tdb().prepare("UPDATE retail_stores SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'deactivate', 'retail_store', id, {}, req.ip);
  res.json({ success: true });
});

// ─── Per-store stock layers ────────────────────────────────────────────
// GET /api/retail-admin/inventory/grid
// Cross-store grid: one row per active product with a `stocks` array
// containing { store_id, physical_qty, active_reservations, available_wechat,
//              restock_target } for every active store. Drives the single
// "all stores at a glance" view on the Inventory page.
router.get('/api/retail-admin/inventory/grid', requireInventoryRead, (req, res) => {
  const publishedOnly = req.query.published === '1';
  const extraWhere = publishedOnly ? ' AND p.is_published = 1' : '';

  const stores = inventory.listStores({ activeOnly: true });
  const products = tdb().prepare(`
    SELECT id AS product_id, name_en, name_cn, sku, retail_price, weight,
           COALESCE(is_published, 0) AS is_published
      FROM store_products
     WHERE COALESCE(is_active, 1) = 1${extraWhere}
     ORDER BY is_published DESC, name_en COLLATE NOCASE
  `).all();

  const stockByPair = new Map();
  if (stores.length && products.length) {
    const rows = tdb().prepare(`
      SELECT store_id, product_id, physical_qty, restock_target
        FROM retail_store_stock
    `).all();
    for (const r of rows) stockByPair.set(`${r.store_id}:${r.product_id}`, r);
  }

  const out = products.map(p => {
    const stocks = stores.map(s => {
      const row = stockByPair.get(`${s.id}:${p.product_id}`);
      const physical = row?.physical_qty ?? 0;
      const av = inventory.getAvailable(s.id, p.product_id, 'wechat');
      return {
        store_id: s.id,
        physical_qty: physical,
        restock_target: row?.restock_target ?? null,
        active_reservations: av.activeThisChannel || 0,
        available_wechat: av.exists ? av.available : 0,
        stocked: !!row,
      };
    });
    return { ...p, stocks };
  });

  res.json({ success: true, data: { stores, products: out } });
});

// GET /api/retail-admin/stores/:id/stock
// Returns every active product joined with its stock row for the given
// store. Missing rows show physical=0 so the office can fill them in.
// `is_published` is surfaced so the UI can mark mini-app-sellable items.
// Optional ?published=1 narrows to retail-published only.
router.get('/api/retail-admin/stores/:id/stock', requireInventoryRead, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!inventory.getStore(id)) return res.status(404).json({ success: false, error: 'store_not_found' });

  // A kitchen operator may only read their own store's product list, and never
  // the quantities — the Add Stock app needs names/SKUs to search, nothing else.
  const kitchenOp = !!req.backendUser && req.backendUser.role === 'kitchen';
  if (kitchenOp && id !== req.backendUser.retail_store_id) {
    return res.status(403).json({ success: false, error: 'store_not_assigned' });
  }

  const publishedOnly = req.query.published === '1';
  const extraWhere = publishedOnly ? ' AND p.is_published = 1' : '';

  const rows = tdb().prepare(`
    SELECT p.id AS product_id, p.name_en, p.name_cn, p.sku, p.retail_price, p.weight,
           COALESCE(p.is_published, 0) AS is_published,
           COALESCE(p.is_market, 0)    AS is_market,
           COALESCE(p.is_restock_only, 0) AS is_restock_only,
           COALESCE(s.physical_qty, 0)  AS physical_qty,
           COALESCE(s.safety_buffer, 0) AS safety_buffer,
           s.wechat_quota,
           s.meituan_quota,
           s.updated_at
      FROM store_products p
      LEFT JOIN retail_store_stock s ON s.product_id = p.id AND s.store_id = ?
     WHERE COALESCE(p.is_active, 1) = 1${extraWhere}
     ORDER BY p.is_published DESC, p.name_en COLLATE NOCASE
  `).all(id);

  // Kitchen operators get a quantity-free list (id/name/sku only) so the shelf
  // total is never exposed — not in the UI, not over the raw API.
  if (kitchenOp) {
    return res.json({ success: true, data: rows.map(r => ({
      product_id: r.product_id, name_en: r.name_en, name_cn: r.name_cn, sku: r.sku,
    })) });
  }

  // Decorate with computed `available` (wechat channel) so the admin sees
  // the same number the customer would see.
  for (const r of rows) {
    const av = inventory.getAvailable(id, r.product_id, 'wechat');
    r.available_wechat = av.available;
    r.active_reservations = av.activeThisChannel || 0;
  }

  res.json({ success: true, data: rows });
});

// PATCH /api/retail-admin/stores/:storeId/stock/:productId
// Updates any subset of { physical_qty, safety_buffer, wechat_quota, meituan_quota }.
// physical_qty changes go through adjustStock so a ledger row is written.
// Per-store access: admin OR users.retail_store_id === storeId. Other users
// can read the grid but get 403 here.
router.patch('/api/retail-admin/stores/:storeId/stock/:productId', requireInventoryRead, express.json(), (req, res) => {
  const storeId   = parseInt(req.params.storeId, 10);
  const productId = parseInt(req.params.productId, 10);
  if (!inventory.getStore(storeId)) return res.status(404).json({ success: false, error: 'store_not_found' });
  const product = tdb().prepare('SELECT id FROM store_products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ success: false, error: 'product_not_found' });

  // Restricted operators may only touch their assigned store. A 'kitchen'
  // operator may additionally only ADD (a delta) — never set an absolute count;
  // a 'store_stock' clerk recounts their own store (absolute set is allowed).
  const kitchenOp = !!req.backendUser && req.backendUser.role === 'kitchen';
  const restrictedOp = kitchenOp || (!!req.backendUser && req.backendUser.role === 'store_stock');
  if (restrictedOp && storeId !== req.backendUser.retail_store_id) {
    return res.status(403).json({ success: false, error: 'store_not_assigned' });
  }

  // Store-scoped access. A full-access Mini App Backend operator (req.backendUser,
  // non-kitchen) has already passed the tenant gate in requireRetailAdmin and
  // manages all of the tenant's stores, so the assigned-store restriction doesn't
  // apply. For kitchen-app sessions: admin is always allowed; everyone else must
  // be assigned to this specific store.
  if (!req.backendUser && req.user.role !== 'admin') {
    const u = db.prepare('SELECT retail_store_id FROM users WHERE id = ?').get(req.user.id);
    if (!u || u.retail_store_id !== storeId) {
      return res.status(403).json({ success: false, error: 'store_not_assigned' });
    }
  }

  const b = req.body || {};
  if (kitchenOp && !('delta' in b)) {
    return res.status(403).json({ success: false, error: 'kitchen_add_only' });
  }
  const out = {};
  // Two ways to move physical_qty:
  //   physical_qty → set the absolute count (warehouse recount / Quick Stock)
  //   delta        → add/subtract relative to current (kitchen "I made N more")
  // The delta path resolves the target inside adjustStock's transaction, so the
  // kitchen client never reads the current count — it only ever sends "+N".
  if ('delta' in b) {
    const d = parseInt(b.delta, 10) || 0;
    if (d !== 0) {
      out.adjust = inventory.adjustStock({
        storeId, productId, deltaQty: d,
        actorUserId: req.user.id, actorLabel: req.user.display_name || req.user.username || null,
        note: b.note || null, reason: b.reason || 'kitchen_add',
      });
    }
  } else if ('physical_qty' in b) {
    const newQty = parseInt(b.physical_qty, 10) || 0;
    out.adjust = inventory.adjustStock({
      storeId, productId, newPhysicalQty: newQty,
      // actor_user_id is just an audit integer (no FK) — but it can't be
      // resolved by id (kitchen users vs operator tenant_users id spaces
      // collide), so record the display name too. req.user is shimmed for
      // both realms (retail.js requireRetailAdmin).
      actorUserId: req.user.id, actorLabel: req.user.display_name || req.user.username || null,
      note: b.note || null, reason: b.reason || 'adjust',
    });
  }
  const layerFields = {};
  for (const k of ['safety_buffer', 'wechat_quota', 'meituan_quota', 'restock_target']) {
    if (k in b) {
      const v = b[k];
      layerFields[k] = v === null || v === '' ? null : parseInt(v, 10);
    }
  }
  if (Object.keys(layerFields).length) {
    inventory.upsertStockLayer({ storeId, productId, fields: layerFields });
    out.layers = layerFields;
  }
  logActivity(req.user.id, req.user.username, 'stock_update', 'retail_store_stock', null,
              { store_id: storeId, product_id: productId, ...b }, req.ip);

  const row = tdb().prepare(`
    SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota, updated_at
      FROM retail_store_stock WHERE store_id = ? AND product_id = ?
  `).get(storeId, productId);

  // Queue a Meituan stock push whenever physical_qty changes (either an
  // absolute set or a kitchen delta add) and this (store, product) pair is
  // mapped in meituan_product_map.
  if (out.adjust && row) {
    try {
      const map = db.prepare(
        'SELECT store_code FROM meituan_product_map WHERE retail_store_id=? AND product_id=? AND sync_enabled=1'
      ).get(storeId, productId);
      if (map) {
        db.prepare(`
          INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
          VALUES (?, ?, ?, ?, 'pending')
        `).run(storeId, productId, map.store_code, row.physical_qty);
      }
      // Re-push any Meituan-only bundles this product is a component of, so the
      // bundle auto-drops when an ingredient runs out (independent of whether the
      // component itself is individually mapped/sold on Meituan).
      require('../lib/meituan-bundles').enqueueBundlesForProduct(db, storeId, productId);
    } catch (e) { console.error('[meituan-sync-queue] enqueue error:', e.message); }
  }

  res.json({ success: true, data: { ...row, ...out } });
});

// ─── Reservations + ledger (read-only) ──────────────────────────────────
router.get('/api/retail-admin/stores/:id/reservations', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = req.query.status || 'active';
  const rows = tdb().prepare(`
    SELECT r.id, r.product_id, p.name_en, p.name_cn, r.order_id, r.qty, r.channel, r.status,
           r.expires_at, r.created_at, r.committed_at, r.released_at
      FROM retail_stock_reservations r
      LEFT JOIN store_products p ON p.id = r.product_id
     WHERE r.store_id = ? AND r.status = ?
     ORDER BY r.created_at DESC LIMIT 200
  `).all(id, status);
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/stores/:id/ledger', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
  const where = ['store_id = ?'];
  const params = [id];
  if (productId) { where.push('product_id = ?'); params.push(productId); }
  // NOTE: this joins control-plane `users` with tenant data-plane tables. On
  // tdb() it's correct today (Roots: tdb()===db), but once data isolation is on,
  // a non-Roots tenant DB won't contain `users` — this LEFT JOIN must be
  // resolved out-of-band (lookup actor names from the global db) before cut-over.
  const rows = tdb().prepare(`
    SELECT l.id, l.product_id, p.name_en, p.name_cn, l.delta, l.reason, l.ref_table, l.ref_id,
           l.balance_after, l.actor_user_id,
           -- actor name captured at write time (operator OR kitchen user);
           -- fall back to the users join for historical rows with no label.
           COALESCE(l.actor_label, u.username) AS actor, l.channel, l.note, l.created_at
      FROM retail_stock_ledger l
      LEFT JOIN store_products p ON p.id = l.product_id
      LEFT JOIN users u ON u.id = l.actor_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.created_at DESC LIMIT 200
  `).all(...params);
  res.json({ success: true, data: rows });
});

// PUT /api/admin/users/:userId/retail-store — assign / unassign a store.
// Admin-only. NULL clears the assignment (user is then "no store" — can
// view per-store stock but can't edit any).
router.put('/api/admin/users/:userId/retail-store', requireAuth, (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
}, express.json(), (req, res) => {
  const userId  = parseInt(req.params.userId, 10);
  const storeId = req.body?.retail_store_id ? parseInt(req.body.retail_store_id, 10) : null;
  if (!userId) return res.status(400).json({ error: 'invalid_user_id' });
  if (storeId && !inventory.getStore(storeId)) return res.status(400).json({ error: 'store_not_found' });
  db.prepare('UPDATE users SET retail_store_id = ? WHERE id = ?').run(storeId || null, userId);
  logActivity(req.user.id, req.user.username, 'assign_retail_store', 'user', userId, { retail_store_id: storeId }, req.ip);
  res.json({ success: true });
});

// GET /api/retail-admin/inventory/geocode-status
// Lightweight read for the Admin → Integrations panel. Reports whether
// the Tencent Maps key is configured + how many stores / customer
// addresses still need coordinates.
router.get('/api/retail-admin/inventory/geocode-status', requireRetailAdmin, (req, res) => {
  const storeTotal = tdb().prepare('SELECT COUNT(*) AS n FROM retail_stores WHERE is_active = 1').get().n;
  const storeMissing = tdb().prepare('SELECT COUNT(*) AS n FROM retail_stores WHERE is_active = 1 AND (lat IS NULL OR lng IS NULL)').get().n;
  const addrTotal = tdb().prepare('SELECT COUNT(*) AS n FROM retail_customer_addresses').get().n;
  const addrMissing = tdb().prepare('SELECT COUNT(*) AS n FROM retail_customer_addresses WHERE lat IS NULL OR lng IS NULL').get().n;
  const err = geocode.lastError && geocode.lastError();
  res.json({
    success: true,
    data: {
      tencent_maps_configured: geocode.configured(),   // kept for back-compat: true if ANY provider key set
      provider: geocode.provider ? geocode.provider() : null,
      last_error: err ? { code: err.code, message: err.message, provider: err.provider, quota: geocode.isQuotaError(err) } : null,
      stores: { total: storeTotal, missing: storeMissing, geocoded: storeTotal - storeMissing },
      addresses: { total: addrTotal, missing: addrMissing, geocoded: addrTotal - addrMissing },
    },
  });
});

// POST /api/retail-admin/inventory/geocode-backfill
// Admin-only one-shot. Geocodes every store + every customer address that
// doesn't yet have lat/lng. Idempotent — safe to re-run. Useful after
// setting TENCENT_MAPS_KEY for the first time. Returns counts.
router.post('/api/retail-admin/inventory/geocode-backfill', requireRetailAdmin, async (req, res) => {
  if (!geocode.configured()) return res.status(400).json({ success: false, error: 'tencent_maps_key_missing' });

  const stores = tdb().prepare('SELECT id, address, city, district FROM retail_stores WHERE is_active = 1 AND (lat IS NULL OR lng IS NULL)').all();
  const addrs  = tdb().prepare('SELECT id, province, city, district, address, detail FROM retail_customer_addresses WHERE lat IS NULL OR lng IS NULL').all();
  let storesDone = 0, addrsDone = 0;
  let aborted = false;   // set if the provider hits a daily-quota cap mid-run

  for (const s of stores) {
    const c = await geocode.geocodeAddress({ city: s.city, district: s.district, address: s.address });
    if (c) {
      tdb().prepare('UPDATE retail_stores SET lat = ?, lng = ? WHERE id = ?').run(c.lat, c.lng, s.id);
      storesDone++;
    } else if (geocode.isQuotaError(geocode.lastError())) { aborted = true; break; }
  }
  if (!aborted) for (const a of addrs) {
    const c = await geocode.geocodeAddress({
      province: a.province, city: a.city, district: a.district,
      address: [a.address, a.detail].filter(Boolean).join(' '),
    });
    if (c) {
      tdb().prepare('UPDATE retail_customer_addresses SET lat = ?, lng = ?, geocoded_at = CURRENT_TIMESTAMP WHERE id = ?').run(c.lat, c.lng, a.id);
      addrsDone++;
    } else if (geocode.isQuotaError(geocode.lastError())) { aborted = true; break; }
  }
  logActivity(req.user.id, req.user.username, 'geocode_backfill', null, null, { storesDone, addrsDone, aborted }, req.ip);
  const err = geocode.lastError && geocode.lastError();
  res.json({
    success: true,
    data: {
      stores_geocoded: storesDone, stores_total: stores.length,
      addresses_geocoded: addrsDone, addresses_total: addrs.length,
      // When nothing geocoded, tell the UI WHY (quota vs other) instead of a silent 0.
      aborted_on_quota: aborted,
      last_error: err ? { code: err.code, message: err.message, provider: err.provider, quota: geocode.isQuotaError(err) } : null,
    },
  });
});

// Admin: list / set / clear substitutes for a product.
router.get('/api/retail-admin/products/:productId/substitutes', requireRetailAdmin, (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const rows = tdb().prepare(`
    SELECT s.substitute_product_id AS product_id, s.sort_order,
           p.name_en, p.name_cn, p.sku, p.sell_price, p.image_data, p.category
      FROM retail_product_substitutes s
      JOIN store_products p ON p.id = s.substitute_product_id
     WHERE s.product_id = ?
     ORDER BY s.sort_order ASC, p.name_en COLLATE NOCASE
  `).all(productId);
  res.json({ success: true, data: rows });
});

// PUT replaces the whole substitute list for a product.
// Body: { substitute_product_ids: [1, 2, 3] } — in order of preference.
router.put('/api/retail-admin/products/:productId/substitutes', requireRetailAdmin, express.json(), (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const ids = Array.isArray(req.body?.substitute_product_ids) ? req.body.substitute_product_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  // Drop self-references defensively.
  const cleanIds = ids.filter(id => id !== productId);
  const tx = tdb().transaction(() => {
    tdb().prepare('DELETE FROM retail_product_substitutes WHERE product_id = ?').run(productId);
    const ins = tdb().prepare('INSERT OR IGNORE INTO retail_product_substitutes (product_id, substitute_product_id, sort_order) VALUES (?, ?, ?)');
    cleanIds.forEach((sid, i) => ins.run(productId, sid, i));
  });
  tx();
  logActivity(req.user.id, req.user.username, 'update', 'retail_product_substitutes', productId, { ids: cleanIds }, req.ip);
  res.json({ success: true, data: { count: cleanIds.length } });
});

// ─── GZ-express excluded districts config (admin) ──────────────────────
router.get('/api/retail-admin/config/gz-excluded-districts', requireRetailAdmin, (req, res) => {
  const arr = Array.from(inventory.gzExpressExcludedDistricts());
  res.json({ success: true, data: arr });
});

router.put('/api/retail-admin/config/gz-excluded-districts', requireRetailAdmin, express.json(), (req, res) => {
  const list = Array.isArray(req.body?.districts) ? req.body.districts.map(s => String(s).trim()).filter(Boolean) : [];
  tdb().prepare(
    "INSERT INTO storefront_config (key, value_json) VALUES ('routing.gz_express_excluded_districts', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  ).run(JSON.stringify(list));
  logActivity(req.user.id, req.user.username, 'update', 'gz_excluded_districts', null, { districts: list }, req.ip);
  res.json({ success: true, data: list });
});

// ─── Quick Stock (mobile add-on) ───────────────────────────────────────
// "Quick Stock" is the phone-first inventory PWA (served at /stock). It's a
// per-tenant add-on, toggled like every other feature: an operator switch
// persisted to storefront_config under `features.quickStock` (unset = on, to
// match the FEATURE_CATALOG default). When off, the mobile app shows an
// "off" screen and loads no products — the underlying stock APIs stay
// available to the desktop admin grid either way.
function quickStockEnabled() {
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'features.quickStock'").get();
    if (!row) return true;                       // unset → catalog default (on)
    return JSON.parse(row.value_json) !== false; // explicit false → off
  } catch { return true; }
}

// The kitchen "Add Stock" add-on — same on/off pattern as quickStock, its own
// flag so a tenant can run either, both, or neither. Unset = on (catalog
// default). This is the relative-add flow (kitchen logs what they just made),
// as opposed to quickStock's absolute recount.
function kitchenAddEnabled() {
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'features.kitchenAdd'").get();
    if (!row) return true;
    return JSON.parse(row.value_json) !== false;
  } catch { return true; }
}

// GET /api/retail-admin/quick-stock/context
// One-shot bootstrap for the mobile app: who the staffer is, whether the
// add-on is on, and exactly which stores they may edit. Plain store staff
// (users.retail_store_id) get their one store; admins / `retail` operators /
// backend operators get every active store and can switch between them. The
// app then drives the existing per-store GET/PATCH stock endpoints.
router.get('/api/retail-admin/quick-stock/context', requireInventoryRead, (req, res) => {
  // Restricted backend operators are pinned to the single store they're assigned
  // to (req.user.role is shimmed from tenant_users in requireRetailAdmin, so
  // check req.backendUser explicitly). Two restricted roles:
  //   • 'kitchen'     — kitchen staff: relative Add Stock flow (delta-only).
  //   • 'store_stock' — store clerk: absolute recount of their own store.
  const kitchenOp = !!req.backendUser && req.backendUser.role === 'kitchen';
  const restrictedOp = kitchenOp || (!!req.backendUser && req.backendUser.role === 'store_stock');

  // Full-access = any unrestricted backend operator, kitchen-app admin, or the
  // `retail` permission. Those see and edit all stores; a restricted operator or
  // plain staffer is pinned to their own.
  const fullAccess = !restrictedOp && (
    !!req.backendUser
    || req.user?.role === 'admin'
    || !!req.permissions?.retail
  );

  // Mode is role-driven: a kitchen operator (backend) or a kitchen-app staffer
  // gets the relative "Add Stock" flow (log what you made, never see the running
  // total); a store_stock clerk and everyone else get the absolute recount flow.
  // Each mode has its own feature flag.
  const mode = (kitchenOp || (!fullAccess && req.user?.role === 'kitchen')) ? 'add' : 'recount';
  const enabled = mode === 'add' ? kitchenAddEnabled() : quickStockEnabled();

  let stores;
  if (restrictedOp) {
    const sid = req.backendUser.retail_store_id;
    const s = sid ? inventory.getStore(sid) : null;
    stores = s && s.is_active !== 0 ? [s] : [];
  } else if (fullAccess) {
    stores = inventory.listStores({ activeOnly: true });
  } else {
    const u = db.prepare('SELECT retail_store_id FROM users WHERE id = ?').get(req.user.id);
    const assigned = u?.retail_store_id ? inventory.getStore(u.retail_store_id) : null;
    stores = assigned && assigned.is_active !== 0 ? [assigned] : [];
  }

  const slim = stores.map(s => ({
    id: s.id, code: s.code,
    name_en: s.name_en, name_cn: s.name_cn,
  }));

  res.json({
    success: true,
    data: {
      enabled,
      mode,                       // 'add' (kitchen) | 'recount' (warehouse)
      user: {
        name: req.user?.display_name || req.user?.username || null,
        full_access: fullAccess,
      },
      stores: slim,
    },
  });
});

module.exports = router;
