// Markets — physical stall locations. CRUD by admins; read-only list
// available to anyone authenticated (the POS / Sales analytics need it).
//
// Each POS user is pinned to one market via users.market_id; the POS
// checkout endpoint reads that and tags the transaction so analytics can
// roll up performance per stall.
const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requireAdmin, logActivity } = require('../middleware/auth');
const router = express.Router();

// GET — full list, including inactive (the admin UI shows everyone).
// Authed users (incl. vendors) see only active rows for picker dropdowns.
router.get('/api/markets', requireAuth, (req, res) => {
  const where = [];
  const params = [];
  if (req.user.role !== 'admin') where.push('COALESCE(is_active,1) = 1');
  if (req.query.kind) {
    where.push('COALESCE(kind, \'market\') = ?');
    params.push(String(req.query.kind));
  }
  const sql = `SELECT id, name, name_cn, location, lat, lng,
                      COALESCE(daily_target, 0) AS daily_target,
                      COALESCE(kind, 'market') AS kind,
                      is_active, created_at, updated_at
                 FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY kind, name`;
  res.json({ success: true, data: db.prepare(sql).all(...params) });
});

// Create — admin OR any user with `pos` permission. Vendors arriving at
// a new market should be able to add it themselves rather than waiting
// for an admin to provision it. Duplicates by name (case-insensitive)
// are blocked so a typo doesn't fragment analytics.
router.post('/api/markets', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const hasPos  = !!req.permissions?.pos;
  if (!isAdmin && !hasPos) return res.status(403).json({ error: 'forbidden' });
  const { name, name_cn, location, lat, lng, kind, daily_target } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required · 名称必填' });
  const trimmed = name.trim();
  // Whitelist allowed kinds. Default 'market' so existing callers
  // don't need to know about the new field.
  const KINDS = new Set(['market', 'retail', 'kitchen', 'warehouse']);
  const cleanKind = KINDS.has(kind) ? kind : 'market';
  // Validate lat/lng — accept null/undefined freely, but if provided
  // must be sane numbers. Out-of-range values are silently dropped
  // rather than rejected so an iffy GPS reading doesn't block the save.
  const cleanLat = (lat != null && isFinite(lat) && lat >= -90  && lat <= 90)  ? +lat : null;
  const cleanLng = (lng != null && isFinite(lng) && lng >= -180 && lng <= 180) ? +lng : null;
  const cleanTarget = (daily_target != null && isFinite(daily_target) && daily_target >= 0) ? +daily_target : 0;
  // Case-insensitive duplicate check — also matches a soft-deleted market
  // so we can reactivate it instead of inserting a parallel row.
  const dup = db.prepare('SELECT id, is_active FROM markets WHERE LOWER(name) = LOWER(?) LIMIT 1').get(trimmed);
  if (dup) {
    if (!dup.is_active) {
      db.prepare('UPDATE markets SET is_active=1, name_cn=COALESCE(NULLIF(?,\'\'),name_cn), location=COALESCE(NULLIF(?,\'\'),location), lat=COALESCE(?,lat), lng=COALESCE(?,lng), daily_target=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run((name_cn||'').trim(), (location||'').trim(), cleanLat, cleanLng, cleanTarget, dup.id);
      logActivity(req.user.id, req.user.username, 'reactivate', 'market', dup.id, { name }, req.ip);
      return res.json({ success: true, id: dup.id, reactivated: true });
    }
    return res.status(400).json({ error: 'A market with this name already exists · 已存在同名市场', existing_id: dup.id });
  }
  try {
    const r = db.prepare(`INSERT INTO markets (name, name_cn, location, lat, lng, kind, daily_target) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(trimmed, (name_cn||'').trim() || null, (location||'').trim() || null, cleanLat, cleanLng, cleanKind, cleanTarget);
    logActivity(req.user.id, req.user.username, 'create', 'market', r.lastInsertRowid, { name, kind: cleanKind, lat: cleanLat, lng: cleanLng, daily_target: cleanTarget }, req.ip);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Self-service market switch for the POS. Lets a vendor change which
// market they're tagging sales with — including to a market they just
// created. Only updates the *caller's* user row; admins use the
// /api/admin/users/:id/market endpoint to assign others.
router.put('/api/pos/my-market', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const hasPos  = !!req.permissions?.pos;
  if (!isAdmin && !hasPos) return res.status(403).json({ error: 'forbidden' });
  const marketId = req.body?.market_id ? parseInt(req.body.market_id, 10) : null;
  if (marketId) {
    const m = db.prepare('SELECT id FROM markets WHERE id = ? AND is_active = 1').get(marketId);
    if (!m) return res.status(400).json({ error: 'market not found · 市场不存在' });
  }
  db.prepare('UPDATE users SET market_id = ? WHERE id = ?').run(marketId || null, req.user.id);
  logActivity(req.user.id, req.user.username, 'self_assign_market', 'user', req.user.id, { market_id: marketId }, req.ip);
  res.json({ success: true, market_id: marketId });
});

// Edit — admin OR pos. Vendors who created a market on the spot should
// be able to fix typos / rename it without bothering an admin.
router.put('/api/markets/:id', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const hasPos  = !!req.permissions?.pos;
  if (!isAdmin && !hasPos) return res.status(403).json({ error: 'forbidden' });
  const { name, name_cn, location, lat, lng, is_active, daily_target, kind } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required · 名称必填' });
  // Block renaming to the same name as another active market.
  const dup = db.prepare('SELECT id FROM markets WHERE LOWER(name) = LOWER(?) AND id != ? AND is_active = 1 LIMIT 1').get(name.trim(), id);
  if (dup) return res.status(400).json({ error: 'Another active market already uses this name · 名称冲突' });
  const cleanLat = (lat != null && isFinite(lat) && lat >= -90  && lat <= 90)  ? +lat : null;
  const cleanLng = (lng != null && isFinite(lng) && lng >= -180 && lng <= 180) ? +lng : null;
  const cleanTarget = (daily_target != null && isFinite(daily_target) && daily_target >= 0) ? +daily_target : 0;
  const KINDS = new Set(['market','retail','kitchen','warehouse']);
  const existingKind = db.prepare('SELECT COALESCE(kind, \'market\') AS kind FROM markets WHERE id = ?').get(id)?.kind || 'market';
  const cleanKind = KINDS.has(kind) ? kind : existingKind;
  db.prepare(`UPDATE markets SET name=?, name_cn=?, location=?,
              lat=COALESCE(?,lat), lng=COALESCE(?,lng),
              daily_target=?, kind=?,
              is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name.trim(), (name_cn||'').trim() || null, (location||'').trim() || null,
         cleanLat, cleanLng,
         cleanTarget, cleanKind,
         is_active == null ? 1 : (is_active ? 1 : 0), id);
  logActivity(req.user.id, req.user.username, 'update', 'market', id, { name }, req.ip);
  res.json({ success: true });
});

// Soft-delete — admin OR pos. Existing sales tagged with this market
// keep their [markets:txn:N:M] tag (historic data unchanged); the
// market just stops appearing in pickers. Admin can reactivate by
// re-creating with the same name (which calls our reactivate path).
router.delete('/api/markets/:id', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const hasPos  = !!req.permissions?.pos;
  if (!isAdmin && !hasPos) return res.status(403).json({ error: 'forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  // Also clear it from any user who currently has it assigned, so they
  // get prompted to re-pick on next interaction (rather than silently
  // tagging future sales to a deactivated market).
  const tx = db.transaction(() => {
    db.prepare(`UPDATE markets SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    db.prepare('UPDATE users SET market_id = NULL WHERE market_id = ?').run(id);
  });
  tx();
  logActivity(req.user.id, req.user.username, 'delete', 'market', id, null, req.ip);
  res.json({ success: true });
});

// ── Per-market stock (retail inventory) ───────────────────────────
// GET /api/markets/:id/stock — list every active product with its
// current qty at this market. Products with zero stock are included
// so the admin can spot what HASN'T been replenished (filter on the
// client if they only want non-zero). Auto-incremented when a restock
// order is delivered (see routes/restock.js _applyDeliveryToStock).
router.get('/api/markets/:id/stock', requireAuth, requireAdmin, (req, res) => {
  const marketId = parseInt(req.params.id, 10);
  if (!marketId) return res.status(400).json({ error: 'invalid id' });
  const m = db.prepare('SELECT id, name, name_cn, kind FROM markets WHERE id = ?').get(marketId);
  if (!m) return res.status(404).json({ error: 'market not found' });
  // LEFT JOIN so every active product appears, even if no row exists
  // in market_stock yet. COALESCE the qty to 0 for those.
  const rows = db.prepare(`
    SELECT p.id              AS product_id,
           p.name_en         AS name_en,
           p.name_cn         AS name_cn,
           p.sku             AS sku,
           p.category        AS category,
           COALESCE(ms.qty, 0)        AS qty,
           ms.updated_at     AS updated_at
      FROM products p
      LEFT JOIN market_stock ms
        ON ms.product_id = p.id AND ms.market_id = ?
     WHERE COALESCE(p.is_active, 1) = 1
     ORDER BY p.name_cn, p.name_en
  `).all(marketId);
  res.json({ success: true, market: m, data: rows });
});

// POST /api/markets/:id/stock/adjust — manual correction.
// Body: { product_id, delta }  → adds delta (can be negative)
//   or  { product_id, set_qty } → sets the absolute qty (delta = set - current)
// Reason + notes are recorded in market_stock_ledger for audit.
router.post('/api/markets/:id/stock/adjust', requireAuth, requireAdmin, (req, res) => {
  const marketId = parseInt(req.params.id, 10);
  if (!marketId) return res.status(400).json({ error: 'invalid id' });
  const m = db.prepare('SELECT id FROM markets WHERE id = ?').get(marketId);
  if (!m) return res.status(404).json({ error: 'market not found' });
  const productId = parseInt(req.body?.product_id, 10);
  if (!productId) return res.status(400).json({ error: 'product_id required' });
  const reason = String(req.body?.reason || 'manual_adjust');
  const notes  = req.body?.notes ? String(req.body.notes) : null;
  const current = db.prepare('SELECT qty FROM market_stock WHERE market_id = ? AND product_id = ?').get(marketId, productId);
  const currentQty = current ? Number(current.qty) : 0;
  let delta;
  if (req.body?.set_qty != null) {
    const setQty = Number(req.body.set_qty);
    if (!Number.isFinite(setQty)) return res.status(400).json({ error: 'set_qty must be a number' });
    delta = setQty - currentQty;
  } else if (req.body?.delta != null) {
    delta = Number(req.body.delta);
    if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta must be a number' });
  } else {
    return res.status(400).json({ error: 'set_qty or delta required' });
  }
  if (delta === 0) return res.json({ success: true, qty: currentQty, delta: 0 });
  const newQty = currentQty + delta;
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO market_stock (market_id, product_id, qty, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(market_id, product_id) DO UPDATE SET
           qty = excluded.qty,
           updated_at = CURRENT_TIMESTAMP
    `).run(marketId, productId, newQty);
    db.prepare(`
      INSERT INTO market_stock_ledger
        (market_id, product_id, delta, reason, ref_table, ref_id, user_id, notes)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(marketId, productId, delta, reason, req.user.id, notes);
  });
  tx();
  logActivity(req.user.id, req.user.username, 'stock_adjust', 'market_stock', marketId,
    { product_id: productId, delta, new_qty: newQty, reason, notes }, req.ip);
  res.json({ success: true, qty: newQty, delta });
});

// GET /api/markets/:id/stock/ledger — recent stock movements for this
// market. Lets the admin see how the qty got to where it is.
router.get('/api/markets/:id/stock/ledger', requireAuth, requireAdmin, (req, res) => {
  const marketId = parseInt(req.params.id, 10);
  if (!marketId) return res.status(400).json({ error: 'invalid id' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const rows = db.prepare(`
    SELECT l.*,
           p.name_en AS product_name_en,
           p.name_cn AS product_name_cn,
           u.username AS actor_username
      FROM market_stock_ledger l
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN users    u ON u.id = l.user_id
     WHERE l.market_id = ?
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ?
  `).all(marketId, limit);
  res.json({ success: true, data: rows });
});

// PUT /api/admin/users/:userId/market — assign a market to a user.
// Admin-only. NULL clears the assignment (user is then "no market").
router.put('/api/admin/users/:userId/market', requireAuth, requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const marketId = req.body?.market_id ? parseInt(req.body.market_id, 10) : null;
  if (!userId) return res.status(400).json({ error: 'invalid user id' });
  db.prepare('UPDATE users SET market_id = ? WHERE id = ?').run(marketId || null, userId);
  logActivity(req.user.id, req.user.username, 'assign_market', 'user', userId, { market_id: marketId }, req.ip);
  res.json({ success: true });
});

module.exports = router;
