#!/usr/bin/env node
/**
 * diagnose_made_material_line_cost.js — why does a made material cost a
 * DIFFERENT amount as an ingredient line than its own recipe says?
 *
 * REPORTED (Ash, 2026-09-09): the Garlic Dill Sour Cream recipe reads
 * ¥109.10 a batch, ¥9.09 a serving, and its material line reads ¥0.0417/g.
 * Adding that same material to another recipe produced ¥1.53 on the line,
 * which is not that per-gram figure times any quantity anybody typed.
 *
 * Every screen involved multiplies the SAME stored column — the recipe
 * header (19-recipes.js materialHtml), the picker
 * (GET /api/retail-admin/materials) and the line total (lineCostText) all
 * print `ingredients.cost_per_unit`. So a disagreement between them is not
 * arithmetic; it is either two different ROWS answering to one name, or a
 * stored figure that no longer matches what the recipe now computes.
 * This prints both, for every material whose name looks like a sour cream
 * and for every made material in the file.
 *
 * SECTIONS
 *   1. The recipe: row, resolved yield, computeRecipeCost figures.
 *   2. Its ingredient lines, each priced the way the editor prices them.
 *   3. Every ingredients row matching the name — duplicates are the first
 *      suspect, so they are printed whole, is_active included.
 *   4. Stored cost_per_unit vs. what computeRecipeCost says it should be,
 *      for EVERY recipe-backed material (a stale row anywhere is the same
 *      fault). Includes the quantity of each that would cost ¥1.53.
 *   5. Every recipe line that consumes one of the name-matched materials,
 *      with its own line cost.
 *
 * READ-ONLY, AND IT PROVES IT: the connection is opened readonly and a write
 * is attempted and required to fail before anything else runs — the same
 * contract as every other diagnose_* script here.
 *
 * Run via .github/workflows/ro-query.yml (workflow_dispatch).
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

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

const { computeRecipeCost } = require(path.join(HOME, 'lib', 'recipe-cost.js'));

console.log('db: ' + DB_PATH);
console.log('run at (UTC): ' + new Date().toISOString());
console.log('');

const j = (label, obj) => console.log(label + ': ' + JSON.stringify(obj));
const NAME = process.env.MATCH_NAME || 'Garlic Dill Sour Cream';
const TARGET = Number(process.env.TARGET_LINE_COST || 1.53);

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · the recipe ══');
const recipes = db.prepare(
  `SELECT * FROM recipes WHERE name_en LIKE ? OR name_cn LIKE ? ORDER BY id`
).all(`%${NAME}%`, `%${NAME}%`);
console.log('recipes matching "' + NAME + '": ' + recipes.length);
for (const r of recipes) {
  j('recipe', {
    id: r.id, sku: r.sku, name_en: r.name_en, name_cn: r.name_cn,
    is_active: r.is_active, batch_size: r.batch_size, batch_size_auto: r.batch_size_auto,
    servings: r.servings, servings_auto: r.servings_auto,
    serving_size: r.serving_size, updated_at: r.updated_at,
  });
  const c = computeRecipeCost(r.id, db);
  if (!c) { console.log('  computeRecipeCost returned null'); continue; }
  j('  computed', {
    batchSize: c.batchSize, batchSizeAuto: c.batchSizeAuto,
    servings: c.servings, servingsAuto: c.servingsAuto,
    ingredientCost: c.ingredientCost, labour: c.labour,
    overheadAmount: c.overheadAmount, packagingTotal: c.packagingTotal,
    batchCost: c.batchCost, costPerServing: c.costPerServing,
    costPerGram: c.costPerGram, materialCostPerGram: c.materialCostPerGram,
    zeroCostIngredientLines: c.zeroCostIngredientLines,
    unreconciledUnitLines: c.unreconciledUnitLines,
  });
  console.log('');
  console.log('══ 2 · its lines, priced as the editor prices them ══');
  for (const l of c.lines) {
    j('  line', {
      ingredient_id: l.ingredient_id, name: l.name_en || l.master_name_en,
      qty: l.qty, unit: l.unit, master_unit: l.master_unit,
      master_cost: l.master_cost, lineCost: l.lineCost, in_yield: l.in_yield,
    });
  }
  console.log('');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 3 · every ingredients row answering to that name ══');
const mats = db.prepare(
  `SELECT id, name_en, name_cn, sku, category, unit, buy_unit, buy_pack_size,
          pack_contents_qty, pack_contents_unit, cost_per_unit, overhead_per_unit,
          buy_price, free_by_design, is_active, item_kind, source_recipe_id, updated_at
     FROM ingredients
    WHERE name_en LIKE ? OR name_cn LIKE ?
    ORDER BY name_en COLLATE NOCASE, id`
).all(`%${NAME}%`, `%${NAME}%`);
console.log('rows: ' + mats.length);
for (const m of mats) {
  j('  material', m);
  if (Number(m.cost_per_unit) > 0) {
    console.log(`    → ${TARGET} at this rate is ${(TARGET / Number(m.cost_per_unit)).toFixed(2)} ${m.unit || '?'}`);
  }
}
console.log('');

// A wider net: anything whose per-unit cost, times a round-ish quantity, lands
// on the reported figure. Printed so the number can be traced to a ROW rather
// than guessed at.
console.log('══ 3b · materials whose rate would make ' + TARGET + ' out of 1–1000 units ══');
const all = db.prepare(
  `SELECT id, name_en, unit, cost_per_unit, source_recipe_id, is_active
     FROM ingredients WHERE cost_per_unit > 0`
).all();
for (const m of all) {
  const q = TARGET / Number(m.cost_per_unit);
  if (q >= 1 && q <= 1000 && Math.abs(q - Math.round(q)) < 0.02) {
    j('  candidate', { ...m, qty_for_target: Math.round(q) });
  }
}
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 4 · stored cost_per_unit vs. what the recipe now computes ══');
const made = db.prepare(
  `SELECT i.id, i.name_en, i.unit, i.cost_per_unit, i.overhead_per_unit, i.source_recipe_id,
          r.name_en AS recipe_name, r.is_active AS recipe_active
     FROM ingredients i JOIN recipes r ON r.id = i.source_recipe_id
    WHERE i.is_active = 1 ORDER BY i.name_en COLLATE NOCASE`
).all();
console.log('recipe-backed materials: ' + made.length);
let drifted = 0;
for (const m of made) {
  const c = computeRecipeCost(m.source_recipe_id, db);
  const should = c ? c.materialCostPerGram : null;
  const stored = Number(m.cost_per_unit) || 0;
  const off = should === null ? null : Math.abs(should - stored);
  const bad = off !== null && stored > 0 && off / Math.max(stored, 1e-9) > 0.01;
  if (bad) drifted++;
  if (bad || (mats.some(x => x.id === m.id))) {
    j('  material', {
      id: m.id, name: m.name_en, unit: m.unit, recipe: m.recipe_name,
      stored_cost_per_unit: stored, computed_material_cost_per_gram: should,
      batchCost: c ? c.batchCost : null, batchSize: c ? c.batchSize : null,
      drift_pct: (off !== null && stored > 0) ? +(off / stored * 100).toFixed(2) : null,
    });
  }
}
console.log('drifted (stored more than 1% from computed): ' + drifted);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 5 · every recipe line consuming one of those materials ══');
if (mats.length) {
  const ids = mats.map(m => m.id);
  const rows = db.prepare(
    `SELECT ri.recipe_id, r.name_en AS recipe_name, r.is_active AS recipe_active,
            ri.ingredient_id, i.name_en AS material, ri.qty AS qty, ri.unit,
            i.unit AS master_unit, i.cost_per_unit
       FROM recipe_ingredients ri
       JOIN ingredients i ON i.id = ri.ingredient_id
       LEFT JOIN recipes r ON r.id = ri.recipe_id
      WHERE ri.ingredient_id IN (${ids.map(() => '?').join(',')})
      ORDER BY r.name_en COLLATE NOCASE`
  ).all(...ids);
  console.log('lines: ' + rows.length);
  for (const l of rows) {
    j('  line', { ...l, line_cost: +(Number(l.qty || 0) * Number(l.cost_per_unit || 0)).toFixed(4) });
  }
} else {
  console.log('no matching materials, so no lines to show');
}
console.log('');
console.log('done.');
