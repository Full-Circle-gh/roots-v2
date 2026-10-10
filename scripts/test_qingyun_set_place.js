#!/usr/bin/env node
/**
 * §448 — CHANGING A QINGYUN ORDER'S ADDRESS BY SEARCHING FOR IT.
 *
 *   node scripts/test_qingyun_set_place.js
 *
 * Two halves, both RUN rather than grepped:
 *
 *   A. The server route, POST /api/retail-admin/orders/:id/qingyun/set-place,
 *      sliced out of routes/retail.js and run against an in-memory SQLite built
 *      from the REAL table definitions in database.js, with the real payload
 *      builder, the real address-pin bounds check, the real queue SQL and the
 *      real transaction helper. Only Qingyun's browser is a stub.
 *   B. The tablet (public/m.html): the "Delivery address" block above the
 *      courier list, the Search a place sheet, and what it sends.
 *
 * No network, no browser, no install: it sits in the fast shard.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DBJS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const { openQueueTableDb, addTables } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');
const addressPin = require('../lib/address-pin');
const qingyunQueue = require('../lib/qingyun-queue');
const realPayload = require('../lib/qingyun-payload');
const { requiredCapFor } = require('../lib/cap-routes');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }

// ── Slicing the shipped source ─────────────────────────────────────────────
function sliceFn(src, name, isAsync) {
  const start = src.indexOf('\n' + (isAsync ? 'async ' : '') + 'function ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function sliceRoute(route) {
  const at = RETAIL.indexOf(`router.post('${route}'`);
  if (at === -1) throw new Error('route not found: ' + route);
  return RETAIL.slice(at, RETAIL.indexOf('\n});\n', at) + 5);
}
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}

const SERVER_CODE = [
  sliceFn(RETAIL, '_qingyunPushRow'),
  sliceFn(RETAIL, '_qingyunMoveBlockedBy'),
  sliceFn(RETAIL, 'deliveryJobStage'),
  sliceBetween(RETAIL, 'const _DROPOFF_SOURCES', '\n\n// Where this order is set to be collected'),
  sliceRoute('/api/retail-admin/orders/:id/qingyun/set-place'),
].join('\n');

// ── The world the route runs in ────────────────────────────────────────────
// The store sits at 23.13,113.33 (Tianhe). NEAR is ~2km away, FAR ~40km.
const SHOP = { shopId: 'S1', cityId: 20, name: '天河店', lat: 23.13, lng: 113.33 };
const NEAR = { name: '品秀星越花园', district: '天河区', lat: 23.142, lng: 113.345 };
const FAR = { name: '品秀星越花园', district: '增城区', lat: 23.29, lng: 113.68 };
const OLD_ADDR = { province: '广东省', city: '广州市', district: '天河区', address: '品秀星月花园', detail: 'A栋1203',
  lat: 23.2, lng: 113.4, geo_source: 'geocode:amap', geo_precision: 'street' };

function world(opts = {}) {
  const db = openQueueTableDb(DBJS);
  addTables(db, DBJS, DBJS, ['retail_orders', 'delivery_jobs', 'qingyun_sync_log']);
  const addr = Object.assign({}, OLD_ADDR, opts.addr || {});
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, recipient_name, recipient_phone, address_json, address_full, total)
              VALUES (7, 'TC000777', ?, '张三', '13000000868', ?, '广东省 广州市 天河区 品秀星月花园 A栋1203', 0)`)
    .run(opts.orderStatus || 'paid', JSON.stringify(addr));
  const q = Object.assign({ status: 'done', qingyun_order_id: 'QY-OLD' }, opts.queue || {});
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, qingyun_order_id, attempts)
              VALUES (7, 'TH', ?, ?, 0)`).run(q.status, q.qingyun_order_id);
  if (opts.job) {
    db.prepare(`INSERT INTO delivery_jobs (qingyun_order_id, store_code, retail_order_id, order_status, delivery_status, rider_name)
                VALUES (?, 'TH', 7, ?, ?, ?)`).run(opts.job.qy || 'QY-OLD', opts.job.order_status, opts.job.delivery_status ?? null, opts.job.rider_name ?? null);
  }
  const calls = { created: [], deleted: [], activity: [] };
  const br = {
    getShop: async () => (opts.noShop ? null : SHOP),
    createOrder: async (p) => {
      calls.created.push(p);
      if (opts.duringCreate) opts.duringCreate(db);
      return opts.createFails ? { ok: false, msg: 'portal said no' } : { ok: true, orderId: 'QY-NEW' };
    },
  };
  const ROUTES = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    router: { post: (p, ...h) => { ROUTES[p] = h[h.length - 1]; } },
    requireRetailAdmin: () => {}, express: { json: () => () => {} },
    tdb: () => db, withTransaction, addressPin, qingyunQueue,
    geocode: { configured: () => true, geocodeAddress: async () => null, isDeliverablePin: () => ({ ok: false }) },
    addressCn: { translateToChinese: async (s) => s },
    cfgValue: (k, d) => d, QY_GOODS_PIC_DEFAULT: 'pic',
    logActivity: (...a) => calls.activity.push(a),
    _qingyunDeleteCopy: async (store, id) => { calls.deleted.push(id); return opts.deleteFails ? { ok: false, msg: 'nope' } : { ok: true }; },
    require: (m) => {
      if (m === '../lib/qingyun-browser') return { getQingyunBrowser: async () => br };
      if (m === '../lib/qingyun-payload') return realPayload;
      throw new Error('unexpected require ' + m);
    },
    JSON, Object, String, Number, Math, Date, Error, Promise, Set, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(SERVER_CODE, ctx);
  const handler = ROUTES['/api/retail-admin/orders/:id/qingyun/set-place'];
  const call = async (body) => {
    let status = 200, out = null;
    const res = { status(c) { status = c; return res; }, json(j) { out = j; return res; } };
    await handler({ params: { id: '7' }, body, user: { id: 1, username: 'ash' }, ip: '::1' }, res);
    return { status, body: out };
  };
  const order = () => {
    const r = db.prepare('SELECT address_json, address_full FROM retail_orders WHERE id = 7').get();
    return { addr: JSON.parse(r.address_json), full: r.address_full };
  };
  const row = () => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 7').get();
  return { db, ctx, call, order, row, calls };
}
const pick = (p, detail) => Object.assign({}, p, { detail: detail == null ? 'A栋1203' : detail });

async function serverHalf() {
  console.log('\nA0 · the server gate');
  is(requiredCapFor('POST', '/api/retail-admin/orders/7/qingyun/set-place'), 'orders:edit',
    'set-place is orders:edit, not the money key — it calls nobody and charges nothing');

  console.log('\nA1 · a copy is waiting in Qingyun — it is swapped before the answer');
  {
    const w = world();
    const r = await w.call(pick(NEAR, ' B栋  805 '));
    is([r.status, r.body.success, r.body.recreated, r.body.qingyun_order_id], [200, true, true, 'QY-NEW'], 'answered only once the new copy exists');
    const o = w.order();
    is([o.addr.address, o.addr.district, o.addr.detail], ['品秀星越花园', '天河区', 'B栋 805'], 'the order reads the picked place and the typed room');
    is([o.addr.lat, o.addr.lng, o.addr.geo_source, o.addr.geo_precision], [NEAR.lat, NEAR.lng, 'poi_picked', null],
      "the point is the picked one, as 'poi_picked' — a name off a list, not a tapped building");
    is([o.addr.province, o.addr.city], ['广东省', '广州市'], 'province and city are kept');
    is(o.full, '广东省 广州市 天河区 品秀星越花园 B栋 805', 'the printed line follows');
    const p = w.calls.created[0];
    is([p.recipientLat, p.recipientLng], [Math.round(NEAR.lat * 1e6), Math.round(NEAR.lng * 1e6)], 'the new copy carries the picked point');
    has(p.recipientAddress, '品秀星越花园', 'and the picked name on the waybill');
    is(w.row().qingyun_order_id, 'QY-NEW', 'the queue row points at the new copy');
    const old = w.db.prepare("SELECT superseded, retail_order_id FROM delivery_jobs WHERE qingyun_order_id = 'QY-OLD'").get();
    is([old.superseded, old.retail_order_id], [1, null], 'the old copy is marked superseded, so the daemon never re-links it');
    is(w.calls.deleted, ['QY-OLD'], 'and deleted from the store list');
    is(w.calls.activity[0][2], 'qingyun_set_place', 'logged');
    is(w.calls.activity[0][5].before.address_full, '广东省 广州市 天河区 品秀星月花园 A栋1203', 'with what the customer had written');
  }

  console.log('\nA2 · refusals write nothing');
  const untouched = (w, m) => {
    is([w.order().addr.address, w.order().addr.geo_source, w.row().qingyun_order_id], ['品秀星月花园', 'geocode:amap', 'QY-OLD'], m);
  };
  {
    const w = world({ job: { order_status: 30, delivery_status: 20 } });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'courier_already_called'], 'a courier already on the old copy refuses');
    is(w.calls.created.length, 0, 'before asking Qingyun for anything');
    untouched(w, 'and the order is left as it was');
  }
  {
    const w = world({ job: { order_status: 20 } });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.recreated], [200, true], 'a tracked copy nobody was sent for (待配送) is still swappable');
  }
  {
    const w = world();
    const r = await w.call(pick(FAR));
    is([r.status, r.body.error], [422, 'too_far'], 'a picked place past 25km is refused — poi_picked keeps the distance rule');
    is(typeof r.body.drop_km === 'number' && r.body.drop_km > 25, true, 'and says how far');
    is(w.calls.created.length, 0, 'no copy is made');
    untouched(w, 'nothing is written');
  }
  {
    const w = world({ createFails: true });
    const r = await w.call(pick(NEAR));
    is([r.body.success, r.body.error], [false, 'create_failed'], 'Qingyun refusing the new copy says so');
    untouched(w, 'and the old address and copy still stand');
    is(w.calls.deleted, [], 'nothing is deleted');
  }
  {
    const w = world({ noShop: true });
    const r = await w.call(pick(NEAR));
    is([r.body.success, r.body.error], [false, 'store_unavailable'], 'no Qingyun session for the store says so');
    untouched(w, 'and writes nothing');
  }
  {
    // A dispatch lands on the OLD copy while the new one is being made.
    const w = world({ duringCreate: (db) => db.prepare(
      `INSERT INTO delivery_jobs (qingyun_order_id, store_code, retail_order_id, order_status, delivery_status)
       VALUES ('QY-OLD', 'TH', 7, 30, 10)`).run() });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'courier_already_called'], 'a dispatch that lands during the swap wins');
    is(w.calls.deleted, ['QY-NEW'], 'the copy just made is deleted, not left for someone to dispatch');
    untouched(w, 'and the order still points at the copy the courier holds');
  }
  {
    // Another swap repointed the row while this one was creating.
    const w = world({ duringCreate: (db) => db.prepare("UPDATE qingyun_push_queue SET qingyun_order_id = 'QY-OTHER' WHERE retail_order_id = 7").run() });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'row_moved'], 'a row that moved under it rolls back');
    is(w.calls.deleted, ['QY-NEW'], 'and its new copy is removed');
    is(w.order().addr.address, '品秀星月花园', 'the address write is rolled back with it');
  }
  {
    const w = world({ deleteFails: true });
    const r = await w.call(pick(NEAR));
    is([r.body.success, r.body.old_removed], [true, false], 'an old copy that would not delete is reported');
    is([w.row().stale_qingyun_order_id, w.row().stale_store_code], ['QY-OLD', 'TH'], 'and recorded, so the drawer offers Remove it');
  }

  console.log('\nA3 · no copy in Qingyun yet — the row goes back to the drain');
  {
    const w = world({ queue: { status: 'needs_point', qingyun_order_id: null } });
    w.db.prepare("UPDATE qingyun_push_queue SET needs_point_at = CURRENT_TIMESTAMP, guessed_lat = 23.1 WHERE retail_order_id = 7").run();
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.recreated, r.body.requeued, r.body.push_status], [200, false, true, 'pending'], 'a parked order is requeued');
    is([w.row().needs_point_at, w.row().guessed_lat], [null, null], 'its parked guess is cleared with it');
    is(w.order().addr.geo_source, 'poi_picked', 'and the order carries the picked point for the drain to use');
    is(w.calls.created.length, 0, 'no copy is made here — that is the drain\'s job');
  }
  for (const st of ['ready', 'awaiting_choice', 'error']) {
    const w = world({ queue: { status: st, qingyun_order_id: null } });
    const r = await w.call(pick(NEAR));
    is([r.body.success, r.body.push_status], [true, 'pending'], `a '${st}' row is requeued`);
  }
  {
    const w = world({ queue: { status: 'pending', qingyun_order_id: null } });
    const r = await w.call(pick(NEAR));
    is([r.body.success, r.body.requeued, r.body.push_status], [true, false, 'pending'], "a 'pending' row needs nothing more — the drain reads the order when it claims it");
  }
  {
    const w = world({ queue: { status: 'processing', qingyun_order_id: null } });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'row_busy'], 'a row being built right now is not raced');
    is(w.order().addr.address, '品秀星月花园', 'nothing written');
  }
  {
    const w = world({ queue: { status: 'skipped', qingyun_order_id: null } });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'push_retired'], 'a retired row is not brought back by an address');
  }

  console.log('\nA4 · bad input');
  for (const [body, code, m] of [
    [pick(Object.assign({}, NEAR, { name: '  ' })), 'bad_place', 'no name'],
    [pick(Object.assign({}, NEAR, { lat: 0, lng: 0 })), 'bad_point', '0,0 is absent, not a place'],
    [pick(Object.assign({}, NEAR, { lat: 48.85, lng: 2.35 })), 'bad_point', 'a point outside China'],
  ]) {
    const w = world();
    const r = await w.call(body);
    is([r.status, r.body.error], [400, code], m);
    is(w.calls.created.length, 0, '…and Qingyun is not asked');
  }
  {
    const w = world({ orderStatus: 'cancelled' });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [409, 'order_closed'], 'a closed order is refused');
  }
  {
    const w = world({ addr: { pickup: true } });
    const r = await w.call(pick(NEAR));
    is([r.status, r.body.error], [422, 'pickup_order'], 'a pickup order has no address to change');
  }

  console.log('\nA5 · where the "Delivery address" map points');
  {
    const w = world({ job: { order_status: 20 } });
    w.db.prepare("UPDATE delivery_jobs SET recipient_lat = 23150000, recipient_lng = 113350000 WHERE qingyun_order_id = 'QY-OLD'").run();
    is(w.ctx._qingyunDropoff(7, w.row()), { lat: 23.15, lng: 113.35, from: 'qingyun' }, "Qingyun's own copy first — that is the point a rider sees");
  }
  {
    const w = world();
    is(w.ctx._qingyunDropoff(7, w.row()), { lat: 23.2, lng: 113.4, from: 'order', source: 'geocode:amap' }, 'before the daemon reads it back, the order\'s own trusted point');
  }
  {
    const w = world({ addr: { geo_precision: 'coarse' } });
    is(w.ctx._qingyunDropoff(7, w.row()), null, 'an unverified point is not drawn — the push would re-resolve it');
  }
  {
    const w = world({ addr: { lat: null, lng: null, geo_source: null } });
    is(w.ctx._qingyunDropoff(7, w.row()), null, 'no point at all is null, and the screen says so');
  }
  has(RETAIL, 'dropoff: _qingyunDropoff(retailOrderId, q),', 'the drawer payload carries it');
}

// ── B. The tablet ──────────────────────────────────────────────────────────
const M_CODE = [
  sliceBetween(MHTML, '/* ── §325 O8 — SAME-CITY RIDER OPERATIONS', '/* The printer can succeed'),
  sliceFn(MHTML, 'shipFromCard'), sliceFn(MHTML, 'orderWrite', true), sliceFn(MHTML, 'rereadOrder', true), sliceFn(MHTML, 'orderErrorText'),
  sliceBetween(MHTML, 'const M_COURIER_STALE_MS=', 'function riderDist('),
].join('\n');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const ALL = ['orders:view', 'orders:edit', 'orders:dispatch_courier'];
const SHIPTO = { name: '张三', phone: '130', province: '广东省', city: '广州市', district: '天河区', address: '品秀星月花园', detail: 'A栋1203' };
const CARRIERS = { available: true, carriers: [{ carrierId: 1, serviceCode: 's1', serviceName: 'Fengniao', carrierName: 'Ele', feeYuan: 12, enabled: true, cheapest: true }] };
const POI = [{ name: '品秀星越花园', address: '广东省广州市天河区花城大道', district: '天河区', lat: 23.142, lng: 113.345 },
  { name: '品秀大厦', address: '广东省广州市越秀区', district: '越秀区', lat: 23.12, lng: 113.27 }];

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const timers = [];
  const order = Object.assign({ id: 'TC7', _id: 7, raw: 'paid', viewOnly: false, courier: null,
    shipments: [{ id: 3, mode: 'local', state: 'pending', items: [] }],
    shipFrom: { qingyun_order_id: 'QY1', store_code: 'TH', dropoff: { lat: 23.15, lng: 113.35, from: 'qingyun' } },
    shipTo: SHIPTO }, opts.order || {});
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (k) => `<i data-ic="${k}"></i>`, money: (c, v) => c + Number(v || 0).toFixed(2),
    fmtTime: (v) => (v ? 'H(' + v + ')' : ''), _date: (v) => (v ? new Date(v) : null),
    mCan: (k) => { const c = ctx.state.caps; return c ? c.includes(k) : true; },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, orderBusy: null, orderErr: null, ask: null,
      detailId: 'TC7', liveDetail: null, qy: null, qyPlace: null, focus: null },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    currentOrder: () => order, findOrder: () => order,
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => {}, refreshOrders: () => {},
    mapDetail: (d) => d,
    document: { getElementById: (id) => els[id] || null },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
    api: (p) => { calls.reads.push(p); return Promise.resolve(p.indexOf('/carriers') !== -1 ? CARRIERS : {}); },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p, body) : null;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { success: true });
    },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, isFinite, Infinity,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.APP = { cmd: (k, ...a) => CMD[k](...a) };
  vm.createContext(ctx);
  vm.runInContext(M_CODE, ctx);
  const flush = () => { const fs2 = timers.splice(0); fs2.forEach((f) => f()); };
  els.mQyPlaceList = { innerHTML: '' };
  return { ctx, CMD, calls, order, flush, els };
}

async function tabletHalf() {
  console.log('\nB1 · the courier list opens with where the rider goes');
  {
    const m = mk();
    m.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: {} };
    const h = m.ctx.qyCarrierPanel(m.order);
    has(h, 'Ship to', 'headed as the order sheet heads the address');
    has(h, '天河区 品秀星月花园 A栋1203', 'the address the waybill reads');
    has(h, 'id="qyDestMap" data-lat="23.15" data-lng="113.35"', 'a map of the point the rider is sent to');
    has(h, "APP.cmd('qyPlaceOpen')", 'and Search a place');
    is(h.indexOf('qyDestMap') < h.indexOf("APP.cmd('qyCarrierT'"), true, 'above the couriers, so it is read before one is ticked');
    const n = mk({ order: { shipFrom: { qingyun_order_id: 'QY1', dropoff: null } } });
    n.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: {} };
    const nh = n.ctx.qyCarrierPanel(n.order);
    has(nh, 'No point placed yet', 'no known point says so');
    hasnt(nh, 'qyDestMap', 'rather than drawing a map of nothing');
    const r = mk({ caps: ['orders:view', 'orders:dispatch_courier'] });
    r.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: {} };
    hasnt(r.ctx.qyCarrierPanel(r.order), 'qyPlaceOpen', 'without orders:edit, the address is shown but not offered for change');
    const c = mk({ lang: 'cn' });
    c.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: {} };
    const ch = c.ctx.qyCarrierPanel(c.order);
    has(ch, '收货地址', 'in Chinese: 收货地址, the live word'); has(ch, '搜索地点', '搜索地点');
  }

  console.log('\nB2 · the parked cards offer it too');
  {
    const np = mk({ order: { shipFrom: { awaiting_point: true, qingyun_order_id: null } } });
    has(np.ctx.shipFromCard(np.order), "APP.cmd('qyPlaceOpen')", 'Confirm delivery point — the phone can now answer it by typing');
    has(np.ctx.shipFromCard(np.order), 'The point is placed on the desktop map.', 'and the desktop map is still named, for a tap');
    const ch = mk({ order: { shipFrom: { awaiting_choice: true, qingyun_order_id: null, candidates: [{ idx: 0, name: '汇景新城', address: '天河区', lat: 23.1, lng: 113.3 }] } } });
    has(ch.ctx.shipFromCard(ch.order), "APP.cmd('qyPlaceOpen')", 'Pick the delivery point — for when none of the list is right');
    const rf = mk({ order: { shipFrom: { needs_attention: true, qingyun_order_id: null, push_error: 'x' } } });
    has(rf.ctx.shipFromCard(rf.order), "APP.cmd('qyPlaceOpen')", 'Push refused — beside Retry push');
    const ro = mk({ caps: ['orders:view'], order: { shipFrom: { awaiting_point: true, qingyun_order_id: null } } });
    hasnt(ro.ctx.shipFromCard(ro.order), 'qyPlaceOpen', 'not for a reader');
  }

  console.log('\nB3 · typing searches on a pause, never mid-pinyin');
  {
    const m = mk({ respond: (p) => (p === '/poi-search' ? { success: true, data: POI } : { success: true }) });
    m.CMD.qyPlaceOpen();
    is(m.ctx.state.qyPlace && m.ctx.state.focus, { id: 'mQyPlaceKw' }, 'the sheet opens with the box focused');
    m.CMD.qyPlaceKw('p', false); m.flush(); await tick();
    is(m.calls.writes.length, 0, 'one character is not a search');
    m.CMD.qyPlaceKw('pinxiu', true); m.flush(); await tick();
    is(m.calls.writes.length, 0, 'letters still being composed by the input method are not a search');
    m.CMD.qyPlaceKw('品秀', false);
    is(m.calls.writes.length, 0, 'nothing is sent until the pause');
    m.flush(); await tick();
    is(m.calls.writes, [{ p: '/poi-search', method: 'POST', body: { keyword: '品秀', city: '广州市', lat: 23.15, lng: 113.35 } }],
      "one search, in the order's city, biased to the point it has");
    has(m.els.mQyPlaceList.innerHTML, "APP.cmd('qyPlacePick',0)", 'results are painted in place');
    has(m.els.mQyPlaceList.innerHTML, '品秀大厦', 'every one');
    hasnt(m.els.mQyPlaceList.innerHTML, 'aria-checked', 'none pre-selected');
    const e = mk({ respond: () => ({ success: true, data: [] }) });
    e.CMD.qyPlaceOpen(); e.CMD.qyPlaceKw('无此地', false); e.flush(); await tick();
    has(e.els.mQyPlaceList.innerHTML, 'No places found', 'an empty answer says so');
    const k = mk({ respond: () => ({ success: false, error: 'maps_key_missing' }) });
    k.CMD.qyPlaceOpen(); k.CMD.qyPlaceKw('品秀', false); k.flush(); await tick();
    has(k.els.mQyPlaceList.innerHTML, 'Load failed', 'a lookup that could not run is not "nothing found"');
  }

  console.log('\nB4 · pick, type the room, save');
  {
    const m = mk({ respond: (p) => (p === '/poi-search' ? { success: true, data: POI }
      : { success: true, recreated: true, qingyun_order_id: 'QY-NEW', name: '品秀星越花园' }) });
    m.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: {} };
    m.CMD.qyPlaceOpen(); m.CMD.qyPlaceKw('品秀', false); m.flush(); await tick();
    m.CMD.qyPlacePick(0);
    const sh = m.ctx.sheetQyPlace();
    has(sh, 'id="qyPlaceMap" data-lat="23.142" data-lng="113.345"', 'the picked place is shown on a map, to look at');
    has(sh, 'value="A栋1203"', 'the room the order had is kept, ready to edit');
    has(sh, '天河区 品秀星月花园 A栋1203', 'with what the customer wrote above it');
    m.CMD.qyPlaceDetail('B栋805');
    m.calls.writes.length = 0;
    m.CMD.qyPlaceSave(); await tick(12);
    is(m.calls.writes[0], { p: '/orders/7/qingyun/set-place', method: 'POST',
      body: { name: '品秀星越花园', district: '天河区', lat: 23.142, lng: 113.345, detail: 'B栋805' } }, 'POST …/qingyun/set-place with the place and the room');
    is(m.calls.toasts, ['Address updated'], 'confirmed');
    is(m.ctx.state.qyPlace, null, 'the sheet closes');
    is(m.calls.reads, ['/orders/7', '/orders/7/qingyun/carriers'], 'the order is read again, and the courier prices with it — the old ones were for the old copy');
  }
  {
    const m = mk({ order: { shipFrom: { awaiting_point: true, qingyun_order_id: null } },
      respond: (p) => (p === '/poi-search' ? { success: true, data: POI } : { success: true, recreated: false, requeued: true, push_status: 'pending', name: '品秀星越花园' }) });
    m.CMD.qyPlaceOpen(); m.CMD.qyPlaceKw('品秀', false); m.flush(); await tick();
    m.CMD.qyPlacePick(0); m.CMD.qyPlaceSave(); await tick(12);
    is(m.calls.toasts, ['Picked 品秀星越花园 — sending it to the channel, about a minute'], 'a parked order says it is on its way, in the words Pick the delivery point uses');
    is(m.calls.reads, ['/orders/7'], 'no prices to reload');
  }
  for (const [resp, want] of [
    [{ success: false, error: 'too_far', drop_km: 41.2 }, 'That place is 41.2 km from the store — too far for a same-city rider'],
    [{ success: false, error: 'courier_already_called' }, 'A courier is already on it — cancel it in the Qingyun app first'],
    [{ success: false, error: 'create_failed', detail: '超出范围' }, 'Save failed: 超出范围'],
    [{ success: false, error: 'store_unavailable' }, "That location's Qingyun account isn't wired up yet — ask ops to set it up"],
    [{ success: false, error: 'row_busy' }, 'Being sent right now — try again in a moment'],
  ]) {
    const m = mk({ respond: (p) => (p === '/poi-search' ? { success: true, data: POI } : resp) });
    m.CMD.qyPlaceOpen(); m.CMD.qyPlaceKw('品秀', false); m.flush(); await tick();
    m.CMD.qyPlacePick(0); m.CMD.qyPlaceSave(); await tick(12);
    is([m.ctx.state.qyPlace && m.ctx.state.qyPlace.saveErr, m.ctx.state.qyPlace && m.ctx.state.qyPlace.saving], [want, false], resp.error + ' — said in the sheet, which stays open');
  }
  {
    const m = mk({ caps: ['orders:view'] });
    m.CMD.qyPlaceOpen();
    is(m.ctx.state.qyPlace, null, 'without orders:edit the sheet does not open');
  }

  console.log('\nB5 · wiring');
  has(MHTML, "html += layer('qyplace', sheetQyPlace());", 'the sheet is drawn, under one layer key so a pick does not slide it in again');
  has(MHTML, 'ptMapSync();', 'the map is put back after each repaint');
  has(MHTML, "state.jd=null; if(state.qyPlace) clearTimeout(state.qyPlace.timer); state.qyPlace=null;", 'closing the order closes the sheet');
}

(async () => {
  try { await serverHalf(); } catch (e) { bad('server half crashed', e.stack); }
  try { await tabletHalf(); } catch (e) { bad('tablet half crashed', e.stack); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
