#!/usr/bin/env node
/**
 * The exact live state of the bread question, and the Chinese already in use.
 *
 * ── WHY THIS RUNS BEFORE THE REPAIR ────────────────────────────────────────
 * Two faults on option group #1346, both found while fixing something else and
 * both confirmed by Ash to fix:
 *
 *   A. It is typed `multi` while asking "Choose your bread", so a customer can
 *      put two breads under one toast and is charged for one of them.
 *   B. Its Chinese question reads 加点配料? — "Add extras?" — copied from the
 *      Apple Pie Overnight Oats question. A Chinese customer is asked a
 *      different question from the English one, on a live menu.
 *
 * Its two answers also carry no Chinese label at all, so 中文 falls back to the
 * English and a Chinese customer reads "whole wheat rye" in Latin script.
 *
 * ── WHAT DECIDES THE CHINESE, AND WHY IT IS READ RATHER THAN WRITTEN ───────
 * CLAUDE.md's amendment of 2026-09-06 delegates the Chinese to the session and
 * fixes the order to work in: copy a live pair, then lift from the source, then
 * compose — and anything composed must be declared in
 * docs/tacet-delivery-vocabulary.md in the same commit, with the candidates it
 * beat. That order is only followable if the live pairs are actually LOOKED at,
 * so this prints them.
 *
 * The repo already answers part of it: public/shop.html carries
 * {key:'gluten', en:'GLUTEN FREE', cn:'无麸质'} as a customer-facing filter
 * chip, and 全麦 (whole wheat) and 荞麦 (buckwheat) appear in real product names
 * and ingredient lists. 黑麦 (rye) appears ONLY in this repo's own test
 * fixtures, which is not a source — a string invented in a test is still
 * invented. This reads the live catalogue for it, and for how this tenant
 * writes "bread".
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * 1. Option #1346 exactly as it stands, with its choices, so the repair has a
 *    before to be checked against and so nothing is assumed about its shape.
 * 2. Every OTHER option group on the catalogue whose question is about a
 *    choice of bread or base, with both languages — the best possible source,
 *    because it is this operator answering this question already.
 * 3. Live English/Chinese product-name pairs containing bread, rye, wheat or
 *    buckwheat, so each word can be lifted rather than composed.
 *
 * NO CUSTOMER DATA. Products, questions and answers only.
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
const q = (v) => JSON.stringify(v == null ? null : String(v));

// ── 1 · the group being repaired, exactly as it stands ─────────────────────
rule('1 · option group #1346 as it stands');
const g = db.prepare(`
  SELECT o.*, COALESCE(p.name_en, p.name_cn) AS product
    FROM retail_product_options o
    LEFT JOIN store_products p ON p.id = o.product_id
   WHERE o.id = 1346
`).get();
if (!g) {
  console.log('  #1346 DOES NOT EXIST. The repair must not run.');
} else {
  for (const k of Object.keys(g)) console.log(`  ${k.padEnd(16)} ${q(g[k])}`);
  console.log('  choices:');
  for (const c of db.prepare(
    `SELECT id, label_en, label_cn, price_delta, is_default, sort_order, stock_product_id
       FROM retail_product_option_choices WHERE option_id = 1346 ORDER BY sort_order, id`
  ).all()) {
    console.log(`    #${c.id} en=${q(c.label_en)} cn=${q(c.label_cn)} ` +
                `delta=${c.price_delta} default=${c.is_default} sort=${c.sort_order}`);
  }
}

// ── 2 · has this operator already asked this question somewhere? ───────────
rule('2 · every option group that asks about a bread or a base — the best source');
const breadish = db.prepare(`
  SELECT o.id, o.product_id, o.question_en, o.question_cn, o.type, o.is_required,
         COALESCE(p.name_en, p.name_cn) AS product
    FROM retail_product_options o
    LEFT JOIN store_products p ON p.id = o.product_id
   WHERE o.question_en LIKE '%bread%' OR o.question_cn LIKE '%面包%'
      OR o.question_en LIKE '%base%'  OR o.question_en LIKE '%toast%'
   ORDER BY o.id
`).all();
if (!breadish.length) {
  console.log('  (none — this question is asked nowhere else in the catalogue)');
} else {
  for (const b of breadish) {
    console.log(`  Q#${b.id} on "${b.product}" type=${b.type} required=${b.is_required}`);
    console.log(`     en=${q(b.question_en)}  cn=${q(b.question_cn)}`);
    for (const c of db.prepare(
      `SELECT label_en, label_cn FROM retail_product_option_choices
        WHERE option_id = ? ORDER BY sort_order, id`).all(b.id)) {
      console.log(`       - en=${q(c.label_en)} cn=${q(c.label_cn)}`);
    }
  }
}

// ── 3 · the words themselves, as this tenant already writes them ───────────
rule('3 · live product names carrying bread / rye / wheat / buckwheat');
const words = [
  ['bread',     '面包'],
  ['rye',       '黑麦'],
  ['wholemeal', '全麦'],
  ['wheat',     '全麦'],
  ['buckwheat', '荞麦'],
  ['gluten',    '麸质'],
  ['sourdough', '酸面'],
];
for (const [en, cn] of words) {
  const rows = db.prepare(`
    SELECT id, name_en, name_cn FROM store_products
     WHERE (name_en LIKE ? OR name_cn LIKE ?)
       AND COALESCE(is_active, 1) = 1
     ORDER BY id LIMIT 6
  `).all('%' + en + '%', '%' + cn + '%');
  console.log(`\n  ${en} / ${cn} — ${rows.length} live product(s)`);
  for (const r of rows) console.log(`    #${r.id} en=${q(r.name_en)} cn=${q(r.name_cn)}`);
}

// And the option ANSWERS across the catalogue, which is where a size or a
// bread is most likely to have been named in both languages already.
rule('4 · option answers whose Chinese carries one of those words');
const ans = db.prepare(`
  SELECT c.id, c.label_en, c.label_cn, o.question_en, o.question_cn
    FROM retail_product_option_choices c
    JOIN retail_product_options o ON o.id = c.option_id
   WHERE c.label_cn LIKE '%面包%' OR c.label_cn LIKE '%全麦%'
      OR c.label_cn LIKE '%黑麦%' OR c.label_cn LIKE '%荞麦%'
      OR c.label_cn LIKE '%麸质%'
   ORDER BY c.id LIMIT 30
`).all();
if (!ans.length) console.log('  (no option answer anywhere carries one of those words)');
for (const a of ans) {
  console.log(`  #${a.id} en=${q(a.label_en)} cn=${q(a.label_cn)}   [under ${q(a.question_en)}]`);
}

rule('');
console.log('read complete — nothing was written.');
