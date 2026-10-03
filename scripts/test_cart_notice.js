#!/usr/bin/env node
/**
 * §197 — A PRODUCT CAN CARRY ITS OWN WARNING, AND IT IS RAISED WHEN THE
 * PRODUCT GOES INTO THE CART.
 *
 *   node scripts/test_cart_notice.js
 *
 * Ash: a tenant needs to be able to put an important notice on a product —
 * kombucha that has to stand in the fridge overnight once it arrives — and have
 * the customer meet it at the moment they add it.
 *
 * WHAT THIS LOCKS, and each is a way the change could go wrong:
 *
 *   • BLANK IS SILENCE. A notice with no words in it renders nothing, rather
 *     than an empty card. (The pre-order notice's blank means "unchanged"
 *     instead — §194 — because that one was already live and blank would have
 *     switched it off for every tenant. This one has never shipped.)
 *
 *   • EITHER LANGUAGE ALONE IS STILL A NOTICE. A tenant who fills in only the
 *     Chinese side has written one, and dropping it for want of an English
 *     title would hide it from the half of the shop that would read it.
 *
 *   • SEEN IS PER VERSION, NOT PER NOTICE. Every client keys the "seen" mark on
 *     `<id>:<updated_at>`, so fixing a wrong word shows the notice once more
 *     and an untouched notice still shows exactly once. popup-manager was built
 *     the other way first and a merchant's edit shipped to phones that could
 *     never display it.
 *
 *   • BOTH CLIENTS OR NEITHER. The mini app and the web shop run the same
 *     rules over the same notices. The same bottle behaving differently in the
 *     two is the drift §196's suite exists to catch, and this one asserts the
 *     queue and the seen-mark on both sides rather than reading one and
 *     trusting the other.
 *
 *   • EVERY ADD PATH CARRIES IT. A notice that fires from the product page and
 *     is silent from the grid's + button is worse than none: the customer who
 *     never opened the page is the one who has not read it anywhere else.
 *
 *   • THE STAMP MOVES ONLY WHEN THE WORDS DO. Bumping `updated_at` on every
 *     save would re-interrupt every customer each time any product on the
 *     notice was edited for an unrelated reason.
 *
 * Nothing here touches a network or a real database: the server helpers and the
 * web client's functions are lifted out of their files and run in a vm sandbox
 * with their few dependencies stubbed, which is the technique the pre-order
 * notice suites use.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
// Collected and run in order at the bottom rather than executed inline: half of
// these are async, and an async assertion run by a synchronous runner rejects
// into nothing and reports a tick. That is the exact failure scripts/run-suites
// exists to stop, so it must not be reintroduced inside one suite.
const TESTS = [];
function it(name, fn) { TESTS.push({ name, fn }); }
function section(t) { TESTS.push({ section: t }); }

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SHOP = fs.readFileSync(path.join(ROOT, 'public', 'shop.html'), 'utf8');
const PRODUCT_JS = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'product', 'product.js'), 'utf8');
const SHOP_JS = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'shop', 'shop.js'), 'utf8');
const CART_JS = fs.readFileSync(path.join(ROOT, 'miniapp', 'utils', 'cart.js'), 'utf8');
const EDITOR = fs.readFileSync(path.join(ROOT, 'public', 'product-editor.html'), 'utf8');
const CHECKOUT_JS = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'checkout', 'checkout.js'), 'utf8');
const CHECKOUT_WXML = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'checkout', 'checkout.wxml'), 'utf8');
const CHECKOUT_JSON = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'checkout', 'checkout.json'), 'utf8');
const CARD_JS = fs.readFileSync(path.join(ROOT, 'miniapp', 'components', 'cart-notice', 'cart-notice.js'), 'utf8');

// Lift one top-level `function name(` … `\n}` block out of a source file. An
// `async function` is lifted WITH its keyword: slicing from `function` alone
// drops it, and the body then fails to parse on its first await — which is how
// this helper quietly stops testing an async function at all.
function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} not found`);
  const isAsync = src.slice(Math.max(0, at - 6), at) === 'async ';
  const rest = src.slice(isAsync ? at - 6 : at);
  const end = rest.indexOf('\n}');
  assert.ok(end > -1, `${name} has no top-level close`);
  return rest.slice(0, end + 2);
}

/* ── 1 · the server — what a stored notice turns into ────────────────────── */
section('1 · the server — resolving a notice onto a product');

// cfgValue and the sibling query are the two dependencies; everything else in
// these helpers is pure. `groups` is { productId: variantGroupId } and stands in
// for store_products — the stub answers the query the way the JOIN does.
function serverWith(list, groups = {}, opts = {}) {
  const tdb = () => ({
    prepare: () => ({
      all: (...ids) => {
        if (opts.throws) throw new Error('db gone');
        const out = [];
        for (const id of ids) {
          const g = groups[id];
          if (g == null) continue;
          for (const [sib, sg] of Object.entries(groups)) {
            if (sg === g && Number(sib) !== id) out.push({ of_id: id, sib_id: Number(sib) });
          }
        }
        return out;
      },
    }),
  });
  const sandbox = { cfgValue: (k, fb) => (k === 'cart_notices.list' ? list : fb), tdb, module: {}, console: { ...console, warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(
    grab(RETAIL, 'cartNoticeList') + '\n'
    + grab(RETAIL, 'shapeCartNotice') + '\n'
    + grab(RETAIL, 'cartNoticeSiblings') + '\n'
    + grab(RETAIL, 'cartNoticeIndex') + '\n'
    + grab(RETAIL, 'attachCartNotices') + '\n',
    sandbox);
  return sandbox;
}

const FRIDGE = {
  id: 'cn_fridge', enabled: true,
  title_en: 'Let it settle', title_cn: '请先静置',
  body_en: 'Stand it in the fridge overnight before you open it.',
  body_cn: '开瓶前请冷藏静置一夜。',
  product_ids: [11, 12], updated_at: 1700000000000,
};

it('a product on a notice gets it', () => {
  const s = serverWith([FRIDGE]);
  const rows = [{ id: 11 }, { id: 99 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice.title_en, 'Let it settle');
  assert.strictEqual(rows[0].cart_notice.updated_at, 1700000000000);
});

it('a product on no notice is left alone — not stamped with null', () => {
  const s = serverWith([FRIDGE]);
  const rows = [{ id: 99 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]), 'a 500-row grid must not carry a field per row for a notice nobody wrote');
});

it('BLANK IS SILENCE — a notice with no words resolves to nothing', () => {
  const s = serverWith([{ id: 'cn_empty', enabled: true, title_en: '  ', body_cn: '', product_ids: [11] }]);
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]));
});

it('a disabled notice resolves to nothing', () => {
  const s = serverWith([{ ...FRIDGE, enabled: false }]);
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]));
});

it('EITHER LANGUAGE ALONE IS STILL A NOTICE', () => {
  const s = serverWith([{ id: 'cn_zh', enabled: true, title_cn: '请先静置', product_ids: [11] }]);
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice.title_cn, '请先静置');
  assert.strictEqual(rows[0].cart_notice.title_en, '');
});

it('two notices naming one product: the first wins, so one add is one card', () => {
  const s = serverWith([FRIDGE, { id: 'cn_other', enabled: true, title_en: 'Second', product_ids: [11] }]);
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice.id, 'cn_fridge');
});

it('a config key holding rubbish is read as no notices, not a crash', () => {
  const s = serverWith('not a list');
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]));
});

it('product ids stored as strings still match — an admin JSON round-trip is not a silent miss', () => {
  const s = serverWith([{ ...FRIDGE, product_ids: ['11'] }]);
  const rows = [{ id: 11 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice.id, 'cn_fridge');
});

/* ── 1b · every size of the product (§267) ───────────────────────────────── */
section('1b · a notice on one size covers every size (§267)');

// The live case: the notice named the 300 ml Lemongrass (90); the shop opens
// the 1 L (314), which is the family's hero. The page showed nothing and the
// 1 L went into baskets with no card.
const KOMBUCHA = { 90: 314, 314: 314 };

it('the size the notice does not name gets it from its sibling', () => {
  const s = serverWith([{ ...FRIDGE, product_ids: [90] }], KOMBUCHA);
  const rows = [{ id: 314 }, { id: 90 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice && rows[0].cart_notice.id, 'cn_fridge', 'the 1 L must carry the 300 ml\'s notice');
  assert.strictEqual(rows[1].cart_notice.id, 'cn_fridge');
});

it('a size\'s OWN notice beats one it would inherit', () => {
  const own = { id: 'cn_big', enabled: true, title_en: 'Big bottle', product_ids: [314] };
  const s = serverWith([{ ...FRIDGE, product_ids: [90] }, own], KOMBUCHA);
  const rows = [{ id: 314 }, { id: 90 }];
  s.attachCartNotices(rows);
  assert.strictEqual(rows[0].cart_notice.id, 'cn_big', 'named later in the list, but named — it must not be overwritten by the sibling pass');
  assert.strictEqual(rows[1].cart_notice.id, 'cn_fridge');
});

it('a product outside the family is not touched', () => {
  const s = serverWith([{ ...FRIDGE, product_ids: [90] }], { ...KOMBUCHA, 286: 286, 319: 286 });
  const rows = [{ id: 286 }, { id: 319 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]) && !('cart_notice' in rows[1]), 'Mango is its own family');
});

it('a disabled notice is not inherited either', () => {
  const s = serverWith([{ ...FRIDGE, enabled: false, product_ids: [90] }], KOMBUCHA);
  const rows = [{ id: 314 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]));
});

it('a failed sibling lookup falls back to the named ids — never a broken page', () => {
  const s = serverWith([{ ...FRIDGE, product_ids: [90] }], KOMBUCHA, { throws: true });
  const rows = [{ id: 314 }, { id: 90 }];
  s.attachCartNotices(rows);
  assert.ok(!('cart_notice' in rows[0]));
  assert.strictEqual(rows[1].cart_notice.id, 'cn_fridge');
});

it('the order page reads the same index, so it restates the notice for the inherited size', () => {
  const s = serverWith([{ ...FRIDGE, product_ids: [90] }], KOMBUCHA);
  assert.strictEqual(s.cartNoticeIndex().get(314).id, 'cn_fridge');
});

/* ── 2 · the mini app — the queue and the seen mark ──────────────────────── */
section('2 · the mini app — queue + seen-per-version');

function miniapp() {
  const store = new Map();
  global.wx = {
    getStorageSync: k => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => store.set(k, v),
  };
  const p = require.resolve(path.join(ROOT, 'miniapp', 'utils', 'cart-notice.js'));
  delete require.cache[p];
  const mod = require(p);
  mod._reset();
  return { mod, store };
}

it('a queued notice comes back once and is then seen', () => {
  const { mod } = miniapp();
  assert.strictEqual(mod.queue({ cart_notice: FRIDGE }), true);
  assert.strictEqual(mod.takeNext().id, 'cn_fridge');
  assert.strictEqual(mod.takeNext(), null);
  assert.strictEqual(mod.queue({ cart_notice: FRIDGE }), false, 'seen — never again at this version');
});

it('SEEN IS PER VERSION — an edited notice shows once more', () => {
  const { mod } = miniapp();
  mod.queue({ cart_notice: FRIDGE });
  mod.takeNext();
  assert.strictEqual(mod.queue({ cart_notice: { ...FRIDGE, updated_at: 1700000000001 } }), true);
});

it('two of the same bottle raise one card', () => {
  const { mod } = miniapp();
  mod.queue({ cart_notice: FRIDGE });
  mod.queue({ cart_notice: FRIDGE });
  assert.strictEqual(mod.waiting(), 1);
});

it('two different notices both wait — nothing is dropped on the floor', () => {
  const { mod } = miniapp();
  const other = { id: 'cn_other', title_en: 'Second', updated_at: 5 };
  mod.queue({ cart_notice: FRIDGE });
  mod.queue({ cart_notice: other });
  assert.strictEqual(mod.waiting(), 2);
  assert.strictEqual(mod.takeNext().id, 'cn_fridge');
  assert.strictEqual(mod.takeNext().id, 'cn_other');
});

it('a product with no notice queues nothing', () => {
  const { mod } = miniapp();
  assert.strictEqual(mod.queue({ id: 7 }), false);
  assert.strictEqual(mod.waiting(), 0);
});

it('the key is <id>:<updated_at>, and an unstamped notice reads as 0', () => {
  const { mod } = miniapp();
  assert.strictEqual(mod.seenKey(FRIDGE), 'cart_notice_seen:cn_fridge:1700000000000');
  assert.strictEqual(mod.seenKey({ id: 'x' }), 'cart_notice_seen:x:0');
});

/* ── 3 · the web shop — the same rules, asserted on the other client ─────── */
section('3 · the web shop — BOTH CLIENTS OR NEITHER');

function web() {
  const ls = new Map();
  const closers = [];
  const sandbox = {
    console,
    state: { lang: 'en' },
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, v),
    },
    pick: (en, cn) => ((sandbox.state.lang === 'cn' ? cn : en) || en || cn || ''),
    esc: s => String(s == null ? '' : s),
    document: {
      body: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {} }, set onclick(_) {}, addEventListener() {} }),
    },
    $: () => ({ addEventListener: (_, fn) => closers.push(fn) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'var cnPending=[];\n'
    + grab(SHOP, 'cnSeenKey') + '\n'
    + grab(SHOP, 'cnHasSeen') + '\n'
    + grab(SHOP, 'cnMarkSeen') + '\n'
    + grab(SHOP, 'cnQueue') + '\n'
    + grab(SHOP, 'cnTake') + '\n'
    + grab(SHOP, 'cnStrip') + '\n',
    sandbox);
  return sandbox;
}

it('the web keys the seen mark exactly as the mini app does', () => {
  const w = web();
  const { mod } = miniapp();
  assert.strictEqual(w.cnSeenKey(FRIDGE), mod.seenKey(FRIDGE));
});

it('a queued notice comes back once and is then seen', () => {
  const w = web();
  assert.strictEqual(w.cnQueue(FRIDGE), true);
  assert.strictEqual(w.cnTake().id, 'cn_fridge');
  assert.strictEqual(w.cnTake(), null);
  assert.strictEqual(w.cnQueue(FRIDGE), false);
});

it('SEEN IS PER VERSION on the web too', () => {
  const w = web();
  w.cnQueue(FRIDGE); w.cnTake();
  assert.strictEqual(w.cnQueue({ ...FRIDGE, updated_at: 1700000000001 }), true);
});

it('two of the same bottle raise one card; two notices both wait', () => {
  const w = web();
  w.cnQueue(FRIDGE); w.cnQueue(FRIDGE);
  assert.strictEqual(w.cnPending.length, 1);
  w.cnQueue({ id: 'cn_other', title_en: 'Second', updated_at: 5 });
  assert.strictEqual(w.cnPending.length, 2);
});

it('the PDP strip is empty for a notice with no words, and carries them when there are', () => {
  const w = web();
  assert.strictEqual(w.cnStrip(null), '');
  assert.strictEqual(w.cnStrip({ id: 'x', title_en: '', body_en: '' }), '');
  assert.ok(w.cnStrip(FRIDGE).includes('Let it settle'));
});

/* ── 4 · every add path carries the notice ───────────────────────────────── */
section('4 · every add path carries it');

// The two clients add from several places. Where the call site hands over a
// whole product row the notice rides along for free; where it builds a literal
// it has to be copied across, and a missed one is a notice that is silent from
// exactly the screen the customer used.
it('the mini app raises it from cart.add(), so no call site can forget', () => {
  assert.ok(/cartNotice\.queue\(product\)/.test(CART_JS), 'cart.add must queue the notice itself');
});

it('the mini app literals carry cart_notice (PDP add, bundle, size picker, grid +)', () => {
  const pdp = PRODUCT_JS.match(/cart\.add\(\{[\s\S]*?\}, this\.data\.qty, chosen\)/);
  const size = PRODUCT_JS.match(/cart\.add\(\{[\s\S]*?\}, this\.data\.qty, \[\]\)/);
  const bundle = PRODUCT_JS.match(/cart\.add\(\{\s*id: it\.id[\s\S]*?\}, 1, \[\]\)/);
  const grid = SHOP_JS.match(/cart\.add\(\{[\s\S]*?\}, 1, \[\]\)/);
  for (const [name, m] of [['PDP add', pdp], ['size picker', size], ['bundle', bundle], ['shop grid +', grid]]) {
    assert.ok(m, `${name} call site not found`);
    assert.ok(/cart_notice/.test(m[0]), `${name} drops the notice`);
  }
});

it('the web raises it from cartAdd(), and all four literals carry it', () => {
  assert.ok(/function cartAdd\(line\)[\s\S]{0,900}cnQueue\(line\.cart_notice\)/.test(SHOP),
    'cartAdd must queue the notice itself');
  const sites = SHOP.match(/cartAdd\(\{[\s\S]*?\}\);/g) || [];
  assert.strictEqual(sites.length, 4, `expected 4 cartAdd call sites, found ${sites.length}`);
  sites.forEach((s, i) => assert.ok(/cart_notice/.test(s), `web cartAdd site ${i + 1} drops the notice`));
});

/* ── 5 · one resolver ────────────────────────────────────────────────────── */
section('5 · one resolver');

// `cart_notices.list` is a public config key, like `popups.list` — the admin
// card reads it back through the admin config endpoint, which is the same
// loadConfig(), so it cannot be made private without blinding the editor. That
// leaves it visible to a client that could resolve notices for itself, and a
// second resolver is how the grid and the PDP start disagreeing about the same
// bottle. The server is the only one.
// Comments are dropped before this section's scans. Every file here explains
// in prose what it deliberately does NOT do — "the client never reads that
// config list itself" — and a gate that matched its own rationale would fire on
// the explanation and have to be loosened until it caught nothing.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|<!--)/.test(l))
    .join('\n');
}

it('no customer client reads the notice LIST — they read what the server resolved', () => {
  const clients = {
    'public/shop.html': codeOnly(SHOP),
    'miniapp/utils/cart-notice.js': codeOnly(fs.readFileSync(path.join(ROOT, 'miniapp', 'utils', 'cart-notice.js'), 'utf8')),
    'miniapp/pages/product/product.js': codeOnly(PRODUCT_JS),
    'miniapp/pages/shop/shop.js': codeOnly(SHOP_JS),
    'miniapp/pages/order/order.js': codeOnly(fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'order', 'order.js'), 'utf8')),
    'miniapp/pages/checkout/checkout.js': codeOnly(CHECKOUT_JS),
  };
  for (const [name, src] of Object.entries(clients)) {
    assert.ok(!/cart_notices\.list/.test(src), `${name} reads cart_notices.list`);
    assert.ok(!/config[^\n]{0,40}cart_notices/.test(src), `${name} resolves notices out of the config payload`);
  }
  // `cart_notices` on an ORDER is the server's own resolved list for that
  // order's items and is the intended read — the assertions above allow it and
  // this one keeps it honest by requiring it to come off an order payload.
  for (const [name, src] of Object.entries(clients)) {
    for (const m of src.match(/[A-Za-z_$][\w$]*\.cart_notices/g) || []) {
      assert.ok(/^(o|order|data)\.cart_notices$/.test(m), `${name}: ${m} is not an order payload`);
    }
  }
});

/* ── 6 · the admin card — the stamp moves only when the words do ─────────── */
section('6 · the admin card');

function editor(list, family) {
  const fields = { 'pa-cn-pick': '', 'pa-cn-title-en': '', 'pa-cn-title-cn': '', 'pa-cn-body-en': '', 'pa-cn-body-cn': '' };
  const put = [];
  const sandbox = {
    console, fields, put,
    PA_NOTICES: list, PA_NOTICES_LOADED: true,
    document: { getElementById: id => (id in fields ? { value: fields[id] } : null) },
    toast() {},
    fetch: (url, opt) => { put.push({ url, body: JSON.parse(opt.body) }); return Promise.resolve({ json: () => Promise.resolve({ success: true }) }); },
    paFillCartNotice: () => Promise.resolve(),
    PA_CURRENT: family ? { id: family.open } : null,
    peFamilyIds: () => (family ? family.ids.slice() : []),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    grab(EDITOR, 'paNoticeUid') + '\n'
    + grab(EDITOR, 'paNoticeFamily') + '\n'
    + grab(EDITOR, 'paCartNoticeState') + '\n'
    + grab(EDITOR, 'paSaveCartNotice') + '\n',
    sandbox);
  return sandbox;
}

function savedList(s) {
  assert.strictEqual(s.put.length, 1, 'expected exactly one config write');
  return s.put[0].body['cart_notices.list'];
}

it('attaching a product to an existing notice does not restamp it', async () => {
  const s = editor([JSON.parse(JSON.stringify(FRIDGE))]);
  s.fields['pa-cn-pick'] = 'cn_fridge';
  s.fields['pa-cn-title-en'] = FRIDGE.title_en; s.fields['pa-cn-title-cn'] = FRIDGE.title_cn;
  s.fields['pa-cn-body-en'] = FRIDGE.body_en;   s.fields['pa-cn-body-cn'] = FRIDGE.body_cn;
  await s.paSaveCartNotice(13);
  const n = savedList(s)[0];
  assert.deepStrictEqual(n.product_ids, [11, 12, 13]);
  assert.strictEqual(n.updated_at, 1700000000000, 'an untouched notice must not re-interrupt every customer');
});

it('THE STAMP MOVES ONLY WHEN THE WORDS DO', async () => {
  const s = editor([JSON.parse(JSON.stringify(FRIDGE))]);
  s.fields['pa-cn-pick'] = 'cn_fridge';
  s.fields['pa-cn-title-en'] = 'Let it rest';           // changed
  s.fields['pa-cn-title-cn'] = FRIDGE.title_cn;
  s.fields['pa-cn-body-en'] = FRIDGE.body_en; s.fields['pa-cn-body-cn'] = FRIDGE.body_cn;
  await s.paSaveCartNotice(11);
  const n = savedList(s)[0];
  assert.ok(n.updated_at > 1700000000000, 'a fixed word must show once more');
  assert.strictEqual(n.title_en, 'Let it rest');
});

it('a new notice is stamped and carries only this product', async () => {
  const s = editor([]);
  s.fields['pa-cn-pick'] = 'new';
  s.fields['pa-cn-title-en'] = 'Let it settle';
  await s.paSaveCartNotice(11);
  const list = savedList(s);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].product_ids, [11]);
  assert.ok(list[0].updated_at > 0);
  assert.strictEqual(list[0].enabled, true);
});

it('"new" with nothing typed writes no notice', async () => {
  const s = editor([]);
  s.fields['pa-cn-pick'] = 'new';
  await s.paSaveCartNotice(11);
  assert.strictEqual(s.put.length, 0, 'an empty card is not a notice');
});

it('setting a product to None detaches it and leaves the others alone', async () => {
  const s = editor([JSON.parse(JSON.stringify(FRIDGE))]);
  s.fields['pa-cn-pick'] = '';
  await s.paSaveCartNotice(11);
  assert.deepStrictEqual(savedList(s)[0].product_ids, [12]);
});

it('detaching the last product drops the notice rather than leaving a dead row', async () => {
  const s = editor([{ ...JSON.parse(JSON.stringify(FRIDGE)), product_ids: [11] }]);
  s.fields['pa-cn-pick'] = '';
  await s.paSaveCartNotice(11);
  assert.deepStrictEqual(savedList(s), []);
});

it('a config read that failed never rewrites the list', async () => {
  const s = editor([]);
  s.PA_NOTICES_LOADED = false;
  s.fields['pa-cn-pick'] = 'new';
  s.fields['pa-cn-title-en'] = 'Let it settle';
  await s.paSaveCartNotice(11);
  assert.strictEqual(s.put.length, 0, 'a failed read must not be read as "this tenant has no notices"');
});

it('moving a product from one notice to another detaches it from the first', async () => {
  const s = editor([
    JSON.parse(JSON.stringify(FRIDGE)),
    { id: 'cn_other', enabled: true, title_en: 'Second', product_ids: [20], updated_at: 1 },
  ]);
  s.fields['pa-cn-pick'] = 'cn_other';
  s.fields['pa-cn-title-en'] = 'Second';
  await s.paSaveCartNotice(11);
  const list = savedList(s);
  assert.deepStrictEqual(list.find(n => n.id === 'cn_fridge').product_ids, [12]);
  assert.deepStrictEqual(list.find(n => n.id === 'cn_other').product_ids, [20, 11]);
});

section('6b · the admin card writes the whole size family (§267)');

it('attaching the open size attaches every size', async () => {
  const s = editor([{ ...JSON.parse(JSON.stringify(FRIDGE)), product_ids: [20] }], { open: 314, ids: [90, 314] });
  s.fields['pa-cn-pick'] = 'cn_fridge';
  s.fields['pa-cn-title-en'] = FRIDGE.title_en; s.fields['pa-cn-title-cn'] = FRIDGE.title_cn;
  s.fields['pa-cn-body-en'] = FRIDGE.body_en;   s.fields['pa-cn-body-cn'] = FRIDGE.body_cn;
  await s.paSaveCartNotice(314);
  const n = savedList(s)[0];
  assert.deepStrictEqual(n.product_ids, [20, 90, 314]);
  assert.strictEqual(n.updated_at, 1700000000000, 'adding sizes is not a change of words');
});

it('a new notice covers every size', async () => {
  const s = editor([], { open: 90, ids: [90, 314] });
  s.fields['pa-cn-pick'] = 'new';
  s.fields['pa-cn-title-en'] = 'Chill before opening';
  await s.paSaveCartNotice(90);
  assert.deepStrictEqual(savedList(s)[0].product_ids, [90, 314]);
});

it('None detaches every size, not just the open one', async () => {
  const s = editor([{ ...JSON.parse(JSON.stringify(FRIDGE)), product_ids: [90, 20] }], { open: 314, ids: [90, 314] });
  s.fields['pa-cn-pick'] = '';
  await s.paSaveCartNotice(314);
  assert.deepStrictEqual(savedList(s)[0].product_ids, [20], 'the 300 ml must not keep the notice the operator removed from the 1 L');
});

it('the family helper always includes the open product', () => {
  const s = editor([], { open: 314, ids: [90] });
  assert.deepStrictEqual(Array.from(s.paNoticeFamily(314)).sort((a, b) => a - b), [90, 314]);
  const lone = editor([]);
  assert.deepStrictEqual(Array.from(lone.paNoticeFamily(11)), [11]);
});

it('the picker is filled from any size in the family', () => {
  assert.ok(/const fam = paNoticeFamily\(pid\);\s*const mine = PA_NOTICES\.find\([^\n]*fam\.includes/.test(EDITOR),
    'paFillCartNotice must look up the notice across the family, or the 1 L shows None while it is covered');
});

/* ── 7 · the checkout receipt restates it, every time (§422) ─────────────── */
section('7 · the checkout receipt line (§422)');

// Ash, 2026-10-03: the add-to-cart card shows once per phone and is tapped away
// while choosing flavours, so the warning sits on the checkout receipt under
// the product, on every checkout, and a tap opens the full card.
//
// WHAT THIS LOCKS:
//   • A TAP OPENS THE FULL CARD AND SPENDS NOTHING. Reading it again from the
//     receipt must not mark the notice seen, or a customer who taps it first
//     would never get the card on the add it was meant for.
//   • THE CHECKOUT'S CARD NEVER OPENS BY ITSELF. It must not drain the
//     add-to-cart queue there: the checkout has §196's delivery notices, and a
//     card arriving on its own would land on top of one of them.
//   • THE LINE COMES FROM THE SERVER'S RESOLVER, keyed by product id, and a
//     product without a notice draws nothing.
//   • BOTH CLIENTS OR NEITHER.

// The mini app's notice card, run for real: Component() captured, its
// lifetimes and methods called with a fake `this`.
function card(props = {}) {
  const store = new Map();
  global.wx = {
    getStorageSync: k => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => store.set(k, v),
  };
  global.getApp = () => ({ globalData: { lang: 'en' } });
  const cnPath = require.resolve(path.join(ROOT, 'miniapp', 'utils', 'cart-notice.js'));
  delete require.cache[cnPath];
  const mod = require(cnPath);
  mod._reset();
  let def;
  const sandbox = {
    Component: d => { def = d; },
    require: r => (r.endsWith('cart-notice') ? mod : require(path.join(ROOT, 'miniapp', 'components', 'cart-notice', r))),
    getApp: global.getApp,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(CARD_JS, sandbox);
  const events = [];
  const self = {
    data: { ...JSON.parse(JSON.stringify(def.data)), passive: false, ...props },
    setData(p) { Object.assign(this.data, p); },
    triggerEvent(e) { events.push(e); },
  };
  for (const [k, fn] of Object.entries(def.methods)) self[k] = fn.bind(self);
  return { def, self, mod, store, events };
}

it('mini app: a tap opens the FULL card and marks nothing seen', () => {
  const { self, mod } = card({ passive: true });
  assert.strictEqual(self.open(FRIDGE), true);
  assert.strictEqual(self.data.open, true);
  assert.strictEqual(self.data.title, FRIDGE.title_en);
  assert.strictEqual(self.data.body, FRIDGE.body_en, 'the body is the point — the line only carries the title');
  assert.strictEqual(mod.hasSeen(FRIDGE), false, 'reading it from the receipt must not spend the add-to-cart card');
});

it('mini app: a notice with no words opens nothing', () => {
  const { self } = card({ passive: true });
  assert.strictEqual(self.open({ id: 'x', title_en: '', body_en: '' }), false);
  assert.strictEqual(self.open(null), false);
  assert.strictEqual(self.data.open, false);
});

it('mini app: the PASSIVE card never drains the queue — not on attach, show, or close', () => {
  const { def, self, mod } = card({ passive: true });
  mod.queue({ cart_notice: FRIDGE });
  def.lifetimes.attached.call(self);
  def.pageLifetimes.show.call(self);
  assert.strictEqual(self.data.open, false, 'a queued card must not open by itself on the checkout');
  self.open({ id: 'cn_tofu', title_en: 'Tofu', updated_at: 1 });
  self.onClose();
  assert.strictEqual(self.data.open, false, 'closing the tapped card must not pull the queued one up');
  assert.strictEqual(mod.waiting(), 1, 'the queued notice is still waiting for a screen that may show it');
});

it('mini app: an ordinary card still drains the queue as before', () => {
  const { def, self, mod } = card();
  mod.queue({ cart_notice: FRIDGE });
  def.lifetimes.attached.call(self);
  assert.strictEqual(self.data.open, true);
  assert.strictEqual(mod.hasSeen(FRIDGE), true);
});

// The page method, lifted out of Page({…}) and run with its few dependencies.
function checkoutLoader(items, rows, { fail = false } = {}) {
  const at = CHECKOUT_JS.indexOf('  async loadLineNotices() {');
  assert.ok(at > -1, 'loadLineNotices not found');
  const end = CHECKOUT_JS.indexOf('\n  },', at);
  const body = CHECKOUT_JS.slice(at, end + 4).trim().replace(/,$/, '');
  const calls = [];
  const sandbox = {
    console: { warn() {} },
    cart: { get: () => ({ items }) },
    api: { get: async u => { calls.push(u); if (fail) throw new Error('down'); return { success: true, data: rows }; } },
    lang: { pick: (en, cn, L) => ((L === 'cn' ? cn : en) || en || cn || '') },
  };
  vm.createContext(sandbox);
  const obj = vm.runInContext(`({ ${body} })`, sandbox);
  const page = { data: { lang: 'en', lineNotices: {} }, setData(p) { Object.assign(this.data, p); } };
  return { run: () => obj.loadLineNotices.call(page), page, calls };
}

it('mini app: the line is read from the server-stamped product, keyed by id', async () => {
  const { run, page, calls } = checkoutLoader(
    [{ product_id: 90 }, { product_id: 7 }, { product_id: 90 }],
    [{ id: 90, cart_notice: FRIDGE }, { id: 7 }]);
  await run();
  assert.deepStrictEqual(calls, ['/api/retail/products?ids=90,7']);
  // Compared as JSON: the map is built inside the vm sandbox, and its
  // prototype is that context's Object, which deepStrictEqual counts as a diff.
  assert.strictEqual(JSON.stringify(page.data.lineNotices), JSON.stringify({ 90: FRIDGE.title_en }), 'a product with no notice draws no line');
  assert.strictEqual(page._lineNotices[90], FRIDGE, 'the full notice is kept for the tap');
});

it('mini app: a failed read draws no line rather than breaking the checkout', async () => {
  const { run, page } = checkoutLoader([{ product_id: 90 }], [], { fail: true });
  await run();
  assert.strictEqual(JSON.stringify(page.data.lineNotices), '{}');
});

it('mini app: the receipt draws the line, the tap opens the passive card', () => {
  assert.ok(/wx:if="\{\{lineNotices\[item\.product_id\]\}\}"[^>]*catchtap="openLineNotice"/.test(CHECKOUT_WXML),
    'each receipt line must draw its notice and open it on a tap');
  assert.ok(/<cart-notice id="line-notice" passive="\{\{true\}\}">/.test(CHECKOUT_WXML),
    'the checkout card must be passive, or it drains the queue over §196\'s notices');
  assert.ok(/"cart-notice":\s*"\/components\/cart-notice\/cart-notice"/.test(CHECKOUT_JSON));
  assert.ok(/'查看详情' : 'Read full notice'/.test(CHECKOUT_WXML));
  assert.ok(/this\.loadLineNotices\(\);\s*if \(!isBound\) return;/.test(CHECKOUT_JS),
    'loaded before the bind gate — the warning is on the receipt whoever is looking');
});

function webCheckout(rows, { fail = false } = {}) {
  const ls = new Map();
  let drawn = null;
  const sandbox = {
    console,
    state: { lang: 'en' },
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, v) },
    pick: (en, cn) => ((sandbox.state.lang === 'cn' ? cn : en) || en || cn || ''),
    esc: s => String(s == null ? '' : s),
    escAttr: s => String(s == null ? '' : s),
    cartGet: () => [{ product_id: 90 }, { product_id: 7 }],
    coRenderItems: () => {},
    api: async () => { if (fail) throw new Error('down'); return rows; },
    document: {
      body: { appendChild() {} },
      createElement: () => ({ set innerHTML(v) { drawn = v; }, get innerHTML() { return drawn; } }),
    },
    $: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'var cnPending=[];\n'
    + grab(SHOP, 'cnSeenKey') + '\n' + grab(SHOP, 'cnHasSeen') + '\n' + grab(SHOP, 'cnMarkSeen') + '\n'
    + grab(SHOP, 'cnOpen') + '\n' + grab(SHOP, 'cnDraw') + '\n'
    + 'var coLineNotices={};\n'
    + grab(SHOP, 'coLoadLineNotices') + '\n' + grab(SHOP, 'coNoteTag') + '\n',
    sandbox);
  // cnDraw finds its overlay through $; hand it one that records what it drew.
  const ov = { hidden: true, set innerHTML(v) { drawn = v; }, get innerHTML() { return drawn; } };
  sandbox.$ = sel => (sel === '#cnotePop' ? ov : { addEventListener() {} });
  return { w: sandbox, ov, drawn: () => drawn };
}

it('web: a tap opens the FULL card and marks nothing seen', () => {
  const { w, ov, drawn } = webCheckout([]);
  assert.strictEqual(w.cnOpen(FRIDGE), true);
  assert.strictEqual(ov.hidden, false);
  assert.ok(drawn().includes(FRIDGE.body_en), 'the full text, not just the title');
  assert.strictEqual(w.cnHasSeen(FRIDGE), false);
  assert.strictEqual(w.cnOpen(null), false);
});

it('web: the line is read from the server-stamped product and draws only where there is a notice', async () => {
  const { w } = webCheckout([{ id: 90, cart_notice: FRIDGE }, { id: 7 }]);
  await w.coLoadLineNotices();
  const tag = w.coNoteTag(90);
  assert.ok(tag.includes(FRIDGE.title_en) && tag.includes('Read full notice') && tag.includes('data-pid="90"'));
  assert.strictEqual(w.coNoteTag(7), '');
  w.state.lang = 'cn';
  assert.ok(w.coNoteTag(90).includes('查看详情'));
});

it('web: a failed read draws no line', async () => {
  const { w } = webCheckout([], { fail: true });
  await w.coLoadLineNotices();
  assert.strictEqual(w.coNoteTag(90), '');
});

it('web: the receipt draws the line and a tap opens it; the checkout loads it without waiting on an address', () => {
  assert.ok(/\$\{l\.ship_from_supplier\?supTag\(\):''\}\$\{coNoteTag\(l\.product_id\)\}/.test(SHOP));
  assert.ok(/closest\('\.cx-note'\);if\(b\)cnOpen\(coLineNotices\[b\.dataset\.pid\]\)/.test(SHOP));
  assert.ok(/coLoadLineNotices\(\);[^\n]*\n\s*await coLoadAddrs\(\);/.test(SHOP));
});

/* ── run ─────────────────────────────────────────────────────────────────── */
(async () => {
  for (const t of TESTS) {
    if (t.section) { console.log(`\n${t.section}`); continue; }
    try { await t.fn(); console.log(`  ✓ ${t.name}`); pass++; }
    catch (e) { console.log(`  ✗ ${t.name}\n      ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
