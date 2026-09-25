#!/usr/bin/env node
/**
 * The rider's own delivery photos, off Qingyun (§261 addendum).
 *
 *   node scripts/test_rider_photos.js
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. A photo staff took off is never fetched back, and a rider's photo never
 *      replaces the one staff chose.
 *   2. A code Qingyun refuses (500002) is asked once, not every 25 seconds; a
 *      failing one backs off and is given up on after the cap.
 *   3. The codes are the DELIVERY photos (`unloadPics`), found wherever the
 *      order nests them, once each — never the pickup photo (`ladingPics`).
 *   4. Each store's codes go through that store's own Qingyun login.
 *   5. What is stored is a shrunk JPEG data URI, never Qingyun's link.
 *
 * Both schemas are read out of database.js. The Qingyun browser and the
 * download are fakes: no network, no Chrome.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, driver } = require('./test-support/memory-db');
const rp = require('../lib/rider-photos');
const dp = require('../lib/delivery-photo');

let pass = 0;
const fails = [];
async function it(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const lift = (t) => {
  const m = DB_SRC.match(new RegExp('db\\.exec\\(`(\\s*CREATE TABLE IF NOT EXISTS ' + t + '[\\s\\S]*?)`\\);'));
  if (!m) { console.error(`could not find the ${t} schema in database.js`); process.exit(1); }
  return m[1];
};
const STAFF_TABLE = lift('retail_delivery_photos');
const RIDER_TABLE = lift('retail_rider_photos');

function fresh() {
  const db = openMemoryDb();
  db.exec(`CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, status TEXT,
             fulfillment_type TEXT, customer_id INTEGER)`);
  db.exec(`CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT)`);
  db.exec(`CREATE TABLE delivery_jobs (id INTEGER PRIMARY KEY, retail_order_id INTEGER,
             qingyun_order_id TEXT, store_code TEXT)`);
  db.exec(STAFF_TABLE);
  db.exec(RIDER_TABLE);
  return db;
}
const order = (db, id, { status = 'delivered', store = 'tianhe', qy = 'QY' + id } = {}) => {
  db.prepare("INSERT INTO retail_orders (id, status, fulfillment_type, customer_id) VALUES (?,?,'delivery',7)").run(id, status);
  db.prepare('INSERT INTO delivery_jobs (retail_order_id, qingyun_order_id, store_code) VALUES (?,?,?)').run(id, qy, store);
  return db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
};
const STAFF = 'data:image/jpeg;base64,' + Buffer.from('staff photo').toString('base64');

// A real picture, so the stored bytes can be checked as a JPEG sharp produced.
let PICTURE = null;
async function picture() {
  if (PICTURE) return PICTURE;
  const sharp = require('sharp');
  PICTURE = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 90, g: 120, b: 80 } } })
    .png().toBuffer();
  return PICTURE;
}
function fakeFetch(buf, { status = 200, type = 'image/png' } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : String(buf.length)) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    };
  };
  f.calls = calls;
  return f;
}
function fakeBrowser(answer) {
  const asked = [];
  return { asked, resolvePicUrl: async (t) => { asked.push(t); return typeof answer === 'function' ? answer(t) : answer; } };
}
const OK = { code: 0, picUrl: 'https://img.example.test/door.png' };

(async () => {
  console.log(`test_rider_photos (${driver})`);

  // ── The codes ────────────────────────────────────────────────────────────
  await it('reads unloadPics wherever the order nests them, in order, once each', () => {
    const raw = {
      orderId: 1, ladingPics: ['PICKUP'],
      unloadPics: ['A', 'B'],
      orderDeliveryInfo: { unloadPics: ['B', 'C'], ladingPics: ['PICKUP2'] },
      waybills: [{ unloadPics: ['D'] }, { unloadPics: null }],
    };
    assert.deepStrictEqual(rp.tokensFrom(raw), ['A', 'B', 'C', 'D']);
  });
  await it('never reads the pickup photo', () => {
    assert.deepStrictEqual(rp.tokensFrom({ ladingPics: ['X', 'Y'] }), []);
  });
  await it('an order with no photo gives no codes, and junk is ignored', () => {
    assert.deepStrictEqual(rp.tokensFrom(null), []);
    assert.deepStrictEqual(rp.tokensFrom({ unloadPics: [null, 3, '', '  '] }), []);
  });
  await it('noting codes is idempotent — the daemon reads the same order every cycle', () => {
    const db = fresh(); order(db, 1);
    assert.strictEqual(rp.record(db, 1, 'QY1', ['A', 'B']), 2);
    assert.strictEqual(rp.record(db, 1, 'QY1', ['A', 'B']), 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM retail_rider_photos').get().n, 2);
  });

  // ── Fetching ─────────────────────────────────────────────────────────────
  await it('a fetched photo is stored as a shrunk JPEG, never as Qingyun\'s link', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A']);
    const f = fakeFetch(await picture());
    const t = await rp.fetchDue(db, fakeBrowser(OK), { fetchImpl: f });
    assert.strictEqual(t.ok, 1);
    const row = db.prepare('SELECT * FROM retail_rider_photos').get();
    assert.strictEqual(row.status, 'ok');
    assert.ok(/^data:image\/jpeg;base64,/.test(row.data), row.data && row.data.slice(0, 30));
    assert.ok(!row.data.includes('example.test'));
    const dims = await require('sharp')(Buffer.from(row.data.split(',')[1], 'base64')).metadata();
    assert.ok(Math.max(dims.width, dims.height) <= 1280, `${dims.width}x${dims.height}`);
  });
  await it('a refused code (500002) is marked refused and never asked again', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A']);
    const br = fakeBrowser({ code: rp.BLOCKED_CODE });
    await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(db.prepare('SELECT status FROM retail_rider_photos').get().status, 'blocked');
    db.prepare("UPDATE retail_rider_photos SET next_try_at = NULL").run();
    await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(br.asked.length, 1);
  });
  await it('a failure waits before it is tried again', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A']);
    const br = fakeBrowser({ code: 9, msg: 'busy' });
    const t = await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(t.retry, 1);
    const row = db.prepare('SELECT status, attempts, next_try_at FROM retail_rider_photos').get();
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 1);
    assert.ok(row.next_try_at, 'no next_try_at');
    await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(br.asked.length, 1, 'asked again before its wait was up');
  });
  await it('it is given up on after the attempt cap', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A']);
    const br = fakeBrowser({ code: 9 });
    for (let i = 0; i < rp.MAX_ATTEMPTS + 2; i++) {
      db.prepare("UPDATE retail_rider_photos SET next_try_at = NULL").run();
      await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    }
    assert.strictEqual(db.prepare('SELECT status FROM retail_rider_photos').get().status, 'failed');
    assert.strictEqual(br.asked.length, rp.MAX_ATTEMPTS);
  });
  await it('a download that is not an image is a failure, not a stored page', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A']);
    await rp.fetchDue(db, fakeBrowser(OK), { fetchImpl: fakeFetch(Buffer.from('<html>'), { type: 'text/html' }) });
    const row = db.prepare('SELECT status, data, last_error FROM retail_rider_photos').get();
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.data, null);
    assert.ok(/text\/html/.test(row.last_error), row.last_error);
  });
  await it('at most `limit` photos a cycle', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A', 'B', 'C']);
    const br = fakeBrowser(OK);
    await rp.fetchDue(db, br, { limit: 2, fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(br.asked.length, 2);
  });
  await it("each store's codes go through that store's login only", async () => {
    const db = fresh();
    order(db, 1, { store: 'tianhe' }); order(db, 2, { store: 'yuexiu' });
    rp.record(db, 1, 'QY1', ['T']); rp.record(db, 2, 'QY2', ['Y']);
    const br = fakeBrowser(OK);
    await rp.fetchDue(db, br, { storeCode: 'yuexiu', fetchImpl: fakeFetch(await picture()) });
    assert.deepStrictEqual(br.asked, ['Y']);
  });
  await it('a code older than a week is not asked about', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['OLD']);
    db.prepare(`UPDATE retail_rider_photos SET created_at = datetime('now', '-${rp.FRESH_DAYS + 1} days')`).run();
    const br = fakeBrowser(OK);
    await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(br.asked.length, 0);
  });
  await it('one photo that throws does not stop the next', async () => {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['BAD', 'GOOD']);
    const br = fakeBrowser((t) => { if (t === 'BAD') throw new Error('page gone'); return OK; });
    const t = await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(t.ok, 1);
    assert.strictEqual(t.retry, 1);
  });

  // ── Beside the staff photo ──────────────────────────────────────────────
  async function withTwoRiderPhotos() {
    const db = fresh(); order(db, 1); rp.record(db, 1, 'QY1', ['A', 'B']);
    await rp.fetchDue(db, fakeBrowser(OK), { fetchImpl: fakeFetch(await picture()) });
    return db;
  }
  await it('the order lists the staff photo first, then the rider\'s in their order', async () => {
    const db = await withTwoRiderPhotos();
    dp.put(db, 1, { data: STAFF });
    const l = dp.list(db, 1);
    assert.deepStrictEqual(l.map(x => x.kind), ['staff', 'rider', 'rider']);
    assert.strictEqual(l[0].key, 's');
    assert.ok(/^r\d+$/.test(l[1].key) && /^r\d+$/.test(l[2].key));
    assert.ok(!l.some(x => 'data' in x), 'the list carried bytes');
  });
  await it("a rider's photo never replaces the staff photo", async () => {
    const db = await withTwoRiderPhotos();
    dp.put(db, 1, { data: STAFF });
    rp.record(db, 1, 'QY1', ['C']);
    await rp.fetchDue(db, fakeBrowser(OK), { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(dp.data(db, 1), STAFF);
    assert.strictEqual(dp.dataByKey(db, 1, 's'), STAFF);
  });
  await it('a key opens only its own order\'s photo', async () => {
    const db = await withTwoRiderPhotos();
    order(db, 2);
    const key = dp.list(db, 1)[0].key;
    assert.ok(dp.dataByKey(db, 1, key));
    assert.strictEqual(dp.dataByKey(db, 2, key), null);
    assert.strictEqual(dp.dataByKey(db, 1, 'r999999'), null);
    assert.strictEqual(dp.dataByKey(db, 1, 'nonsense'), null);
  });
  await it('no key gives the first photo', async () => {
    const db = await withTwoRiderPhotos();
    assert.strictEqual(dp.dataByKey(db, 1), dp.dataByKey(db, 1, dp.list(db, 1)[0].key));
  });
  await it('a rider photo staff took off is gone for good — not fetched back', async () => {
    const db = await withTwoRiderPhotos();
    const key = dp.list(db, 1)[0].key;
    assert.strictEqual(dp.removeByKey(db, 1, key), true);
    assert.strictEqual(dp.list(db, 1).length, 1);
    assert.strictEqual(dp.dataByKey(db, 1, key), null);
    const row = db.prepare('SELECT status, data FROM retail_rider_photos WHERE id = ?').get(Number(key.slice(1)));
    assert.strictEqual(row.status, 'removed');
    assert.strictEqual(row.data, null, 'the bytes were kept');
    // The daemon sees the same code again next cycle.
    assert.strictEqual(rp.record(db, 1, 'QY1', ['A', 'B']), 0);
    const br = fakeBrowser(OK);
    await rp.fetchDue(db, br, { fetchImpl: fakeFetch(await picture()) });
    assert.strictEqual(br.asked.length, 0);
  });
  await it('removing the staff photo leaves the rider\'s', async () => {
    const db = await withTwoRiderPhotos();
    dp.put(db, 1, { data: STAFF });
    dp.removeByKey(db, 1, 's');
    assert.deepStrictEqual(dp.list(db, 1).map(x => x.kind), ['rider', 'rider']);
  });
  await it('rider photos give the order its slot, whatever its state', async () => {
    const db = await withTwoRiderPhotos();
    assert.strictEqual(dp.eligible(db, { id: 1, status: 'refunded', fulfillment_type: 'delivery' }), true);
  });
  await it('the stamp changes when a photo is added or removed', async () => {
    const db = await withTwoRiderPhotos();
    const before = dp.stamp(dp.list(db, 1));
    assert.ok(before);
    db.prepare("UPDATE retail_rider_photos SET fetched_at = datetime('now', '-1 day')").run();
    const older = dp.stamp(dp.list(db, 1));
    dp.put(db, 1, { data: STAFF });
    assert.notStrictEqual(dp.stamp(dp.list(db, 1)), older);
  });

  // ── The daemon's switch ─────────────────────────────────────────────────
  await it('the daemon fetches only behind QINGYUN_RIDER_PHOTOS, and notes codes regardless', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/qingyun-daemon.js'), 'utf8');
    assert.ok(/const RIDER_PHOTOS = process\.env\.QINGYUN_RIDER_PHOTOS === '1';/.test(src));
    const fetchAt = src.indexOf('riderPhotos.fetchDue(');
    const gate = src.lastIndexOf('if (RIDER_PHOTOS)', fetchAt);
    assert.ok(fetchAt > 0 && gate > 0 && fetchAt - gate < 200, 'fetchDue is not directly behind the switch');
    assert.ok(src.includes('riderPhotos.record(db,'), 'codes are not noted');
    assert.ok(!/if \(RIDER_PHOTOS\)[\s\S]{0,80}riderPhotos\.record/.test(src), 'noting the codes is behind the switch');
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) process.exit(1);
})();
