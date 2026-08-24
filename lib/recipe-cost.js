// Recipe cost breakdown — the ONE derivation, shared by the server and the
// browser the same way lib/ingredient-cost.js is.
//
// WHY THIS EXISTS
// ---------------
// `recipe_cost_data` stores only the MANUAL inputs — labour, packaging,
// overhead_pct, sell_price, target_food_cost. It holds no cost column of any
// kind. Every actual cost figure (ingredient subtotal, batch cost, per serving,
// per gram, margin, food cost %) is derived on read, and that derivation used
// to exist in five separate copies:
//
//   lib/recipe-cost.js  computeRecipeCost()      this file, export route only
//   public/app.html     viewRecipe()             ~:6483  recipe detail card
//   public/app.html     showCostSheet/renderCS   ~:7660  Cost Sheet, first paint
//   public/app.html     csUpdate()               ~:7970  Cost Sheet, live retype
//   public/app.html     _loadProductCtx()        ~:9653  product card — DEAD, its
//                                                result was never read by any
//                                                renderer
//
// Four of those are now gone: viewRecipe(), renderCS() and csUpdate() call this
// file over HTTP, and the export route requires it. Two readers remain outside
// it, both deliberately:
//
//   * routes/waste.js computeProductCost() — EXCLUDES packaging, because
//     packaging is reused when a finished unit is wasted, and falls back to
//     sell_price when a recipe cannot produce a cost. Folding it onto this
//     module is a separate, clearly-labelled change (it also does not yet read
//     free_by_design, which every reader here does).
//   * _loadProductCtx()'s dead block, removed in that same later change rather
//     than ported — see above.
//
// THE FORMULA IS COPIED, NOT REDESIGNED
// -------------------------------------
// Every line below mirrors what renderCS() computed before it was swapped onto
// this file, including its quirks. Two are worth naming so a later reader does
// not "fix" them and silently move a number on a screen Roots reads daily:
//
//   * `parseFloat(cd.target_food_cost || 30)` — a STORED target of 0 becomes
//     30, because `0 || 30` is 30. Preserved deliberately.
//   * An ingredient line whose master cost is 0 or null contributes NOTHING to
//     the subtotal and is counted as a missing cost instead. It is not treated
//     as a genuine zero.
//
// A CALLER MUST HAND THIS FILE NUMBERS, NOT DOM STRINGS
// -----------------------------------------------------
// The `|| 30` quirk above is why. A costData carrying the STRING '0' takes a
// different branch from the NUMBER 0: `'0' || 30` is `'0'` (a non-empty string
// is truthy) and parses to 0, while `0 || 30` is 30. csUpdate() reads live form
// inputs, which are always strings, so it coerces each field with its own
// `parseFloat(...)||fallback` at the DOM boundary and passes the resulting
// numbers in. Hand a raw `input.value` to this function and a zeroed target
// food cost will silently mean something different here than it does on the
// stored row.
//
// NO WRITES, NO DB REQUIRED. The id-form takes a database handle; the
// rows-form is pure. Either way this module only ever reads.

'use strict';

// One ingredient line's contribution. Mirrors app.html:7511-7516 — a line whose
// master cost is not > 0 yields a null lineCost and is counted as missing,
// rather than adding 0 to the subtotal.
function buildLines(ingredients) {
  let ingredientCost = 0;
  let zeroCostLines = 0;
  const lines = (ingredients || []).map((i) => {
    const costPerUnit = i.master_cost || 0;
    const qty = parseFloat(i.qty) || 0;
    // An item marked free by design costs a real zero. It adds nothing to the
    // subtotal and — the point of the flag — is NOT counted as a missing cost,
    // so water in 26 recipes stops crying wolf over the one that matters.
    const isFree = !!i.master_free;
    const lineCost = isFree ? 0 : (costPerUnit > 0 ? qty * costPerUnit : null);
    if (lineCost === null) zeroCostLines++;
    else ingredientCost += lineCost;
    return {
      ingredient_id: i.ingredient_id == null ? null : i.ingredient_id,
      name: i.name_en || i.master_name_en || '',
      name_cn: i.name_cn || null,
      sku: i.sku || null,
      qty,
      unit: i.unit || '',
      costPerUnit,
      lineCost,
      freeByDesign: isFree,
    };
  });
  return { lines, ingredientCost, zeroCostLines };
}

// The three statements the id-form uses. Kept identical to the ones
// GET /api/recipes/:id already runs (routes/recipes.js:57-61) so the export
// cannot diverge from what the Cost Sheet is fed.
const SQL_RECIPE = 'SELECT * FROM recipes WHERE id = ?';
const SQL_INGREDIENTS = `SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
         i.free_by_design AS master_free,
         i.name_en AS master_name_en
    FROM recipe_ingredients ri
    LEFT JOIN ingredients i ON ri.ingredient_id = i.id
   WHERE ri.recipe_id = ?
   ORDER BY ri.sort_order`;
const SQL_COST = 'SELECT * FROM recipe_cost_data WHERE recipe_id = ?';

/**
 * Full cost breakdown for one recipe.
 *
 * Two call shapes:
 *   computeRecipeCost(42, db)
 *       loads the recipe, its ingredient lines and its cost row through `db`
 *       (which MUST be a seamed handle — see lib/db-seam.js).
 *
 *   computeRecipeCost({ recipe, ingredients, costData })
 *       uses rows the caller already has. This is what the export uses: it
 *       reads all 85 recipes in three queries instead of 255.
 *
 * `costData` may be null/undefined — a recipe with no `recipe_cost_data` row.
 * In that case labour, packaging, overhead_pct and sell_price are all treated
 * as 0, target_food_cost falls back to its schema default of 30, and
 * `hasCostRow` on the result is false.
 *
 * Returns null only when an id was given and no such recipe exists.
 */
function computeRecipeCost(input, db) {
  let recipe;
  let ingredients;
  let costData;

  if (input !== null && typeof input === 'object') {
    recipe = input.recipe;
    ingredients = input.ingredients || [];
    costData = input.costData;
  } else {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[recipe-cost] a database handle is required when called with a recipe id');
    }
    recipe = db.prepare(SQL_RECIPE).get(input);
    if (!recipe) return null;
    ingredients = db.prepare(SQL_INGREDIENTS).all(recipe.id);
    costData = db.prepare(SQL_COST).get(recipe.id);
  }
  if (!recipe) return null;

  const hasCostRow = !!costData;
  const cd = costData || {};

  const { lines, ingredientCost, zeroCostLines } = buildLines(ingredients);

  // ── renderCS() app.html:7522-7533, line for line ────────────────────────
  const labour = parseFloat(cd.labour || 0);
  const packaging = parseFloat(cd.packaging || 0);
  const overheadPct = parseFloat(cd.overhead_pct || 0);
  const sellPrice = parseFloat(cd.sell_price || 0);
  const servings = parseFloat(recipe.servings || 0);

  // Packaging is a PER SERVING figure. With no servings recorded it is counted
  // once rather than dropped — the `servings>0?servings:1` in the original.
  const packagingTotal = packaging * (servings > 0 ? servings : 1);
  const overheadAmount = ingredientCost * overheadPct / 100;
  const batchCost = ingredientCost + labour + packagingTotal + overheadAmount;

  const costPerServing = servings > 0 ? batchCost / servings : null;
  const batchSize = parseFloat(recipe.batch_size) || 0;
  const costPerGram = batchSize > 0 ? batchCost / batchSize : null;

  const marginPerServing = sellPrice > 0 && costPerServing !== null ? sellPrice - costPerServing : null;
  const foodCostPct = sellPrice > 0 && costPerServing !== null ? costPerServing / sellPrice * 100 : null;

  const targetFoodCost = parseFloat(cd.target_food_cost || 30);
  const suggestedSellPrice = costPerServing !== null && targetFoodCost > 0
    ? costPerServing / (targetFoodCost / 100)
    : null;

  return {
    recipe_id: recipe.id,
    hasCostRow,
    costDataUpdatedAt: cd.updated_at || null,

    // Recipe identity, so a caller holding only this object can label a row.
    sku: recipe.sku || null,
    name_en: recipe.name_en || '',
    name_cn: recipe.name_cn || null,
    category: recipe.category || null,
    servings,
    batchSize,

    // Ingredients
    ingredientCost,
    ingredientLines: lines.length,
    zeroCostIngredientLines: zeroCostLines,
    lines,

    // Stored inputs
    labour,
    packaging,
    packagingTotal,
    overheadPct,
    overheadAmount,
    sellPrice,
    targetFoodCost,

    // Derived
    batchCost,
    costPerServing,
    costPerGram,
    marginPerServing,
    foodCostPct,
    suggestedSellPrice,
  };
}

const API = { computeRecipeCost };

// Two loaders, one file — the same contract lib/ingredient-cost.js keeps. Node
// requires it (the Excel export route, diagnostics). The recipe detail card and
// the Cost Sheet fetch it from /lib/recipe-cost.js and read it off window —
// served with no-store, and skipped by the service worker, because a phone
// running yesterday's money formula against today's server is the failure this
// arrangement exists to prevent. No bundler, and deliberately no second copy:
// four hand-maintained copies of this maths is what let a product card compute
// a cost nobody could see and a waste figure ignore a flag every other screen
// honoured.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
// globalThis rather than a bare `window`, so the file stays valid Node source
// (and lints as such) while still publishing itself in a browser.
if (typeof globalThis !== 'undefined' && globalThis.window) globalThis.window.RootsRecipeCost = API;
