#!/usr/bin/env node
/**
 * §325 step PD2 — A PRODUCT'S SALES AND VERSION HISTORY, AND THE SHOP MENUS,
 * READ ON THE PHONE.
 *
 *   node scripts/test_mobile_products_records.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js (pdLoadSales,
 * pdSalesContext, pdOpenVersions) and public/retail-admin/28-shops.js (the
 * shop menu's read half). The phone code is RUN, lifted out of public/m.html
 * by name into a sandbox with a fake server, so every read is asserted on the
 * request it sends. No browser — fast shard.
 *
 * What it pins:
 *   1. the Sales card — the request per size and per window, a newer window
 *      winning over an older answer, units / revenue / rank and the two
 *      sentences, revenue withheld from a no-money board, the failed read;
 *   2. Version history — the list, Current / Original / who, empty and
 *      failed, and no Restore button while the step is read-only;
 *   3. shop menus — every location (not set up, inactive, counted), one shop's
 *      code, QR picture, the address it opens or why it cannot, Download, its
 *      listings with price, kind and availability, the filter, and the
 *      empty / failed states; the door opens for the desktop board's any-of;
 *   4. every string is a live pair.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const SHOPS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/28-shops.js'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

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

const FNS = ['chipRow', 'searchBox', 'searchClearShow', 'nothingYet', 'E', 'pill', 'toggle', 'mCan', 'canRoute',
  'loadProdSales', 'psWhen', 'psContext', 'psTitle', 'salesCard', 'versionsRow', 'loadProdVersions', 'pvWhen',
  'sheetVersions',
  'shmName', 'shmLocName', 'loadShopMenus', 'loadShopMenu', 'shmErrBox', 'screenShopMenus', 'shmProdName',
  'shmShown', 'shmListHtml', 'screenShopMenu'];
const CONSTS = ['PILL', 'KIND2PILL', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'money0', 'shopDayAdd', 'PS_RANGES',
  'shmLoading', 'shmCanEdit'];
const REGS = ['psDays', 'pvOpen', 'pvClose', 'shmRetry', 'shmOneRetry', 'shmOpen', 'shmQ'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const TODAY = '2026-10-01';
function mk(opts = {}) {
  const calls = { reads: [], pushed: [], renders: 0 };
  const CMD = {};
  const els = {};
  const pendingReads = [];
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: Object.assign({
      // A reader by default: these are PD2's read screens. PD4's edits, which
      // stores:edit adds to the same rows, are test_mobile_shop_menu_edits.js's.
      caps: opts.caps === undefined ? ['dashboard:view', 'products:view'] : opts.caps, pos: opts.pos || 'owner', prodMounted: true,
      prodSales: { pid: null, days: '30', data: null, err: null, seq: 0 },
      prodVer: { pid: null, open: false, rows: null, err: null, seq: 0 },
      shm: { list: null, err: null, tried: false, seq: 0, id: null, oneFor: null, shop: null, rows: null, oneErr: null, oneSeq: 0, qr: null, q: '' },
    }, opts.state || {}),
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (r) => calls.pushed.push(r),
    shopToday: () => TODAY,
    // A stand-in for the shared formatter: a day is its ISO date, a time its
    // HH:MM, anything else is tagged with the kind it was asked for.
    tdWhen: (v, kind) => { const d = v instanceof Date ? v.toISOString() : String(v);
      return kind === 'date' ? d.slice(0, 10) : kind === 'time' ? d.slice(11, 16) : kind + ':' + d; },
    _tdL: () => ({}),
    recapNoMoney: () => ['warehouse', 'dispatch', 'customer_service'].includes(ctx.state.pos),
    featOn: () => true,
    document: { getElementById: (id) => els[id] || null },
    APP: { cmd: (n, ...a) => CMD[n] && CMD[n](...a) },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
    encodeURIComponent,
  };
  /* Every read waits until the test answers it (`h.answer(i, value)`), so the
     order answers land in is the test's to choose. */
  const read = (p) => new Promise((res, rej) => { calls.reads.push(p); pendingReads.push({ p, res, rej }); });
  ctx.apiRaw = read;
  ctx.api = (p) => read(p).then((j) => (j && j.data !== undefined ? j.data : j));
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const h = { ctx, CMD, calls, els, text, s: ctx.state, pendingReads,
    answer: async (i, v) => { const r = pendingReads[i]; if (v instanceof Error) r.rej(v); else r.res(v); await settle(); },
    answerPath: async (p, v) => { const i = pendingReads.findIndex((r) => r.p === p && !r.done); assert.ok(i >= 0, 'no read for ' + p); pendingReads[i].done = true; await h.answer(i, v); } };
  return h;
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/* ── 1 · Sales ─────────────────────────────────────────────────────────── */
const P = { _id: 7, sku: 'SKU OM-1', name: ['Oat milk', '燕麦奶'] };
const SALES = (o) => ({ success: true, data: Object.assign({ from: '2026-09-02', to: TODAY, units: 1234, revenue: 5678.4,
  orders: 40, rank: 3, total_products: 61, selling_days: 12, last_sale: '2026-09-28', daily: [] }, o) });

section('1 · the Sales card');
it('reads the size on screen for 30 days, and draws the desktop’s title and windows', async () => {
  const h = mk();
  const html = h.ctx.salesCard(P);
  same(h.calls.reads, ['/products/7/sales?days=30']);
  const t = h.text(html);
  assert.ok(t.includes('Sales · last 30 days'));
  assert.ok(t.includes('7 days') && t.includes('30 days') && t.includes('90 days') && t.includes('All'));
  assert.ok(/units sold/.test(t) && /revenue/.test(t) && /rank/.test(t));
  assert.ok((t.match(/…/g) || []).length >= 3, 'loading shows the ellipsis, never a zero');
  h.ctx.salesCard(P);
  assert.strictEqual(h.calls.reads.length, 1, 'one read per size and window');
});
it('units, revenue in whole yuan, rank of all, and when it last sold', async () => {
  const h = mk(); h.ctx.salesCard(P);
  await h.answer(0, SALES());
  const t = h.text(h.ctx.salesCard(P));
  assert.ok(t.includes('1,234'), t);
  assert.ok(t.includes('¥5,678'), t);
  assert.ok(t.includes('#3 / 61'), t);
  assert.ok(t.includes('Last sale 3 days ago · 12 selling days'), t);
});
it('today, yesterday and one selling day are said as the desktop says them', async () => {
  const h = mk();
  assert.strictEqual(h.ctx.psContext({ selling_days: 1, last_sale: TODAY }), 'Last sale today · 1 selling day');
  assert.strictEqual(h.ctx.psContext({ selling_days: 2, last_sale: '2026-09-30' }), 'Last sale yesterday · 2 selling days');
  assert.strictEqual(h.ctx.psContext({ selling_days: 2, last_sale: '2026-06-01' }), 'Last sale 2026-06-01 · 2 selling days');
  assert.strictEqual(h.ctx.psContext({ selling_days: 0 }), 'No sales in this window');
});
it('no sale in the window: rank reads No sales', async () => {
  const h = mk(); h.ctx.salesCard(P);
  await h.answer(0, SALES({ units: 0, revenue: 0, rank: null, selling_days: 0, last_sale: null }));
  const t = h.text(h.ctx.salesCard(P));
  assert.ok(t.includes('No sales') && t.includes('No sales in this window'));
});
it('another window reads again, and a slower answer for the old one is thrown away', async () => {
  const h = mk(); h.ctx.salesCard(P);
  h.CMD.psDays('7');
  same(h.calls.reads, ['/products/7/sales?days=30', '/products/7/sales?days=7']);
  await h.answer(1, SALES({ units: 7 }));
  await h.answer(0, SALES({ units: 30 }));
  const t = h.text(h.ctx.salesCard(P));
  assert.ok(t.includes('Sales · last 7 days'));
  assert.ok(/\b7 units sold/.test(t) && !t.includes('30 units sold'), t);
});
it('All asks for all time', async () => {
  const h = mk(); h.ctx.salesCard(P);
  h.CMD.psDays('all');
  assert.strictEqual(h.calls.reads[1], '/products/7/sales?days=all');
  assert.ok(h.text(h.ctx.salesCard(P)).includes('Sales · all time'));
  h.CMD.psDays('bogus');
  assert.strictEqual(h.calls.reads.length, 2, 'only the four windows the desktop has');
});
it('the sheet\u2019s first paint reads afresh, even for the size read last time', async () => {
  const h = mk(); h.ctx.salesCard(P); await h.answer(0, SALES());
  h.s.prodMounted = false; h.ctx.salesCard(P); h.s.prodMounted = true; h.ctx.salesCard(P);
  same(h.calls.reads, ['/products/7/sales?days=30', '/products/7/sales?days=30']);
});
it('another size of the family reads its own sales', async () => {
  const h = mk(); h.ctx.salesCard(P); await h.answer(0, SALES());
  h.ctx.salesCard(Object.assign({}, P, { _id: 8 }));
  assert.strictEqual(h.calls.reads[1], '/products/8/sales?days=30');
});
it('a failed read says so where the numbers were, with dashes, never zeros', async () => {
  const h = mk(); h.ctx.salesCard(P);
  await h.answer(0, new Error('HTTP 500'));
  const t = h.text(h.ctx.salesCard(P));
  assert.ok(t.includes('Couldn’t load sales'));
  assert.ok((t.match(/—/g) || []).length >= 3 && !/\b0 units/.test(t));
});
it('a warehouse board sees units and rank, and no revenue tile at all', async () => {
  const h = mk({ pos: 'warehouse' }); h.ctx.salesCard(P); await h.answer(0, SALES());
  const t = h.text(h.ctx.salesCard(P));
  assert.ok(!t.includes('revenue') && !t.includes('¥'), t);
  assert.ok(t.includes('1,234') && t.includes('#3 / 61'));
});
it('in Chinese, the desktop’s words', async () => {
  const h = mk({ lang: 'zh' }); h.ctx.salesCard(P); await h.answer(0, SALES());
  const t = h.text(h.ctx.salesCard(P));
  for (const w of ['销量 · 最近 30 天', '售出件数', '营业额', '排名', '最近售出 3 天前 · 12 天有销量', '7 天', '全部']) assert.ok(t.includes(w), w);
});

section('2 · Version history (read)');
it('the row opens the list and reads it for this size', async () => {
  const h = mk();
  assert.ok(h.text(h.ctx.versionsRow(P)).includes('Version history'));
  h.CMD.pvOpen('7');
  assert.strictEqual(h.s.prodVer.open, true);
  same(h.calls.reads, ['/products/7/versions']);
  assert.ok(h.text(h.ctx.sheetVersions()).includes('Loading…'));
});
it('newest first, Current on the newest, Original on the baseline, and who saved it', async () => {
  const h = mk(); h.CMD.pvOpen('7');
  await h.answer(0, { success: true, versions: [
    { id: 9, is_baseline: 0, edited_by: 'Mei', created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') },
    { id: 8, is_baseline: 0, edited_by: null, created_at: '2026-09-20 02:30:00' },
    { id: 1, is_baseline: 1, edited_by: 'Ash', created_at: '2026-09-01 02:30:00' }] });
  const html = h.ctx.sheetVersions(), t = h.text(html);
  assert.ok(t.indexOf('Current') < t.indexOf('Original'));
  assert.strictEqual((t.match(/Current/g) || []).length, 1);
  assert.ok(t.includes('by Mei') && t.includes('by Ash'));
  assert.ok(t.includes('Today '), 'today is said as Today');
  assert.ok(!/Restore/.test(t) && !html.includes('restore'), 'read-only in this step: no Restore');
});
it('nothing yet says the desktop’s sentence', async () => {
  const h = mk(); h.CMD.pvOpen('7'); await h.answer(0, { success: true, versions: [] });
  assert.ok(h.text(h.ctx.sheetVersions()).includes('No earlier versions yet — they’re saved automatically as you edit.'));
});
it('a failed read says so, with the reason, and is not "nothing yet"', async () => {
  const h = mk(); h.CMD.pvOpen('7'); await h.answer(0, new Error('HTTP 500'));
  const t = h.text(h.ctx.sheetVersions());
  assert.ok(t.includes('Could not load versions: HTTP 500') && !t.includes('No earlier versions'));
});
it('closing drops an answer still in flight', async () => {
  const h = mk(); h.CMD.pvOpen('7'); h.CMD.pvClose();
  await h.answer(0, { success: true, versions: [{ id: 1, created_at: '2026-09-01 00:00:00' }] });
  assert.strictEqual(h.s.prodVer.open, false); assert.strictEqual(h.s.prodVer.rows, null);
  assert.strictEqual(h.ctx.sheetVersions(), '');
});

/* ── 3 · Shop menus ────────────────────────────────────────────────────── */
const LOCS = [
  { location: { id: 1, code: 'TH', name_en: 'Tianhe', name_cn: '天河' },
    shop: { id: 3, public_code: 'K7Q2', is_active: 1, listing_count: 3, available_count: 2 } },
  { location: { id: 2, code: 'YX', name_en: 'Yuexiu', name_cn: '越秀' },
    shop: { id: 4, public_code: 'Z9P1', is_active: 0, listing_count: 1, available_count: 1 } },
  { location: { id: 5, code: 'PY', name_en: 'Panyu', name_cn: '番禺' }, shop: null },
];
const SHOP = { shop: { id: 3, public_code: 'K7Q2', is_active: 1, updated_at: '2026-09-30 10:00:00' }, listings: [
  { id: 11, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', variant_label: '1L', price: 18, fulfilment_mode: 'stocked', is_available: 1 },
  { id: 12, name_en: 'Latte', name_cn: '拿铁', sku: 'LT-1', price: 28.5, fulfilment_mode: 'made_here', is_available: 0 },
  { id: 13, name_en: 'Rye loaf', name_cn: '黑麦面包', sku: 'RY-1', price: 32, fulfilment_mode: 'stocked', is_available: 1 },
] };
async function openShop(opts = {}) {
  const h = mk(opts);
  h.ctx.screenShopMenus();
  await h.answerPath('/shops', { success: true, data: LOCS });
  h.CMD.shmOpen('3');
  h.ctx.screenShopMenu();
  return h;
}

section('3 · shop menus');
it('every location, read from /shops: counted, inactive, or not set up', async () => {
  const h = mk();
  assert.ok(h.text(h.ctx.screenShopMenus()).includes('Loading…'));
  same(h.calls.reads, ['/shops']);
  await h.answer(0, { success: true, data: LOCS });
  const html = h.ctx.screenShopMenus(), t = h.text(html);
  assert.ok(t.includes('Tianhe 3 products'), t);
  assert.ok(t.includes('Yuexiu 1 product Inactive'), t);
  assert.ok(t.includes('Panyu Not set up'), t);
  assert.ok(html.includes("APP.cmd('shmOpen',3)") && html.includes("APP.cmd('shmOpen',4)"));
  assert.ok(!/shmOpen',\s*null/.test(html) && (html.match(/shmOpen/g) || []).length === 2, 'a location with no shop does not open');
});
it('a failed list says Load failed and offers Try again; Try again reads again', async () => {
  const h = mk(); h.ctx.screenShopMenus();
  await h.answer(0, new Error('HTTP 500'));
  const t = h.text(h.ctx.screenShopMenus());
  assert.ok(t.includes('Load failed') && t.includes('Try again'));
  h.CMD.shmRetry();
  same(h.calls.reads, ['/shops', '/shops']);
});
it('opening a shop pushes its record and reads it', async () => {
  const h = await openShop();
  same(h.calls.pushed, ['shopmenu']);
  assert.strictEqual(h.s.shm.id, 3);
  assert.ok(h.calls.reads.includes('/shops/3'));
});
it('the record: location, the code unlabelled, the QR picture, then the address it opens and Download', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  assert.ok(h.calls.reads.includes('/shops/3/qr'), 'an active shop asks what a scan opens');
  let html = h.ctx.screenShopMenu();
  assert.ok(html.includes('src="/api/retail-admin/shops/3/qr.png?v=2026-09-30%2010%3A00%3A00"'), 'the picture');
  await h.answerPath('/shops/3/qr', { success: true, data: { url: 'https://roots.example/m/K7Q2' } });
  html = h.ctx.screenShopMenu();
  const t = h.text(html);
  assert.ok(t.includes('Tianhe') && t.includes('K7Q2') && t.includes('QR code') && t.includes('https://roots.example/m/K7Q2'));
  assert.ok(html.includes('href="/api/retail-admin/shops/3/qr.png?download=1&amp;scale=20"') && html.includes('download="shop-K7Q2.png"'));
  assert.ok(t.includes('Download'));
});
it('no public domain: QR unavailable, and no picture and no Download to a refusal', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  await h.answerPath('/shops/3/qr', { success: true, data: { url: null, reason: 'no_public_domain' } });
  const html = h.ctx.screenShopMenu();
  assert.ok(h.text(html).includes('QR unavailable'));
  assert.ok(!html.includes('qr.png'), 'neither the picture nor the download');
});
it('an inactive shop: the Inactive pill, no QR, and no QR read', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: Object.assign({}, SHOP, { shop: Object.assign({}, SHOP.shop, { is_active: 0 }) }) });
  const html = h.ctx.screenShopMenu();
  assert.ok(h.text(html).includes('Inactive') && !html.includes('qr.png'));
  assert.ok(!h.calls.reads.includes('/shops/3/qr'));
});
it('each listing: name and size, SKU and kind, price, and whether it is available', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  const t = h.text(h.ctx.shmListHtml());
  assert.ok(t.includes('Oat milk · 1L OM-1 · Stocked ¥18 Available'), t);
  assert.ok(t.includes('Latte LT-1 · Made here ¥28.50 Sold out'), t);
});
it('the filter narrows by name, size or SKU, counts bare, and repaints only the list', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  const body = { innerHTML: '' }; h.els.mShmBody = body;
  const before = h.calls.renders;
  h.CMD.shmQ('ry-');
  assert.strictEqual(h.calls.renders, before, 'no full render, so the keyboard stays');
  const t = h.text(body.innerHTML);
  assert.ok(t.includes('1 / 3') && t.includes('Rye loaf') && !t.includes('Latte'));
  h.CMD.shmQ('拿铁');
  assert.ok(h.text(body.innerHTML).includes('Latte'));
  h.CMD.shmQ('zzz');
  assert.ok(h.text(body.innerHTML).includes('No products match this filter'));
});
it('a menu with nothing on it says No products yet, and draws no filter', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: { shop: SHOP.shop, listings: [] } });
  const html = h.ctx.screenShopMenu();
  assert.ok(h.text(html).includes('No products yet') && !html.includes('mShmQ'));
});
it('a failed record says Load failed and Try again reads it again', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', new Error('HTTP 500'));
  assert.ok(h.text(h.ctx.screenShopMenu()).includes('Load failed'));
  h.CMD.shmOneRetry();
  assert.strictEqual(h.calls.reads.filter((p) => p === '/shops/3').length, 2);
});
it('nothing on these screens writes', async () => {
  const h = await openShop();
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  const html = h.ctx.screenShopMenu() + h.ctx.screenShopMenus();
  assert.ok(!/apiWrite|toggle\(|Remove|\+ Add product/.test(html));
});
it('the door opens for the desktop Sales board’s any-of, and not without one', async () => {
  for (const caps of [['dashboard:view'], ['meituan:view'], ['eleme:view'], ['guanyi:view'], ['integrations:view']]) {
    const h = mk({ caps });
    assert.ok(h.ctx.canRoute('shopmenus') && h.ctx.canRoute('shopmenu'), caps[0]);
  }
  const h = mk({ caps: ['products:view', 'stores:view'] });
  assert.ok(!h.ctx.canRoute('shopmenus') && !h.ctx.canRoute('shopmenu'));
  assert.ok(M.includes("['shopmenus','qr-code','Shop menu','门店商品']"), 'a More row');
});
it('in Chinese, the shop names and the desktop’s words', async () => {
  const h = await openShop({ lang: 'zh' });
  await h.answerPath('/shops/3', { success: true, data: SHOP });
  await h.answerPath('/shops/3/qr', { success: true, data: { url: null } });
  const t = h.text(h.ctx.screenShopMenu()) + ' ' + h.text(h.ctx.screenShopMenus());
  for (const w of ['天河', '二维码不可用', '备货', '现做', '有货', '售罄', '未开通', '已停用', '件商品']) assert.ok(t.includes(w), w);
});

section('4 · every string is a live pair');
it('the desktop’s own, copied whole', () => {
  const desk = (en, zh) => PRODUCTS_JS.includes(`cuT('${en}', '${zh}')`) || SHOPS_JS.includes(`T('${en}', '${zh}')`)
    || DESK.includes(`${en} · ${zh}`);
  for (const [en, zh] of [['No sales in this window', '此区间暂无销量'], ['1 selling day', '1 天有销量'],
    ['Sales · all time', '销量 · 全部时间'], ['No sales', '暂无销量'], ['Couldn’t load sales', '无法加载销量'],
    ['units sold', '售出件数'], ['revenue', '营业额'], ['rank', '排名'],
    ['Version history', '历史版本'], ['Original', '原始版本'], ['Current', '当前'], ['by ', '操作人:'],
    ['Could not load versions: ', '无法加载版本:'], ['Today ', '今天 '], ['Yesterday ', '昨天 '],
    ['No earlier versions yet — they’re saved automatically as you edit.', '暂无历史版本 — 编辑时会自动保存。'],
    ['Shop menu', '门店商品'], ['QR code', '二维码'], ['QR unavailable', '二维码不可用'], ['Download', '下载'],
    ['Inactive', '已停用'], ['Not set up', '未开通'], ['Load failed', '加载失败'],
    ['Search by name or SKU…', '按名称或货号搜索…'], ['No products yet', '还没有商品'],
    ['No products match this filter', '没有匹配此筛选条件的产品'], ['Stocked', '备货'], ['Made here', '现做'],
    ['Available', '有货'], ['Sold out', '售罄']]) {
    assert.ok(desk(en, zh), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`) || M.includes(`E('${en}','${zh}')`), 'phone uses ' + en);
  }
});
it('the phone’s own pairs for the windows and the counts', () => {
  for (const [en, zh] of [['7 days', '7 天'], ['30 days', '30 天'], ['90 days', '90 天'], ['All', '全部'],
    ['No stores', '没有门店'], ['Try again', '重试']]) {
    // Either shape the file writes a pair in: T('a','b') / ['k','a','b'], or {en:'a',zh:'b'}.
    assert.ok((M.match(new RegExp(`'${en}',\\s*(zh:)?'${zh}'`, 'g')) || []).length >= 2, en);
  }
  assert.ok(M.includes("T(n===1?'product':'products','件商品')"));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
