#!/usr/bin/env node
/**
 * The family switch brings back only the sizes that were on — §294.
 *
 *   node scripts/test_family_publish.js
 *
 * THE TRAP. One size of a variant family can be kept off the online store on
 * purpose (the per-size tick box, which PATCHes that size's own is_published).
 * The four family switches — Products list, bulk Turn on/off, the page
 * designer's Online store button, the phone admin — used to PATCH one value to
 * every size, so the next off-then-on quietly put that size back in the mini
 * app. They now all call POST /api/retail-admin/products/family-publish, whose
 * rule is lib/family-publish.js.
 *
 * Everything runs against a REAL sqlite database and the REAL routes/retail.js
 * router, mounted and called over HTTP. The size being tucked away is done with
 * the real PATCH the tick box sends, and the last word goes to the mini app's
 * own product route: the size picker is what a customer sees.
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
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// 7294x/7295x — clear of every other suite's fixture ids.
const A = 72941, B = 72942, C = 72943;          // family G: 250g, 500g, 1kg
const H1 = 72944, H2 = 72945;                    // family H: tucked away BEFORE §294 (no marks)
const K1 = 72946, K2 = 72947;                    // family K: fully off, never marked
const M1 = 72948, M2 = 72949;                    // family M: fully off, every size marked
const L = 72950;                                 // a lone product
const X = 72951;                                 // an ARCHIVED member of family G
const ALL = [A, B, C, H1, H2, K1, K2, M1, M2, L, X];
const OPERATOR = 1;

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
async function it(m, fn) { try { await fn(); ok(m); } catch (e) { bad(m, e.message); } }

function cleanup() {
  const ph = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM retail_product_versions WHERE product_id IN (${ph})`).run(...ALL);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...ALL);
}
function seed() {
  cleanup();
  const ins = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active,
                                 variant_group_id, variant_label, variant_sort, kept_off_online)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(A,  'Fixture honey', '测试蜂蜜', '__FP-A', 30, 1, 1, A,  '250g', 0, 0);
  ins.run(B,  'Fixture honey', '测试蜂蜜', '__FP-B', 50, 1, 1, A,  '500g', 1, 0);
  ins.run(C,  'Fixture honey', '测试蜂蜜', '__FP-C', 90, 1, 1, A,  '1kg',  2, 0);
  ins.run(X,  'Fixture honey', '测试蜂蜜', '__FP-X', 99, 0, 0, A,  '5kg',  3, 0);
  ins.run(H1, 'Fixture jam',   '测试果酱', '__FP-H1', 20, 1, 1, H1, 'S', 0, 0);
  ins.run(H2, 'Fixture jam',   '测试果酱', '__FP-H2', 35, 0, 1, H1, 'L', 1, 0);
  ins.run(K1, 'Fixture oil',   '测试油',   '__FP-K1', 40, 0, 1, K1, 'S', 0, 0);
  ins.run(K2, 'Fixture oil',   '测试油',   '__FP-K2', 70, 0, 1, K1, 'L', 1, 0);
  ins.run(M1, 'Fixture salt',  '测试盐',   '__FP-M1', 10, 0, 1, M1, 'S', 0, 1);
  ins.run(M2, 'Fixture salt',  '测试盐',   '__FP-M2', 15, 0, 1, M1, 'L', 1, 1);
  ins.run(L,  'Fixture tea',   '测试茶',   '__FP-L', 25, 1, 1, null, null, 0, 0);
}
const pub  = id => db.prepare('SELECT is_published AS v FROM store_products WHERE id = ?').get(id).v;
const mark = id => db.prepare('SELECT kept_off_online AS v FROM store_products WHERE id = ?').get(id).v;
const pubs = ids => ids.map(pub);

(async () => {
  seed();
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const family = (ids, on) => call('POST', '/api/retail-admin/products/family-publish', { ids, on });
  // The size picker on the mini app's product page — what a customer sees.
  const pickerSizes = async id => {
    const r = await call('GET', `/api/retail/products/${id}`);
    assert.strictEqual(r.status, 200, 'the product page did not load: ' + JSON.stringify(r.body));
    return ((r.body.data || r.body).variants || []).map(v => v.variant_label).sort();
  };

  try {
    console.log('\n── The size kept off on purpose survives off-then-on');
    await it('the per-size tick box (its real PATCH) takes the 500g off the mini app', async () => {
      const r = await call('PATCH', `/api/retail-admin/products/${B}`, { is_published: 0 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(await pickerSizes(A), ['1kg', '250g']);
    });
    await it('switching the family OFF takes every size off and remembers the 500g was off', async () => {
      const r = await family([A, B, C], false);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(pubs([A, B, C]), [0, 0, 0]);
      assert.deepStrictEqual([mark(A), mark(B), mark(C)], [0, 1, 0]);
    });
    await it('switching it back ON brings back the 250g and 1kg, and NOT the 500g', async () => {
      const r = await family([A, B, C], true);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(pubs([A, B, C]), [1, 0, 1], 'the 500g came back — the trap §294 closes');
      assert.deepStrictEqual(await pickerSizes(A), ['1kg', '250g'], 'the mini app shows the 500g again');
    });
    await it('the answer names every member of the family, and which were written', async () => {
      const r = await family([A], false);
      const ids = r.body.data.rows.map(x => x.id).sort();
      assert.deepStrictEqual(ids, [A, B, C], 'the switch did not widen to the whole family, or listed the archived size');
      assert.deepStrictEqual(r.body.data.changed.sort(), [A, C], 'the 500g was already off and must not be rewritten');
      await family([A], true);
      assert.deepStrictEqual(pubs([A, B, C]), [1, 0, 1], 'one id must act for its whole family');
    });
    await it('an archived size is never touched', async () => {
      assert.strictEqual(pub(X), 0);
      assert.strictEqual(mark(X), 0);
    });

    console.log('\n── Turning ON never overrides a size that is off while a sibling is on');
    await it('bulk Turn on over a partly-live family changes nothing', async () => {
      const r = await family([A, B, C], true);
      assert.deepStrictEqual(r.body.data.changed, []);
      assert.deepStrictEqual(pubs([A, B, C]), [1, 0, 1]);
    });
    await it('...even for a family tucked away before §294, with no marks at all', async () => {
      await family([H1, H2], true);
      assert.deepStrictEqual(pubs([H1, H2]), [1, 0], 'bulk Turn on brought back a size hidden before this shipped');
    });

    console.log('\n── The plain cases stay plain');
    await it('a fully-off family that was never marked comes fully on, as it always did', async () => {
      await family([K1], true);
      assert.deepStrictEqual(pubs([K1, K2]), [1, 1]);
    });
    await it('a family with EVERY size marked comes fully on, and the marks clear', async () => {
      await family([M1, M2], true);
      assert.deepStrictEqual(pubs([M1, M2]), [1, 1], 'turning a product on showed nothing');
      assert.deepStrictEqual([mark(M1), mark(M2)], [0, 0]);
    });
    await it('ticking the 500g back on, then off-and-on, brings back all three', async () => {
      await call('PATCH', `/api/retail-admin/products/${B}`, { is_published: 1 });
      await family([A], false);
      assert.deepStrictEqual([mark(A), mark(B), mark(C)], [0, 0, 0], 'a fully-on family must clear its marks when switched off');
      await family([A], true);
      assert.deepStrictEqual(pubs([A, B, C]), [1, 1, 1]);
    });
    await it('switching off an already-off family keeps its marks', async () => {
      await call('PATCH', `/api/retail-admin/products/${B}`, { is_published: 0 });
      await family([A], false);
      await family([A], false);
      assert.strictEqual(mark(B), 1, 'a second OFF wiped the memory of the first');
      await family([A], true);
      assert.deepStrictEqual(pubs([A, B, C]), [1, 0, 1]);
    });
    await it('a lone product: off is off, on is on', async () => {
      await family([L], false);
      assert.strictEqual(pub(L), 0);
      await family([L], true);
      assert.strictEqual(pub(L), 1);
    });
    await it('each size written gets a version checkpoint, as a PATCH would', async () => {
      await family([K1], false);
      const n = db.prepare('SELECT COUNT(*) AS n FROM retail_product_versions WHERE product_id = ?').get(K2).n;
      assert.ok(n >= 1, 'no version history for a size the switch wrote');
    });

    console.log('\n── The door');
    await it('no ids, or no on/off, is a 400; ids that match nothing are a 404', async () => {
      assert.strictEqual((await call('POST', '/api/retail-admin/products/family-publish', { on: true })).status, 400);
      assert.strictEqual((await call('POST', '/api/retail-admin/products/family-publish', { ids: [A] })).status, 400);
      assert.strictEqual((await family([99999999], true)).status, 404);
    });
    await it('it needs products:edit, like the PATCH it replaces', async () => {
      assert.strictEqual(requiredCapFor('POST', '/api/retail-admin/products/family-publish'), 'products:edit');
      assert.strictEqual(requiredCapFor('PATCH', `/api/retail-admin/products/${A}`), 'products:edit');
    });

    console.log('\n── No family switch writes one value to every size any more');
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const body = (src, name) => {
      const i = src.indexOf(name);
      assert.ok(i >= 0, name + ' not found');
      return src.slice(i, i + 2600);
    };
    await it('the Products list switch goes through the rule', async () => {
      const f = body(read('public/retail-admin/09-products.js'), 'async function paToggleShop(');
      assert.ok(/products\/family-publish/.test(f.slice(0, 1400)), 'paToggleShop does not call family-publish');
      assert.ok(!/method: 'PATCH', body: \{ is_published/.test(f.slice(0, 1400)), 'paToggleShop PATCHes every size again');
    });
    await it('bulk Turn on / Turn off goes through the rule', async () => {
      const f = body(read('public/retail-admin/09-products.js'), 'async function paBulkApply(');
      assert.ok(/kind === 'shop-on' \|\| kind === 'shop-off'/.test(f) && /products\/family-publish/.test(f),
        'bulk shop on/off PATCHes every size again');
    });
    await it('the page designer button goes through the rule', async () => {
      const f = body(read('public/product-editor.html'), 'async function peTogglePublish(');
      assert.ok(/products\/family-publish/.test(f), 'peTogglePublish does not call family-publish');
    });
    await it('the phone admin switch goes through the rule', async () => {
      const f = body(read('public/m.html'), "reg('toggleShop'");
      assert.ok(/\/products\/family-publish/.test(f.slice(0, 1600)), 'the phone switch does not call family-publish');
      assert.ok(!/is_published:next/.test(f.slice(0, 1600)), 'the phone switch PATCHes every size again');
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
