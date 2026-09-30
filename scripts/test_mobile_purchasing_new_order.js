#!/usr/bin/env node
/**
 * §300 P2 — WRITING A PURCHASE ORDER ON THE PHONE: the desktop's three-step
 * wizard (public/retail-admin/16-purchasing.js), a draft reopened in it, and
 * Order again.
 *
 *   node scripts/test_mobile_purchasing_new_order.js
 *
 * The phone's code is RUN, sliced out of public/m.html into a sandbox, and
 * every write is asserted on its REQUEST — path, method, every body field.
 * What it pins:
 *
 *   1. who and where: the supplier from the book (one language shown, the
 *      whole stored name kept), the store, the date, the note;
 *   2. what to buy: the product / material search, the typed line for what is
 *      in neither catalogue, the supplier price list and the price it brings,
 *      a material's own unit and price, running-low hints, per-line supplier,
 *      the stepper, cost each, sort;
 *   3. the writes: save a new draft (POST), save an opened draft (PUT, lines
 *      keeping their ids), place (save then status Ordered), delete a draft
 *      behind the desktop's confirm — and a Place that half-failed not making
 *      a second draft on the retry;
 *   4. the gates: purchasing:edit for the screen, Place and Delete; the
 *      desktop's refusals before and after the round trip;
 *   5. a draft opens in the wizard; Order again opens it with a received
 *      order's lines and writes nothing.
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
  slice('const PILL = {', 'function pill(kind, label)'),
  slice('const CAT_CJK=', 'function catLabels('),
  slice('const rcvPartial=', 'function rcvToReceive(){'),
  slice('function rcvMatched(r){', 'function statusReceiving(){'),
  slice('const poMoney=', '/* ==========================================================================\n   §286 — Suppliers we owe'),
  slice("reg('openPO',", '/* From the order straight into receiving it.'),
].join('\n');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (v) => JSON.parse(JSON.stringify(v));
function fail(code) { const e = new Error(code); e.code = code; e.body = { success: false, error: code }; return e; }

const STORES = [{ id: 1, name_en: 'Tianhe', name_cn: '天河店' }, { id: 2, name_en: 'Yuexiu', name_cn: '越秀店' }];
const SUPS = [{ id: 1, name: 'Dry Fruit 果干', is_active: 1 }, { id: 2, name: 'Guangzhou Dairy', name_cn: '广州乳业', is_active: 1 },
  { id: 3, name: 'Gone Ltd', is_active: 0 }];
const STOCK = [
  { product_id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', physical_qty: 2, safety_buffer: 12 },
  { product_id: 12, name_en: 'Oat bar', sku: 'OB-1', physical_qty: 40, safety_buffer: 10 },
  { product_id: 13, name_en: 'Feta', sku: 'FE-1', physical_qty: 1, safety_buffer: 0 },
];
const MATS = [{ id: 7, name_en: 'Oat flour', name_cn: '燕麦粉', sku: 'M-7', buy_unit: 'bag', buy_price: 55,
  accounting_category: 'Food 食品', supplier: 'Mill Co', is_active: 1 }];
const HIST = { suppliers: [
  { supplier: 'Guangzhou Dairy', last_cost: 128, avg_cost: 126, order_count: 11, last_date: '2026-09-26' },
  { supplier: 'Metro', last_cost: 119, avg_cost: 120, order_count: 2, last_date: '2026-08-02' }], last: { cost: 124 } };

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], renders: 0, pushed: [], opened: [] };
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:edit', 'purchasing:receive'] : opts.caps;
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: Object.assign({
      caps, stores: plain(STORES), stack: [{ route: 'purchasing' }],
      poList: [], posTried: true, poSeg: 'all', poId: null, poDetail: null, poErr: null, poBusy: false, poMounted: false,
      poView: 'orders', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null, storeName: 'Roots',
      pw: null, pwc: { stock: {}, stockErr: {}, mats: null, sups: null, cats: null, hist: {}, info: {}, tried: {} }, pwSheet: null,
      focus: null,
    }, opts.state || {}),
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => { const num = Number(n || 0); const f = num % 1 ? 2 : 0; return (cur || '¥') + num.toLocaleString('en-US', { minimumFractionDigits: f, maximumFractionDigits: f }); },
    money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)).toLocaleString('en-US'),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5) : ''),
    shopToday: () => '2026-09-30',
    tdWhen: () => 'STAMP', _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {},
    footBar: (inner, id) => `<div id="${id}" class="footbar">${inner}</div>`,
    catLabel: (v) => String(v || ''),
    featOn: (k) => !(opts.off || []).includes(k),
    canRoute: (k) => (opts.routes ? opts.routes.includes(k) : (k === 'newpo' ? ctx.mCan('purchasing:edit') : true)),
    mCan: (k) => !Array.isArray(ctx.state.caps) || ctx.state.caps.includes(k),
    push: (r) => { if (!ctx.canRoute(r)) return; calls.pushed.push(r); ctx.state.stack.push({ route: r }); },
    screenSupOwed: () => '', statusSupOwed: () => '', poDeliveries: () => '', loadPoReceipts: () => {},
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { f(); return 1; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    api: async (p) => {
      calls.gets.push(p);
      const r = opts.get ? opts.get(p) : undefined;
      if (r !== undefined) { if (r instanceof Error) throw r; return plain(r); }
      if (p === '/suppliers') return plain(SUPS);
      if (/^\/stores\/\d+\/stock$/.test(p)) return plain(STOCK);
      if (p === '/materials') return plain(MATS);
      if (p === '/materials/meta/accounting-categories') return ['Food 食品', 'Office 办公'];
      if (p === '/products/11/suppliers') return plain(HIST);
      if (/^\/products\/\d+\/suppliers$/.test(p)) return { suppliers: [] };
      if (p === '/purchases') return [];
      return {};
    },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: plain(body), method });
      const r = opts.write ? opts.write(p, body, method, calls.writes.length) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
      if (p === '/purchases' && method === 'POST') return { success: true, id: 41, po_number: 'RPO-0041' };
      return { success: true };
    },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, encodeURIComponent, isFinite,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => { if (n === 'openPO' && opts.stubOpen) { calls.opened.push(a[0]); return; } return CMD[n](...a); } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, s: ctx.state };
}
async function started(opts) {
  const e = mk(opts);
  e.CMD.pwNew(); await flush();
  return e;
}
const screen = (e) => text(e.ctx.screenNewPO());
const sheet = (e) => text(e.ctx.sheetPW());

// ═══════════════════════════════════════════════════════════════════════════
section('1 · opening a new order');
{
  it('New order starts at step 1, today, the first store, nothing on it', async () => {
    const e = await started();
    assert.deepStrictEqual(e.calls.pushed, ['newpo']);
    const w = e.s.pw;
    assert.strictEqual(w.step, 1); assert.strictEqual(w.date, '2026-09-30'); assert.strictEqual(w.store_id, 1);
    assert.strictEqual(w.id, null); assert.strictEqual(w.items.length, 0);
  });
  it('it reads the supplier book, the store\'s stock, materials and categories — once', async () => {
    const e = await started();
    e.ctx.screenNewPO(); e.ctx.screenNewPO(); await flush();
    for (const p of ['/suppliers', '/stores/1/stock', '/materials', '/materials/meta/accounting-categories']) {
      assert.strictEqual(e.calls.gets.filter((g) => g === p).length, 1, p);
    }
  });
  it('without purchasing:edit there is no new order to start', async () => {
    const e = await started({ caps: ['purchasing:view'] });
    assert.deepStrictEqual(e.calls.pushed, []);
    assert.strictEqual(e.s.pw, null);
  });
  it('step 1 asks the desktop\'s four questions', async () => {
    const e = await started();
    const t = screen(e);
    for (const w of ['From & to', 'Supplier', 'Optional — leave empty for a mixed or one-off buy.', 'Deliver to', 'Order date',
      'Items can arrive on different days.', 'Note', 'Next — what to buy']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(e.ctx.screenNewPO().includes('Yuexiu'), 'every store is offered');
  });
  it('choosing another store reads that store\'s stock', async () => {
    const e = await started();
    e.CMD.pwHead('store_id', '2'); await flush();
    assert.strictEqual(e.s.pw.store_id, 2);
    assert.ok(e.calls.gets.includes('/stores/2/stock'));
  });
  it('a date box cleared by hand keeps the order\'s date', async () => {
    const e = await started();
    e.CMD.pwHead('date', '2026-09-28'); e.CMD.pwHead('date', '');
    assert.strictEqual(e.s.pw.date, '2026-09-28');
  });
}

section('2 · the order\'s supplier comes from the book');
{
  it('the sheet lists active suppliers, one language, and "No supplier"', async () => {
    const e = await started();
    e.CMD.pwSup('order');
    const t = sheet(e);
    assert.ok(t.includes('Dry Fruit') && !t.includes('果干'), t);
    assert.ok(t.includes('Guangzhou Dairy') && t.includes('No supplier'));
    assert.ok(!t.includes('Gone Ltd'), 'a disabled supplier is not offered');
  });
  it('in Chinese it shows the master\'s 中文 name, or the split half', async () => {
    const e = await started({ lang: 'zh' });
    e.CMD.pwSup('order');
    const t = sheet(e);
    assert.ok(t.includes('广州乳业') && t.includes('果干'));
  });
  it('searching in either language narrows it; picking stores the WHOLE name', async () => {
    const e = await started();
    e.CMD.pwSup('order'); e.CMD.pwSupQ('果');
    const rows = plain(e.ctx.pwSupSheetRows().map((r) => r.v));
    assert.deepStrictEqual(rows, ['Dry Fruit 果干']);
    e.CMD.pwSupPick(0);
    assert.strictEqual(e.s.pw.supplier, 'Dry Fruit 果干');
    assert.strictEqual(e.s.pwSheet, null);
    e.CMD.pwSup('order'); e.CMD.pwSupNone();
    assert.strictEqual(e.s.pw.supplier, '');
  });
}

section('3 · what to buy');
{
  const at2 = async (opts) => { const e = await started(opts); e.CMD.pwStep(2); return e; };
  it('a search finds products and materials, and always offers a typed line last', async () => {
    const e = await at2();
    e.CMD.pwQ('oat');
    const h = e.ctx.pwPicksHtml(), t = text(h);
    assert.ok(t.includes('Oat milk') && t.includes('Oat bar') && t.includes('Oat flour') && t.includes('Material'));
    assert.ok(/Add “oat”\s*$/.test(t.trim()), 'the typed row is last');
    e.CMD.pwQ('zzz');
    assert.ok(text(e.ctx.pwPicksHtml()).includes('No match'));
  });
  it('with Production off, no materials', async () => {
    const e = await at2({ off: ['production'] });
    e.CMD.pwQ('oat');
    assert.ok(!text(e.ctx.pwPicksHtml()).includes('Oat flour'));
    assert.ok(!e.calls.gets.includes('/materials'));
    assert.ok(screen(e).includes('Add products') && !screen(e).includes('materials'));
  });
  it('stock still loading says so; stock that failed says so', async () => {
    const slow = await started();
    delete slow.s.pwc.stock[1];            // asked for, not answered yet
    slow.CMD.pwStep(2); slow.CMD.pwQ('oat');
    assert.ok(text(slow.ctx.pwPicksHtml()).includes('Loading…'));
    const bad = await started({ get: (p) => (/stock$/.test(p) ? new Error('HTTP 500') : undefined) });
    bad.CMD.pwStep(2); bad.CMD.pwQ('oat');
    assert.ok(text(bad.ctx.pwPicksHtml()).includes('Could not load this.'));
  });
  it('a product bought before opens its price list: preferred, cheapest, last, average, bought', async () => {
    const e = await at2();
    e.CMD.pwPick(11); await flush();
    assert.strictEqual(e.s.pwSheet.kind, 'price');
    const t = sheet(e);
    for (const w of ['Oat milk', 'OM-1 · stock 2', 'Guangzhou Dairy', 'Preferred', 'Last paid ¥128', 'Average ¥126', 'Bought 11× · D09-26',
      'Metro', '¥119 · cheapest', 'Use ¥128', 'Someone else / type it myself', 'Adds the line — set the supplier and price by hand.']) {
      assert.ok(t.includes(w), 'missing ' + w + ' in ' + t);
    }
  });
  it('Use takes that supplier AND that price onto the line, and says what was paid last', async () => {
    const e = await at2();
    e.CMD.pwPick(11); await flush(); e.CMD.pwUse(1);
    const it0 = e.s.pw.items[0];
    assert.strictEqual(it0.store_product_id, 11); assert.strictEqual(it0.supplier_name, 'Metro');
    assert.strictEqual(it0.cost_per_unit, 119); assert.strictEqual(it0.qty, 1); assert.strictEqual(it0.unit, 'pcs');
    assert.strictEqual(it0.expense_category, '门店进货 Retail stock');
    assert.ok(screen(e).includes('last paid ¥119'));
    e.CMD.pwLine(0, 'cost_per_unit', '130');
    assert.ok(text(e.ctx.pwLineHtml(e.s.pw.items[0], 0)).includes('▲ was ¥119'), 'a dearer price is flagged');
  });
  it('type it myself adds the line with the order\'s supplier and no price', async () => {
    const e = await at2();
    e.s.pw.supplier = 'Dry Fruit 果干';
    e.CMD.pwPick(11); await flush(); e.CMD.pwUse(-1);
    assert.strictEqual(e.s.pw.items[0].supplier_name, 'Dry Fruit 果干');
    assert.strictEqual(e.s.pw.items[0].cost_per_unit, 0);
  });
  it('a product never bought before drops straight on — no invented vendor', async () => {
    const e = await at2();
    e.CMD.pwPick(12); await flush();
    assert.strictEqual(e.s.pwSheet, null);
    assert.strictEqual(e.s.pw.items[0].store_product_id, 12);
  });
  it('picking a product already on the order does not add it twice', async () => {
    const e = await at2();
    e.CMD.pwPick(12); await flush(); e.CMD.pwPick(12); await flush();
    assert.strictEqual(e.s.pw.items.length, 1);
  });
  it('a material brings its own buy unit, price, supplier and category', async () => {
    const e = await at2();
    e.CMD.pwPickMat(7);
    const m = plain(e.s.pw.items[0]);
    assert.strictEqual(m.ingredient_id, 7); assert.strictEqual(m.unit, 'bag'); assert.strictEqual(m.cost_per_unit, 55);
    assert.strictEqual(m.supplier_name, 'Mill Co'); assert.strictEqual(m.expense_category, 'Food 食品');
  });
  it('a typed line splits its name by language, and its unit and category are the buyer\'s', async () => {
    const e = await at2();
    e.CMD.pwQ('Desk chair 办公椅'); e.CMD.pwPickTyped();
    const t = plain(e.s.pw.items[0]);
    assert.strictEqual(t.name_en, 'Desk chair'); assert.strictEqual(t.name_cn, '办公椅');
    assert.strictEqual(t.store_product_id, null); assert.strictEqual(t.ingredient_id, null);
    assert.strictEqual(t.unit, 'pcs'); assert.strictEqual(t.expense_category, '');
    const h = e.ctx.pwLineHtml(e.s.pw.items[0], 0);
    assert.ok(h.includes("'pwLine',0,'unit'") && h.includes('Office 办公'), 'a unit and category select');
    const p = e.ctx.pwLineHtml({ store_product_id: 11, name_en: 'Oat milk', unit: 'pcs', qty: 1, cost_per_unit: 1 }, 1);
    assert.ok(!p.includes("'unit'") && !p.includes('Office'), 'a catalogue line has neither');
    e.CMD.pwQ('Chair'); e.CMD.pwPickTyped();
    assert.strictEqual(e.s.pw.items[1].name_en, 'Chair'); assert.strictEqual(e.s.pw.items[1].name_cn, null);
  });
  it('running low: the furthest under their buffer, not already on the order', async () => {
    const e = await at2();
    let t = text(e.ctx.pwLowHtml());
    assert.ok(t.includes('Running low here') && t.includes('Oat milk') && t.includes('2 left · buffer 12') && t.includes('Feta'));
    assert.ok(!t.includes('Oat bar'), 'a product over its buffer is not suggested');
    e.CMD.pwPick(13); await flush();
    t = text(e.ctx.pwLowHtml());
    assert.ok(!t.includes('Feta'));
    const off = await at2({ off: ['lowStockHints'] });
    assert.strictEqual(off.ctx.pwLowHtml(), '');
  });
  it('typing a quantity or a price repaints the totals in place, not the screen', async () => {
    const e = await at2();
    e.CMD.pwPick(12); await flush();
    const r0 = e.calls.renders;
    e.CMD.pwLine(0, 'qty', '3'); e.CMD.pwLine(0, 'cost_per_unit', '2.5');
    assert.strictEqual(e.calls.renders, r0);
    assert.strictEqual(vm.runInContext('pwTotal(state.pw)', e.ctx), 7.5);
    e.CMD.pwQty(0, 1); e.CMD.pwQty(0, -10);
    assert.strictEqual(e.s.pw.items[0].qty, 0, 'the stepper stops at zero');
  });
  it('sort: supplier A→Z then Z→A, a blank supplier at the bottom both ways', async () => {
    const e = await at2();
    e.s.pw.items = [{ name_en: 'a', supplier_name: 'Zed' }, { name_en: 'b', supplier_name: '' }, { name_en: 'c', supplier_name: 'Abe' }];
    e.CMD.pwSort('supplier');
    assert.deepStrictEqual(plain(e.s.pw.items.map((x) => x.name_en)), ['c', 'a', 'b']);
    e.CMD.pwSort('supplier');
    assert.deepStrictEqual(plain(e.s.pw.items.map((x) => x.name_en)), ['a', 'c', 'b']);
    assert.ok(screen(e).includes('Supplier ↓'));
  });
  it('a line\'s supplier: its price history, the book, and a one-off typed name', async () => {
    const e = await at2();
    e.CMD.pwPick(12); await flush();
    e.s.pw.items.push({ store_product_id: 11, name_en: 'Oat milk', qty: 1, unit: 'pcs', cost_per_unit: 0, supplier_name: '' });
    e.CMD.pwSup(1); await flush();
    let t = sheet(e);
    assert.ok(t.includes('Who are we buying this from?') && t.includes('Use ¥128') && t.includes('Leave it empty and the line follows the order’s supplier.'));
    e.CMD.pwUse(0);
    assert.strictEqual(e.s.pw.items[1].supplier_name, 'Guangzhou Dairy'); assert.strictEqual(e.s.pw.items[1].cost_per_unit, 128);
    e.CMD.pwSup(1); await flush();
    assert.ok(sheet(e).includes('In use'));
    e.CMD.pwSupQ('广州乳业'); e.CMD.pwSupSave();
    assert.strictEqual(e.s.pw.items[1].supplier_name, 'Guangzhou Dairy', 'the 中文 name resolves to the stored one');
    e.CMD.pwSup(0); e.CMD.pwSupQ('Corner shop'); e.CMD.pwSupSave();
    assert.strictEqual(e.s.pw.items[0].supplier_name, 'Corner shop', 'a one-off name is kept as typed');
    e.CMD.pwSup(0); e.CMD.pwSupQ(''); e.CMD.pwSupSave();
    assert.strictEqual(e.s.pw.items[0].supplier_name, '');
  });
  it('an empty order says how to start, and step 3 refuses to place it', async () => {
    const e = await at2();
    assert.ok(screen(e).includes('Nothing yet — search or pick a suggestion above.'));
    e.CMD.pwStep(3);
    const h = e.ctx.screenNewPO();
    assert.ok(text(h).includes('Add at least one product before placing the order.'));
    assert.ok(/disabled onclick="APP.cmd\('pwSave',1\)"/.test(h));
  });
}

section('4 · the writes');
{
  const filled = async (opts) => {
    const e = await started(opts);
    e.s.pw.supplier = 'Dry Fruit 果干'; e.s.pw.notes = 'Back door';
    e.CMD.pwStep(2);
    e.CMD.pwPick(11); await flush(); e.CMD.pwUse(0);
    e.CMD.pwLine(0, 'qty', '12'); e.CMD.pwLine(0, 'note', 'cold chain');
    e.CMD.pwPickMat(7);
    return e;
  };
  // A material line carries no store_product_id and a product line no
  // ingredient_id — undefined, so absent from the JSON, exactly as the
  // desktop's wizBody sends them.
  const LINE0 = { id: null, store_product_id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', qty: 12, unit: 'pcs',
    cost_per_unit: 128, expense_category: '门店进货 Retail stock', purchase_channel: null, supplier_name: 'Guangzhou Dairy', note: 'cold chain' };
  const LINE1 = { id: null, ingredient_id: 7, name_en: 'Oat flour', name_cn: '燕麦粉', sku: 'M-7', qty: 1, unit: 'bag',
    cost_per_unit: 55, expense_category: 'Food 食品', purchase_channel: null, supplier_name: 'Mill Co', note: null };
  it('Save as draft sends POST /purchases with the desktop\'s body, then leaves', async () => {
    const e = await filled();
    e.CMD.pwSave(0);
    assert.ok(screen(e).includes('Saving…'), 'says what it is doing');
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases', method: 'POST', body: {
      date: '2026-09-30', delivery_date: null, supplier: 'Dry Fruit 果干', store_id: 1, notes: 'Back door', items: [LINE0, LINE1] } }]);
    assert.deepStrictEqual(e.calls.toasts, ['Saved as draft']);
    assert.strictEqual(e.s.pw, null);
    assert.ok(!e.s.stack.some((x) => x.route === 'newpo'));
    assert.ok(e.calls.gets.includes('/purchases'), 'the list is read again');
  });
  it('Place order saves, then sends status Ordered, then opens the order', async () => {
    const e = await filled({ stubOpen: true });
    e.CMD.pwStep(3);
    const t = screen(e);
    assert.ok(t.includes('2 products · 13 units · ¥1,591') && t.includes('from Dry Fruit') && t.includes('to Tianhe'), t);
    assert.ok(t.includes('posts to Finance → Expenses by itself.') && t.includes('Nothing touches stock until the goods arrive'));
    e.CMD.pwSave(1); await flush();
    assert.deepStrictEqual(plain(e.calls.writes.map((w) => [w.method, w.p])), [['POST', '/purchases'], ['PUT', '/purchases/41/status']]);
    assert.deepStrictEqual(e.calls.writes[1].body, { status: 'Ordered' });
    assert.deepStrictEqual(e.calls.toasts, ['Order placed']);
    assert.deepStrictEqual(e.calls.opened, [41]);
  });
  it('a Place that saved but could not mark ordered does not make a second draft on the retry', async () => {
    const e = await filled({ stubOpen: true, write: (p, b, m, n) => (n === 2 ? fail('boom') : undefined) });
    e.CMD.pwStep(3); e.CMD.pwSave(1); await flush();
    assert.ok(screen(e).includes('That did not save'), 'the failure is said where you are');
    assert.deepStrictEqual(e.calls.toasts, []);
    assert.strictEqual(e.s.pw.id, 41);
    e.CMD.pwSave(1); await flush();
    assert.deepStrictEqual(plain(e.calls.writes.map((w) => [w.method, w.p])),
      [['POST', '/purchases'], ['PUT', '/purchases/41/status'], ['PUT', '/purchases/41'], ['PUT', '/purchases/41/status']]);
  });
  it('nothing on the order: refused before the round trip', async () => {
    const e = await started();
    e.CMD.pwStep(3); e.CMD.pwSave(0);
    assert.strictEqual(e.calls.writes.length, 0);
    assert.ok(screen(e).includes('Add at least one product'));
  });
  it('a typed line with its name rubbed out: refused before the round trip, in the desktop\'s words', async () => {
    const e = await started();
    e.CMD.pwStep(2); e.CMD.pwQ('Chair'); e.CMD.pwPickTyped(); e.CMD.pwLineName(0, '  ');
    e.CMD.pwSave(0);
    assert.strictEqual(e.calls.writes.length, 0);
    assert.ok(screen(e).includes('Give it a name first.'));
  });
  it('the server\'s refusals are the desktop\'s sentences', async () => {
    const e = await filled({ write: () => fail('store_required') });
    e.CMD.pwSave(0); await flush();
    assert.ok(screen(e).includes('Choose a location first.'));
    assert.ok(e.s.pw, 'the order is still there to fix');
  });
  it('Place order is purchasing:edit\'s alone', async () => {
    const e = await filled();
    e.s.caps = ['purchasing:view'];
    e.CMD.pwStep(3);
    assert.ok(!e.ctx.screenNewPO().includes("APP.cmd('pwSave',1)"));
    e.CMD.pwSave(1);
    assert.strictEqual(e.calls.writes.length, 0);
  });
}

section('5 · a draft opens here, and Order again');
{
  const DRAFT = { id: 30, po_number: 'RPO-0030', status: 'Requested', date: '2026-09-20', supplier: 'Guangzhou Dairy', store_id: 2, notes: 'n',
    items: [{ id: 301, store_product_id: 11, name_en: 'Oat milk', qty: 4, unit: 'pcs', cost_per_unit: 30, supplier_name: 'Metro',
      expense_category: '门店进货 Retail stock', note: 'x' }] };
  it('opening a draft lands in the wizard at step 2, lines keeping their ids', async () => {
    const e = mk({ get: (p) => (p === '/purchases/30' ? DRAFT : undefined) });
    e.CMD.openPO(30); await flush();
    assert.strictEqual(e.s.poId, null, 'not the read-only sheet');
    assert.deepStrictEqual(e.calls.pushed, ['newpo']);
    const w = e.s.pw;
    assert.strictEqual(w.id, 30); assert.strictEqual(w.step, 2); assert.strictEqual(w.store_id, 2);
    assert.strictEqual(w.items[0].id, 301); assert.strictEqual(w.items[0].supplier_name, 'Metro');
  });
  it('saving it PUTs /purchases/:id, lines named by id so an allocation survives', async () => {
    const e = mk({ get: (p) => (p === '/purchases/30' ? DRAFT : undefined) });
    e.CMD.openPO(30); await flush();
    e.CMD.pwSave(0); await flush();
    assert.strictEqual(e.calls.writes[0].method, 'PUT'); assert.strictEqual(e.calls.writes[0].p, '/purchases/30');
    assert.strictEqual(e.calls.writes[0].body.items[0].id, 301);
    assert.strictEqual(e.calls.writes[0].body.store_id, 2);
  });
  it('Delete draft asks the desktop\'s question, then sends DELETE', async () => {
    const e = mk({ get: (p) => (p === '/purchases/30' ? DRAFT : undefined) });
    e.CMD.openPO(30); await flush();
    assert.ok(screen(e).includes('Delete draft'));
    e.CMD.pwDelete();
    assert.strictEqual(e.s.ask.title, 'Delete this draft order?');
    assert.strictEqual(e.s.ask.body, 'It was never placed, so nothing to unwind — this just removes it.');
    assert.strictEqual(e.s.ask.confirmLabel, 'Delete draft'); assert.strictEqual(e.s.ask.danger, true);
    assert.strictEqual(e.calls.writes.length, 0);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(plain(e.calls.writes.map((w) => [w.method, w.p])), [['DELETE', '/purchases/30']]);
    assert.deepStrictEqual(e.calls.toasts, ['Draft deleted']);
    assert.strictEqual(e.s.pw, null);
  });
  it('a draft that has moved on is refused in words', async () => {
    const e = mk({ get: (p) => (p === '/purchases/30' ? DRAFT : undefined), write: () => fail('not_draft') });
    e.CMD.openPO(30); await flush();
    e.CMD.pwDelete(); e.s.ask.run(); await flush();
    assert.ok(screen(e).includes('This order has already moved on.'));
  });
  it('a new order has no Delete draft; without purchasing:edit a draft reads in the sheet', async () => {
    const e = await started();
    e.CMD.pwStep(2);
    assert.ok(!screen(e).includes('Delete draft'));
    const v = mk({ caps: ['purchasing:view'], get: (p) => (p === '/purchases/30' ? DRAFT : undefined) });
    v.CMD.openPO(30); await flush();
    assert.strictEqual(v.s.poId, 30); assert.strictEqual(v.s.pw, null);
  });
  it('Order again (a received order) opens a NEW order with its lines, and writes nothing', async () => {
    const e = mk();
    e.s.poId = 6;
    e.s.poDetail = { id: 6, po_number: 'RPO-0006', status: 'Delivered', supplier: 'Dry Fruit 果干', store_id: 2, notes: 'old',
      items: [{ id: 61, store_product_id: 11, name_en: 'Oat milk', qty: 5, unit: 'pcs', cost_per_unit: 30, supplier_name: 'Metro', note: 'x', qty_received: 5 }] };
    e.CMD.poActs();
    assert.ok(plain(e.s.ask.options.map((o) => o.label)).includes('Order again'));
    e.s.ask.run('again');
    assert.strictEqual(e.calls.writes.length, 0);
    assert.strictEqual(e.s.poId, null);
    const w = plain(e.s.pw);
    assert.strictEqual(w.id, null); assert.strictEqual(w.step, 2); assert.strictEqual(w.date, '2026-09-30');
    assert.strictEqual(w.supplier, 'Dry Fruit 果干'); assert.strictEqual(w.store_id, 2); assert.strictEqual(w.notes, '');
    assert.strictEqual(w.items[0].id, undefined); assert.strictEqual(w.items[0].qty, 5);
    assert.strictEqual(w.items[0].supplier_name, ''); assert.strictEqual(w.items[0].note, '');
  });
}

section('6 · both languages');
{
  it('in Chinese, the steps and the buttons are the desktop\'s pairs', async () => {
    const e = await started({ lang: 'zh' });
    let t = screen(e);
    assert.ok(t.includes('来源与门店') && t.includes('收货门店') && t.includes('下一步 —— 采购内容'));
    e.CMD.pwStep(3);
    t = screen(e);
    assert.ok(t.includes('确认下单') && t.includes('存为草稿'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
