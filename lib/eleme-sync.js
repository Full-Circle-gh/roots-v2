'use strict';

// Eleme stock-push queue writer — the Eleme twin of meituan-bundles'
// enqueueProductStock. Called from inventory.enqueueChannelSync after ANY change
// to a product's physical_qty, so order ingest, manual edits, and other channels'
// deductions all re-push the corrected number to Eleme.
//
// Gated twice so a tenant that doesn't use Eleme never accrues queue rows:
//   1. feature switch  — storefront_config 'eleme.enabled' must be true
//   2. per-product map — eleme_product_map row with sync_enabled = 1
// Both checks are cheap and read the SAME tenant db connection as the mutation.

// Is the Eleme channel switched on for this tenant?
function elemeEnabled(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'eleme.enabled'").get();
    return row ? JSON.parse(row.value_json) === true : false;
  } catch { return false; }
}

// If this store/product already has a pending row, update its qty in place and
// report true; otherwise report false so the caller inserts a fresh one. Same
// pattern as meituan-bundles' refreshPending — without it, every stock change
// (and every "Sync now" click on push-all below) inserted a brand new row on
// top of whatever was already waiting, so a product that changed 5 times before
// the daemon got to it queued 5 separate pushes of increasingly stale values
// instead of one push of the current one.
function refreshPending(db, { retailStoreId, productId, qty }) {
  try {
    const r = db.prepare(`
      UPDATE eleme_sync_queue
         SET new_qty = ?, last_error = NULL
       WHERE retail_store_id = ? AND product_id = ? AND status = 'pending'
    `).run(qty, retailStoreId, productId);
    return r.changes > 0;
  } catch (_) { return false; }
}

// Queue this product's current physical_qty for an Eleme push, if mapped + enabled.
function enqueueProductStock(db, storeId, productId) {
  try {
    if (!elemeEnabled(db)) return;
    const map = db.prepare(
      'SELECT store_code FROM eleme_product_map WHERE retail_store_id = ? AND product_id = ? AND sync_enabled = 1'
    ).get(storeId, productId);
    if (!map) return;
    const row = db.prepare(
      'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
    ).get(storeId, productId);
    const qty = row ? row.q : 0;
    if (refreshPending(db, { retailStoreId: storeId, productId, qty })) return;
    db.prepare(`
      INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(storeId, productId, map.store_code, qty);
  } catch (e) { console.error('[eleme-sync-queue] enqueueProductStock:', e.message); }
}

// Queue every mapped product for a "push all" / sync-now. Returns the count.
function enqueueAll(db) {
  if (!elemeEnabled(db)) return 0;
  const mapped = db.prepare(`
    SELECT m.product_id, m.retail_store_id, m.store_code,
           COALESCE(s.physical_qty, 0) AS qty
      FROM eleme_product_map m
      LEFT JOIN retail_store_stock s
             ON s.product_id = m.product_id AND s.store_id = m.retail_store_id
     WHERE m.sync_enabled = 1
  `).all();
  const insert = db.prepare(`
    INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  const tx = db.transaction(() => {
    for (const row of mapped) {
      if (refreshPending(db, { retailStoreId: row.retail_store_id, productId: row.product_id, qty: row.qty })) continue;
      insert.run(row.retail_store_id, row.product_id, row.store_code, row.qty);
    }
  });
  tx();
  return mapped.length;
}

module.exports = { elemeEnabled, enqueueProductStock, enqueueAll };
