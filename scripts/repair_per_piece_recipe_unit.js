#!/usr/bin/env node
// Fourteen items carry recipe unit 'g' while being bought and used as whole
// pieces — Folding table, Ladle, Cabinet, Dessert Cup, Meat Grinder. The unit
// is simply wrong: nobody weighs out grams of ladle. Because of it the shared
// cost derivation declines them (a weight-based row with no pack contents can
// not be priced), so they never get a cost from a PO and they raise a "Cost Not
// Updated" alert every time one is ordered.
//
// This sets ingredients.unit = 'pcs' on exactly those rows. It writes nothing
// else — cost_per_unit, buy_price and the pack fields are untouched.
//
// DRY RUN BY DEFAULT — opens the database read-only and writes nothing.
//
//   node scripts/repair_per_piece_recipe_unit.js               # dry run
//   node scripts/repair_per_piece_recipe_unit.js --apply       # writes
//   node scripts/repair_per_piece_recipe_unit.js --db /path/roots.db
//
// SELECTION — a row qualifies only when ALL of:
//   * recipe unit is 'g' or 'ml'
//   * buy_unit is a container (the helper finds no grams for it)
//   * no pack contents recorded, so the helper declines it
//
// THE GUARD THAT MATTERS: changing the recipe unit changes what a recipe line
// means. If any recipe or product consumes one of these by weight, changing it
// would silently move that recipe's cost. Such a row is REFUSED — printed, not
// written — whatever else the run does.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { deriveCostPerUnit } = require('../lib/ingredient-cost');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : path.join(__dirname, '..', 'data', 'roots.db');

const db = new Database(DB_PATH, { readonly: !APPLY });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${DB_PATH}${APPLY ? '' : ' (opened read-only)'}\n`);

const candidates = db.prepare('SELECT * FROM ingredients').all().filter((r) => {
  const u = String(r.unit || '').trim().toLowerCase();
  if (!['g', 'ml'].includes(u)) return false;
  const { reason } = deriveCostPerUnit(r, r.buy_price > 0 ? r.buy_price : 1);
  return reason === 'no_pack_contents';
});

// Who consumes these, and in what unit?
const recipeUse = db.prepare(`
  SELECT ri.recipe_id, ri.qty, ri.unit, r.name_en AS recipe_name, r.is_active
    FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
   WHERE ri.ingredient_id = ?`);
const productUse = db.prepare(`
  SELECT p.id, p.name_en, p.status
    FROM products p JOIN recipe_ingredients ri ON ri.recipe_id = p.recipe_id
   WHERE ri.ingredient_id = ? GROUP BY p.id`);

const safe = [];
const refused = [];

console.log('  id   SKU    name                          item_kind  unit buy_unit  price     consumed by');
console.log('  ' + '─'.repeat(112));
for (const r of candidates.sort((a, b) => String(a.sku).localeCompare(String(b.sku)))) {
  const uses = recipeUse.all(r.id);
  const prods = productUse.all(r.id);
  // By weight = a recipe line measured in g / ml / kg / l. A line already in
  // pcs is consistent with the change and does not block it.
  const byWeight = uses.filter((u) => ['g', 'ml', 'kg', 'l', 'liter', 'litre'].includes(String(u.unit || '').trim().toLowerCase()));
  const summary = uses.length === 0
    ? 'nothing — no recipe line references it'
    : uses.map((u) => `${u.recipe_name} (${u.qty} ${u.unit || '—'}${u.is_active ? '' : ', inactive'})`).join('; ') +
      (prods.length ? ` · products: ${prods.map((p) => p.name_en).join(', ')}` : '');

  console.log('  ' + String(r.id).padEnd(5) + String(r.sku || '—').padEnd(7) + String(r.name_en || '').slice(0, 28).padEnd(30) +
    String(r.item_kind || '').padEnd(11) + String(r.unit).padEnd(5) + String(r.buy_unit || '—').padEnd(10) +
    String(r.buy_price).padEnd(10) + summary);

  (byWeight.length ? refused : safe).push({ r, byWeight, uses });
}

if (refused.length) {
  console.log('\n══ REFUSED — a recipe consumes these by weight ════════════════════');
  for (const { r, byWeight } of refused) {
    console.log(`  ${r.sku || r.id} ${r.name_en} — ${byWeight.map((u) => `${u.recipe_name}: ${u.qty} ${u.unit}`).join('; ')}`);
    console.log('    Changing its unit would move that recipe\'s cost. Left alone.');
  }
}

console.log(`\n  ${safe.length} row(s) would be set to unit='pcs' · ${refused.length} refused`);

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write.\n');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const upd = db.prepare("UPDATE ingredients SET unit = 'pcs', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND unit = ?");
  for (const { r } of safe) {
    const res = upd.run(r.id, r.unit);
    console.log(`  wrote ${r.sku || r.id}: unit ${r.unit} → pcs (${res.changes} row)`);
  }
});
tx();

console.log('\n  ── Read back from the database ───────────────────────────────');
for (const { r } of safe) {
  const now = db.prepare('SELECT id, sku, name_en, unit, cost_per_unit, updated_at FROM ingredients WHERE id = ?').get(r.id);
  console.log(`  ${String(now.sku || now.id).padEnd(7)}unit=${String(now.unit).padEnd(5)}cost_per_unit=${String(now.cost_per_unit).padEnd(12)}updated_at=${now.updated_at}`);
}
db.close();
console.log('');
