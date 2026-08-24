const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const { currentTenantId } = require('../lib/tenant-db');
const router = express.Router();

// ── Tenant scope for the supplier endpoints ────────────────────────────────
// `suppliers` is SHARED with retail purchasing, which has filtered by tenant
// since the column was added. This half never did: every read below was
// `WHERE is_active = 1` with no tenant predicate, and the create never set the
// column, so it took the DEFAULT 1. Invisible with one tenant; a §0 violation
// the moment there are two.
//
// A kitchen request never enters a tenant ALS scope — the host->tenant
// middleware lives in routes/retail.js, is gated to paths under `/api/retail/`,
// and this router is mounted before it — so currentTenantId() resolves to
// ROOTS_TENANT_ID here. Written as a call rather than a literal 1 so a kitchen
// realm that IS scoped one day is correct without an edit.
const tid = () => Number(currentTenantId()) || 1;

// COALESCE, NOT a bare equality. A row whose tenant_id is somehow NULL belongs
// to Roots and must not vanish from the list. Measured on production
// 2026-08-24: 234 supplier rows, 0 with a NULL tenant_id, all 234 already
// tagged 1 — because addColumn() gave the column a non-NULL DEFAULT, which
// SQLite applies to every existing row at ALTER time. The backfill everyone
// expected to need had therefore already happened. The COALESCE is what makes
// this filter safe to merge in ANY order relative to a backfill, rather than
// resting on that measurement staying true.
const TENANT_SCOPE = 'COALESCE(s.tenant_id, 1) = ?';

// Shared lookup endpoints — replaces per-browser localStorage with server-side
// canonical lists so multiple users see the same categories / packaging types.

// ── Categories (recipe / product) ───────────────────────────────────────────
// 'accounting' is shared between PO line items + ingredient.accounting_category
// so the buyer picks once and finance posts land in matching buckets.
// 'role' lets admins add custom user roles beyond the built-in four.
// 'item_kind' is the editable list of buckets that filter the Items page
// tab bar (food / packaging / equipment / retail / other by default — admin
// can add/rename/remove). Each ingredients row references one by name in
// its item_kind column.
const VALID_KINDS = ['recipe', 'product', 'accounting', 'role', 'item_kind', 'payment_method'];

router.get('/api/categories/:kind', requireAuth, (req, res) => {
  if (!VALID_KINDS.includes(req.params.kind)) return res.status(400).json({ error: 'Invalid kind · 类型无效' });
  const rows = db.prepare('SELECT id, name FROM categories WHERE kind = ? ORDER BY sort_order, name').all(req.params.kind);
  res.json({ success: true, data: rows });
});

router.post('/api/categories/:kind', requireAuth, (req, res) => {
  if (!VALID_KINDS.includes(req.params.kind)) return res.status(400).json({ error: 'Invalid kind · 类型无效' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required · 名称必填' });
  try {
    const result = db.prepare('INSERT INTO categories (kind, name) VALUES (?,?)').run(req.params.kind, name);
    logActivity(req.user.id, req.user.username, 'create', 'category', result.lastInsertRowid, { kind: req.params.kind, name }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid, name });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'Already exists · 已存在' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/categories/:kind/:id', requireAuth, requireDelete, (req, res) => {
  if (!VALID_KINDS.includes(req.params.kind)) return res.status(400).json({ error: 'Invalid kind · 类型无效' });
  const r = db.prepare('DELETE FROM categories WHERE id = ? AND kind = ?').run(req.params.id, req.params.kind);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'category', req.params.id, { kind: req.params.kind }, req.ip);
  res.json({ success: true });
});

// ── Packaging Types ─────────────────────────────────────────────────────────
router.get('/api/packaging-types', requireAuth, (req, res) => {
  res.json({ success: true, data: db.prepare('SELECT * FROM packaging_types ORDER BY name').all() });
});

router.post('/api/packaging-types', requireAuth, (req, res) => {
  const { name, name_cn, cost, image_data } = req.body;
  if (!name) return res.status(400).json({ error: 'name required · 名称必填' });
  const c = parseFloat(cost) || 0;
  const result = db.prepare('INSERT INTO packaging_types (name, name_cn, cost, image_data) VALUES (?,?,?,?)')
    .run(name, name_cn || null, c, image_data || null);
  logActivity(req.user.id, req.user.username, 'create', 'packaging_type', result.lastInsertRowid, { name, cost: c }, req.ip);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/api/packaging-types/:id', requireAuth, (req, res) => {
  const { name, name_cn, cost, image_data } = req.body;
  const existing = db.prepare('SELECT * FROM packaging_types WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  const c = parseFloat(cost) || 0;
  db.prepare('UPDATE packaging_types SET name = ?, name_cn = ?, cost = ?, image_data = ? WHERE id = ?')
    .run(name || existing.name, name_cn || null, c, image_data === undefined ? existing.image_data : (image_data || null), req.params.id);
  res.json({ success: true });
});

router.delete('/api/packaging-types/:id', requireAuth, requireDelete, (req, res) => {
  const r = db.prepare('DELETE FROM packaging_types WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'packaging_type', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── Staff (active users, minimal projection) ────────────────────────────────
// Used by Production-log + waste-log dropdowns so staff can be picked from a
// list instead of typed free-form. Returns only safe fields — no perms, no
// password, no last_login. Any authenticated user can read this.
router.get('/api/staff', requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT id, username, display_name, role FROM users WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE, username"
  ).all();
  res.json({ success: true, data: rows });
});

// ── Suppliers ───────────────────────────────────────────────────────────────
// List payload deliberately omits the four base64 *_data columns
// (business_license_data, permits_data, payment_qr_data, channel_qr_data)
// because the supplier picker / table never renders them — and shipping
// them was pushing the response close to 1 MB. Anything that needs the
// real images calls GET /api/suppliers/:id (full row) or the document
// streaming endpoints.
const SUPPLIER_LIST_COLS = `
  s.id, s.name, s.name_cn,
  s.contact_name, s.contact_phone, s.contact_wechat,
  s.payment_terms, s.payment_method,
  s.rating, s.notes,
  s.is_active, s.created_at, s.updated_at,
  s.products_supplied, s.price_info,
  s.channel_type, s.channel_link,
  (s.business_license_data IS NOT NULL AND s.business_license_data != '') AS has_business_license_data,
  (s.permits_data          IS NOT NULL AND s.permits_data != '')          AS has_permits_data,
  (s.payment_qr_data       IS NOT NULL AND s.payment_qr_data != '')       AS has_payment_qr_data,
  (s.channel_qr_data       IS NOT NULL AND s.channel_qr_data != '')       AS has_channel_qr_data
`;

router.get('/api/suppliers', requireAuth, (req, res) => {
  // has_* counts power the list-view chips (License / Permit / Payment QR).
  // We don't ship the heavy `data` blobs in list payloads.
  const rows = db.prepare(`
    SELECT ${SUPPLIER_LIST_COLS},
      (SELECT COUNT(*) FROM ingredients i WHERE i.supplier = s.name) AS ingredient_count,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id = s.id AND kind = 'license')    AS has_license,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id = s.id AND kind = 'permit')     AS has_permit,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id = s.id AND kind = 'payment_qr') AS has_payment_qr,
      (SELECT COUNT(*) FROM supplier_documents WHERE supplier_id = s.id)                          AS doc_count
    FROM suppliers s
    WHERE s.is_active = 1 AND COALESCE(s.tenant_id, 1) = ?
    ORDER BY s.name
  `).all(tid());
  // Mirror the legacy *_data truthy-check shape so any front-end that does
  // `if (s.payment_qr_data)` keeps working without code changes — the actual
  // base64 bytes come from GET /api/suppliers/:id when the user opens the row.
  for (const r of rows) {
    r.business_license_data = r.has_business_license_data ? 1 : null;
    r.permits_data          = r.has_permits_data          ? 1 : null;
    r.payment_qr_data       = r.has_payment_qr_data       ? 1 : null;
    r.channel_qr_data       = r.has_channel_qr_data       ? 1 : null;
    delete r.has_business_license_data;
    delete r.has_permits_data;
    delete r.has_payment_qr_data;
    delete r.has_channel_qr_data;
  }
  res.json({ success: true, data: rows });
});

router.get('/api/suppliers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers s WHERE s.id = ? AND ' + TENANT_SCOPE).get(req.params.id, tid());
  if (!s) return res.status(404).json({ error: 'Not found · 未找到' });
  const ingredients = db.prepare('SELECT id, name_en, name_cn, sku, buy_price, buy_unit FROM ingredients WHERE supplier = ? AND is_active = 1 ORDER BY name_en').all(s.name);
  // Metadata only — `data` is fetched on demand via /documents/:docId so the
  // detail payload stays under a few KB regardless of how many docs exist.
  const documents = db.prepare(`SELECT id, kind, label, filename, mime_type, size_bytes, uploaded_at
                                  FROM supplier_documents WHERE supplier_id = ?
                                  ORDER BY kind, uploaded_at`).all(s.id);
  res.json({ success: true, data: { ...s, ingredients, documents } });
});

// Fetch a single document's full data (base64 URI). Open to any authed user
// since they can already see supplier list/details.
router.get('/api/suppliers/:id/documents/:docId', requireAuth, (req, res) => {
  // supplier_documents carries no tenant_id of its own; it is scoped through
  // its parent, so the join is what keeps one tenant out of another's files.
  const doc = db.prepare(
    'SELECT d.* FROM supplier_documents d JOIN suppliers s ON s.id = d.supplier_id ' +
    'WHERE d.id = ? AND d.supplier_id = ? AND ' + TENANT_SCOPE
  ).get(req.params.docId, req.params.id, tid());
  if (!doc) return res.status(404).json({ error: 'Not found · 未找到' });
  res.json({ success: true, data: doc });
});

const VALID_DOC_KINDS = ['license', 'permit', 'payment_qr', 'other'];

router.post('/api/suppliers/:id/documents', requireAuth, requirePermission('suppliers'), (req, res) => {
  const supplier = db.prepare('SELECT s.id, s.name FROM suppliers s WHERE s.id = ? AND ' + TENANT_SCOPE).get(req.params.id, tid());
  if (!supplier) return res.status(404).json({ error: 'Supplier not found · 供应商未找到' });
  const { kind, label, filename, mime_type, data } = req.body;
  if (!VALID_DOC_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind · 类型无效' });
  if (!data || typeof data !== 'string' || !data.startsWith('data:')) {
    return res.status(400).json({ error: 'Bad data URI · 数据格式错误' });
  }
  const b64 = (data.split(',')[1] || '');
  const size = Math.floor(b64.length * 3 / 4);
  // Cap individual uploads at 10MB raw — base64 inflates ~33%, so the row is
  // ~13MB which SQLite handles fine but anything bigger is a misuse.
  if (size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 10MB) · 文件过大(最大10MB)' });
  const result = db.prepare(`INSERT INTO supplier_documents
    (supplier_id, kind, label, filename, mime_type, size_bytes, data)
    VALUES (?,?,?,?,?,?,?)`).run(
      supplier.id, kind, label || null, filename || null,
      mime_type || 'application/octet-stream', size, data
  );
  logActivity(req.user.id, req.user.username, 'create', 'supplier_document', result.lastInsertRowid,
              { supplier_id: supplier.id, supplier: supplier.name, kind, filename, size }, req.ip);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/api/suppliers/:id/documents/:docId', requireAuth, requirePermission('suppliers'), requireDelete, (req, res) => {
  const r = db.prepare(
    'DELETE FROM supplier_documents WHERE id = ? AND supplier_id = ? AND supplier_id IN ' +
    '(SELECT s.id FROM suppliers s WHERE ' + TENANT_SCOPE + ')')
              .run(req.params.docId, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'supplier_document', req.params.docId,
              { supplier_id: req.params.id }, req.ip);
  res.json({ success: true });
});

// GET routes stay open to all authed users — supplier dropdowns are
// referenced from PO / Items / Finance, places where users without
// supplier-management rights still need the list. Write endpoints
// gate behind requirePermission('suppliers').
router.post('/api/suppliers', requireAuth, requirePermission('suppliers'), (req, res) => {
  const { name, name_cn, contact_name, contact_phone, contact_wechat, payment_terms, payment_method, rating, notes,
          products_supplied, price_info, business_license_data, permits_data, payment_qr_data,
          channel_type, channel_link, channel_qr_data } = req.body;
  if (!name) return res.status(400).json({ error: 'name required · 名称必填' });
  try {
    const result = db.prepare(`INSERT INTO suppliers
      (name, name_cn, contact_name, contact_phone, contact_wechat, payment_terms, payment_method, rating, notes,
       products_supplied, price_info, business_license_data, permits_data, payment_qr_data,
       channel_type, channel_link, channel_qr_data, tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      name.trim(), name_cn || null, contact_name || null, contact_phone || null,
      contact_wechat || null, payment_terms || null, payment_method || null,
      Math.max(0, Math.min(5, parseInt(rating)||0)), notes || null,
      products_supplied || null, price_info || null,
      business_license_data || null, permits_data || null, payment_qr_data || null,
      channel_type || null, channel_link || null, channel_qr_data || null,
      // Stamp the creating tenant. This was omitted, so every kitchen-created
      // supplier has been relying on the column DEFAULT to land on Roots.
      tid()
    );
    logActivity(req.user.id, req.user.username, 'create', 'supplier', result.lastInsertRowid, { name }, req.ip);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'A supplier with that name already exists · 该供应商名称已存在' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/suppliers/:id', requireAuth, requirePermission('suppliers'), (req, res) => {
  const existing = db.prepare('SELECT * FROM suppliers s WHERE s.id = ? AND ' + TENANT_SCOPE).get(req.params.id, tid());
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  const { name, name_cn, contact_name, contact_phone, contact_wechat, payment_terms, payment_method, rating, notes, is_active,
          products_supplied, price_info, business_license_data, permits_data, payment_qr_data,
          channel_type, channel_link, channel_qr_data } = req.body;
  // Image fields use sentinel '__keep__' to preserve the existing value
  // when the form didn't touch them (so a save round-trip without a file
  // re-upload doesn't null out a previously-uploaded license/QR).
  const keepImg = (incoming, current) => incoming === '__keep__' ? current : (incoming || null);
  try {
    db.prepare(`UPDATE suppliers SET
      name=?, name_cn=?, contact_name=?, contact_phone=?, contact_wechat=?,
      payment_terms=?, payment_method=?, rating=?, notes=?, is_active=?,
      products_supplied=?, price_info=?,
      business_license_data=?, permits_data=?, payment_qr_data=?,
      channel_type=?, channel_link=?, channel_qr_data=?,
      updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND COALESCE(tenant_id, 1) = ?`).run(
      name || existing.name, name_cn || null, contact_name || null, contact_phone || null,
      contact_wechat || null, payment_terms || null,
      payment_method !== undefined ? (payment_method || null) : existing.payment_method,
      Math.max(0, Math.min(5, parseInt(rating ?? existing.rating) || 0)), notes || null,
      is_active == null ? existing.is_active : (is_active ? 1 : 0),
      products_supplied !== undefined ? (products_supplied || null) : existing.products_supplied,
      price_info        !== undefined ? (price_info        || null) : existing.price_info,
      keepImg(business_license_data, existing.business_license_data),
      keepImg(permits_data,          existing.permits_data),
      keepImg(payment_qr_data,       existing.payment_qr_data),
      channel_type !== undefined ? (channel_type || null) : existing.channel_type,
      channel_link !== undefined ? (channel_link || null) : existing.channel_link,
      keepImg(channel_qr_data, existing.channel_qr_data),
      req.params.id, tid()
    );
    // If the name changed, propagate to ingredients table to keep the link.
    if (name && name !== existing.name) {
      db.prepare('UPDATE ingredients SET supplier = ? WHERE supplier = ?').run(name, existing.name);
    }
    logActivity(req.user.id, req.user.username, 'update', 'supplier', req.params.id, { name }, req.ip);
    res.json({ success: true });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ error: 'A supplier with that name already exists · 该供应商名称已存在' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/suppliers/:id', requireAuth, requirePermission('suppliers'), requireDelete, (req, res) => {
  // Soft delete (preserves the supplier name on existing ingredients)
  const r = db.prepare('UPDATE suppliers SET is_active = 0 WHERE id = ? AND COALESCE(tenant_id, 1) = ?').run(req.params.id, tid());
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'supplier', req.params.id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
