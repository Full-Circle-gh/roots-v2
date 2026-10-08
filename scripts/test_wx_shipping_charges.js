#!/usr/bin/env node
/**
 * A wallet top-up and an order add-on each get their own WeChat virtual
 * delivery, exactly like an order does.
 *
 *   node scripts/test_wx_shipping_charges.js
 *
 * The defect this locks down: the shipping upload (发货信息管理) only ever ran
 * for retail_orders, and only when one was marked delivered. A top-up
 * ('FCTU…') and a "Forgot something?" add-on ('FCAO…') are separate WeChat
 * charges with their own 支付单, so nothing ever shipped them: in the merchant
 * back office they sat on 待发货 and went to 发货超时. Seen on 2026-10-08 with
 * two ¥5000/¥2000 top-ups a month old.
 *
 * The functions under test are LIFTED from routes/retail.js and RUN against the
 * REAL schema (database.js booted into a scratch directory), with WeChat faked
 * at wxApiPost. So the columns the migration adds are exercised, not assumed,
 * and every body sent to WeChat is observed rather than inferred.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const db = require(path.join(SCRATCH, 'database.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// ── Lift ─────────────────────────────────────────────────────────────────────
function extractFn(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  return null;
}
function extractConst(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex(l => l.startsWith(`const ${name} =`));
  if (start === -1) return null;
  if (/;\s*(\/\/.*)?$/.test(lines[start])) return lines[start];
  for (let i = start + 1; i < lines.length; i++) if (/^[\]}]/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  return null;
}
const FNS = ['rfc3339Shanghai', 'buildShippingItemDesc', 'shippingItemDescFromLines',
  'uploadWeChatVirtualShipping', 'shipWeChatChargeSoon', 'uploadWeChatVirtualShippingForCharge',
  'claimAndSendShippingUpload', 'sendWeChatShippingUpload', 'retryWeChatShippingForTenant'];
const CONSTS = ['WX_SHIPPING_PERMANENT_CODES', 'WX_SHIPPING_TRANSIENT_CODES', 'WX_SHIPPING_LOCK_STALE_MIN',
  'WX_SHIPPING_CHARGE_TABLES', 'WX_SHIPPING_MAX_ATTEMPTS', 'WX_SHIPPING_SWEEP_LOOKBACK_DAYS',
  'WX_SHIPPING_SWEEP_BATCH'];
const lifted = {};
for (const n of [...FNS, ...CONSTS]) lifted[n] = FNS.includes(n) ? extractFn(n) : extractConst(n);

section('── 0. Extraction');
check('every function and constant under test was found', Object.keys(lifted).filter(n => !lifted[n]), []);

// WeChat, faked. `reply` decides the errcode per transaction_id.
const sent = [];
const alerts = [];
let reply = () => ({ errcode: 0, errmsg: 'ok' });
const routes = new Function('db', 'sent', 'alerts', 'replyRef', `
  const tdb = () => db;
  const cfgValue = (k, d) => d;
  const getWeChatAccessToken = async () => 'tok';
  const wxApiPost = async (p, body) => { sent.push({ path: p, body }); return { json: replyRef.fn(body) }; };
  const sendTenantAlert = async (tid, msg) => { alerts.push(msg); };
  const currentTenantId = () => 1;
  ${CONSTS.map(n => lifted[n]).join('\n')}
  ${FNS.map(n => lifted[n]).join('\n')}
  return { ${FNS.join(', ')} };
`)(db, sent, alerts, { get fn() { return reply; } });

// ── Fixtures ─────────────────────────────────────────────────────────────────
const C_REAL = 9801, C_WEB = 9802;
db.prepare("INSERT INTO retail_customers (id, openid, nickname) VALUES (?, 'oReal_openid_1', 'Real')").run(C_REAL);
db.prepare("INSERT INTO retail_customers (id, openid, nickname) VALUES (?, 'web:abc', 'Web')").run(C_WEB);

function topup(id, { customer = C_REAL, status = 'success', method = 'wechat', txn = `4200TU${id}`, amount = 5000 } = {}) {
  db.prepare(
    `INSERT INTO retail_topup_transactions (id, customer_id, amount, bonus_points, payment_method, status, out_trade_no, transaction_id, paid_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(id, customer, amount, method, status, `FCTU${id}`, txn);
}
const ORDER_ID = 9901;
db.prepare("INSERT INTO retail_orders (id, order_no, customer_id, status, payment_method) VALUES (?, 'RT9901', ?, 'delivered', 'wechat')").run(ORDER_ID, C_REAL);
function addon(id, { txn = `4200AO${id}`, amount = 36, status = 'success' } = {}) {
  db.prepare(
    `INSERT INTO retail_order_addons (id, order_id, customer_id, items_json, amount, payment_method, status, out_trade_no, transaction_id, paid_at)
     VALUES (?, ?, ?, ?, ?, 'wechat', ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(id, ORDER_ID, C_REAL, JSON.stringify([{ name_cn: '燕麦奶', name_en: 'Oat milk', qty: 2 }]), amount, status, `FCAO${id}`, txn);
}
const row = (t, id) => db.prepare(`SELECT wx_shipping_uploaded_at IS NOT NULL AS up, wx_shipping_status AS st, wx_shipping_attempts AS n, wx_shipping_locked_at AS lk FROM ${t} WHERE id = ?`).get(id);

(async () => {
  section('── 1. The migration');
  for (const t of ['retail_topup_transactions', 'retail_order_addons']) {
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name);
    check(`${t} carries the four shipping columns`,
      ['wx_shipping_uploaded_at', 'wx_shipping_status', 'wx_shipping_attempts', 'wx_shipping_locked_at'].filter(c => !cols.includes(c)), []);
  }

  section('── 2. A paid top-up ships as a virtual delivery');
  topup(1, { amount: 5000 });
  await routes.uploadWeChatVirtualShippingForCharge('topup', 1);
  check('one upload sent', sent.length, 1);
  const b = sent[0] && sent[0].body;
  check('to the shipping endpoint', sent[0] && sent[0].path, '/wxa/sec/order/upload_shipping_info');
  check('keyed on the top-up\'s own transaction_id', b && b.order_key, { order_number_type: 2, transaction_id: '4200TU1' });
  check('as a virtual delivery, single shipment', b && [b.logistics_type, b.delivery_mode], [3, 1]);
  check('described as the live wallet label plus the figure', b && b.shipping_list, [{ item_desc: '钱包充值 ¥5000' }]);
  check('payer is the customer\'s openid', b && b.payer, { openid: 'oReal_openid_1' });
  check('stamped uploaded, ok, one attempt, lock released', row('retail_topup_transactions', 1), { up: 1, st: 'ok', n: 1, lk: null });

  section('── 3. Idempotent');
  await routes.uploadWeChatVirtualShippingForCharge('topup', 1);
  check('a second call sends nothing', sent.length, 1);

  section('── 4. What must NOT ship');
  topup(2, { status: 'pending' });
  topup(3, { txn: null });                 // manual finalize / dev: no 支付单
  topup(4, { customer: C_WEB });           // no genuine mini-program openid
  topup(5, { method: 'alipay' });
  for (const id of [2, 3, 4, 5]) await routes.uploadWeChatVirtualShippingForCharge('topup', id);
  check('pending, no txn id, web openid, alipay: nothing sent', sent.length, 1);
  await routes.uploadWeChatVirtualShippingForCharge('nonsense', 1);
  check('an unknown kind is refused, not interpolated', sent.length, 1);

  section('── 5. An add-on ships with its own lines');
  addon(1);
  await routes.uploadWeChatVirtualShippingForCharge('addon', 1);
  const ab = sent[1] && sent[1].body;
  check('keyed on the add-on\'s own transaction_id', ab && ab.order_key.transaction_id, '4200AO1');
  check('described by its staged items', ab && ab.shipping_list, [{ item_desc: '燕麦奶×2' }]);
  check('stamped on the add-on row', row('retail_order_addons', 1).up, 1);
  addon(2, { txn: null, amount: 0 });       // ¥0 add-on: freed shipping covered it, no charge
  await routes.uploadWeChatVirtualShippingForCharge('addon', 2);
  check('a ¥0 add-on (no charge) sends nothing', sent.length, 2);

  section('── 6. The sweeper drains the backlog and retries');
  topup(6, { amount: 2000 });             // the backlog: paid, never shipped
  topup(7, { amount: 99.5 });
  reply = (body) => body.order_key.transaction_id === '4200TU7'
    ? { errcode: 10060019, errmsg: '写冲突' } : { errcode: 0, errmsg: 'ok' };
  const n = await routes.retryWeChatShippingForTenant();
  check('sweep uploads the backlog top-up', row('retail_topup_transactions', 6).up, 1);
  check('a transient reject is left to retry, not stamped', [row('retail_topup_transactions', 7).up, row('retail_topup_transactions', 7).st], [0, 'retry:10060019 写冲突']);
  check('a non-integer amount keeps its cents', sent.filter(s => s.body.order_key.transaction_id === '4200TU7').map(s => s.body.shipping_list[0].item_desc)[0], '钱包充值 ¥99.50');
  check('sweep reports one upload', n, 1);
  check('the transient reject paged nobody', alerts, []);
  const before = sent.length;
  reply = () => ({ errcode: 0, errmsg: 'ok' });
  await routes.retryWeChatShippingForTenant();
  check('the next tick ships it', row('retail_topup_transactions', 7).up, 1);
  check('and touches nothing already shipped', sent.length - before, 1);

  section('── 7. A permanent reject is never retried');
  topup(8);
  reply = () => ({ errcode: 10060004, errmsg: '支付单处于不可发货的状态' });
  await routes.retryWeChatShippingForTenant();
  check('stamped perm', String(row('retail_topup_transactions', 8).st).startsWith('perm:'), true);
  const b2 = sent.length;
  await routes.retryWeChatShippingForTenant();
  check('and the next sweep leaves it alone', sent.length, b2);

  section('── 8. The give-up alert names the merchant order number');
  topup(9);
  db.prepare('UPDATE retail_topup_transactions SET wx_shipping_attempts = 7 WHERE id = 9').run();
  reply = () => ({ errcode: 47001, errmsg: 'data format error' });
  await routes.retryWeChatShippingForTenant();
  check('given up after the cap', String(row('retail_topup_transactions', 9).st).startsWith('perm:givenup'), true);
  check('one rolled-up alert naming FCTU9', alerts.length === 1 && alerts[0].includes('FCTU9'), true);

  section('── 9. Orders still ship as before');
  db.prepare("INSERT INTO retail_payments (order_id, amount, method, status, transaction_id, out_trade_no) VALUES (?, 88, 'wechat', 'success', '4200RT9901', 'FCR9901')").run(ORDER_ID);
  db.prepare("INSERT INTO retail_order_items (order_id, product_id, name_cn, name_en, qty, unit_price, line_total) VALUES (?, NULL, '青酱卷', 'Pesto Wrap', 1, 88, 88)").run(ORDER_ID);
  reply = () => ({ errcode: 0, errmsg: 'ok' });
  await routes.retryWeChatShippingForTenant();
  const ob = sent[sent.length - 1].body;
  check('the delivered order uploads on its payment\'s txn id', ob.order_key.transaction_id, '4200RT9901');
  check('with its own items', ob.shipping_list, [{ item_desc: '青酱卷' }]);
  check('stamped on the order row', row('retail_orders', ORDER_ID).up, 1);

  console.log(failures ? `\n✗ ${failures} failed` : '\n✓ all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
