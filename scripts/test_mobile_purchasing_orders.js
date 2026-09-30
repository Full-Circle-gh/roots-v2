#!/usr/bin/env node
/**
 * §300 P1 — PURCHASE ORDERS ON THE PHONE: the list's search, month and store,
 * the row's facts, and managing one order.
 *
 *   node scripts/test_mobile_purchasing_orders.js
 *
 * The desktop module is the spec (public/retail-admin/16-purchasing.js). The
 * phone's code is RUN, sliced out of public/m.html into a sandbox, so every
 * write below is asserted on the REQUEST it sends — path, method and every
 * body field — not on a toast. What it pins:
 *
 *   1. the list: order date, "N suppliers" for a mixed order, the kitchen
 *      order a copy came from; the search, month and store go to the server
 *      and repaint the list only; a failed search says so and retries;
 *   2. the sub-view strip draws only tabs that work;
 *   3. the order: its journey, each line's supplier and cost each, and money
 *      FAILING CLOSED (no capabilities known = no money, and the receive-only
 *      account that reaches this sheet from Receiving sees none either);
 *   4. Back to draft, Undo receiving, Cancel and Back-order: the desktop's
 *      conditions, capability, confirm, request, and its refusals rendered
 *      where the operator is looking;
 *   5. landed cost: view, edit, save, and a failed save that keeps the figures;
 *   6. the printed order: bilingual whatever the phone's language, money-gated.
 *
 * No browser — this runs in the fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
  });
}

function slice(from, to) {
  const a = M.indexOf(from);
  assert.notStrictEqual(a, -1, 'not found in m.html: ' + from);
  const b = M.indexOf(to, a + from.length);
  assert.notStrictEqual(b, -1, 'not found after ' + from + ': ' + to);
  return M.slice(a, b);
}
// The purchasing region, the two small helpers it borrows from Receiving, and
// the open/close commands the sheet is driven by.
const REGION = slice('const poMoney=', '/* ==========================================================================\n   §286 — Suppliers we owe');
const PARTIAL = slice('const rcvPartial=', 'function rcvToReceive(){');
const MATCHED = slice('function rcvMatched(r){', 'function statusReceiving(){');
const OPEN = slice("reg('openPO',", '/* From the order straight into receiving it.');
const PILL_SRC = slice('const PILL = {', 'function pill(kind, label)');

const flush = () => new Promise((r) => setImmediate(r));
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], renders: 0, timers: [], opened: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: Object.assign({
      caps: opts.caps === undefined ? ['purchasing:view', 'purchasing:edit', 'purchasing:receive'] : opts.caps,
      poList: null, posErr: null, posTried: true, poSeg: 'all', poId: null,
      poDetail: null, poErr: null, poBusy: false, poMounted: false,
      poView: 'orders', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null, storeName: 'Roots',
    }, opts.state || {}),
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => { const num = Number(n || 0); const f = num % 1 ? 2 : 0; return (cur || '¥') + num.toLocaleString('en-US', { minimumFractionDigits: f, maximumFractionDigits: f }); },
    money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)).toLocaleString('en-US'),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5) : ''),
    shopToday: () => '2026-09-30',
    tdWhen: (v, kind) => (kind === 'month' ? 'M' + String(v).slice(0, 7) : 'STAMP'),
    _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {},
    catLabel: (v) => String(v || '').split(' ')[0],
    canRoute: (k) => (opts.routes ? opts.routes.includes(k) : true),
    mCan: (k) => !Array.isArray(ctx.state.caps) || ctx.state.caps.includes(k),
    screenSupOwed: () => '<div>SUPOWED-SCREEN</div>',
    statusSupOwed: () => 'SUPOWED-STATUS',
    poDeliveries: () => '',
    loadPoReceipts: () => {},
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { calls.timers.push(f); return calls.timers.length; },
    clearTimeout: () => {},
    document: { getElementById: (id) => els[id] || null },
    api: async (p) => {
      calls.gets.push(p);
      const r = opts.get ? opts.get(p) : [];
      if (r instanceof Error) throw r;
      return JSON.parse(JSON.stringify(r));
    },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      const r = opts.write ? opts.write(p, body, method) : { success: true };
      if (r instanceof Error) throw r;
      return r;
    },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => { if (n === 'openPO' && opts.stubOpen) { calls.opened.push(a[0]); return; } return CMD[n](...a); } };
  vm.createContext(ctx);
  vm.runInContext(PILL_SRC + PARTIAL + MATCHED + REGION + OPEN, ctx);
  return { ctx, CMD, calls, els, s: ctx.state };
}
function fail(code, body) { const e = new Error(code); e.code = code; e.body = Object.assign({ success: false, error: code }, body || {}); return e; }

const LIST = [
  { id: 4, po_number: 'RPO-0004', supplier: 'Fresh Co.', store_id: 1, store_name_en: 'Tianhe', store_name_cn: '天河店',
    date: '2026-08-14', delivery_date: '2026-08-16', status: 'Ordered', line_count: 6, received_lines: 0, total_cost: 3240 },
  { id: 9, po_number: 'RPO-0009', supplier: '', line_suppliers: 'Levant Foods,Guangzhou Dairy', store_id: 2, store_name_en: 'Yuexiu',
    date: '2026-09-29', status: 'Ordered', line_count: 9, received_lines: 0, total_cost: 3905 },
  { id: 10, po_number: 'RPO-0010', supplier: '', line_suppliers: 'Metro', store_id: 1, store_name_en: 'Tianhe',
    date: '2026-09-30', status: 'Requested', line_count: 1, total_cost: 264, copied_from_po_number: 'PO-0031' },
];
const DELIVERED = {
  id: 6, po_number: 'RPO-0006', supplier: '', store_id: 1, store_name_en: 'Tianhe', store_name_cn: '天河店',
  date: '2026-09-20', status: 'Delivered', total_cost: 1420, extra_freight: 40, extra_tax: 0, extra_handling: 0, notes: 'Back door',
  items: [
    { id: 1, name_en: 'Tahini', name_cn: '芝麻酱', qty: 10, unit: 'kg', cost_per_unit: 96, total_cost: 960, qty_received: 10, supplier_name: 'Levant Foods' },
    { id: 2, name_en: 'Chickpeas', name_cn: '鹰嘴豆', qty: 25, unit: 'kg', cost_per_unit: 14, total_cost: 350, qty_received: 18, supplier_name: 'Levant Foods', returned_qty: 2 },
    { id: 3, name_en: 'Flour', name_cn: '面粉', qty: 2, unit: 'bag', cost_per_unit: 55, total_cost: 110, qty_received: 2, ingredient_id: 7, supplier_name: 'Mill' },
  ],
  expenses: [{ id: 1, amount: 1380, category: 'Food 食品' }, { id: 2, amount: 40, category: 'Freight 运费' }],
};
const ORDERED = { id: 4, po_number: 'RPO-0004', supplier: 'Fresh Co.', status: 'Ordered', total_cost: 3240, date: '2026-08-14',
  items: [{ id: 11, name_en: 'Oat milk', qty: 48, unit: 'btl', cost_per_unit: 30, total_cost: 1440 }], expenses: [] };
const open = (e, po) => { e.s.poId = po.id; e.s.poDetail = JSON.parse(JSON.stringify(po)); return text(e.ctx.sheetPO()); };

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the list: the row\'s facts');
{
  it('each row says when it was ordered', () => {
    const e = mk({ state: { poList: LIST } });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(t.includes('RPO-0004 · D08-14'), t);
    assert.ok(t.includes('RPO-0009 · D09-29'));
  });
  it('a mixed order says how many suppliers, not "No supplier"', () => {
    const e = mk({ state: { poList: LIST } });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(t.includes('2 suppliers · Yuexiu'), t);
    assert.ok(!t.includes('No supplier'));
  });
  it('one line supplier is the order\'s supplier in practice', () => {
    const e = mk({ state: { poList: LIST } });
    assert.ok(text(e.ctx.screenPurchasing()).includes('Metro · Tianhe'));
  });
  it('a copy names the kitchen order it came from', () => {
    const e = mk({ state: { poList: LIST } });
    assert.ok(text(e.ctx.screenPurchasing()).includes('from PO-0031'));
  });
  it('in Chinese, the mixed count is the desktop\'s pair', () => {
    const e = mk({ lang: 'zh', state: { poList: LIST } });
    assert.ok(text(e.ctx.screenPurchasing()).includes('2 家供应商'));
  });
  it('an empty ledger looks empty, and invents nothing', () => {
    const e = mk({ state: { poList: [] } });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(t.includes('No purchase orders yet'));
    assert.ok(!t.includes('RPO-'));
  });
  it('a ledger that would not load says so', () => {
    const e = mk({ state: { poList: null, posErr: 'Could not load purchase orders.' } });
    assert.ok(text(e.ctx.screenPurchasing()).includes('Could not load purchase orders'));
  });
}

section('2 · the sub-view strip draws only what works');
{
  it('Orders and Suppliers we owe, when both are reachable', () => {
    const e = mk({ state: { poList: LIST } });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(t.includes('Orders') && t.includes('Suppliers we owe'));
    assert.ok(!/Invoices|Reorder/.test(t), 'no dead tabs');
  });
  it('the second tab shows the account screen, and the head band follows', () => {
    const e = mk({ state: { poList: LIST } });
    e.CMD.poView('supowed');
    assert.strictEqual(e.s.poView, 'supowed');
    assert.ok(e.ctx.screenPurchasing().includes('SUPOWED-SCREEN'));
    assert.strictEqual(e.ctx.statusPurchasing(), 'SUPOWED-STATUS');
  });
  it('one tab alone is not a strip', () => {
    const e = mk({ routes: ['purchasing'], state: { poList: LIST } });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(!t.includes('Suppliers we owe'));
    e.CMD.poView('supowed');
    assert.ok(!e.ctx.screenPurchasing().includes('SUPOWED-SCREEN'), 'an unreachable view is not drawn');
  });
}

section('3 · search, month and store go to the server');
{
  it('a keystroke waits for the pause, then asks /purchases?search=', async () => {
    const e = mk({ state: { poList: LIST }, get: (p) => (p.startsWith('/purchases?') ? [Object.assign({}, LIST[0], { matched_lines: [{ name_en: 'Mint' }] })] : []) });
    e.CMD.poQuery('mint');
    assert.strictEqual(e.calls.gets.length, 0, 'nothing sent on the keystroke');
    e.calls.timers.pop()();
    await flush();
    assert.deepStrictEqual(e.calls.gets, ['/purchases?search=mint']);
    const t = text(e.ctx.screenPurchasing());
    assert.ok(t.includes('RPO-0004') && !t.includes('RPO-0009'), 'the rows are the server\'s answer');
    assert.ok(t.includes('Mint'), 'and the matched product is named on the row');
  });
  it('the answer repaints the list only, never the search field', async () => {
    const e = mk({ state: { poList: LIST }, get: () => [LIST[1]] });
    const segs = { innerHTML: '' }, body = { innerHTML: '' };
    e.els.mPoSegs = segs; e.els.mPoBody = body;
    e.CMD.poQuery('dairy'); e.calls.timers.pop()(); await flush();
    assert.strictEqual(e.calls.renders, 0, 'no full render');
    assert.ok(text(body.innerHTML).includes('RPO-0009'));
    assert.ok(/All\s*1/.test(text(segs.innerHTML)), 'segment counts follow the answer');
  });
  it('month and store choices come from the ledger, and appear only when there is a choice', () => {
    const e = mk({ state: { poList: LIST } });
    const h = e.ctx.screenPurchasing();
    assert.ok(h.includes("APP.cmd('poMonth'") && h.includes('M2026-08') && h.includes('M2026-09'));
    assert.ok(h.includes("APP.cmd('poStoreF'") && h.includes('Yuexiu'));
    assert.ok(text(h).includes('All months') && text(h).includes('All stores'));
    const one = mk({ state: { poList: [LIST[0]] } });
    const h1 = one.ctx.screenPurchasing();
    assert.ok(!h1.includes("APP.cmd('poMonth'") && !h1.includes("APP.cmd('poStoreF'"));
  });
  it('month and store are sent together with the search', async () => {
    const e = mk({ state: { poList: LIST, poQ: 'oat' }, get: () => [] });
    e.CMD.poMonth('2026-08'); await flush();
    e.CMD.poStoreF('1'); await flush();
    assert.deepStrictEqual(e.calls.gets, ['/purchases?search=oat&month=2026-08', '/purchases?search=oat&month=2026-08&store_id=1']);
    assert.ok(text(e.ctx.screenPurchasing()).includes('Nothing here — try another filter.'), 'an empty answer looks empty');
  });
  it('clearing every filter goes back to the ledger without a read', async () => {
    const e = mk({ state: { poList: LIST, poQ: 'x', poFound: [] } });
    e.CMD.poQuery(''); e.calls.timers.pop()(); await flush();
    assert.strictEqual(e.calls.gets.length, 0);
    assert.strictEqual(e.s.poFound, null);
    assert.ok(text(e.ctx.screenPurchasing()).includes('RPO-0009'));
  });
  it('a failed search says so and can be tried again', async () => {
    let n = 0;
    const e = mk({ state: { poList: LIST, poQ: 'oat' }, get: () => (n++ ? [LIST[0]] : new Error('HTTP 500')) });
    e.CMD.poMonth('2026-08'); await flush();
    assert.ok(text(e.ctx.screenPurchasing()).includes('Could not load purchase orders'));
    e.CMD.poFindRetry(); await flush();
    assert.strictEqual(e.calls.gets.length, 2);
    assert.ok(text(e.ctx.screenPurchasing()).includes('RPO-0004'));
  });
  it('a slow answer to an older query is thrown away', async () => {
    let resolveFirst;
    const e = mk({ state: { poList: LIST } });
    e.ctx.api = (p) => (p.includes('first') ? new Promise((r) => { resolveFirst = r; }) : Promise.resolve([LIST[1]]));
    e.CMD.poQuery('first'); e.calls.timers.pop()();
    e.CMD.poQuery('second'); e.calls.timers.pop()(); await flush();
    resolveFirst([LIST[0]]); await flush();
    assert.deepStrictEqual(e.s.poFound.map((p) => p.id), [9]);
  });
}

section('4 · the order: journey, lines, money');
{
  it('the journey reads Draft → Sent → Part received → Received', () => {
    const e = mk();
    const t = open(e, DELIVERED);
    assert.ok(/Draft .*Sent .*Part received .*Received/.test(t), t);
  });
  it('a part-counted Sent order is at Part received', () => {
    const e = mk();
    const po = JSON.parse(JSON.stringify(ORDERED));
    po.items.push({ id: 12, name_en: 'Rice', qty: 1, cost_per_unit: 5, qty_received: 1 });
    open(e, po);
    const h = e.ctx.poLifeStepper(e.s.poDetail);
    assert.ok(/font-weight:500">Part received/.test(h), 'Part received is the current step');
  });
  it('an order that failed to load gets no journey rather than a wrong one', () => {
    const e = mk();
    assert.strictEqual(e.ctx.poLifeStepper({ id: 1, items: [] }), '');
  });
  it('each line names its supplier and what each costs; a material line is tagged', () => {
    const e = mk();
    const t = open(e, DELIVERED);
    assert.ok(t.includes('Levant Foods') && t.includes('¥96 each') && t.includes('¥14 each'));
    assert.ok(t.includes('Material'));
  });
  it('the header of a mixed order counts its suppliers', () => {
    const e = mk();
    assert.ok(open(e, DELIVERED).includes('2 suppliers'));
  });
  it('the Finance panel lists what the order posted, and what a return took off', () => {
    const e = mk();
    const t = open(e, DELIVERED);
    assert.ok(t.includes('Food ¥1,380') && t.includes('Freight ¥40'));
    assert.ok(t.includes('Posted to Expenses · ¥1,420'));
    assert.ok(t.includes('Returned to supplier · ¥28'));
  });
  it('an order that posted nothing yet says when it will', () => {
    const e = mk();
    assert.ok(open(e, ORDERED).includes('Posts to Expenses when the order is placed.'));
  });
  it('MONEY FAILS CLOSED: capabilities not known yet → no money at all', () => {
    const e = mk({ caps: null });
    const t = open(e, DELIVERED);
    assert.ok(!t.includes('¥'), t);
    assert.ok(!t.includes('each') && !t.includes('Finance') && !t.includes('landed cost'));
    assert.ok(!e.ctx.sheetPO().includes("APP.cmd('poPrint')"), 'no printed order either');
    assert.ok(t.includes('Tahini') && t.includes('Levant Foods'), 'the order itself still reads');
  });
  it('a receive-only account (reached from Receiving) sees no money', () => {
    const e = mk({ caps: ['purchasing:receive'] });
    const t = open(e, DELIVERED);
    assert.ok(!t.includes('¥') && !t.includes('Finance'));
    assert.ok(!e.ctx.sheetPO().includes("APP.cmd('poActs')"), 'and no manage menu');
  });
}

section('5 · Back to draft, Undo receiving, Cancel — the desktop\'s conditions and gates');
{
  const keys = (e, po) => { open(e, po); return JSON.parse(JSON.stringify(e.ctx.poActions(e.s.poDetail).map((a) => a.key))); };
  it('Sent: back to draft and cancel', () => assert.deepStrictEqual(keys(mk(), ORDERED), ['draft', 'cancel']));
  it('Received: undo receiving', () => assert.deepStrictEqual(keys(mk(), DELIVERED), ['undo']));
  it('Cancelled and draft: none (a draft opens in the wizard on the desktop)', () => {
    assert.deepStrictEqual(keys(mk(), Object.assign({}, ORDERED, { status: 'Cancelled' })), []);
    assert.deepStrictEqual(keys(mk(), Object.assign({}, ORDERED, { status: 'Requested' })), []);
  });
  it('without purchasing:edit there is no menu to open', () => {
    const e = mk({ caps: ['purchasing:view', 'purchasing:receive'] });
    open(e, ORDERED);
    assert.ok(!e.ctx.sheetPO().includes("APP.cmd('poActs')"));
    e.CMD.poActs(); e.CMD.poAct('cancel');
    assert.strictEqual(e.s.ask, null, 'nor a way round it');
  });
  it('the menu opens with the actions, and Cancel asks the desktop\'s question first', () => {
    const e = mk();
    open(e, ORDERED);
    e.CMD.poActs();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e.s.ask.options.map((o) => o.label))), ['Back to draft', 'Cancel order']);
    e.s.ask.run('cancel');
    assert.strictEqual(e.s.ask.title, 'Cancel this order?');
    assert.strictEqual(e.s.ask.confirmLabel, 'Cancel order');
    assert.strictEqual(e.s.ask.danger, true);
    assert.strictEqual(e.calls.writes.length, 0, 'nothing sent before the confirm');
  });
  it('Cancel sends PUT /purchases/:id/status {status:"Cancelled"}, then reloads', async () => {
    const e = mk({ get: (p) => (p === '/purchases/4' ? Object.assign({}, ORDERED, { status: 'Cancelled' }) : LIST) });
    open(e, ORDERED);
    e.CMD.poAct('cancel'); e.s.ask.run();
    assert.strictEqual(e.s.poBusy, 'cancel');
    assert.ok(text(e.ctx.sheetPO()).includes('Saving…'), 'says what it is doing');
    await flush(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/4/status', body: { status: 'Cancelled' }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Saved']);
    assert.ok(e.calls.gets.includes('/purchases') && e.calls.gets.includes('/purchases/4'));
    assert.strictEqual(e.s.poDetail.status, 'Cancelled');
    assert.strictEqual(e.s.poBusy, false);
  });
  it('Back to draft asks, then sends {status:"Requested"}', async () => {
    const e = mk({ get: () => ORDERED });
    open(e, ORDERED);
    e.CMD.poAct('draft');
    assert.strictEqual(e.s.ask.title, 'Back to draft?');
    assert.ok(e.s.ask.body.includes('Posts to Expenses when the order is placed.'));
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/4/status', body: { status: 'Requested' }, method: 'PUT' }]);
  });
  it('Undo receiving says what it clears BEFORE the confirm, then sends PUT /undo-receive', async () => {
    const e = mk({ get: () => DELIVERED });
    open(e, DELIVERED);
    e.CMD.poAct('undo');
    assert.strictEqual(e.s.ask.title, 'Undo receiving?');
    assert.ok(e.s.ask.body.includes('returns the order to Sent') && e.s.ask.body.includes('The arrived and damaged counts are cleared'));
    assert.strictEqual(e.s.ask.danger, true);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/6/undo-receive', body: {}, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Undone']);
  });
  it('an undo the shelf cannot give back is refused where you are looking, with the goods named, and stays', async () => {
    const e = mk({ write: () => fail('undo_blocked', { blocking: [{ product_id: 5, name_en: 'Tahini', short: 3 }] }) });
    open(e, DELIVERED);
    e.CMD.poAct('undo'); e.s.ask.run(); await flush();
    const t = text(e.ctx.sheetPO());
    assert.ok(t.includes('Cannot undo this delivery'));
    assert.ok(t.includes('Some of these goods have already left stock, so this delivery cannot be undone — nothing was changed.'));
    assert.ok(t.includes('Tahini') && t.includes('3 short'));
    assert.deepStrictEqual(e.calls.toasts, [], 'a toast never reports a failure');
    e.ctx.sheetPO();
    assert.ok(text(e.ctx.sheetPO()).includes('Cannot undo this delivery'), 'it stays across a repaint');
  });
  it('a price with nothing to go back to is refused the desktop\'s way, with the way out named', async () => {
    const e = mk({ write: () => fail('cost_not_recoverable', { ingredients: [{ ingredient_id: 7, name_en: 'Flour', buy_price: 55 }] }) });
    open(e, ORDERED);
    e.CMD.poAct('draft'); e.s.ask.run(); await flush();
    const t = text(e.ctx.sheetPO());
    assert.ok(t.includes('This order cannot go back yet'));
    assert.ok(t.includes('Flour') && t.includes('¥55'));
    assert.ok(t.includes('Set their price yourself under Materials, then try again.'));
  });
  it('any other failure is the house line, and the order is left as it was', async () => {
    const e = mk({ write: () => fail('boom') });
    open(e, ORDERED);
    e.CMD.poAct('cancel'); e.s.ask.run(); await flush();
    assert.ok(text(e.ctx.sheetPO()).includes('That did not save. Nothing has changed — try again.'));
    assert.strictEqual(e.s.poDetail.status, 'Ordered');
    assert.strictEqual(e.s.poBusy, false);
  });
  it('a refusal belongs to its order: opening another clears it', () => {
    const e = mk();
    e.s.poRefusal = { id: 6, msg: 'x' }; e.s.poLc = { id: 6 }; e.s.poPrint = true;
    e.CMD.openPO(4);
    assert.strictEqual(e.s.poRefusal, null); assert.strictEqual(e.s.poLc, null); assert.strictEqual(e.s.poPrint, false);
  });
  it('in Chinese, the confirm is the desktop\'s pair', () => {
    const e = mk({ lang: 'zh' });
    open(e, ORDERED);
    e.CMD.poAct('cancel');
    assert.strictEqual(e.s.ask.title, '确定取消该采购单？');
    assert.strictEqual(e.s.ask.confirmLabel, '取消采购单');
  });
}

section('6 · Back-order what came up short');
{
  it('offered with the count of short lines, to purchasing:edit only', () => {
    assert.ok(open(mk(), DELIVERED).includes('Back-order 1 short'));
    assert.ok(!open(mk({ caps: ['purchasing:view'] }), DELIVERED).includes('Back-order'));
    assert.ok(!open(mk(), ORDERED).includes('Back-order'), 'nothing short, nothing offered');
  });
  it('sends POST /purchases/:id/backorder and opens the new draft, as the desktop does', async () => {
    const e = mk({ stubOpen: true, write: () => ({ success: true, id: 31, po_number: 'RPO-0031' }) });
    open(e, DELIVERED);
    e.CMD.poBackorder(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/6/backorder', body: {}, method: 'POST' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Back-order created']);
    assert.deepStrictEqual(e.calls.opened, [31]);
  });
  it('nothing outstanding is said in the desktop\'s words', async () => {
    const e = mk({ write: () => fail('nothing_outstanding') });
    open(e, DELIVERED);
    e.CMD.poBackorder(); await flush();
    assert.ok(text(e.ctx.sheetPO()).includes('No short items to back-order'));
  });
}

section('7 · Landed cost');
{
  it('the row shows the extras and the landed total', () => {
    const t = open(mk(), DELIVERED);
    assert.ok(t.includes('True landed cost'));
    assert.ok(t.includes('Freight ¥40 · Tax — · Handling —'));
    // goods = 10×96 + 25×14 + 2×55 = 1,420; + 40 freight
    assert.ok(t.includes('¥1,460'), t);
  });
  it('not on a cancelled order', () => {
    assert.ok(!open(mk(), Object.assign({}, DELIVERED, { status: 'Cancelled' })).includes('True landed cost'));
  });
  it('opens with the saved figures, and typing repaints the total alone', () => {
    const e = mk();
    open(e, DELIVERED);
    e.CMD.poLcOpen();
    assert.deepStrictEqual([e.s.poLc.f, e.s.poLc.t, e.s.poLc.h], ['40', '', '']);
    const tot = { textContent: '' }; e.els.mPoLcTotal = tot;
    const r0 = e.calls.renders;
    e.CMD.poLcInput('t', '12.5');
    assert.strictEqual(tot.textContent, '¥1,472.50');
    assert.strictEqual(e.calls.renders, r0, 'no render while typing');
  });
  it('Save sends PUT /purchases/:id/landed with all three figures', async () => {
    const e = mk({ get: () => DELIVERED });
    open(e, DELIVERED);
    e.CMD.poLcOpen(); e.CMD.poLcInput('f', '45'); e.CMD.poLcInput('h', '8');
    e.CMD.poLcSave();
    assert.ok(text(e.ctx.sheetPO()).includes('Saving…'));
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/6/landed', body: { freight: 45, tax: 0, handling: 8 }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Landed cost saved']);
    assert.strictEqual(e.s.poLc, null);
  });
  it('a failed save says so and keeps what was typed', async () => {
    const e = mk({ write: () => fail('boom') });
    open(e, DELIVERED);
    e.CMD.poLcOpen(); e.CMD.poLcInput('f', '99'); e.CMD.poLcSave(); await flush();
    assert.strictEqual(e.s.poLc.f, '99');
    assert.strictEqual(e.s.poLc.busy, false);
    assert.ok(text(e.ctx.sheetPO()).includes('That did not save'));
  });
  it('without purchasing:edit the figures read, and there is nothing to save', () => {
    const e = mk({ caps: ['purchasing:view'] });
    open(e, DELIVERED);
    e.CMD.poLcOpen();
    const h = e.ctx.sheetPO();
    assert.ok(text(h).includes('Landed total'));
    assert.ok(!h.includes("APP.cmd('poLcSave')") && !h.includes('mPoLc_f'));
    e.CMD.poLcSave();
    assert.strictEqual(e.calls.writes.length, 0);
  });
}

section('8 · The printed order');
{
  it('the sheet carries a print button, to the money key only', () => {
    const e = mk();
    open(e, DELIVERED);
    assert.ok(e.ctx.sheetPO().includes("APP.cmd('poPrint')"));
    e.CMD.poPrint();
    assert.strictEqual(e.s.poPrint, true);
    const denied = mk({ caps: ['purchasing:receive'] });
    open(denied, DELIVERED);
    denied.CMD.poPrint();
    assert.strictEqual(denied.s.poPrint, false);
  });
  it('the document is the desktop\'s, in both languages whatever the phone is set to', () => {
    const e = mk({ lang: 'zh' });
    open(e, DELIVERED);
    const d = e.ctx.poPrintDoc(e.s.poDetail);
    for (const w of ['Purchase Order', '采购单', 'RPO-0006', 'Supplier 供应商', 'Deliver to 收货', 'Status 状态',
      'Delivered 已收货', 'Cost each <span class="cn">单价', 'Total 总计', 'CNY 1,420.00', 'Tahini', '芝麻酱', '公斤', '包', 'Notes 备注', 'Roots']) {
      assert.ok(d.includes(w), 'missing ' + w);
    }
    assert.ok(d.includes('2 家供应商'), 'the supplier line follows the operator, as the desktop\'s does');
  });
  // The document lives inside m.html's script. The render harnesses inject
  // themselves at the FIRST closing body tag, so a literal one in this string
  // blinded every probe suite at once — found the day it was written.
  it('m.html still has exactly one closing body tag', () => {
    assert.strictEqual(M.split('</body>').length - 1, 1);
    assert.strictEqual(M.split('</html>').length - 1, 1);
  });
  it('the print view frames it, and Print hands it to the phone', () => {
    const e = mk();
    open(e, DELIVERED); e.CMD.poPrint();
    const h = e.ctx.sheetPOPrint();
    assert.ok(h.includes('id="mPoPrintFrame"') && h.includes('srcdoc="&lt;!DOCTYPE html&gt;'));
    let printed = 0;
    e.els.mPoPrintFrame = { contentWindow: { focus() {}, print() { printed++; } } };
    e.CMD.poPrintGo();
    assert.strictEqual(printed, 1);
    e.els.mPoPrintFrame = { contentWindow: { focus() {}, print() { throw new Error('no'); } } };
    e.CMD.poPrintGo();
    assert.ok(text(e.ctx.sheetPOPrint()).includes('Print failed'), 'a failure is said in the view, not in a toast');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
