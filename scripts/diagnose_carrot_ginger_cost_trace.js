#!/usr/bin/env node
/**
 * diagnose_carrot_ginger_cost_trace.js — trace why Carrot-Ginger Juice waste
 * cost disagrees with the recipe card's cost per serving.
 *
 * Read-only. Opens ROOTS_DB readonly and proves it before querying.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const SKU = process.env.TRACE_SKU || '2-170';
const NAME_LIKE = process.env.TRACE_NAME || '%Carrot-Ginger%';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('better-sqlite3'); }
}

const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write.');
  process.exit(2);
}

const { computeRecipeCost } = require(path.join(HOME, 'lib', 'recipe-cost'));
const { productUnitCostYuan } = require(path.join(HOME, 'lib', 'product-cost'));
const { computeProductBuildCost } = require(path.join(HOME, 'lib', 'product-build-cost'));
const { wasteUnitCostYuan } = require(path.join(HOME, 'lib', 'waste-record'));
const { productionEnabled } = require(path.join(HOME, 'lib', 'features'));
const { recipeOwnsProductCost } = require(path.join(HOME, 'lib/recipe-rollup'));

const money = n => (n == null || !Number.isFinite(Number(n))) ? '—' : '¥' + Number(n).toFixed(2);

console.log('db:     ' + DB_PATH);
console.log('run at: ' + new Date().toISOString());
console.log('sku:    ' + SKU);
console.log('');

const prods = db.prepare(`
  SELECT id, name_en, name_cn, sku, recipe_id, unit_cost, sell_price, weight, updated_at,
         COALESCE(is_active, 1) AS is_active
    FROM store_products
   WHERE sku = ? OR name_en LIKE ?
   ORDER BY id
`).all(SKU, NAME_LIKE);

if (!prods.length) {
  console.log('No store_products matched sku=' + SKU + ' or name LIKE ' + NAME_LIKE);
  process.exit(1);
}

console.log('productionEnabled:', productionEnabled(db));
console.log('matched products:', prods.length);
console.log('');

for (const p of prods) {
  console.log('═'.repeat(72));
  console.log(`PRODUCT #${p.id}  ${p.name_en}  sku=${p.sku}`);
  console.log('─'.repeat(72));
  console.log('  sell_price:', money(p.sell_price));
  console.log('  weight/size field:', p.weight || '—');
  console.log('  stored unit_cost:', money(p.unit_cost));
  console.log('  productUnitCostYuan():', money(productUnitCostYuan(db, p.id)));
  console.log('  recipe_id:', p.recipe_id);
  console.log('  recipeOwnsProductCost():', recipeOwnsProductCost(db, p.id));
  console.log('  updated_at:', p.updated_at);

  const bl = computeProductBuildCost(p.id, db);
  console.log('  build list:', bl.hasBuildList ? 'yes' : 'no',
    '| unitCost from build:', money(bl.unitCost),
    '| lines:', bl.lines.length);

  if (bl.hasBuildList && bl.lines.length) {
    console.log('  build lines:');
    for (const l of bl.lines) {
      console.log('    ·', l.name || l.name_en, 'qty', l.qty, l.unit,
        'lineCost', money(l.lineCost), l.packedSeparately ? '[packed separately]' : '');
    }
  }

  if (p.recipe_id) {
    const r = db.prepare(`
      SELECT id, name_en, name_cn, sku, batch_size, servings, serving_size,
             batch_size_auto, servings_auto, is_active
        FROM recipes WHERE id = ?
    `).get(p.recipe_id);
    console.log('');
    console.log('  RECIPE #' + r.id + ' ' + r.name_en + (r.is_active ? '' : ' [ARCHIVED]'));
    console.log('    batch_size:', r.batch_size, 'auto:', r.batch_size_auto);
    console.log('    servings:', r.servings, 'auto:', r.servings_auto);
    console.log('    serving_size (g):', r.serving_size);

    const c = computeRecipeCost(p.recipe_id, db);
    console.log('');
    console.log('  LIVE computeRecipeCost (what the recipe card shows):');
    console.log('    batchSize (resolved):', c.batchSize, 'g');
    console.log('    servings (resolved):', c.servings);
    console.log('    batchCost:', money(c.batchCost));
    console.log('    costPerServing:', money(c.costPerServing));
    console.log('    costPerGram:', c.costPerGram != null ? money(c.costPerGram) + '/g' : '—');
    const servingSizeG = parseFloat(r.serving_size) || 0;
    if (servingSizeG > 0 && c.batchSize > 0) {
      const implied = Math.floor(Number((c.batchSize / servingSizeG).toFixed(6)));
      console.log('    implied servings from batch÷serving_size:', implied,
        '(leftover g:', (c.batchSize - implied * servingSizeG).toFixed(1) + ')');
    }
    if (c.costPerGram != null && r.serving_size > 0) {
      console.log('    costPerGram × serving_size:', money(c.costPerGram * r.serving_size),
        '(if one bottle = serving_size g)');
    }

    const delta = (p.unit_cost != null && c.costPerServing != null)
      ? Number(p.unit_cost) - Number(c.costPerServing) : null;
    console.log('');
    console.log('  PARITY: stored unit_cost vs live costPerServing:',
      money(p.unit_cost), 'vs', money(c.costPerServing),
      delta != null ? `(Δ ${money(delta)})` : '');

    if (p.unit_cost != null && c.costPerServing != null && Math.abs(delta) > 0.001) {
      const stored = Number(p.unit_cost);
      const impliedServings = c.batchCost / stored;
      console.log('    if stored were old costPerServing, implied batch÷stored servings ≈',
        impliedServings.toFixed(2));
    }
  }

  console.log('');
  console.log('  WASTE pricing (current rules, not historical snapshot):');
  for (const reason of ['staff', 'expired', 'spoiled', 'damaged']) {
    const w = wasteUnitCostYuan(db, p.id, reason);
    console.log('    reason', reason + ':', money(w.unitYuan),
      w.kept.length ? '(kept: ' + w.kept.map(k => k.name_en).join(', ') + ')' : '');
  }

  const wasteRows = db.prepare(`
    SELECT id, qty, cost_total_cents, is_uncosted, reason_code, business_date, created_at
      FROM waste_records
     WHERE store_product_id = ? AND subject_type = 'product'
       AND reverses_waste_id IS NULL AND voided_by_waste_id IS NULL
     ORDER BY id DESC LIMIT 10
  `).all(p.id);

  console.log('');
  console.log('  RECENT waste_records (snapshotted at write):', wasteRows.length ? '' : '(none)');
  for (const w of wasteRows) {
    const unitSnap = w.cost_total_cents != null && w.qty > 0
      ? (w.cost_total_cents / 100 / w.qty) : null;
    console.log('    #' + w.id, w.business_date, 'qty', w.qty, w.reason_code,
      'total', money(w.cost_total_cents / 100),
      'unit@write', money(unitSnap),
      w.is_uncosted ? '[uncosted]' : '');
  }

  const corrections = db.prepare(`
    SELECT wcc.waste_id, wcc.from_cents, wcc.to_cents, wcc.created_at
      FROM waste_cost_corrections wcc
      JOIN waste_records wr ON wr.id = wcc.waste_id
     WHERE wr.store_product_id = ?
     ORDER BY wcc.id DESC LIMIT 5
  `).all(p.id);
  if (corrections.length) {
    console.log('  waste_cost_corrections:');
    for (const c of corrections) {
      console.log('    waste #' + c.waste_id, money(c.from_cents / 100), '→', money(c.to_cents / 100), c.created_at);
    }
  }
  console.log('');
}

process.exit(0);
