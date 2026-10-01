#!/usr/bin/env node
/**
 * §325 S1c — THE DESKTOP'S GUARDS, CARRIED TO THE PHONE, AND SMALL DEFECTS.
 *
 *   node scripts/test_mobile_safety_guards.js
 *
 * Live defects 5–10, 12 and 13 of docs/tacet-phone-parity-rest-of-app.md. The
 * code is RUN, sliced out of public/m.html into a sandbox with a fake server.
 * No browser — fast shard. Every write is asserted on its request; every
 * sentence copied from the desktop is checked against the desktop's own file.
 *
 *   1. Approve refund carries §222's rider warning, when it is true.
 *   2. Points adjust refuses a fraction and sends the number typed.
 *   3. The out-of-stock policy goes to every size in the family.
 *   4. The two recount refusals are asked and answered, on Add stock and the
 *      product sheet.
 *   5. Reopening a channel at a shop reads the stock-publish preview first.
 *   6. Home's Needs you sends the store lock.
 *   7. Resume delivery writes with version history.
 *   8. Legal and FAQ keep separate open rows.
 *   9. Invoice rows open their order; notes that were no longer true are gone.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ORD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');
const CUS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/08-customers.js'), 'utf8');
const PRD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const DLV = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');
const INV = fs.readFileSync(path.join(ROOT, 'routes/retail-inventory.js'), 'utf8');

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
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const SRC = [
  slice('const MCAN_MONEY_ONLY=', 'function canRoute('),
  slice("reg('askRun', key=>{", "reg('copyWaybill'"),
  slice('function orderErrorText(e){', '/* printer.* is private config'),
  slice("reg('advance', to=>{", 'function currentOrder(){'),
  slice("reg('adjustPoints', ()=>{", "reg('adjustWallet'"),
  fn('custWrite'),
  slice("reg('toggleShop', ids=>{", '/* The status buckets are derived'),
  slice('function prodCanEdit(){', '/* Needs you, from the same snapshot'),
  slice('const RECOUNT_QUESTIONS=', '/* The two ways a recount ends'),
  fn('qsSetLanded'), fn('qsSetFailed'), fn('qsCorrect'),
  slice("reg('chanCell', (channel, storeCode, next)=>{", '/* THE SHOP SWITCH'),
  slice('function opsStoreQS(){', 'function ageShort('),
  slice('const cfgGet=', '\n'),
  slice("reg('resumeDelivery', ()=>{", "reg('mirror'"),
  slice("reg('openInvoiceOrder', i=>{", "/* The operator's role, the same read"),
  slice('const INV_KIND=', '\n'), slice('const INV_DEAD=', '\n'), fn('mapInvoice'),
].join('\n');

/* A fake server: each write is recorded, and answered by `reply(req)` —
   a value resolves, an Error-like {status, body} rejects the way apiWrite does. */
function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const fields = {};
  const order = Object.assign({ id: 'R-9', _id: 9, raw: 'paid', total: '¥120.00', totalNum: 120 }, opts.order || {});
  const reply = opts.reply || (() => ({ success: true, data: {} }));
  const answer = (req) => {
    const r = reply(req);
    if (r && r.fail) {
      const e = new Error((r.body && (r.body.message || r.body.error)) || 'HTTP ' + r.fail);
      e.code = r.body && r.body.error; e.body = r.body;
      return Promise.reject(e);
    }
    return Promise.resolve(r);
  };
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: () => '', money: (c, n) => c + Number(n).toFixed(2),
    state: Object.assign({ caps: null, ask: null, askErr: null, orderBusy: null, orderErr: null, detailActions: false,
      detailId: 'R-9', liveDetail: null, drag: 0, detailMounted: false, orderOverCust: false, detailFetch: false,
      ordersView: null, liveOrders: null,
      custId: 5, custDetail: { customer: { points_balance: 100 } }, custBusy: null, custErr: null,
      prodBusy: null, prodErr: null, productSku: null, oosSku: null, prodStock: {},
      qs: { storeId: 2, items: [], fixing: {}, setBase: {}, rowErr: {}, timers: {} },
      chan: null, chanBusy: null, chanErr: null, storeLock: null, ops: null, opsLoading: false,
      cfg: null, dlvBusy: false, dlvErr: null, faqOpen: null, legalOpen: null }, opts.state || {}),
    DB: { products: opts.products || [], invoices: opts.invoices || [] },
    sheetPrice: {}, sheetStep: {},
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    currentOrder: () => order, findOrder: () => order,
    shopNoteReady: () => false, shopNoteShown: () => false, earlyShipAsk: () => null,
    showToast: (m) => calls.toasts.push(String(m)), refreshOrders: () => {},
    loadCustomerDetail: () => {}, loadCustomers: () => {}, loadInbox: () => {},
    reKindProduct: () => {}, cfgGetStub: null, loadCatalogue: async () => {}, loadProductStock: () => {},
    prodFamily: (p) => (opts.family ? opts.family(p) : []), prodStoreRows: (pid) => (opts.stores || {})[pid] || [],
    stockKey: (p, s) => 'st_' + p + '_' + s,
    qsShelf: (p) => (p && p.physical_qty != null ? (p.physical_qty | 0) : null), qsName: (p) => p.name || '',
    CHAN_META: { meituan: { en: 'Meituan', zh: '美团' }, pos: { en: 'In store', zh: '门店' } },
    chanStoreName: (c) => c.nameEn || c.storeCode, loadChannels: () => {},
    ORDER_STATUS: { cancelled: ['cancelled', 'Cancelled', '已取消'] },
    mapDetail: (o) => ({ id: o.order_no, _id: o.id }),
    mDetailFetchStub: null,
    api: (p) => { calls.reads.push(p); return Promise.resolve(opts.readReply ? opts.readReply(p) : {}); },
    apiRaw: (p) => { calls.reads.push(p); return opts.rawReply ? opts.rawReply(p) : Promise.resolve({ success: true, count: 0, items: [] }); },
    apiWrite: (p, body, method) => {
      const req = { p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST' };
      calls.writes.push(req);
      return answer(req);
    },
    document: { getElementById: (id) => (id.indexOf('ask-') === 0 ? { value: fields[id.slice(4)] || '' } : null) },
    setTimeout: () => 0, clearTimeout: () => {},   // the preview's 3s leash never fires inside a test
    _date: (v) => (v ? new Date(v) : null),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, setImmediate, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const ask = (vals) => { Object.assign(fields, vals || {}); CMD.askRun(''); };
  const pick = (key) => CMD.askRun(key);
  return { ctx, CMD, calls, order, ask, pick };
}
const has = (src, s) => assert.ok(src.includes(s), 'missing in source: ' + s);

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · Approve refund names the rider (§222)');
{
  /* §325 O3 moved Approve from a one-tap confirm to the desktop's approve form
     (sheetRefundForm). Every case below is the S1c case, asked of the form: the
     sentence must be ON THE FORM, above its button, before anything is sent. */
  const RIDER = 'A rider is on this order right now — approving cancels that delivery.';
  const base = { refundStatus: 'pending', courier: { stage: 'in_transit' }, rfItems: [], refundLineIds: [] };
  const form = (h) => h.ctx.sheetRefundForm();
  it('the pair is the desktop\'s own, and so is the stage list', () => {
    has(ORD, "cuT('A rider is on this order right now — approving cancels that delivery.',\n                           '当前已有骑手接单 — 批准后该配送会被取消。')");
    has(M, "T('A rider is on this order right now — approving cancels that delivery.','当前已有骑手接单 — 批准后该配送会被取消。')");
    has(ORD, "const RIDER_ON_IT = ['awaiting_dispatch', 'heading_to_pickup', 'in_transit'];");
    has(M, "const REFUND_RIDER_ON_IT=['awaiting_dispatch','heading_to_pickup','in_transit'];");
  });
  it('a full approve with a rider on the road says so, on the form, before anything is sent', () => {
    const h = mk({ order: Object.assign({}, base, { refund: { gross: 120, approved: 0, requested: null, lines: null } }) });
    h.CMD.approveRefund();
    assert.strictEqual(h.ctx.state.rf.kind, 'approve');
    assert.ok(form(h).includes(RIDER));
    assert.ok(form(h).indexOf(RIDER) < form(h).indexOf("APP.cmd('rfSubmit')"), 'above the button');
    assert.deepStrictEqual(h.calls.writes, []);
  });
  it('points and wallet count towards "full", as on the server (gross, not cash)', () => {
    // 120 cash + 30 points = 150 gross; the customer asked for 120 → partial → no warning.
    const h = mk({ order: Object.assign({}, base, { refund: { gross: 150, approved: 0, requested: 120, lines: null } }) });
    h.CMD.approveRefund();
    assert.ok(!form(h).includes(RIDER));
    // …and a prior partial lowers the bar: 150 − 30 already approved, 120 asked → full.
    const f = mk({ order: Object.assign({}, base, { refund: { gross: 150, approved: 30, requested: 120, lines: null } }) });
    f.CMD.approveRefund();
    assert.ok(form(f).includes(RIDER));
  });
  it('picked lines are the amount when there are any', () => {
    const h = mk({ order: Object.assign({}, base, { refund: { gross: 120, approved: 0, requested: 120 },
      rfItems: [{ id: 1, name: ['Milk', '奶'], qty: 1, left: 1, refunded: 0, unit: 40 }, { id: 2, name: ['Rice', '米'], qty: 2, left: 2, refunded: 0, unit: 40 }],
      refundLineIds: [{ item_id: 1, qty: 1 }] }) });
    h.CMD.approveRefund();
    assert.strictEqual(h.ctx.state.rf.mode, 'lines');
    assert.ok(!form(h).includes(RIDER));
    // …and ticking the rest of the order makes it full, so the warning comes on.
    h.CMD.rfChk(2);
    assert.ok(form(h).includes(RIDER));
  });
  it('no rider in flight — none found yet is not "on it", nor a cancelled one — no sentence', () => {
    for (const stage of [null, 'delivered', 'cancelled']) {
      const h = mk({ order: { refundStatus: 'pending', courier: stage ? { stage } : null, refund: { gross: 120, approved: 0 }, rfItems: [] } });
      h.CMD.approveRefund();
      assert.ok(!form(h).includes('rider'), String(stage));
    }
  });
  it('figures not read yet: the form reads them first, and claims nothing until it has them', async () => {
    const h = mk({ order: Object.assign({}, base, { refund: null, rfItems: undefined }),
      readReply: () => ({ order_no: 'R-9', id: 9 }) });
    h.ctx.mapDetail = () => ({ id: 'R-9', _id: 9, totalNum: 120, courier: { stage: 'in_transit' }, rfItems: [], refundLineIds: [],
      refund: { gross: 120, approved: 0, requested: null } });
    h.CMD.approveRefund();
    assert.ok(h.ctx.state.rf.loading);
    assert.deepStrictEqual(plain(h.calls.reads), ['/orders/9']);
    assert.ok(form(h).includes('Loading…') && !form(h).includes('rfSubmit'), 'no button before the figures');
    h.CMD.rfSubmit();
    assert.deepStrictEqual(h.calls.writes, [], 'and nothing can be sent');
    await tick();
    assert.strictEqual(h.ctx.state.rf.mode, 'full');
    h.ctx.currentOrder = () => h.ctx.state.liveDetail;
    assert.ok(form(h).includes(RIDER), 'then the warning, on the real figures');
  });
  it('confirming sends the desktop\'s approve body', async () => {
    const h = mk({ order: Object.assign({}, base, { refund: { gross: 120, approved: 0 } }) });
    h.CMD.approveRefund(); h.CMD.rfSubmit(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/orders/9/refund/approve', body: { note: '', amount: 120, reverse_points: true }, method: 'POST' }]);
  });
  it('the detail map carries the gross tender figure', () => {
    has(M, "gross:Math.round(((Number(o.points_amount)||0)+(Number(o.balance_used)||0)+(Number(o.total)||0))*100)/100,");
  });
}

section('2 · Points adjust is whole, never rounded');
{
  it('a fraction is refused with the desktop\'s words, and nothing is sent', async () => {
    has(CUS, "cuT('Points must be a whole number.', '积分必须是整数。')");
    const h = mk();
    h.CMD.adjustPoints(); h.ask({ delta: '1.5', reason: 'goodwill' });
    assert.strictEqual(String(h.ctx.state.askErr), 'Points must be a whole number.');
    await tick();
    assert.deepStrictEqual(h.calls.writes, []);
  });
  it('trailing letters are not read as a number (parseInt read "12abc" as 12)', () => {
    const h = mk();
    h.CMD.adjustPoints(); h.ask({ delta: '12abc', reason: 'x' });
    assert.strictEqual(String(h.ctx.state.askErr), 'Enter a number other than zero.');
  });
  it('a whole number goes out as typed, sign and all', async () => {
    const h = mk();
    h.CMD.adjustPoints(); h.ask({ delta: '-20', reason: 'late delivery' });
    await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/customers/5/points-adjust', body: { delta: -20, reason: 'late delivery' }, method: 'POST' }]);
  });
}

section('3 · The out-of-stock policy goes to the whole family');
{
  const fam = () => [{ _id: 1, sku: 'S', oos: 'strict' }, { _id: 2, sku: 'M', oos: 'strict' }, { _id: 3, sku: 'L', oos: 'backorder_all' }];
  it('the size on screen first, then every sibling that differs — the desktop\'s vaPersistSiblings(oosPolicy)', async () => {
    has(PRD, 'if (oosPolicy != null) body.oos_policy = oosPolicy;');
    const rows = fam();
    const h = mk({ products: rows, family: () => rows });
    h.ctx.state.oosSku = 'M';
    h.CMD.pickOos('backorder_all'); await tick(6);
    assert.deepStrictEqual(plain(h.calls.writes), [
      { p: '/products/2', body: { oos_policy: 'backorder_all' }, method: 'PATCH' },
      { p: '/products/1', body: { oos_policy: 'backorder_all' }, method: 'PATCH' }]);
    assert.deepStrictEqual(rows.map((r) => r.oos), ['backorder_all', 'backorder_all', 'backorder_all']);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
  });
  it('a single product writes once, as before', async () => {
    const h = mk({ products: [{ _id: 7, sku: 'X', oos: 'strict' }] });
    h.ctx.state.oosSku = 'X';
    h.CMD.pickOos('backorder_gz'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/products/7', body: { oos_policy: 'backorder_gz' }, method: 'PATCH' }]);
  });
  it('a failure part-way puts back only what did not land, and says to pick again', async () => {
    const rows = fam();
    const h = mk({ products: rows, family: () => rows, reply: (r) => (r.p === '/products/1' ? { fail: 500, body: {} } : { success: true }) });
    h.ctx.state.oosSku = 'M';
    h.CMD.pickOos('backorder_all'); await tick(6);
    assert.deepStrictEqual(rows.map((r) => r.oos), ['strict', 'backorder_all', 'backorder_all']);
    assert.strictEqual(String(h.ctx.state.prodErr), 'Some sizes did not save. Pick it again to finish.');
    // Picking again sends only the one that is still behind.
    h.calls.writes.length = 0; h.ctx.state.oosSku = 'M';
    const ok = mk({ products: rows, family: () => rows }); ok.ctx.state.oosSku = 'M';
    ok.CMD.pickOos('backorder_all'); await tick(6);
    assert.deepStrictEqual(plain(ok.calls.writes), [{ p: '/products/1', body: { oos_policy: 'backorder_all' }, method: 'PATCH' }]);
  });
}

section('4 · The recount questions, asked and answered');
{
  const DEBT = { fail: 400, body: { success: false, error: 'recount_clears_debt', owed: 18, accepts: ['clears_debt'] } };
  const DOWN = { fail: 400, body: { success: false, error: 'recount_reason_required', accepts: ['miscount'] } };
  it('the server\'s codes and words are the ones answered', () => {
    has(INV, "error: 'recount_clears_debt'"); has(INV, "error: 'recount_reason_required'");
    has(fs.readFileSync(path.join(ROOT, 'lib/quick-stock-grant.js'), 'utf8'), "const RECOUNT_CLEARS_DEBT = 'clears_debt';");
  });
  it('the questions are the desktop\'s, word for word', () => {
    for (const s of ["`Customer orders waiting — ${owed}`", "`有客户订单等待 — ${owed}`", "'Clear it and save', '清零并保存'", "'Keep it', '保留'",
      "'That number is what the kitchen cooks against, and saving a count here sets it '", "'这个数字是厨房的待制作依据,在此保存数量会将其清零。若要增加库存,请改用“加库存”。'"]) {
      has(PRD, s); has(M, s.replace("', '", "','"));
    }
  });
  it('Add stock: a raise over a debt is asked, and the answer resends the count with clears_debt', async () => {
    let n = 0;
    const p = { product_id: 4, physical_qty: -18 };
    const h = mk({ state: { qs: { storeId: 2, items: [p], fixing: {}, setBase: {}, rowErr: {}, timers: {} } },
      reply: () => (n++ === 0 ? DEBT : { success: true }) });
    h.ctx.qsCorrect(4, 5, null); await tick();
    assert.strictEqual(h.ctx.state.ask.title, 'Customer orders waiting — 18');
    assert.ok(h.ctx.state.ask.body.startsWith('This shelf is at -18 because 18 were sold'));
    assert.strictEqual(p.physical_qty, -18, 'the shelf went back while asking');
    assert.ok(!h.ctx.state.qs.rowErr[4], 'a question is not an error line');
    h.pick('clears_debt'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [
      { p: '/stores/2/stock/4', body: { physical_qty: 5, note: 'kitchen-correct' }, method: 'PATCH' },
      { p: '/stores/2/stock/4', body: { physical_qty: 5, note: 'kitchen-correct', recount_reason: 'clears_debt' }, method: 'PATCH' }]);
  });
  it('Keep it sends nothing more', async () => {
    const p = { product_id: 4, physical_qty: -18 };
    const h = mk({ state: { qs: { storeId: 2, items: [p], fixing: {}, setBase: {}, rowErr: {}, timers: {} } }, reply: () => DEBT });
    h.ctx.qsCorrect(4, 5, null); await tick();
    h.pick('keep'); await tick();
    assert.strictEqual(h.calls.writes.length, 1);
  });
  it('Add stock in recount mode asks too, and resends with its own body', async () => {
    let n = 0;
    const p = { product_id: 4, physical_qty: 3 };
    const h = mk({ state: { qs: { storeId: 2, items: [p], fixing: {}, setBase: { 4: -18 }, rowErr: {}, timers: {} } },
      reply: () => (n++ === 0 ? DEBT : { success: true }) });
    h.ctx.qsSetCommit(4); await tick();
    assert.strictEqual(p.physical_qty, -18);
    h.pick('clears_debt'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes[1]), { p: '/stores/2/stock/4', body: { physical_qty: 3, reason: 'adjust', note: 'quick-stock', recount_reason: 'clears_debt' }, method: 'PATCH' });
  });
  it('a refusal already answered is reported, not asked again', async () => {
    const p = { product_id: 4, physical_qty: -18 };
    const h = mk({ state: { qs: { storeId: 2, items: [p], fixing: {}, setBase: {}, rowErr: {}, timers: {} } }, reply: () => DEBT });
    h.ctx.qsCorrect(4, 5, 'clears_debt'); await tick();
    assert.strictEqual(h.ctx.state.ask, null);
    assert.ok(h.ctx.state.qs.rowErr[4]);
  });
  const P = () => ({ _id: 4, sku: 'SKU-4', priceNum: 12 });
  it('the product sheet: a debt is asked, and the answer resends that count only', async () => {
    let n = 0;
    const st = { id: 2, qty: -18 };
    const h = mk({ products: [P()], stores: { 4: [st] }, reply: (r) => (r.p.indexOf('/stores/') === 0 && n++ === 0 ? DEBT : { success: true }) });
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetStep.st_4_2 = 5;
    await h.ctx.saveProductEdits();
    assert.strictEqual(h.ctx.state.ask.title, 'Customer orders waiting — 18');
    assert.strictEqual(h.ctx.state.prodErr, null);
    h.pick('clears_debt'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [
      { p: '/stores/2/stock/4', body: { physical_qty: 5 }, method: 'PATCH' },
      { p: '/stores/2/stock/4', body: { physical_qty: 5, recount_reason: 'clears_debt' }, method: 'PATCH' }]);
    assert.strictEqual(st.qty, 5);
  });
  it('the product sheet: a count gone down is asked the §46 way; "missing" puts the stepper back', async () => {
    const st = { id: 2, qty: 9 };
    const h = mk({ products: [P()], stores: { 4: [st] }, reply: () => DOWN });
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetStep.st_4_2 = 5;
    await h.ctx.saveProductEdits();
    assert.strictEqual(h.ctx.state.ask.title, 'The count has gone down');
    assert.deepStrictEqual(plain(h.ctx.state.ask.options.map((o) => o.label)), ['I counted wrong — save 5', 'Something is missing or spoiled']);
    h.pick('gone'); await tick();
    assert.strictEqual(h.ctx.sheetStep.st_4_2, 9);
    assert.deepStrictEqual(h.calls.toasts, ['The count stays as it is. Tell whoever records waste.']);
    assert.strictEqual(h.calls.writes.length, 1);
  });
  it('the product sheet: "I counted wrong" resends with miscount', async () => {
    let n = 0;
    const st = { id: 2, qty: 9 };
    const h = mk({ products: [P()], stores: { 4: [st] }, reply: () => (n++ === 0 ? DOWN : { success: true }) });
    h.ctx.state.productSku = 'SKU-4'; h.ctx.sheetStep.st_4_2 = 5;
    await h.ctx.saveProductEdits();
    h.pick('miscount'); await tick();
    assert.deepStrictEqual(plain(h.calls.writes[1]), { p: '/stores/2/stock/4', body: { physical_qty: 5, recount_reason: 'miscount' }, method: 'PATCH' });
  });
}

section('5 · Reopening a channel at a shop checks what it will publish');
{
  const GRID = { channels: [{ channel: 'meituan', cells: [{ storeCode: 'panyu', nameEn: 'Panyu', open: false }] }] };
  const preview = { success: true, count: 7, items: [{ name: 'Oat milk', updatedAt: null }, { name: 'Hummus', updatedAt: '2000-01-01 00:00:00' }] };
  it('the desktop reads the same preview and asks the same question', () => {
    has(CORE, "/api/retail-admin/channel-status/reopen-preview?channel=");
    for (const s of ["'Publish current stock to this channel?', '将当前库存发布到该渠道？'", "'Publish', '发布'", "'Not yet', '暂不'", "'never touched', '从未更新'"]) {
      has(CORE, s); has(M, s.replace("', '", "','"));
    }
  });
  it('open → confirm → preview read → the publish question, then the cell write', async () => {
    const h = mk({ state: { chan: GRID }, rawReply: () => Promise.resolve(preview) });
    h.CMD.chanCell('meituan', 'panyu', '1');
    assert.strictEqual(h.ctx.state.ask.title, 'Open Meituan at Panyu?');
    h.ask(); await tick();
    assert.deepStrictEqual(plain(h.calls.reads), ['/channel-status/reopen-preview?channel=meituan&storeCode=panyu']);
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Publish current stock to this channel?');
    assert.ok(a.body.includes('Reopening will publish current quantities for 7 product(s). Oldest first:'));
    assert.ok(a.body.includes('Oat milk — never touched') && a.body.includes('Hummus — ') && a.body.includes('and 5 more'));
    assert.strictEqual(a.confirmLabel, 'Publish'); assert.strictEqual(a.cancelLabel, 'Not yet');
    assert.deepStrictEqual(h.calls.writes, [], 'nothing written before the answer');
    h.ask(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/channel-status/cell', body: { channel: 'meituan', storeCode: 'panyu', open: true }, method: 'POST' }]);
  });
  it('nothing to publish, or a preview that fails: straight to the write, as on the desktop', async () => {
    for (const rawReply of [() => Promise.resolve({ success: true, count: 0, items: [] }), () => Promise.reject(new Error('HTTP 500'))]) {
      const h = mk({ state: { chan: GRID }, rawReply });
      h.CMD.chanCell('meituan', 'panyu', '1'); h.ask(); await tick();
      assert.strictEqual(h.calls.writes.length, 1);
    }
  });
  it('closing reads no preview', async () => {
    const h = mk({ state: { chan: GRID } });
    h.CMD.chanCell('meituan', 'panyu', '0'); h.ask(); await tick();
    assert.deepStrictEqual(h.calls.reads, []);
    assert.deepStrictEqual(plain(h.calls.writes[0].body), { channel: 'meituan', storeCode: 'panyu', open: false });
  });
  it('the ask sheet draws a caller\'s cancel label', () => {
    has(M, "${a.cancelLabel||T('Cancel','取消')}");
  });
}

section('6 · Needs you follows the store lock');
{
  it('a store-scoped operator\'s read names their store, as dashStoreQS does', async () => {
    has(fs.readFileSync(path.join(ROOT, 'public/retail-admin/03-dashboard.js'), 'utf8'), 'if (window.RA_STORE_LOCK) return String(window.RA_STORE_LOCK);');
    const h = mk({ state: { storeLock: '3' } });
    await h.ctx.loadOps();
    assert.deepStrictEqual(plain(h.calls.reads), ['/dashboard/ops?store_id=3']);
  });
  it('no lock, no filter — all stores, as before', async () => {
    const h = mk();
    await h.ctx.loadOps();
    assert.deepStrictEqual(plain(h.calls.reads), ['/dashboard/ops']);
  });
}

section('7 · Resume delivery is a version');
{
  it('the desktop card and its key', () => {
    has(DLV, "card: 'delivery.holiday'");
  });
  it('PUT /config?history=delivery.holiday with the card\'s two keys, the message unchanged', async () => {
    const h = mk({ state: { cfg: { delivery: { holidayMode: true, holidayMessage: { en: 'Back Thursday', cn: '周四回来' } } } } });
    h.CMD.resumeDelivery(); h.ask(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes), [{ p: '/config?history=delivery.holiday', method: 'PUT',
      body: { 'delivery.holidayMode': false, 'delivery.holidayMessage': { en: 'Back Thursday', cn: '周四回来' } } }]);
    assert.strictEqual(h.ctx.state.cfg.delivery.holidayMode, false);
  });
  it('a message the phone never read is left out, never sent blank', async () => {
    const h = mk({ state: { cfg: { delivery: { holidayMode: true } } } });
    h.CMD.resumeDelivery(); h.ask(); await tick();
    assert.deepStrictEqual(plain(h.calls.writes[0].body), { 'delivery.holidayMode': false });
  });
}

section('8 · Legal and FAQ keep their own open row');
{
  it('two commands, two keys', () => {
    const h = mk();
    h.CMD.faqToggle(0);
    assert.strictEqual(h.ctx.state.faqOpen, 0); assert.strictEqual(h.ctx.state.legalOpen, null);
    h.CMD.legalToggle(1);
    assert.strictEqual(h.ctx.state.legalOpen, 1); assert.strictEqual(h.ctx.state.faqOpen, 0);
  });
  it('the legal screen reads legalOpen and calls legalToggle; the key is declared', () => {
    const legal = slice("{key:'terms',   name:['Terms of service','服务条款']}", 'Clipped here');
    assert.ok(legal.includes("APP.cmd('legalToggle',${i})") && legal.includes('state.legalOpen===i'));
    assert.ok(!legal.includes('faqOpen') && !legal.includes('faqToggle'));
    has(M, 'faqOpen:null, legalOpen:null,');
  });
}

section('9 · Notes that were no longer true');
{
  it('an invoice row opens its order, which is where §314 issues the fapiao', async () => {
    const v = { order_no: '20260930-0142', id: 142, invoice_status: 'requested', status: 'paid', total: 268 };
    const h = mk({ invoices: [], readReply: () => ({ id: 142, order_no: '20260930-0142' }) });
    h.ctx.DB.invoices = [h.ctx.mapInvoice(v)];
    assert.strictEqual(h.ctx.DB.invoices[0]._id, 142);
    h.CMD.openInvoiceOrder(0); await tick();
    assert.deepStrictEqual(plain(h.calls.reads), ['/orders/142']);
    assert.strictEqual(h.ctx.state.detailId, '20260930-0142');
    assert.strictEqual(h.ctx.state.detailFetch, false);
  });
  it('the Invoices line and the desktop-only claims are gone', () => {
    assert.ok(!M.includes("noteBar(T('Issue fapiao on desktop'"));
    assert.ok(!M.includes('Marking it paid is a desktop action'));
    assert.ok(!M.includes("'Store details, staff, printers and payment keys are set on desktop.'"));
    // §325 X6 — store details are edited on the phone now, so they left the line too.
    assert.ok(!M.includes("'Store details, printers and payment keys are set on desktop.'"));
    // §325 X7 — and printers: they have their own screen now.
    assert.ok(!M.includes("'Printers and payment keys are set on desktop.'"));
    has(M, "noteBar(T('Payment keys are set on desktop.','支付密钥在电脑端设置。'))");
    has(M, "why:['The screenshot was read and matches.',\n         '付款截图已核对一致。']};");
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
