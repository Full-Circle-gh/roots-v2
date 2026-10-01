#!/usr/bin/env node
/**
 * §325 step PD3 — VOIDING A WASTE ENTRY FROM THE PHONE, and the Back order
 * of the "When it runs out" picker.
 *
 *   node scripts/test_mobile_waste_void.js
 *
 * The desktop is the spec: public/retail-admin/20-waste.js (the row's Void,
 * offered on a live loss only behind data-cap="waste:void", and doVoid: a
 * confirm that says what goes back into stock, then POST /waste/:id/void with
 * an empty body). The phone code is RUN, lifted out of public/m.html by name
 * into a sandbox with a fake server, so the write is asserted on its method,
 * path and body, before and after its confirm. No browser — fast shard.
 *
 * What it pins:
 *   1. who sees Void, and on which rows;
 *   2. the confirm, word for word, and that nothing is sent before it;
 *   3. the request, the busy row, the toast, the re-read;
 *   4. a refusal (403), a stale row (409) and a plain failure each say so
 *      above the list and stay; the toast never reports a failure;
 *   5. Back closes the "When it runs out" picker before the product sheet
 *      under it (found in PD2, folded in here).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const WASTE_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/20-waste.js'), 'utf8');

const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m);
let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}

/* ── Lifting by name ─────────────────────────────────────────────────────────
   A small scanner that knows strings, comments, regex literals and NESTED
   template literals (this file's markup is templates inside templates), so a
   function is cut at its own closing brace and nowhere else. */
function skipBalanced(src, i) {
  const open = src[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  const stack = [{ t: 'code', depth: 0 }];
  let prev = '';
  for (; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top.t === 'tmpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); prev = '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ t: 'code', depth: 0, inTmpl: true }); i++; continue; }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      prev = c; continue;
    }
    if (c === '`') { stack.push({ t: 'tmpl' }); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); prev = ''; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      prev = 'x'; continue;
    }
    if (c === '{' || c === '(' || c === '[') top.depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (top.inTmpl && top.depth === 0 && c === '}') { stack.pop(); prev = '}'; continue; }
      top.depth--;
      if (stack.length === 1 && top.depth === 0 && c === close) return i + 1;
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('unbalanced from ' + src.slice(i, i + 40));
}
function liftFn(name) {
  const at = M.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, 'cannot find function ' + name);
  const body = M.indexOf('{', M.indexOf(')', at));
  return M.slice(at + 1, skipBalanced(M, body));
}
function liftConst(name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=').exec(M);
  const at = m ? m.index : -1;
  assert.ok(at >= 0, 'cannot find const ' + name);
  // To the first `;` outside any bracket, string or template.
  let i = at + 1;
  while (i < M.length) {
    const c = M[i];
    if (c === '{' || c === '(' || c === '[') { i = skipBalanced(M, i); continue; }
    if (c === '"' || c === "'") { for (i++; M[i] !== c; i++) if (M[i] === '\\') i++; i++; continue; }
    if (c === ';') return M.slice(at + 1, i + 1);
    i++;
  }
  throw new Error('cannot end const ' + name);
}
function liftReg(name) {
  const at = M.indexOf("\nreg('" + name + "',");
  assert.ok(at >= 0, 'cannot find reg ' + name);
  const open = M.indexOf('(', at + 1);
  return M.slice(at + 1, skipBalanced(M, open)) + ';';
}

const FNS = ['E', 'pill', 'mCan', 'chipRow', 'nothingYet', 'actRangeLine', 'wstPreset', 'wstWindow',
  'loadWasteReasons', 'wstReasonName', 'loadWaste', 'wstStoreName', 'wstProductName', 'wstPulse', 'wstRow',
  'wstVoidBtn', 'screenWaste', 'wstRefilter', 'layers', 'prodRecordsDrop'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'money', 'wstMoney', 'wstShowMoney'];
const REGS = ['askRun', 'wstVoid', 'wstRange', 'wstRetry'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const ROWS = () => [
  { id: 41, qty: 3, product_name_en: 'Oat milk', product_name_cn: '燕麦奶', reason_code: 'expired', location_name_en: 'Tianhe', business_date: '2026-09-30', cost_total_cents: 5400 },
  { id: 40, qty: 1, product_name_en: 'Rye loaf', product_name_cn: '黑麦面包', reason_code: 'damaged', location_name_en: 'Tianhe', business_date: '2026-09-29', voided_by_waste_id: 42 },
  { id: 42, qty: 1, product_name_en: 'Rye loaf', product_name_cn: '黑麦面包', reason_code: 'damaged', location_name_en: 'Tianhe', business_date: '2026-09-30', reverses_waste_id: 40 },
];
function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], renders: 0 };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: Object.assign({
      caps: opts.caps === undefined ? ['waste:view', 'waste:record', 'waste:void', 'waste:costs'] : opts.caps,
      ask: null, askErr: null, stores: [],
      wst: { rows: null, totals: null, tried: false, loading: false, err: null, listSeq: 0,
             range: 'week', reason: '', store: '', reasons: [], from: null, to: null, voidBusy: null, voidErr: null },
      stack: [], pinv: {}, fin: {}, kq: {}, prodVer: { open: false }, prodSales: { pid: null, seq: 0 },
      shm: { edit: null, pick: null },   // §325 PD4's two shop-menu sheets, closed
    }, opts.state || {}),
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    shopToday: () => '2026-10-01',
    fmtDateOnly: (v) => 'D' + String(v || '').slice(5),
    showToast: (m) => calls.toasts.push(String(m)),
    apiRaw: (p) => { calls.reads.push(p); return Promise.resolve({ success: true, data: opts.rows ? opts.rows() : ROWS(), totals: { entries: 1 } }); },
    api: (p) => { calls.reads.push(p); return Promise.resolve([]); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state, w: ctx.state.wst };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
async function loaded(opts) { const h = mk(opts); h.ctx.screenWaste(); await settle(); return h; }
const voidBtns = (html) => (html.match(/APP\.cmd\('wstVoid',(\d+)\)/g) || []).map((x) => Number(/(\d+)\)$/.exec(x)[1]));
const refusal = (words) => Object.assign(new Error(words[0]), { refused: true, status: 403, words, code: 'forbidden' });
const conflict = (code, message) => Object.assign(new Error(message), { code });

section('1 · who sees Void, and on which rows');
it('a live loss carries Void; a voided row and its reversal do not', async () => {
  const h = await loaded();
  same(voidBtns(h.ctx.screenWaste()), [41]);
});
it('without waste:void, no Void anywhere — the desktop’s data-cap', async () => {
  const h = await loaded({ caps: ['waste:view', 'waste:record'] });
  same(voidBtns(h.ctx.screenWaste()), []);
  h.CMD.wstVoid(41);
  assert.strictEqual(h.s.ask, null, 'and the command refuses to ask');
});

section('2 · the confirm, before anything is sent');
it('asks the desktop’s question, says what goes back, and sends nothing yet', async () => {
  const h = await loaded();
  h.CMD.wstVoid(41);
  const a = h.s.ask;
  assert.strictEqual(a.title, 'Void this waste entry?');
  assert.strictEqual(a.body, '3 × Oat milk goes back into stock. The entry stays in the list, marked voided.');
  assert.strictEqual(a.confirmLabel, 'Void');
  assert.strictEqual(a.danger, true);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('in Chinese, the product first and the same ×, no measure word', async () => {
  const h = await loaded({ lang: 'zh' });
  h.CMD.wstVoid(41);
  assert.strictEqual(h.s.ask.title, '作废这条损耗记录?');
  assert.strictEqual(h.s.ask.body, '燕麦奶 × 3 将退回库存。该记录仍保留在列表中,标记为已作废。');
  assert.strictEqual(h.s.ask.confirmLabel, '作废');
});
it('a product name is escaped into the sentence', async () => {
  const h = await loaded({ rows: () => [Object.assign(ROWS()[0], { product_name_en: '<b>Jam</b>' })] });
  h.CMD.wstVoid(41);
  assert.ok(h.s.ask.body.includes('&lt;b&gt;Jam&lt;/b&gt;'));
});
it('a voided row or a reversal is never asked about, even by a stale tap', async () => {
  const h = await loaded();
  h.CMD.wstVoid(40); h.CMD.wstVoid(42);
  assert.strictEqual(h.s.ask, null);
});

section('3 · the write');
it('POST /waste/41/void with the desktop’s empty body; the row says Voiding… and every Void waits', async () => {
  const h = await loaded({ rows: () => [ROWS()[0], Object.assign({}, ROWS()[0], { id: 43 })] });
  h.CMD.wstVoid(41); h.CMD.askRun('');
  assert.strictEqual(h.calls.writes.length, 1);
  same({ p: h.calls.writes[0].p, body: h.calls.writes[0].body, method: h.calls.writes[0].method },
    { p: '/waste/41/void', body: {}, method: 'POST' });
  const html = h.ctx.screenWaste();
  assert.ok(h.text(html).includes('Voiding…'));
  assert.strictEqual((html.match(/disabled/g) || []).length, 2, 'both Void buttons wait');
  h.CMD.wstVoid(43);
  assert.strictEqual(h.s.ask, null, 'a second void cannot start while one is in flight');
});
it('success: the toast confirms and the list is read again', async () => {
  const h = await loaded();
  const reads = h.calls.reads.filter((p) => p.startsWith('/waste?')).length;
  h.CMD.wstVoid(41); h.CMD.askRun('');
  h.calls.writes[0].res({ success: true }); await settle();
  same(h.calls.toasts, ['Voided']);
  assert.strictEqual(h.w.voidBusy, null);
  assert.strictEqual(h.calls.reads.filter((p) => p.startsWith('/waste?')).length, reads + 1);
});
it('Cancel sends nothing', async () => {
  const h = await loaded();
  h.CMD.wstVoid(41); h.s.ask = null;
  assert.strictEqual(h.calls.writes.length, 0);
});

section('4 · when it does not go through');
it('a permission refusal says why above the list, stays, and is not a toast', async () => {
  const h = await loaded();
  h.CMD.wstVoid(41); h.CMD.askRun('');
  h.calls.writes[0].rej(refusal(['You don’t have permission to do that.', '你没有执行此操作的权限。'])); await settle();
  assert.ok(h.text(h.ctx.screenWaste()).includes('You don’t have permission to do that.'));
  same(h.calls.toasts, []);
  h.ctx.screenWaste();
  assert.ok(h.text(h.ctx.screenWaste()).includes('You don’t have permission to do that.'), 'it stays');
  assert.strictEqual(h.w.voidBusy, null);
});
it('a row voided elsewhere: the server’s sentence, and the list is read again', async () => {
  const h = await loaded();
  const reads = h.calls.reads.length;
  h.CMD.wstVoid(41); h.CMD.askRun('');
  h.calls.writes[0].rej(conflict('already_voided', 'This entry has already been voided.')); await settle();
  assert.ok(h.text(h.ctx.screenWaste()).includes('This entry has already been voided.'));
  assert.ok(h.calls.reads.length > reads);
});
it('any other failure: nothing changed, try again', async () => {
  const h = await loaded();
  h.CMD.wstVoid(41); h.CMD.askRun('');
  h.calls.writes[0].rej(new Error('HTTP 500')); await settle();
  assert.ok(h.text(h.ctx.screenWaste()).includes('That did not go through. Nothing has changed — try again.'));
});
it('a new filter lets the old refusal go', async () => {
  const h = await loaded();
  h.w.voidErr = 'old';
  h.CMD.wstRange('today'); await settle();
  assert.strictEqual(h.w.voidErr, null);
});

section('5 · Back closes the topmost sheet first');
it('with the "When it runs out" picker open over a product, Back closes the picker and leaves the product', () => {
  const h = mk({ state: { productSku: 'SKU OM-1', oosSku: 'SKU OM-1' } });
  const L = h.ctx.layers();
  L[L.length - 1]();
  assert.strictEqual(h.s.oosSku, null);
  assert.strictEqual(h.s.productSku, 'SKU OM-1');
  const L2 = h.ctx.layers();
  L2[L2.length - 1]();
  assert.strictEqual(h.s.productSku, null);
});
it('the version list, too, closes before its product', () => {
  const h = mk({ state: { productSku: 'SKU OM-1', prodVer: { open: true } } });
  const L = h.ctx.layers();
  L[L.length - 1]();
  assert.strictEqual(h.s.prodVer.open, false); assert.strictEqual(h.s.productSku, 'SKU OM-1');
});

section('6 · every string is a live pair');
it('the desktop’s own, copied whole', () => {
  for (const [en, zh] of [['Void this waste entry?', '作废这条损耗记录?'], ['Void', '作废'], ['Voiding…', '作废中…'], ['Voided', '已作废'],
    [' goes back into stock. The entry stays in the list, marked voided.', ' 将退回库存。该记录仍保留在列表中,标记为已作废。']]) {
    assert.ok(WASTE_JS.includes(en) && WASTE_JS.includes(zh), 'desktop has ' + en);
    assert.ok(M.includes(en) && M.includes(zh), 'phone uses ' + en);
  }
  assert.ok(M.includes("T('That did not go through. Nothing has changed — try again.','没有成功。数据没有变化 — 请重试。')"));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
