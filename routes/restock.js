const express = require('express');
// `db` is the shared global handle (always Roots). Use it ONLY for
// control-plane tables — `users` here, and `activity_log` via logActivity.
// Those live once in the shared database for every tenant and are never
// cloned (lib/tenant-db.js CONTROL_PLANE_TABLES).
const db = require('../database');
const inventory = require('../lib/inventory');
// The request-scoped tenant connection, and the one inventory.adjustStock
// writes through. EVERY data-plane table this file touches — restock_orders,
// restock_items, markets, products, store_products, retail_stores,
// retail_store_stock — must go through it. For Roots/kitchen sessions tdb()
// is a seam wrapper (lib/db-seam.js) over the SAME connection as `db`, so this
// is a behavioural no-op today; it closes the cross-tenant split before data
// isolation is switched on.
const { tdb } = require('../lib/tenant-db');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// Web Push fan-out for restock state changes — no-op until VAPID keys
// + HTTPS are in place (push.ENABLED === false on plain HTTP). Lazy-load
// so a missing module never breaks the rest of the routes.
let _push = null;
try { _push = require('./push'); } catch (e) { console.warn('[restock] push module not available:', e.message); }
// Server-Sent Events fan-out — works on plain HTTP. Sub-second
// notifications to any open dashboard / restock PWA tab.
let _events = null;
try { _events = require('./events'); } catch (e) { console.warn('[restock] events module not available:', e.message); }
function _broadcastRestock(orderId, kind, actorUserId) {
  if (!_events || !_events.broadcast) return;
  try {
    const o = tdb().prepare(`SELECT id, rs_number, store_name, store_cn, status, created_by,
      COALESCE(from_role,'store') AS from_role, COALESCE(to_role,'warehouse') AS to_role, purpose,
      (SELECT COUNT(*) FROM restock_items WHERE restock_id = restock_orders.id) AS item_count
      FROM restock_orders WHERE id = ?`).get(orderId);
    if (!o) return;
    // Audience permission per (direction, kind):
    //   store→warehouse:    sent→warehouse_inbox, prepared→restock, delivered→warehouse_inbox
    //   warehouse→kitchen:  sent→kitchen_inbox,   prepared→warehouse_inbox  (no delivered — closure at prepared)
    //   warehouse→store:    sent→restock,         prepared→warehouse_inbox, delivered→warehouse_inbox
    // For warehouse→kitchen, `prepared` IS the closure: kitchen done
    // packing = the order is done; no warehouse delivery confirmation.
    const dir = `${o.from_role}->${o.to_role}`;
    const targetPerm = ({
      'store->warehouse':    { sent:'warehouse_inbox', prepared:'restock',         delivered:'warehouse_inbox' },
      'warehouse->kitchen':  { sent:'kitchen_inbox',   prepared:'warehouse_inbox' /* no delivered */            },
      'warehouse->store':    { sent:'restock',         prepared:'warehouse_inbox', delivered:'warehouse_inbox' },
    })[dir]?.[kind];
    if (!targetPerm) return;
    const payload = {
      kind, id: o.id, rs_number: o.rs_number,
      store_name: o.store_name, store_cn: o.store_cn,
      item_count: o.item_count || 0,
      status: o.status, created_by: o.created_by,
      from_role: o.from_role, to_role: o.to_role, purpose: o.purpose,
      ts: Date.now(),
    };
    // For warehouse↔store events affecting the store side (sent and
    // delivered to the store user), narrow the audience to JUST users
    // assigned to that specific store via users.market_id. This is
    // the per-location routing — Jing at Yuexiu only sees Yuexiu's
    // events, not stuff bound for other stores. Falls back to the
    // permission-only broadcast if the store can't be matched (e.g.
    // legacy free-text store names with no markets row).
    const isStoreSideEvent = (dir === 'warehouse->store' && (kind === 'sent' || kind === 'delivered'));
    if (isStoreSideEvent && o.store_name) {
      const loc = tdb().prepare(`
        SELECT id FROM markets
         WHERE COALESCE(is_active,1)=1
           AND (LOWER(TRIM(name))=LOWER(TRIM(?)) OR (name_cn IS NOT NULL AND TRIM(name_cn)=TRIM(?)))
         LIMIT 1
      `).get(o.store_name, o.store_cn || o.store_name);
      if (loc?.id) {
        // `users` is control-plane (shared across tenants), so it stays on `db`
        // while the `markets` row above came from the tenant handle. The join is
        // by users.market_id, a plain integer with no FK — pre-existing, and it
        // is why a tenant's markets ids and the shared users table have to be
        // kept in step. Not changed here; see the handle audit notes.
        const userIds = db.prepare('SELECT id FROM users WHERE market_id = ? AND COALESCE(is_active,1) = 1').all(loc.id).map(r => r.id);
        if (userIds.length === 0) {
          // No one assigned yet — broadcast to the perm so admin still
          // sees it (better than silently swallowing the event).
          _events.broadcast('restock', payload, { perms: [targetPerm], excludeUserId: actorUserId });
          return;
        }
        // Ship one event per matched user — `events.broadcast` doesn't
        // accept multi-user targets natively; this loop is fine since
        // realistically there are <5 users per store.
        userIds.forEach(uid => {
          if (uid === actorUserId) return;
          _events.broadcast('restock', payload, { userId: uid });
        });
        return;
      }
    }
    _events.broadcast('restock', payload, { perms: [targetPerm], excludeUserId: actorUserId });
  } catch (e) { console.warn('[broadcastRestock]', e.message); }
}
function _fireRestockPush(orderId, kind) {
  if (!_push || !_push.ENABLED) return;
  try {
    const o = tdb().prepare(`SELECT id, rs_number, store_name, store_cn, status,
      COALESCE(from_role,'store')   AS from_role,
      COALESCE(to_role,'warehouse') AS to_role
      FROM restock_orders WHERE id = ?`).get(orderId);
    if (!o) return;
    const label  = o.rs_number || ('#' + o.id);
    const store  = o.store_name || o.store_cn || '';
    // Item summary — first 3 lines with their quantities. Lets the notification
    // tell you at a glance "5 items: 3×Hummus, 2×Tortilla…" instead of just "From store".
    const items = tdb().prepare(`SELECT product_name, product_cn, qty_requested
                              FROM restock_items WHERE restock_id = ? AND qty_requested > 0
                              ORDER BY id`).all(orderId);
    const count = items.length;
    const totalQty = items.reduce((s, i) => s + (i.qty_requested || 0), 0);
    const top = items.slice(0, 3)
      .map(i => Math.round(i.qty_requested) + '×' + (i.product_cn || i.product_name || '?'))
      .join(', ');
    const summary = count === 0
      ? ''
      : `${count} item${count === 1 ? '' : 's'} · ${Math.round(totalQty)} units${top ? ': ' + top + (count > 3 ? '…' : '') : ''}`;
    const compose = (lead) => [lead, summary].filter(Boolean).join(' · ');
    let title, body, perm;
    // Each event targets the side that NEEDS to act — store sends a new
    // request → warehouse_inbox needs to know; warehouse marks prepared
    // → store-side `restock` perm needs to know it's ready to pick up;
    // store confirms delivery → warehouse_inbox needs the close-out.
    // Pick the permission set to ping based on the order's
    // direction. Same `kind` for both flows — only the audience changes.
    const isToKitchen = o.to_role === 'kitchen';
    if (kind === 'sent') {
      title = isToKitchen ? `🔔 New kitchen request · 厨房新请求 ${label}` : `🔔 New restock · 新补货请求 ${label}`;
      body  = compose(store ? `From ${store}` : (isToKitchen ? 'From warehouse' : 'From store'));
      perm  = isToKitchen ? 'kitchen_inbox' : 'warehouse_inbox';
    } else if (kind === 'prepared') {
      title = `📦 ${label} ready to receive · 待收货`;
      body  = compose(store ? `Ready for ${store}` : 'Ready');
      perm  = isToKitchen ? 'warehouse_inbox' : 'restock';
    } else if (kind === 'delivered') {
      title = `✓ ${label} delivered · 已送达`;
      body  = compose(isToKitchen ? 'Confirmed by warehouse' : (store ? `Confirmed by ${store}` : 'Confirmed by store'));
      perm  = isToKitchen ? 'kitchen_inbox' : 'warehouse_inbox';
    } else { return; }
    // Opens the kitchen SPA, which carries the restock module. This pointed at
    // '/restock?order=N' until 2026-08-04; that page is gone, so the old URL
    // would 404 on a staff phone the moment the notification was tapped.
    _push.sendPushByPermission(perm, {
      title, body, url: '/', tag: 'rs-' + orderId + '-' + kind,
    });
  } catch (e) { console.warn('[fireRestockPush]', e.message); }
}

// Status pipeline. `delivered` is included so the warehouse mobile app can
// flip an order to "delivered" once the driver has actually handed it off.
// Older code may produce orders that stop at `prepared` — both are valid.
const STATUS_FLOW = ['draft', 'sent', 'received', 'prepared', 'delivered'];

// ─── Auto inventory transfer on ship ────────────────────────────────
// A restock order physically moves goods from the warehouse to a store.
// When the warehouse packs it (status → 'prepared', the moment stock
// actually leaves the shelf), we mirror that in the real sellable
// inventory: DEDUCT what was sent from the warehouse's retail_store_stock
// and ADD it to the receiving store's. Both sides go through
// inventory.adjustStock so the movement is ledgered AND channel
// availability (mini-app / web / Meituan) re-syncs for both locations.
//
// Notes:
//   • Uses qty_sent (what actually shipped) and falls back to
//     qty_requested when the warehouse didn't override the amount.
//   • warehouse↔kitchen is excluded — the kitchen runs on its own
//     ingredient inventory, not per-store retail stock.
//   • Idempotent via restock_orders.stock_applied_at — 'prepared' applies
//     it; a later 'delivered' is a no-op safety net.

// Resolve the warehouse (source) retail_stores.id — the location goods
// ship OUT of. Preference: explicit setting → a warehouse-role user's
// bound store → the store holding the most stock. null if undeterminable.
function _resolveWarehouseStoreId() {
  // (1) optional explicit override, for a future multi-warehouse world.
  // NOTE: there is no `settings` table in this schema — nothing creates one,
  // and this is its only reader in the repo — so this lookup always throws
  // "no such table" and falls through to (2). That was already true on the
  // shared handle; moving it to tdb() keeps it exactly as dead, but on the
  // right connection for when the table does arrive (it would be data-plane:
  // a warehouse id is a tenant's retail_stores id, not a global one).
  try {
    const s = tdb().prepare("SELECT value FROM settings WHERE key = 'restock.warehouseStoreId'").get();
    const id = s && parseInt(s.value, 10);
    if (id) return id;
  } catch { /* no settings table / row — fall through */ }
  // (2) the store a warehouse-role user is assigned to. `users` is
  // control-plane, so this one genuinely stays on the shared handle — but the
  // retail_store_id it returns is a TENANT retail_stores id. Pre-existing
  // cross-plane reference; not changed here.
  const wu = db.prepare(`
    SELECT retail_store_id FROM users
     WHERE role = 'warehouse' AND retail_store_id IS NOT NULL
     ORDER BY id LIMIT 1`).get();
  if (wu?.retail_store_id) return wu.retail_store_id;
  // (3) fallback: whichever active store carries the most on-hand stock.
  const top = tdb().prepare(`
    SELECT rss.store_id AS id, SUM(rss.physical_qty) AS q
      FROM retail_store_stock rss
      JOIN retail_stores s ON s.id = rss.store_id AND COALESCE(s.is_active,1) = 1
     GROUP BY rss.store_id ORDER BY q DESC LIMIT 1`).get();
  return top?.id || null;
}

// Resolve the receiving (destination) retail_stores.id. Never returns the
// warehouse itself. null → cannot resolve, caller skips + warns.
function _resolveDestStoreId(order, warehouseStoreId) {
  // 1. store_name / store_cn / code stamped on the order.
  if (order.store_name || order.store_cn) {
    const m = tdb().prepare(`
      SELECT id FROM retail_stores
       WHERE COALESCE(is_active,1) = 1
         AND (LOWER(TRIM(name_en)) = LOWER(TRIM(?))
              OR (name_cn IS NOT NULL AND TRIM(name_cn) = TRIM(?))
              OR LOWER(TRIM(code)) = LOWER(TRIM(?)))
       LIMIT 1`).get(order.store_name || '', order.store_cn || order.store_name || '', order.store_name || '');
    if (m?.id && m.id !== warehouseStoreId) return m.id;
  }
  // 2. store→warehouse: the requester's bound store is the destination.
  // `users` is control-plane — stays on the shared handle. Same cross-plane
  // caveat as (2) in _resolveWarehouseStoreId: the id it yields is a tenant's.
  if (order.from_role === 'store' && order.created_by) {
    const u = db.prepare('SELECT retail_store_id FROM users WHERE id = ?').get(order.created_by);
    if (u?.retail_store_id && u.retail_store_id !== warehouseStoreId) return u.retail_store_id;
  }
  // 3. fallback: exactly one active store that isn't the warehouse.
  const others = tdb().prepare(`
    SELECT id FROM retail_stores
     WHERE COALESCE(is_active,1) = 1 AND id != ?`).all(warehouseStoreId);
  if (others.length === 1) return others[0].id;
  return null;
}

// A restock line's product_id is a KITCHEN products.id, but every table this
// transfer writes is keyed on store_products.id (the catalogue fork repointed
// retail_store_stock's FK — database.js:3805-3823). The two tables are separate
// AUTOINCREMENT counters over ONE integer space, so an id only means the same
// thing on both sides for rows the fork seeded. For anything created since, the
// same integer points at a different product on each side — and because the FK
// is satisfied either way, nothing errors: the units simply land on the wrong
// product's shelf.
//
// So check every line before moving anything. A line is safe when its id exists
// in store_products AND, where both catalogues carry a SKU, the two SKUs match.
// A SKU is the operator's own code for a thing, so two rows sharing an id and
// disagreeing on the SKU are definitely not the same thing. Returns a list of
// plain-English problems; empty means every line is safe to move.
function _checkTransferIds(items, conn = tdb()) {
  const kitchenRow = conn.prepare('SELECT sku, name_en FROM products WHERE id = ?');
  const storeRow   = conn.prepare('SELECT sku, name_en FROM store_products WHERE id = ?');
  const problems = [];
  for (const it of items) {
    const kitchen = kitchenRow.get(it.product_id);
    const store   = storeRow.get(it.product_id);
    const name = it.product_name || kitchen?.name_en || ('product ' + it.product_id);
    if (!store) {
      problems.push(`${name} is not in the store catalogue, so there is no shelf to move it to.`);
      continue;
    }
    const kSku = kitchen?.sku == null ? '' : String(kitchen.sku).trim();
    const sSku = store.sku   == null ? '' : String(store.sku).trim();
    if (kSku && sSku && kSku !== sSku) {
      problems.push(`${name} does not match the store catalogue: the kitchen has ${kSku} and the store has ${sSku} under the same reference. Moving it would change the wrong product's stock.`);
    }
  }
  return problems;
}

// Apply a restock order's stock movement: OUT of the warehouse, IN to the
// receiving store, for every line, through inventory.adjustStock so each half
// is ledgered and every channel's availability re-syncs.
//
// All or nothing. Every line's decrement and increment, every ledger row, and
// the stock_applied_at stamp share ONE transaction, opened on the tenant
// connection adjustStock writes through. Every read and write below is on that
// same `conn`, so the guarantee holds for any tenant, not just Roots.
// adjustStock opens its own transaction per call; better-sqlite3 nests those as
// savepoints, so a throw anywhere — including a ledger insert that cannot be
// written — unwinds the whole transfer.
// It used to run each half as its own transaction and stamp stock_applied_at
// regardless of what happened, so a failure between the two halves took units
// out of the warehouse, never put them anywhere, marked the order complete, and
// logged a warning nobody reads. That loss was permanent.
//
// Returns one of:
//   { ok: true,  moved: n }            — applied and stamped
//   { ok: true,  skipped: 'reason' }   — nothing to do, correctly
//   { ok: false, error: 'message' }    — nothing moved, nothing stamped, retryable
// Never throws. Idempotent via stock_applied_at, which is now only ever set on
// a transfer that fully applied.
function _applyRestockTransfer(orderId, actorUser) {
  // Captured ONCE, up front, and used for every read and write in this
  // function — the order row, the lines, the catalogue check, the transaction
  // boundary and the stock_applied_at stamp. adjustStock resolves the same
  // connection through tdb(), so the outer boundary and the inner writes are
  // provably on one handle whatever tenant scope we run in.
  const conn = tdb();
  const o = conn.prepare('SELECT * FROM restock_orders WHERE id = ?').get(orderId);
  if (!o) return { ok: false, error: 'That restock order no longer exists. No stock was moved.' };
  // Kitchen direction uses ingredient inventory, not per-store retail stock.
  if (o.to_role === 'kitchen' || o.from_role === 'kitchen') return { ok: true, skipped: 'kitchen_direction' };
  // Idempotency — never move stock twice for the same order.
  if (o.stock_applied_at) return { ok: true, skipped: 'already_applied' };

  const label = o.rs_number || ('RS#' + o.id);
  const warehouseStoreId = _resolveWarehouseStoreId();
  const destStoreId = _resolveDestStoreId(o, warehouseStoreId);
  if (!warehouseStoreId || !destStoreId || warehouseStoreId === destStoreId) {
    console.warn(`[restock-transfer] ${label}: cannot resolve source/dest ` +
      `(warehouse=${warehouseStoreId}, dest=${destStoreId}) — stock not moved`);
    return { ok: false, error: 'Could not work out which location the goods leave from and which they arrive at, so no stock was moved. Set the warehouse and the receiving store, then try again.' };
  }

  const items = conn.prepare(`
    SELECT product_id, product_name, qty_requested, qty_sent
      FROM restock_items
     WHERE restock_id = ?
       AND product_id IS NOT NULL
       AND COALESCE(qty_sent, qty_requested, 0) > 0
  `).all(o.id);
  const lines = items.filter(it => {
    // Prefer qty_sent (what actually shipped); fall back to requested.
    const qty = (it.qty_sent != null) ? Number(it.qty_sent) : Number(it.qty_requested);
    return qty > 0;
  });
  if (!lines.length) return { ok: true, skipped: 'no_lines' };

  // Refuse the whole transfer if any line's product cannot be matched across
  // the two catalogues — same all-or-nothing rule as a mid-transfer failure.
  const problems = _checkTransferIds(lines, conn);
  if (problems.length) {
    console.warn(`[restock-transfer] ${label}: refused — ${problems.length} line(s) failed the catalogue check`);
    return {
      ok: false,
      error: 'No stock was moved, because some lines could not be matched to the store catalogue. ' + problems.join(' '),
    };
  }

  // One transaction on the connection adjustStock uses (captured above).
  try {
    const moved = conn.transaction(() => {
      let n = 0;
      for (const it of lines) {
        const qty = (it.qty_sent != null) ? Number(it.qty_sent) : Number(it.qty_requested);
        // − out of the warehouse
        inventory.adjustStock({
          storeId: warehouseStoreId, productId: it.product_id, deltaQty: -qty,
          actorUserId: actorUser?.id || null, actorLabel: 'restock',
          reason: 'restock_transfer_out', note: label,
        });
        // + into the receiving store
        inventory.adjustStock({
          storeId: destStoreId, productId: it.product_id, deltaQty: qty,
          actorUserId: actorUser?.id || null, actorLabel: 'restock',
          reason: 'restock_transfer_in', note: label,
        });
        n++;
      }
      // Inside the transaction, and only reached when every line applied.
      // This MUST be `conn`, the handle the transaction was opened on. It used
      // to be the shared global `db`, with a comment claiming the two were the
      // same handle — true only for Roots, where tdb() returns mainDb. For any
      // other tenant the stamp landed in a different database, outside this
      // transaction, so a rollback left the order marked as applied while no
      // stock had moved: the exact double-spend the idempotency guard exists
      // to prevent.
      conn.prepare('UPDATE restock_orders SET stock_applied_at = CURRENT_TIMESTAMP WHERE id = ?').run(o.id);
      return n;
    })();
    console.log(`[restock-transfer] ${label}: moved ${moved} line(s) store ${warehouseStoreId} → ${destStoreId}`);
    return { ok: true, moved };
  } catch (e) {
    // Rolled back: no stock moved, stock_applied_at still empty, so the
    // transfer can be run again once the cause is fixed.
    console.error(`[restock-transfer] ${label}: failed and rolled back —`, e.message);
    return {
      ok: false,
      error: 'No stock was moved. The transfer was stopped and everything was put back, so nothing has changed. Try again, and if it keeps failing tell whoever looks after the system: ' + e.message,
    };
  }
}

// Some endpoints are usable by either the store-side (restock perm) or
// the warehouse-side (warehouse_inbox perm). Reads and warehouse-side
// writes (status transition, item check-off, wh_notes) accept either.
// Admin always passes.
function requireRestockOrInbox(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const p = req.permissions || {};
  if (p.restock || p.warehouse_inbox || p.kitchen_inbox) return next();
  return res.status(403).json({ error: 'forbidden' });
}
// Decide which side of the two-sided workflow this user can ORIGINATE
// from. Three flows are supported:
//   store      → warehouse  (store user requests stock)
//   warehouse  → kitchen    (warehouse asks kitchen for items)
//   warehouse  → store      (warehouse pushes stock to a store)
// Warehouse users can explicitly target either kitchen or store via
// req.body.to_role; the kitchen path is the default for back-compat.
function _inferDirection(req) {
  // ORIGIN is decided by ROLE, not by the `warehouse_inbox` perm — a
  // store user (e.g. Retail Yuexiu) may have the perm so they can see
  // the Fulfill tab, but their own outgoing requests still flow
  // store→warehouse. Only `warehouse` and `admin` originate from the
  // warehouse side and need a kitchen/store destination chooser.
  const role = req.user?.role || '';
  const isWarehouseOrigin = (role === 'warehouse' || role === 'admin');
  const explicit = (req.body && req.body.to_role) ? String(req.body.to_role) : null;
  if (isWarehouseOrigin) {
    if (explicit === 'store')   return { from_role: 'warehouse', to_role: 'store'   };
    if (explicit === 'kitchen') return { from_role: 'warehouse', to_role: 'kitchen' };
    if (explicit === 'warehouse' && role === 'admin') {
      // Admin acting on behalf of a store — rare but supported.
      return { from_role: 'store', to_role: 'warehouse' };
    }
    // No explicit choice → default to kitchen (warehouse's daily flow).
    return { from_role: 'warehouse', to_role: 'kitchen' };
  }
  // Everyone else (including store users with warehouse_inbox perm)
  // sends requests to the warehouse.
  return { from_role: 'store', to_role: 'warehouse' };
}

// Suggest products to restock based on past cadence. For each product that's
// been restocked in the last 60 days, compute:
//   - avg_qty: rolling average qty per request
//   - last_date: most recent request date
//   - days_since_last: today − last_date
//   - typical_cadence: average gap between consecutive requests
// A product is "due" when days_since_last >= typical_cadence × 0.8.
// Score = days_since_last / typical_cadence, sorted descending.
function buildRestockSuggestions(daysWindow = 60) {
  const since = new Date(Date.now() - daysWindow * 86400000).toISOString().slice(0, 10);
  const rows = tdb().prepare(`
    SELECT ri.product_id, ri.product_name, ri.product_cn, ri.sku, ri.qty_requested AS qty,
           ri.unit, r.date
    FROM restock_items ri
    JOIN restock_orders r ON r.id = ri.restock_id
    WHERE r.date >= ? AND ri.qty_requested > 0 AND ri.product_id IS NOT NULL
    ORDER BY ri.product_id, r.date DESC
  `).all(since);
  if (!rows.length) return [];
  // Bucket by product
  const buckets = {};
  for (const r of rows) {
    if (!buckets[r.product_id]) {
      buckets[r.product_id] = {
        product_id: r.product_id, product_name: r.product_name, product_cn: r.product_cn,
        sku: r.sku, unit: r.unit, qtys: [], dates: [],
      };
    }
    buckets[r.product_id].qtys.push(r.qty);
    buckets[r.product_id].dates.push(r.date);
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const b of Object.values(buckets)) {
    if (b.dates.length < 2) {
      // Not enough history to predict cadence — only surface if last one was a while ago
      const days_since = Math.floor((new Date(today) - new Date(b.dates[0])) / 86400000);
      if (days_since >= 7) {
        out.push({
          ...b,
          avg_qty: Math.round((b.qtys.reduce((a,c)=>a+c,0) / b.qtys.length) * 10) / 10,
          last_date: b.dates[0], days_since_last: days_since, typical_cadence: null,
          score: days_since / 14, // Default cadence assumption
        });
      }
      continue;
    }
    // Compute gaps between consecutive requests (descending → ascending)
    const sorted = [...b.dates].sort();
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += (new Date(sorted[i]) - new Date(sorted[i-1])) / 86400000;
    }
    const cadence = totalGap / (sorted.length - 1);
    const last_date = sorted[sorted.length - 1];
    const days_since = Math.floor((new Date(today) - new Date(last_date)) / 86400000);
    const score = cadence > 0 ? days_since / cadence : 0;
    if (score < 0.8) continue; // not due yet
    out.push({
      ...b,
      avg_qty: Math.round((b.qtys.reduce((a,c)=>a+c,0) / b.qtys.length) * 10) / 10,
      last_date, days_since_last: days_since,
      typical_cadence: Math.round(cadence * 10) / 10,
      score: Math.round(score * 100) / 100,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

router.get('/api/restock/suggest', requireAuth, requirePermission('restock'), (req, res) => {
  const days = parseInt(req.query.days) || 60;
  res.json({ success: true, data: buildRestockSuggestions(days) });
});

function genRsNumber() {
  const d = new Date();
  const ymd = d.getFullYear().toString().slice(2) + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  const todayCount = tdb().prepare("SELECT COUNT(*) AS c FROM restock_orders WHERE substr(rs_number,4,6) = ?").get(ymd).c;
  return `RS-${ymd}-${String(todayCount + 1).padStart(3,'0')}`;
}

// ── Orders list (with item count + progress) ────────────────────────────────
router.get('/api/restock', requireAuth, requireRestockOrInbox, (req, res) => {
  const { status, tab, to_role, from_role } = req.query; // tab: active|history|all
  // Auto-archive sweep: on every `tab=active` fetch, soft-delete any
  // active (non-prepared/delivered/draft) order whose creation day in
  // Shanghai time is earlier than today. Keeps the Fulfill tab focused
  // on the current day's work — stale items go to the archive folder
  // (still recoverable via tab=archived). Server time is UTC; the +8h
  // offset gives us today's calendar day in the user's actual timezone.
  if (tab === 'active') {
    // Kitchen-bound requests are excluded — kitchen prep can legitimately
    // span days (slow ferments, multi-step recipes), so a "stale" sent
    // request to the kitchen is still real work, not noise. The original
    // sweep was designed for the store→warehouse Fulfill tab only.
    tdb().prepare(`
      UPDATE restock_orders
         SET archived_at = CURRENT_TIMESTAMP
       WHERE archived_at IS NULL
         AND status NOT IN ('prepared','delivered','draft')
         AND COALESCE(to_role, 'warehouse') != 'kitchen'
         AND date(created_at, '+8 hours') < date('now', '+8 hours')
    `).run();
  }
  let q = `
    SELECT r.*,
      (SELECT COUNT(*) FROM restock_items WHERE restock_id = r.id AND qty_requested > 0)  AS item_count,
      (SELECT COUNT(*) FROM restock_items WHERE restock_id = r.id AND is_checked = 1)     AS checked_count
    FROM restock_orders r
    WHERE 1=1`;
  const params = [];
  // Terminal status is direction-dependent:
  //   warehouse→kitchen: 'prepared' IS the closure (no delivered step)
  //   everything else:   only 'delivered' closes the loop — 'prepared'
  //                      is still waiting on the receiver to confirm
  //                      and belongs in Active.
  if (tab === 'active') {
    q += " AND NOT (r.status = 'delivered'"
       + "         OR (r.status = 'prepared' AND COALESCE(r.to_role,'warehouse') = 'kitchen'))";
  } else if (tab === 'history') {
    q += " AND (r.status = 'delivered'"
       + "      OR (r.status = 'prepared' AND COALESCE(r.to_role,'warehouse') = 'kitchen'))";
  }
  // Soft-delete filter: by default, hide archived rows from every tab.
  // `tab=archived` opts in to view archived (so a future "restore"
  // surface can list them). Activity log and admin queries are
  // unaffected — this filter is scoped to this endpoint.
  if (tab === 'archived')     q += ' AND r.archived_at IS NOT NULL';
  else                        q += ' AND r.archived_at IS NULL';
  if (status)                 { q += ' AND r.status = ?'; params.push(status); }
  // Direction filter: explicit query param wins, otherwise gate by perm.
  // Old clients without the param keep seeing store→warehouse (the
  // legacy default) so nothing breaks while UI catches up.
  if (to_role)   { q += " AND COALESCE(r.to_role,'warehouse') = ?";   params.push(to_role); }
  if (from_role) { q += " AND COALESCE(r.from_role,'store') = ?";     params.push(from_role); }
  q += ' ORDER BY r.created_at DESC, r.id DESC';
  res.json({ success: true, data: tdb().prepare(q).all(...params) });
});

// ── Single order with items ─────────────────────────────────────────────────
router.get('/api/restock/:id', requireAuth, requireRestockOrInbox, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  const items = tdb().prepare('SELECT * FROM restock_items WHERE restock_id = ? ORDER BY id').all(order.id);
  res.json({ success: true, data: { ...order, items } });
});

// ── Create order ───────────────────────────────────────────────────────────
// Both `restock` (store-side requests) and `warehouse_inbox` (warehouse
// requesting from kitchen) users can post here. The handler infers
// direction from perms — see _inferDirection — so a warehouse user
// hitting "Send" doesn't need a destination picker; their request
// always goes to the kitchen.
router.post('/api/restock', requireAuth, (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  const p = req.permissions || {};
  if (p.restock || p.warehouse_inbox) return next();
  return res.status(403).json({ error: 'forbidden' });
}, (req, res) => {
  const { date, store_name, store_cn, notes, items, status, purpose } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required · 至少需要一项' });

  const dir = _inferDirection(req);
  // Warehouse → kitchen requests must declare WHY: 'order' (need it to
  // ship a customer order) or 'shelf' (refill warehouse shelves).
  const cleanPurpose = (dir.to_role === 'kitchen' && (purpose === 'order' || purpose === 'shelf'))
    ? purpose : null;
  if (dir.to_role === 'kitchen' && !cleanPurpose) {
    return res.status(400).json({ error: 'purpose required for kitchen requests · 必须选择请求原因' });
  }
  // Warehouse → store push: store_name is optional today (single-store
  // world). When set, the notification broadcaster routes only to staff
  // assigned to that market; when null, it falls back to broadcasting
  // to every user with the `restock` permission. Reintroduce a hard
  // requirement here once a second retail store is added.

  const rs_number = genRsNumber();
  const today = date || new Date().toISOString().slice(0,10);
  const initialStatus = status === 'sent' ? 'sent' : 'draft';
  const sent_at = initialStatus === 'sent' ? new Date().toISOString() : null;

  // One handle for both statements and the transaction they run in.
  const conn = tdb();
  const insertOrder = conn.prepare(`INSERT INTO restock_orders
    (rs_number, date, status, store_name, store_cn, notes, sent_at, created_by, from_role, to_role, purpose)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItem = conn.prepare(`INSERT INTO restock_items
    (restock_id, product_id, product_name, product_cn, sku, qty_requested, unit, notes)
    VALUES (?,?,?,?,?,?,?,?)`);

  const tx = conn.transaction(() => {
    const result = insertOrder.run(rs_number, today, initialStatus, store_name || null, store_cn || null, notes || null, sent_at, req.user.id, dir.from_role, dir.to_role, cleanPurpose);
    const id = result.lastInsertRowid;
    items.forEach(it => {
      const qty = parseFloat(it.qty_requested) || 0;
      if (qty <= 0) return;
      insertItem.run(id, it.product_id || null, it.product_name || '', it.product_cn || null, it.sku || null, qty, it.unit || null, it.notes || null);
    });
    return id;
  });

  try {
    const id = tx();
    logActivity(req.user.id, req.user.username, 'create', 'restock', id, { rs_number, status: initialStatus }, req.ip);
    if (initialStatus === 'sent') {
      _fireRestockPush(id, 'sent');
      _broadcastRestock(id, 'sent', req.user.id);
    }
    res.json({ success: true, id, rs_number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update order (store can edit drafts; both sides can edit notes) ────────
router.put('/api/restock/:id', requireAuth, requireRestockOrInbox, (req, res) => {
  const conn = tdb();
  const order = conn.prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });

  const { date, store_name, store_cn, notes, wh_notes, items } = req.body;
  // Permission split: warehouse-side updates (wh_notes only) accepted from
  // either perm. Store-side fields (date/store_name/store_cn/notes/items)
  // require the broader `restock` perm so a warehouse-only user can't
  // accidentally rename or rewrite the order.
  const isAdmin = req.user.role === 'admin';
  const hasRestock = isAdmin || !!req.permissions?.restock;
  const wantsStoreSideEdit =
    date != null || store_name != null || store_cn != null || notes != null || Array.isArray(items);
  if (wantsStoreSideEdit && !hasRestock) {
    return res.status(403).json({ error: 'restock permission required for store-side edits · 此修改需要补货权限' });
  }
  // Items can only be replaced when the order is still a draft
  const replacingItems = Array.isArray(items);
  if (replacingItems && order.status !== 'draft') {
    return res.status(400).json({ error: 'Items can only be edited while the order is a draft · 草稿状态才能编辑项目' });
  }

  const tx = conn.transaction(() => {
    conn.prepare(`UPDATE restock_orders SET
      date = COALESCE(?, date),
      store_name = COALESCE(?, store_name),
      store_cn = COALESCE(?, store_cn),
      notes = COALESCE(?, notes),
      wh_notes = COALESCE(?, wh_notes)
      WHERE id = ?`).run(date || null, store_name || null, store_cn || null, notes || null, wh_notes || null, order.id);

    if (replacingItems) {
      conn.prepare('DELETE FROM restock_items WHERE restock_id = ?').run(order.id);
      const insert = conn.prepare(`INSERT INTO restock_items
        (restock_id, product_id, product_name, product_cn, sku, qty_requested, unit, notes)
        VALUES (?,?,?,?,?,?,?,?)`);
      items.forEach(it => {
        const qty = parseFloat(it.qty_requested) || 0;
        if (qty <= 0) return;
        insert.run(order.id, it.product_id || null, it.product_name || '', it.product_cn || null, it.sku || null, qty, it.unit || null, it.notes || null);
      });
    }
  });

  try {
    tx();
    logActivity(req.user.id, req.user.username, 'update', 'restock', order.id, null, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Status transition (sent / received / prepared / delivered) ─────────────
router.put('/api/restock/:id/status', requireAuth, requireRestockOrInbox, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  const { status } = req.body;
  if (!STATUS_FLOW.includes(status)) return res.status(400).json({ error: 'Invalid status · 状态无效' });

  const fromIdx = STATUS_FLOW.indexOf(order.status);
  const toIdx   = STATUS_FLOW.indexOf(status);
  if (toIdx <= fromIdx) return res.status(400).json({ error: `Cannot move backward 状态不能后退: ${order.status} → ${status}` });

  const now = new Date().toISOString();
  const tsCol = { sent:'sent_at', received:'received_at', prepared:'prepared_at', delivered:'delivered_at' }[status];
  tdb().prepare(`UPDATE restock_orders SET status = ?, ${tsCol} = ? WHERE id = ?`).run(status, now, order.id);

  logActivity(req.user.id, req.user.username, 'status_change', 'restock', order.id, { from: order.status, to: status }, req.ip);
  // Auto inventory transfer — fires once per order when the warehouse
  // packs it ('prepared' = stock physically leaves). Deducts what was
  // sent from the warehouse and adds it to the receiving store, both in
  // the real retail_store_stock. 'delivered' repeats the call as a safety
  // net; stock_applied_at makes the second call a no-op, so it can never
  // double-count.
  let transfer = null;
  if (status === 'prepared' || status === 'delivered') {
    transfer = _applyRestockTransfer(order.id, req.user);
  }
  // Push fan-out — only for the cross-side transitions the other party
  // actually needs to act on. `received` is internal warehouse state.
  if (status === 'sent' || status === 'prepared' || status === 'delivered') {
    _fireRestockPush(order.id, status);
    _broadcastRestock(order.id, status, req.user.id);
  }
  // The status change itself succeeded. When the stock movement did not, say so
  // in the response so the screen can put it in front of the person who just
  // pressed the button — it used to be a console warning only, which meant a
  // failed transfer looked exactly like a successful one.
  if (transfer && transfer.ok === false) {
    return res.json({ success: true, stock_transfer: { ok: false, error: transfer.error } });
  }
  res.json({ success: true });
});

// ── Mark item prepared (warehouse side) ────────────────────────────────────
router.put('/api/restock/:id/item/:item_id', requireAuth, requireRestockOrInbox, (req, res) => {
  const item = tdb().prepare('SELECT * FROM restock_items WHERE id = ? AND restock_id = ?').get(req.params.item_id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found · 项目未找到' });
  const { is_checked, qty_sent } = req.body;
  tdb().prepare(`UPDATE restock_items SET
    is_checked = COALESCE(?, is_checked),
    qty_sent   = COALESCE(?, qty_sent)
    WHERE id = ?`).run(
      is_checked == null ? null : (is_checked ? 1 : 0),
      qty_sent == null ? null : parseFloat(qty_sent),
      item.id
    );
  res.json({ success: true });
});

// ── Archive / unarchive ────────────────────────────────────────────────────
// Soft-delete toggle for inbox/history cleanup. POST body { archived: true }
// stamps archived_at = now; { archived: false } clears it. The row is
// preserved either way — this only flips the visibility flag the list
// endpoint filters on.
router.put('/api/restock/:id/archive', requireAuth, requireRestockOrInbox, (req, res) => {
  const order = tdb().prepare('SELECT id, archived_at FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  const wantArchived = req.body?.archived !== false;  // default true if omitted
  const ts = wantArchived ? new Date().toISOString() : null;
  tdb().prepare('UPDATE restock_orders SET archived_at = ? WHERE id = ?').run(ts, order.id);
  logActivity(req.user.id, req.user.username,
    wantArchived ? 'archive' : 'unarchive', 'restock', order.id, null, req.ip);
  res.json({ success: true, archived: !!wantArchived });
});

// ── Bulk archive ───────────────────────────────────────────────────────────
// One-click cleanup of an entire inbox tab. Body { tab: 'active'|'history' }
// flips archived_at for every non-archived row matching that tab. Soft-
// delete only — rows are preserved with a timestamp, no destruction.
router.post('/api/restock/archive-bulk', requireAuth, requireRestockOrInbox, (req, res) => {
  const tab = req.body?.tab;
  if (tab !== 'active' && tab !== 'history') {
    return res.status(400).json({ error: 'tab must be "active" or "history"' });
  }
  const statusFilter = tab === 'history'
    ? "status IN ('prepared','delivered')"
    : "status NOT IN ('prepared','delivered','draft')";  // drafts stay — they're not in the inbox view anyway
  const ts = new Date().toISOString();
  const result = tdb().prepare(
    `UPDATE restock_orders SET archived_at = ? WHERE archived_at IS NULL AND ${statusFilter}`
  ).run(ts);
  logActivity(req.user.id, req.user.username, 'archive-bulk', 'restock', 0, { tab, count: result.changes }, req.ip);
  res.json({ success: true, count: result.changes });
});

// ── Delete (drafts only) ───────────────────────────────────────────────────
router.delete('/api/restock/:id', requireAuth, requireDelete, requirePermission('restock'), (req, res) => {
  const conn = tdb();
  const order = conn.prepare('SELECT status FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  if (order.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be deleted · 仅草稿可删除' });
  conn.prepare('DELETE FROM restock_items WHERE restock_id = ?').run(req.params.id);
  conn.prepare('DELETE FROM restock_orders WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'restock', req.params.id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
