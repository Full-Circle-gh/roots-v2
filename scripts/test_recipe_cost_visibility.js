#!/usr/bin/env node
/**
 * `recipes:costs` — the cost and margin gate on the Recipes screen.
 *
 *   node scripts/test_recipe_cost_visibility.js
 *
 * FOURTH of the bundles that split money out of a "view" capability (waste,
 * materials, products — Ash, 2026-09-02/03; recipes — §164, 2026-09-17).
 *
 * `recipes:view` was the ONLY view key in lib/capabilities.js carrying
 * money:'shows', justified by the note "A recipe is a cost." That sentence was
 * true of the screen as it stood, which is why the coin was on the wrong KEY
 * rather than simply wrong: with nothing else to carry it, opening Recipes at
 * all was seeing money, and a kitchen operator could not be handed the
 * ingredients and the steps without also being handed the batch cost, the cost
 * per gram, and the margin on every product the recipe makes.
 *
 * WHY THIS TESTS A REGISTRY AND A CLIENT FILE RATHER THAN A ROUTE.
 * Its three siblings each gate a payload: the server declines to SEND the
 * figure. This one does not, and deliberately — lib/cap-routes.js opens every
 * GET, and §164's "what this does not decide" leaves the server side to its own
 * decision rather than answering it in passing. So the contract here is in two
 * halves and both are asserted:
 *
 *   REGISTRY — the key exists, carries the coin, and `recipes:view` no longer
 *              does; no floor preset holds either; admin and manager do.
 *   CLIENT   — public/retail-admin/19-recipes.js gates every money surface on
 *              it, through one fail-closed helper rather than per call site.
 *
 * The client half is asserted against SOURCE because these are DOM decisions in
 * a 3,000-line IIFE with no seam to mount — the same reason
 * test_role_editor_client.js reads its screen rather than driving it. The
 * assertions name the helper and the surfaces, so a regression that deletes a
 * gate fails here even though nothing renders.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const caps = require('../lib/capabilities');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const absent  = (o, k, m) => (o && !(k in o) ? ok(m) : bad(m, k + ' is present: ' + JSON.stringify(o && o[k])));
const present = (o, k, m) => (o && (k in o) ? ok(m) : bad(m, k + ' is missing'));
const truthy = (v, m) => (v ? ok(m) : bad(m, 'got ' + JSON.stringify(v)));
const falsy  = (v, m) => (!v ? ok(m) : bad(m, 'expected nothing, got ' + JSON.stringify(v)));
const section = (t) => console.log('\n' + t);

const capOf = (key) => caps.CAPABILITIES.find(c => c.key === key) || null;

// ═══ 1. THE REGISTRY ═══════════════════════════════════════════════════════
section('The capability itself');

const view  = capOf('recipes:view');
const costs = capOf('recipes:costs');
const edit  = capOf('recipes:edit');

truthy(view,  '`recipes:view` is registered');
truthy(costs, '`recipes:costs` is registered');
truthy(edit,  '`recipes:edit` is registered');

falsy(view && view.money, '`recipes:view` carries NO money mark — opening a recipe is not seeing money');
is(costs && costs.money, 'shows', '`recipes:costs` carries money:\'shows\'');
is(costs && costs.section, 'recipes', '`recipes:costs` files under the recipes section');
is(costs && costs.group, 'run', '`recipes:costs` sits in the run group, beside its siblings');

// The pair is bilingual like every other row in the registry; §164 records
// where both halves were lifted from.
is(costs && costs.labelEn, 'See recipe cost & margin', 'English label is the products:costs pair with its noun swapped');
is(costs && costs.labelCn, '查看食谱成本与毛利', 'Chinese label likewise (查看 · 食谱 · 成本与毛利, every character lifted)');

section('The note that justifies the coin moved with it');
falsy(caps.MONEY_NOTES['recipes:view'], '"A recipe is a cost." is gone from `recipes:view`');
truthy(caps.MONEY_NOTES['recipes:costs'], '`recipes:costs` carries a note of its own');
is(
  caps.MONEY_NOTES['recipes:costs'],
  ['Recipes show batch cost, cost per gram and margin.', '食谱显示整批成本、每克成本与毛利。'],
  'the note names the three figures the key withholds, in both languages',
);

// MONEY_KEYS is derived from the marks, so it is the thing the role editor
// actually paints a coin from. Asserted separately: a mark that does not reach
// this set is a mark nobody assigning a role ever sees.
section('What the role editor paints a coin on');
// MONEY_KEYS is a map of key → 'shows' | 'moves', derived from the marks above.
is(caps.MONEY_KEYS['recipes:costs'], 'shows', '`recipes:costs` reaches MONEY_KEYS as a shows');
falsy(caps.MONEY_KEYS['recipes:view'], '`recipes:view` no longer appears in MONEY_KEYS at all');

// ═══ 2. WHO HOLDS IT ═══════════════════════════════════════════════════════
section('Presets');

// admin and manager are ALL_KEYS filters excluding three named keys, so a new
// key joins them on the deploy that mints it. §164 leans on exactly this when
// it says the blast radius is only the by-name grants.
for (const role of ['admin', 'manager']) {
  const held = caps.presetCapsFor(role);
  const set = held === '*' ? null : new Set(held);
  truthy(set === null || set.has('recipes:costs'), `${role} picks \`recipes:costs\` up automatically`);
}

// owner resolves to everything by a named branch rather than by listing.
const ownerCaps = caps.presetCapsFor('owner');
truthy(ownerCaps === '*' || new Set(ownerCaps).has('recipes:costs'), 'owner holds it');

// The floor presets are the point of the split: none of them reads a recipe at
// all today, and minting a costs key must not quietly hand one to them.
for (const role of ['staff', 'store_manager', 'warehouse']) {
  const held = caps.presetCapsFor(role);
  const set = new Set(held === '*' ? caps.ALL_KEYS : held);
  falsy(set.has('recipes:costs'), `${role} does NOT hold \`recipes:costs\``);
  falsy(set.has('recipes:view'),  `${role} does NOT hold \`recipes:view\` either — unchanged by this split`);
}

// ═══ 3. THE SCREEN ═════════════════════════════════════════════════════════
section('The client gate (public/retail-admin/19-recipes.js)');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '19-recipes.js'), 'utf8');

truthy(/const showMoney = \(\) =>/.test(src), 'the screen has one showMoney() helper rather than a check per call site');
truthy(/CAPS\.has\('recipes:costs'\)/.test(src), 'it asks for `recipes:costs` by name');

// FAILS CLOSED. can() one file over answers true on a null cap set so a
// resolution hiccup never locks an operator out of their own app; money
// inverts that trade, and this is the assertion that keeps it inverted.
truthy(
  /const showMoney = \(\) => \(typeof CAPS !== 'undefined' && CAPS !== null\)\s*\?\s*CAPS\.has\('recipes:costs'\)\s*:\s*false;/.test(src),
  'showMoney() FAILS CLOSED — an unknown cap set hides money, it does not reveal it',
);
falsy(/can\('recipes:costs'\)/.test(src), 'it never routes the money question through fail-open can()');

section('Every money surface is behind it');

// The Cost & Pricing sub-tab: not rendered at all, and unreachable by hand.
truthy(/function subtabsFor\(\)[\s\S]{0,200}showMoney\(\) \? SUBTABS : SUBTABS\.filter/.test(src),
  'the Cost & Pricing tab is filtered out of the sub-nav');
truthy(/subnav\.innerHTML = subtabsFor\(\)/.test(src),
  'the sub-nav paints from the filtered list, not the raw one');
truthy(/if \(t === 'cost' && !showMoney\(\)\) return;/.test(src),
  'rcpSubtab(\'cost\') refuses the tab when called by hand');
truthy(/\$\{showMoney\(\) \? `<div class="rcp-subbody" data-t="cost"/.test(src),
  'the cost body is never built, so its figures are not in the DOM to read');
truthy(/function subtabSafe\(\)[\s\S]{0,160}_subtab = 'details'/.test(src),
  'a record carried onto the Cost tab falls back to Details rather than opening blank');

// The list's two money columns — removed, not dashed.
truthy(/const withCost = showMoney\(\);\s*\n\s*const rows = view\.map/.test(src),
  'the list decides once, above the row map');
truthy(/\$\{withCost \? `<td class="right rcp-num rcp-fit">\$\{costCell\}<\/td>/.test(src),
  'the Cost and Cost-per-gram CELLS are dropped');
truthy(/\$\{withCost \? `<th class="right rcp-fit">\$\{esc\(T\('Cost', '成本'\)\)\}<\/th>/.test(src),
  'and their HEADERS with them — a dash would read as "no figure for this recipe"');

// Per-line money on the Ingredients tab, and the picker that feeds it.
truthy(/function lineCostText\(l\) \{[\s\S]{0,400}if \(!showMoney\(\)\) return '';/.test(src),
  'an ingredient line\'s cost is blank, not dashed');
truthy(/function linePerText\(l\) \{\s*\n\s*if \(!showMoney\(\)\) return '';/.test(src),
  'the material\'s own rate on that line likewise');
truthy(/<span class="s">\$\{!showMoney\(\) \? '' : \(m\.cost_per_unit > 0 \? moneyU\(m\.cost_per_unit\) \+ '\/' \+ esc\(m\.unit/.test(src),
  'the material picker does not price its candidates');

// The record header strip, the linked material, the products strip.
truthy(/let html = showMoney\(\) \? `<div class="rcp-sumrow">/.test(src),
  'the record\'s summary row of figures is not built');
truthy(/const costTxt = !showMoney\(\) \? ''/.test(src),
  'the linked material keeps its name and loses its rate');
truthy(/\(withCost \? `<span class="marg\$\{cls\}">\$\{fig\}<\/span>` : ''\)/.test(src),
  'the margin beside each product goes');
truthy(/<span class="sells">\$\{esc\(price\)\}<\/span>/.test(src),
  'the SELL PRICE stays — it is what a customer is charged, not what this key withholds');

// The two modals and the archive warning.
truthy(/const cost = \(showMoney\(\) && m\.cost_per_unit > 0\)/.test(src),
  'the archive warning keeps its warning and drops its figure');
truthy(/row\(T\('Sell price', '售价'\), showMoney\(\) && cd\.sell_price/.test(src),
  'version history omits its two money rows');
truthy(/\$\{!showMoney\(\) \? '' : \(m\.cost_per_unit > 0 \? moneyU\(m\.cost_per_unit\) \+ '\/g'/.test(src),
  'the materialize picker does not price its candidates either');

section('What deliberately stays');

// The diagnosis is not the figure. 18-materials.js makes the same call in the
// same words: hiding a fault is how it stays unfixed.
truthy(/ingredient\$\{c\.zeroCostIngredientLines === 1 \? '' : 's'\} missing cost/.test(src),
  'the "N ingredients missing cost" pill still paints — it carries a count and a cause, never an amount');
truthy(/'UNIT MISMATCH', '单位不符'/.test(src),
  'the locked UNIT MISMATCH pair still paints');

// ═══ 4. THE WIRE ═══════════════════════════════════════════════════════════
//
// §164 shipped the screen gate and recorded that it had deliberately not gated
// the wire. Ash asked for the gap closed, so these are the rules that close it —
// lib/recipe-cost-visibility.js, extracted from the route for exactly this
// reason, the way lib/product-cost-visibility.js was.
const V = require('../lib/recipe-cost-visibility');

section('The gate on the wire');
const reqWith    = { caps: new Set(['recipes:view', 'recipes:costs', 'recipes:edit']) };
const reqWithout = { caps: new Set(['recipes:view', 'recipes:edit']) };

truthy(V.canSeeCosts(reqWith), 'a caller holding `recipes:costs` may read money');
falsy(V.canSeeCosts(reqWithout), 'one holding view and edit but not costs may not');
falsy(V.canSeeCosts({ caps: null }), 'FAILS CLOSED on a null cap set — a degraded request is not a grant');
falsy(V.canSeeCosts({}), 'and on a request with no caps at all');
falsy(V.canSeeCosts(undefined), 'and on no request at all');

section('A list row');
const listRow = () => ({
  id: 7, name_en: 'Quinoa Salad', name_cn: '藜麦沙拉', sku: 'RCP-7', category: 'Homemade',
  batch_size: 3179, servings: 12, recipe_type: 'made', is_active: 1,
  batchCost: 127.07, costPerServing: 10.59, costPerGram: 0.04,
  zeroCostIngredientLines: 2, unreconciledUnitLines: 1,
  backsMaterial: { id: 3, name_en: 'Quinoa base', cost_per_unit: 0.04, unit: 'g' },
});
const stripped = V.stripListRow(listRow());
absent(stripped, 'batchCost', 'batchCost is gone');
absent(stripped, 'costPerServing', 'costPerServing is gone');
absent(stripped, 'costPerGram', 'costPerGram is gone');
absent(stripped.backsMaterial, 'cost_per_unit', 'the linked material\'s rate is gone with them');

// DELETED, NOT ZEROED — the rule all three gates share. A 0 reads as free.
is(stripped.batchCost, undefined, 'and it is DELETED, not zeroed — a 0 would read as free');

present(stripped, 'name_en', 'the recipe\'s name survives');
present(stripped, 'batch_size', 'its batch size survives — a weight is not money');
present(stripped, 'servings', 'its servings likewise');
present(stripped.backsMaterial, 'name_en', 'the material keeps its name');
is(stripped.zeroCostIngredientLines, 2, 'the missing-cost COUNT survives — it is a count and a cause, never an amount');
is(stripped.unreconciledUnitLines, 1, 'the unit-mismatch count survives for the same reason');

// The original must not be mutated: the route maps over rows it may also serve
// to a caller who IS allowed them.
const original = listRow();
V.stripListRow(original);
is(original.batchCost, 127.07, 'the caller\'s own row is not mutated — the strip copies');

section('The computed cost object');
// Every key computeRecipeCost() returns today, so a money key added later is
// caught by the allow-list rather than leaking past a deny-list.
const fullCost = {
  recipe_id: 7, hasCostRow: 1, costDataUpdatedAt: '2026-09-17', sku: 'RCP-7',
  name_en: 'Quinoa Salad', name_cn: '藜麦沙拉', category: 'Homemade',
  servings: 12, batchSize: 3179, batchSizeAuto: 1, servingsAuto: 1, servingsLeftover: 0, yield: {},
  ingredientCost: 100, ingredientLines: 7, zeroCostIngredientLines: 2, unreconciledUnitLines: 1,
  lines: [{ cost: 12 }],
  labour: 10, packaging: 2, packagingTotal: 4, overheadPct: 15, overheadAmount: 17,
  embeddedOverhead: 1, overheadBase: 110, sellPrice: 38, targetFoodCost: 30,
  batchCost: 127.07, costPerServing: 10.59, costPerGram: 0.04,
  materialBatchCost: 120, materialCostPerGram: 0.038,
  marginPerServing: 27.41, foodCostPct: 27.8, suggestedSellPrice: 35.3,
};
const safeCost = V.stripCostObject(fullCost);

for (const k of ['ingredientCost', 'labour', 'packaging', 'packagingTotal', 'overheadAmount',
                 'embeddedOverhead', 'overheadBase', 'sellPrice', 'batchCost', 'costPerServing',
                 'costPerGram', 'materialBatchCost', 'materialCostPerGram', 'marginPerServing',
                 'suggestedSellPrice', 'lines']) {
  absent(safeCost, k, `${k} is gone`);
}
// The three that carry no currency sign and are still cost.
absent(safeCost, 'overheadPct', 'overheadPct goes — a percentage of cost is cost');
absent(safeCost, 'targetFoodCost', 'targetFoodCost goes — it is a costing input');
absent(safeCost, 'foodCostPct', 'foodCostPct goes — against a known price it IS the cost');

for (const k of ['batchSize', 'servings', 'ingredientLines', 'zeroCostIngredientLines',
                 'unreconciledUnitLines', 'name_en', 'yield']) {
  present(safeCost, k, `${k} survives`);
}

// THE ALLOW-LIST IS THE POINT: a money key invented tomorrow must not ride out.
const withNewMoneyKey = V.stripCostObject({ ...fullCost, someNewMarginFigure: 99 });
absent(withNewMoneyKey, 'someNewMarginFigure',
  'a money key added to computeRecipeCost() LATER does not leak — the list allows, it does not deny');

is(V.stripCostObject(null), null, 'a null cost object passes through untouched');

section('An ingredient line, and a product');
const line = V.stripLine({ id: 1, ingredient_id: 4, qty: 1200, unit: 'g', notes: 'rinse',
                           master_cost: 0.012, master_unit: 'g', master_name_en: 'Quinoa' });
absent(line, 'master_cost', 'the material\'s rate is gone from the line');
is(line.qty, 1200, 'the quantity stays — it is the recipe, not its price');
is(line.unit, 'g', 'the unit stays');
present(line, 'master_name_en', 'the material\'s name stays');

const prod = V.stripProduct({ id: 9, name_en: 'Quinoa Salad 150g', size: '150g',
                              sell_price: 38, unit_cost: 10.59, build_line_count: 0 });
absent(prod, 'unit_cost', 'the product\'s unit cost is gone');
is(prod.sell_price, 38,
  'THE SELL PRICE SURVIVES — it is what a customer is charged, not what this key withholds');
is(prod.build_line_count, 0, 'and the build-line count, which is a count');

section('The write that would have wiped what it cannot see');
// draftCostData() reads the Cost & Pricing inputs out of the DOM, and §164
// stopped rendering that tab for these operators: v() returns null for an
// element that is not there, parseFloat(null) || 0 is 0, and an ordinary
// autosave after a NAME correction sent {labour: 0, overhead_pct: 0,
// sell_price: 0, target_food_cost: 30}. Both halves are asserted because
// neither alone is enough — the client stops sending it, and the route refuses
// it anyway for a tab left open across the deploy, a retry, or a hand-rolled
// request.
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail-recipes.js'), 'utf8');
truthy(/recipes_costs_required/.test(routeSrc),
  'PUT /:id/cost refuses a caller without `recipes:costs`');
truthy(/if \(!canSeeCosts\(req\)\) \{[\s\S]{0,40}return res\.status\(403\)/.test(routeSrc),
  'it refuses with 403 — the one write here where every column is money');

truthy(/if \(showMoney\(\)\) \{[\s\S]{0,260}recipes\/' \+ recipeId \+ '\/cost'/.test(src),
  'and the client does not make the request at all rather than sending zeros');

// The trap worth naming: omitting the keys would NOT have been enough.
const writerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recipe-cost-data-write.js'), 'utf8');
truthy(/an absent `labour` still writes 0/.test(writerSrc),
  'the writer still grants preserve-on-absent to packaging_type_id ALONE — omitting keys is not a fix, and this is the line that says so');

section('The reads refuse a field, never a request');
truthy(/costs_hidden: true/.test(routeSrc),
  'the envelope says so, so a client can tell "withheld" from "there was none"');
const four = (routeSrc.match(/costs_hidden: true/g) || []).length;
truthy(four >= 3, `every gated read carries the flag (${four} sites)`);
falsy(/status\(403\)[\s\S]{0,120}recipes_costs_required[\s\S]{0,400}router\.get/.test(routeSrc),
  'no GET in the file 403s for lacking the capability');

console.log('\n' + (fail ? `✗ ${fail} failed, ${pass} passed` : `✓ all ${pass} passed`));
process.exit(fail ? 1 : 0);
