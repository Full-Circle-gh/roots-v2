#!/usr/bin/env node
/**
 * diagnose_made_material_readiness.js — what does the live data say about
 * representing a recipe's output as a MATERIAL?
 *
 * Read-only. Answers the questions the nested-recipe planning pass turns on,
 * against production rather than against assumption:
 *
 *   1. Can a recipe even yield a per-unit cost today? costPerGram is
 *      batchCost / batch_size (lib/recipe-cost.js:163), so a recipe with no
 *      batch_size cannot produce one. How many are missing it?
 *   2. Are the recipes that COULD be made-materials actually costable — every
 *      line priced, or flagged free? A made material whose own cost is
 *      incomplete would publish a confidently wrong number.
 *   3. HAS THIS ALREADY BEEN DONE BY HAND? If an operator has been working
 *      round the missing feature, the same thing exists twice: once in
 *      `recipes` and once in `ingredients`. Name and SKU overlap between the
 *      two tables is the evidence, and it is also the migration list.
 *   4. What units do recipes and materials actually use? A made material needs
 *      a stocking/recipe unit, and the per-unit derivation is only meaningful
 *      if the recipe's batch_size is expressed in that same unit.
 *   5. How deep could nesting plausibly go, and how much work is a rollup?
 *      Reports the real line counts a recursive walk would traverse.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const { computeRecipeCost } = require(path.join(HOME, 'lib', 'recipe-cost.js'));

console.log('db: ' + DB_PATH);
console.log('run at (UTC): ' + new Date().toISOString());
const j = (l, o) => console.log(l + ': ' + JSON.stringify(o));
const note = (m) => console.log('        · ' + m);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · can a recipe yield a per-unit cost at all ══');
{
  const s = db.prepare(`
    SELECT
      COUNT(*)                                                      AS active_recipes,
      SUM(CASE WHEN COALESCE(batch_size,0) > 0 THEN 1 ELSE 0 END)   AS with_batch_size,
      SUM(CASE WHEN COALESCE(batch_size,0) = 0 THEN 1 ELSE 0 END)   AS without_batch_size,
      SUM(CASE WHEN COALESCE(servings,0)   > 0 THEN 1 ELSE 0 END)   AS with_servings,
      SUM(CASE WHEN COALESCE(batch_size,0) > 0 AND COALESCE(servings,0) > 0 THEN 1 ELSE 0 END) AS with_both
    FROM recipes WHERE COALESCE(is_active,1)=1
  `).get();
  j('active recipes / yield fields', s);
  note('a recipe with no batch_size cannot produce costPerGram (lib/recipe-cost.js:163)');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · are those recipes actually costable ══');
{
  const recipes = db.prepare('SELECT * FROM recipes WHERE COALESCE(is_active,1)=1 ORDER BY id').all();
  const getIngs = db.prepare(`SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
           i.free_by_design AS master_free
      FROM recipe_ingredients ri LEFT JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ? ORDER BY ri.sort_order`);
  const getCost = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?');
  let clean = 0, missing = 0, noLines = 0, noBatch = 0, derivable = 0;
  const perGram = [];
  for (const r of recipes) {
    const ings = getIngs.all(r.id);
    const c = computeRecipeCost({ recipe: r, ingredients: ings, costData: getCost.get(r.id) });
    if (!ings.length) { noLines++; continue; }
    if (c.zeroCostIngredientLines > 0) missing++; else clean++;
    if (!(c.batchSize > 0)) { noBatch++; continue; }
    if (c.zeroCostIngredientLines === 0 && c.costPerGram !== null) {
      derivable++;
      perGram.push({ id: r.id, name: (r.name_en || '').slice(0, 30), cpg: Math.round(c.costPerGram * 1e6) / 1e6, batch: c.batchSize, batchCost: Math.round(c.batchCost * 100) / 100 });
    }
  }
  j('costability of active recipes', {
    total: recipes.length, fully_priced: clean, has_missing_cost_lines: missing,
    no_ingredient_lines: noLines, no_batch_size: noBatch,
    FULLY_DERIVABLE_per_unit_cost: derivable,
  });
  note('"FULLY_DERIVABLE" = every line priced (or free by design) AND batch_size set —');
  note('the set that could become a made material with a defensible cost today.');
  perGram.sort((a, b) => b.cpg - a.cpg);
  note('highest and lowest per-unit costs, as a sanity check on the derivation:');
  for (const p of perGram.slice(0, 3)) note('  ' + JSON.stringify(p));
  if (perGram.length > 3) for (const p of perGram.slice(-2)) note('  ' + JSON.stringify(p));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · has an operator already done this by hand ══');
{
  // Same thing in both tables = the workaround this decision replaces.
  const byName = db.prepare(`
    SELECT r.id AS recipe_id, r.name_en AS recipe_name, r.sku AS recipe_sku,
           i.id AS ingredient_id, i.name_en AS ingredient_name, i.sku AS ingredient_sku,
           i.item_kind, i.cost_per_unit, i.buy_price,
           (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.ingredient_id = i.id) AS used_as_line
      FROM recipes r
      JOIN ingredients i
        ON LOWER(TRIM(r.name_en)) = LOWER(TRIM(i.name_en))
     WHERE COALESCE(r.is_active,1)=1 AND COALESCE(i.is_active,1)=1
     ORDER BY used_as_line DESC, r.id
  `).all();
  j('recipes whose name EXACTLY matches an ingredient name', { count: byName.length });
  for (const r of byName) note(JSON.stringify(r));
  if (!byName.length) note('none — the workaround has not been used, so there is nothing to migrate.');

  const bySku = db.prepare(`
    SELECT r.id AS recipe_id, r.sku, i.id AS ingredient_id, i.name_en
      FROM recipes r JOIN ingredients i ON r.sku IS NOT NULL AND r.sku = i.sku
  `).all();
  j('recipe SKU colliding with an ingredient SKU', { count: bySku.length, rows: bySku });
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · units — what a made material would have to be measured in ══');
{
  j('ingredients.unit distribution', db.prepare(
    `SELECT unit, COUNT(*) n FROM ingredients WHERE COALESCE(is_active,1)=1 GROUP BY unit ORDER BY n DESC`).all());
  j('recipe_ingredients.unit distribution', db.prepare(
    `SELECT unit, COUNT(*) n FROM recipe_ingredients GROUP BY unit ORDER BY n DESC`).all());
  j('ingredients.item_kind distribution', db.prepare(
    `SELECT COALESCE(item_kind,'food') k, COUNT(*) n FROM ingredients WHERE COALESCE(is_active,1)=1 GROUP BY 1 ORDER BY n DESC`).all());
  j('item_kind values the operator has defined (categories kind=item_kind)', db.prepare(
    `SELECT name FROM categories WHERE kind='item_kind' ORDER BY sort_order, name`).all().map(r => r.name));
  // An item_kind on a row that no longer exists in the lookup = already orphaned.
  const orphanKinds = db.prepare(`
    SELECT COALESCE(i.item_kind,'food') k, COUNT(*) n FROM ingredients i
     WHERE COALESCE(i.is_active,1)=1
       AND COALESCE(i.item_kind,'food') NOT IN (SELECT name FROM categories WHERE kind='item_kind')
     GROUP BY 1`).all();
  j('item_kind values on live rows with NO matching lookup row (already orphaned)', orphanKinds);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · the size of a rollup ══');
{
  const s = db.prepare(`
    SELECT (SELECT COUNT(*) FROM recipes WHERE COALESCE(is_active,1)=1)     AS recipes,
           (SELECT COUNT(*) FROM recipe_ingredients)                        AS lines,
           (SELECT COUNT(*) FROM ingredients WHERE COALESCE(is_active,1)=1) AS materials
  `).get();
  j('graph size today', s);
  const fan = db.prepare(`
    SELECT ri.ingredient_id, i.name_en, COUNT(DISTINCT ri.recipe_id) AS used_in_n_recipes
      FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
      JOIN recipes r ON r.id = ri.recipe_id AND COALESCE(r.is_active,1)=1
     GROUP BY ri.ingredient_id ORDER BY used_in_n_recipes DESC LIMIT 5`).all();
  j('most-shared materials (fan-out a memoised rollup would exploit)', fan);
  const t0 = process.hrtime.bigint();
  const recipes = db.prepare('SELECT * FROM recipes WHERE COALESCE(is_active,1)=1').all();
  const gi = db.prepare(`SELECT ri.*, i.cost_per_unit AS master_cost, i.free_by_design AS master_free
      FROM recipe_ingredients ri LEFT JOIN ingredients i ON ri.ingredient_id = i.id WHERE ri.recipe_id = ?`);
  const gc = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?');
  for (const r of recipes) computeRecipeCost({ recipe: r, ingredients: gi.all(r.id), costData: gc.get(r.id) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  j('cost EVERY active recipe once, flat (no recursion)', { ms: Math.round(ms * 10) / 10, recipes: recipes.length });
  note('a one-level-deep rollup costs about this again per level; memoising by');
  note('recipe id makes the whole graph one pass regardless of depth.');
}

console.log('\n══ done ══');
