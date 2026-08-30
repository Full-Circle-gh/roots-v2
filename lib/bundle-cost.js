// A bundle product's unit cost — the sum of what is inside it.
//
// WHY THIS FILE EXISTS
// --------------------
// A roots BUNDLE (combo, set meal — one concept, three words) is a normal
// store_products row whose `bundle_items` JSON lists the component products it
// is made of, [{id, qty}] per sellable unit. See the block comment at the head
// of lib/bundle-stock.js for the full shape; this module is its cost sibling
// and reads the same recipe through the same parser.
//
// Every OTHER cost source a product can have already derives its figure:
// a recipe-linked product gets costPerServing (lib/recipe-rollup.js
// applyProductCosts), a product with a build list gets the sum of its lines
// (lib/product-build-cost.js). A bundle had NEITHER. Its unit_cost was a
// hand-typed column that nothing derived and nothing corrected — blank on
// every bundle in the live catalogue — so the Products list showed an em dash
// in Margin for a product whose cost is fully knowable from rows we already
// hold, and waste on a bundle priced at nothing.
//
// The arithmetic is the one the design already implies and that
// decorateBundleRow() (routes/retail.js) has always used for the "if bought
// separately" worth badge, with cost substituted for price:
//
//     unit cost = Σ over components of  qty × that component's unit cost
//
// There is no batch, no servings division and no packaging term: a bundle's
// recipe already describes ONE sellable unit, exactly as a build list does.
//
// ALL OR NOTHING — A PARTIAL SUM IS NEVER PUBLISHED
// -------------------------------------------------
// If any single component has no cost, this returns null and the bundle shows
// blank. That is the same all-or-nothing rule computeProductBuildCost() holds
// for an unpriced build line and costOneRecipe() holds for an unpriced
// ingredient, and it is held here for the same reason: a sum missing one
// component's contribution is CONFIDENTLY LOW, and low reads as plausible. A
// three-item gift box costed off the two components that happen to have been
// received would report a margin nobody could tell was wrong. Blank is the
// honest answer, and it is one the screen already renders (an em dash).
//
// WHAT COUNTS AS "NO COST" is decided in exactly one place — the > 0 test in
// lib/product-cost.js's productUnitCostYuan(), which this calls rather than
// re-implementing. A stored zero reads as unknown there, for the reason §32
// rule 10 gives, and so it does here.
//
// A PREPACKED BUNDLE IS OUT OF SCOPE, AND NOT BY OVERSIGHT. `bundle_mode`
// distinguishes 'assembled' (made from components at pick time) from
// 'prepacked' (bought or packed ahead, its own counted stock), and the editor
// only ever saves `bundle_items` for the assembled mode (bpBody(),
// public/retail-admin/09-products.js). A prepacked set therefore has no
// component list to sum, and its cost stays what it always was: the
// purchase-order fill or the operator's own figure. Carrying a component list
// is the whole test, here as in lib/bundle-stock.js.
//
// NO WRITES. A pure read through the handle it is given, which must be the
// request's tenant connection (tdb()) — never the global handle, or a
// non-Roots tenant costs its bundles out of Roots' catalogue.

'use strict';

const { componentsOf } = require('./bundle-stock');
const { productUnitCostYuan } = require('./product-cost');

/**
 * Unit cost for one bundle product, in YUAN, or null when it cannot be
 * established.
 *
 * NESTING IS RESOLVED, NOT READ. A component that is itself a bundle is
 * costed from ITS components rather than from its stored column, so a
 * bundle-of-bundles is right on the first read instead of after however many
 * passes it takes a stored figure to settle. `seen` carries the ids already on
 * the stack: a recipe that loops back on itself yields null — the same
 * "unknown rather than wrong" answer an unpriced component gets, and the
 * treatment planRollup() gives a cycle one level down. sanitizeBundleItems()
 * already stops a bundle listing itself, so a cycle needs two rows to conspire
 * and should not exist; this makes it terminate rather than trusting that.
 *
 * @param {object} db  a tenant connection (tdb()), or any handle with .prepare
 * @param {number} storeProductId  store_products.id
 * @param {Set<number>} [seen]  internal — bundle ids currently being resolved
 * @returns {number|null} yuan per bundle, or null when any component is unpriced
 */
function bundleUnitCostYuan(db, storeProductId, seen) {
  const id = Number(storeProductId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const comps = componentsOf(db, id);
  if (!comps.length) return null;              // not a bundle — nothing to derive
  const stack = seen || new Set();
  if (stack.has(id)) return null;              // cycle → unknown, never a partial sum
  stack.add(id);
  try {
    let total = 0;
    for (const c of comps) {
      // A nested bundle is resolved through this function; anything else reads
      // its own unit cost through THE one reader, blank-cost policy included.
      // productUnitCostYuan() re-checks for components and, having just been
      // told there are none, always takes its stored-column path — so this
      // cannot recurse back in behind `seen`'s back. The repeated read is one
      // more primary-key lookup per component and is not worth a second API.
      const each = componentsOf(db, c.id).length
        ? bundleUnitCostYuan(db, c.id, stack)
        : productUnitCostYuan(db, c.id);
      if (each == null) return null;           // one blank component blanks the bundle
      total += each * c.qty;
    }
    // Four decimals, purely to keep IEEE noise (0.1 + 0.2) out of a figure the
    // margin column divides by. NOT a rounding to cents: a component can
    // legitimately cost fractions of one (a sachet, a label), and rounding the
    // sum to 2dp would throw that away on every bundle that holds several.
    const v = Math.round(total * 10000) / 10000;
    return Number.isFinite(v) && v > 0 ? v : null;
  } finally {
    stack.delete(id);
  }
}

/**
 * Does this product take its cost from a component list right now?
 *
 * The cheap gate — the bundle analogue of recipeOwnsProductCost(). Callers use
 * it to decide whether the stored column is theirs to write (the PATCH guard)
 * or theirs to overwrite on the way out (the read decorations), WITHOUT paying
 * for the whole derivation. True exactly when the row carries components.
 */
function bundleOwnsProductCost(db, storeProductId) {
  return componentsOf(db, storeProductId).length > 0;
}

module.exports = { bundleUnitCostYuan, bundleOwnsProductCost };
