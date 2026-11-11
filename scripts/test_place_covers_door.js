#!/usr/bin/env node
/**
 * A picked place that does not name the building must not become the rider's pin.
 *
 *   node scripts/test_place_covers_door.js
 *
 * The waybill keeps the typed address. confirm-place used to write the chosen
 * place's coordinates anyway, so the rider read a correct address and navigated
 * to a pin kilometres away (the estate, or a hospital that only shares the
 * front of the name). This runs the shipped route against an in-memory SQLite.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const RETAIL = lf(path.join(ROOT, 'routes', 'retail.js'));
const DBJS = lf(path.join(ROOT, 'database.js'));
const DAEMON = lf(path.join(ROOT, 'scripts', 'qingyun-daemon.js'));
const { openQueueTableDb, addTables } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');
const addressPin = require('../lib/address-pin');
const qingyunQueue = require('../lib/qingyun-queue');
const pointMemory = require('../lib/delivery-point-memory');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }

function sliceFn(src, name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function sliceRoute(route) {
  const at = RETAIL.indexOf(`router.post('${route}'`);
  if (at === -1) throw new Error('route not found: ' + route);
  return RETAIL.slice(at, RETAIL.indexOf('\n});\n', at) + 5);
}

const SERVER_CODE = [
  sliceFn(RETAIL, '_qingyunPushRow'),
  sliceRoute('/api/retail-admin/orders/:id/qingyun/confirm-place'),
].join('\n');

const ADDR = {
  province: '广东省', city: '广州市', district: '番禺区',
  address: '祈福新村倚湖湾', detail: '5座1106',
};
const TOWER = { name: '祈福新村倚湖湾', lat: Math.round(22.960 * 1e6), lng: Math.round(113.320 * 1e6) };
const ESTATE = { name: '祈福新村', lat: Math.round(22.970 * 1e6), lng: Math.round(113.330 * 1e6) };
const HOSPITAL = { name: '祈福医院', lat: Math.round(22.985 * 1e6), lng: Math.round(113.345 * 1e6) };

function world() {
  const db = openQueueTableDb(DBJS);
  addTables(db, DBJS, DBJS, ['retail_orders', 'retail_delivery_point_memory']);
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, address_json, address_full, total)
              VALUES (585, 'TC002585', 'paid', ?, '广东省 广州市 番禺区 祈福新村倚湖湾 5座1106', 0)`)
    .run(JSON.stringify(ADDR));
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts)
              VALUES (585, 'YX', 'pending', 0)`).run();
  const row = db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 585').get();
  db.prepare(qingyunQueue.AWAITING_CHOICE_SQL).run(
    row.attempts, JSON.stringify([TOWER, ESTATE, HOSPITAL]),
    22.97, 113.33, null, 'pick one', row.id);
  const calls = { activity: [] };
  const ROUTES = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    router: { post: (p, ...h) => { ROUTES[p] = h[h.length - 1]; } },
    requireRetailAdmin: () => {}, express: { json: () => () => {} },
    tdb: () => db, withTransaction, addressPin, qingyunQueue, pointMemory,
    logActivity: (...a) => calls.activity.push(a),
    require: (m) => {
      if (m === '../lib/qingyun-payload') return require('../lib/qingyun-payload');
      throw new Error('unexpected require ' + m);
    },
    JSON, Object, String, Number, Math, Date, Error, Promise, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(SERVER_CODE, ctx);
  const handler = ROUTES['/api/retail-admin/orders/:id/qingyun/confirm-place'];
  const call = async (idx) => {
    let status = 200, out = null;
    const res = { status(c) { status = c; return res; }, json(j) { out = j; return res; } };
    await handler({ params: { id: '585' }, body: { idx }, user: { id: 1, username: 'ash' }, ip: '::1' }, res);
    return { status, body: out };
  };
  const order = () => JSON.parse(db.prepare('SELECT address_json FROM retail_orders WHERE id = 585').get().address_json);
  const queue = () => db.prepare('SELECT status, candidates_json FROM qingyun_push_queue WHERE retail_order_id = 585').get();
  return { db, call, order, queue, calls };
}

(async () => {
  console.log('\nconfirm-place refuses a place that is not the building');
  {
    const w = world();
    const r = await w.call(2);
    is([r.status, r.body.error, r.body.name], [422, 'place_is_area', '祈福医院'],
      '祈福医院 is refused — the pin would be the hospital, the words stay the tower');
    is(w.order().geo_source || null, null, 'the order pin is not written');
    is(w.queue().status, 'awaiting_choice', 'the list stays up');
    is(w.calls.activity.length, 0, 'nothing is logged as a pick');
  }
  {
    const w = world();
    const r = await w.call(1);
    is([r.status, r.body.error, r.body.name], [422, 'place_is_area', '祈福新村'],
      '祈福新村 is the estate, not 倚湖湾');
    is(w.queue().status, 'awaiting_choice', 'still waiting for the building');
  }
  {
    const w = world();
    const r = await w.call(0);
    is([r.status, r.body.success, r.body.name], [200, true, '祈福新村倚湖湾'],
      'the tower itself is accepted');
    const o = w.order();
    is([o.geo_source, o.lat, o.lng, o.address, o.detail],
      ['poi_picked', 22.96, 113.32, '祈福新村倚湖湾', '5座1106'],
      'the pin is the tower and the typed door is unchanged');
    is(w.queue().status, 'pending', 'the row goes back to the drain');
    is(w.queue().candidates_json, null, 'the list is cleared');
  }

  console.log('\nthe drain does not reuse a remembered place that is not the building');
  has(DAEMON, 'rememberedPickIsDoor', 'the drain asks the question again instead of replaying the wrong pin');
  has(RETAIL, 'place_is_area', 'confirm-place names the refusal');
  has(RETAIL, 'covers: qyPayload.placeCoversAddress', 'the pick list is told which rows are the area');

  console.log(fail ? `\n${fail} failed` : `\n${pass} passed`);
  process.exit(fail ? 1 : 0);
})();
