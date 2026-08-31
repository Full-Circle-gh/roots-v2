#!/usr/bin/env node
/**
 * Audit (and optionally clean up) the material rows a REPACK recipe was given
 * before ensureMaterialized() learned not to give them one.
 *
 * WHY THIS EXISTS. §29's third addendum has every recipe save file its output
 * as a material, because a product's build list can only point at a material —
 * that is how a cooked thing reaches a cost, and it is not optional. But a
 * ONE-LINE recipe is a repack, not a made thing: "one 120g bag is 120g of the
 * bulk dates we already buy". routes/retail-product-build.js already costs
 * that case with no material at all (its 'repack' state offers the sole line's
 * material at the recipe's own quantity), so the row it was given is a second
 * copy of something Roots already buys. Ash reported the pair this started
 * from: "Nour Dates (retail)" beside "Dates（Nour）", the same dates twice.
 *
 * lib/recipe-materialize.js now skips repacks, so no NEW ones appear. The rows
 * created before that are still there, and this is what finds them.
 *
 * IT IS CAUTIOUS BY DESIGN. A made row is only offered for cleanup when
 * NOTHING points at it — no build line, no other recipe's ingredient line, no
 * purchase history. Anything still referenced is listed under KEEP with the
 * reason, because unlinking it would take a real cost path out from under a
 * product, and a duplicate on a screen is a smaller problem than a product
 * that silently costs zero.
 *
 * --write UNLINKS AND ARCHIVES. It never DELETEs: the row's last computed cost
 * is still a real number, and archiving is reversible from the Materials screen
 * where a delete is not. Unlinking first is what stops the next save of that
 * recipe from simply re-adopting it.
 *
 * Read-only by default. Run ON THE SERVER:
 *   node scripts/audit_repack_materials.js            # report
 *   node scripts/audit_repack_materials.js --write    # unlink + archive the clear ones
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

// Every made material whose recipe is a one-liner pointing at a LIVE material —
// exactly the test ensureMaterialized() now applies, so this finds precisely
// the rows that would not be created today.
const candidates = db.prepare(`
  SELECT i.id, i.name_en, i.name_cn, i.sku, i.cost_per_unit, i.is_active,
         r.id AS recipe_id, r.name_en AS recipe_name, r.is_active AS recipe_active,
         b.id AS bulk_id, b.name_en AS bulk_name, b.sku AS bulk_sku, ri.qty AS bulk_qty
    FROM ingredients i
    JOIN recipes r ON r.id = i.source_recipe_id
    JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    JOIN ingredients b ON b.id = ri.ingredient_id AND COALESCE(b.is_active, 1) = 1
   WHERE i.source_recipe_id IS NOT NULL
     AND (SELECT COUNT(*) FROM recipe_ingredients x WHERE x.recipe_id = r.id) = 1
   ORDER BY i.name_en COLLATE NOCASE`).all();

const buildLines = db.prepare('SELECT COUNT(*) AS n FROM product_build_lines WHERE ingredient_id = ?');
const recipeLines = db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients WHERE ingredient_id = ?');
const poLines = db.prepare('SELECT COUNT(*) AS n FROM po_line_items WHERE ingredient_id = ?');

const clear = [];
const keep = [];

for (const c of candidates) {
  const reasons = [];
  const b = buildLines.get(c.id).n;
  const rl = recipeLines.get(c.id).n;
  const po = poLines.get(c.id).n;
  if (b) reasons.push(`${b} build line(s)`);
  if (rl) reasons.push(`${rl} recipe line(s)`);
  if (po) reasons.push(`${po} purchase line(s)`);
  if (!c.is_active) reasons.push('already archived');
  (reasons.length ? keep : clear).push(Object.assign({ reasons }, c));
}

const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

console.log(`\nDB: ${DB_PATH}`);
console.log(`Made materials whose recipe is a one-line repack: ${candidates.length}\n`);

if (clear.length) {
  console.log(`── ${WRITE ? 'UNLINKING + ARCHIVING' : 'WOULD UNLINK + ARCHIVE'} — nothing points at these ${clear.length} ──`);
  console.log(`  ${pad('MADE ROW', 34)}${pad('SKU', 10)}${pad('IS A REPACK OF', 34)}QTY`);
  for (const c of clear) {
    console.log(`  ${pad(c.name_en, 34)}${pad(c.sku, 10)}${pad(c.bulk_name, 34)}${c.bulk_qty}`);
  }
  console.log();
}

if (keep.length) {
  console.log(`── KEEPING — still referenced, ${keep.length} ──`);
  for (const c of keep) {
    console.log(`  ${pad(c.name_en, 34)}${pad(c.sku, 10)}${c.reasons.join(', ')}`);
  }
  console.log();
}

if (!candidates.length) console.log('Nothing to do.\n');

if (WRITE && clear.length) {
  const run = db.transaction(() => {
    const unlink = db.prepare(
      'UPDATE ingredients SET source_recipe_id = NULL, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const c of clear) unlink.run(c.id);
  });
  run();
  console.log(`Done — ${clear.length} row(s) unlinked and archived.`);
  console.log('Each product that used one now costs through its recipe\'s own line');
  console.log('(the build screen\'s \'repack\' state). Check any that were on a build list.\n');
} else if (clear.length) {
  console.log('Dry run. Re-run with --write to apply.\n');
}

db.close();
