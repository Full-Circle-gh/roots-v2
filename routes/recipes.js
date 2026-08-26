const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const { computeRecipeCost } = require('../lib/recipe-cost');
const { checkCycle } = require('../lib/recipe-graph');
// The nested-recipe recompute (§29 step 3) — fired after a save on a recipe
// that backs a linked material (recipe_ingredients lines, batch_size, or
// recipe_cost_data), since any of those can move that material's
// recipe-derived cost transitively. See lib/recipe-rollup.js.
const { fireRecompute, backsAnyCostedRow } = require('../lib/recipe-rollup');
const { saveRecipeCostData } = require('../lib/recipe-cost-data-write');
const router = express.Router();

// Nested recipes (§29): a line may reference a material that is itself made by
// another recipe, so a save can close a loop — "this recipe needs its own
// output to exist". Nothing else in this codebase has had to refuse that
// before. Checked BEFORE any write, so a rejected save changes nothing.
//
// Each line is checked independently against the stored graph, which is
// sufficient: a loop needs a path back INTO this recipe, and the other new
// lines on the same save are all edges leading OUT of it.
//
// The refusal names the actual chain. "Would create a circular reference" is
// true and useless; an operator needs to know which link to break.
function cycleRefusal(recipeId, lines) {
  const rid = Number(recipeId);
  for (const ing of (lines || [])) {
    if (!ing || !ing.ingredient_id) continue;
    const verdict = checkCycle(db, { recipeId: rid, ingredientId: ing.ingredient_id });
    if (verdict.ok) continue;
    const names = verdict.chain.map(id => {
      const r = db.prepare('SELECT name_en FROM recipes WHERE id = ?').get(id);
      return (r && r.name_en) || `recipe #${id}`;
    });
    const lineName = ing.name_en || `item #${ing.ingredient_id}`;
    // chain[0] is the recipe that makes the material being added; the last
    // entry is this recipe. A single-entry chain is the direct self-reference.
    const how = names.length === 1
      ? `"${lineName}" is made by this very recipe`
      : `"${lineName}" is made by ${names.map(n => `"${n}"`).join(', which needs ')}`;
    return `Can't add "${lineName}" here: ${how}. A recipe can't end up needing its own output. `
         + `· 无法添加“${lineName}”:配方不能依赖自身产出。`;
  }
  return null;
}

// GET all recipes (favorites first, then alphabetical)
router.get('/api/recipes', requireAuth, requirePermission('recipes'), (req, res) => {
  const { search, count_only } = req.query;
  // count_only=1 returns just {count: N} so the dashboard KPI tile doesn't
  // have to download the full recipe list (with method/ingredients JSON) on
  // every page load.
  if (count_only === '1' || count_only === 'true') {
    let cq = 'SELECT COUNT(*) AS n FROM recipes WHERE is_active = 1';
    const cp = [];
    if (search) { cq += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; cp.push(s,s,s); }
    return res.json({ success: true, count: db.prepare(cq).get(...cp).n });
  }
  let query = 'SELECT * FROM recipes WHERE is_active = 1';
  const params = [];
  if (search) { query += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; params.push(s,s,s); }
  query += ' ORDER BY is_favorite DESC, name_en';
  const recipes = db.prepare(query).all(...params);
  res.json({ success: true, data: recipes });
});

// PUT toggle favorite
router.put('/api/recipes/:id/favorite', requireAuth, requirePermission('recipes'), (req, res) => {
  const cur = db.prepare('SELECT is_favorite FROM recipes WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found · 未找到' });
  const next = cur.is_favorite ? 0 : 1;
  db.prepare('UPDATE recipes SET is_favorite = ? WHERE id = ?').run(next, req.params.id);
  res.json({ success: true, is_favorite: next });
});

// GET deleted recipes (the trash). MUST be defined before the
// `/api/recipes/:id` route below — otherwise Express matches "trash"
// as an id and returns 404. Lists soft-deleted rows so the user can
// restore them. Includes a count of linked ingredients + the deletion
// timestamp (proxied by updated_at since the soft-delete bumps that).
router.get('/api/recipes/trash', requireAuth, requirePermission('recipes'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
      FROM recipes r
     WHERE r.is_active = 0
     ORDER BY r.updated_at DESC, r.id DESC
  `).all();
  res.json({ success: true, data: rows });
});

// GET Excel export of the whole recipe cost book. MUST be defined before
// `/api/recipes/:id` for the same reason /trash is — otherwise Express matches
// "export" as an id and returns 404.
//
// READ-ONLY, and deliberately so: `recipe_cost_data` holds only the manual
// inputs, and every cost figure in this workbook is derived at read time by
// lib/recipe-cost.js. Nothing here writes, and nothing here caches a computed
// cost back into the database. Four SELECTs, one workbook, no mutation.
//
// Three sheets:
//   Recipes           one row per ACTIVE recipe, including recipes that have
//                     no cost row and recipes with no ingredient lines
//   Ingredient Lines  one row per recipe_ingredients line on an active recipe
//   Ingredient Prices one row per ingredient, with how many recipes use it
router.get('/api/recipes/export', requireAuth, requirePermission('recipes'), async (req, res) => {
  try {
    // Same order the list route paints, so the workbook matches the screen.
    const recipes = db.prepare(
      'SELECT * FROM recipes WHERE is_active = 1 ORDER BY is_favorite DESC, name_en'
    ).all();

    // All ingredient lines for active recipes in ONE query. Same columns and
    // same LEFT JOIN as GET /api/recipes/:id above, so the export is fed
    // exactly what the Cost Sheet is fed.
    const allLines = db.prepare(`
      SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
             i.free_by_design AS master_free,
             i.name_en AS master_name_en
        FROM recipe_ingredients ri
        LEFT JOIN ingredients i ON ri.ingredient_id = i.id
        JOIN recipes r ON r.id = ri.recipe_id AND r.is_active = 1
       ORDER BY ri.recipe_id, ri.sort_order
    `).all();

    const allCost = db.prepare('SELECT * FROM recipe_cost_data').all();

    const linesByRecipe = new Map();
    for (const l of allLines) {
      if (!linesByRecipe.has(l.recipe_id)) linesByRecipe.set(l.recipe_id, []);
      linesByRecipe.get(l.recipe_id).push(l);
    }
    const costByRecipe = new Map(allCost.map(c => [c.recipe_id, c]));

    // One breakdown per recipe. A recipe with no lines gets an empty array,
    // not a skip — an ingredient-less recipe is exactly the kind of gap this
    // export is meant to surface.
    const breakdowns = recipes.map(recipe => computeRecipeCost({
      recipe,
      ingredients: linesByRecipe.get(recipe.id) || [],
      costData: costByRecipe.get(recipe.id),
    }));

    // Required lazily, inside the handler. exceljs is a heavy dependency that
    // only this one route needs, and if it is ever missing from node_modules
    // the failure lands here as a 500 on the export instead of taking the
    // whole server down at boot.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    // Number formats. Values stay real numbers so Excel can SUM them; these
    // only govern display. MONEY is 2dp, but the two genuinely sub-cent
    // columns — cost per GRAM, and an ingredient's ¥-per-recipe-unit — would
    // round to 0.00 and read as free, so they get a finer format instead.
    const MONEY = '0.00';
    const UNIT_MONEY = '0.000000';
    const PCT = '0.00';          // a plain number: 30 means 30%, as the app stores it
    const QTY = '0.####';

    const styleHeader = (ws) => {
      const h = ws.getRow(1);
      h.font = { bold: true };
      h.alignment = { vertical: 'middle' };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    };

    // ── Sheet 1 — Recipes ──────────────────────────────────────────────────
    const s1 = wb.addWorksheet('Recipes');
    s1.columns = [
      { header: 'SKU',                       key: 'sku',        width: 14 },
      { header: 'English Name',              key: 'nameEn',     width: 30 },
      { header: 'Chinese Name',              key: 'nameCn',     width: 20 },
      { header: 'Category',                  key: 'category',   width: 16 },
      { header: 'Batch Size',                key: 'batch',      width: 11, style: { numFmt: QTY } },
      { header: 'Servings',                  key: 'servings',   width: 10, style: { numFmt: QTY } },
      { header: 'Ingredient Cost',           key: 'ingCost',    width: 15, style: { numFmt: MONEY } },
      { header: 'Labour',                    key: 'labour',     width: 11, style: { numFmt: MONEY } },
      { header: 'Packaging Total',           key: 'packTotal',  width: 15, style: { numFmt: MONEY } },
      { header: 'Overhead %',                key: 'overPct',    width: 11, style: { numFmt: PCT } },
      { header: 'Overhead Amount',           key: 'overAmt',    width: 15, style: { numFmt: MONEY } },
      { header: 'Batch Cost',                key: 'batchCost',  width: 13, style: { numFmt: MONEY } },
      { header: 'Cost per Serving',          key: 'cpServ',     width: 15, style: { numFmt: MONEY } },
      { header: 'Cost per Gram',             key: 'cpGram',     width: 14, style: { numFmt: UNIT_MONEY } },
      { header: 'Sell Price',                key: 'sell',       width: 12, style: { numFmt: MONEY } },
      { header: 'Margin per Serving',        key: 'margin',     width: 17, style: { numFmt: MONEY } },
      { header: 'Food Cost %',               key: 'fcPct',      width: 12, style: { numFmt: PCT } },
      { header: 'Target Food Cost',          key: 'targetFc',   width: 16, style: { numFmt: PCT } },
      { header: 'Suggested Sell Price',      key: 'suggest',    width: 19, style: { numFmt: MONEY } },
      { header: 'Has Cost Row',              key: 'hasCost',    width: 13 },
      { header: 'Ingredient Lines',          key: 'lineCount',  width: 16 },
      { header: 'Zero-Cost Ingredient Lines', key: 'zeroLines', width: 24 },
      { header: 'Cost Data Updated',         key: 'updated',    width: 20 },
    ];
    for (const b of breakdowns) {
      s1.addRow({
        sku: b.sku,
        nameEn: b.name_en,
        nameCn: b.name_cn,
        category: b.category,
        batch: b.batchSize || null,
        servings: b.servings || null,
        ingCost: b.ingredientCost,
        labour: b.labour,
        packTotal: b.packagingTotal,
        overPct: b.overheadPct,
        overAmt: b.overheadAmount,
        batchCost: b.batchCost,
        cpServ: b.costPerServing,
        cpGram: b.costPerGram,
        sell: b.sellPrice,
        margin: b.marginPerServing,
        fcPct: b.foodCostPct,
        targetFc: b.targetFoodCost,
        suggest: b.suggestedSellPrice,
        hasCost: b.hasCostRow ? 'Yes' : 'No',
        lineCount: b.ingredientLines,
        zeroLines: b.zeroCostIngredientLines,
        updated: b.costDataUpdatedAt,
      });
    }
    styleHeader(s1);

    // ── Sheet 2 — Ingredient Lines ─────────────────────────────────────────
    const s2 = wb.addWorksheet('Ingredient Lines');
    s2.columns = [
      { header: 'Recipe SKU',                    key: 'rSku',   width: 14 },
      { header: 'Recipe English Name',           key: 'rName',  width: 30 },
      { header: 'Ingredient Name',               key: 'iName',  width: 30 },
      { header: 'Qty',                           key: 'qty',    width: 10, style: { numFmt: QTY } },
      { header: 'Unit',                          key: 'unit',   width: 8 },
      { header: 'Cost per Unit',                 key: 'cpu',    width: 14, style: { numFmt: UNIT_MONEY } },
      { header: 'Line Cost',                     key: 'line',   width: 12, style: { numFmt: MONEY } },
      { header: '% of Recipe Ingredient Cost',   key: 'pct',    width: 26, style: { numFmt: PCT } },
    ];
    for (const b of breakdowns) {
      for (const l of b.lines) {
        s2.addRow({
          rSku: b.sku,
          rName: b.name_en,
          iName: l.name,
          qty: l.qty,
          unit: l.unit,
          cpu: l.costPerUnit,
          line: l.lineCost,
          // Null rather than 0 when the recipe has no ingredient cost at all —
          // a share of nothing is undefined, not zero.
          pct: (l.lineCost !== null && b.ingredientCost > 0)
            ? l.lineCost / b.ingredientCost * 100
            : null,
        });
      }
    }
    styleHeader(s2);

    // ── Sheet 3 — Ingredient Prices ────────────────────────────────────────
    // Usage counts DISTINCT active recipes, so a line listed twice in one
    // recipe counts once.
    const ingredients = db.prepare(`
      SELECT i.name_en, i.unit, i.cost_per_unit, i.updated_at,
             (SELECT COUNT(DISTINCT ri.recipe_id)
                FROM recipe_ingredients ri
                JOIN recipes r ON r.id = ri.recipe_id AND r.is_active = 1
               WHERE ri.ingredient_id = i.id) AS used_in
        FROM ingredients i
       ORDER BY i.name_en
    `).all();

    const s3 = wb.addWorksheet('Ingredient Prices');
    s3.columns = [
      { header: 'Ingredient Name', key: 'name',    width: 32 },
      { header: 'Stocking Unit',   key: 'unit',    width: 14 },
      { header: 'Cost per Unit',   key: 'cpu',     width: 14, style: { numFmt: UNIT_MONEY } },
      { header: 'Used in N Recipes', key: 'used',  width: 18 },
      { header: 'Last Updated',    key: 'updated', width: 20 },
    ];
    for (const i of ingredients) {
      s3.addRow({
        name: i.name_en || '',
        unit: i.unit || '',
        cpu: i.cost_per_unit == null ? 0 : i.cost_per_unit,
        used: i.used_in,
        updated: i.updated_at || null,
      });
    }
    styleHeader(s3);

    const buf = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="recipe-costs-${stamp}.xlsx"`);
    res.setHeader('Content-Length', buf.byteLength);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single recipe with ingredients and steps
router.get('/api/recipes/:id', requireAuth, requirePermission('recipes'), (req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!recipe) return res.status(404).json({ error: 'Not found · 未找到' });
  const ingredients = db.prepare('SELECT ri.*, i.cost_per_unit as master_cost, i.unit as master_unit, i.free_by_design as master_free FROM recipe_ingredients ri LEFT JOIN ingredients i ON ri.ingredient_id = i.id WHERE ri.recipe_id = ? ORDER BY ri.sort_order').all(recipe.id);
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number').all(recipe.id);
  const costData = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(recipe.id);
  res.json({ success: true, data: { ...recipe, ingredients, steps, costData } });
});

// POST create recipe
router.post('/api/recipes', requireAuth, requirePermission('recipes'), (req, res) => {
  const { name_en, name_cn, sku, category, batch_size, servings, serving_size, shelf_life, storage, notes, image_data, ingredients, steps } = req.body;
  if (!name_en) return res.status(400).json({ error: 'name_en required · 英文名称必填' });
  try {
    const result = db.prepare('INSERT INTO recipes (name_en,name_cn,sku,category,batch_size,servings,serving_size,shelf_life,storage,notes,image_data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(name_en, name_cn||null, sku||null, category||null, batch_size||null, servings||null, serving_size||null, shelf_life||null, storage||null, notes||null, image_data||null);
    const recipeId = result.lastInsertRowid;
    if (ingredients?.length) {
      const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)');
      ingredients.forEach((ing, i) => insertIng.run(recipeId, ing.ingredient_id||null, ing.name_en||'', ing.name_cn||null, ing.sku||null, ing.qty||0, ing.unit||'g', ing.notes||null, ing.substitutes||null, i));
    }
    if (steps?.length) {
      const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(recipeId, i+1, s.name||null, s.instructions||null));
    }
    logActivity(req.user.id, req.user.username, 'create', 'recipe', recipeId, { name_en }, req.ip);
    res.json({ success: true, id: recipeId });
  } catch(e) {
    if (e.message.includes('UNIQUE') && /sku/i.test(e.message)) {
      const owner = sku ? db.prepare('SELECT id, name_en, is_active FROM recipes WHERE sku = ?').get(sku) : null;
      if (owner && !owner.is_active) {
        return res.status(400).json({ error: `SKU "${sku}" belongs to a deleted recipe ("${owner.name_en}"). Pick a different SKU, or restore the deleted recipe first.` });
      }
      if (owner) {
        return res.status(400).json({ error: `SKU "${sku}" is already used by recipe "${owner.name_en}".` });
      }
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT update recipe
router.put('/api/recipes/:id', requireAuth, requirePermission('recipes'), (req, res) => {
  const { name_en, name_cn, sku, category, batch_size, servings, serving_size, shelf_life, storage, notes, image_data, ingredients, steps } = req.body;
  if (ingredients) {
    const refusal = cycleRefusal(req.params.id, ingredients);
    if (refusal) return res.status(400).json({ error: refusal });
  }
  try {
    db.prepare('UPDATE recipes SET name_en=?,name_cn=?,sku=?,category=?,batch_size=?,servings=?,serving_size=?,shelf_life=?,storage=?,notes=?,image_data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(name_en, name_cn||null, sku||null, category||null, batch_size||null, servings||null, serving_size||null, shelf_life||null, storage||null, notes||null, image_data||null, req.params.id);
    if (ingredients) {
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(req.params.id);
      const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)');
      ingredients.forEach((ing, i) => insertIng.run(req.params.id, ing.ingredient_id||null, ing.name_en||'', ing.name_cn||null, ing.sku||null, ing.qty||0, ing.unit||'g', ing.notes||null, ing.substitutes||null, i));
    }
    if (steps) {
      db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(req.params.id);
      const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(req.params.id, i+1, s.name||null, s.instructions||null));
    }
    // Recompute trigger (§29 step 3): batch_size (always saved by this
    // handler) and the ingredient lines just written above both feed a
    // linked material's recipe cost, so this fires on every successful save
    // of a recipe that backs one — regardless of which fields were sent.
    if (backsAnyCostedRow(db, req.params.id)) {
      fireRecompute(db, { source: 'recipes.update', recipe_id: Number(req.params.id) });
    }
    logActivity(req.user.id, req.user.username, 'update', 'recipe', req.params.id, { name_en }, req.ip);
    res.json({ success: true });
  } catch(e) {
    if (e.message.includes('UNIQUE') && /sku/i.test(e.message)) {
      const owner = sku ? db.prepare('SELECT id, name_en, is_active FROM recipes WHERE sku = ? AND id != ?').get(sku, req.params.id) : null;
      if (owner) {
        const tag = owner.is_active ? '' : ' (deleted)';
        return res.status(400).json({ error: `SKU "${sku}" is already used by recipe "${owner.name_en}"${tag}.` });
      }
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT update cost data
router.put('/api/recipes/:id/cost', requireAuth, requirePermission('recipes'), (req, res) => {
  // The Cost Sheet DOES send `packaging_type_id` (public/app.html:8062 — the
  // picked type, or a literal null when nothing is selected), so this route's
  // behaviour is unchanged: a picked type is written, a cleared picker still
  // clears. It shares the write with Tacet's cost route so the absent-key rule
  // is one rule rather than two copies — see lib/recipe-cost-data-write.js.
  saveRecipeCostData(db, req.params.id, req.body);
  // Recompute trigger (§29 step 3): labour/packaging/overhead feed a linked
  // material's recipe cost exactly like an ingredient line does.
  if (backsAnyCostedRow(db, req.params.id)) {
    fireRecompute(db, { source: 'recipes.cost_update', recipe_id: Number(req.params.id) });
  }
  res.json({ success: true });
});

// DELETE recipe (soft)
router.delete('/api/recipes/:id', requireAuth, requireDelete, requirePermission('recipes'), (req, res) => {
  db.prepare('UPDATE recipes SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'recipe', req.params.id, null, req.ip);
  res.json({ success: true });
});

// PUT restore a deleted recipe. Flips is_active back to 1; ingredients,
// steps, and cost data weren't touched on delete (soft delete only
// hides the recipe), so restore is a single column update.
router.put('/api/recipes/:id/restore', requireAuth, requirePermission('recipes'), (req, res) => {
  const r = db.prepare('SELECT id, name_en, is_active FROM recipes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found · 食谱未找到' });
  if (r.is_active) return res.json({ success: true, already_active: true });
  db.prepare('UPDATE recipes SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'restore', 'recipe', req.params.id, { name: r.name_en }, req.ip);
  res.json({ success: true });
});

// DELETE permanent — hard-delete a soft-deleted recipe along with its
// children (ingredients, steps, cost data). Admin only because once it's
// gone, it's gone. Refuses to hard-delete an active recipe (use the
// soft-delete endpoint first).
router.delete('/api/recipes/:id/permanent', requireAuth, requireDelete, requirePermission('recipes'), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only · 仅管理员可永久删除' });
  const r = db.prepare('SELECT id, name_en, is_active FROM recipes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found · 食谱未找到' });
  if (r.is_active) return res.status(400).json({ error: 'Soft-delete first · 请先软删除' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(req.params.id);
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(req.params.id);
    db.prepare('DELETE FROM recipe_cost_data WHERE recipe_id = ?').run(req.params.id);
    db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
  });
  tx();
  logActivity(req.user.id, req.user.username, 'permanent_delete', 'recipe', req.params.id, { name: r.name_en }, req.ip);
  res.json({ success: true });
});

// POST duplicate — clones a recipe (sans SKU since SKUs are UNIQUE) plus all
// ingredients, steps, and cost data. Optional `scale` body param applies
// a multiplier to batch_size, servings, serving_size, and every ingredient
// qty — used by the "Save as New Recipe" button on the Batch Scaler bar.
// Returns the new recipe id so the UI can jump straight into the copy.
router.post('/api/recipes/:id/duplicate', requireAuth, requirePermission('recipes'), (req, res) => {
  const src = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Recipe not found' });
  const ings  = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order').all(src.id);
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number').all(src.id);
  const cost  = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(src.id);

  const scale = parseFloat(req.body?.scale);
  const isScaled = scale && scale > 0 && Math.abs(scale - 1) > 0.001;
  const round1 = v => v == null ? v : Math.round(v * 10) / 10;

  // Servings is a COUNT OF SELLABLE PORTIONS, so it rounds DOWN, never to
  // nearest. Rounding up invents a portion that cannot be sold, and since cost
  // per serving is batch cost / servings, an overstated serving count
  // understates cost per serving and overstates margin.
  //
  // floor() alone is not enough. 45 * 1.4 is 62.99999999999999 in binary
  // floating point, which floors to 62 and loses a whole serving — the very
  // error this is meant to prevent. Snapping the product to 6 decimal places
  // first restores the intended integer before the floor sees it.
  const floorServings = (n, k) => Math.floor(Number((n * k).toFixed(6)));

  // A scale that leaves under one serving is REFUSED, not clamped to 1 and not
  // stored as 0. Clamping would claim a portion that does not exist, and a
  // stored 0 is indistinguishable from "no servings recorded" downstream:
  // lib/recipe-cost.js guards on `servings > 0`, so cost per serving, margin
  // and suggested sell price would all silently read as unrecorded rather than
  // wrong. Refusing while the operator is still at the scaler is the visible
  // failure the recorded rules ask for.
  if (isScaled && src.servings && floorServings(src.servings, scale) < 1) {
    // Smallest k with servings * k >= 1, rounded UP so the figure quoted
    // actually clears the floor (1/3 = 0.333 still floors to 0; 0.334 does not).
    const minScale = Math.ceil((1 / src.servings) * 1000) / 1000;
    const n = v => String(Number(v.toFixed(3)));
    // At 1 serving the smallest working scale is 1 — i.e. no scale-down exists,
    // so quoting "at least 1" would read as an instruction when it is a dead
    // end. Say that plainly instead of naming a minimum the scaler rejects.
    const advice = minScale >= 1
      ? 'A 1-serving recipe cannot be scaled down at all — scale up instead.'
      : `Scale by at least ${n(minScale)} to keep one serving, or scale up instead.`;
    return res.status(400).json({
      error: `Scaling by ${n(scale)} would leave less than one serving — this recipe makes ${src.servings} serving${src.servings === 1 ? '' : 's'}, and ${src.servings} x ${n(scale)} is under 1. ${advice}`,
    });
  }

  // Name: " (copy)" for plain duplicates; "(<scaledBatch>g)" for scaled — the
  // batch size makes the variant immediately recognisable in the recipe list.
  let nameEn, nameCn;
  if (isScaled) {
    const scaledBatchG = src.batch_size ? Math.round(src.batch_size * scale) : null;
    const tag = scaledBatchG ? `(${scaledBatchG}g)` : `(×${scale})`;
    nameEn = (src.name_en || 'Recipe') + ' ' + tag;
    nameCn = src.name_cn ? src.name_cn + '（' + tag + '）' : null;
  } else {
    nameEn = (src.name_en || '') + ' (copy)';
    nameCn = src.name_cn ? src.name_cn + '（副本）' : null;
  }

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO recipes
      (name_en, name_cn, sku, category, batch_size, servings, serving_size, shelf_life, storage, notes, image_data, recipe_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      nameEn, nameCn,
      null, // SKU is UNIQUE — let user assign a new one
      src.category,
      isScaled && src.batch_size   ? Math.round(src.batch_size * scale)   : src.batch_size,
      isScaled && src.servings     ? floorServings(src.servings, scale)   : src.servings,
      // Per-serving size doesn't change when you scale the batch — same portions, just more of them.
      // (v1 scaled it too, but that's a bug. Leaving it unchanged here.)
      src.serving_size,
      src.shelf_life, src.storage, src.notes, src.image_data,
      // A copy of a repack is a repack. Carried over rather than left to the
      // column default, which would silently refile it as made.
      src.recipe_type || 'made'
    );
    const newId = r.lastInsertRowid;
    const insIng = db.prepare(`INSERT INTO recipe_ingredients
      (recipe_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, substitutes, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ings.forEach(i => insIng.run(
      newId, i.ingredient_id, i.name_en, i.name_cn, i.sku,
      isScaled ? round1((parseFloat(i.qty) || 0) * scale) : i.qty,
      i.unit, i.notes, i.substitutes, i.sort_order
    ));
    const insStep = db.prepare(`INSERT INTO recipe_steps (recipe_id, step_number, name, instructions) VALUES (?,?,?,?)`);
    steps.forEach(s => insStep.run(newId, s.step_number, s.name, s.instructions));
    if (cost) {
      // Labour scales with batch (more time to prep more); packaging is per
      // serving so it scales with servings count (which we already scaled).
      // Overhead %, sell_price (per unit), target FC are intrinsic — copy as-is.
      db.prepare(`INSERT INTO recipe_cost_data
        (recipe_id, labour, packaging, packaging_type_id, overhead_pct, sell_price, target_food_cost)
        VALUES (?,?,?,?,?,?,?)`).run(
        newId,
        isScaled && cost.labour ? round1(cost.labour * scale) : cost.labour,
        cost.packaging, cost.packaging_type_id,
        cost.overhead_pct, cost.sell_price, cost.target_food_cost
      );
    }
    return newId;
  });
  const newId = tx();
  logActivity(req.user.id, req.user.username, isScaled ? 'duplicate_scaled' : 'duplicate', 'recipe', newId, { from: src.id, name: src.name_en, scale: isScaled ? scale : null }, req.ip);
  res.json({ success: true, id: newId, scaled: isScaled });
});

// POST bulk import — accepts an array of recipe objects, each with nested
// ingredients[] and steps[]. Wrapped in a transaction so a partial import
// never lands. Skips recipes whose SKU already exists.
router.post('/api/recipes/bulk', requireAuth, requirePermission('recipes'), (req, res) => {
  const { recipes } = req.body;
  if (!Array.isArray(recipes) || !recipes.length) return res.status(400).json({ error: 'recipes array required' });

  const insertRecipe = db.prepare(`INSERT INTO recipes
    (name_en, name_cn, sku, category, batch_size, servings, serving_size, shelf_life, storage, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertIng = db.prepare(`INSERT INTO recipe_ingredients
    (recipe_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, substitutes, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertStep = db.prepare(`INSERT INTO recipe_steps
    (recipe_id, step_number, name, instructions) VALUES (?,?,?,?)`);
  const findIngBySku   = db.prepare('SELECT id FROM ingredients WHERE sku = ? LIMIT 1');
  const findIngByName  = db.prepare('SELECT id FROM ingredients WHERE name_en = ? LIMIT 1');
  const findRecipeSku  = db.prepare('SELECT id FROM recipes WHERE sku = ? LIMIT 1');

  const stats = { imported: 0, skipped: 0, errors: [] };

  const importMany = db.transaction(() => {
    recipes.forEach((rec, idx) => {
      try {
        if (!rec.name_en) { stats.skipped++; stats.errors.push(`Row ${idx+1}: missing name_en`); return; }
        if (rec.sku && findRecipeSku.get(rec.sku)) { stats.skipped++; stats.errors.push(`Row ${idx+1}: SKU ${rec.sku} already exists`); return; }
        const r = insertRecipe.run(
          rec.name_en, rec.name_cn || null, rec.sku || null, rec.category || null,
          parseFloat(rec.batch_size) || null, parseFloat(rec.servings) || null,
          parseFloat(rec.serving_size) || null, rec.shelf_life || null,
          rec.storage || null, rec.notes || null
        );
        const recipeId = r.lastInsertRowid;
        (rec.ingredients || []).forEach((ing, i) => {
          // Try to link to an existing ingredient by SKU or name (case-insensitive name match)
          let ingId = null;
          if (ing.sku)     ingId = findIngBySku.get(ing.sku)?.id || null;
          if (!ingId && ing.name_en) ingId = findIngByName.get(ing.name_en)?.id || null;
          insertIng.run(recipeId, ingId, ing.name_en || '', ing.name_cn || null,
            ing.sku || null, parseFloat(ing.qty) || 0, ing.unit || 'g', ing.notes || null, ing.substitutes || null, i);
        });
        (rec.steps || []).forEach((s, i) => {
          insertStep.run(recipeId, i+1, s.name || null, s.instructions || null);
        });
        stats.imported++;
      } catch (e) {
        stats.skipped++;
        stats.errors.push(`Row ${idx+1}: ${e.message}`);
      }
    });
  });
  importMany();
  logActivity(req.user.id, req.user.username, 'bulk_import', 'recipe', null, { imported: stats.imported, skipped: stats.skipped }, req.ip);
  res.json({ success: true, ...stats });
});

module.exports = router;
