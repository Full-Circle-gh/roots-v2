#!/usr/bin/env node
/**
 * Link the paid extras on the four wraps and the Beet Salad to the stock
 * products they are, so ordering one takes it off the shelf.
 *
 *   node scripts/oneoff_link_wrap_and_beet_extras.js          # prints the plan, writes nothing
 *   node scripts/oneoff_link_wrap_and_beet_extras.js --apply  # write
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Ash, 2026-09-23: "all extras should go down from the stock once ordered",
 * then "yes" to linking these, of the list
 * scripts/diagnose_dip_options_and_unlinked_extras.js printed.
 *
 *   Tofu Banh Mi / Shawarma / Falafel / Pesto 'Chicken' wraps, "on the side":
 *     Wild harrisa (spicy)  -> #355 Harissa Chilli Paste
 *     Tzadziki              -> #356 Tzatziki
 *     Red onion pickles     -> #354 Pickled Onions
 *   Beet Salad, "Flavor Boosters":
 *     Onion Pickles         -> #354 Pickled Onions
 *     Spicy Harrisa         -> #355 Harissa Chilli Paste
 *
 * #354 and #355 are the stock products the soups' and dips' extras already
 * deduct from. #356 is the Tzatziki stock product; no extra used it before, so
 * a shop that has never counted it will see Tzadziki sold out on the wraps
 * until it does (§47).
 *
 * LEFT UNLINKED, DELIBERATELY, as told to Ash: drink sizes and extra shots
 * (not a thing on a shelf), the toasts' "gluten-free +¥3" (a swap of the bread
 * already on the toast, not an extra item), and the Hummus Platter's extras
 * (no stock product to link them to).
 *
 * ── WHAT IT TOUCHES ────────────────────────────────────────────────────────
 * Only stock_product_id on the named answers, and only where it is blank. No
 * label, price, order or Chinese changes; no rows are added or removed. Each
 * product is found by SKU with its name checked, each answer by its label
 * within its question; a missing product, question or answer REFUSES, and so
 * does an answer already linked to a DIFFERENT stock product.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * An answer already linked to the right product is reported and skipped.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path.
 */
'use strict';

const Database = require('@libsql/client');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const STOCK = { 354: 'Pickled Onions', 355: 'Harissa Chilli Paste', 356: 'Tzatziki' };
const WRAP_SIDES = { 'Wild harrisa (spicy)': 355, 'Tzadziki': 356, 'Red onion pickles': 354 };
const PLAN = [
  { sku: '1-410', name: 'Tofu Banh Mi Wrap', q: 'on the side', links: WRAP_SIDES },
  { sku: '1-430', name: 'Shawarma Wrap', q: 'on the side', links: WRAP_SIDES },
  { sku: '1-420', name: 'Falafel Wrap', q: 'on the side', links: WRAP_SIDES },
  { sku: '1-440', name: "Pesto 'Chicken' Wrap", q: 'on the side', links: WRAP_SIDES },
  { sku: '1-310', name: 'Beet Salad', q: 'Flavor Boosters',
    links: { 'Onion Pickles': 354, 'Spicy Harrisa': 355 } },
];

const q = (v) => JSON.stringify(v == null ? null : v);
const rule = (t) => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));
const die = (m) => { console.error('\nREFUSED: ' + m + ' Nothing was written.'); process.exit(1); };
const norm = (s) => String(s || '').replace(/[’‘]/g, "'").trim().toLowerCase();

console.log(`db: ${dbPath}`);
console.log(`mode: ${WRITE ? 'APPLY — this will write' : 'DRY RUN — nothing will be written'}`);

rule('1 · the stock products');
for (const [id, name] of Object.entries(STOCK)) {
  const p = db.prepare('SELECT id, sku, name_en FROM store_products WHERE id = ?').get(Number(id));
  if (!p) die(`stock product #${id} does not exist.`);
  if (!norm(p.name_en).includes(norm(name))) die(`stock product #${id} is ${q(p.name_en)}, not ${q(name)}.`);
  console.log(`  #${p.id} ${p.sku} ${p.name_en}`);
}

rule('2 · the plan');
const todo = [];   // { choiceId, to, what }
for (const t of PLAN) {
  const rows = db.prepare('SELECT id, sku, name_en FROM store_products WHERE sku = ?').all(t.sku);
  if (rows.length !== 1) die(`${rows.length} products carry SKU ${t.sku}; expected exactly one.`);
  const p = rows[0];
  if (!norm(p.name_en).includes(norm(t.name))) die(`SKU ${t.sku} is ${q(p.name_en)}, not ${q(t.name)}.`);
  const groups = db.prepare(
    'SELECT id FROM retail_product_options WHERE product_id = ? AND LOWER(TRIM(question_en)) = ?'
  ).all(p.id, norm(t.q));
  if (groups.length !== 1) die(`${p.sku} ${p.name_en} has ${groups.length} ${q(t.q)} questions; expected one.`);
  const choices = db.prepare(
    'SELECT id, label_en, stock_product_id FROM retail_product_option_choices WHERE option_id = ?'
  ).all(groups[0].id);
  console.log(`\n  ${p.sku} ${p.name_en} — ${q(t.q)}`);
  for (const [label, to] of Object.entries(t.links)) {
    const hits = choices.filter(c => norm(c.label_en) === norm(label));
    if (hits.length !== 1) die(`${p.sku} ${q(t.q)} has ${hits.length} answers reading ${q(label)}; expected one.`);
    const c = hits[0];
    if (c.stock_product_id != null && Number(c.stock_product_id) === to) {
      console.log(`    = ${q(label)} already takes #${to} ${STOCK[to]} off stock`);
      continue;
    }
    if (c.stock_product_id != null) {
      die(`${p.sku} ${q(label)} is already linked to #${c.stock_product_id}, not #${to}. Somebody chose that.`);
    }
    console.log(`    + ${q(label)} -> #${to} ${STOCK[to]}`);
    todo.push({ choiceId: c.id, to, what: `${p.sku} ${label}` });
  }
}
if (!todo.length) { rule(''); console.log('Nothing to do — every extra listed is already linked.'); process.exit(0); }

if (!WRITE) {
  rule('');
  console.log(`DRY RUN — nothing was written. ${todo.length} extra(s) would be linked. Re-run with --apply.`);
  process.exit(0);
}

rule('3 · writing');
const up = db.prepare(
  'UPDATE retail_product_option_choices SET stock_product_id = ? WHERE id = ? AND stock_product_id IS NULL');
db.transaction(() => {
  for (const t of todo) {
    if (up.run(t.to, t.choiceId).changes !== 1) throw new Error(`${t.what} changed under us`);
  }
})();

rule('4 · read back');
let bad = 0;
const get = db.prepare('SELECT stock_product_id FROM retail_product_option_choices WHERE id = ?');
for (const t of todo) {
  const r = get.get(t.choiceId);
  const ok = r && Number(r.stock_product_id) === t.to;
  console.log(`  ${ok ? 'OK ' : '!! '} ${t.what} -> #${t.to}`);
  if (!ok) bad++;
}
rule('');
if (bad) { console.error(`FAILED — ${bad} link(s) did not take.`); process.exit(1); }
console.log('APPLIED — every listed extra now takes its stock product off the shelf.');
