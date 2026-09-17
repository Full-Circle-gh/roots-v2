// What a product's CHOICES cost us — the half of an option that has never had
// a cost counterpart.
//
// WHY THIS FILE EXISTS
// --------------------
// `retail_product_option_choices` carries `price_delta` (what the CUSTOMER
// pays) and `stock_product_id` (a real product whose shelf the choice draws
// down — expandStockLines reserves one per unit bought, exactly like a bundle
// component). It has never carried what that product costs US, and nothing
// derived it: `routes/finance-summary.js` records the gap in its own words as
// one of the three things its coverage fraction "cannot" see — "OPTIONS carry
// a price delta with no cost counterpart."
//
// That was survivable while an extra was a garnish. It stops being survivable
// the moment a CHOICE is how a product is built. Ash, 2026-09-17, on Beet
// Salad: the customer picks one of two dressings and staff had put BOTH in the
// recipe, so the product carried ¥11.43 where the true figure is ¥8.31 or
// ¥9.33. The fix is to model the choice as a choice — the recipe holds the
// salad WITHOUT dressing and each dressing becomes a stock-linked choice — and
// the moment that happens the dressing's cost leaves the recipe with it.
// Without this module it would land nowhere at all.
//
// TWO QUESTIONS, TWO ANSWERS, AND THEY ARE NOT THE SAME QUESTION
// --------------------------------------------------------------
// A SALE knows which choice was picked, so its answer is that choice's cost.
// A CATALOGUE figure — the product editor's margin, a price being set — has no
// customer and no pick yet, so there is no chosen choice to read. Its answer is
// the DEAREST the product can oblige the customer to take, because that is the
// only figure that cannot flatter a margin. A mean would read plausible and be
// wrong in the direction that gets a price cut.
//
// ONLY REQUIRED GROUPS COUNT TOWARD THE FLOOR, and that is the whole
// justification for calling it a floor: an optional "Add extras?" is revenue
// the customer volunteered, and folding its cost into the product's own would
// charge every unit for an extra most units never carry. A REQUIRED group is
// different in kind — the product cannot leave the counter without one, so its
// cost is part of what the product costs.
//
// NULL MEANS UNKNOWN, NEVER ZERO — the discipline lib/product-cost.js,
// lib/recipe-cost.js and lib/product-build-cost.js all hold, for the reason
// §32 rule 10 gives: a thing nobody could price and a thing that genuinely cost
// nothing must not render alike. A choice with NO stock link is a label — a
// sugar level, a "slice the wrap?" — and costs a real, knowable zero. A choice
// WITH a link whose product has no cost is an unknown, and it blocks the
// figure rather than quietly contributing nothing.
//
// NO WRITES, AND NO ARITHMETIC OF ITS OWN ON WHAT A PRODUCT COSTS.
// productUnitCostYuan() is what decides that — bundles derived from components,
// a figure not > 0 read as unknown — so this calls it rather than re-deriving
// it. A second copy of "what does this product cost" is precisely the drift
// lib/product-cost.js's header exists to record.
'use strict';

const { productUnitCostYuan } = require('./product-cost');

/* The chosen extras on ONE order line, per unit of that line.
 *
 * PER UNIT, not per line, because that is how the stock behaves: expandStockLines
 * adds `r.qty` of each stock-linked choice, one per unit bought. A caller
 * multiplying by qty gets the line; a caller multiplying by pack_units as well
 * would be wrong, and the column's comment in database.js says so at the one
 * place that could make the mistake.
 *
 * `options` is the array that lives in retail_order_items.options_json — the
 * shape the checkout already stores, and the same one expandStockLines reads.
 * A stock link is the ONLY thing consulted: a choice without one is a label.
 *
 * Returns { yuan, linked, uncosted }:
 *   yuan      null when there is nothing to record (no stock-linked choice at
 *             all) AND null when one of them cannot be priced. `linked` tells
 *             those two apart, so a caller is never left guessing which null
 *             it got.
 *   linked    how many chosen choices draw down a real shelf.
 *   uncosted  how many of those we could not price.
 */
function chosenOptionCostYuan(db, options) {
  const list = Array.isArray(options) ? options : [];
  let yuan = 0, linked = 0, uncosted = 0;
  for (const o of list) {
    const pid = o && parseInt(o.stock_product_id, 10);
    if (!pid) continue;                       // a label, not a thing
    linked++;
    let c = null;
    try { c = productUnitCostYuan(db, pid); } catch (e) { c = null; }
    if (c == null) { uncosted++; continue; }
    yuan += c;
  }
  // ALL-OR-NOTHING, the same rule a build list holds: a sum missing one line's
  // contribution is confidently low, and low reads as plausible. Better to say
  // nothing than to say a number that is wrong downward.
  if (!linked || uncosted) return { yuan: null, linked, uncosted };
  return { yuan, linked, uncosted };
}

/* What this product's REQUIRED choices add to its own cost, at worst.
 *
 * For each required group, the dearest combination the customer may be made to
 * take: one choice for a `single`, and for a `multi` the `min_choices` dearest
 * (a required multi with no floor still obliges one — is_required is the older,
 * coarser form of the same rule, and routes/retail.js treats it that way).
 * A `text` group has no choices and adds nothing.
 *
 * Returns { yuan, groups, uncosted }:
 *   yuan      0 when no required group has a stock-linked choice — a real,
 *             knowable zero, and the answer for almost every product today.
 *             null when a required group HAS a stock-linked choice we cannot
 *             price, because then the floor is unknown rather than zero.
 *   groups    required groups that contribute something.
 *   uncosted  linked choices in required groups we could not price.
 */
function requiredOptionFloorYuan(db, productId) {
  if (!productId) return { yuan: 0, groups: 0, uncosted: 0 };
  let opts;
  try {
    opts = db.prepare(
      `SELECT id, type, is_required, min_choices
         FROM retail_product_options
        WHERE product_id = ? AND is_required = 1`
    ).all(productId);
  } catch (e) {
    // A handle without the options tables (an older fixture) has no options and
    // therefore no floor. It must not disable costing for everything else.
    return { yuan: 0, groups: 0, uncosted: 0 };
  }
  if (!opts.length) return { yuan: 0, groups: 0, uncosted: 0 };

  let total = 0, groups = 0, uncosted = 0, blocked = false;
  for (const o of opts) {
    if (o.type === 'text') continue;
    let choices;
    try {
      choices = db.prepare(
        'SELECT stock_product_id FROM retail_product_option_choices WHERE option_id = ?'
      ).all(o.id);
    } catch (e) { continue; }

    // Price every stock-linked choice in the group. An unlinked choice is a
    // label and contributes a real zero — it is NOT skipped, because "the
    // cheapest required answer is free" is a true and useful fact about a group
    // that mixes labels with things.
    const costs = [];
    for (const c of choices) {
      const pid = c && parseInt(c.stock_product_id, 10);
      if (!pid) { costs.push(0); continue; }
      let v = null;
      try { v = productUnitCostYuan(db, pid); } catch (e) { v = null; }
      if (v == null) { uncosted++; blocked = true; continue; }
      costs.push(v);
    }
    if (!costs.length) continue;

    // How many the customer must take. A required single takes exactly one; a
    // required multi takes its floor, and a floor of 0 on a REQUIRED group
    // still means one — the group cannot be answered with nothing.
    const need = o.type === 'multi' ? Math.max(1, Number(o.min_choices) || 0) : 1;
    costs.sort((a, b) => b - a);                       // dearest first
    const worst = costs.slice(0, need).reduce((a, b) => a + b, 0);
    if (worst > 0) groups++;
    total += worst;
  }
  // A group we could not fully price makes the FLOOR unknown, not zero: the
  // choice we could not read might be the dearest one, so the figure we could
  // compute is a lower bound pretending to be a worst case.
  if (blocked) return { yuan: null, groups, uncosted };
  return { yuan: total, groups, uncosted };
}

module.exports = { chosenOptionCostYuan, requiredOptionFloorYuan };
