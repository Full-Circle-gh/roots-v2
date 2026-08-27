#!/usr/bin/env node
/**
 * test_recipe_materialize.js — does the §29 step 5 "make available as
 * material" action (lib/recipe-materialize.js) actually guard what it claims
 * to, in both directions?
 *
 * Mutation-tested the same way scripts/test_recipe_graph_cycles.js tested the
 * original cycle guard and scripts/test_recipe_rollup_apply.js tested the
 * write half of the rollup: every REFUSAL case is paired with the nearby
 * happy-path case that must still be ALLOWED, so a guard that rejects
 * everything (or never fires at all) both show up as failures here — a
 * guard that never fires passes a happy-path-only test, which is exactly
 * what this file refuses to be.
 *
 * Covers, against the real exported functions (not a re-implementation):
 *   - materializeNew: creates a linked material, refuses a second link on the
 *     same recipe, refuses an empty name, refuses (and names) a SKU clash.
 *   - materializeLink, guard 1 (already linked elsewhere): refuses and names
 *     the actual recipe that already owns the link.
 *   - materializeLink, guard 2 (unit mismatch): refuses and names the actual
 *     non-gram unit; a gram-unit candidate is allowed.
 *   - materializeLink, the cycle guard (checkMaterializeCycle): direct
 *     self-consumption, a two-hop loop, and — the case that catches an
 *     over-eager guard — a diamond dependency that is NOT a loop and MUST be
 *     allowed.
 *   - The soft warning: fires on a nonzero buy_price, fires on purchase
 *     history alone (buy_price 0), and is silent (null) when neither is true
 *     — in all three cases the link itself still succeeds.
 *   - The rollup is actually called, not bypassed: a costable recipe produces
 *     a real cost_per_unit; a blocked recipe (no batch_size) leaves the
 *     material's cost at 0 AND reports blocked via costOneRecipe — the
 *     signal the record screen's "never reads as free" banner depends on.
 *   - unlink: detaches without deleting the row, and other recipes' lines
 *     referencing that material are untouched.
 *
 * In-memory fixture only. No real database, no network, no writes outside
 * this process's own :memory: handle.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not.
 */
'use strict';

const path = require('path');
function loadSqlite() {
  try { return require('better-sqlite3'); } catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); } catch (e) { /* next */ }
  }
  console.error('better-sqlite3 not found — run from the main checkout or the box.');
  process.exit(2);
}
const Database = loadSqlite();
const { materializeNew, materializeLink, unlink } =
  require(path.join(__dirname, '..', 'lib', 'recipe-materialize'));
const { costOneRecipe } = require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT,
      batch_size REAL, servings INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name_en TEXT, name_cn TEXT, sku TEXT UNIQUE,
      unit TEXT DEFAULT 'g', cost_per_unit REAL DEFAULT 0, buy_price REAL DEFAULT 0,
      free_by_design INTEGER DEFAULT 0, item_kind TEXT DEFAULT 'food',
      -- materializeNew files a made material under a category (2026-08-27);
      -- the real table has always had this column, the fixture had not.
      category TEXT,
      source_recipe_id INTEGER, is_active INTEGER DEFAULT 1, updated_at TEXT);
    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER, ingredient_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, qty REAL, unit TEXT DEFAULT 'g', sort_order INTEGER DEFAULT 0);
    CREATE TABLE recipe_cost_data (
      recipe_id INTEGER PRIMARY KEY, labour REAL DEFAULT 0, packaging REAL DEFAULT 0,
      overhead_pct REAL DEFAULT 0, sell_price REAL DEFAULT 0, target_food_cost REAL DEFAULT 30,
      updated_at TEXT);
    CREATE TABLE po_line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER);
    -- materializeNew/materializeLink's success paths call resolveOpenCollisions()
    -- as of the §29 auto-materialize addendum (2026-08-27) — see
    -- scripts/test_recipe_materialize_auto.js for that mechanism's own tests.
    CREATE TABLE recipe_materialize_collisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER NOT NULL,
      candidate_ingredient_id INTEGER, reason TEXT NOT NULL DEFAULT 'name_collision',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT);
  `);
  return db;
}
// recipes: [id, batchSize, servings, active]
// materials: [id, unit, cpu, buyPrice, sourceRecipeId]
// lines: [recipeId, ingredientId, qty]
function seed(db, { recipes = [], materials = [], lines = [], poLines = [] }) {
  const r = db.prepare('INSERT INTO recipes (id,name_en,batch_size,servings,is_active) VALUES (?,?,?,?,?)');
  const m = db.prepare("INSERT INTO ingredients (id,name_en,unit,cost_per_unit,buy_price,source_recipe_id,updated_at) VALUES (?,?,?,?,?,?,'seed')");
  const l = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)');
  const p = db.prepare('INSERT INTO po_line_items (ingredient_id) VALUES (?)');
  for (const [id, batch, servings, active] of recipes) r.run(id, 'Recipe ' + id, batch === undefined ? null : batch, servings === undefined ? null : servings, active === undefined ? 1 : active);
  for (const [id, unit, cpu, buyPrice, src] of materials) m.run(id, 'Material ' + id, unit || 'g', cpu || 0, buyPrice || 0, src === undefined ? null : src);
  let i = 0;
  for (const [rid, iid, qty] of lines) l.run(rid, iid, 'line', qty === undefined ? 100 : qty, 'g', i++);
  for (const iid of poLines) p.run(iid);
  return db;
}
const ingRow = (db, id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  materializeNew
// ═══════════════════════════════════════════════════════════════════════════

// 1 · happy path — creates a linked, gram-unit material.
{
  const db = seed(makeDb(), { recipes: [[1, 2000, 10, 1]] });
  const res = materializeNew(db, { recipeId: 1, name_en: 'New Material' });
  check('materializeNew: happy path succeeds', res.ok, true, JSON.stringify(res));
  if (res.ok) {
    const row = ingRow(db, res.material_id);
    check('materializeNew: unit fixed at g', row.unit, 'g');
    check('materializeNew: source_recipe_id set', row.source_recipe_id, 1);
    check('materializeNew: item_kind defaults to food', row.item_kind, 'food');
    // Filed under the category Roots already uses for made materials — 26 of
    // 31 live rows sat there while the 4 this function created sat blank,
    // invisible to the Materials screen's category filter.
    check('materializeNew: filed under the made-material category', row.category, 'Kitchen Recipes 厨房自制');
  }
  db.close();
}

// 2 · refuses a second material on a recipe that already backs one.
{
  const db = seed(makeDb(), { recipes: [[1, 2000, 10, 1]], materials: [[10, 'g', 5, 0, 1]] });
  const res = materializeNew(db, { recipeId: 1, name_en: 'Duplicate' });
  check('materializeNew: refuses when recipe already backs a material', res.ok, false);
  check('materializeNew: names the existing material in the refusal', !res.ok && /Material 10/.test(res.message), true, res.message);
  db.close();
}

// 3 · refuses an empty name.
{
  const db = seed(makeDb(), { recipes: [[1, 2000, 10, 1]] });
  const res = materializeNew(db, { recipeId: 1, name_en: '   ' });
  check('materializeNew: refuses an empty name', res.ok, false);
  db.close();
}

// 4 · SKU clash names the actual owner.
{
  const db = seed(makeDb(), { recipes: [[1, 2000, 10, 1]], materials: [[10, 'g', 5, 0, null]] });
  db.prepare("UPDATE ingredients SET sku='DUP-1' WHERE id=10").run();
  const res = materializeNew(db, { recipeId: 1, name_en: 'Clashing', sku: 'DUP-1' });
  check('materializeNew: refuses a SKU clash', res.ok, false);
  check('materializeNew: names the actual SKU owner', !res.ok && /Material 10/.test(res.message), true, res.message);
  db.close();
}

// 5 · a costable recipe produces a real computed cost, via the rollup — not a
//    direct write. (400g batch, one 100g line at ¥2/g -> ¥200 batch -> ¥0.5/g.)
{
  const db = seed(makeDb(), {
    recipes: [[1, 400, null, 1], [99, null, null, 1]],
    materials: [[50, 'g', 2, 0, null]],
    lines: [[1, 50, 100]],
  });
  const res = materializeNew(db, { recipeId: 1, name_en: 'Costable Output' });
  check('materializeNew: costable recipe -> rollup applies', res.ok && res.rollup && res.rollup.applied, true, JSON.stringify(res.rollup));
  if (res.ok) {
    const row = ingRow(db, res.material_id);
    check('materializeNew: real cost_per_unit written via the rollup', row.cost_per_unit, 0.5, `row=${JSON.stringify(row)}`);
  }
  db.close();
}

// 6 · a BLOCKED recipe (no batch_size) leaves the material's cost at 0 and
//    reports blocked — this is what the record screen's "never reads as
//    free" banner depends on. It must NOT throw, and must NOT invent a cost.
{
  const db = seed(makeDb(), {
    recipes: [[1, null, null, 1]],  // no batch_size
    materials: [[50, 'g', 2, 0, null]],
    lines: [[1, 50, 100]],
  });
  const res = materializeNew(db, { recipeId: 1, name_en: 'Blocked Output' });
  check('materializeNew: blocked recipe still succeeds (rollup does not throw)', res.ok, true, JSON.stringify(res));
  if (res.ok) {
    const row = ingRow(db, res.material_id);
    check('materializeNew: blocked material stays at cost 0, not invented', row.cost_per_unit, 0);
    const state = costOneRecipe(db, 1, new Map());
    check('materializeNew: blocked state is detectable (costOneRecipe.ok=false)', state.ok, false, `reason=${state.reason}`);
  }
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  materializeLink — guard 1: already linked elsewhere
// ═══════════════════════════════════════════════════════════════════════════

// 7 · refuses, naming the recipe that actually owns the link.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1], [2, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, 2]],   // material 10 already backs recipe 2
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink guard1: refuses a material already linked elsewhere', res.ok, false);
  check('materializeLink guard1: names the actual owning recipe', !res.ok && /Recipe 2/.test(res.message), true, res.message);
  db.close();
}

// 8 · the paired happy path: an UNLINKED gram material links cleanly.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink guard1 (paired happy path): unlinked material links', res.ok, true, JSON.stringify(res));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  materializeLink — guard 2: unit mismatch
// ═══════════════════════════════════════════════════════════════════════════

// 9 · refuses a non-gram material, naming the actual unit.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'ml', 5, 0, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink guard2: refuses a non-gram material', res.ok, false);
  check('materializeLink guard2: names the actual unit (ml)', !res.ok && /per ml/.test(res.message), true, res.message);
  db.close();
}

// 10 · the paired happy path: a gram material is allowed through guard 2.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink guard2 (paired happy path): gram material passes', res.ok, true, JSON.stringify(res));
  db.close();
}

// 11 · pcs is refused too — not a special case, the same guard.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'pcs', 5, 0, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink guard2: refuses pcs the same as ml', res.ok, false);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  materializeLink — the cycle guard (checkMaterializeCycle, via materializeLink)
// ═══════════════════════════════════════════════════════════════════════════

// 12 · direct self-consumption: recipe 1 already has material 10 as a line;
//     linking 10 to recipe 1 would mean "R1 needs M10 to make M10".
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, null]],
    lines: [[1, 10, 50]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink cycle: direct self-consumption REFUSED', res.ok, false, res.message);
  db.close();
}

// 13 · two-hop loop. R1 -> R2 already exists (R1 consumes M10, made by R2).
//     R2 consumes M20 (unlinked). Linking M20 to R1 would add the edge
//     R2 -> R1 (R2 would now need R1 to get M20), closing R1 -> R2 -> R1.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1], [2, 2000, 10, 1]],
    materials: [
      [10, 'g', 5, 0, 2],    // M10 made by R2 -> edge R1->R2 (R1 consumes M10)
      [20, 'g', 5, 0, null], // unlinked, consumed by R2
    ],
    lines: [[1, 10, 50], [2, 20, 50]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 20 });
  check('materializeLink cycle: two-hop loop REFUSED', res.ok, false, res.message);
  db.close();
}

// 14 · diamond dependency — NOT a loop, MUST be allowed. R3 and R4 both
//     consume M10 (both depend on R1, made by... wait M10 unlinked here);
//     construct: R1 makes nothing yet. R3 consumes M_a (made by R1) and R4
//     consumes M_a too — both depend on R1. Linking a fresh unlinked M_b
//     (consumed by neither) to R2 (unrelated) must be allowed; more to the
//     point, linking M_b (consumed by BOTH R3 and R4, a genuine diamond) to
//     R5, where R5 is reachable from neither R3 nor R4, must be allowed.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1], [3, 2000, 10, 1], [4, 2000, 10, 1], [5, 2000, 10, 1]],
    materials: [
      [10, 'g', 5, 0, 1],     // M10 made by R1
      [20, 'g', 5, 0, null],  // the shared material both R3 and R4 consume — diamond base
    ],
    lines: [[3, 10, 50], [4, 10, 50], [3, 20, 50], [4, 20, 50]],
  });
  // Linking M20 to R5 (unrelated to R3/R4/R1) must be allowed — R5 cannot
  // reach R3 or R4 through any existing edge.
  const res = materializeLink(db, { recipeId: 5, materialId: 20 });
  check('materializeLink cycle: diamond dependency (no loop) ALLOWED', res.ok, true, JSON.stringify(res));
  db.close();
}

// 15 · a pre-existing cycle elsewhere in the graph must not hang the walk.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1], [2, 2000, 10, 1], [3, 2000, 10, 1]],
    materials: [
      [10, 'g', 5, 0, 1],  // M10 made by R1
      [20, 'g', 5, 0, 2],  // M20 made by R2
      [30, 'g', 5, 0, null],
    ],
    lines: [[2, 10, 50], [1, 20, 50], [3, 30, 50]], // R2->R1 and R1->R2: already a loop
  });
  const t0 = Date.now();
  const res = materializeLink(db, { recipeId: 3, materialId: 10 });
  const ms = Date.now() - t0;
  check('materializeLink cycle: pre-existing loop elsewhere does not hang', ms < 1000, true, `resolved ok=${res.ok} in ${ms}ms`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  materializeLink — the soft warning (never blocking)
// ═══════════════════════════════════════════════════════════════════════════

// 16 · nonzero buy_price -> warning fires, link still succeeds.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 12.5, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink warning: nonzero buy_price still links', res.ok, true);
  check('materializeLink warning: nonzero buy_price produces a warning', !!(res.ok && res.warning), true, res.warning);
  db.close();
}

// 17 · purchase history alone (buy_price 0) -> warning still fires.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, null]],
    poLines: [10],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink warning: purchase history (buy_price 0) still links', res.ok, true);
  check('materializeLink warning: purchase history alone produces a warning', !!(res.ok && res.warning), true, res.warning);
  db.close();
}

// 18 · neither -> no warning.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1]],
    materials: [[10, 'g', 5, 0, null]],
  });
  const res = materializeLink(db, { recipeId: 1, materialId: 10 });
  check('materializeLink warning: clean material links with no warning', res.ok && res.warning === null, true, JSON.stringify(res));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  unlink
// ═══════════════════════════════════════════════════════════════════════════

// 19 · detaches without deleting; other recipes' lines are untouched.
{
  const db = seed(makeDb(), {
    recipes: [[1, 2000, 10, 1], [9, 2000, 10, 1]],
    materials: [[10, 'g', 0.5, 0, 1]],
    lines: [[9, 10, 200]],   // recipe 9 consumes the linked material
  });
  const res = unlink(db, { recipeId: 1 });
  check('unlink: succeeds', res.ok, true);
  const row = ingRow(db, 10);
  check('unlink: source_recipe_id cleared', row.source_recipe_id, null);
  check('unlink: the row itself is NOT deleted', !!row, true);
  check('unlink: its last computed cost is kept, not zeroed', row.cost_per_unit, 0.5);
  const consumerLine = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id=9 AND ingredient_id=10').get();
  check('unlink: a consuming recipe\'s line is untouched', !!consumerLine, true);
  db.close();
}

// 20 · refuses when the recipe does not back anything.
{
  const db = seed(makeDb(), { recipes: [[1, 2000, 10, 1]] });
  const res = unlink(db, { recipeId: 1 });
  check('unlink: refuses a recipe with no linked material', res.ok, false);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All materialize guard cases behaved as specified.');
