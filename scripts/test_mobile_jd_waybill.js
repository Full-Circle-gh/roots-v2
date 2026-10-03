#!/usr/bin/env node
/**
 * §325 step O12 — A JD WAYBILL, CREATED AND CANCELLED FROM THE PHONE.
 *
 *   node scripts/test_mobile_jd_waybill.js
 *
 * From the desktop's order drawer (public/retail-admin/04-orders.js):
 *   1. createJdLabel / submitJdLabel — the service question, the pieces count,
 *      the two "anyway?" questions, then
 *      POST /orders/:id/jd-waybill {shipment_id, product, package_count};
 *   2. cancelJdPickup — asked first, POST /orders/:id/jd-waybill/cancel.
 * No printing: the label goes to a print component on the desktop PC.
 * Both are orders:edit (lib/cap-routes.js).
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
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
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
  sliceBetween('/* ── §325 O12 — A JD WAYBILL', '\nfunction trackingCard('),
  sliceFn('trackingCard'), sliceFn('parcelExtras'),
  sliceFn('orderWrite', true), sliceFn('rereadOrder', true), sliceFn('orderErrorText'),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  sliceFn('orderBreakdown'),
  sliceFn('itemOpts'), sliceBetween('\nconst ITEM_TUPLE=', '\nfunction '), sliceFn('mapDetail'),
  'globalThis.__x={jdCan,jdPlan,jdLandDefault,JD_SERVICES};',
].join('\n');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const fault = (code) => Object.assign(new Error(code), { code });
const SP = (over) => Object.assign({ id: 3, mode: 'land', state: 'dispatched', items: [], trk: null, carrierCode: null, jdFresh: false, jdNames: [], jdNoAir: [] }, over || {});

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const order = Object.assign({ id: 'TC7', _id: 7, raw: 'dispatched', viewOnly: false, shipments: [SP(opts.sp)], shipTo: { province: opts.province || '广东省' }, sfOnlyAir: !!opts.sfOnlyAir, gzMethodToggle: false }, opts.order || {});
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', PILL: { muted: ['#eee', '#555'] },
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`, money: (c, n) => c + Number(n || 0).toFixed(2), pill: (k, t) => `<span class="pill">${t}</span>`,
    tdWhen: (v) => 'W(' + v + ')', _tdL: () => 'x', fmtDay: (v) => 'D(' + v + ')', evTime: (v) => v,
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    noContactCard: () => '', delayCaseCard: () => '', DELIV_TONE: {}, TRK_STATE_TONE: {}, countLabel: () => '',
    state: { orderBusy: null, orderErr: null, ask: null, askErr: null, jd: null, detailId: 'TC7', liveDetail: null, parcelBusy: null, splitPick: null, splitDismissed: [] },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    currentOrder: () => order, findOrder: () => order,
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => {}, refreshOrders: () => {},
    mapOrderRow: (r) => ({ id: r.order_no, _id: r.id }), shipByPlan: () => null, shipByUrgency: () => ({ level: 'none' }),
    orderWaitingOn: () => null, chanMoneyOf: () => null,
    api: (p) => { calls.reads.push(p); return Promise.resolve({ id: 7, order_no: 'TC7', status: 'dispatched', items: [] }); },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p) : null;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r || { success: true, data: { waybill: 'JDV0001', method: 'cancel' } });
    },
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls, order };
}
const open = (m) => { m.CMD.jdOpen(3); return m.ctx.state.jd; };

async function main() {
  console.log('\n0 · the server gate');
  {
    is([requiredCapFor('POST', '/api/retail-admin/orders/7/jd-waybill'), requiredCapFor('POST', '/api/retail-admin/orders/7/jd-waybill/cancel')],
      ['orders:edit', 'orders:edit'], 'create and cancel: orders:edit');
  }

  console.log('\n1 · where it is offered');
  {
    const m = mk();
    const card = m.ctx.trackingCard(m.order, m.order.shipments[0]);
    has(card, "APP.cmd('jdOpen',3)", 'a parcel out with no waybill offers Create JD label'); has(card, 'Free live tracking — JD bills the parcel.', 'with the desktop\'s line');
    has(card, '— or attach an existing waybill manually —', 'and the manual way after it');
    hasnt(mk({ caps: ['orders:view'] }).ctx.trackingCard(m.order, m.order.shipments[0]), 'jdOpen', 'not for a reader');
    hasnt(m.ctx.trackingCard(Object.assign({}, m.order, { viewOnly: true }), m.order.shipments[0]), 'jdOpen', 'not on a mirrored order');
    const gz = mk({ order: { raw: 'paid', gzMethodToggle: true }, sp: { state: 'pending' } });
    has(gz.ctx.parcelExtras(gz.order, gz.order.shipments[0]), "APP.cmd('jdOpen',3)", 'a pending Guangzhou parcel on JD offers it, as the desktop\'s card does');
    const no = mk({ order: { raw: 'paid', gzMethodToggle: false }, sp: { state: 'pending' } });
    hasnt(no.ctx.parcelExtras(no.order, no.order.shipments[0]), 'jdOpen', 'an ordinary pending parcel does not');
    const sup = mk({ sp: { mode: 'supplier' } }); sup.CMD.jdOpen(3); is(sup.ctx.state.jd, null, 'a supplier parcel never opens it');
    has(src, "if(state.jd&&state.detailId===state.jd.oid) html += layer('jd:'+state.jd.sid, sheetJd());", 'the sheet is a layer');
    has(src, 'state.qy=null; state.jd=null;', 'closing the order closes it');
  }

  console.log('\n2 · the question, the desktop\'s way');
  {
    is(mk().ctx.__x.jdPlan({ shipTo: {} }, SP({ mode: 'air' })).services.map((s) => s.code), ['LL-SD-M', 'LL-HD-M', 'ed-m-0001'],
      'an air parcel: air first, then both ground services (§381)');
    is(mk().ctx.__x.jdPlan({ shipTo: {} }, SP({ mode: 'air' })).preset, 'LL-SD-M', '…and starts on fresh express');
    const fj = mk().ctx.__x.jdPlan({ shipTo: { province: '福建省' } }, SP({ mode: 'air' }));
    is([fj.preset, fj.services.map((s) => s.code)], ['LL-HD-M', ['LL-HD-M', 'LL-SD-M']], 'into Fujian: the two fresh services, ground first');
    is(mk().ctx.__x.jdPlan({ shipTo: { province: '广西壮族自治区' } }, SP({ mode: 'air' })).landDefault, true, 'Guangxi by prefix');
    is(mk().ctx.__x.jdPlan({ shipTo: { province: '广东省' } }, SP({ mode: 'air' })).landDefault, false, 'not Guangdong');
    const g = mk().ctx.__x.jdPlan({ shipTo: {} }, SP({ mode: 'land' }));
    is([g.preset, g.services.map((s) => s.code)], ['ed-m-0001', ['LL-HD-M', 'ed-m-0001', 'LL-SD-M']], 'a ground parcel: fresh, ambient, air last — ambient when nothing is iced');
    is(mk().ctx.__x.jdPlan({ shipTo: {} }, SP({ mode: 'land', jdFresh: true })).preset, 'LL-HD-M', 'an iced box starts on fresh ground');
    const m = mk({ sp: { jdNoAir: [['Durian', '榴莲']], jdNames: [['Durian', '榴莲'], ['Cake', '蛋糕']] } });
    open(m);
    let h = m.ctx.sheetJd();
    has(h, 'Ground parcel — is it fresh (ice pack) or ambient?', 'the ground question'); has(h, 'Land shipping only — airline rejected: Durian', 'air marked where the airline refuses it');
    has(h, '京东标快 · ed-m-0001', 'each service named with its code'); has(h, 'Pieces (boxes)', 'and the pieces count');
    m.CMD.jdSvc('LL-SD-M');
    is([m.ctx.state.ask.title, m.ctx.state.ask.confirmLabel, m.ctx.state.ask.cancelLabel], ['Land only', 'Create air waybill anyway', 'Not yet'], 'picking air on a land parcel asks, on the pick');
    has(m.ctx.state.ask.body, '<b>Durian, Cake</b> — land shipping only.', 'naming what is in the box');
    is(m.ctx.state.jd.svc, 'ed-m-0001', 'nothing changes before the answer');
    m.CMD.askRun(''); is(m.ctx.state.jd.svc, 'LL-SD-M', 'yes: air');
    const d = mk(); open(d); d.CMD.jdSvc('LL-SD-M'); d.ctx.state.ask = null; is(d.ctx.state.jd.svc, 'ed-m-0001', 'declined: the row stays where it was');
    const air = mk({ sp: { mode: 'air' }, province: '福建省' }); open(air); air.CMD.jdSvc('LL-SD-M');
    is([air.ctx.state.ask, air.ctx.state.jd.svc], [null, 'LL-SD-M'], 'on an air parcel\'s own list air is the plan: no question');
    air.CMD.jdSvc('nope'); is(air.ctx.state.jd.svc, 'LL-SD-M', 'a service not offered is ignored');
    const fjg = mk({ sp: { mode: 'air' }, province: '福建省' }); open(fjg); fjg.CMD.jdSvc('LL-SD-M'); fjg.ctx.state.ask = null; fjg.CMD.jdSvc('LL-HD-M');
    is([fjg.ctx.state.ask, fjg.ctx.state.jd.svc], [null, 'LL-HD-M'], 'into Fujian ground is the default: going back to it asks nothing');
  }

  console.log('\n2b · §381 — ground on an air parcel asks, on the pick');
  {
    const g = mk({ sp: { mode: 'air', jdNames: [['Dates', '椰枣'], ['Chips', '果干']], jdNoAir: [['Dates', '椰枣']] } }); open(g);
    has(g.ctx.sheetJd(), 'Ambient · Ground', 'an air parcel\'s sheet lists the ground services');
    has(g.ctx.sheetJd(), 'Land shipping only — airline rejected: Dates', 'and marks its air row where the airline refuses an item');
    g.CMD.jdSvc('LL-HD-M');
    is([g.ctx.state.ask.title, g.ctx.state.ask.confirmLabel, g.ctx.state.ask.cancelLabel], ['Air parcel', 'Create ground waybill anyway', 'Not yet'],
      'picking ground on an air parcel asks');
    has(g.ctx.state.ask.body, '<b>Dates, Chips</b> — planned for air. Ground is slower.', 'naming what is in the box');
    is(g.ctx.state.jd.svc, 'LL-SD-M', 'nothing changes before the answer');
    g.CMD.askRun(''); is(g.ctx.state.jd.svc, 'LL-HD-M', 'yes: fresh ground');
    g.ctx.state.ask = null; g.CMD.jdSvc('ed-m-0001');
    is([g.ctx.state.ask, g.ctx.state.jd.svc], [null, 'ed-m-0001'], 'moving between the ground rows asks nothing more');
    g.CMD.jdSvc('LL-SD-M'); is([g.ctx.state.ask, g.ctx.state.jd.svc], [null, 'LL-SD-M'], 'back to air asks nothing');
    const d = mk({ sp: { mode: 'air' } }); open(d); d.CMD.jdSvc('ed-m-0001'); d.ctx.state.ask = null;
    is(d.ctx.state.jd.svc, 'LL-SD-M', 'declined: air stays');
    const e = mk({ sp: { mode: 'air' } }); open(e); e.CMD.jdSvc('LL-HD-M');
    has(e.ctx.state.ask.body, 'This parcel is planned for air.', 'no names loaded: says "this parcel"');
    const z = mk({ lang: 'zh', sp: { mode: 'air', jdNames: [['Dates', '椰枣']] } }); open(z); z.CMD.jdSvc('LL-HD-M');
    is([z.ctx.state.ask.title, z.ctx.state.ask.confirmLabel, z.ctx.state.ask.cancelLabel], ['空运包裹', '仍要生成陆运运单', '暂不'], 'in Chinese');
    has(z.ctx.state.ask.body, '<b>椰枣</b> 计划空运,陆运较慢。仍要生成陆运运单吗?', 'the desktop\'s Chinese sentence');
    const y = mk({ sp: { mode: 'air' } }); open(y); y.CMD.jdSvc('LL-HD-M'); y.CMD.askRun(''); y.CMD.jdGo(); await tick();
    is(y.calls.writes.map((w) => w.body.product), ['LL-HD-M'], 'Create & ship books the ground service chosen');
  }

  console.log('\n3 · create');
  {
    const m = mk(); open(m); m.CMD.jdSvc('LL-HD-M'); m.CMD.jdPieces('3'); m.CMD.jdGo(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/jd-waybill?shipment_id=3', method: 'POST', body: { shipment_id: 3, product: 'LL-HD-M', package_count: 3 } }],
      'POST /orders/:id/jd-waybill {shipment_id, product, package_count}');
    is([m.calls.toasts, m.ctx.state.jd, m.calls.reads], [['JD waybill created: JDV0001 · 3 boxes'], null, ['/orders/7']], 'the waybill named, the sheet closed, the order read again');
    for (const [v, want] of [['0', 1], ['99', 30], ['x', 1]]) {
      const x = mk(); open(x); x.CMD.jdPieces(v); x.CMD.jdGo(); await tick();
      is(x.calls.writes[0].body.package_count, want, 'pieces ' + JSON.stringify(v) + ' → ' + want + ' (1–30, as the desktop clamps)');
    }
    const sf = mk({ sfOnlyAir: true, sp: { mode: 'air' } }); open(sf); sf.CMD.jdGo();
    is([sf.ctx.state.ask.title, sf.calls.writes], ['SF Express only', []], 'an SF-only city asks at submit');
    has(sf.ctx.state.ask.body, 'Chengdu air can only ship with SF Express.', '…in the desktop\'s words');
    sf.CMD.askRun(''); await tick(); is(sf.calls.writes[0].body.product, 'LL-SD-M', 'and sends on yes');
    const sfg = mk({ sfOnlyAir: true }); open(sfg); sfg.CMD.jdGo(); await tick();
    is([sfg.ctx.state.ask, sfg.calls.writes.length], [null, 1], 'not when the service is ground');
    for (const [resp, want] of [[fault('store_sender_phone_missing'), 'Set the store’s sender phone first (Settings → Stores)'],
      [fault('jd_not_configured'), 'JD Logistics is not set up yet — finish it in Settings → Delivery.'],
      [fault('not_shippable'), 'That order is not ready to ship.'], [fault('jd_create_failed'), 'JD label failed: jd_create_failed'],
      [REFUSAL(), 'Your role does not include this action.']]) {
      const x = mk({ respond: () => resp }); open(x); x.CMD.jdGo(); await tick();
      is([String(x.ctx.state.jd.err), x.ctx.state.jd.busy, x.calls.toasts], [want, false, []], 'refused: ' + want);
    }
    const b = mk(); b.ctx.apiWrite = (p, body) => { b.calls.writes.push({ p, body }); return new Promise(() => {}); };
    open(b); b.CMD.jdGo(); await tick(); has(b.ctx.sheetJd(), 'Working…', 'busy says so'); b.CMD.jdGo(); b.CMD.jdClose();
    is([b.calls.writes.length, b.ctx.state.jd !== null], [1, true], 'one send, and the sheet stays until it lands');
    const r = mk({ caps: ['orders:view'] }); r.CMD.jdOpen(3); is(r.ctx.state.jd, null, 'without orders:edit it does not open');
    r.ctx.state.jd = { oid: 'TC7', sid: 3, svc: 'ed-m-0001', pieces: '1' }; r.CMD.jdGo(); await tick(); is(r.calls.writes, [], 'and sends nothing');
    hasnt(src.slice(src.indexOf('/* ── §325 O12'), src.indexOf('\nfunction trackingCard(')), 'print-data', 'and nothing here prints');
  }

  console.log('\n4 · cancel the JD pickup');
  {
    const jd = { trk: { number: 'JDV9', carrier_code: 'jd', carrier_name_en: 'JD', carrier_name_cn: '京东' }, carrierCode: 'jd' };
    const m = mk({ sp: jd });
    const card = m.ctx.trackingCard(m.order, m.order.shipments[0]);
    has(card, "APP.cmd('jdCancel',3)", 'a JD waybill offers Cancel JD pickup');
    has(card, '"Cancel JD pickup" calls off the courier with JD. "Clear" only removes the number locally (courier still comes).', 'and says how it differs from Clear');
    hasnt(mk({ sp: { trk: { number: 'SF1', carrier_code: 'sf' }, carrierCode: 'sf' } }).ctx.trackingCard(m.order, SP({ trk: { number: 'SF1', carrier_code: 'sf' }, carrierCode: 'sf' })), 'jdCancel', 'not on another carrier\'s');
    hasnt(mk({ sp: jd, caps: ['orders:view'] }).ctx.trackingCard(m.order, SP(jd)), 'jdCancel', 'not for a reader');
    m.CMD.jdCancel(3);
    is([m.ctx.state.ask.title, m.ctx.state.ask.danger, m.ctx.state.ask.confirmLabel], ['Cancel the JD pickup / recall this parcel with JD?', true, 'Cancel JD pickup'], 'asks first');
    is(m.calls.writes, [], 'nothing before the answer');
    m.CMD.askRun(''); await tick();
    is(m.calls.writes, [{ p: '/orders/7/jd-waybill/cancel?shipment_id=3', method: 'POST', body: { shipment_id: 3 } }], 'POST …/jd-waybill/cancel');
    is([m.calls.toasts, m.calls.reads], [['JD pickup cancelled'], ['/orders/7']], 'confirmed, order read again');
    const it = mk({ sp: jd, respond: () => ({ success: true, data: { method: 'intercept' } }) }); it.CMD.jdCancel(3); it.CMD.askRun(''); await tick();
    is(it.calls.toasts, ['JD parcel intercepted (was already collected)'], 'an intercept says so');
    const f = mk({ sp: jd, respond: () => fault('jd_cancel_failed') }); f.CMD.jdCancel(3); f.CMD.askRun(''); await tick();
    is(String(f.ctx.state.orderErr), 'JD cancel failed: jd_cancel_failed', 'a failure says so');
    const rf = mk({ sp: jd, respond: () => REFUSAL() }); rf.CMD.jdCancel(3); rf.CMD.askRun(''); await tick();
    is(String(rf.ctx.state.orderErr), 'Your role does not include this action.', 'a refusal says why');
    const d = mk({ sp: jd, caps: ['orders:view'] }); d.CMD.jdCancel(3); is(d.ctx.state.ask, null, 'without orders:edit nothing is asked');
  }

  console.log('\n5 · the order read carries what the sheet asks from');
  {
    const md = mk().ctx.mapDetail({ id: 7, order_no: 'TC7', items: [], sf_only_air: 1, shipments: [{ id: 3, mode: 'land', items: [
      { name_en: 'Durian', name_cn: '榴莲', needs_ice_pack: 1, ship_modes_arr: ['land'] }, { name_en: 'Durian', name_cn: '榴莲', ship_modes_arr: ['land'] },
      { name_en: 'Tea', name_cn: '茶', ship_modes_arr: ['air', 'land'] }] }] });
    const sp = md.shipments[0];
    is([sp.jdFresh, sp.jdNames, sp.jdNoAir, md.sfOnlyAir], [true, [['Durian', '榴莲'], ['Tea', '茶']], [['Durian', '榴莲'], ['Durian', '榴莲']], true],
      'iced, the names once each, the airline-refused lines, and the SF-only answer');
  }

  console.log('\n6 · Chinese, and the words are the desktop\'s');
  {
    const z = mk({ lang: 'zh' }); open(z); has(z.ctx.sheetJd(), '生成京东运单', 'title'); has(z.ctx.sheetJd(), '生成并发货', 'button');
    const N = (s) => s.replace(/\s*\n\s*/g, ' ').replace(/cuT\( /g, 'cuT(');
    const D = N(DESK);
    for (const [en, zh] of [['Create JD label', '生成京东运单'], ['Free live tracking — JD bills the parcel.', '免费物流追踪，京东承担费用。'],
      ['— or attach an existing waybill manually —', '— 或手动填写已有运单 —'], ['Cancel JD pickup', '取消揽收'],
      ['Air parcel — fresh express (生鲜特快)', '空运包裹 — 生鲜特快'], ['Ground parcel — is it fresh (ice pack) or ambient?', '陆运包裹 — 生鲜(冰袋)还是普通?'],
      ['Pieces (boxes)', '箱数'], ['Create & ship', '生成并发货'], ['Land only', '仅陆运'], ['Land shipping only — airline rejected', '仅陆运 — 航空拒运'],
      ['JD waybill created', '京东运单已生成'], ['Set the store’s sender phone first (Settings → Stores)', '请先在门店设置寄件电话']]) {
      has(D, `cuT('${en}', '${zh}')`, 'the desktop\'s own pair: ' + en);
    }
    for (const s of ["titleEn: 'SF Express only', titleCn: '仅顺丰速运'", "confirmEn: 'Create air waybill anyway', confirmCn: '仍要生成空运运单'",
      "'Cancel the JD pickup / recall this parcel with JD? · 向京东取消揽收 / 拦截此包裹?'", "'JD parcel intercepted (was already collected) · 已拦截在途包裹'",
      "'JD pickup cancelled · 已取消揽收'", "errLabelEn: 'JD label failed', errLabelCn: '生成运单失败'", "errLabelEn: 'JD cancel failed', errLabelCn: '取消揽收失败'",
      "{ code: 'LL-SD-M',   en: 'Fresh · Air',     cn: '生鲜 · 空运', sub: '生鲜特快 · LL-SD-M' }",
      "titleEn: 'Air parcel', titleCn: '空运包裹'", "confirmEn: 'Create ground waybill anyway', confirmCn: '仍要生成陆运运单'",
      "'This parcel is planned for air. Ground is slower. Create the ground waybill anyway?'", "'计划空运,陆运较慢。仍要生成陆运运单吗?'"]) has(D, s, 'the desktop\'s own words: ' + s.slice(0, 44));
    has(CORE, "jd_not_configured:      ['JD Logistics is not set up yet — finish it in Settings → Delivery.', '京东物流尚未配置,请在设置 → 配送中完成。']", 'jd_not_configured\'s sentence');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
