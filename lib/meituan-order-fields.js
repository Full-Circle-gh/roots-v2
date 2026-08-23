'use strict';

// Everything the unified Meituan order-list response carries BEYOND the order
// number / items / total the two daemons already read.
//
// WHY THIS FILE EXISTS. 外卖 (lib/meituan-browser.js) and 闪购
// (lib/shangou-browser.js) both poll the SAME endpoint —
// POST /gw/api/unified/r/order/list/page/history — and both get back a ~26KB
// envelope per order of which we kept about fifteen fields. Prices, Meituan's
// own listing ids, the fee/commission breakdown, the rider, the customer's
// lifetime order count and the delivery distance were all already in the
// response and were being dropped on the floor.
//
// ⚠️ THIS ADDS NO REQUESTS. Every field below is read out of a response we have
// already fetched, so the daemon's footprint on Meituan is byte-for-byte what it
// was: same URL, same cadence, same session, same signature. That is the whole
// point — nothing here was worth a second call. In particular the customer's
// REAL phone and street address are deliberately NOT here: Meituan masks them
// ("为保护用户隐私具体地址已隐藏" / "手机尾号1150") and un-masking needs a separate
// per-order, privacy-gated call that would turn one request per poll into 1+N on
// their most-audited endpoint. Distance + coordinates below are the substitute.
//
// CONTRACT: best-effort and never throwing. A missing section, a renamed field
// or a payload shape we have never seen yields null/[] for that fact and nothing
// else — an order must still import, and its stock must still deduct, on the day
// Meituan reshuffles this JSON. Callers treat every field as optional.

// Coerce to a finite number, else null. '' / null / 'abc' / NaN → null.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Unix seconds → UTC 'YYYY-MM-DD HH:MM:SS', matching every other timestamp we
// store. 0 / absent → null (Meituan uses 0 for "not yet", not for the epoch).
function toUtc(sec) {
  const n = num(sec);
  if (!n || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Meituan sends coordinates as micro-degrees (23118822 → 23.118822).
function microDeg(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  return Math.round(n) / 1e6;
}

function str(v) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s || null;
}

// A logistics phrase meaning the parcel is with the customer. Decides whether
// the row's last-update time may be read as the delivery time (see deliveredAt).
const DELIVERED_RX = /已送达|已妥投|妥投|已完成|用户已收餐|已收餐|已收货|已签收|签收成功/;

// Parse a field that arrives as a JSON string but may already be an object (the
// daemons hand us the raw row; the tests hand us a parsed one). Never throws.
function asObj(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
}

// Pull the extra fields out of ONE element of data.orderList.
// Returns a flat, small object safe to POST to the internal ingest API — never
// the 26KB original.
function extractOrderFields(row) {
  try {
    const ci = asObj(row && row.commonInfo);
    const oi = asObj(row && row.orderInfo);

    const uo   = oi.unifiedOrderInfo     || {};
    const bv   = uo.basicVo              || {};
    const food = oi.foodInfo             || {};
    const log  = oi.unifiedLogisticsInfo || {};
    const lbv  = log.basicVo             || {};
    const user = oi.unifiedUserInfo      || {};
    const fs   = (oi.chargeInfo || {}).fixedSettlementInfo || {};

    // ── Items, structured ────────────────────────────────────────────────
    // orderInfo.foodInfo.cartDetailVos[].details[] — the same lines the copy
    // text carries, but with the price, Meituan's own foodId, and any add-on
    // children. cartName is the "口袋" a line belongs to on a multi-bag order.
    const items = [];
    const carts = Array.isArray(food.cartDetailVos) ? food.cartDetailVos
                : Array.isArray(food.cartDetails)   ? food.cartDetails : [];
    for (const cart of carts) {
      for (const f of (Array.isArray(cart && cart.details) ? cart.details : [])) {
        const name = str(f.foodName || f.name || f.skuName);
        const qty  = num(f.count != null ? f.count : f.quantity);
        if (!name || !qty) continue;
        // Add-on / spec children ride along as labels for whoever packs the bag;
        // they are NOT separate stock lines (the parent already carries the qty).
        const options = (Array.isArray(f.subDetails) ? f.subDetails : [])
          .map(s => str(s && (s.foodName || s.name)))
          .filter(Boolean);
        items.push({
          name,
          qty,
          price:       num(f.foodPrice),
          originPrice: num(f.originFoodPrice),
          discount:    num(f.foodDiscountPrice),
          foodId:      str(f.foodId),
          detailId:    str(f.detailId),
          cart:        str(cart && cart.cartName),
          sku:         str(f.skuCode || f.sourceFoodCode || f.upcCode),
          options:     options.length ? options : null,
        });
      }
    }

    // ── Money ────────────────────────────────────────────────────────────
    // The copy text's "合计：65.0元" is what the CUSTOMER paid. It is not what we
    // earn, and until now it was the only money figure we kept. Here:
    //   food       商品金额      56     → subtotal
    //   shipping   配送费         8     → shipping_fee
    //   packaging  打包袋         1     → packing_fee
    //   commission 平台服务费   3.25    → deducted from us
    //   settle     预计收入    61.75    → what actually lands
    const money = {
      food:       num(fs.foodAmount),
      shipping:   num(fs.shippingFee),
      packaging:  num(fs.packageBagMoney != null ? fs.packageBagMoney : fs.boxpriceTotal),
      commission: num(fs.commisionAmount),
      discount:   num(fs.activityAmount),
      settle:     num(fs.settleAmount != null ? fs.settleAmount : fs.orderSettleAmount),
      userPaid:   num(fs.userPayTotalAmount),
    };

    // ── Rider / logistics ────────────────────────────────────────────────
    // statusCode is Meituan's own numeric logistics state (40 = delivered),
    // worth keeping beside the Chinese phrase because a code survives the
    // wording changes our status regexes keep chasing.
    const brief = str((log.logisticsProcessVo || {}).processBrief)
               || str((log.logisticsTitleVo   || {}).text);
    const statusDesc = str(uo.statusDesc);
    const rider = {
      name:       str(log.riderName || (lbv.dispatcherVo || {}).name),
      statusCode: num(lbv.status),
      statusDesc: brief,
      // sendTime  = job pushed to the fleet; assignTime = a rider took it;
      // fetchTime = that rider collected it from the store.
      sentAt:     toUtc(lbv.sendTime),
      assignedAt: toUtc(lbv.assignTime),
      fetchedAt:  toUtc(lbv.fetchTime),
      selfDelivery: lbv.ifSelfLogistics === true ? 1 : (lbv.ifSelfLogistics === false ? 0 : null),
      dispatchId: str(lbv.dispatchOrderId),
      // No delivered-at timestamp is sent as such. What IS sent is basicVo.utime
      // (the row's last update) plus logisticsProcessVo.formatTime — an "HH:MM"
      // with no date, untrustworthy alone across midnight. On a row whose
      // logistics phrase says delivered the two agree to the minute (utime
      // 09:01:08Z = formatTime "17:01" Beijing), so utime is read as the delivery
      // time ONLY then, and left null otherwise rather than guessed.
      deliveredAt: (DELIVERED_RX.test(brief || '') || DELIVERED_RX.test(statusDesc || ''))
        ? toUtc(bv.utime)
        : null,
    };

    // ── Customer ─────────────────────────────────────────────────────────
    // wmUserId is the only stable customer identity Meituan gives a merchant: it
    // is the same across that customer's orders, so repeat business becomes
    // countable for the first time. Stored as TEXT — these ids run past 2^53.
    const addr = ((user.customerAddressVo || {}).distanceAndAddressVo) || {};
    let orderCount = null;
    for (const c of (((food.userLabelVo || {}).contents) || [])) {
      const m = String((c && c.info) || '').match(/下单\s*(\d+)\s*次/);
      if (m) { orderCount = parseInt(m[1], 10); break; }
    }
    // Masked tail only ("手机尾号1150" → "1150"); see the header note.
    const phoneShow = str(((user.recipientPhoneVo || {}).appRecipientPhoneVo || {}).recipientPhoneShow);
    const tailM = (phoneShow || '').match(/(\d{4})\s*$/);
    const customer = {
      userId:     str(ci.wmUserId || user.wmUserId),
      name:       str(user.recipientName),
      phoneTail:  tailM ? tailM[1] : null,
      orderCount,
      distanceM:  num(addr.orderDistance),
      lat:        microDeg(addr.addressLatitude),
      lng:        microDeg(addr.addressLongitude),
    };

    // ── Invoice (发票) ───────────────────────────────────────────────────
    // Fills invoice_title / invoice_tax_id / needs_invoice — three columns that
    // have existed on retail_orders all along and were never populated for a
    // channel order.
    const invoiceTitle = str(food.invoiceTitle);
    const invoice = {
      wanted: invoiceTitle ? 1 : 0,
      title:  invoiceTitle,
      taxId:  str(food.invoiceTaxpayerId),
    };

    // customerRemark is Meituan's own rendering of the 备注 ("无备注" when the
    // customer wrote nothing) — a cross-check on the note we scrape out of the
    // copy text, never a replacement for it.
    const remark = str(food.customerRemark || food.remark);

    return {
      items,
      money,
      rider,
      customer,
      invoice,
      remark: (remark === '无备注') ? null : remark,
      kindsAndNum: str(food.foodKindsAndNum),
      // Which top-level sections this payload actually carried. Logged once per
      // store so a shape change (or a store whose payload never had a section)
      // shows up as data instead of as a silently empty column.
      present: Object.keys(oi).filter(k => oi[k] != null),
    };
  } catch (e) {
    // A parse failure must cost the extras and nothing else — never the order.
    return {
      items: [], money: {}, rider: {}, customer: {}, invoice: {},
      remark: null, kindsAndNum: null, present: [],
      error: String(e && e.message).slice(0, 120),
    };
  }
}

module.exports = { extractOrderFields, toUtc };
