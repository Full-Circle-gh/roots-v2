#!/usr/bin/env node
/**
 * §300 P7 — SUPPLIERS ON THE PHONE: the directory and one supplier's record.
 *
 *   node scripts/test_mobile_purchasing_suppliers.js
 *
 * The desktop's Suppliers tab and supplier page (16-purchasing.js) are the
 * spec. The phone's code is RUN, sliced out of public/m.html, with the real
 * autosave engine (public/tacet-autosave.js) and the real version-history
 * sheet, and every write is asserted on its REQUEST. What it pins:
 *
 *   1. the directory: Active / Disabled (read only when asked for), search,
 *      the Suppliers-we-owe card (money, fails closed), empty / failed states;
 *   2. New supplier: POST /suppliers, name required, name_taken in words;
 *   3. the record: scorecard (money gated), fields that SAVE THEMSELVES with
 *      the desktop's PUT and history flag, Undo, Version history + restore,
 *      the When / How suggestions, disable / enable;
 *   4. the credit switch (§300 overturns §286's desktop-only hold): one PUT,
 *      purchasing:edit, behind a confirm;
 *   5. price list → Price history, paperwork (view / upload ≤10MB / delete),
 *      orders → the order sheet, New order from this supplier;
 *   6. NOT CSV import (§300 item 4).
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
const AUTOSAVE = fs.readFileSync(path.join(ROOT, 'public/tacet-autosave.js'), 'utf8');

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
  slice('const supMoney=', 'const SUP_ACCT_KIND='),
  slice('function liveHistorySheet(', "reg('adjustPoints'"),
].join('\n');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (v) => JSON.parse(JSON.stringify(v));
function fail(code) { const e = new Error(code); e.code = code; e.body = { success: false, error: code }; return e; }

const DIR = () => [
  { id: 3, name: 'Dry Fruit 果干', name_cn: null, contact_name: 'Mei', contact_phone: '138', payment_terms: 'Net 30', products_supplied: 'dates, figs',
    doc_count: 2, po_count: 4, last_po_date: '2026-09-20', rating: 4, is_active: 1 },
  { id: 4, name: 'Guangzhou Dairy', name_cn: '广州乳业', contact_name: 'Jun', is_active: 1, po_count: 0, rating: 0 },
  { id: 5, name: 'Gone Ltd', is_active: 0 },
];
const REC = () => ({
  id: 3, name: 'Dry Fruit 果干', name_cn: null, contact_name: 'Mei', contact_phone: '138', contact_wechat: null, payment_terms: 'Net 30',
  payment_method: null, channel_type: 'taobao', channel_link: 'shop.taobao.com/x', rating: 4, notes: null, products_supplied: 'dates', is_active: 1,
  scorecard: { order_count: 4, spend: 2400, last_date: '2026-09-20', awaiting: 300, awaiting_lines: 2, product_count: 1 },
  price_list: [{ store_product_id: 11, name_en: 'Dates', times: 3, avg_cost: 20, last_cost: 22 }],
  documents: [{ id: 70, kind: 'license', label: 'Licence 2026', filename: 'l.png' }, { id: 71, kind: 'other', filename: 'terms.pdf' }],
  recent_pos: [{ id: 31, po_number: 'RPO-0031', date: '2026-09-20', status: 'Delivered', total: 800 }],
});
const ACCT_OFF = { on_credit: false, owed: 0 };
const ACCT_ON = { on_credit: true, owed: 1200 };
const HISTORY = { success: true, versions: [
  { id: 2, at: '2026-09-30 10:00:00', by: 'ash', changed: ['contact_phone'], snapshot: { name: 'Dry Fruit 果干', contact_phone: '138' } },
  { id: 1, at: '2026-09-29 10:00:00', by: 'ash', isBaseline: true, changed: [], snapshot: { name: 'Dry Fruit 果干', contact_phone: '137', rating: 3 } },
] };

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], pushed: [], cmds: [], opened: [] };
  const timers = [];
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:edit'] : opts.caps;
  let acct = plain(opts.acct || ACCT_OFF);
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: {
      caps, stores: [{ id: 1, name_en: 'Tianhe' }], stack: [{ route: 'purchasing' }],
      poList: [], posTried: true, poSeg: 'all', poId: null, poDetail: null, poErr: null, poBusy: false,
      poView: 'suppliers', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null, askErr: null,
      pw: null, pwc: { stock: {}, stockErr: {}, mats: null, sups: [], cats: null, hist: {}, info: {}, tried: { sups: 1, cats: 1, mats: 1, stores: 1 } }, pwSheet: null,
      pkLines: [], pkErr: null, pkTried: true, pk: null,
      preo: { rows: null, err: null, tried: false }, pph: null,
      psupDir: { rows: null, err: null, tried: false, all: false, seg: 'active', q: '' }, psup: null,
      pinv: { view: 'suppliers', month: '', q: '', out: null, list: null, err: null, tried: false, seq: 0, open: {}, busy: false, actErr: null, sheet: null },
      supOwed: opts.owed || null, supOwedTried: true,
    },
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => (cur || '¥') + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)).toLocaleString('en-US'),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5, 10) : ''),
    shopToday: () => '2026-09-30', tdWhen: (v) => 'W' + String(v).slice(5, 10), _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {}, footBar: (inner, id) => `<div id="${id}">${inner}</div>`, catLabel: (v) => String(v || ''),
    featOn: () => false,
    canRoute: (k) => (k === 'newpo' ? ctx.mCan('purchasing:view') && ctx.mCan('purchasing:edit') : true),
    mCan: (k) => !Array.isArray(ctx.state.caps) || ctx.state.caps.includes(k),
    push: (r) => { calls.pushed.push(r); ctx.state.stack.push({ route: r }); },
    loadSupOwed: () => {},
    screenSupOwed: () => '', statusSupOwed: () => '', poDeliveries: () => '', loadPoReceipts: () => {},
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    window: { open: (u) => calls.opened.push(u) },
    URL: { createObjectURL: () => 'blob:x' }, Blob: class { constructor(p, o) { this.type = o && o.type; } }, Uint8Array,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    FileReader: class { readAsDataURL(f) { this.result = 'data:' + f.type + ';base64,QUJD'; setImmediate(() => this.onload()); } },
    api: async (p) => {
      calls.gets.push(p);
      const r = opts.get ? opts.get(p) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return plain(r);
      if (p === '/suppliers' || p === '/suppliers?all=1') return p.endsWith('all=1') ? DIR() : DIR().filter((s) => s.is_active);
      if (/^\/suppliers\/\d+\/account$/.test(p)) return plain(acct);
      if (/^\/suppliers\/\d+\/documents\/70$/.test(p)) return { id: 70, mime_type: 'image/png', data: 'data:image/png;base64,QUJD' };
      if (/^\/suppliers\/\d+\/documents\/71$/.test(p)) return { id: 71, mime_type: 'application/pdf', data: 'data:application/pdf;base64,QUJD' };
      if (/^\/suppliers\/\d+$/.test(p)) return REC();
      return {};
    },
    apiRaw: async (p) => { calls.gets.push(p); return plain(HISTORY); },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: plain(body), method });
      const r = opts.write ? opts.write(p, body, method, calls.writes.length) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
      if (/\/account$/.test(p)) { acct = { on_credit: !!body.on_credit, owed: body.on_credit ? 1200 : 0 }; return { success: true, data: acct }; }
      if (p === '/suppliers' && method === 'POST') return { success: true, id: 9 };
      return { success: true };
    },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, parseInt, encodeURIComponent, isFinite, queueMicrotask,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => { if (CMD[n] && n !== 'zoomImg' && n !== 'openPO' && n !== 'openSupOwed') return CMD[n](...a); calls.cmds.push([n, ...a]); } };
  vm.createContext(ctx);
  vm.runInContext(AUTOSAVE, ctx);
  ctx.TacetAutosave = ctx.window.TacetAutosave;   // the page's window is where it lands
  vm.runInContext(SRC, ctx);
  const runTimers = async () => { while (timers.length) { timers.shift()(); await flush(); } };
  return { ctx, CMD, calls, s: ctx.state, runTimers };
}
const dir = async (opts) => { const e = mk(opts); e.ctx.screenPurchasing(); await flush(); return e; };
const body = (e) => text(e.ctx.psupDirBody());
const rec = async (opts) => { const e = mk(opts); e.CMD.psupOpen(3); await flush(); return e; };
const page = (e) => text(e.ctx.screenPoSupplier());

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the directory');
{
  it('the Suppliers tab reads the active book: name, what they supply, files, contact, terms, orders, rating', async () => {
    const e = await dir();
    assert.ok(e.calls.gets.includes('/suppliers'));
    const t = body(e);
    for (const w of ['Dry Fruit', 'dates, figs · 2 files on record', 'Mei · 138 · Net 30', '4 Orders', 'D09-20', 'Guangzhou Dairy']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(!t.includes('果干') && !t.includes('Gone Ltd'));
    assert.ok(e.ctx.psupDirBody().includes('★★★★'));
  });
  it('the header offers New supplier, to purchasing:edit; Import CSV is not on the phone', async () => {
    const e = await dir();
    assert.ok(!/Import|CSV/.test(e.ctx.screenPoSuppliers()));
  });
  it('search reaches the name in either language and the contact', async () => {
    const e = await dir();
    e.CMD.psupQ('乳业');
    assert.ok(body(e).includes('Guangzhou Dairy') && !body(e).includes('Dry Fruit'));
    e.CMD.psupQ('mei');
    assert.ok(body(e).includes('Dry Fruit'));
  });
  it('Disabled reads the whole book only when asked for, and shows only the disabled', async () => {
    const e = await dir();
    assert.ok(text(e.ctx.screenPoSuppliers()).includes('Disabled ·'));
    e.CMD.psupSeg('disabled'); await flush();
    assert.ok(e.calls.gets.includes('/suppliers?all=1'));
    assert.ok(body(e).includes('Gone Ltd') && !body(e).includes('Dry Fruit'));
  });
  it('a book with nobody in it teaches; nothing matching says so; a failed read retries', async () => {
    const none = await dir({ get: (p) => (p === '/suppliers' ? [] : undefined) });
    assert.ok(body(none).includes('No suppliers yet') && body(none).includes('Add your first supplier'));
    const e = await dir();
    e.CMD.psupQ('zzz');
    assert.ok(body(e).includes('No suppliers here.'));
    let n = 0;
    const bad = await dir({ get: (p) => (p === '/suppliers' && n++ === 0 ? new Error('HTTP 500') : undefined) });
    assert.ok(body(bad).includes('Could not load this.'));
    bad.CMD.psupRetry(); await flush();
    assert.ok(body(bad).includes('Dry Fruit'));
  });
  it('the Suppliers-we-owe card heads it, its rows open the account sheet — money, failing closed', async () => {
    const owed = { total_owed: 1200, suppliers: [{ supplier_id: 3, name: 'Dry Fruit 果干', owed: 1200 }] };
    const e = await dir({ owed });
    const h = e.ctx.screenPoSuppliers();
    assert.ok(text(h).includes('Suppliers we owe') && text(h).includes('¥1,200.00') && h.includes("APP.cmd('openSupOwed',3)"));
    const c = await dir({ owed, caps: null });
    assert.ok(!text(c.ctx.screenPoSuppliers()).includes('Suppliers we owe'));
  });
}

section('2 · a new supplier');
{
  it('opens an empty form with Save, to purchasing:edit only', async () => {
    const e = mk();
    e.CMD.psupNew();
    assert.deepStrictEqual(e.calls.pushed, ['posupplier']);
    const h = e.ctx.screenPoSupplier();
    assert.ok(text(h).includes('Save supplier') && text(h).includes('The only thing we need to save.'));
    assert.ok(!text(h).includes('Rating'), 'rated after working together, as on the desktop');
    const v = mk({ caps: ['purchasing:view'] });
    v.CMD.psupNew();
    assert.deepStrictEqual(v.calls.pushed, []);
  });
  it('a name is the one thing it needs', async () => {
    const e = mk();
    e.CMD.psupNew(); e.CMD.psupSave();
    assert.strictEqual(e.calls.writes.length, 0);
    assert.ok(page(e).includes('Name is required'));
  });
  it('Save sends POST /suppliers with the desktop\'s body, then opens the record', async () => {
    const e = mk();
    e.CMD.psupNew();
    e.CMD.psupField('name', ' Metro '); e.CMD.psupField('contact_phone', '139'); e.CMD.psupPick('payment_method', 2);
    e.CMD.psupSave(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/suppliers', method: 'POST', body: {
      name: 'Metro', name_cn: null, products_supplied: null, contact_name: null, contact_phone: '139', contact_wechat: null,
      payment_terms: null, payment_method: 'Bank 银行转账', channel_type: null, channel_link: null, rating: 0, notes: null } }]);
    assert.ok(e.calls.gets.includes('/suppliers/9'));
    assert.deepStrictEqual(e.calls.toasts, ['Saved']);
  });
  it('a name already on the book is said in words', async () => {
    const e = mk({ write: () => fail('name_taken') });
    e.CMD.psupNew(); e.CMD.psupField('name', 'Metro'); e.CMD.psupSave(); await flush();
    assert.ok(page(e).includes('Name already exists'));
  });
}

section('3 · the record');
{
  it('reads the supplier and its account; the scorecard; the fields', async () => {
    const e = await rec();
    assert.ok(e.calls.gets.includes('/suppliers/3') && e.calls.gets.includes('/suppliers/3/account'));
    const t = page(e);
    for (const w of ['Orders 4', 'last D09-20', 'Products 1', 'bought before', 'Spend, all time ¥2,400', 'Awaiting 发票 ¥300', '2 lines',
      'Who they are', 'How you pay them', 'Where you order', 'Rating', 'Paperwork', 'Orders with them', 'All changes saved', 'Version history']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(e.ctx.screenPoSupplier().includes('value="Mei"'));
  });
  it('a field SAVES ITSELF: the desktop\'s PUT with its history flag, the whole body', async () => {
    const e = await rec();
    e.CMD.psupField('contact_phone', '139000');
    await e.runTimers();
    assert.strictEqual(e.calls.writes.length, 1);
    const w = e.calls.writes[0];
    assert.strictEqual(w.p, '/suppliers/3?history=supplier.3'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { name: 'Dry Fruit 果干', name_cn: null, products_supplied: 'dates', contact_name: 'Mei', contact_phone: '139000',
      contact_wechat: null, payment_terms: 'Net 30', payment_method: null, channel_type: 'taobao', channel_link: 'shop.taobao.com/x', rating: 4, notes: null });
  });
  it('an emptied name is held, not sent, and says why', async () => {
    const e = await rec();
    e.CMD.psupField('name', '   ');
    await e.runTimers();
    assert.strictEqual(e.calls.writes.length, 0);
    assert.ok(text(e.ctx.psupFootHtml()).includes('Name is required'));
  });
  it('a refused save says so in words', async () => {
    const e = await rec({ write: () => fail('name_taken') });
    e.CMD.psupField('name', 'Metro'); await e.runTimers();
    assert.ok(text(e.ctx.psupFootHtml()).includes('Save failed: Name already exists'));
  });
  it('the When / How suggestions fill the field and save it', async () => {
    const e = await rec();
    e.CMD.psupPick('payment_terms', 1); await e.runTimers();
    assert.strictEqual(e.calls.writes[0].body.payment_terms, 'COD 货到付款');
    assert.ok(text(e.ctx.screenPoSupplier()).includes('Prepay') && text(e.ctx.screenPoSupplier()).includes('Bank transfer'));
  });
  it('Undo puts the visit\'s start back, filed as undo', async () => {
    const e = await rec();
    e.CMD.psupField('contact_name', 'Ling'); await e.runTimers();
    e.CMD.psupUndo(); await e.runTimers();
    const last = e.calls.writes[e.calls.writes.length - 1];
    assert.strictEqual(last.p, '/suppliers/3?history=supplier.3&note=undo');
    assert.strictEqual(last.body.contact_name, 'Mei');
  });
  it('Version history lists what changed by the field\'s name, and a restore is filed as one', async () => {
    const e = await rec();
    e.CMD.psupHistory(); await flush();
    assert.ok(e.calls.gets.includes('/suppliers/3/history'));
    const a = e.s.ask;
    assert.strictEqual(a.title, 'Version history');
    assert.ok(text(a.options[0].label).includes('Current') && text(a.options[0].label).includes('Phone'));
    a.run('1');
    assert.strictEqual(e.s.ask.title, 'Restore this version?');
    e.s.ask.run(); await e.runTimers();
    const last = e.calls.writes[e.calls.writes.length - 1];
    assert.strictEqual(last.p, '/suppliers/3?history=supplier.3&note=restore');
    assert.strictEqual(last.body.contact_phone, '137'); assert.strictEqual(last.body.rating, 3);
  });
  it('Disable / Enable: PUT is_active, then read again', async () => {
    const e = await rec();
    e.CMD.psupToggle(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/suppliers/3', body: { is_active: false }, method: 'PUT' }]);
    assert.strictEqual(e.calls.gets.filter((g) => g === '/suppliers/3').length, 2);
  });
  it('without purchasing:edit: the fields read, and nothing writes', async () => {
    const e = await rec({ caps: ['purchasing:view'] });
    const h = e.ctx.screenPoSupplier();
    assert.ok(/value="Mei" disabled/.test(h));
    assert.ok(!h.includes("APP.cmd('psupToggle')") && !h.includes('psupCredit') && !h.includes("APP.cmd('psupUpload')") && !h.includes('psupDocDelete'));
    e.CMD.psupField('contact_name', 'x'); e.CMD.psupToggle(); e.CMD.psupCredit(1);
    await e.runTimers();
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('MONEY FAILS CLOSED: before capabilities are known, no spend, no price list, no order totals', async () => {
    const e = await rec({ caps: null });
    const t = page(e);
    assert.ok(!/¥/.test(t) && !t.includes('Price list'));
    assert.ok(t.includes('Orders 4') && t.includes('RPO-0031'));
  });
}

section('4 · the credit switch');
{
  it('off: the switch and what it is for; turning it on asks first', async () => {
    const e = await rec();
    assert.ok(page(e).includes('We pay them later (credit)') && page(e).includes('Turn on for a supplier who delivers now'));
    e.CMD.psupCredit(1);
    assert.strictEqual(e.s.ask.title, 'We pay them later (credit)');
    assert.strictEqual(e.s.ask.confirmLabel, 'Turn on');
    assert.strictEqual(e.calls.writes.length, 0);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/suppliers/3/account', body: { on_credit: true }, method: 'PUT' }]);
    assert.ok(page(e).includes('We owe') && e.ctx.screenPoSupplier().includes("APP.cmd('openSupOwed',3)"));
  });
  it('on: turning it off says the entries are kept, and is marked as the dangerous way', async () => {
    const e = await rec({ acct: ACCT_ON });
    e.CMD.psupCredit(0);
    assert.strictEqual(e.s.ask.body, 'The account is hidden and every entry is kept — turning it back on finds it as it was.');
    assert.strictEqual(e.s.ask.confirmLabel, 'Turn off'); assert.strictEqual(e.s.ask.danger, true);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes[0].body, { on_credit: false });
  });
}

section('5 · price list, paperwork, orders, a new order');
{
  it('the price list opens each product\'s price history', async () => {
    const e = await rec();
    const h = e.ctx.screenPoSupplier();
    assert.ok(text(h).includes('Price list — what you’ve bought from them') && text(h).includes('Dates') && text(h).includes('¥22'));
    assert.ok(h.includes("APP.cmd('pphOpen',11)"));
  });
  it('paperwork: an image opens in the viewer, a PDF as a file', async () => {
    const e = await rec();
    const t = page(e);
    assert.ok(t.includes('License') && t.includes('Licence 2026') && t.includes('terms.pdf'));
    e.CMD.psupDocView(70); await flush();
    assert.deepStrictEqual(plain(e.calls.cmds.find((c) => c[0] === 'zoomImg')), ['zoomImg', 'data:image/png;base64,QUJD']);
    e.CMD.psupDocView(71); await flush();
    assert.deepStrictEqual(plain(e.calls.opened), ['blob:x']);
  });
  it('upload: a file is needed, at most 10MB, and goes as the desktop\'s body', async () => {
    const e = await rec();
    e.CMD.psupUpload();
    assert.ok(page(e).includes('Choose a file first'));
    e.CMD.psupDocFile({ files: [{ name: 'big.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 }] });
    e.CMD.psupUpload();
    assert.ok(page(e).includes('Max 10MB'));
    assert.strictEqual(e.calls.writes.length, 0);
    e.CMD.psupDocKind('permit'); e.CMD.psupDocLabel(' Food permit ');
    e.CMD.psupDocFile({ files: [{ name: 'p.png', type: 'image/png', size: 2048 }] });
    e.CMD.psupUpload(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/suppliers/3/documents', method: 'POST', body: {
      kind: 'permit', label: 'Food permit', filename: 'p.png', mime_type: 'image/png', size_bytes: 2048, data: 'data:image/png;base64,QUJD' } }]);
    assert.deepStrictEqual(e.calls.toasts, ['Uploaded']);
  });
  it('delete asks the desktop\'s question, then DELETE', async () => {
    const e = await rec();
    e.CMD.psupDocDelete(70);
    assert.strictEqual(e.s.ask.title, 'Delete this document?'); assert.strictEqual(e.s.ask.confirmLabel, 'Delete document');
    assert.strictEqual(e.calls.writes.length, 0);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/suppliers/3/documents/70', body: {}, method: 'DELETE' }]);
  });
  it('an order opens its sheet; New order starts one from this supplier', async () => {
    const e = await rec();
    assert.ok(e.ctx.screenPoSupplier().includes("APP.cmd('openPO',31)"));
    e.CMD.psupNewOrder();
    assert.ok(e.calls.pushed.includes('newpo'));
    assert.strictEqual(e.s.pw.supplier, 'Dry Fruit 果干'); assert.strictEqual(e.s.pw.step, 1);
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('in Chinese: the desktop\'s pairs', async () => {
    const e = await rec({ lang: 'zh' });
    const t = page(e);
    assert.ok(t.includes('基本信息') && t.includes('付款方式') && t.includes('先货后款') && t.includes('资质文件') && t.includes('营业执照'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
