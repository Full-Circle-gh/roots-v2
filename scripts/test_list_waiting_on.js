#!/usr/bin/env node
/**
 * The orders LIST names what an awaiting-restock order is waiting on.
 *
 *   node scripts/test_list_waiting_on.js
 *
 * Ash, after the drawer card shipped (#861): the list row still said only
 * "Awaiting restock", so finding the short product meant opening every order.
 * GET /api/retail-admin/orders now carries `awaiting_restock_items` — the
 * waited-on lines by name — and the phone's list row prints them.
 *
 * Runs the REAL route against a REAL sqlite database over HTTP, then feeds the
 * payload through the phone's listWaitingOn, sliced out of the shipped m.html.
 *
 * What it locks down:
 *   1. A parked order's row names the waited-on lines, and only those.
 *   2. 🔴 A RELEASED order names nothing, though its pids column is still set —
 *      the column outlives the park as an audit trail.
 *   3. A pid whose line was removed still reaches the row, as its id.
 *   4. The phone row reads it, in both languages.
 *   6. 🔴 A parked row does not ALSO draw the "shipping store is short" chip —
 *      a checkout-time count of only the transferable lines, which beside the
 *      waiting line read as a second, smaller shortage (TC001023, 2026-10-09).
 *      A released row still draws it.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const vm      = require('vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// High ids, clear of the other suites' fixture blocks.
const STORE = 9801, CUSTOMER = 9831;
const { testOperator } = require('./lib/test-operator');
// The suite's own operator, made and removed by the suite — see scripts/lib/test-operator.js.
const op = testOperator(99863, '__op_list_waiting_on');
const OPERATOR = op.id;
const P_MILK = 9811, P_NUTS = 9812, P_RICE = 9813, P_GONE = 9814;
const PIDS = [P_MILK, P_NUTS, P_RICE, P_GONE];

function cleanup() {
  op.remove();
  const oids = db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map((r) => r.id);
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_items', 'retail_payments', 'retail_shipments']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch {}
    }
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PIDS.map(() => '?').join(',')})`).run(...PIDS);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'wo-st', 'Wait Test Store', '等待测试店', '广州市', '天河区', 96);
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'List Wait Test', '13900000003', 'dev:list-wait');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active)
     VALUES (?,?,?,?,10,1,1)`
  );
  for (const pid of PIDS) prod.run(pid, 'wo ' + pid, '测试' + pid, 'wo-' + pid);
}

let n = 0;
function makeOrder(status, pids, lines) {
  const info = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, store_id,
                                fulfillment_type, subtotal, total, paid_at, channel, awaiting_restock_pids)
     VALUES (?,?,?,'wechat',?,'delivery',100,100,CURRENT_TIMESTAMP,'wechat',?)`
  ).run('WO' + String(++n).padStart(6, '0'), CUSTOMER, status, STORE, pids ? JSON.stringify(pids) : null);
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, size, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,?,10,?)`
  );
  for (const l of lines) ins.run(info.lastInsertRowid, l.pid, l.en, l.cn, l.size || null, l.qty, 10 * l.qty);
  return info.lastInsertRowid;
}

const MILK = { pid: P_MILK, en: 'Oat milk', cn: '燕麦奶', qty: 2 };
const NUTS = { pid: P_NUTS, en: 'Almonds', cn: '杏仁', size: '500g', qty: 1 };
const RICE = { pid: P_RICE, en: 'Rice', cn: '大米', qty: 3 };

// The phone's reader, from the shipped file.
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const start = M.indexOf('\nfunction listWaitingOn(');
const phone = vm.createContext({});
vm.runInContext(M.slice(start, M.indexOf('\n}\n', start) + 3), phone);
const ns = M.indexOf('\nfunction orderNotes(');
vm.runInContext(M.slice(ns, M.indexOf('\n}\n', ns) + 3), phone);

(async () => {
  seed();
  const parked   = makeOrder('awaiting_restock', [P_NUTS, P_RICE], [MILK, NUTS, RICE]);
  const released = makeOrder('paid',             [P_NUTS],         [MILK, NUTS]);
  const orphan   = makeOrder('awaiting_restock', [P_NUTS, P_GONE], [NUTS]);
  // Both carry a checkout-time shortage of one transferable line.
  db.prepare('UPDATE retail_orders SET fulfillment_short_pids = ? WHERE id IN (?, ?)')
    .run(JSON.stringify([P_NUTS]), parked, released);

  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/retail-admin/orders?customer_id=${CUSTOMER}&limit=50`);
    const body = await res.json();
    const rows = body.orders || body.data || body.rows || [];
    const row = (id) => rows.find((r) => r.id === id);

    console.log('\n1. a parked order names what it waits on');
    await it('the list answered with the three fixture orders', () => {
      assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));
      assert.ok(row(parked) && row(released) && row(orphan), 'rows missing: ' + JSON.stringify(Object.keys(body)));
    });
    await it('the waited-on lines, in order, and nothing else', () => {
      const items = row(parked).awaiting_restock_items;
      assert.deepStrictEqual(items.map((l) => l.product_id), [P_NUTS, P_RICE]);
      assert.strictEqual(items[0].name_cn, '杏仁');
      assert.strictEqual(items[0].size, '500g');
      assert.strictEqual(items[1].qty, 3);
    });

    console.log('\n2. 🔴 a released order names nothing');
    await it('paid, with the audit column still set → no items', () => {
      assert.strictEqual(row(released).awaiting_restock_items, undefined);
      assert.strictEqual(phone.listWaitingOn(row(released)), null);
    });

    console.log('\n3. a pid with no line left still reaches the row');
    await it('the orphan rides as a bare product_id', () => {
      const items = row(orphan).awaiting_restock_items;
      assert.deepStrictEqual(items.map((l) => l.product_id), [P_NUTS, P_GONE]);
      assert.strictEqual(items[1].name_en, undefined);
    });

    console.log('\n4. the phone row reads it');
    await it('English and Chinese pairs, size and quantity included', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(phone.listWaitingOn(row(parked)))),
        [['Almonds 500g', '杏仁 500g'], ['Rice ×3', '大米 ×3']]);
    });
    await it('the orphan shows as its id', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(phone.listWaitingOn(row(orphan))))[1],
        ['#' + P_GONE, '#' + P_GONE]);
    });
    await it('the list row prints it, under the live "Waiting on stock" pair', () => {
      assert.ok(M.includes('waitingList: listWaitingOn(r),'), 'mapOrderRow does not fill it');
      assert.ok(/\$\{o\.waitingList\?`[\s\S]{0,400}T\('Waiting on stock','等待补货'\)/.test(M),
        'screenOrders does not print it');
    });

    console.log('\n5. the PC list row reads it too');
    // awaitingRestockLine, sliced from the shipped 04-orders.js and fed the
    // same payload the real route just returned.
    const D = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
    const ds = D.indexOf('\nfunction awaitingRestockLine(');
    let lang = 'en';
    const pc = vm.createContext({
      ICON_WAIT_STOCK: '<svg></svg>',
      cuT: (en, cn) => (lang === 'cn' ? cn : en),
      escapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      escapeAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    });
    vm.runInContext(D.slice(ds, D.indexOf('\n}\n', ds) + 3), pc);
    await it('a parked row names its lines, in English', () => {
      const html = pc.awaitingRestockLine(row(parked));
      assert.ok(html.includes('Waiting on stock · Almonds 500g, Rice ×3'), html);
    });
    await it('and in Chinese', () => {
      lang = 'cn';
      const html = pc.awaitingRestockLine(row(parked));
      lang = 'en';
      assert.ok(html.includes('等待补货 · 杏仁 500g、大米 ×3'), html);
    });
    await it('🔴 a released row draws nothing', () => {
      assert.strictEqual(pc.awaitingRestockLine(row(released)), '');
    });
    await it('an orphan pid shows as its id', () => {
      assert.ok(pc.awaitingRestockLine(row(orphan)).includes('#' + P_GONE));
    });
    await it('the row calls it, in the status cell', () => {
      assert.ok(/\$\{paymentCheckLine\(o\)\}\$\{awaitingRestockLine\(o\)\}/.test(D), 'not called from the list row');
    });
    await it('it wraps instead of stretching the status column', () => {
      const css = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
      assert.ok(/\.ord-note-line\.is-wait\s*\{[^}]*white-space:\s*normal/.test(css), 'no .is-wait wrap rule');
    });

    console.log('\n6. 🔴 a parked row draws one shortage, not two');
    const shortChip = (r) => (phone.orderNotes(r) || []).filter((nt) => /short/.test(nt.label[0]));
    await it('the list carries the checkout-time column for both rows', () => {
      assert.strictEqual(row(parked).fulfillment_short_pids, JSON.stringify([P_NUTS]));
      assert.strictEqual(row(released).fulfillment_short_pids, JSON.stringify([P_NUTS]));
    });
    await it('phone: parked → no "Shipping store is short" chip', () => {
      assert.deepStrictEqual(shortChip(row(parked)), []);
    });
    await it('phone: released → the chip is still there', () => {
      assert.strictEqual(shortChip(row(released)).length, 1);
      assert.strictEqual(shortChip(row(released))[0].label[0], 'Shipping store is short 1 item');
    });
    const bs = D.indexOf('\nfunction fulfillmentShortBadge(');
    vm.runInContext(D.slice(bs, D.indexOf('\n}\n', bs) + 3), pc);
    await it('PC: parked → no "needs restock" badge', () => {
      assert.strictEqual(pc.fulfillmentShortBadge(row(parked)), '');
    });
    await it('PC: released → the badge is still there', () => {
      assert.ok(pc.fulfillmentShortBadge(row(released)).includes('needs restock'));
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
