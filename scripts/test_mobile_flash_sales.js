#!/usr/bin/env node
/**
 * §325 M15 — FLASH SALES ARE RUN FROM THE PHONE, AS THE DESKTOP'S TAB.
 *
 *   node scripts/test_mobile_flash_sales.js
 *
 * The phone listed flash sales and said they were "built on desktop". The
 * desktop's Flash sales tab (public/retail-admin/07-content-billing.js) is the
 * timeline (Live now, then Scheduled & recent), End early, Edit, Run again, and
 * the composer: product, price & cap, window, keep coupons off, Start /
 * Schedule, Cancel this sale. This is that tab on the phone, sliced out of
 * public/m.html and run in a sandbox (fast shard). Pins every request (method,
 * path, every body field), the confirms, the checks, the empty / failed /
 * refused cases, and the keys — flash:edit or products:edit for the PUT,
 * flash:delete or products:delete for the DELETE, failing closed while the
 * keys are unknown.
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

const MAP_SRC = slice(MH, "/* A coupon's headline fact is what it GIVES", 'const BC_KIND=');
const SRC = slice(MH, '/* Pausing a coupon is the one marketing action', '/* A scheduled broadcast can still be stopped');

const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const ROWS = () => {
  const now = Date.now();
  return [
    { id: 11, name_en: 'Kombucha', name_cn: '康普茶', sku: 'K1', sell_price: 30, flash_price: 20, flash_starts_at: iso(now - HOUR),
      flash_ends_at: iso(now + 2 * HOUR), flash_stock_limit: 10, flash_sold: 4, no_coupon_on_flash: 1, is_published: 1, flash_state: 'active' },
    { id: 12, name_en: 'Tofu', name_cn: '豆腐', sku: 'T1', sell_price: 10, flash_price: 8, flash_starts_at: iso(now + 24 * HOUR),
      flash_ends_at: iso(now + 30 * HOUR), flash_stock_limit: null, flash_sold: 0, no_coupon_on_flash: 0, is_published: 1, flash_state: 'upcoming' },
    { id: 13, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'O1', sell_price: 20, flash_price: 15, flash_starts_at: null,
      flash_ends_at: iso(now - 24 * HOUR), flash_stock_limit: 5, flash_sold: 5, no_coupon_on_flash: 0, is_published: 1, flash_state: 'ended' },
  ];
};
const PRODUCTS = [{ id: 21, name_en: 'Bread', name_cn: '面包', sku: 'B1', size: '500g', sell_price: 25, is_published: 1 },
  { id: 22, name_en: 'Jam', sku: 'J1', sell_price: 0, is_published: 1 }];

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
    fmtDay: (d) => String(d || '').slice(0, 10), fmtDateOnly: (d) => String(d || '').slice(0, 10), fmtTime: (d) => String(d || '').slice(11, 16),
    shopDayOf: (d) => new Date(d).toISOString().slice(0, 10),
    nothingYet: (t, m) => `<empty>${t}|${m}</empty>`,
    chipRow: () => '', searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    forgetScroll: () => {},
    state: { caps: opts.caps === undefined ? ['flash:view', 'flash:edit', 'flash:delete'] : opts.caps,
      ask: null, askErr: null, stack: [{ route: 'flash' }], sw: {}, flashLoaded: true, flashBusy: null, flashErr: null },
    DB: { coupons: opts.coupons || [], flash: [] },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(String(m)),
    api: async (p) => {
      reads.push(p);
      if (p.startsWith('/products?')) { if (opts.productsFail) throw new Error('down'); return opts.products || PRODUCTS; }
      return [];
    },
    apiRaw: async (p) => {
      reads.push(p);
      if (p === '/flash-sales') return { success: true, data: opts.after ? opts.after() : ROWS(), meta: { server_time_ms: Date.now() } };
      return { success: true, data: [] };
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: plain(body), method });
      if (opts.refused) { const e = new Error('refused'); e.refused = true; e.words = ['Not allowed', '无权限']; throw e; }
      if (opts.writeFails) { const e = new Error(opts.writeFails); e.code = opts.writeFails; throw e; }
      return { success: true };
    },
    document: { getElementById: () => null },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, Date, encodeURIComponent, setTimeout, clearTimeout, parseInt, isNaN,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(MAP_SRC + SRC + '\nthis.mapFlash=mapFlash; this.screenFlash=screenFlash; this.screenFlashEdit=screenFlashEdit;'
    + ' this.fsc=()=>FSC; this.fscMayLeave=fscMayLeave; this.fscEndsDate=fscEndsDate;', ctx);
  ctx.DB.flash = (opts.rows || ROWS()).map(ctx.mapFlash);
  return { ctx, CMD, writes, reads, toasts };
}
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;
const yes = (ctx) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(); };
/* A new sale on Bread at Y18, ready to start. */
const ready = async (o) => {
  const m = mk(o); m.CMD.fsNew(); m.CMD.fscOpenPicker(); await tick(); m.CMD.fscPick(21); m.CMD.fscPrice('18');
  return m;
};

section('1 · the timeline and its actions');
{
  it('the door, the route and the leave guards are wired; the list no longer sends them to the desktop', () => {
    assert.ok(MH.includes("cta:()=>fsCanPut()?`<button class=\"cta inhead\" onclick=\"APP.cmd('fsNew')\">${T('New flash sale','新建秒杀')}</button>`:''"));
    assert.ok(/flashedit:\['flash:edit','products:edit'\]/.test(MH));
    assert.ok(/if\(top==='flashedit'&&!fscMayLeave\(\)\) return;/.test(MH) && /t\.route==='flashedit'&&!fscMayLeave\(\)/.test(MH));
    assert.ok(/FSC&&FSC\.dirty&&\(state\.stack\|\|\[\]\)\.some\(f=>f&&f\.route==='flashedit'\)/.test(MH), 'a reload asks too');
    assert.ok(!MH.includes('Flash sales are built on desktop'));
    assert.ok(/flashBusy:null, flashErr:null/.test(MH), 'the state keys are declared');
  });
  it('Live now, then Scheduled & recent; End early + Edit on live, Edit on scheduled, Run again on ended', () => {
    const { ctx } = mk();
    const h = ctx.screenFlash();
    assert.ok(h.includes('Live now · 1 running') && h.includes('Scheduled & recent · 1 scheduled'));
    assert.ok(h.indexOf('Kombucha') < h.indexOf('Scheduled') && h.indexOf('Tofu') < h.indexOf('Oat milk'));
    assert.ok(/fsEndNow',11\)/.test(h) && /fsEdit',11\)/.test(h) && /fsEdit',12\)/.test(h) && /fsAgain',13\)/.test(h));
    assert.ok(!/fsEndNow',12\)/.test(h) && !/fsEndNow',13\)/.test(h) && !/fsAgain',11\)/.test(h));
  });
  it('nothing live says so; nothing at all is the desktop\'s empty', () => {
    const { ctx } = mk({ rows: ROWS().slice(1) });
    assert.ok(ctx.screenFlash().includes('No sale is live this moment. Scheduled ones start on their own.'));
    const e = mk({ rows: [] });
    assert.ok(e.ctx.screenFlash().includes("Nothing's on the clock|Put a product on a timer and it sells at the sale price until the window closes."));
  });
  it('End early: the desktop\'s confirm, then DELETE /products/:id/flash-sale, then the list is read', async () => {
    const { ctx, CMD, writes, toasts, reads } = mk();
    CMD.fsEndNow(11);
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'End the flash sale on "Kombucha" now?');
    assert.strictEqual(a.body, 'The regular price comes back immediately.');
    assert.strictEqual(a.confirmLabel, 'End sale'); assert.strictEqual(a.danger, true);
    assert.deepStrictEqual(writes, [], 'nothing until yes');
    yes(ctx);
    assert.ok(ctx.screenFlash().includes('Saving…'), 'the card says Saving…');
    await tick();
    assert.deepStrictEqual(writes, [{ p: '/products/11/flash-sale', body: {}, method: 'DELETE' }]);
    assert.deepStrictEqual(toasts, ['Flash sale ended']);
    assert.ok(reads.includes('/flash-sales'));
  });
  it('End early failing or refused stays above the list', async () => {
    const f = mk({ writeFails: 'not_found' });
    f.CMD.fsEndNow(11); yes(f.ctx); await tick();
    assert.ok(f.ctx.screenFlash().includes('Failed: not_found'));
    const r = mk({ refused: true });
    r.CMD.fsEndNow(11); yes(r.ctx); await tick();
    assert.ok(r.ctx.screenFlash().includes('Not allowed'));
  });
}

section('2 · the composer');
{
  it('opens empty: choose a product, price & cap, ends tonight, starts now, coupons kept off', () => {
    const { ctx, CMD } = mk();
    CMD.fsNew();
    assert.strictEqual(top(ctx), 'flashedit');
    const h = ctx.screenFlashEdit();
    for (const s of ['Choose a product', 'Price & cap', 'Y price', 'No cap', 'stock cap', 'flash price', 'Window',
      'starts now', 'schedule it', 'Ends ', '+1h', '+6h', 'Tonight', '+3d', '+7d', 'Keep coupons off this price',
      'Sitewide coupons skip this product while the sale runs.', '<toggle on="true"', 'What customers see',
      'Pick a product and set a price to preview the shopper’s view.', '>Start<']) assert.ok(h.includes(s), s);
  });
  it('the product search reads published products, and a pick fills the product', async () => {
    const { ctx, CMD, reads } = mk();
    CMD.fsNew(); CMD.fscOpenPicker(); await tick();
    assert.ok(reads.includes('/products?published=1&limit=20'));
    let h = ctx.screenFlashEdit();
    assert.ok(h.includes('Bread') && h.includes('B1 · 500g') && h.includes('Y25 regular') && /fscPick',21\)/.test(h));
    CMD.fscPQ('br ead'); await new Promise((r) => setTimeout(r, 300)); await tick();
    assert.strictEqual(reads.filter((p) => p.startsWith('/products')).pop(), '/products?published=1&limit=20&q=br%20ead');
    CMD.fscPick(21);
    h = ctx.screenFlashEdit();
    assert.ok(h.includes('Bread') && h.includes('Regular Y25') && !ctx.fsc().pickerOpen);
  });
  it('the product search: none match, and failed', async () => {
    const e = mk({ products: [] }); e.CMD.fsNew(); e.CMD.fscOpenPicker(); await tick();
    assert.ok(e.ctx.screenFlashEdit().includes('No products match — try another search.'));
    const f = mk({ productsFail: true }); f.CMD.fsNew(); f.CMD.fscOpenPicker(); await tick();
    assert.ok(f.ctx.screenFlashEdit().includes('Failed to load: down'));
  });
  it('the price says how much off, refuses one not lower, and the preview shows the shopper\'s view', async () => {
    const { ctx, CMD } = await ready();
    let h = ctx.screenFlashEdit();
    assert.ok(h.includes('<b>28% off</b> Y25'));
    assert.ok(h.includes('Y18') && h.includes('save 28%') && h.includes('Reverts to Y25 on its own when the clock runs out.'));
    CMD.fscCap('6');
    assert.ok(ctx.screenFlashEdit().includes('Limited to 6'));
    CMD.fscPrice('30');
    h = ctx.screenFlashEdit();
    assert.ok(h.includes('Must be lower than regular'));
  });
  it('the window: chips set the end, the end can be typed, a start can be scheduled', async () => {
    const { ctx, CMD } = await ready();
    const t0 = Date.now();
    CMD.fscEndChip('+6h');
    const e6 = ctx.fscEndsDate(ctx.fsc()).getTime();
    assert.ok(Math.abs(e6 - t0 - 6 * HOUR) < 5000);
    CMD.fscStartLater();
    let h = ctx.screenFlashEdit();
    assert.ok(h.includes('scheduled — ') && h.includes('start now instead') && h.includes('Tomorrow 09:00') && h.includes('Pick a time') && h.includes('>Schedule<'));
    CMD.fscStartChip('custom');
    assert.ok(ctx.screenFlashEdit().includes('id="mFscStart" type="datetime-local"'));
    CMD.fscOpenEnd();
    h = ctx.screenFlashEdit();
    assert.ok(h.includes('id="mFscEnd" type="datetime-local"'));
    CMD.fscSetEnd('2099-01-02T10:30');
    assert.ok(ctx.screenFlashEdit().includes('Ends 2099-01-02 10:30'));
  });
  it('a live coupon that would stack is warned when coupons are allowed', async () => {
    const coupons = [{ raw: { is_active: 1, is_public: 1 } }];
    const { ctx, CMD } = await ready({ coupons });
    assert.ok(!ctx.screenFlashEdit().includes('A sitewide coupon is live'));
    CMD.fscCoupon();
    assert.ok(ctx.screenFlashEdit().includes('A sitewide coupon is live — it will stack on this price. Keep coupons off to protect your margin.'));
  });
}

section('3 · the save: PUT /products/:id/flash-sale');
{
  it('Start: the desktop\'s body, every field', async () => {
    const { ctx, CMD, writes, toasts, reads } = await ready();
    CMD.fscCap('6'); CMD.fscOpenEnd(); CMD.fscSetEnd('2099-01-02T10:30');
    CMD.fscStart(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/products/21/flash-sale', method: 'PUT', body: {
      flash_price: 18, flash_ends_at: new Date('2099-01-02T10:30').toISOString(), flash_starts_at: null,
      flash_stock_limit: 6, no_coupon_on_flash: 1 } }]);
    assert.deepStrictEqual(toasts, ['Flash sale started']);
    assert.strictEqual(ctx.fsc(), null); assert.strictEqual(top(ctx), 'flash');
    assert.ok(reads.includes('/flash-sales'));
  });
  it('Schedule: tomorrow 09:00 as the start, no cap as null, coupons allowed as 0', async () => {
    const { CMD, writes, toasts } = await ready();
    CMD.fscStartLater(); CMD.fscEndChip('+3d'); CMD.fscCoupon();
    CMD.fscStart(); await tick();
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    const b = writes[0].body;
    assert.strictEqual(b.flash_starts_at, d.toISOString());
    assert.strictEqual(b.flash_ends_at, new Date(d.getTime() + 3 * 86400e3).toISOString());
    assert.strictEqual(b.flash_stock_limit, null); assert.strictEqual(b.no_coupon_on_flash, 0);
    assert.deepStrictEqual(toasts, ['Flash sale scheduled']);
  });
  it('the checks, as the desktop\'s, and nothing is sent', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.fsNew(); CMD.fscStart();
    assert.ok(ctx.screenFlashEdit().includes('Pick a product first'));
    const m = await ready();
    m.CMD.fscPrice(''); m.CMD.fscStart();
    assert.ok(m.ctx.screenFlashEdit().includes('Enter a flash price'));
    m.CMD.fscPrice('25'); m.CMD.fscStart();
    assert.ok(m.ctx.screenFlashEdit().includes('Flash price must be lower than regular'));
    m.CMD.fscPrice('18'); m.CMD.fscOpenEnd(); m.CMD.fscSetEnd('2001-01-01T10:00'); m.CMD.fscStart();
    assert.ok(m.ctx.screenFlashEdit().includes('End time is in the past'));
    m.CMD.fscSetEnd(''); m.CMD.fscStart();
    assert.ok(m.ctx.screenFlashEdit().includes('Set an end time'));
    m.CMD.fscSetEnd('2099-01-02T10:00'); m.CMD.fscStartLater(); m.CMD.fscStartChip('custom'); m.CMD.fscSetStart('2099-01-03T10:00'); m.CMD.fscStart();
    assert.ok(m.ctx.screenFlashEdit().includes('Start must be before end'));
    await tick();
    assert.deepStrictEqual(writes, []); assert.deepStrictEqual(m.writes, []);
  });
  it('three states: Saving…, a second tap sends nothing; the server\'s refusals in the desktop\'s words', async () => {
    const { ctx, CMD, writes } = await ready();
    CMD.fscStart();
    assert.ok(ctx.screenFlashEdit().includes('Saving…'));
    CMD.fscStart(); await tick();
    assert.strictEqual(writes.length, 1);
    const f = await ready({ writeFails: 'flash_stock_limit_invalid' });
    f.CMD.fscStart(); await tick();
    assert.ok(f.ctx.screenFlashEdit().includes('Failed: Stock cap must be a positive number'));
    assert.strictEqual(top(f.ctx), 'flashedit', 'the composer stays, with what was set');
    const r = await ready({ refused: true });
    r.CMD.fscStart(); await tick();
    assert.ok(r.ctx.screenFlashEdit().includes('Not allowed'));
  });
  it('Edit keeps the window and the product; Cancel this sale confirms, then DELETE', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.fsEdit(12);
    const w = ctx.fsc();
    assert.deepStrictEqual([w.mode, w.editId, w.price, w.cap, w.noCoupon, w.startLater, w.startChip], ['edit', 12, '8', '', false, true, 'custom']);
    const h = ctx.screenFlashEdit();
    assert.ok(h.includes('Editing') && h.includes('Tofu') && h.includes('Cancel this sale') && h.includes('>Schedule<'));
    CMD.fscCancelSale();
    assert.strictEqual(ctx.state.ask.title, 'Cancel the flash sale on "Tofu"?');
    assert.strictEqual(ctx.state.ask.body, "The product returns to its regular price and the sale leaves the list. This can't be undone.");
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Cancel sale');
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/products/12/flash-sale', body: {}, method: 'DELETE' }]);
    assert.deepStrictEqual(toasts, ['Flash sale cancelled']);
    assert.strictEqual(top(ctx), 'flash');
  });
  it('Edit then Start sends the same product with the kept window', async () => {
    const { CMD, writes } = mk();
    CMD.fsEdit(11); CMD.fscPrice('19'); CMD.fscStart(); await tick();
    const row = ROWS()[0];
    assert.strictEqual(writes[0].p, '/products/11/flash-sale');
    assert.strictEqual(writes[0].body.flash_price, 19);
    assert.strictEqual(writes[0].body.flash_stock_limit, 10);
    assert.strictEqual(writes[0].body.no_coupon_on_flash, 1);
    assert.ok(Math.abs(new Date(writes[0].body.flash_ends_at).getTime() - new Date(row.flash_ends_at).getTime()) < 60e3, 'the end kept to the minute');
  });
  it('Run again: a fresh clock ending tonight, starting now, no Cancel', () => {
    const { ctx, CMD } = mk();
    CMD.fsAgain(13);
    const w = ctx.fsc();
    assert.deepStrictEqual([w.mode, w.editId, w.endChip, w.startLater, w.price, w.cap], ['again', null, 'tonight', false, '15', '5']);
    const h = ctx.screenFlashEdit();
    assert.ok(h.includes('Run again') && !h.includes('Cancel this sale'));
  });
  it('leaving: untouched goes; changed asks', async () => {
    const { ctx, CMD } = mk();
    CMD.fsNew();
    assert.strictEqual(ctx.fscMayLeave(), true);
    const m = await ready();
    assert.strictEqual(m.ctx.fscMayLeave(), false);
    assert.strictEqual(m.ctx.state.ask.confirmLabel, 'Leave');
  });
}

section('4 · the keys');
{
  it('flash:view alone: no actions, no door, and the commands send nothing', async () => {
    const { ctx, CMD, writes } = mk({ caps: ['flash:view'] });
    const h = ctx.screenFlash();
    assert.ok(!h.includes('fsEndNow') && !h.includes('fsEdit') && !h.includes('fsAgain'));
    CMD.fsNew(); CMD.fsEdit(11); CMD.fsAgain(13); CMD.fsEndNow(11); await tick();
    assert.strictEqual(top(ctx), 'flash'); assert.strictEqual(ctx.state.ask, null);
    assert.deepStrictEqual(writes, []);
  });
  it('products:edit opens the composer and products:delete ends a sale, as the server allows', async () => {
    const { ctx } = mk({ caps: ['flash:view', 'products:edit', 'products:delete'] });
    const h = ctx.screenFlash();
    assert.ok(/fsEndNow',11\)/.test(h) && /fsEdit',11\)/.test(h));
  });
  it('flash:edit without a delete key: Edit, no End early, no Cancel this sale', () => {
    const { ctx, CMD } = mk({ caps: ['flash:view', 'flash:edit'] });
    const h = ctx.screenFlash();
    assert.ok(/fsEdit',11\)/.test(h) && !/fsEndNow/.test(h));
    CMD.fsEdit(12);
    assert.ok(!ctx.screenFlashEdit().includes('Cancel this sale'));
    CMD.fscCancelSale(); assert.strictEqual(ctx.state.ask, null);
  });
  it('keys not yet known: closed (money: moves)', async () => {
    const { ctx, CMD, writes } = mk({ caps: null });
    const h = ctx.screenFlash();
    assert.ok(!h.includes('fsEndNow') && !h.includes('fsEdit'));
    CMD.fsNew(); CMD.fsEndNow(11); await tick();
    assert.strictEqual(ctx.fsc(), null); assert.deepStrictEqual(writes, []);
  });
  it('the server agrees on the keys', () => {
    const { requiredCapFor } = require(path.join(ROOT, 'lib/cap-routes.js'));
    assert.deepStrictEqual(plain(requiredCapFor('PUT', '/api/retail-admin/products/5/flash-sale')), ['flash:edit', 'products:edit']);
    assert.deepStrictEqual(plain(requiredCapFor('DELETE', '/api/retail-admin/products/5/flash-sale')), ['flash:delete', 'products:delete']);
  });
}

(async () => {
  for (const f of queue) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
