#!/usr/bin/env node
/**
 * §325 step O8 — SAME-CITY RIDER OPERATIONS ON THE PHONE.
 *
 *   node scripts/test_mobile_rider_ops.js
 *
 * From the desktop's courier block (public/retail-admin/04-orders.js,
 * renderQyShipFrom / renderQyDispatch and the parked surfaces):
 *   1. Retry push — POST /orders/:id/qingyun/retry-push;
 *   2. Remove the old job — POST …/qingyun/remove-stale;
 *   3. pick a place — POST …/qingyun/confirm-place {idx};
 *   4. Change where it ships from — GET …/qingyun/ship-from, then
 *      POST …/qingyun/ship-from {store_code} after a confirm;
 *   5. move the delivery day — POST …/qingyun/reschedule {date};
 *   6. compare couriers and dispatch — GET …/qingyun/carriers, then
 *      POST …/qingyun/dispatch {carriers} after a confirm.
 * 1–5 are orders:edit; 6 is orders:dispatch_courier and charges the shop's
 * Qingyun balance, so it is drawn only once the account's keys are known.
 * Placing a point on a map stays on the desktop (§97, held by §325.4).
 *
 * The code is RUN, sliced out of public/m.html, so this needs no browser and
 * sits in the fast shard. Every request is asserted on method, path and body.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
// Line breaks inside a call collapsed, so a pair the desktop wraps over lines still matches whole.
const DESKN = DESK.replace(/\s*\n\s*/g, ' ').replace(/cuT\( /g, 'cuT(');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name, isAsync) {
  const start = src.indexOf('\n' + (isAsync ? 'async ' : '') + 'function ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}
const CODE = [
  sliceBetween('/* ── §325 O8 — SAME-CITY RIDER OPERATIONS', '/* The printer can succeed'),
  sliceFn('shipFromCard'), sliceFn('orderWrite', true), sliceFn('rereadOrder', true), sliceFn('orderErrorText'),
  sliceBetween('const M_COURIER_STALE_MS=', 'function riderDist('),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
].join('\n');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const fault = (code, body) => Object.assign(new Error(code), { code, body: body || { success: false, error: code } });
const ALL = ['orders:view', 'orders:edit', 'orders:dispatch_courier'];
const LOCAL = [{ id: 3, mode: 'local', state: 'pending', items: [] }];
const CREATED = { qingyun_order_id: 'QY1', store_code: 'TH', name_en: 'Tianhe', name_cn: '天河' };
const BJ = (i) => new Date(Date.now() + 8 * 3600000 + i * 86400000).toISOString().slice(0, 10);
const CARRIERS = { available: true, carriers: [
  { carrierId: 1, serviceCode: 's1', serviceName: 'Fengniao', carrierName: 'Ele', feeYuan: 12, distanceM: 3200, enabled: true, cheapest: true },
  { carrierId: 2, serviceCode: 's2', serviceName: 'Shansong', carrierName: 'SS', feeYuan: 15.5, enabled: true },
  { carrierId: 3, serviceCode: 's3', serviceName: 'Off', carrierName: 'X', feeYuan: 9, enabled: false }] };
const STORES = { available: true, current: 'TH', blocked_by: null, stores: [
  { code: 'TH', name_en: 'Tianhe', name_cn: '天河', connected: true },
  { code: 'YX', name_en: 'Yuexiu', name_cn: '越秀', connected: true },
  { code: 'PY', name_en: 'Panyu', name_cn: '番禺', connected: false }] };

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const order = Object.assign({ id: 'TC7', _id: 7, raw: 'paid', viewOnly: false, shipments: LOCAL, courier: null, shipFrom: null, shipTo: { name: 'Li' } }, opts.order || {});
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (k) => `<i data-ic="${k}"></i>`, money: (c, v) => c + Number(v || 0).toFixed(2),
    fmtTime: (v) => (v ? 'H(' + v + ')' : ''), _date: (v) => (v ? new Date(v) : null),
    mCan: (k) => { const c = ctx.state.caps; return c ? c.includes(k) : k !== 'finance:view'; },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, orderBusy: null, orderErr: null, ask: null, askErr: null,
      detailId: 'TC7', liveDetail: null, qy: null },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    currentOrder: () => order, findOrder: () => order,
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => {}, refreshOrders: () => {},
    mapDetail: (d) => d,
    api: (p) => {
      calls.reads.push(p);
      const r = opts.read ? opts.read(p) : {};
      if (r instanceof Error) return Promise.reject(r);
      if (r && r.then) return r;
      return Promise.resolve(r);
    },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p) : null;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { success: true });
    },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, isFinite, Infinity,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls, order };
}
const sfo = (sf, extra) => Object.assign({ shipFrom: sf }, extra || {});

async function main() {
  console.log('\n0 · the server gate');
  {
    const A = '/api/retail-admin/orders/7/qingyun/';
    for (const p of ['retry-push', 'remove-stale', 'ship-from', 'reschedule', 'confirm-place']) is(requiredCapFor('POST', A + p), 'orders:edit', 'POST ' + p + ' is orders:edit');
    is(requiredCapFor('POST', A + 'dispatch'), 'orders:dispatch_courier', 'POST dispatch is orders:dispatch_courier');
    is([requiredCapFor('GET', A + 'carriers'), requiredCapFor('GET', A + 'ship-from')], [null, null], 'the two reads are open');
  }

  console.log('\n1 · Retry push');
  {
    const o = sfo({ needs_attention: true, push_error: 'address not pinnable' });
    const m = mk({ order: o });
    const h = m.ctx.shipFromCard(m.order);
    has(h, "APP.cmd('qyRetryPush')", 'a refused push offers Retry'); has(h, 'Retry push', 'labelled as the desktop labels it');
    has(h, 'Fix the delivery address (Edit ship-to, or Make address Chinese) and it retries on its own — or press Retry.', 'with the desktop\'s instruction, now that both are on the phone');
    const r = mk({ order: o, caps: ['orders:view'] }).ctx.shipFromCard(m.order);
    has(r, 'Push refused', 'a reader still sees the refusal'); hasnt(r, 'qyRetryPush', 'and no button (capability-denied)'); hasnt(r, 'press Retry', 'nor a sentence pointing at one');
    m.CMD.qyRetryPush(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/retry-push', method: 'POST', body: {} }], 'POST …/qingyun/retry-push');
    is([m.calls.toasts, m.calls.reads], [['Queued — sending it to the channel, about a minute'], ['/orders/7']], 'queued, and the order read again');
    const a = mk({ order: o, respond: () => ({ success: true, already_created: true }) }); a.CMD.qyRetryPush(); await tick();
    is(a.calls.toasts, ['Already on the courier platform'], 'already created says so');
    for (const [resp, want] of [[fault('order_not_in_qingyun'), 'Could not queue it'], [REFUSAL(), 'Your role does not include this action.']]) {
      const x = mk({ order: o, respond: () => resp }); x.CMD.qyRetryPush(); await tick();
      is([String(x.ctx.state.orderErr), x.calls.toasts], [want, []], 'a failure says so, not toasted: ' + want);
    }
    const d = mk({ order: o, caps: ['orders:view'] }); d.CMD.qyRetryPush(); await tick();
    is(d.calls.writes, [], 'without orders:edit nothing is sent');
    m.ctx.state.orderBusy = 'qyretry'; has(m.ctx.shipFromCard(m.order), 'Queuing…', 'busy says so');
  }

  console.log('\n2 · Remove the old job');
  {
    const o = sfo(Object.assign({}, CREATED, { stale: { store_code: 'YX', name_en: 'Yuexiu', name_cn: '越秀' } }));
    const m = mk({ order: o });
    const h = m.ctx.shipFromCard(m.order);
    has(h, 'The old job at Yuexiu is still in Qingyun', 'the warning'); has(h, "APP.cmd('qyRemoveStale')", 'and Remove it');
    hasnt(mk({ order: o, caps: ['orders:view'] }).ctx.shipFromCard(m.order), 'qyRemoveStale', 'not for a reader');
    m.CMD.qyRemoveStale(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/remove-stale', method: 'POST', body: {} }], 'POST …/qingyun/remove-stale, no confirm (the desktop has none)');
    is(m.calls.toasts, ['Old job removed'], 'confirmed');
    const f = mk({ order: o, respond: () => ({ success: false, error: 'remove_failed' }) }); f.CMD.qyRemoveStale(); await tick();
    is(String(f.ctx.state.orderErr), 'Could not remove it — do it in the Qingyun app', 'the platform saying no is a failure too');
  }

  console.log('\n3 · pick a place');
  {
    const o = sfo({ awaiting_choice: true, candidates: [{ idx: 0, name: '汇景新城', address: '天河区', drop_km: 3.2 }, { idx: 1, name: '汇景花园', address: '白云区', drop_km: 18 }] });
    const m = mk({ order: o, respond: () => ({ success: true, requeued: true, name: '汇景花园' }) });
    const h = m.ctx.shipFromCard(m.order);
    has(h, "APP.cmd('qyPickPlace',0)", 'each place is a button'); has(h, "APP.cmd('qyPickPlace',1)", '…every one');
    hasnt(h, 'aria-checked', 'and none is pre-selected');
    hasnt(mk({ order: o, caps: ['orders:view'] }).ctx.shipFromCard(m.order), 'qyPickPlace', 'a reader sees the places, no buttons');
    m.CMD.qyPickPlace(1); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/confirm-place', method: 'POST', body: { idx: 1 } }], 'POST …/qingyun/confirm-place {idx} — only the index travels');
    is(m.calls.toasts, ['Picked 汇景花园 — sending it to the channel, about a minute'], 'says which place, in the server\'s name');
    for (const [code, want] of [['choice_gone', 'That option is gone — reopen the order'], ['row_moved', 'It moved on while you were looking — reopen the order'],
      ['order_closed', 'This order is closed'], ['confirm_failed', 'Could not pick it']]) {
      const x = mk({ order: o, respond: () => fault(code) }); x.CMD.qyPickPlace(0); await tick();
      is(String(x.ctx.state.orderErr), want, code);
    }
    const n = mk({ order: o }); n.CMD.qyPickPlace(-1); n.CMD.qyPickPlace('x'); await tick();
    is(n.calls.writes, [], 'a bad index sends nothing');
    hasnt(h, 'Place the point on a map', 'no switch to a map the phone does not have (§97, held)');
    const pt = mk({ order: sfo({ awaiting_point: true }) });
    has(pt.ctx.shipFromCard(pt.order), 'The point is placed on the desktop map.', 'the map surface still points at the desktop');
    has(pt.ctx.shipFromCard(pt.order), "APP.cmd('shipToOpen','edit')", 'with the desktop\'s Edit ship-to beside it');
  }

  console.log('\n4 · change where it ships from');
  {
    const o = sfo(Object.assign({}, CREATED));
    const m = mk({ order: o, read: () => STORES, respond: () => ({ success: true, store_code: 'YX', old_removed: true }) });
    has(m.ctx.shipFromCard(m.order), "APP.cmd('qyShipOpen')", 'Change is offered');
    const blocked = mk({ order: sfo(Object.assign({}, CREATED, { blocked_by: 'in_transit' })) });
    const bh = blocked.ctx.shipFromCard(blocked.order);
    hasnt(bh, 'qyShipOpen', 'not once a courier is on it'); has(bh, 'A courier is already on this one. To collect it somewhere else, cancel it in the Qingyun app first.', 'which it says');
    hasnt(mk({ order: o, caps: ['orders:view'] }).ctx.shipFromCard(m.order), 'qyShipOpen', 'not for a reader');
    let release; const slow = mk({ order: o, read: () => new Promise((r) => { release = () => r(STORES); }) });
    slow.CMD.qyShipOpen(); await tick();
    has(slow.ctx.shipFromCard(slow.order), 'Loading…', 'loading says so'); release(); await tick();
    m.CMD.qyShipOpen(); await tick();
    is(m.calls.reads, ['/orders/7/qingyun/ship-from'], 'GET …/qingyun/ship-from');
    const h = m.ctx.shipFromCard(m.order);
    has(h, 'Yuexiu', 'the other stores'); hasnt(h, "qyShipPick','TH'", 'not the current one');
    has(h, 'not connected to Qingyun', 'a disconnected one says why'); has(h, 'Close', 'Change becomes Close');
    m.CMD.qyShipPick('PY'); is(m.ctx.state.qy.storePick, null, 'a disconnected store cannot be picked');
    m.CMD.qyShipGo(); await tick();
    is([String(m.ctx.state.orderErr), m.calls.writes], ['Pick a location', []], 'nothing picked is refused before sending');
    m.CMD.qyShipPick('YX'); m.CMD.qyShipGo();
    is([m.ctx.state.ask.title, m.ctx.state.ask.confirmLabel], ['Collect this order at Yuexiu instead?', 'Move it'], 'asks first');
    has(m.ctx.state.ask.body, 'the one at Tianhe is deleted. Nobody has been sent for it yet, so nothing is charged.', 'saying what happens');
    is(m.calls.writes, [], 'nothing before the answer');
    m.CMD.askRun(''); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/ship-from', method: 'POST', body: { store_code: 'YX' } }], 'POST …/qingyun/ship-from {store_code}');
    is(m.calls.toasts, ['Now collected at Yuexiu'], 'confirmed'); is(m.ctx.state.qy, null, 'the panel closes');
    const left = mk({ order: o, read: () => STORES, respond: () => ({ success: true, old_removed: false }) });
    left.CMD.qyShipOpen(); await tick(); left.CMD.qyShipPick('YX'); left.CMD.qyShipGo(); left.CMD.askRun(''); await tick();
    is(left.calls.toasts, ["Now collected at Yuexiu — but the old job couldn't be deleted, remove it below"], 'an old job left behind is said');
    for (const [resp, want] of [[fault('courier_already_called'), 'A courier is already on it — cancel it in the Qingyun app first'],
      [fault('store_not_connected'), "That location isn't connected to Qingyun"],
      [fault('store_not_reachable'), "That location's Qingyun account isn't wired up yet — ask ops to set it up"],
      [{ success: false, error: 'move_failed' }, 'Could not move it'], [REFUSAL(), 'Your role does not include this action.']]) {
      const x = mk({ order: o, read: () => STORES, respond: () => resp });
      x.CMD.qyShipOpen(); await tick(); x.CMD.qyShipPick('YX'); x.CMD.qyShipGo(); x.CMD.askRun(''); await tick();
      is(String(x.ctx.state.orderErr), want, 'refused: ' + want);
    }
    for (const [read, want] of [[new Error('HTTP 500'), 'Load failed'], [{ available: false }, 'This order has no Qingyun job to move.'],
      [{ available: true, current: 'TH', stores: [STORES.stores[0]] }, 'No other location is set up for same-city delivery.']]) {
      const x = mk({ order: o, read: () => read }); x.CMD.qyShipOpen(); await tick();
      has(x.ctx.shipFromCard(x.order), want, 'the read: ' + want);
    }
    const t = mk({ order: o, read: () => STORES }); t.CMD.qyShipOpen(); await tick(); t.CMD.qyShipOpen();
    is(t.ctx.state.qy, null, 'a second press closes it');
    const d = mk({ order: o, caps: ['orders:view'], read: () => STORES }); d.CMD.qyShipOpen(); await tick();
    is([d.calls.reads, d.ctx.state.qy], [[], null], 'without orders:edit nothing is read');
  }

  console.log('\n5 · move the delivery day');
  {
    const exp = sfo({ awaiting_point: true, date_posture: 'passed', promised_date: '2026-09-30' });
    const m = mk({ order: exp, respond: () => ({ success: true, moved: true, requeued: true }) });
    let h = m.ctx.shipFromCard(m.order);
    has(h, 'Delivery date passed', 'an expired order'); has(h, "APP.cmd('qyDayOpen')", 'offers Reschedule delivery'); has(h, "APP.cmd('shipToOpen','edit')", 'and Edit ship-to');
    hasnt(mk({ order: exp, caps: ['orders:view'] }).ctx.shipFromCard(m.order), 'qyDayOpen', 'not for a reader');
    m.CMD.qyDayOpen(); h = m.ctx.shipFromCard(m.order);
    for (let i = 0; i < 7; i++) has(h, `APP.cmd('qyDayPick','${BJ(i)}')`, 'a week of Beijing days: ' + BJ(i));
    hasnt(h, BJ(7), 'and no more'); has(h, 'today', 'today named'); has(h, 'tomorrow', 'and tomorrow');
    has(h, 'The rider is called on the morning of the day you pick. Nothing is dispatched before then.', 'with what picking a day means');
    m.CMD.qyDayPick('1999-01-01'); is(m.ctx.state.qy.day, null, 'a day not offered cannot be picked');
    m.CMD.qyDayPick(BJ(2)); h = m.ctx.shipFromCard(m.order);
    has(h, 'Move this delivery from 2026-09-30 to ' + BJ(2) + '? The customer is told the new day.', 'asks, naming both days');
    is(m.calls.writes, [], 'nothing before Move the delivery');
    m.CMD.qyDayGo(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/reschedule', method: 'POST', body: { date: BJ(2) } }], 'POST …/qingyun/reschedule {date}');
    is(m.calls.toasts, ['Moved to ' + BJ(2) + ' — the rider is called that morning'], 'a later day: the rider is called that morning');
    const outcome = async (resp, day) => { const x = mk({ order: exp, respond: () => resp }); x.CMD.qyDayOpen(); x.CMD.qyDayPick(day); x.CMD.qyDayGo(); await tick(); return x; };
    is((await outcome({ success: true, requeued: true }, BJ(0))).calls.toasts, ['Moved to today — it goes back in the queue now'], 'today: back in the queue now');
    is((await outcome({ success: true, already_created: true }, BJ(1))).calls.toasts, ['A courier is already on this one — cancel it in the Qingyun app first'], 'a live rider: nothing moved');
    is((await outcome({ success: true, moved: true, stale_copy: true }, BJ(0))).calls.toasts, ['Moved to today. The old courier order may still be live — cancel it in the Qingyun app, then call another courier.'], 'a frozen copy: moved, finish by hand');
    is((await outcome({ success: true, moved: true, requeued: false }, BJ(3))).calls.toasts, ['Moved to ' + BJ(3) + ', but it was not re-queued — check the courier'], 'moved but not queued: both halves');
    is(String((await outcome(fault('date_passed'), BJ(1))).ctx.state.orderErr), 'Could not move it', 'a failure says so');
    m.CMD.qyDayOpen(); m.CMD.qyClose(); is(m.ctx.state.qy, null, 'Keep the current date closes it');

    const live = sfo(Object.assign({}, CREATED, { date_posture: 'today', promised_date: BJ(0) }));
    has(mk({ order: live }).ctx.shipFromCard(mk({ order: live }).order), "APP.cmd('qyDayOpen')", 'a live order: Change delivery day beside the courier');
    const riding = mk({ order: Object.assign({}, live, { courier: { stage: 'heading_to_pickup', updated_at: new Date().toISOString() } }) });
    hasnt(riding.ctx.shipFromCard(riding.order), 'qyDayOpen', 'not while a rider is on the way');
    const frozen = mk({ order: Object.assign({}, live, { courier: { stage: 'in_transit', updated_at: new Date(Date.now() - 3600000).toISOString() } }) });
    has(frozen.ctx.shipFromCard(frozen.order), 'qyDayOpen', 'but a frozen run is nobody (TC000823)');
    const gone = mk({ order: Object.assign({}, live, { raw: 'cancelled' }) });
    hasnt(gone.ctx.shipFromCard(gone.order), 'qyDayOpen', 'nor on a closed order');
    const d = mk({ order: live, caps: ['orders:view'] }); d.CMD.qyDayOpen();
    is(d.ctx.state.qy, null, 'without orders:edit it does not open');
    d.ctx.state.qy = { oid: 'TC7', panel: 'day', day: BJ(1) }; d.CMD.qyDayGo(); await tick();
    is(d.calls.writes, [], 'and nothing is sent');
  }

  console.log('\n6 · compare couriers and dispatch');
  {
    const booked = sfo({ awaiting_dispatch: true });
    const m = mk({ order: booked, read: () => CARRIERS, respond: () => ({ success: true, carriers: [{ name: 'Shansong', fee_yuan: 15.5 }] }) });
    let h = m.ctx.shipFromCard(m.order);
    has(h, "APP.cmd('qyCarriers')", 'Compare couriers is offered'); has(h, 'Compare couriers', 'in the desktop\'s words');
    has(h, 'The address is checked. Compare couriers below when you want a rider — nothing is charged until you dispatch.', 'and the sentence that points at it');
    const edOnly = mk({ order: booked, caps: ['orders:view', 'orders:edit'] }).ctx.shipFromCard(mk().order);
    hasnt(edOnly, 'qyCarriers', 'orders:edit alone does not dispatch'); hasnt(edOnly, 'Compare couriers below', 'nor is told to');
    hasnt(mk({ order: booked, caps: null }).ctx.shipFromCard(mk({ order: booked }).order), 'qyCarriers', 'keys not yet known: no button (money fails closed)');
    const mv = (stage, ago) => mk({ order: Object.assign({}, booked, { courier: { stage, updated_at: new Date(Date.now() - ago).toISOString() } }) });
    has(mv('awaiting_dispatch', 0).ctx.shipFromCard(mv('awaiting_dispatch', 0).order), 'Call another courier', 'still finding: Call another courier');
    has(mv('cancelled', 0).ctx.shipFromCard(mv('cancelled', 0).order), 'Call another courier', 'a cancelled rider likewise');
    hasnt(mv('in_transit', 0).ctx.shipFromCard(mv('in_transit', 0).order), 'qyCarriers', 'a rider on the way: no re-compare');
    has(mv('in_transit', 3600000).ctx.shipFromCard(mv('in_transit', 3600000).order), 'Call another courier', 'a frozen run: call another');
    const shipped = mk({ order: Object.assign({}, booked, { shipments: [{ id: 3, mode: 'local', state: 'dispatched' }] }) });
    hasnt(shipped.ctx.shipFromCard(shipped.order), 'qyCarriers', 'not once the parcel has gone');
    const bare = mk({ order: { shipFrom: null } });
    has(bare.ctx.qyCourierCard(bare.order), "APP.cmd('qyCarriers')", 'with no ship-from line the controls have a card of their own');
    is(mk({ order: { shipFrom: null, viewOnly: true } }).ctx.qyCourierCard(mk({ order: { shipFrom: null, viewOnly: true } }).order), '', 'never on a mirrored order');

    m.CMD.qyCarriers(); await tick();
    is(m.calls.reads, ['/orders/7/qingyun/carriers'], 'GET …/qingyun/carriers');
    h = m.ctx.shipFromCard(m.order);
    has(h, 'Fengniao', 'the couriers'); has(h, '¥12.00', 'with the price'); has(h, '3.2km', 'and distance'); hasnt(h, 'Off', 'only the enabled ones');
    has(h, 'cheapest', 'the cheapest named'); is(Object.keys(m.ctx.state.qy.pick), ['1|s1'], 'and pre-ticked, as the desktop does');
    has(h, 'Refresh prices', 'Compare becomes Refresh prices');
    m.CMD.qyCarrierT('1|s1'); m.CMD.qyDispatch();
    is([String(m.ctx.state.orderErr), m.ctx.state.ask], ['Pick at least one courier', null], 'nothing ticked is refused before asking');
    m.CMD.qyCarrierT('2|s2'); m.CMD.qyCarrierT('3|s3');
    is(Object.keys(m.ctx.state.qy.pick), ['2|s2'], 'a disabled courier cannot be ticked');
    m.CMD.qyDispatch();
    is([m.ctx.state.ask.title, m.ctx.state.ask.confirmLabel], ['Dispatch Shansong? A rider is called and your Qingyun balance is charged.', 'Dispatch'], 'asks, saying it charges');
    is(m.calls.writes, [], 'nothing before the answer');
    m.CMD.askRun(''); await tick();
    is(m.calls.writes, [{ p: '/orders/7/qingyun/dispatch', method: 'POST', body: { carriers: [{ carrierId: 2, serviceCode: 's2' }] } }], 'POST …/qingyun/dispatch {carriers}');
    is(m.calls.toasts, ['Courier dispatched'], 'confirmed');
    has(m.ctx.shipFromCard(m.order), 'Dispatched: Shansong ¥15.50', 'and who, at what price');
    const two = mk({ order: booked, read: () => CARRIERS }); two.CMD.qyCarriers(); await tick(); two.CMD.qyCarrierT('2|s2'); two.CMD.qyDispatch();
    is(two.ctx.state.ask.title, 'Call 2 couriers at once? The first rider to accept takes the order — only that courier is charged to your Qingyun balance.', 'two at once says how charging works');
    for (const [resp, want, reread] of [[{ success: false, error: 'balance', insufficient_balance: true }, 'Qingyun balance too low — top up first', false],
      [fault('courier_already_called'), 'A courier is already on this order', true], [{ success: false, error: '附近无骑手' }, 'Dispatch failed: 附近无骑手', false],
      [fault('carrier_unavailable'), 'Dispatch failed: carrier_unavailable', false], [{ success: false, error: 'dispatch_failed' }, 'Dispatch failed', false],
      [REFUSAL(), 'Your role does not include this action.', false]]) {
      const x = mk({ order: booked, read: () => CARRIERS, respond: () => resp });
      x.CMD.qyCarriers(); await tick(); x.CMD.qyDispatch(); x.CMD.askRun(''); await tick();
      is([String(x.ctx.state.orderErr), x.calls.toasts, x.calls.reads.includes('/orders/7')], [want, [], reread], 'refused: ' + want);
    }
    for (const [read, want] of [[{ success: false, error: 'quote failed' }, 'Could not load couriers — is the store connected to Qingyun?'],
      [{ available: false }, "Not in Qingyun yet. Turn on auto-send, or this isn't a same-city order."],
      [{ available: true, carriers: [CARRIERS.carriers[2]] }, 'No couriers available right now.'], [new Error('HTTP 500'), 'Load failed']]) {
      const x = mk({ order: booked, read: () => read }); x.CMD.qyCarriers(); await tick();
      has(x.ctx.shipFromCard(x.order), want, 'the read: ' + want);
      hasnt(x.ctx.shipFromCard(x.order), 'qyDispatch', '…and no Dispatch');
    }
    let release; const slow = mk({ order: booked, read: () => new Promise((r) => { release = () => r(CARRIERS); }) });
    slow.CMD.qyCarriers(); await tick(); has(slow.ctx.shipFromCard(slow.order), 'Loading…', 'loading says so'); release(); await tick();
    const d = mk({ order: booked, caps: ['orders:view', 'orders:edit'], read: () => CARRIERS });
    d.CMD.qyCarriers(); await tick(); is(d.calls.reads, [], 'without orders:dispatch_courier nothing is read');
    d.ctx.state.qy = { oid: 'TC7', panel: 'carriers', carriers: CARRIERS, pick: { '1|s1': true } }; d.CMD.qyDispatch();
    is([d.ctx.state.ask, d.calls.writes], [null, []], 'and nothing is asked or sent');
    const late = mk({ order: booked, read: () => CARRIERS }); late.CMD.qyCarriers(); await tick(); late.CMD.qyDispatch();
    late.ctx.state.caps = ['orders:view']; late.CMD.askRun(''); await tick();
    is(late.calls.writes, [], 'a key lost between asking and answering sends nothing');
  }

  console.log('\n7 · Chinese');
  {
    const z = mk({ lang: 'zh', order: sfo({ needs_attention: true }) });
    has(z.ctx.shipFromCard(z.order), '重新发单', 'Retry push');
    const c = mk({ lang: 'zh', order: sfo({ awaiting_dispatch: true }), read: () => CARRIERS });
    has(c.ctx.shipFromCard(c.order), '查看运力比价', 'Compare couriers');
    await c.CMD.qyCarriers(); await tick(); has(c.ctx.shipFromCard(c.order), '发起配送', 'Dispatch courier');
    const e = mk({ lang: 'zh', order: sfo({ awaiting_point: true, date_posture: 'passed', promised_date: 'D' }) });
    has(e.ctx.shipFromCard(e.order), '改期配送', 'Reschedule delivery');
  }

  console.log('\n8 · where it sits, and that the words are the desktop\'s');
  {
    has(src, '${qyCourierCard(o)}', 'the sheet draws the stand-alone courier card');
    has(src, 'splitPick:null, splitDismissed:[], shipTo:null, qy:null,', 'the panel slot is declared in the state literal');
    has(src, 'state.shipTo=null; state.qy=null;', 'closing the order clears it');
    for (const [en, zh] of [['Retry push', '重新发单'], ['Queuing…', '排队中…'], ['Queued — sending it to the channel, about a minute', '已排队 — 约一分钟内发单'],
      ['Already on the courier platform', '已在配送平台'], ['Could not queue it', '排队失败'], ['Remove it', '删除原单'], ['Removing…', '删除中…'], ['Old job removed', '原配送单已删除'],
      ['Could not remove it — do it in the Qingyun app', '删除失败 — 请在青云 App 中删除'], ['That option is gone — reopen the order', '该选项已失效，请重新打开订单'],
      ['It moved on while you were looking — reopen the order', '状态已变更，请重新打开订单'], ['This order is closed', '该订单已关闭'], ['Could not pick it', '选择失败'],
      ['Change', '更改'], ['This order has no Qingyun job to move.', '该订单在青云没有可转移的配送单。'], ['No other location is set up for same-city delivery.', '暂无其他门店开通同城配送。'],
      ['not connected to Qingyun', '未连接青云'], ['Ship from here', '改为此门店取货'], ['Pick a location', '请选择门店'], ['Move it', '确认更改'], ['Moving…', '更改中…'],
      ['A courier is already on it — cancel it in the Qingyun app first', '已呼叫运力 — 请先在青云 App 取消'], ["That location isn't connected to Qingyun", '该门店未连接青云'],
      ["That location's Qingyun account isn't wired up yet — ask ops to set it up", '该门店的青云账号尚未接通 — 请联系运维配置'], ['Could not move it', '更改失败'],
      ['Load failed', '加载失败'], ['Reschedule delivery', '改期配送'], ['Change delivery day', '更改配送日期'], ['today', '今天'], ['tomorrow', '明天'],
      ['The rider is called on the morning of the day you pick. Nothing is dispatched before then.', '所选日期当天才会呼叫骑手,在此之前不会发单。'],
      ['Move the delivery', '确认改期'], ['Keep the current date', '保持原日期'], ['Moved to today — it goes back in the queue now', '已改期至今天 — 已重新排队'],
      ['A courier is already on this one — cancel it in the Qingyun app first', '已呼叫运力。请先在青云 App 取消该单。'], ['Could not move it', '改期失败'],
      ['Compare couriers', '查看运力比价'], ['Refresh prices', '刷新比价'], ['Could not load couriers — is the store connected to Qingyun?', '无法获取运力 — 门店是否已连接青云?'],
      ["Not in Qingyun yet. Turn on auto-send, or this isn't a same-city order.", '订单尚未进入青云。请开启自动发送,或此单非同城配送。'], ['No couriers available right now.', '当前暂无可用运力。'],
      ['cheapest', '最便宜'], ['Dispatch courier', '发起配送'], ['Pick at least one courier', '请至少选择一个运力'], ['Dispatch', '发起配送'], ['Dispatching…', '发单中…'],
      ['Courier dispatched', '已发起配送'], ['first to accept wins', '谁先接单谁配送'], ['Dispatched', '已发单'], ['Qingyun balance too low — top up first', '青云余额不足,请先充值'],
      ['A courier is already on this order', '该订单已呼叫运力'], ['Dispatch failed', '发起配送失败'],
      ['Fix the delivery address (Edit ship-to, or Make address Chinese) and it retries on its own — or press Retry.', '修正收货地址(修改收货信息或转为中文地址)后会自动重试,也可点击重新发单。'],
      ['The address is checked. Compare couriers below when you want a rider — nothing is charged until you dispatch.', '地址已核对。需要骑手时点击下方“查看运力比价” — 发起配送前不产生费用。'],
      ['A courier is already on this one. To collect it somewhere else, cancel it in the Qingyun app first.', '已呼叫运力。如需改到其他门店取货,请先在青云 App 取消该单。']]) {
      const found = [`cuT('${en}', '${zh}')`, `cuT("${en}", '${zh}')`, `'${en}', '${zh}'`, `"${en}", '${zh}'`].some((x) => DESKN.includes(x));
      if (found) ok('the desktop\'s own pair: ' + en); else bad('the desktop\'s own pair: ' + en, 'not found: ' + en + ' / ' + zh);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
