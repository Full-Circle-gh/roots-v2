#!/usr/bin/env node
// Real SQL, independent tenant fixtures: the public count must never claim
// another company's sale, an unpaid order, a refund or an unavailable item.
// The card's lifted figure is checked separately and must not touch that SQL.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sales = require('../lib/qr-company-sales');
const i18n = require('../lib/qr-menu-i18n');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE store_products(id INTEGER PRIMARY KEY, variant_group_id INTEGER);
    CREATE TABLE retail_orders(id INTEGER PRIMARY KEY, status TEXT, channel TEXT,
      store_id INTEGER, paid_at TEXT, placed_at TEXT, replacement_for_order_id INTEGER);
    CREATE TABLE retail_order_items(order_id INTEGER, product_id INTEGER, qty REAL, refunded_qty REAL);
    INSERT INTO store_products VALUES(1,NULL),(2,2),(3,2),(4,NULL);`);
  return db;
}
const db = fixture(), other = fixture();
let id = 0;
function order({ product = 1, qty = 1, refunded = 0, status = 'paid', channel = 'shop',
  store = 1, paid = '2026-11-05 10:00:00', placed = paid, replacement = 0 } = {}) {
  db.prepare('INSERT INTO retail_orders VALUES(?,?,?,?,?,?,?)')
    .run(++id, status, channel, store, paid, placed, replacement);
  db.prepare('INSERT INTO retail_order_items VALUES(?,?,?,?)').run(id, product, qty, refunded);
}
try {
  order({ qty: 10 });
  order({ qty: 7, store: 2, channel: 'miniapp' });
  order({ qty: 6, store: 3, channel: 'meituan', refunded: 2 });
  order({ product: 2, qty: 3 });
  order({ product: 3, qty: 8, store: 2, channel: 'online' });
  for (const status of ['cancelled', 'refunded', 'pending_payment']) order({ qty: 500, status });
  order({ qty: 500, replacement: 1 });
  order({ qty: 500, paid: '2026-11-13 16:00:00' }); // today at +8
  order({ qty: 500, paid: '2026-10-14 15:59:59' }); // before window
  order({ qty: 2, paid: '2026-10-14 16:00:00' }); // first local midnight
  order({ qty: 3, paid: '2026-11-13 15:59:59' }); // last second
  order({ qty: 2, paid: null, placed: '2026-11-03 10:00:00' });
  order({ product: 4, qty: 3, refunded: 5 }); // clamp a historical bad refund
  const units = sales.readUnits(db, '2026-10-15', '2026-11-13', '+480 minutes');
  assert.strictEqual(units.get(1), 28, 'all stores/channels, net of refunds, exact local-day window');
  assert.strictEqual(units.get(2), 11, 'listed and unlisted variant siblings share a total');
  assert.ok(!units.has(4), 'no negative sales count');
  assert.strictEqual(sales.forProduct(units, { store_product_id: 3, variant_group_id: 2 }), 11);
  assert.strictEqual(sales.readUnits(other, '2026-10-15', '2026-11-13', '+480 minutes').size, 0,
    'another tenant handle cannot read this company');
  const rows = Array.from({ length: 8 }, (_, n) => ({ store_product_id: n + 1, company_units: 20 - n }));
  rows[0].sold_out = true;
  rows[7].company_units = 0;
  const groups = [{ sections: [{ items: rows }] }];
  assert.deepStrictEqual(sales.topSellers(groups).map(p => p.store_product_id), [2,3,4,5,6,7]);
  assert.strictEqual(sales.topSellers([{ sections: [{ items: [{ company_units: 0 }] }] }]).length, 0);
  for (const key of ['TOP SELLERS', 'Last 30 days · All locations', '{n} sold']) {
    for (const lang of i18n.LANGS.filter(l => l !== 'en')) assert.ok(i18n.UI[key][lang], `${key}: ${lang}`);
  }
  const labels = i18n.spans('{n} sold', '已售 {n}').replace(/\{n\}/g, '1,248');
  assert.ok(labels.includes('1,248 sold') && labels.includes('已售 1,248'));
  assert.ok(!labels.includes('{n}'));

  // §534 — 30% on a real sale, whole numbers. The recorded SQL above stays put.
  assert.strictEqual(sales.liftedUnits(413), 537);
  assert.strictEqual(sales.liftedUnits(310), 403);
  assert.strictEqual(sales.liftedUnits(97), 126);
  assert.strictEqual(sales.liftedUnits(94), 122);
  assert.strictEqual(sales.liftedUnits(1), 1);
  assert.strictEqual(sales.liftedUnits(2), 3);
  assert.strictEqual(sales.liftedUnits(0), 0);
  assert.strictEqual(sales.liftedUnits(0.2), 1);
  assert.strictEqual(sales.shownUnits(413, 1, 200), 537);
  assert.strictEqual(sales.quietCeiling([0, 0, 94, 413]), 121);
  assert.strictEqual(sales.quietCeiling([0, 0]), sales.QUIET_MAX);
  const quiet = sales.shownUnits(0, 10, sales.quietCeiling([0, 94]));
  assert.ok(quiet >= sales.QUIET_MIN && quiet <= sales.QUIET_MAX);
  assert.ok(quiet < sales.shownUnits(94, 11, 121));
  assert.strictEqual(quiet, sales.shownUnits(0, 10, sales.quietCeiling([0, 94])));
  assert.strictEqual(sales.shownUnits(0, 99, sales.quietCeiling([0, 1])), 1);
  const onlyZeros = Array.from({ length: 40 }, (_, i) => sales.shownUnits(0, i + 1, sales.quietCeiling([0])));
  for (const n of onlyZeros) assert.ok(n >= 4 && n <= 12);
  assert.ok(new Set(onlyZeros).size >= 3, 'quiet dishes do not share one number');
  const weak = sales.quietCeiling([0, 5]);
  assert.ok(sales.shownUnits(0, 7, weak) < sales.shownUnits(5, 8, weak));
  assert.strictEqual(units.get(1), 28, 'the lift does not rewrite the recorded count');

  const menu = fs.readFileSync(path.join(__dirname, '../routes/shop-menu.js'), 'utf8');
  assert.ok(!menu.includes("id: 'best'"), 'top sellers section is not built');
  assert.strictEqual((menu.match(/class="sales-scope"/g) || []).length, 1, 'the monthly line is drawn once');
  assert.ok(menu.includes("bi('Last 30 days · All locations', '近30天 · 所有门店')"));
  assert.ok(menu.includes('shownUnits'));
  console.log('PASS — company-wide sales, refunds, dates, variants, tenant isolation, ranking, lift and seven languages');
} finally { db.close(); other.close(); }
