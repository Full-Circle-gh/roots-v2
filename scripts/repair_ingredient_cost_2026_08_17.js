#!/usr/bin/env node
// One-off repair: four ingredients whose cost_per_unit holds the PACK price
// undivided, written there by the old PO price write-back (see the
// firePriceAlertsForPO comment in routes/purchases.js).
//
// DRY RUN BY DEFAULT. It opens the database read-only and prints what it would
// do. Nothing is written without --apply.
//
//   node scripts/repair_ingredient_cost_2026_08_17.js               # dry run
//   node scripts/repair_ingredient_cost_2026_08_17.js --apply       # writes
//   node scripts/repair_ingredient_cost_2026_08_17.js --db /path/to/roots.db
//
// SCOPE — exactly these four ids, verified by SKU before anything is touched:
//   254 F-15 Real Thai Coconut Milk   (1000×)
//   139 C-5  Red Lentils              (500×)
//   547 A-80 Oregano leaf             (100×)
//   234 E-40 Dry Mint Leaves          (95×)
//
// DELIBERATELY EXCLUDED:
//   405 4-250 Tortilla chips — recipe unit 'pcs', so ¥28 per piece is correct.
//       The script re-checks that unit and refuses to run if it has changed.
//   The 24 container-bought rows with no pack contents (equipment, packaging)
//       — per-piece items whose stored cost is already right.
//
// Only cost_per_unit (and updated_at) are written. buy_price, buy_unit, pack
// fields and everything else are left exactly as they are.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { deriveCostPerUnit } = require('../lib/ingredient-cost');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1]
  ? args[dbIdx + 1]
  : path.join(__dirname, '..', 'data', 'roots.db');

// id → the SKU it must still carry. A mismatch aborts the whole run: ids are
// only meaningful next to the SKU they were surveyed under.
const TARGETS = { 254: 'F-15', 139: 'C-5', 547: 'A-80', 234: 'E-40' };
const EXCLUDED_PCS_ID = 405;

const db = new Database(DB_PATH, { readonly: !APPLY });
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · ${DB_PATH}${APPLY ? '' : ' (opened read-only)'}\n`);

// ── Guard: the excluded row must still be the per-piece item we excluded ──
const excluded = db.prepare('SELECT id, sku, name_en, unit, cost_per_unit, buy_price FROM ingredients WHERE id = ?').get(EXCLUDED_PCS_ID);
if (!excluded) {
  console.log(`  note: id ${EXCLUDED_PCS_ID} no longer exists — nothing to exclude`);
} else if (String(excluded.unit).toLowerCase() !== 'pcs') {
  console.error(`ABORT: id ${EXCLUDED_PCS_ID} (${excluded.sku}) has recipe unit '${excluded.unit}', not 'pcs'.`);
  console.error('It was excluded on the grounds that it is a per-piece item. That premise no longer holds.');
  process.exit(2);
} else {
  console.log(`  excluded ${excluded.sku} ${excluded.name_en} — recipe unit '${excluded.unit}', ¥${excluded.buy_price} per piece is correct\n`);
}

const rows = [];
let blocked = 0;

for (const [idStr, expectedSku] of Object.entries(TARGETS)) {
  const id = Number(idStr);
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  if (!ing) { console.error(`ABORT: ingredient id ${id} not found`); process.exit(2); }
  if ((ing.sku || '') !== expectedSku) {
    console.error(`ABORT: id ${id} carries SKU '${ing.sku}', expected '${expectedSku}'`);
    process.exit(2);
  }

  const { cpu, reason } = deriveCostPerUnit(ing, ing.buy_price);
  const old = Number(ing.cost_per_unit);

  // Precondition: the row must still look un-repaired, i.e. the stored cost is
  // the pack price rather than the derived one. If someone has already fixed it
  // (a Save on the ingredient form does exactly that), leave it alone.
  const looksUnrepaired = cpu !== null && Math.abs(old - Number(ing.buy_price)) <= 0.005 && Math.abs(old - cpu) > 1e-9;

  rows.push({ id, sku: ing.sku, name: ing.name_en, unit: ing.unit, buy_unit: ing.buy_unit,
              pack: ing.buy_pack_size, contents: `${ing.pack_contents_qty ?? '—'} ${ing.pack_contents_unit ?? ''}`.trim(),
              buy_price: ing.buy_price, old, cpu, reason, looksUnrepaired });
  if (!looksUnrepaired) blocked++;
}

const f = (v) => (v === null || v === undefined ? '—' : String(v));
console.log('  id   SKU    name                     unit  buy_unit  pack  contents  pack price   stored cost →  new cost      ratio  reason');
console.log('  ' + '─'.repeat(120));
for (const r of rows) {
  const ratio = r.cpu ? (r.old / r.cpu) : null;
  console.log(
    `  ${String(r.id).padEnd(4)} ${f(r.sku).padEnd(6)} ${f(r.name).slice(0, 24).padEnd(24)} ${f(r.unit).padEnd(5)} ` +
    `${f(r.buy_unit).padEnd(9)} ${f(r.pack).padEnd(5)} ${f(r.contents).padEnd(9)} ` +
    `${('¥' + f(r.buy_price)).padEnd(12)} ${f(r.old).padEnd(14)} ${f(r.cpu === null ? null : +r.cpu.toFixed(6)).padEnd(13)} ` +
    `${ratio ? ratio.toFixed(0) + '×' : '—'}     ${r.reason}${r.looksUnrepaired ? '' : '   ← SKIPPED (already repaired or unexpected shape)'}`
  );
}

const toWrite = rows.filter(r => r.looksUnrepaired && r.cpu !== null && r.reason === 'divided');
console.log(`\n  ${toWrite.length} row(s) would be written, ${blocked} skipped.`);

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write these values.\n');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND sku = ?');
  for (const r of toWrite) {
    const res = upd.run(r.cpu, r.id, r.sku);
    console.log(`  wrote ${r.sku}: ${r.old} → ${r.cpu} (${res.changes} row)`);
  }
});
tx();

console.log('\n  ── Read back from the database ───────────────────────────────');
for (const r of toWrite) {
  const now = db.prepare('SELECT id, sku, cost_per_unit, buy_price, updated_at FROM ingredients WHERE id = ?').get(r.id);
  console.log(`  ${now.sku.padEnd(6)} cost_per_unit=${now.cost_per_unit}  buy_price=${now.buy_price}  updated_at=${now.updated_at}`);
}
db.close();
console.log('');
