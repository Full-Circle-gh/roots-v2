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

const INTERNAL_SECRET = process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal';

router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

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
  const d = String(desc || '');
  if (!d) return null;
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
  return null; // 待支付 / unknown → keep 'paid'
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
function resolveProduct(item, storeId) {
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
    const total = parseFloat(order.total) || 0;

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
    const internalStatus = internalStatusForChannel(channelStatus) || 'paid';
    // An order whose FIRST sighting is already void never had stock deducted here,
    // and this build has no restock path to give it back (see the header). Deducting
    // now would drift the count low permanently and then under-report that number to
    // every other channel on the next push. Record the order, skip the deduction.
    const bornVoid = internalStatus === 'cancelled' || internalStatus === 'refunded';
    // subtotal stays equal to total, matching the Meituan mirror. Packaging and
    // delivery fees are deliberately NOT written to packing_fee/shipping_fee: on
    // our own orders those are ADDENDS to subtotal, so writing them beside a
    // subtotal that already equals the total would double-count in every place
    // that re-adds them. They are kept intact in eleme_order_import.detail_json.

    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method, subtotal, total,
          store_id, channel, fulfillment_type, placed_at, paid_at,
          channel_status, channel_status_at, channel_eta, channel_preorder_at,
          customer_note, needs_cutlery
        ) VALUES (?, ?, 'eleme', ?, ?, ?, 'eleme', 'delivery',
                  COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP),
                  ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?, ?,
                  ?, ?)
      `).run(orderNo, internalStatus, total, total, storeId, placedAt, placedAt,
             channelStatus, channelStatus, channelEta, preOrderAt, customerNote, needsCutlery);
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
            (order_id, product_id, name_cn, name_en, sku, qty, unit_price, line_total, pack_units)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(oid, it.productId, it.nameCn, it.nameEn, it.sku || null, it.qty,
               it.unitPrice != null ? it.unitPrice : 0,
               it.lineTotal != null ? it.lineTotal : 0,
               packUnits(it.units));
      }
      return oid;
    })();

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

    res.json({ ok: true, orderId, orderNo, items: items.length, deducted, unresolved, bornVoid });
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
  const { elemeOrderId, statusDesc, eta, preOrderAt, note, needsCutlery, placedAt } = req.body || {};
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
      'SELECT status, store_id, channel_stock_restored FROM retail_orders WHERE id = ?'
    ).get(imp.retail_order_id);
    const internal = internalStatusForChannel(desc);
    // channel_status is ALWAYS written (the drawer shows Eleme's exact label);
    // only our own status is held back when the label would walk it backwards.
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

module.exports = router;
