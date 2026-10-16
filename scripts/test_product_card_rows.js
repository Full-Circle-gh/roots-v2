#!/usr/bin/env node
/**
 * test_product_card_rows.js — what a product row looks like by the time the
 * shop and the mini app get it: the columns each list pulls, the photo link,
 * the nutrition and page blocks, and a variant's borrowed photo.
 *
 *   node scripts/test_product_card_rows.js
 *
 * WHAT IT GUARDS. A mutation sweep of routes/retail.js (2026-10-15) broke
 * lazifyProductImage, hydrateNutrition and resolveProductImage 14 ways; one was
 * caught. Unnoticed: a photo link that stops loading, loses its version (so a
 * new photo is served stale) or its thumbnail size; a variant losing the photo
 * it borrows; a broken nutrition table or page design shipped to the app; the
 * "Local only" badge wrong.
 *
 * And nothing at all pinned the column lists. The lean lists are the full list
 * with heavy columns cut out by string replace — the multi-MB photo collapsed,
 * nutrition, page design, descriptions dropped — and a replace that stops
 * matching fails silently: the shop grid goes back to shipping megabytes and
 * nothing turns red. Section 1 runs every list over the real tables and checks
 * what each one carries.
 *
 * HOW. The real code is lifted from the source (retailSource(), so it is found
 * in routes/retail.js or in lib/ after decisions §477 moves it) and run over the
 * real table definitions, with the real stock SQL from lib/inventory.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}
// A top-level const, up to the blank line that ends it.
function constSrc(name) {
  const at = SRC.search(new RegExp(`^const ${name} = `, 'm'));
  assert.ok(at >= 0, `const ${name} not found`);
  const end = SRC.indexOf('\n\n', at);
  return SRC.slice(at, end < 0 ? undefined : end);
}

// ── the real tables ───────────────────────────────────────────────────────
const db = openMemoryDb();
addTables(db, DB_SRC, DB_SRC, ['retail_stores', 'retail_store_stock', 'channel_status', 'store_business_status',
  'retail_product_options']);
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
const inventory = require(path.join(ROOT, 'lib', 'inventory'));

const COLS = ['RETAIL_PRODUCT_COLS', 'RETAIL_PRODUCT_COLS_LIST', 'RETAIL_PRODUCT_COLS_CARD', 'RETAIL_PRODUCT_COLS_HOME'];
const FNS = ['lazifyProductImage', 'parseStockByStore', 'hydrateNutrition', 'resolveProductImage'];
const X = new Function('inventory', 'tdb',
  `${COLS.map(constSrc).join('\n')}\n${FNS.map(fnSrc).join('\n')}\nreturn { ${[...COLS, ...FNS].join(', ')} };`)(
  inventory, () => db);

const BLOB = 'data:image/png;base64,' + 'A'.repeat(5000);
const p = db.prepare(`INSERT INTO store_products (id, sku, name_en, sell_price, image_data, image_url, nutrition,
  description_en, description_blocks, keywords_en, tagline_en, colophon_character, variant_group_id, variant_sort,
  is_active, updated_at) VALUES (@id, @sku, 'x', 10, @image_data, @image_url, @nutrition, @description_en,
  @description_blocks, 'kw', 'tag', 'c', @variant_group_id, @variant_sort, @is_active, '2040-01-04 10:00:00')`);
const prod = (o) => p.run({ image_data: null, image_url: null, nutrition: null, description_en: 'long', description_blocks: null,
  variant_group_id: null, variant_sort: 0, is_active: 1, ...o });
prod({ id: 1, sku: 'A', image_data: BLOB, nutrition: '{"basis_en":"per 100g","rows":[]}', description_blocks: '[{"t":"p"}]' });
prod({ id: 2, sku: 'B', image_data: 'https://img.test/b.jpg' });
// a variant group: 10 owns it, 11 has no photo, 12 has one, 13 is switched off
prod({ id: 10, sku: 'G0', variant_group_id: 10, variant_sort: 5 });
prod({ id: 11, sku: 'G1', variant_group_id: 10, variant_sort: 1 });
prod({ id: 12, sku: 'G2', variant_group_id: 10, variant_sort: 2, image_url: 'https://img.test/g2.jpg' });
prod({ id: 13, sku: 'G3', variant_group_id: 10, variant_sort: 0, image_data: 'data:image/png;base64,OFF', is_active: 0 });
db.prepare("INSERT INTO retail_product_options (product_id, question_en) VALUES (1, 'Dressing?')").run();

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(() => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;
const pull = (cols, id) => db.prepare(`SELECT ${cols} FROM store_products p WHERE p.id = ?`).get(id);

// ══ 1. the column lists ════════════════════════════════════════════════════
section('1. each list pulls what its screen shows, and the lean ones stay lean');

it('product page (full): the whole photo, nutrition, page design, description', () => {
  const r = pull(X.RETAIL_PRODUCT_COLS, 1);
  assert.strictEqual(r.image_data, BLOB);
  for (const k of ['nutrition', 'description_blocks', 'colophon_character', 'description_en', 'keywords_en', 'tagline_en', 'stock', 'price'])
    assert.ok(k in r, `full row lost ${k}`);
});
it('lists: the multi-KB photo collapses to a "data:" marker inside the database; a plain URL passes', () => {
  for (const cols of [X.RETAIL_PRODUCT_COLS_LIST, X.RETAIL_PRODUCT_COLS_CARD, X.RETAIL_PRODUCT_COLS_HOME]) {
    assert.strictEqual(pull(cols, 1).image_data, 'data:', 'the blob is back in a list');
    assert.strictEqual(pull(cols, 2).image_data, 'https://img.test/b.jpg');
  }
});
it('lists: no nutrition, page design or colophon; a has_options flag instead', () => {
  for (const cols of [X.RETAIL_PRODUCT_COLS_LIST, X.RETAIL_PRODUCT_COLS_CARD, X.RETAIL_PRODUCT_COLS_HOME]) {
    const r = pull(cols, 1);
    for (const k of ['nutrition', 'description_blocks', 'use_block_design', 'page_template', 'colophon_character'])
      assert.ok(!(k in r), `a list ships ${k} again`);
    assert.strictEqual(r.has_options, 1);
    assert.strictEqual(pull(cols, 2).has_options, 0);
  }
});
it('card (the shop grid): no description, keywords or tagline', () => {
  const r = pull(X.RETAIL_PRODUCT_COLS_CARD, 1);
  for (const k of ['description_en', 'description_cn', 'keywords_en', 'tagline_en']) assert.ok(!(k in r), `card ships ${k}`);
});
it('home: no description or keywords, but the tagline stays for the captions', () => {
  const r = pull(X.RETAIL_PRODUCT_COLS_HOME, 1);
  for (const k of ['description_en', 'keywords_en']) assert.ok(!(k in r), `home ships ${k}`);
  assert.strictEqual(r.tagline_en, 'tag');
});
it('every list carries the per-shop shelves (§481), and the clean-up hands the app an object', () => {
  for (const cols of COLS.map(k => X[k])) {
    assert.ok('stock_by_store' in pull(cols, 1), 'a list lost stock_by_store');
  }
  // Never stocked per-shop → NULL from the database → null to the app, which
  // then reads the summed stock exactly as it did before §481.
  assert.strictEqual(X.hydrateNutrition(pull(X.RETAIL_PRODUCT_COLS_CARD, 1)).stock_by_store, null);
  assert.deepStrictEqual(X.parseStockByStore({ stock_by_store: '{"yuexiu":4}' }).stock_by_store, { yuexiu: 4 });
  assert.strictEqual(X.parseStockByStore({ stock_by_store: 'not json' }).stock_by_store, null);
  assert.strictEqual(X.parseStockByStore({ stock_by_store: '[1]' }).stock_by_store, null);
});
it('list (the fuller one): keeps the description for the blocks that show it', () => {
  assert.strictEqual(pull(X.RETAIL_PRODUCT_COLS_LIST, 1).description_en, 'long');
});

// ══ 2. the photo link ══════════════════════════════════════════════════════
section('2. a list row\'s photo becomes a link the app can lazy-load');

const B = 'https://shop.test';
it('a collapsed photo becomes its image route, versioned by updated time', () => {
  const r = X.lazifyProductImage({ id: 1, image_data: 'data:', updated_at: '2040-01-04 10:00:00' }, B);
  assert.strictEqual(r.image_data, 'https://shop.test/api/retail/products/1/image?v=2040-01-04%2010%3A00%3A00');
});
it('with a thumbnail width, the link asks for it', () => {
  const r = X.lazifyProductImage({ id: 1, image_data: 'DATA:', updated_at: 'u' }, B, 320);
  assert.strictEqual(r.image_data, 'https://shop.test/api/retail/products/1/image?v=u&w=320');
});
it('a plain photo URL is left alone', () => {
  const r = X.lazifyProductImage({ id: 2, image_data: 'https://img.test/b.jpg', updated_at: 'u', has_group_image: 1 }, B);
  assert.strictEqual(r.image_data, 'https://img.test/b.jpg');
});
it('a variant with no photo, whose group has one, gets its image route (which borrows)', () => {
  const r = X.lazifyProductImage({ id: 11, image_data: null, image_url: null, has_group_image: 1, updated_at: 'u' }, B);
  assert.strictEqual(r.image_data, 'https://shop.test/api/retail/products/11/image?v=u');
});
it('no photo anywhere, or an image_url of its own: no link invented', () => {
  assert.strictEqual(X.lazifyProductImage({ id: 3, image_data: null, image_url: null, has_group_image: 0 }, B).image_data, null);
  assert.strictEqual(X.lazifyProductImage({ id: 4, image_data: null, image_url: 'https://u', has_group_image: 1 }, B).image_data, null);
});
it('a missing updated time still gives a valid link', () => {
  assert.strictEqual(X.lazifyProductImage({ id: 1, image_data: 'data:' }, B).image_data, 'https://shop.test/api/retail/products/1/image?v=');
});
it('the helper-only fields never reach the app', () => {
  const r = X.lazifyProductImage({ id: 1, image_data: 'data:', updated_at: 'u', has_group_image: 0 }, B);
  assert.ok(!('updated_at' in r) && !('has_group_image' in r));
});

// ══ 3. nutrition, page design, local only ══════════════════════════════════
section('3. nutrition and page design arrive as objects or null; "Local only" is read off ship modes');

const h = (o) => X.hydrateNutrition({ ...o });
it('nutrition with a basis or rows is kept; empty, broken or not text → null', () => {
  assert.deepStrictEqual(h({ nutrition: '{"basis_cn":"每100克"}' }).nutrition, { basis_cn: '每100克' });
  assert.deepStrictEqual(h({ nutrition: '{"rows":[{"k":"kcal"}]}' }).nutrition, { rows: [{ k: 'kcal' }] });
  for (const v of ['{"rows":[]}', '{}', 'null', 'not json', '   ', null, 7]) assert.strictEqual(h({ nutrition: v }).nutrition, null, String(v));
});
it('page design: a non-empty list is kept; empty, broken, not a list or missing → null', () => {
  assert.deepStrictEqual(h({ description_blocks: '[{"t":"p"}]' }).description_blocks, [{ t: 'p' }]);
  for (const v of ['[]', '{"t":"p"}', 'not json', '', undefined]) assert.strictEqual(h({ description_blocks: v }).description_blocks, null, String(v));
});
it('"Local only" when ship modes include local, as its own word, any case; ship_modes itself never ships', () => {
  const lo = (v) => { const r = h({ ship_modes: v }); assert.ok(!('ship_modes' in r)); return r.local_only; };
  assert.strictEqual(lo('local'), true);
  assert.strictEqual(lo('air, LOCAL'), true);
  assert.strictEqual(lo('air,land'), false);
  assert.strictEqual(lo('locally'), false);
  assert.strictEqual(lo(null), false);
});
it('a row without ship_modes gets no local_only; no row stays no row', () => {
  assert.ok(!('local_only' in h({ nutrition: null })));
  assert.strictEqual(X.hydrateNutrition(null), null);
});

// ══ 4. a variant's borrowed photo ══════════════════════════════════════════
section('4. the photo the image route streams: its own, else a live sibling\'s');

it('its own photo wins: the inline one, else its URL', () => {
  assert.strictEqual(X.resolveProductImage(1), BLOB);
  assert.strictEqual(X.resolveProductImage(12), 'https://img.test/g2.jpg');
});
it('a variant with none borrows: the group owner first, else the lowest-sorted live sibling with one', () => {
  assert.strictEqual(X.resolveProductImage(11), 'https://img.test/g2.jpg', 'owner 10 has none, so the next live one');
  db.prepare("UPDATE store_products SET image_url = 'https://img.test/owner.jpg' WHERE id = 10").run();
  try { assert.strictEqual(X.resolveProductImage(11), 'https://img.test/owner.jpg'); }
  finally { db.prepare('UPDATE store_products SET image_url = NULL WHERE id = 10').run(); }
});
it('a switched-off sibling\'s photo is never borrowed, even sorted first', () => {
  assert.notStrictEqual(X.resolveProductImage(11), 'data:image/png;base64,OFF');
});
it('no photo anywhere in the group, no group, or no such product → null', () => {
  db.prepare('UPDATE store_products SET image_url = NULL WHERE id = 12').run();
  try { assert.strictEqual(X.resolveProductImage(11), null); }
  finally { db.prepare("UPDATE store_products SET image_url = 'https://img.test/g2.jpg' WHERE id = 12").run(); }
  prod({ id: 20, sku: 'N' });
  assert.strictEqual(X.resolveProductImage(20), null);
  assert.strictEqual(X.resolveProductImage(999), null);
});

for (const step of pending) step();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
