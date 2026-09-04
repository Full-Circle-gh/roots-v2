/* global fetch, document */
// Playwright browser automation for the Eleme (饿了么) Napos merchant backend.
//
// Twin of lib/meituan-browser.js — same session-persist / anti-fingerprint / proxy
// machinery — but the merchant UI is cross-origin FaaS micro-frontends calling one
// JSON-RPC gateway (app-api.shop.ele.me, the "ncp" envelope) instead of Meituan's
// per-feature REST APIs. Eleme's official OpenAPI rejects our single-store
// accounts ("暂不支持该账户登录" — see ELEME_BROWSER_RECON.md), so this replaces
// lib/eleme-client.js (OAuth, now dead) the same way meituan-browser.js replaced
// nothing — it was always the only option for 外卖.
//
// The RPC contract here is reverse-engineered from a single live network capture
// (2026-08-23, shop 1304930646) — see ELEME_BROWSER_RECON.md for the raw capture
// and the parts of the contract that are still guesses (marked below). STOCK push
// (FoodService2.updateFoodStock) is the one call captured payload-and-response, so
// it's the one this file trusts fully; everything upstream of it (category/food
// listing) is shape-agnostic on purpose, so an unguessed field name degrades to
// "found nothing" instead of a crash.
//
// Orders (Tier 0 + Tier 1 collection) ARE wired, but defensively: the recon
// captured the order RPC method NAMES and nothing else, so the order path reads
// what the merchant page itself fetches wherever it can (observe), replays the
// page's own captured request body when it can't (replay), and only falls back to
// a bounded one-per-session probe of candidate request shapes as a last resort.
// Response parsing is structural for the same reason. See the Orders block below.

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const { browserEnv } = require('./browser-env');
// The Tier-2 anti-fingerprint init script is a generic "coherent Windows Chrome"
// spoof with nothing Meituan-specific in it — reuse it rather than duplicate
// ~140 lines of navigator/WebGL/plugin shimming.
const { fingerprintInitScript } = require('./meituan-browser');

const SESSION_DIR  = path.join(__dirname, '../data/eleme-sessions');
const MERCHANT_URL = 'https://melody.shop.ele.me';
const GOODS_URL    = 'https://napos-goods-pc.faas.ele.me/single/goods-manage';
// The orders micro-frontend's own origin. Kept for RECOGNISING its frame — NOT
// for navigating to: opened as a top-level tab it answers UNAUTHORIZED 未登录 to
// every order RPC, including the ones the page fires for itself (confirmed live
// 2026-08-24). Only the copy embedded in the melody shell is authenticated.
const ORDERS_APP_HOST = 'napos-order-pc.faas.ele.me';
// Where the shell mounts it. Overridable without a code change if the SPA moves.
const ORDER_SHELL_ROUTE = process.env.ELEME_ORDER_ROUTE || 'order';
const API_HOST     = 'app-api.shop.ele.me';

// Every order RPC lives under this gateway prefix; the path repeats the method
// name (contrast goods, which uses a fixed 'invoke' segment) — recon capture.
const ORDER_PATH_PREFIX = 'fulfill/weborder';
// The in-process list method the recon confirmed by name. Overridable without a
// code change once a live order shows what the current UI actually calls.
const ORDER_LIST_METHOD = process.env.ELEME_ORDER_LIST_METHOD || 'queryInProcessOrders';
// Which observed call counts as "the order list", MOST SPECIFIC FIRST. Priority
// is the point: a single loose regex plus Map iteration order is exactly how
// PollingService.nonCoreOrders — a summary/notice feed carrying only tab counts —
// came to be read as the order list (live, 2026-08-24). nonCoreOrders is now
// excluded outright; unprocessedOrders stays as a last resort because it answers
// a NARROWER question (unprocessed only), so it must never outrank the real list.
const ORDER_LIST_RES = [
  /queryInProcessOrders/i,
  /queryOrderList|orderList/i,
  /unprocessedOrders/i,
];
const ORDER_DETAIL_RE   = /orderdetail|querydetail|commodit/i;
// The refund / exception queue, most specific first for the same reason. A
// cancelled or refunded order LEAVES the in-process list — it just stops being
// mentioned, which is indistinguishable from completion — so this is the only way
// a void reaches the restock. queryExceptionInfo is LAST: it answers with counts
// (exceptionalOrderCount / refundOrderCount / …), not with order rows, so it is a
// health signal rather than a source of orders.
const ORDER_VOID_RES = [
  /abnormalOrders/i,
  /refundOrders|cancelOrders/i,
  /queryExceptionInfo/i,
];
const DETAIL_METHOD_ENV = process.env.ELEME_ORDER_DETAIL_METHOD || '';
// Re-navigate the orders tab at most this often — between navigations we read
// whatever the SPA's own polling produces, which costs us no requests at all.
const ORDER_PAGE_STALE_MS = 10 * 60000;
// How long to wait for the page's own list call after a navigation before
// falling back to replaying it ourselves.
const ORDER_OBSERVE_MS = 12000;
// The "in progress" tab identifier queryInProcessOrders demands when the captured
// request carried a null one. 'ALL' matches the filter vocabulary the goods side
// uses; override without a code change if the live error says otherwise.
const ORDER_INPROCESS_TAB = process.env.ELEME_ORDER_TAB || 'ALL';
// How old an observed response may be and still count as "the current order
// list". Without a ceiling, a page that stopped polling would have its last
// snapshot re-read as fresh on every poll forever — new orders would simply
// never appear, silently, with no error anywhere. Past this age the reader falls
// through to replaying the call itself, which costs one request and is correct.
const ORDER_RESULT_MAX_AGE_MS = 120000;
// The "guess a request shape" rung is the ONLY thing in the order path that can
// emit a request a real merchant session never makes, so it is OFF by default.
// Observe + replay need no guessing: the merchant page fetches its own order list
// on load, and that is what the daemon reads. Turn this on only to bootstrap a
// shop whose page never fired the call we were watching for.
const ORDER_PROBE_ENABLED = process.env.ELEME_ORDER_PROBE === '1';

let playwright;
function getPlaywright() {
  if (!playwright) playwright = require('playwright');
  return playwright;
}

// Proxy resolution — same shape as meituan-browser's resolveProxy, namespaced
// ELEME_*, but it defaults to the SAME active-proxy decision the store's Meituan
// channel already elected (proxy-manager's state file is keyed by storeCode) so
// every channel for a given store rides one coherent exit IP — the anti-
// fingerprint story the recon build plan calls for ("same residential-proxy +
// fingerprint treatment as Meituan Tianhe").
function activeProxyRaw(storeCode) {
  try {
    const active = require('./proxy-manager').readActive(storeCode);
    if (active !== undefined) return active; // '' is a valid value (direct)
  } catch (_) { /* manager optional — fall through to env */ }
  return (storeCode && process.env[`ELEME_PROXY_${String(storeCode).toUpperCase()}`])
    || process.env.ELEME_PROXY_URL || '';
}

function resolveProxy(storeCode) {
  const raw = activeProxyRaw(storeCode);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const proxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch (e) {
    console.error(`[eleme] ignoring malformed proxy URL: ${e.message}`);
    return null;
  }
}

// ── Order payload helpers (pure, shape-agnostic) ─────────────────────────────
//
// The recon (ELEME_BROWSER_RECON.md) captured the order RPC method NAMES but no
// payloads — no live order existed during the capture. So nothing below hardcodes
// a field name it hasn't seen: orders are located structurally and read by
// candidate key, the same defensive technique _skusFromFood uses for the goods
// response, and for the same reason — an unguessed name degrades to "missing"
// instead of crashing or, worse, silently reading the wrong field.

const ORDER_ID_KEYS    = ['orderId', 'orderIdStr', 'eleOrderId', 'orderNo', 'tradeNo', 'id'];
const DAY_SEQ_KEYS     = ['daySn', 'dayId', 'daySeq', 'orderIndex', 'serialNumber', 'index', 'seq'];
const TOTAL_KEYS       = ['consumerTotal', 'totalPrice', 'orderAmount', 'totalAmount', 'payAmount', 'userFee', 'total'];
// ── The real payload, finally seen ──────────────────────────────────────────
// The header above says Eleme's order payload was never captured and that every
// field here is read by candidate key rather than by a shape we were told. Two
// live orders have now been read out of eleme_order_import (see
// scripts/diagnose_eleme_payload_shape.js), and they settle the one field that
// was reading wrong.
//
// EL20260901417897 carried:
//   settlementInfo.customerPaidInfo.total        269      what the customer paid
//   printDataInfo.payAmount                      269      the same figure
//   settlementInfo.subTotalFeeInfo.total         269      and again
//   settlementInfo.orderTotalPrice               268.5    goods + packaging
//   foodInfo.groups[].items[].total              38 …     the lines (267 in all)
//   foodInfo.deliveryFee                         18
//   foodInfo.packageFee                          1.5
//   settlementInfo.expectedIncomeInfo.total      240.49   merchant income
//   settlementInfo.platformServiceFeeInfo.total  28.51    commission
//   settlementInfo.merchantActivityInfo.total    17.5     SHOP-FUNDED PROMOTION
//
// We recorded 17.50 as the order total. The last line is why: TOTAL_KEYS ends
// in the bare 'total', pick() walks the sub-objects in key order trying EVERY
// candidate at each one, and merchantActivityInfo is reached before
// customerPaidInfo. Position beat priority, so a discount was read as the bill
// while 'payAmount' sat one sub-object away holding the right answer.
//
// Named paths first, then a priority-first search. Both are needed: the paths
// are what we have actually seen, and the search is what still works when Eleme
// renames one.
const TOTAL_PATHS = [
  'settlementInfo.customerPaidInfo.total',
  'printDataInfo.payAmount',
  'settlementInfo.subTotalFeeInfo.total',
];
// Sub-trees that hold money which is definitively NOT the order total — a
// promotion, the platform's cut, our own income, a per-party subsidy split. The
// bug was reading one of these; excluding them by name means the fallback search
// cannot repeat it under a different key.
const NOT_TOTAL_PATH = /(merchantActivity|platformServiceFee|expectedIncome|activities|allowance|orderAllParties|subsidy|serviceFee|commission|deliveryFee|packageFee|refund)/i;
const INCOME_KEYS      = ['merchantIncome', 'shopIncome', 'settleAmount', 'actualIncome', 'merchantAmount', 'income'];
const COMMISSION_KEYS  = ['commission', 'serviceFee', 'platformFee', 'commissionFee'];
const SUBSIDY_KEYS     = ['platformSubsidy', 'elemeSubsidy', 'platformDiscount', 'subsidyAmount'];
const SHOP_DISC_KEYS   = ['shopDiscount', 'merchantDiscount', 'shopSubsidy', 'merchantSubsidy', 'activityAmount'];
const PACK_FEE_KEYS    = ['packageFee', 'packagingFee', 'packFee', 'lunchBoxFee', 'boxFee'];
const DELIVER_FEE_KEYS = ['deliveryFee', 'shippingFee', 'sendFee', 'deliverFee'];
// The same capture, for the columns beside the total. Each is tried before its
// guessed key list, and each is a path this payload actually carried — the
// commission and income columns were landing NULL on every order because none of
// the guessed names appears anywhere in it.
const INCOME_PATHS     = ['settlementInfo.expectedIncomeInfo.total'];
const COMMISSION_PATHS = ['settlementInfo.platformServiceFeeInfo.total'];
const SHOP_DISC_PATHS  = ['settlementInfo.merchantActivityInfo.total'];
const PACK_FEE_PATHS   = ['foodInfo.packageFee'];
const DELIVER_FEE_PATHS = ['foodInfo.deliveryFee', 'printDataInfo.deliveryFeeTotal'];
const STATUS_KEYS      = ['statusDesc', 'orderStatusDesc', 'statusText', 'statusName', 'statusDescription', 'status'];
// WHERE THE LIFECYCLE STAGE ACTUALLY LIVES. Named paths first, then the key
// search — the same two-step the money fields above were given, for the same
// reason: position beat priority here too, and the field that won was not a
// stage at all.
//
// None of the five *Desc names in STATUS_KEYS appears anywhere in Eleme's real
// order payload, so pick() fell through to the bare 'status' — which holds
// "VALID", an order-VALIDITY flag, on 100% of live orders (3/3, measured by
// scripts/diagnose_eleme_courier_status.js and confirmed by
// diagnose_eleme_status_survey.js). routes/eleme-internal.js maps "VALID" to
// nothing and falls back to 'paid', and every later poll writes the same "VALID"
// back, so an Eleme order stayed on **Paid** for its whole life however far
// Eleme itself had taken it. That is the bug this fixes.
//
// The three paths are the ones that same capture found carrying a real per-order
// stage (its question 2). Ordered most-specific first: the order's own latest
// status, then the label Eleme prints on the ticket, then the delivery trace.
const STATUS_PATHS = [
  'header.orderLatestStatus',
  'printDataInfo.statusForPrint',
  'deliveryInfo.distTraceView.traceView.status',
];
// A value that cannot be a lifecycle stage, whatever key it arrives under: the
// VALID/INVALID validity flag, a placeholder, or a bare numeric code (which no
// mapper here can read, and which would sit in channel_status looking like a
// stage). Stepped over so the search continues to a field that IS one.
//
// INVALID is refused as firmly as VALID, and deliberately: reading it as a
// cancel would skip the stock deduction at ingest (`bornVoid`) on an order that
// may be perfectly live. A flag we cannot interpret must produce no claim.
const NOT_A_STAGE = /^(valid|invalid|normal|none|null|unknown|default|true|false|-?\d+(\.\d+)?)$/i;
const ETA_KEYS         = ['expectArrivalTime', 'estimateArrivalTime', 'expectedDeliveryTime', 'promiseDeliveryTime', 'deliveryTime', 'expectTime'];
const PLACED_KEYS      = ['createdAt', 'createTime', 'orderTime', 'activeTime', 'gmtCreate', 'placeTime'];
const BOOK_FLAG_KEYS   = ['isBooking', 'bookingOrder', 'isPreOrder', 'preOrder', 'booked'];
const BOOK_TIME_KEYS   = ['bookedTime', 'deliverStartTime', 'expectStartTime', 'reserveTime'];
const NOTE_KEYS        = ['description', 'remark', 'userRemark', 'memo', 'note', 'comment', 'userNote'];
const CUTLERY_KEYS     = ['tableware', 'tablewareNum', 'cutlery', 'cutleryNum', 'chopsticks'];
const REFUND_KEYS      = ['refundStatus', 'refundStatusDesc', 'refundType', 'refundDesc'];
const ADDRESS_KEYS     = ['address', 'deliveryAddress', 'userAddress', 'receiverAddress', 'addressDesc'];
const PHONE_KEYS       = ['phone', 'privacyPhone', 'userPhone', 'consigneePhone', 'receiverPhone', 'mobile'];
const ITEM_NAME_KEYS   = ['name', 'foodName', 'goodsName', 'skuName', 'itemName', 'title'];
const ITEM_QTY_KEYS    = ['quantity', 'qty', 'num', 'count', 'number'];
const ITEM_PRICE_KEYS  = ['price', 'unitPrice', 'salePrice', 'actualPrice', 'originPrice'];
const ITEM_TOTAL_KEYS  = ['totalPrice', 'sumPrice', 'lineTotal', 'itemAmount'];
const ITEM_SKU_KEYS    = ['extCode', 'skuCode', 'customSkuId', 'barCode', 'upc', 'shopSkuId'];
const ITEM_SPEC_KEYS   = ['specName', 'spec', 'attribute', 'specDesc'];

// First present value among `names`, on the object itself and then one level into
// its nested plain objects — Eleme's envelopes wrap the interesting fields in
// sub-objects (baseInfo / orderInfo / …) exactly as Meituan's do.
function pick(obj, names, depth = 2) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  if (depth <= 0) return undefined;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = pick(v, names, depth - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

// pick(), but it also says WHERE the value came from: { value, path }. Same walk,
// same order, same result — the path is the only addition.
//
// It exists because of EL20260901417897, an order whose banner read ¥17.50 over
// ¥267.00 of line items. The number itself gave no way to tell which of the seven
// TOTAL_KEYS produced it, or whether it came off the order or out of some nested
// sub-record, so the one question that would have settled it — "which field is
// this?" — could not be answered from anything we had stored. Now the ingest logs
// the path beside the figure, and the next disagreement names its own cause.
function pickPath(obj, names, depth = 2, base = '') {
  if (!obj || typeof obj !== 'object') return { value: undefined, path: null };
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') return { value: v, path: base ? base + '.' + n : n };
  }
  if (depth <= 0) return { value: undefined, path: null };
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = pickPath(v, names, depth - 1, base ? base + '.' + k : k);
      if (hit.value !== undefined) return hit;
    }
  }
  return { value: undefined, path: null };
}

// Read one exact dotted path, or undefined. No searching, no guessing — this is
// how a field we have actually SEEN gets read.
function atPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return (cur === null || cur === '') ? undefined : cur;
}

// PRIORITY-FIRST search: every candidate name is looked for across the WHOLE
// object before the next name is tried at all.
//
// pick() does the opposite — it walks the objects and tries every name at each
// one — so a low-priority name on an early sub-object beats a high-priority name
// on a later one. That is not a hypothetical: it is how
// settlementInfo.merchantActivityInfo.total (a shop-funded promotion, ¥17.50)
// was read as EL20260901417897's order total while printDataInfo.payAmount held
// ¥269. Breadth-first within each name, so a shallower hit beats a deeper one.
//
// `exclude` drops whole sub-trees by path — the fee, promotion and settlement
// branches that hold money which is definitively not the figure being read.
//
// `accept` is the same idea one level down, on the VALUE rather than the path: a
// hit that fails it is stepped over and the search carries on. The status reader
// needs it — its highest-priority candidate name ('status') is also the one that
// holds an order-validity flag — and money never passes one, so every existing
// caller behaves exactly as before.
function pickByPriority(obj, names, exclude, maxDepth = 4, accept = null) {
  for (const name of names) {
    let level = [{ node: obj, path: '' }];
    for (let d = 0; d <= maxDepth && level.length; d++) {
      const next = [];
      for (const { node, path } of level) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        const v = node[name];
        const hitPath = path ? path + '.' + name : name;
        if (v !== undefined && v !== null && v !== '' && typeof v !== 'object'
            && !(exclude && exclude.test(hitPath))
            && !(accept && !accept(v))) {
          return { value: v, path: hitPath };
        }
        for (const [k, child] of Object.entries(node)) {
          if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
          const childPath = path ? path + '.' + k : k;
          if (exclude && exclude.test(childPath)) continue;
          next.push({ node: child, path: childPath });
        }
      }
      level = next;
    }
  }
  return { value: undefined, path: null };
}

// One order-level money field: the paths we have SEEN, in order, then a
// priority-first search over the candidate names, then nothing. Returns the
// value with the path it came from, so every figure this reader produces can say
// where it came from.
function pickMoney(obj, paths, names, exclude) {
  for (const path of paths || []) {
    const v = atPath(obj, path);
    if (v !== undefined && typeof v !== 'object') return { value: v, path };
  }
  return pickByPriority(obj, names, exclude);
}

// The order's LIFECYCLE STAGE: the paths we have seen carrying one, then a
// priority-first search over the candidate names — and at every step a value
// that is not a stage is stepped over rather than accepted, so the search cannot
// stop on the validity flag that produced the always-Paid bug.
//
// Returns { value, path, isStage }. `isStage` false is the honest last resort:
// no field in this payload named a stage, so the platform's own word for the
// order is carried through unmapped (channel_status still shows it, the internal
// status still refuses to move on it) rather than the order arriving with no
// status at all — which would silence the daemon's whole refresh, backfills and
// void detection included, since it skips an order with no label.
function pickStage(obj) {
  const isStage = (v) => typeof v !== 'object' && !NOT_A_STAGE.test(String(v).trim());
  for (const path of STATUS_PATHS) {
    const v = atPath(obj, path);
    if (v !== undefined && isStage(v)) return { value: String(v).trim(), path, isStage: true };
  }
  const hit = pickByPriority(obj, STATUS_KEYS, null, 4, isStage);
  if (hit.value !== undefined) return { value: String(hit.value).trim(), path: hit.path, isStage: true };
  const flag = pickPath(obj, STATUS_KEYS);
  if (flag.value === undefined) return { value: null, path: null, isStage: false };
  return { value: String(flag.value).trim() || null, path: flag.path, isStage: false };
}

// The OUTERMOST array under `root` whose members satisfy `isMember`, largest
// first among arrays at the same nesting tier. Used to find the order list
// inside an unknown envelope, and the line items inside an unknown order — same
// walk, different predicate.
//
// Outermost, not simply largest: an order's line items live INSIDE an order row,
// so a single order carrying three items nests a 3-array inside a 1-array. Taking
// the larger one read each line item as its own order — one Eleme order with
// three products arrived as three ¥-per-product orders with no items — which is
// why a candidate found inside another candidate's member is never preferred over
// the one containing it. Depth is the tier: a nested candidate is always deeper
// than the array whose member holds it, so keeping the shallowest is the same
// rule stated as a number.
function findArray(root, isMember, maxDepth = 6) {
  let best = null, bestDepth = Infinity;
  const walk = (node, d) => {
    if (!node || typeof node !== 'object' || d > maxDepth) return;
    if (Array.isArray(node)) {
      if (node.length && node.every(x => x && typeof x === 'object') && node.some(isMember)) {
        if (d < bestDepth || (d === bestDepth && node.length > best.length)) {
          best = node; bestDepth = d;
        }
      }
      for (const x of node) walk(x, d + 1);
      return;
    }
    for (const v of Object.values(node)) walk(v, d + 1);
  };
  walk(root, 0);
  return best || [];
}

function looksLikeItem(x) {
  return !!x && typeof x === 'object'
    && pick(x, ITEM_NAME_KEYS, 1) !== undefined
    && pick(x, ITEM_QTY_KEYS, 1) !== undefined;
}

// Fields a LINE ITEM never carries: they describe the trip, the customer or the
// settlement, none of which belong to a single food. Packaging fee is left out on
// purpose — Eleme prices 打包费 per food as well as per order — and so are the
// refund and sequence keys, whose candidate names ('index', 'seq', 'refundType')
// are generic enough to sit on an item row.
const ORDER_ONLY_KEYS = [].concat(
  PLACED_KEYS, ETA_KEYS, BOOK_TIME_KEYS, BOOK_FLAG_KEYS,
  ADDRESS_KEYS, PHONE_KEYS, CUTLERY_KEYS, INCOME_KEYS, DELIVER_FEE_KEYS,
);

// A line item, read on its OWN keys: its own name and its own quantity, and none
// of the order-only fields above. Deliberately not `looksLikeItem`, which reaches
// one level into sub-objects and would call an order with a nested `user.name`
// and `page.num` a line item.
function looksLikeItemRow(x) {
  if (!x || typeof x !== 'object') return false;
  if (!ITEM_NAME_KEYS.some(k => x[k] != null && x[k] !== '')) return false;
  if (!ITEM_QTY_KEYS.some(k => x[k] != null && x[k] !== '')) return false;
  return !ORDER_ONLY_KEYS.some(k => x[k] != null && x[k] !== '');
}

// An order, not a line item: a TOP-LEVEL id of real length (a nested id doesn't
// count — a line item's own id would false-positive) plus at least one of the
// things only an order carries.
function looksLikeOrder(o) {
  if (!o || typeof o !== 'object') return false;
  if (!ORDER_ID_KEYS.some(k => o[k] != null && String(o[k]).length >= 6)) return false;
  const hasItems = Object.values(o).some(v => Array.isArray(v) && v.some(looksLikeItem));
  // An id, a name, a quantity, a price and a total: a line item has all five, so
  // "has an id and a total" cannot be what makes a row an order. TOTAL_KEYS and
  // ITEM_TOTAL_KEYS even share 'totalPrice'. What a line item never has is line
  // items of its own — so for an item-shaped row that is the only thing that
  // promotes it, and a food id beside a per-food 总价 stays a food.
  if (looksLikeItemRow(o)) return hasItems;
  if (pick(o, STATUS_KEYS) !== undefined) return true;
  if (pick(o, TOTAL_KEYS) !== undefined) return true;
  return hasItems;
}

// Timestamps arrive as epoch-ms, epoch-seconds, or a 'YYYY-MM-DD HH:mm:ss' string
// in BEIJING time. Everything downstream stores UTC 'YYYY-MM-DD HH:MM:SS' (same as
// meituan-browser), so normalise all three here. A bare date string handed to
// `new Date()` is read in the SERVER's timezone — UTC on the box — and would land
// 8 hours early, so the offset is applied explicitly rather than inherited.
function toUtcStamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    let n = Number(v);
    if (!n) return null;
    if (n < 1e11) n *= 1000;   // epoch seconds → ms
    if (n < 1e12) return null; // still not a plausible timestamp
    return new Date(n).toISOString().slice(0, 19).replace('T', ' ');
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v).trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Eleme's wire money unit was never captured — the stock write echoes prices
// straight back (`price: 92`) without ever interpreting one, so the repo holds no
// evidence either way. 'auto' reads values as 分 only when every money figure on
// the order is a whole number AND the largest is implausible for 元; a real 外卖
// basket over ¥600 is rarer than a fen-denominated payload. Set
// ELEME_MONEY_SCALE=yuan|fen once a live order settles it. Either way the raw
// values are preserved in eleme_order_import.detail_json, so a wrong guess is
// recoverable from stored data instead of needing the order re-read.
const MONEY_SCALE = String(process.env.ELEME_MONEY_SCALE || 'auto').toLowerCase();
const FEN_TOTAL_THRESHOLD = Number(process.env.ELEME_FEN_THRESHOLD || 600);

function decideMoneyDivisor(values) {
  if (MONEY_SCALE === 'fen') return { divisor: 100, why: 'ELEME_MONEY_SCALE=fen' };
  if (MONEY_SCALE === 'yuan') return { divisor: 1, why: 'ELEME_MONEY_SCALE=yuan' };
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v !== 0);
  if (!nums.length) return { divisor: 1, why: 'no money values' };
  if (nums.some(v => !Number.isInteger(v))) return { divisor: 1, why: 'decimal present, read as 元' };
  const max = Math.max(...nums);
  if (max >= FEN_TOTAL_THRESHOLD) return { divisor: 100, why: `integers, max ${max} >= ${FEN_TOTAL_THRESHOLD}, read as 分` };
  return { divisor: 1, why: `integers, max ${max} < ${FEN_TOTAL_THRESHOLD}, read as 元` };
}

// How populated a captured request is — the count of keys carrying a real value.
// Used to prefer one capture of a method over another; see the 'request' hook.
function _requestScore(req) {
  if (!req || typeof req !== 'object') return 0;
  let n = 0;
  for (const v of Object.values(req)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) { n += 1 + _requestScore(v); continue; }
    n++;
  }
  return n;
}

// Key structure of a payload with every VALUE stripped — safe to write to the sync
// log (no customer data, bounded size), and it is the one artefact that turns "we
// never captured an order" into a five-minute follow-up: the first live order
// prints the real field names.
function shapeDigest(node, depth = 0, maxDepth = 4) {
  if (node === null || node === undefined) return 'null';
  if (Array.isArray(node)) return node.length ? `[${shapeDigest(node[0], depth + 1, maxDepth)}x${node.length}]` : '[]';
  if (typeof node !== 'object') return typeof node;
  if (depth >= maxDepth) return '{...}';
  const keys = Object.keys(node).slice(0, 40);
  return `{${keys.map(k => `${k}:${shapeDigest(node[k], depth + 1, maxDepth)}`).join(',')}}`;
}

class ElemeBrowser {
  constructor(storeCode, shopId) {
    this.storeCode = storeCode;
    this.shopId    = shopId != null ? String(shopId) : '';
    this.sessionFile = path.join(SESSION_DIR, `${storeCode}-session.json`);
    this.browser = null;
    this.context = null;
    this.page    = null;
    this._loggedIn = false;
    // Set when Eleme redirects to its Alibaba risk-control challenge (isaac.ele.me
    // / ynuf.aliapp.org, seen at login per the recon). Mirrors meituan-browser's
    // verificationRequired so callers back off instead of hammering it.
    this.verificationRequired = false;
    // The auth credential every RPC call needs (metas.ksid) — captured passively
    // off the page's OWN traffic (see the context 'request' listener in init()),
    // not guessed from a cookie/localStorage key that could change out from under
    // us. Session cookies ride along automatically; ksid does not persist across
    // a restart the way cookies do, so it's re-captured fresh every init().
    this._ksid = null;
    // name -> { itemGlobalId, skus:[{...captured sku fields incl. stock}] }.
    // Populated a whole-catalogue pass at a time (see _loadFoodCatalogue) since
    // Eleme's stock RPC is scoped per food-group, not searchable by name.
    this._foodCache = new Map();
    // ── Orders (Tier 0/1). All discovery state is per-session: what the orders
    // page was seen CALLING, and what it got BACK. Nothing here is persisted —
    // a new session re-learns from the page rather than trusting a stale guess.
    this.orderPage = null;
    // The napos-order-pc IFRAME inside the shell. Every order RPC is evaluated in
    // here: it is the only context that is BOTH authenticated and origin-correct.
    this.orderFrame = null;
    this._orderNavAt = 0;
    this._orderRpcSeen   = new Map(); // method -> { path, service, method, request }
    this._orderRpcResult = new Map(); // method -> { at, result }
    this._orderRpcSkip   = new Map(); // method -> why its response was unusable
    this._orderListProbe = null;      // cached working probe shape, or 'exhausted'
    this._orderDetailOff = false;     // Tier 1 dormant (no detail method known)
    this._moneyScaleLogged = false;
    // Key-only structure (values stripped) of the first list/detail payload seen.
    // The daemon copies this into eleme_sync_log — it is what turns "we never
    // captured an order" into a five-minute follow-up.
    this.orderShapes = {};
  }

  _isVerifyPage() {
    try { return /isaac\.ele\.me|ynuf\.aliapp\.org|\/verify/i.test(this.page.url()); }
    catch (e) { return false; }
  }
  _flagVerification(where) {
    this.verificationRequired = true;
    this._log(`⚠️ verification required (risk control) at ${where} — a human must pass the challenge; sync paused for this store`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(opts = {}) {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { chromium } = getPlaywright();

    const useSession = !opts.ignoreSession && fs.existsSync(this.sessionFile);
    const storageState = useSession
      ? JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      : undefined;

    const displayAvailable = process.platform === 'win32' || !!process.env.DISPLAY;
    const headfulRequested = process.env.ELEME_HEADFUL === '1';
    const goHeadful = headfulRequested && displayAvailable;
    const headless = opts.headed ? false : (useSession ? !goHeadful : false);
    if (useSession && headfulRequested && !displayAvailable) {
      this._log('ELEME_HEADFUL set but no DISPLAY — staying headless (run under xvfb-run, or start Xvfb and set DISPLAY=:99)');
    }
    this._log(!useSession
      ? (opts.ignoreSession ? 'fresh login (existing session kept until new login succeeds)'
                            : 'no session — launching headed for manual login')
      : (headless ? 'restoring session (headless)' : 'restoring session (headful / Xvfb)'));

    const isWindows = process.platform === 'win32';
    const stealthArgs = ['--disable-blink-features=AutomationControlled'];
    const launchOpts = {
      headless,
      env: browserEnv(),
      args: isWindows
        ? [...stealthArgs, '--disable-gpu', '--disable-dev-shm-usage']
        : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--disable-domain-reliability', '--no-pings', '--disk-cache-size=33554432', '--media-cache-size=16777216', '--disable-gpu-shader-disk-cache', ...stealthArgs],
    };
    if (isWindows) {
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      if (fs.existsSync(edgePath)) launchOpts.executablePath = edgePath;
      else launchOpts.channel = 'msedge';
    }

    this._proxyRaw = activeProxyRaw(this.storeCode);
    const proxy = resolveProxy(this.storeCode);
    if (proxy) { launchOpts.proxy = proxy; this._log(`using proxy ${proxy.server}`); }
    else this._log('no proxy configured (direct datacenter IP)');

    this.browser = await chromium.launch(launchOpts);

    let chromeVer = '124.0.0.0';
    try {
      const m = String(this.browser.version()).match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) chromeVer = m[1];
    } catch (e) {}
    const chromeMajor = chromeVer.split('.')[0];
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

    this.context = await this.browser.newContext({
      storageState,
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await this.context.addInitScript(fingerprintInitScript, { chromeVer, chromeMajor });

    // Capture ksid (+ confirm shopId) straight off the RPC calls the page ITSELF
    // makes while loading — the same "inject a hook, read what fires" trick the
    // recon capture used, rather than guessing where ksid lives client-side (a
    // cookie? localStorage? a JS global? all three are page-implementation
    // details that can change silently; the wire format is the contract).
    // Context-level (not page-level) so it also catches the goods-manage
    // standalone tab and any iframe, regardless of which one fires first.
    this.context.on('request', (req) => {
      try {
        if (req.method() !== 'POST') return;
        if (!req.url().includes(API_HOST)) return;
        const body = req.postData();
        if (!body) return;
        let json; try { json = JSON.parse(body); } catch (e) { return; }
        const metas = json && json.metas;
        if (metas && metas.ksid) {
          if (this._ksid !== metas.ksid) this._log('captured ksid from live traffic');
          this._ksid = metas.ksid;
        }
        if (metas && metas.shopId && !this.shopId) this.shopId = String(metas.shopId);
        // Order RPCs the page issues on its own. Recording the METHOD NAME plus
        // the exact request body it sent is what lets the order reader replay a
        // real payload instead of guessing a shape nobody ever captured.
        if (req.url().includes('/' + ORDER_PATH_PREFIX + '/')) {
          const mm = /[?&]method=([^&]+)/.exec(req.url());
          const name = mm ? decodeURIComponent(mm[1]) : ((json.service || '') + '.' + (json.method || ''));
          if (!this._orderRpcSeen.has(name)) this._log('observed order RPC: ' + name);
          const captured = {
            path: new URL(req.url()).pathname.replace(/^\/+|\/+$/g, ''),
            service: json.service, method: json.method,
            // The ENTIRE request body, metas included — not a reconstruction.
            //
            // Captured live, and the reason this is the whole body rather than a
            // sub-key: ShopQueryService.queryExceptionInfo sends params {} and
            // still works for the page, so the server reads shopId out of METAS,
            // not params. This file's own metas are the GOODS micro-frontend's
            // (appName 'melody', appVersion '4.4.0'); rebuilding an order call
            // around them returned "shopId 必填" no matter what went into params.
            // The order UI is a different app and sends its own metas.
            //
            // So: keep the page's body and send it back as-is. Only `id` (server-
            // validated, must be unique per call) and `ksid` are refreshed.
            body: json,
            params: (json.params && typeof json.params === 'object') ? json.params : {},
            request: (json.params && json.params.request) || {},
          };
          // Keep the MOST COMPLETE capture per method, not merely the newest. The
          // SPA calls some of these more than once — an early call made before the
          // tab is chosen carries nulls, and letting it clobber a fully-populated
          // later one is what produced live "queryType=null [进行中tab类型为空]".
          const prevCap = this._orderRpcSeen.get(name);
          if (!prevCap || _requestScore(captured.body) >= _requestScore(prevCap.body)) {
            this._orderRpcSeen.set(name, captured);
          }
        }
      } catch (e) {}
    });

    // …and the response side. This is the whole point of the "observe" rung: the
    // merchant page fetches its own order list on load, so the daemon can read
    // that payload and issue NO request of its own.
    this.context.on('response', async (res) => {
      try {
        const url = res.url();
        if (!url.includes(API_HOST) || !url.includes('/' + ORDER_PATH_PREFIX + '/')) return;
        const mm = /[?&]method=([^&]+)/.exec(url);
        if (!mm) return;
        const rpcName = decodeURIComponent(mm[1]);
        const json = await res.json().catch(() => null);
        // Why a response was rejected matters as much as that it was: an empty
        // _orderRpcResult otherwise looks identical whether the hook never fired,
        // the body was unreadable, or the page's own call errored.
        if (!json) { this._orderRpcSkip.set(rpcName, 'body unreadable'); return; }
        if (json.error) {
          this._orderRpcSkip.set(rpcName, 'page call errored: ' + JSON.stringify(json.error).slice(0, 120));
          return;
        }
        // A reply with no `result` KEY is not an ncp envelope at all — the order
        // services signal failure as {name,message,meta}. Keep that message: it is
        // the only thing that says why, and it is what finally surfaced
        // "UNAUTHORIZED: 未登录" after three rounds of chasing request shapes.
        if (!('result' in json)) {
          const why = [json.name, json.message].filter(Boolean).join(': ').slice(0, 200);
          this._orderRpcSkip.set(rpcName, why || ('no result key; keys: ' + Object.keys(json).join('/')));
          return;
        }
        // result === null WITH the key present is a legitimate EMPTY answer — a
        // shop with nothing in flight. Discarding it used to make the reader fall
        // through to whatever lesser call had non-null data, which is how a
        // summary feed came to stand in for the order list.
        this._orderRpcSkip.delete(rpcName);
        this._orderRpcResult.set(rpcName, { at: Date.now(), result: json.result });
      } catch (e) {}
    });

    this.page = await this.context.newPage();
  }

  _shellUrl() {
    return this.shopId ? `${MERCHANT_URL}/app/shop/${this.shopId}` : MERCHANT_URL;
  }

  async _waitForKsid(maxMs) {
    const deadline = Date.now() + maxMs;
    while (!this._ksid && Date.now() < deadline) {
      await this.page.waitForTimeout(300);
    }
    return !!this._ksid;
  }

  async ensureLoggedIn() {
    if (this._loggedIn && this._ksid) return true;

    // A proxy/network outage makes this goto time out. That is NOT a logout —
    // surface it as such so callers don't trigger a pointless re-login.
    try {
      await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this._log(`merchant page unreachable (${String(e.message).split('\n')[0].slice(0, 60)}) — proxy/network down, NOT a logout`);
      return false;
    }
    await this._humanPause(2500, 4200);

    if (this._isVerifyPage()) { this._flagVerification('login'); return false; }

    // The shell's own widgets fire RPCs on load, so a real logged-in session
    // hands us a ksid within a few seconds. URL alone is not proof (a logged-out
    // session can flash the shop URL before redirecting to login — same false-
    // positive meituan-browser guards against).
    const onShop = (u) => this.shopId ? u.includes(`/shop/${this.shopId}`) : /\/shop\/\d+/.test(u);
    if (onShop(this.page.url()) && await this._waitForKsid(8000)) {
      this._loggedIn = true;
      await this._saveSession();
      this._log('login confirmed (ksid captured)');
      return true;
    }

    // Not logged in: if there's no saved session yet, wait for a human to log in.
    const hasSession = fs.existsSync(this.sessionFile);
    if (!hasSession) {
      this._log('waiting for manual login (up to 3 min)...');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await this.page.waitForTimeout(2500);
        if (this._isVerifyPage()) continue;
        if (onShop(this.page.url()) && await this._waitForKsid(4000)) {
          this._loggedIn = true;
          await this._saveSession();
          this._log('manual login successful — session saved');
          return true;
        }
      }
      this._log('login timeout');
      return false;
    }

    this._log('session expired — delete session file and re-run in headed mode');
    return false;
  }

  // Interactive headed login for the standalone eleme-login helper (scripts/
  // eleme-login.js). Unlike ensureLoggedIn (which bails the moment it sees a
  // challenge so the daemon doesn't hang), this keeps the window open and polls,
  // letting a human clear it. Only succeeds once ksid has actually been captured.
  async interactiveLogin(maxMs = 360000) {
    const onShop = (u) => !!u && /\/shop\/\d+/.test(u);
    await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(6000);
    this._log('window open — log in, solve any risk-control challenge; waiting for the shop dashboard…');

    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        await this.page.waitForTimeout(2500);
        if (this._isVerifyPage()) continue;
        if (!onShop(this.page.url())) continue;
        if (!this._ksid) continue;
        this._loggedIn = true;
        await this._saveSession();
        this._log('login successful — session saved');
        return true;
      } catch (e) {
        const msg = String(e.message || '');
        if (/crash|has been closed|Target (page|closed)/i.test(msg)) {
          this._log(`recovering from page crash: ${msg.slice(0, 50)}`);
          try {
            this.page = await this.context.newPage();
            await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (e2) { await new Promise(r => setTimeout(r, 2000)); }
        }
      }
    }
    this._log('timed out waiting for manual login');
    return false;
  }

  async close() {
    // Only persist a session we actually logged into — otherwise a failed/
    // abandoned interactive login would overwrite a good session with a
    // logged-out one.
    try { if (this._loggedIn) await this._saveSession(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = this.context = this.page = this.orderPage = this.orderFrame = null;
    this._loggedIn = false;
  }

  isAlive() {
    try {
      if (!this.browser || !this.browser.isConnected()) return false;
      if (!this.page || this.page.isClosed()) return false;
      return true;
    } catch { return false; }
  }

  // Public read of session state (callers alert on this transitioning, same as
  // verificationRequired) — _loggedIn stays the internal field so init()/close()
  // can reset it freely without touching a public contract.
  get loggedIn() { return this._loggedIn; }

  // The goods-manage micro-frontend runs standalone in a top-level tab once the
  // shared .ele.me cookies are set (confirmed live — this is how the recon
  // capture was taken), and it's the origin our own fetch() calls need to run
  // from for the RPC gateway to accept them the same way it accepts the real UI.
  async _ensureOnGoodsManage() {
    try {
      if (!this.page.url().startsWith(GOODS_URL)) {
        await this.page.goto(GOODS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this._humanPause(2000, 3500);
      }
      if (this._isVerifyPage()) { this._flagVerification('goods-manage'); return false; }
      return true;
    } catch (e) {
      this._log(`goods-manage nav failed: ${String(e.message).slice(0, 80)}`);
      return false;
    }
  }

  // ── RPC ("ncp" envelope) ─────────────────────────────────────────────────

  // One JSON-RPC call to app-api.shop.ele.me, issued as an in-page fetch so the
  // shared .ele.me session cookies ride along (no request signing observed).
  // `id` IS validated server-side (confirmed live 2026-08-23 — a made-up short
  // token gets ILLEGAL_REQUEST/"requestId is invalid", and reusing one id across
  // calls gets an internal SERVER_ERROR, presumably an idempotency/dedup check).
  // Live traffic shows every one of the page's own calls uses a FRESH random
  // 32-char uppercase-hex token (a UUIDv4 with the dashes stripped) + "|" +
  // epoch-ms — match that exactly, one per call.
  async _rpc(path, service, rpcMethod, request, opts = {}) {
    // Which context issues the fetch decides both the Origin/Referer the gateway
    // sees AND which session it runs under. Callers pass opts.page — a Page for
    // goods, a Frame for orders (the shell iframe). Both expose evaluate(); they
    // differ only in how you ask whether they are still alive.
    const dead = (t) => {
      try {
        if (typeof t.isClosed === 'function') return t.isClosed();
        if (typeof t.isDetached === 'function') return t.isDetached();
        return false;
      } catch (e) { return true; }
    };
    const page = opts.page && !dead(opts.page) ? opts.page : this.page;
    if (!this._ksid) return { ok: false, transient: true, reason: 'no ksid captured yet' };
    const reqId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
    // A captured body replays as-is. Only two fields are refreshed: `id`, which
    // the server validates and rejects if reused (recon, confirmed live), and
    // `ksid`, which can be newer than the one captured with the body.
    if (opts.body) {
      const replay = Object.assign({}, opts.body, { id: reqId + `|` + Date.now() });
      replay.metas = Object.assign({}, opts.body.metas || {}, { ksid: this._ksid });
      return this._send(`https://${API_HOST}/${path}/?method=${service}.${rpcMethod}`, replay, page);
    }
    const body = {
      id: `${reqId}|${Date.now()}`,
      service, method: rpcMethod,
      // opts.params replaces the whole envelope (order replays — see _rpcOrder);
      // otherwise the goods-style { request } wrapper the recon captured.
      params: opts.params || { request },
      metas: { appName: 'melody', appVersion: '4.4.0', ksid: this._ksid, shopId: Number(this.shopId) },
      ncp: '2.0.0', adapter: 'ncp',
    };
    return this._send(`https://${API_HOST}/${path}/?method=${service}.${rpcMethod}`, body, page);
  }

  // The wire call itself, shared by the reconstructed and the replayed paths.
  async _send(url, body, page) {
    let res;
    try {
      res = await page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, json: j };
      }, { url, body });
    } catch (e) {
      return { ok: false, transient: true, reason: `fetch error: ${String(e.message).slice(0, 100)}` };
    }
    if (!res || res.status !== 200 || !res.json) {
      return { ok: false, transient: true, reason: `HTTP ${res && res.status}` };
    }
    // Envelope stays HTTP 200 on a business error; the error lives in .error.
    if (res.json.error) {
      return { ok: false, transient: false, reason: JSON.stringify(res.json.error).slice(0, 200) };
    }
    return { ok: true, result: res.json.result };
  }

  // The food object's sku-array field name is "specs" (confirmed live capture,
  // 2026-08-23) — found structurally rather than hardcoded anyway (the first
  // array property whose items carry `stock` plus a skuGlobalId/specGlobalId),
  // the same defensive technique lib/meituan-browser.js uses (_extractSku) for
  // its own shape gaps, in case a future response nests it differently. Keeps
  // every original field, since updateFoodStock wants the sku object handed
  // back close to how it read.
  _skusFromFood(food) {
    if (!food || typeof food !== 'object') return [];
    for (const v of Object.values(food)) {
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' &&
          'stock' in v[0] && (('skuGlobalId' in v[0]) || ('specGlobalId' in v[0]))) {
        return v.map(s => ({ ...s }));
      }
    }
    return [];
  }

  // Foods embedded directly in a queryCategoryWithFoodFilter category (see
  // below) — harvest them straight from that response instead of a second
  // round-trip. Returns the set of groupGlobalIds that were fully covered this
  // way, so the caller knows which groups still need their own fetch.
  _harvestEmbeddedFoods(categories) {
    const handled = new Set();
    if (!Array.isArray(categories)) return handled;
    for (const cat of categories) {
      if (!cat || !cat.groupGlobalId || !Array.isArray(cat.foodList)) continue;
      handled.add(String(cat.groupGlobalId));
      for (const food of cat.foodList) {
        const name = String(food.name || '').trim();
        if (!name) continue;
        const skus = this._skusFromFood(food);
        if (skus.length) this._foodCache.set(name, { itemGlobalId: food.itemGlobalId, skus });
      }
    }
    return handled;
  }

  // Populate _foodCache with every food in every group — one full pass per
  // session (foods rarely get renamed), so the FIRST push of a run pays for the
  // whole catalogue and every push after it is a cache hit.
  //
  // FoodService2.queryCategoryWithFoodFilter lists every category with its
  // groupGlobalId + foodCount, and (with withFoods:true) embeds the food list
  // for at least the first/currently-open category — the merchant UI evidently
  // lazy-loads the rest as you scroll, so any category whose foodList comes back
  // null needs its own queryFoodsByGroupGlobalId call (the one call the recon
  // fully captured payload-and-response for).
  async _loadFoodCatalogue() {
    const r = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'queryCategoryWithFoodFilter', {
      shopId: Number(this.shopId), foodQueryFilter: 'ALL', withFoods: true, withPackageUpgradeTag: true,
    });
    if (!r.ok) { this._log(`category listing failed: ${r.reason}`); return false; }
    const categories = Array.isArray(r.result) ? r.result : [];
    if (!categories.length) { this._log('no food groups found — category RPC returned nothing usable'); return false; }

    const handled = this._harvestEmbeddedFoods(categories);
    const remaining = categories.filter(c => c && c.groupGlobalId && !handled.has(String(c.groupGlobalId)));
    for (const cat of remaining) {
      const groupGlobalId = String(cat.groupGlobalId);
      // shopId is a STRING here per the recon capture — confirmed footgun: this
      // sibling call in the SAME service wants shopId as a NUMBER (see
      // _apiUpdateFoodStock and the queryCategoryWithFoodFilter call above).
      const rr = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'queryFoodsByGroupGlobalId',
        { shopId: String(this.shopId), groupGlobalId, withPackageUpgradeTag: true });
      if (!rr.ok) { this._log(`group ${groupGlobalId} (${cat.name || ''}) fetch failed: ${rr.reason}`); continue; }
      const foods = (rr.result && rr.result.foods) || [];
      for (const food of foods) {
        const name = String(food.name || '').trim();
        if (!name) continue;
        const skus = this._skusFromFood(food);
        if (skus.length) this._foodCache.set(name, { itemGlobalId: food.itemGlobalId, skus });
      }
      await this._humanPause(200, 500);
    }
    this._log(`food catalogue loaded: ${this._foodCache.size} item(s) across ${categories.length} group(s)`);
    return this._foodCache.size > 0;
  }

  // There is no fuzzy name match any more, and the absence is the feature.
  //
  // What stood here walked the cache and returned the first entry where either
  // name contained the other. Two consequences, both real: a stored name that
  // was a FRAGMENT of a real listing resolved silently to that listing, and
  // where several matched, insertion order decided which — see
  // docs/eleme-findings.md finding 9. One mapping carrying the single character
  // 芒 pushed 25 units onto one of three listings on 2026-08-25, and which one
  // is still not established, because nothing recorded the target.
  //
  // The rule is now the one the admin screen has always applied: a stored name
  // must BE a listing name (public/retail-admin/14-eleme.js elNameKnown). The
  // screen and the pusher had two different rules and the screen's verdict was
  // read as if it described the pusher — that is how the fragment survived.
  //
  // Measured before removing it: all 194 named mappings on the table resolved
  // on the exact branch and not one depended on the fallback, so nothing stops
  // resolving. Seven of them, though, sit one Eleme rename away from a
  // neighbouring listing whose name contains theirs (洗衣液 / 洗衣液※ and five
  // more like it) — those are what the fallback would have caught silently.

  // ── Stock push ────────────────────────────────────────────────────────────

  // Push one product's stock to Eleme by name (our Eleme items carry no extCode —
  // see the ELEME_BROWSER_RECON.md footgun — so name is the only matching key
  // until a one-time 货号-backfill pass changes that). `sku` (our own 货号) is
  // accepted for interface parity with meituan-browser.updateStock but unused
  // until per-spec extCode matching is wired.
  //
  // `specGlobalId` is the operator's answer to "which size inside this listing"
  // (eleme_product_map.spec_id, chosen in the admin against the cached specs).
  // When set it is the WHOLE match — one size gets the number and nothing else
  // is touched, so two Roots size-variants can share one Eleme listing without
  // overwriting each other.
  async updateStock(productNameCn, productNameEn, newQty, sku, specGlobalId) {
    if (!await this.ensureLoggedIn()) return { ok: false, transient: true };
    if (!await this._ensureOnGoodsManage()) return { ok: false, transient: true };
    if (!await this._waitForKsid(8000)) return { ok: false, transient: true };

    const name = String(productNameCn || productNameEn || '').trim();
    if (!name) return { ok: false, transient: false };

    let entry = this._foodCache.get(name);
    if (!entry) {
      if (!this._foodCache.size) await this._loadFoodCatalogue();
      entry = this._foodCache.get(name);
    }

    if (!entry) {
      // TWO different failures wore one shape before this, and the shared shape
      // was `transient: true` — the same answer a proxy blip gives. A name that
      // is not in the catalogue will never succeed on a retry, so it burned
      // three attempts in about half a minute and landed as
      // "transient push failure — retries exhausted", indistinguishable in the
      // database from a network fault (docs/eleme-findings.md finding 3).
      //
      // A catalogue we could not READ is still transient, and must stay that
      // way. With no rows there is nothing to judge this name against, and
      // answering "not in the catalogue" would be a verdict from an empty
      // input — the fault §30 rule 4 and finding 7 are both about. So the
      // no-catalogue case retries and the not-in-catalogue case does not.
      if (!this._foodCache.size) {
        this._log(`catalogue unavailable — cannot resolve "${name}"`);
        return { ok: false, transient: true };
      }
      // Config error, not a fault: refuse once, say why, and let the reason
      // travel far enough to reach a person. `reason` is carried through the
      // batch into the queue row and the sync log by scripts/eleme-daemon.js.
      //
      // English on both sides, deliberately: §30 rule 3 and
      // docs/tacet-delivery-vocabulary.md Rule 4 say copy from the source and
      // never compose, and no Chinese pair for this sentence exists yet. It
      // joins the strings already waiting in EL_PENDING_CN for one.
      this._log(`name not in catalogue: ${name}`);
      return {
        ok: false, transient: false, unresolved: true,
        reason: `no listing on this store is named "${name}" — pick the name from the catalogue`,
      };
    }

    // The resolved target travels back with the result. §30 rule 7: where a
    // target is chosen, the choice is part of what happened, and storing only
    // that a push succeeded is what made finding 9 unanswerable. Under an exact
    // rule `name` IS the listing's name, so this is a record and not a guess.
    const r = await this._applyStockRule(entry, newQty, name, specGlobalId);
    return { ...r, targetName: name, targetItemId: entry.itemGlobalId || null };
  }

  // Three ways to decide which size(s) of a listing get the number, in order:
  //
  //   1. The operator mapped ONE size (specGlobalId) — write only that size.
  //      This is the accurate path and the only one that lets two Roots
  //      size-variants share one Eleme listing.
  //   2. The listing has exactly one size — unambiguous, write it.
  //   3. Neither — fall back to the wraps/soups rule below. It is a GUESS: the
  //      number it writes is not this product's real stock. Kept because real
  //      wraps/soups (a main size plus add-on sizes, all fed by one Roots
  //      product) genuinely need it, but for a size-variant group it fabricates
  //      stock, so it now says so in the log.
  //
  // A mapped size that is no longer on the listing is a terminal config error,
  // NOT a reason to fall through to the guess — falling through is exactly the
  // behaviour this mapping exists to stop.
  async _applyStockRule(entry, newQty, label, specGlobalId) {
    const skus = entry.skus || [];
    if (!skus.length) return { ok: false, transient: true };

    const want = specGlobalId == null ? '' : String(specGlobalId).trim();
    if (want) {
      const hit = skus.find(sk => String(sk.specGlobalId || sk.skuGlobalId || '') === want);
      if (hit) {
        const sizeName = hit.name || want;
        return this._apiUpdateFoodStock(entry.itemGlobalId, hit, newQty, `${label} [${sizeName}]`);
      }
      this._log(`mapped size ${want} is no longer on "${label}" (sizes: ${skus.map(sk => `${sk.name || '?'}:${sk.specGlobalId}`).join(' | ')}) — not guessing`);
      return { ok: false, transient: false };
    }

    if (skus.length === 1) {
      return this._apiUpdateFoodStock(entry.itemGlobalId, skus[0], newQty, label);
    }
    const N = Number(newQty);
    const BIG = 9999;
    const targets = skus.map((_, i) => (N >= 3) ? BIG : (i === 0 ? N : 0));
    const results = [];
    for (let i = 0; i < skus.length; i++) {
      results.push(await this._apiUpdateFoodStock(entry.itemGlobalId, skus[i], targets[i], `${label} [sku ${i}]`));
      if (i < skus.length - 1) await this._humanPause(300, 700);
    }
    this._log(`variants set (GUESS — no size mapped): ${label} (Roots N=${N}) → [${targets.join(', ')}]`);
    const ok = results.every(r => r.ok);
    const transient = !ok && results.some(r => !r.ok && r.transient);
    return { ok, transient };
  }

  // Set one sku's stock via FoodService2.updateFoodStock. The captured payload
  // (ELEME_BROWSER_RECON.md) reflects the sku object straight back with only
  // `stock` changed — but the READ shape (foods[].*) wasn't captured field-for-
  // field, so default anything it might not carry rather than send `undefined`
  // for a field Eleme requires.
  //
  // Footgun (from the recon captures): shopId is a STRING in the read call
  // (queryFoodsByGroupGlobalId) but a bare NUMBER in this write call — matched
  // literally rather than "fixed" to be consistent.
  //
  // Footgun #2 (confirmed live 2026-08-23): a real read (queryCategoryWithFood
  // Filter's embedded foodList) carries `specGlobalId` on the spec object but NO
  // `skuGlobalId` field at all — recon's captured write payload showed both set
  // to the SAME value, so default skuGlobalId from specGlobalId rather than
  // sending `undefined` for a field the write requires.
  async _apiUpdateFoodStock(itemGlobalId, sku, newQty, label) {
    const foodSkuStock = {
      id: sku.id, foodId: sku.foodId != null ? sku.foodId : sku.id,
      skuGlobalId: sku.skuGlobalId || sku.specGlobalId, specGlobalId: sku.specGlobalId || sku.skuGlobalId,
      price: sku.price, stock: Number(newQty),
      maxStock: sku.maxStock != null ? sku.maxStock : 10000,
      stockStatus: sku.stockStatus != null ? sku.stockStatus : 0,
      stockType: sku.stockType != null ? sku.stockType : 0,
      packageFee: sku.packageFee != null ? sku.packageFee : 0,
      packageShare: sku.packageShare != null ? sku.packageShare : 1,
      extCode: sku.extCode != null ? sku.extCode : '',
      name: sku.name != null ? sku.name : '',
      pid: sku.pid != null ? sku.pid : '',
      canEditPrice: sku.canEditPrice != null ? sku.canEditPrice : true,
    };
    const r = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'updateFoodStock', {
      shopId: Number(this.shopId),
      itemGlobalId,
      foodSkuStocks: [foodSkuStock],
    });
    if (r.ok) { this._log(`stock updated: ${label} → ${newQty}`); return { ok: true, transient: false }; }
    this._log(`stock push failed for ${label}: ${r.reason}`);
    return { ok: false, transient: r.transient };
  }

  // Batch update: push multiple products in ONE goods-manage visit (one catalogue
  // load), mirroring meituan-browser.batchUpdateStock. items = [{ targetCn,
  // targetEn, newQty, sku, ...passthrough }]. Returns the input items each
  // augmented with { ok, transient }.
  async batchUpdateStock(items) {
    if (!items || !items.length) return [];
    if (!await this.ensureLoggedIn()) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!await this._ensureOnGoodsManage()) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!await this._waitForKsid(8000)) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!this._foodCache.size) await this._loadFoodCatalogue();

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (this.verificationRequired) { out.push({ ...it, ok: false, transient: true }); continue; }
      let r;
      try {
        r = await this.updateStock(it.targetCn, it.targetEn, it.newQty, it.sku, it.specGlobalId);
      } catch (e) {
        this._log(`batch item failed: ${String(e.message).slice(0, 80)}`);
        r = { ok: false, transient: true };
      }
      // targetName/targetItemId are what the push landed on (§30 rule 7);
      // reason is why it refused when it did. All three ride the item back to
      // the daemon, which is the only thing that can write them down.
      out.push({ ...it, ok: !!r.ok, transient: !r.ok && !!r.transient,
                 unresolved: !r.ok && !!r.unresolved, reason: r.reason || null,
                 targetName: r.targetName || null, targetItemId: r.targetItemId || null });
      if (i < items.length - 1) await this._humanPause(400, 1000);
    }
    const okN = out.filter(r => r.ok).length;
    this._log(`batchUpdateStock: ${okN} ok, ${out.length - okN} fail`);
    return out;
  }

  // Diagnostic: every food name currently on Eleme (admin tooling / sanity checks).
  async listFoods() {
    if (!await this.ensureLoggedIn()) return null;
    if (!await this._ensureOnGoodsManage()) return null;
    if (!await this._waitForKsid(8000)) return null;
    await this._loadFoodCatalogue();
    return Array.from(this._foodCache.keys());
  }

  // Read-only snapshot of the currently-cached catalogue — no network call,
  // just what listFoods()/updateStock() already loaded into _foodCache this
  // session. Used by the daemon to write eleme_catalogue_cache (the admin
  // UI's autocomplete source), so call listFoods() first if you need it fresh.
  catalogueSnapshot() {
    const out = [];
    for (const [name, entry] of this._foodCache) {
      const skus = entry.skus || [];
      const sku = skus[0] || {};
      out.push({
        name,
        itemGlobalId: entry.itemGlobalId || null,
        stock: sku.stock != null ? sku.stock : null,
        // Every size behind this one name. The admin needs these to offer the
        // "which size" picker; `name` can be blank on a single-size listing, so
        // price/stock ride along to keep the options tellable apart.
        specs: skus.map(sk => ({
          specGlobalId: String(sk.specGlobalId || sk.skuGlobalId || ''),
          name: sk.name || '',
          price: sk.price != null ? sk.price : null,
          stock: sk.stock != null ? sk.stock : null,
        })).filter(sp => sp.specGlobalId),
      });
    }
    return out;
  }

  // ── Orders (Tier 0 + Tier 1) ─────────────────────────────────────────────
  //
  // Detection budget, cheapest rung first — each is used only when the one above
  // came up empty:
  //
  //   1. OBSERVE — loading the orders micro-frontend makes the page issue its own
  //      list RPC. The context hooks in init() capture that request AND its
  //      response, so reading the order list costs ZERO synthetic requests: the
  //      daemon's traffic is exactly a merchant's open tab.
  //   2. REPLAY — if the page didn't refetch, re-issue the call with the request
  //      body captured off the wire. A byte-identical payload, not a guess.
  //   3. GUESS — only if nothing was ever observed this session: a few candidate
  //      request shapes, tried ONCE and cached. Never re-probed per poll.
  //
  // Rung 3 is the only one that can produce a request a real merchant never makes,
  // which is why it is bounded to one pass per browser session and why its
  // outcome (including the observed method names) is written to the sync log —
  // the first live order upgrades this to rung 1 permanently.

  // The orders UI is a DIFFERENT FaaS origin from goods-manage. Running an order
  // RPC from the goods page would send an Origin/Referer pair no real merchant
  // session ever produces — the single most avoidable tell in this file — so
  // orders get their own page, held open like a merchant's second tab. Keeping
  // them separate also means order polling never discards the goods page's loaded
  // catalogue (which _foodCache is built from).
  // The live napos-order-pc frame on the orders tab, or null.
  _findOrderFrame() {
    try {
      return this.orderPage.frames().find(f => {
        try { return f.url().includes(ORDERS_APP_HOST) && !f.isDetached(); } catch (e) { return false; }
      }) || null;
    } catch (e) { return null; }
  }

  // Click the shell nav entry that opens 订单. The shell is an SPA, so the order
  // iframe only mounts once that view is selected. The element is FOUND by its
  // own text rather than by a guessed selector, and the click is confined to the
  // shell's own navigation.
  async _clickOrderNav() {
    try {
      return await this.orderPage.evaluate(() => {
        const wanted = ["订单管理", "订单"];
        const nodes = Array.from(document.querySelectorAll('a, li, span, div, button'));
        for (const want of wanted) {
          const hit = nodes.find((el) => {
            const t = (el.textContent || "").trim();
            if (t !== want) return false;              // exact label only
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;        // must be visible
          });
          if (hit) { hit.click(); return true; }
        }
        return false;
      });
    } catch (e) { return false; }
  }

  // Put the orders UI in front of us, INSIDE the shell.
  //
  // This used to navigate straight to the standalone micro-frontend, which is what
  // the recon said would work — true for napos-goods-pc, false for this one. Loaded
  // as a top-level tab every order RPC comes back UNAUTHORIZED 未登录, the page's
  // own calls included, so no request shape could ever have fixed it. The shell
  // establishes the session the orders app needs; its iframe inherits it, and is
  // also the origin the gateway expects these calls from.
  async _ensureOnOrders(opts = {}) {
    try {
      if (!this.orderPage || this.orderPage.isClosed()) {
        this.orderPage = await this.context.newPage();
        this.orderFrame = null;
        this._orderNavAt = 0;
      }
      const stale = !this._orderNavAt || (Date.now() - this._orderNavAt) > ORDER_PAGE_STALE_MS;
      const live = this.orderFrame && !this.orderFrame.isDetached() ? this._findOrderFrame() : null;
      if (live && !opts.refresh && !stale) { this.orderFrame = live; return true; }

      const url = `${MERCHANT_URL}/app/shop/${this.shopId}/${ORDER_SHELL_ROUTE}`;
      await this.orderPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      this._orderNavAt = Date.now();
      await this._humanPause(3000, 4800);

      if (/isaac\.ele\.me|ynuf\.aliapp\.org|\/verify/i.test(this.orderPage.url())) {
        this._flagVerification('orders shell');
        return false;
      }

      // The route may land on the dashboard rather than the order view; in that
      // case select 订单 the way a person would and wait for the iframe to mount.
      this.orderFrame = this._findOrderFrame();
      if (!this.orderFrame) {
        if (await this._clickOrderNav()) {
          for (let i = 0; i < 12 && !this.orderFrame; i++) {
            await this.orderPage.waitForTimeout(700);
            this.orderFrame = this._findOrderFrame();
          }
        }
      }
      if (!this.orderFrame) {
        this._log(`orders iframe not found on the shell (route "${ORDER_SHELL_ROUTE}") — set ELEME_ORDER_ROUTE to the shell path that shows 订单`);
        return false;
      }
      await this._humanPause(1500, 2600); // let the frame issue its own calls
      return true;
    } catch (e) {
      this._log(`orders shell nav failed: ${String(e.message).slice(0, 80)}`);
      return false;
    }
  }

  // Newest response the page itself produced for a method matching `re`, if it
  // arrived after `since`. This is rung 1 — pure observation, no request of ours.
  // First tier that has an answer wins outright — a later tier is a WORSE answer,
  // not an equal one, so recency must not be allowed to promote it.
  _observedResult(res, since) {
    for (const re of [].concat(res)) {
      let best = null;
      for (const [name, entry] of this._orderRpcResult) {
        if (!re.test(name)) continue;
        if (entry.at < since) continue;
        if (!best || entry.at > best.at) best = Object.assign({ method: name }, entry);
      }
      if (best) return best;
    }
    return null;
  }

  // Request body the page itself sent for a method matching `re` — rung 2.
  _observedCall(res) {
    for (const re of [].concat(res)) {
      for (const [name, entry] of this._orderRpcSeen) {
        if (re.test(name)) return Object.assign({ method: name }, entry);
      }
    }
    return null;
  }

  // A replayed request is the page's own body, but the page fills some values from
  // React state rather than from the payload it was last seen sending — so a
  // verbatim replay can arrive with a required field null. Both cases below are
  // from live traffic, not speculation:
  //   shopId=null    → ShopQueryService.queryExceptionInfo ("shopId 必填")
  //   queryType=null → OrderWebService.queryInProcessOrders ("进行中tab类型为空")
  // Only ever fills a MISSING or NULL field; a value the page actually sent always
  // wins, so this cannot mask a real capture.
  // Fill the values the page supplies from its own React state rather than from
  // the payload it was last seen sending, at whichever level of params they live.
  // Only ever fills a field that is PRESENT and null/empty — a value the page
  // actually sent always wins, so this can never mask a real capture. The one
  // exception is shopId, which is added when the envelope mentions it nowhere.
  // The in-process tab value, taken from any order call the page was seen making
  // that carries one. This is evidence, not a guess: the constant is only the
  // fallback for when no sibling call mentioned a tab at all.
  _observedTabValue() {
    const keys = ['queryType', 'inProcessQueryType', 'tab', 'tabType', 'orderTab'];
    const scan = (obj, depth = 3) => {
      if (!obj || typeof obj !== 'object' || depth < 0) return null;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (keys.includes(k) && v !== null && v !== undefined && v !== ''
            && (typeof v === 'string' || typeof v === 'number')) return v;
        if (v && typeof v === 'object') { const hit = scan(v, depth - 1); if (hit !== null) return hit; }
      }
      return null;
    };
    for (const entry of this._orderRpcSeen.values()) {
      const hit = scan(entry.params);
      if (hit !== null) return hit;
    }
    return null;
  }

  _fillContextParams(params) {
    const out = params && typeof params === 'object' ? JSON.parse(JSON.stringify(params)) : {};
    const blank = (v) => v === null || v === undefined || v === '';
    const tabValue = this._observedTabValue() != null ? this._observedTabValue() : ORDER_INPROCESS_TAB;
    const fillLevel = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k of ['shopId', 'shopIdStr']) {
        if (k in obj && blank(obj[k])) obj[k] = k === 'shopIdStr' ? String(this.shopId) : Number(this.shopId);
      }
      for (const k of ['queryType', 'inProcessQueryType', 'tab', 'tabType', 'orderTab']) {
        if (k in obj && blank(obj[k])) obj[k] = tabValue;
      }
    };
    const mentions = (obj, keys, depth = 3) => {
      if (!obj || typeof obj !== 'object' || depth < 0) return false;
      for (const k of Object.keys(obj)) {
        if (keys.includes(k) && !blank(obj[k])) return true;
        if (obj[k] && typeof obj[k] === 'object' && mentions(obj[k], keys, depth - 1)) return true;
      }
      return false;
    };
    fillLevel(out);
    fillLevel(out.request);
    if (!mentions(out, ['shopId', 'shopIdStr'])) {
      out.request = out.request && typeof out.request === 'object' ? out.request : {};
      out.request.shopId = Number(this.shopId);
    }
    return out;
  }

  // Replay one observed order RPC. With no requestOverride the page's ENTIRE
  // captured params envelope goes back out verbatim (plus context fills) — that is
  // the whole point of observing, and the only shape known to work. An override is
  // used where we must change something (an order id for the detail read, or a
  // probe candidate) and is spliced into params.request.
  async _rpcOrder(entry, requestOverride, opts = {}) {
    // Never let an order call fall through to the goods page. _rpc treats a dead
    // target as "use the default one", and the default is the goods origin — both
    // the wrong origin AND, as it turns out, the wrong session.
    if (!this.orderFrame || this.orderFrame.isDetached()) {
      return { ok: false, transient: true, reason: 'orders frame not mounted' };
    }
    // Preferred path: send the page's own body back, untouched except for the
    // fields that MUST change. Nothing is inferred, so nothing can be inferred
    // wrong — this is the only envelope shape proven to work for these services.
    if (entry.body && entry.body.metas) {
      const replayBody = JSON.parse(JSON.stringify(entry.body));
      if (requestOverride) {
        replayBody.params = replayBody.params && typeof replayBody.params === 'object' ? replayBody.params : {};
        replayBody.params.request = requestOverride;
      }
      return this._rpc(entry.path, entry.service, entry.method, null,
        { page: this.orderFrame, body: replayBody });
    }

    // Fallback for a call we never saw the page make (the probe path only):
    // rebuild the goods-style envelope and fill what context we can.
    let params;
    if (entry.params && Object.keys(entry.params).length) {
      params = JSON.parse(JSON.stringify(entry.params));
      if (requestOverride) params.request = requestOverride;
    } else {
      params = { request: requestOverride || {} };
    }
    const filled = this._fillContextParams(params);
    if (opts.needsTab) {
      const mentionsTab = /"(queryType|inProcessQueryType|tabType|orderTab)"\s*:\s*(?!null)/.test(JSON.stringify(filled));
      if (!mentionsTab) {
        filled.queryType = this._observedTabValue() != null ? this._observedTabValue() : ORDER_INPROCESS_TAB;
      }
    }
    return this._rpc(entry.path, entry.service, entry.method, null,
      { page: this.orderFrame, params: filled });
  }

  // Read the in-process order list. Returns the raw `result` payload (unparsed)
  // or null. See the three rungs above.
  async _readOrderList(opts = {}) {
    if (!await this._ensureOnOrders(opts)) return null;
    // Accept only a response newer than BOTH the last navigation and the freshness
    // ceiling — see ORDER_RESULT_MAX_AGE_MS. On a just-navigated page the nav time
    // wins; on a page held open between polls the ceiling does.
    const since = Math.max(this._orderNavAt || 0, Date.now() - ORDER_RESULT_MAX_AGE_MS);

    // Rung 1 — wait briefly for the page's own list call to land. The SPA fires it
    // on load, so this is the normal path once the page has been navigated.
    const deadline = Date.now() + ORDER_OBSERVE_MS;
    while (Date.now() < deadline) {
      const seen = this._observedResult(ORDER_LIST_RES, since);
      if (seen) {
        // Which call answered matters: more than one order method matches the list
        // pattern loosely, and reading a summary block as though it were the list
        // is exactly the mistake that presents as "no orders".
        this._log('order list observed from ' + (seen.method || '(unknown method)'));
        this._noteOrderShape('list', seen.result);
        return seen.result;
      }
      await this.orderPage.waitForTimeout(400);
    }

    // Rung 2 — replay the page's own captured request body.
    const call = this._observedCall(ORDER_LIST_RES);
    if (call) {
      const r = await this._rpcOrder(call, null, { needsTab: true });
      if (r.ok) {
        this._noteOrderShape('list', r.result);
        return r.result;
      }
      this._log(`order list replay failed (${call.service}.${call.method}): ${r.reason}`);
    }

    // Rung 3 — never observed anything this session. Try the recon's method name
    // against a few candidate request shapes, ONCE, and remember the winner (or
    // that they all failed, so a poll never re-probes).
    if (!ORDER_PROBE_ENABLED) {
      if (!this._probeDisabledLogged) {
        this._probeDisabledLogged = true;
        this._log('order list not observed and shape probing is off (set ELEME_ORDER_PROBE=1 to bootstrap). '
          + `Order RPCs seen this session: ${Array.from(this._orderRpcSeen.keys()).join(', ') || '(none)'}`);
        const skips = Array.from(this._orderRpcSkip.entries()).map(([k, v]) => `${k}: ${v}`);
        this._log(`order responses captured: ${this._orderRpcResult.size}`
          + (skips.length ? ` | unusable: ${skips.join(' ; ')}` : ''));
      }
      return null;
    }
    if (this._orderListProbe === 'exhausted') return null;
    if (this._orderListProbe && this._orderListProbe.request) {
      const r = await this._rpcOrder(this._orderListProbe, this._orderListProbe.request);
      if (r.ok) { this._noteOrderShape('list', r.result); return r.result; }
      return null;
    }

    const shopN = Number(this.shopId);
    const candidates = [
      { shopId: shopN },
      { shopId: shopN, inProcessQueryType: 'ALL' },
      { shopId: shopN, queryType: 'ALL', pageNo: 1, pageSize: 50 },
      { shopId: String(this.shopId) },
    ];
    const base = { path: `fulfill/weborder/${ORDER_LIST_METHOD}`, service: 'OrderWebService', method: ORDER_LIST_METHOD };
    for (const request of candidates) {
      const r = await this._rpcOrder(base, request);
      if (r.ok) {
        this._orderListProbe = { ...base, request };
        this._log(`order list shape found by probe: ${JSON.stringify(request)}`);
        this._noteOrderShape('list', r.result);
        return r.result;
      }
      await this._humanPause(600, 1400);
    }
    this._orderListProbe = 'exhausted';
    this._log(`order list probe exhausted — no working request shape for ${ORDER_LIST_METHOD}. `
      + `Observed order RPCs this session: ${Array.from(this._orderRpcSeen.keys()).join(', ') || '(none)'}`);
    return null;
  }

  // Record the KEY STRUCTURE of the first payload of each kind we see (values
  // stripped). The daemon writes these to the sync log so the first live order
  // reveals the real field names without another capture session.
  _noteOrderShape(kind, payload) {
    if (this.orderShapes[kind]) return;
    try { this.orderShapes[kind] = shapeDigest(payload).slice(0, 4000); } catch (e) { /* never fatal */ }
  }

  // The REQUEST bodies the page was seen sending, with values intact. Unlike the
  // response digests these are safe to keep whole — they are query parameters
  // (shopId, tab, page number), never customer data — and they are what tells us
  // the real value of a field a replay had to fill blind.
  orderRequestSnapshot() {
    const out = {};
    for (const [name, entry] of this._orderRpcSeen) {
      try { out[name] = JSON.parse(JSON.stringify(entry.params)); } catch (e) { /* skip */ }
    }
    return out;
  }

  // Tier 0. Every field below rides in the list response we had to read anyway —
  // reading more of it costs nothing. Returns normalised orders shaped like
  // meituan-browser.getPendingOrders' output, so routes/eleme-internal can stay a
  // twin of routes/meituan-internal.
  async getPendingOrders(opts = {}) {
    if (!await this.ensureLoggedIn()) return [];
    if (!await this._waitForKsid(8000)) return [];

    const payload = await this._readOrderList(opts);
    if (payload == null) return [];
    this.verificationRequired = false; // a real order payload proves we're through

    return this.parseOrderPayload(payload);
  }

  // The whole parse step, split out from the fetch so it can be exercised against
  // recorded/synthetic payloads without a browser (scripts/test_eleme_order_parse.js).
  // Given an envelope of unknown shape: find the order rows, normalise each.
  parseOrderPayload(payload) {
    const list = findArray(payload, looksLikeOrder);
    if (!list.length) {
      // No rows is a legitimate answer for a shop with nothing in flight, so
      // report the COUNTS the payload carries and not only its shape. Zero counts
      // means the backend agrees there is nothing; non-zero counts with no rows
      // means we are reading the wrong payload. Those two look identical
      // otherwise, and the shape digest strips values by design.
      const counts = {};
      const walkCounts = (o, d = 0) => {
        if (!o || typeof o !== 'object' || d > 3) return;
        for (const [k, v] of Object.entries(o)) {
          if (/count$/i.test(k) && (typeof v === 'number' || v === null)) counts[k] = v;
          else if (v && typeof v === 'object') walkCounts(v, d + 1);
        }
      };
      walkCounts(payload);
      this.lastOrderCounts = counts;
      const shown = Object.entries(counts).map(([k, v]) => k + '=' + v).join(' ');
      this._log('order list: no order rows'
        + (shown ? ' | counts: ' + shown : '')
        + (this.orderShapes.list ? ' | shape: ' + this.orderShapes.list.slice(0, 200) : ''));
      return [];
    }
    const orders = list.map(o => this._normalizeOrder(o)).filter(o => o && o.elemeOrderId);
    this._log(`found ${orders.length} order(s) (${list.length} row(s) in payload)`);
    return orders;
  }

  // Tier 1 — ONE extra call per NEW order, mirroring what a merchant's UI does
  // when a card is opened, so our call rate tracks the real order rate.
  //
  // The recon never captured the detail method's name (it is listed as TODO), so
  // this deliberately does NOT probe for it: guessing method names in a loop is
  // the one pattern that would stand out. It runs only when the name is known —
  // either observed on the wire (rung 1, the page calls it whenever anyone opens
  // an order) or named explicitly in ELEME_ORDER_DETAIL_METHOD. Otherwise it
  // stays dormant and says so once per session.
  async getOrderDetail(elemeOrderId) {
    if (!elemeOrderId) return null;
    if (this._orderDetailOff) return null;

    let call = this._observedCall(ORDER_DETAIL_RE);
    if (!call && DETAIL_METHOD_ENV) {
      call = {
        path: `fulfill/weborder/${DETAIL_METHOD_ENV}`,
        service: process.env.ELEME_ORDER_DETAIL_SERVICE || 'OrderWebService',
        method: DETAIL_METHOD_ENV,
        request: { shopId: Number(this.shopId), orderId: String(elemeOrderId) },
      };
    }
    if (!call) {
      this._orderDetailOff = true;
      this._log('order detail (Tier 1) dormant — no detail RPC observed and ELEME_ORDER_DETAIL_METHOD unset. '
        + `Order RPCs seen this session: ${Array.from(this._orderRpcSeen.keys()).join(', ') || '(none)'}`);
      return null;
    }

    if (!await this._ensureOnOrders()) return null;
    const request = this._withOrderId(call.request, elemeOrderId);
    const r = await this._rpcOrder(call, request);
    if (!r.ok) {
      this._log(`order detail failed for ${elemeOrderId}: ${r.reason}`);
      return null;
    }
    this._noteOrderShape('detail', r.result);
    return r.result;
  }

  // Put `id` into a captured request template: overwrite whatever id-ish keys the
  // real payload used, and add `orderId` if it carried none.
  _withOrderId(template, id) {
    const out = JSON.parse(JSON.stringify(template || {}));
    let replaced = false;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        if (/^(order)?id(str)?$|orderno|tradeno/i.test(k) && (typeof node[k] !== 'object')) {
          node[k] = typeof node[k] === 'number' ? Number(id) : String(id);
          replaced = true;
        } else if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) {
          walk(node[k]);
        }
      }
    };
    walk(out);
    if (!replaced) out.orderId = String(id);
    if (out.shopId === undefined) out.shopId = Number(this.shopId);
    return out;
  }

  // One order row → the normalised shape the daemon and internal route consume.
  // Every read goes through pick()/findArray(), so a field Eleme names differently
  // than any candidate comes back null rather than wrong.
  _normalizeOrder(o) {
    const id = ORDER_ID_KEYS.map(k => o[k]).find(v => v != null && String(v).length >= 6);
    if (id == null) return null;

    const rawItems = findArray(o, looksLikeItem, 5);
    // Read through the SAME resolvers the fields themselves use. The scale
    // heuristic decides 元 vs 分 from these values, so feeding it a different
    // set than the one that ends up on the order would let the divisor be
    // decided by a field nobody keeps.
    const moneyRaw = [
      num(pickMoney(o, TOTAL_PATHS, TOTAL_KEYS, NOT_TOTAL_PATH).value),
      num(pickMoney(o, INCOME_PATHS, INCOME_KEYS).value),
      num(pickMoney(o, PACK_FEE_PATHS, PACK_FEE_KEYS).value),
      num(pickMoney(o, DELIVER_FEE_PATHS, DELIVER_FEE_KEYS).value),
      ...rawItems.map(it => num(pick(it, ITEM_PRICE_KEYS, 1))),
      ...rawItems.map(it => num(pick(it, ITEM_TOTAL_KEYS, 1))),
    ].filter(v => v != null);
    const { divisor, why } = decideMoneyDivisor(moneyRaw);
    if (!this._moneyScaleLogged) {
      this._moneyScaleLogged = true;
      this._log(`money scale: dividing by ${divisor} (${why}) — set ELEME_MONEY_SCALE=yuan|fen to pin it`);
    }
    const money = (v) => { const n = num(v); return n == null ? null : n / divisor; };

    const bookFlag = pick(o, BOOK_FLAG_KEYS);
    const bookTime = toUtcStamp(pick(o, BOOK_TIME_KEYS));
    const cutlery  = pick(o, CUTLERY_KEYS);

    const items = rawItems.map((it) => {
      const qty = parseInt(num(pick(it, ITEM_QTY_KEYS, 1)), 10) || 0;
      const unit = money(pick(it, ITEM_PRICE_KEYS, 1));
      const line = money(pick(it, ITEM_TOTAL_KEYS, 1));
      const spec = pick(it, ITEM_SPEC_KEYS, 1);
      return {
        name: String(pick(it, ITEM_NAME_KEYS, 1) || '').trim(),
        qty,
        sku: (pick(it, ITEM_SKU_KEYS, 1) || null) && String(pick(it, ITEM_SKU_KEYS, 1)),
        unitPrice: unit != null ? unit : (line != null && qty > 0 ? line / qty : null),
        lineTotal: line != null ? line : (unit != null ? unit * qty : null),
        specName: typeof spec === 'string' ? spec : null,
      };
    }).filter(it => it.name && it.qty > 0);

    // What the LINES say the basket is worth, and which field the ORDER total
    // came out of. Two independent readings of the same money, kept as two
    // fields rather than reconciled here: the parser's job is to report what the
    // payload said, and picking a winner is a decision the ingest makes with the
    // order's other columns in front of it.
    //
    // Before this, only the order figure survived and it was written to both
    // `subtotal` and `total`. EL20260901417897 banner-read ¥17.50 over ¥267.00 of
    // items with nothing anywhere recording that the two ever disagreed.
    const totalHit  = pickMoney(o, TOTAL_PATHS, TOTAL_KEYS, NOT_TOTAL_PATH);
    // Read once, kept as hits rather than bare values, so each figure below can
    // report the field it came out of alongside what it says.
    const incomeHit     = pickMoney(o, INCOME_PATHS, INCOME_KEYS);
    const commissionHit = pickMoney(o, COMMISSION_PATHS, COMMISSION_KEYS);
    const discountHit   = pickMoney(o, SHOP_DISC_PATHS, SHOP_DISC_KEYS);
    const packHit       = pickMoney(o, PACK_FEE_PATHS, PACK_FEE_KEYS);
    const deliverHit    = pickMoney(o, DELIVER_FEE_PATHS, DELIVER_FEE_KEYS);
    // Where this order actually IS, and which field said so. Two fields rather
    // than one for the same reason the money reads carry `totalKeyPath`: when a
    // status looks wrong, "which field is this?" is the only question that
    // settles it, and until now it could not be answered from anything stored.
    const stage     = pickStage(o);
    const itemsSum  = items.reduce((acc, it) => acc + (Number(it.lineTotal) || 0), 0);
    const itemsPriced = items.length > 0 && items.every(it => Number(it.lineTotal) > 0);

    return {
      elemeOrderId: String(id),
      daySeq:     pick(o, DAY_SEQ_KEYS) != null ? String(pick(o, DAY_SEQ_KEYS)) : null,
      items,
      total:      money(totalHit.value) || 0,
      // Which key, at which depth, produced `total` — 'consumerTotal',
      // 'feeInfo.payAmount', … Null when no candidate matched at all. Carried
      // into eleme_order_import.detail_json, so a wrong-field read is diagnosable
      // from stored data instead of needing the order re-read off the platform.
      totalKeyPath: totalHit.path,
      // Sum of the line totals, rounded the way money is compared everywhere
      // else here. Null unless EVERY line carries a real price: a partially
      // priced basket sums to something smaller than itself, which is a worse
      // number than none at all.
      itemsTotal: itemsPriced ? Math.round(itemsSum * 100) / 100 : null,
      statusDesc: stage.value,
      // The path `statusDesc` came out of ('header.orderLatestStatus',
      // 'printDataInfo.statusForPrint', …), and whether that field named a real
      // stage or is only the validity flag standing in for one. Both ride into
      // eleme_order_import.detail_json and the ingest's sync log, so the next
      // time Eleme renames the field the log says which one we read.
      statusKeyPath: stage.path,
      statusIsStage: stage.isStage,
      eta:        toUtcStamp(pick(o, ETA_KEYS)),
      placedAt:   toUtcStamp(pick(o, PLACED_KEYS)),
      // 预订单 — booked for a later window rather than "now". Only trust an
      // explicit booking flag; without one, a plain ETA is not a pre-order.
      preOrderAt: (bookFlag === true || bookFlag === 1 || bookFlag === 'true') ? (bookTime || toUtcStamp(pick(o, ETA_KEYS))) : null,
      note:       String(pick(o, NOTE_KEYS) || '').trim() || null,
      // Eleme sends a count (份数), not a boolean — any positive count means the
      // customer asked for cutlery.
      needsCutlery: cutlery == null ? false : (num(cutlery) != null ? num(cutlery) > 0 : !!cutlery),
      refundDesc: String(pick(o, REFUND_KEYS) || '').trim() || null,
      // Masked at source by Eleme (隐私号 / partial address). Kept because routing
      // and the rider callback need them; never un-masked — see the Tier 3 note in
      // the daemon header.
      addressMasked: String(pick(o, ADDRESS_KEYS) || '').trim() || null,
      phoneMasked:   String(pick(o, PHONE_KEYS) || '').trim() || null,
      // Economics. Present in the list on some payloads, otherwise filled from the
      // Tier 1 detail read.
      merchantIncome: money(incomeHit.value),
      commission:     money(commissionHit.value),
      platformSubsidy: money(pick(o, SUBSIDY_KEYS)),
      shopDiscount:   money(discountHit.value),
      packagingFee:   money(packHit.value),
      deliveryFee:    money(deliverHit.value),
      // Where every one of those came from, not just the total. pickMoney has
      // always returned a path with its value — the comment on it says so — and
      // until now five of the six were thrown away, which is what made
      // EL20260903163199 undiagnosable: its components overshot its total by
      // exactly the delivery fee, and "the delivery fee is wrong", "the discount
      // is understated" and "the total was read off a delivery-free field" all
      // produce that row. A gap plus the field each term came out of tells them
      // apart; a gap alone never can.
      //
      // Null per key where nothing matched. Archived by scripts/eleme-daemon.js
      // and logged by routes/eleme-internal.js on any order that fails the
      // settlement identity.
      moneyKeyPaths: {
        total:          totalHit.path,
        merchantIncome: incomeHit.path,
        commission:     commissionHit.path,
        shopDiscount:   discountHit.path,
        packagingFee:   packHit.path,
        deliveryFee:    deliverHit.path,
      },
      moneyDivisor:   divisor,
      raw: o,
    };
  }

  // Merge a Tier 1 detail payload onto a Tier 0 order: fill the economics and any
  // line prices the list didn't carry. Never overwrites a value the list already
  // gave — the list is the row we actually saw, detail only fills blanks.
  mergeOrderDetail(order, detail) {
    if (!order || !detail) return order;
    const divisor = order.moneyDivisor || 1;
    const money = (v) => { const n = num(v); return n == null ? null : n / divisor; };
    // Filling a blank from the detail read has to record WHERE it was filled
    // from too, or a figure that arrived on the second read looks, in the log,
    // exactly like one that was never found at all. `detail:` prefixes the path
    // because the two payloads are different documents and the same key can
    // legitimately sit at a different place in each.
    const fill = (key, paths, keys) => {
      if (order[key] == null) {
        const hit = pickMoney(detail, paths, keys);
        const v = money(hit.value);
        if (v != null) {
          order[key] = v;
          if (order.moneyKeyPaths && hit.path) order.moneyKeyPaths[key] = 'detail:' + hit.path;
        }
      }
    };
    fill('merchantIncome', INCOME_PATHS, INCOME_KEYS);
    fill('commission', COMMISSION_PATHS, COMMISSION_KEYS);
    fill('platformSubsidy', [], SUBSIDY_KEYS);
    fill('shopDiscount', SHOP_DISC_PATHS, SHOP_DISC_KEYS);
    fill('packagingFee', PACK_FEE_PATHS, PACK_FEE_KEYS);
    fill('deliveryFee', DELIVER_FEE_PATHS, DELIVER_FEE_KEYS);
    if (order.note == null) order.note = String(pick(detail, NOTE_KEYS) || '').trim() || null;
    if (order.refundDesc == null) order.refundDesc = String(pick(detail, REFUND_KEYS) || '').trim() || null;

    // Line prices: match detail lines to list lines by name, fill only blanks.
    const dItems = findArray(detail, looksLikeItem, 6);
    if (dItems.length) {
      for (const line of order.items) {
        const hit = dItems.find(d => String(pick(d, ITEM_NAME_KEYS, 1) || '').trim() === line.name);
        if (!hit) continue;
        if (line.unitPrice == null) line.unitPrice = money(pick(hit, ITEM_PRICE_KEYS, 1));
        if (line.lineTotal == null) line.lineTotal = money(pick(hit, ITEM_TOTAL_KEYS, 1));
        if (!line.sku) {
          const s = pick(hit, ITEM_SKU_KEYS, 1);
          if (s) line.sku = String(s);
        }
      }
      // A detail line the list never carried (combo component, gift) is real
      // stock leaving the shelf — take it rather than silently under-deducting.
      for (const d of dItems) {
        const name = String(pick(d, ITEM_NAME_KEYS, 1) || '').trim();
        const qty = parseInt(num(pick(d, ITEM_QTY_KEYS, 1)), 10) || 0;
        if (!name || qty <= 0) continue;
        if (order.items.some(l => l.name === name)) continue;
        const sk = pick(d, ITEM_SKU_KEYS, 1);
        order.items.push({
          name, qty, sku: sk ? String(sk) : null,
          unitPrice: money(pick(d, ITEM_PRICE_KEYS, 1)),
          lineTotal: money(pick(d, ITEM_TOTAL_KEYS, 1)),
          specName: null,
        });
      }
    }
    // The merge above is the ONLY other writer of line money — it fills blanks
    // from the detail payload and can append a line the list never carried — so
    // the basket value computed in _normalizeOrder is stale by exactly this
    // point. Recompute on the same rule (every line priced, or null).
    const merged = (order.items || []).reduce((acc, it) => acc + (Number(it.lineTotal) || 0), 0);
    order.itemsTotal = (order.items || []).length > 0
      && order.items.every(it => Number(it.lineTotal) > 0)
      ? Math.round(merged * 100) / 100
      : null;

    order.rawDetail = detail;
    return order;
  }

  // Orders sitting in Eleme's refund/exception queue. OBSERVE + REPLAY only —
  // never probed, because unlike the list there is no single confirmed method name
  // to probe with, and guessing several in a row is exactly the pattern this file
  // is built to avoid. If the page never calls one of these, this returns [] and
  // says so once; the restock path simply stays dormant rather than acting on a
  // guess.
  //
  // Returns the same normalised shape as getPendingOrders, so the daemon can push
  // these through the identical status-refresh path.
  async getVoidedOrders() {
    if (!await this.ensureLoggedIn()) return [];
    if (!this.orderFrame || this.orderFrame.isDetached()) return [];

    const since = Math.max(this._orderNavAt || 0, Date.now() - ORDER_RESULT_MAX_AGE_MS);
    let payload = null;
    const seen = this._observedResult(ORDER_VOID_RES, since);
    if (seen) {
      payload = seen.result;
    } else {
      const call = this._observedCall(ORDER_VOID_RES);
      if (!call) {
        if (!this._voidQueueOffLogged) {
          this._voidQueueOffLogged = true;
          this._log('refund/exception queue not observed this session — cancels will not auto-restock. '
            + `Order RPCs seen: ${Array.from(this._orderRpcSeen.keys()).join(', ') || '(none)'}`);
        }
        return [];
      }
      const r = await this._rpcOrder(call);
      if (!r.ok) { this._log(`refund queue replay failed (${call.method}): ${r.reason}`); return []; }
      payload = r.result;
    }
    this._noteOrderShape('void', payload);
    return this.parseOrderPayload(payload);
  }

  // Not wired: accepting an order writes to Eleme, which is outside the Tier 0/1
  // collection scope, and the accept method was never captured either. Left as an
  // explicit stub so a caller gets `false` rather than a missing-method throw.
  async acceptOrder() {
    this._log('acceptOrder: not implemented (collection-only build)');
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _saveSession() {
    if (!this.context) return;
    const state = await this.context.storageState();
    fs.writeFileSync(this.sessionFile, JSON.stringify(state));
  }

  // Re-persist the live session's cookies to disk periodically (see the same
  // rationale in meituan-browser.js — a crash skips close()'s save, and a stale
  // cookie snapshot forces a re-login, the riskiest event for tripping risk-
  // control). No-op unless authenticated.
  async persistSession() {
    if (!this._loggedIn || !this.context) return false;
    try { await this._saveSession(); return true; } catch (e) { return false; }
  }

  _rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
  async _humanPause(min = 600, max = 1600) { await this.page.waitForTimeout(this._rand(min, max)); }

  _log(msg) {
    console.log(`[eleme:${this.storeCode}] ${msg}`);
  }
}

// ── Factory: get or create a browser instance per store ──────────────────────
const instances = {};
const lastLaunchAt = {}; // storeCode → epochMs of last full (re)launch

// Don't spin up a fresh Chromium more than once per minute (see meituan-browser's
// identical guard — the same renderer-thrash concern applies here).
const RELAUNCH_COOLDOWN_MS = 60_000;

async function getBrowser(storeCode, shopId) {
  const existing = instances[storeCode];
  if (existing && existing.isAlive() && existing._proxyRaw === activeProxyRaw(storeCode)) return existing;

  if (existing) {
    const proxyChanged = existing.isAlive() && existing._proxyRaw !== activeProxyRaw(storeCode);
    const now = Date.now();
    if (!proxyChanged && lastLaunchAt[storeCode] && now - lastLaunchAt[storeCode] < RELAUNCH_COOLDOWN_MS) {
      throw new Error('eleme browser relaunch cooling down (renderer recently crashed) — will retry shortly');
    }
    console.log(`[eleme:${storeCode}] ${proxyChanged
      ? `proxy switched (${existing._proxyRaw || 'direct'} → ${activeProxyRaw(storeCode) || 'direct'}) — relaunching`
      : 'browser not alive (crash/disconnect) — relaunching from saved session'}`);
    try { await existing.close(); } catch {}
    delete instances[storeCode];
  }

  lastLaunchAt[storeCode] = Date.now();
  const b = new ElemeBrowser(storeCode, shopId);
  await b.init();
  instances[storeCode] = b;
  return b;
}

async function closeAll() {
  for (const b of Object.values(instances)) await b.close();
  for (const k of Object.keys(instances)) delete instances[k];
}

module.exports = { ElemeBrowser, getBrowser, closeAll };
