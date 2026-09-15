#!/usr/bin/env node
/**
 * "I can't see the description — only the picture, ingredients, allergens."
 *
 * ── THE SIGHTING ───────────────────────────────────────────────────────────
 * Reported by Ash 2026-09-15 on the Ramada Hotel QR menu, opening "Garlic Dill
 * Sour Cream Toast" (#370): the detail sheet shows the photo, the ingredient
 * chips and the allergen card, and no description.
 *
 * ── WHY THIS NEEDS READING RATHER THAN FIXING ──────────────────────────────
 * The sheet is DESIGNED not to show one. routes/shop-menu.js's listing query
 * carries a note beside `p.description_blocks` saying the page reads TWO block
 * types, ingredients and the allergen card, and is "deliberately NOT the
 * marketing paragraph, the claims, the usage tiles or the tagline: a person
 * standing at a counter is deciding whether they can eat it."
 *
 * So the report is consistent with two different states of the world, and
 * shipping a renderer without knowing which would be shipping a guess:
 *
 *   A. THE TEXT IS THERE AND THE SHEET IGNORES IT. The product carries a
 *      `hero_intro` block the office wrote, the mini app draws it, and the QR
 *      sheet drops it on the floor. Then the fix is a renderer, and the
 *      question for Ash is only whether the recorded decision is being
 *      reversed on purpose.
 *
 *   B. THE TEXT IS NOT THERE. The product has no paragraph block at all, and a
 *      renderer would ship a feature that displays nothing on the product that
 *      prompted it. Then the fix is in the product editor, not in this repo.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * For every product listed on an active shop menu: which block types it
 * carries, each marked SHOWN or ignored by the QR detail sheet as it stands,
 * plus the length and opening words of any paragraph-shaped block. Then a
 * catalogue-wide count of how many listed products carry a paragraph the sheet
 * is currently dropping — which is the number that says whether a renderer is
 * worth building at all.
 *
 * NO CUSTOMER DATA. Products and the office's own product copy only; no
 * orders, names or addresses are read.
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);

const rule = (t) => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

// The two the QR detail sheet understands today, per lib/product-blocks-read.js.
const SHOWN = new Set(['ingredients_chips', 'ingredients_line', 'allergen_card']);
// The block types that carry prose a customer would call "the description".
const PROSE = new Set(['hero_intro', 'why', 'notes_callout', 'pull_quote', 'storage_box', 'how_to_use']);

const blocksOf = (raw) => {
  let b = raw;
  if (typeof b === 'string') {
    if (!b.trim()) return [];
    try { b = JSON.parse(b); } catch (e) { return ['(UNPARSEABLE JSON)']; }
  }
  return Array.isArray(b) ? b : [];
};

const firstWords = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

const rows = db.prepare(`
  SELECT DISTINCT
         sh.public_code                  AS shop_code,
         COALESCE(sh.display_name_en, rs.name_en) AS shop_name,
         p.id                            AS product_id,
         COALESCE(p.name_en, p.name_cn)  AS product,
         p.description_blocks            AS blocks,
         p.nutrition                     AS nutrition
    FROM shops sh
    JOIN retail_stores rs   ON rs.id = sh.location_id
    JOIN shop_listings sl   ON sl.shop_id = sh.id
    JOIN store_products p   ON p.id = sl.store_product_id
   WHERE sh.is_active = 1
   ORDER BY shop_name, product
`).all();

rule('1 · every listed product, and what the detail sheet does with its blocks');
if (!rows.length) console.log('(no listed products)');

let withProse = 0, withoutAnyBlocks = 0;
const proseProducts = [];

for (const r of rows) {
  const bs = blocksOf(r.blocks);
  const types = bs.map(b => (b && b.type) || String(b));
  const prose = bs.filter(b => b && PROSE.has(b.type));
  if (!bs.length) withoutAnyBlocks++;
  if (prose.length) { withProse++; proseProducts.push(r.product_id + ' · ' + r.product); }

  console.log(`\n  ${r.shop_name} [${r.shop_code}] · ${r.product} (#${r.product_id})`);
  if (!types.length) {
    console.log('    (no description_blocks at all)');
  } else {
    for (const t of types) {
      const mark = SHOWN.has(t) ? 'SHOWN  ' : (PROSE.has(t) ? 'ignored' : 'ignored');
      console.log(`    [${mark}] ${t}`);
    }
  }
  console.log(`    nutrition column: ${r.nutrition && String(r.nutrition).trim() ? 'present' : 'empty'}`);

  // The prose itself — the office's own copy, so it can be read rather than
  // guessed at. Length matters as much as content: a block that exists and is
  // empty is a third state, and it looks exactly like B from the phone.
  for (const b of prose) {
    const en = (b.body_en || b.text_en || b.body || '') + '';
    const cn = (b.body_cn || b.text_cn || '') + '';
    const ken = (b.kicker_en || '') + '', kcn = (b.kicker_cn || '') + '';
    console.log(`      ${b.type}: en=${en.length} chars, cn=${cn.length} chars` +
                `${ken || kcn ? `, kicker en="${ken}" cn="${kcn}"` : ''}`);
    if (en) console.log(`        EN: "${firstWords(en, 160)}"`);
    if (cn) console.log(`        CN: "${firstWords(cn, 160)}"`);
    if (!en && !cn) console.log('        (the block exists and carries NO text in either language)');
  }
}

rule('2 · the number that decides whether a renderer is worth building');
console.log(`  listed products:                       ${rows.length}`);
console.log(`  ...carrying a prose block the sheet drops: ${withProse}`);
console.log(`  ...carrying no description_blocks at all:  ${withoutAnyBlocks}`);
if (proseProducts.length) {
  console.log('\n  the ones with prose being dropped:');
  for (const p of proseProducts) console.log('    - ' + p);
} else {
  console.log('\n  NO listed product carries a prose block. A renderer would display');
  console.log('  nothing anywhere, and the fix is in the product editor.');
}

rule('3 · the catalogue, by block type, across ALL products');
const counts = new Map();
for (const r of db.prepare('SELECT description_blocks AS b FROM store_products').all()) {
  for (const blk of blocksOf(r.b)) {
    const t = (blk && blk.type) || String(blk);
    counts.set(t, (counts.get(t) || 0) + 1);
  }
}
for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${SHOWN.has(t) ? 'SHOWN  ' : 'ignored'}  ${String(t).padEnd(20)} ${n}`);
}

rule('');
console.log('read complete — nothing was written.');
