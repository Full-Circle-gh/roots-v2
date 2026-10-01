#!/usr/bin/env node
/**
 * §325 X8b — THE CHANNEL SYNC SCREEN'S PICKER, SEARCH AND SWITCH, ON THE PHONE.
 *
 *   node scripts/test_mobile_channel_sync_switch.js
 *
 * The desktop page's tools (29-channel-sync.js `tools`, `syncSwitch`,
 * `csSetSync`): which channel the verdicts are read for, a search over name,
 * SKU and size, and each item's Sync on / off switch. §326.3 brought the
 * switch to the phone and asked that turning it off asks first and says it is
 * a lasting change.
 *
 * What is asserted: the counts follow the channel picked, the desktop's
 * countsFor; the search filters what is shown and nothing else; the switch's
 * request (method, path, body) both ways; off asks first, on does not; the
 * switch is drawn only for {channel}:map and nothing is sent without it;
 * refusals and stale-page answers are said on the row; both languages.
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
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/29-channel-sync.js'), 'utf8');
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
  block(M, 'function toggle('),
  block(M, 'function chipRow('),
  block(M, 'function searchBox('),
  line(M, 'function searchClearShow('),
  block(M, 'function nothingYet('),
  block(M, 'function x1Paint('),
  slice(M, '/* ==========================================================================\n   §103 · CHANNEL SYNC', '/* ==========================================================================\n   Share cards'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const DATA = () => ({
  channels: [{ key: 'meituan' }, { key: 'eleme' }],
  counts: { att: 1, ok: 1, off: 1, none: 0, unk: 0, all: 3 },
  items: [
    { id: 1, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OAT-1', variant_label: '1L', worst: 'att', shelf: { 1: 4 },
      channels: { meituan: { k: 'att', reason: 'push_failed', last_pushed_qty: 2 }, eleme: { k: 'ok', reason: 'synced', last_pushed_qty: 4 } } },
    { id: 2, name_en: 'Rye bread', name_cn: '黑麦面包', sku: 'RYE-2', worst: 'ok', shelf: { 1: 9 },
      channels: { meituan: { k: 'ok', reason: 'synced' }, eleme: { k: 'none', reason: 'no_map' } } },
    { id: 3, name_en: 'Kimchi', name_cn: '泡菜', sku: 'KIM-3', worst: 'off', shelf: { 1: 1 },
      channels: { meituan: { k: 'off', reason: 'sync_off' }, eleme: { k: 'ok', reason: 'synced' } } },
  ],
});

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: { caps: opts.caps === undefined ? ['meituan:view', 'eleme:view', 'meituan:sync', 'eleme:sync', 'meituan:map', 'eleme:map'] : opts.caps,
      cs: DATA(), csErr: '', csFilter: '', csLoading: false, csTried: true, csOpen: null, csCh: '', csQ: '', csBusy: null, csNote: null, ask: null, askErr: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    mCan: (k) => { const c = ctx.state.caps; return Array.isArray(k) ? k.some((x) => c.includes(x)) : c.includes(k); },
    showToast: (m) => calls.toasts.push(String(m)),
    fmtDay: (v) => 'D' + v, _date: (v) => (v ? new Date(v) : null),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    document: { getElementById: (id) => els[id] || null },
    location: { href: '' },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC).runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, st: ctx.state };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const fn = (h, name) => vm.runInContext(name, h.ctx);
const screen = (h) => fn(h, 'screenChannelSync')();
const chipCount = (t, label) => { const m = new RegExp(label + ' (\\d+)').exec(t); return m ? Number(m[1]) : null; };

// ─────────────────────────────────────────────────────────────────────────
section('1 · the channel picker');
{
  it('with no channel picked an item counts by its worst, as the server counts', () => {
    const h = mk();
    assert.deepStrictEqual(plain(fn(h, 'csCounts')(h.st.cs)), { ok: 1, att: 1, off: 1, unk: 0, none: 0, all: 3 });
    const t = h.text(screen(h));
    assert.ok(t.includes('All channels') && t.includes('Meituan') && t.includes('Eleme'));
  });
  it('a channel picked counts and filters by that channel\'s own state — the desktop\'s countsFor', () => {
    const h = mk();
    h.CMD.csCh('eleme');
    assert.deepStrictEqual(plain(fn(h, 'csCounts')(h.st.cs)), { ok: 2, att: 0, off: 0, unk: 0, none: 1, all: 3 });
    assert.strictEqual(fn(h, 'csFilterNow')(h.st.cs), 'all', 'nothing needs you on Eleme, so it opens on everything');
    h.CMD.csFilter('none');
    const t = h.text(fn(h, 'csListHtml')());
    assert.ok(t.includes('Rye bread') && !t.includes('Oat milk'));
    h.CMD.csCh('nope'); assert.strictEqual(h.st.csCh, 'eleme', 'a channel not on the screen is ignored');
    const desk = block(DESK, 'function countsFor()');
    assert.ok(/stateOf\(p\)/.test(desk) && /function stateOf\(p\) \{ return _channel \? \(\(p\.channels\[_channel\] \|\| \{\}\)\.k \|\| 'none'\) : p\.worst; \}/.test(DESK), 'the desktop rule this mirrors');
  });
  it('a Name-not-checked chip appears only when something is in it', () => {
    const h = mk(); h.st.cs.items[0].channels.meituan = { k: 'unk' };
    h.CMD.csCh('meituan');
    assert.strictEqual(chipCount(h.text(screen(h)), 'Name not checked'), 1);
    const g = mk(); assert.strictEqual(chipCount(g.text(screen(g)), 'Name not checked'), null);
  });
}

section('2 · the search');
{
  it('filters by name, Chinese name, SKU and size, and repaints the list alone', () => {
    const h = mk(); h.CMD.csFilter('all');
    const body = { innerHTML: '' }; h.els.mCsBody = body;
    h.CMD.csQ('rye');
    assert.ok(h.text(body.innerHTML).includes('Rye bread') && !h.text(body.innerHTML).includes('Oat milk'));
    h.CMD.csQ('泡菜'); assert.ok(h.text(body.innerHTML).includes('Kimchi'));
    h.CMD.csQ('oat-1'); assert.ok(h.text(body.innerHTML).includes('Oat milk'));
    h.CMD.csQ('1l'); assert.ok(h.text(body.innerHTML).includes('Oat milk'));
    h.CMD.csQ('zzz'); assert.ok(h.text(body.innerHTML).includes('Nothing here.'));
    assert.ok(screen(h).includes('id="mCsBody"'));
  });
  it('the counts do not follow the search (the desktop\'s countsFor ignores it)', () => {
    const h = mk(); h.CMD.csQ('rye');
    assert.strictEqual(fn(h, 'csCounts')(h.st.cs).all, 3);
  });
  it('the clear button is registered and the search is emptied on entry', () => {
    assert.ok(M.includes(" ['mCsQ','mCsClr','csQ'],"));
    assert.ok(/route==='channelsync'\)\{ state\.csQ=''; state\.csNote=null; \}/.test(block(M, 'function push(route)')));
  });
}

section('3 · the switch (§326.3)');
{
  const opened = (opts) => { const h = mk(opts); h.CMD.csFilter('all'); h.CMD.csOpen(1); h.st.csOpen = 1; return h; };
  it('is drawn for {channel}:map on every mapped channel line, not where nothing is mapped', () => {
    const h = mk(); h.CMD.csFilter('all'); h.st.csOpen = 2;
    const html = fn(h, 'csListHtml')();
    assert.ok(html.includes(`APP.cmd('csSync','meituan',2)`));
    assert.ok(!html.includes(`APP.cmd('csSync','eleme',2)`), 'Eleme has nothing mapped for this item');
    for (const ch of ['meituan', 'eleme', 'guanyi']) assert.strictEqual(cap.requiredCapFor('POST', `/api/retail-admin/channel-sync/${ch}/products/2/sync`), ch + ':map');
    const n = mk({ caps: ['meituan:view', 'meituan:sync'] }); n.CMD.csFilter('all'); n.st.csOpen = 2;
    assert.ok(!fn(n, 'csListHtml')().includes('csSync'), 'without meituan:map there is no switch');
    n.CMD.csSync('meituan', 2);
    assert.strictEqual(n.st.ask, null); assert.strictEqual(n.calls.writes.length, 0);
  });
  it('turning it off asks first, says it is a lasting change, and sends {on:false}', async () => {
    const h = opened();
    h.CMD.csSync('meituan', 1);
    assert.strictEqual(h.calls.writes.length, 0, 'nothing before the answer');
    const a = h.st.ask;
    assert.strictEqual(a.title, 'Stop syncing Oat milk to Meituan?');
    assert.ok(/lasting change/.test(a.body) && /stops following your shelf/.test(a.body) && /nothing reminds you/.test(a.body));
    assert.strictEqual(a.confirmLabel, 'Turn sync off'); assert.strictEqual(a.danger, true);
    a.run();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/channel-sync/meituan/products/1/sync'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { on: false });
    w.res({ success: true }); await tick();
    assert.strictEqual(h.calls.api[0].p, '/channel-sync', 'the reload is the answer, as on the desktop');
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('turning it back on sends {on:true} straight away, as the desktop does', async () => {
    const h = mk(); h.CMD.csFilter('all');
    h.CMD.csSync('meituan', 3);
    assert.strictEqual(h.st.ask, null);
    assert.deepStrictEqual(h.calls.writes[0].body, { on: true });
    assert.strictEqual(h.calls.writes[0].p, '/channel-sync/meituan/products/3/sync');
  });
  it('one write at a time; the line says Saving… while it is in flight', () => {
    const h = opened();
    h.CMD.csSync('eleme', 1); h.st.ask.run();
    assert.ok(h.text(fn(h, 'csListHtml')()).includes('Saving…'));
    h.CMD.csSync('meituan', 3); h.CMD.csPush('meituan', 1);
    assert.strictEqual(h.calls.writes.length, 1);
  });
  it('a refusal and a stale page are said on the row', async () => {
    const h = opened();
    h.CMD.csSync('meituan', 1); h.st.ask.run();
    h.calls.writes[0].rej(REFUSED()); await tick();
    h.calls.api[0].res(DATA()); await tick();
    assert.ok(h.text(fn(h, 'csListHtml')()).includes('You don’t have permission for this'));
    const g = mk(); g.CMD.csFilter('all'); g.st.csOpen = 3;
    g.CMD.csSync('meituan', 3);
    const e = new Error('not_mapped'); e.code = 'not_mapped'; g.calls.writes[0].rej(e); await tick();
    g.calls.api[0].res(DATA()); await tick();
    assert.ok(g.text(fn(g, 'csListHtml')()).includes('Somebody else changed this while you had it open'));
  });
  it('in Chinese', () => {
    const h = opened({ lang: 'zh' });
    h.CMD.csSync('meituan', 1);
    assert.strictEqual(h.st.ask.title, '停止将「燕麦奶」同步到美团?');
    assert.ok(/持久的更改/.test(h.st.ask.body)); assert.strictEqual(h.st.ask.confirmLabel, '关闭同步');
    const t = h.text(screen(h));
    assert.ok(t.includes('全部渠道') && t.includes('饿了么'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
