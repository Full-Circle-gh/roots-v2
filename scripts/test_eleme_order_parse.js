// Local test for the Eleme order reader's parse step, plus the void/restock
// classifiers on BOTH channel routes (npm run test:eleme-orders).
//
// Eleme's real order payload has never been captured — the recon
// (ELEME_BROWSER_RECON.md) got the RPC method names and nothing else — so
// lib/eleme-browser.js locates orders STRUCTURALLY and reads fields by candidate
// key rather than by a shape it was told. This test can't prove we guessed Eleme's
// field names; it proves the part that has to hold either way:
//
//   • given an envelope of unknown depth and naming, the finder locates the order
//     rows and their line items;
//   • line items are never mistaken for orders;
//   • an unrecognised field yields null, never a plausible-looking wrong number;
//   • Beijing timestamps land in UTC in all three wire formats;
//   • the money-unit heuristic picks 元 vs 分 the way the comments claim;
//   • the shape digest written to eleme_sync_log carries structure but no
//     customer data.
//
// It drives the real production method (parseOrderPayload / mergeOrderDetail) on a
// browser instance that is never init()'d — the parse path touches no page.
//
// Run: node scripts/test_eleme_order_parse.js

'use strict';

const fs = require('fs');
const path = require('path');
const { ElemeBrowser } = require('../lib/eleme-browser');

const b = new ElemeBrowser('test', '1304930646');
b._log = () => {}; // keep the output to test lines only

let pass = 0, fail = 0;
function ok(label, cond, got) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (got !== undefined ? '   got: ' + JSON.stringify(got) : '')); }
}
function section(t) { console.log('\n' + t); }

// ── A. Flat envelope, Eleme-ish names, epoch-ms times, 元 with decimals ───────
section('A · flat envelope, 元 decimals');
{
  const payload = {
    total: 2,
    orders: [
      {
        orderId: '2000123456789012',
        daySn: 7,
        statusDesc: '配送中',
        consumerTotal: 68.5,
        packageFee: 2,
        createTime: 1787461712272,
        expectArrivalTime: 1787465312272,
        description: '不要辣，谢谢',
        tableware: 1,
        deliveryAddress: '天河区**大厦 3*号',
        privacyPhone: '188****1234_1357',
        items: [
          { name: '素食卷饼', quantity: 2, price: 24.0, totalPrice: 48.0, extCode: 'RT-1001' },
          { name: '南瓜汤', quantity: 1, price: 20.5, totalPrice: 20.5 },
        ],
      },
      {
        orderId: '2000123456789013',
        statusDesc: '已完成',
        consumerTotal: 31,
        createTime: 1787461999000,
        items: [{ name: '燕麦拿铁', quantity: 1, price: 31, totalPrice: 31 }],
      },
    ],
  };
  const orders = b.parseOrderPayload(payload);
  ok('two orders found', orders.length === 2, orders.length);
  const o = orders[0];
  ok('order id', o.elemeOrderId === '2000123456789012', o.elemeOrderId);
  ok('day sequence', o.daySeq === '7', o.daySeq);
  ok('status label kept verbatim', o.statusDesc === '配送中', o.statusDesc);
  ok('total', o.total === 68.5, o.total);
  ok('customer note', o.note === '不要辣，谢谢', o.note);
  ok('cutlery count → boolean', o.needsCutlery === true, o.needsCutlery);
  ok('masked address kept', o.addressMasked === '天河区**大厦 3*号', o.addressMasked);
  ok('masked phone kept', o.phoneMasked === '188****1234_1357', o.phoneMasked);
  ok('two line items', o.items.length === 2, o.items.length);
  ok('line name', o.items[0].name === '素食卷饼', o.items[0].name);
  ok('line qty', o.items[0].qty === 2, o.items[0].qty);
  ok('line unit price (was always 0 before)', o.items[0].unitPrice === 24, o.items[0].unitPrice);
  ok('line total', o.items[0].lineTotal === 48, o.items[0].lineTotal);
  ok('line sku token', o.items[0].sku === 'RT-1001', o.items[0].sku);
  ok('money read as 元', o.moneyDivisor === 1, o.moneyDivisor);
  ok('placedAt is a UTC stamp', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(o.placedAt), o.placedAt);
  ok('eta parsed', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(o.eta), o.eta);
  ok('no booking flag → not a pre-order', o.preOrderAt === null, o.preOrderAt);
}

// ── B. Nested envelope, different names, epoch SECONDS, 分 integers ──────────
section('B · nested envelope, epoch seconds, 分 integers');
{
  const payload = {
    data: {
      page: { pageNo: 1 },
      orderList: {
        records: [{
          id: '3000987654321098',
          baseInfo: { orderStatusDesc: '待接单', orderTime: 1787461712, daySeq: 12 },
          feeInfo: { totalAmount: 6850, packagingFee: 200, merchantIncome: 5900, commission: 950 },
          goodsList: [
            { goodsName: '素食卷饼', num: 2, salePrice: 2400, sumPrice: 4800, skuCode: 'RT-1001' },
            { goodsName: '南瓜汤', num: 1, salePrice: 2050, sumPrice: 2050 },
          ],
        }],
      },
    },
  };
  const orders = b.parseOrderPayload(payload);
  ok('one order found through nesting', orders.length === 1, orders.length);
  const o = orders[0];
  ok('id from a nested envelope', o.elemeOrderId === '3000987654321098', o.elemeOrderId);
  ok('status read through a sub-object', o.statusDesc === '待接单', o.statusDesc);
  ok('money read as 分', o.moneyDivisor === 100, o.moneyDivisor);
  ok('total converted to 元', o.total === 68.5, o.total);
  ok('merchant income converted', o.merchantIncome === 59, o.merchantIncome);
  ok('commission converted', o.commission === 9.5, o.commission);
  ok('two line items', o.items.length === 2, o.items.length);
  ok('line price converted', o.items[0].unitPrice === 24, o.items[0].unitPrice);
  ok('epoch seconds == the same epoch ms', o.placedAt === b._normalizeOrder({ orderId: 'x'.repeat(8), statusDesc: 's', createTime: 1787461712000 }).placedAt, o.placedAt);
}

// ── C. A line item must never be read as an order ────────────────────────────
section('C · line items are not orders');
{
  ok('short id rejected', b.parseOrderPayload({ items: [{ name: 'x', quantity: 1, price: 5, id: 12 }] }).length === 0);
  const trap = { list: [{ id: '999999999999', name: 'x', quantity: 1 }] };
  ok('item-shaped row with a long id is skipped', b.parseOrderPayload(trap).length === 0);
}

// ── D. Unrecognised names degrade to null, never to a wrong value ────────────
section('D · unknown field names degrade to null');
{
  const orders = b.parseOrderPayload({ rows: [{ orderId: '4000111122223333', statusDesc: '配送中', zzzTotalThing: 99 }] });
  ok('order still found', orders.length === 1, orders.length);
  const o = orders[0];
  ok('unknown total → 0, not 99', o.total === 0, o.total);
  ok('no items → empty array', o.items.length === 0, o.items.length);
  ok('missing note → null', o.note === null, o.note);
  ok('missing eta → null', o.eta === null, o.eta);
}

// ── E. Timezone: Eleme date strings are Beijing, we store UTC ────────────────
section('E · Beijing date string → UTC');
{
  const at = (v) => b._normalizeOrder({ orderId: '5000111122223333', statusDesc: 's', createTime: v }).placedAt;
  ok('12:00 Beijing → 04:00 UTC', at('2026-08-24 12:00:00') === '2026-08-24 04:00:00', at('2026-08-24 12:00:00'));
  ok('03:00 Beijing rolls back a day', at('2026-08-24 03:00:00') === '2026-08-23 19:00:00', at('2026-08-24 03:00:00'));
  ok('garbage → null', at('not a date') === null, at('not a date'));
  ok('zero → null', at(0) === null, at(0));
}

// ── F. Pre-order only when Eleme says so ────────────────────────────────────
section('F · 预订单 needs an explicit flag');
{
  const booked = b._normalizeOrder({
    orderId: '6000111122223333', statusDesc: '待接单', isBooking: true,
    bookedTime: '2026-08-24 18:30:00', expectArrivalTime: '2026-08-24 18:30:00',
  });
  ok('booking flag → preOrderAt set', booked.preOrderAt === '2026-08-24 10:30:00', booked.preOrderAt);
  const normal = b._normalizeOrder({
    orderId: '6000111122223334', statusDesc: '待接单', expectArrivalTime: '2026-08-24 18:30:00',
  });
  ok('an ETA alone is not a pre-order', normal.preOrderAt === null, normal.preOrderAt);
}

// ── G. Tier 1 detail merges without clobbering the list ─────────────────────
section('G · detail fills blanks, never overwrites');
{
  const order = b._normalizeOrder({
    orderId: '7000111122223333', statusDesc: '配送中', consumerTotal: 68.5,
    items: [{ name: '素食卷饼', quantity: 2, price: 24, totalPrice: 48 }],
  });
  ok('list gave no merchant income', order.merchantIncome === null, order.merchantIncome);
  b.mergeOrderDetail(order, {
    merchantIncome: 59.0, commission: 9.5, platformSubsidy: 3,
    consumerTotal: 999, // detail must NOT be allowed to rewrite this
    commodities: [
      { name: '素食卷饼', quantity: 2, price: 24, totalPrice: 48, extCode: 'RT-1001' },
      { name: '赠品 环保袋', quantity: 1, price: 0, totalPrice: 0 },
    ],
  });
  ok('merchant income filled from detail', order.merchantIncome === 59, order.merchantIncome);
  ok('commission filled', order.commission === 9.5, order.commission);
  ok('platform subsidy filled', order.platformSubsidy === 3, order.platformSubsidy);
  ok('list total NOT overwritten by detail', order.total === 68.5, order.total);
  ok('sku backfilled onto the existing line', order.items[0].sku === 'RT-1001', order.items[0].sku);
  ok('detail-only line appended (would have under-deducted)', order.items.length === 2, order.items.length);
  ok('appended line keeps its qty', order.items[1].qty === 1, order.items[1].qty);
  ok('raw detail archived', !!order.rawDetail);
}

// ── H. The shape digest is safe to write to the sync log ────────────────────
section('H · shape digest carries structure, not values');
{
  const fresh = new ElemeBrowser('test2', '1');
  fresh._log = () => {};
  fresh._noteOrderShape('list', {
    orders: [{ orderId: '2000123456789012', description: '不要辣，谢谢', privacyPhone: '188****1234', deliveryAddress: '天河区**大厦' }],
  });
  const dig = fresh.orderShapes.list;
  ok('digest produced', typeof dig === 'string' && dig.length > 0);
  ok('key names present', dig.includes('orderId') && dig.includes('description'), dig);
  ok('customer note not leaked', !dig.includes('不要辣'));
  ok('phone not leaked', !dig.includes('188'));
  ok('address not leaked', !dig.includes('天河'));
  fresh._noteOrderShape('list', { somethingElse: 1 });
  ok('only the FIRST payload is recorded', fresh.orderShapes.list === dig);
}


// ── I. Void classification — the guards that decide whether stock moves ──────
// These two live in routes/eleme-internal.js, which can't be require()'d here: it
// pulls in database.js and better-sqlite3 has no Windows build (see
// project_runtime_env). So the functions are lifted out of the real source file by
// name and evaluated — the shipped text, not a copy that could drift from it.
section('I · void classification (routes/eleme-internal.js)');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eleme-internal.js'), 'utf8');
  const lift = (name) => {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('could not find ' + name + ' in routes/eleme-internal.js');
    let depth = 0, i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('unbalanced braces reading ' + name);
    // eslint-disable-next-line no-new-func
    return new Function('return function ' + name + '(desc) ' + src.slice(open, i + 1))();
  };
  const isConfirmedVoid = lift('isConfirmedVoid');
  const statusOf = lift('internalStatusForChannel');

  // A refund or cancel REQUEST must NOT return stock — the merchant or platform
  // may still reject it and the order then goes on to be delivered. Restocking on
  // the request double-counts the inventory.
  for (const pending of ['退款申请', '申请退款', '退款中', '退货中', '商家审核中', '协商中', '待处理', '部分退款']) {
    ok(`pending "${pending}" does NOT restock`, isConfirmedVoid(pending) === false, isConfirmedVoid(pending));
  }
  // Settled voids DO return stock.
  for (const settled of ['已取消', '订单取消', '交易取消', '已关闭', '交易关闭', '已退款', '退款成功', '退款完成', '全额退款']) {
    ok(`settled "${settled}" restocks`, isConfirmedVoid(settled) === true, isConfirmedVoid(settled));
  }
  // Live orders are never voids.
  for (const live of ['配送中', '待接单', '已送达', '骑手已取餐', '']) {
    ok(`live "${live || '(empty)'}" is not a void`, isConfirmedVoid(live) === false, isConfirmedVoid(live));
  }

  // Status vocabulary, including the ordering that differs from the Meituan twin.
  ok('已退款 → refunded', statusOf('已退款') === 'refunded', statusOf('已退款'));
  ok('已取消 → cancelled', statusOf('已取消') === 'cancelled', statusOf('已取消'));
  ok('已送达 → delivered', statusOf('已送达') === 'delivered', statusOf('已送达'));
  ok('待接单 → preparing', statusOf('待接单') === 'preparing', statusOf('待接单'));
  ok('商家已接单 → preparing', statusOf('商家已接单') === 'preparing', statusOf('商家已接单'));
  ok('骑手已接单 → rider_pickup (NOT preparing)', statusOf('骑手已接单') === 'rider_pickup', statusOf('骑手已接单'));
  ok('待骑手取餐 → rider_pickup', statusOf('待骑手取餐') === 'rider_pickup', statusOf('待骑手取餐'));
  ok('骑手已取餐 → dispatched (rider HAS it)', statusOf('骑手已取餐') === 'dispatched', statusOf('骑手已取餐'));
  ok('配送中 → dispatched', statusOf('配送中') === 'dispatched', statusOf('配送中'));
  ok('待支付 → null (stays paid)', statusOf('待支付') === null, statusOf('待支付'));
  ok('empty → null', statusOf('') === null, statusOf(''));

  // Every settled void must also classify as a terminal status, or the order would
  // return its stock while still sitting in an active Orders tab.
  for (const settled of ['已取消', '已退款', '交易关闭']) {
    const st = statusOf(settled);
    ok(`"${settled}" is terminal (${st})`, st === 'cancelled' || st === 'refunded', st);
  }
}


// ── J. The two channels must agree on what returns stock ────────────────────
// Eleme's void classifier is a deliberate COPY of Meituan's, not a shared import
// (the two platforms word their statuses differently, and a shared list would make
// one channel's wording fix a risk to the other). Copies drift. These assertions
// pin the cases where drift would cost real money — a label that restocks on one
// channel and not the other means one of them is wrong.
section('J · Meituan and Eleme agree on what restocks');
{
  const liftFrom = (relPath, name) => {
    const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('could not find ' + name + ' in ' + relPath);
    let depth = 0, i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('unbalanced braces reading ' + name + ' in ' + relPath);
    // eslint-disable-next-line no-new-func
    return new Function('return function ' + name + '(desc) ' + src.slice(open, i + 1))();
  };
  const mtVoid = liftFrom('routes/meituan-internal.js', 'isConfirmedVoid');
  const elVoid = liftFrom('routes/eleme-internal.js', 'isConfirmedVoid');

  // Shared wording — both platforms use these, and both must answer the same.
  const shared = [
    ['退款申请', false], ['申请退款', false], ['退款中', false], ['退货中', false],
    ['协商中', false], ['部分退款', false],
    ['已取消', true], ['订单取消', true], ['交易取消', true], ['已关闭', true],
    ['交易关闭', true], ['已退款', true], ['退款成功', true], ['退款完成', true],
    ['全额退款', true],
    ['配送中', false], ['已送达', false], ['', false],
  ];
  for (const [label, want] of shared) {
    const m = mtVoid(label), e = elVoid(label);
    ok(`"${label || '(empty)'}" → ${want} on both`, m === want && e === want, { meituan: m, eleme: e });
  }

  // Both must have a born-void guard: an order first seen cancelled must not be
  // deducted, because the restock only fires on a transition that never comes.
  for (const rel of ['routes/meituan-internal.js', 'routes/eleme-internal.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    ok(`${rel} has the born-void guard`, /const bornVoid = /.test(src) && /bornVoid \? \[\] : items/.test(src));
    ok(`${rel} marks born-void stock as not-deducted`,
      /if \(bornVoid\) db\.prepare\('UPDATE retail_orders SET channel_stock_restored = 1/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
