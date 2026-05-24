const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

const PRODUCT_COLS = `
  p.id, p.name_en, p.name_cn, p.sku, p.category, p.recipe_id, p.status,
  p.sell_price, p.weight, p.barcode,
  p.description_en, p.description_cn, p.free_of,
  p.image_data, p.label_data,
  p.notes, p.created_at, p.updated_at,
  p.external_id, p.sort_order, p.stock_qty, p.tags,
  p.variant_group_id, p.variant_label,
  p.is_market, p.is_restock_only, p.is_published,
  p.ship_modes, p.needs_ice_pack,
  p.nutrition,
  p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,
  p.description_blocks,
  p.colophon_character, p.colophon_tagline_en, p.colophon_tagline_cn,
  r.name_en AS recipe_name
`;

// GET all products (with linked recipe name for the table view)
router.get('/api/products', requireAuth, requirePermission('products'), (req, res) => {
  const { search, category, status, deleted_only } = req.query;
  // Filter mode:
  //  - default            → active products (is_active=1)
  //  - ?deleted_only=1    → trash view (is_active=0) for the restore UI
  const onlyDeleted = deleted_only === '1' || deleted_only === 'true';
  let q = `SELECT ${PRODUCT_COLS} FROM products p
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
  res.json({ success: true, data: db.prepare(q).all(...params) });
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
  // Derive recipe-driven info if linked. Each ingredient.allergens is a
  // free-text comma string ("nuts, soy") — split, dedupe, sort.
  let derived = { allergens: [], ingredient_count: 0 };
  if (row.recipe_id) {
    const ings = db.prepare(`
      SELECT ing.name_en, ing.name_cn, ing.allergens
        FROM recipe_ingredients ri
        JOIN ingredients ing ON ing.id = ri.ingredient_id
       WHERE ri.recipe_id = ? AND COALESCE(ing.is_active, 1) = 1
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
  }
  // Sibling variants — the other products that share this row's
  // variant_group_id. The form uses these to render the "Other variants"
  // chips. Empty array if the product is standalone.
  let siblings = [];
  if (row.variant_group_id) {
    siblings = db.prepare(`
      SELECT id, name_en, name_cn, sku, sell_price, stock_qty,
             variant_label, image_data, status
        FROM products
       WHERE variant_group_id = ? AND id != ? AND COALESCE(is_active, 1) = 1
       ORDER BY variant_label, name_en
    `).all(row.variant_group_id, row.id);
  }
  res.json({ success: true, data: { ...row, derived, siblings } });
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
  try {
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE products SET variant_group_id = ?, variant_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      for (const id of cleanIds) {
        const lbl = (labelMap[id] || '').toString().trim() || null;
        upd.run(groupId, lbl, id);
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

// Body keys the form sends; whitelisted to keep the SQL boring.
const FIELDS = [
  'name_en', 'name_cn', 'sku', 'category', 'recipe_id', 'status',
  'sell_price', 'weight', 'barcode',
  'description_en', 'description_cn', 'free_of',
  'image_data', 'label_data', 'notes',
  'external_id', 'sort_order', 'stock_qty', 'tags',
  'variant_group_id', 'variant_label',
  'is_market', 'is_restock_only',
  // Retail / mini-app surface — single toggle, no separate retail price
  // or description. Mini app uses sell_price + description_en/cn directly.
  'is_published',
  // Warehouse / packing flags. ship_modes is a csv subset of {'air','land'}
  // — items the airline rejects (liquid, lithium, frozen) are 'land' only.
  // needs_ice_pack flags cold-chain so the packer pulls ice.
  'ship_modes', 'needs_ice_pack',
  // Nutrition panel — JSON: { basis_en, basis_cn, rows:[{label_en,label_cn,value}] }
  'nutrition',
  // Mini-app card chrome (bilingual)
  'keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn',
  // Block-based product page body (JSON array of `{id, type, ...data}`)
  'description_blocks',
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
    else if (k === 'needs_ice_pack')     out[k] = body[k] ? 1 : 0;
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
router.put('/api/products/:id', requireAuth, requirePermission('products'), (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });

  const present = FIELDS.filter(f => f in req.body);
  if (present.length === 0) return res.status(400).json({ error: 'no_fields' });
  const p = pickBody(req.body);
  if ('name_en' in req.body && !p.name_en) return res.status(400).json({ error: 'name_en required · 英文名称必填' });
  try {
    const setClause = present.map(f => `${f}=?`).join(',') + ',updated_at=CURRENT_TIMESTAMP';
    db.prepare(`UPDATE products SET ${setClause} WHERE id=?`)
      .run(...present.map(f => p[f]), req.params.id);
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
//   set_category          value = category name (string, '' clears)
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
      // '' / null clears the category (NULL in the column).
      normalized = (value == null || value === '') ? null : String(value).trim();
      stmt = db.prepare('UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
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
        const r = (action === 'delete') ? stmt.run(id) : stmt.run(normalized, id);
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
