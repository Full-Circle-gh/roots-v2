#!/usr/bin/env node
/**
 * §300 step F0 — THE PHONE'S MONEY AND PERMISSION DEFECTS, fixed before any
 * finance screen lands on it.
 *
 *   node scripts/test_mobile_finance_guards.js
 *
 * Four defects from docs/tacet-phone-parity-recipes-purchasing-finance.md §3:
 *   1. Approvals' "Mark paid / Mark recovered" wrote on the FIRST tap — its
 *      confirm was the desktop's askConfirm, which public/m.html does not have,
 *      behind a typeof guard that was therefore always false;
 *   2. a VOIDED claim read "Waiting" under Already decided;
 *   3. the purchase-order sheet drew Mark ordered / Everything arrived /
 *      Receive line by line for accounts that cannot use them;
 *   4. mCan() let every key through while the caps were unknown — including
 *      the keys whose whole job is money.
 *
 * The code is RUN, sliced out of public/m.html into a sandbox (the harness
 * test_mobile_category_banner.js uses), so this needs no browser and sits in
 * the fast shard. Every write is asserted on its request.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const FIN = fs.readFileSync(path.join(ROOT, 'public/retail-admin/22-finance.js'), 'utf8');
const PU = fs.readFileSync(path.join(ROOT, 'public/retail-admin/16-purchasing.js'), 'utf8');
const CAPS = require(path.join(ROOT, 'lib/capabilities.js'));

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
  slice("reg('aprSettle', (who,total,ids)=>{", '/* §146 — WHERE THE CLAIM IS FILED'),
  slice('function expStatusPill(r){', 'function expMineRow('),
  slice("reg('poReceive', ()=>{", '/* Marking a delivery in writes stock'),
  slice("reg('poStatus', st=>{", "reg('invSeg'"),
  slice('function sheetPO(){', '/* =========='),
  slice('const MCAN_MONEY_ONLY=', 'function canRoute('),
].join('\n');

const tick = () => new Promise((r) => setImmediate(r));

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], renders: 0, loads: 0, cmds: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: () => '<i></i>',
    state: {
      caps: opts.caps === undefined ? null : opts.caps,
      apr: { busy: 0, err: '', tried: true },
      ask: null, askErr: null,
      poDetail: opts.po || null, poId: opts.po ? opts.po.id : null, poBusy: false, poErr: null,
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    APP: { cmd: (n, ...a) => { calls.cmds.push([n, ...a]); } },
    showToast: (m) => calls.toasts.push(String(m)),
    aprLoad: () => { calls.loads++; },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method: method || 'POST' });
      if (opts.writeFails && calls.writes.length >= opts.writeFails) throw new Error('Claim is not approved');
      return { success: true };
    },
    api: async () => opts.po,
    loadPOs: () => {},
    poPill: () => '<span class="pill">pill</span>',
    poStore: () => '', poLate: () => false, poLineRow: () => '<div>line</div>', poDeliveries: () => '',
    poFact: (l, v) => `<div>${l} ${v}</div>`,
    fmtDateOnly: (s) => s, money0: (c, n) => c + n,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls };
}

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · Mark paid / Mark recovered asks before it writes');
{
  it('nothing on the phone calls the desktop\'s askConfirm, or guards on it', () => {
    assert.ok(!/askConfirm\s*\(|typeof askConfirm/.test(M), 'a typeof askConfirm guard is always false here');
  });
  it('the owed row still sends the tap to aprSettle', () => {
    assert.ok(/onclick="APP\.cmd\('aprSettle',/.test(M));
  });
  it('Mark paid: the tap opens the sheet and sends NOTHING', async () => {
    const { ctx, CMD, calls } = mk();
    CMD.aprSettle('Wei', '38', '11,12');
    await tick();
    assert.strictEqual(calls.writes.length, 0, 'no request before confirm');
    assert.ok(ctx.state.ask, 'the ask sheet is up');
    const html = ctx.sheetAsk();
    assert.ok(html.includes('Paid ¥38 back?'), 'the desktop\'s title');
    assert.ok(html.includes('This records that Wei has been paid back. It does not change the accounts — the expense was recorded when it was approved.'), 'the desktop\'s body');
    assert.ok(/onclick="APP\.cmd\('askRun',''\)">Mark paid</.test(html), 'the desktop\'s confirm label, on the run button');
    assert.ok(/onclick="APP\.cmd\('closeAsk'\)">Cancel</.test(html), 'and a way out');
  });
  it('Cancel closes the sheet and still sends nothing', async () => {
    const { ctx, CMD, calls } = mk();
    CMD.aprSettle('Wei', '38', '11,12');
    CMD.closeAsk();
    await tick();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(calls.writes.length, 0);
  });
  it('confirm settles every claim, one after another, on the desktop\'s route and body', async () => {
    const { ctx, CMD, calls } = mk();
    CMD.aprSettle('Wei', '38', '11,12');
    CMD.askRun('');
    await tick(); await tick(); await tick();
    assert.strictEqual(ctx.state.ask, null, 'the sheet closes');
    assert.deepStrictEqual(calls.writes, [
      { p: '/staff-expenses/11/settle', body: { settled: true }, method: 'POST' },
      { p: '/staff-expenses/12/settle', body: { settled: true }, method: 'POST' },
    ]);
    // 22-finance.js: api('/api/retail-admin/staff-expenses/' + claim + '/settle', { method: 'POST', body: { settled: true } })
    assert.ok(/staff-expenses\/' \+ claim \+ '\/settle',\s*\{ method: 'POST', body: \{ settled: true \} \}/.test(FIN), 'the same route and body as the desktop');
    assert.strictEqual(calls.loads, 1, 'the queue reloads');
    assert.deepStrictEqual(calls.toasts, ['Marked paid'], 'and a toast confirms (the phone\'s own, not window.toast)');
    assert.strictEqual(ctx.state.apr.busy, 0);
  });
  it('Mark recovered: the refund-back case asks in its own words, then sends the same write', async () => {
    const { ctx, CMD, calls } = mk();
    CMD.aprSettle('Wei', '-12.5', '9');
    assert.strictEqual(calls.writes.length, 0);
    const html = ctx.sheetAsk();
    assert.ok(html.includes('Recovered ¥12.5?'));
    assert.ok(html.includes('>Wei<'), 'the body names the person');
    assert.ok(/>Mark recovered</.test(html));
    CMD.askRun('');
    await tick(); await tick();
    assert.deepStrictEqual(calls.writes, [{ p: '/staff-expenses/9/settle', body: { settled: true }, method: 'POST' }]);
    assert.deepStrictEqual(calls.toasts, ['Recovered']);
  });
  it('in Chinese, the desktop\'s Chinese', () => {
    const { ctx, CMD } = mk({ lang: 'zh' });
    CMD.aprSettle('王伟', '38', '11');
    const html = ctx.sheetAsk();
    assert.ok(html.includes('已付款 ¥38？'));
    assert.ok(html.includes('记录已向王伟付款。不会改动账目 — 该费用在审批通过时已记入。'));
    assert.ok(html.includes('>标记已付<'));
    assert.ok(html.includes('>取消<'));
  });
  it('a name is escaped into the sheet, and a nameless claim says Someone', () => {
    const a = mk();
    a.CMD.aprSettle('<b>x</b>', '5', '1');
    assert.ok(!a.ctx.sheetAsk().includes('<b>x</b>'));
    assert.ok(a.ctx.sheetAsk().includes('&lt;b&gt;x&lt;/b&gt;'));
    const b = mk();
    b.CMD.aprSettle('', '5', '1');
    assert.ok(b.ctx.sheetAsk().includes('This records that Someone has been paid back.'));
    assert.ok(/cuT\('Someone', '未知'\)/.test(FIN), 'the desktop\'s fallback');
  });
  it('a refused settle says why where the operator is looking, stops, and toasts nothing', async () => {
    const { ctx, CMD, calls } = mk({ writeFails: 2 });
    CMD.aprSettle('Wei', '38', '11,12,13');
    CMD.askRun('');
    await tick(); await tick(); await tick();
    assert.strictEqual(calls.writes.length, 2, 'stops at the refusal; the third is never sent');
    assert.strictEqual(String(ctx.state.apr.err), 'Claim is not approved');
    assert.strictEqual(ctx.state.apr.busy, 0);
    assert.deepStrictEqual(calls.toasts, []);
  });
  it('nothing to settle, or a settle already running, opens no sheet', () => {
    const a = mk();
    a.CMD.aprSettle('Wei', '38', '');
    assert.strictEqual(a.ctx.state.ask, null);
    const b = mk();
    b.ctx.state.apr.busy = -1;
    b.CMD.aprSettle('Wei', '38', '4');
    assert.strictEqual(b.ctx.state.ask, null);
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('2 · a voided claim reads Voided, as on the desktop');
{
  it('Voided, in the neutral pill — not Waiting, not refused Brick', () => {
    const { ctx } = mk();
    const html = ctx.expStatusPill({ status: 'voided', amount: 38, paid_by: 'employee' });
    assert.ok(/>Voided<\/span>$/.test(html));
    assert.ok(!html.includes('Waiting'));
    assert.ok(html.includes('rgba(88,96,110,0.10)'), 'the neutral (clear) pill');
    assert.ok(!html.includes('brick'));
  });
  it('已作废 in Chinese — the desktop\'s pair', () => {
    const { ctx } = mk({ lang: 'zh' });
    assert.ok(ctx.expStatusPill({ status: 'voided' }).includes('>已作废<'));
    assert.ok(/r\.status === 'voided'[\s\S]{0,120}cuT\('Voided', '已作废'\)/.test(FIN));
  });
  it('the other statuses are unchanged', () => {
    const { ctx } = mk();
    assert.ok(ctx.expStatusPill({ status: 'submitted' }).includes('Waiting'));
    assert.ok(ctx.expStatusPill({ status: 'rejected' }).includes('Not approved'));
    assert.ok(ctx.expStatusPill({ status: 'approved', paid_by: 'company' }).includes('Approved'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('3 · the purchase-order sheet draws each button only for who may press it');
{
  const PO = (status) => ({ id: 4, po_number: 'RPO-0004', supplier: 'Fresh Co.', status, total_cost: 100, items: [] });
  it('the desktop gates these on purchasing:edit (Place order) and purchasing:receive (receive)', () => {
    assert.ok(/data-cap="purchasing:edit" onclick="puPlace\(\)"/.test(PU));
    assert.ok(/data-cap="purchasing:receive" onclick="puAllArrived\(\)"/.test(PU));
    assert.ok(/data-cap="purchasing:receive" onclick="puReceiveSave\(\)"/.test(PU));
  });
  it('a draft, to purchasing:edit: Mark ordered', () => {
    const { ctx } = mk({ caps: ['purchasing:view', 'purchasing:edit'], po: PO('Requested') });
    assert.ok(ctx.sheetPO().includes('Mark ordered'));
  });
  it('a draft, view-only: no Mark ordered, no Receive line by line', () => {
    const { ctx } = mk({ caps: ['purchasing:view'], po: PO('Requested') });
    const html = ctx.sheetPO();
    assert.ok(!html.includes('Mark ordered'));
    assert.ok(!html.includes('Receive line by line'));
    assert.ok(!html.includes("APP.cmd('poStatus'"));
    assert.ok(html.includes('Fresh Co.'), 'the order itself still reads');
  });
  it('a draft, receive-only: no Mark ordered — placing is the buyer\'s', () => {
    const { ctx } = mk({ caps: ['purchasing:view', 'purchasing:receive'], po: PO('Requested') });
    assert.ok(!ctx.sheetPO().includes('Mark ordered'));
  });
  it('an order placed, to purchasing:receive: Everything arrived and Receive line by line', () => {
    const { ctx } = mk({ caps: ['purchasing:view', 'purchasing:receive'], po: PO('Ordered') });
    const html = ctx.sheetPO();
    assert.ok(html.includes('Everything arrived'));
    assert.ok(html.includes('Receive line by line'));
  });
  it('an order placed, edit without receive: neither', () => {
    const { ctx } = mk({ caps: ['purchasing:view', 'purchasing:edit'], po: PO('Ordered') });
    const html = ctx.sheetPO();
    assert.ok(!html.includes('Everything arrived'));
    assert.ok(!html.includes('Receive line by line'));
  });
  it('still loading: no buttons at all', () => {
    const { ctx } = mk({ caps: ['purchasing:view', 'purchasing:edit', 'purchasing:receive'] });
    ctx.state.poId = 4;
    const html = ctx.sheetPO();
    assert.ok(html.includes('Loading…'));
    assert.ok(!/Mark ordered|Everything arrived|Receive line by line/.test(html));
  });
  it('the commands refuse too, so a stale sheet cannot write past the gate', async () => {
    const a = mk({ caps: ['purchasing:view'], po: PO('Requested') });
    a.CMD.poStatus('Ordered'); await tick();
    assert.strictEqual(a.calls.writes.length, 0);
    const b = mk({ caps: ['purchasing:view', 'purchasing:edit'], po: PO('Ordered') });
    b.CMD.poStatus('Delivered'); await tick();
    assert.strictEqual(b.ctx.state.ask, null, 'no Everything-arrived confirm either');
    b.CMD.poReceive();
    assert.deepStrictEqual(b.calls.cmds, [], 'Receive does not open');
  });
  it('with the key: Mark ordered writes the same status PUT as before', async () => {
    const { CMD, calls } = mk({ caps: ['purchasing:edit'], po: PO('Requested') });
    CMD.poStatus('Ordered'); await tick();
    assert.deepStrictEqual(calls.writes, [{ p: '/purchases/4/status', body: { status: 'Ordered' }, method: 'PUT' }]);
  });
  it('with the key: Everything arrived asks first, then writes Delivered', async () => {
    const { ctx, CMD, calls } = mk({ caps: ['purchasing:receive'], po: PO('Ordered') });
    CMD.poStatus('Delivered'); await tick();
    assert.strictEqual(calls.writes.length, 0);
    assert.ok(ctx.sheetAsk().includes('Everything arrived?'));
    CMD.askRun(''); await tick();
    assert.deepStrictEqual(calls.writes, [{ p: '/purchases/4/status', body: { status: 'Delivered' }, method: 'PUT' }]);
  });
  it('caps unknown: purchasing keys still fail open, as before (nothing regresses)', () => {
    const { ctx } = mk({ caps: null, po: PO('Ordered') });
    assert.ok(ctx.sheetPO().includes('Everything arrived'));
  });
}

/* ─────────────────────────────────────────────────────────────────────── */
section('4 · mCan fails CLOSED for the money-only keys, open for the rest');
{
  const MONEY = ['finance:view', 'finance:record', 'recipes:costs', 'materials:costs',
    'products:costs', 'waste:costs', 'purchasing:invoices', 'reports:view'];
  it('every key in the closed set is real and money-marked in lib/capabilities.js', () => {
    const { ctx } = mk();
    const set = [...vm.runInContext('MCAN_MONEY_ONLY', ctx)];
    assert.deepStrictEqual(set.slice().sort(), MONEY.slice().sort());
    for (const k of set) {
      const c = CAPS.CAPABILITIES.find((x) => x.key === k);
      assert.ok(c, k + ' is a capability');
      assert.ok(c.money === 'shows' || c.money === 'moves', k + ' carries a money marker');
    }
  });
  it('caps unknown: every money-only key is refused', () => {
    const { ctx } = mk({ caps: null });
    for (const k of MONEY) assert.strictEqual(ctx.mCan(k), false, k);
  });
  it('caps unknown: every other key is allowed, exactly as before', () => {
    const { ctx } = mk({ caps: null });
    for (const k of ['orders:view', 'customers:adjust', 'customers:view', 'purchasing:edit',
      'purchasing:receive', 'purchasing:view', 'till:use', 'expenses:approve', 'invoices:manage', 'dashboard:view']) {
      assert.strictEqual(ctx.mCan(k), true, k);
    }
    assert.strictEqual(ctx.mCan(undefined), true, 'an ungated route is still open');
  });
  it('caps unknown, a list: allowed if any member would be', () => {
    const { ctx } = mk({ caps: null });
    assert.strictEqual(ctx.mCan(['finance:view', 'recipes:costs']), false);
    assert.strictEqual(ctx.mCan(['finance:view', 'orders:view']), true);
  });
  it('caps known: held means yes, missing means no, money or not', () => {
    const { ctx } = mk({ caps: ['finance:view', 'orders:view'] });
    assert.strictEqual(ctx.mCan('finance:view'), true);
    assert.strictEqual(ctx.mCan('finance:record'), false);
    assert.strictEqual(ctx.mCan('orders:view'), true);
    assert.strictEqual(ctx.mCan('orders:edit'), false);
    assert.strictEqual(ctx.mCan(['finance:record', 'orders:view']), true);
    assert.strictEqual(ctx.mCan([]), false);
  });
  it('an empty cap list (an account with nothing) refuses everything', () => {
    const { ctx } = mk({ caps: [] });
    assert.strictEqual(ctx.mCan('orders:view'), false);
    assert.strictEqual(ctx.mCan('finance:view'), false);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
