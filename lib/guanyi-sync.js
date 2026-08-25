'use strict';

// Guanyi (gzgrocery) stock-sync enqueue helper. Parallel to lib/meituan-bundles
// but simpler: Guanyi has no bundles/combos for us, so this only enqueues a
// single mapped product's CURRENT target quantity. The daemon turns that target
// into an inbound/outbound document by diffing against Guanyi's live on-hand.
//
// Every function takes the tenant db handle so it stays multi-tenant safe.

const bundleStock = require('./bundle-stock');

// Enqueue a Guanyi reconcile for one product after its physical_qty changed.
// new_qty is the ABSOLUTE target (the store's current physical_qty) — NOT a
// delta; the daemon computes the delta against Guanyi's current stock so it
// never double-applies if several queue rows pile up. No-op for products that
// aren't mapped to Guanyi or whose mapping is disabled.
function enqueueProductStock(db, storeId, productId) {
  try {
    const map = db.prepare(
      'SELECT store_code FROM guanyi_product_map WHERE retail_store_id = ? AND product_id = ? AND sync_enabled = 1'
    ).get(storeId, productId);
    if (!map) return;
    // Bundles report their component floor, everything else its own shelf count —
    // see lib/bundle-stock. The daemon still treats this as an ABSOLUTE target and
    // diffs it against Guanyi's live on-hand, so the meaning of the number is
    // unchanged; only its source is corrected.
    const qty = bundleStock.sellableAt(db, storeId, productId);
    db.prepare(`
      INSERT INTO guanyi_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(storeId, productId, map.store_code, qty);
  } catch (e) { console.error('[guanyi-sync-queue] enqueueProductStock:', e.message); }
}

// Enqueue every sync-enabled mapped product for a store (used by "Push all now").
function enqueueAll(db, storeId) {
  const maps = db.prepare(
    'SELECT product_id FROM guanyi_product_map WHERE retail_store_id = ? AND sync_enabled = 1'
  ).all(storeId);
  let n = 0;
  for (const m of maps) { enqueueProductStock(db, storeId, m.product_id); n++; }
  return n;
}

module.exports = { enqueueProductStock, enqueueAll };
