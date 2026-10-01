#!/usr/bin/env node
/**
 * §325 M5 — THE MEDIA LIBRARY ON THE PHONE, AS THE DESKTOP KEEPS IT.
 *
 *   node scripts/test_mobile_media_library.js
 *
 * The phone listed the newest thirty pictures and said "Folders, tags and alt
 * text are on desktop". It now has the desktop's library (07-content-billing.js):
 * search, folder and tag filters, pages of sixty, "used in" counts, details
 * that save themselves on the desktop's card ('media.<id>'), folders, and a
 * selection moved, tagged or deleted with the where-used warning first.
 * Sliced out of public/m.html; the real §279 engine (fast shard). Pins every
 * request (path, method, body), the warnings' words, the three states, and
 * the keys: media:upload for every write but a delete, media:delete for those.
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
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const SRC = slice(MH, '/* ==========================================================================\n   §325 M5 — THE MEDIA LIBRARY', '/* The fapiao list read');

const ROWS = (n, from) => Array.from({ length: n }, (_, i) => ({ id: from + i, filename: 'pic' + (from + i) + '.jpg', mime_type: 'image/jpeg', size_bytes: 2048, width: 800, height: 600, alt_text: '', tags: ['hero'], folder_id: null }));
function mk(opts = {}) {
  const reads = [], writes = [], toasts = [], CMD = {};
  let hist = null, copied = null;
  const ctx = {
    LANG: opts.lang || 'en',
    T: (en, zh) => (opts.lang === 'zh' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    chipRow: (items, cur, cmd) => items.map((c) => `<chip ${c.key === cur ? 'on' : ''} cmd="${cmd}" key="${c.key}" n="${c.count == null ? '' : c.count}">${c.en}</chip>`).join(''),
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    nothingYet: (a, b) => `<empty>${a}|${b}</empty>`,
    state: { media: null, mediaTried: false, mediaLoading: false, mediaErr: null, mediaBusy: null, ask: null, askErr: null, caps: opts.caps === undefined ? null : opts.caps },
    render: () => {}, reg: (n, f) => { CMD[n] = f; }, showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {}, liveHistorySheet: (list, sub, restore) => { hist = { list, sub, restore }; },
    copyText: (t) => { copied = t; },
    TacetAutosave: ENGINE,
    api: async (p) => {
      reads.push(p);
      if (opts.failList && p.startsWith('/media/list')) throw new Error('HTTP 500');
      if (p.startsWith('/media/list')) { const off = Number(new URLSearchParams(p.split('?')[1]).get('offset')); return { rows: off ? ROWS(10, 61) : ROWS(opts.n == null ? 60 : opts.n, 1), total: opts.total == null ? 70 : opts.total }; }
      if (p === '/media/folders') return { folders: [{ id: 3, name: 'Banners', count: 4 }, { id: 4, name: 'Empty', count: 0 }], unsorted_count: 66, total_count: 70 };
      if (p === '/media/tags') return [{ tag: 'hero', n: 12 }];
      if (p === '/media/usage') return { 1: 2, 2: 1 };
      if (/\/history$/.test(p)) return { versions: opts.versions || [] };
      return null;
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method: method || 'POST' });
      if (opts.refuse) { const e = new Error('Your role cannot do this.'); e.refused = true; throw e; }
      return { success: true };
    },
    URLSearchParams, Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout,
  };
  ctx.mCan = (v) => { const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.ML = ML;', ctx);
  return { ctx, CMD, reads, writes, toasts, hist: () => hist, copied: () => copied };
}
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;
const load = async (t) => { t.ctx.screenMedia(); await tick(); return t.ctx.screenMedia(); };

section('1 · the library: filters, counts, pages');
{
  it('loads a page of sixty with the folders, tags and usage; draws the counts and badges', async () => {
    const t = mk();
    const html = await load(t);
    assert.deepStrictEqual(t.reads.sort(), ['/media/folders', '/media/list?limit=60&offset=0', '/media/tags', '/media/usage']);
    assert.ok(/key="all" n="70">All media</.test(html) && /key="unsorted" n="66">Unsorted</.test(html) && /key="3" n="4">Banners</.test(html));
    assert.ok(/key="__all" n="">All</.test(html) && /key="hero" n="12">hero</.test(html));
    assert.ok(/60 of 70/.test(html));
    assert.ok(/APP\.cmd\('mlTap',1\)[\s\S]*?× 2<\/span>/.test(html) && /APP\.cmd\('mlTap',3\)[\s\S]*?unused<\/span>/.test(html));
    assert.ok(/APP\.cmd\('mlMore'\)">Load more/.test(html));
    assert.ok(!/on desktop/.test(html), 'no "Folders, tags and alt text are on desktop"');
  });
  it('Load more asks for the next sixty and adds them', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlMore(); await tick();
    assert.ok(t.reads.includes('/media/list?limit=60&offset=60'));
    assert.strictEqual(t.ctx.state.media.rows.length, 70);
    assert.ok(!/mlMore/.test(t.ctx.screenMedia()));
  });
  it('search, a folder, a tag: each asks the server again with it', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlQ('beet'); t.CMD.mlSearchGo(); await tick();
    assert.ok(t.reads.includes('/media/list?q=beet&limit=60&offset=0'));
    t.CMD.mlFolder('3'); await tick();
    assert.ok(t.reads.includes('/media/list?q=beet&folder=3&limit=60&offset=0'));
    t.CMD.mlTag('hero'); await tick();
    assert.ok(t.reads.includes('/media/list?q=beet&tag=hero&folder=3&limit=60&offset=0'));
    t.CMD.mlFolder('unsorted'); t.CMD.mlTag('__all'); t.CMD.mlFolder('all'); await tick();
    assert.ok(t.reads.includes('/media/list?q=beet&limit=60&offset=0'));
  });
  it('empty, filtered-empty and failed', async () => {
    const e = mk({ n: 0, total: 0 });
    assert.ok(/<empty>Nothing in the library\|Add photos/.test(await load(e)));
    const f = mk({ n: 0, total: 0 });
    f.ctx.ML.q = 'zzz';
    assert.ok(/<empty>Nothing in the library\|<\/empty>/.test(await load(f)));
    const bad = mk({ failList: true });
    assert.ok(/Load failed/.test(await load(bad)));
  });
}

section('2 · a picture\'s details save themselves');
{
  it('the desktop\'s fields; an edit PATCHes the desktop\'s card with all four', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlTap(5);
    const a = t.ctx.state.ask;
    assert.strictEqual(a.title, 'pic5.jpg');
    assert.deepStrictEqual(plain(a.fields.map((f) => f.id)), ['filename', 'alt_text', 'folder', 'tags']);
    assert.deepStrictEqual(plain(a.fields[2].choices), [['', '(unsorted)'], ['3', 'Banners'], ['4', 'Empty']]);
    assert.ok(/Not used yet/.test(a.body) && /\/api\/retail\/media\/5/.test(a.body));
    live(t.ctx).set('alt_text', 'Beet salad, top-down'); live(t.ctx).set('folder', '3'); live(t.ctx).set('tags', 'Hero, Spring Menu ,hero');
    await live(t.ctx).auto.flush();
    assert.deepStrictEqual(t.writes, [{ p: '/media/5?history=media.5', method: 'PATCH',
      body: { filename: 'pic5.jpg', alt_text: 'Beet salad, top-down', tags: ['hero', 'spring-menu'], folder_id: 3 } }]);
  });
  it('Version history: the picture\'s own; a restore is filed as one', async () => {
    const versions = [{ id: 2, changed: ['alt_text'], snapshot: {} }, { id: 1, isBaseline: true, snapshot: { filename: 'old.jpg', alt_text: null, tags: [], folder_id: null } }];
    const t = mk({ versions });
    await load(t);
    t.CMD.mlTap(5);
    live(t.ctx).history(); await tick();
    assert.ok(t.reads.includes('/media/5/history'));
    await t.hist().restore(versions[1]);
    assert.deepStrictEqual(t.writes[t.writes.length - 1], { p: '/media/5?history=media.5&note=restore', method: 'PATCH', body: { filename: 'old.jpg', alt_text: null, tags: [], folder_id: null } });
  });
  it('Copy gives the address; without media:upload the details are read only', async () => {
    const t = mk({ caps: ['media:view'] });
    await load(t);
    t.CMD.mlTap(1);
    const a = t.ctx.state.ask;
    assert.ok(!a.fields && !a.live);
    assert.deepStrictEqual(plain(a.options.map((o) => o.key)), ['copy']);
    a.run('copy');
    assert.strictEqual(t.copied(), '/api/retail/media/1');
  });
  it('the reload guard and the background flush know the open picture', () => {
    assert.ok(/if\(ML\.auto&&ML\.auto\.busy\(\)\) return true;/.test(MH));
    assert.ok(/if\(ML\.auto\) ML\.auto\.flush\(\); \}/.test(MH));
  });
}

section('3 · deleting says where the picture is used first');
{
  it('one used picture: the desktop\'s warning, then bulk-delete; a toast only on success', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlTap(1);
    live(t.ctx).acts.find((x) => x.key === 'del').run();
    assert.strictEqual(t.ctx.state.ask.title, 'This media is referenced in 2 places. Delete anyway?');
    assert.strictEqual(t.ctx.state.ask.danger, true);
    t.ctx.state.ask.run(); await tick();
    assert.deepStrictEqual(t.writes, [{ p: '/media/bulk-delete', method: 'POST', body: { ids: [1] } }]);
    assert.deepStrictEqual(t.toasts, ['Deleted']);
  });
  it('one unused picture is asked by its name; a selection by its count and broken references', async () => {
    const t = mk();
    await load(t);
    t.ctx.mlDeleteAsk([3]);
    assert.strictEqual(t.ctx.state.ask.title, 'Delete &quot;pic3.jpg&quot;?');
    t.ctx.mlDeleteAsk([1, 2, 3]);
    assert.strictEqual(t.ctx.state.ask.title, 'Delete 3 items — 3 references will be broken. Continue?');
    t.ctx.mlDeleteAsk([3, 4]);
    assert.strictEqual(t.ctx.state.ask.title, 'Delete 2 items?');
  });
  it('a refused delete is said on the screen and no toast says it worked', async () => {
    const t = mk({ refuse: true });
    await load(t);
    t.ctx.mlDeleteAsk([3]); t.ctx.state.ask.run(); await tick();
    assert.deepStrictEqual(t.toasts, []);
    assert.ok(/Your role cannot do this\./.test(t.ctx.screenMedia()));
  });
  it('without media:delete: no Delete anywhere, and asking does nothing', async () => {
    const t = mk({ caps: ['media:view', 'media:upload'] });
    await load(t);
    t.CMD.mlTap(1);
    assert.deepStrictEqual(plain(live(t.ctx).acts.map((x) => x.key)), ['copy']);
    t.ctx.state.ask = null;
    t.ctx.mlDeleteAsk([1]);
    assert.strictEqual(t.ctx.state.ask, null);
    t.CMD.mlSelect();
    assert.ok(!/mlBulkDelete/.test(t.ctx.screenMedia()));
  });
}

section('4 · a selection: move, tag, delete');
{
  it('Select, tap to pick, the bar\'s three actions', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlSelect(); t.CMD.mlTap(1); t.CMD.mlTap(2); t.CMD.mlTap(2); t.CMD.mlTap(4);
    assert.deepStrictEqual([...t.ctx.ML.sel], [1, 4]);
    const html = t.ctx.screenMedia();
    assert.ok(/2 selected/.test(html) && /mlBulkMove/.test(html) && /mlBulkTag/.test(html) && /mlBulkDelete/.test(html));
    assert.ok(/APP\.cmd\('mlSelect'\)">Done/.test(html));
    assert.strictEqual(t.ctx.state.ask, null, 'a tap while selecting does not open the details');
  });
  it('Move: the folders with their counts; bulk-move with the folder, or none for Unsorted', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlSelect(); t.CMD.mlTap(1); t.CMD.mlTap(4);
    t.CMD.mlBulkMove();
    assert.strictEqual(t.ctx.state.ask.title, 'Move to folder');
    assert.deepStrictEqual(plain(t.ctx.state.ask.options.map((o) => o.key)), ['unsorted', '3', '4']);
    t.ctx.state.ask.run('3'); await tick();
    assert.deepStrictEqual(t.writes[0], { p: '/media/bulk-move', method: 'POST', body: { ids: [1, 4], folder_id: 3 } });
    assert.deepStrictEqual(t.toasts, ['Moved 2']);
    t.CMD.mlSelect(); t.CMD.mlSelect(); t.CMD.mlTap(9); t.CMD.mlBulkMove(); t.ctx.state.ask.run('unsorted'); await tick();
    assert.deepStrictEqual(t.writes[1].body, { ids: [9], folder_id: null });
  });
  it('Tag: add and remove, normalised as the desktop does; nothing to apply is said', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlSelect(); t.CMD.mlTap(2);
    t.CMD.mlBulkTag();
    const a = t.ctx.state.ask;
    assert.strictEqual(a.validate({ add: '', remove: '' }), 'Nothing to apply');
    a.run({ add: 'Spring Menu, hero', remove: 'old' }); await tick();
    assert.deepStrictEqual(t.writes[0], { p: '/media/bulk-tag', method: 'POST', body: { ids: [2], add: ['spring-menu', 'hero'], remove: ['old'] } });
    assert.deepStrictEqual(t.toasts, ['Tags updated']);
  });
  it('without either write key there is no Select at all', async () => {
    const t = mk({ caps: ['media:view'] });
    assert.ok(!/mlSelect/.test(await load(t)));
  });
}

section('5 · folders');
{
  it('made, renamed, deleted — with the desktop\'s words and requests', async () => {
    const t = mk();
    await load(t);
    t.CMD.mlFolders();
    assert.deepStrictEqual(plain(t.ctx.state.ask.options.map((o) => o.key)), ['__new', '3', '4']);
    t.ctx.state.ask.run('__new');
    t.ctx.state.ask.run({ name: '' });
    assert.strictEqual(t.writes.length, 0, 'an empty name does nothing, as on the desktop');
    t.ctx.state.ask.run({ name: 'Spring' }); await tick();
    assert.deepStrictEqual(t.writes[0], { p: '/media/folders', method: 'POST', body: { name: 'Spring' } });
    t.CMD.mlFolders(); t.ctx.state.ask.run('3');
    assert.deepStrictEqual(plain(t.ctx.state.ask.options.map((o) => o.key)), ['rename', 'delete']);
    t.ctx.state.ask.run('rename');
    assert.strictEqual(t.ctx.state.ask.fields[0].value, 'Banners');
    t.ctx.state.ask.run({ name: 'Heroes' }); await tick();
    assert.deepStrictEqual(t.writes[1], { p: '/media/folders/3', method: 'PATCH', body: { name: 'Heroes' } });
    t.CMD.mlFolders(); t.ctx.state.ask.run('3'); t.ctx.state.ask.run('delete');
    assert.strictEqual(t.ctx.state.ask.title, 'Delete folder &quot;Banners&quot;? Its 4 items will move to Unsorted (images are kept).');
    t.ctx.state.ask.run(); await tick();
    assert.deepStrictEqual(t.writes[2], { p: '/media/folders/3', method: 'DELETE', body: {} });
    t.CMD.mlFolders(); t.ctx.state.ask.run('4'); t.ctx.state.ask.run('delete');
    assert.strictEqual(t.ctx.state.ask.title, 'Delete empty folder &quot;Empty&quot;?');
  });
  it('a view-only account sees the folders and can make none', async () => {
    const t = mk({ caps: ['media:view'] });
    await load(t);
    t.CMD.mlFolders();
    assert.deepStrictEqual(plain(t.ctx.state.ask.options.map((o) => o.key)), ['3', '4']);
    t.ctx.state.ask.run('3');
    assert.ok(t.ctx.state.ask.title === 'Folder', 'no Rename / Delete to offer: the list stays');
  });
  it('the words are the desktop\'s', () => {
    const D = fs.readFileSync(path.join(ROOT, 'public/retail-admin/07-content-billing.js'), 'utf8');
    for (const s of ['This media is referenced in ${used} place${used===1?\'\':\'s\'}. Delete anyway? · 此媒体被 ${used} 处引用。仍要删除吗？',
      'will be broken. Continue? · 删除 ${ids.length} 项，将破坏 ${usedCount} 处引用，是否继续？',
      'will move to Unsorted (images are kept). · 删除文件夹 "${f.name}"？其中 ${f.count} 个项目将移至未分类（图片保留）。',
      "'/api/retail-admin/media/bulk-move', { method: 'POST', body: { ids, folder_id } }",
      "body: { ids: [..._mlSel], add: _mlBulkAdd, remove: _mlBulkRemove }",
      "card: () => 'media.' + _mlEditId"]) assert.ok(D.includes(s), s.slice(0, 50));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
