#!/usr/bin/env node
/**
 * §120 — the QR menu asks the questions the counter would have asked.
 *
 *   node scripts/test_shop_menu_options.js
 *
 * Before §120 the public QR menu sold a flat row: tap Add, get one unit. It
 * read NEITHER of the two choice mechanisms this system already had, so a
 * customer standing at a counter could not say "half sugar" and a drink sold in
 * three sizes took three rows of a phone screen.
 *
 * What this locks down, in the order the customer meets it:
 *
 *   the menu    a product with questions says so on its own card, and carries
 *               them as JSON so opening the picker costs no round trip
 *   rule 1A     a sold-out PAID EXTRA greys out and the drink still sells —
 *               but a REQUIRED question with no answer left takes the product
 *               with it, because that drink cannot be made
 *   rule 2B     a required question left unanswered is refused, server-side,
 *               where the page's own block cannot be skipped by posting
 *               straight at the endpoint
 *   the price   base plus this tenant's own price_delta, never a number that
 *               arrived from a phone
 *   the basket  two sugar levels of one latte are TWO order lines
 *   the ticket  options_json is written in the shape lib/feie.js already
 *               prints and the admin order detail already parses
 *
 * Everything runs against a REAL sqlite database and the REAL express route,
 * mounted and called over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of test_shop_menu.js's own fixture block.
const LOC       = 9421;
const CODE      = 'QPTSAAA7';
const P_LATTE   = 9531;   // free questions + a paid extra
const P_TEA     = 9532;   // a REQUIRED question whose every answer has run out
const P_PLAIN   = 9533;   // no questions at all — the common case, unchanged
const A_OAT     = 9534;   // paid extra, ON the shelf
const A_ALMOND  = 9535;   // paid extra, at ZERO
const A_HONEY   = 9536;   // the tea's only answer, at ZERO

const IDS = [P_LATTE, P_TEA, P_PLAIN, A_OAT, A_ALMOND, A_HONEY];
const OPT = {};           // question name → id
const CH  = {};           // answer name  → id

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
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

function seed() {
  cleanup();

  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
     VALUES (?,?,?,?,1,96)`
  ).run(LOC, '__test_opts', 'Options fixture', '测试选项店');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
     VALUES (?,?,?,?,?,1,1,?)`
  );
  prod.run(P_LATTE,  'Fixture latte',  '测试拿铁',   '__O-61', 20, 'Drinks');
  prod.run(P_TEA,    'Fixture tea',    '测试茶',     '__O-62', 18, 'Drinks');
  prod.run(P_PLAIN,  'Fixture water',  '测试水',     '__O-63', 5,  'Drinks');
  prod.run(A_OAT,    'Fixture oat',    '测试燕麦奶', '__O-64', 3,  'Drinks');
  prod.run(A_ALMOND, 'Fixture almond', '测试杏仁奶', '__O-65', 4,  'Drinks');
  prod.run(A_HONEY,  'Fixture honey',  '测试蜂蜜',   '__O-66', 2,  'Drinks');

  const shopId = db.prepare(
    'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
  ).run(LOC, CODE).lastInsertRowid;

  const add = db.prepare(
    `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
     VALUES (?,?,?,?,1,?)`
  );
  // All three are made here, so the DRINK's own availability never depends on a
  // shelf — every sold-out result below is therefore about an EXTRA, which is
  // what rule 1A is about.
  add.run(shopId, P_LATTE, 20, 'made_here', 0);
  add.run(shopId, P_TEA,   18, 'made_here', 1);
  add.run(shopId, P_PLAIN, 5,  'made_here', 2);

  const shelf = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)`
  );
  shelf.run(LOC, A_OAT, 9);
  shelf.run(LOC, A_ALMOND, 0);
  // A_HONEY gets NO ROW AT ALL. §47: an absent shelf record IS sold out, and
  // this fixture is the one that proves the extras obey that rule too.

  const mkOpt = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (?,?,?,?,?,?)`
  );
  const mkCh = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  );

  // The latte: a required FREE single (sugar), an optional PAID multi (milk),
  // and a `text` question that must never be rendered.
  OPT.sugar = mkOpt.run(P_LATTE, 'Sugar level', '糖度', 'single', 1, 0).lastInsertRowid;
  CH.full   = mkCh.run(OPT.sugar, 'Full sugar', '全糖', 0, 1, null, 0).lastInsertRowid;
  CH.half   = mkCh.run(OPT.sugar, 'Half sugar', '半糖', 0, 0, null, 1).lastInsertRowid;

  OPT.milk  = mkOpt.run(P_LATTE, 'Milk', '奶', 'multi', 0, 1).lastInsertRowid;
  CH.oat    = mkCh.run(OPT.milk, 'Oat',    '燕麦', 3,   0, A_OAT,    0).lastInsertRowid;
  CH.almond = mkCh.run(OPT.milk, 'Almond', '杏仁', 4,   0, A_ALMOND, 1).lastInsertRowid;

  OPT.note  = mkOpt.run(P_LATTE, 'Anything else', '其他', 'text', 0, 2).lastInsertRowid;
  CH.note   = mkCh.run(OPT.note, 'Note', '备注', 0, 0, null, 0).lastInsertRowid;

  // The tea: ONE required question, and its only answer has run out.
  OPT.sweet = mkOpt.run(P_TEA, 'Sweeten with', '加甜', 'single', 1, 0).lastInsertRowid;
  CH.honey  = mkCh.run(OPT.sweet, 'Honey', '蜂蜜', 2, 1, A_HONEY, 0).lastInsertRowid;
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(router);
let PORT = 0, pass = 0, fail = 0;

const get = (u) => fetch(`http://127.0.0.1:${PORT}${u}`)
  .then(async r => ({ status: r.status, body: await r.text() }));
const post = (u, b) => fetch(`http://127.0.0.1:${PORT}${u}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// The card's questions, parsed back out of the <template> the menu renders.
function optsOnCard(body, pid) {
  const m = body.match(new RegExp(`<template data-op="${pid}">([\\s\\S]*?)</template>`));
  if (!m) return null;
  const json = m[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(json);
}

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  const resetLimit = async () => {
    for (const k of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await router.orderLimiter.resetKey(k);
  };

  console.log('\n── The menu carries its questions');

  await check('a product with questions says so on its card, and brings them with it', async () => {
    const { body } = await get(`/s/${CODE}`);
    assert.ok(/data-add="9531"[^>]*data-ask="1"/.test(body), 'the latte lost its data-ask flag');
    const o = optsOnCard(body, P_LATTE);
    assert.ok(Array.isArray(o), 'no <template data-op> for the latte');
    const qs = o.map(x => x.q_en);
    assert.deepStrictEqual(qs, ['Sugar level', 'Milk'], `questions rendered: ${qs.join(', ')}`);
  });

  await check('a product with NO questions is untouched — no flag, no template', async () => {
    const { body } = await get(`/s/${CODE}`);
    assert.ok(/data-add="9533"/.test(body), 'the plain product lost its add button');
    assert.ok(!/data-add="9533"[^>]*data-ask/.test(body), 'a product with no questions grew a picker');
    assert.strictEqual(optsOnCard(body, P_PLAIN), null, 'a product with no questions grew a template');
  });

  await check('a `text` question is not rendered — unsupported on every other client too', async () => {
    const { body } = await get(`/s/${CODE}`);
    const o = optsOnCard(body, P_LATTE);
    assert.ok(!o.some(x => x.q_en === 'Anything else'), 'a text option reached the picker');
  });

  await check('both languages ride along, so the toggle stays a class swap', async () => {
    const { body } = await get(`/s/${CODE}`);
    const o = optsOnCard(body, P_LATTE);
    const sugar = o.find(x => x.q_en === 'Sugar level');
    assert.strictEqual(sugar.q_cn, '糖度');
    assert.strictEqual(sugar.choices.find(c => c.en === 'Half sugar').cn, '半糖');
  });

  console.log('\n── Rule 1A — a sold-out extra greys out; the drink still sells');

  await check('the extra ON the shelf is live and the one at ZERO is not', async () => {
    const { body } = await get(`/s/${CODE}`);
    const milk = optsOnCard(body, P_LATTE).find(x => x.q_en === 'Milk');
    assert.strictEqual(milk.choices.find(c => c.en === 'Oat').out, 0, 'oat is on the shelf');
    assert.strictEqual(milk.choices.find(c => c.en === 'Almond').out, 1, 'almond is at zero');
  });

  await check('...and the latte itself still sells, because the milk was optional', async () => {
    const { body } = await get(`/s/${CODE}`);
    // The add button exists only on a card that is not sold out.
    assert.ok(/data-add="9531"/.test(body), 'an optional sold-out extra took the whole drink with it');
  });

  await check('a FREE choice has no shelf and is never sold out', async () => {
    const { body } = await get(`/s/${CODE}`);
    const sugar = optsOnCard(body, P_LATTE).find(x => x.q_en === 'Sugar level');
    assert.ok(sugar.choices.every(c => c.out === 0), 'a sugar level acquired a stock state');
  });

  await check('a REQUIRED question with no answer left DOES take the product with it', async () => {
    const { body } = await get(`/s/${CODE}`);
    assert.ok(!/data-add="9532"/.test(body), 'a tea that cannot be made was still addable');
    assert.ok(body.includes('Fixture tea'), 'the tea should still be on the menu, shown sold out');
  });

  console.log('\n── The order endpoint');

  await check('base plus this tenant\'s own delta — and the answers are snapshotted', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei',
      items: [{ store_product_id: P_LATTE, qty: 2, choices: [CH.half, CH.oat] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const d = r.json.data;
    assert.strictEqual(d.items[0].unit_price, 23, 'latte 20 + oat 3');
    assert.strictEqual(d.total, 46);
    const row = db.prepare(
      'SELECT options_json FROM retail_order_items WHERE order_id = (SELECT id FROM retail_orders WHERE order_no = ?)'
    ).get(d.order_no);
    const saved = JSON.parse(row.options_json);
    assert.strictEqual(saved.length, 2);
    // THE SHAPE lib/feie.js ALREADY PRINTS. `label` (not label_en) is the key
    // its parseOptions reads, and the question is what turns a bare "Half
    // sugar" into "Sugar level: Half sugar" on the ticket.
    assert.strictEqual(saved[0].label, 'Half sugar');
    assert.strictEqual(saved[0].label_cn, '半糖');
    assert.strictEqual(saved[0].question_en, 'Sugar level');
    assert.strictEqual(saved[0].question_cn, '糖度');
    assert.strictEqual(saved[1].delta, 3);
  });

  await check('a price posted by the customer is still not a price', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei',
      items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.oat], price: 1, unit_price: 1 }],
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.data.total, 23, 'a posted price was honoured');
  });

  await check('TWO SUGAR LEVELS OF ONE LATTE ARE TWO LINES', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei',
      items: [
        { store_product_id: P_LATTE, qty: 1, choices: [CH.full] },
        { store_product_id: P_LATTE, qty: 1, choices: [CH.half] },
      ],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const rows = db.prepare(
      'SELECT options_json FROM retail_order_items WHERE order_id = (SELECT id FROM retail_orders WHERE order_no = ?) ORDER BY id'
    ).all(r.json.data.order_no);
    assert.strictEqual(rows.length, 2, 'the second latte was folded into the first');
    assert.strictEqual(JSON.parse(rows[0].options_json)[0].label, 'Full sugar');
    assert.strictEqual(JSON.parse(rows[1].options_json)[0].label, 'Half sugar');
  });

  await check('a line with no answers writes NULL, not an empty array', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, { name: 'Mei', items: [{ store_product_id: P_PLAIN, qty: 1 }] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const row = db.prepare(
      'SELECT options_json FROM retail_order_items WHERE order_id = (SELECT id FROM retail_orders WHERE order_no = ?)'
    ).get(r.json.data.order_no);
    assert.strictEqual(row.options_json, null, 'every reader of this column handles NULL, not "[]"');
  });

  console.log('\n── Rule 2B, and the refusals');

  await check('a required question left unanswered is refused at the endpoint', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.oat] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'choice_required');
  });

  await check('an answer belonging to ANOTHER product is refused', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.honey] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'choice_wrong_product');
  });

  await check('two answers to a single-answer question are refused', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.half] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'too_many_answers');
  });

  await check('a `text` answer cannot be smuggled in by posting its id', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.note] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'bad_choice');
  });

  await check('a SOLD-OUT extra refuses the line, naming the drink rather than the extra', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.almond] }],
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
    assert.strictEqual(r.json.error, 'unavailable');
    // The page answers a 409 by clearing that PRODUCT's lines from the basket.
    // Handed the almond's id it would find nothing to clear and resubmit the
    // same order, so naming the latte is what lets the customer re-pick.
    assert.strictEqual(r.json.items[0].store_product_id, P_LATTE);
    assert.strictEqual(r.json.items[0].name_en, 'Fixture latte');
  });

  await check('the extras a shelf cannot cover are counted ACROSS lines', async () => {
    await resetLimit();
    const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
    db.prepare('UPDATE retail_store_stock SET physical_qty = 1 WHERE store_id = ? AND product_id = ?')
      .run(LOC, A_OAT);
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei',
      items: [
        { store_product_id: P_LATTE, qty: 1, choices: [CH.full, CH.oat] },
        { store_product_id: P_LATTE, qty: 1, choices: [CH.half, CH.oat] },
      ],
    });
    assert.ok(shopId);
    assert.strictEqual(r.status, 409, 'two oat milks against one on the shelf should refuse');
    db.prepare('UPDATE retail_store_stock SET physical_qty = 9 WHERE store_id = ? AND product_id = ?')
      .run(LOC, A_OAT);
  });

  await check('a chosen extra RESERVES its own stock alongside the drink', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 2, choices: [CH.full, CH.oat] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const oid = db.prepare('SELECT id FROM retail_orders WHERE order_no = ?').get(r.json.data.order_no).id;
    const held = db.prepare(
      "SELECT product_id, qty FROM retail_stock_reservations WHERE order_id = ? AND status = 'active'"
    ).all(oid);
    const oat = held.find(h => h.product_id === A_OAT);
    assert.ok(oat, 'the oat milk was sold and never held');
    assert.strictEqual(oat.qty, 2, 'one extra per unit bought, as expandStockLines has always counted them');
    // The latte is made here, so it holds nothing of its own — §43.
    assert.ok(!held.some(h => h.product_id === P_LATTE), 'a made-here drink reserved a shelf it does not have');
  });

  console.log('\n── What the customer reads back');

  await check('the order page names what was chosen, with its question, in both languages', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_LATTE, qty: 1, choices: [CH.half, CH.oat] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    // order_url is what the response hands back — the address the menu
    // remembers and the customer returns to.
    const page = await get(r.json.data.order_url);
    assert.strictEqual(page.status, 200, 'the order page did not render');
    const body = page.body;
    assert.ok(body.includes('Sugar level: Half sugar'), 'the English answer is not on the order page');
    assert.ok(body.includes('糖度: 半糖'), 'the 中文 answer is not on the order page');
    assert.ok(body.includes('Milk: Oat'), 'the paid extra is not on the order page');
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
