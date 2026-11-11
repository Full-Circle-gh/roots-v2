#!/usr/bin/env node
// THE FAPIAO CODE ON A RECEIPT (§526).
//
// A till receipt and a Ramada menu receipt carry a code for that order. The
// customer scans it and types the details. They land on the order. A menu
// receipt prints before the money arrives, and the page still takes the
// details. The cashier's button stays a paid till sale. A delivery, a
// cancelled sale and an issued sale print no code, and a token that is not
// one of these two doors does not name some other order.
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
  (5, 'TC900005', 'paid', 20, 'till'),
  (6, 'QR900006', 'pending_payment', 18, 'qr'),
  (7, 'DL900007', 'paid', 40, NULL);
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
     'the cashier\'s button stays a till sale; the menu code is on the receipt');
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
  ok(page.text.includes('action="https://shop.example.test/s/fapiao/' + token + '"'),
     'the form posts to the /s/ address the code shows, not to a path the filed domain 404s');
  ok(bad.status === 200 && bad.text.includes('请填写发票抬头'),
     'an empty title is refused in the words the mini app already uses, and the answer is 200 so WeChat shows it');
  const saved = await send('POST', '/s/fapiao/' + token,
    'invoice_type=company&invoice_title=' + encodeURIComponent('越秀咖啡有限公司')
      + '&invoice_tax_id=91440101MA5EXAMPLE&invoice_email=ap@example.com',
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  ok(saved.status === 200 && saved.text.includes('已保存') && saved.text.includes('越秀咖啡有限公司'),
     'a complete form saves and the same page says so, with no redirect', saved.status);
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

  console.log('\n5 · the receipt carries the code, for a till sale and a menu order');
  const feie = require('../lib/feie');
  const menu = handle.prepare('SELECT * FROM retail_orders WHERE id = 2').get();
  const printed = link.receiptUrl(handle, menu, 1);
  ok(/^https:\/\/shop\.example\.test\/s\/fapiao\/[a-f0-9]{36}$/.test(printed || ''),
     'a paid menu order gets an address for its receipt', printed);
  const reprinted = link.receiptUrl(handle, handle.prepare('SELECT * FROM retail_orders WHERE id = 2').get(), 1);
  ok(reprinted === printed, 'a reprint is the same code');
  const unpaid = link.receiptUrl(handle, handle.prepare('SELECT * FROM retail_orders WHERE id = 6').get(), 1);
  ok(/^https:\/\/shop\.example\.test\/s\/fapiao\/[a-f0-9]{36}$/.test(unpaid || ''),
     'a menu order that has not been paid yet still gets a code, because its receipt prints first', unpaid);
  ok(link.receiptUrl(handle, handle.prepare('SELECT * FROM retail_orders WHERE id = 3').get(), 1) === null,
     'a cancelled sale prints no code');
  ok(link.receiptUrl(handle, handle.prepare('SELECT * FROM retail_orders WHERE id = 5').get(), 1) === null,
     'an issued fapiao prints no code');
  ok(link.receiptUrl(handle, handle.prepare('SELECT * FROM retail_orders WHERE id = 7').get(), 1) === null,
     'a delivery prints no code');
  const slip = feie.renderOrder('receipt', menu, [], 'Ramada', [], { fapiaoUrl: printed });
  ok(slip.includes('<QR>' + printed + '</QR>')
     && slip.includes('扫码填写发票') && slip.includes('Scan and type the fapiao'),
     'the receipt prints the code and the words under it');
  const bare = feie.renderOrder('receipt', menu, [], 'Ramada', []);
  ok(!bare.includes('<QR>'), 'a receipt with no address prints no code');
  const compact = feie.renderOrder('compact', menu, [], 'Ramada', [], { fapiaoUrl: printed });
  ok(compact.includes('<QR>' + printed + '</QR>'), 'a compact receipt carries the code too');
  const packing = feie.renderOrder('packing',
    Object.assign({}, menu, { fulfillment_type: 'delivery' }), [], 'Ramada', [], { fapiaoUrl: printed });
  ok(!packing.includes('<QR>'), 'a packing slip does not carry the code');
  const asReceipt = feie.renderOrder('packing',
    { order_no: 'TC1', fulfillment_type: 'counter', total: 12 }, [], 'Ramada', [], { fapiaoUrl: printed });
  ok(asReceipt.includes('<QR>' + printed + '</QR>'),
     'a counter sale whose store prints a packing slip still comes out as a receipt, with the code');
  const token6 = unpaid.split('/').pop();
  const waiting = await send('GET', '/s/fapiao/' + token6);
  ok(waiting.status === 200 && waiting.text.includes('QR900006') && waiting.text.includes('发票资料'),
     'scanning the code on an unpaid menu receipt opens the form', waiting.status);
  const filed = await send('POST', '/s/fapiao/' + token6,
    'invoice_type=personal&invoice_title=' + encodeURIComponent('王伟') + '&invoice_email=wei@example.com',
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  ok(filed.status === 200 && filed.text.includes('已保存'),
     'the form saves before the menu order is paid, and answers 200', filed.status);
  const row6 = handle.prepare('SELECT needs_invoice, invoice_title, invoice_email FROM retail_orders WHERE id = 6').get();
  ok(row6.needs_invoice === 1 && row6.invoice_title === '王伟' && row6.invoice_email === 'wei@example.com',
     'the title and email are on the unpaid menu order', row6);
  handle.prepare('UPDATE retail_orders SET fapiao_token = ? WHERE id = 7').run('d'.repeat(36));
  const hidden = await send('GET', '/s/fapiao/' + 'd'.repeat(36));
  ok(hidden.status === 200 && hidden.text.includes('此链接没有可开的订单') && !hidden.text.includes('DL900007'),
     'a token on a delivery does not open that order');

  console.log('\n6 · the button is a till sale, on each surface that opens one');
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
