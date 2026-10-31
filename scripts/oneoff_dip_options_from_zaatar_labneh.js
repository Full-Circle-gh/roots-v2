#!/usr/bin/env node
/**
 * Give the dips on sale exactly the extras Za'atar Labneh carries — same six
 * extras, same order, same prices, same Chinese, same stock links.
 *
 *   node scripts/oneoff_dip_options_from_zaatar_labneh.js          # prints the plan, writes nothing
 *   node scripts/oneoff_dip_options_from_zaatar_labneh.js --apply  # write
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Ash, 2026-09-23, with a screenshot of Za'atar Labneh (1-40): "we need to do
 * the same for the dips. this is the template for the dips", then, of the list
 * scripts/diagnose_dip_options_and_unlinked_extras.js produced: "except nachos
 * dip. do all".
 *
 * That diagnostic found Zhoug, Guacamole, Chickpea Salad and Turkish Tomato
 * Salad already carrying the template, and these seven dips not:
 *
 *   1-10  Hummus Asli                           no options
 *   1-20  Arugula-Basil Pesto                   two breads only
 *   1-30  Tzatziki                              no options
 *   1-70  Garlic Dill Sour Cream                no options
 *   1-80  Olive 'n' Cream                       no options
 *   1-90  Classic Cashew Sour Cream             no options
 *   1-15  Baked Camembert Roasted Garlic Spread no options
 *
 * Nacho Cheese Dip (3-230) is left out on Ash's word.
 *
 * Every extra is linked to a stock product, so choosing one takes it off the
 * shelf, and one a shop has none of counted shows sold out (§47). That is how
 * the template and the four dips that already match behave today.
 *
 * ── THE CHINESE ────────────────────────────────────────────────────────────
 * Nothing is composed. Every string is copied from the template's live rows,
 * already live on five products.
 *
 * ── TARGETED BY SKU AND NAME, NEVER BY ROW ID ──────────────────────────────
 * Option and choice ids are renumbered by every save in the product editor.
 * Each product is found by SKU and its name checked; the template is checked
 * against the six extras and links it was read to hold. Anything unexpected
 * REFUSES and writes nothing. Replacing a product's option rows is what an
 * editor save does; past orders keep their own snapshot and are untouched.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * A dip that already matches the template is reported and skipped.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, with an integrity_check that aborts on failure.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const TEMPLATE = { sku: '1-40', name: "Za'atar Labneh" };
const TARGETS = [
  { sku: '1-10', name: 'Hummus Asli' },
  { sku: '1-20', name: 'Arugula-Basil Pesto' },
  { sku: '1-30', name: 'Tzatziki' },
  { sku: '1-70', name: 'Garlic Dill Sour Cream' },
  { sku: '1-80', name: "Olive 'n' Cream" },
  { sku: '1-90', name: 'Classic Cashew Sour Cream' },
  { sku: '1-15', name: 'Baked Camembert Roasted Garlic Spread' },
];
// What the template was read to hold on 2026-09-23.
const EXPECT = [
  { q: 'Add extras?', choices: [
    ['Whole-Wheat Crisp Crackers (1 pack)', 96], ['GF Buckwheat Bread (3 slices)', 353],
    ['Whole-Wheat Pita', 351], ['Rye & Whole Wheat Bread (3 slices)', 352],
    ['Harissa Chilli Paste (1 serving)', 355], ['Pickled Onions (1 serving)', 354],
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
  const rows = db.prepare('SELECT id, sku, name_en FROM store_products WHERE sku = ?').all(t.sku);
  if (rows.length !== 1) die(`${rows.length} products carry SKU ${t.sku}; expected exactly one.`);
  const p = rows[0];
  const norm = (s) => String(s || '').replace(/＆/g, '&').replace(/[’‘]/g, "'").toLowerCase();
  if (!norm(p.name_en).includes(norm(t.name))) {
    die(`SKU ${t.sku} is ${q(p.name_en)}, not ${q(t.name)}. It may have been reused.`);
  }
  return p;
};

const readOptions = (productId) => db.prepare(
  'SELECT * FROM retail_product_options WHERE product_id = ? ORDER BY sort_order, id'
).all(productId).map(o => ({
  opt: Object.fromEntries(optCols.map(c => [c, o[c]])),
  choices: db.prepare(
    'SELECT * FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order, id'
  ).all(o.id).map(c => Object.fromEntries(choiceCols.map(k => [k, c[k]]))),
}));

const normalise = (groups) => groups.map((g, oi) => ({
  opt: { ...g.opt, sort_order: oi },
  choices: g.choices.map((c, ci) => ({ ...c, sort_order: ci })),
}));
const same = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

const show = (groups) => {
  if (!groups.length) { console.log('    (no options)'); return; }
  for (const g of groups) {
    console.log(`    ? ${q(g.opt.question_en)} / ${q(g.opt.question_cn)}  type=${g.opt.type} required=${g.opt.is_required}`);
    for (const c of g.choices) {
      console.log(`        - ${q(c.label_en)} / ${q(c.label_cn)}  +${c.price_delta}`
        + (c.stock_product_id != null ? `  stock #${c.stock_product_id}` : '  (no stock link)'));
    }
  }
};

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

rule('2 · the plan');
const todo = [];
for (const t of TARGETS) {
  const p = findProduct(t);
  const current = readOptions(p.id);
  console.log(`\n  ${p.sku} ${p.name_en} (#${p.id})`);
  if (same(current, template)) { console.log("    already matches Za'atar Labneh — nothing to do."); continue; }
  console.log('    now:');
  show(current);
  console.log('    becomes: the template above');
  todo.push(p);
}
if (!todo.length) { rule(''); console.log("Nothing to do — every dip already matches Za'atar Labneh."); process.exit(0); }

if (!WRITE) {
  rule('');
  console.log(`DRY RUN — nothing was written. ${todo.length} dip(s) would change. Re-run with --apply.`);
  process.exit(0);
}

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

rule('4 · read back');
let bad = 0;
for (const t of TARGETS) {
  const p = findProduct(t);
  const ok = same(readOptions(p.id), template);
  console.log(`  ${ok ? 'OK ' : '!! '} ${p.sku} ${p.name_en}`);
  if (!ok) bad++;
}
rule('');
if (bad) { console.error(`FAILED — ${bad} dip(s) do not match after the write.`); process.exit(1); }
console.log("APPLIED — every listed dip reads back identical to Za'atar Labneh.");
