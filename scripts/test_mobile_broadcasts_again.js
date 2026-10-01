#!/usr/bin/env node
/**
 * §325 M6 — BROADCASTS: SEND AGAIN, RECALL, EVERY STATUS, EVERY REGION.
 *
 *   node scripts/test_mobile_broadcasts_again.js
 *
 * The phone wrote and cancelled broadcasts but could not do what the desktop
 * feed (05-marketing.js bxFeedRow / bxSendAgain / recallBroadcast) does with a
 * past one: send it again, or recall it while it still shows. It also called
 * a recalled, cancelled or expired broadcast "Draft", and offered only the
 * first twelve regions. Sliced out of public/m.html (fast shard). Pins:
 *   1. the statuses in the desktop's words, Ended for a window that has passed;
 *   2. which row offers Cancel send / Recall / Send again, on broadcasts:send;
 *   3. Recall asks first in the desktop's words, then POSTs …/recall;
 *   4. Send again fills the composer from the stored row — both languages in
 *      their own columns, link, audience — now, no end, at its last look; the
 *      POST it then makes; a city no saved address is in any more is dropped;
 *   5. every region is offered.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

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
const sub = (key) => {
  const s = MH.indexOf('  ' + key + ':{title:');
  let depth = 0, i = MH.indexOf('{', s);
  for (; i < MH.length; i++) { if (MH[i] === '{') depth++; else if (MH[i] === '}' && --depth === 0) break; }
  return MH.slice(s, i + 1);
};
const SRC = [
  slice(MH, 'const BC_KIND=', 'function mapFeedback(r){'),
  slice(MH, '/* ==========================================================================\n   Writing a broadcast (§63)', 'function bcfRepaintFoot(){'),
  slice(MH, 'function recallBroadcast(id){', '/* The list, re-read.'),
  slice(MH, "reg('recallBroadcast', id=>recallBroadcast(Number(id)));", "reg('togglePrint'"),
  slice(MH, '/* ==========================================================================\n   Writing a broadcast — the screen (§63)', 'function screenPopups(){'),
  slice(MH, 'const TIER_LABEL=', '\n'),
].join('\n') + '\nthis.SUBBC=({' + sub('broadcasts') + '}).broadcasts;';

const REGIONS = Array.from({ length: 15 }, (_, i) => ({ city: '城' + i, city_en: 'City ' + i, n: 20 - i }));
function mk(opts = {}) {
  const reads = [], writes = [], toasts = [], CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    T: (en, zh) => (opts.lang === 'cn' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>', pill: (k, l) => `<pill ${k}>${l}</pill>`, nothingYet: (a) => `<empty>${a}</empty>`,
    fmtDay: (d) => (d ? String(d).slice(0, 10) : ''), footBar: (inner) => `<foot>${inner}</foot>`, statusNotifCats: () => '',
    state: { bcf: { step: 1, title: '', body: '', title2: '', body2: '', lang2: false, activity: 'all', tiers: [], cities: [],
      when: 'now', at: '', ends: 'never', endsAt: '', deeplink: '', count: null, countBusy: false, countSeq: 0, countTimer: null,
      regions: opts.regions === undefined ? null : opts.regions, regionsTried: opts.regions !== undefined, busy: false, err: '', sent: null },
    bcBusy: null, bcErr: null, bcLoaded: true, ask: null, stack: [], caps: opts.caps === undefined ? null : opts.caps },
    DB: { broadcasts: [] },
    render: () => {}, reg: (n, f) => { CMD[n] = f; }, showToast: (m) => toasts.push(m),
    api: async (p) => { reads.push(p); if (p === '/broadcasts/regions') return REGIONS; if (p.startsWith('/broadcasts/audience-count')) return { count: 42 }; if (p === '/broadcasts') return []; return null; },
    apiWrite: async (p, body) => { writes.push({ p, body: JSON.parse(JSON.stringify(body)) }); return opts.reply ? opts.reply(p) : { success: true, data: { status: 'sent', recipient_count: 42 } }; },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, isNaN, encodeURIComponent, setTimeout, clearTimeout,
  };
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  ctx.mCan = (v) => { const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  ctx.push = (k) => { ctx.state.stack.push({ route: k }); if (k === 'bcnew') ctx.bcfReset(); };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, reads, writes, toasts };
}
const FUTURE = new Date(Date.now() + 86400e3).toISOString(), PAST = new Date(Date.now() - 86400e3).toISOString();
const ROW = (o) => Object.assign({ id: 7, status: 'sent', title_en: 'Autumn menu', title_cn: '秋季菜单', body_en: 'New soups.', body_cn: '新汤品。',
  deeplink: '/pages/shop/shop', audience: JSON.stringify({ activity: 'lapsed', tiers: ['root'], cities: ['城1', '旧城'] }), sent_at: PAST, recipient_count: 12 }, o);

section('1 · every status in the desktop\'s words');
{
  it('recalled, cancelled, expired, and a sent one whose window has passed', () => {
    const { ctx } = mk();
    const st = (o) => plain(ctx.mapBroadcast(ROW(o)));
    assert.deepStrictEqual([st({ status: 'recalled' }).status, st({ status: 'cancelled' }).status, st({ status: 'expired' }).status],
      [['Recalled', '已撤回'], ['Cancelled', '已取消'], ['Expired', '已过期']]);
    const ended = st({ expires_at: PAST });
    assert.deepStrictEqual([ended.status, ended.ended, ended.kind], [['Ended', '已结束'], true, 'off']);
    const live = st({ expires_at: FUTURE });
    assert.deepStrictEqual([live.status, live.ended, live.kind], [['Sent', '已发送'], false, 'delivered']);
    assert.deepStrictEqual(st({}).raw, { title_en: 'Autumn menu', title_cn: '秋季菜单', body_en: 'New soups.', body_cn: '新汤品。', deeplink: '/pages/shop/shop', audience: ROW({}).audience });
  });
}

section('2 · which row offers what');
{
  it('scheduled: Cancel send; sent and showing: Recall and Send again; ended or recalled: Send again', () => {
    const { ctx } = mk();
    ctx.DB.broadcasts = [ROW({ id: 1, status: 'scheduled', scheduled_for: FUTURE }), ROW({ id: 2 }), ROW({ id: 3, expires_at: PAST }), ROW({ id: 4, status: 'recalled' })].map(ctx.mapBroadcast);
    const cards = ctx.SUBBC.render().split('<div class="card"').slice(1);
    assert.ok(/recallBroadcast','1'/.test(cards[0]) && !/bcAgain|recallAsk/.test(cards[0]));
    assert.ok(/recallAsk','2'\)">Recall</.test(cards[1]) && /bcAgain','2'\)">Send again</.test(cards[1]));
    assert.ok(!/recallAsk/.test(cards[2]) && /bcAgain','3'/.test(cards[2]) && /Ended/.test(cards[2]));
    assert.ok(!/recallAsk/.test(cards[3]) && /bcAgain','4'/.test(cards[3]) && /Recalled/.test(cards[3]));
  });
  it('without broadcasts:send: none of them', () => {
    const { ctx, CMD } = mk({ caps: ['broadcasts:view'] });
    ctx.DB.broadcasts = [ROW({ id: 2 })].map(ctx.mapBroadcast);
    assert.ok(!/bcAgain|recallAsk|recallBroadcast/.test(ctx.SUBBC.render()));
    CMD.bcAgain('2'); CMD.recallAsk('2');
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(ctx.state.stack.length, 0);
  });
}

section('3 · Recall');
{
  it('asks first, in the desktop\'s words; then POSTs …/recall and says Recalled', async () => {
    const { ctx, CMD, writes, toasts } = mk({ reply: () => ({ success: true, data: { status: 'recalled', removed: 12 } }) });
    ctx.DB.broadcasts = [ROW({ id: 2 })].map(ctx.mapBroadcast);
    CMD.recallAsk('2');
    assert.strictEqual(ctx.state.ask.title, 'Recall this broadcast (remove from every customer\'s inbox)?');
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Recall');
    assert.strictEqual(ctx.state.ask.danger, true);
    ctx.state.ask.run(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/broadcasts/2/recall', body: {} }]);
    assert.deepStrictEqual(plain(ctx.DB.broadcasts[0].status), ['Recalled', '已撤回']);
    assert.deepStrictEqual(toasts, ['Recalled']);
    const D = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
    assert.ok(D.includes("'Recall this broadcast (remove from every customer\\'s inbox) · 撤回此群发消息（从每位客户的收件箱中移除）'"));
  });
  it('a scheduled send that went out meanwhile is recalled by the same call, and says so', async () => {
    const { ctx, toasts } = mk({ reply: () => ({ success: true, data: { status: 'recalled' } }) });
    ctx.DB.broadcasts = [ROW({ id: 1, status: 'scheduled' })].map(ctx.mapBroadcast);
    ctx.recallBroadcast(1); await tick();
    assert.deepStrictEqual(plain(ctx.DB.broadcasts[0].status), ['Recalled', '已撤回']);
    assert.deepStrictEqual(toasts, ['Recalled']);
  });
  it('nothing to recall once the window has closed', () => {
    const { ctx, CMD } = mk();
    ctx.DB.broadcasts = [ROW({ id: 3, expires_at: PAST })].map(ctx.mapBroadcast);
    CMD.recallAsk('3');
    assert.strictEqual(ctx.state.ask, null);
  });
}

section('4 · Send again');
{
  it('fills the composer from the row, at its last look, now and with no end', async () => {
    const { ctx, CMD, reads } = mk({ regions: REGIONS });
    ctx.DB.broadcasts = [ROW({ id: 2, expires_at: FUTURE })].map(ctx.mapBroadcast);
    ctx.state.bcf.when = 'later'; ctx.state.bcf.at = 'x';
    CMD.bcAgain('2');
    const f = ctx.state.bcf;
    assert.deepStrictEqual(plain([f.step, f.title, f.body, f.title2, f.body2, f.lang2, f.deeplink, f.activity, f.tiers, f.cities, f.when, f.at, f.ends, f.endsAt]),
      [4, 'Autumn menu', 'New soups.', '秋季菜单', '新汤品。', true, '/pages/shop/shop', 'lapsed', ['root'], ['城1'], 'now', '', 'never', '']);
    assert.deepStrictEqual(plain(ctx.state.stack), [{ route: 'bcnew' }]);
    await new Promise((r) => setTimeout(r, 300)); await tick();
    assert.ok(reads.some((p) => p.startsWith('/broadcasts/audience-count?aud=')), 'counted again');
    assert.strictEqual(f.count, 42);
    assert.ok(/Ready to send\?/.test(ctx.screenBcNew()) && /Autumn menu/.test(ctx.screenBcNew()));
  });
  it('sending it posts the stored words in their own columns, the link and the audience', async () => {
    const { ctx, CMD, writes } = mk({ regions: REGIONS });
    ctx.DB.broadcasts = [ROW({ id: 2 })].map(ctx.mapBroadcast);
    CMD.bcAgain('2');
    ctx.bcfSend(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/broadcasts', body: { audience: { activity: 'lapsed', tiers: ['root'], cities: ['城1'] }, deeplink: '/pages/shop/shop',
      title_en: 'Autumn menu', body_en: 'New soups.', title_cn: '秋季菜单', body_cn: '新汤品。' } }]);
  });
  it('working in Chinese, the Chinese is the first field and still lands in its own column', async () => {
    const { ctx, CMD, writes } = mk({ lang: 'cn', regions: REGIONS });
    ctx.DB.broadcasts = [ROW({ id: 2, title_en: '', body_en: '' })].map(ctx.mapBroadcast);
    CMD.bcAgain('2');
    const f = ctx.state.bcf;
    assert.deepStrictEqual([f.title, f.title2, f.lang2], ['秋季菜单', '', false]);
    ctx.bcfSend(); await tick();
    assert.deepStrictEqual([writes[0].body.title_cn, writes[0].body.title_en, writes[0].body.body_en], ['秋季菜单', '', '']);
  });
  it('a city no saved address is in any more is dropped once the regions are known', async () => {
    const { ctx, CMD } = mk();
    ctx.DB.broadcasts = [ROW({ id: 2 })].map(ctx.mapBroadcast);
    CMD.bcAgain('2');
    assert.deepStrictEqual(plain(ctx.state.bcf.cities), ['城1', '旧城'], 'until the regions arrive');
    await tick();
    assert.deepStrictEqual(plain(ctx.state.bcf.cities), ['城1']);
  });
  it('a scheduled row is not sent again (it has not gone yet)', () => {
    const { ctx, CMD } = mk();
    ctx.DB.broadcasts = [ROW({ id: 1, status: 'scheduled' })].map(ctx.mapBroadcast);
    CMD.bcAgain('1');
    assert.strictEqual(ctx.state.stack.length, 0);
  });
}

section('5 · every region');
{
  it('all fifteen regions are offered, not the first twelve', () => {
    const { ctx } = mk({ regions: REGIONS });
    ctx.state.bcf.step = 2;
    const html = ctx.screenBcNew();
    assert.strictEqual((html.match(/APP\.cmd\('bcfCity',\d+\)/g) || []).length, 15);
    assert.ok(/City 14<\/span><span class="c">6</.test(html));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
