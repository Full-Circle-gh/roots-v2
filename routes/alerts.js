const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// Each row joins the ingredient name and a comma-separated list of recipe
// names that use the ingredient. The frontend splits affected_recipes on ', '
// for display.
const ALERT_COLS = `
  a.id, a.ingredient_id, a.old_price, a.new_price, a.change_pct,
  a.is_read, a.created_at,
  i.name_en  AS ingredient_name,
  i.name_cn  AS ingredient_name_cn,
  i.sku      AS ingredient_sku,
  (
    SELECT GROUP_CONCAT(DISTINCT r.name_en)
    FROM recipe_ingredients ri
    JOIN recipes r ON r.id = ri.recipe_id
    WHERE ri.ingredient_id = a.ingredient_id
  ) AS affected_recipes
`;

// GET list (optional ?unread=1)
router.get('/api/alerts', requireAuth, requirePermission('alerts'), (req, res) => {
  let q = `SELECT ${ALERT_COLS} FROM price_alerts a
           LEFT JOIN ingredients i ON i.id = a.ingredient_id`;
  const params = [];
  if (req.query.unread === '1') q += ' WHERE a.is_read = 0';
  q += ' ORDER BY a.created_at DESC, a.id DESC LIMIT 200';
  res.json({ success: true, data: db.prepare(q).all(...params) });
});

// GET unread count (cheap call for the sidebar badge). Sums every alert
// category — stored price_alerts (point-in-time events) + dynamic
// operational signals (low stock, expiring lots, stale kitchen orders).
// Without this, the badge sat at 0 even when 100+ products were
// actually out of stock — see /api/alerts/feed below for the data.
router.get('/api/alerts/unread-count', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && !req.permissions?.alerts) return res.json({ success: true, count: 0 });
  const c = computeAlertCounts();
  res.json({ success: true, count: c.total, breakdown: c });
});

// Internal — used by the unread-count endpoint and the feed endpoint
// so they always agree on category counts.
function computeAlertCounts() {
  const priceAlerts = db.prepare("SELECT COUNT(*) AS c FROM price_alerts WHERE is_read = 0").get().c;
  const outOfStock  = db.prepare("SELECT COUNT(*) AS c FROM products WHERE COALESCE(stock_qty,0) = 0 AND status = 'Active' AND COALESCE(is_active,1) = 1").get().c;
  const lowStock    = db.prepare("SELECT COUNT(*) AS c FROM products WHERE COALESCE(stock_qty,0) > 0 AND COALESCE(stock_qty,0) <= 5 AND status = 'Active' AND COALESCE(is_active,1) = 1").get().c;
  const expired = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL AND pli.expiry_date < date('now') AND po.status IN ('Delivered','Confirmed')`).get().c;
  const expiringSoon = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL AND pli.expiry_date >= date('now') AND pli.expiry_date <= date('now','+7 days') AND po.status IN ('Delivered','Confirmed')`).get().c;
  const staleKitchen = db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders
    WHERE source = 'kitchenOrder' AND status = 'Requested' AND created_at < datetime('now','-3 days')`).get().c;
  const total = priceAlerts + outOfStock + lowStock + expired + expiringSoon + staleKitchen;
  return { priceAlerts, outOfStock, lowStock, expired, expiringSoon, staleKitchen, total };
}

// GET combined alerts feed — categorized live data. The Alerts page
// renders sections per category; the sidebar badge counts them all.
router.get('/api/alerts/feed', requireAuth, requirePermission('alerts'), (req, res) => {
  const counts = computeAlertCounts();

  // Stored price_alerts (point-in-time events)
  const price = db.prepare(`SELECT ${ALERT_COLS} FROM price_alerts a
                             LEFT JOIN ingredients i ON i.id = a.ingredient_id
                             ORDER BY a.created_at DESC LIMIT 50`).all();

  // Out-of-stock products (active + stock_qty = 0)
  const outOfStock = db.prepare(`SELECT id, name_en, name_cn, sku, sell_price, stock_qty, category
    FROM products WHERE COALESCE(stock_qty,0) = 0 AND status = 'Active' AND COALESCE(is_active,1) = 1
    ORDER BY name_en LIMIT 200`).all();

  // Low-stock (1..5 units)
  const lowStock = db.prepare(`SELECT id, name_en, name_cn, sku, sell_price, stock_qty, category
    FROM products WHERE COALESCE(stock_qty,0) > 0 AND COALESCE(stock_qty,0) <= 5
      AND status = 'Active' AND COALESCE(is_active,1) = 1
    ORDER BY stock_qty ASC, name_en LIMIT 200`).all();

  // Expired lots
  const expired = db.prepare(`SELECT pli.id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit,
                                     pli.lot_number, pli.expiry_date, po.po_number, po.id AS po_id
    FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL AND pli.expiry_date < date('now')
      AND po.status IN ('Delivered','Confirmed')
    ORDER BY pli.expiry_date DESC LIMIT 100`).all();

  // Expiring within 7 days
  const expiringSoon = db.prepare(`SELECT pli.id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit,
                                          pli.lot_number, pli.expiry_date, po.po_number, po.id AS po_id
    FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL AND pli.expiry_date >= date('now')
      AND pli.expiry_date <= date('now','+7 days')
      AND po.status IN ('Delivered','Confirmed')
    ORDER BY pli.expiry_date ASC LIMIT 100`).all();

  // Stale kitchen orders (>3 days unfulfilled)
  const staleKitchen = db.prepare(`SELECT po.id, po.po_number, po.date, po.status, po.notes, po.created_at,
                                          (SELECT COUNT(*) FROM po_line_items WHERE po_id = po.id) AS line_count,
                                          u.display_name AS created_by_name
    FROM purchase_orders po LEFT JOIN users u ON u.id = po.created_by
    WHERE po.source = 'kitchenOrder' AND po.status = 'Requested'
      AND po.created_at < datetime('now','-3 days')
    ORDER BY po.created_at ASC LIMIT 100`).all();

  res.json({ success: true, data: { counts, price, outOfStock, lowStock, expired, expiringSoon, staleKitchen } });
});

// PUT mark single as read
router.put('/api/alerts/:id/read', requireAuth, requirePermission('alerts'), (req, res) => {
  const r = db.prepare('UPDATE price_alerts SET is_read = 1 WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  res.json({ success: true });
});

// PUT mark all as read
router.put('/api/alerts/read-all', requireAuth, requirePermission('alerts'), (req, res) => {
  const r = db.prepare('UPDATE price_alerts SET is_read = 1 WHERE is_read = 0').run();
  logActivity(req.user.id, req.user.username, 'mark_all_read', 'alerts', null, { count: r.changes }, req.ip);
  res.json({ success: true, count: r.changes });
});

// DELETE single alert (clear)
router.delete('/api/alerts/:id', requireAuth, requireDelete, requirePermission('alerts'), (req, res) => {
  const r = db.prepare('DELETE FROM price_alerts WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  res.json({ success: true });
});

// DELETE all read alerts (housekeeping)
router.delete('/api/alerts', requireAuth, requireDelete, requirePermission('alerts'), (req, res) => {
  const r = db.prepare('DELETE FROM price_alerts WHERE is_read = 1').run();
  logActivity(req.user.id, req.user.username, 'clear_read', 'alerts', null, { count: r.changes }, req.ip);
  res.json({ success: true, count: r.changes });
});

// Per-user in-memory rate limiter for /api/notifications/feed.
// Frontend polls every 30s; we cap each user at 1 call / 10s to absorb
// multi-tab open without hammering the DB.
const _feedHits = new Map();    // userId → last-millis
const FEED_MIN_GAP_MS = 10_000;

// GET notification feed — used by the front-end push poller. Returns recent
// kitchen-submitted POs that haven't been seen yet (caller passes the
// timestamp of the last seen item). Self-submissions are filtered out so a
// kitchen user doesn't get notified about their own request.
// Rate-limited per user; also clamps `since` to no further back than 7 days
// so a stale tab can't request a years-old window.
router.get('/api/notifications/feed', requireAuth, (req, res) => {
  const now = Date.now();
  const last = _feedHits.get(req.user.id) || 0;
  if (now - last < FEED_MIN_GAP_MS) {
    return res.json({ success: true, data: [], server_time: new Date().toISOString(), throttled: true });
  }
  _feedHits.set(req.user.id, now);
  const sevenDaysAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  let since = sevenDaysAgo;
  if (req.query.since && /^\d{4}-\d{2}-\d{2}T?/.test(req.query.since)) {
    // Use whichever is more recent — caller's cursor or the 7-day floor.
    since = req.query.since > sevenDaysAgo ? req.query.since : sevenDaysAgo;
  }
  const rows = db.prepare(`
    SELECT po.id, po.po_number, po.date, po.source, po.notes, po.created_at,
           po.created_by, u.display_name AS created_by_name,
           (SELECT COUNT(*) FROM po_line_items WHERE po_id = po.id) AS item_count
    FROM purchase_orders po
    LEFT JOIN users u ON u.id = po.created_by
    WHERE po.source = 'kitchenOrder'
      AND po.created_at > ?
      AND (po.created_by IS NULL OR po.created_by != ?)
    ORDER BY po.created_at DESC
    LIMIT 20
  `).all(since, req.user.id);
  // Periodic GC so the rate-limit map doesn't grow forever. Cheap enough.
  if (_feedHits.size > 200) {
    const cutoff = now - 60_000;
    for (const [k, v] of _feedHits) if (v < cutoff) _feedHits.delete(k);
  }
  res.json({ success: true, data: rows, server_time: new Date().toISOString() });
});

module.exports = router;
