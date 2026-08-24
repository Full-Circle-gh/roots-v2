#!/usr/bin/env node
/**
 * Read-only recipe volume/orphan survey — the row counts docs/tacet-recipe-
 * schema-survey.md could not get because no database was attached to that
 * session. Answers, in order:
 *
 *   0. Row counts: recipes, recipe_ingredients, recipe_steps, recipe_cost_data,
 *      production_batches, categories WHERE kind='recipe'.
 *   1. Active vs archived recipes (recipes.is_active).
 *   2. products.recipe_id: how many products reference a recipe, split into
 *      "points at a live recipe", "points at an archived recipe (is_active=0
 *      but the row exists)", and "points at nothing (no matching recipes.id
 *      at all — true dangling)".
 *   3. Orphans in recipe_ingredients: ingredient_id pointing at a soft-deleted
 *      ingredient vs. at no ingredient row at all; recipe_id pointing at no
 *      recipe row at all (should be structurally impossible — CASCADE — this
 *      checks that it actually is) vs. at an archived recipe.
 *   4. Ingredient-count distribution per recipe: min / max / median, computed
 *      over recipes that have at least one line, both for active recipes only
 *      and for all recipes (so a zero-ingredient recipe isn't silently folded
 *      into "typical").
 *   5. Date range of recipes.created_at.
 *   6. The 10-vs-13 category question: full list + count of
 *      categories WHERE kind='recipe', compared against the server seed list
 *      (database.js:760) and the drifted client fallback list (app.html:2286).
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted — same contract as every
 * other diagnose_* script in this directory.
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without querying anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);
console.log('run at (UTC): ' + new Date().toISOString());
console.log('');

const j = (label, obj) => console.log(label + ': ' + JSON.stringify(obj));

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · row counts ══');
const counts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM recipes)                              AS recipes,
    (SELECT COUNT(*) FROM recipe_ingredients)                   AS recipe_ingredients,
    (SELECT COUNT(*) FROM recipe_steps)                         AS recipe_steps,
    (SELECT COUNT(*) FROM recipe_cost_data)                     AS recipe_cost_data,
    (SELECT COUNT(*) FROM production_batches)                   AS production_batches,
    (SELECT COUNT(*) FROM categories WHERE kind = 'recipe')     AS recipe_categories
`).get();
j('counts', counts);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · active vs archived recipes ══');
const activeSplit = db.prepare(`
  SELECT COALESCE(is_active, 1) AS is_active, COUNT(*) AS n
  FROM recipes GROUP BY 1 ORDER BY 1 DESC
`).all();
j('recipes by is_active', activeSplit);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 2 · products.recipe_id ══');
const productLink = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM products WHERE recipe_id IS NOT NULL) AS products_with_recipe_id,
    (SELECT COUNT(*) FROM products p WHERE recipe_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM recipes r WHERE r.id = p.recipe_id AND COALESCE(r.is_active,1)=1))
                                                                  AS points_at_live_recipe,
    (SELECT COUNT(*) FROM products p WHERE recipe_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM recipes r WHERE r.id = p.recipe_id AND COALESCE(r.is_active,1)=0))
                                                                  AS points_at_archived_recipe,
    (SELECT COUNT(*) FROM products p WHERE recipe_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.id = p.recipe_id))
                                                                  AS points_at_no_such_recipe_true_dangling,
    (SELECT COUNT(DISTINCT recipe_id) FROM products WHERE recipe_id IS NOT NULL)
                                                                  AS distinct_recipes_referenced
`).get();
j('products.recipe_id', productLink);
if (productLink.points_at_no_such_recipe_true_dangling > 0) {
  const dangling = db.prepare(`
    SELECT p.id, p.name_en, p.recipe_id, p.is_active FROM products p
    WHERE p.recipe_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.id = p.recipe_id)
    ORDER BY p.id
  `).all();
  j('dangling product rows (recipe_id points at nothing)', dangling);
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 3 · orphans in recipe_ingredients ══');
const ingOrphans = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM recipe_ingredients) AS total_lines,
    (SELECT COUNT(*) FROM recipe_ingredients WHERE ingredient_id IS NULL) AS ingredient_id_null,
    (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.ingredient_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.id = ri.ingredient_id))
                                                                  AS ingredient_id_no_such_row,
    (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.ingredient_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM ingredients i WHERE i.id = ri.ingredient_id AND COALESCE(i.is_active,1)=0))
                                                                  AS ingredient_id_archived,
    (SELECT COUNT(*) FROM recipe_ingredients ri
       WHERE NOT EXISTS (SELECT 1 FROM recipes r WHERE r.id = ri.recipe_id))
                                                                  AS recipe_id_no_such_row_should_be_zero_cascade,
    (SELECT COUNT(*) FROM recipe_ingredients ri
       WHERE EXISTS (SELECT 1 FROM recipes r WHERE r.id = ri.recipe_id AND COALESCE(r.is_active,1)=0))
                                                                  AS recipe_id_archived
`).get();
j('recipe_ingredients orphans', ingOrphans);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 4 · ingredient-count distribution per recipe ══');
function distribution(rows) {
  const counts = rows.map(r => r.n).sort((a, b) => a - b);
  if (!counts.length) return { n_recipes: 0, min: null, max: null, median: null, mean: null };
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return { n_recipes: counts.length, min: counts[0], max: counts[counts.length - 1], median, mean: Math.round(mean * 100) / 100 };
}
const perRecipeActive = db.prepare(`
  SELECT r.id, COUNT(ri.id) AS n
  FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
  WHERE COALESCE(r.is_active,1) = 1
  GROUP BY r.id
`).all();
const perRecipeAll = db.prepare(`
  SELECT r.id, COUNT(ri.id) AS n
  FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
  GROUP BY r.id
`).all();
j('active recipes — ingredient count distribution (incl. zero-ingredient recipes)', distribution(perRecipeActive));
j('active recipes — ingredient count distribution (EXCLUDING zero-ingredient recipes)', distribution(perRecipeActive.filter(r => r.n > 0)));
j('all recipes (incl. archived) — ingredient count distribution', distribution(perRecipeAll));
const zeroIngActive = perRecipeActive.filter(r => r.n === 0).length;
j('active recipes with zero ingredient lines', { count: zeroIngActive });
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 5 · date range of recipe creation ══');
const dateRange = db.prepare(`
  SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest, COUNT(*) AS n
  FROM recipes WHERE created_at IS NOT NULL
`).get();
j('recipes.created_at range', dateRange);
const byMonth = db.prepare(`
  SELECT substr(created_at,1,7) AS month, COUNT(*) AS n
  FROM recipes WHERE created_at IS NOT NULL
  GROUP BY 1 ORDER BY 1
`).all();
j('recipes created per month', byMonth);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 6 · categories WHERE kind=\'recipe\' — the 10-vs-13 question ══');
const liveCats = db.prepare(`
  SELECT id, name, sort_order FROM categories WHERE kind = 'recipe' ORDER BY sort_order, name
`).all();
j('live recipe categories', liveCats);
j('live recipe category count', { count: liveCats.length });

const SERVER_SEED = ['Dips & Spreads 酱料','Salads 沙拉','Hot Dishes 热菜','Cold Dishes 冷菜','Baked Goods 烘焙','Beverages 饮料','Snacks 小食','Sauces & Condiments 调味','Desserts 甜点','Other 其他'];
const CLIENT_FALLBACK = ['Dips & Spreads 酱料', 'Salads 沙拉', 'Hot Dishes 热菜', 'Cold Dishes 冷菜','Baked Goods 烘焙', 'Beverages 饮料', 'Sauces 调味汁', 'Desserts 甜品','Breads 面包', 'Snacks 小食'];
const liveNames = new Set(liveCats.map(c => c.name));
j('present in live but NOT in server-seed list (database.js:760)', SERVER_SEED.filter(n => !liveNames.has(n)).length ? [...liveNames].filter(n => !SERVER_SEED.includes(n)) : []);
j('server-seed entries missing from live (deleted since seed?)', SERVER_SEED.filter(n => !liveNames.has(n)));
j('matches client fallback list (app.html:2286) instead of server seed?', {
  exactly_matches_server_seed: JSON.stringify(liveCats.map(c=>c.name)) === JSON.stringify(SERVER_SEED),
  exactly_matches_client_fallback: JSON.stringify(liveCats.map(c=>c.name)) === JSON.stringify(CLIENT_FALLBACK),
});

// Which recipe.category values are actually IN USE, including any that
// don't match a categories row at all (typed free text, category deleted
// since, or imported data) — the category column is not FK'd.
const catsInUse = db.prepare(`
  SELECT category, COUNT(*) AS n FROM recipes
  WHERE COALESCE(is_active,1)=1 AND category IS NOT NULL AND category != ''
  GROUP BY category ORDER BY n DESC
`).all();
j('recipe.category values actually in use on active recipes', catsInUse);
j('in-use category values with NO matching categories row (free text / orphaned)', catsInUse.filter(c => !liveNames.has(c.category)).map(c => c.category));

console.log('\n══ done ══');
