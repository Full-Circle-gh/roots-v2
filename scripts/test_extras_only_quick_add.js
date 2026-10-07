#!/usr/bin/env node
/**
 * A product whose only question is optional extras adds straight in (§440).
 *
 *   node scripts/test_extras_only_quick_add.js
 *
 * WHY. Since §438 the shop grid + opens the product page with its choice sheet
 * up. For the dips, whose only question is the optional "Add extras?", that
 * meant every + on a dip met the extras sheet — the complaint was a customer
 * picking a dip "needs to see the extras" every single time.
 *
 * NOW: `has_options` — the flag every quick add reads — means "must ask before
 * adding", not "has any options". Optional pick-any groups alone don't set it.
 * A pick-one (dressing, "heat up?" — so the soups), a required or minimum
 * pick-any, or a pre-ticked default still do. The extras stay on the product
 * page for whoever opens it.
 *
 * WHAT IS RUN FOR REAL: every server read that ships the flag — the shop list,
 * a product page's "Buy together" items and size rows, and a customer's order
 * lines (for "Buy again") — plus the rule itself against six shapes.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const productOptions = require(path.join(ROOT, 'lib', 'product-options.js'));
const db = tdb();

let pass = 0;
const it = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

// 9762–9769 is clear of every other suite's block (9761 manual restock park,
// 977x checkout required options). Products, options and choices are separate
// tables, so each reuses the block.
const P = {
  EXTRAS:   9762,   // only an optional "Add extras?" — the dip
  HEAT:     9763,   // optional pick-one "Heat up?" + extras — the soup
  REQMULTI: 9764,   // required pick-any
  DEFAULT:  9765,   // optional pick-any with a pre-ticked choice
  PLAIN:    9766,   // no options at all
  TEXT:     9767,   // a 'text' group only — never asked anywhere
  MAIN:     9768,   // carries "Buy together" and a size sibling
};
const VARIANT_GROUP = 9762;
const CUSTOMER = 9762;
const ORDER    = 9762;
const TOKEN    = 'extrasquickadd9762';
const IDS = Object.values(P);
const ph = IDS.map(() => '?').join(',');

function cleanup() {
  db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(ORDER);
  db.prepare('DELETE FROM retail_orders WHERE id = ?').run(ORDER);
  db.prepare(`DELETE FROM retail_product_option_choices WHERE option_id IN
                (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
}

function seed() {
  cleanup();
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, stock_qty, is_active, is_published,
                                bundle, variant_group_id, variant_label, variant_label_cn, variant_sort)
     VALUES (?,?,?,?,?,10,1,1,?,?,?,?,?)`);
  const bundle = JSON.stringify({ ids: [P.EXTRAS, P.HEAT, P.PLAIN] });
  prod.run(P.EXTRAS,   'QA Dip',     '测试蘸酱', 'qa-1', 49, null,   VARIANT_GROUP, 'Small', '小', 1);
  prod.run(P.HEAT,     'QA Soup',    '测试汤',   'qa-2', 45, null,   null, null, null, 0);
  prod.run(P.REQMULTI, 'QA Bowl',    '测试碗',   'qa-3', 55, null,   null, null, null, 0);
  prod.run(P.DEFAULT,  'QA Toast',   '测试吐司', 'qa-4', 35, null,   null, null, null, 0);
  prod.run(P.PLAIN,    'QA Bread',   '测试面包', 'qa-5', 30, null,   null, null, null, 0);
  prod.run(P.TEXT,     'QA Note',    '测试备注', 'qa-6', 20, null,   null, null, null, 0);
  prod.run(P.MAIN,     'QA Dip Big', '测试大蘸酱', 'qa-7', 89, bundle, VARIANT_GROUP, 'Large', '大', 2);

  let optId = 9762, chId = 9762;
  const opt = (pid, type, req, min, q) => {
    const id = optId++;
    db.prepare(
      `INSERT INTO retail_product_options
         (id, product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
       VALUES (?,?,?,?,?,?,?,0,0)`
    ).run(id, pid, q, q, type, req, min);
    return id;
  };
  const choice = (oid, label, delta, def = 0) => db.prepare(
    `INSERT INTO retail_product_option_choices (id, option_id, label_en, label_cn, price_delta, is_default, sort_order)
     VALUES (?,?,?,?,?,?,0)`
  ).run(chId++, oid, label, label, delta, def);

  // The dip: the "Add extras?" preset exactly as optAddExtras writes it.
  choice(opt(P.EXTRAS, 'multi', 0, 0, 'Add extras?'), 'Pita', 10);
  // The soup: "Heat up?" was made optional (Express orders), extras beside it.
  const heat = opt(P.HEAT, 'single', 0, 0, 'Heat up?');
  choice(heat, 'Yes', 0); choice(heat, 'No', 0);
  choice(opt(P.HEAT, 'multi', 0, 0, 'Add extras?'), 'Brown Rice', 8);
  choice(opt(P.REQMULTI, 'multi', 1, 0, 'Pick your sides'), 'Salad', 0);
  choice(opt(P.DEFAULT, 'multi', 0, 0, 'Add extras?'), 'Butter', 2, 1);
  opt(P.TEXT, 'text', 0, 0, 'Note');

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Quick Add Test', '13900000976', 'dev:extras-quick-add');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, customer_id, status, subtotal, total)
     VALUES (?,?,?,?,?,?)`
  ).run(ORDER, 'TCQUICK9762', CUSTOMER, 'delivered', 94, 94);
  const line = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,?,?)`);
  line.run(ORDER, P.EXTRAS, 'QA Dip',  '测试蘸酱', 1, 49, 49);
  line.run(ORDER, P.HEAT,   'QA Soup', '测试汤',   1, 45, 45);
}

// What every read must say: true = open the sheet first, false = add straight in.
const EXPECT = {
  [P.EXTRAS]: false, [P.HEAT]: true, [P.REQMULTI]: true,
  [P.DEFAULT]: true, [P.PLAIN]: false, [P.TEXT]: false,
};
const NAME = {
  [P.EXTRAS]: 'extras-only dip', [P.HEAT]: 'soup with optional "heat up?"',
  [P.REQMULTI]: 'required pick-any', [P.DEFAULT]: 'pre-ticked extra',
  [P.PLAIN]: 'no options', [P.TEXT]: 'text group only',
};

const app = express();
app.use(router);
let PORT = 0;
const get = (url, auth) => fetch(`http://127.0.0.1:${PORT}${url}`, {
  headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const rowsOf = (b) => (b && (Array.isArray(b.data) ? b.data : (b.data && (b.data.products || b.data.items)))) || [];

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nA · the rule');
    const asks = (pid) => !!db.prepare(`SELECT ${productOptions.asksFirstSql('?')} AS a`).get(pid).a;
    for (const [pid, want] of Object.entries(EXPECT)) {
      it(`${NAME[pid]} → ${want ? 'asks first' : 'adds straight in'}`, () => {
        assert.strictEqual(asks(Number(pid)), want);
      });
    }

    console.log('\nB · every read that ships has_options says the same');

    for (const q of ['', '&slim=1', '&lean=1']) {
      const list = await get(`/api/retail/products?ids=${Object.keys(EXPECT).join(',')}${q}`);
      it(`shop list${q || ' (full)'}`, () => {
        assert.strictEqual(list.status, 200, JSON.stringify(list.body));
        const rows = rowsOf(list.body);
        for (const [pid, want] of Object.entries(EXPECT)) {
          const r = rows.find(x => Number(x.id) === Number(pid));
          assert.ok(r, `${NAME[pid]} missing from the list`);
          assert.strictEqual(!!r.has_options, want, `${NAME[pid]} flagged ${!!r.has_options}`);
        }
      });
    }

    const pdp = await get(`/api/retail/products/${P.MAIN}`);
    const data = (pdp.body && pdp.body.data) || {};
    it('"Buy together" items', () => {
      const items = (data.bundle && data.bundle.items) || [];
      for (const pid of [P.EXTRAS, P.HEAT, P.PLAIN]) {
        const r = items.find(i => i.id === pid);
        assert.ok(r, `${NAME[pid]} missing from Buy together: ${JSON.stringify(items)}`);
        assert.strictEqual(!!r.has_options, EXPECT[pid], NAME[pid]);
      }
    });
    it('size rows (the dip as a smaller size)', () => {
      const v = (data.variants || []).find(x => x.id === P.EXTRAS);
      assert.ok(v, `size row missing: ${JSON.stringify(data.variants)}`);
      assert.strictEqual(!!v.has_options, false, 'picking the small dip would open the extras sheet');
    });

    const ord = await get(`/api/retail/orders/${ORDER}`, true);
    it('order lines, for "Buy again"', () => {
      assert.strictEqual(ord.status, 200, JSON.stringify(ord.body));
      const lines = (ord.body && ord.body.data && ord.body.data.items) || [];
      const dip  = lines.find(l => l.product_id === P.EXTRAS);
      const soup = lines.find(l => l.product_id === P.HEAT);
      assert.ok(dip && soup, JSON.stringify(lines));
      assert.strictEqual(!!dip.has_options, false, 'Buy again would open the dip page for its extras');
      assert.strictEqual(!!soup.has_options, true, 'Buy again would copy the soup without asking "heat up?"');
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
