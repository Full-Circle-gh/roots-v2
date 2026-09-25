#!/usr/bin/env node
/**
 * test_recipe_print.js — the recipe card a cook prints from the Recipes screen.
 *
 *   node scripts/test_recipe_print.js
 *
 * THE REQUEST (Ash, 2026-09-24): there was no way to print a recipe. The card
 * is for the kitchen, so it is bilingual throughout and carries NO money — the
 * screen hides cost from anyone without recipes:costs, and a sheet on a wall is
 * read by everybody who walks past it.
 *
 * HOW IT RUNS THE REAL CODE. recipePrintCard (and the option lists and parser
 * it reads) are LIFTED OUT of public/retail-admin/19-recipes.js by brace
 * matching; tdPrintRecipe runs from the shipped 26-print.js against a fake
 * window, so the HTML it writes can be read. A rename is reported, not passed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { tdWhen, tdToday } = require('../public/td-datetime.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RECIPES_JS = read('public/retail-admin/19-recipes.js');
const ADMIN_HTML = read('public/retail-admin.html');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const no  = (c, m, extra) => (!c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

function extract(src, decl) {
  const at = src.indexOf(decl);
  if (at === -1) throw new Error('not found in the shipped file: ' + decl);
  const open = decl.trim().endsWith('[') ? '[' : '{';
  const close = open === '[' ? ']' : '}';
  let i = src.indexOf(open, at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (!depth) return src.slice(at, i + 1) + (open === '[' ? ';' : ''); }
  }
  throw new Error('unbalanced after ' + decl);
}

// ── the card's data, from the recipe screen ───────────────────────────────
const cardSandbox = { console };
vm.createContext(cardSandbox);
for (const decl of ['const STORAGE_OPTIONS = [', 'const SHELF_LIFE_UNITS = [',
  'function parseShelfLife(', 'function lineSku(', 'function recipePrintCard(']) {
  vm.runInContext(extract(RECIPES_JS, decl), cardSandbox);
}
cardSandbox.__in = null;
const card = (details, lines, steps) => {
  cardSandbox.__in = { details, lines, steps };
  return vm.runInContext('recipePrintCard(__in.details, __in.lines, __in.steps)', cardSandbox);
};

const PESTO = {
  name_en: 'Arugula-Basil Pesto', name_cn: '芝麻叶罗勒青酱', sku: '1-20',
  category: 'Spreads & Dips', recipe_type: 'made',
  batch_size: 652.82, servings: 4, serving_size: 150,
  shelf_life: '14 days', storage: 'fridge', notes: 'Keep the oil layer on top.',
  // Money the screen holds that must not reach the card, even if a later
  // caller hands it in.
  sell_price: 38, labour: 5, overhead_pct: 10, target_food_cost: 30,
};
const LINES = [
  // sku is the copy taken when the line was added; master_sku is the
  // material's SKU now. The card prints the current one.
  { ingredient_id: 1, sku: 'J-01-OLD', master_sku: 'J-01', name_en: 'Arugula', name_cn: '芝麻叶', qty: 150, unit: 'g', cost: 3.2,
    notes: '  two big handfuls ' },
  { ingredient_id: null, sku: 'J-02', name_en: 'Nutritional yeast', name_cn: '', qty: 2, unit: 'g' },
  { ingredient_id: 3, sku: 'J-03', name_en: 'Lemon juice', name_cn: '柠檬汁', qty: '20.5', unit: 'ml' },
  { name_en: '', name_cn: '', qty: 0, unit: 'g' },           // an empty row
];
const STEPS = [
  { name: 'Prep', instructions: 'Wash the greens.\nToast the nuts.' },
  { name: '', instructions: '' },                             // an empty step
  { name: '', instructions: 'Blend.' },
];

section('1 · what the card says, from what is on screen');
{
  const { card: c, missingCn } = card(PESTO, LINES, STEPS);
  const facts = Object.fromEntries(c.facts);
  yes(c.nameEn === 'Arugula-Basil Pesto' && c.nameCn === '芝麻叶罗勒青酱', 'both names');
  yes(c.sku === '1-20', 'the SKU');
  yes(facts['SKU · 货号'] === '1-20', "the recipe's SKU is a fact, labelled in both languages",
    JSON.stringify(c.facts));
  no('Batch size · 批量大小' in facts, 'batch size is off the card: the SKU took its slot',
    JSON.stringify(c.facts));
  yes(facts['Servings · 份数'] === '4 × 150 g', 'servings with the serving weight');
  yes(facts['Shelf life · 保质期'] === '14 Days · 14 天', 'shelf life in both languages',
    facts['Shelf life · 保质期']);
  yes(facts['Storage · 储存方式'] === 'Fridge · 冷藏', 'storage in both languages');
  yes(c.lines.length === 3, 'an ingredient row with no name is left off', c.lines.length);
  yes(c.lines[0].en === 'Arugula' && c.lines[0].cn === '芝麻叶' && c.lines[0].qty === '150 g',
    'an ingredient carries both names and its amount', JSON.stringify(c.lines[0]));
  yes(c.lines[2].qty === '20.5 ml', 'the line keeps its own unit');
  yes(c.lines[0].note === 'two big handfuls', "an ingredient line's note reaches the card, trimmed",
    JSON.stringify(c.lines[0]));
  yes(c.lines[1].note === '', 'a line with no note carries an empty one');
  yes(c.lines[0].sku === 'J-01', "an ingredient's SKU is the material's current one, not the line's old copy",
    c.lines[0].sku);
  yes(c.lines[1].sku === 'J-02', 'a line whose material is gone keeps the copy it took');
  yes(c.lines[2].sku === 'J-03', 'a line added since the load uses the copy it just took');
  yes(c.steps.length === 2, 'an empty step is left off');
  yes(c.steps[0].text === 'Wash the greens.\nToast the nuts.', 'a step prints as typed, line breaks kept');
  yes(c.notes === 'Keep the oil layer on top.', 'the notes');
  yes(missingCn.length === 1 && missingCn[0] === 'Nutritional yeast',
    'what printed in English only is named, so it can be filled in', JSON.stringify(missingCn));
}

section('2 · no money reaches the card');
{
  const { card: c } = card(PESTO, LINES, STEPS);
  const json = JSON.stringify(c);
  no(/38|sell|price|cost|labour|overhead|margin|¥/i.test(json), 'no price, cost or margin in the card', json);
}

section('3 · what is missing is left off, not printed blank');
{
  const { card: c, missingCn } = card({ name_en: 'Plain', servings: 3 }, [], []);
  yes(c.facts.length === 1 && c.facts[0][1] === '3', 'servings without a serving weight is the count alone',
    JSON.stringify(c.facts));
  yes(missingCn[0] === 'Plain', 'a recipe with no Chinese name is named too');
  const odd = card({ name_en: 'Old', shelf_life: 'best before date on pack' }, [], []).card;
  yes(odd.facts[0][1] === 'best before date on pack', 'older free-text shelf life prints as it was written');
  const one = card({ name_en: 'Toast', shelf_life: '1 days' }, [], []).card;
  yes(one.facts[0][1] === '1 Day · 1 天', 'one day reads "1 Day", not "1 Days"', one.facts[0][1]);
}

// ── the sheet, from the print module ──────────────────────────────────────
function runPrint(setup) {
  const written = [];
  const toasts = [];
  const sandbox = {
    console, tdWhen, tdToday, Date,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    cuT: (en) => en,
    acMoney: (n) => '¥' + Number(n || 0).toFixed(2),
  };
  sandbox.window = sandbox;
  sandbox.window.open = () => ({ document: { write: (h) => written.push(h), close: () => {} } });
  Object.assign(sandbox, setup || {});
  vm.createContext(sandbox);
  vm.runInContext(read('public/retail-admin/26-print.js'), sandbox, { filename: '26-print.js' });
  return { sandbox, toasts, html: () => written.join('\n') };
}

section('4 · the printed sheet');
{
  const r = runPrint({ TD_SHOP_NAME: 'Harbour Greens' });
  r.sandbox.tdPrintRecipe(card(PESTO, LINES, STEPS).card);
  const h = r.html();
  yes(h.includes('Harbour Greens'), "the shop's own name");
  yes(h.includes('Arugula-Basil Pesto') && h.includes('芝麻叶罗勒青酱'), 'both recipe names');
  yes(h.includes('Ingredients<span>原料</span>') && h.includes('Steps<span>步骤</span>')
    && h.includes('Notes<span>备注</span>'), 'every heading in both languages');
  yes(h.includes('Arugula<span class="zh">芝麻叶</span>'), 'an ingredient in both languages');
  yes(h.includes('<th>SKU · 货号</th>') && h.includes('<td class="sku">J-01</td>'),
    "each ingredient's SKU has its own column");
  yes(h.includes('<td>Nutritional yeast</td>'), 'an ingredient with no Chinese name prints in English alone');
  no(/¥/.test(h), 'no currency anywhere on the sheet');
  no(/fonts\.googleapis|@import|<link/i.test(h), 'no external font or stylesheet');
  yes(/white-space:\s*pre-line/.test(h), "a step's line breaks survive to paper");
}

section('4b · laid out for the kitchen: amount first, SKU last, facts under the name');
{
  const r = runPrint({ TD_SHOP_NAME: 'Harbour Greens' });
  r.sandbox.tdPrintRecipe(card(PESTO, LINES, STEPS).card);
  const h = r.html();
  const head = (h.match(/<thead><tr>[\s\S]*?<\/tr><\/thead>/g) || [])[0] || '';
  const at = (s) => head.indexOf(s);
  yes(at('Qty · 数量') > -1 && at('Qty · 数量') < at('Ingredient · 原料') && at('Ingredient · 原料') < at('SKU · 货号'),
    'the columns read amount, ingredient, SKU', head);
  yes(/<td class="qty">150 g<\/td><td>Arugula/.test(h), 'each row starts with its amount, beside the name');
  yes(at('Ingredient · 原料') < at('Note · 备注') && at('Note · 备注') < at('SKU · 货号'),
    'a Note column sits between the ingredient and the SKU', head);
  yes(h.includes('<td class="lnote">two big handfuls</td>'), "the line's note prints in it, as typed");
  yes(/Nutritional yeast<\/td><td class="lnote"><\/td>/.test(h), 'a line with no note leaves its cell empty');
  const { card: c } = card(PESTO, LINES, STEPS);
  yes(c.facts[0][0] === 'Servings · 份数' && c.facts[1][0] === 'SKU · 货号',
    'servings first, then the SKU in the slot batch size had',
    JSON.stringify(c.facts.map((f) => f[0])));
  const name = h.indexOf('<h1>'), facts = h.indexOf('<dl class="facts">'), ing = h.indexOf('Ingredients<span>');
  yes(name > -1 && name < facts && facts < ing, 'the facts sit under the name, above the ingredients');
  yes(h.includes('<dd>4 × 150 g</dd>'), 'a fact prints its value');
  no(/class="meta"/.test(h), 'no small facts block tucked top right');
  yes(h.includes('<dt>SKU · 货号</dt><dd>1-20</dd>'), "the recipe's SKU prints in the facts row, full size");
  yes(/<div class="foot"><span>Harbour Greens<\/span>/.test(h), 'and not again in the foot');
  no(/<div class="sub">SKU/.test(h), 'nor as small print under the name');
}
{
  const r = runPrint();
  r.sandbox.tdPrintRecipe(card({ name_en: 'Plain' }, [], []).card);
  no(r.html().includes('<dl class="facts">'), 'a recipe with no facts prints no empty facts row');
}
{
  const r = runPrint();
  const plain = LINES.map((l) => Object.assign({}, l, { notes: '' }));
  r.sandbox.tdPrintRecipe(card(PESTO, plain, STEPS).card);
  const h = r.html();
  no(h.includes('Note · 备注') || h.includes('class="lnote"'), 'no line has a note: no empty Note column');
}
{
  const r = runPrint();
  r.sandbox.tdPrintRecipe(card({ name_en: 'Plain' }, [], []).card);
  const h = r.html();
  yes(h.includes('Nothing to show'), 'a recipe with no ingredients says so');
  no(h.includes('Steps<span>') || h.includes('Notes<span>'), 'no empty Steps or Notes heading');
}
{
  const r = runPrint();
  r.sandbox.window.open = () => null;
  const w = r.sandbox.tdPrintRecipe(card(PESTO, LINES, STEPS).card);
  yes(w === null && r.toasts.length === 1 && r.toasts[0].kind === 'err', 'a blocked pop-up is said, not swallowed');
}

section('5 · the button');
{
  yes(/id="rcp-rec-print"[^>]*onclick="rcpPrint\(\)"/.test(ADMIN_HTML), 'the record header has a Print button');
  no(/id="rcp-rec-print"[^>]*data-cap=/.test(ADMIN_HTML), 'it is not gated: it shows nothing a viewer cannot see');
  yes(RECIPES_JS.includes("T('Print', '打印')"), 'its label is bilingual');
  yes(/window\.rcpPrint = function/.test(RECIPES_JS), 'the handler exists');
}

section('6 · the SKU on screen');
{
  const route = read('routes/retail-recipes.js');
  const one = route.slice(route.indexOf("router.get('/api/retail-admin/recipes/:id'"));
  yes(/i\.sku AS master_sku/.test(one.slice(0, 1500)), "the record's lines carry the material's current SKU");
  yes(/rcp-line-sku/.test(RECIPES_JS) && /const sku = lineSku\(l\)/.test(RECIPES_JS),
    'each ingredient line shows it'); 
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
