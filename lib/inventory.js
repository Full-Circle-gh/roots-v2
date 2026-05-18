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
// All multi-step operations use a db.transaction() so concurrent order
// creates can't oversell — better-sqlite3 serializes transactions.

const db = require('../database');
const { haversineKm } = require('./geocode');

const RESERVATION_TTL_MIN_DEFAULT = 15;

function ttlMinutes() {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'inventory.reservationTtlMinutes'").get();
    if (row) {
      const v = parseInt(JSON.parse(row.value_json), 10);
      if (v > 0) return v;
    }
  } catch {}
  return RESERVATION_TTL_MIN_DEFAULT;
}

function listStores({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return db.prepare(
    `SELECT id, code, name_en, name_cn, address, city, district, lat, lng, phone,
            meituan_account_id, is_active, sort_order, created_at, updated_at
       FROM retail_stores ${where} ORDER BY sort_order ASC, id ASC`
  ).all();
}

function getStore(storeId) {
  return db.prepare('SELECT * FROM retail_stores WHERE id = ?').get(storeId);
}

// Active reservations sum, optionally scoped to a channel.
function sumActiveReservations(storeId, productId, channel) {
  const params = [storeId, productId];
  let sql = `SELECT COALESCE(SUM(qty), 0) AS n
               FROM retail_stock_reservations
              WHERE store_id = ? AND product_id = ? AND status = 'active'`;
  if (channel) { sql += ' AND channel = ?'; params.push(channel); }
  return db.prepare(sql).get(...params).n;
}

// Per-store availability for a product on a given channel.
function getAvailable(storeId, productId, channel = 'wechat') {
  const row = db.prepare(
    `SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota
       FROM retail_store_stock
      WHERE store_id = ? AND product_id = ?`
  ).get(storeId, productId);
  if (!row) return { available: 0, exists: false, physical: 0, safety: 0, channelQuota: null };

  const allReserved     = sumActiveReservations(storeId, productId);
  const chanReserved    = sumActiveReservations(storeId, productId, channel);
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

// Order routing: given an address and a list of {product_id, qty} items,
// pick a store that can satisfy ALL items, preferring (1) the store linked
// to the matching delivery zone, (2) a store whose home district matches
// the address, (3) the lowest-sort_order active store as fallback.
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
function routeOrder({ address, items, channel = 'wechat', acceptFallback = false }) {
  const stores = listStores({ activeOnly: true });
  if (!stores.length) return { error: 'no_active_store' };

  // Build candidate list in priority order:
  //   1. Admin override — delivery zone's preferred_store_id (manual intent always wins).
  //   2. GPS distance — if BOTH customer address AND at least one store have lat/lng,
  //      sort all stores by Haversine distance ascending. This is the smart default
  //      once coordinates are populated (handles "天河区 is huge" correctly).
  //   3. Home-district match — store.district === address.district.
  //   4. Sort_order fallback.
  const candidates = [];
  const addrDistrict = address?.district || null;
  const addrCity     = address?.city     || null;
  const addrLat      = typeof address?.lat === 'number' ? address.lat : null;
  const addrLng      = typeof address?.lng === 'number' ? address.lng : null;
  const hasAddrGps   = addrLat != null && addrLng != null;

  // 1. Preferred store from delivery zone, if any.
  if (addrDistrict || addrCity) {
    const zone = db.prepare(
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

  // 2. GPS-based proximity ranking. Stores without lat/lng go to the
  // bottom (we can't measure them). Only kicks in when the customer's
  // address has been geocoded.
  if (hasAddrGps) {
    const ranked = stores
      .map(s => {
        const sLat = typeof s.lat === 'number' ? s.lat : null;
        const sLng = typeof s.lng === 'number' ? s.lng : null;
        const km = (sLat != null && sLng != null)
          ? haversineKm({ lat: addrLat, lng: addrLng }, { lat: sLat, lng: sLng })
          : null;
        return { store: s, km };
      })
      .sort((a, b) => {
        if (a.km == null && b.km == null) return 0;
        if (a.km == null) return  1;
        if (b.km == null) return -1;
        return a.km - b.km;
      });
    for (const r of ranked) {
      if (!candidates.some(c => c.store.id === r.store.id)) {
        candidates.push({ store: r.store, reason: 'nearest', distance_km: r.km });
      }
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
      const av = getAvailable(c.store.id, it.product_id, channel);
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
    };
  });

  const nearest    = scored[0] || null;
  const fallbackOk = scored.slice(1).find(c => c.ok) || null;

  // Single store and it's out → nothing we can do.
  if (stores.length === 1) {
    if (nearest?.ok) return { store: nearest.store, reason: 'only_store', items: nearest.items };
    return {
      error: 'no_stock',
      store: nearest?.store || null,
      shortages: nearest?.shortages || [],
    };
  }

  // Nearest can fulfill — done, no question to ask.
  if (nearest?.ok) {
    return { store: nearest.store, reason: nearest.proposedReason, items: nearest.items };
  }

  // Nearest can't, but a fallback can. Ask the customer unless they've
  // already accepted up-front (acceptFallback === true).
  if (fallbackOk) {
    if (acceptFallback) {
      return { store: fallbackOk.store, reason: 'fallback_no_stock', items: fallbackOk.items };
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
function reserveForOrder({ storeId, orderId, items, channel = 'wechat' }) {
  const ttl = ttlMinutes();
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const insRes = db.prepare(`
    INSERT INTO retail_stock_reservations
      (store_id, product_id, order_id, qty, channel, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `);

  const out = [];
  const tx = db.transaction(() => {
    for (const it of items) {
      const av = getAvailable(storeId, it.product_id, channel);
      if (!av.exists) {
        const err = new Error('product_not_stocked_here');
        err.code = 'product_not_stocked_here';
        err.product_id = it.product_id;
        throw err;
      }
      if (av.available < it.qty) {
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
  return { reservations: out, expires_at: expiresAt };
}

// Commit all active reservations for an order: mark committed, decrement
// physical_qty, write ledger entries. Idempotent — re-running on an
// already-committed order is a no-op.
function commitOrderReservations(orderId, { actorUserId = null } = {}) {
  const tx = db.transaction(() => {
    const reservations = db.prepare(`
      SELECT id, store_id, product_id, qty, channel
        FROM retail_stock_reservations
       WHERE order_id = ? AND status = 'active'
    `).all(orderId);
    if (!reservations.length) return { committed: 0 };

    const decr   = db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
    const mark   = db.prepare("UPDATE retail_stock_reservations SET status = 'committed', committed_at = CURRENT_TIMESTAMP WHERE id = ?");
    const getBal = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
    const insLed = db.prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, channel)
      VALUES (?, ?, ?, 'order_commit', 'retail_orders', ?, ?, ?, ?)
    `);

    for (const r of reservations) {
      decr.run(r.qty, r.store_id, r.product_id);
      const bal = getBal.get(r.store_id, r.product_id)?.physical_qty ?? 0;
      insLed.run(r.store_id, r.product_id, -r.qty, orderId, bal, actorUserId, r.channel);
      mark.run(r.id);
    }
    return { committed: reservations.length };
  });
  return tx();
}

// Release all active reservations for an order (customer cancel, expiry,
// admin reject). Stock returns to the available pool without touching
// physical_qty. Idempotent.
function releaseOrderReservations(orderId, { reason = 'released', actorUserId = null } = {}) {
  const tx = db.transaction(() => {
    const reservations = db.prepare(`
      SELECT id FROM retail_stock_reservations WHERE order_id = ? AND status = 'active'
    `).all(orderId);
    if (!reservations.length) return { released: 0 };

    const status = reason === 'expired' ? 'expired' : 'released';
    const mark = db.prepare(
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
function reverseCommittedOrder(orderId, { actorUserId = null, note = null } = {}) {
  const tx = db.transaction(() => {
    const reservations = db.prepare(`
      SELECT id, store_id, product_id, qty, channel
        FROM retail_stock_reservations
       WHERE order_id = ? AND status = 'committed'
    `).all(orderId);
    if (!reservations.length) return { reversed: 0 };

    // Don't reverse twice — check ledger for an existing reverse entry.
    const already = db.prepare(`
      SELECT 1 FROM retail_stock_ledger
       WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'order_reverse'
       LIMIT 1
    `).get(orderId);
    if (already) return { reversed: 0, idempotent: true };

    const inc    = db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?');
    const getBal = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?');
    const insLed = db.prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, channel, note)
      VALUES (?, ?, ?, 'order_reverse', 'retail_orders', ?, ?, ?, ?, ?)
    `);

    for (const r of reservations) {
      inc.run(r.qty, r.store_id, r.product_id);
      const bal = getBal.get(r.store_id, r.product_id)?.physical_qty ?? 0;
      insLed.run(r.store_id, r.product_id, +r.qty, orderId, bal, actorUserId, r.channel, note);
    }
    return { reversed: reservations.length };
  });
  return tx();
}

// Admin stock adjustment — sets physical_qty to an explicit value and
// records the delta in the ledger.
function adjustStock({ storeId, productId, newPhysicalQty, actorUserId = null, note = null, reason = 'adjust' }) {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
    ).get(storeId, productId);
    const oldQty = existing?.physical_qty ?? 0;
    const delta  = newPhysicalQty - oldQty;
    if (existing) {
      db.prepare(
        'UPDATE retail_store_stock SET physical_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?'
      ).run(newPhysicalQty, storeId, productId);
    } else {
      db.prepare(
        'INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, ?)'
      ).run(storeId, productId, newPhysicalQty);
    }
    db.prepare(`
      INSERT INTO retail_stock_ledger
        (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, note)
      VALUES (?, ?, ?, ?, 'retail_store_stock', NULL, ?, ?, ?)
    `).run(storeId, productId, delta, reason, newPhysicalQty, actorUserId, note);
    return { oldQty, newQty: newPhysicalQty, delta };
  });
  return tx();
}

function upsertStockLayer({ storeId, productId, fields, actorUserId = null }) {
  const allowed = ['safety_buffer', 'wechat_quota', 'meituan_quota', 'restock_target'];
  const existing = db.prepare(
    'SELECT id FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  ).get(storeId, productId);
  if (!existing) {
    db.prepare(
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
  db.prepare(
    `UPDATE retail_store_stock SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_id = ?`
  ).run(...vals);
  return { changed: 1 };
}

// Reservation expiry sweeper. Run on a timer; idempotent. Returns the
// number of expired reservations + auto-cancelled orders. Auto-cancels
// any pending_payment order whose reservations have all expired.
function sweepExpiredReservations() {
  const tx = db.transaction(() => {
    const expired = db.prepare(`
      SELECT id, order_id FROM retail_stock_reservations
       WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP
    `).all();
    if (!expired.length) return { expired: 0, cancelledOrders: 0 };

    const markExpired = db.prepare(
      "UPDATE retail_stock_reservations SET status = 'expired', released_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    for (const r of expired) markExpired.run(r.id);

    // Auto-cancel orders whose reservations are all gone (and which are
    // still pending_payment). One UPDATE per distinct order_id is fine.
    const orderIds = [...new Set(expired.map(r => r.order_id).filter(Boolean))];
    let cancelled = 0;
    for (const oid of orderIds) {
      const r = db.prepare(`
        UPDATE retail_orders
           SET status = 'cancelled',
               cancelled_at = CURRENT_TIMESTAMP,
               cancelled_reason = 'reservation_expired',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending_payment'
      `).run(oid);
      if (r.changes > 0) {
        db.prepare("UPDATE retail_payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'").run(oid);
        cancelled++;
      }
    }
    return { expired: expired.length, cancelledOrders: cancelled };
  });
  return tx();
}

function startReservationSweeper({ intervalMs = 60_000 } = {}) {
  const tick = () => {
    try {
      const r = sweepExpiredReservations();
      if (r.expired > 0) {
        console.log(`[inventory.sweeper] expired=${r.expired} cancelled_orders=${r.cancelledOrders}`);
      }
    } catch (e) {
      console.error('[inventory.sweeper] error', e);
    }
  };
  // First tick at boot, then on interval.
  setTimeout(tick, 5_000);
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  ttlMinutes,
  listStores,
  getStore,
  getAvailable,
  routeOrder,
  reserveForOrder,
  commitOrderReservations,
  releaseOrderReservations,
  reverseCommittedOrder,
  adjustStock,
  upsertStockLayer,
  sweepExpiredReservations,
  startReservationSweeper,
};
