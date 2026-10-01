#!/usr/bin/env node
/**
 * §325 step PD4 — A SHOP MENU'S DAILY EDITS FROM THE PHONE.
 *
 *   node scripts/test_mobile_shop_menu_edits.js
 *
 * The desktop is the spec: public/retail-admin/28-shops.js, its WRITES —
 * shpToggleAvail, shpSaveField, shpRemove, fetchPick / shpAdd and
 * shpAddAllPublished. The phone code is RUN, lifted out of public/m.html by
 * name into a sandbox with a fake server, so every write is asserted on its
 * method, path and every body field, before and after its confirm. No
 * browser — fast shard.
 *
 * What it pins:
 *   1. without stores:edit the menu stays PD2's read-only screen, and every
 *      command refuses;
 *   2. Available: optimistic, the server's row, put back and said when refused;
 *   3. price and kind: one PATCH per changed field, nothing sent for nothing
 *      changed or for a price that is not a number of 0 or more;
 *   4. Remove asks first (the desktop does not), then DELETE;
 *   5. Add product: the candidate search, the last answer winning, the add;
 *      Add all: the desktop's confirm, the POST, the count re-asked;
 *   6. Back closes the sheets first, but not under a write in flight;
 *   7. the desktop's own strings.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const SHOPS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/28-shops.js'), 'utf8');

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

const FNS = ['E', 'pill', 'toggle', 'mCan', 'searchBox', 'searchClearShow', 'searchClearRun',
  'shmName', 'shmLocName', 'loadShopMenu', 'shmErrBox', 'screenShopMenu', 'shmProdName', 'shmShown', 'shmListHtml',
  'shmWriteErr', 'shmRepaint', 'sheetShmEdit', 'shmPickListHtml', 'sheetShmPick', 'shmPickRepaint', 'shmFetchPick',
  'layers', 'prodRecordsDrop'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'money', 'shmLoading', 'shmCanEdit', 'shmRow'];
const REGS = ['askRun', 'shmAvail', 'shmEdit', 'shmEditClose', 'shmEditPrice', 'shmEditMode', 'shmEditSave', 'shmRemove',
  'shmPickOpen', 'shmPickClose', 'shmPickQ', 'shmAdd', 'shmAddAll'];
const ctaAt = M.indexOf('SUBS.shopmenu.cta=');
const CTA = M.slice(ctaAt, M.indexOf("\n/* Available", ctaAt));
const SRC = [...CONSTS.map(liftConst), 'let _shmPickTimer=null;', ...FNS.map(liftFn), CTA, ...REGS.map(liftReg)].join('\n');

const ROWS = () => [
  { id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', variant_label: '1L', price: 18, fulfilment_mode: 'stocked', is_available: 1 },
  { id: 12, name_en: 'Latte', name_cn: '拿铁', sku: 'LT-1', price: 28.5, fulfilment_mode: 'made_here', is_available: 0 },
];
const CANDS = () => [
  { id: 21, name_en: 'Rye loaf', name_cn: '黑麦面包', sku: 'RY-1', sell_price: 32, is_published: 1 },
  { id: 22, name_en: 'Jam', name_cn: '果酱', sku: 'JM-1', sell_price: 25, is_published: 1 },
  { id: 23, name_en: 'Draft', name_cn: '草稿', sku: 'DR-1', sell_price: 9, is_published: 0 },
];
const ALL = ['dashboard:view', 'stores:view', 'stores:edit'];

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], renders: 0, timers: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: { shopmenu: {} },
    state: {
      caps: opts.caps === undefined ? ALL : opts.caps, ask: null, askErr: null,
      shm: { list: null, err: null, tried: true, seq: 0, id: 3, oneFor: 3, shop: { id: 3, public_code: 'K7Q2', is_active: 0 },
             rows: ROWS(), oneErr: null, oneSeq: 0, qr: null, q: '', busy: {}, writeErr: null, edit: null, pick: null },
      stack: [], pinv: {}, fin: {}, kq: {}, prodVer: { open: false }, prodSales: { pid: null, seq: 0 },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => new Promise((res, rej) => { calls.reads.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    setTimeout: (fn) => { calls.timers.push(fn); return calls.timers.length; },
    clearTimeout: () => {},
    document: { getElementById: (id) => els[id] || null },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state.shm,
    w: (i) => { const x = h0(calls.writes[i]); return x; } };
  function h0(x) { return x && { p: x.p, body: x.body, method: x.method }; }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const refusal = (words) => Object.assign(new Error(words[0]), { refused: true, status: 403, words, code: 'forbidden' });
const REFUSED = ['You don’t have permission to do that.', '你没有执行此操作的权限。'];

section('1 · without stores:edit, the menu is read-only');
it('no switch, no row sheet, no Add product, and every command refuses', async () => {
  const h = mk({ caps: ['dashboard:view', 'stores:view'] });
  const html = h.ctx.shmListHtml();
  assert.ok(!/shmAvail|shmEdit|<button/.test(html), 'no control on a row');
  assert.ok(h.text(html).includes('Available') && h.text(html).includes('Sold out'), 'the state still reads');
  assert.strictEqual(h.ctx.SUBS.shopmenu.cta(), '');
  h.CMD.shmAvail(11); h.CMD.shmEdit(11); h.CMD.shmRemove(11); h.CMD.shmPickOpen();
  assert.strictEqual(h.calls.writes.length + h.calls.reads.length, 0);
  assert.strictEqual(h.s.edit, null); assert.strictEqual(h.s.pick, null); assert.strictEqual(h.ctx.state.ask, null);
});
it('with stores:edit: a switch per row, the row opens its sheet, and + Add product in the head', () => {
  const h = mk();
  const html = h.ctx.shmListHtml();
  assert.ok(html.includes("APP.cmd('shmAvail',11)") && html.includes("APP.cmd('shmEdit',12)"));
  assert.ok(h.text(h.ctx.SUBS.shopmenu.cta()).includes('+ Add product'));
});

section('2 · Available, the row’s switch');
it('flips at once, sends {is_available: 0}, and takes the server’s row', async () => {
  const h = mk();
  h.CMD.shmAvail(11);
  assert.strictEqual(h.s.rows[0].is_available, 0, 'optimistic');
  same(h.w(0), { p: '/shops/3/listings/11', body: { is_available: 0 }, method: 'PATCH' });
  assert.ok(h.ctx.shmListHtml().includes('…'), 'busy while it writes');
  h.CMD.shmAvail(11);
  assert.strictEqual(h.calls.writes.length, 1, 'no second write on a busy row');
  h.calls.writes[0].res({ success: true, data: Object.assign(ROWS()[0], { is_available: 0, updated_at: 'x' }) }); await settle();
  assert.strictEqual(h.s.rows[0].updated_at, 'x');
  assert.ok(!h.s.busy[11]);
});
it('turning one back on sends {is_available: 1}', () => {
  const h = mk(); h.CMD.shmAvail(12);
  same(h.w(0).body, { is_available: 1 });
});
it('a refusal puts the switch back and says why above the list, and it stays', async () => {
  const h = mk();
  h.CMD.shmAvail(11);
  h.calls.writes[0].rej(refusal(REFUSED)); await settle();
  assert.strictEqual(h.s.rows[0].is_available, 1);
  assert.ok(h.text(h.ctx.shmListHtml()).includes(REFUSED[0]));
  same(h.calls.toasts, []);
});

section('3 · price and kind');
it('the sheet opens on the row’s price and kind', () => {
  const h = mk(); h.CMD.shmEdit(11);
  same({ id: h.s.edit.id, price: h.s.edit.price, mode: h.s.edit.mode }, { id: 11, price: '18.00', mode: 'stocked' });
  const t = h.text(h.ctx.sheetShmEdit());
  assert.ok(t.includes('Oat milk') && t.includes('Price') && t.includes('Kind') && t.includes('Stocked') && t.includes('Made here') && t.includes('Remove') && t.includes('Save'));
});
it('a new price: one PATCH {price}, as typed, then Saved and the sheet closes', async () => {
  const h = mk(); h.CMD.shmEdit(11);
  const r0 = h.calls.renders; h.CMD.shmEditPrice('19.5');
  assert.strictEqual(h.calls.renders, r0, 'typing does not repaint');
  h.CMD.shmEditSave();
  assert.strictEqual(h.calls.writes.length, 1);
  same(h.w(0), { p: '/shops/3/listings/11', body: { price: '19.5' }, method: 'PATCH' });
  assert.ok(h.text(h.ctx.sheetShmEdit()).includes('Saving…'));
  h.calls.writes[0].res({ success: true, data: Object.assign(ROWS()[0], { price: 19.5 }) }); await settle();
  assert.strictEqual(h.s.edit, null); same(h.calls.toasts, ['Saved']); assert.strictEqual(h.s.rows[0].price, 19.5);
});
it('a new kind: one PATCH {fulfilment_mode}', async () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmEditMode('made_here'); h.CMD.shmEditSave();
  same(h.w(0), { p: '/shops/3/listings/11', body: { fulfilment_mode: 'made_here' }, method: 'PATCH' });
});
it('both: two PATCHes, price first, the second only after the first lands', async () => {
  const h = mk(); h.CMD.shmEdit(12); h.CMD.shmEditPrice('30'); h.CMD.shmEditMode('stocked'); h.CMD.shmEditSave();
  await settle();
  assert.strictEqual(h.calls.writes.length, 1);
  h.calls.writes[0].res({ success: true, data: Object.assign(ROWS()[1], { price: 30 }) }); await settle();
  same(h.w(1), { p: '/shops/3/listings/12', body: { fulfilment_mode: 'stocked' }, method: 'PATCH' });
});
it('nothing changed: nothing sent, and the sheet closes', () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmEditPrice('18'); h.CMD.shmEditSave();
  assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.s.edit, null);
});
it('a price that is not a number of 0 or more is refused before anything is sent', () => {
  for (const v of ['', 'abc', '-1']) {
    const h = mk(); h.CMD.shmEdit(11); h.CMD.shmEditPrice(v); h.CMD.shmEditSave();
    assert.strictEqual(h.calls.writes.length, 0, v);
    assert.ok(h.text(h.ctx.sheetShmEdit()).includes('Enter a price — a number, 0 or more.'), v);
  }
});
it('the server’s bad_price says the same, and the sheet stays open', async () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmEditPrice('1e9'); h.CMD.shmEditSave();
  h.calls.writes[0].rej(Object.assign(new Error('bad_price'), { code: 'bad_price' })); await settle();
  assert.ok(h.s.edit && h.text(h.ctx.sheetShmEdit()).includes('Enter a price — a number, 0 or more.'));
  same(h.calls.toasts, []);
});

section('4 · Remove asks first');
it('asks, naming the product, and sends nothing before the answer', () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmRemove(11);
  const a = h.ctx.state.ask;
  assert.strictEqual(a.title, 'Remove from this menu?');
  assert.ok(h.text(a.body).includes('Oat milk'));
  assert.strictEqual(a.confirmLabel, 'Remove'); assert.strictEqual(a.danger, true);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Remove: DELETE the listing; the row goes, the sheet closes, Removed', async () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmRemove(11); h.CMD.askRun('');
  same(h.w(0), { p: '/shops/3/listings/11', body: {}, method: 'DELETE' });
  assert.ok(h.text(h.ctx.sheetShmEdit()).includes('Removing…'));
  h.calls.writes[0].res({ success: true, data: { removed: 11 } }); await settle();
  same(h.s.rows.map((r) => r.id), [12]); assert.strictEqual(h.s.edit, null); same(h.calls.toasts, ['Removed']);
});
it('a refused remove stays in the sheet and keeps the row', async () => {
  const h = mk(); h.CMD.shmEdit(11); h.CMD.shmRemove(11); h.CMD.askRun('');
  h.calls.writes[0].rej(refusal(REFUSED)); await settle();
  assert.strictEqual(h.s.rows.length, 2);
  assert.ok(h.text(h.ctx.sheetShmEdit()).includes(REFUSED[0]));
});

section('5 · Add product, and Add all');
async function picker(h) {
  h.CMD.shmPickOpen();
  assert.strictEqual(h.calls.reads[0].p, '/shops/3/candidates?q=');
  h.calls.reads[0].res(CANDS()); await settle();
}
it('opens on every candidate, with Add all counting the Online store ones', async () => {
  const h = mk(); await picker(h);
  const t = h.text(h.ctx.sheetShmPick());
  assert.ok(t.includes('Rye loaf') && t.includes('Jam') && t.includes('Draft'));
  assert.ok(t.includes('+ Add all 2 Online store products'), t);
  assert.ok(h.ctx.sheetShmPick().includes('placeholder="Search a product to add…"'));
});
it('typing waits for a pause, then searches; the last search asked wins', async () => {
  const h = mk(); await picker(h);
  h.CMD.shmPickQ('ry'); h.CMD.shmPickQ('rye');
  assert.strictEqual(h.calls.reads.length, 1, 'nothing until the pause');
  h.calls.timers[0](); h.calls.timers[1]();
  same(h.calls.reads.slice(1).map((r) => r.p), ['/shops/3/candidates?q=rye', '/shops/3/candidates?q=rye']);
  h.calls.reads[2].res([CANDS()[0]]); await settle();
  h.calls.reads[1].res(CANDS()); await settle();
  const t = h.text(h.ctx.shmPickListHtml());
  assert.ok(t.includes('Rye loaf') && !t.includes('Jam'), 'the older answer is thrown away');
  assert.ok(t.includes('+ Add all 2'), 'the count stays from the unfiltered answer while a search narrows');
});
it('+ Add product: POST {store_product_id}; the row joins the menu and leaves the picker', async () => {
  const h = mk(); await picker(h);
  h.CMD.shmAdd(21);
  same(h.w(0), { p: '/shops/3/listings', body: { store_product_id: 21 }, method: 'POST' });
  assert.ok(h.text(h.ctx.shmPickListHtml()).includes('Adding…'));
  h.calls.writes[0].res({ success: true, data: { id: 31, name_en: 'Rye loaf', price: 32, fulfilment_mode: 'stocked', is_available: 1 } }); await settle();
  same(h.s.rows.map((r) => r.id), [11, 12, 31]);
  assert.ok(!h.text(h.ctx.shmPickListHtml()).includes('Rye loaf'));
  assert.ok(h.s.pick, 'the picker stays open for the next one');
});
it('a refused add says so in the picker', async () => {
  const h = mk(); await picker(h);
  h.CMD.shmAdd(21);
  h.calls.writes[0].rej(refusal(REFUSED)); await settle();
  assert.ok(h.text(h.ctx.sheetShmPick()).includes(REFUSED[0]));
  assert.strictEqual(h.s.rows.length, 2);
});
it('Add all asks the desktop’s question first, then POSTs add-published and re-asks the count', async () => {
  const h = mk(); await picker(h);
  h.CMD.shmAddAll();
  const a = h.ctx.state.ask;
  assert.strictEqual(a.title, 'Add 2 products to this menu?');
  assert.ok(a.body.startsWith('Every Online store product not on this menu is added at its catalogue price, as Stocked.'));
  assert.strictEqual(a.confirmLabel, 'Add');
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.askRun('');
  same(h.w(0), { p: '/shops/3/listings/add-published', body: {}, method: 'POST' });
  h.calls.writes[0].res({ success: true, data: { added: 2, listings: ROWS().concat([{ id: 41 }, { id: 42 }]) } }); await settle();
  assert.strictEqual(h.s.rows.length, 4);
  same(h.calls.toasts, ['Saved']);
  assert.strictEqual(h.calls.reads[h.calls.reads.length - 1].p, '/shops/3/candidates?q=', 'the count is re-asked of the server');
});
it('in Chinese, the desktop’s question', async () => {
  const h = mk({ lang: 'zh' }); await picker(h);
  h.CMD.shmAddAll();
  assert.strictEqual(h.ctx.state.ask.title, '添加 2 个商品到此菜单？');
});
it('a failed candidate read says Load failed', async () => {
  const h = mk(); h.CMD.shmPickOpen();
  h.calls.reads[0].rej(new Error('HTTP 500')); await settle();
  assert.ok(h.text(h.ctx.sheetShmPick()).includes('Load failed'));
});

section('6 · Back');
it('closes the row sheet and the picker first, but not under a write in flight', () => {
  const h = mk({});
  h.CMD.shmEdit(11);
  let L = h.ctx.layers(); L[L.length - 1](); assert.strictEqual(h.s.edit, null);
  h.CMD.shmEdit(11); h.s.edit.busy = 'save';
  L = h.ctx.layers(); L[L.length - 1](); assert.ok(h.s.edit, 'kept while saving');
  h.s.edit = null; h.CMD.shmPickOpen();
  L = h.ctx.layers(); L[L.length - 1](); assert.strictEqual(h.s.pick, null);
});

section('7 · the desktop’s strings');
it('copied whole from 28-shops.js', () => {
  for (const [en, zh] of [['Price', '价格'], ['Kind', '类型'], ['Stocked', '备货'], ['Made here', '现做'], ['Remove', '移除'],
    ['+ Add product', '+ 添加商品'], ['Adding…', '添加中…'], ['Search a product to add…', '搜索商品以添加…'], ['Cancel', '取消'],
    ['Saved', '已保存'], ['Add', '添加']]) {
    assert.ok(SHOPS_JS.includes(`T('${en}', '${zh}')`) || SHOPS_JS.includes(`'${en}', '${zh}'`) || SHOPS_JS.includes(`confirmEn: '${en}', confirmCn: '${zh}'`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`), 'phone uses ' + en);
  }
  assert.ok(SHOPS_JS.includes('Every Online store product not on this menu is added at its catalogue price, as Stocked.'));
  assert.ok(M.includes('Every Online store product not on this menu is added at its catalogue price, as Stocked.'));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
