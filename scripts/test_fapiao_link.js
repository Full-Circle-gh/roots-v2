#!/usr/bin/env node
// THE TILL'S FAPIAO CODE (§526).
//
// A till sale is paid before anyone has a title. The cashier shows a code for
// that order. The customer types the details. They land on the order. A
// QR-menu sale, a cancelled sale and an issued sale do not get a code, and a
// token that is not a live till sale does not name some other order.
//
// USAGE   node scripts/test_fapiao_link.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no driver/router

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const RETAIL_PATH = path.join(ROOT, 'routes', 'retail.js');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

let openMemoryDb, driver;
try { ({ openMemoryDb, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_fapiao_link] no usable SQLite driver:', e.message); process.exit(2); }

const handle = openMemoryDb();
handle.exec(`
CREATE TABLE retail_orders (
  id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, total REAL,
  shop_entry_method TEXT, needs_invoice INTEGER DEFAULT 0,
  invoice_status TEXT, invoice_type TEXT, invoice_title TEXT,
  invoice_tax_id TEXT, invoice_email TEXT, fapiao_token TEXT,
  subtotal REAL, shipping_fee REAL, store_id INTEGER
);
CREATE UNIQUE INDEX idx_retail_orders_fapiao_token ON retail_orders(fapiao_token) WHERE fapiao_token IS NOT NULL;
CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', '"Asia/Shanghai"');
CREATE TABLE tenants (id INTEGER PRIMARY KEY, status TEXT, rbac_enforce INTEGER, roles_version INTEGER);
CREATE TABLE tenant_users (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, username TEXT, role TEXT,
  is_active INTEGER, display_name TEXT
);
CREATE TABLE tenant_domains (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, host TEXT, status TEXT,
  serves TEXT, is_primary INTEGER
);
INSERT INTO tenants (id, status, rbac_enforce, roles_version) VALUES (1, 'active', 1, 1);
INSERT INTO tenant_users (id, tenant_id, username, role, is_active, display_name) VALUES
  (1, 1, 'cashier', 'staff', 1, 'Cashier'),
  (2, 1, 'viewer', 'staff', 1, 'Viewer');
INSERT INTO tenant_domains (id, tenant_id, host, status, serves, is_primary)
  VALUES (1, 1, 'shop.example.test', 'active', 'shop', 1);
INSERT INTO retail_orders (id, order_no, status, total, shop_entry_method) VALUES
  (1, 'TC900001', 'paid', 48, 'till'),
  (2, 'TC900002', 'paid', 36, 'qr'),
  (3, 'TC900003', 'cancelled', 20, 'till'),
  (4, 'TC900004', 'pending_payment', 20, 'till'),
  (5, 'TC900005', 'paid', 20, 'till');
UPDATE retail_orders SET invoice_status = 'issued', needs_invoice = 1, invoice_title = '已开' WHERE id = 5;
`);

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: RETAIL_PATH, filename: RETAIL_PATH, paths: Module._nodeModulePaths(path.dirname(RETAIL_PATH)),
  });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
stub('../database', handle);
stub('../lib/tenant-db', {
  tdb: () => handle, currentTenantId: () => 1,
  getTenantDb: () => handle, rawTenantDb: () => handle, rawTdb: () => handle,
  ROOTS_TENANT_ID: 1, DATA_ISOLATION_READY: true,
  tenantAls: { run: (_db, fn) => fn(), getStore: () => handle },
});
let CAPS = ['orders:edit'];
const { storeIdsOf } = require('../lib/operator-caps');
stub('../lib/operator-caps', { resolveOperator: () => ({ caps: CAPS, scopeStores: null }), storeIdsOf });
stub('../middleware/auth', {
  logActivity: () => {},
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
  requirePermission: () => (_req, _res, next) => next(),
  requireDelete: (_req, _res, next) => next(),
});
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false, fireRecompute: () => {} });
stub('../middleware/block-kitchen-cost-writes', {
  blockCostWrite: () => (_req, _res, next) => next(), blockCostWriteIf: () => (_req, _res, next) => next(),
});

let express, retailRouter;
try { express = require('express'); retailRouter = require(RETAIL_PATH); }
catch (e) { console.error('[test_fapiao_link] could not load the router:', e.message); process.exit(2); }

const link = require('../lib/fapiao-link');

(async () => {
  console.log(`\ntest_fapiao_link — driver: ${driver}\n`);

  console.log('1 · who may have a code');
  ok(link.staffBlock(handle.prepare('SELECT * FROM retail_orders WHERE id = 1').get()) === null,
     'a paid till sale may show one');
  ok(link.staffBlock(handle.prepare('SELECT * FROM retail_orders WHERE id = 2').get()) === 'not_till',
     'a QR-menu sale may not — that customer already has a page');
  ok(link.staffBlock(handle.prepare('SELECT * FROM retail_orders WHERE id = 3').get()) === 'not_open',
     'a cancelled till sale may not');
  ok(link.staffBlock(handle.prepare('SELECT * FROM retail_orders WHERE id = 4').get()) === 'not_open',
     'an unpaid till sale may not');
  ok(link.staffBlock(handle.prepare('SELECT * FROM retail_orders WHERE id = 5').get()) === 'already_issued',
     'an issued fapiao may not be typed over');

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  let WHO = 1;
  app.use((req, _res, next) => { req.session = { backendUserId: WHO }; next(); });
  app.use(retailRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, p, body, headers) => {
    const r = await fetch(base + p, {
      method,
      headers: headers || { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      redirect: 'manual',
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text, location: r.headers.get('location') };
  };

  console.log('\n2 · the cashier\'s code');
  const denied = await send('POST', '/api/retail-admin/orders/2/fapiao-link', {});
  ok(denied.status === 409 && denied.json.error === 'not_till',
     'the server refuses a QR-menu sale', denied.json);
  CAPS = ['orders:view'];
  const locked = await send('POST', '/api/retail-admin/orders/1/fapiao-link', {});
  ok(locked.status === 403, 'without orders:edit the code is not opened', locked.status);
  CAPS = ['orders:edit'];
  const opened = await send('POST', '/api/retail-admin/orders/1/fapiao-link', {});
  ok(opened.status === 200 && opened.json.data && opened.json.data.qr_png,
     'a till sale returns a picture of the code', opened.status);
  const url = opened.json.data && opened.json.data.url;
  ok(/^https:\/\/shop\.example\.test\/s\/fapiao\/[a-f0-9]{36}$/.test(url || ''),
     'the address is under /s/, which is the path the filed domain forwards', url);
  const again = await send('POST', '/api/retail-admin/orders/1/fapiao-link', {});
  ok(again.json.data && again.json.data.url === url,
     'a second tap shows the same code, so a scan already in progress still lands');

  console.log('\n3 · the customer types, and it lands on that order');
  const token = url.split('/').pop();
  const page = await send('GET', '/s/fapiao/' + token);
  ok(page.status === 200 && page.text.includes('TC900001') && page.text.includes('¥48.00'),
     'the page names this order and what was paid', page.status);
  const bad = await send('POST', '/s/fapiao/' + token,
    'invoice_type=company&invoice_title=&invoice_email=nope',
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  ok(bad.status === 400 && bad.text.includes('请填写发票抬头'),
     'an empty title is refused in the words the mini app already uses');
  const saved = await send('POST', '/s/fapiao/' + token,
    'invoice_type=company&invoice_title=' + encodeURIComponent('越秀咖啡有限公司')
      + '&invoice_tax_id=91440101MA5EXAMPLE&invoice_email=ap@example.com',
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  ok(saved.status === 303 && saved.location === '/s/fapiao/' + token + '?saved=1',
     'a complete form saves and comes back to the same order', saved.location);
  const row = handle.prepare('SELECT needs_invoice, invoice_type, invoice_title, invoice_tax_id, invoice_email FROM retail_orders WHERE id = 1').get();
  ok(row.needs_invoice === 1 && row.invoice_type === 'company'
     && row.invoice_title === '越秀咖啡有限公司'
     && row.invoice_tax_id === '91440101MA5EXAMPLE'
     && row.invoice_email === 'ap@example.com',
     'the title, tax ID and email are on the till sale', row);
  const other = handle.prepare('SELECT needs_invoice FROM retail_orders WHERE id = 2').get();
  ok(other.needs_invoice === 0, 'the QR-menu sale beside it is untouched');
  const seen = await send('GET', '/api/retail-admin/orders/1/fapiao-link');
  ok(seen.status === 200 && seen.json.data && seen.json.data.linked && seen.json.data.title === '越秀咖啡有限公司',
     'the till can see that the details arrived', seen.json);

  console.log('\n4 · a token is not a way to reach some other order');
  const ghost = await send('GET', '/s/fapiao/' + 'a'.repeat(36));
  ok(ghost.status === 200 && ghost.text.includes('此链接没有可开的订单') && !ghost.text.includes('TC900'),
     'an unknown token says the link is not an open order, and names nobody');

  console.log('\n5 · the button is a till sale, on each surface that opens one');
  const till = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
  const desk = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
  const bill = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '07-content-billing.js'), 'utf8');
  ok(/d\.till \? '<button class="dsec" type="button" data-fapiao="open">/.test(till),
     'the till shows the button only after a sale it rang itself');
  ok(/till:\s*true/.test(till) && !/confirmRecall[\s\S]{0,800}till:\s*true/.test(till),
     'a recalled QR order settling on the same screen does not grow one');
  ok(/if\(!o\|\|!o\.tillSale\|\|o\._id==null\) return ''/.test(phone),
     'the phone draws it only for a till sale');
  ok(/o\.shop_entry_method !== 'till'/.test(bill) && /tillFapiaoCodeRow\(o\)/.test(desk),
     'the desktop order does the same');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
