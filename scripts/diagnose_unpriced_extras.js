#!/usr/bin/env node
/**
 * diagnose_unpriced_extras.js — which products must be costed before §162's
 * plumbing actually carries any money, in the order that moves the number most.
 *
 * WHY THIS EXISTS
 * ---------------
 * §162 built the pipe: a chosen option that draws down a real shelf
 * (`stock_product_id`) now records what it cost us, in
 * `retail_order_items.options_cost_at_sale`, and routes/finance-summary.js adds
 * it to COGS. The pipe is not the money. 54 live choices carry a stock link and
 * `scripts/diagnose_option_cost_gap.js` could price 15 of them — the other 39
 * point at products with no cost on file, so the new column writes NULL and the
 * profit figure is exactly as short as it was.
 *
 * Ash asked which ones to fix. Alphabetical is the wrong order: a dip nobody
 * orders and a bread on every third ticket are one row each in a catalogue and
 * nothing alike in a ledger. So this ranks by WHAT WAS ACTUALLY SOLD.
 *
 * THE ALL-OR-NOTHING RULE MAKES THE COVERAGE WORSE THAN 15-OF-54 SOUNDS, AND
 * SECTION 3 MEASURES THE REAL FIGURE. lib/option-cost.js blocks a line's whole
 * extras cost when ANY chosen link cannot be priced — a sum missing one
 * contributor is confidently low, and low reads as plausible. So a line whose
 * bread is costed and whose harissa is not records NOTHING, and one unpriced
 * product can hold down every line it ever appears beside. Counting priceable
 * CHOICES answers a different and easier question than counting priceable
 * LINES, and only the second one is the money.
 *
 * IT READS HISTORY THROUGH `options_json`, WHICH IS WHY IT CAN RANK AT ALL.
 * The column has been filled by the web and mini-app checkouts for as long as
 * either has had options, so the past is legible even though §162 deliberately
 * back-filled no costs into it. An entry's `stock_product_id` is preferred when
 * present and its `choice_id` is resolved against the live choice table when it
 * is not — older rows predate the link being carried on the line, and dropping
 * them would under-count exactly the oldest and best-established extras.
 *
 * SECTION 4 SAYS WHAT FIXING EACH ONE ACTUALLY MEANS, because "give it a cost"
 * is three different jobs. A product with a recipe or a build list needs its
 * SOURCE mended and the rollup does the rest; a product with neither needs a
 * number typed by someone who knows it. Sending an operator to the wrong one is
 * how a list like this gets abandoned half-done.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Read-only, and it proves it: the
 * database is opened `readonly: true` and a write is attempted and REQUIRED to
 * fail before any query runs. Costs are read through productUnitCostYuan(), the
 * same accessor §162's module uses, so "can we price it" means here exactly what
 * it will mean at the till.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_unpriced_extras.js
 *   Dispatch it against THIS BRANCH — the workflow checks out the ref it is
 *   given, and this file does not exist on main.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

const { productUnitCostYuan } = require(path.join(HOME, 'lib', 'product-cost'));

const out = (s = '') => console.log(s);
const rule = (t) => { out(); out('═'.repeat(78)); out(t); out('═'.repeat(78)); };
const money = (n) => n == null ? '—' : '¥' + (Number(n) || 0).toFixed(2);
const pct = (num, den) => (!Number(den) ? '—' : ((100 * Number(num)) / Number(den)).toFixed(1) + '%');

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[unpriced-extras] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _unpriced_extras_write_probe (x INTEGER)').run();
  console.error('[unpriced-extras] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[unpriced-extras] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

// ── The live choice table, and what each link can be priced at ─────────────
const choiceLink = new Map();     // choice_id -> stock_product_id
for (const c of db.prepare(
  'SELECT id, stock_product_id FROM retail_product_option_choices WHERE stock_product_id IS NOT NULL'
).all()) choiceLink.set(c.id, c.stock_product_id);

const costCache = new Map();
function costOf(pid) {
  if (costCache.has(pid)) return costCache.get(pid);
  let v = null;
  try { v = productUnitCostYuan(db, pid); } catch (e) { v = null; }
  costCache.set(pid, v);
  return v;
}

const prodRow = db.prepare(
  'SELECT id, name_en, name_cn, sku, unit_cost, recipe_id, COALESCE(is_active,1) AS is_active FROM store_products WHERE id = ?'
);
const prodCache = new Map();
function product(pid) {
  if (!prodCache.has(pid)) prodCache.set(pid, prodRow.get(pid) || null);
  return prodCache.get(pid);
}

// ── Walk the sold lines ────────────────────────────────────────────────────
// Every paid-ish line that carries options. The order allow-list is NOT applied
// here deliberately: the question is "which product needs a cost", and a
// cancelled order still tells us the extra is one people choose. The money
// columns below say so where it matters.
const lines = db.prepare(`
  SELECT i.id, i.qty, i.options_json, i.line_total, o.status, o.paid_at
    FROM retail_order_items i
    JOIN retail_orders o ON o.id = i.order_id
   WHERE i.options_json IS NOT NULL AND i.options_json != '' AND i.options_json != '[]'
`).all();

// per stock product: lines it appeared on, units of it sold as an extra
const use = new Map();
let linesWithLink = 0, linesFullyPriceable = 0, linesBlocked = 0;
const blockedBy = new Map();      // pid -> lines it alone/partly blocked

for (const l of lines) {
  let opts;
  try { opts = JSON.parse(l.options_json); } catch (e) { continue; }
  if (!Array.isArray(opts)) continue;
  const pids = [];
  for (const o of opts) {
    if (!o) continue;
    // Prefer the link stored on the line; fall back to the live choice row for
    // rows written before the link travelled on the line itself.
    let pid = parseInt(o.stock_product_id, 10);
    if (!pid && o.choice_id != null) pid = choiceLink.get(o.choice_id) || 0;
    if (pid) pids.push(pid);
  }
  if (!pids.length) continue;
  linesWithLink++;
  const qty = Number(l.qty) || 0;
  const unpriced = [];
  for (const pid of pids) {
    if (!use.has(pid)) use.set(pid, { lines: 0, units: 0, revenue: 0 });
    const u = use.get(pid);
    u.lines++; u.units += qty; u.revenue += Number(l.line_total) || 0;
    if (costOf(pid) == null) unpriced.push(pid);
  }
  if (unpriced.length) {
    linesBlocked++;
    for (const pid of new Set(unpriced)) {
      blockedBy.set(pid, (blockedBy.get(pid) || 0) + 1);
    }
  } else {
    linesFullyPriceable++;
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('1 · THE LIST — WHICH PRODUCTS TO COST, IN THE ORDER THAT MOVES THE NUMBER');
out('  Ranked by ORDER LINES BLOCKED, not by how often the extra was chosen. The');
out('  two differ because of the all-or-nothing rule: a product that shares a');
out('  ticket with another unpriced one is only worth fixing WITH it, and a');
out('  product that is the sole unpriced thing on its lines unblocks them alone.');
out();

const unpricedPids = [...use.keys()].filter(pid => costOf(pid) == null);
unpricedPids.sort((a, b) => (blockedBy.get(b) || 0) - (blockedBy.get(a) || 0)
                         || (use.get(b).units - use.get(a).units));

if (!unpricedPids.length) {
  out('  Nothing. Every stock-linked extra that has ever been sold can be priced.');
} else {
  out('  #   ' + 'product'.padEnd(34) + 'blocks'.padStart(7) + 'lines'.padStart(7)
      + 'units'.padStart(8) + '  on orders worth');
  out('  ' + '─'.repeat(74));
  let n = 0;
  for (const pid of unpricedPids) {
    const p = product(pid);
    const u = use.get(pid);
    n++;
    out('  ' + String(n).padEnd(4)
        + String(p ? p.name_en : '#' + pid + ' (gone)').slice(0, 33).padEnd(34)
        + String(blockedBy.get(pid) || 0).padStart(7)
        + String(u.lines).padStart(7)
        + String(Math.round(u.units)).padStart(8)
        + money(u.revenue).padStart(14)
        + (p && !p.is_active ? '   archived' : ''));
  }
  out();
  out('  "blocks" = order lines whose extras cost cannot be recorded while THIS');
  out('  product has no cost. "on orders worth" is the revenue of those lines —');
  out('  not the extra\'s own value, but the size of what is being reported');
  out('  without a cost beside it.');
}

// ════════════════════════════════════════════════════════════════════════════
rule('2 · THE ONES ALREADY PRICED, FOR CONTRAST');
const pricedPids = [...use.keys()].filter(pid => costOf(pid) != null)
  .sort((a, b) => use.get(b).units - use.get(a).units);
if (!pricedPids.length) {
  out('  None — no sold extra can be priced at all today.');
} else {
  out('  ' + 'product'.padEnd(36) + 'our cost'.padStart(10) + 'lines'.padStart(7) + 'units'.padStart(8));
  out('  ' + '─'.repeat(61));
  for (const pid of pricedPids) {
    const p = product(pid);
    const u = use.get(pid);
    out('  ' + String(p ? p.name_en : '#' + pid).slice(0, 35).padEnd(36)
        + money(costOf(pid)).padStart(10)
        + String(u.lines).padStart(7)
        + String(Math.round(u.units)).padStart(8));
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('3 · THE REAL COVERAGE — LINES, NOT CHOICES');
out('  Counting priceable CHOICES answers an easier question than counting');
out('  priceable LINES, and only the second is the money. One unpriced product');
out('  holds down every line it appears beside, however well costed the rest of');
out('  that line is.');
out();
out('  order lines carrying a stock-linked extra   ' + String(linesWithLink).padStart(6));
out('    every extra on them priceable            ' + String(linesFullyPriceable).padStart(6)
    + '   ' + pct(linesFullyPriceable, linesWithLink));
out('    BLOCKED by at least one unpriced extra   ' + String(linesBlocked).padStart(6)
    + '   ' + pct(linesBlocked, linesWithLink));
out();
out('  Those blocked lines record NULL for their extras — unknown, never zero.');
out('  They are not wrong. They are simply not yet counted, and §162 deliberately');
out('  prefers that to a sum that is quietly low.');

// ════════════════════════════════════════════════════════════════════════════
rule('4 · WHAT FIXING EACH ONE ACTUALLY MEANS');
out('  "Give it a cost" is three different jobs, and sending someone to the wrong');
out('  one is how a list like this gets abandoned half-done.');
out();
let typeIt = 0, mendRecipe = 0, mendBuild = 0;
for (const pid of unpricedPids) {
  const p = product(pid);
  if (!p) { out('  #' + pid + ' — the product is GONE. The choice points at nothing; unlink it.'); continue; }
  let buildLines = 0;
  try {
    buildLines = db.prepare('SELECT COUNT(*) n FROM product_build_lines WHERE product_id = ?').get(pid).n;
  } catch (e) { buildLines = 0; }
  let job, why;
  if (buildLines) {
    job = 'MEND THE BUILD LIST'; mendBuild++;
    why = buildLines + ' line(s) — one of them is unpriced or packaging-only, so the whole list is blocked';
  } else if (p.recipe_id) {
    job = 'MEND THE RECIPE'; mendRecipe++;
    why = 'recipe #' + p.recipe_id + ' — the rollup writes the cost once the recipe can answer';
  } else {
    job = 'TYPE A COST'; typeIt++;
    why = 'no recipe and no build list; the figure has to come from someone who knows it';
  }
  out('  ' + String(p.name_en).slice(0, 32).padEnd(34) + job);
  out('  ' + ' '.repeat(34) + why);
}
out();
out('  type a cost         ' + String(typeIt).padStart(4) + '   fastest, and the only one an operator can finish alone');
out('  mend a recipe       ' + String(mendRecipe).padStart(4) + '   the rollup then writes the cost by itself');
out('  mend a build list   ' + String(mendBuild).padStart(4) + '   usually one unpriced material, or contents never recorded');

out();
out('done.');
