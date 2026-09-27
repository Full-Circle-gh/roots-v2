#!/usr/bin/env node
/**
 * The phone's order sheet names what an awaiting-restock order is waiting on.
 *
 *   node scripts/test_mobile_waiting_on.js
 *
 * Ash, from a phone, on TC000868: "awaiting stock it doesn't say which product
 * waiting stock for". The desktop drawer has named them since
 * awaitingRestockCard (04-orders.js); the phone showed the status pill and
 * nothing else, off the same `SELECT o.*` payload that already carried
 * `awaiting_restock_pids`.
 *
 * No browser: orderWaitingOn, waitingOnCard, ITEM_TUPLE and itemOpts are SLICED
 * OUT of the shipped public/m.html and run against stubs, so this reads the
 * real source and sits in the fast shard.
 *
 * What it locks down:
 *   1. THE CARD NAMES THE PRODUCT — every line of it, variants included.
 *   2. 🔴 A RELEASED ORDER CLAIMS NOTHING. The pids column is kept after the
 *      order returns to Paid (audit trail), so the reader gates on live status.
 *   3. A pid with no line left still shows, as its id — never a silent gap.
 *   4. "The customer chose to wait" only when they did; a pre-order has no
 *      fallback_choice and must not say it.
 *   5. The Chinese is the desktop's, word for word — no new strings.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

// Top-level functions in m.html close on a `}` in column 0.
function sliceFn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}
function sliceConst(name, endMarker) {
  const start = src.indexOf('\nconst ' + name + '=');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end);
}

let LANG = 'en';
const sandbox = {
  CUR: '¥',
  T: (en, zh) => (LANG === 'zh' ? zh : en),
  escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  ic: (n) => `<i data-ic="${n}"></i>`,
  money: (cur, n) => (cur || '¥') + Number(n || 0),
};
vm.createContext(sandbox);
vm.runInContext([
  sliceFn('itemOpts'),
  sliceConst('ITEM_TUPLE', '\nfunction '),
  sliceFn('orderWaitingOn'),
  sliceFn('waitingOnCard'),
  'globalThis.ITEM_TUPLE=ITEM_TUPLE;',
].join('\n'), sandbox);
const { orderWaitingOn, waitingOnCard } = sandbox;

const ITEMS = [
  { id: 1, product_id: 11, name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', qty: 2, unit_price: 35 },
  { id: 2, product_id: 22, name_en: 'Almonds', name_cn: '杏仁', qty: 1, unit_price: 27, size: '500g' },
  { id: 3, product_id: 22, name_en: 'Almonds', name_cn: '杏仁', qty: 1, unit_price: 50, size: '1kg' },
  { id: 4, product_id: 33, name_en: 'Rice', name_cn: '大米', qty: 1, unit_price: 20 },
];
const order = (over) => Object.assign({
  status: 'awaiting_restock', awaiting_restock_pids: '[22]', fallback_choice: 'wait_for_restock',
  store_code: 'TH', store_name_en: 'Tianhe', store_name_cn: '天河店', items: ITEMS,
}, over);
const card = (o) => waitingOnCard({ waitingOn: orderWaitingOn(o) });

console.log('\n1. the card names the product');
{
  const html = card(order({}));
  has(html, 'Almonds', 'the waited-on product is named');
  has(html, '500g', 'its first variant is shown');
  has(html, '1kg', 'and its second — both lines of that product');
  hasnt(html, 'Oat milk', 'a line that is NOT waited on stays out');
  hasnt(html, 'Rice', 'nor the other one');
  has(html, 'Waiting on stock at Tianhe', 'the title names the store');
}

console.log('\n2. 🔴 a released order claims nothing');
{
  is(orderWaitingOn(order({ status: 'paid' })), null, 'paid with pids still set → nothing');
  is(orderWaitingOn(order({ status: 'dispatched' })), null, 'dispatched → nothing');
  is(card(order({ status: 'paid' })), '', 'and no card is drawn');
  is(orderWaitingOn(order({ awaiting_restock_pids: null })), null, 'no pids → no card');
  is(orderWaitingOn(order({ awaiting_restock_pids: 'not json' })), null, 'unreadable pids → no card, no throw');
}

console.log('\n3. a pid with no line left still shows');
{
  const w = orderWaitingOn(order({ awaiting_restock_pids: '[22, 99]' }));
  is(w.lines.length, 3, 'two Almonds lines plus the orphan');
  has(card(order({ awaiting_restock_pids: '[22, 99]' })), '#99', 'the orphan shows as its id');
  is(orderWaitingOn(order({ awaiting_restock_pids: '["11"]' })).lines.length, 1, 'a pid stored as a string still matches');
}

console.log('\n4. "the customer chose" only when they did');
{
  has(card(order({})), 'The customer chose to wait.', 'wait_for_restock says so');
  hasnt(card(order({ fallback_choice: null })), 'chose to wait', 'a pre-order does not');
  has(card(order({ fallback_choice: null })), 'Releases to Paid on its own once Tianhe', 'but the release line is always there');
  has(card(order({ store_code: null, store_name_en: null, store_name_cn: null })), 'once the store can cover', 'no store → the plain sentence');
}

console.log('\n5. the Chinese is the desktop\'s');
{
  LANG = 'zh';
  const html = card(order({}));
  LANG = 'en';
  has(html, '天河店等待补货', 'title');
  has(html, '顾客选择了等待补货。', 'chose line');
  has(html, '天河店备齐订单全部商品后,订单会自动转为已支付。', 'release line');
  has(html, '杏仁', 'product name in Chinese');
  const desk = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js'), 'utf8');
  for (const s of ['等待补货', '顾客选择了等待补货。', '备齐订单全部商品后,订单会自动转为已支付。', '门店备齐订单全部商品后,订单会自动转为已支付。']) {
    has(desk, s, 'live on the desktop: ' + s);
  }
}

console.log('\n6. the sheet actually draws it');
has(src, '${waitingOnCard(o)}', 'sheetOrderDetail calls waitingOnCard');
has(src, 'base.waitingOn=orderWaitingOn(o);', 'mapDetail fills it');

console.log('\n7. every order status has a name on the phone');
{
  // The pill printed the raw column ("awaiting_restock") because ORDER_STATUS
  // had no entry for it and falls back to r.status. Checked against the locked
  // operator register, so a status added there and not here goes red.
  const at = src.indexOf('\nconst ORDER_STATUS={');
  const map = vm.runInNewContext('(' + src.slice(src.indexOf('{', at), src.indexOf('\n};', at) + 2) + ')');
  const vocab = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
  const reg = vocab.slice(vocab.indexOf('## Order status — operator register'));
  const table = reg.slice(0, reg.indexOf('\n## ', 5));
  const keys = [...new Set([...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]))];
  if (keys.length < 8) bad('the operator register table was found', 'parsed ' + keys.length + ' statuses');
  for (const k of keys) {
    if (map[k]) ok('ORDER_STATUS names ' + k); else bad('ORDER_STATUS names ' + k, 'missing — the pill prints the raw word');
  }
  is(map.awaiting_restock, ['restock', 'Awaiting restock', '等待补货'], 'awaiting_restock: the locked pair, amber');
  is(map.rider_pickup.slice(1), ['Rider coming', '骑手前往取货'], 'rider_pickup: the locked pair');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
