#!/usr/bin/env node
/**
 * The delivery photo through the real routes (§261): staff put it on, the
 * customer whose order it is sees it, and nobody else does.
 *
 *   node scripts/test_delivery_photo_routes.js
 *
 * scripts/test_delivery_photo.js proves the rules in lib/delivery-photo.js and
 * reads the route source. This drives routes/retail.js over HTTP, because the
 * one thing that must never break — a stranger's login, or none, opening
 * somebody's front door — is only proven by asking the server.
 *
 * Runs against the local tenant database the way test_manual_restock_park.js
 * does, on fixtures in the 74xx block, and removes them after.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const OWNER    = 7401;   // the customer whose order it is
const STRANGER = 7402;   // another logged-in customer
const { testOperator } = require('./lib/test-operator');
// The suite's own operator, made and removed by the suite — see scripts/lib/test-operator.js.
const op = testOperator(99861, '__op_delivery_photo_routes');
const OPERATOR = op.id;      // tenant_users row the suite acts as
const T_OWNER    = 'dphtestowner7401';
const T_STRANGER = 'dphteststranger7402';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('a photo of a door').toString('base64');
const PNG  = 'data:image/png;base64,'  + Buffer.from('a better photo').toString('base64');

function orderIds() {
  return db.prepare('SELECT id FROM retail_orders WHERE customer_id IN (?,?) OR order_no LIKE ?')
    .all(OWNER, STRANGER, 'DPH%').map(r => r.id);
}
function cleanup() {
  op.remove();
  const oids = orderIds();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_delivery_photos', 'retail_rider_photos', 'retail_shipments', 'retail_order_items']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); }
      catch (e) { /* a table this checkout does not have yet — nothing to remove */ }
    }
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id IN (?,?)').run(OWNER, STRANGER);
  db.prepare('DELETE FROM retail_customers   WHERE id IN (?,?)').run(OWNER, STRANGER);
}
let nextNo = 0;
function makeOrder(status, { customer = OWNER, ft = 'delivery', mode = 'local' } = {}) {
  const info = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, fulfillment_type,
                                subtotal, total, channel)
     VALUES (?,?,?,'wechat',?,100,100,'wechat')`
  ).run('DPH' + String(++nextNo).padStart(5, '0'), customer, status, ft);
  if (mode) db.prepare('INSERT INTO retail_shipments (order_id, mode) VALUES (?,?)').run(info.lastInsertRowid, mode);
  return Number(info.lastInsertRowid);
}
function seed() {
  cleanup();
  const c = db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`);
  c.run(OWNER, 'Photo Owner', '13900007401', 'dev:dph-owner');
  c.run(STRANGER, 'Photo Stranger', '13900007402', 'dev:dph-stranger');
  const t = db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))");
  t.run(T_OWNER, OWNER);
  t.run(T_STRANGER, STRANGER);
}

(async () => {
  seed();
  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { body, token } = {}) => fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  try {
    console.log('\n── Staff put a photo on a delivered same-city order');
    const a = makeOrder('delivered');
    const up = await call('POST', `/api/retail-admin/orders/${a}/delivery-photo`, { body: { data: JPEG } });
    it('the upload is accepted', () => assert.strictEqual(up.status, 200, JSON.stringify(up.body)));
    it('and the answer carries no bytes', () => assert.ok(!('data' in (up.body?.data || {}))));

    const drawer = await call('GET', `/api/retail-admin/orders/${a}`);
    it('the drawer read shows the slot, filled, customer-visible, without the bytes', () => {
      const p = drawer.body?.data?.delivery_photo;
      assert.ok(p, JSON.stringify(drawer.body?.data && Object.keys(drawer.body.data)));
      assert.strictEqual(p.has, true);
      assert.strictEqual(p.customer_sees, true);
      assert.ok(!('data' in p));
    });

    console.log('\n── Who can open it');
    const own = await call('GET', `/api/retail/orders/${a}/delivery-photo`, { token: T_OWNER });
    it('the customer whose order it is gets the picture', () => {
      assert.strictEqual(own.status, 200);
      assert.strictEqual(own.body?.data?.data, JPEG);
    });
    const other = await call('GET', `/api/retail/orders/${a}/delivery-photo`, { token: T_STRANGER });
    it('another logged-in customer gets 404, not the picture', () => {
      assert.strictEqual(other.status, 404);
      assert.ok(!JSON.stringify(other.body).includes('base64'));
    });
    const anon = await call('GET', `/api/retail/orders/${a}/delivery-photo`);
    it('nobody logged in gets 401', () => assert.strictEqual(anon.status, 401));

    const detail = await call('GET', `/api/retail/orders/${a}`, { token: T_OWNER });
    it("the customer's order read says there is a photo, and carries no bytes", () => {
      assert.strictEqual(detail.status, 200);
      assert.strictEqual(detail.body?.data?.delivery_photo?.has, true);
      assert.ok(!JSON.stringify(detail.body.data.delivery_photo).includes('base64'));
    });

    console.log('\n── Replace and remove');
    await call('POST', `/api/retail-admin/orders/${a}/delivery-photo`, { body: { data: PNG } });
    const own2 = await call('GET', `/api/retail/orders/${a}/delivery-photo`, { token: T_OWNER });
    it('a second upload replaces the first', () => assert.strictEqual(own2.body?.data?.data, PNG));
    it('one row, not two', () => assert.strictEqual(
      db.prepare('SELECT COUNT(*) n FROM retail_delivery_photos WHERE order_id = ?').get(a).n, 1));
    const del = await call('DELETE', `/api/retail-admin/orders/${a}/delivery-photo`);
    const gone = await call('GET', `/api/retail/orders/${a}/delivery-photo`, { token: T_OWNER });
    it('remove takes it off for the customer too', () => {
      assert.strictEqual(del.status, 200);
      assert.strictEqual(gone.status, 404);
    });

    console.log("\n── The rider's photos beside the shop's (§261 addendum)");
    // Rows as lib/rider-photos.js leaves them once fetched; the fetch itself is
    // covered by test_rider_photos.js, so the rows are written straight in here.
    const c = makeOrder('delivered');
    const riderRow = db.prepare(
      `INSERT INTO retail_rider_photos (order_id, qingyun_order_id, position, token, status, data, bytes, fetched_at)
       VALUES (?,?,?,?, 'ok', ?, ?, CURRENT_TIMESTAMP)`);
    const R1 = 'data:image/jpeg;base64,' + Buffer.from('rider one').toString('base64');
    const R2 = 'data:image/jpeg;base64,' + Buffer.from('rider two').toString('base64');
    riderRow.run(c, 'DPHQY1', 0, 'tok-a', R1, R1.length);
    riderRow.run(c, 'DPHQY1', 1, 'tok-b', R2, R2.length);
    await call('POST', `/api/retail-admin/orders/${c}/delivery-photo`, { body: { data: JPEG } });

    const cd = await call('GET', `/api/retail/orders/${c}`, { token: T_OWNER });
    const keys = (cd.body?.data?.delivery_photo?.photos || []).map(p => p.key);
    it("the customer's order read names all three: the shop's first, then the rider's", () => {
      assert.strictEqual(keys.length, 3, JSON.stringify(cd.body?.data?.delivery_photo));
      assert.strictEqual(keys[0], 's');
      assert.ok(/^r\d+$/.test(keys[1]) && /^r\d+$/.test(keys[2]));
      assert.ok(!JSON.stringify(cd.body.data.delivery_photo).includes('base64'));
    });
    const got = [];
    for (const k of keys) got.push((await call('GET', `/api/retail/orders/${c}/delivery-photo?key=${k}`, { token: T_OWNER })).body?.data?.data);
    it('each key opens its own photo for the owner', () => assert.deepStrictEqual(got, [JPEG, R1, R2]));
    const strangerR = await call('GET', `/api/retail/orders/${c}/delivery-photo?key=${keys[1]}`, { token: T_STRANGER });
    it("another customer cannot open a rider photo either", () => assert.strictEqual(strangerR.status, 404));
    const d2 = makeOrder('delivered');
    const crossed = await call('GET', `/api/retail/orders/${d2}/delivery-photo?key=${keys[1]}`, { token: T_OWNER });
    it("a rider photo's key opens nothing on another order, even the owner's", () => assert.strictEqual(crossed.status, 404));

    const cadm = await call('GET', `/api/retail-admin/orders/${c}`);
    it('the drawer lists them by kind, without the bytes', () => {
      const ph = cadm.body?.data?.delivery_photo?.photos || [];
      assert.deepStrictEqual(ph.map(p => p.kind), ['staff', 'rider', 'rider']);
      assert.ok(!JSON.stringify(ph).includes('base64'));
    });
    const rm = await call('DELETE', `/api/retail-admin/orders/${c}/delivery-photo?key=${keys[1]}`);
    const after = await call('GET', `/api/retail/orders/${c}`, { token: T_OWNER });
    it('staff can take a rider photo off; it is marked removed, its bytes dropped', () => {
      assert.strictEqual(rm.status, 200);
      assert.strictEqual(after.body?.data?.delivery_photo?.photos?.length, 2);
      const row = db.prepare('SELECT status, data FROM retail_rider_photos WHERE id = ?').get(Number(keys[1].slice(1)));
      assert.strictEqual(row.status, 'removed');
      assert.strictEqual(row.data, null);
    });
    const bad = await call('DELETE', `/api/retail-admin/orders/${c}/delivery-photo?key=../1`);
    it('a malformed key is refused', () => assert.strictEqual(bad.status, 400));
    const staffGone = await call('DELETE', `/api/retail-admin/orders/${c}/delivery-photo`);
    it("no key still removes the shop's photo, as before, and leaves the rider's", () => {
      assert.strictEqual(staffGone.status, 200);
      assert.deepStrictEqual(staffGone.body?.data?.photos?.map(p => p.kind), ['rider']);
    });

    console.log('\n── Where the slot is refused');
    const early = makeOrder('preparing');
    const r1 = await call('POST', `/api/retail-admin/orders/${early}/delivery-photo`, { body: { data: JPEG } });
    it('before the parcel leaves: 409', () => assert.strictEqual(r1.status, 409));
    const pick = makeOrder('delivered', { ft: 'pickup', mode: null });
    const r2 = await call('POST', `/api/retail-admin/orders/${pick}/delivery-photo`, { body: { data: JPEG } });
    it('a pickup order: 409', () => assert.strictEqual(r2.status, 409));
    const b = makeOrder('dispatched');
    const r3 = await call('POST', `/api/retail-admin/orders/${b}/delivery-photo`,
      { body: { data: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') } });
    it('an SVG: 400 bad_image', () => {
      assert.strictEqual(r3.status, 400);
      assert.strictEqual(r3.body?.error, 'bad_image');
    });
    const plain = await call('GET', `/api/retail-admin/orders/${early}`);
    it('the drawer offers no slot before dispatch', () =>
      assert.strictEqual(plain.body?.data?.delivery_photo, undefined));
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
