#!/usr/bin/env node
/**
 * §325 X8c-2 — MEITUAN'S MATCH NAMES, PASTE NAMES AND START OVER, ON THE PHONE.
 *
 *   node scripts/test_mobile_meituan_match_names.js
 *
 * The desktop Meituan page's guided flow (11-meituan.js mtMatchStart,
 * mtMatchListing, mtMatchApply, mtMatchPick, mtMatchFallback(All),
 * mtClearAll, mtPasteApply).
 *
 * What is asserted: the matcher is the desktop's rule, case for case — the
 * desktop's function is sliced out of 11-meituan.js and run against the same
 * table as the phone's; every write's method, path and body; a name the
 * operator already set is never touched and the switch is kept; the
 * leftovers are offered as the desktop offers them; refusals are counted apart
 * from failures; Start over asks first and leaves the 货号 store alone; Paste
 * feeds the same matcher; each control is the server's key; both languages.
 * No browser — fast shard.
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
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x1Paint('),
  line(M, 'const x8Wait='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X8c-2 — MEITUAN', '/* §325 X8c-2 ends */'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const STORES = [{ id: 1, code: 'tianhe', name: '天河店', nameEn: 'Tianhe' }, { id: 2, code: 'yuexiu', name: '越秀店', nameEn: 'Yuexiu' }];
const P = (id, o) => Object.assign({ id, is_active: 1, stores: {} }, o);
const PRODUCTS = () => [
  P(1, { name_cn: '燕麦奶', name_en: 'Oat milk', variant_label: '1L' }),                       // two contain it → size breaks the tie
  P(2, { name_cn: '黑麦面包', name_en: 'Rye bread' }),                                          // exact
  P(3, { name_cn: '泡菜', name_en: 'Kimchi', sku: '3-120' }),                                   // 货号
  P(4, { name_cn: '豆腐', name_en: 'Tofu' }),                                                   // ambiguous
  P(5, { name_cn: '海苔', name_en: 'Seaweed' }),                                                // not on Meituan
  P(6, { name_cn: '酸奶', name_en: 'Yogurt', stores: { tianhe: { meituan_name: '老酸奶', sync_enabled: 1 } } }), // kept
  P(7, { name_cn: '橄榄油', name_en: 'Olive oil', is_active: 0 }),                              // paused
  P(8, { name_cn: '紫菜', name_en: 'Laver' }),                                                 // not on Meituan either
];
const LISTINGS = { tianhe: ['燕麦奶 1L', '燕麦奶 2L', '黑麦面包', '泡菜大桶', '嫩豆腐', '老豆腐', '米（5kg）', '酸奶杯'] };
// A suggestion is our own name and size, offered only when Meituan carries exactly that string.
const RICE = P(9, { name_cn: '米', name_en: 'Rice', variant_label: '5kg' });
const SKUS = { tianhe: { '3-120': '泡菜大桶' } };

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [], timers: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? ['meituan:map', 'meituan:sync'] : opts.caps, ask: null, askErr: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    document: { getElementById: () => null },
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return 0; },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;state.mtm=mtmBlank();').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: () => ctx.state.mtm, screen: () => ctx.SUBS.mtmatch.render() };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const wake = async (h) => { const t = h.calls.timers.shift(); assert.ok(t, 'no wait pending'); t.f(); await tick(); return t.ms; };
async function opened(opts) {
  const h = mk(opts);
  h.CMD.mtmOpen();
  h.screen();
  await answer(h, '/meituan/products?includeInactive=1', { data: PRODUCTS() });
  await answer(h, '/meituan/stores', plain(STORES));
  return h;
}
/* Answer every write in turn, as the server would; the run awaits each. */
async function drain(h, fromIdx, answerFor) {
  let i = fromIdx;
  for (let n = 0; n < 50; n++) {
    await tick();
    const w = h.calls.writes[i];
    if (!w) break;
    const a = answerFor ? answerFor(w) : null;
    if (a instanceof Error) w.rej(a); else w.res({ success: true });
    i++;
  }
  return i;
}
async function runMatch(h, answerFor) {
  h.CMD.mtmStart(); await tick();
  const r = h.calls.writes[0];
  assert.strictEqual(r.p, '/meituan/listings/refresh'); assert.strictEqual(r.method, 'POST');
  r.res({ success: true, queued: ['tianhe'], alreadyRunning: [] }); await tick();
  assert.strictEqual(await wake(h), 3000);
  await answer(h, '/meituan/listings', { running: 0, listings: plain(LISTINGS), skus: plain(SKUS), jobs: [] });
  const end = await drain(h, 1, answerFor);
  await answer(h, '/meituan/products?includeInactive=1', { data: PRODUCTS() });
  return end;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · the matcher is the desktop\'s');
{
  // The desktop's own function, run against the same products and listings.
  const desk = new vm.Script(block(MT, 'function mtMatchListing(p, storeCode)') + '\nthis.f = mtMatchListing;');
  const dctx = { _listings: LISTINGS, _listingSkus: SKUS }; vm.createContext(dctx); desk.runInContext(dctx);
  it('every product gets the same answer on both surfaces', () => {
    const h = mk(); h.ctx.state.mtm.listings = plain(LISTINGS); h.ctx.state.mtm.skus = plain(SKUS);
    for (const p of PRODUCTS()) {
      assert.deepStrictEqual(plain(h.ctx.mtmMatch(p, 'tianhe')), plain(dctx.f(p, 'tianhe')), 'product ' + p.id);
    }
    assert.strictEqual(h.ctx.mtmMatch(PRODUCTS()[2], 'tianhe').reason, 'sku');
    assert.strictEqual(h.ctx.mtmMatch(PRODUCTS()[0], 'tianhe').reason, 'variant');
    assert.strictEqual(h.ctx.mtmMatch(PRODUCTS()[3], 'tianhe').reason, 'ambiguous');
    assert.deepStrictEqual(plain(h.ctx.mtmMatch(PRODUCTS()[0], 'yuexiu')), { name: '', reason: 'no-listings' });
  });
  it('a composed suggestion is offered only when Meituan really carries it', () => {
    const h = mk(); h.ctx.state.mtm.listings = plain(LISTINGS);
    assert.strictEqual(h.ctx.mtmSuggest(RICE, 'tianhe'), '米（5kg）');
    assert.strictEqual(h.ctx.mtmSuggest(PRODUCTS()[4], 'tianhe'), '');
  });
}

section('2 · who reaches it');
{
  it('the route is meituan:map; Start matching also needs meituan:sync; Paste does not', async () => {
    const h = mk();
    assert.strictEqual(h.ctx.ROUTE_CAP.mtmatch, 'meituan:map');
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin/meituan/products/1/map'), 'meituan:map');
    assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin/meituan/listings/refresh'), 'meituan:sync');
    const m = await opened({ caps: ['meituan:map'] });
    const t = m.text(m.screen());
    assert.ok(!t.includes('Start matching') && t.includes('Cannot connect? Paste the names yourself'));
    m.CMD.mtmStart(); await tick();
    assert.strictEqual(m.calls.writes.length, 0);
    const n = mk({ caps: ['meituan:view'] }); n.CMD.mtmOpen(); assert.deepStrictEqual(n.calls.pushes, []);
  });
  it('its door is on the Meituan screen\'s upkeep card', () => {
    assert.ok(/canRoute\('mtmatch'\)\?`<button class="cta" style="width:100%" onclick="APP\.cmd\('mtmOpen'\)">\$\{T\('Match names','匹配名称'\)\}/.test(M));
  });
}

section('3 · Start matching');
{
  it('reads the listings, saves every confident match with the switch kept, and leaves the operator\'s own names alone', async () => {
    const h = await opened();
    assert.ok(h.text(h.screen()).includes('Reads the product names from your Meituan Tianhe store'));
    await runMatch(h);
    const maps = h.calls.writes.slice(1);
    assert.deepStrictEqual(maps.map((w) => [w.p, w.body.meituanName]), [
      ['/meituan/products/1/map', '燕麦奶 1L'], ['/meituan/products/2/map', '黑麦面包'], ['/meituan/products/3/map', '泡菜大桶']]);
    assert.deepStrictEqual(maps[0].body, { storeId: 1, storeCode: 'tianhe', meituanName: '燕麦奶 1L', syncEnabled: 0, source: 'match_names' });
    assert.ok(!maps.some((w) => w.p === '/meituan/products/6/map'), 'a name the operator set is never touched');
    assert.ok(!maps.some((w) => w.p === '/meituan/products/7/map'), 'a paused product is not matched');
    const t = h.text(h.screen());
    assert.ok(t.includes('3 matched automatically'));
    assert.ok(t.includes('1 need your pick') && t.includes('嫩豆腐') && t.includes('老豆腐'));
    assert.ok(t.includes('2 are not on Meituan') && t.includes('海苔') && t.includes('no suggestion'));
  });
  it('refusals are counted apart from failures, with their own remedy', async () => {
    const h = await opened();
    await runMatch(h, (w) => {
      if (w.body.meituanName === '黑麦面包') { const e = new Error('not in catalogue'); e.code = 'name_not_in_catalogue'; return e; }
      if (w.body.meituanName === '泡菜大桶') return new Error('HTTP 500');
      return null;
    });
    const t = h.text(h.screen());
    assert.ok(t.includes('1 matched automatically') && t.includes('1 failed to save — try again in a minute.'));
    assert.ok(t.includes('1 were refused — those names are not in the catalogue read from this store.'));
  });
  it('a read that finds nothing and an errored job goes back to the start, saying why', async () => {
    const h = await opened();
    h.CMD.mtmStart(); await tick();
    h.calls.writes[0].res({ queued: ['tianhe'] }); await tick(); await wake(h);
    await answer(h, '/meituan/listings', { running: 0, listings: {}, jobs: [{ status: 'error', error: 'login expired' }] });
    assert.strictEqual(h.s().stage, 'intro');
    assert.ok(h.text(h.screen()).includes('Match failed: login expired'));
  });
}

section('4 · the review');
{
  it('a tapped candidate is saved and the row leaves', async () => {
    const h = await opened(); const end = await runMatch(h);
    h.CMD.mtmPick(0, 1);
    const w = h.calls.writes[end];
    assert.deepStrictEqual(w.body, { storeId: 1, storeCode: 'tianhe', meituanName: '老豆腐', syncEnabled: 0, source: 'match_names' });
    assert.strictEqual(w.p, '/meituan/products/4/map');
    w.res({ success: true }); await tick();
    await answer(h, '/meituan/products?includeInactive=1', { data: PRODUCTS() });
    assert.strictEqual(h.s().amb.length, 0); assert.strictEqual(h.s().applied, 4);
  });
  it('a suggested name is used, singly or for all; a refusal stays on screen in the server\'s words', async () => {
    const h = await opened(); const end = await runMatch(h);
    h.ctx.state.mtm.unm.push({ pid: 9, label: '米 Rice · 5kg', suggestion: '米（5kg）' });
    assert.ok(h.text(h.screen()).includes('Use “米（5kg）”'));
    h.CMD.mtmUse(2);
    const w = h.calls.writes[end];
    assert.strictEqual(w.p, '/meituan/products/9/map'); assert.strictEqual(w.body.meituanName, '米（5kg）');
    const e = new Error('That name is not in the catalogue.'); e.code = 'name_not_in_catalogue'; w.rej(e); await tick();
    assert.ok(h.text(h.screen()).includes('That name is not in the catalogue.'));
    assert.strictEqual(h.s().unm.length, 3, 'the row stays');
    const desk = block(MT, 'window.mtMatchFallbackAll = async function');
    assert.ok(/filter\(it => it\.suggestion\)/.test(desk));
  });
}

section('4b · a permission refusal');
{
  it('a pick the server refuses for permission is said in its words, and the row stays', async () => {
    const h = await opened(); const end = await runMatch(h);
    h.CMD.mtmPick(0, 0);
    h.calls.writes[end].rej(REFUSED()); await tick();
    assert.ok(h.text(h.screen()).includes('You don’t have permission for this'));
    assert.strictEqual(h.s().amb.length, 1);
    assert.deepStrictEqual(h.calls.toasts, []);
  });
}

section('5 · Start over and Paste');
{
  it('Start over asks first, clears only the delivery store\'s names, and goes back to the start', async () => {
    const h = await opened(); const end = await runMatch(h);
    h.ctx.state.mtm.prod = PRODUCTS().map((p) => (p.id <= 2 ? Object.assign(p, { stores: { tianhe: { meituan_name: 'x' }, yuexiu: { meituan_name: 'y' } } }) : p));
    h.CMD.mtmStartOver();
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Clear all 3 Meituan names on Tianhe?');
    assert.ok(/links itself by 货号 is left untouched/.test(a.body)); assert.strictEqual(a.danger, true);
    assert.strictEqual(h.calls.writes.length, end);
    a.run(); const fin = await drain(h, end);
    const clears = h.calls.writes.slice(end, fin);
    assert.deepStrictEqual(clears.map((w) => w.p), ['/meituan/products/1/map', '/meituan/products/2/map', '/meituan/products/6/map']);
    assert.deepStrictEqual(clears[0].body, { storeId: 1, storeCode: 'tianhe', meituanName: '', syncEnabled: 0, source: 'remove' });
    assert.ok(clears.every((w) => w.body.storeCode === 'tianhe'), 'the 货号 store is never written');
    await answer(h, '/meituan/products?includeInactive=1', { data: PRODUCTS() });
    assert.deepStrictEqual(h.calls.toasts, ['Cleared 3 mapping(s).']);
    assert.strictEqual(h.s().stage, 'intro');
  });
  it('nothing set says so rather than asking', async () => {
    const h = await opened(); h.ctx.state.mtm.prod = [P(1, { name_cn: 'a' })];
    h.CMD.mtmStartOver();
    assert.strictEqual(h.ctx.state.ask, null);
    h.ctx.state.mtm.stage = 'intro';
    assert.ok(h.text(h.screen()).includes('Nothing to clear — no names are set on Tianhe.'));
  });
  it('Paste needs a title, then feeds the same matcher — de-duplicated, bullets stripped, no refresh', async () => {
    const h = await opened({ caps: ['meituan:map'] });
    h.CMD.mtmPasteOpen();
    assert.ok(h.text(h.screen()).includes('Paste Meituan names') && h.text(h.screen()).includes('Store: Tianhe'));
    h.CMD.mtmPasteApply();
    assert.ok(h.text(h.screen()).includes('Paste at least one title.'));
    h.CMD.mtmPasteText('• 黑麦面包\n- 黑麦面包\n\n  燕麦奶 2L');
    h.CMD.mtmPasteApply(); await tick();
    assert.deepStrictEqual(plain(h.s().listings.tianhe), ['黑麦面包', '燕麦奶 2L']);
    const end = await drain(h, 0);
    assert.deepStrictEqual(h.calls.writes.slice(0, end).map((w) => [w.p, w.body.meituanName]), [
      ['/meituan/products/1/map', '燕麦奶 2L'], ['/meituan/products/2/map', '黑麦面包']]);
    assert.ok(!h.calls.writes.some((w) => w.p === '/meituan/listings/refresh'));
    const desk = block(MT, 'window.mtPasteApply = async function');
    assert.ok(desk.includes(".replace(/^[\\s•\\-–·]+/, '')"), 'the desktop strips the same marks');
  });
}

section('6 · reads, and Chinese');
{
  it('a failed read says so and offers Try again', async () => {
    const h = mk(); h.CMD.mtmOpen(); h.screen();
    const c = h.calls.api[0]; c.done = true; c.rej(new Error('HTTP 500')); await tick();
    const t = h.text(h.screen());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
  });
  it('in Chinese', async () => {
    const h = await opened({ lang: 'zh' });
    const t = h.text(h.screen());
    assert.ok(t.includes('从美团天河店读取商品名称') && t.includes('开始匹配') && t.includes('无法连接？自己粘贴名称'));
    await runMatch(h);
    const r = h.text(h.screen());
    assert.ok(r.includes('已自动匹配 3 个') && r.includes('1 个需要你选择') && r.includes('重新开始'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
