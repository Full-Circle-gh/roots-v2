const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const { computeRecipeCost } = require('../lib/recipe-cost');
const router = express.Router();

// Resolve a product's "production cost per unit" by walking
// product → recipe → recipe_ingredients × ingredient.cost_per_unit + cost-sheet.
//
// The recipe half is lib/recipe-cost.js — the one derivation the recipe card,
// the Cost Sheet and the Excel export all read. This function used to run its
// own queries and its own arithmetic, which is how it came to be the only
// reader that did not honour `free_by_design`: its ingredient SELECT never
// asked for the column. That was invisible while every flagged-free ingredient
// also happened to have cost_per_unit = 0 (measured on production 2026-08-24:
// 3 flagged rows — Drinking Water, Lemon Zest, Lime Zest — all at 0, so 0 rows
// affected), and would have become a real divergence the first time someone
// priced one. Consolidating fixes it as a side effect rather than as a patch.
//
// WHAT IS DELIBERATELY DIFFERENT HERE, AND MUST STAY THAT WAY
// -----------------------------------------------------------
// PACKAGING IS EXCLUDED. Packaging is recycled when a finished product is
// wasted (the box / container is reused on the replacement unit), so
// counting it would double-count. This is why the batch total is assembled
// from the breakdown's granular fields — ingredientCost + labour +
// overheadAmount — instead of taking `batchCost`, which includes packaging.
// No flag was added to the shared module for this: the policy belongs to
// waste, not to the derivation. If the policy ever changes, add
// `+ c.packagingTotal` here.
//
// THE SELL-PRICE FALLBACK IS GONE. It used to price an uncosted loss at what
// the product would have SOLD for — backwards for a line meant to report
// what was spent, and it silently outran a real cost figure the moment a
// recipe went incomplete. A product with no recipe-derived cost now returns
// cost_per_unit: null and the caller (routes/waste.js's own POST handler)
// shows that blank, the same "null means write nothing, never zero, never
// someone else's number" rule lib/ingredient-cost.js already enforces for
// material cost.
function computeProductCost(productId) {
  if (!productId) return { cost_per_unit: null, source: null };
  const p = db.prepare('SELECT recipe_id, name_en FROM products WHERE id = ?').get(productId);
  if (!p || !p.recipe_id) return { cost_per_unit: null, source: null };
  // id-form: the module loads the recipe, its lines (selecting free_by_design)
  // and its cost row through the seamed handle. Returns null if the recipe id
  // points at nothing — a product whose recipe was hard-deleted.
  const c = computeRecipeCost(p.recipe_id, db);
  if (!c) return { cost_per_unit: null, source: null };
  // Packaging-free batch total — see note above.
  const batchCost = c.ingredientCost + c.labour + c.overheadAmount;
  const costPerServ = c.servings > 0 ? batchCost / c.servings : null;

  if (costPerServ !== null && costPerServ > 0) {
    return { cost_per_unit: costPerServ, source: 'recipe' };
  }
  return { cost_per_unit: null, source: null };
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
  const sell_price    = prod.sell_price || 0;
  // Track WHICH path produced the cost so COGS reconciliation can tell a
  // recipe-computed loss apart from one nothing could price. The cost_source
  // column is added by an idempotent migration.
  const cost_source = cost_per_unit != null ? 'recipe' : 'none';
  // No sell-price fallback: a loss the cost sheet can't price is BLANK, not
  // priced at what it would have sold for — same policy as ingredients.js's
  // cost_per_unit (see lib/ingredient-cost.js). retail_value below is a
  // separate figure (what the loss would have sold for) and keeps using
  // sell_price; it is not the cost.
  const cost_lost    = cost_per_unit != null ? cost_per_unit * q : null;
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
