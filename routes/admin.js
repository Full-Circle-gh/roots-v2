const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
// The one cost-per-recipe-unit derivation, shared with the PO price write-back
// and mirroring the ingredient form. See lib/ingredient-cost.js.
const { deriveCostPerUnit } = require('../lib/ingredient-cost');
// The nested-recipe recompute (§29 step 3) — fired after the repair sweep
// moves a non-linked ingredient's cost, since that can move a linked
// material's recipe-derived cost transitively. See lib/recipe-rollup.js.
const { fireRecompute } = require('../lib/recipe-rollup');
const { requireAuth, requireAdmin, logActivity } = require('../middleware/auth');
const { blockCostWrite } = require('../middleware/block-kitchen-cost-writes');
const router = express.Router();

// POST create user
router.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || username.trim().length < 2) return res.status(400).json({ error: 'username must be at least 2 chars · 用户名至少需要 2 位' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 chars · 密码至少需要 6 位' });
  // Built-in roles always accepted; custom roles must exist in the
  // categories table with kind='role'. Admins manage that list from
  // Admin → Roles. Falls back to 'kitchen' if the value is unknown.
  const builtIn = ['admin', 'manager', 'warehouse', 'kitchen'];
  const customRoles = db.prepare("SELECT name FROM categories WHERE kind = 'role'").all().map(r => r.name);
  const validRoles = new Set([...builtIn, ...customRoles]);
  const userRole = validRoles.has(role) ? role : 'kitchen';
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password, role, display_name) VALUES (?,?,?,?)'
    ).run(username.trim(), hash, userRole, display_name || username);
    // Default permissions per role. Last column = can_delete (granular
    // destructive-action gate). Admin/manager get it by default; warehouse
    // and kitchen do NOT — admin can flip it on per-user later.
    const defaults = {
      // dash, rec, ing, prod, pur, fin, sales, kit, waste, restock, alerts, suppliers, can_delete
      admin:     [1,1,1,1,1,1,1,1,1,1,1, 1, 1],
      manager:   [1,1,1,1,1,1,1,1,1,1,1, 1, 1],
      warehouse: [1,0,1,0,1,0,0,0,1,1,1, 1, 0],
      kitchen:   [1,1,1,0,0,0,0,1,1,0,0, 0, 0],
    };
    const p = defaults[userRole] || defaults.kitchen;
    db.prepare(`INSERT INTO permissions (user_id, dashboard, recipes, ingredients, products, purchases, finance, sales, kitchen, waste, restock, alerts, suppliers, can_delete)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(result.lastInsertRowid, ...p);
    logActivity(req.user.id, req.user.username, 'create_user', 'user', result.lastInsertRowid, { username, role: userRole }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'Username already exists · 用户名已存在' });
    res.status(500).json({ error: e.message });
  }
});

// GET all users
router.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id,username,role,display_name,last_login,is_active,created_at,market_id,retail_store_id FROM users ORDER BY id').all();
  const usersWithPerms = users.map(u => ({
    ...u,
    permissions: db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(u.id) || {}
  }));
  res.json({ success: true, data: usersWithPerms });
});

// PUT update permissions
router.put('/api/admin/permissions/:userId', requireAuth, requireAdmin, (req, res) => {
  const { dashboard,recipes,ingredients,products,purchases,finance,sales,kitchen,waste,restock,warehouse_inbox,kitchen_inbox,alerts,suppliers,pos,ai,can_delete } = req.body;
  // can_delete = granular destructive-action gate (server middleware
  // requireDelete). pos = Markets POS app access. ai = Sprout · 苗 chat
  // assistant access. warehouse_inbox = warehouse-side fulfilment view.
  // kitchen_inbox = kitchen-side fulfilment view for warehouse→kitchen
  // restock requests. All independent of module-level reads.
  db.prepare(`INSERT INTO permissions (user_id,dashboard,recipes,ingredients,products,purchases,finance,sales,kitchen,waste,restock,warehouse_inbox,kitchen_inbox,alerts,suppliers,pos,ai,can_delete)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET dashboard=?,recipes=?,ingredients=?,products=?,purchases=?,finance=?,sales=?,kitchen=?,waste=?,restock=?,warehouse_inbox=?,kitchen_inbox=?,alerts=?,suppliers=?,pos=?,ai=?,can_delete=?`)
    .run(req.params.userId,
      dashboard?1:0,recipes?1:0,ingredients?1:0,products?1:0,purchases?1:0,finance?1:0,sales?1:0,kitchen?1:0,waste?1:0,restock?1:0,warehouse_inbox?1:0,kitchen_inbox?1:0,alerts?1:0,suppliers?1:0,pos?1:0,ai?1:0,can_delete?1:0,
      dashboard?1:0,recipes?1:0,ingredients?1:0,products?1:0,purchases?1:0,finance?1:0,sales?1:0,kitchen?1:0,waste?1:0,restock?1:0,warehouse_inbox?1:0,kitchen_inbox?1:0,alerts?1:0,suppliers?1:0,pos?1:0,ai?1:0,can_delete?1:0);
  logActivity(req.user.id, req.user.username, 'update_permissions', 'user', req.params.userId, req.body, req.ip);
  res.json({ success: true });
});

// DELETE a user (hard-delete). Refuses if the user has any historical records
// — sales / POs / waste / production / kitchen / restock / activity log all
// reference users via created_by. Caller is told to Deactivate instead.
router.delete('/api/admin/users/:userId', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.userId);
  if (id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself · 不能删除自己' });
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'user not found · 用户不存在' });
  // Don't let admin delete the last admin — would lock everyone out.
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND COALESCE(is_active,1)=1").get().n;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot delete the last active admin · 不能删除最后一位管理员' });
  }
  // Pre-flight: count rows that would orphan if we hard-deleted.
  const refs = [
    { tbl: 'sales_entries',     col: 'created_by', label: 'sales' },
    { tbl: 'waste_entries',     col: 'created_by', label: 'waste' },
    { tbl: 'purchase_orders',   col: 'created_by', label: 'POs' },
    { tbl: 'income_entries',    col: 'created_by', label: 'income' },
    { tbl: 'expense_entries',   col: 'created_by', label: 'expenses' },
    { tbl: 'kitchen_orders',    col: 'created_by', label: 'kitchen orders' },
    { tbl: 'production_log',    col: 'created_by', label: 'production' },
    { tbl: 'restock_orders',    col: 'created_by', label: 'restock' },
  ];
  const hits = [];
  for (const r of refs) {
    try {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${r.tbl} WHERE ${r.col} = ?`).get(id).n;
      if (n > 0) hits.push(`${n} ${r.label}`);
    } catch { /* table may not exist on a fresh DB — skip */ }
  }
  if (hits.length) {
    return res.status(409).json({
      error: 'user has historical records · 用户有历史记录',
      detail: `Would orphan: ${hits.join(' · ')}. Deactivate instead. · 改为停用。`,
      counts: hits,
    });
  }
  // Safe to delete: clean up permissions, sessions, then the user row.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM permissions WHERE user_id = ?').run(id);
    try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); } catch {}
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  try { tx(); }
  catch (e) { return res.status(500).json({ error: 'delete failed · 删除失败', detail: e.message }); }
  logActivity(req.user.id, req.user.username, 'delete_user', 'user', id, { username: target.username, role: target.role }, req.ip);
  res.json({ success: true });
});

// PUT change user role
router.put('/api/admin/users/:userId/role', requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role required · 角色必填' });
  const builtIn = ['admin', 'manager', 'warehouse', 'kitchen'];
  const customRoles = db.prepare("SELECT name FROM categories WHERE kind='role'").all().map(r => r.name);
  const valid = new Set([...builtIn, ...customRoles]);
  if (!valid.has(role)) return res.status(400).json({ error: 'unknown role · 未知角色' });
  // Block self-demotion — an admin can't accidentally lock themselves out by
  // dropping their own admin role.
  if (Number(req.params.userId) === req.user.id && role !== req.user.role) {
    return res.status(400).json({ error: 'cannot change your own role · 不能修改自己的角色' });
  }
  const target = db.prepare('SELECT role FROM users WHERE id=?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'user not found · 用户不存在' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.userId);
  logActivity(req.user.id, req.user.username, 'change_role', 'user', req.params.userId, { from: target.role, to: role }, req.ip);
  res.json({ success: true });
});

// PUT reset password
router.put('/api/admin/users/:userId/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password min 6 chars · 密码至少 6 位' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.userId);
  logActivity(req.user.id, req.user.username, 'reset_password', 'user', req.params.userId, null, req.ip);
  res.json({ success: true });
});

// PUT toggle user active
router.put('/api/admin/users/:userId/status', requireAuth, requireAdmin, (req, res) => {
  const { is_active } = req.body;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.userId);
  res.json({ success: true });
});

// GET activity log
router.get('/api/admin/activity', requireAuth, requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ success: true, data: logs });
});

// DELETE activity log entries older than N days (default 30 for manual purge)
router.delete('/api/admin/activity', requireAuth, requireAdmin, (req, res) => {
  const days = parseInt(req.body.days || req.query.days || '30', 10);
  if (!days || days < 1) return res.status(400).json({ error: 'days must be >= 1 · 天数必须 >= 1' });
  const r = db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
  logActivity(req.user.id, req.user.username, 'purge_activity_log', 'system', null, { deleted: r.changes, days }, req.ip);
  res.json({ success: true, deleted: r.changes });
});

// GET backup
router.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  const dbPath = path.join(__dirname, '../data/roots.db');
  const date = new Date().toISOString().split('T')[0];
  logActivity(req.user.id, req.user.username, 'backup_download', 'system', null, null, req.ip);
  res.download(dbPath, `roots-backup-${date}.db`);
});

// POST /api/admin/factory-reset — wipe every transactional + lookup table
// the team fills in (items, recipes, products, POs, finance, sales, waste,
// production, restock, kitchen, suppliers, packaging types, categories).
// Users, permissions, sessions, and the activity log are preserved so the
// admin can still sign in and the wipe itself is auditable.
//
// Safety: requires `confirm: 'RESET'` in the body AND admin role. Copies
// the live db to data/roots-pre-wipe-<ts>.db before doing anything, so a
// rollback is one file copy away. Re-seeds item_kind defaults so the
// Items page tabs work post-wipe.
// Wipes ingredients (cost columns included), recipes, recipe_ingredients and
// recipe_cost_data outright — blocked (material cost columns + recipe lines +
// recipe cost data), on top of everything else it destroys.
router.post('/api/admin/factory-reset', requireAuth, requireAdmin, blockCostWrite('material cost / recipe data'), (req, res) => {
  const fs = require('fs');
  const { confirm } = req.body || {};
  if (confirm !== 'RESET') return res.status(400).json({ error: 'confirm:"RESET" required · 需输入 RESET 确认' });

  // Snapshot the live DB to /data first. If anything goes wrong after, the
  // admin can scp this file back into place + pm2 restart.
  const dataDir = path.join(__dirname, '../data');
  const dbPath  = path.join(dataDir, 'roots.db');
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const backup  = path.join(dataDir, `roots-pre-wipe-${ts}.db`);
  try { if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, backup); }
  catch (e) { return res.status(500).json({ error: 'Backup failed · 备份失败: ' + e.message }); }

  // Tables wiped, ordered child→parent so FK refs don't trip:
  const TABLES_WIPE = [
    // Recipe graph — recipe_materialize_collisions references BOTH recipes
    // and ingredients (§29's third addendum, 2026-08-27) so it must clear
    // before either.
    'recipe_materialize_collisions',
    'recipe_ingredients', 'recipe_steps', 'recipe_cost_data', 'recipes',
    // Items + history — product_build_lines also references ingredients
    // (Step 2, docs/tacet-product-build-lines-design.md), so it clears here
    // too, before every ingredients row is deleted below. Its other FK,
    // store_products, is not touched by this kitchen-only reset at all.
    'product_build_lines',
    'ingredient_price_history', 'price_alerts', 'ingredients',
    // Products
    'products',
    // PO graph
    'po_line_items', 'purchase_orders',
    // Finance
    'income_entries', 'expense_entries',
    // Sales
    'sales_entries',
    // Waste / production / kitchen / restock
    'waste_entries', 'production_batches',
    'kitchen_order_items', 'kitchen_orders',
    'restock_items', 'restock_orders',
    // Lookups (everything user-edited)
    'suppliers', 'packaging_types', 'categories',
  ];

  const counts = {};
  const tx = db.transaction(() => {
    for (const t of TABLES_WIPE) {
      try { counts[t] = db.prepare(`DELETE FROM ${t}`).run().changes; }
      catch (e) { counts[t] = 'error: ' + e.message; }
    }
    // Reset autoincrement so IDs start at 1 again on the next insert.
    try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN (" + TABLES_WIPE.map(()=>'?').join(',') + ")").run(...TABLES_WIPE); } catch {}
    // Re-seed the item_kind defaults so the Items page tab bar still
    // shows food/packaging/equipment/retail/other after the reset.
    const seedKind = db.prepare("INSERT INTO categories (kind, name, sort_order) VALUES ('item_kind', ?, ?)");
    [['food',0],['packaging',1],['equipment',2],['retail',3],['other',4]].forEach(([n,o]) => seedKind.run(n,o));
  });
  try { tx(); }
  catch (e) { return res.status(500).json({ error: 'Reset failed mid-transaction · 重置失败: ' + e.message, backup: path.basename(backup) }); }

  logActivity(req.user.id, req.user.username, 'factory_reset', 'system', null,
    { backup: path.basename(backup), counts }, req.ip);
  res.json({ success: true, backup: path.basename(backup), counts });
});

// POST /api/admin/repair-items — fixes two classes of import quirks on
// already-imported ingredients (so the user doesn't have to wipe + re-import):
//   1. Names where Zoho's "中文 English" pattern (or merged variants) ended
//      up with both halves stuck in name_cn. Re-runs the splitter on the
//      combined name and updates name_en + name_cn when the split improves.
//   2. recipe_unit + cost_per_unit not matching the new item_kind rules:
//      non-food rows are forced to recipe_unit='pcs'. The cost comes from
//      lib/ingredient-cost.js — the same derivation the ingredient form and
//      the PO price write-back use — and a row the helper cannot price keeps
//      the cost it already has.
// Returns counts so the user can see what changed.
// Rewrites ingredients.cost_per_unit across the whole catalogue — blocked
// outright (material cost columns).
router.post('/api/admin/repair-items', requireAuth, requireAdmin, blockCostWrite('material cost'), (req, res) => {
  // Mirrors the client splitCN — keep this in sync with public/app.html.
  function splitName(s) {
    if (!s) return { en: '', cn: '' };
    const trimmed = String(s).trim();
    const cjkRe = /[一-鿿　-〿＀-￯]+/g;
    const matches = [];
    let m;
    while ((m = cjkRe.exec(trimmed)) !== null) matches.push({ start: m.index, end: m.index + m[0].length });
    if (!matches.length) return { en: trimmed, cn: '' };
    const first = matches[0], last = matches[matches.length - 1];
    const before = trimmed.slice(0, first.start).trim();
    const after  = trimmed.slice(last.end).trim();
    const strip = x => x.replace(/^[\s\-·•·,，;；:：·]+|[\s\-·•·,，;；:：·]+$/g, '').trim();
    if (before && !after) return { en: strip(before), cn: strip(trimmed.slice(first.start)) };
    if (after  && !before) return { en: strip(after),  cn: strip(trimmed.slice(0, last.end)) };
    if (before && after) {
      const en = before.length >= after.length ? before : after;
      return { en: strip(en), cn: strip(trimmed.slice(first.start, last.end)) };
    }
    return { en: '', cn: strip(trimmed) };
  }

  // Same recipe_unit / cost rules as the client parser.
  function recipeUnitFor(buyUnit, kind, packUnit) {
    if (kind && kind !== 'food') return 'pcs';
    const b = (buyUnit || '').toLowerCase();
    if (['kg','g','lb','oz'].includes(b)) return 'g';
    if (['l','liter','litre','ml'].includes(b)) return 'ml';
    if (packUnit) {
      const p = packUnit.toLowerCase();
      if (['kg','g','lb','oz'].includes(p)) return 'g';
      if (['l','liter','litre','ml'].includes(p)) return 'ml';
    }
    return 'pcs';
  }
  // The cost is no longer derived here. deriveCpu() used to divide by the pack
  // contents whenever they were recorded, even for an item bought by the kilo,
  // where the schema says contents has no meaning (schema.sql:52-54). That read
  // priced an apple at ¥11.60 per GRAM and a 12.5 kg sack of almonds at ¥6/kg,
  // and it disagreed with the ingredient form on 29 live rows — all 29 of which
  // stored the form's answer, so this endpoint would have overwritten correct
  // costs with wrong ones the moment anyone ran it. lib/ingredient-cost.js is
  // now the only derivation, shared with the form and the PO write-back.
  //
  // It is keyed on the row's STORED recipe unit, not on the unit this endpoint
  // is about to write. That matters for the 14 equipment/packaging rows that
  // carry unit='g' on a per-piece item with no pack contents: the helper
  // declines them, and a decline means LEAVE THE COST ALONE. Feeding it the
  // reclassified 'pcs' instead would quietly turn those declines into
  // per-piece writes, which is exactly the fallback we are removing.

  // Hostname → platform classifier — must mirror client parseZohoCSV.
  // Tmall, JD, Pinduoduo, iHerb get their own platforms now (were lumped
  // under taobao/other before). Reclassifying writes to supplier_platform
  // when the URL clearly disagrees with the saved value.
  function platformFromUrl(url) {
    if (!url) return null;
    const s = String(url).toLowerCase();
    if (/1688\.com|alibaba\.com/.test(s))       return 'alibaba';
    if (/tmall\.com|tmall\.hk/.test(s))         return 'tmall';
    if (/taobao\.com/.test(s))                  return 'taobao';
    if (/iherb\.com|cn\.iherb/.test(s))         return 'iherb';
    if (/jd\.com|jd\.hk/.test(s))               return 'jd';
    if (/pinduoduo|yangkeduo|pdd\.com/.test(s)) return 'pdd';
    if (/wechat|weixin/.test(s))                return 'wechat';
    return 'other';
  }

  const rows = db.prepare('SELECT * FROM ingredients WHERE is_active = 1').all();
  let nameFixed = 0, unitFixed = 0, cpuFixed = 0, platformFixed = 0, cpuDeclined = 0;
  const upd = db.prepare('UPDATE ingredients SET name_en = ?, name_cn = ?, unit = ?, cost_per_unit = ?, supplier_platform = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      // 1. Name re-split: if name_cn contains Latin chars OR name_en is empty
      //    while name_cn has CJK + space + Latin pattern, re-run the splitter.
      let newEn = r.name_en || '';
      let newCn = r.name_cn || '';
      const looksMerged = (newCn && /[a-zA-Z]/.test(newCn) && /[一-鿿]/.test(newCn))
        || (!newEn && newCn);
      if (looksMerged) {
        const combined = (newEn ? newEn + ' ' : '') + newCn;
        const split = splitName(combined);
        if (split.en && split.cn && (split.en !== newEn || split.cn !== newCn)) {
          newEn = split.en; newCn = split.cn; nameFixed++;
        }
      }

      // 2. Recipe unit + cost re-derive
      const newUnit = recipeUnitFor(r.buy_unit, r.item_kind, r.pack_contents_unit);
      const derived = deriveCostPerUnit(r, r.buy_price);
      // A declined derivation keeps the stored cost. Writing 0 (what the old
      // code did for a priceless row) is not a cost — the Cost Sheet already
      // reads 0 as "Missing", so a hard 0 only destroys whatever was there.
      // Rounded to 6dp exactly as deriveCpu() did. Without this the switch
      // would rewrite ~168 rows purely to lengthen their decimals
      // (0.030482 -> 0.030481818181818183), which is churn, not a repair.
      const newCpu  = derived.cpu === null ? (+r.cost_per_unit || 0) : Math.round(derived.cpu * 1e6) / 1e6;
      if (derived.cpu === null) cpuDeclined++;
      const unitChanged = newUnit !== r.unit;
      const cpuChanged  = Math.abs((+newCpu) - (+r.cost_per_unit || 0)) > 0.0000001;

      // 3. supplier_platform re-classify from supplier_link hostname so the
      //    chip says "Tmall" instead of generic "Taobao", "iHerb" instead
      //    of "Other", etc. Wechat platforms with QR but no URL are left
      //    alone (URL is empty so platformFromUrl returns null).
      let newPlatform = r.supplier_platform || null;
      if (r.supplier_link && r.supplier_link.trim()) {
        const inferred = platformFromUrl(r.supplier_link);
        if (inferred && inferred !== newPlatform) {
          newPlatform = inferred;
        }
      }
      const platformChanged = newPlatform !== r.supplier_platform;

      // A made material (§29) is costed from its recipe, not from buy_price /
      // pack size — so this sweep must not re-derive it from purchase fields
      // that don't describe it. Its name, unit and platform are still repaired
      // below; only the cost is left to the recompute pass that owns it.
      const cpuLocked  = !!r.source_recipe_id;
      const writeCpu   = cpuLocked ? (+r.cost_per_unit || 0) : newCpu;
      const cpuWillMove = cpuChanged && !cpuLocked;

      if (unitChanged || cpuWillMove || platformChanged || newEn !== r.name_en || newCn !== r.name_cn) {
        upd.run(newEn || r.name_en, newCn || null, newUnit, writeCpu, newPlatform, r.id);
        if (unitChanged)     unitFixed++;
        if (cpuWillMove)     cpuFixed++;   // a locked (recipe-costed) row is not a cost "fix"
        if (platformChanged) platformFixed++;
      }
    }
    // Recompute trigger (§29 step 3), inside the same transaction as the
    // sweep itself — a failure here rolls back only this pass's own writes
    // (fireRecompute never throws), never the repairs already made above.
    if (cpuFixed > 0) fireRecompute(db, { source: 'admin.repair_items' });
  });
  tx();
  logActivity(req.user.id, req.user.username, 'repair_items', 'system', null, { nameFixed, unitFixed, cpuFixed, platformFixed, cpuDeclined }, req.ip);
  res.json({ success: true, scanned: rows.length, nameFixed, unitFixed, cpuFixed, platformFixed, cpuDeclined });
});

// POST restore — admin uploads a base64-encoded .db file. The current db is
// renamed to roots-pre-restore-<timestamp>.db as a safety net before the
// new file replaces it. The process must be restarted by pm2 afterwards
// (the route returns success with a `restart_required: true` flag).
// Overwrites the entire database file wholesale, roots.db and everything in
// it — a strict superset of material cost columns, recipe lines and recipe
// cost data (and of every Tacet table besides), so it is blocked outright
// rather than counted "ambiguous": there is no reading of this route under
// which it doesn't touch those three.
router.post('/api/admin/restore', requireAuth, requireAdmin, blockCostWrite('the entire database'), (req, res) => {
  const fs = require('fs');
  const { db_base64 } = req.body;
  if (!db_base64 || typeof db_base64 !== 'string') return res.status(400).json({ error: 'db_base64 (data URI or raw base64) required · 缺少 base64 数据' });

  // Strip optional data URI prefix
  const b64 = db_base64.replace(/^data:[^;]+;base64,/, '');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch (e) { return res.status(400).json({ error: 'Invalid base64 · base64 无效' }); }
  if (buf.length < 100) return res.status(400).json({ error: 'File too small to be a valid SQLite db · 文件太小,不是有效的 SQLite 数据库' });
  // Sanity check: SQLite files start with "SQLite format 3\0"
  if (buf.slice(0, 16).toString('ascii') !== 'SQLite format 3\0') {
    return res.status(400).json({ error: 'Not a valid SQLite database file · 不是有效的 SQLite 数据库文件' });
  }

  const dataDir = path.join(__dirname, '../data');
  const dbPath  = path.join(dataDir, 'roots.db');
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const safety  = path.join(dataDir, `roots-pre-restore-${ts}.db`);

  try {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, safety);
    fs.writeFileSync(dbPath, buf);
    logActivity(req.user.id, req.user.username, 'restore_upload', 'system', null, { size: buf.length, safety_backup: path.basename(safety) }, req.ip);
    res.json({ success: true, restart_required: true, safety_backup: path.basename(safety), size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET allergen audit — every product (Active by default) grouped by allergen,
// pulled from the master ingredient records linked through the product's recipe.
// "free_of" claims on the product are also returned so the UI can flag any
// contradictions (e.g. product claims "nut free" but recipe contains nuts).
router.get('/api/admin/allergen-audit', requireAuth, requireAdmin, (req, res) => {
  const includeAll = req.query.include === 'all';
  const products = db.prepare(
    includeAll
      ? 'SELECT id, name_en, name_cn, sku, status, recipe_id, free_of FROM products ORDER BY name_en'
      : "SELECT id, name_en, name_cn, sku, status, recipe_id, free_of FROM products WHERE status = 'Active' ORDER BY name_en"
  ).all();

  // Pre-load all ingredient allergens once
  const ingAllergens = {};
  db.prepare("SELECT id, name_en, allergens FROM ingredients WHERE allergens IS NOT NULL AND allergens != ''").all().forEach(i => {
    if (i.allergens) ingAllergens[i.id] = { name_en: i.name_en, allergens: i.allergens.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) };
  });

  // Pre-load recipe → ingredient_id list once
  const recipeIngs = {};
  db.prepare('SELECT recipe_id, ingredient_id FROM recipe_ingredients WHERE ingredient_id IS NOT NULL').all().forEach(r => {
    if (!recipeIngs[r.recipe_id]) recipeIngs[r.recipe_id] = new Set();
    recipeIngs[r.recipe_id].add(r.ingredient_id);
  });

  // Build the audit
  const byAllergen = {}; // allergen → [products]
  const productRows = [];
  for (const p of products) {
    const allergenSet = new Set();
    const allergenSources = {}; // allergen → [ingredient names]
    if (p.recipe_id && recipeIngs[p.recipe_id]) {
      for (const ingId of recipeIngs[p.recipe_id]) {
        const ia = ingAllergens[ingId];
        if (!ia) continue;
        for (const a of ia.allergens) {
          allergenSet.add(a);
          if (!allergenSources[a]) allergenSources[a] = [];
          allergenSources[a].push(ia.name_en);
        }
      }
    }
    const claims = (p.free_of || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    // Detect contradictions: claims X-free but allergen list contains X
    const claimMap = { gluten:['gluten','wheat'], nuts:['nuts','peanut','almond','cashew','walnut','hazelnut','pecan'], soy:['soy','soya'], dairy:['dairy','milk','lactose','cheese','butter'], egg:['egg','eggs'], '5spice':['5spice','five-spice','star anise','clove','cinnamon','fennel','sichuan pepper'] };
    const contradictions = [];
    for (const claim of claims) {
      const matchers = claimMap[claim] || [claim];
      for (const a of allergenSet) {
        if (matchers.some(m => a.includes(m))) contradictions.push({ claim, allergen: a, sources: allergenSources[a] });
      }
    }
    const row = {
      id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, status: p.status,
      recipe_id: p.recipe_id, free_of: p.free_of,
      allergens: [...allergenSet], allergen_sources: allergenSources,
      contradictions,
    };
    productRows.push(row);
    for (const a of allergenSet) {
      if (!byAllergen[a]) byAllergen[a] = [];
      byAllergen[a].push({ id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, sources: allergenSources[a] });
    }
  }
  res.json({ success: true, data: {
    products: productRows,
    by_allergen: byAllergen,
    total_products: productRows.length,
    products_with_allergens: productRows.filter(p => p.allergens.length).length,
    products_with_contradictions: productRows.filter(p => p.contradictions.length).length,
  }});
});

module.exports = router;
