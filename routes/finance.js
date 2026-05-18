const express = require('express');
const db = require('../database');
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// Map a row from income_entries / expense_entries to the shape the
// frontend uses (v1 parity: notes/source fields).
function mapIncome(row) {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    category: row.category,
    notes: row.description,
    channel: row.channel,
    payment_method: row.payment_method,
    source: 'manual',
    createdAt: row.created_at,
  };
}
function mapExpense(row) {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    category: row.category,
    notes: row.description,
    payment_method: row.payment_method,
    po_id: row.po_id,
    source: row.po_id ? 'po' : 'manual',
    createdAt: row.created_at,
  };
}

// Aggregate sales_entries into one synthetic income row per (date, channel).
// This is the derive-only integration: sales remain the source of truth in
// the Sales module, the Finance module just *displays* them as auto-rows so
// the books match. These rows have id like "sale-2026-04-12-Meituan" and
// source: 'sales' so the frontend can render them as read-only.
function getSalesAsIncomeRows({ month, category } = {}) {
  let q = `SELECT date,
    COALESCE(NULLIF(TRIM(channel),''),'(unspecified)') AS channel,
    COUNT(*) AS entries,
    COALESCE(SUM(total),0)  AS amount
    FROM sales_entries WHERE 1=1`;
  const params = [];
  if (month) { q += ' AND substr(date,1,7) = ?'; params.push(month); }
  if (category) { q += ' AND COALESCE(NULLIF(TRIM(channel),\'\'),\'(unspecified)\') = ?'; params.push(category); }
  q += ' GROUP BY date, channel ORDER BY date DESC, channel';
  return db.prepare(q).all(...params).map(r => ({
    id: 'sale-' + r.date + '-' + r.channel.replace(/[^a-z0-9]/gi, '_'),
    date: r.date,
    amount: +r.amount,
    category: 'Sales · 销售 / ' + r.channel,
    notes: `${r.entries} transaction${r.entries===1?'':'s'} (auto-derived from Sales)`,
    channel: r.channel,
    source: 'sales',
    entries: r.entries,
    createdAt: r.date,
  }));
}

// ── Income ──────────────────────────────────────────────────────────────────
router.get('/api/finance/income', requireAuth, requirePermission('finance'), (req, res) => {
  const { month, category, source } = req.query;
  let manual = [];
  if (source !== 'sales') {
    let q = 'SELECT * FROM income_entries WHERE 1=1';
    const params = [];
    if (month) { q += ' AND substr(date,1,7) = ?'; params.push(month); }
    if (category) { q += ' AND category = ?'; params.push(category); }
    q += ' ORDER BY date DESC, id DESC';
    manual = db.prepare(q).all(...params).map(mapIncome);
  }
  let salesRows = [];
  if (source !== 'manual') {
    salesRows = getSalesAsIncomeRows({ month, category });
  }
  // Merge, sort by date desc, then by source so manual rows tend to land on top
  // for the same day (sales are derived/secondary).
  const data = [...manual, ...salesRows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.source !== b.source) return a.source === 'sales' ? 1 : -1;
    return 0;
  });
  res.json({ success: true, data });
});

router.post('/api/finance/income', requireAuth, requirePermission('finance'), (req, res) => {
  const { date, amount, category, notes, channel, payment_method } = req.body;
  const amt = parseFloat(amount);
  if (!date) return res.status(400).json({ error: 'date required · 日期必填' });
  if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be positive · 金额必须大于零' });
  try {
    const result = db.prepare(
      'INSERT INTO income_entries (date,amount,category,description,channel,payment_method,created_by) VALUES (?,?,?,?,?,?,?)'
    ).run(date, amt, category || null, notes || null, channel || null, payment_method || null, req.user.id);
    logActivity(req.user.id, req.user.username, 'create', 'income', result.lastInsertRowid, { amount: amt, category }, req.ip);
    const row = db.prepare('SELECT * FROM income_entries WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, id: result.lastInsertRowid, data: mapIncome(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/finance/income/:id', requireAuth, requireDelete, requirePermission('finance'), (req, res) => {
  const row = db.prepare('SELECT * FROM income_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found · 未找到' });
  db.prepare('DELETE FROM income_entries WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'income', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── Expenses ────────────────────────────────────────────────────────────────
router.get('/api/finance/expenses', requireAuth, requirePermission('finance'), (req, res) => {
  const { month, category, source } = req.query;
  let q = 'SELECT * FROM expense_entries WHERE 1=1';
  const params = [];
  if (month) { q += ' AND substr(date,1,7) = ?'; params.push(month); }
  if (category) { q += ' AND category = ?'; params.push(category); }
  if (source === 'po') q += ' AND po_id IS NOT NULL';
  else if (source === 'manual') q += ' AND po_id IS NULL';
  q += ' ORDER BY date DESC, id DESC';
  res.json({ success: true, data: db.prepare(q).all(...params).map(mapExpense) });
});

router.post('/api/finance/expenses', requireAuth, requirePermission('finance'), (req, res) => {
  const { date, amount, category, notes, payment_method } = req.body;
  const amt = parseFloat(amount);
  if (!date) return res.status(400).json({ error: 'date required · 日期必填' });
  if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be positive · 金额必须大于零' });
  try {
    const result = db.prepare(
      'INSERT INTO expense_entries (date,amount,category,description,payment_method,created_by) VALUES (?,?,?,?,?,?)'
    ).run(date, amt, category || null, notes || null, payment_method || null, req.user.id);
    logActivity(req.user.id, req.user.username, 'create', 'expense', result.lastInsertRowid, { amount: amt, category }, req.ip);
    const row = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, id: result.lastInsertRowid, data: mapExpense(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/finance/expenses/:id', requireAuth, requireDelete, requirePermission('finance'), (req, res) => {
  const row = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found · 未找到' });
  if (row.po_id) return res.status(400).json({ error: 'PO-linked expenses cannot be deleted directly · 关联采购单的支出不能直接删除' });
  db.prepare('DELETE FROM expense_entries WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'expense', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── Combined summary (server-side totals to avoid loading everything) ───────
// Income is derive-only: combines manual income_entries with the auto-aggregate
// from sales_entries (Sales module is the source of truth for revenue).
router.get('/api/finance/summary', requireAuth, requirePermission('finance'), (req, res) => {
  const incTotal     = db.prepare('SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM income_entries').get();
  const salesTotal   = db.prepare('SELECT COALESCE(SUM(total),0)  AS s, COUNT(*) AS c FROM sales_entries').get();
  const expTotal     = db.prepare('SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM expense_entries').get();
  const incByMonthM  = db.prepare("SELECT substr(date,1,7) AS month, SUM(amount) AS total FROM income_entries GROUP BY substr(date,1,7)").all();
  const incByMonthS  = db.prepare("SELECT substr(date,1,7) AS month, SUM(total)  AS total FROM sales_entries  GROUP BY substr(date,1,7)").all();
  const expByMonth   = db.prepare("SELECT substr(date,1,7) AS month, SUM(amount) AS total FROM expense_entries GROUP BY substr(date,1,7)").all();
  const expByCategory = db.prepare("SELECT COALESCE(category,'未分类') AS category, SUM(amount) AS total FROM expense_entries GROUP BY COALESCE(category,'未分类')").all();
  // Merge per-month income from both tables.
  const monthMap = {};
  incByMonthM.forEach(r => { monthMap[r.month] = (monthMap[r.month] || 0) + (+r.total || 0); });
  incByMonthS.forEach(r => { monthMap[r.month] = (monthMap[r.month] || 0) + (+r.total || 0); });
  const incByMonth = Object.entries(monthMap).map(([month, total]) => ({ month, total })).sort((a,b)=>a.month<b.month?-1:1);

  const totalIncome  = (+incTotal.s || 0) + (+salesTotal.s || 0);
  const totalExpense = +expTotal.s || 0;
  res.json({
    success: true,
    data: {
      totalIncome, incomeCount: (incTotal.c | 0) + (salesTotal.c | 0),
      manualIncome: incTotal.s, manualIncomeCount: incTotal.c,
      salesIncome:  salesTotal.s, salesIncomeCount:  salesTotal.c,
      totalExpense, expenseCount: expTotal.c,
      net: totalIncome - totalExpense,
      margin: totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome) * 100 : 0,
      incByMonth, expByMonth, expByCategory,
    },
  });
});

// GET /api/finance/invoice-summary?month=YYYY-MM&supplier=…
//
// Aggregates PO line items by supplier_name within the selected month and
// breaks each total down by the 3-state invoice_status:
//   • received        — invoice in hand (已收取)
//   • not_received    — should arrive but hasn't (未收取) ← the action item
//   • no_invoice      — supplier doesn't issue one (不开发票)
// "missing" is the legacy alias for not_received so older clients keep
// working; new clients should read the 3 fields directly.
//
// month is matched against po.date (YYYY-MM-…). supplier is an optional
// case-insensitive LIKE filter that also matches purchase_channel so a
// buyer searching "京东" finds every line bought there. Lines with no
// supplier_name fall under "未指定 Unspecified" so they're never lost.
//
// Returns:
//   { rows: [...],
//     totals: { total, received, not_received, no_invoice, lines },
//     lines_payload: [...] }
router.get('/api/finance/invoice-summary', requireAuth, requirePermission('finance'), (req, res) => {
  const month    = (req.query.month || '').trim();          // 'YYYY-MM' or ''
  const supplier = (req.query.supplier || '').trim();
  let q = `
    SELECT pli.id AS line_id, pli.po_id, pli.name_en, pli.name_cn, pli.sku,
           pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           COALESCE(NULLIF(TRIM(pli.supplier_name),''), '未指定 Unspecified') AS supplier_name,
           pli.purchase_channel,
           COALESCE(pli.invoice_status, 'not_received') AS invoice_status,
           po.po_number, po.date, po.status, po.supplier AS po_supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE 1=1`;
  const params = [];
  if (month) { q += ' AND substr(po.date, 1, 7) = ?'; params.push(month); }
  if (supplier) {
    q += ` AND (
      LOWER(COALESCE(pli.supplier_name,'')) LIKE LOWER(?) OR
      LOWER(COALESCE(po.supplier,''))       LIKE LOWER(?) OR
      LOWER(COALESCE(pli.purchase_channel,'')) LIKE LOWER(?)
    )`;
    const like = '%' + supplier + '%';
    params.push(like, like, like);
  }
  q += ' ORDER BY po.date DESC, pli.sort_order';
  const lines = db.prepare(q).all(...params);

  const bySupplier = new Map();
  let gTotal = 0, gReceived = 0, gNotReceived = 0, gNoInvoice = 0;
  for (const l of lines) {
    const amt = (parseFloat(l.qty)||0) * (parseFloat(l.cost_per_unit)||0);
    const s   = l.supplier_name;
    if (!bySupplier.has(s)) bySupplier.set(s, {
      supplier_name: s, total: 0, received: 0, not_received: 0, no_invoice: 0,
      lines: 0, channels: new Set(),
    });
    const row = bySupplier.get(s);
    row.total += amt;
    if      (l.invoice_status === 'received')    row.received     += amt;
    else if (l.invoice_status === 'no_invoice')  row.no_invoice   += amt;
    else                                         row.not_received += amt;
    row.lines++;
    if (l.purchase_channel) row.channels.add(l.purchase_channel);
    gTotal += amt;
    if      (l.invoice_status === 'received')    gReceived     += amt;
    else if (l.invoice_status === 'no_invoice')  gNoInvoice    += amt;
    else                                         gNotReceived  += amt;
  }
  const round = n => Math.round(n * 100) / 100;
  const rows = [...bySupplier.values()].map(r => ({
    supplier_name: r.supplier_name,
    total:        round(r.total),
    received:     round(r.received),
    not_received: round(r.not_received),
    no_invoice:   round(r.no_invoice),
    // Legacy aliases — older callers expecting "invoiced / missing" still work.
    invoiced:     round(r.received),
    missing:      round(r.not_received),
    lines:        r.lines,
    channels:     [...r.channels],
  })).sort((a, b) => b.not_received - a.not_received || b.total - a.total);

  res.json({
    success: true,
    data: {
      month: month || null,
      supplier: supplier || null,
      rows,
      totals: {
        total:        round(gTotal),
        received:     round(gReceived),
        not_received: round(gNotReceived),
        no_invoice:   round(gNoInvoice),
        // Legacy aliases for older clients.
        invoiced:     round(gReceived),
        missing:      round(gNotReceived),
        lines:        lines.length,
      },
      lines_payload: lines,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Invoices entity — line-level model.
//
// A buying order is a mixed shopping list (warehouse uses it to confirm
// receipt; accounting uses it to track invoices). Each LINE has its own
// supplier (po_line_items.supplier_name). An invoice from supplier X
// covers a subset of lines whose supplier_name = X, possibly across many
// buying orders.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/finance/invoices?month=&supplier= — list invoices + their
// linked line items.
router.get('/api/finance/invoices', requireAuth, requirePermission('finance'), (req, res) => {
  const month    = (req.query.month || '').trim();
  const supplier = (req.query.supplier || '').trim();
  let q = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (month)    { q += " AND substr(date, 1, 7) = ?"; params.push(month); }
  if (supplier) { q += ' AND LOWER(supplier) LIKE LOWER(?)'; params.push('%' + supplier + '%'); }
  q += ' ORDER BY date DESC, id DESC';
  const invoices = db.prepare(q).all(...params);
  const linkStmt = db.prepare(`
    SELECT il.id AS link_id, il.allocated_amount,
           pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit, pli.cost_per_unit,
           pli.supplier_name, pli.purchase_channel,
           po.id AS po_id, po.po_number, po.date AS po_date, po.status
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE il.invoice_id = ?
     ORDER BY po.date DESC`);
  // Pull links once per invoice (was 3× per row before — N+1 amplified).
  // The PO summary is just a distinct-by-po_number reduction over the
  // same link list.
  const data = invoices.map(inv => {
    const lines = linkStmt.all(inv.id);
    const seenPo = new Map();
    for (const l of lines) {
      if (!seenPo.has(l.po_number)) {
        seenPo.set(l.po_number, { po_id: l.po_id, po_number: l.po_number, po_date: l.po_date, status: l.status });
      }
    }
    return { ...inv, lines, pos: [...seenPo.values()] };
  });
  res.json({ success: true, data });
});

// GET /api/finance/invoices/:id — one invoice with all linked line items.
router.get('/api/finance/invoices/:id', requireAuth, requirePermission('finance'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found · 未找到' });
  const lines = db.prepare(`
    SELECT il.id AS link_id, il.allocated_amount,
           pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit, pli.cost_per_unit,
           pli.supplier_name, pli.purchase_channel,
           po.id AS po_id, po.po_number, po.date AS po_date, po.status, po.supplier AS po_header_supplier
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE il.invoice_id = ?
     ORDER BY po.date DESC`).all(inv.id);
  res.json({ success: true, data: { ...inv, lines } });
});

// POST /api/finance/invoices — create invoice + link lines.
// Body: { supplier, invoice_number, amount, date, notes,
//         links: [{line_id, allocated_amount}] }
router.post('/api/finance/invoices', requireAuth, requirePermission('finance'), (req, res) => {
  const { supplier, invoice_number, amount, date, notes, links } = req.body || {};
  if (!supplier || !supplier.trim()) return res.status(400).json({ error: 'supplier required · 供应商必填' });
  if (!(parseFloat(amount) > 0))     return res.status(400).json({ error: 'amount must be > 0 · 金额必须大于零' });
  if (!date)                          return res.status(400).json({ error: 'date required · 日期必填' });

  const insertInv = db.prepare(`INSERT INTO invoices (supplier, invoice_number, amount, date, notes, created_by) VALUES (?,?,?,?,?,?)`);
  const insertLink = db.prepare(`INSERT OR IGNORE INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,?)`);
  // Defense-in-depth: refuse a per-line allocation that exceeds the
  // line's actual outstanding amount. The frontend already clamps via
  // input max=, but a hand-crafted POST could bypass that.
  const lineInfo = db.prepare(`
    SELECT pli.id, pli.qty, pli.cost_per_unit,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id = pli.id), 0) AS already_allocated
      FROM po_line_items pli
     WHERE pli.id = ?`);
  let id;
  try {
    const tx = db.transaction(() => {
      const r = insertInv.run(supplier.trim(), invoice_number?.trim() || null, parseFloat(amount), date, notes || null, req.user.id);
      id = r.lastInsertRowid;
      if (Array.isArray(links)) {
        for (const l of links) {
          const lineId = parseInt(l.line_id, 10);
          let alloc = parseFloat(l.allocated_amount) || 0;
          if (!(lineId > 0) || !(alloc > 0)) continue;
          const info = lineInfo.get(lineId);
          if (!info) throw new Error(`Line ${lineId} not found`);
          const lineTotal   = (info.qty || 0) * (info.cost_per_unit || 0);
          const remaining   = Math.max(0, lineTotal - info.already_allocated);
          if (alloc > remaining + 0.01) {
            throw new Error(`Line ${lineId}: allocated ¥${alloc.toFixed(2)} exceeds outstanding ¥${remaining.toFixed(2)} · 行分配超额`);
          }
          insertLink.run(id, lineId, alloc);
        }
      }
    });
    tx();
    logActivity(req.user.id, req.user.username, 'create', 'invoice', id, { supplier, amount, date, links: (links||[]).length }, req.ip);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[create invoice]', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/finance/invoices/:id — replace header + diff link list.
router.put('/api/finance/invoices/:id', requireAuth, requirePermission('finance'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found · 未找到' });
  const { supplier, invoice_number, amount, date, notes, links } = req.body || {};
  try {
    const tx = db.transaction(() => {
      db.prepare(`UPDATE invoices SET supplier=?, invoice_number=?, amount=?, date=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(
          (supplier && supplier.trim()) || inv.supplier,
          invoice_number?.trim() || null,
          parseFloat(amount) || inv.amount,
          date || inv.date,
          notes || null,
          inv.id
        );
      if (Array.isArray(links)) {
        // Drop the old links FIRST so "already allocated" computed below
        // doesn't double-count this invoice's own previous allocation.
        db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(inv.id);
        const ins = db.prepare('INSERT OR IGNORE INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,?)');
        const lineInfo = db.prepare(`
          SELECT pli.id, pli.qty, pli.cost_per_unit,
                 COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id = pli.id), 0) AS already_allocated
            FROM po_line_items pli
           WHERE pli.id = ?`);
        for (const l of links) {
          const lineId = parseInt(l.line_id, 10);
          const alloc = parseFloat(l.allocated_amount) || 0;
          if (!(lineId > 0) || !(alloc > 0)) continue;
          const info = lineInfo.get(lineId);
          if (!info) throw new Error(`Line ${lineId} not found`);
          const lineTotal = (info.qty || 0) * (info.cost_per_unit || 0);
          const remaining = Math.max(0, lineTotal - info.already_allocated);
          if (alloc > remaining + 0.01) {
            throw new Error(`Line ${lineId}: allocated ¥${alloc.toFixed(2)} exceeds outstanding ¥${remaining.toFixed(2)} · 行分配超额`);
          }
          ins.run(inv.id, lineId, alloc);
        }
      }
    });
    tx();
    logActivity(req.user.id, req.user.username, 'update', 'invoice', inv.id, { supplier, amount }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[update invoice]', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/finance/invoices/:id — drops the invoice + all its links
// (FK ON DELETE CASCADE handles invoice_lines cleanup).
router.delete('/api/finance/invoices/:id', requireAuth, requireDelete, requirePermission('finance'), (req, res) => {
  const r = db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'invoice', req.params.id, null, req.ip);
  res.json({ success: true });
});

// GET /api/finance/outstanding-lines?month=&supplier=
//
// Every line item from a placed buying order, with coverage status,
// grouped by supplier_name. This is the action-item view for accounting:
// "for each supplier, how much is awaiting an invoice?"
//
// A line is included when:
//   • parent PO status ∈ {Ordered, Delivered, Confirmed}
//   • parent PO is NOT flagged no_invoice_expected
//   • the line itself is NOT flagged no_invoice_expected
// (Either flag suppresses the line — supplier-level OR per-line opt-out.)
//
// Per line: amount = qty × cost_per_unit;
//           covered = SUM(invoice_lines.allocated_amount where line_id = X);
//           outstanding = max(0, amount - covered).
// Status:
//   fully_invoiced     covered >= amount AND amount > 0
//   partially_invoiced 0 < covered < amount
//   awaiting           covered == 0
router.get('/api/finance/outstanding-lines', requireAuth, requirePermission('finance'), (req, res) => {
  const month    = (req.query.month || '').trim();
  const supplier = (req.query.supplier || '').trim();
  // Unified free-text search: matches supplier name, English name, Chinese
  // name, OR SKU. Used by the Invoices tab so the user can find a pending
  // line by supplier OR by what was on it (e.g. "Wang", "黄油", "BUT-12-1").
  const search = (req.query.q || '').trim();
  // Supplier resolution chain (most-specific first):
  //   1. line's own supplier_name (explicit per-line override)
  //   2. PO header supplier (single-supplier order convenience)
  //   3. linked ingredient's master supplier (the canonical "we always
  //      buy this from X" source — set on the Item form)
  //   4. literal "未指定 Unspecified" fallback (only if nothing matches)
  let q = `
    SELECT pli.id AS line_id, pli.po_id, pli.name_en, pli.name_cn, pli.sku,
           pli.qty, pli.unit, pli.cost_per_unit,
           COALESCE(
             NULLIF(TRIM(pli.supplier_name),''),
             NULLIF(TRIM(po.supplier),''),
             NULLIF(TRIM(ing.supplier),''),
             '未指定 Unspecified'
           ) AS supplier_name,
           pli.purchase_channel, pli.no_invoice_expected AS line_no_invoice,
           po.po_number, po.date, po.status, po.no_invoice_expected AS po_no_invoice,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id = pli.id), 0) AS covered_amount
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
      LEFT JOIN ingredients ing ON ing.id = pli.ingredient_id
     WHERE po.status IN ('Ordered','Delivered','Confirmed')`;
  const params = [];
  if (month)    { q += " AND substr(po.date, 1, 7) = ?"; params.push(month); }
  if (supplier) {
    // Special case: "未指定 Unspecified" → rows where ALL fallback sources
    // are empty. Otherwise a normal LIKE across the same chain.
    if (supplier === '未指定 Unspecified') {
      q += ` AND NULLIF(TRIM(pli.supplier_name),'') IS NULL
             AND NULLIF(TRIM(po.supplier),'')        IS NULL
             AND NULLIF(TRIM(ing.supplier),'')       IS NULL`;
    } else {
      q += ` AND LOWER(COALESCE(
               NULLIF(TRIM(pli.supplier_name),''),
               NULLIF(TRIM(po.supplier),''),
               NULLIF(TRIM(ing.supplier),''),
               ''
             )) LIKE LOWER(?)`;
      params.push('%' + supplier + '%');
    }
  }
  // Unified free-text search — supplier name OR product name (EN/CN) OR
  // SKU. The supplier match runs against the same coalesced chain used
  // for grouping so a search by "Wang" returns Wang's lines even when
  // the explicit `pli.supplier_name` is null.
  if (search) {
    const term = '%' + search + '%';
    q += ` AND (
        LOWER(COALESCE(
          NULLIF(TRIM(pli.supplier_name),''),
          NULLIF(TRIM(po.supplier),''),
          NULLIF(TRIM(ing.supplier),''),
          ''
        )) LIKE LOWER(?)
        OR LOWER(COALESCE(pli.name_en,'')) LIKE LOWER(?)
        OR LOWER(COALESCE(pli.name_cn,'')) LIKE LOWER(?)
        OR LOWER(COALESCE(pli.sku,''))     LIKE LOWER(?)
    )`;
    params.push(term, term, term, term);
  }
  q += ' ORDER BY po.date DESC, pli.sort_order';
  const rows = db.prepare(q).all(...params);

  const round = n => Math.round(n * 100) / 100;
  const enriched = rows.map(r => {
    const amount = round((parseFloat(r.qty) || 0) * (parseFloat(r.cost_per_unit) || 0));
    const covered = round(r.covered_amount);
    const outstanding = round(Math.max(0, amount - covered));
    let status = 'awaiting';
    if (r.line_no_invoice || r.po_no_invoice) status = 'no_invoice_expected';
    else if (covered >= amount && amount > 0) status = 'fully_invoiced';
    else if (covered > 0)                     status = 'partially_invoiced';
    return { ...r, amount, covered_amount: covered, outstanding, status };
  });

  const bySupplier = new Map();
  let gTotal = 0, gFully = 0, gPartial = 0, gAwaiting = 0, gNoInvoice = 0;
  for (const r of enriched) {
    const s = r.supplier_name;
    if (!bySupplier.has(s)) bySupplier.set(s, {
      supplier: s, total: 0, fully_invoiced: 0, partially_invoiced: 0,
      awaiting: 0, no_invoice_expected: 0, lines: [],
    });
    const g = bySupplier.get(s);
    g.total += r.amount;
    g[r.status] += r.amount;
    g.lines.push(r);
    gTotal += r.amount;
    if (r.status === 'fully_invoiced')           gFully     += r.amount;
    else if (r.status === 'partially_invoiced')  gPartial   += r.amount;
    else if (r.status === 'no_invoice_expected') gNoInvoice += r.amount;
    else                                         gAwaiting  += r.amount;
  }

  const groups = [...bySupplier.values()].map(g => ({
    supplier: g.supplier,
    total:               round(g.total),
    fully_invoiced:      round(g.fully_invoiced),
    partially_invoiced:  round(g.partially_invoiced),
    awaiting:            round(g.awaiting),
    no_invoice_expected: round(g.no_invoice_expected),
    lines: g.lines,
    line_count: g.lines.length,
    po_numbers: [...new Set(g.lines.map(l => l.po_number))],
  })).sort((a, b) => (b.awaiting + b.partially_invoiced) - (a.awaiting + a.partially_invoiced) || b.total - a.total);

  res.json({
    success: true,
    data: {
      month: month || null,
      supplier: supplier || null,
      groups,
      totals: {
        total:               round(gTotal),
        fully_invoiced:      round(gFully),
        partially_invoiced:  round(gPartial),
        awaiting:            round(gAwaiting),
        no_invoice_expected: round(gNoInvoice),
        line_count: rows.length,
      },
    },
  });
});

// Legacy alias — older clients still poll /outstanding-pos. Forward to
// the new endpoint and reshape the response so existing callers don't
// break. Will be removed once the frontend fully migrates.
router.get('/api/finance/outstanding-pos', requireAuth, requirePermission('finance'), (req, res) => {
  // Reuse the new endpoint's logic: redirect internally.
  req.url = '/api/finance/outstanding-lines' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  router.handle(req, res, () => {});
});

module.exports = router;
