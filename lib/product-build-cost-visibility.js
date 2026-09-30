'use strict';

/**
 * Who may read the money on a product's BUILD LIST, and on the recipe link's
 * answer — §300 step R7 (Ash: "yes , and keep going until you finish all .I
 * approve all").
 *
 * TWO CAPABILITIES, BECAUSE THE PAYLOAD CARRIES TWO KINDS OF MONEY.
 *   - `products:costs` — what the PRODUCT costs us: `unit_cost`, and the build
 *     list's computed total (`cost.unitCost`, `cost.ingredientCost`). The same
 *     key lib/product-cost-visibility.js strips `unit_cost` on everywhere else
 *     a product is read.
 *   - `materials:costs` — what a MATERIAL costs: the rate and the buy price
 *     joined onto each line (`material_cost_per_unit`, `material_buy_price`),
 *     the rate on the recipe bridge's material and on each picker row
 *     (`cost_per_unit`, `buy_price`), and the per-line figures in the computed
 *     cost (`costPerUnit`, `lineCost`). The same key routes/retail-materials.js
 *     strips those two columns on.
 * Both screens that read these routes already draw them on exactly these keys
 * (the phone's §300 R6 Cost & Pricing; the desktop's product editor hides its
 * cost block on products:costs). Until now the wire sent them regardless.
 *
 * THE RULES ARE lib/recipe-cost-visibility.js's, COPIED, NOT RE-DECIDED:
 *   - FAILS CLOSED. req.caps is null only when resolveOperator threw, which is
 *     already a degraded request; money inverts the usual "unknown, allow".
 *     The owner, and a tenant with enforcement off, resolve to a cap set that
 *     holds both keys (lib/operator-caps.js) and so read everything, exactly
 *     as they read a recipe's cost.
 *   - Keys are DELETED, never zeroed. A rate of 0 reads as free.
 *   - A FIELD is refused, never a request. Nobody is 403'd for lacking these.
 *   - The computed cost object is ALLOW-LISTED, for the reason recipe-cost-
 *     visibility gives: it comes out of a library and grows, and a deny-list
 *     is a list of the money keys that existed on the day it was written.
 *
 * A HOLDER OF BOTH GETS THE PAYLOAD UNTOUCHED — the same object, not a copy —
 * so what they receive is byte-identical to before this existed.
 *
 * THE SAVE READS NO MONEY. PUT /products/:id/build-lines writes ingredient,
 * names, SKU, qty, unit, notes and the kept flag; the cost is written by the
 * server's own recompute from the materials table. So a non-holder's save,
 * which never received a rate, cannot blank one — there is nothing on the
 * write side to strip, and this module has no write half.
 */

function canSeeProductCosts(req) {
  return !!(req && req.caps && typeof req.caps.has === 'function' && req.caps.has('products:costs'));
}
function canSeeMaterialCosts(req) {
  return !!(req && req.caps && typeof req.caps.has === 'function' && req.caps.has('materials:costs'));
}

// ── The computed cost object (lib/product-build-cost.js) ────────────────────
// The COUNTS AND CAUSES stay for everyone: they say a list is blocked and why,
// never by how much, and they are what makes the fault fixable by whoever is
// looking (the reason recipe-cost-visibility keeps its three counts).
const BUILD_COST_FACTS_WITHOUT_MONEY = [
  'hasBuildList', 'ingredientLines', 'zeroCostLines', 'unreconciledUnitLines', 'packagingOnly',
];
const BUILD_COST_PRODUCT_MONEY = ['unitCost', 'ingredientCost'];
// A computed line (lib/recipe-cost.js buildLines) without its two figures.
const BUILD_COST_LINE_MONEY = ['costPerUnit', 'lineCost'];

function stripBuildCostObject(cost, prod, mat) {
  if (!cost || typeof cost !== 'object') return cost;
  const out = {};
  for (const k of BUILD_COST_FACTS_WITHOUT_MONEY) if (k in cost) out[k] = cost[k];
  if (prod) for (const k of BUILD_COST_PRODUCT_MONEY) if (k in cost) out[k] = cost[k];
  if ('lines' in cost) {
    out.lines = Array.isArray(cost.lines)
      ? cost.lines.map((l) => {
        if (mat || !l || typeof l !== 'object') return l;
        const o = { ...l };
        for (const k of BUILD_COST_LINE_MONEY) delete o[k];
        return o;
      })
      : cost.lines;
  }
  return out;
}

// ── A stored build line, as GET /build-lines joins it ───────────────────────
function stripBuildLine(l) {
  if (!l || typeof l !== 'object') return l;
  const out = { ...l };
  delete out.material_cost_per_unit;
  delete out.material_buy_price;
  return out;
}

// ── A material row (the recipe bridge's, and the picker's) ──────────────────
function stripMaterialRow(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  delete out.cost_per_unit;
  delete out.buy_price;
  return out;
}

// ── GET /api/retail-admin/products/:id/build-lines — the whole `data` ───────
function stripBuildPayload(req, data) {
  const prod = canSeeProductCosts(req), mat = canSeeMaterialCosts(req);
  if ((prod && mat) || !data || typeof data !== 'object') return data;
  const out = { ...data };
  if (!prod) delete out.unit_cost;
  if (!mat && Array.isArray(out.lines)) out.lines = out.lines.map(stripBuildLine);
  if ('cost' in out) out.cost = stripBuildCostObject(out.cost, prod, mat);
  if (!mat && out.recipe && typeof out.recipe === 'object' && out.recipe.material) {
    out.recipe = { ...out.recipe, material: stripMaterialRow(out.recipe.material) };
  }
  return out;
}

// ── GET /api/retail-admin/product-build/materials — the picker's rows ───────
function stripPickerRows(req, rows) {
  if (canSeeMaterialCosts(req) || !Array.isArray(rows)) return rows;
  return rows.map(stripMaterialRow);
}

// ── A product row answered by a write (PUT build-lines) ─────────────────────
// `unit_cost` is the one money key those rows carry. The recipe-link routes in
// routes/retail.js use lib/product-cost-visibility.js's stripProductCosts for
// the same job, since that file already requires it.
function stripProductRow(req, row) {
  if (canSeeProductCosts(req) || !row || typeof row !== 'object') return row;
  const out = { ...row };
  delete out.unit_cost;
  return out;
}

module.exports = {
  canSeeProductCosts, canSeeMaterialCosts,
  stripBuildPayload, stripBuildCostObject, stripBuildLine, stripMaterialRow, stripPickerRows, stripProductRow,
  BUILD_COST_FACTS_WITHOUT_MONEY,
};
