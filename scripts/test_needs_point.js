#!/usr/bin/env node
/**
 * Offline self-test for the needs_point state (stage 1 of the delivery-point
 * confirmation build — see docs/tacet-delivery-point-confirmation-spec.md).
 * No network, no keys, no real DB: the queue statements run against an
 * in-memory SQLite built to match database.js.
 *
 *   node scripts/test_needs_point.js
 *
 * What it locks down:
 *   1. the GATE — an unplaceable address parks instead of refusing, and the
 *      point it parks with is the one the order was carrying;
 *   2. what must NOT change — a trustworthy pin still dispatches untouched, a
 *      geocoder outage is still a hold, and a genuine refusal is still an error;
 *   3. the ATTEMPT budget — parking hands back the attempt the drain spent, and
 *      confirming a point starts the counter from zero;
 *   4. the STATE transitions — including the guards that stop a confirm from
 *      resurrecting a row that already has a courier copy.
 */
'use strict';

const assert = require('assert');
const { buildCreatePayload } = require('../lib/qingyun-payload');
const qingyunQueue = require('../lib/qingyun-queue');
const geocode = require('../lib/geocode');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function itAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Fixtures, same shapes as scripts/test_address_pin.js ──────────────────
const SHOP = { shopId: 'S1', cityId: 20, name: '测试门店', lat: 23.13, lng: 113.33 };
const ORDER = (addr) => ({
  order_no: 'TC000988', recipient_name: '张三', recipient_phone: '13000000868',
  address_json: JSON.stringify(addr), delivery_slot_label: '',
});
const stubGeo = (result) => ({
  configured: () => true,
  geocodeAddress: async () => result,
  isDeliverablePin: geocode.isDeliverablePin,
});
const noPoi = { geocode: async () => null };

// The address that produces the state: a real Guangzhou street the provider can
// only place at district level.
const VAGUE = { province: '广东省', city: '广州市', district: '天河区', address: '品秀星越花园A栋' };
// A district-centroid answer — precise-looking, useless to a rider.
const COARSE = { lat: 23.1339, lng: 113.3603, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true };

// Node's CommonJS has no top-level await — everything runs inside one async
// pass so the async gate tests and the synchronous SQL tests share a tally.
(async () => {

// ─────────────────────────────────────────────────────────────────────────
console.log('\nthe gate — an unplaceable address parks instead of refusing');

// The exact shape the three text geocoders write (background save, checkout
// fallback, admin snapshot): coordinates present, graded coarse. This is the
// common path, not an edge case.
await itAsync('a coarse geocoded pin asks for a point instead of erroring', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.1339, lng: 113.3603, geo_source: 'geocode:amap', geo_precision: 'coarse' }),
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.strictEqual(e.needsPoint, true, 'must be flagged needs_point, not a plain refusal');
      assert.strictEqual(e.geoHold, undefined, 'must not be confused with a geocoder outage');
      return true;
    });
});

await itAsync('parks with the point the ORDER was carrying, and its grade', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.1339, lng: 113.3603, geo_source: 'geocode:amap', geo_precision: 'coarse' }),
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.deepStrictEqual(e.point, { lat: 23.1339, lng: 113.3603, precision: 'coarse' });
      return true;
    });
});

await itAsync('a client coordinate with no provenance parks with a null grade', async () => {
  // 'client_unverified': coordinates arrived in a save body with no pin_source
  // claim. We genuinely do not know how exact they are, and saying so beats
  // borrowing the grade of a different point.
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.14, lng: 113.36, geo_source: 'client_unverified' }),
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.strictEqual(e.needsPoint, true);
      assert.deepStrictEqual(e.point, { lat: 23.14, lng: 113.36, precision: null });
      return true;
    });
});

await itAsync('a legacy row with no provenance at all still parks', async () => {
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.14, lng: 113.36 }),
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => e.needsPoint === true);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nwhat must not change — D2, and the other two throw flavours');

await itAsync('a tapped customer pin still dispatches untouched', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.12, lng: 113.32, geo_source: 'customer_pin', geo_precision: 'rooftop' }),
    SHOP, noPoi, { geocode: stubGeo(COARSE) });
  assert.strictEqual(p.recipientLat, 23120000);
  assert.strictEqual(p._geo.source, 'customer_pin');
});

await itAsync('a street-grade geocode still dispatches untouched', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.12, lng: 113.32, geo_source: 'geocode:amap', geo_precision: 'street' }),
    SHOP, noPoi, { geocode: stubGeo(COARSE) });
  assert.strictEqual(p.recipientLat, 23120000);
});

await itAsync('an unverified pin the text CORROBORATES still ships — no point asked for', async () => {
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.135, lng: 113.335 }),
    SHOP, noPoi,
    { geocode: stubGeo({ lat: 23.1365, lng: 113.3365, precision: 'rooftop', provider: 'amap', cityMatch: true }) });
  assert.match(p._geo.source, /\+verified$/);
});

await itAsync('a geocoder OUTAGE is still a hold, not a request for a point', async () => {
  // Nothing was learned about this address, so nobody should be asked to look
  // at a map — it pushes itself when the provider comes back.
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.14, lng: 113.36 }),
      SHOP, noPoi,
      { geocode: {
          configured: () => true,
          isDeliverablePin: geocode.isDeliverablePin,
          geocodeAddressResult: async () => ({ result: null, failure: { code: 'network', message: 'timeout' } }),
        } }),
    (e) => {
      assert.strictEqual(e.geoHold, true);
      assert.notStrictEqual(e.needsPoint, true, 'an outage must not park the row');
      return true;
    });
});

await itAsync('an order with NO coordinates at all is still a plain refusal', async () => {
  // Out of stage-1 scope on purpose: there is no guessed point to drop on a
  // map, so the map surface would open on nothing.
  await assert.rejects(
    buildCreatePayload(ORDER(VAGUE), SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.notStrictEqual(e.needsPoint, true);
      assert.match(e.message, /geocode failed/);
      return true;
    });
});

await itAsync('a missing recipient is still a plain refusal', async () => {
  await assert.rejects(
    buildCreatePayload(
      { order_no: 'TC000989', address_json: JSON.stringify(VAGUE) },
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.notStrictEqual(e.needsPoint, true);
      assert.match(e.message, /missing recipient/);
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nstage 3 · a confirmed point is trusted, and never given a grade (spec §5.1)');

// What the confirm endpoint writes: the operator's point, source staff_pin,
// and NO precision — nobody measured one.
const STAFF = { geo_source: 'staff_pin', geo_precision: null };

await itAsync('a confirmed point ships without being re-corroborated', async () => {
  let asked = false;
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.12, lng: 113.32, ...STAFF }),
    SHOP, noPoi,
    { geocode: { configured: () => true, isDeliverablePin: geocode.isDeliverablePin,
                 geocodeAddress: async () => { asked = true; return COARSE; } } });
  assert.strictEqual(asked, false, 'the whole point of confirming is not to ask the text again');
  assert.strictEqual(p.recipientLat, 23120000);
  assert.strictEqual(p._geo.source, 'staff_pin');
  assert.strictEqual(p._geo.precision, null, 'no grade may be invented for it');
});

await itAsync('a confirmed point does NOT bounce straight back into needs_point', async () => {
  // The failure this clause exists to prevent: without it the drain re-geocodes,
  // gets the same coarse answer, and re-parks the row — the operator confirms
  // and watches it come back with no explanation.
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.12, lng: 113.32, ...STAFF }),
    SHOP, noPoi, { geocode: stubGeo(COARSE) });
  assert.ok(p.recipientLat, 'it built a payload rather than throwing');
});

await itAsync('a far confirmed point is sent, not refused for want of a grade', async () => {
  // 30km: past MAX_DROP_KM (25) but inside the 50km absolute ceiling. A human
  // has looked at the map and said that is the door, so it is a long same-city
  // delivery — and it must not die because staff_pin carries no 'rooftop'.
  const warns = [];
  const p = await buildCreatePayload(
    ORDER({ ...VAGUE, lat: 23.40, lng: 113.33, ...STAFF }),        // ~30km north of SHOP
    SHOP, noPoi, { geocode: stubGeo(COARSE), onWarn: (m) => warns.push(m) });
  assert.ok(p.recipientLat, 'sent');
  assert.ok(warns.some(w => /sending anyway/.test(w)), 'and warned about the distance');
});

await itAsync('the absolute ceiling still refuses a confirmed point', async () => {
  // Past ABS_MAX_KM nothing ships, whatever anyone confirmed — there is no
  // same-city rider trip at that distance.
  await assert.rejects(
    buildCreatePayload(
      ORDER({ ...VAGUE, lat: 23.90, lng: 113.33, ...STAFF }),      // ~85km
      SHOP, noPoi, { geocode: stubGeo(COARSE) }),
    (e) => {
      assert.match(e.message, /same-city ceiling/);
      assert.notStrictEqual(e.needsPoint, true, 'a ceiling breach is a refusal, not a re-park');
      return true;
    });
});

it('staff_pin does not survive an address text edit', () => {
  // The point was chosen against text that has just been replaced, so it goes
  // with it and the order re-parks. Only a customer tap outlives a rewrite.
  const addressPin = require('../lib/address-pin');
  assert.strictEqual(addressPin.keepsPinThroughTextEdit({ geo_source: 'staff_pin', lat: 23.1, lng: 113.3 }), false);
  assert.strictEqual(addressPin.keepsPinThroughTextEdit({ geo_source: 'customer_pin', lat: 23.1, lng: 113.3 }), true);
});

it('an unflagged client coordinate cannot pass itself off as a confirmed point', () => {
  // readClientPin is what the confirm endpoint validates with; it reports
  // bounds and freshness, and the ENDPOINT decides the source. Nothing a
  // client sends can name itself staff_pin.
  const addressPin = require('../lib/address-pin');
  assert.strictEqual(addressPin.readClientPin({ lat: 51.5, lng: -0.12 }), null, 'outside China is refused');
  assert.strictEqual(addressPin.readClientPin({ lat: 0, lng: 0 }), null);
  assert.deepStrictEqual(addressPin.readClientPin({ lat: 23.1, lng: 113.3 }), { lat: 23.1, lng: 113.3, fresh: false });
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\npredicates');

it('shouldMarkNeedsPoint fires only on the marker', () => {
  assert.strictEqual(qingyunQueue.shouldMarkNeedsPoint({ needsPoint: true }), true);
  assert.strictEqual(qingyunQueue.shouldMarkNeedsPoint({ geoHold: true }), false);
  assert.strictEqual(qingyunQueue.shouldMarkNeedsPoint(new Error('boom')), false);
  assert.strictEqual(qingyunQueue.shouldMarkNeedsPoint(null), false);
});

it('awaitingPoint is false once a copy exists on the courier platform', () => {
  assert.strictEqual(qingyunQueue.awaitingPoint({ status: 'needs_point' }), true);
  assert.strictEqual(qingyunQueue.awaitingPoint({ status: 'needs_point', qingyun_order_id: 'QY1' }), false);
  assert.strictEqual(qingyunQueue.awaitingPoint({ status: 'pending' }), false);
  assert.strictEqual(qingyunQueue.awaitingPoint({ status: 'error' }), false);
  assert.strictEqual(qingyunQueue.awaitingPoint(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nstage 2 · who needs a person, and who may be retried (spec §8.1)');

it('a parked row needs attention — it used to read as a normal queue wait', () => {
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'needs_point' }), true);
});

it('a retired row needs attention — the one action that revives it was unreachable', () => {
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'skipped' }), true);
});

it('error keeps its existing behaviour', () => {
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'error' }), true);
});

it('a row the daemon still holds is not a call for help', () => {
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'pending' }), false);
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'processing' }), false);
  assert.strictEqual(qingyunQueue.needsAttention({ status: 'done' }), false);
  assert.strictEqual(qingyunQueue.needsAttention(null), false);
});

it('a row with a courier copy never asks for attention', () => {
  for (const status of ['error', 'skipped', 'needs_point']) {
    assert.strictEqual(qingyunQueue.needsAttention({ status, qingyun_order_id: 'QY1' }), false, status);
  }
});

it('every row the drawer flags is a row the endpoint will accept', () => {
  // The drawer draws the Retry button off needsAttention and the endpoint gates
  // on manualRetryEligible. If those sets ever drift, the client toasts
  // "Queued — the daemon will push it within a minute" on a press that did
  // nothing: the operator is told it worked while the order stays stuck.
  for (const status of ['pending', 'processing', 'done', 'error', 'skipped', 'needs_point']) {
    for (const qy of [null, 'QY1']) {
      const row = { status, qingyun_order_id: qy };
      assert.strictEqual(qingyunQueue.needsAttention(row), qingyunQueue.manualRetryEligible(row),
        `${status}/${qy || 'no copy'}`);
    }
  }
});

it('an address edit releases a parked row but never a retired one', () => {
  // 'skipped' means cancelled/refunded/delivered, or not same-city same-day.
  // An address edit is not evidence about either, and requeuing a closed
  // order's row would hand the drain a push for an order nobody is delivering.
  assert.strictEqual(qingyunQueue.requeueEligible({ status: 'needs_point' }), true);
  assert.strictEqual(qingyunQueue.requeueEligible({ status: 'error' }), true);
  assert.strictEqual(qingyunQueue.requeueEligible({ status: 'skipped' }), false);
  assert.strictEqual(qingyunQueue.requeueEligible({ status: 'pending' }), false);
  assert.strictEqual(qingyunQueue.requeueEligible({ status: 'needs_point', qingyun_order_id: 'QY1' }), false);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nstate transitions (in-memory SQLite, mirrors database.js)');

// The app's driver when it's installed (the box), Node's built-in when it
// isn't (a bare checkout) — same prepare/run/get/all surface either way, so the
// statements under test run verbatim in both. Keeps this file to the house rule
// for tests: no install, no network, safe to run anywhere.
//
// The choice lives in scripts/test-support/memory-db.js because the version
// that lived here was wrong: it wrapped only the require(), which succeeds
// without the native binding, so the fallback never engaged and every test
// below failed on any machine that had not rebuilt better-sqlite3.
const { openQueueTableDb, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// Not a mock: the REAL table definition, lifted out of database.js — both the
// CREATE and every addColumn() that has since been bolted onto it — so a column
// added there and forgotten here cannot make this file quietly pass. Same
// technique as the G1 suite in scripts/test_address_pin.js.
function freshDb() {
  return openQueueTableDb(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'database.js'), 'utf8'));
}
// One queue row, and the drain's own view of it.
const seed = (db, row = {}) => {
  const r = { status: 'pending', attempts: 0, qy: null, ...row };
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, qingyun_order_id)
              VALUES (988, 'tianhe', ?, ?, ?)`)
    .run(r.status, r.attempts, r.qy);
  return db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 988').get();
};
const read = (db) => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 988').get();
// What the drain does to a row before it builds the payload.
const takeAttempt = (db, r) => {
  db.prepare("UPDATE qingyun_push_queue SET status='processing', attempts=attempts+1 WHERE id=?").run(r.id);
  return r;   // the pre-increment snapshot the drain holds, exactly as in the daemon
};
const park = (db, r, pt = { lat: 23.1339, lng: 113.3603, precision: 'coarse' }) =>
  db.prepare(qingyunQueue.NEEDS_POINT_SQL)
    .run(r.attempts, pt.lat, pt.lng, pt.precision, require('../lib/qingyun-payload').NEEDS_POINT_MESSAGE, r.id);

it('parking hands back the attempt the drain just spent', () => {
  const db = freshDb();
  const r = takeAttempt(db, seed(db, { attempts: 2 }));
  assert.strictEqual(read(db).attempts, 3, 'drain incremented');
  park(db, r);
  const after = read(db);
  assert.strictEqual(after.status, 'needs_point');
  assert.strictEqual(after.attempts, 2, 'the attempt must be refunded — this push could never have worked');
});

it('the counter never advances however many times a parked row is re-parked', () => {
  const db = freshDb();
  let r = takeAttempt(db, seed(db, { attempts: 0 }));
  park(db, r);
  for (let i = 0; i < 4; i++) {
    r = takeAttempt(db, read(db));
    park(db, r);
  }
  assert.strictEqual(read(db).attempts, 0, 'attempts start only once a real point exists');
});

it('records the guessed point and its grade', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  const after = read(db);
  assert.strictEqual(after.guessed_lat, 23.1339);
  assert.strictEqual(after.guessed_lng, 113.3603);
  assert.strictEqual(after.guessed_precision, 'coarse');
  assert.ok(after.needs_point_at, 'stamps when the wait began');
});

it('needs_point_at is first-write-wins — the age is the age of the WAIT', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  const first = read(db).needs_point_at;
  db.prepare("UPDATE qingyun_push_queue SET needs_point_at = '2020-01-01 00:00:00' WHERE retail_order_id = 988").run();
  park(db, takeAttempt(db, read(db)));
  assert.strictEqual(read(db).needs_point_at, '2020-01-01 00:00:00', 'a later drain must not restart the clock');
  assert.ok(first);
});

it('parking clears a geocoder hold — the two states are not both true', () => {
  const db = freshDb();
  const r = takeAttempt(db, seed(db));
  db.prepare("UPDATE qingyun_push_queue SET geo_held_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
  park(db, r);
  assert.strictEqual(read(db).geo_held_at, null);
});

it('a row that already produced a courier copy is never parked', () => {
  // The drain finished a push while this one was mid-flight: the row it holds
  // is stale, and writing needs_point over the copy would hide a live delivery
  // behind a "point at the door" prompt nobody can dismiss.
  const db = freshDb();
  const r = seed(db, { status: 'done', qy: 'QY-123' });
  const res = park(db, r);
  assert.strictEqual(res.changes, 0, 'must not hide a live delivery behind a point prompt');
  assert.strictEqual(read(db).status, 'done');
});

it('confirming a point returns the row to pending with a full attempt budget', () => {
  const db = freshDb();
  const r = takeAttempt(db, seed(db, { attempts: 4 }));
  park(db, r);
  const res = db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988);
  assert.strictEqual(res.changes, 1);
  const after = read(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.attempts, 0, 'an order confirmed at attempt 4 must not die on its first real try');
  assert.strictEqual(after.last_error, null);
});

it('confirming clears the guess — no phantom point on a pending row', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988);
  const after = read(db);
  assert.strictEqual(after.guessed_lat, null);
  assert.strictEqual(after.guessed_lng, null);
  assert.strictEqual(after.guessed_precision, null);
  assert.strictEqual(after.needs_point_at, null);
});

it('a second confirm changes nothing', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988).changes, 1);
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988).changes, 0, 'double click must be inert');
});

it('confirm never drags a skipped, error or done row back into the queue', () => {
  for (const status of ['skipped', 'error', 'done', 'pending', 'processing']) {
    const db = freshDb();
    seed(db, { status });
    assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988).changes, 0, status);
  }
});

it('confirm loses to a drain that created the copy first', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  db.prepare("UPDATE qingyun_push_queue SET qingyun_order_id = 'QY-9' WHERE retail_order_id = 988").run();
  assert.strictEqual(db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988).changes, 0,
    'requeuing here would create a SECOND 待配送 order and a second rider to pay for');
});

it('a cancel retires a row that is waiting for a point', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  const res = db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('order cancelled', 988);
  assert.strictEqual(res.changes, 1);
  assert.strictEqual(read(db).status, 'skipped', 'stop asking staff to point at a door nobody delivers to');
});

it('the drain does not pick up a row that is waiting for a point', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  // The daemon's own select (scripts/qingyun-daemon.js).
  const rows = db.prepare("SELECT * FROM qingyun_push_queue WHERE store_code = ? AND status IN ('pending') ORDER BY id LIMIT 3").all('tianhe');
  assert.strictEqual(rows.length, 0);
  db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988);
  assert.strictEqual(
    db.prepare("SELECT * FROM qingyun_push_queue WHERE store_code = ? AND status IN ('pending') ORDER BY id LIMIT 3").all('tianhe').length,
    1, 'and picks it up again the moment a point is confirmed');
});

it('a parked row is not counted as a geocoder-outage hold', () => {
  // The daemon's outage alert counts held PENDING rows; a parked row must not
  // inflate it, or a queue waiting on people reads as a map-service outage.
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  const held = db.prepare(
    `SELECT COUNT(*) AS n FROM qingyun_push_queue
      WHERE geo_held_at IS NOT NULL AND status = 'pending' AND qingyun_order_id IS NULL`).get();
  assert.strictEqual(held.n, 0);
});

it('an address edit re-runs the lookup on a parked row and clears the guess', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db)));
  const r = db.prepare(qingyunQueue.REQUEUE_SQL).run('requeued after ship-to edit', 988);
  assert.strictEqual(r.changes, 1, 'a corrected address is what might place this order');
  const after = read(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.attempts, 0);
  assert.strictEqual(after.guessed_lat, null, 'the guess belonged to the address that was just replaced');
  assert.strictEqual(after.needs_point_at, null);
});

it('an address edit does NOT revive a retired row', () => {
  const db = freshDb();
  seed(db, { status: 'skipped' });
  assert.strictEqual(db.prepare(qingyunQueue.REQUEUE_SQL).run('requeued after ship-to edit', 988).changes, 0,
    'a cancelled order must not walk back into the drain because someone fixed a typo');
});

it('a manual retry accepts a parked row and clears the guess with it', () => {
  const db = freshDb();
  park(db, takeAttempt(db, seed(db, { attempts: 3 })));
  assert.strictEqual(db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(988).changes, 1);
  const after = read(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.attempts, 0);
  assert.strictEqual(after.guessed_lng, null);
  assert.strictEqual(after.needs_point_at, null);
});

it('neither requeue path can duplicate a live courier order', () => {
  for (const sql of [qingyunQueue.REQUEUE_SQL, qingyunQueue.MANUAL_RETRY_SQL]) {
    const db = freshDb();
    park(db, takeAttempt(db, seed(db)));
    db.prepare("UPDATE qingyun_push_queue SET qingyun_order_id = 'QY-9' WHERE retail_order_id = 988").run();
    const args = sql === qingyunQueue.REQUEUE_SQL ? ['why', 988] : [988];
    assert.strictEqual(db.prepare(sql).run(...args).changes, 0);
  }
});

it('the operator-facing message names no code, grade or coordinate', () => {
  const { NEEDS_POINT_MESSAGE } = require('../lib/qingyun-payload');
  assert.doesNotMatch(NEEDS_POINT_MESSAGE, /geocode:|amap|tencent|coarse|rooftop|street|precision|lat|lng/i,
    'an operator cannot act on a precision grade and should not have to read one');
  assert.doesNotMatch(NEEDS_POINT_MESSAGE, /corroborat/i, 'the stale wording is gone');
  assert.match(NEEDS_POINT_MESSAGE, /配送点/, 'staff read this in Chinese');
  assert.ok(NEEDS_POINT_MESSAGE.length <= 300, 'stored in last_error, which the daemon slices at 300');
});

// ─────────────────────────────────────────────────────────────────────────
// The two stage-3 writes. Each is a transaction across two tables, and each
// has an order that matters — these replay the statements in both orders and
// assert the failure the wrong one produces.
console.log('\nstage 3 · confirm and reschedule, as the endpoints run them');

/* The order table, cut down to the columns these two flows touch. */
function ordersTable(db, row) {
  db.exec(`CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT,
    address_json TEXT, scheduled_for TEXT, delivery_slot_kind TEXT, delivery_slot_label TEXT)`);
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, address_json, scheduled_for, delivery_slot_kind)
              VALUES (988, 'R2608060988', 'paid', ?, ?, ?)`)
    .run(row.address_json, row.scheduled_for, row.kind);
  return db;
}
const ORDER_ADDR = JSON.stringify({
  province: '广东省', city: '广州市', district: '海珠区', address: '芳园路1号',
  lat: 23.1339, lng: 113.3603, geo_source: 'geocode:amap', geo_precision: 'coarse',
});
/* What the drain re-checks on every pass, in the one line that matters here. */
const shipsToday = (o, today) => o.delivery_slot_kind === 'today' || o.scheduled_for === today;

it('confirming writes staff_pin onto the ORDER snapshot, not the address book', () => {
  const db = freshDb();
  ordersTable(db, { address_json: ORDER_ADDR, scheduled_for: '2026-08-06', kind: 'today' });
  park(db, takeAttempt(db, seed(db)));

  const addr = JSON.parse(db.prepare('SELECT address_json FROM retail_orders WHERE id=988').get().address_json);
  db.prepare('UPDATE retail_orders SET address_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...addr, lat: 23.0987, lng: 113.3712, geo_source: 'staff_pin', geo_precision: null }), 988);
  db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988);

  const after = JSON.parse(db.prepare('SELECT address_json FROM retail_orders WHERE id=988').get().address_json);
  assert.strictEqual(after.geo_source, 'staff_pin');
  assert.strictEqual(after.geo_precision, null, 'no grade is invented');
  assert.strictEqual(after.lat, 23.0987);
  assert.strictEqual(after.district, '海珠区', 'the rest of the address is left alone');
  assert.strictEqual(read(db).status, 'pending');
  assert.strictEqual(read(db).attempts, 0);
});

it('confirming rolls back WHOLE when the drain got there first', () => {
  // Both writes or neither: a staff point on an order that already has a rider
  // coming to a different spot is worse than a confirm that failed loudly.
  const db = freshDb();
  ordersTable(db, { address_json: ORDER_ADDR, scheduled_for: '2026-08-06', kind: 'today' });
  park(db, takeAttempt(db, seed(db)));
  db.prepare("UPDATE qingyun_push_queue SET qingyun_order_id='QY-9', status='done' WHERE retail_order_id=988").run();

  let rolledBack = false;
  try {
    db.prepare('BEGIN').run();
    db.prepare('UPDATE retail_orders SET address_json = ? WHERE id = ?')
      .run(JSON.stringify({ geo_source: 'staff_pin' }), 988);
    if (!db.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(988).changes) throw new Error('row_moved');
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); rolledBack = true; }

  assert.strictEqual(rolledBack, true);
  const after = JSON.parse(db.prepare('SELECT address_json FROM retail_orders WHERE id=988').get().address_json);
  assert.strictEqual(after.geo_source, 'geocode:amap', 'the point write went back too');
});

it('reschedule writes the DATE first, then requeues — the drain sees the new date', () => {
  const db = freshDb();
  ordersTable(db, { address_json: ORDER_ADDR, scheduled_for: '2026-08-04', kind: 'scheduled' });
  seed(db, { status: 'skipped' });                       // retired when its day passed
  const today = '2026-08-06';

  db.prepare('BEGIN').run();
  db.prepare('UPDATE retail_orders SET scheduled_for = ?, delivery_slot_kind = ? WHERE id = ?').run(today, 'today', 988);
  db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(988);
  db.prepare('COMMIT').run();

  assert.strictEqual(read(db).status, 'pending', 'back in the queue');
  const o = db.prepare('SELECT * FROM retail_orders WHERE id=988').get();
  assert.strictEqual(shipsToday(o, today), true, 'and the drain will keep it');
});

it('the reversed order is what makes a reschedule silently do nothing', () => {
  // Requeue first, and the drain — polling every ~25s — can read the row while
  // the order still carries the passed date, and retire it again.
  const db = freshDb();
  ordersTable(db, { address_json: ORDER_ADDR, scheduled_for: '2026-08-04', kind: 'scheduled' });
  seed(db, { status: 'skipped' });
  const today = '2026-08-06';

  db.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(988);                   // ← wrong way round
  const drainSees = db.prepare('SELECT * FROM retail_orders WHERE id=988').get();
  assert.strictEqual(shipsToday(drainSees, today), false,
    'the drain reads the OLD date and retires the row it was just handed');
  db.prepare(qingyunQueue.RETIRE_CLOSED_SQL).run('not same-city same-day', 988);
  assert.strictEqual(read(db).status, 'skipped', 'straight back where it started');
});

it('existing rows are untouched by the new columns (D12)', () => {
  // A row that predates this build: NULL point, NULL wait, status as it was.
  const db = freshDb();
  seed(db, { status: 'error', attempts: 5 });
  const r = read(db);
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.needs_point_at, null);
  assert.strictEqual(r.guessed_lat, null);
  assert.strictEqual(qingyunQueue.awaitingPoint(r), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})();
