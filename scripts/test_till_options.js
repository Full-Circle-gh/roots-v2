#!/usr/bin/env node
/**
 * The counter asks the questions the QR menu asks — §183.
 *
 *   node scripts/test_till_options.js
 *
 * ── THE BUG THIS SUITE EXISTS FOR ─────────────────────────────────────────
 * Reported by Ash from a live Yuexiu till: *"the till doesn't show the variants
 * of the products"*, then, when told sizes were the smaller half: *"there are
 * few options customers need to do it's not just size. stuff like hot or iced,
 * extra shoot etc"*.
 *
 * TWO DEFECTS WITH ONE REPORT.
 *
 *   1. THE SIZE WAS NEVER READ. Variants are independent store_products rows
 *      linked by variant_group_id, carrying the SAME name. The counter
 *      catalogue query never selected variant_label, so two sizes of one drink
 *      drew two tiles reading "Latte" and "Latte" at two prices, with the size
 *      written nowhere. §129 found and fixed exactly this on the QR menu and
 *      the counter kept it.
 *
 *   2. THE QUESTIONS WERE NEVER ASKED, AND COULD NOT HAVE BEEN ANSWERED. Hot
 *      or iced, extra shot, sugar level — §120's machinery, which exactly one
 *      surface could reach. The till read no options, and the road behind the
 *      buttons stopped anyway: resolveManualOrderLines ignored `choices`, and
 *      the manual-order INSERT carried no options_json column. A till that had
 *      collected an answer would have dropped it between the cashier's tap and
 *      the kitchen's ticket — no iced on the slip, no money for the shot, no
 *      oat milk off the shelf. THAT is the case this suite guards hardest:
 *      silently losing the answer is worse than never asking for it.
 *
 * ── WHAT IS HELD HERE ─────────────────────────────────────────────────────
 * Read side, over the REAL express router against a REAL sqlite database, so
 * every body printed is observed:
 *   1. The size comes back on the row, in both languages.
 *   2. The questions come back, in the operator's order, limits already
 *      clamped — the till is handed answers, never rules to compute.
 *   3. A stock-backed extra that has run out is marked `out`, not removed.
 *   4. A REQUIRED question with every answer gone takes the product with it.
 *   5. The shelf link rides the till's payload and NOT the public QR menu's.
 *
 * Write side, against lib/product-options with the same database:
 *   6. A line is priced base + deltas, and the POST BODY CANNOT PRICE IT.
 *   7. A choice belonging to another product is refused.
 *   8. A single-answer question answered twice is refused.
 *   9. A required question left out is refused.
 *  10. A pick-any group's floor and ceiling both bind.
 *  11. The snapshot is bilingual and carries the question, so a ticket printed
 *      next year still reads "Heat up?: Yes" after the option is deleted.
 *  12. Stock-backed extras aggregate one per unit bought, across lines.
 *
 * And the wiring neither of those can see, asserted against source:
 *  13. The INSERT writes options_json, from the TRANSACTION handle (§24).
 *  14. The till posts choice ids and the BASE price, never the summed one.
 *  15. The till prints the size on the tile and searches it.
 *
 * TO PROVE THE SUITE CAN FAIL: TILLOPT_MUTANT=1 node scripts/test_till_options.js
 * The mutant makes resolveAnswers trust the posted delta instead of the column,
 * which is the exact failure the module exists to prevent. Per §24 it ASSERTS
 * IT MODIFIED THE SOURCE before its red counts as evidence.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const MUTANT = process.env.TILLOPT_MUTANT === '1';

function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../middleware/auth', { logActivity: () => {} });

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const productOptions = require(path.join(ROOT, 'lib', 'product-options.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the blocks the sibling suites use.
const LOC   = 9871;
const SHOP  = 9881;

const P_SMALL  = 9971;  // Latte · Regular — a variant, on the menu, made here
const P_LARGE  = 9972;  // Latte · Large   — its sibling, same name, own price
const P_PLAIN  = 9973;  // no siblings, no questions — the ordinary tile
const P_OAT    = 9974;  // oat milk: a stock-backed extra AND a product of its own
const P_DEAD   = 9975;  // an extra with nothing on the shelf — §47 says sold out
const P_GONE   = 9976;  // a drink whose ONLY milk is P_DEAD — cannot be made

const ALL_PRODUCTS = [P_SMALL, P_LARGE, P_PLAIN, P_OAT, P_DEAD, P_GONE];

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  const ph = ALL_PRODUCTS.join(',');
  db.prepare(`DELETE FROM retail_product_option_choices
               WHERE option_id IN (SELECT id FROM retail_product_options
                                    WHERE product_id IN (${ph}))`).run();
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run();
  db.prepare('DELETE FROM shop_listings WHERE shop_id = ?').run(SHOP);
  db.prepare('DELETE FROM shops WHERE id = ? OR location_id = ?').run(SHOP, LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run();
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}
cleanup();

db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_opt_loc', 'Options fixture', '测试选项', 1, 95)`).run(LOC);
db.prepare(`INSERT INTO shops (id, location_id, public_code, is_active)
            VALUES (?, ?, '__OPTFX', 1)`).run(SHOP, LOC);

// THE TWO SIZES SHARE A NAME, WHICH IS THE POINT. They are told apart by
// variant_label and by nothing else — which is precisely why a till that did
// not read it drew one word twice.
const insProduct = db.prepare(`
  INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category,
                              is_active, is_published, is_restock_only,
                              variant_group_id, variant_label, variant_label_cn, variant_sort)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?)`);
insProduct.run(P_SMALL, 'Fixture latte', '测试拿铁', '__O-9971', 28, 'Drinks', 0, P_SMALL, 'Regular', '中杯', 0);
insProduct.run(P_LARGE, 'Fixture latte', '测试拿铁', '__O-9972', 34, 'Drinks', 0, P_SMALL, 'Large',   '大杯', 1);
insProduct.run(P_PLAIN, 'Fixture scone', '测试司康', '__O-9973', 16, 'Bakery', 1, null, null, null, null);
insProduct.run(P_OAT,   'Fixture oat milk', '测试燕麦奶', '__O-9974', 6, 'Drinks', 1, null, null, null, null);
insProduct.run(P_DEAD,  'Fixture soy milk', '测试豆奶',   '__O-9975', 6, 'Drinks', 0, null, null, null, null);
insProduct.run(P_GONE,  'Fixture flat white', '测试馥芮白', '__O-9976', 30, 'Drinks', 0, null, null, null, null);

const insStock = db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
                             VALUES (?, ?, ?, ?)`);
insStock.run(LOC, P_OAT, 4, 0);
insStock.run(LOC, P_PLAIN, 9, 0);
// P_DEAD gets NO row at all: §47 reads an absent shelf record as sold out, not
// as untracked, and that is the state a greyed extra must come from.

const insListing = db.prepare(`
  INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
  VALUES (?, ?, ?, ?, 1, ?)`);
insListing.run(SHOP, P_SMALL, 30, 'made_here', 0);
insListing.run(SHOP, P_LARGE, 36, 'made_here', 1);
insListing.run(SHOP, P_PLAIN, 18, 'stocked',   2);
insListing.run(SHOP, P_GONE,  32, 'made_here', 3);

const insOpt = db.prepare(`
  INSERT INTO retail_product_options (product_id, question_en, question_cn, type,
                                      is_required, min_choices, max_choices, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insChoice = db.prepare(`
  INSERT INTO retail_product_option_choices (option_id, label_en, label_cn, price_delta,
                                             is_default, stock_product_id, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Q1 — hot or iced. Required, single answer, free, and FIRST in the operator's
// order. Sorted deliberately after Q2 by id so the sort_order is load-bearing.
const Q_TEMP = insOpt.run(P_SMALL, 'Hot or iced?', '冷热?', 'single', 1, 0, 0, 0).lastInsertRowid;
const C_HOT  = insChoice.run(Q_TEMP, 'Hot',  '热', 0, 1, null, 0).lastInsertRowid;
const C_ICED = insChoice.run(Q_TEMP, 'Iced', '冰', 0, 0, null, 1).lastInsertRowid;

// Q2 — extras. Pick any, at most two, and one of them comes off a real shelf.
const Q_EXTRA = insOpt.run(P_SMALL, 'Extras', '加料', 'multi', 0, 0, 2, 1).lastInsertRowid;
const C_SHOT  = insChoice.run(Q_EXTRA, 'Extra shot', '多一份浓缩', 6, 0, null, 0).lastInsertRowid;
const C_OAT   = insChoice.run(Q_EXTRA, 'Oat milk',   '燕麦奶',     4, 0, P_OAT,  1).lastInsertRowid;
const C_SOY   = insChoice.run(Q_EXTRA, 'Soy milk',   '豆奶',       4, 0, P_DEAD, 2).lastInsertRowid;

// Q3 — a required question on ANOTHER product whose only answer is off the
// shelf. The product cannot be made and must not be offered.
const Q_MILK = insOpt.run(P_GONE, 'Milk?', '奶?', 'single', 1, 0, 0, 0).lastInsertRowid;
insChoice.run(Q_MILK, 'Soy milk', '豆奶', 0, 1, P_DEAD, 0);   // the only milk, and it is gone

// Q4 — a pick-any with a FLOOR, used to prove min binds and that the floor is
// measured against what is still pickable.
const Q_SIDES = insOpt.run(P_LARGE, 'Sides', '配菜', 'multi', 0, 2, 2, 0).lastInsertRowid;
const C_S1 = insChoice.run(Q_SIDES, 'Side one',   '配一', 0, 0, null, 0).lastInsertRowid;
const C_S2 = insChoice.run(Q_SIDES, 'Side two',   '配二', 0, 0, null, 1).lastInsertRowid;
insChoice.run(Q_SIDES, 'Side three', '配三', 0, 0, null, 2);   // a third, never ticked here

// ── The mutant, and the guard that makes its red mean something ────────────
// It rewrites the price snapshot to take the delta the CALLER posted instead of
// the one in this tenant's own column — the single thing lib/product-options
// exists to make impossible. Case 6 is what catches it.
const LIB_PATH = path.join(ROOT, 'lib', 'product-options.js');
const LIB_SRC  = fs.readFileSync(LIB_PATH, 'utf8');
if (MUTANT) {
  // TWO ANCHORS, because the mutation has to be a change a careless author
  // could actually make: carry the caller's line through, then let the price
  // come off it. Reading a delta the client posted is the single thing this
  // module exists to make impossible, and it is exactly the shape the bug
  // takes in the wild — "the body already told us what it costs".
  const A1 = 'choices: normaliseChoiceIds(l.choices),';
  const A2 = 'delta = Math.round((delta + (Number(c.price_delta) || 0)) * 100) / 100;';
  for (const [name, a] of [['A1', A1], ['A2', A2]]) {
    const n = LIB_SRC.split(a).length - 1;
    assert.strictEqual(n, 1,
      `mutation anchor ${name} matched ${n} times — expected exactly 1. ` +
      'The mutation did not modify the source, so a red run would prove nothing.');
  }
  const mutated = LIB_SRC
    .split(A1).join('choices: normaliseChoiceIds(l.choices), posted: l,')
    .split(A2).join(
      'delta = Math.round((delta + (Number(r.posted && r.posted.delta) '
      + '|| Number(c.price_delta) || 0)) * 100) / 100;');
  assert.notStrictEqual(mutated, LIB_SRC, 'the mutant source is identical to the real source');
  const abs = require.resolve(LIB_PATH);
  delete require.cache[abs];
  // filename AND paths, both: without them the mutated copy has no idea where
  // it lives and its own `require('./option-limits')` cannot resolve, which
  // fails as a module error and not as the red the mutation is for.
  const m = new module.constructor(abs, null);
  m.filename = abs;
  m.paths = module.constructor._nodeModulePaths(path.dirname(abs));
  m._compile(mutated, abs);
  m.loaded = true;
  require.cache[abs] = m;
}
const lib = MUTANT ? require(LIB_PATH) : productOptions;

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => { req.user = { id: 4, username: 'mei' }; req.caps = null; next(); });
app.use(router);

let server, PORT;
const call = (url) => fetch(`http://127.0.0.1:${PORT}${url}`)
  .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const rowFor = (rows, id) => rows.filter(r => r.product_id === id)[0] || null;
const qFor = (row, oid) => ((row && row.options) || []).filter(o => o.id === oid)[0] || null;
const cFor = (q, cid) => ((q && q.choices) || []).filter(c => c.id === cid)[0] || null;

// The write side, called the way the two routes call it: the shelf is the
// caller's, and here it is this fixture location's.
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
function answer(lines) {
  const avail = inventory.getAvailableMap(LOC);
  return lib.resolveAnswers(db, lines, {
    isChoiceSoldOut: (c) => {
      const a = avail.get(c.stock_product_id);
      return !a || a.available <= 0;
    },
  });
}

(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });
  try {
    const res = await call(`/api/retail-admin/stores/${LOC}/counter-catalogue`);
    const rows = (res.json && res.json.data && res.json.data.rows) || [];

    console.log('\n1 · The size is read, which is half the report');
    check('both sizes reach the till, and each carries its own label', () => {
      const small = rowFor(rows, P_SMALL), large = rowFor(rows, P_LARGE);
      assert.ok(small && large, 'a size is missing from the counter catalogue');
      assert.strictEqual(small.variant_label, 'Regular');
      assert.strictEqual(large.variant_label, 'Large');
    });
    check('the label comes in BOTH languages — a 中文 till is not left guessing', () => {
      assert.strictEqual(rowFor(rows, P_SMALL).variant_label_cn, '中杯');
      assert.strictEqual(rowFor(rows, P_LARGE).variant_label_cn, '大杯');
    });
    check('the two sizes are otherwise identical, which is why the label matters', () => {
      const small = rowFor(rows, P_SMALL), large = rowFor(rows, P_LARGE);
      assert.strictEqual(small.name_en, large.name_en);
      assert.strictEqual(small.name_cn, large.name_cn);
      assert.notStrictEqual(small.price, large.price);
    });
    check('a product with no siblings carries no label, so no stray separator', () => {
      assert.strictEqual(rowFor(rows, P_PLAIN).variant_label, null);
      assert.strictEqual(rowFor(rows, P_PLAIN).variant_label_cn, null);
    });

    console.log('\n2 · The questions reach the counter, already clamped');
    check('the drink carries both of its questions, in the operator\'s order', () => {
      const small = rowFor(rows, P_SMALL);
      assert.ok(Array.isArray(small.options), 'the till was handed no questions at all');
      assert.deepStrictEqual(small.options.map(o => o.id), [Q_TEMP, Q_EXTRA]);
    });
    check('a required single-answer question says so, in both languages', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_TEMP);
      assert.strictEqual(q.req, 1);
      assert.strictEqual(q.multi, 0);
      assert.strictEqual(q.q_en, 'Hot or iced?');
      assert.strictEqual(q.q_cn, '冷热?');
    });
    check('a pick-any question arrives with its ceiling — the till computes nothing', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_EXTRA);
      assert.strictEqual(q.multi, 1);
      assert.strictEqual(q.max, 2);
    });
    check('each answer carries its own price delta', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_EXTRA);
      assert.strictEqual(cFor(q, C_SHOT).d, 6);
      assert.strictEqual(cFor(q, C_OAT).d, 4);
      assert.strictEqual(cFor(q, C_HOT), null, 'a choice leaked across questions');
    });
    check('a product that asks nothing is handed nothing — an ordinary one-tap tile', () => {
      assert.strictEqual(rowFor(rows, P_PLAIN).options, undefined);
    });

    console.log('\n3 · A sold-out extra greys; it does not vanish (§120 rule 1A, §47)');
    check('the extra with nothing on the shelf is marked out, and STAYS in the list', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_EXTRA);
      assert.strictEqual(cFor(q, C_SOY).out, 1, 'an absent shelf record must read as sold out');
      assert.ok(cFor(q, C_SOY), 'the sold-out extra was removed rather than greyed');
    });
    check('its siblings are unaffected — one dead extra does not close the question', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_EXTRA);
      assert.strictEqual(cFor(q, C_OAT).out, 0);
      assert.strictEqual(cFor(q, C_SHOT).out, 0, 'a sugar level has no shelf and can never be out');
    });
    check('the drink itself still sells — nobody who did not want soy is turned away', () => {
      assert.notStrictEqual(rowFor(rows, P_SMALL).stock, 0);
    });

    console.log('\n4 · A required question with no answer left takes the product');
    check('the flat white cannot be made, and the till is told so as a zero shelf', () => {
      const gone = rowFor(rows, P_GONE);
      assert.ok(gone, 'the product vanished instead of being marked unsellable');
      assert.strictEqual(gone.stock, 0,
        'a drink whose required milk has run out must not offer a sheet nobody can satisfy');
    });

    console.log('\n5 · The shelf link is the till\'s, and the public menu never sees it');
    check('the till payload names which shelf an extra comes off', () => {
      const q = qFor(rowFor(rows, P_SMALL), Q_EXTRA);
      assert.strictEqual(cFor(q, C_OAT).stock_product_id, P_OAT);
    });
    check('and the default read — what the public QR menu asks for — omits it', () => {
      const pub = lib.questionsForProducts(db, [P_SMALL]);
      const q = (pub.get(P_SMALL) || []).filter(o => o.id === Q_EXTRA)[0];
      const c = q.choices.filter(x => x.id === C_OAT)[0];
      assert.ok(!('stock_product_id' in c),
        'an internal product id has no business on a page anybody can open');
    });

    console.log('\n6 · The line is priced by the columns, NEVER by the post body');
    check('base plus the chosen deltas', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT, C_SHOT, C_OAT] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.lines[0].delta, 10);      // 0 + 6 + 4
    });
    check('a delta invented by the caller changes NOTHING — this is the mutant\'s case', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT, C_SHOT],
                          posted_delta: 999, price_delta: 999, delta: 999 }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.lines[0].delta, 6,
        'a delta that arrived from a till is not a delta');
    });
    check('answering nothing costs nothing', () => {
      const r = answer([{ product_id: P_PLAIN, qty: 2, choices: [] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.lines[0].delta, 0);
      assert.deepStrictEqual(r.lines[0].options, []);
    });

    console.log('\n7 · Answers that are not allowed are refused, by name');
    check('a choice belonging to another product', () => {
      const r = answer([{ product_id: P_PLAIN, qty: 1, choices: [C_HOT] }]);
      assert.strictEqual(r.error, 'choice_wrong_product');
      assert.strictEqual(r.product_id, P_PLAIN, 'the refusal must name the line');
    });
    check('a single-answer question answered twice', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT, C_ICED] }]);
      assert.strictEqual(r.error, 'too_many_answers');
    });
    check('a required question left out of the body entirely', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_SHOT] }]);
      assert.strictEqual(r.error, 'choice_required');
    });
    check('a choice id that is not an id at all', () => {
      assert.strictEqual(answer([{ product_id: P_SMALL, qty: 1, choices: ['x'] }]).error, 'bad_choice');
      assert.strictEqual(answer([{ product_id: P_SMALL, qty: 1, choices: 'C_HOT' }]).error, 'bad_choice');
    });
    check('a choice id that does not exist', () => {
      assert.strictEqual(answer([{ product_id: P_SMALL, qty: 1, choices: [99999999] }]).error, 'bad_choice');
    });

    console.log('\n8 · A pick-any group\'s floor and ceiling both bind');
    check('over the ceiling is refused', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT, C_SHOT, C_OAT, C_SOY] }]);
      assert.strictEqual(r.error, 'too_many_answers');
    });
    check('under the floor is refused', () => {
      const r = answer([{ product_id: P_LARGE, qty: 1, choices: [C_S1] }]);
      assert.strictEqual(r.error, 'too_few_answers');
    });
    check('exactly the floor is accepted', () => {
      const r = answer([{ product_id: P_LARGE, qty: 1, choices: [C_S1, C_S2] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.lines[0].options.length, 2);
    });
    check('the same answer posted twice counts once, not twice', () => {
      const r = answer([{ product_id: P_LARGE, qty: 1, choices: [C_S1, C_S1, C_S2] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.lines[0].options.length, 2,
        'a tick-box is on or off; posting it twice is one answer written twice');
    });

    console.log('\n9 · The snapshot survives the option being edited or deleted');
    check('it carries the label AND the question, in both languages', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_ICED, C_OAT] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      const [a, b] = r.lines[0].options;
      assert.strictEqual(a.label, 'Iced');
      assert.strictEqual(a.label_cn, '冰');
      assert.strictEqual(a.question_en, 'Hot or iced?');
      assert.strictEqual(a.question_cn, '冷热?');
      assert.strictEqual(b.label, 'Oat milk');
      assert.strictEqual(b.delta, 4);
    });
    check('`label` is the key lib/feie.js prints — not label_en', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT] }]);
      assert.ok('label' in r.lines[0].options[0]);
      assert.ok(!('label_en' in r.lines[0].options[0]));
    });
    check('and it names the shelf, so the stock commit can find it later', () => {
      const r = answer([{ product_id: P_SMALL, qty: 1, choices: [C_HOT, C_OAT] }]);
      const oat = r.lines[0].options.filter(o => o.choice_id === C_OAT)[0];
      assert.strictEqual(oat.stock_product_id, P_OAT,
        'prepareCommitUnreservedOrder rebuilds add-on demand FROM options_json');
    });

    console.log('\n10 · Stock-backed extras are counted one per unit, across lines');
    check('three drinks each taking an oat milk ask the shelf for three', () => {
      const r = answer([{ product_id: P_SMALL, qty: 3, choices: [C_HOT, C_OAT] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.addonWant.get(P_OAT), 3);
    });
    check('two lines of one drink are two lines and ONE shelf', () => {
      const r = answer([
        { product_id: P_SMALL, qty: 2, choices: [C_HOT,  C_OAT] },
        { product_id: P_SMALL, qty: 1, choices: [C_ICED, C_OAT] },
      ]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.addonWant.get(P_OAT), 3);
    });
    check('a sugar level has no shelf and asks for nothing', () => {
      const r = answer([{ product_id: P_SMALL, qty: 5, choices: [C_HOT, C_SHOT] }]);
      assert.ok(!r.error, `refused: ${r.error}`);
      assert.strictEqual(r.addonWant.size, 0);
    });

    // ── Source. What the two halves above cannot observe. ──────────────────
    const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8').replace(/\r\n/g, '\n');
    const TILL   = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8').replace(/\r\n/g, '\n');

    console.log('\n11 · The answer reaches the order row — the defect behind the defect');
    check('the manual-order INSERT names options_json', () => {
      const m = /INSERT INTO retail_order_items\n\s+\(order_id, product_id, name_en[^`]*?\)/.exec(RETAIL);
      assert.ok(m, 'the manual-order INSERT could not be found');
      assert.match(m[0], /options_json/,
        'a till sale that collects an answer and does not store it is worse than one that never asks');
      assert.match(m[0], /options_cost_at_sale/,
        'a QR sale and a till sale at one counter must be costed by the same code');
    });
    check('the cost snapshot reads through the TRANSACTION handle, not the pool (§24)', () => {
      assert.match(RETAIL, /optionsCostAtSale\(tx, r\.options\)/,
        'on pg an ambient tdb() here would read outside the transaction writing the line');
    });
    check('the line resolver asks lib/product-options and prices from it', () => {
      assert.match(RETAIL, /productOptions\.resolveAnswers\(/);
      assert.match(RETAIL, /unitPrice \+ answers\.lines\[idx\]\.delta/);
    });
    check('and both routes share ONE copy of the rules', () => {
      const SHOPMENU = fs.readFileSync(path.join(ROOT, 'routes', 'shop-menu.js'), 'utf8');
      assert.match(SHOPMENU, /productOptions\.resolveAnswers\(/,
        'the QR checkout must use the same module, or the two will price a coffee differently');
    });

    console.log('\n12 · What the till posts, and what it draws');
    check('it posts choice IDS and nothing else', () => {
      assert.match(TILL, /it\.choices = l\.choices;/);
      assert.doesNotMatch(TILL, /it\.unit_price = l\.price;/,
        'the summed price would have the till pricing the extras AND the server pricing them again');
    });
    check('a menu line posts the BASE, so the deltas are added exactly once', () => {
      assert.match(TILL, /it\.unit_price = \(l\.base != null \? l\.base : l\.price\);/);
    });
    check('the tile prints the size, and the search matches it', () => {
      assert.match(TILL, /vlabel\(p\)/);
      assert.match(TILL, /variant_label \|\| ''\)\.toLowerCase\(\)\.indexOf\(q\)/);
      assert.match(TILL, /variant_label_cn \|\| ''\)\.indexOf\(S\.q\.trim\(\)\)/);
    });
    check('§290 — the size sits OUTSIDE the name\'s two-line clamp, on both kinds of tile', () => {
      // Inside .nm it counted as a third line and was cut: "Organic Matcha
      // Latte" wrapped on an iPad column and "Large" vanished. The name span
      // must close before the size is written.
      const closed = TILL.match(/'<span class="hd"><span class="nm">' \+ esc\(pname\(p\)\) \+ '<\/span>'/g) || [];
      assert.strictEqual(closed.length, 2, 'the selling tile and the sold-out tile both close .nm before .vl');
      assert.doesNotMatch(TILL, /'<span class="nm">' \+ esc\(pname\(p\)\)\s*\n\s*(\/\/[^\n]*\n\s*)*\+ \(vlabel/,
        'the size is inside the clamped name again');
    });
    check('a product that asks something opens its sheet instead of adding', () => {
      assert.match(TILL, /if \(asks\(p\)\) return openOpts\(p\);/);
    });
    check('a line is a product PLUS its answers, so hot and iced stay apart', () => {
      assert.match(TILL, /function lineKey\(id, choices\)/);
      assert.match(TILL, /S\.lines\[i\]\.key === key/);
    });
    check('the shelf gate counts every line carrying the product', () => {
      assert.match(TILL, /if \(st != null && inCart\(id\) >= st\) return;/,
        'one latte hot and one latte iced are two lines and one shelf');
    });

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  } finally {
    cleanup();
    server.close();
  }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
