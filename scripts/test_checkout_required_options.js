#!/usr/bin/env node
/**
 * The customer checkout answers to the same option rules as the menu and the till.
 *
 *   node scripts/test_checkout_required_options.js
 *
 * WHY. "Hot or iced? Which dressing?" has been enforced server-side on the QR
 * menu since §120 and on the counter till since §183, both through
 * lib/product-options.js resolveAnswers(). `/api/retail/orders` — the mini app
 * and the web storefront, which is most of the shop's revenue — kept an inline
 * copy that only ever checked HOW MANY answers a pick-any group took:
 *
 *     WHERE product_id = ? AND type = 'multi' AND (min_choices > 0 OR max_choices > 0)
 *
 * A REQUIRED SINGLE question is not of type 'multi', so it was never checked at
 * all. An order answering nothing was accepted, priced and sent to the kitchen
 * for somebody to guess at. That is how a Beet Salad reached a customer with no
 * dressing recorded against it (§227, TC000823).
 *
 * THE INLINE COPY WAS WEAKER IN FOUR MORE WAYS, and each has a case below,
 * because "we moved it onto the module" is a claim about behaviour and not a
 * claim about diffs:
 *
 *   • a choice id matching no row was SILENTLY DROPPED — the loop walked the
 *     rows the lookup returned rather than the ids that were posted
 *   • a single-answer question could be answered twice, and both deltas charged
 *   • a `text` option's choice was accepted, though neither storefront renders one
 *   • nothing capped how many choices one line could carry
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT DO: place a successful order. The happy
 * path through this route — options priced in, the bilingual snapshot written to
 * options_json, stock-backed extras reserved — is already driven end to end by
 * scripts/test_preorder_park.js, which pays for a line carrying `choices:
 * [CH_EXTRA]`. If this change broke ordinary checkout that suite goes red, and a
 * second copy of its fixture here would be a second thing to keep true. What is
 * NEW is the refusals, and the per-line indexing the move introduced.
 *
 * WHERE THE PER-LINE INDEXING IS HELD, stated plainly because this suite does
 * NOT hold it and a comment claiming otherwise would be worse than no comment.
 * resolveAnswers() is now called ONCE for the whole basket and read back as
 * answers.lines[i]; pinning that to lines[0] prices one line's extras onto
 * another. Every case below still passes under exactly that mutation, because a
 * refusal is decided inside the module before the loop indexes anything — what
 * the mixed-basket case here really holds is that the REFUSAL names the right
 * product, which is a different claim.
 *
 * The alignment itself is caught by scripts/test_preorder_park.js, whose paid
 * order puts `choices: [CH_EXTRA]` on the SECOND of two lines — the one shape
 * that tells lines[i] from lines[0]. Section G below asserts that suite still
 * has that shape, so the coverage this one leans on cannot quietly disappear in
 * an edit to a file nobody thought was load-bearing.
 *
 * Runs against a REAL sqlite database and the REAL route, mounted over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const fs      = require('fs');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0;
const it = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

// ── Fixtures ───────────────────────────────────────────────────────────────
// 977x is clear of every other suite's block (95xx option limits, 96xx addon
// stock gate, 98xx preorder park).
const P_SALAD   = 9771;   // carries a REQUIRED SINGLE question
const P_SIDES   = 9772;   // carries a pick-any group with a floor of 2
const OPT_DRESS = 9781;
const OPT_SIDES = 9782;
const CH_GINGER = 9791, CH_MUSTARD = 9792;
const CH_S1 = 9793, CH_S2 = 9794, CH_S3 = 9795;
const CUSTOMER  = 9776;
const ADDRESS   = 9777;
const TOKEN     = 'checkoutrequiredoptions9776';

// Every refusal below fires inside item resolution, which runs AFTER the address
// and slot presence checks and BEFORE the slot is actually resolved. So a real
// address and any truthy slot id are enough to reach the gate under test.
const ORDER_BASE = { address_id: ADDRESS, payment_method: 'wechat', delivery_slot_id: 'right_away' };

const OPTION_CODES = ['choice_required', 'too_few_answers', 'too_many_answers',
                      'bad_choice', 'choice_wrong_product', 'too_many_choices'];

function cleanup() {
  const oids = db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_addons', 'retail_order_items', 'retail_stock_reservations',
                     'retail_points_transactions', 'retail_payments', 'retail_shipments',
                     'delivery_jobs', 'qingyun_push_queue']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch { /* table optional */ }
    }
    try { db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id IN (${ph})`).run(...oids); } catch { /* optional */ }
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  const pids = [P_SALAD, P_SIDES];
  const pph = pids.map(() => '?').join(',');
  try {
    db.prepare(
      `DELETE FROM retail_product_option_choices
        WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${pph}))`
    ).run(...pids);
  } catch { /* optional */ }
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${pph})`).run(...pids);
  try { db.prepare('DELETE FROM retail_checkout_quotes WHERE customer_id = ?').run(CUSTOMER); } catch { /* optional */ }
  db.prepare('DELETE FROM retail_auth_tokens        WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customer_addresses WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers          WHERE id = ?').run(CUSTOMER);
  try { db.prepare(`DELETE FROM retail_store_stock WHERE product_id IN (${pph})`).run(...pids); } catch { /* optional */ }
  db.prepare(`DELETE FROM store_products WHERE id IN (${pph})`).run(...pids);
}

function seed() {
  cleanup();
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight, is_active, is_published, oos_policy)
     VALUES (?,?,?,?,?,?,1,1,'strict')`);
  prod.run(P_SALAD, 'Required Options Salad', '必选沙拉', 'req-1', 48, '300g');
  prod.run(P_SIDES, 'Two Sides Bowl',         '双配菜碗', 'req-2', 54, '350g');

  const opt = db.prepare(
    `INSERT INTO retail_product_options
       (id, product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`);
  // The shape the inline copy could not see: single, required, no min_choices.
  opt.run(OPT_DRESS, P_SALAD, 'Choose Dressing', '选择酱料', 'single', 1, 0, 0, 0);
  // The shape it COULD see — kept so removing checkOptionLimits is proved not
  // to have lost the rule it did enforce.
  opt.run(OPT_SIDES, P_SIDES, 'Pick two sides', '选两样配菜', 'multi', 0, 2, 2, 0);

  const ch = db.prepare(
    `INSERT INTO retail_product_option_choices
       (id, option_id, label_en, label_cn, price_delta, is_default, sort_order)
     VALUES (?,?,?,?,?,?,?)`);
  ch.run(CH_GINGER,  OPT_DRESS, 'Ginger Tahini',       '生姜芝麻酱', 0, 1, 0);
  ch.run(CH_MUSTARD, OPT_DRESS, 'Mustard Vinaigrette', '芥末油醋汁', 0, 0, 1);
  ch.run(CH_S1, OPT_SIDES, 'Slaw',    '凉拌菜', 0, 0, 0);
  ch.run(CH_S2, OPT_SIDES, 'Pickles', '腌菜',   0, 0, 1);
  ch.run(CH_S3, OPT_SIDES, 'Beans',   '豆子',   0, 0, 2);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Required Options Test', '13900000077', 'dev:required-options');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_customer_addresses
       (id, customer_id, recipient_name, phone, province, city, district, address, detail, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(ADDRESS, CUSTOMER, '测试收货人', '13900000077',
        '广东省', '广州市', '天河区', '天河路 1 号', '101');
}

const app = express();
app.use(router);
let PORT = 0;

const order = (items) => fetch(`http://127.0.0.1:${PORT}/api/retail/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ ...ORDER_BASE, items }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nA · a required question that was not answered');

    const unanswered = await order([{ product_id: P_SALAD, qty: 1 }]);
    it('the order is REFUSED (it used to be accepted and cooked)', () => {
      assert.strictEqual(unanswered.status, 400,
        `expected 400, got ${unanswered.status}: ${JSON.stringify(unanswered.body)}`);
      assert.strictEqual(unanswered.body.error, 'choice_required');
    });
    it('the refusal names the product, so the client can say WHICH item', () => {
      assert.strictEqual(unanswered.body.product_id, P_SALAD,
        'no product_id on the refusal — the customer would get a bare code');
    });

    const answered = await order([{ product_id: P_SALAD, qty: 1, choices: [CH_GINGER] }]);
    it('answering it clears this gate', () => {
      assert.ok(!OPTION_CODES.includes(answered.body && answered.body.error),
        `a correctly answered line was refused on its options: ${JSON.stringify(answered.body)}`);
    });

    console.log('\nB · the gaps the inline copy had');

    const ghost = await order([{ product_id: P_SALAD, qty: 1, choices: [CH_GINGER, 99999999] }]);
    it('a choice id matching no row is REFUSED, not silently dropped', () => {
      assert.strictEqual(ghost.body.error, 'bad_choice',
        'an unknown choice id passed through — the old loop walked rows, not posted ids');
    });

    const twice = await order([{ product_id: P_SALAD, qty: 1, choices: [CH_GINGER, CH_MUSTARD] }]);
    it('a single-answer question cannot be answered twice', () => {
      assert.strictEqual(twice.body.error, 'too_many_answers',
        'both dressings were accepted, and both deltas would have been charged');
    });

    const foreign = await order([{ product_id: P_SALAD, qty: 1, choices: [CH_GINGER, CH_S1] }]);
    it('a choice belonging to another product is refused', () => {
      assert.ok(['choice_wrong_product', 'too_many_answers'].includes(foreign.body.error),
        `expected a refusal, got ${JSON.stringify(foreign.body)}`);
    });

    console.log('\nC · the rule the old helper DID enforce is still enforced');

    const short = await order([{ product_id: P_SIDES, qty: 1, choices: [CH_S1] }]);
    it('a pick-any floor of two still refuses one answer', () => {
      assert.strictEqual(short.body.error, 'too_few_answers',
        'removing checkOptionLimits lost the floor it used to apply');
    });
    const twoSides = await order([{ product_id: P_SIDES, qty: 1, choices: [CH_S1, CH_S2] }]);
    it('two answers clear it', () => {
      assert.ok(!OPTION_CODES.includes(twoSides.body && twoSides.body.error),
        `a satisfied floor was refused: ${JSON.stringify(twoSides.body)}`);
    });
    const tooMany = await order([{ product_id: P_SIDES, qty: 1, choices: [CH_S1, CH_S2, CH_S3] }]);
    it('the ceiling still binds too', () => {
      assert.strictEqual(tooMany.body.error, 'too_many_answers');
    });

    console.log('\nD · the basket is resolved in ONE call, so the lines must line up');

    // The bad line is deliberately the SECOND one: a refusal that always blamed
    // the first product would strand the customer on an item that is already
    // answered. This does NOT hold the lines[i] indexing — see the header, and
    // section G for where that is actually held.
    const mixed = await order([
      { product_id: P_SIDES, qty: 1, choices: [CH_S1, CH_S2] },   // fine
      { product_id: P_SALAD, qty: 2 },                            // missing its dressing
    ]);
    it('a basket whose SECOND line is short is refused', () => {
      assert.strictEqual(mixed.body.error, 'choice_required',
        `expected the second line to be caught: ${JSON.stringify(mixed.body)}`);
    });
    it('and the refusal names the SECOND product, not the first', () => {
      assert.strictEqual(mixed.body.product_id, P_SALAD,
        'the per-line answers are misaligned with the posted items');
    });

    console.log('\nE · the second opinion is gone');

    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    it('checkOptionLimits no longer exists to drift from the module', () => {
      assert.ok(!/function checkOptionLimits\b/.test(routeSrc),
        'the old pick-any-only helper is back; two answers to one question is how they diverge');
    });
    it('both customer order paths go through resolveAnswers', () => {
      assert.ok((routeSrc.match(/productOptions\.resolveAnswers\(/g) || []).length >= 3,
        'a customer order path is still resolving options inline');
    });

    console.log('\nF · the clients say what to do about it');

    const miniSrc = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'checkout', 'checkout.js'), 'utf8');
    it('the mini app handles the refusals instead of toasting a raw code', () => {
      for (const code of OPTION_CODES) {
        assert.ok(miniSrc.includes(`'${code}'`),
          `the mini-app checkout does not handle ${code} — the customer sees "出错：${code}"`);
      }
    });
    it('the mini app offers a way to the product page', () => {
      assert.ok(/wx\.navigateTo\(\{ url: '\/pages\/product\/product\?id=' \+ badId \}\)/.test(miniSrc),
        'the refusal names the item but strands the customer on checkout');
    });

    const shopSrc = fs.readFileSync(path.join(ROOT, 'public', 'shop.html'), 'utf8');
    it('the web storefront maps the refusals to words', () => {
      assert.ok(/choice_required:state\.lang/.test(shopSrc),
        'the web checkout still shows "Order failed: choice_required"');
    });
    it('the web storefront hops to the product page', () => {
      assert.ok(/CO_OPTION_CODES\.indexOf\(j\.error\)>=0&&j\.product_id/.test(shopSrc),
        'the web checkout names the problem but not the fix');
    });

    console.log('\nG · the coverage this suite leans on');

    // The lines[i] indexing is caught by test_preorder_park.js and not by
    // anything here (header). That suite does not know it is load-bearing for
    // this one, so the shape it has to keep is asserted rather than assumed:
    // a paid order whose SECOND line carries choices. Simplify it to one line,
    // or move the choices onto the first, and lines[0] stops being detectable
    // anywhere in the shard — silently, which is the failure worth preventing.
    const parkSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'test_preorder_park.js'), 'utf8');
    it('test_preorder_park still pays for a basket whose SECOND line carries choices', () => {
      const shape = /placeAndPay\(\[\s*\{[^}]*\},\s*\{[^}]*choices:\s*\[[^\]]+\][^}]*\}/;
      assert.ok(shape.test(parkSrc),
        'test_preorder_park no longer orders a multi-line basket with choices on a later line — ' +
        'nothing in the fast shard would now catch answers.lines[i] being pinned to [0]');
    });

    console.log('\n' + pass + ' checks passed.\n');
  } finally {
    server.close();
    cleanup();
  }
})().catch((e) => {
  try { cleanup(); } catch { /* best-effort on the failure path */ }
  console.error('\nFAILED: ' + (e && e.message || e));
  console.error(e && e.stack);
  process.exit(1);
});
