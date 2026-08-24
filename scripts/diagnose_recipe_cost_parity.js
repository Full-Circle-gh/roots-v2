#!/usr/bin/env node
/**
 * diagnose_recipe_cost_parity.js — THE GATE for the recipe-cost consolidation.
 *
 * Step 1 of that work is defined as producing NO VISIBLE CHANGE: three browser
 * copies of the recipe cost formula (viewRecipe, renderCS, csUpdate) stop
 * carrying their own maths and call lib/recipe-cost.js instead. The claim is
 * that every number on every screen stays identical. This proves or disproves
 * that claim against LIVE data before the change is merged.
 *
 * HOW IT PROVES IT
 * ----------------
 * The three OLD formulas are transcribed VERBATIM below, from
 * `git show origin/main:public/app.html` at the lines named on each block. They
 * are frozen literal copies — deliberately NOT refactored, NOT tidied, NOT
 * sharing a helper — because the whole point is to compare the new shared
 * module against exactly what production runs today, not against a cleaned-up
 * idea of it. If a later reader "improves" the OLD_* functions in this file,
 * this script stops testing anything.
 *
 * Then, for EVERY recipe in the database (all of them, active and archived —
 * archived recipes can be restored, and the export reads them too):
 *   1. load the same rows GET /api/recipes/:id serves, with the same SQL
 *   2. run each OLD formula over them
 *   3. run the NEW shared module over them
 *   4. compare every intermediate value AND the rendered string a user sees
 *      (¥xx.xx / xx.x% / — ), because the rendered form is the actual promise
 *
 * Any single mismatch fails the run with a nonzero exit. There is no tolerance
 * band: this is the same arithmetic in the same order on the same inputs, so
 * the answer must be bit-identical, not close.
 *
 * csUpdate's DOM ROUND TRIP IS SIMULATED, NOT SKIPPED
 * ---------------------------------------------------
 * csUpdate() reads <input> values, which are always strings, and the Cost
 * Sheet writes those inputs as `value="${cd.labour||''}"` /
 * `value="${cd.target_food_cost||30}"`. That round trip can change a value —
 * `'0' || 30` is '0' where `0 || 30` is 30 — so it is reproduced here field by
 * field rather than assumed away. This is the path that would break if the new
 * code passed raw input.value into the shared module.
 *
 * READ-ONLY, and it proves it on the connection: the database is opened with
 * readonly:true and a write is attempted and required to fail before anything
 * else runs. Same contract as every other diagnose_* script here.
 *
 * Run via .github/workflows/ro-query.yml, which stages THIS CHECKOUT's lib/ on
 * the box and points ROOTS_HOME at it — so the NEW module under test is the one
 * in the commit being gated, not whatever is deployed.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without comparing anything.');
  process.exit(2);
}

// The module under test — the NEW shared derivation, from the staged checkout.
const RECIPE_COST_PATH = path.join(HOME, 'lib', 'recipe-cost.js');
const { computeRecipeCost } = require(RECIPE_COST_PATH);

console.log('db:            ' + DB_PATH);
console.log('module under test: ' + RECIPE_COST_PATH);
console.log('run at (UTC):  ' + new Date().toISOString());
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// THE OLD FORMULAS — frozen verbatim. Do not refactor. See header.
// ════════════════════════════════════════════════════════════════════════════

// origin/main public/app.html:6483-6505 — viewRecipe()
function OLD_viewRecipe(rec, ings) {
  let ingTotal = 0, missingCount = 0;
  const ingRows = ings.map(i => {
    const free = !!i.master_free;
    const cpu = i.master_cost || 0;
    const line = free ? 0 : (cpu > 0 ? i.qty * cpu : null);
    if (line === null) missingCount++;
    else ingTotal += line;
    return { ...i, cpu, line, free };
  });
  const costData = rec.costData || {};
  const labour = parseFloat(costData.labour || 0);
  const packaging = parseFloat(costData.packaging || 0);
  const overhead = parseFloat(costData.overhead_pct || 0);
  const servings = parseFloat(rec.servings || 0);
  const packTotal = packaging * (servings > 0 ? servings : 1);
  const batchCost = ingTotal + labour + packTotal + (ingTotal * overhead / 100);
  const cpServ = servings > 0 ? batchCost / servings : null;
  const sellPrice = parseFloat(costData.sell_price || 0);
  const margin = (sellPrice > 0 && cpServ !== null) ? sellPrice - cpServ : null;
  const foodCostPct = (sellPrice > 0 && cpServ !== null) ? cpServ / sellPrice * 100 : null;
  // The With/No-packaging card, app.html:6568-6572 — derived from the same values.
  const overheadCost = ingTotal * overhead / 100;
  const batchNoPkg = ingTotal + labour + overheadCost;
  const batchWithPkg = batchNoPkg + packTotal;
  const cpServNoPkg = servings > 0 ? batchNoPkg / servings : null;
  const cpServWith = servings > 0 ? batchWithPkg / servings : null;
  return { ingRows, ingTotal, missingCount, labour, packaging, overhead, servings,
           packTotal, batchCost, cpServ, sellPrice, margin, foodCostPct,
           overheadCost, batchNoPkg, batchWithPkg, cpServNoPkg, cpServWith };
}

// origin/main public/app.html:7647-7685 — showCostSheet() + renderCS(cd)
function OLD_renderCS(rec, ings, cd) {
  let ingTotal = 0, missingCount = 0;
  ings.map(i => {
    const free = !!i.master_free;
    const cpu = i.master_cost || 0;
    const line = free ? 0 : (cpu > 0 ? i.qty * cpu : null);
    if (line === null) missingCount++; else ingTotal += line;
    return { ...i, cpu, line, free };
  });
  const labour = parseFloat(cd.labour || 0), packaging = parseFloat(cd.packaging || 0),
        overhead = parseFloat(cd.overhead_pct || 0), sellPrice = parseFloat(cd.sell_price || 0),
        servings = parseFloat(rec.servings || 0);
  const packTotal = packaging * (servings > 0 ? servings : 1);
  const batchCost = ingTotal + labour + packTotal + (ingTotal * overhead / 100);
  const cpServ = servings > 0 ? batchCost / servings : null;
  const batch = parseFloat(rec.batch_size) || 0;
  const cpGram = batch > 0 ? batchCost / batch : null;
  const margin = sellPrice > 0 && cpServ !== null ? sellPrice - cpServ : null;
  const fcPct = sellPrice > 0 && cpServ !== null ? cpServ / sellPrice * 100 : null;
  const targetFC = parseFloat(cd.target_food_cost || 30);
  const suggestSell = cpServ !== null && targetFC > 0 ? cpServ / (targetFC / 100) : null;
  return { ingTotal, missingCount, labour, packaging, overhead, sellPrice, servings,
           packTotal, batchCost, cpServ, batch, cpGram, margin, fcPct, targetFC, suggestSell };
}

// origin/main public/app.html:7960-7976 — csUpdate(), reading the form.
// `dom` holds the STRINGS the inputs carry; see the DOM-round-trip note above.
function OLD_csUpdate(rec, ingTotalCached, dom) {
  const ingTotal = ingTotalCached || 0;
  const labour = parseFloat(dom.cs_labour) || 0;
  const packaging = parseFloat(dom.cs_packaging) || 0;
  const overhead = parseFloat(dom.cs_overhead) || 0;
  const sellPrice = parseFloat(dom.cs_sell) || 0;
  const servings = parseFloat(rec.servings || 0);
  const batch = parseFloat(rec.batch_size || 0);
  const targetFC = parseFloat(dom.cs_target) || 30;
  const packTotal = packaging * (servings > 0 ? servings : 1);
  const batchCost = ingTotal + labour + packTotal + (ingTotal * overhead / 100);
  const cpServ = servings > 0 ? batchCost / servings : null;
  const cpGram = batch > 0 ? batchCost / batch : null;
  const margin = sellPrice > 0 && cpServ !== null ? sellPrice - cpServ : null;
  const fcPct = sellPrice > 0 && cpServ !== null ? cpServ / sellPrice * 100 : null;
  const suggestSell = cpServ !== null && targetFC > 0 ? cpServ / (targetFC / 100) : null;
  return { ingTotal, labour, packaging, overhead, sellPrice, servings, batch,
           targetFC, packTotal, batchCost, cpServ, cpGram, margin, fcPct, suggestSell };
}

// How renderCS writes the form inputs (app.html value="${...}" attributes), so
// csUpdate's string inputs are reproduced rather than guessed.
function domFromCostData(cd) {
  return {
    cs_labour:    String(cd.labour || ''),
    cs_packaging: String(cd.packaging || ''),
    cs_overhead:  String(cd.overhead_pct || ''),
    cs_sell:      String(cd.sell_price || ''),
    cs_target:    String(cd.target_food_cost || 30),
  };
}

// ── The rendered strings a user actually sees ───────────────────────────────
// Taken from the markup: app.html:6585-6586, 6607-6610 (recipe card) and
// 7735-7779, 7981-7986 (cost sheet). If these match, the screen matches.
const money = v => (v === null || v === undefined) ? '—' : '¥' + v.toFixed(2);
const gram4 = v => v ? '¥' + v.toFixed(4) : '—';
const pct1  = v => v ? v.toFixed(1) + '%' : '—';
const sugg  = v => v ? v.toFixed(2) : '';

// ── Comparison ──────────────────────────────────────────────────────────────
let checks = 0, mismatches = 0;
const failures = [];
function cmp(recipeId, recipeName, where, field, oldV, newV) {
  checks++;
  const same = (oldV === newV)
    || (oldV === null && newV === null)
    || (typeof oldV === 'number' && typeof newV === 'number'
        && Number.isNaN(oldV) && Number.isNaN(newV));
  if (!same) {
    mismatches++;
    if (failures.length < 60) {
      failures.push(`recipe ${recipeId} "${recipeName}" · ${where}.${field}: OLD=${JSON.stringify(oldV)} NEW=${JSON.stringify(newV)}`);
    }
  }
}

// Same statements GET /api/recipes/:id runs (routes/recipes.js:267-271), so the
// comparison is fed exactly what the screens are fed.
const SQL_INGREDIENTS = `SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
       i.free_by_design AS master_free
  FROM recipe_ingredients ri
  LEFT JOIN ingredients i ON ri.ingredient_id = i.id
 WHERE ri.recipe_id = ?
 ORDER BY ri.sort_order`;

const recipes = db.prepare('SELECT * FROM recipes ORDER BY id').all();
const getIngs = db.prepare(SQL_INGREDIENTS);
const getCost = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?');

console.log(`══ comparing ${recipes.length} recipes ══`);
let totalLines = 0;

for (const r of recipes) {
  const ings = getIngs.all(r.id);
  const costData = getCost.get(r.id);
  totalLines += ings.length;
  const rec = { ...r, ingredients: ings, costData };
  const name = (r.name_en || '').slice(0, 40);

  // ── 1 · viewRecipe ────────────────────────────────────────────────────────
  const oldV = OLD_viewRecipe(rec, ings);
  const newV = computeRecipeCost({ recipe: rec, ingredients: ings, costData: rec.costData || {} });

  cmp(r.id, name, 'viewRecipe', 'ingTotal',     oldV.ingTotal,     newV.ingredientCost);
  cmp(r.id, name, 'viewRecipe', 'missingCount', oldV.missingCount, newV.zeroCostIngredientLines);
  cmp(r.id, name, 'viewRecipe', 'labour',       oldV.labour,       newV.labour);
  cmp(r.id, name, 'viewRecipe', 'packaging',    oldV.packaging,    newV.packaging);
  cmp(r.id, name, 'viewRecipe', 'overhead',     oldV.overhead,     newV.overheadPct);
  cmp(r.id, name, 'viewRecipe', 'servings',     oldV.servings,     newV.servings);
  cmp(r.id, name, 'viewRecipe', 'packTotal',    oldV.packTotal,    newV.packagingTotal);
  cmp(r.id, name, 'viewRecipe', 'batchCost',    oldV.batchCost,    newV.batchCost);
  cmp(r.id, name, 'viewRecipe', 'cpServ',       oldV.cpServ,       newV.costPerServing);
  cmp(r.id, name, 'viewRecipe', 'sellPrice',    oldV.sellPrice,    newV.sellPrice);
  cmp(r.id, name, 'viewRecipe', 'margin',       oldV.margin,       newV.marginPerServing);
  cmp(r.id, name, 'viewRecipe', 'foodCostPct',  oldV.foodCostPct,  newV.foodCostPct);
  cmp(r.id, name, 'viewRecipe', 'overheadCost', oldV.overheadCost, newV.overheadAmount);

  // The With/No-packaging card derives from the shared values the same way.
  const nOverheadCost = newV.overheadAmount;
  const nBatchNoPkg   = newV.ingredientCost + newV.labour + nOverheadCost;
  const nBatchWithPkg = nBatchNoPkg + newV.packagingTotal;
  const nCpServNoPkg  = newV.servings > 0 ? nBatchNoPkg / newV.servings : null;
  const nCpServWith   = newV.servings > 0 ? nBatchWithPkg / newV.servings : null;
  cmp(r.id, name, 'viewRecipe', 'batchNoPkg',   oldV.batchNoPkg,   nBatchNoPkg);
  cmp(r.id, name, 'viewRecipe', 'batchWithPkg', oldV.batchWithPkg, nBatchWithPkg);
  cmp(r.id, name, 'viewRecipe', 'cpServNoPkg',  oldV.cpServNoPkg,  nCpServNoPkg);
  cmp(r.id, name, 'viewRecipe', 'cpServWith',   oldV.cpServWith,   nCpServWith);

  // Rendered strings — the actual visible promise.
  cmp(r.id, name, 'render:card', 'headline',    money(oldV.batchWithPkg), money(nBatchWithPkg));
  cmp(r.id, name, 'render:card', 'perServing',  oldV.cpServWith !== null ? money(oldV.cpServWith) : 'no servings set',
                                                nCpServWith    !== null ? money(nCpServWith)    : 'no servings set');
  cmp(r.id, name, 'render:card', 'ingTotal',    money(oldV.ingTotal),    money(newV.ingredientCost));
  cmp(r.id, name, 'render:card', 'margin',      oldV.margin !== null ? money(oldV.margin) : '—',
                                                newV.marginPerServing !== null ? money(newV.marginPerServing) : '—');
  cmp(r.id, name, 'render:card', 'fcPct',       oldV.foodCostPct !== null ? oldV.foodCostPct.toFixed(1) + '%' : '—',
                                                newV.foodCostPct !== null ? newV.foodCostPct.toFixed(1) + '%' : '—');

  // Per-line values, every ingredient row on the table.
  for (let n = 0; n < ings.length; n++) {
    const o = oldV.ingRows[n];
    const nn = newV.lines[n];
    cmp(r.id, name, `line[${n}]`, 'cpu',  o.cpu,  nn.costPerUnit);
    cmp(r.id, name, `line[${n}]`, 'line', o.line, nn.lineCost);
    cmp(r.id, name, `line[${n}]`, 'free', o.free, nn.freeByDesign);
    // Rendered: the Cost/unit and Line Cost cells (app.html:6672-6673).
    cmp(r.id, name, `line[${n}]`, 'render:cpu',
        o.free ? 'Free' : (o.cpu ? '¥' + o.cpu.toFixed(4) : 'Missing'),
        nn.freeByDesign ? 'Free' : (nn.costPerUnit ? '¥' + nn.costPerUnit.toFixed(4) : 'Missing'));
    cmp(r.id, name, `line[${n}]`, 'render:line',
        o.line !== null ? '¥' + o.line.toFixed(2) : '—',
        nn.lineCost !== null ? '¥' + nn.lineCost.toFixed(2) : '—');
  }

  // ── 2 · renderCS — first paint, fed the STORED cost row ──────────────────
  const cd = costData || {};
  const oldR = OLD_renderCS(rec, ings, cd);
  const newR = computeRecipeCost({
    recipe: rec, ingredients: ings,
    costData: {
      labour:           parseFloat(cd.labour || 0),
      packaging:        parseFloat(cd.packaging || 0),
      overhead_pct:     parseFloat(cd.overhead_pct || 0),
      sell_price:       parseFloat(cd.sell_price || 0),
      target_food_cost: parseFloat(cd.target_food_cost || 30),
    },
  });
  cmp(r.id, name, 'renderCS', 'ingTotal',    oldR.ingTotal,    newR.ingredientCost);
  cmp(r.id, name, 'renderCS', 'batchCost',   oldR.batchCost,   newR.batchCost);
  cmp(r.id, name, 'renderCS', 'cpServ',      oldR.cpServ,      newR.costPerServing);
  cmp(r.id, name, 'renderCS', 'batch',       oldR.batch,       newR.batchSize);
  cmp(r.id, name, 'renderCS', 'cpGram',      oldR.cpGram,      newR.costPerGram);
  cmp(r.id, name, 'renderCS', 'margin',      oldR.margin,      newR.marginPerServing);
  cmp(r.id, name, 'renderCS', 'fcPct',       oldR.fcPct,       newR.foodCostPct);
  cmp(r.id, name, 'renderCS', 'targetFC',    oldR.targetFC,    newR.targetFoodCost);
  cmp(r.id, name, 'renderCS', 'suggestSell', oldR.suggestSell, newR.suggestedSellPrice);
  cmp(r.id, name, 'renderCS', 'packTotal',   oldR.packTotal,   newR.packagingTotal);
  // Rendered — the four cost tiles + the suggested price box.
  cmp(r.id, name, 'render:sheet', 'batch',   money(oldR.batchCost),   money(newR.batchCost));
  cmp(r.id, name, 'render:sheet', 'serv',    oldR.cpServ !== null ? money(oldR.cpServ) : '—',
                                             newR.costPerServing !== null ? money(newR.costPerServing) : '—');
  cmp(r.id, name, 'render:sheet', 'gram',    gram4(oldR.cpGram),      gram4(newR.costPerGram));
  cmp(r.id, name, 'render:sheet', 'margin',  oldR.margin !== null ? money(oldR.margin) : '—',
                                             newR.marginPerServing !== null ? money(newR.marginPerServing) : '—');
  cmp(r.id, name, 'render:sheet', 'fcPct',   pct1(oldR.fcPct),        pct1(newR.foodCostPct));
  cmp(r.id, name, 'render:sheet', 'suggest', sugg(oldR.suggestSell),  sugg(newR.suggestedSellPrice));

  // ── 3 · csUpdate — live retype, through the DOM string round trip ────────
  const dom = domFromCostData(cd);
  const oldU = OLD_csUpdate(rec, oldR.ingTotal, dom);
  const newU = computeRecipeCost({
    recipe: rec, ingredients: ings,
    costData: {
      labour:           parseFloat(dom.cs_labour) || 0,
      packaging:        parseFloat(dom.cs_packaging) || 0,
      overhead_pct:     parseFloat(dom.cs_overhead) || 0,
      sell_price:       parseFloat(dom.cs_sell) || 0,
      target_food_cost: parseFloat(dom.cs_target) || 30,
    },
  });
  cmp(r.id, name, 'csUpdate', 'batchCost',   oldU.batchCost,   newU.batchCost);
  cmp(r.id, name, 'csUpdate', 'cpServ',      oldU.cpServ,      newU.costPerServing);
  cmp(r.id, name, 'csUpdate', 'cpGram',      oldU.cpGram,      newU.costPerGram);
  cmp(r.id, name, 'csUpdate', 'margin',      oldU.margin,      newU.marginPerServing);
  cmp(r.id, name, 'csUpdate', 'fcPct',       oldU.fcPct,       newU.foodCostPct);
  cmp(r.id, name, 'csUpdate', 'targetFC',    oldU.targetFC,    newU.targetFoodCost);
  cmp(r.id, name, 'csUpdate', 'suggestSell', oldU.suggestSell, newU.suggestedSellPrice);
  // Rendered — exactly the five set()/seti() calls csUpdate makes.
  cmp(r.id, name, 'render:live', 'batch',   money(oldU.batchCost), money(newU.batchCost));
  cmp(r.id, name, 'render:live', 'serv',    oldU.cpServ !== null ? money(oldU.cpServ) : '—',
                                            newU.costPerServing !== null ? money(newU.costPerServing) : '—');
  cmp(r.id, name, 'render:live', 'gram',    gram4(oldU.cpGram),    gram4(newU.costPerGram));
  cmp(r.id, name, 'render:live', 'margin',  oldU.margin !== null ? money(oldU.margin) : '—',
                                            newU.marginPerServing !== null ? money(newU.marginPerServing) : '—');
  cmp(r.id, name, 'render:live', 'fcPct',   pct1(oldU.fcPct),      pct1(newU.foodCostPct));
  cmp(r.id, name, 'render:live', 'suggest', sugg(oldU.suggestSell), sugg(newU.suggestedSellPrice));
}

console.log(`recipes compared:          ${recipes.length}`);
console.log(`ingredient lines compared: ${totalLines}`);
console.log(`value comparisons:         ${checks}`);
console.log(`mismatches:                ${mismatches}`);
console.log('');

if (mismatches === 0) {
  console.log('══ PASS — every value and every rendered string is identical ══');
  console.log('The three browser call sites can be swapped onto lib/recipe-cost.js');
  console.log('without moving a number on any screen.');
  process.exit(0);
} else {
  console.log('══ FAIL — the consolidation is NOT invisible ══');
  console.log('Step 1 is defined as producing no visible change. It does not. Do not merge.');
  console.log('');
  for (const f of failures) console.log('  ' + f);
  if (mismatches > failures.length) console.log(`  … and ${mismatches - failures.length} more`);
  process.exit(1);
}
