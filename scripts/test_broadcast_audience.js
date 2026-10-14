#!/usr/bin/env node
/**
 * test_broadcast_audience.js — a broadcast reaches the customers its audience
 * names, and "has ordered" means a paid order, as Finance counts paid.
 *
 *   node scripts/test_broadcast_audience.js
 *
 * WHAT IT GUARDS. audienceWhere() turns a broadcast's audience (activity,
 * tiers, cities) into the SQL that picks who receives it. "Buyers", "never
 * ordered", "active" and "lapsed" all hinge on BC_PAID_STATUSES. Cutting that
 * list to 'paid' alone, so a customer whose order had moved on to preparing,
 * dispatched or delivered read as "never ordered", failed no suite.
 *
 * AWAITING RESTOCK IS PAID. Decided by Ash 2026-10-14 (decisions §477,
 * v4.531): the list is lib/finance-window.js's PAID_STATUSES, not a copy, so a
 * customer whose only order is paid and waiting on stock is a buyer here as in
 * Finance. Until then it was a four-status copy that left that status out.
 *
 * The real module, lib/broadcast-audience.js, over the real table definitions
 * from database.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const { BC_PAID_STATUSES, audienceWhere, normalizeAudience } = require(path.join(ROOT, 'lib', 'broadcast-audience'));
const { PAID_STATUSES } = require(path.join(ROOT, 'lib', 'finance-window'));

const db = openTablesDb(DB_SRC, ['retail_customers', 'retail_orders', 'retail_customer_addresses']);
const cust = db.prepare('INSERT INTO retail_customers (id, openid, nickname, tier_key, is_blocked) VALUES (?, ?, ?, ?, ?)');
let orderNo = 0;
const order = (cid, status, daysAgo) => db.prepare(
  `INSERT INTO retail_orders (order_no, customer_id, status, placed_at, total)
   VALUES (?, ?, ?, datetime('now', ?), 10)`).run('BA' + (++orderNo), cid, status, `-${daysAgo} days`);
// One customer per paid stage, each with a single recent order.
const STAGES = ['paid', 'preparing', 'dispatched', 'delivered', 'awaiting_restock'];
STAGES.forEach((s, i) => { cust.run(10 + i, 'o' + i, s, 'seed', 0); order(10 + i, s, 3); });
cust.run(20, 'o20', 'only pending', 'seed', 0);   order(20, 'pending', 3);
cust.run(21, 'o21', 'only cancelled', 'seed', 0); order(21, 'cancelled', 3);
cust.run(22, 'o22', 'no orders', 'sprout', 0);
cust.run(23, 'o23', 'lapsed buyer', 'root', 0);   order(23, 'delivered', 90);
cust.run(24, 'o24', 'blocked buyer', 'seed', 1);  order(24, 'delivered', 3);
db.prepare(`INSERT INTO retail_customer_addresses (customer_id, recipient_name, phone, province, city, district, address)
            VALUES (22, 'x', '13800000000', '广东省', '佛山市', '禅城区', 'x')`).run();

const who = (audience) => {
  const { where, params } = audienceWhere(audience);
  return db.prepare(`SELECT c.id FROM retail_customers c WHERE ${where} ORDER BY c.id`).all(...params).map((r) => r.id);
};

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n0. one meaning of paid');
it('the broadcast paid list IS Finance\'s paid list, not a copy of it', () => {
  assert.strictEqual(BC_PAID_STATUSES, PAID_STATUSES);
});

console.log('\n1. "has ordered" covers every paid stage');
it('buyers: a customer at each paid stage, awaiting restock included, is a buyer', () => {
  const got = who({ activity: 'buyers' });
  for (let i = 0; i < STAGES.length; i++) assert.ok(got.includes(10 + i), `${STAGES[i]} was left out of buyers`);
});
it('buyers: pending, cancelled and no orders are not', () => {
  const got = who({ activity: 'buyers' });
  for (const id of [20, 21, 22]) assert.ok(!got.includes(id), `customer ${id} counted as a buyer`);
});
it('never ordered: none of the paid stages, but pending, cancelled and no orders are', () => {
  const got = who({ activity: 'never' });
  for (let i = 0; i < STAGES.length; i++) assert.ok(!got.includes(10 + i), `${STAGES[i]} counted as never ordered`);
  for (const id of [20, 21, 22]) assert.ok(got.includes(id), `customer ${id} left out of never ordered`);
});
it('active (last 30 days): every recent paid stage; not the 90-day-old buyer', () => {
  const got = who({ activity: 'active' });
  for (let i = 0; i < STAGES.length; i++) assert.ok(got.includes(10 + i), `${STAGES[i]} left out of active`);
  assert.ok(!got.includes(23));
});
it('lapsed (paid before, nothing in 60 days): only the 90-day-old buyer', () => {
  assert.deepStrictEqual(who({ activity: 'lapsed' }), [23]);
});

console.log('\n2. the rest of the audience');
it('a blocked customer is never in any audience', () => {
  for (const activity of ['all', 'buyers', 'active']) assert.ok(!who({ activity }).includes(24), activity);
});
it('tiers and cities narrow the audience', () => {
  assert.deepStrictEqual(who({ tiers: ['sprout'] }), [22]);
  assert.deepStrictEqual(who({ cities: ['佛山市'] }), [22]);
});
it('an unknown activity, unknown tier or the legacy string means everyone active', () => {
  assert.deepStrictEqual(normalizeAudience('all_active'), { activity: 'all', tiers: [], cities: [] });
  assert.deepStrictEqual(normalizeAudience({ activity: 'whales', tiers: ['gold'] }), { activity: 'all', tiers: [], cities: [] });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
