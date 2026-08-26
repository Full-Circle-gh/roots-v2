#!/usr/bin/env node
/**
 * test_recipe_cost_data_write.js — does a cost save keep the packaging link it
 * was never told about, and can that link still be cleared on purpose?
 *
 * The fault this covers (docs/packaging-findings.md finding 11): Tacet's Cost &
 * Pricing tab has no packaging-type picker, so its save payload never carries
 * `packaging_type_id` — and the route coalesced the missing key to NULL and
 * wrote it. Every save kept the packaging NUMBER and discarded which packaging
 * it was, deleting the packaging migration's machine-resolvable input one recipe
 * at a time.
 *
 * The repair is preserve-on-absent, and the trap in the repair is that the
 * obvious version (COALESCE the incoming value against the stored one) makes an
 * explicit NULL indistinguishable from an absent key, so a link could never be
 * removed. Cases 2 and 3 exist to catch exactly that, and they are the reason
 * this file is worth having: case 1 passing on its own would also be true of the
 * broken repair.
 *
 * SCOPE IS ONE COLUMN. Cases 8 and 9 assert the opposite property for the other
 * five — an absent `labour` still writes 0, an absent `target_food_cost` still
 * writes 30 — because this change must not quietly turn the route into a
 * partial-update endpoint.
 *
 * In-memory fixture only. No real database, no HTTP, no app modules — the write
 * is called directly, which is why it was moved out of the routes.
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
const { saveRecipeCostData, resolvePackagingTypeId } =
  require(path.join(__dirname, '..', 'lib', 'recipe-cost-data-write'));

// `recipe_cost_data` exactly as schema.sql:135 declares it, minus the FK (no
// recipes table here — this write never touches one).
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipe_cost_data (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id         INTEGER NOT NULL UNIQUE,
      labour            REAL DEFAULT 0,
      packaging         REAL DEFAULT 0,
      packaging_type_id INTEGER,
      overhead_pct      REAL DEFAULT 0,
      sell_price        REAL DEFAULT 0,
      target_food_cost  REAL DEFAULT 30,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  return db;
}

// A recipe that already has a packaging link — the state finding 11 destroys.
// 1.12 / type 2 is recipe 80's real shape on production.
function seedLinked(db, recipeId = 80) {
  db.prepare(`INSERT INTO recipe_cost_data
    (recipe_id, labour, packaging, packaging_type_id, overhead_pct, sell_price, target_food_cost, updated_at)
    VALUES (?, 5, 1.12, 2, 10, 40, 30, '2026-08-01 00:00:00')`).run(recipeId);
}

const row = (db, id) =>
  db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(id);

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected)
    || (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-9);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok ? '' : `  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// ── 1. The regression itself ─────────────────────────────────────────────────
// Tacet's exact payload: five fields, no packaging_type_id key. This is what
// draftCostData() (public/retail-admin/19-recipes.js:713-722) produces.
console.log('\n1. Tacet cost save (no packaging_type_id key) keeps the link');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, 80, {
    labour: 6, packaging: 1.12, overhead_pct: 10, sell_price: 44, target_food_cost: 30,
  });
  const r = row(db, 80);
  check('packaging_type_id preserved', r.packaging_type_id, 2);
  check('packaging number saved', r.packaging, 1.12);
  check('labour saved', r.labour, 6);
  check('sell_price saved', r.sell_price, 44);
  check('updated_at moved', r.updated_at !== '2026-08-01 00:00:00', true);
}

// ── 2 & 3. Clearing must still work ──────────────────────────────────────────
// The COALESCE repair would pass case 1 and fail both of these.
console.log('\n2. Explicit null clears the link (the kitchen picker set to none)');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, 80, {
    labour: 5, packaging: 1.12, packaging_type_id: null,
    overhead_pct: 10, sell_price: 40, target_food_cost: 30,
  });
  check('packaging_type_id cleared', row(db, 80).packaging_type_id, null);
  check('packaging number survives the clear', row(db, 80).packaging, 1.12);
}

console.log('\n3. Explicit empty string clears the link (an unselected <select>)');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, 80, { packaging: 1.12, packaging_type_id: '' });
  check('packaging_type_id cleared', row(db, 80).packaging_type_id, null);
}

// ── 4 & 5. The kitchen app's picker still writes ─────────────────────────────
console.log('\n4. Kitchen Cost Sheet changing to a DIFFERENT type still writes it');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, 80, {
    labour: 5, packaging: 0.488, packaging_type_id: 17,
    overhead_pct: 10, sell_price: 40, target_food_cost: 30,
  });
  const r = row(db, 80);
  check('packaging_type_id changed', r.packaging_type_id, 17);
  check('packaging number changed with it', r.packaging, 0.488);
}

console.log('\n5. Re-saving the same type is a no-op on the link');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, 80, { packaging: 1.12, packaging_type_id: 2 });
  check('packaging_type_id unchanged', row(db, 80).packaging_type_id, 2);
}

// ── 6 & 7. The INSERT path — there is nothing to preserve ────────────────────
console.log('\n6. First-ever cost save with no key writes NULL (nothing to keep)');
{
  const db = makeDb();
  saveRecipeCostData(db, 99, { labour: 1, packaging: 0.5 });
  const r = row(db, 99);
  check('row created', !!r, true);
  check('packaging_type_id null', r.packaging_type_id, null);
  check('packaging saved', r.packaging, 0.5);
}

console.log('\n7. First-ever cost save WITH a key writes it');
{
  const db = makeDb();
  saveRecipeCostData(db, 99, { packaging: 1.88, packaging_type_id: 9 });
  check('packaging_type_id written', row(db, 99).packaging_type_id, 9);
}

// ── 8 & 9. Every other column keeps today's behaviour ────────────────────────
// The scope boundary. If these ever start preserving, this change went further
// than it was meant to and a field cleared to blank can never return to zero.
console.log('\n8. An absent numeric field still writes its default, NOT the stored value');
{
  const db = makeDb();
  seedLinked(db);                                   // labour 5, overhead 10, sell 40
  saveRecipeCostData(db, 80, { packaging: 1.12 });  // mentions nothing else
  const r = row(db, 80);
  check('absent labour -> 0 (not 5)', r.labour, 0);
  check('absent overhead_pct -> 0 (not 10)', r.overhead_pct, 0);
  check('absent sell_price -> 0 (not 40)', r.sell_price, 0);
  check('absent target_food_cost -> 30', r.target_food_cost, 30);
  check('packaging_type_id still preserved', r.packaging_type_id, 2);
}

console.log('\n9. The target_food_cost 0 -> 30 quirk is preserved (recipe-cost.js:248)');
{
  const db = makeDb();
  saveRecipeCostData(db, 99, { target_food_cost: 0 });
  check('stored 0 becomes 30', row(db, 99).target_food_cost, 30);
  saveRecipeCostData(db, 99, { target_food_cost: 25 });
  check('a real value is kept', row(db, 99).target_food_cost, 25);
}

// ── 10. The rule alone, without the write ────────────────────────────────────
console.log('\n10. resolvePackagingTypeId — the three cases, directly');
{
  check('absent + stored 2 -> 2', resolvePackagingTypeId({ labour: 1 }, 2), 2);
  check('absent + stored null -> null', resolvePackagingTypeId({}, null), null);
  check('present null + stored 2 -> null', resolvePackagingTypeId({ packaging_type_id: null }, 2), null);
  check('present 0 + stored 2 -> null', resolvePackagingTypeId({ packaging_type_id: 0 }, 2), null);
  check('present 7 + stored 2 -> 7', resolvePackagingTypeId({ packaging_type_id: 7 }, 2), 7);
  check('undefined body + stored 2 -> 2', resolvePackagingTypeId(undefined, 2), 2);
  // The orphan on recipe 7 (finding 7) is a non-integer string in an INTEGER
  // column. It is not this change's to repair, but it must not be silently
  // dropped by a round-trip either.
  check('non-integer stored id survives an absent key',
    resolvePackagingTypeId({}, 'pt1778315688913'), 'pt1778315688913');
}

// ── 11. The id arrives as a STRING, because that is how the routes call it ───
// Both routes pass `req.params.id`, which is always a string. The preserve step
// added a SELECT keyed on it, and if a string id failed to match an INTEGER
// column the lookup would come back empty, `stored` would be null, and the
// preserve would quietly become "write null" — the original bug through a new
// door, passing every case above. SQLite applies numeric affinity to the
// comparison, so it matches; asserted rather than reasoned about.
console.log('\n11. A string recipe id (what the routes actually pass) still matches');
{
  const db = makeDb();
  seedLinked(db);
  saveRecipeCostData(db, '80', { labour: 7, packaging: 1.12 });
  const r = row(db, 80);
  check('packaging_type_id preserved via string id', r.packaging_type_id, 2);
  check('labour written via string id', r.labour, 7);
  check('no second row created', db.prepare('SELECT COUNT(*) n FROM recipe_cost_data').get().n, 1);
}

console.log(failures === 0
  ? '\nAll cases behaved.\n'
  : `\n${failures} case(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
