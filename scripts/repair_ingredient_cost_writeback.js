#!/usr/bin/env node
// Repair ingredients whose cost_per_unit holds a pack price instead of a cost
// per recipe unit — the damage the old PO write-back did before 2026-08-18
// (see routes/purchases.js firePriceAlertsForPO).
//
// This DETECTS. It takes no list of ids, because the old code kept producing
// casualties until the fix reached production, and a hardcoded list goes stale
// the moment another PO is flipped. Run it again whenever you suspect more.
//
// DRY RUN BY DEFAULT — opens the database read-only and writes nothing.
//
//   node scripts/repair_ingredient_cost_writeback.js                  # dry run
//   node scripts/repair_ingredient_cost_writeback.js --apply          # writes
//   node scripts/repair_ingredient_cost_writeback.js --db /path/roots.db
//
// SELECTION RULE — a row is repaired only when ALL of:
//   1. ingredients.unit is 'g' or 'ml'          (the recipe consumes weight)
//   2. the shared helper resolves grams > 0     (the pack size is knowable)
//   3. |stored − helper result| > 0.000001      (it is actually wrong)
//
// Everything else is NAMED in the output as skipped, never dropped silently:
//   * per-piece recipe units (pcs / bag / bottle / box) — the pack price IS the
//     cost for these, so a stored value equal to buy_price is CORRECT. 4-250
//     tortilla chips and the 4-7xx Yunnan coffees live here.
//   * rows the helper declines — no pack contents recorded, or no price.
//   * inactive rows that would otherwise qualify.
//
// Only cost_per_unit and updated_at are written. buy_price, buy_unit and the
// pack fields are never touched.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { deriveCostPerUnit, PER_PIECE_RECIPE_UNITS } = require('../lib/ingredient-cost');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : path.join(__dirname, '..', 'data', 'roots.db');
const EPS = 0.000001;

const db = new Database(DB_PATH, { readonly: !APPLY });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${DB_PATH}${APPLY ? '' : ' (opened read-only)'}\n`);

const rows = db.prepare('SELECT * FROM ingredients').all();

const repair = [];
const skipPerPiece = [];
const skipDeclined = [];
const skipInactive = [];

for (const r of rows) {
  const recipeUnit = String(r.unit || '').trim().toLowerCase();
  const { cpu, reason, gramsPerBuyUnit } = deriveCostPerUnit(r, r.buy_price);
  const stored = Number(r.cost_per_unit);

  const row = {
    id: r.id, sku: r.sku || '—', name: (r.name_en || '').slice(0, 30),
    unit: recipeUnit, buy_unit: r.buy_unit || '—',
    contents: r.pack_contents_qty == null ? '—' : `${r.pack_contents_qty} ${r.pack_contents_unit || ''}`.trim(),
    stored, price: Number(r.buy_price), cpu, reason, grams: gramsPerBuyUnit,
    active: r.is_active == null ? 1 : r.is_active,
    ratio: cpu ? stored / cpu : null,
    // A pure pack-price artefact stores exactly what the supplier charged. A row
    // that differs from the helper WITHOUT matching buy_price got its value some
    // other way (a hand edit, an import) and is worth a second look.
    packPriceArtefact: Math.abs(stored - Number(r.buy_price)) <= 0.005,
  };

  if (PER_PIECE_RECIPE_UNITS.includes(recipeUnit)) {
    // Correct as they stand. Only surface the ones a divide-based detector
    // would flag, i.e. where the pack holds a measurable quantity — otherwise
    // every per-piece item in the catalogue would print.
    if (row.packPriceArtefact && gramsPerBuyUnit > 1) skipPerPiece.push(row);
    continue;
  }
  if (!['g', 'ml'].includes(recipeUnit)) { skipDeclined.push({ ...row, reason: 'unsupported_recipe_unit' }); continue; }
  if (cpu === null) { skipDeclined.push(row); continue; }
  if (Math.abs(stored - cpu) <= EPS) continue;          // already correct
  if (!row.active) { skipInactive.push(row); continue; }
  repair.push(row);
}

const f = (v, w) => String(v).padEnd(w);
const line = (r) => '  ' + f(r.id, 5) + f(r.sku, 7) + f(r.name, 32) + f(r.unit, 5) + f(r.buy_unit, 8) +
  f(r.contents, 10) + f(r.stored, 22) + f(r.cpu === null ? '—' : +r.cpu.toFixed(6), 13) +
  (r.ratio ? Math.round(r.ratio) + '×' : '—');

console.log('══ TO REPAIR ══════════════════════════════════════════════════════');
if (!repair.length) console.log('  (nothing — every weight-based row already matches the helper)');
else {
  const byRatio = {};
  for (const r of repair) (byRatio[Math.round(r.ratio)] = byRatio[Math.round(r.ratio)] || []).push(r);
  for (const ratio of Object.keys(byRatio).map(Number).sort((a, b) => b - a)) {
    const list = byRatio[ratio];
    console.log(`\n  ── ${ratio}× too high · ${list.length} row${list.length === 1 ? '' : 's'} ──`);
    console.log('  id   SKU    name                            unit buy_unit contents  stored                proposed     ratio');
    for (const r of list.sort((a, b) => a.sku.localeCompare(b.sku))) {
      console.log(line(r) + (r.packPriceArtefact ? '' : '   ← stored ≠ buy_price, check by hand'));
    }
  }
}

console.log('\n══ SKIPPED — CORRECT AS THEY STAND (per-piece recipe unit) ════════');
if (!skipPerPiece.length) console.log('  (none)');
for (const r of skipPerPiece.sort((a, b) => a.sku.localeCompare(b.sku))) {
  console.log(`  ${f(r.id, 5)}${f(r.sku, 7)}${f(r.name, 32)}unit=${f(r.unit, 7)}¥${f(r.stored, 10)} per ${r.unit} — pack holds ${r.contents}, price is per package`);
}

console.log('\n══ SKIPPED — HELPER DECLINES ══════════════════════════════════════');
if (!skipDeclined.length) console.log('  (none)');
const byReason = {};
for (const r of skipDeclined) (byReason[r.reason] = byReason[r.reason] || []).push(r);
for (const [reason, list] of Object.entries(byReason)) {
  console.log(`\n  ── ${reason} · ${list.length} row${list.length === 1 ? '' : 's'} ──`);
  for (const r of list.sort((a, b) => a.sku.localeCompare(b.sku))) {
    console.log(`  ${f(r.id, 5)}${f(r.sku, 7)}${f(r.name, 32)}unit=${f(r.unit, 5)}buy=${f(r.buy_unit, 8)}contents=${f(r.contents, 10)}stored=${f(r.stored, 12)}price=${r.price}`);
  }
}

if (skipInactive.length) {
  console.log('\n══ SKIPPED — INACTIVE ROWS THAT WOULD OTHERWISE QUALIFY ═══════════');
  for (const r of skipInactive) console.log(line(r));
}

console.log(`\n  ${repair.length} to repair · ${skipPerPiece.length} correct per-piece · ${skipDeclined.length} declined · ${skipInactive.length} inactive`);

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write these values.\n');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND sku IS ?');
  for (const r of repair) {
    const res = upd.run(r.cpu, r.id, r.sku === '—' ? null : r.sku);
    console.log(`  wrote ${r.sku}: ${r.stored} → ${r.cpu} (${res.changes} row)`);
  }
});
tx();

console.log('\n  ── Read back from the database ───────────────────────────────');
for (const r of repair) {
  const now = db.prepare('SELECT id, sku, unit, cost_per_unit, buy_price, updated_at FROM ingredients WHERE id = ?').get(r.id);
  console.log(`  ${f(now.sku, 7)}cost_per_unit=${f(now.cost_per_unit, 22)}buy_price=${f(now.buy_price, 10)}updated_at=${now.updated_at}`);
}
db.close();
console.log('');
