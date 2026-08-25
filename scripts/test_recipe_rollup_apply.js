#!/usr/bin/env node
/**
 * test_recipe_rollup_apply.js — does applyRollup() (the function every live
 * trigger point calls) actually write, write ONLY what it should, and stay
 * inert when nothing moved?
 *
 * scripts/test_recipe_rollup.js already proves planRollup's arithmetic and
 * ordering are correct — this file does not re-check that. It proves the
 * write half: the thing a trigger site actually calls, and the three
 * specific failure modes named in the brief for §29 step 3:
 *
 *   1. a trigger that never fires               (stale cost, caught by comparing
 *                                                 "before applyRollup" to "after")
 *   2. a trigger that walks the wrong direction  (upstream/raw writes, caught by
 *                                                 asserting raw ingredients and the
 *                                                 recipes table are untouched)
 *   3. a trigger that fires on a linked          (caught by asserting applyRollup
 *      ingredient's own cost write               ignores whatever a linked row's
 *      (self-referential)                        own stored cost currently says)
 *
 * Plus: the zero-delta requirement itself (an already-correct graph is a
 * true no-op) and the cycle refusal (nothing written, ever).
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
const { applyRollup, backsLinkedMaterial } =
  require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));

// Same shape as scripts/test_recipe_rollup.js's fixture, plus `updated_at` so
// "was this row touched" is checkable without relying on the value alone.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY, name_en TEXT, sku TEXT, category TEXT,
      batch_size REAL, servings INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT, unit TEXT DEFAULT 'g',
      cost_per_unit REAL DEFAULT 0, free_by_design INTEGER DEFAULT 0,
      source_recipe_id INTEGER, is_active INTEGER DEFAULT 1, updated_at TEXT);
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
  const m = db.prepare("INSERT INTO ingredients (id,name_en,unit,cost_per_unit,source_recipe_id,updated_at) VALUES (?,?,?,?,?,'seed')");
  const l = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)');
  for (const [id, batch, active] of recipes) r.run(id, 'Recipe ' + id, batch, active === undefined ? 1 : active);
  for (const [id, cpu, src] of materials) m.run(id, 'Material ' + id, 'g', cpu, src === undefined ? null : src);
  let i = 0;
  for (const [rid, iid, qty] of lines) l.run(rid, iid, 'line', qty, 'g', i++);
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

// ── 1 · "never fires" — a stale graph stays stale until applyRollup runs ───
// R1 makes M10 from 200g raw M99. Bump M99's price DIRECTLY (as a guarded
// writer's own UPDATE would, before it calls fireRecompute) and confirm M10
// stays at its old, now-wrong value until applyRollup is actually called.
// This is the exact failure mode a trigger site that forgets to call
// applyRollup would produce, made visible.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // M10 currently 1.0/g (matches old M99 price)
    lines: [[1, 99, 200]],
  });
  db.prepare('UPDATE ingredients SET cost_per_unit = 1.0, updated_at = ? WHERE id = 99').run('raw-price-bump');
  check('before recompute: linked material is stale', ingRow(db, 10).cost_per_unit, 1.0,
        '200g x 1.0 = 200/100g = 2.0/g is the true cost now, but nothing has run yet');

  const result = applyRollup(db, { source: 'test' });
  check('applyRollup reports it fired', result.applied, true);
  check('after recompute: linked material now correct', ingRow(db, 10).cost_per_unit, 2.0,
        '200g x 1.0 = 200 / 100g batch = 2.0/g');
  db.close();
}

// ── 2 · fires and walks DOWNSTREAM, transitively (2 levels) ────────────────
// R1 makes M10 from raw M99. R2 makes M20 from M10. Move M99's price and
// confirm BOTH M10 and M20 update in one applyRollup call, in the right
// direction (downstream), not just the immediate consumer.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 0.5, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const result = applyRollup(db, { source: 'test' });
  check('transitive: level-1 material recomputed', ingRow(db, 10).cost_per_unit, 2.0, '200g x 1.0 / 100g = 2.0/g');
  check('transitive: level-2 material recomputed off the NEW level-1 cost', ingRow(db, 20).cost_per_unit, 1.0, '50g x 2.0 / 100g = 1.0/g');
  check('written count covers both', result.written, 2);
  db.close();
}

// ── 3 · "wrong direction" — never writes a raw (unlinked) ingredient ───────
// Even though the raw material's price is what moved the whole graph, it is
// never itself in planRollup's change set (loadLinkedMaterials only reads
// source_recipe_id IS NOT NULL rows) — applyRollup's UPDATE is compounded on
// `source_recipe_id = ?`, which can never match a NULL. Assert the raw row's
// cost AND updated_at are byte-for-byte untouched by the call.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const before = ingRow(db, 99);
  applyRollup(db, { source: 'test' });
  const after = ingRow(db, 99);
  check('raw ingredient cost is untouched by applyRollup', after.cost_per_unit, before.cost_per_unit);
  check('raw ingredient updated_at is untouched (not re-stamped)', after.updated_at, before.updated_at, 'proves no UPDATE statement even matched this row');
  db.close();
}

// ── 3b · "wrong direction" — never writes the `recipes` table ──────────────
// applyRollup only ever issues `UPDATE ingredients ...`. Snapshot every
// recipes row before and after a real recompute pass and require byte
// equality — this is also what makes recursion into the recipe-save
// triggers (routes/recipes.js) structurally impossible: those fire on writes
// to `recipes`/`recipe_cost_data`, and applyRollup never produces one.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 0.5, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const before = JSON.stringify(db.prepare('SELECT * FROM recipes ORDER BY id').all());
  applyRollup(db, { source: 'test' });
  const after = JSON.stringify(db.prepare('SELECT * FROM recipes ORDER BY id').all());
  check('the recipes table is never written by applyRollup', after, before,
        'no recipes-table write means no path back into the recipe-save trigger points — structurally, not by convention');
  db.close();
}

// ── 4 · self-referential — a linked material's OWN stored cost is ignored ──
// Simulates the guard failing (or being bypassed some other way) and a
// linked row's cost_per_unit getting hand-set to a wrong number directly.
// applyRollup must derive M10's cost from R1's recipe ONLY, never read or
// preserve whatever M10.cost_per_unit currently holds — so the wrong number
// is overwritten, not amplified or left alone.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 999, 1]], // M10 hand-set to a bogus 999
    lines: [[1, 99, 200]],
  });
  const result = applyRollup(db, { source: 'test' });
  check('a linked material self-write is corrected, not trusted', ingRow(db, 10).cost_per_unit, 1.0,
        'derived purely from R1 (200g x 0.5 / 100g), the bogus 999 is never read');
  check('this reads as a normal change, not a special self-reference path', result.written, 1);
  db.close();
}

// ── 5 · zero-delta — an already-correct graph is a true no-op ──────────────
// The gate the deploy itself must pass: running applyRollup against a graph
// that already matches must write nothing and leave updated_at alone.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // already correct: 200x0.5/100=1.0
    lines: [[1, 99, 200]],
  });
  const before = ingRow(db, 10);
  const result = applyRollup(db, { source: 'test' });
  const after = ingRow(db, 10);
  check('nothing written on an already-correct graph', result.written, 0);
  check('cost_per_unit literally unchanged', after.cost_per_unit, before.cost_per_unit);
  check('updated_at NOT re-stamped (a true no-op, not a same-value rewrite)', after.updated_at, before.updated_at,
        'a recompute firing after deploy with no data change must be invisible');
  db.close();
}

// ── 6 · a cycle refuses the whole pass — writes nothing ────────────────────
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[10, 0, 1], [20, 0, 2]],
    lines: [[1, 20, 10], [2, 10, 10]],
  });
  const before10 = ingRow(db, 10).cost_per_unit, before20 = ingRow(db, 20).cost_per_unit;
  const result = applyRollup(db, { source: 'test' });
  check('a cycle is not applied', result.applied, false);
  check('a cycle is reported, not swallowed', result.reason, 'cycle');
  check('nothing written for M10 on a cycle', ingRow(db, 10).cost_per_unit, before10);
  check('nothing written for M20 on a cycle', ingRow(db, 20).cost_per_unit, before20);
  db.close();
}

// ── 7 · blocked materials stay frozen, never zeroed, through applyRollup ───
// (planRollup already proves the plan marks these blocked — this proves the
// WRITE half respects that: nothing lands in the database for them.)
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 0]], // R2 has no batch_size -> blocked
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 7, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  const before20 = ingRow(db, 20).cost_per_unit;
  applyRollup(db, { source: 'test' });
  check('blocked material keeps its old cost, not zeroed', ingRow(db, 20).cost_per_unit, before20);
  check("blocked material's updated_at is not re-stamped", ingRow(db, 20).updated_at, 'seed');
  db.close();
}

// ── 8 · better-sqlite3 nests applyRollup as a SAVEPOINT ────────────────────
// routes/admin.js repair-items calls applyRollup from inside its OWN
// db.transaction(). Confirm that composition works: calling applyRollup from
// inside an outer transaction still writes correctly and commits together.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const outer = db.transaction(() => {
    db.prepare("UPDATE ingredients SET name_en = 'renamed' WHERE id = 99").run();
    return applyRollup(db, { source: 'nested-test' });
  });
  const result = outer();
  check('nested applyRollup still applies', result.applied, true);
  check('nested applyRollup still writes the recomputed cost', ingRow(db, 10).cost_per_unit, 2.0);
  check("outer transaction's own write also committed", ingRow(db, 99).name_en, 'renamed');
  db.close();
}

// ── 9 · the compound WHERE is what makes a mismatch loud, not silent ───────
// applyRollup always re-plans fresh at write time (same synchronous call, no
// window for the table to move underneath it), so the row-count throw is a
// defence-in-depth belt rather than something normal operation can trip —
// there is no way to hand applyRollup a stale external plan. What IS testable
// directly is the mechanism the throw relies on: the compound
// `WHERE id = ? AND source_recipe_id = ?` match. Prove that when a
// (ingredient, recipe) pair no longer holds — the one way this can happen at
// all, a material getting unlinked between two separate reads — the UPDATE
// matches ZERO rows rather than the wrong row. That changes:0 signal is
// exactly what applyRollup's `r.changes !== 1` check turns into a throw
// instead of a silent no-op or a write to an unrelated ingredient.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare('UPDATE ingredients SET source_recipe_id = NULL WHERE id = 10').run(); // unlinked between reads
  const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_recipe_id = ?');
  const r = upd.run(2.0, 10, 1);
  check('a stale (ingredient, recipe) pair matches zero rows, not the wrong row', r.changes, 0,
        'applyRollup treats r.changes !== 1 as throw-worthy rather than writing silently');
  db.close();
}

// ── 10 · backsLinkedMaterial — the gate the recipe-save trigger points use ─
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // only recipe 1 backs a material
    lines: [[1, 99, 200]],
  });
  check('recipe backing a linked material: true', backsLinkedMaterial(db, 1), true);
  check('ordinary recipe nothing points at: false', backsLinkedMaterial(db, 2), false);
  check('recipe id with no rows at all: false', backsLinkedMaterial(db, 999), false);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All applyRollup/trigger cases behaved as specified.');
