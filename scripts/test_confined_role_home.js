#!/usr/bin/env node
/**
 * A confined role's home is Tacet Mobile, and the confinement still holds.
 *
 *   node scripts/test_confined_role_home.js
 *
 * Decisions §48 step 3, as amended 2026-09-08. §48 ruled the standalone stock
 * app retired and worded step 3 as "drop `stock_app_only` from both presets and
 * retire the gate". It cannot run as written: `lib/cap-routes.js` `capDenied`
 * returns ALLOW whenever `tenants.rbac_enforce` is off, `requiredCapFor`
 * returns null for every GET by design, and `rbac_enforce` is 0 on every
 * tenant. Retiring the gate today hands a kitchen phone the whole back office.
 *
 * So the gate SURVIVES and is re-pointed at `/m`. This file is what says the
 * re-point did not quietly widen it.
 *
 * FOUR THINGS ARE ASSERTED, and each fails silently on its own:
 *
 *   1. THE APP CAN BOOT. Tacet Mobile asks who the operator is and what the
 *      store is called before it draws anything. Miss either and the app opens
 *      into a session it cannot describe.
 *   2. THE BACK OFFICE STAYS SHUT. Revenue, orders, customers, team. This is
 *      the whole reason the gate was not retired, so it is the assertion that
 *      matters most and it is written as a sweep rather than a list.
 *   3. THE TWO ROLES GET DIFFERENT DOORS. `store_stock` raises requests and
 *      counts deliveries in; `kitchen` does neither. A path-only allowlist had
 *      to refuse those URLs to both — which is why "Ask for stock" was offered
 *      to the one role that holds `restock:request` and died before its route.
 *   4. THE BOOT DOES NOT ASK FOR WHAT THE GATE WILL REFUSE. `loadLive` fetches
 *      the revenue board unconditionally; `api()` turns a 403 into a redirect
 *      to /backend/login, which server.js bounces back to /m. That is a boot
 *      loop, and the only thing standing between this app and one is the
 *      `flatNav()` early return.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const caps = require(path.join(ROOT, 'lib', 'capabilities.js'));
const { stockAppOnlyAllows: allows } = require(path.join(ROOT, 'lib', 'stock-app-only.js'));

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

const KITCHEN = caps.PRESETS.kitchen;          // add / fulfil / production:log
const CLERK = caps.PRESETS.store_stock;        // recount / request / receive

// ── 1. The app can boot ────────────────────────────────────────────────────
section('Tacet Mobile can open for a confined operator');

check('it may ask who the operator is — the role names their home screen', () => {
  assert.strictEqual(allows('GET', '/api/backend/me', KITCHEN), true);
});

check('and what the store is called, which is where the timezone comes from', () => {
  assert.strictEqual(allows('GET', '/api/retail-admin/config', KITCHEN), true);
});

check('it may set its own language and register for push', () => {
  assert.strictEqual(allows('PUT', '/api/backend/language', KITCHEN), true);
  assert.strictEqual(allows('GET', '/api/backend/push/pref', KITCHEN), true);
  assert.strictEqual(allows('POST', '/api/backend/push/subscribe', KITCHEN), true);
});

check('and sign out', () => {
  assert.strictEqual(allows('POST', '/api/backend/logout', KITCHEN), true);
});

// ── 2. The back office stays shut ──────────────────────────────────────────
section('The back office is still refused — the reason the gate was kept');

/* A SWEEP, NOT A LIST. The failure this guards against is a future line
   widening a pattern rather than adding a URL somebody thought about, and a
   sweep catches that where an enumeration of four does not. /dashboard leads
   because it is the revenue endpoint and the one the boot used to fetch
   unconditionally. */
const FORBIDDEN = [
  '/api/retail-admin/dashboard', '/api/retail-admin/dashboard/ops',
  '/api/retail-admin/orders', '/api/retail-admin/orders/1',
  '/api/retail-admin/customers', '/api/retail-admin/products',
  '/api/retail-admin/purchases', '/api/retail-admin/invoices',
  '/api/retail-admin/sales/summary', '/api/retail-admin/finance',
  '/api/retail-admin/vouchers', '/api/retail-admin/waste',
  '/api/retail-admin/stores', '/api/retail-admin/setup',
  '/api/backend/team', '/api/backend/team/4',
];
for (const p of FORBIDDEN) {
  check(`GET ${p} is refused`, () => {
    assert.strictEqual(allows('GET', p, KITCHEN), false, `${p} was let through`);
    assert.strictEqual(allows('GET', p, CLERK), false, `${p} was let through`);
  });
}

check('and the shelf pattern is still anchored — no future segment rides in on it', () => {
  assert.strictEqual(allows('GET', '/api/retail-admin/stores/3/stock', KITCHEN), true);
  assert.strictEqual(allows('GET', '/api/retail-admin/stores/3/stock/7', KITCHEN), true);
  assert.strictEqual(allows('GET', '/api/retail-admin/stores/3/stock/7/history', KITCHEN), false);
  assert.strictEqual(allows('GET', '/api/retail-admin/stores/3/orders', KITCHEN), false);
});

// ── 3. The two roles get different doors ───────────────────────────────────
section('The clerk raises requests; the cook does not');

check('store_stock may raise a request — the defect this closes', () => {
  assert.ok(CLERK.includes('restock:request'), 'preset changed: clerk lost restock:request');
  assert.strictEqual(allows('POST', '/api/restock', CLERK), true);
});

check('kitchen may not — it holds no restock:request and never did', () => {
  assert.ok(!KITCHEN.includes('restock:request'), 'preset changed: kitchen gained restock:request');
  assert.strictEqual(allows('POST', '/api/restock', KITCHEN), false);
});

check('store_stock may count a delivery in; kitchen may not', () => {
  assert.strictEqual(allows('PUT', '/api/restock/91/receive', CLERK), true);
  assert.strictEqual(allows('PUT', '/api/restock/91/receive', KITCHEN), false);
});

check('the ready list belongs to whoever asked, never to whoever made it', () => {
  assert.strictEqual(allows('GET', '/api/restock/kitchen-ready/lines', CLERK), true);
  assert.strictEqual(allows('POST', '/api/restock/kitchen-ready/seen', CLERK), true);
  assert.strictEqual(allows('GET', '/api/restock/kitchen-ready/lines', KITCHEN), false);
  assert.strictEqual(allows('POST', '/api/restock/kitchen-ready/seen', KITCHEN), false);
});

check('the queue belongs to the cook, and both roles still read the shelf', () => {
  assert.ok(KITCHEN.includes('restock:fulfil'));
  assert.strictEqual(allows('PUT', '/api/restock/91/status', KITCHEN), true);
  assert.strictEqual(allows('POST', '/api/retail-admin/production', KITCHEN), true);
  assert.strictEqual(allows('PATCH', '/api/retail-admin/stores/3/stock/7', KITCHEN), true);
  assert.strictEqual(allows('PATCH', '/api/retail-admin/stores/3/stock/7', CLERK), true);
});

section('An unresolved capability set fails CLOSED, alone in this layer');

/* The rest of the confinement fails OPEN so a control-plane hiccup never locks
   an operator out of the app they use all day, and counting a shelf still does.
   A confinement must not WIDEN when a read fails, so the gated entries refuse.
   This is also what keeps every two-argument caller in the older suites honest:
   they pass no caps and must still read `false` here. */
for (const [m, p] of [['POST', '/api/restock'], ['PUT', '/api/restock/91/receive'],
  ['GET', '/api/restock/kitchen-ready/lines'], ['POST', '/api/restock/kitchen-ready/seen']]) {
  check(`${m} ${p} is refused when caps are null`, () => {
    assert.strictEqual(allows(m, p, null), false);
    assert.strictEqual(allows(m, p), false);
  });
}

check('but counting the shelf survives the same hiccup', () => {
  assert.strictEqual(allows('PATCH', '/api/retail-admin/stores/3/stock/7', null), true);
  assert.strictEqual(allows('GET', '/api/retail-admin/quick-stock/context', null), true);
  assert.strictEqual(allows('GET', '/api/restock', null), true);
});

// ── 4. The server sends them to /m, and the app does not ask for the board ──
section('The door is Tacet Mobile, and the boot knows not to ask');

const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

check('a backend page bounces a confined role to /m, not to the retired app', () => {
  assert.ok(/p === '\/retail-admin' \|\| p\.startsWith\('\/backend\/'\)\) return res\.redirect\('\/m'\)/.test(SERVER),
    'the confined-role redirect does not name /m');
  assert.ok(!/return res\.redirect\('\/stock'\)/.test(SERVER),
    'a redirect to /stock survives — step 3 re-points the confinement at /m');
});

check('/m and its manifest are let through the gate', () => {
  const branch = SERVER.slice(SERVER.indexOf('Pages/assets'), SERVER.indexOf('Pages/assets') + 1400);
  assert.ok(branch.includes("p === '/m'"), '/m is not admitted');
  assert.ok(branch.includes("p === '/m-manifest.webmanifest'"), 'the install manifest is not admitted');
});

check('/stock stays open too — migrate before delete, §48 step 4 closes it', () => {
  const branch = SERVER.slice(SERVER.indexOf('Pages/assets'), SERVER.indexOf('Pages/assets') + 1400);
  assert.ok(branch.includes("p === '/stock'"),
    'an installed home-screen shortcut would die mid-shift');
});

check('the gate is given the capabilities it now decides with', () => {
  assert.ok(/stockAppOnlyAllows\(req\.method, p, roleCaps\)/.test(SERVER),
    'server.js still calls the allowlist without capabilities');
});

const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

/* SCOPED TO loadLive's BODY, not to the file. `api('/dashboard?from=` also
   appears in the Home tab's own reload some three thousand lines earlier, and a
   bare indexOf finds THAT one — which reads as the early return sitting after
   the fetch when it sits before it. The first version of this check failed for
   exactly that reason and the offsets are taken from the function now. */
const BOOT = (() => {
  const from = MHTML.indexOf('async function loadLive()');
  assert.ok(from > 0, 'loadLive is gone — this file is asserting against a boot that moved');
  return MHTML.slice(from);
})();

check('the boot stops before the revenue board for an operator with no tabs', () => {
  const stop = BOOT.indexOf('if(flatNav()) return;');
  assert.ok(stop > 0, 'loadLive has no flat-role early return — a confined role boot-loops');
  const dash = BOOT.indexOf("api('/dashboard?from=");
  assert.ok(dash > 0, 'the dashboard fetch moved — re-check which side of it the return sits on');
  assert.ok(stop < dash, 'the early return sits AFTER the dashboard fetch, so it prevents nothing');
});

check('and it stops AFTER /config, which names their home screen', () => {
  const cfg = BOOT.indexOf("api('/config')");
  const stop = BOOT.indexOf('if(flatNav()) return;');
  assert.ok(cfg > 0 && cfg < stop, 'the early return would skip the store name and timezone');
});

check('and before the rest of the board — orders, products, reviews', () => {
  const stop = BOOT.indexOf('if(flatNav()) return;');
  for (const call of ["api('/orders?limit=", "api('/products?limit=", "api('/reviews?limit="]) {
    const at = BOOT.indexOf(call);
    assert.ok(at > 0, `${call} moved out of the boot — re-check this list`);
    assert.ok(stop < at, `${call} is still fetched before the flat-role return`);
  }
});

console.log(`\n${failures ? `${failures} failed, ` : ''}${passed} checks passed.`);
process.exit(failures ? 1 : 0);
