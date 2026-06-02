const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const { normalizeCategoryPair } = require('../lib/category-tree');
const router = express.Router();

const PRODUCT_COLS = `
  p.id, p.name_en, p.name_cn, p.sku, p.category, p.top_category, p.subcategory, p.recipe_id, p.status,
  p.sell_price, p.weight, p.barcode,
  p.description_en, p.description_cn, p.free_of,
  p.image_data, p.images, p.label_data,
  p.notes, p.created_at, p.updated_at,
  p.external_id, p.sort_order, p.stock_qty, p.tags,
  p.variant_group_id, p.variant_label, p.variant_sort,
  p.is_market, p.is_restock_only, p.is_published,
  p.ship_modes, p.needs_ice_pack, p.is_batch_made,
  p.nutrition,
  p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,
  p.description_blocks, p.use_block_design, p.bundle,
  p.colophon_character, p.colophon_tagline_en, p.colophon_tagline_cn,
  r.name_en AS recipe_name
`;

// Lightweight column set for the LIST endpoint. The table/grid views never
// render the heavy text/blob fields — most importantly image_data (a base64
// 1800px JPEG per row) and label_data (a second base64 image), plus
// description_blocks / nutrition / descriptions — so shipping them for every
// product made the page payload balloon to megabytes. Here we drop them and
// expose only a has_image flag; the row's image is fetched lazily from
// GET /api/products/:id/image instead. The full GET /api/products/:id still
// returns everything (PRODUCT_COLS) for the edit form and detail page.
const PRODUCT_LIST_COLS = `
  p.id, p.name_en, p.name_cn, p.sku, p.category, p.top_category, p.subcategory, p.recipe_id, p.status,
  p.sell_price, p.weight, p.barcode,
  p.notes, p.created_at, p.updated_at,
  p.external_id, p.sort_order, p.stock_qty, p.tags,
  p.variant_group_id, p.variant_label, p.variant_sort,
  p.is_market, p.is_restock_only, p.is_published,
  p.ship_modes, p.needs_ice_pack, p.is_batch_made,
  (p.image_data IS NOT NULL AND p.image_data != '') AS has_image,
  r.name_en AS recipe_name
`;

// GET all products (with linked recipe name for the table view)
router.get('/api/products', requireAuth, requirePermission('products'), (req, res) => {
  const { search, category, status, deleted_only, count_only } = req.query;
  // Filter mode:
  //  - default            → active products (is_active=1)
  //  - ?deleted_only=1    → trash view (is_active=0) for the restore UI
  const onlyDeleted = deleted_only === '1' || deleted_only === 'true';
  // count_only=1 returns just {count: N} — the dashboard KPI tile uses this
  // so it doesn't have to wait on the full (slim-but-still-paginated) list.
  if (count_only === '1' || count_only === 'true') {
    let cq = `SELECT COUNT(*) AS n FROM products p WHERE COALESCE(p.is_active, 1) = ${onlyDeleted ? 0 : 1}`;
    const cp = [];
    if (search) { cq += ' AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)'; const s = `%${search}%`; cp.push(s,s,s); }
    if (category) { cq += ' AND p.category = ?'; cp.push(category); }
    if (status)   { cq += ' AND p.status = ?';   cp.push(status); }
    return res.json({ success: true, count: db.prepare(cq).get(...cp).n });
  }
  let q = `SELECT ${PRODUCT_LIST_COLS} FROM products p
           LEFT JOIN recipes r ON r.id = p.recipe_id
           WHERE COALESCE(p.is_active, 1) = ${onlyDeleted ? 0 : 1}`;
  const params = [];
  if (search) {
    q += ' AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (category) { q += ' AND p.category = ?'; params.push(category); }
  if (status)   { q += ' AND p.status = ?';   params.push(status); }
  q += onlyDeleted ? ' ORDER BY p.updated_at DESC' : ' ORDER BY p.name_en';
  const rows = db.prepare(q).all(...params);
  // Replace the (omitted) base64 image with a tiny URL the browser can lazy-
  // load + cache. ?v=updated_at busts the cache when the photo changes. The
  // front-end renders image_data straight into <img src>, so it doesn't care
  // whether the value is a data: URI (detail view) or this URL (list view).
  for (const r of rows) {
    r.image_data = r.has_image
      ? `/api/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}`
      : null;
    delete r.has_image;
  }
  res.json({ success: true, data: rows });
});

// GET /api/products/:id/image — stream a product's stored photo as real image
// bytes so the list endpoint can ship a small URL per row instead of an inline
// base64 blob. image_data is a data: URI (data:image/jpeg;base64,...): decode
// and send it with a long cache window (the ?v=updated_at query busts it when
// the photo changes). NOT filtered by is_active so Trash-view thumbnails still
// resolve. Gated by the same `products` permission as the list it serves.
router.get('/api/products/:id/image', requireAuth, requirePermission('products'), (req, res) => {
  const row = db.prepare('SELECT image_data FROM products WHERE id = ?').get(req.params.id);
  const data = row && row.image_data;
  if (!data) return res.status(404).end();
  const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(data);
  if (!m) return res.redirect(String(data));   // stored as a plain URL, not a data: URI
  const mime = m[1] || 'application/octet-stream';
  const buf  = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(buf);
});

// POST /api/products/:id/restore — un-soft-delete. Flips is_active back to
// 1 so a previously "deleted" product returns to the list. Used by the trash
// view to undo accidental deletes. The product keeps its old id, sku, sales
// history, variant_group_id — nothing is lost beyond is_active flipping.
router.post('/api/products/:id/restore', requireAuth, requirePermission('products'), (req, res) => {
  const row = db.prepare('SELECT id, name_en, is_active FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found · 未找到' });
  if (row.is_active === 1) return res.json({ success: true, already: true });
  db.prepare('UPDATE products SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'restore', 'product', req.params.id, { name_en: row.name_en }, req.ip);
  res.json({ success: true });
});

// GET /api/products/by-barcode/:code — instant lookup by barcode for the
// tablet POS. Trims/normalizes the input (barcode guns sometimes append
// trailing whitespace from the Enter keystroke). Soft-deleted products are
// excluded. Returns just the fields the POS needs to render a cart line.
router.get('/api/products/by-barcode/:code', requireAuth, (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'barcode required' });
  // Allow the lookup for any authenticated user with EITHER `pos` OR
  // `products` permission — admins always have access. (The Phase-1 vendor
  // role gets `pos` only; the kitchen team has `products` already.)
  if (req.user.role !== 'admin' && !req.permissions?.pos && !req.permissions?.products) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const row = db.prepare(`
    SELECT id, name_en, name_cn, sku, barcode, category, sell_price,
           stock_qty, status, image_data, variant_label,
           is_market, is_restock_only
      FROM products
     WHERE barcode = ? AND COALESCE(is_active, 1) = 1
     LIMIT 1
  `).get(code);
  if (!row) return res.status(404).json({ error: 'not_found', code });
  res.json({ success: true, data: row });
});

// GET single product. When the product is linked to a recipe we also
// derive aggregated allergens from the recipe's ingredients and return
// them in derived_allergens — so the form can show "from recipe (auto)"
// labels that stay current as ingredients change. No caching: the join
// is cheap (a recipe has maybe 5-15 ingredients) and we never have to
// worry about stale data.
router.get('/api/products/:id', requireAuth, requirePermission('products'), (req, res) => {
  const row = db.prepare(
    `SELECT ${PRODUCT_COLS} FROM products p
     LEFT JOIN recipes r ON r.id = p.recipe_id
     WHERE p.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found · 未找到' });
  // Buy-together bundle is stored as JSON text; parse so the editor receives
  // an object it can pre-fill ({title_en,title_cn,ids,price,voucher}).
  if (typeof row.bundle === 'string' && row.bundle.trim()) {
    try { row.bundle = JSON.parse(row.bundle); } catch { row.bundle = null; }
  } else {
    row.bundle = null;
  }
  // Photo gallery — stored as a JSON array of image srcs (data-URI or URL).
  // Element [0] mirrors image_data (the primary). Hand the detail page a real
  // array; fall back to the single image_data so legacy products still show.
  try { row.images = row.images ? JSON.parse(row.images) : []; } catch { row.images = []; }
  if (!Array.isArray(row.images)) row.images = [];
  if (!row.images.length && row.image_data) row.images = [row.image_data];
  // Derive recipe-driven info if linked. Each ingredient.allergens is a
  // free-text comma string ("nuts, soy") — split, dedupe, sort.
  let derived = { allergens: [], ingredient_count: 0 };
  // Inline the linked recipe so the detail page doesn't need a second
  // round-trip to /api/recipes/:id. Only the fields _loadProductCtx
  // actually consumes (name_en, servings, ingredients-with-master_cost,
  // costData) — recipe steps and the recipe's own base64 image_data are
  // omitted to keep the payload small.
  let recipe = null;
  if (row.recipe_id) {
    const ings = db.prepare(`
      SELECT ing.name_en, ing.name_cn, ing.allergens,
             ri.ingredient_id, ri.sku, ri.qty, ri.unit,
             ing.cost_per_unit AS master_cost
        FROM recipe_ingredients ri
        LEFT JOIN ingredients ing ON ing.id = ri.ingredient_id
       WHERE ri.recipe_id = ?
         AND (ing.id IS NULL OR COALESCE(ing.is_active, 1) = 1)
       ORDER BY ri.sort_order
    `).all(row.recipe_id);
    derived.ingredient_count = ings.length;
    const set = new Set();
    for (const i of ings) {
      if (!i.allergens) continue;
      for (const a of String(i.allergens).split(',')) {
        const t = a.trim().toLowerCase();
        if (t) set.add(t);
      }
    }
    derived.allergens = [...set].sort();
    // Recipe header + cost block — small payload, no steps, no image.
    const recRow = db.prepare(
      'SELECT id, name_en, name_cn, servings, batch_size, serving_size FROM recipes WHERE id = ? AND is_active = 1'
    ).get(row.recipe_id);
    if (recRow) {
      const costData = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(row.recipe_id) || null;
      recipe = { ...recRow, ingredients: ings, costData };
    }
  }
  // Sibling variants — the other products that share this row's
  // variant_group_id. The form uses these to render the "Other variants"
  // chips. Empty array if the product is standalone.
  //
  // Lazy-load the sibling thumbnails: select a has_image flag instead of
  // pulling the full base64 image_data for every sibling. A product with
  // five size variants was otherwise shipping six heavy images on every
  // detail open. The chip image is rendered via <img src=...> so a URL
  // works in its place; the existing /api/products/:id/image route streams
  // the bytes when the browser actually requests them.
  let siblings = [];
  if (row.variant_group_id) {
    siblings = db.prepare(`
      SELECT id, name_en, name_cn, sku, sell_price, stock_qty,
             variant_label, variant_sort, status, updated_at,
             (image_data IS NOT NULL AND image_data != '') AS has_image
        FROM products
       WHERE variant_group_id = ? AND id != ? AND COALESCE(is_active, 1) = 1
       ORDER BY COALESCE(variant_sort, 0), variant_label, name_en
    `).all(row.variant_group_id, row.id);
    for (const s of siblings) {
      s.image_data = s.has_image
        ? `/api/products/${s.id}/image?v=${encodeURIComponent(s.updated_at || '')}`
        : null;
      delete s.has_image;
    }
  }
  res.json({ success: true, data: { ...row, derived, siblings, recipe } });
});

// POST /api/products/variants/group — create a new variant group from a
// list of product ids (with optional per-product labels). The first id
// in the list "owns" the group_id (its current id is reused so we get a
// stable, predictable number — easier to debug). Existing group memberships
// are overwritten — products can only be in one group at a time.
router.post('/api/products/variants/group', requireAuth, requirePermission('products'), (req, res) => {
  const { ids, labels } = req.body || {};
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 product ids · 至少需要 2 个产品' });
  }
  const cleanIds = ids.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (cleanIds.length < 2) return res.status(400).json({ error: 'Invalid ids · 无效 id' });
  // Group id = first product's id. Stable & predictable.
  const groupId = cleanIds[0];
  const labelMap = labels && typeof labels === 'object' ? labels : {};
  // Variants of one family share a category. The anchor (first id) is the
  // product the group is built from, so members that have no category of their
  // own inherit the anchor's — otherwise a product grouped in as a variant
  // shows up uncategorised even though its siblings sit under, e.g., "Nut
  // Butters". We only fill blanks so a deliberately-different category is kept.
  const anchorCat = (db.prepare('SELECT category FROM products WHERE id = ?').get(groupId) || {}).category || null;
  try {
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE products SET variant_group_id = ?, variant_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const setCat = db.prepare("UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (category IS NULL OR TRIM(category) = '')");
      for (const id of cleanIds) {
        const lbl = (labelMap[id] || '').toString().trim() || null;
        upd.run(groupId, lbl, id);
        if (anchorCat && id !== groupId) setCat.run(anchorCat, id);
      }
    });
    tx();
    logActivity(req.user.id, req.user.username, 'create_variant_group', 'product', groupId, { ids: cleanIds, labels }, req.ip);
    res.json({ success: true, group_id: groupId, count: cleanIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/products/variants/group/:id — disband a variant group
// (clear group_id + label on every member). Doesn't delete the products.
router.delete('/api/products/variants/group/:id', requireAuth, requirePermission('products'), (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isFinite(groupId) || groupId <= 0) return res.status(400).json({ error: 'invalid group id' });
  const r = db.prepare('UPDATE products SET variant_group_id = NULL, variant_label = NULL, updated_at = CURRENT_TIMESTAMP WHERE variant_group_id = ?').run(groupId);
  logActivity(req.user.id, req.user.username, 'disband_variant_group', 'product', groupId, { affected: r.changes }, req.ip);
  res.json({ success: true, affected: r.changes });
});

// POST /api/products/variants/reorder — set the display order of variants
// within a group. Body { ids:[...] } in the desired order → variant_sort =
// array index (lower = shown first). This is the same column the mini-app
// picker reads, so reordering here is what the customer sees.
router.post('/api/products/variants/reorder', requireAuth, requirePermission('products'), (req, res) => {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = raw.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (ids.length < 2) return res.status(400).json({ error: 'Need at least 2 ids · 至少需要 2 个' });
  try {
    const upd = db.prepare('UPDATE products SET variant_sort = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    logActivity(req.user.id, req.user.username, 'reorder_variants', 'product', ids[0], { ids }, req.ip);
    res.json({ success: true, count: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Body keys the form sends; whitelisted to keep the SQL boring.
const FIELDS = [
  'name_en', 'name_cn', 'sku', 'category', 'top_category', 'subcategory', 'recipe_id', 'status',
  'sell_price', 'weight', 'barcode',
  'description_en', 'description_cn', 'description_format', 'free_of',
  'image_data', 'images', 'label_data', 'notes',
  'external_id', 'sort_order', 'stock_qty', 'tags',
  'variant_group_id', 'variant_label',
  'is_market', 'is_restock_only',
  // Retail / mini-app surface — single toggle, no separate retail price
  // or description. Mini app uses sell_price + description_en/cn directly.
  'is_published',
  // Warehouse / packing flag. ship_modes is a csv subset of {'air','land'}
  // — items the airline rejects (liquid, lithium, frozen) are 'land' only.
  // (The legacy needs_ice_pack cold-chain flag was retired — anything shipped
  // by air is packed with ice anyway, so it added no signal.)
  'ship_modes',
  // Fresh batch-made flag — short-shelf-life items (fresh meals, wraps) the
  // kitchen makes on a fixed cadence. Gates the outside-GZ "made fresh, ships
  // on the next batch day" notice + promised dates.
  'is_batch_made',
  // Nutrition panel — JSON: { basis_en, basis_cn, rows:[{label_en,label_cn,value}] }
  'nutrition',
  // "Buy together" bundle JSON: { title_en, title_cn, ids:[productId,…], price, voucher }
  'bundle',
  // Mini-app card chrome (bilingual)
  'keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn',
  // Block-based product page body (JSON array of `{id, type, ...data}`)
  'description_blocks',
  // Office toggle (kitchen Description card): when 1, mini-app renders
  // blocks; when 0/null (default), it renders the classic description path.
  'use_block_design',
  // Colophon overrides — blank fields fall back to category-mapped character
  // + default "From Soil to Soul" tagline.
  'colophon_character', 'colophon_tagline_en', 'colophon_tagline_cn',
];

function pickBody(body) {
  const out = {};
  for (const k of FIELDS) {
    if (body[k] === undefined) { out[k] = null; continue; }
    if (k === 'sell_price')              out[k] = parseFloat(body[k]) || 0;
    else if (k === 'is_market')          out[k] = body[k] ? 1 : 0;
    else if (k === 'is_restock_only')    out[k] = body[k] ? 1 : 0;
    else if (k === 'is_published')       out[k] = body[k] ? 1 : 0;
    else if (k === 'use_block_design')   out[k] = body[k] ? 1 : 0;
    else if (k === 'is_batch_made')      out[k] = body[k] ? 1 : 0;
    else if (k === 'description_format') {
      // Only two valid values; default anything else to 'plain'. Mini-app's
      // <rich-text> renders HTML when this is 'rich'; otherwise the front-end
      // splits on \n and "## " headings (the legacy "plain" path).
      out[k] = body[k] === 'rich' ? 'rich' : 'plain';
    }
    else if (k === 'ship_modes') {
      // Accept either a csv string ("air,land") or an array (['air','land']).
      // Normalize to a stable csv with at least one mode; default to 'air,land'.
      const v = body[k];
      let modes = [];
      if (Array.isArray(v)) modes = v;
      else if (typeof v === 'string') modes = v.split(',');
      modes = modes.map(m => String(m).trim().toLowerCase()).filter(m => m === 'air' || m === 'land');
      out[k] = (modes.length ? Array.from(new Set(modes)).join(',') : 'air,land');
    }
    else if (k === 'recipe_id')          out[k] = body[k] ? parseInt(body[k], 10) : null;
    else if (k === 'external_id')        out[k] = body[k] ? parseInt(body[k], 10) : null;
    else if (k === 'sort_order')         out[k] = body[k] != null && body[k] !== '' ? parseInt(body[k], 10) : 0;
    else if (k === 'stock_qty')          out[k] = body[k] != null && body[k] !== '' ? parseInt(body[k], 10) : 0;
    else if (k === 'variant_group_id')   out[k] = body[k] ? parseInt(body[k], 10) : null;
    else if (k === 'nutrition') {
      // Accept either an already-stringified JSON blob or a parsed object;
      // normalize to a canonical JSON string, or null when empty.
      const v = body[k];
      if (v == null || v === '') { out[k] = null; }
      else if (typeof v === 'string') {
        try { const obj = JSON.parse(v); out[k] = obj && (obj.basis_en || obj.basis_cn || (obj.rows || []).length) ? JSON.stringify(obj) : null; }
        catch { out[k] = null; }
      } else if (typeof v === 'object') {
        out[k] = (v.basis_en || v.basis_cn || (v.rows || []).length) ? JSON.stringify(v) : null;
      } else { out[k] = null; }
    }
    else if (k === 'bundle') {
      // Accept object, JSON string, or null. Normalize to a JSON string the
      // mini-app + editor can both read; drop if no product ids are listed.
      const v = body[k];
      let obj = null;
      if (v == null || v === '') obj = null;
      else if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { obj = null; } }
      else if (typeof v === 'object') obj = v;
      if (obj && Array.isArray(obj.ids)) {
        const ids = [...new Set(obj.ids.map(n => parseInt(n, 10)).filter(Number.isFinite))];
        if (ids.length) {
          out[k] = JSON.stringify({
            title_en: (obj.title_en ? String(obj.title_en) : '').trim() || null,
            title_cn: (obj.title_cn ? String(obj.title_cn) : '').trim() || null,
            ids,
            price: Math.max(0, parseFloat(obj.price) || 0),
            voucher: (obj.voucher ? String(obj.voucher) : '').trim() || null,
          });
        } else { out[k] = null; }
      } else { out[k] = null; }
    }
    else if (k === 'images') {
      // Ordered photo gallery — array of image srcs (data-URI or URL), max 8.
      // Stored as a JSON string; null when empty. image_data is kept in sync
      // with element [0] by the PUT/POST handlers (shop cards, orders and the
      // label printer all read image_data, not the gallery).
      const arr = (Array.isArray(body[k]) ? body[k] : []).filter(s => typeof s === 'string' && s).slice(0, 8);
      out[k] = arr.length ? JSON.stringify(arr) : null;
    }
    else if (k === 'description_blocks') {
      // Accept either an already-stringified JSON array or a parsed array;
      // normalize to a canonical JSON string, or null when the array is empty.
      const v = body[k];
      let arr = null;
      if (v == null || v === '') { arr = null; }
      else if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) arr = parsed; } catch { arr = null; }
      } else if (Array.isArray(v)) { arr = v; }
      out[k] = (arr && arr.length) ? JSON.stringify(arr) : null;
    }
    else if (body[k] === '')             out[k] = null;
    else out[k] = body[k];
  }
  return out;
}

// POST create
router.post('/api/products', requireAuth, requirePermission('products'), (req, res) => {
  const p = pickBody(req.body);
  if (!p.name_en) return res.status(400).json({ error: 'name_en required · 英文名称必填' });
  // Validate the 2-level category pair against the live tree.
  const cat = normalizeCategoryPair(p.top_category, p.subcategory, db);
  p.top_category = cat.top; p.subcategory = cat.sub;
  // Keep the legacy freeform `category` column auto-synced to the chosen top
  // category. The operator picker is gone (tree is the only category system),
  // but colophon mapping + any legacy reader still read products.category.
  p.category = cat.top;
  // Keep the primary image_data in sync with the gallery's first photo.
  if ('images' in req.body && !('image_data' in req.body)) {
    const arr = (Array.isArray(req.body.images) ? req.body.images : []).filter(s => typeof s === 'string' && s);
    p.image_data = arr.length ? arr[0] : null;
  }
  try {
    const placeholders = FIELDS.map(() => '?').join(',');
    const result = db.prepare(
      `INSERT INTO products (${FIELDS.join(',')}) VALUES (${placeholders})`
    ).run(...FIELDS.map(f => p[f]));
    logActivity(req.user.id, req.user.username, 'create', 'product', result.lastInsertRowid, { name_en: p.name_en, sku: p.sku }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'SKU already exists · SKU已存在' });
    res.status(500).json({ error: e.message });
  }
});

// PUT update — only writes fields explicitly present in req.body. Fields
// the kitchen product form doesn't carry (stock_qty, sort_order,
// external_id, tags) keep their existing values rather than being wiped
// to null on every save. stock_qty is managed by /api/products/:id/stock-adjust;
// sort_order / external_id come from import; tags come from… nobody. All
// preserved.
// Description fields shared across variants by default: editing the product
// body on one variant auto-propagates to its siblings (same variant_group_id),
// so the operator doesn't have to re-paste the description into Big/Small/etc.
// Per-variant override is still possible: just edit that one variant alone
// — propagation only fires for fields actually included in the request.
const SHARED_DESC_FIELDS = ['description_en', 'description_cn', 'description_format', 'description_blocks', 'use_block_design'];

router.put('/api/products/:id', requireAuth, requirePermission('products'), (req, res) => {
  const existing = db.prepare('SELECT id, variant_group_id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });

  const present = FIELDS.filter(f => f in req.body);
  if (present.length === 0) return res.status(400).json({ error: 'no_fields' });
  const p = pickBody(req.body);
  if ('name_en' in req.body && !p.name_en) return res.status(400).json({ error: 'name_en required · 英文名称必填' });
  // Gallery edits keep the primary image_data in sync with images[0] — the
  // shop grid, order items and label printer all read image_data, not the
  // gallery. An explicit image_data in the same body still wins.
  if ('images' in req.body && !present.includes('image_data')) {
    const arr = (Array.isArray(req.body.images) ? req.body.images : []).filter(s => typeof s === 'string' && s);
    present.push('image_data');
    p.image_data = arr.length ? arr[0] : null;
  }
  // Validate the 2-level category pair. On a partial update we re-validate the
  // MERGED pair (current row + incoming) and always write BOTH columns, so
  // changing the top clears a now-stale sub.
  if ('top_category' in req.body || 'subcategory' in req.body) {
    const cur = db.prepare('SELECT top_category, subcategory FROM products WHERE id = ?').get(req.params.id) || {};
    const top = 'top_category' in req.body ? req.body.top_category : cur.top_category;
    const sub = 'subcategory'  in req.body ? req.body.subcategory  : cur.subcategory;
    const cat = normalizeCategoryPair(top, sub, db);
    p.top_category = cat.top; p.subcategory = cat.sub;
    if (!present.includes('top_category')) present.push('top_category');
    if (!present.includes('subcategory'))  present.push('subcategory');
    // Auto-sync the legacy `category` column to the chosen top category.
    p.category = cat.top;
    if (!present.includes('category')) present.push('category');
  }
  try {
    const setClause = present.map(f => `${f}=?`).join(',') + ',updated_at=CURRENT_TIMESTAMP';
    db.prepare(`UPDATE products SET ${setClause} WHERE id=?`)
      .run(...present.map(f => p[f]), req.params.id);

    const descPresent = present.filter(f => SHARED_DESC_FIELDS.includes(f));
    if (descPresent.length && existing.variant_group_id) {
      const sibSet = descPresent.map(f => `${f}=?`).join(',') + ',updated_at=CURRENT_TIMESTAMP';
      db.prepare(`UPDATE products SET ${sibSet} WHERE variant_group_id=? AND id<>?`)
        .run(...descPresent.map(f => p[f]), existing.variant_group_id, req.params.id);
    }

    logActivity(req.user.id, req.user.username, 'update', 'product', req.params.id, { fields: present }, req.ip);
    res.json({ success: true });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'SKU already exists · SKU已存在' });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/products/:id/store-stocks — list per-store stock rows for one
// product. Used by the 📦 Stock card on the product detail page so the
// user sees Tianhe / Yuexiu / etc. side by side and knows WHICH store
// they're adjusting before they click. Gated by `products` perm (not
// `retail`) so anyone who can view a product can see its inventory.
router.get('/api/products/:id/store-stocks', requireAuth, requirePermission('products'), (req, res) => {
  const productId = parseInt(req.params.id, 10);
  if (!productId) return res.status(400).json({ error: 'bad id' });
  // Active stores only — keep retired/hidden ones off the picker so the
  // user can't accidentally stock something nobody serves anymore.
  const stores = db.prepare(
    `SELECT id, code, name_en, name_cn FROM retail_stores
     WHERE COALESCE(is_active,1) = 1
     ORDER BY COALESCE(sort_order,0), name_en`
  ).all();
  const rows = db.prepare(
    `SELECT store_id, physical_qty, safety_buffer, wechat_quota, meituan_quota, restock_target
     FROM retail_store_stock WHERE product_id = ?`
  ).all(productId);
  const byStore = Object.fromEntries(rows.map(r => [r.store_id, r]));
  const data = stores.map(s => {
    const r = byStore[s.id];
    return {
      store_id: s.id,
      store_code: s.code,
      store_name_en: s.name_en,
      store_name_cn: s.name_cn,
      physical_qty: r?.physical_qty ?? 0,
      safety_buffer: r?.safety_buffer ?? null,
      wechat_quota: r?.wechat_quota ?? null,
      meituan_quota: r?.meituan_quota ?? null,
      restock_target: r?.restock_target ?? null,
      stocked: !!r,
    };
  });
  res.json({ success: true, data });
});

// POST /api/products/:id/store-stocks/:storeId/adjust — adjust per-store
// stock for ONE product at ONE store. Routes through the inventory lib's
// adjustStock so a row lands in retail_stock_ledger (the per-store audit
// trail) AND we also write to activity_log so the general audit feed
// catches it. Body: { delta?, set_to?, reason, notes? } — same shape as
// the legacy global stock-adjust endpoint.
router.post('/api/products/:id/store-stocks/:storeId/adjust', requireAuth, requirePermission('products'), (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const storeId   = parseInt(req.params.storeId, 10);
  if (!productId || !storeId) return res.status(400).json({ error: 'bad ids' });
  const product = db.prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active,1)=1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found · 产品未找到' });
  const store = db.prepare('SELECT id, name_en, name_cn FROM retail_stores WHERE id = ? AND COALESCE(is_active,1)=1').get(storeId);
  if (!store) return res.status(404).json({ error: 'Store not found · 门店未找到' });
  const { delta, set_to, reason, notes } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason required · 必填原因' });
  const existing = db.prepare(
    'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  ).get(storeId, productId);
  const oldQty = parseInt(existing?.physical_qty || 0, 10) || 0;
  let newQty;
  if (set_to != null && set_to !== '') {
    const n = parseInt(set_to, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid set_to · 数值无效' });
    newQty = n;
  } else if (delta != null && delta !== '') {
    const d = parseInt(delta, 10);
    if (!Number.isFinite(d)) return res.status(400).json({ error: 'Invalid delta · 数值无效' });
    newQty = Math.max(0, oldQty + d);
  } else {
    return res.status(400).json({ error: 'delta or set_to required · 需要 delta 或 set_to' });
  }
  if (newQty === oldQty) return res.json({ success: true, physical_qty: newQty, from: oldQty, to: newQty, unchanged: true });
  const inventory = require('../lib/inventory');
  const result = inventory.adjustStock({
    storeId, productId,
    newPhysicalQty: newQty,
    actorUserId: req.user.id,
    note: notes ? String(notes).trim() : null,
    reason: String(reason).trim(),
  });
  logActivity(req.user.id, req.user.username, 'stock_adjust', 'product', productId, {
    name_en: product.name_en,
    store_id: storeId,
    store_name: store.name_cn || store.name_en,
    from: result.oldQty, to: result.newQty, delta: result.delta,
    reason: String(reason).trim(),
    notes: notes ? String(notes).trim() : null,
  }, req.ip);
  res.json({ success: true, physical_qty: result.newQty, from: result.oldQty, to: result.newQty, store_id: storeId });
});

// POST /api/products/:id/stock-adjust — write stock_qty + audit-log the
// change. Body shapes accepted:
//   { delta: N,   reason, notes? }   → increment/decrement by N (can be negative)
//   { set_to: N,  reason, notes? }   → set absolute value (used by the inline list-cell edit)
// Either is allowed; whichever is present wins. Reason is required so the
// activity_log entry tells us WHY ("New batch", "Correction", etc.) — the
// stock_qty column itself doesn't store history, so the log is the trail.
router.post('/api/products/:id/stock-adjust', requireAuth, requirePermission('products'), (req, res) => {
  const { delta, set_to, reason, notes } = req.body || {};
  const existing = db.prepare('SELECT id, name_en, stock_qty FROM products WHERE id = ? AND COALESCE(is_active,1)=1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason required · 必填原因' });
  const oldStock = parseInt(existing.stock_qty || 0, 10) || 0;
  let newStock;
  if (set_to != null && set_to !== '') {
    const n = parseInt(set_to, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid set_to · 数值无效' });
    newStock = n;
  } else if (delta != null && delta !== '') {
    const d = parseInt(delta, 10);
    if (!Number.isFinite(d)) return res.status(400).json({ error: 'Invalid delta · 数值无效' });
    newStock = Math.max(0, oldStock + d);
  } else {
    return res.status(400).json({ error: 'delta or set_to required · 需要 delta 或 set_to' });
  }
  if (newStock === oldStock) return res.json({ success: true, stock_qty: newStock, unchanged: true });
  db.prepare('UPDATE products SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStock, req.params.id);
  logActivity(req.user.id, req.user.username, 'stock_adjust', 'product', req.params.id, {
    name_en: existing.name_en,
    from: oldStock,
    to: newStock,
    delta: newStock - oldStock,
    reason: String(reason).trim(),
    notes: notes ? String(notes).trim() : null,
  }, req.ip);
  res.json({ success: true, stock_qty: newStock, from: oldStock, to: newStock });
});

// DELETE — soft delete (set is_active=0) so waste/restock entries that
// reference this product by id continue to resolve correctly. Hard-delete
// would orphan those rows and break cost lookups.
router.delete('/api/products/:id', requireAuth, requireDelete, requirePermission('products'), (req, res) => {
  const existing = db.prepare('SELECT name_en FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  db.prepare('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'product', req.params.id, { name_en: existing.name_en }, req.ip);
  res.json({ success: true });
});

// POST /api/products/bulk-update — apply one action to many products at once.
// Body: { ids: [int,...], action: string, value: any }
// Actions:
//   set_status            value = 'Active'|'Inactive'|'Seasonal'|'Coming Soon'
//   set_category          value = TOP category name from the tree ('' clears);
//                         also clears subcategory + mirrors into legacy category
//   set_is_market         value = 0|1
//   set_is_restock_only   value = 0|1
//   set_is_published      value = 0|1 — toggles "Show in mini-app shop"
//   delete                value ignored — soft-delete (is_active=0)
// Wrapped in a transaction so partial failure rolls back. Writes one
// activity_log entry summarizing the batch instead of N per-row entries.
router.post('/api/products/bulk-update', requireAuth, requirePermission('products'), (req, res) => {
  const { ids, action } = req.body || {};
  let { value } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids[] required · 缺少 ids' });
  }
  const cleanIds = ids.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (cleanIds.length === 0) return res.status(400).json({ error: 'No valid ids · 无效 ids' });
  // Per-action validation + the prepared statement that will run.
  let stmt, normalized;
  switch (action) {
    case 'set_status': {
      const allowed = new Set(['Active','Inactive','Seasonal','Coming Soon']);
      if (!allowed.has(value)) return res.status(400).json({ error: 'Invalid status · 无效状态' });
      stmt = db.prepare('UPDATE products SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      normalized = value;
      break;
    }
    case 'set_category': {
      // Value is a TOP category name from the live tree (the freeform legacy
      // picker is gone). Validate against the tree; '' / null clears. Setting a
      // top also clears any now-stale subcategory and mirrors into the legacy
      // `category` column so colophon + legacy readers keep working.
      normalized = (value == null || value === '') ? null : normalizeCategoryPair(value, null, db).top;
      stmt = db.prepare('UPDATE products SET top_category = ?, subcategory = NULL, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      break;
    }
    case 'set_is_market': {
      normalized = value ? 1 : 0;
      stmt = db.prepare('UPDATE products SET is_market = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      break;
    }
    case 'set_is_restock_only': {
      normalized = value ? 1 : 0;
      stmt = db.prepare('UPDATE products SET is_restock_only = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      break;
    }
    case 'set_is_published': {
      normalized = value ? 1 : 0;
      stmt = db.prepare('UPDATE products SET is_published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      break;
    }
    case 'delete': {
      stmt = db.prepare('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      normalized = null;
      break;
    }
    default:
      return res.status(400).json({ error: 'Unknown action · 未知操作: ' + action });
  }
  let affected = 0;
  try {
    const tx = db.transaction(() => {
      for (const id of cleanIds) {
        const r = (action === 'delete') ? stmt.run(id)
          : (action === 'set_category') ? stmt.run(normalized, normalized, id)
          : stmt.run(normalized, id);
        if (r.changes > 0) affected += 1;
      }
    });
    tx();
  } catch (e) { return res.status(500).json({ error: e.message }); }
  logActivity(req.user.id, req.user.username, 'bulk_' + action, 'product', null, {
    ids: cleanIds, value: normalized, affected,
  }, req.ip);
  res.json({ success: true, affected, requested: cleanIds.length });
});

// POST bulk import — used by the Products CSV/Excel import wizard. Mirrors the
// shape of /api/sales/bulk: skips invalid rows instead of aborting, returns
// {inserted, updated, skipped, errors[]}. Rows with an existing SKU are
// UPDATED in place; new SKUs (or rows without one) are INSERTED. Recipe links
// are resolved by the recipe's name when supplied as text.
router.post('/api/products/bulk', requireAuth, requirePermission('products'), (req, res) => {
  const rows = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'entries[] required · 数据为空' });

  // Importing reactivates a soft-deleted product if its SKU is reused —
  // matches user expectation of "I'm adding this again".
  const findBySku    = db.prepare('SELECT id FROM products WHERE LOWER(sku) = LOWER(?) LIMIT 1');
  const reactivate   = db.prepare('UPDATE products SET is_active = 1 WHERE id = ?');
  const findRecipe   = db.prepare('SELECT id FROM recipes WHERE LOWER(name_en) = LOWER(?) OR LOWER(name_cn) = LOWER(?) OR LOWER(sku) = LOWER(?) LIMIT 1');
  const insertProd   = db.prepare(`INSERT INTO products
    (name_en,name_cn,sku,category,recipe_id,status,sell_price,weight,barcode,description_en,description_cn,free_of,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateProd   = db.prepare(`UPDATE products SET
    name_en=COALESCE(NULLIF(?,''),name_en),
    name_cn=COALESCE(NULLIF(?,''),name_cn),
    category=COALESCE(NULLIF(?,''),category),
    recipe_id=COALESCE(?,recipe_id),
    status=COALESCE(NULLIF(?,''),status),
    sell_price=COALESCE(?,sell_price),
    weight=COALESCE(NULLIF(?,''),weight),
    barcode=COALESCE(NULLIF(?,''),barcode),
    description_en=COALESCE(NULLIF(?,''),description_en),
    description_cn=COALESCE(NULLIF(?,''),description_cn),
    free_of=COALESCE(NULLIF(?,''),free_of),
    notes=COALESCE(NULLIF(?,''),notes),
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`);

  const stats = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const importTx = db.transaction(() => {
    rows.forEach((r, idx) => {
      const name_en = (r.name_en || '').toString().trim();
      const sku     = (r.sku || '').toString().trim();
      if (!name_en && !sku) {
        stats.skipped++; stats.errors.push(`Row ${idx+1}: no name and no SKU`); return;
      }

      // Resolve linked recipe if recipe_name was supplied
      let recipeId = r.recipe_id ? parseInt(r.recipe_id, 10) || null : null;
      if (!recipeId && r.recipe_name) {
        const rn = String(r.recipe_name).trim();
        const rec = findRecipe.get(rn, rn, rn);
        if (rec) recipeId = rec.id;
      }

      const sell_price = (r.sell_price !== '' && r.sell_price != null) ? parseFloat(r.sell_price) : null;

      if (sku) {
        const existing = findBySku.get(sku);
        if (existing) {
          reactivate.run(existing.id);  // un-soft-delete on re-import
          updateProd.run(
            name_en, r.name_cn || '', r.category || '', recipeId,
            r.status || '', isNaN(sell_price) ? null : sell_price,
            r.weight || '', r.barcode || '',
            r.description_en || '', r.description_cn || '',
            r.free_of || '', r.notes || '',
            existing.id
          );
          stats.updated++;
          return;
        }
      }
      if (!name_en) { stats.skipped++; stats.errors.push(`Row ${idx+1}: SKU "${sku}" not found and no name to insert`); return; }
      try {
        insertProd.run(
          name_en, r.name_cn || null, sku || null, r.category || null,
          recipeId, r.status || 'Active',
          isNaN(sell_price) ? 0 : (sell_price || 0),
          r.weight || null, r.barcode || null,
          r.description_en || null, r.description_cn || null,
          r.free_of || null, r.notes || null
        );
        stats.inserted++;
      } catch (e) {
        stats.skipped++;
        stats.errors.push(`Row ${idx+1}: ${e.message.includes('UNIQUE') ? 'duplicate SKU' : e.message}`);
      }
    });
  });

  try {
    importTx();
    logActivity(req.user.id, req.user.username, 'bulk_import', 'product', null,
      { inserted: stats.inserted, updated: stats.updated, skipped: stats.skipped }, req.ip);
    if (stats.errors.length > 50) stats.errors = stats.errors.slice(0, 50).concat([`… ${stats.errors.length - 50} more`]);
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET sales overview for one product — used by the product detail page's
// "Sales Performance" card. Returns this-month / last-month / YTD / lifetime
// totals, top channels, last-12-months trend, and 5 most recent entries.
// Read-only; needs the products permission since it's an aggregate of sales.
router.get('/api/products/:id/sales-summary', requireAuth, requirePermission('products'), (req, res) => {
  const productId = parseInt(req.params.id, 10);
  if (!productId) return res.status(400).json({ error: 'invalid id · ID 无效' });

  const today      = new Date();
  const yyyy       = today.getFullYear();
  const mm         = today.getMonth();          // 0-11
  const startMonth = `${yyyy}-${String(mm+1).padStart(2,'0')}-01`;
  const lastMonthY = mm === 0 ? yyyy - 1 : yyyy;
  const lastMonthM = mm === 0 ? 12 : mm;        // 1-12
  const lastMonthStart = `${lastMonthY}-${String(lastMonthM).padStart(2,'0')}-01`;
  const startYear  = `${yyyy}-01-01`;

  const sumOver = (whereClause, ...params) => {
    const r = db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(total),0) AS revenue
      FROM sales_entries WHERE product_id = ? ${whereClause}`).get(productId, ...params);
    return { entries: r.entries|0, qty: +(r.qty||0), revenue: +(r.revenue||0) };
  };

  const this_month = sumOver('AND date >= ?', startMonth);
  const last_month = sumOver('AND date >= ? AND date < ?', lastMonthStart, startMonth);
  const this_year  = sumOver('AND date >= ?', startYear);
  const lifetime   = sumOver('');

  // Channel ranking by revenue, plus qty + entry count for tooltips.
  const top_channels = db.prepare(`SELECT
      COALESCE(NULLIF(TRIM(channel),''),'(unspecified)') AS channel,
      COUNT(*) AS entries,
      COALESCE(SUM(qty),0)   AS qty,
      COALESCE(SUM(total),0) AS revenue
    FROM sales_entries
    WHERE product_id = ?
    GROUP BY channel
    ORDER BY revenue DESC
    LIMIT 8`).all(productId).map(r => ({ channel: r.channel, entries: r.entries|0, qty: +r.qty, revenue: +r.revenue }));

  // Last 12 months — emit a complete series so the chart has zero-bars.
  const monthRows = db.prepare(`SELECT substr(date,1,7) AS ym,
       COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS entries
     FROM sales_entries WHERE product_id = ? AND date >= date('now','-11 months','start of month')
     GROUP BY ym ORDER BY ym`).all(productId);
  const monthMap = Object.fromEntries(monthRows.map(r => [r.ym, r]));
  const by_month = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(yyyy, mm - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const r  = monthMap[ym] || { qty: 0, revenue: 0, entries: 0 };
    by_month.push({ month: ym, qty: +(r.qty||0), revenue: +(r.revenue||0), entries: r.entries|0 });
  }

  const recent = db.prepare(`SELECT id, date, channel, qty, unit_price, total
    FROM sales_entries WHERE product_id = ? ORDER BY date DESC, id DESC LIMIT 5`).all(productId);

  res.json({ success: true, data: { this_month, last_month, this_year, lifetime, top_channels, by_month, recent } });
});

// GET distinct categories (handy for filters)
router.get('/api/products/meta/categories', requireAuth, (req, res) => {
  const cats = db.prepare(
    "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category"
  ).all().map(r => r.category);
  res.json({ success: true, data: cats });
});

module.exports = router;
