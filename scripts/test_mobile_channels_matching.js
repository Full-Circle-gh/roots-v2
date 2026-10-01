#!/usr/bin/env node
/**
 * §325 X8c — MATCHING AND CLAIMS ON THE PHONE: ONE PRODUCT ON ONE CHANNEL.
 *
 *   node scripts/test_mobile_channels_matching.js
 *
 * The channel tabs' product panel (11-meituan.js mtPanelStore / mtWriteMap /
 * mtSaveClaim / mtRemoveName; 14-eleme.js elPanelStore / elSetElemeName /
 * elRemoveMapping / elClaimOption / elSetUnits; 12-guanyi.js gyBind /
 * gyUnbind), opened from a Channel sync card the way the desktop's csFix
 * opens the channel's tab on the product.
 *
 * What is asserted: every write's method, path and body; only a name read from
 * the channel can be sent; naming never moves the sync switch; Remove asks
 * first; options claimed by another product cannot be taken; each control is
 * the key the server asks (lib/cap-routes.js) and without it nothing is sent;
 * failures said in place; loading and failed reads; both languages. No browser
 * — fast shard.
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
const EL = fs.readFileSync(path.join(ROOT, 'public/retail-admin/14-eleme.js'), 'utf8');
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
  block(M, 'function toggle('),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function searchBox('),
  line(M, 'function searchClearShow('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x1Paint('),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X8c — MATCHING', '/* §325 X8c ends */'),
].join('\n');

const ALL = ['meituan:map', 'meituan:sync', 'eleme:map', 'eleme:sync', 'guanyi:map'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? ALL : opts.caps, ask: null, askErr: null,
      chm: { ch: null, pid: null, seq: 0, tried: false, prod: null, stores: null, names: null, cat: {}, err: null, busy: null, note: {}, q: '' } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    document: { getElementById: (id) => els[id] || null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state.chm, screen: () => ctx.SUBS.chmatch.render() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };

const MT_STORES = [{ id: 1, code: 'tianhe', name: '天河店', nameEn: 'Tianhe' }, { id: 2, code: 'yuexiu', name: '越秀店', nameEn: 'Yuexiu' }];
const MT_NAMES = { tianhe: ['燕麦奶 1L', '燕麦奶 2L', '黑麦面包'] };
const mtProd = (stores) => ({ success: true, data: [{ id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: '3-120', variant_label: '1L', stores: stores || {} }], optionOwners: {} });
async function mt(stores, opts, owners) {
  const h = mk(opts);
  h.CMD.chmOpen('meituan', 7);
  if (h.ctx.canRoute('chmatch')) assert.deepStrictEqual(h.calls.pushes, ['chmatch']);
  else { h.s.ch = 'meituan'; h.s.pid = 7; }   // drawn for somebody who cannot open it, to prove nothing writes
  h.screen();
  const prod = mtProd(stores); if (owners) prod.optionOwners = owners;
  await answer(h, '/meituan/products?includeInactive=1', prod);
  await answer(h, '/meituan/stores', plain(MT_STORES));
  await answer(h, '/meituan/listings', { listings: plain(MT_NAMES) });
  return h;
}
const EL_STORES = [{ id: 5, code: 'yx', name: '越秀店', nameEn: 'Yuexiu', shop_id: 'S1' }, { id: 6, code: 'th', name: '天河店', nameEn: 'Tianhe', shop_id: '' }];
const EL_CAT = [{ name: 'Oatly 燕麦奶', specs: [{ specGlobalId: 101, name: '1瓶', stock: 9 }, { specGlobalId: 102, name: '3瓶', stock: 4 }] }, { name: '黑麦面包', specs: [] }];
async function el(stores, opts, owners) {
  const h = mk(opts);
  h.CMD.chmOpen('eleme', 7);
  h.screen();
  await answer(h, '/eleme/products', { success: true, data: [{ id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', stores: stores || {} }], optionOwners: owners || {} });
  await answer(h, '/eleme/stores', plain(EL_STORES));
  await answer(h, '/eleme/catalogue?storeCode=yx', { success: true, data: plain(EL_CAT) });
  await answer(h, '/eleme/catalogue?storeCode=th', { success: true, data: [] });
  return h;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches it, and which key each control asks');
{
  it('the route opens for any of the five keys its controls are drawn for', () => {
    const h = mk();
    assert.deepStrictEqual(plain(h.ctx.ROUTE_CAP.chmatch), ALL);
    for (const ch of ['meituan', 'eleme']) {
      assert.strictEqual(cap.requiredCapFor('POST', `/api/retail-admin/${ch}/products/7/map`), ch + ':map');
      assert.strictEqual(cap.requiredCapFor('POST', `/api/retail-admin/${ch}/products/7/claim`), ch + ':sync');
    }
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin/guanyi/products/7/map'), 'guanyi:map');
  });
  it('the Channel sync card opens it where the phone can match, and keeps the sentence where it cannot', () => {
    const cs = slice(M, 'function csListHtml(){', '\nfunction ');
    assert.ok(cs.includes("APP.cmd('chmOpen','${x.ch.key}',${p.id})") && cs.includes("canRoute('chmatch')"));
    assert.ok(cs.includes("T('Fix this on the desktop: '"));
    assert.ok(/T\('Open '\+csChName\(x\.ch\.key\),'前往'\+csChName\(x\.ch\.key\)\)/.test(cs), 'the desktop button’s own pair');
    assert.ok(/cuT\(`Open \$\{name\}`, `前往\$\{name\}`\)/.test(fs.readFileSync(path.join(ROOT, 'public/retail-admin/29-channel-sync.js'), 'utf8')));
  });
  it('without the keys nothing is drawn to write with and no command sends', async () => {
    const h = await mt({ tianhe: { meituan_name: '燕麦奶 1L', sync_enabled: 1, specs: [{ skuId: 'a', spec: 'A', sku: '1' }, { skuId: 'b', spec: 'B', sku: '2' }], claims: [] } }, { caps: ['meituan:view'] });
    const html = h.screen();
    assert.ok(!html.includes('chmRemove') && !html.includes('chmClaim') && !html.includes('mChmQ'));
    h.s.q = '燕麦'; h.CMD.chmPick('tianhe', 1, 0); h.CMD.chmRemove('tianhe', 1); h.CMD.chmClaim('tianhe', 1, 0, true, 1);
    h.CMD.chmGyBind(); h.CMD.chmGyUnbind();
    assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.ctx.state.ask, null);
    const n = mk({ caps: ['orders:view'] }); n.CMD.chmOpen('meituan', 7); assert.deepStrictEqual(n.calls.pushes, []);
  });
}

section('2 · Meituan');
{
  it('the delivery store is editable; the 闪购 store is read, by 货号', async () => {
    const h = await mt({});
    const t = h.text(h.screen());
    assert.ok(t.includes('Oat milk · 1L') && t.includes('SKU 3-120'));
    assert.ok(t.includes('Tianhe') && t.includes('Meituan delivery name'));
    assert.ok(t.includes('Yuexiu') && t.includes('No listing carries SKU 3-120 yet — add it on 闪购 and this links itself'));
  });
  it('the desktop guesses the delivery store the same way', () => {
    assert.ok(/s\.code === 'tianhe' \|\| s\.name\?\.includes\('天河'\)/.test(MT));
  });
  it('typing searches the names read from Meituan; only a tapped name is sent, and the switch is kept', async () => {
    const h = await mt({ tianhe: { meituan_name: '', sync_enabled: 0 } });
    const hits = { innerHTML: '' }; h.els['mChmHits-tianhe'] = hits;
    h.CMD.chmQ('燕麦');
    assert.ok(h.text(hits.innerHTML).includes('燕麦奶 1L') && h.text(hits.innerHTML).includes('燕麦奶 2L') && !h.text(hits.innerHTML).includes('黑麦'));
    h.CMD.chmQ('zzz'); assert.ok(h.text(hits.innerHTML).includes('No matches'));
    h.CMD.chmQ('燕麦'); h.CMD.chmPick('tianhe', 1, 1);
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/products/7/map'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { storeId: 1, storeCode: 'tianhe', meituanName: '燕麦奶 2L', syncEnabled: 0, source: 'manual' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.ok(h.calls.api.filter((c) => c.p === '/meituan/products?includeInactive=1').length === 2, 'the product is read again');
    assert.ok(/syncEnabled = mtKeepSync\(pid, storeCode\)/.test(block(MT, 'async function mtWriteMap(')), 'the desktop keeps the switch the same way');
  });
  it('a mapped product keeps sync on when its name is corrected', async () => {
    const h = await mt({ tianhe: { meituan_name: '燕麦奶 1L', sync_enabled: 1 } });
    h.s.q = '2L'; h.CMD.chmPick('tianhe', 1, 0);
    assert.strictEqual(W(h, 0).body.syncEnabled, 1);
  });
  it('a stored name no listing carries says so; with no names read it says the check cannot run', async () => {
    const h = await mt({ tianhe: { meituan_name: '旧名字', sync_enabled: 1 } });
    assert.ok(h.text(h.screen()).includes('This name matches no listing on this store. Pick one from the list.'));
    const n = mk(); n.CMD.chmOpen('meituan', 7); n.screen();
    await answer(n, '/meituan/products?includeInactive=1', mtProd({ tianhe: { meituan_name: '燕麦奶 1L', sync_enabled: 1 } }));
    await answer(n, '/meituan/stores', plain(MT_STORES)); await answer(n, '/meituan/listings', { listings: {} });
    const t = n.text(n.screen());
    assert.ok(t.includes('no listings read from this store yet, so nothing can be checked here'));
    assert.ok(!n.screen().includes('mChmHits-tianhe'), 'nothing to pick from, so no list');
  });
  it('Remove asks with the name, then clears it as a removal', async () => {
    const h = await mt({ tianhe: { meituan_name: '燕麦奶 1L', sync_enabled: 1 } });
    h.CMD.chmRemove('tianhe', 1);
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Remove'); assert.strictEqual(a.body, '燕麦奶 1L'); assert.strictEqual(a.danger, true);
    assert.strictEqual(h.calls.writes.length, 0);
    a.run();
    assert.deepStrictEqual(W(h, 0).body, { storeId: 1, storeCode: 'tianhe', meituanName: '', syncEnabled: 1, source: 'remove' });
  });
  it('the server\'s refusal of a name is said in place, and the product is read again', async () => {
    const h = await mt({ tianhe: { meituan_name: '', sync_enabled: 0 } });
    h.s.q = '燕麦'; h.CMD.chmPick('tianhe', 1, 0);
    const e = new Error('That name is not in the catalogue for tianhe.'); e.code = 'name_not_in_catalogue';
    W(h, 0).rej(e); await tick();
    assert.ok(h.text(h.screen()).includes('Save failed: That name is not in the catalogue for tianhe.'));
    assert.deepStrictEqual(h.calls.toasts, []);
    h.CMD.chmPick('tianhe', 1, 0); W(h, 1).rej(REFUSED()); await tick();
    assert.ok(h.text(h.screen()).includes('You don’t have permission for this'));
  });
  const SHARED = { meituan_name: '燕麦奶 1L', sync_enabled: 1,
    specs: [{ skuId: 's1', spec: '一瓶 3-120', sku: '3-120' }, { skuId: 's2', spec: '三瓶 3-121', sku: '3-121' }, { skuId: 's3', spec: '六瓶 3-122', sku: '3-122' }],
    claims: [{ spec_key: 's1', units_per_pack: 1 }] };
  it('a shared listing asks which options this product is; one held by another product cannot be taken', async () => {
    const h = await mt({ tianhe: plain(SHARED) }, {}, { tianhe: { s3: { product_id: 99 } } });
    const t = h.text(h.screen());
    assert.ok(t.includes('Which options is this product?') && t.includes('一瓶 3-120') && t.includes('claimed by another product'));
    h.CMD.chmClaim('tianhe', 1, 2, true, 1);
    assert.strictEqual(h.calls.writes.length, 0, 'the option another product holds is not sent');
    h.CMD.chmClaim('tianhe', 1, 1, true, 3);
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/products/7/claim');
    assert.deepStrictEqual(w.body, { storeId: 1, storeCode: 'tianhe', specSkuId: 's2', specLabel: '三瓶 3-121', units: 3, on: true });
    w.res({ success: true }); await tick();
    h.CMD.chmClaim('tianhe', 1, 0, false, 1);
    assert.deepStrictEqual(W(h, 1).body, { storeId: 1, storeCode: 'tianhe', specSkuId: 's1', specLabel: '一瓶 3-120', units: 1, on: false });
    const desk = block(MT, 'async function mtSaveClaim(');
    for (const k of ['storeId', 'storeCode', 'specSkuId', 'specLabel', 'units', 'on']) assert.ok(desk.includes(k), 'desktop body has ' + k);
  });
  it('an add-on listing says where the count goes, with nothing to pick', async () => {
    const h = await mt({ tianhe: { meituan_name: '燕麦奶 1L', sync_enabled: 1, specs: [{ skuId: 'a', spec: 'Wrap' }, { skuId: 'b', spec: '+ Sauce' }] } });
    const t = h.text(h.screen());
    assert.ok(t.includes('2 options: Wrap · + Sauce') && t.includes('The count goes to Wrap . The add-ons open and close with it.'));
    assert.ok(!h.screen().includes('chmClaim'));
  });
  it('options need meituan:sync; the name needs meituan:map', async () => {
    const h = await mt({ tianhe: plain(SHARED) }, { caps: ['meituan:map'] });
    const html = h.screen();
    assert.ok(html.includes('chmRemove') && !html.includes('chmClaim'));
    assert.ok(h.text(html).includes('1 units'), 'the claim still reads');
  });
}

section('3 · Eleme');
{
  it('each linked store is matched by hand; an unlinked one says why', async () => {
    const h = await el({});
    const t = h.text(h.screen());
    assert.ok(t.includes('Yuexiu') && t.includes('Eleme listing name'));
    assert.ok(t.includes('pick one of the 2 read from this store'));
    assert.ok(t.includes('Nothing can be matched here until this store has an Eleme shop linked'));
  });
  it('a picked name is sent with the switch where it was — a new mapping starts off', async () => {
    const h = await el({});
    h.s.q = 'oatly'; h.CMD.chmPick('yx', 5, 0);
    const w = W(h, 0);
    assert.strictEqual(w.p, '/eleme/products/7/map');
    assert.deepStrictEqual(w.body, { storeId: 5, storeCode: 'yx', elemeName: 'Oatly 燕麦奶', syncEnabled: 0 });
    assert.ok(/syncEnabled: cur \? Number\(cur\.sync_enabled\) : 0/.test(EL), 'the desktop rule');
  });
  it('Remove explains it deletes the mapping, then sends remove:true', async () => {
    const h = await el({ yx: { eleme_name: 'Oatly 燕麦奶', sync_enabled: 1, claims: [] } });
    h.CMD.chmRemove('yx', 5);
    assert.ok(/goes back to Not on Eleme/.test(h.ctx.state.ask.body) && /switch sync off instead/.test(h.ctx.state.ask.body));
    h.ctx.state.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { storeId: 5, storeCode: 'yx', remove: true });
    W(h, 0).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Mapping removed']);
  });
  it('a nameless mapping on an unlinked store can still be removed', async () => {
    const h = await el({ th: { eleme_name: null, sync_enabled: 0 } });
    assert.ok(h.text(h.screen()).includes('This product still holds a mapping here'));
    h.CMD.chmRemove('th', 6); h.ctx.state.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { storeId: 6, storeCode: 'th', remove: true });
  });
  it('the options come from the catalogue and a claim carries the listing name, spec and units', async () => {
    const h = await el({ yx: { eleme_name: 'Oatly 燕麦奶', sync_enabled: 1, claims: [] } });
    const t = h.text(h.screen());
    assert.ok(t.includes('1瓶 · 9') && t.includes('3瓶 · 4'));
    h.CMD.chmClaim('yx', 5, 1, true, 3);
    const w = W(h, 0);
    assert.strictEqual(w.p, '/eleme/products/7/claim');
    assert.deepStrictEqual(w.body, { storeId: 5, storeCode: 'yx', elemeName: 'Oatly 燕麦奶', specId: '102', specName: '3瓶', units: 3, on: true });
    const desk = block(EL, 'window.elClaimOption = async function');
    for (const k of ['storeId', 'storeCode', 'elemeName', 'specId', 'specName', 'units', 'on']) assert.ok(desk.includes(k), 'desktop body has ' + k);
  });
  it('a failed catalogue read leaves nothing to pick from, and says so', async () => {
    const h = await el({});
    assert.ok(h.text(h.screen()).includes('Tianhe'));
    const g = mk(); g.CMD.chmOpen('eleme', 7); g.screen();
    await answer(g, '/eleme/products', { data: [{ id: 7, name_en: 'Oat milk', stores: {} }] });
    await answer(g, '/eleme/stores', [EL_STORES[0]]);
    g.calls.api.find((c) => c.p === '/eleme/catalogue?storeCode=yx').rej(new Error('HTTP 500')); await tick();
    assert.ok(g.text(g.screen()).includes('No catalogue has been read from this store yet, so there is nothing to pick from.'));
  });
}

section('4 · GZ Grocery');
{
  async function gy(p, opts) {
    const h = mk(opts); h.CMD.chmOpen('guanyi', 7); h.screen();
    await answer(h, '/guanyi/products', { success: true, data: [Object.assign({ id: 7, name_en: 'Oat milk', product_sku: 'GVF 1-180' }, p)] });
    return h;
  }
  it('binds to the listing the SKU suggests, sync on, as the desktop does', async () => {
    const h = await gy({ map: null, suggestion: { sku_id: 55, guanyi_name: 'GVF 1-180 燕麦奶' } });
    assert.ok(h.text(h.screen()).includes('GVF 1-180 燕麦奶') && h.text(h.screen()).includes('Bind'));
    h.CMD.chmGyBind();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/guanyi/products/7/map'); assert.deepStrictEqual(w.body, { skuId: '55', syncEnabled: true });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Bound']);
  });
  it('unbinds a bound one', async () => {
    const h = await gy({ map: { guanyi_name: 'GVF 1-180 燕麦奶', guanyi_code: 'C1', sync_enabled: 1 } });
    h.CMD.chmGyUnbind();
    assert.deepStrictEqual(W(h, 0).body, { skuId: '' });
    W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.screen()).includes('Save failed: HTTP 500'));
  });
  it('no suggestion says where to look', async () => {
    const h = await gy({ map: null, suggestion: null });
    assert.ok(h.text(h.screen()).includes('No Guanyi listing carries this product\'s SKU.'));
    assert.ok(!h.screen().includes('chmGyBind'));
  });
}

section('5 · reads, and Chinese');
{
  it('a failed read says so and offers Try again; a product no longer listed says Nothing here', async () => {
    const h = mk(); h.CMD.chmOpen('guanyi', 7); h.screen();
    h.calls.api[0].done = true; h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    const t = h.text(h.screen());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
    h.CMD.chmRetry(); h.screen(); await answer(h, '/guanyi/products', { data: [] });
    assert.ok(h.text(h.screen()).includes('Nothing here.'));
  });
  it('in Chinese', async () => {
    const h = await mt({ tianhe: { meituan_name: '旧名字', sync_enabled: 1 } }, { lang: 'zh' });
    const t = h.text(h.screen());
    for (const w of ['燕麦奶', '天河店', '美团外卖商品名', '该名称与本门店的任何商品都不符,请从列表中选择。', '移除', '越秀店', '暂无商品使用货号']) assert.ok(t.includes(w), w);
    assert.strictEqual(h.ctx.SUBS.chmatch.titleOf(), '美团');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
