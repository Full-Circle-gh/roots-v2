#!/usr/bin/env node
/**
 * §325 step O11 — CUSTOMERS: WHAT THE DESKTOP STILL HAD.
 *
 *   node scripts/test_mobile_customers_more.js
 *
 * From the desktop's customer roster and drawer (public/retail-admin/08-customers.js,
 * 26-print.js):
 *   1. found, but filtered (cuHiddenMatchState): a search whose only matches the
 *      filters hide — hidden_by_filters — says so and goes and gets them;
 *   2. diagnostics (renderDiagnosticsBlock, cuCopyDiagnostics);
 *   3. print statement (cuPrintStatement): GET /orders?customer_id=&limit=500;
 *   4. reset to a new customer (cuResetTestCustomer): POST
 *      /customers/:id/reset-test, the typed RESET, customers:block.
 * §326.4 brought 3 and 4 to the phone.
 *
 * The code is RUN, sliced out of public/m.html, so this needs no browser and
 * sits in the fast shard. Every request is asserted on method, path and body.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '08-customers.js'), 'utf8');
const PRINT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '26-print.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const DLG = fs.readFileSync(path.join(ROOT, 'public', 'tacet-dialogs.js'), 'utf8');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name, isAsync) {
  const start = src.indexOf('\n' + (isAsync ? 'async ' : '') + 'function ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}
const CODE = [
  sliceBetween('/* ── §325 O11 — CUSTOMERS', '\nfunction custFooterActions('),
  sliceFn('custFooterActions'), sliceFn('custWrite'), sliceFn('custSection'), sliceFn('loadCustomers', true),
  sliceBetween('\nconst custRow=', '\n/* THE SAME ROW'),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
].join('\n');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const C = (over) => Object.assign({ id: 7, nickname: 'Lin', phone: '138', openid: 'oWx1', is_blocked: 0 }, over || {});
const DIAG = { error_count_7d: 2, device_last_seen: { app_version: '3.2.1', device_model: 'iPhone 15', system: 'iOS 18', wx_version: '8.0.50', lib_version: '3.4', created_at: 't0' },
  recent_logs: [{ kind: 'error', page: 'pages/cart', message: 'TypeError: x', stack: 'at cart.js:9', created_at: 't1' }, { kind: 'open', page: '', message: '', app_version: '3.2.1', created_at: 't2' }] };

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [], copies: [], details: 0, lists: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', PILL: { muted: ['#eee', '#555'] }, storeName: 'Roots',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`, money: (c, n) => c + Number(n || 0).toFixed(2),
    tdWhen: (v, f) => (v instanceof Date ? 'NOW' : 'W(' + v + ')'), _tdL: () => 'x',
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    state: { custId: 7, custDetail: opts.detail === undefined ? { customer: C(opts.customer), stats: { active_sessions: 2 }, diagnostics: DIAG } : opts.detail,
      custBusy: null, custErr: null, ask: null, askErr: null, stmt: null, custHidden: null, custQ: opts.q || '', custSeg: 'all',
      custTier: ['tree'], custChan: ['web'], custTags: ['vip'], customers: [], custLoaded: false, storeName: 'Roots' },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)), copyText: (t) => calls.copies.push(t),
    loadCustomerDetail: () => { calls.details++; }, loadCustomerMeta: () => {},
    mapCustomer: (r) => r, custQuery: () => 'q', CUST_PAGE: 50,
    api: (p) => { calls.reads.push(p); const r = opts.read ? opts.read(p) : []; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    apiRaw: (p) => { calls.reads.push(p); const r = opts.raw ? opts.raw(p) : { data: [] }; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      const r = opts.respond ? opts.respond(p) : null;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r || { success: true, revoked: 0 });
    },
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseInt, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  // loadCustomers re-reads the list; count it rather than run it again.
  return { ctx, CMD, calls };
}

async function main() {
  console.log('\n0 · the server gate');
  {
    is(requiredCapFor('POST', '/api/retail-admin/customers/7/reset-test'), 'customers:block', 'reset: customers:block');
    is([requiredCapFor('GET', '/api/retail-admin/orders'), requiredCapFor('GET', '/api/retail-admin/customers')], [null, null], 'the reads are open');
  }

  console.log('\n1 · found, but filtered');
  {
    const m = mk({ q: '13800138000', raw: () => ({ data: [], total: 0, hidden_by_filters: { total: 1, blocked: 1 } }) });
    await m.ctx.loadCustomers(); await tick();
    is(m.ctx.state.custHidden, { total: 1, blocked: 1 }, 'the roster keeps the server\'s hidden count');
    let h = m.ctx.custHiddenState();
    has(h, 'Found — but your filters are hiding it', 'says it was found'); has(h, '1 customer matching “13800138000” is blocked, and blocked accounts show up nowhere but the Blocked list.', 'and that it is blocked');
    has(h, 'Show the blocked match', 'offering to go there');
    m.ctx.loadCustomers = async () => { m.calls.lists++; };
    m.CMD.custReveal();
    is([m.ctx.state.custSeg, m.ctx.state.custTier, m.ctx.state.custChan, m.ctx.state.custTags, m.ctx.state.custQ],
      ['blocked', [], [], [], '13800138000'], 'the filters come off, the search stays, and it lands on Blocked');
    const n = mk({ q: 'Lin' }); n.ctx.state.custHidden = { total: 3, blocked: 1 };
    h = n.ctx.custHiddenState();
    has(h, 'Found — but your filters are hiding them', 'several'); has(h, '3 customers matching “Lin” are outside the filters you\'ve set.', 'outside the filters');
    has(h, '>Show them<', 'Show them');
    n.ctx.loadCustomers = async () => {}; n.CMD.custReveal(); is([n.ctx.state.custSeg, n.ctx.state.custTags], ['all', []], 'not all blocked: back to All, tags off too');
    const none = mk({ raw: () => ({ data: [], total: 0 }) }); await none.ctx.loadCustomers(); await tick();
    is(none.ctx.state.custHidden, null, 'nothing hidden: no such state');
    const bad1 = mk({ raw: () => new Error('HTTP 500') }); bad1.ctx.state.custHidden = { total: 1 }; await bad1.ctx.loadCustomers(); await tick();
    is(bad1.ctx.state.custHidden, null, 'a failed read clears it');
    has(src, '} else if(!rows.length && state.custHidden){\n    body=custHiddenState();', 'the roster draws it before "no customers match"');
    const z = mk({ lang: 'zh', q: '138' }); z.ctx.state.custHidden = { total: 1, blocked: 1 };
    has(z.ctx.custHiddenState(), '找到了 — 但被当前筛选隐藏', 'Chinese');
  }

  console.log('\n2 · diagnostics');
  {
    const m = mk();
    const h = m.ctx.custDiagnostics(m.ctx.state.custDetail);
    has(h, '2 errors in 7 days', 'the error count'); has(h, 'iPhone 15', 'the phone'); has(h, '3.2.1', 'the app build');
    has(h, 'TypeError: x', 'the log'); has(h, 'stack / details', 'with its stack, folded'); has(h, 'at cart.js:9', '…inside');
    has(h, 'W(t1)', 'absolute times (a log is forensic)'); has(h, '>open<', 'a launch row');
    m.CMD.custDiagCopy();
    has(m.calls.copies[0], 'Customer #7 · 138 · Lin', 'Copy summary: who'); has(m.calls.copies[0], 'App: 3.2.1 · Phone: iPhone 15 · System: iOS 18 · WeChat: 8.0.50', 'the device');
    has(m.calls.copies[0], 'Errors (7d): 2 · Active sessions: 2', 'the counts'); has(m.calls.copies[0], '      at cart.js:9', 'and the stack indented under its line');
    const empty = mk({ detail: { customer: C(), stats: {}, diagnostics: { error_count_7d: 0, recent_logs: [] } } });
    const e = empty.ctx.custDiagnostics(empty.ctx.state.custDetail);
    has(e, 'No errors in 7 days', 'none'); has(e, 'No device data yet.', 'no device yet'); has(e, 'No diagnostics logged yet.', 'no log yet');
    const un = mk({ detail: { customer: C(), diagnostics: { unavailable: true } } });
    has(un.ctx.custDiagnostics(un.ctx.state.custDetail), 'This is not an all-clear — the check itself failed.', 'a failed read is never an all-clear');
    has(src, '    ${custDiagnostics(d)}`;', 'the record draws it');
  }

  console.log('\n3 · print statement');
  {
    const ORD = [{ id: 1, order_no: 'TC1', status: 'delivered', total: 100, placed_at: '2026-09-01 10:00:00' },
      { id: 2, order_no: 'TC2', status: 'cancelled', total: 40, placed_at: '2026-09-02 10:00:00' },
      { id: 3, order_no: 'TC3', status: 'pending_payment', total: 30, placed_at: '2026-09-03' }];
    const m = mk({ read: () => ORD });
    has(m.ctx.custFooterActions(m.ctx.state.custDetail, C()), "APP.cmd('custStatement')", 'offered on the record');
    has(mk({ caps: ['customers:view', 'orders:view'] }).ctx.custFooterActions({}, C()), 'custStatement', 'for orders:view, without customers:block');
    hasnt(mk({ caps: ['customers:view'] }).ctx.custFooterActions({}, C()), 'custStatement', 'not without orders:view');
    m.CMD.custStatement(); await tick();
    is(m.calls.reads, ['/orders?customer_id=7&limit=500'], 'GET /orders?customer_id=&limit=500, as the desktop reads it');
    const doc = m.ctx.stmtDoc(m.ctx.state.stmt);
    has(doc, '<h1>Statement</h1>', 'the document'); has(doc, '对账单', 'both names'); has(doc, 'Lin', 'whose');
    has(doc, 'TC2', 'a cancelled order is listed'); has(doc, 'Cancelled', 'and says so'); has(doc, 'Unpaid', 'unpaid too');
    is(m.ctx.stmtTotal(ORD), 100, 'only the orders that count are totalled'); has(doc, '¥100.00', 'the total');
    has(doc, 'This is a record of orders, not an invoice.', 'and it says what it is not');
    has(m.ctx.sheetStatement(), "APP.cmd('stmtPrint')", 'Print'); has(m.ctx.sheetStatement(), 'srcdoc=', 'the page to print');
    let release; const slow = mk(); slow.ctx.api = (p) => new Promise((r) => { release = () => r(ORD); });
    slow.CMD.custStatement(); await tick(); has(slow.ctx.sheetStatement(), 'Loading…', 'loading says so'); hasnt(slow.ctx.sheetStatement(), 'stmtPrint', 'with no Print'); release(); await tick();
    const f = mk({ read: () => new Error('HTTP 500') }); f.CMD.custStatement(); await tick();
    has(f.ctx.sheetStatement(), 'Could not read the orders', 'a failed read says so');
    const e = mk({ read: () => [] }); e.CMD.custStatement(); await tick();
    has(e.ctx.stmtDoc(e.ctx.state.stmt), 'Nothing to show · 暂无内容', 'no orders: says so');
    const d = mk({ caps: ['customers:view'] }); d.CMD.custStatement(); await tick();
    is([d.calls.reads, d.ctx.state.stmt], [[], null], 'without orders:view nothing is read');
  }

  console.log('\n4 · reset to a new customer');
  {
    const m = mk({ respond: () => ({ success: true, revoked: 2 }) });
    const foot = m.ctx.custFooterActions(m.ctx.state.custDetail, C());
    has(foot, "APP.cmd('custResetTest')", 'below Block'); has(foot, '· testing', 'labelled testing');
    hasnt(mk({ caps: ['customers:view', 'orders:view'] }).ctx.custFooterActions({}, C()), 'custResetTest', 'not without customers:block');
    const spent = m.ctx.custFooterActions({}, C({ openid: '_reset_1_oWx1' }));
    has(spent, '· already reset', 'a spent reset says so'); has(spent, `disabled onclick="APP.cmd('custResetTest')"`, 'and cannot be pressed');
    m.CMD.custResetTest();
    const a = m.ctx.state.ask;
    is([a.title, a.confirmLabel, a.danger], ['Reset Lin to a new customer?', 'Reset to a new customer', true], 'asks, in brick');
    has(a.body, 'For testing signup on your own phone. Not for a real customer.', 'saying what it is for');
    is(a.fields.map((x) => x.label), ['Type RESET to continue'], 'and makes the operator type the word');
    is(String(a.validate({ word: 'reset' })), 'Type RESET to continue', 'anything but RESET is refused'); is(a.validate({ word: 'RESET' }), null, 'RESET passes');
    is(m.calls.writes, [], 'nothing before the word');
    a.run({ word: 'RESET' }); await tick();
    is(m.calls.writes, [{ p: '/customers/7/reset-test', method: 'POST', body: {} }], 'POST /customers/:id/reset-test');
    is([m.calls.toasts, m.calls.details], [['Reset — 2 sessions revoked, they arrive as a new customer next time'], 1], 'says what was revoked, reads the record again');
    const z0 = mk({ respond: () => ({ success: true, revoked: 0 }) }); z0.CMD.custResetTest(); z0.ctx.state.ask.run({ word: 'RESET' }); await tick();
    is(z0.calls.toasts, ['Reset — they arrive as a new customer next time'], 'nothing to revoke: says that');
    const ar = mk({ respond: () => Object.assign(new Error('already_reset'), { code: 'already_reset' }) }); ar.CMD.custResetTest(); ar.ctx.state.ask.run({}); await tick();
    is(String(ar.ctx.state.custErr), 'That customer has already been reset — they are waiting to arrive as a new customer.', 'already reset: the desktop\'s sentence');
    const rf = mk({ respond: () => REFUSAL() }); rf.CMD.custResetTest(); rf.ctx.state.ask.run({}); await tick();
    is(String(rf.ctx.state.custErr), 'Your role does not include this action.', 'a refusal says why');
    const d = mk({ caps: ['customers:view'] }); d.CMD.custResetTest(); is(d.ctx.state.ask, null, 'without customers:block it does not ask');
    const s2 = mk({ customer: { openid: '_reset_9_x' } }); s2.CMD.custResetTest(); is(s2.ctx.state.ask, null, 'nor on a record already reset');
    has(src, `    <div><button class="\${blocked?'btn2':'dangerbtn'}"`, 'Block keeps a row of its own');
    const z = mk({ lang: 'zh' }); z.CMD.custResetTest();
    is(z.ctx.state.ask.title, '将 Lin 重置为新顾客？', 'Chinese'); is(z.ctx.state.ask.fields[0].label, '输入 RESET 以继续', '…and the typed gate');
  }

  console.log('\n5 · the words are the desktop\'s');
  {
    const N = (s) => s.replace(/\s*\n\s*/g, ' ').replace(/cuT\( /g, 'cuT(');
    const D = N(DESK), P = N(PRINT);
    for (const [en, zh] of [['Show the blocked match', '查看该封禁顾客'], ['Show the blocked matches', '查看这些封禁顾客'], ['Show them', '查看'],
      ['these filters', '当前筛选'], ['1 customer', '1 位顾客'], ['App version', '小程序版本'], ['Phone', '手机'], ['System', '系统'], ['WeChat', '微信版本'],
      ['Base library', '基础库'], ['Last seen', '最近一次'], ['errors in 7 days', '近7天报错'], ['No errors in 7 days', '近7天无报错'], ['stack / details', '堆栈 / 详情'],
      ['error', '报错'], ['open', '启动'], ['No diagnostics logged yet.', '暂无诊断记录。'], ['Copy summary', '复制摘要'], ['Device & app', '设备与版本'],
      ['Recent activity & errors (last 25)', '近期活动与报错（最近25条）'], ['Reset to a new customer', '重置为新顾客'], ['already reset', '已重置'], ['testing', '测试'],
      ["Diagnostics couldn't be read for this customer. This is not an all-clear — the check itself failed.", '无法读取该顾客的诊断数据。这不代表一切正常 — 是检查本身失败了。'],
      ['Reset — they arrive as a new customer next time', '已重置，下次进入将是新顾客']]) {
      const hit = [`cuT('${en}', '${zh}')`, `cuT("${en}", '${zh}')`].some((x) => D.includes(x));
      if (hit) ok('the desktop\'s own pair: ' + en); else bad('the desktop\'s own pair: ' + en);
    }
    has(D, 'Print statement · 打印对账单', 'the desktop\'s menu item');
    for (const [en, zh] of [['Could not read the orders', '无法读取订单'], ['The total counts orders that were not cancelled, refunded or left unpaid. This is a record of orders, not an invoice.', '合计仅包含未取消、未退款且已付款的订单。本表为订单记录，非发票。'],
      ['Sent', '已发出'], ['Unpaid', '未付款'], ['Date 日期', '日期 Date'], ['Total 金额', '金额 Total']]) {
      has(P, `'${en}', '${zh}'`, 'the statement\'s own pair: ' + en);
    }
    has(DLG, 'Type ${opts.matchWord} to continue · 输入 ${opts.matchWord} 以继续', 'the typed gate\'s own words');
    has(CORE, "already_reset:          ['That customer has already been reset — they are waiting to arrive as a new customer.', '该顾客已重置，正等待以新顾客身份进入。']", 'already_reset\'s own sentence');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
