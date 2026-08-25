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

  try {
    const result = db.prepare(`INSERT INTO ingredients
      (name_en, name_cn, sku, unit, item_kind, cost_per_unit, buy_price, source_recipe_id)
      VALUES (?, ?, ?, 'g', ?, 0, 0, ?)`)
      .run(nameEn, nameCn, skuVal, kind, recipeId);
    const materialId = result.lastInsertRowid;
    const rollup = fireRecompute(db, { source: 'retail-recipes.materialize_new', recipe_id: recipeId });
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

module.exports = { linkedMaterialFor, materializeNew, materializeLink, unlink };
