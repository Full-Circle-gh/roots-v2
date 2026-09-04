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
// CLIENT-DIRECTED path (a client body naming a specific material_id or a
// specific new-material name) permitted to write ingredients.source_recipe_id.
// routes/retail-materials.js's own save path deliberately refuses to read
// that field from the client (see its readBody()) and stays that way; this
// file is where the exception lives, guarded and narrow.
//
// A SECOND, INDIRECT PATH EXISTS AS OF §29's third addendum (2026-08-27):
// every successful POST/PUT here also calls lib/recipe-materialize.js's
// ensureMaterialized(), which can create a new source_recipe_id-linked row
// with no material_id or name ever supplied by the client — the recipe's own
// name is not something a client "directs" the way materializeLink's
// material_id choice is. It is still the same file, the same guards
// (materializeNew underneath), and the same refusal-on-ambiguity discipline;
// it is not a third door.

const express = require('express');
// Per-tenant connection, for EVERY read and write in this file. `recipes`,
// `recipe_ingredients`, `recipe_steps`, `recipe_cost_data` and `ingredients`
// are data-plane tables with no tenant_id column, so under data isolation they
// live in the account's own DB and the global handle is account #1's. Only the
// cost writes used tdb() before; creating and editing a recipe went to the
// global handle. Account #1 resolves tdb() to that same global handle, so the
// live install is unchanged.
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const { computeRecipeCost } = require('../lib/recipe-cost');
const { checkCycle } = require('../lib/recipe-graph');
// §29 step 5 — the "make available as material" guards/writes live here, not
// in this route file, so they can be tested directly. See its own header.
const { materializeNew, materializeLink, unlink: unlinkMaterial, linkedMaterialFor, materialConsumers, ensureMaterialized } = require('../lib/recipe-materialize');
// The nested-recipe recompute (§29 step 3) — fired after a save that can move
// a linked material's recipe-derived cost. Same triggers routes/recipes.js
// already fires from the kitchen door; a recipe backing a material must stay
// correct no matter which door saved it.
const { fireRecompute, backsAnyCostedRow, costOneRecipe } = require('../lib/recipe-rollup');
const { saveRecipeCostData } = require('../lib/recipe-cost-data-write');
// The derived batch size / serving count, stamped onto the row after the
// lines are written and before the rollup divides by it. See its header.
const { applyAutoYield } = require('../lib/recipe-yield');
// Version history (the undo behind the record's autosave) — every save through
// this door files the state it displaced, and the History panel puts one back.
// See lib/recipe-versions.js for why the snapshot is whole-record JSON.
const { snapshotRecipe, listVersions, getVersion, restoreVersion } = require('../lib/recipe-versions');

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
    const verdict = checkCycle(tdb(), { recipeId: rid, ingredientId: ing.ingredient_id });
    if (verdict.ok) continue;
    const names = verdict.chain.map(id => {
      const r = tdb().prepare('SELECT name_en FROM recipes WHERE id = ?').get(id);
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
    ? tdb().prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE sku = ? AND id != ?').get(sku, excludeId)
    : tdb().prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE sku = ?').get(sku);
  if (!owner) return { error: 'sku_taken', message: 'SKU already exists' };
  return {
    error: 'sku_taken',
    message: owner.is_active
      ? `SKU "${sku}" is already used by "${owner.name_en}" (#${owner.id}).`
      : `SKU "${sku}" belongs to an archived recipe ("${owner.name_en}", #${owner.id}).`,
    conflict: { id: owner.id, name_en: owner.name_en, name_cn: owner.name_cn, is_active: owner.is_active },
  };
}

// Recipe type — the two values recipes.recipe_type may hold, and
// nothing else. Anything unrecognised is refused rather than stored, so the
// filter can never meet a third state it has no chip for.
//
// `undefined` back means "the client didn't say", which is NOT the same as
// 'made': the update below leaves the stored value alone in that case, so a
// caller that predates this field can never quietly reclassify a repack.
// Create has no such history to protect and defaults to 'made'.
const RECIPE_TYPES = ['made', 'repacked'];
function readRecipeType(b) {
  if (b.recipe_type === undefined || b.recipe_type === null || b.recipe_type === '') return undefined;
  const v = String(b.recipe_type);
  return RECIPE_TYPES.includes(v) ? v : undefined;
}

// The body fields a recipe carries, listed once so create and update read the
// same set — matches retail-materials.js's readBody() convention.
// A 0/1 flag as the client sent it, or `undefined` when the client said
// nothing. The distinction is the same one readRecipeType keeps: a caller that
// predates the field must never be read as having turned it off — the update
// below leaves the stored value alone in that case.
function readFlag(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return (v === 1 || v === true || v === '1') ? 1 : 0;
}

function readBody(b) {
  return {
    name_en: b.name_en, name_cn: b.name_cn || null, sku: (b.sku || '').trim() || null,
    category: b.category || null,
    batch_size: b.batch_size || null, servings: b.servings || null, serving_size: b.serving_size || null,
    // Whether either of those two is derived rather than typed. The figures
    // themselves are still sent and still stored — a derived batch size that
    // stopped being derivable falls back to the last one written, and clearing
    // the column on the way past would leave nothing to fall back to.
    batch_size_auto: readFlag(b.batch_size_auto), servings_auto: readFlag(b.servings_auto),
    shelf_life: b.shelf_life || null, storage: b.storage || null, notes: b.notes || null,
    recipe_type: readRecipeType(b),
  };
}

// One ingredient line's yield flag. Same absent-vs-stated rule as readFlag, and
// the caller decides what absent means: on create it is 1 (a new line counts),
// on update it is whatever the line already carried, so a save from a door that
// has no such control cannot silently re-count a discarded ingredient.
function readLineYield(ing) {
  return readFlag(ing && ing.in_yield);
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
  const r = costOneRecipe(tdb(), recipeId, new Map());
  return { ok: r.ok, reason: r.ok ? null : r.reason, unpriced: r.unpriced || 0 };
}

// Who to name beside a filed version. The operator, as requireRetailAdmin
// already resolved him (routes/retail.js sets req.user for the backend realm
// precisely so handlers like this don't have to know which realm they're in).
// A display name reads better in the History list than a login, but the login
// is the identifier that is always there.
function actorOf(req) {
  const u = req.user || {};
  return u.display_name || u.username || (u.id ? 'user #' + u.id : null);
}

// How this save was made, as the client declares it: 'auto' is the record's
// debounced background save, 'manual' is someone pressing Save. It changes ONLY
// how aggressively versions coalesce (lib/recipe-versions.js COALESCE_MS) and
// what the History list labels the row — never what is written to the recipe.
// Anything unrecognised is treated as a manual save, which is the safer of the
// two: it files a restore point rather than folding into an existing one.
function saveSourceOf(req) {
  const v = String((req.body && req.body.save_source) || '').toLowerCase();
  return v === 'auto' ? 'auto' : 'manual';
}

// ═══ List ══════════════════════════════════════════════════════════════════
router.get('/api/retail-admin/recipes', requireRetailAdmin, (req, res) => {
  const { search, category, archived } = req.query;
  let where = ' WHERE is_active = ?';
  const p = [archived === '1' ? 0 : 1];
  if (search)   { where += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; p.push(s, s, s); }
  if (category) { where += ' AND category = ?'; p.push(category); }

  const recipes = tdb().prepare(`SELECT * FROM recipes${where} ORDER BY is_favorite DESC, name_en COLLATE NOCASE`).all(...p);

  // Bulk-load lines + cost data in three queries total rather than one round
  // trip per row — same technique the Excel export uses (routes/recipes.js,
  // lib/recipe-cost.js header comment), necessary here too since a list of 85
  // recipes would otherwise be 255 queries just to show a cost column.
  const ids = recipes.map(r => r.id);
  let linesByRecipe = new Map(), costByRecipe = new Map(), materialByRecipe = new Map();
  if (ids.length) {
    const qs = ids.map(() => '?').join(',');
    const allLines = tdb().prepare(`
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
    const allCost = tdb().prepare(`SELECT * FROM recipe_cost_data WHERE recipe_id IN (${qs})`).all(...ids);
    costByRecipe = new Map(allCost.map(c => [c.recipe_id, c]));
    const allMaterials = tdb().prepare(`SELECT id, name_en, cost_per_unit, unit, source_recipe_id FROM ingredients WHERE source_recipe_id IN (${qs})`).all(...ids);
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
      // The RESOLVED figures, not the raw columns. lib/recipe-yield.js keeps the
      // two in step on every save, so they agree today; taking them off the
      // breakdown means the list cannot be the screen that disagrees if a row is
      // ever written by a path that does not stamp them.
      batch_size: c.batchSize || null, servings: c.servings || null,
      is_active: r.is_active, is_favorite: !!r.is_favorite,
      // Filing only — the list's Made/Repacked filter is the only thing that
      // reads it. Deliberately NOT a server-side WHERE: the filter chips show
      // a count each, and a count of what the server just filtered out is not
      // a count anyone can act on. The client filters the rows it already has,
      // exactly as the Products list does with its category chips.
      recipe_type: r.recipe_type || 'made',
      // batchCost is always computable (it needs neither batch_size nor
      // servings) — the list's cost column falls back to it when neither
      // per-unit figure can be worked out, which real data shows is common
      // (3 of the 4 recipes named in the build gate have both unset).
      batchCost: c.batchCost, costPerServing: c.costPerServing, costPerGram: c.costPerGram,
      zeroCostIngredientLines: c.zeroCostIngredientLines,
      // Lines whose unit measures a different kind of thing than their
      // material's stocking unit (§7 addendum), left out of the cost entirely.
      // Carried for the SAME reason zeroCostIngredientLines is: the list paints
      // a warning icon on the recipes whose cost is understated, and until now
      // it could only see one of the two ways that happens. computeRecipeCost
      // already derived this figure on the line above — forwarding it costs no
      // query, and re-deriving it in SQL would be the second copy of the
      // dimension rule that lib/recipe-cost.js exists to prevent.
      //
      // NOT folded into the count above and never will be: those materials are
      // not missing a cost, they have a good one this line's quantity cannot be
      // multiplied by. Two facts, two counters, two sentences — the separation
      // the recipe record's two pills already keep on screen.
      unreconciledUnitLines: c.unreconciledUnitLines,
      backsMaterial: material ? { id: material.id, name_en: material.name_en, cost_per_unit: material.cost_per_unit, unit: material.unit } : null,
      materialBlock: material ? materialBlockState(r.id) : null,
    };
  });
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/recipes/meta/categories', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    "SELECT DISTINCT category FROM recipes WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category COLLATE NOCASE"
  ).all();
  res.json({ success: true, data: rows.map(r => r.category) });
});

// Open collisions from automatic materialization (§29's third addendum) — the
// data source for a human to resolve one, via materializeLink/materializeNew
// below. Registered here, ahead of GET /:id, for the same reason
// meta/categories is: a literal path segment must be matched before the
// parameterized route or it is shadowed and never reached. Read-only; no
// screen consumes this yet (Step 3 of the build-lines work,
// docs/tacet-product-build-lines-design.md, is a separate PR), but the rows
// are real from the moment auto-materialize first refuses to guess.
router.get('/api/retail-admin/recipes/materialize-collisions', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(`
    SELECT c.id, c.recipe_id, c.candidate_ingredient_id, c.reason, c.created_at,
           r.name_en AS recipe_name_en, r.name_cn AS recipe_name_cn, r.sku AS recipe_sku,
           i.name_en AS candidate_name_en, i.name_cn AS candidate_name_cn, i.sku AS candidate_sku
      FROM recipe_materialize_collisions c
      JOIN recipes r ON r.id = c.recipe_id
      LEFT JOIN ingredients i ON i.id = c.candidate_ingredient_id
     WHERE c.resolved_at IS NULL
     ORDER BY c.created_at ASC
  `).all();
  res.json({ success: true, data: rows });
});

// ═══ One recipe ════════════════════════════════════════════════════════════
router.get('/api/retail-admin/recipes/:id', requireRetailAdmin, (req, res) => {
  const recipe = tdb().prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });
  const ingredients = tdb().prepare(`
    SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
           i.free_by_design AS master_free, i.name_en AS master_name_en, i.item_kind AS master_item_kind
      FROM recipe_ingredients ri
      LEFT JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ? ORDER BY ri.sort_order
  `).all(recipe.id);
  const steps = tdb().prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number').all(recipe.id);
  const costData = tdb().prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(recipe.id);
  const cost = computeRecipeCost({ recipe, ingredients, costData });
  const material = linkedMaterialFor(tdb(), recipe.id);
  // Which retail products this recipe makes — the reverse of the product
  // editor's "From recipe" link (that one names the recipe from the product;
  // this names the products from the recipe). Read-only: the link itself is
  // owned and edited on the product side, never here.
  //
  // ACTIVE ROWS ONLY, and `COALESCE(is_active,1) = 1` rather than
  // `is_active = 1` because the column is nullable and an older row can carry
  // NULL meaning "live". Exactly the filter lib/recipe-rollup.js's
  // loadLinkedProducts() uses to decide which products a recipe may cost, so
  // the header can never advertise a product the rollup would not write to.
  // This is load-bearing, not tidiness: two ARCHIVED rows carry a recipe_id
  // inherited from the fork mirror, and without the filter a recipe with no
  // live product would claim two.
  //
  // Priced per ROW and never blended. One recipe can feed a 150g bag and a 25g
  // sample at different prices; a single averaged margin across them would be a
  // number that is true of neither. The client renders one line each.
  //
  // Wrapped, exactly as loadLinkedProducts() is: a handle with no storefront has
  // no store_products, and "this recipe makes nothing we sell" is the right
  // answer there — not a 500 that takes the whole recipe record down with it.
  let products = [];
  try {
    products = tdb().prepare(`
      SELECT sp.id, sp.name_en, sp.name_cn, sp.weight AS size, sp.sell_price, sp.unit_cost,
             -- DOES THIS RECIPE STILL OWN THAT unit_cost? Since §31's addendum
             -- a product with a build list takes its cost from the list and
             -- applyProductCosts() skips it, so the figure beside this recipe
             -- may have nothing to do with this recipe. The screen has to know,
             -- because it prints the product's margin in the same strip as the
             -- recipe's own batch cost and cost-per-serving: Hazelnut-Chocolate
             -- Spread showed "Cost per serving ¥46.05" beside "Margin 98.6%",
             -- the second computed from a ¥1.23 build list, and the two read as
             -- one arc. 0 rows here means the recipe still owns it.
             (SELECT COUNT(*) FROM product_build_lines pbl WHERE pbl.product_id = sp.id) AS build_line_count
        FROM store_products sp
       WHERE sp.recipe_id = ? AND COALESCE(sp.is_active,1) = 1
       ORDER BY sp.name_en COLLATE NOCASE, sp.id
    `).all(recipe.id);
  } catch (e) { products = []; }
  // consumers (§29 step 6) — which OTHER active recipes currently use this
  // material as an ingredient line. Only fetched when there's a material to
  // report on; feeds the archive-warning's "used by N recipes" — naming the
  // actual consequence rather than a generic confirm.
  res.json({ success: true, data: {
    ...recipe, ingredients, steps, costData, cost,
    backsMaterial: material ? { ...material, consumers: materialConsumers(tdb(), material.id) } : null,
    materialBlock: material ? materialBlockState(recipe.id) : null,
    products,
  } });
});

// ═══ Create ════════════════════════════════════════════════════════════════
router.post('/api/retail-admin/recipes', requireRetailAdmin, (req, res) => {
  const b = readBody(req.body || {});
  if (!b.name_en) return res.status(400).json({ success: false, error: 'name_required' });
  const lines = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];
  try {
    // A CREATE THAT CARRIES A FIGURE IS A CREATE THAT MEANT IT. The column
    // defaults to derived, which is right for the editor (it sends the flags
    // explicitly anyway) and wrong for any caller that types a batch size and
    // says nothing about deriving — an import, a fork, a script. Falling back on
    // "did they send a number" keeps every one of those behaving exactly as it
    // does today.
    const batchAuto = b.batch_size_auto === undefined ? (b.batch_size == null ? 1 : 0) : b.batch_size_auto;
    const servAuto  = b.servings_auto   === undefined ? (b.servings   == null ? 1 : 0) : b.servings_auto;
    const result = tdb().prepare(`INSERT INTO recipes
      (name_en,name_cn,sku,category,batch_size,servings,serving_size,batch_size_auto,servings_auto,shelf_life,storage,notes,recipe_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.name_en, b.name_cn, b.sku, b.category, b.batch_size, b.servings, b.serving_size, batchAuto, servAuto,
           b.shelf_life, b.storage, b.notes,
           b.recipe_type || 'made');
    const recipeId = result.lastInsertRowid;
    if (lines.length) {
      const insertIng = tdb().prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,in_yield,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((ing, i) => {
        const iy = readLineYield(ing);
        insertIng.run(recipeId, ing.ingredient_id || null, ing.name_en || '', ing.name_cn || null, ing.sku || null, ing.qty || 0, ing.unit || 'g', iy === undefined ? 1 : iy, ing.notes || null, ing.substitutes || null, i);
      });
    }
    // The lines are in; the derived figures follow them.
    applyAutoYield(tdb(), recipeId);
    const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
    if (steps.length) {
      const insertStep = tdb().prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(recipeId, i + 1, s.name || null, s.instructions || null));
    }
    // §29's third addendum: a recipe's output always has a materials row,
    // whether or not anything uses it yet. Never blocks the save.
    const materialize = ensureMaterialized(tdb(), recipeId);
    res.json({ success: true, id: recipeId, materialize });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, null) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Update ════════════════════════════════════════════════════════════════
router.put('/api/retail-admin/recipes/:id', requireRetailAdmin, (req, res) => {
  const existing = tdb().prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const b = readBody(req.body || {});
  if (!b.name_en) return res.status(400).json({ success: false, error: 'name_required' });
  const lines = req.body.ingredients;
  const steps = req.body.steps;
  if (lines) {
    const refusal = cycleRefusal(req.params.id, lines);
    if (refusal) return res.status(400).json({ success: false, error: 'cycle', message: refusal });
  }
  // File the state this save is about to overwrite, BEFORE the writes below and
  // AFTER the cycle guard — a refused save changed nothing and must not leave a
  // version behind claiming it did. Reads through the same `db` handle the
  // UPDATE writes to, so the filed state is genuinely the one being displaced.
  // Never throws: snapshotRecipe returns a reason instead, because a save that
  // succeeded must not report failure over its history entry.
  snapshotRecipe(tdb(), req.params.id, { source: saveSourceOf(req), actor: actorOf(req) });
  try {
    tdb().prepare(`UPDATE recipes SET
      name_en=?,name_cn=?,sku=?,category=?,batch_size=?,servings=?,serving_size=?,shelf_life=?,storage=?,notes=?,
      recipe_type=COALESCE(?,recipe_type),
      batch_size_auto=COALESCE(?,batch_size_auto), servings_auto=COALESCE(?,servings_auto),
      updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.name_en, b.name_cn, b.sku, b.category, b.batch_size, b.servings, b.serving_size, b.shelf_life, b.storage, b.notes,
           b.recipe_type === undefined ? null : b.recipe_type,
           b.batch_size_auto === undefined ? null : b.batch_size_auto,
           b.servings_auto === undefined ? null : b.servings_auto,
           req.params.id);
    if (lines) {
      // WHAT THE INCOMING LINES DO NOT SAY, THE OLD ONES DO. The update replaces
      // recipe_ingredients wholesale, so a client that knows nothing about
      // in_yield would re-count an ingredient somebody deliberately excluded
      // from the batch weight — silently, and in the number every per-gram cost
      // divides by. Keyed on ingredient_id, which is what identifies a line
      // across a delete-and-reinsert; a line with none (a deleted material)
      // falls back to counting, as it always did.
      const prevYield = new Map(
        tdb().prepare('SELECT ingredient_id, in_yield FROM recipe_ingredients WHERE recipe_id = ? AND ingredient_id IS NOT NULL')
          .all(req.params.id).map(r => [r.ingredient_id, r.in_yield])
      );
      tdb().prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(req.params.id);
      const insertIng = tdb().prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,name_cn,sku,qty,unit,in_yield,notes,substitutes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((ing, i) => {
        const said = readLineYield(ing);
        const kept = prevYield.has(ing.ingredient_id) ? prevYield.get(ing.ingredient_id) : 1;
        insertIng.run(req.params.id, ing.ingredient_id || null, ing.name_en || '', ing.name_cn || null, ing.sku || null, ing.qty || 0, ing.unit || 'g', said === undefined ? (kept == null ? 1 : kept) : said, ing.notes || null, ing.substitutes || null, i);
      });
    }
    // BEFORE the recompute below, not after: fireRecompute divides a linked
    // material's cost by batch_size, and it must divide by the one these lines
    // just produced.
    applyAutoYield(tdb(), req.params.id);
    if (steps) {
      tdb().prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(req.params.id);
      const insertStep = tdb().prepare('INSERT INTO recipe_steps (recipe_id,step_number,name,instructions) VALUES (?,?,?,?)');
      steps.forEach((s, i) => insertStep.run(req.params.id, i + 1, s.name || null, s.instructions || null));
    }
    // Recompute trigger (§29 step 3) — same condition the kitchen door checks
    // (routes/recipes.js PUT /:id): batch_size and the ingredient lines just
    // written both feed a linked material's recipe cost.
    // tdb(): fireRecompute WRITES through the handle it is given
    // (lib/recipe-rollup.js stamps ingredients.cost_per_unit and
    // store_products.unit_cost), and backsAnyCostedRow decides whether it runs
    // — both must look at the same database the save above wrote to.
    if (backsAnyCostedRow(tdb(), req.params.id)) {
      fireRecompute(tdb(), { source: 'retail-recipes.update', recipe_id: Number(req.params.id) });
    }
    // §29's third addendum — after the name/SKU write and the recompute, so
    // a rename that clears a collision is picked up this same request.
    const materialize = ensureMaterialized(tdb(), req.params.id);
    res.json({ success: true, materialize });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, req.params.id) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Cost data ═════════════════════════════════════════════════════════════
router.put('/api/retail-admin/recipes/:id/cost', requireRetailAdmin, (req, res) => {
  // The existence guard reads the same database the cost row is written to —
  // otherwise a tenant's save is admitted or refused on Roots' recipe list.
  const existing = tdb().prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  // One logical save from the record is TWO requests (the recipe PUT above and
  // this one), and they must not file two versions of nearly the same state.
  // They don't: the recipe PUT files its point first, and COALESCE_MS folds
  // this call into it — see lib/recipe-versions.js. Called anyway rather than
  // skipped, because a cost-only save (nothing touched on the other three tabs)
  // is a real change to what this recipe costs and deserves its own point.
  snapshotRecipe(tdb(), req.params.id, { source: saveSourceOf(req), actor: actorOf(req) });
  // THIS SCREEN HAS NO PACKAGING-TYPE PICKER, so its payload never carries
  // `packaging_type_id` — and the write underneath keeps the stored one rather
  // than coalescing the missing key to NULL. That is the whole of finding 11:
  // every save here used to keep the packaging NUMBER and discard which
  // packaging it was, quietly deleting the packaging migration's input one
  // recipe at a time. The absent/cleared distinction lives in the lib so it
  // holds for the kitchen route and for any caller not yet written.
  saveRecipeCostData(tdb(), req.params.id, req.body);
  if (backsAnyCostedRow(tdb(), req.params.id)) {
    fireRecompute(tdb(), { source: 'retail-recipes.cost_update', recipe_id: Number(req.params.id) });
  }
  res.json({ success: true });
});

// ═══ Archive / restore ═════════════════════════════════════════════════════
// Combined into one endpoint, matching retail-materials.js's shape — not the
// kitchen door's separate DELETE/restore pair. No hard-delete route here: the
// kitchen door's permanent-delete is a kitchen-only affordance not mirrored
// onto this one, same as Materials never got one either.
router.put('/api/retail-admin/recipes/:id/archive', requireRetailAdmin, (req, res) => {
  const row = tdb().prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const active = req.body && req.body.restore ? 1 : 0;
  tdb().prepare('UPDATE recipes SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(active, req.params.id);
  res.json({ success: true, is_active: active });
});

// ═══ Version history ═══════════════════════════════════════════════════════
// The record autosaves, so these three routes are not a nicety — they are the
// half of autosave that lets a change be taken back. Every save above files the
// state it displaced (lib/recipe-versions.js); this lists those states, reads
// one back, and puts one on the live recipe.
//
// Registered under :id/versions, which cannot shadow GET /:id (that route
// matches a single segment) and cannot be shadowed by it.
//
// The two reads are open, as every GET under this prefix is (lib/cap-routes.js
// gates write verbs only). The restore is a POST and so carries recipes:edit,
// the same capability a save carries — which is the right gate, since it can
// only ever write a state this very recipe was already in. It opens nothing a
// save does not.

router.get('/api/retail-admin/recipes/:id/versions', requireRetailAdmin, (req, res) => {
  const recipe = tdb().prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: listVersions(tdb(), req.params.id, req.query.limit) });
});

router.get('/api/retail-admin/recipes/:id/versions/:versionId', requireRetailAdmin, (req, res) => {
  const v = getVersion(tdb(), req.params.id, req.params.versionId);
  if (!v) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: v });
});

router.post('/api/retail-admin/recipes/:id/versions/:versionId/restore', requireRetailAdmin, (req, res) => {
  const result = restoreVersion(tdb(), req.params.id, req.params.versionId, {
    actor: actorOf(req),
    // The cost inputs go back through the SAME writer and the SAME handle the
    // cost route uses, so a restore obeys the absent-vs-cleared rule
    // (lib/recipe-cost-data-write.js) rather than carrying a second copy of it.
    costDb: tdb(),
    saveCostData: saveRecipeCostData,
  });
  if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error, message: result.message });
  // The same two things every other successful write here does. A restore can
  // move a linked material's cost exactly as a save can — it IS a save, of an
  // older state — and a restored name can clear or cause a materialize
  // collision just as a typed one can.
  if (backsAnyCostedRow(tdb(), req.params.id)) {
    fireRecompute(tdb(), { source: 'retail-recipes.restore', recipe_id: Number(req.params.id) });
  }
  const materialize = ensureMaterialized(tdb(), req.params.id);
  res.json({ success: true, version_id: result.version_id, held: result.held, materialize });
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
  const recipe = tdb().prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const result = b.mode === 'link'
    ? materializeLink(tdb(), { recipeId: recipe.id, materialId: Number(b.material_id) })
    : materializeNew(tdb(), { recipeId: recipe.id, name_en: b.name_en || recipe.name_en, name_cn: b.name_cn, sku: b.sku, item_kind: b.item_kind });

  if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error, message: result.message });
  res.json({ success: true, material_id: result.material_id, warning: result.warning || null, rollup: result.rollup });
});

router.delete('/api/retail-admin/recipes/:id/materialize', requireRetailAdmin, (req, res) => {
  if (!requireMaterialsEditToo(req, res)) return;
  const recipe = tdb().prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) return res.status(404).json({ success: false, error: 'not_found' });
  const result = unlinkMaterial(tdb(), { recipeId: recipe.id });
  if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error, message: result.message });
  res.json({ success: true, material_id: result.material_id });
});

module.exports = router;
