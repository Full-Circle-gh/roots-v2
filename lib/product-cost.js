// A product's unit cost — THE ONE READER, and the one place to change it.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// Today a product's unit cost is a single stored column, `store_products.unit_cost`,
// in REAL yuan. Three writers fill it — purchase-order receiving
// (routes/retail-purchasing.js), the product editor by hand (routes/retail.js),
// and the recipe rollup (lib/recipe-rollup.js applyProductCosts) — and every
// reader up to now has done its own inline `SELECT unit_cost`.
//
// That is fine while the answer is one column. It stops being fine the moment
// §31 is built: `docs/tacet-consolidation-decisions.md` §31 rule 1 settles that
// A PRODUCT'S UNIT COST IS ITS CONTENTS PLUS ITS PACKAGING, and rule 3 that a
// product carries a LIST of packaging materials rather than one. When that
// lands, "what does this product cost" becomes a derivation over several rows,
// and every inline SELECT becomes a reader that quietly reports the contents
// half as the whole figure.
//
// So waste reads its cost through here rather than inlining a fourth copy. When
// §31 is built, this function changes and its callers do not. It is deliberately
// NOT a re-implementation of anything — there is no calculation here to get
// wrong yet, and when there is one it belongs to §31's own module, which this
// will call.
//
// WHAT COUNTS AS "NO COST", AND WHY ZERO DOES
// -------------------------------------------
// Returns null when the figure is absent, unparseable, or not greater than
// zero. A stored zero reads as absent ON PURPOSE, for the reason §32 rule 10
// gives: a loss nobody could price and a loss that genuinely cost nothing must
// not render identically, and today's `unit_cost` cannot tell them apart — the
// column has no "deliberately free" marker, which is the same unknown-vs-zero
// fault §31 rule 9 records against packaging. Treating zero as unknown is the
// direction that flags the row instead of silently reporting a loss of ¥0.
//
// It also mirrors what the recipe derivation already does with an unpriced
// ingredient line (`lib/recipe-cost.js` — a master cost not > 0 yields null and
// is counted as MISSING rather than added as a real zero), so the two agree.
//
// NO WRITES. A pure read through the handle it is given, which must be the
// request's tenant connection (tdb()) — never the global handle, or a non-Roots
// tenant reads Roots' catalogue.

'use strict';

/**
 * Unit cost for one product, in YUAN, or null when it cannot be established.
 *
 * @param {object} db   a tenant connection (tdb()), or any handle with .prepare
 * @param {number} storeProductId  store_products.id — NOT the kitchen products.id
 * @returns {number|null} yuan per unit, strictly > 0, or null
 */
function productUnitCostYuan(db, storeProductId) {
  if (!storeProductId) return null;
  const row = db.prepare('SELECT unit_cost FROM store_products WHERE id = ?').get(storeProductId);
  if (!row || row.unit_cost == null) return null;
  const v = Number(row.unit_cost);
  return Number.isFinite(v) && v > 0 ? v : null;
}

module.exports = { productUnitCostYuan };
