#!/usr/bin/env node
/**
 * §423 — THE PHONE'S WASTE LIST: build a list of losses, record them in one go.
 *
 *   node scripts/test_mobile_waste_list.js
 *
 * Staff asked for it, 2026-10-03: one product at a time "takes too much time".
 * The phone code is RUN, lifted out of public/m.html by name into a sandbox with
 * a fake server (the technique of test_mobile_waste_void.js), so the write is
 * asserted on its path and body, and the failure paths on what they leave on
 * screen. No browser — fast shard.
 *
 * What it pins:
 *   1. Add to list: the item half resets, the REASON is kept for the next line,
 *      and a blocked entry never reaches the list;
 *   2. the list's own refusals, each naming the product — and quantities summed
 *      per product, because the same product can sit on two lines;
 *   3. the one request: path, store, every line with its own reason and note,
 *      nothing sent while blocked;
 *   4. success: the toast, the money gate on it, uncosted counted not zeroed,
 *      the list cleared;
 *   5. failure: the server's line is marked, the list is kept whole, and the
 *      words say nothing has changed — in both languages;
 *   6. the store cannot change under a list, and the list's markup carries each
 *      line's reason and a note field only where the reason needs one.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

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

/* ── Lifting by name — the scanner of test_mobile_waste_void.js, kept short: it
   knows strings, comments, regex literals and nested template literals. ───── */
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

const FNS = ['E', 'wstBlocked', 'wstListBlocked', 'wstListHtml'];
const CONSTS = ['money', 'wstMoney', 'wstShowMoney', 'wstNm', 'wstLineArgs'];
const REGS = ['wstAdd', 'wstLineQty', 'wstLineCode', 'wstLineNote', 'wstLineRm', 'wstListClear', 'wstSaveList', 'wstPickStore'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const REASONS = [{ code: 'spoiled', en: 'Spoiled', cn: '变质' }, { code: 'expired', en: 'Expired', cn: '过期' },
  { code: 'damaged', en: 'Damaged', cn: '损坏' }, { code: 'other', en: 'Other', cn: '其他' }];
const OAT = { id: 9, name_en: 'Oat milk 1L', name_cn: '燕麦奶', sku: '10188', on_hand: 18 };
const LOAF = { id: 11, name_en: 'Sourdough loaf', name_cn: '酸种面包', sku: 'A11', on_hand: 6 };

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], renders: 0, loads: 0, picks: 0 };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: {
      caps: opts.caps === undefined ? ['waste:view', 'waste:record', 'waste:costs'] : opts.caps,
      stores: [{ id: 1 }, { id: 2 }], focus: null,
      wst: { open: true, busy: false, formErr: null, storeId: 1, pick: null, qty: 1, code: 'expired', note: '',
             q: '', preview: null, reasons: REASONS, list: [], badLine: null },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    loadWaste: () => { calls.loads++; },
    loadWastePicks: () => { calls.picks++; },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state, w: ctx.state.wst };
}
// Put a product in the form and Add it, as the operator does.
function addItem(h, p, qty, code, note) {
  h.w.pick = Object.assign({}, p); h.w.qty = qty; h.w.code = code || h.w.code; h.w.note = note || '';
  h.CMD.wstAdd();
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const conflict = (body, message) => Object.assign(new Error(message || body.error), { code: body.error, body });

section('1 · Add to list');
it('puts the line on the list and resets the item half — but keeps the reason', () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired');
  same(h.w.list, [{ pid: 9, name_en: 'Oat milk 1L', name_cn: '燕麦奶', sku: '10188', on_hand: 18, qty: 4, code: 'expired', note: '' }]);
  assert.strictEqual(h.w.pick, null);
  assert.strictEqual(h.w.qty, 1);
  assert.strictEqual(h.w.note, '');
  assert.strictEqual(h.w.code, 'expired', 'a clean-out is one reason after another');
  assert.ok(h.calls.picks > 0, 'and the picker is reloaded for the next product');
});
it('a blocked entry never reaches the list (more than is on the shelf)', () => {
  const h = mk();
  addItem(h, OAT, 99, 'expired');
  same(h.w.list, []);
});
it('nor one with no reason, nor "other" with nothing said', () => {
  const h = mk();
  addItem(h, OAT, 1, '');           // code '' falls back to the form's current code, so force it empty
  h.w.list.length = 0; h.w.pick = Object.assign({}, OAT); h.w.qty = 1; h.w.code = '';
  h.CMD.wstAdd();
  same(h.w.list, []);
  h.w.pick = Object.assign({}, OAT); h.w.code = 'other'; h.w.note = '  ';
  h.CMD.wstAdd();
  same(h.w.list, []);
});
it('the note is trimmed and travels with its line', () => {
  const h = mk();
  addItem(h, OAT, 1, 'other', '  dropped on the floor ');
  assert.strictEqual(h.w.list[0].note, 'dropped on the floor');
});

section('2 · the list refuses, and says which product');
it('"other" with no note on a line names the product', () => {
  const h = mk();
  addItem(h, OAT, 2, 'expired');
  h.CMD.wstLineCode('0:other');
  assert.strictEqual(h.ctx.wstListBlocked(), 'Tell us what happened for Oat milk 1L.');
  h.CMD.wstLineNote('0:dropped');
  assert.strictEqual(h.ctx.wstListBlocked(), '');
});
it('the same product on two lines is summed against the shelf', () => {
  const h = mk();
  addItem(h, LOAF, 4, 'expired');
  addItem(h, LOAF, 4, 'damaged');      // each fine alone (6 on the shelf), 8 together
  assert.strictEqual(h.ctx.wstListBlocked(), 'Only 6 of Sourdough loaf on hand.');
});
it('a product chosen but not added blocks Record, and says to add it', () => {
  const h = mk();
  addItem(h, OAT, 2, 'expired');
  h.w.pick = Object.assign({}, LOAF);
  assert.strictEqual(h.ctx.wstListBlocked(), 'Add the chosen product to the list first.');
});
it('in Chinese', () => {
  const h = mk({ lang: 'zh' });
  addItem(h, OAT, 2, 'expired');
  h.CMD.wstLineCode('0:other');
  assert.strictEqual(h.ctx.wstListBlocked(), '请填写「燕麦奶」的备注说明。');
});
it('a line quantity stays between 1 and what is on the shelf', () => {
  const h = mk();
  addItem(h, LOAF, 5, 'expired');
  h.CMD.wstLineQty('0:1'); h.CMD.wstLineQty('0:1'); h.CMD.wstLineQty('0:1');
  assert.strictEqual(h.w.list[0].qty, 6);
  for (let i = 0; i < 9; i++) h.CMD.wstLineQty('0:-1');
  assert.strictEqual(h.w.list[0].qty, 1);
});
it('a line can be removed, and the whole list cleared', () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired'); addItem(h, LOAF, 1, 'expired');
  h.CMD.wstLineRm(0);
  same(h.w.list.map((l) => l.pid), [11]);
  h.CMD.wstListClear();
  same(h.w.list, []);
});

section('3 · one request for the whole list');
it('POSTs /waste/bulk once, every line with its own reason and note, in order', async () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired');
  addItem(h, LOAF, 1, 'damaged');
  addItem(h, OAT, 1, 'other', 'dropped');
  h.CMD.wstSaveList();
  assert.strictEqual(h.calls.writes.length, 1);
  assert.strictEqual(h.calls.writes[0].p, '/waste/bulk');
  same(h.calls.writes[0].body, { location_id: 1, items: [
    { store_product_id: 9, qty: 4, reason_code: 'expired', note: null },
    { store_product_id: 11, qty: 1, reason_code: 'damaged', note: null },
    { store_product_id: 9, qty: 1, reason_code: 'other', note: 'dropped' },
  ] });
  assert.strictEqual(h.w.busy, true, 'busy while it is in flight');
});
it('sends nothing while the list is blocked, or empty, or already in flight', () => {
  const h = mk();
  h.CMD.wstSaveList();
  assert.strictEqual(h.calls.writes.length, 0, 'empty');
  addItem(h, OAT, 2, 'expired');
  h.CMD.wstLineCode('0:other');
  h.CMD.wstSaveList();
  assert.strictEqual(h.calls.writes.length, 0, 'blocked');
  h.CMD.wstLineNote('0:x');
  h.CMD.wstSaveList(); h.CMD.wstSaveList();
  assert.strictEqual(h.calls.writes.length, 1, 'a second press while busy does nothing');
});

section('4 · success');
it('says how many, with the total for somebody who may read money — and the list is gone', async () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired'); addItem(h, LOAF, 2, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].res({ success: true, data: [
    { id: 1, cost_total_cents: 1600, is_uncosted: 0 }, { id: 2, cost_total_cents: 3400, is_uncosted: 0 }] });
  await settle();
  same(h.calls.toasts, ['Recorded 2 items · ¥50']);
  same(h.w.list, []);
  assert.strictEqual(h.w.open, false);
  assert.strictEqual(h.w.busy, false);
  assert.ok(h.calls.loads > 0, 'the ledger is re-read: stock moved');
});
it('an uncosted line is counted, never summed as zero', async () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired'); addItem(h, LOAF, 1, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].res({ success: true, data: [
    { id: 1, cost_total_cents: 400, is_uncosted: 0 }, { id: 2, cost_total_cents: null, is_uncosted: 1 }] });
  await settle();
  same(h.calls.toasts, ['Recorded 2 items · ¥4 · 1 with no cost on file']);
});
it('without waste:costs the toast carries no money at all', async () => {
  const h = mk({ caps: ['waste:view', 'waste:record'] });
  addItem(h, OAT, 1, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].res({ success: true, costs_hidden: true, data: [{ id: 1 }] });
  await settle();
  same(h.calls.toasts, ['Recorded 1 item']);
});
it('in Chinese', async () => {
  const h = mk({ lang: 'zh', caps: ['waste:view', 'waste:record'] });
  addItem(h, OAT, 1, 'expired'); addItem(h, LOAF, 1, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].res({ success: true, costs_hidden: true, data: [{ id: 1 }, { id: 2 }] });
  await settle();
  same(h.calls.toasts, ['已登记 2 条']);
});

section('5 · failure — the list stays whole and nothing has changed');
it('a line the shelf cannot cover is marked, with the figures, and the list is kept', async () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired'); addItem(h, LOAF, 5, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].rej(conflict({ error: 'insufficient_stock', line: 1, on_hand: 2, requested: 5 }));
  await settle();
  assert.strictEqual(h.w.badLine, 1);
  assert.strictEqual(String(h.w.formErr), 'Line 2: only 2 on hand, 5 asked. Nothing has changed.');
  assert.strictEqual(h.w.list.length, 2, 'nothing lost');
  assert.strictEqual(h.w.open, true, 'still open, where the operator is looking');
  assert.strictEqual(h.w.busy, false);
  same(h.calls.toasts, [], 'a failure never toasts');
});
it('in Chinese', async () => {
  const h = mk({ lang: 'zh' });
  addItem(h, LOAF, 5, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].rej(conflict({ error: 'insufficient_stock', line: 0, on_hand: 2, requested: 5 }));
  await settle();
  assert.strictEqual(String(h.w.formErr), '第 1 行：库存只有 2，登记了 5。数据没有变化。');
});
it('any other refusal that names a line still marks it', async () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].rej(conflict({ error: 'reason_invalid', line: 0 }));
  await settle();
  assert.strictEqual(h.w.badLine, 0);
  assert.strictEqual(String(h.w.formErr), 'Line 1 did not pass. Nothing has changed.');
});
it('a plain failure says nothing changed, and keeps the list', async () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired');
  h.CMD.wstSaveList();
  h.calls.writes[0].rej(new Error('HTTP 500'));
  await settle();
  assert.strictEqual(String(h.w.formErr), 'That did not save. Nothing has changed — try again.');
  assert.strictEqual(h.w.badLine, null);
  assert.strictEqual(h.w.list.length, 1);
});
it('editing the list clears the mark', async () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired');
  h.w.badLine = 0; h.w.formErr = 'x';
  h.CMD.wstLineQty('0:-1');
  assert.strictEqual(h.w.badLine, null);
  assert.strictEqual(h.w.formErr, null);
});

section('6 · the store, and what the list shows');
it('the store cannot change under a list', () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired');
  h.CMD.wstPickStore(2);
  assert.strictEqual(h.w.storeId, 1);
  assert.strictEqual(h.w.list.length, 1);
});
it('each line shows its number, name, reason and quantity; a note field only for "other"', () => {
  const h = mk();
  addItem(h, OAT, 4, 'expired'); addItem(h, LOAF, 1, 'other', 'dropped');
  const html = h.ctx.wstListHtml();
  const t = h.text(html);
  assert.ok(t.includes('List · 2'), t);
  assert.ok(t.includes('Oat milk 1L') && t.includes('Sourdough loaf'));
  assert.ok(/<option value="expired" selected>/.test(html), 'line 1 shows Expired');
  assert.ok(/<option value="other" selected>/.test(html), 'line 2 shows Other');
  assert.strictEqual((html.match(/id="mWstLN\d+"/g) || []).length, 1, 'one note field, on the "other" line');
  assert.ok(/id="mWstLN1"[^>]*value="dropped"/.test(html));
});
it('the refused line is outlined', () => {
  const h = mk();
  addItem(h, OAT, 1, 'expired'); addItem(h, LOAF, 1, 'expired');
  h.w.badLine = 1;
  const html = h.ctx.wstListHtml();
  assert.strictEqual((html.match(/outline:2px solid/g) || []).length, 1);
});
it('a line with 1 on hand switches both keys off, and they look it', () => {
  const h = mk();
  addItem(h, Object.assign({}, LOAF, { on_hand: 1 }), 1, 'expired');
  const html = h.ctx.wstListHtml();
  assert.strictEqual((html.match(/class="stepbtn"[^>]*disabled/g) || []).length, 2, 'both keys disabled at 1 of 1');
  /* Disabled with no look of its own is what was reported as "+ and − don't
     work": the keys were right to refuse, and looked live while doing it. */
  assert.ok(/\.stepbtn:disabled\{[^}]*opacity/.test(M), '.stepbtn:disabled is styled');
});
it('an empty list draws nothing', () => {
  assert.strictEqual(mk().ctx.wstListHtml(), '');
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
