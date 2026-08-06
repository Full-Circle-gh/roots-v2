#!/usr/bin/env node
/**
 * Client-side pin handling — the mini-app address book, the mini-app checkout,
 * and the web storefront.
 *
 *   node scripts/test_address_clients.js
 *
 * Separate from scripts/test_address_pin.js because these are WeChat mini-app
 * pages and a browser page, not modules: the mini-app files are loaded under a
 * stubbed `Page`/`wx`/`getApp` so their real handlers can be called, and
 * shop.html's handler is extracted from the script block and evaluated with a
 * stub `$`. Nothing here touches a network, a DB, or a real WeChat runtime.
 *
 * What it locks down (the F1 regression, on all three surfaces):
 *   picking a spot on the map and THEN typing the floor/room number must keep
 *   the pin. Clearing it there — which is what the first version did — silently
 *   undid the whole fix in the most common way anyone fills this form in, and
 *   sent the order back to being pinned by a text guess.
 * Plus the F3a client half: only a fresh map tap may send pin_source='map'.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');

// ── Load a mini-app page module and hand back the object it passed to Page() ──
// The page files call the global Page() at require time and pull in utils that
// expect a WeChat runtime; stubbing both is enough to get the real handlers.
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'getStorageSync') return () => null;
      if (k === 'setStorageSync') return () => {};
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      return () => {};
    },
  });
  try {
    const full = path.join(ROOT, relPath);
    delete require.cache[require.resolve(full)];
    require(full);
    return captured;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}

// Minimal setData: applies 'a.b' paths onto a plain object, like the real one.
function makeCtx(initial) {
  const ctx = {
    data: JSON.parse(JSON.stringify(initial)),
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split('.');
        let cur = ctx.data;
        while (parts.length > 1) { const p = parts.shift(); if (cur[p] == null) cur[p] = {}; cur = cur[p]; }
        cur[parts[0]] = v;
      }
    },
    refreshQuote() {},
    _deriveAreaFromTyped() {},
  };
  return ctx;
}
const field = (name, value) => ({ currentTarget: { dataset: { field: name } }, detail: { value } });

// ── Mini-app address book ───────────────────────────────────────────────────
console.log('\nmini-app address book — onField (F1)');
{
  const page = loadMiniPage('miniapp/pages/addresses/addresses.js');
  const PINNED = { form: { address: '品秀星越花园A栋', detail: '', lat: 23.12, lng: 113.32, pinFresh: true } };

  it('typing the FLOOR/ROOM keeps the map pin', () => {
    const ctx = makeCtx(PINNED);
    page.onField.call(ctx, field('detail', '18层1801室'));
    assert.strictEqual(ctx.data.form.lat, 23.12, 'pin survived');
    assert.strictEqual(ctx.data.form.lng, 113.32);
    assert.strictEqual(ctx.data.form.pinFresh, true, 'and is still a fresh pick');
    assert.strictEqual(ctx.data.form.detail, '18层1801室');
  });
  it('typing the STREET clears the map pin', () => {
    const ctx = makeCtx(PINNED);
    page.onField.call(ctx, field('address', '另一个小区'));
    assert.strictEqual(ctx.data.form.lat, null);
    assert.strictEqual(ctx.data.form.lng, null);
    assert.strictEqual(ctx.data.form.pinFresh, false);
  });
  it('typing the NAME or PHONE leaves the pin alone', () => {
    for (const f of ['recipient_name', 'phone']) {
      const ctx = makeCtx(PINNED);
      page.onField.call(ctx, field(f, 'x'));
      assert.strictEqual(ctx.data.form.lat, 23.12, `${f} must not touch the pin`);
    }
  });
  it('no other handler on this page nulls coordinates (source check, exact count)', () => {
    // A cap with slack is not a guard: the previous version allowed <= 3 while
    // the pattern matched 2, so one new clearing site could be added for free —
    // which is exactly the regression this is supposed to catch. Exact equality,
    // and a pattern that also sees the ternary form ('form.lat': x ? y : null).
    const src = fs.readFileSync(path.join(ROOT, 'miniapp/pages/addresses/addresses.js'), 'utf8');
    const clearing = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /'form\.lat'\s*\]?\s*[:=][^;]*\bnull\b/.test(l));
    // The three legitimate sites, and only these:
    //   onField          — the STREET input (never the detail box)
    //   pickFromWechat   — an address-book entry carries no coordinates
    //   pickOnMap        — the no-pin branch of the map result
    assert.strictEqual(clearing.length, 3,
      `pin-nulling sites changed — review each: ${JSON.stringify(clearing)}`);
  });
}

// ── Mini-app checkout ───────────────────────────────────────────────────────
console.log('\nmini-app checkout — onAddrField (F1)');
{
  const page = loadMiniPage('miniapp/pages/checkout/checkout.js');
  const PINNED = { address: { address: '品秀星越花园A栋', detail: '', lat: 23.12, lng: 113.32, pinFresh: true } };

  it('typing the FLOOR/ROOM keeps the map pin', () => {
    const ctx = makeCtx(PINNED);
    page.onAddrField.call(ctx, field('detail', '18层1801室'));
    assert.strictEqual(ctx.data.address.lat, 23.12);
    assert.strictEqual(ctx.data.address.pinFresh, true);
  });
  it('typing the STREET clears the map pin', () => {
    const ctx = makeCtx(PINNED);
    page.onAddrField.call(ctx, field('address', '另一个小区'));
    assert.strictEqual(ctx.data.address.lat, null);
    assert.strictEqual(ctx.data.address.pinFresh, false);
  });
}

// ── Web storefront ──────────────────────────────────────────────────────────
// shop.html is one big script block against a live DOM. Rather than emulate
// that, we lift the two functions the pin depends on and run them against a
// stub $ — enough to prove the same rule, in the same code.
console.log('\nweb storefront — coBindStreetClearsPin / coApplyArea (F1, F3a)');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
  const grab = (name) => {
    const at = html.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} not found in shop.html`);
    // Walk braces from the function's opening { to its matching close.
    const open = html.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) break; }
    }
    return html.slice(at, i + 1);
  };

  const listeners = {};
  const sandbox = {
    co: { af: {} },
    $: (sel) => ({ addEventListener: (ev, fn) => { listeners[sel + ':' + ev] = fn; },
                   value: '', textContent: '', classList: { remove() {} } }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(grab('coApplyArea') + '\n' + grab('coBindStreetClearsPin'), sandbox);

  it('a map pick records coordinates AND marks them fresh', () => {
    sandbox.co.af = {};
    vm.runInContext("coApplyArea('广东省','广州市','天河区','label','珠江西路15号',23.12,113.32)", sandbox);
    assert.strictEqual(sandbox.co.af.lat, 23.12);
    assert.strictEqual(sandbox.co.af.pinFresh, true);
  });
  it('the area picker (no coordinates) clears the pin and the claim', () => {
    sandbox.co.af = { lat: 23.12, lng: 113.32, pinFresh: true };
    vm.runInContext("coApplyArea('广东省','广州市','天河区','label')", sandbox);
    assert.strictEqual(sandbox.co.af.lat, null);
    assert.strictEqual(sandbox.co.af.pinFresh, false);
  });
  it('only the STREET input is wired to clear the pin — not the detail box', () => {
    vm.runInContext('coBindStreetClearsPin()', sandbox);
    assert.ok(listeners['#afAddr:input'], 'street input clears');
    assert.ok(!listeners['#afDetail:input'], 'detail input must NOT clear');
  });
  it('the street listener clears coordinates and the freshness claim', () => {
    sandbox.co.af = { lat: 23.12, lng: 113.32, pinFresh: true };
    listeners['#afAddr:input']();
    assert.strictEqual(sandbox.co.af.lat, null);
    assert.strictEqual(sandbox.co.af.pinFresh, false);
  });
  it('both save paths send pin_source only when the pin is fresh', () => {
    const sends = html.match(/pin_source:'map'/g) || [];
    assert.strictEqual(sends.length, 2, 'checkout add + address-book save');
    assert.ok(/co\.af\.pinFresh\?\{pin_source:'map'\}/.test(html.replace(/\s/g, '')),
      'gated on pinFresh, never on the mere presence of coordinates');
  });
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
