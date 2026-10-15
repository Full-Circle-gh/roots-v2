// What a product row looks like for the shop and the mini app: the column set
// each screen pulls (product page, list, card, home), the sold-out policy and
// its pre-order questions, and the row clean-up (photo link, nutrition and page
// design, a variant's borrowed photo). Moved out of routes/retail.js unchanged
// (decisions §477). Pinned by scripts/test_product_card_rows.js and
// scripts/test_preorder_everywhere.js.
'use strict';

const inventory = require('./inventory');
const { tdb } = require('./tenant-db');
const RETAIL_PRODUCT_COLS = `
  p.id, p.name_en, p.name_cn, p.sku, p.category, p.top_category, p.subcategory,
  p.weight AS size, p.barcode,
  p.sell_price AS price,
  p.compare_at_price,
  -- Stock surfaced to the mini-app: the SUM of per-store physical_qty across the
  -- stores that are OPEN (inventory.sellableStockSql — closed shops are invisible
  -- to a customer, so their shelves can't make a product look buyable). That's the
  -- inventory the /retail-admin per-store grid edits; the legacy
  -- products.stock_qty column is the fallback only for a product never stocked
  -- per-store, so a newly-added one doesn't silently flip to OOS. When every open
  -- store shows 0 this returns 0 → shop.js marks the row as outOfStock and the
  -- "in stock only" filter hides it.
  ${inventory.sellableStockSql('p.id', 'p.stock_qty')} AS stock,
  p.sort_order AS display_order,
  p.description_en, p.description_cn, p.description_format,
  p.free_of, p.tags, p.ship_modes, p.ship_from_supplier, p.image_data, p.image_url,
  p.image_aspect,
  p.nutrition,
  p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,
  p.description_blocks, p.use_block_design, p.page_template,
  p.colophon_character, p.colophon_tagline_en, p.colophon_tagline_cn,
  p.flash_price, p.flash_starts_at, p.flash_ends_at,
  p.flash_stock_limit, p.flash_sold, p.no_coupon_on_flash,
  p.variant_group_id, p.variant_label, p.variant_label_cn, p.variant_sort,
  p.variant_noun_en, p.variant_noun_cn,
  p.low_stock_threshold,
  p.is_batch_made,
  p.oos_policy,
  p.supplier_paused,
  p.bundle_items,
  p.updated_at
`;

// Effective out-of-stock policy for a catalog row, resolving the legacy
// is_batch_made flag and NULL defaults to one of three concrete modes:
//   'strict'        → not orderable in ANY region once stock ≤ 0 (default).
//   'backorder_gz'  → out-of-city shoppers may still pre-order; only same-day
//                     Guangzhou stays hard-blocked.
//   'backorder_all' → §128: EVERY shopper may pre-order, same-day Guangzhou
//                     included. The order that results cannot ship off the
//                     shelf, so it PARKS as 'awaiting_restock' with its
//                     delivery window cleared — see the pre-order park in
//                     POST /orders. The difference from 'backorder_gz' is one
//                     question only: may the local run sell past zero.
// An explicit oos_policy always wins; a blank policy falls back to the legacy
// rule (batch meals = backorder, everything else = strict) so nothing that
// relied on is_batch_made regresses before operators opt products in.
function effectiveOosPolicy(p) {
  // Supplier-direct items carry no inventory of ours — the supplier is the
  // source of truth, so they're always orderable regardless of stock. This
  // wins over any stored policy (and auto-applies to existing supplier products
  // without a re-save). Pausing one is the supplier_paused switch, handled at
  // the order gate, not here.
  if (p && p.ship_from_supplier) return 'always';
  const pol = (p && p.oos_policy) || '';
  if (pol === 'always' || pol === 'backorder_gz' || pol === 'backorder_all' || pol === 'strict') return pol;
  return (p && p.is_batch_made) ? 'backorder_gz' : 'strict';
}

// Does this policy keep a sold-out row ORDERABLE for the shoppers it covers?
// The two backorder modes differ in WHO they cover, never in whether the row
// survives zero, so every "may this be pre-ordered at all" test reads this and
// the region question is asked separately (isLocalRunPreorder below). Written
// as a function rather than spelled out at each site because there are eleven
// of them: a twelfth that forgets the new mode reads as a dead SOLD OUT with
// nothing thrown, which is the failure §80 spent three rounds chasing.
function isPreorderPolicy(pol) {
  return pol === 'backorder_gz' || pol === 'backorder_all';
}

// …and the region half: may a shopper ON THE SAME-DAY LOCAL RUN pre-order it?
// Only 'backorder_all' says yes. 'backorder_gz' is refused for them by
// localPreorderLine, which is why the clients draw a dead SOLD OUT there.
function isLocalRunPreorder(pol) {
  return pol === 'backorder_all';
}

// List/grid variant of the column set: NEVER pull the heavy inline base64 photo.
// A data: URI is collapsed to the tiny literal 'data:' marker INSIDE SQLite, so
// the multi-MB blob never enters Node's heap or the JSON payload — the list
// endpoints below then swap that marker for a streamed-image URL via
// lazifyProductImage(). Plain-URL image_data (small) passes through untouched.
// This is the single biggest shop / mini-app load win: a 50-row grid drops from
// several MB to a few hundred KB. Detail pages (PDP) keep RETAIL_PRODUCT_COLS so
// they still ship the full photo and render without an extra round-trip.
const RETAIL_PRODUCT_COLS_LIST = RETAIL_PRODUCT_COLS
  .replace(
    'p.image_data, p.image_url',
    "CASE WHEN p.image_data LIKE 'data:%' THEN 'data:' ELSE p.image_data END AS image_data, p.image_url"
  )
  // Grid cards never render the PDP page design / nutrition table / colophon, yet
  // these columns were shipping for EVERY row — description_blocks alone is a
  // multi-KB page-design JSON per product, so a 500-row shop pull carried megabytes
  // of detail-page content the grid throws away. Drop them from the list set; the
  // PDP (GET /products/:id) still ships them via the full RETAIL_PRODUCT_COLS.
  // hydrateNutrition() already null-safes the missing nutrition/description_blocks.
  // NB: this file is CRLF — match the column tokens only, not the line ending, so
  // the leftover indentation (harmless SQL whitespace) is all that remains.
  .replace('p.nutrition,', '')
  .replace('p.description_blocks, p.use_block_design, p.page_template,', '')
  .replace('p.colophon_character, p.colophon_tagline_en, p.colophon_tagline_cn,', '')
  // has_options: 0/1 flag so a card grid knows the product needs a customer
  // choice (e.g. dressing). The shop's quick-add reads it to route to the PDP
  // (where the choice is made + required-validated) instead of adding straight
  // to cart. Indexed lookup (idx_retail_opts_product) → cheap per row.
  + ', EXISTS(SELECT 1 FROM retail_product_options o WHERE o.product_id = p.id) AS has_options';

// Leanest set for the shop's full-catalogue grid pull (slim=1). The card renders
// only name / price / image / badge / stock / variant — never the long
// description, tagline or keywords — so drop those too. ~2.4 KB/row saved → a
// 97-product shop pull drops from ~350 KB to ~115 KB. Shared list consumers that
// DO render copy (home product_grid blocks) keep the fuller RETAIL_PRODUCT_COLS_LIST.
const RETAIL_PRODUCT_COLS_CARD = RETAIL_PRODUCT_COLS_LIST
  .replace('p.description_en, p.description_cn, p.description_format,', '')
  .replace('p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,', '');

// Home page set (lean=1). The home renders block-renderer cards that show a
// short tagline caption but NEVER the full rich-HTML description — yet the
// fuller LIST set shipped description_en/cn for every row, and 99/100 Roots
// products are format:'rich'. A 100-row home pull measured 1.28 MB, 1.2 MB of
// it descriptions the home throws away (it only used them as an 80-char tagline
// fallback). Drop the heavy descriptions + keywords but KEEP tagline_en/cn so
// grid captions survive. The PDP (GET /products/:id) still ships the full
// description via the complete RETAIL_PRODUCT_COLS. ~1.2 MB → ~80 KB per 100.
const RETAIL_PRODUCT_COLS_HOME = RETAIL_PRODUCT_COLS_LIST
  .replace('p.description_en, p.description_cn, p.description_format,', '')
  .replace('p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,', 'p.tagline_en, p.tagline_cn,');

// Swap a list row's heavy inline base64 primary photo for a tiny streamed-image
// URL the mini-app lazy-loads + caches (see GET /api/retail/products/:id/image).
// Pairs with RETAIL_PRODUCT_COLS_LIST (which already collapsed the blob to a
// 'data:' marker). ABSOLUTE URLs so the live mini-app renders them without
// absUrl(). Mutates + returns the row; drops the helper-only updated_at /
// has_group_image fields. baseUrl = `${req.protocol}://${req.get('host')}`.
// thumbW (optional): when set, the streamed-image URL carries &w=<thumbW> so the
// image route returns a downscaled JPEG/PNG instead of the full-res original —
// the shop grid (slim=1) uses this so a 97-card page pulls ~kB thumbnails, not MB.
function lazifyProductImage(r, baseUrl, thumbW) {
  const hasGroupImg = r.has_group_image;
  delete r.has_group_image;
  const wq = thumbW ? `&w=${thumbW}` : '';
  if (typeof r.image_data === 'string' && /^data:/i.test(r.image_data)) {
    r.image_data = `${baseUrl}/api/retail/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}${wq}`;
  } else if (!r.image_data && !r.image_url && hasGroupImg) {
    // Variant with no photo of its own — point at its image route, which
    // resolves a sibling's photo ("fallback when empty").
    r.image_data = `${baseUrl}/api/retail/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}${wq}`;
  }
  delete r.updated_at;
  return r;
}

// Parse JSON-string columns (nutrition, description_blocks) into objects for
// the client. Drops empty values to null so the mini-app can `wx:if` cleanly.
function hydrateNutrition(row) {
  if (!row) return row;
  if (typeof row.nutrition === 'string' && row.nutrition.trim()) {
    try {
      const n = JSON.parse(row.nutrition);
      row.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null;
    } catch { row.nutrition = null; }
  } else {
    row.nutrition = null;
  }
  if (typeof row.description_blocks === 'string' && row.description_blocks.trim()) {
    try {
      const b = JSON.parse(row.description_blocks);
      row.description_blocks = (Array.isArray(b) && b.length) ? b : null;
    } catch { row.description_blocks = null; }
  } else {
    row.description_blocks = null;
  }
  // Clean boolean for the mini-app: "Local only" = Guangzhou same-city delivery
  // only (no air/land). Lets the storefront badge it + block out-of-GZ carts.
  if ('ship_modes' in row) {
    row.local_only = /(^|,)\s*local\s*(,|$)/.test(String(row.ship_modes || '').toLowerCase());
    delete row.ship_modes;
  }
  return row;
}

// ── Variant photo inheritance ("fallback when empty") ──────────────────────
// Variants are independent product rows linked by variant_group_id. A variant
// with NO photo of its own should show a sibling's photo by default — so all
// sizes of one product look identical until a variant gets its own upload.
// We resolve this at READ time (never copy into the row), so the variant stays
// truly "empty" in the DB and keeps tracking the sibling. Preference order:
// the variant's own photo → the group owner (id = variant_group_id) → lowest
// variant_sort/id among active siblings that have a photo.
//
// hasImageFallbackSql() — the SQL flag for the same fallback — lives in
// lib/product-image-sql.js (required at the top of this file), so the till's
// counter catalogue can use it too (§289).
// Resolve the effective primary photo (a data: URI or plain URL string), with
// sibling fallback for variants. Returns null when neither this row nor any
// sibling has one. Used by the two /image byte-streaming endpoints.
function resolveProductImage(id) {
  const row = tdb().prepare('SELECT image_data, image_url, variant_group_id FROM store_products WHERE id = ?').get(id);
  if (!row) return null;
  if (row.image_data) return row.image_data;
  if (row.image_url)  return row.image_url;
  if (!row.variant_group_id) return null;
  const sib = tdb().prepare(
    `SELECT image_data, image_url FROM store_products
      WHERE variant_group_id = ? AND COALESCE(is_active, 1) = 1
        AND ((image_data IS NOT NULL AND image_data != '')
          OR (image_url IS NOT NULL AND image_url != ''))
      ORDER BY (id = variant_group_id) DESC, COALESCE(variant_sort, 0) ASC, id ASC
      LIMIT 1`
  ).get(row.variant_group_id);
  return sib ? (sib.image_data || sib.image_url || null) : null;
}

module.exports = {
  RETAIL_PRODUCT_COLS, RETAIL_PRODUCT_COLS_LIST, RETAIL_PRODUCT_COLS_CARD, RETAIL_PRODUCT_COLS_HOME,
  effectiveOosPolicy, isPreorderPolicy, isLocalRunPreorder,
  lazifyProductImage, hydrateNutrition, resolveProductImage,
};
