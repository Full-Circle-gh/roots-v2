#!/usr/bin/env node
/**
 * §325 step PD14 — BULK EDITS, BULK DELETE, AND DELETING ONE PRODUCT, FROM
 * THE PHONE.
 *
 *   node scripts/test_mobile_products_bulk.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js —
 * paToggleSelect / paSelectAllVisible (a family ticks as a block),
 * paRenderBulkBar's five menus, paBulkApply (its confirm, then one PATCH per
 * product in turn — or ONE POST /products/family-publish for the shop switch,
 * §294), paBulkDelete (its danger confirm, then DELETE each), and pdDelete. The
 * phone code is RUN, lifted out of public/m.html by name into a sandbox with a
 * fake server, so every write is asserted on method, path and body, before and
 * after its confirm. No browser — fast shard.
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


const FNS = ['mCan', 'prodCanEdit', 'toggle', 'pill', 'prodUnits', 'productCard',
  'prodBulkCanEdit', 'prodBulkCanDelete', 'prodBulkAny', 'prodVisibleIds', 'prodBulkBar', 'peDeleteRow'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'money', 'prodBySize', 'PROD_BULK', 'PROD_BULK_MENUS'];
const REGS = ['askRun', 'prodSelect', 'prodSelToggle', 'prodSelAll', 'prodSelClear', 'prodBulkMenu', 'prodBulkAsk', 'prodBulkDeleteAsk',
  'peDeleteAsk', 'peDelete'];
// prodBulkRun is an async function; the lifter's anchor is `function name(`.
const liftAsync = (name) => { const at = M.indexOf('\nasync function ' + name + '('); assert.ok(at >= 0, 'cannot find async ' + name);
  return M.slice(at + 1, skipBalanced(M, M.indexOf('{', M.indexOf(')', at)))); };
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null;', ...FNS.map(liftFn), liftAsync('prodBulkRun'), ...REGS.map(liftReg)].join('\n');

const P = (id, name, o) => Object.assign({ _id: id, name: [name, name], sku: 'SKU S' + id, rawSku: 'S' + id, price: '¥10', priceNum: 10, stock: 5,
  stockLabel: ['5 in stock', '库存 5'], status: ['Live', '在售'], kind: 'on', pub: true, gid: null, vLabel: '', vSort: 0, img: '' }, o || {});
const CAT = () => [P(7, 'Oat milk'), P(21, 'Granola', { gid: 21, vLabel: '250 g', vSort: 0 }), P(22, 'Granola', { gid: 21, vLabel: '500 g', vSort: 1 }), P(30, 'Jam')];
const ALL = ['products:view', 'products:edit', 'products:delete'];
const REFUSED = ['You don’t have permission to do that.', '你没有执行此操作的权限。'];
const refusal = () => Object.assign(new Error('forbidden'), { refused: true, words: REFUSED, code: 'forbidden' });

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], catalogue: 0, pops: 0, stops: 0, touches: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD, DB: { products: opts.products || CAT() },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, catalogMode: opts.catalogMode || 'self', ask: null, askErr: null, cfg: {},
      prodSel: opts.sel === undefined ? null : opts.sel, prodBulk: { busy: null, err: null }, prodBusy: false,
      stack: [{ route: 'productedit', pid: 7 }], pe: opts.pe === undefined ? { pid: 7, delBusy: false, delErr: null } : opts.pe },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    prodFiltered: () => (opts.shown ? ctx.DB.products.filter((p) => opts.shown.includes(p._id)) : ctx.DB.products.slice()),
    loadCatalogue: () => { calls.catalogue++; return Promise.resolve(); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    peErrText: () => 'That did not save. Nothing has changed — try again.',
    showToast: (m) => calls.toasts.push(String(m)),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  if (opts.auto) vm.runInContext('peAuto={ stop(){ __c.stops++; }, touch(){ __c.touches++; } };', Object.assign(ctx, { __c: calls }));
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, st: ctx.state,
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const units = (h) => h.ctx.prodUnits(h.ctx.prodFiltered());
const sel = (h) => h.st.prodSel;
async function answerAll(h, ok = true) { // resolve each write as it appears, in order
  for (let i = 0; i < 20; i++) { await settle(); const x = h.calls.writes.find((w) => !w.done); if (!x) return; x.done = true; ok ? x.res({ success: true }) : x.rej(refusal()); }
}

section('1 · Select: the door and the ticks');
it('Select arms ticking, Done ends it; without products:edit or products:delete there is no Select', () => {
  const h = mk(); h.CMD.prodSelect(); same(sel(h), []); h.CMD.prodSelect(); assert.strictEqual(sel(h), null);
  const r = mk({ caps: ['products:view'] }); assert.strictEqual(r.ctx.prodBulkAny(), false); r.CMD.prodSelect(); assert.strictEqual(sel(r), null);
  assert.ok(M.includes("const sel=prodBulkAny()?`<button class=\"btn2\" style=\"width:auto;flex:none;padding:0 14px\" onclick=\"APP.cmd('prodSelect')\">${Array.isArray(state.prodSel)?T('Done','完成'):T('Select','选择')}</button>`:'';"));
});
it('while selecting, a card ticks instead of opening, and a family ticks as one block — every size', () => {
  const h = mk({ sel: [] }); const fam = units(h).find((u) => u.group);
  const html = h.ctx.productCard(fam);
  assert.ok(html.includes(`onclick="APP.cmd('prodSelToggle','21,22')"`) && !html.includes('openProduct') && !html.includes('toggleShop'));
  h.CMD.prodSelToggle('21,22'); same(sel(h), [21, 22]);
  assert.ok(h.ctx.productCard(fam).includes('aria-pressed="true"'));
  h.CMD.prodSelToggle('21,22'); same(sel(h), []);
});
it('a half-ticked family flips fully on (paToggleSelect)', () => {
  const h = mk({ sel: [22] }); h.CMD.prodSelToggle('21,22'); same(sel(h).slice().sort(), [21, 22]);
});
it('not selecting: the card is unchanged — it opens the product and carries the shop switch', () => {
  const h = mk(); const html = h.ctx.productCard(units(h)[0]);
  assert.ok(html.includes("APP.cmd('openProduct','SKU S7')") && html.includes("toggleShop"));
});
it('the bar: how many, Select all what the filters show / Clear page, Clear', () => {
  const h = mk({ sel: [], shown: [7, 21, 22] });
  assert.strictEqual(h.text(h.ctx.prodBulkBar()), '0 selected Select all 3');
  h.CMD.prodSelAll(1); same(sel(h), [7, 21, 22]);
  const t = h.text(h.ctx.prodBulkBar());
  assert.ok(t.startsWith('3 selected Clear page Clear Shop Badge Shipping More Delete'), t);
  h.CMD.prodSelAll(0); same(sel(h), []);
  h.CMD.prodSelToggle('30'); h.CMD.prodSelClear(); same(sel(h), []);
  assert.strictEqual(mk().ctx.prodBulkBar(), '', 'no bar when not selecting');
});
it('products:edit alone: the four menus, no Delete; products:delete alone: Delete only; upstream: no Delete', () => {
  assert.ok(!mk({ sel: [7], caps: ['products:edit'] }).text(mk({ sel: [7], caps: ['products:edit'] }).ctx.prodBulkBar()).includes('Delete'));
  const d = mk({ sel: [7], caps: ['products:delete'] }); const t = d.text(d.ctx.prodBulkBar());
  assert.ok(t.includes('Delete') && !t.includes('Badge'));
  const u = mk({ sel: [7], catalogMode: 'upstream' }); assert.ok(!u.text(u.ctx.prodBulkBar()).includes('Delete'));
  u.CMD.prodBulkDeleteAsk(); assert.strictEqual(u.st.ask, null);
});

section('2 · A bulk change: the menu, the confirm, the writes');
it('each menu lists the desktop’s items', () => {
  const h = mk({ sel: [7] });
  const items = (k) => { h.CMD.prodBulkMenu(k); const a = h.st.ask; h.st.ask = null; return [a.title, a.options.map((o) => o.label)]; };
  same(items('shop'), ['Shop', ['Turn on', 'Turn off']]);
  same(items('badge'), ['Badge', ['None', 'Auto', 'NEW', 'POP', 'SALE', 'HOT']]);
  same(items('ship'), ['Shipping', ['Air + Land', 'Air only', 'Land only']]);
  same(items('more'), ['More', ['Show in markets', 'Hide from markets', 'Mark fresh batch', 'Not fresh batch']]);
});
it('picking asks the desktop’s question with the count, and sends nothing until Apply', () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkMenu('badge'); h.CMD.askRun('badge-new');
  same([h.st.ask.title, h.st.ask.confirmLabel], ['Set badge to NEW — 2 product(s)?', 'Apply']);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Apply: one PATCH {tags} per product, one at a time; Working… meanwhile; then Updated N ✓ and the catalogue read again', async () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkAsk('badge-new'); h.CMD.askRun(''); await settle();
  same(h.calls.writes.map((x) => ({ p: x.p, body: x.body, method: x.method })), [{ p: '/products/7', body: { tags: 'new' }, method: 'PATCH' }]);
  assert.ok(h.text(h.ctx.prodBulkBar()).includes('Working…') && /disabled/.test(h.ctx.prodBulkBar()));
  h.CMD.prodBulkAsk('badge-hot'); assert.strictEqual(h.st.ask, null, 'nothing new starts under a write');
  await answerAll(h);
  same(h.calls.writes.map((x) => x.p), ['/products/7', '/products/30']);
  same([h.calls.toasts, h.calls.catalogue, sel(h)], [['Updated 2 ✓'], 1, [7, 30]]);
});
it('each item’s body is the desktop’s', async () => {
  const want = { 'badge-none': { tags: '' }, 'badge-auto': { tags: 'auto' }, 'ship-both': { ship_modes: 'air,land' }, 'ship-air': { ship_modes: 'air' },
    'ship-land': { ship_modes: 'land' }, 'mkt-on': { is_market: 1 }, 'mkt-off': { is_market: 0 }, 'batch-on': { is_batch_made: 1 }, 'batch-off': { is_batch_made: 0 } };
  for (const k of Object.keys(want)) {
    const h = mk({ sel: [7] }); h.CMD.prodBulkAsk(k); h.CMD.askRun(''); await settle();
    same(h.w(0), { p: '/products/7', method: 'PATCH', body: want[k] }, k);
  }
});
it('the shop switch is ONE family-publish for every tick, never a PATCH per size (§294)', async () => {
  const h = mk({ sel: [21, 22, 7] }); h.CMD.prodBulkAsk('shop-off');
  assert.strictEqual(h.st.ask.title, 'Hide from the shop — 3 product(s)?');
  h.CMD.askRun(''); await settle();
  same(h.calls.writes.map((x) => ({ p: x.p, body: x.body, method: x.method })), [{ p: '/products/family-publish', body: { ids: [21, 22, 7], on: false }, method: 'POST' }]);
  await answerAll(h); same(h.calls.toasts, ['Updated 3 ✓']);
  const on = mk({ sel: [7] }); on.CMD.prodBulkAsk('shop-on'); on.CMD.askRun(''); await settle();
  same(on.w(0).body, { ids: [7], on: true });
});
it('a shortfall is counted in the desktop’s words, with the refusal’s own, on the bar — and it stays', async () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkAsk('mkt-on'); h.CMD.askRun('');
  await answerAll(h, false);
  assert.strictEqual(h.st.prodBulk.err, '0 done, 2 failed — You don’t have permission to do that.');
  assert.ok(h.text(h.ctx.prodBulkBar()).includes('0 done, 2 failed'));
  same(h.calls.toasts, []);
});
it('a refused family-publish counts every tick as failed', async () => {
  const h = mk({ sel: [21, 22] }); h.CMD.prodBulkAsk('shop-on'); h.CMD.askRun(''); await answerAll(h, false);
  assert.strictEqual(h.st.prodBulk.err, '0 done, 2 failed — You don’t have permission to do that.');
});
it('without products:edit a menu does not open and nothing is sent', () => {
  const h = mk({ sel: [7], caps: ['products:delete'] }); h.CMD.prodBulkMenu('badge'); h.CMD.prodBulkAsk('badge-new');
  same([h.st.ask, h.calls.writes.length], [null, 0]);
});

section('3 · Bulk delete');
it('the desktop’s danger confirm: how many, that it frees SKUs, that it cannot be undone; nothing sent before it', () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkDeleteAsk();
  same([h.st.ask.title, h.st.ask.body, h.st.ask.confirmLabel, h.st.ask.danger],
    ['Delete 2 product(s)?', 'This removes them from the catalogue and frees their SKUs. This cannot be undone.', 'Delete', true]);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Delete: DELETE each in turn; the shelf loses them, the ticks clear, Deleted N ✓', async () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkDeleteAsk(); h.CMD.askRun(''); await answerAll(h);
  same(h.calls.writes.map((x) => ({ p: x.p, body: x.body, method: x.method })), [{ p: '/products/7', body: {}, method: 'DELETE' }, { p: '/products/30', body: {}, method: 'DELETE' }]);
  same([h.ctx.DB.products.map((p) => p._id), sel(h), h.calls.toasts, h.calls.catalogue], [[21, 22], [], ['Deleted 2 ✓'], 1]);
});
it('some refused: the count in the desktop’s words stays on the bar, and the ticks stay', async () => {
  const h = mk({ sel: [7, 30] }); h.CMD.prodBulkDeleteAsk(); h.CMD.askRun('');
  await settle(); h.calls.writes[0].res({ success: true }); await settle(); h.calls.writes[1].rej(refusal()); await settle();
  assert.strictEqual(h.st.prodBulk.err, '1 deleted, 1 failed — You don’t have permission to do that.');
  same(sel(h), [7, 30]); same(h.calls.toasts, []);
});
it('in Chinese: the desktop’s pairs', () => {
  const h = mk({ sel: [7, 30], lang: 'zh' }); const t = h.text(h.ctx.prodBulkBar());
  ['已选 2 件', '全选 4', '清除', '上架', '标签', '配送', '更多', '删除'].forEach((w) => assert.ok(t.includes(w), w));
  h.CMD.prodBulkAsk('ship-air'); assert.strictEqual(h.st.ask.title, '设置配送为仅空运 — 2 件商品?');
  h.st.ask = null; h.CMD.prodBulkDeleteAsk(); assert.strictEqual(h.st.ask.body, '将从商品库移除并释放其 SKU。此操作无法撤销。');
});

section('4 · Deleting one product, from its Details screen');
it('products:delete gets Delete on the Details screen; not for a product not yet saved, not upstream, not without the key', () => {
  assert.ok(mk().text(mk().ctx.peDeleteRow()).includes('Delete'));
  assert.strictEqual(mk({ pe: { pid: null } }).ctx.peDeleteRow(), '');
  assert.strictEqual(mk({ catalogMode: 'upstream' }).ctx.peDeleteRow(), '');
  assert.strictEqual(mk({ caps: ['products:edit'] }).ctx.peDeleteRow(), '');
  assert.ok(/\$\{peDeleteRow\(\)\}/.test(liftFn('screenProductEdit')));
});
it('the desktop’s question first, nothing sent before the answer', () => {
  const h = mk(); h.CMD.peDeleteAsk();
  same([h.st.ask.title, h.st.ask.body, h.st.ask.confirmLabel, h.st.ask.danger], ['Delete this product?', 'It will be hidden from the shop.', 'Delete', true]);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Delete: the pending edit is dropped, DELETE /products/7, Deleting… meanwhile; then gone from the shelf and the screen closes', async () => {
  const h = mk({ auto: true }); h.CMD.peDeleteAsk(); h.CMD.askRun('');
  same(h.w(0), { p: '/products/7', method: 'DELETE', body: {} });
  assert.strictEqual(h.calls.stops, 1, 'an edit typed a moment ago is not sent to a product being deleted');
  assert.ok(h.text(h.ctx.peDeleteRow()).includes('Deleting…'));
  h.calls.writes[0].res({ success: true }); await settle();
  same([h.ctx.DB.products.map((p) => p._id), h.calls.toasts, h.calls.pops, h.st.pe], [[21, 22, 30], ['Deleted'], 1, null]);
});
it('refused: said on the Details screen, the screen stays, and the autosave picks up again', async () => {
  const h = mk({ auto: true }); h.CMD.peDeleteAsk(); h.CMD.askRun('');
  h.calls.writes[0].rej(refusal()); await settle();
  assert.ok(h.text(h.ctx.peDeleteRow()).startsWith('Delete failed: You don’t have permission to do that.'));
  same([h.calls.pops, h.calls.touches, h.ctx.DB.products.length], [0, 1, 4]);
});
it('in Chinese, the desktop’s question', () => {
  const h = mk({ lang: 'zh' }); h.CMD.peDeleteAsk();
  same([h.st.ask.title, h.st.ask.body], ['删除此产品?', '将从店面隐藏。']);
});

section('5 · The desktop is the spec');
it('the same confirms and the same requests', () => {
  assert.ok(PRODUCTS_JS.includes("title: cuT(what + ' — ' + ids.length + ' product(s)?', what + ' — ' + ids.length + ' 件商品?'),"));
  assert.ok(PRODUCTS_JS.includes("confirmLabel: cuT('Apply', '应用'),"));
  assert.ok(PRODUCTS_JS.includes("await api('/api/retail-admin/products/family-publish', { method: 'POST', body: { ids, on: kind === 'shop-on' } });"));
  assert.ok(PRODUCTS_JS.includes("const r = await fetch('/api/retail-admin/products/' + id, { method: 'DELETE' });"));
  assert.ok(PRODUCTS_JS.includes("title: 'Delete this product? · 删除此产品?',"));
  assert.ok(PRODUCTS_JS.includes("body: 'It will be hidden from the shop. · 将从店面隐藏。',"));
  assert.ok(PRODUCTS_JS.includes("cuT('This removes them from the catalogue and frees their SKUs. This cannot be undone.',"));
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
