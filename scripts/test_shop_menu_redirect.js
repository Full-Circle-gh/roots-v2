#!/usr/bin/env node
/**
 * The old shop host sends printed QR menus to the filed one — and does
 * nothing at all until it is told to.
 *
 *   node scripts/test_shop_menu_redirect.js
 *
 * docs/tacet-consolidation-decisions.md §496 rule 4. lib/shop-menu-redirect.js.
 *
 * WHAT IS HELD:
 *   1. With the setting unset, empty, or not a plain hostname, every request
 *      passes through. A push to main deploys, so "off" is the default state.
 *   2. With it set, a GET or HEAD for /s/... on the old shop host is a 302 to
 *      the new host with the path and query intact.
 *   3. A POST (an order from a page opened before the switch) is NOT touched.
 *   4. Other paths on the old shop host, and /s/ on any other host, are NOT
 *      touched — including the new host, so there is no loop.
 */
'use strict';

const assert = require('assert');
const { shopMenuRedirect, OLD_HOST } = require('../lib/shop-menu-redirect');

function run(target, req) {
  let redirected = null, nexted = false;
  const res = { redirect(code, url) { redirected = { code, url }; } };
  shopMenuRedirect(target)(Object.assign({ method: 'GET', hostname: OLD_HOST, path: '/s/RK01', originalUrl: '/s/RK01' }, req), res, () => { nexted = true; });
  return { redirected, nexted };
}

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ✓ ' + name); }

check('off when unset, empty, or not a plain hostname', () => {
  for (const t of [undefined, '', '  ', 'https://shop.tacetapp.cn', 'a.cn/evil', 'shop.tacetapp.cn\r\nX: y', OLD_HOST]) {
    const r = run(t, {});
    assert.ok(r.nexted && !r.redirected, 'target ' + JSON.stringify(t));
  }
});

check('on: GET /s/... on the old host is a 302 with path and query kept', () => {
  const r = run('shop.tacetapp.cn', { originalUrl: '/s/RK01?t=12&lang=zh' });
  assert.deepStrictEqual(r.redirected, { code: 302, url: 'https://shop.tacetapp.cn/s/RK01?t=12&lang=zh' });
  assert.ok(!r.nexted);
});

check('on: HEAD is redirected too; the setting is trimmed and lowercased', () => {
  const r = run('  Shop.TacetApp.cn ', { method: 'HEAD' });
  assert.strictEqual(r.redirected && r.redirected.url, 'https://shop.tacetapp.cn/s/RK01');
});

check('on: the pay page and images are redirected', () => {
  for (const u of ['/s/RK01/pay/abc123', '/s/RK01/i/42?w=200']) {
    const p = u.split('?')[0];
    const r = run('shop.tacetapp.cn', { path: p, originalUrl: u });
    assert.strictEqual(r.redirected && r.redirected.url, 'https://shop.tacetapp.cn' + u);
  }
});

check('on: a POST is left alone (an order from a page opened before the switch)', () => {
  const r = run('shop.tacetapp.cn', { method: 'POST', path: '/s/RK01/order', originalUrl: '/s/RK01/order' });
  assert.ok(r.nexted && !r.redirected);
});

check('on: other paths on the old shop host are left alone', () => {
  for (const p of ['/', '/assets/fonts/a.ttf', '/api/retail/products', '/sx/RK01']) {
    const r = run('shop.tacetapp.cn', { path: p, originalUrl: p });
    assert.ok(r.nexted && !r.redirected, p);
  }
});

check('on: /s/ on any other host is left alone, the new host included (no loop)', () => {
  for (const h of ['shop.tacetapp.cn', 'food.rootskitchenchina.com', 'shop.example.com', '']) {
    const r = run('shop.tacetapp.cn', { hostname: h });
    assert.ok(r.nexted && !r.redirected, h);
  }
});

check('on: the old host matches case-insensitively', () => {
  const r = run('shop.tacetapp.cn', { hostname: 'SHOP.RootsKitchenChina.com' });
  assert.ok(r.redirected);
});

console.log(`\nPASS — ${n} checks`);
