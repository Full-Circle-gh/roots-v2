#!/usr/bin/env node
/**
 * Make every soup on sale carry exactly the options Red Lentil Soup carries —
 * same questions, same extras, same order, same prices, same Chinese, AND the
 * same stock links.
 *
 *   node scripts/oneoff_soup_options_from_red_lentil.js          # prints the plan, writes nothing
 *   node scripts/oneoff_soup_options_from_red_lentil.js --apply  # write
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Ash, 2026-09-23: "i want all soups to have the same options as this soup",
 * then, of the stock links: "in red lentil its right. it should be like this in
 * all soups".
 *
 * scripts/diagnose_soup_options.js read the live catalogue first. The five
 * soups on sale all show the same "heat up?" question and the same five paid
 * extras, but:
 *
 *   1. Only Red Lentil (1-460) links each extra to a stock product, so choosing
 *      brown rice takes one brown rice off the shelf and an extra that has run
 *      out shows sold out. On the other four the extras are unlinked: nothing
 *      is deducted and they never sell out.
 *   2. Herbal Nourish (1-360) has its pita last instead of fourth, spelt
 *      "whole wheat pita bread" / 全麦皮塔面包 instead of
 *      "Whole wheat pita bread" / 全麦皮塔饼.
 *
 * Copying Red Lentil's groups verbatim onto the other four fixes both.
 *
 * ── THE CONSEQUENCE, STATED ONCE ───────────────────────────────────────────
 * After this runs, an extra on ANY soup shows sold out at a shop whose shelf
 * has none of that stock product counted (§47: an absent shelf record is sold
 * out). That is already how Red Lentil behaves today; it becomes true of all
 * five. Ash chose it.
 *
 * ── THE CHINESE ────────────────────────────────────────────────────────────
 * Nothing is composed. Every string is copied from Red Lentil's live rows, and
 * each one is already live on four of the five soups.
 *
 * ── TARGETED BY SKU AND NAME, NEVER BY ROW ID ──────────────────────────────
 * The product editor deletes and re-inserts a product's option rows on every
 * save (see scripts/oneoff_bread_question.js), so option and choice ids are
 * not stable. Each product is found by SKU and its name is checked; the
 * template is checked against the five extras and five stock links it was
 * written for. Anything unexpected REFUSES and writes nothing.
 *
 * Replacing a product's option rows is exactly what a save in the product
 * editor does, so every reader already copes with it. Past orders keep their
 * own snapshot of the labels (options_json) and are untouched.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * A product whose options already match the template is reported and skipped.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, through SQLite's online .backup API with an
 * integrity_check that aborts the run if it is not "ok".
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const TEMPLATE = { sku: '1-460', name: 'Red Lentil Soup' };
const TARGETS = [
  { sku: '1-400', name: 'Nourish Beans' },
  { sku: '1-360', name: 'Herbal Nourish Soup' },
  { sku: '1-370', name: 'Roasted Pumpkin Soup' },
  { sku: '1-380', name: 'Sweet Potato & Cauliflower Curry' },
];
// What the template was read to hold on 2026-09-23. If it has changed since,
// the change was somebody's decision and this script must be re-read, not run.
const EXPECT = [
  { q: 'heat up?', choices: [['Yes', null], ['No', null]] },
  { q: 'Add extras?', choices: [
    ['Brown Rice', 177], ['Mix colored Quinoa', 161], ['3 Slice of whole wheat bread', 352],
    ['Whole wheat pita bread', 351], ['Wild harrisa (spicy)', 355],
  ] },
];

const q = (v) => JSON.stringify(v == null ? null : v);
const rule = (t) => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));
const die = (m) => { console.error('\nREFUSED: ' + m + ' Nothing was written.'); process.exit(1); };

console.log(`db: ${dbPath}`);
console.log(`mode: ${WRITE ? 'APPLY — this will write' : 'DRY RUN — nothing will be written'}`);

const optCols = db.prepare('PRAGMA table_info(retail_product_options)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'product_id' && c !== 'created_at');
const choiceCols = db.prepare('PRAGMA table_info(retail_product_option_choices)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'option_id');

const findProduct = (t) => {
  const rows = db.prepare('SELECT id, sku, name_en, name_cn FROM store_products WHERE sku = ?').all(t.sku);
  if (rows.length !== 1) die(`${rows.length} products carry SKU ${t.sku}; expected exactly one.`);
  const p = rows[0];
  const norm = (s) => String(s || '').replace(/＆/g, '&').toLowerCase();
  if (!norm(p.name_en).includes(norm(t.name))) {
    die(`SKU ${t.sku} is ${q(p.name_en)}, not ${q(t.name)}. It may have been reused.`);
  }
  return p;
};

// Options of one product, as plain data with no row ids — the shape compared and copied.
const readOptions = (productId) => db.prepare(
  'SELECT * FROM retail_product_options WHERE product_id = ? ORDER BY sort_order, id'
).all(productId).map(o => ({
  opt: Object.fromEntries(optCols.map(c => [c, o[c]])),
  choices: db.prepare(
    'SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order, id'
  ).all(o.id).map(c => Object.fromEntries(choiceCols.map(k => [k, c[k]]))),
}));

// Positions are rewritten 0..n on copy, so compare on that normalised shape.
const normalise = (groups) => groups.map((g, oi) => ({
  opt: { ...g.opt, sort_order: oi },
  choices: g.choices.map((c, ci) => ({ ...c, sort_order: ci })),
}));
const same = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

const show = (groups) => {
  for (const g of groups) {
    console.log(`    ? ${q(g.opt.question_en)} / ${q(g.opt.question_cn)}  type=${g.opt.type} required=${g.opt.is_required}`);
    for (const c of g.choices) {
      console.log(`        - ${q(c.label_en)} / ${q(c.label_cn)}  +${c.price_delta}`
        + (c.stock_product_id != null ? `  stock #${c.stock_product_id}` : '  (no stock link)'));
    }
  }
};

// ── the template, checked against what it was read to hold ─────────────────
rule('1 · the template');
const src = findProduct(TEMPLATE);
const template = readOptions(src.id);
console.log(`  ${src.sku} ${src.name_en} (#${src.id})`);
show(template);
if (template.length !== EXPECT.length) die(`the template has ${template.length} option groups, expected ${EXPECT.length}.`);
EXPECT.forEach((e, i) => {
  const g = template[i];
  if (g.opt.question_en !== e.q) die(`template group ${i + 1} asks ${q(g.opt.question_en)}, expected ${q(e.q)}.`);
  if (g.choices.length !== e.choices.length) die(`${q(e.q)} has ${g.choices.length} answers, expected ${e.choices.length}.`);
  e.choices.forEach(([label, stock], j) => {
    const c = g.choices[j];
    if (c.label_en !== label) die(`${q(e.q)} answer ${j + 1} is ${q(c.label_en)}, expected ${q(label)}.`);
    if ((c.stock_product_id == null ? null : Number(c.stock_product_id)) !== stock) {
      die(`${q(label)} is linked to stock ${q(c.stock_product_id)}, expected ${q(stock)}.`);
    }
  });
});
console.log('  matches what it was read to hold.');

// ── the plan ───────────────────────────────────────────────────────────────
rule('2 · the plan');
const todo = [];
for (const t of TARGETS) {
  const p = findProduct(t);
  const current = readOptions(p.id);
  console.log(`\n  ${p.sku} ${p.name_en} (#${p.id})`);
  if (same(current, template)) { console.log('    already matches Red Lentil — nothing to do.'); continue; }
  console.log('    now:');
  show(current);
  console.log('    becomes: the template above');
  todo.push(p);
}
if (!todo.length) { rule(''); console.log('Nothing to do — every soup already matches Red Lentil.'); process.exit(0); }

if (!WRITE) {
  rule('');
  console.log(`DRY RUN — nothing was written. ${todo.length} soup(s) would change. Re-run with --apply.`);
  process.exit(0);
}

// ── write: one transaction for all soups ───────────────────────────────────
rule('3 · writing');
const insOpt = db.prepare(
  `INSERT INTO retail_product_options (product_id, ${optCols.join(', ')})
   VALUES (?, ${optCols.map(() => '?').join(', ')})`);
const insChoice = db.prepare(
  `INSERT INTO retail_product_option_choices (option_id, ${choiceCols.join(', ')})
   VALUES (?, ${choiceCols.map(() => '?').join(', ')})`);
const delChoices = db.prepare(
  `DELETE FROM retail_product_option_choices
    WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`);
const delOpts = db.prepare('DELETE FROM retail_product_options WHERE product_id = ?');

db.transaction(() => {
  for (const p of todo) {
    delChoices.run(p.id);
    delOpts.run(p.id);
    normalise(template).forEach(g => {
      const optId = insOpt.run(p.id, ...optCols.map(c => g.opt[c])).lastInsertRowid;
      g.choices.forEach(c => insChoice.run(optId, ...choiceCols.map(k => c[k])));
    });
    console.log(`  wrote ${p.sku} ${p.name_en}`);
  }
})();

// ── read back, because a write that was not checked is a claim ─────────────
rule('4 · read back');
let bad = 0;
for (const t of TARGETS) {
  const p = findProduct(t);
  const ok = same(readOptions(p.id), template);
  console.log(`  ${ok ? 'OK ' : '!! '} ${p.sku} ${p.name_en}`);
  if (!ok) bad++;
}
rule('');
if (bad) { console.error(`FAILED — ${bad} soup(s) do not match after the write.`); process.exit(1); }
console.log('APPLIED — all five soups read back identical to Red Lentil.');
