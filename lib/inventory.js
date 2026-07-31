// Dual-location retail inventory service.
//
// Stock is tracked per (store, product) in `retail_store_stock` with layers:
//   physical_qty   = real units at the store
//   safety_buffer  = held back from any channel (sync-delay protection)
//   wechat_quota   = optional sub-cap for mini-app sales (NULL = no extra cap)
//   meituan_quota  = optional sub-cap for Meituan (NULL = no extra cap)
//
// Active soft-reserves (`retail_stock_reservations.status = 'active'`) hold
// stock during the pending-payment window. On payment they commit, deducting
// physical_qty and writing a ledger row. On expiry or cancel they release.
//
// Availability formula per channel:
//   global_remaining  = physical_qty - safety_buffer - SUM(active reservations all-channels)
//   channel_remaining = (channel_quota == NULL ? +inf : channel_quota - SUM(active reservations in channel))
//   available         = max(0, min(global_remaining, channel_remaining))
//
// All multi-step operations use a tdb().transaction() so concurrent order
// creates can't oversell — better-sqlite3 serializes transactions.

const db = require('../database');
// Tenant-aware data access (Phase 2). tdb() = the request's tenant connection
// when called inside a tenant scope (set by retail.js's gate), else the global
// db. So storefront/order callers under a tenant scope read that tenant's
// stock; kitchen-side callers (no scope) are unchanged.
const { tdb, tenantAls, getTenantDb, ROOTS_TENANT_ID, DATA_ISOLATION_READY, currentTenantId } = require('./tenant-db');
const { haversineKm, drivingDistanceKm } = require('./geocode');

const RESERVATION_TTL_MIN_DEFAULT = 15;

// Hook fired with the list of order_ids promoted from awaiting_restock → paid by
// a stock adjustment. retail.js registers a handler (post-payment side effects
// like the referral credit) — kept as a callback to avoid a circular require.
let _onOrdersPromoted = null;
function setOnOrdersPromoted(fn) { _onOrdersPromoted = fn; }

// Push a (store, product)'s current physical_qty to Meituan via the sync queue.
// Called after every physical_qty mutation so Meituan tracks sale-driven
// depletion, not just operator edits (the admin stock route enqueues on its own).
// Lazy require breaks the meituan-bundles → (db) cycle; best-effort so a sync
// hiccup never aborts the surrounding stock transaction. Uses tdb() so it writes
// to the same tenant connection as the mutation.
function enqueueMeituanSync(storeId, productId) {
  try {
    require('./meituan-bundles').enqueueProductStock(tdb(), storeId, productId);
  } catch (e) { console.error('[inventory] enqueueMeituanSync:', e.message); }
}

// Same hook for the Guanyi (gzgrocery) channel — see lib/guanyi-sync. Separate
// function/require so a fault in one channel can't block the other.
function enqueueGuanyiSync(storeId, productId) {
  try {
    require('./guanyi-sync').enqueueProductStock(tdb(), storeId, productId);
  } catch (e) { console.error('[inventory] enqueueGuanyiSync:', e.message); }
}

// Same hook for the Eleme (饿了么 open-platform) channel. Gated internally on the
// 'eleme.enabled' tenant switch + a per-product map, so a tenant not using Eleme
// pays nothing here. Separate require so an Eleme fault can't block other channels.
function enqueueElemeSync(storeId, productId) {
  try {
    require('./eleme-sync').enqueueProductStock(tdb(), storeId, productId);
  } catch (e) { console.error('[inventory] enqueueElemeSync:', e.message); }
}

// Fan a stock change out to every sales channel that mirrors our inventory.
function enqueueChannelSync(storeId, productId) {
  enqueueMeituanSync(storeId, productId);
  enqueueGuanyiSync(storeId, productId);
  enqueueElemeSync(storeId, productId);
}

function ttlMinutes() {
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'inventory.reservationTtlMinutes'").get();
    if (row) {
      const v = parseInt(JSON.parse(row.value_json), 10);
      if (v > 0) return v;
    }
  } catch {}
  return RESERVATION_TTL_MIN_DEFAULT;
}

function listStores({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return tdb().prepare(
    `SELECT id, code, name_en, name_cn, address, city, district, lat, lng, phone,
            meituan_account_id, is_active, pickup_enabled, sort_order, open_time, close_time,
            low_stock_threshold, created_at, updated_at
       FROM retail_stores ${where} ORDER BY sort_order ASC, id ASC`
  ).all();
}

function getStore(storeId) {
  return tdb().prepare('SELECT * FROM retail_stores WHERE id = ?').get(storeId);
}

// Online-storefront order channel → channel_status key. The mini-app leaves
// channel unset ('wechat'); the web shop tags 'web'. routeOrder only ever runs for
// these two (Meituan/gzgrocery orders arrive via their daemons, not routeOrder).
function orderChannelKey(channel) { return channel === 'web' ? 'web' : 'mini_app'; }

// Store codes whose WHOLE shop is closed — store_business_status.fulfillment_open
// = 0, the "this location isn't operating" switch (POST /api/retail-admin/
// store-status/store/:code and the Sales-page location master). It is not a
// channel: a shop with its shutter down fulfils nothing, so this set is unioned
// into EVERY channel's closed set below rather than living beside it.
// Absent row / NULL = fulfilling. Never throws so routing survives an older DB.
function storeClosedStores() {
  try {
    return new Set(
      tdb().prepare('SELECT store_code FROM store_business_status WHERE fulfillment_open = 0')
        .all().map(r => r.store_code)
    );
  } catch (e) { return new Set(); }
}

// Store codes CLOSED for a given channel: that channel's own cell
// (channel_status.is_open = 0) PLUS every store closed shop-wide. A closed store
// drops out of routeOrder's candidate pool, analyzeShortage's candidate pool, the
// pickup list and the out-of-city shipper, so its orders reroute to the store
// that is still open.
// Absent row = open. Never throws (empty set) so routing survives a fresh/older DB.
function channelClosedStores(channelKey) {
  const closed = storeClosedStores();
  try {
    for (const r of tdb().prepare('SELECT store_code FROM channel_status WHERE channel = ? AND is_open = 0').all(channelKey)) {
      closed.add(r.store_code);
    }
  } catch (e) { /* table missing / db busy — shop-wide closures still stand */ }
  return closed;
}

// True when EVERY active store is closed for this channel → nothing can fulfill it,
// so checkout should reject with a clean "channel closed" message rather than let
// routeOrder fail with a bare no_active_store.
function channelFullyClosed(channelKey) {
  const closed = channelClosedStores(channelKey);
  const stores = listStores({ activeOnly: true });
  return stores.length > 0 && stores.every(s => closed.has(s.code));
}

// Store codes that can't hand a pickup over: closed shop-wide, or closed for BOTH
// online channels (mini_app AND web) — i.e. the shop isn't fulfilling any online
// orders, so it should also drop off the pickup list. (Pickup is a physical
// hand-over; a shop still fulfilling one online channel can still hand over
// pickups, so a single closed channel doesn't hide it.)
function onlineFullyClosedStores() {
  const closed = storeClosedStores();
  try {
    for (const r of tdb().prepare(`
      SELECT store_code FROM channel_status
       WHERE channel IN ('mini_app','web') AND is_open = 0
       GROUP BY store_code HAVING COUNT(DISTINCT channel) = 2
    `).all()) closed.add(r.store_code);
  } catch (e) { /* table missing / db busy — shop-wide closures still stand */ }
  return closed;
}

// The same "not serving the storefront at all" set as onlineFullyClosedStores,
// expressed as SQL so the catalog queries can apply it inside their existing
// one-pass stock aggregate instead of post-filtering thousands of rows in JS.
const CLOSED_STORE_CODES_SQL = `
      SELECT store_code FROM store_business_status WHERE fulfillment_open = 0
       UNION
      SELECT store_code FROM channel_status
       WHERE channel IN ('mini_app','web') AND is_open = 0
       GROUP BY store_code HAVING COUNT(DISTINCT channel) = 2`;

// SQL expression for the units a customer can actually be sold right now: the
// per-store shelves summed across OPEN stores only. A closed shop is invisible
// here — its stock is either already moved to the shop that stayed open or it is
// behind a shutter, and in both cases counting it sells something nobody can
// pick. Without this the catalog says "in stock" on a closed shop's shelf and
// checkout then refuses the order, which is the same lie told one screen later.
//
// The three arms, in order:
//   1. what the open shops hold;
//   2. 0 when the product IS tracked per-store but at no open shop — the shelf
//      exists and is unreachable, which is a real zero, not missing data;
//   3. the legacy flat store_products column, ONLY for a product that has no
//      per-store rows anywhere (never stocked per-store), so a newly-added
//      product doesn't silently read as sold out.
function sellableStockSql(productIdExpr, legacyQtyExpr) {
  return `COALESCE(
    (SELECT SUM(rss.physical_qty)
       FROM retail_store_stock rss
       JOIN retail_stores      rs ON rs.id = rss.store_id
      WHERE rss.product_id = ${productIdExpr} AND rs.is_active = 1
        AND rs.code NOT IN (${CLOSED_STORE_CODES_SQL})),
    (SELECT 0
       FROM retail_store_stock rss_any
       JOIN retail_stores      rs_any ON rs_any.id = rss_any.store_id
      WHERE rss_any.product_id = ${productIdExpr} AND rs_any.is_active = 1
      LIMIT 1),
    ${legacyQtyExpr})`;
}

// Active reservations sum, optionally scoped to a channel. `ignoreOrderIds`
// (array/Set of order ids) drops those orders' holds from the sum — used so a
// customer's OWN still-unpaid (pending_payment) orders don't make their next
// order read as out-of-stock (which used to bounce it to a farther store as a
// spurious 缺货 reroute). Scoped to the one customer's own orders by the caller.
function sumActiveReservations(storeId, productId, channel, ignoreOrderIds) {
  const params = [storeId, productId];
  let sql = `SELECT COALESCE(SUM(qty), 0) AS n
               FROM retail_stock_reservations
              WHERE store_id = ? AND product_id = ? AND status = 'active'`;
  if (channel) { sql += ' AND channel = ?'; params.push(channel); }
  const ignore = ignoreOrderIds ? [...ignoreOrderIds].filter(id => id != null) : [];
  if (ignore.length) {
    sql += ` AND order_id NOT IN (${ignore.map(() => '?').join(',')})`;
    params.push(...ignore);
  }
  return tdb().prepare(sql).get(...params).n;
}

// Per-store availability for a product on a given channel. `ignoreOrderIds`
// excludes those orders' active holds from BOTH the global and the per-channel
// reservation sums (see sumActiveReservations).
function getAvailable(storeId, productId, channel = 'wechat', ignoreOrderIds) {
  const row = tdb().prepare(
    `SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota
       FROM retail_store_stock
      WHERE store_id = ? AND product_id = ?`
  ).get(storeId, productId);
  if (!row) return { available: 0, exists: false, physical: 0, safety: 0, channelQuota: null };

  const allReserved     = sumActiveReservations(storeId, productId, null, ignoreOrderIds);
  const chanReserved    = sumActiveReservations(storeId, productId, channel, ignoreOrderIds);
  const globalRemaining = Math.max(0, row.physical_qty - row.safety_buffer - allReserved);

  let chanRemaining = Infinity;
  const quotaCol = channel === 'meituan' ? row.meituan_quota : channel === 'wechat' ? row.wechat_quota : null;
  if (quotaCol != null) chanRemaining = Math.max(0, quotaCol - chanReserved);

  return {
    available: Math.max(0, Math.min(globalRemaining, chanRemaining)),
    exists: true,
    physical: row.physical_qty,
    safety: row.safety_buffer,
    channelQuota: quotaCol,
    activeAllChannels: allReserved,
    activeThisChannel: chanReserved,
  };
}

// Batch twin of getAvailable: one pass over a store's shelf + its active
// reservations instead of 3 queries per product. Returns Map(product_id →
// the same shape getAvailable gives). Products with no row at this store are
// absent from the map (the caller decides what "not stocked here" means —
// getAvailable's `exists: false`). `productIds` narrows the scan; omit it for
// the whole store.
function getAvailableMap(storeId, productIds = null, channel = 'wechat', ignoreOrderIds) {
  const ids = productIds ? [...new Set(productIds.map(n => parseInt(n, 10)).filter(Boolean))] : null;
  if (ids && !ids.length) return new Map();
  const idClause = ids ? ` AND product_id IN (${ids.map(() => '?').join(',')})` : '';

  const rows = tdb().prepare(
    `SELECT product_id, physical_qty, safety_buffer, wechat_quota, meituan_quota
       FROM retail_store_stock WHERE store_id = ?${idClause}`
  ).all(storeId, ...(ids || []));
  if (!rows.length) return new Map();

  // Active holds, summed per product in one go — all-channel and this-channel,
  // with the same ignoreOrderIds carve-out sumActiveReservations applies.
  const ignore = ignoreOrderIds ? [...ignoreOrderIds].filter(id => id != null) : [];
  const ignoreClause = ignore.length ? ` AND order_id NOT IN (${ignore.map(() => '?').join(',')})` : '';
  const holds = tdb().prepare(
    `SELECT product_id,
            COALESCE(SUM(qty), 0)                                   AS all_qty,
            COALESCE(SUM(CASE WHEN channel = ? THEN qty ELSE 0 END), 0) AS chan_qty
       FROM retail_stock_reservations
      WHERE store_id = ? AND status = 'active'${idClause}${ignoreClause}
      GROUP BY product_id`
  ).all(channel, storeId, ...(ids || []), ...ignore);
  const holdBy = new Map(holds.map(h => [h.product_id, h]));

  const out = new Map();
  for (const row of rows) {
    const h = holdBy.get(row.product_id) || { all_qty: 0, chan_qty: 0 };
    const globalRemaining = Math.max(0, row.physical_qty - row.safety_buffer - h.all_qty);
    let chanRemaining = Infinity;
    const quotaCol = channel === 'meituan' ? row.meituan_quota : channel === 'wechat' ? row.wechat_quota : null;
    if (quotaCol != null) chanRemaining = Math.max(0, quotaCol - h.chan_qty);
    out.set(row.product_id, {
      available: Math.max(0, Math.min(globalRemaining, chanRemaining)),
      exists: true,
      physical: row.physical_qty,
      safety: row.safety_buffer,
      channelQuota: quotaCol,
      activeAllChannels: h.all_qty,
      activeThisChannel: h.chan_qty,
    });
  }
  return out;
}

// Rank stores by real proximity to a geocoded address. Haversine (straight-
// line) distance is only a cheap pre-filter here — it ignores the Pearl
// River and actual roads, so two stores on opposite banks can read as
// near-tied by Haversine while one needs a much longer bridge detour. Real
// road distance (drivingDistanceKm) is the source of truth for the final
// order; Haversine is the fallback when the routing APIs are unkeyed, down,
// or return a partial result.
//
// `stores` must already be filtered to candidates worth ranking (active,
// channel-open). Returns Promise<[{ store, distance_km, source: 'road'|'haversine' }]>
// sorted nearest-first, covering every input store — never throws.
async function rankStoresByProximity(stores, addrLat, addrLng) {
  const haversineRanked = stores
    .map(s => ({
      store: s,
      km: (typeof s.lat === 'number' && typeof s.lng === 'number')
        ? haversineKm({ lat: addrLat, lng: addrLng }, { lat: s.lat, lng: s.lng })
        : null,
    }))
    .sort((a, b) => {
      if (a.km == null && b.km == null) return 0;
      if (a.km == null) return  1;
      if (b.km == null) return -1;
      return a.km - b.km;
    });

  // Cap the road-distance API calls to the nearest few candidates by
  // Haversine — cheap today (2 stores), still bounded as more stores or
  // tenants are added. Anything outside this set is already farther by
  // straight-line distance than every checked candidate.
  const ROAD_CHECK_LIMIT = 4;
  const toCheck = haversineRanked.filter(r => r.km != null).slice(0, ROAD_CHECK_LIMIT);
  const toHaversine = () => haversineRanked.map(r => ({ store: r.store, distance_km: r.km, source: 'haversine' }));
  if (toCheck.length < 2) return toHaversine();

  const roadResults = await Promise.all(toCheck.map(r =>
    drivingDistanceKm({
      origin: { lat: addrLat, lng: addrLng },
      destination: { lat: r.store.lat, lng: r.store.lng },
    }).catch(() => null)
  ));

  // All-or-nothing: only trust road distance when EVERY checked candidate
  // resolved — comparing a resolved road km against a failed one's Haversine
  // km isn't a fair comparison and could flip the order on bad data.
  if (!roadResults.every(r => r && r.km != null)) return toHaversine();

  const roadRanked = toCheck
    .map((r, i) => ({ store: r.store, distance_km: roadResults[i].km, source: 'road' }))
    .sort((a, b) => a.distance_km - b.distance_km);
  const rest = haversineRanked.slice(toCheck.length)
    .map(r => ({ store: r.store, distance_km: r.km, source: 'haversine' }));
  return [...roadRanked, ...rest];
}

// Order routing: given an address and a list of {product_id, qty} items,
// pick a store that can satisfy ALL items, preferring (1) the nearest store
// by real road distance when the address is geocoded, else (2) the store
// linked to the matching delivery zone, (3) a store whose home district
// matches the address, (4) the lowest-sort_order active store as fallback.
//
// By default, if the nearest store can't fulfill but a farther one can, we
// return `error: 'needs_fallback_confirmation'` with BOTH stores' info so
// the customer can be asked "willing to wait longer?". When the caller
// passes `acceptFallback: true`, we silently route to the fallback.
//
// Returns one of:
//   { store, reason, items: [{product_id, qty, available, ok}] }
//   { error: 'needs_fallback_confirmation', nearest, fallback }
//   { error: 'no_stock', store, shortages }
//   { error: 'no_active_store' }
async function routeOrder({ address, items, channel = 'wechat', acceptFallback = false, ignoreStock = false, ignoreOrderIds = null }) {
  // Drop stores closed for THIS channel's fulfillment — the channel's own cell, or
  // the whole shop — so their online orders reroute to the store that is still
  // open. If EVERY store is closed for the channel there's nowhere to
  // fulfill → no_active_store (checkout's channelFullyClosed guard blocks it first
  // with a clean message, but guard here too).
  const closedForChan = channelClosedStores(orderChannelKey(channel));
  const stores = listStores({ activeOnly: true }).filter(s => !closedForChan.has(s.code));
  if (!stores.length) return { error: 'no_active_store' };

  // Build candidate list in priority order. TRUE DISTANCE LEADS: once an
  // address is geocoded, the nearest store always wins — a seeded/legacy zone
  // pin must never override a physically closer store (that once shipped a
  // Haizhu order ~9 km to Tianhe when Yuexiu was ~1 km away).
  //   1. GPS distance — if the address AND at least one store have lat/lng,
  //      sort all stores by Haversine distance ascending. Authoritative: when
  //      GPS is available EVERY store lands in the list here, so steps 2-3 are
  //      no-ops and neither the zone pin nor district-name matching interferes.
  //   2. Zone preferred_store_id — ONLY consulted when we have no coordinates
  //      to measure by (un-geocoded address). A fallback hint, not an override.
  //   3. Home-district match — store.district === address.district.
  //   4. Sort_order fallback.
  const candidates = [];
  const addrDistrict = address?.district || null;
  const addrCity     = address?.city     || null;
  const addrLat      = typeof address?.lat === 'number' ? address.lat : null;
  const addrLng      = typeof address?.lng === 'number' ? address.lng : null;
  const hasAddrGps   = addrLat != null && addrLng != null;

  // 1. Real-proximity ranking (road distance, Haversine fallback). Stores
  // without coordinates go to the bottom (we can't measure them). Only
  // kicks in when the customer's address has been geocoded — but when it
  // has, this ranks ALL stores, so distance is the sole decider and the
  // zone/district steps below never run.
  if (hasAddrGps) {
    const ranked = await rankStoresByProximity(stores, addrLat, addrLng);
    for (const r of ranked) {
      if (!candidates.some(c => c.store.id === r.store.id)) {
        candidates.push({ store: r.store, reason: 'nearest', distance_km: r.distance_km });
      }
    }
  }

  // 2. Zone preferred store — FALLBACK ONLY, when the address isn't geocoded so
  // we have no distance to rank by. With coordinates present (step 1 filled the
  // list) this is skipped, so a legacy zone pin can't beat a closer store.
  if (!hasAddrGps && (addrDistrict || addrCity)) {
    const zone = tdb().prepare(
      `SELECT id, preferred_store_id
         FROM retail_delivery_zones
        WHERE is_active = 1
          AND (
            (zone_type = 'gz_district' AND match_district = ?) OR
            (zone_type = 'city'        AND match_city     = ?)
          )
        ORDER BY zone_type DESC LIMIT 1`
    ).get(addrDistrict, addrCity);
    if (zone?.preferred_store_id) {
      const s = stores.find(x => x.id === zone.preferred_store_id);
      if (s) candidates.push({ store: s, reason: 'nearest' });
    }
  }

  // 3. Store whose home district == address district.
  for (const s of stores) {
    if (s.district && s.district === addrDistrict && !candidates.some(c => c.store.id === s.id)) {
      candidates.push({ store: s, reason: 'nearest' });
    }
  }

  // 4. Everything else, by sort_order.
  for (const s of stores) {
    if (!candidates.some(c => c.store.id === s.id)) {
      candidates.push({ store: s, reason: candidates.length === 0 ? 'only_store' : 'fallback_no_stock' });
    }
  }

  // Score every candidate so we can return rich info about nearest +
  // fallback to the caller (used by /checkout/quote so the mini-app can
  // pre-warn the customer).
  const scored = candidates.map((c, i) => {
    const itemResults = items.map(it => {
      const av = getAvailable(c.store.id, it.product_id, channel, ignoreOrderIds);
      return {
        product_id: it.product_id,
        qty: it.qty,
        available: av.available,
        ok: av.exists && av.available >= it.qty,
        exists: av.exists,
      };
    });
    return {
      store: c.store,
      proposedReason: i === 0 ? c.reason : 'fallback_no_stock',
      items: itemResults,
      ok: itemResults.every(r => r.ok),
      shortages: itemResults.filter(r => !r.ok),
      distance_km: c.distance_km ?? null,
    };
  });

  // Was this order routed by REAL distance, or by a coarse fallback because the
  // address had no coordinates? true only when GPS ranking ran AND produced a
  // measurable distance for the chosen (first) candidate. Surfaced to ops so a
  // fallback-routed order can be eyeballed. Independent of stock outcome.
  const routedByDistance = hasAddrGps && scored[0]?.distance_km != null;

  const nearest    = scored[0] || null;
  const fallbackOk = scored.slice(1).find(c => c.ok) || null;

  // ignoreStock = true: caller doesn't care about live shortages (e.g.
  // out-of-Guangzhou order, or scheduled-for-later inside GZ). We still
  // pick the best store so the order has somewhere to ship from, but we
  // never raise no_stock / needs_fallback_confirmation. The kitchen
  // restocks before the scheduled fulfilment date.
  if (ignoreStock) {
    if (!nearest) return { error: 'no_active_store' };
    return { store: nearest.store, reason: nearest.proposedReason, items: nearest.items, routed_by_distance: routedByDistance };
  }

  // Single store and it's out → nothing we can do.
  if (stores.length === 1) {
    if (nearest?.ok) return { store: nearest.store, reason: 'only_store', items: nearest.items, routed_by_distance: routedByDistance };
    return {
      error: 'no_stock',
      store: nearest?.store || null,
      shortages: nearest?.shortages || [],
    };
  }

  // Nearest can fulfill — done, no question to ask.
  if (nearest?.ok) {
    return { store: nearest.store, reason: nearest.proposedReason, items: nearest.items, routed_by_distance: routedByDistance };
  }

  // Nearest can't, but a fallback can. Ask the customer unless they've
  // already accepted up-front (acceptFallback === true).
  if (fallbackOk) {
    if (acceptFallback) {
      // Diagnostics: name the items the NEARER store was short on, so the
      // rerouted order can explain itself ("改派(缺货)" → which SKUs) instead of
      // leaving ops guessing. The fulfilling (fallback) store covers everything.
      return {
        store: fallbackOk.store, reason: 'fallback_no_stock', items: fallbackOk.items,
        routed_by_distance: routedByDistance,
        nearest_store: nearest?.store || null,
        nearest_short_pids: (nearest?.shortages || []).map(s => s.product_id),
      };
    }
    return {
      error: 'needs_fallback_confirmation',
      nearest:  { store: nearest.store,  shortages: nearest.shortages,  items: nearest.items },
      fallback: { store: fallbackOk.store, items: fallbackOk.items },
    };
  }

  // Nothing can fulfill.
  return {
    error: 'no_stock',
    store: nearest?.store || null,
    shortages: nearest?.shortages || [],
  };
}

// Atomically reserve N items for an order. items: [{product_id, qty}].
// Returns { reservations: [...] } on success, or throws on shortage so
// the caller can rollback its outer transaction.
//
// `allowPartial` flips that all-or-nothing rule: every line is judged on its
// own, short ones are skipped and reported in `shortages`, and the rest still
// reserve. Only for callers that CANNOT refuse the sale — the paid add-on path,
// where throwing used to roll back the whole batch and leave the available
// lines silently undeducted alongside the short one. Checkout keeps the throw:
// it can still refuse, and a partial reserve there would oversell.
function reserveForOrder({ storeId, orderId, items, channel = 'wechat', ignoreOrderIds = null, allowPartial = false }) {
  const ttl = ttlMinutes();
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const insRes = tdb().prepare(`
    INSERT INTO retail_stock_reservations
      (store_id, product_id, order_id, qty, channel, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `);

  const out = [];
  const shortages = [];
  const tx = tdb().transaction(() => {
    for (const it of items) {
      // Ignore the same customer's own unpaid holds when gating the reserve —
      // matches routeOrder so the new order can take the stock its own abandoned
      // pending order was sitting on, rather than falsely failing / rerouting.
      const av = getAvailable(storeId, it.product_id, channel, ignoreOrderIds);
      if (!av.exists) {
        if (allowPartial) {
          shortages.push({ product_id: it.product_id, qty: it.qty, available: 0, reason: 'product_not_stocked_here' });
          continue;
        }
        const err = new Error('product_not_stocked_here');
        err.code = 'product_not_stocked_here';
        err.product_id = it.product_id;
        throw err;
      }
      if (av.available < it.qty) {
        if (allowPartial) {
          // Reserve what IS there so the shelf still moves for the units we can
          // cover; the remainder is the operator's short to reconcile.
          if (av.available > 0) {
            const partial = insRes.run(storeId, it.product_id, orderId, av.available, channel, expiresAt);
            out.push({ id: partial.lastInsertRowid, product_id: it.product_id, qty: av.available });
          }
          shortages.push({ product_id: it.product_id, qty: it.qty, available: av.available, reason: 'insufficient_stock' });
          continue;
        }
        const err = new Error('insufficient_stock');
        err.code = 'insufficient_stock';
        err.product_id = it.product_id;
        err.available = av.available;
        throw err;
      }
      const info = insRes.run(storeId, it.product_id, orderId, it.qty, channel, expiresAt);
      out.push({ id: info.lastInsertRowid, ...it });
    }
  });
  tx();
  return { reservations: out, shortages, expires_at: expiresAt };
}

// Commit all active reservations for an order: mark committed, decrement
// physical_qty, write ledger entries. Idempotent — re-running on an
// already-committed order is a no-op.
function commitOrderReservations(orderId, { actorUserId = null, actorLabel = null } = {}) {
  const tx = tdb().transaction(() => {
    const reservations = tdb().prepare(`
      SELECT id, store_id, product_id, qty, channel
        FROM retail_stock_reservations
       WHERE order_id = ? AND status = 'active'
    `).all(orderId);
    if (!reservations.length) return { committed: 0 };

    const decr   = tdb().prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
    const mark   = tdb().prepare("UPDATE retail_stock_reservations SET status = 'committed', committed_at = CURRENT_TIMESTAMP WHERE id = ?");
    const getBal = tdb().prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
    const insLed = tdb().prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, channel)
      VALUES (?, ?, ?, 'order_commit', 'retail_orders', ?, ?, ?, ?, ?)
    `);

    for (const r of reservations) {
      decr.run(r.qty, r.store_id, r.product_id);
      const bal = getBal.get(r.store_id, r.product_id)?.physical_qty ?? 0;
      insLed.run(r.store_id, r.product_id, -r.qty, orderId, bal, actorUserId, actorLabel, r.channel);
      mark.run(r.id);
      enqueueChannelSync(r.store_id, r.product_id);
    }
    return { committed: reservations.length };
  });
  const result = tx();
  if (result.committed > 0) _bumpStockLive();
  return result;
}

// Decrement stock for an order that NEVER reserved at checkout. Out-of-Guangzhou
// and scheduled-for-later orders skip the reserve→commit flow (stockGate off, see
// the create-order path), so their physical_qty is never deducted and they never
// appear in the inventory ledger. To keep stock honest, the caller invokes this
// when staff start working the order (first forward transition into
// preparing/dispatched/delivered), passing the already-expanded component lines
// (bundles + add-ons resolved). Idempotent: skips any order that already reserved
// (GZ same-day) or that we've already prepare-committed, so it never double-counts.
// `lines` = [{ product_id, qty }] (positive qty), `note` = order_no for traceability.
function commitUnreservedOrder(orderId, lines, { actorUserId = null, actorLabel = null, note = null } = {}) {
  const o = tdb().prepare('SELECT id, store_id FROM retail_orders WHERE id = ?').get(orderId);
  if (!o || !o.store_id) return { skipped: 'no_store' };
  // Already accounted? A reservation row means the GZ same-day reserve→commit
  // path owns this order's stock; an order_* ledger row means we (or commit)
  // already decremented. Either way, do nothing.
  if (tdb().prepare('SELECT 1 FROM retail_stock_reservations WHERE order_id = ? LIMIT 1').get(orderId)) {
    return { skipped: 'reserved' };
  }
  if (tdb().prepare("SELECT 1 FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason LIKE 'order%' LIMIT 1").get(orderId)) {
    return { skipped: 'already_committed' };
  }
  const valid = (lines || []).filter(l => l && l.product_id && l.qty > 0);
  if (!valid.length) return { skipped: 'no_lines' };

  const decr   = tdb().prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
  const getBal = tdb().prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
  const insLed = tdb().prepare(`
    INSERT INTO retail_stock_ledger
      (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, channel, note)
    VALUES (?, ?, ?, 'order_prepare', 'retail_orders', ?, ?, ?, ?, 'wechat', ?)
  `);
  const tx = tdb().transaction(() => {
    for (const l of valid) {
      decr.run(l.qty, o.store_id, l.product_id);
      const bal = getBal.get(o.store_id, l.product_id)?.physical_qty ?? 0;
      insLed.run(o.store_id, l.product_id, -l.qty, orderId, bal, actorUserId, actorLabel, note);
      enqueueChannelSync(o.store_id, l.product_id);
    }
    return { committed: valid.length };
  });
  const result = tx();
  if (result.committed > 0) _bumpStockLive();
  return result;
}

// True only when an order's real stock hasn't been decremented yet: it's a
// 'paid' order on our OWN checkout channel (wechat mini-app / web storefront —
// the only channels that run the reserve→commit / commitUnreservedOrder
// pipeline) with no reservation row (active or committed) and no order_*
// ledger entry — i.e. an out-of-Guangzhou / skip-reserve order sitting between
// payment and its first preparing/dispatched/delivered transition. Mirrors the
// exact guard commitUnreservedOrder uses to no-op. Mirrored channel orders
// (meituan/eleme/gzgrocery) decrement stock immediately via adjustStock on
// their own ledger shape (ref_table='retail_store_stock') and must never be
// flagged here — they'd always look "pending" otherwise.
function isStockPending(orderId, status, channel) {
  if (status !== 'paid') return false;
  const ch = channel || 'wechat';
  if (ch !== 'wechat' && ch !== 'web') return false;
  if (tdb().prepare('SELECT 1 FROM retail_stock_reservations WHERE order_id = ? LIMIT 1').get(orderId)) return false;
  if (tdb().prepare("SELECT 1 FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason LIKE 'order%' LIMIT 1").get(orderId)) return false;
  return true;
}

// Release all active reservations for an order (customer cancel, expiry,
// admin reject). Stock returns to the available pool without touching
// physical_qty. Idempotent.
function releaseOrderReservations(orderId, { reason = 'released', actorUserId = null } = {}) {
  const tx = tdb().transaction(() => {
    const reservations = tdb().prepare(`
      SELECT id FROM retail_stock_reservations WHERE order_id = ? AND status = 'active'
    `).all(orderId);
    if (!reservations.length) return { released: 0 };

    const status = reason === 'expired' ? 'expired' : 'released';
    const mark = tdb().prepare(
      `UPDATE retail_stock_reservations SET status = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?`
    );
    for (const r of reservations) mark.run(status, r.id);
    return { released: reservations.length };
  });
  return tx();
}

// Reverse a committed order (refund / cancel-after-paid). Adds the qty
// back to physical_qty and writes a positive ledger entry. Does NOT
// re-activate the reservation rows — they stay 'committed' for audit.
function reverseCommittedOrder(orderId, { actorUserId = null, actorLabel = null, note = null } = {}) {
  const tx = tdb().transaction(() => {
    const reservations = tdb().prepare(`
      SELECT id, store_id, product_id, qty, channel
        FROM retail_stock_reservations
       WHERE order_id = ? AND status = 'committed'
    `).all(orderId);
    if (!reservations.length) return { reversed: 0 };

    // Don't reverse twice — check ledger for an existing reverse entry.
    const already = tdb().prepare(`
      SELECT 1 FROM retail_stock_ledger
       WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_reverse'
       LIMIT 1
    `).get(orderId);
    if (already) return { reversed: 0, idempotent: true };

    const inc    = tdb().prepare('UPDATE retail_store_stock SET physical_qty = physical_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
    const getBal = tdb().prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
    const insLed = tdb().prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, channel, note)
      VALUES (?, ?, ?, 'order_reverse', 'retail_orders', ?, ?, ?, ?, ?, ?)
    `);

    for (const r of reservations) {
      inc.run(r.qty, r.store_id, r.product_id);
      const bal = getBal.get(r.store_id, r.product_id)?.physical_qty ?? 0;
      insLed.run(r.store_id, r.product_id, +r.qty, orderId, bal, actorUserId, actorLabel, r.channel, note);
      enqueueChannelSync(r.store_id, r.product_id);
    }
    return { reversed: reservations.length };
  });
  const result = tx();
  if (result.reversed > 0) _bumpStockLive();
  return result;
}

// Partial reversal — for line-itemized refunds. Returns qty for selected
// product_ids only (up to qty refunded, capped at what was committed).
// Idempotency uses a distinct reason ('order_reverse_partial') so a later
// full-reverse can still run. Pass lines as [{ product_id, qty }].
function reverseCommittedLines(orderId, lines, { actorUserId = null, actorLabel = null, note = null } = {}) {
  if (!Array.isArray(lines) || !lines.length) return { reversed: 0 };
  const tx = tdb().transaction(() => {
    const byProduct = new Map();
    for (const l of lines) {
      const pid = parseInt(l.product_id, 10);
      const q = +l.qty;
      if (!pid || !(q > 0)) continue;
      byProduct.set(pid, (byProduct.get(pid) || 0) + q);
    }
    if (!byProduct.size) return { reversed: 0 };

    const reservations = tdb().prepare(`
      SELECT id, store_id, product_id, qty, channel
        FROM retail_stock_reservations
       WHERE order_id = ? AND status = 'committed'
    `).all(orderId);
    if (!reservations.length) return { reversed: 0 };

    const inc    = tdb().prepare('UPDATE retail_store_stock SET physical_qty = physical_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
    const getBal = tdb().prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
    const insLed = tdb().prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, channel, note)
      VALUES (?, ?, ?, 'order_reverse_partial', 'retail_orders', ?, ?, ?, ?, ?, ?)
    `);

    let totalReversed = 0;
    for (const r of reservations) {
      const want = byProduct.get(r.product_id);
      if (!want) continue;
      const take = Math.min(r.qty, want);
      if (!(take > 0)) continue;
      inc.run(take, r.store_id, r.product_id);
      const bal = getBal.get(r.store_id, r.product_id)?.physical_qty ?? 0;
      insLed.run(r.store_id, r.product_id, +take, orderId, bal, actorUserId, actorLabel, r.channel, note);
      enqueueChannelSync(r.store_id, r.product_id);
      byProduct.set(r.product_id, want - take);
      totalReversed += take;
    }
    return { reversed: totalReversed };
  });
  const result = tx();
  if (result.reversed > 0) _bumpStockLive();
  return result;
}

// Admin stock adjustment — sets physical_qty to an explicit value and
// records the delta in the ledger. Pass EITHER `newPhysicalQty` (set the
// absolute count, e.g. warehouse recount) OR `deltaQty` (add/subtract relative
// to whatever is on the shelf right now, e.g. kitchen "I made 5 more"). With
// `deltaQty` the target is computed INSIDE the transaction from the current
// row, so the caller never has to read-then-write — no lost-update race, and
// the kitchen client never has to know the current count.
// Live nudge for the `stock` entity (reference/live-updates-spec.md §5). The
// admin stream's 5s watermark only samples orders/customers/gzgrocery, so a
// Quick Stock recount on a phone left an open Products tab on the desk showing
// the page-load count — "Out" long after the shelf was refilled.
//
// Coalesced per tenant: one paid order adjusts every line, and twenty frames
// for one event helps nobody. Best-effort and lazily required — the nudge is a
// convenience, never part of the write's contract, and requiring routes/retail
// at module load would close a require cycle. In the Meituan/gzgrocery daemon
// processes there is no live hub at all; the require throws and we move on.
const _stockBumpTimers = new Map();
function _bumpStockLive() {
  let tenantId;
  try { tenantId = currentTenantId(); } catch (e) { return; }
  if (!tenantId || _stockBumpTimers.has(tenantId)) return;
  const t = setTimeout(() => {
    _stockBumpTimers.delete(tenantId);
    try { require('../routes/retail').retailLiveBump(tenantId, 'stock', { action: 'update' }); }
    catch (e) { /* no live hub in this process */ }
  }, 1200);
  t.unref?.();
  _stockBumpTimers.set(tenantId, t);
}

function adjustStock({ storeId, productId, newPhysicalQty, deltaQty = null, actorUserId = null, actorLabel = null, note = null, reason = 'adjust' }) {
  const tx = tdb().transaction(() => {
    const existing = tdb().prepare(
      'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
    ).get(storeId, productId);
    const oldQty = existing?.physical_qty ?? 0;
    if (deltaQty != null) newPhysicalQty = Math.max(0, oldQty + deltaQty);
    const delta  = newPhysicalQty - oldQty;
    if (existing) {
      tdb().prepare(
        'UPDATE retail_store_stock SET physical_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?'
      ).run(newPhysicalQty, storeId, productId);
    } else {
      tdb().prepare(
        'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, ?)'
      ).run(storeId, productId, newPhysicalQty);
    }
    tdb().prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, note)
      VALUES (?, ?, ?, ?, 'retail_store_stock', NULL, ?, ?, ?, ?)
    `).run(storeId, productId, delta, reason, newPhysicalQty, actorUserId, actorLabel, note);
    enqueueChannelSync(storeId, productId);
    return { oldQty, newQty: newPhysicalQty, delta };
  });
  const result = tx();
  if (result.delta !== 0) _bumpStockLive();
  // If stock went UP, check whether any awaiting_restock orders at this
  // store are now fulfillable. Returns a list of order_ids that got
  // promoted; we hand them to the caller so it can notify customers.
  let promotedOrderIds = [];
  if (result.delta > 0) {
    try { promotedOrderIds = checkAwaitingRestockForRestock({ storeId, productId }); }
    catch (e) { console.error('[adjustStock awaiting check]', e); }
    // Fire post-payment side effects for promoted orders (e.g. the referral
    // credit, which markOrderPaid skipped while the order sat in
    // awaiting_restock). Best-effort, outside the stock transaction.
    if (promotedOrderIds.length && _onOrdersPromoted) {
      try { _onOrdersPromoted(promotedOrderIds); }
      catch (e) { console.error('[adjustStock onOrdersPromoted]', e); }
    }
  }
  return { ...result, promotedOrderIds };
}

function upsertStockLayer({ storeId, productId, fields, actorUserId = null }) {
  const allowed = ['safety_buffer', 'wechat_quota', 'meituan_quota', 'restock_target'];
  const existing = tdb().prepare(
    'SELECT id FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  ).get(storeId, productId);
  if (!existing) {
    tdb().prepare(
      'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, 0)'
    ).run(storeId, productId);
  }
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return { changed: 0 };
  vals.push(storeId, productId);
  tdb().prepare(
    `UPDATE retail_store_stock SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?`
  ).run(...vals);
  return { changed: 1 };
}

// Reservation expiry sweeper. Run on a timer; idempotent. Returns the
// number of expired reservations + auto-cancelled orders. Auto-cancels
// any pending_payment order whose reservations have all expired.
function sweepExpiredReservations() {
  const tx = tdb().transaction(() => {
    const expired = tdb().prepare(`
      SELECT id, order_id FROM retail_stock_reservations
       WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP
    `).all();
    if (!expired.length) return { expired: 0, cancelledOrders: 0 };

    const markExpired = tdb().prepare(
      "UPDATE retail_stock_reservations SET status = 'expired', released_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    for (const r of expired) markExpired.run(r.id);

    // Auto-cancel orders whose reservations are all gone (and which are
    // still pending_payment). One UPDATE per distinct order_id is fine.
    const orderIds = [...new Set(expired.map(r => r.order_id).filter(Boolean))];
    let cancelled = 0;
    for (const oid of orderIds) {
      const r = tdb().prepare(`
        UPDATE retail_orders
           SET status = 'cancelled',
               cancelled_at = CURRENT_TIMESTAMP,
               cancelled_reason = 'reservation_expired',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending_payment'
      `).run(oid);
      if (r.changes > 0) {
        tdb().prepare("UPDATE retail_payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'").run(oid);
        cancelled++;
      }
    }
    return { expired: expired.length, cancelledOrders: cancelled };
  });
  return tx();
}

// Active non-Roots tenant ids from the control-plane `tenants` table (which
// lives on the main/Roots db). Empty on any error so the sweeper still runs
// for Roots.
function activeNonRootsTenantIds() {
  try {
    const main = getTenantDb(ROOTS_TENANT_ID);
    return main.prepare("SELECT id FROM tenants WHERE status = 'active' AND id != ?")
      .all(ROOTS_TENANT_ID)
      .map(r => Number(r.id))
      .filter(Boolean);
  } catch (e) {
    console.error('[inventory.sweeper] tenant list failed', e.message);
    return [];
  }
}

function startReservationSweeper({ intervalMs = 60_000 } = {}) {
  const sweepScope = (label) => {
    try {
      const r = sweepExpiredReservations();
      if (r.expired > 0) {
        console.log(`[inventory.sweeper] ${label} expired=${r.expired} cancelled_orders=${r.cancelledOrders}`);
      }
    } catch (e) {
      console.error(`[inventory.sweeper] ${label} error`, e);
    }
  };
  const tick = () => {
    // Default/Roots scope — tdb() resolves to the main db when there's no ALS
    // scope (which is the case inside a bare timer callback).
    sweepScope('roots');
    // Every OTHER active tenant has its own db file once data-isolation is on;
    // the unscoped boot timer can't reach those, so run the sweep inside each
    // tenant's ALS scope. Before cut-over (flag off) there's only Roots, so this
    // is a no-op and behaviour is unchanged.
    if (DATA_ISOLATION_READY) {
      for (const id of activeNonRootsTenantIds()) {
        tenantAls.run(getTenantDb(id), () => sweepScope('tenant ' + id));
      }
    }
  };
  // First tick at boot, then on interval.
  setTimeout(tick, 5_000);
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

// Read the editable GZ-express excluded districts from storefront_config.
// Returns a Set for O(1) lookup. Defaults to ['番禺区','花都区'] until the
// admin edits it.
function gzExpressExcludedDistricts() {
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'routing.gz_express_excluded_districts'").get();
    if (row) {
      const arr = JSON.parse(row.value_json);
      if (Array.isArray(arr)) return new Set(arr.filter(Boolean).map(s => String(s).trim()));
    }
  } catch {}
  return new Set(['番禺区', '花都区']);
}

// Eligibility for the 5-option fallback flow:
//   1. Address city = 广州 / 广州市
//   2. District NOT in gz_express_excluded_districts
//   3. Delivery slot = 'right_away'
// Returns true/false. The mini-app gets this verdict via /checkout/quote
// so it knows whether to show the 5-button modal or the legacy yes/no one.
function isExpressGzEligible({ address, deliverySlotId }) {
  if (!address) return false;
  if (deliverySlotId !== 'right_away') return false;
  const city = String(address.city || '').replace(/市$/, '').trim();
  if (city !== '广州') return false;
  const district = String(address.district || '').trim();
  if (!district) return false;
  const excluded = gzExpressExcludedDistricts();
  if (excluded.has(district)) return false;
  return true;
}

// Does the customer-facing address live inside Guangzhou? The structured
// address.city field is checked first; we also scan the free-text address
// blob since WeChat-imported addresses often dump everything there. Mirrors
// the matcher used by /quote so the answer is consistent.
function isGuangzhouAddress(address) {
  if (!address) return false;
  const city = String(address.city || '').replace(/市$/, '').trim().toLowerCase();
  if (city === '广州' || city === 'guangzhou') return true;
  const blob = [address.address, address.detail, address.city, address.district]
                 .filter(Boolean).join(' ');
  return /广州/.test(blob) || /guangzhou/i.test(blob);
}

// True when the picked delivery slot would ship today. 'right_away' is
// always same-day. Date-based slot ids ('YYYY-MM-DD…' from the picker)
// are same-day only when their date part matches today.
function isSameDayDelivery(deliverySlotId, now = new Date()) {
  if (!deliverySlotId) return false;
  if (deliverySlotId === 'right_away') return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(deliverySlotId));
  if (!m) return false;
  const y  = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return m[1] === y && m[2] === mm && m[3] === dd;
}

// Out-of-stock logic only applies when the order needs to ship TODAY from
// a Guangzhou store. For any other case — GZ but scheduled later, or any
// non-GZ address — the kitchen has time to restock before fulfilment, so
// shortages are not a blocker and we skip both the customer warning AND
// the stock-reservation step. This is the rule the office asked for in
// 2026-05-19: "out-of-stock notification is only for orders that require
// same-day delivery; outside Guangzhou it's never relevant."
function requiresStockGate({ address, deliverySlotId }) {
  return isGuangzhouAddress(address) && isSameDayDelivery(deliverySlotId);
}

// True when the address falls in a Guangzhou "ship-district" — an outer
// district (花都/番禺/南沙/从化/增城) where same-day is an OPT-IN extra rather
// than the default. These zones are gz_district rows flagged day_only=1 or
// carrying a same-day surcharge ("Panyu-style"); the same distinction
// annotateShipBy uses. Unless the customer explicitly buys the same-day slot,
// orders here ship by courier on the batch cadence like out-of-GZ orders, so
// routing should pin them to the out-of-city store rather than the nearest
// shop. Inner GZ districts (day_only=0 AND no surcharge) return false — they
// stay always-nearest same-day local delivery.
function isOptInSameDayDistrict(address) {
  const district = address?.district || null;
  const city     = address?.city     || null;
  if (!district && !city) return false;
  const zone = tdb().prepare(
    `SELECT zone_type, day_only, same_day_surcharge
       FROM retail_delivery_zones
      WHERE is_active = 1
        AND (
          (zone_type = 'gz_district' AND match_district = ?) OR
          (zone_type = 'city'        AND match_city     = ?)
        )
      ORDER BY zone_type DESC LIMIT 1`
  ).get(district, city);
  if (!zone || zone.zone_type !== 'gz_district') return false;
  return Number(zone.day_only) === 1 || Number(zone.same_day_surcharge) > 0;
}

// The Guangzhou (UTC+8) calendar date of a stored timestamp, "YYYY-MM-DD".
// Host-TZ independent (explicit +8h). Accepts a bare 'YYYY-MM-DD' (a day-only
// pick), a ' '-separated SQL datetime, or a full ISO string. '' when unparseable.
function _gzDateStr(ts) {
  if (!ts) return '';
  const s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;              // already a bare GZ date
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

// Channels we auto-dispatch to a same-city rider ourselves. Marketplace orders
// (meituan/eleme) carry their OWN delivery and no recipient name/phone/address
// in our DB, and gzgrocery is wholesale pickup — none may reach Qingyun 待配送.
// Only our first-party storefronts: the WeChat mini app ('wechat', the default)
// and the web storefront ('web').
const QINGYUN_PUSH_CHANNELS = ['wechat', 'web'];

// Does a paid DELIVERY order belong in the same-city courier aggregator's
// 待配送 list (Qingyun)? Qingyun is a Guangzhou SAME-CITY, SAME-DAY rider
// service, so we auto-push ONLY an order that:
//   1. comes from a first-party channel we deliver ourselves (mini app / web),
//      NOT a marketplace (Meituan/Eleme) that runs its own courier, AND
//   2. delivers to a Guangzhou address (never out-of-city — those ride our
//      air/land logistics with a real waybill), AND
//   3. is routed as a same-city 'local' drop, NOT an outer ship-district
//      (花都/番禺/南沙/从化/增城) on its batch cadence — mirrors planShipments:
//      a ship-district only goes same-city when the customer bought the
//      'today' slot, otherwise it ships by courier like any Guangdong order, AND
//   4. actually ships TODAY. 'right_away'/'today' are same-day by definition;
//      a scheduled/express pick is same-day only when its promised day is the
//      Guangzhou date `now` falls on — a future day is regular next-day
//      delivery and must wait for its own dispatch day, not flood 待配送 now.
// `order` needs { channel, address_json, delivery_slot_kind, scheduled_for }.
function isQingyunSameCityToday(order, now = new Date()) {
  if (!order) return false;
  // A NULL channel is a legacy mini-app order (column default was 'wechat').
  const channel = order.channel == null ? 'wechat' : String(order.channel);
  if (!QINGYUN_PUSH_CHANNELS.includes(channel)) return false;
  let addr = null;
  try {
    addr = typeof order.address_json === 'string'
      ? JSON.parse(order.address_json || 'null')
      : (order.address_json || null);
  } catch { addr = null; }
  if (!addr || !isGuangzhouAddress(addr)) return false;

  const kind = order.delivery_slot_kind || null;

  // Outer-GZ ship-district: same-city rider only when 'today' was purchased.
  if (isOptInSameDayDistrict(addr) && kind !== 'today') return false;

  if (kind === 'right_away' || kind === 'today') return true;
  const sched = _gzDateStr(order.scheduled_for);
  // An Express pick with NO date is "as soon as possible" — the same promise as
  // right_away, and it's treated as ASAP everywhere else (see the send-by/ship-by
  // grouping in routes/retail.js: express | right_away | restock | no-date).
  // This rule used to assume Express always carried a date, because markOrderPaid
  // re-anchors one on payment — but that re-anchor only fires for an "Earliest
  // <date>" label, so an Express order labelled "Right away" (and any order marked
  // paid by hand, which skips markOrderPaid entirely) kept an empty scheduled_for
  // and was rejected forever. TC000101 was a paid, same-city, 天河区 "Right away"
  // order that never reached Qingyun for exactly this reason.
  if (kind === 'express' && sched === '') return true;
  // Scheduled / legacy: compare the promised Guangzhou day to today. A future day
  // is regular next-day delivery and must wait for its own dispatch day. Still no
  // date and not Express → not a datable same-day order.
  return sched !== '' && sched === _gzDateStr(now.toISOString());
}

// Guangzhou district centroids — used as a fallback when a customer
// address hasn't been geocoded yet (Tencent Maps key absent, or the
// background geocode hasn't run). Granularity is ~5 km, which is plenty
// to differentiate stores ~10 km apart for the routing/extra-km message.
// Add new districts here as the kitchen footprint expands.
const GZ_DISTRICT_CENTROIDS = {
  '天河区':   { lat: 23.1339, lng: 113.3603 },
  '越秀区':   { lat: 23.1289, lng: 113.2664 },
  '荔湾区':   { lat: 23.1259, lng: 113.2444 },
  '海珠区':   { lat: 23.0838, lng: 113.3175 },
  '番禺区':   { lat: 22.9379, lng: 113.3845 },
  '白云区':   { lat: 23.1577, lng: 113.2729 },
  '黄埔区':   { lat: 23.1801, lng: 113.4593 },
  '增城区':   { lat: 23.2914, lng: 113.8254 },
  '从化区':   { lat: 23.5453, lng: 113.5862 },
  '花都区':   { lat: 23.4035, lng: 113.2206 },
  '南沙区':   { lat: 22.8016, lng: 113.5333 },
};
function districtCentroid(district) {
  return district ? (GZ_DISTRICT_CENTROIDS[district] || null) : null;
}

// Sum total Haversine distance from a store to the customer. Cheap.
// Falls back to GZ district centroids when the address hasn't been
// geocoded yet, so routing can still surface "+N km / ~M min" deltas.
function storeDistanceKm(store, address) {
  if (!store || !address) return null;
  if (typeof store.lat !== 'number' || typeof store.lng !== 'number') return null;
  let aLat = address.lat, aLng = address.lng;
  if (typeof aLat !== 'number' || typeof aLng !== 'number') {
    const c = districtCentroid(address.district);
    if (!c) return null;
    aLat = c.lat; aLng = c.lng;
  }
  return haversineKm({ lat: store.lat, lng: store.lng }, { lat: aLat, lng: aLng });
}

// Rich shortage analysis for the 5-option fallback flow.
// Inputs: { address (has lat/lng + city/district), items, deliverySlotId, channel }
// Output describes BOTH "what the nearest store can do" and "what the
// fallback store could do", plus all the data the mini-app needs to render
// the right modal:
//   {
//     gate: 'options_5' | 'simple_confirm' | 'none',
//     nearest: { store, items, ok, shortages[], distance_km },
//     fallback: { store, items, ok, distance_km, extra_km, extra_min_estimate } | null,
//     missing_items: [{ product_id, qty, available, name_en, name_cn }],
//   }
// Falls back gracefully when GPS coords aren't available — the flow still
// works using district matching, just without "extra km" numbers.
async function analyzeShortage({ address, items, deliverySlotId, channel = 'wechat', ignoreOrderIds = null }) {
  // Same candidate pool as routeOrder, closures and all. A closed store cannot be
  // "the nearest store" here either: naming it in the modal asked the customer to
  // wait for / substitute around a shop that isn't opening, and the wait_for_restock
  // branch of POST /api/retail/orders pins the order to a.nearest.store — which
  // would have parked it at the closed shop until someone noticed.
  const closedForChan = channelClosedStores(orderChannelKey(channel));
  const stores = listStores({ activeOnly: true }).filter(s => !closedForChan.has(s.code));
  if (!stores.length) return { gate: 'none', error: 'no_active_store' };

  // Stock check only applies to GZ + same-day deliveries. For non-GZ or
  // future-dated GZ orders the kitchen restocks before fulfilment, so we
  // skip both the warning AND the routing scoring — just pick a store
  // (ignoreStock) and return gate='none' with no missing items.
  if (!requiresStockGate({ address, deliverySlotId })) {
    const relaxed = await routeOrder({ address, items, channel, acceptFallback: true, ignoreStock: true, ignoreOrderIds });
    return {
      gate: 'none',
      resolved: relaxed,
      nearest: null,
      fallback: null,
      missing_items: [],
      stock_gate_off: true,   // for diagnostics / future telemetry
    };
  }

  const route = await routeOrder({ address, items, channel, acceptFallback: true, ignoreOrderIds });
  // routeOrder with acceptFallback:true returns the *resolved* store (nearest
  // if OK, fallback otherwise). To get a richer picture we score both.
  // Build candidate list the same way routeOrder does.
  const addrLat = typeof address?.lat === 'number' ? address.lat : null;
  const addrLng = typeof address?.lng === 'number' ? address.lng : null;
  const hasGps = addrLat != null && addrLng != null;

  // Order all stores by preference (same tiers as routeOrder), then score.
  // TRUE DISTANCE LEADS: road-distance-ranked first so the "nearest" label
  // reflects the physically closest store, not a legacy zone pin. Zone
  // preferred_store is only a fallback when the address has no coordinates
  // to measure by.
  const order = [];
  const seen = new Set();
  const push = (s) => { if (s && !seen.has(s.id)) { order.push(s); seen.add(s.id); } };
  // Tier 1: proximity-ranked (authoritative — pushes ALL stores when coords exist)
  if (hasGps) {
    const ranked = await rankStoresByProximity(stores, addrLat, addrLng);
    for (const r of ranked) push(r.store);
  }
  // Tier 2: zone preferred_store — FALLBACK ONLY, when no coordinates to rank by
  if (!hasGps) {
    const zone = tdb().prepare(
      `SELECT preferred_store_id FROM retail_delivery_zones
        WHERE is_active = 1 AND (
          (zone_type = 'gz_district' AND match_district = ?) OR
          (zone_type = 'city'        AND match_city     = ?)
        ) ORDER BY zone_type DESC LIMIT 1`
    ).get(address?.district || null, address?.city || null);
    if (zone?.preferred_store_id) push(stores.find(s => s.id === zone.preferred_store_id));
  }
  // Tier 3: home-district match
  for (const s of stores) if (s.district === address?.district) push(s);
  // Tier 4: everything else
  for (const s of stores) push(s);

  const scored = order.map(store => {
    const itemResults = items.map(it => {
      const av = getAvailable(store.id, it.product_id, channel, ignoreOrderIds);
      return { product_id: it.product_id, qty: it.qty, available: av.available, ok: av.exists && av.available >= it.qty, exists: av.exists };
    });
    return {
      store,
      items: itemResults,
      ok: itemResults.every(r => r.ok),
      shortages: itemResults.filter(r => !r.ok),
      distance_km: storeDistanceKm(store, address),
    };
  });

  const nearest    = scored[0] || null;
  const fallbackOk = scored.slice(1).find(c => c.ok) || null;

  // Decide which flow the customer sees.
  //
  // Per docs/shipping-rules.md → "Out-of-Stock flow → GZ main + exceptions",
  // every GZ order whose nearest store is short MUST see the multi-option
  // flow (ship from other store / replace / cancel item / cancel order +
  // wait for restock when both are out). The previous restriction to
  // `right_away` orders left scheduled-day GZ customers stuck on the
  // legacy yes/no "Longer delivery" modal — exactly the case the user
  // reported on 2026-05-20.
  //
  // requiresStockGate (checked above) already guarantees we're only here
  // for GZ + same-day orders, so any non-OK nearest unconditionally maps
  // to the 5-option flow. `simple_confirm` is kept as a dead fallback so
  // any future code path that flips back to it still has a defined gate.
  let gate = 'none';
  if (nearest && !nearest.ok) gate = 'options_5';

  // Hydrate missing-item product info (name) so the modal can show
  // "out of stock: 81% Hazel Chocolate Spread" instead of bare ids.
  const missing_items = nearest && !nearest.ok
    ? nearest.shortages.map(s => {
        const p = tdb().prepare('SELECT id AS product_id, name_en, name_cn, sku, sell_price, image_data FROM store_products WHERE id = ?').get(s.product_id);
        return { ...s, ...(p || {}) };
      })
    : [];

  let fallbackBlock = null;
  if (fallbackOk) {
    // Haversine delta between the two stores' distance to the address.
    // Can come out 0 or negative when "nearest" was picked by district-
    // match (Tier 3) but the fallback is geographically closer to the
    // centroid we're using as the address proxy — common in light data,
    // e.g. Tianhe-district address → Yuexiu store closer to centroid
    // than the Tianhe store itself (the centroid lives between them).
    const rawExtraKm = (fallbackOk.distance_km != null && nearest?.distance_km != null)
      ? fallbackOk.distance_km - nearest.distance_km
      : null;
    // Floor the displayed delta to a baseline cross-store routing cost
    // (~1.5 km / ~15 min). Picking up from a non-preferred store always
    // adds real operational time — even when the straight-line distance
    // ties — so the customer expectation is honest, never "0 extra".
    const MIN_CROSS_STORE_KM  = 1.5;
    const MIN_CROSS_STORE_MIN = 15;
    const extraKm = rawExtraKm == null
      ? null
      : Math.max(MIN_CROSS_STORE_KM, rawExtraKm);
    // Rough rule-of-thumb: e-bike / scooter in GZ traffic ≈ 18 km/h
    // including pickup + drop. So extra ETA in minutes ≈ extra_km * 3.3.
    // Round to nearest 5 minutes for friendliness; floor at the
    // cross-store baseline so the modal never claims "0 min slower".
    const extraMin = extraKm == null
      ? null
      : Math.max(MIN_CROSS_STORE_MIN, Math.round(extraKm * 3.3 / 5) * 5);
    fallbackBlock = {
      store: fallbackOk.store,
      items: fallbackOk.items,
      distance_km: fallbackOk.distance_km,
      extra_km: extraKm != null ? Number(extraKm.toFixed(1)) : null,
      extra_min_estimate: extraMin,
    };
  }

  return {
    gate,
    resolved: route, // for callers that just want the auto-fallback path
    nearest,
    fallback: fallbackBlock,
    missing_items,
  };
}

// Substitute candidates for a missing item at a given store. Returns
// in-stock products: explicit admin-curated substitutes first, then
// same-category in-stock products as filler. Used by the 'replace'
// option in the mini-app modal.
function substitutesForProduct({ productId, storeId, channel = 'wechat', limit = 12 }) {
  const explicit = tdb().prepare(`
    SELECT p.id AS product_id, p.name_en, p.name_cn, p.sku, p.sell_price, p.image_data, p.category,
           1 AS curated, s.sort_order
      FROM retail_product_substitutes s
      JOIN store_products p ON p.id = s.substitute_product_id
     WHERE s.product_id = ? AND COALESCE(p.is_active, 1) = 1 AND p.is_published = 1
     ORDER BY s.sort_order ASC, p.name_en COLLATE NOCASE
  `).all(productId);

  const base = tdb().prepare('SELECT category FROM store_products WHERE id = ?').get(productId);
  const auto = (base?.category)
    ? tdb().prepare(`
        SELECT id AS product_id, name_en, name_cn, sku, sell_price, image_data, category,
               0 AS curated, 0 AS sort_order
          FROM store_products
         WHERE id != ? AND category = ? AND COALESCE(is_active, 1) = 1 AND is_published = 1
         ORDER BY name_en COLLATE NOCASE
         LIMIT 50
      `).all(productId, base.category)
    : [];

  // Merge — explicit first, auto fills the rest, no duplicates.
  const seen = new Set(explicit.map(r => r.product_id));
  const merged = [...explicit];
  for (const r of auto) {
    if (seen.has(r.product_id)) continue;
    merged.push(r);
    seen.add(r.product_id);
  }

  // Filter by in-stock at the routing store + decorate with available_qty.
  return merged
    .map(r => {
      const av = getAvailable(storeId, r.product_id, channel);
      return { ...r, available: av.available, in_stock: av.exists && av.available > 0 };
    })
    .filter(r => r.in_stock)
    .slice(0, limit);
}

// Called whenever stock for (store, product) increases. If any orders
// are in 'awaiting_restock' status at that store waiting on that
// product AND all their awaiting-products are now satisfied, transition
// them to 'paid' so the kitchen sees them in the active queue. Returns
// the list of transitioned order_ids so the caller can fire pushes.
function checkAwaitingRestockForRestock({ storeId, productId }) {
  const candidates = tdb().prepare(`
    SELECT o.id, o.awaiting_restock_pids
      FROM retail_orders o
     WHERE o.status = 'awaiting_restock' AND o.store_id = ?
  `).all(storeId);
  const transitioned = [];
  const tx = tdb().transaction(() => {
    for (const o of candidates) {
      let pids;
      try { pids = JSON.parse(o.awaiting_restock_pids || '[]'); }
      catch { pids = []; }
      if (!Array.isArray(pids) || !pids.includes(productId)) continue;
      // Load the order's line items up front so availability is checked against
      // the actual quantities required (not merely ">0").
      const items = tdb().prepare(
        'SELECT product_id, qty FROM retail_order_items WHERE order_id = ?'
      ).all(o.id);
      // Total qty this order needs per product (a product can appear on more
      // than one line).
      const need = new Map();
      for (const it of items) need.set(it.product_id, (need.get(it.product_id) || 0) + it.qty);
      // EVERY product the order needs must have enough FREE stock to cover its
      // quantity — not just >0. The old `available > 0` check oversold:
      // restocking 1 unit for an order needing 5 still passed, then deducted the
      // full 5, driving physical_qty negative (and overselling against another
      // channel's active reservations). awaiting_restock orders hold no
      // reservation, so av.available is the true free stock.
      const allOk = [...need.entries()].every(([pid, qty]) => {
        const av = getAvailable(storeId, pid, 'wechat');
        return av.exists && av.available >= qty;
      });
      if (!allOk) continue;
      // Reserve fresh holds for the items (so the restock isn't sold to
      // someone else between now and fulfillment) — re-use the existing
      // reservation table, status='committed' to skip the sweeper.
      const ttl = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      for (const it of items) {
        tdb().prepare(`
          INSERT INTO retail_stock_reservations
            (store_id, product_id, order_id, qty, channel, status, expires_at, committed_at)
          VALUES (?, ?, ?, ?, 'wechat', 'committed', ?, CURRENT_TIMESTAMP)
        `).run(storeId, it.product_id, o.id, it.qty, ttl);
        // Deduct physical now that the order is fulfillable.
        tdb().prepare(
          'UPDATE retail_store_stock SET physical_qty = physical_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?'
        ).run(it.qty, storeId, it.product_id);
        const bal = tdb().prepare(
          'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
        ).get(storeId, it.product_id)?.physical_qty ?? 0;
        tdb().prepare(`
          INSERT INTO retail_stock_ledger
            (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel)
          VALUES (?, ?, ?, 'awaiting_restock_release', 'retail_orders', ?, ?, 'wechat')
        `).run(storeId, it.product_id, -it.qty, o.id, bal);
        enqueueChannelSync(storeId, it.product_id);
      }
      // Flip the order status. awaiting_restock_pids stays for audit.
      tdb().prepare(
        "UPDATE retail_orders SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(o.id);
      transitioned.push(o.id);
    }
  });
  tx();
  return transitioned;
}

module.exports = {
  ttlMinutes,
  listStores,
  orderChannelKey,
  storeClosedStores,
  channelClosedStores,
  channelFullyClosed,
  onlineFullyClosedStores,
  sellableStockSql,
  getStore,
  getAvailable,
  getAvailableMap,
  routeOrder,
  reserveForOrder,
  commitOrderReservations,
  commitUnreservedOrder,
  isStockPending,
  releaseOrderReservations,
  reverseCommittedOrder,
  reverseCommittedLines,
  adjustStock,
  setOnOrdersPromoted,
  upsertStockLayer,
  sweepExpiredReservations,
  startReservationSweeper,
  // New for the 5-option flow:
  isExpressGzEligible,
  gzExpressExcludedDistricts,
  storeDistanceKm,
  analyzeShortage,
  substitutesForProduct,
  checkAwaitingRestockForRestock,
  // Stock-gate helpers (out-of-stock only fires on GZ + same-day):
  isGuangzhouAddress,
  isSameDayDelivery,
  isOptInSameDayDistrict,
  requiresStockGate,
  isQingyunSameCityToday,
  QINGYUN_PUSH_CHANNELS,
};
