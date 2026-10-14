// The cost stamped on an order line when it is sold: the product's unit cost
// and the chosen extras' cost. Both never throw, because they run inside the
// transaction that writes the order. Moved out of routes/retail.js unchanged
// (decisions §477). Pinned by scripts/test_bundle_stock_cost.js.
'use strict';

const { productUnitCostYuan } = require('./product-cost');
const { chosenOptionCostYuan } = require('./option-cost');

// ── The cost snapshot written onto every order line ────────────────────────
// What one unit of `productId` costs us right now, in ¥, for stamping into
// retail_order_items.unit_cost_at_sale at the moment a sale is written. See the
// column's own comment in database.js for what it means and why it is per-unit.
//
// THE ONE READER, THROUGH THE ONE READER. productUnitCostYuan() is what decides
// what a product costs — bundles derived from their components, a figure not
// > 0 read as unknown — so this adds no arithmetic of its own. A raw
// `SELECT unit_cost` here would snapshot blank for every bundle sold, which is
// exactly the hole lib/product-cost.js exists to close.
//
// NEVER THROWS, and that is the whole reason this wrapper exists rather than a
// bare call at each of the four write sites. Three of those sites sit INSIDE the
// transaction that writes the order itself — a checkout, a Meituan ingest — and
// a cost lookup that raised there would roll back a real order over a column
// nothing reads yet. Same judgement applyBundleCost() makes right above, for the
// same reason: null is the value the column already means "unknown" by, so a
// failure degrades to the honest answer instead of losing the sale.
//
// A null/absent productId (an unmatched channel line) short-circuits to null
// without a query — there is nothing to look up and nothing to guess.
function costAtSale(handle, productId) {
  if (!productId) return null;
  try {
    return productUnitCostYuan(handle, productId);
  } catch (e) {
    console.error('[cost-at-sale] could not resolve cost for product', productId, e && e.message);
    return null;
  }
}

// ── And what the CHOSEN EXTRAS on that line cost ───────────────────────────
// The sibling of costAtSale, for retail_order_items.options_cost_at_sale.
//
// A SECOND FUNCTION RATHER THAN A SECOND ARGUMENT TO THE ONE ABOVE, because the
// two answer different questions and land in different columns. costAtSale is
// per unit AND per pack (`pack_units` multiplies it downstream); this is per
// unit and NEVER per pack — expandStockLines adds one linked extra per unit
// bought, with no pack factor. Merging them would make one of the two wrong at
// every channel six-pack, and the mistake would be invisible in either
// expression on its own. The column's comment in database.js carries the same
// warning at the other end.
//
// NEVER THROWS, for exactly the reason its sibling gives: three of the write
// sites sit inside the transaction that writes the order, and a cost lookup
// that raised there would roll back a real sale over a column nothing depended
// on. Null is already the column's word for unknown, so a failure degrades to
// the honest answer instead of losing the order.
//
// `options` is what goes into options_json — the array the checkout already
// builds and expandStockLines already reads. A line with no options, or none
// carrying a stock link, has nothing to record and returns null.
function optionsCostAtSale(handle, options) {
  if (!Array.isArray(options) || !options.length) return null;
  try {
    return chosenOptionCostYuan(handle, options).yuan;
  } catch (e) {
    console.error('[cost-at-sale] could not resolve option costs', e && e.message);
    return null;
  }
}

module.exports = { costAtSale, optionsCostAtSale };
