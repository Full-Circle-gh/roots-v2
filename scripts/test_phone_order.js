#!/usr/bin/env node
/**
 * test_phone_order.js — a phone order, taken on a phone (audit N-02).
 *
 *   node scripts/test_phone_order.js
 *
 * THE FINDING. "Taking an order over the telephone is a daily task in a shop,
 * and the phone is where the shopkeeper is standing. The mobile app
 * deliberately has no create surface." It had none because the one it used to
 * have was a lie — a submit handler that showed "Created" and sent nothing —
 * and deleting a lie is the right first move. This is the second one.
 *
 * WHAT THIS CHECKS, and why each half is here:
 *
 *   1. The form's own rules, driven rather than read. onwBlocked() is the
 *      sentence an operator reads before pressing the button, and every one of
 *      its branches is a refusal the server would otherwise answer with after
 *      the order has been typed. They are asserted in the order they are asked.
 *
 *   2. The payload. This is the half that cannot be seen by looking at the
 *      screen: a shipping fee left standing after a switch from delivery to
 *      pickup is refused by the server, an address on a collection is refused,
 *      and a `save_customer` flag on an order already attached to an account
 *      would fork a record. All three are shaped in onwBody(), so all three are
 *      driven here with a real state object.
 *
 *   3. Coverage of the server's own vocabulary. Every error code the create
 *      route can answer with is looked up in the screen's code→section map, so
 *      the day the route grows a new one, this fails rather than the operator
 *      reading "That did not save" with no idea which field to look at.
 *
 *   4. The keyboard rule. m.html renders by rebuilding its own innerHTML, which
 *      removes the focused input from the document — and a removed input drops
 *      the on-screen keyboard on some Android builds however fast it is put
 *      back. The waste sheet documents this at length. So no plain text field
 *      in this form may call render(), and this greps every one of them.
 *
 * The screen's own functions are lifted out of public/m.html and run in a
 * sandbox against stubs, so these are the real predicates and the real payload
 * builder — not a second copy of them written to agree with itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const M    = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const RET  = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
const CAPS = fs.readFileSync(path.join(ROOT, 'lib/cap-routes.js'), 'utf8');

// ── the block itself, lifted out of the page ──────────────────────────────
const START = '   New order — one taken on the phone (audit N-02)';
const END   = '   Purchasing — the goods ledger (desktop: 16-purchasing.js)';
const s0 = M.indexOf(START), s1 = M.indexOf(END);
if (s0 < 0 || s1 < 0 || s1 < s0) {
  console.error('FAIL — cannot find the New order block in public/m.html');
  process.exit(1);
}
// Back up to the banner's opening line, forward to the one that follows it.
const BLOCK = M.slice(M.lastIndexOf('/* ===', s0), M.lastIndexOf('/* ===', s1));

// ── a sandbox with everything the block reaches for ───────────────────────
const calls = { render: 0, toast: null, api: [], write: [], forgetPushed: 0, seen: 0, orders: 0 };
let LANG = 'en';
const later = [];                       // resolvers for the stubbed reads
function deferred(store, pathArg, body) {
  store.push({ path: pathArg, body });
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  later.push({ path: pathArg, resolve, reject });
  return p;
}
const ctx = {
  console,
  setTimeout, clearTimeout,
  LANG,
  T: (en, zh) => (ctx.LANG === 'en' ? en : (zh || en)),
  E: (en, zh) => ({ toString() { return ctx.T(en, zh); } }),
  escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  ic: () => '<svg></svg>',
  CUR: '¥',
  money: (cur, n) => (cur || '¥') + Number(n || 0),
  PAY_METHODS: [['cash', 'Cash', '现金'], ['bank_transfer', 'Bank transfer', '银行转账'],
                ['wechat_offline', 'WeChat (off app)', '微信（线下）'],
                ['alipay_offline', 'Alipay (off app)', '支付宝（线下）'], ['other', 'Other', '其他']],
  canRoute: () => true,
  render: () => { calls.render++; },
  showToast: (m) => { calls.toast = String(m); },
  forgetPushed: () => { calls.forgetPushed++; },
  markOrdersSeen: () => { calls.seen++; },
  loadOrdersPage: () => { calls.orders++; },
  mapDetail: (o) => ({ id: o.order_no || ('#' + o.id) }),
  api: (p) => deferred(calls.api, p),
  apiRaw: (p) => deferred(calls.api, p),
  apiWrite: (p, b) => deferred(calls.write, p, b),
  document: { getElementById: () => null, activeElement: null },
  CMD: {},
};
ctx.reg = (n, f) => { ctx.CMD[n] = f; };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(BLOCK + '\nglobalThis.__ONW={onwBlank,onwReset,onwBlocked,onwBody,onwAddress,onwHasWork,'
  + 'onwSubtotal,onwTotal,onwDistrictRequired,onwErrText,onwFeeNote,onwLinesHtml,onwFootHtml,'
  + 'screenNewOrder,ONW_WHERE,ONW_ORIGINS,ONW_FULS,onwSyncStore};', ctx);
const A = ctx.__ONW;

// A form with one line, a name and an origin — everything a delivery needs bar
// the address. Every test below starts from this and breaks one thing.
function form(over) {
  ctx.state = {
    stores: [], caps: null, ask: null, focus: null, tab: 'more', stack: [],
    detailId: null, drag: 0, liveDetail: null, detailMounted: false, detailActions: false,
    orderErr: null, orderBusy: null, orderOverCust: false, detailFetch: false,
    onw: A.onwBlank([]),
  };
  Object.assign(ctx.state.onw, {
    name: 'Chen Meiling', phone: '13800002841', channel: 'wechat_chat',
    lines: [{ id: 7, en: 'Oat milk 1L', cn: '燕麦奶 1L', price: 32, qty: 2 }],
  }, over || {});
  return ctx.state.onw;
}

// ── §1 · the questions, in the order they are asked ───────────────────────
section('1 · what is still missing, said before the button is pressed');

{
  const o = form({ ful: 'pickup' });
  is(A.onwBlocked(), '', 'a pickup with a name, a line and an origin is ready to send');

  o.name = '   ';
  is(A.onwBlocked(), 'Enter a name for the order.', 'no name blocks first — it is what the label is addressed to');
  o.name = 'Chen Meiling';

  o.lines = [];
  is(A.onwBlocked(), 'Add at least one product.', 'an order with nothing in it blocks');
  o.lines = [{ id: 7, en: 'Oat milk', cn: '燕麦奶', price: 32, qty: 0 }];
  is(A.onwBlocked(), 'Every line needs a quantity of 1 or more.', 'a line at zero blocks — the server refuses it as invalid_item');
  o.lines = [{ id: 7, en: 'Oat milk', cn: '燕麦奶', price: 32, qty: 2 }];

  o.channel = '';
  is(A.onwBlocked(), 'Say where this order came from.', 'origin is required — the server refuses channel_required for anything but a counter sale');
  o.channel = 'other';
  is(A.onwBlocked(), 'Write where this order came from.', '"Other" without a note is the unattributable bucket under another name');
  o.channelNote = 'Xiaohongshu message';
  is(A.onwBlocked(), '', 'with the note it goes');
}

{
  // A collection has to name the counter it will be collected from — but only
  // where there is a choice to make.
  const o = form({ ful: 'pickup' });
  ctx.state.stores = [{ id: 1, name_en: 'Tianhe' }, { id: 2, name_en: 'Panyu' }];
  is(A.onwBlocked(), 'Pick a store.', 'a pickup at a two-store shop must say which store');
  o.storeId = 2;
  is(A.onwBlocked(), '', 'once picked it goes');
  ctx.state.stores = [{ id: 1, name_en: 'Tianhe' }];
  o.storeId = null;
  is(A.onwBlocked(), '', 'a one-store shop is never asked — §1.9, a picker that can only pick one thing is not a choice');
  A.onwSyncStore();
  is(o.storeId, 1, 'and the single store is filled in for the order anyway');
}

{
  const o = form({ ful: 'delivery' });
  is(A.onwBlocked(), 'A delivery order needs a full address.', 'a delivery with no city blocks');
  o.city = '上海市'; o.street = '';
  is(A.onwBlocked(), 'A delivery order needs a full address.', 'a city with no street still blocks');
  o.street = 'Fuxing Road 12';
  is(A.onwBlocked(), '', 'city plus street is an address');
  is(A.onwDistrictRequired(), false, 'Shanghai may be delivered to city-wide');

  o.city = '广州市'; o.district = '';
  is(A.onwDistrictRequired(), true, 'Guangzhou is the one city whose district decides rider vs courier');
  yes(String(A.onwBlocked()).indexOf('Guangzhou district') >= 0,
      'so a Guangzhou order with no district blocks, and says why', A.onwBlocked());
  o.district = '番禺区';
  is(A.onwBlocked(), '', 'with a district it goes');
}

// ── §2 · the payload — the half nobody can see on the screen ──────────────
section('2 · what actually gets posted');

{
  form({ ful: 'delivery', city: '广州市', province: '广东省', district: '天河区',
                   street: 'Tianhe Road 1', ship: 12, pack: 3 });
  const b = A.onwBody();
  is(b.fulfillment_type, 'delivery', 'fulfillment_type is always sent — the server refuses an absent one');
  is(b.shipping_fee, 12, 'a delivery carries its shipping fee');
  is(b.packing_fee, 3, 'and its packing fee');
  is(b.status, 'pending_payment', 'unpaid by default — a phone order is paid when the money lands');
  is(b.payment_method, 'offline', 'and no tender is claimed');
  is(b.channel, 'wechat_chat', 'the origin travels');
  is(b.channel_note, null, 'and its note is null unless the origin is "other"');
  is(b.address.city, '广州市', 'the address snapshot carries the city');
  is(b.address.province, '广东省', 'and the province read off the picked city, never typed');
  is(b.address.district, '天河区', 'and the district that decides how it ships');
  is(b.items.length, 1, 'one line');
  is(b.items[0].product_id, 7, 'by product id');
  is(b.items[0].qty, 2, 'with its quantity');
  is(b.customer_id, null, 'a guest order carries no customer');
  is(b.save_customer, undefined, 'and does not ask for one to be created unless told to');
}

{
  // The stale-quote case. The operator typed a delivery, quoted ¥12 of
  // shipping, then switched to pickup — the server refuses a shipping fee on a
  // collection, and the refusal would arrive after they had stopped looking.
  const o = form({ ful: 'delivery', city: '上海市', street: 'Fuxing Road 12', ship: 12, pack: 3 });
  ctx.CMD.onwFul('pickup');
  is(o.ship, 0, 'switching to a collection clears the shipping quote in state');
  is(o.feeTouched.ship, false, 'and un-marks it, so the next quote may fill it again');
  const b = A.onwBody();
  is(b.shipping_fee, 0, 'nothing ships on a collection, so nothing is charged for shipping');
  is(b.address, undefined, 'and no address travels — the server refuses address_not_allowed_for_pickup');
  is(b.packing_fee, 3, 'packing survives: a collection is still boxed');
}

{
  form({ paid: true, pay: 'wechat_offline', ful: 'pickup' });
  const b = A.onwBody();
  is(b.status, 'paid', 'marking it paid sends paid');
  is(b.payment_method, 'wechat_offline', 'with the wallet that took the money, so the day splits correctly');
}

{
  const o = form({ ful: 'pickup', saveCust: true });
  is(A.onwBody().save_customer, true, 'a guest may be saved as a customer by the order itself');
  o.cust = { id: 42, nickname: 'Chen Meiling', phone: '13800002841' };
  const b = A.onwBody();
  is(b.customer_id, 42, 'a linked customer travels as an id');
  is(b.save_customer, undefined, 'and is never re-created — that would fork the record');
  is(b.recipient_name, 'Chen Meiling', 'the recipient is the order’s own, not the record’s');
}

{
  const o = form({ ful: 'pickup', channel: 'other', channelNote: '  Xiaohongshu  ' });
  is(A.onwBody().channel_note, 'Xiaohongshu', '"Other" carries its note, trimmed');
  o.channel = 'wholesale';
  is(A.onwBody().channel_note, null, 'and switching away from it drops the note rather than mis-filing it');
}

// ── §3 · the money the operator reads back down the telephone ─────────────
section('3 · the total');

{
  const o = form({ ful: 'delivery', ship: 12, pack: 3, city: '上海市', street: 'x' });
  o.lines = [{ id: 7, en: 'A', cn: 'A', price: 32, qty: 2 }, { id: 8, en: 'B', cn: 'B', price: 10, qty: 3 }];
  is(A.onwSubtotal(), 94, 'the subtotal is the lines');
  is(A.onwTotal(), 109, 'the total is the lines plus both fees');
  ctx.CMD.onwFul('pickup');
  is(A.onwTotal(), 97, 'and drops the shipping the moment nothing is being shipped');
}

// ── §4 · the lines ────────────────────────────────────────────────────────
section('4 · adding, counting and removing a line');

{
  const o = form({ ful: 'pickup' });
  o.lines = [];
  o.picks = [{ id: 7, name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', sell_price: 32 }];
  ctx.CMD.onwAddLine(7);
  is(o.lines.length, 1, 'a tap on a search result adds a line');
  is(o.lines[0].price, 32, 'at the product’s own price');
  is(o.q, '', 'and clears the search, so the next product starts fresh');
  o.picks = [{ id: 7, name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', sell_price: 32 }];
  ctx.CMD.onwAddLine(7);
  is(o.lines.length, 1, 'the same product twice is one line');
  is(o.lines[0].qty, 2, 'with two on it');
  ctx.CMD.onwQty(0, -1);
  is(o.lines[0].qty, 1, 'the stepper comes down');
  ctx.CMD.onwQty(0, -1);
  is(o.lines[0].qty, 1, 'and stops at one — removing a line is the × , not a quantity of zero');
  ctx.CMD.onwDropLine(0);
  is(o.lines.length, 0, 'and the × removes it');
}

// ── §5 · every refusal the server can answer with has a home ──────────────
section('5 · the server’s vocabulary, covered');

{
  const at = RET.indexOf("router.post('/api/retail-admin/orders'");
  const end = RET.indexOf('\nrouter.', at + 10);
  const handler = RET.slice(at, end);
  yes(handler.length > 5000, 'found the create route');
  const raw = [...new Set([...handler.matchAll(/error:\s*'([a-z_0-9]+)'/g)].map((m) => m[1]))];
  // Two of them are built by concatenation — `'address_not_allowed_for_' +
  // fulfillmentType` — and only two fulfilment types can produce each: the rule
  // is "everything that is not a delivery".
  const codes = [];
  for (const c of raw) {
    if (c.endsWith('_for_')) { codes.push(c + 'pickup', c + 'counter'); } else codes.push(c);
  }
  // The line helper and the customer helper answer with their own codes, from
  // outside the slice above. Named here so a rename of one is caught too.
  for (const c of ['invalid_item', 'product_unavailable', 'bad_unit_price',
                   'name_or_phone_required', 'bad_email']) codes.push(c);
  const missing = codes.filter((c) => !A.ONW_WHERE[c]).sort();
  yes(missing.length === 0,
      `all ${codes.length} refusals the create route can answer with land on a section of the form`,
      missing.length ? 'unmapped: ' + missing.join(', ') : '');
  // And every section named is one the screen actually renders.
  const sections = [...new Set(Object.values(A.ONW_WHERE))].sort();
  const drawn = ['from', 'how', 'what', 'who'];
  is(sections.join(','), drawn.join(','), 'and every section named exists on the screen');
}

{
  // Each mapped code has a sentence, in both languages, and an unknown one
  // still says something rather than nothing.
  const HOUSE = String(A.onwErrText('nothing_is_mapped_to_this', null));
  let sentences = 0, chinese = 0;
  for (const code of Object.keys(A.ONW_WHERE)) {
    const en = String(A.onwErrText(code, null));
    ctx.LANG = 'zh';
    const zh = String(A.onwErrText(code, null));
    ctx.LANG = 'en';
    if (en !== HOUSE) sentences++;
    if (/[一-鿿]/.test(zh)) chinese++;
  }
  yes(sentences >= 18, `${sentences} of the mapped codes say what happened in their own words`);
  is(chinese, Object.keys(A.ONW_WHERE).length, 'and every one of them answers in Chinese too');
  yes(String(A.onwErrText('something_new_next_year', null)).indexOf('Nothing was created') >= 0,
      'a code nobody has written a sentence for still says nothing was created');
}

// ── §6 · the create, driven ───────────────────────────────────────────────
async function pressTheButton() {
  section('6 · pressing the button');
  form({ ful: 'pickup' });
  calls.write.length = 0; calls.api.length = 0; later.length = 0;
  calls.toast = null; calls.forgetPushed = 0; calls.seen = 0; calls.orders = 0;
  ctx.CMD.onwCreate();
  is(calls.write.length, 1, 'the button posts once');
  is(calls.write[0].path, '/orders', 'to the same endpoint the desktop and the till use');
  is(ctx.state.onw.busy, true, 'and the form says it is working');
  ctx.CMD.onwCreate();
  is(calls.write.length, 1, 'a second press while it is in flight does not post a second order');
  later.shift().resolve({ data: { id: 9, order_no: 'RT-0009', total: 64 } });
  await new Promise((r) => setTimeout(r, 5));
  is(ctx.state.onw.lines.length, 0, 'a created order leaves an empty form behind');
  is(ctx.state.onw.name, '', 'with nothing of the last customer on it');
  is(ctx.state.tab, 'orders', 'and lands on the list');
  is(ctx.state.stack.length, 0, 'with the form closed');
  is(calls.toast, 'Order created', 'saying so');
  is(ctx.state.detailId, 'RT-0009', 'and opens the order that was just made');
  is(ctx.state.detailFetch, true, 'holding the sheet while its own read is in flight');
  is(calls.orders, 1, 'the list behind it is refetched');
  yes(calls.api.some((c) => c.path === '/orders/9'), 'by id, because it is not in the list yet');

  // A refusal renders where the operator is looking, and NOTHING is thrown away.
  section('6b · a refusal');
  form({ ful: 'pickup' });
  calls.write.length = 0; later.length = 0;
  ctx.CMD.onwCreate();
  const e = new Error('store not found'); e.code = 'store_not_found';
  later.shift().reject(e);
  await new Promise((r) => setTimeout(r, 5));
  is(ctx.state.onw.busy, false, 'the button comes back');
  is(ctx.state.onw.lines.length, 1, 'the typed order is still there — nothing was created, so nothing is cleared');
  is(ctx.state.onw.err.where, 'how', 'the message lands on the section that owns the control');
  is(String(ctx.state.onw.err.msg), 'That store no longer exists. Pick another.', 'in the server’s own words');
  ctx.LANG = 'zh';
  yes(/[一-鿿]/.test(String(ctx.state.onw.err.msg)), 'and in Chinese for whoever is reading it in Chinese');
  ctx.LANG = 'en';
}

// ── §7 · the screen, painted ──────────────────────────────────────────────
function paint() {
  section('7 · what the screen puts on the glass');
  const o = form({ ful: 'delivery', city: '广州市', street: 'Tianhe Road 1' });
  o.districts = [{ name_cn: '天河区' }, { name_cn: '番禺区' }];
  const html = A.screenNewOrder();
  yes(html.indexOf("APP.cmd('onwCreate')") > 0, 'the commit is on screen');
  yes(html.indexOf('mOnwShip') > 0, 'a delivery is asked for a shipping fee');
  yes(html.indexOf('Street address') > 0, 'and for a street');
  yes(html.indexOf('天河区') > 0, 'the districts of the picked city are offered');
  for (const org of A.ONW_ORIGINS) {
    yes(html.indexOf("APP.cmd('onwOrigin','" + org.k + "')") > 0, `origin "${org.k}" can be chosen`);
  }
  ctx.CMD.onwFul('pickup');
  const p = A.screenNewOrder();
  is(p.indexOf('mOnwShip'), -1, 'a collection is never asked for a shipping fee — the server refuses one');
  is(p.indexOf('Street address'), -1, 'nor for an address, for the same reason');
  yes(p.indexOf('mOnwPack') > 0, 'but it is still boxed, so packing stays');
  // The empty form has nothing to clear, and says so by not offering it.
  ctx.state.onw = A.onwBlank([]);
  is(A.onwHasWork(), false, 'a form nobody has typed in has no work in it');
  ctx.state.onw.name = 'Chen';
  is(A.onwHasWork(), true, 'one line of typing is work worth a confirm before clearing it');
}

// ── §8 · the wiring, and the keyboard ─────────────────────────────────────
function wiring() {
  section('8 · reachable, gated, and typed into without the keyboard dropping');

  yes(/neworder:'orders:edit'/.test(M), 'the screen is gated on orders:edit, not orders:view');
  yes(/orders:edit/.test(CAPS), 'which is the capability the create route itself is gated on');
  yes(/\n {2}neworder:\{title:\['New order','新建订单'\]/.test(M), 'it is a screen in SUBS, with both halves of its name');
  yes(M.indexOf("['neworder','file-plus','New order','新建订单']") > 0, 'it has a row in More → Operations');
  yes(M.indexOf("canRoute('neworder')") > 0 && M.indexOf('APP.cmd(\'push\',\'neworder\')') > 0,
      'and a button in the Orders header, gated the same way');

  // The keyboard rule. A plain text field must not go through render().
  const handlers = ['onwName', 'onwPhone', 'onwStreet', 'onwNote', 'onwStaffNote', 'onwOriginNote', 'onwFee'];
  for (const h of handlers) {
    const at = BLOCK.indexOf("reg('" + h + "'");
    yes(at > 0, `${h} is registered`);
    const body = BLOCK.slice(at, BLOCK.indexOf('\nreg(', at + 5));
    yes(!/[^a-zA-Z]render\(\)/.test(body),
        `${h} never re-renders the app — that would take the input being typed into out of the document`,
        body.trim().split('\n')[0]);
  }
  yes(BLOCK.indexOf('function onwRepaintFoot') > 0, 'the money and the blocking sentence are patched instead');

  // The origins offered are the server's own, minus the one it refuses here.
  const origins = (RET.match(/const MANUAL_ORDER_ORIGINS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const allowed = [...origins.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  is(A.ONW_ORIGINS.map((x) => x.k).join(','), allowed.join(','),
     'the origin chips are exactly MANUAL_ORDER_ORIGINS, in the server’s own order');
  yes(!A.ONW_ORIGINS.some((x) => x.k === 'manual'),
      "and never 'manual' — the till's value, which the route refuses for anything that is not a counter sale");
  const fuls = (RET.match(/const ORDER_FULFILLMENT_TYPES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const fulAllowed = [...fuls.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  yes(A.ONW_FULS.every((x) => fulAllowed.includes(x.k)), 'both fulfilment chips are types the server knows');
  yes(!A.ONW_FULS.some((x) => x.k === 'counter'),
      'and counter is not one of them — a walk-in rings up at the till, which is built for it');

  // One endpoint, not two. A second write path here is a second contract.
  const writes = [...BLOCK.matchAll(/apiWrite\('([^']+)'/g)].map((m) => m[1]).sort();
  is([...new Set(writes)].join(','), '/order-fees,/orders',
     'the screen writes to exactly two endpoints: the fee quote, and the order');
}

(async () => {
  await pressTheButton();
  paint();
  wiring();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
