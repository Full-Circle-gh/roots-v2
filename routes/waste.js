const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// Resolve a product's "production cost per unit" by walking
// product → recipe → recipe_ingredients × ingredient.cost_per_unit + cost-sheet.
// Returns sell_price separately so the caller can fall back when the cost
// sheet is incomplete.
function computeProductCost(productId) {
  if (!productId) return { cost_per_unit: null, sell_price: 0, source: null };
  const p = db.prepare('SELECT sell_price, recipe_id, name_en FROM products WHERE id = ?').get(productId);
  if (!p) return { cost_per_unit: null, sell_price: 0, source: null };
  const sellPrice = p.sell_price || 0;
  if (!p.recipe_id) {
    return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
  }
  const recipe = db.prepare('SELECT servings FROM recipes WHERE id = ?').get(p.recipe_id);
  const cd = db.prepare('SELECT labour, packaging, overhead_pct FROM recipe_cost_data WHERE recipe_id = ?').get(p.recipe_id) || {};
  const ings = db.prepare(`
    SELECT ri.qty, ri.unit, i.cost_per_unit
    FROM recipe_ingredients ri
    LEFT JOIN ingredients i ON i.id = ri.ingredient_id
    WHERE ri.recipe_id = ?
  `).all(p.recipe_id);

  let ingTotal = 0;
  for (const ri of ings) {
    if (ri.cost_per_unit && ri.qty) ingTotal += ri.qty * ri.cost_per_unit;
  }
  const labour    = cd.labour       || 0;
  // Packaging is intentionally EXCLUDED from waste cost — packaging is recycled
  // when a finished product is wasted (the box / container is reused on the
  // replacement unit), so accounting it as waste would double-count it. If
  // that policy ever changes, add it back here as `+ (packaging * servings)`.
  const overhead  = cd.overhead_pct || 0;
  const servings  = recipe?.servings || 0;
  const batchCost = ingTotal + labour + (ingTotal * overhead / 100);
  const costPerServ = servings > 0 ? batchCost / servings : null;

  if (costPerServ !== null && costPerServ > 0) {
    return { cost_per_unit: costPerServ, sell_price: sellPrice, source: 'recipe' };
  }
  return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
}

function periodCutoff(period) {
  const today = new Date().toISOString().slice(0, 10);
  if (period === 'today') return { from: today, label: 'today', days: 1 };
  const days = period === '30d' ? 30 : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return { from: cutoff, label: period === '30d' ? '30 days' : '7 days', days };
}

// GET list (optional ?period=today|7d|30d, ?product_id=, ?reason=)
router.get('/api/waste', requireAuth, requirePermission('waste'), (req, res) => {
  const { period, product_id, reason } = req.query;
  let q = 'SELECT * FROM waste_entries WHERE 1=1';
  const params = [];
  if (period) {
    const { from } = periodCutoff(period);
    q += ' AND date >= ?';
    params.push(from);
  }
  if (product_id) { q += ' AND product_id = ?'; params.push(product_id); }
  if (reason)     { q += ' AND reason = ?';     params.push(reason); }
  q += ' ORDER BY date DESC, id DESC';
  res.json({ success: true, data: db.prepare(q).all(...params) });
});

// GET cost preview for the entry form
router.get('/api/waste/preview/:product_id', requireAuth, requirePermission('waste'), (req, res) => {
  res.json({ success: true, data: computeProductCost(req.params.product_id) });
});

// GET summary (KPIs, daily buckets, top items, MoM delta)
router.get('/api/waste/summary', requireAuth, requirePermission('waste'), (req, res) => {
  const period = req.query.period || '7d';
  const { from, days } = periodCutoff(period);
  const today = new Date().toISOString().slice(0, 10);

  const periodRows = db.prepare('SELECT * FROM waste_entries WHERE date >= ?').all(from);
  const todayRows  = db.prepare('SELECT * FROM waste_entries WHERE date = ?').all(today);

  const sumCost = rows => rows.reduce((s, e) => s + (e.cost_lost || 0), 0);
  const sumQty  = rows => rows.reduce((s, e) => s + (e.qty || 0), 0);

  const totalCost = sumCost(periodRows);
  const todayCost = sumCost(todayRows);
  const totalQty  = sumQty(periodRows);
  const avgPerDay = days > 0 ? totalCost / days : 0;

  // Previous period of same length, for MoM badge
  const prevFrom = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);
  const prevRows = db.prepare('SELECT cost_lost FROM waste_entries WHERE date >= ? AND date < ?').all(prevFrom, from);
  const prevCost = sumCost(prevRows);
  const costDeltaPct = prevCost > 0 ? ((totalCost - prevCost) / prevCost * 100) : null;

  // Daily buckets for the trend chart
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    buckets.push({ date: d, cost: 0, qty: 0 });
  }
  const idx = Object.fromEntries(buckets.map((b, i) => [b.date, i]));
  for (const e of periodRows) {
    const i = idx[e.date];
    if (i !== undefined) { buckets[i].cost += e.cost_lost || 0; buckets[i].qty += e.qty || 0; }
  }

  // Top items by cost
  const byItem = {};
  for (const e of periodRows) {
    const key = e.product_name || 'Unknown';
    if (!byItem[key]) byItem[key] = { name: key, sku: e.product_sku || '', cost: 0, qty: 0, count: 0 };
    byItem[key].cost  += e.cost_lost || 0;
    byItem[key].qty   += e.qty || 0;
    byItem[key].count += 1;
  }
  const topItems = Object.values(byItem).sort((a, b) => b.cost - a.cost).slice(0, 8);

  res.json({
    success: true,
    data: {
      period, days, from, today,
      totalCost, todayCost, totalQty, avgPerDay, prevCost, costDeltaPct,
      todayCount: todayRows.length, periodCount: periodRows.length,
      buckets, topItems,
    },
  });
});

// POST create — server snapshots cost_lost and retail_value at write time
router.post('/api/waste', requireAuth, requirePermission('waste'), (req, res) => {
  const { date, product_id, qty, reason, staff_name, shift, notes, unit } = req.body;
  const q = parseFloat(qty);
  if (!date) return res.status(400).json({ error: 'date required · 日期必填' });
  if (!q || q <= 0) return res.status(400).json({ error: 'qty must be positive · 数量必须大于零' });
  if (!product_id) return res.status(400).json({ error: 'product_id required · 产品必填' });

  const prod = db.prepare('SELECT id, name_en, name_cn, sku, sell_price FROM products WHERE id = ?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'product not found · 产品未找到' });

  const cc = computeProductCost(product_id);
  const cost_per_unit = cc.cost_per_unit;
  const sell_price    = cc.sell_price;
  // Track WHICH path produced the cost so future COGS reconciliation can tell
  // recipe-computed costs apart from the sell-price fallback. The cost_source
  // column is added by an idempotent migration.
  const cost_source = cost_per_unit != null
    ? 'recipe'                     // ingredients × cost_per_unit + labour + overhead
    : (sell_price > 0 ? 'sell_price_fallback' : 'none');
  const cost_lost    = (cost_per_unit != null ? cost_per_unit : sell_price) * q;
  const retail_value = sell_price * q;

  try {
    const result = db.prepare(
      `INSERT INTO waste_entries
         (date, product_id, product_name, product_sku, qty, unit, reason,
          cost_lost, retail_value, cost_source, staff_name, shift, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      date, prod.id, prod.name_en, prod.sku || null, q, unit || 'pcs', reason || 'expired',
      cost_lost, retail_value, cost_source, staff_name || null, shift || null, notes || null, req.user.id
    );
    logActivity(req.user.id, req.user.username, 'create', 'waste', result.lastInsertRowid, { product: prod.name_en, qty: q, cost_lost, cost_source }, req.ip);
    const row = db.prepare('SELECT * FROM waste_entries WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, id: result.lastInsertRowid, data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/api/waste/:id', requireAuth, requireDelete, requirePermission('waste'), (req, res) => {
  const r = db.prepare('DELETE FROM waste_entries WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'waste', req.params.id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
