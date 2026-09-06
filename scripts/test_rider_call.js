#!/usr/bin/env node
/**
 * "Call rider" — the button, and the number behind it.
 *
 *   node scripts/test_rider_call.js
 *
 * A customer watching a Guangzhou order move across the map gets one control
 * that reaches the person carrying it: the button under the map on the order
 * status page, which opens the dialer on the Qingyun rider's number. Nothing
 * asserted that it appears — so when the payload that feeds it went out shaped
 * `rider: job.rider_name ? {...} : null`, a job Qingyun returned with a phone
 * and NO name rendered a live map with no way to phone anyone on it, on every
 * surface at once, silently.
 *
 * These probes hold the rule that fixes it: the NUMBER decides whether a
 * customer can call, the name is decoration. They cover the mini-app page end
 * to end (real page module, real view-model build, real tap handler) and then
 * assert the three call sites that cannot be required here — routes/retail.js
 * pulls in better-sqlite3, and m.html and the admin bundle are pages — against
 * their own source, which is the split scripts/test_recipient_phone.js uses.
 *
 * No DB, no network, no browser, no Qingyun account.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Load a mini-app page module and hand back the object it passed to Page() ──
// Same shape as the helper in test_preorder_local.js / test_address_clients.js.
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'getStorageSync') return () => null;
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

// Minimal setData — enough for the flat keys loadDeliveryTrack writes.
function makeCtx(initial) {
  return {
    data: Object.assign({ id: 77, lang: 'en', deliveryTrack: null }, initial),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

// Run something with the WeChat globals up — loadMiniPage only keeps them in
// place during require(), and callRider needs wx.makePhoneCall at CALL time.
function withWx(stub, fn) {
  const g = global;
  const saved = g.wx;
  g.wx = stub;
  try { return fn(); }
  finally { if (saved === undefined) delete g.wx; else g.wx = saved; }
}

const page = loadMiniPage('miniapp/pages/order/order.js');
const api = require('../miniapp/utils/api');

// A delivery-track payload the way the server sends it: rider en route, with
// whatever rider identity this case is about.
const track = (rider) => ({
  tracking: true, stage: 'in_transit', carrier: '青云聚信',
  rider,
  rider_position: { lat: 23.13, lng: 113.32 },
  shop_position: { lat: 23.12, lng: 113.30 },
  recipient_position: { lat: 23.14, lng: 113.34 },
  route: [], eta_seconds: 540, rider_to_cust_m: 1200,
});

// Drive the page's real loader against a stubbed api.get.
async function loadTrack(payload, ctx) {
  const saved = api.get;
  api.get = async () => ({ data: payload });
  try { await page.loadDeliveryTrack.call(ctx); }
  finally { api.get = saved; }
  return ctx.data.deliveryTrack;
}

(async () => {

  console.log('\nminiapp/pages/order — the number is what makes the button');

  {
    const t = await loadTrack(track({ name: 'Wang Lei', phone: '13800000000' }), makeCtx());
    it('a named rider with a number is callable', () => {
      assert.ok(t, 'expected a deliveryTrack');
      assert.strictEqual(t.rider.phone, '13800000000');
    });
    it('and their name reaches the sub-line', () => {
      assert.ok(t.subLine.includes('Wang Lei'), `sub-line was: ${t.subLine}`);
    });
  }

  {
    // The regression this suite exists for.
    const t = await loadTrack(track({ name: null, phone: '13800000000' }), makeCtx());
    it('A NAMELESS RIDER IS STILL CALLABLE', () => {
      assert.ok(t, 'expected a deliveryTrack');
      assert.ok(t.rider, 'rider object was dropped for want of a name');
      assert.strictEqual(t.rider.phone, '13800000000');
    });
    it('and the sub-line simply omits the name it does not have', () => {
      assert.ok(!/null|undefined/.test(t.subLine), `sub-line was: ${t.subLine}`);
    });
  }

  {
    const t = await loadTrack(track(null), makeCtx());
    it('no rider at all leaves nothing to call', () => {
      assert.ok(t, 'expected a deliveryTrack');
      assert.strictEqual(t.rider, null);
    });
  }

  {
    // A rider Qingyun names but gives no number for: the card still says who is
    // carrying the order, and the button must not offer a call it cannot place.
    const t = await loadTrack(track({ name: 'Wang Lei', phone: null }), makeCtx());
    it('a named rider with no number is not callable', () => {
      assert.ok(t.rider, 'expected the rider to survive for the sub-line');
      assert.strictEqual(t.rider.phone, null);
    });
  }

  console.log('\nminiapp/pages/order — tapping it dials');

  it('callRider places the call on the number in the payload', () => {
    const dialled = [];
    const ctx = makeCtx({ deliveryTrack: { rider: { name: null, phone: '13800000000' } } });
    withWx({ makePhoneCall: (o) => dialled.push(o.phoneNumber) },
      () => page.callRider.call(ctx));
    assert.deepStrictEqual(dialled, ['13800000000']);
  });

  it('and dials nothing when there is no number', () => {
    const dialled = [];
    const ctx = makeCtx({ deliveryTrack: { rider: { name: 'Wang Lei', phone: null } } });
    withWx({ makePhoneCall: (o) => dialled.push(o.phoneNumber) },
      () => page.callRider.call(ctx));
    assert.deepStrictEqual(dialled, []);
  });

  console.log('\nminiapp/pages/order — the button is gated on the phone, not the name');

  {
    const wxml = read('miniapp/pages/order/order.wxml');
    it('the button renders on deliveryTrack.rider.phone', () => {
      assert.ok(
        /wx:if="\{\{deliveryTrack\.rider && deliveryTrack\.rider\.phone\}\}"/.test(wxml),
        'the call button is no longer gated on the rider phone'
      );
    });
    it('and taps through to callRider', () => {
      assert.ok(/bindtap="callRider"/.test(wxml), 'callRider is not bound to the button');
    });
  }

  console.log('\nroutes/retail.js — both rider payloads carry a nameless rider');

  {
    const src = read('routes/retail.js');
    it('no rider payload is gated on the name alone', () => {
      assert.ok(
        !/rider: job\.rider_name \?/.test(src),
        'a rider payload still drops the phone number when the name is missing'
      );
    });
    it('both of them build on name OR phone', () => {
      const n = (src.match(/rider: \(job\.rider_name \|\| job\.rider_phone\)/g) || []).length;
      // The track endpoint's payload and the order row's o.courier twin. If this
      // count moves, a third one appeared — give it the same shape.
      assert.strictEqual(n, 2, `expected 2 rider shapings, found ${n}`);
    });
  }

  console.log('\nthe other two surfaces that hang off the same object');

  it('m.html shows the call link on a number, name or no name', () => {
    const src = read('public/m.html');
    assert.ok(
      /\$\{\(name\|\|phone\)\?`<div/.test(src),
      "the storefront's rider row is gated on the name again"
    );
  });

  it('the admin drawer renders name and number independently', () => {
    const src = read('public/retail-admin/04-orders.js');
    assert.ok(/if \(c\.rider && c\.rider\.phone\) riderBits\.push/.test(src),
      'the drawer no longer renders the number independently of the name');
    assert.ok(!/<b>\$\{escapeHtml\(c\.rider\.name\)\}<\/b>\$\{c\.rider\.phone/.test(src),
      'the drawer is back to assuming a rider always has a name');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
