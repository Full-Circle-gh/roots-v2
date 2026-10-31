#!/usr/bin/env node
//
// test_recipe_duplicate.js — the Recipes list's Duplicate action.
//
// WHAT THIS IS FOR
// ----------------
// Most new recipes on this screen are variants of one already there, and until
// this button existed starting one meant retyping every ingredient line by hand
// off the recipe open in the next tab. A duplicate has to carry the WORK and
// none of the source's IDENTITY, and the two failures either side of that line
// are both silent:
//
//   * carry too little — an empty recipe wearing the right name, which looks
//     right in the list and is discovered days later in the kitchen;
//   * carry too much — the source's SKU (UNIQUE in the recipes table) makes the
//     first save a 400 that autosave then repeats every few seconds, and the
//     source's material link makes the copy's header offer to unlink a material
//     it has nothing to do with.
//
// So the sku assertion below is not tidiness: it is checked against the SHIPPED
// schema, by actually inserting both rows, because "UNIQUE" is a fact about the
// database and not about this file.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * duplicateOf and dupButton are LIFTED OUT of
//     public/retail-admin/19-recipes.js, brace-matched, and run in a vm.
//   * The uniqueness case runs against a real in-memory database built from the
//     shipped schema.sql, using the INSERT the create route itself issues.
//   * The table's shape is read out of the shipped tableHtml().
//
// USAGE   node scripts/test_recipe_duplicate.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT       = path.join(__dirname, '..');
const read       = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RECIPES_JS = read('public', 'retail-admin', '19-recipes.js');
const RECIPES_CSS= read('public', 'retail-admin.css');
const SCHEMA_SQL = read('schema.sql');
const ROUTES_JS  = read('routes', 'retail-recipes.js');

function loadSqlite() {
  try { return require('@libsql/client'); } catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); } catch (e) { /* next */ }
  }
  console.error('better-sqlite3 not found — run from the main checkout or the box.');
  process.exit(2);
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// Slice a named top-level function or const out of a shipped file,
// brace-matched, so what runs below is the source that ships rather than a copy
// of it. Anchored on the declaration alone — an anchor carrying surrounding
// lines breaks on a reformat and reports it as a missing feature.
function extractFunction(src, decl) {
  const at = src.indexOf(decl);
  assert.notStrictEqual(at, -1, `not found in the shipped file: ${decl}`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced braces after ${decl}`);
}
function extractLine(src, decl) {
  const at = src.indexOf(decl);
  assert.notStrictEqual(at, -1, `not found in the shipped file: ${decl}`);
  return src.slice(at, src.indexOf('\n', at) + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. duplicateOf — the shipped function, run against a full record');
// ═══════════════════════════════════════════════════════════════════════════

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  extractLine(RECIPES_JS, "const COPY_SUFFIX_EN") +
  extractLine(RECIPES_JS, "const COPY_SUFFIX_CN") +
  extractFunction(RECIPES_JS, 'function duplicateOf(') +
  '\nglobalThis.duplicateOf = duplicateOf;',
  sandbox);
const duplicateOf = sandbox.duplicateOf;

// A source with every part a duplicate has an opinion about: two ingredient
// lines (one deliberately excluded from the yield), two steps, cost inputs, a
// SKU, a linked material with a consumer, a live product, and derived yield
// flags in a non-default combination.
function sourceRecipe() {
  return {
    id: 41,
    name_en: 'Garlic Dill Sour Cream',
    name_cn: '蒜香莳萝酸奶油',
    sku: 'RCP-0041',
    category: 'Sour creams 酸奶油',
    recipe_type: 'made',
    batch_size: 2616, servings: 12, serving_size: 218,
    batch_size_auto: 1, servings_auto: 0,
    shelf_life: '14d', storage: 'Chilled', notes: 'Rest overnight.',
    is_active: 1,
    ingredients: [
      { id: 900, recipe_id: 41, ingredient_id: 12, name_en: 'Sour cream', name_cn: '酸奶油',
        sku: 'ING-12', qty: 2400, unit: 'g', in_yield: 1, notes: null, substitutes: null,
        sort_order: 0, master_cost: 0.031, master_unit: 'g' },
      { id: 901, recipe_id: 41, ingredient_id: 44, name_en: 'Brine', name_cn: '盐水',
        sku: 'ING-44', qty: 200, unit: 'ml', in_yield: 0, notes: 'drained off',
        substitutes: null, sort_order: 1, master_cost: 0.002, master_unit: 'ml' },
    ],
    steps: [
      { id: 500, recipe_id: 41, step_number: 1, name: 'Mix', instructions: 'Fold the dill through.' },
      { id: 501, recipe_id: 41, step_number: 2, name: 'Rest', instructions: 'Overnight, chilled.' },
    ],
    costData: { id: 77, recipe_id: 41, labour: 18, packaging: 4, overhead_pct: 12,
                sell_price: 24, target_food_cost: 28 },
    cost: { batchCost: 109.05, costPerServing: 9.09, zeroCostIngredientLines: 0, lines: [] },
    backsMaterial: { id: 310, name_en: 'Garlic Dill Sour Cream', cost_per_unit: 0.0417,
                     unit: 'g', consumers: [{ id: 62, name_en: 'Loaded Potato' }] },
    materialBlock: { ok: true, reason: null },
    products: [{ id: 8, name_en: 'Garlic Dill Sour Cream 150g', sell_price: 32 }],
  };
}

check('the copy has no id — which is what makes the save a create, not an update', () => {
  assert.strictEqual(duplicateOf(sourceRecipe()).id, null);
});

check('the copy carries no SKU', () => {
  assert.strictEqual(duplicateOf(sourceRecipe()).sku, '');
});

check('each name is suffixed in its OWN language, never the viewer\'s', () => {
  const c = duplicateOf(sourceRecipe());
  assert.strictEqual(c.name_en, 'Garlic Dill Sour Cream (copy)');
  assert.strictEqual(c.name_cn, '蒜香莳萝酸奶油(副本)');
});

// A recipe with no Chinese name must not acquire the bare suffix as its whole
// Chinese name — "(副本)" alone in that column names nothing.
check('a source with no Chinese name gives a copy with no Chinese name', () => {
  const src = sourceRecipe();
  src.name_cn = null;
  assert.strictEqual(duplicateOf(src).name_cn, '');
});

check('the ingredient lines come across whole — qty, unit and the yield flag', () => {
  const lines = duplicateOf(sourceRecipe()).ingredients;
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].ingredient_id, 12);
  assert.strictEqual(lines[0].qty, 2400);
  assert.strictEqual(lines[0].unit, 'g');
  // The excluded line stays excluded. in_yield is the divisor of every
  // per-gram cost on the screen; a copy that silently re-counts a drained
  // brine prices the whole recipe wrong.
  assert.strictEqual(lines[1].in_yield, 0);
  assert.strictEqual(lines[1].notes, 'drained off');
});

check('the steps come across in order, with their text', () => {
  const steps = duplicateOf(sourceRecipe()).steps;
  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].name, 'Mix');
  assert.strictEqual(steps[1].instructions, 'Overnight, chilled.');
});

check('no child row carries the source\'s id or recipe_id', () => {
  const c = duplicateOf(sourceRecipe());
  c.ingredients.concat(c.steps).concat([c.costData]).forEach((row) => {
    assert.ok(!('id' in row), 'a child row kept an id: ' + JSON.stringify(row).slice(0, 60));
    assert.ok(!('recipe_id' in row), 'a child row kept a recipe_id: ' + JSON.stringify(row).slice(0, 60));
  });
});

check('the cost inputs come across', () => {
  const cd = duplicateOf(sourceRecipe()).costData;
  assert.strictEqual(cd.labour, 18);
  assert.strictEqual(cd.overhead_pct, 12);
  assert.strictEqual(cd.sell_price, 24);
  assert.strictEqual(cd.target_food_cost, 28);
});

check('the yield figures AND whether each is derived come across', () => {
  const c = duplicateOf(sourceRecipe());
  assert.strictEqual(c.batch_size, 2616);
  assert.strictEqual(c.servings, 12);
  assert.strictEqual(c.serving_size, 218);
  // Not defaulted back to derived: a recipe whose servings were TYPED must
  // duplicate as a recipe whose servings are typed, or the copy quietly
  // recomputes to a different number of servings than the thing it copied.
  assert.strictEqual(c.batch_size_auto, 1);
  assert.strictEqual(c.servings_auto, 0);
});

check('the filing fields come across — category, type, shelf life, storage, notes', () => {
  const c = duplicateOf(sourceRecipe());
  assert.strictEqual(c.category, 'Sour creams 酸奶油');
  assert.strictEqual(c.recipe_type, 'made');
  assert.strictEqual(c.shelf_life, '14d');
  assert.strictEqual(c.storage, 'Chilled');
  assert.strictEqual(c.notes, 'Rest overnight.');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. What the copy must NOT inherit');
// ═══════════════════════════════════════════════════════════════════════════

check('the source\'s material link and its block state are dropped', () => {
  const c = duplicateOf(sourceRecipe());
  assert.strictEqual(c.backsMaterial, null);
  assert.strictEqual(c.materialBlock, null);
});

check('the source\'s live products are dropped', () => {
  // Length, not deepStrictEqual: the array is minted inside the vm context, so
  // its prototype is not this realm's Array and reference-equality on the
  // prototype fails on two arrays that are both genuinely empty.
  const p = duplicateOf(sourceRecipe()).products;
  assert.strictEqual(p.length, 0, JSON.stringify(p));
});

check('the source\'s computed cost is dropped, not printed over the copy', () => {
  assert.strictEqual(duplicateOf(sourceRecipe()).cost, null);
});

// Duplicating an archived recipe is a normal way to restart an idea without
// disturbing what was filed. A copy that arrived archived would be created and
// then invisible in the list it lands back in.
check('an ARCHIVED source produces a LIVE copy', () => {
  const src = sourceRecipe();
  src.is_active = 0;
  assert.strictEqual(duplicateOf(src).is_active, 1);
});

// The list row the operator clicked is still on screen behind the takeover.
check('the source object is not mutated', () => {
  const src = sourceRecipe();
  const before = JSON.stringify(src);
  duplicateOf(src);
  assert.strictEqual(JSON.stringify(src), before);
});

check('the copy\'s child rows are not the source\'s objects', () => {
  const src = sourceRecipe();
  const c = duplicateOf(src);
  c.ingredients[0].qty = 1;
  c.steps[0].name = 'changed';
  assert.strictEqual(src.ingredients[0].qty, 2400);
  assert.strictEqual(src.steps[0].name, 'Mix');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. Why the SKU is cleared — against the shipped schema');
// ═══════════════════════════════════════════════════════════════════════════

const Database = loadSqlite();

// The recipes table as it actually ships, taken out of schema.sql rather than
// hand-rewritten here: the UNIQUE this section is about is the shipped one.
function recipesDdl() {
  const at = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS recipes (');
  assert.notStrictEqual(at, -1, 'recipes table not found in schema.sql');
  const end = SCHEMA_SQL.indexOf(');', at);
  return SCHEMA_SQL.slice(at, end + 2);
}

// The exact column list and VALUES the create route issues, so this cannot
// drift from the statement that actually runs in production.
const CREATE_SQL = (() => {
  const at = ROUTES_JS.indexOf('INSERT INTO recipes');
  assert.notStrictEqual(at, -1, 'the create INSERT was not found in routes/retail-recipes.js');
  return ROUTES_JS.slice(at, ROUTES_JS.indexOf('`', at));
})();

check('schema.sql still declares recipes.sku UNIQUE — the reason for all this', () => {
  assert.ok(/sku\s+TEXT\s+UNIQUE/.test(recipesDdl()),
    'recipes.sku is no longer UNIQUE; re-read whether the copy still needs a blank SKU');
});

// readBody's own rule, quoted rather than re-derived: '' becomes NULL, and
// SQLite permits any number of NULLs in a UNIQUE column. That is what lets a
// recipe be duplicated twice before either copy is given a SKU.
const asStoredSku = (sku) => (String(sku || '').trim() || null);

check('the copy INSERTs beside its source; carrying the SKU would have thrown', () => {
  const db = new Database(':memory:');
  db.exec(recipesDdl());
  const ins = db.prepare(CREATE_SQL);
  const row = (r) => [r.name_en, r.name_cn, asStoredSku(r.sku), r.category, r.batch_size,
                      r.servings, r.serving_size, r.batch_size_auto, r.servings_auto,
                      r.shelf_life, r.storage, r.notes, r.recipe_type];

  const src = sourceRecipe();
  ins.run(...row(src));

  // What the shipped duplicateOf produces goes in without complaint…
  const copy = duplicateOf(src);
  ins.run(...row(copy));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM recipes').get().n, 2);

  // …and a copy that HAD kept the SKU is the 400 this is all guarding against.
  const naive = { ...copy, sku: src.sku };
  assert.throws(() => ins.run(...row(naive)), /UNIQUE/,
    'a copy carrying the source SKU was accepted — the guard means nothing');

  // Two un-SKU'd copies of the same recipe are legal, because NULLs do not
  // collide. Duplicating twice before naming either must not fail.
  ins.run(...row(duplicateOf(src)));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM recipes').get().n, 3);
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The button on the row');
// ═══════════════════════════════════════════════════════════════════════════

const btnBox = {
  console,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  T: (en) => en,
  I: { copy: '<svg data-ico="copy"></svg>' },
};
vm.createContext(btnBox);
vm.runInContext(extractFunction(RECIPES_JS, 'function dupButton(') +
  '\nglobalThis.dupButton = dupButton;', btnBox);
const html = btnBox.dupButton({ id: 41 });

// The whole row is a click target (rcpRecordOpen). Without this, one click
// would open the source AND start a copy of it, and the copy would arrive
// underneath the record it was made from.
check('the click does not fall through to the row', () => {
  assert.ok(/event\.stopPropagation\(\)/.test(html), html);
});

check('it calls rcpDuplicate with the row\'s id', () => {
  assert.ok(/rcpDuplicate\(41\)/.test(html), html);
});

check('a duplicate is a create, so it is gated on recipes:edit', () => {
  assert.ok(/data-cap="recipes:edit"/.test(html), html);
});

// An icon with no accessible name is a button that cannot be described.
check('the icon carries a name, for the pointer and for a screen reader', () => {
  assert.ok(/title="Duplicate"/.test(html), html);
  assert.ok(/aria-label="Duplicate"/.test(html), html);
});

check('it is a type=button — never a form submit', () => {
  assert.ok(/type="button"/.test(html), html);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. The table still balances, and the control is reachable');
// ═══════════════════════════════════════════════════════════════════════════

const tableSrc = extractFunction(RECIPES_JS, 'function tableHtml(');

check('the header and the row have the same number of cells', () => {
  const head = tableSrc.slice(tableSrc.indexOf('<thead>'), tableSrc.indexOf('</thead>'));
  const body = tableSrc.slice(tableSrc.indexOf('<tr onclick'), tableSrc.indexOf('</tr>'));
  const ths = (head.match(/<th[\s>]/g) || []).length;
  const tds = (body.match(/<td[\s>]/g) || []).length;
  assert.strictEqual(ths, tds, `${ths} header cells against ${tds} row cells`);
});

check('the action column is in the row and in the header', () => {
  assert.ok(/rcp-actcell/.test(tableSrc), 'the row has no action cell');
  assert.ok(/rcp-actcol/.test(tableSrc), 'the header has no action column');
});

// This back office is worked on a phone as well as at a desk, and a control
// that only exists under a mouse pointer does not exist there at all. The base
// rule must set the button up on its own; :hover may only restyle it.
check('the button is styled by a base rule, not only on :hover', () => {
  assert.ok(/#tab-recipes \.rcp-rowact \{/.test(RECIPES_CSS),
    '.rcp-rowact has no base rule — is it hover-only?');
  assert.ok(/#tab-recipes \.rcp-rowact:hover/.test(RECIPES_CSS));
});

check('the base rule does not hide the button', () => {
  const at = RECIPES_CSS.indexOf('#tab-recipes .rcp-rowact {');
  const rule = RECIPES_CSS.slice(at, RECIPES_CSS.indexOf('}', at));
  assert.ok(!/display:\s*none|opacity:\s*0(?![.\d])|visibility:\s*hidden/.test(rule), rule);
});

// applyCapGates() writes display:'' / 'none' onto [data-cap] elements, so the
// button's own display has to come from the stylesheet or the gate cannot
// hand it back.
check('the base rule gives it a display for the cap gate to restore', () => {
  const at = RECIPES_CSS.indexOf('#tab-recipes .rcp-rowact {');
  const rule = RECIPES_CSS.slice(at, RECIPES_CSS.indexOf('}', at));
  assert.ok(/display:\s*inline-flex/.test(rule), rule);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. Every string is a live pair, none composed');
// ═══════════════════════════════════════════════════════════════════════════

const MARKETING_JS = read('public', 'retail-admin', '05-marketing.js');

// docs/tacet-consolidation-decisions.md §30 rule 3 / the vocabulary doc's Rule
// 4: a string composed here would have to be declared. None is — all three are
// copied verbatim from the popup manager's own duplicate action, which is where
// these operators have already met the word. If that source is reworded, this
// goes red and the two are reconciled deliberately rather than drifting apart.
[
  ["'Duplicate', '复制'", 'the button'],
  ["'Duplicated · edit the copy', '已复制 · 编辑副本'", 'the toast'],
].forEach(([pair, what]) => {
  check(`${what} uses a pair that is live in 05-marketing.js`, () => {
    assert.ok(RECIPES_JS.includes(pair), `19-recipes.js no longer carries ${pair}`);
    assert.ok(MARKETING_JS.includes(pair), `${pair} is no longer live in 05-marketing.js`);
  });
});

check('the name suffixes are the popup manager\'s, verbatim', () => {
  assert.ok(MARKETING_JS.includes("' (copy)', '(副本)'"),
    "05-marketing.js no longer carries the ' (copy)' / '(副本)' pair");
  assert.ok(/COPY_SUFFIX_EN\s*=\s*' \(copy\)'/.test(RECIPES_JS));
  assert.ok(/COPY_SUFFIX_CN\s*=\s*'\(副本\)'/.test(RECIPES_JS));
});

// The suffixes are STORED DATA read afterwards in both languages, so they must
// not be picked by whichever language the operator happened to be viewing in.
check('the suffixes are not run through T()', () => {
  const fn = extractFunction(RECIPES_JS, 'function duplicateOf(');
  assert.ok(!/T\(/.test(fn), 'duplicateOf translates something — the names are data, not UI');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + (failures ? `${failures} failed` : 'all assertions held'));
process.exit(failures ? 1 : 0);
