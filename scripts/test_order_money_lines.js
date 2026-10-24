#!/usr/bin/env node
/**
 * The customer order page's price lines add up to its total.
 *
 *   node scripts/test_order_money_lines.js
 *
 * THE DEFECT. checkout's total is subtotal + shipping + packing − coupon −
 * points − wallet, but GET /api/retail/orders/:id gave the page only subtotal,
 * shipping and total, so a shopper whose order used any of the others read
 * "¥227 + ¥25 = ¥213" and could not tell why. The order now carries
 * money_lines, the signed lines between shipping and total.
 *
 * LOCKED: (1) subtotal + shipping + the lines = total, for an order that uses
 * all four; (2) an order that uses none gets no lines, so nothing else changes;
 * (3) labels come in both languages, CN from the live checkout strings.
 * The route is the REAL express route, called over HTTP against sqlite.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// High ids in a block no other suite claims (the shard shares one sqlite file).
const CUSTOMER = 9936;
const TOKEN    = 'moneylinestesttoken9936';
const FULL = 9937, PLAIN = 9938;
const IDS = [FULL, PLAIN];

function cleanup() {
  const ph = IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Money Lines Test', '13900000036', 'dev:money-lines');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  const ins = db.prepare(
    `INSERT INTO retail_orders (id, customer_id, order_no, status, payment_method, placed_at,
                                subtotal, shipping_fee, packing_fee, voucher_amount,
                                points_used, points_amount, balance_used, total)
     VALUES (?,?,?,'paid','wechat','2026-10-23 07:06:00',?,?,?,?,?,?,?,?)`
  );
  // 227 + 25 + 4 − 20 − 13 (130 pts) − 10 wallet = 213
  ins.run(FULL,  CUSTOMER, 'ML-0001', 227, 25, 4, 20, 130, 13, 10, 213);
  ins.run(PLAIN, CUSTOMER, 'ML-0002', 100, 10, 0, 0, 0, 0, 0, 110);
}

const app = express();
app.use(router);
let PORT = 0;
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const full = (await get(`/api/retail/orders/${FULL}`)).body?.data || {};
    console.log('\nan order that used packing, coupon, points and wallet\n');
    it('subtotal + shipping + the lines = total', () => {
      const sum = full.subtotal + full.shipping_fee
        + full.money_lines.reduce((s, l) => s + l.amount, 0);
      assert.strictEqual(Math.round(sum * 100) / 100, full.total);
    });
    it('has the four lines, in checkout order', () => {
      assert.deepStrictEqual(full.money_lines.map(l => l.key), ['packing', 'coupon', 'points', 'wallet']);
      assert.deepStrictEqual(full.money_lines.map(l => l.amount), [4, -20, -13, -10]);
    });
    it('labels both languages; CN is the live checkout wording', () => {
      assert.deepStrictEqual(full.money_lines.map(l => l.label_cn), ['包装费', '优惠券', '积分抵扣 · 130 积分', '钱包']);
      assert.deepStrictEqual(full.money_lines.map(l => l.label_en), ['Packing fee', 'Coupon', 'Points · 130 pts', 'Wallet']);
    });

    console.log('\nan order that used none\n');
    const plain = (await get(`/api/retail/orders/${PLAIN}`)).body?.data || {};
    it('gets no lines', () => assert.deepStrictEqual(plain.money_lines, []));
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
