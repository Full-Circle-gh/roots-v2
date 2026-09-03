#!/usr/bin/env node
//
// test_recipe_unit_mismatch_warnings.js — the unit-mismatch warning, on both
// screens that were silent about it: the recipe editor at save time, and the
// Products list beside the margin it qualifies.
//
// WHAT THIS IS FOR
// ----------------
// lib/recipe-cost.js has excluded a line whose unit measures a different kind
// of thing than its material's stocking unit since the §7 addendum
// (docs/tacet-consolidation-decisions.md: no conversion without a stated
// factor — 160 ml of an oil stocked in grams needs a density, and there is no
// density to find). 82 live lines across 36 recipes are in that state. The
// recipe RECORD said so on its card. Two places said nothing at all:
//
//   * The person saving the line was told "Saved" and nothing else.
//   * The Products grid printed the resulting margin bare — and a cost missing
//     an ingredient always flatters, so it is the higher of the two numbers.
//
// Nothing here changes a quantity, a unit or a cost. Every assertion is about
// what is SAID about figures that were already being computed this way.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * The rule is lib/recipe-cost.js's own export, required directly, and
//     checked against buildLines() so the predicate and the counter cannot
//     drift.
//   * markRecipeUnitMismatch is LIFTED OUT of routes/retail.js and run in a vm
//     against a real in-memory database built from the shipped DDL.
//   * lineUnitMismatch / mismatchedLines are LIFTED OUT of
//     public/retail-admin/19-recipes.js the same way.
//   * The list cell is public/retail-admin/09-products.js, executed verbatim,
//     every assertion reading the HTML the shipped function returned.
//
// USAGE   node scripts/test_recipe_unit_mismatch_warnings.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT        = path.join(__dirname, '..');
const read        = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const DATABASE_JS = read('database.js');
const SCHEMA_SQL  = read('schema.sql');
const PRODUCTS_JS = read('public', 'retail-admin', '09-products.js');
const RECIPES_JS  = read('public', 'retail-admin', '19-recipes.js');
const RETAIL_JS   = read('routes', 'retail.js');
const RECIPES_CSS = read('public', 'retail-admin.css');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// Slice a named top-level function out of a shipped file, brace-matched, so
// what runs below is the source that ships rather than a copy of it. Anchored
// on the declaration alone — an anchor carrying surrounding lines breaks on a
// reformat and reports it as a missing feature.
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

// ═══════════════════════════════════════════════════════════════════════════
section('1. The rule is ONE rule, exported rather than re-derived');
// ═══════════════════════════════════════════════════════════════════════════

const RC = require('../lib/recipe-cost');

check('lib/recipe-cost.js exports the predicate the two screens ask', () => {
  assert.strictEqual(typeof RC.unitsReconcilable, 'function');
  assert.strictEqual(typeof RC.unitDimension, 'function');
});

check('ml against g is a mismatch; g against g is not', () => {
  assert.strictEqual(RC.unitsReconcilable('ml', 'g'), false);
  assert.strictEqual(RC.unitsReconcilable('g', 'g'), true);
  assert.strictEqual(RC.unitsReconcilable('kg', 'g'), true);
});

// Only a KNOWN mismatch blocks — an unrecognised unit has no dimension to
// disagree with and keeps the behaviour it has today. The warning must not
// widen the rule.
check('an unknown or blank unit is NOT accused', () => {
  assert.strictEqual(RC.unitsReconcilable('', 'g'), true);
  assert.strictEqual(RC.unitsReconcilable('splodge', 'g'), true);
  assert.strictEqual(RC.unitsReconcilable('g', null), true);
});

// The predicate and the counter must answer the same question about the same
// line, or a screen warns about a line the total did include (or worse, stays
// quiet about one it dropped).
check('the exported predicate agrees with buildLines() line for line', () => {
  const ing = [
    { qty: 160, unit: 'ml',  master_cost: 0.05, master_unit: 'g'   },  // mismatch
    { qty: 200, unit: 'g',   master_cost: 0.05, master_unit: 'g'   },  // fine
    { qty: 2,   unit: 'pcs', master_cost: 3,    master_unit: 'g'   },  // mismatch
    { qty: 1,   unit: 'tsp', master_cost: 1,    master_unit: 'ml'  },  // fine
  ];
  const built = RC.buildLines(ing);
  assert.strictEqual(built.unreconciledUnitLines, 2);
  built.lines.forEach((l, i) => assert.strictEqual(
    l.unreconciledUnit, !RC.unitsReconcilable(ing[i].unit, ing[i].master_unit),
    `line ${i} disagrees`));
});

// free_by_design outranks the unit question in buildLines(), so it must outrank
// it in every warning too — a line that costs nothing is excluded from nothing.
check('a free-by-design line is never counted as a mismatch', () => {
  const built = RC.buildLines([{ qty: 500, unit: 'ml', master_cost: 0, master_unit: 'g', master_free: 1 }]);
  assert.strictEqual(built.unreconciledUnitLines, 0);
  assert.strictEqual(built.lines[0].unreconciledUnit, false);
});

// The whole point of the mark: the figure it qualifies is the FLATTERING one.
check('a mismatched line is left out of the subtotal, so the cost reads low', () => {
  const withMismatch = RC.buildLines([
    { qty: 200, unit: 'g',  master_cost: 0.05, master_unit: 'g' },
    { qty: 160, unit: 'ml', master_cost: 0.50, master_unit: 'g' },
  ]);
  assert.strictEqual(withMismatch.ingredientCost, 10);   // the 80.00 never lands
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The Products list route flags the rows whose cost is short');
// ═══════════════════════════════════════════════════════════════════════════

const { openTablesDb, addTables, addForkedStoreProducts, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

function freshDb() {
  const db = openTablesDb(DATABASE_JS, []);
  addForkedStoreProducts(db, SCHEMA_SQL, DATABASE_JS);
  addTables(db, SCHEMA_SQL, DATABASE_JS, ['recipes', 'ingredients', 'recipe_ingredients']);
  addTables(db, DATABASE_JS, DATABASE_JS, ['product_build_lines']);
  return db;
}

// The shipped helper, lifted out of routes/retail.js and given exactly the two
// things it closes over. productionEnabled is stubbed per case because the
// settings table it reads is not part of this fixture; unitsReconcilable is the
// real export, so the RULE under test is never stubbed.
const MARK_FN = extractFunction(RETAIL_JS, 'function markRecipeUnitMismatch(db, rows)');
function runMark(db, rows, { production = true } = {}) {
  const sb = { unitsReconcilable: RC.unitsReconcilable, productionEnabled: () => production, Set, Array };
  vm.createContext(sb);
  vm.runInContext(MARK_FN + '\nthis.__run = markRecipeUnitMismatch;', sb, { filename: 'retail.js#markRecipeUnitMismatch' });
  sb.__run(db, rows);
  return rows;
}

let rseq = 0, iseq = 0, pseq = 0;
function recipe(db, name) {
  const id = ++rseq;
  db.prepare('INSERT INTO recipes (id, name_en) VALUES (?,?)').run(id, name);
  return id;
}
function material(db, name, unit, free) {
  const id = ++iseq;
  db.prepare('INSERT INTO ingredients (id, name_en, unit, cost_per_unit, free_by_design) VALUES (?,?,?,?,?)')
    .run(id, name, unit, 0.5, free ? 1 : 0);
  return id;
}
function rline(db, recipeId, ingredientId, qty, unit, name) {
  db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, name_en, qty, unit) VALUES (?,?,?,?,?)')
    .run(recipeId, ingredientId, name || 'line', qty, unit);
}
function product(db, name, recipeId) {
  const id = ++pseq;
  db.prepare('INSERT INTO store_products (id, name_en, sell_price, unit_cost, recipe_id) VALUES (?,?,?,?,?)')
    .run(id, name, 100, 20, recipeId == null ? null : recipeId);
  return { id, name_en: name, recipe_id: recipeId == null ? null : recipeId };
}

{
  const db = freshDb();
  const gram = material(db, 'Tahini', 'g');
  const oil  = material(db, 'Olive oil', 'g');
  const water = material(db, 'Water', 'g', true);

  const clean = recipe(db, 'All in grams');
  rline(db, clean, gram, 200, 'g');

  const dirty = recipe(db, 'One line in ml');
  rline(db, dirty, gram, 200, 'g');
  rline(db, dirty, oil, 160, 'ml');

  const freeOnly = recipe(db, 'The only odd line is free by design');
  rline(db, freeOnly, gram, 200, 'g');
  rline(db, freeOnly, water, 500, 'ml');

  const okRow    = product(db, 'Hummus 150g', clean);
  const badRow   = product(db, 'Zhoug 225g', dirty);
  const freeRow  = product(db, 'Hummus with water', freeOnly);
  const typedRow = product(db, 'Dried banana — typed cost', null);

  const rows = [okRow, badRow, freeRow, typedRow];
  runMark(db, rows);

  check('a product whose recipe holds a mismatched line is flagged', () =>
    assert.strictEqual(badRow.recipe_unit_mismatch, 1));
  check('a product whose recipe is clean grows no key at all', () =>
    assert.ok(!('recipe_unit_mismatch' in okRow), 'a clean row was flagged'));
  check('a free-by-design line is not a mismatch here either', () =>
    assert.ok(!('recipe_unit_mismatch' in freeRow), 'free_by_design was flagged'));
  check('a product with no recipe is never flagged', () =>
    assert.ok(!('recipe_unit_mismatch' in typedRow)));

  // recipeOwnsProductCost() is false with Production off — the figure came from
  // a purchase order or a person, and the recipe has nothing to say about it.
  check('Production off flags nothing', () => {
    const again = [{ ...badRow }];
    delete again[0].recipe_unit_mismatch;
    runMark(db, again, { production: false });
    assert.ok(!('recipe_unit_mismatch' in again[0]));
  });

  // §31's addendum: a build list owns the cost outright and recipe_id is not
  // consulted for it by anything. lib/product-build-cost.js already BLOCKS such
  // a product on an unreconciled build line, so it shows an em dash.
  check('a product with a build list is not flagged for its recipe', () => {
    const built = product(db, 'Zhoug jar — built', dirty);
    db.prepare('INSERT INTO product_build_lines (product_id, ingredient_id, name_en, qty, unit) VALUES (?,?,?,?,?)')
      .run(built.id, gram, 'Zhoug', 1, 'g');
    runMark(db, [built]);
    assert.ok(!('recipe_unit_mismatch' in built), 'a build-list product wore its recipe’s mark');
  });

  // applyBundleCost() has just overwritten unit_cost with the components' own,
  // so the figure in the cell is not this recipe's to complain about.
  check('a bundle is not flagged', () => {
    const bundle = { ...product(db, 'Gift set', dirty), is_bundle: true };
    runMark(db, [bundle]);
    assert.ok(!('recipe_unit_mismatch' in bundle), 'a bundle wore its recipe’s mark');
  });

  // A LEFT JOIN, so a line whose material was deleted still arrives — and
  // unitDimension(null) is null, which unitsReconcilable() reads as
  // reconcilable. The same escape buildLines() takes, so the list and the
  // recipe screen agree about that row.
  check('a line whose material was deleted is not invented into a mismatch', () => {
    const orphan = recipe(db, 'One line, no material');
    db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, name_en, qty, unit) VALUES (?,NULL,?,?,?)')
      .run(orphan, 'gone', 100, 'ml');
    const row = product(db, 'Orphan-lined product', orphan);
    runMark(db, [row]);
    assert.ok(!('recipe_unit_mismatch' in row));
  });

  // The catalogue is the screen. A warning must never be able to take it down.
  check('a database that cannot answer leaves the rows untouched', () => {
    const broken = { prepare() { throw new Error('no such table'); } };
    const row = { id: 1, recipe_id: 1 };
    runMark(broken, [row]);
    assert.deepStrictEqual(row, { id: 1, recipe_id: 1 });
  });
}

check('the products list route actually calls it', () => {
  const at = RETAIL_JS.indexOf('FROM store_products p WHERE COALESCE(is_active, 1) = 1');
  assert.notStrictEqual(at, -1, 'the products list query has moved');
  assert.ok(RETAIL_JS.slice(at).indexOf('markRecipeUnitMismatch(tdb(), rows)') > -1,
    'the list route does not flag its rows');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. The Products list paints the SAME mark, beside the same figure');
// ═══════════════════════════════════════════════════════════════════════════

const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, readOnly: false,
    style: {}, hidden: false, children: [], placeholder: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { if (c && c.id) nodes.set(c.id, c); this.children.push(c); return c; },
    insertAdjacentHTML(_p, h) { this.innerHTML += h; },
    closest: () => null, querySelector: () => makeNode(''), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}
function node(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); }

const sandbox = {
  console,
  document: {
    getElementById: id => node(id),
    querySelector: () => makeNode('q'),
    querySelectorAll: () => [],
    addEventListener() {}, createElement: () => makeNode(''),
    body: { classList: { contains: () => false, add() {}, remove() {} } },
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error('no network')),
  escapeHtml: s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  cuT: (en) => en,
  fmt: n => Number(n).toFixed(2),
  toast() {}, api: () => Promise.resolve({}), logActivity() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(PRODUCTS_JS, sandbox, { filename: '09-products.js' });

const marginCell = u => sandbox._paMarginCell(u);
const unit = (p, members) => (members ? { group: true, p, members } : { group: false, p });
const P = extra => ({ sell_price: 100, unit_cost: 20, ...extra });
const MARK = 'pa-mgn-warn';

// STEP 1's component, reused exactly — not a second visual style.
check('the mark is the same icon and class the cost_incomplete tag paints', () => {
  const tagged   = marginCell(unit(P({ cost_incomplete: 1 })));
  const mismatch = marginCell(unit(P({ recipe_unit_mismatch: 1 })));
  assert.ok(tagged.includes(MARK) && mismatch.includes(MARK), 'different classes');
  // PD_ICON_WARN is a module-scope const, so it never lands on the sandbox
  // global — take it out of the source and assert both cells carry that exact
  // markup. A second triangle drawn slightly differently would fail here.
  const icon = (PRODUCTS_JS.match(/const PD_ICON_WARN = '([^']+)'/) || [])[1];
  assert.ok(icon && icon.includes('<svg'), 'PD_ICON_WARN has moved');
  assert.ok(tagged.includes(icon) && mismatch.includes(icon),
    'the two marks do not share PD_ICON_WARN');
});

check('a flagged product keeps its figure AND carries the mark', () => {
  const html = marginCell(unit(P({ recipe_unit_mismatch: 1 })));
  assert.ok(html.includes('80.0%'), 'the figure was withheld — it must still show: ' + html);
  assert.ok(html.includes(MARK), 'no mark on a flagged row: ' + html);
});

check('an unflagged product renders exactly the cell it always did', () => {
  const html = marginCell(unit(P()));
  assert.ok(html.includes('80.0%') && !html.includes(MARK) && !html.includes('pa-mgn-flag'), html);
});

check('the mark says what it means, for a mouse and for a screen reader', () => {
  const html = marginCell(unit(P({ recipe_unit_mismatch: 1 })));
  assert.ok(/title="[^"]*UNIT MISMATCH[^"]*"/.test(html), 'no readable title: ' + html);
  assert.ok(/aria-label="[^"]*UNIT MISMATCH[^"]*"/.test(html), 'no aria-label: ' + html);
  assert.ok(/title="[^"]*left out[^"]*"/.test(html), 'the title does not say the cost is excluded');
  assert.ok(/title="[^"]*incomplete[^"]*"/.test(html), 'the title does not say the cost is incomplete');
});

// An em dash claims nothing, so there is nothing to qualify — the rule the
// cost_incomplete mark already keeps.
check('no cost, no mark — an em dash is not marked', () => {
  const html = marginCell(unit({ sell_price: 100, unit_cost: null, recipe_unit_mismatch: 1 }));
  assert.ok(html.includes('—') && !html.includes(MARK), html);
});

check('a variant family is marked when ANY member is flagged', () => {
  const members = [P(), P({ recipe_unit_mismatch: 1 })];
  assert.ok(marginCell(unit(members[0], members)).includes(MARK));
});

// Two triangles side by side read as a severity, not as two facts.
check('both reasons at once still paint ONE mark, carrying both sentences', () => {
  const html = marginCell(unit(P({ cost_incomplete: 1, recipe_unit_mismatch: 1 })));
  assert.strictEqual(html.split(MARK).length - 1, 1, 'the mark was painted twice: ' + html);
  assert.ok(/title="[^"]*not complete[^"]*UNIT MISMATCH[^"]*"/.test(html),
    'the one tooltip does not carry both reasons: ' + html);
});

check('the two-figure Meituan cell carries ONE mark, outside both rows', () => {
  const html = marginCell(unit(P({ recipe_unit_mismatch: 1, mt_revenue: 400, mt_units: 10 })));
  assert.strictEqual(html.split(MARK).length - 1, 1, 'painted twice: ' + html);
  assert.ok(html.indexOf(MARK) < html.indexOf('pa-mgn2'), 'the mark landed inside the rows: ' + html);
});

// The mark points at the product editor, which has to explain it.
check('the product editor pill explains the mark the list paints', () => {
  assert.ok(/unreconciled: c\.unreconciledUnitLines/.test(RETAIL_JS),
    'recipe-health does not report the count');
  assert.ok(PRODUCTS_JS.includes("Number(d.unreconciled)"),
    'the editor never reads the count');
  assert.ok(/pdCostPill\(cuT\('UNIT MISMATCH', '单位不符'\)/.test(PRODUCTS_JS),
    'no UNIT MISMATCH pill in the editor');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The recipe editor stops being silent at save time');
// ═══════════════════════════════════════════════════════════════════════════

// The shipped predicate and the shipped save-time list, lifted out of
// 19-recipes.js and run against the real exported rule.
const RCP_FNS = ['function lineUnitMismatch(l)', 'function mismatchedLines()', 'function lineMismatchTitle(l)']
  .map(d => extractFunction(RECIPES_JS, d)).join('\n');
function runRecipeFns(lines) {
  const sb = { COST: () => RC, T: (en) => en, _lines: lines, Number, String };
  vm.createContext(sb);
  vm.runInContext(RCP_FNS + '\nthis.__m = mismatchedLines; this.__one = lineUnitMismatch; this.__t = lineMismatchTitle;',
    sb, { filename: '19-recipes.js#lineUnitMismatch' });
  return sb;
}

{
  const lines = [
    { name_en: 'Tahini',    qty: 200, unit: 'g',  master_unit: 'g'  },
    { name_en: 'Olive oil', qty: 160, unit: 'ml', master_unit: 'g'  },
    { name_en: 'Water',     qty: 500, unit: 'ml', master_unit: 'g', master_free: 1 },
    { name_en: 'Lemon',     qty: 2,   unit: 'pcs', master_unit: 'g' },
  ];
  const sb = runRecipeFns(lines);

  check('the editor names exactly the mismatched lines, in order', () => {
    const bad = sb.__m();
    assert.deepStrictEqual(bad.map(x => x.l.name_en), ['Olive oil', 'Lemon']);
    assert.deepStrictEqual(bad.map(x => x.i), [1, 3]);
  });
  check('a matching line and a free-by-design line are left alone', () => {
    assert.strictEqual(sb.__one(lines[0]), false);
    assert.strictEqual(sb.__one(lines[2]), false);
  });
  // Three distinctions the locked vocabulary requires the copy to preserve:
  // UNKNOWN not missing, the LINE at fault not the material, INCOMPLETE not
  // wrong. Losing any one turns a refusal into a defect report.
  check('the line’s own message names both units, blames the line, and clears the material', () => {
    const t = sb.__t(lines[1]);
    assert.ok(t.includes('ml') && t.includes('g'), 'the two units are not named: ' + t);
    assert.ok(/NOT included/.test(t), 'it does not say the cost is excluded: ' + t);
    assert.ok(/material's own cost is fine/.test(t), 'it does not clear the material: ' + t);
    assert.ok(!/missing/i.test(t), 'it says "missing", which sends the fix to the wrong record: ' + t);
  });
  // A screen that cannot check must not accuse.
  check('with the shared module not loaded, nothing is accused', () => {
    const sbNo = { COST: () => null, T: (en) => en, _lines: lines, Number, String };
    vm.createContext(sbNo);
    vm.runInContext(RCP_FNS + '\nthis.__m = mismatchedLines;', sbNo, { filename: 'no-module' });
    assert.strictEqual(sbNo.__m().length, 0);
  });
}

// The save must go through. This is a warning, not a gate.
check('rcpSave warns AFTER the write and never blocks or converts', () => {
  const save = extractFunction(RECIPES_JS, 'window.rcpSave = async function ()');
  const putAt = save.indexOf("'/api/retail-admin/recipes/' + id");
  const warnAt = save.indexOf('mismatchedLines()');
  assert.ok(putAt > -1 && warnAt > putAt, 'the warning is not after the save');
  assert.ok(/Saved — but/.test(save), 'the sentence does not confirm the save first');
  assert.ok(/NOT included in this recipe's cost/.test(save), 'it does not say the cost is excluded');
  assert.ok(!/\.unit\s*=/.test(save), 'rcpSave assigns to a line unit — nothing may be auto-converted');
  assert.ok(!/return;[\s\S]{0,80}mismatch/i.test(save), 'the save returns early on a mismatch');
});

check('the same warning is on the line itself, refreshed without a repaint', () => {
  assert.ok(/class="rcp-line-warn" data-line=/.test(RECIPES_JS), 'no per-line slot in lineRow');
  const paint = extractFunction(RECIPES_JS, 'function paintLineWarns()');
  assert.ok(paint.includes('I.warn'), 'the line mark is not the shared triangle');
  assert.ok(/单位不符/.test(paint), 'the locked CN half of UNIT MISMATCH is not used');
  assert.ok(paint.includes("classList.toggle('is-unit-mismatch'"), 'the excluded figure is not struck');
  assert.ok(!/innerHTML = (ingredientsTab|stepsTab)/.test(paint), 'it repaints the tab under the operator');
  const rec = extractFunction(RECIPES_JS, 'window.rcpRecompute = function ()');
  assert.ok(rec.includes('paintLineWarns()'), 'a unit change does not re-mark the line');
});

check('the struck figure is display only — the CSS strikes it, nothing recomputes it', () => {
  assert.ok(/\.rcp-line\.is-unit-mismatch \.rcp-line-cost \{[^}]*line-through/.test(RECIPES_CSS),
    'no strike rule for an excluded line');
  assert.ok(/\.rcp-line-warn \{[^}]*--td-amber/.test(RECIPES_CSS.replace(/\n/g, ' ')),
    'the line mark is not amber');
});

// A stored unit outside RECIPE_UNITS() (an old/legacy value such as "L")
// matches none of the <option>s the select renders, so a browser marks none
// of them selected and falls back to showing the FIRST option — "g" — as if
// it had been chosen. An operator "fixing" the line by leaving that dropdown
// alone (because it already looks right) saves the SAME stale unit back out,
// which is exactly what made this recipe's mismatch pill outlive several
// rounds of edits. lineRow() must show the real stored value instead of
// letting the browser's default masquerade as one.
{
  const LINE_ROW_FN = extractFunction(RECIPES_JS, 'function lineRow(l, idx)');
  function runLineRow(l, idx) {
    const sb = {
      esc: (s) => String(s == null ? '' : s),
      T: (en) => en,
      moneyU: (n) => String(n),
      money: (n) => String(n),
      RECIPE_UNITS: () => ['g', 'ml', 'pcs'],
      I: { x: 'x' },
      Number, String,
    };
    vm.createContext(sb);
    vm.runInContext(LINE_ROW_FN + '\nthis.__row = lineRow;', sb, { filename: '19-recipes.js#lineRow' });
    return sb.__row(l, idx);
  }

  check('a line whose stored unit is not a recognised value renders it as its own selected option', () => {
    const html = runLineRow({ name_en: 'Real Thai Coconut Milk', qty: 4, unit: 'L', master_unit: 'g', master_cost: 0.05 }, 3);
    assert.ok(/<option value="L" selected>L<\/option>/.test(html),
      'the raw stored unit "L" is not rendered as its own selected option: ' + html);
    assert.ok(!/<option value="g" selected>/.test(html),
      'a recognised option was wrongly marked selected in place of the true stored value');
  });
  check('a line whose unit IS a recognised value renders exactly as before — no phantom option', () => {
    const html = runLineRow({ name_en: 'Shallot', qty: 320, unit: 'g', master_unit: 'g', master_cost: 0.03 }, 0);
    assert.strictEqual((html.match(/<option/g) || []).length, 3,
      'an extra option leaked in for a line whose unit is already valid: ' + html);
    assert.ok(/<option value="g" selected>/.test(html));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The Recipes LIST — the screen this is scanned from');
// ═══════════════════════════════════════════════════════════════════════════
//
// The record card's pill only speaks once a recipe is OPEN. The list is where
// an operator reads 100 costs in one pass, and it already paints a triangle for
// the OTHER way a cost comes out too low (an unpriced line). A recipe whose only
// fault was a unit mismatch sat here with a clean-looking cost column and
// nothing beside the name — which was exactly the silence this work exists to
// break, on the busiest of the three screens.

const RECIPES_ROUTE_JS = read('routes', 'retail-recipes.js');

// The route's row shape, checked against a real database rather than asserted
// from the source: computeRecipeCost already derives the figure, so the only
// thing that can go wrong is the row forgetting to carry it.
{
  const db = freshDb();
  const gram = material(db, 'Tahini', 'g');
  const oil  = material(db, 'Olive oil', 'g');
  const r = recipe(db, 'One line in ml');
  rline(db, r, gram, 200, 'g');
  rline(db, r, oil, 160, 'ml');
  const lines = db.prepare(`
    SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
           i.free_by_design AS master_free, i.name_en AS master_name_en
      FROM recipe_ingredients ri
      LEFT JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ?`).all(r);
  const c = RC.computeRecipeCost({ recipe: db.prepare('SELECT * FROM recipes WHERE id = ?').get(r), ingredients: lines, costData: null });

  check('the breakdown the list route already runs carries the count', () =>
    assert.strictEqual(c.unreconciledUnitLines, 1));
  check('the list row forwards it — no second query, no second rule', () => {
    const at = RECIPES_ROUTE_JS.indexOf('zeroCostIngredientLines: c.zeroCostIngredientLines');
    assert.notStrictEqual(at, -1, 'the recipes list row shape has moved');
    const row = RECIPES_ROUTE_JS.slice(at, at + 1400);
    assert.ok(row.includes('unreconciledUnitLines: c.unreconciledUnitLines'),
      'the list row does not carry unreconciledUnitLines');
    // It must come off the SAME breakdown, never a fresh SQL derivation.
    assert.ok(!/UNIT_DIMENSION|unitsReconcilable/.test(RECIPES_ROUTE_JS),
      'the list route re-derives the unit rule instead of reading the breakdown');
  });
}

// The list cell, executed. tableHtml() is private to the module's IIFE, so it
// is lifted out with the two helpers it calls and run against stubs — every
// assertion reads the HTML the shipped function returned.
{
  const LIST_FNS = ['function tableHtml()', 'function primaryCost(row)', 'function rowsInView()']
    .map(d => extractFunction(RECIPES_JS, d)).join('\n');
  const esc = s2 => String(s2 == null ? '' : s2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function listHtml(rows) {
    const sb2 = {
      _rows: rows, _type: '', _q: '', _cat: '',
      esc, T: (en) => en, dash: v => (v == null || v === '' ? '—' : v),
      money: n => '¥' + (Number(n) || 0).toFixed(2),
      moneyU: n => '¥' + (Number(n) || 0).toFixed(4),
      I: { warn: '<svg id="the-triangle"></svg>', book: '' },
      blockReasonText: () => '', Number, String,
    };
    vm.createContext(sb2);
    vm.runInContext(LIST_FNS + '\nthis.__t = tableHtml;', sb2, { filename: '19-recipes.js#tableHtml' });
    return sb2.__t();
  }
  const R = extra => ({ id: 1, name_en: 'Quinoa salad dressing', category: 'Homemade',
    batch_size: 432, servings: null, costPerGram: 0.0456, costPerServing: null,
    batchCost: 19.7, zeroCostIngredientLines: 0, unreconciledUnitLines: 0, ...extra });

  check('a recipe whose ONLY fault is a unit mismatch now carries the triangle', () => {
    const html = listHtml([R({ unreconciledUnitLines: 2 })]);
    assert.ok(html.includes('rcp-warnic'), 'no icon on a mismatched recipe: ' + html);
    assert.ok(/title="[^"]*UNIT MISMATCH[^"]*"/.test(html), 'the icon does not say why: ' + html);
  });

  check('a clean recipe still carries no icon at all', () => {
    assert.ok(!listHtml([R()]).includes('rcp-warnic'));
  });

  // The behaviour that was already there must be untouched, word for word.
  check('the missing-cost icon keeps its own count and its own sentence', () => {
    const html = listHtml([R({ zeroCostIngredientLines: 3 })]);
    assert.ok(/title="3 ingredient\(s\) missing cost — costs shown are too low"/.test(html),
      'the missing-cost wording changed: ' + html);
    assert.ok(!html.includes('UNIT MISMATCH'), 'a clean-unit recipe was accused: ' + html);
  });

  // Two triangles in a name cell read as a severity, not as two facts.
  check('both faults at once paint ONE triangle carrying both sentences', () => {
    const html = listHtml([R({ zeroCostIngredientLines: 1, unreconciledUnitLines: 2 })]);
    assert.strictEqual(html.split('rcp-warnic').length - 1, 1, 'painted twice: ' + html);
    assert.ok(/title="1 ingredient[^"]*too low · UNIT MISMATCH"/.test(html),
      'the one tooltip does not carry both, in the record card’s order: ' + html);
    assert.strictEqual(html.split('the-triangle').length - 1, 1, 'two icons in one cell: ' + html);
  });

  // The locked pair carries no count — the string has no slot for one, and
  // widening it here would be composing a variant of a locked pair.
  check('the locked string is copied whole, never given a count', () => {
    const html = listHtml([R({ unreconciledUnitLines: 7 })]);
    assert.ok(!/7[^"]*UNIT MISMATCH|UNIT MISMATCH[^"·]*7/.test(html),
      'a count was spliced into the locked pair: ' + html);
  });

  check('the icon is the same triangle the list already used', () => {
    assert.ok(listHtml([R({ unreconciledUnitLines: 1 })]).includes('the-triangle'));
  });

  // The list is the catalogue of recipes; a row must render whatever the field
  // says. An older cached payload has no such key.
  check('a row from a payload predating the field renders unmarked, not broken', () => {
    const r = R(); delete r.unreconciledUnitLines;
    const html = listHtml([r]);
    assert.ok(html.includes('Quinoa salad dressing') && !html.includes('rcp-warnic'), html);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. Every warning speaks Chinese in the Chinese UI');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE CHECK THAT WAS MISSING. Section 3 and 4 above run with cuT/T stubbed to
// return the ENGLISH half, so they pass whether or not a Chinese half exists —
// which is exactly how four tooltips shipped reading English to the half of the
// room that reads Chinese. These run the same shipped functions with the
// language flipped and assert the output actually CHANGED.
//
// A pair is proved by three things together: the Chinese differs from the
// English, it contains Han characters, and it is not merely the English with a
// locked label bolted on the front.
const HAN = /[\u4e00-\u9fff]/;
function assertRealPair(label, en, cn) {
  assert.notStrictEqual(cn, en, `${label}: the Chinese half is the English string`);
  assert.ok(HAN.test(cn), `${label}: the Chinese half has no Chinese in it — ${cn}`);
  // The English sentence must not be sitting inside the Chinese one. Compared on
  // the longest English clause rather than the whole string, so a shared unit
  // token like "ml" or a name cannot mask a copy-paste.
  const clause = en.split(/[.。]/).map(x => x.trim()).sort((a, b) => b.length - a.length)[0];
  if (clause && clause.length > 25) {
    assert.ok(!cn.includes(clause), `${label}: the English sentence is embedded in the Chinese`);
  }
}

// ── The recipe record's per-line tooltip and its save-time sentence ──────────
{
  const line = { name_en: 'Olive oil', qty: 160, unit: 'ml', master_unit: 'g' };
  function titleIn(lang) {
    const sb2 = { COST: () => RC, T: (en, cn) => (lang === 'cn' ? cn : en), _lines: [line], Number, String };
    vm.createContext(sb2);
    vm.runInContext(RCP_FNS + '\nthis.__t = lineMismatchTitle;', sb2, { filename: 'lineMismatchTitle' });
    return sb2.__t(line);
  }
  check('the ingredient line’s tooltip has a real Chinese half', () =>
    assertRealPair('lineMismatchTitle', titleIn('en'), titleIn('cn')));

  check('the Chinese names the same two units the English does', () => {
    const cn = titleIn('cn');
    assert.ok(cn.includes('ml') && cn.includes('g'), 'the units are missing: ' + cn);
  });

  // 无法换算 was CONSIDERED AND REJECTED when the label pair was minted — it
  // says impossible, and a recorded density will settle the volume↔mass cases.
  // 待换算 was rejected for the mirror reason. Neither may reappear in the
  // explanation, or the copy reopens a decision the vocabulary closed.
  check('the Chinese avoids the two phrasings the vocabulary rejected', () => {
    const cn = titleIn('cn');
    assert.ok(!cn.includes('无法换算'), '无法换算 was rejected — it overstates: ' + cn);
    assert.ok(!cn.includes('待换算'), '待换算 was rejected — it implies a remedy: ' + cn);
  });

  // The three distinctions the locked entry requires, in the Chinese as well as
  // the English: the cost is UNKNOWN not missing, the LINE is at fault not the
  // material, the total is INCOMPLETE not wrong.
  check('the Chinese keeps the line at fault and clears the material', () => {
    const cn = titleIn('cn');
    assert.ok(cn.includes('不计入'), 'it does not say the cost is left out: ' + cn);
    assert.ok(cn.includes('该物料本身的成本没有问题'), 'it does not clear the material: ' + cn);
    assert.ok(!cn.includes('缺少成本'), '缺少成本 means MISSING cost — the wrong record: ' + cn);
  });
}

// ── The Products list mark ──────────────────────────────────────────────────
{
  function markIn(lang, p) {
    const saved = sandbox.cuT;
    sandbox.cuT = (en, cn) => (lang === 'cn' ? cn : en);
    try { return sandbox._paMarginWarn({ group: false, p }); } finally { sandbox.cuT = saved; }
  }
  const titleOf = html => (html.match(/title="([^"]*)"/) || [])[1] || '';

  check('the list mark’s tooltip has a real Chinese half', () => {
    const p = { recipe_unit_mismatch: 1 };
    assertRealPair('_paMarginWarn/mismatch', titleOf(markIn('en', p)), titleOf(markIn('cn', p)));
  });

  // This one had been English-only since the cost_incomplete tag shipped, a day
  // before any of this. It shares the tooltip, and half a tooltip in Chinese is
  // worse than none.
  check('the older cost_incomplete sentence got its Chinese too', () => {
    const p = { cost_incomplete: 1 };
    assertRealPair('_paMarginWarn/incomplete', titleOf(markIn('en', p)), titleOf(markIn('cn', p)));
  });

  // Joined AFTER translation, or a cell carrying both reasons gets one sentence
  // of each language.
  check('both reasons at once give TWO Chinese sentences, no English left', () => {
    const cn = titleOf(markIn('cn', { cost_incomplete: 1, recipe_unit_mismatch: 1 }));
    assert.ok(cn.includes('单位不符') && cn.includes('成本不完整'), 'a reason is missing: ' + cn);
    assert.ok(!/[a-z]{6,}/.test(cn), 'an English clause survived the join: ' + cn);
  });
}

// ── The save toast and the product editor pill ──────────────────────────────
// Read off the source: both are composed inside async/DOM-bound functions that
// a vm cannot drive without a live editor. The assertion is that each carries a
// Chinese half at all — the shape the four bugs shared was a `T(x, x)` /
// `cuT(x, x)` call passing the SAME string twice.
{
  const RECIPES_SRC = read('public', 'retail-admin', '19-recipes.js');
  const PRODUCTS_SRC = read('public', 'retail-admin', '09-products.js');

  check('no warning string passes the same variable as both halves', () => {
    for (const [name, src] of [['19-recipes.js', RECIPES_SRC], ['09-products.js', PRODUCTS_SRC]]) {
      const dup = src.match(/\b(?:cuT|T)\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)/g) || [];
      assert.deepStrictEqual(dup, [], `${name} still has English-on-both-halves: ${dup.join(', ')}`);
    }
  });

  check('the save toast carries a Chinese sentence', () => {
    const save = extractFunction(RECIPES_SRC, 'window.rcpSave = async function ()');
    assert.ok(HAN.test(save), 'rcpSave has no Chinese at all');
    assert.ok(save.includes('单位不符'), 'the toast does not carry the locked label in Chinese');
    assert.ok(/toast\(T\(en, cn\)/.test(save), 'the toast is not given both halves');
  });

  check('the product editor pill carries a Chinese sentence', () => {
    assert.ok(/cuT\(tail, tailCn\)/.test(PRODUCTS_SRC), 'the pill tail has no Chinese half');
    assert.ok(PRODUCTS_SRC.includes('本配方中有'), 'the pill’s Chinese sentence is missing');
  });
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
