#!/usr/bin/env node
/**
 * §452 — a payment that could not be started tells the shop, once, and the
 * customer gets a Try again instead of "we'll contact you".
 *
 *   node scripts/test_payment_start_failed.js
 *
 * No network, no keys, no server.
 *
 *   • alertPaymentStartFailed is sliced out of routes/retail.js and run against
 *     a real retail_orders row and a real activity_log table, with the push and
 *     WeCom senders stubbed to record what they were handed;
 *   • every /payment/create exit that leaves the order unpayable is checked to
 *     call it;
 *   • public/shop.html's checkout is checked to send only the "can't charge
 *     from here" codes to the old screen, and everything else to the retry.
 *
 * TO PROVE THE SUITE CAN FAIL:  PSF_MUTANT=1 node scripts/test_payment_start_failed.js
 * The mutant drops the once-per-order guard, so a customer pressing Try again
 * pages the shop every time. The suite must go RED.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, addTables } = require('./test-support/memory-db');

const MUTANT = process.env.PSF_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const RETAIL_SRC = read('routes/retail.js');
const SHOP_SRC = read('public/shop.html');
const DB_SRC = read('database.js');
const SCHEMA_SRC = read('schema.sql');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// From the `{` at or after `from`, to its matching `}` (inclusive).
function braceSlice(src, from) {
  let i = src.indexOf('{', from), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

// ── 1 · the alert itself ──────────────────────────────────────────────────
console.log('alertPaymentStartFailed');

const fnAt = RETAIL_SRC.indexOf('function alertPaymentStartFailed(');
assert(fnAt > 0, 'alertPaymentStartFailed not found in routes/retail.js');
let fnSrc = 'function alertPaymentStartFailed(orderId, method, reason) ' + braceSlice(RETAIL_SRC, fnAt);
if (MUTANT) {
  const before = fnSrc;
  fnSrc = fnSrc.replace('if (seen) return;', '');
  assert.notStrictEqual(fnSrc, before, 'mutant did not change the source');
  console.log('  (mutant: once-per-order guard removed)');
}

// The real tables: retail_orders from database.js, activity_log from schema.sql
// with database.js's addColumn('activity_log', 'tenant_id') replayed on it.
const t = openTablesDb(DB_SRC, ['retail_orders']);
addTables(t, SCHEMA_SRC, DB_SRC, ['activity_log']);
const ins = t.prepare('INSERT INTO retail_orders (id, order_no, subtotal, total, status, shop_entry_method, recipient_name, recipient_phone) VALUES (?,?,0,?,?,?,?,?)');
ins.run(1, 'TC001049', 213.5, 'pending_payment', 'web', 'Asher', '18613159912');
ins.run(2, 'TC001050', 30, 'pending_payment', 'qr', null, null);
ins.run(3, 'TC001051', 44, 'paid', 'web', 'B', null);
ins.run(4, 'TC001052', 51, 'pending_payment', null, null, null);

const TENANT = 7;
const pushes = [], wecoms = [];
const deps = {
  tdb: () => t,
  db: t,
  currentTenantId: () => TENANT,
  logActivity: (uid, user, action, et, eid, details) => t.prepare(
    'INSERT INTO activity_log (user_id, username, action, entity_type, entity_id, details, tenant_id) VALUES (?,?,?,?,?,?,?)'
  ).run(uid, user, action, et, eid, JSON.stringify(details), TENANT),
  _push: { sendPushToTenantOperators: (tid, p) => pushes.push({ tid, ...p }) },
  wecomAppCreds: () => null,
  wecomWebhookUrl: () => 'https://hook.example',
  sendWecomAppMessage: () => Promise.resolve({ ok: true }),
  postWecomMarkdown: (url, content) => { wecoms.push(content); return Promise.resolve({ ok: true }); },
};
const alertPaymentStartFailed = new Function(...Object.keys(deps), fnSrc + '\nreturn alertPaymentStartFailed;')(...Object.values(deps));
const attempts = (id) => t.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE entity_id = ? AND action = 'payment_start_failed'").get(id).n;

it('a pending web order pages the shop: one push, one WeCom card', () => {
  alertPaymentStartFailed(1, 'wechat', 'wechat_native_failed: NO_AUTH');
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].tid, TENANT);
  assert.strictEqual(pushes[0].event, 'payment_failed');
  assert.match(pushes[0].body, /TC001049 · ¥213\.50/);
  assert.strictEqual(wecoms.length, 1);
  assert.match(wecoms[0], /TC001049/);
  assert.match(wecoms[0], /18613159912/);
});

it('the attempt and its reason are on the order\'s history', () => {
  assert.strictEqual(attempts(1), 1);
  const d = JSON.parse(t.prepare("SELECT details FROM activity_log WHERE entity_id = 1").get().details);
  assert.strictEqual(d.method, 'wechat');
  assert.match(d.reason, /NO_AUTH/);
});

it('a second failure on the same order is logged but does not page again', () => {
  alertPaymentStartFailed(1, 'wechat', 'wechat_native_failed: NO_AUTH');
  alertPaymentStartFailed(1, 'wechat', 'timeout');
  assert.strictEqual(attempts(1), 3);
  assert.strictEqual(pushes.length, 1, `paged ${pushes.length} times for one order`);
  assert.strictEqual(wecoms.length, 1);
});

it('a QR order is left to the till (§440)', () => {
  alertPaymentStartFailed(2, 'wechat', 'x');
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(attempts(2), 0);
});

it('an order that is no longer pending says nothing', () => {
  alertPaymentStartFailed(3, 'wechat', 'x');
  alertPaymentStartFailed(99, 'wechat', 'x');
  assert.strictEqual(pushes.length, 1);
});

it('an order with no entry method recorded still pages (only QR is excluded)', () => {
  alertPaymentStartFailed(4, 'alipay', 'alipay_not_configured');
  assert.strictEqual(pushes.length, 2);
  assert.doesNotMatch(wecoms[1], /收货人/, 'no recipient line when there is no recipient');
});

it('the once-per-order check is scoped to this account', () => {
  const src = fnSrc.replace(/\s+/g, ' ');
  assert.match(src, /tenant_id IS \?/);
});

// ── 2 · every unpayable exit of /payment/create calls it ──────────────────
console.log('/api/retail/payment/create');

const rStart = RETAIL_SRC.indexOf("router.post('/api/retail/payment/create'");
const rEnd = RETAIL_SRC.indexOf("router.get('/api/retail/payment/status/:orderId'");
const route = RETAIL_SRC.slice(rStart, rEnd);

it('each 409 / 5xx exit is preceded by alertPaymentStartFailed', () => {
  const lines = route.split('\n');
  const exits = [];
  lines.forEach((l, i) => {
    const m = l.match(/res\.status\((\d{3})\)/);
    if (m && (m[1] === '409' || m[1][0] === '5')) exits.push(i);
  });
  assert(exits.length >= 8, `expected at least 8 unpayable exits, found ${exits.length}`);
  for (const i of exits) {
    const prev = lines.slice(Math.max(0, i - 2), i).join('\n');
    assert.match(prev, /alertPaymentStartFailed\(orderId, '(wechat|alipay)'/, `no alert before: ${lines[i].trim()}`);
  }
});

it('request errors (400 / 404) do not page anybody', () => {
  const lines = route.split('\n');
  lines.forEach((l, i) => {
    if (/res\.status\(40[04]\)/.test(l)) {
      assert.doesNotMatch(lines.slice(Math.max(0, i - 2), i).join('\n'), /alertPaymentStartFailed/);
    }
  });
});

// ── 3 · the shopper's screen ──────────────────────────────────────────────
console.log('public/shop.html checkout');

const unavailM = SHOP_SRC.match(/const CO_PAY_UNAVAILABLE=\[([^\]]*)\]/);
it('the "we\'ll contact you" codes are listed', () => assert(unavailM, 'CO_PAY_UNAVAILABLE not found'));
const unavail = unavailM ? unavailM[1].split(',').map(s => s.trim().replace(/'/g, '')) : [];

it('each listed code is one the server actually sends for "cannot charge from here"', () => {
  for (const code of unavail) {
    assert(route.includes(`error: '${code}'`), `${code} is not a /payment/create error`);
  }
});

it('a gateway failure is NOT on the list, so it reaches the retry screen', () => {
  for (const code of ['wechat_pay_failed', 'alipay_failed', 'alipay_no_qr']) {
    assert(!unavail.includes(code), `${code} would tell the customer to wait for a call`);
  }
});

it('the payment call\'s catch picks between the two screens by that list', () => {
  const start = SHOP_SRC.indexOf('async function coStartPayment(');
  const body = braceSlice(SHOP_SRC, start);
  assert.match(body, /catch\(e\)\{ return CO_PAY_UNAVAILABLE\.indexOf\(e\.code\)>=0 \? coOrderPlaced\(order\) : coPayFailed\(order\); \}/);
});

it('Try again asks for payment again, the same call the order page makes', () => {
  const start = SHOP_SRC.indexOf('function coPayFailed(');
  assert(start > 0, 'coPayFailed not found');
  const body = braceSlice(SHOP_SRC, start);
  assert.match(body, /coPayRetry'\)\.addEventListener\('click',\(\)=>coStartPayment\(order\)\)/);
  assert.match(body, /clearInterval\(co\.pollTimer\)/);
});

console.log(`\n${pass} passed, ${fail} failed${MUTANT ? ' (mutant)' : ''}`);
process.exit(fail ? 1 : 0);
