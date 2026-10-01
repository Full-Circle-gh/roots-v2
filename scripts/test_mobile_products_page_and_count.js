#!/usr/bin/env node
/**
 * §325 X3 — THE PRODUCT PAGE'S SECTIONS, AND A STOCK COUNT SHEET, ON THE PHONE.
 *
 *   node scripts/test_mobile_products_page_and_count.js
 *
 *   1. Operations → Product page: the order the desktop's full product page
 *      shows its sections in, and which it shows (31-product-page.js). Every
 *      change is the desktop's PUT /config {'product_page.sections': {order,
 *      hidden}}, asserted on its body; the sections and the layout resolver are
 *      sliced out of the desktop module and compared.
 *   2. Products → Count sheet: the desktop's paPrintCountSheet document
 *      (26-print.js), shown in a frame and handed to the phone's print sheet.
 *
 * The phone code is RUN, sliced out of public/m.html into a sandbox with a fake
 * server. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const PPG = fs.readFileSync(path.join(ROOT, 'public/retail-admin/31-product-page.js'), 'utf8');
const PRINT = fs.readFileSync(path.join(ROOT, 'public/retail-admin/26-print.js'), 'utf8');
const { tdWhen } = require('../public/td-datetime.js');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  block(M, 'function toggle('),
  line(M, 'const cfgGet='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  block(M, 'function prodStoreOn()'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X2 — WHAT THE DESKTOP', '/* §325 X2 ends */'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X3 — THE PRODUCT PAGE', '/* §325 X3 ends */'),
].join('\n');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'];
const KEYS = ['basics', 'where', 'cost', 'stock', 'sold', 'page'];

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], renders: 0, printed: 0 };
  const CMD = {};
  const frame = { contentWindow: { focus() {}, print() { if (opts.printThrows) throw new Error('blocked'); calls.printed++; } } };
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    DB: { products: opts.products || [], coupons: [] },
    state: {
      caps: opts.caps === undefined ? SETTINGS.concat(['products:view']) : opts.caps,
      cfg: opts.cfg || {}, ask: null, storeName: 'Roots', countPrint: false,
      catalogueComplete: opts.complete !== false, catalogMode: 'self',
      prodStore: opts.store || '', prodGrid: opts.grid || { ready: false, stores: [], qty: {} },
      opsx: { busy: null, err: null, geoBusy: false, geoErr: null, bin: null, binDays: 60, binTried: false, binErr: null, binBusy: null, binRowErr: {} },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false,
    tdWhen, _tdL: () => ({ lang: ctx.LANG === 'en' ? 'en' : 'cn' }),
    api: () => new Promise(() => {}), apiRaw: () => new Promise(() => {}),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: plain(body), method: method || 'POST', res, rej });
    }),
    document: { getElementById: (id) => (id === 'mCountPrintFrame' ? frame : null) },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.PPGM_SECTIONS=PPGM_SECTIONS;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text };
}
const tick = () => new Promise((r) => setImmediate(r));
async function ok(h, i) { h.calls.writes[i].res({ success: true }); await tick(); }
async function no(h, i, e) { h.calls.writes[i].rej(e || new Error('HTTP 500')); await tick(); }
const body = (h, i) => h.calls.writes[i].body;

// ─────────────────────────────────────────────────────────────────────────
section('1 · the product page\'s sections are the desktop\'s');
{
  const desk = vm.runInNewContext('(' + slice(PPG, 'const PPG_SECTIONS = [', '];').replace('const PPG_SECTIONS = ', '') + '])');
  it('the six sections, their names and their one-line descriptions, key for key', () => {
    const phone = plain(mk().ctx.PPGM_SECTIONS);
    const want = desk.map((s) => { const o = { key: s.key, en: s.en, cn: s.cn }; if (s.locked) o.locked = true; o.what_en = s.what_en; o.what_cn = s.what_cn; return o; });
    assert.deepStrictEqual(phone, plain(want));
  });
  it('the layout resolves exactly as the desktop resolves it', () => {
    const dctx = { PPG_SECTIONS: desk };
    vm.createContext(dctx);
    vm.runInContext(block(PPG, 'function ppgResolveLayout(raw)') + '\nthis.r=ppgResolveLayout;', dctx);
    const { ctx } = mk();
    for (const raw of [null, {}, { order: ['page', 'cost'] }, { order: ['x', 'cost', 'cost'], hidden: ['basics', 'sold', 'nope', 'sold'] }, { order: 'bad', hidden: 7 }]) {
      assert.deepStrictEqual(plain(ctx.ppgmResolve(raw)), plain(dctx.r(raw)), JSON.stringify(raw));
    }
  });
}

section('2 · Operations → Product page');
{
  it('draws the stored order, with Basics always shown', () => {
    const h = mk({ cfg: { product_page: { sections: { order: ['page', 'basics'], hidden: ['cost'] } } } });
    const t = h.text(h.ctx.ppgmCard());
    assert.ok(t.indexOf('Shopper page') < t.indexOf('Basics') && t.indexOf('Basics') < t.indexOf('Where it shows'), t);
    assert.ok(t.includes('Always shown'));
    assert.ok(t.includes('The order your product page shows its sections in, and which ones it shows at all.'));
    assert.ok(t.includes('Basics cannot be hidden: a product needs a name.'));
    assert.ok(!/ppgToggle','basics'/.test(h.ctx.ppgmCard()), 'no switch for the locked section');
    assert.ok(/ppgToggle','cost'/.test(h.ctx.ppgmCard()));
  });
  it('hiding a section saves the whole layout, in the desktop\'s key', async () => {
    const h = mk();
    h.CMD.ppgToggle('cost');
    assert.strictEqual(h.calls.writes[0].p, '/config');
    assert.strictEqual(h.calls.writes[0].method, 'PUT');
    assert.deepStrictEqual(body(h, 0), { 'product_page.sections': { order: KEYS, hidden: ['cost'] } });
    assert.ok(/Saving…/.test(h.text(h.ctx.ppgmCard())));
    h.CMD.ppgToggle('stock');
    assert.strictEqual(h.calls.writes.length, 1, 'one change at a time');
    await ok(h, 0);
    assert.deepStrictEqual(plain(h.ctx.state.cfg.product_page.sections), { order: KEYS, hidden: ['cost'] });
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    h.CMD.ppgToggle('cost');
    assert.deepStrictEqual(body(h, 1), { 'product_page.sections': { order: KEYS, hidden: [] } });
  });
  it('moving a section swaps it with its neighbour; the ends do not move', async () => {
    const h = mk({ cfg: { product_page: { sections: { hidden: ['sold'] } } } });
    h.CMD.ppgMove('stock', -1);
    assert.deepStrictEqual(body(h, 0), { 'product_page.sections': { order: ['basics', 'where', 'stock', 'cost', 'sold', 'page'], hidden: ['sold'] } });
    await ok(h, 0);
    h.CMD.ppgMove('basics', -1); h.CMD.ppgMove('page', 1); h.CMD.ppgMove('nope', 1);
    assert.strictEqual(h.calls.writes.length, 1);
    const html = h.ctx.ppgmCard();
    assert.ok(/aria-label="Move up" disabled onclick="APP\.cmd\('ppgMove','basics',-1\)"/.test(html), 'the first row cannot go up');
  });
  it('the locked section cannot be hidden, even if asked', () => {
    const h = mk(); h.CMD.ppgToggle('basics');
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('Reset sends the default order with nothing hidden, at once', () => {
    const h = mk({ cfg: { product_page: { sections: { order: ['page'], hidden: ['cost'] } } } });
    h.CMD.ppgReset();
    assert.deepStrictEqual(body(h, 0), { 'product_page.sections': { order: KEYS, hidden: [] } });
  });
  it('a failed save says so beside the list, and the list stays as the server has it', async () => {
    const h = mk({ cfg: { product_page: { sections: { hidden: ['cost'] } } } });
    h.CMD.ppgToggle('cost');
    await no(h, 0);
    assert.ok(h.text(h.ctx.ppgmCard()).includes('Save failed'));
    assert.deepStrictEqual(plain(vm.runInContext('ppgmLayout()', h.ctx).hidden), ['cost']);
    assert.deepStrictEqual(h.calls.toasts, []);
    const r = mk(); r.CMD.ppgToggle('cost');
    const e = new Error('refused'); e.refused = true; e.words = ['You do not have permission for this.', '你没有此操作的权限。'];
    await no(r, 0, e);
    assert.ok(r.text(r.ctx.ppgmCard()).includes('You do not have permission for this.'));
  });
  it('an account without the Settings keys gets no card and no write', () => {
    const h = mk({ caps: ['products:view'] });
    assert.strictEqual(h.ctx.ppgmCard(), '');
    h.CMD.ppgToggle('cost'); h.CMD.ppgReset();
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('in Chinese', () => {
    const t = mk({ lang: 'zh' }).text(mk({ lang: 'zh' }).ctx.ppgmCard());
    assert.ok(t.includes('产品页') && t.includes('始终显示') && t.includes('售卖方式') && t.includes('重置为默认顺序'));
  });
  it('it sits on the Operations screen', () => {
    assert.ok(block(M, 'function screenOperations(){').includes('${ppgmCard()}'));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · the count sheet');
{
  const P = [
    { _id: 1, name: ['Hummus Asli', '鹰嘴豆泥'], rawSku: 'RT-1', stock: 12 },
    { _id: 2, name: ['Pita <bag>', '皮塔'], rawSku: '', stock: 0 },
  ];
  const GRID = { ready: true, stores: [{ id: 3, name_en: 'Tianhe', name_cn: '天河' }, { id: 4, name_en: 'Yuexiu', name_cn: '越秀' }],
    qty: { 1: { 3: 5, 4: 7 } } };
  it('offered only to someone who can open Products, and only with the whole catalogue in hand', () => {
    assert.ok(/countPrint/.test(mk({ products: P }).ctx.countButton()));
    assert.strictEqual(mk({ products: P, complete: false }).ctx.countButton(), '');
    assert.strictEqual(mk({ products: [] }).ctx.countButton(), '');
    assert.strictEqual(mk({ products: P, caps: ['orders:view'] }).ctx.countButton(), '');
    const h = mk({ products: P, complete: false }); h.CMD.countPrint();
    assert.strictEqual(h.ctx.state.countPrint, false);
  });
  it('every store: the shop-wide figure, the SKU, two boxes to write in, the desktop\'s headings and note', () => {
    const doc = mk({ products: P }).ctx.countSheetDoc();
    assert.ok(/<h1>Stock count<\/h1>\s*<div class="cn">盘点表<\/div>\s*<div class="sub">All locations<\/div>/.test(doc));
    assert.ok(doc.includes('<dt>Lines</dt><dd>2</dd>') && doc.includes('<dt>Counted by</dt><dd>________</dd>'));
    assert.ok(/<td>Hummus Asli<\/td><td>RT-1<\/td><td class="r">12<\/td><td class="write r"><\/td><td class="write r"><\/td>/.test(doc));
    assert.ok(doc.includes('<td>Pita &lt;bag&gt;</td><td></td><td class="r">0</td>'), 'names are escaped');
    for (const h of ['Product 商品', 'System 系统', 'Counted 实盘', 'Difference 差异']) assert.ok(doc.includes('>' + h + '</th>'), h);
    const deskNote = slice(PRINT, "note: cuT('Write the counted figure", "',").replace("note: cuT('", '');
    assert.ok(doc.includes(deskNote), 'the desktop\'s note');
    assert.ok(doc.includes('<div class="shop">Roots</div>'), 'the shop\'s own name');
  });
  it('one store picked: that shelf\'s own figure, blank where the shelf has none', () => {
    const doc = mk({ products: P, grid: GRID, store: '4' }).ctx.countSheetDoc();
    assert.ok(doc.includes('<div class="sub">Yuexiu</div>'));
    assert.ok(/<td>Hummus Asli<\/td><td>RT-1<\/td><td class="r">7<\/td>/.test(doc));
    assert.ok(/<td>Pita &lt;bag&gt;<\/td><td><\/td><td class="r"><\/td>/.test(doc), 'unknown is blank, never 0');
  });
  it('a store pick the switch cannot answer for falls back to every store', () => {
    const doc = mk({ products: P, grid: { ...GRID, ready: false }, store: '4' }).ctx.countSheetDoc();
    assert.ok(doc.includes('<div class="sub">All locations</div>'));
  });
  it('in Chinese: the desktop\'s Chinese-first headings and note', () => {
    const doc = mk({ products: P, lang: 'zh', grid: GRID, store: '3' }).ctx.countSheetDoc();
    assert.ok(doc.includes('>商品 Product</th>') && doc.includes('<td>鹰嘴豆泥</td>') && doc.includes('<div class="sub">天河</div>'));
    assert.ok(doc.includes('请在货架前填写实盘数量。'));
  });
  it('never writes a literal closing tag into the app\'s own script', () => {
    const src = slice(M, '§325 X3 — THE PRODUCT PAGE', '/* §325 X3 ends */');
    assert.ok(!/<\/(body|html|script|style)>/.test(src));
  });
  it('opens over Products, prints through the frame, and says so when the phone refuses', () => {
    const h = mk({ products: P });
    h.CMD.countPrint();
    assert.strictEqual(h.ctx.state.countPrint, true);
    const sheet = h.ctx.sheetCountPrint();
    assert.ok(/<iframe id="mCountPrintFrame"[^>]*srcdoc="[^"]*Stock count/.test(sheet));
    h.CMD.countPrintGo();
    assert.strictEqual(h.calls.printed, 1);
    h.CMD.countPrintClose();
    assert.strictEqual(h.ctx.state.countPrint, false);
    const f = mk({ products: P, printThrows: true });
    f.CMD.countPrint(); f.CMD.countPrintGo();
    assert.strictEqual(f.ctx.state.countPrint, 'failed');
    assert.ok(/Print failed/.test(f.ctx.sheetCountPrint()));
  });
  it('wired: the button beside Export, the layer, and Back closing it first', () => {
    assert.ok(block(M, 'function screenProductCatalogue(){').includes('${exp}${countButton()}'));
    assert.ok(/if\(state\.countPrint\) html \+= layer\('countprint', sheetCountPrint\(\)\);/.test(M));
    assert.ok(/if\(state\.countPrint\) L\.push\(\(\)=>\{ state\.countPrint=false; \}\);/.test(block(M, 'function layers(){')));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
