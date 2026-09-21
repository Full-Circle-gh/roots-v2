'use strict';

// Meituan-only bundle stock logic. A bundle is a Meituan listing (套餐/combo)
// made of N roots component products. Its sellable quantity is the minimum of
// what its components can make — floor(component_stock / qty_per_bundle) over
// all components, capped by an optional max_qty. When any component hits 0 the
// bundle drops to 0, so it auto-pauses on Meituan.
//
// Every function takes the tenant db handle so it stays multi-tenant safe.

const bundleStockLib = require('./bundle-stock');

// Compute a bundle's current sellable quantity from component stock.
//
// NOTE ON WHICH BUNDLE THIS IS. `meituan_bundles` is MEITUAN's own combo concept —
// a 套餐 listing assembled from N roots products — and is a different thing from a
// roots bundle (a store_products row carrying `bundle_items`). This function was
// always correct for its own kind. The component read goes through
// bundleStock.sellableAt() so that a component which is ITSELF a roots bundle
// contributes what it can be assembled from rather than its vestigial shelf row.
// No live row is affected: meituan_bundle_components currently holds zero rows
// pointing at a roots bundle, so this is a no-op today and correct if that changes.
function bundleStock(db, bundle) {
  const comps = db.prepare(
    'SELECT product_id, qty FROM meituan_bundle_components WHERE bundle_id = ?'
  ).all(bundle.id);
  if (!comps.length) return 0;

  let min = Infinity;
  for (const c of comps) {
    const have = bundleStockLib.sellableAt(db, bundle.retail_store_id, c.product_id);
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

// §85 — the number a platform is told. Not required for the roots-bundle floor
// below: a Meituan 套餐 is assembled from components and an allowance added to
// each of them would be counted once per component.
const channelPublish = require('./channel-publish');
const { isStoreTradingOnChannel } = require('./store-trading');

// Enqueue a single bundle's computed stock for the daemon to push.
// An empty shell (no components) is skipped — pushing its 0 would wrongly
// sell out the Meituan listing before the operator fills in components.
function enqueueBundle(db, bundle) {
  if (!hasComponents(db, bundle)) return null;
  const qty = bundleStock(db, bundle);
  if (!storeTrading(db, bundle.retail_store_id)) return null;
  // The same per-location gate enqueueProductStock applies. It was missing here,
  // so a component's stock moving at a switched-off location still queued a combo
  // push for it — rows the daemon would refuse and lib/store-close.js would have
  // to clear again. storeTrading above is a different question (is the retail
  // store row active at all), not a substitute for this one.
  if (!storePushEnabled(db, bundle.store_code)) return null;
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
// target_open is a COMMAND the daemon nulls once applied, so it cannot be read
// alone — a store closed last month has none pending. Fall through to is_open,
// the 营业/置休 state. Nightly hours are a separate daemon-side gate.
//
// It delegates to lib/store-trading, the one predicate, rather than reading
// target_open/is_open here. Those two are the Meituan POI's own 营业/停业 state and
// they are not the only switch over this location: fulfillment_open is the
// shop-wide master, and a shop with it at 0 has already been dropped from every
// routing pool in lib/inventory — it cannot take an order, so nothing should be
// queueing it stock pushes either.
function storePushEnabled(db, storeCode) {
  if (!storeCode) return true;
  return isStoreTradingOnChannel(db, storeCode, 'meituan');
}

function enqueueProductStock(db, storeId, productId) {
  try {
    const map = db.prepare(
      'SELECT store_code FROM meituan_product_map WHERE retail_store_id = ? AND product_id = ? AND sync_enabled = 1'
    ).get(storeId, productId);
    if (map && storeTrading(db, storeId) && storePushEnabled(db, map.store_code)) {
      // A roots bundle's own stock row is vestigial — no sale ever moves it, and
      // on most rows it is still the 2026-05-17 migration seed. sellableAt()
      // returns the component floor for those and the untouched shelf count for
      // everything else, so Meituan is told what the shop shows.
      // §85 — what we would PUBLISH, which during the pre-order window is the
      // shelf plus the morning's allowance rather than the shelf alone. Outside
      // the window this is the same floored figure sellableAt returned.
      const qty = channelPublish.publishableAt(db, storeId, productId, { channel: 'meituan' });
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
