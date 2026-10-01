#!/usr/bin/env node
/**
 * §325 M12 — POP-UPS ARE WRITTEN ON THE PHONE, AND NEVER OVER SOMEBODY ELSE'S LIST.
 *
 *   node scripts/test_mobile_popup_editor.js
 *
 * The phone could switch a pop-up on or off and said the rest was written on
 * desktop. It now carries the desktop's editor (05-marketing.js): an existing
 * pop-up saves itself (§279, card 'popup.<id>'), a new one keeps its Save,
 * Duplicate and Delete (asks) are one press each — and because the pop-ups are
 * ONE list written whole, every write sends the version it was built from
 * (§337). Sliced out of public/m.html and run in a sandbox (fast shard), with
 * the real autosave engine. Pins every request (path with expect / history,
 * the whole list), the stale cases (retried when only OTHER pop-ups changed;
 * refused and reloaded when THIS one did), the holds, the leave guard, and the
 * keys.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
const slice = (src, a, b) => {
  const s = src.indexOf(a), e = src.indexOf(b, s + 1);
  if (s < 0 || e < 0) throw new Error('slice not found: ' + a);
  return src.slice(s, e);
};
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const PAGE_SRC = slice(MH, 'const PU_PAGE={', 'function puState(p){');
const STALE_SRC = slice(MH, 'const staleSaveText=', '\n\n');
const PU_SRC = slice(MH, '/* ==========================================================================\n   §325 M12 — POP-UPS ARE WRITTEN', '/* ==========================================================================\n   Operations (desktop');

const P1 = () => ({ id: 'p1', enabled: true, name: 'Autumn promo', pages: ['home', 'shop'], trigger: 'on_load', delay_seconds: 3, frequency: 'once',
  start_at: '', end_at: '', image_url: '', title_en: 'Autumn', title_cn: '秋', body_en: '', body_cn: '', cta_label_en: 'Shop now', cta_label_cn: '',
  cta_target: 'shop', dismissible: true, updated_at: 1000 });
const P2 = () => ({ id: 'p2', enabled: false, name: 'Holiday', pages: ['all'], trigger: 'on_load', delay_seconds: 3, frequency: 'daily',
  start_at: '', end_at: '', image_url: '', title_en: 'Closed', title_cn: '', body_en: '', body_cn: '', cta_label_en: '', cta_label_cn: '',
  cta_target: '', dismissible: true, updated_at: 2000 });

function mk(opts = {}) {
  const writes = [], toasts = [], CMD = {};
  let histSheet = null;
  const responses = (opts.responses || []).slice();
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T,
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>', toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    MEDIA_ERR: {}, apiRefusal: async () => ({ message: 'refused' }), catBannerShrink: async (f) => f, API: '/api/retail-admin',
    FormData: class { append() {} }, location: { href: '' },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: { url: '/api/retail/media/42' } }) }),
    state: { caps: opts.caps === undefined ? ['popups:view'] : opts.caps, ask: null, askErr: null, stack: [{ route: 'popups' }],
      cfg: { popups: { list: opts.list || [P1(), P2()] }, _versions: { 'popups.list': 'v1' } } },
    render: () => {}, forgetScroll: () => {},
    CMD, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    api: async (p) => {
      if (p === '/categories') return [{ id: 7, name: 'Bakery' }];
      if (p.startsWith('/products')) return [{ id: 55, name_en: 'Oat milk', sku: 'OAT' }];
      if (p.startsWith('/config/history')) return opts.history || { success: true, versions: [] };
      return {};
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      const r = responses.length ? responses.shift() : null;
      if (r && r.stale) { const e = new Error('stale_config'); e.code = 'stale_config'; e.body = { key: 'popups.list', version: r.stale.version, value: r.stale.value }; throw e; }
      if (r && r.refuse) { const e = new Error('refused'); e.refused = true; e.words = ['Your role cannot change pop-ups.', '你的角色不能修改弹窗。']; throw e; }
      return { success: true, data: { popups: { list: body['popups.list'] }, _versions: { 'popups.list': 'v' + (writes.length + 1) } } };
    },
    document: { addEventListener: () => {}, getElementById: () => null, createElement: () => ({ click() {} }), visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + PAGE_SRC + STALE_SRC + '\n' + PU_SRC +
    '\nthis.pue=()=>PUE; this.card=(k)=>CFG_CARD[k]; this.screenPopupEdit=screenPopupEdit; this.puMayLeave=puMayLeave; this.puUpload=puUpload; this.cardFootHtml=cardFootHtml;', ctx);
  return { ctx, CMD, writes, toasts, hist: () => histSheet };
}
const yes = (ctx) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(); };
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;
const flush = (ctx, id) => ctx.card('popup.' + id).auto.flush();

section('1 · an existing pop-up saves itself, on the list as loaded');
{
  it('the editor: every desktop field, the card\'s foot, Duplicate and Delete — no Save', () => {
    const { ctx, CMD } = mk();
    CMD.puEdit('p1');
    assert.strictEqual(top(ctx), 'popupedit');
    const html = ctx.screenPopupEdit();
    for (const w of ['Internal name', '— admin only, never shown to customers', 'The message', 'Picture', 'No image yet — text-only pop-up.', 'Add or replace an image',
      'Headline', 'Message', 'Button text', 'What the button opens', 'The rules', 'Where', 'Appears', 'How often', 'Start', 'End',
      'Leave blank to run until you turn it off.', 'Live — show this to customers now', 'Closable — show a close button', 'Duplicate', 'Delete', '→ Opens Shop tab']) assert.ok(html.includes(w), w);
    assert.ok(/cardHistory','popup\.p1'/.test(html) && !/APP\.cmd\('puSave'\)/.test(html));
  });
  it('a change sends the whole list, this pop-up swapped in and stamped, with the version and the card\'s history', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.puEdit('p1');
    CMD.puSet('title_en', 'Autumn sale'); CMD.puPage('cart'); CMD.puSet('frequency', 'daily');
    await flush(ctx, 'p1');
    assert.strictEqual(writes.length, 1);
    const w = writes[0];
    assert.deepStrictEqual([w.p, w.method], ['/config?expect=popups.list%3Av1&history=popup.p1', 'PUT']);
    const [a, b] = w.body['popups.list'];
    assert.deepStrictEqual(plain([a.id, a.title_en, a.pages, a.frequency]), ['p1', 'Autumn sale', ['home', 'shop', 'cart'], 'daily']);
    assert.ok(a.updated_at > 1000, 'a new version, so a "once" pop-up is shown again');
    assert.deepStrictEqual(b, P2(), 'the other pop-up is sent exactly as loaded');
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(P1()).sort());
    assert.strictEqual(ctx.state.cfg._versions['popups.list'], 'v2', 'the next write sends the new version');
  });
  it('no page picked holds the save, in the desktop\'s words; "All pages" overrides the rest', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.puEdit('p1');
    CMD.puPage('all');
    assert.deepStrictEqual(plain(ctx.pue().d.pages), ['all']);
    CMD.puPage('all');
    await flush(ctx, 'p1');
    assert.strictEqual(writes.length, 0);
    assert.ok(/Pick at least one page/.test(ctx.cardFootHtml(ctx.card('popup.p1'))));
  });
  it('stale because ANOTHER pop-up changed: sent again at once on the fresh list, theirs kept', async () => {
    const theirs = Object.assign(P2(), { title_en: 'Closed Monday' });
    const { ctx, CMD, writes } = mk({ responses: [{ stale: { version: 'v9', value: [P1(), theirs] } }] });
    CMD.puEdit('p1');
    CMD.puSet('name', 'Autumn promo 2');
    await flush(ctx, 'p1'); await tick();
    assert.strictEqual(writes.length, 2);
    assert.ok(writes[1].p.startsWith('/config?expect=popups.list%3Av9&history=popup.p1'));
    assert.deepStrictEqual(plain(writes[1].body['popups.list'].map((p) => [p.id, p.name, p.title_en])), [['p1', 'Autumn promo 2', 'Autumn'], ['p2', 'Holiday', 'Closed Monday']]);
    assert.strictEqual(ctx.pue().err, '');
  });
  it('stale because THIS pop-up changed elsewhere: nothing is retried, the editor takes their copy and says so', async () => {
    const mine = Object.assign(P1(), { title_en: 'Their title', updated_at: 5000 });
    const { ctx, CMD, writes } = mk({ responses: [{ stale: { version: 'v9', value: [mine, P2()] } }] });
    CMD.puEdit('p1');
    CMD.puSet('title_en', 'My title');
    await flush(ctx, 'p1'); await tick();
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(ctx.pue().d.title_en, 'Their title');
    assert.ok(String(ctx.pue().err).startsWith('Somebody else changed this while you had it open.'));
  });
  it('Version history restores only this pop-up from the stored list', async () => {
    const old = Object.assign(P1(), { title_en: 'Old title' });
    const versions = [{ id: 1, at: 'x', changed: ['popups.list'], snapshot: { 'popups.list': [old, Object.assign(P2(), { name: 'Old other' })] } }];
    const { CMD, writes, hist } = mk({ history: { success: true, versions } });
    CMD.puEdit('p1');
    CMD.cardHistory('popup.p1'); await tick();
    await hist().restore(versions[0]);
    const w = writes[writes.length - 1];
    assert.ok(w.p.includes('history=popup.p1&note=restore'));
    assert.deepStrictEqual(plain(w.body['popups.list'].map((p) => [p.id, p.name, p.title_en])), [['p1', 'Autumn promo', 'Old title'], ['p2', 'Holiday', 'Closed']]);
  });
}

section('2 · a new pop-up, Duplicate, Delete');
{
  it('New pop-up: the desktop\'s blank; Save puts it first in the list, with the version', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.puNew();
    const d = ctx.pue().d;
    assert.deepStrictEqual(plain([d.enabled, d.pages, d.trigger, d.delay_seconds, d.frequency, d.dismissible]), [true, ['home'], 'on_load', 3, 'once', true]);
    assert.ok(/APP\.cmd\('puSave'\)/.test(ctx.screenPopupEdit()));
    CMD.puSet('name', '  Spring  '); CMD.puSet('title_en', 'Hello');
    CMD.puTarget('product'); CMD.puProdQ('oat'); await new Promise((r) => setTimeout(r, 300)); await tick();
    CMD.puPickProduct(55);
    CMD.puSave(); await tick();
    assert.strictEqual(writes[0].p, '/config?expect=popups.list%3Av1');
    const list = writes[0].body['popups.list'];
    assert.deepStrictEqual(plain([list.length, list[0].name, list[0].title_en, list[0].cta_target, list[1].id, list[2].id]), [3, 'Spring', 'Hello', 'product:55', 'p1', 'p2']);
    assert.deepStrictEqual(toasts, ['Pop-up saved']);
    assert.strictEqual(top(ctx), 'popups');
  });
  it('a new one with no page is not sent; a stale list is refused and said, and the next Save goes on the fresh one', async () => {
    const { ctx, CMD, writes } = mk({ responses: [{ stale: { version: 'v7', value: [P2()] } }] });
    CMD.puNew(); CMD.puPage('home');
    CMD.puSave();
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(ctx.pue().err, 'Pick at least one page');
    CMD.puPage('home'); CMD.puSave(); await tick();
    assert.ok(ctx.pue().err.startsWith('Somebody else changed this'));
    CMD.puSave(); await tick();
    assert.strictEqual(writes[1].p, '/config?expect=popups.list%3Av7');
    assert.deepStrictEqual(plain(writes[1].body['popups.list'].map((p) => p.id)).slice(1), ['p2'], 'built on the list as it is now');
  });
  it('Duplicate: a copy, OFF, "(copy)" on its name, first in the list; the editor opens on the copy', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.puEdit('p1');
    CMD.puDuplicate(); await tick();
    const list = writes[0].body['popups.list'];
    assert.deepStrictEqual(plain([list.length, list[0].enabled, list[0].name, list[0].title_en, list[1].id]), [3, false, 'Autumn promo (copy)', 'Autumn', 'p1']);
    assert.notStrictEqual(list[0].id, 'p1');
    assert.strictEqual(ctx.pue().id, list[0].id);
    assert.deepStrictEqual(toasts, ['Duplicated · edit the copy']);
  });
  it('Delete asks, then sends the list without it', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.puEdit('p2');
    CMD.puDelete();
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.danger], ['Delete this pop-up?', true]);
    assert.strictEqual(writes.length, 0);
    yes(ctx); await tick();
    assert.deepStrictEqual(plain(writes[0].body['popups.list'].map((p) => p.id)), ['p1']);
    assert.deepStrictEqual(toasts, ['Pop-up deleted']);
    assert.strictEqual(top(ctx), 'popups');
  });
  it('a refusal is said on the editor', async () => {
    const { ctx, CMD } = mk({ responses: [{ refuse: true }] });
    CMD.puNew(); CMD.puSave(); await tick();
    assert.strictEqual(ctx.pue().err, 'Your role cannot change pop-ups.');
  });
  it('Back from a new pop-up with changes asks; from an existing one it sends what is pending', async () => {
    const a = mk();
    a.CMD.puNew(); assert.strictEqual(a.ctx.puMayLeave(), true);
    a.CMD.puNew(); a.CMD.puSet('name', 'x');
    assert.strictEqual(a.ctx.puMayLeave(), false);
    assert.strictEqual(a.ctx.state.ask.title, 'Leave without saving? The changes on this page are lost.');
    const b = mk();
    b.CMD.puEdit('p1'); b.CMD.puSet('name', 'y');
    assert.strictEqual(b.ctx.puMayLeave(), true); await tick();
    assert.strictEqual(b.writes.length, 1, 'the pending edit went on the way out');
    assert.ok(MH.includes("if(top==='popupedit'&&!puMayLeave()) return;") && MH.includes("if(PUE&&PUE.isNew&&PUE.dirty&&(state.stack||[]).some(f=>f&&f.route==='popupedit')) return true;"));
  });
  it('the picture: POST /cms/media, then the card saves the address', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.puEdit('p1');
    await ctx.puUpload({});
    await flush(ctx, 'p1');
    assert.strictEqual(writes[0].body['popups.list'][0].image_url, '/api/retail/media/42');
  });
}

section('3 · the keys');
{
  it('without the pop-up keys nothing opens and nothing writes', async () => {
    const { ctx, CMD, writes } = mk({ caps: ['orders:view'] });
    CMD.puNew(); CMD.puEdit('p1');
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.strictEqual(writes.length, 0);
    assert.ok(/popupedit:\['popups:view','popups:edit'\]/.test(MH));
    assert.ok(MH.includes("${puCan()?`<button class=\"btn2\" style=\"min-height:34px;padding:0 14px;font-size:13px\" onclick=\"APP.cmd('puEdit'"), 'the list\'s Edit is drawn for the keys only');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
