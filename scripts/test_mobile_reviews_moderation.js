#!/usr/bin/env node
/**
 * §325 M10 — REVIEWS ARE RUN FROM THE PHONE, AS THE DESKTOP'S REVIEWS TAB.
 *
 *   node scripts/test_mobile_reviews_moderation.js
 *
 * The phone's Inbox showed the newest thirty reviews and could answer or hide
 * one. The desktop's Reviews tab (07-content-billing.js) is the queue, the
 * filters, the bulk "handled", Put back, the seeded rows, and Set up: the
 * reward for reviewing, auto top-up and the review tags. This is that tab on
 * the phone, opened from the top of the Inbox's Reviews. Sliced out of
 * public/m.html and run in a sandbox (fast shard), with the real autosave
 * engine for the tags card. Pins every request (method, path, body), the
 * confirms, the empty / failed / refused cases and the keys.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const RVW_SRC = slice(MH, '/* ==========================================================================\n   §325 M10 — REVIEWS', '/* ==========================================================================\n   Sales — archetype');

const ROWS = () => [
  { id: 1, source: 'real', rating: 2, comment: 'Arrived warm', tags: ['fresh'], reply: '', is_visible: 1, product_name_en: 'Oat milk', product_name_cn: '燕麦奶', customer_name: 'Chen', created_at: '2026-09-28 10:00:00' },
  { id: 2, source: 'real', rating: 5, comment: '', tags: [], reply: 'Thanks!', is_visible: 1, product_name_en: 'Tofu', customer_name: 'Ling', created_at: '2026-09-27 10:00:00' },
  { id: 3, source: 'real', rating: 4, comment: 'Fine', tags: [], reply: '', dismissed_at: '2026-09-29 10:00:00', is_visible: 0, product_name_en: 'Tofu', customer_name: 'Wu', created_at: '2026-09-26 10:00:00' },
  { id: 9, source: 'synthetic', rating: 5, comment: 'Lovely', tags: [], reply: '', is_visible: 1, product_name_en: 'Tofu', customer_name: 'M**', created_at: '2026-09-25 10:00:00' },
];
const META = { total: 60, summary: { total: 60, needs_reply: 6, hidden: 1, low: 2, waiting_low: 2, seeded: 1, oldest_unanswered: null } };

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  let histSheet = null;
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T,
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { muted: ['m', 'M'] },
    chipRow: (items, cur, cmd) => items.map((c) => `<chip key="${c.key}" on="${c.key === cur}" cmd="${cmd}">${T(c.en, c.zh)}${c.count != null ? '(' + c.count + ')' : ''}</chip>`).join(''),
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    fmtDay: (d) => String(d || '').slice(0, 10),
    state: { caps: opts.caps === undefined ? ['reviews:view', 'reviews:moderate'] : opts.caps, ask: null, askErr: null, stack: [{ route: 'inbox' }],
      cfg: { reviews: { tags: [{ id: 'fresh', en: 'Fresh', cn: '新鲜', color: 'lime' }] } } },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    URLSearchParams,
    apiRaw: async (p) => { reads.push(p); if (opts.listFails) throw new Error('net'); return { success: true, data: opts.rows ? opts.rows(p) : ROWS(), meta: opts.meta || META }; },
    api: async (p) => {
      reads.push(p);
      if (p === '/reviews/reward') return opts.reward || { enabled: false, points: 20, max_per_order: 1, grants: 3, points_given: 60 };
      if (p === '/reviews/topup') return opts.topup || { enabled: false, min_reviews: 3, max_per_run: 50, available: true, products: 4, uncapped: 9, reviews: 9 };
      if (p.startsWith('/config/history')) return { success: true, versions: [] };
      return {};
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error(opts.writeFails); e.code = opts.writeFails; throw e; }
      if (p === '/reviews/dismiss-waiting') return { success: true, data: { dismissed: 6, low_rated: 2 } };
      if (p === '/reviews/topup/run') return { success: true, data: { added: 4 } };
      return { success: true, data: ctx.state.cfg };
    },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + RVW_SRC + '\nthis.RVW=RVW; this.screenReviews=screenReviews; this.card=(k)=>CFG_CARD[k]; this.rtagD=()=>RTAG_D;', ctx);
  return { ctx, CMD, writes, reads, toasts, hist: () => histSheet };
}
const opened = async (o) => { const m = mk(o); m.CMD.rvwOpen(); await tick(); return m; };
const yes = (ctx, vals) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(vals); };
const lastRead = (reads) => reads.filter((p) => p.startsWith('/reviews?')).pop();

section('1 · the queue and the list');
{
  it('opens on Needs reply, with the status line, the count, the chips with counts, search and the rating filter', async () => {
    const { ctx, reads } = await opened();
    assert.strictEqual(ctx.state.stack[ctx.state.stack.length - 1].route, 'reviews');
    assert.strictEqual(lastRead(reads), '/reviews?needs_reply=1&limit=50&offset=0');
    const html = ctx.screenReviews();
    assert.ok(html.includes('60 reviews · 6 waiting on a reply · 1 hidden'));
    assert.ok(html.includes('Mark all 6 as handled'));
    for (const c of ['Needs reply(6)', 'Everything(60)', 'Low rated(2)', 'Hidden(1)']) assert.ok(html.includes(c), c);
    assert.ok(html.includes('Search reviews and products…') && html.includes('Any rating'));
    assert.ok(!/on desktop|电脑端/.test(html));
  });
  it('a row: stars, the comment or what is missing, product · who · day, tag labels, marks, the reply or "handled"', async () => {
    const { ctx } = await opened();
    const html = ctx.screenReviews();
    assert.ok(html.includes('Arrived warm') && html.includes('Oat milk · Chen') && html.includes('>Fresh<'), 'the tag is shown by its label');
    assert.ok(html.includes('Low rated') && html.includes('Seeded') && html.includes('No comment'));
    assert.ok(html.includes('Thanks!') && html.includes('Handled — no reply sent') && /rvwUndismiss',3\)/.test(html));
    assert.ok(/rvwRemove',9\)/.test(html) && !/rvwRemove',1\)/.test(html), 'only a seeded row can be removed');
  });
  it('Everything groups the waiting ones first; filters, rating, search and pages go into the read', async () => {
    const { ctx, CMD, reads } = await opened();
    CMD.rvwFilter('all'); await tick();
    assert.strictEqual(lastRead(reads), '/reviews?limit=50&offset=0');
    const html = ctx.screenReviews();
    assert.ok(html.indexOf('Waiting on a reply') < html.indexOf('Arrived warm') && html.indexOf('Not waiting on you') < html.indexOf('Thanks!'));
    CMD.rvwFilter('low'); await tick();
    assert.strictEqual(lastRead(reads), '/reviews?low=1&limit=50&offset=0');
    CMD.rvwFilter('hidden'); CMD.rvwRating('2'); await tick();
    assert.strictEqual(lastRead(reads), '/reviews?visible=0&rating=2&limit=50&offset=0');
    CMD.rvwQ('oat'); await wait(300); await tick();
    assert.strictEqual(lastRead(reads), '/reviews?visible=0&rating=2&q=oat&limit=50&offset=0');
    CMD.rvwPage(1); await tick();
    assert.strictEqual(lastRead(reads), '/reviews?visible=0&rating=2&q=oat&limit=50&offset=50');
    assert.ok(ctx.screenReviews().includes('51–60 of 60'));
  });
  it('empty, no-match and failed lists say which', async () => {
    const e = await opened({ rows: () => [] });
    assert.ok(e.ctx.screenReviews().includes('Nothing waiting on a reply') && e.ctx.screenReviews().includes('Every customer review has an answer.'));
    e.CMD.rvwFilter('all'); await tick();
    assert.ok(e.ctx.screenReviews().includes('No reviews match'));
    const f = await opened({ listFails: true });
    assert.ok(f.ctx.screenReviews().includes('Could not load reviews'));
  });
}

section('2 · the writes, each on reviews:moderate');
{
  it('Mark all 6 as handled: asks, in red because two are low-rated, then sends the count it showed', async () => {
    const { ctx, CMD, writes, toasts } = await opened();
    CMD.rvwDismissAll();
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'Mark all 6 as handled?');
    assert.ok(a.body.includes('Nothing is sent to the customer') && a.body.includes('2 of them are rated 3 or less.'));
    assert.strictEqual(a.danger, true);
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/reviews/dismiss-waiting', method: 'POST', body: { expect: 6 } }]);
    assert.deepStrictEqual(toasts, ['6 marked as handled']);
  });
  it('a queue that moved is refused, said so, and nothing was marked', async () => {
    const { ctx, CMD } = await opened({ writeFails: 'queue_changed' });
    CMD.rvwDismissAll(); yes(ctx); await tick();
    assert.ok(ctx.screenReviews().includes('The queue changed — nothing was marked. Reloading.'));
  });
  it('Reply: the desktop\'s sheet, prefilled; blank removes it; unchanged sends nothing', async () => {
    const { ctx, CMD, writes, toasts } = await opened();
    CMD.rvwReply(2, 'real');
    const a = ctx.state.ask;
    assert.deepStrictEqual([a.title, a.body, a.confirmLabel, a.fields[0].value], ['Public reply', 'Customers see it under their review. Leave blank to remove.', 'Save reply', 'Thanks!']);
    yes(ctx, { reply: 'Thanks!' });
    assert.strictEqual(writes.length, 0);
    CMD.rvwReply(2, 'real'); yes(ctx, { reply: '' }); await tick();
    CMD.rvwReply(1, 'real'); yes(ctx, { reply: 'Sorry — refund on its way.' }); await tick();
    assert.deepStrictEqual(writes, [
      { p: '/reviews/2', method: 'PATCH', body: { reply: '', source: 'real' } },
      { p: '/reviews/1', method: 'PATCH', body: { reply: 'Sorry — refund on its way.', source: 'real' } }]);
    assert.deepStrictEqual(toasts, ['Reply removed', 'Reply saved']);
  });
  it('Hide asks; Restore does not; a seeded row\'s Remove asks and deletes with ?source=synthetic; Put back', async () => {
    const { ctx, CMD, writes } = await opened();
    CMD.rvwVisible(1, 'real');
    assert.strictEqual(ctx.state.ask.title, 'Hide this review?');
    yes(ctx); await tick();
    CMD.rvwVisible(3, 'real'); await tick();
    CMD.rvwRemove(9);
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel], ['Remove this seeded review for good?', 'Remove review']);
    yes(ctx); await tick();
    CMD.rvwUndismiss(3); await tick();
    assert.deepStrictEqual(plain(writes), [
      { p: '/reviews/1', method: 'PATCH', body: { is_visible: false, source: 'real' } },
      { p: '/reviews/3', method: 'PATCH', body: { is_visible: true, source: 'real' } },
      { p: '/reviews/9?source=synthetic', method: 'DELETE', body: {} },
      { p: '/reviews/3/undismiss', method: 'POST', body: {} }]);
  });
  it('a refused write stays above the list, in the server\'s words', async () => {
    const { ctx, CMD } = await opened({ writeFails: 'x' });
    CMD.rvwVisible(3, 'real'); await tick();
    assert.ok(ctx.screenReviews().includes('That did not save. Nothing has changed.'));
    assert.strictEqual(ctx.RVW.busy, null);
  });
}

section('3 · Set up');
{
  it('Reward reviewers: the switch saves the three fields; the numbers are held to the desktop\'s ranges', async () => {
    const { ctx, CMD, writes, toasts } = await opened();
    const html = ctx.screenReviews();
    assert.ok(html.includes('Set up') && html.includes('Points per review: 20') && html.includes('3 rewarded · 60 points given'));
    CMD.rvwRewardToggle(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/config', method: 'PUT', body: { 'reviews.reward': { enabled: true, points: 20, max_per_order: 1 } } }]);
    assert.ok(ctx.screenReviews().includes('On. The mini app needs a republish before shoppers are told about it.'));
    assert.deepStrictEqual(toasts, ['Saved']);
    CMD.rvwRewardEdit();
    assert.strictEqual(ctx.state.ask.validate({ points: '20000', max: '1' }), 'Points must be 0–10000');
    assert.strictEqual(ctx.state.ask.validate({ points: '5', max: '99' }), 'Per-order cap must be 1–50');
    yes(ctx, { points: '30', max: '2' }); await tick();
    assert.deepStrictEqual(writes[1].body, { 'reviews.reward': { enabled: false, points: 30, max_per_order: 2 } });
  });
  it('Auto top-up: turning it on asks, naming the line; off does not; Run now runs one sweep', async () => {
    const { ctx, CMD, writes, toasts } = await opened();
    assert.ok(ctx.screenReviews().includes('4 products below 3 — would add 9 reviews') && ctx.screenReviews().includes('These are seeded reviews, not customer ones'));
    CMD.rvwTopupToggle();
    assert.ok(ctx.state.ask.title.startsWith('Turn on auto top-up? Every published product below 3 reviews'));
    assert.strictEqual(writes.length, 0);
    yes(ctx); await tick();
    assert.deepStrictEqual(writes[0], { p: '/config', method: 'PUT', body: { 'reviews.topup': { enabled: true, min_reviews: 3, max_per_run: 50 } } });
    CMD.rvwTopupEdit();
    assert.strictEqual(ctx.state.ask.validate({ min: '30', max: '5' }), 'Minimum must be 1–20');
    ctx.state.ask = null;
    CMD.rvwTopupRun(); await tick();
    assert.deepStrictEqual(writes[1], { p: '/reviews/topup/run', method: 'POST', body: {} });
    assert.ok(toasts.includes('Added 4 reviews'));
    const on = await opened({ topup: { enabled: true, min_reviews: 3, max_per_run: 50, available: true, products: 0 } });
    on.CMD.rvwTopupToggle(); await tick();
    assert.strictEqual(on.ctx.state.ask, null, 'turning it off does not ask');
    assert.deepStrictEqual(on.writes[0].body, { 'reviews.topup': { enabled: false, min_reviews: 3, max_per_run: 50 } });
  });
  it('Review tags: a §279 card on PUT /config?history=reviews.tags, held while an id is missing, removing a used id asks', async () => {
    const { ctx, CMD, writes } = await opened();
    const html = ctx.screenReviews();
    assert.ok(/rtagEdit',0\)/.test(html) && html.includes('fresh · lime') && /cardHistory','reviews\.tags'/.test(html));
    CMD.rtagAdd();
    await ctx.state.ask.live.auto.flush();
    assert.strictEqual(writes.length, 0, 'held: a tag with no id');
    assert.ok(/Every tag needs an id/.test(ctx.card('reviews.tags').auto.message));
    ctx.state.ask.live.set('id', 'Too Sweet!'); ctx.state.ask.live.set('en', 'Too sweet'); ctx.state.ask.live.auto.touch();
    await ctx.state.ask.live.auto.flush();
    assert.deepStrictEqual(writes[0], { p: '/config?history=reviews.tags', method: 'PUT', body: { 'reviews.tags': [
      { id: 'fresh', en: 'Fresh', cn: '新鲜', color: 'lime' }, { id: 'too-sweet', en: 'Too sweet', cn: '', color: 'lime' }] } });
    CMD.rtagEdit(0);
    ctx.state.ask.live.acts.find((x) => x.key === 'rm').run();
    assert.ok(ctx.state.ask.title.startsWith('Remove "fresh"? Reviews already tagged with this id will lose that chip.'));
    yes(ctx);
    assert.deepStrictEqual(plain(ctx.rtagD().map((t) => t.id)), ['too-sweet']);
  });
}

section('4 · the keys');
{
  it('reviews:view only: the list and Set up\'s settings, but no row writes, no bulk, no Run now', async () => {
    const { ctx, CMD, writes } = await opened({ caps: ['reviews:view'] });
    const html = ctx.screenReviews();
    assert.ok(html.includes('Arrived warm'));
    assert.ok(!/rvwDismissAll|rvwReply|rvwVisible|rvwRemove|rvwUndismiss|rvwTopupRun/.test(html));
    assert.ok(/rvwRewardToggle/.test(html), 'the reward and top-up settings are the reviews family, which view may write');
    CMD.rvwDismissAll(); CMD.rvwReply(1, 'real'); CMD.rvwVisible(1, 'real'); CMD.rvwRemove(9); CMD.rvwUndismiss(3); CMD.rvwTopupRun();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
  });
  it('neither key: the screen does not open', () => {
    const { ctx, CMD } = mk({ caps: ['feedback:view'] });
    CMD.rvwOpen();
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.ok(/reviews:\['reviews:view','reviews:moderate'\]/.test(MH), 'the route opens on the reviews family\'s keys');
    assert.ok(MH.includes("${seg==='reviews'&&mCan(RVW_KEYS)?`<button class=\"card\" onclick=\"APP.cmd('rvwOpen')\""), 'the Inbox door is drawn for them only');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
