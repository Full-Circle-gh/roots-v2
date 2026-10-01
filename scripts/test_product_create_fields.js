#!/usr/bin/env node
/**
 * §325 step S2i — A NEW PRODUCT KEEPS ITS COST, LOW-STOCK LINE AND BATCH FLAG.
 *
 *   node scripts/test_product_create_fields.js
 *
 * The desktop product drawer's FIRST save is POST /products, and it sends the
 * cost, the "cost is not the whole cost" tag, the low-stock line and "made in
 * fresh batches" with everything else (09-products.js pdCollectBody). The
 * create never stored those four, so they reached the database only on the
 * next autosave, which is a PATCH — and an operator who closed the drawer
 * first lost them. The create now stores them with exactly the PATCH's rules,
 * which this suite proves by sending the same inputs both ways and comparing
 * what lands.
 *
 * The real routes/retail.js over a scratch database, real sessions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router = require(path.join(ROOT, 'routes', 'retail.js'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = 8050 + Object.keys(ops).length;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2i_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
}
operator('owner', [], 'owner');
operator('noCosts', ['products:view', 'products:create', 'products:edit']);

const FIELDS = ['unit_cost', 'cost_incomplete', 'low_stock_threshold', 'is_batch_made'];
const stored = (id) => db.prepare(`SELECT ${FIELDS.join(', ')} FROM store_products WHERE id = ?`).get(id);
let seq = 0;

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, method, p, body) => {
    const r = await fetch(base + '/api/retail-admin' + p, {
      method, headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) }, body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const create = (who, extra) => call(who, 'POST', '/products', { name_en: 'S2i ' + (++seq), sku: 'S2I-' + seq, ...extra });

  try {
    section('1 · what the drawer sends on its first save is stored by the create');
    let r = await create('owner', { unit_cost: 12.5, cost_incomplete: 1, low_stock_threshold: 3, is_batch_made: 1 });
    is(r.status, 200, 'the create succeeds');
    const id1 = r.body.data.id;
    is(stored(id1), { unit_cost: 12.5, cost_incomplete: 1, low_stock_threshold: 3, is_batch_made: 1 },
      'cost, the incomplete tag, the low-stock line and the batch flag are all in the database');
    is(FIELDS.map((k) => r.body.data[k]), [12.5, 1, 3, 1], 'and the answer carries them');

    section('2 · the same rules as the PATCH, input for input');
    const inputs = [
      { unit_cost: 0 }, { unit_cost: -5 }, { unit_cost: '' }, { unit_cost: 'abc' }, { unit_cost: '7.25' },
      { cost_incomplete: 0 }, { cost_incomplete: true },
      { low_stock_threshold: '' }, { low_stock_threshold: -1 }, { low_stock_threshold: 'x' }, { low_stock_threshold: '4' }, { low_stock_threshold: 0 },
      { is_batch_made: 0 }, { is_batch_made: 'yes' },
    ];
    for (const inp of inputs) {
      const c = await create('owner', inp);
      const viaCreate = stored(c.body.data.id);
      const p = await create('owner', {});
      await call('owner', 'PATCH', '/products/' + p.body.data.id, inp);
      const viaPatch = stored(p.body.data.id);
      const k = Object.keys(inp)[0];
      is(viaCreate[k], viaPatch[k], `${JSON.stringify(inp)} lands as ${JSON.stringify(viaPatch[k])} either way`);
    }

    section('3 · a key that is not sent keeps the column default, as before');
    r = await create('owner', {});
    is(stored(r.body.data.id), { unit_cost: null, cost_incomplete: null, low_stock_threshold: null, is_batch_made: 0 },
      'no cost (unknown, not 0), no tag, the shop-wide low-stock line, not batch-made');

    section('4 · an operator who cannot see costs cannot write them, here as on PATCH');
    r = await create('noCosts', { unit_cost: 9, cost_incomplete: 1, low_stock_threshold: 2, is_batch_made: 1 });
    is(r.status, 200, 'the create succeeds');
    is(stored(r.body.data.id), { unit_cost: null, cost_incomplete: null, low_stock_threshold: 2, is_batch_made: 1 },
      'the cost keys are struck (a hidden field cannot write), the other two are stored');
    ok(!('unit_cost' in r.body.data) && !('cost_incomplete' in r.body.data), 'and the answer carries no cost to them');

    section('5 · the handler, read the way the phone\'s create test reads it');
    const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    const h0 = SRC.indexOf("router.post('/api/retail-admin/products', requireRetailAdmin");
    const handler = SRC.slice(h0, SRC.indexOf('\n});', h0));
    const cols = ((handler.match(/INSERT INTO store_products\s*\(([\s\S]*?)\)\s*VALUES/) || [])[1] || '').split(',').map((c) => c.trim());
    for (const f of FIELDS) ok(cols.includes(f), `the create's INSERT stores ${f}`);
    const placeholders = ((handler.match(/VALUES \(([^)]*)\)`/) || [])[1] || '').split(',').length;
    is(placeholders, cols.length, 'one value per column');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
