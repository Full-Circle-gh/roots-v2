#!/usr/bin/env node
/**
 * diagnose_recipe_unit_mismatch.js — for ONE named recipe, name the exact
 * ingredient line(s) tripping the UNIT MISMATCH pill, with no guessing.
 *
 * WHY THIS EXISTS
 * ----------------
 * The pill (`lib/recipe-cost.js` buildLines() -> unreconciledUnitLines,
 * surfaced in `public/retail-admin/19-recipes.js`) is computed fresh on every
 * read — there is no cached flag to go stale. An operator who has visually set
 * every line's unit to match and still sees the pill is not looking at a bug;
 * they are looking at a line whose LINKED MATERIAL is still stocked in a unit
 * of a different dimension (mass vs volume vs count) than the line's own unit
 * — a fact that lives on the material's record, not on the recipe screen. This
 * prints exactly which line(s), reusing the SAME `buildLines()` the app runs,
 * so the answer cannot disagree with what the operator is seeing.
 *
 * READ-ONLY, and it proves it on the connection: the database is opened with
 * readonly:true and a write is attempted and required to fail before anything
 * else runs. Same contract as every other diagnose_* script here.
 *
 * Usage (via .github/workflows/ro-query.yml, workflow_dispatch):
 *   RECIPE_NAME='Roasted Pumpkin Soup' node scripts/diagnose_recipe_unit_mismatch.js
 *   RECIPE_ID=123 node scripts/diagnose_recipe_unit_mismatch.js
 * Defaults to 'Roasted Pumpkin Soup' when neither is set.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const RECIPE_NAME = process.env.RECIPE_NAME || 'Roasted Pumpkin Soup';
const RECIPE_ID = process.env.RECIPE_ID ? Number(process.env.RECIPE_ID) : null;

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}

const Database = loadSqlite();
const { buildLines, unitDimension } = require(path.join(HOME, 'lib', 'recipe-cost'));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting.');
  process.exit(2);
}

const recipes = RECIPE_ID
  ? db.prepare('SELECT * FROM recipes WHERE id = ?').all(RECIPE_ID)
  : db.prepare('SELECT * FROM recipes WHERE name_en LIKE ? OR name_cn LIKE ?')
      .all(`%${RECIPE_NAME}%`, `%${RECIPE_NAME}%`);

if (!recipes.length) {
  console.log(`No recipe found matching ${RECIPE_ID ? 'id ' + RECIPE_ID : JSON.stringify(RECIPE_NAME)}.`);
  process.exit(1);
}

const SQL_INGREDIENTS = `SELECT ri.*, i.name_en AS master_name_en, i.cost_per_unit AS master_cost,
       i.unit AS master_unit, i.free_by_design AS master_free
  FROM recipe_ingredients ri
  LEFT JOIN ingredients i ON ri.ingredient_id = i.id
 WHERE ri.recipe_id = ?
 ORDER BY ri.sort_order`;
const getIngs = db.prepare(SQL_INGREDIENTS);
const getMaterial = db.prepare('SELECT id, name_en, unit, cost_per_unit FROM ingredients WHERE source_recipe_id = ?');

for (const r of recipes) {
  console.log(`\n══ recipe ${r.id} "${r.name_en}" (active=${r.is_active}) ══`);
  const ings = getIngs.all(r.id);
  if (!ings.length) { console.log('  no ingredient lines'); continue; }

  const { lines, unreconciledUnitLines } = buildLines(ings);
  console.log(`  ${ings.length} ingredient line(s), unreconciledUnitLines=${unreconciledUnitLines}`);

  for (const l of lines) {
    const mark = l.unreconciledUnit ? '  <-- UNIT MISMATCH' : '';
    const lineDim = unitDimension(l.unit) || '(unrecognised)';
    const masterDim = unitDimension(l.masterUnit) || '(unrecognised)';
    console.log(`  - ${l.name || '(deleted material)'}: line unit "${l.unit}" (${lineDim})`
      + ` vs material unit "${l.masterUnit}" (${masterDim})`
      + `  ingredient_id=${l.ingredient_id ?? 'null'}${mark}`);
  }

  const mat = getMaterial.get(r.id);
  if (mat) {
    console.log(`  backs material #${mat.id} "${mat.name_en}": stocked in "${mat.unit}",`
      + ` cost_per_unit=${mat.cost_per_unit == null ? 'null' : mat.cost_per_unit}`);
  } else {
    console.log('  does not back any material');
  }
}
