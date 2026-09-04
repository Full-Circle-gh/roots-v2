// Stamping the derived batch size and serving count onto the recipe row.
//
// WHY A WRITE AT ALL, when lib/recipe-cost.js already resolves both figures on
// every read: because `recipes.batch_size` and `recipes.servings` are read
// DIRECTLY, off the column, by a dozen places that never go near a cost
// breakdown — routes/production.js's batch sheets, routes/kitchen.js's picker,
// routes/products.js's recipe lookup, the AI tool surface, every diagnostic in
// scripts/. Leaving the column stale and correcting it only in the derivation
// would give the same recipe two batch sizes depending on which door asked, and
// the one people read on a printed batch sheet would be the wrong one.
//
// So the rule is: the derivation decides, and the column follows it. Both
// recipe doors call applyAutoYield() immediately after writing the ingredient
// lines and BEFORE firing the material recompute — the rollup divides by
// batch_size, and it must divide by the new one.
//
// IT ONLY EVER TOUCHES A RECIPE THAT ASKED. `batch_size_auto` / `servings_auto`
// are 0 on every recipe that carried a typed figure when the columns landed
// (database.js, recipe_yield_auto_v1), so this is a no-op for all of them —
// including any recipe whose stated yield deliberately differs from the sum of
// its inputs because it reduces on the stove.

'use strict';

const { resolveYield } = require('./recipe-cost');

const SQL_RECIPE = 'SELECT * FROM recipes WHERE id = ?';
// The lines as the derivation wants them: qty, unit and in_yield. No join —
// nothing about a material's cost bears on what a batch weighs.
const SQL_LINES = 'SELECT qty, unit, in_yield, name_en FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order, id';

/**
 * Recompute this recipe's derived batch size / serving count and write back
 * whichever of the two the recipe asks to have derived.
 *
 * Never throws: a save that succeeded must not report failure because a derived
 * figure could not be stamped, and the derivation on read still returns the
 * right number regardless. Returns what it did, for a caller that wants to say.
 */
function applyAutoYield(db, recipeId) {
  const id = Number(recipeId);
  try {
    const recipe = db.prepare(SQL_RECIPE).get(id);
    if (!recipe) return { ok: false, reason: 'not_found' };
    const lines = db.prepare(SQL_LINES).all(id);
    const y = resolveYield(recipe, lines);
    const sets = [];
    const vals = [];
    if (y.batchAuto) {
      // A refused sum (see computeYield) resolves back to the stored figure, so
      // this writes the recipe's own number back onto itself rather than
      // clearing it — the batch size an operator typed before turning auto on
      // is not something a blocked derivation may delete.
      sets.push('batch_size=?');
      vals.push(y.batchSize > 0 ? y.batchSize : null);
    }
    if (y.servingsAuto) {
      sets.push('servings=?');
      vals.push(y.servings > 0 ? y.servings : null);
    }
    if (!sets.length) return { ok: true, changed: false, yield: y };
    db.prepare(`UPDATE recipes SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return { ok: true, changed: true, batch_size: y.batchSize, servings: y.servings, yield: y };
  } catch (e) {
    return { ok: false, reason: 'write_failed', message: e && e.message };
  }
}

module.exports = { applyAutoYield };
