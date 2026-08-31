#!/usr/bin/env node
/**
 * Audit (and optionally clean up) the material rows that recipes were given
 * automatically and nothing ever used.
 *
 * WHY THIS EXISTS. §29's third addendum has every recipe save file its output
 * as a material, because a product's build list can only point at a material —
 * that is how a cooked thing reaches a cost, and it is not optional. The side
 * effect is that a recipe nobody ever builds a product from, and no other
 * recipe cooks with, still put a row in the Materials list. 122 of 138 active
 * recipes have one. Ash: "every time I add a new recipe it becomes a material,
 * even when it doesn't need to be."
 *
 * TWO DIFFERENT THINGS ARE WRONG, AND THEY NEED DIFFERENT ANSWERS:
 *
 *   A · REPACK TWINS. A one-line recipe is not a made thing — "one 120g bag is
 *       120g of the bulk dates we already buy" — so its row is a second copy
 *       of something Roots already buys, sitting beside the original. This is
 *       the pair Ash reported: "Nour Dates (retail)" and "Dates（Nour）".
 *       routes/retail-product-build.js already costs a repack with no material
 *       at all (its 'repack' state, the sole line at the recipe's own qty), so
 *       the row buys nothing. UNLINKED AND ARCHIVED: unlinking is what stops
 *       the next save re-adopting it, and lib/recipe-materialize.js now returns
 *       'repack' before the collision check, so an unlinked twin cannot come
 *       back as a queued collision either.
 *
 *   B · UNUSED MADE ROWS. A real multi-line recipe whose material nothing has
 *       ever pointed at. The row is not wrong, it is just early — the recipe
 *       may well go into a product next month. ARCHIVED, LINK KEPT. Keeping
 *       the link is the whole trick: ensureMaterialized() finds it on the next
 *       save and reports 'updated', so the row stays archived, stays out of the
 *       list, and no duplicate appears. Unlinking these instead would make the
 *       next save queue a name collision against the row just archived — a
 *       question with no screen to answer it. Unarchive from the Materials
 *       screen the moment the recipe is actually used.
 *
 * IT IS CAUTIOUS BY DESIGN. A row is only offered when NOTHING references it:
 * no build line, no other recipe's ingredient line, no purchase, no kitchen
 * order, no price history — and no product pointing at its recipe, because the
 * build screen would offer that material the moment someone opened the product.
 * Anything else is listed under KEEP with the reason. A duplicate on a screen
 * is a smaller problem than a product that silently costs nothing.
 *
 * It never DELETEs. The row's last computed cost is still a real number, other
 * things may point at it later, and archiving is reversible from the Materials
 * screen where a delete is not.
 *
 * Read-only by default. Run ON THE SERVER:
 *   node scripts/audit_made_materials.js            # report
 *   node scripts/audit_made_materials.js --write    # apply
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
// READ-ONLY UNLESS --write. This is meant to be run against the live database
// while pm2 is serving from it, so the reporting pass is opened in a mode where
// a stray UPDATE cannot execute at all — the guarantee is enforced by SQLite,
// not by trusting that every branch below happens to be a SELECT.
const db = new Database(DB_PATH, WRITE ? {} : { readonly: true });

// Every live material a recipe backs, with the shape of that recipe alongside:
// how many lines it has, and (for a one-liner) the live material it repacks.
// lineCount + soleLive together are the same test ensureMaterialized() applies,
// so class A here is exactly the set that would not be created today.
const made = db.prepare(`
  SELECT i.id, i.name_en, i.name_cn, i.sku, i.cost_per_unit,
         r.id AS recipe_id, r.name_en AS recipe_name, r.is_active AS recipe_active,
         (SELECT COUNT(*) FROM recipe_ingredients x WHERE x.recipe_id = r.id) AS line_count,
         (SELECT b.name_en FROM recipe_ingredients ri JOIN ingredients b ON b.id = ri.ingredient_id
           WHERE ri.recipe_id = r.id AND COALESCE(b.is_active, 1) = 1) AS sole_live_name,
         (SELECT ri.qty FROM recipe_ingredients ri JOIN ingredients b ON b.id = ri.ingredient_id
           WHERE ri.recipe_id = r.id AND COALESCE(b.is_active, 1) = 1) AS sole_qty
    FROM ingredients i
    JOIN recipes r ON r.id = i.source_recipe_id
   WHERE i.source_recipe_id IS NOT NULL AND COALESCE(i.is_active, 1) = 1
   ORDER BY i.name_en COLLATE NOCASE`).all();

// Everything that can make a material row worth keeping. Deliberately wider
// than "is it costing something today": a purchase or a kitchen order is
// history a human may still need to read, and a product pointing at the recipe
// is a build line waiting to be added.
const REFS = [
  ['build line', 'SELECT COUNT(*) AS n FROM product_build_lines WHERE ingredient_id = ?'],
  ['recipe line', 'SELECT COUNT(*) AS n FROM recipe_ingredients WHERE ingredient_id = ?'],
  ['purchase line', 'SELECT COUNT(*) AS n FROM po_line_items WHERE ingredient_id = ?'],
  ['kitchen order', 'SELECT COUNT(*) AS n FROM kitchen_order_items WHERE ingredient_id = ?'],
  ['price history', 'SELECT COUNT(*) AS n FROM ingredient_price_history WHERE ingredient_id = ?'],
].map(([label, sql]) => [label, db.prepare(sql)]);

const productsOnRecipe = db.prepare('SELECT COUNT(*) AS n FROM store_products WHERE recipe_id = ?');

const repack = [];   // class A — unlink + archive
const unused = [];   // class B — archive, keep the link
const keep = [];

for (const m of made) {
  const reasons = [];
  for (const [label, stmt] of REFS) {
    const n = stmt.get(m.id).n;
    if (n) reasons.push(`${n} ${label}${n > 1 ? 's' : ''}`);
  }
  const prods = productsOnRecipe.get(m.recipe_id).n;
  // A product pointing at this recipe is offered this exact material by the
  // build screen ('ready'), so archiving it would turn a working screen into
  // "the recipe must be saved once" — except for a repack, which that same
  // screen costs without a material anyway.
  const isRepack = m.line_count === 1 && m.sole_live_name != null;
  if (prods && !isRepack) reasons.push(`${prods} product(s) use the recipe`);

  if (reasons.length) keep.push(Object.assign({ reasons }, m));
  else if (isRepack) repack.push(m);
  else unused.push(m);
}

const w = (s, n) => {
  s = String(s == null ? '' : s);
  // CJK glyphs occupy two terminal cells; pad by display width, not length.
  let width = 0;
  for (const ch of s) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - width));
};

console.log(`\nDB: ${DB_PATH}`);
console.log(`Live materials backed by a recipe: ${made.length}`);
console.log(`  repack twins ............ ${repack.length}`);
console.log(`  made but never used ..... ${unused.length}`);
console.log(`  in use, keeping ......... ${keep.length}\n`);

if (repack.length) {
  console.log(`── A · ${WRITE ? 'UNLINKED + ARCHIVED' : 'WOULD UNLINK + ARCHIVE'} — repack twins, ${repack.length} ──`);
  console.log(`  ${w('MADE ROW', 32)}${w('SKU', 10)}${w('IS A REPACK OF', 32)}QTY`);
  for (const m of repack) console.log(`  ${w(m.name_en, 32)}${w(m.sku, 10)}${w(m.sole_live_name, 32)}${m.sole_qty}`);
  console.log();
}

if (unused.length) {
  console.log(`── B · ${WRITE ? 'ARCHIVED' : 'WOULD ARCHIVE'} (link kept) — never used, ${unused.length} ──`);
  console.log(`  ${w('MADE ROW', 32)}${w('SKU', 10)}${w('FROM RECIPE', 32)}LINES`);
  for (const m of unused) console.log(`  ${w(m.name_en, 32)}${w(m.sku, 10)}${w(m.recipe_name, 32)}${m.line_count}`);
  console.log();
}

if (keep.length) {
  console.log(`── KEEPING — in use, ${keep.length} ──`);
  for (const m of keep) console.log(`  ${w(m.name_en, 32)}${w(m.sku, 10)}${m.reasons.join(', ')}`);
  console.log();
}

if (!made.length) console.log('Nothing to do.\n');

if (WRITE && (repack.length || unused.length)) {
  const unlinkArchive = db.prepare(
    'UPDATE ingredients SET source_recipe_id = NULL, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const archiveOnly = db.prepare(
    'UPDATE ingredients SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  db.transaction(() => {
    for (const m of repack) unlinkArchive.run(m.id);
    for (const m of unused) archiveOnly.run(m.id);
  })();
  console.log(`Done — ${repack.length} repack twin(s) unlinked and archived, ${unused.length} unused row(s) archived.`);
  console.log('Nothing was deleted. Tick "Archived" on the Materials screen to see them,');
  console.log('and un-archive any the kitchen still wants.\n');
} else if (repack.length || unused.length) {
  console.log('Dry run. Re-run with --write to apply.\n');
}

db.close();
