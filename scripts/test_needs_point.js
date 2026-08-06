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
console.log('\nstate transitions (in-memory SQLite, mirrors database.js)');

// The app's driver when it's installed (the box), Node's built-in when it
// isn't (a bare checkout) — same prepare/run/get/all surface either way, so the
// statements under test run verbatim in both. Keeps this file to the house rule
// for tests: no install, no network, safe to run anywhere.
const openMemoryDb = (() => {
  try {
    const BetterSqlite = require('better-sqlite3');
    return () => new BetterSqlite(':memory:');
  } catch {
    const quiet = () => {};                       // node:sqlite is experimental and says so
    process.on('warning', quiet);
    const { DatabaseSync } = require('node:sqlite');
    process.off('warning', quiet);
    return () => new DatabaseSync(':memory:');
  }
})();

// Not a mock: the REAL table definition, lifted out of database.js — both the
// CREATE and every addColumn() that has since been bolted onto it — so a column
// added there and forgotten here cannot make this file quietly pass. Same
// technique as the G1 suite in scripts/test_address_pin.js.
function freshDb() {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'database.js'), 'utf8');
  const ddl = src.match(/CREATE TABLE IF NOT EXISTS qingyun_push_queue[\s\S]*?\n {2}\);/);
  assert.ok(ddl, 'qingyun_push_queue DDL not found in database.js');
  const db = openMemoryDb();
  // The FK points at a table this in-memory DB doesn't carry.
  db.exec(ddl[0].replace(/FOREIGN KEY[\s\S]*?ON DELETE CASCADE/, 'dummy_fk INTEGER'));
  const added = [...src.matchAll(/addColumn\('qingyun_push_queue',\s*'(\w+)',\s*'(\w+)'\)/g)];
  assert.ok(added.length >= 4, 'expected the bolted-on columns to be found');
  for (const [, col, type] of added) db.exec(`ALTER TABLE qingyun_push_queue ADD COLUMN ${col} ${type}`);
  return db;
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
    .run(r.attempts, pt.lat, pt.lng, pt.precision, 'unverified stored pin could not be corroborated', r.id);

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
