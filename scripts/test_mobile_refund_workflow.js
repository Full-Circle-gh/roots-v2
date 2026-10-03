#!/usr/bin/env node
/**
 * §325 step O3 — THE REFUND WORKFLOW ON THE PHONE, FINISHED.
 *
 *   node scripts/test_mobile_refund_workflow.js
 *
 * The desktop's refund panel (public/retail-admin/04-orders.js) and its
 * dialogs, on the phone:
 *   1. Start review, with a note for the customer  — POST /refund/review {note}
 *   2. Approve with full / amount / lines, the points choice and a note, the
 *      consequence line and §222's rider warning     — POST /refund/approve
 *   3. Reject with a reason shown to the customer     — POST /refund/reject {note}
 *   4. Record payout: method (store credit included), reference, amount, note,
 *      and the WeChat warning                         — POST /refund/payout
 *   5. A direct refund by items                       — POST /refund/direct {lines, note}
 *
 * Every one is orders:refund on the server (lib/cap-routes.js); every control
 * is drawn only for it and every command refuses without it. Full by status
 * needs orders:edit as well.
 *
 * The code is RUN, sliced out of the shipped public/m.html, so this needs no
 * browser and sits in the fast shard. Every write is asserted on its request.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const CAPR = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name) {
  let start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) start = src.indexOf('\nasync function ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}

const CODE = [
  sliceBetween("reg('refundOrder',", '/* Off-app payment records WHICH tender'),
  sliceBetween('/* ── §325 O3 — THE REFUND WORKFLOW, FINISHED', '/* TYPING NEVER REPAINTS.'),
  sliceFn('orderActs'),
  sliceFn('orderErrorText'),
  sliceFn('orderWrite'),
  sliceFn('itemOpts'),
  sliceBetween('\nconst ITEM_TUPLE=', '\nfunction '),
  sliceFn('orderBreakdown'),
  sliceFn('mapDetail'),
].join('\n');

const tick = () => new Promise((r) => setImmediate(r));

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], refreshes: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (c, n) => c + Number(n).toFixed(2),
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    state: { rf: null, ask: null, askErr: null, detailActions: true, orderBusy: null, orderErr: null,
      rfHist: { open: true }, liveDetail: null, detailId: null },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    refreshOrders: () => { calls.refreshes++; },
    findOrder: () => null,
    document: { getElementById: () => null },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method: method || 'POST' });
      if (opts.writeFails) return Promise.reject(Object.assign(new Error('not_approvable'), { code: opts.writeFails }));
      return Promise.resolve(opts.answer || { success: true, amount: 27 });
    },
    ORDER_ALSO: { paid: ['dispatched', 'refunded', 'cancelled'], delivered: ['refunded'] },
    orderHasWaybill: () => false, shopNoteReady: () => false, shopNoteShown: () => false,
    mapOrderRow: (r) => ({ id: r.order_no, _id: r.id, total: '¥' + Number(r.total).toFixed(2), totalNum: Number(r.total) || 0,
      raw: r.status, refundStatus: r.refund_status || null, payKey: String(r.payment_method || '').toLowerCase(), courier: r.courier || null, items: [] }),
    shipByPlan: () => null, shipByUrgency: () => ({ level: 'none' }), orderWaitingOn: () => null, chanMoneyOf: () => null,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls };
}
const ITEMS = [
  { id: 101, product_id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', qty: 2, line_total: 70, unit_price: 35, refunded_qty: 0 },
  { id: 102, product_id: 22, name_en: 'Almonds', name_cn: '杏仁', qty: 3, line_total: 81, unit_price: 27, refunded_qty: 1, size: '500g' },
  { id: 103, product_id: 33, name_en: 'Rice', name_cn: '大米', qty: 1, line_total: 20, unit_price: 20, refunded_qty: 1 },
];
const raw = (over) => Object.assign({ id: 7, order_no: 'TC7', status: 'delivered', total: 171, payment_method: 'wechat',
  points_amount: 0, balance_used: 0, items: ITEMS }, over);
function open(m, over) {
  const d = m.ctx.mapDetail(raw(over));
  m.ctx.state.liveDetail = d; m.ctx.state.detailId = d.id;
  return d;
}

async function main() {
  console.log('\n0 · the server gate these follow');
  {
    for (const p of ['review', 'approve', 'reject', 'payout', 'direct']) {
      is(CAPR.requiredCapFor('POST', '/api/retail-admin/orders/7/refund/' + p), 'orders:refund', `/refund/${p} is orders:refund on the server`);
    }
  }

  console.log('\n1 · who sees the refund rows');
  {
    const m = mk();
    const d = open(m, { refund_status: 'pending', refund_amount_requested: 27 });
    const acts = m.ctx.orderActs(d).map((a) => a[2]);
    is(acts.filter((c) => /Refund'|refund'/i.test(c)), ["APP.cmd('reviewRefund')", "APP.cmd('approveRefund')", "APP.cmd('rejectRefund')"],
      'a new request: Start review, Approve, Reject');
    const rv = mk(); const dv = open(rv, { refund_status: 'reviewing' });
    hasnt(rv.ctx.orderActs(dv).map((a) => a[2]).join(), 'reviewRefund', 'already reviewing: no Start review');
    const nocap = mk({ caps: ['orders:view', 'orders:edit'] });
    const dn = open(nocap, { refund_status: 'pending' });
    for (const c of ['reviewRefund', 'approveRefund', 'rejectRefund', 'payRefund', 'refundOrder', 'rfSubmit']) {
      nocap.CMD[c]();
    }
    is([nocap.ctx.state.ask, nocap.ctx.state.rf, nocap.calls.writes.length], [null, null, 0], 'without orders:refund every refund command refuses, and nothing is sent (capability-denied)');
    hasnt(nocap.ctx.orderActs(dn).map((a) => a[2]).join(), 'Refund', 'and no refund row is drawn for them');
  }

  console.log('\n2 · Start review');
  {
    const m = mk(); open(m, { refund_status: 'pending' });
    m.CMD.reviewRefund();
    const a = m.ctx.state.ask;
    has(a.title, 'Start review', 'asks first'); has(a.body, "Tell the customer you're looking into it.", 'in the desktop\'s words');
    has(a.fields[0].label, 'Note for customer', 'with a note for the customer');
    is(a.confirmLabel, 'Mark reviewing', 'the button says Mark reviewing');
    is(m.calls.writes, [], 'nothing before the button');
    a.run({ note: 'checking stock' }); await tick(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/refund/review', body: { note: 'checking stock' }, method: 'POST' }], 'POST /refund/review {note}');
    is(m.calls.toasts, ['Marked as reviewing'], 'confirmed');
    is(m.ctx.state.rfHist.open, false, 'the history folds, so it is read fresh next time');
  }

  console.log('\n3 · Reject with a reason');
  {
    const m = mk(); open(m, { refund_status: 'pending' });
    m.CMD.rejectRefund();
    const a = m.ctx.state.ask;
    has(a.title, 'Reject refund', 'asks'); has(a.body, 'The customer sees this reason.', 'says the customer sees the reason');
    has(a.fields[0].label, 'Reason (shown to customer)', 'the reason field'); is(a.danger, true, 'as a danger confirm');
    a.run({ note: 'Item was opened' }); await tick(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/refund/reject', body: { note: 'Item was opened' }, method: 'POST' }], 'POST /refund/reject {note}');
    is(m.calls.toasts, ['Refund rejected'], 'confirmed');
    const f = mk({ writeFails: 'not_rejectable' }); open(f, { refund_status: 'pending' });
    f.CMD.rejectRefund(); f.ctx.state.ask.run({ note: '' }); await tick(); await tick();
    has(f.ctx.state.orderErr, 'That did not go through', 'a refusal renders on the order and stays');
    is(f.calls.toasts, [], 'and toasts nothing');
  }

  console.log('\n4 · Approve');
  {
    // The customer asked for part of it by amount.
    const m = mk(); open(m, { refund_status: 'pending', refund_amount_requested: 27 });
    m.CMD.approveRefund();
    let f = m.ctx.state.rf;
    is([f.kind, f.mode, f.amount, f.points], ['approve', 'amount', 27, false], 'opens on what the customer asked for: amount ¥27, points off');
    let html = m.ctx.sheetRefundForm();
    has(html, 'Approve refund', 'titled'); has(html, 'customer asked for ¥27.00', 'says what they asked for');
    has(html, 'Partial refund: the order keeps its status and its delivery.', 'the consequence line says partial');
    has(html, 'Also reverse earned + redeemed points', 'offers the points choice');
    has(html, 'Refunding never changes the delivery day.', 'and the reschedule warning');
    m.CMD.rfType('note', 'sorry'); m.CMD.rfPts();
    m.CMD.rfSubmit();
    has(m.ctx.sheetRefundForm(), 'Working…', 'the button says what it is doing');
    await tick(); await tick();
    is(m.calls.writes[0], { p: '/orders/7/refund/approve', body: { note: 'sorry', amount: 27, reverse_points: true }, method: 'POST' },
      'POST /refund/approve {note, amount, reverse_points}');
    is(m.calls.toasts, ['Approved ¥27.00'], 'confirmed with the amount the server approved');
    is([m.ctx.state.rf, m.calls.refreshes], [null, 1], 'the sheet closes and the order is read again');

    // By the customer's lines.
    const l = mk(); open(l, { refund_status: 'pending', refund_lines_json: JSON.stringify([{ item_id: 102, qty: 1, amount: 27 }]) });
    l.CMD.approveRefund(); f = l.ctx.state.rf;
    is([f.mode, f.chk[102], f.qty[102], f.chk[101]], ['lines', true, 1, false], 'opens on the customer\'s picked line');
    html = l.ctx.sheetRefundForm();
    has(html, 'Almonds · 500g', 'the line is named'); has(html, 'Lines total: <b>¥27.00</b>', 'and totalled');
    l.CMD.rfQty(101, 1);
    is([f.chk[101], f.qty[101]], [true, 2], 'stepping a line ticks it (capped at its quantity)');
    l.CMD.rfChk(101); l.CMD.rfSubmit(); await tick(); await tick();
    is(l.calls.writes[0], { p: '/orders/7/refund/approve', body: { note: '', lines: [{ item_id: 102, qty: 1 }], reverse_points: false }, method: 'POST' },
      'POST /refund/approve {note, lines:[{item_id, qty}], reverse_points}');
    const e = mk(); open(e, { refund_status: 'pending', refund_lines_json: JSON.stringify([{ item_id: 102, qty: 1 }]) });
    e.CMD.approveRefund(); e.CMD.rfChk(102); e.CMD.rfSubmit();
    has(e.ctx.state.rf.err, 'Select at least one line', 'no line picked is refused on the sheet');
    is(e.calls.writes.length, 0, 'and nothing is sent');

    // Full, with a rider on it.
    const r = mk(); open(r, { refund_status: 'pending', courier: { stage: 'in_transit' } });
    r.CMD.approveRefund(); f = r.ctx.state.rf;
    is([f.mode, f.points], ['full', true], 'no amount asked: opens on Full, points on');
    html = r.ctx.sheetRefundForm();
    has(html, 'Full refund: the order is marked refunded, its same-city delivery is cancelled', 'the full consequence');
    has(html, 'A rider is on this order right now — approving cancels that delivery.', '§222: the rider warning, when one is on it');
    hasnt(html, 'Also reverse earned', 'full always reverses points, so no choice is offered');
    r.CMD.rfSubmit(); await tick(); await tick();
    is(r.calls.writes[0].body, { note: '', amount: 171, reverse_points: true }, 'Full sends the total and reverse_points:true');
    const nr = mk(); open(nr, { refund_status: 'pending', refund_amount_requested: 20, courier: { stage: 'in_transit' } });
    nr.CMD.approveRefund();
    hasnt(nr.ctx.sheetRefundForm(), 'A rider is on this order', 'a partial does not pull the rider, so it does not warn');
    // A partial amount that reaches the gross remaining IS full — the server's rule.
    const g = mk(); open(g, { refund_status: 'pending', refund_amount_requested: 20, points_amount: 0 });
    g.CMD.approveRefund(); g.CMD.rfType('amount', '171');
    is(g.ctx.rfIsFull(g.ctx.state.liveDetail, Object.assign({}, g.ctx.state.rf, { amount: 171 })), true, 'typing the whole total into Partial is a full refund');
    const pts = mk(); open(pts, { refund_status: 'pending', refund_amount_requested: 171, points_amount: 30 });
    pts.CMD.approveRefund();
    is(pts.ctx.rfIsFull(pts.ctx.state.liveDetail, Object.assign({}, pts.ctx.state.rf, { mode: 'amount', amount: 171 })), false,
      'on an order paid partly with points, the cash total alone is NOT full (gross tenders)');
    const bad0 = mk(); open(bad0, { refund_status: 'pending', refund_amount_requested: 20 });
    bad0.CMD.approveRefund(); bad0.CMD.rfType('amount', ''); bad0.CMD.rfSubmit();
    has(bad0.ctx.state.rf.err, 'Enter an amount above 0', 'an empty amount is refused on the sheet');
    const ref = mk({ writeFails: 'not_approvable' }); open(ref, { refund_status: 'pending' });
    ref.CMD.approveRefund(); ref.CMD.rfSubmit(); await tick(); await tick();
    has(ref.ctx.sheetRefundForm(), 'That did not go through', 'a refused approve stays on the sheet');
    is([ref.ctx.state.rf.busy, ref.calls.toasts.length], [false, 0], 'the button comes back and nothing is toasted');
  }

  console.log('\n5 · Record payout');
  {
    const m = mk(); open(m, { refund_status: 'approved', refund_amount_approved: 27, payment_method: 'cash' });
    m.CMD.payRefund();
    const f = m.ctx.state.rf;
    is([f.kind, f.method, f.amount], ['payout', 'cash', 27], 'opens on the tender the customer paid with, for the approved amount');
    let html = m.ctx.sheetRefundForm();
    has(html, 'Record payout', 'titled'); has(html, 'value="store_credit"', 'store credit is a method');
    has(html, 'Reference / txn id', 'a reference'); has(html, 'Approved ¥27.00 — usually paid in full', 'the approved figure');
    hasnt(html, "there's no WeChat transaction", 'no warning on a cash payout');
    m.CMD.rfMethod('wechat');
    html = m.ctx.sheetRefundForm();
    has(html, "This order wasn't paid via online WeChat — there's no WeChat transaction to auto-refund.", 'picking WeChat on a cash order warns');
    m.CMD.rfMethod('store_credit'); m.CMD.rfType('ref', 'BANK-1'); m.CMD.rfType('amount', '20'); m.CMD.rfType('note', 'part');
    m.CMD.rfSubmit(); await tick(); await tick();
    is(m.calls.writes[0], { p: '/orders/7/refund/payout', body: { method: 'store_credit', reference: 'BANK-1', amount: 20, note: 'part' }, method: 'POST' },
      'POST /refund/payout {method, reference, amount, note}');
    is(m.calls.toasts, ['Payout recorded ¥27.00'], 'confirmed with the server\'s figure');
    const w = mk(); open(w, { refund_status: 'approved', refund_amount_approved: 10, payment_method: 'wechat' });
    w.CMD.payRefund();
    is(w.ctx.state.rf.method, 'wechat', 'an online WeChat order defaults to WeChat');
    hasnt(w.ctx.sheetRefundForm(), "there's no WeChat transaction", 'and is not warned');
    const e = mk(); open(e, { refund_status: 'approved', refund_amount_approved: 10 });
    e.CMD.payRefund(); e.CMD.rfType('amount', ' '); e.CMD.rfSubmit();
    has(e.ctx.state.rf.err, 'Enter an amount first.', 'an empty amount is refused');
  }

  console.log('\n6 · a direct refund by items');
  {
    const m = mk(); open(m, {});
    m.CMD.refundOrder();
    const a = m.ctx.state.ask;
    is(a.options.map((x) => x.key), ['full', 'amount', 'lines'], 'Refund offers Full, by amount and — new — by items');
    a.run('lines');
    const f = m.ctx.state.rf;
    is(f.kind, 'direct', 'by items opens the item sheet');
    const html = m.ctx.sheetRefundForm();
    has(html, 'Items to refund', 'headed'); has(html, 'Oat milk', 'a refundable line');
    has(html, '1 already refunded', 'a part-refunded line says how much already went');
    hasnt(html, 'Rice', 'a fully refunded line is not offered');
    is(f.qty[102], 2, 'a part-refunded line offers only what is left');
    m.CMD.rfQty(102, 5);
    is(f.qty[102], 2, 'and cannot be stepped past it');
    m.CMD.rfChk(102);
    m.CMD.rfSubmit();
    has(f.err, 'Select at least one item', 'nothing picked is refused');
    m.CMD.rfChk(101); m.CMD.rfType('note', 'damaged'); m.CMD.rfSubmit(); await tick(); await tick();
    is(m.calls.writes[0], { p: '/orders/7/refund/direct', body: { note: 'damaged', lines: [{ item_id: 101, qty: 2 }] }, method: 'POST' },
      'POST /refund/direct {note, lines}');
    is(m.calls.toasts, ['Refunded ¥27.00'], 'confirmed');
    const man = mk({ answer: { success: true, method: 'manual', amount: 70 } }); open(man, {});
    man.CMD.refundOrder(); man.ctx.state.ask.run('lines'); man.CMD.rfChk(101); man.CMD.rfSubmit(); await tick(); await tick();
    is(man.calls.toasts, ['Recorded ¥70.00 — pay the customer back by hand (paid off-app)'], 'an off-app order says to pay by hand');
    const ro = mk({ caps: ['orders:view', 'orders:refund'] }); open(ro, {});
    ro.CMD.refundOrder();
    is(ro.ctx.state.ask.options.map((x) => x.key), ['amount', 'lines'], 'without orders:edit, Full (a status change) is not offered');
    const z = mk({ lang: 'zh' }); open(z, {});
    z.CMD.refundOrder(); z.ctx.state.ask.run('lines');
    const zh = z.ctx.sheetRefundForm();
    for (const w of ['退款商品', '商品合计', '原因 / 备注', '燕麦奶']) has(zh, w, 'Chinese: ' + w);
  }

  console.log('\n7 · the words are the desktop\'s');
  {
    for (const s of ["titleEn: 'Start review', titleCn: '开始处理'", "labelEn: 'Note for customer', labelCn: '给顾客的备注'",
      "submitEn: 'Mark reviewing', submitCn: '开始处理'", "okEn: 'Marked as reviewing', okCn: '已开始处理'",
      "titleEn: 'Reject refund', titleCn: '拒绝退款'", "labelEn: 'Reason (shown to customer)', labelCn: '原因(顾客可见)'",
      "okEn: 'Refund rejected', okCn: '退款已拒绝'", 'Approve refund · 批准退款', 'Partial — amount · 部分金额', 'Partial — by items · 按商品',
      'Staff note (shown to customer) · 客服备注(顾客可见)', 'Also reverse earned + redeemed points · 同时退还积分',
      '全额退款:订单将标记为已退款,同城配送将被取消', '部分退款:订单状态与配送均不变', '退款不会更改配送日期。',
      'Record payout · 记录退款', 'Store credit · 店铺余额', 'Reference / txn id · 凭证号', '此订单非微信在线支付',
      'Mark paid · 确认已退款', 'Payout recorded · 退款已记录', "cuT('Part — by items', '部分 — 按商品')", "cuT('Items to refund', '退款商品')",
      "cuT('Everything has already been refunded', '已全部退款')", "cuT('already refunded', '已退')", "cuT('Select at least one item', '至少选一项')",
      'Select at least one line · 至少选一项', "cuT('customer asked for', '顾客申请')", "cuT('Lines total', '商品合计')"]) {
      has(DESK, s, 'desktop: ' + s);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
