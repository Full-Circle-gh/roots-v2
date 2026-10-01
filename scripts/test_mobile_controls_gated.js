#!/usr/bin/env node
/**
 * §325 S1b — EVERY PHONE CONTROL IS DRAWN ONLY FOR WHO THE SERVER WILL LET PRESS IT.
 *
 *   node scripts/test_mobile_controls_gated.js
 *
 * Live defect 2 of docs/tacet-phone-parity-rest-of-app.md: the order actions
 * and refunds, the product sheet's Save and switches, the coupon switch, the
 * inbox's moderation, media upload and broadcast cancel were drawn for every
 * account. Each is now drawn for the key lib/cap-routes.js (and the handler)
 * actually requires, and each command refuses on the same key, so a sheet left
 * open cannot write past the gate.
 *
 * The code is RUN, sliced out of public/m.html into a sandbox with a fake
 * apiWrite. No browser — fast shard. The keys are read from lib/cap-routes.js
 * itself, so the phone and the server cannot drift apart silently.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const { requiredCapFor } = require(path.join(ROOT, 'lib/cap-routes.js'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(from, to) {
  const a = M.indexOf(from);
  const b = M.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
  return M.slice(a, b);
}
function fn(name) {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(M);
  assert.ok(m, 'no function ' + name);
  const a = m.index + 1, b = M.indexOf('\n}\n', a);
  return M.slice(a, b + 2);
}
const A = '/api/retail-admin';
const cap = (method, p) => requiredCapFor(method, A + p);

const SRC = [
  slice('const MCAN_MONEY_ONLY=', 'function canRoute('),
  slice('const ORDER_NEXT={', '/* A write helper that keeps'),
  slice('function orderErrorText(e){', '/* printer.* is private config'),
  slice("reg('advance', to=>{", 'function currentOrder(){'),
  slice('const PRINT_NO_RECEIPT=', 'function printOrderAt('),   // §325 O7: orderHeadPrint's guard
  fn('orderActionRow'), fn('sheetActions'), fn('shopNoteCard'),
  fn('trackingCard'), fn('etaPretty'), fn('localEtaCard'), fn('noContactCard'), fn('deliveryPhotoCard'), fn('mDcActs'),
  slice("reg('toggleShop', ids=>{", '/* The status buckets are derived'),
  slice('function prodCanEdit(){', '/* Needs you, from the same snapshot'),
  fn('stockCard'), fn('oosCard'), fn('sheetProduct'),
  slice("reg('openReply', who=>{", "reg('closeReply',"),
  fn('sheetReply'),
  fn('toggleCoupon'), fn('recallBroadcast'),
  slice("reg('pickMedia', ()=>{", '\n});\n') + '\n});\n',
].join('\n');

function mk(caps, opts = {}) {
  const calls = { writes: [], toasts: [], files: 0 };
  const CMD = {};
  const order = Object.assign({ id: 'R-9', _id: 9, raw: 'paid', total: '¥120.00', totalNum: 120, shipments: [] }, opts.order || {});
  const ctx = {
    LANG: 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    pill: (k, t) => `<span class="pill">${t}</span>`,
    toggle: (on, cmd) => `<button class="toggle" onclick="${cmd}"></button>`,
    noteBar: (t) => `<div>${t}</div>`, sheetVariants: () => '', pcEntryRow: () => '',
    // §325 PD2's two read-only cards on the sheet; they carry no control this
    // suite gates (test_mobile_products_records.js holds them).
    salesCard: () => '', versionsRow: () => '',
    // §325 PD5's Details row, products:edit's; test_mobile_product_details.js holds it.
    peEntryRow: () => '',
    // §325 PD7's Duplicate row, products:create's; test_mobile_product_restore_duplicate.js holds it.
    dupRow: () => '',
    money: (c, n) => c + Number(n).toFixed(2),
    state: { caps, capsLoaded: true, ask: null, askErr: null, orderBusy: null, orderErr: null, detailActions: false,
      detailId: 'R-9', liveDetail: null, ordNote: null, ordNoteOpen: null, parcelBusy: null,
      prodBusy: null, prodErr: null, productSku: null, oosSku: null, prodStockReady: true, prodStock: {},
      reply: null, thread: null, replyBusy: false, replyErr: null, revBusy: null, revErr: null, reviewsSeen: new Set(),
      couponBusy: null, couponErr: null, sw: {}, bcBusy: null, bcErr: null, mediaBusy: null },
    DB: { products: opts.products || [], reviews: opts.reviews || [], feedback: opts.feedback || [],
      coupons: opts.coupons || [], broadcasts: opts.broadcasts || [] },
    sheetPrice: {}, sheetStep: {},
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    currentOrder: () => order, findOrder: () => order,
    shopNoteReady: () => !!opts.noteReady, shopNoteShown: () => !!opts.noteShown,
    showToast: (m) => calls.toasts.push(String(m)), refreshOrders: () => {},
    reKindProduct: () => {}, cfgGet: () => 5, loadCatalogue: async () => {}, loadProductStock: () => {},
    prodFamily: () => [], prodStoreRows: (pid) => (opts.stores || {})[pid] || [], stockKey: (p, s) => 'st_' + p + '_' + s,
    revKey: (r) => (r.stream === 'feedback' ? 'fb:' : 'rv:') + r.id, markInboxSeen: () => {}, loadInbox: () => {}, loadOps: () => {},
    threadBody: () => '<div>thread</div>', recapNoMoney: () => false, fmtDay: (s) => s, evTime: (s) => s,
    delayCaseCard: () => '', DELIV_TONE: {}, TRK_STATE_TONE: {},
    api: async () => ({ messages: [] }),
    apiWrite: (p, body, method) => { calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST' }); return Promise.resolve({ success: true, data: {} }); },
    document: { getElementById: () => null, createElement: () => { calls.files++; return { click() {} }; } },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, setImmediate,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, order };
}
const tick = () => new Promise((r) => setImmediate(r));
const plain = (x) => JSON.parse(JSON.stringify(x));   // arrays built inside the sandbox are another realm's
const cmds = (html) => [...String(html).matchAll(/APP\.cmd\('([\w$]+)'/g)].map((m) => m[1]);
const ALL_ORDER = ['orders:view', 'orders:edit', 'orders:refund'];

/* ─────────────────────────────────────────────────────────────────────── */
section('0 · the keys are the server\'s');
{
  it('status, cancel, pay, undo, print, note, tracking, parcels, delay case: orders:edit', () => {
    for (const [m, p] of [['PATCH', '/orders/9/status'], ['POST', '/orders/9/undo-dispatch'], ['POST', '/orders/9/undo-preparing'],
      ['POST', '/orders/9/print'], ['PATCH', '/orders/9/note'], ['PUT', '/orders/9/tracking'], ['PUT', '/orders/9/eta'],
      ['POST', '/orders/9/shipments/3/dispatch'], ['POST', '/orders/9/shipments/combine'], ['POST', '/orders/9/delay-case/step'],
      ['POST', '/orders/9/delivery-photo'], ['POST', '/orders/9/no-contact/ack'], ['POST', '/orders/9/air-delay/ack']]) {
      assert.strictEqual(cap(m, p), 'orders:edit', m + ' ' + p);
    }
  });
  it('every refund path: orders:refund; a full refund by status also needs it in the handler', () => {
    for (const p of ['/orders/9/refund/approve', '/orders/9/refund/reject', '/orders/9/refund/payout', '/orders/9/refund/direct']) {
      assert.strictEqual(cap('POST', p), 'orders:refund', p);
    }
    assert.ok(/status === 'refunded' && capRoutes\.capDenied\(req, 'orders:refund'\)/.test(RETAIL));
  });
  it('products, stock, coupons, inbox, media, broadcasts', () => {
    assert.strictEqual(cap('PATCH', '/products/4'), 'products:edit');
    assert.strictEqual(cap('POST', '/products/family-publish'), 'products:edit');
    assert.deepStrictEqual(cap('PATCH', '/stores/2/stock/4'), ['quickstock:recount', 'quickstock:add', 'products:edit']);
    assert.strictEqual(cap('PATCH', '/vouchers/5'), 'coupons:edit');
    assert.strictEqual(cap('PATCH', '/reviews/5'), 'reviews:moderate');
    assert.strictEqual(cap('POST', '/feedback/5/reply'), 'feedback:moderate');
    assert.strictEqual(cap('POST', '/feedback/5/handled'), 'feedback:moderate');
    assert.strictEqual(cap('POST', '/media/upload'), 'media:upload');
    assert.strictEqual(cap('POST', '/broadcasts/5/recall'), 'broadcasts:send');
  });
}

section('1 · the order sheet');
{
  it('every key: the row and the More sheet as before', () => {
    const h = mk(ALL_ORDER, { noteReady: true });
    assert.deepStrictEqual(cmds(h.ctx.orderActionRow(h.order)), ['advance', 'printOrder', 'detailActions']);
    // §325 O6: a paid order gains §136's Hold for restock (advance → awaiting_restock), first, as on the desktop.
    assert.deepStrictEqual(cmds(h.ctx.sheetActions()), ['printOrder', 'advance', 'advance', 'refundOrder', 'cancelOrder', 'ordNoteOpen']);
    assert.ok(h.ctx.sheetActions().includes("APP.cmd('advance','awaiting_restock')"));
  });
  it('orders:view alone: no action row at all, and nothing in More', () => {
    const h = mk(['orders:view'], { noteReady: true });
    assert.strictEqual(h.ctx.orderActionRow(h.order), '');
    assert.deepStrictEqual(plain(h.ctx.orderActs(h.order)), []);
  });
  it('orders:edit without orders:refund: Cancel and forward, no Refund', () => {
    const h = mk(['orders:view', 'orders:edit']);
    assert.deepStrictEqual(cmds(h.ctx.sheetActions()), ['printOrder', 'advance', 'advance', 'cancelOrder']);
    // …and Hold for restock is orders:edit, so an account without it does not get it.
    assert.ok(!mk(['orders:view', 'orders:refund']).ctx.sheetActions().includes('awaiting_restock'));
  });
  it('orders:refund without orders:edit: Refund only (the two Parts; Full is offered with both keys)', async () => {
    const h = mk(['orders:view', 'orders:refund']);
    assert.deepStrictEqual(cmds(h.ctx.sheetActions()), ['refundOrder']);
    h.CMD.refundOrder();
    // §325 O3 added the desktop's third way, by items — /refund/direct, orders:refund alone.
    assert.deepStrictEqual(plain(h.ctx.state.ask.options.map((o) => o.key)), ['amount', 'lines']);
    const both = mk(ALL_ORDER); both.CMD.refundOrder();
    assert.deepStrictEqual(plain(both.ctx.state.ask.options.map((o) => o.key)), ['full', 'amount', 'lines']);
  });
  it('a customer\'s refund request: Approve / Reject for orders:refund only; Pay likewise', () => {
    // A counter sale: no parcel, so no "Undo delivery" row to muddy the list.
    const req = { refundStatus: 'pending', raw: 'delivered', counter: true };
    const e = mk(['orders:view', 'orders:edit'], { order: req });
    assert.deepStrictEqual(plain(e.ctx.orderActs(e.order)), []);
    const r = mk(['orders:view', 'orders:refund'], { order: req });
    // §325 O3: a NEW request also offers the desktop's Start review (orders:refund too).
    assert.deepStrictEqual(plain(r.ctx.orderActs(r.order).map((a) => a[2])), ["APP.cmd('reviewRefund')", "APP.cmd('approveRefund')", "APP.cmd('rejectRefund')"]);
    const rv = mk(['orders:view', 'orders:refund'], { order: Object.assign({}, req, { refundStatus: 'reviewing' }) });
    assert.deepStrictEqual(plain(rv.ctx.orderActs(rv.order).map((a) => a[2])), ["APP.cmd('approveRefund')", "APP.cmd('rejectRefund')"]);
    const pay = mk(['orders:view', 'orders:refund'], { order: { refundStatus: 'approved', raw: 'delivered', counter: true } });
    assert.deepStrictEqual(plain(pay.ctx.orderActs(pay.order).map((a) => a[2])), ["APP.cmd('payRefund')"]);
  });
  it('an unpaid order: Mark paid for orders:edit only', () => {
    assert.ok(cmds(mk(['orders:edit'], { order: { raw: 'pending_payment' } }).ctx.orderActionRow(Object.assign({ _id: 9, raw: 'pending_payment' }))).includes('markPaid'));
    assert.strictEqual(mk(['orders:view'], { order: { raw: 'pending_payment' } }).ctx.orderActionRow({ _id: 9, raw: 'pending_payment' }), '');
  });
  it('the commands refuse on the same keys: nothing is sent', async () => {
    const h = mk(['orders:view']);
    for (const c of ['advance', 'cancelOrder', 'markPaid', 'undoDispatch', 'undoPreparing', 'refundOrder', 'approveRefund', 'rejectRefund', 'payRefund',
      'reviewRefund', 'rfSubmit']) {
      h.CMD[c]('dispatched');
      assert.strictEqual(h.ctx.state.ask, null, c + ' opened a sheet');
      assert.ok(!h.ctx.state.rf, c + ' opened the refund form');
    }
    h.ctx.askRefundFull(h.order); h.ctx.askRefundAmount(h.order);
    assert.strictEqual(h.ctx.state.ask, null);
    await tick();
    assert.deepStrictEqual(plain(h.calls.writes), []);
  });
  it('a full refund needs both keys even when reached directly', () => {
    const h = mk(['orders:view', 'orders:refund']);
    h.ctx.askRefundFull(h.order);
    assert.strictEqual(h.ctx.state.ask, null);
  });
  it('with the key, the write is the desktop\'s request', async () => {
    const h = mk(ALL_ORDER);
    h.CMD.advance('preparing'); await tick(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes[0]), { p: '/orders/9/status', body: { status: 'preparing' }, method: 'PATCH' });
    // §325 O3: Approve is the desktop's approve form; its button sends the desktop's body.
    Object.assign(h.order, { refundStatus: 'pending', rfItems: [], refundLineIds: [], refund: { gross: 120, approved: 0 } });
    h.CMD.approveRefund(); h.CMD.rfSubmit(); await tick(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes[1]), { p: '/orders/9/refund/approve', body: { note: '', amount: 120, reverse_points: true }, method: 'POST' });
  });
  it('tracking and arrival time: read for everyone, written for orders:edit', () => {
    const sp = { id: 3, trk: { number: 'SF123', carrier_name_en: 'SF' }, lastError: 'x', localEta: '17:30', etaSource: 'manual' };
    const ro = mk(['orders:view']);
    const t = ro.ctx.trackingCard(ro.order, sp, 'Parcel');
    assert.ok(t.includes('SF123') && cmds(t).every((c) => c === 'copyWaybill'), cmds(t).join());
    assert.deepStrictEqual(cmds(ro.ctx.localEtaCard(ro.order, sp, 'x')), []);
    const none = ro.ctx.trackingCard(ro.order, { id: 4 }, 'Parcel');
    assert.ok(none.includes('No waybill yet') && !cmds(none).length);
    const rw = mk(['orders:view', 'orders:edit']);
    assert.deepStrictEqual(cmds(rw.ctx.trackingCard(rw.order, sp, 'P')), ['copyWaybill', 'resubWaybill', 'clearWaybill']);
    assert.deepStrictEqual(cmds(rw.ctx.localEtaCard(rw.order, sp, 'x')), ['setEta', 'clearEta']);
  });
  it('the courier-could-not-reach card, the delivery photo and the delay steps: no controls without orders:edit', () => {
    const ro = mk(['orders:view']);
    assert.deepStrictEqual(cmds(ro.ctx.noContactCard({ noContact: { open: true } })), []);
    const ph = ro.ctx.deliveryPhotoCard({ dphoto: { has: true, photos: [{ key: 's' }] } });
    assert.deepStrictEqual(cmds(ph), ['dphView']);
    assert.strictEqual(ro.ctx.deliveryPhotoCard({ dphoto: { has: false, photos: [] } }), '');
    assert.strictEqual(ro.ctx.mDcActs({ acts: [{ cmd: 'dcTold', arg: '3', text: 'Told' }] }, true), '');
    const rw = mk(['orders:edit']);
    assert.deepStrictEqual(cmds(rw.ctx.noContactCard({ noContact: { open: true } })), ['ackNoContact']);
    assert.deepStrictEqual(cmds(rw.ctx.deliveryPhotoCard({ dphoto: { has: true, photos: [{ key: 's' }] } })), ['dphView', 'dphDel', 'dphAdd']);
  });
  it('a stored shop note is read, not edited, without orders:edit', () => {
    const ro = mk(['orders:view'], { noteShown: true });
    const html = ro.ctx.shopNoteCard({ _id: 9, shopNote: 'fragile' });
    assert.ok(html.includes('fragile') && !html.includes('<textarea') && !cmds(html).length);
  });
  it('every order-sheet write command carries the guard', () => {
    const edit = ['clearAirDelay', 'ackNoContact', 'dcPhoto', 'dcDelEv', 'dphAdd', 'dphDel', 'dcReplacement', 'dcClaim', 'dcNoClaim',
      'dcNoRemedy', 'dcSettle', 'dispatchParcel', 'prepareParcel', 'undoParcelDispatch', 'combineParcels', 'splitParcels',
      'ordNoteOpen', 'ordNoteSave', 'addWaybill', 'clearWaybill', 'resubWaybill', 'setEta', 'clearEta', 'printOrder'];
    for (const c of edit) {
      const a = M.indexOf("reg('" + c + "',"); assert.ok(a > 0, c);
      assert.ok(/^\s*if\(!mCan\('orders:edit'\)\) return;/.test(M.slice(M.indexOf('\n', a) + 1)), c + ' has no guard');
    }
    assert.ok(/function dcStep\(sid,step,payload,busyKey\)\{\n\s*if\(!mCan\('orders:edit'\)\) return;/.test(M));
  });
}

section('2 · the product sheet');
{
  const P = () => ({ _id: 4, sku: 'SKU-4', name: ['Oat', '燕麦'], status: ['Live', '在售'], kind: 'live', price: '¥12.00', priceNum: 12, pub: true, oos: 'strict' });
  it('products:edit: price box, steppers, policy picker, Save', () => {
    const h = mk(['products:edit'], { products: [P()], stores: { 4: [{ id: 2, name_en: 'Tianhe', name_cn: '天河', qty: 3 }] } });
    h.ctx.state.productSku = 'SKU-4';
    const html = h.ctx.sheetProduct();
    assert.ok(html.includes('id="mPrice"'));
    assert.deepStrictEqual(cmds(html), ['closeProduct', 'priceTyped', 'stepDec', 'stepInc', 'openOos', 'saveProduct']);
  });
  it('a stock key alone: steppers and Save, the price read-only, no policy picker', () => {
    const h = mk(['quickstock:recount'], { products: [P()], stores: { 4: [{ id: 2, name_en: 'Tianhe', name_cn: '天河', qty: 3 }] } });
    h.ctx.state.productSku = 'SKU-4';
    const html = h.ctx.sheetProduct();
    assert.ok(!html.includes('id="mPrice"') && html.includes('¥12.00'));
    assert.deepStrictEqual(cmds(html), ['closeProduct', 'stepDec', 'stepInc', 'saveProduct']);
    assert.ok(html.includes('When it runs out') && html.includes('Sold out everywhere'));
  });
  it('neither: everything read, nothing pressed', () => {
    const h = mk(['products:view'], { products: [P()], stores: { 4: [{ id: 2, name_en: 'Tianhe', name_cn: '天河', qty: 3 }] } });
    h.ctx.state.productSku = 'SKU-4';
    const html = h.ctx.sheetProduct();
    assert.deepStrictEqual(cmds(html), ['closeProduct']);
    assert.ok(/Tianhe<\/div><span class="num"[^>]*>3</.test(html));
  });
  it('a supplier item: the pause switch is products:edit\'s', () => {
    const sup = Object.assign(P(), { supplier: true, paused: false });
    assert.deepStrictEqual(cmds(mk(['products:edit']).ctx.stockCard(sup)), ['togglePaused']);
    const ro = mk(['products:view']).ctx.stockCard(sup);
    assert.deepStrictEqual(cmds(ro), []); assert.ok(ro.includes('Available'));
  });
  it('the commands refuse: shop switch, pause, policy, Save', async () => {
    const h = mk(['products:view'], { products: [Object.assign(P(), { supplier: true })] });
    h.CMD.toggleShop('4'); h.CMD.togglePaused('4'); h.CMD.openOos('SKU-4');
    assert.strictEqual(h.ctx.state.oosSku, null);
    h.ctx.state.oosSku = 'SKU-4'; h.CMD.pickOos('backorder_all');
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetPrice[4] = '15'; await h.ctx.saveProductEdits();
    await tick();
    assert.deepStrictEqual(plain(h.calls.writes), []);
  });
  it('a stock key saves the count and never the price', async () => {
    const h = mk(['quickstock:recount'], { products: [P()], stores: { 4: [{ id: 2, qty: 3 }] } });
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetPrice[4] = '15'; h.ctx.sheetStep.st_4_2 = 5;
    await h.ctx.saveProductEdits();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/stores/2/stock/4', body: { physical_qty: 5 }, method: 'PATCH' }]);
  });
  it('products:edit saves both, price first', async () => {
    const h = mk(['products:edit'], { products: [P()], stores: { 4: [{ id: 2, qty: 3 }] } });
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetPrice[4] = '15'; h.ctx.sheetStep.st_4_2 = 5;
    await h.ctx.saveProductEdits();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/products/4', body: { sell_price: 15 }, method: 'PATCH' },
      { p: '/stores/2/stock/4', body: { physical_qty: 5 }, method: 'PATCH' }]);
  });
  it('the catalogue\'s In shop switch is drawn through prodCanEdit', () => {
    assert.ok(/\$\{!prodCanEdit\(\)\?`<span[^`]*\$\{on\?T\('On the shop','已上架'\):T\('Off the shop','已下架'\)\}/.test(M));
  });
}

section('3 · the inbox');
{
  const RV = { id: 5, stream: 'review', source: 'real', cust: ['A', 'A'], text: ['ok', 'ok'] };
  const FB = { id: 6, stream: 'feedback', needsReply: true, cust: ['B', 'B'], text: ['hi', 'hi'] };
  it('the row\'s buttons are gated on the stream\'s own key', () => {
    const src = slice("${r.stream==='review'&&r.id!=null", "</span></div></div>`;");
    assert.ok(src.includes("r.stream==='review'&&r.id!=null&&mCan('reviews:moderate')?smallBtn("));
    assert.ok(src.includes("(r.needsReply||r.handled)&&mCan('feedback:moderate')"));
    assert.ok(src.includes("revCanWrite(r)?smallBtn(r.reply?T('Edit reply','编辑回复'):T('Reply','回复')"));
    assert.ok(src.includes("smallBtn(T('View','查看'),`APP.cmd('openReply','${k}')`,false)"));
  });
  it('revCanWrite reads the stream', () => {
    const h = mk(['reviews:moderate']);
    assert.strictEqual(h.ctx.revCanWrite(RV), true); assert.strictEqual(h.ctx.revCanWrite(FB), false);
  });
  it('hide, handled and reply refuse without the key', async () => {
    const h = mk(['feedback:moderate'], { reviews: [RV], feedback: [FB] });
    h.CMD.toggleReviewVisible('rv:5'); h.ctx.revWrite(RV, false);
    h.ctx.state.reply = 'rv:5'; h.CMD.sendReplyText('thanks');
    await tick();
    assert.deepStrictEqual(plain(h.calls.writes), []);
    const f = mk(['reviews:moderate'], { reviews: [RV], feedback: [FB] });
    f.CMD.toggleFeedbackHandled('fb:6');
    f.ctx.state.reply = 'fb:6'; f.ctx.state.thread = { id: 6 }; f.CMD.sendReplyText('hello');
    await tick();
    assert.deepStrictEqual(plain(f.calls.writes), []);
  });
  it('with the key, the desktop\'s requests', async () => {
    const h = mk(['reviews:moderate', 'feedback:moderate'], { reviews: [RV], feedback: [FB] });
    h.ctx.revWrite(RV, false); await tick();
    h.CMD.toggleFeedbackHandled('fb:6'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [
      { p: '/reviews/5', body: { is_visible: false, source: 'real' }, method: 'PATCH' },
      { p: '/feedback/6/handled', body: {}, method: 'POST' }]);
  });
  it('the reply sheet opened without the key has no box and no Send', () => {
    const h = mk(['reviews:view'], { reviews: [RV] });
    h.ctx.state.reply = 'rv:5';
    const html = h.ctx.sheetReply();
    assert.ok(!html.includes('mReply') && !cmds(html).includes('sendReplyText'));
    const w = mk(['reviews:moderate'], { reviews: [RV] }); w.ctx.state.reply = 'rv:5';
    assert.ok(cmds(w.ctx.sheetReply()).includes('sendReplyText'));
  });
}

section('4 · coupons, broadcasts, media');
{
  it('the coupon switch is coupons:edit\'s; without it the card says On / Off', async () => {
    assert.ok(/\$\{\(c\.id==null\|\|!mCan\('coupons:edit'\)\)\?`<span[^`]*\$\{c\.on\?T\('On','已启用'\):T\('Off','已关闭'\)\}/.test(M));
    const h = mk(['coupons:view'], { coupons: [{ id: 5, code: 'HI', active: true }] });
    h.ctx.toggleCoupon('HI'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), []);
    const w = mk(['coupons:edit'], { coupons: [{ id: 5, code: 'HI', active: true }] });
    w.ctx.toggleCoupon('HI'); await tick();
    assert.deepStrictEqual(plain(w.calls.writes), [{ p: '/vouchers/5', body: { is_active: false }, method: 'PATCH' }]);
  });
  it('Cancel send is broadcasts:send\'s', async () => {
    assert.ok(M.includes("${b.st==='scheduled'&&b.id!=null&&mCan('broadcasts:send')?`<button"));
    const h = mk(['broadcasts:view'], { broadcasts: [{ id: 7, st: 'scheduled' }] });
    h.ctx.recallBroadcast(7); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), []);
    const w = mk(['broadcasts:send'], { broadcasts: [{ id: 7, st: 'scheduled' }] });
    w.ctx.recallBroadcast(7); await tick();
    assert.deepStrictEqual(plain(w.calls.writes), [{ p: '/broadcasts/7/recall', body: {}, method: 'POST' }]);
  });
  it('Add photos is media:upload\'s, drawn and pressed', () => {
    assert.ok(M.includes("cta:()=>{ if(!mCan('media:upload')) return ''; const b=state.mediaBusy;"));
    const h = mk(['media:view']); h.CMD.pickMedia();
    assert.strictEqual(h.calls.files, 0, 'a file picker opened');
    const w = mk(['media:upload']); w.CMD.pickMedia();
    assert.strictEqual(w.calls.files, 1);
  });
  it('unknown caps (still loading) draw the controls, as mCan always has for these keys', () => {
    const h = mk(null);
    assert.deepStrictEqual(cmds(h.ctx.orderActionRow(h.order)), ['advance', 'printOrder', 'detailActions']);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
