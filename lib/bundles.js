// Bundle products: reading and storing a bundle's recipe, the parts as the
// shop shows them, a bundle's stock made from its parts, the stock lines a
// cart reserves (bundles expanded into parts, stock-backed extras added), and
// a bundle's derived cost on the admin rows. Moved out of routes/retail.js
// unchanged (decisions §477). Pinned by scripts/test_bundle_stock_cost.js.
'use strict';

const inventory = require('./inventory');
const { tdb } = require('./tenant-db');
const { hasImageFallbackSql } = require('./product-image-sql');
const { bundleOwnsProductCost, bundleUnitCostYuan } = require('./bundle-cost');

// ── BUNDLE PRODUCTS (store_products.bundle_items) ──────────────────────────
// A bundle product is a real store_products row whose `bundle_items` JSON lists
// the component products it's made of: [{ id, qty }] (per-unit quantities). It
// looks/sells like one product — one card, one PDP, one cart line, one fixed
// price (the row's own sell_price). Behind the scenes it deducts COMPONENT
// stock at checkout (see expandStockLines) and shows a "what's inside" list.
// This is a SEPARATE concept from the legacy "buy together" `bundle` upsell
// above — don't conflate the two columns.
//
// parseBundleItems → the clean [{id, qty}] array (or [] when not a bundle).
function parseBundleItems(v) {
  if (!v) return [];
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const id = parseInt(it && (it.id != null ? it.id : it.product_id), 10);
    let qty  = parseInt(it && it.qty, 10);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    seen.add(id);
    out.push({ id, qty });
  }
  return out;
}
// sanitizeBundleItems → the JSON string to store (or null to clear / not a
// bundle). A component can't be the bundle itself. Caps at 20 components.
function sanitizeBundleItems(input, selfId = null) {
  const items = parseBundleItems(input)
    .filter(c => c.id !== Number(selfId))
    .slice(0, 20);
  return items.length ? JSON.stringify(items) : null;
}

function resolveBundleComponents(v) {
  const comps = parseBundleItems(v);
  if (!comps.length) return [];
  const ids = comps.map(c => c.id);
  const ph  = ids.map(() => '?').join(',');
  const rows = tdb().prepare(
    `SELECT sp.id, sp.name_en, sp.name_cn, sp.sku, sp.weight AS size, sp.sell_price AS price,
            COALESCE(${inventory.sellableStockSql('sp.id', 'sp.stock_qty')}, 0) AS stock,
            sp.is_published, sp.is_active, sp.updated_at,
            ${hasImageFallbackSql('sp')} AS has_image_data
       FROM store_products sp
      WHERE sp.id IN (${ph})`
  ).all(...ids);
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = [];
  for (const c of comps) {
    const r = byId.get(c.id);
    if (!r) continue;
    out.push({
      id: r.id, qty: c.qty, name_en: r.name_en, name_cn: r.name_cn,
      sku: r.sku, size: r.size, price: r.price,
      stock: r.stock,
      available: !!(r.is_published && (r.is_active == null || r.is_active === 1)),
      image_data: r.has_image_data
        ? `/api/retail/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}`
        : null,
    });
  }
  return out;
}
// expandStockLines → turn resolved cart lines into the flat [{product_id, qty}]
// list the inventory layer reserves/routes on, EXPANDING any bundle line into
// its component demand (component qty × units bought) and aggregating repeats.
// A component bought both standalone and via a bundle sums correctly. Non-bundle
// lines pass straight through. `r.product.bundle_items` must be selected.
function expandStockLines(resolvedLines) {
  const agg = new Map();
  const add = (id, qty) => { const pid = parseInt(id, 10); if (pid) agg.set(pid, (agg.get(pid) || 0) + qty); };
  for (const r of resolvedLines) {
    // Supplier-direct items hold no inventory of ours — never reserve, route on,
    // or refuse them for stock. They contribute zero demand to every store.
    if (r.product && r.product.ship_from_supplier) continue;
    const comps = parseBundleItems(r.product && r.product.bundle_items);
    if (comps.length) {
      for (const c of comps) add(c.id, c.qty * r.qty);
    } else {
      add(r.product.id, r.qty);
    }
    // Stock-backed paid extras: each chosen option that carries a
    // stock_product_id contributes its own demand (one add-on per unit
    // bought), so the add-on's inventory is reserved/committed/released right
    // alongside the main product. Plain (no-stock) option picks carry no
    // stock_product_id and are ignored here.
    for (const o of (r.options || [])) {
      if (o.stock_product_id) add(o.stock_product_id, r.qty);
    }
  }
  return [...agg.entries()].map(([product_id, qty]) => ({ product_id, qty }));
}
// Decorate a storefront list / PDP row IN PLACE: flag bundles, override the
// displayed `stock` with the assemble-from-components figure, and (PDP only)
// attach the "what's inside" component cards. The raw recipe JSON is stripped
// so it never reaches the customer. Cheap no-op for normal products.
function decorateBundleRow(r, { withComponents = false } = {}) {
  if (!r) return r;
  const recipe = parseBundleItems(r.bundle_items);
  if (!recipe.length) { r.is_bundle = false; delete r.bundle_items; return r; }
  r.is_bundle = true;
  const comps = resolveBundleComponents(r.bundle_items);
  let bstock = 0, worth = 0;
  if (comps.length === recipe.length) {
    let min = Infinity;
    for (const c of comps) {
      worth += (Number(c.price) || 0) * c.qty;   // "if bought separately" total
      if (!c.available) { min = 0; continue; }    // still tally worth for the SAVE badge
      min = Math.min(min, Math.floor((Number(c.stock) || 0) / c.qty));
    }
    bstock = Number.isFinite(min) ? min : 0;
  }
  r.stock = bstock;                       // shop card "sold out" honesty
  // The components' combined regular price, surfaced only when it actually beats
  // the bundle's own fixed price — lets the storefront + checkout show a "save ¥X"
  // badge on the bundle line. Cheap: comps were already resolved for stock above.
  const bundlePrice = Number(r.sell_price ?? r.price) || 0;
  if (worth > bundlePrice) r.bundle_worth = Math.round(worth * 100) / 100;
  if (withComponents) r.bundle_components = comps;
  delete r.bundle_items;                  // never ship the raw recipe
  return r;
}

// Overwrite an ADMIN product row's `unit_cost` with the figure derived from its
// components, for a row that is a bundle. Cheap no-op for everything else.
//
// WHY THIS IS A DECORATION AND NOT A STORED COLUMN. Every other derived cost in
// the system is CASCADED into store_products.unit_cost (lib/recipe-rollup.js),
// because its inputs — an ingredient price, a recipe line — move behind trigger
// points that call fireRecompute(). A bundle's inputs are OTHER PRODUCTS' unit
// costs, and those move from two writers that have no such trigger: purchase-
// order receiving (routes/retail-purchasing.js) and the hand-edit in this
// file's own PATCH. A stored bundle figure would therefore be stale from the
// next delivery until something unrelated happened to fire a recompute, and
// stale is the one failure mode a cost column must not have. Derived on read,
// it is right on every read, and it also cannot fight the cascade for ownership
// of a column two other writers already share.
//
// Applied to the three ADMIN reads (list, single, PATCH response) — the whole
// of what the operator's Products screen ever sees, so both the Margin column
// and the editor's Cost field get the same figure from the same place. NOT
// applied to the storefront rows decorateBundleRow() handles: a customer is
// never shown a cost.
function applyBundleCost(row) {
  if (!row) return row;
  try {
    if (bundleOwnsProductCost(tdb(), row.id)) row.unit_cost = bundleUnitCostYuan(tdb(), row.id);
  } catch (e) {
    // A cost is not worth a 500 on the catalogue. Leaving the stored column
    // (blank, on every bundle today) is the same em dash a blocked derivation
    // would have produced anyway.
    console.error('[bundle-cost] could not derive cost for product', row && row.id, e && e.message);
  }
  return row;
}

module.exports = {
  parseBundleItems, sanitizeBundleItems, resolveBundleComponents, expandStockLines,
  decorateBundleRow, applyBundleCost,
};
