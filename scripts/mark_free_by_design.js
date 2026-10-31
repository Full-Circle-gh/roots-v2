#!/usr/bin/env node
// Marks the ingredients that cost nothing on purpose — decided 2026-08-19:
//
//   571 F-26 Drinking Water 饮用水   — tap water, used as a cooking medium; it
//                                      belongs in the overhead % , not in the
//                                      ingredient subtotal. 26 recipes.
//   579      Lemon Zest 柠檬皮       — byproduct: the whole lemon's cost stays
//                                      with the juice. 4 recipes.
//   598 F-41 Lime Zest 青柠檬皮      — same. 1 recipe.
//
// NOT flagged, deliberately: Lemon Juice, Apple Juice, Cucumber juice and Chai
// Mix are sub-recipes with a yield loss (cucumber in, less juice out) and must
// stay visible as missing until that feature exists. Cloves Powder is a plain
// missing price for a human to type.
//
// DRY RUN BY DEFAULT — opens the database read-only and writes nothing.
//
//   node scripts/mark_free_by_design.js               # dry run
//   node scripts/mark_free_by_design.js --apply       # writes
//   node scripts/mark_free_by_design.js --db /path/roots.db
//
// Only free_by_design is written. cost_per_unit, buy_price and everything else
// are untouched — a flagged row is expected to already sit at zero, and the
// script refuses any row that does not.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : path.join(__dirname, '..', 'data', 'roots.db');

// id → the name it must still carry, so an id reused by a later import cannot
// be flagged by accident.
const TARGETS = {
  571: 'Drinking Water',
  579: 'Lemon Zest',
  598: 'Lime Zest',
};

const db = new Database(DB_PATH, { readonly: !APPLY });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${DB_PATH}${APPLY ? '' : ' (opened read-only)'}\n`);

const rows = [];
for (const [idStr, expectedName] of Object.entries(TARGETS)) {
  const id = Number(idStr);
  const r = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  if (!r) { console.error(`ABORT: ingredient id ${id} not found`); process.exit(2); }
  if ((r.name_en || '') !== expectedName) {
    console.error(`ABORT: id ${id} is named '${r.name_en}', expected '${expectedName}'`);
    process.exit(2);
  }
  const recipes = db.prepare(`SELECT COUNT(DISTINCT ri.recipe_id) AS c FROM recipe_ingredients ri
                              JOIN recipes rec ON rec.id = ri.recipe_id AND rec.is_active = 1
                             WHERE ri.ingredient_id = ?`).get(id).c;
  const cost = Number(r.cost_per_unit) || 0;
  rows.push({ r, recipes, cost, already: !!r.free_by_design, hasCost: cost > 0 });
}

console.log('  id   SKU    name            cn        cost_per_unit  buy_price  active recipes  state');
console.log('  ' + '─'.repeat(94));
for (const { r, recipes, cost, already, hasCost } of rows) {
  const state = already ? 'already flagged — no change'
    : hasCost ? 'REFUSED — carries a real cost, flagging it would erase that fact'
      : 'would be flagged';
  console.log('  ' + String(r.id).padEnd(5) + String(r.sku || '—').padEnd(7) + String(r.name_en).padEnd(16) +
    String(r.name_cn || '').padEnd(10) + String(cost).padEnd(15) + String(r.buy_price).padEnd(11) +
    String(recipes).padEnd(16) + state);
}

const toWrite = rows.filter((x) => !x.already && !x.hasCost);
console.log(`\n  ${toWrite.length} row(s) would be flagged · ${rows.filter(x => x.already).length} already · ${rows.filter(x => x.hasCost).length} refused`);
console.log(`  Recipes that stop reporting a missing cost: ${rows.reduce((s, x) => s + (x.already || x.hasCost ? 0 : x.recipes), 0)} (counting a recipe once per flagged item)`);

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write.\n');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const upd = db.prepare('UPDATE ingredients SET free_by_design = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND name_en = ?');
  for (const { r } of toWrite) {
    const res = upd.run(r.id, r.name_en);
    console.log(`  flagged ${r.sku || r.id} ${r.name_en} (${res.changes} row)`);
  }
});
tx();

console.log('\n  ── Read back from the database ───────────────────────────────');
for (const { r } of toWrite) {
  const now = db.prepare('SELECT id, sku, name_en, free_by_design, cost_per_unit, buy_price, updated_at FROM ingredients WHERE id = ?').get(r.id);
  console.log(`  ${String(now.sku || now.id).padEnd(7)}free_by_design=${now.free_by_design}  cost_per_unit=${now.cost_per_unit}  buy_price=${now.buy_price}  ${now.updated_at}`);
}
db.close();
console.log('');
