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
const { tdb, currentTenantId } = require('../lib/tenant-db');
// The shop's own day (decisions §82). This file took "today" as the UTC day
// and numbered requests off the host's clock, so between midnight and 08:00 in
// Guangzhou a request was dated, and numbered, the day before.
const businessDate = require('../lib/business-date');
const shopToday = () => businessDate.businessDate(businessDate.shopTimezone(tdb()));
// 'YYYY-MM-DD' minus whole days, as plain calendar arithmetic on the shop's day.
const shopDaysAgo = (n) => {
  const d = new Date(shopToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const { cfgValue } = require('../lib/store-config');
const { logActivity } = require('../middleware/auth');
// Lazily, and deliberately: routes/retail.js requires this file's siblings, so
// a top-level require here would close a cycle at load time.
const requireRetailAdmin = (req, res, next) => require('./retail').requireRetailAdmin(req, res, next);
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
// The kitchen's PAPER copy of the same event. A push reaches a phone; a kitchen
// is a room with wet hands and no phone on the bench, so the request also comes
// out of a thermal printer that beeps. Rides the store printers' existing
// Feieyun rail — see lib/kitchen-print.js for why it routes on its own SN
// rather than on `printer.by_store`. Best-effort and fire-and-forget: a request
// must never fail to reach the queue because a printer is offline.
const _kprint = require('../lib/kitchen-print');
// THE SAME EVENT, ON THE SUPPLIER'S OWN PRINTER (§198). A shop-to-shop request
// printed nowhere until now, and the comment above said why it was not owed a
// slip — "a store transfer has its own paper trail". It did not have one. This
// is that paper trail: the shops' existing `printer.by_store` map keyed on the
// request's own `from_store_id`, so nothing new is configured to get it.
const _tprint = require('../lib/transfer-print');
// "Which finished requests still count as news" — shared with routes/retail.js,
// which reads the same clause for the dashboard's Needs-you row. See the header
// of that file for why it is one definition and not two.
const _kready = require('../lib/kitchen-ready');
// "What today's batch owes" (§84). Beside _kready for the same reason: the
// arithmetic lives in one module because two surfaces ask for it.
const _owed = require('../lib/batch-owed');
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
/* WHO IS TOLD, AND ABOUT WHAT — the Tacet half of it, which did not exist.
 *
 * THE DEFECT. Every push on this route went through sendPushByPermission, which
 * reads `permissions` rows on the kitchen `users` table. That was the only realm
 * these endpoints had when the notifications were written. The screens moved to
 * Tacet (#261): the people who now raise a request, pick a run, dispatch it,
 * count it in and work the kitchen queue are `tenant_users` with CAPABILITIES,
 * subscribed in a different table (tenant_operator_push_subs). Not one of them
 * could be reached by a permission lookup in the other realm, so the kitchen was
 * never told a request had arrived, and neither end of a transfer was ever told
 * the goods were ready, gone, or counted. The pushes fired; nobody held the
 * permission they were addressed to.
 *
 * So the kitchen realm keeps exactly what it had — public/app.html is still a
 * client of these endpoints — and the same event now also fans out by
 * capability to the tenant's operators.
 *
 * (This named public/kitchen.html until §76 deleted that page. The realm still
 * has a client and the fan-out is unchanged; only the example moved.)
 *
 * THE AUDIENCE IS THE SIDE THAT MUST ACT NEXT, at the location the work is at.
 * from_store_id is where the goods come FROM and to_store_id where they go, in
 * every shape — a store asking the warehouse, the warehouse pushing a store, one
 * shop asking another (#264). So the map is keyed on the order's own direction
 * and reads its ends off the row rather than off who happened to press the
 * button. A kitchen request has no locations at all and is scoped by capability
 * alone.
 */
const PUSH_AUDIENCE = {
  'store->warehouse': {
    // Somebody asked. The location that HAS the stock picks it.
    sent:      { caps: 'restock:pick',    at: 'from', go: 'pick' },
    // Picked and dispatched — it is on its way to whoever asked.
    prepared:  { caps: 'restock:receive', at: 'to',   go: 'receive' },
    delivered: { caps: 'restock:pick',    at: 'from', go: '' },
    // Counted in at the far end. This is the close-out the sender waits for, and
    // it fired no push at all before — PUT /:id/receive told nobody.
    received:  { caps: 'restock:pick',    at: 'from', go: '' },
  },
  'warehouse->store': {
    // The warehouse pushes stock out: it raised this itself, so 'sent' is news
    // for the destination, not a job for the picker who just created it.
    sent:      { caps: 'restock:receive', at: 'to',   go: '' },
    prepared:  { caps: 'restock:receive', at: 'to',   go: 'receive' },
    delivered: { caps: 'restock:pick',    at: 'from', go: '' },
    received:  { caps: 'restock:pick',    at: 'from', go: '' },
  },
  'warehouse->kitchen': {
    // Ask the kitchen. The people who work the queue are the ones who make it.
    sent:      { caps: 'restock:fulfil',  at: null, go: 'queue' },
    // And 'prepared' IS the closure here — the food is made, and the person who
    // asked for it is the one waiting to hear so.
    //
    // IT NOW HAS A DOOR. This carried no `go` because there was no screen at the
    // asking end to open — the notification told somebody their hummus was made
    // and then handed them a launcher to go hunting through. `ready` is the list
    // of what the kitchen has finished and nobody has collected, which is the
    // thing the alert is about; it opens /m?to=kitchenready now, and did open
    // /stock?go=ready until §48 step 4 retired that app.
    prepared:  { caps: ['restock:request', 'restock:pick'], at: null, go: 'ready' },
  },
};

// The actor, as the id the operator subscription store is keyed on. A Tacet
// session's req.user IS the tenant_users row (requireRetailAdmin shims it), and
// a kitchen session's is a different table entirely — so only one of the two
// realms can be excluded from an operator fan-out, and the other must not be
// excluded by id collision.
function _actorOperatorId(req) {
  return req && req.restockRealm === 'tacet' && req.user ? req.user.id : null;
}

function _fireRestockPush(orderId, kind, actorTenantUserId) {
  if (!_push || !_push.ENABLED) return;
  try {
    const o = tdb().prepare(`SELECT id, rs_number, store_name, store_cn, status,
      from_store_id, to_store_id,
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
    // THE ENDS BY NAME. store_name is free text a caller may not have set at all,
    // and on a store→store ask it names neither end usefully. The ids are the
    // order's own, so where they are set the notification says which shelf.
    const nameOf = (id) => {
      if (!id) return '';
      try {
        const r = tdb().prepare('SELECT name_en, name_cn FROM retail_stores WHERE id = ?').get(id);
        return r ? (r.name_en || r.name_cn || '') : '';
      } catch (e) { return ''; }
    };
    const fromName = nameOf(o.from_store_id) || (o.from_role === 'warehouse' ? 'the warehouse' : store);
    const toName   = nameOf(o.to_store_id)   || (o.to_role === 'kitchen' ? 'the kitchen' : store);

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
      // WHICH END IS WORTH NAMING IS THE END THE READER IS NOT AT. A picker
      // being asked for a run needs to know who it is for; a store being told
      // stock is coming needs to know where from. store_name is free text a
      // caller may never have set — on a store→store ask it names neither end —
      // so the order's own locations answer first and it is the fallback.
      const pushedOut = o.from_role === 'warehouse' && o.to_role === 'store';
      body  = compose(isToKitchen ? (store ? `From ${store}` : 'From warehouse')
                    : pushedOut   ? (fromName ? `From ${fromName}` : 'From warehouse')
                    : toName      ? `For ${toName}`
                    : (store ? `From ${store}` : 'From store'));
      perm  = isToKitchen ? 'kitchen_inbox' : 'warehouse_inbox';
    } else if (kind === 'prepared') {
      title = isToKitchen
        ? `👩‍🍳 ${label} is made · 制作完成`
        : `📦 ${label} ready to receive · 待收货`;
      body  = compose(isToKitchen ? 'The kitchen has finished it' : (toName ? `On its way to ${toName}` : 'Ready'));
      perm  = isToKitchen ? 'warehouse_inbox' : 'restock';
    } else if (kind === 'delivered') {
      title = `✓ ${label} delivered · 已送达`;
      body  = compose(isToKitchen ? 'Confirmed by warehouse' : (store ? `Confirmed by ${store}` : 'Confirmed by store'));
      perm  = isToKitchen ? 'kitchen_inbox' : 'warehouse_inbox';
    } else if (kind === 'received') {
      // NO KITCHEN-REALM SEND FOR THIS ONE. Counting a delivery in is Tacet's
      // (tacetOnly on PUT /:id/receive), and the kitchen app has no screen that
      // shows it — a push into that realm would open on nothing.
      /* A SHORT DELIVERY CHANGES THIS PUSH RATHER THAN ADDING ONE (§216). Ash
         was told the gap was invisible and asked for it to be raised; the
         temptation is a second notification, and it would go to the SAME people
         this one already reaches — `restock:pick` at the `from` store, per
         PUSH_AUDIENCE — which is the two-for-one-event mistake §211 exists to
         avoid. The sender is already being told the boxes were counted. What
         was missing is WHAT the count said.

         §39 IS WHY THIS MATTERS RATHER THAN BEING A NICETY: the receipt books
         the COUNTED figure, so Tianhe loses 2 and Yuexiu gains 1 and the
         business is quietly one short. The row has always carried asked, sent
         and counted side by side — legible to anyone who opened it, and nobody
         opens a transfer that already closed.

         SHORT ONLY, DELIBERATELY. An over-count is also a discrepancy and is
         not an alarm: nothing is missing, and a notification for every extra
         unit would teach people to swipe these away.

         THE PRODUCT NAMES CARRY THE CHINESE. Bodies on this fan-out are English
         by existing convention (see every branch above), so the gap is written
         as names and numerals — `薄荷 4/5` — which need no translating and
         read the same to both halves of the team. */
      const gaps = tdb().prepare(`
        SELECT product_name, product_cn, qty_requested, qty_sent, qty_received
          FROM restock_items
         WHERE restock_id = ?
           AND qty_received IS NOT NULL
           AND qty_received < COALESCE(qty_sent, qty_requested)
         ORDER BY id`).all(orderId);
      if (gaps.length) {
        const sentOf = (g) => Math.round(g.qty_sent == null ? g.qty_requested : g.qty_sent);
        const named = gaps.slice(0, 3)
          .map(g => (g.product_cn || g.product_name || '?') + ' ' + Math.round(g.qty_received) + '/' + sentOf(g))
          .join(', ');
        title = `⚠ ${label} short · 短少`;
        body  = `${gaps.length} short at ${toName}` + (named ? ' · ' + named + (gaps.length > 3 ? '…' : '') : '');
      } else {
        title = `✓ ${label} counted in · 已点收`;
        body  = compose(toName ? `Counted at ${toName}` : 'Counted in');
      }
      perm  = null;
    } else { return; }
    // Opens the kitchen SPA, which carries the restock module. This pointed at
    // '/restock?order=N' until 2026-08-04; that page is gone, so the old URL
    // would 404 on a staff phone the moment the notification was tapped.
    if (perm) {
      _push.sendPushByPermission(perm, {
        title, body, url: '/', tag: 'rs-' + orderId + '-' + kind,
      });
    }

    // ── The same event, to the operators who actually run this now ──────────
    const audience = (PUSH_AUDIENCE[`${o.from_role}->${o.to_role}`] || {})[kind];
    if (!audience || !_push.sendPushToOperatorsWithCaps) return;
    const storeId = audience.at === 'from' ? o.from_store_id
                  : audience.at === 'to'   ? o.to_store_id
                  : null;
    /* A door onto the screen the work is on, not onto the app's front page.
       TACET MOBILE, since §48 step 4 deleted the app these used to open. `?to=`
       is that app's own deep-link parameter and it takes a screen key, so the
       old `go` vocabulary is translated here rather than taught to the phone —
       one table, in the file that owns the audience it belongs to.
       The safety property is unchanged and is the phone's, not this table's:
       m.html ignores a `?to=` it does not recognise, and its push() refuses a
       route the operator's capabilities do not reach, so a link can never grant
       access to a screen a capability does not. */
    const GO_SCREEN = {
      pick: 'pick', receive: 'receivexfer', queue: 'kitchenqueue', ready: 'kitchenready',
    };
    const screen = GO_SCREEN[audience.go];
    const url = screen ? '/m?to=' + screen : '/m';
    // `event` names the switch this alert answers to (audit E-10).
    Promise.resolve(_push.sendPushToOperatorsWithCaps(currentTenantId(), audience.caps, {
      title, body, url, tag: 'rs-' + orderId + '-' + kind, event: 'restock',
    }, { storeId, excludeTenantUserId: actorTenantUserId || null }))
      .catch(e => console.warn('[fireRestockPush operators]', e.message));
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

// `stock.warehouseStoreId` off `storefront_config`, on the tenant handle,
// through the one shared settings reader (lib/store-config.js, §477).
// value_json is JSON, so the id may arrive as a number or as a quoted string;
// both are accepted and anything that is not a positive integer is treated as
// unset so a malformed value falls through rather than resolving to 0/NaN.
// The try stays: cfgValue lets a failed read throw, and this answers unset.
function _cfgWarehouseStoreId() {
  try {
    const id = parseInt(cfgValue('stock.warehouseStoreId', null), 10);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch { return null; }
}

// Resolve the warehouse (source) retail_stores.id — the location goods ship
// OUT of. ONE READ OF ONE SETTING; unset returns null and the caller refuses,
// naming the setting.
//
// The three-tier guess this replaces is recorded in
// docs/tacet-stock-movement-schema.md A4/B7, and each tier is dropped for its
// own reason:
//
//   Tier 1 read `SELECT value FROM settings` — a table that does not exist in
//   this schema, is created by nothing, and had no writer anywhere in the
//   repository. The read always threw and always fell through, so the "explicit
//   override" never overrode anything. _cfgWarehouseStoreId IS that tier, on a
//   table that is real and a key something can write.
//
//   Tier 2 took a warehouse-role user's bound store off control-plane `users`
//   and used it as a tenant `retail_stores.id` — a cross-plane reference the
//   file's own comment already flagged.
//
//   Tier 3 picked whichever active store held the most stock. The day a second
//   warehouse exists it silently picks whichever happens to be fuller, and
//   nothing on any screen says a guess was made. It is also wrong BEFORE that
//   day: a store that has just taken a large delivery can outweigh the
//   warehouse. Guessing the source of a stock movement is worse than refusing
//   to move it.
//
// REFUSING IS SAFE HERE ONLY BECAUSE THE KEY IS WRITTEN. #254's
// pin_warehouse_store_id_v1 pins it on first boot, resolving the id the way
// tiers 2 and 3 used to rather than hardcoding one, so an existing deployment
// carries a value before this file ever asks for it. That migration landing
// first is why deleting the fallbacks does not stop a single live dispatch —
// and it is why the two changes were sequenced rather than merged in parallel.
function _resolveWarehouseStoreId() {
  return _cfgWarehouseStoreId();
}

// Where a NEW order's goods should go, used once at creation to write
// `to_store_id` and never again at dispatch. It still eliminates the warehouse,
// because it only answers for the store→warehouse and warehouse→store shapes
// where the warehouse is one end by definition; an order naming both ends
// explicitly does not come through here at all.
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
//
// THE LINE'S OWN SKU DECIDES FIRST (§445). A line raised on the phone carries
// a store_products.id AND the SKU of the product the shop tapped, saved on the
// line when it was asked for. Comparing that id against `products` compares it
// with an unrelated row: RS-261008-002/-003 were refused because one integer
// is Passion Fruit Kombucha 300ml (2-80) in the store list and the 1L (2-90) in
// the old one. The line said 2-80, so the store row WAS the bottle asked for.
// So: where the line and the store row both carry a SKU, they must agree, and
// when they do the line is safe whatever the old list says; when they do not,
// it is refused. Only a line with no SKU of its own, or a store row with none,
// falls back to the old-list comparison below.
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
    const lSku = it.sku     == null ? '' : String(it.sku).trim();
    const kSku = kitchen?.sku == null ? '' : String(kitchen.sku).trim();
    const sSku = store.sku   == null ? '' : String(store.sku).trim();
    if (lSku && sSku) {
      if (lSku !== sSku) {
        problems.push(`${name} does not match the store catalogue: the request was for ${lSku} but that reference is ${sSku} in the store list. Moving it would change the wrong product's stock.`);
      }
      continue;
    }
    if (kSku && sSku && kSku !== sSku) {
      problems.push(`${name} does not match the store catalogue: the old product list has ${kSku} and the store has ${sSku} under the same reference. Moving it would change the wrong product's stock.`);
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
  // A kitchen request asks someone to MAKE something. Nothing travels, so there
  // is no pair to read and nothing to move — stock changes when the kitchen
  // makes it, which is the production path, not this one.
  if (o.to_role === 'kitchen' || o.from_role === 'kitchen') return { skipped: 'kitchen_direction' };

  const label = o.rs_number || ('RS#' + o.id);

  // THE ORDER SAYS WHERE THE GOODS COME FROM AND WHERE THEY GO. It is not
  // inferred here, and the three-tier guess that used to live in this function
  // is gone — see the column comment in database.js for what each tier got
  // wrong. Two things that guess could not survive, both of them Roots:
  // Tianhe is a store AND the warehouse, so a direction taken from a user's
  // role cannot say which hat they wear; and Tianhe must be able to ask Yuexiu,
  // which the old resolver could not express at all because it always sourced
  // from the warehouse and refused any destination equal to it.
  const fromStoreId = o.from_store_id || null;
  const toStoreId   = o.to_store_id || null;
  if (!fromStoreId || !toStoreId) {
    console.warn(`[restock-transfer] ${label}: no source/destination on the order — stock not moved`);
    return {
      ok: false,
      error: 'No stock was moved because this transfer does not say which location the goods leave from and which they arrive at. Set both on the order, then try again.',
    };
  }
  // A location cannot send to itself. Under the old resolver this was implicit
  // in "the destination is never the warehouse"; now it is the only rule, and
  // it is the honest one — it catches Tianhe→Tianhe without also forbidding
  // Yuexiu→Tianhe, which the old form banned as a side effect.
  if (fromStoreId === toStoreId) {
    console.warn(`[restock-transfer] ${label}: source and destination are the same location (${fromStoreId}) — stock not moved`);
    return { ok: false, error: 'No stock was moved: this transfer leaves from and arrives at the same location.' };
  }
  // Kept under its old name so the two halves below read unchanged: it is the
  // location the goods LEAVE, which for a Yuexiu→Tianhe request is Yuexiu.
  return { conn, o, label, warehouseStoreId: fromStoreId, destStoreId: toStoreId };
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
    SELECT product_id, product_name, sku, qty_requested, qty_sent
      FROM restock_items
     WHERE restock_id = ?
       AND product_id IS NOT NULL
       AND COALESCE(qty_sent, qty_requested, 0) > 0
  `).all(o.id).filter(it => _sentQty(it) > 0);
  /* A TRANSFER THAT MOVES NOTHING IS NOT A SUCCESS (§200).
   *
   * This returned ok:true for a transfer with a full basket on it, and that one
   * word is what turned a broken request into a silent "Sent". Ash's banana:
   * Yuexiu asked Tianhe, Tianhe pressed Send, the status went to 'prepared',
   * `goods_state` stayed 'none' — and the Receive screen at the far end filters
   * on 'in_transit', so nobody could ever count it in. Nothing said a word.
   *
   * The cause was upstream (the phone sent `product_id: null` on every line,
   * fixed in public/m.html), but the SILENCE was here, and it is the half worth
   * keeping fixed: whatever makes a line unmovable next time, the person who
   * pressed Send is told instead of the goods quietly not going.
   *
   * ZERO LINES AND ZERO MOVABLE LINES ARE DIFFERENT THINGS, and only the second
   * is a fault. An order with nothing asked for is a no-op and stays one. */
  /* §490 — AND ONE SUCH LINE AMONG MANY IS REFUSED TOO. The §200 refusal fired
     only when NO line could move. One unlinked line in three let the other two
     go: the order went in transit, the receipt never asked about the third
     (its query carries the same product_id IS NOT NULL), and the asker's screen
     marked all three arrived. The units of that line were neither taken off
     nor put on, and nobody was told. Now any line with a quantity and no
     product stops the send and is named. */
  const unlinked = conn.prepare(`
    SELECT product_name, sku, COALESCE(qty_sent, qty_requested, 0) AS qty FROM restock_items
     WHERE restock_id = ? AND product_id IS NULL AND COALESCE(qty_sent, qty_requested, 0) > 0
  `).all(o.id);
  if (unlinked.length) {
    const named = unlinked.map(u => `${u.product_name || u.sku || '?'} ×${u.qty}`).join(', ');
    console.warn(`[restock-dispatch] ${label}: refused — ${unlinked.length} line(s) carry no product: ${named}`);
    return {
      ok: false,
      error: `No stock was moved. ${unlinked.length === 1 ? 'One line is' : unlinked.length + ' lines are'} not linked to a product `
           + `(${named}), so there is no shelf to take ${unlinked.length === 1 ? 'it' : 'them'} off. Raise the request again `
           + 'from the product list, and tell whoever looks after the system.',
    };
  }
  if (!lines.length) {
    const asked = conn.prepare(`
      SELECT COUNT(*) AS c FROM restock_items
       WHERE restock_id = ? AND COALESCE(qty_sent, qty_requested, 0) > 0
    `).get(o.id).c;
    if (asked > 0) {
      console.warn(`[restock-dispatch] ${label}: refused — ${asked} line(s) asked for, none carries a product the shelf knows`);
      return {
        ok: false,
        error: 'No stock was moved. None of these lines is linked to a product, '
             + 'so there is no shelf to take them off. Raise the request again '
             + 'from the product list, and tell whoever looks after the system.',
      };
    }
    /* EVERY LINE WAS PICKED AS 0 — the supplier had none of any of it. That is
     * an answer, not a fault: the picker checked the shelf and said so. Left
     * at goods_state 'none' it would sit under "Did not leave the shelf" for
     * ever, with a Send again that can only reply "nothing to send". So it
     * closes here: nothing leaves, nothing is in transit, there is nothing for
     * the far end to count, and the asking shop reads "0 sent" on each line.
     * received_confirmed_at stays empty because nobody counted anything. */
    const zeroed = conn.prepare(`
      SELECT COUNT(*) AS c FROM restock_items
       WHERE restock_id = ? AND qty_sent = 0 AND COALESCE(qty_requested, 0) > 0
    `).get(o.id).c;
    if (zeroed > 0) {
      conn.prepare(`UPDATE restock_orders
                       SET goods_state = 'settled', dispatched_at = CURRENT_TIMESTAMP
                     WHERE id = ?`).run(o.id);
      console.log(`[restock-dispatch] ${label}: every line picked as 0, nothing left store ${warehouseStoreId}`);
      return { ok: true, skipped: 'nothing_sent' };
    }
    return { ok: true, skipped: 'no_lines' };
  }

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
    SELECT id, product_id, product_name, sku, qty_requested, qty_sent, qty_received
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
/* THE RESTOCK ROUTES BELONG TO TACET, AND THE KITCHEN APP KEEPS ONLY ITS INBOX.
 *
 * These endpoints were reachable by ONE identity: the kitchen `users` realm
 * (session.userId). Tacet operators are `tenant_users` (session.backendUserId),
 * a deliberately separate key — see routes/backend-auth.js — so every transfer
 * screen 403'd on the Tacet host and worked only on the kitchen one. That was
 * never a decision about where the feature belonged; it was the only realm that
 * could reach the API, and the screens followed it there.
 *
 * A Tacet operator now passes through requireRetailAdmin, exactly as every
 * /api/retail-admin/* route does — the same tenant scoping, the same tdb()
 * context, the same RBAC choke point. The three capabilities are mapped in
 * lib/cap-routes.js, so they honour the tenant's own rbac_enforce switch and the
 * owner bypass rather than inventing a second permission system beside it.
 *
 * THE KITCHEN REALM IS NARROWED, NOT REMOVED, AND THE DIFFERENCE MATTERS.
 * public/app.html is a kitchen-realm client of these endpoints and is still
 * served at the root of food.* / app.* / the bare domain. Refusing that realm
 * outright would break a surface this gate does not own, so the kitchen keeps
 * exactly what it needs: kitchen-direction orders, and nothing else. Store and
 * warehouse work — raising a request, picking, dispatching, receiving — is
 * Tacet's alone.
 *
 * THE KITCHEN'S INBOX HAS MOVED, and the gate outliving it is deliberate. This
 * used to name public/kitchen.html as the inbox an "ask the kitchen" request
 * was sent to; §76 deleted that page, and the inbox is now /m's kitchenqueue
 * screen — Tacet realm, gated on a capability, not on this. What survives here
 * is the narrowing itself, which is load-bearing for as long as ANY kitchen-
 * realm session can reach these routes. It retires with public/app.html.
 */
function requireRestockAccess(req, res, next) {
  if (req.session && req.session.backendUserId) {
    req.restockRealm = 'tacet';
    return requireRetailAdmin(req, res, next);
  }
  /* THE KITCHEN BRANCH IS GONE (§81). It ran requireAuth and then accepted an
     admin, or a holder of restock / warehouse_inbox / kitchen_inbox, as
     req.restockRealm = 'kitchen'. That realm is retired — its login and its
     /api/auth routes are deleted — so the branch could only ever have refused.
     ONE REALM REACHES THESE ROUTES NOW, which is what the header above said
     this narrowing was waiting for. */
  return res.status(401).json({ error: 'Not authenticated' });
}

/* KITCHEN-ONLY OPERATORS ARE CONFINED TO KITCHEN REQUESTS, and the confinement
 * is enforced here rather than by hiding a button.
 *
 * Two kinds of session land in it. The dying kitchen app is one — it is a
 * kitchen-realm client of these endpoints and has no business in a transfer.
 * The other is a Tacet operator who holds `restock:fulfil` and NOT
 * `restock:pick`: the person who MAKES what was asked for. Marking a kitchen
 * request prepared says the food is ready; marking a TRANSFER prepared sends a
 * van and moves stock. Same route, same verb, and only the row says which — so
 * the row is read.
 *
 * `req.caps` is null when the tenant has not switched RBAC on, and an owner
 * bypasses everything: in both cases there is no fulfil-only operator to
 * confine, and this correctly does nothing. Policy stays where the tenant set
 * it rather than being second-guessed here.
 */
// Shared with routes/retail.js for the same reason KITCHEN_READY_WHERE is: the
// dashboard row must exclude exactly the operators this file excludes, or the
// maker gets told on the dashboard about work they did themselves.
const _kitchenScopedSession = _kready.kitchenScopedSession;

function kitchenScopedOrder(req, res, next) {
  if (!_kitchenScopedSession(req)) return next();
  const o = tdb().prepare('SELECT from_role, to_role FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found · 未找到' });
  if ((o.to_role || 'warehouse') !== 'kitchen' && (o.from_role || 'store') !== 'kitchen') {
    return res.status(403).json({
      error: 'This is a transfer between locations, not a kitchen request · 这是门店之间的调拨,不是厨房制作请求。',
    });
  }
  next();
}

// Store and warehouse work is Tacet's. A kitchen session reaching one of these
// is the kitchen app asking for something that is not its job.
function tacetOnly(req, res, next) {
  if (req.restockRealm === 'kitchen') {
    return res.status(403).json({
      error: 'Transfers are managed in Tacet · 调拨请在 Tacet 中处理。',
    });
  }
  next();
}
// Decide which side of the two-sided workflow this user can ORIGINATE
// from. Three flows are supported:
//   store      → warehouse  (store user requests stock)
//   warehouse  → kitchen    (warehouse asks kitchen for items)
//   warehouse  → store      (warehouse pushes stock to a store)
// Warehouse users target kitchen or store explicitly via req.body.to_role.
//
// A REQUEST WITH NO DESTINATION GOES TO THE WAREHOUSE, whoever sends it.
//
// It used to default a warehouse or admin user to the kitchen, "for
// back-compat" with public/restock.html — the warehouse PWA, which was the
// only client that ever sent `to_role`, and which asked for a destination and
// a purpose in a modal before posting. That page was deleted on 2026-08-04
// (488806ce, after Ash confirmed the flow was unused) and its create path was
// not ported anywhere. Nothing has sent `to_role` since.
//
// What the default did after that was create a trap. The one surviving client,
// app.html's in-SPA Restock screen, sends neither field, so a warehouse or
// admin user pressing its "Send to Warehouse" button was inferred into the
// kitchen branch and then rejected by the purpose gate below with a 400 — on
// every submission, with no way to satisfy it from that screen. Store users
// were unaffected, which is why it survived. The default now matches both the
// button's label and the only flow the UI can actually express.
//
// This does NOT revive kitchen requests, and does not decide whether they
// should come back: an explicit to_role:'kitchen' with a purpose still creates
// one exactly as before. It only stops an absent choice from being read as a
// choice of the kitchen.
function _inferDirection(req) {
  // ORIGIN is decided by ROLE, not by the `warehouse_inbox` perm — a
  // store user (e.g. Retail Yuexiu) may have the perm so they can see
  // the Fulfill tab, but their own outgoing requests still flow
  // store→warehouse. Only `warehouse` and `admin` originate from the
  // warehouse side and can name a destination.
  const role = req.user?.role || '';
  // A TACET OPERATOR IS ALWAYS WAREHOUSE-ORIGIN. The role names below are the
  // KITCHEN realm's vocabulary — `warehouse`, `admin` on users — and a Tacet
  // operator's role comes from tenant_users, where the words are owner / staff /
  // store_stock and none of them match. Without this line an operator naming
  // to_role:'kitchen' would have it silently ignored and the request would go to
  // the warehouse instead: the "ask the kitchen" tile would send, report success
  // and reach the wrong inbox. Their authority to originate is established by
  // the realm and the restock:request capability, not by a word on a row in a
  // different table.
  const isWarehouseOrigin = req.restockRealm === 'tacet'
    || role === 'warehouse' || role === 'admin';
  const explicit = (req.body && req.body.to_role) ? String(req.body.to_role) : null;
  if (isWarehouseOrigin) {
    if (explicit === 'store')   return { from_role: 'warehouse', to_role: 'store'   };
    if (explicit === 'kitchen') return { from_role: 'warehouse', to_role: 'kitchen' };
    // 'warehouse', anything unrecognised, or nothing at all falls through.
  }
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
  const since = shopDaysAgo(daysWindow);
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
  const today = shopToday();
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

router.get('/api/restock/suggest', requireRestockAccess, tacetOnly, (req, res) => {
  const days = parseInt(req.query.days) || 60;
  res.json({ success: true, data: buildRestockSuggestions(days) });
});

/* TWO PREFIXES, BECAUSE THEY ARE TWO THINGS.
 *
 * RS- is a transfer: goods that exist, moving between two locations, with a
 * dispatch and a receipt. PR- is a production request: nothing exists yet and
 * nothing travels — somebody is being asked to MAKE it. This file already knew
 * that in ten places (_transferContext refuses a kitchen direction outright,
 * both locations are forced to NULL on create, `purpose` is required for one
 * shape and meaningless for the other, and half of STATUS_FLOW is dead on a
 * kitchen row). The number was the last place still calling them the same.
 *
 * EXISTING ROWS KEEP THEIR NUMBERS. A number that has been read down a phone,
 * written on a tray or printed on a sheet is not ours to rewrite, so nothing
 * backfills: RS-260904-002 stays RS-260904-002 for the rest of its life, and
 * only requests raised from here on are PR-. The two live side by side, which
 * is what a rename in a working system actually looks like.
 *
 * THE SEQUENCE IS PER PREFIX. Counting both together would leave a day looking
 * like RS-001, PR-002, RS-003 — a shared run of numbers across two things that
 * have nothing to do with each other, which is the very confusion the prefix
 * exists to end. substr(4,6) is the date in both, the prefixes being the same
 * width, so the existing index-free scan reads either.
 */
function genRsNumber(prefix = 'RS') {
  // The shop's date, not the host's: RS-YYMMDD is the day the shop raised it.
  const ymd = shopToday().replace(/-/g, '').slice(2);
  const todayCount = tdb().prepare(
    'SELECT COUNT(*) AS c FROM restock_orders WHERE substr(rs_number,1,3) = ? AND substr(rs_number,4,6) = ?'
  ).get(prefix + '-', ymd).c;
  return `${prefix}-${ymd}-${String(todayCount + 1).padStart(3,'0')}`;
}

// ── Orders list (with item count + progress) ────────────────────────────────
router.get('/api/restock', requireRestockAccess, (req, res) => {
  // A KITCHEN SESSION MAY LIST ITS OWN INBOX AND NOTHING ELSE. The refusal used
  // to do a second job as well, and that job is gone: the retired /stock app
  // probed this route with `to_role=store` and read a 403 as "there is one job
  // here", which is what kept its Transfers launcher off the kitchen host.
  // Nothing probes it now — Tacet Mobile gates each row on a capability instead
  // — but the refusal itself is load-bearing on its own terms and stays: a
  // kitchen session reading the store's transfers is a door that opens
  // onto a wall. (public/kitchen.html always asked for to_role=kitchen; §76
  // deleted it, and the refusal stands on its own terms without that example.)
  if (_kitchenScopedSession(req) && req.query.to_role !== 'kitchen') {
    return res.status(403).json({
      error: 'Transfers are managed in Tacet · 调拨请在 Tacet 中处理。',
    });
  }
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
    //
    // AND SO IS EVERY OPEN TRANSFER BETWEEN TWO NAMED LOCATIONS (§198), for
    // exactly the reason the kitchen already is. Ash raised a request from
    // Yuexiu against Tianhe in the evening; by the time anyone at Tianhe opened
    // the app, THIS SWEEP HAD ARCHIVED IT — `archived_at` stamped, off every
    // active list, nobody having touched it. "there is no printing in tianhe
    // for it, i dont see it on my mobile" is partly this line.
    //
    // The sweep's own comment says what it was built for: a single-day
    // store→warehouse Fulfill tab. It is simply WRONG about a request one shop
    // raises against another. A shop does not walk its freezer on demand, the
    // supplier may be closed, and work that legitimately spans days is not
    // stale — which is the same sentence the kitchen exclusion above rests on.
    //
    // NOTHING GROWS FOREVER BECAUSE OF THIS. Archiving an abandoned request is
    // already a person's call: PUT /api/restock/:id/archive takes one, and
    // POST /api/restock/archive-bulk takes a tab's worth. What is removed here
    // is a CLOCK deciding that an unanswered request has stopped mattering.
    //
    // Both ends named is what identifies a real transfer. A row with only one
    // end set cannot be routed to a Pick screen at all and is a legacy shape
    // (#259 added the pair), so it keeps the old behaviour rather than being
    // quietly rescued into a list nothing draws it on.
    // The shop's own midnight, not Guangzhou's (audit A-05).
    const SHIFT = require('../lib/business-date').sqlDayShiftForShop(tdb());
    tdb().prepare(`
      UPDATE restock_orders
         SET archived_at = CURRENT_TIMESTAMP
       WHERE archived_at IS NULL
         AND status NOT IN ('prepared','delivered','draft')
         AND COALESCE(to_role, 'warehouse') != 'kitchen'
         AND NOT (from_store_id IS NOT NULL AND to_store_id IS NOT NULL)
         AND date(created_at, '${SHIFT}') < date('now', '${SHIFT}')
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
  /* URGENT FIRST, AND THAT IS THE WHOLE OF WHAT 'urgent' MEANS (§65). Newest
     -first was this list's only sort, so a request raised at 09:00 and marked
     urgent sat BELOW a routine one raised at 09:05 and the kitchen found it
     only by reading every card. Marking one now moves it.
     The key tests `purpose = 'urgent'` and nothing else, deliberately: this
     endpoint also serves store→warehouse rows, whose purpose is NULL by
     design, and the expression is identical for every one of them — their
     order does not move. `created_at DESC` still orders inside each group, so
     two urgent requests are still newest-first between themselves. */
  q += " ORDER BY CASE WHEN r.purpose = 'urgent' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC";
  res.json({ success: true, data: tdb().prepare(q).all(...params) });
});

/* ── What the kitchen has finished, and nobody has acknowledged ─────────────
 *
 * THE SIGNAL THAT DID NOT EXIST. A warehouse operator raises a kitchen request
 * ("Ask the kitchen", on the /stock launcher) and then hears nothing. For
 * warehouse→kitchen 'prepared' IS the closure — there is no delivery leg and no
 * receipt to count in — so the request simply stops moving, and the only thing
 * that ever announced it was a push: one moment, on one phone, that may be in a
 * pocket, on silent, or swiped away on the lock screen. Nothing in either app
 * carried the fact afterwards, so the person who asked found out by remembering
 * to go and look.
 *
 * WHAT THE ACKNOWLEDGEMENT IS, AND WHAT IT IS NOT. This shipped counting
 * unarchived rows and clearing on a "Collected" button, which invented a step
 * Roots does not have: the kitchen puts what it makes on the shelf and records
 * the stock itself, so nothing is physically waiting for the warehouse and
 * there is nothing to collect. Ash, on the warehouse account: "the only thing
 * needed is that the warehouse knows the kitchen handled his request."
 *
 * So the fact behind the dot is SEEN, not done: `seen_at`, stamped when
 * somebody opens the list. It is still a SERVER-SIDE fact rather than a
 * per-device "last seen" stamp, and that is the half worth keeping — one person
 * looking clears it for the whole warehouse, so nobody is chased about a
 * request the team already knows about. That is the property the Orders dot
 * gets from reading a status (routes/retail.js orders/unseen-count) and the
 * Inbox dot has never had.
 *
 * ARCHIVED IS STILL EXCLUDED, and it is a different fact: archiving HIDES a
 * row. Being seen does not — the list stays a record of what the kitchen has
 * made, and it must still read that way the day after somebody glanced at it.
 *
 * DECLARED BEFORE /:id, because /:id would otherwise match the word and answer
 * 404 for a row whose id is 'kitchen-ready'.
 */
// MOVED TO lib/kitchen-ready.js, not copied there. The dashboard's Needs-you
// row now counts the same lines this endpoint does, and two surfaces reading
// one clause cannot drift apart the way two clauses eventually do.
//
// THE GRAIN IS THE LINE (§69). It counted REQUESTS until 2026-09-08, which was
// §61 half-carried: one product made out of three never moved the request's
// own status, so this answered zero about a jar already on the shelf. The
// clause's own header carries the full reasoning.
const { KITCHEN_READY_FROM, KITCHEN_READY_MADE_WHERE, KITCHEN_READY_WHERE, KITCHEN_READY_MADE_AT } = _kready;

router.get('/api/restock/kitchen-ready', requireRestockAccess, tacetOnly, (req, res) => {
  /* THE MAKER IS NOT THE AUDIENCE. A fulfil-only operator is the person who
     marked it made; a dot telling them their own work is waiting is telling
     them about themselves. They get an honest zero rather than a 403 — this is
     polled in the background, and a refusal there costs the client a bounce to
     the login screen out of a pocket. */
  if (_kitchenScopedSession(req)) return res.json({ success: true, data: { count: 0, latest: null } });
  const row = tdb().prepare(`
    SELECT COUNT(*) AS n, MAX(${KITCHEN_READY_MADE_AT}) AS latest
      FROM ${KITCHEN_READY_FROM}
     WHERE ${KITCHEN_READY_WHERE}`).get();
  res.json({ success: true, data: { count: row.n || 0, latest: row.latest || null } });
});

/* ── What today's batch owes ────────────────────────────────────────────────
 *
 * §84. The number the kitchen adds to the batch it is about to make, and until
 * this endpoint existed there was no way to ask for it. Ash described the
 * routine it serves — "in the morning when kitchen come to work they already
 * see how many fresh meals and wraps need to be prepared and they will add
 * those extra to the batch they are about to do" — and the screen that routine
 * happens on renders REQUESTS somebody typed, never the orders themselves.
 *
 * THE ARITHMETIC IS NOT HERE. lib/batch-owed.js holds it, for the reason
 * lib/kitchen-ready.js holds the finished-line clause: the queue screen and the
 * phone's Home row both ask this question, and two surfaces reading one
 * definition cannot drift apart the way two definitions eventually do.
 *
 * NOT SCOPED TO A STORE, and the rows carry their own. These routes have no
 * per-store session scope (a Tacet operator sees the tenant), and a kitchen
 * cooking for two shops needs both numbers rather than one of them silently.
 *
 * A FULFIL-ONLY SESSION GETS AN HONEST EMPTY LIST rather than a 403, exactly as
 * the kitchen-ready dot above does and for the same reason: this is fetched in
 * the background behind a screen, and a refusal there bounces somebody to a
 * login out of their pocket.
 */
router.get('/api/restock/batch-owed', requireRestockAccess, tacetOnly, (req, res) => {
  if (_kitchenScopedSession(req)) return res.json({ success: true, data: { rows: [], total: 0 } });
  /* NOT NAMED `db`, and the shadow it would have cast is why. In this file `db`
     is the SHARED global handle — always Roots, control-plane tables only, per
     the header at the top — so a local binding it to tdb() would read as that
     handle to everyone after it while silently being a different connection.
     scripts/test_restock_tenant_handle.js polices exactly this and caught it. */
  const tdbc = tdb();
  const rows = _owed.owedAt(tdbc);
  // The store's name is resolved HERE and not in the lib: batch-owed answers a
  // stock question and has no business knowing how a shop is labelled. One
  // query for the handful of stores in the result, not one per row.
  let named = rows;
  if (rows.length) {
    const ids = [...new Set(rows.map((r) => r.store_id))];
    const ph = ids.map(() => '?').join(',');
    const stores = new Map(
      tdbc.prepare(`SELECT id, name_en, name_cn FROM retail_stores WHERE id IN (${ph})`)
        .all(...ids)
        .map((s) => [s.id, s])
    );
    named = rows.map((r) => ({
      ...r,
      store_en: stores.get(r.store_id)?.name_en || null,
      store_cn: stores.get(r.store_id)?.name_cn || null,
    }));
  }
  res.json({
    success: true,
    data: {
      rows: named,
      // Summed from the same rows rather than by a second query, so the Home
      // row and the list it opens can never disagree about whether there is
      // anything to make.
      total: named.reduce((n, r) => n + r.owed, 0),
      // More than one shop in the answer means the client has to say WHICH,
      // and deciding that here keeps the rule off three call sites.
      multi_store: new Set(named.map((r) => r.store_id)).size > 1,
    },
  });
});

/* ── What the kitchen has finished, line by line ────────────────────────────
 *
 * THE LIST BEHIND THE FIRE, and it is a list of PRODUCTS rather than of request
 * numbers (§69). Ash: *"why not to mention the specific product kitchen made
 * directly on the dashboard this way the user wont need to open the order —
 * too many clicks."* A request number is the one fact about a finished jar that
 * nobody in the warehouse can act on; the name is the whole of what they came
 * to find out, and it was two taps down.
 *
 * IT SHOWS SEEN LINES TOO, and only the COUNT above is unseen-only. The screen
 * answers "what has the kitchen made", which has to still answer the day after
 * somebody glanced at it; the dot answers "is there anything I have not been
 * told about". Two questions, one clause plus one arm — which is why
 * KITCHEN_READY_WHERE is literally KITCHEN_READY_MADE_WHERE with the two seen
 * arms appended, rather than a second clause that could drift.
 *
 * DECLARED BEFORE /:id, with the two above, because /:id would otherwise match
 * the word and answer 404 for a row whose id is 'kitchen-ready'.
 */
router.get('/api/restock/kitchen-ready/lines', requireRestockAccess, tacetOnly, (req, res) => {
  if (_kitchenScopedSession(req)) return res.json({ success: true, data: [] });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
  const rows = tdb().prepare(`
    SELECT i.id, i.restock_id, i.product_name, i.product_cn, i.sku,
           i.qty_requested, i.unit,
           ${KITCHEN_READY_MADE_AT} AS made_at,
           COALESCE(i.seen_at, r.seen_at) AS seen_at,
           r.rs_number, r.purpose
      FROM ${KITCHEN_READY_FROM}
     WHERE ${KITCHEN_READY_MADE_WHERE}
     ORDER BY made_at DESC, i.id DESC
     LIMIT ?`).all(limit);
  res.json({ success: true, data: rows });
});

/* ── "We have read it" ──────────────────────────────────────────────────────
 *
 * The only acknowledgement this direction has room for, and it is not a button:
 * opening the list IS the acknowledgement, so /stock posts this the moment the
 * screen has something on it. Nobody is asked to confirm anything, because
 * there is nothing to confirm — the goods are already on the shelf and the
 * stock is already right.
 *
 * IT STAMPS THE IDS THE SCREEN ACTUALLY SHOWED, never "everything unseen". The
 * kitchen can mark something made in the seconds between the list rendering and
 * this call landing, and a blanket stamp would quietly clear a request nobody
 * has laid eyes on — the one failure that would make the dot worth ignoring.
 *
 * ALREADY-SEEN ROWS ARE LEFT ALONE (`seen_at IS NULL` in the UPDATE), so the
 * stamp records when the warehouse FIRST knew rather than the last time anyone
 * scrolled past. Re-opening the screen is therefore free and idempotent.
 */
router.post('/api/restock/kitchen-ready/seen', requireRestockAccess, tacetOnly, (req, res) => {
  // The maker's own screen has no business stamping the asker's dot.
  if (_kitchenScopedSession(req)) return res.json({ success: true, data: { seen: 0 } });
  const clean = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
  const itemIds  = clean(req.body?.item_ids);
  // BOTH SHAPES, AND THE OLD ONE IS NOT DEPRECATION DEBT. `ids` meant request
  // ids before §69 and still does — a page cached on a phone before this
  // deploy goes on sending them, and the sentence it is making ("I have read
  // this request") is exactly as true per line as it was per request. It is
  // resolved to the request's own unseen finished lines below rather than
  // stamping the order, so a stale client and a fresh one leave the same
  // marks. Reading it as item ids instead would have silently acknowledged
  // whichever unrelated lines happened to carry those numbers.
  const orderIds = clean(req.body?.ids);
  if (!itemIds.length && !orderIds.length) return res.json({ success: true, data: { seen: 0 } });

  // Resolved to line ids FIRST, in one read, so the UPDATE below has a single
  // shape and the clause is applied exactly once. A line already seen — by
  // either stamp — falls out here, which is what keeps re-opening the screen
  // free and keeps `seen_at` the moment the warehouse FIRST knew.
  const marks = (a) => a.map(() => '?').join(',');
  const where = [];
  const args = [];
  if (itemIds.length)  { where.push(`i.id IN (${marks(itemIds)})`);          args.push(...itemIds); }
  if (orderIds.length) { where.push(`i.restock_id IN (${marks(orderIds)})`); args.push(...orderIds); }
  const targets = tdb().prepare(`
    SELECT i.id FROM ${KITCHEN_READY_FROM}
     WHERE (${where.join(' OR ')}) AND ${KITCHEN_READY_WHERE}`).all(...args);
  if (!targets.length) return res.json({ success: true, data: { seen: 0 } });

  const ids = targets.map((t) => t.id);
  const r = tdb().prepare(
    `UPDATE restock_items SET seen_at = ?
      WHERE id IN (${marks(ids)}) AND seen_at IS NULL`
  ).run(new Date().toISOString(), ...ids);
  res.json({ success: true, data: { seen: r.changes || 0 } });
});

// ── Single order with items ─────────────────────────────────────────────────
/* WHICH LINES HAVE ALREADY REACHED THE SHELF — DERIVED FROM THE BATCHES
 * THEMSELVES, NEVER STORED ON THE LINE.
 *
 * §61's per-item hand-over opens the What-you-made screen the moment a line is
 * marked made, and an operator can leave that screen without recording: the
 * line is `prepared`, the shelf is still short, and until now the queue drew it
 * done with no way back — the dead end Ash reported ("if I'm on this page and
 * going back I can't come back to this page again, no option"). The queue can
 * only offer the way back if it knows which lines are still owed.
 *
 * IT IS DERIVED FOR THE REASON docs/tacet-stock-movement-schema.md B3 GIVES for
 * deriving in-transit rather than counting it: a flag on the line and the
 * batches behind it can disagree, and a derivation cannot. It also needs no
 * migration and is right about every request recorded before it existed, which
 * a backfilled column would only be as far as the backfill's own guesswork.
 *
 * THE JOIN IS THE ONE THE RECORD SCREEN ITSELF MAKES. A kitchen request carries
 * no product_id — it is sent null on purpose, restock_items.product_id being a
 * kitchen products.id where every shelf table is keyed on store_products.id —
 * so public/m.html's hdResolve matches its lines to the shelf by SKU, falling
 * back to an exact name. This mirrors that, against the products the batches
 * were actually written for. A line the screen could not match cannot have been
 * recorded either, so both sides say the same thing about it.
 *
 * Best-effort by construction: any failure here leaves every line unmarked,
 * which shows the way back to a screen that has already been used rather than
 * hiding one that has not. A wrongly-offered door costs a tap; a hidden one
 * costs the stock.
 */
function _attachRecorded(order, items) {
  if ((order.to_role || 'warehouse') !== 'kitchen') return items;
  const blank = () => items.map(it => ({ ...it, recorded_at: null, recorded_qty: null }));
  try {
    const batches = tdb().prepare(`
      SELECT b.product_id, sp.sku, sp.name_en, sp.name_cn,
             MAX(b.created_at)  AS recorded_at,
             SUM(b.qty_shelved) AS recorded_qty
        FROM production_batches b
        JOIN store_products sp ON sp.id = b.product_id
       WHERE b.request_id = ?
       GROUP BY b.product_id`).all(order.id);
    if (!batches.length) return blank();
    const key = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const bySku = {}, byName = {};
    for (const b of batches) {
      const k = key(b.sku);
      if (k && bySku[k] === undefined) bySku[k] = b;
      for (const n of [b.name_en, b.name_cn]) {
        const kn = key(n);
        if (kn && byName[kn] === undefined) byName[kn] = b;
      }
    }
    return items.map(it => {
      const m = bySku[key(it.sku)] || byName[key(it.product_name)] || byName[key(it.product_cn)] || null;
      return { ...it, recorded_at: m ? m.recorded_at : null, recorded_qty: m ? m.recorded_qty : null };
    });
  } catch (e) {
    console.warn('[restock] recorded-line derivation:', e.message);
    return blank();
  }
}

/* ── What became of what YOU asked for (§198) ───────────────────────────────
 *
 * THE SCREEN THAT DID NOT EXIST, and the half of Ash's report that paper does
 * not fix: "i dont see it on my mobile". Between pressing Send and the supplier
 * dispatching, a stock request existed on NO screen the asker could open. The
 * Receive-from-another-shop list shows only what is already in transit, so the
 * whole of the waiting — the part somebody actually wonders about — was blank.
 *
 * ASK TO BUY HAS HAD THIS SINCE §175 AND ASK FOR STOCK HAD NOTHING, which is
 * the whole argument for this route: two request screens sitting under one
 * heading on the same phone, one of which answers back.
 *
 * SCOPED TO THE CALLER by `created_by`, the column the request already stamps,
 * and `tacetOnly` besides — a kitchen session's user id is a row in a different
 * table, so without the realm gate two people with the same integer id would
 * read each other's requests. §175's route can scope by the column alone
 * because only one realm ever reaches it.
 *
 * THE LINE CARRIES THE STATE, NOT THE REQUEST — §175's rule, and it is if
 * anything more true here. A picker walks a freezer and ticks lines one at a
 * time, so a request is routinely part dispatched and part not, and any single
 * word printed across the whole of it is wrong about at least one line.
 *
 * `state` IS DECIDED HERE AND NOT ON THE PHONE, for §175's reason: two screens
 * each deciding what a null means is how they come to disagree.
 *
 * WHAT WAS ACTUALLY SENT IS PART OF THE ANSWER, and it is why `qty_sent` rides
 * along. "Arrived" against a line that asked for 20 and got 12 is a true word
 * about a thing the asker still needs; the number is what makes it readable.
 * Nothing here carries a price — a transfer moves value between two shelves of
 * one business, which is §51's rule for the slip applied to the screen.
 *
 * DECLARED BEFORE /:id, because /:id would otherwise match the word and answer
 * 404 for a row whose id is 'mine'. */
/* ── IS THERE ANYTHING FOR ME TO PICK (§198) ────────────────────────────────
 *
 * THE MARK THE PICK ROW NEVER CARRIED. A request reaching a supplier announced
 * itself by push and nothing else, and a push is one moment on one phone that
 * may be in a pocket, on silent, or swiped away on a lock screen. After that
 * the only way to find out was to open More, find Pick among thirty rows, and
 * choose a location — which is to say, to already know. §175 made this argument
 * for the kitchen's Ready dot and it is unchanged here.
 *
 * A COUNT, SO THE PHONE CAN COMPARE IT AND ANNOUNCE AN ARRIVAL. What the phone
 * DRAWS is one 6px Sage dot, never a number: a count in the chrome turns
 * arriving work into an alarm, and the number belongs on the screen it points
 * at. The standing rule on the tab bar's dots, applied to a row.
 *
 * SCOPED TO THE SHELVES THIS OPERATOR CAN ACT ON. `req.scopeStores` is the same
 * list the push fan-out narrows on (routes/push.js) — null means unscoped and
 * therefore every location. A dot must never promise work behind a door this
 * operator cannot open, which is the rule the Ready dot and the Inbox count
 * both follow.
 *
 * WHAT COUNTS IS WHAT THE PICK SCREEN ITSELF LISTS, and it is deliberately the
 * same clause: open, not yet dispatched, supplied by one of my shops. Two
 * surfaces disagreeing about what is waiting is a dot that stays lit over an
 * empty screen, which teaches people to stop believing it.
 *
 * DECLARED BEFORE /:id, for the reason kitchen-ready is. */
router.get('/api/restock/pick-count', requireRestockAccess, tacetOnly, (req, res) => {
  const scope = Array.isArray(req.scopeStores) ? req.scopeStores.filter(n => Number.isFinite(Number(n))) : null;
  // An operator scoped to NO store can act nowhere; counting every shop's work
  // for them would be the promise-behind-a-locked-door this endpoint avoids.
  if (scope && scope.length === 0) return res.json({ success: true, data: { count: 0, shop_count: 0, oldest_at: null, shops: [] } });
  const where = scope ? ` AND from_store_id IN (${scope.map(() => '?').join(',')})` : '';
  /* THE CLAUSE IS WRITTEN ONCE AND USED TWICE, because the count and the names
     beside it disagreeing is the dot-over-an-empty-screen fault this endpoint
     exists to avoid, one level down. */
  const WAITING = `
       archived_at IS NULL
       AND status IN ('sent','received')
       AND COALESCE(goods_state,'none') = 'none'
       AND from_store_id IS NOT NULL
       AND to_store_id IS NOT NULL
       AND COALESCE(to_role,'warehouse') != 'kitchen'
       AND COALESCE(from_role,'store')   != 'kitchen'${where}`;
  const row = tdb().prepare(`
    SELECT COUNT(*) AS c,
           COUNT(DISTINCT to_store_id) AS shop_count,
           /* datetime(), AND IT IS NOT DECORATION. sent_at is written by the
              API as a full ISO instant ('…T14:00:00.000Z') while created_at
              is SQLite's own CURRENT_TIMESTAMP ('… 14:00:00'), and MIN() over
              two string shapes compares the shapes: 'T' sorts after ' ', so a
              raw MIN picks 14:00 over an earlier 09:00 and the row reads
              "oldest 2h" over a shop that has waited seven. datetime() folds
              both to one UTC form first, which is also the form the phone's
              _date() reads as UTC. */
           MIN(datetime(COALESCE(sent_at, created_at))) AS oldest_at
      FROM restock_orders
     WHERE ${WAITING}
  `).get(...(scope || []));
  /* WHO IS WAITING, AND SINCE WHEN (§215). The dot on the Pick row needs
     neither — it is one 6px mark and a number in the chrome would turn arriving
     work into an alarm — but Home's "Needs you" row is a full sentence and this
     is what fills it: a shop's NAME is what decides whether the walk happens
     now or after the delivery run, and it saves opening the screen to find out.
     The COUNT stays first and stays exactly what it was, because that is what
     the dot reads and what §198's test pins.
     ASKING SHOPS, NOT SUPPLYING ONES: `to_store_id` is the shop that asked.
     DISTINCT, because two requests from one shop are one name; ordered by that
     shop's OLDEST wait so the head of the list is the shop kept waiting longest,
     which is the order Home prints them in. Four is a cap on the wire, not a
     display rule — the row itself shows two and counts off the rest. */
  const shops = row && row.c ? tdb().prepare(`
    SELECT s.id, COALESCE(s.name_en,'') AS name_en, COALESCE(s.name_cn,'') AS name_cn
      FROM retail_stores s
      JOIN (SELECT to_store_id AS sid, MIN(datetime(COALESCE(sent_at, created_at))) AS waiting_since
              FROM restock_orders
             WHERE ${WAITING}
             GROUP BY to_store_id) w ON w.sid = s.id
     ORDER BY w.waiting_since, s.id
     LIMIT 4
  `).all(...(scope || [])) : [];
  res.json({
    success: true,
    data: {
      count: row ? row.c : 0,
      shop_count: row ? row.shop_count : 0,
      oldest_at: (row && row.oldest_at) || null,
      shops,
    },
  });
});

router.get('/api/restock/mine', requireRestockAccess, tacetOnly, (req, res) => {
  const me = (req.user && req.user.id) || null;
  if (!me) return res.json({ success: true, data: [] });
  const conn = tdb();
  // Kitchen requests are excluded outright: "Ask the kitchen" is a different
  // screen with a different answer (kitchen-ready), and folding the two into
  // one list would put a tray of food and a case of almonds under one heading.
  const rows = conn.prepare(`
    SELECT id, rs_number, date, status, notes, sent_at, delivered_at, archived_at,
           from_store_id, to_store_id, store_name, store_cn,
           COALESCE(goods_state, 'none') AS goods_state
      FROM restock_orders
     WHERE created_by = ?
       AND status <> 'draft'
       AND COALESCE(to_role,'warehouse') != 'kitchen'
       AND COALESCE(from_role,'store')   != 'kitchen'
     ORDER BY COALESCE(sent_at, date) DESC, id DESC
     LIMIT 60`).all(me);
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const lines = conn.prepare(`
      SELECT id, restock_id, product_name, product_cn, sku,
             qty_requested, qty_sent, unit, COALESCE(is_checked, 0) AS is_checked
        FROM restock_items
       WHERE restock_id IN (${marks}) AND qty_requested > 0
       ORDER BY id`).all(...rows.map(r => r.id));
    /* FOUR STATES, BECAUSE THREE TOLD A SMALL LIE (§202). The middle one read
     * "Dispatched" and lit on the picker's TICK — which happens at the shelf,
     * while the goods are still in the supplier's shop and possibly hours from
     * leaving. Ash caught it on his own banana: the line said dispatched and
     * the Receive screen at the far end said Nothing on its way, and both were
     * telling the truth about different things.
     *
     * TICKING AND SENDING ARE TWO EVENTS and the asker cares about the
     * difference: PICKED means somebody has it in their hand, ON ITS WAY means
     * it has left. They come from two different facts — `is_checked` is the
     * line's, written one PUT at a time as a picker walks the freezer;
     * `goods_state` is the ORDER's, written once when the run is dispatched —
     * which is exactly why one could never stand in for the other.
     *
     * ORDER MATTERS, and it reads backwards from the end of the journey: a
     * counted-in line was on its way first, and an in-transit line was picked
     * first, so the later fact must win or a finished line reads as unfinished. */
    const delivered = new Set(rows
      .filter(r => r.status === 'delivered' || r.delivered_at || r.goods_state === 'settled')
      .map(r => r.id));
    const moving = new Set(rows.filter(r => r.goods_state === 'in_transit').map(r => r.id));
    const byReq = new Map(rows.map(r => [r.id, []]));
    for (const l of lines) {
      l.state = delivered.has(l.restock_id) ? 'arrived'
              : moving.has(l.restock_id)    ? 'transit'
              : (l.is_checked ? 'picked' : 'waiting');
      delete l.is_checked;
      byReq.get(l.restock_id).push(l);
    }
    // The shop it was asked OF, by name. The phone sends no store_name at all
    // on this flow, so the location id answers first and the free text is the
    // fallback for rows written before #259 gave it one.
    const nameOf = (id) => {
      if (!id) return '';
      try {
        const r = conn.prepare('SELECT name_en, name_cn FROM retail_stores WHERE id = ?').get(id);
        return r ? { name_en: r.name_en || '', name_cn: r.name_cn || '' } : '';
      } catch (e) { return ''; }
    };
    rows.forEach(r => {
      r.items = byReq.get(r.id) || [];
      // WITHDRAWN IS THE ONE GENUINELY REQUEST-LEVEL FACT, exactly as it is on
      // §175's screen. Archiving is how a request stops being outstanding, and
      // an asker reading a list of what they asked for must not be shown a
      // dead row as though somebody were still walking a freezer for it.
      r.withdrawn = !!r.archived_at;
      const from = nameOf(r.from_store_id);
      r.from_name_en = from ? from.name_en : '';
      r.from_name_cn = from ? from.name_cn : (r.store_cn || r.store_name || '');
    });
  }
  res.json({ success: true, data: rows });
});

router.get('/api/restock/:id', requireRestockAccess, kitchenScopedOrder, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  const items = tdb().prepare('SELECT * FROM restock_items WHERE restock_id = ? ORDER BY id').all(order.id);
  res.json({ success: true, data: { ...order, items: _attachRecorded(order, items) } });
});

// ── Create order ───────────────────────────────────────────────────────────
// Both `restock` (store-side requests) and `warehouse_inbox` (warehouse
// requesting from kitchen) users can post here. The handler infers
// direction from perms — see _inferDirection — so a warehouse user
// hitting "Send" doesn't need a destination picker; their request
// always goes to the kitchen.
router.post('/api/restock', requireRestockAccess, tacetOnly, (req, res) => {
  const { date, store_name, store_cn, notes, items, status, purpose } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required · 至少需要一项' });

  const dir = _inferDirection(req);
  // Warehouse → kitchen requests must declare WHY: 'order' (need it to
  // ship a customer order), 'shelf' (refill warehouse shelves), or 'urgent'
  // (an order that jumps the queue — see the sort in the list endpoint).
  // §65: 'urgent' is a THIRD VALUE here rather than a flag beside the other
  // two, so the column stays untyped TEXT and no row already written changes
  // meaning. An unknown value still falls through to null and is refused
  // below by name, which is what has always caught a stale client.
  const KITCHEN_PURPOSES = ['order', 'shelf', 'urgent'];
  const cleanPurpose = (dir.to_role === 'kitchen' && KITCHEN_PURPOSES.includes(purpose))
    ? purpose : null;
  if (dir.to_role === 'kitchen' && !cleanPurpose) {
    return res.status(400).json({ error: 'purpose required for kitchen requests · 必须选择请求原因' });
  }
  // Warehouse → store push: store_name is optional today (single-store
  // world). When set, the notification broadcaster routes only to staff
  // assigned to that market; when null, it falls back to broadcasting
  // to every user with the `restock` permission. Reintroduce a hard
  // requirement here once a second retail store is added.

  // A request the kitchen must MAKE is production, not a transfer — see the
  // note on genRsNumber. Read off the resolved direction rather than the body,
  // so a caller cannot pick its own prefix.
  const rs_number = genRsNumber(dir.to_role === 'kitchen' ? 'PR' : 'RS');
  const today = date || shopToday();
  const initialStatus = status === 'sent' ? 'sent' : 'draft';
  const sent_at = initialStatus === 'sent' ? new Date().toISOString() : null;

  // WHERE THE GOODS COME FROM AND WHERE THEY GO, DECIDED ONCE, HERE.
  //
  // A caller may name both ends outright — `from_store_id` / `to_store_id` — and
  // that is the general form: it is how Tianhe asks Yuexiu, a request the old
  // model could not express because it always sourced from the warehouse and
  // refused any destination equal to it.
  //
  // When they are not named, the two familiar shapes still resolve themselves,
  // because in both of them the warehouse is one end BY DEFINITION: a store
  // asking for stock receives it, and a warehouse push sends it. Anything the
  // pair cannot be worked out for is left NULL rather than guessed — the
  // transfer refuses on null and says so, which is the honest end for an order
  // nobody can place. A kitchen request has no pair at all and keeps none.
  const explicitFrom = parseInt(req.body && req.body.from_store_id, 10);
  const explicitTo   = parseInt(req.body && req.body.to_store_id, 10);
  let fromStoreId = Number.isFinite(explicitFrom) && explicitFrom > 0 ? explicitFrom : null;
  let toStoreId   = Number.isFinite(explicitTo)   && explicitTo   > 0 ? explicitTo   : null;
  if (dir.to_role === 'kitchen' || dir.from_role === 'kitchen') {
    fromStoreId = null; toStoreId = null;
  } else if (!fromStoreId || !toStoreId) {
    const wh = _resolveWarehouseStoreId();
    const other = _resolveDestStoreId(
      { store_name, store_cn, from_role: dir.from_role, created_by: req.user.id }, wh);
    if (wh && other) {
      // The warehouse supplies in both shapes; only the far end changes hands.
      fromStoreId = fromStoreId || wh;
      toStoreId   = toStoreId   || other;
    }
  }
  if (fromStoreId && toStoreId && fromStoreId === toStoreId) {
    return res.status(400).json({
      error: 'A transfer cannot leave from and arrive at the same location · 调拨的发出与接收地点不能相同',
    });
  }
  // §490 — WHOLE UNITS ONLY. The shelf and the ledger are integer columns, and
  // a 2.5 typed here went all the way to the shelf as 2.5 (SQLite stores a
  // fraction in an INTEGER column as a REAL). Purchase receiving rounds; a
  // transfer is counted by hand and is refused instead, naming the line.
  const fractional = items.find(it => it && it.qty_requested != null && it.qty_requested !== ''
    && !Number.isInteger(Number(it.qty_requested)));
  if (fractional) {
    return res.status(400).json({
      error: 'quantity_not_whole',
      message: `A quantity must be a whole number of units (${fractional.product_name || fractional.sku || 'a line'}: ${fractional.qty_requested}).`,
    });
  }

  // One handle for both statements and the transaction they run in.
  const conn = tdb();
  const insertOrder = conn.prepare(`INSERT INTO restock_orders
    (rs_number, date, status, store_name, store_cn, notes, sent_at, created_by, from_role, to_role, purpose,
     from_store_id, to_store_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItem = conn.prepare(`INSERT INTO restock_items
    (restock_id, product_id, product_name, product_cn, sku, qty_requested, unit, notes)
    VALUES (?,?,?,?,?,?,?,?)`);

  const tx = conn.transaction(() => {
    const result = insertOrder.run(rs_number, today, initialStatus, store_name || null, store_cn || null, notes || null,
      sent_at, req.user.id, dir.from_role, dir.to_role, cleanPurpose, fromStoreId, toStoreId);
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
      _fireRestockPush(id, 'sent', _actorOperatorId(req));
      _broadcastRestock(id, 'sent', req.user.id);
      // Paper, for the kitchen queue. No-ops for every other direction — the
      // kitchen's roll is its own, and §51's note on lib/kitchen-print.js says
      // why it cannot be keyed on a location.
      _kprint.autoPrintKitchenRequest(id, 'sent');
      // And paper for the SHOP that has to fill it (§198), which is the same
      // event on the other roll. No-ops for a kitchen request and for any
      // request with no supplier named; the two calls can never both print,
      // because each refuses what the other takes.
      _tprint.autoPrintTransferRequest(id, 'sent');
    }
    res.json({ success: true, id, rs_number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update order (store can edit drafts; both sides can edit notes) ────────
router.put('/api/restock/:id', requireRestockAccess, kitchenScopedOrder, (req, res) => {
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

// Applies an order-level status transition and every side effect that goes
// with it. Pulled out of the endpoint below so the per-item rollup (the
// kitchen queue split, decisions §61) can reach the exact same dispatch/push/
// print path when the last line catches the order up, rather than a second
// copy that could drift from this one.
/* `opts.announce === false` STAMPS THE STATUS AND TELLS NOBODY, and it exists
   for exactly one caller: the receipt endpoint, which has already told both
   sides itself in better words (§211). Everything else keeps the old
   behaviour by leaving it off — the fan-out below is the default. */
function _advanceOrderStatus(order, status, req, opts) {
  const announce = !opts || opts.announce !== false;
  const now = new Date().toISOString();
  const tsCol = { sent:'sent_at', received:'received_at', prepared:'prepared_at', delivered:'delivered_at' }[status];
  tdb().prepare(`UPDATE restock_orders SET status = ?, ${tsCol} = ? WHERE id = ?`).run(status, now, order.id);

  // Kitchen lines carry their own status (§61). An order-level advance —
  // through this function, whichever door called it — always brings every
  // line on the order up to at least the same point, so a legacy caller that
  // never touches a single item (the transfer flow; the old kitchen app)
  // still leaves the two in step.
  const itemTsCol = { received: 'received_at', prepared: 'prepared_at' }[status];
  if (itemTsCol) {
    const toIdx = STATUS_FLOW.indexOf(status);
    const behind = tdb().prepare('SELECT id, status FROM restock_items WHERE restock_id = ?').all(order.id)
      .filter(it => STATUS_FLOW.indexOf(it.status || 'sent') < toIdx);
    const bump = tdb().prepare(`UPDATE restock_items SET status = ?, ${itemTsCol} = COALESCE(${itemTsCol}, ?) WHERE id = ?`);
    behind.forEach(it => bump.run(status, now, it.id));
  }

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
  if (announce && (status === 'sent' || status === 'prepared' || status === 'delivered')) {
    _fireRestockPush(order.id, status, _actorOperatorId(req));
    _broadcastRestock(order.id, status, req.user.id);
  }
  // The kitchen's slip, for the two events that mean anything on paper. Which
  // of them actually prints is the tenant's setting (printer.kitchen_print_on)
  // — Roots prints on arrival only, because the people who would read a
  // completion slip are the people who just cooked it. 'delivered' never
  // prints: a warehouse→kitchen request closes at 'prepared'.
  if (status === 'sent' || status === 'prepared') {
    _kprint.autoPrintKitchenRequest(order.id, status);
  }
  // The supplier's slip (§198), for the one event that means anything on their
  // floor. A draft sent later must print exactly as one sent on creation does —
  // the two paths are the same request arriving, and a slip that depended on
  // which button raised it is the kind of difference nobody can see from the
  // shop floor. 'prepared' deliberately prints nothing: by then the goods have
  // left, and the only people who would read it are the ones who packed them.
  if (status === 'sent') {
    _tprint.autoPrintTransferRequest(order.id, 'sent');
  }
  return transfer;
}

// ── Status transition (sent / received / prepared / delivered) ─────────────
router.put('/api/restock/:id/status', requireRestockAccess, kitchenScopedOrder, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  const { status } = req.body;
  if (!STATUS_FLOW.includes(status)) return res.status(400).json({ error: 'Invalid status · 状态无效' });

  const fromIdx = STATUS_FLOW.indexOf(order.status);
  const toIdx   = STATUS_FLOW.indexOf(status);
  if (toIdx <= fromIdx) return res.status(400).json({ error: `Cannot move backward 状态不能后退: ${order.status} → ${status}` });

  const transfer = _advanceOrderStatus(order, status, req);
  // The status change itself succeeded. When the stock movement did not, say so
  // in the response so the screen can put it in front of the person who just
  // pressed the button — it used to be a console warning only, which meant a
  // failed transfer looked exactly like a successful one.
  if (transfer && transfer.ok === false) {
    return res.json({ success: true, stock_transfer: { ok: false, error: transfer.error } });
  }
  res.json({ success: true });
});

// ── Per-item status (the kitchen queue split) ───────────────────────────────
// A kitchen request used to move as one block: one status on restock_orders,
// one button, every line forced to start and finish together. Ash's report —
// "they can split what they start making, what was made. its all one batch" —
// is decisions §61: each restock_items row now carries its own status, and
// this is the door that advances one. restock_orders.status stays the
// rollup, brought forward by _advanceOrderStatus the moment every line has
// reached the same point — which is what keeps dispatch/push/print, all keyed
// on the ORDER status, firing exactly once, exactly as before this existed.
router.put('/api/restock/:id/item/:item_id/status', requireRestockAccess, kitchenScopedOrder, (req, res) => {
  const order = tdb().prepare('SELECT * FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  // Splitting which item is being worked on is a kitchen-queue idea — a
  // transfer between locations has no such concept and stays on the
  // whole-order endpoint above.
  if ((order.to_role || 'warehouse') !== 'kitchen') {
    return res.status(403).json({
      error: 'This is a transfer between locations, not a kitchen request · 这是门店之间的调拨,不是厨房制作请求。',
    });
  }
  const item = tdb().prepare('SELECT * FROM restock_items WHERE id = ? AND restock_id = ?').get(req.params.item_id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found · 项目未找到' });

  const { status } = req.body;
  // Only the two steps the kitchen queue actually asks for. 'sent' is where
  // every line starts and 'delivered' never applies to a kitchen line — see
  // the comment on STATUS_FLOW.
  if (status !== 'received' && status !== 'prepared') {
    return res.status(400).json({ error: 'Invalid status · 状态无效' });
  }
  const fromStatus = item.status || 'sent';
  const fromIdx = STATUS_FLOW.indexOf(fromStatus);
  const toIdx   = STATUS_FLOW.indexOf(status);
  if (toIdx <= fromIdx) return res.status(400).json({ error: `Cannot move backward 状态不能后退: ${fromStatus} → ${status}` });

  const now = new Date().toISOString();
  const tsCol = { received: 'received_at', prepared: 'prepared_at' }[status];
  tdb().prepare(`UPDATE restock_items SET status = ?, ${tsCol} = ? WHERE id = ?`).run(status, now, item.id);
  logActivity(req.user.id, req.user.username, 'status_change', 'restock_item', item.id, { from: fromStatus, to: status }, req.ip);

  // The order catches up the moment every one of its lines has reached this
  // point — never before, and never for a line still behind.
  const items = tdb().prepare('SELECT status FROM restock_items WHERE restock_id = ?').all(order.id);
  const everyLineCaughtUp = items.length > 0 && items.every(it => STATUS_FLOW.indexOf(it.status || 'sent') >= toIdx);
  let transfer = null;
  if (everyLineCaughtUp && STATUS_FLOW.indexOf(order.status) < toIdx) {
    transfer = _advanceOrderStatus(order, status, req);
  }
  if (transfer && transfer.ok === false) {
    return res.json({ success: true, stock_transfer: { ok: false, error: transfer.error } });
  }
  res.json({ success: true, order_status: everyLineCaughtUp ? status : order.status });
});

// ── Reprint the kitchen's slip ─────────────────────────────────────────────
//
// PAPER RUNS OUT, AND THAT IS NOT A REASON TO LOSE A JOB. The slip prints once,
// automatically, when the request lands in the queue — and the one thing that
// is certain about a thermal printer in a kitchen is that some morning it will
// be out of paper, off, or offline. The auto-print records exactly that on the
// order (print_status = 'failed'), so the queue can show it and offer this.
//
// WHOEVER WORKS THE QUEUE CAN PRESS IT. Same guard as every other action on a
// kitchen request, and kitchenScopedOrder refuses a store transfer here for the
// same reason it refuses one everywhere else: a transfer between shelves has
// its own paper trail and must never surface on the kitchen's roll.
//
// FORCED, DELIBERATELY. A reprint is somebody standing at the printer asking
// for this slip now. It ignores printer.kitchen_print_on — which governs what
// prints BY ITSELF — because a tenant switching off automatic completion slips
// has not said the kitchen may never reprint one. It cannot bypass a missing
// SN or absent credentials: those are "there is no printer", not a preference.
router.post('/api/restock/:id/reprint', requireRestockAccess, kitchenScopedOrder, async (req, res) => {
  const conn = tdb();
  const order = conn.prepare('SELECT id, status, to_role FROM restock_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found · 未找到' });
  // THE OBJECT TYPE, CHECKED HERE, BECAUSE THE MIDDLEWARE ABOVE CHECKS
  // SOMETHING ELSE. kitchenScopedOrder is a SCOPE limiter: it confines an
  // account that can fulfil but not pick — the `kitchen` role, and on the
  // shipped presets only that one — to kitchen requests. Every other role that
  // reaches these endpoints (owner, admin, manager, warehouse, store_manager)
  // works transfers legitimately and passes through, which is correct for the
  // endpoints that serve both.
  //
  // THIS ENDPOINT NOW SERVES BOTH, AND THE REFUSAL IS GONE RATHER THAN WIDENED
  // (§198). It refused a transfer because a transfer had no slip to reprint —
  // the failed print then stamped print_status on a row that was never owed
  // one, which is the defect the refusal was added for. A transfer has a slip
  // now, so the honest fix is to print it. The object type still decides WHICH
  // roll: the two modules refuse each other's rows by construction, so there is
  // no arrangement in which one request reaches both.
  const isKitchen = (order.to_role || 'warehouse') === 'kitchen';
  // The slip says what state the job is in, so reprint the one that matches
  // where the request actually IS — not the event that happened to print first.
  // A transfer has only the one slip: 'sent' is the whole of its vocabulary.
  const kind = !isKitchen ? 'sent'
             : (order.status === 'prepared' || order.status === 'delivered') ? 'prepared'
             : 'sent';
  const mod = isKitchen ? _kprint : _tprint;
  const print = isKitchen
    ? _kprint.printKitchenRequest(order.id, kind, { conn, force: true })
    : _tprint.printTransferRequest(order.id, kind, { conn, force: true });
  const r = await print.catch(e => ({ ok: false, msg: e.message }));
  mod.recordPrintResult(conn, order.id, r);
  logActivity(req.user.id, req.user.username, 'reprint', 'restock', order.id, { ok: !!r.ok, kind }, req.ip);
  if (!r.ok) return res.status(502).json({ success: false, error: r.msg || 'print_failed' });
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
// (requireRestockAccess — the identical middleware the status endpoint uses),
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
router.post('/api/restock/:id/retry-dispatch', requireRestockAccess, tacetOnly, (req, res) => {
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
  if (result.ok && result.skipped === 'nothing_sent') {
    return res.json({
      success: true, retried: true, stock_moved: false,
      message: 'Every line was picked as 0, so nothing was sent. The order is closed.',
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

  // THE GOODS LEFT ON THIS CALL, so the far end is told on this call. The first
  // attempt rolled back and fired nothing; without this the retry that actually
  // dispatched was the one transition nobody downstream ever heard about.
  _fireRestockPush(order.id, 'prepared', _actorOperatorId(req));
  _broadcastRestock(order.id, 'prepared', req.user.id);
  res.json({
    success: true, retried: true, stock_moved: true, moved: result.moved || 0,
    goods_state: 'in_transit',
    message: `Sent. ${result.moved || 0} line${result.moved === 1 ? '' : 's'} left the warehouse.`,
  });
});

// ── Mark item prepared (warehouse side) ────────────────────────────────────
router.put('/api/restock/:id/item/:item_id', requireRestockAccess, kitchenScopedOrder, (req, res) => {
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
  /* `clear_qty_sent` PUTS A LINE BACK TO UNTOUCHED, and it needs its own flag
     because `COALESCE(?, qty_sent)` cannot express it: a missing `qty_sent` and
     a `qty_sent` of null are the same request on the wire, and the existing
     meaning of both — leave it alone — is what every caller but one relies on.
     It is opt-in and explicit for that reason; nothing that does not ask for it
     changes (§214).

     WHY UN-TICKING ALONE WOULD NOT BE ENOUGH. Dispatch reads
     `COALESCE(qty_sent, qty_requested)` and never looks at `is_checked`, so a
     line un-ticked with a stale `qty_sent` would dispatch the OLD figure — a
     picker undoing "1 of 2" and sending without re-picking would move 1 and
     nobody would see why. Un-ticked with a quantity on it is a state that has
     never existed on this table, and this keeps it that way. */
  const { is_checked, qty_sent } = req.body;
  const clearSent = req.body && req.body.clear_qty_sent === true;
  // §490 — a picked quantity is a whole number of units, or it is refused.
  if (!clearSent && qty_sent != null && qty_sent !== '' && (!Number.isInteger(Number(qty_sent)) || Number(qty_sent) < 0)) {
    return res.status(400).json({
      error: 'quantity_not_whole',
      message: `A picked quantity must be a whole number of units, 0 or more (got ${qty_sent}).`,
    });
  }
  tdb().prepare(`UPDATE restock_items SET
    is_checked = COALESCE(?, is_checked),
    qty_sent   = ${clearSent ? 'NULL' : 'COALESCE(?, qty_sent)'}
    WHERE id = ?`).run.apply(null, clearSent
      ? [is_checked == null ? null : (is_checked ? 1 : 0), item.id]
      : [is_checked == null ? null : (is_checked ? 1 : 0),
         qty_sent == null ? null : parseFloat(qty_sent),
         item.id]);
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
router.put('/api/restock/:id/receive', requireRestockAccess, tacetOnly, (req, res) => {
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
  // §490 — a count of 2.5 is not a count of units. Refused by name rather than
  // skipped: a skipped line reads as "not counted yet" and the counter, who
  // typed a number, would not know why the receipt never settles.
  const fractional = counts.find(c => c && c.qty_received != null && c.qty_received !== ''
    && Number.isFinite(Number(c.qty_received)) && !Number.isInteger(Number(c.qty_received)));
  if (fractional) {
    return res.status(400).json({
      error: 'quantity_not_whole',
      message: `A counted quantity must be a whole number of units (got ${fractional.qty_received}).`,
      counts_written: 0,
    });
  }
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
  // THE PUSH IS ITS OWN KIND, and it is not the broadcast's compromise above:
  // the sender is waiting to hear the boxes were counted, and until now this
  // endpoint sent them nothing at all.
  /* THE PAPERWORK FOLLOWS THE GOODS (§211). Ash, having counted a real
     transfer in: *"once received the package at the location and record
     everything ... where it goes after that"*. The goods went where they
     should — onto the shelf, into the ledger, out to every channel. The ORDER
     went nowhere: `goods_state` settled, and `status` sat at 'prepared' for
     ever, because Active and History are split on STATUS and only 'delivered'
     closes a transfer.

     NOTHING HAS EVER WRITTEN THAT STATUS. It is the same dead column §208
     found gating the Receive screen, biting a second time one screen along:
     its only writer is this function, and until now no client called it with
     'delivered'. So a fully counted transfer stayed in Active looking like
     open work, never reached History, and was never swept — the daily archive
     deliberately skips shop-to-shop rows (§198).

     COUNTED IN *IS* THE CLOSURE, so the receipt writes it. A separate "mark
     delivered" step was rejected in §208 for the reason that still holds: it
     asks the sending shop to assert a fact only the receiving shop can know.

     SILENTLY, AND THAT IS THE POINT OF `announce:false`. Both sides have
     already been told, in the two lines below, and better: the sender gets
     *counted in · 已点收*, which is what happened, rather than 'delivered''s
     *已送达*, which is about a driver's leg. Left to announce itself this
     would send the SAME audience — `restock:pick` at the `from` store, for
     both kinds — two pushes for one event. */
  const fromIdx = STATUS_FLOW.indexOf(order.status);
  if (fromIdx >= 0 && fromIdx < STATUS_FLOW.indexOf('delivered')
      && (order.to_role || 'warehouse') !== 'kitchen') {
    try { _advanceOrderStatus(order, 'delivered', req, { announce: false }); }
    catch (e) {
      // The stock has already moved and been stamped. A status that could not
      // be written leaves the order in Active — untidy, and the old behaviour
      // exactly — which is not worth failing a settled receipt over.
      console.warn('[restock-receipt] could not close order ' + order.id + ':', e.message);
    }
  }
  _fireRestockPush(order.id, 'received', _actorOperatorId(req));
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

router.get('/api/restock/in-transit', requireRestockAccess, tacetOnly, (req, res) => {
  res.json({ success: true, data: inTransitByProduct() });
});

// ── Archive / unarchive ────────────────────────────────────────────────────
// Soft-delete toggle for inbox/history cleanup. POST body { archived: true }
// stamps archived_at = now; { archived: false } clears it. The row is
// preserved either way — this only flips the visibility flag the list
// endpoint filters on.
router.put('/api/restock/:id/archive', requireRestockAccess, tacetOnly, (req, res) => {
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
router.post('/api/restock/archive-bulk', requireRestockAccess, tacetOnly, (req, res) => {
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

/* A DELETE ENDPOINT STOOD HERE (§81). `DELETE /api/restock/:id` removed a
   DRAFT restock order and was gated on requireAuth + requireDelete +
   requirePermission('restock') — three gates, all on the retired realm, and
   public/app.html was its only caller. Tacet Mobile has never had a delete on
   this screen. Nothing replaces it: a draft nobody can reach is not a job. */

/* ── §101: THE NIGHT'S ORDERS RAISE THEIR OWN KITCHEN REQUEST ──────────────
   §84 gave the kitchen the number and gave it to one screen. Push, the printed
   slip, the deep link and the card that closes a line all key on a
   `restock_orders` row, and a night of `awaiting_restock` pre-orders creates
   none — so the fact reached nobody who had not thought to look for it.
   Ash: "we need it to be push, print".

   NOTHING NEW IS WIRED HERE, and that is the whole reason this shape was
   chosen over a digest notification: the three calls below are the SAME three,
   in the same order, that POST /api/restock fires on a request it creates
   `sent`. The audience is §51's, the deep link is §71's, the printer is §51's.

   THE ACTOR IS NULL BECAUSE THERE IS NOBODY TO EXCLUDE. Both notifiers take an
   actor only to keep a person's own action from pinging their own phone, and
   this request has no author — which is also what `auto_source` records.

   `genRsNumber` IS PASSED IN RATHER THAN REIMPLEMENTED (§80's copy rule): a
   second per-prefix daily sequence is how two requests come to be called
   PR-260911-002. */
require('../lib/kitchen-morning-request').startMorningKitchenRequestSweeper({
  genRsNumber,
  onRaised: ({ id }) => {
    _fireRestockPush(id, 'sent', null);
    _broadcastRestock(id, 'sent', null);
    _kprint.autoPrintKitchenRequest(id, 'sent');
  },
});

module.exports = router;
// Exported for scripts/test_warehouse_store_pin.js — the tier order in
// _resolveWarehouseStoreId is the whole point of the configured key, and it is
// not observable through any endpoint without moving real stock.
module.exports._resolveWarehouseStoreId = _resolveWarehouseStoreId;
