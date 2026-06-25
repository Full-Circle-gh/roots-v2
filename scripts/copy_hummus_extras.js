#!/usr/bin/env node
/**
 * Copy the "Add extras?" option group from Hummus Asli – The Original onto a set
 * of other dips/salads so they offer the SAME extras picker (Whole-Wheat Crisp
 * Crackers, GF Buckwheat Bread, Whole-Wheat Pita, Rye & Whole Wheat Bread,
 * Harissa Chilli Paste, Pickled Onions …).
 *
 * Why: the operator authored the extras group ONCE on the hummus and wants it
 * mirrored verbatim (same labels, prices, CN, sort order) onto:
 *   Zhoug, Turkish Tomato Salad, Zaatar Labneh, Chickpeas Salad, Guacamole.
 *
 * Options live in retail_product_options + retail_product_option_choices, keyed
 * by store-product id, and never touch stock (see routes/retail.js
 * saveProductOptions). Same mechanism as scripts/copy_soup_options.js.
 *
 * Matching is BY NAME (case-insensitive substring on name_en, with name_cn as a
 * fallback) because SKUs aren't known locally. Dry-run prints every match so you
 * can eyeball it before writing. If a name is ambiguous (matches >1 product) it
 * is reported and SKIPPED — narrow it via the SKU override map below.
 *
 * Behaviour, per matched target product:
 *   1. Reads the source's "Add extras?" group VERBATIM (every column copied, so
 *      price_delta / is_default / sort_order / stock link transfer exactly).
 *   2. Removes any existing option group on the target whose question matches
 *      "add extras" (so re-runs don't duplicate it), leaving other groups alone.
 *   3. Inserts the copied group + choices.
 *
 * Idempotent: re-running replaces only the "Add extras?" group on each target.
 *
 * Usage:
 *   node scripts/copy_hummus_extras.js --dry-run
 *   node scripts/copy_hummus_extras.js
 *
 * Run on the prod server's /root/roots-v2/data/roots.db (the live retail DB),
 * not a stale local copy.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
// Absolute prod path so it runs from any cwd. Override with ROOTS_DB if needed.
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

// Source product: Hummus Asli – The Original.
const SOURCE_NAME = 'hummus asli';
// Which option group on the source to copy (matched on question_en, case-insensitive substring).
const GROUP_MATCH = 'add extras';

// Targets, matched by name (case-insensitive substring on name_en, then name_cn).
const TARGET_NAMES = [
  'zhoug',
  'turkish tomato salad',
  'zaatar labneh',
  'chickpeas salad',
  'guacamole',
];

// Optional: pin a fuzzy/ambiguous name straight to a SKU to skip name matching.
//   e.g. 'guacamole': '1-123'
const SKU_OVERRIDES = { 'chickpeas salad': '1-50', 'zaatar labneh': '1-40' };

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

for (const t of ['retail_product_options', 'retail_product_option_choices', 'store_products']) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) {
    console.error(`Table ${t} missing — run this on the prod server's data/roots.db, not a stale local copy.`);
    process.exit(1);
  }
}

// --- find a single product by SKU or by name (substring on name_en, then name_cn) ---
const bySku = (sku) => db.prepare('SELECT id, sku, name_en, name_cn FROM store_products WHERE sku = ?').get(sku);
function findByName(name) {
  const like = `%${name.toLowerCase()}%`;
  // sku IS NOT NULL → exclude variant children (they share the parent's name).
  let rows = db.prepare(
    "SELECT id, sku, name_en, name_cn FROM store_products WHERE sku IS NOT NULL AND lower(name_en) LIKE ? ORDER BY id"
  ).all(like);
  if (!rows.length) {
    rows = db.prepare(
      "SELECT id, sku, name_en, name_cn FROM store_products WHERE sku IS NOT NULL AND name_cn LIKE ? ORDER BY id"
    ).all(like);
  }
  return rows;
}

// --- locate the source group ---
const srcMatches = findByName(SOURCE_NAME);
if (!srcMatches.length) { console.error(`Source "${SOURCE_NAME}" not found in store_products.`); process.exit(1); }
if (srcMatches.length > 1) {
  console.error(`Source "${SOURCE_NAME}" is ambiguous — matched ${srcMatches.length}:`);
  srcMatches.forEach(r => console.error(`   ${r.sku}  ${r.name_en}`));
  process.exit(1);
}
const src = srcMatches[0];

const optCols = db.prepare('PRAGMA table_info(retail_product_options)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'product_id');
const choiceCols = db.prepare('PRAGMA table_info(retail_product_option_choices)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'option_id');

const srcGroup = db.prepare(
  "SELECT * FROM retail_product_options WHERE product_id = ? AND lower(question_en) LIKE ? ORDER BY id"
).get(src.id, `%${GROUP_MATCH}%`);
if (!srcGroup) {
  console.error(`Source "${src.name_en}" (${src.sku}) has no option group matching "${GROUP_MATCH}".`);
  process.exit(1);
}
const srcChoices = db.prepare(
  'SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order ASC, id ASC'
).all(srcGroup.id);

console.log(`Source ${src.sku} "${src.name_en}" → group "${srcGroup.question_en}" [${srcGroup.type}${srcGroup.is_required ? ', required' : ''}] ${srcGroup.question_cn ? `(${srcGroup.question_cn})` : ''}`);
srcChoices.forEach(c => console.log(
  `   - ${c.label_en} ${c.price_delta ? `(+¥${c.price_delta})` : ''} ${c.label_cn ? `→ ${c.label_cn}` : ''}`
));
console.log('');

// --- prepared statements ---
const insOpt = db.prepare(
  `INSERT INTO retail_product_options (product_id, ${optCols.join(', ')})
   VALUES (?, ${optCols.map(() => '?').join(', ')})`
);
const insChoice = db.prepare(
  `INSERT INTO retail_product_option_choices (option_id, ${choiceCols.join(', ')})
   VALUES (?, ${choiceCols.map(() => '?').join(', ')})`
);
const findExistingGroups = db.prepare(
  "SELECT id FROM retail_product_options WHERE product_id = ? AND lower(question_en) LIKE ?"
);
const delChoicesForOpt = db.prepare('DELETE FROM retail_product_option_choices WHERE option_id = ?');
const delOpt = db.prepare('DELETE FROM retail_product_options WHERE id = ?');
const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM retail_product_options WHERE product_id = ?');

const applyTo = db.transaction((productId) => {
  // Remove any pre-existing "Add extras?" group on this product (idempotent re-run).
  for (const g of findExistingGroups.all(productId, `%${GROUP_MATCH}%`)) {
    delChoicesForOpt.run(g.id);
    delOpt.run(g.id);
  }
  const sort = maxSort.get(productId).m + 1;
  const optVals = optCols.map(col => col === 'sort_order' ? sort : srcGroup[col]);
  const optId = insOpt.run(productId, ...optVals).lastInsertRowid;
  srcChoices.forEach((c, ci) => {
    const cVals = choiceCols.map(col => col === 'sort_order' ? ci : c[col]);
    insChoice.run(optId, ...cVals);
  });
});

let applied = 0;
const problems = [];
for (const name of TARGET_NAMES) {
  let row;
  if (SKU_OVERRIDES[name]) {
    row = bySku(SKU_OVERRIDES[name]);
    if (!row) { problems.push(`"${name}" → override SKU ${SKU_OVERRIDES[name]} not found`); continue; }
  } else {
    const matches = findByName(name);
    if (!matches.length) { problems.push(`"${name}" → no product matched`); continue; }
    if (matches.length > 1) {
      problems.push(`"${name}" → AMBIGUOUS (${matches.length}): ${matches.map(m => `${m.sku} ${m.name_en}`).join(' | ')} — pin via SKU_OVERRIDES, SKIPPED`);
      continue;
    }
    row = matches[0];
  }
  if (DRY) {
    console.log(`would copy → ${row.sku} "${row.name_en}"`);
  } else {
    applyTo(row.id);
    console.log(`✅ copied → ${row.sku} "${row.name_en}"`);
  }
  applied++;
}

if (problems.length) {
  console.log('\n⚠️  Needs attention:');
  problems.forEach(p => console.log(`   - ${p}`));
}
console.log(DRY
  ? `\n🔍 DRY-RUN — no rows written. ${applied} product(s) would get the extras picker.`
  : `\n✅ Done. ${applied} product(s) updated.`);
