#!/usr/bin/env node
/**
 * §325 step O10 — DESK WORK ON THE PHONE.
 *
 *   node scripts/test_mobile_desk_work.js
 *
 * From the desktop Orders screen (public/retail-admin/04-orders.js):
 *   1. select orders and move them a step (ordRenderBulkBar / ordBulkStatus):
 *      one PATCH /orders/:id/status per order — plus the early-dispatch warning
 *      the desktop's bulk path lacks (parity doc §14);
 *   2. bulk attach tracking (submitBulkTracking): POST /orders/bulk-tracking,
 *      offered only while delivery.bulkTracking is on;
 *   3. order drafts (ordShowDrafts … ordNewSaveDraft): GET/POST/PATCH/DELETE
 *      /order-drafts, the desktop's payload both ways;
 *   4. the by-phone customer warning (ordNewPhoneBlur): GET /customers/by-phone;
 * and the phone's setup guide opening O9's delivery wizard.
 * Every write is orders:edit (lib/cap-routes.js).
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
const DESK_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
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
const NO0 = src.indexOf('   New order — one taken on the phone (audit N-02)');
const NO1 = src.indexOf('   Purchasing — the goods ledger (desktop: 16-purchasing.js)');
const NEWORDER = src.slice(src.lastIndexOf('/* ===', NO0), src.lastIndexOf('/* ===', NO1));
const CODE = [
  sliceBetween('/* ── §325 O10 — DESK WORK ON THE PHONE', "/* ── §325 O2 — SAVED VIEWS"),
  NEWORDER,
  sliceFn('orderErrorText'),
  // §325 X11 — the setup row and its chooser, which now carries O10's wizard.
  sliceBetween('const SU_KEYS=', 'function screenSetup(){'),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  // const-declared gates are not properties of the sandbox; hand them over.
  'globalThis.__x={btrkOn,draftsOn};',
].join('\n');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const fault = (code) => Object.assign(new Error(code), { code });
const ROW = (no, id, raw, extra) => Object.assign({ id: no, _id: id, raw, viewOnly: false, earlyShip: null }, extra || {});

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [], pushes: [], loads: 0 };
  const CMD = {};
  const rows = opts.rows || [ROW('TC1', 1, 'paid'), ROW('TC2', 2, 'preparing'), ROW('TC3', 3, 'dispatched'), ROW('MT4', 4, 'paid', { viewOnly: true })];
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`, money: (c, n) => c + Number(n || 0).toFixed(2),
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    canRoute: (k) => (opts.routes ? opts.routes.includes(k) : true),
    cfgGet: (k, d) => (k === 'delivery.bulkTracking' ? opts.bulkTracking !== false : d),
    dlvCanWrite: () => opts.dlvWrite !== false, dlvUnconfigured: () => opts.unconfigured !== false,
    PAY_METHODS: [['cash', 'Cash', '现金'], ['bank_transfer', 'Bank transfer', '银行转账'], ['wechat_offline', 'WeChat (off app)', '微信（线下）'],
      ['alipay_offline', 'Alipay (off app)', '支付宝（线下）'], ['other', 'Other', '其他']],
    mCanKnown: (k) => (opts.caps ? [].concat(k).some((x) => opts.caps.includes(x)) : true), peCanCreate: () => false,
    SETUP_LABEL: { fulfillment: ['Set up delivery or pickup', '设置配送或自提'], store: ['Your store', '门店信息'] }, setupDetail: () => '',
    courierAgo: (v) => 'ago(' + v + ')',
    state: { ordSel: null, ordBulkBusy: false, btrk: null, drafts: null, draftCount: null, ask: null, askErr: null, stores: [], carriers: opts.carriers || null, onw: null, stack: [] },
    ordersFiltered: () => rows,
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => { calls.loads++; },
    push: (r) => calls.pushes.push(r), forgetPushed: () => {}, markOrdersSeen: () => {}, navTabs: () => [],
    ensureCarriers: async () => [{ code: 'jd', name_en: 'JD', name_cn: '京东' }, { code: 'sf', name_en: 'SF', name_cn: '顺丰' }],
    api: (p) => { calls.reads.push(p); const r = opts.read ? opts.read(p) : {}; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    apiRaw: (p) => { calls.reads.push(p); const r = opts.read ? opts.read(p) : {}; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p, calls.writes.length) : null;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { success: true });
    },
    document: { getElementById: () => null, activeElement: null },
    setTimeout, clearTimeout,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseInt, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  ctx.globalThis = ctx;
  ctx.APP = { cmd: (n, ...a) => { calls.cmds = (calls.cmds || []).concat(n); if (CMD[n]) CMD[n](...a); } };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  ctx.state.onw = ctx.onwBlank([]);
  return { ctx, CMD, calls, rows };
}

async function main() {
  console.log('\n0 · the server gate');
  {
    const A = '/api/retail-admin';
    is([requiredCapFor('PATCH', A + '/orders/7/status'), requiredCapFor('POST', A + '/orders/bulk-tracking')], ['orders:edit', 'orders:edit'], 'status and bulk tracking: orders:edit');
    is([requiredCapFor('POST', A + '/order-drafts'), requiredCapFor('PATCH', A + '/order-drafts/3'), requiredCapFor('DELETE', A + '/order-drafts/3')],
      ['orders:edit', 'orders:edit', 'orders:edit'], 'drafts: orders:edit');
    is([requiredCapFor('GET', A + '/order-drafts'), requiredCapFor('GET', A + '/customers/by-phone')], [null, null], 'the reads are open');
  }

  console.log('\n1 · select and move');
  {
    has(src, "${mCan('orders:edit')&&!state.ordSel?`<button onclick=\"APP.cmd('ordSelOn')\"", 'the list offers Select for orders:edit');
    has(src, "${sel?(selectable?`role=\"checkbox\" aria-checked=\"${picked?'true':'false'}\" onclick=\"APP.cmd('ordSelT','${o.id}')\"`:'disabled'):`onclick=\"APP.cmd('openOrder','${o.id}')\"`}",
      'in select mode a row ticks instead of opening, and a mirrored order cannot be ticked');
    has(src, '${ordBulkBar()}', 'the bar sits over the list');
    const m = mk();
    m.CMD.ordSelOn(); is(m.ctx.state.ordSel, { ids: [] }, 'select mode on');
    m.CMD.ordSelT('TC1'); m.CMD.ordSelT('TC2'); m.CMD.ordSelT('MT4');
    is(m.ctx.state.ordSel.ids, ['TC1', 'TC2'], 'a mirrored order is not selectable');
    let bar = m.ctx.ordBulkBar();
    has(bar, '2 selected', 'the count'); has(bar, 'Select all 3', 'select the page (selectable rows only)');
    has(bar, "APP.cmd('ordBulk','preparing')", 'Start preparing'); has(bar, "APP.cmd('ordBulk','dispatched')", 'Mark dispatched');
    has(bar, 'Start preparing <span class="num" style="color:var(--text-secondary)">1</span>', 'a step that moves only some counts them');
    has(bar, `disabled onclick="APP.cmd('ordBulk','delivered')"`, 'a step that moves none is greyed');
    m.CMD.ordSelAll(true); is(m.ctx.state.ordSel.ids.length, 3, 'select all'); has(m.ctx.ordBulkBar(), 'Clear page', 'then Clear page');
    m.CMD.ordSelAll(false); is(m.ctx.state.ordSel.ids, [], 'clear page');
    m.CMD.ordSelT('TC1'); m.CMD.ordSelT('TC3');
    m.CMD.ordBulk('dispatched');
    is([m.ctx.state.ask.title, m.ctx.state.ask.confirmLabel], ['Mark dispatched — 1 order?', 'Mark dispatched'], 'asks with the number that can move');
    has(m.ctx.state.ask.body, '1 of the 2 you selected is not at a step this can move from, and will be left alone.', 'and names the one that cannot');
    is(m.calls.writes, [], 'nothing before the answer');
    m.CMD.askRun(''); await tick();
    is(m.calls.writes, [{ p: '/orders/1/status', method: 'PATCH', body: { status: 'dispatched' } }], 'one PATCH …/status per order that can move');
    is([m.calls.toasts, m.ctx.state.ordSel, m.calls.loads], [['Moved 1 ✓'], null, 1], 'done, selection cleared, list read again');

    const e = mk({ rows: [ROW('TC1', 1, 'paid', { earlyShip: { kind: 'fresh', day: '2026-10-09', arrives: null } }),
      ROW('TC2', 2, 'preparing', { earlyShip: { kind: 'late', day: '2026-10-12', days: 5, label: 'Oct 12 10:00–12:00' } }), ROW('TC3', 3, 'paid')] });
    e.CMD.ordSelOn(); e.CMD.ordSelAll(true); e.CMD.ordBulk('dispatched');
    has(e.ctx.state.ask.body, 'TC1 · Made fresh later · 2026-10-09', 'an order made fresh later is named (the single sheet\'s words)');
    has(e.ctx.state.ask.body, 'TC2 · Delivery requested later · Oct 12 10:00–12:00', 'a delivery requested later is named');
    hasnt(e.ctx.state.ask.body, 'TC3', 'one that is not early is not');
    is(e.ctx.state.ask.confirmLabel, 'Mark dispatched anyway', 'and the button says what it overrides');
    e.CMD.ordSelOn(); e.CMD.ordSelAll(true); e.CMD.ordBulk('preparing');
    is(e.ctx.state.ask.confirmLabel, 'Start preparing', 'the warning is only for dispatching');

    const f = mk({ respond: (p) => (p === '/orders/2/status' ? fault('invalid_transition') : null) });
    f.CMD.ordSelOn(); f.CMD.ordSelAll(true); f.CMD.ordBulk('dispatched'); f.CMD.askRun(''); await tick();
    is(f.calls.writes.map((w) => w.p), ['/orders/1/status', '/orders/2/status'], 'each order is tried');
    is(f.ctx.state.ask.title, '1 moved, 1 could not', 'a failure is reported with both numbers');
    has(f.ctx.state.ask.body, 'TC2 — This order has already moved on.', 'naming the order and why');
    is(f.calls.toasts, [], 'not toasted as done');
    const r = mk({ respond: () => REFUSAL() }); r.CMD.ordSelOn(); r.CMD.ordSelT('TC1'); r.CMD.ordBulk('preparing'); r.CMD.askRun(''); await tick();
    has(r.ctx.state.ask.body, 'TC1 — Your role does not include this action.', 'a refusal says why');
    const d = mk({ caps: ['orders:view'] });
    d.CMD.ordSelOn(); is(d.ctx.state.ordSel, null, 'without orders:edit there is no select mode');
    d.ctx.state.ordSel = { ids: ['TC1'] }; d.CMD.ordBulk('preparing'); is([d.ctx.state.ask, d.calls.writes], [null, []], 'and no move');
    const z = mk({ lang: 'zh' }); z.CMD.ordSelOn(); z.CMD.ordSelT('TC1');
    has(z.ctx.ordBulkBar(), '已选 1 单', 'Chinese'); has(z.ctx.ordBulkBar(), '开始备货', '…the steps too');
  }

  console.log('\n2 · bulk attach tracking');
  {
    has(src, "${btrkOn()?`<button onclick=\"APP.cmd('btrkOpen')\"", 'the list offers it');
    is([mk().ctx.__x.btrkOn(), mk({ bulkTracking: false }).ctx.__x.btrkOn(), mk({ caps: ['orders:view'] }).ctx.__x.btrkOn()], [true, false, false],
      'only while the Delivery switch is on, and only for orders:edit');
    const m = mk({ respond: () => ({ success: true, results: [{ order_no: 'R1', ok: true, auto_dispatched: true }, { order_no: 'R2', ok: false, error: 'order_not_found' }] }) });
    m.CMD.btrkOpen(); await tick();
    has(m.ctx.sheetBulkTracking(), '<option value="jd" selected>JD · 京东</option>', 'JD first, as the desktop selects it');
    is(m.ctx.btrkParse('R1, JD001\n\n R2\tSF22 sf \nbad\nR3;EMS9 EMS', 'jd'),
      [{ order_no: 'R1', tracking_number: 'JD001', carrier: 'jd' }, { order_no: 'R2', tracking_number: 'SF22', carrier: 'sf' }, { order_no: 'R3', tracking_number: 'EMS9', carrier: 'ems' }],
      'parsed the desktop\'s way: comma, tab, space or semicolon; a third value overrides; a one-value line is skipped');
    m.CMD.btrkGo(); await tick();
    is([String(m.ctx.state.btrk.err), m.calls.writes], ['Nothing to process — check the format', []], 'nothing pasted: refused before sending');
    m.CMD.btrkCarrier('sf'); m.CMD.btrkText('R1 X1\nR2 X2 jd');
    is(m.ctx.btrkCount(), '2 entries', 'counts the lines');
    m.CMD.btrkGo(); await tick();
    is(m.calls.writes, [{ p: '/orders/bulk-tracking', method: 'POST', body: { entries: [{ order_no: 'R1', tracking_number: 'X1', carrier: 'sf' }, { order_no: 'R2', tracking_number: 'X2', carrier: 'jd' }] } }],
      'POST /orders/bulk-tracking {entries}');
    const h = m.ctx.sheetBulkTracking();
    has(h, '<b>1</b> saved', 'how many saved'); has(h, '<b>1</b> failed', 'failed'); has(h, '<b>1</b> auto-marked dispatched', 'auto-dispatched');
    has(h, '✗ order_not_found', 'each failure with the server\'s reason, as the desktop shows it');
    is([m.calls.toasts, m.calls.loads], [['Bulk: 1/2 saved'], 1], 'toasted, list read again');
    const r = mk({ respond: () => REFUSAL() }); r.CMD.btrkOpen(); await tick(); r.CMD.btrkText('R1 X1'); r.CMD.btrkGo(); await tick();
    is(String(r.ctx.state.btrk.err), 'Your role does not include this action.', 'a refusal says why');
    const f = mk({ respond: () => fault('too_many') }); f.CMD.btrkOpen(); await tick(); f.CMD.btrkText('R1 X1'); f.CMD.btrkGo(); await tick();
    is(String(f.ctx.state.btrk.err), 'Request failed: too_many', 'a failure says so');
    const d = mk({ bulkTracking: false }); d.CMD.btrkOpen(); is(d.ctx.state.btrk, null, 'switched off: it does not open');
    d.ctx.state.btrk = { text: 'R1 X1', carrier: 'jd' }; d.CMD.btrkGo(); await tick(); is(d.calls.writes, [], 'and sends nothing');
    const zb = mk({ lang: 'zh' }); zb.CMD.btrkOpen(); await tick();
    has(zb.ctx.sheetBulkTracking(), '批量绑定运单号', 'Chinese'); has(zb.ctx.sheetBulkTracking(), '处理条目', '…and its button');
  }

  console.log('\n3 · drafts');
  {
    has(src, "${draftsOn()?`<button onclick=\"APP.cmd('draftsOpen')\"", 'the list offers Drafts');
    is([mk().ctx.__x.draftsOn(), mk({ caps: ['orders:view'] }).ctx.__x.draftsOn(), mk({ routes: [] }).ctx.__x.draftsOn()], [true, false, false], 'for orders:edit with New order');
    const LIST = { success: true, total: 2, data: [
      { id: 5, updated_at: 'u5', preview: { kind: 'products', label: 'Oolong', label_cn: '乌龙', extra: 2, total: 88 } },
      { id: 6, updated_at: 'u6', preview: { kind: 'empty' } }] };
    const DRAFT = { id: 5, payload: { form: { customer_id: null, recipient_name: 'Li', recipient_phone: '138', items: [{ product_id: 9, qty: 2, unit_price: 30 }],
      shipping_fee: 10, packing_fee: 2, status: 'paid', payment_method: 'offline', channel: 'other', channel_note: 'phone', fulfillment_type: 'delivery',
      customer_note: 'ring', staff_note: null, store_id: 3, total_override: 50, save_customer: true,
      address: { province: '广东省', city: '广州市', district: '天河区', address: '体育西路1号', detail: '', postal_code: '' } },
      lines: [{ product_id: 9, name_en: 'Oolong', name_cn: '乌龙', sku: 'S9', qty: 2, unit_price: 30 }], cust: 'guest', customer: null, saveCust: true } };
    let release; const slow = mk({ read: () => new Promise(() => {}) }); slow.ctx.apiRaw = (p) => { slow.calls.reads.push(p); return new Promise((r) => { release = () => r(LIST); }); };
    slow.CMD.draftsOpen(); await tick(); has(slow.ctx.sheetDrafts(), 'Loading…', 'loading says so'); release(); await tick();
    const m = mk({ read: (p) => (p === '/order-drafts' ? LIST : DRAFT) });
    m.CMD.draftsOpen(); await tick();
    is(m.calls.reads, ['/order-drafts'], 'GET /order-drafts');
    let h = m.ctx.sheetDrafts();
    has(h, 'Oolong +2 more', 'labelled the desktop\'s way'); has(h, 'Empty draft', 'an empty one says so'); has(h, '¥88.00', 'with its total');
    has(h, 'Saved ago(u5)', 'and when'); is(m.ctx.state.draftCount, 2, 'the count comes from the server\'s total');
    m.CMD.draftOpen(5); await tick();
    is(m.calls.reads[1], '/order-drafts/5', 'opening reads the draft');
    is(m.calls.pushes, ['neworder'], 'and goes to New order');
    const o = m.ctx.state.onw;
    is([o.draftId, o.name, o.phone, o.ful, o.storeId, o.channel, o.channelNote, o.city, o.district, o.street, o.ship, o.pack, o.paid, o.pay, o.note, o.override, o.saveCust, o.lines],
      [5, 'Li', '138', 'delivery', 3, 'other', 'phone', '广州市', '天河区', '体育西路1号', 10, 2, true, 'cash', 'ring', 50, true,
        [{ id: 9, en: 'Oolong', cn: '乌龙', sku: 'S9', price: 30, qty: 2 }]],
      'every field restored; the desktop\'s Cash ("offline") is the phone\'s cash; the override kept');
    has(m.ctx.onwFootHtml(), 'Grand-total override', 'the override is shown, not carried silently');
    is(m.ctx.onwTotal(), 50, 'and is the total'); is(m.ctx.onwBody().total_override, 50, 'and is sent');
    m.CMD.onwOverrideOff(); is([m.ctx.state.onw.override, m.ctx.onwTotal()], [null, 72], 'removing it puts the total back to the lines (60 + 10 + 2)');
    m.CMD.onwSaveDraft(); await tick();
    const w = m.calls.writes[0];
    is([w.p, w.method], ['/order-drafts/5', 'PATCH'], 'saving an opened draft updates it: PATCH /order-drafts/:id');
    is(w.body.payload.form, m.ctx.onwBody(), 'the payload\'s form is the order body');
    is(w.body.payload.lines, [{ product_id: 9, name_en: 'Oolong', name_cn: '乌龙', sku: 'S9', qty: 2, unit_price: 30 }], 'its lines carry the names, the desktop\'s shape');
    is([w.body.payload.cust, w.body.payload.customer, w.body.payload.saveCust], ['guest', null, true], 'and the customer state');
    has(m.ctx.onwFootHtml(), '>Saved<', 'Save draft says Saved');
    const n = mk({ respond: () => ({ success: true, data: { id: 41 } }) });
    n.ctx.state.onw.name = 'Wang'; n.CMD.onwSaveDraft(); await tick();
    is([n.calls.writes[0].p, n.calls.writes[0].method, n.ctx.state.onw.draftId], ['/order-drafts', 'POST', 41], 'a new draft: POST /order-drafts, and it remembers the id');
    n.CMD.onwSaveDraft(); await tick(); is([n.calls.writes[1].p, n.calls.writes[1].method], ['/order-drafts/41', 'PATCH'], 'the second save updates the same one');
    const fl = mk({ respond: () => fault('bad_payload') }); fl.CMD.onwSaveDraft(); await tick();
    is(String(fl.ctx.state.onw.err.msg), 'The draft did not save.', 'a failed save says so');

    const c = mk({ respond: (p) => (p === '/orders' ? { success: true, data: { id: 70, order_no: 'TC70' } } : { success: true }) });
    c.ctx.onwOpenCreated = () => {};
    Object.assign(c.ctx.state.onw, { draftId: 5, name: 'Li', channel: 'phone', ful: 'pickup', lines: [{ id: 9, en: 'O', cn: 'O', price: 3, qty: 1 }] });
    c.CMD.onwCreate(); await tick();
    is(c.calls.writes.map((x) => [x.p, x.method]), [['/orders', 'POST'], ['/order-drafts/5', 'DELETE']], 'creating from a draft deletes the draft');
    const del = mk({ read: (p) => (p === '/order-drafts' ? LIST : DRAFT) });
    del.CMD.draftsOpen(); await tick(); del.CMD.draftDel(6);
    is([del.ctx.state.ask.title, del.ctx.state.ask.danger], ['Delete this draft?', true], 'Delete asks first');
    del.CMD.askRun(''); await tick();
    is(del.calls.writes, [{ p: '/order-drafts/6', method: 'DELETE', body: {} }], 'DELETE /order-drafts/:id'); is(del.calls.reads.filter((x) => x === '/order-drafts').length, 2, 'and the list is read again');
    const empty = mk({ read: () => ({ success: true, total: 0, data: [] }) }); empty.CMD.draftsOpen(); await tick();
    has(empty.ctx.sheetDrafts(), 'No drafts', 'none: says so');
    const bad1 = mk({ read: () => new Error('HTTP 500') }); bad1.CMD.draftsOpen(); await tick();
    has(bad1.ctx.sheetDrafts(), 'Drafts did not load', 'a failed read says so'); has(bad1.ctx.sheetDrafts(), "APP.cmd('draftsRetry')", 'and can be retried');
    const ro = mk({ caps: ['orders:view'] }); ro.CMD.draftsOpen(); ro.CMD.onwSaveDraft(); await tick();
    is([ro.ctx.state.drafts, ro.calls.writes], [null, []], 'without orders:edit: no drafts, no save');
    hasnt(ro.ctx.onwFootHtml(), 'onwSaveDraft', 'and no Save draft button');
    const z = mk({ lang: 'zh', read: () => LIST }); z.CMD.draftsOpen(); await tick();
    has(z.ctx.sheetDrafts(), '乌龙 +2 项', 'Chinese');
  }

  console.log('\n4 · the by-phone warning');
  {
    has(src, `onblur="APP.cmd('onwPhoneCheck')">\`)\n    + onwPhoneNoteHtml()`, 'checked when the phone box is left, said under it');
    const run = async (resp, phone) => { const m = mk({ read: () => resp }); m.ctx.state.onw.phone = phone || '138 0013 8000'; m.CMD.onwPhoneCheck(); await tick(); return m; };
    let m = await run({ match: { id: 4, nickname: 'Wang', is_blocked: 0 }, share_count: 1 });
    is(m.calls.reads, ['/customers/by-phone?phone=13800138000'], 'GET /customers/by-phone, spaces taken out');
    has(m.ctx.onwPhoneNoteHtml(), '13800138000 belongs to Wang.</b> The order will be filed under that customer record, not a new one.', 'a match');
    m = await run({ match: { id: 4, nickname: 'Wang', is_blocked: 1 }, share_count: 1 });
    has(m.ctx.onwPhoneNoteHtml(), 'belongs to Wang, whose account is blocked.</b> The order will still be filed under that record.', 'blocked is never hidden');
    has(m.ctx.onwPhoneNoteHtml(), 'brick-ink', 'in brick');
    m = await run({ match: { id: 4, nickname: 'Wang' }, share_count: 3 });
    has(m.ctx.onwPhoneNoteHtml(), 'is shared by 3 customers.</b> The order will be filed under Wang, the oldest record.', 'shared');
    m = await run({ match: null });
    is(m.ctx.onwPhoneNoteHtml(), '', 'no match: nothing');
    m = await run({}, '12ab');
    is(m.calls.reads, [], 'not a phone number: no lookup');
    m = await run(new Error('HTTP 500'));
    is(m.ctx.onwPhoneNoteHtml(), '', 'a failed lookup is silence — Create checks again');
    const l = mk({ read: () => ({ match: { id: 4, nickname: 'Wang' }, share_count: 1 }) });
    l.ctx.state.onw.cust = { id: 4 }; l.ctx.state.onw.phone = '13800138000'; l.CMD.onwPhoneCheck(); await tick();
    is([l.calls.reads, l.ctx.onwPhoneNoteHtml()], [[], ''], 'a picked customer is not warned about');
    const z = mk({ lang: 'zh', read: () => ({ match: { id: 4, nickname: 'Wang' }, share_count: 1 }) });
    z.ctx.state.onw.phone = '13800138000'; z.CMD.onwPhoneCheck(); await tick();
    has(z.ctx.onwPhoneNoteHtml(), '13800138000 属于 Wang。</b>订单将记入这位顾客的档案,不会新建。', 'Chinese');
  }

  console.log('\n5 · the setup guide opens the delivery wizard');
  {
    /* §325 X11 widened the step's button to the desktop's whole chooser; the
       wizard is its first option, offered on exactly O10's conditions. */
    const offers = (m) => { m.CMD.suFulfil(); return ((m.ctx.state.ask && m.ctx.state.ask.options) || []).map((o) => o.key); };
    has(mk().ctx.setupRow({ key: 'fulfillment', done: false }, 0, true), "APP.cmd('suFulfil')", 'the handover step offers its chooser');
    const d = mk(); is(offers(d), ['delivery', 'pickup'], '…whose first choice is Set up delivery');
    d.CMD.askRun('delivery');
    is((d.calls.cmds || []).includes('dwizOpen'), true, 'which opens the delivery wizard');
    hasnt(mk().ctx.setupRow({ key: 'fulfillment', done: true }, 0, false), 'suFulfil', 'not once it is done');
    is(offers(mk({ unconfigured: false })), ['pickup'], 'no wizard once delivery is set up');
    is(offers(mk({ dlvWrite: false })), ['pickup'], 'nor without the Delivery panel\'s key');
    hasnt(mk().ctx.setupRow({ key: 'store', done: false }, 0, true), 'dwizOpen', 'and only on that step');
    has(src, "if(state.setup) api('/setup').then(", 'finishing the wizard reads the guide again');
  }

  console.log('\n6 · the words are the desktop\'s');
  {
    const N = (s) => s.replace(/\s*\n\s*/g, ' ').replace(/cuT\( /g, 'cuT(');
    const JS = N(DESK), HTML = N(DESK_HTML);
    for (const [en, zh] of [['Start preparing', '开始备货'], ['Mark dispatched', '标记发货'], ['Mark delivered', '标记送达'], ['Clear page', '清空本页'], ['Clear', '清除'],
      ['Drafts did not load', '草稿未能加载'], ['The list could not be read just now. Try again in a moment.', '暂时无法读取列表,请稍后再试。'],
      ['Empty draft', '空草稿'], ['No drafts', '没有草稿'], ['Drafts are yours alone. A half-typed order waits here until you come back for it.', '草稿仅你可见。未填完的订单会留在这里,等你回来继续。'],
      ['Saved', '保存于'], ['Delete draft', '删除草稿'], ['Save draft', '存为草稿'], ['The draft did not save.', '草稿未能保存。'], ['Failed', '失败']]) {
      has(JS, `cuT('${en}', '${zh}')`, 'the desktop\'s own pair: ' + en);
    }
    for (const s of ["titleEn: 'Made fresh later', titleCn: '稍后制作'", "titleEn: 'Delivery requested later', titleCn: '要求稍后送达'",
      "confirmEn: 'Mark dispatched anyway', confirmCn: '仍要标记已发货'", "titleEn: 'Delete this draft?', titleCn: '删除这份草稿？'", "bodyEn: 'It has not been placed as an order, and this cannot be undone.'",
      "'Nothing to process — check the format · 无可处理的内容,请检查格式'", "confirmEn: 'OK', confirmCn: '好'"]) has(JS, s, 'the desktop\'s own words: ' + s.slice(0, 40));
    for (const s of ['Bulk attach tracking · 批量绑定运单号', 'Paste one waybill per line. Auto-flips paid/preparing orders to dispatched. · 每行粘贴一个运单号,会自动将已付款/备货中订单切换为已发货。',
      'Default carrier · 默认快递', 'Process entries · 处理条目', 'Grand-total override · 自定义总额']) has(HTML, s, 'the desktop\'s own pair: ' + s.slice(0, 40));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
