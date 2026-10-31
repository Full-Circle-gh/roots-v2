#!/usr/bin/env node
/**
 * Restore recipe_ingredients / recipe_steps / recipe_cost_data from a
 * pre-wipe backup file into the current live DB. Safe to run multiple
 * times — INSERT OR IGNORE on (recipe_id, sort_order) for ingredients;
 * for steps + cost_data, wipes the recipe's own rows first then
 * re-inserts.
 *
 * Ingredient ID remapping: when an ingredient_id from the backup no
 * longer exists in the current DB (because the ingredients table was
 * re-imported with new IDs), we fall back to matching by SKU, then by
 * name_en, then by name_cn. Unresolvable rows are skipped + reported.
 *
 * Usage:
 *   node scripts/restore_recipe_data.js --backup=data/roots-pre-wipe-XXXX.db --dry-run
 *   node scripts/restore_recipe_data.js --backup=data/roots-pre-wipe-XXXX.db
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const backupArg = process.argv.find(a => a.startsWith('--backup='));
if (!backupArg) {
  console.error('Usage: --backup=path/to/roots-pre-wipe-*.db [--dry-run]');
  process.exit(1);
}
const BACKUP = path.resolve(backupArg.slice('--backup='.length));
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

const live = new Database(DB_PATH);
live.pragma('journal_mode = WAL');
const bak  = new Database(BACKUP, { readonly: true });

// Build ingredient lookup maps from CURRENT DB so we can remap ids that
// no longer exist (or whose row was replaced by a newer import).
const liveIngs   = live.prepare('SELECT id, sku, name_en, name_cn FROM ingredients').all();
const byId       = new Map(liveIngs.map(i => [i.id, i]));
const bySku      = new Map(liveIngs.filter(i => i.sku).map(i => [String(i.sku).toLowerCase().trim(), i]));
const byNameEn   = new Map(liveIngs.filter(i => i.name_en).map(i => [String(i.name_en).toLowerCase().trim(), i]));
const byNameCn   = new Map(liveIngs.filter(i => i.name_cn).map(i => [String(i.name_cn).toLowerCase().trim(), i]));

// Backup ingredient lookup so we can read the original SKU/name when
// the id-remap fallback fires.
const bakIngs = bak.prepare('SELECT id, sku, name_en, name_cn FROM ingredients').all();
const bakById = new Map(bakIngs.map(i => [i.id, i]));

// Backup recipe rows — only restore data for recipes that EXIST in the
// live DB (active OR soft-deleted). If a recipe was hard-wiped, no point
// trying to restore its children — they'd be orphans.
const liveRecipes = new Set(live.prepare('SELECT id FROM recipes').all().map(r => r.id));
const bakRecipes  = bak.prepare('SELECT * FROM recipes').all().filter(r => liveRecipes.has(r.id));
const skipped_recipes = bak.prepare('SELECT id, name_en FROM recipes').all().filter(r => !liveRecipes.has(r.id));

function resolveIngredient(bakIngId) {
  // Tier 1: same id still exists
  if (byId.has(bakIngId)) return { id: bakIngId, via: 'id' };
  // Tier 2: lookup backup row, try sku/name_en/name_cn against live
  const orig = bakById.get(bakIngId);
  if (!orig) return null;
  if (orig.sku) {
    const m = bySku.get(String(orig.sku).toLowerCase().trim());
    if (m) return { id: m.id, via: 'sku', original: orig };
  }
  if (orig.name_en) {
    const m = byNameEn.get(String(orig.name_en).toLowerCase().trim());
    if (m) return { id: m.id, via: 'name_en', original: orig };
  }
  if (orig.name_cn) {
    const m = byNameCn.get(String(orig.name_cn).toLowerCase().trim());
    if (m) return { id: m.id, via: 'name_cn', original: orig };
  }
  return null;
}

const stats = {
  recipesEligible: bakRecipes.length,
  recipesSkipped:  skipped_recipes.length,
  ingredientsRestored: 0, ingredientsRemapped: 0, ingredientsUnresolved: 0,
  stepsRestored: 0, costDataRestored: 0,
  unresolved: [],
};

// Stage 1: recipe_ingredients — table snapshots name_en/name_cn/sku at
// insert time, so even when ingredient_id no longer matches we keep the
// human-readable info.
const insertIng = live.prepare(`INSERT INTO recipe_ingredients
  (recipe_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, sort_order, substitutes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const wipeIngsForRecipe  = live.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?');
const wipeStepsForRecipe = live.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?');
const wipeCostForRecipe  = live.prepare('DELETE FROM recipe_cost_data WHERE recipe_id = ?');

const insertStep = live.prepare(`INSERT INTO recipe_steps
  (recipe_id, step_number, name, instructions)
  VALUES (?, ?, ?, ?)`);
const insertCost = live.prepare(`INSERT INTO recipe_cost_data
  (recipe_id, labour, packaging, packaging_type_id, overhead_pct, sell_price, target_food_cost)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

const tx = live.transaction(() => {
  for (const r of bakRecipes) {
    // Wipe the recipe's existing children (mostly empty — that's the bug)
    wipeIngsForRecipe.run(r.id);
    wipeStepsForRecipe.run(r.id);
    wipeCostForRecipe.run(r.id);

    // Restore recipe_ingredients. The table snapshots name_en/name_cn/sku
    // at insert time, so even if the ingredient_id can't be remapped we
    // still keep the human-readable line item — qty + unit + name. The
    // master_cost JOIN in the GET endpoint just shows "—" for missing
    // ingredient_id rows, which is the correct fallback.
    const bakRis = bak.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order').all(r.id);
    for (const ri of bakRis) {
      const resolved = ri.ingredient_id ? resolveIngredient(ri.ingredient_id) : null;
      if (resolved && resolved.via !== 'id') stats.ingredientsRemapped++;
      if (!resolved && ri.ingredient_id) {
        // Couldn't remap — keep the line but null out ingredient_id;
        // user gets a "missing master" indicator in the recipe view.
        stats.ingredientsUnresolved++;
        const orig = bakById.get(ri.ingredient_id);
        stats.unresolved.push({
          recipe: r.name_en, recipe_id: r.id,
          ingredient_id: ri.ingredient_id,
          original_name: orig?.name_en || ri.name_en || '?',
          original_sku:  orig?.sku || ri.sku || '?',
        });
      }
      insertIng.run(r.id, resolved?.id || null, ri.name_en, ri.name_cn, ri.sku,
                    ri.qty, ri.unit, ri.notes, ri.sort_order, ri.substitutes);
      stats.ingredientsRestored++;
    }

    // Restore recipe_steps
    const bakSteps = bak.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number').all(r.id);
    for (const s of bakSteps) {
      insertStep.run(r.id, s.step_number, s.name, s.instructions);
      stats.stepsRestored++;
    }

    // Restore recipe_cost_data (1:1 with recipe)
    const bakCost = bak.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(r.id);
    if (bakCost) {
      insertCost.run(r.id, bakCost.labour, bakCost.packaging, bakCost.packaging_type_id,
        bakCost.overhead_pct, bakCost.sell_price, bakCost.target_food_cost);
      stats.costDataRestored++;
    }
  }
});

if (DRY) {
  console.log(`DRY-RUN — would restore from ${BACKUP}:`);
  console.log(`  Recipes eligible (exist in live DB): ${stats.recipesEligible}`);
  console.log(`  Recipes skipped (not in live DB):    ${stats.recipesSkipped}`);
  // Preview ingredient resolution rate without writing
  let ok = 0, remapped = 0, missing = 0;
  for (const r of bakRecipes) {
    const bakRis = bak.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(r.id);
    for (const ri of bakRis) {
      const res = resolveIngredient(ri.ingredient_id);
      if (!res) missing++;
      else if (res.via === 'id') ok++;
      else remapped++;
    }
  }
  console.log(`  Ingredients direct match: ${ok}`);
  console.log(`  Ingredients remapped:     ${remapped}`);
  console.log(`  Ingredients unresolvable: ${missing}`);
  process.exit(0);
}

tx();
console.log(`✅ Recovery complete (from ${path.basename(BACKUP)})`);
console.log(`  Recipes processed:     ${stats.recipesEligible}`);
console.log(`  Recipes skipped:       ${stats.recipesSkipped}`);
console.log(`  Ingredients restored:  ${stats.ingredientsRestored} (${stats.ingredientsRemapped} via SKU/name remap)`);
console.log(`  Steps restored:        ${stats.stepsRestored}`);
console.log(`  Cost rows restored:    ${stats.costDataRestored}`);
if (stats.ingredientsUnresolved > 0) {
  console.log(`  ⚠ Unresolved ingredients (${stats.ingredientsUnresolved}) — these need manual re-entry:`);
  for (const u of stats.unresolved) {
    console.log(`     recipe='${u.recipe}' missing ingredient: '${u.original_name}' (sku=${u.original_sku})`);
  }
}
