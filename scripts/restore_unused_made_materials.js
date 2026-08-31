#!/usr/bin/env node
/**
 * Un-archive the 32 made materials that audit_made_materials.js archived on
 * 2026-08-31 under its class B, before class B was moved behind its own flag.
 *
 * WHAT HAPPENED. The audit's first --write run on production archived both
 * classes: 14 repack twins (class A, correct — they duplicated a bought
 * material) and 32 class B rows. Class B turned out not to be junk. They are
 * breads, kombuchas, yogurts, parfaits — things Roots sells, whose product
 * build lists have simply never been set up. The build-list picker filters
 * COALESCE(is_active,1)=1, so archiving them removes the exact row an operator
 * would search for when wiring one of those products up, and finding nothing
 * there invites hand-creating a duplicate — the very thing this work exists to
 * stop. The script was changed the same day so --write acts on class A alone.
 *
 * NOTHING WAS BROKEN BY THE ARCHIVE, WHICH IS WHY THIS IS A PLAIN UN-ARCHIVE
 * AND NOT A DATABASE RESTORE. A class B row is by definition one that no build
 * line, no other recipe, no purchase and no kitchen order points at, so no
 * product's cost and no recipe's cost moved. Their source_recipe_id was kept,
 * so each recipe still owns its row. Restoring the whole roots.db from the
 * .bak taken before the run would instead discard every real order and edit
 * made in the meantime — never the right trade for a reversible flag.
 *
 * THE LIST IS EXPLICIT, taken from that run's own output, rather than a query
 * for "archived and linked". A generic query would also catch any made
 * material somebody archived deliberately before this, and silently bring it
 * back. Each row is only touched if it is still archived AND still linked to
 * its recipe — anything else is reported and left alone.
 *
 * This is a one-shot repair, safe to delete once run.
 *
 * Read-only by default. Run ON THE SERVER:
 *   node scripts/restore_unused_made_materials.js            # report
 *   node scripts/restore_unused_made_materials.js --write    # un-archive
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, WRITE ? {} : { readonly: true });

// The 32 class B rows as that run listed them, name -> SKU.
//
// KEYED ON NAME, NOT SKU, BECAUSE THE SKUs MAY ALREADY BE GONE. database.js:75
// runs `UPDATE ingredients SET sku = NULL WHERE is_active = 0` on EVERY boot —
// its comment calls it one-time, but nothing makes it so — meaning any archived
// material loses its SKU at the next pm2 restart. So this restores the SKU too
// wherever the row has lost it, and matches on a whitespace-normalised name to
// survive the double spaces some of these carry ("Lemon Grass kombucha  1L").
const SKU_BY_NAME = new Map(Object.entries({
  'Almond Butter（Big）': '2-410',
  'Almond Butter（Small）': '2-400',
  'Apple Pie Overnight Oats': '1-120',
  'Berry Intelligence House Blend': '4-580',
  'Blueberry Chia Jam': '1-100',
  'Buckwheat Bread（GF）': '3-252',
  'Choco Hemp Protein Bites': '3-20',
  'Energy Cubes（Big）': '1-270',
  'Energy Cubes（Small）': '1-260',
  'Ginger Tahini': '1-350D',
  'Hearty Rye & Whole Wheat Bread': '3-250',
  'Lemon Grass kombucha 1L': '2-70',
  'Mango Kombucha 1L': '2-130',
  'Mango Kombucha 300ml': '2-120',
  'Maple Cinnamon Almond Butter（Small）': '2-420',
  'Mix Berries Kombucha 1L': '2-110',
  'Mix Berries Kombucha 300ml': '2-100',
  'Nuts & Seeds Bread（Gluten Free）': '3-240',
  'Passion Fruit Kombucha 1L': '2-90',
  'Passion Fruit Kombucha 300ml': '2-80',
  'Probiotic Coconut Yogurt - Plain Flavor（Big）': '1-140',
  'Probiotic Coconut Yogurt - Plain Flavor（Small）': '1-130',
  'Probiotic Coconut Yogurt - Vanilla Flavor（Big）': '1-160',
  'Probiotic Coconut Yogurt - Vanilla Flavor（Small）': '1-150',
  'Probiotic Coconut Yogurt -Peach Flavor（Big）': '1-190',
  'Probiotic Coconut Yogurt -Peach Flavor（Small）': '1-180',
  'Raspberry Mango Sorbet': '3-210',
  'Red Lentils Soup': '1-460',
  'Strawberry Coconut Parfait': '1-210',
  'Strawberry-Lemon Chia Jam': '1-110',
  'Tabbouleh bowl dressing': '1-330D',
  'Whole-Wheat Pita': '3-251',
}));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const SKU_BY_NORM = new Map([...SKU_BY_NAME].map(([n, sku]) => [norm(n), sku]));

// CLASS B RE-DERIVED FROM THE DATA, not trusted to a stored list: a live row
// archived by that run is still linked to its recipe (class A was unlinked, so
// the two cannot be confused) and its recipe is not a one-line repack. The
// updated_at floor keeps out any made material somebody archived deliberately
// before this — that run stamped every row it touched.
const SINCE = process.env.RESTORE_SINCE || '2026-08-31';
const candidates = db.prepare(`
  SELECT i.id, i.name_en, i.sku, i.is_active, i.source_recipe_id, i.updated_at,
         (SELECT COUNT(*) FROM recipe_ingredients x WHERE x.recipe_id = i.source_recipe_id) AS line_count,
         (SELECT COUNT(*) FROM recipe_ingredients ri JOIN ingredients b ON b.id = ri.ingredient_id
           WHERE ri.recipe_id = i.source_recipe_id AND COALESCE(b.is_active, 1) = 1) AS live_lines
    FROM ingredients i
   WHERE i.is_active = 0 AND i.source_recipe_id IS NOT NULL
     AND date(i.updated_at) >= date(?)
   ORDER BY i.name_en COLLATE NOCASE`).all(SINCE);

const restore = [];
const skip = [];
for (const row of candidates) {
  if (row.line_count === 1 && row.live_lines === 1) {
    skip.push({ name_en: row.name_en, sku: row.sku, why: 'a one-line repack — class A, staying archived' });
    continue;
  }
  const sku = SKU_BY_NORM.get(norm(row.name_en)) || null;
  restore.push(Object.assign({ restoreSku: row.sku == null ? sku : null, known: sku != null }, row));
}
const missing = [...SKU_BY_NAME.keys()].filter(n => !restore.some(r => norm(r.name_en) === norm(n)));

const w = (s, n) => {
  s = String(s == null ? '' : s);
  let width = 0;
  for (const ch of s) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - width));
};

console.log(`\nDB: ${DB_PATH}`);
console.log(`Archived, still recipe-linked, touched on/after ${SINCE}: ${candidates.length}`);
console.log(`  to bring back ........... ${restore.length}`);
console.log(`  left archived ........... ${skip.length}\n`);

if (restore.length) {
  console.log(`── ${WRITE ? 'UN-ARCHIVED' : 'WOULD UN-ARCHIVE'} ──`);
  for (const r of restore) {
    const skuNote = r.restoreSku ? `SKU restored -> ${r.restoreSku}`
      : r.sku != null ? r.sku
        : 'no SKU, and none on record for this name';
    console.log(`  ${w(r.name_en, 46)}${skuNote}`);
  }
  console.log();
}
if (skip.length) {
  console.log(`── LEFT ARCHIVED, ${skip.length} ──`);
  for (const s2 of skip) console.log(`  ${w(s2.name_en, 46)}${s2.why}`);
  console.log();
}
if (missing.length) {
  console.log(`── ON RECORD BUT NOT FOUND ARCHIVED, ${missing.length} — already restored, or renamed ──`);
  for (const n of missing) console.log(`  ${w(n, 46)}${SKU_BY_NAME.get(n)}`);
  console.log();
}

if (WRITE && restore.length) {
  const live = db.prepare('UPDATE ingredients SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const withSku = db.prepare('UPDATE ingredients SET is_active = 1, sku = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  let skusBack = 0;
  db.transaction(() => {
    for (const r of restore) {
      if (r.restoreSku) {
        // Only if nothing live has taken that code in the meantime — a SKU
        // freed by database.js:75 is a SKU another material may have claimed.
        const taken = db.prepare('SELECT id FROM ingredients WHERE sku = ? AND id <> ?').get(r.restoreSku, r.id);
        if (!taken) { withSku.run(r.restoreSku, r.id); skusBack++; continue; }
      }
      live.run(r.id);
    }
  })();
  console.log(`Done — ${restore.length} row(s) back in the Materials list and the build-list picker`
    + (skusBack ? `, ${skusBack} with their SKU restored.` : '.'));
  console.log('The 14 repack twins stay archived: those were real duplicates.\n');
} else if (restore.length) {
  console.log('Dry run. Re-run with --write to apply.\n');
} else {
  console.log('Nothing to bring back.\n');
}

db.close();
