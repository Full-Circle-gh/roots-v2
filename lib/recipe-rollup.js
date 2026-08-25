// Nested-recipe cost rollup (§29 step 2) — the pass that lets a made
// material's cost come from the recipe that makes it.
//
// WHY A TOPOLOGICAL PASS AND NOT A LOOP
// -------------------------------------
// lib/recipe-cost.js is FLAT: it reads each line's ingredients.cost_per_unit as
// a leaf number and never asks where that number came from. That is correct and
// stays correct. Nesting is layered on top here: a linked material's cost is
// its recipe's costPerGram, so a recipe that consumes one must be costed AFTER
// the recipe that makes it. Deepest first — that is all topological order means
// in this file.
//
// Costs are never written mid-pass to make the next computation see them.
// Each resolved material's cost is carried in an override map and injected as
// that line's master_cost. A pass therefore reads a consistent database from
// start to finish, and a pass that is abandoned leaves nothing behind.
//
// BLOCKED NODES STOP THE CASCADE, THEY DO NOT ZERO IT
// ---------------------------------------------------
// A source recipe that cannot yield a cost (no batch_size, or a line nobody has
// priced) writes NOTHING — never 0. This is lib/ingredient-cost.js's own rule
// ("null means write nothing, not zero") applied one level up, and it is what
// keeps a blocked material from silently reading as free. Blocking propagates
// for free: computeRecipeCost already counts a line whose master cost is not > 0
// as a missing cost rather than adding zero, so a recipe above a blocked
// material is itself blocked instead of receiving a confidently wrong number.
//
// NO WRITES IN THIS FILE. It computes a plan; the caller decides whether to
// apply it, and owns the transaction.

'use strict';

const { computeRecipeCost } = require('./recipe-cost');

// Every linked material, keyed by the recipe that makes it.
function loadLinkedMaterials(db) {
  const rows = db.prepare(`
    SELECT id AS ingredient_id, name_en, sku, unit, cost_per_unit, source_recipe_id
      FROM ingredients
     WHERE source_recipe_id IS NOT NULL
  `).all();
  const byRecipe = new Map();
  for (const r of rows) byRecipe.set(r.source_recipe_id, r);
  return byRecipe;
}

// One recipe's lines, carrying what the cost maths needs plus the link column
// so a line that is itself a made material can be recognised.
function linesFor(db, recipeId) {
  return db.prepare(`
    SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
           i.free_by_design AS master_free, i.name_en AS master_name_en,
           i.source_recipe_id AS master_source_recipe_id
      FROM recipe_ingredients ri
      LEFT JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ?
     ORDER BY ri.sort_order
  `).all(recipeId);
}

// Dependency edges BETWEEN linked source recipes only — recipe S depends on
// recipe T when one of S's lines is a material made by T. Terminal consumers
// (an ordinary recipe using a made material) are not here: nothing is computed
// for them, so they never need ordering.
function buildSourceGraph(db, byRecipe) {
  const deps = new Map();
  for (const recipeId of byRecipe.keys()) deps.set(recipeId, new Set());
  for (const recipeId of byRecipe.keys()) {
    for (const line of linesFor(db, recipeId)) {
      const src = line.master_source_recipe_id;
      if (src && src !== recipeId && byRecipe.has(src)) deps.get(recipeId).add(src);
    }
  }
  return deps;
}

/**
 * Kahn's algorithm: dependencies before the things that need them.
 *
 * Returns { order, unresolved }. `unresolved` is non-empty only when the graph
 * holds a cycle — the nodes that could never reach in-degree zero. The caller
 * must treat that as a refusal, not a partial result: a cycle means "these
 * costs are defined in terms of each other" and no order exists. This is the
 * backstop to the save-time guard in lib/recipe-graph.js, which is what should
 * normally stop a cycle ever reaching the database at all.
 */
function topoOrder(deps) {
  const indeg = new Map();
  const dependents = new Map();
  for (const node of deps.keys()) { indeg.set(node, 0); dependents.set(node, []); }
  for (const [node, ds] of deps) {
    for (const d of ds) {
      if (!indeg.has(d)) continue;
      indeg.set(node, indeg.get(node) + 1);
      dependents.get(d).push(node);
    }
  }
  // Sorted seed so a run is reproducible — the same database yields the same
  // order, which is what makes a dry-run comparable to the apply that follows.
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort((a, b) => a - b);
  const order = [];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const dep of dependents.get(node)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) { queue.push(dep); queue.sort((a, b) => a - b); }
    }
  }
  const unresolved = [...deps.keys()].filter(id => !order.includes(id));
  return { order, unresolved };
}

// Cost one source recipe, with already-resolved linked materials injected.
// `overrides` maps ingredient_id -> { cpu } where cpu === null means blocked.
//
// BLOCKED AND FREE ARE NOT THE SAME ZERO, and this is the only place that can
// tell them apart. computeRecipeCost reads a line as "cost missing" when its
// master_cost is not > 0, UNLESS master_free is set — which is how
// free_by_design stops water crying wolf. So:
//   blocked (null)   -> master_cost 0, master_free 0  => counted missing, the
//                       block propagates upward, nothing is invented
//   genuinely free(0) -> master_cost 0, master_free 1  => a real zero that adds
//                       nothing and blocks nothing
// Collapsing these (an earlier draft mapped both to a bare 0) would make a
// material whose recipe legitimately costs nothing — one made only of things
// marked free by design — block every recipe above it.
function costOneRecipe(db, recipeId, overrides) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
  if (!recipe) return { ok: false, reason: 'recipe_missing' };
  if (!recipe.is_active) return { ok: false, reason: 'recipe_archived' };

  const lines = linesFor(db, recipeId).map(l => {
    if (l.ingredient_id == null || !overrides.has(l.ingredient_id)) return l;
    const { cpu } = overrides.get(l.ingredient_id);
    if (cpu === null) return { ...l, master_cost: 0, master_free: 0 };
    if (cpu === 0)    return { ...l, master_cost: 0, master_free: 1 };
    return { ...l, master_cost: cpu, master_free: 0 };
  });

  const costData = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(recipeId);
  const c = computeRecipeCost({ recipe, ingredients: lines, costData });
  if (!lines.length) return { ok: false, reason: 'no_ingredient_lines', detail: c };
  if (c.zeroCostIngredientLines > 0) {
    return { ok: false, reason: 'unpriced_lines', unpriced: c.zeroCostIngredientLines, detail: c };
  }
  if (!(c.batchSize > 0)) return { ok: false, reason: 'no_batch_size', detail: c };
  if (c.costPerGram === null) return { ok: false, reason: 'no_cost_per_unit', detail: c };
  return { ok: true, cpu: c.costPerGram, detail: c };
}

/**
 * Plan the whole rollup. READ-ONLY — returns what would change, writes nothing.
 *
 * Returns:
 *   order       recipe ids, dependency-first
 *   changes     [{ ingredient_id, name, sku, unit, oldCpu, newCpu, consumers }]
 *   blocked     [{ ingredient_id, name, recipe_id, recipeName, reason, unpriced }]
 *   unchanged   count of linked materials whose cost already matched
 *   cycle       recipe ids that could not be ordered (empty in a sane graph)
 */
function planRollup(db) {
  const byRecipe = loadLinkedMaterials(db);
  const deps = buildSourceGraph(db, byRecipe);
  const { order, unresolved } = topoOrder(deps);

  // ingredient_id -> { cpu } ; cpu === null means blocked. No memo table: the
  // topological order visits every recipe exactly once, so there is nothing a
  // cache could save. (The first draft carried one; deliberately breaking it
  // changed no result, which is how it was found to be dead.)
  const overrides = new Map();
  const changes = [];
  const blocked = [];
  let unchanged = 0;

  for (const recipeId of order) {
    const mat = byRecipe.get(recipeId);
    const result = costOneRecipe(db, recipeId, overrides);

    if (!result.ok) {
      overrides.set(mat.ingredient_id, { cpu: null });
      const r = db.prepare('SELECT name_en FROM recipes WHERE id = ?').get(recipeId);
      blocked.push({
        ingredient_id: mat.ingredient_id, name: mat.name_en, sku: mat.sku,
        recipe_id: recipeId, recipeName: (r && r.name_en) || `#${recipeId}`,
        reason: result.reason, unpriced: result.unpriced || 0,
        oldCpu: mat.cost_per_unit,
      });
      continue;
    }

    overrides.set(mat.ingredient_id, { cpu: result.cpu });
    const oldCpu = Number(mat.cost_per_unit) || 0;
    // Same 6dp rounding routes/admin.js's repair already applies, so a value
    // that only differs in float tail noise is not reported as a change.
    const newCpu = Math.round(result.cpu * 1e6) / 1e6;
    if (Math.abs(newCpu - oldCpu) <= 0.0000001) { unchanged++; continue; }

    const consumers = db.prepare(`
      SELECT DISTINCT r.name_en AS name
        FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
       WHERE ri.ingredient_id = ? AND COALESCE(r.is_active,1) = 1 AND r.id != ?
       ORDER BY r.name_en
    `).all(mat.ingredient_id, recipeId).map(x => x.name);

    changes.push({
      ingredient_id: mat.ingredient_id, name: mat.name_en, sku: mat.sku,
      unit: mat.unit, recipe_id: recipeId,
      oldCpu, newCpu, consumers,
      batchCost: result.detail.batchCost, batchSize: result.detail.batchSize,
    });
  }

  return { order, changes, blocked, unchanged, cycle: unresolved, linkedCount: byRecipe.size };
}

/**
 * The incremental form, for the live trigger points (NOT wired in yet — the
 * first run is a reviewed one-off; see scripts/rollup_made_material_costs.js).
 *
 * Recomputing the whole graph costs single-digit milliseconds at this size, so
 * this deliberately re-plans everything rather than maintaining a second,
 * subtly-different partial walk. One code path, one set of rules. `trigger` is
 * accepted and recorded so a caller can say what set it off without changing
 * what is computed.
 */
function recomputeDownstreamFrom(db, trigger) {
  const plan = planRollup(db);
  return { ...plan, trigger: trigger || null };
}

module.exports = {
  loadLinkedMaterials, linesFor, buildSourceGraph, topoOrder,
  costOneRecipe, planRollup, recomputeDownstreamFrom,
};
