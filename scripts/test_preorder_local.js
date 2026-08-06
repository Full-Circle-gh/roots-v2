#!/usr/bin/env node
/**
 * PRE-ORDER is an out-of-city offer — the catalog must not promise it to a
 * shopper delivering inside Guangzhou.
 *
 *   node scripts/test_preorder_local.js
 *
 * The rule, and why it needs locking down: a sold-out product on the
 * 'backorder_gz' policy stays orderable only when the order ISN'T Guangzhou
 * same-day (lib/inventory.js → requiresStockGate; the local kitchen can't
 * conjure a batch for today's scooter run). The shop grid, the PDP, the
 * favourites page and the web storefront used to render the pill off the
 * product flag alone, so a customer with a 2 km Tianhe address was invited to
 * reserve items the checkout would then refuse. Every browse surface now folds
 * in the shopper's own delivery city and shows the dead SOLD OUT pill instead.
 *
 * Nothing here touches a network, a DB, or a real WeChat runtime: the mini-app
 * pages load under stubbed Page/wx/getApp, and shop.html's functions are lifted
 * out of the script block and run in a vm sandbox.
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

// A sold-out product the operator left reservable (the shop's PRE-ORDER row).
const SOLD_OUT_RESERVABLE = {
  id: 41, name_en: 'Beet Salad', name_cn: '甜菜沙拉', price: 48,
  stock: 0, oos_preorder: true,
};
// A sold-out product on the strict policy — dead everywhere, either way.
const SOLD_OUT_STRICT = {
  id: 42, name_en: 'Tabbouleh Bowl', name_cn: '塔博勒', price: 44,
  stock: 0, oos_preorder: false,
};

// ── Load a mini-app page module and hand back the object it passed to Page() ──
function loadMiniPage(relPath, wxOverrides) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {}, activeAddressId: null }, authReady: Promise.resolve() });
  g.wx = new Proxy(wxOverrides || {}, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'getStorageSync') return () => null;
      if (k === 'setStorageSync') return () => {};
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
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

// Run a handler with the WeChat globals in place. loadMiniPage only keeps them
// up during require(); a tap handler needs wx.showToast at call time too.
function withWx(fn) {
  const g = global;
  const saved = { wx: g.wx, getApp: g.getApp };
  g.wx = new Proxy({}, { get: () => () => {} });
  g.getApp = () => ({ globalData: { lang: 'en', activeAddressId: null }, authReady: Promise.resolve() });
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}

// Minimal setData: applies 'a.b' paths onto a plain object, like the real one.
function makeCtx(initial) {
  return {
    data: JSON.parse(JSON.stringify(initial)),
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split('.');
        let o = this.data;
        while (parts.length > 1) o = o[parts.shift()];
        o[parts[0]] = v;
      }
    },
  };
}

// ── The server's own verdict ────────────────────────────────────────────────
// The clients never re-implement the 广州 matcher — they read `same_city`,
// stamped on every saved address the customer gets back.
console.log('\nserver — same_city on the addresses the customer reads');
{
  const inventory = require(path.join(ROOT, 'lib/inventory.js'));
  const retailSrc = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

  it('a Guangzhou address is same-city, whichever field carries the city', () => {
    assert.strictEqual(inventory.isGuangzhouAddress({ city: '广州市', district: '天河区' }), true);
    assert.strictEqual(inventory.isGuangzhouAddress({ city: 'Guangzhou' }), true);
    // WeChat-imported addresses dump everything in the free-text blob.
    assert.strictEqual(inventory.isGuangzhouAddress({ address: '广州市天河区新塘大街7号' }), true);
  });
  it('an out-of-city address is not — that shopper may still pre-order', () => {
    assert.strictEqual(inventory.isGuangzhouAddress({ city: '上海市', district: '静安区' }), false);
    assert.strictEqual(inventory.isGuangzhouAddress({ city: 'Shenzhen' }), false);
    assert.strictEqual(inventory.isGuangzhouAddress(null), false);
  });
  it('both customer-facing address payloads are stamped', () => {
    assert.ok(/function stampSameCity\(rows\)/.test(retailSrc), 'stampSameCity exists');
    assert.ok(/r\.same_city = inventory\.isGuangzhouAddress\(r\)/.test(retailSrc),
      'the verdict comes from lib/inventory, not a second matcher');
    // GET /api/retail/addresses (mini app) + GET /api/retail/customer (web).
    const stamped = retailSrc.match(/stampSameCity\(/g) || [];
    assert.strictEqual(stamped.length, 3, 'declaration + both address payloads');
  });
}

// ── Mini-app shop grid ──────────────────────────────────────────────────────
console.log('\nmini-app shop — the PRE-ORDER pill (_toRows)');
{
  const page = loadMiniPage('miniapp/pages/shop/shop.js');
  const row = (product, sameCity) => {
    const ctx = makeCtx({ lang: 'en' });
    ctx._sameCity = sameCity;
    return page._toRows.call(ctx, [product], 'en')[0];
  };

  it('an out-of-city shopper still gets PRE-ORDER on a reservable row', () => {
    const r = row(SOLD_OUT_RESERVABLE, false);
    assert.strictEqual(r.preorder, true);
    assert.strictEqual(r.outOfStock, false, 'stays orderable — the + button lives');
  });
  it('a same-city shopper gets the dead SOLD OUT pill instead', () => {
    const r = row(SOLD_OUT_RESERVABLE, true);
    assert.strictEqual(r.preorder, false, 'never promises what checkout refuses');
    assert.strictEqual(r.outOfStock, true);
  });
  it('a strict sold-out row is dead for everyone', () => {
    for (const sameCity of [false, true]) {
      const r = row(SOLD_OUT_STRICT, sameCity);
      assert.strictEqual(r.preorder, false);
      assert.strictEqual(r.outOfStock, true);
    }
  });
  it('an in-stock row is untouched by the shopper’s city', () => {
    for (const sameCity of [false, true]) {
      const r = row({ ...SOLD_OUT_RESERVABLE, stock: 6 }, sameCity);
      assert.strictEqual(r.preorder, false);
      assert.strictEqual(r.outOfStock, false);
    }
  });
  it('a collapsed variant card reads its sizes the same way', () => {
    const members = [{ ...SOLD_OUT_RESERVABLE, id: 51 }, { ...SOLD_OUT_RESERVABLE, id: 52 }];
    const card = (sameCity) => {
      const ctx = makeCtx({ lang: 'en' });
      ctx._sameCity = sameCity;
      ctx._collapseVariants = page._collapseVariants;
      return page._toRows.call(ctx, [{ ...members[0], _members: members }], 'en')[0];
    };
    assert.strictEqual(card(false).preorder, true, 'every size reservable → PRE-ORDER');
    assert.strictEqual(card(true).preorder, false);
    assert.strictEqual(card(true).outOfStock, true);
  });
  it('a quick-add on a stale card is refused for a same-city shopper', () => {
    const ctx = makeCtx({ lang: 'en', _raw: [SOLD_OUT_RESERVABLE] });
    ctx._sameCity = true;
    let added = false;
    ctx._addRawToCart = () => { added = true; };
    withWx(() => page.addToCart.call(ctx, { currentTarget: { dataset: { id: SOLD_OUT_RESERVABLE.id } } }));
    assert.strictEqual(added, false, 'the tap must not slip a sold-out item into the cart');
  });
}

// ── Mini-app favourites ─────────────────────────────────────────────────────
console.log('\nmini-app favourites — same rule as the shop');
{
  const page = loadMiniPage('miniapp/pages/favorites/favorites.js');
  const tile = (sameCity) => {
    const ctx = makeCtx({
      lang: 'en', all: [SOLD_OUT_RESERVABLE], activeCat: 'All',
      copy: { catAll: 'ALL' },
    });
    ctx._sameCity = sameCity;
    page.rebuildView.call(ctx);
    return ctx.data.visible[0];
  };

  it('out-of-city: a sold-out favourite stays a PRE-ORDER tile', () => {
    assert.strictEqual(tile(false).preorder, true);
    assert.strictEqual(tile(false).soldOut, false);
  });
  it('same-city: it goes dead', () => {
    assert.strictEqual(tile(true).preorder, false);
    assert.strictEqual(tile(true).soldOut, true);
  });
  it('a same-city quick-add is refused', () => {
    const ctx = makeCtx({ lang: 'en', all: [SOLD_OUT_RESERVABLE], copy: { soldOut: 'SOLD OUT' } });
    ctx._sameCity = true;
    withWx(() => {
      const cart = require(path.join(ROOT, 'miniapp/utils/cart.js'));
      const before = cart.get().items.length;
      page.onQuickAdd.call(ctx, { currentTarget: { dataset: { id: SOLD_OUT_RESERVABLE.id } } });
      assert.strictEqual(cart.get().items.length, before, 'nothing was added');
    });
  });
}

// ── utils/delivery — which address the verdict comes from ───────────────────
console.log('\nmini-app utils/delivery — the active address decides');
{
  const delivery = require(path.join(ROOT, 'miniapp/utils/delivery.js'));
  const GZ  = { id: 1, is_default: true,  same_city: true };
  const SH  = { id: 2, is_default: false, same_city: false };

  it('unknown (nothing loaded) reads as out-of-city — the permissive default', () => {
    delivery.invalidate();
    assert.strictEqual(delivery.sameCity(), false);
    assert.strictEqual(delivery.preorderAllowed(), true);
  });
  it('the default address is the one that counts', () => {
    delivery.prime([GZ, SH]);
    assert.strictEqual(delivery.sameCity(), true);
    delivery.prime([{ ...GZ, is_default: false }, { ...SH, is_default: true }]);
    assert.strictEqual(delivery.sameCity(), false);
  });
  it('a checkout pick (activeAddressId) overrides the default', () => {
    const saved = global.getApp;
    global.getApp = () => ({ globalData: { activeAddressId: 2 } });
    try {
      delivery.prime([GZ, SH]);
      assert.strictEqual(delivery.sameCity(), false, 'the picked Shanghai address wins');
      global.getApp = () => ({ globalData: { activeAddressId: 1 } });
      assert.strictEqual(delivery.sameCity(), true);
    } finally {
      if (saved === undefined) delete global.getApp; else global.getApp = saved;
    }
  });
  it('an address book with no saved rows never blocks a pre-order', () => {
    delivery.prime([]);
    assert.strictEqual(delivery.sameCity(), false);
  });
  it('invalidate() drops the cache so the next load re-asks', () => {
    delivery.prime([GZ]);
    assert.strictEqual(delivery.sameCity(), true);
    delivery.invalidate();
    assert.strictEqual(delivery.sameCity(), false);
  });
}

// ── Web storefront ──────────────────────────────────────────────────────────
// shop.html is one big script block against a live DOM; lift the stock verdict
// out and run it against a stub `state`, same trick as test_address_clients.js.
console.log('\nweb storefront — stockState / slStock');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
  const grab = (name) => {
    const at = html.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} not found in shop.html`);
    const open = html.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) break; }
    }
    return html.slice(at, i + 1);
  };

  const sandbox = { state: { lang: 'en', customer: null }, console };
  vm.createContext(sandbox);
  vm.runInContext(
    [grab('oosBackorder'), grab('shopperSameCity'), grab('stockState'), grab('slStock')].join('\n'),
    sandbox,
  );
  const signIn = (sameCity) => {
    sandbox.state.customer = { addresses: [{ id: 1, is_default: true, same_city: sameCity }] };
  };
  const verdict = (p) => vm.runInContext('stockState(' + JSON.stringify(p) + ')', sandbox);
  const size    = (m) => vm.runInContext('slStock(' + JSON.stringify(m) + ')', sandbox);
  const BACKORDER = { id: 7, stock: 0, oos_policy: 'backorder_gz', oos_preorder: true };

  it('signed out → the old permissive behaviour (server still gates)', () => {
    sandbox.state.customer = null;
    assert.strictEqual(verdict(BACKORDER).soldOut, false);
    assert.strictEqual(size(BACKORDER).pre, true);
  });
  it('an out-of-city account keeps the "ships soon" badge', () => {
    signIn(false);
    const v = verdict(BACKORDER);
    assert.strictEqual(v.oos, true);
    assert.strictEqual(v.soldOut, false);
    assert.strictEqual(size(BACKORDER).pre, true);
  });
  it('a same-city account gets SOLD OUT on the card and a dead size row', () => {
    signIn(true);
    const v = verdict(BACKORDER);
    assert.strictEqual(v.soldOut, true);
    assert.strictEqual(v.badge, 'SOLD OUT');
    assert.strictEqual(size(BACKORDER).pre, false);
    assert.strictEqual(size(BACKORDER).soldOut, true);
  });
  it('in-stock and supplier-direct rows are unaffected', () => {
    signIn(true);
    assert.strictEqual(verdict({ ...BACKORDER, stock: 3 }).oos, false);
    assert.strictEqual(verdict({ ship_from_supplier: 1, stock: 0 }).soldOut, false);
  });

  // ── The mobile list/grid (slToRows) ───────────────────────────────────────
  // The mini-app-mirror layouts the web serves under 768px. They build their own
  // row objects rather than going through stockState(), which is how they kept
  // showing SHIPS SOON to a same-city shopper after the badge rule landed
  // everywhere else.
  console.log('\nweb storefront — mobile list/grid (slToRows)');
  vm.runInContext(
    [grab('pick'), grab('slMoney'), grab('slEff'), grab('slImg'), grab('slPickBadge'), grab('slToRows')].join('\n'),
    sandbox,
  );
  const row = (p) => vm.runInContext('slToRows([' + JSON.stringify(p) + '])', sandbox)[0];

  it('signed out → SHIPS SOON, exactly as before', () => {
    sandbox.state.customer = null;
    const r = row(BACKORDER);
    assert.strictEqual(r.nextBatch, true);
    assert.strictEqual(r.outOfStock, false, 'the + button still renders');
    assert.strictEqual(r.batchTxt, 'SHIPS SOON');
  });
  it('out-of-city keeps SHIPS SOON, and a batch meal keeps NEXT BATCH', () => {
    signIn(false);
    assert.strictEqual(row(BACKORDER).nextBatch, true);
    assert.strictEqual(row(BACKORDER).outOfStock, false);
    const batch = row({ ...BACKORDER, is_batch_made: 1 });
    assert.strictEqual(batch.nextBatch, true);
    assert.strictEqual(batch.batchTxt, 'NEXT BATCH');
  });
  it('same-city gets the dead SOLD OUT row, no + button', () => {
    signIn(true);
    const r = row(BACKORDER);
    assert.strictEqual(r.nextBatch, false, 'no SHIPS SOON badge');
    assert.strictEqual(r.outOfStock, true);
    assert.strictEqual(r.oosLabel, 'SOLD OUT', 'the page’s existing sold-out copy, not a new string');
    // The + renders only when neither flag is set (slRowHtml / slCardHtml).
    assert.strictEqual(!r.outOfStock && !r.nextBatch, false);
  });
  it('same-city: a batch meal goes dead too, no NEXT BATCH', () => {
    signIn(true);
    const r = row({ ...BACKORDER, is_batch_made: 1 });
    assert.strictEqual(r.nextBatch, false);
    assert.strictEqual(r.outOfStock, true);
  });
  it('a collapsed variant card follows its sizes', () => {
    const members = [{ ...BACKORDER, id: 71 }, { ...BACKORDER, id: 72 }];
    const card = { ...members[0], _members: members };
    signIn(false);
    assert.strictEqual(row(card).nextBatch, true);
    signIn(true);
    assert.strictEqual(row(card).nextBatch, false);
    assert.strictEqual(row(card).outOfStock, true);
  });
  it('in-stock and strict sold-out rows read the same in both cities', () => {
    for (const sameCity of [false, true]) {
      signIn(sameCity);
      const live = row({ ...BACKORDER, stock: 4 });
      assert.strictEqual(live.outOfStock, false);
      assert.strictEqual(live.nextBatch, false);
      const strict = row({ id: 8, stock: 0, oos_policy: 'strict' });
      assert.strictEqual(strict.outOfStock, true);
      assert.strictEqual(strict.nextBatch, false);
    }
  });
  it('the quick-add tap is refused for a same-city shopper', () => {
    // slAdd's guard is slStock(raw).soldOut — the same verdict the row renders.
    signIn(true);
    assert.strictEqual(size(BACKORDER).soldOut, true, 'slAdd would refuse');
    signIn(false);
    assert.strictEqual(size(BACKORDER).soldOut, false, 'out-of-city still adds');
    const src = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
    assert.ok(/if\(slStock\(raw\)\.soldOut\)\{toast\(/.test(src), 'the guard is wired into slAdd');
  });
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
