#!/usr/bin/env node
/**
 * §325 M8 — SOCIAL PROOF IS SET ON THE PHONE, AND SAVES ITSELF.
 *
 *   node scripts/test_mobile_social_proof.js
 *
 * The phone's Social proof screen had the one switch and a note: "What counts
 * as recent, and which products show it, are set on desktop." It now carries
 * the desktop tab's two §279 cards (05-marketing.js SOCIAL_CARD and
 * UPSELL_CARD) on PUT /config: 'social_proof' — the five widgets and the
 * manual buyers, as one nested blob built the way buildSocialProof builds it —
 * and 'checkout.upsell'. Sliced out of public/m.html and run in a sandbox
 * (fast shard), with the real autosave engine. Pins:
 *   1. the screen, in the desktop's words, with no "set on desktop";
 *   2. what is sent: the whole blob, the desktop's defaults, legacy boosts,
 *      clamps and swapped ranges; the manual entries, blanks dropped;
 *   3. the upsell card;
 *   4. history, refusals, and nothing without social:edit.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
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
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const SP_SRC = slice(MH, '/* ==========================================================================\n   §325 M8 — SOCIAL PROOF', "/* Meituan's health");

const DEFAULTS = {
  bought_count: { enabled: true, min_today: 2, min_week: 2, min_month: 1, min_all: 2, boost_min: 0, boost_max: 0 },
  recent_buyers: { enabled: true, window_days: 7, visible_secs: 4.5, gap_secs: 5, manual: [] },
  viewing_now: { enabled: true, show_in_app: true, ttl_sec: 45, boost_min: 0, boost_max: 0 },
  last_ordered: { enabled: true, max_hours: 24, fallback_min_minutes: 0, fallback_max_minutes: 0 },
  sold_badge: { enabled: true, min_units: 3, boost_min: 0, boost_max: 0 },
};

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  let histSheet = null;
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T,
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    featOn: () => true,
    state: { cfg: opts.cfg === undefined ? {} : opts.cfg, caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null, featBusy: null, featErr: null },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error('Your role cannot change social proof.'); e.refused = true; throw e; }
      return { success: true, data: ctx.state.cfg };
    },
    api: async (p) => { reads.push(p); return opts.history || { success: true, versions: [] }; },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + SP_SRC + '\nthis.card=(k)=>CFG_CARD[k]; this.spD=()=>SP_D; this.upD=()=>UP_D; this.SP_W=SP_W; this.cardFootHtml=cardFootHtml; this.screenSocial=screenSocial;', ctx);
  return { ctx, CMD, writes, reads, toasts, hist: () => histSheet };
}
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;
const flush = (ctx, k) => ctx.card(k).auto.flush();

section('1 · the screen');
{
  it('the switch, the upsell card, the five widgets, the manual entries and the foot; no "set on desktop"', () => {
    const { ctx } = mk();
    const html = ctx.screenSocial();
    for (const w of ['Checkout upsell pop-up', 'Show the checkout upsell pop-up', 'Bundles ("buy together")', 'Linked extras', 'Flash sales (active deals)', 'Max items shown: 4',
      '"N people bought this" — product page', 'Recent-buyers ticker — home', '"N viewing now" — product page', '"Last ordered X ago" — product page', '"X SOLD" badge — shop & home cards',
      'Show this widget', 'Show the ticker', 'Track viewer counts (powers the dashboard LIVE pane)', 'Also show the "N viewing now" badge to customers', 'Show "last ordered"', 'Show "X SOLD" badges',
      'Manual fake entries', 'No fake entries yet.', '+ Add fake entry', 'Min today: 2']) assert.ok(html.includes(esc(w)), w);
    assert.ok(/APP\.cmd\('cardHistory','social_proof'\)/.test(html) && /APP\.cmd\('cardHistory','checkout\.upsell'\)/.test(html));
    assert.ok(html.includes('cmd="APP.cmd(\'toggleFeature\',\'socialProof\')"'), 'the feature switch stays');
    assert.ok(!/on desktop|电脑端/.test(html));
  });
  it('every label is the desktop\'s own pair, word for word', () => {
    const { ctx } = mk();
    const pairs = [];
    for (const w of ctx.SP_W) { pairs.push(w[1], w[3]); for (const [, lab] of w[4]) pairs.push(lab); }
    for (const [en, cn] of pairs) {
      const fused = en.replace(/&/g, '&amp;') + ' · ' + cn;
      assert.ok(ADMIN.includes(fused), fused);
    }
  });
}

section('2 · what is sent');
{
  it('a shop with nothing stored: the desktop\'s defaults, sent whole on PUT /config?history=social_proof', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenSocial();
    CMD.spToggle('sb', 'enabled');
    await flush(ctx, 'social_proof');
    assert.deepStrictEqual(writes, [{ p: '/config?history=social_proof', method: 'PUT',
      body: { social_proof: Object.assign(plain(DEFAULTS), { sold_badge: Object.assign({}, DEFAULTS.sold_badge, { enabled: false }) }) } }]);
  });
  it('old single boosts fill both ends of a range; a range typed backwards is swapped; the desktop\'s clamps', async () => {
    const { ctx, CMD, writes } = mk({ cfg: { social_proof: { bought_count: { boost: 12 }, last_ordered: { fallback_minutes: 30 } } } });
    ctx.screenSocial();
    assert.deepStrictEqual(plain([ctx.spD().bc.boost_min, ctx.spD().bc.boost_max, ctx.spD().lo.fallback_min_minutes]), ['12', '12', '30']);
    CMD.spEdit('vn');
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => [f.id, f.type])), [['ttl_sec', 'number'], ['boost_min', 'number'], ['boost_max', 'number']]);
    live(ctx).set('boost_min', '40'); live(ctx).set('boost_max', '15'); live(ctx).set('ttl_sec', '1');
    CMD.spEdit('rb');
    live(ctx).set('window_days', '99'); live(ctx).set('visible_secs', '0.1');
    CMD.spEdit('lo');
    live(ctx).set('fallback_max_minutes', '5000');
    live(ctx).auto.touch();
    await live(ctx).auto.flush();
    const b = writes[0].body.social_proof;
    assert.deepStrictEqual([b.viewing_now.boost_min, b.viewing_now.boost_max, b.viewing_now.ttl_sec], [15, 40, 5]);
    assert.deepStrictEqual([b.recent_buyers.window_days, b.recent_buyers.visible_secs], [60, 0.5]);
    assert.deepStrictEqual([b.last_ordered.fallback_min_minutes, b.last_ordered.fallback_max_minutes], [30, 1440]);
    assert.deepStrictEqual([b.bought_count.boost_min, b.bought_count.boost_max], [12, 12]);
  });
  it('the viewing-now badge has its own switch', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenSocial();
    CMD.spToggle('vn', 'show_in_app');
    CMD.spToggle('bc', 'show_in_app');   // not a switch the desktop has
    await flush(ctx, 'social_proof');
    assert.strictEqual(writes[0].body.social_proof.viewing_now.show_in_app, false);
    assert.ok(!('show_in_app' in writes[0].body.social_proof.bought_count));
  });
  it('manual entries: added at 5 minutes, typed in a sheet, blanks left out of the save, removed', async () => {
    const { ctx, CMD, writes } = mk({ cfg: { social_proof: { recent_buyers: { manual: [{ name: 'L**', product_en: 'Oat milk', product_cn: '燕麦奶', minutes_ago: 12 }] } } } });
    let html = ctx.screenSocial();
    assert.ok(/APP\.cmd\('spMan',0\)/.test(html) && html.includes('L** · Oat milk') && html.includes('12 min ago'));
    CMD.spManAdd();
    const a = ctx.state.ask;
    assert.deepStrictEqual(plain(a.fields.map((f) => [f.id, f.label])), [['name', 'Masked name, e.g. W**'], ['product_en', 'Product (English)'], ['product_cn', 'Product (Chinese)'], ['minutes_ago', 'min ago']]);
    assert.strictEqual(live(ctx).get('minutes_ago'), 5);
    await live(ctx).auto.flush();
    assert.strictEqual(writes.length, 0, 'a blank row is not part of the save, so nothing changed');
    live(ctx).set('name', ' W** '); live(ctx).set('product_cn', '豆浆'); live(ctx).set('minutes_ago', '9'); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.deepStrictEqual(plain(writes[0].body.social_proof.recent_buyers.manual), [{ name: 'L**', product_en: 'Oat milk', product_cn: '燕麦奶', minutes_ago: 12 },
      { name: 'W**', product_en: '', product_cn: '豆浆', minutes_ago: 9 }]);
    CMD.spManAdd(); ctx.state.ask = null;
    CMD.spMan(0);
    ctx.state.ask.live.acts.find((x) => x.key === 'rm').run();
    await flush(ctx, 'social_proof');
    assert.deepStrictEqual(plain(writes[1].body.social_proof.recent_buyers.manual.map((m) => m.name)), ['W**'], 'removed, and the blank third row still not sent');
    html = ctx.screenSocial();
    assert.ok(!html.includes('L**'));
  });
}

section('3 · the checkout upsell card');
{
  it('its switches and its maximum, sent as checkout.upsell with the desktop\'s 1–6 clamp', async () => {
    const { ctx, CMD, writes } = mk({ cfg: { checkout: { upsell: { enabled: true, flash: true, max: 3 } } } });
    ctx.screenSocial();
    CMD.upToggle('flash');
    CMD.upToggle('nonsense');
    await flush(ctx, 'checkout.upsell');
    assert.deepStrictEqual(writes, [{ p: '/config?history=checkout.upsell', method: 'PUT', body: { 'checkout.upsell': { enabled: true, bundles: true, extras: true, flash: false, max: 3 } } }]);
    CMD.upMax();
    live(ctx).set('max', '9'); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.strictEqual(writes[1].body['checkout.upsell'].max, 6);
  });
}

section('4 · history, refusals, the key');
{
  it('Version history restores the stored blob, as a restore', async () => {
    const snap = { social_proof: Object.assign(plain(DEFAULTS), { sold_badge: { enabled: false, min_units: 7, boost_min: 1, boost_max: 2 } }) };
    const versions = [{ id: 1, at: 'x', changed: ['social_proof'], snapshot: snap }];
    const { ctx, CMD, writes, reads, hist } = mk({ history: { success: true, versions } });
    ctx.screenSocial();
    CMD.cardHistory('social_proof'); await tick();
    assert.ok(reads.includes('/config/history?card=social_proof'));
    assert.strictEqual(hist().sub(versions[0]), 'Social proof');
    await hist().restore(versions[0]);
    const w = writes[writes.length - 1];
    assert.strictEqual(w.p, '/config?history=social_proof&note=restore');
    assert.deepStrictEqual(w.body.social_proof.sold_badge, { enabled: false, min_units: 7, boost_min: 1, boost_max: 2 });
  });
  it('a refusal stays in the foot and is never a toast', async () => {
    const { ctx, CMD, toasts } = mk({ writeFails: true });
    ctx.screenSocial();
    CMD.spToggle('bc', 'enabled');
    await flush(ctx, 'social_proof');
    assert.ok(/Save failed: Your role cannot change social proof\./.test(ctx.cardFootHtml(ctx.card('social_proof'))));
    assert.deepStrictEqual(toasts, []);
  });
  it('before the settings arrive: loading, nothing started', () => {
    const { ctx } = mk({ cfg: null });
    assert.ok(ctx.screenSocial().includes('Loading…'));
    assert.ok(!ctx.card('social_proof'));
  });
  it('without social:edit: no settings drawn, no card started, the commands do nothing', () => {
    const { ctx, CMD, writes } = mk({ caps: ['orders:view'] });
    const html = ctx.screenSocial();
    assert.ok(!/spToggle|spEdit|spMan|upToggle|upMax|cardHistory/.test(html));
    assert.ok(!ctx.card('social_proof') && !ctx.card('checkout.upsell'));
    CMD.spToggle('bc', 'enabled'); CMD.spEdit('bc'); CMD.spManAdd(); CMD.spMan(0); CMD.upToggle('flash'); CMD.upMax();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
    assert.ok(/social:'social:edit'/.test(MH), 'the screen opens on social:edit');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
