// The one writer of `recipe_cost_data` — the manual cost inputs a person types
// on a recipe (labour, packaging, overhead %, sell price, target food cost) and
// the record of WHICH packaging that number came from.
//
// NOT `lib/recipe-cost.js`. That file DERIVES a cost breakdown and never writes
// anything. This file writes the stored inputs that file reads. A reader meeting
// both should treat the split as: recipe-cost.js answers "what does this cost",
// this file answers "what did someone type".
//
// WHY THIS IS NOT LEFT IN THE ROUTES
// ----------------------------------
// Two routes save these inputs — the kitchen app's `PUT /api/recipes/:id/cost`
// and Tacet's `PUT /api/retail-admin/recipes/:id/cost` — and they carried two
// byte-identical copies of the same UPSERT. The rule below has to hold for every
// caller of both, including callers not yet written, so it lives underneath them
// rather than in each. This is the shape `lib/meituan-map-write.js` already
// uses, and the reason is the one recorded in decisions §30 rule 3's worked
// example: A RULE ENFORCED BY THE CALLERS OF A WRITE IS A CONVENTION, AND A
// CONVENTION IS DECLINED BY WHICHEVER CALLER NOBODY CHECKED.
//
// It also means the write can be driven headless against an in-memory fixture —
// see scripts/test_recipe_cost_data_write.js — instead of only through HTTP.
//
// AN ABSENT FIELD IS NOT A CLEARED FIELD
// --------------------------------------
// This is the fix this file exists for. `packaging_type_id` records which
// packaging a recipe's packaging number was copied from. Tacet's Cost & Pricing
// tab has no packaging-type picker, so its save payload has never carried the
// key at all — and the route coalesced the missing value to NULL and wrote it.
// So opening a recipe in Tacet, changing anything on the cost tab and saving
// KEPT THE NUMBER AND SILENTLY DISCARDED WHICH PACKAGING IT WAS.
//
// That link is not decoration: it is the machine-resolvable input to the
// packaging migration (decisions §31). Every such save turned a row the
// migration could resolve on its own into one needing a person. See
// docs/packaging-findings.md finding 11.
//
// CLEARING MUST STILL WORK, AND THAT IS WHY THE THREE CASES ARE SEPARATED.
// The obvious repair — COALESCE the incoming value against the stored one — is
// wrong, and wrong in a way that would not show up for months: it makes an
// explicit NULL indistinguishable from an absent key, so a link could never be
// removed once set. `lib/meituan-map-write.js` solves the same problem by
// checking the clear FIRST, before its gate, for the same reason: an unmap is a
// removal, not a claim, and a rule meant to protect a value must not trap it.
//
// NOTHING ELSE GAINS PRESERVE-ON-ABSENT SEMANTICS. Every other column keeps the
// exact behaviour it had — an absent `labour` still writes 0, an absent
// `target_food_cost` still writes 30. That is deliberate and asserted in the
// test: this change is about one column that records an identity, not about
// turning the whole route into a partial-update endpoint. The other five are
// numbers a form always sends, and quietly making them sticky would mean a field
// a user cleared to blank could never go back to zero.

'use strict';

const PACKAGING_TYPE_KEY = 'packaging_type_id';

// A body that can be safely asked whether it holds a key. `req.body` is
// `undefined` on a request with no parsed body, and a caller may hand us
// anything; both read as "mentioned no fields at all".
function asBody(body) {
  return (body && typeof body === 'object') ? body : {};
}

/**
 * Which packaging type to write, given what the caller sent and what is stored.
 *
 * THREE CASES, AND THE FIRST TWO ARE THE WHOLE POINT:
 *
 *   key ABSENT              -> keep whatever is stored. The caller is not
 *                              talking about this field, so it is not theirs to
 *                              erase. (Tacet's cost tab, and any future caller
 *                              that saves a subset.)
 *   key PRESENT but empty   -> CLEAR. null, '' and 0 all mean "no packaging
 *                              type". The kitchen app's picker sends a literal
 *                              null when nothing is selected, and that is a
 *                              deliberate unlink that must keep working.
 *   key PRESENT with a value-> write that value.
 *
 * The empty test is `|| null`, unchanged from what both routes did before, so a
 * value that cleared the column yesterday still clears it today. Ids are
 * AUTOINCREMENT from 1, so 0 is not a losable id.
 *
 * Exported for the test and for anyone who needs the answer without the write.
 */
function resolvePackagingTypeId(body, storedTypeId) {
  const b = asBody(body);
  if (!Object.prototype.hasOwnProperty.call(b, PACKAGING_TYPE_KEY)) {
    return storedTypeId == null ? null : storedTypeId;
  }
  return b[PACKAGING_TYPE_KEY] || null;
}

const PACKAGING_KEY = 'packaging';

/**
 * The packaging FIGURE, same three cases and now for the same reason.
 *
 * WIDENED 2026-08-27 BY STEP 4, DELIBERATELY. This file's header records that
 * only `packaging_type_id` had preserve-on-absent semantics, and a test
 * asserted no other column had gained them — a guard against the fix spreading
 * by accident. This is not an accident.
 *
 * §31's Step 4 removed the packaging INPUT from Tacet's Cost & Pricing tab,
 * because packaging is the product's now and lives on its build list. So that
 * screen's payload legitimately stops mentioning `packaging` at all — and the
 * old `b.packaging || 0` would have read undefined and written ZERO, erasing
 * the recorded figure on the first save of any of the 93 recipes that still
 * carry one. That is finding 11's exact failure, on the neighbouring column,
 * caused by the very change that made the key absent.
 *
 * The figures are still wanted: they are what the screen strikes through so a
 * migration can be checked, and what a later pass would reconcile against a
 * product's build list. A caller that says nothing about the field does not
 * get to erase it.
 *
 * The kitchen app's Cost Sheet still SENDS this key and still owns clearing
 * it — present-and-zero clears, exactly as before.
 */
function resolvePackaging(body, storedPackaging) {
  const b = asBody(body);
  if (!Object.prototype.hasOwnProperty.call(b, PACKAGING_KEY)) {
    return Number(storedPackaging) || 0;
  }
  return Number(b[PACKAGING_KEY]) || 0;
}

const UPSERT = `
  INSERT INTO recipe_cost_data
    (recipe_id, labour, packaging, packaging_type_id, overhead_pct, sell_price, target_food_cost, updated_at)
  VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(recipe_id) DO UPDATE SET
    labour=?, packaging=?, packaging_type_id=?, overhead_pct=?, sell_price=?,
    target_food_cost=?, updated_at=CURRENT_TIMESTAMP`;

/**
 * Save one recipe's cost inputs. Writes; computes nothing.
 *
 * The caller owns the existence check, the permission gate and the recompute
 * trigger — this adds no rule of its own beyond the absent/cleared distinction
 * above, and it deliberately does NOT fire the rollup: the two routes tag their
 * recompute differently ('recipes.cost_update' vs 'retail-recipes.cost_update')
 * and that tag is a property of the caller, not of the write.
 *
 * READ-THEN-WRITE IS SAFE HERE WITHOUT A TRANSACTION. better-sqlite3 is
 * synchronous, so no other statement in this process can land between the SELECT
 * and the UPSERT, and no other process writes this table — the only other
 * writers are the recipe duplicate path and the kitchen reset, both in-process.
 * It nests harmlessly if a caller has its own transaction open.
 *
 * `target_food_cost || 30` PRESERVES A DOCUMENTED QUIRK: a stored 0 becomes 30,
 * exactly as lib/recipe-cost.js:248 reads it back. Do not "fix" it here alone —
 * the two would then disagree about the same recipe.
 *
 * Returns { existed, packaging_type_id } — `existed` says whether this updated a
 * row or created one, and the id is what was actually written, so a caller can
 * report it without re-reading.
 */
function saveRecipeCostData(db, recipeId, body) {
  const b = asBody(body);
  const cur = db.prepare(
    'SELECT packaging, packaging_type_id FROM recipe_cost_data WHERE recipe_id = ?'
  ).get(recipeId);

  const packagingTypeId = resolvePackagingTypeId(b, cur ? cur.packaging_type_id : null);
  const labour = b.labour || 0;
  const packaging = resolvePackaging(b, cur ? cur.packaging : 0);
  const overheadPct = b.overhead_pct || 0;
  const sellPrice = b.sell_price || 0;
  const targetFoodCost = b.target_food_cost || 30;

  db.prepare(UPSERT).run(
    recipeId, labour, packaging, packagingTypeId, overheadPct, sellPrice, targetFoodCost,
    labour, packaging, packagingTypeId, overheadPct, sellPrice, targetFoodCost
  );

  return { existed: !!cur, packaging_type_id: packagingTypeId };
}

module.exports = { saveRecipeCostData, resolvePackagingTypeId, PACKAGING_TYPE_KEY, resolvePackaging, PACKAGING_KEY };
