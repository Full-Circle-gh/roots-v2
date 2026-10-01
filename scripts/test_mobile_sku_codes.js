#!/usr/bin/env node
/**
 * §325 step PD15 — SKU CODE RULES FOR MATERIALS, FROM THE PHONE.
 *
 *   node scripts/test_mobile_sku_codes.js
 *
 * The desktop is the spec: public/retail-admin/23-sku.js (Settings → SKU
 * codes) — skuLoad (GET /sku/material), skuToggle (PUT /sku/material/settings
 * {enabled}), skuAdd / skuEdit / the four plain controls / Advanced with its
 * token palette / skuSaveDraft (POST /sku/material/rules), and skuDelete (its
 * danger confirm, then DELETE /sku/material/rules/:id). The phone code is RUN,
 * lifted out of public/m.html by name into a sandbox with a fake server, so
 * every write is asserted on method, path and every body field. The preview
 * twins are checked against lib/sku-format.js, the engine that really issues
 * the codes. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const SKU_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/23-sku.js'), 'utf8');
const FMT = require(path.join(ROOT, 'lib/sku-format.js'));

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


const FNS = ['mCan', 'toggle', 'noteBar', 'loadSkuRules', 'skuRender', 'skuCatCode', 'skuNext', 'skuSummary', 'skuCompose', 'skuReadPattern',
  'skuLiveHtml', 'skuRuleRow', 'screenSkuCodes', 'sheetSkuDraft', 'skuSaveBody', 'skuSaveErr'];
const CONSTS = ['PILL', 'MCAN_MONEY_ONLY', 'SKU_KIND', 'skuKind', 'skuCanEdit', 'skuScopeOf', 'skuCodeToken', 'skuLiveRepaint'];
const REGS = ['askRun', 'skuRetry', 'skuToggle', 'skuAdd', 'skuEdit', 'skuCancel', 'skuKindPick', 'skuField', 'skuSimple', 'skuAdvanced',
  'skuInsert', 'skuSave', 'skuDeleteAsk', 'skuDelete'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const TOKENS = FMT.tokenCatalogue();
const DATA = (o) => Object.assign({ success: true, entity: 'material', settings: { enabled: true }, tokens: TOKENS,
  levels: { kinds: ['food', 'packaging'], byKind: { food: ['Dried fruits', 'Nuts'], packaging: ['Jars'] } },
  rules: [
    { id: 1, category: '', subcategory: '', code: '', pattern: '{SEQ:5}', scope: 'default', simple: { text: '', useCode: false, year: 0, sep: '', digits: 5 }, next_seq: 12, in_use: null },
    { id: 2, category: 'food', subcategory: '', code: 'F', pattern: '{CAT}{SEQ:4}', scope: 'category', simple: { text: '', useCode: true, year: 0, sep: '', digits: 4 }, next_seq: 3, in_use: 9 },
    { id: 3, category: 'food', subcategory: 'Dried fruits', code: 'DF', pattern: '{SUB}-{YY}-{SEQ:3}', scope: 'subcategory', simple: { text: '', useCode: true, year: 2, sep: '-', digits: 3 }, next_seq: 7, in_use: 4 },
    { id: 4, category: 'packaging', subcategory: '', code: 'P', pattern: 'X{CAT}{NAME}{SEQ:4}', scope: 'category', simple: null, next_seq: 1, in_use: 0 },
  ] }, o || {});
const ALL = ['materials:view', 'materials:edit'];
const REFUSED = ['You don’t have permission to do that.', '你没有执行此操作的权限。'];
const refusal = () => Object.assign(new Error('forbidden'), { refused: true, words: REFUSED, code: 'forbidden' });
const YY = String(new Date().getFullYear()).slice(-2);

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [] };
  const CMD = {};
  const els = {};
  const serve = opts.serve || (() => DATA());
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD, SUBS: {},
    state: { caps: opts.caps === undefined ? ALL : opts.caps, ask: null, askErr: null,
      sku: { data: null, err: null, tried: false, seq: 0, busy: null, actErr: null, draft: null, saveErr: null } },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    apiRaw: (p) => { calls.reads.push(p); const v = serve(p, calls.reads.length); return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    Object, Promise, Math, Number, String, Array, JSON, Error, RegExp, Set, Map, Date, isNaN, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state.sku, st: ctx.state,
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
async function opened(opts) { const h = mk(opts); h.ctx.screenSkuCodes(); await settle(); return h; }
const screen = (h) => h.text(h.ctx.screenSkuCodes());

section('1 · The screen: read, loading, failed, refused, read-only');
it('reads GET /sku/material once and says Loading… until it lands', async () => {
  const h = mk(); assert.strictEqual(h.text(h.ctx.screenSkuCodes()), 'Loading…');
  await settle(); h.ctx.screenSkuCodes();
  same(h.calls.reads, ['/api/retail-admin/sku/material']);
});
it('the three cards: the switch, the rules (each: what, code, scope, next code, plain reading, count), the fallback', async () => {
  const h = await opened(); const t = screen(h);
  assert.ok(t.startsWith('Automatic SKUs for materials Give a category the shape of its code once'), t);
  assert.ok(t.includes('Generate a SKU when a material is saved without one'));
  assert.ok(t.includes('All of Food F every category here without its own rule next: F0003 F + 4-digit number · 9 materials'), t);
  assert.ok(t.includes(`Food ▸ Dried fruits DF this subcategory only next: DF-${YY}-007 DF + the year + 3-digit number · 4 materials`), t);
  assert.ok(t.includes('All of Packaging P every category here without its own rule next: XP0001 Custom format · 0 materials'), t);
  assert.ok(t.includes('Fallback Used for anything with no rule of its own') && t.includes('Everything else when no rule above fits next: 00012 5-digit number Edit'), t);
  assert.ok(!/skuDeleteAsk',1\)/.test(h.ctx.screenSkuCodes()), 'the fallback cannot be removed');
});
it('switched off, the screen says what that means', async () => {
  const h = await opened({ serve: () => DATA({ settings: { enabled: false } }) });
  assert.ok(screen(h).includes('Numbering is off. New materials are saved with whatever SKU is typed, and blank if none is — exactly as before.'));
});
it('no category rules: the desktop’s empty line', async () => {
  const h = await opened({ serve: () => DATA({ rules: [DATA().rules[0]] }) });
  assert.ok(screen(h).includes('No category rules yet. Everything is numbered by the fallback below.'));
});
it('a failed read says so with the reason, and Try again reads again', async () => {
  let n = 0; const h = await opened({ serve: () => (++n === 1 ? new Error('HTTP 500') : DATA()) });
  assert.ok(screen(h).startsWith('Could not load the SKU rules: HTTP 500 Try again'));
  h.CMD.skuRetry(); await settle();
  assert.strictEqual(h.calls.reads.length, 2); assert.ok(screen(h).includes('Your rules'));
});
it('a refused read says why', async () => {
  const h = await opened({ serve: () => refusal() });
  assert.ok(screen(h).includes('You don’t have permission to do that.'));
});
it('materials:view alone: everything is shown, nothing is a control, every command refuses', async () => {
  const h = await opened({ caps: ['materials:view'] }); const html = h.ctx.screenSkuCodes();
  ['skuToggle', 'skuEdit', 'skuDeleteAsk', 'skuAdd'].forEach((c) => assert.ok(!html.includes(c), c));
  assert.ok(screen(h).includes('Generate a SKU when a material is saved without one On'));
  h.CMD.skuToggle(); h.CMD.skuAdd(); h.CMD.skuEdit(2); h.CMD.skuDeleteAsk(2);
  same([h.calls.writes.length, h.s.draft, h.st.ask], [0, null, null]);
});
it('the door: Settings → SKU codes behind materials:view, the desktop tab’s key', () => {
  assert.ok(M.includes("skucodes:'materials:view',"));
  assert.ok(M.includes(`...(canRoute('skucodes')?[{label:T('SKU codes','编码规则'),cmd:"APP.cmd('push','skucodes')",chev:true}]:[])`));
  assert.ok(M.includes("if(state.sku&&state.sku.draft) html += layer('skudraft', sheetSkuDraft());"));
});

section('2 · The switch');
it('PUT /sku/material/settings {enabled: false}; it says … meanwhile; then the desktop’s toast and a fresh read', async () => {
  const h = await opened(); h.CMD.skuToggle();
  same(h.w(0), { p: '/api/retail-admin/sku/material/settings', method: 'PUT', body: { enabled: false } });
  assert.ok(screen(h).includes('Generate a SKU when a material is saved without one …'));
  h.calls.writes[0].res({ success: true }); await settle();
  same([h.calls.toasts, h.calls.reads.length], [['Automatic SKUs are off'], 2]);
});
it('refused: said above the rules, and it stays', async () => {
  const h = await opened(); h.CMD.skuToggle(); h.calls.writes[0].rej(refusal()); await settle();
  assert.ok(screen(h).startsWith('Could not change the setting: You don’t have permission to do that.'));
  same(h.calls.toasts, []);
});

section('3 · A rule: the four plain controls');
it('+ Add a rule opens the sheet on a letter and four digits, the first kind, all of it', async () => {
  const h = await opened(); h.CMD.skuAdd();
  same(h.s.draft, { id: null, category: 'food', subcategory: '', code: '', simple: { digits: 4, sep: '', year: 0 }, pattern: '{SUB}{SEQ:4}', advanced: false });
  const t = h.text(h.ctx.sheetSkuDraft());
  assert.ok(t.startsWith('New rule Kind Food Packaging Category — all of this kind — Dried fruits Nuts'), t);
  assert.ok(t.includes('Codes will look like 0001 · 0002 · 0003'), t);
});
it('the preview follows the controls, and a new kind empties the category', async () => {
  const h = await opened(); h.CMD.skuAdd(); h.CMD.skuField('subcategory', 'Nuts'); h.CMD.skuField('code', 'N');
  h.CMD.skuSimple('sep', '-'); h.CMD.skuSimple('year', 2); h.CMD.skuSimple('digits', '3');
  assert.ok(h.text(h.ctx.sheetSkuDraft()).includes(`Codes will look like N-${YY}-001 · N-${YY}-002 · N-${YY}-003`));
  h.CMD.skuKindPick('packaging'); same([h.s.draft.category, h.s.draft.subcategory], ['packaging', '']);
});
it('a code with a space is flagged before it is sent, in the desktop’s words', async () => {
  const h = await opened(); h.CMD.skuAdd(); h.CMD.skuField('code', 'D F');
  assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('A code may only contain letters, digits and . _ / - — remove any spaces.'));
});
it('Save rule: POST /sku/material/rules with the four FIELDS (the server composes); Saving…; then Rule saved and a fresh read', async () => {
  const h = await opened(); h.CMD.skuAdd(); h.CMD.skuField('subcategory', 'Nuts'); h.CMD.skuField('code', 'N'); h.CMD.skuSimple('sep', '-'); h.CMD.skuSave();
  same(h.w(0), { p: '/api/retail-admin/sku/material/rules', method: 'POST',
    body: { category: 'food', subcategory: 'Nuts', code: 'N', simple: { text: '', useCode: true, year: 0, sep: '-', digits: 4 } } });
  assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('Saving…'));
  h.calls.writes[0].res({ success: true, id: 9, warnings: [] }); await settle();
  same([h.s.draft, h.calls.toasts, h.calls.reads.length], [null, ['Rule saved'], 2]);
});
it('a warning is not a refusal: the rule saved, and the warning is what the toast says', async () => {
  const h = await opened(); h.CMD.skuAdd(); h.CMD.skuSave();
  h.calls.writes[0].res({ success: true, id: 9, warnings: [{ message_en: 'Two rules share the code N.', message_cn: '两条规则使用相同代码 N。' }] }); await settle();
  same(h.calls.toasts, ['Two rules share the code N.']);
});
it('refused: the reason stays on the sheet, which stays open — the server’s detail, or the desktop’s word for its code', async () => {
  for (const [err, want] of [[{ body: { error: 'bad', detail: [{ message_en: 'Pattern is empty.', message_cn: '格式为空。' }] } }, 'Pattern is empty.'],
    [{ code: 'code_too_long', body: { error: 'code_too_long' } }, 'A code may be at most 8 characters.'],
    [{ code: 'subcategory_needs_category', body: { error: 'subcategory_needs_category' } }, 'Pick a kind before a category.'],
    [refusal(), 'You don’t have permission to do that.']]) {
    const h = await opened(); h.CMD.skuAdd(); h.CMD.skuSave();
    h.calls.writes[0].rej(Object.assign(new Error('x'), err)); await settle();
    assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('Could not save the rule: ' + want), want);
    same(h.calls.toasts, []); assert.ok(h.s.draft);
  }
});
it('Edit opens a rule in the controls that made it; the fallback has no category to choose', async () => {
  const h = await opened(); h.CMD.skuEdit(3);
  same(h.s.draft, { id: 3, category: 'food', subcategory: 'Dried fruits', code: 'DF', simple: { digits: 3, sep: '-', year: 2 }, pattern: '{SUB}-{YY}-{SEQ:3}', advanced: false, locked: false });
  h.CMD.skuCancel(); h.CMD.skuEdit(1);
  assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('This is the fallback — it applies to everything with no rule of its own, so it has no category to choose.'));
  h.CMD.skuSave();
  same(h.w(0).body, { category: '', subcategory: '', code: '', simple: { text: '', useCode: false, year: 0, sep: '', digits: 5 } });
});

section('4 · Advanced: the one place a format is written');
it('a rule the controls cannot describe opens in Advanced, never flattened; its pattern is sent as written', async () => {
  const h = await opened(); h.CMD.skuEdit(4);
  assert.strictEqual(h.s.draft.advanced, true);
  const t = h.text(h.ctx.sheetSkuDraft());
  assert.ok(t.includes('Format') && t.includes('{SEQ:4}') && t.includes('← Back to the simple form'), t);
  h.CMD.skuSave();
  same(h.w(0).body, { category: 'packaging', subcategory: '', code: 'P', pattern: 'X{CAT}{NAME}{SEQ:4}' });
});
it('into Advanced carries the controls across as a pattern; back out reads it — and refuses a custom one', async () => {
  const h = await opened(); h.CMD.skuEdit(3); h.CMD.skuAdvanced();
  same([h.s.draft.advanced, h.s.draft.pattern], [true, '{SUB}-{YY}-{SEQ:3}']);
  h.CMD.skuAdvanced(); same([h.s.draft.advanced, h.s.draft.simple], [false, { digits: 3, sep: '-', year: 2 }]);
  h.CMD.skuEdit(4);   // busy-free: a second edit replaces the draft
  h.CMD.skuAdvanced();
  assert.strictEqual(h.s.draft.advanced, true);
  assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('This format uses pieces the simple form cannot show. Clear it first to go back.'));
});
it('a piece from the palette goes in at the caret', async () => {
  const h = await opened(); h.CMD.skuEdit(4);
  h.els.mSkuPattern = { selectionStart: 1, selectionEnd: 1, focus() {}, setSelectionRange() {} };
  h.CMD.skuInsert('{YY}');
  assert.strictEqual(h.s.draft.pattern, 'X{YY}{CAT}{NAME}{SEQ:4}');
  const sheet = h.ctx.sheetSkuDraft();
  assert.ok(TOKENS.length > 3);
  TOKENS.forEach((tk) => assert.ok(sheet.includes(`APP.cmd('skuInsert','${tk.insert}')`), 'the palette is the server’s token list: ' + tk.insert));
});
it('Advanced problems: empty, an unknown piece, a space', async () => {
  const h = await opened(); h.CMD.skuEdit(4);
  h.CMD.skuField('pattern', ''); assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('A format is required.'));
  h.CMD.skuField('pattern', '{FOO}{SEQ:4}'); assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('{FOO} is not one of the pieces above.'));
  h.CMD.skuField('pattern', 'A {SEQ:4}'); assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('remove any spaces'));
  h.CMD.skuField('pattern', 'AB'); assert.ok(h.text(h.ctx.sheetSkuDraft()).includes('Without a number, every material here would get the same code'));
});

section('5 · Removing a rule');
it('the desktop’s danger confirm says what it means; nothing sent before it', async () => {
  const h = await opened(); h.CMD.skuDeleteAsk(3);
  same([h.st.ask.title, h.st.ask.body, h.st.ask.confirmLabel, h.st.ask.danger], ['Remove the rule for Food ▸ Dried fruits?',
    'Materials already coded keep their SKUs. New ones will be numbered by the rule above it instead.', 'Remove', true]);
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.skuDeleteAsk(1); assert.strictEqual(h.st.ask.title, 'Remove the rule for Food ▸ Dried fruits?', 'the fallback is never asked about');
});
it('Remove: DELETE /sku/material/rules/3; the row says … ; then Rule removed and a fresh read', async () => {
  const h = await opened(); h.CMD.skuDeleteAsk(3); h.CMD.askRun('');
  same(h.w(0), { p: '/api/retail-admin/sku/material/rules/3', method: 'DELETE', body: {} });
  assert.ok(/skuDeleteAsk',3\)">…/.test(h.ctx.screenSkuCodes()));
  h.calls.writes[0].res({ success: true }); await settle();
  same([h.calls.toasts, h.calls.reads.length], [['Rule removed'], 2]);
});
it('refused: said above the rules, in the desktop’s words', async () => {
  const h = await opened(); h.CMD.skuDelete(3); h.calls.writes[0].rej(refusal()); await settle();
  assert.ok(screen(h).startsWith('Could not remove the rule: You don’t have permission to do that.'));
});

section('6 · Words, and the desktop and the engine are the spec');
it('in Chinese: the desktop’s pairs', async () => {
  const h = await opened({ lang: 'zh' }); const t = screen(h);
  ['物料自动编码', '保存未填写编码的物料时自动生成', '您的规则', '兜底规则', '全部 食品', '食品 ▸ Dried fruits', '下一个', '自定义格式', '个物料', '编辑', '删除', '+ 新增规则']
    .forEach((w) => assert.ok(t.includes(w), w));
  h.CMD.skuDeleteAsk(3); assert.strictEqual(h.st.ask.title, '删除 食品 ▸ Dried fruits 的编码规则？');
});
it('the preview twins agree with lib/sku-format.js — the engine that issues the codes', async () => {
  const h = await opened();
  for (const [pattern, c] of [['{CAT}{SEQ:4}', { seq: 3, categoryCode: 'F' }], ['{SUB}-{YY}-{SEQ:3}', { seq: 7, subcategoryCode: 'DF' }],
    ['X{CAT}{NAME}{SEQ:4}', { seq: 1, categoryCode: 'P', name: 'Dried Mango' }], ['{SEQ:5}', { seq: 12 }]]) {
    assert.strictEqual(h.ctx.skuRender(pattern, c), FMT.render(pattern, c), pattern);
  }
  for (const d of [{ code: 'B', simple: { digits: 4, sep: '-', year: 2 } }, { code: '', simple: { digits: 5, sep: '', year: 0 } }, { code: 'DF', subcategory: 'x', simple: { digits: 3, sep: '.', year: 4 } }]) {
    const scope = d.subcategory ? 'subcategory' : 'category';
    const p = h.ctx.skuCompose(d);
    same(p, FMT.fromSimple(Object.assign({ text: '', useCode: !!d.code }, d.simple), scope), JSON.stringify(d));
    const back = FMT.toSimple(p);
    same({ digits: back.digits, sep: back.sep, year: back.year }, d.simple);
  }
});
it('the desktop sends the same bodies and asks the same question', () => {
  assert.ok(SKU_JS.includes("api('/api/retail-admin/sku/' + ENTITY + '/settings', { method: 'PUT', body: { enabled: !!on } });"));
  assert.ok(SKU_JS.includes("useCode: !!d.code,"));
  assert.ok(SKU_JS.includes("titleEn: `Remove the rule for ${where}?`,"));
  assert.ok(SKU_JS.includes("api('/api/retail-admin/sku/' + ENTITY + '/rules/' + id, { method: 'DELETE' });"));
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
