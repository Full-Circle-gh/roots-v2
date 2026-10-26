#!/usr/bin/env node
/**
 * The till's best-sellers row — §499.
 *
 *   node scripts/test_till_best_sellers.js
 *
 * Ash: "best seller from the till should show at the top of the till for easy
 * access". A mock-up was approved: a row of the location's top sellers above
 * the grid, fixed for the day, sold-out ones greyed in place.
 *
 * Runs against the REAL sqlite database and the REAL router over HTTP, with
 * only the auth choke point stubbed, as scripts/test_counter_catalogue.js does.
 *
 * Held here:
 *   1. Ranked by UNITS, summed across orders, ties by id.
 *   2. The window is the 30 whole days that ended last night, both ends in:
 *      today's sales and day 31 are out.
 *   3. This location's till only — not another location, not its QR orders,
 *      not an order nobody paid for.
 *   4. Only what is on this till's glass, cut to six AFTER that, and a sold-out
 *      best seller keeps its place.
 *   5. It does not move during the day: a sale after the first read leaves the
 *      row as it was.
 *   6. The till draws it on All with no search, through the ordinary tap.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../middleware/auth', { logActivity: () => {} });

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { shopDaysAgo, shopOffsetMinutes } = require(path.join(ROOT, 'lib', 'shop-clock.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the blocks the other suites use.
const LOC_A = 9871;
const LOC_B = 9872;

const P1  = 9981;  // 10 units yesterday                       → 1st
const P2  = 9982;  // 7 units on day 30, the window's first day → 2nd
const P3  = 9983;  // 3 + 2 units over two orders               → 3rd
const P4  = 9984;  // 4 units, nothing on the shelf now         → 4th, sold out
const P5  = 9985;  // 3 units                                   → 5th
const P6  = 9986;  // 2 units, ties P7 and wins on id           → 6th
const P7  = 9987;  // 2 units                                   → 7th, past the cut
const P8  = 9988;  // 100 units TODAY                           → out
const P9  = 9989;  // 50 units on day 31                        → out
const P10 = 9990;  // 60 units at LOC_B                         → B's, not A's
const P11 = 9991;  // 40 units through A's QR menu              → out
const P12 = 9992;  // 30 pending, 30 cancelled                  → out
const P13 = 9993;  // 20 units, restock-only: not on the glass  → out, takes no slot

const ALL = [P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11, P12, P13];

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  const ids = db.prepare(`SELECT id FROM retail_orders WHERE order_no LIKE '__TBS-%'`).all().map(r => r.id);
  if (ids.length) db.prepare(`DELETE FROM retail_order_items WHERE order_id IN (${ids.join(',')})`).run();
  db.prepare(`DELETE FROM retail_orders WHERE order_no LIKE '__TBS-%'`).run();
  db.prepare('DELETE FROM retail_store_stock WHERE store_id IN (?, ?)').run(LOC_A, LOC_B);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ALL.join(',')})`).run();
  db.prepare('DELETE FROM retail_stores WHERE id IN (?, ?)').run(LOC_A, LOC_B);
}
cleanup();

db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_best_a', 'Best fixture A', '测试热销A', 1, 98)`).run(LOC_A);
db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_best_b', 'Best fixture B', '测试热销B', 1, 99)`).run(LOC_B);

const insProduct = db.prepare(`
  INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category,
                              is_active, is_published, is_restock_only)
  VALUES (?, ?, ?, ?, 20, 'Dry & Pantry', 1, 1, ?)`);
for (const id of ALL) insProduct.run(id, `Fixture best ${id}`, `测试热销${id}`, `__B-${id}`, id === P13 ? 1 : 0);

const insStock = db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
                             VALUES (?, ?, 50, 0)`);
for (const id of ALL) if (id !== P4) insStock.run(LOC_A, id);
insStock.run(LOC_B, P10);

// A paid_at that lands at noon on `day` on the shop's own clock, whatever zone
// this database's first location is in.
const OFF = shopOffsetMinutes();
function noonOn(day) {
  return new Date(Date.parse(day + 'T12:00:00Z') - OFF * 60000).toISOString().slice(0, 19).replace('T', ' ');
}
let seq = 0;
function sale({ loc = LOC_A, daysAgo = 1, entry = 'till', status = 'paid', lines }) {
  const at = noonOn(shopDaysAgo(daysAgo));
  const id = db.prepare(`
    INSERT INTO retail_orders (order_no, status, channel, shop_entry_method, store_id, placed_at, paid_at)
    VALUES (?, ?, 'shop', ?, ?, ?, ?)`)
    .run(`__TBS-${++seq}`, status, entry, loc, at, status === 'paid' ? at : null).lastInsertRowid;
  const ins = db.prepare(`INSERT INTO retail_order_items (order_id, product_id, qty, unit_price, line_total)
                          VALUES (?, ?, ?, 20, ?)`);
  for (const [pid, qty] of lines) ins.run(id, pid, qty, qty * 20);
}
sale({ lines: [[P1, 10]] });
sale({ daysAgo: 30, lines: [[P2, 7]] });
sale({ daysAgo: 4, lines: [[P3, 3], [P5, 3]] });
sale({ daysAgo: 9, lines: [[P3, 2], [P4, 4]] });
sale({ daysAgo: 2, lines: [[P6, 2], [P7, 2]] });
sale({ daysAgo: 0, lines: [[P8, 100]] });
sale({ daysAgo: 31, lines: [[P9, 50]] });
sale({ loc: LOC_B, lines: [[P10, 60]] });
sale({ entry: 'qr', lines: [[P11, 40]] });
sale({ status: 'pending_payment', lines: [[P12, 30]] });
sale({ status: 'cancelled', lines: [[P12, 30]] });
sale({ lines: [[P13, 20]] });

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => { req.user = { id: 3, username: 'mei' }; req.caps = null; req.scopeStores = null; next(); });
app.use(router);

let server, PORT;
function call(url) {
  return fetch(`http://127.0.0.1:${PORT}${url}`)
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}
const cat = (loc) => call(`/api/retail-admin/stores/${loc}/counter-catalogue`);

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    const a = await cat(LOC_A);
    const b = await cat(LOC_B);
    const bestA = (a.json && a.json.data && a.json.data.best_sellers) || null;
    const bestB = (b.json && b.json.data && b.json.data.best_sellers) || null;
    const rowsA = (a.json && a.json.data && a.json.data.rows) || [];

    console.log('\nThe ranking');
    check('the catalogue answers with best_sellers, a list of product ids', () => {
      assert.strictEqual(a.status, 200);
      assert.ok(Array.isArray(bestA), JSON.stringify(a.json && a.json.data && Object.keys(a.json.data)));
    });
    check('most units first, summed across orders, ties by id, six at most', () => {
      assert.deepStrictEqual(bestA, [P1, P2, P3, P4, P5, P6]);
    });

    console.log('\nThe window — 30 whole days, ending last night');
    check("today's sales are out, however many", () => assert.ok(!bestA.includes(P8)));
    check('day 30 is in and day 31 is out', () => {
      assert.ok(bestA.includes(P2), 'the first day of the window was dropped');
      assert.ok(!bestA.includes(P9));
    });

    console.log('\nThis location, this till, paid');
    check("another location's sales are not this one's", () => {
      assert.ok(!bestA.includes(P10));
      assert.deepStrictEqual(bestB, [P10]);
    });
    check('QR orders at the same shop are not till sales', () => assert.ok(!bestA.includes(P11)));
    check('an order nobody paid for counts for nothing', () => assert.ok(!bestA.includes(P12)));

    console.log('\nWhat is on the glass');
    check('a product off the glass is dropped before the cut, so it takes no slot', () => {
      assert.ok(!rowsA.some(r => r.product_id === P13), 'fixture: restock-only must not be on the glass');
      assert.ok(!bestA.includes(P13));
      assert.ok(bestA.includes(P6), 'the sixth slot went to a product the till cannot show');
    });
    check('a sold-out best seller keeps its place', () => {
      const r = rowsA.find(x => x.product_id === P4);
      assert.ok(r); assert.strictEqual(r.stock, 0);
      assert.strictEqual(bestA.indexOf(P4), 3);
    });

    console.log('\nIt does not move during the day');
    sale({ lines: [[P7, 500]] });
    const again = await cat(LOC_A);
    check('a big sale after the first read leaves the row as it was', () => {
      assert.deepStrictEqual(again.json.data.best_sellers, [P1, P2, P3, P4, P5, P6]);
    });

    console.log('\nThe till draws it');
    const till = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
    check('it keeps the list from the catalogue', () => {
      assert.match(till, /S\.best = \(r && r\.data && Array\.isArray\(r\.data\.best_sellers\)\) \? r\.data\.best_sellers : \[\];/);
    });
    check('only on All with no search', () => {
      assert.match(till, /var best = \(S\.cat \|\| S\.q\.trim\(\)\) \? \[\] : bestProducts\(\);/);
    });
    check('a best-seller tile adds through the same tap, and greys when out', () => {
      const fn = till.slice(till.indexOf('function bestTile(p)'), till.indexOf('function renderGrid()'));
      assert.match(fn, /data-add="' \+ p\.id \+ '"/);
      assert.match(fn, /\(out \? ' disabled' : ''\)/);
    });
    check('the three words are lifted pairs on the STRINGS table', () => {
      assert.match(till, /bestSellers:\s+\['Best sellers', '热销商品'\]/);
      assert.match(till, /last30:\s+\['Last 30 days', '近 30 天'\]/);
      assert.match(till, /allItems:\s+\['All items', '全部商品'\]/);
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
