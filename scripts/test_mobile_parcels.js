#!/usr/bin/env node
/**
 * §325 step O6 — PARCELS AND STATUS ON THE PHONE.
 *
 *   node scripts/test_mobile_parcels.js
 *
 * From the desktop's order drawer (public/retail-admin/04-orders.js):
 *   1. Hold for restock (§136) — PATCH status awaiting_restock, its refusals said;
 *   2. parcel recovery (§189) — POST /shipments/:sid/recovery {outcome};
 *   3. a supplier parcel delivered — POST /shipments/:sid/deliver;
 *   4. rider or JD on a Guangzhou outer-district parcel — POST /shipments/:sid/method;
 *   5. reopening a handled air delay — POST /air-delay/ack {cleared:false};
 *   6. ship part later — POST /shipments/split {item_ids};
 *   7. the split suggestion — POST /shipment-suggestion/apply.
 * Every one is under /orders, so orders:edit (lib/cap-routes.js).
 *
 * The code is RUN, sliced out of public/m.html, so this needs no browser and
 * sits in the fast shard. Every write is asserted on method, path and body.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
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
  sliceBetween('/* ── §325 O6 — the parcel writes, one helper.', "reg('dispatchParcel',"),
  sliceFn('parcelExtras'), sliceFn('splitSuggestionCard'), sliceFn('orderActs'), sliceFn('orderErrorText'),
  sliceBetween('const ORDER_ALSO={', '\n};\n') + '\n};',
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  sliceFn('orderBreakdown'),
  sliceFn('itemOpts'), sliceBetween('\nconst ITEM_TUPLE=', '\nfunction '), sliceFn('mapDetail'),
].join('\n');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const IT = (id, name, qty) => [qty, [name, name + '中'], '¥10.00', 'SKU' + id, '', null, id];

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const order = Object.assign({ id: 'TC7', _id: 7, raw: 'paid', rawStatus: 'paid', refundStatus: null, viewOnly: false, shipments: [] }, opts.order || {});
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (k) => `<i data-ic="${k}"></i>`, money: (c, v) => c + Number(v || 0).toFixed(2),
    pill: (k, t) => `<span class="pill" data-k="${k}">${t}</span>`,
    tdWhen: (v) => 'W(' + v + ')', _tdL: () => 'x',
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    state: { parcelBusy: null, orderErr: null, ask: null, askErr: null, splitPick: null, splitDismissed: [], detailId: 'TC7', liveDetail: null, detailActions: false },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    currentOrder: () => order, findOrder: () => order,
    shopNoteReady: () => false, shopNoteShown: () => false, orderHasWaybill: () => false,
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => {},
    api: (p) => { calls.reads.push(p); return Promise.resolve({ id: 7, order_no: 'TC7', status: 'paid', items: [] }); },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      if (opts.refuse) return Promise.reject(Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] }));
      if (opts.fail) return Promise.reject(Object.assign(new Error(opts.fail.message), { code: opts.fail.code }));
      return Promise.resolve({ success: true });
    },
    mapOrderRow: (r) => ({ id: r.order_no, _id: r.id }), shipByPlan: () => null, shipByUrgency: () => ({ level: 'none' }),
    orderWaitingOn: () => null, chanMoneyOf: () => null,
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls, order };
}

async function main() {
  console.log('\n0 · the server gate');
  {
    const A = '/api/retail-admin/orders/7';
    for (const [m, p] of [['PATCH', '/status'], ['POST', '/shipments/3/recovery'], ['POST', '/shipments/3/deliver'], ['POST', '/shipments/3/method'],
      ['POST', '/air-delay/ack'], ['POST', '/shipments/split'], ['POST', '/shipment-suggestion/apply']]) {
      is(requiredCapFor(m, A + p), 'orders:edit', m + ' ' + p + ' is orders:edit');
    }
  }

  console.log('\n1 · Hold for restock (§136)');
  {
    const m = mk();
    const acts = m.ctx.orderActs(m.order).map((a) => a[2]);
    is(acts[0], "APP.cmd('advance','awaiting_restock')", 'a paid order offers it first, as the desktop does');
    has(m.ctx.orderActs(m.order)[0][1], 'Hold for restock', 'labelled as the desktop labels it');
    hasnt(mk({ caps: ['orders:view', 'orders:refund'] }).ctx.orderActs(m.order).map((a) => a[2]).join(), 'awaiting_restock', 'not for an account without orders:edit');
    hasnt(mk({ order: { raw: 'preparing', rawStatus: 'preparing' } }).ctx.orderActs(Object.assign({}, m.order, { raw: 'preparing' })).map((a) => a[2]).join(), 'awaiting_restock', 'only from paid');
    for (const [code, msg] of [['nothing_short', 'Every item on this order is covered at its store right now, so there is nothing for it to wait on.'],
      ['line_not_stocked_here', 'This order holds an item that is not stocked at its store…'], ['no_fulfilling_store', 'This order has no fulfilling store…']]) {
      is(m.ctx.orderErrorText({ code, message: msg }), msg, 'the server\'s own sentence for ' + code);
    }
  }

  console.log('\n2 · a parcel that was out when its order was cancelled (§189)');
  {
    const sp = { id: 3, mode: 'land', state: 'dispatched', items: [IT(11, 'Oat milk', 1)], recoveryNeeded: '2026-10-01', recoveryOutcome: null };
    const m = mk();
    const h = m.ctx.parcelExtras(m.order, sp);
    has(h, 'This parcel was already out when the order was cancelled', 'says what happened');
    has(h, 'Only "it came back" puts the stock on the shelf.', 'and what each answer does');
    m.CMD.parcelRecovery(3, 'recovered');
    has(m.ctx.state.ask.title, 'Put this parcel back on the shelf?', 'asks first');
    is(m.calls.writes, [], 'nothing before the answer');
    m.ctx.state.ask.run(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/shipments/3/recovery', method: 'POST', body: { outcome: 'recovered' } }], 'POST /shipments/:sid/recovery {outcome}');
    is(m.calls.toasts, ['Parcel recovered'], 'confirmed'); is(m.calls.reads, ['/orders/7'], 'and the order is read again');
    const n = mk(); n.CMD.parcelRecovery(3, 'not_recovered');
    is([n.ctx.state.ask.danger, n.ctx.state.ask.confirmLabel], [true, 'It did not come back'], 'not recovered is the danger answer');
    n.ctx.state.ask.run(); await tick();
    is(n.calls.writes[0].body, { outcome: 'not_recovered' }, '…and sends not_recovered');
    const done = mk().ctx.parcelExtras(mk().order, Object.assign({}, sp, { recoveryOutcome: 'recovered', recoveryClosedAt: 't', recoveryClosedBy: 'ash' }));
    has(done, 'Recovered', 'a closed case says how it ended'); has(done, 'W(t) · ash', 'when and by whom'); hasnt(done, 'parcelRecovery', 'with nothing to press');
    hasnt(mk({ caps: ['orders:view'] }).ctx.parcelExtras(m.order, sp), 'parcelRecovery', 'a reader sees the case and no buttons (capability-denied)');
  }

  console.log('\n3 · a supplier parcel delivered');
  {
    const sp = { id: 4, mode: 'supplier', state: 'dispatched', items: [IT(12, 'Wine', 1)] };
    const m = mk();
    const h = m.ctx.parcelExtras(m.order, sp);
    has(h, 'Ships directly from the supplier', 'the desktop\'s instruction'); has(h, "APP.cmd('parcelDelivered',4)", 'and the button once it is on its way');
    hasnt(m.ctx.parcelExtras(m.order, Object.assign({}, sp, { state: 'pending' })), 'parcelDelivered', 'not before it is on its way');
    m.CMD.parcelDelivered(4);
    has(m.ctx.state.ask.body, 'If it was the last parcel, the order is marked delivered.', 'asks, saying what follows');
    m.ctx.state.ask.run(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/shipments/4/deliver', method: 'POST', body: {} }], 'POST /shipments/:sid/deliver');
    is(m.calls.toasts, ['Parcel delivered'], 'confirmed');
  }

  console.log('\n4 · rider or JD');
  {
    const sp = { id: 5, mode: 'local', state: 'pending', items: [IT(13, 'Bread', 1)] };
    const m = mk({ order: { gzMethodToggle: true } });
    const h = m.ctx.parcelExtras(m.order, sp);
    has(h, 'Dispatch method', 'headed'); has(h, "disabled aria-pressed=\"true\" onclick=\"APP.cmd('parcelMethod',5,'local')\"", 'the method it is on cannot be picked again');
    m.CMD.parcelMethod(5, 'land'); await tick();
    is(m.calls.writes, [{ p: '/orders/7/shipments/5/method', method: 'POST', body: { method: 'land' } }], 'POST /shipments/:sid/method {method}');
    is(m.calls.toasts, ['Switched to JD logistics'], 'confirmed');
    hasnt(mk().ctx.parcelExtras(mk().order, sp), 'Dispatch method', 'only where the server offers the switch');
    hasnt(m.ctx.parcelExtras(m.order, Object.assign({}, sp, { state: 'delivered' })), 'Dispatch method', 'not once delivered');
    hasnt(m.ctx.parcelExtras(m.order, Object.assign({}, sp, { mode: 'air' })), 'Dispatch method', 'not on an Air parcel');
  }

  console.log('\n5 · a handled air delay, reopened');
  {
    const m = mk();
    m.CMD.reopenAirDelay(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/air-delay/ack', method: 'POST', body: { cleared: false } }], 'POST /air-delay/ack {cleared:false}');
    is(m.calls.toasts, ['Air delay re-opened'], 'confirmed');
    has(src, "onclick=\"APP.cmd('reopenAirDelay')\"", 'the handled line carries the Undo');
    has(src, "(sp.lateDays>0&&!o.viewOnly&&o._id!=null&&mCan('orders:edit'))?`<button class=\"rowact\"", '…for orders:edit, on a parcel that was late');
  }

  console.log('\n6 · ship part later');
  {
    const sp = { id: 6, mode: 'land', state: 'pending', items: [IT(21, 'Rice', 2), IT(22, 'Tea', 1)] };
    const m = mk();
    let h = m.ctx.parcelExtras(m.order, sp);
    has(h, "APP.cmd('splitPickOpen',6)", 'a pending parcel with two lines offers it');
    hasnt(m.ctx.parcelExtras(m.order, Object.assign({}, sp, { items: [IT(21, 'Rice', 2)] })), 'splitPickOpen', 'one line cannot be split');
    hasnt(m.ctx.parcelExtras(m.order, Object.assign({}, sp, { state: 'dispatched' })), 'splitPickOpen', 'nor a parcel that has gone');
    m.CMD.splitPickOpen(6);
    h = m.ctx.parcelExtras(m.order, sp);
    has(h, 'Tick the items that ship <b>later</b>', 'the desktop\'s instruction'); has(h, 'Rice', 'the lines are listed');
    m.CMD.splitPickGo();
    is(m.ctx.state.splitPick.err, 'Tick at least one item to ship later', 'nothing ticked is refused');
    m.CMD.splitPickT(22); m.CMD.splitPickGo(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/shipments/split', method: 'POST', body: { item_ids: [22] } }], 'POST /shipments/split {item_ids}');
    is([m.calls.toasts, m.ctx.state.splitPick], [['Moved to follow-up parcel'], null], 'confirmed, and the panel closes');
  }

  console.log('\n7 · the split suggestion');
  {
    const sug = { eligible: true, savings: 12, current: { cost: 40 }, suggested: { cost: 28, plan: [
      { mode: 'air', cost: 18, value: 120, grams: 800, item_ids: [1, 2] }, { mode: 'land', cost: 10, value: 60, grams: 2500, item_ids: [3] }] } };
    const m = mk({ order: { suggestion: sug } });
    const h = m.ctx.splitSuggestionCard(m.order);
    has(h, 'Suggested: split into 2 packages', 'headed'); has(h, 'save ¥12.00', 'the saving');
    has(h, 'Current freight ¥40.00 → split freight ¥28.00', 'before and after'); has(h, 'Air package', 'the air bucket');
    has(h, '2 products · ¥120.00 · 800 g', 'its lines, value and weight'); has(h, '2.5 kg', 'kilograms past a thousand grams');
    m.CMD.splitSugApply(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/shipment-suggestion/apply', method: 'POST', body: {} }], 'POST /shipment-suggestion/apply');
    is(m.calls.toasts, ['Split applied'], 'confirmed');
    const d = mk({ order: { suggestion: sug } }); d.CMD.splitSugDismiss();
    is(d.ctx.splitSuggestionCard(d.order), '', 'Dismiss hides it for this session');
    is(mk({ caps: ['orders:view'], order: { suggestion: sug } }).ctx.splitSuggestionCard(Object.assign({}, m.order)), '', 'no card without orders:edit');
  }

  console.log('\n8 · refusals and the detail read');
  {
    const r = mk({ refuse: true });
    r.CMD.parcelMethod(5, 'land'); await tick();
    is(String(r.ctx.state.orderErr), 'Your role does not include this action.', 'a refusal says why, on the order');
    is([r.ctx.state.parcelBusy, r.calls.toasts], [null, []], 'the controls come back and nothing is toasted');
    const f = mk({ fail: { code: 'nothing_short', message: 'Every item on this order is covered at its store right now, so there is nothing for it to wait on.' } });
    f.CMD.splitPickOpen(6); f.CMD.splitPickT(22); f.CMD.splitPickGo(); await tick();
    ok(/nothing for it to wait on/.test(String(f.ctx.state.orderErr)), 'a server sentence is shown as the server wrote it');
    const { ctx } = mk();
    const d = ctx.mapDetail({ id: 7, order_no: 'TC7', status: 'cancelled', gz_method_toggle: 1, items: [],
      shipment_suggestion: { eligible: false }, shipments: [{ id: 3, mode: 'land', state: 'dispatched', items: [],
        recovery_needed_at: 'r', recovery_outcome: 'not_recovered', recovery_closed_at: 'c', recovery_closed_by: 'ash' }] });
    is([d.gzMethodToggle, d.suggestion, d.shipments[0].recoveryNeeded, d.shipments[0].recoveryOutcome, d.shipments[0].recoveryClosedBy],
      [true, null, 'r', 'not_recovered', 'ash'], 'the detail read carries the switch, the suggestion (only when eligible) and the recovery case');
  }

  console.log('\n9 · words');
  {
    const z = mk({ lang: 'zh' });
    has(z.ctx.parcelExtras(z.order, { id: 3, mode: 'land', state: 'dispatched', items: [], recoveryNeeded: 'r' }), '订单取消时此包裹已发货', 'Chinese recovery');
    has(z.ctx.orderActs(z.order)[0][1], '等待补货', 'Chinese hold');
    for (const s of ["'Hold for restock · 等待补货'", "cuT('This parcel was already out when the order was cancelled',", "cuT('Put this parcel back on the shelf?', '把此包裹退回货架?')",
      "cuT('It came back', '已收回')", "cuT('It did not come back', '未收回')", "cuT('Parcel recovered', '包裹已收回')", "cuT('Recorded', '已登记')",
      "titleEn: 'Mark parcel delivered?', titleCn: '标记包裹已送达?'", "cuT('Mark this parcel delivered', '标记此包裹已送达')", "'Parcel delivered · 包裹已送达'",
      "cuT('Dispatch method', '配送方式')", "'Rider', '骑手配送'", "'JD logistics', '京东物流'", "'Switched to rider · 已改为骑手配送'",
      "'Switched to JD logistics · 已改为京东物流'", "'Air delay re-opened · 空运延误已恢复'", "Ship part later · 分批发货", "Move to follow-up parcel · 移入后补包裹",
      "'Moved to follow-up parcel · 已移入后补包裹'", "'Tick at least one item to ship later · 请至少勾选一项'", "Suggested: split into 2 packages · 拆分为 2 个包裹",
      "'Split applied · 拆分完成'", "Apply · 拆分", "Dismiss · 忽略", "'Air package' : 'Land package'", "'空运包裹' : '陆运包裹'"]) has(DESK, s, 'desktop: ' + s);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
