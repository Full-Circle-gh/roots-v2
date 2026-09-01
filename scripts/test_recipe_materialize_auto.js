#!/usr/bin/env node
/**
 * test_recipe_materialize_auto.js — does ensureMaterialized() (the automatic
 * counterpart to §29 step 5, decided as the third §29 addendum on
 * 2026-08-27) actually deliver the three outcomes it claims, and never a
 * fourth?
 *
 * Mirrors scripts/test_recipe_materialize.js's own convention: every refusal
 * case is paired with the nearby happy-path case that must still be allowed,
 * against the real exported function, not a re-implementation.
 *
 * Covers:
 *   - not linked, no name collision -> 'created', a real linked material row.
 *   - not linked, an unlinked ingredients row shares the name (any case) ->
 *     'collision', NOTHING is written, and exactly one open
 *     recipe_materialize_collisions row is recorded.
 *   - a second save while still colliding does NOT insert a second open row
 *     — the existence is the signal, not the count.
 *   - already linked -> 'updated', and a rename on the recipe follows
 *     through to the material's name_en/name_cn/sku; cost_per_unit and unit
 *     are never touched by this path.
 *   - a SKU clash on the create path (name is clear, SKU is not) -> the same
 *     'skipped' + recorded-collision discipline as a name collision, naming
 *     the actual SKU owner as the candidate.
 *   - an archived recipe, and a recipe with no name, are both skipped with
 *     nothing written and nothing recorded — there is no collision to flag
 *     when there was never anything to materialize.
 *   - a collision that resolves (the recipe is renamed off the colliding
 *     name on a later save, or a human calls materializeLink directly)
 *     stamps resolved_at and does not require a fourth call to notice.
 *   - a collision candidate is matched case-insensitively but not against
 *     an unrelated name — the guard is real, not a coincidence of casing.
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
const { ensureMaterialized, materializeLink } = require(path.join(__dirname, '..', 'lib', 'recipe-materialize'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT,
      batch_size REAL, servings INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name_en TEXT, name_cn TEXT, sku TEXT UNIQUE,
      unit TEXT DEFAULT 'g', cost_per_unit REAL DEFAULT 0, buy_price REAL DEFAULT 0,
      -- §29's second addendum (2026-08-27): the overhead a made material's
      -- own recipe added, so a parent can exclude it from its base.
      overhead_per_unit REAL DEFAULT 0,
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
    CREATE TABLE recipe_materialize_collisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER NOT NULL,
      candidate_ingredient_id INTEGER, reason TEXT NOT NULL DEFAULT 'name_collision',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT);
  `);
  return db;
}
function seedRecipe(db, { id, name_en, name_cn, sku, batch_size, servings, is_active }) {
  db.prepare('INSERT INTO recipes (id,name_en,name_cn,sku,batch_size,servings,is_active) VALUES (?,?,?,?,?,?,?)')
    .run(id, name_en, name_cn || null, sku || null, batch_size == null ? null : batch_size,
         servings == null ? null : servings, is_active == null ? 1 : is_active);
}
function seedIngredient(db, { name_en, name_cn, sku, source_recipe_id }) {
  return db.prepare('INSERT INTO ingredients (name_en,name_cn,sku,source_recipe_id) VALUES (?,?,?,?)')
    .run(name_en, name_cn || null, sku || null, source_recipe_id == null ? null : source_recipe_id).lastInsertRowid;
}
function seedLine(db, { recipe_id, ingredient_id, qty }) {
  db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty) VALUES (?,?,?,?)')
    .run(recipe_id, ingredient_id, 'line', qty == null ? 100 : qty);
}
const ingRow = (db, id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
const linkedFor = (db, recipeId) => db.prepare('SELECT * FROM ingredients WHERE source_recipe_id = ?').get(recipeId);
const openCollisions = (db, recipeId) =>
  db.prepare('SELECT * FROM recipe_materialize_collisions WHERE recipe_id = ? AND resolved_at IS NULL').all(recipeId);
const allCollisionRows = (db, recipeId) =>
  db.prepare('SELECT * FROM recipe_materialize_collisions WHERE recipe_id = ?').all(recipeId);

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  'created' — no collision
// ═══════════════════════════════════════════════════════════════════════════

// 1 · happy path — an unlinked recipe with a clear name gets a new material.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Zhoug' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: creates on a clear name', res.action, 'created', JSON.stringify(res));
  const linked = linkedFor(db, 1);
  check('ensureMaterialized: the new row is actually linked', !!linked, true);
  check('ensureMaterialized: name copied from the recipe', linked && linked.name_en, 'Zhoug');
  check('ensureMaterialized: no collision recorded on the clean path', openCollisions(db, 1).length, 0);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  'collision' — name already exists, unlinked
// ═══════════════════════════════════════════════════════════════════════════

// 2 · a same-named unlinked ingredient blocks the write and is recorded.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Almond Butter' });
  const existingId = seedIngredient(db, { name_en: 'Almond Butter' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: refuses to guess on a name collision', res.action, 'collision', JSON.stringify(res));
  check('ensureMaterialized: names the actual candidate', res.candidate_ingredient_id, existingId);
  check('ensureMaterialized: nothing was linked', linkedFor(db, 1), undefined);
  const open = openCollisions(db, 1);
  check('ensureMaterialized: exactly one open collision row', open.length, 1);
  check('ensureMaterialized: collision row reason is name_collision', open[0] && open[0].reason, 'name_collision');
  db.close();
}

// 3 · matching is case-insensitive.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'zhoug' });
  seedIngredient(db, { name_en: 'ZHOUG' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: collision matches regardless of case', res.action, 'collision');
  db.close();
}

// 4 · an UNRELATED existing name does not false-positive.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Zhoug' });
  seedIngredient(db, { name_en: 'Sesame Oil' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: an unrelated name does not block creation', res.action, 'created', JSON.stringify(res));
  db.close();
}

// 5 · a repeat save while still colliding does not pile up a second open row.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Almond Butter' });
  seedIngredient(db, { name_en: 'Almond Butter' });
  ensureMaterialized(db, 1);
  ensureMaterialized(db, 1);
  ensureMaterialized(db, 1);
  check('ensureMaterialized: repeat collisions stay at one open row', openCollisions(db, 1).length, 1);
  check('ensureMaterialized: no duplicate rows accumulate at all', allCollisionRows(db, 1).length, 1);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  'updated' — already linked
// ═══════════════════════════════════════════════════════════════════════════

// 6 · already linked: name/name_cn/sku follow a rename; cost/unit untouched.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Zhoug', name_cn: '青辣椒酱' });
  const materialId = seedIngredient(db, { name_en: 'Zhoug', name_cn: '青辣椒酱', source_recipe_id: 1 });
  db.prepare('UPDATE ingredients SET cost_per_unit = 0.5, unit = ? WHERE id = ?').run('g', materialId);
  db.prepare("UPDATE recipes SET name_en = 'Zhoug — Green Chilli Dip', sku = 'REC-80' WHERE id = 1").run();
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: reports updated on an already-linked recipe', res.action, 'updated', JSON.stringify(res));
  const row = ingRow(db, materialId);
  check('ensureMaterialized: a rename follows through to the material', row.name_en, 'Zhoug — Green Chilli Dip');
  check('ensureMaterialized: sku follows through too', row.sku, 'REC-80');
  check('ensureMaterialized: cost_per_unit is never touched by this path', row.cost_per_unit, 0.5);
  check('ensureMaterialized: unit is never touched by this path', row.unit, 'g');
  db.close();
}

// 7 · already linked, nothing changed — still reports 'updated', still a no-op write.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Zhoug' });
  seedIngredient(db, { name_en: 'Zhoug', source_recipe_id: 1 });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: unchanged name still reports updated', res.action, 'updated');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  SKU clash on the create path — same discipline as a name collision
// ═══════════════════════════════════════════════════════════════════════════

// 8 · the name is clear but the SKU belongs to someone else.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Dried Pineapple Rings', sku: 'DUP-1' });
  const ownerId = seedIngredient(db, { name_en: 'Something Else', sku: 'DUP-1' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: a SKU clash is skipped, not guessed past', res.action, 'skipped', JSON.stringify(res));
  check('ensureMaterialized: nothing was linked on a SKU clash', linkedFor(db, 1), undefined);
  const open = openCollisions(db, 1);
  check('ensureMaterialized: the SKU clash is recorded too', open.length, 1);
  check('ensureMaterialized: names the actual SKU owner as candidate', open[0] && open[0].candidate_ingredient_id, ownerId);
  check('ensureMaterialized: reason distinguishes it from a name collision', open[0] && open[0].reason, 'sku_taken');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Nothing to materialize — skipped, and silently so (no collision to flag)
// ═══════════════════════════════════════════════════════════════════════════

// 9 · an archived recipe is left alone.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Old Recipe', is_active: 0 });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: an archived recipe is skipped', res.action, 'skipped');
  check('ensureMaterialized: archived reason is named', res.reason, 'recipe_archived');
  check('ensureMaterialized: nothing recorded for an archived recipe', openCollisions(db, 1).length, 0);
  db.close();
}

// 10 · a recipe with no name (should not happen past the save routes' own
//     validation, but this module must not assume its callers are perfect).
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: '   ' });
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: a blank name is skipped, not materialized as ""', res.action, 'skipped');
  check('ensureMaterialized: no_name reason is named', res.reason, 'no_name');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Resolution
// ═══════════════════════════════════════════════════════════════════════════

// 11 · a later save whose name no longer collides resolves the open row.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Almond Butter' });
  seedIngredient(db, { name_en: 'Almond Butter' });
  ensureMaterialized(db, 1);
  check('ensureMaterialized: collision open before the rename', openCollisions(db, 1).length, 1);
  db.prepare("UPDATE recipes SET name_en = 'Maple Cinnamon Almond Butter' WHERE id = 1").run();
  const res = ensureMaterialized(db, 1);
  check('ensureMaterialized: the rename clears the block', res.action, 'created', JSON.stringify(res));
  check('ensureMaterialized: the old collision is resolved, not left open', openCollisions(db, 1).length, 0);
  const resolved = allCollisionRows(db, 1)[0];
  check('ensureMaterialized: the resolved row still exists as history', !!resolved, true);
  check('ensureMaterialized: resolved_at is stamped', resolved && resolved.resolved_at != null, true);
  db.close();
}

// 12 · a human resolving it directly via materializeLink also clears the row
//     — not just the next automatic save.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Almond Butter' });
  const existingId = seedIngredient(db, { name_en: 'Almond Butter' });
  ensureMaterialized(db, 1);
  check('ensureMaterialized: collision open before the human resolves it', openCollisions(db, 1).length, 1);
  const linkRes = materializeLink(db, { recipeId: 1, materialId: existingId });
  check('materializeLink: the human\'s own resolution succeeds', linkRes.ok, true, JSON.stringify(linkRes));
  check('materializeLink: resolves the open collision immediately', openCollisions(db, 1).length, 0);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
//  'repack' — a one-line recipe gets no material of its own
// ═══════════════════════════════════════════════════════════════════════════

// A · the case Ash reported. A recipe that repacks a material Roots already
// buys must not put a second row for the same physical thing in the Materials
// list. The names deliberately do NOT match here — that is the whole point,
// since it is the exact pair ("Dates（Nour）" / "Nour Dates (retail)") an
// exact-name collision check let through.
{
  const db = makeDb();
  const bulk = seedIngredient(db, { name_en: 'Nour Dates (retail)', name_cn: '诺意椰枣（打包）', sku: 'B-6' });
  seedRecipe(db, { id: 1, name_en: 'Dates（Nour）', name_cn: '诺意椰枣', sku: '2-280' });
  seedLine(db, { recipe_id: 1, ingredient_id: bulk, qty: 120 });
  const res = ensureMaterialized(db, 1);
  check('repack: a one-line recipe is skipped, not materialized', res.action, 'skipped', JSON.stringify(res));
  check('repack: the reason names it as a repack', res.reason, 'repack');
  check('repack: it names the material being repacked', res.repack_ingredient_id, bulk);
  check('repack: no second row was created', db.prepare('SELECT COUNT(*) AS n FROM ingredients').get().n, 1);
  check('repack: nothing was linked to the recipe', linkedFor(db, 1), undefined);
  check('repack: no collision is queued — there is no question to answer', openCollisions(db, 1).length, 0);
  db.close();
}

// B · two lines is not a repack. The rule is the line COUNT, so the moment a
// recipe combines anything it is a made thing and gets its row as before.
{
  const db = makeDb();
  const a = seedIngredient(db, { name_en: 'Dates' });
  const b = seedIngredient(db, { name_en: 'Tahini' });
  seedRecipe(db, { id: 1, name_en: 'Date Tahini Ball' });
  seedLine(db, { recipe_id: 1, ingredient_id: a });
  seedLine(db, { recipe_id: 1, ingredient_id: b });
  const res = ensureMaterialized(db, 1);
  check('repack: a two-line recipe still materializes', res.action, 'created', JSON.stringify(res));
  db.close();
}

// C · a recipe with no lines at all is not a repack either — it has nothing to
// point at, so it needs its own row exactly as it always did. This is the
// shape every other case in this file uses, and it must not have changed.
{
  const db = makeDb();
  seedRecipe(db, { id: 1, name_en: 'Zhoug' });
  const res = ensureMaterialized(db, 1);
  check('repack: a recipe with no lines still materializes', res.action, 'created', JSON.stringify(res));
  db.close();
}

// D · the sole line points at an ARCHIVED material. routes/retail-product-
// build.js will not offer an archived row as a product's contents, so that
// recipe has no other route to a cost and must still get its own material —
// skipping it here would leave it with neither.
{
  const db = makeDb();
  const gone = seedIngredient(db, { name_en: 'Old Dates' });
  db.prepare('UPDATE ingredients SET is_active = 0 WHERE id = ?').run(gone);
  seedRecipe(db, { id: 1, name_en: 'Dates（Nour）' });
  seedLine(db, { recipe_id: 1, ingredient_id: gone });
  const res = ensureMaterialized(db, 1);
  check('repack: a sole line on an archived material still materializes', res.action, 'created', JSON.stringify(res));
  db.close();
}

// E · an ALREADY-LINKED one-line recipe keeps its material and keeps syncing.
// §29 step 5's "Make available as material" is still how a real one-line
// transformation (a dry-down with a yield loss) gets its own row by hand, and
// this rule must never take that back.
{
  const db = makeDb();
  const bulk = seedIngredient(db, { name_en: 'Fresh Banana' });
  seedRecipe(db, { id: 1, name_en: 'Dried Baby Banana' });
  seedLine(db, { recipe_id: 1, ingredient_id: bulk });
  const mine = seedIngredient(db, { name_en: 'Dried Baby Banana', source_recipe_id: 1 });
  const res = ensureMaterialized(db, 1);
  check('repack: an already-linked one-liner is updated, never unlinked', res.action, 'updated', JSON.stringify(res));
  check('repack: its material is still the same row', res.material_id, mine);
  db.close();
}

// F · a repack whose name DOES collide clears the stale collision. Before this
// rule the same recipe would have queued a question; now it is not asking for
// a material at all, so leaving one open would queue a question nobody can
// answer.
{
  const db = makeDb();
  const bulk = seedIngredient(db, { name_en: 'Sumac' });
  seedRecipe(db, { id: 1, name_en: 'Sumac' });
  ensureMaterialized(db, 1);
  check('repack: the pre-existing collision is open', openCollisions(db, 1).length, 1);
  seedLine(db, { recipe_id: 1, ingredient_id: bulk });
  const res = ensureMaterialized(db, 1);
  check('repack: adding the line turns it into a repack', res.reason, 'repack', JSON.stringify(res));
  check('repack: the stale collision is resolved, not left open', openCollisions(db, 1).length, 0);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All automatic-materialization cases behaved as specified.');
