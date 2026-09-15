#!/usr/bin/env node
/**
 * "It let me choose both options." — is that the data or the code?
 *
 * ── THE SIGHTING ───────────────────────────────────────────────────────────
 * Reported by Ash 2026-09-15 on the Ramada Hotel QR menu, with a screenshot:
 * the product "Garlic dill sour cream" asks CHOOSE YOUR BREAD *, and BOTH
 * answers — "whole wheat rye" and "gluten free buckwheat" — are ticked at the
 * same time, with the button reading ¥33.00 (base plus the +¥3.00 delta).
 *
 * ── WHY THIS CANNOT BE READ OFF THE SCREENSHOT ─────────────────────────────
 * §120's picker renders a single-answer question and a multi-answer question
 * with IDENTICAL furniture: a column of full-width rows that flip to an ink
 * ground when ticked. There is no radio, no tick box, nothing that says which
 * kind of question this is. So a screenshot showing two ticked rows is
 * consistent with two different stories and distinguishes neither:
 *
 *   A. THE DATA. `retail_product_options.type` for that question is 'multi',
 *      the picker is doing exactly what it is told, and the fix is in the
 *      product editor — plus the picker should have made the kind of question
 *      legible so nobody had to guess.
 *
 *   B. THE CODE. The type is 'single' and the tick handler is failing to
 *      replace the selection, which would be a real bug in routes/shop-menu.js
 *      and would affect every single-answer question on every QR menu.
 *
 * A and B look the same on a phone. They are told apart by one column, and
 * this script prints it rather than a verdict.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * Every option group on every product that is actually LISTED on an active
 * shop menu: the shop, the product, the question in both languages, its type,
 * whether it is required, and its answers with their price deltas and default
 * flags. Then a count by type, and the subset that is 'multi' AND required —
 * the shape a "choose your bread" question would have if story A is right.
 *
 * NO CUSTOMER DATA. Products, questions, answers, types and prices only; no
 * orders, no names, no addresses are read.
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
const money = (n) => '¥' + (Number(n || 0) / 100).toFixed(2);

// The schema is read rather than assumed: a column this script names and the
// live database does not have is a schema difference, and guessing a value for
// it would be inventing the answer this script exists to avoid inventing.
const colsOf = (t) => {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch (e) { return []; }
};
const optCols = colsOf('retail_product_options');
const chCols = colsOf('retail_product_option_choices');
const shopCols = colsOf('shops');
if (!optCols.length) {
  console.error('FATAL: retail_product_options does not exist on this database.');
  process.exit(2);
}
console.log('retail_product_options columns: ' + optCols.join(', '));
console.log('retail_product_option_choices columns: ' + chCols.join(', '));

// ── 1 · every question on every product a QR menu actually lists ───────────
rule('1 · option groups on products listed by an ACTIVE shop menu');

const nameCol = shopCols.includes('display_name_en') ? 'sh.display_name_en' : 'NULL';
const codeCol = shopCols.includes('public_code') ? 'sh.public_code' : 'NULL';

const rows = db.prepare(`
  SELECT DISTINCT
         ${codeCol}                       AS shop_code,
         COALESCE(${nameCol}, rs.name_en) AS shop_name,
         p.id                             AS product_id,
         COALESCE(p.name_en, p.name_cn)   AS product,
         o.id                             AS option_id,
         o.question_en                    AS q_en,
         o.question_cn                    AS q_cn,
         o.type                           AS type,
         o.is_required                    AS req
    FROM shops sh
    JOIN retail_stores rs        ON rs.id = sh.location_id
    JOIN shop_listings sl        ON sl.shop_id = sh.id
    JOIN store_products p        ON p.id = sl.store_product_id
    JOIN retail_product_options o ON o.product_id = p.id
   WHERE sh.is_active = 1
   ORDER BY shop_name, product, o.sort_order, o.id
`).all();

if (!rows.length) {
  console.log('(no option groups on any listed product — nothing to read)');
} else {
  const choicesOf = db.prepare(`
    SELECT id, label_en, label_cn, price_delta,
           ${chCols.includes('is_default') ? 'is_default' : 'NULL AS is_default'},
           ${chCols.includes('stock_product_id') ? 'stock_product_id' : 'NULL AS stock_product_id'}
      FROM retail_product_option_choices
     WHERE option_id = ?
     ORDER BY sort_order, id
  `);
  let lastProduct = null;
  for (const r of rows) {
    const key = r.shop_name + ' / ' + r.product;
    if (key !== lastProduct) {
      console.log(`\n  ${r.shop_name} [${r.shop_code}] · ${r.product} (#${r.product_id})`);
      lastProduct = key;
    }
    const flag = r.type === 'multi' ? '  <-- MULTI: more than one answer can be ticked' : '';
    console.log(`    Q#${r.option_id} type=${r.type} required=${r.req ? 'yes' : 'no'}` +
                `  "${r.q_en || ''}" / "${r.q_cn || ''}"${flag}`);
    for (const c of choicesOf.all(r.option_id)) {
      const d = Number(c.price_delta) || 0;
      console.log(`        - "${c.label_en || ''}" / "${c.label_cn || ''}"` +
                  `${d ? '  ' + (d > 0 ? '+' : '') + money(d) : ''}` +
                  `${c.is_default ? '  [default]' : ''}` +
                  `${c.stock_product_id ? '  [stock #' + c.stock_product_id + ']' : ''}`);
    }
  }
}

// ── 2 · the count, across the whole catalogue ──────────────────────────────
rule('2 · every option group in the catalogue, by type');
for (const r of db.prepare(
  `SELECT COALESCE(type, '(null)') AS type, COUNT(*) AS n
     FROM retail_product_options GROUP BY type ORDER BY n DESC`
).all()) {
  console.log(`  ${String(r.type).padEnd(12)} ${r.n}`);
}

// ── 3 · the shape story A predicts ─────────────────────────────────────────
rule('3 · REQUIRED questions typed multi — a "pick one" that accepts several');
const suspects = db.prepare(`
  SELECT o.id, o.question_en, o.question_cn, o.type, o.product_id,
         COALESCE(p.name_en, p.name_cn) AS product,
         (SELECT COUNT(*) FROM retail_product_option_choices c WHERE c.option_id = o.id) AS n
    FROM retail_product_options o
    LEFT JOIN store_products p ON p.id = o.product_id
   WHERE o.type = 'multi' AND o.is_required = 1
   ORDER BY product, o.id
`).all();
if (!suspects.length) {
  console.log('  (none — no required question in the catalogue is typed multi)');
  console.log('  IF THE SCREENSHOT STILL SHOWS TWO TICKED ANSWERS, STORY B IS THE LIVE ONE');
  console.log('  and the bug is in the tick handler, not in the data.');
} else {
  for (const s of suspects) {
    console.log(`  Q#${s.id} on "${s.product}" (#${s.product_id}) — ${s.n} answers` +
                `  "${s.question_en || ''}" / "${s.question_cn || ''}"`);
  }
}

rule('');
console.log('read complete — nothing was written.');
