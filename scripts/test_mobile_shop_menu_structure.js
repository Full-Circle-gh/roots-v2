#!/usr/bin/env node
/**
 * §325 step PD13 — A SHOP MENU'S STRUCTURE FROM THE PHONE.
 *
 *   node scripts/test_mobile_shop_menu_structure.js
 *
 * The desktop is the spec: public/retail-admin/28-shops.js — shpCreate (POST
 * /shops {location_id}), details() with shpSaveName (PATCH {display_name_en} /
 * {display_name_cn}) and shpToggleActive (PATCH {is_active}), and shpMove with
 * moveTargets (§177: where, then what it costs, then POST /shops/:id/move
 * {to_location_id}, landing on the destination). The phone code is RUN, lifted
 * out of public/m.html by name into a sandbox with a fake server, so every
 * write is asserted on method, path and every body field, before and after its
 * confirms. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const SHOPS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/28-shops.js'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');

const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m);
let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}

/* ── Lifting by name ─────────────────────────────────────────────────────────
   A small scanner that knows strings, comments, regex literals and NESTED
   template literals (this file's markup is templates inside templates), so a
   function is cut at its own closing brace and nowhere else. */
function skipBalanced(src, i) {
  const open = src[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  const stack = [{ t: 'code', depth: 0 }];
  let prev = '';
  for (; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top.t === 'tmpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); prev = '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ t: 'code', depth: 0, inTmpl: true }); i++; continue; }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      prev = c; continue;
    }
    if (c === '`') { stack.push({ t: 'tmpl' }); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); prev = ''; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      prev = 'x'; continue;
    }
    if (c === '{' || c === '(' || c === '[') top.depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (top.inTmpl && top.depth === 0 && c === '}') { stack.pop(); prev = '}'; continue; }
      top.depth--;
      if (stack.length === 1 && top.depth === 0 && c === close) return i + 1;
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('unbalanced from ' + src.slice(i, i + 40));
}
function liftFn(name) {
  const at = M.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, 'cannot find function ' + name);
  const body = M.indexOf('{', M.indexOf(')', at));
  return M.slice(at + 1, skipBalanced(M, body));
}
function liftConst(name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=').exec(M);
  const at = m ? m.index : -1;
  assert.ok(at >= 0, 'cannot find const ' + name);
  // To the first `;` outside any bracket, string or template.
  let i = at + 1;
  while (i < M.length) {
    const c = M[i];
    if (c === '{' || c === '(' || c === '[') { i = skipBalanced(M, i); continue; }
    if (c === '"' || c === "'") { for (i++; M[i] !== c; i++) if (M[i] === '\\') i++; i++; continue; }
    if (c === ';') return M.slice(at + 1, i + 1);
    i++;
  }
  throw new Error('cannot end const ' + name);
}
function liftReg(name) {
  const at = M.indexOf("\nreg('" + name + "',");
  assert.ok(at >= 0, 'cannot find reg ' + name);
  const open = M.indexOf('(', at + 1);
  return M.slice(at + 1, skipBalanced(M, open)) + ';';
}


const FNS = ['E', 'pill', 'toggle', 'mCan', 'searchBox', 'searchClearShow', 'nothingYet',
  'shmName', 'shmLocName', 'loadShopMenus', 'loadShopMenu', 'shmErrBox', 'screenShopMenus', 'screenShopMenu', 'shmProdName',
  'shmShown', 'shmListHtml', 'shmWriteErr', 'shmStructErr', 'shmHere', 'shmMoveTargets', 'shmDetailsCard', 'shmStructDone'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'money', 'shmLoading', 'shmCanEdit', 'shmLocIn'];
const REGS = ['askRun', 'shmOpen', 'shmSetup', 'shmDisplayName', 'shmActive', 'shmMoveAsk', 'shmMoveConfirm', 'shmMove'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const LIST = () => [
  { location: { id: 1, code: 'TH', name_en: 'Tianhe', name_cn: '天河' }, shop: { id: 3, public_code: 'K7Q2', display_name_en: null, display_name_cn: null, is_active: 1, listing_count: 2 } },
  { location: { id: 2, code: 'YX', name_en: 'Yuexiu', name_cn: '越秀' }, shop: null },
  { location: { id: 4, code: 'PY', name_en: 'Panyu', name_cn: '番禺' }, shop: { id: 5, public_code: 'P9X1', is_active: 0, listing_count: 0 } },
  { location: { id: 6, code: 'HZ', name_en: 'Haizhu', name_cn: '海珠' }, shop: { id: 7, public_code: 'H2Z2', is_active: 1, listing_count: 4 } }];
const SHOP = (o) => Object.assign({ id: 3, location_id: 1, public_code: 'K7Q2', display_name_en: null, display_name_cn: null, is_active: 1, updated_at: 'x' }, o || {});
const ROWS = () => [{ id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', price: 18, fulfilment_mode: 'stocked', is_available: 1 },
  { id: 12, name_en: 'Latte', name_cn: '拿铁', sku: 'LT-1', price: 28, fulfilment_mode: 'made_here', is_available: 1 }];
const ALL = ['dashboard:view', 'stores:view', 'stores:edit'];
const REFUSED = ['You don’t have permission to do that.', '你没有执行此操作的权限。'];
const refusal = () => Object.assign(new Error('forbidden'), { refused: true, words: REFUSED, code: 'forbidden' });

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], pushed: [] };
  const CMD = {};
  const serve = opts.serve || ((p) => (p === '/shops' ? LIST() : /^\/shops\/\d+$/.test(p) ? { shop: SHOP({ id: Number(p.split('/')[2]) }), listings: ROWS() } : /\/qr$/.test(p) ? { url: 'https://x/s/K7Q2' } : {}));
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    CMD, SUBS: {},
    state: { caps: opts.caps === undefined ? ALL : opts.caps, ask: null, askErr: null, stack: [],
      shm: { list: opts.list === undefined ? LIST() : opts.list, err: null, tried: true, seq: 0, id: opts.id === undefined ? 3 : opts.id, oneFor: 3,
        shop: opts.shop === undefined ? SHOP() : opts.shop, rows: opts.rows || ROWS(), oneErr: null, oneSeq: 0, qr: { url: 'https://x/s/K7Q2' }, q: '',
        busy: {}, writeErr: null, edit: null, pick: null, setup: null, listErr: null, shopBusy: null, shopErr: null } },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushed.push(r); },
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => { calls.reads.push(p); const v = serve(p); return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body || {})), method: method || 'POST', res, rej });
    }),
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state.shm, st: ctx.state,
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

section('1 · Set up a location’s shop');
it('a location with no shop offers Set up to stores:edit; without it, only the board’s word', () => {
  const h = mk(); const html = h.ctx.screenShopMenus();
  assert.ok(html.includes("APP.cmd('shmSetup',2)") && h.text(html).includes('Yuexiu Not set up Set up'));
  const r = mk({ caps: ['dashboard:view', 'stores:view'] }); const t = r.ctx.screenShopMenus();
  assert.ok(!t.includes('shmSetup') && r.text(t).includes('Yuexiu Not set up'));
  r.CMD.shmSetup(2); assert.strictEqual(r.calls.writes.length, 0);
});
it('Set up: POST /shops {location_id}; the button says Saving… and the others wait', () => {
  const h = mk(); h.CMD.shmSetup(2);
  same(h.w(0), { p: '/shops', method: 'POST', body: { location_id: 2 } });
  const html = h.ctx.screenShopMenus();
  assert.ok(/disabled onclick="APP\.cmd\('shmSetup',2\)">Saving…/.test(html));
  h.CMD.shmSetup(2); assert.strictEqual(h.calls.writes.length, 1);
});
it('a location that already has a shop is not set up again', () => {
  const h = mk(); h.CMD.shmSetup(1); assert.strictEqual(h.calls.writes.length, 0);
});
it('done: Saved, the list read again, and the new shop opens', async () => {
  const h = mk(); h.CMD.shmSetup(2);
  h.calls.writes[0].res({ success: true, data: { shop: SHOP({ id: 9, location_id: 2 }), listings: [] } }); await settle();
  same(h.calls.toasts, ['Saved']);
  assert.ok(h.calls.reads.includes('/shops'));
  same([h.s.id, h.calls.pushed], [9, ['shopmenu']]);
});
it('refused: said above the list, and it stays', async () => {
  const h = mk(); h.CMD.shmSetup(2); h.calls.writes[0].rej(refusal()); await settle();
  assert.ok(h.text(h.ctx.screenShopMenus()).startsWith('You don’t have permission to do that.'));
  same([h.s.setup, h.calls.toasts], [null, []]);
});

section('2 · The shop’s names and its switch');
it('stores:edit sees the card: both names (the location’s as the hint), On, and Move products', () => {
  const h = mk(); const html = h.ctx.shmDetailsCard(), t = h.text(html);
  assert.ok(t.startsWith('English name (optional) Chinese name On'), t);
  assert.ok(html.includes('placeholder="Tianhe"') && html.includes('placeholder="天河"'));
  assert.ok(t.includes('Move products'));
  assert.ok(h.ctx.screenShopMenu().includes(html), 'drawn on the record');
  assert.strictEqual(mk({ caps: ['dashboard:view'] }).ctx.shmDetailsCard(), '', 'and only for stores:edit');
});
it('a name, when its box is left: PATCH /shops/3 {display_name_en}; unchanged sends nothing', async () => {
  const named = (p) => (p === '/shops' ? LIST() : p === '/shops/3' ? { shop: SHOP({ display_name_en: 'Tianhe Kitchen' }), listings: ROWS() } : { url: null });
  const h = mk({ serve: named }); h.CMD.shmDisplayName('display_name_en', '');
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.shmDisplayName('display_name_en', 'Tianhe Kitchen');
  same(h.w(0), { p: '/shops/3', method: 'PATCH', body: { display_name_en: 'Tianhe Kitchen' } });
  assert.ok(h.text(h.ctx.shmDetailsCard()).includes('Saving…'));
  assert.ok(/<input value="" placeholder="天河" disabled/.test(h.ctx.shmDetailsCard()), 'the card waits');
  h.calls.writes[0].res({ success: true, data: { shop: SHOP({ display_name_en: 'Tianhe Kitchen' }) } }); await settle();
  assert.strictEqual(h.s.shop.display_name_en, 'Tianhe Kitchen');
  assert.ok(h.calls.reads.includes('/shops') && h.calls.reads.includes('/shops/3'), 'list and record read again');
});
it('the Chinese name the same way: PATCH {display_name_cn}', () => {
  const h = mk(); h.CMD.shmDisplayName('display_name_cn', '天河厨房');
  same(h.w(0).body, { display_name_cn: '天河厨房' });
  h.CMD.shmDisplayName('public_code', 'X'); assert.strictEqual(h.calls.writes.length, 1, 'never the code');
});
it('Off: PATCH {is_active: 0}, not optimistic — the switch says … and keeps its place if refused', async () => {
  const h = mk(); h.CMD.shmActive();
  same(h.w(0), { p: '/shops/3', method: 'PATCH', body: { is_active: 0 } });
  assert.ok(h.text(h.ctx.shmDetailsCard()).includes('On …'));
  h.calls.writes[0].rej(refusal()); await settle();
  same([h.s.shop.is_active, h.s.shopBusy], [1, null]);
  assert.ok(h.text(h.ctx.shmDetailsCard()).includes('You don’t have permission to do that.'));
});
it('On, for a shop that is off: PATCH {is_active: 1}', () => {
  const h = mk({ shop: SHOP({ is_active: 0 }) }); assert.ok(h.text(h.ctx.shmDetailsCard()).includes('Off'));
  h.CMD.shmActive(); same(h.w(0).body, { is_active: 1 });
});
it('without stores:edit every structural command refuses', () => {
  const h = mk({ caps: ['dashboard:view'] });
  h.CMD.shmDisplayName('display_name_en', 'X'); h.CMD.shmActive(); h.CMD.shmMoveAsk(); h.CMD.shmMove(4);
  same([h.calls.writes.length, h.st.ask], [0, null]);
});

section('3 · Move products (§177): where, then what it costs');
it('the places offered: every other location whose menu is empty — a shop with listings is not one', () => {
  const h = mk(); h.CMD.shmMoveAsk();
  assert.strictEqual(h.st.ask.title, 'Move products to another location?');
  same(h.st.ask.options.map((o) => [o.key, o.label]), [['2', 'Yuexiu'], ['4', 'Panyu']]);
  assert.strictEqual(h.calls.writes.length, 0);
});
it('no Move products on an empty menu, or when there is nowhere to go', () => {
  assert.ok(!mk({ rows: [] }).text(mk({ rows: [] }).ctx.shmDetailsCard()).includes('Move products'));
  const full = LIST().map((x) => (x.location.id === 1 ? x : Object.assign({}, x, { shop: { id: 50 + x.location.id, listing_count: 1, is_active: 1 } })));
  const h = mk({ list: full }); assert.ok(!h.text(h.ctx.shmDetailsCard()).includes('Move products'));
  h.CMD.shmMoveAsk(); assert.strictEqual(h.st.ask, null);
});
it('the second ask names the count, the place, the emptied menu, the dead QR and the reprint — a danger confirm, nothing sent yet', () => {
  const h = mk(); h.CMD.shmMoveAsk(); h.CMD.askRun('4');
  assert.strictEqual(h.st.ask.title, 'Move 2 products to Panyu?');
  assert.strictEqual(h.st.ask.body, 'This menu is emptied and this shop switches off, so the QR already printed here stops working. Panyu has its own code, so a new QR has to be printed there.');
  same([h.st.ask.confirmLabel, h.st.ask.danger, h.calls.writes.length], ['Move', true, 0]);
});
it('Move: POST /shops/3/move {to_location_id}; the button says Saving…', () => {
  const h = mk(); h.CMD.shmMoveAsk(); h.CMD.askRun('4'); h.CMD.askRun('');
  same(h.w(0), { p: '/shops/3/move', method: 'POST', body: { to_location_id: 4 } });
  assert.ok(/disabled onclick="APP\.cmd\('shmMoveAsk'\)">Saving…/.test(h.ctx.shmDetailsCard()));
});
it('moved: Moved, and the screen lands on the destination’s menu, read fresh', async () => {
  const h = mk(); h.CMD.shmMoveAsk(); h.CMD.askRun('4'); h.CMD.askRun('');
  h.calls.writes[0].res({ success: true, data: { from: SHOP({ is_active: 0 }), to: SHOP({ id: 5, location_id: 4 }), listings: ROWS(), moved: 2, created: false } });
  await settle();
  same(h.calls.toasts, ['Moved']);
  assert.strictEqual(h.s.id, 5);
  assert.ok(h.calls.reads.includes('/shops/5') && h.calls.reads.includes('/shops'));
  assert.strictEqual(h.s.shop.id, 5);
});
it('the server’s three refusals, in the desktop’s words, on the card; nothing toasts', async () => {
  for (const [code, words] of [['destination_has_menu', 'That location already has a menu of its own.'],
    ['nothing_to_move', 'There is nothing on this menu to move.'], ['same_location', 'The menu is already at that location.']]) {
    const h = mk(); h.CMD.shmMove(4);
    h.calls.writes[0].rej(Object.assign(new Error(code), { code })); await settle();
    assert.ok(h.text(h.ctx.shmDetailsCard()).includes(words), code);
    same([h.s.id, h.calls.toasts], [3, []]);
    assert.ok(CORE_JS.includes(code + ':') && CORE_JS.includes("'" + words + "'"), 'the desktop’s own sentence for ' + code);
  }
});
it('in Chinese: the desktop’s question and warning', () => {
  const h = mk({ lang: 'zh' }); h.CMD.shmMoveAsk();
  assert.strictEqual(h.st.ask.title, '移动商品到其他门店？');
  same(h.st.ask.options.map((o) => o.label), ['越秀', '番禺']);
  h.CMD.askRun('2');
  assert.strictEqual(h.st.ask.title, '移动 2 个商品到越秀？');
  assert.strictEqual(h.st.ask.body, '此门店的商品将被清空,门店将停用,已打印的二维码将失效。越秀 有自己的编码,需要重新打印二维码。');
  const t = h.text(h.ctx.shmDetailsCard());
  ['英文名(可选)', '中文名', '已开启', '移动商品'].forEach((w) => assert.ok(t.includes(w), w));
});

section('4 · The desktop is the spec');
it('the same requests, the same targets rule, the same two asks', () => {
  assert.ok(SHOPS_JS.includes("api('/api/retail-admin/shops', { method: 'POST', body: { location_id: _loc.id } })"));
  assert.ok(SHOPS_JS.includes("{ method: 'PATCH', body: { [field]: val } }"));
  assert.ok(SHOPS_JS.includes("{ method: 'PATCH', body: { is_active: want } }"));
  assert.ok(SHOPS_JS.includes("method: 'POST', body: { to_location_id: target.location.id },"));
  assert.ok(SHOPS_JS.includes('x.location.id !== _loc.id && !(x.shop && x.shop.listing_count > 0)'));
  assert.ok(SHOPS_JS.includes("titleEn: 'Move products to another location?', titleCn: '移动商品到其他门店？',"));
  assert.ok(SHOPS_JS.includes('window.shopMenuOpen(target.location.code);'), 'it lands on the destination');
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
