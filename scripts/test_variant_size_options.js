#!/usr/bin/env node
/**
 * Picking a size never skips that size's question.
 *
 *   node scripts/test_variant_size_options.js
 *
 * WHY. Whole-Wheat Pita comes in sizes, and only one size — One Pita — asks
 * "heat up?" (options belong to one product row, and each size is its own
 * row). A customer could not see the question in the mini app: both size
 * sheets (the shop grid's + and the product page's Add) put the chosen size
 * straight into the cart with no answers. Products without sizes already
 * asked; sizes did not, because the server never said which size asks.
 *
 * NOW: each size row on the product page carries `has_options`, and both size
 * sheets hand a size that asks to its choice sheet (utils/pick-queue, or the
 * sheet already on the page when it is the size open there). A page opened in
 * pick mode for one size does not re-open the size sheet.
 *
 * WHAT IS RUN FOR REAL: the server answer. WHAT IS READ FROM SOURCE: the mini
 * app, which has no runtime here; each check names the path it holds.
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

// 965x is clear of every other suite's block (974x bulk add pick, 977x
// checkout required options, 95xx option limits, 96xx addon stock gate).
const P_PACK = 9651;   // group owner — a pack of pitas, no question
const P_ONE  = 9652;   // one pita — asks "heat up?"
const OPT    = 9653;
const CH_YES = 9654, CH_NO = 9655;

function cleanup() {
  db.prepare('DELETE FROM retail_product_option_choices WHERE option_id = ?').run(OPT);
  db.prepare('DELETE FROM retail_product_options WHERE id = ?').run(OPT);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_PACK, P_ONE);
}

function seed() {
  cleanup();
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, stock_qty, is_active, is_published,
                                 variant_group_id, variant_label, variant_label_cn, variant_sort)
     VALUES (?,?,?,?,?,?,1,1,?,?,?,?)`);
  prod.run(P_PACK, 'Size Pita', '规格皮塔', 'vso-1', 45, 10, P_PACK, 'Pack of 5', '五个装', 0);
  prod.run(P_ONE,  'Size Pita', '规格皮塔', 'vso-2', 10, 10, P_PACK, 'One Pita', '一个口袋饼', 1);
  db.prepare(
    `INSERT INTO retail_product_options
       (id, product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
     VALUES (?,?,?,?,?,0,0,0,0)`
  ).run(OPT, P_ONE, 'Heat up?', '是否加热?', 'single');
  const ch = db.prepare(
    `INSERT INTO retail_product_option_choices (id, option_id, label_en, label_cn, price_delta, is_default, sort_order)
     VALUES (?,?,?,?,0,0,?)`);
  ch.run(CH_YES, OPT, 'Yes', '要', 0);
  ch.run(CH_NO,  OPT, 'No',  '不要', 1);
}

const app = express();
app.use(router);
let PORT = 0;
const get = (url) => fetch(`http://127.0.0.1:${PORT}${url}`)
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nA · the server says which size asks a question');

    // Opened on the size WITHOUT the question — the page a customer lands on
    // from the shop card — and on the size with it.
    for (const pageId of [P_PACK, P_ONE]) {
      const pdp = await get(`/api/retail/products/${pageId}`);
      const sizes = (pdp.body && pdp.body.data && pdp.body.data.variants) || [];
      it(`size rows carry has_options (page opened on #${pageId})`, () => {
        assert.strictEqual(pdp.status, 200, JSON.stringify(pdp.body));
        const one = sizes.find(v => v.id === P_ONE);
        const pack = sizes.find(v => v.id === P_PACK);
        assert.ok(one && pack, `size rows missing: ${JSON.stringify(sizes)}`);
        assert.ok(one.has_options, 'One Pita is not flagged — the size sheet adds it without asking');
        assert.ok(!pack.has_options, 'a size with no question is flagged — it would be sent to a pick it does not need');
      });
    }

    console.log('\nB · both size sheets ask the chosen size its question');

    const src = (rel) => fs.readFileSync(path.join(ROOT, 'miniapp', rel), 'utf8');
    // The body of a page's vpChoose — the size sheet's tap handler.
    const vpChoose = (s) => {
      const i = s.indexOf('\n  vpChoose(e) {');
      assert.ok(i >= 0, 'vpChoose not found');
      const j = s.indexOf('\n  },', i);
      return s.slice(i, j);
    };

    const shop = vpChoose(src('pages/shop/shop.js'));
    it('shop grid size sheet opens the choice sheet for a size that asks', () => {
      const ask = shop.indexOf('if (m.has_options) { pickQueue.start([{ id, qty: 1 }]); return; }');
      const add = shop.indexOf('this._addRawToCart(');
      assert.ok(ask >= 0, 'the shop size sheet never checks has_options');
      assert.ok(ask < add, 'the shop size sheet adds to the cart before asking');
      assert.ok(/const pickQueue = require\('\.\.\/\.\.\/utils\/pick-queue'\);/.test(src('pages/shop/shop.js')));
    });

    const prodSrc = src('pages/product/product.js');
    const prod = vpChoose(prodSrc);
    it('product page size sheet asks before adding', () => {
      const ask = prod.indexOf('if (m.has_options) {');
      const add = prod.indexOf('cart.add(');
      assert.ok(ask >= 0, 'the product page size sheet never checks has_options');
      assert.ok(ask < add, 'the product page size sheet adds to the cart before asking');
      assert.ok(prod.includes('pickQueue.start([{ id, qty: this.data.qty }]);'),
        'another size with a question is not opened on its own page');
      assert.ok(prod.includes('this._openOptionPicker(); return;'),
        'the size open on the page does not use the options it already has');
    });

    it('a page opened for one size (pick mode) does not re-ask the size', () => {
      assert.ok(prodSrc.includes('if (this.data.hasVariants && !this._pickMode) { this._openVariantPicker(); return; }'),
        'pick mode re-opens the size sheet, so the question is never reached');
    });

    console.log('\n' + pass + ' checks passed.\n');
  } finally {
    server.close();
    cleanup();
  }
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
