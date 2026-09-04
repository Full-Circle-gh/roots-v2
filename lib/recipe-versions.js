// Recipe version history — the undo behind autosave.
//
// WHY THIS EXISTS. The Recipes record (public/retail-admin/19-recipes.js) saves
// itself now: there is no longer a moment where an operator decides "this is
// worth committing", so there is no longer a moment where he decides "this is
// worth NOT committing" either. Autosave without history does not remove the
// risk of losing work, it removes the WARNING and keeps the risk — a mistyped
// batch size or a deleted ingredient line is written to the record within a
// second and the old value is gone. Every save therefore files the state it
// displaced, and the screen can put any of them back.
//
// WHAT A VERSION IS: the state BEFORE a save, not after it. Save 1 files state
// A, save 2 files state B, and the recipe itself holds C. So the history reads
// as "what this recipe looked like before each change", and restoring the
// newest row is the plain undo of the last save.
//
// The snapshot is the whole record — recipe fields, ingredient lines, steps and
// the manual cost inputs — because those four are edited together on one screen
// and a partial restore would leave a recipe whose lines and whose batch size
// came from different days. It is stored as JSON in one row rather than as
// mirrored tables: nothing queries INTO a version, it is only ever read whole,
// and a mirrored schema would need every later ALTER TABLE applied twice.
//
// WHICH HANDLE. Every function takes the handle the caller's own writes use,
// and reads/writes only through it. restoreVersion additionally accepts a
// `costDb` because the two recipe doors deliberately write recipe_cost_data
// through a different handle than the recipe row (routes/retail-recipes.js uses
// tdb() for the cost upsert and the global db for the recipe) — this file
// mirrors whatever the caller already does rather than inventing a third rule.
//
// COLUMNS ARE DISCOVERED, NEVER ASSUMED. `substitutes`, `image_data`,
// `is_favorite` and `recipe_type` all arrived through database.js's addColumn
// after the tables were first written, and a tenant DB or a test fixture can
// legitimately be missing any of them. Both the snapshot and the restore
// intersect their field list with pragma_table_info, so a column that does not
// exist is simply not carried — never a "no such column" 500 on someone's save.

'use strict';

const crypto = require('crypto');

// How many versions a recipe keeps. Past this the oldest are dropped on the
// next snapshot. 60 is roughly a fortnight of ordinary editing at the
// coalescing rates below — long enough that "the version from before I started
// on Tuesday" is still there, short enough that a recipe someone leaves a tab
// open on cannot grow an unbounded table.
const MAX_VERSIONS = 60;

// Two saves closer together than this share ONE filed version between them,
// and the one kept is the OLDER (the state before the first of them) — the
// restore point a person actually wants: "before I started typing", not
// "before my last keystroke".
//
// 'auto' is the debounced background save; a couple of minutes of continuous
// typing is one edit as far as a human is concerned. 'manual' is someone
// pressing Save, which is a deliberate mark and gets its own point — the 6s
// floor there exists only because ONE logical save is TWO requests (the recipe
// PUT and the cost PUT), and those two must not file two versions.
// A restore always files a point, so a restore can itself be undone.
const COALESCE_MS = { auto: 120000, manual: 6000, restore: 0 };

const RECIPE_FIELDS = [
  'name_en', 'name_cn', 'sku', 'category', 'batch_size', 'servings', 'serving_size',
  // Whether those two figures are derived or stated is part of the record, not
  // a setting beside it: restoring a version that derived its batch size and
  // leaving the flag off would put the number back and then let the next save
  // overwrite it from a different set of lines.
  'batch_size_auto', 'servings_auto',
  'shelf_life', 'storage', 'notes', 'recipe_type', 'image_data',
];
const LINE_FIELDS = [
  // in_yield — see schema.sql. A line excluded from the batch weight is a
  // decision a person made about this recipe, and undo has to be able to put it
  // back; without it here, a restore would quietly re-count the discarded stock.
  'ingredient_id', 'name_en', 'name_cn', 'sku', 'qty', 'unit', 'in_yield', 'notes', 'substitutes', 'sort_order',
];
const STEP_FIELDS = ['step_number', 'name', 'instructions'];
const COST_FIELDS = [
  'labour', 'packaging', 'packaging_type_id', 'overhead_pct', 'sell_price', 'target_food_cost',
];

function columnsOf(db, table) {
  try { return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name)); }
  catch (e) { return new Set(); }
}
function present(db, table, fields) {
  const have = columnsOf(db, table);
  return fields.filter(f => have.has(f));
}
function pick(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row && row[f] !== undefined ? row[f] : null;
  return out;
}

// The whole record as it stands right now, in the exact shape restoreVersion
// puts back. Returns null when the recipe is gone.
function readRecipeState(db, recipeId) {
  const id = Number(recipeId);
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!recipe) return null;
  const lineCols = present(db, 'recipe_ingredients', LINE_FIELDS);
  const stepCols = present(db, 'recipe_steps', STEP_FIELDS);
  const costCols = present(db, 'recipe_cost_data', COST_FIELDS);
  const lines = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order, id').all(id);
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_number, id').all(id);
  const cost = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(id) || null;
  return {
    recipe: pick(recipe, present(db, 'recipes', RECIPE_FIELDS)),
    ingredients: lines.map(l => pick(l, lineCols)),
    steps: steps.map(s => pick(s, stepCols)),
    costData: cost ? pick(cost, costCols) : null,
  };
}

// Stable enough to compare two states for equality: JSON.stringify walks the
// object in insertion order, and every object here is built by pick() from the
// same field list, so the same state always serialises the same way.
function hashState(state) {
  return crypto.createHash('sha1').update(JSON.stringify(state)).digest('hex');
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id     INTEGER NOT NULL,
    source        TEXT DEFAULT 'manual',
    actor         TEXT,
    name_en       TEXT,
    name_cn       TEXT,
    line_count    INTEGER DEFAULT 0,
    step_count    INTEGER DEFAULT 0,
    content_hash  TEXT,
    snapshot      TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_recipe_versions_recipe ON recipe_versions(recipe_id, id DESC)');
}

function latestVersion(db, recipeId) {
  return db.prepare(
    'SELECT id, source, content_hash, created_at FROM recipe_versions WHERE recipe_id = ? ORDER BY id DESC LIMIT 1'
  ).get(Number(recipeId)) || null;
}

// SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' in UTC (CURRENT_TIMESTAMP).
// Parsed as UTC explicitly — appending nothing would make V8 read it as LOCAL
// time and every coalescing window would be wrong by the server's offset.
function ageMs(createdAt, now) {
  if (!createdAt) return Infinity;
  const s = String(createdAt).trim();
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const t = Date.parse(s.replace(' ', 'T') + (hasZone ? '' : 'Z'));
  if (!Number.isFinite(t)) return Infinity;
  return (now == null ? Date.now() : now) - t;
}

/**
 * File the recipe's CURRENT state as a version, before the caller overwrites it.
 *
 * Never throws into the caller's save path: a save that succeeded must not be
 * reported as failed because its history entry could not be written. Returns
 * { filed: false, reason } when it deliberately declined.
 *
 * opts: { source: 'manual'|'auto'|'restore', actor: string, now: number }
 */
function snapshotRecipe(db, recipeId, opts) {
  const o = opts || {};
  const source = COALESCE_MS[o.source] !== undefined ? o.source : 'manual';
  try {
    const state = readRecipeState(db, recipeId);
    if (!state) return { filed: false, reason: 'not_found' };
    ensureTable(db);
    const hash = hashState(state);
    const last = latestVersion(db, recipeId);
    // Nothing changed since the last version was filed — a second row would be
    // a duplicate restore point that says the same thing.
    if (last && last.content_hash === hash) return { filed: false, reason: 'unchanged' };
    if (last && ageMs(last.created_at, o.now) < COALESCE_MS[source]) {
      return { filed: false, reason: 'coalesced' };
    }
    const info = db.prepare(`INSERT INTO recipe_versions
      (recipe_id, source, actor, name_en, name_cn, line_count, step_count, content_hash, snapshot)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      Number(recipeId), source, o.actor || null,
      state.recipe.name_en || null, state.recipe.name_cn || null,
      state.ingredients.length, state.steps.length, hash, JSON.stringify(state)
    );
    prune(db, recipeId);
    return { filed: true, version_id: Number(info.lastInsertRowid) };
  } catch (e) {
    return { filed: false, reason: 'error', message: e.message };
  }
}

function prune(db, recipeId) {
  db.prepare(`DELETE FROM recipe_versions WHERE recipe_id = ? AND id NOT IN (
    SELECT id FROM recipe_versions WHERE recipe_id = ? ORDER BY id DESC LIMIT ?
  )`).run(Number(recipeId), Number(recipeId), MAX_VERSIONS);
}

// The list the History panel paints — newest first, WITHOUT the snapshot blob
// (a recipe with 40 lines is several KB, and 60 of those on every panel open is
// a payload nobody reads).
function listVersions(db, recipeId, limit) {
  try {
    ensureTable(db);
    return db.prepare(`SELECT id, recipe_id, source, actor, name_en, name_cn, line_count, step_count, created_at
      FROM recipe_versions WHERE recipe_id = ? ORDER BY id DESC LIMIT ?`)
      .all(Number(recipeId), Math.max(1, Math.min(Number(limit) || MAX_VERSIONS, 200)));
  } catch (e) { return []; }
}

function getVersion(db, recipeId, versionId) {
  try {
    ensureTable(db);
    const row = db.prepare('SELECT * FROM recipe_versions WHERE id = ? AND recipe_id = ?')
      .get(Number(versionId), Number(recipeId));
    if (!row) return null;
    let snapshot = null;
    try { snapshot = JSON.parse(row.snapshot); } catch (e) { snapshot = null; }
    return { ...row, snapshot };
  } catch (e) { return null; }
}

/**
 * Put a filed version back onto the live recipe.
 *
 * The current state is filed FIRST (source 'restore', never coalesced), so
 * restoring the wrong version is itself undoable — the one thing a history
 * panel must not be able to do is destroy the present.
 *
 * The SKU is deliberately NOT restored when it would collide with another
 * recipe: SKUs are unique across the table, so a version carrying a SKU that
 * has since been given to a different recipe would fail the whole restore. The
 * rest of the version goes back and the caller is told which field was held
 * back — better than refusing to restore the ingredient lines because of a code.
 *
 * opts: { actor, costDb, saveCostData, now }
 */
function restoreVersion(db, recipeId, versionId, opts) {
  const o = opts || {};
  const id = Number(recipeId);
  const v = getVersion(db, id, versionId);
  if (!v) return { ok: false, status: 404, error: 'version_not_found', message: 'That version no longer exists.' };
  if (!v.snapshot || !v.snapshot.recipe) {
    return { ok: false, status: 400, error: 'version_unreadable', message: 'That version could not be read back.' };
  }
  const live = db.prepare('SELECT id FROM recipes WHERE id = ?').get(id);
  if (!live) return { ok: false, status: 404, error: 'not_found' };

  snapshotRecipe(db, id, { source: 'restore', actor: o.actor, now: o.now });

  const s = v.snapshot;
  const recipeCols = present(db, 'recipes', RECIPE_FIELDS).filter(f => Object.prototype.hasOwnProperty.call(s.recipe, f));
  const held = [];
  const sets = [];
  const vals = [];
  for (const f of recipeCols) {
    if (f === 'sku' && s.recipe.sku) {
      const owner = db.prepare('SELECT id FROM recipes WHERE sku = ? AND id != ?').get(s.recipe.sku, id);
      if (owner) { held.push('sku'); continue; }
    }
    sets.push(`${f}=?`);
    vals.push(s.recipe[f]);
  }
  const lineCols = present(db, 'recipe_ingredients', LINE_FIELDS);
  const stepCols = present(db, 'recipe_steps', STEP_FIELDS);

  const tx = db.transaction(() => {
    if (sets.length) {
      db.prepare(`UPDATE recipes SET ${sets.join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals, id);
    }
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    const insLine = db.prepare(
      `INSERT INTO recipe_ingredients (recipe_id, ${lineCols.join(',')}) VALUES (?, ${lineCols.map(() => '?').join(',')})`
    );
    (s.ingredients || []).forEach((l, i) => {
      insLine.run(id, ...lineCols.map(c => (c === 'sort_order' ? i : (l[c] === undefined ? null : l[c]))));
    });
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    const insStep = db.prepare(
      `INSERT INTO recipe_steps (recipe_id, ${stepCols.join(',')}) VALUES (?, ${stepCols.map(() => '?').join(',')})`
    );
    (s.steps || []).forEach((st, i) => {
      insStep.run(id, ...stepCols.map(c => (c === 'step_number' ? i + 1 : (st[c] === undefined ? null : st[c]))));
    });
  });
  tx();

  // The manual cost inputs, through the caller's own writer so the
  // absent-vs-cleared rule (lib/recipe-cost-data-write.js) applies to a restore
  // exactly as it applies to a save. A version filed before the recipe had any
  // cost row leaves the current one alone rather than zeroing it — there is
  // nothing to put back, and writing defaults would be inventing a state that
  // never existed.
  if (s.costData && typeof o.saveCostData === 'function') {
    try { o.saveCostData(o.costDb || db, id, s.costData); } catch (e) { held.push('cost'); }
  }

  return { ok: true, version_id: v.id, held };
}

module.exports = {
  snapshotRecipe, listVersions, getVersion, restoreVersion,
  readRecipeState, hashState, ensureTable,
  MAX_VERSIONS, COALESCE_MS,
};
