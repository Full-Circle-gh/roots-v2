const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// GET production batches with optional period filter
// ?period=today | 7d | 30d | all (default 30d)
router.get('/api/production', requireAuth, requirePermission('kitchen'), (req, res) => {
  const period = req.query.period || '30d';
  let from = '0000-01-01';
  if (period === 'today') from = new Date().toISOString().slice(0, 10);
  else if (period === '7d')  from = new Date(Date.now() -  7*86400000).toISOString().slice(0,10);
  else if (period === '30d') from = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT pb.*, r.name_en AS recipe_name_current, r.name_cn AS recipe_name_cn,
           r.batch_size AS recipe_batch_size, r.servings AS recipe_servings
    FROM production_batches pb
    LEFT JOIN recipes r ON r.id = pb.recipe_id
    WHERE pb.date >= ?
    ORDER BY pb.date DESC, pb.id DESC
    LIMIT 500
  `).all(from);
  res.json({ success: true, data: rows });
});

// GET summary — KPIs + top recipes for a period
router.get('/api/production/summary', requireAuth, requirePermission('kitchen'), (req, res) => {
  const period = req.query.period || '7d';
  const days = period === 'today' ? 1 : period === '30d' ? 30 : 7;
  const from = new Date(Date.now() - days*86400000).toISOString().slice(0,10);

  const rows = db.prepare(`
    SELECT pb.*, r.batch_size AS recipe_batch_size, r.servings AS recipe_servings
    FROM production_batches pb
    LEFT JOIN recipes r ON r.id = pb.recipe_id
    WHERE pb.date >= ?
  `).all(from);

  let totalBatches = 0, totalServings = 0;
  const byRecipe = {};
  for (const r of rows) {
    const batches = parseFloat(r.batches_made) || 0;
    const servings = parseFloat(r.servings_made) || (batches * (r.recipe_servings || 0)) || 0;
    totalBatches += batches;
    totalServings += servings;
    const key = r.recipe_id || ('name:' + r.recipe_name);
    if (!byRecipe[key]) byRecipe[key] = { recipe_id: r.recipe_id, name: r.recipe_name, batches: 0, servings: 0, count: 0 };
    byRecipe[key].batches += batches;
    byRecipe[key].servings += servings;
    byRecipe[key].count += 1;
  }
  const topRecipes = Object.values(byRecipe).sort((a,b) => b.servings - a.servings).slice(0, 10);
  res.json({ success: true, data: {
    period, days, from, totalBatches, totalServings, count: rows.length, topRecipes,
  }});
});

// POST log a batch
router.post('/api/production', requireAuth, requirePermission('kitchen'), (req, res) => {
  const { date, recipe_id, batches_made, servings_made, staff_name, shift, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const batches = parseFloat(batches_made);
  if (!batches || batches <= 0) return res.status(400).json({ error: 'batches_made must be positive' });

  let recipe_name = null, recipe_sku = null;
  let derivedServings = parseFloat(servings_made) || null;
  if (recipe_id) {
    const r = db.prepare('SELECT name_en, sku, servings FROM recipes WHERE id = ?').get(recipe_id);
    if (!r) return res.status(404).json({ error: 'Recipe not found' });
    recipe_name = r.name_en;
    recipe_sku = r.sku;
    if (!derivedServings && r.servings) derivedServings = batches * r.servings;
  }
  if (!recipe_name) return res.status(400).json({ error: 'recipe_id required' });

  try {
    const result = db.prepare(`INSERT INTO production_batches
      (date, recipe_id, recipe_name, recipe_sku, batches_made, servings_made, staff_name, shift, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      date, recipe_id || null, recipe_name, recipe_sku, batches, derivedServings,
      staff_name || null, shift || null, notes || null, req.user.id
    );
    logActivity(req.user.id, req.user.username, 'log_production', 'recipe', recipe_id, { batches, servings: derivedServings, recipe: recipe_name }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/api/production/:id', requireAuth, requireDelete, requirePermission('kitchen'), (req, res) => {
  const r = db.prepare('DELETE FROM production_batches WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  logActivity(req.user.id, req.user.username, 'delete', 'production_batch', req.params.id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
