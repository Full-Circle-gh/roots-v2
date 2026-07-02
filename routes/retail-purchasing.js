// Retail purchasing — the online store's buying department.
//
// Shares the kitchen procurement engine (suppliers, supplier_documents,
// purchase_orders, po_line_items, expense_entries) but lives behind the Mini
// App Backend operator gate. Differences from the kitchen module:
//   • POs carry scope='retail' + a retail_stores.id they restock into
//     (kitchen POs stay scope='kitchen'; the kitchen list filters them apart)
//   • Line items reference store_products (store_product_id), never ingredients
//   • Receiving pushes goods into retail_store_stock via inventory.adjustStock,
//     which writes the stock ledger AND fans out to Meituan/Guanyi/Eleme sync.
//     po_line_items.stock_applied_qty remembers what's already been applied so
//     a corrected receive only moves the difference (idempotent, both ways).
//   • Expense auto-posting mirrors routes/purchases.js postPOExpenses —
//     retail POs land in Finance → Expenses the moment they're Ordered.
//   • created_by stays NULL: it FKs kitchen `users`, and backend operators live
//     in tenant_users (separate id space; FK enforcement is ON). The actor is
//     recorded in the activity log + stock ledger instead.
//
// NOTE (multi-tenant): the purchasing tables live on the shared control-plane
// db today. When a second tenant needs purchasing, these tables need a
// tenant_id column + scoping — flagged in the roadmap, not built here.

const express = require('express');
const db = require('../database');
const { tdb } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
const { logActivity } = require('../middleware/auth');
const { requireRetailAdmin } = require('./retail');

const router = express.Router();

const PO_STATUSES = new Set(['Requested', 'Ordered', 'Delivered', 'Cancelled']);
const VALID_INVOICE = new Set(['not_received', 'received', 'no_invoice']);

// Next RPO number from the highest existing suffix (not a row count, so a
// deleted PO can never cause a UNIQUE collision on po_number).
function nextRetailPONumber() {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(po_number, 5) AS INTEGER)) AS n FROM purchase_orders WHERE po_number LIKE 'RPO-%'"
  ).get();
  return 'RPO-' + String((row?.n || 0) + 1).padStart(4, '0');
}

function getRetailPO(id) {
  return db.prepare(
    "SELECT * FROM purchase_orders WHERE id = ? AND COALESCE(scope,'kitchen') = 'retail'"
  ).get(id);
}

function actorLabel(req) {
  return req.user?.display_name || req.user?.username || null;
}

// ── Expense auto-posting — mirror of routes/purchases.js postPOExpenses ────
// Idempotent DELETE-then-INSERT keyed on po_id; posts on Ordered/Delivered,
// wiped when the PO drops back to Requested (or is Cancelled). Amount uses
// qty_received once receiving started, so shortages adjust the books.
function postRetailPOExpenses(poId) {
  const po = db.prepare('SELECT id, date, supplier, po_number, status FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) return { skipped: 'po-missing' };
  db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
  if (!['Ordered', 'Delivered'].includes(po.status)) return { skipped: 'not-postable' };
  const groups = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(expense_category),''),'门店进货 Retail stock') AS category,
           SUM(COALESCE(qty_received, qty) * COALESCE(cost_per_unit, 0))       AS amount,
           COUNT(*)                                                            AS line_count
      FROM po_line_items
     WHERE po_id = ? AND COALESCE(qty_received, qty) > 0
     GROUP BY 1
  `).all(poId);
  const insert = db.prepare('INSERT INTO expense_entries (date, amount, category, description, po_id) VALUES (?,?,?,?,?)');
  let inserted = 0, total = 0;
  for (const g of groups) {
    if (!g.amount || g.amount <= 0) continue;
    const desc = `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · ${g.line_count} line${g.line_count === 1 ? '' : 's'}`;
    insert.run(po.date, +g.amount, g.category, desc, poId);
    inserted++; total += +g.amount;
  }
  return { inserted, total };
}

// ── Stock application — push received goods into store inventory ───────────
// good = qty_received − damaged_qty; apply (good − stock_applied_qty) as a
// delta through inventory.adjustStock (ledger row + channel sync fan-out).
// Safe to call repeatedly; corrections move stock in either direction.
function applyReceivedToStock(poId, req) {
  const po = getRetailPO(poId);
  if (!po || !po.store_id) return { applied: 0 };
  const lines = db.prepare(`
    SELECT id, store_product_id, qty_received, damaged_qty, stock_applied_qty, name_en
      FROM po_line_items WHERE po_id = ?
  `).all(poId);
  let applied = 0;
  for (const l of lines) {
    if (!l.store_product_id || l.qty_received == null) continue;
    // Whole units: retail_store_stock.physical_qty is an INTEGER, so both the
    // applied bookkeeping and the delta are rounded the same way — repeated
    // saves always converge instead of drifting on a fractional entry.
    const good = Math.round(Math.max(0, (parseFloat(l.qty_received) || 0) - (parseFloat(l.damaged_qty) || 0)));
    const alreadyApplied = Math.round(parseFloat(l.stock_applied_qty) || 0);
    const delta = good - alreadyApplied;
    if (delta !== 0) {
      inventory.adjustStock({
        storeId: po.store_id, productId: l.store_product_id, deltaQty: delta,
        actorUserId: req.user?.id || null, actorLabel: actorLabel(req),
        note: po.po_number, reason: 'restock',
      });
      applied++;
    }
    db.prepare('UPDATE po_line_items SET stock_applied_qty = ? WHERE id = ?').run(good, l.id);
  }
  return { applied };
}

// ═══ Suppliers (shared master — same table the kitchen uses) ═══════════════

router.get('/api/retail-admin/suppliers', requireRetailAdmin, (req, res) => {
  const includeInactive = req.query.all === '1';
  const rows = db.prepare(`
    SELECT s.id, s.name, s.name_cn, s.contact_name, s.contact_phone, s.contact_wechat,
           s.payment_terms, s.payment_method, s.rating, s.notes, s.is_active,
           s.channel_type, s.channel_link, s.products_supplied, s.price_info,
           s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM supplier_documents d WHERE d.supplier_id = s.id) AS doc_count,
           (SELECT COUNT(*) FROM purchase_orders po
             WHERE po.supplier = s.name AND COALESCE(po.scope,'kitchen') = 'retail') AS po_count,
           (SELECT MAX(po.date) FROM purchase_orders po
             WHERE po.supplier = s.name AND COALESCE(po.scope,'kitchen') = 'retail') AS last_po_date
      FROM suppliers s
     ${includeInactive ? '' : 'WHERE s.is_active = 1'}
     ORDER BY s.name COLLATE NOCASE
  `).all();
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  // Base64 payloads stay out of the detail read — documents fetch individually.
  delete s.channel_qr_data; delete s.business_license_data;
  delete s.permits_data; delete s.payment_qr_data;
  const documents = db.prepare(`
    SELECT id, kind, label, filename, mime_type, size_bytes, uploaded_at
      FROM supplier_documents WHERE supplier_id = ? ORDER BY uploaded_at DESC
  `).all(s.id);
  const recentPOs = db.prepare(`
    SELECT id, po_number, date, status,
           (SELECT SUM(COALESCE(total_cost,0)) FROM po_line_items WHERE po_id = purchase_orders.id) AS total
      FROM purchase_orders
     WHERE supplier = ? AND COALESCE(scope,'kitchen') = 'retail'
     ORDER BY date DESC, id DESC LIMIT 10
  `).all(s.name);
  res.json({ success: true, data: { ...s, documents, recent_pos: recentPOs } });
});

const SUPPLIER_FIELDS = ['name', 'name_cn', 'contact_name', 'contact_phone', 'contact_wechat',
  'payment_terms', 'payment_method', 'rating', 'notes', 'channel_type', 'channel_link',
  'products_supplied', 'price_info'];

router.post('/api/retail-admin/suppliers', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  if (db.prepare('SELECT id FROM suppliers WHERE name = ?').get(name)) {
    return res.status(409).json({ success: false, error: 'name_taken' });
  }
  const info = db.prepare(`
    INSERT INTO suppliers (name, name_cn, contact_name, contact_phone, contact_wechat,
                           payment_terms, payment_method, rating, notes, channel_type,
                           channel_link, products_supplied, price_info, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    name, b.name_cn || null, b.contact_name || null, b.contact_phone || null, b.contact_wechat || null,
    b.payment_terms || null, b.payment_method || null,
    Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)),
    b.notes || null, b.channel_type || null, b.channel_link || null,
    b.products_supplied || null, b.price_info || null,
  );
  logActivity(req.user.id, req.user.username, 'create', 'supplier', info.lastInsertRowid, { name }, req.ip);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/api/retail-admin/suppliers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const s = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  if ('name' in b) {
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name_required' });
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND id != ?').get(name, s.id);
    if (dup) return res.status(409).json({ success: false, error: 'name_taken' });
    b.name = name;
  }
  const sets = [], vals = [];
  for (const k of SUPPLIER_FIELDS) {
    if (k in b) {
      sets.push(`${k} = ?`);
      vals.push(k === 'rating' ? Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)) : (b[k] ?? null));
    }
  }
  if ('is_active' in b) { sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0); }
  if (!sets.length) return res.json({ success: true });
  vals.push(s.id);
  db.prepare(`UPDATE suppliers SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
  // Historical POs keep the old supplier name on purpose — they're a snapshot
  // of what was ordered from whom at the time (same rule as the kitchen side).
  logActivity(req.user.id, req.user.username, 'update', 'supplier', s.id, b, req.ip);
  res.json({ success: true });
});

// Soft-delete: keep the row (and its name) so historical POs stay attributable.
router.delete('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare('UPDATE suppliers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(s.id);
  logActivity(req.user.id, req.user.username, 'delete', 'supplier', s.id, {}, req.ip);
  res.json({ success: true });
});

// Documents — base64 data URI payloads (images / PDFs), 10MB per file.
router.post('/api/retail-admin/suppliers/:id/documents', requireRetailAdmin, express.json({ limit: '15mb' }), (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  if (!b.data || typeof b.data !== 'string') return res.status(400).json({ success: false, error: 'data_required' });
  if (b.data.length > 14 * 1024 * 1024) return res.status(413).json({ success: false, error: 'too_large' });
  const kind = ['license', 'permit', 'payment_qr', 'other'].includes(b.kind) ? b.kind : 'other';
  const info = db.prepare(`
    INSERT INTO supplier_documents (supplier_id, kind, label, filename, mime_type, size_bytes, data)
    VALUES (?,?,?,?,?,?,?)
  `).run(s.id, kind, b.label || null, b.filename || null, b.mime_type || null,
         b.size_bytes != null ? parseInt(b.size_bytes, 10) : null, b.data);
  logActivity(req.user.id, req.user.username, 'create', 'supplier_document', info.lastInsertRowid,
              { supplier_id: s.id, kind, filename: b.filename }, req.ip);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.get('/api/retail-admin/suppliers/:id/documents/:docId', requireRetailAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM supplier_documents WHERE id = ? AND supplier_id = ?')
    .get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: doc });
});

router.delete('/api/retail-admin/suppliers/:id/documents/:docId', requireRetailAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM supplier_documents WHERE id = ? AND supplier_id = ?')
    .run(req.params.docId, req.params.id);
  if (!info.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'supplier_document', +req.params.docId,
              { supplier_id: +req.params.id }, req.ip);
  res.json({ success: true });
});

// ═══ Purchase orders (scope='retail') ══════════════════════════════════════

router.get('/api/retail-admin/purchases', requireRetailAdmin, (req, res) => {
  const { status, search, month, store_id } = req.query;
  let q = `
    SELECT po.*,
           (SELECT COUNT(*) FROM po_line_items i WHERE i.po_id = po.id)                        AS line_count,
           (SELECT SUM(COALESCE(i.total_cost,0)) FROM po_line_items i WHERE i.po_id = po.id)   AS total_cost,
           (SELECT COUNT(*) FROM po_line_items i WHERE i.po_id = po.id AND i.qty_received IS NOT NULL) AS received_lines
      FROM purchase_orders po
     WHERE COALESCE(po.scope,'kitchen') = 'retail'`;
  const params = [];
  if (status)   { q += ' AND po.status = ?'; params.push(status); }
  if (store_id) { q += ' AND po.store_id = ?'; params.push(parseInt(store_id, 10)); }
  if (month)    { q += ' AND substr(po.date, 1, 7) = ?'; params.push(String(month).slice(0, 7)); }
  if (search) {
    q += ` AND (po.po_number LIKE ? OR po.supplier LIKE ? OR po.id IN (
      SELECT po_id FROM po_line_items WHERE name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?))`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  q += ' ORDER BY po.date DESC, po.id DESC';
  const pos = db.prepare(q).all(...params);
  // Store names come from the tenant connection (retail_stores is data-plane).
  const stores = new Map(inventory.listStores({ activeOnly: false }).map(s => [s.id, s]));
  for (const po of pos) {
    const s = po.store_id ? stores.get(po.store_id) : null;
    po.store_name_en = s?.name_en || null;
    po.store_name_cn = s?.name_cn || null;
  }
  res.json({ success: true, data: pos });
});

router.get('/api/retail-admin/purchases/:id', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order, id').all(po.id);
  // Current shelf qty at the PO's store for context next to each line.
  if (po.store_id) {
    const ids = items.map(i => i.store_product_id).filter(Boolean);
    if (ids.length) {
      const rows = tdb().prepare(`
        SELECT product_id, physical_qty FROM retail_store_stock
         WHERE store_id = ? AND product_id IN (${ids.map(() => '?').join(',')})
      `).all(po.store_id, ...ids);
      const byId = new Map(rows.map(r => [r.product_id, r.physical_qty]));
      for (const i of items) i.current_stock = i.store_product_id ? (byId.get(i.store_product_id) ?? 0) : null;
    }
  }
  const expenses = db.prepare('SELECT id, date, amount, category, description FROM expense_entries WHERE po_id = ? ORDER BY id').all(po.id);
  const store = po.store_id ? inventory.getStore(po.store_id) : null;
  res.json({ success: true, data: {
    ...po, items, expenses,
    store_name_en: store?.name_en || null, store_name_cn: store?.name_cn || null,
  } });
});

// Per-line cost history: for every line with a store_product_id, the latest
// prior retail PO line + lifetime stats. Drives "last paid ¥X on RPO-0007".
router.get('/api/retail-admin/purchases/:id/history', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const items = db.prepare('SELECT id, store_product_id FROM po_line_items WHERE po_id = ?').all(po.id);
  const prevStmt = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date, po.supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail'
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  const statsStmt = db.prepare(`
    SELECT COUNT(*) AS total_orders, AVG(pli.cost_per_unit) AS avg_price,
           MIN(pli.cost_per_unit) AS min_price, MAX(pli.cost_per_unit) AS max_price,
           SUM(pli.qty) AS total_qty
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail'`);
  const out = {};
  for (const it of items) {
    if (!it.store_product_id) continue;
    out[it.store_product_id] = {
      previous: prevStmt.get(it.store_product_id, po.id) || null,
      stats: statsStmt.get(it.store_product_id, po.id) || null,
    };
  }
  res.json({ success: true, data: out });
});

function insertLineItems(poId, items, headerSupplier) {
  const insertItem = db.prepare(`INSERT INTO po_line_items
    (po_id, store_product_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost,
     expense_category, supplier_name, purchase_channel, invoice_status, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach((item, i) => {
    const qty = parseFloat(item.qty) || 0;
    const cpu = parseFloat(item.cost_per_unit) || 0;
    const status = VALID_INVOICE.has(item.invoice_status) ? item.invoice_status : 'not_received';
    insertItem.run(
      poId, item.store_product_id || null, item.name_en || '', item.name_cn || null, item.sku || null,
      qty, item.unit || 'pcs', cpu, qty * cpu, item.expense_category || null,
      item.supplier_name || headerSupplier || null, item.purchase_channel || null, status, i,
    );
  });
}

router.post('/api/retail-admin/purchases', requireRetailAdmin, express.json(), (req, res) => {
  const { date, delivery_date, supplier, store_id, notes, items } = req.body || {};
  if (!date) return res.status(400).json({ success: false, error: 'date_required' });
  const storeId = parseInt(store_id, 10);
  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(400).json({ success: false, error: 'store_required' });
  }
  try {
    const po_number = nextRetailPONumber();
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO purchase_orders (po_number, date, delivery_date, status, supplier, notes, source, scope, store_id, created_by)
        VALUES (?,?,?,'Requested',?,?,'manual','retail',?,NULL)
      `).run(po_number, date, delivery_date || null, supplier || null, notes || null, storeId);
      const poId = result.lastInsertRowid;
      if (Array.isArray(items) && items.length) insertLineItems(poId, items, supplier);
      return poId;
    });
    const poId = tx();
    logActivity(req.user.id, req.user.username, 'create', 'purchase_order', poId, { po_number, scope: 'retail' }, req.ip);
    res.json({ success: true, id: poId, po_number });
  } catch (e) {
    console.error('[retail-purchasing create]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/api/retail-admin/purchases/:id', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const { date, delivery_date, supplier, store_id, notes, items } = req.body || {};
  // Once receiving has touched stock, the store + lines are frozen — a moved
  // PO would strand its applied quantities at the old store.
  const applied = db.prepare(
    'SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(stock_applied_qty,0) > 0'
  ).get(po.id).c;
  if (applied && (Array.isArray(items) || (store_id && parseInt(store_id, 10) !== po.store_id))) {
    return res.status(409).json({ success: false, error: 'already_receiving' });
  }
  const storeId = store_id ? parseInt(store_id, 10) : po.store_id;
  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(400).json({ success: false, error: 'store_required' });
  }
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE purchase_orders SET date = ?, delivery_date = ?, supplier = ?, notes = ?, store_id = ?,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(date || po.date, delivery_date || null, supplier || null, notes || null, storeId, po.id);
    if (Array.isArray(items)) {
      db.prepare('DELETE FROM po_line_items WHERE po_id = ?').run(po.id);
      insertLineItems(po.id, items, supplier);
    }
  });
  tx();
  postRetailPOExpenses(po.id);
  logActivity(req.user.id, req.user.username, 'update', 'purchase_order', po.id, { scope: 'retail' }, req.ip);
  res.json({ success: true });
});

router.put('/api/retail-admin/purchases/:id/status', requireRetailAdmin, express.json(), (req, res) => {
  const { status } = req.body || {};
  if (!PO_STATUSES.has(status)) return res.status(400).json({ success: false, error: 'invalid_status' });
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, po.id);
  // First-time delivery seeds qty_received = qty (the common "everything
  // arrived" case); receive-route edits refine it afterwards.
  if (status === 'Delivered') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(po.id);
    applyReceivedToStock(po.id, req);
  }
  if (status === 'Ordered' || status === 'Delivered') postRetailPOExpenses(po.id);
  else db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(po.id);
  logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', po.id,
              { from: po.status, to: status, scope: 'retail' }, req.ip);
  res.json({ success: true });
});

// Bulk per-line receive: qty_received / damaged_qty / tracking / invoice_status.
// Every save re-applies the stock delta and re-posts expenses.
router.put('/api/retail-admin/purchases/:id/receive', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const { receipts } = req.body || {};
  if (!Array.isArray(receipts)) return res.status(400).json({ success: false, error: 'receipts_required' });
  let missing_lines = 0, damaged_lines = 0, any_qty = false;
  const tx = db.transaction(() => {
    for (const r of receipts) {
      const lineId = parseInt(r.line_id, 10);
      if (!lineId) continue;
      const line = db.prepare('SELECT id, qty FROM po_line_items WHERE id = ? AND po_id = ?').get(lineId, po.id);
      if (!line) continue;
      const sets = [], vals = [];
      if (r.qty_received !== undefined) {
        const q = r.qty_received == null || r.qty_received === '' ? null : Math.max(0, parseFloat(r.qty_received) || 0);
        sets.push('qty_received = ?'); vals.push(q);
        if (q != null) { any_qty = true; if (q < (parseFloat(line.qty) || 0)) missing_lines++; }
      }
      if (r.damaged_qty !== undefined) {
        const dq = Math.max(0, parseFloat(r.damaged_qty) || 0);
        sets.push('damaged_qty = ?'); vals.push(dq);
        if (dq > 0) damaged_lines++;
      }
      if (r.tracking_number !== undefined) { sets.push('tracking_number = ?'); vals.push((r.tracking_number || '').toString().trim() || null); }
      if (r.tracking_carrier !== undefined) { sets.push('tracking_carrier = ?'); vals.push((r.tracking_carrier || '').toString().trim() || null); }
      if (r.invoice_status !== undefined && VALID_INVOICE.has(r.invoice_status)) { sets.push('invoice_status = ?'); vals.push(r.invoice_status); }
      if (!sets.length) continue;
      vals.push(lineId, po.id);
      db.prepare(`UPDATE po_line_items SET ${sets.join(', ')} WHERE id = ? AND po_id = ?`).run(...vals);
    }
  });
  tx();
  // Stock + finance follow the receive state (adjustStock runs outside the PO
  // transaction: it opens its own per-line transactions on the tenant handle).
  const stock = applyReceivedToStock(po.id, req);
  if (any_qty) postRetailPOExpenses(po.id);
  logActivity(req.user.id, req.user.username, 'receive', 'purchase_order', po.id,
              { lines: receipts.length, missing_lines, damaged_lines, scope: 'retail' }, req.ip);
  res.json({ success: true, missing_lines, damaged_lines, stock_lines_adjusted: stock.applied });
});

module.exports = router;
