#!/usr/bin/env node
// gzgrocery ORDER → stock daemon.
//
// gzgrocery sells OUR products (alongside lots of third-party grocery) through
// their OpenCart storefront. Until now we could only INFER their sales from
// Guanyi stock drift, which misses scheduled/next-day orders (Guanyi doesn't
// decrement until fulfillment). This daemon reads their orders DIRECTLY and
// decrements our Tianhe stock the moment a paid order appears — scheduled or
// not — through the canonical adjustStock path (ledgered + fanned out to the
// other channels). Cancellations/refunds add the stock back.
//
//   Modes (GZGROCERY_ORDER_MODE):
//     off    — daemon does nothing (default; safe).
//     shadow — read + log what it WOULD decrement; never touches stock.
//     live   — apply decrements/reversals to Tianhe.
//
//   ⚠ DOUBLE-COUNT GUARD: once this is in `live`, set GUANYI_PICKUP_MODE=shadow
//   in the guanyi-sync daemon. Otherwise, when gzgrocery later fulfills and the
//   Guanyi number finally drops, the drift detector would decrement the SAME
//   sale a second time. Order-read is the source of truth; drift becomes a
//   shadow cross-check.
//
//   Start:  pm2 start scripts/gzgrocery-order-daemon.js --name gzgrocery-orders
//   Recon:  node scripts/gzgrocery-order-daemon.js --once   (one cycle, verbose)
//
//   Requires in .env:
//     GZGROCERY_ADMIN_URL=https://www.gzgrocery.cn/admin/
//     GZGROCERY_ADMIN_USER=...   GZGROCERY_ADMIN_PASS=...
//     GZGROCERY_ORDER_MODE=shadow

'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); } catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const db = require('../database');
const { adjustStock } = require('../lib/inventory');
const { GzGroceryAdmin, extractSku } = require('../lib/gzgrocery-admin');
const { notifyOrder } = require('../lib/gzgrocery-order-notify');

let MODE = (process.env.GZGROCERY_ORDER_MODE || 'off').toLowerCase();
if (!['off', 'shadow', 'live'].includes(MODE)) MODE = 'off';

const STORE_CODE   = process.env.GZGROCERY_STORE_CODE || 'tianhe';
const POLL_MS      = Number(process.env.GZGROCERY_POLL_MS || 60_000);
const MAX_PAGES    = Number(process.env.GZGROCERY_MAX_PAGES || 5);
const SINCE_DAYS   = Number(process.env.GZGROCERY_SINCE_DAYS || 3);
const ONCE         = process.argv.includes('--once');

// Order is committed (units have physically left / will be picked) once paid and
// beyond. Pending/unpaid → wait. Void statuses → reverse if we already counted.
const ACTIVE = new Set((process.env.GZGROCERY_ACTIVE_STATUSES ||
  'Paid,Processing,Shipped,Complete,Completed,Partially Shipped,已支付,待处理,已审核,部分发货,全部发货,已完成').split(',').map(s => s.trim()).filter(Boolean));
const VOID = new Set((process.env.GZGROCERY_VOID_STATUSES ||
  'Canceled,Cancelled,Denied,Refunded,Reversed,Chargeback,Expired,Voided,Failed,已取消,退款中,支付失败').split(',').map(s => s.trim()).filter(Boolean));

function log(msg) { console.log(`[gzgrocery-orders] ${new Date().toISOString()} ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Schema (idempotent) ──────────────────────────────────────────────────────
function ensureTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS gzgrocery_orders (
    order_id      INTEGER PRIMARY KEY,
    order_no      TEXT,
    status        TEXT,
    total         REAL,
    customer      TEXT,
    date_added    TEXT,
    delivery_time TEXT,
    items_json    TEXT,          -- [{product,model,sku,qty,product_id,matched}]
    our_units     INTEGER DEFAULT 0,
    decremented   INTEGER DEFAULT 0,
    reversed      INTEGER DEFAULT 0,
    mode          TEXT,
    note          TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS gzgrocery_order_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER, order_no TEXT, action TEXT, mode TEXT, detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS gzgrocery_meta (
    key TEXT PRIMARY KEY, value TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gzo_status ON gzgrocery_orders(status)`);
  // Ship-to, added after the table shipped. The customer panel on their Order
  // Details screen is masked (***), so for months the only "customer" we had was
  // the order id echoed back. The dispatch note carries the real thing — see
  // GzGroceryAdmin.fetchOrderShipTo.
  for (const col of ['recipient_name TEXT', 'recipient_phone TEXT', 'address_full TEXT', 'address_json TEXT']) {
    try { db.exec(`ALTER TABLE gzgrocery_orders ADD COLUMN ${col}`); } catch { /* already there */ }
  }
}
function getMeta(k) { return db.prepare(`SELECT value FROM gzgrocery_meta WHERE key=?`).get(k)?.value ?? null; }
function setMeta(k, v) { db.prepare(`INSERT INTO gzgrocery_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(v)); }

// Cold-start baseline: the highest order_id that already existed the first time
// this daemon ran. Everything at/below it was placed BEFORE we started watching
// (and was already accounted for by the legacy Guanyi-drift path), so it is
// seeded as "counted" and NEVER decremented — only NEW orders above it act.
// Persisted once, so a restart (or shadow→live flip) keeps the same line.
function resolveBaseline(orders) {
  const env = Number(process.env.GZGROCERY_DECREMENT_FROM_ID || 0);
  if (env > 0) { setMeta('baseline_order_id', env); return env; }
  const stored = Number(getMeta('baseline_order_id') || 0);
  if (stored > 0) return stored;
  const max = orders.reduce((m, o) => Math.max(m, o.orderId), 0);
  setMeta('baseline_order_id', max);
  log(`cold-start: baseline_order_id seeded at ${max} — existing orders (≤${max}) will NOT be decremented`);
  return max;
}
function auditLog(o, action, detail) {
  try { db.prepare(`INSERT INTO gzgrocery_order_log (order_id,order_no,action,mode,detail) VALUES (?,?,?,?,?)`)
    .run(o.orderId, o.orderNo, action, MODE, detail || null); } catch {}
}

// ── Resolution helpers ───────────────────────────────────────────────────────
let _storeId = null;
function resolveStoreId() {
  if (_storeId) return _storeId;
  if (process.env.GZGROCERY_STORE_ID) return (_storeId = Number(process.env.GZGROCERY_STORE_ID));
  // The Guanyi map is keyed by the same Tianhe retail store — reuse it.
  const row = db.prepare(`SELECT retail_store_id AS id FROM guanyi_product_map WHERE store_code=? LIMIT 1`).get(STORE_CODE)
           || db.prepare(`SELECT id FROM retail_stores WHERE store_code=? OR code=? LIMIT 1`).get(STORE_CODE, STORE_CODE);
  if (!row) throw new Error(`cannot resolve Tianhe store id for store_code=${STORE_CODE} (set GZGROCERY_STORE_ID)`);
  return (_storeId = row.id);
}
// sku (UPPERCASE) -> { productId, sku }
function loadSkuMap() {
  const map = new Map();
  for (const r of db.prepare(`SELECT id, sku, name_en, name_cn FROM store_products WHERE sku IS NOT NULL AND sku <> ''`).all()) {
    const raw = String(r.sku).trim();
    const m = /\b(\d+-\d+[A-Za-z]?)\b/.exec(raw);
    if (!m) continue;
    const key = m[1].toUpperCase();
    // The same numeric code can appear on a canonical product ('3-251') AND on a
    // wrapped "sample" twin ('S(3-251)'). The canonical SKU — where the whole SKU
    // IS the code — must win, otherwise a later-iterated twin clobbers the real
    // product and orders decrement (and mis-price) the wrong row.
    const canonical = raw.toUpperCase() === key;
    const existing = map.get(key);
    if (existing && existing.canonical && !canonical) continue;
    map.set(key, { productId: r.id, sku: r.sku, name_en: r.name_en, name_cn: r.name_cn, canonical });
  }
  return map;
}

function curQty(storeId, productId) {
  const r = db.prepare(`SELECT physical_qty FROM retail_store_stock WHERE store_id=? AND product_id=?`).get(storeId, productId);
  return r ? r.physical_qty : 0;
}

// ── retail_orders mirror (combined orders view) ──────────────────────────────
// gzgrocery is a wholesale pickup channel: its authoritative revenue stays the
// Guanyi/order-read LEDGER (guanyiPickupSales), which the dashboard folds in and
// which excludes channel='gzgrocery' from its retail_orders sums. These mirror
// rows are DISPLAY-ONLY — they let gzgrocery orders show, read-only, in the
// combined admin orders list alongside mini-app / web / Meituan. One row per
// gzgrocery order that contains our products; order_no = 'GZ-<orderId>' (stable,
// unique, no collision with R…/MT… numbers). Idempotent — safe to re-run.
const GZ_MIRROR = (process.env.GZGROCERY_MIRROR_ORDERS || 'on').toLowerCase() !== 'off';

// Per-unit price on the SAME basis as guanyiPickupSales so the orders-list total
// and the Sales/dashboard revenue agree: GZ wholesale price → retail → sell.
let _gzPriceStmt = undefined;
function gzUnitPrice(productId) {
  if (_gzPriceStmt === undefined) {
    const hasPricing = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='guanyi_product_pricing'`).get();
    _gzPriceStmt = db.prepare(hasPricing
      ? `SELECT COALESCE(pp.excel_gz_price, pp.excel_retail, sp.sell_price, 0) AS owed
           FROM store_products sp LEFT JOIN guanyi_product_pricing pp ON pp.product_id = sp.id WHERE sp.id=?`
      : `SELECT COALESCE(sp.sell_price, 0) AS owed FROM store_products sp WHERE sp.id=?`);
  }
  const r = _gzPriceStmt.get(productId);
  return r ? Number(r.owed) || 0 : 0;
}

function parseGzDateMs(s) {
  if (!s) return null;
  let m = /(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
  m = /(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
  return null;
}
function gzPlacedAt(dateAdded) {
  const ms = parseGzDateMs(dateAdded);
  return ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : null;
}
function gzMirrorOrderNo(orderId) { return 'GZ-' + orderId; }

// Upsert the display-only retail_orders row for one gzgrocery order. `voided`
// flips an existing mirror to 'cancelled' (and never creates a new row for an
// order that was cancelled before we ever counted it).
function ensureGzMirror({ orderId, status, customer, dateAdded, ours, storeId, voided, shipTo }) {
  if (!GZ_MIRROR || MODE !== 'live') return;
  if (!ours || !ours.length) return;
  const roNo = gzMirrorOrderNo(orderId);
  const existing = db.prepare('SELECT id, status FROM retail_orders WHERE order_no=?').get(roNo);
  // Ship-to for the mirror. Before we read the dispatch note the only "customer"
  // available was their masked list cell, which fell through to the order id —
  // so recipient_name held "140078". Prefer the real recipient; keep the old
  // fallback only for an order whose dispatch note we couldn't read.
  const shipName  = (shipTo && shipTo.recipientName) || null;
  const shipPhone = (shipTo && shipTo.recipientPhone) || null;
  const shipAddr  = (shipTo && shipTo.addressFull) || null;
  const shipJson  = shipTo ? shipToJson(shipTo, { source: 'gzgrocery_dispatch_note' }) : null;
  // gzgrocery orders are already fulfilled (picked/collected) by the time we
  // mirror them — this channel is read-only for us — so show them as delivered,
  // not merely paid.
  const mStatus = voided ? 'cancelled' : 'delivered';
  if (existing) {
    if (existing.status !== mStatus) {
      db.prepare('UPDATE retail_orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(mStatus, existing.id);
    }
    // Self-heal a mirror written before we read ship-to: fill the blanks and
    // overwrite the placeholder name (the order id echoed back). A hand-edited
    // name that is NOT the placeholder is left alone.
    if (shipName || shipPhone || shipAddr) {
      // Fill blanks, replace the placeholder name (the order id echoed back),
      // and refresh an address written by an OLDER parser generation — the
      // first one left overseas numbers unparsed, so the raw line (name and
      // phone included) ended up as the address. A hand-edited name, and an
      // address already read by the current parser, are left alone.
      //
      // The name also gets replaced when it CONTAINS the mobile we just parsed.
      // That is the pre-ship-to blob: on the orders whose list cell wasn't
      // masked, the whole "Name (phone) address…" string was stored as the
      // recipient. A person's name never contains their own phone number, so
      // this can only hit the blob — and a real name typed by hand survives.
      const stale = `COALESCE(address_json,'') = '' OR address_json NOT LIKE '%"p":${SHIPTO_PARSER}%'`;
      db.prepare(`UPDATE retail_orders SET
           recipient_name  = CASE WHEN COALESCE(recipient_name,'') IN ('', ?)
                                    OR (? IS NOT NULL AND instr(COALESCE(recipient_name,''), ?) > 0)
                                  THEN COALESCE(?, recipient_name) ELSE recipient_name END,
           recipient_phone = CASE WHEN COALESCE(recipient_phone,'') = '' THEN COALESCE(?, recipient_phone) ELSE recipient_phone END,
           address_full    = CASE WHEN ${stale} THEN COALESCE(?, address_full) ELSE address_full END,
           address_json    = CASE WHEN ${stale} THEN COALESCE(?, address_json) ELSE address_json END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`)
        .run(String(orderId), shipPhone, shipPhone, shipName, shipPhone, shipAddr, shipJson, existing.id);
    }
    return;
  }
  if (voided) return;  // never counted, already void → nothing to show

  let subtotal = 0;
  const lines = ours.map((it) => {
    const owed = gzUnitPrice(it.product_id);
    const line = +(owed * it.qty).toFixed(2);
    subtotal += line;
    // Persist the SKU we matched on (from the OpenCart model), not just
    // product_id. The order-detail drawer coalesces oi.sku → p.sku, but that
    // join returns nothing once a product is deleted or re-SKU'd — so a mirror
    // that only stored product_id shows "no SKU". oi.sku is the SKU that was
    // actually ordered and survives catalogue churn.
    return { product_id: it.product_id, sku: it.sku || null, name_cn: it.name_cn || null, name_en: it.name_en || null, qty: it.qty, unit_price: owed, line_total: line };
  });
  subtotal = +subtotal.toFixed(2);
  const placedAt = gzPlacedAt(dateAdded);

  db.transaction(() => {
    const r = db.prepare(`INSERT INTO retail_orders
        (order_no, status, payment_method, subtotal, total, recipient_name, recipient_phone,
         address_full, address_json,
         store_id, channel, fulfillment_type, placed_at, paid_at)
      VALUES (?, 'delivered', 'gzgrocery', ?, ?, ?, ?, ?, ?, ?, 'gzgrocery', 'delivery',
              COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`)
      .run(roNo, subtotal, subtotal,
        (shipName || customer || '').slice(0, 200) || null, shipPhone,
        shipAddr, shipJson, storeId, placedAt, placedAt);
    const oid = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO retail_order_items
      (order_id, product_id, sku, name_cn, name_en, qty, unit_price, line_total) VALUES (?,?,?,?,?,?,?,?)`);
    for (const l of lines) ins.run(oid, l.product_id, l.sku, l.name_cn, l.name_en, l.qty, l.unit_price, l.line_total);
  })();
  log(`mirrored ${roNo} → retail_orders (channel=gzgrocery, ¥${subtotal}, ${lines.length} line(s))`);
}

// One-time (idempotent) backfill so existing gzgrocery orders show in the list
// immediately, not only new ones. Runs at startup in live mode.
function backfillGzMirrors(storeId) {
  if (!GZ_MIRROR || MODE !== 'live') return;
  let made = 0;
  const rows = db.prepare(`SELECT order_id, status, customer, date_added, items_json, reversed
                             FROM gzgrocery_orders WHERE decremented=1 AND our_units>0`).all();
  for (const row of rows) {
    let ours = [];
    try { ours = JSON.parse(row.items_json || '[]'); } catch { ours = []; }
    if (!ours.length) continue;
    const had = db.prepare('SELECT 1 FROM retail_orders WHERE order_no=?').get(gzMirrorOrderNo(row.order_id));
    ensureGzMirror({ orderId: row.order_id, status: row.status, customer: row.customer,
      dateAdded: row.date_added, ours, storeId, voided: !!row.reversed });
    if (!had) made++;
  }
  if (made) log(`backfill: mirrored ${made} existing gzgrocery order(s) into retail_orders`);
}

// One-time (idempotent) repair for mirrors created before we persisted oi.sku.
// Those rows left retail_order_items.sku NULL and leaned on the detail-drawer's
// p.sku join, which shows "no SKU" whenever the product was later deleted or
// re-SKU'd. Refill the blanks from the SKU we recorded in gzgrocery_orders.
// items_json (matched by product_id) — the SKU that was actually ordered.
function backfillGzMirrorSkus() {
  if (!GZ_MIRROR || MODE !== 'live') return;
  let fixed = 0;
  const upd = db.prepare(
    `UPDATE retail_order_items SET sku=? WHERE order_id=? AND product_id=? AND COALESCE(sku,'')=''`
  );
  const rows = db.prepare(`SELECT order_id, items_json FROM gzgrocery_orders WHERE our_units>0`).all();
  const tx = db.transaction(() => {
    for (const row of rows) {
      let ours = [];
      try { ours = JSON.parse(row.items_json || '[]'); } catch { ours = []; }
      if (!ours.length) continue;
      const mirror = db.prepare('SELECT id FROM retail_orders WHERE order_no=?').get(gzMirrorOrderNo(row.order_id));
      if (!mirror) continue;
      // Best SKU per product_id from the stored line items.
      const bySku = new Map();
      for (const it of ours) { if (it.product_id && it.sku && !bySku.has(it.product_id)) bySku.set(it.product_id, it.sku); }
      for (const [pid, sku] of bySku) fixed += upd.run(sku, mirror.id, pid).changes;
    }
  });
  tx();
  if (fixed) log(`backfill: filled SKU on ${fixed} mirrored gzgrocery line item(s)`);
}

// Backfill ship-to onto orders imported before we read the dispatch note. Those
// rows carry no customer at all — their recipient_name is the order id, echoed
// back from the masked list cell. Runs a slice per cycle (not one big burst:
// this is someone else's admin and each order is a separate page load) and
// stops on its own once every order has been attempted. address_json is the
// "attempted" marker — written on every SUCCESSFUL read, even one that parsed
// nothing, so an order whose note genuinely has no address isn't retried
// forever, while a network failure IS.
// Parser generation, stamped into address_json as "p". Bump it when the ship-to
// PARSER changes and every order re-reads itself once, then stops: the first
// version missed overseas numbers written "(+85291943231)", which left the name
// and phone unparsed and the raw line — number and all — sitting in the address.
// Without a generation there is no way to tell "already read" from "already read
// by the version that got it wrong".
const SHIPTO_PARSER    = 3;
const SHIPTO_PER_CYCLE = Number(process.env.GZGROCERY_SHIPTO_PER_CYCLE || 40);
const SHIPTO_GAP_MS    = Number(process.env.GZGROCERY_SHIPTO_GAP_MS || 400);
function shipToJson(shipTo, extra) {
  return JSON.stringify({
    region: shipTo.region || '', street: shipTo.street || '',
    postcode: shipTo.postcode || '', contacter: shipTo.contacter || '',
    p: SHIPTO_PARSER, ...extra,
  });
}
async function backfillShipTo(client, storeId) {
  if (MODE !== 'live' || SHIPTO_PER_CYCLE <= 0) return;
  const rows = db.prepare(
    `SELECT order_id, status, customer, date_added, items_json, reversed, decremented
       FROM gzgrocery_orders
      WHERE our_units > 0
        AND (COALESCE(address_json,'') = '' OR address_json NOT LIKE '%"p":${SHIPTO_PARSER}%')
      ORDER BY order_id DESC LIMIT ?`
  ).all(SHIPTO_PER_CYCLE);
  if (!rows.length) return;
  let done = 0, failed = 0;
  for (const row of rows) {
    let shipTo;
    try { shipTo = await client.fetchOrderShipTo(row.order_id); }
    catch (e) { failed++; log(`ship-to backfill ${row.order_id} failed: ${e.message}`); await sleep(SHIPTO_GAP_MS); continue; }
    db.prepare(
      `UPDATE gzgrocery_orders SET recipient_name=?, recipient_phone=?, address_full=?, address_json=?,
              updated_at=CURRENT_TIMESTAMP WHERE order_id=?`
    ).run(shipTo.recipientName || null, shipTo.recipientPhone || null, shipTo.addressFull || null,
      shipToJson(shipTo), row.order_id);
    // Push the same ship-to onto the display mirror the drawer reads. Only for
    // orders we actually counted — same gate as backfillGzMirrors. An order that
    // was never decremented (e.g. its status never parsed, so it never went
    // ACTIVE) has no mirror on purpose, and filling in an address is not a
    // reason to invent one and show it in the list as delivered.
    let ours = [];
    try { ours = JSON.parse(row.items_json || '[]'); } catch { ours = []; }
    if (ours.length && row.decremented) {
      try {
        ensureGzMirror({ orderId: row.order_id, status: row.status, customer: row.customer,
          dateAdded: row.date_added, ours, storeId, voided: !!row.reversed, shipTo });
      } catch (e) { log(`ship-to mirror ${row.order_id} failed: ${e.message}`); }
    }
    done++;
    await sleep(SHIPTO_GAP_MS);
  }
  log(`ship-to backfill: ${done} filled, ${failed} failed (${rows.length} attempted this cycle)`);
}

// Match an order's line items against our catalogue → the OUR-product units.
function matchOurItems(items, skuMap) {
  const ours = [];
  for (const it of items) {
    const sku = extractSku(it.model);   // Model field only — see extractSku notes
    if (!sku) continue;
    const hit = skuMap.get(sku);
    if (!hit) continue;
    ours.push({ ...it, sku, product_id: hit.productId, name_en: hit.name_en, name_cn: hit.name_cn, matched: true });
  }
  return ours;
}

// ── Core: reconcile one order against stored state ───────────────────────────
function processOrder(o, items, skuMap, storeId, shipTo) {
  const ours = matchOurItems(items, skuMap);
  const ourUnits = ours.reduce((s, x) => s + x.qty, 0);
  const prev = db.prepare(`SELECT * FROM gzgrocery_orders WHERE order_id=?`).get(o.orderId);
  const isActive = ACTIVE.has(o.status);
  const isVoid   = VOID.has(o.status);

  const upsert = (fields) => {
    const base = {
      order_id: o.orderId, order_no: o.orderNo, status: o.status, total: o.total,
      customer: o.customer, date_added: o.dateAdded, delivery_time: o.deliveryTime,
      items_json: JSON.stringify(ours), our_units: ourUnits, mode: MODE,
      decremented: prev?.decremented || 0, reversed: prev?.reversed || 0, note: null,
      // Ship-to read off the dispatch note. A cycle that didn't (or couldn't)
      // fetch it keeps whatever we stored before — never blank a known address.
      recipient_name:  shipTo?.recipientName  || prev?.recipient_name  || null,
      recipient_phone: shipTo?.recipientPhone || prev?.recipient_phone || null,
      address_full:    shipTo?.addressFull    || prev?.address_full    || null,
      address_json:    shipTo ? shipToJson(shipTo) : (prev?.address_json || null),
      ...fields,
    };
    db.prepare(`INSERT INTO gzgrocery_orders
      (order_id,order_no,status,total,customer,date_added,delivery_time,items_json,our_units,decremented,reversed,mode,note,recipient_name,recipient_phone,address_full,address_json,updated_at)
      VALUES (@order_id,@order_no,@status,@total,@customer,@date_added,@delivery_time,@items_json,@our_units,@decremented,@reversed,@mode,@note,@recipient_name,@recipient_phone,@address_full,@address_json,CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET status=@status,total=@total,customer=@customer,delivery_time=@delivery_time,
        items_json=@items_json,our_units=@our_units,decremented=@decremented,reversed=@reversed,mode=@mode,note=COALESCE(@note,note),
        recipient_name=COALESCE(@recipient_name,recipient_name),recipient_phone=COALESCE(@recipient_phone,recipient_phone),
        address_full=COALESCE(@address_full,address_full),address_json=COALESCE(@address_json,address_json),updated_at=CURRENT_TIMESTAMP
    `).run(base);
  };

  // No products of ours in this order — record & move on.
  if (!ours.length) { upsert({ note: 'no Roots products' }); return { result: 'skip-foreign' }; }

  const alreadyDecremented = prev?.decremented;
  const alreadyReversed    = prev?.reversed;

  // (1) Active + not yet counted → decrement.
  if (isActive && !alreadyDecremented) {
    const applied = [];
    for (const it of ours) {
      const cur = curQty(storeId, it.product_id);
      const next = Math.max(0, cur - it.qty);
      if (MODE === 'live') {
        adjustStock({
          storeId, productId: it.product_id, newPhysicalQty: next,
          actorLabel: 'gzgrocery-order', reason: 'gzgrocery_order',
          note: `gzgrocery order ${o.orderNo || o.orderId}: ${it.sku} ×${it.qty} (${cur}→${next})`,
        });
      }
      applied.push(`${it.sku}×${it.qty}(${cur}→${next})`);
    }
    upsert({ decremented: 1, note: `${MODE}: decremented ${applied.join(', ')}` });
    auditLog(o, MODE === 'live' ? 'decremented' : 'would_decrement', applied.join(', '));
    log(`order ${o.orderNo || o.orderId} [${o.status}] ${MODE === 'live' ? 'DECREMENTED' : 'would decrement'}: ${applied.join(', ')}`);
    // Push a WeCom card listing only our line items (fire-and-forget, never blocks).
    notifyOrder(o, ours.map((it) => ({ name_en: it.name_en, name_cn: it.name_cn, sku: it.sku, qty: it.qty })))
      .catch((e) => console.error('[gzgrocery-orders] notify failed:', e.message));
    // Display-only mirror into retail_orders so this shows in the combined list.
    try { ensureGzMirror({ orderId: o.orderId, status: o.status, customer: o.customer, dateAdded: o.dateAdded, ours, storeId, voided: false, shipTo }); }
    catch (e) { log(`mirror ${o.orderNo || o.orderId} failed: ${e.message}`); }
    return { result: 'decremented', units: ourUnits };
  }

  // (2) Void after we counted → reverse (add back).
  if (isVoid && alreadyDecremented && !alreadyReversed) {
    const applied = [];
    for (const it of ours) {
      const cur = curQty(storeId, it.product_id);
      const next = cur + it.qty;
      if (MODE === 'live') {
        adjustStock({
          storeId, productId: it.product_id, newPhysicalQty: next,
          actorLabel: 'gzgrocery-order', reason: 'gzgrocery_order_reverse',
          note: `gzgrocery order ${o.orderNo || o.orderId} ${o.status}: +${it.sku} ×${it.qty} (${cur}→${next})`,
        });
      }
      applied.push(`${it.sku}+${it.qty}(${cur}→${next})`);
    }
    upsert({ reversed: 1, note: `${MODE}: reversed (${o.status}) ${applied.join(', ')}` });
    auditLog(o, MODE === 'live' ? 'reversed' : 'would_reverse', applied.join(', '));
    log(`order ${o.orderNo || o.orderId} [${o.status}] ${MODE === 'live' ? 'REVERSED' : 'would reverse'}: ${applied.join(', ')}`);
    // Flip the display mirror to cancelled so the list reflects the void.
    try { ensureGzMirror({ orderId: o.orderId, status: o.status, customer: o.customer, dateAdded: o.dateAdded, ours, storeId, voided: true, shipTo }); }
    catch (e) { log(`mirror-void ${o.orderNo || o.orderId} failed: ${e.message}`); }
    return { result: 'reversed', units: ourUnits };
  }

  // (3) Nothing to do (pending, or already in desired state) — keep state fresh.
  upsert({ note: prev?.note || `seen [${o.status}]` });
  return { result: alreadyDecremented ? 'noop-counted' : (isActive ? 'noop' : `waiting [${o.status}]`) };
}

// ── One poll cycle ───────────────────────────────────────────────────────────
let _client = null;
let _backfilledMirrors = false;
async function runCycle() {
  if (MODE === 'off') { if (ONCE) log('MODE=off — nothing to do'); return; }
  // gzgrocery channel closed from the Sales grid (channel_status, tianhe-only)?
  // Pause — don't import/decrement its orders until reopened. Absent row = open.
  try {
    const cs = db.prepare("SELECT is_open FROM channel_status WHERE channel='gzgrocery' AND store_code='tianhe'").get();
    if (cs && cs.is_open === 0) { if (ONCE) log('gzgrocery channel closed — paused'); return; }
  } catch (e) { /* table missing on older DB → treat as open */ }
  const storeId = resolveStoreId();
  // One-time backfill so pre-existing gzgrocery orders appear in the list.
  if (!_backfilledMirrors) {
    _backfilledMirrors = true;
    try { backfillGzMirrors(storeId); } catch (e) { log(`backfill failed: ${e.message}`); }
    try { backfillGzMirrorSkus(); } catch (e) { log(`sku backfill failed: ${e.message}`); }
  }
  const skuMap  = loadSkuMap();
  _client = _client || new GzGroceryAdmin();
  const orders = await _client.fetchOrders({ maxPages: MAX_PAGES, sinceDays: SINCE_DAYS });
  const baseline = resolveBaseline(orders);
  log(`fetched ${orders.length} recent order(s) (mode=${MODE}, store=${STORE_CODE}, baseline>${baseline})`);

  let dec = 0, rev = 0, foreign = 0, seeded = 0, errs = 0;
  for (const o of orders) {
    try {
      const prev = db.prepare(`SELECT decremented,reversed,status,our_units,items_json FROM gzgrocery_orders WHERE order_id=?`).get(o.orderId);
      // Pre-existing backlog (≤ baseline, never seen) → seed as counted, no
      // item fetch, no stock action — it was handled before we started.
      if (!prev && o.orderId <= baseline) { seedBacklog(o); seeded++; continue; }
      // Already fetched once and held no Roots products. An order's line items
      // never change after placement, so don't waste a detail request re-checking it.
      if (prev && prev.our_units === 0 && prev.items_json === '[]') { foreign++; continue; }
      // Only spend a detail request when state may change.
      const needItems =
        (ACTIVE.has(o.status) && !prev?.decremented) ||
        (VOID.has(o.status) && prev?.decremented && !prev?.reversed) ||
        !prev; // first sighting → record line items for the audit trail
      if (!needItems) continue;
      const items = await _client.fetchOrderItems(o.orderId);
      // Ship-to comes off a SECOND page (the dispatch note), so only spend that
      // request when the order actually holds our products — most gzgrocery
      // orders are pure third-party grocery and we'd be reading a stranger's
      // address for nothing. A failure here must not lose the stock decrement,
      // so it degrades to "no ship-to this cycle" and the backfill retries.
      let shipTo = null;
      if (items.some((it) => extractSku(it.model))) {
        try { shipTo = await _client.fetchOrderShipTo(o.orderId); }
        catch (e) { log(`order ${o.orderId} ship-to failed: ${e.message}`); }
      }
      const r = processOrder(o, items, skuMap, storeId, shipTo);
      if (r.result === 'decremented') dec++;
      else if (r.result === 'reversed') rev++;
      else if (r.result === 'skip-foreign') foreign++;
    } catch (e) {
      errs++;
      log(`order ${o.orderId} error: ${e.message}`);
      auditLog(o, 'error', e.message);
    }
  }
  log(`cycle done: ${dec} decremented, ${rev} reversed, ${foreign} non-Roots, ${seeded} backlog-seeded, ${errs} error(s)`);
  // Fill ship-to on the historic orders, a slice at a time, after the live work.
  try { await backfillShipTo(_client, storeId); } catch (e) { log(`ship-to backfill failed: ${e.message}`); }
}

// Record a pre-baseline order as already-counted without touching stock.
function seedBacklog(o) {
  db.prepare(`INSERT INTO gzgrocery_orders
    (order_id,order_no,status,total,customer,date_added,delivery_time,items_json,our_units,decremented,reversed,mode,note)
    VALUES (?,?,?,?,?,?,?,?,0,1,0,?,?)
    ON CONFLICT(order_id) DO NOTHING`)
    .run(o.orderId, o.orderNo, o.status, o.total, o.customer, o.dateAdded, o.deliveryTime, '[]', MODE, 'pre-existing backlog (seeded, not decremented)');
  auditLog(o, 'seeded', `backlog ${o.status}`);
}

async function main() {
  ensureTables();
  log(`starting (mode=${MODE}, poll=${POLL_MS}ms, store=${STORE_CODE}, active=${ACTIVE.size} void=${VOID.size})`);
  if (MODE !== 'off' && (!process.env.GZGROCERY_ADMIN_USER || !process.env.GZGROCERY_ADMIN_PASS)) {
    log('⚠ GZGROCERY_ADMIN_USER/PASS not set — cannot log in'); if (ONCE) process.exit(1);
  }
  if (ONCE) { await runCycle().catch(e => { log(`fatal: ${e.stack || e.message}`); process.exitCode = 1; }); return; }
  for (;;) {
    try { await runCycle(); } catch (e) { log(`cycle fatal: ${e.message}`); }
    await sleep(POLL_MS);
  }
}

main();
