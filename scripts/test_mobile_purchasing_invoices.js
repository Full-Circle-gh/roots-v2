#!/usr/bin/env node
/**
 * §300 P5 — PURCHASING'S INVOICES (发票) ON THE PHONE.
 *
 *   node scripts/test_mobile_purchasing_invoices.js
 *
 * The desktop's Invoices tab (16-purchasing.js, INVOICES) is the spec: the
 * chase by supplier down to the order and the line, the 发票 recorded, the
 * no-invoice marks at both levels, Set supplier for the Unspecified bucket,
 * the add / edit sheet with its allocation, Match to amount, Re-match, the
 * reach chip. The phone's code is RUN, sliced out of public/m.html, and every
 * write is asserted on its REQUEST.
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
function fail(code, msg) { const e = new Error(msg || code); e.code = code; e.body = { success: false, error: code }; return e; }

const UNSPEC = '未指定 Unspecified';
const L = (o) => Object.assign({ qty: 1, cost_per_unit: 10, status: 'awaiting', covered: 0, credit_due: 0, line_no_invoice: false, po_no_invoice: false }, o);
const OUT = () => ({
  totals: { total: 2000, fully_invoiced: 900, partially_invoiced: 300, awaiting: 700, no_invoice_expected: 100, credit_due: 96, line_count: 5 },
  recorded_elsewhere: { amount: 480, by_reason: { superseded: 480 }, orders: [{ po_id: 12, po_number: 'PO-0012', copy_po_number: 'RPO-0033', amount: 480 }] },
  groups: [
    { supplier: 'Guangzhou Dairy', supplier_cn: '广州乳业', total: 1500, fully_invoiced: 900, partially_invoiced: 300, awaiting: 200, no_invoice_expected: 100,
      credit_due: 96, line_count: 3, po_numbers: ['RPO-0031', 'RPO-0029'],
      reach: { supplier_id: 3, type: 'phone', link: '138 0000 1111', has_qr: false },
      lines: [
        L({ line_id: 1, po_id: 31, po_number: 'RPO-0031', date: '2026-09-26', name_en: 'Sour cream', sku: 'SC-1', amount: 500, outstanding: 200, covered: 300, status: 'partially_invoiced', supersedes_po_number: 'PO-0012', supersedes_invoiced: 480 }),
        L({ line_id: 2, po_id: 31, po_number: 'RPO-0031', date: '2026-09-26', name_en: 'Feta', amount: 100, outstanding: 0, status: 'no_invoice_expected', line_no_invoice: true }),
        L({ line_id: 3, po_id: 29, po_number: 'RPO-0029', date: '2026-09-12', name_en: 'Yoghurt', amount: 900, outstanding: 0, covered: 996, status: 'fully_invoiced', credit_due: 96 }),
      ] },
    { supplier: UNSPEC, supplier_cn: null, total: 500, fully_invoiced: 0, partially_invoiced: 0, awaiting: 500, no_invoice_expected: 0, credit_due: 0,
      line_count: 2, po_numbers: ['RPO-0040'], reach: null,
      lines: [
        L({ line_id: 7, po_id: 40, po_number: 'RPO-0040', date: '2026-09-20', name_en: 'Gloves', amount: 200, outstanding: 200 }),
        L({ line_id: 8, po_id: 40, po_number: 'RPO-0040', date: '2026-09-20', name_en: 'Tape', amount: 300, outstanding: 300 }),
      ] },
  ],
});
const LIST = () => [
  { id: 5, supplier: 'Guangzhou Dairy', supplier_cn: '广州乳业', invoice_number: '44019283', date: '2026-09-27', amount: 1200, unallocated: 0, pos: [{ po_number: 'RPO-0029' }] },
  { id: 6, supplier: 'Guangzhou Dairy', invoice_number: null, date: '2026-08-02', amount: 500, unallocated: 250, pos: [] },
];
const INV5 = { id: 5, supplier: 'Guangzhou Dairy', invoice_number: '44019283', date: '2026-09-27', amount: 1200, notes: 'n', due_date: '2026-10-27',
  lines: [{ line_id: 3, allocated_amount: 900, name_en: 'Yoghurt', qty: 9, cost_per_unit: 100, po_number: 'RPO-0029', po_date: '2026-09-12' },
          { line_id: 1, allocated_amount: 300, name_en: 'Sour cream', qty: 5, cost_per_unit: 100, po_number: 'RPO-0031', po_date: '2026-09-26' }] };

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], renders: 0 };
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:edit', 'purchasing:invoices'] : opts.caps;
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: {
      caps, stores: [], stack: [{ route: 'purchasing' }],
      poList: [], posTried: true, poSeg: 'all', poId: null, poDetail: null, poErr: null, poBusy: false,
      poView: 'invoices', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null,
      pw: null, pwc: { stock: {}, stockErr: {}, mats: null, sups: null, cats: null, hist: {}, info: {}, tried: {} }, pwSheet: null,
      pkLines: [], pkErr: null, pkTried: true, pk: null,
      pinv: { view: 'suppliers', month: '', q: '', out: null, list: null, err: null, tried: false, seq: 0, open: {}, busy: false, actErr: null, sheet: null },
    },
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => (cur || '¥') + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5, 10) : ''),
    shopToday: () => '2026-09-30', tdWhen: (v, k) => (k === 'month' ? 'M' + String(v).slice(0, 7) : 'STAMP'), _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {}, footBar: (inner) => inner, catLabel: (v) => String(v || ''),
    featOn: () => false, canRoute: () => true,
    mCan: (k) => Array.isArray(ctx.state.caps) ? ctx.state.caps.includes(k) : k !== 'purchasing:invoices',
    push: () => {}, screenSupOwed: () => '', statusSupOwed: () => '', poDeliveries: () => '', loadPoReceipts: () => {},
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { f(); return 1; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    api: async (p) => {
      calls.gets.push(p);
      const r = opts.get ? opts.get(p) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return plain(r);
      if (p.startsWith('/purchasing/invoices/outstanding')) return OUT();
      if (p.startsWith('/purchasing/invoices/rematch/')) return { copy: { id: 33 }, movable: 480, moves: [{ from: { name_en: 'Milk' }, to: { name_en: 'Milk' }, basis: 'sku', amount: 480 }], unmatched: [] };
      if (p === '/purchasing/invoices/5') return plain(INV5);
      if (p.startsWith('/purchasing/invoices')) return LIST();
      if (p === '/suppliers') return [{ name: 'Guangzhou Dairy', name_cn: '广州乳业', is_active: 1 }, { name: 'Metro', is_active: 1 }];
      if (/channel-qr$/.test(p)) return { name: 'Dry Fruit', qr: 'data:image/png;base64,AAA' };
      return {};
    },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: plain(body), method });
      const r = opts.write ? opts.write(p, body, method, calls.writes.length) : undefined;
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
      if (/rematch/.test(p)) return { success: true, data: { moved: 1, amount: 480 } };
      return { success: true, id: 9 };
    },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, parseInt, encodeURIComponent, isFinite,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => CMD[n](...a) };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, s: ctx.state, v: ctx.state.pinv };
}
const loaded = async (opts) => { const e = mk(opts); e.ctx.screenPurchasing(); await flush(); return e; };
const body = (e) => text(e.ctx.pinvBodyHtml());
const sheet = (e) => text(e.ctx.sheetPinv());

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the tab, and who sees it');
{
  it('Invoices joins the strip for purchasing:invoices with purchasing:view', () => {
    const e = mk();
    assert.deepStrictEqual(plain(e.ctx.poViewTabs().map((t) => t[0])), ['orders', 'suppliers', 'invoices', 'reorder']);
  });
  it('without purchasing:invoices, or before capabilities are known, there is no tab and no screen', () => {
    for (const caps of [['purchasing:view', 'purchasing:edit'], null]) {
      const e = mk({ caps });
      assert.ok(!e.ctx.poViewTabs().some((t) => t[0] === 'invoices'));
      assert.ok(!e.ctx.screenPurchasing().includes('mPinvBody'), 'the orders list shows instead');
      e.CMD.pinvNew(-1);
      assert.strictEqual(e.v.sheet, null);
    }
  });
  it('it reads the chase and the recorded 发票 together, with month and search', async () => {
    const e = await loaded();
    assert.ok(e.calls.gets.includes('/purchasing/invoices/outstanding') && e.calls.gets.includes('/purchasing/invoices'));
    e.CMD.pinvMonth('2026-09'); await flush();
    e.CMD.pinvQ('dairy'); await flush();
    assert.ok(e.calls.gets.includes('/purchasing/invoices/outstanding?month=2026-09&q=dairy'));
    assert.ok(e.calls.gets.includes('/purchasing/invoices?month=2026-09&q=dairy'));
  });
  it('a failed read says so, and Try again reads again', async () => {
    let n = 0;
    const e = await loaded({ get: (p) => (p.startsWith('/purchasing/invoices') && n++ < 2 ? new Error('HTTP 500') : undefined) });
    assert.ok(body(e).includes('Could not load this.') && body(e).includes('Try again'));
    e.CMD.pinvRetry(); await flush();
    assert.ok(body(e).includes('Guangzhou Dairy'));
  });
  it('nothing at all: the desktop\'s empty state and Add invoice', async () => {
    const e = await loaded({ get: (p) => (p.startsWith('/purchasing/invoices/outstanding') ? { groups: [], totals: {} } : p.startsWith('/purchasing/invoices') ? [] : undefined) });
    assert.ok(body(e).includes('No invoices yet') && body(e).includes('Add invoice'));
  });
}

section('2 · the figures and the strips');
{
  it('the five figures', async () => {
    const e = await loaded();
    const t = body(e);
    for (const w of ['Total purchases ¥2,000', '5 lines', 'Fully invoiced ¥900', 'Partial ¥300', 'Awaiting ¥700', 'chase these', 'No invoice ¥100']) assert.ok(t.includes(w), 'missing ' + w);
  });
  it('money recorded against a replaced order is named, with Re-match', async () => {
    const e = await loaded();
    const t = body(e);
    assert.ok(t.includes('Recorded, not counted above: ¥480') && t.includes('the orders they were recorded against have been replaced by copies'));
    assert.ok(t.includes('PO-0012 → RPO-0033 ¥480') && t.includes('Re-match…'));
  });
  it('a return after invoicing: credit due, and what to do about it', async () => {
    const e = await loaded();
    assert.ok(body(e).includes('Returned after invoicing: credit due ¥96 — ask the supplier for a credit note'));
  });
}

section('3 · by supplier, down to the order and the line');
{
  it('each supplier: one language, lines and orders, what is still to chase, the reach chip', async () => {
    const e = await loaded();
    const h = e.ctx.pinvBodyHtml(), t = text(h);
    assert.ok(t.includes('Guangzhou Dairy') && t.includes('3 lines · 2 orders · Awaiting ¥500') && t.includes('Unspecified'));
    assert.ok(!t.includes('未指定'), 'the Unspecified bucket in one language');
    assert.ok(h.includes('href="tel:13800001111"') && t.includes('Phone →'));
  });
  it('in Chinese, the master\'s 中文 name', async () => {
    const e = await loaded({ lang: 'zh' });
    assert.ok(body(e).includes('广州乳业') && body(e).includes('未指定'));
  });
  it('a chip for a link opens it; javascript: is never a link', () => {
    const e = mk();
    assert.ok(e.ctx.pinvReachHtml({ type: 'taobao', link: 'shop.taobao.com/x' }).includes('href="https://shop.taobao.com/x"'));
    assert.ok(!e.ctx.pinvReachHtml({ type: 'website', link: 'javascript:alert(1)' }).includes('href'));
    assert.ok(e.ctx.pinvReachHtml({ type: 'wechat', supplier_id: 3, has_qr: true }).includes("APP.cmd('pinvQr',3)"));
  });
  it('opening a group shows its orders and lines, with the order\'s own facts', async () => {
    const e = await loaded();
    e.CMD.pinvToggle(0);
    const t = body(e);
    for (const w of ['RPO-0031', 'D09-26', 'replaces PO-0012 · already invoiced ¥480', 'Sour cream', 'SC-1', 'Partial', 'invoiced ¥300',
      'Yoghurt', 'credit due ¥96', 'Mark whole order as no-invoice', 'Mark as no-invoice', 'Restore to awaiting']) assert.ok(t.includes(w), 'missing ' + w);
  });
  it('a line covered by the order\'s mark says so rather than offering a toggle', async () => {
    const e = await loaded({ get: (p) => { if (!p.startsWith('/purchasing/invoices/outstanding')) return undefined;
      const o = OUT(); o.groups[0].lines.forEach((l) => { if (l.po_id === 31) l.po_no_invoice = true; }); return o; } });
    e.CMD.pinvToggle(0);
    const t = body(e);
    assert.ok(t.includes('Restore whole order to awaiting') && t.includes('by whole-order mark'));
  });
  it('a search opens every group', async () => {
    const e = await loaded();
    e.v.q = 'feta';
    assert.ok(body(e).includes('RPO-0029') && body(e).includes('Tape'));
  });
  it('Unspecified: Set supplier for the bucket, the order and the line, and Add invoice', async () => {
    const e = await loaded();
    e.CMD.pinvToggle(1);
    const h = e.ctx.pinvBodyHtml();
    assert.ok(h.includes("APP.cmd('pinvAssign','')") && h.includes("APP.cmd('pinvAssign','7,8')") && h.includes("APP.cmd('pinvAssign','7')"));
    assert.ok(h.includes("APP.cmd('pinvNew',1)"));
  });
}

section('4 · the no-invoice marks');
{
  it('whole order: PUT /purchasing/po/:id/no-invoice, then read again', async () => {
    const e = await loaded();
    e.CMD.pinvMarkPo(31, 1); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/po/31/no-invoice', body: { no_invoice_expected: true }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Whole order marked as no-invoice']);
    assert.strictEqual(e.calls.gets.filter((g) => g === '/purchasing/invoices/outstanding').length, 2);
  });
  it('restoring an order says how many lines keep their own mark', async () => {
    const e = await loaded({ write: () => ({ success: true, lines_still_marked: 2 }) });
    e.CMD.pinvMarkPo(31, 0); await flush();
    assert.deepStrictEqual(e.calls.writes[0].body, { no_invoice_expected: false });
    assert.deepStrictEqual(e.calls.toasts, ['Order restored — 2 lines keep their own no-invoice mark']);
  });
  it('one line: PUT /purchasing/po/:id/line/:lineId/no-invoice', async () => {
    const e = await loaded();
    e.CMD.pinvMarkLine(31, 2, 0); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/po/31/line/2/no-invoice', body: { no_invoice_expected: false }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Line restored to awaiting']);
  });
  it('a failure is said on the screen and stays; one mark at a time', async () => {
    const e = await loaded({ write: () => fail('boom') });
    e.CMD.pinvMarkLine(31, 1, 1); e.CMD.pinvMarkLine(31, 2, 1); await flush();
    assert.strictEqual(e.calls.writes.length, 1);
    assert.ok(body(e).includes('That did not save.'));
    assert.deepStrictEqual(e.calls.toasts, []);
  });
}

section('5 · recorded 发票: edit and delete');
{
  it('the ledger: supplier, number, day, orders, amount, and what does not add up', async () => {
    const e = await loaded();
    e.CMD.pinvView('recorded');
    const t = body(e);
    assert.ok(t.includes('44019283') && t.includes('D09-27 · RPO-0029') && t.includes('¥1,200'));
    assert.ok(t.includes('¥250 unallocated'));
  });
  it('Delete asks the desktop\'s question, then DELETE', async () => {
    const e = await loaded();
    e.CMD.pinvDelete(6);
    assert.strictEqual(e.s.ask.title, 'Delete this invoice?');
    assert.strictEqual(e.s.ask.body, 'The lines it covers go back to awaiting an invoice.');
    assert.strictEqual(e.s.ask.confirmLabel, 'Delete invoice'); assert.strictEqual(e.s.ask.danger, true);
    assert.strictEqual(e.calls.writes.length, 0);
    e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/invoices/6', body: {}, method: 'DELETE' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Deleted']);
  });
  it('Edit loads the 发票 with its own lines ticked, and saves with PUT, the due date handed back', async () => {
    const e = await loaded();
    e.CMD.pinvEdit(5); await flush();
    const d = e.v.sheet;
    assert.strictEqual(d.kind, 'inv'); assert.strictEqual(d.id, 5);
    assert.deepStrictEqual(plain(d.alloc), { 1: 300, 3: 900 });
    const t = sheet(e);
    assert.ok(t.includes('Edit invoice') && t.includes('Yoghurt') && t.includes('Save changes'));
    assert.ok(t.includes('Allocated ¥1,200') && t.includes('nothing left over'));
    e.CMD.pinvSave(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/invoices/5', method: 'PUT', body: {
      supplier: 'Guangzhou Dairy', invoice_number: '44019283', amount: 1200, date: '2026-09-27', due_date: '2026-10-27', notes: 'n',
      links: [{ line_id: 1, allocated_amount: 300 }, { line_id: 3, allocated_amount: 900 }] } }]);
    assert.deepStrictEqual(e.calls.toasts, ['Saved']);
  });
}

section('6 · adding a 发票');
{
  it('from a supplier row: that supplier, its open lines (never the no-invoice ones)', async () => {
    const e = await loaded();
    e.CMD.pinvNew(0);
    const d = e.v.sheet;
    assert.strictEqual(d.supplier, 'Guangzhou Dairy'); assert.strictEqual(d.date, '2026-09-30');
    const t = sheet(e);
    assert.ok(t.includes('Add invoice') && t.includes('Sour cream') && t.includes('¥200 open') && !t.includes('Feta'));
  });
  it('tick takes what is open; the badge follows typing without a repaint', async () => {
    const e = await loaded();
    e.CMD.pinvNew(0);
    e.CMD.pinvTick(1);
    assert.deepStrictEqual(plain(e.v.sheet.alloc), { 1: 200 });
    const r0 = e.calls.renders;
    e.CMD.pinvField('amount', '250'); e.CMD.pinvAlloc(1, '150');
    assert.strictEqual(e.calls.renders, r0);
    assert.ok(text(e.ctx.pinvBadge()).includes('¥100 unallocated'));
    e.CMD.pinvAlloc(1, '300');
    assert.ok(text(e.ctx.pinvBadge()).includes('¥50 over the invoice'));
  });
  it('Match to amount pours the amount down the open lines, each taking what it has open', async () => {
    const e = await loaded();
    e.CMD.pinvNew(1);
    assert.strictEqual(e.v.sheet.supplier, '', 'the Unspecified bucket is a one-off: no supplier');
    e.CMD.pinvField('amount', '350'); e.CMD.pinvMatch();
    assert.deepStrictEqual(plain(e.v.sheet.alloc), { 7: 200, 8: 150 });
  });
  it('changing the supplier clears the allocation — the lines on offer are that supplier\'s', async () => {
    const e = await loaded();
    e.CMD.pinvNew(0); e.CMD.pinvTick(1);
    e.CMD.pinvField('supplier', 'Metro');
    assert.deepStrictEqual(plain(e.v.sheet.alloc), {});
    assert.ok(sheet(e).includes('No open lines for this supplier'));
  });
  it('the supplier picker offers the chase\'s names and the active book, one language', async () => {
    const e = await loaded({ lang: 'zh' });
    e.CMD.pinvNew(-1);
    const h = e.ctx.sheetPinv();
    assert.ok(h.includes('value="Guangzhou Dairy"') && h.includes('>广州乳业<') && h.includes('value="Metro"'));
    assert.ok(!h.includes(`value="${UNSPEC}"`));
  });
  it('no amount: refused before the round trip', async () => {
    const e = await loaded();
    e.CMD.pinvNew(0); e.CMD.pinvSave();
    assert.strictEqual(e.calls.writes.length, 0);
    assert.ok(sheet(e).includes('Enter the invoice amount'));
  });
  it('Save sends POST /purchasing/invoices with the desktop\'s body', async () => {
    const e = await loaded();
    e.CMD.pinvNew(0);
    e.CMD.pinvField('invoice_number', '777'); e.CMD.pinvField('amount', '200'); e.CMD.pinvTick(1);
    e.CMD.pinvSave();
    assert.ok(sheet(e).includes('Saving…'));
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/invoices', method: 'POST', body: {
      supplier: 'Guangzhou Dairy', invoice_number: '777', amount: 200, date: '2026-09-30', due_date: null, notes: null,
      links: [{ line_id: 1, allocated_amount: 200 }] } }]);
    assert.deepStrictEqual(e.calls.toasts, ['Invoice recorded']);
    assert.strictEqual(e.v.sheet, null);
  });
  it('a line over its headroom is refused in words, and the form stays', async () => {
    const e = await loaded({ write: () => fail(undefined, 'line 1 over-allocated') });
    e.CMD.pinvNew(0); e.CMD.pinvField('amount', '500'); e.CMD.pinvTick(1); e.CMD.pinvAlloc(1, '500');
    e.CMD.pinvSave(); await flush();
    assert.ok(sheet(e).includes('That is more than the line has left to invoice.'));
    assert.strictEqual(e.v.sheet.busy, false);
  });
}

section('7 · Set supplier for the Unspecified bucket');
{
  it('opens on the lines pointed at, all ticked; Tick all toggles', async () => {
    const e = await loaded();
    e.CMD.pinvAssign('7');
    assert.deepStrictEqual(plain(e.v.sheet.picked), [7]);
    e.CMD.pinvAssign('');
    assert.deepStrictEqual(plain(e.v.sheet.picked), [7, 8]);
    e.CMD.pinvAssignAll();
    assert.deepStrictEqual(plain(e.v.sheet.picked), []);
    assert.ok(sheet(e).includes('Nothing ticked') && sheet(e).includes('Tick all'));
  });
  it('no supplier, or nothing ticked: said, nothing sent', async () => {
    const e = await loaded();
    e.CMD.pinvAssign(''); e.CMD.pinvAssignSave();
    assert.ok(sheet(e).includes('Choose a supplier'));
    e.CMD.pinvAssignSup('Metro'); e.CMD.pinvAssignAll(); e.CMD.pinvAssignSave();
    assert.ok(sheet(e).includes('Tick at least one line'));
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('Save sends PUT /purchasing/lines/supplier and opens the group they moved into', async () => {
    const e = await loaded();
    e.CMD.pinvAssign(''); e.CMD.pinvAssignSup('Metro'); e.CMD.pinvAssignTick(8);
    e.CMD.pinvAssignSave(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/lines/supplier', body: { supplier: 'Metro', line_ids: [7] }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Supplier set']);
    assert.strictEqual(e.v.open.Metro, true);
  });
  it('a supplier the book does not hold: the desktop\'s sentence', async () => {
    const e = await loaded({ write: () => fail('unknown_supplier') });
    e.CMD.pinvAssign(''); e.CMD.pinvAssignSup('Metro'); e.CMD.pinvAssignSave(); await flush();
    assert.ok(sheet(e).includes('That supplier isn’t on file — add them on the Suppliers tab first.'));
  });
}

section('8 · Re-match, and a WeChat QR');
{
  it('shows the pairing before anything moves, ticked only where the whole order pairs', async () => {
    const e = await loaded();
    e.CMD.pinvRematchOpen(); await flush();
    assert.ok(e.calls.gets.includes('/purchasing/invoices/rematch/12'));
    assert.deepStrictEqual(plain(e.v.sheet.picked), [12]);
    e.CMD.pinvRematchLines(12);
    const t = sheet(e);
    assert.ok(t.includes('PO-0012 → RPO-0033 · ¥480') && t.includes('1 of 1 lines pair') && t.includes('Milk → Milk') && t.includes('matched on SKU'));
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('Move posts each order and says what moved', async () => {
    const e = await loaded();
    e.CMD.pinvRematchOpen(); await flush();
    e.CMD.pinvRematchSave(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/invoices/rematch/12', body: {}, method: 'POST' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Moved ¥480 across 1 line onto the replacing orders']);
    assert.strictEqual(e.v.sheet, null);
  });
  it('an order that could not be moved is named, and the sheet stays', async () => {
    const e = await loaded({ write: () => fail('not_superseded') });
    e.CMD.pinvRematchOpen(); await flush();
    e.CMD.pinvRematchSave(); await flush();
    assert.ok(sheet(e).includes('these could not be moved: PO-0012'));
    assert.deepStrictEqual(e.calls.toasts, []);
  });
  it('a WeChat QR opens in a sheet; none on file says so', async () => {
    const e = await loaded();
    e.CMD.pinvQr(3); await flush();
    assert.ok(e.calls.gets.includes('/suppliers/3/channel-qr'));
    assert.ok(e.ctx.sheetPinv().includes('src="data:image/png;base64,AAA"') && sheet(e).includes('Scan to reach them'));
    const n = await loaded({ get: (p) => (/channel-qr$/.test(p) ? new Error('HTTP 404') : undefined) });
    n.CMD.pinvQr(3); await flush();
    assert.ok(sheet(n).includes('No QR on file'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
