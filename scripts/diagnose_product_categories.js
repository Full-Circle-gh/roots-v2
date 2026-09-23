/* Every store-product category and subcategory, with how many active products
 * each holds, how many already carry a filled allergen card, and a few names.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * §241's trace line has to reach every FOOD product, including the ones whose
 * office never wrote an allergen card (scripts/diagnose_allergen_card_coverage.js
 * found 109 active). Ash, 2026-09-23, ruled it by category — food gets the card,
 * home care, beauty and accessories do not; bought-in powders count as food
 * ("packed in our facility"). This lists the categories so Ash can confirm the
 * split against real names rather than guessed ones.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products: name_en, category, subcategory, is_active, description_blocks
 * NO CUSTOMER DATA of any kind. It changes nothing.
 *
 *   node scripts/diagnose_product_categories.js
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

const cols = new Set(db.pragma('table_info(store_products)').map(c => c.name));
const col = (c, d) => (cols.has(c) ? c : `${d} AS ${c}`);
const rows = db.prepare(`SELECT ${col('name_en', "''")}, ${col('category', "''")},
  ${col('subcategory', "''")}, ${col('is_active', 1)}, description_blocks FROM store_products`).all();

const filled = (raw) => {
  let b = raw;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return false; } }
  return Array.isArray(b) && b.some(x => x && x.type === 'allergen_card' &&
    ['contains_en', 'contains_cn', 'may_contain_en', 'may_contain_cn']
      .some(k => String(x[k] == null ? '' : x[k]).trim()));
};

const g = new Map();
for (const r of rows) {
  const k = `${r.category || '(none)'}  ›  ${r.subcategory || '-'}`;
  if (!g.has(k)) g.set(k, { active: 0, inactive: 0, card: 0, names: [] });
  const e = g.get(k);
  if (r.is_active) {
    e.active++;
    if (filled(r.description_blocks)) e.card++;
    if (e.names.length < 5) e.names.push(r.name_en);
  } else e.inactive++;
}
console.log('active · with card · inactive   category › subcategory');
for (const [k, e] of [...g.entries()].sort()) {
  console.log(`${String(e.active).padStart(6)} ${String(e.card).padStart(11)} ${String(e.inactive).padStart(10)}   ${k}`);
  if (e.names.length) console.log('                                 e.g. ' + e.names.join(' | '));
}
