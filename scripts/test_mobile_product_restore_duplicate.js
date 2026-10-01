#!/usr/bin/env node
/**
 * §325 step PD7 — DUPLICATE A PRODUCT, AND RESTORE ONE OF ITS VERSIONS, FROM
 * THE PHONE.
 *
 *   node scripts/test_mobile_product_restore_duplicate.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — pdDoDuplicate
 * (POST /products/:id/duplicate {as_variant: false, label: null}, the copy
 * opened for tweaking, its reminder) and pdRestoreVersion (the confirm, POST
 * /products/:id/restore-version {version_id}, the editor read again). The
 * phone code is RUN, lifted out of public/m.html by name into a sandbox with
 * a fake server, so both writes are asserted on method, path and body, before
 * and after the confirm. No browser — fast shard.
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

const FNS = ['mCan', 'prodCanEdit', 'prodLowThreshold', 'mapProduct', 'loadProdVersions', 'pvWhen', 'sheetVersions',
  'pvCanRestore', 'prodCanDuplicate', 'dupRow'];
const CONSTS = ['PILL', 'MCAN_MONEY_ONLY', 'money', 'cfgGet'];
const REGS = ['askRun', 'pvOpen', 'pvClose', 'pvRestore', 'prodDuplicate'];
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null;', ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const VERS = { success: true, versions: [
  { id: 9, is_baseline: 0, edited_by: 'Mei', created_at: '2026-09-30 02:00:00' },
  { id: 8, is_baseline: 0, edited_by: null, created_at: '2026-09-20 02:00:00' },
  { id: 1, is_baseline: 1, edited_by: 'Ash', created_at: '2026-09-01 02:00:00' }] };

function mk(opts = {}) {
  const calls = { raw: [], writes: [], toasts: [], peOpen: [], openProduct: [], loadPe: [], catalogue: 0, flushes: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD, DB: { products: [{ _id: 7, sku: 'SKU OM-1' }] },
    state: { caps: opts.caps === undefined ? ['products:view', 'products:edit', 'products:create'] : opts.caps,
      catalogMode: opts.catalogMode || 'self', cfg: {}, ask: null, askErr: null, prodBusy: false, prodErr: null,
      prodVer: { pid: null, open: false, rows: null, err: null, seq: 0, busy: null, restoreErr: null }, pe: opts.pe || null },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    tdWhen: (v, kind) => { const d = v instanceof Date ? v.toISOString() : String(v); return kind === 'date' ? d.slice(0, 10) : kind === 'time' ? d.slice(11, 16) : d; },
    _tdL: () => ({}),
    canRoute: () => true,
    loadPe: (pid) => calls.loadPe.push(pid),
    loadCatalogue: () => { calls.catalogue++; return Promise.resolve(); },
    showToast: (m) => calls.toasts.push(String(m)),
    apiRaw: (p) => { calls.raw.push(p); return Promise.resolve(VERS); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    document: { getElementById: () => null },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  CMD.peOpen = (id) => calls.peOpen.push(id);
  CMD.openProduct = (sku) => calls.openProduct.push(sku);
  if (opts.pending) {
    vm.runInContext(`peAuto={ flush(){ __flush(); return new Promise(r=>__release.push(r)); }, stop(){} };`,
      Object.assign(ctx, { __flush: () => calls.flushes++, __release: calls.release = [] }));
  }
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state, v: ctx.state.prodVer,
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
async function listed(opts) { const h = mk(opts); h.CMD.pvOpen(7); await settle(); return h; }

section('1 · Restore: who, and on which rows');
it('Restore on every version but the newest, with the desktop’s line saying what it does', async () => {
  const h = await listed();
  const html = h.ctx.sheetVersions();
  same((html.match(/APP\.cmd\('pvRestore',(\d+)\)/g) || []).map((x) => Number(/(\d+)\)$/.exec(x)[1])), [8, 1]);
  assert.ok(h.text(html).includes('Roll this product back to any saved version. Stock counts are never changed.'));
});
it('without products:edit the list stays read-only, and the command refuses', async () => {
  const h = await listed({ caps: ['products:view'] });
  const html = h.ctx.sheetVersions();
  assert.ok(!html.includes('pvRestore') && !h.text(html).includes('Roll this product back'));
  h.CMD.pvRestore(8);
  assert.strictEqual(h.s.ask, null);
});
it('the newest cannot be restored, even by a stale tap', async () => {
  const h = await listed(); h.CMD.pvRestore(9);
  assert.strictEqual(h.s.ask, null);
});

section('2 · Restore: the confirm, then the write');
it('asks the desktop’s question first and sends nothing before the answer', async () => {
  const h = await listed(); h.CMD.pvRestore(8);
  assert.strictEqual(h.s.ask.title, 'Restore this version?');
  assert.ok(h.s.ask.body.startsWith('The product’s current content (name, price, description, photos, category…) is replaced with this version.'));
  assert.strictEqual(h.s.ask.confirmLabel, 'Restore'); assert.strictEqual(h.s.ask.danger, true);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('Restore: POST {version_id}; the row says Restoring…, then the list closes, Restored, and the catalogue is read again', async () => {
  const h = await listed(); h.CMD.pvRestore(8); h.CMD.askRun(''); await settle();
  same(h.w(0), { p: '/products/7/restore-version', body: { version_id: 8 }, method: 'POST' });
  assert.ok(h.text(h.ctx.sheetVersions()).includes('Restoring…'));
  h.CMD.pvClose(); assert.strictEqual(h.v.open, true, 'not closed under a write in flight');
  h.calls.writes[0].res({ success: true }); await settle();
  assert.strictEqual(h.v.open, false);
  same(h.calls.toasts, ['Restored to the chosen version.']);
  assert.strictEqual(h.calls.catalogue, 1);
});
it('with the Details screen open on this product: its pending edit goes FIRST, then the restore, then it reads the product again', async () => {
  const h = await listed({ pending: true, pe: { pid: 7 } });
  h.CMD.pvRestore(8); h.CMD.askRun(''); await settle();
  assert.strictEqual(h.calls.flushes, 1);
  assert.strictEqual(h.calls.writes.length, 0, 'the restore waits for the pending edit');
  h.calls.release[0](); await settle();
  same(h.w(0).body, { version_id: 8 });
  h.calls.writes[0].res({ success: true }); await settle();
  same(h.calls.loadPe, [7]);
});
it('a refused restore says why in the list, which stays open', async () => {
  const h = await listed(); h.CMD.pvRestore(8); h.CMD.askRun(''); await settle();
  h.calls.writes[0].rej(Object.assign(new Error('x'), { refused: true, words: ['You don’t have permission to do that.', '你没有执行此操作的权限。'] })); await settle();
  assert.ok(h.text(h.ctx.sheetVersions()).includes('Restore failed: You don’t have permission to do that.'));
  assert.strictEqual(h.v.open, true); same(h.calls.toasts, []);
});
it('in Chinese, the desktop’s question', async () => {
  const h = await listed({ lang: 'zh' }); h.CMD.pvRestore(8);
  assert.strictEqual(h.s.ask.title, '还原此版本?');
});

section('3 · Duplicate');
it('products:create gets Duplicate on the sheet; without it, or on an upstream catalogue, none', () => {
  assert.ok(mk().text(mk().ctx.dupRow({ _id: 7 })).includes('Duplicate'));
  assert.strictEqual(mk({ caps: ['products:view', 'products:edit'] }).ctx.dupRow({ _id: 7 }), '');
  assert.strictEqual(mk({ catalogMode: 'upstream' }).ctx.dupRow({ _id: 7 }), '');
  const h = mk({ caps: ['products:view', 'products:edit'] }); h.CMD.prodDuplicate(7);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('no confirm, as on the desktop: POST {as_variant: false, label: null} at once, the row says Duplicating…', () => {
  const h = mk(); h.CMD.prodDuplicate(7);
  same(h.w(0), { p: '/products/7/duplicate', body: { as_variant: false, label: null }, method: 'POST' });
  assert.ok(h.text(h.ctx.dupRow({ _id: 7 })).includes('Duplicating…'));
  h.CMD.prodDuplicate(7); assert.strictEqual(h.calls.writes.length, 1);
});
it('the copy joins the catalogue and opens on its Details, with the desktop’s reminder', async () => {
  const h = mk(); h.CMD.prodDuplicate(7);
  h.calls.writes[0].res({ success: true, data: { id: 31, name_en: 'Oat milk (copy)', sku: 'DRAFT-1', sell_price: 18 } }); await settle();
  assert.strictEqual(h.ctx.DB.products[0]._id, 31);
  same(h.calls.peOpen, [31]);
  same(h.calls.toasts, ['Duplicated — set the new SKU / price / size, then publish.']);
  assert.strictEqual(h.calls.catalogue, 1);
});
it('a creator who may not edit gets the copy’s sheet instead', async () => {
  const h = mk({ caps: ['products:view', 'products:create'] }); h.CMD.prodDuplicate(7);
  h.calls.writes[0].res({ success: true, data: { id: 31, name_en: 'Copy', sku: 'DRAFT-1' } }); await settle();
  same(h.calls.peOpen, []); same(h.calls.openProduct, ['SKU DRAFT-1']);
});
it('a failed duplicate says so on the sheet and opens nothing', async () => {
  const h = mk(); h.CMD.prodDuplicate(7);
  h.calls.writes[0].rej(Object.assign(new Error('catalog_locked'), { code: 'catalog_locked' })); await settle();
  assert.strictEqual(String(h.s.prodErr), 'Duplicate failed: catalog_locked');
  same(h.calls.peOpen, []); same(h.calls.toasts, []);
  assert.strictEqual(h.s.prodBusy, false);
});

section('4 · the desktop’s strings');
it('copied whole', () => {
  for (const [en, zh] of [['Restore this version?', '还原此版本?'], ['Restore', '还原'], ['Restored to the chosen version.', '已还原到所选版本。'],
    ['Restore failed: ', '还原失败:'], ['Roll this product back to any saved version. Stock counts are never changed.', '将此产品还原到任意已保存的版本。库存数量不会被更改。'],
    ['Duplicate failed: ', '复制失败:'], ['Duplicated — set the new SKU / price / size, then publish.', '已复制 — 请设置新货号 / 价格 / 规格后再上架。']]) {
    assert.ok(PRODUCTS_JS.includes(`cuT('${en}', '${zh}')`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`), 'phone uses ' + en);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
