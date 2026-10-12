#!/usr/bin/env node
/**
 * A size that shows a sibling's photo gets a new photo link when that photo
 * changes.
 *
 *   node scripts/test_borrowed_photo_version.js
 *
 * THE TRAP. A size with no photo of its own shows a sibling's
 * (resolveProductImage), but its photo link carries its OWN updated_at as the
 * version (?v=), and the image route answers a version from a year-long
 * immutable cache. Change the sibling's photo and the borrowing size kept the
 * same link, so the shop card kept the old picture after the operator had
 * deleted it. A photo save, a version restore and a delete now re-stamp the
 * photo-less sizes in the family (touchPhotoBorrowers, lib/product-image-sql.js).
 *
 * Everything runs against a REAL sqlite database and the REAL routes/retail.js
 * router, mounted and called over HTTP.
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
// 7391x — clear of every other suite's fixture ids.
const OWNER = 73911;     // family G owner: has NO photo, borrows (the card's size)
const LOAF  = 73912;     // family G: holds the photo
const OWN   = 73913;     // family G: has its own photo — never borrows
const GONE  = 73914;     // family G: archived, no photo
const D1 = 73915, D2 = 73916;    // family D: borrower + holder, unrelated
const ALL = [OWNER, LOAF, OWN, GONE, D1, D2];
const { testOperator } = require('./lib/test-operator');
const op = testOperator(99878, '__op_borrowed_photo');
const OPERATOR = op.id;

const svg = (fill) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${fill}"/></svg>`
).toString('base64');
const OLD = svg('#111111'), NEW = svg('#eeeeee'), NEWER = svg('#777777'), MINE = svg('#ff0000');
const OLD_STAMP = '2026-01-01 00:00:00';

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
async function it(m, fn) { try { await fn(); ok(m); } catch (e) { bad(m, e.message); } }

function cleanup() {
  op.remove();
  const ph = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM retail_product_versions WHERE product_id IN (${ph})`).run(...ALL);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...ALL);
}
function seed() {
  cleanup();
  const ins = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active,
                                 variant_group_id, variant_label, variant_sort, image_data, images)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(OWNER, 'Fixture rye', '测试黑麦', '__BP-OWNER', 12, 1, 1, OWNER, '3 Slices', 1, null, null);
  ins.run(LOAF,  'Fixture rye', '测试黑麦', '__BP-LOAF',  44, 1, 1, OWNER, 'Loaf',     0, OLD, JSON.stringify([OLD]));
  ins.run(OWN,   'Fixture rye', '测试黑麦', '__BP-OWN',   80, 1, 1, OWNER, 'Double',   2, MINE, JSON.stringify([MINE]));
  ins.run(GONE,  'Fixture rye', '测试黑麦', '__BP-GONE',  90, 0, 0, OWNER, 'Old',      3, null, null);
  ins.run(D1,    'Fixture pita', '测试皮塔', '__BP-D1',    5, 1, 1, D1, 'One',  1, null, null);
  ins.run(D2,    'Fixture pita', '测试皮塔', '__BP-D2',   20, 1, 1, D1, 'Five', 0, OLD, JSON.stringify([OLD]));
  age();
}
// Back-date every fixture so a re-stamp in the same second as the seed still
// shows up as a change.
const age = () => db.prepare(
  `UPDATE store_products SET updated_at = ? WHERE id IN (${ALL.map(() => '?').join(',')})`
).run(OLD_STAMP, ...ALL);
// updated_at has one-second resolution, and the image route caches by it. Two
// photo writes inside the same second would hand out the same link twice —
// never the case for an operator, always the case for this script — so each
// later write first steps past the second the previous one was stamped in.
const nextSecond = () => new Promise(r => setTimeout(r, 1100));
const stamp = id => db.prepare('SELECT updated_at AS v FROM store_products WHERE id = ?').get(id).v;

(async () => {
  seed();
  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const patch = (id, body) => call('PATCH', `/api/retail-admin/products/${id}`, body);
  // The link the shop grid hands the phone for a size (slim=1, as shop.js asks).
  const link = async (id) => {
    const r = await call('GET', `/api/retail/products?slim=1&ids=${id}`);
    const rows = Array.isArray(r.body) ? r.body : (r.body && (r.body.data || r.body.products)) || [];
    const row = rows.find(x => x.id === id);
    assert.ok(row, `size ${id} missing from the shop list: ${JSON.stringify(r.body).slice(0, 200)}`);
    return row.image_data;
  };
  // What a phone fetching that link is sent.
  const picture = (url) => fetch(base + new URL(url).pathname + new URL(url).search)
    .then(r => r.arrayBuffer()).then(b => Buffer.from(b).toString('base64'));
  const bytesOf = (dataUri) => dataUri.split(',')[1];

  try {
    console.log('\n── A new photo on the sibling moves the borrowing size\'s link');
    await it('before: the card\'s size shows the sibling\'s photo', async () => {
      assert.strictEqual(await picture(await link(OWNER)), bytesOf(OLD));
    });
    await it('a photo saved on the Loaf gives the card\'s size a new link, which serves the new photo', async () => {
      const before = await link(OWNER);
      await picture(before);                       // warm the image cache on the old link
      const r = await patch(LOAF, { images: [NEW] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const after = await link(OWNER);
      assert.notStrictEqual(after, before, 'the borrowing size kept its old link — phones keep the old picture');
      assert.strictEqual(await picture(after), bytesOf(NEW));
    });
    await it('a size with its own photo is not re-stamped', async () => {
      assert.strictEqual(stamp(OWN), OLD_STAMP);
    });
    await it('an archived size is not re-stamped', async () => {
      assert.strictEqual(stamp(GONE), OLD_STAMP);
    });
    await it('another product\'s sizes are not re-stamped', async () => {
      assert.deepStrictEqual([stamp(D1), stamp(D2)], [OLD_STAMP, OLD_STAMP]);
    });
    await it('a save that does not carry photos leaves the borrowing size alone', async () => {
      age();
      const r = await patch(LOAF, { notes: 'price check' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(stamp(OWNER), OLD_STAMP);
    });

    console.log('\n── Restoring an older photo moves the link too');
    await it('restoring the Loaf to its old photo gives the card\'s size a new link', async () => {
      const oldVer = db.prepare(
        `SELECT id FROM retail_product_versions WHERE product_id = ? AND snapshot_json LIKE ? ORDER BY id ASC LIMIT 1`
      ).get(LOAF, '%' + bytesOf(OLD).slice(0, 40) + '%');
      assert.ok(oldVer && oldVer.id, 'no version holding the old photo to restore');
      age();
      await nextSecond();
      const before = await link(OWNER);
      const r = await call('POST', `/api/retail-admin/products/${LOAF}/restore-version`, { version_id: oldVer.id });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const after = await link(OWNER);
      assert.notStrictEqual(after, before);
      assert.strictEqual(await picture(after), bytesOf(OLD));
    });

    console.log('\n── Deleting the photo\'s size moves the link to the next photo');
    await it('deleting the Loaf: the card\'s size now shows the other sibling\'s photo, on a new link', async () => {
      age();
      await nextSecond();
      const before = await link(OWNER);
      const r = await call('DELETE', `/api/retail-admin/products/${LOAF}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const after = await link(OWNER);
      assert.notStrictEqual(after, before);
      assert.strictEqual(await picture(after), bytesOf(MINE));
    });

    console.log('\n── The other family');
    await it('a photo on Five moves One\'s link, and only One\'s', async () => {
      age();
      const before = await link(D1);
      await patch(D2, { images: [NEWER] });
      const after = await link(D1);
      assert.notStrictEqual(after, before);
      assert.strictEqual(await picture(after), bytesOf(NEWER));
      assert.strictEqual(stamp(OWNER), OLD_STAMP);
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
