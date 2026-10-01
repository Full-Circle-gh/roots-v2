#!/usr/bin/env node
/**
 * §325 M14 — A COUPON IS MADE ON THE PHONE, THROUGH THE DESKTOP'S WIZARD.
 *
 *   node scripts/test_mobile_coupons_create.js
 *
 * Coupons were "written on desktop". The desktop's guided wizard
 * (public/retail-admin/05-marketing.js vwOpen … vwSave) is now a phone screen:
 * the deal with its five starting points, who gets it, the small print, then
 * turn it on, with the live ticket and the heads-up on every step and one
 * POST /vouchers carrying the desktop's body. Sliced out of public/m.html and
 * run in a sandbox (fast shard). Pins the request (method, path, every body
 * field), the step checks, the save checks, the failed and refused cases, the
 * hand-off to the grant screen, and coupons:create failing closed.
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

const MAP_SRC = slice(MH, "/* A coupon's headline fact is what it GIVES", 'const FLASH_KIND');
const SRC = slice(MH, '/* Pausing a coupon is the one marketing action', '/* A scheduled broadcast can still be stopped');

const LIVE = [
  { id: 1, code: 'AUTO10', type: 'percent', value: 10, is_active: 1, auto_apply: 1, expires_at: null },
  { id: 2, code: 'HELLO', type: 'fixed_amount', value: 20, is_active: 1, auto_grant_signup: 1, expires_at: null },
  { id: 3, code: 'OLD', type: 'fixed_amount', value: 5, is_active: 0, expires_at: null },
];

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, CUR: 'Y',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { muted: ['m', 'M'] },
    pill: (k, l) => `<pill kind="${k}">${l}</pill>`,
    money: (c, n) => c + Number(n), money0: (c, n) => c + Math.round(Number(n)),
    _date: (s) => (s ? new Date(s) : null),
    fmtDay: (d) => String(d || '').slice(0, 10),
    nothingYet: (t, m) => `<empty>${t}${m}</empty>`,
    chipRow: (items, cur, cmd) => items.map((c) => `<chip on="${c.key === cur}" cmd="APP.cmd('${cmd}','${c.key}')">${T(c.en, c.zh)}</chip>`).join(''),
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    forgetScroll: () => {},
    state: { caps: opts.caps === undefined ? ['coupons:view', 'coupons:create', 'coupons:grant'] : opts.caps,
      ask: null, askErr: null, stack: [{ route: 'coupons' }], sw: {}, vchLoaded: true },
    DB: { coupons: [] },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(String(m)),
    api: async (p) => {
      reads.push(p);
      if (p === '/vouchers') return opts.list ? opts.list() : LIVE;
      return {};
    },
    apiRaw: async (p) => { reads.push(p); return { success: true, data: [], total: 0 }; },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: plain(body), method });
      if (opts.refused) { const e = new Error('refused'); e.refused = true; e.words = ['Not allowed', '无权限']; throw e; }
      if (opts.writeFails) { const e = new Error('That code is already in use.'); e.code = opts.writeFails; throw e; }
      return opts.reply || { success: true, data: { id: 44, code: body.code } };
    },
    document: { getElementById: () => null },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(MAP_SRC + SRC + '\nthis.mapVoucher=mapVoucher; this.screenCouponNew=screenCouponNew; this.cw=()=>CW; this.cwMayLeave=cwMayLeave;'
    + ' this.vd=()=>VD; this.vg=()=>VG;', ctx);
  ctx.DB.coupons = LIVE.map(ctx.mapVoucher);
  return { ctx, CMD, writes, reads, toasts };
}
const open = async (o) => { const m = mk(o); m.CMD.cwOpen(); await tick(); return m; };
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;
const toReview = (CMD) => { CMD.cwNext(); CMD.cwNext(); };

section('1 · the door and the steps');
{
  it('the door is a New coupon button on Coupons, for coupons:create; the route is coupons:create\'s; leaving asks', () => {
    assert.ok(MH.includes("cta:()=>cwCan()?`<button class=\"cta inhead\" onclick=\"APP.cmd('cwOpen')\">${T('New coupon','新建优惠券')}</button>`:''"));
    assert.ok(/couponnew:'coupons:create'/.test(MH));
    assert.ok(/if\(top==='couponnew'&&!cwMayLeave\(\)\) return;/.test(MH) && /t\.route==='couponnew'&&!cwMayLeave\(\)/.test(MH));
    assert.ok(/CW&&CW\.dirty&&\(state\.stack\|\|\[\]\)\.some\(f=>f&&f\.route==='couponnew'\)/.test(MH), 'a reload asks too');
    assert.ok(!MH.includes('Coupons are written on desktop'), 'the empty list no longer sends them to the desktop');
  });
  it('opens on the deal, "Anyone can use" picked, Y10 off, with the ticket and the heads-up; reads the live coupons', async () => {
    const { ctx, reads } = await open();
    assert.strictEqual(top(ctx), 'couponnew');
    assert.ok(reads.includes('/vouchers'));
    const h = ctx.screenCouponNew();
    for (const s of ['Start from', 'Welcome gift', 'Store sale', 'Free shipping', 'Start fresh', 'What kind of discount?', 'Money off',
      'a set Y amount', 'How much do they save?', 'value="10"', '<b>Anyone</b> can find it in the app and tap to save.', 'Change',
      'What the customer sees', 'Y10 off', 'any order', '<b style="color:var(--text-primary);font-weight:500">Anyone</b> · once each · no end date',
      'Anyone can find this in the app, and a shared code also works.', 'Next']) assert.ok(h.includes(s), s);
    assert.ok(/<chip on="true" cmd="APP\.cmd\('cwGoal','public'\)">/.test(h));
    assert.ok(!h.includes('cwBack'), 'no Back on the first step');
  });
  it('a starting point replaces the answers; Start fresh adds the who step', async () => {
    const { ctx, CMD } = await open();
    CMD.cwGoal('sale');
    let w = ctx.cw();
    assert.deepStrictEqual([w.type, w.value, w.path, w.showWho], ['percent', 10, 'auto', false]);
    CMD.cwGoal('welcome'); w = ctx.cw();
    assert.deepStrictEqual([w.type, w.value, w.path, w.showOnHome], ['fixed_amount', 20, 'welcome', true]);
    CMD.cwGoal('shipping'); w = ctx.cw();
    assert.deepStrictEqual([w.type, w.value, w.path], ['free_shipping', 0, 'auto']);
    CMD.cwGoal('fresh'); w = ctx.cw();
    assert.deepStrictEqual([w.type, w.value, w.path, w.showWho], ['fixed_amount', 0, 'public', true]);
    CMD.cwVal('15'); CMD.cwNext();
    assert.strictEqual(ctx.cw().step, 'who');
    const h = ctx.screenCouponNew();
    for (const s of ['How do customers get it?', 'Applied for everyone', 'Anyone can use it', 'A welcome gift', 'I choose who gets it', 'Back'])
      assert.ok(h.includes(s), s);
    CMD.cwPath('welcome');
    assert.ok(ctx.screenCouponNew().includes('Also show it on the home page?'));
    CMD.cwBack(); assert.strictEqual(ctx.cw().step, 'deal');
  });
  it('"Change" on the deal opens the who step', async () => {
    const { ctx, CMD } = await open();
    CMD.cwChangeWho();
    assert.strictEqual(ctx.cw().step, 'who');
  });
  it('the deal checks how much, as the desktop does, and stays put', async () => {
    const { ctx, CMD } = await open();
    CMD.cwVal(''); CMD.cwNext();
    assert.strictEqual(ctx.cw().step, 'deal');
    assert.ok(ctx.screenCouponNew().includes('Enter how much they save'));
    CMD.cwType('percent'); CMD.cwVal('120'); CMD.cwNext();
    assert.ok(ctx.screenCouponNew().includes('Percent can be at most 100'));
    CMD.cwType('free_shipping'); CMD.cwNext();
    assert.strictEqual(ctx.cw().step, 'rules', 'free shipping has no amount to check');
  });
  it('the small print: minimum, end, per customer, total — and a past end date is refused', async () => {
    const { ctx, CMD } = await open();
    CMD.cwNext();
    let h = ctx.screenCouponNew();
    for (const s of ['Good defaults are set. Change only what you want.', 'Works on <b>any order size</b>.', 'Set a minimum',
      'Runs <b>until you turn it off</b>.', 'No end date', 'One week', 'One month', 'Pick a day', 'Per customer · <b>Once</b>',
      '<b>No limit</b> on total uses.', 'Set a limit']) assert.ok(h.includes(s), s);
    CMD.cwMinOn(); CMD.cwMin('100'); CMD.cwStep(1); CMD.cwStep(1); CMD.cwMaxOn(); CMD.cwMax('50'); CMD.cwEnd('1w');
    h = ctx.screenCouponNew();
    assert.ok(h.includes('On orders over') && h.includes('Per customer · <b>3 times</b>') && h.includes('Ends in <b>one week</b>.'));
    assert.ok(h.includes('orders Y100+') && h.includes('3× each'));
    CMD.cwEnd('pick'); CMD.cwDate('2020-01-01'); CMD.cwNext();
    assert.strictEqual(ctx.cw().step, 'rules');
    assert.ok(ctx.screenCouponNew().includes('That end date has passed — pick a later one'));
  });
  it('review: the recap, a generated code and label, both editable', async () => {
    const { ctx, CMD } = await open();
    toReview(CMD);
    const w = ctx.cw();
    assert.deepStrictEqual([w.step, w.code, w.title_en, w.title_cn], ['review', 'OFF10', 'Y10 off', '立减 Y10']);
    const h = ctx.screenCouponNew();
    for (const s of ['<b>Anyone in the app</b> get <b>Y10 off</b> — they tap to save, once each, until you turn it off.', 'Coupon code',
      '— made for you, change it if you like', 'value="OFF10"', 'What customers see', 'value="Y10 off"', 'value="立减 Y10"',
      'Save as draft', 'Turn it on']) assert.ok(h.includes(s), s);
    CMD.cwCode('spring'); assert.strictEqual(ctx.cw().code, 'SPRING');
  });
  it('an automatic sale has no label to fill, and the generated code follows the path', async () => {
    const { ctx, CMD } = await open();
    CMD.cwGoal('sale'); toReview(CMD);
    assert.strictEqual(ctx.cw().code, 'SAVE10');
    assert.ok(!ctx.screenCouponNew().includes('What customers see'));
    const m = await open(); m.CMD.cwGoal('welcome'); toReview(m.CMD);
    assert.deepStrictEqual([m.ctx.cw().code, m.ctx.cw().title_en, m.ctx.cw().title_cn], ['WELCOME20', 'Y20 off your first order', '首单立减 Y20']);
  });
  it('Chinese reads the desktop\'s Chinese, and the recap uses no word the desktop does not', async () => {
    const { ctx, CMD } = await open({ lang: 'zh' });
    let h = ctx.screenCouponNew();
    for (const s of ['从以下开始', '哪种优惠?', '优惠多少?', '<b>人人可用</b>在小程序内自行领取。', '顾客看到的', '下一步']) assert.ok(h.includes(s), s);
    toReview(CMD);
    h = ctx.screenCouponNew();
    assert.ok(h.includes('<b>小程序内任何人</b>:<b>立减 Y10</b> — 顾客自行领取,每人一次,直到你停用。'), 'recap');
    assert.ok(h.includes('存为草稿') && h.includes('开启'));
  });
}

section('2 · the heads-up, from the live coupons');
{
  it('another automatic deal: best one wins, and which gives more on a Y200 order', async () => {
    const { ctx, CMD } = await open();
    CMD.cwGoal('sale');
    let h = ctx.screenCouponNew();
    assert.ok(h.includes('You already have automatic deal(s): <b>AUTO10</b>. Customers get the single best one — these do not add together.'));
    assert.ok(h.includes('On a typical Y200 order, <b>AUTO10</b> gives more — your new deal may rarely be used.'), 'a tie goes to the old one, as on the desktop');
    CMD.cwVal('30');
    h = ctx.screenCouponNew();
    assert.ok(h.includes('On a typical Y200 order, your new deal gives the most — it will usually win.'));
  });
  it('another welcome gift, a code a live coupon holds (red), a dead one (reused), and "pick" says what happens next', async () => {
    const { ctx, CMD } = await open();
    CMD.cwGoal('welcome');
    let h = ctx.screenCouponNew();
    assert.ok(h.includes('New customers will also get <b>HELLO</b>. They can use one per order.'));
    CMD.cwCode('hello');
    h = ctx.screenCouponNew();
    assert.ok(h.includes('A live coupon already uses <b>HELLO</b>. Pick another code, or turn the old one off first.'));
    CMD.cwGoal('public'); CMD.cwCode('old');
    h = ctx.screenCouponNew();
    assert.ok(h.includes('You used <b>OLD</b> before and it is off now. Saving reuses it and starts its count from zero.'));
    CMD.cwChangeWho(); CMD.cwPath('pick');
    assert.ok(ctx.screenCouponNew().includes('After saving, pick the customers to give it to — it lands in their coupons, no code needed.'));
  });
}

section('3 · the save: POST /vouchers');
{
  it('Save as draft: the desktop\'s body, every field, is_active false', async () => {
    const { ctx, CMD, writes, toasts, reads } = await open();
    CMD.cwNext();
    CMD.cwMinOn(); CMD.cwMin('100'); CMD.cwStep(1); CMD.cwMaxOn(); CMD.cwMax('50'); CMD.cwEnd('pick'); CMD.cwDate('2099-06-15');
    CMD.cwNext();
    const n = reads.length;
    CMD.cwSave(0); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers', method: undefined, body: {
      code: 'OFF10', type: 'fixed_amount', value: 10, min_subtotal: 100, max_uses: 50, per_customer_limit: 2,
      expires_at: '2099-06-15', is_public: true, auto_grant_signup: false, auto_apply: false,
      title_en: 'Y10 off', title_cn: '立减 Y10', is_active: false } }]);
    assert.deepStrictEqual(toasts, ['Saved as draft OFF10']);
    assert.strictEqual(ctx.cw(), null);
    assert.strictEqual(top(ctx), 'coupons', 'back on the list');
    assert.ok(reads.slice(n).includes('/vouchers'), 'the list is read again');
  });
  it('Turn it on: is_active true; an automatic free-shipping sale sends value 0, no label, the right flags', async () => {
    const { CMD, writes, toasts } = await open();
    CMD.cwGoal('shipping'); toReview(CMD);
    CMD.cwSave(1); await tick();
    assert.deepStrictEqual(writes[0].body, { code: 'FREESHIP', type: 'free_shipping', value: 0, min_subtotal: 0, max_uses: null,
      per_customer_limit: 1, expires_at: null, is_public: false, auto_grant_signup: false, auto_apply: true,
      title_en: 'Free shipping', title_cn: '免运费', is_active: true });
    assert.deepStrictEqual(toasts, ['Created & live FREESHIP']);
  });
  it('a welcome gift shown on the home page is public and granted at signup; a reused code says so', async () => {
    const { CMD, writes, toasts } = await open({ reply: { success: true, reused: true, data: { id: 3 } } });
    CMD.cwGoal('welcome'); toReview(CMD); CMD.cwCode('NEWBIE');
    CMD.cwSave(1); await tick();
    assert.deepStrictEqual([writes[0].body.is_public, writes[0].body.auto_grant_signup, writes[0].body.auto_apply], [true, true, false]);
    assert.deepStrictEqual(toasts, ['Reused code NEWBIE']);
  });
  it('the save checks: a code, a label unless automatic, and no live coupon on the code — nothing sent', async () => {
    const { ctx, CMD, writes } = await open();
    toReview(CMD);
    CMD.cwCode(''); CMD.cwSave(1);
    assert.ok(ctx.screenCouponNew().includes('Code required'));
    CMD.cwCode('X1'); CMD.cwLbl('en', ' '); CMD.cwLbl('cn', ''); CMD.cwSave(1);
    assert.ok(ctx.screenCouponNew().includes('Add a label customers see (EN or 中)'));
    CMD.cwLbl('en', 'Hi'); CMD.cwCode('auto10'); CMD.cwSave(1);
    assert.ok(ctx.screenCouponNew().includes('A live coupon already uses AUTO10 — change the code'));
    await tick();
    assert.deepStrictEqual(writes, []);
  });
  it('for chosen customers, the save goes straight on to the grant screen for the new coupon', async () => {
    const list = () => LIVE.concat([{ id: 44, code: 'OFF10', type: 'fixed_amount', value: 10, is_active: 0, per_customer_limit: 1, grant_count: 0 }]);
    const { ctx, CMD } = await open({ list });
    CMD.cwChangeWho(); CMD.cwPath('pick'); CMD.cwNext(); CMD.cwNext();
    assert.strictEqual(ctx.cw().step, 'review');
    CMD.cwSave(0); await tick(); await tick();
    assert.deepStrictEqual(ctx.state.stack.map((f) => f.route), ['coupons', 'coupon', 'coupongrant']);
    assert.strictEqual(ctx.vd().id, 44); assert.strictEqual(ctx.vg().id, 44);
  });
  it('three states: Saving… while out, a second tap sends nothing; a failure stays with the desktop\'s words', async () => {
    const { ctx, CMD, writes } = await open();
    toReview(CMD);
    CMD.cwSave(1);
    assert.ok(ctx.screenCouponNew().includes('Saving…'));
    CMD.cwSave(1); await tick();
    assert.strictEqual(writes.length, 1);
    const f = await open({ writeFails: 'code_exists' });
    toReview(f.CMD); f.CMD.cwSave(1); await tick();
    assert.ok(f.ctx.screenCouponNew().includes('Failed: Code already exists'));
    assert.strictEqual(top(f.ctx), 'couponnew', 'the wizard stays, with what was typed');
    const a = await open({ writeFails: 'code_active' });
    toReview(a.CMD); a.CMD.cwSave(1); await tick();
    assert.ok(a.ctx.screenCouponNew().includes('Failed: A live coupon already uses this code'));
    const r = await open({ refused: true });
    toReview(r.CMD); r.CMD.cwSave(1); await tick();
    assert.ok(r.ctx.screenCouponNew().includes('Not allowed'));
  });
  it('leaving: untouched goes; changed asks', async () => {
    const { ctx } = await open();
    assert.strictEqual(ctx.cwMayLeave(), true);
    const m = await open(); m.CMD.cwVal('12');
    assert.strictEqual(m.ctx.cwMayLeave(), false);
    assert.strictEqual(m.ctx.state.ask.confirmLabel, 'Leave');
  });
}

section('4 · the key');
{
  it('without coupons:create: no door, and nothing opens or saves', async () => {
    const { ctx, CMD, writes } = mk({ caps: ['coupons:view', 'coupons:edit'] });
    CMD.cwOpen(); await tick();
    assert.strictEqual(ctx.cw(), null);
    assert.strictEqual(top(ctx), 'coupons');
    assert.deepStrictEqual(writes, []);
  });
  it('keys not yet known: closed (money: moves)', async () => {
    const { ctx, CMD } = mk({ caps: null });
    CMD.cwOpen(); await tick();
    assert.strictEqual(ctx.cw(), null);
  });
  it('keys lost mid-way: no save buttons, and the save sends nothing', async () => {
    const { ctx, CMD, writes } = await open();
    toReview(CMD);
    ctx.state.caps = ['coupons:view'];
    const h = ctx.screenCouponNew();
    assert.ok(!h.includes('Save as draft') && !h.includes("cwSave',1"));
    CMD.cwSave(1); await tick();
    assert.deepStrictEqual(writes, []);
  });
  it('the server agrees on the key', () => {
    const { requiredCapFor } = require(path.join(ROOT, 'lib/cap-routes.js'));
    assert.strictEqual(requiredCapFor('POST', '/api/retail-admin/vouchers'), 'coupons:create');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
