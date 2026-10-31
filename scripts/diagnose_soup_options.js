#!/usr/bin/env node
/**
 * diagnose_soup_options.js — which soups are on the catalogue, and what
 * customer options (the "Add extras?" sheet) does each one carry today?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-23: "i want all soups to have the same options as this soup",
 * with a screenshot of Nourish Beans & Veggie Soup (SKU 1-400) showing five
 * paid extras: Brown Rice +¥8, Mix colored Quinoa +¥10, 3 Slice of whole wheat
 * bread +¥8, Whole wheat pita bread +¥10, Wild harrisa (spicy) +¥4.
 *
 * The same copy was made once before (scripts/copy_soup_options.js, then
 * scripts/add_harissa_extra.js), for a fixed list of four SKUs. Soups added
 * since then were never on that list, and a soup edited since may have drifted.
 * This reads what is live before anything is written, so the repair is aimed at
 * the soups that actually exist rather than the list from last time.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. The database is opened
 * `readonly: true` and a write is attempted and REQUIRED to fail before any
 * query runs.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_soup_options.js
 *   dispatched against the branch that carries this file.
 */
'use strict';

const path = require('path');
const Database = require('@libsql/client');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

const out = (s = '') => console.log(s);
const rule = (t) => { out(); out('='.repeat(78)); out(t); out('='.repeat(78)); };

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[soups] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _soups_write_probe (x INTEGER)').run();
  console.error('[soups] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[soups] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

const cols = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); }
                      catch { return []; } };
const spCols = cols('store_products');
if (!spCols.length) { console.error('[soups] store_products missing'); process.exit(1); }
const pick = (...names) => names.filter(n => spCols.includes(n));

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

const SOURCE_SKU = '1-400';
const KNOWN = ['1-400', '1-460', '1-360', '1-370', '1-380'];   // last copy's list
const NAME_RE = /soup|stew|curry|汤|羹|咖喱|炖/i;

const extra = pick('category', 'category_cn', 'status', 'is_active', 'retail_visible',
                   'retail_price', 'price', 'deleted_at');
const rows = db.prepare(
  `SELECT id, sku, name_en, name_cn${extra.length ? ', ' + extra.join(', ') : ''}
     FROM store_products ORDER BY sku`).all();

// Anything that looks like a soup by name or category, the known list, and any
// product that already carries an "Add extras?" group.
const withExtras = new Set(db.prepare(
  `SELECT DISTINCT product_id FROM retail_product_options
    WHERE LOWER(TRIM(question_en)) = 'add extras?'`).all().map(r => r.product_id));
const hits = rows.filter(r =>
  KNOWN.includes(r.sku)
  || NAME_RE.test(`${r.name_en || ''} ${r.name_cn || ''} ${r.category || ''} ${r.category_cn || ''}`)
  || withExtras.has(r.id));

const optsOf = db.prepare(
  `SELECT id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order
     FROM retail_product_options WHERE product_id = ? ORDER BY sort_order, id`);
const choicesOf = db.prepare(
  `SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order, id`);

const describe = (r) => {
  const meta = extra.map(c => `${c}=${JSON.stringify(r[c])}`).join('  ');
  out();
  out(`#${r.id}  ${r.sku || '(no sku)'}  ${r.name_en || ''} / ${r.name_cn || ''}`);
  out(`    ${meta}`);
  const opts = optsOf.all(r.id);
  if (!opts.length) { out('    (no options)'); return; }
  for (const o of opts) {
    out(`    ? ${JSON.stringify(o.question_en)} / ${JSON.stringify(o.question_cn)}  `
      + `type=${o.type} req=${o.is_required} min=${o.min_choices} max=${o.max_choices} sort=${o.sort_order}`);
    for (const c of choicesOf.all(o.id)) {
      out(`        - ${JSON.stringify(c.label_en)} / ${JSON.stringify(c.label_cn)}  `
        + `+${c.price_delta}  default=${c.is_default}  sort=${c.sort_order}`
        + (c.stock_product_id != null ? `  stock_product_id=${c.stock_product_id}` : ''));
    }
  }
};

rule(`1 . THE SOURCE — ${SOURCE_SKU}`);
const src = rows.find(r => r.sku === SOURCE_SKU);
if (!src) out(`  no store_products row with sku ${SOURCE_SKU}`);
else describe(src);

rule(`2 . EVERY CANDIDATE SOUP (${hits.length})`);
out('  matched by: the last copy\'s SKU list, a soup-like name/category, or an existing "Add extras?" group');
for (const r of hits) if (r !== src) describe(r);

rule('3 . CATEGORY VALUES ON THE CATALOGUE (to spot a soup category the name test missed)');
if (spCols.includes('category')) {
  for (const c of db.prepare(
    `SELECT category, COUNT(*) n FROM store_products GROUP BY category ORDER BY category`).all()) {
    out(`  ${JSON.stringify(c.category)}  ${c.n}`);
  }
} else out('  store_products has no category column');
