// Recipes (食谱) — the retail-admin door onto the same recipes/recipe_ingredients/
// recipe_steps/recipe_cost_data tables the kitchen app writes.
//
// §28/§29 (docs/tacet-consolidation-decisions.md): Recipes generalises the
// kitchen machinery the same way Materials did — one masterlist, two doors.
// requireRetailAdmin (multi-tenant operator gate) instead of requireAuth
// (single-tenant kitchen gate). Same table names, same columns — nothing here
// is a parallel schema.
//
// SCOPE (§29 restated): cost-only. No quantity/stock tracking for recipes, and
// no connection to retail Products or the storefront in this phase.
//
// Wired into the retail-admin Recipes screen (public/retail-admin/19-recipes.js)
// as of step 4. Step 5 adds POST/DELETE .../materialize — the ONLY
// client-reachable path permitted to write ingredients.source_recipe_id.
// routes/retail-materials.js's own save path deliberately refuses to read
// that field from the client (see its readBody()) and stays that way; this
// file is where the exception lives, guarded and narrow.

const express = require('express');
const db = require('../database');
const { requireRetailAdmin } = require('./retail');
const { computeRecipeCost } = require('../lib/recipe-cost');
const { checkCycle } = require('../lib/recipe-graph');
// §29 step 5 — the "make available as material" guards/writes live here, not
// in this route file, so they can be tested directly. See its own header.
const { materializeNew, materializeLink, unlink: unlinkMaterial, linkedMaterialFor } = require('../lib/recipe-materialize');
// The nested-recipe recompute (§29 step 3) — fired after a save that can move
// a linked material's recipe-derived cost. Same triggers routes/recipes.js
// already fires from the kitchen door; a recipe backing a material must stay
// correct no matter which door saved it.
const { fireRecompute, backsLinkedMaterial, costOneRecipe } = require('../lib/recipe-rollup');

const router = express.Router();

// Mirrors routes/recipes.js's cycle guard line for line (routes/recipes.js:28
// cycleRefusal) — kept as its own copy rather than imported, because the two
// doors return errors in different shapes (this one JSON `{success:false}`,
// the kitchen door a bare `{error}`), and threading that difference through a
// shared function would cost more clarity than the duplication does.
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
    const how = names.length === 1
      ? `"${lineName}" is made by this very recipe`
      : `"${lineName}" is made by ${names.map(n => `"${n}"`).join(', which needs ')}`;
    return `Can't add "${lineName}" here: ${how}. A recipe can't end up needing its own output. `
         + `· 无法添加“${lineName}”:配方不能依赖自身产出。`;
  }
  return null;
}

function skuClash(sku, excludeId) {
  if (!sku) return { error: 'sku_taken', message: 'SKU already exists' };
  const owner = excludeId
    ? db.prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE sku = ? AND id != ?').get(sku, excludeId)
    : db.prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE sku = ?').get(sku);
  if (!owner) return { error: 'sku_taken', message: 'SKU already exists' };
  return {
    error: 'sku_taken',
    message: owner.is_active
      ? `SKU "${sku}" is already used by "${owner.name_en}" (#${owner.id}).`
      : `SKU "${sku}" belongs to an archived recipe ("${owner.name_en}", #${owner.id}).`,
    conflict: { id: owner.id, name_en: owner.name_en, name_cn: owner.name_cn, is_active: owner.is_active },
  };
}

// The body fields a recipe carries, listed once so create and update read the
// same set — matches retail-materials.js's readBody() convention.
function readBody(b) {
  return {
    name_en: b.name_en, name_cn: b.name_cn || null, sku: (b.sku || '').trim() || null,
    category: b.category || null,
    batch_size: b.batch_size || null, servings: b.servings || null, serving_size: b.serving_size || null,
    shelf_life: b.shelf_life || null, storage: b.storage || null, notes: b.notes || null,
  };
}

// Whether this recipe's OWN rollup would succeed right now, and why not if
// not — reuses lib/recipe-rollup.js's costOneRecipe (the exact function
// planRollup calls per node) rather than re-deriving the block conditions
// here, so this can never drift from what actually decides a linked
// material's stored cost. An empty overrides Map is correct for a single
// recipe read: overrides only matter when cascading through OTHER linked
// materials this recipe's lines might consume, which is planRollup's job,
// not a per-recipe status read's.
function materialBlockState(recipeId) {
  const r = costOneRecipe(db, recipeId, new Map());
  return { ok: r.ok, reason: r.ok ? null : r.reason, unpriced: r.unpriced || 0 };
}

// ═══ List ══════════════════════════════════════════════════════════════════
router.get('/api/retail-admin/recipes', requireRetailAdmin, (req, res) => {
  const { search, category, archived } = req.query;
  let where = ' WHERE is_active = ?';
  const p = [archived === '1' ? 0 : 1];
  if (search)   { where += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; p.push(s, s, s); }
  if (category) { where += ' AND category = ?'; p.push(category); }

  const recipes = db.prepare(`SELECT * FROM recipes${where} ORDER BY is_favorite DESC, name_en COLLATE NOCASE`).all(...p);

  // Bulk-load lines + cost data in three queries total rather than one round
  // trip per row — same technique the Excel export uses (routes/recipes.js,
  // lib/recipe-cost.js header comment), necessary here too since a list of 85
  // recipes would otherwise be 255 queries just to show a cost column.
  const ids = recipes.map(r => r.id);
  let linesByRecipe = new Map(), costByRecipe = new Map(), materialByRecipe = new Map();
  if (ids.length) {
    const qs = ids.map(() => '?').join(',');
    const allLines = db.prepare(`
      SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
             i.free_by_design AS master_free, i.name_en AS master_name_en
        FROM recipe_ingredients ri
        LEFT JOIN ingredients i ON ri.ingredient_id = i.id
       WHERE ri.recipe_id IN (${qs})
       ORDER BY ri.recipe_id, ri.sort_order
    `).all(...ids);
    for (const l of allLines) {
      if (!linesByRecipe.has(l.recipe_id)) linesByRecipe.set(l.recipe_id, []);
      linesByRecipe.get(l.recipe_id).push(l);
    }
    const allCost = db.prepare(`SELECT * FROM recipe_cost_data WHERE recipe_id IN (${qs})`).all(...ids);
    costByRecipe = new Map(allCost.map(c => [c.recipe_id, c]));
    const allMaterials = db.prepare(`SELECT id, name_en, cost_per_unit, unit, source_recipe_id FROM ingredients WHERE source_recipe_id IN (${qs})`).all(...ids);
    materialByRecipe = new Map(allMaterials.map(m => [m.source_recipe_id, m]));
  }

  const rows = recipes.map(r => {
    const c = computeRecipeCost({ recipe: r, ingredients: linesByRecipe.get(r.id) || [], costData: costByRecipe.get(r.id) });
    const material = materialByRecipe.get(r.id);
    // Blocked state only costs a query for the ~27 recipes that actually back
    // a material — costOneRecipe is cheap but there is no reason to run it
    // for the other ~110 rows on every list paint.
    return {
      id: r.id, name_en: r.name_en, name_cn: r.name_cn, sku: r.sku, category: r.category,
      batch_size: r.batch_size, servings: r.servings, is_active: r.is_active, is_favorite: !!r.is_favorite,
      // batchCost is always computable (it needs neither batch_size nor
      // servings) — the list's cost column falls back to it when neither
      // per-unit figure can be worked out, which real data shows is common
      // (3 of the 4 recipes named in the build gate have both unset).
      batchCost: c.batchCost, costPerServing: c.costPerServing, costPerGram: c.costPerGram,
      zeroCostIngredientLines: c.zeroCostIngredientLines,
      backsMaterial: material ? { id: material.id, name_en: material.name_en, cost_per_unit: material.cost_per_unit, unit: material.unit } : null,
      materialBlock: material ? materialBlockState(r.id) : null,
    };
  });
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/recipes/meta/categories', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT category FROM recipes WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category COLLATE NOCASE"
  ).all();
  res.json({ success: true, data: rows.map(r => r.category) });
});

// ═══ One recipe ════════════════════════════════════════════════════════════
router.get('/api/retail-admin/recipes/:id', requireRetailAdmin, (req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });
  const ingredients = db.prepare(`
    SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
           i.free_by_design AS master_free, i.name_en AS master_name_en, i.item_kind AS master_item_kind
      FROM recipe_ingredients ri
      LEFT JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ? ORDER BY ri.sort_order
  `).all(recipe.id);
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number').all(recipe.id);
  const costData = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(recipe.id);
  const cost = computeRecipeCost({ recipe, ingredients, costData });
  const material = linkedMaterialFor(db, recipe.id);
  res.json({ success: true, data: {
    ...recipe, ingredients, steps, costData, cost,
    backsMaterial: material, materialBlock: material ? materialBlockState(recipe.id) : null,
  } });
});

// ═══ Create ════════════════════════════════════════════════════════════════
router.post('/api/retail-admin/recipes', requireRetailAdmin, (req, res) => {
  const b = readBody(req.body || {});
  if (!b.name_en) return res.status(400).json({ success: false, error: 'name_required' });
  const lines = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];
  try {
    const result = db.prepare(`INSERT INTO recipes
      (name_en,name_cn,sku,category,batch_size,servings,serving_size,shelf_life,storage,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(b.name_en, b.name_cn, b.sku, b.category, b.batch_size, b.servings, b.serving_size, b.shelf_life, b.storage, b.notes);
    const recipeId = result.lastInsertRowid;
    if (lines.length) {
      const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((ing, i) => insertIng.run(recipeId, ing.ingredient_id || null, ing.name_en || '', ing.name_cn || null, ing.sku || null, ing.qty || 0, ing.unit || 'g', ing.notes || null, ing.substitutes || null, i));
    }
    const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
    if (steps.length) {
      const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(recipeId, i + 1, s.name || null, s.instructions || null));
    }
    res.json({ success: true, id: recipeId });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, null) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Update ════════════════════════════════════════════════════════════════
router.put('/api/retail-admin/recipes/:id', requireRetailAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const b = readBody(req.body || {});
  if (!b.name_en) return res.status(400).json({ success: false, error: 'name_required' });
  const lines = req.body.ingredients;
  const steps = req.body.steps;
  if (lines) {
    const refusal = cycleRefusal(req.params.id, lines);
    if (refusal) return res.status(400).json({ success: false, error: 'cycle', message: refusal });
  }
  try {
    db.prepare(`UPDATE recipes SET
      name_en=?,name_cn=?,sku=?,category=?,batch_size=?,servings=?,serving_size=?,shelf_life=?,storage=?,notes=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.name_en, b.name_cn, b.sku, b.category, b.batch_size, b.servings, b.serving_size, b.shelf_life, b.storage, b.notes, req.params.id);
    if (lines) {
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(req.params.id);
      const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((ing, i) => insertIng.run(req.params.id, ing.ingredient_id || null, ing.name_en || '', ing.name_cn || null, ing.sku || null, ing.qty || 0, ing.unit || 'g', ing.notes || null, ing.substitutes || null, i));
    }
    if (steps) {
      db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(req.params.id);
      const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(req.params.id, i + 1, s.name || null, s.instructions || null));
    }
    // Recompute trigger (§29 step 3) — same condition the kitchen door checks
    // (routes/recipes.js PUT /:id): batch_size and the ingredient lines just
    // written both feed a linked material's recipe cost.
    if (backsLinkedMaterial(db, req.params.id)) {
      fireRecompute(db, { source: 'retail-recipes.update', recipe_id: Number(req.params.id) });
    }
    res.json({ success: true });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, req.params.id) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Cost data ═════════════════════════════════════════════════════════════
router.put('/api/retail-admin/recipes/:id/cost', requireRetailAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const { labour, packaging, packaging_type_id, overhead_pct, sell_price, target_food_cost } = req.body || {};
  db.prepare(`INSERT INTO recipe_cost_data (recipe_id,labour,packaging,packaging_type_id,overhead_pct,sell_price,target_food_cost,updated_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(recipe_id) DO UPDATE SET
      labour=?,packaging=?,packaging_type_id=?,overhead_pct=?,sell_price=?,target_food_cost=?,updated_at=CURRENT_TIMESTAMP`)
    .run(req.params.id, labour || 0, packaging || 0, packaging_type_id || null, overhead_pct || 0, sell_price || 0, target_food_cost || 30,
         labour || 0, packaging || 0, packaging_type_id || null, overhead_pct || 0, sell_price || 0, target_food_cost || 30);
  if (backsLinkedMaterial(db, req.params.id)) {
    fireRecompute(db, { source: 'retail-recipes.cost_update', recipe_id: Number(req.params.id) });
  }
  res.json({ success: true });
});

// ═══ Archive / restore ═════════════════════════════════════════════════════
// Combined into one endpoint, matching retail-materials.js's shape — not the
// kitchen door's separate DELETE/restore pair. No hard-delete route here: the
// kitchen door's permanent-delete is a kitchen-only affordance not mirrored
// onto this one, same as Materials never got one either.
router.put('/api/retail-admin/recipes/:id/archive', requireRetailAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const active = req.body && req.body.restore ? 1 : 0;
  db.prepare('UPDATE recipes SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(active, req.params.id);
  res.json({ success: true, is_active: active });
});

// ═══ Materialize (§29 step 5) ═══════════════════════════════════════════════
// "Make available as material" — the one action that turns a recipe's output
// into a reusable ingredient another recipe can consume. This is the ONLY
// client-reachable write of ingredients.source_recipe_id anywhere in the app;
// routes/retail-materials.js's readBody() refuses that field on purpose (see
// its comment), so there is no other door.
//
// Two-cap gate: recipes:edit is already enforced for every route under this
// prefix by lib/cap-routes.js. This action ALSO creates/edits a row in the
// materials masterlist, so it additionally requires materials:edit, checked
// inline here — mirrors routes/retail.js's "also save as a customer" guard
// (orders:edit alone must not mint a customer). Same three conditions
// requireRetailAdmin's own enforcement already uses, so this changes nothing
// while tenant.rbac_enforce is dark and opens no hole the day it is switched on.
function requireMaterialsEditToo(req, res) {
  if (req.tenant && req.tenant.rbac_enforce && req.user && req.user.role !== 'owner'
      && req.caps && !req.caps.has('materials:edit')) {
    res.status(403).json({ success: false, error: 'forbidden_capability', need: 'materials:edit' });
    return false;
  }
  return true;
}

// Thin wrappers — all the guard/write logic lives in lib/recipe-materialize.js
// so it can be tested directly (scripts/test_recipe_materialize.js) rather
// than through an HTTP layer.
router.post('/api/retail-admin/recipes/:id/materialize', requireRetailAdmin, (req, res) => {
  if (!requireMaterialsEditToo(req, res)) return;
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const result = b.mode === 'link'
    ? materializeLink(db, { recipeId: recipe.id, materialId: Number(b.material_id) })
    : materializeNew(db, { recipeId: recipe.id, name_en: b.name_en || recipe.name_en, name_cn: b.name_cn, sku: b.sku, item_kind: b.item_kind });

  if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error, message: result.message });
  res.json({ success: true, material_id: result.material_id, warning: result.warning || null, rollup: result.rollup });
});

router.delete('/api/retail-admin/recipes/:id/materialize', requireRetailAdmin, (req, res) => {
  if (!requireMaterialsEditToo(req, res)) return;
  const recipe = db.prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });
  const result = unlinkMaterial(db, { recipeId: recipe.id });
  if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error, message: result.message });
  res.json({ success: true, material_id: result.material_id });
});

module.exports = router;
