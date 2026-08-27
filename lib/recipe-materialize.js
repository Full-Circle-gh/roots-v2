// "Make available as material" (§29 step 5) — the one action that turns a
// recipe's output into a reusable ingredient. Pulled out of the route file so
// it can be tested directly (scripts/test_recipe_materialize.js) against the
// exported functions themselves, the same way lib/recipe-graph.js and
// lib/recipe-rollup.js are — a test that re-implements the guard logic to
// check it proves only that two copies agree.
//
// routes/retail-recipes.js's POST/DELETE .../materialize handlers are thin
// wrappers: parse the request, call one of these, map {ok:false} to an HTTP
// status. This module owns no HTTP concerns and takes a db-shaped handle
// (better-sqlite3 or a seamed wrapper), same convention as recipe-graph.js
// and recipe-rollup.js.
//
// THIS IS THE ONLY CODE PATH PERMITTED TO WRITE ingredients.source_recipe_id
// FROM A CLIENT REQUEST. routes/retail-materials.js's readBody() deliberately
// never reads that field — see its own comment — so there is no other door,
// and nothing in this file should be copied to open one.

'use strict';

const { checkMaterializeCycle } = require('./recipe-graph');
const { fireRecompute } = require('./recipe-rollup');

// The material a recipe backs, if any. At most one, per the partial unique
// index on ingredients.source_recipe_id (database.js).
function linkedMaterialFor(db, recipeId) {
  return db.prepare(
    `SELECT id, name_en, name_cn, sku, unit, cost_per_unit, item_kind, source_recipe_id
       FROM ingredients WHERE source_recipe_id = ?`
  ).get(recipeId) || null;
}

// Active recipes currently consuming `materialId` as an ingredient line (§29
// step 6). Used to name the actual consequence of archiving something a
// material depends on, or that depends on a material — on both sides of
// that relationship, not just the one this file otherwise concerns itself
// with. Read-only; archived recipes are excluded since they are not a
// "currently uses it" fact worth warning about.
function materialConsumers(db, materialId) {
  return db.prepare(`
    SELECT DISTINCT r.id, r.name_en, r.name_cn
      FROM recipe_ingredients ri
      JOIN recipes r ON r.id = ri.recipe_id AND r.is_active = 1
     WHERE ri.ingredient_id = ?
     ORDER BY r.name_en COLLATE NOCASE
  `).all(materialId);
}

// Create a brand-new material row backed by `recipeId`.
//
// unit is fixed at 'g' — batch_size is defined in grams (schema.sql) and the
// rollup does no conversion. buy_unit/buy_price/pack fields stay at their
// schema defaults: there is no purchase for a made material, and costFor() in
// routes/retail-materials.js already knows to leave a linked row's cost alone
// rather than deriving it from those fields.
//
// No cycle check here: a brand-new ingredients row has no id until the INSERT
// runs, so nothing could already reference it as a recipe_ingredients line —
// the cycle checkMaterializeCycle exists to catch is structurally impossible
// for a row that has never existed before this call.
function materializeNew(db, { recipeId, name_en, sku, name_cn, item_kind }) {
  const already = linkedMaterialFor(db, recipeId);
  if (already) {
    return { ok: false, status: 400, error: 'already_linked',
      message: `This recipe already backs "${already.name_en}". Unlink it first.` };
  }
  const nameEn = String(name_en || '').trim();
  if (!nameEn) return { ok: false, status: 400, error: 'name_required', message: 'A name is required.' };
  const nameCn = name_cn != null ? (String(name_cn).trim() || null) : null;
  const skuVal = sku != null ? (String(sku).trim() || null) : null;
  const kind = item_kind || 'food';
  // WHERE A MADE MATERIAL FILES ITSELF. Copied verbatim from live data, never
  // composed: 26 of the 31 materials currently backed by a recipe already sit
  // in this category, and it is a real `ingredients.category` value with 37
  // rows in it, so this follows a convention Roots set rather than inventing
  // one. The 4 that were blank were exactly the ones this function created —
  // it never set a category at all, so every recipe made available as a
  // material landed uncategorised and invisible to the Materials screen's own
  // category filter. Reported by Ash looking at Hazelnut-Chocolate Spread.
  //
  // The string is a DATA value, not a UI label — the categories in this table
  // are stored bilingual — so copying it whole is correct and the
  // never-compose rule is satisfied by it already existing.
  //
  // materializeLink does NOT do this, deliberately: linking an EXISTING
  // material must not rewrite a category somebody already chose. One of the 31
  // sits in "Spices, Herbs & Salt" for exactly that reason and is right to.
  const MADE_MATERIAL_CATEGORY = 'Kitchen Recipes 厨房自制';

  try {
    const result = db.prepare(`INSERT INTO ingredients
      (name_en, name_cn, sku, unit, item_kind, category, cost_per_unit, buy_price, source_recipe_id)
      VALUES (?, ?, ?, 'g', ?, ?, 0, 0, ?)`)
      .run(nameEn, nameCn, skuVal, kind, MADE_MATERIAL_CATEGORY, recipeId);
    const materialId = result.lastInsertRowid;
    const rollup = fireRecompute(db, { source: 'retail-recipes.materialize_new', recipe_id: recipeId });
    // A human choosing this action IS the resolution, if a collision was
    // open on this recipe — don't wait for the next save to notice.
    resolveOpenCollisions(db, recipeId);
    return { ok: true, material_id: materialId, rollup };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      const owner = skuVal ? db.prepare('SELECT id, name_en, is_active FROM ingredients WHERE sku = ?').get(skuVal) : null;
      return { ok: false, status: 400, error: 'sku_taken',
        message: owner ? `SKU "${skuVal}" is already used by "${owner.name_en}" (#${owner.id}).` : `SKU "${skuVal}" already exists.` };
    }
    return { ok: false, status: 500, error: 'save_failed', message: e.message };
  }
}

// Link an EXISTING material to `recipeId`. Two required guards, checked in
// order, each naming the actual conflict rather than a generic refusal —
// plus the cycle guard, plus a non-blocking informational warning.
function materializeLink(db, { recipeId, materialId }) {
  const already = linkedMaterialFor(db, recipeId);
  if (already) {
    return { ok: false, status: 400, error: 'already_linked',
      message: `This recipe already backs "${already.name_en}". Unlink it first.` };
  }
  if (!materialId) return { ok: false, status: 400, error: 'material_required', message: 'Pick a material to link.' };
  const candidate = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(materialId);
  if (!candidate) return { ok: false, status: 404, error: 'material_not_found', message: 'That material no longer exists.' };

  // Guard 1 — already linked elsewhere. Re-linking would silently steal the
  // link from whichever recipe currently backs it.
  if (candidate.source_recipe_id) {
    const owner = db.prepare('SELECT id, name_en FROM recipes WHERE id = ?').get(candidate.source_recipe_id);
    return { ok: false, status: 400, error: 'material_already_linked',
      message: `"${candidate.name_en}" already backs "${owner ? owner.name_en : 'recipe #' + candidate.source_recipe_id}" — unlink it there first.` };
  }
  // Guard 2 — unit mismatch. lib/recipe-rollup.js's costOneRecipe() writes
  // costPerGram straight into cost_per_unit with no conversion, so linking a
  // non-gram material would silently mislabel its cost basis. This is the
  // guard that matters most: it fails quietly, not loudly, if skipped.
  const candidateUnit = candidate.unit || 'g';
  if (candidateUnit !== 'g') {
    return { ok: false, status: 400, error: 'unit_mismatch',
      message: `"${candidate.name_en}" is costed per ${candidateUnit}, but a recipe's cost only rolls up in grams — linking it would silently relabel its cost basis.` };
  }
  // Cycle guard (§29) — mirror-direction check of routes/recipes.js's own
  // cycleRefusal(); see lib/recipe-graph.js checkMaterializeCycle().
  const verdict = checkMaterializeCycle(db, { recipeId, materialId: candidate.id });
  if (!verdict.ok) {
    const names = verdict.chain.map(id => {
      const r = db.prepare('SELECT name_en FROM recipes WHERE id = ?').get(id);
      return (r && r.name_en) || `recipe #${id}`;
    });
    return { ok: false, status: 400, error: 'cycle',
      message: `Can't link "${candidate.name_en}" here: "${names.join('" already needs "')}" already needs "${candidate.name_en}" to make it. A recipe can't end up needing its own output.` };
  }

  // Soft warning — informational only, never blocking.
  const hasPoLines = !!db.prepare('SELECT 1 FROM po_line_items WHERE ingredient_id = ? LIMIT 1').get(candidate.id);
  const warning = (candidate.buy_price > 0 || hasPoLines)
    ? `"${candidate.name_en}" had a buy price / purchase history — its cost now comes from this recipe instead.`
    : null;

  db.prepare('UPDATE ingredients SET source_recipe_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(recipeId, candidate.id);
  // The existing rollup, not a direct write — a newly-linked material shows
  // its real computed cost (or a correctly-blocked one) on first paint.
  const rollup = fireRecompute(db, { source: 'retail-recipes.materialize_link', recipe_id: recipeId });
  resolveOpenCollisions(db, recipeId);
  return { ok: true, material_id: candidate.id, warning, rollup };
}

// Detach only — never delete the row. Other recipes may already consume it
// as an ingredient line, and its last computed cost is still a real number
// worth keeping (it simply stops moving with this recipe from here on).
function unlink(db, { recipeId }) {
  const material = linkedMaterialFor(db, recipeId);
  if (!material) return { ok: false, status: 400, error: 'not_linked', message: 'This recipe does not back a material.' };
  db.prepare('UPDATE ingredients SET source_recipe_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(material.id);
  return { ok: true, material_id: material.id };
}

// ── §29 addendum (decided 2026-08-27): a recipe's output always has a ─────
// materials row, whether or not anything uses it. This is the automatic
// counterpart to materializeNew/materializeLink above — called after every
// recipe create/update from BOTH routes/recipes.js and
// routes/retail-recipes.js, never from a client request directly, so it
// stays true that this file is the only place ingredients.source_recipe_id
// moves. See docs/tacet-consolidation-decisions.md's third §29 addendum and
// docs/tacet-product-build-lines-design.md §6 for why this exists: a
// product's build list cannot point at a made thing's cost until that thing
// has a materials row, and today only 28 of 137 active recipes have one.
//
// THREE OUTCOMES, NEVER A FOURTH:
//   'updated'   — already linked. The material's name/name_cn/sku are kept
//                 in sync with the recipe (a rename follows through); its
//                 unit, cost_per_unit and item_kind are NEVER touched here —
//                 those are the rollup's and the original materialize
//                 action's business, not this one's.
//   'created'   — not linked, and no existing ingredients row shares its
//                 name — materializeNew() runs, unchanged, so there is
//                 exactly one code path that ever performs the write.
//   'collision' — not linked, and an ingredients row with the same name_en
//                 already exists. NOTHING IS WRITTEN. §29's first addendum
//                 found none of the platform's three signals for telling a
//                 legacy MADE row from a legacy BOUGHT one trustworthy alone
//                 or combined, and settled that a human resolved every one
//                 of Roots' 40 real collisions. Guessing here — silently
//                 linking, silently renaming either side, or silently
//                 creating a second row with the same name — would relearn
//                 that lesson at a worse time, on every future save instead
//                 of as a one-time migration. The collision is recorded in
//                 recipe_materialize_collisions (database.js) for a human to
//                 resolve, by using materializeLink (this recipe really does
//                 make that thing) or by renaming one side (it doesn't).
//
// Matching is name_en only, case-insensitive, exact. Not name_cn: recipes
// and ingredients disagree on whether name_cn is required, so matching on it
// risks a false negative (a real collision missed because the Chinese name
// was typed slightly differently) — worse than the false positive of
// flagging two same-named things that turn out to be unrelated, which a
// human resolves in one click via materializeLink's own "not this one".
// Matching considers ingredients regardless of is_active — an archived
// material sharing the name is still evidence worth a human's eyes; being
// silently invisible to this check would let the same collision resurface
// later as a fresh one when the row is reactivated.
function ensureMaterialized(db, recipeId) {
  const recipe = db.prepare('SELECT id, name_en, name_cn, sku, is_active FROM recipes WHERE id = ?').get(recipeId);
  if (!recipe) return { action: 'skipped', reason: 'recipe_missing' };
  if (!recipe.is_active) return { action: 'skipped', reason: 'recipe_archived' };

  const nameEn = String(recipe.name_en || '').trim();
  if (!nameEn) return { action: 'skipped', reason: 'no_name' };
  const nameCn = recipe.name_cn != null ? (String(recipe.name_cn).trim() || null) : null;
  const skuVal = recipe.sku != null ? (String(recipe.sku).trim() || null) : null;

  const linked = linkedMaterialFor(db, recipeId);
  if (linked) {
    if (linked.name_en !== nameEn || linked.name_cn !== nameCn || linked.sku !== skuVal) {
      try {
        db.prepare('UPDATE ingredients SET name_en = ?, name_cn = ?, sku = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(nameEn, nameCn, skuVal, linked.id);
      } catch (e) {
        // The recipe's own SKU collides with an unrelated ingredient's. The
        // recipe save must not fail over a secondary field — keep the name
        // in sync and leave the material's SKU as it was.
        if (!/UNIQUE/.test(e.message)) throw e;
        db.prepare('UPDATE ingredients SET name_en = ?, name_cn = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(nameEn, nameCn, linked.id);
      }
    }
    resolveOpenCollisions(db, recipeId);
    return { action: 'updated', material_id: linked.id };
  }

  const collision = db.prepare(
    `SELECT id, name_en FROM ingredients WHERE name_en = ? COLLATE NOCASE LIMIT 1`
  ).get(nameEn);
  if (collision) {
    recordCollision(db, { recipeId, candidateIngredientId: collision.id, reason: 'name_collision' });
    return { action: 'collision', candidate_ingredient_id: collision.id, candidate_name: collision.name_en };
  }

  const result = materializeNew(db, { recipeId, name_en: nameEn, name_cn: nameCn, sku: skuVal, item_kind: 'food' });
  if (!result.ok) {
    // materializeNew's own guards fired (most likely sku_taken — the name
    // was clear but the SKU was not). Same discipline as a name collision:
    // record it, write nothing, let a human sort out which side is wrong.
    let candidateId = null;
    if (result.error === 'sku_taken' && skuVal) {
      const owner = db.prepare('SELECT id FROM ingredients WHERE sku = ?').get(skuVal);
      candidateId = owner ? owner.id : null;
    }
    recordCollision(db, { recipeId, candidateIngredientId: candidateId, reason: result.error || 'materialize_failed' });
    return { action: 'skipped', reason: result.error };
  }
  resolveOpenCollisions(db, recipeId);
  return { action: 'created', material_id: result.material_id };
}

// One open collision row per recipe — a repeat save of a still-colliding
// recipe must not pile up duplicates, since the count itself is not the
// signal, the existence is.
function recordCollision(db, { recipeId, candidateIngredientId, reason }) {
  const open = db.prepare(
    'SELECT id FROM recipe_materialize_collisions WHERE recipe_id = ? AND resolved_at IS NULL'
  ).get(recipeId);
  if (open) return;
  db.prepare(
    'INSERT INTO recipe_materialize_collisions (recipe_id, candidate_ingredient_id, reason) VALUES (?, ?, ?)'
  ).run(recipeId, candidateIngredientId, reason || 'name_collision');
}

// Closes whatever brought a recipe here, however it was closed — a rename
// off the colliding name, a human's own materializeLink/materializeNew, or
// (below) a save that no longer collides. Idempotent: a no-op once nothing
// is open.
function resolveOpenCollisions(db, recipeId) {
  db.prepare(
    'UPDATE recipe_materialize_collisions SET resolved_at = CURRENT_TIMESTAMP WHERE recipe_id = ? AND resolved_at IS NULL'
  ).run(recipeId);
}

module.exports = {
  linkedMaterialFor, materialConsumers, materializeNew, materializeLink, unlink,
  ensureMaterialized, recordCollision, resolveOpenCollisions,
};
