// Product build cost — a product's unit cost from its build list.
// docs/tacet-product-build-lines-design.md §2, Step 2 of the build. Sibling
// to lib/recipe-cost.js, sharing its buildLines() rather than duplicating it
// (recipe-cost.js exports it precisely for this).
//
// WHY THIS IS NOT computeRecipeCost() WITH A DIFFERENT TABLE NAME
// -----------------------------------------------------------------
// computeRecipeCost() divides a whole batch down to one serving:
// batchCost / servings. A build list already describes ONE SELLABLE UNIT —
// the design doc's own worked example is "250g Zhoug + 1 box + 1 label", not
// a batch that makes 46 jars — so there is no servings/batch_size division
// step at all. unitCost is the flat sum of qty × costPerUnit across the
// list. This is a genuine simplification, not a gap: computeRecipeCost's
// labour/packaging/overhead_pct/servings/target_food_cost inputs have no
// build-list equivalent, because a build list is not a recipe.
//
// unitCost IS THE PRODUCT'S OWN COST SOURCE, PER §31's ADDENDUM
// -----------------------------------------------------------------
// (docs/tacet-consolidation-decisions.md, "a build line is the product's
// only cost source"). Once a product has build lines, this is what feeds
// store_products.unit_cost — see lib/recipe-rollup.js's
// applyProductBuildCosts(). recipe_id is not consulted here or anywhere
// else for that product's cost; Step 4 is what turns off the other writer.
//
// NULL MEANS UNKNOWN, NEVER ZERO — the same discipline
// lib/ingredient-cost.js and lib/recipe-cost.js both hold. A build list with
// any unpriced or unreconciled line is BLOCKED as a whole (unitCost: null),
// the same all-or-nothing rule lib/recipe-rollup.js's costOneRecipe()
// already applies to a materialized recipe: a confidently-low number missing
// one line's contribution is worse than a plain "unknown", because low reads
// as plausible.
//
// NO WRITES, NO DB REQUIRED. The id-form takes a database handle; the
// rows-form is pure. Either way this module only ever reads.

'use strict';

const { buildLines } = require('./recipe-cost');

const SQL_LINES = `SELECT pbl.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
       i.free_by_design AS master_free, i.name_en AS master_name_en
  FROM product_build_lines pbl
  LEFT JOIN ingredients i ON pbl.ingredient_id = i.id
 WHERE pbl.product_id = ?
 ORDER BY pbl.sort_order`;

/**
 * A product's cost from its build list.
 *
 * Two call shapes, matching computeRecipeCost():
 *   computeProductBuildCost(5, db)         loads product_build_lines through
 *                                          `db` (a seamed handle — see
 *                                          lib/db-seam.js).
 *   computeProductBuildCost({ lines })     uses rows the caller already has.
 *
 * Returns { hasBuildList, unitCost, ingredientCost, ingredientLines,
 *   zeroCostLines, unreconciledUnitLines, lines }.
 *
 * hasBuildList is false only when the product has no build_lines rows at
 * all — a genuinely different fact from unitCost being null (a build list
 * exists but is currently blocked). A caller distinguishing "never built"
 * from "built but broken" needs both.
 */
function computeProductBuildCost(input, db) {
  let lines;
  if (input !== null && typeof input === 'object') {
    lines = input.lines || [];
  } else {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[product-build-cost] a database handle is required when called with a product id');
    }
    lines = db.prepare(SQL_LINES).all(input);
  }

  if (!lines.length) {
    return {
      hasBuildList: false, unitCost: null, ingredientCost: 0,
      ingredientLines: 0, zeroCostLines: 0, unreconciledUnitLines: 0, lines: [],
    };
  }

  const { lines: built, ingredientCost, zeroCostLines, unreconciledUnitLines } = buildLines(lines);
  const blocked = zeroCostLines > 0 || unreconciledUnitLines > 0;

  return {
    hasBuildList: true,
    // A real zero (every line free_by_design) is a genuine cost, not an
    // unknown — only a BLOCKED list reads as null. See buildLines() in
    // recipe-cost.js for the free-vs-missing distinction this rests on.
    unitCost: blocked ? null : ingredientCost,
    ingredientCost,
    ingredientLines: built.length,
    zeroCostLines,
    unreconciledUnitLines,
    lines: built,
  };
}

const API = { computeProductBuildCost };

// Node only for now. lib/ingredient-cost.js and lib/recipe-cost.js both
// publish to the browser too, because a live screen reads their maths on
// every keystroke — Step 3 (the build-list screen) is a separate PR with no
// code here yet, so there is no browser caller to keep in sync with. Add the
// globalThis.window publish and the no-store/service-worker-skip route
// wiring when that screen actually needs it, not before.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
