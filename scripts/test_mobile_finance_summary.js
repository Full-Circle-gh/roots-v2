#!/usr/bin/env node
/**
 * §300 step F1 — THE FINANCE SUMMARY ON THE PHONE, asserted against the desktop.
 *
 *   node scripts/test_mobile_finance_summary.js
 *
 * The desktop module (public/retail-admin/22-finance.js) is the spec: the same
 * three reads, the same staircase in the same order, the same three cost
 * states, the same notes, the same strings. The phone code is RUN, sliced out
 * of public/m.html into a sandbox with a fake server whose answers the test
 * releases one at a time, so every request is asserted on its path and the
 * stale-answer guards can be exercised. No browser — fast shard.
 *
 * What it pins:
 *   1. who gets the screen — finance:view, failing CLOSED while caps are
 *      unknown, and never on the no-money boards;
 *   2. the staircase, in both languages, in each cost state, with and without
 *      tax, channels and excluded money; empty, loading and failed loads;
 *   3. the window — four presets on the store's day, Custom with no floor,
 *      the refusals the sheet gives before the server would, stale answers;
 *   4. a category's rows in a sheet, and a purchase order's items inside it;
 *   5. the sub-view strip: Summary, and Approvals only for who may approve.
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
  slice('const RECAP_NO_MONEY=', '\n', 0) + '\n' + slice('function recapNoMoney(){', '\n'),
  slice('function aprFresh(){', "reg('closeAsk',"),
  slice("reg('askRun', key=>{", "reg('copyWaybill'"),
  slice("reg('closeAsk',", '/* The live sheet'),
  slice('function sheetAsk(){', '/* A photo, full-screen.'),
  slice('const CAT_CJK=', "/* The claim's own day."),
  slice('/* ══════════════════════════════════════════════════════════════════════════\n   §300 — FINANCE ON THE PHONE', 'SUBS.stockadd='),
  slice('const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice('const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice('const shopDayAdd=', '/* The shop date of a value'),
  slice('const money0=', '\n'),
].join('\n');

const TODAY = '2026-09-30';

function mk(opts = {}) {
  const calls = { api: [], renders: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: {
      caps: opts.caps === undefined ? ['finance:view', 'expenses:approve'] : opts.caps,
      pos: opts.pos || null,
      ask: null, askErr: null,
      apr: { rows: [{ id: 1 }], tried: true, err: 'x', busy: 3, shot: 1, shotFor: 1 },
      fin: { view: 'summary', range: '30', from: null, to: null, data: null, err: '', tried: false, seq: 0,
             open: { rev: true, exp: true, excl: false }, cat: null, pol: null },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    shopToday: () => TODAY,
    tdWhen: (s) => 'D' + String(s).slice(5),          // 2026-09-01 → D09-01, a marker the test can read
    _tdL: () => ({ lang: 'en' }),
    screenApprovals: () => '<div>APPROVALS-SCREEN</div>',
    nothingYet: (t) => `<div>${t}</div>`,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const screen = () => ctx.SUBS.finance.render();
  const status = () => ctx.SUBS.finance.status();
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, screen, status, text, f: ctx.state.fin };
}
const tick = () => new Promise((r) => setImmediate(r));
async function answer(h, i, data) { h.calls.api[i].res(data); await tick(); }
async function refuse(h, i) { h.calls.api[i].rej(new Error('HTTP 500')); await tick(); }

const SUMMARY = () => ({
  window: { from: '2026-09-01', to: '2026-09-30', span_days: 30 },
  revenue: 128640,
  revenue_breakdown: [{ channel: 'wechat', amount: 61200 }, { channel: 'meituan', amount: 38410 },
    { channel: 'gzgrocery', amount: 7100 }, { channel: 'mystery', amount: 10 }],
  tax: { net: 7280 },
  cost_of_goods: 41020, gross_profit: 87620, cost_coverage: 0.886,
  operating_expenses: 27860,
  expense_breakdown: [
    { category: 'Rent 房租', amount: 24000, is_operating: 1 },
    { category: null, amount: 1000, is_operating: 1 },
    { category: 'Delivery & freight 运费', amount: 2860 },
    { category: 'Owner drawings 股东提款', amount: 5000, is_operating: 0 },
  ],
  non_operating_expenses: 5000,
  net: 100780,
});
async function loaded(opts, data) {
  const h = mk(opts);
  h.screen();
  await answer(h, 0, data || SUMMARY());
  return h;
}

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · who gets the screen');
{
  it('the route is finance:view, and the More row sits in Money and numbers', () => {
    const { ctx } = mk();
    assert.strictEqual(vm.runInContext('ROUTE_CAP.finance', ctx), 'finance:view');
    const grp = M.slice(M.indexOf("{h:['Money and numbers','营收与数据']"), M.indexOf("{h:['Send it out'"));
    assert.ok(grp.includes("['finance','landmark','Finance','财务']"));
    assert.ok(/Finance · 财务/.test(DESK), 'the desktop tab\'s own pair');
  });
  it('holding finance:view: yes', () => {
    assert.strictEqual(mk({ caps: ['finance:view'] }).ctx.canRoute('finance'), true);
  });
  it('without it: no', () => {
    assert.strictEqual(mk({ caps: ['orders:view', 'finance:record'] }).ctx.canRoute('finance'), false);
  });
  it('caps unknown: no — money fails closed (F0)', () => {
    assert.strictEqual(mk({ caps: null }).ctx.canRoute('finance'), false);
  });
  it('the three no-money boards: no, whatever their caps', () => {
    for (const pos of ['warehouse', 'dispatch', 'customer_service']) {
      assert.strictEqual(mk({ caps: ['finance:view'], pos }).ctx.canRoute('finance'), false, pos);
    }
    assert.strictEqual(mk({ caps: ['finance:view'], pos: 'store_manager' }).ctx.canRoute('finance'), true);
  });
  it('the push resets to Summary and re-reads, keeping the window', () => {
    const push = M.slice(M.indexOf('function push(route){'), M.indexOf('function pop(){'));
    assert.ok(/if\(route==='finance'\)\{ const f=state\.fin; f\.view='summary'; f\.tried=false; f\.err=''; f\.cat=null; f\.pol=null;/.test(push));
    assert.ok(/if\(route==='approvals'\) aprFresh\(\);/.test(push), 'Approvals still starts from nothing');
  });
  it('Back closes the category sheet before the screen', () => {
    const L = M.slice(M.indexOf('function layers(){'), M.indexOf('function syncHistory(){'));
    assert.ok(L.includes('if(state.fin.cat) L.push(()=>{ state.fin.cat=null; state.fin.pol=null; });'));
    assert.ok(M.includes("if(state.fin.cat) html += layer('fincat:'+state.fin.cat.i, sheetFinCat());"));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · the staircase');
{
  it('first paint: Loading…, and the desktop\'s 30 days on the store\'s day', () => {
    const h = mk();
    const t = h.text(h.screen());
    assert.ok(t.includes('Loading…'));
    assert.strictEqual(h.calls.api.length, 1);
    assert.strictEqual(h.calls.api[0].p, '/finance/summary?from=2026-09-01&to=2026-09-30');
    assert.strictEqual(h.status(), 'D09-01 – D09-30 · 30 days');
    h.screen();
    assert.strictEqual(h.calls.api.length, 1, 'one read, not one per paint');
  });
  it('every step, in the desktop\'s order, with its figure', async () => {
    const h = await loaded();
    const t = h.text(h.screen());
    const order = ['Revenue ¥128,640', 'WeChat ¥61,200', 'Meituan ¥38,410', 'Gzgrocery ¥7,100', 'mystery ¥10',
      'Orders only — wallet money counts when spent, not when topped up.',
      'of which tax ¥7,280', 'Cost of goods − ¥41,020', 'Gross profit ¥87,620',
      "Cost recorded for 88% of this period's revenue — the real margin is lower.",
      'Operating expenses − ¥27,860', 'Rent ¥24,000', 'Not recorded ¥1,000', 'Delivery & freight ¥2,860',
      'Net ¥100,780', 'Not an operating expense ¥5,000', 'Recorded, and not counted in the figures above.'];
    let at = -1;
    for (const s of order) {
      const i = t.indexOf(s);
      assert.ok(i > at, `"${s}" missing or out of order in: ${t}`);
      at = i;
    }
  });
  it('the excluded block is closed, like the desktop\'s <details>, and opens', async () => {
    const h = await loaded();
    assert.ok(!h.text(h.screen()).includes('Owner drawings'));
    h.CMD.finToggle('excl');
    assert.ok(h.text(h.screen()).includes('Owner drawings ¥5,000'));
  });
  it('Revenue and Operating expenses close and open', async () => {
    const h = await loaded();
    h.CMD.finToggle('rev'); h.CMD.finToggle('exp');
    const t = h.text(h.screen());
    assert.ok(!t.includes('WeChat') && !t.includes('Rent'));
    assert.ok(t.includes('Revenue ¥128,640') && t.includes('Operating expenses − ¥27,860'), 'the totals stay');
  });
  it('a category line opens its sheet; a channel line is not a control', async () => {
    const h = await loaded();
    const html = h.screen();
    assert.ok(/onclick="APP\.cmd\('finCat',0\)"[\s\S]*Rent/.test(html));
    assert.ok(/onclick="APP\.cmd\('finCat',2\)"/.test(html), 'indexed into the WHOLE breakdown');
    assert.strictEqual((html.match(/APP\.cmd\('finCat',/g) || []).length, 3, 'one control per operating category, none for a channel');
  });
  it('in Chinese: the desktop\'s Chinese, and each category\'s Chinese half', async () => {
    const h = await loaded({ lang: 'zh' });
    const t = h.text(h.screen());
    for (const s of ['营收 ¥128,640', '微信', '美团', 'Gzgrocery', '仅计订单 —— 储值在消费时计入，充值时不计入。',
      '其中税费', '销货成本 − ¥41,020', '毛利润', '此期间 88% 的营收已记录成本 —— 实际毛利更低。',
      '营业费用', '房租 ¥24,000', '未记录 ¥1,000', '运费', '净额 ¥100,780', '不计入营业费用', '已记录，未计入上方数字。']) {
      assert.ok(t.includes(s), `missing ${s}`);
    }
    assert.ok(!t.includes('Rent'));
  });
  it('no cost at all: both rows read Not recorded, no minus, one sentence', async () => {
    const d = SUMMARY(); d.cost_of_goods = null; d.gross_profit = null; d.cost_coverage = 0;
    const h = await loaded({}, d);
    const t = h.text(h.screen());
    assert.ok(t.includes('Cost of goods Not recorded'), 'no "− Not recorded"');
    assert.ok(t.includes('Gross profit Not recorded'));
    assert.strictEqual(t.split('This period has no recorded cost data.').length, 2, 'said once, for both');
    assert.ok(!t.includes('Cost recorded for'));
  });
  it('all of it costed: the figures and nothing under them', async () => {
    const d = SUMMARY(); d.cost_coverage = 1;
    const h = await loaded({}, d);
    const t = h.text(h.screen());
    assert.ok(t.includes('Cost of goods − ¥41,020'));
    assert.ok(!t.includes('Cost recorded for') && !t.includes('no recorded cost'));
  });
  it('coverage is floored: 99.6% says 99, never 100', async () => {
    const d = SUMMARY(); d.cost_coverage = 0.996;
    const h = await loaded({}, d);
    assert.ok(h.text(h.screen()).includes('Cost recorded for 99%'));
  });
  it('no tax charged: no tax row; no channels: a plain Revenue row; nothing excluded: no block', async () => {
    const d = SUMMARY(); d.tax = null; d.revenue_breakdown = []; d.non_operating_expenses = 0;
    d.expense_breakdown = d.expense_breakdown.filter((r) => r.is_operating !== 0);
    const h = await loaded({}, d);
    const html = h.screen(); const t = h.text(html);
    assert.ok(!t.includes('of which tax'));
    assert.ok(!html.includes("APP.cmd('finToggle','rev')"), 'no chevron over nothing');
    assert.ok(t.includes('Revenue ¥128,640'));
    assert.ok(!t.includes('Not an operating expense'));
  });
  it('an empty period reads as zeroes — never a mock, never a blank', async () => {
    const d = { window: { from: '2026-09-30', to: '2026-09-30' }, revenue: 0, revenue_breakdown: [], tax: null,
      cost_of_goods: null, gross_profit: null, cost_coverage: null, operating_expenses: 0,
      expense_breakdown: [], non_operating_expenses: 0, net: 0 };
    const h = await loaded({}, d);
    const html = h.screen(); const t = h.text(html);
    assert.ok(t.includes('Revenue ¥0') && t.includes('Operating expenses − ¥0') && t.includes('Net ¥0'));
    assert.ok(!html.includes('finToggle') && !html.includes('finCat'));
  });
  it('a negative net prints its sign', async () => {
    const d = SUMMARY(); d.net = -1234;
    const h = await loaded({}, d);
    assert.ok(h.text(h.screen()).includes('Net ¥-1,234'));
  });
  it('a failed read says so where the operator is looking, with a retry', async () => {
    const h = mk();
    h.screen();
    await refuse(h, 0);
    const html = h.screen(); const t = h.text(html);
    assert.ok(t.includes('Could not load Finance.'));
    assert.ok(/onclick="APP\.cmd\('finRetry'\)">Try again/.test(html));
    assert.ok(!t.includes('Revenue'), 'a failed card never renders as an empty one');
    h.CMD.finRetry(); h.screen();
    assert.strictEqual(h.calls.api.length, 2);
    await answer(h, 1, SUMMARY());
    assert.ok(h.text(h.screen()).includes('Revenue ¥128,640'));
  });
  it('a failed REFRESH keeps the figures, with the banner above them', async () => {
    const h = await loaded();
    h.CMD.finRange('7'); h.screen();
    await refuse(h, 1);
    const t = h.text(h.screen());
    assert.ok(t.indexOf('Could not load Finance.') < t.indexOf('Revenue ¥128,640'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · the window');
{
  it('the chips are the desktop\'s four presets and Custom', () => {
    const h = mk();
    const t = h.text(h.screen());
    assert.ok(/Today 7 days 30 days 90 days Custom/.test(t));
    for (const p of ['Today · 今日', '7 days · 7天', '30 days · 30天', '90 days · 90天', 'Apply · 应用']) assert.ok(DESK.includes(p), p);
    const z = mk({ lang: 'zh' });
    assert.ok(/今日 7天 30天 90天 自定义/.test(z.text(z.screen())));
  });
  it('each preset asks for its own window, ending on the store\'s today', async () => {
    for (const [k, from] of [['today', '2026-09-30'], ['7', '2026-09-24'], ['90', '2026-07-03']]) {
      const h = await loaded();
      h.CMD.finRange(k); h.screen();
      assert.strictEqual(h.calls.api[1].p, `/finance/summary?from=${from}&to=2026-09-30`, k);
    }
    const h = mk(); h.CMD.finRange('today');
    assert.strictEqual(h.status(), 'D09-30 · today');
  });
  it('90 days reaches back past 1 August — no floor (§36)', async () => {
    const h = await loaded(); h.CMD.finRange('90'); h.screen();
    assert.ok(h.calls.api[1].p.includes('from=2026-07-03'));
  });
  it('Custom opens a sheet with two dates, prefilled, and Apply; nothing is read yet', async () => {
    const h = await loaded();
    h.CMD.finRange('custom');
    const html = h.ctx.sheetAsk();
    assert.ok(html.includes('>Custom<'));
    assert.ok(/From[\s\S]*id="ask-from" type="date"[^>]*value="2026-09-01"/.test(html));
    assert.ok(/To[\s\S]*id="ask-to" type="date"[^>]*value="2026-09-30"/.test(html));
    assert.ok(!/id="ask-from"[^>]*min=/.test(html), 'no min on the field');
    assert.ok(/>Apply</.test(html));
    assert.strictEqual(h.calls.api.length, 1);
  });
  const withDates = (h, from, to) => {
    h.ctx.document = { getElementById: (id) => ({ value: id === 'ask-from' ? from : to }) };
    vm.runInContext('0', h.ctx);
  };
  it('Custom refuses an inverted window before the server would', async () => {
    const h = await loaded();
    h.CMD.finRange('custom');
    withDates(h, '2026-09-10', '2026-09-01');
    h.CMD.askRun('');
    assert.strictEqual(h.ctx.state.askErr, 'From is after to');
    assert.ok(h.ctx.state.ask, 'the sheet stays open with the reason');
    assert.strictEqual(h.calls.api.length, 1);
  });
  it('…and an empty date', async () => {
    const h = await loaded();
    h.CMD.finRange('custom');
    withDates(h, '', '2026-09-01');
    h.CMD.askRun('');
    assert.strictEqual(h.ctx.state.askErr, 'Pick a date');
  });
  it('Apply reads the window chosen — May included — and the status says it', async () => {
    const h = await loaded();
    h.CMD.finRange('custom');
    withDates(h, '2026-05-01', '2026-05-31');
    h.CMD.askRun(''); h.screen();
    assert.strictEqual(h.calls.api[1].p, '/finance/summary?from=2026-05-01&to=2026-05-31');
    assert.strictEqual(h.f.range, 'custom');
    assert.strictEqual(h.status(), 'D05-01 – D05-31 · 31 days');
    assert.ok(/class="chip on"[^>]*onclick="APP\.cmd\('finRange','custom'\)"/.test(h.screen()), 'Custom is the lit chip');
  });
  it('a custom pick that IS a preset lights the preset', async () => {
    const h = await loaded();
    h.CMD.finRange('custom');
    withDates(h, '2026-09-24', '2026-09-30');
    h.CMD.askRun('');
    assert.strictEqual(h.f.range, '7');
  });
  it('a slow answer for the old window never paints over the new one', async () => {
    const h = mk();
    h.screen();                       // read #1, 30 days
    h.CMD.finRange('7'); h.screen();  // read #2, 7 days
    await answer(h, 1, Object.assign(SUMMARY(), { revenue: 7 }));
    await answer(h, 0, Object.assign(SUMMARY(), { revenue: 30 }));
    assert.ok(h.text(h.screen()).includes('Revenue ¥7'));
  });
  it('moving the window closes an open category', async () => {
    const h = await loaded();
    h.CMD.finCat(0);
    h.CMD.finRange('7'); h.screen();
    assert.strictEqual(h.f.cat, null);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · a category, and a purchase order inside it');
const ROWS = [
  { id: 5, source: 'po', date: '2026-09-29', note: 'RPO-0234 · Levant Foods · 2 lines', po_number: 'RPO-0234', lines: 2, amount: 40 },
  { id: 6, source: 'po', date: '2026-09-28', note: 'RPO-0235 · landed', po_number: 'RPO-0235', lines: 0, amount: 12 },
  { id: 7, source: 'claim', paid_by: 'employee', date: '2026-09-27', note: 'Taxi to the market', amount: 38 },
  { id: 8, source: 'claim', paid_by: 'company', date: '2026-09-26', note: 'Van', amount: 260 },
  { id: 9, source: 'delay_case', date: '2026-09-25', note: 'SF late', amount: 20 },
  { id: 10, source: 'return', date: '2026-09-22', note: 'SF express refund', amount: -18 },
  { id: 11, source: 'typed', date: '2026-09-01', note: '', amount: 2540 },
];
{
  it('opens a sheet and reads the rows for that category over the window ON SCREEN', async () => {
    const h = await loaded();
    h.f.data.window = { from: '2026-08-01', to: '2026-08-31' };   // the figures' window, not the chips'
    h.CMD.finCat(2);
    assert.strictEqual(h.calls.api[1].p, '/finance/summary/category?from=2026-08-01&to=2026-08-31&category=Delivery%20%26%20freight%20%E8%BF%90%E8%B4%B9');
    const t = h.text(h.ctx.sheetFinCat());
    assert.ok(t.includes('Delivery & freight'), 'titled by its label');
    assert.ok(t.includes('D08-01 – D08-31 · 31 days · ¥2,860'));
    assert.ok(t.includes('Loading…'));
  });
  it('the uncategorised line asks with an EMPTY category, and is titled Not recorded', async () => {
    const h = await loaded();
    h.CMD.finCat(1);
    assert.ok(h.calls.api[1].p.endsWith('&category='));
    assert.ok(h.text(h.ctx.sheetFinCat()).startsWith('Not recorded'));
  });
  it('each kind of row, with the desktop\'s mark and its amount to the fen', async () => {
    const h = await loaded();
    h.CMD.finCat(2);
    await answer(h, 1, { rows: ROWS });
    const html = h.ctx.sheetFinCat(); const t = h.text(html);
    for (const s of ['RPO-0234 · Levant Foods · 2 lines D09-29 · Posted by Purchasing ¥40.00',
      'Taxi to the market D09-27 · Staff claim · own money ¥38.00', 'Van D09-26 · Staff claim ¥260.00',
      'SF late D09-25 · Carrier claim ¥20.00', 'SF express refund D09-22 · Return ¥-18.00', 'D09-01 ¥2,540.00']) {
      assert.ok(t.includes(s), `missing "${s}" in ${t}`);
    }
    assert.ok(/onclick="APP\.cmd\('finPol',5\)"/.test(html), 'a PO row with items opens');
    assert.ok(!/APP\.cmd\('finPol',6\)/.test(html), 'a landed-cost row with no items does not');
    assert.ok(!/APP\.cmd\('finPol',7\)/.test(html), 'nor a claim');
  });
  it('the marks are the desktop\'s, in Chinese too', async () => {
    const h = await loaded({ lang: 'zh' });
    h.CMD.finCat(2);
    await answer(h, 1, { rows: ROWS });
    const t = h.text(h.ctx.sheetFinCat());
    for (const s of ['采购单自动记入', '费用申请 · 个人支付', '承运商赔偿', '退货']) assert.ok(t.includes(s), s);
  });
  it('a failed read and an empty one each say so', async () => {
    const a = await loaded(); a.CMD.finCat(0); await refuse(a, 1);
    assert.ok(a.text(a.ctx.sheetFinCat()).includes('Could not load Finance.'));
    const b = await loaded(); b.CMD.finCat(0); await answer(b, 1, { rows: [] });
    assert.ok(b.text(b.ctx.sheetFinCat()).includes('Nothing recorded yet'));
  });
  it('a stale category answer is dropped', async () => {
    const h = await loaded();
    h.CMD.finCat(0); h.CMD.finCat(2);
    await answer(h, 1, { rows: [{ id: 99, source: 'typed', date: '2026-09-01', note: 'WRONG', amount: 1 }] });
    assert.ok(!h.text(h.ctx.sheetFinCat()).includes('WRONG'));
  });
  it('a PO row opens its items: name by language, qty × unit cost, amount', async () => {
    const h = await loaded();
    h.CMD.finCat(2); await answer(h, 1, { rows: ROWS });
    h.CMD.finPol(5);
    assert.strictEqual(h.calls.api[2].p, '/finance/summary/po-lines?entry_id=5');
    assert.ok(h.text(h.ctx.sheetFinCat()).includes('Loading…'));
    await answer(h, 2, { rows: [{ name_en: 'Freight jar', name_cn: '运费罐', qty: 200, unit: 'pc', unit_cost: 3.5, amount: 700 },
      { name_cn: '只有中文', qty: 1.25, unit_cost: 2, amount: 2.5 }] });
    const t = h.text(h.ctx.sheetFinCat());
    assert.ok(t.includes('Freight jar 200 pc × ¥3.50 ¥700.00'));
    assert.ok(t.includes('只有中文 1.25 × ¥2.00 ¥2.50'), 'the other language when a line has only one');
    h.CMD.finPol(5);
    assert.ok(!h.text(h.ctx.sheetFinCat()).includes('Freight jar'), 'a second tap shuts it');
  });
  it('a PO read that fails, or holds nothing, says so', async () => {
    const h = await loaded();
    h.CMD.finCat(2); await answer(h, 1, { rows: ROWS });
    h.CMD.finPol(5); await refuse(h, 2);
    assert.ok(h.text(h.ctx.sheetFinCat()).includes('Could not load Finance.'));
    h.CMD.finPol(5); h.CMD.finPol(5); await answer(h, 3, { rows: [] });
    assert.ok(h.text(h.ctx.sheetFinCat()).includes('Nothing recorded yet'));
  });
  it('Close shuts the sheet and the order inside it', async () => {
    const h = await loaded();
    h.CMD.finCat(2); h.CMD.finPol(5); h.CMD.closeFinCat();
    assert.strictEqual(h.f.cat, null); assert.strictEqual(h.f.pol, null);
    assert.strictEqual(h.ctx.sheetFinCat(), '');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('5 · the sub-view strip');
{
  it('Summary, Transactions and Approvals — and nothing that does not exist yet', () => {
    const h = mk();
    const t = h.text(h.screen());
    assert.ok(t.startsWith('Summary Transactions Approvals'));
    assert.ok(!/Categories/.test(t));
    assert.ok(DESK.includes('Summary · 汇总') && DESK.includes('Transactions · 交易记录') && DESK.includes('Approvals · 审批'));
  });
  it('Approvals renders the Approvals screen this app has, from a fresh queue', () => {
    const h = mk();
    h.CMD.finView('approvals');
    const t = h.text(h.screen());
    assert.ok(t.includes('APPROVALS-SCREEN'));
    assert.strictEqual(h.ctx.state.apr.rows, null); assert.strictEqual(h.ctx.state.apr.tried, false);
    assert.strictEqual(h.status(), '', 'no money window over the queue');
    assert.strictEqual(h.calls.api.length, 0, 'and no summary read');
    h.CMD.finView('summary');
    assert.ok(h.text(h.screen()).includes('Loading…'));
  });
  it('without expenses:approve: no Approvals tab, and it cannot be forced', () => {
    const h = mk({ caps: ['finance:view'] });
    assert.ok(!h.text(h.screen()).includes('Approvals'));
    assert.ok(h.text(h.screen()).startsWith('Summary Transactions Today'));
    h.CMD.finView('approvals');
    assert.strictEqual(h.f.view, 'summary');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('6 · every string is the desktop\'s (or a named live pair)');
{
  it('the staircase\'s pairs are live in 22-finance.js', () => {
    for (const [en, zh] of [['Revenue', '营收'], ['Operating expenses', '营业费用'], ['of which tax', '其中税费'],
      ['Cost of goods', '销货成本'], ['Gross profit', '毛利润'], ['Not recorded', '未记录'], ['Net', '净额'],
      ['Not an operating expense', '不计入营业费用'], ['Could not load Finance.', '财务数据加载失败。'],
      ['Nothing recorded yet', '暂无记录'], ['Posted by Purchasing', '采购单自动记入'], ['Staff claim', '费用申请'],
      ['Staff claim · own money', '费用申请 · 个人支付'], ['Carrier claim', '承运商赔偿'], ['Return', '退货'],
      ['today', '今日'], ['WeChat', '微信'], ['Web shop', '网页商店'], ['Pick up', '到店自取'], ['Manual', '手动']]) {
      assert.ok(FIN.includes(`cuT('${en}', '${zh}')`), `${en} · ${zh}`);
    }
    for (const s of ['This period has no recorded cost data.', '此期间未记录成本数据。',
      'Orders only — wallet money counts when spent, not when topped up.', '仅计订单 —— 储值在消费时计入，充值时不计入。',
      'Recorded, and not counted in the figures above.', '已记录，未计入上方数字。',
      '% of this period\'s revenue — the real margin is lower.', '的营收已记录成本 —— 实际毛利更低。']) {
      assert.ok(FIN.includes(s), s);
    }
  });
  it('the rest are live elsewhere, named in the vocabulary document', () => {
    const W = fs.readFileSync(path.join(ROOT, 'public/retail-admin/20-waste.js'), 'utf8');
    assert.ok(W.includes("T('From', '从')") && W.includes("T('To', '至')"));
    assert.ok(M.includes("T('Custom','自定义')") && M.includes("T('Pick a date','选日期')") && M.includes("T('Try again','重试')"));
    const S = fs.readFileSync(path.join(ROOT, 'routes/finance-summary.js'), 'utf8');
    assert.ok(S.includes("'from is after to · 起始日期晚于结束日期'"));
    assert.ok(fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8').includes('## The Finance summary on the phone ('));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
