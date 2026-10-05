#!/usr/bin/env node
/**
 * Bulk adds never put a product with a question into the cart unanswered (§434).
 *
 *   node scripts/test_bulk_add_pick.js
 *
 * WHY. A customer's Whole-Wheat Pita carries a required "heat up?" question.
 * Checkout refused the order ("Please choose: Whole-Wheat Pita"), and removing
 * the pita and adding it back did not help: four mini app paths called
 * cart.add(p, qty, []) for every item, answering nothing — "Buy again" on an
 * order, favourites "Add all", the home bundle block (and its copy in the
 * layout page), and the product page's "Buy together". The single quick adds
 * (shop grid +, one favourite) already opened the product page for a product
 * with options; these did not.
 *
 * NOW: those paths add what needs no answer and hand the rest to
 * utils/pick-queue, which opens each product page with its choice sheet up.
 *
 * WHAT IS RUN FOR REAL: the two server answers the clients need and did not
 * have — `has_options` on a product page's "Buy together" items, and on each
 * line of a customer's order (for "Buy again"). The home, layout and favourites
 * lists already carried it. WHAT IS READ FROM SOURCE: the mini app, which has
 * no runtime here; each check names the path it holds.
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

// 974x is clear of every other suite's block (977x checkout required options,
// 95xx option limits, 96xx addon stock gate, 98xx preorder park).
const P_MAIN  = 9741;   // carries the "Buy together" set
const P_ASKS  = 9742;   // has a required question — the pita's shape
const P_PLAIN = 9743;   // no question
const OPT     = 9744;
const CH_YES  = 9745, CH_NO = 9746;
const CUSTOMER = 9747;
const ORDER    = 9748;
const TOKEN    = 'bulkaddpick9747';

function cleanup() {
  db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(ORDER);
  db.prepare('DELETE FROM retail_orders WHERE id = ?').run(ORDER);
  db.prepare('DELETE FROM retail_product_option_choices WHERE option_id = ?').run(OPT);
  db.prepare('DELETE FROM retail_product_options WHERE id = ?').run(OPT);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM store_products WHERE id IN (?,?,?)`).run(P_MAIN, P_ASKS, P_PLAIN);
}

function seed() {
  cleanup();
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, stock_qty, is_active, is_published, bundle)
     VALUES (?,?,?,?,?,?,1,1,?)`);
  prod.run(P_MAIN,  'Bulk Main',  '批量主品', 'bap-1', 30, 10, JSON.stringify({ ids: [P_ASKS, P_PLAIN] }));
  prod.run(P_ASKS,  'Bulk Pita',  '批量皮塔', 'bap-2', 45, 10, null);
  prod.run(P_PLAIN, 'Bulk Bread', '批量面包', 'bap-3', 50, 10, null);
  db.prepare(
    `INSERT INTO retail_product_options
       (id, product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
     VALUES (?,?,?,?,?,1,0,0,0)`
  ).run(OPT, P_ASKS, 'Heat up?', '需要加热吗?', 'single');
  const ch = db.prepare(
    `INSERT INTO retail_product_option_choices (id, option_id, label_en, label_cn, price_delta, is_default, sort_order)
     VALUES (?,?,?,?,0,0,?)`);
  ch.run(CH_YES, OPT, 'Yes', '要', 0);
  ch.run(CH_NO,  OPT, 'No',  '不要', 1);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Bulk Add Test', '13900000074', 'dev:bulk-add-pick');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  // An order placed BEFORE the pita gained its question: its line carries no
  // answers. That is the line "Buy again" used to copy forward blank.
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, customer_id, status, subtotal, total)
     VALUES (?,?,?,?,?,?)`
  ).run(ORDER, 'TCBULK9748', CUSTOMER, 'delivered', 95, 95);
  const line = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,?,?)`);
  line.run(ORDER, P_ASKS,  'Bulk Pita',  '批量皮塔', 2, 45, 90);
  line.run(ORDER, P_PLAIN, 'Bulk Bread', '批量面包', 1, 50, 50);
}

const app = express();
app.use(router);
let PORT = 0;
const get = (url, auth) => fetch(`http://127.0.0.1:${PORT}${url}`, {
  headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nA · the server says which items ask a question');

    const pdp = await get(`/api/retail/products/${P_MAIN}`);
    const items = (pdp.body && pdp.body.data && pdp.body.data.bundle && pdp.body.data.bundle.items) || [];
    it('"Buy together" items carry has_options', () => {
      const asks = items.find(i => i.id === P_ASKS);
      const plain = items.find(i => i.id === P_PLAIN);
      assert.ok(asks && plain, `bundle items missing: ${JSON.stringify(items)}`);
      assert.ok(asks.has_options, 'the item with a question is not flagged — Buy together adds it blank');
      assert.ok(!plain.has_options, 'an item with no question is flagged — it would be sent to a pick it does not need');
    });

    const ord = await get(`/api/retail/orders/${ORDER}`, true);
    const lines = (ord.body && ord.body.data && ord.body.data.items) || [];
    it('each order line carries has_options, for "Buy again"', () => {
      assert.strictEqual(ord.status, 200, JSON.stringify(ord.body));
      const asks = lines.find(l => l.product_id === P_ASKS);
      const plain = lines.find(l => l.product_id === P_PLAIN);
      assert.ok(asks && plain, `order lines missing: ${JSON.stringify(lines)}`);
      assert.ok(asks.has_options, 'the pita line is not flagged — Buy again copies it blank');
      assert.ok(!plain.has_options);
    });

    console.log('\nB · every bulk path hands a question to the queue instead of adding it blank');

    const src = (rel) => fs.readFileSync(path.join(ROOT, 'miniapp', rel), 'utf8');
    const paths = [
      ['pages/order/order.js',         '"Buy again"',       /!opts\.length && it\.has_options\) \{ toPick\.push/],
      ['pages/favorites/favorites.js', 'favourites Add all', /v\.product && v\.product\.has_options\) \{ toPick\.push/],
      ['pages/home/home.js',           'home bundle list',  /p && p\.has_options\) \{ toPick\.push/],
      ['pages/layout/layout.js',       'layout bundle list', /p && p\.has_options\) \{ toPick\.push/],
      ['pages/product/product.js',     '"Buy together"',    /it\.has_options\) \{ toPick\.push/],
    ];
    for (const [rel, label, re] of paths) {
      const s = src(rel);
      it(`${label} (${rel}) sets a question aside`, () => {
        assert.ok(re.test(s), `${label} adds a product with a question straight to the cart`);
        assert.ok(/pickQueue\.start\(/.test(s), `${label} never opens the products it set aside`);
      });
    }
    it('home bundle PRODUCT with a question goes to its page', () => {
      assert.ok(/bp && bp\.has_options\) \{ pickQueue\.start\(/.test(src('pages/home/home.js')));
    });

    console.log('\nC · the product page answers the queue');

    const prod = src('pages/product/product.js');
    it('pick=1 opens the choice sheet by itself', () => {
      assert.ok(/query\.pick === '1'/.test(prod));
      assert.ok(/if \(pickMode && this\.data\.product\) this\.addToCart\(\);/.test(prod));
    });
    it('only a page the queue opened moves it on', () => {
      assert.ok(/const nxt = this\._pickMode \? pickQueue\.next\(\) : null;/.test(prod),
        'the page that started "Buy together" could pull the next queued product on an ordinary add');
    });
    it('a product page opened any other way ends the batch', () => {
      assert.ok(/\} else \{\s*pickQueue\.clear\(\);/.test(prod));
    });

    const q = src('utils/pick-queue.js');
    it('the queue opens product pages in pick mode, carrying the quantity', () => {
      assert.ok(q.includes("'/pages/product/product?id=' + entry.id + '&pick=1'"));
      assert.ok(q.includes("'&qty=' + Number(entry.qty)"));
    });

    console.log('\nD · no bulk path is left behind');

    // Any cart.add(…, []) — no answers — in a page must sit behind a
    // has_options guard. A new bulk path added later without one is the same
    // door this suite was written to close.
    const pagesDir = path.join(ROOT, 'miniapp', 'pages');
    const offenders = [];
    for (const dir of fs.readdirSync(pagesDir)) {
      const f = path.join(pagesDir, dir, dir + '.js');
      if (!fs.existsSync(f)) continue;
      const s = fs.readFileSync(f, 'utf8');
      if (/cart\.add\([^;]*,\s*\[\]\)/.test(s) && !/has_options/.test(s)) offenders.push(dir);
    }
    it('every page that adds with no answers also checks has_options', () => {
      assert.deepStrictEqual(offenders, [], 'pages adding blank lines with no has_options check: ' + offenders.join(', '));
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
