#!/usr/bin/env node
/**
 * A paid extra that has run out must SAY so to the client.
 *
 *   node scripts/test_addon_available.js
 *
 * THE DEFECT THIS LOCKS DOWN. Both mini-app surfaces decide whether an option
 * choice is sold out with exactly one expression:
 *
 *     !!c.stock_product_id && c.addon_available === false
 *
 * (miniapp/pages/product/product.js, miniapp/pages/add-to-order/add-to-order.js)
 *
 * `addon_available` was READ in those two places and WRITTEN IN NONE — a
 * whole-tree grep found two readers and zero writers. The comparison could
 * therefore never be true. The sold-out guard never fired, the choice stayed
 * tappable, and `_doAddWithOptions`'s own `if (!c || c.sold_out) return;`
 * ("never bill/add a sold-out extra") never returned. A shopper could buy, and
 * be charged the price_delta for, an extra the counter had run out of — and
 * because expandStockLines reserves a stock-backed extra's inventory alongside
 * the main product, the shelf went negative behind it.
 *
 * So the assertions below are written against the CLIENT'S OWN EXPRESSION, not
 * against the field in isolation. A future change that renames the field, or
 * ships it as a string, or sends it only when true, would keep a field-level
 * assertion green while leaving both clients exactly as broken as they were.
 *
 * Everything runs against a REAL sqlite database and the REAL express route,
 * mounted and called over HTTP, so what is printed is observed rather than
 * reasoned about.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids clear of test_addon_stock_gate.js's 94xx/95xx/96xx/97xx block.
const STORE   = 9411;
const P_MAIN  = 9511;   // the drink the options hang off
const A_OUT   = 9512;   // a stock-backed extra at ZERO on every shelf
const A_IN    = 9513;   // a stock-backed extra with plenty on the shelf
const A_OFF   = 9514;   // a stock-backed extra that has been UNPUBLISHED
const A_GONE  = 9515;   // never inserted: a choice pointing at a deleted product

function cleanup() {
  const pids = [P_MAIN, A_OUT, A_IN, A_OFF, A_GONE];
  const ph   = pids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...pids);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...pids);
  db.prepare(`DELETE FROM retail_store_stock     WHERE product_id IN (${ph})`).run(...pids);
  db.prepare(`DELETE FROM store_products         WHERE id         IN (${ph})`).run(...pids);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}

function seed() {
  cleanup();

  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'aav-shop', 'Options Shop', '选项店', '广州市', '天河区', 1);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,?,1)`
  );
  prod.run(P_MAIN, 'Latte',     '拿铁',   'aav-0', 20, '350ml', 1);
  prod.run(A_OUT,  'Oat Milk',  '燕麦奶', 'aav-1',  3, '30ml',  1);
  prod.run(A_IN,   'Soy Milk',  '豆奶',   'aav-2',  3, '30ml',  1);
  prod.run(A_OFF,  'Rice Milk', '米奶',   'aav-3',  3, '30ml',  0);   // unpublished

  // Shelf: the out extra is at zero, the in extra is plentiful, the unpublished
  // one is ALSO plentiful — so a green result for it could only come from the
  // stock count alone, which is the thing being ruled out.
  const stock = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)`
  );
  stock.run(STORE, A_OUT,  0);
  stock.run(STORE, A_IN,  25);
  stock.run(STORE, A_OFF, 25);

  // One question, five choices: the four stock-backed cases above plus a FREE
  // choice with no stock_product_id at all — a sugar level has no shelf and
  // must never acquire a sold-out state.
  const optId = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (?,?,?,'multi',0,0)`
  ).run(P_MAIN, 'Milk?', '奶?').lastInsertRowid;

  const ch = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,0,?,?)`
  );
  ch.run(optId, 'Oat',      '燕麦', 3, A_OUT,  0);
  ch.run(optId, 'Soy',      '豆奶', 3, A_IN,   1);
  ch.run(optId, 'Rice',     '米奶', 3, A_OFF,  2);
  ch.run(optId, 'Deleted',  '已删', 3, A_GONE, 3);
  ch.run(optId, 'No milk',  '不加', 0, null,   4);
}

// THE CLIENT'S OWN EXPRESSION, copied character for character from
// miniapp/pages/product/product.js and add-to-order.js. If those two ever
// disagree with this line, this suite is the thing that should break.
const clientSaysSoldOut = c => !!c.stock_product_id && c.addon_available === false;

// ── The route, mounted and called over HTTP ────────────────────────────────
const app = express();
app.use(router);

let PORT = 0;
let pass = 0, fail = 0;

function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
  seed();

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  const resp = await fetch(`http://127.0.0.1:${PORT}/api/retail/products/${P_MAIN}`)
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  const product = (resp.body && (resp.body.data || resp.body)) || {};
  const choices = ((product.options || [])[0] || {}).choices || [];
  const byLabel = new Map(choices.map(c => [c.label_en, c]));

  console.log(`\nGET /api/retail/products/${P_MAIN} → ${resp.status}`);
  console.log('\n── What each choice reports');
  for (const c of choices) {
    console.log(
      `   ${String(c.label_en).padEnd(9)} stock_product_id ${String(c.stock_product_id ?? '(none)').padEnd(7)}`
      + ` addon_available ${String(c.addon_available)}`
      + `   client reads: ${clientSaysSoldOut(c) ? 'SOLD OUT' : 'orderable'}`
    );
  }

  console.log('\n── Assertions');

  check('the options and their choices come back at all', () => {
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(choices.length, 5, 'five choices were seeded');
  });

  // THE REGRESSION. Before the fix this was the one that could not pass: the
  // field was absent, `undefined === false` was false, and the client read a
  // sold-out extra as orderable.
  check('a stock-backed extra at ZERO reads SOLD OUT through the client expression', () => {
    const c = byLabel.get('Oat');
    assert.ok(c, 'the Oat choice came back');
    assert.strictEqual(c.addon_available, false);
    assert.strictEqual(clientSaysSoldOut(c), true, 'this is the comparison that was dead');
  });

  check('a stock-backed extra WITH stock stays orderable', () => {
    const c = byLabel.get('Soy');
    assert.strictEqual(c.addon_available, true);
    assert.strictEqual(clientSaysSoldOut(c), false);
  });

  check('an UNPUBLISHED extra is sold out even with a full shelf', () => {
    const c = byLabel.get('Rice');
    assert.strictEqual(c.addon_available, false, 'stock alone must not make it sellable');
    assert.strictEqual(clientSaysSoldOut(c), true);
  });

  check('a choice pointing at a DELETED product is sold out, not orderable', () => {
    const c = byLabel.get('Deleted');
    assert.strictEqual(c.addon_available, false, 'a dangling link cannot be honoured');
    assert.strictEqual(clientSaysSoldOut(c), true);
  });

  // The other half of the contract, and the easier one to break by accident:
  // a free choice has no shelf, so "absent" must stay "not applicable" rather
  // than becoming a third state the clients would read as sold out.
  check('a FREE choice carries no flag and is never sold out', () => {
    const c = byLabel.get('No milk');
    assert.strictEqual(c.stock_product_id, null);
    assert.strictEqual(c.addon_available, undefined, 'a sugar level has no shelf to be empty');
    assert.strictEqual(clientSaysSoldOut(c), false);
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
