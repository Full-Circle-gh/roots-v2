#!/usr/bin/env node
/**
 * §300 step F5 — WHAT THE DESKTOP'S REPORTS HAS THAT THE PHONE'S TREND LACKED.
 *
 *   node scripts/test_mobile_trend_reports.js
 *
 * Trend and the desktop's Reports read one payload (/dashboard). The survey
 * listed what only the desktop could do with it: a custom window, a store
 * select, the demand heatmap, retention, and the AI's read and Ask
 * (public/retail-admin/03-dashboard.js). This runs the phone's code for each,
 * sliced out of public/m.html into a sandbox with a fake server whose answers
 * the test releases one at a time. No browser — fast shard. (The rendering of
 * the rest of Trend stays with scripts/test_mobile_trend.js.)
 *
 * What it pins:
 *   1. the window — Custom's sheet and its refusals, the request it makes;
 *   2. the store — the picker only with several stores, a store-scoped
 *      operator pinned to theirs and offered no picker;
 *   3. the heatmap and retention, computed as the desktop computes them;
 *   4. the read and Ask — the desktop's request and digest, gated on
 *      reports:view (closed while caps are unknown) and off the no-money boards;
 *   5. the strings.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'public/retail-admin/03-dashboard.js'), 'utf8');
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
  slice("reg('askRun', key=>{", "reg('copyWaybill'"),
  slice("reg('closeAsk',", '/* The live sheet'),
  slice('function sheetAsk(){', '/* A photo, full-screen.'),
  slice('const RECAP_NO_MONEY=', '\n') + '\n' + slice('function recapNoMoney(){', '\n'),
  slice('function mStoreName(st){', '\n}\n') + '\n}\n',
  slice('const TREND_RANGES=', '/* A line, and nothing else'),
  // statusTrend and screenTrend, and the F5 block that follows them, to Team.
  slice('function statusTrend(){', '/* ==========================================================================\n   Team'),
  slice("reg('trendRange', v=>{", "reg('trendMetric'"),
  slice('const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
].join('\n');

const TODAY = '2026-09-30';

function mk(opts = {}) {
  const calls = { api: [], writes: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: () => '<i></i>',
    state: {
      caps: opts.caps === undefined ? ['dashboard:view', 'reports:view'] : opts.caps,
      pos: opts.pos || null, ask: null, askErr: null,
      stores: opts.stores === undefined ? [{ id: 1, name_en: 'Tianhe', name_cn: '天河店' }, { id: 2, name_en: 'Panyu', name_cn: '番禺店' }] : opts.stores,
      storeLock: opts.storeLock || null,
      trend: null, trendFull: null, trendKey: null, trendErr: null, trendRange: '7', trendMetric: 'revenue',
      trendFrom: null, trendTo: null, trendStore: '', trendStoresTried: true, trendOpen: {},
      trendRead: { key: null, data: null, loading: false, unavailable: false, error: false },
      trendAsk: { log: [], busy: false, q: '' },
    },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    CMD,
    shopToday: () => TODAY,
    tdWhen: (s, kind) => (kind === 'time' ? 'T' + String(s).slice(11, 16) : 'D' + String(s).slice(5, 10)),
    _tdL: () => ({}),
    fmtDateOnly: (s) => 'D' + String(s).slice(5),
    money0: (c, n) => c + Math.round(Number(n || 0)).toLocaleString(),
    sparkline: () => '<svg></svg>',
    trendSections: () => [], trendBestDow: () => null,
    noteBar: (t) => `<div>${t}</div>`,
    nothingYet: (t) => `<div>${t}</div>`,
    E: (en) => ({ toString() { return en; } }),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Date, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state, screen: () => ctx.screenTrend() };
}
const tick = () => new Promise((r) => setImmediate(r));
const PAY = () => ({
  window: { from: '2026-09-24', to: '2026-09-30', span_days: 7 },
  trend: [{ bucket: '2026-09-29', revenue: 100, orders: 3, visits: 9 }, { bucket: '2026-09-30', revenue: 200, orders: 5, visits: 12 }],
  deltas: { revenue: 12, orders: -3, visits: null },
  kpis: { revenue: 300.456, orders: 8, aov: 37.5, buyers: 6, new_customers: 2, visits: 21, sessions: 20, visitors: 15,
          mini_app_orders: 4, conversion_rate: 20, refund_rate: 0.6, cancelled_orders: 1, refunded_orders: 0 },
  funnel: { paid: { n: 5, revenue: 250 } },
  payments: [{ method: 'wechat', orders: 5, revenue: 250 }],
  heat: [{ dow: 5, hour: 12, orders: 9, revenue: 300 }, { dow: 1, hour: 9, orders: 2, revenue: 40 }, { dow: 3, hour: 18, orders: 4, revenue: 90 }],
  cohortSizes: [{ cohort_month: '2026-07', size: 100 }, { cohort_month: '2026-09', size: 50 }],
  cohorts: [{ cohort_month: '2026-07', active_month: '2026-08', active_customers: 40 },
            { cohort_month: '2026-07', active_month: '2026-07', active_customers: 100 },
            { cohort_month: '2026-09', active_month: '2026-09', active_customers: 50 }],
  traffic: { scenes: [{ scene: 1007, visits: 12 }, { scene: 4242, visits: 1 }] },
  new_vs_returning: { new: 2, returning: 4 },
});
async function loaded(opts, data) {
  const h = mk(opts);
  h.screen();
  h.calls.api[0].res(data || PAY()); await tick();
  return h;
}

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · a custom window');
{
  it('the range chips gain Custom, and the first read is the preset\'s, unscoped, keyed as before', () => {
    const h = mk({ stores: [] });
    const t = h.text(h.screen());
    assert.ok(t.includes('7 days 30 days 90 days Custom'));
    assert.strictEqual(h.calls.api[0].p, '/dashboard?from=2026-09-24&to=2026-09-30');
    assert.strictEqual(h.s.trendKey, '7', 'a preset with no store is still keyed by its name');
  });
  it('Custom opens two dates and Apply, and reads nothing yet', () => {
    const h = mk();
    h.CMD.trendRange('custom');
    const html = h.ctx.sheetAsk();
    assert.ok(h.text(html).startsWith('Custom From To'));
    assert.ok(/id="ask-from" type="date"[^>]*value="2026-09-24"/.test(html) && /id="ask-to" type="date"[^>]*value="2026-09-30"/.test(html));
    assert.ok(h.text(html).includes('Apply'));
    assert.strictEqual(h.calls.api.length, 0);
    assert.strictEqual(h.s.trendRange, '7');
  });
  const pick = (h, from, to) => { h.ctx.document.getElementById = (id) => ({ value: id === 'ask-from' ? from : to }); h.CMD.askRun(''); };
  it('an inverted window and an empty day are refused on the sheet', () => {
    const h = mk();
    h.CMD.trendRange('custom'); pick(h, '2026-09-10', '2026-09-01');
    assert.strictEqual(h.s.askErr, 'From is after to');
    pick(h, '', '2026-09-01');
    assert.strictEqual(h.s.askErr, 'Pick a date');
    assert.strictEqual(h.calls.api.length, 0);
  });
  it('Apply reads the chosen days; the status line names them and the delta line counts them', async () => {
    const h = mk({ stores: [] });
    h.CMD.trendRange('custom'); pick(h, '2026-08-01', '2026-08-31');
    assert.strictEqual(h.calls.api[0].p, '/dashboard?from=2026-08-01&to=2026-08-31');
    assert.strictEqual(h.s.trendRange, 'custom');
    h.calls.api[0].res(PAY()); await tick();
    assert.ok(h.ctx.statusTrend().endsWith('· D08-01 – D08-31'));
    assert.ok(h.text(h.screen()).includes('vs prior 31 days'));
  });
  it('a custom pick that is a preset lights the preset', () => {
    const h = mk();
    h.CMD.trendRange('custom'); pick(h, '2026-09-01', '2026-09-30');
    assert.strictEqual(h.s.trendRange, '30');
  });
  it('choosing a preset again clears the custom days', () => {
    const h = mk();
    h.CMD.trendRange('custom'); pick(h, '2026-08-01', '2026-08-31');
    h.CMD.trendRange('90');
    assert.strictEqual(h.s.trendFrom, null);
    assert.ok(h.calls.api[1].p.startsWith('/dashboard?from=2026-07-03&to=2026-09-30'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · the store');
{
  it('with several stores: All stores and each store, by name in this language', () => {
    const h = mk();
    const html = h.screen();
    assert.ok(/<select aria-label="Store"[^>]*onchange="APP\.cmd\('trendStore',this\.value\)"/.test(html));
    assert.ok(h.text(html).includes('All stores Tianhe Panyu'));
    assert.ok(DESK.includes('All stores · 全部门店') || DASH.includes("'<option value=\"\">All stores · 全部门店</option>'"), 'the desktop pair');
  });
  it('picking one scopes the read and names it in the status line', async () => {
    const h = mk();
    h.screen();
    h.CMD.trendStore('2');
    assert.strictEqual(h.calls.api[1].p, '/dashboard?from=2026-09-24&to=2026-09-30&store_id=2');
    h.calls.api[1].res(PAY()); await tick();
    assert.ok(h.ctx.statusTrend().endsWith('· last 7 days · Panyu'));
  });
  it('one store: no picker', () => {
    const h = mk({ stores: [{ id: 1, name_en: 'Tianhe' }] });
    assert.ok(!h.screen().includes("APP.cmd('trendStore'"));
  });
  it('a store-scoped operator is pinned to their store on every read, and offered no picker', () => {
    const h = mk({ storeLock: '1' });
    const html = h.screen();
    assert.ok(!html.includes("APP.cmd('trendStore'"));
    assert.strictEqual(h.calls.api[0].p, '/dashboard?from=2026-09-24&to=2026-09-30&store_id=1');
    h.CMD.trendStore('2');
    assert.strictEqual(h.calls.api.length, 1, 'the pin cannot be changed');
    assert.ok(M.includes("state.storeLock=(Array.isArray(u.scopeStores)&&u.scopeStores.length)?String(u.scopeStores[0]):null;"), 'read from /me, as RA_STORE_LOCK is');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · the heatmap and retention');
{
  it('the heatmap: 7 rows of 24, the busiest hour named, orders only', async () => {
    const h = await loaded();
    const html = h.ctx.trendHeatCard(); const t = h.text(html);
    assert.ok(t.startsWith('Demand heatmap orders by hour'));
    assert.strictEqual((html.match(/<i style="flex:1;height:12px/g) || []).length, 168);
    assert.ok(t.includes('Busiest: Friday 12:00'));
    assert.ok(!t.includes('¥'), 'no money on it');
    const z = await loaded({ lang: 'zh' });
    assert.ok(z.text(z.ctx.trendHeatCard()).includes('最忙：周五 12:00'));
  });
  it('the heatmap with no orders says so', async () => {
    const d = PAY(); d.heat = [];
    const h = await loaded({}, d);
    assert.ok(h.text(h.ctx.trendHeatCard()).includes('No orders in range'));
  });
  it('retention: the desktop\'s weighted curve, month 1 / 3 / 6 / 12', async () => {
    const h = await loaded();
    const curve = h.ctx.trendRetCurve(h.s.trendFull);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(curve)), [{ offset: 0, pct: 100 }, { offset: 1, pct: 40 }, { offset: 2, pct: 0 }]);
    const t = h.text(h.ctx.trendRetCard());
    assert.ok(t.startsWith('Retention weighted, all cohorts'));
    assert.ok(t.includes('40% month 1') && t.includes('— month 3') && t.includes('— month 12'));
  });
  it('retention with no history says so', async () => {
    const d = PAY(); d.cohortSizes = []; d.cohorts = [];
    const h = await loaded({}, d);
    assert.ok(h.text(h.ctx.trendRetCard()).includes('Not enough history yet'));
  });
  it('both render on the screen for a Trend reader with no reports:view', async () => {
    const h = await loaded({ caps: ['dashboard:view'] });
    const t = h.text(h.screen());
    assert.ok(t.includes('Demand heatmap') && t.includes('Retention'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · the read and Ask');
{
  it('once the window\'s numbers are here, the read is asked for — the desktop\'s body', async () => {
    const h = await loaded();
    h.screen();
    assert.strictEqual(h.calls.writes.length, 1);
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/reports/read');
    assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(Object.keys(w.body), ['from', 'to', 'store_id', 'digest']);
    assert.strictEqual(w.body.from, '2026-09-24'); assert.strictEqual(w.body.to, '2026-09-30'); assert.strictEqual(w.body.store_id, '');
    assert.ok(h.text(h.screen()).includes('Reading the numbers…'));
    h.screen();
    assert.strictEqual(h.calls.writes.length, 1, 'once per window, not once per paint');
  });
  it('the digest is dashAiDigest\'s, field for field', async () => {
    const h = await loaded();
    h.screen();
    const d = h.calls.writes[0].body.digest;
    assert.deepStrictEqual(Object.keys(d), ['currency', 'window', 'kpis', 'change_vs_prior_window_pct', 'order_status', 'payments',
      'delivery_modes', 'revenue_composition', 'wallet', 'busiest_hours', 'top_products', 'top_customers', 'buyers_new_vs_returning',
      'top_cities', 'vouchers', 'points', 'checkout', 'retention_pct_by_months_since_first_order', 'traffic_scenes', 'article_views']);
    const body = DASH.slice(DASH.indexOf('function dashAiDigest()'), DASH.indexOf('async function dashReadMaybeLoad'));
    const deskKeys = [...body.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);
    assert.deepStrictEqual(Object.keys(d), deskKeys, 'the same top-level keys, in the desktop\'s order');
    assert.strictEqual(d.kpis.revenue, 300.46);
    assert.deepStrictEqual(d.busiest_hours[0], { weekday: 'Friday', hour: 12, orders: 9 });
    assert.deepStrictEqual(d.retention_pct_by_months_since_first_order, [{ month: 0, pct: 100 }, { month: 1, pct: 40 }, { month: 2, pct: 0 }]);
    assert.deepStrictEqual(d.traffic_scenes, [{ source: 'Single chat card', visits: 12 }, { source: 'scene 4242', visits: 1 }]);
    const scenes = [...DASH.matchAll(/^ {2}(\d{4}): \['([^']+)'/gm)].map((m) => [Number(m[1]), m[2]]);
    const phone = vm.runInContext('TREND_SCENE_EN', h.ctx);
    for (const [k, en] of scenes) assert.strictEqual(phone[k], en, 'scene ' + k);
    assert.strictEqual(Object.keys(phone).length, scenes.length);
  });
  it('the read, in this language, with the desktop\'s head and foot', async () => {
    const h = await loaded();
    h.screen();
    h.calls.writes[0].res({ success: true, data: { available: true, generated_at: '2026-09-30 09:14:00',
      read: { read_en: 'Sales held.\nFriday lunch carried the week.', read_cn: '销售平稳。' } } });
    await tick();
    const t = h.text(h.ctx.trendReadCard());
    assert.ok(t.startsWith('The read written at T09:14 Sales held. Friday lunch carried the week.'));
    assert.ok(t.endsWith('Drawn from the numbers in this report — nothing else. Refreshes with the range, at most twice a day.'));
    const z = await loaded({ lang: 'zh' }); z.screen();
    z.calls.writes[0].res({ success: true, data: { available: true, read: { read_en: 'x', read_cn: '销售平稳。' } } }); await tick();
    assert.ok(z.text(z.ctx.trendReadCard()).includes('解读 由本期数据生成 销售平稳。'));
  });
  it('no AI configured: no read and no Ask, and it is never asked again', async () => {
    const h = await loaded();
    h.screen();
    h.calls.writes[0].res({ success: true, data: { available: false } }); await tick();
    assert.strictEqual(h.ctx.trendReadCard(), '');
    assert.strictEqual(h.ctx.trendAskCard(), '');
    h.CMD.trendRange('30'); h.calls.api[1].res(PAY()); await tick(); h.screen();
    assert.strictEqual(h.calls.writes.length, 1);
  });
  it('a failed read is hidden, not apologised for; Ask still offered', async () => {
    const h = await loaded();
    h.screen();
    h.calls.writes[0].rej(new Error('read_failed')); await tick();
    assert.strictEqual(h.ctx.trendReadCard(), '');
    assert.ok(h.text(h.ctx.trendAskCard()).startsWith('Ask about your numbers'));
  });
  it('Ask sends the desktop\'s body and shows the answer', async () => {
    const h = await loaded();
    h.screen();
    h.calls.writes[0].res({ success: true, data: { available: true, read: { read_en: 'r', read_cn: 'r' } } }); await tick();
    const t = h.text(h.ctx.trendAskCard());
    assert.ok(t.includes('Ask Why did the average order change? What should I restock first? How does this period compare with the one before?'));
    h.CMD.trendAskSet('  Which day was best? '); h.CMD.trendAsk('');
    const w = h.calls.writes[1];
    assert.strictEqual(w.p, '/reports/ask');
    assert.deepStrictEqual(Object.keys(w.body), ['q', 'from', 'to', 'store_id', 'digest']);
    assert.strictEqual(w.body.q, 'Which day was best?');
    assert.strictEqual(h.s.trendAsk.q, '', 'the box empties');
    assert.ok(h.text(h.ctx.trendAskCard()).includes('Which day was best? Reading the numbers…'));
    h.CMD.trendAsk('again');
    assert.strictEqual(h.calls.writes.length, 2, 'one question at a time');
    w.res({ success: true, data: { answer: { answer_en: 'Friday.', answer_cn: '周五。' } } }); await tick();
    assert.ok(h.text(h.ctx.trendAskCard()).includes('Which day was best? Friday.'));
  });
  it('a suggested question asks itself; the day\'s limit and a failure say so', async () => {
    const h = await loaded();
    h.screen();
    h.calls.writes[0].res({ success: true, data: { available: true, read: { read_en: 'r', read_cn: 'r' } } }); await tick();
    h.CMD.trendAskChip(1);
    assert.strictEqual(h.calls.writes[1].body.q, 'What should I restock first?');
    const e = new Error('ask_limit'); e.code = 'ask_limit';
    h.calls.writes[1].rej(e); await tick(); await tick();
    assert.ok(h.text(h.ctx.trendAskCard()).includes("That's the day's questions used up — ask again tomorrow."));
    h.CMD.trendAsk('why'); h.calls.writes[2].rej(new Error('HTTP 502')); await tick(); await tick();
    assert.ok(h.text(h.ctx.trendAskCard()).includes('That one didn’t go through. Try again.'));
  });
  it('without reports:view — or while caps are unknown — no read is asked for and nothing shows', async () => {
    for (const caps of [['dashboard:view'], null]) {
      const h = await loaded({ caps });
      const t = h.text(h.screen());
      assert.strictEqual(h.calls.writes.length, 0, JSON.stringify(caps));
      assert.ok(!t.includes('The read') && !t.includes('Ask about your numbers'));
      h.CMD.trendAsk('x');
      assert.strictEqual(h.calls.writes.length, 0);
    }
  });
  it('on a no-money board: none of it, whatever the caps', async () => {
    const h = await loaded({ pos: 'warehouse' });
    h.screen();
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('a scoped read carries its store to the AI too', async () => {
    const h = await loaded({ storeLock: '1' });
    h.screen();
    assert.strictEqual(h.calls.writes[0].body.store_id, '1');
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('5 · the strings');
{
  it('every label is the desktop\'s', () => {
    for (const [en, zh] of [['Reading the numbers…', '正在读取数据…'], ['The read', '解读'],
      ["That's the day's questions used up — ask again tomorrow.", '今天的提问次数已用完，明天再来。'],
      ['That one didn’t go through. Try again.', '这次没有成功，请再试一次。'],
      ['e.g. Why did the average order drop?', '例如：平均客单为什么下降？']]) {
      assert.ok(DASH.includes(`cuT('${en}', '${zh}')`) || DASH.includes(`cuT("${en}", '${zh}')`), `${en} · ${zh}`);
    }
    for (const p of ['Demand heatmap · 需求热力图', 'orders by hour · 按小时订单', 'Retention · 留存', 'weighted, all cohorts · 加权，全部批次',
      'Ask about your numbers · 问问你的数据', 'Ask · 提问', 'Store · 门店']) assert.ok(DESK.includes(p), p);
    for (const s of ['No orders in range · 区间内无订单', 'Not enough history yet · 暂无足够留存数据', "tile(1, 'month 1', '第1个月')",
      "tile(12, 'month 12', '第12个月')", '<span>fewer · 少</span>', '<span>more · 多</span>', "['What should I restock first?', '我该先补什么货？']",
      'Drawn from the numbers in this report — nothing else. Refreshes with the range, at most twice a day.']) {
      assert.ok(DASH.includes(s), s);
    }
  });
  it('the note names only what is still desktop-only (the one composed pair)', () => {
    assert.ok(M.includes("T('Hover charts are on desktop.','悬停图表在电脑端。')"));
    assert.ok(!M.includes('Hover charts, the cohort grid and the written read are on desktop.'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
