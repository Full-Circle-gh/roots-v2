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

// ── The server's own verdicts ───────────────────────────────────────────────
// The clients never re-implement either question — they read the two flags
// stamped on every saved address the customer gets back: `same_city` (plain
// geography) and `local_run` (would this order ride the same-day local run).
// The pill wants the second one; reading the first is what took the pre-order
// away from the outer ship-districts.
console.log('\nserver — same_city / local_run on the addresses the customer reads');
{
  const inventory = require(path.join(ROOT, 'lib/inventory.js'));
  const { stampSameCity } = require(path.join(ROOT, 'routes/retail.js'));
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

  it('local_run is stamped beside same_city, and answers a different question', () => {
    const [core, ship, away] = stampSameCity([
      { id: 1, city: '广州市', district: '天河区' },   // core GZ — on the run
      { id: 2, city: '广州市', district: '花都区' },   // ship-district — not on it
      { id: 3, city: '上海市', district: '静安区' },   // out-of-city
    ]);
    assert.deepStrictEqual(
      { same_city: core.same_city, local_run: core.local_run }, { same_city: true, local_run: true });
    assert.deepStrictEqual(
      { same_city: ship.same_city, local_run: ship.local_run }, { same_city: true, local_run: false },
      '花都 is same-city AND keeps its pre-order');
    assert.deepStrictEqual(
      { same_city: away.same_city, local_run: away.local_run }, { same_city: false, local_run: false });
  });
  it('the two flags come from lib/inventory, not from new matchers', () => {
    const fn = retailSrc.slice(retailSrc.indexOf('function stampSameCity'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/r\.local_run = r\.same_city && !inventory\.isOptInSameDayDistrict\(r\)/.test(body),
      'the run verdict is the zone question, asked only of Guangzhou addresses');
    assert.ok(!/广州/.test(body), 'no city string of its own');
  });
  it('both clients read local_run for the pill', () => {
    const util = fs.readFileSync(path.join(ROOT, 'miniapp/utils/delivery.js'), 'utf8');
    assert.ok(/return !!\(r && r\.local_run\);/.test(util), 'mini app');
    assert.ok(!/r\.same_city/.test(util), 'and no longer the city one');
    const web = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
    assert.ok(/return !!\(a&&a\.local_run\);/.test(web), 'web storefront');
  });
}

// ── The order path ──────────────────────────────────────────────────────────
// The browse surfaces stopped offering a local shopper a pre-order; this is the
// gate that stops the server accepting one however the request arrived. The
// rule has no delivery-day term: requiresStockGate goes false for a scheduled
// day and used to let the line through unreserved, which is the hole.
console.log('\nserver — the local pre-order gate (localPreorderLine)');
{
  const inventory = require(path.join(ROOT, 'lib/inventory.js'));
  const { localPreorderLine } = require(path.join(ROOT, 'routes/retail.js'));
  const retailSrc = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

  // Core Guangzhou: always on the local run, whatever day is picked.
  const GZ = { city: '广州市', district: '天河区', address: '新塘大街7号' };
  // An outer "ship-district": a Guangzhou address that ships by courier from
  // the out-of-city warehouse on the batch cadence unless the shopper buys the
  // same-day extra. 花都区 is the zone the shipping_spec_alignment_v1 migration
  // seeds (day_only=1, ¥30 same-day surcharge).
  const HD = { city: '广州市', district: '花都区', address: '新华街道1号' };
  const SH = { city: '上海市', district: '静安区', address: '南京西路1号' };
  // Order lines as POST /api/retail/orders resolves them: the product row
  // carries the policy columns and `real_stock`, the per-store sellable SUM.
  const line = (over) => ({
    qty: 1,
    product: { id: 41, name_en: 'Beet Salad', oos_policy: 'backorder_gz', real_stock: 0, ...over },
  });
  // Both slot ids the gate must be blind to. 'right_away' is same-day;
  // a dated slot far enough out is not.
  const SAME_DAY = 'right_away';
  const FUTURE   = '2099-01-01T10:00';

  it('the two delivery days really do differ to requiresStockGate', () => {
    // Guard on the premise: if this ever stops being true, the gate below is
    // testing nothing (and the hole it plugs would have closed by itself).
    assert.strictEqual(inventory.requiresStockGate({ address: GZ, deliverySlotId: SAME_DAY }), true);
    assert.strictEqual(inventory.requiresStockGate({ address: GZ, deliverySlotId: FUTURE }), false);
  });

  it('core Guangzhou + sold out + same day → refused', () => {
    const hit = localPreorderLine([line()], GZ);
    assert.ok(hit, 'the line is blocked');
    assert.strictEqual(hit.product.id, 41);
  });
  it('core Guangzhou + sold out + future day → refused just the same', () => {
    // The gate takes no slot at all for a core-GZ address — that is the point.
    // Same call, same verdict, whichever day the customer picked.
    assert.ok(localPreorderLine([line()], GZ), 'a scheduled day buys no stock');
  });
  it('out-of-city + future day → still allowed, pre-order untouched', () => {
    assert.strictEqual(localPreorderLine([line()], SH), null);
  });
  it('out-of-city + same day → also untouched (this gate is local-only)', () => {
    assert.strictEqual(localPreorderLine([line()], SH), null);
  });

  // ── Ship-districts (花都/番禺/南沙/从化/增城) ────────────────────────────────
  // Guangzhou addresses that are NOT on the local run by default: without the
  // same-day extra their parcel leaves the out-of-city warehouse on the batch
  // cadence, the same fulfilment that makes a pre-order safe for Shanghai.
  it('the zone data really does separate a ship-district from core GZ', () => {
    // The input the whole narrowing rests on. 花都区 carries day_only=1 +
    // a same-day surcharge; 天河区 is an always-same-day district (no opt-in
    // row), so it reads false either way.
    assert.strictEqual(inventory.isOptInSameDayDistrict(HD), true);
    assert.strictEqual(inventory.isOptInSameDayDistrict(GZ), false);
    // Both are still Guangzhou — the narrowing is not a second city matcher.
    assert.strictEqual(inventory.isGuangzhouAddress(HD), true);
  });
  it('ship-district + sold out + future day → allowed', () => {
    assert.strictEqual(localPreorderLine([line()], HD, { scheduledShipDistrict: true }), null,
      'ships by courier on the batch cadence — a pre-order is safe');
  });
  it('ship-district + same-day extra + sold out → refused', () => {
    // Buying the extra puts them back on the local run, so the rule applies.
    const hit = localPreorderLine([line()], HD, { scheduledShipDistrict: false });
    assert.ok(hit, 'same-day in a ship-district is still same-day local');
    assert.strictEqual(hit.product.id, 41);
  });
  it('the flag alone never rescues an out-of-run shopper by accident', () => {
    // Out-of-city is already allowed; the flag changes nothing there.
    assert.strictEqual(localPreorderLine([line()], SH, { scheduledShipDistrict: true }), null);
    // …and it cannot be used to wave through a core-GZ order, because the
    // route only ever sets it when isOptInSameDayDistrict says so (asserted
    // against the source below).
    assert.ok(localPreorderLine([line()], GZ, {}), 'default is the strict answer');
  });
  it('the order path computes that flag from the zone and the slot kind', () => {
    assert.ok(/const scheduledShipDistrict =\s*\n\s*inGz &&\s*\n\s*inventory\.isOptInSameDayDistrict\(address\) &&\s*\n\s*!pickedSameDay;/.test(retailSrc),
      'Guangzhou AND an opt-in district AND they did not buy same-day');
    assert.ok(/const pickedSameDay = body\.delivery_slot_kind === 'today';/.test(retailSrc),
      'the same-day extra is the explicit "today" slot kind the client sends');
    assert.ok(/localPreorderLine\(mutatedItems, address, \{ scheduledShipDistrict \}\)/.test(retailSrc),
      'and the gate is handed that one verdict');
    // One expression in the order path, two consumers: the pre-order gate and
    // the out-of-city store pin (which also stamps the routing reason).
    const orderPath = retailSrc.slice(retailSrc.indexOf('router.post(\'/api/retail/orders\''));
    const uses = (orderPath.slice(0, orderPath.indexOf('\n  // Stock-shortage warning')).match(/scheduledShipDistrict/g) || []);
    assert.strictEqual(uses.length, 5, 'one declaration, the gate, the pin, its routing reason, one pointer comment');
  });

  it('a local shopper keeps buying what is in stock', () => {
    assert.strictEqual(localPreorderLine([line({ real_stock: 5 })], GZ), null);
    // Short by one still blocks — the test is availability vs qty, not zero.
    assert.strictEqual(localPreorderLine([{ ...line({ real_stock: 1 }), qty: 2 }], GZ).product.id, 41);
  });
  it('untracked stock (null) is treated as available, as everywhere else', () => {
    assert.strictEqual(localPreorderLine([line({ real_stock: null })], GZ), null);
  });
  it('strict and always are not this gate’s business', () => {
    // 'strict' is already refused for everyone by the hard OOS gate above it;
    // 'always' (supplier-direct) holds no stock of ours.
    assert.strictEqual(localPreorderLine([line({ oos_policy: 'strict' })], GZ), null);
    assert.strictEqual(localPreorderLine([line({ oos_policy: 'always' })], GZ), null);
    assert.strictEqual(localPreorderLine([line({ oos_policy: null, ship_from_supplier: 1 })], GZ), null);
  });
  it('a legacy batch meal with no explicit policy is still caught', () => {
    // Blank policy + is_batch_made=1 resolves to backorder_gz (effectiveOosPolicy).
    assert.ok(localPreorderLine([line({ oos_policy: null, is_batch_made: 1 })], GZ));
    // …and a blank policy without the flag resolves to strict, so not here.
    assert.strictEqual(localPreorderLine([line({ oos_policy: null })], GZ), null);
  });
  it('one bad line in a full basket is enough, and it names that line', () => {
    const basket = [line({ id: 10, real_stock: 9 }), line({ id: 11 }), line({ id: 12, real_stock: 3 })];
    assert.strictEqual(localPreorderLine(basket, GZ).product.id, 11);
  });
  it('an empty or malformed line set never throws', () => {
    assert.strictEqual(localPreorderLine([], GZ), null);
    assert.strictEqual(localPreorderLine(null, GZ), null);
    assert.strictEqual(localPreorderLine([{}, null], GZ), null);
  });

  it('the gate is wired into the order path, on the final line set', () => {
    assert.ok(/const localPre = localPreorderLine\(mutatedItems, address, \{ scheduledShipDistrict \}\);/.test(retailSrc),
      'runs on mutatedItems, so cancel_missing / replace_missing still work');
    assert.ok(/if \(!isPickup && fallbackChoice !== 'wait_for_restock'\) \{/.test(retailSrc),
      'pickup and the explicit wait-for-restock choice stay exempt');
    // The error must be one the checkout UI already handles — the same code a
    // sold-out 'strict' line returns today.
    const block = retailSrc.slice(retailSrc.indexOf('const localPre = localPreorderLine'));
    assert.ok(/error: 'insufficient_stock'/.test(block.slice(0, 400)), 'reuses insufficient_stock');
  });
  it('the gate reuses the one matcher, and adds no second one', () => {
    assert.ok(/function localPreorderLine\(lines, address, \{ scheduledShipDistrict = false \} = \{\}\) \{\s*\n\s*if \(!inventory\.isGuangzhouAddress\(address\)\) return null;\s*\n\s*if \(scheduledShipDistrict\) return null;/.test(retailSrc),
      'Guangzhou comes from lib/inventory, like stampSameCity, then the run narrows it');
    // Every same-city verdict in this file defers to lib/inventory — no local
    // copy of the 广州 matcher anywhere, including inside the new gate.
    const all      = (retailSrc.match(/isGuangzhouAddress\(/g) || []).length;
    const deferred = (retailSrc.match(/inventory\.isGuangzhouAddress\(/g) || []).length;
    assert.strictEqual(all, deferred, 'no locally-defined isGuangzhouAddress');
    const fn = retailSrc.slice(retailSrc.indexOf('function localPreorderLine'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(!/广州/.test(body) && !/['"`]guangzhou['"`]/i.test(body),
      'the gate compares no city string of its own — it just calls the matcher');
  });
  it('checkout stops promising "ships soon" to a local shopper', () => {
    const fn = retailSrc.slice(retailSrc.indexOf('function computePreorderNotice'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/if \(inventory\.isGuangzhouAddress\(address\)\) \{/.test(body),
      'the banner would advertise a checkout that now refuses');
    // …but a ship-district shopper still gets it: same narrowing as the gate,
    // so the banner and the checkout agree about who is on the local run.
    assert.ok(/inventory\.isOptInSameDayDistrict\(address\) && slotKind !== 'today'/.test(body),
      'the notice keeps its ship-district audience');
    assert.ok(/computePreorderNotice\(zone, address, \(items \|\| \[\]\)\.map\(\(i\) => i\.product_id\), body\.delivery_slot_id, body\.slot_kind\)/.test(retailSrc),
      'the quote passes the slot kind it already passes to computeBatchNotice');
    // The day term is gone: a Guangzhou customer on a future day used to get
    // the notice, and that is exactly the shopper the gate turns away. Judge
    // the code, not the comment that explains the removal.
    const code = body.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/requiresStockGate/.test(code), 'no day-dependent escape hatch left');
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
  // The pill reads local_run, not same_city: a 花都 address is same-city and
  // still ships on the batch cadence, so it keeps its pre-order.
  const GZ  = { id: 1, is_default: true,  local_run: true,  same_city: true };
  const SH  = { id: 2, is_default: false, local_run: false, same_city: false };
  const HD  = { id: 3, is_default: true,  local_run: false, same_city: true };

  it('unknown (nothing loaded) reads as off the run — the permissive default', () => {
    delivery.invalidate();
    assert.strictEqual(delivery.onLocalRun(), false);
    assert.strictEqual(delivery.preorderAllowed(), true);
  });
  it('the default address is the one that counts', () => {
    delivery.prime([GZ, SH]);
    assert.strictEqual(delivery.onLocalRun(), true);
    delivery.prime([{ ...GZ, is_default: false }, { ...SH, is_default: true }]);
    assert.strictEqual(delivery.onLocalRun(), false);
  });
  it('a checkout pick (activeAddressId) overrides the default', () => {
    const saved = global.getApp;
    global.getApp = () => ({ globalData: { activeAddressId: 2 } });
    try {
      delivery.prime([GZ, SH]);
      assert.strictEqual(delivery.onLocalRun(), false, 'the picked Shanghai address wins');
      global.getApp = () => ({ globalData: { activeAddressId: 1 } });
      assert.strictEqual(delivery.onLocalRun(), true);
    } finally {
      if (saved === undefined) delete global.getApp; else global.getApp = saved;
    }
  });
  it('an address book with no saved rows never blocks a pre-order', () => {
    delivery.prime([]);
    assert.strictEqual(delivery.onLocalRun(), false);
  });
  it('a ship-district address keeps its pre-order — same city, not the run', () => {
    delivery.prime([HD]);
    assert.strictEqual(delivery.onLocalRun(), false, '花都 ships on the batch cadence');
    assert.strictEqual(delivery.preorderAllowed(), true);
  });
  it('the cache stores the run verdict, not the city one', () => {
    // A row that is same_city but not local_run must NOT read as on the run —
    // this is the over-restriction the ship-districts were under.
    delivery.prime([{ id: 9, is_default: true, same_city: true, local_run: false }]);
    assert.strictEqual(delivery.onLocalRun(), false);
  });
  it('invalidate() drops the cache so the next load re-asks', () => {
    delivery.prime([GZ]);
    assert.strictEqual(delivery.onLocalRun(), true);
    delivery.invalidate();
    assert.strictEqual(delivery.onLocalRun(), false);
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
  // signIn(true) = an address on the same-day local run (core Guangzhou);
  // signIn(false) = anything else — out-of-city, or a ship-district on the
  // batch cadence. The page reads the server's local_run stamp.
  const signIn = (onLocalRun) => {
    sandbox.state.customer = { addresses: [{ id: 1, is_default: true, local_run: onLocalRun, same_city: true }] };
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
