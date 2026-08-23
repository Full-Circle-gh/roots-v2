// End-to-end harness for the Meituan order-extras collector.
//
//   node eval/meituan-order-fields/harness.js
//
// Lives under eval/ deliberately: nothing here is deployable (see
// is_deployable() in scripts/deploy-changed.sh), so committing it ships nothing
// and restarts nothing.
//
// fixture-order.json is a REAL captured order-list row with the customer's
// identifiers replaced and the console deep-link's session token removed — the
// structure is untouched, which is the part under test. schema.snapshot.sql is
// the live DDL of the seven tables involved, taken 2026-08-24; the new columns
// are NOT in it and are applied from database.js at run time, so the migration
// itself is exercised rather than a copy of it.
//
// Original harness note:
//
// Local better-sqlite3 isn't built for Node 24, so this runs the REAL route
// handlers against Node's built-in node:sqlite, seeded with the BOX's actual
// schema for the seven tables involved, plus the new addColumn() lines parsed
// straight out of database.js (so the DDL itself is under test, not a copy of
// it). The route's three deps are primed into require.cache before it loads.
'use strict';
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { DatabaseSync } = require('node:sqlite');
const Module = require('module');

const REPO = process.argv[2] || path.join(__dirname, '..', '..');
const HERE = __dirname;

// ── 1. Build the test DB from the box's schema ────────────────────────────────
// Scratch DB in the OS temp dir — this directory stays clean.
const dbFile = path.join(os.tmpdir(), 'meituan-order-fields-test.db');
try { fs.unlinkSync(dbFile); } catch (e) {}
const raw = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });
raw.exec(fs.readFileSync(path.join(HERE, 'schema.snapshot.sql'), 'utf8'));

// ── 2. Apply the NEW addColumn() lines, parsed out of database.js ─────────────
const dbjs = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');
const NEW_COLS = [
  'channel_commission', 'channel_settle_amount', 'channel_discount',
  'channel_rider_name', 'channel_rider_status', 'channel_rider_status_code',
  'channel_rider_assigned_at', 'channel_rider_fetched_at',
  'channel_customer_id', 'channel_customer_orders',
  'channel_distance_m', 'channel_dest_lat', 'channel_dest_lng', 'channel_food_id',
];
let applied = 0;
for (const m of dbjs.matchAll(/addColumn\('(\w+)',\s*'(\w+)',\s*'([^']+)'\)/g)) {
  const [, table, col, type] = m;
  if (!NEW_COLS.includes(col)) continue;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  applied++;
}
if (applied !== NEW_COLS.length) {
  console.error(`FAIL: parsed ${applied} of ${NEW_COLS.length} new addColumn lines out of database.js`);
  process.exit(1);
}

// ── 3. better-sqlite3 shim over node:sqlite (prepare/run/get/all/transaction) ──
const db = {
  prepare(sql) {
    const st = raw.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  },
  exec: (s) => raw.exec(s),
  transaction: (fn) => (...a) => { raw.exec('BEGIN'); try { const r = fn(...a); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
};

// ── 4. Prime the route's dependencies ─────────────────────────────────────────
const stub = (id, exports) => {
  const full = require.resolve(id, { paths: [path.join(REPO, 'routes')] });
  const m = new Module(full);
  m.exports = exports; m.loaded = true;
  require.cache[full] = m;
};
const adjustments = [];
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });
stub('../lib/inventory', { adjustStock: (a) => { adjustments.push(a); return { ok: true }; } });

const router = require(path.join(REPO, 'routes', 'meituan-internal.js'));

// Find a mounted handler by method + path (no express server needed).
function handler(method, route) {
  for (const l of router.stack) {
    if (l.route && l.route.path === route && l.route.methods[method]) return l.route.stack[0].handle;
  }
  throw new Error(`no handler for ${method} ${route}`);
}
function call(method, route, body) {
  const req = { body, ip: '127.0.0.1', headers: { 'x-internal-secret': 'x' }, connection: {} };
  let out = null, code = 200;
  const res = { json: (j) => { out = j; return res; }, status: (c) => { code = c; return res; } };
  handler(method, route)(req, res);
  return { code, body: out };
}

// ── 5. Seed a store, two products and their stock ─────────────────────────────
db.exec(`
  INSERT INTO store_products (id, name_cn, name_en, sku, is_active) VALUES
    (101, '纯素椰子酸奶-桃子味（小）', 'Coconut Yogurt Peach', '1-130', 1),
    (102, '香烤南瓜汤', 'Roasted Pumpkin Soup', '1-330', 1);
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (7, 101, 10), (7, 102, 10);
`);

// ── 6. The real captured payload → the real extractor ─────────────────────────
const { extractOrderFields } = require(path.join(REPO, 'lib', 'meituan-order-fields.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture-order.json'), 'utf8'));
const channel = extractOrderFields(fixture);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

// ── TEST 1: ingest with the full payload ──────────────────────────────────────
const order = {
  meituanOrderNo: '3200000000000000001',
  daySeq: 1,
  items: [
    { name: '纯素椰子酸奶-桃子味（小） Coconut Yogurt Peach（130g）', sku: null, qty: 1 },
    { name: '香烤南瓜汤 Roasted Pumpkin Soup（330g）(不加热No)', sku: null, qty: 1 },
  ],
  total: 65, paid: true, statusDesc: '用户已收餐',
  eta: '2026-07-30 09:27:21', preOrderAt: null, placedAt: '2026-07-30 08:21:14',
  note: null, needsCutlery: false, channel,
};
const r1 = call('post', '/ingest-order', { storeId: 7, storeCode: 'yuexiu', order });
check('ingest returns ok', r1.code === 200 && r1.body && r1.body.ok, JSON.stringify(r1));
const oid = r1.body && r1.body.orderId;

const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(oid);
check('total = what the customer paid (65)', row.total === 65, `got ${row.total}`);
check('subtotal = goods only (56)', row.subtotal === 56, `got ${row.subtotal}`);
check('shipping_fee = 8', row.shipping_fee === 8, `got ${row.shipping_fee}`);
check('packing_fee = 1', row.packing_fee === 1, `got ${row.packing_fee}`);
check('commission = 3.25', row.channel_commission === 3.25, `got ${row.channel_commission}`);
check('settle = 61.75', row.channel_settle_amount === 61.75, `got ${row.channel_settle_amount}`);
check('fees reconcile to the total', Math.abs((row.subtotal + row.shipping_fee + row.packing_fee) - row.total) < 0.01,
  `${row.subtotal} + ${row.shipping_fee} + ${row.packing_fee} != ${row.total}`);
check('rider name stored', row.channel_rider_name === '骑手甲', `got ${row.channel_rider_name}`);
check('rider status code 40', row.channel_rider_status_code === 40, `got ${row.channel_rider_status_code}`);
check('rider fetched_at', row.channel_rider_fetched_at === '2026-07-30 08:39:09', `got ${row.channel_rider_fetched_at}`);
check('dispatched_at = rider pickup', row.dispatched_at === '2026-07-30 08:39:09', `got ${row.dispatched_at}`);
check('delivered_at set on a delivered row', row.delivered_at === '2026-07-30 09:01:08', `got ${row.delivered_at}`);
check('customer id stored as text', row.channel_customer_id === '100000001', `got ${row.channel_customer_id}`);
check('lifetime order count = 155', row.channel_customer_orders === 155, `got ${row.channel_customer_orders}`);
check('distance 5436m', row.channel_distance_m === 5436, `got ${row.channel_distance_m}`);
check('drop coords', row.channel_dest_lat === 23.1 && row.channel_dest_lng === 113.3,
  `got ${row.channel_dest_lat},${row.channel_dest_lng}`);
check('recipient name', row.recipient_name === '测女士', `got ${row.recipient_name}`);
check('status mapped to delivered', row.status === 'delivered', `got ${row.status}`);

const lines = db.prepare('SELECT * FROM retail_order_items WHERE order_id = ? ORDER BY id').all(oid);
check('two lines stored', lines.length === 2, `got ${lines.length}`);
check('line 1 priced 29', lines[0] && lines[0].unit_price === 29 && lines[0].line_total === 29,
  `got ${lines[0] && lines[0].unit_price}/${lines[0] && lines[0].line_total}`);
check('line 2 priced 27', lines[1] && lines[1].unit_price === 27 && lines[1].line_total === 27,
  `got ${lines[1] && lines[1].unit_price}/${lines[1] && lines[1].line_total}`);
check('line totals sum to the goods amount', lines.reduce((s, l) => s + l.line_total, 0) === row.subtotal,
  `${lines.reduce((s, l) => s + l.line_total, 0)} != ${row.subtotal}`);
check('Meituan listing id on line 1', lines[0] && lines[0].channel_food_id === '49673301215', `got ${lines[0] && lines[0].channel_food_id}`);
check('stock still deducted from the copy-text lines', adjustments.length === 2,
  `got ${adjustments.length} adjustments`);
check('deduction unchanged (10 → 9)', adjustments.every(a => a.newPhysicalQty === 9),
  JSON.stringify(adjustments.map(a => a.newPhysicalQty)));

// ── TEST 2: an order with NO extras at all (old daemon / shape change) ────────
db.exec("INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (8, 101, 5)");
const r2 = call('post', '/ingest-order', {
  storeId: 8, storeCode: 'tianhe',
  order: { meituanOrderNo: 'BARE1', items: [{ name: '纯素椰子酸奶-桃子味（小）', qty: 1 }], total: 29, statusDesc: '配送中' },
});
check('bare order still imports', r2.code === 200 && r2.body.ok, JSON.stringify(r2));
const bare = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(r2.body.orderId);
check('bare: total preserved', bare.total === 29, `got ${bare.total}`);
check('bare: subtotal falls back to total', bare.subtotal === 29, `got ${bare.subtotal}`);
check('bare: unknown fees are NULL not 0', bare.channel_commission === null && bare.channel_settle_amount === null,
  `got ${bare.channel_commission}/${bare.channel_settle_amount}`);
check('bare: fee columns default 0', bare.shipping_fee === 0 && bare.packing_fee === 0,
  `got ${bare.shipping_fee}/${bare.packing_fee}`);
check('bare: line still written at 0', db.prepare('SELECT unit_price FROM retail_order_items WHERE order_id = ?').get(r2.body.orderId).unit_price === 0, 'expected 0');

// ── TEST 3: a corrupt payload must not cost the order ─────────────────────────
const r3 = call('post', '/ingest-order', {
  storeId: 8, storeCode: 'tianhe',
  order: { meituanOrderNo: 'JUNK1', items: [{ name: '香烤南瓜汤', qty: 1 }], total: 27, statusDesc: '配送中',
           channel: { items: 'not-an-array', money: null, rider: 42, customer: undefined, invoice: 'x' } },
});
check('junk extras still import the order', r3.code === 200 && r3.body.ok, JSON.stringify(r3));

// ── TEST 4: the update path backfills an order mirrored before this existed ───
// Simulate the old shape: subtotal == total, no fees, no rider, zero-priced line.
const oldIns = db.prepare(`
  INSERT INTO retail_orders (order_no, status, payment_method, subtotal, total, store_id, channel,
                             fulfillment_type, placed_at, channel_status)
  VALUES ('MT20260101999999','paid','meituan',65,65,7,'meituan','delivery','2026-07-30 08:21:14','配送中')
`).run();
const oldId = oldIns.lastInsertRowid;
db.prepare(`INSERT INTO retail_order_items (order_id, product_id, name_cn, name_en, qty, unit_price, line_total)
            VALUES (?, 101, '纯素椰子酸奶-桃子味（小） Coconut Yogurt Peach（130g）', 'Coconut Yogurt Peach', 1, 0, 0)`).run(oldId);
db.prepare(`INSERT INTO meituan_order_import (meituan_order_no, retail_order_id, store_code, status)
            VALUES ('OLD1', ?, 'yuexiu', 'imported')`).run(oldId);

const r4 = call('post', '/update-order-status', {
  meituanOrderNo: 'OLD1', statusDesc: '用户已收餐', eta: '2026-07-30 09:27:21', channel,
});
check('update returns ok', r4.code === 200 && r4.body.ok, JSON.stringify(r4));
const healed = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(oldId);
check('backfill: subtotal corrected to goods', healed.subtotal === 56, `got ${healed.subtotal}`);
check('backfill: fees filled', healed.shipping_fee === 8 && healed.packing_fee === 1,
  `got ${healed.shipping_fee}/${healed.packing_fee}`);
check('backfill: total untouched', healed.total === 65, `got ${healed.total}`);
check('backfill: rider filled', healed.channel_rider_name === '骑手甲', `got ${healed.channel_rider_name}`);
check('backfill: settle filled', healed.channel_settle_amount === 61.75, `got ${healed.channel_settle_amount}`);
check('backfill: delivered_at filled', healed.delivered_at === '2026-07-30 09:01:08', `got ${healed.delivered_at}`);
check('backfill: customer count filled', healed.channel_customer_orders === 155, `got ${healed.channel_customer_orders}`);
check('backfill: line priced', db.prepare('SELECT unit_price, line_total, channel_food_id FROM retail_order_items WHERE order_id = ?').get(oldId).unit_price === 29, 'expected 29');

// ── TEST 5: idempotence — the same poll again must change nothing ─────────────
const before = JSON.stringify(db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(oldId));
call('post', '/update-order-status', { meituanOrderNo: 'OLD1', statusDesc: '用户已收餐', eta: '2026-07-30 09:27:21', channel });
const after = JSON.stringify(db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(oldId));
check('re-poll is a no-op', before === after, 'row changed on a repeat poll');

// ── TEST 6: a later poll must not overwrite money a human may have touched ────
db.prepare('UPDATE retail_orders SET shipping_fee = 99, subtotal = 50 WHERE id = ?').run(oldId);
call('post', '/update-order-status', { meituanOrderNo: 'OLD1', statusDesc: '用户已收餐', channel });
const kept = db.prepare('SELECT shipping_fee, subtotal FROM retail_orders WHERE id = ?').get(oldId);
check('edited money is not overwritten', kept.shipping_fee === 99 && kept.subtotal === 50,
  `got ${kept.shipping_fee}/${kept.subtotal}`);

// ── TEST 7: the drift/first-sighting log ──────────────────────────────────────
const logs = db.prepare("SELECT store_code, status, error_msg FROM meituan_sync_log WHERE event_type = 'order_fields'").all();
check('order_fields logged', logs.length >= 1, JSON.stringify(logs));
check('a clean order logs status ok', logs.some(l => l.status === 'ok' && l.store_code === 'yuexiu'), JSON.stringify(logs));
check('a payload with no item rows logs drift', logs.some(l => l.status === 'warn'), JSON.stringify(logs));

// ── TEST 8: a poll from an OLDER daemon that sends no extras at all ───────────
const r8 = call('post', '/update-order-status', { meituanOrderNo: 'OLD1', statusDesc: '用户已收餐' });
check('poll without extras still updates status', r8.code === 200 && r8.body.ok, JSON.stringify(r8));
const kept8 = db.prepare('SELECT channel_rider_name, channel_settle_amount FROM retail_orders WHERE id = ?').get(oldId);
check('extras survive an extras-less poll',
  kept8.channel_rider_name === '骑手甲' && kept8.channel_settle_amount === 61.75, JSON.stringify(kept8));

// ── TEST 9: add-ons land in options_json in the shape the packer view reads ───
const withAddons = extractOrderFields({ commonInfo: '{}', orderInfo: JSON.stringify({ foodInfo: { cartDetailVos: [{
  cartName: '1号口袋',
  details: [{ foodName: '香烤南瓜汤 Roasted Pumpkin Soup（330g）', foodPrice: 27, count: 1, foodId: '9001',
              subDetails: [{ foodName: '加牛油果 Avocado' }, { foodName: '不加辣 No chilli' }] }],
}] } }) });
db.exec('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (9, 102, 4)');
const r9 = call('post', '/ingest-order', {
  storeId: 9, storeCode: 'tianhe',
  order: { meituanOrderNo: 'ADDON1', items: [{ name: '香烤南瓜汤 Roasted Pumpkin Soup（330g）', qty: 1 }],
           total: 27, statusDesc: '配送中', channel: withAddons },
});
const l9 = db.prepare('SELECT unit_price, options_json, channel_food_id FROM retail_order_items WHERE order_id = ?').get(r9.body.orderId);
check('add-on line priced', l9.unit_price === 27, `got ${l9.unit_price}`);
check('add-ons stored as [{label}]',
  JSON.stringify(JSON.parse(l9.options_json)) === JSON.stringify([{ label: '加牛油果 Avocado' }, { label: '不加辣 No chilli' }]),
  l9.options_json);

console.log(`\n${failures ? 'FAILURES: ' + failures : 'ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
