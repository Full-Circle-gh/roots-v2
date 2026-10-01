#!/usr/bin/env node
/**
 * §325 step O1 — THE ORDER FACTS THE PHONE DID NOT SHOW.
 *
 *   node scripts/test_mobile_orders_facts.js
 *
 * The desktop order drawer (public/retail-admin/04-orders.js) carries facts the
 * phone's order sheet never drew, every one of them already in the
 * GET /orders/:id payload:
 *
 *   1. the guest pay link of an unpaid order, with Copy (orderPayLinkTile);
 *   2. "address changed by the customer" (addressChangedNote);
 *   3. the pre-order lines and "rerouted, shop was closed"
 *      (preorderSoldNote, movedFromNote);
 *   4. was the customer told (wasCustomerToldBlock) — read only;
 *   5. refund history (openRefundEvents, GET /orders/:id/refund/events);
 *   6. a Meituan / Eleme order's settlement (renderChannelMoneyPanel), with the
 *      shop's takings withheld on the three no-money boards;
 *   7. the stock-reservation table, only when a hold is abnormal;
 *   8. the partial-refund badge on a list row (refundBadge);
 *   9. where a same-city rider collects and what is parking it, in words, no
 *      map (renderQyShipFrom and its two parked surfaces).
 *
 * The code is RUN, sliced out of the shipped public/m.html into a sandbox (the
 * harness test_mobile_waiting_on.js uses), so it needs no browser and sits in
 * the fast shard. The one request this step adds is a read, and it is
 * asserted on its path; the step adds no write.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
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
  sliceBetween('const PILL = {', '\n};\n') + '\n};',
  sliceBetween('const REFUND_STATE={', '\nfunction refundPanel('),
  sliceFn('refundPanel'),
  sliceBetween('/* ── §325 O1 — REFUND HISTORY', '/* The band under the total when it disagrees'),
  sliceFn('itemOpts'),
  sliceBetween('\nconst ITEM_TUPLE=', '\nfunction '),
  sliceFn('orderWaitingOn'),
  sliceFn('chanMoneyOf'),
  sliceFn('mapOrderRow'),
  sliceFn('mapDetail'),
  sliceBetween("reg('copyPayLink',", "reg('copyTxn',"),
  'globalThis.__x={ITEM_TUPLE};',
].join('\n');

function mk(opts = {}) {
  const calls = { gets: [], copies: [], renders: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (c, n) => c + Number(n).toFixed(2),
    tdWhen: (v) => 'W(' + v + ')', _tdL: () => 'x',
    fmtDay: (v) => 'D(' + v + ')',
    fmtTime: (v) => (v ? 'H(' + v + ')' : ''),
    courierAgo: (v) => (v ? 'ago(' + v + ')' : ''),
    _date: (v) => { if (!v) return null; let t = String(v).replace(' ', 'T'); if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z'; const d = new Date(t); return isNaN(d.getTime()) ? null : d; },
    recapNoMoney: () => !!opts.noMoney,
    location: { origin: 'https://shop.example' },
    state: {
      rfHist: { open: false, id: null, busy: false, err: false, rows: null },
      liveDetail: opts.detail || null, detailId: opts.detail ? opts.detail.id : null,
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    findOrder: () => null,
    copyText: (t) => calls.copies.push(t),
    api: (p) => {
      calls.gets.push(p);
      if (opts.apiFails) return Promise.reject(new Error('HTTP 500'));
      return opts.slow ? new Promise((r) => { calls.release = () => r(opts.events || []); }) : Promise.resolve(opts.events || []);
    },
    // mapOrderRow's neighbours — not under test here, stubbed flat.
    ORDER_STATUS: { paid: ['paid', 'Paid', '已支付'], delivered: ['done', 'Delivered', '已送达'], refunded: ['refund', 'Refunded', '已退款'], pending_payment: ['pending', 'Pending', '待付款'] },
    CH_BACK: { wechat: 'miniapp', meituan: 'meituan', eleme: 'eleme' },
    custLines: (r) => ({ name: r.recipient_name || '—', phone: r.recipient_phone || '—' }),
    earlyShipFacts: () => null, routingNotePair: () => null, orderNotes: () => null,
    listWaitingOn: () => null, parcelRollup: () => null, isMirrorCh: (c) => ['meituan', 'eleme', 'gzgrocery'].includes(String(c || '').toLowerCase()),
    payNoteOf: () => null, payLabel: () => ['WeChat', '微信'], payIsKnown: () => true,
    payStatusWord: () => null, primaryPayment: () => null,
    shipByPlan: () => null, shipByUrgency: () => ({ level: 'none' }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

const ITEMS = [
  { id: 101, product_id: 11, name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', qty: 2, unit_price: 35, line_total: 70 },
  { id: 102, product_id: 22, name_en: 'Almonds', name_cn: '杏仁', qty: 1, unit_price: 27, line_total: 27 },
];
const raw = (over) => Object.assign({
  id: 7, order_no: 'TC000900', status: 'paid', total: 97, subtotal: 97, channel: 'wechat',
  recipient_name: 'Li', recipient_phone: '13800000000', address_full: '天河路 1 号',
  store_code: 'TH', store_name_en: 'Tianhe', store_name_cn: '天河店', items: ITEMS,
}, over);

async function main() {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n1 · the guest pay link');
  {
    const { ctx, CMD, calls } = mk();
    const d = ctx.mapDetail(raw({ status: 'pending_payment', pay_token: 'abc123' }));
    is(d.payPath, '/pay/abc123', 'an unpaid order with a token carries its path');
    is(ctx.mapDetail(raw({ status: 'paid', pay_token: 'abc123' })).payPath, null, 'a paid order has nothing to collect');
    is(ctx.mapDetail(raw({ status: 'pending_payment', pay_token: 'abc123', total: 0 })).payPath, null, 'a zero-total order has no pay page');
    is(ctx.mapDetail(raw({ status: 'pending_payment', pay_token: null })).payPath, null, 'no token, no link');
    const html = ctx.payLinkBlock(d);
    has(html, 'https://shop.example/pay/abc123', 'the link is the shop origin + /pay/<token>');
    has(html, 'Payment link', 'headed as the desktop heads it');
    has(html, 'Open pay page', 'opens the pay page');
    has(html, 'Send this to the customer, or show the page for them to scan.', 'with the desktop\'s instruction');
    has(html, "APP.cmd('copyPayLink')", 'Copy is wired');
    is(ctx.payLinkBlock(ctx.mapDetail(raw({}))), '', 'nothing is drawn on a paid order');
    ctx.state.liveDetail = d; ctx.state.detailId = d.id;
    CMD.copyPayLink();
    is(calls.copies, ['https://shop.example/pay/abc123'], 'Copy copies the whole link');
    ctx.state.liveDetail = ctx.mapDetail(raw({})); ctx.state.detailId = 'TC000900';
    CMD.copyPayLink();
    is(calls.copies.length, 1, 'no link, nothing copied');
    is(calls.gets, [], 'no request is made by any of it');
    const z = mk({ lang: 'zh' });
    const zh = z.ctx.payLinkBlock(z.ctx.mapDetail(raw({ status: 'pending_payment', pay_token: 'abc123' })));
    has(zh, '付款链接', 'Chinese heading'); has(zh, '打开付款页', 'Chinese open'); has(zh, '发给顾客,或打开页面让其扫码支付。', 'Chinese instruction');
  }

  console.log('\n2 · the customer moved the ship-to');
  {
    const { ctx } = mk();
    const before = ctx.addrMovedNote(ctx.mapDetail(raw({ address_changed_at: '2026-10-01 02:00:00' })));
    has(before, 'Address changed by the customer', 'names what happened');
    has(before, 'Check the shipping label against the address above before this goes out', 'with the instruction, before it goes out');
    has(before, 'W(2026-10-01 02:00:00)', 'and when');
    has(before, 'amber-tint', 'as an amber band');
    const after = ctx.addrMovedNote(ctx.mapDetail(raw({ address_changed_at: '2026-10-01 02:00:00', dispatched_at: '2026-10-01 05:00:00' })));
    has(after, 'Address changed by the customer', 'after dispatch the fact stays');
    hasnt(after, 'Check the shipping label', 'but the instruction goes');
    hasnt(after, 'amber-tint', 'and so does the band');
    is(ctx.addrMovedNote(ctx.mapDetail(raw({}))), '', 'an address nobody changed draws nothing');
  }

  console.log('\n3 · pre-order lines and the closed shop it was rerouted from');
  {
    const { ctx } = mk();
    const d = ctx.mapDetail(raw({ preorder_pids: '[22, 99]', moved_from_store: ' BY ' }));
    is(d.preorderSold, [['Almonds', '杏仁'], ['#99', '#99']], 'the pre-order line is named; a line that is gone reads as its id');
    is(d.movedFrom, 'BY', 'the shop it would have gone to');
    is(ctx.mapDetail(raw({ preorder_pids: 'not json' })).preorderSold, null, 'an unreadable column is no note, and no throw');
    is(ctx.mapDetail(raw({})).movedFrom, null, 'nothing moved, nothing said');
    has(src, "T('Rerouted, shop was closed','改派 · 门店已关闭')", 'the Fulfilled-by card says "rerouted, shop was closed"');
    has(src, "${T('Pre-order','预订')}</span>", 'and heads the lines "Pre-order"');
    has(src, '${o.preorderSold.map(', 'and lists them');
  }

  console.log('\n4 · was the customer told (read only)');
  {
    const { ctx } = mk();
    const d = ctx.mapDetail(raw({ notifications: [
      { kind: 'order_dispatched', channel: 'wechat', ok: false, error: 'no_consent', created_at: '2026-10-01 03:00:00' },
      { kind: 'order_paid', channel: 'sms', ok: true, error: null, created_at: '2026-10-01 01:00:00' },
      { kind: 'pickup_ready', channel: 'email', ok: false, error: 'mailbox_full', created_at: '2026-10-01 00:30:00' },
    ] }));
    const html = ctx.toldCard(d);
    has(html, 'Was the customer told', 'headed as the desktop heads it');
    has(html, 'Dispatched', 'what the message was about'); has(html, 'WeChat', 'how it went');
    has(html, 'they have not agreed to be messaged in the mini app', 'why it did not arrive, in words');
    has(html, 'Payment received', 'a sent one is listed too'); has(html, 'Text', 'SMS reads as Text');
    has(html, 'Pickup ready', 'an unknown kind reads as words'); has(html, 'Mailbox full', 'and so does an unknown reason');
    has(html, 'W(2026-10-01 03:00:00)', 'with when');
    hasnt(html, 'renotify', 'no Try-again yet — the write is a later step');
    hasnt(html, 'APP.cmd', 'the card has no control at all');
    is(ctx.toldCard(ctx.mapDetail(raw({ notifications: [] }))), '', 'nothing attempted, no card');
    is(ctx.toldCard(ctx.mapDetail(raw({}))), '', 'no field, no card');
    const z = mk({ lang: 'zh' });
    const zh = z.ctx.toldCard(z.ctx.mapDetail(raw({ notifications: [{ kind: 'order_dispatched', channel: 'wechat', ok: false, error: 'no_consent', created_at: 'x' }] })));
    has(zh, '顾客是否已收到通知', 'Chinese heading'); has(zh, '已发货', 'Chinese kind'); has(zh, '微信', 'Chinese channel');
    has(zh, '顾客未在小程序中同意接收通知', 'Chinese reason');
  }

  console.log('\n5 · refund history');
  {
    const events = [
      { id: 1, event: 'pending', amount: 27, note: 'broken', customer_nickname: 'Li', created_at: '2026-10-01 01:00:00', meta: { lines: [{ item_id: 102, qty: 1, amount: 27 }, { item_id: 555, qty: 1, amount: 3 }] } },
      { id: 2, event: 'approved', amount: 27, user_username: 'ash', user_id: 3, created_at: '2026-10-01 02:00:00', meta: { is_full: false } },
      { id: 3, event: 'paid', amount: 27, user_id: 9, created_at: '2026-10-01 03:00:00', meta: { method: 'wechat', reference: 'WX123' } },
      { id: 4, event: 'escalated', amount: null, created_at: '2026-10-01 04:00:00', meta: null },
    ];
    const detail = (m) => m.ctx.mapDetail(raw({ refund_status: 'paid', refund_amount_paid: 27 }));
    const m = mk({ events });
    const d = detail(m); m.ctx.state.liveDetail = d; m.ctx.state.detailId = d.id;
    const panel0 = m.ctx.refundPanel(d);
    has(panel0, "APP.cmd('rfHist')", 'the refund panel offers History');
    has(panel0, 'History', 'labelled as the desktop labels it');
    hasnt(panel0, 'Refund history', 'folded until asked for');
    m.CMD.rfHist();
    is(m.calls.gets, ['/orders/7/refund/events'], 'History reads GET /orders/:id/refund/events, by the order\'s database id');
    has(m.ctx.refundPanel(d), 'Loading…', 'says it is loading while it reads');
    await tick(); await tick();
    const html = m.ctx.refundPanel(d);
    has(html, 'Refund history', 'unfolds under its heading');
    has(html, 'Refund requested', 'a step is named with the panel\'s own words');
    has(html, 'Refund approved', 'approved'); has(html, 'Refund paid', 'paid');
    has(html, 'Escalated', 'an unknown step reads as words');
    has(html, 'by Li', 'a customer\'s step names the customer');
    has(html, 'by ash', 'a staff step names the staff member');
    has(html, 'by staff#9', 'a staff member with no name falls back to the id, as the desktop does');
    has(html, 'Almonds ×1', 'a refunded line is named off the order');
    has(html, '#555 ×1', 'a line that is gone reads as its id');
    has(html, 'broken', 'the note is shown');
    has(html, 'Payout: wechat · WX123', 'the payout method and reference');
    has(html, '¥27.00', 'the amount');
    m.CMD.rfHist();
    hasnt(m.ctx.refundPanel(d), 'Refund history', 'a second tap folds it');
    is(m.calls.gets.length, 1, 'folding reads nothing');

    const e = mk({ events: [] });
    const de = detail(e); e.ctx.state.liveDetail = de; e.ctx.state.detailId = de.id;
    e.CMD.rfHist(); await tick(); await tick();
    has(e.ctx.refundPanel(de), 'No events yet', 'an empty answer looks empty');

    const f = mk({ apiFails: true });
    const df = detail(f); f.ctx.state.liveDetail = df; f.ctx.state.detailId = df.id;
    f.CMD.rfHist(); await tick(); await tick();
    const fh = f.ctx.refundPanel(df);
    has(fh, 'Could not load this.', 'a failed read says so, where the operator is looking');
    has(fh, 'Try again', 'and offers to try again');
    f.CMD.rfHist();
    is(f.calls.gets.length, 2, 'Try again reads again');

    const s = mk({ events, slow: true });
    const ds = detail(s); s.ctx.state.liveDetail = ds; s.ctx.state.detailId = ds.id;
    s.CMD.rfHist();
    s.CMD.rfHist();
    is(s.calls.gets.length, 1, 'a second tap while reading does not read twice');
    s.ctx.state.rfHist.id = 999;             // another order took the slot
    s.calls.release(); await tick(); await tick();
    is(s.ctx.state.rfHist.rows, null, 'a slow answer is not painted into another order\'s panel');

    const z = mk({ lang: 'zh', events });
    const dz = detail(z); z.ctx.state.liveDetail = dz; z.ctx.state.detailId = dz.id;
    z.CMD.rfHist(); await tick(); await tick();
    const zh = z.ctx.refundPanel(dz);
    has(zh, '退款历史', 'Chinese heading'); has(zh, '操作人', 'Chinese "by"'); has(zh, '退款明细', 'Chinese lines'); has(zh, '打款', 'Chinese payout');
    has(zh, '杏仁 ×1', 'a line in Chinese');
  }

  console.log('\n6 · a marketplace order\'s settlement');
  {
    const mt = (over) => raw(Object.assign({ channel: 'meituan', subtotal: 45, packing_fee: 1.5, shipping_fee: 5, channel_discount: 5.5, total: 46,
      channel_commission: 8, channel_settle_amount: 38 }, over));
    const { ctx } = mk();
    const html = ctx.settlePanel(ctx.mapDetail(mt({})));
    has(html, 'Settlement', 'headed Settlement');
    has(html, 'Subtotal', 'the items'); has(html, 'Packing', 'packing'); has(html, 'Customer delivery fee', 'delivery');
    has(html, 'Merchant discount', 'the discount'); has(html, '−¥5.50', 'as a deduction');
    has(html, 'Commission', 'reconciled and published: the commission'); has(html, '−¥8.00', 'as a deduction');
    has(html, 'Estimated income', 'and the estimated income'); has(html, '¥38.00', 'its figure');
    const off = mk({ noMoney: true });
    const oh = off.ctx.settlePanel(off.ctx.mapDetail(mt({})));
    has(oh, 'Subtotal', 'a no-money board still sees what the customer paid');
    hasnt(oh, 'Commission', 'but not the commission (capability-denied case: the takings)');
    hasnt(oh, 'Estimated income', 'nor the income');
    const gap = ctx.settlePanel(ctx.mapDetail(mt({ total: 41 })));
    has(gap, 'These rows add up to ¥46.00, but the order records ¥41.00 — ¥5.00 unaccounted for. Check the channel before refunding.', 'rows that do not add up say by how much');
    hasnt(gap, 'Estimated income', 'and print no income');
    has(off.ctx.settlePanel(off.ctx.mapDetail(mt({ total: 41 }))), 'Check the channel before refunding.', 'the refund warning stays on a no-money board');
    has(ctx.settlePanel(ctx.mapDetail(mt({ channel_commission: null }))), 'Commission and income not published by the channel yet.', 'reconciled, not yet published: says so');
    hasnt(off.ctx.settlePanel(off.ctx.mapDetail(mt({ channel_commission: null }))), 'not published', 'that note is about the takings, so a no-money board does not get it');
    is(ctx.mapDetail(raw({})).settle, null, 'a shop order has no settlement');
    is(ctx.settlePanel(ctx.mapDetail(raw({ channel: 'gzgrocery' }))), '', 'nor does gzgrocery');
    has(ctx.settlePanel(ctx.mapDetail(mt({ channel: 'Eleme' }))), 'Settlement', 'Eleme, any case, gets it');
    const z = mk({ lang: 'zh' });
    const zh = z.ctx.settlePanel(z.ctx.mapDetail(mt({})));
    for (const w of ['结算明细', '小计', '打包费', '顾客配送费', '商家对顾客的活动补贴', '佣金', '预计收入']) has(zh, w, 'Chinese: ' + w);
    has(z.ctx.settlePanel(z.ctx.mapDetail(mt({ total: 41 }))), '以上各项合计 ¥46.00，但订单金额为 ¥41.00 — 相差 ¥5.00。退款前请先核对平台。', 'Chinese gap note');
  }

  console.log('\n7 · stock holds, only when one went wrong');
  {
    const { ctx } = mk();
    const r = (over) => Object.assign({ id: 1, product_id: 11, qty: 2, channel: 'wechat', status: 'committed', expires_at: '2026-01-01 00:00:00', committed_at: '2026-01-01 00:01:00', released_at: null, product_name_en: 'Oat milk', product_name_cn: '燕麦奶' }, over);
    is(ctx.resvCard(ctx.mapDetail(raw({ reservations: [r({})] }))), '', 'a healthy committed hold draws nothing');
    is(ctx.resvCard(ctx.mapDetail(raw({ reservations: [r({ status: 'pending', expires_at: '2999-01-01 00:00:00' })] }))), '', 'a pending hold inside its expiry draws nothing');
    const exp = ctx.resvCard(ctx.mapDetail(raw({ reservations: [r({}), r({ id: 2, status: 'expired', product_id: 44, product_name_en: null, product_name_cn: null })] })));
    has(exp, 'Stock reservations — needs attention', 'an expired hold draws the card');
    has(exp, 'Oat milk', 'listing every hold'); has(exp, 'product_id 44', 'a nameless one by its id');
    has(exp, '>expired<', 'with the server\'s status word'); has(exp, 'Expires', 'and its times');
    has(ctx.resvCard(ctx.mapDetail(raw({ reservations: [r({ status: 'pending', expires_at: '2020-01-01 00:00:00' })] }))), 'needs attention', 'a pending hold past its expiry is stuck, and drawn');
    has(ctx.resvCard(ctx.mapDetail(raw({ reservations: [r({ status: 'released', released_at: '2026-01-02 00:00:00' })] }))), 'W(2026-01-02 00:00:00)', 'a released hold, with when');
    is(ctx.resvCard(ctx.mapDetail(raw({}))), '', 'no holds, no card');
    const z = mk({ lang: 'zh' });
    has(z.ctx.resvCard(z.ctx.mapDetail(raw({ reservations: [r({ status: 'expired' })] }))), '库存预留 — 需留意', 'Chinese heading');
  }

  console.log('\n8 · a partial refund on the list row');
  {
    const { ctx } = mk();
    is(ctx.mapOrderRow(raw({ refund_status: 'paid', refund_amount_paid: 27 })).partRefund, 27, 'paid back, order not refunded: a partial, with the cumulative amount');
    is(ctx.mapOrderRow(raw({ refund_status: 'paid', refund_amount_paid: null, refund_amount_approved: 12 })).partRefund, 12, 'an older row falls back to approved');
    is(ctx.mapOrderRow(raw({ refund_status: 'paid', refund_amount_requested: 5 })).partRefund, 5, 'then to requested');
    is(ctx.mapOrderRow(raw({ refund_status: 'paid' })).partRefund, 0, 'no figure at all is still a partial, without one');
    is(ctx.mapOrderRow(raw({ refund_status: 'paid', status: 'refunded', refund_amount_paid: 97 })).partRefund, null, 'a full refund is the status pill\'s job, not this');
    is(ctx.mapOrderRow(raw({ refund_status: 'pending', refund_amount_requested: 5 })).partRefund, null, 'an open request is not a partial refund');
    is(ctx.mapOrderRow(raw({})).partRefund, null, 'no refund, nothing');
    has(src, "${T('Partial refund','部分退款')}${o.partRefund>0?", 'the row draws it, worded at render time');
  }

  console.log('\n9 · where the rider collects, in words');
  {
    const { ctx } = mk();
    const sf = (over) => ctx.mapDetail(raw({ qingyun_ship_from: Object.assign({ store_code: 'TH', name_en: 'Tianhe', name_cn: '天河店', qingyun_order_id: null }, over) }));
    is(ctx.shipFromCard(ctx.mapDetail(raw({}))), '', 'not a Qingyun order: nothing');
    has(ctx.shipFromCard(sf({ needs_attention: true, push_error: 'address not pinnable' })), 'Push refused — nobody is collecting this', 'refused');
    has(ctx.shipFromCard(sf({ needs_attention: true, push_error: 'address not pinnable' })), 'address not pinnable', 'with the server\'s reason');
    const held = ctx.shipFromCard(sf({ push_held: true, push_held_since: '2026-10-01 06:20:00' }));
    has(held, 'Held — map service unavailable, retrying', 'held'); has(held, 'since H(2026-10-01 06:20:00)', 'since when');
    has(held, 'Nothing is wrong with this address', 'and that the address is fine');
    has(ctx.shipFromCard(sf({ awaiting_dispatch: true })), 'No courier called yet', 'booked and waiting on staff');
    has(ctx.shipFromCard(sf({ push_since: '2026-10-01 06:00:00' })), 'Queued for push… · ago(2026-10-01 06:00:00)', 'queued, with how long');
    const pt = ctx.shipFromCard(sf({ awaiting_point: true, guess_grade: { en: 'District only', cn: '仅到区' }, date_posture: 'tomorrow', promised_date: '2026-10-02' }));
    has(pt, 'Confirm delivery point', 'parked for a point');
    has(pt, 'We could not place this address precisely.', 'says why');
    has(pt, 'District only', 'with the grade in words');
    has(pt, 'Promised tomorrow, 2026-10-02.', 'and the deadline when it is tomorrow');
    has(pt, 'The point is placed on the desktop map.', 'and where the point is placed — no map here');
    hasnt(pt, 'qpConfirmPoint', 'no confirm control');
    const px = ctx.shipFromCard(sf({ awaiting_point: true, date_posture: 'passed', promised_date: '2026-09-30' }));
    has(px, 'Delivery date passed', 'a passed date is its own state');
    has(px, 'Nobody was sent for this order and 2026-09-30 has gone.', 'naming the day');
    const ch = ctx.shipFromCard(sf({ awaiting_choice: true, candidates: [{ idx: 0, name: '汇景新城', address: '天河区', drop_km: 3.2 }, { idx: 1, name: '汇景花园', address: '白云区', drop_km: 18 }] }));
    has(ch, 'Pick the delivery point', 'several places matched');
    has(ch, '汇景新城', 'the first candidate'); has(ch, '白云区', 'the second\'s address'); has(ch, '3.2km', 'its distance');
    has(ch, 'Distances are from the store the rider collects from.', 'and what the distance is from');
    hasnt(ch, 'APP.cmd', 'listed, not yet pickable — the pick is a later step');
    has(ctx.shipFromCard(sf({ awaiting_choice: true, candidates: [] })), 'Queued for push…', 'a choice with no readable candidates falls through to the plain wait');
    const moved = ctx.shipFromCard(ctx.mapDetail(raw({ qingyun_ship_from: { store_code: 'BY', name_en: 'Baiyun', name_cn: '白云店', qingyun_order_id: 'Q1', stale: { store_code: 'TH', name_en: 'Tianhe', name_cn: '天河店' } } })));
    has(moved, 'Ships from', 'created: where it ships from'); has(moved, 'Baiyun', 'named');
    has(moved, 'Collected here, but the order still counts against Tianhe for stock and reports.', 'moved off the order\'s store: says the order still counts there');
    has(moved, 'The old job at Tianhe is still in Qingyun — someone there could send a rider for it.', 'an old copy left behind is warned about');
    hasnt(moved, 'APP.cmd', 'no Change or Remove yet — later step');
    const same = ctx.shipFromCard(ctx.mapDetail(raw({ qingyun_ship_from: { store_code: 'TH', name_en: 'Tianhe', name_cn: '天河店', qingyun_order_id: 'Q1', stale: null } })));
    hasnt(same, 'Collected here', 'collected at its own store: no moved note');
    const z = mk({ lang: 'zh' });
    const zsf = (over) => z.ctx.shipFromCard(z.ctx.mapDetail(raw({ qingyun_ship_from: Object.assign({ store_code: 'TH', name_en: 'Tianhe', name_cn: '天河店', qingyun_order_id: null }, over) })));
    has(zsf({ needs_attention: true }), '发单被拒 — 无人接单', 'Chinese refused');
    has(zsf({ awaiting_point: true }), '确认配送点', 'Chinese point');
    has(zsf({ awaiting_point: true }), '配送点请在电脑端地图上标记。', 'Chinese composed note');
    has(zsf({ awaiting_point: true, date_posture: 'tomorrow', promised_date: 'D' }), '明天(D)送达。', 'Chinese deadline');
  }

  console.log('\n10 · the sheet draws every one of them');
  {
    for (const call of ['${payLinkBlock(o)}', '${toldCard(o)}', '${shipFromCard(o)}', '${settlePanel(o)}', '${resvCard(o)}',
      "${(!o.counter&&!o.pickup)?addrMovedNote(o):''}", '${histOpen?rfHistBody(o):\'\'}']) {
      has(src, call, 'drawn: ' + call);
    }
    has(src, 'rfHist:{open:false, id:null, busy:false, err:false, rows:null},', 'the history slot is declared in the state literal');
    const added = sliceBetween('/* ── §325 O1 — REFUND HISTORY', '/* The band under the total when it disagrees');
    hasnt(added, 'apiWrite', 'this step adds no write');
  }

  console.log('\n11 · the words are the desktop\'s');
  {
    const copied = ['Payment link', '付款链接', 'Open pay page', '打开付款页', '发给顾客,或打开页面让其扫码支付。',
      'Address changed by the customer', '顾客修改了收货地址', '发货前请核对面单与上方地址',
      'Rerouted, shop was closed', '改派 · 门店已关闭', "cuT('Pre-order', '预订')",
      '顾客是否已收到通知', '顾客未在小程序中同意接收通知', '该号码无法发送短信',
      'Refund history · 退款历史', 'No events yet · 暂无记录', "cuT('by', '操作人')", 'Lines · 退款明细', 'Reason · 原因', 'Payout · 打款', 'History · 历史',
      '结算明细', '顾客配送费', '商家对顾客的活动补贴', '平台尚未公布佣金与预计收入。', '退款前请先核对平台。',
      'Stock reservations — needs attention · 库存预留 — 需留意', 'Expires · 到期', 'Committed · 提交', 'Released · 释放',
      'Partial refund · 部分退款',
      'Push refused — nobody is collecting this', '已挂起 — 地图服务不可用,正在重试', '尚未呼叫运力', '排队发单中…',
      '确认配送点', '无法精确定位该地址，请核对后确认配送点。', '配送日期已过', '选择配送点', '距离为骑手取货门店到该地点的距离。',
      "cuT('Ships from', '取货门店')", '在此取货,但库存与报表仍算在', '的原配送单仍在青云中 — 那边有人可能会再叫一位骑手。',
      '请今天确认配送点 — 过了今晚将无法安排同城骑手。', '请今天选择配送点 — 过了今晚将无法安排同城骑手。'];
    for (const s of copied) has(DESK, s, 'live on the desktop: ' + s);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
