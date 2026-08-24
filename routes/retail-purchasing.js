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
const { tdb, currentTenantId } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
// Finance category text — the one normalisation. See lib/category-text.js.
const { storeCategory } = require('../lib/category-text');
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
    "SELECT * FROM purchase_orders WHERE id = ? AND COALESCE(scope,'kitchen') = 'retail' AND COALESCE(tenant_id,1) = ?"
  ).get(id, currentTenantId());
}

function actorLabel(req) {
  return req.user?.display_name || req.user?.username || null;
}

// ── Expense auto-posting — mirror of routes/purchases.js postPOExpenses ────
// Idempotent DELETE-then-INSERT keyed on po_id; posts on Ordered/Delivered,
// wiped when the PO drops back to Requested (or is Cancelled). Amount uses
// qty_received once receiving started, so shortages adjust the books.
function postRetailPOExpenses(poId) {
  const po = db.prepare('SELECT id, date, supplier, po_number, status, extra_freight, extra_tax, extra_handling FROM purchase_orders WHERE id = ?').get(poId);
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
  // Landed-cost extras (freight/tax/handling) post as one shipping & fees line.
  const extras = (+po.extra_freight || 0) + (+po.extra_tax || 0) + (+po.extra_handling || 0);
  if (extras > 0) {
    insert.run(po.date, extras, '运费及杂费 Freight & fees',
      `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · shipping & fees`, poId);
    inserted++; total += extras;
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
  const tid = Number(currentTenantId()) || 1;
  const rows = db.prepare(`
    SELECT s.id, s.name, s.name_cn, s.contact_name, s.contact_phone, s.contact_wechat,
           s.payment_terms, s.payment_method, s.rating, s.notes, s.is_active,
           s.channel_type, s.channel_link, s.products_supplied, s.price_info,
           s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM supplier_documents d WHERE d.supplier_id = s.id) AS doc_count,
           (SELECT COUNT(*) FROM purchase_orders po
             WHERE po.supplier = s.name AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}) AS po_count,
           (SELECT MAX(po.date) FROM purchase_orders po
             WHERE po.supplier = s.name AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}) AS last_po_date
      FROM suppliers s
     WHERE s.tenant_id = ?${includeInactive ? '' : ' AND s.is_active = 1'}
     ORDER BY s.name COLLATE NOCASE
  `).all(tid);
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  // Base64 payloads stay out of the detail read — documents fetch individually.
  delete s.channel_qr_data; delete s.business_license_data;
  delete s.permits_data; delete s.payment_qr_data;
  const tid = Number(currentTenantId()) || 1;   // integer — safe to inline in SQL
  const documents = db.prepare(`
    SELECT id, kind, label, filename, mime_type, size_bytes, uploaded_at
      FROM supplier_documents WHERE supplier_id = ? ORDER BY uploaded_at DESC
  `).all(s.id);
  const recentPOs = db.prepare(`
    SELECT id, po_number, date, status,
           (SELECT SUM(COALESCE(total_cost,0)) FROM po_line_items WHERE po_id = purchase_orders.id) AS total
      FROM purchase_orders
     WHERE supplier = ? AND COALESCE(scope,'kitchen') = 'retail' AND COALESCE(tenant_id,1) = ${tid}
     ORDER BY date DESC, id DESC LIMIT 10
  `).all(s.name);
  // Scorecard — honest, computed-from-history metrics only (no faked on-time/
  // fill without the data to back them). Lines match this supplier whether the
  // supplier sits on the line or only on the PO header.
  const SUP_MATCH = "COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') = ?";
  const stat = db.prepare(`
    SELECT COUNT(DISTINCT po.id) AS order_count,
           COALESCE(SUM(pli.total_cost),0) AS spend,
           MAX(po.date) AS last_date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}`).get(s.name) || {};
  // `spend` above and `owed` below come from columns that do not share a unit:
  // po_line_items.total_cost stays a decimal amount, while invoices.amount is a
  // whole-cent integer in Postgres. They are built by two statements, so no
  // single row ever carries both — but the scorecard folds them into one payload
  // and the supplier screen renders them as adjacent tiles, which puts them back
  // together with nothing to tell them apart. Reading the bill amounts as a
  // plain column and summing them here keeps invoices.amount identifiable all
  // the way to the boundary. `spend` needs nothing; its column never changes
  // unit. The bill count comes from the rows we already read.
  const owedRows = db.prepare(
    `SELECT amount FROM invoices WHERE scope='retail' AND COALESCE(tenant_id,1) = ${tid} AND supplier=? AND paid_at IS NULL ORDER BY id`
  ).all(s.name);
  const owed = owedRows.reduce((sum, r) => sum + (r.amount || 0), 0);
  const priceList = db.prepare(`
    SELECT pli.store_product_id,
           MAX(pli.name_en) AS name_en, MAX(pli.name_cn) AS name_cn, MAX(pli.sku) AS sku,
           COUNT(*) AS times, AVG(pli.cost_per_unit) AS avg_cost, SUM(pli.qty) AS total_qty
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH} AND pli.store_product_id IS NOT NULL
     GROUP BY pli.store_product_id
     ORDER BY times DESC, name_en LIMIT 50`).all(s.name);
  const lastStmt = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id=? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  for (const pl of priceList) {
    const l = lastStmt.get(pl.store_product_id, s.name) || {};
    pl.last_cost = l.cost != null ? l.cost : pl.avg_cost;
    pl.last_date = l.date || null;
  }
  const scorecard = {
    order_count: stat.order_count || 0, spend: stat.spend || 0, last_date: stat.last_date || null,
    owed, owed_count: owedRows.length, product_count: priceList.length,
  };
  res.json({ success: true, data: { ...s, documents, recent_pos: recentPOs, scorecard, price_list: priceList } });
});

const SUPPLIER_FIELDS = ['name', 'name_cn', 'contact_name', 'contact_phone', 'contact_wechat',
  'payment_terms', 'payment_method', 'rating', 'notes', 'channel_type', 'channel_link',
  'products_supplied', 'price_info'];

router.post('/api/retail-admin/suppliers', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  // Scoped: without the tenant predicate one tenant's supplier name blocked
  // every other tenant from creating the same name (§0). The UNIQUE index on
  // suppliers.name is still global — see the PR, it needs a table rebuild.
  if (db.prepare('SELECT id FROM suppliers WHERE name = ? AND COALESCE(tenant_id,1) = ?').get(name, currentTenantId())) {
    return res.status(409).json({ success: false, error: 'name_taken' });
  }
  const info = db.prepare(`
    INSERT INTO suppliers (name, name_cn, contact_name, contact_phone, contact_wechat,
                           payment_terms, payment_method, rating, notes, channel_type,
                           channel_link, products_supplied, price_info, is_active, tenant_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  `).run(
    name, b.name_cn || null, b.contact_name || null, b.contact_phone || null, b.contact_wechat || null,
    b.payment_terms || null, b.payment_method || null,
    Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)),
    b.notes || null, b.channel_type || null, b.channel_link || null,
    b.products_supplied || null, b.price_info || null, currentTenantId(),
  );
  logActivity(req.user.id, req.user.username, 'create', 'supplier', info.lastInsertRowid, { name }, req.ip);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/api/retail-admin/suppliers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const s = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  if ('name' in b) {
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name_required' });
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND id != ? AND COALESCE(tenant_id,1) = ?').get(name, s.id, currentTenantId());
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
  db.prepare(`UPDATE suppliers SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id,1) = ?`).run(...vals, currentTenantId());
  // Historical POs keep the old supplier name on purpose — they're a snapshot
  // of what was ordered from whom at the time (same rule as the kitchen side).
  logActivity(req.user.id, req.user.username, 'update', 'supplier', s.id, b, req.ip);
  res.json({ success: true });
});

// Soft-delete: keep the row (and its name) so historical POs stay attributable.
router.delete('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare('UPDATE suppliers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id,1) = ?').run(s.id, currentTenantId());
  logActivity(req.user.id, req.user.username, 'delete', 'supplier', s.id, {}, req.ip);
  res.json({ success: true });
});

// Documents — base64 data URI payloads (images / PDFs), 10MB per file.
router.post('/api/retail-admin/suppliers/:id/documents', requireRetailAdmin, express.json({ limit: '15mb' }), (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, currentTenantId());
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
     WHERE COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ?`;
  const params = [currentTenantId()];
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
  const tid = Number(currentTenantId()) || 1;
  const prevStmt = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date, po.supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  const statsStmt = db.prepare(`
    SELECT COUNT(*) AS total_orders, AVG(pli.cost_per_unit) AS avg_price,
           MIN(pli.cost_per_unit) AS min_price, MAX(pli.cost_per_unit) AS max_price,
           SUM(pli.qty) AS total_qty
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}`);
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

// Per-product supplier price list: every supplier we've bought THIS product
// from on a retail PO, with last price + who + average. Powers the order
// picker's "who sells this / what we paid last time". Derived from PO history
// only — a brand-new tenant with no orders gets an empty list, never someone
// else's suppliers. Preferred = who we buy it from most; cheapest = lowest last
// price.
router.get('/api/retail-admin/products/:spid/suppliers', requireRetailAdmin, (req, res) => {
  const spid = parseInt(req.params.spid, 10);
  if (!spid) return res.status(400).json({ success: false, error: 'bad_id' });
  const tid = Number(currentTenantId()) || 1;   // integer — safe to inline
  // Group by the resolved supplier (line supplier wins, else the PO's supplier).
  // Positional GROUP BY 1 so the alias never shadows a real column.
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') AS supplier,
           COUNT(*)               AS order_count,
           SUM(pli.qty)           AS total_qty,
           AVG(pli.cost_per_unit) AS avg_cost,
           MIN(pli.cost_per_unit) AS min_cost,
           MAX(pli.cost_per_unit) AS max_cost
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     GROUP BY 1
     ORDER BY order_count DESC, MAX(po.date) DESC`).all(spid);
  const lastStmt = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date, po.po_number
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
       AND COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') = ?
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  const suppliers = rows.map(r => {
    const last = lastStmt.get(spid, r.supplier) || {};
    return {
      supplier: r.supplier || null,
      order_count: r.order_count, total_qty: r.total_qty,
      avg_cost: r.avg_cost, min_cost: r.min_cost, max_cost: r.max_cost,
      last_cost: last.cost != null ? last.cost : r.avg_cost,
      last_date: last.date || null, last_po_number: last.po_number || null,
    };
  });
  const overall = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date, po.po_number,
           COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier) AS supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`).get(spid) || null;
  // Cost-over-time series + overall stats + product identity, for the
  // standalone Price-history screen (sparkline + metric tiles).
  const series = db.prepare(`
    SELECT po.date AS date, pli.cost_per_unit AS cost
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND COALESCE(pli.cost_per_unit,0) > 0
     ORDER BY po.date, pli.id`).all(spid);
  const stats = db.prepare(`
    SELECT COUNT(*) AS order_count, SUM(pli.qty) AS total_qty,
           AVG(pli.cost_per_unit) AS avg_cost, MIN(pli.cost_per_unit) AS min_cost, MAX(pli.cost_per_unit) AS max_cost,
           MIN(po.date) AS first_date, MAX(po.date) AS last_date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND COALESCE(pli.cost_per_unit,0) > 0`).get(spid) || {};
  const prod = db.prepare(`
    SELECT MAX(pli.name_en) AS name_en, MAX(pli.name_cn) AS name_cn, MAX(pli.sku) AS sku
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid}`).get(spid) || {};
  res.json({ success: true, data: {
    store_product_id: spid, product: prod, suppliers, series, stats,
    last: overall ? { cost: overall.cost, date: overall.date, supplier: overall.supplier, po_number: overall.po_number } : null,
  } });
});

// ═══ RETAIL BILLS (supplier invoices) ═══════════════════════════════════════
// Retail port of the kitchen invoice tracker: record a supplier's invoice and
// allocate it across the retail PO lines it covers, with due-date / paid / AP
// aging on top. Everything is scoped to retail (invoices.scope='retail') and
// linked to retail PO lines, so kitchen bills never appear here and vice versa.
const BILL_PO_STATUSES = "('Ordered','Delivered','Confirmed')";
const gzToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const gzNow   = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// How much of a PO line has already been billed.
//
// invoice_lines.allocated_amount is a whole-cent integer in Postgres, while a
// line's own value is qty x po_line_items.cost_per_unit — a decimal amount that
// stays decimal. Every caller below puts one beside the other. Summed inside
// SQL the allocations arrive as a bare scalar with no column left to say which
// unit built it; selected as a plain column and summed here, each side is still
// identifiable at the point the two meet.
const allocatedForLine = (lineId) => db
  .prepare('SELECT allocated_amount FROM invoice_lines WHERE line_id=? ORDER BY id')
  .all(lineId)
  .reduce((sum, r) => sum + (r.allocated_amount || 0), 0);

// The same read for a whole page of lines, keyed by line_id. Lines with no
// allocation are absent from the map rather than present as 0, so the caller
// keeps the COALESCE it already had.
const allocatedByLine = (lineIds) => {
  const out = new Map();
  for (let i = 0; i < lineIds.length; i += 400) {
    const chunk = lineIds.slice(i, i + 400);
    const rows = db.prepare(`SELECT line_id, allocated_amount FROM invoice_lines
                              WHERE line_id IN (${chunk.map(() => '?').join(',')})
                              ORDER BY id`).all(...chunk);
    for (const a of rows) out.set(a.line_id, (out.get(a.line_id) || 0) + (a.allocated_amount || 0));
  }
  return out;
};

// Outstanding retail PO lines grouped by supplier — "who are we still awaiting
// an invoice from, and for how much?"
router.get('/api/retail-admin/bills/outstanding', requireRetailAdmin, (req, res) => {
  const month = (req.query.month || '').trim();
  const supplier = (req.query.supplier || '').trim();
  const params = [];
  const tid = Number(currentTenantId()) || 1;
  let where = `COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND po.status IN ${BILL_PO_STATUSES}
    AND COALESCE(po.no_invoice_expected,0)=0 AND COALESCE(pli.no_invoice_expected,0)=0`;
  if (month)    { where += ' AND substr(po.date,1,7)=?'; params.push(month.slice(0, 7)); }
  if (supplier) { where += " AND COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''),po.supplier,'')=?"; params.push(supplier); }
  // Neither money figure is built inside SQL. `line_total` was the product of
  // two decimal columns and `covered` a SUM over a whole-cent column; computed
  // in the database they came back as two scalars in one row, in two units,
  // with nothing to tell them apart. qty and cost_per_unit are read as the plain
  // columns they are and multiplied below, and the allocations are read and
  // summed the same way.
  const rows = db.prepare(`
    SELECT pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.cost_per_unit,
           po.id AS po_id, po.po_number, po.date,
           COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''),po.supplier,'') AS supplier
      FROM po_line_items pli JOIN purchase_orders po ON po.id=pli.po_id
     WHERE ${where}
     ORDER BY supplier, po.date DESC, pli.id`).all(...params);
  const allocated = allocatedByLine(rows.map(r => r.line_id));
  const bySup = new Map();
  for (const r of rows) {
    r.line_total = (r.qty || 0) * (r.cost_per_unit || 0);
    r.covered = allocated.get(r.line_id) || 0;
    r.outstanding = Math.max(0, r.line_total - r.covered);
    r.status = r.covered <= 0.01 ? 'awaiting' : (r.covered + 0.01 >= r.line_total ? 'fully' : 'partial');
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, { supplier: r.supplier || null, total: 0, covered: 0, outstanding: 0, lines: [] });
    const g = bySup.get(r.supplier);
    g.total += r.line_total; g.covered += r.covered; g.outstanding += r.outstanding; g.lines.push(r);
  }
  const groups = [...bySup.values()].filter(g => g.outstanding > 0.01).sort((a, b) => b.outstanding - a.outstanding);
  res.json({ success: true, data: groups });
});

// KPI + AP aging for the retail Bills header.
router.get('/api/retail-admin/bills/summary', requireRetailAdmin, (req, res) => {
  const month = (req.query.month || gzToday().slice(0, 7)).slice(0, 7);
  const tid = Number(currentTenantId()) || 1;
  // `purchased` and `billed` are read in two statements rather than one because
  // they come from columns that do not share a unit: po_line_items.cost_per_unit
  // is a decimal amount, while invoice_lines.allocated_amount is a whole-cent
  // integer in Postgres. Summed together in one query they arrive as two scales
  // in one row with nothing to tell them apart. Read separately — and with the
  // allocation rows selected as a plain column rather than pre-summed in SQL —
  // each side is a single identifiable unit before the two meet below.
  const billScope = `COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid}
       AND po.status IN ${BILL_PO_STATUSES}
       AND COALESCE(po.no_invoice_expected,0)=0 AND COALESCE(pli.no_invoice_expected,0)=0
       AND substr(po.date,1,7)=?`;
  const purchased = (db.prepare(`
    SELECT COALESCE(SUM(pli.qty*pli.cost_per_unit),0) AS purchased
      FROM po_line_items pli JOIN purchase_orders po ON po.id=pli.po_id
     WHERE ${billScope}`).get(month) || {}).purchased || 0;
  const billed = db.prepare(`
    SELECT il.allocated_amount AS allocated_amount
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE ${billScope}`).all(month)
    .reduce((sum, r) => sum + (r.allocated_amount || 0), 0);
  const awaiting = Math.max(0, purchased - billed);
  const today = gzToday();
  const soon = new Date(Date.now() + 8 * 3600 * 1000 + 7 * 86400 * 1000).toISOString().slice(0, 10);
  const bills = db.prepare(`SELECT amount, due_date, paid_at FROM invoices WHERE scope='retail' AND COALESCE(tenant_id,1) = ${tid} AND paid_at IS NULL`).all();
  let notDue = 0, dueSoon = 0, overdue = 0, overdueCount = 0;
  for (const b of bills) {
    const amt = b.amount || 0;
    if (!b.due_date) { notDue += amt; continue; }
    if (b.due_date < today) { overdue += amt; overdueCount++; }
    else if (b.due_date <= soon) dueSoon += amt;
    else notDue += amt;
  }
  res.json({ success: true, data: { month, purchased, billed, awaiting, aging: { notDue, dueSoon, overdue, overdueCount } } });
});

// Recorded retail bills ledger.
router.get('/api/retail-admin/bills', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const invs = db.prepare(`SELECT * FROM invoices WHERE scope='retail' AND COALESCE(tenant_id,1) = ${tid} ORDER BY date DESC, id DESC`).all();
  const linkStmt = db.prepare(`
    SELECT COUNT(DISTINCT po.id) AS po_count, GROUP_CONCAT(DISTINCT po.po_number) AS po_numbers,
           COALESCE(SUM(il.allocated_amount),0) AS allocated
      FROM invoice_lines il JOIN po_line_items pli ON pli.id=il.line_id JOIN purchase_orders po ON po.id=pli.po_id
     WHERE il.invoice_id=?`);
  const today = gzToday();
  for (const inv of invs) {
    const l = linkStmt.get(inv.id) || {};
    inv.po_count = l.po_count || 0;
    inv.po_numbers = l.po_numbers || '';
    inv.allocated = l.allocated || 0;
    inv.paid = !!inv.paid_at;
    inv.overdue = !inv.paid_at && !!inv.due_date && inv.due_date < today;
  }
  res.json({ success: true, data: invs });
});

// Create a retail bill + allocate across the lines it covers.
router.post('/api/retail-admin/bills', requireRetailAdmin, express.json(), (req, res) => {
  const { supplier, invoice_number, amount, date, due_date, store_id, notes, links } = req.body || {};
  if (!supplier || !String(supplier).trim()) return res.status(400).json({ success: false, error: 'supplier_required' });
  if (!(parseFloat(amount) > 0)) return res.status(400).json({ success: false, error: 'amount_required' });
  if (!date) return res.status(400).json({ success: false, error: 'date_required' });
  const insertInv = db.prepare(`INSERT INTO invoices (supplier, invoice_number, amount, date, notes, created_by, scope, store_id, due_date, tenant_id)
    VALUES (?,?,?,?,?,NULL,'retail',?,?,?)`);
  const insertLink = db.prepare('INSERT OR IGNORE INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,?)');
  const lineInfo = db.prepare(`
    SELECT pli.id, pli.qty, pli.cost_per_unit
      FROM po_line_items pli WHERE pli.id=?`);
  try {
    let id;
    const tx = db.transaction(() => {
      const r = insertInv.run(String(supplier).trim(), invoice_number ? String(invoice_number).trim() : null,
        parseFloat(amount), date, notes || null, store_id ? parseInt(store_id, 10) : null, due_date || null, Number(currentTenantId()) || 1);
      id = r.lastInsertRowid;
      if (Array.isArray(links)) {
        for (const l of links) {
          const lineId = parseInt(l.line_id, 10);
          const alloc = parseFloat(l.allocated_amount) || 0;
          if (!(lineId > 0) || !(alloc > 0)) continue;
          const info = lineInfo.get(lineId);
          if (!info) throw new Error(`line ${lineId} not found`);
          // Read inside the loop, so an earlier link to this same line in this
          // same request is already counted — as it was when the sum was a
          // correlated subquery on the row above.
          const lineTotal = (info.qty || 0) * (info.cost_per_unit || 0);
          const remaining = Math.max(0, lineTotal - allocatedForLine(lineId));
          if (alloc > remaining + 0.01) throw new Error(`line ${lineId} over-allocated`);
          insertLink.run(id, lineId, alloc);
        }
      }
    });
    tx();
    logActivity(req.user.id, req.user.username, 'create', 'retail_bill', id, { supplier, amount }, req.ip);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[retail bill create]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Mark a bill paid / unpaid.
router.put('/api/retail-admin/bills/:id/paid', requireRetailAdmin, express.json(), (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id=? AND scope='retail' AND COALESCE(tenant_id,1)=?").get(req.params.id, Number(currentTenantId()) || 1);
  if (!inv) return res.status(404).json({ success: false, error: 'not_found' });
  const paid = (req.body && req.body.paid === false) ? null : gzNow();
  db.prepare('UPDATE invoices SET paid_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(paid, inv.id);
  res.json({ success: true, paid: !!paid });
});

// Delete a bill (invoice_lines cascade).
router.delete('/api/retail-admin/bills/:id', requireRetailAdmin, (req, res) => {
  const r = db.prepare("DELETE FROM invoices WHERE id=? AND scope='retail' AND COALESCE(tenant_id,1)=?").run(req.params.id, Number(currentTenantId()) || 1);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_bill', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ═══ REORDER ════════════════════════════════════════════════════════════════
// Products sitting below their safety buffer across every active store, grouped
// by the supplier we'd order each from (its most-used vendor in retail PO
// history) + the store. Each group can become a one-tap draft order.
router.get('/api/retail-admin/reorder', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  let stores = [];
  try { stores = inventory.listStores({ activeOnly: true }); } catch (_) { stores = []; }
  const low = [];
  for (const st of stores) {
    let rows = [];
    try {
      rows = tdb().prepare(`
        SELECT p.id AS product_id, p.name_en, p.name_cn, p.sku,
               COALESCE(s.physical_qty,0)  AS physical_qty,
               COALESCE(s.safety_buffer,0) AS safety_buffer
          FROM store_products p
          LEFT JOIN retail_store_stock s ON s.product_id = p.id AND s.store_id = ?
         WHERE COALESCE(p.is_active,1) = 1
      `).all(st.id);
    } catch (_) { rows = []; }
    for (const r of rows) {
      const buffer = r.safety_buffer > 0 ? r.safety_buffer : 5;
      if (r.physical_qty < buffer) {
        low.push({
          store_id: st.id, store_name: st.name_en || st.code || ('#' + st.id),
          product_id: r.product_id, name_en: r.name_en, name_cn: r.name_cn, sku: r.sku,
          physical_qty: r.physical_qty, buffer,
          suggest: Math.max(1, Math.round(buffer * 2 - r.physical_qty)),
        });
      }
    }
  }
  const prefStmt = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') AS supplier, COUNT(*) AS c
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     GROUP BY 1 ORDER BY c DESC LIMIT 1`);
  const groups = new Map();
  for (const it of low) {
    const pref = prefStmt.get(it.product_id);
    it.supplier = (pref && pref.supplier) ? pref.supplier : null;
    const key = (it.supplier || '—') + '|' + it.store_id;
    if (!groups.has(key)) groups.set(key, { supplier: it.supplier, store_id: it.store_id, store_name: it.store_name, items: [] });
    groups.get(key).items.push(it);
  }
  const out = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  res.json({ success: true, data: out });
});

// Back-order the shortfall: make a fresh draft PO holding the outstanding
// quantity of every line that arrived short (received < ordered), linked to the
// original via backorder_of. Lines never received at all stay on the original
// order — only genuine shortfalls carry over.
router.post('/api/retail-admin/purchases/:id/backorder', requireRetailAdmin, (req, res) => {
  const src = getRetailPO(req.params.id);
  if (!src) return res.status(404).json({ success: false, error: 'not_found' });
  const lines = db.prepare(`
    SELECT * FROM po_line_items WHERE po_id = ? AND (COALESCE(qty_received, qty) < qty) ORDER BY sort_order, id
  `).all(src.id);
  if (!lines.length) return res.status(400).json({ success: false, error: 'nothing_outstanding' });
  try {
    const po_number = nextRetailPONumber();
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO purchase_orders
        (po_number, date, delivery_date, status, supplier, notes, source, scope, store_id, created_by, backorder_of, tenant_id)
        VALUES (?,?,?,'Requested',?,?,'backorder','retail',?,NULL,?,?)`).run(
        po_number, gzToday(), null, src.supplier || null,
        `Back-order from ${src.po_number}`, src.store_id, src.id, currentTenantId());
      const newId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO po_line_items
        (po_id, store_product_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost,
         expense_category, supplier_name, purchase_channel, note, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      lines.forEach((l, i) => {
        const outstanding = (parseFloat(l.qty) || 0) - (l.qty_received == null ? 0 : parseFloat(l.qty_received) || 0);
        ins.run(newId, l.store_product_id, l.name_en, l.name_cn, l.sku, outstanding, l.unit || 'pcs',
          l.cost_per_unit, outstanding * (parseFloat(l.cost_per_unit) || 0), storeCategory(db, l.expense_category),
          l.supplier_name || null, l.purchase_channel || null, l.note || null, i);
      });
      return newId;
    });
    const newId = tx();
    logActivity(req.user.id, req.user.username, 'backorder', 'purchase_order', newId, { from: src.id, po_number, scope: 'retail' }, req.ip);
    res.json({ success: true, id: newId, po_number });
  } catch (e) {
    console.error('[retail backorder]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Set landed-cost extras on a PO, then re-post expenses so Finance reflects
// them (no-op posting until the order is placed — same rule as goods).
router.put('/api/retail-admin/purchases/:id/landed', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const num = v => Math.max(0, parseFloat(v) || 0);
  const { freight, tax, handling } = req.body || {};
  db.prepare('UPDATE purchase_orders SET extra_freight=?, extra_tax=?, extra_handling=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(num(freight), num(tax), num(handling), po.id);
  const posted = postRetailPOExpenses(po.id);
  logActivity(req.user.id, req.user.username, 'landed_cost', 'purchase_order', po.id, { freight: num(freight), tax: num(tax), handling: num(handling) }, req.ip);
  res.json({ success: true, posted });
});

function insertLineItems(poId, items, headerSupplier) {
  const insertItem = db.prepare(`INSERT INTO po_line_items
    (po_id, store_product_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost,
     expense_category, supplier_name, purchase_channel, invoice_status, note, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach((item, i) => {
    const qty = parseFloat(item.qty) || 0;
    const cpu = parseFloat(item.cost_per_unit) || 0;
    const status = VALID_INVOICE.has(item.invoice_status) ? item.invoice_status : 'not_received';
    insertItem.run(
      poId, item.store_product_id || null, item.name_en || '', item.name_cn || null, item.sku || null,
      qty, item.unit || 'pcs', cpu, qty * cpu, storeCategory(db, item.expense_category),
      item.supplier_name || headerSupplier || null, item.purchase_channel || null, status,
      (item.note || '').trim() || null, i,
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
        INSERT INTO purchase_orders (po_number, date, delivery_date, status, supplier, notes, source, scope, store_id, created_by, tenant_id)
        VALUES (?,?,?,'Requested',?,?,'manual','retail',?,NULL,?)
      `).run(po_number, date, delivery_date || null, supplier || null, notes || null, storeId, currentTenantId());
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
