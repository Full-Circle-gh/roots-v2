// Internal-only API for the meituan-daemon process.
// Only accepts requests from 127.0.0.1 with the correct X-Internal-Secret header.
// Mounted at /api/internal/meituan in server.js.

'use strict';

const express = require('express');
const router  = express.Router();
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db      = seam(require('../database'));
const inventory = require('../lib/inventory');

const INTERNAL_SECRET = process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal';

// Guard: localhost only + secret header
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

// Collapse a name for comparison: drop spec parens, whitespace, punctuation and
// case so "巧克力榛棒 Premium Nutella Bars" and its map entry compare equal even
// across the CN/EN word order and stray spacing Meituan inserts.
function normName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')          // (300ml), (1-300) specs
    .replace(/[\s　]+/g, '')          // all spaces incl. full-width
    .replace(/[^\p{L}\p{N}]/gu, '')       // punctuation/symbols
    .toLowerCase();
}

// Resolve one parsed Meituan line-item to a store_product.
//
// Resolution order, most reliable first:
//   1. Inline "(\d+-\d+)" SKU token the merchant encodes in the spec name.
//   2. meituan_product_map — the SAME Roots↔Meituan bridge stock-push uses. The
//      operator maps each product to its exact Meituan listing title, so when the
//      listing carries no SKU token AND its display name differs from the Roots
//      product name (e.g. Meituan "巧克力榛棒 Premium Nutella Bars" vs Roots
//      "巧克力榛果棒 / Choco-Hazel Bars"), the map is the only thing that links
//      them. Without this, such lines silently failed to deduct stock.
//   3. UNIQUE active name match (CJK core, then English) as a last resort.
// Ambiguous/no match → productId null (not deducted, surfaced as unresolved).
function resolveProduct(item, storeId) {
  const qty = parseInt(item.qty, 10) || 0;
  const out = { name: item.name, sku: item.sku || null, qty, productId: null, nameCn: item.name, nameEn: item.name, matchBy: null };
  const apply = (p, by) => { out.productId = p.id; out.nameCn = p.name_cn; out.nameEn = p.name_en; out.matchBy = by; };

  // 1. Inline SKU token. Prefer the explicit skuCode Meituan sends; fall back to a
  // "(\d+-\d+)" token the merchant encodes in the listing/spec name. Meituan
  // sometimes drops skuCode and mangles foodName down to just the token tail
  // (e.g. "1-440)"), which used to strand the line as unmatched — no product, no
  // image, and no stock deduction. Extracting the token here recovers it.
  const skuToken = item.sku || (String(item.name || '').match(/\d+-\d+/) || [])[0] || null;
  if (skuToken) {
    const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(skuToken)
           || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(skuToken);
    if (p) { apply(p, 'sku'); out.sku = skuToken; return out; }
    // Token didn't resolve — fall through to the map/name strategies rather than
    // stranding the line on a stale or mistyped SKU code.
    out.matchBy = 'sku_unknown';
  }

  // 2. Product map by Meituan listing name (scoped to this store).
  if (storeId) {
    const wanted = normName(item.name);
    if (wanted) {
      const rows = db.prepare(`
        SELECT p.id, p.name_cn, p.name_en, m.meituan_name
          FROM meituan_product_map m
          JOIN store_products p ON p.id = m.product_id
         WHERE m.retail_store_id = ? AND p.is_active = 1 AND m.meituan_name IS NOT NULL
      `).all(storeId);
      let hit = rows.find(r => normName(r.meituan_name) === wanted);
      if (!hit) {
        // Substring either way (Meituan sometimes appends/trims a suffix), but
        // only when it's unambiguous.
        const cands = rows.filter(r => {
          const mn = normName(r.meituan_name);
          return mn && (mn.includes(wanted) || wanted.includes(mn));
        });
        if (cands.length === 1) hit = cands[0];
      }
      if (hit) { apply(hit, 'map'); return out; }
    }
  }

  // 3. Unique active name match.
  const clean = String(item.name || '').replace(/\([^)]*\)/g, ' ').trim();
  const cjk = (clean.match(/[一-鿿]+/) || [])[0];
  const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
  let matches = [];
  if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
  if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
  if (matches.length === 1) { apply(matches[0], 'name'); }
  else if (!out.matchBy || out.matchBy === 'sku_unknown') out.matchBy = matches.length > 1 ? 'ambiguous' : 'unmatched';
  return out;
}

// ── The extras the order payload already carried ─────────────────────────────
// Both daemons now send `order.channel` — the rest of the SAME order-list
// response they already fetched, read by lib/meituan-order-fields.js. Every
// field is optional by contract: a payload shape we've never seen leaves nulls
// and changes nothing else. These helpers are deliberately total (never throw)
// so a surprise can cost the extras and never the order or its stock deduction.
function chan(order) {
  const c = order && order.channel;
  return (c && typeof c === 'object') ? c : {};
}
// A finite number, else null — so a missing fee writes NULL rather than 0, which
// would read as "Meituan charged us nothing" instead of "we don't know".
function fnum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function ftext(v) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s || null;
}
// "There is nothing to write" — distinguished from a real failure so the poll
// path stays silent instead of logging an error for the ordinary case.
class SkipExtras extends Error {}

// Attach the structured payload's per-line price and Meituan listing id to the
// lines we resolved from the copy text.
//
// WHY MATCH INSTEAD OF REPLACE. The copy-text parse is what deducts stock, and
// it handles a combo by expanding it into its components; the structured rows
// report that same combo as ONE line. Swapping the source would therefore change
// what gets deducted — a thing to do on evidence, in daylight, not as a side
// effect of collecting prices. So the structured rows are matched ONTO the
// resolved lines: exact normalised name first, then an unambiguous substring,
// each structured row consumed at most once. A line that finds no match keeps
// unit_price 0 exactly as before, and the order's money is unaffected either way
// because the totals come from chargeInfo, not from summing these.
function attachChannelLines(items, chItems) {
  const rows = (Array.isArray(chItems) ? chItems : []).map(r => ({ r, used: false }));
  if (!rows.length) return;
  for (const it of items) {
    const wanted = normName(it.name);
    if (!wanted) continue;
    let hit = rows.find(x => !x.used && normName(x.r.name) === wanted);
    if (!hit) {
      const cands = rows.filter(x => {
        if (x.used) return false;
        const n = normName(x.r.name);
        return n && (n.includes(wanted) || wanted.includes(n));
      });
      if (cands.length === 1) hit = cands[0];
    }
    if (!hit) continue;
    hit.used = true;
    const price = fnum(hit.r.price);
    if (price !== null) { it.unitPrice = price; it.lineTotal = price * (Number(it.qty) || 0); }
    it.foodId = ftext(hit.r.foodId);
    // Add-ons as [{ label }] — the shape options_json already carries for our own
    // orders, so the packer's per-line options row renders them with no change
    // there. They are labels only: nothing keys stock off them (a channel order
    // deducts through adjustStock, never through the option-expanding path).
    it.options = Array.isArray(hit.r.options) && hit.r.options.length
      ? hit.r.options.map(label => ({ label }))
      : null;
  }
}

// Map a Meituan platform status label → our internal `status` so the order
// shows OUR lifecycle vocabulary (Paid/Preparing/Dispatched/Delivered) and
// lands in the matching Orders tab, exactly like mini-app/web orders. The exact
// Meituan label is still kept in channel_status for the detail drawer. Ordered
// so pre-dispatch labels that happen to contain 配送 (待发起配送/待配送) classify
// as preparing, not dispatched. Returns null for unpaid/unknown → keep 'paid'.
function internalStatusForChannel(desc) {
  const d = String(desc || '');
  if (!d) return null;
  if (/退款|退货/.test(d))                                        return 'refunded';
  if (/取消|已关闭|交易关闭/.test(d))                             return 'cancelled';
  // 用户已收餐 / 已收餐 is the 外卖 wording for 已收货 — the customer has it.
  // 妥投/已妥投/签收成功 are Meituan's courier-delivery synonyms for the same event.
  if (/已完成|交易完成|已送达|已收货|已收餐|订单完成|已签收|妥投|签收成功/.test(d)) return 'delivered';
  if (/待发起配送|待配送|待接单|已接单|待拣货|拣货|备货|待发货|制作/.test(d)) return 'preparing';
  // Rider now HOLDS the parcel and is en route to the customer — real dispatch.
  // (已取货/已取餐 = picked up; distinguished from 待…取货 = still awaiting pickup below.)
  if (/已取货|已取餐|已揽收|配送中|派送中|派件中|运输中/.test(d))   return 'dispatched';
  // Rider assigned and heading to the store to COLLECT, parcel not yet in hand
  // (正在分配骑手 / 骑手已接单 / 待骑手到店 / 骑手已到店 / 待骑手取货 / 待取货).
  // Its own bucket so the floor knows "a rider is coming — have it ready now".
  if (/骑手|到店|待取货/.test(d))                                 return 'rider_pickup';
  // Any other delivery-ish label with no rider phase → dispatched fallback.
  if (/配送|派送|取货/.test(d))                                   return 'dispatched';
  return null; // 待支付 / unknown → keep 'paid'
}

// Lifecycle order of the statuses a Meituan label can write, used only to stop a
// STALE label from walking an order backwards. Meituan's poll runs ~5min and
// trails the Qingyun rider who actually carries the order, so by the time a poll
// reports 骑手已接单 the rider may already have collected it — and our own
// auto-dispatch / auto-deliver sweeps (routes/retail.js) will have advanced the
// mirror off the live courier feed. Letting the trailing label win drags the
// order back and the two flap against each other every poll: dispatched →
// rider_pickup → dispatched, minute after minute. Same shape as the placed_at
// guard in the handler below, which only ever moves EARLIER; this one only ever
// moves FORWARD.
const CHANNEL_STATUS_RANK = {
  pending_payment: 0, paid: 1, awaiting_restock: 1,
  preparing: 2, rider_pickup: 3, dispatched: 4, delivered: 5,
};
// Should `next` be written over `current`?
// cancelled/refunded are deliberately exempt in BOTH directions: a void is the
// platform's own fact and can land at any point (including after delivery, as a
// refund), and a void that flips back to a live label must be able to un-cancel —
// the restock logic below is built on exactly that, so it can re-deduct stock it
// returned when Meituan rejects a refund request.
// An unranked status on either side keeps the old unconditional behaviour.
//
// Trade-off worth naming: a Qingyun rider who ACCEPTS then CANCELS reverts the
// job, but our status stays on 'dispatched' and this guard won't let Meituan pull
// it back to rider_pickup. That matches what already happens to our own mini-app
// orders (nothing reverts the auto-dispatch sweep either), and the row's status
// pill still reads the live courier stage — it shows "Finding a rider" over a
// dispatched order rather than pretending one is on the way.
function isForwardChannelStatus(current, next) {
  if (!next || next === current) return true;                      // nothing to write
  if (next === 'cancelled' || next === 'refunded') return true;    // a void always wins
  const cur = CHANNEL_STATUS_RANK[current];
  const nxt = CHANNEL_STATUS_RANK[next];
  if (cur == null || nxt == null) return true;                     // not ours to rank
  return nxt > cur;
}

// Whether a status label is a CONFIRMED, terminal void — the only thing that
// should return stock. A bare 退款/退货/取消 is NOT enough: Meituan surfaces a
// refund/cancel *request* with those words while the order is still live, and if
// the merchant/platform rejects it the order goes on to ship (rider picks up,
// delivered). Restocking on the request then double-counts. So we require an
// explicit settled form and explicitly exclude pending/in-progress wording.
function isConfirmedVoid(desc) {
  const d = String(desc || '');
  if (!d) return false;
  // Pending / under-review / negotiating → not settled, never restock.
  if (/申请|待处理|处理中|审核|退款中|退货中|协商|部分退款/.test(d)) return false;
  // Settled cancels and completed refunds.
  return /已取消|交易取消|订单取消|已关闭|交易关闭|已退款|退款成功|退款完成|全额退款/.test(d);
}

// POST /api/internal/meituan/ingest-order
// Mirrors a parsed Meituan order into roots: creates a retail_order and deducts
// store stock (ledgered, which re-pushes the corrected number to Meituan +
// Guanyi via enqueueChannelSync). Returns { orderId, deducted, unresolved }.
router.post('/ingest-order', (req, res) => {
  const { storeId, storeCode, order } = req.body || {};
  if (!storeId || !order) return res.status(400).json({ error: 'storeId and order required' });

  try {
    const now      = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand     = Math.floor(Math.random() * 900000) + 100000;
    const orderNo  = `MT${datePart}${rand}`;
    const ref      = order.meituanOrderNo || orderNo;

    const items = (order.items || []).map(it => resolveProduct(it, storeId)).filter(i => i.qty > 0);
    const total = parseFloat(order.total) || 0;
    // Real platform status label (拣货中 / 配送中 / 已完成 / 已取消 …). The internal
    // `status` stays 'paid' — this is a read-only mirror we never fulfil ourselves
    // — but channel_status carries Meituan's own lifecycle so the Orders list shows
    // the true state instead of a fixed "Paid". Refreshed on later polls via
    // /update-order-status.
    const channelStatus = (order.statusDesc && String(order.statusDesc).trim()) || null;
    const channelEta    = (order.eta && String(order.eta).trim()) || null;
    // 预订单 — booked for a later window, not to be packed now. NULL on a normal
    // order. The Orders list and drawer both key their "Pre-order" treatment off
    // this, so a booked order stops reading as "due immediately".
    const preOrderAt    = (order.preOrderAt && String(order.preOrderAt).trim()) || null;
    // Prefer Meituan's own order time over our import time (a ~5 min poll means
    // CURRENT_TIMESTAMP is always late, and near midnight it lands on the wrong
    // day). Falls back to now when the platform didn't give us one.
    const placedAt      = (order.placedAt && String(order.placedAt).trim()) || null;
    // What the customer typed, plus their cutlery answer — both are on the order
    // in Meituan and both matter to whoever packs the bag.
    const customerNote  = (order.note && String(order.note).trim()) || null;
    const needsCutlery  = order.needsCutlery ? 1 : 0;
    // A terminal Meituan label (已完成/已取消/退款…) maps to the matching internal
    // status so the order lands in the right tab; anything in-progress → 'paid'.
    const internalStatus = internalStatusForChannel(channelStatus) || 'paid';
    // An order whose FIRST sighting is already void. The restock in
    // /update-order-status only fires on the TRANSITION into cancelled/refunded —
    // which by definition never happens for one that arrived cancelled — so
    // deducting here takes stock that nothing ever gives back. Live example found
    // 2026-08-24: order 604 (MT20260714365100), placed_at == channel_status_at ==
    // 订单取消, deducted and still sitting at channel_stock_restored = 0.
    // Record the order, skip the deduction.
    const bornVoid = internalStatus === 'cancelled' || internalStatus === 'refunded';

    // The rest of the same payload (see chan/attachChannelLines above).
    const ch    = chan(order);
    const money = ch.money    || {};
    const rider = ch.rider    || {};
    const cust  = ch.customer || {};
    const inv   = ch.invoice  || {};
    attachChannelLines(items, ch.items);

    // Money. `total` keeps its meaning — what the customer was charged — and
    // Meituan's own userPayTotalAmount is the authority on it when present (the
    // copy text's 合计 agrees; 闪购 previously summed item prices and so under-
    // reported by the fees). `subtotal` now carries the GOODS amount rather than
    // a repeat of the total, with the fees in their own long-existing columns.
    const userPaid    = fnum(money.userPaid);
    const totalPaid   = userPaid !== null ? userPaid : total;
    const subtotal    = fnum(money.food) !== null ? fnum(money.food) : totalPaid;
    const shippingFee = fnum(money.shipping);
    const packingFee  = fnum(money.packaging);
    // Delivery lifecycle as the PLATFORM records it. Our own dispatch/delivery
    // columns were always empty on these orders — nobody here dispatches them —
    // so the rider's collect/drop times are the only such record that exists.
    const fetchedAt   = ftext(rider.fetchedAt);
    const deliveredAt = ftext(rider.deliveredAt);

    // 1. Create the order + its line items in one transaction.
    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method, subtotal, total,
          store_id, channel, fulfillment_type, placed_at, paid_at,
          channel_status, channel_status_at, channel_eta, channel_preorder_at,
          customer_note, needs_cutlery,
          shipping_fee, packing_fee,
          channel_commission, channel_settle_amount, channel_discount,
          channel_rider_name, channel_rider_status, channel_rider_status_code,
          channel_rider_assigned_at, channel_rider_fetched_at,
          channel_customer_id, channel_customer_orders,
          channel_distance_m, channel_dest_lat, channel_dest_lng,
          recipient_name, needs_invoice, invoice_title, invoice_tax_id,
          dispatched_at, delivered_at
        ) VALUES (?, ?, 'meituan', ?, ?, ?, 'meituan', 'delivery',
                  COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP),
                  ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?, ?,
                  ?, ?,
                  COALESCE(?, 0), COALESCE(?, 0),
                  ?, ?, ?,
                  ?, ?, ?,
                  ?, ?,
                  ?, ?,
                  ?, ?, ?,
                  ?, ?, ?, ?,
                  ?, ?)
      `).run(orderNo, internalStatus, subtotal, totalPaid, storeId, placedAt, placedAt,
             channelStatus, channelStatus, channelEta, preOrderAt, customerNote, needsCutlery,
             shippingFee, packingFee,
             fnum(money.commission), fnum(money.settle), fnum(money.discount),
             ftext(rider.name), ftext(rider.statusDesc), fnum(rider.statusCode),
             ftext(rider.assignedAt), fetchedAt,
             ftext(cust.userId), fnum(cust.orderCount),
             fnum(cust.distanceM), fnum(cust.lat), fnum(cust.lng),
             ftext(cust.name), inv.wanted ? 1 : 0, ftext(inv.title), ftext(inv.taxId),
             fetchedAt, deliveredAt);
      const oid = r.lastInsertRowid;
      // channel_stock_restored means "this order's stock is NOT currently deducted
      // from our count". A born-void order never had its stock taken, so it starts
      // in that state — which is also what makes the re-deduct branch in
      // /update-order-status correct if Meituan later revives the order.
      if (bornVoid) db.prepare('UPDATE retail_orders SET channel_stock_restored = 1 WHERE id = ?').run(oid);
      for (const it of items) {
        // Snapshot the Meituan 货号 (SKU token) so the view-only order drawer can
        // show it per line — including UNMATCHED lines (productId null), which
        // have no store_products row for the detail route to pull a SKU from.
        // unit_price/line_total were hard-zeroed here until the structured rows
        // arrived: every Meituan sale therefore counted as ¥0 of product revenue
        // in the per-product reports that SUM(line_total). They now carry the
        // real per-line price when the line matched a structured row, and stay 0
        // when it didn't — never a guess.
        db.prepare(`
          INSERT INTO retail_order_items
            (order_id, product_id, name_cn, name_en, sku, qty, unit_price, line_total,
             channel_food_id, options_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(oid, it.productId, it.nameCn, it.nameEn, it.sku || null, it.qty,
               fnum(it.unitPrice) || 0, fnum(it.lineTotal) || 0,
               it.foodId || null, it.options ? JSON.stringify(it.options) : null);
      }
      return oid;
    })();

    // 2. Deduct stock via the ledgered adjuster (also re-pushes to Meituan +
    //    Guanyi). Clamp at 0 — a Meituan oversell shouldn't drive us negative.
    const unresolved = [];
    const oversold = [];
    let deducted = 0;
    for (const it of bornVoid ? [] : items) {
      if (!it.productId) { unresolved.push({ name: it.name, sku: it.sku, qty: it.qty, reason: it.matchBy }); continue; }
      const cur  = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, it.productId);
      const oldQ = cur ? cur.physical_qty : 0;
      // On-hand can't cover the line (oversell, or an already-negative row). We
      // still clamp at 0 so a channel oversell can't drive us negative, but flag
      // the shortfall (below) instead of letting it vanish into the clamp.
      if (oldQ < it.qty) oversold.push({ name: it.nameEn, sku: it.sku, have: oldQ, want: it.qty });
      inventory.adjustStock({
        storeId, productId: it.productId,
        newPhysicalQty: Math.max(0, oldQ - it.qty),
        actorLabel: 'Meituan order',
        reason: 'meituan_order',
        note: `Meituan ${ref}${order.daySeq != null ? ` #${order.daySeq}` : ''} — ${it.nameEn} x${it.qty}`,
      });
      deducted++;
    }

    // Visible in the sync log rather than only in the response body — "stock
    // deliberately not deducted" is exactly the kind of silent decision that looks
    // like a bug six weeks later.
    if (bornVoid) {
      try {
        db.prepare(`
          INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_born_void', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, channelStatus, items: items.length }),
          `order first seen as "${channelStatus}" — recorded without deducting stock`
        );
      } catch (logErr) { console.error('[meituan-internal] order_born_void log failed:', logErr.message); }
    }

    // 3. Surface unmatched line-items. Previously these were dropped silently —
    //    a combo component with no SKU token / map entry just vanished, leaving
    //    no ledger row and no trace (e.g. an un-mapped 套餐). Log every order's
    //    matched/unmatched breakdown so gaps are visible in the sync log and the
    //    operator can map what's missing instead of guessing.
    if (unresolved.length) {
      try {
        const matched = items.filter(i => i.productId)
          .map(i => ({ name: i.name, sku: i.sku, qty: i.qty, by: i.matchBy }));
        db.prepare(`
          INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_unsynced', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, deducted, matched, unresolved }),
          `${unresolved.length} item(s) not synced: ` +
            unresolved.map(u => `${u.name}${u.sku ? ` (${u.sku})` : ''} x${u.qty} [${u.reason}]`).join('; ')
        );
      } catch (logErr) {
        console.error('[meituan-internal] order_unsynced log failed:', logErr.message);
      }
    }

    // 4. Surface oversold lines. The deduction clamped at 0, so an order whose
    //    on-hand was already short (or negative) leaves no visible drop — exactly
    //    the "why didn't this one move?" confusion. Flag it so the count can be
    //    reconciled rather than silently swallowed by the clamp.
    if (oversold.length) {
      try {
        db.prepare(`
          INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_oversold', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, oversold }),
          `${oversold.length} line(s) exceeded on-hand (clamped at 0): ` +
            oversold.map(o => `${o.name}${o.sku ? ` (${o.sku})` : ''} have ${o.have} want ${o.want}`).join('; ')
        );
      } catch (logErr) {
        console.error('[meituan-internal] order_oversold log failed:', logErr.message);
      }
    }

    // 5. Record what the payload's own item rows said, versus the copy-text parse
    //    we deduct from. This is the evidence for a decision not yet taken: the
    //    structured rows carry Meituan's listing id and would be a sturdier basis
    //    for matching than a regex over a merchant-typed title — but only if they
    //    agree with the parse in the cases that matter (combos, add-ons, odd
    //    characters). Logged when they DISAGREE, plus once per store on first
    //    sighting so an empty section is visible as a fact rather than as an
    //    absence. Never blocks the import.
    try {
      const chLines = Array.isArray(ch.items) ? ch.items : [];
      const copyQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
      const chQty   = chLines.reduce((s, i) => s + (Number(i.qty) || 0), 0);
      const priced  = items.filter(i => fnum(i.unitPrice) !== null).length;
      const drift   = chLines.length !== items.length || chQty !== copyQty || priced !== items.length;
      const firstForStore = !db.prepare(`
        SELECT 1 FROM meituan_sync_log
         WHERE event_type = 'order_fields' AND COALESCE(store_code,'') = COALESCE(?,'') LIMIT 1
      `).get(storeCode || null);
      if (drift || firstForStore) {
        db.prepare(`
          INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_fields', ?, ?, ?)
        `).run(
          storeCode || null,
          drift ? 'warn' : 'ok',
          JSON.stringify({
            ref,
            sections: ch.present || [],
            copy: items.map(i => ({ name: i.name, qty: i.qty, priced: fnum(i.unitPrice) !== null })),
            structured: chLines.map(i => ({ name: i.name, qty: i.qty, price: i.price, foodId: i.foodId })),
            money: money, rider: rider.name || null, customerOrders: cust.orderCount ?? null,
          }),
          drift
            ? `structured/copy item mismatch: ${items.length} copy line(s) qty ${copyQty} vs ${chLines.length} structured qty ${chQty}; ${priced}/${items.length} priced`
            : null
        );
      }
    } catch (logErr) {
      console.error('[meituan-internal] order_fields log failed:', logErr.message);
    }

    res.json({ ok: true, orderId, orderNo, items: items.length, deducted, unresolved });
  } catch (err) {
    console.error('[meituan-internal] ingest-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/meituan/update-order-status
// Refresh the mirrored order's platform status label on later polls (an order
// moves 拣货中 → 配送中 → 已完成 while it stays in Meituan's hands). Idempotent:
// only writes when the label actually changed, and returns { changed }. Looked up
// by Meituan order no via meituan_order_import → retail_order_id.
router.post('/update-order-status', (req, res) => {
  const { meituanOrderNo, statusDesc, eta, preOrderAt, note, needsCutlery, placedAt } = req.body || {};
  // The extras ride on every poll, not just the first: at import time an order
  // usually has no rider yet, so the delivery record only exists on later reads.
  const ch = chan(req.body);
  const desc = (statusDesc && String(statusDesc).trim()) || null;
  const etaVal = (eta && String(eta).trim()) || null;
  if (!meituanOrderNo || !desc) return res.status(400).json({ error: 'meituanOrderNo and statusDesc required' });

  try {
    const imp = db.prepare(
      'SELECT retail_order_id FROM meituan_order_import WHERE meituan_order_no = ?'
    ).get(String(meituanOrderNo));
    if (!imp || !imp.retail_order_id) return res.json({ ok: true, changed: false, reason: 'not_mirrored' });

    // Snapshot the order BEFORE we advance it — the restock below keys off the
    // PREVIOUS status, which is what makes it idempotent under a repeating poll.
    const prev = db.prepare('SELECT status, store_id, channel_stock_restored FROM retail_orders WHERE id = ?').get(imp.retail_order_id);

    // A terminal label also advances the internal status so the order leaves the
    // Paid worklist for Delivered/Cancelled/Refunded; in-progress leaves it alone.
    const internal = internalStatusForChannel(desc);
    // Forward-only (see isForwardChannelStatus): a poll that merely lags the live
    // Qingyun rider must not undo a sweep that already advanced this order.
    // `channel_status` itself is ALWAYS written — the drawer shows Meituan's exact
    // label, and that stays true even when we decline to follow it with our own
    // status. Only the internal status is held back.
    const statusWrite = isForwardChannelStatus(prev && prev.status, internal) ? internal : null;
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

    // Backfill the platform-owned facts an older import didn't carry: the 预订单
    // window, the customer's note, their cutlery answer, and Meituan's own order
    // time. Every poll re-reads them, so orders mirrored before those were parsed
    // heal themselves on the next sweep instead of needing a hand-written UPDATE.
    // Guarded so a re-poll can't undo anything: the note only fills when blank,
    // and placed_at only moves EARLIER — our import stamp is by definition later
    // than the real order time, so an earlier platform time is always the truer
    // one, and a correct row can never be dragged forward.
    const noteVal    = (note && String(note).trim()) || null;
    const preVal     = (preOrderAt && String(preOrderAt).trim()) || null;
    const placedVal  = (placedAt && String(placedAt).trim()) || null;
    const cutleryVal = needsCutlery == null ? null : (needsCutlery ? 1 : 0);
    db.prepare(`
      UPDATE retail_orders
         SET channel_preorder_at = COALESCE(?, channel_preorder_at),
             customer_note = CASE WHEN COALESCE(customer_note,'') = '' THEN COALESCE(?, customer_note) ELSE customer_note END,
             needs_cutlery = COALESCE(?, needs_cutlery),
             placed_at = CASE WHEN ? IS NOT NULL AND ? < placed_at THEN ? ELSE placed_at END,
             paid_at   = CASE WHEN ? IS NOT NULL AND ? < paid_at   THEN ? ELSE paid_at   END
       WHERE id = ?
    `).run(preVal, noteVal, cutleryVal,
           placedVal, placedVal, placedVal,
           placedVal, placedVal, placedVal,
           imp.retail_order_id);

    // The platform-owned extras, refreshed the same way. Two different rules,
    // deliberately:
    //   • The RIDER and the settlement move while the order is live (a rider is
    //     assigned, collects, delivers; a refund re-cuts the settlement), so the
    //     channel_* columns take the latest non-null value — COALESCE(?, col)
    //     keeps a poll that simply didn't carry the section from wiping one that
    //     did.
    //   • subtotal / shipping_fee / packing_fee and the customer facts are
    //     BACKFILL-ONLY: written when still empty, never overwritten. That heals
    //     every order mirrored before this existed without letting a later poll
    //     rewrite the money on an order somebody has since worked on.
    // delivered_at / dispatched_at are ours, and only ever fill a blank.
    // A daemon that didn't send the section at all (an older build, mid-deploy)
    // writes nothing here rather than a row of COALESCE no-ops.
    try {
      if (!Object.keys(ch).length) throw new SkipExtras();
      const money = ch.money    || {};
      const rider = ch.rider    || {};
      const cust  = ch.customer || {};
      const inv   = ch.invoice  || {};
      db.prepare(`
        UPDATE retail_orders
           SET channel_rider_name        = COALESCE(?, channel_rider_name),
               channel_rider_status      = COALESCE(?, channel_rider_status),
               channel_rider_status_code = COALESCE(?, channel_rider_status_code),
               channel_rider_assigned_at = COALESCE(?, channel_rider_assigned_at),
               channel_rider_fetched_at  = COALESCE(?, channel_rider_fetched_at),
               channel_commission        = COALESCE(?, channel_commission),
               channel_settle_amount     = COALESCE(?, channel_settle_amount),
               channel_discount          = COALESCE(?, channel_discount),
               dispatched_at             = COALESCE(dispatched_at, ?),
               delivered_at              = COALESCE(delivered_at, ?),
               shipping_fee              = CASE WHEN COALESCE(shipping_fee,0) = 0 THEN COALESCE(?, shipping_fee) ELSE shipping_fee END,
               packing_fee               = CASE WHEN COALESCE(packing_fee,0)  = 0 THEN COALESCE(?, packing_fee)  ELSE packing_fee  END,
               subtotal                  = CASE WHEN COALESCE(subtotal,0) = COALESCE(total,0) THEN COALESCE(?, subtotal) ELSE subtotal END,
               channel_customer_id       = COALESCE(channel_customer_id, ?),
               channel_customer_orders   = COALESCE(?, channel_customer_orders),
               channel_distance_m        = COALESCE(channel_distance_m, ?),
               channel_dest_lat          = COALESCE(channel_dest_lat, ?),
               channel_dest_lng          = COALESCE(channel_dest_lng, ?),
               recipient_name            = CASE WHEN COALESCE(recipient_name,'') = '' THEN COALESCE(?, recipient_name) ELSE recipient_name END,
               invoice_title             = CASE WHEN COALESCE(invoice_title,'')  = '' THEN COALESCE(?, invoice_title)  ELSE invoice_title  END,
               invoice_tax_id            = CASE WHEN COALESCE(invoice_tax_id,'') = '' THEN COALESCE(?, invoice_tax_id) ELSE invoice_tax_id END,
               needs_invoice             = CASE WHEN ? = 1 THEN 1 ELSE needs_invoice END
         WHERE id = ?
      `).run(
        ftext(rider.name), ftext(rider.statusDesc), fnum(rider.statusCode),
        ftext(rider.assignedAt), ftext(rider.fetchedAt),
        fnum(money.commission), fnum(money.settle), fnum(money.discount),
        ftext(rider.fetchedAt), ftext(rider.deliveredAt),
        fnum(money.shipping), fnum(money.packaging), fnum(money.food),
        ftext(cust.userId), fnum(cust.orderCount),
        fnum(cust.distanceM), fnum(cust.lat), fnum(cust.lng),
        ftext(cust.name), ftext(inv.title), ftext(inv.taxId), inv.wanted ? 1 : 0,
        imp.retail_order_id
      );
      // Per-line price + listing id for an order mirrored before the structured
      // rows were read. Matched by name against the lines already stored, and
      // only ever fills a zero — a line somebody has since edited is left alone.
      const chLines = Array.isArray(ch.items) ? ch.items : [];
      if (chLines.length) {
        const stored = db.prepare(
          'SELECT id, name_cn, name_en, qty, unit_price, channel_food_id FROM retail_order_items WHERE order_id = ?'
        ).all(imp.retail_order_id);
        const lines = stored.map(s => ({ name: s.name_cn || s.name_en, qty: s.qty, id: s.id, row: s }));
        attachChannelLines(lines, chLines);
        for (const l of lines) {
          const price = fnum(l.unitPrice);
          if (price === null && !l.foodId) continue;
          db.prepare(`
            UPDATE retail_order_items
               SET unit_price      = CASE WHEN COALESCE(unit_price,0) = 0 THEN COALESCE(?, unit_price) ELSE unit_price END,
                   line_total      = CASE WHEN COALESCE(line_total,0) = 0 THEN COALESCE(?, line_total) ELSE line_total END,
                   channel_food_id = COALESCE(channel_food_id, ?)
             WHERE id = ?
          `).run(price, fnum(l.lineTotal), l.foodId || null, l.id);
        }
      }
    } catch (e) {
      // The extras must never cost the status write — that is the load-bearing
      // half of this endpoint.
      if (!(e instanceof SkipExtras)) {
        console.error('[meituan-internal] channel extras update failed:', e.message);
      }
    }

    // Meituan voided the order → give the stock back. Ingest deducted it (ledgered)
    // and nothing else ever returned it, so without this EVERY cancel drifts our count
    // low — which then under-reports to Meituan + Guanyi on the next push. Runs only on
    // the transition into cancelled/refunded (prev status was neither), so a poll that
    // re-reads the same 订单取消 label can never restock twice. Best-effort: a restock
    // failure must not fail the status write, or the order would stick on a stale label.
    // Gate on a CONFIRMED void, not a bare 退款/取消 (which may be a request the
    // order later shrugs off). channel_stock_restored keeps it idempotent under a
    // repeating poll AND lets a transient void that flips back to a live status
    // re-deduct what we returned — otherwise a rejected refund inflates our count.
    let restocked = 0, rededucted = 0;
    const confirmedVoid   = isConfirmedVoid(desc);
    const alreadyRestored = !!prev && prev.channel_stock_restored === 1;
    const orderLines = () => db.prepare(
      'SELECT product_id, name_en, qty FROM retail_order_items WHERE order_id = ? AND product_id IS NOT NULL'
    ).all(imp.retail_order_id);
    const stockOf = (pid) => {
      const cur = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
        .get(prev.store_id, pid);
      return cur ? cur.physical_qty : 0;
    };
    if (prev && confirmedVoid && !alreadyRestored) {
      // Order truly voided → give the deducted stock back, exactly once.
      try {
        for (const it of orderLines()) {
          inventory.adjustStock({
            storeId: prev.store_id, productId: it.product_id,
            newPhysicalQty: stockOf(it.product_id) + it.qty,
            actorLabel: 'Meituan cancel',
            reason: 'meituan_cancel',
            note: `Meituan ${String(meituanOrderNo)} ${internal || 'void'} — restored ${it.name_en} x${it.qty}`,
          });
          restocked++;
        }
        db.prepare('UPDATE retail_orders SET channel_stock_restored = 1 WHERE id = ?').run(imp.retail_order_id);
      } catch (e) {
        console.error('[meituan-internal] restock on cancel failed:', e.message);
      }
    } else if (prev && alreadyRestored && !confirmedVoid) {
      // Stock was returned for a void that has since flipped back to a live status
      // (request rejected, rider picked up) → re-deduct so we don't over-report.
      try {
        for (const it of orderLines()) {
          inventory.adjustStock({
            storeId: prev.store_id, productId: it.product_id,
            newPhysicalQty: Math.max(0, stockOf(it.product_id) - it.qty),
            actorLabel: 'Meituan uncancel',
            reason: 'meituan_uncancel',
            note: `Meituan ${String(meituanOrderNo)} back to ${desc} — re-deducted ${it.name_en} x${it.qty}`,
          });
          rededucted++;
        }
        db.prepare('UPDATE retail_orders SET channel_stock_restored = 0 WHERE id = ?').run(imp.retail_order_id);
      } catch (e) {
        console.error('[meituan-internal] re-deduct on uncancel failed:', e.message);
      }
    }

    res.json({ ok: true, changed: r.changes > 0, restocked, rededucted });
  } catch (err) {
    console.error('[meituan-internal] update-order-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/meituan/auto-deliver-past-eta
// Time-based fallback: Meituan only stamps 已完成 (→ Delivered) once the customer
// confirms receipt / auto-confirm fires, often a day or more after the parcel has
// actually arrived — so mirrored orders sit at Dispatched long after delivery. If
// an order is still non-terminal one hour past its Meituan ETA (channel_eta), treat
// it as delivered so the Orders list reflects reality. channel_eta and channel_status_at
// are UTC (getPendingOrders stores the ETA as a UTC string; CURRENT_TIMESTAMP is UTC),
// so the comparison is done in UTC via datetime('now'). Idempotent — a delivered order
// is terminal and the daemon sweep never re-reads it, so this never fights the label.
// Applies across every store (channel = 'meituan'); safe to call from either daemon.
router.post('/auto-deliver-past-eta', (_req, res) => {
  try {
    const r = db.prepare(`
      UPDATE retail_orders
         SET status = 'delivered'
       WHERE channel = 'meituan'
         AND status IN ('paid','preparing','dispatched','rider_pickup')
         AND channel_eta IS NOT NULL AND channel_eta != ''
         AND datetime(channel_eta, '+1 hour') <= datetime('now')
    `).run();
    res.json({ ok: true, delivered: r.changes });
  } catch (err) {
    console.error('[meituan-internal] auto-deliver-past-eta error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/internal/meituan/sync-status
// Quick health check the daemon can call to verify the server is reachable.
router.get('/sync-status', (_req, res) => {
  const queuePending = db.prepare(
    "SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='pending'"
  ).get()?.n || 0;
  const recentLogs = db.prepare(
    "SELECT * FROM meituan_sync_log ORDER BY created_at DESC LIMIT 10"
  ).all();
  res.json({ ok: true, queuePending, recentLogs });
});

module.exports = router;
