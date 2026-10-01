#!/usr/bin/env node
/**
 * §325 S1d — FOUR FOLLOW-UPS TO THE PHONE SAFETY STEPS.
 *
 *   node scripts/test_mobile_safety_followups.js
 *
 *   1. The §298 category banner editor is drawn and pressed only for the keys
 *      its writes need: categories:edit (PUT /category-tree), and media:upload
 *      as well for a picture (POST /media/upload).
 *   2. The empty media library invites "Add photos from this phone" only when
 *      the Add photos button is drawn.
 *   3. Approve refund on the phone carries the rest of §222's block, as the
 *      desktop draws it: the full / partial consequence line and "refunding
 *      never changes the delivery day".
 *   4. The DESKTOP new-order form says "cannot create customers" only for the
 *      handler's customers:edit refusal; any other forbidden_capability gets
 *      the general sentence (TD_ERR).
 *
 * The code is RUN, sliced out of the live files into sandboxes. No browser —
 * fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ORD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function cut(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function topFn(src, head) {
  const a = src.indexOf(head);
  assert.ok(a >= 0, 'no ' + head);
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const cmds = (html) => [...String(html).matchAll(/APP\.cmd\('([\w$]+)'/g)].map((m) => m[1]);

/* ─────────────────────────────────────────────────────────────────────── */
section('1 · the category banner editor');
{
  const SRC = cut(M, 'const CAT_BANNER_PAGES=', 'function statusCategories(){');
  const B = { image_url: '/api/retail/media/12', target: 'promotions', start_at: '2026-10-01', end_at: '' };
  const tree = (banner) => [{ id: 'fresh', name: 'Fresh & Deli', subs: [], banner }];
  function mk(caps, banner) {
    const calls = { writes: [], files: 0, fetches: 0 };
    const CMD = {};
    const ctx = {
      T: (en) => en, LANG: 'en', API: '/api/retail-admin',
      escAttr: (s) => String(s == null ? '' : s).replace(/"/g, '&quot;'), ic: () => '',
      state: { caps, cats: tree(banner), catTop: 'fresh', catShelf: { top: 'Fresh & Deli', rows: [] } },
      mCan: (k) => (caps ? [].concat(k).some((x) => caps.includes(x)) : true),
      render: () => {}, reg: (n, f) => { CMD[n] = f; }, showToast: () => {}, loadCategories: () => {},
      apiRaw: () => Promise.resolve({ data: [] }),
      apiWrite: async (p, body, method) => { calls.writes.push({ p, method }); return { success: true }; },
      fetch: async () => { calls.fetches++; return { status: 200, json: async () => ({}) }; },
      FormData: class { append() {} }, createImageBitmap: async () => { throw new Error('x'); },
      document: { createElement: () => { calls.files++; return { click() {} }; } },
      URLSearchParams, Object, Promise, Math, Date, String, Array, JSON, Error, location: {},
    };
    vm.createContext(ctx); vm.runInContext(SRC, ctx);
    return { ctx, CMD, calls, card: () => ctx.catBannerCard(ctx.state.cats[0]) };
  }
  it('both keys: Add, then Replace, the link, the dates and Remove', () => {
    assert.deepStrictEqual(cmds(mk(['categories:edit', 'media:upload']).card()), ['catBannerPick']);
    const html = mk(['categories:edit', 'media:upload'], { ...B }).card();
    assert.deepStrictEqual(cmds(html), ['catBannerSet', 'catBannerSet', 'catBannerSet', 'catBannerPick', 'catBannerRemove']);
  });
  it('categories:edit without media:upload: no Add, no Replace; the link, dates and Remove stay', () => {
    assert.strictEqual(mk(['categories:edit']).card(), '');
    assert.deepStrictEqual(cmds(mk(['categories:edit'], { ...B }).card()), ['catBannerSet', 'catBannerSet', 'catBannerSet', 'catBannerRemove']);
  });
  it('neither: no banner draws nothing; a banner is read — picture, status, link, dates — with nothing to press', () => {
    assert.strictEqual(mk(['categories:view']).card(), '');
    const html = mk(['categories:view'], { ...B }).card();
    assert.deepStrictEqual(cmds(html), []);
    assert.ok(html.includes('<img src="/api/retail/media/12"') && html.includes('Tap link') && html.includes('2026-10-01'));
    assert.ok(!html.includes('<select') && !html.includes('<input'));
  });
  it('the commands refuse on the same keys: no write, no picker, no upload', async () => {
    const h = mk(['categories:view'], { ...B });
    h.CMD.catBannerSet('target', 'coupons'); h.CMD.catBannerRemove(); h.CMD.catBannerPick();
    await h.ctx.catBannerUpload({ type: 'image/png' });
    await tick();
    assert.deepStrictEqual(h.calls.writes, []);
    assert.strictEqual(h.calls.files, 0); assert.strictEqual(h.calls.fetches, 0);
    const e = mk(['categories:edit'], { ...B });
    e.CMD.catBannerPick(); assert.strictEqual(e.calls.files, 0, 'a picker opened without media:upload');
    e.CMD.catBannerSet('target', 'coupons'); await tick();
    assert.deepStrictEqual(plain(e.calls.writes), [{ p: '/category-tree', method: 'PUT' }]);
  });
}

section('2 · the empty media library');
{
  it('the invitation is made only through mCan(\'media:upload\'), the Add photos button\'s own key', () => {
    const r = cut(M, "if(!state.media.rows.length) return", '\n    return `');
    assert.ok(/mCan\('media:upload'\)\?T\('Add photos from this phone/.test(r), r);
    assert.ok(r.includes(":'');"));
    assert.ok(M.includes("cta:()=>{ if(!mCan('media:upload')) return ''; const b=state.mediaBusy;"));
  });
  it('nothingYet with no message draws no empty line', () => {
    const ctx = {};
    vm.createContext(ctx); vm.runInContext(topFn(M, 'function nothingYet(title,msg){'), ctx);
    assert.ok(!ctx.nothingYet('Empty', '').includes('max-width:270px'));
    assert.ok(ctx.nothingYet('Empty', 'Body').includes('Body'));
  });
}

section('3 · Approve refund carries all of §222\'s block');
{
  /* §325 O3: Approve is the desktop's approve FORM now (sheetRefundForm), and
     §222's block sits where the desktop puts it — above the form's button,
     recomputed as the amount, the lines or the mode change. Every S1d case is
     asked of the form. */
  const FULL = 'Full refund: the order is marked refunded, its same-city delivery is cancelled, and stock, points and referral credit are reversed. The customer is told.';
  const PART = 'Partial refund: the order keeps its status and its delivery. Stock reverses for the selected items only. The customer is told.';
  const DAY = 'Refunding never changes the delivery day. If the customer only wants it another day, reject this and change the date instead.';
  const RIDER = 'A rider is on this order right now — approving cancels that delivery.';
  const SRC = [cut(M, 'const MCAN_MONEY_ONLY=', 'function canRoute('), cut(M, "reg('advance', to=>{", 'function currentOrder(){')].join('\n');
  function mk(order, lang, read) {
    const CMD = {};
    const ctx = { LANG: lang || 'en', CUR: '¥', state: { caps: null, ask: null, detailActions: false, rf: null, detailId: 'R-9', liveDetail: null },
      render: () => {}, reg: (n, f) => { CMD[n] = f; },
      currentOrder: () => ctx.state.liveDetail || Object.assign({ id: 'R-9', _id: 9, totalNum: 120, rfItems: [], refundLineIds: [] }, order),
      escAttr: (v) => String(v == null ? '' : v), ic: () => '', money: (c, n) => c + Number(n).toFixed(2),
      api: () => Promise.resolve({}), mapDetail: () => Object.assign({ id: 'R-9', _id: 9, totalNum: 120, rfItems: [], refundLineIds: [] }, read || {}),
      E: (en, zh) => ({ toString() { return ctx.T(en, zh); } }), document: { getElementById: () => null },
      Object, Promise, Math, Number, String, Array, JSON };
    ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
    vm.createContext(ctx); vm.runInContext(SRC, ctx);
    CMD.approveRefund();
    ctx.form = () => ctx.sheetRefundForm();
    ctx.CMD = CMD;
    return ctx;
  }
  it('every sentence is the desktop\'s pair, copied whole', () => {
    for (const [en, zh] of [[FULL, '全额退款:订单将标记为已退款,同城配送将被取消,库存、积分与推荐奖励一并退回。系统会通知顾客。'],
      [PART, '部分退款:订单状态与配送均不变,仅退回所选商品的库存。系统会通知顾客。'],
      [DAY, '退款不会更改配送日期。如顾客只是想改天收货,请拒绝此申请并改期。']]) {
      assert.ok(ORD.includes(`'${en}'`) && ORD.includes(`'${zh}'`), 'desktop lost: ' + en.slice(0, 30));
      assert.ok(M.includes(`T('${en}',`) && M.includes(`'${zh}'`), 'phone lacks: ' + en.slice(0, 30));
    }
  });
  it('a full approve: the full line, a brick edge, and the day line', () => {
    const b = mk({ refund: { gross: 120, approved: 0, requested: null } }).form();
    assert.ok(b.includes(FULL) && !b.includes(PART) && b.includes(DAY));
    assert.ok(b.includes('border-left:3px solid var(--brick-ink)'));
  });
  it('a partial one (points make the gross larger): the partial line, a quiet edge, no rider', () => {
    const b = mk({ refund: { gross: 150, approved: 0, requested: 120 }, courier: { stage: 'in_transit' } }).form();
    assert.ok(b.includes(PART) && !b.includes(FULL) && !b.includes(RIDER) && b.includes(DAY));
    assert.ok(b.includes('border-left:3px solid var(--border-default)'));
  });
  it('full with a rider on the road: all three, in the desktop\'s order, above the button', () => {
    const b = mk({ refund: { gross: 120, approved: 0 }, courier: { stage: 'heading_to_pickup' } }).form();
    assert.ok(b.indexOf(FULL) < b.indexOf(RIDER) && b.indexOf(RIDER) < b.indexOf(DAY));
    assert.ok(b.indexOf(DAY) < b.indexOf("APP.cmd('rfSubmit')"));
  });
  it('the block follows the form: switching a full approve to a smaller amount turns it partial', () => {
    const c = mk({ refund: { gross: 120, approved: 0, requested: null }, courier: { stage: 'in_transit' } });
    assert.ok(c.form().includes(FULL) && c.form().includes(RIDER));
    c.CMD.rfMode('amount'); c.CMD.rfType('amount', '20');
    const b = c.form();
    assert.ok(b.includes(PART) && !b.includes(FULL) && !b.includes(RIDER) && b.includes(DAY));
  });
  it('figures not read: no full/partial claim — nor any button — until they are, then the real block', async () => {
    const c = mk({ refund: null, rfItems: undefined, courier: { stage: 'in_transit' } }, 'en',
      { refund: { gross: 120, approved: 0 }, courier: { stage: 'in_transit' } });
    let b = c.form();
    assert.ok(!b.includes(FULL) && !b.includes(PART) && !b.includes('rfSubmit') && b.includes('Loading…'));
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    b = c.form();
    assert.ok(b.includes(FULL) && b.includes(RIDER) && b.includes(DAY));
  });
  it('in Chinese, the Chinese halves', () => {
    const zh = mk({ refund: { gross: 120, approved: 0 } }, 'zh').form();
    assert.ok(zh.includes('全额退款:') && zh.includes('退款不会更改配送日期。'));
  });
}

section('4 · the desktop new-order form names the customer box only when that is the refusal');
{
  const SRC = [
    'var LANG="en"; function cuT(en, zh){ return LANG==="en"?en:zh; }',
    cut(CORE, 'const TD_ERR = {', '\n};\n') + '\n};\n',
    topFn(CORE, 'function tdErrorText(code, serverMessage) {'),
    'var ONW = { lines: [] };',
    cut(ORD, 'const ONW_OPTION_CODES = [', ';\n') + ';\n',
    cut(ORD, 'const ONW_ERR_WHERE = {', '\n};\n') + '\n};\n',
    topFn(ORD, 'function ordNewErrText(code, detail, productId) {'),
    'let _ORD_NEW_BUSY = false;',
    topFn(ORD, 'async function ordNewCreate(ev) {'),
  ].join('\n');
  async function run(reply) {
    const shown = [];
    const ctx = {
      ordNewClearErrors: () => {}, ordNewCollect: () => ({ items: [] }), ordNewValidate: () => null, ordNewSetBusy: () => {},
      ordNewShowError: (slot, msg) => shown.push([slot, msg]),
      document: { getElementById: () => ({ textContent: '' }) },
      fetch: async () => ({ ok: false, status: 403, json: async () => reply }),
      Object, Promise, Number, String, Array, JSON,
    };
    vm.createContext(ctx); vm.runInContext(SRC, ctx);
    await ctx.ordNewCreate({ currentTarget: { textContent: '' } });
    return shown;
  }
  it('the handler\'s customers:edit refusal keeps its own sentence', async () => {
    assert.deepStrictEqual(plain(await run({ success: false, error: 'forbidden_capability', need: 'customers:edit' })),
      [['cust', 'Your account cannot create customers. Clear "Also save as a customer" to place the order.']]);
  });
  it('the choke point\'s orders:edit refusal gets the general sentence', async () => {
    assert.deepStrictEqual(plain(await run({ error: 'forbidden_capability', need: 'orders:edit' })),
      [['cust', 'Your role does not include this action. An owner can grant it on the Team page.']]);
  });
  it('so does one that names no key', async () => {
    assert.deepStrictEqual(plain(await run({ error: 'forbidden_capability' }))[0][1],
      'Your role does not include this action. An owner can grant it on the Team page.');
  });
  it('the phone answers the same refusal the same way (S1a)', () => {
    assert.ok(M.includes("const custRefused=e.code==='forbidden_capability'&&e.body&&e.body.need==='customers:edit';"));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
