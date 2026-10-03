#!/usr/bin/env node
/**
 * §325 step O7 — THE ORDER WRITES THE CUSTOMER FEELS, ON THE PHONE.
 *
 *   node scripts/test_mobile_customer_writes.js
 *
 * From the desktop's order drawer (public/retail-admin/04-orders.js):
 *   1. tell the customer again (ordRenotify) — POST /orders/:id/renotify;
 *   2. edit the ship-to (openEditShipTo) — POST /orders/:id/address/apply-chinese
 *      with the recipient, the address and save_order:true;
 *   3. make the address Chinese (openAddressToChinese) — POST …/address/to-chinese
 *      for the proposal, then …/address/apply-chinese without the recipient;
 *   4. read the payment screenshot again (rerunAlipayOcr) —
 *      POST /orders/:id/alipay-ocr/rerun;
 *   5. reprint at a chosen store (reprintOrder + pickReprintStore) — GET /printer,
 *      and POST /orders/:id/print {store_id} when two or more stores have one;
 *      no receipt for an unpaid, cancelled or refunded order (orderHeadPrint).
 * Every write is under /orders, so orders:edit (lib/cap-routes.js).
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
const O7 = '/* ── §325 O7 — WRITES THE CUSTOMER FEELS';
const CODE = [
  sliceBetween('/* The printer can succeed as a request and fail as a print', O7),
  sliceBetween(O7, "reg('copyAddr',"),
  sliceFn('orderWrite', true), sliceFn('rereadOrder', true), sliceFn('orderErrorText'),
  sliceFn('toldCard'), sliceFn('sheetActions'), sliceFn('orderActs'),
  sliceBetween('const ORDER_ALSO={', '\n};\n') + '\n};',
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  sliceFn('orderBreakdown'),
  sliceFn('itemOpts'), sliceBetween('\nconst ITEM_TUPLE=', '\nfunction '), sliceFn('mapDetail'),
].join('\n');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const SHIP = { name: 'Li Wei', phone: '13800000000', province: 'Guangdong', city: 'Guangzhou', district: 'Tianhe', address: 'Tiyu W Rd 1', detail: '5F', latin: true };

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [], timers: [] };
  const CMD = {};
  const order = Object.assign({ id: 'TC7', _id: 7, raw: 'paid', viewOnly: false, shipments: [], shipTo: Object.assign({}, SHIP) }, opts.order || {});
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (k) => `<i data-ic="${k}"></i>`, money: (c, v) => c + Number(v || 0).toFixed(2),
    tdWhen: (v) => 'W(' + v + ')', _tdL: () => 'x',
    M_NOTIFY_KINDS: {}, M_NOTIFY_CHANNELS: {}, M_NOTIFY_WHY: {}, mCodeWords: String,
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    state: { orderBusy: null, orderErr: null, ask: null, askErr: null, detailId: 'TC7', liveDetail: null, detailActions: false, shipTo: null, parcelBusy: null },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    currentOrder: () => order, findOrder: () => order,
    showToast: (m) => calls.toasts.push(String(m)), loadOrdersPage: () => {}, refreshOrders: () => {},
    shopNoteReady: () => false, shopNoteShown: () => false, orderHasWaybill: () => false,
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return 1; },
    api: (p) => {
      calls.reads.push(p);
      if (p === '/printer') return opts.printers === 'fail' ? Promise.reject(new Error('HTTP 500')) : Promise.resolve({ stores: opts.printers || [] });
      return Promise.resolve({ id: 7, order_no: 'TC7', status: 'paid', items: [] });
    },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p, calls.writes.length) : null;
      if (r instanceof Error) return Promise.reject(r);
      if (r && r.then) return r;
      return Promise.resolve(r || { success: true });
    },
    mapOrderRow: (r) => ({ id: r.order_no, _id: r.id }), shipByPlan: () => null, shipByUrgency: () => ({ level: 'none' }),
    orderWaitingOn: () => null, chanMoneyOf: () => null,
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls, order };
}
const fault = (code, message) => Object.assign(new Error(message || code), { code });
const DIDNT = 'That did not go through. Nothing has changed — try again.';

async function main() {
  console.log('\n0 · the server gate');
  {
    const A = '/api/retail-admin/orders/7';
    for (const p of ['/renotify', '/address/to-chinese', '/address/apply-chinese', '/alipay-ocr/rerun', '/print']) {
      is(requiredCapFor('POST', A + p), 'orders:edit', 'POST ' + p + ' is orders:edit');
    }
    is(requiredCapFor('GET', '/api/retail-admin/printer'), null, 'GET /printer is a read, open to anyone signed in (the desktop reads it the same way)');
  }

  console.log('\n1 · tell the customer again');
  {
    const told = (rows) => Object.assign({ _id: 7, viewOnly: false, told: rows });
    const failed = [{ kind: 'order_dispatched', channel: 'wechat', ok: false, error: 'no_consent', at: 't' }, { kind: 'order_paid', channel: 'sms', ok: true, at: 't' }];
    const m = mk();
    const h = m.ctx.toldCard(told(failed));
    has(h, 'Try telling them again', 'a message that did not arrive offers the desktop\'s button');
    has(h, "APP.cmd('renotify')", 'wired to renotify');
    hasnt(m.ctx.toldCard(told([failed[1]])), 'renotify', 'everything arrived: nothing to retry');
    hasnt(mk({ caps: ['orders:view'] }).ctx.toldCard(told(failed)), 'renotify', 'a reader sees the failure and no button (capability-denied)');
    hasnt(m.ctx.toldCard(Object.assign(told(failed), { viewOnly: true })), 'renotify', 'not on a mirrored channel\'s order');
    m.ctx.state.orderBusy = 'renotify';
    const busy = m.ctx.toldCard(told(failed));
    has(busy, 'Sending…', 'says it is sending'); has(busy, 'disabled', 'and cannot be pressed twice');
    m.ctx.state.orderBusy = null;

    const w = mk();
    await w.CMD.renotify(); await tick();
    is(w.calls.writes, [{ p: '/orders/7/renotify', method: 'POST', body: {} }], 'POST /orders/:id/renotify');
    is(w.calls.toasts, ['Trying again — the result appears below in a moment.'], 'says it is trying, not that it arrived');
    is(w.calls.timers.map((t) => t.ms), [2500], 'and reads the order again a moment later, as the desktop does');
    w.calls.timers[0].f(); await tick();
    is(w.calls.reads, ['/orders/7'], '…the re-read');
    const closed = mk(); await closed.CMD.renotify(); await tick();
    closed.ctx.state.detailId = null; closed.calls.timers[0].f(); await tick();
    is(closed.calls.reads, [], 'no re-read once the order is closed');

    const r = mk({ respond: () => REFUSAL() }); await r.CMD.renotify(); await tick();
    is(String(r.ctx.state.orderErr), 'Your role does not include this action.', 'a refusal says why');
    const f = mk({ respond: () => fault('renotify_failed') }); await f.CMD.renotify(); await tick();
    is(String(f.ctx.state.orderErr), DIDNT, 'a failure says nothing changed'); is(f.calls.toasts, [], 'and is not toasted as done');
    const d = mk({ caps: ['orders:view'] }); await d.CMD.renotify(); await tick();
    is(d.calls.writes, [], 'without orders:edit the command sends nothing');
    has(mk({ lang: 'zh' }).ctx.toldCard(told(failed)), '重新通知顾客', 'Chinese');
  }

  console.log('\n2 · edit the ship-to');
  {
    const md = mk().ctx.mapDetail;
    const base = { id: 7, order_no: 'TC7', status: 'paid', items: [], recipient_name: 'Li Wei', recipient_phone: '138', address_full: 'Guangdong Guangzhou Tianhe Tiyu W Rd 1' };
    is(JSON.parse(JSON.stringify(md(Object.assign({}, base, { address: { province: '广东省', city: '广州市', district: '天河区', address: '体育西路1号', detail: '5楼' }, address_full: '广东省 广州市 天河区 体育西路1号 5楼' })).shipTo)),
      { name: 'Li Wei', phone: '138', province: '广东省', city: '广州市', district: '天河区', address: '体育西路1号', detail: '5楼', latin: false },
      'prefilled from the parsed address; an all-Chinese line offers no Make Chinese');
    is(JSON.parse(JSON.stringify(md(base).shipTo)),
      { name: 'Li Wei', phone: '138', province: 'Guangdong', city: 'Guangzhou', district: 'Tianhe', address: 'Tiyu W Rd 1', detail: '', latin: true },
      'a legacy row with only the line is split on spaces, as the desktop splits it');
    is(md(Object.assign({}, base, { fulfillment_type: 'pickup' })).shipTo, null, 'a pickup has no ship-to');
    is(md(Object.assign({}, base, { fulfillment_type: 'counter' })).shipTo, null, 'nor does a counter sale');
    is(md(Object.assign({}, base, { address: { pickup: true } })).shipTo, null, 'nor an address marked pickup');

    const m = mk();
    const b = m.ctx.shipToBtns(m.order);
    has(b, "APP.cmd('shipToOpen','edit')", 'Edit ship-to is offered'); has(b, "APP.cmd('shipToOpen','cn')", 'and, with Latin letters in the line, Make address Chinese');
    hasnt(m.ctx.shipToBtns(Object.assign({}, m.order, { shipTo: Object.assign({}, SHIP, { latin: false }) })), "'cn'", 'no Make Chinese for a Chinese line');
    is(mk({ caps: ['orders:view'] }).ctx.shipToBtns(m.order), '', 'a reader gets neither (capability-denied)');
    is(m.ctx.shipToBtns(Object.assign({}, m.order, { viewOnly: true })), '', 'nor a mirrored order');
    is(m.ctx.shipToBtns(Object.assign({}, m.order, { shipTo: null })), '', 'nor a pickup');

    m.CMD.shipToOpen('edit');
    const s = m.ctx.sheetShipTo();
    has(s, 'Edit ship-to', 'the sheet'); has(s, 'This changes the address on this order only.', 'says what it changes');
    has(s, 'value="Li Wei"', 'the recipient prefilled'); has(s, 'value="Tiyu W Rd 1"', 'and the street');
    has(s, 'Also update the customer’s saved address', 'the customer box'); has(s, 'aria-checked="false"', 'unticked, as on the desktop');
    is(m.calls.writes, [], 'opening sends nothing');
    m.CMD.shipToSet('name', '  '); m.CMD.shipToSave(); await tick();
    is(String(m.ctx.state.shipTo.err), 'Recipient name is required', 'a blank recipient is refused before sending');
    m.CMD.shipToSet('name', 'Li Wei'); m.CMD.shipToSet('address', ''); m.CMD.shipToSave(); await tick();
    is(String(m.ctx.state.shipTo.err), 'Street / building is required', 'and so is a blank street');
    is(m.calls.writes, [], 'nothing sent for either');
    m.CMD.shipToSet('address', 'Tiyu W Rd 9'); m.CMD.shipToSet('phone', '139');
    m.CMD.shipToSave(); await tick();
    is(m.calls.writes, [{ p: '/orders/7/address/apply-chinese', method: 'POST', body: {
      recipient_name: 'Li Wei', recipient_phone: '139', province: 'Guangdong', city: 'Guangzhou', district: 'Tianhe',
      address: 'Tiyu W Rd 9', detail: '5F', save_order: true, save_customer: false } }], 'POST …/address/apply-chinese with what the desktop sends');
    is(m.calls.toasts, ['Address updated'], 'confirmed'); is(m.ctx.state.shipTo, null, 'the sheet closes'); is(m.calls.reads, ['/orders/7'], 'and the order is read again');

    const c = mk({ respond: () => ({ success: true, data: { saved_order: true, saved_customer: false, customer_reason: 'no_match' } }) });
    c.CMD.shipToOpen('edit'); c.CMD.shipToTog('saveCust'); c.CMD.shipToSave(); await tick();
    is(c.calls.writes[0].body.save_customer, true, 'the customer box ticked sends save_customer');
    is(c.calls.toasts, ['Order updated · couldn’t match the saved address'], 'and when the saved address could not be matched, it says so');

    for (const [err, want] of [[fault('missing_recipient_name'), 'Recipient name is required'], [fault('pickup_order'), 'Pickup order — no shipping address'],
      [REFUSAL(), 'Your role does not include this action.'], [fault('HTTP 500'), DIDNT]]) {
      const x = mk({ respond: () => err }); x.CMD.shipToOpen('edit'); x.CMD.shipToSave(); await tick();
      is([String(x.ctx.state.shipTo.err), x.ctx.state.shipTo.busy, x.calls.toasts.length], [want, false, 0], 'a failure stays on the sheet: ' + want);
    }
    const busy = mk({ respond: () => new Promise(() => {}) }); busy.CMD.shipToOpen('edit'); busy.CMD.shipToSave(); await tick();
    const bs = busy.ctx.sheetShipTo(); has(bs, 'Saving…', 'saving says so'); has(bs, ' disabled', 'and locks the sheet');
    busy.CMD.shipToSave(); is(busy.calls.writes.length, 1, 'a second tap sends nothing');
    busy.CMD.shipToClose(); is(busy.ctx.state.shipTo !== null, true, 'and the sheet cannot be dismissed mid-save');

    const d = mk({ caps: ['orders:view'] }); d.CMD.shipToOpen('edit');
    is(d.ctx.state.shipTo, null, 'without orders:edit the sheet does not open');
    d.ctx.state.shipTo = { mode: 'edit', oid: 'TC7', f: Object.assign({}, SHIP), saveOrder: true, saveCust: false };
    d.CMD.shipToSave(); await tick(); is(d.calls.writes, [], 'and Save sends nothing');
    const z = mk({ lang: 'zh' }); z.CMD.shipToOpen('edit');
    has(z.ctx.sheetShipTo(), '修改收货地址', 'Chinese title'); has(z.ctx.sheetShipTo(), '街道 / 楼栋', 'Chinese field');
  }

  console.log('\n3 · make the address Chinese');
  {
    const PROPOSAL = { success: true, data: { chinese: { province: '广东省', city: '广州市', district: '天河区', address: '体育西路1号', detail: '5楼' },
      original_full: 'Guangdong Guangzhou Tianhe Tiyu W Rd 1', geocode_configured: true, geocode_ok: true, geocode_precision: 'rooftop', geocode_matched: '广州市天河区体育西路1号' } };
    let release;
    const m = mk({ respond: (p) => (p.endsWith('/to-chinese') ? new Promise((r) => { release = () => r(PROPOSAL); }) : { success: true, data: { saved_order: true, saved_customer: true } }) });
    m.CMD.shipToOpen('cn'); await tick();
    is(m.calls.writes, [{ p: '/orders/7/address/to-chinese', method: 'POST', body: {} }], 'POST …/address/to-chinese for the proposal');
    has(m.ctx.sheetShipTo(), 'Translating address…', 'while it is read, it says so'); hasnt(m.ctx.sheetShipTo(), 'shipToSave', 'with no Save yet');
    release(); await tick();
    const s = m.ctx.sheetShipTo();
    has(s, 'Make address Chinese', 'the sheet'); has(s, 'Guangdong Guangzhou Tianhe Tiyu W Rd 1', 'what was entered');
    has(s, 'value="体育西路1号"', 'the Chinese street to check'); has(s, 'matched the building', 'what the map matched');
    has(s, 'Map reads this as: 广州市天河区体育西路1号', 'and the place it matched');
    has(s, 'Update this order (prints on the waybill)', 'the order box'); has(s, 'Also fix the customer’s saved address', 'the customer box');
    hasnt(s, 'mShipTo_name', 'no recipient fields: this flow leaves them alone');
    m.CMD.shipToSave(); await tick();
    is(m.calls.writes[1], { p: '/orders/7/address/apply-chinese', method: 'POST', body: {
      province: '广东省', city: '广州市', district: '天河区', address: '体育西路1号', detail: '5楼', save_order: true, save_customer: true } },
      'then POST …/address/apply-chinese, both ticked as on the desktop, no recipient');
    is(m.calls.toasts, ['Address updated'], 'confirmed');

    const n = mk({ respond: () => PROPOSAL }); n.CMD.shipToOpen('cn'); await tick();
    n.CMD.shipToTog('saveOrder'); n.CMD.shipToTog('saveCust'); n.CMD.shipToSave(); await tick();
    is([String(n.ctx.state.shipTo.err), n.calls.writes.length], ['Pick at least one place to save', 1], 'nothing ticked is refused before sending');

    const far = mk({ respond: () => ({ success: true, data: Object.assign({}, PROPOSAL.data, { geocode_ok: false, geocode_precision: 'coarse', geocode_reason: 'city_mismatch' }) }) });
    far.CMD.shipToOpen('cn'); await tick();
    has(far.ctx.sheetShipTo(), 'only matched the district centre — different city!', 'a weak or wrong-city match is called out');
    has(far.ctx.sheetShipTo(), 'amber-ink', 'in amber');
    const nomap = mk({ respond: () => ({ success: true, data: Object.assign({}, PROPOSAL.data, { geocode_configured: false }) }) });
    nomap.CMD.shipToOpen('cn'); await tick();
    hasnt(nomap.ctx.sheetShipTo(), 'matched', 'no map set up: no badge');

    for (const [err, want] of [[fault('ai_not_configured'), 'Translation service is off'], [fault('translate_failed'), 'Couldn’t translate the address'],
      [fault('pickup_order'), 'Pickup order — no shipping address'], [REFUSAL(), 'Your role does not include this action.']]) {
      const x = mk({ respond: () => err }); x.CMD.shipToOpen('cn'); await tick();
      const h = x.ctx.sheetShipTo();
      has(h, want, 'a proposal that could not be made says why: ' + want); has(h, "APP.cmd('shipToRetry')", 'and offers Try again');
    }
    const retry = mk({ respond: (p, k) => (k === 1 ? fault('translate_failed') : PROPOSAL) });
    retry.CMD.shipToOpen('cn'); await tick(); retry.CMD.shipToRetry(); await tick();
    is(retry.calls.writes.map((w) => w.p), ['/orders/7/address/to-chinese', '/orders/7/address/to-chinese'], 'Try again asks again');
    has(retry.ctx.sheetShipTo(), 'value="体育西路1号"', 'and the form arrives');
    const d = mk({ caps: ['orders:view'] }); d.CMD.shipToOpen('cn'); await tick();
    is([d.calls.writes, d.ctx.state.shipTo], [[], null], 'without orders:edit nothing is asked (capability-denied)');
  }

  console.log('\n4 · read the payment screenshot again');
  {
    const o = (v) => ({ _id: 7, viewOnly: false, proof: 'data:x', ocrVerdict: v });
    const m = mk();
    has(m.ctx.ocrRerunBtn(o('mismatch')), "APP.cmd('ocrRerun')", 'offered when the read did not match');
    has(m.ctx.ocrRerunBtn(o('error')), 'Try reading again', 'and when it could not complete');
    is(m.ctx.ocrRerunBtn(o('match')), '', 'not when it matched'); is(m.ctx.ocrRerunBtn(o(null)), '', 'nor when it never ran');
    is(m.ctx.ocrRerunBtn(Object.assign(o('error'), { proof: null })), '', 'nor with no screenshot');
    is(mk({ caps: ['orders:view'] }).ctx.ocrRerunBtn(o('error')), '', 'nor for a reader (capability-denied)');
    is(m.ctx.mapDetail({ id: 7, order_no: 'TC7', items: [], alipay_ocr_verdict: 'mismatch' }).ocrVerdict, 'mismatch', 'the verdict is carried from the order');
    m.ctx.state.orderBusy = 'ocr'; has(m.ctx.ocrRerunBtn(o('error')), 'Reading …', 'reading says so'); m.ctx.state.orderBusy = null;

    for (const [v, want] of [['match', 'Verified ✓'], ['mismatch', 'Read it — does not match'], ['error', 'Still could not read — try again or verify manually']]) {
      const x = mk({ respond: () => ({ success: true, data: { verdict: v, auto_paid: false } }) });
      x.CMD.ocrRerun(); await tick();
      is(x.calls.writes, [{ p: '/orders/7/alipay-ocr/rerun', method: 'POST', body: {} }], 'POST …/alipay-ocr/rerun (' + v + ')');
      is([x.calls.toasts, x.calls.reads], [[want], ['/orders/7']], 'the new verdict, in words, and the order read again');
    }
    const u = mk({ respond: () => fault('ocr_unavailable') }); u.CMD.ocrRerun(); await tick();
    is(String(u.ctx.state.orderErr), 'Re-run failed (ocr_unavailable)', 'reading switched off: the desktop\'s sentence, not "try again"');
    const r = mk({ respond: () => REFUSAL() }); r.CMD.ocrRerun(); await tick();
    is(String(r.ctx.state.orderErr), 'Your role does not include this action.', 'a refusal says why');
    const g = mk({ respond: () => fault('HTTP 500') }); g.CMD.ocrRerun(); await tick();
    is(String(g.ctx.state.orderErr), DIDNT, 'a failure says nothing changed');
    const d = mk({ caps: ['orders:view'] }); d.CMD.ocrRerun(); await tick();
    is(d.calls.writes, [], 'without orders:edit nothing is sent');
    has(mk({ lang: 'zh' }).ctx.ocrRerunBtn(o('error')), '重新识别', 'Chinese');
  }

  console.log('\n5 · reprint at a chosen store');
  {
    const P = (id, en, cn, sn) => ({ id, code: 'S' + id, name_en: en, name_cn: cn, sn });
    const one = mk({ printers: [P(1, 'Tianhe', '天河', 'SN1'), P(2, 'Yuexiu', '越秀', '')], respond: () => ({ success: true, ok: true }) });
    await one.CMD.printOrder(); await tick();
    is(one.calls.reads, ['/printer'], 'the printers are read first');
    is(one.calls.writes, [{ p: '/orders/7/print', method: 'POST', body: {} }], 'one store with a printer: no choice, the server routes it');
    is(one.calls.toasts, ['Sent to the printer'], 'confirmed');

    const two = mk({ printers: [P(1, 'Tianhe', '天河', 'SN1'), P(12, 'Yuexiu', '越秀', 'SN2'), P(3, 'Panyu', '番禺', '')], respond: () => ({ success: true, ok: true }) });
    await two.CMD.printOrder(); await tick();
    const a = two.ctx.state.ask;
    is([a.title, a.options.map((x) => [x.key, x.label])], ['Print at which store?', [['1', 'Tianhe'], ['12', 'Yuexiu']]], 'two or more: which store, the ones with a printer');
    is(two.calls.writes, [], 'nothing sent before the choice');
    two.CMD.askRun('12'); await tick();
    is(two.calls.writes, [{ p: '/orders/7/print', method: 'POST', body: { store_id: 12 } }], 'POST /orders/:id/print {store_id}');
    const zh = mk({ lang: 'zh', printers: [P(1, 'Tianhe', '天河', 'S'), P(2, 'Yuexiu', '越秀', 'S')] });
    await zh.CMD.printOrder(); await tick();
    is([zh.ctx.state.ask.title, zh.ctx.state.ask.options.map((x) => x.label)], ['在哪个门店打印？', ['天河', '越秀']], 'Chinese');

    const down = mk({ printers: 'fail', respond: () => ({ success: true, ok: true }) });
    await down.CMD.printOrder(); await tick();
    is(down.calls.writes, [{ p: '/orders/7/print', method: 'POST', body: {} }], 'the printers could not be read: printed the default way, as the desktop does');
    const none = mk({ printers: [P(1, 'Tianhe', '天河', 'S'), P(2, 'Yuexiu', '越秀', 'S')], respond: () => ({ success: true, ok: false, error: 'no_printer_for_store' }) });
    await none.CMD.printOrder(); await tick(); none.CMD.askRun('2'); await tick();
    is([String(none.ctx.state.orderErr), none.calls.toasts], ['No printer is set up for that location.', []], 'a store with no printer: the desktop\'s sentence');
    const off = mk({ respond: () => ({ success: true, ok: false, error: 'not_configured' }) });
    await off.CMD.printOrder(); await tick();
    is(String(off.ctx.state.orderErr), 'No printer is set up. Add one in Settings on desktop.', 'no printing at all: says so');
    const r = mk({ respond: () => REFUSAL() }); await r.CMD.printOrder(); await tick();
    is(String(r.ctx.state.orderErr), 'Your role does not include this action.', 'a refusal says why');

    let hold;
    const gone = mk({ printers: [P(1, 'Tianhe', '天河', 'S')] });
    gone.ctx.api = (p) => { gone.calls.reads.push(p); return new Promise((res) => { hold = () => res({ stores: [] }); }); };
    const pending = gone.CMD.printOrder(); await tick();
    is(gone.ctx.state.orderBusy, 'print', 'while the printers are read the button is busy');
    gone.ctx.state.detailId = null; hold(); await pending; await tick();
    is(gone.calls.writes, [], 'and if the order is closed meanwhile, nothing prints');

    for (const st of ['pending_payment', 'cancelled', 'refunded']) {
      const x = mk({ order: { raw: st } }); await x.CMD.printOrder(); await tick();
      is([x.calls.reads, x.calls.writes], [[], []], 'no receipt for a ' + st + ' order: nothing read, nothing sent');
      hasnt(x.ctx.sheetActions(), 'printOrder', '…and no Reprint row in its More sheet');
    }
    has(mk().ctx.sheetActions(), "APP.cmd('printOrder')", 'a paid order keeps it');
    hasnt(mk({ caps: ['orders:view'] }).ctx.sheetActions(), 'printOrder', 'a reader does not get it (capability-denied)');
    const d = mk({ caps: ['orders:view'] }); await d.CMD.printOrder(); await tick();
    is([d.calls.reads, d.calls.writes], [[], []], 'and the command sends nothing without orders:edit');
  }

  console.log('\n6 · where they sit, and that the words are the desktop\'s');
  {
    has(src, '${shipToBtns(o)}', 'the ship-to card carries the two ship-to buttons');
    has(src, '${ocrRerunBtn(o)}', 'the payment card carries Try reading again');
    has(src, "html += layer('shipto:'+state.shipTo.mode, sheetShipTo());", 'the sheet is a layer');
    has(src, 'state.rf=null; state.shipTo=null;', 'closing the order closes it');
    has(src, 'if(canEdit&&printable(o)) btns.push(', 'the footer\'s Reprint carries the receipt guard too');
    for (const [en, zh] of [['Try telling them again', '重新通知顾客'], ['Sending…', '发送中…'], ['Trying again — the result appears below in a moment.', '正在重试,稍后在下方显示结果。'],
      ['Edit ship-to', '修改收货地址'], ['Make address Chinese', '转为中文地址'], ['This changes the address on this order only.', '仅修改此订单的收货地址。'],
      ['Check the Chinese address, edit if needed, then save.', '请核对中文地址,如需可修改,然后保存。'], ['As entered', '原始地址'], ['Chinese address', '中文地址'],
      ['Translating address…', '正在翻译地址…'], ['Translation service is off', '翻译服务未启用'], ['Couldn’t translate the address', '地址翻译失败'],
      ['Pickup order — no shipping address', '自提订单 — 无收货地址'], ['matched the building', '匹配到楼栋门牌'], ['matched the street', '匹配到道路'],
      ['only matched the district centre', '仅匹配到区域中心'], ['no map match', '地图无匹配'], ['different city!', '城市不符!'], ['Map reads this as', '地图识别为'],
      ['Update this order (prints on the waybill)', '更新此订单(用于运单打印)'], ['Also fix the customer’s saved address', '同时更新顾客保存的地址'],
      ['Also update the customer’s saved address', '同时更新顾客保存的地址'], ['Pick at least one place to save', '请至少选择一处保存'],
      ['Street / building is required', '街道 / 楼栋不能为空'], ['Recipient name is required', '收货人不能为空'], ['Address updated', '地址已更新'],
      ['couldn’t match the saved address', '未找到对应的保存地址'], ['no customer on file', '无顾客记录'], ['saved address not updated', '保存地址未更新'],
      ['Try reading again', '重新识别'], ['Reading …', '识别中 …'], ['Verified ✓', '核对通过 ✓'], ['Read it — does not match', '已识别 · 不一致'],
      ['Still could not read — try again or verify manually', '仍无法识别 · 请重试或人工核对']]) {
      has(DESK, `cuT('${en}', '${zh}')`, 'the desktop\'s own pair: ' + en);
    }
    for (const [en, zh] of [['Province', '省 / 市'], ['City', '市'], ['District', '区 / 县'], ['Street / building', '街道 / 楼栋'], ['Unit / floor (optional)', '单元 / 楼层(可选)'],
      ['Recipient name', '收货人'], ['Phone', '电话']]) {
      has(DESK, `'${en}', '${zh}'`, 'the desktop\'s field label: ' + en);
    }
    has(DESK, 'Print at which store? · 在哪个门店打印？', 'the desktop\'s picker title');
    has(CORE, "no_printer_for_store:   ['No printer is set up for that location.', '该门店未配置打印机。']", 'and its sentence for a store with no printer');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
