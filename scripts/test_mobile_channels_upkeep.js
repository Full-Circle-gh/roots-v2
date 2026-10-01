#!/usr/bin/env node
/**
 * §325 X8a — CHANNEL UPKEEP ON THE PHONE: SYNC NOW, THE CATALOGUE, AUTO-MATCH,
 * SYNC FROM.
 *
 *   node scripts/test_mobile_channels_upkeep.js
 *
 * The channel tabs' maintenance buttons (11-meituan.js mtPushAll,
 * mtRefreshCatalogue, mtSetSyncStart; 14-eleme.js elPushAll, elSetSyncStart;
 * 12-guanyi.js gyRefreshListings, gyAutoMatch, gyPushAll) on the phone's
 * Meituan, Eleme and gzgrocery screens.
 *
 * What is asserted: every write's method, path and body; the catalogue and
 * list refreshes poll until no job runs and apply nothing; the effective sync
 * start is the daemon's own rule; each button is drawn only for the key the
 * server asks (lib/cap-routes.js), and without it nothing is sent; refusals
 * and failures render in place, toasts only for what worked; loading and
 * failed reads; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
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
  line(M, 'const cfgHead='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  block(M, 'function x6Words('),
  line(M, 'const x6En='),
  line(M, 'const x6Zh='),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X8a — CHANNEL UPKEEP', '/* §325 X8a ends */'),
].join('\n');

const ALL = ['meituan:sync', 'eleme:sync', 'guanyi:sync', 'guanyi:map', 'stores:edit'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const MT_STORES = [{ id: 1, code: 'tianhe', name: '天河店', nameEn: 'Tianhe', openTime: '10:00', syncStartTime: null },
  { id: 2, code: 'yuexiu', name: '越秀店', nameEn: 'Yuexiu', openTime: null, syncStartTime: null }];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], timers: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: { caps: opts.caps === undefined ? ALL : opts.caps, elm: { tried: true },
      x8: { busy: null, err: {}, ok: {}, mtStores: null, mtTried: false, mtErr: null, elStores: null, elTried: false, elErr: null,
        mtCat: null, mtCatTried: false, catReading: false, gyLs: null, gyTried: false, gyReading: false } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    elmAgo: () => '5 min ago', tdWhen: (v) => 'T' + v, _tdL: () => ({}),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    // The screen's polling waits are released by the test, one at a time.
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return 0; },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state.x8 };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const fn = (h, name) => vm.runInContext(name, h.ctx);
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const wake = async (h) => { const t = h.calls.timers.shift(); assert.ok(t, 'no wait pending'); t.f(); await tick(); return t.ms; };
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function mt(opts) {
  const h = mk(opts);
  fn(h, 'x8MtCard')();
  await answer(h, '/meituan/stores', plain(MT_STORES));
  await answer(h, '/meituan/listings', { success: true, catalogue: { tianhe: { count: 265, scrapedAt: '2026-10-01 01:00:00' } }, running: 0 });
  return h;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · each button is the server\'s key, and nothing is sent without it');
{
  it('the routes ask what the drawn buttons need', () => {
    const P = (p) => cap.requiredCapFor('POST', '/api/retail-admin' + p);
    assert.strictEqual(P('/meituan/push-all'), 'meituan:sync');
    assert.strictEqual(P('/meituan/listings/refresh'), 'meituan:sync');
    assert.strictEqual(P('/eleme/push-all'), 'eleme:sync');
    assert.strictEqual(P('/guanyi/push-all'), 'guanyi:sync');
    assert.strictEqual(P('/guanyi/listings/refresh'), 'guanyi:sync');
    assert.strictEqual(P('/guanyi/auto-match'), 'guanyi:map');
    assert.strictEqual(cap.requiredCapFor('PATCH', '/api/retail-admin/stores/1'), 'stores:edit');
    const X = slice(M, '§325 X8a — CHANNEL UPKEEP', '/* §325 X8a ends */');
    for (const [cmd, key] of [['x8MtPush', 'meituan:sync'], ['x8MtCat', 'meituan:sync'], ['x8ElPush', 'eleme:sync'],
      ['x8GyRefresh', 'guanyi:sync'], ['x8GyMatch', 'guanyi:map'], ['x8GyPush', 'guanyi:sync'], ['x8SyncFrom', 'stores:edit']]) {
      assert.ok(block(X, `reg('${cmd}'`).includes(`mCan('${key}')`), cmd + ' checks ' + key);
    }
  });
  it('without the keys the facts show and no button does; commands send nothing', async () => {
    const h = await mt({ caps: ['meituan:view'] });
    const t = h.text(fn(h, 'x8MtCard')());
    assert.ok(t.includes('Listing names read from Meituan') && t.includes('Tianhe 265'));
    assert.ok(!t.includes('Refresh catalogue') && !t.includes('Sync now'));
    assert.ok(!fn(h, 'x8MtCard')().includes('type="time"'), 'Sync from is read, not set');
    assert.ok(t.includes('08:00'), 'the effective start still shows');
    for (const c of ['x8MtPush', 'x8MtCat', 'x8ElPush', 'x8GyRefresh', 'x8GyMatch', 'x8GyPush']) h.CMD[c]();
    h.CMD.x8SyncFrom('meituan', 1, '07:00');
    await tick();
    assert.strictEqual(h.calls.writes.length, 0);
    const g = mk({ caps: ['guanyi:view'] });
    assert.ok(!g.text(fn(g, 'x8GyCard')()).includes('Auto-match'));
  });
  it('the cards sit on the three channel screens, and are read again on entry', () => {
    assert.ok(block(M, 'function mirrorScreen(which,note)').includes('mtHealthCard()+x8MtCard()'));
    assert.ok(block(M, 'function mirrorScreen(which,note)').includes('${x8GyCard()'));
    assert.ok(block(M, 'function screenEleme(){').includes('${x8ElCard()'));
    assert.ok(/route==='mirror_meituan'\|\|route==='mirror_eleme'\|\|route==='mirror_gzgrocery'\)\{ const x=state\.x8;/.test(block(M, 'function push(route)')));
  });
}

section('2 · Meituan');
{
  it('the catalogue line, per store, with how old it is', async () => {
    const h = await mt();
    const t = h.text(fn(h, 'x8MtCard')());
    assert.ok(t.includes('Tianhe 265 · 5 min ago') && t.includes('Yuexiu 0 · never read'));
    assert.ok(t.includes('Reads the current listing names. Changes nothing and matches nothing.'));
  });
  it('Sync now POSTs {force:false} and says how many were queued', async () => {
    const h = await mt();
    h.CMD.x8MtPush();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/push-all'); assert.strictEqual(w.method, 'POST'); assert.deepStrictEqual(w.body, { force: false });
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Queuing…'));
    w.res({ success: true, queued: 212 }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Queued 212 stock push(es) to Meituan']);
    assert.ok(h.calls.api.some((c) => c.p === '/meituan/status'), 'the health card is read again');
  });
  it('a refused Sync now stays on the card', async () => {
    const h = await mt();
    h.CMD.x8MtPush(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('Refresh catalogue enqueues, waits while a job runs, then takes the new counts — and applies nothing', async () => {
    const h = await mt();
    h.CMD.x8MtCat();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/listings/refresh'); assert.strictEqual(w.method, 'POST');
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Reading…'));
    w.res({ success: true, queued: ['tianhe'] }); await tick();
    assert.strictEqual(await wake(h), 3000);
    await answer(h, '/meituan/listings', { running: 1, listings: {} });
    await wake(h);
    await answer(h, '/meituan/listings', { running: 0, listings: { tianhe: ['A', 'B'] }, catalogue: { tianhe: { count: 2, scrapedAt: 'now' } } });
    assert.deepStrictEqual(h.calls.toasts, ['Catalogue updated. Nothing was matched or changed.']);
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Tianhe 2'));
    assert.strictEqual(h.calls.writes.length, 1, 'nothing applied: one request, the read');
  });
  it('a read that comes back empty says the sync service may be signed out', async () => {
    const h = await mt();
    h.CMD.x8MtCat(); W(h, 0).res({ success: true }); await tick();
    await wake(h); await answer(h, '/meituan/listings', { running: 0, listings: {} });
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Could not read the listings — is the sync service signed in?'));
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.strictEqual(h.s.catReading, false);
  });
}

section('3 · Sync from');
{
  it('blank says what it resolves to: two hours before opening, or all day with no hours', async () => {
    const h = await mt();
    assert.strictEqual(fn(h, 'x8EffStart')({ openTime: '10:00' }), '08:00');
    assert.strictEqual(fn(h, 'x8EffStart')({ openTime: '10:00', syncStartTime: '14:00' }), '10:00', 'later than opening reads as opening');
    assert.strictEqual(fn(h, 'x8EffStart')({ openTime: '01:00' }), '00:00');
    assert.strictEqual(fn(h, 'x8EffStart')({}), null);
    const t = h.text(fn(h, 'x8MtCard')());
    assert.ok(t.includes('defaults to 08:00') && t.includes('no opening hours set — syncs all day'));
  });
  it('a time PATCHes the store row alone, and a cleared box sends null', async () => {
    const h = await mt();
    h.CMD.x8SyncFrom('meituan', 1, '07:30');
    let w = W(h, 0);
    assert.strictEqual(w.p, '/stores/1'); assert.strictEqual(w.method, 'PATCH'); assert.deepStrictEqual(w.body, { sync_start_time: '07:30' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Syncing this store from 07:30']);
    h.CMD.x8SyncFrom('meituan', 1, '');
    w = W(h, 1); assert.deepStrictEqual(w.body, { sync_start_time: null });
    w.res({ success: true }); await tick();
    assert.strictEqual(h.calls.toasts[1], 'Syncing this store from 08:00');
    h.CMD.x8SyncFrom('meituan', 1, '25:99'); h.CMD.x8SyncFrom('meituan', 99, '07:00');
    assert.strictEqual(h.calls.writes.length, 2, 'a bad time or an unknown store sends nothing');
  });
  it('a failure stays under the list and the store keeps its old time', async () => {
    const h = await mt();
    h.CMD.x8SyncFrom('meituan', 1, '07:30');
    W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Could not save the sync start: HTTP 500'));
    assert.strictEqual(h.s.mtStores[0].syncStartTime, null);
  });
  it('Eleme: the same control on its own stores', async () => {
    const h = mk();
    fn(h, 'x8ElCard')();
    await answer(h, '/eleme/stores', [{ id: 5, code: 'yx', name: '越秀店', nameEn: 'Yuexiu', openTime: '09:00', syncStartTime: '06:00' }]);
    const html = fn(h, 'x8ElCard')();
    assert.ok(html.includes(`APP.cmd('x8SyncFrom','eleme',5,this.value)`) && html.includes('value="06:00"'));
    h.CMD.x8SyncFrom('eleme', 5, '05:00');
    assert.deepStrictEqual(W(h, 0).body, { sync_start_time: '05:00' }); assert.strictEqual(W(h, 0).p, '/stores/5');
  });
  it('a failed store read says so', async () => {
    const h = mk(); fn(h, 'x8MtCard')();
    h.calls.api.find((c) => c.p === '/meituan/stores').rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(fn(h, 'x8MtCard')()).includes('Could not load this.'));
  });
}

section('4 · Eleme push');
{
  it('Push all stock POSTs and says how many; the screen is read again', async () => {
    const h = mk(); h.ctx.state.elm.tried = true;
    h.CMD.x8ElPush();
    const w = W(h, 0); assert.strictEqual(w.p, '/eleme/push-all'); assert.strictEqual(w.method, 'POST');
    w.res({ success: true, queued: 40 }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Queued 40 product(s)']);
    assert.strictEqual(h.ctx.state.elm.tried, false);
  });
  it('a failure stays on the card', async () => {
    const h = mk(); h.CMD.x8ElPush(); W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(fn(h, 'x8ElCard')()).includes('Push failed: HTTP 500'));
  });
}

section('5 · gzgrocery');
{
  async function gy(ls, opts) { const h = mk(opts); fn(h, 'x8GyCard')(); await answer(h, '/guanyi/listings', ls); return h; }
  const LS = { success: true, listings: [{}, {}, {}], job: { completed_at: '2026-10-01 01:00:00' }, running: 0 };
  it('the list line: how many were read and when', async () => {
    const h = await gy(plain(LS));
    const t = h.text(fn(h, 'x8GyCard')());
    assert.ok(t.includes('3 listings read · T2026-10-01 01:00:00'));
    assert.ok(t.includes('Refresh list') && t.includes('Auto-match by SKU') && t.includes('Push all stock'));
    const never = await gy({ listings: [], job: null, running: 0 });
    assert.ok(never.text(fn(never, 'x8GyCard')()).includes('never refreshed'));
  });
  it('Refresh list enqueues and waits for the job, two seconds a look', async () => {
    const h = await gy(plain(LS));
    h.CMD.x8GyRefresh();
    const w = W(h, 0); assert.strictEqual(w.p, '/guanyi/listings/refresh'); assert.strictEqual(w.method, 'POST');
    w.res({ success: true }); await tick();
    assert.strictEqual(await wake(h), 2000);
    await answer(h, '/guanyi/listings', { running: 1, listings: [] });
    assert.ok(h.text(fn(h, 'x8GyCard')()).includes('refreshing…'));
    await wake(h); await answer(h, '/guanyi/listings', Object.assign(plain(LS), { listings: [{}] }));
    assert.deepStrictEqual(h.calls.toasts, ['Guanyi product list refreshed']);
    assert.ok(h.text(fn(h, 'x8GyCard')()).includes('1 listings read'));
  });
  it('Auto-match POSTs and reports what it matched, what was ambiguous, what was not', async () => {
    const h = await gy(plain(LS));
    h.CMD.x8GyMatch();
    const w = W(h, 0); assert.strictEqual(w.p, '/guanyi/auto-match'); assert.strictEqual(w.method, 'POST');
    w.res({ success: true, matched: 12, ambiguous: [{ sku: 'A' }], unmatched: 3 }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Matched 12 product(s) · 1 ambiguous · 3 unmatched']);
  });
  it('Auto-match with nothing read says to refresh first, in place', async () => {
    const h = await gy(plain(LS));
    h.CMD.x8GyMatch(); W(h, 0).res({ success: true, matched: 0, note: 'No cached Guanyi listings — click Refresh first.' }); await tick();
    assert.ok(h.text(fn(h, 'x8GyCard')()).includes('No cached Guanyi listings — click Refresh first.'));
    h.ctx.LANG = 'zh';
    assert.ok(h.text(fn(h, 'x8GyCard')()).includes('尚无已缓存的管易商品 — 请先点击刷新。'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('Push all stock POSTs; a refusal stays', async () => {
    const h = await gy(plain(LS));
    h.CMD.x8GyPush(); const w = W(h, 0); assert.strictEqual(w.p, '/guanyi/push-all');
    w.res({ success: true, queued: 7 }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Queued 7 product(s)']);
    h.CMD.x8GyMatch(); W(h, 1).rej(REFUSED()); await tick();
    assert.ok(h.text(fn(h, 'x8GyCard')()).includes('You don’t have permission for this'));
  });
}

section('6 · in Chinese');
{
  it('the three cards read in Chinese', async () => {
    const h = await mt({ lang: 'zh' });
    const t = h.text(fn(h, 'x8MtCard')());
    for (const w of ['从美团读取的商品名称', '天河店 265', '刷新商品名称', '立即同步', '同步开始', '默认 08:00', '未设营业时间 — 全天同步']) assert.ok(t.includes(w), w);
    const g = mk({ lang: 'zh' }); fn(g, 'x8GyCard')(); await answer(g, '/guanyi/listings', { listings: [{}], job: null, running: 0 });
    const gt = g.text(fn(g, 'x8GyCard')());
    for (const w of ['已读取 1 个商品', '未刷新', '刷新', '按货号自动匹配', '推送全部库存']) assert.ok(gt.includes(w), w);
    const e = mk({ lang: 'zh' }); assert.ok(e.text(fn(e, 'x8ElCard')()).includes('为所有已匹配商品排队推送库存'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
