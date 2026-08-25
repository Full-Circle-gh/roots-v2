#!/usr/bin/env node
/**
 * test_recipe_graph_cycles.js — does the nested-recipe cycle guard actually
 * catch a loop, and does it let a valid graph through?
 *
 * This is the repo's first recursive structure and there was no precedent to
 * copy, so the guard is tested the way the recipe-cost parity gate was: by
 * deliberately building the shapes it must get right and asserting on each,
 * INCLUDING the ones it must ALLOW. A guard that rejects valid graphs is as
 * broken as one that accepts loops — the diamond case below is the one that
 * catches an over-eager implementation, and it is not optional.
 *
 * Runs entirely against an in-memory SQLite fixture. Touches no real database,
 * needs no network, and asserts on lib/recipe-graph.js itself rather than a
 * re-implementation of it — a test that re-derives the logic it is testing
 * proves only that two copies agree.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not, with the
 * mismatch named.
 */
'use strict';

const path = require('path');
// A git worktree has no node_modules of its own — the dependency lives in the
// main checkout. Same two-place lookup the diagnose_* scripts already use, so
// this runs from a worktree, from the main folder, and on the box unchanged.
function loadSqlite() {
  try { return require('better-sqlite3'); }
  catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); }
    catch (e) { /* try next */ }
  }
  console.error('better-sqlite3 not found — run from the main checkout or the box.');
  process.exit(2);
}
const Database = loadSqlite();
const { checkCycle } = require(path.join(__dirname, '..', 'lib', 'recipe-graph'));

// ── fixture ────────────────────────────────────────────────────────────────
// Only the three columns the guard actually reads. Building the whole schema
// would hide which columns it really depends on.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, name_en TEXT);
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name_en TEXT, source_recipe_id INTEGER);
    CREATE TABLE recipe_ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER, ingredient_id INTEGER);
  `);
  return db;
}

// Build a graph from a compact spec.
//   recipes:  [id, ...]                      — a recipe per id
//   materials:[[ingredientId, madeByRecipeId|null], ...]
//   lines:    [[recipeId, ingredientId], ...] — recipe consumes material
function seed(db, { recipes = [], materials = [], lines = [] }) {
  const r = db.prepare('INSERT INTO recipes (id, name_en) VALUES (?,?)');
  const m = db.prepare('INSERT INTO ingredients (id, name_en, source_recipe_id) VALUES (?,?,?)');
  const l = db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id) VALUES (?,?)');
  for (const id of recipes) r.run(id, 'Recipe ' + id);
  for (const [id, src] of materials) m.run(id, 'Material ' + id, src);
  for (const [rid, iid] of lines) l.run(rid, iid);
  return db;
}

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ok=${expected}, got ok=${actual}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}

// ── 1 · direct self-reference ──────────────────────────────────────────────
// Recipe 1 makes material 10. Try to add material 10 as a line of recipe 1.
{
  const db = seed(makeDb(), { recipes: [1], materials: [[10, 1]], lines: [] });
  const v = checkCycle(db, { recipeId: 1, ingredientId: 10 });
  check('direct self-reference is REFUSED', v.ok, false, v.ok ? '' : `chain=[${v.chain}]`);
  db.close();
}

// ── 2 · two-hop loop ───────────────────────────────────────────────────────
// R1 makes M10; R2 makes M20; R2 already consumes M10 (R2 -> R1).
// Adding M20 to R1 would close R1 -> R2 -> R1.
{
  const db = seed(makeDb(), {
    recipes: [1, 2],
    materials: [[10, 1], [20, 2]],
    lines: [[2, 10]],
  });
  const v = checkCycle(db, { recipeId: 1, ingredientId: 20 });
  check('two-hop loop is REFUSED', v.ok, false, v.ok ? '' : `chain=[${v.chain}]`);
  db.close();
}

// ── 3 · three-hop loop ─────────────────────────────────────────────────────
// R2 consumes M10 (R2->R1); R3 consumes M20 (R3->R2).
// Adding M30 (made by R3) to R1 closes R1 -> R3 -> R2 -> R1.
{
  const db = seed(makeDb(), {
    recipes: [1, 2, 3],
    materials: [[10, 1], [20, 2], [30, 3]],
    lines: [[2, 10], [3, 20]],
  });
  const v = checkCycle(db, { recipeId: 1, ingredientId: 30 });
  check('three-hop loop is REFUSED', v.ok, false, v.ok ? '' : `chain=[${v.chain}]`);
  db.close();
}

// ── 4 · diamond — NOT a cycle, MUST be allowed ─────────────────────────────
// R2 and R3 both consume M10 (both depend on R1). R4 consumes M20 (from R2).
// Adding M30 (from R3) to R4 makes R4 depend on both branches — a diamond,
// which is a perfectly ordinary shared base ingredient, not a loop.
// This is the case that fails an over-eager "have I seen this node" guard.
{
  const db = seed(makeDb(), {
    recipes: [1, 2, 3, 4],
    materials: [[10, 1], [20, 2], [30, 3]],
    lines: [[2, 10], [3, 10], [4, 20]],
  });
  const v = checkCycle(db, { recipeId: 4, ingredientId: 30 });
  check('diamond (shared base, no loop) is ALLOWED', v.ok, true, v.ok ? 'both branches reach R1, still acyclic' : `wrongly refused chain=[${v.chain}]`);
  db.close();
}

// ── 5 · an ordinary purchased ingredient is always allowed ─────────────────
// Material 99 is bought — source_recipe_id NULL. It can never carry an edge.
{
  const db = seed(makeDb(), { recipes: [1], materials: [[99, null]], lines: [] });
  const v = checkCycle(db, { recipeId: 1, ingredientId: 99 });
  check('unlinked (bought) ingredient is ALLOWED', v.ok, true);
  db.close();
}

// ── 6 · a long acyclic chain is allowed at every depth ─────────────────────
// R1 <- R2 <- R3 <- R4 in a straight line; adding the deepest to a fresh
// recipe is fine. Guards against a depth limit masquerading as cycle checks.
{
  const db = seed(makeDb(), {
    recipes: [1, 2, 3, 4, 5],
    materials: [[10, 1], [20, 2], [30, 3], [40, 4]],
    lines: [[2, 10], [3, 20], [4, 30]],
  });
  const v = checkCycle(db, { recipeId: 5, ingredientId: 40 });
  check('4-deep acyclic chain is ALLOWED', v.ok, true);
  db.close();
}

// ── 7 · the refusal names the real chain, not a generic message ────────────
{
  const db = seed(makeDb(), {
    recipes: [1, 2, 3],
    materials: [[10, 1], [20, 2], [30, 3]],
    lines: [[2, 10], [3, 20]],
  });
  const v = checkCycle(db, { recipeId: 1, ingredientId: 30 });
  const named = !v.ok && Array.isArray(v.chain) && v.chain.length === 3
    && v.chain[0] === 3 && v.chain[v.chain.length - 1] === 1;
  check('refusal carries the actual dependency chain [3,2,1]', named, true, `chain=[${v.chain}]`);
  db.close();
}

// ── 8 · a graph that ALREADY contains a cycle must not hang ────────────────
// Production has none today (verified before this shipped), but the guard runs
// against whatever is in the database, and a walk over a pre-existing loop is
// exactly where a naive implementation spins forever. R1<->R2 already cycle;
// ask an unrelated question and require a prompt answer.
{
  const db = seed(makeDb(), {
    recipes: [1, 2, 3],
    materials: [[10, 1], [20, 2], [30, 3]],
    lines: [[2, 10], [1, 20]],   // R2->R1 and R1->R2: already a loop
  });
  const t0 = Date.now();
  const v = checkCycle(db, { recipeId: 3, ingredientId: 10 });
  const ms = Date.now() - t0;
  check('pre-existing cycle does not hang the walk', ms < 1000, true, `returned ok=${v.ok} in ${ms}ms`);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All cycle-guard cases behaved as specified.');
