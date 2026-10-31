#!/usr/bin/env node
/**
 * diagnose_dip_options_and_unlinked_extras.js — two read-only questions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-23, after the soups (scripts/oneoff_soup_options_from_red_lentil.js):
 *   "we need to do the same for the dips. this is the template for the dips"
 *     — a screenshot of Za'atar Labneh (SKU 1-40): six paid extras, Whole-Wheat
 *       Crisp Crackers +¥27, GF Buckwheat Bread +¥15, Whole-Wheat Pita +¥10,
 *       Rye & Whole Wheat Bread +¥12, Harissa Chilli Paste +¥6, Pickled Onions +¥8.
 *   "all extras should go down from the stock once ordered"
 *
 * So, before anything is written:
 *   1. Which products are dips, and what does each carry today? scripts/
 *      diagnose_soup_options.js showed the template's extras on several
 *      "Fresh & Deli" products, but that category also holds salads, and a
 *      "Spreads & Dips" category exists whose products it never printed.
 *   2. Every paid extra on the catalogue that is NOT linked to a stock product,
 *      so nothing is deducted when it is ordered. Unpaid answers (Yes/No,
 *      "choose your bread") are listed separately: they are choices about the
 *      product, not extra things taken off a shelf, and linking them is a
 *      different decision.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Opened `readonly: true`, and a write
 * is attempted and REQUIRED to fail before any query runs.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml with
 *     script = scripts/diagnose_dip_options_and_unlinked_extras.js
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
  console.error(`[dips] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _dips_write_probe (x INTEGER)').run();
  console.error('[dips] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[dips] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

const TEMPLATE_SKU = '1-40';
const DIP_RE = /dip|hummus|labneh|zhoug|guacamole|pesto|baba|muhammara|tzatziki|spread|酱|泥/i;
const CAT_RE = /spreads|dips|fresh/i;

const products = db.prepare(
  `SELECT id, sku, name_en, name_cn, category, status, is_active
     FROM store_products ORDER BY category, sku`).all();
const byId = new Map(products.map(p => [p.id, p]));

const optsOf = db.prepare(
  `SELECT id, question_en, question_cn, type, is_required, min_choices, max_choices
     FROM retail_product_options WHERE product_id = ? ORDER BY sort_order, id`);
const choicesOf = db.prepare(
  `SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order, id`);
const stockName = (id) => {
  if (id == null) return '(no stock link)';
  const p = byId.get(Number(id));
  return `stock #${id}${p ? ' ' + JSON.stringify(p.name_en) : ' (not a store product!)'}`;
};

const describe = (p) => {
  out();
  out(`#${p.id}  ${p.sku || '(no sku)'}  ${p.name_en || ''} / ${p.name_cn || ''}`);
  out(`    category=${JSON.stringify(p.category)}  status=${JSON.stringify(p.status)}  is_active=${p.is_active}`);
  const opts = optsOf.all(p.id);
  if (!opts.length) { out('    (no options)'); return; }
  for (const o of opts) {
    out(`    ? ${JSON.stringify(o.question_en)} / ${JSON.stringify(o.question_cn)}  `
      + `type=${o.type} req=${o.is_required} min=${o.min_choices} max=${o.max_choices}`);
    for (const c of choicesOf.all(o.id)) {
      out(`        - ${JSON.stringify(c.label_en)} / ${JSON.stringify(c.label_cn)}  +${c.price_delta}  ${stockName(c.stock_product_id)}`);
    }
  }
};

rule(`1 . THE TEMPLATE — ${TEMPLATE_SKU}`);
const tpl = products.find(p => p.sku === TEMPLATE_SKU);
if (!tpl) out(`  no store_products row with sku ${TEMPLATE_SKU}`); else describe(tpl);

rule('2 . EVERY CANDIDATE DIP');
out('  matched by: category Spreads/Dips/Fresh, or a dip-like name. Salads will show up here');
out('  on purpose — the category mixes them, and which is a dip is Ash\'s call.');
for (const p of products) {
  if (p === tpl) continue;
  if (p.category === 'Restock- only，internal') continue;
  if (CAT_RE.test(p.category || '') || DIP_RE.test(`${p.name_en || ''}`)) describe(p);
}

rule('3 . EXTRAS THAT TAKE NOTHING OFF STOCK — whole catalogue');
const rows = db.prepare(`
  SELECT o.product_id, o.question_en, c.label_en, c.label_cn, c.price_delta, c.stock_product_id
    FROM retail_product_option_choices c
    JOIN retail_product_options o ON o.id = c.option_id
   ORDER BY o.product_id, o.sort_order, c.sort_order`).all();
const paid = rows.filter(r => r.stock_product_id == null && Number(r.price_delta) > 0);
const free = rows.filter(r => r.stock_product_id == null && !(Number(r.price_delta) > 0));
const line = (r) => {
  const p = byId.get(r.product_id) || {};
  return `  ${String(p.sku || '#' + r.product_id).padEnd(12)} ${String(p.name_en || '').slice(0, 34).padEnd(34)} `
    + `active=${p.is_active}  ${JSON.stringify(r.question_en)} -> ${JSON.stringify(r.label_en)} +${r.price_delta}`;
};
out(`\n  PAID and unlinked (${paid.length}) — these are what "all extras go down from stock" is about:`);
paid.forEach(r => out(line(r)));
out(`\n  FREE and unlinked (${free.length}) — answers about the product itself; listed, not proposed:`);
free.forEach(r => out(line(r)));

rule('4 . STOCK PRODUCTS ALREADY USED BY LINKED EXTRAS (to pick links from)');
for (const r of db.prepare(`
  SELECT c.stock_product_id AS id, COUNT(*) n, GROUP_CONCAT(DISTINCT c.label_en) labels
    FROM retail_product_option_choices c
   WHERE c.stock_product_id IS NOT NULL
   GROUP BY c.stock_product_id ORDER BY c.stock_product_id`).all()) {
  const p = byId.get(Number(r.id)) || {};
  out(`  #${r.id}  ${p.sku || ''}  ${JSON.stringify(p.name_en || '?')}  used ${r.n}x as: ${r.labels}`);
}
