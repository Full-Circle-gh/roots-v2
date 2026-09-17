#!/usr/bin/env node
/**
 * What a product's CHOICES cost us — lib/option-cost.js.
 *
 *   node scripts/test_option_cost.js
 *
 * §166 (Ash, 2026-09-17). Beet Salad offers a choice of two dressings and staff
 * had put BOTH into the recipe, so the product carried ¥11.43 where the truth is
 * ¥8.31 or ¥9.33 — on every sale, not merely on the wasted ones. The fix models
 * the choice as a choice, and that moves the dressing's cost OUT of the recipe.
 * This module is where it lands.
 *
 * WHY EVERY CASE HERE IS ABOUT A ZERO OR A NULL. The arithmetic is a sum; there
 * is nothing to get wrong in it. What can go wrong is what the module says when
 * it does NOT know, and the two failure directions are not symmetrical:
 *
 *   • A choice with no stock link costs a real, knowable ZERO — a sugar level, a
 *     "slice the wrap?". Reporting that as unknown would blank the margin on
 *     nearly every product in the catalogue.
 *   • A choice WITH a link nobody has priced is an UNKNOWN. Reporting that as
 *     zero produces a sum that is confidently low, and low reads as plausible,
 *     which is the one direction that gets a price cut it cannot afford.
 *
 * So the tests that matter are the ones that tell those two apart, and the
 * `linked` counter exists precisely so a caller can.
 *
 * A REAL DATABASE, NOT A STUB. The module reads two tables and prices each link
 * through productUnitCostYuan(), whose own behaviour (a stored 0 read as
 * unknown, a bundle derived from components) is half of what is under test here.
 * Stubbing that out would test the sum and nothing else.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(m)
  : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);

const ROOT = path.join(__dirname, '..');
const { chosenOptionCostYuan, requiredOptionFloorYuan } = require(path.join(ROOT, 'lib', 'option-cost'));

// ── The smallest tree the module reads ─────────────────────────────────────
// store_products for the costs, and the two option tables. bundle_items is
// present because productUnitCostYuan() consults it before unit_cost — a column
// missing here would throw inside the very call under test.
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, name_en TEXT, unit_cost REAL, bundle_items TEXT
  );
  CREATE TABLE retail_product_options (
    id INTEGER PRIMARY KEY, product_id INTEGER, type TEXT,
    is_required INTEGER DEFAULT 0, min_choices INTEGER DEFAULT 0
  );
  CREATE TABLE retail_product_option_choices (
    id INTEGER PRIMARY KEY, option_id INTEGER, stock_product_id INTEGER
  );
`);
const prod = db.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)');
prod.run(1,  'Beet Salad',          6.2159);
prod.run(10, 'Beet salad dressing', 3.1143);
prod.run(11, 'Ginger Tahini',       2.0983);
// A product that exists and has NO cost — the unknown the module must not
// silently treat as free. 0 rather than NULL deliberately: productUnitCostYuan
// reads a stored 0 as unknown too, and a test that only covered NULL would miss
// the half of the catalogue that carries a zero.
prod.run(12, 'Unpriced dip',        0);

const opt = db.prepare('INSERT INTO retail_product_options (id, product_id, type, is_required, min_choices) VALUES (?,?,?,?,?)');
const cho = db.prepare('INSERT INTO retail_product_option_choices (id, option_id, stock_product_id) VALUES (?,?,?)');

// ════════════════════════════════════════════════════════════════════════════
section('1 · chosenOptionCostYuan — what the extras on ONE sold line cost');

is(chosenOptionCostYuan(db, []),
   { yuan: null, linked: 0, uncosted: 0 },
   'no options at all → null, and linked 0 says WHICH null it is');

is(chosenOptionCostYuan(db, [{ choice_id: 5, label_en: 'No' }]),
   { yuan: null, linked: 0, uncosted: 0 },
   'a label with no stock link is not a thing — nothing to record');

is(chosenOptionCostYuan(db, [{ stock_product_id: 10 }]),
   { yuan: 3.1143, linked: 1, uncosted: 0 },
   'one linked choice → that product\'s cost');

is(chosenOptionCostYuan(db, [{ stock_product_id: 10 }, { stock_product_id: 11 }]),
   { yuan: 3.1143 + 2.0983, linked: 2, uncosted: 0 },
   'two linked choices → their sum');

// THE ONE THAT MATTERS. A sum missing one contributor is worse than no sum: it
// is low, and low reads as plausible.
is(chosenOptionCostYuan(db, [{ stock_product_id: 10 }, { stock_product_id: 12 }]),
   { yuan: null, linked: 2, uncosted: 1 },
   'one unpriced link BLOCKS the whole figure rather than contributing zero');

is(chosenOptionCostYuan(db, [{ stock_product_id: 999 }]),
   { yuan: null, linked: 1, uncosted: 1 },
   'a link to a product that no longer exists is unknown, never free');

// A label riding alongside a real extra must not disturb the sum — this is the
// ordinary shape of options_json, which carries every answer the customer gave.
is(chosenOptionCostYuan(db, [{ choice_id: 1 }, { stock_product_id: 11 }, { choice_id: 2 }]),
   { yuan: 2.0983, linked: 1, uncosted: 0 },
   'labels mixed with a real extra → only the extra counts');

is(chosenOptionCostYuan(db, null),
   { yuan: null, linked: 0, uncosted: 0 },
   'a null options array (the column\'s own empty value) does not throw');

// ════════════════════════════════════════════════════════════════════════════
section('2 · requiredOptionFloorYuan — the worst the product can oblige us to');

is(requiredOptionFloorYuan(db, 1),
   { yuan: 0, groups: 0, uncosted: 0 },
   'no option groups → a real, knowable zero (nearly every product today)');

// Beet Salad as §166 says it should be: one required single, two dressings.
opt.run(1, 1, 'single', 1, 0);
cho.run(1, 1, 10);      // Beet salad dressing 3.1143
cho.run(2, 1, 11);      // Ginger Tahini       2.0983
is(requiredOptionFloorYuan(db, 1),
   { yuan: 3.1143, groups: 1, uncosted: 0 },
   'required single → the DEAREST choice, never the cheapest and never a mean');

// An OPTIONAL group must never reach the floor: it is revenue the customer
// volunteered, and charging every unit for it is the same error mirrored.
opt.run(2, 1, 'multi', 0, 0);
cho.run(3, 2, 10);
is(requiredOptionFloorYuan(db, 1),
   { yuan: 3.1143, groups: 1, uncosted: 0 },
   'an optional group adds nothing, however dear its choices');

// A required multi takes its floor — "Choose 2 crunchy sides" is min 2 / max 2,
// and two of them are two costs.
const db2 = new Database(':memory:');
db2.exec(db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all().map(r => r.sql + ';').join('\n'));
const p2 = db2.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)');
p2.run(1, 'Platter', 20); p2.run(20, 'A', 5); p2.run(21, 'B', 3); p2.run(22, 'C', 1);
db2.prepare('INSERT INTO retail_product_options (id, product_id, type, is_required, min_choices) VALUES (?,?,?,?,?)')
   .run(1, 1, 'multi', 1, 2);
const c2 = db2.prepare('INSERT INTO retail_product_option_choices (id, option_id, stock_product_id) VALUES (?,?,?)');
c2.run(1, 1, 20); c2.run(2, 1, 21); c2.run(3, 1, 22);
is(requiredOptionFloorYuan(db2, 1),
   { yuan: 8, groups: 1, uncosted: 0 },
   'required multi min 2 → the TWO dearest (5+3), not all three and not one');

// A required multi with no floor still obliges one answer — is_required is the
// older, coarser form of the same rule and routes/retail.js treats it so.
db2.prepare('UPDATE retail_product_options SET min_choices = 0 WHERE id = 1').run();
is(requiredOptionFloorYuan(db2, 1),
   { yuan: 5, groups: 1, uncosted: 0 },
   'required multi with min 0 still takes one — the dearest');

// A group mixing a label with a thing: the cheapest required answer is free, so
// the dearest is still the thing. The label must not be skipped as if absent —
// it is a true fact about the group — but it must not lower the worst case.
const db3 = new Database(':memory:');
db3.exec(db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all().map(r => r.sql + ';').join('\n'));
db3.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)').run(1, 'Wrap', 6);
db3.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)').run(30, 'Sauce', 2);
db3.prepare('INSERT INTO retail_product_options (id, product_id, type, is_required, min_choices) VALUES (?,?,?,?,?)')
   .run(1, 1, 'single', 1, 0);
db3.prepare('INSERT INTO retail_product_option_choices (id, option_id, stock_product_id) VALUES (?,?,?)').run(1, 1, null);
db3.prepare('INSERT INTO retail_product_option_choices (id, option_id, stock_product_id) VALUES (?,?,?)').run(2, 1, 30);
is(requiredOptionFloorYuan(db3, 1),
   { yuan: 2, groups: 1, uncosted: 0 },
   'a label beside a thing → the thing is the worst case');

// THE ONE THAT MATTERS, again. An unpriced link inside a REQUIRED group makes
// the floor unknown, because the choice nobody could read might be the dearest
// one — so the figure we CAN compute is a lower bound wearing a worst case's
// clothes.
db3.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)').run(31, 'Unpriced', 0);
db3.prepare('INSERT INTO retail_product_option_choices (id, option_id, stock_product_id) VALUES (?,?,?)').run(3, 1, 31);
is(requiredOptionFloorYuan(db3, 1).yuan, null,
   'an unpriced link in a REQUIRED group → null floor, never a partial sum');
is(requiredOptionFloorYuan(db3, 1).uncosted, 1,
   '...and it says how many it could not price');

// A text group has no choices at all and must not be mistaken for an empty one.
const db4 = new Database(':memory:');
db4.exec(db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all().map(r => r.sql + ';').join('\n'));
db4.prepare('INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (?,?,?,NULL)').run(1, 'Cake', 30);
db4.prepare('INSERT INTO retail_product_options (id, product_id, type, is_required, min_choices) VALUES (?,?,?,?,?)')
   .run(1, 1, 'text', 1, 0);
is(requiredOptionFloorYuan(db4, 1),
   { yuan: 0, groups: 0, uncosted: 0 },
   'a required free-text question ("name on the cake") adds nothing');

is(requiredOptionFloorYuan(db, null),
   { yuan: 0, groups: 0, uncosted: 0 },
   'no product id → zero, not a throw');

// ════════════════════════════════════════════════════════════════════════════
section('3 · a handle with no options tables at all');
// Every in-memory fixture predating §166 is this shape. It must read as "no
// options" rather than disabling costing for everything downstream — the same
// try/catch discipline lib/recipe-rollup.js holds around product_build_lines.
const bare = new Database(':memory:');
bare.exec('CREATE TABLE store_products (id INTEGER PRIMARY KEY, unit_cost REAL, bundle_items TEXT);');
is(requiredOptionFloorYuan(bare, 1),
   { yuan: 0, groups: 0, uncosted: 0 },
   'missing option tables → no floor, no throw');
is(chosenOptionCostYuan(bare, [{ stock_product_id: 1 }]).yuan, null,
   'and a link into an empty catalogue is unknown, not free');

// ════════════════════════════════════════════════════════════════════════════
section('4 · §166\'s worked example, end to end');
// The numbers from the live diagnostic, so a future reader can check the module
// against the report that justified it.
const base = 6.2159;
const withBeet   = base + requiredOptionFloorYuan(db, 1).yuan;
const soldTahini = base + chosenOptionCostYuan(db, [{ stock_product_id: 11 }]).yuan;
is(Number(withBeet.toFixed(2)),   9.33, 'catalogue floor: ¥6.22 salad + dearest dressing = ¥9.33');
is(Number(soldTahini.toFixed(2)), 8.31, 'a sale of the ginger tahini one: ¥8.31');
// And the number the product carried before §166, which is neither of them.
is(Number((base + 3.1143 + 2.0983).toFixed(2)), 11.43,
   'both dressings in one recipe was ¥11.43 — the figure this section removes');

console.log('\n' + (fail ? `FAIL  ${fail} failed, ${pass} passed` : `PASS  ${pass} checks`));
process.exit(fail ? 1 : 0);
