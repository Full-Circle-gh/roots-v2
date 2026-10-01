#!/usr/bin/env node
/**
 * §325 X8d — MEITUAN BUNDLES ON THE PHONE.
 *
 *   node scripts/test_mobile_meituan_bundles.js
 *
 * The desktop Meituan page's Bundles tab (11-meituan.js mtRenderBundles,
 * mtEditBundle, mtBundleNameCommit, mtSaveBundle, mtDeleteBundle,
 * mtComboCandidates).
 *
 * What is asserted: the list says what the desktop's says; Save's body, key
 * for key against the desktop's (sliced from 11-meituan.js), with the switch
 * carried through and a blank cap sent as null; only a listed name, or the
 * title the bundle already holds, can be the title; the server's refusal is
 * said under the field; Delete asks first and sends DELETE; Suggest finds the
 * combo-looking titles that are not bundles yet; every button is meituan:sync
 * and nothing is sent without it; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const MT = fs.readFileSync(path.join(ROOT, 'public/retail-admin/11-meituan.js'), 'utf8');
const cap = require('../lib/cap-routes.js');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function searchBox('),
  line(M, 'function searchClearShow('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x1Paint('),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X8d — MEITUAN BUNDLES', '/* §325 X8d ends */'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const STORES = [{ id: 1, code: 'tianhe', name: '天河店', nameEn: 'Tianhe' }, { id: 2, code: 'yuexiu', name: '越秀店', nameEn: 'Yuexiu' }];
const NAMES = { tianhe: ['藜麦沙拉套餐', '燕麦奶 1L', 'Bagel + Coffee', '黑麦面包'], yuexiu: ['越秀套餐 A'] };
const BUNDLES = () => [
  { id: 3, store_code: 'tianhe', meituan_name: '藜麦沙拉套餐', available: 4, max_qty: 10, sync_enabled: 0, last_pushed_at: null,
    components: [{ product_id: 11, name_cn: '藜麦', name_en: 'Quinoa', qty: 2 }, { product_id: 12, name_cn: '沙拉', name_en: 'Salad', qty: 1 }] },
  { id: 4, store_code: 'tianhe', meituan_name: '旧套餐', available: 0, max_qty: null, sync_enabled: 1, components: [] },
];
const PRODS = [{ id: 11, name_cn: '藜麦', name_en: 'Quinoa', is_active: 1 }, { id: 12, name_cn: '沙拉', name_en: 'Salad', is_active: 1 },
  { id: 13, name_cn: '燕麦奶', name_en: 'Oat milk', variant_label: '1L', is_active: 0, sku: 'OAT-1' }];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [], pops: 0 };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? ['meituan:view', 'meituan:sync'] : opts.caps, ask: null, askErr: null, stack: [],
      mtb: { list: null, tried: false, err: null, stores: null, names: null, prod: null, draft: null, q: '', pq: '', busy: null, note: null, saveErr: null, suggest: null, hint: null } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); ctx.state.stack.push({ route: r }); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true, elmAgo: () => '5 min ago',
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    document: { getElementById: (id) => els[id] || null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: () => ctx.state.mtb, list: () => ctx.SUBS.mtbundles.render(), editor: () => ctx.SUBS.mtbundle.render() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function opened(opts) {
  const h = mk(opts);
  h.CMD.mtbOpen(); h.list();
  await answer(h, '/meituan/bundles', { data: BUNDLES() });
  await answer(h, '/meituan/stores', plain(STORES));
  await answer(h, '/meituan/listings', { listings: plain(NAMES) });
  return h;
}
async function editing(h, id) {
  h.CMD.mtbEdit(id);
  if (h.calls.api.some((c) => c.p === '/meituan/products?includeInactive=1' && !c.done)) await answer(h, '/meituan/products?includeInactive=1', { data: plain(PRODS) });
}
const DESK_BODY = ['id', 'storeId', 'storeCode', 'meituanName', 'maxQty', 'syncEnabled', 'components'];

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches it');
{
  it('every bundle write is meituan:sync, and the buttons are drawn for it', async () => {
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin/meituan/bundles'), 'meituan:sync');
    assert.strictEqual(cap.requiredCapFor('DELETE', '/api/retail-admin/meituan/bundles/3'), 'meituan:sync');
    const h = await opened({ caps: ['meituan:view'] });
    assert.deepStrictEqual(plain(h.ctx.ROUTE_CAP.mtbundles), ['meituan:view', 'meituan:sync']);
    assert.strictEqual(h.ctx.ROUTE_CAP.mtbundle, 'meituan:sync');
    const t = h.text(h.list());
    assert.ok(t.includes('藜麦沙拉套餐') && !t.includes('Add bundle') && !t.includes('Edit') && !t.includes('Delete'));
    h.CMD.mtbEdit(3); h.CMD.mtbDelete(3); h.CMD.mtbSuggest(); h.CMD.mtbSave();
    assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.ctx.state.ask, null);
    assert.ok(!h.calls.pushes.includes('mtbundle'));
  });
  it('its door is on the Meituan screen\'s upkeep card', () => {
    assert.ok(M.includes("${canRoute('mtbundles')?`<button class=\"btn2\" style=\"width:100%\" onclick=\"APP.cmd('mtbOpen')\">${T('Bundles','套餐')}</button>`:''}"));
  });
}

section('2 · the list');
{
  it('says what the desktop\'s says', async () => {
    const h = await opened();
    const t = h.text(h.list());
    assert.ok(t.includes('Combos sold on Meituan that use up your products.'));
    assert.ok(t.includes('Tianhe · 藜麦 Quinoa ×2, 沙拉 Salad'));
    assert.ok(t.includes('Available now 4 · cap 10 · sync off'));
    assert.ok(t.includes('旧套餐') && t.includes('no components yet'));
  });
  it('empty and failed reads', async () => {
    const h = mk(); h.CMD.mtbOpen(); h.list();
    await answer(h, '/meituan/bundles', { data: [] });
    assert.ok(h.text(h.list()).includes('No bundles yet.'));
    const f = mk(); f.CMD.mtbOpen(); f.list();
    const c = f.calls.api.find((x) => x.p === '/meituan/bundles'); c.done = true; c.rej(new Error('HTTP 500')); await tick();
    assert.ok(f.text(f.list()).includes('Could not load this.'));
  });
}

section('3 · add and edit');
{
  it('Save sends the desktop\'s body, key for key — the switch carried, a blank cap null', async () => {
    const h = await opened(); await editing(h, 3);
    assert.strictEqual(h.ctx.SUBS.mtbundle.titleOf(), 'Edit bundle');
    const t = h.text(h.editor());
    assert.ok(t.includes('Matches a listing on this store.') && t.includes('藜麦 Quinoa') && t.includes('Components'));
    h.CMD.mtbCap('');
    h.CMD.mtbCompQty(0, '3');
    h.CMD.mtbSave();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/bundles'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(Object.keys(w.body), DESK_BODY);
    assert.deepStrictEqual(w.body, { id: 3, storeId: 1, storeCode: 'tianhe', meituanName: '藜麦沙拉套餐', maxQty: null, syncEnabled: 0,
      components: [{ productId: 11, qty: 3 }, { productId: 12, qty: 1 }] });
    const desk = block(MT, 'window.mtSaveBundle = async function').split('JSON.stringify({')[1];
    for (const k of DESK_BODY) assert.ok(desk.includes(k), 'the desktop sends ' + k);
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Bundle saved.']);
    assert.strictEqual(h.calls.pops, 1);
    assert.ok(h.calls.api.filter((c) => c.p === '/meituan/bundles').length === 2, 'the list is read again');
  });
  it('a new bundle: title only from the store\'s names, components from any product, paused ones too', async () => {
    const h = await opened(); await editing(h, 0);
    assert.strictEqual(h.ctx.SUBS.mtbundle.titleOf(), 'Add bundle');
    assert.ok(h.text(h.editor()).includes('Pick the title from the list.'));
    h.CMD.mtbSave(); assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.editor()).includes('Enter the Meituan bundle title.'));
    const hits = { innerHTML: '' }; h.els.mMtbHits = hits;
    h.CMD.mtbQ('coffee'); assert.ok(h.text(hits.innerHTML).includes('Bagel + Coffee'));
    h.CMD.mtbPick(0);
    assert.strictEqual(h.s().draft.meituanName, 'Bagel + Coffee');
    const ph = { innerHTML: '' }; h.els.mMtbPHits = ph;
    h.CMD.mtbPQ('oat'); assert.ok(h.text(ph.innerHTML).includes('燕麦奶 Oat milk (1L) · inactive'));
    h.CMD.mtbAddComp(13); h.CMD.mtbAddComp(13);
    assert.strictEqual(h.s().draft.components.length, 1, 'added once');
    h.CMD.mtbCap('5');
    h.CMD.mtbSave();
    assert.deepStrictEqual(W(h, 0).body, { id: null, storeId: 1, storeCode: 'tianhe', meituanName: 'Bagel + Coffee', maxQty: '5', syncEnabled: 1,
      components: [{ productId: 13, qty: 1 }] });
  });
  it('a stored title no listing carries reads as wrong, but can be kept unchanged', async () => {
    const h = await opened(); await editing(h, 4);
    assert.ok(h.text(h.editor()).includes('This stored title matches no listing on this store.'));
    h.CMD.mtbSave();
    assert.strictEqual(W(h, 0).body.meituanName, '旧套餐');
  });
  it('switching store clears the search and follows that store\'s names', async () => {
    const h = await opened(); await editing(h, 0);
    h.CMD.mtbStore('yuexiu');
    h.s().q = '套餐';
    assert.ok(h.text(h.ctx.mtbHits()).includes('越秀套餐 A') && !h.text(h.ctx.mtbHits()).includes('藜麦'));
    h.CMD.mtbStore('nowhere'); assert.strictEqual(h.s().draft.storeCode, 'yuexiu');
  });
  it('the server\'s refusal of the title is said under the field, and the screen stays', async () => {
    const h = await opened(); await editing(h, 3);
    h.CMD.mtbSave();
    const e = new Error('That name is not in the catalogue.'); e.code = 'name_not_in_catalogue'; W(h, 0).rej(e); await tick();
    const t = h.text(h.editor());
    assert.ok(t.includes('Refused — that name is not in the catalogue. Refresh it and try again.') && t.includes('That name is not in the catalogue.'));
    assert.strictEqual(h.calls.pops, 0); assert.deepStrictEqual(h.calls.toasts, []);
    h.CMD.mtbSave(); W(h, 1).rej(REFUSED()); await tick();
    assert.ok(h.text(h.editor()).includes('You don’t have permission for this'));
  });
}

section('4 · delete and suggest');
{
  it('Delete asks the desktop\'s question, then sends DELETE', async () => {
    const h = await opened();
    h.CMD.mtbDelete(3);
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Delete this bundle?');
    assert.strictEqual(a.body, 'This only stops auto-stock — it does not touch the Meituan listing.');
    assert.strictEqual(a.confirmLabel, 'Delete bundle'); assert.strictEqual(a.danger, true);
    assert.strictEqual(h.calls.writes.length, 0);
    a.run();
    const w = W(h, 0); assert.strictEqual(w.p, '/meituan/bundles/3'); assert.strictEqual(w.method, 'DELETE');
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Deleted.']);
  });
  it('a failed delete stays on the list', async () => {
    const h = await opened();
    h.CMD.mtbDelete(3); h.ctx.state.ask.run(); W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.list()).includes('Delete failed: HTTP 500'));
  });
  it('Suggest finds combo-looking titles that are not a bundle yet; Create opens Add with the title', async () => {
    const h = await opened();
    h.CMD.mtbSuggest();
    assert.deepStrictEqual(plain(h.s().suggest), [{ storeCode: 'tianhe', name: 'Bagel + Coffee' }, { storeCode: 'yuexiu', name: '越秀套餐 A' }]);
    const t = h.text(h.list());
    assert.ok(t.includes('2 possible bundle(s) — Create sets the components'));
    h.CMD.mtbCreateFrom(1);
    await answer(h, '/meituan/products?includeInactive=1', { data: plain(PRODS) });
    assert.deepStrictEqual([h.s().draft.storeCode, h.s().draft.meituanName, h.s().draft.id], ['yuexiu', '越秀套餐 A', null]);
    assert.ok(/套餐\|combo\/i\.test\(t\) \|\| \/\[\+＋&\]\/\.test\(t\)/.test(block(MT, 'function mtComboCandidates(')), 'the desktop rule');
  });
  it('nothing combo-looking says so', async () => {
    const h = await opened(); h.s().names = { tianhe: ['黑麦面包'] };
    h.CMD.mtbSuggest();
    assert.ok(h.text(h.list()).includes('No combo-looking titles found.'));
  });
}

section('5 · in Chinese');
{
  it('the list and the editor read in Chinese', async () => {
    const h = await opened({ lang: 'zh' });
    const t = h.text(h.list());
    for (const w of ['美团套餐:库存按组成商品可做的最大份数自动同步。', '新增套餐', '套餐建议', '当前可做 4', '上限 10', '同步已关', '编辑', '删除']) assert.ok(t.includes(w), w);
    await editing(h, 0);
    const e = h.text(h.editor());
    for (const w of ['门店', '美团套餐名 — 从列表中选择', '请从列表中选择套餐名。', '库存上限（可选）', '组成商品 — 该套餐消耗的商品', '尚未添加组成商品，至少添加一个。']) assert.ok(e.includes(w), w);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
