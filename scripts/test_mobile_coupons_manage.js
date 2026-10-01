#!/usr/bin/env node
/**
 * §325 M13 — ONE COUPON ON THE PHONE: CHANGE IT, GIVE IT OUT, TAKE IT BACK.
 *
 *   node scripts/test_mobile_coupons_manage.js
 *
 * The phone's coupon list could only pause a coupon. The desktop's coupon
 * drawer (public/retail-admin/05-marketing.js vchDrawerRender) changes the
 * per-customer limit, the end date, the three "how customers get it" switches
 * and the label, turns it on and off, and lists who holds it with Take it back;
 * its grant dialog (openGrantModal) gives it to one customer or to everyone,
 * with a note, and revokes. This is both, on the phone, sliced out of
 * public/m.html and run in a sandbox (fast shard). Pins every request (method,
 * path, every body field), the confirms, the empty / failed / refused cases,
 * and the keys — coupons:edit for the PATCH, coupons:grant for the grants,
 * both failing closed while the keys are unknown.
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
const VD_SRC = slice(MH, '/* Pausing a coupon is the one marketing action', '/* A scheduled broadcast can still be stopped');

const FUTURE = '2099-06-15T15:59:59Z', PAST = '2020-01-01T15:59:59Z';
const ROW = (o = {}) => Object.assign({ id: 5, code: 'WELCOME', type: 'fixed_amount', value: 20, min_subtotal: 100,
  max_uses: null, per_customer_limit: 1, expires_at: FUTURE, is_active: 1, is_public: 0, auto_grant_signup: 0,
  auto_apply: 0, title_en: 'Welcome', title_cn: '欢迎', used_count: 3, grant_count: 12, grant_used_count: 2 }, o);
const HOLDERS = [
  { id: 71, customer_id: 401, nickname: 'Chen', phone: '138', used_at: null },
  { id: 72, customer_id: 402, nickname: '', phone: '', used_at: '2026-09-01 10:00:00' },
];

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {}, opened = [];
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, CUR: 'CNY',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    pill: (k, l) => `<pill kind="${k}">${l}</pill>`,
    money: (c, n) => 'Y' + Number(n), money0: (c, n) => 'Y' + Math.round(Number(n)),
    _date: (s) => (s ? new Date(s) : null),
    fmtDay: (d) => String(d || '').slice(0, 10),
    nothingYet: (t, m) => `<empty>${t}${m}</empty>`,
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    forgetScroll: () => {},
    state: { caps: opts.caps === undefined ? ['coupons:view', 'coupons:edit', 'coupons:grant', 'customers:view'] : opts.caps,
      ask: null, askErr: null, stack: [{ route: 'coupons' }], sw: {}, vchLoaded: true },
    DB: { coupons: [] },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(String(m)),
    api: async (p) => {
      reads.push(p);
      if (p === '/vouchers') { if (opts.reloadFails) throw new Error('net'); return [opts.after || ROW(opts.row)]; }
      return {};
    },
    apiRaw: async (p) => {
      reads.push(p);
      if (p.startsWith('/vouchers/5/grants')) {
        if (opts.grantsFail) throw new Error('boom');
        const rows = opts.holders || HOLDERS;
        return { success: true, data: rows, total: opts.total != null ? opts.total : rows.length };
      }
      if (p.startsWith('/customers')) {
        if (opts.searchFails) throw new Error('down');
        return { success: true, data: opts.customers || [{ id: 401, nickname: 'Chen', phone: '138' }, { id: 403, nickname: 'Ling', phone: '139' }] };
      }
      return {};
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: plain(body), method });
      if (opts.refused) { const e = new Error('refused'); e.refused = true; e.words = ['Not allowed', '无权限']; throw e; }
      if (opts.writeFails) { const e = new Error(opts.writeFails); e.code = opts.writeFails; throw e; }
      if (p.endsWith('/grant')) return opts.grantReply || { success: true, granted: 1, skipped: 0 };
      return { success: true };
    },
    document: { getElementById: () => null },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  CMD.openCustomer = (id) => opened.push(id);
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(MAP_SRC + VD_SRC + '\nthis.mapVoucher=mapVoucher; this.screenCoupon=screenCoupon; this.screenCouponGrant=screenCouponGrant;'
    + ' this.vd=()=>VD; this.vg=()=>VG; this.vdMayLeave=vdMayLeave; this.toggleCoupon=toggleCoupon;', ctx);
  ctx.DB.coupons = [ctx.mapVoucher(ROW(opts.row))];
  return { ctx, CMD, writes, reads, toasts, opened };
}
const open = async (o) => { const m = mk(o); m.CMD.vchOpen(5); await tick(); return m; };
const yes = (ctx) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(); };

section('1 · the screen is the desktop drawer');
{
  it('the card opens it; the switch keeps its own tap; both routes are coupons:view', () => {
    assert.ok(/onclick="APP\.cmd\('vchOpen',\$\{Number\(c\.id\)\}\)"/.test(MH), 'the card opens the coupon');
    assert.ok(/<span style="flex:none" onclick="event\.stopPropagation\(\)">\$\{toggle\(!!c\.active/.test(MH), 'the pause switch does not open it');
    assert.ok(/coupon:'coupons:view', coupongrant:'coupons:view'/.test(MH));
    assert.ok(/if\(top==='coupon'&&!vdMayLeave\(\)\) return;/.test(MH) && /t\.route==='coupon'&&!vdMayLeave\(\)/.test(MH), 'Back and the edge swipe both ask');
  });
  it('opens on the coupon: code, status, the facts, the switches, the label, who has it', async () => {
    const { ctx, reads } = await open();
    assert.strictEqual(ctx.state.stack[ctx.state.stack.length - 1].route, 'coupon');
    assert.ok(reads.includes('/vouchers/5/grants?limit=8'), 'the head of the holder list');
    const h = ctx.screenCoupon();
    for (const s of ['WELCOME', '<pill kind="live">Running</pill>', 'Gives', 'Y20 off', 'On orders over', 'Y100', 'Used', '>3<',
      'Per customer', 'Ends', 'value="2099-06-15"', 'How customers get it', 'Show in the app', 'Give to new signups', 'Apply it for them',
      'Only the customers you give it to get it at checkout — no code, no tap.', 'What customers see', 'value="Welcome"', 'value="欢迎"',
      'Save label', 'Give it out', 'Given to 12 customers — 2 of those have used it.', 'Give to a customer', 'Chen', '138', '(no name)',
      'Turn off', 'Turning it off keeps its history.']) assert.ok(h.includes(s), s);
    assert.ok(/<option value="1" selected>Once<\/option>/.test(h) && /<option value="0">No limit<\/option>/.test(h));
  });
  it('a used one-shot hand-out is not offered back; an unused one is', async () => {
    const { ctx } = await open();
    const h = ctx.screenCoupon();
    assert.ok(/vdTakeBack',71\)/.test(h) && !/vdTakeBack',72\)/.test(h));
  });
  it('a standing coupon says they keep it, and every holder can be taken back', async () => {
    const { ctx } = await open({ row: { per_customer_limit: 0 } });
    const h = ctx.screenCoupon();
    assert.ok(h.includes('Given to 12 customers — they keep it, with no limit on how many orders.'));
    assert.ok(/vdTakeBack',71\)/.test(h) && /vdTakeBack',72\)/.test(h));
  });
  it('an ended coupon says so, and Turn on is refused with the reason and nothing sent', async () => {
    const { ctx, CMD, writes } = await open({ row: { expires_at: PAST, is_active: 0 } });
    let h = ctx.screenCoupon();
    assert.ok(h.includes('<pill kind="off">Off</pill>') && h.includes('Turn on'));
    CMD.vdTurn(1); await tick();
    assert.strictEqual(writes.length, 0);
    assert.ok(ctx.screenCoupon().includes('It already ended — set a new end date first'));
    const e = await open({ row: { expires_at: PAST, is_active: 1 } });
    h = e.ctx.screenCoupon();
    assert.ok(h.includes('<pill kind="off">Ended</pill>') && h.includes('This coupon ended. Set a new end date below to run it again.'));
  });
  it('a public coupon with no label is warned; "See all" appears past the eight', async () => {
    const { ctx } = await open({ row: { is_public: 1, title_en: '', title_cn: '' }, total: 40 });
    const h = ctx.screenCoupon();
    assert.ok(h.includes('Public coupons need a label customers can read.'));
    assert.ok(h.includes('Every customer gets it at checkout — no code, no tap.'));
    assert.ok(h.includes('See all 40') && h.includes("APP.cmd('vgOpen')"));
  });
  it('nobody given it: no holder read, and the line says how to', async () => {
    const { ctx, reads } = await open({ row: { grant_count: 0, grant_used_count: 0 } });
    assert.ok(!reads.some((p) => p.includes('/grants')));
    assert.ok(ctx.screenCoupon().includes('Hand it to specific customers — it lands in their coupons, no code needed.'));
  });
  it('the holder list failing says so, with a retry that reads again', async () => {
    const { ctx, CMD, reads } = await open({ grantsFail: true });
    const h = ctx.screenCoupon();
    assert.ok(h.includes('Couldn’t load who has it: boom') && h.includes("APP.cmd('vdHoldersRetry')"));
    const n = reads.length; CMD.vdHoldersRetry(); await tick();
    assert.ok(reads.length > n);
  });
  it('a sample row (no id) does not open', () => {
    const m = mk(); m.ctx.DB.coupons = [{ id: null, code: 'X' }]; m.CMD.vchOpen(null);
    assert.strictEqual(m.ctx.state.stack.length, 1);
  });
  it('a holder opens the customer', async () => {
    const { CMD, opened } = await open();
    CMD.vdHolder(401); assert.deepStrictEqual(opened, [401]);
  });
  it('Chinese reads the desktop’s Chinese', async () => {
    const { ctx } = await open({ lang: 'zh' });
    const h = ctx.screenCoupon();
    for (const s of ['生效中', '最低订单金额', '每人限用', '顾客怎么获得', '在小程序展示', '保存标签', '发放给顾客', '收回', '停用会保留历史记录,可随时重新开启。'])
      assert.ok(h.includes(s), s);
  });
}

section('2 · the writes: PATCH /vouchers/:id');
{
  it('each switch sends its own field, flipped', async () => {
    const { CMD, writes } = await open();
    CMD.vdSwitch('is_public'); await tick();
    CMD.vdSwitch('auto_grant_signup'); await tick();
    CMD.vdSwitch('auto_apply'); await tick();
    CMD.vdSwitch('value'); await tick();
    assert.deepStrictEqual(writes, [
      { p: '/vouchers/5', body: { is_public: true }, method: 'PATCH' },
      { p: '/vouchers/5', body: { auto_grant_signup: true }, method: 'PATCH' },
      { p: '/vouchers/5', body: { auto_apply: true }, method: 'PATCH' }]);
  });
  it('the end date, and clearing it to no end date', async () => {
    const { CMD, writes, toasts } = await open();
    CMD.vdExpiry('2099-12-31'); await tick();
    CMD.vdExpiry(''); await tick();
    assert.deepStrictEqual(writes, [
      { p: '/vouchers/5', body: { expires_at: '2099-12-31' }, method: 'PATCH' },
      { p: '/vouchers/5', body: { expires_at: null }, method: 'PATCH' }]);
    assert.deepStrictEqual(toasts, ['End date set', 'No end date — runs until turned off']);
  });
  it('the list’s switch refuses to turn an ended coupon on, as the desktop’s Turn on does; off still goes', async () => {
    const m = mk({ row: { expires_at: PAST, is_active: 0 } });
    m.ctx.toggleCoupon('WELCOME'); await tick();
    assert.deepStrictEqual(m.writes, []);
    assert.strictEqual(String(m.ctx.state.couponErr), 'It already ended — set a new end date first');
    const n = mk({ row: { expires_at: PAST, is_active: 1 } });
    n.ctx.toggleCoupon('WELCOME'); await tick();
    assert.deepStrictEqual(n.writes, [{ p: '/vouchers/5', body: { is_active: false }, method: 'PATCH' }]);
  });
  it('per customer: from once to more asks first when someone already used it; No sends nothing', async () => {
    const { ctx, CMD, writes, toasts } = await open();
    CMD.vdPer('3');
    assert.ok(ctx.state.ask && ctx.state.ask.title === 'Give it back to customers who already used it?');
    assert.strictEqual(ctx.state.ask.body, '2 customers have already used this coupon. They get it back and can use it again.');
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Yes, let them use it again');
    ctx.state.ask = null; await tick();
    assert.strictEqual(writes.length, 0, 'cancelled');
    CMD.vdPer('3'); yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers/5', body: { per_customer_limit: 3 }, method: 'PATCH' }]);
    assert.deepStrictEqual(toasts, ['Up to 3 orders per customer']);
  });
  it('per customer: back to once, or with nobody revived, goes straight out', async () => {
    const { ctx, CMD, writes, toasts } = await open({ row: { per_customer_limit: 0, grant_used_count: 0 } });
    CMD.vdPer('0'); await tick();
    assert.strictEqual(ctx.state.ask, null);
    CMD.vdPer('1'); await tick();
    assert.deepStrictEqual(writes.map((w) => w.body), [{ per_customer_limit: 0 }, { per_customer_limit: 1 }]);
    assert.deepStrictEqual(toasts, ['No limit — each customer can use it on every order', 'Once per customer']);
  });
  it('the label: typed text is held, Save label sends both (blank as null), then it is clean', async () => {
    const { ctx, CMD, writes, toasts } = await open();
    CMD.vdLbl('en', '  Hello  '); CMD.vdLbl('cn', '');
    assert.ok(ctx.screenCoupon().includes('value="  Hello  "'), 'a repaint keeps what was typed');
    CMD.vdSaveLabel(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers/5', body: { title_en: 'Hello', title_cn: null }, method: 'PATCH' }]);
    assert.deepStrictEqual(toasts, ['Label saved']);
    assert.strictEqual(ctx.vd().lblDirty, false);
  });
  it('a typed label asks before it is left; a clean screen does not', async () => {
    const c = await open();
    assert.strictEqual(c.ctx.vdMayLeave(), true);
    const m = await open(); m.CMD.vdLbl('en', 'x');
    assert.strictEqual(m.ctx.vdMayLeave(), false);
    assert.strictEqual(m.ctx.state.ask.confirmLabel, 'Leave');
    assert.ok(/VD&&VD\.lblDirty&&\(state\.stack\|\|\[\]\)\.some\(f=>f&&f\.route==='coupon'\)/.test(MH), 'a reload asks too');
  });
  it('turn off and turn on', async () => {
    const { CMD, writes, toasts } = await open();
    CMD.vdTurn(0); await tick();
    const m = await open({ row: { is_active: 0 } });
    m.CMD.vdTurn(1); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers/5', body: { is_active: false }, method: 'PATCH' }]);
    assert.deepStrictEqual(m.writes, [{ p: '/vouchers/5', body: { is_active: true }, method: 'PATCH' }]);
    assert.deepStrictEqual(toasts, ['Turned off']);
    assert.deepStrictEqual(m.toasts, ['On — customers can use it now']);
  });
  it('three states: Saving… while out, and a second tap sends nothing', async () => {
    const { ctx, CMD, writes } = await open();
    CMD.vdTurn(0);
    assert.ok(ctx.screenCoupon().includes('Saving…'));
    CMD.vdSwitch('is_public');
    await tick();
    assert.strictEqual(writes.length, 1);
  });
  it('a failure stays on the screen with the server’s word; a refusal says why', async () => {
    const f = await open({ writeFails: 'not_found' });
    f.CMD.vdSwitch('is_public'); await tick();
    assert.ok(f.ctx.screenCoupon().includes('Failed: not_found'));
    assert.deepStrictEqual(f.toasts, []);
    const r = await open({ refused: true });
    r.CMD.vdTurn(0); await tick();
    assert.ok(r.ctx.screenCoupon().includes('Not allowed'));
  });
  it('success re-reads the list, and the screen reads the new row', async () => {
    const { ctx, CMD, reads } = await open({ after: ROW({ is_public: 1 }) });
    CMD.vdSwitch('is_public'); await tick();
    assert.ok(reads.includes('/vouchers'));
    assert.ok(/<toggle on="true" cmd="APP\.cmd\('vdSwitch','is_public'\)">/.test(ctx.screenCoupon()));
  });
}

section('3 · giving it out and taking it back');
{
  it('Take it back: the desktop’s confirm, then DELETE /voucher-grants/:id, then both lists read again', async () => {
    const { ctx, CMD, writes, toasts, reads } = await open();
    CMD.vdTakeBack(71);
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'Take this coupon back?');
    assert.strictEqual(a.body, 'They lose it at their next checkout. Orders they already placed keep their discount.');
    assert.strictEqual(a.confirmLabel, 'Take it back'); assert.strictEqual(a.danger, true);
    const n = reads.length;
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/voucher-grants/71', body: {}, method: 'DELETE' }]);
    assert.deepStrictEqual(toasts, ['Taken back']);
    assert.ok(reads.slice(n).includes('/vouchers') && reads.slice(n).includes('/vouchers/5/grants?limit=8'));
  });
  it('Take it back refused by the server (already used) says so', async () => {
    const { ctx, CMD } = await open({ writeFails: 'already_used_or_missing' });
    CMD.vdTakeBack(71); yes(ctx); await tick();
    assert.ok(ctx.screenCoupon().includes('Failed: already_used_or_missing'));
  });
  it('the grant screen: the note, grant to all, search, and who already has it', async () => {
    const { ctx, CMD, reads } = await open();
    CMD.vgOpen(); await tick();
    assert.strictEqual(ctx.state.stack[ctx.state.stack.length - 1].route, 'coupongrant');
    assert.ok(reads.includes('/vouchers/5/grants') && reads.includes('/customers?pageSize=20&page=1'));
    const h = ctx.screenCouponGrant();
    for (const s of ['Recipients see this in their wallet & checkout, no code needed.', 'Note (optional, internal only)',
      'Grant to every customer', 'Grant to all', 'Or grant to a specific customer', 'Search by name, phone, or openid…',
      'Ling', '#403', "APP.cmd('vgGrant',403)", 'Already granted', '<pill kind="draft">Unused</pill>', '<pill kind="live">Used</pill>'])
      assert.ok(h.includes(s), s);
    assert.ok(/vgRevoke',71\)/.test(h) && !/vgRevoke',72\)/.test(h), 'a used one-shot grant has no Revoke');
  });
  it('search goes into the read', async () => {
    const { CMD, reads } = await open();
    CMD.vgOpen(); await tick();
    CMD.vgQ('ch an'); await new Promise((r) => setTimeout(r, 260)); await tick();
    assert.strictEqual(reads.filter((p) => p.startsWith('/customers')).pop(), '/customers?pageSize=20&page=1&q=ch%20an');
  });
  it('grant to one customer: POST {customer_ids:[id], note}; already had it says so', async () => {
    const { CMD, writes, toasts } = await open();
    CMD.vgOpen(); await tick();
    CMD.vgNote('  goodwill  '); CMD.vgGrant(403); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers/5/grant', body: { customer_ids: [403], note: 'goodwill' }, method: undefined }]);
    assert.deepStrictEqual(toasts, ['Granted to customer #403']);
    const m = await open({ grantReply: { success: true, granted: 0, skipped: 1 } });
    m.CMD.vgOpen(); await tick(); m.CMD.vgGrant(401); await tick();
    assert.deepStrictEqual(m.writes[0].body, { customer_ids: [401], note: null });
    assert.deepStrictEqual(m.toasts, ['Customer already had this coupon']);
  });
  it('grant to all: the desktop’s confirm, then POST {to_all:true, note}, and the count', async () => {
    const { ctx, CMD, writes, toasts } = await open({ grantReply: { success: true, granted: 30, skipped: 2 } });
    CMD.vgOpen(); await tick();
    CMD.vgAll();
    assert.strictEqual(ctx.state.ask.title, 'Grant this coupon to every customer?');
    assert.strictEqual(ctx.state.ask.body, 'Existing grants are kept.');
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Grant to all');
    assert.strictEqual(writes.length, 0, 'nothing until yes');
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/vouchers/5/grant', body: { to_all: true, note: null }, method: undefined }]);
    assert.deepStrictEqual(toasts, ['Granted to 30 customers (2 already had it)']);
  });
  it('revoke: the desktop’s confirm, then DELETE /voucher-grants/:id', async () => {
    const { ctx, CMD, writes } = await open();
    CMD.vgOpen(); await tick();
    CMD.vgRevoke(71);
    assert.strictEqual(ctx.state.ask.title, 'Revoke this grant?');
    assert.strictEqual(ctx.state.ask.danger, true);
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/voucher-grants/71', body: {}, method: 'DELETE' }]);
  });
  it('a standing coupon: everyone "Has it", and every row can be revoked', async () => {
    const { ctx, CMD } = await open({ row: { per_customer_limit: 0 } });
    CMD.vgOpen(); await tick();
    const h = ctx.screenCouponGrant();
    assert.ok(h.includes('Has it') && !h.includes('Unused'));
    assert.ok(/vgRevoke',71\)/.test(h) && /vgRevoke',72\)/.test(h));
  });
  it('empty and failed: no grants yet, no customers match, a failed search and list', async () => {
    const e = await open({ holders: [], customers: [] });
    e.CMD.vgOpen(); await tick();
    const h = e.ctx.screenCouponGrant();
    assert.ok(h.includes('No grants yet.') && h.includes('No customers match.'));
    const f = await open({ searchFails: true });
    f.CMD.vgOpen(); await tick();
    assert.ok(f.ctx.screenCouponGrant().includes('Failed: down'));
    const m = mk({ grantsFail: true }); m.CMD.vchOpen(5); await tick(); m.CMD.vgOpen(); await tick();
    const gh = m.ctx.screenCouponGrant();
    assert.ok(gh.includes('Failed: boom') && gh.includes("APP.cmd('vgGrantsRetry')"));
  });
  it('a failed grant stays on the screen', async () => {
    const { ctx, CMD, toasts } = await open({ writeFails: 'no_customers' });
    CMD.vgOpen(); await tick(); CMD.vgGrant(403); await tick();
    assert.ok(ctx.screenCouponGrant().includes('Failed: no_customers'));
    assert.deepStrictEqual(toasts, []);
  });
}

section('4 · the keys');
{
  it('coupons:view alone: every fact read-only, no switch, no Save, no Give, no Take it back — and the commands send nothing', async () => {
    const { ctx, CMD, writes } = await open({ caps: ['coupons:view'] });
    const h = ctx.screenCoupon();
    assert.ok(!h.includes('<toggle') && !h.includes('<select') && !h.includes('type="date"') && !h.includes('Save label'));
    assert.ok(!h.includes('Give to a customer') && !h.includes('vdTakeBack') && !h.includes('Turn off'));
    assert.ok(h.includes('Once') && h.includes('2099-06-15') && h.includes('Welcome'));
    CMD.vdSwitch('is_public'); CMD.vdExpiry(''); CMD.vdPer('0'); CMD.vdTurn(0); CMD.vdSaveLabel(); CMD.vdTakeBack(71);
    CMD.vgOpen(); await tick(); CMD.vgGrant(403); CMD.vgAll(); CMD.vgRevoke(71); await tick();
    assert.strictEqual(ctx.state.ask, null);
    assert.deepStrictEqual(writes, []);
    const g = ctx.screenCouponGrant();
    assert.ok(g.includes('Already granted') && !g.includes('Grant to all') && !g.includes('vgRevoke'));
  });
  it('coupons:edit without coupons:grant: the coupon changes, nothing is given or taken', async () => {
    const { ctx, CMD, writes } = await open({ caps: ['coupons:view', 'coupons:edit'] });
    const h = ctx.screenCoupon();
    assert.ok(h.includes('<toggle') && h.includes('Save label') && !h.includes('Give to a customer') && !h.includes('vdTakeBack'));
    CMD.vdTakeBack(71); assert.strictEqual(ctx.state.ask, null);
    CMD.vdSwitch('auto_apply'); await tick();
    assert.deepStrictEqual(writes.map((w) => w.p), ['/vouchers/5']);
  });
  it('coupons:grant without coupons:edit: given and taken, not changed', async () => {
    const { ctx, CMD, writes } = await open({ caps: ['coupons:view', 'coupons:grant'] });
    const h = ctx.screenCoupon();
    assert.ok(!h.includes('<toggle') && h.includes('Give to a customer') && h.includes('vdTakeBack'));
    CMD.vdTurn(0); await tick();
    assert.deepStrictEqual(writes, []);
  });
  it('keys not yet known: both fail closed (money: moves)', async () => {
    const { ctx, CMD, writes } = await open({ caps: null });
    const h = ctx.screenCoupon();
    assert.ok(!h.includes('<toggle') && !h.includes('Give to a customer') && !h.includes('Turn off'));
    CMD.vdTurn(0); CMD.vdTakeBack(71); await tick();
    assert.deepStrictEqual(writes, []);
    assert.strictEqual(ctx.state.ask, null);
  });
  it('the server agrees on the keys', () => {
    const { requiredCapFor } = require(path.join(ROOT, 'lib/cap-routes.js'));
    const cap = (m, p) => requiredCapFor(m, '/api/retail-admin' + p);
    assert.strictEqual(cap('PATCH', '/vouchers/5'), 'coupons:edit');
    assert.strictEqual(cap('POST', '/vouchers/5/grant'), 'coupons:grant');
    assert.strictEqual(cap('DELETE', '/voucher-grants/71'), 'coupons:grant');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
