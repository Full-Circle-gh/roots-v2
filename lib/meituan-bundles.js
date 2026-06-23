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

// Enqueue a single bundle's computed stock for the daemon to push.
function enqueueBundle(db, bundle) {
  const qty = bundleStock(db, bundle);
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

// Enqueue all sync-enabled bundles (used by "Push all stock now").
function enqueueAllBundles(db) {
  const bundles = db.prepare('SELECT * FROM meituan_bundles WHERE sync_enabled = 1').all();
  for (const b of bundles) enqueueBundle(db, b);
  return bundles.length;
}

module.exports = { bundleStock, enqueueBundle, enqueueBundlesForProduct, enqueueAllBundles };
