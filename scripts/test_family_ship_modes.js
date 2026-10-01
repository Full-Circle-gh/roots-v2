#!/usr/bin/env node
/**
 * Shipping is one setting for the whole product, not per size — §374.
 *
 *   node scripts/test_family_ship_modes.js
 *
 * THE TRAP. Each size of a product is its own store_products row with its own
 * ship_modes, and the Shipping chips PATCHed only the size that was open. On
 * TC000899 the page read Land while the size the customer bought still said
 * "Air only", so checkout snapshotted 'air' and planShipments flew it. A write
 * of ship_modes to one size now goes to every active size in the family
 * (lib/family-ship-modes.js), from the PATCH and from a version restore.
 *
 * Everything runs against a REAL sqlite database and the REAL routes/retail.js
 * router, mounted and called over HTTP.
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

// ── Fixtures ───────────────────────────────────────────────────────────────
// 7374x — clear of every other suite's fixture ids.
const A = 73741, B = 73742, C = 73743;          // family G: three sizes
const X = 73744;                                 // an ARCHIVED member of family G
const D1 = 73745, D2 = 73746;                    // family D: an unrelated product
const L = 73747;                                 // a lone product
const ALL = [A, B, C, X, D1, D2, L];
const { testOperator } = require('./lib/test-operator');
const op = testOperator(99866, '__op_family_ship_modes');
const OPERATOR = op.id;

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
                                 variant_group_id, variant_label, variant_sort, ship_modes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // The TC000899 shape: the sizes disagree, one of them "Air only".
  ins.run(A,  'Fixture dates', '测试椰枣', '__FS-A', 30, 1, 1, A,  '250g', 0, 'land');
  ins.run(B,  'Fixture dates', '测试椰枣', '__FS-B', 50, 1, 1, A,  '500g', 1, 'air');
  ins.run(C,  'Fixture dates', '测试椰枣', '__FS-C', 90, 1, 1, A,  '1kg',  2, 'air,land');
  ins.run(X,  'Fixture dates', '测试椰枣', '__FS-X', 99, 0, 0, A,  '5kg',  3, 'air');
  ins.run(D1, 'Fixture chips', '测试薯片', '__FS-D1', 20, 1, 1, D1, 'S', 0, 'air');
  ins.run(D2, 'Fixture chips', '测试薯片', '__FS-D2', 35, 1, 1, D1, 'L', 1, 'air');
  ins.run(L,  'Fixture tea',   '测试茶',   '__FS-L', 25, 1, 1, null, null, 0, 'air,land');
}
const modes = id => db.prepare('SELECT ship_modes AS v FROM store_products WHERE id = ?').get(id).v;
const modesOf = ids => ids.map(modes);
const versions = id => db.prepare('SELECT COUNT(*) AS n FROM retail_product_versions WHERE product_id = ?').get(id).n;

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

  try {
    console.log('\n── Setting Shipping on one size sets it on every size');
    await it('Land on the 250g makes the 500g ("Air only") and the 1kg Land too', async () => {
      const r = await patch(A, { ship_modes: 'land' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(modesOf([A, B, C]), ['land', 'land', 'land'],
        'a size kept its own setting — the trap §374 closes');
    });
    await it('the answer names the other sizes it wrote, so the editor can refresh them', async () => {
      const r = await patch(B, { ship_modes: 'air' });
      assert.deepStrictEqual(r.body.ship_modes_family.slice().sort(), [A, C]);
      assert.strictEqual(r.body.data.ship_modes, 'air');
      assert.deepStrictEqual(modesOf([A, B, C]), ['air', 'air', 'air']);
    });
    await it('saving the same value again writes no other size', async () => {
      const r = await patch(C, { ship_modes: 'air' });
      assert.deepStrictEqual(r.body.ship_modes_family, []);
    });
    await it('Local only goes to every size too', async () => {
      await patch(A, { ship_modes: 'local' });
      assert.deepStrictEqual(modesOf([A, B, C]), ['local', 'local', 'local']);
      await patch(A, { ship_modes: 'air,land' });
      assert.deepStrictEqual(modesOf([A, B, C]), ['air,land', 'air,land', 'air,land']);
    });
    await it('an archived size is never touched', async () => {
      assert.strictEqual(modes(X), 'air');
    });
    await it('another product is never touched', async () => {
      assert.deepStrictEqual(modesOf([D1, D2]), ['air', 'air']);
    });
    await it('a lone product just takes its own value', async () => {
      const r = await patch(L, { ship_modes: 'land' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(modes(L), 'land');
      assert.deepStrictEqual(r.body.ship_modes_family, []);
    });
    await it('a save that does not carry Shipping leaves the sizes alone', async () => {
      db.prepare('UPDATE store_products SET ship_modes = ? WHERE id = ?').run('air', B);
      const r = await patch(A, { notes: 'price check' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(modes(B), 'air', 'a save without ship_modes copied Shipping');
      assert.deepStrictEqual(r.body.ship_modes_family, []);
    });
    await it('each size written gets a version checkpoint, as a PATCH would', async () => {
      await patch(A, { ship_modes: 'land' });
      assert.ok(versions(B) >= 1, 'no version history for a size the copy wrote');
      assert.ok(versions(C) >= 1, 'no version history for a size the copy wrote');
    });

    console.log('\n── Restoring a version restores the whole product\'s Shipping');
    await it('restoring the 250g to an Air version puts every size back on Air', async () => {
      await patch(A, { ship_modes: 'air' });
      // Autosaves inside VERSION_COLLAPSE_SECONDS merge into one checkpoint;
      // age the Air one so the Land save below keeps it as its own version.
      db.prepare(`UPDATE retail_product_versions SET created_at = datetime('now', '-1 hour') WHERE product_id = ?`).run(A);
      await patch(A, { ship_modes: 'land' });
      assert.deepStrictEqual(modesOf([A, B, C]), ['land', 'land', 'land']);
      const airVer = db.prepare(
        `SELECT id FROM retail_product_versions WHERE product_id = ? AND snapshot_json LIKE '%"ship_modes":"air"%' ORDER BY id DESC LIMIT 1`
      ).get(A);
      assert.ok(airVer && airVer.id, 'no Air version to restore');
      const r = await call('POST', `/api/retail-admin/products/${A}/restore-version`, { version_id: airVer.id });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(modesOf([A, B, C]), ['air', 'air', 'air'], 'a restore split the family');
      assert.deepStrictEqual(r.body.ship_modes_family.slice().sort(), [B, C]);
    });

    console.log('\n── The desktop editor mirrors the copy into its list');
    await it('the save handler writes ship_modes_family back into PA_PRODUCTS', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
      assert.ok(/j\.ship_modes_family/.test(src) && /p\.ship_modes = j\.data\.ship_modes/.test(src),
        'the editor keeps the old Shipping for the other sizes, and its next autosave would copy it back');
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
