#!/usr/bin/env node
/**
 * Copy the per-product Options (customer "choices") from the Nourish Beans soup
 * (SKU 1-400) onto the other soups/curry, and fill in Chinese for the choices.
 *
 * Why: the operator authored two option groups on 1-400 — a Yes/No pick and an
 * "Add extras?" pick-any (Brown Rice +¥8, Mix colored Quinoa +¥10, 3 Slice of
 * whole wheat +¥8, Whole wheat pita bread +¥10) — and wants the SAME options on
 * the sibling soups, with the missing 中文 added. Options live in
 * retail_product_options + retail_product_option_choices, keyed by store-product
 * id, and never touch stock (see routes/retail.js saveProductOptions).
 *
 * What it does, per the matching store-product:
 *   1. Reads 1-400's option groups + choices VERBATIM (every column copied, so
 *      price_delta / is_default / sort_order / any stock link transfer exactly).
 *   2. Fills label_cn / question_cn where blank, from the approved map below.
 *   3. Replaces (delete-then-insert, one transaction) the options on each target
 *      SKU — and on 1-400 itself, so the source also gets the Chinese filled in.
 *
 * Idempotent: re-running replaces the same options with the same content.
 *
 * Usage:
 *   node scripts/copy_soup_options.js --dry-run
 *   node scripts/copy_soup_options.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

const SOURCE_SKU = '1-400';                                  // Nourish Beans & Veggie soup
const TARGET_SKUS = ['1-460', '1-360', '1-370', '1-380'];    // Red Lentils / Herbal / Pumpkin / Sweet Potato Cauliflower Curry
const ALL_SKUS = [SOURCE_SKU, ...TARGET_SKUS];               // source included so its own 中文 gets filled

// Approved Chinese, keyed by the English label/question (case-insensitive, trimmed).
// Only fills a *blank* cn — never overwrites an existing translation.
const CHOICE_CN = {
  'brown rice': '糙米',
  'mix colored quinoa': '三色藜麦',
  '3 slice of whole wheat': '全麦面包(3片)',
  'whole wheat pita bread': '全麦皮塔饼',
  'yes': '要',
  'no': '不要',
};
const QUESTION_CN = {
  'add extras?': '加点配料?',
};

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

for (const t of ['retail_product_options', 'retail_product_option_choices', 'store_products']) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) {
    console.error(`Table ${t} missing — run this on the prod server's data/roots.db, not a stale local copy.`);
    process.exit(1);
  }
}

const skuToId = (sku) => db.prepare('SELECT id, name_en FROM store_products WHERE sku = ?').get(sku);

const src = skuToId(SOURCE_SKU);
if (!src) { console.error(`Source SKU ${SOURCE_SKU} not found in store_products.`); process.exit(1); }

// Column lists, discovered dynamically so we copy every column except the keys.
const optCols = db.prepare('PRAGMA table_info(retail_product_options)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'product_id');
const choiceCols = db.prepare('PRAGMA table_info(retail_product_option_choices)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'option_id');

// Read the source template into memory (plain objects, decoupled from row ids).
const srcOptions = db.prepare(
  'SELECT * FROM retail_product_options WHERE product_id = ? ORDER BY sort_order ASC, id ASC'
).all(src.id);
if (!srcOptions.length) {
  console.error(`Source ${SOURCE_SKU} has no options to copy — nothing to do.`);
  process.exit(1);
}
const template = srcOptions.map(o => {
  const choices = db.prepare(
    'SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(o.id);
  // Fill blank CN from the approved maps.
  const qcn = (o.question_cn && String(o.question_cn).trim())
    || QUESTION_CN[String(o.question_en || '').trim().toLowerCase()] || null;
  return {
    opt: { ...o, question_cn: qcn },
    choices: choices.map(c => ({
      ...c,
      label_cn: (c.label_cn && String(c.label_cn).trim())
        || CHOICE_CN[String(c.label_en || '').trim().toLowerCase()] || null,
    })),
  };
});

console.log(`Source ${SOURCE_SKU} "${src.name_en}": ${template.length} option group(s)`);
template.forEach(t => {
  console.log(`  • ${t.opt.question_en} [${t.opt.type}${t.opt.is_required ? ', required' : ''}] → ${t.opt.question_cn || '—'}`);
  t.choices.forEach(c => console.log(
    `      - ${c.label_en} ${c.price_delta ? `(+¥${c.price_delta})` : ''} → ${c.label_cn || '—'}`
  ));
});

const insOpt = db.prepare(
  `INSERT INTO retail_product_options (product_id, ${optCols.join(', ')})
   VALUES (?, ${optCols.map(() => '?').join(', ')})`
);
const insChoice = db.prepare(
  `INSERT INTO retail_product_option_choices (option_id, ${choiceCols.join(', ')})
   VALUES (?, ${choiceCols.map(() => '?').join(', ')})`
);
const delChoices = db.prepare(
  `DELETE FROM retail_product_option_choices
    WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`
);
const delOpts = db.prepare('DELETE FROM retail_product_options WHERE product_id = ?');

const applyTo = db.transaction((productId) => {
  delChoices.run(productId);
  delOpts.run(productId);
  template.forEach((t, oi) => {
    const optVals = optCols.map(col => col === 'sort_order' ? oi : t.opt[col]);
    const optId = insOpt.run(productId, ...optVals).lastInsertRowid;
    t.choices.forEach((c, ci) => {
      const cVals = choiceCols.map(col => col === 'sort_order' ? ci : c[col]);
      insChoice.run(optId, ...cVals);
    });
  });
});

let applied = 0, missing = [];
for (const sku of ALL_SKUS) {
  const row = skuToId(sku);
  if (!row) { missing.push(sku); continue; }
  const tag = sku === SOURCE_SKU ? ' (source — fills its 中文)' : '';
  if (DRY) {
    console.log(`would apply → ${sku} "${row.name_en}"${tag}`);
  } else {
    applyTo(row.id);
    console.log(`✅ applied → ${sku} "${row.name_en}"${tag}`);
  }
  applied++;
}

if (missing.length) console.log(`\n⚠️  SKUs not found (skipped): ${missing.join(', ')}`);
console.log(DRY
  ? `\n🔍 DRY-RUN — no rows written. ${applied} product(s) would be updated.`
  : `\n✅ Done. ${applied} product(s) updated.`);
