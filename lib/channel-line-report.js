'use strict';

// What an order line's stock problems are, and how to say them out loud.
//
// TWO FAMILIES NOW, and the second was added on 2026-09-15: the platform
// ingests' clamped/unmatched lines (everything down to notifyStockGaps), and
// our OWN channels' shelf-below-zero — mini app, web store and counter till,
// which had no alert of any kind. See the block above OWN_CHANNEL_LABEL for
// why that is a different sentence rather than another arm of alertText().
//
// SHARED BY BOTH CHANNEL INGESTS, deliberately. routes/eleme-internal.js and
// routes/meituan-internal.js are parallel copies of each other by design — the
// two platforms word their statuses and their payloads differently, and a shared
// status list would make one channel's fix a risk to the other. That argument
// holds for the PARSING. It does not hold for this: "an order arrived and some
// of it never came off the shelf" is one fact about our own stock, worded
// identically whichever platform sent it, and the copies had already drifted on
// exactly that — Meituan detected oversells and Eleme did not, for months.
//
// ── WHY ANY OF THIS IS NEEDED ────────────────────────────────────────────────
// Both ingests already wrote an `order_unsynced` row when a line resolved to no
// product, and Meituan wrote `order_oversold` when a line exceeded on-hand. Both
// went into a sync-log table with no index, no screen, and nothing watching it.
// The result, measured 2026-09-08: 54 lines had gone undeducted, the oldest in
// June, and it was found only because the stock numbers looked wrong to a human
// weeks later. A log nobody reads is not a record, it is a place to put things.
//
// ── AND WHY IT FILTERS FIRST ─────────────────────────────────────────────────
// Of those 54, a third are not products and never were: the cutlery answer
// (无需餐具 / 适量餐具) and orphaned heating options (加热 Yes) that Meituan sends
// as line items. Alerting on those would fire on nearly every Meituan order, and
// an alert that cries wolf on every order is worse than no alert — it is the
// thing that buries the seven real ones.

// A line that is an ORDER OPTION rather than something we sell. Kept narrow on
// purpose, and both halves are drawn from the live data (the 54 unresolved lines
// on 2026-09-08) rather than imagined:
//
//   • 餐具 — the cutlery answer. Meituan sends it as a line ("无需餐具 No
//     cutlery（0份）", "适量餐具 Cutlery based on product（1份）"). The order
//     already carries it properly in needs_cutlery, so the line is a duplicate
//     of a field we store, not a sale.
//   • a name that is NOTHING BUT a heating option — "加热 Yes)", "加热Yes)" —
//     which is what a real line's option suffix looks like after Meituan has
//     mangled the food name off the front of it.
//
// THE SECOND TEST IS DELIBERATELY EXACT, not "contains 加热". Live lines like
// "藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g） (加热Yes)" are REAL
// products carrying a heating suffix, and a `contains` test would classify a
// genuine unsold combo as noise — hiding the very thing this is meant to
// surface.
function isOptionLine(name) {
  const s = String(name || '');
  if (!s.trim()) return false;
  if (s.includes('餐具')) return true;
  // Everything that is not a letter, a digit or a CJK character, removed — so
  // stray brackets and spacing from a truncated name cannot defeat the match.
  const core = s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return /^加热(yes|no|heatup)?$/.test(core);
}

// Split a resolved line list into the three things a caller has to act on
// differently. `items` are the ingest's own resolved lines: { productId, name,
// nameEn, sku, qty } plus, for an oversell, { have, want }.
function classifyLines(items, oversoldByLine) {
  const unresolved = [];   // a real product we could not identify — stock NOT taken
  const optionNoise = [];  // cutlery / heating — nothing should ever be deducted
  for (const it of items || []) {
    if (it.productId) continue;
    const name = it.name || it.nameEn || '';
    (isOptionLine(name) ? optionNoise : unresolved).push(it);
  }
  return { unresolved, optionNoise, oversold: oversoldByLine || [] };
}

// The merchant-facing line, bilingual, in the shape every other channel alert on
// this account already uses: emoji, 中文, newline, English (scripts/*-daemon.js).
//
// ── AND THE ENGLISH HALF IS WRITTEN FOR THE SHOP FLOOR, NOT FOR US ───────────
// It shipped saying `1 line(s) exceeded on-hand and were clamped at 0`, which is
// four pieces of our vocabulary in nine words: a `line` is a row in a payload, a
// count `on-hand` is a column name, `clamped` is what the ingest did to it, and
// the parenthesised plural is a programmer refusing to pick. Ash read that alert
// on a phone on 2026-09-17 and could not tell what had happened — which is the
// whole failure, because the 中文 half beside it said the plain thing (`库存不足,
// 已按 0 计`) and the group's own auto-translate rendered it as `1 item out of
// stock, counted as 0`. The machine translation of our Chinese was clearer than
// our English.
//
// So: no `line`, no `on-hand`, no `clamped`, no `deducted`, no `(s)`. Say what
// happened to the shelf, then say the one thing to go and do. The count is
// carried by the 中文 half and by the names themselves, so the English does not
// repeat it and never has to agree with it.
//
// EVERY CHINESE WORD HERE IS ALREADY LIVE IN THIS PRODUCT — nothing is invented.
// 订单 · 商品 · 未匹配 (the products table's own "no match" pair) · 库存 · 扣减
// (the stock screens' own "已扣减") · 库存不足 (the low-stock pair) · 剩余 ·
// 请检查 (the daemons' own alert tail). Declared in
// docs/tacet-delivery-vocabulary.md under Rule 4's standing delegation.
function alertText({ channel, storeCode, orderNo, unresolved = [], oversold = [] }) {
  if (!unresolved.length && !oversold.length) return null;
  const cnCh = channel === 'eleme' ? '饿了么' : '美团外卖';
  const enCh = channel === 'eleme' ? 'Eleme' : 'Meituan 外卖';
  const where = `${cnCh} ${storeCode || ''}`.trim();
  const whereEn = `${enCh} ${storeCode || ''}`.trim();
  const nameOf = (it) => it.nameEn || it.name || '?';

  const cn = [];
  const en = [];
  if (unresolved.length) {
    cn.push(`${unresolved.length} 项商品未匹配,库存未扣减:` +
            unresolved.map(i => `${nameOf(i)} ×${i.qty}`).join('、'));
    en.push('not in our product list, so no stock came off the shelf: ' +
            unresolved.map(i => `${nameOf(i)} x${i.qty}`).join('; '));
  }
  if (oversold.length) {
    cn.push(`${oversold.length} 项库存不足,已按 0 计:` +
            oversold.map(o => `${nameOf(o)} 需要 ${o.want},剩余 ${o.have}`).join('、'));
    en.push('sold with nothing left on the shelf: ' +
            oversold.map(o => `${nameOf(o)} ordered ${o.want}, stock said ${o.have}`).join('; '));
  }
  return `🟠 ${where} 订单 ${orderNo}:${cn.join(';')}。请检查\n` +
         `${whereEn} order ${orderNo} — ${en.join('; ')}. The stock count is now wrong. Count the shelf and correct it.`;
}

// Classify, word it, and send it to the merchant. The one call both ingests make.
//
// NEVER THROWS, and never blocks. This runs inside the request that records a
// real order, and an alerting problem must not be able to cost us the order —
// the same rule resolveProduct() is written under in both routes. ops-alert and
// tenant-db are required lazily so that merely loading this module (in a test,
// or in a diagnostic) does not open a database or read alert config.
//
// ONE ACCOUNT. Both internal routes open account 1's database and are reachable
// only from the daemon on localhost, so ROOTS_TENANT_ID is the addressee for the
// same reason scripts/eleme-daemon.js states in its own header: there is exactly
// one, and naming it is real rather than a placeholder.
function notifyStockGaps({ channel, storeCode, orderNo, unresolved = [], oversold = [] }) {
  try {
    // The unresolved list arrives already filtered to product_id-less lines, so
    // it is re-shaped for classifyLines rather than re-derived.
    const { unresolved: real } = classifyLines(unresolved.map(u => ({ ...u, productId: null })));
    const text = alertText({ channel, storeCode, orderNo, unresolved: real, oversold });
    if (!text) return null;
    const { alertMerchant } = require('./ops-alert');
    const { ROOTS_TENANT_ID } = require('./tenant-db');
    Promise.resolve(alertMerchant(ROOTS_TENANT_ID, text))
      .catch((e) => console.error('[channel-line-report] alert delivery failed:', e && e.message));
    return text;
  } catch (e) {
    console.error('[channel-line-report] notifyStockGaps failed:', e && e.message);
    return null;
  }
}

/* ── OUR OWN CHANNELS, WHICH SAID NOTHING AT ALL ───────────────────────────
   Everything above is about a line arriving from Meituan or Eleme. The mini
   app, the web store and the counter till have the same problem and had no
   voice for it whatsoever.

   THE FACT IS NOT THE SAME FACT, which is why this is its own sentence rather
   than another arm of alertText(). A platform ingest CLAMPS: the line exceeded
   on-hand, the shelf did not move, and the alert says "已按 0 计". Our own
   commit does not clamp and must not — since §84 a shelf below zero is the
   honest record that units were sold that were never held, and it is the only
   record the kitchen has (lib/batch-owed.js). So the shelf DID move, the write
   was correct, and what is being reported is that somebody is now owed
   something. Saying the shelf never moved, as the platform alert does, would
   be false here.

   WHY IT IS REPORTED AT ALL, given the negative is already the record. The
   record is somewhere nobody is looking. A batch-made product's debt reaches
   the kitchen's owed block; a bought-in one reaches nothing but a row inside
   the dashboard's out-of-stock panel, where it is one line among the plain
   zeroes. Meituan and Eleme have been pushing this to the merchant since
   2026-09-08 for exactly the reason the header above gives — 54 lines went
   undeducted from June to September and were found by a human noticing. Our own
   channels were left out of that fix.

   NO NEW LOG TABLE. The platforms write a sync-log row because their ingest has
   one; ours already writes `retail_stock_ledger` with the negative
   `balance_after`, the order it belongs to and the channel that caused it. That
   IS the durable record. What was missing was only the saying-it-out-loud half.

   Every Chinese fragment is live and cited in
   docs/tacet-delivery-vocabulary.md, "A shelf that went below zero". */
const OWN_CHANNEL_LABEL = {
  // Live pairs, not minted: the dashboard's own channel chips
  // (public/retail-admin/03-dashboard.js DASH_CHAN_SHORT) and, for the till,
  // the capability and role label it carries everywhere (lib/capabilities.js
  // `till: ['Counter till', '前台收银']`).
  counter: ['前台收银', 'Counter till'],
  wechat: ['微信', 'WeChat'],
  web: ['网店', 'Web store'],
  shop: ['门店', 'Shop'],
  manual: ['手动', 'Manual'],
};

// The merchant-facing line for a shelf our own commit has taken below zero.
// Same shape as alertText: emoji, 中文, newline, English.
//
// `lines` = [{ name, nameEn, balance }] — `balance` is the shelf AFTER the
// write, so it is already negative and prints with its own sign. A numeral
// needs no unit noun here for the same reason the kitchen's owed rows carry
// none: the name and the number are the whole of it.
//
// ── TWO SENTENCES, BECAUSE A NEGATIVE HAS TWO CAUSES ───────────────────────
// Shipped 2026-09-15 saying "有客户订单等待 / are now owed" on every path, and
// Ash asked the question that showed it was wrong on the one path it actually
// fires on. A DELIVERY order that outruns the shelf leaves units genuinely
// owed: the customer is waiting and somebody has to make or re-order them. A
// COUNTER SALE does not. The goods left in the customer's hand and the money is
// in the till; what the negative says is that the RECORD was wrong — there were
// three more on that shelf than the system believed.
//
// It matters which one it says, because the two have opposite remedies. "Units
// are owed" sends somebody to re-order stock that is not missing. "The count was
// wrong" sends them to recount a shelf, which is the actual repair.
//
// AND THE TILL IS THE PATH THAT FIRES. A bought-in product is `strict` by
// default, and the hard out-of-stock gate in POST /orders refuses a strict line
// at checkout — so the mini app and the web store cannot ordinarily reach here
// at all. The counter till has no such gate, correctly: a walk-in holding the
// item can never be refused because a row disagrees with the room. So the
// wording that was wrong was the wording almost every alert would carry.
function belowZeroText({ channel, fulfilment, orderNo, storeName, lines = [] }) {
  if (!lines.length) return null;
  const isCounter = fulfilment === 'counter';
  const key = isCounter ? 'counter' : (channel || 'wechat');
  const [cnCh, enCh] = OWN_CHANNEL_LABEL[key] || OWN_CHANNEL_LABEL.wechat;
  const where = `${cnCh} ${storeName || ''}`.trim();
  const whereEn = `${enCh} ${storeName || ''}`.trim();
  // EACH HALF NAMES THE PRODUCT IN ITS OWN LANGUAGE. alertText above falls back
  // to English on both sides because its names arrive from a platform payload
  // and there is no Chinese copy to prefer. These are our own products and both
  // names are stored, so the 中文 line reads 青辣椒酱 where the English one reads
  // Zhoug — the same rule cuT() applies on every screen.
  const cnName = (l) => l.name || l.nameEn || '?';
  const enName = (l) => l.nameEn || l.name || '?';
  // The half that differs. Everything else about the alert is identical, which
  // is the point: one alert, one shape, and the clause that names the cause.
  const cnWhy = isCounter ? '可能是数错了' : '有客户订单等待';
  // The leading space/comma belongs to the clause, not the template — otherwise
  // the comma variant renders as "below zero , so".
  const enWhy = isCounter
    ? ', which nearly always means a miscount'
    : ', so customers are waiting on items we do not have';
  // And the one thing to go and do about it, as its own sentence rather than a
  // third clause: an alert read on a phone is acted on from its last line.
  const enDo = isCounter ? 'Recount the shelf.' : 'Make or re-order them.';
  const cn = `${lines.length} 项商品库存已为负数,${cnWhy}:`
    + lines.map((l) => `${cnName(l)} 剩余 ${l.balance}`).join('、');
  const en = `stock has gone below zero${enWhy}: `
    + lines.map((l) => `${enName(l)} ${l.balance}`).join('; ');
  return `🟠 ${where} 订单 ${orderNo || '?'}:${cn}。请检查\n`
       + `${whereEn} order ${orderNo || '?'} — ${en}. ${enDo}`;
}

// Send it. NEVER THROWS and never blocks, under the same rule notifyStockGaps
// states at length: this runs inside the write that records a real sale, and an
// alerting problem must not be able to cost us the sale.
function notifyShelfBelowZero(opts) {
  try {
    const text = belowZeroText(opts || {});
    if (!text) return null;
    const { alertMerchant } = require('./ops-alert');
    const { ROOTS_TENANT_ID } = require('./tenant-db');
    Promise.resolve(alertMerchant(ROOTS_TENANT_ID, text))
      .catch((e) => console.error('[channel-line-report] below-zero alert delivery failed:', e && e.message));
    return text;
  } catch (e) {
    console.error('[channel-line-report] notifyShelfBelowZero failed:', e && e.message);
    return null;
  }
}

module.exports = {
  isOptionLine, classifyLines, alertText, notifyStockGaps,
  belowZeroText, notifyShelfBelowZero,
};
