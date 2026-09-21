// §209 — an Eleme 预订单 keeps its stock on the shelf until the kitchen starts
// (npm run test:eleme-preorder-stock).
//
// Ash: 饿了么的预定单，需要等到开始备餐的时候才会自动扣库存。
//
// What has to hold, and each case exists because getting it wrong is silent:
//
//   0  no setting at all             → deducts at order time (§210: off by default)
//   A  booked, only accepted        → NOTHING comes off the shelf
//   B  booked, 备餐中 at first sight → deducts at ingest, hold never applies
//   C  booked inside the lead        → deducts at ingest (prep time is now)
//   D  no booking flag               → deducts at ingest, exactly as before
//   E  held → 备餐中 on a later poll  → deducts once, and only once
//   F  held → 已接单 on a later poll  → STILL HELD. The load-bearing case: our
//                                      status map reads 已接单 as 'preparing',
//                                      and if the release read it the same way
//                                      the whole feature would deduct at the
//                                      moment it always did.
//   G  held → cancelled → revived    → never deducted, never restocked, and the
//                                      revival branch must not claim it
//   H  the clock sweep               → releases what the poll never saw, once,
//                                      and never a cancelled order
//   I  lead_minutes from config      → 30 means 30
//   J  the label test itself         → 接单 out, kitchen and movement in
//
// Drives the REAL route handlers (routes/eleme-internal.js) and the REAL
// decision file (lib/channel-preorder-stock.js) against node:sqlite, on schema
// parsed out of database.js at run time — the CREATE plus every addColumn() for
// those tables — so what is under test is the schema the box builds. The
// inventory module is the one stub with behaviour: it applies the delta to
// retail_store_stock, so the shelf in these assertions is a real shelf.
//
// Run: node scripts/test_eleme_preorder_stock.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');

// ── 1. Schema, from database.js itself ────────────────────────────────────────
const dbjs = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');
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

const dbFile = path.join(os.tmpdir(), 'eleme-preorder-stock-test.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
const raw = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });

const TABLES = ['retail_orders', 'retail_order_items', 'retail_store_stock',
                'eleme_product_map', 'eleme_sync_log', 'eleme_order_import',
                'storefront_config', 'retail_stores'];
for (const t of TABLES) raw.exec(ddl(t));
raw.exec(`
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, name_cn TEXT, name_en TEXT, sku TEXT, is_active INTEGER DEFAULT 1
  )
`);
for (const m of dbjs.matchAll(/addColumn\('(\w+)',\s*'(\w+)',\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)) {
  if (!TABLES.includes(m[1])) continue;
  try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3] ?? m[4]}`); }
  catch (_) { /* already in the CREATE above */ }
}
// The column this whole change rests on. If the migration is missing, every
// assertion below would still "pass" by holding nothing — so fail loudly here.
{
  const cols = raw.prepare('SELECT * FROM pragma_table_info(?)').all('retail_orders').map(c => c.name);
  for (const need of ['channel_stock_deferred', 'channel_stock_restored', 'channel_preorder_at']) {
    if (!cols.includes(need)) {
      console.error(`FAIL: retail_orders has no ${need} column`);
      process.exit(1);
    }
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
  Module._resolveFilename = ((orig) => function (request, ...rest) {
    return request === 'express' ? 'express' : orig.call(this, request, ...rest);
  })(Module._resolveFilename);
}

// The one stub that DOES something: every deduction lands on the same shelf the
// route reads back, so "nothing came off" is a fact about stock rather than
// about a spy's call count. Both call shapes the route uses are honoured.
const moves = [];
stub('../lib/inventory', {
  adjustStock: ({ storeId, productId, deltaQty, newPhysicalQty, reason, note }) => {
    const cur = raw.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
      .get(storeId, productId);
    const now = cur ? cur.physical_qty : 0;
    const next = newPhysicalQty != null ? newPhysicalQty : now + (deltaQty || 0);
    raw.prepare('UPDATE retail_store_stock SET physical_qty = ? WHERE store_id = ? AND product_id = ?')
      .run(next, storeId, productId);
    moves.push({ storeId, productId, from: now, to: next, reason, note });
    return { ok: true };
  },
});
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });
stub('../lib/product-cost', { productUnitCostYuan: () => null });
// The alert path reaches for the tenant's messaging transport; the shelf facts
// are what this suite is about, so it is silenced rather than driven.
stub('../lib/channel-line-report', { notifyStockGaps: () => null });

const router = require(path.join(REPO, 'routes', 'eleme-internal.js'));
const preorderStock = require(path.join(REPO, 'lib', 'channel-preorder-stock.js'));

function handler(method, route) {
  for (const l of router.stack) {
    if (l.route && l.route.path === route && l.route.methods[method]) return l.route.stack[0].handle;
  }
  throw new Error(`no handler for ${method} ${route}`);
}
const call = (route, body) => {
  const req = { body, ip: '127.0.0.1',
                headers: { 'x-internal-secret': process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal' },
                connection: {} };
  let out = null, code = 200;
  const res = { json: (j) => { out = j; return res; }, status: (c) => { code = c; return res; } };
  handler('post', route)(req, res);
  return { code, body: out };
};
const ingest = (order) => call('/ingest-order', { storeId: 7, storeCode: 'yuexiu', order });
const poll   = (body) => call('/update-order-status', body);
const sweep  = () => call('/release-due-preorder-stock', {});

// UTC stamp, the format lib/eleme-browser.js toUtcStamp writes.
const stampIn = (minutes) =>
  new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');

let seq = 0;
const mirror = (elemeOrderId, retailOrderId) =>
  raw.prepare('INSERT INTO eleme_order_import (store_code, eleme_order_id, retail_order_id) VALUES (?, ?, ?)')
    .run('yuexiu', String(elemeOrderId), retailOrderId);
const stockOf = (pid) =>
  raw.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = 7 AND product_id = ?').get(pid).physical_qty;
const orderRow = (id) => raw.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
const logKinds = () =>
  raw.prepare('SELECT event_type, COUNT(*) AS n FROM eleme_sync_log GROUP BY event_type').all()
    .reduce((acc, r) => (acc[r.event_type] = r.n, acc), {});

// ── 4. Seed ───────────────────────────────────────────────────────────────────
raw.exec(`
  INSERT INTO retail_stores (id, code, name_en, name_cn) VALUES (7, 'yuexiu', 'Yuexiu', '越秀');
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

/* §210 — THE HOLD SHIPS OFF, so every case below that expects one has to say
   so first. Checked here rather than assumed: a default that quietly came back
   on would make the whole shop's count overstate, and this is the assertion
   that would go red. */
console.log('\n0 · with no setting at all, a booking deducts at order time');
{
  const before = stockOf(101);
  const r = ingest({
    elemeOrderId: `900000000000000${++seq}`,
    items: [{ name: '香烤南瓜汤', sku: 'RT-330', qty: 2, unitPrice: 38, lineTotal: 76 }],
    total: 76, preOrderAt: stampIn(180), statusDesc: '待接单',
  });
  check('nothing is held by default', r.body.stockHeld === false, JSON.stringify(r.body));
  check('shelf down by 2 at order time', stockOf(101) === before - 2, `${before} → ${stockOf(101)}`);
}

// Everything from here on runs with the hold switched on for Eleme, which is
// how a shop that wants it would run.
raw.prepare("INSERT INTO storefront_config (key, value_json) VALUES ('channel.preorder_stock_hold', ?)")
  .run(JSON.stringify({ channels: ['eleme'], lead_minutes: 120 }));

const booking = (over, extra = {}) => ({
  elemeOrderId: `900000000000000${++seq}`,
  items: [{ name: '香烤南瓜汤', sku: 'RT-330', qty: 2, unitPrice: 38, lineTotal: 76 }],
  // preOrderAt is what the daemon sends: lib/eleme-browser.js has already read
  // Eleme's booking flag and turned it into a UTC stamp by the time the route
  // sees it, so the payload here is the route's own input, not the platform's.
  total: 76, preOrderAt: stampIn(over),
  ...extra,
});

// ── A. Booked and only accepted — the shelf does not move ─────────────────────
console.log('\nA · a 预订单 three hours out keeps its stock');
{
  const before = stockOf(101);
  const r = ingest(booking(180, { statusDesc: '商家已接单' }));
  check('ingest ok', r.code === 200 && r.body && r.body.ok, JSON.stringify(r.body));
  check('reported as held', r.body.stockHeld === true, JSON.stringify(r.body));
  check('nothing deducted', r.body.deducted === 0, `deducted ${r.body.deducted}`);
  check('shelf unchanged', stockOf(101) === before, `${before} → ${stockOf(101)}`);
  const row = orderRow(r.body.orderId);
  check('channel_stock_deferred = 1', row.channel_stock_deferred === 1, `got ${row.channel_stock_deferred}`);
  check('channel_stock_restored = 1 (not currently deducted)', row.channel_stock_restored === 1, `got ${row.channel_stock_restored}`);
  check('the hold is in the log', (logKinds().order_stock_held || 0) === 1, JSON.stringify(logKinds()));
}

// ── B. Already being made when we first see it ────────────────────────────────
console.log('\nB · a booking first seen as 备餐中 deducts at ingest');
{
  const before = stockOf(101);
  const r = ingest(booking(180, { statusDesc: '备餐中' }));
  check('not held', r.body.stockHeld === false, JSON.stringify(r.body));
  check('deducted one line', r.body.deducted === 1, `deducted ${r.body.deducted}`);
  check('shelf down by 2', stockOf(101) === before - 2, `${before} → ${stockOf(101)}`);
  check('flag clear', orderRow(r.body.orderId).channel_stock_deferred === 0, 'deferred set on a deducted order');
}

// ── C. Booked, but prep time is already here ──────────────────────────────────
console.log('\nC · a booking inside the two-hour lead deducts at ingest');
{
  const before = stockOf(101);
  const r = ingest(booking(45, { statusDesc: '待接单' }));
  check('not held', r.body.stockHeld === false, JSON.stringify(r.body));
  check('shelf down by 2', stockOf(101) === before - 2, `${before} → ${stockOf(101)}`);
}

// ── D. A normal order is untouched by any of this ─────────────────────────────
console.log('\nD · a plain order still deducts at ingest');
{
  const before = stockOf(102);
  const r = ingest({
    elemeOrderId: `900000000000000${++seq}`,
    items: [{ name: '素食卷饼', sku: 'RT-100', qty: 3, unitPrice: 29, lineTotal: 87 }],
    total: 87, statusDesc: '待接单',
  });
  check('not held', r.body.stockHeld === false, JSON.stringify(r.body));
  check('shelf down by 3', stockOf(102) === before - 3, `${before} → ${stockOf(102)}`);
}

// ── E. The kitchen starts, on a later poll ────────────────────────────────────
console.log('\nE · 备餐中 on a later poll takes the stock, exactly once');
{
  const order = booking(180, { statusDesc: '商家已接单' });
  const r = ingest(order);
  mirror(order.elemeOrderId, r.body.orderId);
  const before = stockOf(101);

  const p1 = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '备餐中' });
  check('released one line', p1.body.released === 1, JSON.stringify(p1.body));
  check('shelf down by 2', stockOf(101) === before - 2, `${before} → ${stockOf(101)}`);
  const row = orderRow(r.body.orderId);
  check('deferred cleared', row.channel_stock_deferred === 0, `got ${row.channel_stock_deferred}`);
  check('restored cleared', row.channel_stock_restored === 0, `got ${row.channel_stock_restored}`);

  const mid = stockOf(101);
  const p2 = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '备餐中' });
  check('a repeat poll releases nothing', (p2.body.released || 0) === 0, JSON.stringify(p2.body));
  check('and moves no stock', stockOf(101) === mid, `${mid} → ${stockOf(101)}`);
  const p3 = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '配送中' });
  check('nor does the next stage', stockOf(101) === mid && (p3.body.rededucted || 0) === 0, JSON.stringify(p3.body));
}

// ── F. Acceptance is not the kitchen ──────────────────────────────────────────
console.log('\nF · 已接单 on a later poll leaves the stock where it is');
{
  const order = booking(180, { statusDesc: '待接单' });
  const r = ingest(order);
  mirror(order.elemeOrderId, r.body.orderId);
  const before = stockOf(101);

  const p = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '商家已接单' });
  check('released nothing', (p.body.released || 0) === 0, JSON.stringify(p.body));
  check('still reported held', p.body.stockHeld === true, JSON.stringify(p.body));
  check('shelf unchanged', stockOf(101) === before, `${before} → ${stockOf(101)}`);
  // Our own lifecycle DID advance — the order reads Preparing in the back
  // office while its stock is deliberately still on the shelf. Both are true,
  // and the pair is the reason the release has its own label test.
  check("our status still moved to 'preparing'", orderRow(r.body.orderId).status === 'preparing',
    `got ${orderRow(r.body.orderId).status}`);
  check('deferred still 1', orderRow(r.body.orderId).channel_stock_deferred === 1, 'hold lost');
}

// ── G. Cancelled, then revived ────────────────────────────────────────────────
console.log('\nG · a held booking that is cancelled and comes back is never deducted twice');
{
  const order = booking(180, { statusDesc: '待接单' });
  const r = ingest(order);
  mirror(order.elemeOrderId, r.body.orderId);
  const before = stockOf(101);

  const p1 = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '已取消' });
  check('nothing restocked (nothing was ever taken)', (p1.body.restocked || 0) === 0, JSON.stringify(p1.body));
  check('shelf unchanged on the cancel', stockOf(101) === before, `${before} → ${stockOf(101)}`);

  const p2 = poll({ elemeOrderId: order.elemeOrderId, statusDesc: '商家已接单' });
  check('the revival branch does not claim it', (p2.body.rededucted || 0) === 0, JSON.stringify(p2.body));
  check('shelf still unchanged', stockOf(101) === before, `${before} → ${stockOf(101)}`);
  check('still held', orderRow(r.body.orderId).channel_stock_deferred === 1, 'hold lost across the void');
}

// ── H. The clock sweep ────────────────────────────────────────────────────────
console.log('\nH · the sweep releases what the poll never saw');
{
  const held = booking(180, { statusDesc: '待接单' });
  const r = ingest(held);
  const before = stockOf(101);

  const early = sweep();
  check('not due yet — sweep leaves it alone', early.body.orders === 0, JSON.stringify(early.body));
  check('shelf unchanged', stockOf(101) === before, `${before} → ${stockOf(101)}`);

  // Drag the booking to 90 minutes out: inside the two-hour lead, so prep time
  // has arrived. Written on the row rather than re-ingested, because what the
  // sweep reads is the row.
  raw.prepare('UPDATE retail_orders SET channel_preorder_at = ? WHERE id = ?')
    .run(stampIn(90), r.body.orderId);
  const due = sweep();
  check('released the order', due.body.orders === 1 && due.body.lines === 1, JSON.stringify(due.body));
  check('shelf down by 2', stockOf(101) === before - 2, `${before} → ${stockOf(101)}`);

  // The release has to be READABLE afterwards. eleme_sync_log.store_code is NOT
  // NULL, so a row written without one is silently dropped — which is how a
  // stock decision becomes invisible.
  check('the release is in the log with its store',
    (raw.prepare("SELECT COUNT(*) AS n FROM eleme_sync_log WHERE event_type = 'order_stock_released' AND store_code = 'yuexiu'").get().n) >= 1,
    JSON.stringify(logKinds()));

  const after = stockOf(101);
  const again = sweep();
  check('a second sweep releases nothing', again.body.orders === 0, JSON.stringify(again.body));
  check('and moves no stock', stockOf(101) === after, `${after} → ${stockOf(101)}`);

  // A cancelled booking is never swept, however far past its window.
  const dead = booking(180, { statusDesc: '待接单' });
  const d = ingest(dead);
  raw.prepare("UPDATE retail_orders SET status = 'cancelled', channel_preorder_at = ? WHERE id = ?")
    .run(stampIn(-600), d.body.orderId);
  const shelfNow = stockOf(101);
  const swept = sweep();
  check('a cancelled booking is not swept', swept.body.orders === 0, JSON.stringify(swept.body));
  check('shelf unchanged', stockOf(101) === shelfNow, `${shelfNow} → ${stockOf(101)}`);
}

// ── I. The lead is a setting ──────────────────────────────────────────────────
console.log('\nI · lead_minutes comes from config');
{
  raw.prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'channel.preorder_stock_hold'")
    .run(JSON.stringify({ channels: ['eleme'], lead_minutes: 30 }));

  const r = ingest(booking(60, { statusDesc: '待接单' }));
  check('60 minutes out is held under a 30-minute lead', r.body.stockHeld === true, JSON.stringify(r.body));
  check('the lead is reported', r.body.leadMinutes === 30, `got ${r.body.leadMinutes}`);

  const soon = ingest(booking(20, { statusDesc: '待接单' }));
  check('20 minutes out deducts', soon.body.stockHeld === false, JSON.stringify(soon.body));

  // And the off switch is an explicit empty list, not an absent row.
  raw.prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'channel.preorder_stock_hold'")
    .run(JSON.stringify({ channels: [], lead_minutes: 30 }));
  const off = ingest(booking(180, { statusDesc: '待接单' }));
  check('channels: [] switches the hold off', off.body.stockHeld === false, JSON.stringify(off.body));

  raw.prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'channel.preorder_stock_hold'")
    .run(JSON.stringify({ channels: ['eleme'], lead_minutes: 120 }));
}

// ── J. The label test, on its own ─────────────────────────────────────────────
console.log('\nJ · what counts as the kitchen having started');
{
  const started = ['备餐中', '已出餐', '已打包', '骑手已取餐', '配送中', '已完成', 'ORDER_COMPLETED', 'DELIVERING', 'COOKING'];
  const notYet  = ['待接单', '商家已接单', '待配送', '待备餐', 'VALID', 'ORDER_ACCEPTED', 'UNPROCESSED', ''];
  for (const s of started) check(`"${s}" counts as started`, preorderStock.prepStarted(s) === true, 'read as not started');
  for (const s of notYet)  check(`"${s}" does not`, preorderStock.prepStarted(s) === false, 'read as started');
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — every check green'}`);
try { fs.unlinkSync(dbFile); } catch (_) {}
process.exit(failures ? 1 : 0);
