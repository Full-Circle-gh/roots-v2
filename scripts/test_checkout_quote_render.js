#!/usr/bin/env node
/**
 * A Shenzhen checkout can place the order.
 *
 *   node scripts/test_checkout_quote_render.js
 *
 * Reported from an iPhone, English UI, one Buckwheat Bread at ¥15.00, address
 * in Shenzhen · Longgang. The When section read "Couldn't load delivery times
 * — tap to retry", Place Order toasted "Please pick a delivery time", and the
 * pay button said ¥442.00.
 *
 * The quote had succeeded. The server repriced the line to ¥15 and sent a
 * day-only express slot (Shenzhen is outside Guangzhou). Drawing that slot
 * called toLocaleDateString(locale, options). WeChat's iOS JavaScriptCore
 * throws there — Intl.DateTimeFormat is absent — and the quote's catch treated
 * the throw as a failed quote: slots cleared, pay button restored to the cart
 * total captured before the reprice. There was then no time to pick, so the
 * order could not be placed.
 *
 * A discount below zero takes the same path to a wrong total. Number(-427) || 0
 * stays -427, and subtotal minus that number is a larger bill.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CHECKOUT = path.join(ROOT, 'miniapp/pages/checkout/checkout.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}
async function itAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}
const section = (t) => console.log('\n' + t);

const mem = {};
const toasts = [];
function installWx() {
  global.wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
    showToast: (o) => { toasts.push(o && o.title); },
    showModal() {},
    pageScrollTo() {},
    getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 20, platform: 'ios' }),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxtest' } }),
    getDeviceInfo: () => ({}),
    getAppBaseInfo: () => ({}),
  };
  global.getApp = () => ({ globalData: { lang: 'en', customer: {}, token: '' }, authReady: Promise.resolve() });
  global.getCurrentPages = () => [{ route: 'pages/checkout/checkout' }];
}

function loadCheckoutPage() {
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  let captured = null;
  g.Page = (o) => { captured = o; return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {}, activeAddressId: null }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, { get: () => () => ({}) });
  try {
    delete require.cache[require.resolve(CHECKOUT)];
    require(CHECKOUT);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
  return captured;
}

installWx();
const lang = require(path.join(ROOT, 'miniapp/utils/lang'));
const cart = require(path.join(ROOT, 'miniapp/utils/cart'));
const api = require(path.join(ROOT, 'miniapp/utils/api'));
const page = loadCheckoutPage();
installWx();

function instance() {
  const inst = Object.create(page);
  inst.data = Object.assign({}, page.data, {
    lang: 'en',
    fulfillment: 'delivery',
    isBound: true,
    address: {
      id: 7,
      recipient_name: '纳斯Naz',
      phone: '17157555761',
      address: '坂田街道佳兆业中央广场一期3B座 4201',
      city: 'Shenzhen',
      district: 'Longgang',
      province: 'Guangdong',
    },
    quoteFailed: false,
    scheduling: null,
    deliverySlotId: '',
    selectedSlotKind: '',
    voucherDiscount: 0,
    voucherCode: '',
    autoVoucher: null,
    usePoints: false,
    useBalance: false,
    sameCityRider: false,
    riderPhoneWarn: false,
  });
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  inst.offerPick = function () {};
  return inst;
}

function expressSlot() {
  return {
    slot_id: '2026-11-12',
    date_iso: '2026-11-12',
    is_same_day: false,
    is_day_only: true,
    requires_surcharge: false,
    surcharge: 0,
    label_en: 'Earliest 2026-11-12',
    label_cn: '最早 2026-11-12',
  };
}

function quotePayload() {
  const slot = expressSlot();
  return {
    subtotal: 15,
    lines: [{
      product_id: 252,
      choice_ids: [9],
      unit_price: 15,
      is_flash: false,
      regular_price: null,
    }],
    delivery_fee: 12,
    packing_fee: 0,
    free_shipping: false,
    scheduling: {
      mode: 'day_only',
      right_away_available: false,
      same_day_surcharge: 0,
      slots: [slot],
      express_slot: Object.assign({}, slot),
      schedule: { min_date: '2026-11-14', max_date: '2026-11-24' },
      kitchen_hours: { start: 10, end: 20 },
      slot_duration_minutes: 120,
    },
  };
}

section('1 · iOS WECHAT THROWS ON toLocaleDateString — THE QUOTE STILL LANDS');

const SRC = fs.readFileSync(CHECKOUT, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

it('checkout no longer calls toLocaleDateString', () => {
  assert.ok(!/\.toLocaleDateString\s*\(/.test(CODE),
    'iOS WeChat throws on toLocaleDateString(locale, options); checkout must format the day itself');
});

it('a number or an object handed to lang.pick does not throw', () => {
  assert.strictEqual(lang.pick(15, null, 'en'), '15');
  assert.strictEqual(lang.pick(0, '荞麦', 'en'), '荞麦');
  assert.strictEqual(lang.pick({ en: 'x' }, '荞麦', 'cn'), '荞麦');
  assert.strictEqual(lang.pick(['a'], '', 'en'), '');
  assert.strictEqual(lang.pick(null, undefined, 'en'), '');
});

it('a slot with no label does not throw while grouping', () => {
  const inst = instance();
  const groups = inst.buildSlotGroups({
    mode: 'day_only',
    slots: [{ slot_id: '2026-11-12', date_iso: '2026-11-12', label_en: null, label_cn: null, surcharge: 0 }],
  });
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].slots[0].chip_label, '');
});

it('the express day reads Thu, Nov 12 / 11月12日 with Intl throwing', () => {
  const orig = Date.prototype.toLocaleDateString;
  let calls = 0;
  Date.prototype.toLocaleDateString = function () {
    calls++;
    throw new TypeError('Intl.DateTimeFormat is not a function');
  };
  try {
    const inst = instance();
    inst.data.scheduling = { express_slot: expressSlot() };
    const slot = inst.prettyExpressSlot();
    assert.strictEqual(slot.label_en, 'Thu, Nov 12');
    assert.strictEqual(slot.label_cn, '11月12日');
    assert.strictEqual(calls, 0);
  } finally {
    Date.prototype.toLocaleDateString = orig;
  }
});

(async () => {
  const orig = Date.prototype.toLocaleDateString;
  let localeCalls = 0;
  Date.prototype.toLocaleDateString = function () {
    localeCalls++;
    throw new TypeError('Intl.DateTimeFormat is not a function');
  };
  const realPost = api.post;
  let quotes = 0;
  api.post = (url) => {
    if (String(url).indexOf('/quote') >= 0) {
      quotes++;
      return Promise.resolve(quotePayload());
    }
    return Promise.resolve({ data: [] });
  };
  try {
    cart.clear();
    cart.add({
      id: 252,
      name_en: 'Buckwheat Bread (GF, Sliced & Frozen)',
      name_cn: '冷冻切片无麸质荞麦面包',
      price: 442,
      effective_price: 442,
    }, 1, [{ option_id: 1, choice_id: 9, question: 'Heat up?', label: "Don't heat up", delta: 0 }]);

    const inst = instance();
    await inst.refreshQuote();
    // applyDayOnlySlot re-quotes. Let that second pass finish.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await itAsync('the day-only quote keeps its slot and the server total', async () => {
      assert.ok(quotes >= 1, 'the quote was sent');
      assert.strictEqual(localeCalls, 0);
      assert.strictEqual(inst.data.quoteFailed, false);
      assert.ok(inst.data.scheduling && inst.data.scheduling.mode === 'day_only');
      assert.strictEqual(inst.data.deliverySlotId, '2026-11-12');
      assert.strictEqual(inst.data.selectedSlotKind, 'express');
      assert.strictEqual(inst.data.deliverySlotLabel, 'Thu, Nov 12');
      assert.strictEqual(inst.data.items[0].line_total, '¥15.00');
      assert.strictEqual(inst.data.total, '27.00');
      assert.notStrictEqual(inst.data.total, '442.00');
    });

    await itAsync('Place Order is not asking for a time that is missing', async () => {
      toasts.length = 0;
      // A failed quote leaves no slot. The toast is the retry line, and the
      // quote is asked again — there is nothing on screen to pick.
      inst.data.quoteFailed = true;
      inst.data.deliverySlotId = '';
      inst.data.scheduling = null;
      const before = quotes;
      await inst.placeOrder();
      assert.strictEqual(toasts[0], inst.data.copy.quoteFailed);
      assert.ok(quotes > before, 'tapping Place Order retries the quote');
      assert.ok(!toasts.includes('Please pick a delivery time'));
    });

    await itAsync('a loaded quote with no pick still asks for a time', async () => {
      toasts.length = 0;
      inst.data.quoteFailed = false;
      inst.data.deliverySlotId = '';
      inst.data.scheduling = { mode: 'day_only', slots: [] };
      await inst.placeOrder();
      assert.strictEqual(toasts[0], 'Please pick a delivery time');
    });
  } finally {
    Date.prototype.toLocaleDateString = orig;
    api.post = realPost;
    cart.clear();
  }

  section('2 · A NEGATIVE DISCOUNT CANNOT TURN ¥15 INTO ¥442');

  it('money off a negative voucher is zero', () => {
    cart.clear();
    cart.add({ id: 1, name_en: 'Bread', name_cn: '面包', price: 15 }, 1, []);
    const inst = instance();
    inst.data.voucherDiscount = -427;
    // The argument is the stale pre-request subtotal. The lines are ¥15.
    inst.applyQuoteFallback(442, true);
    assert.strictEqual(inst.data.quoteFailed, true);
    assert.strictEqual(inst.data.total, '15.00');
    cart.clear();
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
