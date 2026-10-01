#!/usr/bin/env node
/**
 * §325 M7 — THE LEADERBOARD'S SETTINGS ARE SET ON THE PHONE, AND SAVE THEMSELVES.
 *
 *   node scripts/test_mobile_leaderboard_settings.js
 *
 * The phone showed the board and a note: "Metric, period, rewards and who is
 * hidden are set on desktop." It now carries the desktop's card (10-extras.js
 * LB_CARD): every field lbReadForm sends, as one §279 card ('leaderboard') on
 * PUT /leaderboard/config?history=leaderboard, the desktop's placeholder
 * generator, and history read from snapshot['leaderboard.config']. Sliced out
 * of public/m.html and run in a sandbox (fast shard), with the real autosave
 * engine. Pins:
 *   1. the card starts only once the stored board has arrived, and the screen
 *      draws the desktop's sections;
 *   2. what it sends: the whole board, top_n a number, hide_names a list;
 *   3. the placeholder generator: the desktop's count, top, curve and names;
 *   4. history, refusals, the failed read, and no settings without the key.
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
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const LB_SRC = slice(MH, '/* ── Leaderboard ───', '/* ==========================================================================\n   Categories — the shop\'s shelves');
const WEST = slice(MH, 'const LB_SEED_NAMES_WEST=[', '];');
const D_WEST = (() => { const D = fs.readFileSync(path.join(ROOT, 'public/retail-admin/10-extras.js'), 'utf8'); return [D, slice(D, 'const LB_SEED_NAMES_WEST = [', '];'), slice(D, 'const LB_SEED_NAMES_CN = [', '];')]; })();

const STORED = {
  enabled: true, title_en: 'Top growers', title_cn: '排行榜', kicker_en: 'ROOTS CLUB', kicker_cn: 'ROOTS 会员', subhead_en: 'Our best', subhead_cn: '最佳',
  metric: 'lifetime_spend', period: 'all', top_n: 20, reveal_mode: 'first_char',
  reward_top1_en: '¥500 credit', reward_top1_cn: '¥500 储值', reward_top3_en: '', reward_top3_cn: '', reward_top10_en: '', reward_top10_cn: '',
  seed_enabled: false, seed_entries: [], hide_names: ['mimi', 'asher'],
};
const PREVIEW = { config: STORED, revealed_entries: [{ rank: 1, name: 'C***', value: 6240 }] };

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  let histSheet = null;
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, CUR: '¥',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { success: ['g', 'G'], muted: ['m', 'M'] },
    money0: (c, n) => c + Math.round(Number(n) || 0),
    noteBar: (t) => `<note>${t}</note>`,
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    state: { lb: opts.preview === undefined ? plain(PREVIEW) : opts.preview, lbTried: true, lbErr: null,
      caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error('Your role cannot change the leaderboard.'); e.refused = true; throw e; }
      return { success: true, data: body };
    },
    api: async (p) => {
      reads.push(p);
      if (p === '/leaderboard/config') { if (opts.cfgFails) throw new Error('network'); return plain(opts.stored || STORED); }
      if (p === '/leaderboard/preview') return plain(PREVIEW);
      if (p.startsWith('/config/history')) return opts.history || { success: true, versions: [] };
      return {};
    },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + LB_SRC + '\nthis.lbD=()=>LB_D; this.lbErr=()=>LB_ERR; this.card=(k)=>CFG_CARD[k]; this.cfgFootHtml=cfgFootHtml; this.lbSeedEntries=lbSeedEntries;' +
    ' this.WEST=LB_SEED_NAMES_WEST; this.CN=LB_SEED_NAMES_CN; this.screenLeaderboard=screenLeaderboard;', ctx);
  return { ctx, CMD, writes, reads, toasts, hist: () => histSheet };
}
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;
const started = async (o) => { const m = mk(o); m.ctx.screenLeaderboard(); await tick(); return m; };
const FULL = (over) => Object.assign({
  enabled: true, title_en: 'Top growers', title_cn: '排行榜', kicker_en: 'ROOTS CLUB', kicker_cn: 'ROOTS 会员', subhead_en: 'Our best', subhead_cn: '最佳',
  metric: 'lifetime_spend', period: 'all', top_n: 20, reveal_mode: 'first_char',
  reward_top1_en: '¥500 credit', reward_top1_cn: '¥500 储值', reward_top3_en: '', reward_top3_cn: '', reward_top10_en: '', reward_top10_cn: '',
  seed_enabled: false, seed_entries: [], hide_names: ['mimi', 'asher'],
}, over);

section('1 · the card and the screen');
{
  it('reads /leaderboard/config, then starts; the desktop\'s sections are drawn and the desktop note is gone', async () => {
    const { ctx, reads } = await started();
    assert.ok(reads.includes('/leaderboard/config'));
    assert.ok(ctx.card('leaderboard').auto, 'started');
    const html = ctx.screenLeaderboard();
    for (const w of ['Visibility', 'When off, the mini-app menu entry stays hidden and the API returns 404.', 'Headline copy', 'Ranking rules', 'Rewards (optional)',
      'Placeholder board (temporary)', 'Show placeholder members', 'No placeholder members yet.', 'Generate placeholder members', 'Hide these real members', 'mimi, asher',
      'Top 1 reward: ¥500 credit', 'Lifetime spend (¥) · All time · Show top 20 · First character + asterisks (recommended)']) assert.ok(html.includes(w), w);
    assert.ok(html.includes('cmd="APP.cmd(\'lbToggle\',\'enabled\')"') && html.includes('cmd="APP.cmd(\'lbToggle\',\'seed_enabled\')"'));
    assert.ok(/APP\.cmd\('cfgHistory','leaderboard'\)/.test(html));
    assert.ok(!/on desktop|电脑端/.test(html));
  });
  it('the board still reads the server\'s preview; an empty one says so', async () => {
    const { ctx } = await started();
    assert.ok(ctx.screenLeaderboard().includes('C***'));
    const e = await started({ preview: { config: STORED, revealed_entries: [] } });
    assert.ok(e.ctx.screenLeaderboard().includes('Nobody is on the board yet.'));
  });
}

section('2 · what it sends');
{
  it('the visibility switch sends the whole board, as lbReadForm builds it', async () => {
    const { ctx, CMD, writes } = await started();
    CMD.lbToggle('enabled');
    await ctx.card('leaderboard').auto.flush();
    assert.deepStrictEqual(writes, [{ p: '/leaderboard/config?history=leaderboard', method: 'PUT', body: FULL({ enabled: false }) }]);
    assert.ok(ctx.screenLeaderboard().includes('>Off<'), 'the head follows the draft');
  });
  it('Ranking rules: the desktop\'s choices; top_n goes as a number; points balance carries its note', async () => {
    const { ctx, CMD, writes } = await started();
    CMD.lbEdit('rank');
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'Ranking rules');
    assert.deepStrictEqual(plain(a.fields.map((f) => f.id)), ['metric', 'period', 'top_n', 'reveal_mode']);
    assert.deepStrictEqual(plain(a.fields[0].choices), [['lifetime_spend', 'Lifetime spend (¥)'], ['points_balance', 'Points balance'], ['orders_count', 'Paid orders count']]);
    assert.deepStrictEqual(plain(a.fields[1].choices.map((c) => c[0])), ['all', 'year', 'month', 'week']);
    assert.deepStrictEqual(plain(a.fields[3].choices.map((c) => c[0])), ['first_char', 'full', 'masked']);
    live(ctx).set('metric', 'points_balance'); live(ctx).set('top_n', '35'); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.deepStrictEqual([writes[0].body.metric, writes[0].body.top_n], ['points_balance', 35]);
    ctx.state.ask = null;
    assert.ok(ctx.screenLeaderboard().includes('Note: points-balance metric is point-in-time. Period selector is ignored for this metric.'));
  });
  it('Headline copy and Rewards: each desktop field, labelled by the language it is typed in', async () => {
    const { ctx, CMD, writes } = await started();
    CMD.lbEdit('copy');
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => [f.id, f.label])), [['kicker_en', 'Kicker · EN'], ['kicker_cn', 'Kicker · 中文'],
      ['title_en', 'Title · EN'], ['title_cn', 'Title · 中文'], ['subhead_en', 'Subhead · EN'], ['subhead_cn', 'Subhead · 中文']]);
    live(ctx).set('title_cn', '会员榜'); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.strictEqual(writes[0].body.title_cn, '会员榜');
    CMD.lbEdit('rewards');
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => f.id)), ['reward_top1_en', 'reward_top1_cn', 'reward_top3_en', 'reward_top3_cn', 'reward_top10_en', 'reward_top10_cn']);
  });
  it('hidden members: typed with commas or lines, sent as a list', async () => {
    const { ctx, CMD, writes } = await started();
    CMD.lbEdit('hide');
    assert.strictEqual(live(ctx).get('hide_names'), 'mimi, asher');
    live(ctx).set('hide_names', ' mimi , asher\nsteve,, '); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.deepStrictEqual(writes[0].body.hide_names, ['mimi', 'asher', 'steve']);
  });
  it('after a save the board underneath is read again', async () => {
    const { ctx, CMD, reads } = await started();
    const before = reads.filter((p) => p === '/leaderboard/preview').length;
    CMD.lbToggle('seed_enabled');
    await ctx.card('leaderboard').auto.flush(); await tick();
    assert.strictEqual(reads.filter((p) => p === '/leaderboard/preview').length, before + 1);
  });
}

section('3 · the placeholder board: the desktop\'s generator');
{
  it('the name pools are the desktop\'s, word for word', () => {
    const { ctx } = mk();
    const [, dW, dC] = D_WEST;
    const parse = (s) => (s.match(/'([^']+)'/g) || []).map((x) => x.slice(1, -1));
    assert.deepStrictEqual(plain(ctx.WEST), parse(dW));
    assert.deepStrictEqual(plain(ctx.CN), parse(dC));
    assert.ok(WEST.length > 0);
  });
  it('the ask: Top spender and How many members, 3000 and 18 to start; generating switches it on and saves', async () => {
    const { ctx, CMD, writes, toasts } = await started();
    CMD.lbSeedAsk();
    const a = ctx.state.ask;
    assert.strictEqual(a.confirmLabel, 'Generate placeholder members');
    assert.deepStrictEqual(plain(a.fields.map((f) => [f.id, f.label, f.value])), [['max', 'Top spender (¥)', '3000'], ['count', 'How many members', '18']]);
    ctx.state.ask = null;
    a.run({ max: '2000', count: '10' });
    await ctx.card('leaderboard').auto.flush();
    const b = writes[0].body;
    assert.strictEqual(b.seed_enabled, true);
    assert.strictEqual(b.seed_entries.length, 10);
    assert.strictEqual(b.seed_entries[0].value, 2000, 'the exact top asked for');
    for (let i = 1; i < 10; i++) assert.ok(b.seed_entries[i].value < b.seed_entries[i - 1].value, 'strictly decreasing');
    assert.strictEqual(b.seed_entries.filter((s) => ctx.WEST.includes(s.name)).length, 7, '70% Western');
    assert.deepStrictEqual(Object.keys(b.seed_entries[0]).sort(), ['name', 'tier_key', 'value']);
    assert.deepStrictEqual(toasts, ['Placeholder members generated']);
    assert.ok(ctx.screenLeaderboard().includes('10 members · ¥2000 → '));
  });
  it('the desktop\'s bounds: 3 to 50 members, a top of at least 50', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.lbSeedEntries('3000', '99').length, 50);
    assert.strictEqual(ctx.lbSeedEntries('3000', '1').length, 3);
    assert.strictEqual(ctx.lbSeedEntries('10', '5')[0].value, 50);
    assert.strictEqual(ctx.lbSeedEntries('', '')[0].value, 3000);
    assert.strictEqual(ctx.lbSeedEntries('', '').length, 18);
  });
}

section('4 · history, refusals, the failed read, the key');
{
  it('Version history reads card=leaderboard and restores snapshot[\'leaderboard.config\'] as a restore', async () => {
    const versions = [{ id: 3, at: 'x', changed: ['leaderboard.config'], snapshot: { 'leaderboard.config': Object.assign(plain(STORED), { enabled: false, hide_names: ['old'] }) } }];
    const { CMD, writes, reads, hist } = await started({ history: { success: true, versions } });
    CMD.cfgHistory('leaderboard'); await tick();
    assert.ok(reads.includes('/config/history?card=leaderboard'));
    assert.strictEqual(hist().sub(versions[0]), 'Leaderboard');
    await hist().restore(versions[0]);
    const w = writes[writes.length - 1];
    assert.strictEqual(w.p, '/leaderboard/config?history=leaderboard&note=restore');
    assert.deepStrictEqual(w.body, FULL({ enabled: false, hide_names: ['old'] }));
  });
  it('Undo goes back to the visit\'s start, filed as an undo', async () => {
    const { ctx, CMD, writes } = await started();
    CMD.lbToggle('enabled');
    await ctx.card('leaderboard').auto.flush();
    CMD.cfgUndo('leaderboard'); await tick();
    assert.strictEqual(writes[1].p, '/leaderboard/config?history=leaderboard&note=undo');
    assert.strictEqual(writes[1].body.enabled, true);
  });
  it('a refusal stays in the foot and is never a toast', async () => {
    const { ctx, CMD, toasts } = await started({ writeFails: true });
    CMD.lbToggle('enabled');
    await ctx.card('leaderboard').auto.flush();
    assert.ok(/Save failed: Your role cannot change the leaderboard\./.test(ctx.cfgFootHtml(ctx.card('leaderboard'))));
    assert.deepStrictEqual(toasts, []);
  });
  it('if the stored board does not arrive: the desktop\'s words, no card, nothing writes', async () => {
    const { ctx, CMD, writes } = await started({ cfgFails: true });
    assert.strictEqual(String(ctx.lbErr()), 'Failed to load leaderboard config');
    assert.ok(!ctx.card('leaderboard'));
    assert.ok(ctx.screenLeaderboard().includes('Failed to load leaderboard config'));
    CMD.lbToggle('enabled'); CMD.lbEdit('rank'); CMD.lbSeedAsk();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
  });
  it('without leaderboard:edit: the board, and no settings; the commands do nothing', async () => {
    const { ctx, CMD, writes } = await started({ caps: ['orders:view'] });
    const html = ctx.screenLeaderboard();
    assert.ok(html.includes('C***'));
    assert.ok(!/lbToggle|lbEdit|lbSeedAsk|cfgHistory/.test(html));
    CMD.lbToggle('enabled'); CMD.lbEdit('copy'); CMD.lbSeedAsk();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
    assert.ok(/leaderboard:'leaderboard:edit'/.test(MH), 'the screen opens on leaderboard:edit');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
