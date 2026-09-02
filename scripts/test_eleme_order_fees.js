// Eleme ingest writes the platform's packaging and delivery fees
// (npm run test:eleme-order-fees).
//
// The one thing this proves, because it is the one thing that was wrong: an
// Eleme order's 打包费 and 配送费 land in retail_orders.packing_fee /
// shipping_fee, and `subtotal` stays the GOODS while they do. Those two facts
// have to hold together — the fees are ADDENDS to subtotal, so writing them
// beside a subtotal that already contained them would double-count, and that is
// exactly the (mistaken) reading the ingest route used to decline the write on.
//
// The addition itself is the check that matters, and it is the real one off
// EL20260901417897: 267 goods + 1.5 packaging + 18 delivery - 17.5 shop
// discount = 269, the figure Eleme's customerPaidInfo.total carries and `total`
// is written from.
//
// This drives the REAL route handler (routes/eleme-internal.js) against
// node:sqlite, on retail_orders DDL parsed out of database.js at run time — the
// CREATE plus every addColumn() line for that table — so the schema under test
// is the schema the box builds, not a copy of it. Local better-sqlite3 isn't
// built for this Node, hence the shim; the route's deps are primed into
// require.cache before it loads. store_products is the one table declared here
// rather than parsed: database.js assembles it from a column list at run time,
// and the four columns the matcher reads are not what this test is about.
//
// Run: node scripts/test_eleme_order_fees.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');

// ── 1. Schema, from database.js itself ────────────────────────────────────────
const dbjs = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');

// The body of `CREATE TABLE IF NOT EXISTS <name> ( … )`, balanced on parens so a
// column default like DEFAULT (datetime('now')) doesn't end the statement early.
function ddl(table) {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const at = dbjs.indexOf(head);
  if (at < 0) throw new Error(`no DDL for ${table} in database.js`);
  let depth = 0, i = at + head.length - 1;
  for (; i < dbjs.length; i++) {
    if (dbjs[i] === '(') depth++;
    else if (dbjs[i] === ')' && --depth === 0) break;
  }
  return dbjs.slice(at, i + 1);
}

const dbFile = path.join(os.tmpdir(), 'eleme-order-fees-test.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
const raw = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });

const TABLES = ['retail_orders', 'retail_order_items', 'retail_store_stock',
                'eleme_product_map', 'eleme_sync_log'];
for (const t of TABLES) raw.exec(ddl(t));
raw.exec(`
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, name_cn TEXT, name_en TEXT, sku TEXT, is_active INTEGER DEFAULT 1
  )
`);

// Every later column these tables grew, in the order the box grew them. This is
// where packing_fee comes from — it is an addColumn, not part of the CREATE.
let added = 0;
for (const m of dbjs.matchAll(/addColumn\('(\w+)',\s*'(\w+)',\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)) {
  if (!TABLES.includes(m[1])) continue;
  try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3] ?? m[4]}`); added++; }
  catch (_) { /* already in the CREATE above */ }
}
const cols = raw.prepare('SELECT * FROM pragma_table_info(?)').all('retail_orders').map(c => c.name);
for (const need of ['subtotal', 'total', 'packing_fee', 'shipping_fee', 'channel']) {
  if (!cols.includes(need)) {
    console.error(`FAIL: retail_orders has no ${need} column after ${added} addColumn line(s)`);
    process.exit(1);
  }
}

// ── 2. better-sqlite3 shim over node:sqlite ───────────────────────────────────
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

// ── 3. Prime the route's dependencies ─────────────────────────────────────────
const stub = (id, exports) => {
  const full = require.resolve(id, { paths: [path.join(REPO, 'routes')] });
  const m = new Module(full);
  m.exports = exports; m.loaded = true;
  require.cache[full] = m;
};
// express, when it isn't installed. Nothing here serves a request — the test
// calls the handler directly — so the Router only has to collect the handlers
// under the same `stack` shape express gives them, which is what handler()
// below reads. The real express is used when node_modules has it.
try {
  require.resolve('express', { paths: [path.join(REPO, 'routes')] });
} catch (_) {
  const Router = () => {
    const r = (req, res, next) => next && next();
    r.stack = [];
    r.use = (fn) => { r.stack.push({ handle: fn }); return r; };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      r[method] = (p, ...fns) => {
        r.stack.push({ route: { path: p, methods: { [method]: true }, stack: fns.map(handle => ({ handle })) } });
        return r;
      };
    }
    return r;
  };
  const m = new Module('express');
  m.exports = { Router }; m.loaded = true;
  require.cache['express'] = m;
  // Resolve the bare name to that cache key instead of hunting node_modules.
  Module._resolveFilename = ((orig) => function (request, ...rest) {
    return request === 'express' ? 'express' : orig.call(this, request, ...rest);
  })(Module._resolveFilename);
}
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });
stub('../lib/inventory', { adjustStock: () => ({ ok: true }) });
stub('../lib/product-cost', { productUnitCostYuan: () => null });

const router = require(path.join(REPO, 'routes', 'eleme-internal.js'));

function handler(method, route) {
  for (const l of router.stack) {
    if (l.route && l.route.path === route && l.route.methods[method]) return l.route.stack[0].handle;
  }
  throw new Error(`no handler for ${method} ${route}`);
}
function ingest(order) {
  const req = { body: { storeId: 7, storeCode: 'yuexiu', order }, ip: '127.0.0.1',
                headers: { 'x-internal-secret': process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal' },
                connection: {} };
  let out = null, code = 200;
  const res = { json: (j) => { out = j; return res; }, status: (c) => { code = c; return res; } };
  handler('post', '/ingest-order')(req, res);
  return { code, body: out };
}

// ── 4. Seed ───────────────────────────────────────────────────────────────────
db.exec(`
  INSERT INTO store_products (id, name_cn, name_en, sku, is_active) VALUES
    (101, '香烤南瓜汤', 'Roasted Pumpkin Soup', 'RT-330', 1),
    (102, '素食卷饼', 'Vegan Wrap', 'RT-100', 1);
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (7, 101, 50), (7, 102, 50);
`);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

// ── A. EL20260901417897, to the cent ──────────────────────────────────────────
// Goods 267 over three lines, then the two fees Eleme charged on top. `total` is
// what the customer paid (customerPaidInfo.total), which is the goods plus both
// fees less the shop's own ¥17.50 promotion — so the fees are NOT already inside
// subtotal, and the row only adds up once they are written.
console.log('\nA · EL20260901417897 — the fees are additive to the goods');
{
  const r = ingest({
    elemeOrderId: '2000000000000000001',
    items: [
      { name: '香烤南瓜汤', sku: 'RT-330', qty: 1, unitPrice: 38, lineTotal: 38 },
      { name: '素食卷饼',  sku: 'RT-100', qty: 1, unitPrice: 29, lineTotal: 29 },
      { name: '香烤南瓜汤', sku: 'RT-330', qty: 1, unitPrice: 200, lineTotal: 200 },
    ],
    total: 269, statusDesc: '已完成',
    packagingFee: 1.5, deliveryFee: 18, shopDiscount: 17.5,
    commission: 16.14, merchantIncome: 252.86,
  });
  check('ingest returns ok', r.code === 200 && r.body && r.body.ok, JSON.stringify(r));
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(r.body.orderId);
  check('subtotal is the GOODS (267), not the paid total', near(row.subtotal, 267), `got ${row.subtotal}`);
  check('packing_fee = foodInfo.packageFee (1.5)', near(row.packing_fee, 1.5), `got ${row.packing_fee}`);
  check('shipping_fee = foodInfo.deliveryFee (18)', near(row.shipping_fee, 18), `got ${row.shipping_fee}`);
  check('total is the platform figure (269), untouched', near(row.total, 269), `got ${row.total}`);
  check('channel_discount = merchantActivityInfo.total (17.5)', near(row.channel_discount, 17.5), `got ${row.channel_discount}`);
  // Off the ROW, not off the literal above. Until channel_discount existed the
  // only way to state this identity was to hardcode 17.5 here — which asserted
  // the arithmetic while quietly conceding that the term was stored nowhere.
  // Reading the column is what makes this a test of the row rather than of the
  // fixture, and it is the whole point of the write.
  check('goods + packaging + delivery - discount = total, entirely from the row',
    near(row.subtotal + row.packing_fee + row.shipping_fee - row.channel_discount, row.total),
    `${row.subtotal} + ${row.packing_fee} + ${row.shipping_fee} - ${row.channel_discount} != ${row.total}`);
}

// ── B. EL20260831339491, the second live order ────────────────────────────────
console.log('\nB · EL20260831339491 — the same addition on a smaller basket');
{
  const r = ingest({
    elemeOrderId: '2000000000000000002',
    items: [{ name: '素食卷饼', sku: 'RT-100', qty: 1, unitPrice: 135, lineTotal: 135 }],
    total: 141, statusDesc: '已完成',
    packagingFee: 1.5, deliveryFee: 18, shopDiscount: 13.5,
  });
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(r.body.orderId);
  check('subtotal = 135 goods', near(row.subtotal, 135), `got ${row.subtotal}`);
  check('packing_fee = 1.5', near(row.packing_fee, 1.5), `got ${row.packing_fee}`);
  check('shipping_fee = 18', near(row.shipping_fee, 18), `got ${row.shipping_fee}`);
  check('channel_discount = 13.5', near(row.channel_discount, 13.5), `got ${row.channel_discount}`);
  check('135 + 1.5 + 18 - 13.5 = 141 = total, entirely from the row',
    near(row.subtotal + row.packing_fee + row.shipping_fee - row.channel_discount, row.total),
    `got total ${row.total}`);
}

// ── C. A payload that carries no fees ─────────────────────────────────────────
// COALESCE(?, 0), so a silent platform leaves the column at the 0 the schema
// default gave it anyway. 0 reads as "no packaging was charged", which is the
// honest reading for a fee — unlike commission, where 0 would claim the channel
// took nothing and is therefore left NULL.
console.log('\nC · no fees in the payload');
{
  const r = ingest({
    elemeOrderId: '2000000000000000003',
    items: [{ name: '素食卷饼', sku: 'RT-100', qty: 2, unitPrice: 24, lineTotal: 48 }],
    total: 48, statusDesc: '待接单',
  });
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(r.body.orderId);
  check('packing_fee is 0, not null', row.packing_fee === 0, `got ${row.packing_fee}`);
  check('shipping_fee is 0, not null', row.shipping_fee === 0, `got ${row.shipping_fee}`);
  check('channel_commission stays NULL (0 would be a claim)', row.channel_commission == null, `got ${row.channel_commission}`);
  // Same rule, and the reason it is NOT COALESCE(?, 0) like the two fees above:
  // a 0 here would assert "this order carried no shop promotion", which a
  // payload that never mentioned one does not support.
  check('channel_discount stays NULL (0 would claim there was no promotion)', row.channel_discount == null, `got ${row.channel_discount}`);
  check('subtotal still the goods', near(row.subtotal, 48), `got ${row.subtotal}`);
}

// ── D. A fee that arrives as a string, and one that arrives as junk ───────────
console.log('\nD · unusable fee values');
{
  const r = ingest({
    elemeOrderId: '2000000000000000004',
    items: [{ name: '素食卷饼', sku: 'RT-100', qty: 1, unitPrice: 24, lineTotal: 24 }],
    total: 44, statusDesc: '配送中',
    packagingFee: '2', deliveryFee: 'free',
  });
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(r.body.orderId);
  check('numeric string is a number (2)', near(row.packing_fee, 2), `got ${row.packing_fee}`);
  check('unparseable fee falls to 0, never NaN', row.shipping_fee === 0, `got ${row.shipping_fee}`);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'All checks passed.'}`);
process.exit(failures ? 1 : 0);
