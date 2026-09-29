#!/usr/bin/env node
/**
 * The till's product tiles carry a photo — §289.
 *
 *   node scripts/test_till_photos.js
 *
 * WHY THE TILL NEEDED ITS OWN THUMBNAIL. Two products with one name ("Garlic
 * Dill Sour Cream", a toast and a jar) were told apart at the counter only by
 * their code and price, and a cashier reads neither. A photo is read first. The
 * shop lists already fetch small photos from the PUBLIC image route, but that
 * route refuses anything unpublished — and the till sells unpublished products
 * on purpose (§150: a made-here latte, a box counted on this shelf). So the
 * ADMIN image route learned ?w, the same downscale the public route does.
 *
 * THE ONE THING THAT MUST NOT HAPPEN. Both routes share one in-process
 * thumbnail cache, and the public route reads that cache BEFORE its published
 * check. Had the admin route written the public route's key, an unpublished
 * product's photo would be served to anybody who asked for it once a till had
 * drawn it. The keys are kept apart; the second check below proves it by
 * asking the public route for the exact thumbnail a till just fetched.
 *
 * Real sqlite, the real routes/retail.js router, called over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');
const sharp   = require('sharp');

const ROOT = path.join(__dirname, '..');
const rawDb = require(path.join(ROOT, 'database.js'));
// Creates tenants / tenant_users at require time, so the operator below has a
// tenant to belong to on a fresh database.
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

// An owner of our own on tenant 1, on the control-plane handle, as
// scripts/test_qr_menu_category_order.js does. A fresh database has no owner,
// and a suite that skipped there would protect nothing in CI.
const OPERATOR = 99841;
const P_UNPUB  = 9981;   // counted on a shelf, never published, has a photo
const P_PUB    = 9982;   // published, has a photo
const P_NONE   = 9983;   // published, no photo

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function cleanup() {
  db.prepare(`DELETE FROM store_products WHERE id IN (${P_UNPUB}, ${P_PUB}, ${P_NONE})`).run();
  try { rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(OPERATOR); } catch (e) {}
}

(async () => {
  cleanup();
  // A real 600×400 PNG, so the downscale has something to do.
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#c86' } }).png().toBuffer();
  const uri = 'data:image/png;base64,' + png.toString('base64');
  const ins = db.prepare(`
    INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category,
                                is_active, is_published, image_data, updated_at)
    VALUES (?, ?, ?, ?, 10, 'Toasts', 1, ?, ?, '2026-09-29 10:00:00')`);
  ins.run(P_UNPUB, 'Fixture photo toast', '测试照片吐司', '__PH-9981', 0, uri);
  ins.run(P_PUB,   'Fixture photo jar',   '测试照片罐',   '__PH-9982', 1, uri);
  ins.run(P_NONE,  'Fixture no photo',    '测试无照片',   '__PH-9983', 1, null);
  rawDb.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
                 VALUES (?, 1, '__till_photo_owner', 'x', 'owner', 1)`).run(OPERATOR);

  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url) => fetch(base + url).then(async r => ({
    status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'),
    buf: Buffer.from(await r.arrayBuffer()),
  }));
  const V = '&v=' + encodeURIComponent('2026-09-29 10:00:00');

  try {
    console.log('\nThe admin route sends a thumbnail when asked (?w)');
    const thumb = await get(`/api/retail-admin/products/${P_UNPUB}/image?w=120${V}`);
    await check('an unpublished product: 200, an image, downscaled to the width asked', async () => {
      assert.strictEqual(thumb.status, 200);
      assert.match(thumb.type || '', /^image\/png/);
      const meta = await sharp(thumb.buf).metadata();
      assert.strictEqual(meta.width, 120, `width ${meta.width}, expected 120`);
    });
    await check('it is cached privately — it is an operator read, not a public one', () => {
      assert.match(thumb.cache || '', /^private/);
    });
    await check('asked again, the cached copy is the same bytes', async () => {
      const again = await get(`/api/retail-admin/products/${P_UNPUB}/image?w=120${V}`);
      assert.strictEqual(again.status, 200);
      assert.ok(again.buf.equals(thumb.buf));
    });

    console.log('\nThe public route still refuses what was never published');
    await check('the SAME thumbnail a till just fetched is 404 on the public route', async () => {
      const pub = await get(`/api/retail/products/${P_UNPUB}/image?w=120${V}`);
      assert.strictEqual(pub.status, 404, 'the admin cache entry leaked to the public route');
    });

    console.log('\nNothing else changed');
    await check('the admin route without ?w still sends the original photo', async () => {
      const full = await get(`/api/retail-admin/products/${P_UNPUB}/image`);
      assert.strictEqual(full.status, 200);
      assert.ok(full.buf.equals(png), 'the full-size read should be the stored bytes, untouched');
    });
    await check('the public route still thumbnails a published product', async () => {
      const pub = await get(`/api/retail/products/${P_PUB}/image?w=150${V}`);
      assert.strictEqual(pub.status, 200);
      assert.match(pub.cache || '', /^public/);
      assert.strictEqual((await sharp(pub.buf).metadata()).width, 150);
    });
    await check('a product with no photo is 404 on the admin route, with or without ?w', async () => {
      assert.strictEqual((await get(`/api/retail-admin/products/${P_NONE}/image?w=120`)).status, 404);
      assert.strictEqual((await get(`/api/retail-admin/products/${P_NONE}/image`)).status, 404);
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
