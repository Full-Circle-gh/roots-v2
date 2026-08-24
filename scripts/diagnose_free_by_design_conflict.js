#!/usr/bin/env node
/**
 * diagnose_free_by_design_conflict.js — does any ingredient claim to be free
 * AND carry a price at the same time?
 *
 * WHY THIS EXISTS
 * ---------------
 * `routes/waste.js` computeProductCost() (waste.js:14-49) selects
 * `ri.qty, ri.unit, i.cost_per_unit` and NEVER selects `i.free_by_design`.
 * Every other reader of recipe cost does honour the flag:
 *   lib/recipe-cost.js:52       isFree = !!i.master_free
 *   public/app.html:6486-6489   viewRecipe()
 *   public/app.html:7649-7652   showCostSheet()
 *
 * Today that omission is invisible ONLY because a free-by-design ingredient
 * also happens to have cost_per_unit = 0, and waste.js's
 * `if (ri.cost_per_unit && ri.qty)` skips zero-cost lines anyway — the same
 * numeric answer by coincidence, not by agreement.
 *
 * The two columns are independent. Nothing in the schema, no route, and no
 * form enforces that free_by_design=1 implies cost_per_unit=0. So the moment
 * one row holds both, waste cost counts an ingredient that every other screen
 * correctly treats as free — and the planned waste.js consolidation would
 * CHANGE a live money figure rather than being invisible.
 *
 * This asks that question before the refactor is written, not during it:
 *   - how many ingredients have free_by_design=1 AND cost_per_unit>0
 *   - which ones, by name, with the price they carry
 *   - how much recipe/waste exposure each one has (how many recipes use it)
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
console.log('run at (UTC): ' + new Date().toISOString());
console.log('');

const j = (label, obj) => console.log(label + ': ' + JSON.stringify(obj));

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · the shape of free_by_design across the whole table ══');
const shape = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM ingredients)                                        AS ingredients_total,
    (SELECT COUNT(*) FROM ingredients WHERE COALESCE(free_by_design,0) = 1)   AS flagged_free,
    (SELECT COUNT(*) FROM ingredients WHERE COALESCE(free_by_design,0) = 1
       AND COALESCE(cost_per_unit,0) > 0)                                     AS flagged_free_AND_priced,
    (SELECT COUNT(*) FROM ingredients WHERE COALESCE(free_by_design,0) = 1
       AND COALESCE(cost_per_unit,0) = 0)                                     AS flagged_free_and_zero,
    (SELECT COUNT(*) FROM ingredients WHERE COALESCE(free_by_design,0) = 0
       AND COALESCE(cost_per_unit,0) = 0)                                     AS not_flagged_and_zero_genuinely_missing
`).get();
j('free_by_design shape', shape);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 2 · THE ANSWER — rows that are free AND priced ══');
const conflict = db.prepare(`
  SELECT i.id, i.name_en, i.name_cn, i.sku, i.unit, i.cost_per_unit,
         i.item_kind, COALESCE(i.is_active,1) AS is_active,
         (SELECT COUNT(DISTINCT ri.recipe_id)
            FROM recipe_ingredients ri
            JOIN recipes r ON r.id = ri.recipe_id AND COALESCE(r.is_active,1) = 1
           WHERE ri.ingredient_id = i.id)                    AS used_in_active_recipes,
         (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.ingredient_id = i.id)
                                                             AS total_recipe_lines
    FROM ingredients i
   WHERE COALESCE(i.free_by_design,0) = 1
     AND COALESCE(i.cost_per_unit,0) > 0
   ORDER BY i.cost_per_unit DESC
`).all();
j('COUNT of free_by_design=1 AND cost_per_unit>0', { count: conflict.length });
if (conflict.length === 0) {
  console.log('        · NONE. The planned waste.js free_by_design fix is invisible on today\'s data:');
  console.log('        · every flagged-free ingredient also has cost_per_unit = 0, so waste.js\'s');
  console.log('        · `if (ri.cost_per_unit && ri.qty)` already skips exactly the rows the flag');
  console.log('        · would skip. The fix prevents a future divergence; it changes nothing now.');
} else {
  console.log('        · NONZERO — the waste.js fix WILL move real money figures. Rows:');
  for (const r of conflict) console.log('        · ' + JSON.stringify(r));
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// If any conflict row exists, quantify the blast radius: which PRODUCTS would
// see a different waste cost, since waste.js is the only reader that would
// change. A product is exposed when its recipe contains a conflicting line.
console.log('══ 3 · blast radius — products whose waste cost would change ══');
if (conflict.length === 0) {
  console.log('        · not applicable, no conflicting rows.');
} else {
  const ids = conflict.map(c => c.id);
  const exposed = db.prepare(`
    SELECT DISTINCT p.id, p.name_en, p.sku, p.recipe_id, r.name_en AS recipe_name
      FROM products p
      JOIN recipes r ON r.id = p.recipe_id
      JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE ri.ingredient_id IN (${ids.map(() => '?').join(',')})
     ORDER BY p.id
  `).all(...ids);
  j('products exposed via products.recipe_id', exposed);
  const wasteRows = db.prepare(`
    SELECT COUNT(*) AS n FROM waste_entries w
     WHERE w.product_id IN (SELECT DISTINCT p.id FROM products p
                              JOIN recipe_ingredients ri ON ri.recipe_id = p.recipe_id
                             WHERE ri.ingredient_id IN (${ids.map(() => '?').join(',')}))
  `).get(...ids);
  j('historical waste_entries rows against those products (already-written cost_lost, NOT retroactively changed)', wasteRows);
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// Context for reading the answer: what IS flagged free today, so a human can
// sanity-check that the flag is being used the way its schema comment says
// (schema.sql:56-60 — water, peel, anything the kitchen does not cost).
console.log('══ 4 · every flagged-free ingredient, for context ══');
const allFree = db.prepare(`
  SELECT i.id, i.name_en, i.name_cn, i.cost_per_unit, i.unit,
         (SELECT COUNT(DISTINCT ri.recipe_id)
            FROM recipe_ingredients ri
            JOIN recipes r ON r.id = ri.recipe_id AND COALESCE(r.is_active,1) = 1
           WHERE ri.ingredient_id = i.id) AS used_in_active_recipes
    FROM ingredients i
   WHERE COALESCE(i.free_by_design,0) = 1
   ORDER BY used_in_active_recipes DESC, i.name_en
`).all();
for (const r of allFree) console.log('        · ' + JSON.stringify(r));

console.log('\n══ done ══');
