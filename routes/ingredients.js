const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// Lightweight column set for the LIST endpoint. The Items table doesn't
// render image_data (a base64 product photo) or supplier_qr_data (a base64
// WeChat QR), but SELECT * was shipping both for every row — pushing the
// payload past 1 MB on real catalogues. Here we drop them and expose
// boolean flags instead; the chip uses `has_supplier_qr` to know whether
// to render the "💚 WeChat QR" button, and the QR itself is fetched on
// demand by the existing single-ingredient GET. The detail/edit form
// already calls GET /api/ingredients/:id so it still receives everything.
const INGREDIENT_LIST_COLS = `
  id, name_en, name_cn, sku, category,
  unit, buy_unit, buy_pack_size, pack_contents_qty, pack_contents_unit,
  cost_per_unit, buy_price, free_by_design,
  supplier, supplier_platform, supplier_link,
  allergens, notes,
  is_active, created_at, updated_at,
  accounting_category, item_kind,
  (image_data IS NOT NULL AND image_data != '')        AS has_image,
  (supplier_qr_data IS NOT NULL AND supplier_qr_data != '') AS has_supplier_qr
`;

// GET all ingredients
router.get('/api/ingredients', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { search, category, count_only } = req.query;
  // count_only=1 skips shipping the (multi-MB) full list when the caller only
  // needs the row count — e.g. the dashboard KPI tile. Honours the same
  // filters so a future filtered-count caller works too.
  if (count_only === '1' || count_only === 'true') {
    let cq = 'SELECT COUNT(*) AS n FROM ingredients WHERE is_active = 1';
    const cp = [];
    if (search) { cq += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; cp.push(s,s,s); }
    if (category) { cq += ' AND category = ?'; cp.push(category); }
    return res.json({ success: true, count: db.prepare(cq).get(...cp).n });
  }
  let query = `SELECT ${INGREDIENT_LIST_COLS} FROM ingredients WHERE is_active = 1`;
  const params = [];
  if (search) { query += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; params.push(s,s,s); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  query += ' ORDER BY name_en';
  // SQLite returns booleans as 0/1 — fine for JSON, the front-end already
  // does `if (i.supplier_qr_data)` truthy checks which work with 1 too.
  // Re-shape the column name so the chip's existing branch keeps working
  // unchanged: it tests `i.supplier_qr_data` truthiness, so we mirror the
  // has_supplier_qr flag into that field on the way out.
  const rows = db.prepare(query).all(...params);
  for (const r of rows) {
    r.supplier_qr_data = r.has_supplier_qr ? 1 : null;
    r.image_data = r.has_image ? 1 : null;
    delete r.has_supplier_qr;
    delete r.has_image;
  }
  res.json({ success: true, data: rows });
});

// GET single ingredient
router.get('/api/ingredients/:id', requireAuth, requirePermission('ingredients'), (req, res) => {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!ing) return res.status(404).json({ error: 'Not found · 未找到' });
  const history = db.prepare('SELECT * FROM ingredient_price_history WHERE ingredient_id = ? ORDER BY recorded_at DESC LIMIT 20').all(ing.id);
  res.json({ success: true, data: { ...ing, priceHistory: history } });
});

// POST create ingredient
router.post('/api/ingredients', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { name_en, name_cn, sku, category, unit, buy_unit, buy_pack_size, pack_contents_qty, pack_contents_unit, cost_per_unit, buy_price,
          supplier, supplier_platform, supplier_link, supplier_qr_data, image_data, allergens, notes,
          accounting_category, item_kind, free_by_design } = req.body;
  if (!name_en) return res.status(400).json({ error: 'name_en required · 英文名称必填' });
  try {
    const result = db.prepare(`INSERT INTO ingredients
      (name_en,name_cn,sku,category,unit,buy_unit,buy_pack_size,pack_contents_qty,pack_contents_unit,cost_per_unit,buy_price,supplier,supplier_platform,supplier_link,supplier_qr_data,image_data,allergens,notes,accounting_category,item_kind,free_by_design)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(name_en, name_cn||null, sku||null, category||null, unit||'g', buy_unit||'kg', buy_pack_size||1,
           pack_contents_qty||null, pack_contents_unit||null,
           cost_per_unit||0, buy_price||0,
           supplier||null, supplier_platform||null, supplier_link||null, supplier_qr_data||null, image_data||null,
           allergens ? (Array.isArray(allergens) ? allergens.join(', ') : String(allergens)) : null, notes||null,
           accounting_category || null, item_kind || 'food', free_by_design ? 1 : 0);
    if (buy_price > 0) {
      db.prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source,recorded_by) VALUES (?,?,?,?,?)').run(result.lastInsertRowid, buy_price, buy_unit||'kg', 'manual', req.user.username);
    }
    logActivity(req.user.id, req.user.username, 'create', 'ingredient', result.lastInsertRowid, { name_en }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'SKU already exists · SKU已存在' });
    res.status(500).json({ error: e.message });
  }
});

// PUT update ingredient
router.put('/api/ingredients/:id', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { name_en, name_cn, sku, category, unit, buy_unit, buy_pack_size, pack_contents_qty, pack_contents_unit, cost_per_unit, buy_price,
          supplier, supplier_platform, supplier_link, supplier_qr_data, image_data, allergens, notes,
          accounting_category, item_kind, free_by_design } = req.body;
  const existing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  try {
    db.prepare(`UPDATE ingredients SET
      name_en=?,name_cn=?,sku=?,category=?,unit=?,buy_unit=?,buy_pack_size=?,pack_contents_qty=?,pack_contents_unit=?,cost_per_unit=?,buy_price=?,
      supplier=?,supplier_platform=?,supplier_link=?,supplier_qr_data=?,image_data=?,allergens=?,notes=?,accounting_category=?,item_kind=?,free_by_design=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`)
      .run(name_en||existing.name_en, name_cn||null, sku||null, category||null, unit||'g', buy_unit||'kg', buy_pack_size||1,
           pack_contents_qty||null, pack_contents_unit||null,
           cost_per_unit||0, buy_price||0,
           supplier||null, supplier_platform||null, supplier_link||null, supplier_qr_data||null, image_data||null,
           allergens ? (Array.isArray(allergens) ? allergens.join(', ') : String(allergens)) : null, notes||null,
           accounting_category || null, item_kind || existing.item_kind || 'food',
           free_by_design ? 1 : 0, req.params.id);
    // Record price change
    if (buy_price && buy_price !== existing.buy_price) {
      db.prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source,recorded_by) VALUES (?,?,?,?,?)').run(req.params.id, buy_price, buy_unit||'kg', 'manual', req.user.username);
      // Create price alert if change > 5%
      if (existing.buy_price > 0) {
        const changePct = ((buy_price - existing.buy_price) / existing.buy_price) * 100;
        if (Math.abs(changePct) >= 5) {
          db.prepare('INSERT INTO price_alerts (ingredient_id,old_price,new_price,change_pct) VALUES (?,?,?,?)').run(req.params.id, existing.buy_price, buy_price, changePct);
        }
      }
    }
    // Backfill the new accounting_category onto historical PO lines that
    // were created before the ingredient had one (or had a different one).
    // Re-post any affected Ordered/Delivered/Confirmed POs so Finance →
    // Expenses moves the amounts from "未分类 Uncategorized" into the
    // correct bucket without manager action.
    let backfilled = { lines: 0, pos_reposted: 0 };
    const newCat   = accounting_category || null;
    const oldCat   = existing.accounting_category || null;
    if (newCat && newCat !== oldCat) {
      // Update PO lines that are blank OR were carrying the old category.
      // Lines a buyer has explicitly overridden to a different non-blank
      // category are left alone (manual takes precedence).
      const upd = db.prepare(`
        UPDATE po_line_items
           SET expense_category = ?
         WHERE ingredient_id = ?
           AND (expense_category IS NULL OR TRIM(expense_category) = '' OR expense_category = ?)
      `);
      const params = oldCat ? [newCat, req.params.id, oldCat] : [newCat, req.params.id, ''];
      const r = upd.run(...params);
      backfilled.lines = r.changes;
      // Re-post expenses on every PO that owns one of those lines and is postable.
      if (r.changes > 0) {
        const { postPOExpenses } = require('./purchases');
        const affected = db.prepare(`
          SELECT DISTINCT po.id
          FROM po_line_items pli
          JOIN purchase_orders po ON po.id = pli.po_id
          WHERE pli.ingredient_id = ?
            AND pli.expense_category = ?
            AND po.status IN ('Ordered','Delivered','Confirmed')
        `).all(req.params.id, newCat);
        for (const row of affected) {
          const result = postPOExpenses(row.id);
          if (result.inserted > 0) backfilled.pos_reposted++;
        }
      }
    }
    logActivity(req.user.id, req.user.username, 'update', 'ingredient', req.params.id, { name_en, ...(backfilled.lines ? { backfilled } : {}) }, req.ip);
    res.json({ success: true, backfilled });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'SKU already exists · SKU已存在' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/ingredients/:id/supplier — set just the supplier column.
// Used by the supplier form's "Items Sold" panel so accounting can wire
// items to a supplier from the supplier side without touching any other
// fields. Pass { supplier: '...' } or { supplier: null } to unlink.
router.put('/api/ingredients/:id/supplier', requireAuth, requirePermission('ingredients'), (req, res) => {
  const existing = db.prepare('SELECT id FROM ingredients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ingredient not found · 食材未找到' });
  const supplier = req.body && req.body.supplier ? String(req.body.supplier).trim() : null;
  db.prepare('UPDATE ingredients SET supplier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(supplier || null, req.params.id);
  logActivity(req.user.id, req.user.username, 'set_supplier', 'ingredient', req.params.id, { supplier }, req.ip);
  res.json({ success: true });
});

// PATCH /api/ingredients/bulk-update — apply the same item_kind and/or
// category to many rows in one transaction. Used by the Items page bulk
// edit action bar. `updates` may include `item_kind` (string) and/or
// `category` (string|null). When item_kind changes, the frontend sends
// category=null too so rows don't carry a kind-mismatched legacy
// category (categories are kind-specific — only Packaging uses them).
//
// Body: { ids: [int, ...], updates: { item_kind?, category? } }
router.patch('/api/ingredients/bulk-update', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { ids, updates } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required · 需要 ids 数组' });
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates required · 需要更新字段' });
  const sets = [];
  const args = [];
  if (Object.prototype.hasOwnProperty.call(updates, 'item_kind')) {
    const k = updates.item_kind;
    if (k && typeof k !== 'string') return res.status(400).json({ error: 'item_kind must be string · item_kind 必须为字符串' });
    sets.push('item_kind = ?'); args.push(k || 'food');
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'category')) {
    const c = updates.category;
    if (c !== null && typeof c !== 'string') return res.status(400).json({ error: 'category must be string or null · category 必须为字符串或 null' });
    sets.push('category = ?'); args.push(c && c.trim() ? c.trim() : null);
  }
  // Bulk-edit additions: supplier, accounting_category, unit, buy_unit,
  // supplier_platform, allergens, is_active. All are nullable strings
  // except is_active (0/1). Whitelist ensures the endpoint can't be coaxed
  // into updating columns it shouldn't (price, image, name, etc.).
  const STR_FIELDS = ['supplier', 'accounting_category', 'unit', 'buy_unit', 'supplier_platform', 'allergens'];
  for (const f of STR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, f)) continue;
    const v = updates[f];
    if (v !== null && typeof v !== 'string') return res.status(400).json({ error: `${f} must be string or null` });
    sets.push(`${f} = ?`); args.push(v && v.trim() ? v.trim() : null);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'is_active')) {
    const n = updates.is_active === 1 || updates.is_active === '1' || updates.is_active === true ? 1 : 0;
    sets.push('is_active = ?'); args.push(n);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields to update · 无字段可更新' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  // Sanitize ids → numbers only.
  const cleanIds = ids.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (cleanIds.length === 0) return res.status(400).json({ error: 'no valid ids · 无有效 id' });
  const placeholders = cleanIds.map(() => '?').join(',');
  const sql = `UPDATE ingredients SET ${sets.join(', ')} WHERE id IN (${placeholders})`;
  try {
    const tx = db.transaction(() => db.prepare(sql).run(...args, ...cleanIds));
    const r = tx();
    logActivity(req.user.id, req.user.username, 'bulk_update', 'ingredient', null,
      { count: r.changes, ids: cleanIds, updates }, req.ip);
    res.json({ success: true, updated: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE (soft delete)
router.delete('/api/ingredients/:id', requireAuth, requireDelete, requirePermission('ingredients'), (req, res) => {
  // Release the SKU on delete so the code can be reused. sku is UNIQUE, and a
  // soft-deleted row would otherwise reserve it forever; SQLite allows many
  // NULLs in a UNIQUE column, so nulling it frees the namespace without
  // dropping the row (recipes/POs still reference ingredient_id).
  db.prepare('UPDATE ingredients SET is_active = 0, sku = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'ingredient', req.params.id, null, req.ip);
  res.json({ success: true });
});

// POST bulk import (from Zoho CSV) — broadened to cover all the new
// fields the items page tracks (item_kind, accounting_category, supplier
// link/platform, pack_contents). Optional `wipe: true` clears the table
// (and recipes + recipe_ingredients + ingredient_price_history) inside the
// same transaction so re-imports don't accumulate stale rows. Admin only
// when wipe=true; regular users can still do additive imports.
router.post('/api/ingredients/bulk', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { ingredients, wipe } = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'ingredients array required · 食材数组必填' });
  if (wipe && req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only for wipe · 仅管理员可清空' });
  // Safety net: before a wipe, snapshot the live DB to a timestamped file
  // so the wipe is reversible. This is what factory_reset already does;
  // the bulk-import wipe was missing it. The restore_recipe_data.js
  // script can read these snapshots later to recover ingredient/recipe
  // linkages if the wipe turns out to be a mistake.
  if (wipe) {
    try {
      const fs = require('fs');
      const path = require('path');
      const dataDir = path.join(__dirname, '..', 'data');
      const dbPath  = path.join(dataDir, 'roots.db');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const snap = path.join(dataDir, `roots-pre-wipe-${ts}.db`);
      if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, snap);
      logActivity(req.user.id, req.user.username, 'pre_wipe_snapshot', 'system', null, { snapshot: path.basename(snap) }, req.ip);
    } catch (e) {
      console.error('[bulk import wipe — snapshot failed]', e);
      return res.status(500).json({ error: 'Pre-wipe snapshot failed · 备份失败: ' + e.message });
    }
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO ingredients
    (name_en,name_cn,sku,category,unit,buy_unit,buy_pack_size,pack_contents_qty,pack_contents_unit,cost_per_unit,buy_price,supplier,supplier_platform,supplier_link,notes,accounting_category,item_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertHistory = db.prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source,recorded_by) VALUES (?,?,?,?,?)');

  let imported = 0, wiped = null;
  const importMany = db.transaction((ings) => {
    if (wipe) {
      // Order matters: child rows first.
      const r1 = db.prepare('DELETE FROM recipe_ingredients').run();
      const r2 = db.prepare('DELETE FROM recipe_steps').run();
      const r3 = db.prepare('DELETE FROM recipe_cost_data').run();
      const r4 = db.prepare('DELETE FROM recipes').run();
      const r5 = db.prepare('DELETE FROM ingredient_price_history').run();
      const r6 = db.prepare('DELETE FROM price_alerts').run();
      const r7 = db.prepare('DELETE FROM ingredients').run();
      // Reset autoincrement counters so SKUs / IDs start fresh.
      try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('ingredients','recipes','recipe_ingredients','recipe_steps','recipe_cost_data','ingredient_price_history','price_alerts')").run(); } catch {}
      wiped = {
        recipe_ingredients: r1.changes, recipe_steps: r2.changes, recipe_cost_data: r3.changes,
        recipes: r4.changes, ingredient_price_history: r5.changes, price_alerts: r6.changes,
        ingredients: r7.changes,
      };
    }
    for (const ing of ings) {
      const result = insert.run(
        ing.name_en, ing.name_cn||null, ing.sku||null, ing.category||null,
        ing.unit||'g', ing.buy_unit||'kg', ing.buy_pack_size||1,
        ing.pack_contents_qty||null, ing.pack_contents_unit||null,
        ing.cost_per_unit||0, ing.buy_price||0,
        ing.supplier||null, ing.supplier_platform||null, ing.supplier_link||null,
        ing.notes||null, ing.accounting_category||null, ing.item_kind || 'food'
      );
      if (result.changes > 0) {
        imported++;
        if (ing.buy_price > 0) insertHistory.run(result.lastInsertRowid, ing.buy_price, ing.buy_unit||'kg', 'zoho_import', req.user.username);
      }
    }
  });
  try {
    importMany(ingredients);
    logActivity(req.user.id, req.user.username, wipe ? 'wipe_and_bulk_import' : 'bulk_import', 'ingredient', null, { count: imported, wiped }, req.ip);
    res.json({ success: true, imported, wiped });
  } catch (e) {
    console.error('[bulk import error]', e);
    res.status(500).json({ error: 'Import failed · 导入失败: ' + (e.message || 'unknown') });
  }
});

// GET categories
router.get('/api/ingredients/meta/categories', requireAuth, (req, res) => {
  const cats = db.prepare('SELECT DISTINCT category FROM ingredients WHERE is_active = 1 AND category IS NOT NULL ORDER BY category').all().map(r => r.category);
  res.json({ success: true, data: cats });
});

// Rename a category within one kind. Categories aren't stored separately —
// they live as free text on each ingredient row. So rename = bulk UPDATE
// of every matching row.
//
// Body: { kind: string, oldName: string, newName: string }
router.post('/api/ingredients/categories/rename', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { kind, oldName, newName } = req.body || {};
  if (!kind || typeof kind !== 'string') return res.status(400).json({ error: 'kind required · 需要 kind' });
  if (!oldName || typeof oldName !== 'string') return res.status(400).json({ error: 'oldName required · 需要原名称' });
  if (!newName || typeof newName !== 'string' || !newName.trim()) return res.status(400).json({ error: 'newName required · 需要新名称' });
  const newNameTrim = newName.trim();
  if (newNameTrim === oldName) return res.json({ success: true, updated: 0 });
  try {
    const r = db.prepare('UPDATE ingredients SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ? AND item_kind = ?')
      .run(newNameTrim, oldName, kind);
    logActivity(req.user.id, req.user.username, 'category_rename', 'ingredient', null,
      { kind, oldName, newName: newNameTrim, count: r.changes }, req.ip);
    res.json({ success: true, updated: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a category — null out the category field on every matching row
// (the rows themselves stay). Scoped by kind so categories with the same
// name in different kinds don't collide.
//
// Body: { kind: string, name: string }
router.post('/api/ingredients/categories/delete', requireAuth, requirePermission('ingredients'), (req, res) => {
  const { kind, name } = req.body || {};
  if (!kind || typeof kind !== 'string') return res.status(400).json({ error: 'kind required · 需要 kind' });
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required · 需要名称' });
  try {
    const r = db.prepare('UPDATE ingredients SET category = NULL, updated_at = CURRENT_TIMESTAMP WHERE category = ? AND item_kind = ?')
      .run(name, kind);
    logActivity(req.user.id, req.user.username, 'category_delete', 'ingredient', null,
      { kind, name, count: r.changes }, req.ip);
    res.json({ success: true, updated: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
