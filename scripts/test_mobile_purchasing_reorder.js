#!/usr/bin/env node
/**
 * §300 P6 — REORDER AND PRICE HISTORY ON THE PHONE.
 *
 *   node scripts/test_mobile_purchasing_reorder.js
 *
 * The desktop's Reorder tab and Price history screen (16-purchasing.js) are
 * the spec. The phone's code is RUN, sliced out of public/m.html. What it pins:
 *
 *   1. Reorder is a Purchasing tab reading GET /reorder, one card per usual
 *      supplier and store: what is low, left against buffer, units suggested,
 *      no money; "Open draft order" is the desktop's puReorderDraft — the
 *      new-order screen at its lines, WRITING NOTHING — and only for whoever
 *      may open that screen;
 *   2. Price history reads GET /products/:spid/suppliers: last paid, average,
 *      range with who is cheapest and dearest, bought since, a sparkline
 *      scaled min-to-max, who sells it — and opens only where money shows,
 *      failing closed, from the new-order sheets and an order's lines.
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
const SRC = [
  slice('const PILL = {', 'function toggle('),
  slice('const CAT_CJK=', 'function catLabels('),
  slice('const rcvPartial=', 'function rcvToReceive(){'),
  slice('function rcvMatched(r){', 'function statusReceiving(){'),
  slice('const poMoney=', '/* ==========================================================================\n   §286 — Suppliers we owe'),
].join('\n');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (v) => JSON.parse(JSON.stringify(v));

const ITEM = (n, o) => Object.assign({ product_id: n, name_en: 'P' + n, sku: 'S' + n, physical_qty: 1, buffer: 5, suggest: 9, store_id: 1 }, o || {});
const REO = () => [
  { supplier: 'Dry Fruit 果干', store_id: 1, store_name: 'Tianhe', items: [ITEM(11, { name_en: 'Sour cream', name_cn: '酸奶油', physical_qty: 2, buffer: 12, suggest: 22 }), ITEM(12, { name_en: 'Feta', physical_qty: 0, buffer: 4, suggest: 8 })] },
  { supplier: null, store_id: 2, store_name: 'Yuexiu', items: [1, 2, 3, 4, 5, 6, 7].map((n) => ITEM(20 + n)) },
];
const HIST = () => ({
  product: { name_en: 'Sour cream', name_cn: '酸奶油', sku: 'SC-1' },
  last: { cost: 128, date: '2026-09-26', supplier: 'Guangzhou Dairy' },
  stats: { order_count: 11, total_qty: 132, avg_cost: 126, min_cost: 119, max_cost: 131, first_date: '2026-06-02' },
  series: [{ date: '2026-06-02', cost: 119 }, { date: '2026-07-10', cost: 131 }, { date: '2026-09-26', cost: 128 }],
  suppliers: [
    { supplier: 'Guangzhou Dairy', last_cost: 128, avg_cost: 126, order_count: 8, min_cost: 124, max_cost: 131 },
    { supplier: 'Metro', last_cost: 119, avg_cost: 120, order_count: 2, min_cost: 119, max_cost: 121 },
  ],
});

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], pushed: [] };
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:edit'] : opts.caps;
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: {
      caps, stores: [{ id: 1, name_en: 'Tianhe' }, { id: 2, name_en: 'Yuexiu' }], stack: [{ route: 'purchasing' }],
      poList: [], posTried: true, poSeg: 'all', poId: null, poDetail: null, poErr: null, poBusy: false,
      poView: 'reorder', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null,
      pw: null, pwc: { stock: {}, stockErr: {}, mats: null, sups: [], cats: null, hist: {}, info: {}, tried: { sups: 1, cats: 1, mats: 1, stores: 1 } }, pwSheet: null,
      pkLines: [], pkErr: null, pkTried: true, pk: null,
      preo: { rows: null, err: null, tried: false }, pph: null,
      pinv: { view: 'suppliers', month: '', q: '', out: null, list: null, err: null, tried: false, seq: 0, open: {}, busy: false, actErr: null, sheet: null },
    },
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => (cur || '¥') + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5, 10) : ''),
    shopToday: () => '2026-09-30', tdWhen: () => 'STAMP', _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {}, footBar: (inner) => inner, catLabel: (v) => String(v || ''),
    featOn: () => false,
    canRoute: (k) => (k === 'newpo' ? !(opts.noNew) && ctx.mCan('purchasing:view') && ctx.mCan('purchasing:edit') : true),
    mCan: (k) => !Array.isArray(ctx.state.caps) || ctx.state.caps.includes(k),
    push: (r) => { calls.pushed.push(r); ctx.state.stack.push({ route: r }); },
    screenSupOwed: () => '', statusSupOwed: () => '', poDeliveries: () => '', loadPoReceipts: () => {},
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { f(); return 1; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    api: async (p) => {
      calls.gets.push(p);
      const r = opts.get ? opts.get(p) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return plain(r);
      if (p === '/reorder') return REO();
      if (/^\/products\/\d+\/suppliers$/.test(p)) return HIST();
      return [];
    },
    apiWrite: async (p, body, method) => { calls.writes.push({ p, body: plain(body), method }); return { success: true }; },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, parseInt, encodeURIComponent, isFinite,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => CMD[n](...a) };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, s: ctx.state };
}
const reorder = async (opts) => { const e = mk(opts); e.ctx.screenPurchasing(); await flush(); return e; };
const screen = (e) => text(e.ctx.screenPurchasing());
const hist = async (opts) => { const e = mk(opts); e.CMD.pphOpen(11); await flush(); return e; };
const sheet = (e) => text(e.ctx.sheetPPH());

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the Reorder tab');
{
  it('it is a Purchasing tab for anyone who can open Purchasing — no money on it', () => {
    const e = mk({ caps: ['purchasing:view'] });
    assert.ok(e.ctx.poViewTabs().some((t) => t[0] === 'reorder'));
  });
  it('it reads GET /reorder, and again each time the tab is opened', async () => {
    const e = await reorder();
    assert.deepStrictEqual(e.calls.gets.filter((g) => g === '/reorder').length, 1);
    e.CMD.poView('orders'); e.CMD.poView('reorder'); e.ctx.screenPurchasing(); await flush();
    assert.deepStrictEqual(e.calls.gets.filter((g) => g === '/reorder').length, 2);
  });
  it('one card per usual supplier and store: how many are low, left against buffer, units suggested', async () => {
    const e = await reorder();
    const t = screen(e);
    for (const w of ['Dry Fruit', 'Tianhe', '2 low', 'Sour cream', '2 left · buffer 12', 'Feta', '0 left · buffer 4', '30 units suggested',
      'No preferred supplier yet', 'Yuexiu', '7 low', '+1 more', '63 units suggested', 'Open draft order']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(!t.includes('果干') && !t.includes('P27'), 'one language; six lines shown then a count');
    assert.ok(!/¥/.test(t), 'no money on the tab');
  });
  it('in Chinese: the desktop\'s pairs', async () => {
    const e = await reorder({ lang: 'zh' });
    const t = screen(e);
    assert.ok(t.includes('果干') && t.includes('酸奶油') && t.includes('2 剩 · 安全 12') && t.includes('件建议') && t.includes('生成草稿单') && t.includes('补货'));
  });
  it('Open draft order opens the new-order screen at its lines, and writes nothing', async () => {
    const e = await reorder();
    e.CMD.preoDraft(0);
    assert.deepStrictEqual(e.calls.pushed, ['newpo']);
    assert.strictEqual(e.calls.writes.length, 0);
    const w = plain(e.s.pw);
    assert.strictEqual(w.step, 2); assert.strictEqual(w.id, null); assert.strictEqual(w.supplier, 'Dry Fruit 果干'); assert.strictEqual(w.store_id, 1);
    assert.deepStrictEqual(w.items[0], { store_product_id: 11, name_en: 'Sour cream', name_cn: '酸奶油', sku: 'S11', qty: 22, unit: 'pcs', cost_per_unit: 0,
      expense_category: '门店进货 Retail stock', purchase_channel: '', supplier_name: 'Dry Fruit 果干', current_stock: 2, note: '' });
    e.CMD.preoDraft(1);
    assert.strictEqual(e.s.pw.supplier, '', 'no preferred supplier: a mixed order');
  });
  it('without the new-order screen there is no button, and no way round it', async () => {
    const e = await reorder({ noNew: true });
    assert.ok(!screen(e).includes('Open draft order'));
    e.CMD.preoDraft(0);
    assert.deepStrictEqual(e.calls.pushed, []);
  });
  it('nothing low, still loading, and a failed read each say so', async () => {
    const none = await reorder({ get: (p) => (p === '/reorder' ? [] : undefined) });
    assert.ok(screen(none).includes('Nothing’s running low') && screen(none).includes('Every product is above its buffer'));
    const slow = mk();
    assert.ok(text(slow.ctx.screenPoReorder()).includes('Loading…'));
    let n = 0;
    const bad = await reorder({ get: (p) => (p === '/reorder' && n++ === 0 ? new Error('HTTP 500') : undefined) });
    assert.ok(screen(bad).includes('Could not load this.') && screen(bad).includes('Try again'));
    bad.CMD.preoRetry(); await flush();
    assert.ok(screen(bad).includes('Open draft order'));
  });
}

section('2 · Price history');
{
  it('reads GET /products/:spid/suppliers, and says it is loading until it lands', async () => {
    const e = mk();
    e.CMD.pphOpen(11);
    assert.ok(sheet(e).includes('Loading…'));
    await flush();
    assert.deepStrictEqual(e.calls.gets, ['/products/11/suppliers']);
  });
  it('the four figures: last paid, average, range with cheapest and dearest, bought since', async () => {
    const e = await hist();
    const t = sheet(e);
    for (const w of ['Price history', 'Sour cream', 'SC-1', 'Last paid ¥128', 'Guangzhou Dairy · D09-26', 'Average ¥126', '11 orders',
      'Range ¥119–¥131', 'low Metro · high Guangzhou Dairy', 'Bought 132', 'since D06-02']) assert.ok(t.includes(w), 'missing ' + w);
  });
  it('a sparkline scaled min-to-max, from the first day to now', async () => {
    const e = await hist();
    const h = e.ctx.sheetPPH();
    const m = /<path d="M([\d.,\s L]+)" fill="none"/.exec(h);
    assert.ok(m, 'a line is drawn');
    const ys = m[1].split(' L').map((p) => Number(p.split(',')[1]));
    assert.strictEqual(ys[0], 192, 'the cheapest sits on the floor');
    assert.strictEqual(ys[1], 8, 'the dearest touches the top');
    assert.ok(text(h).includes('What it has cost you') && text(h).includes('D06-02') && text(h).includes('now ¥128'));
  });
  it('who sells it: the preferred first, last paid, average, times', async () => {
    const e = await hist();
    const t = sheet(e);
    assert.ok(t.includes('Who sells it — 2 suppliers') && /Guangzhou Dairy\s+Preferred/.test(t) && t.includes('Average ¥126 · Times 8') && t.includes('¥119'));
  });
  it('one purchase: no line to draw; none: the desktop\'s empty state', async () => {
    const one = await hist({ get: (p) => { if (!/suppliers$/.test(p)) return undefined; const d = HIST(); d.series = d.series.slice(0, 1); return d; } });
    assert.ok(sheet(one).includes('Need at least two purchases to chart a trend.'));
    const none = await hist({ get: (p) => (/suppliers$/.test(p) ? { product: { name_en: 'X' }, suppliers: [], series: [], stats: {} } : undefined) });
    assert.ok(sheet(none).includes('No purchase history yet') && sheet(none).includes('No supplier history yet.'));
  });
  it('a failed read says so', async () => {
    const e = await hist({ get: () => new Error('HTTP 500') });
    assert.ok(sheet(e).includes('Could not load this.'));
  });
  it('MONEY FAILS CLOSED: without purchasing:view, or before capabilities are known, it does not open', async () => {
    for (const caps of [['purchasing:receive'], null]) {
      const e = mk({ caps });
      e.CMD.pphOpen(11); await flush();
      assert.strictEqual(e.s.pph, null);
      assert.strictEqual(e.calls.gets.length, 0);
      assert.strictEqual(vm.runInContext('pphLink(11)', e.ctx), '');
    }
  });
}

section('3 · where Price history is reached from');
{
  it('the new-order price list, and a product line\'s supplier sheet', async () => {
    const e = mk();
    e.s.pw = e.ctx.pwBlank(); e.s.stack.push({ route: 'newpo' });
    e.s.pwSheet = { kind: 'price', p: { product_id: 11, name_en: 'Sour cream', physical_qty: 2 }, info: { suppliers: [] } };
    assert.ok(e.ctx.sheetPW().includes("APP.cmd('pphOpen',11)"));
    e.s.pw.items = [{ store_product_id: 11, name_en: 'Sour cream', qty: 1 }, { ingredient_id: 7, name_en: 'Flour', qty: 1 }];
    e.s.pwSheet = { kind: 'sup', target: 0, q: '', info: null };
    assert.ok(e.ctx.sheetPW().includes("APP.cmd('pphOpen',11)"));
    e.s.pwSheet = { kind: 'sup', target: 1, q: '', info: null };
    assert.ok(!e.ctx.sheetPW().includes('pphOpen'), 'a material has no retail price history');
  });
  it('an order\'s product lines — not its material lines — and only with money', () => {
    const e = mk();
    assert.ok(e.ctx.poLineRow({ store_product_id: 11, name_en: 'Sour cream', qty: 1 }).includes("APP.cmd('pphOpen',11)"));
    assert.ok(!e.ctx.poLineRow({ ingredient_id: 7, name_en: 'Flour', qty: 1 }).includes('pphOpen'));
    const r = mk({ caps: ['purchasing:receive'] });
    assert.ok(!r.ctx.poLineRow({ store_product_id: 11, name_en: 'Sour cream', qty: 1 }).includes('pphOpen'));
  });
  it('it opens over whatever it came from, and closing lands back there', async () => {
    const e = await hist();
    e.s.poId = 4;
    e.CMD.pphClose();
    assert.strictEqual(e.s.pph, null); assert.strictEqual(e.s.poId, 4);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
