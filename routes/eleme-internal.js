// Internal-only API for the eleme-daemon process.
// Localhost + X-Internal-Secret only. Mounted at /api/internal/eleme in server.js.
// Mirrors meituan-internal: ingest a parsed Eleme order, create a retail_order
// (channel='eleme') and deduct stock via the ledgered adjuster (which re-pushes
// the corrected number back to every channel, including Eleme itself).
//
// Carries the full Tier 0/1 field set the browser now collects: real line prices,
// Eleme's own order time and status label, delivery ETA, the 预订单 window, the
// customer's note and cutlery answer. Before this, every mirrored Eleme order was
// stamped with the import time and had ¥0 on every line.
//
// Cancel/refund RESTOCK is here too, with the same guards meituan-internal grew:
// only a CONFIRMED void returns stock (a refund *request* the merchant may still
// reject must not), it happens exactly once (channel_stock_restored), and a void
// that flips back to a live status re-deducts what was returned.

'use strict';

const express = require('express');
const router  = express.Router();
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db      = seam(require('../database'));
const inventory = require('../lib/inventory');
const { packUnits, packDeduct } = require('../lib/pack-units');
const { productUnitCostYuan } = require('../lib/product-cost');
const { settlementGap, describeSettlementGap } = require('../lib/channel-settlement');

const INTERNAL_SECRET = process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal';

router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

// A money field from the daemon, or null. The browser already divided by the
// money scale, so this only has to reject what isn't a usable number — an absent
// field, a string Eleme sent instead of a figure, a NaN out of a bad parse. Null
// rather than 0 on purpose: "Eleme didn't tell us" and "Eleme took nothing" are
// different facts, and only one of them is true.
function fmoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// What the LINES of this order add up to, or null when they can't be trusted to
// add up to anything: an empty basket, or one where any line arrived unpriced.
// A partially priced basket sums to less than itself, and a number that is wrong
// in an unknowable direction is worse than no number.
function itemsTotalOf(items) {
  if (!Array.isArray(items) || !items.length) return null;
  if (!items.every(it => Number(it.lineTotal) > 0)) return null;
  return Math.round(items.reduce((a, it) => a + Number(it.lineTotal), 0) * 100) / 100;
}

// Do the channel's order total and its own line items tell the same story?
// Returns null when they agree well enough, otherwise names the disagreement.
//
// Fees and discounts legitimately separate the two, so the tolerance is wide:
// ¥5 or 30% of the basket, whichever is larger, absorbs packaging, delivery and
// an ordinary promotion. What it does NOT absorb is EL20260901417897 — a ¥17.50
// total over ¥267.00 of goods — or a ×100 unit slip, which is called out by name
// because a scale bug and a discount need very different fixes and the ratio can
// tell them apart.
function totalDisagreement(channelTotal, itemsTotal) {
  const c = Number(channelTotal), i = Number(itemsTotal);
  if (!Number.isFinite(c) || !Number.isFinite(i) || i <= 0) return null;
  const gap = Math.round((i - c) * 100) / 100;
  const ratio = c > 0 ? i / c : Infinity;
  if (c > 0 && Math.abs(ratio - 100) < 1)  return { kind: 'scale_x100', gap, ratio: 100 };
  if (c > 0 && Math.abs(ratio - 0.01) < 0.0001) return { kind: 'scale_div100', gap, ratio: 0.01 };
  const tolerance = Math.max(5, i * 0.3);
  if (Math.abs(gap) <= tolerance) return null;
  return { kind: c <= 0 ? 'no_channel_total' : (gap > 0 ? 'below_items' : 'above_items'), gap, ratio: c > 0 ? Math.round(ratio * 1000) / 1000 : null };
}

// Collapse a name for fuzzy comparison (drop spec parens, spaces, punctuation).
function normName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// Map an Eleme platform status label → our internal `status`, so the order shows
// OUR lifecycle vocabulary (Paid/Preparing/Dispatched/Delivered) and lands in the
// matching Orders tab, exactly like mini-app/web orders. Eleme's own label is kept
// verbatim in channel_status for the detail drawer.
//
// A copy of routes/meituan-internal.js's function rather than a shared import —
// same reason the rest of this file is a copy: the two platforms word their
// statuses differently (Eleme says 商家已接单 / 骑手已取餐 where Meituan says 待拣货),
// and a shared list would make one channel's wording fix a risk to the other.
// Test order matters, and it differs from the Meituan twin ON PURPOSE. Meituan
// checks its 已接单 group before the rider group, so Eleme's 骑手已接单 ("a rider
// has taken the job") would classify as preparing and the floor would not know
// someone is already on the way. Here anything naming a 骑手 lands in rider_pickup
// — except a label that says the rider already HAS the order (已取餐), which is
// checked first and is a real dispatch.
function internalStatusForChannel(desc) {
  const d = String(desc || '').trim();
  if (!d) return null;
  // An order-VALIDITY flag is not a stage. Eleme's list row carries
  // `status: "VALID"` on every live order and lib/eleme-browser.js used to read
  // it as the order's label — which is why every mirrored Eleme order sat on
  // 'paid' for its whole life. The browser now looks past it, and this refuses
  // it a second time so a payload that carries nothing else can never be read
  // as a stage here either.
  //
  // INVALID is refused just as firmly: reading it as a cancel would skip the
  // stock deduction at ingest on an order that may be perfectly live, and
  // "flagged invalid" and "cancelled" are not the same claim. A flag we cannot
  // interpret must produce no claim at all.
  if (/^(valid|invalid|normal|unknown|default)$/i.test(d)) return null;
  if (/退款|退货/.test(d))                                          return 'refunded';
  if (/取消|已关闭|交易关闭/.test(d))                                return 'cancelled';
  if (/已完成|交易完成|已送达|已收货|已收餐|订单完成|已签收|妥投/.test(d)) return 'delivered';
  // Rider now HOLDS the order and is en route to the customer. Before the rider
  // bucket below, because 骑手已取餐 matches both and this is the truer one.
  if (/已取货|已取餐|已揽收|配送中|派送中|运输中/.test(d))            return 'dispatched';
  // Rider assigned and heading to the store to COLLECT — its own bucket so the
  // floor knows "someone is coming, have it ready".
  if (/骑手|到店|待取货|待取餐/.test(d))                             return 'rider_pickup';
  if (/待配送|待接单|已接单|待拣货|拣货|备货|待发货|制作|待出餐/.test(d)) return 'preparing';
  if (/配送|派送|取货/.test(d))                                      return 'dispatched';
  // The same lifecycle, worded as an ASCII enum. Eleme mixes the two: the fields
  // that carry a real stage (header.orderLatestStatus in particular) speak
  // ORDER_COMPLETED where the printed label says 已完成, so a Chinese-only reader
  // would leave exactly the orders this fix is for still sitting on Paid.
  //
  // Matched on the WORD, not against an exhaustive list of Eleme's enum values —
  // we hold three archived payloads, not a specification, so a closed list would
  // silently miss the fourth spelling. Only a pure-ASCII token reaches these arms
  // (a Chinese label has already returned above), and anything unrecognised still
  // returns null, which leaves the order exactly where it is: an enum we misread
  // as unknown costs nothing that today's behaviour doesn't already cost.
  if (/^[A-Za-z][A-Za-z0-9_\- ]*$/.test(d)) {
    const u = d.toUpperCase();
    // Unpaid is not a stage we move an order into — it is the one below 'paid',
    // and our row is only created once Eleme has taken the money.
    if (/UNPAID|TO_?PAY|PENDING_?PAY|WAIT.*PAY/.test(u))            return null;
    // A refund IN FLIGHT is not a refunded order — same rule, and the same
    // consequence if we get it wrong, as 退款中 above.
    if (/REFUND/.test(u)) {
      if (/REFUNDING|APPLY|APPLIED|REQUEST|AUDIT|PENDING|PROCESS|PART/.test(u)) return null;
      return 'refunded';
    }
    if (/CANCEL|CLOSE/.test(u))                                     return 'cancelled';
    // SIGNED and DONE are anchored to a token boundary on purpose: unanchored,
    // RIDER_AS-SIGNED and ABAN-DONE-D both read as a delivered order.
    if (/COMPLET|FINISH|DELIVERED|RECEIVED|SETTLED|(^|_)SIGNED(_|$)|(^|_)DONE(_|$)/.test(u)) return 'delivered';
    // Rider HOLDS it — before the rider bucket, exactly as 骑手已取餐 is above.
    if (/DELIVERING|SHIPPING|IN_?DELIVERY|ON_?THE_?WAY|TRANSPORT|PICKED|TAKEN/.test(u)) return 'dispatched';
    if (/RIDER|KNIGHT|COURIER|ASSIGN|GRAB|ARRIV|PICK/.test(u))      return 'rider_pickup';
    if (/PROCESSING|PREPAR|COOK|MAKING|PACK|ACCEPT|CONFIRM|UNPROCESSED/.test(u)) return 'preparing';
    return null;
  }
  return null; // 待支付 / unknown → keep 'paid'
}

// Labels that map to nothing ON PURPOSE and are therefore not worth a warning:
// an order still awaiting payment sits below 'paid' in our own lifecycle, and
// there is nothing to say about it. Everything else that maps to nothing is a
// label we are storing and cannot read, which is exactly what went unnoticed.
const UNMAPPED_BY_DESIGN = /待支付|未支付|待付款|UNPAID|TO_?PAY|PENDING_?PAY/i;

// A channel label that mapped to nothing, written to the sync log rather than
// dropped. This is the instrument the always-Paid bug did not have: "VALID" was
// read as an order's status for months and nothing anywhere said that the label
// we were storing meant nothing to us. Now the first order carrying an unreadable
// label says so, with the payload field it came out of, so the next rename is a
// log line instead of an archaeology session.
function logUnmappedStatus(storeCode, ref, desc, keyPath, isStage) {
  try {
    db.prepare(`
      INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
      VALUES (?, 'order_status_unmapped', 'warn', ?, ?)
    `).run(
      storeCode || null,
      JSON.stringify({ ref, channelStatus: desc, statusKeyPath: keyPath || null, isStage: isStage !== false }),
      `Eleme label "${desc}" maps to no internal status`
        + (keyPath ? ` (read from ${keyPath}${isStage === false ? ', not a lifecycle field' : ''})` : '')
        + ' — order left where it was',
    );
  } catch (e) { console.error('[eleme-internal] order_status_unmapped log failed:', e.message); }
}

// Stamp OUR OWN lifecycle clock when the platform's label first moves an order
// into a stage. Eleme sends no rider section, so unlike the Meituan twin — which
// fills these from one — nothing else ever writes them for a mirrored order, and
// without this an Eleme order would read "Dispatched" with an empty time beside
// it in the drawer that shows both.
//
// Fill-a-blank only: a stamped time is never rewritten, so a poll that re-reads
// the same label, or an operator's own earlier stamp, always wins. Stages with no
// column of their own (rider_pickup) write nothing.
const STATUS_STAMP_COL = { preparing: 'preparing_at', dispatched: 'dispatched_at', delivered: 'delivered_at' };
function stampLifecycle(orderId, status) {
  const col = STATUS_STAMP_COL[status];
  if (!col || !orderId) return;
  try {
    db.prepare(`UPDATE retail_orders SET ${col} = COALESCE(${col}, CURRENT_TIMESTAMP) WHERE id = ?`).run(orderId);
  } catch (e) { console.error('[eleme-internal] lifecycle stamp failed:', e.message); }
}

// Lifecycle order, used only to stop a STALE label from walking an order
// backwards: the poll trails reality, so a late-arriving 骑手已接单 must not drag
// an order our own sweeps already advanced. cancelled/refunded are exempt in both
// directions — a void is the platform's own fact and can land at any point.
const CHANNEL_STATUS_RANK = {
  pending_payment: 0, paid: 1, awaiting_restock: 1,
  preparing: 2, rider_pickup: 3, dispatched: 4, delivered: 5,
};
function isForwardChannelStatus(current, next) {
  if (!next || next === current) return true;
  if (next === 'cancelled' || next === 'refunded') return true;
  const cur = CHANNEL_STATUS_RANK[current];
  const nxt = CHANNEL_STATUS_RANK[next];
  if (cur == null || nxt == null) return true;
  return nxt > cur;
}

// Whether a label is a CONFIRMED, terminal void — the only thing that may return
// stock. A bare 退款/取消 is NOT enough: Eleme surfaces a refund or cancel REQUEST
// with those words while the order is still live, and if the merchant or platform
// rejects it the order goes on to be delivered. Restocking on the request would
// then double-count. So an explicit settled form is required and pending wording
// is excluded outright.
//
// 部分退款 is treated as NOT settled on purpose: a partial refund returns some of
// the money but we hold no per-line refund detail, so restocking the whole order
// would over-credit. It stays deducted until the order reaches a full void.
function isConfirmedVoid(desc) {
  const d = String(desc || '');
  if (!d) return false;
  if (/申请|待处理|处理中|审核|退款中|退货中|协商|部分退款/.test(d)) return false;
  return /已取消|交易取消|订单取消|已关闭|交易关闭|已退款|退款成功|退款完成|全额退款|已撤销/.test(d);
}

// The claim that says which option of a listing this line was sold as, and how
// many units of the product that option holds. One Eleme listing can sell the
// same bottle as 1瓶 / 3瓶 / 6瓶; the option name is the only thing on the line
// that tells them apart, so a line with no option name deliberately finds
// nothing here rather than guess a pack size.
function claimForLine(item, storeId) {
  const spec = normName(item.specName);
  if (!spec || !storeId) return null;
  const rows = db.prepare(`
    SELECT p.id, p.name_cn, p.name_en, m.eleme_name, m.spec_name, m.units_per_pack
      FROM eleme_product_map m
      JOIN store_products p ON p.id = m.product_id
     WHERE m.retail_store_id = ? AND m.spec_key <> '' AND m.spec_name IS NOT NULL
  `).all(storeId);
  if (!rows.length) return null;
  const listing = normName(item.name);
  // The option name has to match exactly; the listing name only has to be
  // consistent, because Eleme trims and re-pads it on the order line.
  const cands = rows.filter(r => {
    if (normName(r.spec_name) !== spec) return false;
    if (!listing) return true;
    const mn = normName(r.eleme_name);
    return !mn || mn === listing || mn.includes(listing) || listing.includes(mn);
  });
  return cands.length === 1 ? cands[0] : null;
}

// How many units one of this product takes off the shelf when the option it was
// sold as is unknown. Only answerable when the product holds exactly ONE claim —
// with several (a multipack) the line could be any of them, and 1 is the only
// value that can't over-deduct. The caller says so in the match reason.
function fallbackUnits(storeId, productId) {
  try {
    const rows = db.prepare(
      'SELECT units_per_pack FROM eleme_product_map WHERE retail_store_id = ? AND product_id = ?'
    ).all(storeId, productId);
    if (rows.length === 1) return { units: packUnits(rows[0].units_per_pack), sure: true };
    return { units: 1, sure: rows.every(r => packUnits(r.units_per_pack) === 1) };
  } catch (_) { return { units: 1, sure: true }; }
}

// Resolve one Eleme line item to a store_product. Order, most reliable first:
//   0. a claimed option (the only path that knows the line's pack size)
//   1. 货号 / extendCode → store_products.sku
//   2. eleme_product_map by Eleme listing name (per store)
//   3. unique active name match (CJK then English)
//
// MATCHING ONLY — the cost snapshot is stamped by resolveProduct() below, which
// wraps this, so the four branches here stay purely about identifying the
// product and the cost is read once off whichever id they settle on.
function matchProductForLine(item, storeId) {
  const qty = parseInt(item.qty, 10) || 0;
  // Line money now arrives from the channel (Tier 0/1) — carry it through the
  // resolver so a matched AND an unmatched line both keep their real price.
  const unit = Number(item.unitPrice);
  const line = Number(item.lineTotal);
  const out = {
    name: item.name, sku: item.sku || null, qty, productId: null,
    nameCn: item.name, nameEn: item.name, matchBy: null,
    unitPrice: Number.isFinite(unit) ? unit : (Number.isFinite(line) && qty > 0 ? line / qty : null),
    lineTotal: Number.isFinite(line) ? line : (Number.isFinite(unit) ? unit * qty : null),
    specName: item.specName || null,
    // How many units of the product this line took, per unit sold. 1 unless the
    // option it was sold as is a pack.
    units: 1,
  };
  const apply = (p, by) => { out.productId = p.id; out.nameCn = p.name_cn; out.nameEn = p.name_en; out.matchBy = by; };

  // 0. The option this line names, claimed by exactly one product. Ahead of the
  // 货号 path on purpose: a pack option's code is a variant of the base one, and
  // resolving on the code alone loses which pack it was.
  const claim = claimForLine(item, storeId);
  if (claim) { apply(claim, 'claim'); out.units = packUnits(claim.units_per_pack); return out; }

  if (item.sku) {
    const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(item.sku)
           || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(item.sku);
    if (p) { apply(p, 'sku'); return withFallbackUnits(out, storeId); }
    out.matchBy = 'sku_unknown';
  }

  if (storeId) {
    const wanted = normName(item.name);
    if (wanted) {
      const rows = db.prepare(`
        SELECT p.id, p.name_cn, p.name_en, m.eleme_name
          FROM eleme_product_map m
          JOIN store_products p ON p.id = m.product_id
         WHERE m.retail_store_id = ? AND p.is_active = 1 AND m.eleme_name IS NOT NULL
      `).all(storeId);
      let hit = rows.find(r => normName(r.eleme_name) === wanted);
      if (!hit) {
        const cands = rows.filter(r => {
          const mn = normName(r.eleme_name);
          return mn && (mn.includes(wanted) || wanted.includes(mn));
        });
        if (cands.length === 1) hit = cands[0];
      }
      if (hit) { apply(hit, 'map'); return withFallbackUnits(out, storeId); }
    }
  }

  const clean = String(item.name || '').replace(/\([^)]*\)/g, ' ').trim();
  const cjk = (clean.match(/[一-鿿]+/) || [])[0];
  const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
  let matches = [];
  if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
  if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
  if (matches.length === 1) { apply(matches[0], 'name'); }
  else if (!out.matchBy || out.matchBy === 'sku_unknown') out.matchBy = matches.length > 1 ? 'ambiguous' : 'unmatched';
  return withFallbackUnits(out, storeId);
}

// Applied to every non-claim path: a product with one claim lends its pack size,
// a product with several can't (the line didn't say which option), and that case
// is named so it shows up in the unsynced log rather than deducting quietly.
function withFallbackUnits(out, storeId) {
  if (!out.productId || !storeId) return out;
  const { units, sure } = fallbackUnits(storeId, out.productId);
  out.units = units;
  if (!sure) out.matchBy = (out.matchBy || 'matched') + '+pack_unknown';
  return out;
}

// Match the line, then stamp what one unit of it cost us — the figure the order
// INSERT writes into retail_order_items.unit_cost_at_sale. The Eleme twin of
// meituan-internal's wrapper, and deliberately a separate copy: these two
// resolvers have always been parallel implementations rather than one shared
// one, and merging them is a bigger change than this.
//
// ONE LOOKUP, AT THE END, on whatever id the branches settled on — never one
// per branch. An UNMATCHED line (ambiguous or unmapped, kept as an order row and
// surfaced as `unresolved`) has no product to price, so it lands NULL rather
// than a guess or a zero. PER UNIT: `units` carries the pack size into the row's
// own pack_units column, so the two multiply at read time instead of here.
//
// NEVER THROWS — this runs inside the ingest that records a real order.
function resolveProduct(item, storeId) {
  const out = matchProductForLine(item, storeId);
  out.unitCostAtSale = null;
  if (out.productId) {
    try {
      out.unitCostAtSale = productUnitCostYuan(db, out.productId);
    } catch (e) {
      console.error('[eleme-internal] cost snapshot failed for product', out.productId, e && e.message);
    }
  }
  return out;
}

// POST /api/internal/eleme/ingest-order
router.post('/ingest-order', (req, res) => {
  const { storeId, storeCode, order } = req.body || {};
  if (!storeId || !order) return res.status(400).json({ error: 'storeId and order required' });

  try {
    const now      = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand     = Math.floor(Math.random() * 900000) + 100000;
    const orderNo  = `EL${datePart}${rand}`;
    const ref      = order.elemeOrderId || orderNo;

    const items = (order.items || []).map(it => resolveProduct(it, storeId)).filter(i => i.qty > 0);
    // TWO readings of this order's money, and they are not interchangeable.
    //
    //   channelTotal — the single figure Eleme's payload put on the order, read
    //     by candidate key (lib/eleme-browser.js TOTAL_KEYS). It is what we
    //     believe the customer was charged, and `total` is the refund ceiling
    //     (routes/retail.js orderTenders), so it is never invented here.
    //   itemsTotal — what the order's own priced lines add up to. This is the
    //     value of the GOODS, which is what `subtotal` has always meant on every
    //     other order in this table.
    //
    // Until now `subtotal` was assigned channelTotal — the two columns held one
    // number twice — and the admin drawer printed it under a "subtotal" label
    // beside a list of items that added up to something else entirely. That is
    // EL20260901417897: a ¥17.50 banner over ¥38 + ¥29 + ¥200 of goods, with
    // nothing in the row, the log or the import archive recording that the two
    // figures had ever disagreed. Now subtotal is the goods (when every line is
    // priced), total stays the platform's own claim, and a disagreement between
    // them is written to the sync log instead of being averaged away.
    const channelTotal = parseFloat(order.total) || 0;
    // The parser computes this too; recomputing from the resolved lines means a
    // caller that predates the field still gets the fix, and the number always
    // matches the rows this ingest is about to write.
    const itemsTotal = itemsTotalOf(items);
    const subtotal   = itemsTotal != null ? itemsTotal : channelTotal;
    // A missing/zero platform total with priced lines is the one case where the
    // lines DO decide `total`: 0 is not a claim about what was charged, it is the
    // absence of one, and an order that reads ¥0.00 can be neither reported nor
    // refunded. Any non-zero platform figure is left exactly as it came.
    const total = channelTotal > 0 ? channelTotal : (itemsTotal != null ? itemsTotal : 0);
    const moneyGap = totalDisagreement(channelTotal, itemsTotal);

    // Platform-owned facts (Tier 0). Each is null when Eleme didn't give us one,
    // and every write below COALESCEs, so a missing field leaves the old
    // behaviour rather than blanking a column.
    const channelStatus = (order.statusDesc && String(order.statusDesc).trim()) || null;
    const channelEta    = (order.eta && String(order.eta).trim()) || null;
    const preOrderAt    = (order.preOrderAt && String(order.preOrderAt).trim()) || null;
    // Eleme's own order time beats our import time: the poll runs every ~5 min, so
    // CURRENT_TIMESTAMP is always late and near midnight lands on the wrong day.
    const placedAt      = (order.placedAt && String(order.placedAt).trim()) || null;
    const customerNote  = (order.note && String(order.note).trim()) || null;
    const needsCutlery  = order.needsCutlery ? 1 : 0;
    const mappedStatus  = internalStatusForChannel(channelStatus);
    const internalStatus = mappedStatus || 'paid';
    // Eleme told us where the order is and we could not read it — say so once,
    // here, rather than letting the order quietly land on 'paid' and stay there.
    if (channelStatus && !mappedStatus && !UNMAPPED_BY_DESIGN.test(channelStatus)) {
      logUnmappedStatus(storeCode, ref, channelStatus, order.statusKeyPath, order.statusIsStage);
    }
    // An order whose FIRST sighting is already void never had stock deducted here,
    // and this build has no restock path to give it back (see the header). Deducting
    // now would drift the count low permanently and then under-report that number to
    // every other channel on the next push. Record the order, skip the deduction.
    const bornVoid = internalStatus === 'cancelled' || internalStatus === 'refunded';
    // 打包费 and 配送费, into the two columns Meituan already fills. They are
    // ADDENDS to `subtotal`, and that is exactly why they belong here: since
    // 67fc00a subtotal is itemsTotal — the GOODS the priced lines agree on, with
    // no packaging and no delivery inside it — so writing the fees beside it adds
    // money the row was missing rather than re-adding money it already had.
    // Eleme's own payload does the same addition, to the cent, on both live
    // orders we hold:
    //   EL20260901417897  267 + 1.5 + 18 - 17.5 discount = 269 = customerPaidInfo.total
    //   EL20260831339491  135 + 1.5 + 18 - 13.5 discount = 141 = customerPaidInfo.total
    // (An earlier comment here declined the write on the opposite premise — that
    // subtotal held the platform total. It was rewritten by 67fc00a, the very
    // commit that stopped that being true, and kept a conclusion its own new
    // premise contradicted.)
    //
    // NOT the goods figure, and neither is a candidate for one:
    //   • settlementInfo.subTotalFeeInfo.total is not a subtotal despite the
    //     name — it equals customerPaidInfo.total.
    //   • foodInfo.groups[].items[].total already carries PER-FOOD packaging
    //     (Eleme prices 打包费 per item as well as per order, see
    //     lib/eleme-browser.js), so the item totals are not packaging-free.
    // Our stored line_total is the packaging-free figure, and it is what subtotal
    // sums; the per-ORDER packageFee below is what is missing from it.
    //
    // COALESCE(?, 0) like Meituan: a platform that sent no figure leaves the
    // column at the 0 the schema default gave it anyway. 0 is the honest reading
    // for a fee — "no packaging was charged" — where it would not be for the
    // commission below.
    const packingFee  = fmoney(order.packagingFee);
    const shippingFee = fmoney(order.deliveryFee);

    // The two that DO get columns: what Eleme keeps (服务费) and what actually
    // lands with us (商家实收). Same pair, same meaning, same columns Meituan
    // already fills — a reader asking "what did this channel cost us" now gets
    // one answer for both channels instead of having to parse Eleme's JSON.
    // Both stay NULL when the platform didn't give us a number: 0 would read as
    // "commission-free", which is a claim we can't make.
    const commission   = fmoney(order.commission);
    const settleAmount = fmoney(order.merchantIncome);

    // 商家活动补贴 — the SHOP's own promotion, out of our margin, into the
    // customer's price. settlementInfo.merchantActivityInfo.total, already read
    // by lib/eleme-browser.js (SHOP_DISC_PATHS) and until now thrown away here:
    // the ingest never looked at order.shopDiscount and no column held it.
    //
    // It is the missing term in the row's own arithmetic. Since 67fc00a subtotal
    // has been the GOODS, with the two fees beside it rather than inside it, so
    // what the customer paid reads
    //   subtotal + packing + shipping - discount
    // and on both live orders that identity only closes with the discount in it:
    //   EL20260901417897  267 + 1.5 + 18 - 17.5 = 269 = customerPaidInfo.total
    //   EL20260831339491  135 + 1.5 + 18 - 13.5 = 141 = customerPaidInfo.total
    // Without this write the four columns add up to MORE than `total` and there
    // is nothing on the row to say why — the discount is folded into Eleme's own
    // total and was, until here, recorded nowhere at all.
    //
    // NULL, not COALESCE(?, 0), and deliberately unlike packing_fee/shipping_fee
    // two lines up. A fee of 0 is a fact ("nothing was charged to pack it"); a
    // discount of 0 would be the claim "this order carried no promotion", which
    // a payload that simply didn't mention one does not support. Same discipline
    // as channel_commission above, the same column and the same NULL rule Meituan
    // already uses for all three (routes/meituan-internal.js writes commission,
    // settle and discount as plain `?`). Readers treat NULL as absent, not zero.
    const shopDiscount = fmoney(order.shopDiscount);

    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method, subtotal, total,
          store_id, channel, fulfillment_type, placed_at, paid_at,
          channel_status, channel_status_at, channel_eta, channel_preorder_at,
          customer_note, needs_cutlery,
          shipping_fee, packing_fee,
          channel_commission, channel_settle_amount, channel_discount
        ) VALUES (?, ?, 'eleme', ?, ?, ?, 'eleme', 'delivery',
                  COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP),
                  ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?, ?,
                  ?, ?,
                  COALESCE(?, 0), COALESCE(?, 0),
                  ?, ?, ?)
      `).run(orderNo, internalStatus, subtotal, total, storeId, placedAt, placedAt,
             channelStatus, channelStatus, channelEta, preOrderAt, customerNote, needsCutlery,
             shippingFee, packingFee,
             commission, settleAmount, shopDiscount);
      const oid = r.lastInsertRowid;
      // channel_stock_restored means exactly "this order's stock is NOT currently
      // deducted from our count". A born-void order never had its stock taken, so
      // it starts in that state — which is what makes the re-deduct branch in
      // /update-order-status correct if Eleme later revives the order.
      if (bornVoid) db.prepare('UPDATE retail_orders SET channel_stock_restored = 1 WHERE id = ?').run(oid);
      for (const it of items) {
        // Real line money now, not 0/0 — and the channel's own SKU token is kept
        // even on an UNMATCHED line, which has no store_products row to read one
        // from later.
        db.prepare(`
          INSERT INTO retail_order_items
            (order_id, product_id, name_cn, name_en, sku, qty, unit_price, line_total, pack_units,
             unit_cost_at_sale)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(oid, it.productId, it.nameCn, it.nameEn, it.sku || null, it.qty,
               it.unitPrice != null ? it.unitPrice : 0,
               it.lineTotal != null ? it.lineTotal : 0,
               packUnits(it.units),
               // Stamped by resolveProduct(). No `: 0` fallback like the two
               // money columns above — an unknown cost is NULL, because a zero
               // there would claim the goods were free.
               it.unitCostAtSale ?? null);
      }
      return oid;
    })();

    // An order can arrive already under way — the poll runs every ~5 minutes, so
    // its first sighting is often 配送中 rather than a fresh 待接单. Stamp the
    // clock for the stage it arrived in, or the drawer shows a Dispatched order
    // with no dispatch time on it.
    stampLifecycle(orderId, internalStatus);

    const unresolved = [];
    let deducted = 0;
    for (const it of bornVoid ? [] : items) {
      if (!it.productId) { unresolved.push({ name: it.name, sku: it.sku, qty: it.qty, reason: it.matchBy }); continue; }
      const cur  = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, it.productId);
      const oldQ = cur ? cur.physical_qty : 0;
      // One six-pack is one line of one, and six off the shelf.
      const took = packDeduct(it.qty, it.units);
      inventory.adjustStock({
        storeId, productId: it.productId,
        newPhysicalQty: Math.max(0, oldQ - took),
        actorLabel: 'Eleme order',
        reason: 'eleme_order',
        note: `Eleme ${ref}${order.daySeq != null ? ` #${order.daySeq}` : ''} — ${it.nameEn} x${it.qty}` +
              (took !== it.qty ? ` (${took} units)` : ''),
      });
      deducted++;
    }

    if (unresolved.length) {
      try {
        const matched = items.filter(i => i.productId).map(i => ({ name: i.name, sku: i.sku, qty: i.qty, by: i.matchBy }));
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_unsynced', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, deducted, matched, unresolved }),
          `${unresolved.length} item(s) not synced: ` +
            unresolved.map(u => `${u.name}${u.sku ? ` (${u.sku})` : ''} x${u.qty} [${u.reason}]`).join('; ')
        );
      } catch (logErr) { console.error('[eleme-internal] order_unsynced log failed:', logErr.message); }
    }

    // The order's own two money readings disagree by more than fees and a
    // promotion can explain. NOT an error and never a reason to reject the order
    // — Eleme's figure may well be right and the basket heavily discounted — but
    // it is the one fact that has to survive the ingest, because the admin drawer
    // shows both numbers and someone will have to decide which is true. The log
    // row carries the field the total was read out of (totalKeyPath), which is
    // what settles a wrong-key read without re-reading the order off the platform.
    if (moneyGap) {
      try {
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_total_mismatch', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({
            ref, orderNo, kind: moneyGap.kind, channelTotal, itemsTotal,
            gap: moneyGap.gap, ratio: moneyGap.ratio,
            totalKeyPath: order.totalKeyPath || null,
            moneyDivisor: order.moneyDivisor != null ? order.moneyDivisor : null,
            lines: items.map(i => ({ name: i.nameEn || i.name, qty: i.qty, lineTotal: i.lineTotal })),
          }),
          `channel total ¥${channelTotal.toFixed(2)} vs items ¥${Number(itemsTotal).toFixed(2)}` +
            ` (${moneyGap.kind}${order.totalKeyPath ? `, total read from "${order.totalKeyPath}"` : ''})`
        );
      } catch (logErr) { console.error('[eleme-internal] order_total_mismatch log failed:', logErr.message); }
    }

    // The SECOND money question, and a different one from moneyGap above.
    // moneyGap asks whether the platform's total and our line items tell the same
    // story; this asks whether the four columns the Settlement panel prints add
    // up to the total it prints them under:
    //
    //     subtotal + packing + delivery - discount = total
    //
    // The panel has refused to show a commission or an income figure over an
    // unreconciled total since PR #206, which is right, but it said so only in
    // the drawer and only as "Breakdown incomplete" — no components, no gap, no
    // record anywhere that an order had come in that way. EL20260903163199 sat
    // like that from ingest until somebody opened it and asked why, by which
    // point the answer needed the archived payload.
    //
    // So the check runs HERE, against exactly what the INSERT above wrote (fees
    // COALESCEd to 0, discount left NULL), while the payload that produced it is
    // still in the request. Warn, never reject: an order that doesn't reconcile
    // is still a real order the customer placed, and refusing it would lose money
    // we do hold over money we don't.
    //
    // This records the order AS IT ARRIVED, and some of these heal: the discount
    // and the economics are blank-filled by /update-order-status on a later poll
    // (see the COALESCE group there), so a row logged here can reconcile an hour
    // later and the log entry stays behind describing a state that no longer
    // exists. That is the intended division — this log answers "what did the
    // platform send us", scripts/diagnose_channel_settlement.js reads the live
    // rows and answers "what is still wrong now". Don't read a warn row here as
    // a standing fault without checking the order.
    const settleGap = settlementGap({
      subtotal, total,
      packing_fee:      packingFee  != null ? packingFee  : 0,
      shipping_fee:     shippingFee != null ? shippingFee : 0,
      channel_discount: shopDiscount,
    });
    if (settleGap) {
      try {
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_settlement_mismatch', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({
            ref, orderNo, ...settleGap,
            // WHICH FIELD each figure was read out of. Without this the three
            // faults that produce an identical gap — a fee the customer was
            // never charged, a discount bigger than the term we capture, and a
            // total read off a delivery-free key — are indistinguishable, which
            // is the exact position EL20260903163199 left us in. The parser has
            // always known the paths (lib/eleme-browser.js pickMoney returns
            // one with every value); until now only the total's survived.
            keyPaths: order.moneyKeyPaths || { total: order.totalKeyPath || null },
            moneyDivisor: order.moneyDivisor != null ? order.moneyDivisor : null,
            commission: commission, settleAmount: settleAmount,
          }),
          describeSettlementGap(settleGap)
        );
      } catch (logErr) { console.error('[eleme-internal] order_settlement_mismatch log failed:', logErr.message); }
    }

    // Visible in the admin's Eleme log rather than only in the response body —
    // "stock deliberately not deducted" is exactly the kind of silent decision that
    // looks like a bug six weeks later.
    if (bornVoid) {
      try {
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_born_void', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, channelStatus, items: items.length }),
          `order first seen as "${channelStatus}" — recorded without deducting stock`
        );
      } catch (logErr) { console.error('[eleme-internal] order_born_void log failed:', logErr.message); }
    }

    res.json({ ok: true, orderId, orderNo, items: items.length, deducted, unresolved, bornVoid,
                subtotal, total, itemsTotal, channelTotal, moneyGap: moneyGap || null,
                settlementGap: settleGap || null });
  } catch (err) {
    console.error('[eleme-internal] ingest-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/eleme/update-order-status
// Later polls re-read the same order as it moves 待接单 → 配送中 → 已完成, so this
// keeps the mirrored row current. Idempotent: writes only when something actually
// changed, and returns { changed }.
//
// Also backfills the platform-owned facts an EARLIER import may not have carried
// (a row mirrored before this build parsed them), so old orders heal themselves on
// the next poll instead of needing a hand-written UPDATE. Both backfills are
// one-way on purpose: the note only fills when blank, and placed_at only ever
// moves EARLIER — our import stamp is by definition later than the real order
// time, so an earlier platform time is always the truer one and a correct row can
// never be dragged forward.
router.post('/update-order-status', (req, res) => {
  const { elemeOrderId, statusDesc, statusKeyPath, statusIsStage,
          eta, preOrderAt, note, needsCutlery, placedAt,
          merchantIncome, commission, shopDiscount } = req.body || {};
  const desc   = (statusDesc && String(statusDesc).trim()) || null;
  const etaVal = (eta && String(eta).trim()) || null;
  if (!elemeOrderId || !desc) return res.status(400).json({ error: 'elemeOrderId and statusDesc required' });

  try {
    const imp = db.prepare(
      'SELECT retail_order_id FROM eleme_order_import WHERE eleme_order_id = ?'
    ).get(String(elemeOrderId));
    if (!imp || !imp.retail_order_id) return res.json({ ok: true, changed: false, reason: 'not_mirrored' });

    // Snapshot BEFORE advancing: the restock below keys off the PREVIOUS state,
    // which is what makes it idempotent under a repeating poll.
    const prev = db.prepare(
      'SELECT status, channel_status, store_id, channel_stock_restored FROM retail_orders WHERE id = ?'
    ).get(imp.retail_order_id);
    const internal = internalStatusForChannel(desc);
    // channel_status is ALWAYS written (the drawer shows Eleme's exact label);
    // only our own status is held back when the label would walk it backwards.
    const statusWrite = isForwardChannelStatus(prev && prev.status, internal) ? internal : null;

    // A label we cannot read, on an order we are already holding. Logged once per
    // CHANGE of label — never on every poll, or the signal drowns in the repeat
    // of itself, which is most of why the "VALID" years were quiet.
    const unreadable = internal === null && !!desc
                       && String(prev && prev.channel_status || '') !== desc
                       && !UNMAPPED_BY_DESIGN.test(desc);

    const r = db.prepare(`
      UPDATE retail_orders
         SET channel_status = ?, channel_status_at = CURRENT_TIMESTAMP,
             status = COALESCE(?, status),
             channel_eta = COALESCE(?, channel_eta)
       WHERE id = ?
         AND (COALESCE(channel_status,'') != ?
              OR status != COALESCE(?, status)
              OR (? IS NOT NULL AND COALESCE(channel_eta,'') != ?))
    `).run(desc, statusWrite, etaVal, imp.retail_order_id, desc, statusWrite, etaVal, etaVal);

    // Our own clock for the stage the platform just moved it into. Only for a
    // status that actually got written — a label held back for walking the order
    // backwards must not stamp a time either — and fill-a-blank inside, so a
    // repeat poll writes nothing and a row that predates this heals once.
    if (statusWrite) stampLifecycle(imp.retail_order_id, statusWrite);
    if (unreadable) logUnmappedStatus(null, String(elemeOrderId), desc, statusKeyPath, statusIsStage);

    const noteVal    = (note && String(note).trim()) || null;
    const preVal     = (preOrderAt && String(preOrderAt).trim()) || null;
    const placedVal  = (placedAt && String(placedAt).trim()) || null;
    const cutleryVal = needsCutlery == null ? null : (needsCutlery ? 1 : 0);
    // The economics fill blanks only. An order mirrored before this build parsed
    // them heals on the next poll that sees the figures; one that already has a
    // number keeps it, because the import-time read is the one taken beside the
    // money scale we recorded — a later poll must not overwrite it with a
    // differently-scaled figure.
    const commissionVal = fmoney(commission);
    const settleVal     = fmoney(merchantIncome);
    // channel_discount joins the same blank-fill group, for the same reason and
    // under the same rule: an order mirrored before the ingest wrote it heals on
    // the next poll that still sees it, and one that already has a figure keeps
    // it. Leaving the discount out while its two neighbours are in would mean a
    // row could heal its commission and not the term that makes its own total
    // add up. (It heals only orders the list still returns — a delivered order
    // that has aged off it is what the backfill script is for.)
    const discountVal   = fmoney(shopDiscount);
    db.prepare(`
      UPDATE retail_orders
         SET channel_preorder_at = COALESCE(?, channel_preorder_at),
             customer_note = CASE WHEN COALESCE(customer_note,'') = '' THEN COALESCE(?, customer_note) ELSE customer_note END,
             needs_cutlery = COALESCE(?, needs_cutlery),
             channel_commission    = COALESCE(channel_commission, ?),
             channel_settle_amount = COALESCE(channel_settle_amount, ?),
             channel_discount      = COALESCE(channel_discount, ?),
             placed_at = CASE WHEN ? IS NOT NULL AND ? < placed_at THEN ? ELSE placed_at END,
             paid_at   = CASE WHEN ? IS NOT NULL AND ? < paid_at   THEN ? ELSE paid_at   END
       WHERE id = ?
    `).run(preVal, noteVal, cutleryVal,
           commissionVal, settleVal, discountVal,
           placedVal, placedVal, placedVal,
           placedVal, placedVal, placedVal,
           imp.retail_order_id);

    // ── Stock, on a void and on a revival ────────────────────────────────────
    // Eleme voided the order → give the stock back. Ingest deducted it (ledgered)
    // and nothing else ever returns it, so without this every cancel drifts our
    // count low — which then under-reports to Eleme and every other channel on the
    // next push. Runs only on the TRANSITION, so a poll that re-reads the same
    // 已取消 label can never restock twice.
    let restocked = 0, rededucted = 0;
    const confirmedVoid   = isConfirmedVoid(desc);
    const alreadyRestored = !!prev && prev.channel_stock_restored === 1;
    const orderLines = () => db.prepare(
      `SELECT product_id, name_en, qty, COALESCE(pack_units, 1) AS pack_units
         FROM retail_order_items WHERE order_id = ? AND product_id IS NOT NULL`
    ).all(imp.retail_order_id);
    const stockOf = (pid) => {
      const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
        .get(prev.store_id, pid);
      return cur ? cur.physical_qty : 0;
    };

    if (prev && confirmedVoid && !alreadyRestored) {
      // Truly voided → return the deducted stock, exactly once. Best-effort: a
      // restock failure must not fail the status write, or the order would stick
      // on a stale label and never be retried.
      try {
        for (const it of orderLines()) {
          inventory.adjustStock({
            storeId: prev.store_id, productId: it.product_id,
            newPhysicalQty: stockOf(it.product_id) + packDeduct(it.qty, it.pack_units),
            actorLabel: 'Eleme cancel',
            reason: 'eleme_cancel',
            note: `Eleme ${String(elemeOrderId)} ${internal || 'void'} — restored ${it.name_en} x${it.qty}`,
          });
          restocked++;
        }
        db.prepare('UPDATE retail_orders SET channel_stock_restored = 1 WHERE id = ?').run(imp.retail_order_id);
      } catch (e) {
        console.error('[eleme-internal] restock on cancel failed:', e.message);
      }
    } else if (prev && alreadyRestored && !confirmedVoid) {
      // Stock is out of our count for an order that has since gone live again —
      // the refund was rejected, the rider picked it up, or it was born void and
      // Eleme revived it. Re-deduct so we don't over-report stock we no longer have.
      try {
        for (const it of orderLines()) {
          inventory.adjustStock({
            storeId: prev.store_id, productId: it.product_id,
            newPhysicalQty: Math.max(0, stockOf(it.product_id) - packDeduct(it.qty, it.pack_units)),
            actorLabel: 'Eleme uncancel',
            reason: 'eleme_uncancel',
            note: `Eleme ${String(elemeOrderId)} back to ${desc} — re-deducted ${it.name_en} x${it.qty}`,
          });
          rededucted++;
        }
        db.prepare('UPDATE retail_orders SET channel_stock_restored = 0 WHERE id = ?').run(imp.retail_order_id);
      } catch (e) {
        console.error('[eleme-internal] re-deduct on uncancel failed:', e.message);
      }
    }

    if (restocked || rededucted) {
      try {
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, ?, 'ok', ?, NULL)
        `).run(null, restocked ? 'order_restocked' : 'order_rededucted',
          JSON.stringify({ elemeOrderId: String(elemeOrderId), statusDesc: desc, restocked, rededucted }));
      } catch (logErr) { console.error('[eleme-internal] restock log failed:', logErr.message); }
    }

    res.json({
      ok: true, changed: r.changes > 0, restocked, rededucted,
      status: statusWrite || (prev && prev.status) || null,
    });
  } catch (err) {
    console.error('[eleme-internal] update-order-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/eleme/auto-deliver-past-eta
// The twin of routes/meituan-internal.js's endpoint of the same name, for the
// same failure and with the same rule — and Eleme needs it more, not less.
//
// Eleme's order poll reads the IN-PROGRESS tab. An order that completes drops out
// of that list, so the last label we ever see is usually the one it had while
// still moving (配送中), and nothing afterwards can advance it: the refresh only
// touches orders the list still returns, and the refund/exception queue only
// carries voids. Left alone, every Eleme order would now stall on Dispatched
// instead of Paid — a better place to stall, and still a stall.
//
// So: an order still non-terminal an hour past the ETA Eleme itself promised is
// treated as delivered. channel_eta is stored UTC (lib/eleme-browser.js
// toUtcStamp) and CURRENT_TIMESTAMP is UTC, so the comparison is UTC on both
// sides. Idempotent — delivered is terminal, and a real 已完成 label arriving
// first simply gets here first.
//
// delivered_at is deliberately NOT stamped: this is a timer's inference, not a
// platform fact, and public/retail-admin/04-orders.js already treats a past-ETA
// flip as the guess it is. A stamped time would present it as an observation.
router.post('/auto-deliver-past-eta', (_req, res) => {
  try {
    const r = db.prepare(`
      UPDATE retail_orders
         SET status = 'delivered'
       WHERE channel = 'eleme'
         AND status IN ('paid','preparing','rider_pickup','dispatched')
         AND channel_eta IS NOT NULL AND channel_eta != ''
         AND datetime(channel_eta, '+1 hour') <= datetime('now')
    `).run();
    res.json({ ok: true, delivered: r.changes });
  } catch (err) {
    console.error('[eleme-internal] auto-deliver-past-eta error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
