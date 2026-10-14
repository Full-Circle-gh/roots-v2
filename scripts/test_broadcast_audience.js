#!/usr/bin/env node
/**
 * test_broadcast_audience.js — a broadcast reaches the customers its audience
 * names, and "has ordered" means a paid order in any of its paid stages.
 *
 *   node scripts/test_broadcast_audience.js
 *
 * WHAT IT GUARDS. audienceWhere() turns a broadcast's audience (activity,
 * tiers, cities) into the SQL that picks who receives it. "Buyers", "never
 * ordered", "active" and "lapsed" all hinge on BC_PAID_STATUSES. Cutting that
 * list to 'paid' alone, so a customer whose order had moved on to preparing,
 * dispatched or delivered read as "never ordered", failed no suite.
 *
 * OPEN, NOT ASSERTED. lib/finance-window.js counts 'awaiting_restock' as paid
 * and BC_PAID_STATUSES does not, so a customer whose only order awaits restock
 * is "never ordered" to a broadcast. Whether that is right is a product
 * question put to Ash; this suite deliberately says nothing about that status.
 *
 * THE REAL FUNCTIONS ARE LIFTED FROM THE SOURCE AND RUN (retailSource() finds
 * them wherever they live) over the real table definitions from database.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function extractConst(name) {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(SRC);
  assert.ok(m, `const ${name} not found`);
  return m[0];
}
function extractFunction(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}
const BODY = [
  extractConst('BC_PAID_STATUSES'), extractConst('BC_TIER_KEYS'), extractConst('BC_ACTIVITIES'),
  extractFunction('normalizeAudience'), extractFunction('audienceWhere'),
].join('\n');
const { audienceWhere, normalizeAudience } =
  new Function(`${BODY}\nreturn { audienceWhere, normalizeAudience };`)();

const db = openTablesDb(DB_SRC, ['retail_customers', 'retail_orders', 'retail_customer_addresses']);
const cust = db.prepare('INSERT INTO retail_customers (id, openid, nickname, tier_key, is_blocked) VALUES (?, ?, ?, ?, ?)');
let orderNo = 0;
const order = (cid, status, daysAgo) => db.prepare(
  `INSERT INTO retail_orders (order_no, customer_id, status, placed_at, total)
   VALUES (?, ?, ?, datetime('now', ?), 10)`).run('BA' + (++orderNo), cid, status, `-${daysAgo} days`);
// One customer per paid stage, each with a single recent order.
const STAGES = ['paid', 'preparing', 'dispatched', 'delivered'];
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

console.log('\n1. "has ordered" covers every paid stage');
it('buyers: a customer at each of paid, preparing, dispatched and delivered is a buyer', () => {
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
