#!/usr/bin/env node
/**
 * diagnose_option_cost_gap.js — if a chosen dressing leaves the recipe and
 * becomes an option, what happens to the money?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-17, on Beet Salad: the customer picks one of two dressings and
 * staff put BOTH in the recipe. The product therefore carries the cost of a
 * dressing it did not ship — ¥11.43 where the true figure is ¥8.31 or ¥9.33 —
 * on every sale, not merely on the wasted ones.
 *
 * The agreed fix is to model the choice as a choice: the recipe holds the salad
 * WITHOUT dressing, each dressing becomes a real product, and
 * retail_product_option_choices.stock_product_id links the two. expandStockLines
 * already reserves and deducts a stock-linked choice alongside its parent, so
 * stock needs nothing built.
 *
 * THE MONEY IS THE PART THAT IS NOT ALREADY HANDLED, and this measures the hole
 * before any of it is coded:
 *
 *   1. costAtSale() stamps retail_order_items.unit_cost_at_sale through
 *      productUnitCostYuan(db, productId) — a function that takes a product id
 *      and NOTHING ELSE. It cannot see which dressing was picked, so the moment
 *      the dressing leaves the recipe the sale snapshot silently loses it.
 *      A chosen add-on is not an order ITEM either (expandStockLines contributes
 *      stock demand, not a line), so nothing else picks it up.
 *   2. The catalogue/editor figure has no customer and no choice, so it needs a
 *      different answer from the sale: the DEAREST choice, which is the only one
 *      that cannot flatter a margin.
 *   3. Waste is the one reader that should NOT change. Once the dressing is its
 *      own stocked product, a binned salad is a binned salad; a binned dressing
 *      is its own record. That is the original ask solved by modelling rather
 *      than by the "was the dressing kept?" tick I proposed first.
 *
 * So: three readers, three different right answers, and this establishes which
 * of them have live data behind them today.
 *
 * IT ALSO SIZES THE BUG. Section 3 lists every recipe carrying two or more
 * dressing-ish lines — the shape Beet Salad turned out to be. If that list is
 * one row the fix is a data edit; if it is ten, the same wrong cost is sitting
 * under ten products right now.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Read-only, and it proves it: the
 * database is opened `readonly: true` and a write is attempted and REQUIRED to
 * fail before any query runs.
 *
 * WHICH ID SPACE OPTIONS LIVE IN IS MEASURED, NOT ASSUMED. The table declares
 * `FOREIGN KEY (product_id) REFERENCES products(id)` — the KITCHEN table — while
 * the retail admin saves them against store_products ids. Section 1 counts the
 * matches both ways rather than picking one and hoping, because a join taken on
 * the wrong space would report "no options exist" on a catalogue full of them.
 *
 * THE DRESSING MATCH IS THE SAME HEURISTIC diagnose_dressing_waste.js used, and
 * is labelled the same way: there is no "dressing" concept in the schema, which
 * is the whole reason this modelling question is open. Every match is printed.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_option_cost_gap.js
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
const sub = (t) => { out(); out('── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const money = (n) => n == null ? '—' : '¥' + (Number(n) || 0).toFixed(2);
const pct = (num, den) => (!Number(den) ? '—' : ((100 * Number(num)) / Number(den)).toFixed(1) + '%');

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[option-cost] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _option_cost_write_probe (x INTEGER)').run();
  console.error('[option-cost] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[option-cost] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

const DRESSING_RE = /dressing|vinaigrette|tahini|tzatziki|aioli|zhoug|mayo|mayonnaise|sauce|dip|pesto|chimichurri|harissa|hummus/i;
const looksDressing = (n) => DRESSING_RE.test(String(n || ''));

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

// ════════════════════════════════════════════════════════════════════════════
rule('1 · DO OPTION GROUPS EXIST, AND IN WHICH ID SPACE');
const optRows = db.prepare('SELECT * FROM retail_product_options').all();
out('  option groups on file          ' + String(optRows.length).padStart(5));
if (!optRows.length) {
  out('  NONE. Nothing is using this feature yet, so the modelling change starts');
  out('  from zero and every figure below is a forecast rather than a measurement.');
} else {
  const pids = [...new Set(optRows.map(o => o.product_id))];
  const inStore = db.prepare(
    `SELECT COUNT(*) n FROM store_products WHERE id IN (${pids.map(() => '?').join(',')})`
  ).get(...pids).n;
  let inKitchen = 0;
  try {
    inKitchen = db.prepare(
      `SELECT COUNT(*) n FROM products WHERE id IN (${pids.map(() => '?').join(',')})`
    ).get(...pids).n;
  } catch (e) { inKitchen = -1; }
  out('  distinct product ids           ' + String(pids.length).padStart(5));
  out('    matching store_products      ' + String(inStore).padStart(5));
  out('    matching kitchen products    ' + String(inKitchen).padStart(5));
  out('  The larger match is the live id space. Both tables can hold the same id,');
  out('  so this is evidence rather than proof — but a near-total match on one and');
  out('  a sparse one on the other settles it in practice.');

  const byType = {};
  for (const o of optRows) byType[o.type] = (byType[o.type] || 0) + 1;
  out();
  out('  by type: ' + Object.entries(byType).map(([k, v]) => k + '=' + v).join('  '));
  out('  required groups: ' + optRows.filter(o => o.is_required).length);
}

// ════════════════════════════════════════════════════════════════════════════
rule('2 · EVERY OPTION GROUP, ITS CHOICES, AND WHAT EACH CHOICE COSTS US');
out('  price_delta is what the CUSTOMER pays extra. `cost` is what the linked');
out('  stock product costs US — the figure that goes missing from the sale');
out('  snapshot the moment a dressing leaves the recipe. A choice with no stock');
out('  link has no cost of its own and never will: it is a label, not a thing.');

const choiceRows = db.prepare('SELECT * FROM retail_product_option_choices').all();
const byOpt = new Map();
for (const c of choiceRows) {
  if (!byOpt.has(c.option_id)) byOpt.set(c.option_id, []);
  byOpt.get(c.option_id).push(c);
}
let linkedChoices = 0, costedLinks = 0;
for (const o of optRows) {
  const cs = byOpt.get(o.id) || [];
  const owner = db.prepare('SELECT name_en, sell_price, unit_cost FROM store_products WHERE id = ?').get(o.product_id);
  sub(`${owner ? owner.name_en : '(product #' + o.product_id + ' not in store_products)'}  ·  "${o.question_en}"`);
  out('    type ' + o.type + (o.is_required ? ' · required' : ' · optional')
      + (o.type === 'multi' ? ` · min ${o.min_choices} max ${o.max_choices}` : '')
      + (owner ? `   ·   price ${money(owner.sell_price)}   cost now ${money(owner.unit_cost)}` : ''));
  if (!cs.length) { out('    (no choices)'); continue; }
  out('    ' + 'choice'.padEnd(34) + 'price+'.padStart(9) + 'stock link'.padStart(12) + 'our cost'.padStart(10));
  out('    ' + '─'.repeat(66));
  for (const c of cs) {
    let linkName = '—', linkCost = null;
    if (c.stock_product_id) {
      linkedChoices++;
      const sp = db.prepare('SELECT name_en FROM store_products WHERE id = ?').get(c.stock_product_id);
      linkName = sp ? String(sp.name_en).slice(0, 11) : '#' + c.stock_product_id + '?';
      try { linkCost = productUnitCostYuan(db, c.stock_product_id); } catch (e) { linkCost = null; }
      if (linkCost != null) costedLinks++;
    }
    out('    ' + String(c.label_en || c.label_cn || '').slice(0, 33).padEnd(34)
        + money(c.price_delta).padStart(9)
        + String(linkName).padStart(12)
        + (linkCost == null ? '—' : money(linkCost)).padStart(10)
        + (c.is_default ? '   default' : '')
        + (looksDressing(c.label_en) || looksDressing(c.label_cn) ? '   ← dressing?' : ''));
  }
}
out();
out('  choices with a stock link                ' + String(linkedChoices).padStart(5));
out('  ...of those, ones we can cost            ' + String(costedLinks).padStart(5));
out('  A linked choice we cannot cost is the same hole as an uncosted product:');
out('  it would subtract nothing and read as free.');

// ════════════════════════════════════════════════════════════════════════════
rule('3 · HOW BIG IS THE BEET SALAD BUG? (recipes carrying 2+ dressing lines)');
out('  Beet Salad turned out to hold both halves of a choice. Every recipe below');
out('  is the same SHAPE and may be the same mistake — or may genuinely contain');
out('  all of them. A human has to say which; this only finds the candidates.');
out();
const recipes = db.prepare('SELECT id, name_en, name_cn, servings FROM recipes WHERE COALESCE(is_active,1)=1').all();
const linesFor = db.prepare(`SELECT ri.name_en, ri.qty, ri.unit, i.cost_per_unit, i.name_en AS master_name
   FROM recipe_ingredients ri LEFT JOIN ingredients i ON i.id = ri.ingredient_id WHERE ri.recipe_id = ?`);
let candidates = 0;
for (const r of recipes) {
  const ls = linesFor.all(r.id);
  const hits = ls.filter(l => looksDressing(l.name_en) || looksDressing(l.master_name));
  if (hits.length < 2) continue;
  candidates++;
  const linked = db.prepare(
    'SELECT id, name_en, unit_cost, sell_price FROM store_products WHERE recipe_id = ? AND COALESCE(is_active,1)=1'
  ).all(r.id);
  sub(`${r.name_en}  ·  recipe #${r.id}  ·  ${r.servings || '?'} servings`);
  for (const h of hits) {
    const per = (h.cost_per_unit && r.servings) ? (h.qty * h.cost_per_unit) / r.servings : null;
    out('    ' + String(h.name_en || '').slice(0, 36).padEnd(38)
        + String(h.qty).padStart(8) + ' ' + String(h.unit || '').padEnd(4)
        + (per == null ? '—' : money(per)).padStart(10) + ' per unit');
  }
  for (const p of linked) {
    out('    → product "' + p.name_en + '"  cost ' + money(p.unit_cost) + '  price ' + money(p.sell_price));
  }
}
out();
out('  recipes with 2+ dressing-ish lines   ' + String(candidates).padStart(4) + ' of ' + recipes.length);
out('  One row = a data edit. Ten rows = the same wrong cost under ten products.');

// ════════════════════════════════════════════════════════════════════════════
rule('4 · DO THE DRESSINGS EXIST AS PRODUCTS YET?');
out('  A choice can only carry a cost if it links to a real store product. These');
out('  are the dressing MATERIALS from the recipes, matched by name against the');
out('  product catalogue — a match means the product to link already exists, a');
out('  miss means one has to be created before the choice can be costed.');
out();
const dressMats = db.prepare(
  'SELECT id, name_en, name_cn, cost_per_unit, unit FROM ingredients WHERE COALESCE(is_active,1)=1'
).all().filter(m => looksDressing(m.name_en));
const prodByName = new Map();
for (const p of db.prepare('SELECT id, name_en, unit_cost, recipe_id FROM store_products WHERE COALESCE(is_active,1)=1').all()) {
  prodByName.set(String(p.name_en || '').trim().toLowerCase(), p);
}
let haveProduct = 0;
out('  ' + 'dressing material'.padEnd(38) + 'recipes'.padStart(8) + '   product exists?');
out('  ' + '─'.repeat(72));
for (const m of dressMats) {
  const uses = db.prepare('SELECT COUNT(DISTINCT recipe_id) n FROM recipe_ingredients WHERE ingredient_id = ?').get(m.id).n;
  if (!uses) continue;
  const p = prodByName.get(String(m.name_en || '').trim().toLowerCase());
  if (p) haveProduct++;
  out('  ' + String(m.name_en).slice(0, 37).padEnd(38)
      + String(uses).padStart(8)
      + '   ' + (p ? 'yes — #' + p.id + ' cost ' + money(p.unit_cost) : 'NO — would need creating'));
}
out();
out('  ' + haveProduct + ' of the dressings already exist as products.');

// ════════════════════════════════════════════════════════════════════════════
rule('5 · THE THREE READERS, AND WHAT EACH WOULD NEED');
out('  Stated here so the build has one place to disagree with.');
out();
out('  WASTE          unchanged. Once a dressing is its own stocked product, a');
out('                 binned salad is a binned salad and a binned dressing is its');
out('                 own record. No tick, no question, no subtraction.');
out();
out('  SALE SNAPSHOT  needs the CHOSEN choice\'s cost added. costAtSale() takes a');
out('                 product id and nothing else today, and a stock-linked choice');
out('                 is not an order item, so this is a real hole rather than a');
out('                 refinement.');
out();
out('  CATALOGUE      needs the DEAREST required choice added. There is no');
out('  / MARGIN       customer and no choice at that moment, and the dearest is the');
out('                 only answer that cannot flatter a margin.');
out();
const ordersWithOpts = db.prepare(
  "SELECT COUNT(*) n FROM retail_order_items WHERE options_json IS NOT NULL AND options_json != '' AND options_json != '[]'"
).get().n;
const totalItems = db.prepare('SELECT COUNT(*) n FROM retail_order_items').get().n;
out('  order lines carrying options  ' + String(ordersWithOpts).padStart(7) + ' of ' + totalItems
    + '   ' + pct(ordersWithOpts, totalItems));
out('  That is how much history the sale-snapshot change would newly describe.');

out();
out('done.');
