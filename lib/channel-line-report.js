'use strict';

// What a channel order line's stock problems are, and how to say them out loud.
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
    en.push(`${unresolved.length} item(s) matched no product, so their stock was NOT deducted: ` +
            unresolved.map(i => `${nameOf(i)} x${i.qty}`).join('; '));
  }
  if (oversold.length) {
    cn.push(`${oversold.length} 项库存不足,已按 0 计:` +
            oversold.map(o => `${nameOf(o)} 需要 ${o.want},剩余 ${o.have}`).join('、'));
    en.push(`${oversold.length} line(s) exceeded on-hand and were clamped at 0: ` +
            oversold.map(o => `${nameOf(o)} wanted ${o.want}, had ${o.have}`).join('; '));
  }
  return `🟠 ${where} 订单 ${orderNo}:${cn.join(';')}。请检查\n` +
         `${whereEn} order ${orderNo} — ${en.join('; ')}. Please check.`;
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

module.exports = { isOptionLine, classifyLines, alertText, notifyStockGaps };
