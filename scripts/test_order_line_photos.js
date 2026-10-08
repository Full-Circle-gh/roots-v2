#!/usr/bin/env node
/**
 * A till-only product's photo shows on the staff order screen.
 *
 *   node scripts/test_order_line_photos.js
 *
 * THE REPORT. TC000990, a Yuexiu order: four shop products with their photos,
 * and an Americano under them with an empty square. The Americano is a drink
 * made at the counter. It is sold at the till and never published to the shop
 * (§150), and the staff order detail sent every line's photo through the PUBLIC
 * image route, which refuses anything unpublished. So the line had a photo and
 * the screen got a 404 for it.
 *
 * THE FIX. The staff order detail and the dashboard's Top products both point
 * at the ADMIN image route, the one the till's tiles already use for the same
 * reason (§289). Both are staff screens, so the operator's cookie rides on the
 * <img> request.
 *
 * Real sqlite, the real routes/retail.js router, called over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const { testOperator } = require('./lib/test-operator');
const db = tdb();

// The suite's own operator, made and removed by the suite — see scripts/lib/test-operator.js.
const op = testOperator(99871, '__op_order_line_photos');
const P_TILL  = 9921;   // sold at the counter, never published, has a photo
const P_SHOP  = 9922;   // published, has a photo
const P_NONE  = 9923;   // published, no photo
const CUSTOMER = 9924;
const ORDER_NO = '__OLP000001';

// A 1×1 PNG. The bytes only have to come back; nothing here resizes them.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const URI = 'data:image/png;base64,' + PNG.toString('base64');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function cleanup() {
  op.remove();
  const o = db.prepare('SELECT id FROM retail_orders WHERE order_no = ?').get(ORDER_NO);
  if (o) {
    db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM retail_orders WHERE id = ?').run(o.id);
  }
  db.prepare(`DELETE FROM store_products WHERE id IN (${P_TILL}, ${P_SHOP}, ${P_NONE})`).run();
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
}

(async () => {
  cleanup();
  const ins = db.prepare(`
    INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category,
                                is_active, is_published, image_data, updated_at)
    VALUES (?, ?, ?, ?, 24, 'Coffee', 1, ?, ?, '2026-10-08 10:00:00')`);
  ins.run(P_TILL, 'Fixture Americano', '测试美式', '__OLP-9921', 0, URI);
  ins.run(P_SHOP, 'Fixture juice',     '测试果汁', '__OLP-9922', 1, URI);
  ins.run(P_NONE, 'Fixture no photo',  '测试无图', '__OLP-9923', 1, null);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?, '__order_line_photos', '13900009924', '__olp_openid_9924', 0, 0, 0)`
  ).run(CUSTOMER);
  const oid = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method,
                                fulfillment_type, subtotal, total, paid_at, delivered_at, channel)
     VALUES (?, ?, 'delivered', 'wechat', 'delivery', 72, 72,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wechat')`
  ).run(ORDER_NO, CUSTOMER).lastInsertRowid;
  const line = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total)
     VALUES (?, ?, ?, 1, 24, 24)`);
  for (const pid of [P_TILL, P_SHOP, P_NONE]) line.run(oid, pid, 'line ' + pid);

  op.add();
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: op.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url) => fetch(base + url).then(async r => ({
    status: r.status, buf: Buffer.from(await r.arrayBuffer()),
  }));

  try {
    const r = await fetch(`${base}/api/retail-admin/orders/${oid}`).then(x => x.json());
    const items = (r && r.data && r.data.items) || [];
    const byPid = new Map(items.map(it => [it.product_id, it]));

    console.log('\nThe staff order detail points every line at the staff image route');
    await check('the order came back with its three lines', () => {
      assert.ok(r && r.success, 'order detail did not answer success');
      assert.strictEqual(items.length, 3);
    });
    await check('the till-only line names the admin route, not the public one', () => {
      assert.strictEqual(byPid.get(P_TILL).image_url, `/api/retail-admin/products/${P_TILL}/image`);
    });
    await check('that URL returns the photo — the empty square on TC000990', async () => {
      const img = await get(byPid.get(P_TILL).image_url);
      assert.strictEqual(img.status, 200);
      assert.ok(img.buf.equals(PNG), 'the photo bytes did not come back');
    });
    await check('a published line still gets its photo', async () => {
      const img = await get(byPid.get(P_SHOP).image_url);
      assert.strictEqual(img.status, 200);
    });
    await check('a product with no photo at all is still a 404, so the screen draws its blank', async () => {
      assert.strictEqual((await get(byPid.get(P_NONE).image_url)).status, 404);
    });

    console.log('\nThe public route still refuses the unpublished product');
    await check('the same product on the public route is 404', async () => {
      assert.strictEqual((await get(`/api/retail/products/${P_TILL}/image`)).status, 404);
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
