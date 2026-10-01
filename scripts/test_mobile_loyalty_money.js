#!/usr/bin/env node
/**
 * §325 M11 — THE LOYALTY PROGRAMME'S MONEY IS SET ON THE PHONE, EACH WITH ITS OWN SAVE.
 *
 *   node scripts/test_mobile_loyalty_money.js
 *
 * Thresholds, multipliers, perks, the points rules and the top-up packages
 * were "edited on desktop". Each decides what a customer is given, so under
 * §279.2 none saves itself: a draft, then an explicit Save, with the desktop's
 * body (07-content-billing.js savePointsSettings, saveRctiers, the top-up
 * packages table), its holds (a tier key from the English name and unique; at
 * least one tier; the lowest at 0), its confirms, and a leave guard. All fail
 * CLOSED while the account's keys are unknown. Sliced out of public/m.html and
 * run in a sandbox (fast shard).
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

const SRC = slice(MH, '/* ==========================================================================\n   Membership, Top-up and Leaderboard', '/* ── Leaderboard ──');

const TIERS = () => [
  { key: 'seed', name_en: 'Seed', name_cn: '种子', threshold: 0, points_mult: 1, perks_en: ['Newsletter'], perks_cn: [] },
  { key: 'tree', name_en: 'Tree', name_cn: '大树', threshold: 5000, points_mult: 2, perks_en: [], perks_cn: [] },
];
const PKGS = () => [{ id: 1, amount: 200, bonus_points: 20, title_en: 'Starter', title_cn: '入门', is_active: 1 }, { id: 2, amount: 500, bonus_points: 0, is_active: 0 }];

function mk(opts = {}) {
  const writes = [], toasts = [], CMD = {};
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, CUR: '¥',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>', PILL: { success: ['g', 'G'], clear: ['c', 'C'], muted: ['m', 'M'] },
    money: (c, n) => { const v = Number(n || 0); return c + (v % 1 ? v.toFixed(2) : String(v)); },
    money0: (c, n) => c + Math.round(Number(n || 0)).toLocaleString('en-US'),
    nothingYet: (a, b) => `<empty>${a}|${b}</empty>`, noteBar: (t) => `<note>${t}</note>`,
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    fmtDay: (d) => String(d || '').slice(0, 10), payLabel: () => ['WeChat', '微信'],
    state: { caps: opts.caps === undefined ? ['loyalty:view', 'topup:edit'] : opts.caps, ask: null, askErr: null, stack: [{ route: 'membership' }],
      cfg: opts.cfg === undefined ? { points: { earnPoints: 1, earnSpend: 100, earnBase: 'paid', redeemRate: 100, expiryMonths: 12, coverShipping: false } } : opts.cfg,
      tiersTried: true, tiers: opts.tiers === undefined ? TIERS() : opts.tiers, tierCounts: null, tiersErr: null,
      tupTried: true, tup: [], tupPkgs: PKGS(), tupErr: null, tupBusy: null },
    render: () => {}, forgetScroll: () => {},
    CMD, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    api: async (p) => { if (p === '/topup-packages') { if (opts.pkgsFail) throw new Error('net'); return PKGS(); } return {}; },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error(opts.writeFails); e.code = opts.writeFails; throw e; }
      return { success: true, data: Object.assign({}, ctx.state.cfg) };
    },
    document: { getElementById: () => null },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Infinity, setTimeout, clearTimeout, parseInt, parseFloat,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.PR=PR; this.TE=TE; this.TP=TP; this.screenMembership=screenMembership; this.screenPointsRules=screenPointsRules;' +
    ' this.screenTiersEdit=screenTiersEdit; this.screenTopups=screenTopups; this.screenTupPkgs=screenTupPkgs; this.prMayLeave=prMayLeave; this.teMayLeave=teMayLeave;', ctx);
  return { ctx, CMD, writes, toasts };
}
const yes = (ctx, vals) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a sheet is open'); const err = a.validate && a.validate(vals || {}); if (err) { ctx.state.askErr = err; return err; } ctx.state.ask = null; a.run(vals); return ''; };
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;

section('1 · How points work');
{
  it('the read card says what an order gives back; Edit opens the rules; no "edited on desktop"', () => {
    const { ctx, CMD } = mk();
    const html = ctx.screenMembership();
    assert.ok(html.includes('How points work') && html.includes('So a ¥200 order earns 2 points = ¥0.02 off a future order (0.01% back).'));
    assert.ok(!html.includes('member at'), 'no tier name in the read card — the ladder below is in order');
    assert.ok(!/on desktop|电脑端/.test(html));
    CMD.prOpen();
    assert.strictEqual(top(ctx), 'pointsrules');
    const r = ctx.screenPointsRules();
    for (const w of ['Customers earn', 'point for every ¥', 'what they pay', 'order value before discounts', 'Each point is worth ¥', 'at checkout.', 'Points expire',
      '0 = never expire', 'Points can pay for shipping', 'Off — shipping is always paid in cash', 'Applies to new orders only.', 'Save points rules']) assert.ok(r.includes(w), w);
    assert.ok(/id="mPrSave" class="cta" disabled/.test(r), 'nothing to save yet');
  });
  it('Save points rules sends the desktop\'s seven keys, with its clamps; a top tier\'s multiplier is in the worked line', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.prOpen();
    CMD.prSet('earnPoints', '3'); CMD.prSet('earnSpend', '10'); CMD.prSet('pointValue', '0.05'); CMD.prSet('expiryMonths', '3'); CMD.prSet('earnBase', 'subtotal'); CMD.prShip();
    const r = ctx.screenPointsRules();
    assert.ok(r.includes('A Tree member at 2× earns'));
    assert.ok(r.includes('Short — most stores give 12–24, or 0 so points never expire.'));
    CMD.prSave(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/config', method: 'PUT', body: { 'points.earnPoints': 3, 'points.earnSpend': 10, 'points.earnRate': 4,
      'points.earnBase': 'subtotal', 'points.redeemRate': 20, 'points.expiryMonths': 3, 'points.coverShipping': true } }]);
    assert.deepStrictEqual(toasts, ['Saved']);
    assert.ok(!ctx.PR.busy && ctx.screenPointsRules().includes('>Saved<'));
  });
  it('a refused save keeps the draft and says why; Back with changes asks', async () => {
    const { ctx, CMD } = mk({ writeFails: 'bad' });
    CMD.prOpen(); CMD.prSet('earnSpend', '50'); CMD.prSave(); await tick();
    assert.ok(ctx.screenPointsRules().includes('Save failed: bad'));
    assert.strictEqual(ctx.prMayLeave(), false);
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel], ['Leave without saving? The changes on this page are lost.', 'Leave']);
    yes(ctx);
    assert.strictEqual(top(ctx), 'membership');
    assert.ok(MH.includes("if(top==='pointsrules'&&!prMayLeave()) return;") && MH.includes("if(prDirty()&&(state.stack||[]).some(f=>f&&f.route==='pointsrules')) return true;"));
  });
}

section('2 · the tiers: staged, then Save tiers');
{
  it('Edit tier opens the ladder; a tier is edited in a sheet into the draft, nothing sent until Save tiers', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    assert.ok(ctx.screenMembership().includes('Edit tier'));
    CMD.teOpen();
    assert.strictEqual(top(ctx), 'tiersedit');
    CMD.teEdit(1);
    const a = ctx.state.ask;
    assert.deepStrictEqual(plain(a.fields.map((f) => f.id)), ['name_en', 'name_cn', 'threshold', 'points_mult', 'perks_en', 'perks_cn']);
    assert.ok(a.body.includes('tree') && a.body.includes('set automatically from the English name.'));
    yes(ctx, { name_en: 'Oak', name_cn: '橡树', threshold: '4000', points_mult: '20', perks_en: 'Gift\n\n Tasting ', perks_cn: '' });
    assert.strictEqual(writes.length, 0);
    CMD.teSave(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/config', method: 'PUT', body: { 'roots_club.tiers': [
      { key: 'seed', name_en: 'Seed', name_cn: '种子', threshold: 0, points_mult: 1, perks_en: ['Newsletter'], perks_cn: [] },
      { key: 'tree', name_en: 'Oak', name_cn: '橡树', threshold: 4000, points_mult: 10, perks_en: ['Gift', 'Tasting'], perks_cn: [] }] } }],
      'the key stays "tree" — customers are stamped with it; the multiplier is held to 10');
    assert.deepStrictEqual(toasts, ['Tiers saved']);
  });
  it('a new tier starts ¥1000 above the top, gets its key from its English name, and the ladder is saved sorted', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.teOpen(); CMD.teAdd();
    assert.strictEqual(ctx.TE.d[2].threshold, 6000);
    yes(ctx, { name_en: 'Big Leaf', name_cn: '', threshold: '1000', points_mult: '1.5', perks_en: '', perks_cn: '' });
    CMD.teSave(); await tick();
    assert.deepStrictEqual(plain(writes[0].body['roots_club.tiers'].map((t) => [t.key, t.threshold])), [['seed', 0], ['big_leaf', 1000], ['tree', 5000]]);
  });
  it('the desktop\'s holds: an English name, a unique key, at least one tier, the lowest at 0 — nothing sent', async () => {
    const a = mk(); a.CMD.teOpen(); a.CMD.teAdd(); yes(a.ctx, { name_en: '', name_cn: '无名', threshold: '9000', points_mult: '1', perks_en: '', perks_cn: '' });
    a.CMD.teSave(); assert.ok(a.ctx.screenTiersEdit().includes('Every tier needs an English name'));
    const b = mk(); b.CMD.teOpen(); b.CMD.teAdd(); yes(b.ctx, { name_en: 'Seed', name_cn: '', threshold: '9000', points_mult: '1', perks_en: '', perks_cn: '' });
    b.CMD.teSave(); assert.ok(b.ctx.screenTiersEdit().includes('Two tiers resolve to the same key &quot;seed&quot; — rename one.'));
    const c = mk(); c.CMD.teOpen(); c.CMD.teEdit(0); yes(c.ctx, { name_en: 'Seed', name_cn: '', threshold: '100', points_mult: '1', perks_en: '', perks_cn: '' });
    c.CMD.teSave(); assert.ok(c.ctx.screenTiersEdit().includes('The lowest tier must start at ¥0'));
    const d = mk(); d.CMD.teOpen(); d.CMD.teRemove(0); yes(d.ctx); d.CMD.teRemove(0);
    assert.ok(d.ctx.state.ask.title.startsWith('Remove tier "Tree"'));
    yes(d.ctx); d.CMD.teSave();
    assert.ok(d.ctx.screenTiersEdit().includes('At least one tier is required'));
    for (const m of [a, b, c, d]) assert.strictEqual(m.writes.length, 0);
  });
  it('Back with an unsaved ladder asks; the reload guard knows it', () => {
    const { ctx, CMD } = mk();
    CMD.teOpen();
    assert.strictEqual(ctx.teMayLeave(), true);
    CMD.teAdd(); ctx.state.ask = null;
    assert.strictEqual(ctx.teMayLeave(), false);
    assert.ok(MH.includes("if(top==='tiersedit'&&!teMayLeave()) return;") && MH.includes("if(teDirty()&&(state.stack||[]).some(f=>f&&f.route==='tiersedit')) return true;"));
  });
  it('an empty ladder: the desktop\'s line and + Add tier', () => {
    const { ctx } = mk({ tiers: [] });
    const html = ctx.screenMembership();
    assert.ok(html.includes('No tiers yet — add one to start the ladder.') && html.includes('+ Add tier'));
  });
}

section('3 · top-up packages');
{
  it('the Top-up screen opens the packages; each with its switch, edit and delete; the empty and failed reads', async () => {
    const { ctx, CMD } = mk();
    assert.ok(/tpOpen/.test(ctx.screenTopups()) && !ctx.screenTopups().includes('on desktop'));
    CMD.tpOpen(); await tick();
    const html = ctx.screenTupPkgs();
    assert.ok(html.includes('¥200 · +20 points') && html.includes('Starter') && html.includes('¥500 · no bonus'), 'inactive packages are listed here to switch on');
    assert.ok(/cmd="APP\.cmd\('tpActive',2\)"/.test(html) && /tpEdit',1\)/.test(html) && /tpDelete',1\)/.test(html));
    const f = mk({ pkgsFail: true }); f.CMD.tpOpen(); await tick();
    assert.ok(f.ctx.screenTupPkgs().includes('Could not load this.'));
  });
  it('add: amount required; POST with the desktop\'s fields; edit sends only what changed; switch; delete asks', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.tpOpen(); await tick();
    CMD.tpAdd();
    assert.strictEqual(yes(ctx, { amount: '', bonus: '', title_en: '', title_cn: '' }), 'Amount required');
    ctx.state.ask && yes(ctx, { amount: '300', bonus: '30', title_en: 'Big', title_cn: '' }); await tick();
    CMD.tpEdit(1); yes(ctx, { amount: '200', bonus: '25', title_en: 'Starter', title_cn: '入门' }); await tick();
    CMD.tpEdit(1); yes(ctx, { amount: '200', bonus: '20', title_en: 'Starter', title_cn: '入门' }); await tick();
    CMD.tpActive(2); await tick();
    CMD.tpDelete(1);
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.danger], ['Delete ¥200 top-up package?', true]);
    yes(ctx); await tick();
    assert.deepStrictEqual(plain(writes), [
      { p: '/topup-packages', method: 'POST', body: { amount: 300, bonus_points: 30, title_en: 'Big', title_cn: null } },
      { p: '/topup-packages/1', method: 'PATCH', body: { bonus_points: 25 } },
      { p: '/topup-packages/2', method: 'PATCH', body: { is_active: 1 } },
      { p: '/topup-packages/1', method: 'DELETE', body: {} }]);
    assert.deepStrictEqual(toasts, ['Package added', 'Saved', 'Package deleted']);
  });
  it('a refused write is said on the screen', async () => {
    const { ctx, CMD } = mk({ writeFails: 'nope' });
    CMD.tpOpen(); await tick();
    CMD.tpActive(1); await tick();
    assert.ok(ctx.screenTupPkgs().includes('Save failed: nope'));
  });
}

section('4 · the keys — money fails closed');
{
  it('while the keys are unknown: no Edit, no packages door; every command writes nothing', async () => {
    const { ctx, CMD, writes } = mk({ caps: null });
    assert.ok(!/prOpen|teOpen/.test(ctx.screenMembership()) && !/tpOpen/.test(ctx.screenTopups()));
    CMD.prOpen(); CMD.teOpen(); CMD.tpOpen(); CMD.tpAdd(); CMD.tpActive(1); CMD.tpDelete(1);
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
  });
  it('without the loyalty keys the ladder is read-only; without topup:edit the packages are', () => {
    const { ctx, CMD } = mk({ caps: ['dashboard:view'] });
    assert.ok(!/prOpen|teOpen/.test(ctx.screenMembership()) && !/tpOpen/.test(ctx.screenTopups()));
    CMD.teOpen();
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.ok(/pointsrules:\['loyalty:view','loyalty:edit'\], tiersedit:\['loyalty:view','loyalty:edit'\], wallet:'topup:edit', topuppkgs:'topup:edit'/.test(MH));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
