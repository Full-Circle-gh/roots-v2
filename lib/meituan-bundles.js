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

// Enqueue a single bundle's computed stock for the daemon to push.
// An empty shell (no components) is skipped — pushing its 0 would wrongly
// sell out the Meituan listing before the operator fills in components.
// `force` (1) flags the row to push even while the store is closed on Meituan
// (emergency correction outside opening hours).
function enqueueBundle(db, bundle, force = 0) {
  if (!hasComponents(db, bundle)) return null;
  const qty = bundleStock(db, bundle);
  db.prepare(`
    INSERT INTO meituan_sync_queue
      (retail_store_id, product_id, store_code, new_qty, status, meituan_name, bundle_id, force)
    VALUES (?, NULL, ?, ?, 'pending', ?, ?, ?)
  `).run(bundle.retail_store_id, bundle.store_code, qty, bundle.meituan_name, bundle.id, force ? 1 : 0);
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
function enqueueProductStock(db, storeId, productId) {
  try {
    const map = db.prepare(
      'SELECT store_code FROM meituan_product_map WHERE retail_store_id = ? AND product_id = ? AND sync_enabled = 1'
    ).get(storeId, productId);
    if (map) {
      const row = db.prepare(
        'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
      ).get(storeId, productId);
      db.prepare(`
        INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(storeId, productId, map.store_code, row ? row.q : 0);
    }
    enqueueBundlesForProduct(db, storeId, productId);
  } catch (e) { console.error('[meituan-sync-queue] enqueueProductStock:', e.message); }
}

// Enqueue all sync-enabled bundles (used by "Push all stock now").
// Empty shells are skipped (enqueueBundle returns null); count only real pushes.
function enqueueAllBundles(db, force = 0) {
  const bundles = db.prepare('SELECT * FROM meituan_bundles WHERE sync_enabled = 1').all();
  let n = 0;
  for (const b of bundles) if (enqueueBundle(db, b, force) != null) n++;
  return n;
}

module.exports = { bundleStock, enqueueBundle, enqueueBundlesForProduct, enqueueProductStock, enqueueAllBundles };
