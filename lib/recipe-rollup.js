// Nested-recipe cost rollup (§29 step 2) — the pass that lets a made
// material's cost come from the recipe that makes it.
//
// WHY A TOPOLOGICAL PASS AND NOT A LOOP
// -------------------------------------
// lib/recipe-cost.js is FLAT: it reads each line's ingredients.cost_per_unit as
// a leaf number and never asks where that number came from. That is correct and
// stays correct. Nesting is layered on top here: a linked material's cost is
// its recipe's materialCostPerGram (§29 — the batch cost MINUS what belongs to
// selling a serving; see recipe-cost.js MATERIAL_COST_COMPONENTS), so a recipe
// that consumes one must be costed AFTER
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
  // §29 — materialCostPerGram, NOT costPerGram. What a gram of this costs a
  // recipe that consumes it, which is not what the batch cost per gram: the
  // retail container belongs to the serving that is SOLD, and the part of the
  // batch held in bulk for later use goes into a reused kitchen tub nobody
  // costs. Which costs travel is declared in ONE place — recipe-cost.js
  // MATERIAL_COST_COMPONENTS — so this stays a read rather than arithmetic.
  // Null on the same condition as before (no batch size), so this gate refuses
  // exactly the recipes it refused before and no others.
  if (c.materialCostPerGram === null) return { ok: false, reason: 'no_cost_per_unit', detail: c };
  return { ok: true, cpu: c.materialCostPerGram, detail: c };
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
 * Apply the rollup — the function every live trigger point calls.
 *
 * Re-plans fresh against the current database, INSIDE its own transaction,
 * and writes every changed linked-material cost. `trigger` is a small
 * caller-supplied tag recorded on the result only — never used to decide
 * what gets computed.
 *
 * ALWAYS FULLY RECOMPUTES. There is no incremental "just the affected
 * subtree" mode — the whole graph is single-digit milliseconds at this size
 * (27 linked materials today), so a partial walk would be a second, subtly
 * different code path for a problem the full recompute already solves for
 * free. This is also what makes the safety story simple: a recompute never
 * depends on what triggered it, so there is no way for a caller to hand it a
 * wrong or partial view of the graph, and no "walked the wrong direction"
 * bug is even expressible — topoOrder always runs the same dependency-first
 * walk regardless of which edge changed.
 *
 * REFUSES ON A CYCLE — writes nothing, returns applied:false. This should
 * never happen in production: routes/recipes.js's save-time checkCycle()
 * guard exists precisely to keep a cycle from ever reaching the database.
 * This is the backstop, not a place to invent an order.
 *
 * THROWS if an update does not touch exactly one row — the same integrity
 * check scripts/rollup_made_material_costs.js uses. The compound
 * `WHERE id = ? AND source_recipe_id = ?` match is what makes a write
 * structurally safe against landing on the wrong row or a raw ingredient:
 * a plan entry can only match the exact (ingredient, recipe) pair it was
 * computed for. It can never match an unlinked ingredient (source_recipe_id
 * IS NULL never equals a recipe id), and if the pair no longer holds — the
 * material was unlinked or relinked between planning and writing, which
 * cannot happen mid-transaction but is checked anyway — this throws rather
 * than silently no-op-ing or hitting an unrelated row.
 *
 * better-sqlite3 nests db.transaction() calls as SAVEPOINTs, so this is safe
 * to call standalone or from inside a caller's own already-open transaction
 * (routes/admin.js repair-items does the latter) — either way, a failure
 * here rolls back only this pass's own writes, never the caller's.
 *
 * Returns { applied, written, blocked, cycle, trigger }.
 */
function applyRollup(db, trigger) {
  let result;
  const run = db.transaction(() => {
    const plan = planRollup(db);
    if (plan.cycle.length) {
      result = { applied: false, reason: 'cycle', written: 0, blocked: plan.blocked.length, cycle: plan.cycle, trigger: trigger || null };
      return;
    }
    const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_recipe_id = ?');
    for (const c of plan.changes) {
      const r = upd.run(c.newCpu, c.ingredient_id, c.recipe_id);
      if (r.changes !== 1) {
        throw new Error(`recompute: expected to update exactly 1 row for ingredient #${c.ingredient_id} (${c.name}) linked to recipe #${c.recipe_id}, matched ${r.changes}`);
      }
    }
    // Retail products come LAST, and inside the same transaction, so a product
    // whose recipe consumes a made material is costed against that material's
    // just-written figure rather than the stale one. Reads inside a transaction
    // see its own writes, so no override map is needed at this level.
    const products = applyProductCosts(db);
    result = {
      applied: true, written: plan.changes.length, blocked: plan.blocked.length,
      cycle: [], trigger: trigger || null,
      productsWritten: products.written, productsBlocked: products.blocked,
      productsSkippedProductionOff: products.skippedProductionOff,
    };
  });
  run();
  return result;
}

/**
 * Does a recipe own this product's unit_cost right now?
 *
 * THE ONE PLACE THAT ANSWERS "WHICH SOURCE WINS". Purchase-order receiving, the
 * editor's read-only state and the PATCH guard all ask this, so they cannot
 * drift apart and start disagreeing about who owns a figure.
 *
 * True only when BOTH hold: the product names a recipe, and Production is on.
 * With Production off the answer is false, which is what hands the row back to
 * the purchase-order fill and manual entry — the previous behaviour, intact.
 */
function recipeOwnsProductCost(db, productId) {
  try {
    const row = db.prepare('SELECT recipe_id FROM store_products WHERE id = ?').get(productId);
    if (!row || row.recipe_id == null) return false;
    return require('./features').productionEnabled(db);
  } catch (e) { return false; }
}

// Every active retail product taking its cost from a recipe.
function loadLinkedProducts(db) {
  try {
    return db.prepare(`
      SELECT id, name_en, sku, unit_cost, recipe_id
        FROM store_products
       WHERE recipe_id IS NOT NULL AND COALESCE(is_active,1) = 1
       ORDER BY id
    `).all();
  } catch (e) { return []; }   // handle without a storefront — nothing to cost
}

/**
 * Write store_products.unit_cost for every recipe-linked product.
 *
 * THE FIGURE IS costPerServing — one serving is one sellable unit. That is why
 * a repack works without special-casing: its recipe carries servings = 1 and a
 * batch_size equal to the pack weight, so costPerServing IS the cost of one
 * pack.
 *
 * BLOCKED WRITES NOTHING, NEVER 0 OR NULL. Same rule as the material pass one
 * level down: a recipe with no cost row, no servings, or an unpriced line
 * leaves the product's existing figure untouched rather than replacing a real
 * cost with a confident zero. A product that has never been costed simply stays
 * null, which the margin column already renders as an em dash.
 *
 * PRODUCTION OFF STOPS UPDATES, IT DOES NOT ERASE. When the tenant's Production
 * switch is off this writes nothing at all — the last known figure stays on the
 * row and simply stops tracking the recipe. Nothing is nulled on toggle, which
 * is the whole point: flipping a switch must not destroy costing history.
 *
 * NO LOOP IS POSSIBLE HERE, AND IT IS WORTH SAYING WHY. A product is a LEAF —
 * nothing consumes it, so it can never feed a recipe and cannot extend the
 * dependency graph the topological pass walks. This write also touches only
 * `unit_cost`, which no trigger point watches, so it cannot re-enter the
 * cascade. The one full pass per call already guarantees at most one write per
 * product; the value check below makes a re-fire in the same request a no-op
 * rather than a second identical write, the same way the bundle re-push dedupe
 * compares the quantity rather than merely the target.
 */
function applyProductCosts(db) {
  const { productionEnabled } = require('./features');
  const rows = loadLinkedProducts(db);
  if (!rows.length) return { written: 0, blocked: 0, skippedProductionOff: 0 };
  if (!productionEnabled(db)) return { written: 0, blocked: 0, skippedProductionOff: rows.length };

  const upd = db.prepare('UPDATE store_products SET unit_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND recipe_id = ?');
  let written = 0, blocked = 0;
  for (const p of rows) {
    let c = null;
    try { c = computeRecipeCost(p.recipe_id, db); } catch (e) { c = null; }
    const next = c && c.costPerServing != null && Number.isFinite(c.costPerServing) && c.costPerServing > 0
      ? c.costPerServing : null;
    if (next === null) { blocked++; continue; }
    if (p.unit_cost != null && Math.abs(Number(p.unit_cost) - next) < 1e-9) continue;
    // Compound match, mirroring the material write above: a row can only be
    // updated by the exact (product, recipe) pair this figure was computed for.
    const r = upd.run(next, p.id, p.recipe_id);
    if (r.changes !== 1) {
      throw new Error(`recompute: expected to update exactly 1 row for product #${p.id} (${p.name_en}) linked to recipe #${p.recipe_id}, matched ${r.changes}`);
    }
    written++;
  }
  return { written, blocked, skippedProductionOff: 0 };
}

// Fire-and-log wrapper for applyRollup, meant for route handlers: recompute
// is a consistency-maintenance pass, not the reason the request exists, so a
// failure here must never turn an otherwise-successful save into a 500 — it
// is logged loudly instead. Mirrors how routes/purchases.js already treats
// its own secondary effects (_firePOPush, _broadcastPO): report failure by
// console.error, not by rejecting the caller's response.
function fireRecompute(db, trigger) {
  try {
    return applyRollup(db, trigger);
  } catch (e) {
    console.error(`[recipe-rollup] recompute failed (trigger=${JSON.stringify(trigger)}):`, e.message);
    return { applied: false, reason: 'error', error: e.message, trigger: trigger || null };
  }
}

// Does this recipe back a source_recipe_id-linked material? The cheap
// existence check the recipe-save trigger points use to skip calling
// applyRollup on a save that cannot possibly move a linked-material cost —
// an ordinary recipe that nothing points at.
function backsLinkedMaterial(db, recipeId) {
  return !!db.prepare('SELECT 1 FROM ingredients WHERE source_recipe_id = ? LIMIT 1').get(recipeId);
}

// The same cheap check for a retail PRODUCT that takes its cost from this
// recipe. Separate from the material check because the two links live in
// different tables and either one alone is reason enough to recompute.
function backsLinkedProduct(db, recipeId) {
  try {
    return !!db.prepare('SELECT 1 FROM store_products WHERE recipe_id = ? AND COALESCE(is_active,1) = 1 LIMIT 1').get(recipeId);
  } catch (e) { return false; }   // table absent on a handle that has no storefront
}

// What the recipe-save trigger points actually want to know: does anything at
// all take its cost from this recipe? WIDENING backsLinkedMaterial WAS THE
// POINT — before this, a recipe that fed only a product matched no guard, so a
// save on it skipped the recompute entirely and the product's cost never moved.
function backsAnyCostedRow(db, recipeId) {
  return backsLinkedMaterial(db, recipeId) || backsLinkedProduct(db, recipeId);
}

module.exports = {
  loadLinkedMaterials, linesFor, buildSourceGraph, topoOrder,
  costOneRecipe, planRollup, applyRollup, fireRecompute,
  backsLinkedMaterial, backsLinkedProduct, backsAnyCostedRow, recipeOwnsProductCost,
  loadLinkedProducts, applyProductCosts,
};
