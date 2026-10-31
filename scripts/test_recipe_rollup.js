#!/usr/bin/env node
/**
 * test_recipe_rollup.js — does the nested-recipe rollup cost a chain in the
 * right order, and does it stop at a blocked node instead of guessing?
 *
 * The failure mode this exists for is quiet: a rollup that visits nodes in the
 * wrong order, or memoises one it should not, does not crash — it writes a cost
 * that is too low and looks entirely plausible. So every case below asserts on
 * an EXACT expected number computed by hand in the comment above it, not on
 * "something changed".
 *
 * In-memory fixture only. No real database, no network.
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
const { planRollup, topoOrder, buildSourceGraph, loadLinkedMaterials } =
  require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));

// Only the columns the rollup reads. recipe_cost_data is present but left
// empty in most cases so batchCost == ingredientCost and the arithmetic in
// each comment stays checkable by eye.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY, name_en TEXT, sku TEXT, category TEXT,
      batch_size REAL, servings INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT, unit TEXT DEFAULT 'g',
      cost_per_unit REAL DEFAULT 0, free_by_design INTEGER DEFAULT 0,
      -- §29's second addendum (2026-08-27): the overhead a made material's
      -- own recipe added, so a parent can exclude it from its base.
      overhead_per_unit REAL DEFAULT 0,
      source_recipe_id INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER, ingredient_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, qty REAL, unit TEXT DEFAULT 'g', sort_order INTEGER DEFAULT 0);
    CREATE TABLE recipe_cost_data (
      recipe_id INTEGER PRIMARY KEY, labour REAL DEFAULT 0, packaging REAL DEFAULT 0,
      overhead_pct REAL DEFAULT 0, sell_price REAL DEFAULT 0, target_food_cost REAL DEFAULT 30,
      updated_at DATETIME);
  `);
  return db;
}
function seed(db, { recipes = [], materials = [], lines = [] }) {
  const r = db.prepare('INSERT INTO recipes (id,name_en,batch_size,is_active) VALUES (?,?,?,?)');
  const m = db.prepare('INSERT INTO ingredients (id,name_en,unit,cost_per_unit,source_recipe_id) VALUES (?,?,?,?,?)');
  const l = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)');
  for (const [id, batch, active] of recipes) r.run(id, 'Recipe ' + id, batch, active === undefined ? 1 : active);
  for (const [id, cpu, src] of materials) m.run(id, 'Material ' + id, 'g', cpu, src === undefined ? null : src);
  let i = 0;
  for (const [rid, iid, qty] of lines) l.run(rid, iid, 'line', qty, 'g', i++);
  return db;
}

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}
const cpuOf = (plan, ingId) => {
  const c = plan.changes.find(x => x.ingredient_id === ingId);
  return c ? c.newCpu : null;
};

// ── 1 · a two-level chain rolls up, deepest first ──────────────────────────
// R1 makes M10, batch 100g, from 200g of raw M99 @ ¥0.5/g  = ¥100 / 100g = 1.0/g
// R2 makes M20, batch 100g, from 50g of M10 @ (1.0)        = ¥50  / 100g = 0.5/g
// R2 MUST be costed after R1, or M10 reads 0 and M20 comes out 0.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 0, 1], [20, 0, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  const plan = planRollup(db);
  check('two-level chain: inner material costed', cpuOf(plan, 10), 1, 'R1: 200g x 0.5 = 100 / 100g');
  check('two-level chain: outer material uses the inner cost', cpuOf(plan, 20), 0.5, 'R2: 50g x 1.0 = 50 / 100g');
  check('order put the dependency first', plan.order.indexOf(1) < plan.order.indexOf(2), true, `order=[${plan.order}]`);
  db.close();
}

// ── 2 · three levels deep ──────────────────────────────────────────────────
// R1 -> M10 = 1.0/g (as above). R2 -> M20 = 0.5/g. R3 batch 100g from 20g M20
//   = ¥10 / 100g = 0.1/g. Wrong order at ANY level collapses this to 0.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100], [3, 100]],
    materials: [[99, 0.5, null], [10, 0, 1], [20, 0, 2], [30, 0, 3]],
    lines: [[1, 99, 200], [2, 10, 50], [3, 20, 20]],
  });
  const plan = planRollup(db);
  check('three-level chain rolls all the way up', cpuOf(plan, 30), 0.1, 'R3: 20g x 0.5 = 10 / 100g');
  db.close();
}

// ── 3 · a diamond costs the shared base ONCE and both branches correctly ────
// R1 -> M10 = 1.0/g. R2 (batch 100) uses 10g M10 = 0.1/g. R3 (batch 100) uses
// 30g M10 = 0.3/g. R4 (batch 100) uses 100g M20 + 100g M30 = 10+30 = 0.4/g.
// A memo keyed wrongly (e.g. per-visit rather than per-recipe) shows up here.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100], [3, 100], [4, 100]],
    materials: [[99, 0.5, null], [10, 0, 1], [20, 0, 2], [30, 0, 3], [40, 0, 4]],
    lines: [[1, 99, 200], [2, 10, 10], [3, 10, 30], [4, 20, 100], [4, 30, 100]],
  });
  const plan = planRollup(db);
  check('diamond branch A', cpuOf(plan, 20), 0.1);
  check('diamond branch B', cpuOf(plan, 30), 0.3);
  check('diamond join sums both branches', cpuOf(plan, 40), 0.4, 'R4: 100x0.1 + 100x0.3 = 40 / 100g');
  db.close();
}

// ── 4 · a blocked node stops the cascade and is never written as zero ───────
// R1 -> M10 = 1.0/g, fine. R2 has NO batch_size, so M20 cannot be costed.
// R3 consumes M20. M20 must be reported blocked (not changed, not 0), and R3
// must NOT receive a number invented past the block.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 0], [3, 100]],
    materials: [[99, 0.5, null], [10, 0, 1], [20, 0, 2], [30, 0, 3]],
    lines: [[1, 99, 200], [2, 10, 50], [3, 20, 20]],
  });
  const plan = planRollup(db);
  const b20 = plan.blocked.find(b => b.ingredient_id === 20);
  check('blocked material is reported blocked', !!b20, true, b20 ? `reason=${b20.reason}` : 'not in blocked list');
  check('blocked material is NOT in the change list', cpuOf(plan, 20), null, 'nothing written for it');
  const b30 = plan.blocked.find(b => b.ingredient_id === 30);
  check('the node ABOVE a block is also blocked, not guessed', !!b30, true, b30 ? `reason=${b30.reason}` : 'wrongly costed');
  check('nothing above the block got a number', cpuOf(plan, 30), null);
  db.close();
}

// ── 5 · an unpriced line blocks, rather than costing the rest ──────────────
// R1's line references a raw material with cost 0 — computeRecipeCost counts
// that as a missing cost, so R1 must block rather than report a partial batch.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[98, 0, null], [99, 0.5, null], [10, 0, 1]],
    lines: [[1, 99, 100], [1, 98, 100]],
  });
  const plan = planRollup(db);
  const b = plan.blocked.find(x => x.ingredient_id === 10);
  check('an unpriced line blocks the whole recipe', b && b.reason, 'unpriced_lines', b ? `unpriced=${b.unpriced}` : 'not blocked');
  db.close();
}

// ── 6 · re-running finds nothing to do ─────────────────────────────────────
// Costs already at their computed value must report as unchanged, not rewritten.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1, 1]],
    lines: [[1, 99, 200]],
  });
  const plan = planRollup(db);
  check('an already-correct cost is not a change', plan.changes.length, 0);
  check('and is counted as unchanged', plan.unchanged, 1);
  db.close();
}

// ── 7 · an archived source recipe blocks (cost frozen, not recomputed) ─────
{
  const db = seed(makeDb(), {
    recipes: [[1, 100, 0]],
    materials: [[99, 0.5, null], [10, 7, 1]],
    lines: [[1, 99, 200]],
  });
  const plan = planRollup(db);
  const b = plan.blocked.find(x => x.ingredient_id === 10);
  check('archived source recipe blocks', b && b.reason, 'recipe_archived', 'cost stays frozen at its last value');
  db.close();
}

// ── 8 · a cycle is refused, not walked ─────────────────────────────────────
// R1 makes M10 and consumes M20; R2 makes M20 and consumes M10. No order
// exists. topoOrder must leave both unresolved rather than emit a partial one.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[10, 0, 1], [20, 0, 2]],
    lines: [[1, 20, 10], [2, 10, 10]],
  });
  const byRecipe = loadLinkedMaterials(db);
  const { order, unresolved } = topoOrder(buildSourceGraph(db, byRecipe));
  check('a cycle yields no order', order.length, 0, `unresolved=[${unresolved}]`);
  check('and names the unorderable recipes', unresolved.length, 2);
  const plan = planRollup(db);
  check('planRollup surfaces the cycle', plan.cycle.length, 2, 'the script refuses on this');
  db.close();
}

// ── 9 · a legitimately-FREE made material is a real zero, not a block ──────
// R1 is made entirely of something marked free by design (tap water), so its
// batch genuinely costs 0 and costPerGram is a true 0. R2 consumes M10 plus
// 100g of a raw @0.5 = ¥50 / 100g = 0.5/g. M10 must contribute nothing AND
// block nothing. Collapsing "blocked" and "free" into a bare 0 fails here:
// M10 would be read as an unpriced line and R2 would block instead of costing.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[97, 0, null], [99, 0.5, null], [10, 0, 1], [20, 0, 2]],
    lines: [[1, 97, 500], [2, 10, 50], [2, 99, 100]],
  });
  db.prepare('UPDATE ingredients SET free_by_design = 1 WHERE id = 97').run();
  const plan = planRollup(db);
  const blocked10 = plan.blocked.find(b => b.ingredient_id === 10);
  check('a free-by-design recipe is costable, not blocked', !blocked10, true,
        blocked10 ? `wrongly blocked: ${blocked10.reason}` : 'costs a true zero');
  const blocked20 = plan.blocked.find(b => b.ingredient_id === 20);
  check('a free made material does not block the recipe above it', !blocked20, true,
        blocked20 ? `wrongly blocked: ${blocked20.reason}` : '');
  check('and the recipe above costs only its priced lines', cpuOf(plan, 20), 0.5,
        'R2: 50g x 0 (free) + 100g x 0.5 = 50 / 100g');
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All rollup cases behaved as specified.');
