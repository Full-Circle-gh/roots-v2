// Ingredient cost-per-recipe-unit — the ONE derivation.
//
// WHY THIS EXISTS
// ---------------
// `ingredients.cost_per_unit` is a STORED column holding cost per RECIPE unit
// (¥/g for a food weighed into a recipe, ¥/piece for an item counted out).
// `ingredients.buy_price` holds the PACK price — what the supplier charges for
// one package. Turning the second into the first needs the pack size, and that
// division existed in three unrelated copies:
//
//   public/app.html  calcCPU()                  ~:5515  the ingredient edit form
//   routes/admin.js  deriveCpu()                ~:301   POST /api/admin/repair-items
//   routes/purchases.js firePriceAlertsForPO()  ~:74    PO price write-back
//
// The third one divided by a unit→grams table keyed on the PO LINE's unit, so
// a bag-bought item ('bag' is not in any unit table) fell through to `|| 1` and
// stored the pack price undivided — ¥15.80/g for a ¥15.80 500 g bag of sesame
// seeds. This module replaces that maths and is the source purchasing reads.
//
// THE RULE (decided 2026-08-17, keyed on the RECIPE unit, not the buy unit)
// ------------------------------------------------------------------------
//   ingredients.unit is 'g' or 'ml'                 → divide: the recipe
//                                                     consumes weight/volume
//   ingredients.unit is pcs / bag / bottle / box    → do not divide: the recipe
//                                                     consumes whole packages,
//                                                     so the pack price IS the
//                                                     cost per recipe unit
//   anything else                                   → not derivable; skip
//
// Those six are the entire Recipe Unit dropdown (public/app.html:5129-5132), so
// the last line only catches a blank or a value from outside the form. Rather
// than guess a divisor there we return a reason and write nothing, leaving the
// stored value alone.
//
// NO WRITES, NO DB. Pure functions over one ingredient row.

'use strict';

// Grams in ONE of each measurable unit. Mirrors UNIT_TO_GRAMS in
// public/app.html:5487 (the edit form) — ml and g share a scale, which is what
// makes one table serve both weight and volume. Lookup is case-insensitive
// here because the DB holds both 'L' and 'kg'; the form's table is
// case-sensitive and would miss a lowercase 'l'.
const UNIT_TO_GRAMS = {
  kg: 1000, g: 1, l: 1000, liter: 1000, litre: 1000, ml: 1, lb: 453.6, oz: 28.35,
};

// Recipe units that mean "this recipe consumes weight or volume", so the pack
// price must be divided down to a per-gram / per-ml figure.
const DIVISIBLE_RECIPE_UNITS = ['g', 'ml'];

// Recipe units that mean "this recipe consumes whole items". The pack price is
// already the per-item cost. bag / bottle / box sit here for the same reason
// pcs does: a recipe that calls for one bag consumes one bag, whatever weight
// is inside it (decided 2026-08-17 — 29 live rows depend on it).
const PER_PIECE_RECIPE_UNITS = ['pcs', 'bag', 'bottle', 'box'];

// Spellings that mean the same unit. 'pc' against 'pcs' was 8 of the 19 unit
// disagreements in live PO lines (measured 2026-08-18) — a typing habit, not a
// difference of opinion about what was bought. Compare units through
// normaliseUnit(), never raw, or the write-back refuses good prices over a
// missing letter.
const UNIT_SYNONYMS = {
  pc: 'pcs', piece: 'pcs', pieces: 'pcs',
  l: 'liter', litre: 'liter', ltr: 'liter',
  gram: 'g', grams: 'g', kilo: 'kg', kilos: 'kg', kgs: 'kg',
};

function normaliseUnit(unit) {
  const u = String(unit == null ? '' : unit).trim().toLowerCase();
  return UNIT_SYNONYMS[u] || u;
}

function gramsFor(unit) {
  if (!unit) return 0;
  return UNIT_TO_GRAMS[normaliseUnit(unit)] || 0;
}

/**
 * How many grams (or ml) sit inside ONE buy_unit of this ingredient.
 *
 * Two paths, in the same precedence order as the edit form's calcCPU():
 *   1. buy_unit IS a measure (kg, L, g…) → the table answers directly
 *   2. buy_unit is a container (bag, bottle, pcs…) → the row must say what one
 *      container holds, via pack_contents_qty + pack_contents_unit
 *
 * Returns 0 when neither path resolves — a container with no recorded contents.
 * That is not an error, it is an item nobody has told us the size of.
 */
function gramsPerBuyUnit(ing) {
  const direct = gramsFor(ing && ing.buy_unit);
  if (direct > 0) return { grams: direct, source: 'buy_unit' };
  const qty = parseFloat(ing && ing.pack_contents_qty) || 0;
  const per = gramsFor(ing && ing.pack_contents_unit);
  if (qty > 0 && per > 0) return { grams: qty * per, source: 'pack_contents' };
  return { grams: 0, source: null };
}

/**
 * Cost per recipe unit for `packPrice` paid for one package of `ing`.
 *
 * Returns { gramsPerBuyUnit, cpu, reason }:
 *   cpu     — the number to store, or null when it is not derivable
 *   reason  — why, always set:
 *               'per_piece'        cpu = packPrice, recipe unit is pcs
 *               'divided'          cpu = packPrice / (buy_pack_size × grams)
 *               'no_price'         packPrice missing or ≤ 0
 *               'no_pack_size'     buy_pack_size is 0 / null
 *               'no_pack_contents' container buy_unit with no recorded contents
 *               'unsupported_recipe_unit'  recipe unit is not g / ml / pcs
 *
 * A null cpu means WRITE NOTHING. It never means zero — storing 0 would erase a
 * good cost, and dividing by 1 would store a pack price as a per-gram cost,
 * which is the bug this module exists to end.
 */
function deriveCostPerUnit(ing, packPrice) {
  const price = parseFloat(packPrice);
  const recipeUnit = String((ing && ing.unit) || '').trim().toLowerCase();
  const { grams, source } = gramsPerBuyUnit(ing || {});

  if (!(price > 0)) return { gramsPerBuyUnit: grams, cpu: null, reason: 'no_price' };

  if (PER_PIECE_RECIPE_UNITS.includes(recipeUnit)) {
    // Counted out whole. ¥28 for a 300 g bag of tortilla chips used one bag at
    // a time is ¥28 per recipe unit — dividing by 300 would be wrong.
    return { gramsPerBuyUnit: grams, cpu: price, reason: 'per_piece' };
  }

  if (!DIVISIBLE_RECIPE_UNITS.includes(recipeUnit)) {
    // Not one of the six units the form offers — a blank or something written
    // by an older import. No divisor can be defended, so the caller skips.
    return { gramsPerBuyUnit: grams, cpu: null, reason: 'unsupported_recipe_unit' };
  }

  const packSize = parseFloat(ing && ing.buy_pack_size) || 0;
  if (!(packSize > 0)) return { gramsPerBuyUnit: grams, cpu: null, reason: 'no_pack_size' };
  if (!(grams > 0))    return { gramsPerBuyUnit: grams, cpu: null, reason: 'no_pack_contents' };

  return {
    gramsPerBuyUnit: grams,
    cpu: price / (packSize * grams),
    reason: 'divided',
    divisorSource: source,
  };
}

// The reasons above are stored raw in ingredient_cost_skips.reason and turned
// into English + Chinese where they are shown — public/app.html
// _alertCostSkipRows(). They are not translated here: a server module has no
// business owning UI copy, and the Alerts page needs the strings anyway.

module.exports = {
  UNIT_TO_GRAMS,
  DIVISIBLE_RECIPE_UNITS,
  PER_PIECE_RECIPE_UNITS,
  UNIT_SYNONYMS,
  normaliseUnit,
  gramsFor,
  gramsPerBuyUnit,
  deriveCostPerUnit,
};
