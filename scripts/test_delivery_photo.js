#!/usr/bin/env node
/**
 * The delivery photo: one per order, images only, and only the customer whose
 * order it is can reach it (§261).
 *
 *   node scripts/test_delivery_photo.js
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. The customer route is scoped by customer_id. The picture is somebody's
 *      front door; an order id on its own must open nothing. And the photo is
 *      never written to retail_media, whose route needs no login and counts up.
 *   2. A second upload REPLACES the first — the customer sees "the" photo.
 *   3. Only an image data URI is stored (no SVG, no HEIC the mini app cannot
 *      draw, no arbitrary string rendered into an <img src>).
 *   4. The slot is offered only on a same-city delivery that has left the shop,
 *      and never taken away from an order already carrying a photo.
 *
 * THE SCHEMA UNDER TEST IS READ OUT OF database.js, not copied here, so the
 * test cannot go green while the shipped table drifts. The three tables it
 * only reads from are the few columns eligible() touches.
 *
 * No network, no server — an in-memory SQLite and lib/delivery-photo.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, driver } = require('./test-support/memory-db');
const dp = require('../lib/delivery-photo');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DB_SRC = read('database.js');
const TABLE = DB_SRC.match(/db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS retail_delivery_photos[\s\S]*?)`\);/);
if (!TABLE) { console.error('could not find the retail_delivery_photos schema in database.js'); process.exit(1); }

function fresh() {
  const db = openMemoryDb();
  db.exec(`CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, status TEXT,
             fulfillment_type TEXT, customer_id INTEGER)`);
  db.exec(`CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT)`);
  db.exec(`CREATE TABLE delivery_jobs (id INTEGER PRIMARY KEY, retail_order_id INTEGER)`);
  db.exec(TABLE[1]);
  return db;
}
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64');
const PNG  = 'data:image/png;base64,'  + Buffer.from('not really a png').toString('base64');
const order = (db, id, status, extra = {}) => {
  db.prepare('INSERT INTO retail_orders (id, status, fulfillment_type, customer_id) VALUES (?,?,?,?)')
    .run(id, status, extra.ft || 'delivery', extra.customer ?? 7);
  if (extra.local !== false) db.prepare("INSERT INTO retail_shipments (order_id, mode) VALUES (?, ?)")
    .run(id, extra.mode || 'local');
  return db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
};

console.log(`test_delivery_photo (${driver})`);

// ── 1. Who can reach it ─────────────────────────────────────────────────────
const ROUTES = read('routes/retail.js');
function routeBody(method, url) {
  const at = ROUTES.indexOf(`router.${method}('${url}'`);
  assert.ok(at >= 0, `no ${method.toUpperCase()} ${url}`);
  const end = ROUTES.indexOf('\n});', at);
  return ROUTES.slice(at, end);
}
it('the customer route is scoped by customer_id and requires a login', () => {
  const b = routeBody('get', '/api/retail/orders/:id/delivery-photo');
  assert.ok(/requireRetailAuth/.test(b), 'no requireRetailAuth');
  assert.ok(/WHERE id = \? AND customer_id = \?/.test(b), 'not scoped to the customer');
  assert.ok(/req\.customer\.id/.test(b), 'does not bind the logged-in customer');
});
it('the admin routes are behind requireRetailAdmin', () => {
  for (const m of ['post', 'get', 'delete']) {
    assert.ok(/requireRetailAdmin/.test(routeBody(m, '/api/retail-admin/orders/:id/delivery-photo')), m);
  }
});
it('the photo is never stored in retail_media (the public, counting-id route)', () => {
  assert.ok(!/retail_media/.test(read('lib/delivery-photo.js')));
  for (const m of ['post', 'get', 'delete']) {
    assert.ok(!/retail_media/.test(routeBody(m, '/api/retail-admin/orders/:id/delivery-photo')), m);
  }
  assert.ok(!/retail_media/.test(routeBody('get', '/api/retail/orders/:id/delivery-photo')));
});

// ── 2. One per order ────────────────────────────────────────────────────────
it('meta carries no bytes; data returns the picture', () => {
  const db = fresh(); order(db, 1, 'delivered');
  dp.put(db, 1, { data: JPEG, actor: { id: 3, label: 'ash' } });
  const m = dp.meta(db, 1);
  assert.strictEqual(m.source, 'staff');
  assert.strictEqual(m.by, 'ash');
  assert.ok(!('data' in m), 'meta leaked the bytes');
  assert.strictEqual(dp.data(db, 1), JPEG);
});
it('a second upload replaces the first — one row, the new picture, the new uploader', () => {
  const db = fresh(); order(db, 1, 'delivered');
  dp.put(db, 1, { data: JPEG, actor: { id: 3, label: 'ash' } });
  dp.put(db, 1, { data: PNG, actor: { id: 4, label: 'mei' } });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM retail_delivery_photos').get().n, 1);
  assert.strictEqual(dp.data(db, 1), PNG);
  assert.strictEqual(dp.meta(db, 1).by, 'mei');
});
it('photos on two orders stay apart', () => {
  const db = fresh(); order(db, 1, 'delivered'); order(db, 2, 'delivered');
  dp.put(db, 1, { data: JPEG }); dp.put(db, 2, { data: PNG });
  assert.strictEqual(dp.data(db, 1), JPEG);
  assert.strictEqual(dp.data(db, 2), PNG);
});
it('remove takes it off, and says whether there was one', () => {
  const db = fresh(); order(db, 1, 'delivered');
  dp.put(db, 1, { data: JPEG });
  assert.strictEqual(dp.remove(db, 1), true);
  assert.strictEqual(dp.meta(db, 1), null);
  assert.strictEqual(dp.data(db, 1), null);
  assert.strictEqual(dp.remove(db, 1), false);
});

// ── 3. Images only ──────────────────────────────────────────────────────────
it('refuses anything but a JPEG / PNG / WebP data URI', () => {
  const db = fresh(); order(db, 1, 'delivered');
  const bad = [
    '', 'hello', 'https://example.com/x.jpg',
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
    'data:image/heic;base64,AAAA',
    'data:text/html;base64,PGgxPmhpPC9oMT4=',
    'data:image/jpeg;base64,AAAA" onerror="alert(1)',
  ];
  for (const b of bad) {
    assert.throws(() => dp.put(db, 1, { data: b }), (e) => e.code === 'bad_image', JSON.stringify(b.slice(0, 30)));
  }
  assert.strictEqual(dp.meta(db, 1), null);
});
it('refuses a picture over the cap', () => {
  const db = fresh(); order(db, 1, 'delivered');
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(dp.MAX_CHARS);
  assert.throws(() => dp.put(db, 1, { data: big }), (e) => e.code === 'too_large');
});
it('refuses an unknown source', () => {
  const db = fresh(); order(db, 1, 'delivered');
  assert.throws(() => dp.put(db, 1, { data: JPEG, source: 'anyone' }), (e) => e.code === 'bad_source');
  dp.put(db, 1, { data: JPEG, source: 'qingyun' });
  assert.strictEqual(dp.meta(db, 1).source, 'qingyun');
});

// ── 4. Where the slot is offered ────────────────────────────────────────────
it('a same-city parcel that has left the shop gets the slot', () => {
  const db = fresh();
  assert.strictEqual(dp.eligible(db, order(db, 1, 'dispatched')), true);
  assert.strictEqual(dp.eligible(db, order(db, 2, 'delivered')), true);
});
it('not before it leaves, and not once it is cancelled', () => {
  const db = fresh();
  for (const [id, s] of [[1, 'pending_payment'], [2, 'paid'], [3, 'preparing'], [4, 'cancelled'], [5, 'refunded']]) {
    assert.strictEqual(dp.eligible(db, order(db, id, s)), false, s);
  }
});
it('not on a pickup or counter order', () => {
  const db = fresh();
  assert.strictEqual(dp.eligible(db, order(db, 1, 'delivered', { ft: 'pickup' })), false);
  assert.strictEqual(dp.eligible(db, order(db, 2, 'delivered', { ft: 'counter' })), false);
});
it('not on an air or land parcel, but yes where a Qingyun job is linked', () => {
  const db = fresh();
  assert.strictEqual(dp.eligible(db, order(db, 1, 'delivered', { mode: 'air' })), false);
  const o = order(db, 2, 'delivered', { local: false });
  assert.strictEqual(dp.eligible(db, o), false);
  db.prepare('INSERT INTO delivery_jobs (retail_order_id) VALUES (?)').run(2);
  assert.strictEqual(dp.eligible(db, o), true);
});
it('an order already carrying a photo keeps its slot, whatever its state', () => {
  const db = fresh();
  const o = order(db, 1, 'delivered');
  dp.put(db, 1, { data: JPEG });
  db.prepare("UPDATE retail_orders SET status = 'refunded' WHERE id = 1").run();
  assert.strictEqual(dp.eligible(db, { ...o, status: 'refunded' }), true);
});

// ── 5. Every screen names it the same way ──────────────────────────────────
it('the one composed pair ships on all five surfaces and is declared', () => {
  assert.ok(read('public/retail-admin/04-orders.js').includes("cuT('Delivery photo', '送达照片')"));
  assert.ok(read('public/m.html').includes("T('Delivery photo','送达照片')"));
  // The web shop picks the English plural when there is more than one photo
  // (§261 addendum); the Chinese is the same pair either way.
  const shop = read('public/shop.html');
  assert.ok(shop.includes("cn?'送达照片':(") && shop.includes("'Delivery photos':'Delivery photo'"), 'web shop label');
  const mini = read('miniapp/pages/order/order.js');
  assert.ok(mini.includes("deliveryPhotoLabel: '送达照片'") && mini.includes("deliveryPhotoLabel: 'DELIVERY PHOTO'"));
  assert.ok(mini.includes("deliveryPhotosLabel: '送达照片'") && mini.includes("deliveryPhotosLabel: 'DELIVERY PHOTOS'"));
  assert.ok(/Delivery photo · 送达照片/.test(read('docs/tacet-delivery-vocabulary.md')), 'not declared');
});
it("the staff screens number the photos — never 'Rider 1 / Rider 2', which reads as two riders", () => {
  for (const [f, pair] of [['public/retail-admin/04-orders.js', "cuT('Photo', '照片')"], ['public/m.html', "T('Photo','照片')"]]) {
    const src = read(f);
    const at = src.indexOf(f.endsWith('.js') ? 'function renderDeliveryPhoto(' : 'function deliveryPhotoCard(');
    assert.ok(at > 0, f);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(body.includes(pair), `${f}: chips are not "Photo · 照片"`);
    assert.ok(!/'Rider'|'骑手'|'Shop'|'门店'/.test(body), `${f}: a chip is still named for who took it`);
  }
  assert.ok(/`Photo · 照片`/.test(read('docs/tacet-delivery-vocabulary.md')), 'Photo · 照片 not declared');
});

// ── 6. The phone can actually open one ─────────────────────────────────────
// The phone's api() strips the route's {success, data} envelope; the desktop's
// does not. The phone's viewers were written in the desktop's shape
// (j.data.data), so every tap on a chip said "Photo not found" while the photo
// sat in the database. This runs the phone's REAL api() against the route's
// REAL answer and then the viewers' own read of it.
async function phoneOpensPhoto() {
  const src = read('public/m.html');
  const at = src.indexOf('async function api(path){');
  assert.ok(at > 0, 'phone api() not found');
  const apiSrc = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const URI = 'data:image/jpeg;base64,/9j/AA==';
  const fetch = async () => ({ status: 200, ok: true,
    json: async () => ({ success: true, data: { data: URI } }) });   // the route's shape
  const api = new Function('fetch', 'apiURL', 'location', `${apiSrc}; return api;`)(fetch, (p) => p, {});
  const j = await api('/orders/1/delivery-photo?key=r1');
  for (const cmd of ["reg('dphView'", "reg('dcViewEv'"]) {
    const i = src.indexOf(cmd);
    assert.ok(i > 0, cmd);
    const m = /const data=([^;]+);/.exec(src.slice(i, src.indexOf('\n});', i)));
    assert.ok(m, `${cmd}: no "const data=" read`);
    const got = new Function('j', `return (${m[1]});`)(j);
    assert.strictEqual(got, URI, `${cmd}: reads ${m[1]} and finds no picture`);
  }
}

phoneOpensPhoto().then(() => { pass++; console.log('  ✓ the phone opens a stored photo (dphView, dcViewEv)'); },
  (e) => { fails.push(['phone opens photo', e.message]); console.log('  ✗ the phone opens a stored photo\n      ' + e.message); })
  .then(() => {
    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) process.exit(1);
  });
