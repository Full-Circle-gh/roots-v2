#!/usr/bin/env node
/**
 * One-shot: wire up the 6 variant groups detected in Products.xlsx by
 * matching products on (external_id) when known, or (name_en) as fallback.
 *
 * Each group's `group_id` becomes the FIRST member's product id. Labels
 * are derived from the parenthetical / size markers in each name.
 *
 * Idempotent — re-running is safe. Updates existing variant_group_id +
 * variant_label values; doesn't create duplicate groups.
 *
 * Run modes:
 *   node scripts/seed_variant_groups.js --dry-run
 *   node scripts/seed_variant_groups.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const DRY = process.argv.includes('--dry-run');
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
db.pragma('journal_mode = WAL');

// Source-of-truth groupings from the XLSX analysis. Each entry is a list of
// { ext_id, label }. ext_id matches products.external_id (Zoho ID); label
// is the variant axis value the buyer sees on the product card.
const GROUPS = [
  { name: 'Foaming Hand Soap', members: [
    { ext_id: 1229875, label: 'Lemongrass · 柠檬草' },
    { ext_id: 1229804, label: 'Mint · 薄荷' },
    { ext_id: 1229966, label: 'Lavender · 薰衣草' },
  ]},
  { name: 'Peanut Butter', members: [
    { ext_id: 1229669, label: 'Classic 经典' },
    { ext_id: 1229700, label: 'Crunchy 颗粒' },
  ]},
  { name: 'Oatly Chocolate Flavor', members: [
    { ext_id: 1229972, label: 'Small ¥10 小杯' },
    { ext_id: 1229675, label: 'Large ¥38 大瓶' },
  ]},
  { name: 'Oatly Classic', members: [
    { ext_id: 1229971, label: 'Small ¥10 小杯' },
    { ext_id: 1229670, label: 'Large ¥39 大瓶' },
  ]},
  { name: 'Medjool Dates', members: [
    { ext_id: 1229905, label: 'Misfits 次品' },
    { ext_id: 1229886, label: 'Jumbo Size 特大装' },
  ]},
  { name: 'Coconut Yogurt Probiotic', members: [
    { ext_id: 1229703, label: 'Vanilla 香草' },
    { ext_id: 1259338, label: 'Peach 桃子' },
  ]},
];

const findById  = db.prepare('SELECT id, name_en, variant_group_id, variant_label FROM products WHERE external_id = ?');
const updateRow = db.prepare('UPDATE products SET variant_group_id = ?, variant_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

const stats = { groupsApplied: 0, productsUpdated: 0, missing: [] };

if (DRY) console.log('=== DRY-RUN — no writes ===\n');

const tx = db.transaction(() => {
  for (const g of GROUPS) {
    // Resolve members → DB ids
    const resolved = [];
    for (const m of g.members) {
      const row = findById.get(m.ext_id);
      if (!row) { stats.missing.push({ group: g.name, ext_id: m.ext_id }); continue; }
      resolved.push({ id: row.id, name_en: row.name_en, label: m.label });
    }
    if (resolved.length < 2) {
      console.log(`  [skip] ${g.name} — only ${resolved.length} member(s) found in DB`);
      continue;
    }
    const groupId = resolved[0].id;  // stable: first member owns the group
    console.log(`  [${g.name}] group_id=${groupId} — ${resolved.length} members:`);
    for (const r of resolved) {
      console.log(`     id=${r.id}  ${r.name_en}  →  label="${r.label}"`);
      if (!DRY) updateRow.run(groupId, r.label, r.id);
      stats.productsUpdated++;
    }
    stats.groupsApplied++;
  }
});
tx();

console.log('');
console.log(`✅ ${DRY ? 'Would apply' : 'Applied'}: ${stats.groupsApplied} groups, ${stats.productsUpdated} products updated.`);
if (stats.missing.length) {
  console.log(`⚠ Missing from DB (${stats.missing.length}):`);
  for (const m of stats.missing) console.log(`    ${m.group} — ext_id=${m.ext_id}`);
}
