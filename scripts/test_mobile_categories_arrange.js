#!/usr/bin/env node
/**
 * §325 step PD8 — CATEGORIES, ARRANGED FROM THE PHONE.
 *
 *   node scripts/test_mobile_categories_arrange.js
 *
 * The desktop is the spec: public/retail-admin/01-core.js, the Products →
 * Categories shelf — the tree's save (PUT /category-tree), its add / rename /
 * remove / reorder, the QR menu's own order and hide (PUT
 * /category-tree/qr-order), a shelf's products in their order (POST
 * /products/reorder; the QR menu's product order) and Move to another shelf
 * (PATCH /products/:id). S2c's version check rides every tree save. The phone
 * code is RUN, lifted out of public/m.html by name into a sandbox with a fake
 * server, so every write is asserted on method, path and body, before and
 * after its confirm. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

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

const FNS = ['E', 'pill', 'mCan', 'nothingYet', 'loadCategories', 'catName', 'catMark', 'catRow', 'catIcon',
  'catQrNormalise', 'loadCatQr', 'catQrOrdered', 'catTopsShown', 'catSubsShown', 'catQrIsCustom', 'catQrSave',
  'catSaveErr', 'catTreeWrite', 'catRefreshCounts', 'loadCatProducts', 'catProdUnits', 'catQrOrderUnits',
  'catProdGroups', 'catProdHtml', 'catArrangeRow', 'catModeSwitch', 'catQrStatus', 'catNameAsk', 'screenCategories'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'staleSaveText', 'catCount', 'CAT_ICON', 'catCanEdit', 'catCanArrange',
  'catQrView', 'catQrHidden', 'catErrBar'];
const REGS = ['askRun', 'catTop', 'catMode', 'catMove', 'catQrHide', 'catQrReset', 'catRename', 'catAddTop', 'catAddSub',
  'catRemoveTop', 'catRemoveSub', 'catSubMenu', 'catProdMove', 'catProdShelf'];
const SRC = [...CONSTS.map(liftConst), 'let _catQrSaving=false, _catQrAgain=false;', ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const TREE = () => [
  { id: 'dry', name: 'Dry & Pantry', name_cn: '干货', subs: [{ id: 'nuts', name: 'Nuts', name_cn: '坚果' }, { id: 'jams', name: 'Jams', name_cn: '果酱' }] },
  { id: 'drinks', name: 'Drinks', name_cn: '饮品', subs: [] },
  { id: 'ready', name: 'Ready to Eat', name_cn: '即食', subs: [] },
];
const COUNTS = { dry: { n: 14, published: 11 }, nuts: { n: 3, published: 3 }, jams: { n: 2, published: 2 }, drinks: { n: 3, published: 3 }, ready: { n: 0, published: 0 } };
const PRODS = () => [
  { id: 11, name_en: 'Almonds', subcategory: 'Nuts', top_category: 'Dry & Pantry', is_published: true },
  { id: 12, name_en: 'Cashews', subcategory: 'Nuts', top_category: 'Dry & Pantry', is_published: true },
  { id: 13, name_en: 'Pecans', subcategory: 'Nuts', top_category: 'Dry & Pantry', is_published: false },
  { id: 21, name_en: 'Fig jam', subcategory: 'Jams', top_category: 'Dry & Pantry', is_published: true },
  { id: 31, name_en: 'Rice', subcategory: '', top_category: 'Dry & Pantry', is_published: true },
];

function mk(opts = {}) {
  const calls = { raw: [], reads: [], writes: [], toasts: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD,
    state: Object.assign({ caps: opts.caps === undefined ? ['categories:view', 'categories:edit', 'products:edit'] : opts.caps,
      ask: null, askErr: null, cats: null, catCounts: null, catsErr: null, catsTried: false, catsVersion: null, catTop: null,
      catBannerErr: null, catMode: 'miniapp', catQr: null, catQrTried: false, catErr: null, catBusy: false, catProd: null }, opts.state || {}),
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    catBannerCard: () => '[banner]',
    showToast: (m) => calls.toasts.push(String(m)),
    apiRaw: (p) => { calls.raw.push(p);
      if (p === '/category-tree') return Promise.resolve({ success: true, data: opts.tree ? opts.tree() : TREE(), version: 'v1' });
      if (p === '/category-counts') return Promise.resolve({ success: true, counts: COUNTS });
      return Promise.resolve({}); },
    api: (p) => { calls.reads.push(p);
      if (p === '/category-tree/qr-order') return Promise.resolve(opts.qr || { tops: null, subs: {}, hidden: [], products: {} });
      if (p.startsWith('/category-products')) return Promise.resolve(PRODS());
      if (p === '/shop-listings/product-ids') return Promise.resolve([11, 12, 31]);
      return Promise.resolve({}); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state, screen: () => ctx.screenCategories(),
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; },
    last: () => { const x = calls.writes[calls.writes.length - 1]; return x && { p: x.p, body: x.body, method: x.method }; },
    ok: async (data) => { calls.writes[calls.writes.length - 1].res(Object.assign({ success: true }, data || {})); await settle(); },
    no: async (err) => { calls.writes[calls.writes.length - 1].rej(err); await settle(); } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
async function loaded(opts) { const h = mk(opts); h.screen(); await settle(); return h; }
async function shelf(opts) { const h = await loaded(opts); h.CMD.catTop('dry'); h.screen(); await settle(); return h; }
const names = (tree) => tree.map((t) => t.name);

section('1 · a reader sees the shelves and no control');
it('no Add, no Rename, no Move, no eye — and every command refuses', async () => {
  const h = await shelf({ caps: ['categories:view'] });
  const html = h.screen();
  assert.ok(!/catAddTop|catAddSub|catRename|catRemoveTop|catMove|catQrHide|catSubMenu|catProdMove|catProdShelf/.test(html), 'no control drawn');
  h.CMD.catRename(0, -1); h.CMD.catAddTop(); h.CMD.catMove('top', 0, 1); h.CMD.catRemoveTop(0);
  assert.strictEqual(h.s.ask, null); assert.strictEqual(h.calls.writes.length, 0);
});
it('the retired "on desktop" note is gone for everyone', async () => {
  const h = await loaded({ caps: ['categories:view'] });
  assert.ok(!h.text(h.screen()).includes('on desktop'));
});

section('2 · the tree: every change one whole-tree save, with its version');
it('Rename: the desktop’s card, then PUT {tree, version}; the re-tag is said', async () => {
  const h = await shelf();
  h.CMD.catRename(0, -1);
  const a = h.s.ask;
  assert.strictEqual(a.title, 'Rename');
  same(a.fields.map((f) => [f.label, f.value]), [['Category name — English', 'Dry & Pantry'], ['Category name — Chinese', '干货']]);
  assert.strictEqual(a.body, '14 products re-tag themselves when you save');
  assert.strictEqual(a.validate({ name: ' ', name_cn: 'x' }), 'Give it an English name first');
  a.run({ name: 'Pantry', name_cn: '杂货' }); await settle();
  const w = h.last();
  same([w.p, w.method, w.body.version], ['/category-tree', 'PUT', 'v1']);
  same(names(w.body.tree), ['Pantry', 'Drinks', 'Ready to Eat']);
  assert.strictEqual(w.body.tree[0].name_cn, '杂货');
  assert.strictEqual(w.body.tree[0].id, 'dry', 'the node keeps its id, so the server re-tags rather than orphans');
  const answered = TREE(); answered[0].name = 'Pantry';
  await h.ok({ data: answered, version: 'v2', migrated: 14 });
  same(h.calls.toasts, ['Saved · 14 products re-tagged']);
  assert.strictEqual(h.s.catsVersion, 'v2');
  assert.strictEqual(h.s.cats[0].name, 'Pantry');
  assert.ok(h.calls.raw.filter((p) => p === '/category-counts').length >= 2, 'the counts are read again');
});
it('a tree somebody else changed is refused, said, and read again — not saved over', async () => {
  const h = await shelf();
  h.CMD.catRename(1, -1); h.s.ask.run({ name: 'Beverages', name_cn: '' }); await settle();
  await h.no(Object.assign(new Error('stale_tree'), { code: 'stale_tree' }));
  assert.ok(String(h.s.catErr).includes('Somebody else changed this while you had it open'));
  assert.strictEqual(h.calls.raw.filter((p) => p === '/category-tree').length, 2, 'the tree is read again');
  same(h.calls.toasts, []);
});
it('the server’s own refusal (a duplicate name) is said above the shelf', async () => {
  const h = await loaded();
  h.CMD.catAddTop(); h.s.ask.run({ name: 'Drinks', name_cn: '' }); await settle();
  await h.no(Object.assign(new Error('Duplicate top category "Drinks" · 主分类名称重复'), { code: 'dup_top' }));
  assert.ok(h.text(h.screen()).includes('Save failed: Duplicate top category "Drinks"'));
});
it('Add top category: appended, unsaved id empty, and opened once saved', async () => {
  const h = await loaded();
  assert.ok(h.text(h.screen()).includes('Add top category'));
  h.CMD.catAddTop();
  same(h.s.ask.fields.map((f) => f.label), ['Category name — English', 'Category name — Chinese']);
  h.s.ask.run({ name: 'Frozen', name_cn: '冷冻' }); await settle();
  same(h.last().body.tree[3], { id: '', name: 'Frozen', name_cn: '冷冻', subs: [] });
  const answered = TREE().concat([{ id: 'frozen', name: 'Frozen', name_cn: '冷冻', subs: [] }]);
  await h.ok({ data: answered, version: 'v2' });
  assert.strictEqual(h.s.catTop, 'frozen');
});
it('Remove category asks first, naming its subcategories; the last one cannot go', async () => {
  const h = await loaded();
  h.CMD.catRemoveTop(0);
  assert.strictEqual(h.s.ask.title, 'Remove “Dry &amp; Pantry” and its 2 subcategories?');
  assert.strictEqual(h.s.ask.body, 'Products keep their tag until you re-assign them.');
  assert.strictEqual(h.s.ask.confirmLabel, 'Remove category');
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.askRun(''); await settle();
  same(names(h.last().body.tree), ['Drinks', 'Ready to Eat']);
  const one = await loaded({ tree: () => [TREE()[1]] });
  one.CMD.catRemoveTop(0);
  assert.strictEqual(one.s.ask, null);
  assert.strictEqual(String(one.s.catErr), 'The shop needs at least one category');
});
it('Add subcategory and Rename a subcategory, from the shelf', async () => {
  const h = await shelf();
  h.CMD.catAddSub(0);
  same(h.s.ask.fields.map((f) => f.label), ['Subcategory name — English', 'Subcategory name — Chinese']);
  h.s.ask.run({ name: 'Seeds', name_cn: '籽' }); await settle();
  same(h.last().body.tree[0].subs.map((x) => x.name), ['Nuts', 'Jams', 'Seeds']);
  await h.ok({ data: TREE(), version: 'v2' });
  h.CMD.catSubMenu(0, 1);
  same(h.s.ask.options.map((o) => o.label), ['Rename', 'Remove subcategory']);
  h.CMD.askRun('rename');
  assert.strictEqual(h.s.ask.fields[0].value, 'Jams');
  h.s.ask.run({ name: 'Preserves', name_cn: '' }); await settle();
  same(h.last().body.tree[0].subs.map((x) => x.name), ['Nuts', 'Preserves']);
});
it('Remove a subcategory: asked when products stand under it, at once when none do', async () => {
  const h = await shelf();
  h.CMD.catRemoveSub(0, 0);
  assert.ok(h.s.ask.title.startsWith('Remove “Nuts”? Its 3 products stay in Dry &amp; Pantry, without a heading.'));
  assert.strictEqual(h.s.ask.confirmLabel, 'Remove subcategory');
  h.s.ask = null;
  const h2 = await shelf({ tree: () => { const t = TREE(); t[0].subs.push({ id: 'new1', name: 'Empty' }); return t; } });
  h2.CMD.catRemoveSub(0, 2);
  assert.strictEqual(h2.s.ask, null);
  same(h2.last().body.tree[0].subs.map((x) => x.name), ['Nuts', 'Jams']);
});
it('Move down in the mini app’s view reorders the tree itself', async () => {
  const h = await loaded();
  h.CMD.catMove('top', 0, 1); await settle();
  same(names(h.last().body.tree), ['Drinks', 'Dry & Pantry', 'Ready to Eat']);
  assert.strictEqual(h.last().body.version, 'v1');
  h.CMD.catMove('top', 1, 1);
  assert.strictEqual(h.calls.writes.length, 1, 'one save at a time');
});
it('the first cannot go up and the last cannot go down', async () => {
  const h = await loaded();
  h.CMD.catMove('top', 0, -1); h.CMD.catMove('top', 2, 1);
  assert.strictEqual(h.calls.writes.length, 0);
});

section('3 · the QR menu’s own order and hide (§288)');
it('in the QR menu’s view a move changes only the QR order, sent whole', async () => {
  const h = await loaded();
  h.CMD.catMode('qr'); h.screen();
  assert.ok(h.text(h.screen()).includes('Same order as the mini app'));
  h.CMD.catMove('top', 2, -1);
  same(h.last(), { p: '/category-tree/qr-order', method: 'PUT', body: { tops: ['dry', 'ready', 'drinks'], subs: {}, hidden: [], products: {} } });
  assert.ok(!h.calls.writes.some((w) => w.p === '/category-tree'), 'the tree is not touched');
  assert.ok(h.text(h.screen()).includes('Own order for the QR menu'));
});
it('the eye hides a category on the QR menu only, and says how many are hidden', async () => {
  const h = await loaded(); h.CMD.catMode('qr');
  h.CMD.catQrHide('drinks');
  same(h.last().body.hidden, ['drinks']);
  assert.ok(h.text(h.screen()).includes('1 hidden on the QR menu'));
});
it('Reset to mini app order clears the order and keeps what is hidden', async () => {
  const h = await loaded({ qr: { tops: ['ready', 'dry', 'drinks'], subs: { dry: ['jams', 'nuts'] }, hidden: ['drinks'], products: { nuts: [12, 11] } } });
  h.CMD.catMode('qr');
  same(h.ctx.catTopsShown().map((t) => t.id), ['ready', 'dry', 'drinks']);
  h.CMD.catQrReset();
  same(h.last().body, { tops: null, subs: {}, hidden: ['drinks'], products: {} });
});
it('a reader in the QR view gets no eye and no Reset', async () => {
  const h = await loaded({ caps: ['categories:view'], qr: { tops: ['ready'], subs: {}, hidden: [], products: {} } });
  h.CMD.catMode('qr');
  const html = h.screen();
  assert.ok(!html.includes('catQrHide') && !html.includes('catQrReset'));
});

section('4 · the products on a shelf');
it('read by the shelf’s name, grouped under its headings in order, the no-heading group last', async () => {
  const h = await shelf();
  assert.ok(h.calls.reads.includes('/category-products?top=Dry+%26+Pantry'));
  const all = h.text(h.screen()), t = all.slice(all.indexOf('Products on this shelf'));
  assert.ok(t.indexOf('Nuts') < t.indexOf('Almonds') && t.indexOf('Almonds') < t.indexOf('Jams') && t.indexOf('Fig jam') < t.indexOf('no heading'), t);
  assert.ok(t.includes('Pecans draft'));
});
it('Move down in the mini app: POST /products/reorder with the heading’s ids in their new order', async () => {
  const h = await shelf();
  h.CMD.catProdMove(0, 0, 1);
  same(h.last(), { p: '/products/reorder', method: 'POST', body: { ids: [12, 11, 13] } });
  await h.ok();
  assert.strictEqual(h.calls.reads.filter((p) => p.startsWith('/category-products')).length, 2, 'read again');
});
it('a refused reorder is said, and the list is read again so it cannot drift', async () => {
  const h = await shelf();
  h.CMD.catProdMove(0, 1, -1);
  await h.no(Object.assign(new Error('x'), { refused: true, words: ['You don’t have permission to do that.', '你没有执行此操作的权限。'] }));
  assert.ok(String(h.s.catErr).includes('Reorder failed: You don’t have permission to do that.'));
});
it('in the QR menu’s view: only products on a QR menu, no heading first, and a move is the QR product order', async () => {
  const h = await shelf(); h.CMD.catMode('qr'); h.screen(); await settle();
  assert.ok(h.calls.reads.includes('/shop-listings/product-ids'));
  const t = h.text(h.screen());
  assert.ok(!t.includes('Pecans') && !t.includes('Fig jam'), 'not on a QR menu, not on the QR shelf');
  assert.ok(t.indexOf('Rice') < t.indexOf('Almonds'), 'the no-heading group first');
  h.CMD.catProdMove(1, 0, 1);
  same(h.last(), { p: '/category-tree/qr-order', method: 'PUT', body: { tops: null, subs: {}, hidden: [], products: { nuts: [12, 11] } } });
});
it('Move to another shelf: every place, the current one marked; PATCH {top_category, subcategory}', async () => {
  const h = await shelf();
  h.CMD.catProdShelf(31);
  const labels = h.s.ask.options.map((o) => o.label);
  same(labels, ['Dry &amp; Pantry — no heading ✓', 'Dry &amp; Pantry › Nuts', 'Dry &amp; Pantry › Jams', 'Drinks — no heading', 'Ready to Eat — no heading']);
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.askRun('3');
  same(h.last(), { p: '/products/31', method: 'PATCH', body: { top_category: 'Drinks', subcategory: null } });
  await h.ok();
  same(h.calls.toasts, ['Moved']);
  h.CMD.catProdShelf(11); h.CMD.askRun('2');
  same(h.last().body, { top_category: 'Dry & Pantry', subcategory: 'Jams' });
});
it('without products:edit, a category editor arranges the tree but not the products', async () => {
  const h = await shelf({ caps: ['categories:view', 'categories:edit'] });
  const html = h.screen();
  assert.ok(html.includes('catRename') && !html.includes('catProdMove') && !html.includes('catProdShelf'));
});

section('5 · the desktop’s strings');
it('copied whole', () => {
  for (const [en, zh] of [['Add top category', '新增主分类'], ['Mini app', '小程序'], ['QR menu', '二维码菜单']]) {
    assert.ok(DESK.includes(`${en} · ${zh}`), 'desktop has ' + en);
  }
  for (const [en, zh] of [['Add subcategory', '新增子分类'], ['Remove category', '删除主分类'], ['Remove subcategory', '删除子分类'],
    ['Rename', '重命名'], ['Category name — English', '主分类名称 — 英文'], ['Category name — Chinese', '主分类名称 — 中文'],
    ['Subcategory name — English', '子分类名称 — 英文'], ['Subcategory name — Chinese', '子分类名称 — 中文'], ['Save name', '保存名称'],
    ['Give it an English name first', '请先填写英文名'], ['The shop needs at least one category', '店面至少需要一个主分类'],
    ['Own order for the QR menu', '二维码菜单独立顺序'], ['Reset to mini app order', '重置为小程序顺序'],
    ['Same order as the mini app', '与小程序顺序相同'], ['Hidden on the QR menu', '二维码菜单已隐藏'], ['Products on this shelf', '货架上的产品'],
    ['Nothing stands on this shelf yet.', '该分类下暂无产品。'], ['Could not load the products on this shelf.', '加载该分类的产品失败。'],
    ['Move to another shelf', '移动到其他分类'], ['no heading', '无区块'], ['draft', '未上架'], ['Moved', '已移动'], ['Could not move it', '移动失败'],
    ['Reorder failed: ', '排序失败:'], ['Subcategories — the section headings', '子分类 — 区块标题'],
    ['Add a top category to start arranging the shop.', '新增一个主分类，开始整理店面。']]) {
    assert.ok(CORE_JS.includes(`cuT('${en}', '${zh}')`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`), 'phone uses ' + en);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
