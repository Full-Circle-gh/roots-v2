#!/usr/bin/env node
/**
 * diagnose_options_cost_column.js — did §166's column actually reach the box,
 * and can an order still be written?
 *
 * WHY THIS EXISTS, AND WHY IT RUNS AFTER THE DEPLOY SAID SUCCESS
 * --------------------------------------------------------------
 * §166 widened four INSERT statements to name `options_cost_at_sale`, a column
 * created by `addColumn()` in database.js at APP STARTUP — not by the deploy,
 * and not by any migration the deploy can see. The deploy ships bytes and
 * restarts pm2; whether the startup path then added the column is a separate
 * fact, and the health probe cannot tell: it checks `/`, the categories, the
 * config and the products list, and not one of those writes an order line.
 *
 * So a deploy that shipped the wider INSERT to a database that never gained the
 * column would go GREEN and then fail on the first sale — `no such column` on
 * the checkout, the QR till and the added-later line at once. That is the worst
 * shape a failure can take here: invisible to CI, invisible to the probe, and
 * visible only to a customer at a counter.
 *
 * This asks the three questions that settle it, in order of how bad the answer
 * would be:
 *
 *   1. Does `retail_order_items.options_cost_at_sale` exist?
 *   2. Do the DEPLOYED bytes carry the wider INSERTs and lib/option-cost.js?
 *   3. Does the shipped module actually run against the live catalogue?
 *
 * READ-ONLY, AND IT PROVES IT. The database is opened `readonly: true` and a
 * write is attempted and REQUIRED to fail before anything else runs. Question 1
 * is answered with PRAGMA rather than by attempting the insert, for that reason
 * — the whole point is to check a write path WITHOUT writing.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_options_cost_column.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');

let failures = 0, checks = 0;
const ok  = (m) => { checks++; console.log('  PASS  ' + m); };
const bad = (m) => { checks++; failures++; console.log('  FAIL  ' + m); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const note = (m) => console.log('        · ' + m);
const rule = (t) => { console.log(); console.log('═'.repeat(78)); console.log(t); console.log('═'.repeat(78)); };

console.log('db:          ' + DB_PATH);
console.log('deploy root: ' + DEPLOY_ROOT);
console.log('run at (UTC): ' + new Date().toISOString());

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[options-cost-column] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _occ_write_probe (x INTEGER)').run();
  console.error('[options-cost-column] ABORT: the connection accepted a write.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[options-cost-column] ABORT: write refused oddly: ${e && e.message}`);
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('1 · THE COLUMN — the one that decides whether a sale can be written');
const cols = db.prepare('PRAGMA table_info(retail_order_items)').all().map(c => c.name);
assert(cols.includes('unit_cost_at_sale'), 'retail_order_items.unit_cost_at_sale present (the old one)');
assert(cols.includes('options_cost_at_sale'), 'retail_order_items.options_cost_at_sale PRESENT — §166 startup migration ran');
if (!cols.includes('options_cost_at_sale')) {
  note('THIS IS THE BREAKING ONE. Four INSERTs name this column. Until it exists,');
  note('the customer checkout, the QR till and the added-later line all throw.');
  note('Fix: restart the app so database.js addColumn() runs.');
}

// The column must be nullable and must NOT have a default: NULL is the value
// the whole design uses for "unknown", and a DEFAULT 0 would claim every extra
// ever sold was free.
const info = db.prepare('PRAGMA table_info(retail_order_items)').all()
  .find(c => c.name === 'options_cost_at_sale');
if (info) {
  assert(info.notnull === 0, 'it is NULLABLE — NULL is how the design says "unknown"');
  assert(info.dflt_value == null, 'it has NO default — a default of 0 would report every extra as free');
  assert(/REAL/i.test(info.type || ''), 'it is REAL, matching unit_cost_at_sale beside it');
}

// ════════════════════════════════════════════════════════════════════════════
rule('2 · THE DEPLOYED BYTES — not "the deploy said OK"');
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const mod = readIf(path.join(DEPLOY_ROOT, 'lib', 'option-cost.js'));
assert(mod !== null, 'lib/option-cost.js is on the box');
if (mod) {
  assert(/chosenOptionCostYuan/.test(mod) && /requiredOptionFloorYuan/.test(mod),
    '...and exports both functions');
}
const retail = readIf(path.join(DEPLOY_ROOT, 'routes', 'retail.js'));
assert(retail !== null && /options_cost_at_sale/.test(retail || ''),
  'routes/retail.js on the box names the new column');
assert(retail !== null && /function optionsCostAtSale/.test(retail || ''),
  '...and carries the wrapper that fills it');
const menu = readIf(path.join(DEPLOY_ROOT, 'routes', 'shop-menu.js'));
assert(menu !== null && /optionsCostAtSale/.test(menu || ''),
  'routes/shop-menu.js (the QR till) carries it too');
const fin = readIf(path.join(DEPLOY_ROOT, 'routes', 'finance-summary.js'));
assert(fin !== null && /options_cost_at_sale/.test(fin || ''),
  'routes/finance-summary.js adds it to COGS');
const prod = readIf(path.join(DEPLOY_ROOT, 'public', 'retail-admin', '09-products.js'));
assert(prod !== null && /OPT_COST_FLOOR/.test(prod || ''),
  'the product editor on the box reads the option floor');

// ════════════════════════════════════════════════════════════════════════════
rule('3 · THE SHIPPED MODULE, RUN AGAINST THE LIVE CATALOGUE');
// The DEPLOYED copy, not this checkout's — the question is what the server has.
let optcost = null;
try { optcost = require(path.join(DEPLOY_ROOT, 'lib', 'option-cost.js')); } catch (e) {
  bad('the deployed lib/option-cost.js does not load: ' + (e && e.message));
}
if (optcost) {
  ok('the deployed module loads');
  let ran = 0, floors = 0, blocked = 0;
  const prods = db.prepare(
    'SELECT id FROM store_products WHERE COALESCE(is_active,1) = 1'
  ).all();
  for (const p of prods) {
    try {
      const f = optcost.requiredOptionFloorYuan(db, p.id);
      ran++;
      if (f.yuan === null) blocked++;
      else if (f.yuan > 0) floors++;
    } catch (e) {
      bad(`requiredOptionFloorYuan threw on product #${p.id}: ${e && e.message}`);
      break;
    }
  }
  assert(ran === prods.length, `it ran clean over all ${prods.length} active products`);
  note(`products whose required choices add a cost: ${floors}`);
  note(`products whose floor is UNKNOWN (a required linked choice has no cost): ${blocked}`);
  note('Both being 0 is the expected state on the day this shipped — the change is');
  note('inert until a required choice is linked to a costed product.');

  // And the sale half, on the shape it will actually meet.
  try {
    const r = optcost.chosenOptionCostYuan(db, []);
    assert(r.yuan === null && r.linked === 0, 'chosenOptionCostYuan([]) → null, nothing linked');
  } catch (e) { bad('chosenOptionCostYuan threw on an empty array: ' + (e && e.message)); }
}

// ════════════════════════════════════════════════════════════════════════════
rule('4 · WHAT THE LEDGER HOLDS SO FAR');
const n = db.prepare('SELECT COUNT(*) n FROM retail_order_items').get().n;
let withOpt = 0;
try {
  withOpt = db.prepare('SELECT COUNT(*) n FROM retail_order_items WHERE options_cost_at_sale IS NOT NULL').get().n;
  ok('the column is queryable on the live table');
} catch (e) { bad('cannot query the column: ' + (e && e.message)); }
note(`order lines total: ${n}`);
note(`lines carrying an extras cost: ${withOpt} — 0 is correct today; history is deliberately not backfilled`);

console.log();
console.log(failures ? `FAIL — ${failures} of ${checks} checks failed` : `PASS — all ${checks} checks`);
process.exit(failures ? 1 : 0);
