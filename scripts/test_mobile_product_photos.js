#!/usr/bin/env node
/**
 * §325 step PD6 — A PRODUCT'S PHOTOS, ON THE PHONE'S DETAILS SCREEN.
 *
 *   node scripts/test_mobile_product_photos.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — the gallery
 * (pdRenderGallery, pdRemovePhoto, the drag reorder), Add (pdAddPhotos through
 * pdResizeImage with PD_IMG_OPTS), From library (pdOpenLibraryPicker /
 * pdLibFetch / pdLibAddSelected), and the save rule: `images` is sent only
 * once the gallery was loaded and then changed (_pdGalleryDirty), because the
 * server replaces the whole gallery with it. The phone code is RUN, lifted out
 * of public/m.html by name into a sandbox with a fake server and the REAL
 * autosave engine; the picture shrinking itself (a canvas) is stood in for.
 * No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

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

const FNS = ['E', 'pill', 'mCan', 'canRoute', 'prodCanEdit', 'pcMoney', 'prodLowThreshold', 'nothingYet', 'footBar',
  'searchBox', 'searchClearShow',
  'peBadgeOf', 'peRteClean', 'peDraftFrom', 'peBody', 'peDiff', 'peSkuTaken', 'peErrText', 'peApplyToCatalogue',
  'peCostOn', 'peAutoStart', 'loadPe', 'peFootHtml', 'peSubcats', 'screenProductEdit', 'pePopped', 'prodRecordsDrop',
  'peFmtBytes', 'loadPeImages', 'peGalleryChanged', 'pePhotosCard', 'peLibGridHtml', 'sheetPeLib', 'peLibCountText',
  'peLibRepaint', 'peLibFetch'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'cfgGet', 'PE_FACTS', 'PE_FREE_OF',
  'PE_FREE_ALIAS', 'PE_BADGES', 'pePlainToHtml', 'peRichForEdit', 'PE_MAX_PHOTOS', 'PE_IMG', 'PE_LIB_PAGE'];
const REGS = ['peOpen', 'peField', 'peUndo', 'pePhotoZoom', 'pePhotosRetry', 'pePhotoMove', 'pePhotoRemove',
  'pePhotoFiles', 'peLibOpen', 'peLibClose', 'peLibQ', 'peLibMore', 'peLibToggle', 'peLibAdd'];
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null; let _peLibTimer=null;', ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const ROW = () => ({ id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', sell_price: 18, unit_cost: 6.5, ship_modes: 'air,land',
  product_facts: {}, description_format: 'rich', description_en: '', description_cn: '' });
const IMGS = (o) => Object.assign({ success: true, images: ['data:a', 'data:b', 'data:c'], inherited: false }, o || {});
const LIB = (n, total) => ({ success: true, data: { rows: Array.from({ length: n }, (_, i) => ({ id: 100 + i, filename: 'f' + i })), total: total == null ? n : total } });

function mk(opts = {}) {
  const calls = { reads: [], raw: [], writes: [], toasts: [], fetches: [], zoom: [], timers: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, CMD,
    DB: { products: [{ _id: 7, sku: 'SKU OM-1', name: ['Oat milk', '燕麦奶'], img: 'data:a', stock: 9 }] },
    state: { caps: opts.caps === undefined ? ['products:view', 'products:edit'] : opts.caps, pos: 'owner', catalogMode: 'self',
      cfg: {}, stack: [], productSku: 'SKU OM-1', oosSku: null, prodBusy: false, cats: null,
      prodVer: { open: false }, prodSales: { pid: null, seq: 0 }, pe: null },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    // The sizes card (§325 PD9) has its own suite, test_mobile_product_sizes.js.
    loadPeSizes: () => {}, peSizesCard: () => '',
    push: (route) => { ctx.state.stack.push({ route }); },
    loadCategories: () => {}, recapNoMoney: () => false, featOn: () => true, navTabs: () => [],
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => { calls.reads.push(p);
      if (p === '/products/7') return Promise.resolve(ROW());
      if (p.startsWith('/media/list')) { const v = opts.lib ? opts.lib(p) : LIB(3); return v instanceof Error ? Promise.reject(v) : Promise.resolve(v.data); }
      return Promise.resolve({}); },
    apiRaw: (p) => { calls.raw.push(p); const v = opts.images === undefined ? IMGS() : opts.images;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    TacetAutosave: { create: (o) => ENGINE.create(Object.assign({}, o, { delay: 0 })) },
    peShrinkPhoto: async (f) => { if (f.bad) throw new Error('decode failed');
      return { dataURL: 'data:shrunk-' + f.name, resized: f.size > 200 * 1024, orig: f.size, final: 300 * 1024 }; },
    fetch: async (u) => { calls.fetches.push(u); return { ok: !opts.fetchFails, status: opts.fetchFails ? 500 : 200, blob: async () => ({ type: 'image/png' }) }; },
    File: class { constructor(parts, name, o) { this.name = name; this.type = o.type; this.size = 1000; } },
    setTimeout: (fn) => { calls.timers.push(fn); return calls.timers.length; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  CMD.zoomImg = (src) => calls.zoom.push(src);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state,
    e: () => ctx.state.pe,
    flush: () => vm.runInContext('peAuto && peAuto.flush()', ctx),
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
async function opened(opts) { const h = mk(opts); h.CMD.peOpen(7); await settle(); return h; }
const file = (name, size, bad) => ({ name, size, type: 'image/jpeg', bad });

section('1 · the gallery as read');
it('opening reads the gallery, and shows it in order with the first as Main', async () => {
  const h = await opened();
  assert.ok(h.calls.raw.includes('/products/7/images'));
  const html = h.ctx.pePhotosCard(), t = h.text(html);
  assert.ok(t.includes('Photos') && t.includes('Main') && t.includes('Add') && t.includes('From library') && t.includes('Up to 8'));
  assert.ok(html.indexOf("url('data:a')") < html.indexOf("url('data:b')"));
  assert.strictEqual((html.match(/APP\.cmd\('pePhotoRemove',/g) || []).length, 3);
});
it('a size showing a sibling’s photos says so', async () => {
  const h = await opened({ images: IMGS({ inherited: true, images: ['data:x'] }) });
  assert.ok(h.text(h.ctx.pePhotosCard()).includes('Shared from another variant'));
});
it('no photos yet says so', async () => {
  const h = await opened({ images: IMGS({ images: [] }) });
  assert.ok(h.text(h.ctx.pePhotosCard()).includes('No photos yet'));
});
it('a gallery that did not load: said, Try again, no control — and never sent', async () => {
  const h = await opened({ images: new Error('HTTP 500') });
  const html = h.ctx.pePhotosCard();
  assert.ok(h.text(html).includes('Load failed') && h.text(html).includes('Try again'));
  assert.ok(!/pePhotoRemove|pePhotoFiles|peLibOpen/.test(html));
  h.CMD.pePhotoRemove(0); h.CMD.peLibOpen();
  h.CMD.peField('name_en', 'Renamed'); h.flush();
  same(h.w(0).body, { name_en: 'Renamed' });
});
it('an untouched gallery is not sent with another edit', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Renamed'); h.flush();
  assert.ok(!('images' in h.w(0).body));
});
it('tapping a photo opens it big', async () => {
  const h = await opened(); h.CMD.pePhotoZoom(1);
  same(h.calls.zoom, ['data:b']);
});

section('2 · remove and reorder: the whole list, in its new order');
it('Remove sends the list without it', async () => {
  const h = await opened(); h.CMD.pePhotoRemove(0); h.flush();
  same(h.w(0), { p: '/products/7', body: { images: ['data:b', 'data:c'] }, method: 'PATCH' });
});
it('Move down and Move up reorder; the first cannot go up, the last cannot go down', async () => {
  const h = await opened();
  h.CMD.pePhotoMove(0, 1); same(h.e().gallery, ['data:b', 'data:a', 'data:c']);
  h.CMD.pePhotoMove(2, -1); same(h.e().gallery, ['data:b', 'data:c', 'data:a']);
  h.CMD.pePhotoMove(0, -1); h.CMD.pePhotoMove(2, 1); same(h.e().gallery, ['data:b', 'data:c', 'data:a']);
  h.flush();
  same(h.w(0).body, { images: ['data:b', 'data:c', 'data:a'] });
});
it('removing every photo sends the empty list — the server clears the main photo with it', async () => {
  const h = await opened(); h.CMD.pePhotoRemove(0); h.CMD.pePhotoRemove(0); h.CMD.pePhotoRemove(0); h.flush();
  same(h.w(0).body, { images: [] });
});
it('the next edit does not send the same list again', async () => {
  const h = await opened(); h.CMD.pePhotoRemove(2); h.flush();
  h.calls.writes[0].res({ success: true, data: { name_en: 'Oat milk', image_data: 'data:a' } }); await settle();
  h.CMD.peField('name_en', 'Renamed'); h.flush();
  same(h.w(1).body, { name_en: 'Renamed' });
});

section('3 · Add, shrunk first');
it('two pictures: each shrunk, added after the others, sent as the whole list; a shrink is said', async () => {
  const h = await opened();
  h.CMD.pePhotoFiles({ files: [file('p1.jpg', 3 * 1024 * 1024), file('p2.jpg', 100 * 1024)], value: 'x' }); await settle();
  same(h.e().gallery, ['data:a', 'data:b', 'data:c', 'data:shrunk-p1.jpg', 'data:shrunk-p2.jpg']);
  h.flush();
  same(h.w(0).body, { images: ['data:a', 'data:b', 'data:c', 'data:shrunk-p1.jpg', 'data:shrunk-p2.jpg'] });
  same(h.calls.toasts, ['Optimized 3.0 MB → 300 KB']);
});
it('only as many as there is room for', async () => {
  const h = await opened({ images: IMGS({ images: ['1', '2', '3', '4', '5', '6', '7'] }) });
  h.CMD.pePhotoFiles({ files: [file('a', 1), file('b', 1)] }); await settle();
  assert.strictEqual(h.e().gallery.length, 8);
});
it('a full gallery says Up to 8 photos and takes none', async () => {
  const h = await opened({ images: IMGS({ images: ['1', '2', '3', '4', '5', '6', '7', '8'] }) });
  h.CMD.pePhotoFiles({ files: [file('a', 1)] }); await settle();
  assert.strictEqual(h.e().gallery.length, 8);
  assert.ok(h.text(h.ctx.pePhotosCard()).includes('Up to 8 photos'));
});
it('one too huge and one unreadable: each said on the card; the good one still goes in', async () => {
  const h = await opened();
  h.CMD.pePhotoFiles({ files: [file('huge', 26 * 1024 * 1024), file('ok', 1)] }); await settle();
  same(h.e().gallery.slice(3), ['data:shrunk-ok']);
  assert.ok(h.text(h.ctx.pePhotosCard()).includes('Image too huge (max 25MB)'));
  const h2 = await opened();
  h2.CMD.pePhotoFiles({ files: [file('bad', 1, true)] }); await settle();
  assert.ok(h2.text(h2.ctx.pePhotosCard()).includes('Failed to process image'));
  assert.strictEqual(h2.e().gallery.length, 3);
});

section('4 · From library');
it('lists the media library’s pictures, sixty at a time', async () => {
  const h = await opened(); h.CMD.peLibOpen(); await settle();
  assert.strictEqual(h.calls.reads[h.calls.reads.length - 1], '/media/list?mime=image&limit=60&offset=0');
  const t = h.text(h.ctx.sheetPeLib());
  assert.ok(t.includes('Choose from library') && t.includes('Add selected'));
  assert.ok(h.ctx.sheetPeLib().includes('src="/api/retail/media/100"'));
});
it('a search waits for a pause and asks with q; Load more asks for the next page', async () => {
  const h = await opened({ lib: (p) => LIB(60, 130) }); h.CMD.peLibOpen(); await settle();
  h.CMD.peLibQ('jam'); h.calls.timers[h.calls.timers.length - 1](); await settle();
  assert.strictEqual(h.calls.reads[h.calls.reads.length - 1], '/media/list?mime=image&limit=60&offset=0&q=jam');
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('Load more'));
  h.CMD.peLibMore(); await settle();
  assert.strictEqual(h.calls.reads[h.calls.reads.length - 1], '/media/list?mime=image&limit=60&offset=60&q=jam');
});
it('no more picks than the gallery has room for, said in the sheet', async () => {
  const h = await opened({ images: IMGS({ images: ['1', '2', '3', '4', '5', '6', '7'] }) });
  h.CMD.peLibOpen(); await settle();
  h.CMD.peLibToggle(100); h.CMD.peLibToggle(101);
  same(h.e().lib.sel, [100]);
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('Up to 8 photos'));
  same(h.calls.toasts, []);
});
it('Add selected fetches each, shrinks it like an upload, adds it, and sends the list', async () => {
  const h = await opened(); h.CMD.peLibOpen(); await settle();
  h.CMD.peLibToggle(100); h.CMD.peLibToggle(102);
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('2 selected'));
  h.CMD.peLibAdd(); await settle();
  same(h.calls.fetches, ['/api/retail/media/100', '/api/retail/media/102']);
  same(h.e().gallery.slice(3), ['data:shrunk-library-100.jpg', 'data:shrunk-library-102.jpg']);
  assert.strictEqual(h.e().lib, null);
  same(h.calls.toasts, ['Added 2']);
  h.flush();
  same(h.w(0).body.images.length, 5);
});
it('an empty library and a search that finds nothing are two sentences', async () => {
  const h = await opened({ lib: () => LIB(0) }); h.CMD.peLibOpen(); await settle();
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('Your media library is empty'));
  h.CMD.peLibQ('zzz'); h.calls.timers[h.calls.timers.length - 1](); await settle();
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('No photos match your search'));
});
it('a failed library read says Load failed in the sheet', async () => {
  const h = await opened({ lib: () => new Error('HTTP 500') }); h.CMD.peLibOpen(); await settle();
  assert.ok(h.text(h.ctx.sheetPeLib()).includes('Load failed'));
});
it('nothing could be fetched: said on the card, nothing sent', async () => {
  const h = await opened({ fetchFails: true }); h.CMD.peLibOpen(); await settle();
  h.CMD.peLibToggle(100); h.CMD.peLibAdd(); await settle();
  assert.ok(h.text(h.ctx.pePhotosCard()).includes('Failed to process image'));
  assert.strictEqual(h.e().galDirty, false);
});

section('5 · Undo, and what the rest of the phone sees');
it('Undo puts the gallery back as it was loaded, and sends that', async () => {
  const h = await opened(); h.CMD.pePhotoRemove(0); h.flush();
  h.calls.writes[0].res({ success: true, data: {} }); await settle();
  h.CMD.peUndo();
  same(h.e().gallery, ['data:a', 'data:b', 'data:c']);
  same(h.w(1).body, { images: ['data:a', 'data:b', 'data:c'] });
});
it('the catalogue card takes the new main photo', async () => {
  const h = await opened(); h.CMD.pePhotoMove(0, 1); h.flush();
  h.calls.writes[0].res({ success: true, data: { name_en: 'Oat milk', image_data: 'data:b' } }); await settle();
  assert.strictEqual(h.ctx.DB.products[0].img, 'data:b');
});

section('6 · the desktop’s strings');
it('copied whole', () => {
  for (const [en, zh] of [['Photos', '图片'], ['Add', '添加'], ['From library', '从图库选择'], ['Up to 8', '最多 8 张'], ['Main', '主图']]) {
    assert.ok(DESK.includes(`${en} · ${zh}`) || PRODUCTS_JS.includes(`${en} · ${zh}`), 'desktop has ' + en);
  }
  for (const [en, zh] of [['No photos yet', '暂无图片'], ['Up to 8 photos', '最多 8 张图片'], ['Choose from library', '从图库选择'],
    ['Search photos…', '搜索图片…'], ['Load more', '加载更多'], ['Add selected', '添加所选'], ['No photos match your search', '没有匹配的图片'],
    ['Your media library is empty — upload photos in Content → Media', '图库为空 — 请在「内容 → 媒体」中上传图片'],
    ['Failed to process image', '图片处理失败'], ['Optimized', '已优化'],
    ['Shared from another variant — add a photo here to give this variant its own.', '与其他规格共用图片 — 在此添加图片可为本规格单独设置。']]) {
    assert.ok(PRODUCTS_JS.includes(`'${en}', '${zh}'`) || PRODUCTS_JS.includes(`${en} · ${zh}`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`), 'phone uses ' + en);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
