'use strict';

// Meituan-only bundle stock logic. A bundle is a Meituan listing (套餐/combo)
// made of N roots component products. Its sellable quantity is the minimum of
// what its components can make — floor(component_stock / qty_per_bundle) over
// all components, capped by an optional max_qty. When any component hits 0 the
// bundle drops to 0, so it auto-pauses on Meituan.
//
// Every function takes the tenant db handle so it stays multi-tenant safe.

// Compute a bundle's current sellable quantity from component stock.
function bundleStock(db, bundle) {
  const comps = db.prepare(
    'SELECT product_id, qty FROM meituan_bundle_components WHERE bundle_id = ?'
  ).all(bundle.id);
  if (!comps.length) return 0;

  let min = Infinity;
  for (const c of comps) {
    const row = db.prepare(
      'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
    ).get(bundle.retail_store_id, c.product_id);
    const have = row ? row.q : 0;
    const per  = c.qty > 0 ? c.qty : 1;
    min = Math.min(min, Math.floor(have / per));
  }
  if (!isFinite(min) || min < 0) min = 0;
  if (bundle.max_qty != null && min > bundle.max_qty) min = bundle.max_qty;
  return min;
}

// True when a bundle has at least one component product configured.
function hasComponents(db, bundle) {
  return !!db.prepare(
    'SELECT 1 FROM meituan_bundle_components WHERE bundle_id = ? LIMIT 1'
  ).get(bundle.id);
}

// ── One pending row per target, and none at all for a store that is shut ─────
//
// The queue is edge-triggered: every stock change appended a row. While a store
// is being pushed that is fine — the drain collapses same-target rows and the
// pile never gets big. While a store is NOT being pushed, it is unbounded: one
// row per edit, for as long as the store stays shut, for every product. 越秀 was
// closed indefinitely and had 137 rows against 3 days of edits, going up.
//
// Two bounds, in order of how much they buy:
//
//   1) Collapse on the way IN. A target with a push already waiting does not
//      need a second one — the drain would only discard it (it keeps the latest
//      qty per target and retires the rest). Refreshing the waiting row's
//      quantity instead of appending caps the queue at the size of the catalogue
//      no matter how long a store is closed or a push path is broken.
//      created_at is deliberately NOT touched: it is this row's place in the
//      FIFO and the age the stall canary measures. Bumping it on every edit
//      would hide a stuck row forever behind a stream of new edits.
//
//   2) Don't enqueue for an inactive location at all. A store with is_active = 0
//      is not trading, so a stock row for it is a row nobody will ever push.
//
// Neither loses an update. The drift sweep is level-triggered: it compares live
// stock against what Meituan last accepted and re-queues the difference, so
// whatever happened while a store was shut is queued when it opens — one row per
// drifted product, rather than the hundreds of intermediate values that got it
// there.
function storeTrading(db, retailStoreId) {
  try {
    const r = db.prepare('SELECT is_active FROM retail_stores WHERE id = ?').get(retailStoreId);
    return !r || r.is_active !== 0;   // unknown → assume trading, never silently drop
  } catch (_) { return true; }        // pre-migration / missing table → behave as before
}

// Refresh the quantity on a push that is already waiting for this target.
// Returns true when one was found (so the caller must not append another).
// Only 'pending' rows: a row in 'processing' is mid-push and owns its value, so a
// change arriving now genuinely needs a new row behind it.
function refreshPending(db, { retailStoreId, productId = null, bundleId = null, qty }) {
  try {
    const r = db.prepare(`
      UPDATE meituan_sync_queue
         SET new_qty = ?, last_error = NULL
       WHERE retail_store_id = ?
         AND status = 'pending'
         AND ${bundleId != null ? 'bundle_id = ?' : 'bundle_id IS NULL AND product_id = ?'}
    `).run(qty, retailStoreId, bundleId != null ? bundleId : productId);
    return r.changes > 0;
  } catch (_) { return false; }
}

// Enqueue a single bundle's computed stock for the daemon to push.
// An empty shell (no components) is skipped — pushing its 0 would wrongly
// sell out the Meituan listing before the operator fills in components.
function enqueueBundle(db, bundle) {
  if (!hasComponents(db, bundle)) return null;
  const qty = bundleStock(db, bundle);
  if (!storeTrading(db, bundle.retail_store_id)) return null;
  if (refreshPending(db, { retailStoreId: bundle.retail_store_id, bundleId: bundle.id, qty })) return qty;
  db.prepare(`
    INSERT INTO meituan_sync_queue
      (retail_store_id, product_id, store_code, new_qty, status, meituan_name, bundle_id)
    VALUES (?, NULL, ?, ?, 'pending', ?, ?)
  `).run(bundle.retail_store_id, bundle.store_code, qty, bundle.meituan_name, bundle.id);
  return qty;
}

// Enqueue every sync-enabled bundle that contains the given product in a store.
// Called whenever a component's stock changes so the bundle re-pushes.
function enqueueBundlesForProduct(db, storeId, productId) {
  const bundles = db.prepare(`
    SELECT b.* FROM meituan_bundles b
      JOIN meituan_bundle_components c ON c.bundle_id = b.id
     WHERE b.retail_store_id = ? AND c.product_id = ? AND b.sync_enabled = 1
  `).all(storeId, productId);
  for (const b of bundles) enqueueBundle(db, b);
  return bundles.length;
}

// Enqueue a Meituan stock push for a single mapped product PLUS any bundles it
// is a component of. Call this after ANY change to a product's physical_qty
// (admin edit, order commit, refund/reverse) so Meituan tracks every depletion,
// not just operator edits. Pushes the product's current physical_qty (same value
// the admin stock route pushes). No-op for products that aren't mapped/enabled.
// Is this store's Meituan sync switched on? Reads the SAME signal the Sales
// card's per-location toggle writes — store_business_status.target_open — so
// there is one control, not two. Until this gate existed that toggle closed the
// shop on Meituan but left stock syncing, which is how 748 updates queued up
// behind a store that had been shut for 24 days.
//
// target_open ONLY, never is_open: is_open is what Meituan reports, and a shop
// that shuts for the night still wants accurate stock when it opens. This is
// the operator's decision, and absent means on.
function storePushEnabled(db, storeCode) {
  if (!storeCode) return true;
  try {
    const row = db.prepare('SELECT target_open FROM store_business_status WHERE store_code = ?')
                  .get(storeCode);
    return !row || row.target_open === null || row.target_open === undefined
      ? true : row.target_open === 1;
  } catch (e) { return true; }
}

function enqueueProductStock(db, storeId, productId) {
  try {
    const map = db.prepare(
      'SELECT store_code FROM meituan_product_map WHERE retail_store_id = ? AND product_id = ? AND sync_enabled = 1'
    ).get(storeId, productId);
    if (map && storeTrading(db, storeId) && storePushEnabled(db, map.store_code)) {
      const row = db.prepare(
        'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
      ).get(storeId, productId);
      const qty = row ? row.q : 0;
      if (!refreshPending(db, { retailStoreId: storeId, productId, qty })) {
        db.prepare(`
          INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
          VALUES (?, ?, ?, ?, 'pending')
        `).run(storeId, productId, map.store_code, qty);
      }
    }
    enqueueBundlesForProduct(db, storeId, productId);
  } catch (e) { console.error('[meituan-sync-queue] enqueueProductStock:', e.message); }
}

// Enqueue all sync-enabled bundles (used by "Push all stock now").
// Empty shells are skipped (enqueueBundle returns null); count only real pushes.
function enqueueAllBundles(db) {
  const bundles = db.prepare('SELECT * FROM meituan_bundles WHERE sync_enabled = 1').all();
  let n = 0;
  for (const b of bundles) if (enqueueBundle(db, b) != null) n++;
  return n;
}

module.exports = { bundleStock, hasComponents, enqueueBundle, enqueueBundlesForProduct, enqueueProductStock, enqueueAllBundles, storeTrading, refreshPending, storePushEnabled };
