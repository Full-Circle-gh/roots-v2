#!/usr/bin/env node
/**
 * §300 step F4 — ISSUING A 发票 FROM THE PHONE'S ORDER SHEET.
 *
 *   node scripts/test_mobile_orders_fapiao.js
 *
 * The phone's order sheet used to show the customer's fapiao request and say
 * "Issuing it is a desktop job." It issues now, the way the desktop's block does
 * (renderInvoiceBlock and its four writes, public/retail-admin/07-content-billing.js).
 * The code is RUN, sliced out of public/m.html into a sandbox with a fake server
 * whose answers the test releases one at a time. No browser — fast shard.
 *
 * What it pins:
 *   1. who may issue — invoices:manage AND orders:edit; everyone else reads;
 *   2. Copy for accounting — the desktop's payload, to the real clipboard;
 *   3. the upload — PDF or image, 10 MB, POST /invoice-file, the link filled;
 *   4. Mark issued — a link or a number first, then the desktop's body;
 *   5. un-issue — asked first, then the desktop's body;
 *   6. every string is the desktop's, bar the one declared.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const BILL = fs.readFileSync(path.join(ROOT, 'public/retail-admin/07-content-billing.js'), 'utf8');

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
const SRC = [
  slice('const PILL = {', 'function toggle('),
  slice("reg('askRun', key=>{", "reg('copyWaybill'"),
  slice("reg('closeAsk',", '/* The live sheet'),
  slice('function sheetAsk(){', '/* A photo, full-screen.'),
  slice('function orderErrorText(e){', '/* printer.* is private config'),
  slice('/* The fapiao the customer asked for', "/* The sheet's chrome around a read"),
  slice('const finExact=', '\n'),
  slice('const MCAN_MONEY_ONLY=', 'function canRoute('),
].join('\n');

/* The mapping, run on its own: the one statement mapDetail uses to build
   `base.invoice` from the server's row. */
const MAP = slice('base.invoice=Number(o.needs_invoice)?{', '\n  // [en, zh] pair like the rest');
const mapInvoice = new Function('o', `const base={}; ${MAP}; return base.invoice;`);

const ORDER = () => ({ id: 'R-142', _id: 142, invoice: mapInvoice({
  id: 142, order_no: '20260930-0142', needs_invoice: 1, invoice_status: 'requested', invoice_type: 'company',
  invoice_title: 'Guangzhou Bright Tech Co.', invoice_tax_id: '91440101MA59XXXX0Q', invoice_email: 'finance@bright.cn',
  subtotal: 248, total: 268, shipping_fee: 20 }) });

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], copied: [], refreshed: 0 };
  const CMD = {};
  const order = opts.order || ORDER();
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: { caps: opts.caps === undefined ? ['invoices:manage', 'orders:edit'] : opts.caps,
      ask: null, askErr: null, inv: null, orderBusy: null, orderErr: null },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    currentOrder: () => order,
    copyText: (t) => calls.copied.push(t),
    showToast: (m) => calls.toasts.push(String(m)),
    refreshOrders: () => { calls.refreshed++; },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    createImageBitmap: async () => { throw new Error('no canvas in node'); },
    FileReader: class { readAsDataURL(f) { this.result = 'data:' + f.type + ';base64,QUJD'; setImmediate(() => this.onload()); } },
    document: { createElement: () => ({}) },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Date, setImmediate,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, order, text, block: () => ctx.invoiceBlock(order),
    w: (i) => ({ p: calls.writes[i].p, body: calls.writes[i].body, method: calls.writes[i].method }) };
}
const tick = () => new Promise((r) => setImmediate(r));
async function ok(h, i, data) { h.calls.writes[i].res(data || { success: true }); await tick(); await tick(); }
async function no(h, i, msg) { h.calls.writes[i].rej(new Error(msg)); await tick(); await tick(); }
const file = (type, size) => ({ type, size, name: 'f' });

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · who may issue');
{
  it('the old sentence is gone from the phone', () => {
    assert.ok(!M.includes("T('Issuing it is a desktop job.','开具发票请在电脑端。')"));
  });
  it('invoices:manage + orders:edit: copy, link, number, upload, Mark issued', () => {
    const h = mk();
    const html = h.block(); const t = h.text(html);
    assert.ok(t.includes('Fapiao To issue') && t.includes('Title Guangzhou Bright Tech Co.') && t.includes('Tax ID 91440101MA59XXXX0Q'));
    assert.ok(t.includes('Copy for accounting'));
    assert.ok(/id="mInvUrl"[^>]*placeholder="Fapiao link \(or attach PDF\)"/.test(html));
    assert.ok(/id="mInvNo"[^>]*placeholder="Invoice no\. \(optional\)"/.test(html));
    assert.ok(/<input type="file" accept="application\/pdf,image\/\*"[^>]*onchange="APP\.cmd\('invFile',this\)"/.test(html));
    assert.ok(t.includes('PDF / image') && t.includes('Mark issued'));
  });
  for (const caps of [['invoices:manage'], ['orders:edit'], ['orders:view']]) {
    it(`holding only ${caps.join('+')}: the request reads, and nothing is offered`, () => {
      const h = mk({ caps });
      const html = h.block(); const t = h.text(html);
      assert.ok(t.includes('Guangzhou Bright Tech Co.'));
      assert.ok(!/invCopy|invIssue|invFile|mInvUrl/.test(html));
      h.CMD.invCopy(); h.CMD.invIssue();
      assert.strictEqual(h.calls.copied.length + h.calls.writes.length, 0);
    });
  }
  it('Chinese: the desktop\'s Chinese', () => {
    const h = mk({ lang: 'zh' });
    const html = h.block(); const t = h.text(html);
    for (const s of ['复制开票信息', 'PDF / 图片', '标记已开']) assert.ok(t.includes(s), s);
    assert.ok(html.includes('placeholder="发票链接(或上传 PDF)"') && html.includes('placeholder="发票号码(可选)"'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · Copy for accounting');
{
  it('copies the desktop\'s bundle to the clipboard: goods only, bilingual whatever the screen', () => {
    const h = mk({ lang: 'zh' });
    h.CMD.invCopy();
    assert.deepStrictEqual(h.calls.copied, [[
      '开票申请 Invoice request', '订单号 Order: 20260930-0142', '类型 Type: 企业 Company',
      '抬头 Title: Guangzhou Bright Tech Co.', '税号 Tax ID: 91440101MA59XXXX0Q', '邮箱 Email: finance@bright.cn',
      '————————————', '商品总额 Products total: ¥248.00'].join('\n')]);
    for (const l of ["L.push('开票申请 Invoice request');", "'商品总额 Products total: '", "'类型 Type: ' + (company ? '企业 Company' : '个人 Personal')"]) {
      assert.ok(BILL.includes(l), 'the desktop builds the same line: ' + l);
    }
  });
  it('a personal request with no type and no tax id: Personal, no tax line; goods from the lines', () => {
    const order = { id: 'R-9', _id: 9, invoice: mapInvoice({ id: 9, order_no: 'N9', needs_invoice: 1, invoice_title: 'Wei',
      items: [{ line_total: 10 }, { line_total: 5.5 }], total: 25.5, shipping_fee: 10 }) };
    const h = mk({ order });
    h.CMD.invCopy();
    assert.ok(h.calls.copied[0].includes('类型 Type: 个人 Personal'));
    assert.ok(!h.calls.copied[0].includes('税号'));
    assert.ok(h.calls.copied[0].endsWith('商品总额 Products total: ¥15.50'));
  });
  it('a legacy row with a tax id and no type is a company; with neither lines nor subtotal, total less delivery', () => {
    const v = mapInvoice({ id: 3, needs_invoice: 1, invoice_tax_id: 'X1', total: 100, shipping_fee: 12 });
    assert.strictEqual(v.company, true);
    assert.strictEqual(v.goods, 88);
    assert.strictEqual(v.orderNo, 3, 'the id when there is no order number');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · the upload');
{
  it('a PDF goes as it is to POST /invoice-file, and its URL fills the link box', async () => {
    const h = mk();
    h.block();
    const input = { files: [file('application/pdf', 2048)], value: 'x' };
    const p = h.CMD.invFile(input);
    await tick(); await tick();
    assert.strictEqual(input.value, '', 'the same file can be picked again');
    assert.deepStrictEqual(h.w(0), { p: '/invoice-file', method: 'POST', body: { data: 'data:application/pdf;base64,QUJD' } });
    assert.ok(h.text(h.block()).includes('Uploading…'), 'the button says what it is doing');
    h.calls.writes[0].res({ success: true, data: { url: '/api/retail/media/77' } });
    await p;
    assert.strictEqual(h.ctx.state.inv.url, '/api/retail/media/77');
    assert.ok(/id="mInvUrl"[^>]*value="\/api\/retail\/media\/77"/.test(h.block()));
    assert.deepStrictEqual(h.calls.toasts, ['Attached — tap Mark issued']);
    assert.strictEqual(h.calls.writes.length, 1, 'uploading marks nothing issued');
  });
  it('anything but a PDF or an image is refused before the upload', async () => {
    const h = mk(); h.block();
    await h.CMD.invFile({ files: [file('text/plain', 10)] });
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.block()).includes('PDF or image only'));
  });
  it('over 10 MB is refused before the upload', async () => {
    const h = mk(); h.block();
    await h.CMD.invFile({ files: [file('application/pdf', 11 * 1024 * 1024)] });
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.block()).includes('File too large (max 10MB)'));
  });
  it('a photo is shrunk first where the browser can; where it cannot, the original goes', async () => {
    assert.ok(/async function invShrink\(file\)\{[\s\S]*2400\/Math\.max\(bmp\.width,bmp\.height\)[\s\S]*'image\/jpeg',0\.88/.test(M));
    const h = mk(); h.block();
    const p = h.CMD.invFile({ files: [file('image/png', 4000)] });
    await tick(); await tick();
    assert.strictEqual(h.w(0).body.data, 'data:image/png;base64,QUJD');
    h.calls.writes[0].res({ success: true, data: { url: '/m/1' } }); await p;
  });
  it('a refused upload says why, on the block, and toasts nothing', async () => {
    const h = mk(); h.block();
    const p = h.CMD.invFile({ files: [file('application/pdf', 10)] });
    await tick(); await tick();
    h.calls.writes[0].rej(new Error('type_mismatch')); await p;
    assert.ok(h.text(h.block()).includes('Upload failed: type_mismatch'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · Mark issued');
{
  it('neither a link nor a number: said before any request', () => {
    const h = mk(); h.block();
    h.CMD.invIssue();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.block()).includes('Add a fapiao link/PDF or invoice number'));
  });
  it('the desktop\'s body, trimmed; the order is re-read and the toast confirms', async () => {
    const h = mk(); h.block();
    h.CMD.invSet('url', ' https://fp.example/1.pdf '); h.CMD.invSet('number', ' 044001 ');
    h.CMD.invIssue();
    assert.deepStrictEqual(h.w(0), { p: '/orders/142/invoice', method: 'PUT',
      body: { action: 'issue', file_url: 'https://fp.example/1.pdf', number: '044001' } });
    assert.ok(h.text(h.block()).includes('Saving…'));
    assert.ok(BILL.includes("{ method: 'PUT', body: { action: 'issue', file_url: url, number } }"), 'the desktop sends the same');
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Invoice marked issued']);
    assert.strictEqual(h.calls.refreshed, 1);
    assert.strictEqual(h.ctx.state.inv, null, 'what was typed is spent');
  });
  it('a number alone is enough', () => {
    const h = mk(); h.block();
    h.CMD.invSet('number', '9'); h.CMD.invIssue();
    assert.deepStrictEqual(h.w(0).body, { action: 'issue', file_url: '', number: '9' });
  });
  it('a refusal stays on the sheet, and what was typed stays with it', async () => {
    const h = mk(); h.block();
    h.CMD.invSet('number', '9'); h.CMD.invIssue();
    await no(h, 0, 'need_file_or_number');
    assert.ok(h.ctx.state.orderErr, 'the order sheet\'s own refusal line');
    assert.strictEqual(h.ctx.state.inv.number, '9');
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('another order starts with empty boxes', () => {
    const h = mk(); h.block();
    h.CMD.invSet('number', '9');
    const other = ORDER(); other.id = 'R-2';
    h.ctx.invoiceBlock(other);
    assert.strictEqual(h.ctx.state.inv.number, '');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('5 · un-issue');
{
  const issued = () => { const o = ORDER(); o.invoice.status = 'issued'; o.invoice.number = '044001'; o.invoice.file = '/api/retail/media/77'; return o; };
  it('an issued fapiao: its number, Open the fapiao, and the desktop\'s "edit"; no issuing controls', () => {
    const h = mk({ order: issued() });
    const html = h.block(); const t = h.text(html);
    assert.ok(t.includes('Issued') && t.includes('Number 044001') && t.includes('Open the fapiao') && t.includes('edit'));
    assert.ok(!html.includes('mInvUrl') && !html.includes("APP.cmd('invIssue')"));
  });
  it('asks first, then PUTs the desktop\'s unissue', async () => {
    const h = mk({ order: issued() });
    h.CMD.invUnissue();
    assert.strictEqual(h.calls.writes.length, 0, 'nothing before the confirm');
    assert.ok(h.text(h.ctx.sheetAsk()).includes('Back to requested? Cancel Confirm'));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/orders/142/invoice', method: 'PUT', body: { action: 'unissue' } });
    assert.ok(BILL.includes("{ method: 'PUT', body: { action: 'unissue' } }"));
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Back to requested']);
  });
  it('Cancel sends nothing; without the keys there is no edit at all', () => {
    const h = mk({ order: issued() });
    h.CMD.invUnissue(); h.CMD.closeAsk();
    assert.strictEqual(h.calls.writes.length, 0);
    const b = mk({ order: issued(), caps: ['orders:edit'] });
    assert.ok(!b.block().includes('invUnissue'));
    b.CMD.invUnissue();
    assert.strictEqual(b.ctx.state.ask, null);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('6 · the strings');
{
  it('every label is the desktop\'s invT pair', () => {
    for (const [en, zh] of [['Copy for accounting', '复制开票信息'], ['Fapiao link (or attach PDF)', '发票链接(或上传 PDF)'],
      ['Invoice no. (optional)', '发票号码(可选)'], ['PDF / image', 'PDF / 图片'], ['Mark issued', '标记已开'], ['edit', '修改'],
      ['PDF or image only', '仅限 PDF 或图片'], ['File too large (max 10MB)', '文件过大'], ['Attached — tap Mark issued', '已附加,点击标记已开'],
      ['Upload failed: ', '上传失败:'], ['Add a fapiao link/PDF or invoice number', '请填写发票链接或号码'],
      ['Invoice marked issued', '已标记开票'], ['Back to requested', '已恢复待开']]) {
      assert.ok(BILL.includes(`invT('${en}', '${zh}')`), `${en} · ${zh}`);
    }
  });
  it('the one composed pair is the confirm\'s title, built from the live toast', () => {
    assert.ok(M.includes("T('Back to requested?','恢复待开？')"));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
