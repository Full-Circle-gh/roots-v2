#!/usr/bin/env node
/**
 * One answer of a "Pick any" question, picked more than once (§471).
 *
 *   node scripts/test_option_repeats.js
 *
 * Reported by Ash from the till: "can't select 2 items that are the same for
 * example 2 medjool boats". §153 had said a repeated choice id counts once,
 * on purpose. §471 keeps that for every question as it was and adds a switch,
 * `allow_repeat`, under which every pick counts.
 *
 * What this locks down:
 *
 *   the limits    with repeats on, "at least 3" on two answers is reachable, so
 *                 the floor and ceiling are not cut to the number of answers;
 *                 a floor only drops when every answer is sold out
 *   the check     two of the same answer satisfy "at least 2", are charged
 *                 twice, are snapshotted twice and take two off a linked shelf
 *                 per unit; with the switch OFF the same post counts once and
 *                 is charged and written once, exactly as before
 *   the ceiling   a fourth pick past "up to 3" is refused, repeats included
 *   the door      the QR menu passes repeats through to the shared check
 *   the payload   the question carries `rep` so the pickers draw a counter
 *   the printers  groupRepeats folds repeats into one row with a count,
 *                 wherever they sit on the line, and the ticket prints "x2"
 *
 * The rule tests are pure. The rest runs against a REAL sqlite database and
 * the REAL express route, mounted and called over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { normaliseLimits, effectiveLimits, REPEAT_CAP } = require(path.join(ROOT, 'lib', 'option-limits.js'));
const productOptions = require(path.join(ROOT, 'lib', 'product-options.js'));
const feie = require(path.join(ROOT, 'lib', 'feie.js'));
const router = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the other option suites' fixture blocks.
const LOC     = 9471;
const CODE    = 'QPTRPTB4';
const P_BOX   = 9671;   // "Choose your bites", at least 2, up to 3, repeats ON
const P_TICK  = 9672;   // the same question with repeats OFF
const A_DATE  = 9673;   // a bite that is a product of its own, on the shelf

const IDS = [P_BOX, P_TICK, A_DATE];
const OPT = {};
const CH  = {};

function cleanup() {
  const orderIds = db.prepare('SELECT id FROM retail_orders WHERE store_id = ?').all(LOC).map(r => r.id);
  if (orderIds.length) {
    const oq = orderIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM retail_stock_reservations WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_order_items        WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_payments           WHERE order_id IN (${oq})`).run(...orderIds);
    db.prepare(`DELETE FROM retail_orders             WHERE id       IN (${oq})`).run(...orderIds);
  }
  const ph = IDS.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
     VALUES (?,?,?,?,1,97)`
  ).run(LOC, '__test_rpts', 'Repeats fixture', '测试重复店');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
     VALUES (?,?,?,?,?,1,1,?)`
  );
  prod.run(P_BOX,  'Fixture bites box', '测试小食盒', '__RPT-71', 0, 'Snacks');
  prod.run(P_TICK, 'Fixture tick box',  '测试勾选盒', '__RPT-72', 0, 'Snacks');
  prod.run(A_DATE, 'Fixture dates',     '测试椰枣',   '__RPT-73', 8, 'Snacks');

  const shopId = db.prepare(
    'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
  ).run(LOC, CODE).lastInsertRowid;
  const add = db.prepare(
    `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
     VALUES (?,?,?,?,1,?)`
  );
  add.run(shopId, P_BOX, 0, 'made_here', 0);
  add.run(shopId, P_TICK, 0, 'made_here', 1);
  db.prepare(
    'INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)'
  ).run(LOC, A_DATE, 50);

  const mkOpt = db.prepare(
    `INSERT INTO retail_product_options
       (product_id, question_en, question_cn, type, is_required, min_choices, max_choices, allow_repeat, sort_order)
     VALUES (?,?,?,?,?,?,?,?,0)`
  );
  const mkCh = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,0,?,?)`
  );
  OPT.box   = mkOpt.run(P_BOX, 'Choose your bites', '选择小食', 'multi', 1, 2, 3, 1).lastInsertRowid;
  CH.boat   = mkCh.run(OPT.box, 'Medjool Boats', '椰枣船', 8, A_DATE, 0).lastInsertRowid;
  CH.lemon  = mkCh.run(OPT.box, 'Lemon Bars', '柠檬条', 9.5, null, 1).lastInsertRowid;

  OPT.tick  = mkOpt.run(P_TICK, 'Choose your bites', '选择小食', 'multi', 1, 2, 3, 0).lastInsertRowid;
  CH.tBoat  = mkCh.run(OPT.tick, 'Medjool Boats', '椰枣船', 8, null, 0).lastInsertRowid;
  CH.tLemon = mkCh.run(OPT.tick, 'Lemon Bars', '柠檬条', 9.5, null, 1).lastInsertRowid;
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(router);
let PORT = 0, pass = 0, fail = 0;

const post = (u, b) => fetch(`http://127.0.0.1:${PORT}${u}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const resolve = (pid, choices, qty = 1) =>
  productOptions.resolveAnswers(db, [{ product_id: pid, qty, choices }]);

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;
  const resetLimit = async () => {
    for (const k of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await router.orderLimiter.resetKey(k);
  };

  console.log('\n── The limits (lib/option-limits.js)');

  await check('repeats on: a floor past the number of answers is kept', async () => {
    assert.deepStrictEqual(normaliseLimits('multi', 3, 0, 2, 0, 1),
      { min_choices: 3, max_choices: 0, is_required: 1 });
  });
  await check('repeats off: the same floor is cut to the number of answers, as before', async () => {
    assert.strictEqual(normaliseLimits('multi', 3, 0, 2, 0, 0).min_choices, 2);
  });
  await check('repeats on: a ceiling past the number of answers still binds', async () => {
    assert.strictEqual(normaliseLimits('multi', 0, 5, 2, 0, 1).max_choices, 5);
  });
  await check('repeats on: the bound is the per-line cap', async () => {
    assert.strictEqual(normaliseLimits('multi', 99, 0, 2, 0, 1).min_choices, REPEAT_CAP);
    assert.strictEqual(productOptions.MAX_CHOICES_PER_LINE, REPEAT_CAP);
  });
  await check('repeats on: one live answer keeps the whole floor; none left drops it', async () => {
    const o = { type: 'multi', min_choices: 3, max_choices: 0, allow_repeat: 1 };
    assert.strictEqual(effectiveLimits(o, 1).min, 3);
    assert.strictEqual(effectiveLimits(o, 0).min, 0);
    assert.strictEqual(effectiveLimits({ ...o, allow_repeat: 0 }, 1).min, 1);
  });

  console.log('\n── The check (lib/product-options.js resolveAnswers)');

  await check('two Medjool Boats answer "at least 2", charged and written twice', async () => {
    const r = resolve(P_BOX, [CH.boat, CH.boat]);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.lines[0].delta, 16);
    assert.deepStrictEqual(r.lines[0].options.map(o => o.choice_id), [CH.boat, CH.boat]);
  });
  await check('a repeated linked bite takes two off its shelf per unit bought', async () => {
    const r = resolve(P_BOX, [CH.boat, CH.boat, CH.lemon], 3);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.addonWant.get(A_DATE), 6);
  });
  await check('one Medjool Boat is still short of "at least 2"', async () => {
    assert.strictEqual(resolve(P_BOX, [CH.boat]).error, 'too_few_answers');
  });
  await check('a fourth pick past "up to 3" is refused, repeats counted', async () => {
    assert.strictEqual(resolve(P_BOX, [CH.boat, CH.boat, CH.boat, CH.lemon]).error, 'too_many_answers');
  });
  await check('repeats OFF: the same post counts once, as §153 has always said', async () => {
    assert.strictEqual(resolve(P_TICK, [CH.tBoat, CH.tBoat]).error, 'too_few_answers');
    const r = resolve(P_TICK, [CH.tBoat, CH.tBoat, CH.tLemon]);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.lines[0].delta, 17.5, 'the repeat must not be charged');
    assert.strictEqual(r.lines[0].options.length, 2, 'the repeat must not be written');
  });

  console.log('\n── The payload and the door (routes/shop-menu.js)');

  await check('the question tells the pickers to draw a counter', async () => {
    const q = productOptions.questionsForProducts(db, [P_BOX, P_TICK]);
    assert.strictEqual(q.get(P_BOX)[0].rep, 1);
    assert.strictEqual(q.get(P_TICK)[0].rep, 0);
  });
  await check('a QR order for two Medjool Boats is accepted and priced for two', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOX, qty: 1, choices: [CH.boat, CH.boat] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const it = r.json.data.items[0];
    assert.strictEqual(Number(it.unit_price), 16);
    assert.deepStrictEqual(it.options.map(o => o.choice_id), [CH.boat, CH.boat]);
  });

  console.log('\n── The printers');

  await check('groupRepeats folds every repeat into its first appearance', async () => {
    const g = productOptions.groupRepeats([
      { choice_id: 1, label: 'A' }, { choice_id: 2, label: 'B' }, { choice_id: 1, label: 'A' }, 'old',
    ]);
    assert.deepStrictEqual(g.map(o => (typeof o === 'object' ? [o.label, o.n || 1] : o)),
      [['A', 2], ['B', 1], 'old']);
  });
  await check('the receipt prints one line with x2, and pulls two of a linked bite', async () => {
    const opt = { choice_id: 5, label: 'Medjool Boats', label_cn: '椰枣船', sku: 'D-1' };
    const line = (qty) => ({
      product_id: 1, name_en: 'Bites box', name_cn: '', sku: 'BX-1',
      qty, unit_price: 16, line_total: 16 * qty, options_json: JSON.stringify([opt, opt]),
    });
    const order = { order_no: 'TC000971', total: 16, subtotal: 16, paid_at: '2026-10-13 12:00:00' };
    const one = feie.renderOrder('receipt', order, [line(1)], 'Roots', []);
    assert.strictEqual((one.match(/Medjool Boats/g) || []).length, 1, one);
    assert.ok(/Medjool Boats x2/.test(one), one);
    assert.ok(one.includes('<B>x2  SKU D-1</B>'), one);
    const packing = feie.renderOrder('packing', order, [line(3)], 'Roots', []);
    assert.ok(packing.includes('<B>x6  SKU D-1</B>'), packing);
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
