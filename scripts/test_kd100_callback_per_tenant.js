#!/usr/bin/env node
/**
 * §412.6 — NO TENANT INHERITS ROOTS' KUAIDI100 CALLBACK ADDRESS.
 *
 *   node scripts/test_kd100_callback_per_tenant.js
 *
 * lib/tracking.js builds each tenant's kd100 callback from this server's own
 * origin plus the tenant id in the path. When no origin was configured it used
 * to fall back to a literal Roots domain; now the address is unknown (''), and
 * kd100Enabled() says tracking is not set up rather than subscribing with
 * somebody else's address. GET /integrations hands the screens the address in
 * effect (routes/retail.js), so neither screen carries a default of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const ROOT = path.join(__dirname, '..');
const saved = { cb: process.env.KD100_CALLBACK, po: process.env.PUBLIC_ORIGIN };
const t = require('../lib/tracking');
const env = (cb, po) => {
  if (cb == null) delete process.env.KD100_CALLBACK; else process.env.KD100_CALLBACK = cb;
  if (po == null) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = po;
};

it('no origin configured: the address is unknown, not Roots\'', () => {
  env(null, null);
  assert.strictEqual(t.kd100TenantCallbackUrl(7), '');
  assert.strictEqual(t.kd100Enabled({ customer: 'C', key: 'K', callback: t.kd100TenantCallbackUrl(7) }), false, 'so tracking reads as not set up');
});
it('PUBLIC_ORIGIN: this server\'s own address, the tenant in the path', () => {
  env(null, 'https://shop.example.com/anything');
  assert.strictEqual(t.kd100TenantCallbackUrl(7), 'https://shop.example.com/api/retail/tracking/kd100/callback/7');
});
it('a configured callback: its origin, the tenant in the path', () => {
  env('https://srv.example.net/api/retail/tracking/kd100/callback', null);
  assert.strictEqual(t.kd100TenantCallbackUrl(12), 'https://srv.example.net/api/retail/tracking/kd100/callback/12');
});
it('a malformed PUBLIC_ORIGIN is unknown too', () => {
  env(null, 'not a url');
  assert.strictEqual(t.kd100TenantCallbackUrl(7), '');
});
it('no Roots domain is written into the builder, the screens, or their defaults', () => {
  const T = fs.readFileSync(path.join(ROOT, 'lib/tracking.js'), 'utf8');
  const fn = T.slice(T.indexOf('function kd100CallbackOrigin'), T.indexOf('function kd100TenantCallbackUrl'));
  assert.ok(!/rootskitchenchina/.test(fn));
  const R = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  assert.ok(R.includes('out.kd100.callback = kd100Creds().callback || \'\';') && R.includes('out.kd100.callback_built = true;'), 'GET /integrations hands over the address in effect');
});
env(saved.cb, saved.po);
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
