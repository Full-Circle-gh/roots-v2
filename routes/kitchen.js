const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, logActivity } = require('../middleware/auth');
const router = express.Router();

// GET last-ordered qty per ingredient. Used by the kitchen-order autocomplete
// to pre-fill a sensible default. Walks all PO line items and keeps the qty
// from the most recent kitchenOrder PO; falls back to the most recent
// non-kitchen PO so newly-imported ingredients still get a sane default.
router.get('/api/kitchen/last-qty', requireAuth, requirePermission('kitchen'), (req, res) => {
  const rows = db.prepare(`
    SELECT pli.ingredient_id, pli.qty, pli.unit, po.source, po.created_at, po.date AS po_date,
           i.buy_unit AS item_buy_unit
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    LEFT JOIN ingredients i ON i.id = pli.ingredient_id
    WHERE pli.ingredient_id IS NOT NULL
    ORDER BY po.created_at DESC, pli.id DESC
  `).all();
  const out = {};
  for (const r of rows) {
    if (out[r.ingredient_id]) continue; // first hit wins (most recent)
    // A PO line may now carry no unit at all — the row template stopped
    // guessing kg. Fall back to the item's own buy_unit so a blank is not
    // handed forward to the next order as a blank.
    out[r.ingredient_id] = { qty: r.qty, unit: r.unit || r.item_buy_unit || null, source: r.source || 'manual', last_date: r.po_date || (r.created_at ? r.created_at.slice(0,10) : null) };
  }
  // Prefer kitchenOrder qty when both exist for an ingredient.
  const kitchenOnly = {};
  for (const r of rows) {
    if (r.source === 'kitchenOrder' && !kitchenOnly[r.ingredient_id]) {
      kitchenOnly[r.ingredient_id] = r;
    }
  }
  for (const id of Object.keys(kitchenOnly)) {
    const r = kitchenOnly[id];
    out[id] = { qty: r.qty, unit: r.unit || r.item_buy_unit || null, source: 'kitchenOrder', last_date: r.po_date || (r.created_at ? r.created_at.slice(0,10) : null) };
  }
  res.json({ success: true, data: out });
});

// GET ordering history for one ingredient (most recent N PO line items).
// Used by the kitchen UI's "view more history" link.
router.get('/api/kitchen/history/:ingredient_id', requireAuth, requirePermission('kitchen'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 200);
  const rows = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date AS po_date, po.status, po.source, po.supplier
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.ingredient_id = ?
    ORDER BY po.created_at DESC, pli.id DESC
    LIMIT ?
  `).all(req.params.ingredient_id, limit);
  res.json({ success: true, data: rows });
});

// GET recent kitchen orders from all staff. Used by the kitchen mobile
// app to render a team feed at the top of the Order tab and warn staff
// before they re-order something already in flight. Returns:
//  - orders: [{id, po_number, when, who, status, items:[…]}]  (cards to render)
//  - by_ingredient: { ingredient_id: [{po_id, who, when, qty, unit}, …] }  (lookup for cart warnings)
router.get('/api/kitchen/recent-team-orders', requireAuth, requirePermission('kitchen'), (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10) || 7, 30);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const orders = db.prepare(`
    SELECT po.id, po.po_number, po.date, po.created_at, po.status,
           po.created_by, u.display_name, u.username
      FROM purchase_orders po
      LEFT JOIN users u ON u.id = po.created_by
     WHERE po.source = 'kitchenOrder'
       AND po.created_at >= ?
     ORDER BY po.created_at DESC`).all(sinceIso);
  if (!orders.length) return res.json({ success: true, days, orders: [], by_ingredient: {} });
  const ids = orders.map(o => o.id);
  const placeholders = ids.map(()=>'?').join(',');
  const items = db.prepare(`
    SELECT po_id, ingredient_id, name_en, name_cn, sku, qty, unit
      FROM po_line_items
     WHERE po_id IN (${placeholders})`).all(...ids);
  const itemsByPo = {};
  const byIngredient = {};
  for (const it of items) {
    if (!itemsByPo[it.po_id]) itemsByPo[it.po_id] = [];
    itemsByPo[it.po_id].push(it);
    if (it.ingredient_id) {
      const o = orders.find(x => x.id === it.po_id);
      if (!o) continue;
      if (!byIngredient[it.ingredient_id]) byIngredient[it.ingredient_id] = [];
      byIngredient[it.ingredient_id].push({
        po_id: o.id, po_number: o.po_number, status: o.status,
        when: o.created_at, who: o.display_name || o.username || '?',
        is_self: o.created_by === req.user.id,
        qty: it.qty, unit: it.unit,
      });
    }
  }
  const ordersWithItems = orders.map(o => ({
    ...o,
    is_self: o.created_by === req.user.id,
    items: itemsByPo[o.id] || [],
  }));
  res.json({ success: true, days, orders: ordersWithItems, by_ingredient: byIngredient });
});

// GET slim recipes list — what the kitchen mobile app needs for the
// production-log picker. Returns just id / name / sku / servings, gated
// by the `kitchen` permission so users with kitchen access can pick a
// recipe to log a batch even if they don't have full `recipes` access
// (which would expose cost / supplier / pricing fields).
router.get('/api/kitchen/recipes', requireAuth, requirePermission('kitchen'), (req, res) => {
  const rows = db.prepare(`
    SELECT id, name_en, name_cn, sku, servings, batch_size, is_active
      FROM recipes
     WHERE COALESCE(is_active, 1) = 1
     ORDER BY name_en COLLATE NOCASE`).all();
  res.json({ success: true, data: rows });
});

// POST submit a kitchen order — creates a Purchase Order with source='kitchenOrder'
router.post('/api/kitchen/submit', requireAuth, requirePermission('kitchen'), (req, res) => {
  const { items, notes } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item required · 至少需要一项' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const count = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c;
  const po_number = 'PO-' + String(count + 1).padStart(4, '0');

  // Build a notes string out of per-item notes
  const itemNotes = items
    .filter(i => i.note)
    .map(i => `${i.name_en || i.name_cn || ''}: ${i.note}`)
    .join('; ');
  const fullNotes = [notes, itemNotes && `Kitchen request: ${itemNotes}`].filter(Boolean).join(' · ') || 'Kitchen Order Request';

  // Insert PO + items inside a transaction so a partial cart never lands
  const insertPO    = db.prepare('INSERT INTO purchase_orders (po_number,date,status,warehouse,notes,source,created_by) VALUES (?,?,?,?,?,?,?)');
  const insertItem  = db.prepare(`INSERT INTO po_line_items
    (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const submit = db.transaction(() => {
    const result = insertPO.run(po_number, today, 'Requested', 'Main Warehouse', fullNotes, 'kitchenOrder', req.user.id);
    const poId = result.lastInsertRowid;
    items.forEach((item, i) => {
      const qty = parseFloat(item.qty) || 0;
      const costPerUnit = parseFloat(item.cost_per_unit) || 0;
      const totalCost = qty * costPerUnit;
      insertItem.run(
        poId, item.ingredient_id || null,
        item.name_en || '', item.name_cn || null, item.sku || null,
        qty, item.unit || null, costPerUnit, totalCost,
        item.expense_category || null, i
      );
    });
    return { poId, po_number };
  });

  try {
    const { poId, po_number: poNum } = submit();
    logActivity(req.user.id, req.user.username, 'kitchen_submit', 'purchase_order', poId, { po_number: poNum, item_count: items.length }, req.ip);
    res.json({ success: true, id: poId, po_number: poNum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
