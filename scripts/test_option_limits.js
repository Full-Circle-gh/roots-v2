#!/usr/bin/env node
/**
 * How many answers a "Pick any" question takes.
 *
 *   node scripts/test_option_limits.js
 *
 * Until min_choices/max_choices existed, a multi option took ANY number of
 * answers including none: "Choose 2 crunchy sides" was a sentence in a label
 * and nothing else. A customer could tick one side, or all three, and check
 * out either way — the label promised two, the kitchen packed what arrived.
 *
 * What this locks down:
 *
 *   the rule      lib/option-limits.js normalises what the editor posts and
 *                 clamps what the customer is shown — ONE module, because the
 *                 save path, the menu and the checkout all ask the same
 *                 question and a second copy would be a second answer
 *   the floor     a group with min 2 refuses a line that answered once, server
 *                 side, where the sheet's own block cannot be skipped by
 *                 posting straight at the endpoint
 *   the ceiling   a group with max 2 refuses a line that answered three times,
 *                 and a repeated choice id counts ONCE — a tick-box is on or
 *                 off, so posting it twice is one answer, not two
 *   THE TRAP      a floor is NOT absolute. "Choose 2" whose stock-backed sides
 *                 have sold down to one is SERVED as "choose 1" and must be
 *                 ACCEPTED as one. Clamp the menu but not the checkout and the
 *                 endpoint refuses the very order the page told them to place.
 *   the old rows  0 on both columns is no limit, which is what every group
 *                 written before this feature carries — nothing already
 *                 authored changes shape by being read through the new rule
 *
 * The rule tests are pure. Everything else runs against a REAL sqlite database
 * and the REAL express route, mounted and called over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { normaliseLimits, effectiveLimits } = require(path.join(ROOT, 'lib', 'option-limits.js'));
const router  = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of test_shop_menu_options.js's own fixture block.
const LOC      = 9441;
const CODE     = 'QPTSLXM7';
const P_BOWL   = 9551;   // "choose 2 crunchy sides" — 3 free choices, pick 2
const P_WRAP   = 9552;   // "up to 2 extras" — 3 STOCK-BACKED choices, ceiling only
const A_CRACK  = 9553;   // wrap extra, ON the shelf
const A_CHIPS  = 9554;   // wrap extra, at ZERO
const A_VEG    = 9555;   // wrap extra, at ZERO

const IDS = [P_BOWL, P_WRAP, A_CRACK, A_CHIPS, A_VEG];
const OPT = {};          // question name → id
const CH  = {};          // answer name  → id

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
     VALUES (?,?,?,?,1,97)`
  ).run(LOC, '__test_lims', 'Limits fixture', '测试数量店');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
     VALUES (?,?,?,?,?,1,1,?)`
  );
  prod.run(P_BOWL,  'Fixture bowl',     '测试碗',     '__L-71', 30, 'Food');
  prod.run(P_WRAP,  'Fixture wrap',     '测试卷',     '__L-72', 28, 'Food');
  prod.run(A_CRACK, 'Fixture crackers', '测试饼干',   '__L-73', 3,  'Food');
  prod.run(A_CHIPS, 'Fixture chips',    '测试玉米片', '__L-74', 3,  'Food');
  prod.run(A_VEG,   'Fixture veg',      '测试蔬菜条', '__L-75', 3,  'Food');

  const shopId = db.prepare(
    'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
  ).run(LOC, CODE).lastInsertRowid;

  const add = db.prepare(
    `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
     VALUES (?,?,?,?,1,?)`
  );
  // Both mains are made here, so neither product's own availability depends on a
  // shelf — every sold-out result below is therefore about an EXTRA.
  add.run(shopId, P_BOWL, 30, 'made_here', 0);
  add.run(shopId, P_WRAP, 28, 'made_here', 1);

  const shelf = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)`
  );
  shelf.run(LOC, A_CRACK, 9);
  shelf.run(LOC, A_CHIPS, 0);
  // A_VEG gets NO ROW AT ALL. §47: an absent shelf record IS sold out. Between
  // it and A_CHIPS the wrap has exactly ONE pickable side, which is what the
  // clamp tests below turn on.

  const mkOpt = db.prepare(
    `INSERT INTO retail_product_options
       (product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const mkCh = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  );

  // The bowl: exactly two of three, none of them stock-backed — the plain case
  // from the brief ("Choose 2 crunchy sides / 爽脆配菜（选2款）").
  OPT.sides  = mkOpt.run(P_BOWL, 'Choose 2 crunchy sides', '爽脆配菜', 'multi', 1, 2, 2, 0).lastInsertRowid;
  CH.crack   = mkCh.run(OPT.sides, 'Whole wheat crackers', '全麦饼干', 0, 0, null, 0).lastInsertRowid;
  CH.chips   = mkCh.run(OPT.sides, 'Tortilla corn chips',  '玉米片',   0, 0, null, 1).lastInsertRowid;
  CH.veg     = mkCh.run(OPT.sides, 'Veggie sticks',        '蔬菜条',   0, 0, null, 2).lastInsertRowid;

  // The wrap: a FLOOR of two over three stock-backed sides, two of which have
  // run out. Served as "choose 1"; must be accepted as one.
  OPT.extras = mkOpt.run(P_WRAP, 'Choose 2 sides', '配菜', 'multi', 1, 2, 2, 0).lastInsertRowid;
  CH.wCrack  = mkCh.run(OPT.extras, 'Crackers', '饼干',   3, 0, A_CRACK, 0).lastInsertRowid;
  CH.wChips  = mkCh.run(OPT.extras, 'Chips',    '玉米片', 3, 0, A_CHIPS, 1).lastInsertRowid;
  CH.wVeg    = mkCh.run(OPT.extras, 'Veg',      '蔬菜条', 3, 0, A_VEG,   2).lastInsertRowid;
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

  console.log('\n── The rule itself (lib/option-limits.js)');

  await check('a single-answer question carries no limits, whatever was posted', () => {
    assert.deepStrictEqual(
      normaliseLimits('single', 2, 2, 3, 0),
      { min_choices: 0, max_choices: 0, is_required: 0 }
    );
  });

  await check('pick 2 of 3 stores exactly as authored', () => {
    assert.deepStrictEqual(
      normaliseLimits('multi', 2, 2, 3, 1),
      { min_choices: 2, max_choices: 2, is_required: 1 }
    );
  });

  await check('a ceiling past the number of choices is stored as NO ceiling', () => {
    // "at most 5" on a three-choice group is "no ceiling" written the long way,
    // and storing the 5 would leave a number that silently never binds.
    assert.strictEqual(normaliseLimits('multi', 0, 5, 3, 0).max_choices, 0);
  });

  await check('a floor past the number of choices comes down to the choices there are', () => {
    assert.strictEqual(normaliseLimits('multi', 5, 0, 3, 0).min_choices, 3);
  });

  await check('an inverted pair keeps the floor and drops the inversion', () => {
    const r = normaliseLimits('multi', 3, 1, 4, 0);
    assert.strictEqual(r.min_choices, 3, 'the floor is the half a customer is blocked by');
    assert.strictEqual(r.max_choices, 3, 'the ceiling cannot sit under the floor');
  });

  await check('Required with no floor means a floor of one', () => {
    assert.deepStrictEqual(
      normaliseLimits('multi', 0, 0, 3, 1),
      { min_choices: 1, max_choices: 0, is_required: 1 }
    );
  });

  await check('a floor of one or more IS required, whether or not the box was ticked', () => {
    assert.strictEqual(normaliseLimits('multi', 2, 2, 3, 0).is_required, 1);
  });

  await check('zero on both is no limit — every group written before this feature', () => {
    assert.deepStrictEqual(
      normaliseLimits('multi', 0, 0, 3, 0),
      { min_choices: 0, max_choices: 0, is_required: 0 }
    );
  });

  await check('the floor clamps to the choices still pickable, the ceiling stops binding', () => {
    const o = { type: 'multi', min_choices: 2, max_choices: 2 };
    assert.deepStrictEqual(effectiveLimits(o, 1), { min: 1, max: 0 },
      'one side left cannot be asked for twice');
    assert.deepStrictEqual(effectiveLimits(o, 3), { min: 2, max: 2 });
  });

  console.log('\n── The menu carries the numbers');

  await check('a pick-2-of-3 group ships its floor and ceiling with the card', async () => {
    const { body } = await get(`/s/${CODE}`);
    const o = optsOnCard(body, P_BOWL);
    assert.ok(Array.isArray(o), 'no <template data-op> for the bowl');
    const g = o.find(x => x.q_en === 'Choose 2 crunchy sides');
    assert.ok(g, 'the sides question is not on the card');
    assert.strictEqual(g.min, 2, 'the floor did not reach the card');
    assert.strictEqual(g.max, 2, 'the ceiling did not reach the card');
    assert.strictEqual(g.req, 1, 'a floor of 2 is a required question');
  });

  await check('a floor is CLAMPED to what is still pickable before the card is served', async () => {
    const { body } = await get(`/s/${CODE}`);
    const g = (optsOnCard(body, P_WRAP) || []).find(x => x.q_en === 'Choose 2 sides');
    assert.ok(g, 'the wrap lost its question');
    // Two of the three sides have run out, so the sheet asks for one. Serving
    // the authored 2 would make the wrap unbuyable with no way to say why.
    assert.strictEqual(g.min, 1, `served floor was ${g.min}, not the pickable count`);
    assert.strictEqual(g.choices.filter(c => !c.out).length, 1, 'fixture drifted: expected one live side');
  });

  console.log('\n── The refusals, where a post cannot skip them');

  await check('two of three is accepted', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1, choices: [CH.crack, CH.chips] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  });

  await check('three of three is refused — the ceiling', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1, choices: [CH.crack, CH.chips, CH.veg] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'too_many_answers');
  });

  await check('one of three is refused — the floor', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1, choices: [CH.crack] }],
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'too_few_answers');
  });

  await check('none at all is refused too — a floor is not dodged by sending nothing', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1 }],
    });
    assert.strictEqual(r.status, 400);
    // The floor is checked before the older is_required flag, so an unanswered
    // pick-2 group refuses as too_few_answers rather than choice_required. Both
    // are correct; the first says how many were missing, so it is the one kept.
    // A group with the flag and NO floor still answers choice_required — that is
    // test_shop_menu_options.js's rule 2B, which this must not have moved.
    assert.strictEqual(r.json.error, 'too_few_answers');
  });

  await check('the same side posted twice is ONE answer, not two', async () => {
    await resetLimit();
    // A tick-box is on or off. Counting the repeat would refuse a line that
    // answered correctly, and counting it toward the floor would let one side
    // satisfy a request for two — so it must count exactly once, either way.
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1, choices: [CH.crack, CH.crack] }],
    });
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
    assert.strictEqual(r.json.error, 'too_few_answers', 'the repeat was counted as a second side');
  });

  await check('THE TRAP — the clamped floor is the floor the endpoint applies', async () => {
    await resetLimit();
    // The card was served "choose 1" because two sides have run out. If the
    // checkout held this line to the authored 2, it would refuse the very order
    // the page told the customer to place — and nothing on screen could explain
    // it. This is the assertion the whole sold-out clamp exists for.
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_WRAP, qty: 1, choices: [CH.wCrack] }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  });

  await check('a sold-out side still cannot be chosen to satisfy the floor', async () => {
    await resetLimit();
    const r = await post(`/s/${CODE}/order`, {
      name: 'Mei', items: [{ store_product_id: P_WRAP, qty: 1, choices: [CH.wCrack, CH.wChips] }],
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  });

  console.log('\n── A group with no limits is the group it always was');

  await check('clearing both numbers restores the old unlimited behaviour', async () => {
    db.prepare('UPDATE retail_product_options SET min_choices = 0, max_choices = 0, is_required = 0 WHERE id = ?')
      .run(OPT.sides);
    try {
      const { body } = await get(`/s/${CODE}`);
      const g = (optsOnCard(body, P_BOWL) || []).find(x => x.q_en === 'Choose 2 crunchy sides');
      assert.strictEqual(g.min, 0, 'a group with no floor should ship none');
      assert.strictEqual(g.max, 0, 'a group with no ceiling should ship none');
      await resetLimit();
      const r = await post(`/s/${CODE}/order`, {
        name: 'Mei', items: [{ store_product_id: P_BOWL, qty: 1, choices: [CH.crack, CH.chips, CH.veg] }],
      });
      assert.strictEqual(r.status, 201, `all three refused on an unlimited group: ${JSON.stringify(r.json)}`);
    } finally {
      db.prepare('UPDATE retail_product_options SET min_choices = 2, max_choices = 2, is_required = 1 WHERE id = ?')
        .run(OPT.sides);
    }
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
