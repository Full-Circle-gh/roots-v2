#!/usr/bin/env node
/**
 * Offline self-test for the delivery-point MEMORY (decisions §203).
 *
 *   node scripts/test_point_memory.js
 *
 * The thing being locked down, in one sentence: a question an operator has
 * already answered for an address is not asked again for that address, and is
 * not asked on behalf of any OTHER address.
 *
 * What it checks:
 *   1. the KEY — the same address text recalls, a changed one does not, and an
 *      address with no street line is never remembered at all;
 *   2. the SOURCE — what went in comes back out unchanged, so a picked name
 *      cannot leave here wearing a tapped building's distance exemption;
 *   3. the LIMITS — a corrupt row is not handed to a courier, the customer's
 *      saved address is never written, and a memory failure cannot take a
 *      confirm down with it;
 *   4. the LOOP guard and the requeue SQL the drain runs on a hit;
 *   5. END TO END — an order that parks, gets its answer from the memory, and
 *      builds a payload on the next pass without anyone being asked.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const memory = require('../lib/delivery-point-memory');
const qingyunQueue = require('../lib/qingyun-queue');
const geocode = require('../lib/geocode');
const { buildCreatePayload } = require('../lib/qingyun-payload');
const { openQueueTableDb, addTables, driver } = require('./test-support/memory-db');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function itAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const RETAIL = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');
const DAEMON = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qingyun-daemon.js'), 'utf8');
const LIB = fs.readFileSync(path.join(__dirname, '..', 'lib', 'delivery-point-memory.js'), 'utf8');

// The order on the screen that started this: Amap places the road but not the
// house number, so it parks and asks (TC000812, 2026-09-21).
const ADDR = {
  province: '广东省', city: '广州市', district: '海珠区',
  address: '江南中街道江南西路紫山大街15号', detail: '603',
};
const PIN = { lat: 23.0951, lng: 113.2734 };

// The REAL table out of database.js, not a hand-written copy: a column added
// there and forgotten here must fail loudly rather than pass quietly.
function freshDb() {
  const db = openQueueTableDb(DB_SRC);
  addTables(db, DB_SRC, DB_SRC, ['retail_delivery_point_memory']);
  db.exec(`CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, status TEXT,
           address_json TEXT, updated_at DATETIME)`);
  return db;
}
const remembered = (db, addr = ADDR, over = {}) => memory.remember(db, {
  addr, lat: PIN.lat, lng: PIN.lng, source: 'staff_pin',
  orderId: 812, orderNo: 'TC000812', ...over,
});

(async () => {

console.log(`\nthe key — one address, one answer (sqlite driver: ${driver})`);

it('the same address text recalls the answer', () => {
  const db = freshDb();
  assert.strictEqual(remembered(db), true);
  const hit = memory.recall(db, { ...ADDR });
  assert.ok(hit, 'the next order to this address must not be asked again');
  assert.strictEqual(hit.lat, PIN.lat);
  assert.strictEqual(hit.source, 'staff_pin');
  assert.strictEqual(hit.answeredOrderNo, 'TC000812', 'the record says which order answered it');
});

it('spacing and padding in the address text do not lose the answer', () => {
  const db = freshDb();
  remembered(db);
  assert.ok(memory.recall(db, { ...ADDR, address: `  ${ADDR.address}  `, detail: ' 603 ' }),
    'the same address typed with a stray space is the same address');
});

it('a CHANGED address text does not recall it — this is how a wrong answer retires', () => {
  const db = freshDb();
  remembered(db);
  assert.strictEqual(memory.recall(db, { ...ADDR, address: '江南中街道江南西路紫山大街17号' }), null,
    'a corrected street must not keep the point chosen against the old one');
  assert.strictEqual(memory.recall(db, { ...ADDR, district: '越秀区' }), null);
});

it('a different FLAT is a different key, not a shared one', () => {
  // Usually the same front door, and that is not ours to assume: guessing wide
  // is how a memory answers for an address nobody ever answered.
  const db = freshDb();
  remembered(db);
  assert.strictEqual(memory.recall(db, { ...ADDR, detail: '604' }), null);
});

it('an address with no street line is never remembered', () => {
  // '广东省广州市' names a city. A point remembered against one would be handed
  // to every future order that also failed to say more than a city.
  const db = freshDb();
  assert.strictEqual(memory.addressKey({ province: '广东省', city: '广州市' }), null);
  assert.strictEqual(remembered(db, { province: '广东省', city: '广州市' }), false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM retail_delivery_point_memory').get().n, 0);
});

it('keyed on the ADDRESS, so it never answers for a customer’s OTHER address', () => {
  const db = freshDb();
  remembered(db);
  const otherAddress = { ...ADDR, address: '昌岗中路168号', detail: '2栋901' };
  assert.strictEqual(memory.recall(db, otherAddress), null,
    'one tap must not become the answer for everywhere this customer lives');
});

console.log('\nthe source — what went in is what comes out');

it('a picked NAME stays poi_picked and is never promoted to staff_pin', () => {
  // staff_pin is exempt from MAX_DROP_KM in lib/qingyun-payload; poi_picked is
  // not. Promoting one on the way out of the memory would hand a chosen name a
  // distance exemption nobody earned — the laundering §5 exists to prevent,
  // arriving a week later through a cache.
  const db = freshDb();
  remembered(db, ADDR, { source: 'poi_picked', placeName: '紫山大街小区' });
  const hit = memory.recall(db, ADDR);
  assert.strictEqual(hit.source, 'poi_picked');
  assert.strictEqual(hit.placeName, '紫山大街小区');
});

it('no other source may be stored, whatever the caller claims', () => {
  const db = freshDb();
  assert.strictEqual(remembered(db, ADDR, { source: 'customer_pin' }), false,
    'the customer did not tap this — lib/address-pin exists to stop that claim');
  assert.strictEqual(remembered(db, ADDR, { source: 'geocode:amap' }), false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM retail_delivery_point_memory').get().n, 0);
});

it('a row corrupted to another source is never handed back', () => {
  const db = freshDb();
  remembered(db);
  db.prepare("UPDATE retail_delivery_point_memory SET source = 'rooftop'").run();
  assert.strictEqual(memory.recall(db, ADDR), null, 'this row would become a delivery target');
});

it('a coordinate outside China is neither stored nor returned', () => {
  const db = freshDb();
  assert.strictEqual(remembered(db, ADDR, { lat: 51.5, lng: -0.12 }), false);
  remembered(db);
  db.prepare('UPDATE retail_delivery_point_memory SET lat = 51.5, lng = -0.12').run();
  assert.strictEqual(memory.recall(db, ADDR), null);
});

it('re-answering REPLACES the answer and resets the count', () => {
  const db = freshDb();
  remembered(db);
  memory.markUsed(db, memory.addressKey(ADDR));
  remembered(db, ADDR, { lat: 23.10, lng: 113.28, orderNo: 'TC000999' });
  const hit = memory.recall(db, ADDR);
  assert.strictEqual(hit.lat, 23.10, 'the correction wins');
  assert.strictEqual(hit.answeredOrderNo, 'TC000999');
  assert.strictEqual(hit.usedCount, 0, 'a new answer has not been used yet');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM retail_delivery_point_memory').get().n, 1);
});

console.log('\nthe limits — what this must never do');

it('D5 holds: nothing here writes to retail_customer_addresses', () => {
  assert.doesNotMatch(LIB, /retail_customer_addresses\s*(SET|\()/,
    'the customer’s saved record is theirs; this is the operators’ own');
});

it('a memory failure cannot take the confirm down with it', () => {
  // The confirm writes the point AND requeues the push; those two are what make
  // the delivery happen. Not remembering costs a tap on some future order.
  const db = openQueueTableDb(DB_SRC);                       // no memory table at all
  assert.strictEqual(remembered(db), false, 'returns false rather than throwing');
  assert.strictEqual(memory.recall(db, ADDR), null);
});

it('the snapshot carries the point, no invented grade, and says where it came from', () => {
  const db = freshDb();
  remembered(db);
  const snap = memory.pinnedSnapshot(ADDR, memory.recall(db, ADDR));
  assert.strictEqual(snap.lat, PIN.lat);
  assert.strictEqual(snap.geo_source, 'staff_pin');
  assert.strictEqual(snap.geo_precision, null, 'nobody measured how exact this is');
  assert.strictEqual(snap.district, '海珠区', 'the rest of the address is left alone');
  assert.strictEqual(snap.geo_memory, 'TC000812', 'silent on the screen, not silent in the record');
});

it('the loop guard: an order already carrying the remembered point parks anyway', () => {
  const db = freshDb();
  remembered(db);
  const hit = memory.recall(db, ADDR);
  assert.strictEqual(memory.alreadyApplied(ADDR, hit), false, 'nothing applied yet');
  assert.strictEqual(memory.alreadyApplied(memory.pinnedSnapshot(ADDR, hit), hit), true,
    'applying the same point twice would requeue for ever');
});

console.log('\nthe requeue the drain runs on a hit');

const seed = (db, row = {}) => {
  const r = { status: 'processing', attempts: 1, qy: null, ...row };
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, qingyun_order_id)
              VALUES (812, 'tianhe', ?, ?, ?)`).run(r.status, r.attempts, r.qy);
  return db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 812').get();
};
const readRow = (db) => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 812').get();

it('a recalled point sends the row back to the queue without parking it', () => {
  const db = freshDb();
  const r = seed(db);
  assert.strictEqual(db.prepare(qingyunQueue.RECALLED_POINT_SQL).run(0, r.id).changes, 1);
  const after = readRow(db);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual(after.needs_point_at, null, 'it never waited for anyone');
  assert.strictEqual(after.last_error, null);
});

it('the attempt the drain spent is handed back, but the budget is not reset', () => {
  // A human confirm resets to 0 — new information about an order that spent its
  // attempts waiting. A memory hit is the drain answering its own question, and
  // a full budget there would let a failing order push five more times for
  // every address it happens to recognise.
  const db = freshDb();
  const r = seed(db, { attempts: 3 });            // the pre-drain snapshot the daemon holds
  db.prepare("UPDATE qingyun_push_queue SET attempts = 4 WHERE id = ?").run(r.id);
  db.prepare(qingyunQueue.RECALLED_POINT_SQL).run(r.attempts, r.id);
  assert.strictEqual(readRow(db).attempts, 3);
});

it('a row that already has a courier copy is not requeued', () => {
  const db = freshDb();
  const r = seed(db, { qy: 'QY-9' });
  assert.strictEqual(db.prepare(qingyunQueue.RECALLED_POINT_SQL).run(0, r.id).changes, 0,
    'requeuing one would create a second delivery');
});

console.log('\nthe orders already waiting on the same answer');

// A parked row never retries itself — that is the state's whole point — so two
// orders to one address would ask the identical question twice.
const parkOrder = (db, { id, no, addr = ADDR, status = 'paid', qStatus = 'needs_point', qy = null }) => {
  db.prepare('INSERT INTO retail_orders (id, order_no, status, address_json) VALUES (?, ?, ?, ?)')
    .run(id, no, status, JSON.stringify(addr));
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts, qingyun_order_id,
              needs_point_at) VALUES (?, 'tianhe', ?, 0, ?, CURRENT_TIMESTAMP)`).run(id, qStatus, qy);
};
const queueOf = (db, id) => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = ?').get(id);
const addrOf = (db, id) => JSON.parse(db.prepare('SELECT address_json FROM retail_orders WHERE id = ?').get(id).address_json);

it('answering one parked order releases the other one waiting on the same address', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 813, no: 'TC000813' });
  const released = memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 });
  assert.deepStrictEqual(released, ['TC000813'], 'the same question must not be asked twice');
  assert.strictEqual(queueOf(db, 813).status, 'pending');
  assert.strictEqual(queueOf(db, 813).needs_point_at, null);
  assert.strictEqual(addrOf(db, 813).geo_source, 'staff_pin');
  assert.strictEqual(addrOf(db, 813).lat, PIN.lat);
});

it('a parked order at a DIFFERENT address is left alone', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 814, no: 'TC000814', addr: { ...ADDR, address: '昌岗中路168号' } });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), []);
  assert.strictEqual(queueOf(db, 814).status, 'needs_point');
});

it('a CLOSED order is never released — nobody is delivering it', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 815, no: 'TC000815', status: 'cancelled' });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), []);
  assert.strictEqual(queueOf(db, 815).status, 'needs_point');
});

it('an order waiting to PICK A PLACE is released by the same answer', () => {
  // Two surfaces, one question: where is this address. An answer from either
  // ends the wait on both.
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 816, no: 'TC000816', qStatus: 'awaiting_choice' });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), ['TC000816']);
  assert.strictEqual(queueOf(db, 816).status, 'pending');
});

it('a row that already has a courier copy is not dragged back into the queue', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 817, no: 'TC000817', qy: 'QY-9' });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), []);
});

it('a pickup order is never given a delivery point', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 818, no: 'TC000818', addr: { ...ADDR, pickup: true } });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), []);
});

it('the order that was just answered is not touched by its own release', () => {
  const db = freshDb();
  remembered(db);
  parkOrder(db, { id: 812, no: 'TC000812', qStatus: 'needs_point' });
  assert.deepStrictEqual(memory.releaseWaiting(db, memory.recall(db, ADDR), { excludeOrderId: 812 }), [],
    'its own endpoint has already requeued it, under its own guards');
  assert.strictEqual(queueOf(db, 812).status, 'needs_point');
});

// Each endpoint read on its own, from its route line to the next one: the two
// live in one file, so a whole-file indexOf would compare confirm-point's
// release against confirm-place's SQL and prove nothing.
function endpoint(name) {
  const at = RETAIL.indexOf(`/api/retail-admin/orders/:id/qingyun/${name}'`);
  assert.ok(at > 0, `the ${name} endpoint is still there`);
  const end = RETAIL.indexOf('router.post(', at + 10);
  return RETAIL.slice(at, end > 0 ? end : RETAIL.length);
}

it('both endpoints release the twins, and only after their own transaction', () => {
  assert.strictEqual((RETAIL.match(/pointMemory\.releaseWaiting\(/g) || []).length, 2);
  // After, never inside: a sibling order's dispatch must not be able to roll
  // back the confirm the operator just made.
  for (const [name, sql] of [['confirm-point', 'CONFIRM_POINT_SQL'], ['confirm-place', 'CONFIRM_CHOICE_SQL']]) {
    const body = endpoint(name);
    assert.ok(body.includes('pointMemory.releaseWaiting('), `${name} releases the twins`);
    assert.ok(body.indexOf(`qingyunQueue.${sql}`) < body.indexOf('pointMemory.releaseWaiting('),
      `${name} commits its own requeue first`);
  }
});

console.log('\nthe wiring — the two surfaces that ask, and the one that answers');

it('both confirm endpoints record their answer, each with its own source', () => {
  assert.match(RETAIL, /pointMemory\.remember\(tx, \{\s*\n?\s*addr, lat: pin\.lat, lng: pin\.lng, source: 'staff_pin'/,
    'the map tap is remembered');
  assert.match(RETAIL, /pointMemory\.remember\(tx, \{\s*\n?\s*addr, lat: pin\.lat, lng: pin\.lng, source: 'poi_picked'/,
    'the picked place is remembered too — a question asked twice is asked twice either way');
});

it('the drain consults the memory BEFORE it parks either state', () => {
  // Located by the statements that actually park a row, not by the predicates:
  // the memory branch tests both predicates itself, so matching on those would
  // find this block rather than the two it has to come before.
  const recallAt = DAEMON.indexOf('pointMemory.recall(');
  const chosenAt = DAEMON.indexOf('qingyunQueue.AWAITING_CHOICE_SQL');
  const pointAt  = DAEMON.indexOf('qingyunQueue.NEEDS_POINT_SQL');
  assert.ok(recallAt > 0, 'the drain reads the memory');
  assert.ok(chosenAt > 0 && pointAt > 0, 'the two parking statements are still there');
  assert.ok(recallAt < chosenAt && recallAt < pointAt,
    'parking first would draw a question that has already been answered');
});

it('a pickup order is never given a delivery point from the memory', () => {
  assert.match(DAEMON, /parked\.pickup \? null : pointMemory\.recall/);
});

console.log('\nend to end — parked once, never asked again');

const SHOP = { shopId: 'S1', cityId: 20, name: '测试门店', lat: 23.13, lng: 113.33 };
const ORDER = (addr) => ({
  order_no: 'TC000812', recipient_name: '张三', recipient_phone: '13000000868',
  address_json: JSON.stringify(addr), delivery_slot_label: '',
});
// ~17km out: past COARSE_OK_KM, so the coarse-but-close rule cannot vouch for
// it and the address genuinely parks. Same fixture shape as test_needs_point.
const COARSE_FAR = { lat: 23.13, lng: 113.50, precision: 'coarse', level: '区县', provider: 'amap', cityMatch: true };
const stubGeo = {
  configured: () => true,
  geocodeAddress: async () => COARSE_FAR,
  isDeliverablePin: geocode.isDeliverablePin,
};
const noPoi = { geocode: async () => null };
const PARKED = { ...ADDR, lat: 23.13, lng: 113.50 };   // what the order carries when it parks

await itAsync('the FIRST order parks and asks', async () => {
  await assert.rejects(
    buildCreatePayload(ORDER(PARKED), SHOP, noPoi, { geocode: stubGeo }),
    (e) => { assert.strictEqual(e.needsPoint, true); return true; });
});

await itAsync('the SECOND order to the same address ships on the remembered point', async () => {
  const db = freshDb();
  remembered(db);                                    // an operator answered the first one
  const hit = memory.recall(db, PARKED);
  assert.ok(hit, 'the parked order’s own address text is what finds it');
  let asked = false;
  const p = await buildCreatePayload(
    ORDER(memory.pinnedSnapshot(PARKED, hit)), SHOP, noPoi,
    { geocode: { ...stubGeo, geocodeAddress: async () => { asked = true; return COARSE_FAR; } } });
  assert.strictEqual(asked, false, 'a remembered point is not re-corroborated, same as a confirmed one');
  assert.strictEqual(p.recipientLat, Math.round(PIN.lat * 1e6));
  assert.strictEqual(p._geo.source, 'staff_pin');
  assert.strictEqual(p._geo.precision, null);
});

await itAsync('a remembered PICKED name is still measured against MAX_DROP_KM', async () => {
  // The contrast that proves the source survives the round trip: the same
  // coordinate, remembered under the other source, is not exempt.
  const db = freshDb();
  remembered(db, ADDR, { source: 'poi_picked', lat: 23.40, lng: 113.33 });   // ~30km north
  const warns = [];
  await assert.rejects(
    buildCreatePayload(
      ORDER(memory.pinnedSnapshot(ADDR, memory.recall(db, ADDR))), SHOP, noPoi,
      { geocode: stubGeo, onWarn: (m) => warns.push(m) }),
    (e) => { assert.match(e.message, /km/); return true; });
});

console.log(`\n${fail === 0 ? '✅' : '❌'} point memory: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})();
