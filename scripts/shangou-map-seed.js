// Seed/refresh meituan_product_map for a 闪购 store from its LIVE catalogue: each
// 闪购 sku is mapped to the roots product that shares its 货号 (闪购 sourceFoodCode
// === products.sku). A map row (sync_enabled=1) is what makes a roots stock change
// enqueue a push, so this is what "activates" auto stock-sync. Idempotent — safe to
// re-run after adding products. The daemon still resolves the exact 闪购 skuId by 货号
// at push time, so the mapping only needs to mark which products are on 闪购.
//
//   node scripts/shangou-map-seed.js [storeCode]   (default: yuexiu)

'use strict';
const db = require('../database');
const { ShangouBrowser } = require('../lib/shangou-browser');

(async () => {
  const storeCode = process.argv[2] || 'yuexiu';
  const store = db.prepare('SELECT id FROM retail_stores WHERE code=?').get(storeCode);
  if (!store) { console.error('no such store:', storeCode); process.exit(1); }

  const b = new ShangouBrowser(storeCode);
  await b.connect();
  if (!(await b.isLoggedIn())) { console.error('闪购 Chrome not logged in'); process.exit(2); }
  const prods = await b.getProducts();

  // Map against store_products (the canonical retail catalogue the stock/order/
  // enqueue paths all use) — NOT the legacy `products` kitchen table, whose ids
  // diverge from store_products for some SKUs (e.g. Hummus 1-10 = products.id 17
  // but store_products.id 360), which silently mis-keyed the map. Prefer the
  // active row when a SKU has twins. [[reference_gzgrocery_skumap_twin_collision]]
  const findProd = db.prepare(
    'SELECT id, name_cn FROM store_products WHERE sku = ? ORDER BY is_active DESC, id ASC LIMIT 1'
  );
  const upsert = db.prepare(`
    INSERT INTO meituan_product_map (retail_store_id, product_id, store_code, meituan_name, sync_enabled)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(retail_store_id, product_id, spec_key)
    DO UPDATE SET meituan_name = excluded.meituan_name, sync_enabled = 1, updated_at = CURRENT_TIMESTAMP
  `);

  let mapped = 0; const skipped = []; const seen = new Set();
  for (const p of prods) {
    if (!p.code || p.code === '-') { skipped.push(`${p.spuName} (no 货号)`); continue; }
    const rp = findProd.get(p.code);
    if (!rp) { skipped.push(`${p.spuName} (货号 ${p.code} not in roots)`); continue; }
    if (seen.has(rp.id)) continue;
    seen.add(rp.id);
    upsert.run(store.id, rp.id, storeCode, p.spuName);
    mapped++;
  }

  console.log(`mapped ${mapped} products for ${storeCode}`);
  if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.slice(0, 25).join('; ')}`);
  await b.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
