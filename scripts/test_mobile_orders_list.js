#!/usr/bin/env node
/**
 * §325 step O2 — THE PHONE'S ORDERS LIST CATCHES UP WITH THE DESKTOP'S.
 *
 *   node scripts/test_mobile_orders_list.js
 *
 *   1. the status chips the desktop strip has and the phone did not: Rider
 *      coming, Needs a call, Cancelled, To recover, Refunded, and the fapiao
 *      requests — each sent as the server's own status value;
 *   2. "View all N orders" from the customer record, scoping the list to that
 *      customer (customer_id), with a clearable chip;
 *   3. the CSV (GET /orders/export.csv) at exactly the list's filters, drawn
 *      for orders:export;
 *   4. saved views (GET/POST/PATCH/DELETE /views, screen 'orders'), keyed the
 *      server's way so a view saved on the desktop applies here;
 *   5. two language bugs folded in: the order total's Subtotal / Shipping
 *      labels, and the list's note chips, both fixed in the language they were
 *      fetched in.
 *
 * The code is RUN, sliced out of the shipped public/m.html into a sandbox, so
 * this needs no browser and sits in the fast shard. Every write is asserted on
 * its request: method, path and every body field.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK_ORD = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DESK_VIEWS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '25-views.js'), 'utf8');
const DESK_CU = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '08-customers.js'), 'utf8');
const DESK_X = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '10-extras.js'), 'utf8');
const DESK_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}

const CODE = [
  sliceBetween('const STATUS_PARAM={', '\nconst ORDERS_PAGE='),
  'const ORDERS_PAGE=25;',
  sliceFn('ordersFilterParams'),
  sliceFn('ordersQuery'),
  sliceFn('chipRow'),
  sliceFn('ordersHeader'),
  sliceFn('ordersFiltered0'),
  sliceFn('sheetOrdViews'),
  sliceFn('custRecentOrders'),
  sliceFn('orderNotes'),
  sliceFn('ordNoteLabel'),
  sliceFn('orderBreakdown'),
  sliceFn('mapOrderRow'),
  sliceBetween("reg('statusF',", "reg('closeOrder',"),
  // §325 O10 — the header's Drafts door asks the drafts' own gate.
  sliceBetween('const draftsOn=', '\nfunction onwToDraft('),
].join('\n');

const tick = () => new Promise((r) => setImmediate(r));

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], loads: 0, nav: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (c, n) => c + Number(n).toFixed(2),
    fmtDay: (v) => 'D(' + v + ')',
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    canRoute: (k) => (opts.routes ? opts.routes.includes(k) : true),
    // §325 O10 — Bulk attach tracking shows only while Settings → Delivery's switch is on.
    cfgGet: (k, d) => (k === 'delivery.bulkTracking' ? !!opts.bulkTracking : d),
    custSection: (t, b) => `<section><h>${t}</h>${b}</section>`,
    ORDER_STATUS: { paid: ['paid', 'Paid', '已付款'], refunded: ['refund', 'Refunded', '已退款'] },
    CH_BACK: { wechat: 'miniapp' },
    custLines: (r) => ({ name: r.recipient_name || '—', phone: r.recipient_phone || '—' }),
    earlyShipFacts: () => null, routingNotePair: () => null, listWaitingOn: () => null,
    parcelRollup: () => null, isMirrorCh: () => false, payNoteOf: () => null,
    payLabel: () => ['WeChat', '微信'], payIsKnown: () => true, payStatusWord: () => null, primaryPayment: () => null,
    location: { href: '' },
    state: Object.assign({
      statusF: 'all', channelF: 'all', storeF: 'all', orderQ: '', ordCust: null,
      stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店' }, { id: 2, name_en: 'Baiyun', name_cn: '白云店' }],
      liveStatusCounts: { pending_payment: 2, paid: 3, preparing: 1, rider_pickup: 4, dispatched: 5, awaiting_restock: 1, refunds_open: 2, needs_invoice: 6 },
      liveChannelCounts: { all: 40, wechat: 30 },
      ordViews: { open: false, rows: undefined, loading: false, busy: null, err: null },
      custId: 9, custDetail: null, caddr: null, detailId: null, stack: ['x'], tab: 'customers', ask: null, askErr: null,
    }, opts.state || {}),
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    loadOrdersPage: () => { calls.loads++; },
    forgetPushed: () => { calls.nav.push('forget'); },
    markOrdersSeen: () => {},
    loadCustomers: () => {},
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => {
      calls.gets.push(p);
      if (opts.viewsFail) return Promise.reject(new Error('HTTP 500'));
      return Promise.resolve(opts.views || []);
    },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method: method || 'POST' });
      if (opts.writeFails) return Promise.reject(Object.assign(new Error('too_many_views'), { code: 'too_many_views' }));
      return Promise.resolve({ success: true });
    },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls };
}

async function main() {
  console.log('\n1 · the desktop\'s missing status chips');
  {
    const { ctx } = mk();
    const html = ctx.ordersHeader();
    for (const [key, label] of [['rider', 'Rider coming'], ['delayed', 'Delivery needs a call'], ['cancelled', 'Cancelled'],
      ['recover', 'To recover'], ['refunded', 'Refunded'], ['invoice', 'Fapiao']]) {
      has(html, `APP.cmd('statusF','${key}')`, 'a chip for ' + label);
      has(html, `<span>${label}</span>`, 'labelled ' + label);
    }
    has(html, '<span>Rider coming</span><span class="c">4</span>', 'Rider coming carries the rider_pickup count');
    has(html, '<span>Fapiao</span><span class="c">6</span>', 'the fapiao chip carries the still-to-issue count');
    hasnt(html, '<span>Cancelled</span><span class="c">', 'a terminal state carries no badge');
    const want = { rider: 'rider_pickup', delayed: 'delayed', cancelled: 'cancelled', recover: 'recover_parcel', refunded: 'refunded', invoice: 'needs_invoice' };
    for (const k of Object.keys(want)) {
      ctx.state.statusF = k;
      is(ctx.ordersQuery(0), `status=${want[k]}&limit=25&offset=0`, `the ${k} chip asks the server for status=${want[k]}`);
    }
    const desk = DESK_HTML.slice(DESK_HTML.indexOf('id="orders-status-chips"'), DESK_HTML.indexOf('id="ord-chip-drafts"'));
    const deskStatuses = [...desk.matchAll(/data-status="([a-z_]*)"/g)].map((m) => m[1]).filter(Boolean);
    const phoneStatuses = Object.values(ctx.STATUS_PARAM || vm.runInContext('STATUS_PARAM', ctx)).filter(Boolean);
    is(deskStatuses.filter((s) => !phoneStatuses.includes(s)), [], 'every desktop status chip has a phone chip');
    const z = mk({ lang: 'zh' });
    const zh = z.ctx.ordersHeader();
    for (const w of ['骑手前往取货', '配送需要跟进', '已取消', '待收回', '已退款', '发票']) has(zh, w, 'Chinese: ' + w);
    for (const [en, cn] of [['Rider coming', '骑手前往取货'], ['Cancelled', '已取消'], ['To recover', '待收回'], ['Refunded', '已退款']]) {
      has(DESK_X, `'${en}': '${cn}'`, `the desktop's own pair: ${en} · ${cn}`);
    }
  }

  console.log('\n2 · one customer\'s orders, from the record');
  {
    const d = { customer: { id: 42, nickname: 'Li <b>' }, stats: { orders: { orders_count: 12 } },
      recent_orders: [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, order_no: 'TC' + i, total: 10, status: 'paid', created_at: 'x' })) };
    const m = mk();
    const rec = m.ctx.custRecentOrders(d);
    has(rec, 'View all 12 orders', 'the record offers all 12');
    has(rec, "APP.cmd('ordViewCust')", 'wired');
    hasnt(mk({ routes: ['customers'] }).ctx.custRecentOrders(d), 'View all', 'not offered to someone who cannot open Orders (capability-denied)');
    hasnt(m.ctx.custRecentOrders(Object.assign({}, d, { stats: { orders: { orders_count: 5 } } })), 'View all', 'not when every order is already shown');
    has(mk({ lang: 'zh' }).ctx.custRecentOrders(d), '查看全部 12 笔订单', 'Chinese');

    m.ctx.state.custDetail = d;
    Object.assign(m.ctx.state, { statusF: 'paid', channelF: 'web', storeF: '2', orderQ: 'milk', detailId: 'TC1' });
    m.CMD.ordViewCust();
    const st = m.ctx.state;
    is([st.statusF, st.channelF, st.storeF, st.orderQ], ['all', 'all', 'all', ''], 'every other filter goes back to All — "all N" means all');
    is(st.ordCust, { id: 42, name: 'Li <b>' }, 'scoped to the customer, by id');
    is([st.custId, st.custDetail, st.detailId, st.tab, st.stack.length], [null, null, null, 'orders', 0], 'the record closes and Orders opens');
    is(m.calls.loads, 1, 'the list is read');
    is(m.ctx.ordersQuery(0), 'customer_id=42&limit=25&offset=0', 'the read carries customer_id');
    const h = m.ctx.ordersHeader();
    has(h, 'Showing orders for Li &lt;b&gt;', 'a chip says whose orders, escaped');
    has(h, "APP.cmd('ordClearCust')", 'and clears');
    is(m.ctx.ordersFiltered0(), false, 'a scoped list is not the unfiltered one');
    m.CMD.ordClearCust();
    is(m.ctx.state.ordCust, null, 'clearing drops the scope'); is(m.calls.loads, 2, 'and reads again');
    m.ctx.state.ordCust = { id: 42, name: 'Li' }; m.CMD.ordersClear();
    is(m.ctx.state.ordCust, null, 'Clear filters drops it too');
    m.ctx.state.ordCust = { id: 42, name: 'Li' }; m.CMD.ordersGo('paid');
    is(m.ctx.state.ordCust, null, 'and so does a Home worklist row');
    const nn = mk(); nn.ctx.state.custDetail = { customer: { id: 7 } }; nn.CMD.ordViewCust();
    is(nn.ctx.state.ordCust.name, '#7', 'a customer with no name reads as #id, as the desktop does');
    has(mk({ lang: 'zh', state: { ordCust: { id: 1, name: 'Li' } } }).ctx.ordersHeader(), '仅显示以下顾客的订单', 'Chinese chip');
  }

  console.log('\n3 · the CSV');
  {
    const m = mk({ state: { statusF: 'refund', channelF: 'web', storeF: '1', orderQ: 'a&b', ordCust: { id: 42, name: 'Li' } } });
    has(m.ctx.ordersHeader(), "APP.cmd('ordExport')", 'Export is drawn for orders:export');
    m.CMD.ordExport();
    is(m.ctx.location.href, '/api/retail-admin/orders/export.csv?status=refunds_open&channel=web&q=a%26b&store_id=1&customer_id=42',
      'GET /orders/export.csv at exactly the list\'s filters, no paging, customer scope included');
    const all = mk(); all.CMD.ordExport();
    is(all.ctx.location.href, '/api/retail-admin/orders/export.csv', 'the unfiltered list exports everything');
    const no = mk({ caps: ['orders:view'] });
    hasnt(no.ctx.ordersHeader(), 'ordExport', 'not drawn without orders:export (capability-denied)');
    no.CMD.ordExport();
    is(no.ctx.location.href, '', 'and a stale tap downloads nothing');
  }

  console.log('\n4 · saved views');
  {
    const views = [
      { id: 1, name: 'Unpaid web', query: { status: 'pending_payment', channel: 'web' }, shared: false, mine: true },
      { id: 2, name: 'Tianhe refunds', query: { status: 'refunds_open', store_id: '1', q: 'milk' }, shared: true, mine: true },
      { id: 3, name: 'Team invoices', query: { status: 'needs_invoice', store_id: '99' }, shared: true, mine: false, owner_name: 'Ash' },
    ];
    const m = mk({ views });
    m.CMD.ordViewsOpen();
    is(m.calls.gets, ['/views?screen=orders'], 'opening reads GET /views?screen=orders');
    has(m.ctx.sheetOrdViews(), 'Loading…', 'loading state');
    await tick(); await tick();
    let html = m.ctx.sheetOrdViews();
    has(html, 'Unpaid web', 'my view'); has(html, 'Tianhe refunds', 'my shared view');
    has(html, 'Shared with the team', 'the team\'s heading'); has(html, 'shared by Ash', 'who shared it');
    has(html, "APP.cmd('ordViewShare',1,1)", 'a private view of mine offers Share');
    has(html, "APP.cmd('ordViewShare',2,0)", 'a shared one of mine offers to take it back');
    hasnt(html, "ordViewShare',3", 'someone else\'s view offers no Share — the server refuses it');
    hasnt(html, "ordViewDel',3", 'nor Delete');
    has(html, 'Filter the list first', 'Save is not offered over the unfiltered list');
    has(html, 'disabled onclick="APP.cmd(\'ordViewSave\')"', 'and is disabled');
    has(m.ctx.ordersHeader(), 'Views · 3', 'the header counts them');

    m.CMD.ordViewApply(2);
    is([m.ctx.state.statusF, m.ctx.state.channelF, m.ctx.state.storeF, m.ctx.state.orderQ], ['refund', 'all', '1', 'milk'],
      'applying puts the server keys back on the phone\'s chips, from All');
    is(m.ctx.state.ordViews.open, false, 'and closes the sheet');
    is(m.ctx.ordersQuery(0), 'status=refunds_open&q=milk&store_id=1&limit=25&offset=0', 'the list reads exactly the view');
    m.CMD.ordViewApply(3);
    is([m.ctx.state.statusF, m.ctx.state.storeF], ['invoice', 'all'], 'a store that no longer exists falls to All — showing more is the safe direction');

    // Save.
    Object.assign(m.ctx.state, { statusF: 'pending', channelF: 'miniapp', storeF: '2', orderQ: '', ordCust: { id: 5, name: 'X' } });
    m.ctx.state.ordViews.open = true;
    has(m.ctx.sheetOrdViews(), 'Save this view…', 'Save is offered once something narrows the list');
    m.CMD.ordViewSave();
    const a = m.ctx.state.ask;
    has(a.title, 'Name this view', 'it asks for a name');
    is(a.validate({ name: '' }), 'Name is required', 'an empty name is refused on the sheet');
    is(m.calls.writes.length, 0, 'nothing is sent before the name');
    a.run({ name: 'Morning web' });
    is(m.calls.writes[0], { p: '/views', body: { screen: 'orders', name: 'Morning web', query: { status: 'pending_payment', channel: 'wechat', store_id: '2' } }, method: 'POST' },
      'POST /views {screen, name, query} — the server\'s keys, and NOT the customer scope');
    has(m.ctx.sheetOrdViews(), 'Saving…', 'the button says what it is doing');
    await tick(); await tick();
    is(m.calls.toasts, ['View saved'], 'a toast confirms');
    is(m.calls.gets.length, 2, 'and the list is read again');

    // Share / unshare.
    m.CMD.ordViewShare(1, 1);
    is(m.calls.writes[1], { p: '/views/1', body: { shared: true }, method: 'PATCH' }, 'Share is PATCH /views/:id {shared:true}');
    await tick(); await tick();
    m.CMD.ordViewShare(2, 0);
    is(m.calls.writes[2], { p: '/views/2', body: { shared: false }, method: 'PATCH' }, 'and back is {shared:false}');
    await tick(); await tick();
    is(m.calls.toasts.slice(1), ['Shared with the team', 'Yours alone again'], 'each confirmed');

    // Delete, confirmed.
    m.CMD.ordViewDel(2);
    has(m.ctx.state.ask.body, '"Tianhe refunds" is shared — it will go for everyone on the team.', 'deleting a shared view says who loses it');
    is(m.ctx.state.ask.danger, true, 'as a danger confirm');
    is(m.calls.writes.length, 3, 'nothing is sent before the confirm');
    m.ctx.state.ask.run();
    is(m.calls.writes[3], { p: '/views/2', body: {}, method: 'DELETE' }, 'DELETE /views/:id');
    await tick(); await tick();
    m.CMD.ordViewDel(1);
    has(m.ctx.state.ask.body, '"Unpaid web" will be removed. The filters themselves are not affected.', 'a private one says the filters stay');

    // Refusals stay where the operator is looking.
    const f = mk({ views, writeFails: true, state: { statusF: 'paid' } });
    f.CMD.ordViewsOpen(); await tick(); await tick();
    f.CMD.ordViewSave(); f.ctx.state.ask.run({ name: 'x' }); await tick(); await tick();
    has(f.ctx.sheetOrdViews(), 'Could not save the view', 'a refused save says so on the sheet');
    is(f.calls.toasts, [], 'and toasts nothing');
    f.CMD.ordViewShare(1, 1); await tick(); await tick();
    has(f.ctx.sheetOrdViews(), 'Could not change sharing', 'a refused share says so');

    const e = mk({ views: [] }); e.CMD.ordViewsOpen(); await tick(); await tick();
    has(e.ctx.sheetOrdViews(), 'No saved views yet. Filter the list, then save it.', 'none saved: an empty answer looks empty');
    const x = mk({ viewsFail: true }); x.CMD.ordViewsOpen(); await tick(); await tick();
    const xh = x.ctx.sheetOrdViews();
    has(xh, 'Could not load your views.', 'a failed read is not "none saved"');
    has(xh, "APP.cmd('ordViewsRetry')", 'and can be retried');
    const z = mk({ lang: 'zh', views }); z.CMD.ordViewsOpen(); await tick(); await tick();
    const zh = z.ctx.sheetOrdViews();
    for (const w of ['视图', '团队共享', '共享者', '已共享', '请先筛选列表']) has(zh, w, 'Chinese: ' + w);
  }

  console.log('\n5 · two words that stayed in the language they were fetched in');
  {
    const m = mk();
    const r = m.ctx.mapOrderRow({ id: 1, order_no: 'TC1', status: 'paid', total: 50, subtotal: 42, shipping_fee: 8,
      addon_count: 1, needs_invoice: 1, stock_pending: 1, running_late_days: 2 });
    is(r.breakdown.map((b) => b[0]), [['Subtotal', '小计'], ['Shipping', '运费']], 'the total\'s labels are pairs, the live Subtotal · 小计 and Shipping · 运费');
    has(src, '${Array.isArray(l)?T(l[0],l[1]):escAttr(l)}', 'and the sheet says them in the language on screen');
    hasnt(src, '${T(l,l)}', 'the T(l,l) that printed English on a Chinese screen is gone');
    has(src, 'base.breakdown=orderBreakdown(o);', 'the detail read uses the same breakdown builder');
    const pk = m.ctx.mapOrderRow({ id: 2, order_no: 'TC2', status: 'paid', total: 581.6, subtotal: 572, shipping_fee: 0, packing_fee: 9.6 });
    is(pk.breakdown.map((b) => b[0]), [['Subtotal', '小计'], ['Packing', '打包费']], 'a packing fee gets its own row, a zero shipping fee does not');
    is(m.ctx.orderBreakdown({ subtotal: 50, shipping_fee: 8, packing_fee: 2 }).map((b) => b[0][0]), ['Subtotal', 'Shipping', 'Packing'], 'all three rows when all three were charged');
    const notes = r.notes;
    is(m.ctx.ordNoteLabel(notes[0]), 'Items added after paying', 'a note in English…');
    m.ctx.LANG = 'zh';
    is(notes.map((n) => m.ctx.ordNoteLabel(n)), ['下单后加购', '库存待扣', '待开票', '配送逾期 2 天 · 请联系顾客'],
      '…reads Chinese after the switch, without a refetch');
    is(m.ctx.ordNoteLabel({ label: 'plain' }), 'plain', 'a plain-string label still passes through');
    has(src, '${ic(nt.icon,12)}${ordNoteLabel(nt)}</span>', 'the list row says them at render');
  }

  console.log('\n6 · the words are live');
  {
    for (const s of ["cuT('Showing orders for', '仅显示以下顾客的订单')", "cuT('Clear customer filter', '清除顾客筛选')"]) has(DESK_ORD, s, 'desktop: ' + s);
    has(DESK_CU, '查看全部 ${recentOrdersTotal} 笔订单', 'desktop: View all N orders');
    for (const s of ["_viewsT('Views', '视图')", "_viewsT('Could not load your views.', '无法加载视图。')",
      "_viewsT('Shared with the team', '团队共享')", "_viewsT('shared by', '共享者')", "_viewsT('Shared', '已共享')",
      "_viewsT('Share', '共享')", "_viewsT('Save this view…', '保存当前视图…')", "_viewsT('Filter the list first', '请先筛选列表')",
      "_viewsT('No saved views yet. Filter the list, then save it.', '暂无保存的视图。先筛选列表，再保存。')",
      "titleEn: 'Name this view', titleCn: '为视图命名'", "phEn: 'Unpaid at Tianhe', phCn: '天河店未付款'",
      "_viewsT('View saved', '视图已保存')", "_viewsT('Yours alone again', '已改为仅自己可见')",
      "_viewsT('Could not save the view', '保存视图失败')", "_viewsT('Could not change sharing', '修改共享设置失败')",
      "_viewsT('Could not delete the view', '删除视图失败')", "titleEn: 'Delete this view?', titleCn: '删除此视图?'"]) has(DESK_VIEWS, s, 'desktop views: ' + s);
    has(DESK_ORD, "cuT('subtotal','小计')", 'desktop: subtotal · 小计'); has(DESK_ORD, "cuT('shipping','运费')", 'desktop: shipping · 运费');
    for (const s of ["T('Subtotal','小计')", "T('Shipping','运费')", "T('Fapiao','发票')", "T('Delivery needs a call','配送需要跟进')", "T('Export','导出')"]) {
      has(src, s, 'a live phone pair: ' + s);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
