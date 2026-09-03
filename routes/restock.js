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
// ONE READ OF ONE SETTING. The three-tier guess this replaces is recorded in
// docs/tacet-stock-movement-schema.md A4/B7, and each tier is dropped for its
// own reason:
//
//   Tier 1 read `SELECT value FROM settings` — a table that does not exist in
//   this schema, is created by nothing, and had no writer anywhere in the
//   repository. The read always threw and always fell through, so the "explicit
//   override" never overrode anything. This IS that tier, on a table that is
//   real and a key something can write.
//
//   Tier 2 took a warehouse-role user's bound store off control-plane `users`
//   and used it as a tenant `retail_stores.id` — a cross-plane reference the
//   file's own comment already flagged.
//
//   Tier 3 picked whichever active store held the most stock. The day a second
//   warehouse exists it silently picks whichever happens to be fuller, and
//   nothing on any screen says a guess was made. It is also wrong BEFORE that
//   day: a store that has just taken a large delivery can outweigh the warehouse.
//   Guessing the source of a stock movement is worse than refusing to move it.
//
// UNSET RETURNS NULL AND THE CALLER REFUSES, naming the setting. That is the
// intended behaviour, not a gap: no guess is better than a wrong one.
//
// THE READ IS ON tdb(), THE TENANT HANDLE, AND THAT IS THE WHOLE POINT.
// `storefront_config` is data-plane (absent from lib/tenant-db.js's
// CONTROL_PLANE_TABLES), so it is cloned per tenant and each tenant carries its
// own warehouse. A read on the shared handle would hand EVERY tenant Roots'
// warehouse and move their stock at a location they do not own — the same class
// of bug as the :333 stamp, which is why assertion 19 of the test plan exists.
//
// `cfgValue` in routes/retail.js is not exported, so this is its four-line twin
// rather than a require that would close a cycle (retail.js requires this file's
// siblings). Same table, same tdb(), same JSON shape.
function _cfgWarehouseStoreId() {
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'stock.warehouseStoreId'").get();
    if (!row) return null;
    const id = parseInt(JSON.parse(row.value_json), 10);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch { return null; }   // table absent on an older tenant file, or bad JSON
}

function _resolveWarehouseStoreId() {
  return _cfgWarehouseStoreId();
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
// Everything both halves need, resolved once and identically: the order, the
// two locations and the connection every read and write runs on.
//
// `conn` is captured ONCE and used for the order row, the lines, the catalogue
// check, the transaction boundary and the stamps. adjustStock resolves the same
// connection through tdb(), so the outer boundary and the inner writes are
// provably on one handle whatever tenant scope we run in. The bug this shape
// prevents is on record: the stamp used to be written through the shared global
// `db` from inside a transaction opened on the tenant handle, so for any
// non-Roots tenant it landed in a different database file, matched zero rows,
// reported success, and left the idempotency guard permanently disengaged.
//
// Returns { ok: false, error } — caller returns it verbatim
//      or { skipped: 'reason' } — nothing to do, correctly
//      or { conn, o, label, warehouseStoreId, destStoreId }
function _transferContext(orderId) {
  const conn = tdb();
  const o = conn.prepare('SELECT * FROM restock_orders WHERE id = ?').get(orderId);
  if (!o) return { ok: false, error: 'That restock order no longer exists. No stock was moved.' };
  // Kitchen direction uses ingredient inventory, not per-store retail stock.
  if (o.to_role === 'kitchen' || o.from_role === 'kitchen') return { skipped: 'kitchen_direction' };

  const label = o.rs_number || ('RS#' + o.id);
  const warehouseStoreId = _resolveWarehouseStoreId();
  // NAME THE SETTING. This is the refusal that replaces the most-stock guess,
  // and a message saying only "could not work out the locations" would send an
  // operator looking for a broken order instead of an unset setting.
  if (!warehouseStoreId) {
    console.warn(`[restock-transfer] ${label}: stock.warehouseStoreId is not set — stock not moved`);
    return {
      ok: false,
      error: 'No stock was moved because this business has not said which location is its warehouse. Set stock.warehouseStoreId to the warehouse\'s location id, then try again.',
    };
  }
  const destStoreId = _resolveDestStoreId(o, warehouseStoreId);
  if (!destStoreId || warehouseStoreId === destStoreId) {
    console.warn(`[restock-transfer] ${label}: cannot resolve destination ` +
      `(warehouse=${warehouseStoreId}, dest=${destStoreId}) — stock not moved`);
    return { ok: false, error: 'Could not work out which location the goods arrive at, so no stock was moved. Check the receiving store on this order, then try again.' };
  }
  return { conn, o, label, warehouseStoreId, destStoreId };
}

// ── OUT half — the warehouse's shelf, at dispatch ──────────────────────────
//
// Fires when the warehouse packs the order (status → 'prepared', where the whole
// movement used to fire). Moves the SENT quantity out of the warehouse and puts
// it nowhere: between this and the receipt the units are IN TRANSIT, belonging
// to neither location, derived from the order rather than stored anywhere.
//
// All or nothing. Every line's decrement, every ledger row and the
// `dispatched_at`/`goods_state` stamp share ONE transaction on `conn`.
// adjustStock opens its own transaction per call and better-sqlite3 nests those
// as savepoints, so a throw anywhere — including a ledger insert that cannot be
// written — unwinds the whole dispatch and leaves it retryable.
//
// Never throws. Idempotent on `dispatched_at`, which is only ever set by a
// dispatch that fully applied.
function _applyDispatch(orderId, actorUser) {
  const ctx = _transferContext(orderId);
  if (ctx.ok === false || ctx.skipped) return ctx.skipped ? { ok: true, skipped: ctx.skipped } : ctx;
  const { conn, o, label, warehouseStoreId, destStoreId } = ctx;

  // Idempotency, three ways, because they answer three different questions.
  if (o.dispatched_at) return { ok: true, skipped: 'already_dispatched' };
  if (o.goods_state && o.goods_state !== 'none') return { ok: true, skipped: 'already_dispatched' };
  // BELT AND BRACES FOR TENANT DATABASES. The goods_state backfill
  // (restock_goods_state_backfill_v1) runs against the main database only —
  // lib/tenant-db.js's reconcileTenantColumns adds the COLUMN to a tenant file
  // and its DEFAULT, but never runs a main-database data migration. So a tenant
  // whose orders moved stock under the old one-step model can carry
  // stock_applied_at with goods_state 'none', and without this check a dispatch
  // would move those units a second time.
  if (o.stock_applied_at) return { ok: true, skipped: 'already_applied_old_model' };

  const lines = conn.prepare(`
    SELECT product_id, product_name, qty_requested, qty_sent
      FROM restock_items
     WHERE restock_id = ?
       AND product_id IS NOT NULL
       AND COALESCE(qty_sent, qty_requested, 0) > 0
  `).all(o.id).filter(it => _sentQty(it) > 0);
  if (!lines.length) return { ok: true, skipped: 'no_lines' };

  // Refuse the whole dispatch if any line's product cannot be matched across the
  // two catalogues — same all-or-nothing rule as a mid-transfer failure.
  const problems = _checkTransferIds(lines, conn);
  if (problems.length) {
    console.warn(`[restock-dispatch] ${label}: refused — ${problems.length} line(s) failed the catalogue check`);
    return { ok: false, error: 'No stock was moved, because some lines could not be matched to the store catalogue. ' + problems.join(' ') };
  }

  try {
    const moved = conn.transaction(() => {
      let n = 0;
      for (const it of lines) {
        inventory.adjustStock({
          storeId: warehouseStoreId, productId: it.product_id, deltaQty: -_sentQty(it),
          actorUserId: actorUser?.id || null, actorLabel: 'restock',
          reason: 'restock_transfer_out', note: label,
          // PROVENANCE — the ledger row now names the order that caused it, so
          // "has the OUT half for this transfer already been written?" is a
          // query rather than a string match on `note`. See lib/inventory.js.
          refTable: 'restock_orders', refId: o.id,
        });
        n++;
      }
      conn.prepare(`UPDATE restock_orders
                       SET goods_state = 'in_transit', dispatched_at = CURRENT_TIMESTAMP
                     WHERE id = ?`).run(o.id);
      return n;
    })();
    console.log(`[restock-dispatch] ${label}: ${moved} line(s) left store ${warehouseStoreId} for ${destStoreId}`);
    return { ok: true, moved };
  } catch (e) {
    console.error(`[restock-dispatch] ${label}: failed and rolled back —`, e.message);
    return {
      ok: false,
      error: 'No stock was moved. The dispatch was stopped and everything was put back, so nothing has changed. Try again, and if it keeps failing tell whoever looks after the system: ' + e.message,
    };
  }
}

// What the warehouse actually sent. NULL qty_sent means "the warehouse did not
// override", so the requested figure stands — the existing convention (A2), kept.
function _sentQty(it) {
  return (it.qty_sent != null) ? Number(it.qty_sent) : Number(it.qty_requested);
}

// ── IN half — the store's shelf, at confirmed receipt ──────────────────────
//
// WHAT THE STORE COUNTS IS WHAT THE STORE HOLDS (§39). The RECEIVED quantity
// sets stock, never the dispatched one: a short delivery becomes 47 at the store
// immediately, not 50. If the record preferred the warehouse's number to the
// counter's, the shelf and the record would part company and the store would be
// the one to find out.
//
// Short AND over are both accepted without blocking — no reason field, no
// confirmation step. The discrepancy stays legible on the transfer (asked, sent,
// counted are three columns on one row) and is the warehouse's to look at.
//
// EVERY LINE MUST BE COUNTED FIRST. A line still at NULL is one nobody has
// looked at, and settling around it would silently write off whatever was in
// that box. The caller reports how many remain.
//
// Never throws. Idempotent on `received_confirmed_at`, independently of the
// outbound stamp — that independence is the whole point of two stamps.
function _applyReceipt(orderId, actorUser) {
  const ctx = _transferContext(orderId);
  if (ctx.ok === false || ctx.skipped) return ctx.skipped ? { ok: true, skipped: ctx.skipped } : ctx;
  const { conn, o, label, destStoreId } = ctx;

  if (o.received_confirmed_at) return { ok: true, skipped: 'already_received' };
  if (o.goods_state !== 'in_transit') {
    return { ok: false, error: 'This transfer has not been dispatched yet, so there is nothing to receive. The warehouse marks it prepared when the goods leave.' };
  }

  const all = conn.prepare(`
    SELECT id, product_id, product_name, qty_requested, qty_sent, qty_received
      FROM restock_items
     WHERE restock_id = ? AND product_id IS NOT NULL AND COALESCE(qty_sent, qty_requested, 0) > 0
  `).all(o.id);
  const uncounted = all.filter(it => it.qty_received == null);
  if (uncounted.length) {
    return {
      ok: false, uncounted: uncounted.length, counted: all.length - uncounted.length, total: all.length,
      error: `${uncounted.length} of ${all.length} lines have not been counted yet. Count every line, then confirm the receipt.`,
    };
  }

  // The catalogue can drift between dispatch and receipt — hours apart now — so
  // this runs on BOTH halves rather than once at dispatch.
  const problems = _checkTransferIds(all, conn);
  if (problems.length) {
    console.warn(`[restock-receipt] ${label}: refused — ${problems.length} line(s) failed the catalogue check`);
    return { ok: false, error: 'No stock was moved, because some lines could not be matched to the store catalogue. ' + problems.join(' ') };
  }

  try {
    const moved = conn.transaction(() => {
      let n = 0;
      for (const it of all) {
        const qty = Number(it.qty_received);
        // A counted ZERO is a real observation and settles the line, but it moves
        // nothing — the ledger records movements, and there is no movement to
        // record. The discrepancy lives on the row (sent 12, counted 0), which is
        // where a person reads it.
        if (!(qty > 0)) continue;
        inventory.adjustStock({
          storeId: destStoreId, productId: it.product_id, deltaQty: qty,
          actorUserId: actorUser?.id || null, actorLabel: 'restock',
          reason: 'restock_transfer_in', note: label,
          refTable: 'restock_orders', refId: o.id,
        });
        n++;
      }
      conn.prepare(`UPDATE restock_orders
                       SET goods_state = 'settled', received_confirmed_at = CURRENT_TIMESTAMP
                     WHERE id = ?`).run(o.id);
      return n;
    })();
    console.log(`[restock-receipt] ${label}: ${moved} line(s) landed at store ${destStoreId}`);
    return { ok: true, moved };
  } catch (e) {
    // Rolled back: no stock moved AND no stamp, so the order stays in_transit
    // and the receipt can be retried once the cause is fixed.
    console.error(`[restock-receipt] ${label}: failed and rolled back —`, e.message);
    return {
      ok: false,
      error: 'No stock was moved. The receipt was stopped and everything was put back, so nothing has changed. Try again, and if it keeps failing tell whoever looks after the system: ' + e.message,
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
  // OUTBOUND HALF ONLY, and only at 'prepared' — the moment stock physically
  // leaves the warehouse shelf. What arrives at the store is settled separately,
  // by whoever counts it (PUT /api/restock/:id/receive).
  //
  // 'delivered' NO LONGER MOVES STOCK, and that is the one behavioural change to
  // an existing transition. It used to re-run the whole transfer as a "safety
  // net", made harmless only by the stamp. Under two steps that net is wrong
  // rather than redundant: delivered means the driver handed the boxes over,
  // which is not the same event as someone counting them, and at Roots the two
  // are near-simultaneous while on a longer route they are not. The status keeps
  // its meaning and its timestamp — it simply records the driver's leg ending
  // (§39 ruling 5). The idempotency it used to provide now lives on the receipt
  // endpoint's own guard.
  let transfer = null;
  if (status === 'prepared') {
    transfer = _applyDispatch(order.id, req.user);
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

// ── Retry a dispatch that failed ───────────────────────────────────────────
//
// THE GAP THIS FILLS. Under the old one-step model a failed transfer was
// retried by the 'delivered' transition, which re-ran the whole thing as a
// safety net. 'delivered' now moves no stock, and STATUS_FLOW refuses a
// backward move, so an order whose dispatch rolled back sits at status
// 'prepared' with goods_state 'none' and NOTHING REACHES _applyDispatch AGAIN.
// The function was always retryable — its guards rolled back with the stock —
// what was missing is a door, and this is the door.
//
// THE PICKER OPENS IT HIMSELF. Same permission as the dispatch he already had
// (requireRestockOrInbox — the identical middleware the status endpoint uses),
// no manager, no unlock, no second person. The transaction rolled back cleanly
// and nothing is half-done, so the alternative is a warehouse worker standing
// with cold boxes hunting for someone with a password.
//
// ONLY WHERE A DISPATCH GENUINELY DID NOT HAPPEN. _applyDispatch's three guards
// — goods_state, dispatched_at, and the old stock_applied_at — are the same
// three that protect it everywhere else, and they are what makes a retry
// incapable of moving stock twice. They are NOT re-implemented here: this
// endpoint delegates, so the two paths can never drift apart on what "already
// dispatched" means.
//
// AND IT IS ITSELF IDEMPOTENT. Two taps on a bad connection is one dispatch:
// the second call meets dispatched_at and reports that the goods already left,
// as a success rather than an error — because from the picker's side it IS one,
// and an error would send him looking for a problem that does not exist.
router.post('/api/restock/:id/retry-dispatch', requireAuth, requireRestockOrInbox, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });

  // A RETRY IMPLIES AN ATTEMPT. An order still at draft/sent/received has never
  // been packed, so there is nothing to retry and dispatching it here would
  // bypass the request lifecycle — the warehouse would not have picked it yet.
  // Refused rather than silently dispatching, which would make this endpoint a
  // second, quieter way to send goods.
  if (STATUS_FLOW.indexOf(order.status) < STATUS_FLOW.indexOf('prepared')) {
    return res.status(409).json({
      error: 'not_dispatched_yet',
      message: 'This order has not been packed yet, so there is nothing to retry. Mark it prepared when the goods are ready to leave.',
    });
  }

  const result = _applyDispatch(order.id, req.user);

  // Already gone. The common second-tap case, and a success from where the
  // picker is standing.
  if (result.ok && (result.skipped === 'already_dispatched' || result.skipped === 'already_applied_old_model')) {
    return res.json({
      success: true, retried: false, already: true, stock_moved: false,
      goods_state: order.goods_state,
      message: 'These goods have already left the warehouse. Nothing was moved again.',
    });
  }
  if (result.ok && result.skipped === 'kitchen_direction') {
    return res.json({
      success: true, retried: false, stock_moved: false,
      message: 'This is a kitchen order, which does not move store stock.',
    });
  }
  if (result.ok && result.skipped === 'no_lines') {
    return res.status(409).json({
      error: 'no_lines',
      message: 'There is nothing on this order to send. Add a quantity to at least one line first.',
    });
  }
  // Failed again — the cause is still there. The message from _applyDispatch
  // already names it in plain words, so it is passed through rather than
  // replaced by a code the picker would have to look up.
  if (result.ok === false) {
    return res.status(409).json({ error: 'retry_failed', stock_moved: false, message: result.error });
  }

  _broadcastRestock(order.id, 'prepared', req.user.id);
  res.json({
    success: true, retried: true, stock_moved: true, moved: result.moved || 0,
    goods_state: 'in_transit',
    message: `Sent. ${result.moved || 0} line${result.moved === 1 ? '' : 's'} left the warehouse.`,
  });
});

// ── Mark item prepared (warehouse side) ────────────────────────────────────
router.put('/api/restock/:id/item/:item_id', requireAuth, requireRestockOrInbox, (req, res) => {
  const item = tdb().prepare('SELECT * FROM restock_items WHERE id = ? AND restock_id = ?').get(req.params.item_id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found · 项目未找到' });
  // ONCE THE GOODS HAVE LEFT, THE LINES ARE FROZEN.
  //
  // In-transit is DERIVED from these rows rather than stored in a counter
  // (docs/tacet-stock-movement-schema.md B3), which is what makes it impossible
  // for the two to disagree — but it also means editing a line after dispatch
  // retroactively changes a quantity that has already moved. The ledger's OUT
  // rows would not follow, so the derived total and the ledger would part
  // company with nothing to reconcile them.
  //
  // The honest fix is to refuse the edit, not to store a counter. A quantity
  // that turns out wrong after the van left is a RECEIPT discrepancy — counted
  // against sent — which is exactly what the receipt endpoint records.
  const order = tdb().prepare('SELECT goods_state FROM restock_orders WHERE id = ?').get(req.params.id);
  if (order && order.goods_state && order.goods_state !== 'none') {
    return res.status(409).json({
      error: 'These goods have already left the warehouse, so the lines can no longer be changed. Record what actually arrived when you confirm the receipt.',
    });
  }
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

// ── Confirm receipt (store side) ───────────────────────────────────────────
//
// A NEW ENDPOINT RATHER THAN A SIXTH STATUS, and the reason is structural.
// `STATUS_FLOW` is strictly ordered and `toIdx <= fromIdx` is refused, so a
// `receipt_confirmed` value would mean a store confirming receipt BEFORE the
// warehouse marked `delivered` gets rejected — and at Roots the driver marking
// delivered and the store counting are genuinely concurrent. A strictly ordered
// request lifecycle cannot express two lifecycles that interleave, which is why
// the goods live in their own column and settle through their own door.
//
// Body: { counts: [{ item_id, qty_received }, …] }
//
// Counts are SAVED whether or not they complete the order, so a partial count
// survives the person putting the phone down — that is the resumable count the
// receiving screens are built around. Settlement happens only when every line
// carries a figure.
//
// NULL AND ZERO: passing 0 counts the line as "none arrived". Omitting the line
// leaves it NULL — nobody looked. The endpoint will not settle around a NULL.
router.put('/api/restock/:id/receive', requireAuth, requireRestockOrInbox, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });

  // THE STATE IS CHECKED BEFORE ANY COUNT IS WRITTEN, and the order matters.
  // Writing first would let a count land on an order that never left the
  // warehouse, and — worse — let a second call overwrite qty_received on an
  // order already settled, silently changing a recorded count after the stock
  // it justified had moved. The row and the ledger would then disagree with
  // nothing to reconcile them.
  if (order.received_confirmed_at || order.goods_state === 'settled') {
    return res.json({ success: true, settled: true, already: true, counts_written: 0 });
  }
  if (order.goods_state !== 'in_transit') {
    return res.status(409).json({
      error: 'This transfer has not been dispatched yet, so there is nothing to receive. The warehouse marks it prepared when the goods leave.',
      counts_written: 0,
    });
  }

  const counts = Array.isArray(req.body && req.body.counts) ? req.body.counts : [];
  // Written on the tenant handle, in one transaction, before anything is
  // settled: a rejected settlement must still keep the numbers the counter
  // typed, or they retype them.
  const conn = tdb();
  const setCount = conn.prepare('UPDATE restock_items SET qty_received = ? WHERE id = ? AND restock_id = ?');
  let written = 0;
  try {
    conn.transaction(() => {
      for (const c of counts) {
        const itemId = Number(c && c.item_id);
        const qty = Number(c && c.qty_received);
        // A count is a number, including zero. Anything else is not a count and
        // is skipped rather than written as 0 — which would be an observation
        // nobody made.
        if (!itemId || !Number.isFinite(qty) || qty < 0) continue;
        written += setCount.run(qty, itemId, order.id).changes;
      }
    })();
  } catch (e) {
    return res.status(500).json({ error: 'Could not save the counts: ' + e.message });
  }

  const receipt = _applyReceipt(order.id, req.user);
  if (receipt.ok === false) {
    // An incomplete count is not an error the operator did — it is the ordinary
    // state of a count in progress, so it comes back 200 with the tally. A real
    // refusal (never dispatched, catalogue mismatch, rollback) is a 409.
    if (receipt.uncounted) {
      return res.json({
        success: true, settled: false, counts_written: written,
        counted: receipt.counted, total: receipt.total, message: receipt.error,
      });
    }
    return res.status(409).json({ error: receipt.error, counts_written: written });
  }
  if (receipt.skipped === 'already_received') {
    return res.json({ success: true, settled: true, already: true, counts_written: written });
  }
  // BROADCAST AS 'delivered', DELIBERATELY, AND IT IS A NAMING DEBT.
  // _broadcastRestock's audience map is keyed on (direction, kind) and returns
  // undefined — silently sending nothing — for a kind it does not know. A new
  // 'received' kind would therefore have to land in the map AND in the front
  // ends that act on it, and front-end work is out of scope this round. Sending
  // 'delivered' reaches the warehouse_inbox audience, which is exactly who wants
  // to know a transfer was counted. Rename it when the receipt screens ship.
  _broadcastRestock(order.id, 'delivered', req.user.id);
  res.json({ success: true, settled: true, counts_written: written, moved: receipt.moved || 0 });
});

// ── In-transit, DERIVED ────────────────────────────────────────────────────
//
// Never stored. A stored counter would be a third place a quantity lives,
// incremented by one code path and decremented by another hours later, with a
// crash between them leaving it wrong forever and nothing to reconcile it
// against. This form CANNOT disagree with the rows it is derived from.
//
// No pseudo-location either: a `retail_stores` row called "In transit" would
// appear in every store picker, every stock report and every channel
// availability sweep, and `_resolveDestStoreId`'s "exactly one active store that
// isn't the warehouse" rule would silently break. §39 says in-transit stock
// belongs to NEITHER location, and a row in the locations table is a location.
//
// Cost is one indexed join over orders currently on a van — single digits at
// Roots. `idx_restock_goods_state` serves the filter.
function inTransitByProduct(conn = tdb()) {
  try {
    return conn.prepare(`
      SELECT ri.product_id, SUM(COALESCE(ri.qty_sent, ri.qty_requested)) AS qty_in_transit
        FROM restock_items ri
        JOIN restock_orders ro ON ro.id = ri.restock_id
       WHERE ro.goods_state = 'in_transit'
         AND ri.product_id IS NOT NULL
       GROUP BY ri.product_id
    `).all();
  } catch (e) { return []; }
}

router.get('/api/restock/in-transit', requireAuth, requireRestockOrInbox, (req, res) => {
  res.json({ success: true, data: inTransitByProduct() });
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
