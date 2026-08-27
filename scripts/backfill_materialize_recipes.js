#!/usr/bin/env node
/**
 * Backfill: give every active recipe the materials row §29's third addendum
 * says it should already have.
 *
 * WHY THIS EXISTS. ensureMaterialized() (lib/recipe-materialize.js) runs after
 * every recipe create/update, so a recipe saved since that shipped has a
 * material and one saved before it does not. A product's build list can only
 * point at a made thing once that thing has a materials row, so the build-list
 * screen's recipe bridge dead-ends on every recipe nobody has re-saved —
 * "Open the recipe and save it once". 138 active recipes, 31 with a material.
 * Asking an operator to open and save 107 recipes by hand to clear that is the
 * work this script does instead.
 *
 * IT CALLS ensureMaterialized() ITSELF — it does not re-implement it. The
 * outcome is byte-for-byte what opening each recipe and pressing Save would
 * have produced, including the collision discipline: a recipe whose name (or
 * SKU) already belongs to some other material writes NOTHING and is recorded
 * in recipe_materialize_collisions for a human, per §29's first addendum.
 * That is the point, not a limitation — see the report this prints.
 *
 * Read-only by default. Run ON THE SERVER:
 *   node scripts/backfill_materialize_recipes.js            # dry run / report
 *   node scripts/backfill_materialize_recipes.js --write    # do it
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const { ensureMaterialized, linkedMaterialFor } = require(path.join(__dirname, '..', 'lib', 'recipe-materialize'));

const recipes = db.prepare(
  `SELECT id, name_en, name_cn, sku FROM recipes
    WHERE is_active = 1 AND TRIM(COALESCE(name_en,'')) <> '' ORDER BY id`
).all();

// A one-line recipe whose only line IS the material it is named after is a
// REPACK — "one bag holds 120g of the bulk we already buy". It is not a new
// made thing, and it is exactly the shape that collides on name. Named here
// so the report can tell that case apart from a real unresolved collision:
// the answer for a repack is never "link these two" (that would be a cycle),
// it is "the product's build list should point at the bulk material direct".
const repackOf = db.prepare(`
  SELECT i.id, i.name_en FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
   WHERE ri.recipe_id = ? AND (SELECT COUNT(*) FROM recipe_ingredients x WHERE x.recipe_id = ri.recipe_id) = 1
     AND i.name_en = (SELECT name_en FROM recipes WHERE id = ri.recipe_id) COLLATE NOCASE`);

const out = { created: [], updated: [], collision: [], repack: [], skipped: [] };

const run = db.transaction(() => {
  for (const r of recipes) {
    if (!WRITE) {
      // Predict without writing, using the same three questions
      // ensureMaterialized asks, in the same order.
      const linked = linkedMaterialFor(db, r.id);
      if (linked) { out.updated.push({ r, note: linked.name_en }); continue; }
      const clash = db.prepare('SELECT id, name_en FROM ingredients WHERE name_en = ? COLLATE NOCASE LIMIT 1').get(r.name_en.trim());
      if (clash) {
        const rp = repackOf.get(r.id);
        (rp ? out.repack : out.collision).push({ r, note: clash.name_en + ' #' + clash.id });
        continue;
      }
      const sku = r.sku && String(r.sku).trim();
      const skuOwner = sku ? db.prepare('SELECT id, name_en FROM ingredients WHERE sku = ?').get(sku) : null;
      if (skuOwner) { out.collision.push({ r, note: 'SKU ' + sku + ' held by ' + skuOwner.name_en + ' #' + skuOwner.id }); continue; }
      out.created.push({ r, note: '' });
      continue;
    }
    const res = ensureMaterialized(db, r.id);
    if (res.action === 'created') out.created.push({ r, note: '#' + res.material_id });
    else if (res.action === 'updated') out.updated.push({ r, note: '#' + res.material_id });
    else if (res.action === 'collision') {
      const rp = repackOf.get(r.id);
      (rp ? out.repack : out.collision).push({ r, note: res.candidate_name + ' #' + res.candidate_ingredient_id });
    } else out.skipped.push({ r, note: res.reason || '' });
  }
});

run();

function section(title, rows) {
  console.log('\n' + title + '  (' + rows.length + ')');
  for (const { r, note } of rows) console.log('   #' + r.id + '  ' + r.name_en + (note ? '   → ' + note : ''));
}

console.log((WRITE ? 'WROTE' : 'DRY RUN — nothing written') + '   ' + recipes.length + ' active recipes');
section('Material created', out.created);
section('Already had one (names kept in sync)', out.updated);
section('REPACK — recipe is one line of the bulk it is named after; do NOT materialise', out.repack);
section('COLLISION — a human decides: link, or rename one side', out.collision);
section('Skipped', out.skipped);
db.close();
