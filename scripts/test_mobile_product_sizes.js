#!/usr/bin/env node
/**
 * §325 step PD9 — A PRODUCT'S SIZES, EDITED FROM THE PHONE.
 *
 *   node scripts/test_mobile_product_sizes.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — vaLoad (GET
 * /products/:id/variants), vaPersist (PUT /products/:id/variants {members,
 * noun_en, noun_cn}: labels, order, the picker's noun), vaPersistSiblings
 * (PATCH a sibling's sell_price / sku / weight / compare_at_price), the per-size
 * Show tick (is_published, that size only — §294), vaPhotoUpload (PATCH
 * {images:[photo]}), vaAddSize (POST /duplicate {as_variant:true,label:''})
 * and vaRemove (its confirm, then DELETE). The phone code is RUN, lifted out of
 * public/m.html by name into a sandbox with a fake server, so every write is
 * asserted on method, path and every body field. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');

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


const FNS = ['mCan', 'prodCanEdit', 'toggle', 'peSkuTaken', 'peErrText', 'vaMemberFrom', 'vaPutBody', 'loadPeSizes',
  'vaWrite', 'vaFind', 'peSizesCard', 'vaEditRun'];
const CONSTS = ['PILL', 'MCAN_MONEY_ONLY', 'money', 'cfgGet', 'PE_IMG', 'vaFail'];
const REGS = ['askRun', 'vaRetry', 'vaMove', 'vaShow', 'vaEditAsk', 'vaNounAsk', 'vaAdd', 'vaDelAsk', 'vaPhotoFile'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const ALL = ['products:view', 'products:edit', 'products:create', 'products:delete'];
const FAMILY = () => ({ group_id: 7, noun_en: '', noun_cn: '', members: [
  { id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', variant_label: '1 L', variant_label_cn: '1升', size: '1 L',
    price: 18, compare: null, stock: 9, image_data: '/api/retail-admin/products/7/image?v=a', own_image: true, is_published: 1 },
  { id: 8, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-2', variant_label: '250 ml', variant_label_cn: '250毫升', size: '250 ml',
    price: 6, compare: 8, stock: 0, image_data: '/api/retail-admin/products/8/image?v=b', own_image: false, is_published: 0 },
  { id: 9, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-3', variant_label: 'Family 2 L', variant_label_cn: '家庭装 2升', size: '2 L',
    price: 30, compare: null, stock: 4, image_data: null, own_image: false, is_published: 1 }] });
const LONE = () => ({ group_id: null, noun_en: '', noun_cn: '', members: [] });
const PERM = ['You don’t have permission to do that.', '你没有执行此操作的权限。'];
const refused = () => Object.assign(new Error('forbidden'), { refused: true, words: PERM });

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], catalogue: 0, peField: [], shrunk: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD, DB: { products: [] },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, catalogMode: opts.catalogMode || 'self', cfg: {},
      ask: null, askErr: null,
      pe: { pid: 7, row: { id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', sell_price: 18, is_published: 1 },
        draft: { sku: 'OM-1', weight: '1 L', sell_price: '18', compare_at_price: '' }, va: null } },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    loadCatalogue: () => { calls.catalogue++; return Promise.resolve(); },
    peShrinkPhoto: (f) => { calls.shrunk.push(f.size); return f.bad ? Promise.reject(new Error('toBlob failed')) : Promise.resolve({ dataURL: 'data:image/jpeg;base64,QUJD', resized: false, orig: f.size, final: f.size }); },
    api: (p) => { calls.reads.push(p); const v = (opts.serve || (() => FAMILY()))(p, calls.reads.length);
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  CMD.peField = (k, v) => { calls.peField.push([k, v]); ctx.state.pe.draft[k] = v; };
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  // Fill the open ask-sheet the way a person would, then press its confirm.
  const answer = (over) => {
    const a = ctx.state.ask; assert.ok(a && a.fields, 'no field sheet open');
    a.fields.forEach((f) => { els['ask-' + f.id] = { value: String(f.value == null ? '' : f.value) }; });
    Object.keys(over || {}).forEach((k) => { els['ask-' + k] = { value: over[k] }; });
    CMD.askRun('');
  };
  return { ctx, CMD, calls, text, s: ctx.state, va: () => ctx.state.pe.va, card: () => ctx.peSizesCard(), answer,
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
async function loaded(opts) { const h = mk(opts); h.ctx.loadPeSizes(h.s.pe); await settle(); return h; }
const MEMBERS = (order, labels) => order.map((id) => ({ id, label: (labels || {})[id] ? labels[id][0] : { 7: '1 L', 8: '250 ml', 9: 'Family 2 L' }[id],
  label_cn: (labels || {})[id] ? labels[id][1] : { 7: '1升', 8: '250毫升', 9: '家庭装 2升' }[id] }));

section('1 · The family, read: loading, list, empty, failed, refused');
it('reads GET /products/7/variants and says Loading… until it lands', async () => {
  const h = mk(); h.ctx.loadPeSizes(h.s.pe);
  same(h.calls.reads, ['/products/7/variants']);
  assert.ok(h.text(h.card()).includes('Variants Loading…'));
});
it('each size: its label in both languages stacked, SKU · size, price and struck was-price, stock, and Hidden on the one that is off', async () => {
  const h = await loaded(); const t = h.text(h.card());
  assert.ok(t.includes('250 ml 250毫升 OM-2 · 250 ml ¥6 ¥8 · Stock 0 Hidden'), t);
  assert.ok(t.includes('Family 2 L 家庭装 2升 OM-3 · 2 L ¥30 · Stock 4'), t);
  assert.ok(/<s [^>]*>¥8<\/s>/.test(h.card()), 'the was-price is struck through');
  assert.strictEqual((t.match(/Hidden/g) || []).length, 1, 'only the size that is off says Hidden');
});
it('the size open on this screen shows what its boxes above hold, not the server’s older copy', async () => {
  const h = await loaded(); h.s.pe.draft.sell_price = '19.5'; h.s.pe.draft.sku = 'OM-1B';
  assert.ok(h.text(h.card()).includes('1 L 1升 OM-1B · 1 L ¥19.50 · Stock 9'));
});
it('a size with a sibling’s photo is drawn dimmed and offers its own; one with none offers Add', async () => {
  const h = await loaded(); const html = h.card();
  assert.ok(html.includes('aria-label="Shared from another variant — click to give this one its own photo"'));
  assert.ok(html.includes('aria-label="Add a photo for this variant"'));
  assert.ok(/opacity:\.55;[^>]*aria-label="Shared from another variant/.test(html));
  assert.ok(!/vaPhotoFile',7,/.test(html), 'the open size’s photo is the Photos card above, not this row');
});
it('a product with no family: Single option · tap to add, and + Add variant', async () => {
  const h = await loaded({ serve: () => LONE() }); const t = h.text(h.card());
  assert.strictEqual(t, 'Variants Single option · tap to add + Add variant');
});
it('without products:create the empty card does not promise a tap, and offers no Add', async () => {
  const h = await loaded({ serve: () => LONE(), caps: ['products:view', 'products:edit'] });
  assert.strictEqual(h.text(h.card()), 'Variants Single option');
});
it('a failed read says Load failed with Try again, which reads again', async () => {
  let n = 0; const h = await loaded({ serve: () => (++n === 1 ? new Error('HTTP 500') : FAMILY()) });
  assert.strictEqual(h.text(h.card()), 'Variants Load failed Try again');
  h.CMD.vaRetry(); await settle();
  same(h.calls.reads, ['/products/7/variants', '/products/7/variants']);
  assert.ok(h.text(h.card()).includes('Family 2 L'));
});
it('a refused read says why', async () => {
  const h = await loaded({ serve: () => refused() });
  assert.ok(h.text(h.card()).includes('You don’t have permission to do that.'));
});
it('without products:edit: the family is listed and nothing on it is a control', async () => {
  const h = await loaded({ caps: ['products:view'] }); const html = h.card();
  assert.ok(h.text(html).includes('Family 2 L'));
  ['vaMove', 'vaShow', 'vaEditAsk', 'vaDelAsk', 'vaPhotoFile', 'vaAdd'].forEach((c) => assert.ok(!html.includes(c), c));
  h.CMD.vaMove(1, -1); h.CMD.vaShow(8); h.CMD.vaEditAsk(8); h.CMD.vaDelAsk(8); h.CMD.vaAdd();
  assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.s.ask, null);
});
it('in Chinese: the desktop’s pairs', async () => {
  const h = await loaded({ lang: 'zh' }); const t = h.text(h.card());
  ['规格', '库存', '已隐藏', '上架', '+ 新增规格', '这些规格是什么?', '选择器标题 — 留空为「size / 规格」。'].forEach((x) => assert.ok(t.includes(x), x));
});

section('2 · Order: the whole family, in its new order, in one PUT');
it('the first cannot move up and the last cannot move down', async () => {
  const h = await loaded(); const html = h.card();
  assert.ok(/disabled aria-label="Move up" onclick="APP\.cmd\('vaMove',0,-1\)"/.test(html));
  assert.ok(/disabled aria-label="Move down" onclick="APP\.cmd\('vaMove',2,1\)"/.test(html));
  h.CMD.vaMove(0, -1); h.CMD.vaMove(2, 1); assert.strictEqual(h.calls.writes.length, 0);
});
it('Move up: PUT /products/7/variants {members in the new order with both labels, noun_en, noun_cn}; Saving… while it runs', async () => {
  const h = await loaded(); h.CMD.vaMove(1, -1); await settle();
  same(h.w(0), { p: '/products/7/variants', method: 'PUT', body: { members: MEMBERS([8, 7, 9]), noun_en: '', noun_cn: '' } });
  const html = h.card();
  assert.ok(h.text(html).includes('Saving…'));
  assert.ok(/disabled aria-label="Move down" onclick="APP\.cmd\('vaMove',0,1\)"/.test(html), 'every control waits');
  h.CMD.vaMove(2, -1); assert.strictEqual(h.calls.writes.length, 1, 'one write at a time');
  h.calls.writes[0].res({ success: true, group_id: 7, count: 3 }); await settle();
  same(h.calls.reads, ['/products/7/variants', '/products/7/variants'], 'the family is read again');
  assert.strictEqual(h.calls.catalogue, 1, 'and the catalogue, so the sheet’s size chips follow');
});
it('a refused move says why on the card, keeps the old order, and toasts nothing', async () => {
  const h = await loaded(); h.CMD.vaMove(1, -1); await settle();
  h.calls.writes[0].rej(refused()); await settle();
  assert.ok(h.text(h.card()).includes('You don’t have permission to do that.'));
  same(h.va().members.map((m) => m.id), [7, 8, 9]); same(h.calls.toasts, []);
});

section('3 · Show (§294): this size, and no other');
it('turning a hidden size on: PATCH /products/8 {is_published: 1} — never the family switch', async () => {
  const h = await loaded(); h.CMD.vaShow(8); await settle();
  same(h.w(0), { p: '/products/8', method: 'PATCH', body: { is_published: 1 } });
  h.calls.writes[0].res({ success: true }); await settle();
  assert.strictEqual(h.calls.writes.length, 1);
});
it('turning the open size off: PATCH /products/7 {is_published: 0}', async () => {
  const h = await loaded(); h.CMD.vaShow(7); await settle();
  same(h.w(0), { p: '/products/7', method: 'PATCH', body: { is_published: 0 } });
});
it('nothing in the sizes code reaches for /family-publish', () => {
  const block = M.slice(M.indexOf('§325 PD9 — A PRODUCT\'S SIZES'), M.indexOf('§325 PD6 — A PRODUCT\'S PHOTOS'));
  assert.ok(block.length > 1000 && !block.includes('family-publish(') && !block.includes("'/products/family-publish'"));
});

section('4 · One size’s fields: the edit sheet');
it('another size: its labels, SKU, size, price and was-price, under the desktop’s words', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(8);
  assert.strictEqual(h.s.ask.title, 'Edit this variant');
  same(h.s.ask.fields.map((f) => [f.label, f.value]), [['English · e.g. Big 200g', '250 ml'], ['中文 · 如 大 200克', '250毫升'],
    ['SKU', 'OM-2'], ['Size / weight', '250 ml'], ['Price', '6'], ['Was price', '8']]);
});
it('changed nothing: nothing is sent', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(8); h.answer({}); await settle();
  assert.strictEqual(h.calls.writes.length, 0);
});
it('a new label goes in the family PUT first, then the fields in a PATCH of that size with the desktop’s keys — only those that moved', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(8);
  h.answer({ label: 'Small 250 ml', label_cn: '小 250毫升', price: '6.5', was: '' }); await settle();
  same(h.w(0), { p: '/products/7/variants', method: 'PUT',
    body: { members: MEMBERS([7, 8, 9], { 8: ['Small 250 ml', '小 250毫升'] }), noun_en: '', noun_cn: '' } });
  assert.strictEqual(h.calls.writes.length, 1, 'the PATCH waits for the PUT');
  h.calls.writes[0].res({ success: true }); await settle();
  same(h.w(1), { p: '/products/8', method: 'PATCH', body: { sell_price: 6.5, compare_at_price: 0 } });
  h.calls.writes[1].res({ success: true, data: { id: 8 } }); await settle();
  assert.strictEqual(h.calls.catalogue, 1);
});
it('SKU and size alone: PATCH {sku, weight}', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(9); h.answer({ sku: 'OM-3F', weight: '2 litres' }); await settle();
  same(h.w(0), { p: '/products/9', method: 'PATCH', body: { sku: 'OM-3F', weight: '2 litres' } });
});
it('an emptied price is never sent; a price that is not a number keeps the sheet open', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(9); h.answer({ price: '', sku: 'OM-3G' }); await settle();
  same(h.w(0).body, { sku: 'OM-3G' });
  const h2 = await loaded(); h2.CMD.vaEditAsk(9); h2.answer({ price: 'abc' });
  assert.strictEqual(h2.s.askErr, 'Enter a price — a number, 0 or more.'); assert.ok(h2.s.ask);
  assert.strictEqual(h2.calls.writes.length, 0);
});
it('a SKU another product holds names that product and this size, in the desktop’s words, on the card', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(9); h.answer({ sku: 'OM-1' }); await settle();
  h.calls.writes[0].rej(Object.assign(new Error('sku_taken'), { code: 'sku_taken', body: { error: 'sku_taken', conflict: { id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', variant_label: '1 L', is_active: 1, is_published: 1 } } }));
  await settle();
  assert.ok(h.text(h.card()).includes('SKU “OM-1” (size “Family 2 L”) is already used by “Oat milk · 1 L”'), h.text(h.card()));
  same(h.calls.toasts, []);
});
it('the size open on this screen: SKU, size, price and was-price go into the boxes above (one field per fact) and nothing is written', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(7);
  same(h.s.ask.fields.slice(2).map((f) => f.value), ['OM-1', '1 L', '18', '']);
  h.answer({ sku: 'OM-1X', price: '19' }); await settle();
  same(h.calls.peField, [['sku', 'OM-1X'], ['sell_price', '19']]);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('the open size’s label still goes in the family PUT', async () => {
  const h = await loaded(); h.CMD.vaEditAsk(7); h.answer({ label: 'Litre' }); await settle();
  same(h.w(0), { p: '/products/7/variants', method: 'PUT', body: { members: MEMBERS([7, 8, 9], { 7: ['Litre', '1升'] }), noun_en: '', noun_cn: '' } });
  same(h.calls.peField, []);
});

section('5 · The picker’s noun');
it('the sheet carries the desktop’s hint; Save sends the family PUT with the new noun', async () => {
  const h = await loaded(); h.CMD.vaNounAsk();
  assert.strictEqual(h.s.ask.title, 'What are these variants?');
  assert.ok(h.text(h.s.ask.body).includes('Picker heading — blank = “size / 规格”.'));
  h.answer({ noun_en: ' flavor ', noun_cn: '口味' }); await settle();
  same(h.w(0), { p: '/products/7/variants', method: 'PUT', body: { members: MEMBERS([7, 8, 9]), noun_en: 'flavor', noun_cn: '口味' } });
  h.calls.writes[0].res({ success: true }); await settle();
  same([h.va().noun_en, h.va().noun_cn], ['', ''], 'the re-read is the truth (this fake server still says blank)');
});
it('unchanged: nothing is sent; a family of one has no noun to set', async () => {
  const h = await loaded(); h.CMD.vaNounAsk(); h.answer({}); await settle();
  assert.strictEqual(h.calls.writes.length, 0);
  const h2 = await loaded({ serve: () => LONE() }); h2.CMD.vaNounAsk(); assert.strictEqual(h2.s.ask, null);
});

section('6 · Add a size');
it('+ Add variant: POST /products/7/duplicate {as_variant: true, label: ""}; the button says Adding…', async () => {
  const h = await loaded(); h.CMD.vaAdd(); await settle();
  same(h.w(0), { p: '/products/7/duplicate', method: 'POST', body: { as_variant: true, label: '' } });
  assert.ok(h.text(h.card()).includes('Adding…'));
});
it('the new size arrives hidden (§294), the family is read again, and its edit sheet opens', async () => {
  let n = 0;
  const h = await loaded({ serve: () => { n++; const f = FAMILY(); if (n > 1) f.members.push({ id: 12, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'R-12', variant_label: null, variant_label_cn: null, size: '1 L', price: 18, compare: null, stock: 0, image_data: null, own_image: false, is_published: 0 }); return f; } });
  h.CMD.vaAdd(); await settle();
  h.calls.writes[0].res({ success: true, data: { id: 12, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'R-12', weight: '1 L', sell_price: 18, is_published: 0, stock_qty: 0 } });
  await settle();
  same(h.calls.toasts, ['Variant added']);
  assert.strictEqual(h.s.ask && h.s.ask.title, 'Edit this variant');
  same(h.s.ask.fields.map((f) => f.value), ['', '', 'R-12', '1 L', '18', '']);
  assert.strictEqual(h.calls.catalogue, 1);
  assert.strictEqual((h.text(h.card()).match(/Hidden/g) || []).length, 2, 'the new size is off until someone turns it on');
});
it('without products:create, or on an upstream catalogue, nothing is sent', async () => {
  const h = await loaded({ caps: ['products:view', 'products:edit'] }); h.CMD.vaAdd();
  assert.ok(!h.card().includes('vaAdd')); assert.strictEqual(h.calls.writes.length, 0);
  const h2 = await loaded({ catalogMode: 'upstream' }); h2.CMD.vaAdd(); assert.strictEqual(h2.calls.writes.length, 0);
});
it('a failed add says so on the card, in the desktop’s words, and opens nothing', async () => {
  const h = await loaded(); h.CMD.vaAdd(); await settle();
  h.calls.writes[0].rej(new Error('catalog_locked')); await settle();
  assert.ok(h.text(h.card()).includes('Could not add variant: catalog_locked'));
  assert.strictEqual(h.s.ask, null); same(h.calls.toasts, []);
});

section('7 · Delete a size');
it('the desktop’s question first, nothing sent before the answer', async () => {
  const h = await loaded(); h.CMD.vaDelAsk(8);
  assert.strictEqual(h.s.ask.title, 'Delete the variant “250 ml”?');
  assert.strictEqual(h.s.ask.body, 'This removes that product for good.');
  assert.strictEqual(h.s.ask.confirmLabel, 'Delete'); assert.strictEqual(h.s.ask.danger, true);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Delete: DELETE /products/8, Deleting… on the card, then Size deleted', async () => {
  const h = await loaded(); h.CMD.vaDelAsk(8); h.CMD.askRun(''); await settle();
  same(h.w(0), { p: '/products/8', method: 'DELETE', body: {} });
  assert.ok(h.text(h.card()).includes('Deleting…'));
  h.calls.writes[0].res({ success: true }); await settle();
  same(h.calls.toasts, ['Size deleted']);
});
it('the open size has no Delete here; without products:delete no size has one', async () => {
  const h = await loaded(); assert.ok(!h.card().includes("vaDelAsk',7)")); h.CMD.vaDelAsk(7); assert.strictEqual(h.s.ask, null);
  const h2 = await loaded({ caps: ['products:view', 'products:edit', 'products:create'] });
  assert.ok(!h2.card().includes('vaDelAsk')); h2.CMD.vaDelAsk(8); assert.strictEqual(h2.s.ask, null);
});
it('a refused delete says why on the card and keeps the size', async () => {
  const h = await loaded(); h.CMD.vaDelAsk(8); h.CMD.askRun(''); await settle();
  h.calls.writes[0].rej(refused()); await settle();
  assert.ok(h.text(h.card()).includes('You don’t have permission to do that.'));
  same(h.va().members.map((m) => m.id), [7, 8, 9]);
});
it('in Chinese, the desktop’s question', async () => {
  const h = await loaded({ lang: 'zh' }); h.CMD.vaDelAsk(8);
  assert.strictEqual(h.s.ask.title, '删除规格“250 ml”?');
  assert.strictEqual(h.s.ask.body, '将永久删除该产品。');
});

section('8 · Another size’s own photo');
it('a picked picture is shrunk, then PATCH /products/8 {images: [it]}; Uploading… meanwhile; then Variant photo updated', async () => {
  const h = await loaded(); const el = { files: [{ size: 300000, type: 'image/png' }], value: 'C:\\x.png' };
  h.CMD.vaPhotoFile(8, el); assert.strictEqual(el.value, '', 'the picker is cleared for the next pick');
  assert.ok(h.text(h.card()).includes('Uploading…'));
  await settle();
  same(h.calls.shrunk, [300000]);
  same(h.w(0), { p: '/products/8', method: 'PATCH', body: { images: ['data:image/jpeg;base64,QUJD'] } });
  h.calls.writes[0].res({ success: true }); await settle();
  same(h.calls.toasts, ['Variant photo updated']);
});
it('too big is refused before any work, on the card', async () => {
  const h = await loaded(); h.CMD.vaPhotoFile(8, { files: [{ size: 26 * 1024 * 1024 }], value: '' }); await settle();
  assert.ok(h.text(h.card()).includes('Image too huge (max 25MB)'));
  same(h.calls.shrunk, []); assert.strictEqual(h.calls.writes.length, 0);
});
it('a failed upload says so in the desktop’s words', async () => {
  const h = await loaded(); h.CMD.vaPhotoFile(8, { files: [{ size: 10, bad: true }], value: '' }); await settle();
  assert.ok(h.text(h.card()).includes('Photo update failed: toBlob failed'));
  assert.strictEqual(h.calls.writes.length, 0);
});
it('the open size is not given a photo from here', async () => {
  const h = await loaded(); h.CMD.vaPhotoFile(7, { files: [{ size: 10 }], value: '' }); await settle();
  same(h.calls.shrunk, []); assert.strictEqual(h.calls.writes.length, 0);
});

section('9 · The desktop is the spec, and the card is on the Details screen');
it('the desktop sends the same requests', () => {
  assert.ok(PRODUCTS_JS.includes("'/variants', { method: 'PUT', body: { members, noun_en: VA_NOUN_EN || '', noun_cn: VA_NOUN_CN || '' } }"));
  assert.ok(PRODUCTS_JS.includes("const members = VA_MEMBERS.map(v => ({ id: v.id, label: v.label || '', label_cn: v.label_cn || '' }));"));
  assert.ok(PRODUCTS_JS.includes("'/duplicate', { method: 'POST', body: { as_variant: true, label: '' } }"));
  assert.ok(PRODUCTS_JS.includes("{ method: 'PATCH', body: { images: [dataURL] } }"));
  ['body.sell_price = v.price', 'body.sku = v.sku', 'body.weight = v.size', 'body.compare_at_price ='].forEach((k) => assert.ok(PRODUCTS_JS.includes(k), k));
});
it('the Details screen draws the card and loadPe reads the family', () => {
  const scr = liftFn('screenProductEdit'), lp = liftFn('loadPe');
  assert.ok(scr.includes('${peSizesCard()}')); assert.ok(lp.includes('loadPeSizes(e);'));
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
