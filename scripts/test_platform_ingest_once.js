#!/usr/bin/env node
'use strict';

// §489 — a platform order is mirrored once, decided by the server.
//
//   node scripts/test_platform_ingest_once.js
//
// THE BUG THIS PINS, from the stock-deduction audit of 2026-10-19
// (docs/surveys/stock-deduction-audit-2026-10-19.md, finding 5). The only key
// that stopped a Meituan or Eleme order being ingested twice lived in the
// daemons' import tables, written AFTER the server had created the order and
// deducted its stock. A daemon that died between the two sent the same order
// again on its next poll: second retail_order, second deduction, nothing
// cross-checking. The platform's own id now lives on the order row
// (retail_orders.channel_order_id) and the server answers a second ingest with
// the first order, deducting nothing.
//
// Runs the REAL internal routers over HTTP against the real (gitignored, local)
// database, with empty baskets so no product mapping is needed: what is under
// test is the once-per-order answer, not the line matching.

const assert = require('assert');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const db = tdb();

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

const STORE = 9271;
const MT_NO = 'MTTEST-9271-0001';
const EL_NO = 'ELTEST-9271-0001';

function cleanup() {
  for (const [ch, no] of [['meituan', MT_NO], ['eleme', EL_NO]]) {
    const ids = db.prepare('SELECT id FROM retail_orders WHERE channel = ? AND channel_order_id = ?').all(ch, no).map((r) => r.id);
    for (const id of ids) {
      db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM retail_orders WHERE id = ?').run(id);
    }
  }
  db.prepare('DELETE FROM retail_stores WHERE id = ? OR code = ?').run(STORE, 'INGTEST-' + STORE);
}
function seed() {
  cleanup();
  db.prepare('INSERT INTO retail_stores (id,name_en,name_cn,code,is_active) VALUES (?,?,?,?,1)')
    .run(STORE, 'IngestTest', '测试', 'INGTEST-' + STORE);
}
const mirrored = (ch, no) => db.prepare('SELECT id, order_no FROM retail_orders WHERE channel = ? AND channel_order_id = ? ORDER BY id').all(ch, no);

async function main() {
  seed();
  const app = express();
  app.use(express.json());
  app.use('/api/internal/meituan', require(path.join(ROOT, 'routes', 'meituan-internal.js')));
  app.use('/api/internal/eleme', require(path.join(ROOT, 'routes', 'eleme-internal.js')));
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (url, secret, body) => fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const MT_SECRET = process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal';
  const EL_SECRET = process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal';

  try {
    section('Meituan — the same platform order sent twice is one order');
    const mtOrder = { meituanOrderNo: MT_NO, items: [], total: 0, statusDesc: '待接单' };
    let r = await post('/api/internal/meituan/ingest-order', MT_SECRET, { storeId: STORE, storeCode: 'INGTEST-' + STORE, order: mtOrder });
    check('first ingest is accepted', () => { assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.orderId); });
    const first = r.body.orderId;
    check('the order row carries the platform id', () => {
      const rows = mirrored('meituan', MT_NO);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, first);
    });
    r = await post('/api/internal/meituan/ingest-order', MT_SECRET, { storeId: STORE, storeCode: 'INGTEST-' + STORE, order: mtOrder });
    check('second ingest answers with the first order and says so', () => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.orderId, first);
      assert.strictEqual(r.body.duplicate, true);
      assert.strictEqual(r.body.deducted, 0);
    });
    check('and there is still one order', () => assert.strictEqual(mirrored('meituan', MT_NO).length, 1));

    section('Eleme — the same');
    const elOrder = { elemeOrderId: EL_NO, items: [], total: 0, statusDesc: '待接单' };
    r = await post('/api/internal/eleme/ingest-order', EL_SECRET, { storeId: STORE, storeCode: 'INGTEST-' + STORE, order: elOrder });
    check('first ingest is accepted', () => { assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.orderId); });
    const elFirst = r.body.orderId;
    r = await post('/api/internal/eleme/ingest-order', EL_SECRET, { storeId: STORE, storeCode: 'INGTEST-' + STORE, order: elOrder });
    check('second ingest answers with the first order', () => {
      assert.strictEqual(r.body.orderId, elFirst);
      assert.strictEqual(r.body.duplicate, true);
    });
    check('one Eleme order', () => assert.strictEqual(mirrored('eleme', EL_NO).length, 1));
  } finally {
    srv.close();
    cleanup();
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
