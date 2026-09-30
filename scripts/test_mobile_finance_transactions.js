#!/usr/bin/env node
/**
 * §300 step F2 — FINANCE TRANSACTIONS ON THE PHONE, asserted against the desktop.
 *
 *   node scripts/test_mobile_finance_transactions.js
 *
 * The desktop ledger (public/retail-admin/22-finance.js, "TRANSACTIONS" and
 * "THE WRITE HALF") is the spec. The phone code is RUN, sliced out of
 * public/m.html into a sandbox with a fake server whose answers the test
 * releases one at a time, so every write is asserted on its method, path and
 * every body field, before and after its confirm. No browser — fast shard.
 *
 * What it pins:
 *   1. the list — tiles, chips, search, each kind of row and its mark, which
 *      rows are controls; empty, filtered-empty, failed and truncated states;
 *      the window it shares with Summary; Export CSV's URL;
 *   2. New / Edit / Delete of a typed row, on `finance:record`;
 *   3. Record a return and delete one;
 *   4. Void a claim (`expenses:cancel`), re-file it, open its purchase order;
 *   5. every string is the desktop's.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const FIN = fs.readFileSync(path.join(ROOT, 'public/retail-admin/22-finance.js'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

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
  slice('function chipRow(', '/* The same row, for a filter'),
  slice('function searchBox(', 'const cfgGet='),
  slice('const RECAP_NO_MONEY=', '\n') + '\n' + slice('function recapNoMoney(){', '\n'),
  slice('function aprFresh(){', "reg('closeAsk',"),
  slice("reg('askRun', key=>{", "reg('copyWaybill'"),
  slice("reg('closeAsk',", '/* The live sheet'),
  slice('function sheetAsk(){', '/* A photo, full-screen.'),
  slice('const CAT_CJK=', "/* The claim's own day."),
  slice('function tmOneLang(', '\n'),
  slice('/* ══════════════════════════════════════════════════════════════════════════\n   §300 — FINANCE ON THE PHONE: THE SUMMARY', 'SUBS.stockadd='),
  slice('const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice('const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice('const shopDayAdd=', '/* The shop date of a value'),
  slice('const money0=', '\n'),
].join('\n');

const TODAY = '2026-09-30';
const ALL = ['finance:view', 'finance:record', 'expenses:approve', 'expenses:cancel', 'purchasing:view'];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], cmds: [], href: null };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: {
      caps: opts.caps === undefined ? ALL : opts.caps,
      pos: null, ask: null, askErr: null,
      apr: { rows: [{ id: 1 }], tried: true, err: '', busy: 0, shot: null, shotFor: null },
      fin: { view: 'transactions', range: '30', from: null, to: null, data: null, err: '', tried: false, seq: 0,
             open: { rev: true, exp: true, excl: false }, cat: null, pol: null,
             tx: null, txTried: false, txErr: '', txSeq: 0, txDir: 'all', txQ: '', txRow: null, txBusy: '', txActErr: '', form: null, ret: null },
    },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    shopToday: () => TODAY,
    tdWhen: (s) => 'D' + String(s).slice(5),
    _tdL: () => ({ lang: 'en' }),
    screenApprovals: () => '<div>APPROVALS-SCREEN</div>',
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    location: { set href(v) { calls.href = v; }, get href() { return calls.href; } },
    APP: { cmd: (n, ...a) => { calls.cmds.push([n, ...a]); if (CMD[n] && n !== 'openPO') CMD[n](...a); } },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const h = { ctx, CMD, calls, els, text, f: ctx.state.fin,
    screen: () => ctx.SUBS.finance.render(),
    w: (i) => calls.writes[i] && { p: calls.writes[i].p, body: calls.writes[i].body, method: calls.writes[i].method } };
  return h;
}
const tick = () => new Promise((r) => setImmediate(r));
async function answer(h, i, data) { h.calls.api[i].res(data); await tick(); }
async function ok(h, i) { h.calls.writes[i].res({ success: true }); await tick(); }
async function no(h, i, msg) { h.calls.writes[i].rej(new Error(msg)); await tick(); }

const ROWS = () => [
  { kind: 'out', id: 11, date: '2026-09-25', subject: 'Rent 房租', category: 'Rent 房租', note: 'October', amount: 24000, source: 'manual', returned: 0, recorded_by: 'Ash' },
  { kind: 'in', id: 3, date: '2026-09-25', subject: 'Sublet, back room', category: null, note: 'Sublet, back room', amount: 1200, source: 'manual', recorded_by: 'Ash' },
  { kind: 'out', id: 20, date: '2026-09-27', subject: 'Taxi to the market', category: 'Delivery & freight 运费', amount: 38, source: 'claim', claim_id: 7, paid_by: 'employee', settled: false, returned: 0, recorded_by: 'Ash' },
  { kind: 'out', id: 'po-234', date: '2026-09-29', subject: 'RPO-0234', category: null, amount: 1420, source: 'po', po_id: 234, po_number: 'RPO-0234', categories: 2, po_open: true },
  { kind: 'out', id: 30, date: '2026-09-30', subject: 'SF refund', category: 'Delivery & freight 运费', note: 'SF refund', amount: -18, source: 'return', reason: 'quality', held_by_staff: true },
  { kind: 'in', id: 4, date: '2026-09-22', subject: 'SF late', category: null, amount: 20, source: 'delay_case', delay_case_id: 2 },
  { kind: 'out', id: 12, date: '2026-09-20', subject: 'Packaging 包装', category: 'Packaging 包装', note: null, amount: 19, source: 'manual', returned: 10 },
  { kind: 'out', id: 21, date: '2026-09-19', subject: 'Lunch', category: 'Rent 房租', amount: 50, source: 'claim', claim_id: 8, paid_by: 'company', settled: true, returned: 0 },
  { kind: 'out', id: 'po-9', date: '2026-09-18', subject: 'KPO-0009', amount: 70, source: 'po', po_id: 9, po_number: 'KPO-0009', categories: 1, po_open: false },
];
const TX = () => ({
  window: { from: '2026-09-01', to: '2026-09-30' },
  income_categories: [], expense_categories: ['Rent 房租', 'Delivery & freight 运费', 'Packaging 包装'],
  totals: { in: 1220, out: 25509 }, counts: { all: 9, in: 2, out: 7 },
  rows: ROWS(), total: 9, limit: 2000, truncated: false,
});
async function loaded(opts, data) {
  const h = mk(opts);
  h.screen();
  await answer(h, 0, data || TX());
  return h;
}
const idx = (h, id) => h.f.tx.rows.findIndex((r) => String(r.id) === String(id));
function open(h, id) { h.CMD.finTxOpen(idx(h, id)); return h.text(h.ctx.sheetFinTxRow()); }

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · the list');
{
  it('reads the ledger for the window Summary reads, and says Loading… first', () => {
    const h = mk();
    assert.ok(h.text(h.screen()).includes('Loading…'));
    assert.strictEqual(h.calls.api[0].p, '/finance/transactions?from=2026-09-01&to=2026-09-30');
  });
  it('the strip names Transactions, between Summary and Approvals', async () => {
    const h = await loaded();
    assert.ok(h.text(h.screen()).startsWith('Summary Transactions Approvals'));
  });
  it('tiles, the Summary pointer, and the direction chips with their counts', async () => {
    const h = await loaded();
    const t = h.text(h.screen());
    assert.ok(t.includes('Money out ¥25,509 Money in ¥1,220 Sales revenue is on Summary'));
    assert.ok(t.includes('All 9 Money in 2 Money out 7'));
    assert.ok(t.includes('Export CSV'));
  });
  it('each kind of row: its subject, date, the desktop\'s marks, the signed amount', async () => {
    const h = await loaded();
    const t = h.text(h.screen());
    for (const s of [
      'Rent D09-25 · Entered by Ash · Note · October −¥24,000',
      'Sublet, back room D09-25 · Entered by Ash +¥1,200',
      'Taxi to the market D09-27 · Staff claim · own money · Approved by Ash −¥38',
      'RPO-0234 D09-29 · Posted by Purchasing · Sum of 2 category subtotals −¥1,420',
      'SF refund D09-30 · Return · Quality · Owes the shop · Note · SF refund +¥18',
      'SF late D09-22 · Carrier claim +¥20',
      'Packaging D09-20 · Returned ¥10 · Net ¥9 −¥19',
      'KPO-0009 D09-18 · Posted by Purchasing −¥70',
    ]) assert.ok(t.includes(s), `missing "${s}" in ${t}`);
  });
  it('a row is a control only where something may be done to it', async () => {
    const h = await loaded();
    const html = h.screen();
    for (const id of [11, 3, 20, 'po-234', 30, 12, 21]) assert.ok(html.includes(`APP.cmd('finTxOpen',${idx(h, id)})`), 'opens: ' + id);
    assert.ok(!html.includes(`APP.cmd('finTxOpen',${idx(h, 4)})`), 'a carrier claim row is not');
    assert.ok(!html.includes(`APP.cmd('finTxOpen',${idx(h, 'po-9')})`), 'nor a PO Purchasing cannot open');
  });
  it('in Chinese: the desktop\'s Chinese', async () => {
    const h = await loaded({ lang: 'zh' });
    const t = h.text(h.screen());
    for (const s of ['支出 ¥25,509', '进账 ¥1,220', '营收见汇总', '全部 9', '房租', '录入人 Ash', '备注 · October',
      '费用申请 · 个人支付 · 审批人 Ash', '采购单自动记入 · 2 个类别小计合计', '退货 · 质量问题 · 应退还店里', '承运商赔偿',
      '退货 ¥10 · 净额 ¥9', '导出']) assert.ok(t.includes(s), s);
  });
  it('the chips filter by direction', async () => {
    const h = await loaded();
    h.CMD.finTxDir('in');
    const t = h.text(h.screen());
    assert.ok(t.includes('Sublet') && t.includes('SF late') && !t.includes('Taxi'));
  });
  it('the search patches the list only, so the keyboard stays', async () => {
    const h = await loaded();
    h.screen();
    h.els.mFinTxList = { innerHTML: '' };
    h.els.mFinTxClr = { style: {} };
    h.CMD.finTxQ('taxi');
    const t = h.text(h.els.mFinTxList.innerHTML);
    assert.ok(t.includes('Taxi to the market') && !t.includes('Rent'));
    assert.strictEqual(h.els.mFinTxClr.style.display, '', 'the × shows');
    assert.ok(M.includes("['mFinTxQ','mFinTxClr','finTxQ']"), 'and is registered with every other ×');
  });
  it('filtered to nothing: No matching records, and Clear puts everything back', async () => {
    const h = await loaded();
    h.CMD.finTxQ('zzz');
    const html = h.screen();
    assert.ok(h.text(html).includes('No matching records. Clear'));
    assert.ok(!h.text(html).includes('Nothing recorded yet'), 'never the compliment while filtering');
    h.CMD.finTxClear();
    assert.ok(h.text(h.screen()).includes('Taxi to the market'));
  });
  it('an empty ledger is the compliment, with New transaction for the pen', async () => {
    const d = TX(); d.rows = []; d.counts = { all: 0, in: 0, out: 0 }; d.totals = { in: 0, out: 0 };
    const a = await loaded({}, d);
    const html = a.screen();
    assert.ok(a.text(html).includes('Nothing recorded yet Rent, wages and one-off costs you record will appear here'));
    assert.ok(html.includes("APP.cmd('finTxNew')"));
    const b = await loaded({ caps: ['finance:view'] }, d);
    assert.ok(!b.screen().includes("APP.cmd('finTxNew')"), 'no button without finance:record');
  });
  it('a failed read says so with Try again, which re-reads the ledger only', async () => {
    const h = mk();
    h.screen();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    const html = h.screen();
    assert.ok(h.text(html).includes('Could not load Finance.'));
    h.CMD.finRetry(); h.screen();
    assert.strictEqual(h.calls.api[1].p, '/finance/transactions?from=2026-09-01&to=2026-09-30');
    assert.strictEqual(h.f.tried, false, 'Summary untouched');
  });
  it('a truncated ledger says so, in 01-core\'s words', async () => {
    const d = TX(); d.truncated = true; d.limit = 2000; d.total = 2400;
    const h = await loaded({}, d);
    assert.ok(h.text(h.screen()).includes('Showing the first 2,000 of 2,400 ledger rows. Search or filter to reach the rest.'));
  });
  it('one window governs both sub-views: a new range re-reads the ledger', async () => {
    const h = await loaded();
    h.CMD.finRange('7'); h.screen();
    assert.strictEqual(h.calls.api[1].p, '/finance/transactions?from=2026-09-24&to=2026-09-30');
    assert.strictEqual(h.f.tried, false, 'and the staircase');
  });
  it('a slow answer for the old window is dropped', async () => {
    const h = mk();
    h.screen(); h.CMD.finRange('7'); h.screen();
    const late = TX(); late.totals.out = 999999;
    await answer(h, 1, TX());
    await answer(h, 0, late);
    assert.ok(!h.text(h.screen()).includes('999,999'));
  });
  it('Export CSV downloads the desktop\'s URL for the window on screen, not the search', async () => {
    const h = await loaded();
    h.CMD.finTxQ('taxi');
    h.CMD.finTxExport();
    assert.strictEqual(h.calls.href, '/api/retail-admin/finance/transactions/export.csv?from=2026-09-01&to=2026-09-30');
    assert.ok(FIN.includes("'/api/retail-admin/finance/transactions/export.csv'"));
  });
  it('the header CTA is New transaction, on Transactions only, for finance:record only', async () => {
    const h = await loaded();
    assert.ok(h.ctx.SUBS.finance.cta().includes('New transaction'));
    h.f.view = 'summary';
    assert.strictEqual(h.ctx.SUBS.finance.cta(), '');
    const b = await loaded({ caps: ['finance:view'] });
    assert.strictEqual(b.ctx.SUBS.finance.cta(), '');
  });
  it('entering Finance clears the ledger\'s read, sheets and forms', () => {
    const push = M.slice(M.indexOf('function push(route){'), M.indexOf('function pop(){'));
    assert.ok(push.includes("f.txTried=false; f.txErr=''; f.txRow=null; f.txActErr=''; f.txBusy=''; f.form=null; f.ret=null;"));
    const L = M.slice(M.indexOf('function layers(){'), M.indexOf('function syncHistory(){'));
    assert.ok(L.includes('if(state.fin.txRow)') && L.includes('if(state.fin.form)') && L.includes('if(state.fin.ret)'), 'Back closes each');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · New, Edit and Delete a typed row');
{
  it('New opens an empty form: direction, today, amount, category, note', async () => {
    const h = await loaded();
    h.CMD.finTxNew();
    const html = h.ctx.sheetFinTxForm(); const t = h.text(html);
    assert.ok(t.startsWith('New transaction Direction Money out Money in Date Amount Category Rent Delivery & freight Packaging Note Cancel Save'),
      'the tenant\'s categories offered under the box, in this language');
    assert.ok(/id="mFinTxDate" type="date" value="2026-09-30"/.test(html));
    assert.ok(!/id="mFinTxDate"[^>]*min=/.test(html), 'no floor (§36)');
    assert.ok(!t.includes('Delete'));
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('the category box suggests the tenant\'s list, and a pick stores the whole value', async () => {
    const h = await loaded();
    h.CMD.finTxNew();
    h.els.mFinTxSug = { innerHTML: '' };
    h.CMD.finTxSet('cat', 'ren');
    assert.ok(h.text(h.els.mFinTxSug.innerHTML) === 'Rent', 'narrowed as typed, patched in place');
    h.CMD.finTxSug(0);
    assert.strictEqual(h.f.form.cat, 'Rent');
    h.CMD.finTxSet('date', '2026-05-02'); h.CMD.finTxSet('amount', '2540.00'); h.CMD.finTxSet('note', 'Oct');
    h.CMD.finTxSave();
    assert.deepStrictEqual(h.w(0), { p: '/finance/transactions', method: 'POST',
      body: { kind: 'out', date: '2026-05-02', amount: '2540.00', category: 'Rent 房租', note: 'Oct' } });
    assert.ok(h.text(h.ctx.sheetFinTxForm()).includes('Saving…'), 'the button says what it is doing');
    assert.ok(/disabled onclick="APP\.cmd\('finTxSave'\)"/.test(h.ctx.sheetFinTxForm()));
    h.CMD.finTxSave();
    assert.strictEqual(h.calls.writes.length, 1, 'a second tap sends nothing');
    await ok(h, 0);
    assert.strictEqual(h.f.form, null, 'the form closes');
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.strictEqual(h.f.txTried, false, 'the ledger is re-read');
    assert.strictEqual(h.f.tried, false, 'and the staircase');
  });
  it('a new category is stored as typed; either half of a known one resolves to it', async () => {
    const h = await loaded();
    h.CMD.finTxNew(); h.CMD.finTxSet('cat', '运费'); h.CMD.finTxSet('amount', '5');
    h.CMD.finTxSave();
    assert.strictEqual(h.w(0).body.category, 'Delivery & freight 运费');
    const b = await loaded();
    b.CMD.finTxNew(); b.CMD.finTxSet('cat', ' Brand new '); b.CMD.finTxSave();
    assert.strictEqual(b.w(0).body.category, 'Brand new');
  });
  it('money in with no income categories: no category field, and category null', async () => {
    const h = await loaded();
    h.CMD.finTxNew(); h.CMD.finTxSet('cat', 'Rent'); h.CMD.finTxKind('in');
    assert.strictEqual(h.f.form.cat, '', 'a new direction starts its category empty');
    assert.ok(!h.text(h.ctx.sheetFinTxForm()).includes('Category'));
    h.CMD.finTxSet('amount', '1200'); h.CMD.finTxSave();
    assert.deepStrictEqual(h.w(0).body, { kind: 'in', date: TODAY, amount: '1200', category: null, note: '' });
  });
  it('a refusal stays on the form, in this operator\'s half, with no toast', async () => {
    const h = await loaded();
    h.CMD.finTxNew(); h.CMD.finTxSave();
    await no(h, 0, 'amount must be positive · 金额必须大于零');
    assert.ok(h.f.form, 'still open');
    assert.ok(h.text(h.ctx.sheetFinTxForm()).includes('amount must be positive'));
    assert.deepStrictEqual(h.calls.toasts, []);
    const z = await loaded({ lang: 'zh' });
    z.CMD.finTxNew(); z.CMD.finTxSave(); await no(z, 0, 'date required · 日期必填');
    assert.ok(z.text(z.ctx.sheetFinTxForm()).includes('日期必填'));
    const n = await loaded();
    n.CMD.finTxNew(); n.CMD.finTxSave(); await no(n, 0, 'HTTP 500');
    assert.ok(n.text(n.ctx.sheetFinTxForm()).includes('That did not go through. Nothing has changed — try again.'));
  });
  it('a typed row opens Edit and Return; Edit is prefilled and PUTs the desktop\'s body', async () => {
    const h = await loaded();
    const t = open(h, 11);
    assert.ok(t.startsWith('Rent · −¥24,000'));
    assert.ok(t.includes('Edit') && t.includes('Return') && !t.includes('Void'));
    h.CMD.finTxEdit();
    const html = h.ctx.sheetFinTxForm();
    assert.ok(h.text(html).startsWith('Edit Date'), 'no direction toggle on an edit: the row lives in one table');
    assert.ok(/id="mFinTxAmt"[^>]*value="24000"/.test(html) && /id="mFinTxCat"[^>]*value="Rent"/.test(html) && /id="mFinTxNote" value="October"/.test(html));
    h.CMD.finTxSet('amount', '25000');
    h.CMD.finTxSave();
    assert.deepStrictEqual(h.w(0), { p: '/finance/transactions/out/11', method: 'PUT',
      body: { kind: 'out', date: '2026-09-25', amount: '25000', category: 'Rent 房租', note: 'October' } });
  });
  it('Delete asks first, in the desktop\'s words, then DELETEs', async () => {
    const h = await loaded();
    open(h, 11); h.CMD.finTxEdit();
    h.CMD.finTxDelete();
    assert.strictEqual(h.calls.writes.length, 0, 'nothing before the confirm');
    const ask = h.text(h.ctx.sheetAsk());
    assert.ok(ask.includes('Delete this transaction? This removes the row from the ledger. This cannot be undone. Cancel Delete'));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/finance/transactions/out/11', method: 'DELETE', body: {} });
    await ok(h, 0);
    assert.strictEqual(h.f.form, null);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
  });
  it('a refused delete stays on the form', async () => {
    const h = await loaded();
    open(h, 12); h.CMD.finTxEdit(); h.CMD.finTxDelete(); h.CMD.askRun('');
    await no(h, 0, 'This has a return recorded. Delete the return first · 该笔已登记退货，请先删除退货');
    assert.ok(h.text(h.ctx.sheetFinTxForm()).includes('This has a return recorded. Delete the return first'));
  });
  it('without finance:record: no New, no Edit, no Return — and the commands refuse', async () => {
    const h = await loaded({ caps: ['finance:view'] });
    const html = h.screen();
    assert.ok(!html.includes(`APP.cmd('finTxOpen',${idx(h, 11)})`), 'a typed row is not a control');
    h.CMD.finTxNew();
    assert.strictEqual(h.f.form, null);
    h.f.txRow = 'out:11'; h.CMD.finTxEdit();
    assert.strictEqual(h.f.form, null);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · Record a return, and delete one');
{
  it('the return sheet: empty amount with the ceiling as its placeholder, the hint, the five reasons', async () => {
    const h = await loaded();
    open(h, 20); h.CMD.finTxRet();
    const html = h.ctx.sheetFinTxRet(); const t = h.text(html);
    assert.ok(t.startsWith('Return · Taxi to the market Date Amount'));
    assert.ok(/id="mFinRtAmt"[^>]*value=""[^>]*placeholder="¥38"/.test(html), 'empty, not prefilled');
    assert.ok(t.includes('Only what the seller actually refunded. If shipping was not refunded, leave it out.'));
    assert.ok(t.includes('Why? Why? Wrong item Quality Expired Over-delivered Not needed'));
    assert.strictEqual(h.f.txRow, null, 'the row sheet gave way to it');
  });
  it('no amount, or no reason, is caught before the request', async () => {
    const h = await loaded();
    open(h, 20); h.CMD.finTxRet();
    h.CMD.finTxRetSave();
    assert.ok(h.text(h.ctx.sheetFinTxRet()).includes('amount must be positive'));
    h.CMD.finRetSet('amount', '9'); h.CMD.finTxRetSave();
    assert.ok(h.text(h.ctx.sheetFinTxRet()).includes('Pick a reason for the return'));
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('Save sends the desktop\'s body, then re-reads the ledger and the approvals queue', async () => {
    const h = await loaded();
    open(h, 20); h.CMD.finTxRet();
    h.CMD.finRetSet('amount', '9'); h.CMD.finRetSet('reason', 'quality'); h.CMD.finRetSet('note', 'box dented');
    h.CMD.finTxRetSave();
    assert.deepStrictEqual(h.w(0), { p: '/finance/transactions/out/20/return', method: 'POST',
      body: { date: TODAY, amount: '9', reason: 'quality', note: 'box dented' } });
    assert.ok(h.text(h.ctx.sheetFinTxRet()).includes('Saving…'));
    await ok(h, 0);
    assert.strictEqual(h.f.ret, null);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.strictEqual(h.ctx.state.apr.rows, null, 'the owed block is re-read (§269)');
  });
  it('a refused return stays on its sheet', async () => {
    const h = await loaded();
    open(h, 20); h.CMD.finTxRet();
    h.CMD.finRetSet('amount', '99'); h.CMD.finRetSet('reason', 'quality'); h.CMD.finTxRetSave();
    await no(h, 0, 'A return cannot be more than was spent · 退货金额不能超过支出金额');
    assert.ok(h.text(h.ctx.sheetFinTxRet()).includes('A return cannot be more than was spent'));
  });
  it('Return is offered only while something is left to return', async () => {
    const d = TX(); d.rows[6].returned = 19;
    const h = await loaded({}, d);
    const acts = (id) => { open(h, id); return h.ctx.sheetFinTxRow(); };
    assert.ok(acts(12).includes("APP.cmd('finTxEdit')") && !acts(12).includes("APP.cmd('finTxRet')"));
    assert.ok(acts(11).includes("APP.cmd('finTxRet')"));
    assert.ok(!acts('po-234').includes("APP.cmd('finTxRet')"), 'never on a PO row');
  });
  it('a return row offers Delete only; it asks, then DELETEs the return', async () => {
    const h = await loaded();
    const t = open(h, 30);
    assert.ok(t.includes('Delete') && !t.includes('Edit'));
    h.CMD.finTxDelRet();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.sheetAsk()).includes('Delete this transaction?'));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/finance/transactions/out/30', method: 'DELETE', body: {} });
    await ok(h, 0);
    assert.strictEqual(h.f.txRow, null);
    assert.deepStrictEqual(h.calls.toasts, ['Deleted']);
  });
  it('a refused delete of a return stays on the row\'s sheet', async () => {
    const h = await loaded();
    open(h, 30); h.CMD.finTxDelRet(); h.CMD.askRun('');
    await no(h, 0, 'Not found · 未找到');
    assert.ok(h.f.txRow);
    assert.ok(h.text(h.ctx.sheetFinTxRow()).includes('Not found'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · Void, re-file, open the purchase order');
{
  it('a claim offers Category, Return and Void', async () => {
    const h = await loaded();
    const html = (open(h, 20), h.ctx.sheetFinTxRow());
    assert.ok(/<select[^>]*onchange="APP\.cmd\('finTxFile',this\.value\)"/.test(html));
    assert.ok(/value="Delivery &amp; freight 运费" selected>Delivery &amp; freight</.test(html));
    const t = h.text(html);
    assert.ok(t.includes('Return') && t.includes('Void') && !t.includes('Edit'));
  });
  it('Void asks first, then POSTs the claim\'s void', async () => {
    const h = await loaded();
    open(h, 20); h.CMD.finTxVoid();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.sheetAsk()).includes('Void this claim? This removes the row from the ledger. This cannot be undone. Cancel Void'));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/staff-expenses/7/void', method: 'POST', body: {} });
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Voided']);
    assert.strictEqual(h.ctx.state.apr.rows, null);
  });
  it('no Void on a settled claim, nor without expenses:cancel', async () => {
    const h = await loaded();
    assert.ok(!open(h, 21).includes('Void'));
    const b = await loaded({ caps: ['finance:view', 'finance:record', 'expenses:approve'] });
    const t = open(b, 20);
    assert.ok(!t.includes('Void') && t.includes('Category'), 'approve alone may re-file, not void');
    b.CMD.finTxVoid();
    assert.strictEqual(b.ctx.state.ask, null);
  });
  it('re-filing posts the claim\'s own category endpoint; the blank changes nothing', async () => {
    const h = await loaded();
    open(h, 20);
    h.CMD.finTxFile('');
    h.CMD.finTxFile('Delivery & freight 运费');
    assert.strictEqual(h.calls.writes.length, 0, 'the same value, or none, sends nothing');
    h.CMD.finTxFile('Rent 房租');
    assert.deepStrictEqual(h.w(0), { p: '/staff-expenses/7/category', method: 'POST', body: { category: 'Rent 房租' } });
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
  });
  it('a PO row opens this app\'s purchase-order sheet', async () => {
    const h = await loaded();
    const t = open(h, 'po-234');
    assert.ok(t.includes('Open purchase order') && !t.includes('Edit'));
    h.CMD.finTxOpenPO();
    assert.deepStrictEqual(h.calls.cmds.pop(), ['openPO', 234]);
    assert.strictEqual(h.f.txRow, null);
    const b = await loaded({ caps: ['finance:view', 'finance:record'] });
    assert.ok(!b.screen().includes(`APP.cmd('finTxOpen',${idx(b, 'po-234')})`), 'nothing to do without purchasing:view');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('5 · every string is the desktop\'s');
{
  it('the pairs are live in 22-finance.js or its markup', () => {
    for (const [en, zh] of [['Money out', '支出'], ['Money in', '进账'], ['All', '全部'], ['Sales revenue is on Summary', '营收见汇总'],
      ['Filter these transactions', '筛选交易记录'], ['No matching records.', '没有符合条件的记录。'], ['Clear', '清除'],
      ['New transaction', '新建交易'], ['Edit', '编辑'], ['Delete', '删除'], ['Void', '作废'], ['Voided', '已作废'],
      ['Deleted', '已删除'], ['Saved', '已保存'], ['Saving…', '保存中…'], ['Return', '退货'], ['Returned', '退货'],
      ['Why?', '原因？'], ['Note', '备注'], ['Date', '日期'], ['Amount', '金额'], ['Cancel', '取消'], ['Save', '保存'],
      ['Open purchase order', '查看采购单'], ['— pick a category —', '— 选择分类 —'], ['Owes the shop', '应退还店里'],
      ['Delete this transaction?', '删除这条交易记录？'], ['Void this claim?', '作废这条费用申请？'],
      ['amount must be positive', '金额必须大于零'], ['Pick a reason for the return', '请选择退货原因'],
      ['Wrong item', '错货'], ['Quality', '质量问题'], ['Expired', '过期'], ['Over-delivered', '多送'], ['Not needed', '无需要']]) {
      assert.ok(FIN.includes(`cuT('${en}', '${zh}')`) || FIN.includes(`'${en}', '${zh}'`), `${en} · ${zh}`);
    }
    for (const p of ['Transactions · 交易记录', 'Export CSV · 导出', 'Direction · 方向', 'Money out · 支出', 'Money in · 进账',
      'Category · 分类']) assert.ok(DESK.includes(p), p);
    for (const s of ['This removes the row from the ledger. This cannot be undone.', '此操作将从账本中移除该记录。此操作无法撤销。',
      'Only what the seller actually refunded. If shipping was not refunded, leave it out.', '只填卖家实际退回的金额。运费没退就不要算进去。',
      'Rent, wages and one-off costs you record will appear here — alongside anything Purchasing posts from a purchase order.']) {
      assert.ok(FIN.includes(s), s);
    }
    const CORE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
    assert.ok(CORE.includes('Search or filter to reach the rest.') && CORE.includes('请用搜索或筛选查看其余。'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
