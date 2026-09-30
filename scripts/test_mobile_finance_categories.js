#!/usr/bin/env node
/**
 * §300 step F3 — FINANCE CATEGORIES ON THE PHONE, asserted against the desktop.
 *
 *   node scripts/test_mobile_finance_categories.js
 *
 * The desktop's Categories sub-view (public/retail-admin/22-finance.js,
 * "CATEGORIES") is the spec. The phone code is RUN, sliced out of
 * public/m.html into a sandbox with a fake server whose answers the test
 * releases one at a time, so every write is asserted on its method, path and
 * body, and on nothing being sent before its confirm. No browser — fast shard.
 *
 * What it pins:
 *   1. the list — names, usage, hidden, the operating switch; loading, empty,
 *      failed; no date range over it; read-only without `finance:record`;
 *   2. Add, and the box kept on a refusal;
 *   3. the operating switch, Rename, Hide (with its confirm), Restore;
 *   4. Delete — refused before the request when the category is used, asked
 *      first when it is not;
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
  slice('function toggle(', '/* =========='),
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
      fin: { view: 'categories', range: '30', from: null, to: null, data: null, err: '', tried: false, seq: 0,
             open: { rev: true, exp: true, excl: false }, cat: null, pol: null,
             tx: null, txTried: false, txErr: '', txSeq: 0, txDir: 'all', txQ: '', txRow: null, txBusy: '', txActErr: '', form: null, ret: null,
             cats: null, catsTried: false, catsErr: '', catsMsg: '', catsBusy: '', catsNew: '' },
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
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const h = { ctx, CMD, calls, els, text, f: ctx.state.fin,
    screen: () => ctx.SUBS.finance.render(),
    w: (i) => calls.writes[i] && { p: calls.writes[i].p, body: calls.writes[i].body, method: calls.writes[i].method } };
  return h;
}
const tick = () => new Promise((r) => setImmediate(r));
async function answer(h, i, data) { h.calls.api[i].res(data); await tick(); }
async function ok(h, i) { h.calls.writes[i].res({ success: true }); await tick(); }
async function no(h, i, msg) { h.calls.writes[i].rej(new Error(msg)); await tick(); }

const CATS = () => [
  { id: 1, name: 'Rent 房租', sort_order: 0, is_operating: 1, is_active: 1, usage_count: 3 },
  { id: 2, name: 'Owner drawings', sort_order: 1, is_operating: 0, is_active: 1, usage_count: 2 },
  { id: 3, name: 'Old equipment', sort_order: 2, is_operating: 1, is_active: 0, usage_count: 0 },
  { id: 4, name: 'Typo', sort_order: 3, is_operating: 1, is_active: 1, usage_count: 0 },
];
async function loaded(opts, data) {
  const h = mk(opts);
  h.screen();
  await answer(h, 0, data || CATS());
  return h;
}
const more = (h, id) => { h.CMD.finCatMore(id); return h.text(h.ctx.sheetAsk()); };

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · the list');
{
  it('reads the list, says Loading… first, and has no date range over it', () => {
    const h = mk();
    const t = h.text(h.screen());
    assert.ok(t.includes('Loading…'));
    assert.strictEqual(h.calls.api[0].p, '/finance/categories');
    assert.ok(!t.includes('30 days'), 'no range chips');
    assert.strictEqual(h.ctx.SUBS.finance.status(), '', 'no window in the status line');
    assert.strictEqual(h.ctx.SUBS.finance.cta(), '', 'and no New transaction');
  });
  it('the strip: Summary, Transactions, Approvals, Categories — the desktop\'s order', async () => {
    const h = await loaded();
    assert.ok(h.text(h.screen()).startsWith('Summary Transactions Approvals Categories'));
    assert.ok(DESK.includes('Categories · 分类'));
  });
  it('each category: its name, its usage in words, Hidden, and the operating switch', async () => {
    const h = await loaded();
    const html = h.screen(); const t = h.text(html);
    assert.ok(t.includes('Your own list. Expenses are filed against these, and only these are offered when someone records one.'));
    for (const s of ['Rent 房租 Used by 3 Operating expense', 'Owner drawings Used by 2 Operating expense',
      'Old equipment Not used · Hidden Operating expense', 'Typo Not used Operating expense']) assert.ok(t.includes(s), s);
    assert.ok(html.includes("APP.cmd('finCatFlag',1)") && html.includes("APP.cmd('finCatMore',4)"));
    assert.ok(/APP\.cmd\('finCatFlag',1\)" aria-label="Toggle" style="[^"]*background:var\(--text-primary\)/.test(html), 'Rent is on');
    assert.ok(/APP\.cmd\('finCatFlag',2\)" aria-label="Toggle" style="[^"]*background:var\(--surface-raised\)/.test(html), 'drawings is off');
    assert.ok(html.includes('placeholder="Rent"') && t.includes('Add'));
  });
  it('in Chinese: the desktop\'s Chinese', async () => {
    const h = await loaded({ lang: 'zh' });
    const t = h.text(h.screen());
    for (const s of ['汇总 交易记录 审批 分类', '本店自己的分类列表。记录支出时只会显示这些分类。', '3 条使用', '未使用 · 已停用', '营业费用', '添加']) {
      assert.ok(t.includes(s), s);
    }
  });
  it('without finance:record: the list reads, with each flag in words, and no control at all', async () => {
    const h = await loaded({ caps: ['finance:view'] });
    const html = h.screen(); const t = h.text(html);
    assert.ok(t.includes('Rent 房租 Used by 3 · Operating expense'));
    assert.ok(t.includes('Owner drawings Used by 2 · Not an operating expense'));
    assert.ok(!html.includes('finCatFlag') && !html.includes('finCatMore') && !html.includes('mFinCatNew'));
    h.CMD.finCatFlag(1); h.CMD.finCatMore(1); h.f.catsNew = 'x'; h.CMD.finCatAdd();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.strictEqual(h.ctx.state.ask, null);
  });
  it('an empty list says what to do', async () => {
    const h = await loaded({}, []);
    assert.ok(h.text(h.screen()).includes('No categories yet. Add the ones this business spends money on — rent, wages.'));
  });
  it('a failed read says so, and Try again reads again', async () => {
    const h = mk();
    h.screen();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.screen()).includes('Could not load the categories. Try again'));
    h.CMD.finRetry(); h.screen();
    assert.strictEqual(h.calls.api[1].p, '/finance/categories');
  });
  it('entering Finance forgets the list and anything half-typed', () => {
    const push = M.slice(M.indexOf('function push(route){'), M.indexOf('function pop(){'));
    assert.ok(push.includes("f.catsTried=false; f.catsErr=''; f.catsMsg=''; f.catsBusy=''; f.catsNew='';"));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · Add');
{
  it('Add POSTs the name, trimmed; says Saving…; re-reads the list; clears the box', async () => {
    const h = await loaded();
    h.CMD.finCatNewSet('  Wages  ');
    h.CMD.finCatAdd();
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories', method: 'POST', body: { name: 'Wages' } });
    assert.ok(h.text(h.screen()).includes('Saving…'));
    h.CMD.finCatAdd();
    assert.strictEqual(h.calls.writes.length, 1, 'a second tap sends nothing');
    await ok(h, 0);
    assert.strictEqual(h.f.catsNew, '');
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    h.screen();
    assert.strictEqual(h.calls.api[1].p, '/finance/categories', 'the list is read again');
    assert.strictEqual(h.f.txTried, false, 'and the ledger\'s words');
  });
  it('an empty box sends nothing', async () => {
    const h = await loaded();
    h.CMD.finCatNewSet('   '); h.CMD.finCatAdd();
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('a duplicate keeps what was typed, and says why where it stays', async () => {
    const h = await loaded();
    h.CMD.finCatNewSet('rent 房租'); h.CMD.finCatAdd();
    await no(h, 0, 'that category already exists · 该分类已存在');
    assert.strictEqual(h.f.catsNew, 'rent 房租');
    assert.ok(h.text(h.screen()).includes('that category already exists'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · the switch, Rename, Hide and Restore');
{
  it('the operating switch PATCHes the opposite of what it shows', async () => {
    const h = await loaded();
    h.CMD.finCatFlag(1);
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories/1', method: 'PATCH', body: { is_operating: false } });
    await ok(h, 0);
    const b = await loaded();
    b.CMD.finCatFlag(2);
    assert.deepStrictEqual(b.w(0), { p: '/finance/categories/2', method: 'PATCH', body: { is_operating: true } });
  });
  it('⋯ offers Rename, Hide and Delete — Restore instead of Hide on a hidden one', async () => {
    const h = await loaded();
    assert.ok(more(h, 1).includes('Rent 房租 Rename Hide Delete'));
    h.CMD.closeAsk();
    const t3 = more(h, 3);
    assert.ok(t3.includes('Old equipment Rename Restore Delete') && !t3.includes('Hide'), t3);
  });
  it('Rename opens the name, and PATCHes the new one', async () => {
    const h = await loaded();
    h.CMD.finCatMore(1); h.CMD.askRun('rename');
    const html = h.ctx.sheetAsk();
    assert.ok(h.text(html).startsWith('Rename Category'));
    assert.ok(/id="ask-name"[^>]*value="Rent 房租"/.test(html));
    h.ctx.document.getElementById = (id) => (id === 'ask-name' ? { value: ' Rent & rates ' } : null);
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories/1', method: 'PATCH', body: { name: 'Rent & rates' } });
  });
  it('an unchanged or empty name sends nothing', async () => {
    for (const v of ['Rent 房租', '  ']) {
      const h = await loaded();
      h.CMD.finCatMore(1); h.CMD.askRun('rename');
      h.ctx.document.getElementById = (id) => (id === 'ask-name' ? { value: v } : null);
      h.CMD.askRun('');
      assert.strictEqual(h.calls.writes.length, 0, JSON.stringify(v));
    }
  });
  it('Hide asks first, saying what it does, then PATCHes is_active false', async () => {
    const h = await loaded();
    h.CMD.finCatMore(1); h.CMD.askRun('hide');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.sheetAsk()).includes('Hide this category? It stops being offered when recording an expense. Expenses already filed under it keep it, and keep its setting. Cancel Hide'));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories/1', method: 'PATCH', body: { is_active: false } });
  });
  it('Restore PATCHes is_active true, with no confirm', async () => {
    const h = await loaded();
    h.CMD.finCatMore(3); h.CMD.askRun('restore');
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories/3', method: 'PATCH', body: { is_active: true } });
  });
  it('while one write runs the other controls are held', async () => {
    const h = await loaded();
    h.CMD.finCatFlag(1);
    const html = h.screen();
    assert.ok(!html.includes("APP.cmd('finCatFlag',2)"), 'switches inert');
    h.CMD.finCatFlag(2); h.CMD.finCatMore(2);
    assert.strictEqual(h.calls.writes.length, 1);
    assert.strictEqual(h.ctx.state.ask, null);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · Delete');
{
  it('a used category is refused BEFORE any request, with the reason and the way out', async () => {
    const h = await loaded();
    h.CMD.finCatMore(1); h.CMD.askRun('delete');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.strictEqual(h.ctx.state.ask, null, 'nothing to confirm');
    assert.ok(h.text(h.screen()).includes('"Rent 房租" is used by 3 expenses. Hide it instead — hiding keeps those records exactly as they are.'));
  });
  it('an unused one asks first, danger-styled, then DELETEs', async () => {
    const h = await loaded();
    h.CMD.finCatMore(4); h.CMD.askRun('delete');
    assert.strictEqual(h.calls.writes.length, 0);
    const html = h.ctx.sheetAsk();
    assert.ok(h.text(html).includes('Delete this category? Nothing has been filed under it. This cannot be undone. Cancel Delete'));
    assert.ok(/color:var\(--brick-ink\)[^>]*onclick="APP\.cmd\('askRun',''\)">Delete/.test(html));
    h.CMD.askRun('');
    assert.deepStrictEqual(h.w(0), { p: '/finance/categories/4', method: 'DELETE', body: {} });
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
  });
  it('the server\'s in_use refusal still shows, and the list is re-read', async () => {
    const h = await loaded();
    h.CMD.finCatMore(4); h.CMD.askRun('delete'); h.CMD.askRun('');
    await no(h, 0, 'in_use');
    assert.ok(h.text(h.screen()).includes('in_use'));
    assert.strictEqual(h.calls.api.length, 2, 'read again so the counts are current');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('5 · every string is the desktop\'s');
{
  it('the pairs are live in 22-finance.js or its markup', () => {
    for (const [en, zh] of [['Could not load the categories.', '分类加载失败。'], ['Operating expense', '营业费用'],
      ['Restore', '启用'], ['Hide', '停用'], ['Delete', '删除'], ['Hidden', '已停用'], ['Not used', '未使用'],
      ['Hide this category?', '停用该分类？'], ['Delete this category?', '删除该分类？'], ['Category', '分类'],
      ['Not an operating expense', '不计入营业费用']]) {
      assert.ok(FIN.includes(`cuT('${en}', '${zh}')`), `${en} · ${zh}`);
    }
    for (const s of ['No categories yet. Add the ones this business spends money on — rent, wages.', '还没有分类。请新增本店的支出分类 — 租金、工资。',
      'It stops being offered when recording an expense.', 'Nothing has been filed under it. This cannot be undone.',
      'Hide it instead — hiding keeps those records exactly as they are.', '请改为停用 — 停用不会改动这些记录。',
      '`Used by ${count}`', '`${count} 条使用`']) assert.ok(FIN.includes(s), s);
    for (const p of ['Categories · 分类', 'Add · 添加', 'Rent · 租金',
      'Your own list. Expenses are filed against these, and only these are offered when someone records one. · 本店自己的分类列表。记录支出时只会显示这些分类。']) {
      assert.ok(DESK.includes(p), p);
    }
    const ADMIN = fs.readdirSync(path.join(ROOT, 'public/retail-admin')).map((f) => fs.readFileSync(path.join(ROOT, 'public/retail-admin', f), 'utf8')).join('\n');
    assert.ok(ADMIN.includes("cuT('Rename', '重命名')"), 'Rename · 重命名 is live on the desktop');
    assert.ok(M.includes("T('More','更多')"), 'More · 更多 is live on the phone');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
