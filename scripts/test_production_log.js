#!/usr/bin/env node
/**
 * Production — recording what the kitchen made.
 *
 *   node scripts/test_production_log.js
 *
 * WHAT THIS IS ABOUT. The kitchen makes 20 jars, 2 break, 18 go on the shelf.
 * Until this route existed the system saw one number — 18 arriving — and had no
 * way to know 20 were ever made. The two broken jars were not "recorded as a
 * small loss", they were invisible, and nothing anywhere disagreed with the
 * idea that 18 were made. Every case below is about the difference between one
 * number and two.
 *
 * THE RULES IT LOCKS DOWN, each of which is a decision rather than a detail:
 *
 *   • A GAP MUST BE EXPLAINED. "20 made, 18 shelved" reads identically whether
 *     two broke or the batch simply came out small, and those are different
 *     facts about the kitchen. Refused rather than stored as a mystery.
 *   • 'made_fewer' IS NOT A LOSS. It sits in the same picker as the waste codes
 *     and must never be totalled with them — it means nothing was destroyed.
 *   • BOTH WRITES, OR NEITHER. The production row and the stock movement share
 *     one transaction, so a phone that dies mid-call cannot leave a batch
 *     recorded that never reached the shelf.
 *   • MORE ON THE SHELF THAN WAS MADE IS REFUSED, not clamped. Absorbing it
 *     would put units on a shelf that this very record then denies exist.
 *   • A RESTRICTED OPERATOR ACTS ON THEIR OWN STORE. Same rule the stock route
 *     already keeps.
 *
 * Runs against a REAL sqlite database (data/roots.db, created by database.js on
 * require and gitignored) and a REAL express app, so what is asserted is what
 * the route does rather than what it looks like it does.
 */
'use strict';

process.env.TZ = 'Asia/Shanghai';

const assert = require('assert');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const { stockAppOnlyAllows } = require(path.join(ROOT, 'lib', 'stock-app-only.js'));
const caps = require(path.join(ROOT, 'lib', 'capabilities.js'));
const capRoutes = require(path.join(ROOT, 'lib', 'cap-routes.js'));

const db = tdb();

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

// High ids so a developer's own rows are never touched.
const STORE = 9401;         // the kitchen's own store
const OTHER = 9403;         // somebody else's, for the scope refusal
const PROD  = 9402;

// ── The door, before the route ─────────────────────────────────────────────
// A screen and its door go in together. #262 shipped the kitchen queue without
// touching the stock-app allowlist, so every call it made died before any route
// ran and the queue was invisible to the only role it was built for.
section('A confined kitchen role can reach it at all');

check('POST /production is on the stock-app allowlist', () => {
  assert.ok(stockAppOnlyAllows('POST', '/api/retail-admin/production'));
});
check('and the reason list it has to read', () => {
  assert.ok(stockAppOnlyAllows('GET', '/api/retail-admin/production/reasons'));
});
check('the allowlist is still a floor, not a door — POST /api/restock stays shut', () => {
  assert.strictEqual(stockAppOnlyAllows('POST', '/api/restock'), false);
});
check('the kitchen role actually HOLDS production:log', () => {
  assert.ok(caps.PRESETS.kitchen.indexOf('production:log') >= 0,
    `kitchen preset is ${JSON.stringify(caps.PRESETS.kitchen)}`);
});
// Not any-of with quickstock:add: holding the shelf key is permission to say
// what is ON a shelf; this is permission to state what a batch yielded.
check('and the route is gated on that one key alone', () => {
  assert.strictEqual(capRoutes.requiredCapFor('POST', '/api/retail-admin/production'), 'production:log');
});

// ── The route ──────────────────────────────────────────────────────────────
function seed() {
  db.prepare('INSERT OR REPLACE INTO retail_stores (id,name_en,name_cn,code,is_active) VALUES (?,?,?,?,1)')
    .run(STORE, 'ProdTest', '生产测试', 'PT1');
  db.prepare('INSERT OR REPLACE INTO retail_stores (id,name_en,name_cn,code,is_active) VALUES (?,?,?,?,1)')
    .run(OTHER, 'ProdTest2', '生产测试二', 'PT2');
  db.prepare('INSERT OR REPLACE INTO store_products (id,name_en,name_cn,sku,is_active) VALUES (?,?,?,?,1)')
    .run(PROD, 'Peanut Butter', '花生酱', '4-670');
  db.prepare('DELETE FROM production_batches WHERE store_id IN (?,?)').run(STORE, OTHER);
  db.prepare('DELETE FROM retail_store_stock WHERE product_id = ?').run(PROD);
  inventory.adjustStock({ storeId: STORE, productId: PROD, newPhysicalQty: 0, reason: 'seed' });
}

function shelf(storeId = STORE) {
  const r = db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id=? AND product_id=?')
    .get(storeId, PROD);
  return r ? r.q : 0;
}
function rows() {
  return db.prepare(`SELECT qty_made, qty_shelved, gap_reason, recipe_name, product_id, request_id
                       FROM production_batches WHERE store_id = ? ORDER BY id`).all(STORE);
}

function buildApp() {
  // The login is not what this file is about. Stubbing the gate exercises THIS
  // route's own rules — the store scope, the gap, the arithmetic — rather than
  // re-testing requireRetailAdmin, which has its own coverage.
  const retail = require(path.join(ROOT, 'routes', 'retail.js'));
  retail.requireRetailAdmin = (req, res, next) => {
    req.user = { id: 1, username: 'proben', display_name: 'Pro Ben' };
    req.backendUser = { role: 'kitchen', retail_store_id: STORE };
    next();
  };
  delete require.cache[require.resolve(path.join(ROOT, 'routes', 'retail-production.js'))];
  const app = express();
  app.use(express.json());
  app.use(require(path.join(ROOT, 'routes', 'retail-production.js')));
  return app;
}

async function main() {
  seed();
  const app = buildApp();
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (body) => fetch(base + '/api/retail-admin/production', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  section('A gap has to be explained');

  let r = await post({ store_id: STORE, product_id: PROD, qty_made: 20, qty_shelved: 18 });
  check('20 made, 18 shelved, no reason → refused', () => {
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'gap_reason_required');
  });
  // The refusal has to leave the world untouched, or a retry double-counts.
  check('and NOTHING was written — not the row, not the shelf', () => {
    assert.strictEqual(shelf(), 0, 'stock moved on a refused call');
    assert.strictEqual(rows().length, 0, 'a production row was written on a refused call');
  });
  check('the refusal names the reasons it would accept', () => {
    assert.ok(Array.isArray(r.body.reasons) && r.body.reasons.indexOf('damaged') >= 0,
      `reasons were ${JSON.stringify(r.body.reasons)}`);
  });

  section('The two numbers, kept apart');

  r = await post({ store_id: STORE, product_id: PROD, qty_made: 20, qty_shelved: 18, gap_reason: 'damaged' });
  check('20 made, 18 shelved, damaged → accepted', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.qty_made, 20);
    assert.strictEqual(r.body.data.qty_shelved, 18);
    assert.strictEqual(r.body.data.gap, 2);
  });
  // THE WHOLE POINT: the shelf gets what reached it, and the record keeps what
  // was made. One number on the shelf, two in the record.
  check('the shelf got 18, not 20', () => assert.strictEqual(shelf(), 18));
  check('and the record kept the 20, and why 2 are missing', () => {
    const a = rows();
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].qty_made, 20);
    assert.strictEqual(a[0].qty_shelved, 18);
    assert.strictEqual(a[0].gap_reason, 'damaged');
  });
  // recipe_name is NOT NULL and is what the desktop log prints; for a
  // product-shaped row the honest snapshot is the product's own name.
  check('the row names what was made', () => {
    assert.strictEqual(rows()[0].recipe_name, 'Peanut Butter');
    assert.strictEqual(rows()[0].product_id, PROD);
  });

  section('made_fewer is not a loss');

  r = await post({ store_id: STORE, product_id: PROD, qty_made: 8, qty_shelved: 8, gap_reason: null });
  check('8 made, 8 shelved → no reason needed', () => assert.strictEqual(r.status, 200));
  check('the shelf is 26', () => assert.strictEqual(shelf(), 26));

  r = await post({ store_id: STORE, product_id: PROD, qty_made: 5, qty_shelved: 3, gap_reason: 'made_fewer' });
  check('made_fewer is accepted as a gap reason', () => assert.strictEqual(r.status, 200));
  check('and is stored distinctly, so it is never summed as waste', () => {
    const last = rows()[rows().length - 1];
    assert.strictEqual(last.gap_reason, 'made_fewer');
  });

  section('The normal morning takes one number');

  const before = shelf();
  r = await post({ store_id: STORE, product_id: PROD, qty_made: 12 });
  check('qty_shelved absent means all of it reached the shelf', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.qty_shelved, 12);
    assert.strictEqual(r.body.data.gap, 0);
  });
  check('shelf rose by the full 12', () => assert.strictEqual(shelf(), before + 12));

  section('What it refuses');

  const held = shelf();
  const heldRows = rows().length;

  r = await post({ store_id: STORE, product_id: PROD, qty_made: 5, qty_shelved: 9, gap_reason: 'damaged' });
  check('more shelved than made → refused, not clamped', () => {
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'shelved_exceeds_made');
  });

  r = await post({ store_id: STORE, product_id: PROD, qty_made: 0 });
  check('a batch of zero → refused', () => {
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'qty_made_required');
  });

  r = await post({ store_id: STORE, product_id: PROD, qty_made: -4 });
  check('a negative batch → refused (this route only ever adds)', () => {
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'qty_made_required');
  });

  // The same confinement the stock route keeps: their own store, nobody else's.
  r = await post({ store_id: OTHER, product_id: PROD, qty_made: 6 });
  check('another store → refused', () => {
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'store_not_assigned');
  });
  check('and that store’s shelf never moved', () => assert.strictEqual(shelf(OTHER), 0));

  r = await post({ store_id: STORE, product_id: 999999, qty_made: 6 });
  check('a product that does not exist → refused', () => {
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'product_not_found');
  });

  check('every refusal above left the shelf and the log exactly as they were', () => {
    assert.strictEqual(shelf(), held, 'a refused call moved stock');
    assert.strictEqual(rows().length, heldRows, 'a refused call wrote a production row');
  });

  section('The gap vocabulary comes from the waste module, not a second copy');

  const reasons = await fetch(base + '/api/retail-admin/production/reasons').then((x) => x.json());
  const codes = (reasons.data || []).map((x) => x.code);
  const wasteCodes = require(path.join(ROOT, 'routes', 'retail-waste.js')).REASONS.map((x) => x.code);
  check('every waste reason is offered', () => {
    for (const c of wasteCodes) assert.ok(codes.indexOf(c) >= 0, `missing ${c}`);
  });
  check('plus made_fewer, which waste does not have and must not gain', () => {
    assert.ok(codes.indexOf('made_fewer') >= 0);
    assert.ok(wasteCodes.indexOf('made_fewer') < 0,
      'made_fewer leaked into the waste vocabulary — it is not a loss');
  });

  srv.close();
  db.prepare('DELETE FROM production_batches WHERE store_id IN (?,?)').run(STORE, OTHER);

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
