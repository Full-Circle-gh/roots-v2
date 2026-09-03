#!/usr/bin/env node
/**
 * `products:costs` — the cost and margin gate on the catalogue.
 *
 *   node scripts/test_product_cost_visibility.js
 *
 * Third and widest of the three bundles that split money out of a "view"
 * capability (waste, materials, products — Ash, 2026-09-02/03). `products:view`
 * carried money:'shows' with the note "The product list shows unit cost and
 * margin", and FIVE presets hold it — including `staff`, commented in
 * lib/capabilities.js as having "no money-sensitive powers", and `marketing`,
 * "no operations/money". Both read a margin percentage on every row.
 *
 * TWO HALVES, and the second is the one that is data loss rather than
 * disclosure:
 *
 *   READ  — unit_cost and cost_incomplete leave every product payload: the
 *           grid (where the Margin column is built), the record, the
 *           post-save row, and the CSV export.
 *   WRITE — the editor hides the Cost field, its g() helper returns '' for a
 *           missing element, and '' is parsed to NULL on the way in. So
 *           editing a product's NAME would have wiped its cost, blanked the
 *           margin everywhere it is read, and cleared the cost_incomplete tag
 *           with it.
 *
 * WHY THIS TESTS A MODULE AND ITS SIBLINGS MOUNT A ROUTE.
 * test_waste_cost_visibility.js and test_material_cost_visibility.js each stand
 * their route up on a bare express app, because those files are small enough to
 * drive. routes/retail.js is ~32,000 lines with the entire product surface in
 * it and cannot be stood up that way, so the rules were extracted to
 * lib/product-cost-visibility.js and are held to the same contract here. The
 * route's four read sites and one write site call exactly these functions.
 */
'use strict';

const V = require('../lib/product-cost-visibility');
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

const reqWith    = { caps: new Set(['products:view', 'products:costs', 'products:edit']) };
const reqWithout = { caps: new Set(['products:view', 'products:edit']) };
const reqNoCaps  = { caps: null };

// A product row as the grid and the record serve it. Sell price and compare-at
// are customer-facing and must survive; unit_cost and its tag must not.
const row = () => ({
  id: 42, sku: '10188', name_en: 'Oat milk 1L', name_cn: '燕麦奶',
  sell_price: 32, compare_at_price: 38, unit_cost: 24, cost_incomplete: 1,
  stock_qty: 12, status: 'Active', is_published: 1,
});

(async () => {
  section('1 · reading one product');
  {
    const yes = V.stripProductCosts(reqWith, row());
    const no  = V.stripProductCosts(reqWithout, row());
    is(yes.unit_cost, 24, 'with products:costs, the cost is sent');
    present(yes, 'cost_incomplete', 'and the tag that qualifies it');
    absent(no, 'unit_cost', 'without it, no cost');
    // The tag is a statement about that exact figure; a payload carrying it
    // without the cost describes a number that is not there.
    absent(no, 'cost_incomplete', 'and no tag about a figure that is gone');
    // SELL PRICE IS NOT WHAT MOVES. What a customer is charged is on the
    // storefront — withholding it would break the catalogue for no gain.
    is(no.sell_price, 32, 'the sell price stays — it is on the storefront');
    is(no.compare_at_price, 38, 'and so does the compare-at price');
    is(no.name_en, 'Oat milk 1L', 'the product is still a product');
    is(no.stock_qty, 12, 'and still has stock');
  }

  section('2 · reading the grid');
  {
    const rows = [row(), row()];
    V.stripProductCosts(reqWithout, rows);
    is(rows.length, 2, 'no row is dropped');
    is(rows.every(r => !('unit_cost' in r)), true, 'and none keeps a cost');
    // One call site for a row or an array, so a read cannot be half-gated.
    const kept = [row()];
    V.stripProductCosts(reqWith, kept);
    is(kept[0].unit_cost, 24, 'a permitted reader still gets every row costed');
  }

  section('3 · the write — you cannot change what you cannot see');
  {
    // What the editor actually sends with the Cost field hidden: g() returns ''
    // for a missing element, and the route parses '' to NULL.
    const body = { name_en: 'Oat milk 1L (organic)', unit_cost: '', cost_incomplete: false };
    V.stripProductCostWrites(reqWithout, body);
    absent(body, 'unit_cost', 'the cost key is dropped, so no branch writes it');
    absent(body, 'cost_incomplete', 'and the tag with it');
    is(body.name_en, 'Oat milk 1L (organic)', 'while the edit itself survives');

    const allowed = { name_en: 'x', unit_cost: '26' };
    V.stripProductCostWrites(reqWith, allowed);
    is(allowed.unit_cost, '26', 'an operator who may see a cost may still set one');
  }

  section('4 · the fail-closed rule');
  {
    // Every other capability check in this product answers "unknown ⇒ allow".
    // Money inverts the trade, and 01-core.js says so beside its own can().
    falsy(V.canSeeProductCosts(reqNoCaps), 'an unresolved cap set may not read costs');
    falsy(V.canSeeProductCosts({}), 'nor a request with no caps at all');
    falsy(V.canSeeProductCosts(undefined), 'nor no request');
    const stripped = V.stripProductCosts(reqNoCaps, row());
    absent(stripped, 'unit_cost', 'and is sent none');
    is(stripped.name_en, 'Oat milk 1L', 'while the catalogue still answers');
    truthy(V.canSeeProductCosts(reqWith), 'a holder reads them');
  }

  section('5 · the capability itself');
  {
    falsy(caps.MONEY_KEYS['products:view'], 'the catalogue itself shows no money');
    is(caps.MONEY_KEYS['products:costs'], 'shows', 'its cost and margin are where the money is');
    truthy(caps.MONEY_NOTES['products:costs'], 'and it carries the note that argues the coin');
    // The two presets whose own comments claim no money were reading a margin
    // percentage on every row. That is the finding this whole change came from.
    for (const role of ['staff', 'marketing', 'warehouse', 'store_manager']) {
      const set = caps.presetCapsFor(role);
      truthy(set.includes('products:view'), role + ' still opens the catalogue');
      falsy(set.includes('products:costs'), role + ' does NOT read cost or margin');
    }
    for (const role of ['owner', 'admin', 'manager']) {
      truthy(caps.presetCapsFor(role).includes('products:costs'), role + ' does');
    }
    // store_manager keeps products:edit — they price for their store. They just
    // price without seeing what it cost, which is the decision, not an accident.
    truthy(caps.presetCapsFor('store_manager').includes('products:edit'),
      'a store manager still sets what customers are charged');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
