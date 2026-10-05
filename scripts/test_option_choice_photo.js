#!/usr/bin/env node
/**
 * A choice shows the picture of the product it is linked to.
 *
 *   node scripts/test_option_choice_photo.js
 *
 * Ash, 2026-10-05, on a product's paid extras: "i want the customer to see a
 * picture of each item when he make the choice". A choice has no photo of its
 * own; its stock_product_id link does (lib/choice-photo.js).
 *
 * What this locks down:
 *
 *   the store   GET /api/retail/products/:id gives a linked, photographed
 *               choice an image_url, and nothing to a choice with no link or
 *               no photo
 *   the route   /api/retail/option-choices/:id/image serves the photo even
 *               when the linked add-on is UNPUBLISHED (the usual case, and the
 *               reason the product image route could not be used), and
 *               refuses when the PARENT product is not public
 *   the menu    the QR menu's choices carry `img` pointing at the menu's own
 *               /s/:code/c/:id route, never the linked product's id, and that
 *               route refuses a choice whose product is not on that menu
 *   the page    each picker actually draws the picture
 *
 * Real sqlite database, real express routes, called over HTTP.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail   = require(path.join(ROOT, 'routes', 'retail.js'));
const shopMenu = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
const LOC      = 9468;
const CODE     = 'QPTSAAD7';
const P_BOWL   = 9661;   // published, on the menu: the product the extras hang off
const P_HIDDEN = 9662;   // UNPUBLISHED and NOT on the menu, with a linked extra
const A_MANGO  = 9663;   // add-on WITH a photo, UNPUBLISHED (a component, not sold alone)
const A_BARE   = 9664;   // add-on with NO photo
const IDS = [P_BOWL, P_HIDDEN, A_MANGO, A_BARE];
const CH = {};

// 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function cleanup() {
  const ph = IDS.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
     VALUES (?,?,?,?,1,97)`
  ).run(LOC, '__test_chphoto', 'Choice photo fixture', '测试选项图');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, image_data, top_category)
     VALUES (?,?,?,?,?,1,?,?,?)`
  );
  prod.run(P_BOWL,   'Fixture bowl',   '测试碗',   '__CP-1', 30, 1, null, 'Food');
  prod.run(P_HIDDEN, 'Fixture hidden', '测试隐藏', '__CP-2', 30, 0, null, 'Food');
  prod.run(A_MANGO,  'Fixture mango',  '测试芒果', '__CP-3', 8,  0, PNG,  'Food');
  prod.run(A_BARE,   'Fixture bare',   '测试无图', '__CP-4', 8,  1, null, 'Food');

  const shopId = db.prepare(
    'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
  ).run(LOC, CODE).lastInsertRowid;
  db.prepare(
    `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
     VALUES (?,?,?,?,1,0)`
  ).run(shopId, P_BOWL, 30, 'made_here');

  const mkOpt = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (?,?,?,'multi',0,0)`
  );
  const mkCh = db.prepare(
    `INSERT INTO retail_product_option_choices
       (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,?,?,?,0,?,?)`
  );
  const o = mkOpt.run(P_BOWL, 'Add extras?', '加点配料?').lastInsertRowid;
  CH.mango = mkCh.run(o, 'Mango Bites', '芒果蛋白球', 8, A_MANGO, 0).lastInsertRowid;
  CH.bare  = mkCh.run(o, 'Bare Bites',  '无图',       8, A_BARE,  1).lastInsertRowid;
  CH.free  = mkCh.run(o, 'Sauce',       '酱',         0, null,    2).lastInsertRowid;
  const h = mkOpt.run(P_HIDDEN, 'Add extras?', '加点配料?').lastInsertRowid;
  CH.hidden = mkCh.run(h, 'Mango Bites', '芒果蛋白球', 8, A_MANGO, 0).lastInsertRowid;
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(retail);
app.use(shopMenu);
let PORT = 0, pass = 0, fail = 0;
const get = (u) => fetch(`http://127.0.0.1:${PORT}${u}`)
  .then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) }));

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

function optsOnCard(html, pid) {
  const m = html.match(new RegExp(`<template data-op="${pid}">([\\s\\S]*?)</template>`));
  if (!m) return null;
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  console.log('\n── The online store (mini app + web shop)');
  const detail = JSON.parse((await get(`/api/retail/products/${P_BOWL}`)).body.toString());
  const prod = detail.data || detail;
  const byId = new Map(((prod.options || [])[0] || { choices: [] }).choices.map(c => [c.id, c]));

  await check('a linked choice whose product has a photo carries an image_url by CHOICE id', async () => {
    const c = byId.get(CH.mango);
    assert.ok(c, 'the mango choice came back');
    assert.ok(/^\/api\/retail\/option-choices\/\d+\/image\?v=/.test(c.image_url || ''), `image_url: ${c.image_url}`);
    assert.ok(c.image_url.startsWith(`/api/retail/option-choices/${CH.mango}/`));
  });

  await check('a linked choice whose product has NO photo carries no image_url', async () => {
    assert.strictEqual(byId.get(CH.bare).image_url, undefined);
  });

  await check('a free choice with no link carries no image_url', async () => {
    assert.strictEqual(byId.get(CH.free).image_url, undefined);
  });

  await check('the photo is served although the linked add-on is UNPUBLISHED', async () => {
    const r = await get(byId.get(CH.mango).image_url);
    assert.strictEqual(r.status, 200);
    assert.ok(/^image\//.test(r.type), `content-type ${r.type}`);
    assert.ok(r.body.length > 0);
    // The product image route refuses the same add-on — the reason the choice route exists.
    assert.strictEqual((await get(`/api/retail/products/${A_MANGO}/image`)).status, 404);
  });

  await check('the choice photo is refused when the PARENT product is not public', async () => {
    assert.strictEqual((await get(`/api/retail/option-choices/${CH.hidden}/image`)).status, 404);
  });

  await check('a choice with no link, or no photo, has no photo to serve', async () => {
    assert.strictEqual((await get(`/api/retail/option-choices/${CH.free}/image`)).status, 404);
    assert.strictEqual((await get(`/api/retail/option-choices/${CH.bare}/image`)).status, 404);
  });

  console.log('\n── The QR menu');
  const menu = (await get(`/s/${CODE}`)).body.toString();
  const qs = optsOnCard(menu, P_BOWL) || [];
  const mc = new Map(((qs[0] || {}).choices || []).map(c => [c.id, c]));

  await check('the photographed choice carries img on the menu\'s own choice route', async () => {
    const c = mc.get(CH.mango);
    assert.ok(c, 'the mango choice is on the menu');
    assert.ok((c.img || '').startsWith(`/s/${CODE}/c/${CH.mango}?v=`), `img: ${c.img}`);
    assert.strictEqual(c.stock_product_id, undefined, 'the linked product id stays off the public page');
  });

  await check('choices without a photo carry no img', async () => {
    assert.strictEqual(mc.get(CH.bare).img, undefined);
    assert.strictEqual(mc.get(CH.free).img, undefined);
  });

  await check('the menu serves the choice photo, and refuses one not on this menu', async () => {
    const r = await get(`/s/${CODE}/c/${CH.mango}?w=160`);
    assert.strictEqual(r.status, 200);
    assert.ok(/^image\//.test(r.type), `content-type ${r.type}`);
    assert.strictEqual((await get(`/s/${CODE}/c/${CH.hidden}`)).status, 404);
    assert.strictEqual((await get(`/s/${CODE}/c/${CH.free}`)).status, 404);
  });

  await check('the menu picker draws the picture', async () => {
    assert.ok(menu.includes('class="oc-i"'), 'no .oc-i in the picker script');
    assert.ok(/\.oc-i\{/.test(menu), 'no .oc-i style');
  });

  console.log('\n── The other pickers draw it');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  await check('web shop: the option sheet draws image_url', async () => {
    const s = read('public/shop.html');
    assert.ok(/class="op-ci" src="\$\{esc\(c\.image_url\)\}/.test(s));
    assert.ok(/\.op-ci\{/.test(s));
  });

  await check('mini app product page: both sheets draw the picture', async () => {
    const wxml = read('miniapp/pages/product/product.wxml');
    assert.strictEqual((wxml.match(/<image wx:if="\{\{ch\.img\}\}" class="op-choice-img"/g) || []).length, 2);
    assert.ok(/img: c\.image_url \? absUrl\(c\.image_url\)/.test(read('miniapp/pages/product/product.js')));
    assert.ok(/\.op-choice-img \{/.test(read('miniapp/pages/product/product.wxss')));
  });

  await check('mini app "Forgot something?" page draws the picture', async () => {
    assert.ok(/<image wx:if="\{\{ c\.img \}\}" class="op-c-img"/.test(read('miniapp/pages/add-to-order/add-to-order.wxml')));
    assert.ok(/img: c\.image_url \? absUrl\(c\.image_url\)/.test(read('miniapp/pages/add-to-order/add-to-order.js')));
    assert.ok(/\.op-c-img \{/.test(read('miniapp/pages/add-to-order/add-to-order.wxss')));
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
