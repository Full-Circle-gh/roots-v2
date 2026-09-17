'use strict';

/**
 * `recipes:costs` — what a recipe payload looks like for a caller who may not
 * read money. §164 and its addendum (Ash, 2026-09-17).
 *
 * EXTRACTED FROM THE ROUTE, like lib/product-cost-visibility.js beside it, so
 * the rules can be held to a contract without standing up a database. The four
 * read sites and the one write site in routes/retail-recipes.js call exactly
 * these functions.
 *
 * THE THREE RULES ARE THE ONES routes/retail-waste.js AND routes/retail-materials.js
 * ALREADY FOLLOW, deliberately, so all three read alike:
 *
 *   - FAILS CLOSED. Everywhere else a null cap set means "unknown, allow";
 *     money inverts that trade. req.caps is null only when resolveOperator
 *     threw, which is already a degraded request.
 *   - Keys are DELETED, not zeroed. A cost of 0 reads as free, and this
 *     screen's whole point is not looking free.
 *   - A FIELD is refused, never a request — on the READS. The cost WRITE is the
 *     one exception and it 403s, because every column it writes is money and a
 *     caller without the capability has nothing legitimate to say there.
 */

// ── The gate ────────────────────────────────────────────────────────────────
function canSeeCosts(req) {
  return !!(req && req.caps && req.caps.has && req.caps.has('recipes:costs'));
}

// ── The computed cost object ────────────────────────────────────────────────
//
// ALLOW-LISTED, NOT DENY-LISTED, and it is the one shape here that differs in
// kind. Every other shape is built in the route, in sight, so a `delete` beside
// its construction stays honest. This one comes out of lib/recipe-cost.js's
// computeRecipeCost() with thirty-odd keys, fifteen of them money, and it grows:
// `materialCostPerGram` and `embeddedOverhead` were both added after the first
// of them. A deny-list is a list of the money keys that existed on the day it
// was written, and the next one leaks silently.
//
// PERCENTAGES GO WITH THE AMOUNTS. `foodCostPct`, `overheadPct` and
// `targetFoodCost` print no currency sign and are still facts about cost — a
// food-cost percentage against a known sell price IS the cost. The Trend screen
// made the same call for share-of-revenue: the gate is about money rather than
// about the currency sign.
//
// THE THREE COUNTS STAY. `ingredientLines`, `zeroCostIngredientLines` and
// `unreconciledUnitLines` carry a count and a cause, never an amount, and they
// are what make a fault fixable by whoever is looking at it. Hiding those is how
// a fault stays unfixed — the call 18-materials.js makes in the same words.
const COST_FACTS_WITHOUT_MONEY = [
  'recipe_id', 'hasCostRow', 'costDataUpdatedAt',
  'sku', 'name_en', 'name_cn', 'category',
  'servings', 'batchSize', 'batchSizeAuto', 'servingsAuto', 'servingsLeftover', 'yield',
  'ingredientLines', 'zeroCostIngredientLines', 'unreconciledUnitLines',
];

function stripCostObject(cost) {
  if (!cost || typeof cost !== 'object') return cost;
  const out = {};
  for (const k of COST_FACTS_WITHOUT_MONEY) if (k in cost) out[k] = cost[k];
  return out;
}

// ── A list row ──────────────────────────────────────────────────────────────
// The two counts stay for the reason above: the list paints a warning triangle
// off them, and that triangle is the only thing telling anyone a cost is
// understated.
function stripListRow(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.batchCost;
  delete out.costPerServing;
  delete out.costPerGram;
  if (out.backsMaterial) {
    out.backsMaterial = { ...out.backsMaterial };
    delete out.backsMaterial.cost_per_unit;
  }
  return out;
}

// ── An ingredient line ──────────────────────────────────────────────────────
// `master_cost` is the material's own rate, joined in by the route's queries.
// The line's qty, unit and notes are not money and stay, because they are the
// recipe.
function stripLine(l) {
  if (!l) return l;
  const out = { ...l };
  delete out.master_cost;
  return out;
}

// ── A product this recipe makes ─────────────────────────────────────────────
// SELL PRICE SURVIVES. It is what a customer is charged, it is on the shopfront
// and the receipt, and it is not what this capability withholds. `unit_cost` is
// the recipe's cost wearing the product's name, so it goes — and without it the
// client cannot compute the margin, which is the same split
// lib/product-cost-visibility.js already makes.
function stripProduct(p) {
  if (!p) return p;
  const out = { ...p };
  delete out.unit_cost;
  return out;
}

module.exports = {
  canSeeCosts, stripCostObject, stripListRow, stripLine, stripProduct,
  COST_FACTS_WITHOUT_MONEY,
};
