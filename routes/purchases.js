const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
// The one cost-per-recipe-unit derivation — shared so purchasing cannot drift
// from what the ingredient form computes. See lib/ingredient-cost.js.
const { deriveCostPerUnit, normaliseUnit } = require('../lib/ingredient-cost');
const router = express.Router();

// Web Push helpers — fan-out to subscribed devices when a PO event
// happens. Lazy-loaded so a missing or mis-configured push module
// doesn't break the rest of the route.
let _push = null;
try { _push = require('./push'); } catch (e) { console.warn('[purchases] push module not available:', e.message); }
// SSE companion — sub-second in-app pings on plain HTTP.
let _events = null;
try { _events = require('./events'); } catch (e) { console.warn('[purchases] events module not available:', e.message); }
function _broadcastPO(poId, kind, actorUserId) {
  if (!_events || !_events.broadcast) return;
  try {
    const po = db.prepare('SELECT id, po_number, supplier, status, source FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return;
    _events.broadcast('po', {
      kind, id: po.id, po_number: po.po_number,
      supplier: po.supplier, status: po.status, source: po.source,
      ts: Date.now(),
    }, { perms: ['purchases'], excludeUserId: actorUserId });
  } catch (e) { console.warn('[broadcastPO]', e.message); }
}
function _firePOPush(poId, kind) {
  if (!_push || !_push.ENABLED) return;
  try {
    const po = db.prepare('SELECT id, po_number, supplier, status, source FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return;
    const isKitchen = po.source === 'kitchenOrder';
    // Item summary so the notification reads like "ACME · 4 items · ¥1,240"
    // and "(Tomato, Onion, Olive Oil…)" instead of just the supplier name.
    const items = db.prepare(`SELECT name_en, name_cn, qty, total_cost
                              FROM po_line_items WHERE po_id = ?
                              ORDER BY COALESCE(sort_order,0), id`).all(poId);
    const count = items.length;
    const totalCost = items.reduce((s, i) => s + (Number(i.total_cost) || 0), 0);
    const top = items.slice(0, 3).map(i => i.name_cn || i.name_en || '?').join(', ');
    const summary = count === 0
      ? ''
      : `${count} item${count === 1 ? '' : 's'}${top ? ' (' + top + (count > 3 ? '…' : '') + ')' : ''}${totalCost > 0 ? ' · ¥' + Math.round(totalCost).toLocaleString() : ''}`;
    const compose = (lead) => [lead, summary].filter(Boolean).join(' · ');
    let title, body;
    if (kind === 'created') {
      title = isKitchen ? `🛒 ${po.po_number} · 新厨房订货` : `📋 ${po.po_number} · 新采购单`;
      body  = compose((po.supplier ? po.supplier : '') + (isKitchen ? ' · From kitchen' : (po.supplier ? '' : (po.status || 'Requested'))));
    } else if (kind === 'delivered') {
      title = `📦 ${po.po_number} delivered · 到货`;
      body  = compose(po.supplier || 'No supplier · 未指定供应商');
    } else if (kind === 'ordered') {
      title = `✓ ${po.po_number} ordered · 已下单`;
      body  = compose(po.supplier || '');
    } else { return; }
    // Send to anyone with `purchases` perm (or admin) — they're the
    // people who care about PO state changes. Server-side resolution
    // covers users who aren't currently online.
    _push.sendPushByPermission('purchases', {
      title, body, url: '/?po=' + poId, tag: 'po-' + poId,
    });
  } catch (e) { console.warn('[firePOPush]', e.message); }
}

// A line's unit is stored exactly as it arrives, blank included. The old
// `|| 'kg'` here re-instated the very default the PO form stopped setting, so
// the write-back's mismatch guard could never see that nobody had chosen a
// unit. "Nobody said" has to stay "nobody said" the whole way down.

// ── Fire price-history rows + alerts for every line in a PO ────────────────
// Called whenever a PO transitions to Ordered or Delivered (including the
// split-order path which previously skipped this and was the last gap).
// `source` is 'po_ordered' or 'po_delivery' for the price-history row.
// Price alerts (≥5% delta vs current buy_price) are inserted into price_alerts
// — the front-end push poller picks them up and surfaces a toast.
//
// LAST ORDER WINS. The most recent PO price becomes the item's cost, however
// high. No confirmation, no outlier check — that is the decision, not an
// oversight.
//
// The divisor comes from the INGREDIENT row via lib/ingredient-cost.js, never
// from the PO line's unit. The old code looked `item.unit` up in a local
// unit→grams table that held no container units, so a bag / bottle / pcs line
// fell through to `|| 1` and stored the PACK price as the per-gram cost — a
// ¥15.80 500 g bag of sesame seeds became ¥15.80/g, 500× too high, and every
// recipe using it costed 500× too high with it.
//
// Two guards make the function write NOTHING rather than write something wrong:
//   * unit mismatch — the line's unit must equal the item's buy_unit. buy_price
//     is a price per package; a price recorded against some other unit cannot
//     be compared to it or divided by this item's pack size.
//   * no derivable divisor — a container item with no recorded contents, or a
//     recipe unit outside g / ml / pcs. Dividing by 1 or storing 0 would both
//     destroy a good cost.
// Skips are returned to the caller, logged, and recorded in
// ingredient_cost_skips, which the Alerts page reads. A later PO that prices
// the item cleanly closes them again.
//
// buy_unit is NOT written any more. It is a property of the item as the
// supplier sells it, and overwriting it from a PO line silently re-based every
// future division.
function firePriceAlertsForPO(poId, source) {
  const items = db.prepare('SELECT ingredient_id, unit, cost_per_unit FROM po_line_items WHERE po_id = ?').all(poId);
  const skips = [];
  // Prepared behind a guard: a database restored from before this table
  // existed must not take the whole PO status flip down with it. Prices still
  // write; only the record of skips is lost, and loudly.
  let insSkip = null, resolveSkips = null;
  try {
    insSkip = db.prepare(`INSERT INTO ingredient_cost_skips
      (ingredient_id, po_id, reason, line_unit, line_price) VALUES (?,?,?,?,?)`);
    resolveSkips = db.prepare(`UPDATE ingredient_cost_skips
         SET resolved_at = CURRENT_TIMESTAMP
       WHERE ingredient_id = ? AND resolved_at IS NULL`);
  } catch (e) { console.warn('[price write-back] ingredient_cost_skips unavailable:', e.message); }
  const skip = (ing, item, reason) => {
    skips.push({ ingredient_id: ing.id, sku: ing.sku || null, name_en: ing.name_en || '', name_cn: ing.name_cn || null, reason });
    console.warn(`[price write-back] skipped ${ing.sku || 'id ' + ing.id} ${ing.name_en || ''} — ${reason}`);
    // Recorded so the refusal reaches the Alerts page. A skip that only ever
    // reached the server log would leave the item's cost stale in silence.
    try { if (insSkip) insSkip.run(ing.id, poId, reason, item.unit || null, item.cost_per_unit); }
    catch (e) { console.warn('[price write-back] could not record skip:', e.message); }
  };
  for (const item of items) {
    if (!item.ingredient_id || !item.cost_per_unit) continue;
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id);
    if (!ing) continue;

    // Price history is append-only and carries its own buy_unit column, so it
    // stays honest even for lines we refuse to write back. Recorded first, and
    // for every priced line, exactly as before.
    db.prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source) VALUES (?,?,?,?)').run(item.ingredient_id, item.cost_per_unit, item.unit, source);

    // Through normaliseUnit, so 'pc' on the line and 'pcs' on the item are the
    // same unit and the price flows.
    // Marked free by hand. A supplier price on a PO line does not get to start
    // costing something someone deliberately said is free — the flag is a
    // decision, the invoice is just data.
    if (ing.free_by_design) { skip(ing, item, 'marked_free'); continue; }

    if (normaliseUnit(item.unit) !== normaliseUnit(ing.buy_unit)) { skip(ing, item, 'unit_mismatch'); continue; }

    const { cpu, reason } = deriveCostPerUnit(ing, item.cost_per_unit);
    if (cpu === null) { skip(ing, item, reason); continue; }

    db.prepare('UPDATE ingredients SET buy_price=?,cost_per_unit=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.cost_per_unit, cpu, item.ingredient_id);
    // The item just priced cleanly, so whatever blocked it before is no longer
    // true — close its open skips. They stay in the table with resolved_at set,
    // because the history of what went unpriced is worth keeping. Without this
    // the alert would outlive the problem and have to be dismissed by hand.
    if (resolveSkips) resolveSkips.run(item.ingredient_id);
    if (ing.buy_price > 0 && item.cost_per_unit !== ing.buy_price) {
      const changePct = ((item.cost_per_unit - ing.buy_price) / ing.buy_price) * 100;
      if (Math.abs(changePct) >= 5) {
        db.prepare('INSERT INTO price_alerts (ingredient_id,old_price,new_price,change_pct) VALUES (?,?,?,?)').run(item.ingredient_id, ing.buy_price, item.cost_per_unit, changePct);
      }
    }
  }
  return { skips };
}

// ── Auto-post PO line items into expense_entries by category ────────────────
// Idempotent: wipes any existing PO-linked rows first, then inserts fresh.
// Posts as soon as the PO moves to Ordered — matches cash-basis bookkeeping
// where Taobao/1688 payment happens at order time. On Delivered we re-post
// using qty_received instead of qty so shortages/damages adjust the books.
// Only the 'Requested' (and legacy 'Confirmed') states stay un-posted.
function postPOExpenses(poId) {
  const result = { skipped: null, inserted: 0, total: 0, categories: 0, status: null };
  try {
    const po = db.prepare('SELECT id, date, supplier, po_number, status FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) { result.skipped = 'po-missing'; return result; }
    result.status = po.status;
    // Always clear so flipping status back to Requested correctly removes the entries.
    db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
    const POSTABLE = new Set(['Ordered', 'Delivered', 'Confirmed']);
    if (!POSTABLE.has(po.status)) { result.skipped = 'not-postable'; return result; }
    // Group by expense_category, summing (received × cost) per category.
    const groups = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(expense_category),''),'未分类 Uncategorized') AS category,
        SUM(COALESCE(qty_received, qty) * COALESCE(cost_per_unit, 0))     AS amount,
        COUNT(*)                                                            AS line_count
      FROM po_line_items
      WHERE po_id = ?
        AND COALESCE(qty_received, qty) > 0
      GROUP BY COALESCE(NULLIF(TRIM(expense_category),''),'未分类 Uncategorized')
    `).all(poId);
    const insert = db.prepare('INSERT INTO expense_entries (date, amount, category, description, po_id) VALUES (?,?,?,?,?)');
    for (const g of groups) {
      if (!g.amount || g.amount <= 0) continue;
      const desc = `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · ${g.line_count} line${g.line_count === 1 ? '' : 's'}`;
      insert.run(po.date, +g.amount, g.category, desc, poId);
      result.inserted++;
      result.total += +g.amount;
      result.categories++;
    }
    if (result.inserted === 0 && groups.length === 0) result.skipped = 'no-line-items';
    else if (result.inserted === 0) result.skipped = 'all-zero-cost';
    return result;
  } catch (e) {
    console.error('[postPOExpenses error] po=' + poId, e);
    result.skipped = 'error: ' + (e.message || 'unknown');
    return result;
  }
}

// GET all POs
router.get('/api/purchases', requireAuth, requirePermission('purchases'), (req, res) => {
  const { status, search, month } = req.query;
  // Retail (online store) POs live in the same table with scope='retail' and
  // their own admin at /api/retail-admin/purchases — keep them out of the
  // kitchen buying list so the two departments don't see each other's noise.
  let q = "SELECT * FROM purchase_orders WHERE COALESCE(scope,'kitchen') = 'kitchen'";
  const params = [];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (month)  { q += " AND substr(date, 1, 7) = ?"; params.push(String(month).slice(0,7)); }
  if (search) {
    // Match across PO number, header supplier, AND any line-level supplier
    // or channel — so the buyer can search "京东" or "美团闪购" and find
    // every PO that touched that channel.
    q += ` AND (po_number LIKE ? OR supplier LIKE ? OR id IN (
      SELECT po_id FROM po_line_items
      WHERE supplier_name LIKE ? OR purchase_channel LIKE ?
    ))`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  q += ' ORDER BY date DESC, id DESC';
  const pos = db.prepare(q).all(...params);
  res.json({ success: true, data: pos });
});

// GET single PO with line items
router.get('/api/purchases/:id', requireAuth, requirePermission('purchases'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found · 未找到' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(po.id);
  res.json({ success: true, data: { ...po, items } });
});

// GET per-ingredient history context for a PO. Returns, for every line item
// that has an ingredient_id, the most recent prior PO line + lifetime stats
// (count, avg/min/max cost). Used by the PO detail view to surface "last
// ordered: 5kg @ ¥X · trending ▼ 8%" without N+1 fetches.
router.get('/api/purchases/:id/history', requireAuth, requirePermission('purchases'), (req, res) => {
  const items = db.prepare('SELECT id, ingredient_id FROM po_line_items WHERE po_id = ?').all(req.params.id);
  const prevStmt = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date, po.source, po.supplier
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.ingredient_id = ? AND po.id != ?
    ORDER BY po.created_at DESC, pli.id DESC
    LIMIT 1`);
  const statsStmt = db.prepare(`
    SELECT COUNT(*)               AS total_orders,
           AVG(pli.cost_per_unit) AS avg_price,
           MIN(pli.cost_per_unit) AS min_price,
           MAX(pli.cost_per_unit) AS max_price,
           SUM(pli.qty)           AS total_qty
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.ingredient_id = ? AND po.id != ?`);
  const out = {};
  for (const it of items) {
    if (!it.ingredient_id) continue;
    const prev  = prevStmt.get(it.ingredient_id, req.params.id) || null;
    const stats = statsStmt.get(it.ingredient_id, req.params.id) || null;
    out[it.ingredient_id] = { previous: prev, stats };
  }
  res.json({ success: true, data: out });
});

// POST create PO
router.post('/api/purchases', requireAuth, requirePermission('purchases'), (req, res) => {
  const { date, delivery_date, supplier, warehouse, notes, items, source } = req.body;
  // Generate PO number
  const count = db.prepare('SELECT COUNT(*) as c FROM purchase_orders').get().c;
  const po_number = 'PO-' + String(count + 1).padStart(4, '0');
  try {
    const result = db.prepare('INSERT INTO purchase_orders (po_number,date,delivery_date,status,supplier,warehouse,notes,source,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(po_number, date, delivery_date||null, 'Requested', supplier||null, warehouse||null, notes||null, source||'manual', req.user.id);
    const poId = result.lastInsertRowid;
    if (items?.length) {
      const insertItem = db.prepare(`INSERT INTO po_line_items
        (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
         supplier_name, purchase_channel, invoice_status, note, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const VALID_STATUS = new Set(['not_received','received','no_invoice']);
      // When a line is linked to an ingredient, fall back to that
      // ingredient's master supplier — so the canonical "we always buy
      // this from X" stays the source of truth even when the buyer left
      // the per-line picker on "inherit".
      const ingSupplierStmt = db.prepare('SELECT supplier FROM ingredients WHERE id = ?');
      items.forEach((item, i) => {
        const total = (parseFloat(item.qty)||0) * (parseFloat(item.cost_per_unit)||0);
        const status = VALID_STATUS.has(item.invoice_status) ? item.invoice_status : 'not_received';
        let lineSupplier = item.supplier_name || supplier || null;
        if (!lineSupplier && item.ingredient_id) {
          const ing = ingSupplierStmt.get(item.ingredient_id);
          if (ing && ing.supplier && ing.supplier.trim()) lineSupplier = ing.supplier.trim();
        }
        insertItem.run(
          poId, item.ingredient_id||null, item.name_en||'', item.name_cn||null, item.sku||null,
          item.qty||0, item.unit || null, item.cost_per_unit||0, total, item.expense_category||null,
          lineSupplier, item.purchase_channel || null,
          status, (item.note||'').trim() || null, i
        );
      });
    }
    logActivity(req.user.id, req.user.username, 'create', 'purchase_order', poId, {po_number}, req.ip);
    // Fan out a push notification to anyone with `purchases` perm —
    // OS-level alert even if their browser is closed.
    _firePOPush(poId, 'created');
    _broadcastPO(poId, 'created', req.user.id);
    res.json({ success: true, id: poId, po_number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update PO status + items
router.put('/api/purchases/:id', requireAuth, requirePermission('purchases'), (req, res) => {
  const { date, delivery_date, status, supplier, warehouse, notes, items } = req.body;
  db.prepare('UPDATE purchase_orders SET date=?,delivery_date=?,status=?,supplier=?,warehouse=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(date, delivery_date||null, status||'Requested', supplier||null, warehouse||null, notes||null, req.params.id);
  if (items) {
    db.prepare('DELETE FROM po_line_items WHERE po_id = ?').run(req.params.id);
    const insertItem = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, invoice_status, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const VALID_STATUS = new Set(['not_received','received','no_invoice']);
    const ingSupplierStmt = db.prepare('SELECT supplier FROM ingredients WHERE id = ?');
    items.forEach((item, i) => {
      const total = (parseFloat(item.qty)||0) * (parseFloat(item.cost_per_unit)||0);
      const status = VALID_STATUS.has(item.invoice_status) ? item.invoice_status : 'not_received';
      // Same fallback chain as the create path: line override → header
      // → ingredient master supplier.
      let lineSupplier = item.supplier_name || supplier || null;
      if (!lineSupplier && item.ingredient_id) {
        const ing = ingSupplierStmt.get(item.ingredient_id);
        if (ing && ing.supplier && ing.supplier.trim()) lineSupplier = ing.supplier.trim();
      }
      insertItem.run(
        req.params.id, item.ingredient_id||null, item.name_en||'', item.name_cn||null, item.sku||null,
        item.qty||0, item.unit || null, item.cost_per_unit||0, total, item.expense_category||null,
        lineSupplier, item.purchase_channel || null,
        status, (item.note||'').trim() || null, i
      );
    });
    // Fire price-history records + alerts on Ordered/Delivered/Confirmed.
    // Was previously gated on Delivered/Confirmed only — but most POs sit
    // at "Ordered" and never get explicitly delivered (the team just
    // partial-receives), so price changes silently accumulated without
    // ever generating an alert. Triggering at Ordered is more practical:
    // the buyer sees the alert the moment they record a higher price.
    if (status === 'Ordered' || status === 'Delivered' || status === 'Confirmed') {
      firePriceAlertsForPO(req.params.id, status === 'Ordered' ? 'po_ordered' : 'po_delivery');
    }
  }
  // First-time delivery: backfill qty_received from qty so the partial-receive
  // UI has a sensible default. Subsequent receive edits go through /receive.
  if (status === 'Delivered' || status === 'Confirmed') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(req.params.id);
  }
  // Auto-post / wipe expense_entries to keep finance in sync with PO state.
  postPOExpenses(req.params.id);
  logActivity(req.user.id, req.user.username, 'update', 'purchase_order', req.params.id, {status}, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/status — status-only update. Avoids the items
// round-trip used by the previous PUT path which would wipe per-line state
// (qty_received, tracking, damaged_qty) every time the user clicked a status.
router.put('/api/purchases/:id/status', requireAuth, requirePermission('purchases'), (req, res) => {
  const { status } = req.body || {};
  if (!['Requested','Ordered','Delivered'].includes(status)) return res.status(400).json({ error: 'Invalid status · 状态无效' });
  const po = db.prepare('SELECT id, status FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  // First-time delivery → seed qty_received from qty so the receive UI has
  // a sensible default. Subsequent edits go through /receive.
  if (status === 'Delivered') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(req.params.id);
  }
  // On Ordered or Delivered, push ingredient prices + fire alerts. Mirrors
  // the items-PUT path above — see that comment for the rationale (POs sit
  // at "Ordered" indefinitely, so gating only on Delivered means alerts
  // never fire in practice).
  if (status === 'Ordered' || status === 'Delivered') {
    firePriceAlertsForPO(req.params.id, status === 'Ordered' ? 'po_ordered' : 'po_delivery');
  }
  // Status flip drives expense posting. PRACTICAL CHANGE (2026): the
  // moment a PO goes Ordered, money is committed (the buyer placed it),
  // so it should land in Finance → Expenses immediately rather than
  // waiting for goods to physically arrive. postPOExpenses is idempotent
  // (DELETE-then-INSERT), so flipping back to Requested wipes the rows.
  if (status === 'Ordered' || status === 'Delivered') {
    postPOExpenses(req.params.id);
  } else if (status === 'Requested') {
    db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(req.params.id);
  }
  logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', req.params.id, { from: po.status, to: status }, req.ip);
  // Push notification on meaningful transitions only (Requested → Ordered,
  // Ordered → Delivered). Skip if the status didn't actually change.
  if (po.status !== status) {
    if (status === 'Delivered') {
      _firePOPush(req.params.id, 'delivered');
      _broadcastPO(req.params.id, 'delivered', req.user.id);
    } else if (status === 'Ordered') {
      _firePOPush(req.params.id, 'ordered');
      _broadcastPO(req.params.id, 'ordered', req.user.id);
    }
  }
  res.json({ success: true });
});

// PUT /api/purchases/:id/receive — bulk-set per-line receive state. Body:
// { receipts: [{ line_id, qty_received, damaged_qty, tracking_number, tracking_carrier }] }
// Returns alert counts so the UI can flag missing/damaged on save.
router.put('/api/purchases/:id/receive', requireAuth, requirePermission('purchases'), (req, res) => {
  try {
    const { receipts } = req.body || {};
    if (!Array.isArray(receipts)) return res.status(400).json({ error: 'receipts[] required · 收货数据必填' });
    const poId = parseInt(req.params.id, 10);
    if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
    const upd = db.prepare(`UPDATE po_line_items SET
      qty_received    = ?,
      damaged_qty     = ?,
      tracking_number = ?,
      tracking_carrier= ?
      WHERE id = ? AND po_id = ?`);
    let missing_lines = 0, damaged_lines = 0, total_missing = 0, total_damaged = 0;
    let any_qty_received = false;
    const tx = db.transaction(() => {
      for (const r of receipts) {
        const lineId = parseInt(r.line_id, 10);
        if (!lineId) continue;
        const line = db.prepare('SELECT qty FROM po_line_items WHERE id = ? AND po_id = ?').get(lineId, poId);
        if (!line) continue;
        const orderedQty = parseFloat(line.qty) || 0;
        const q  = r.qty_received == null || r.qty_received === ''
                   ? null
                   : Math.max(0, parseFloat(r.qty_received) || 0);
        const dq = Math.max(0, parseFloat(r.damaged_qty) || 0);
        const tn = (r.tracking_number || '').toString().trim() || null;
        const tc = (r.tracking_carrier || '').toString().trim() || null;
        // Tracking-only save: caller omits qty_received and damaged_qty
        // entirely (per-line auto-save from the new bottom-of-line tracking
        // input). We update only tracking columns and leave the warehouse's
        // receive state untouched — even if the user is clearing the
        // tracking number to empty (tn = null).
        const isTrackingOnly = r.qty_received === undefined && r.damaged_qty === undefined;
        if (isTrackingOnly) {
          db.prepare('UPDATE po_line_items SET tracking_number = ?, tracking_carrier = ? WHERE id = ? AND po_id = ?')
            .run(tn, tc, lineId, poId);
        } else {
          upd.run(q, dq, tn, tc, lineId, poId);
        }
        if (q != null) any_qty_received = true;
        if (q != null && q < orderedQty) { missing_lines++; total_missing += orderedQty - q; }
        if (dq > 0)                       { damaged_lines++; total_damaged += dq; }
      }
    });
    tx();
    // Only re-post expenses when an actual received quantity was entered.
    // Tracking-only saves leave Finance untouched — tracking is buyer-side
    // metadata, not a money event.
    if (any_qty_received) postPOExpenses(poId);
    logActivity(req.user.id, req.user.username, 'receive', 'purchase_order', poId,
      { lines: receipts.length, missing_lines, damaged_lines, total_missing, total_damaged }, req.ip);
    res.json({ success: true, missing_lines, damaged_lines, total_missing, total_damaged });
  } catch (e) {
    console.error('[receive PO error]', e);
    res.status(500).json({ error: 'Receive failed · 收货失败: ' + (e.message || 'unknown error') });
  }
});

// GET expense-post status for one PO (used by detail page indicator).
router.get('/api/purchases/:id/expense-status', requireAuth, requirePermission('purchases'), (req, res) => {
  const poId = parseInt(req.params.id, 10);
  if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
  const po = db.prepare('SELECT id, status, date, po_number FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const rows = db.prepare(`SELECT category, amount FROM expense_entries WHERE po_id = ? ORDER BY id`).all(poId);
  const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const lineCount = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ?`).get(poId).c;
  const zeroCostLines = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(cost_per_unit,0) = 0`).get(poId).c;
  // Number of lines whose received-or-ordered qty would actually contribute
  // to the expense post (>0). This is the same filter postPOExpenses uses.
  const liveLines = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(qty_received, qty) > 0`).get(poId).c;
  // Compute a smart reason when posted=0 so the UI can explain why.
  // Mirrors the same checks postPOExpenses runs internally.
  const POSTABLE = new Set(['Ordered','Delivered','Confirmed']);
  let skipped = null;
  if (rows.length === 0) {
    if (!POSTABLE.has(po.status)) skipped = 'not-postable';
    else if (lineCount === 0)     skipped = 'no-line-items';
    else if (liveLines === 0)     skipped = 'no-live-qty';   // every line has qty=0 / received=0
    else if (zeroCostLines === lineCount) skipped = 'all-zero-cost';
    else                           skipped = 'never-posted'; // rows exist with cost+qty but nothing was written → posting was never triggered
  }
  res.json({ success: true,
    status: po.status, posted: rows.length, total, skipped,
    categories: rows.map(r => ({ category: r.category, amount: +r.amount })),
    diagnostics: { lineCount, zeroCostLines, liveLines },
  });
});

// POST manual re-post — useful after editing prices or if the auto-post
// silently failed for any reason. Returns the same shape as the helper
// so the UI can show what happened.
router.post('/api/purchases/:id/repost-expense', requireAuth, requirePermission('purchases'), (req, res) => {
  const poId = parseInt(req.params.id, 10);
  if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
  const r = postPOExpenses(poId);
  logActivity(req.user.id, req.user.username, 'repost_expense', 'purchase_order', poId, r, req.ip);
  res.json({ success: true, ...r });
});

// POST /api/purchases/:id/order — transition to "Ordered" with optional split.
// Body: { defer_line_ids: [..] }  — lines listed here are removed from this PO
// and placed into a fresh Requested PO (linked via backorder_of) so the user
// can keep tracking what's still owed by the supplier. Empty/missing array =
// order everything.
router.post('/api/purchases/:id/order', requireAuth, requirePermission('purchases'), (req, res) => {
  try {
    const poId = parseInt(req.params.id, 10);
    if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
    const src = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
    const defer = Array.isArray(req.body?.defer_line_ids) ? req.body.defer_line_ids.map(n => parseInt(n,10)).filter(Boolean) : [];

    let splitId = null, splitNumber = null;
    const tx = db.transaction(() => {
      if (defer.length) {
        // Make a sibling PO for the deferred lines and move them across.
        const lines = db.prepare(`SELECT * FROM po_line_items WHERE po_id = ? AND id IN (${defer.map(()=>'?').join(',')})`).all(poId, ...defer);
        if (lines.length) {
          const today = new Date().toISOString().slice(0, 10);
          const count = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c;
          splitNumber = 'PO-' + String(count + 1).padStart(4, '0');
          const r = db.prepare(`INSERT INTO purchase_orders
            (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by, backorder_of)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            splitNumber, today, null, 'Requested',
            src.supplier, src.warehouse,
            `Deferred from ${src.po_number}${src.notes ? ' · ' + src.notes : ''}`,
            'split', req.user.id, src.id
          );
          splitId = r.lastInsertRowid;
          // Move (not copy) the line items into the new PO.
          db.prepare(`UPDATE po_line_items SET po_id = ? WHERE po_id = ? AND id IN (${defer.map(()=>'?').join(',')})`).run(splitId, poId, ...defer);
        }
      }
      db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('Ordered', poId);
    });
    tx();
    // Now that the PO is at Ordered, fire price alerts so a buyer recording a
    // higher-than-expected price gets surfaced immediately. (The other two
    // status-flip paths already do this; this one used to silently skip it.)
    firePriceAlertsForPO(poId, 'po_ordered');
    postPOExpenses(poId);  // Ordered isn't paid-yet, but keep the row idempotent.
    logActivity(req.user.id, req.user.username, 'order_split', 'purchase_order', poId,
      { deferred_lines: defer.length, split_po: splitNumber }, req.ip);
    res.json({ success: true, split_po_id: splitId, split_po_number: splitNumber });
  } catch (e) {
    console.error('[order split error]', e);
    res.status(500).json({ error: 'Order failed · 下单失败: ' + (e.message || 'unknown') });
  }
});

// POST /api/purchases/:id/backorder — clones outstanding lines (qty - received
// > 0) into a fresh Requested PO linked back via backorder_of. Used when the
// supplier short-shipped and you want to keep tracking the unfulfilled qty.
router.post('/api/purchases/:id/backorder', requireAuth, requirePermission('purchases'), (req, res) => {
  const src = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const lines = db.prepare(`SELECT * FROM po_line_items WHERE po_id = ?
    AND (COALESCE(qty_received, qty) < qty)
    ORDER BY sort_order`).all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: 'No outstanding qty · 没有缺货项目' });

  const today = new Date().toISOString().slice(0, 10);
  const count = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c;
  const po_number = 'PO-' + String(count + 1).padStart(4, '0');

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders
      (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by, backorder_of)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      po_number, today, null, 'Requested',
      src.supplier, src.warehouse,
      `Back-order from ${src.po_number}${src.notes ? ' · ' + src.notes : ''}`,
      'backorder', req.user.id, src.id
    );
    const newId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    lines.forEach((l, i) => {
      const outstanding = (parseFloat(l.qty) || 0) - (l.qty_received == null ? 0 : parseFloat(l.qty_received) || 0);
      const total = outstanding * (parseFloat(l.cost_per_unit) || 0);
      // Carry supplier_name + purchase_channel + note forward; invoice_received
      // resets to false on the back-order so the new line tracks its own
      // separate fulfilment.
      ins.run(newId, l.ingredient_id, l.name_en, l.name_cn, l.sku, outstanding, l.unit, l.cost_per_unit, total, l.expense_category,
        l.supplier_name || null, l.purchase_channel || null, l.note || null, i);
    });
    return { newId, po_number };
  });
  const r = tx();
  logActivity(req.user.id, req.user.username, 'backorder', 'purchase_order', r.newId, { from: src.id, lines: lines.length, po_number: r.po_number }, req.ip);
  res.json({ success: true, id: r.newId, po_number: r.po_number });
});

// DELETE expense rows + log when a PO is hard-deleted (we keep them otherwise
// because expense_entries.po_id is FK without CASCADE).
function clearPOExpenses(poId) {
  db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
}

// POST duplicate — clones a PO into a fresh draft (status=Requested, new
// po_number, today's date). Items are copied verbatim. Useful for recurring
// orders to the same supplier.
router.post('/api/purchases/:id/duplicate', requireAuth, requirePermission('purchases'), (req, res) => {
  const src = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(src.id);

  const today = new Date().toISOString().slice(0, 10);
  const count = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c;
  const po_number = 'PO-' + String(count + 1).padStart(4, '0');

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders
      (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      po_number, today, null, 'Requested',
      src.supplier, src.warehouse, src.notes ? src.notes + ' (copy)' : null,
      'manual', req.user.id
    );
    const newId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, note, lot_number, expiry_date, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Copy structure but DROP lot/expiry + invoice flag on duplicate —
    // those are per-delivery; a duplicate PO is a fresh order so blank-out
    // makes sense. supplier_name + purchase_channel + note ARE carried forward
    // since the buyer is likely re-ordering from the same place.
    items.forEach(i => ins.run(newId, i.ingredient_id, i.name_en, i.name_cn, i.sku, i.qty, i.unit, i.cost_per_unit, i.total_cost, i.expense_category,
      i.supplier_name || null, i.purchase_channel || null, i.note || null, null, null, i.sort_order));
    return { newId, po_number };
  });
  const r = tx();
  logActivity(req.user.id, req.user.username, 'duplicate', 'purchase_order', r.newId, { from: src.id, po_number: r.po_number }, req.ip);
  res.json({ success: true, id: r.newId, po_number: r.po_number });
});

// DELETE PO
router.delete('/api/purchases/:id', requireAuth, requireDelete, requirePermission('purchases'), (req, res) => {
  // Clear linked expense rows first — expense_entries.po_id is FK without
  // CASCADE so this prevents stale finance entries pointing to a missing PO.
  clearPOExpenses(req.params.id);
  db.prepare('DELETE FROM po_line_items WHERE po_id = ?').run(req.params.id);
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'purchase_order', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── Lot tracking / recall traceability ──────────────────────────────────────

// GET /api/lots/search?q=2024-A — find every PO line item with that lot,
// joined to the parent PO so the user can trace back to supplier + date.
router.get('/api/lots/search', requireAuth, requirePermission('purchases'), (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ success: true, data: [] });
  const rows = db.prepare(`
    SELECT pli.*, po.po_number, po.date AS po_date, po.delivery_date, po.supplier, po.status
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.lot_number LIKE ?
    ORDER BY po.date DESC, pli.id DESC
    LIMIT 200
  `).all('%' + q + '%');
  res.json({ success: true, data: rows });
});

// PUT /api/purchases/:id/line/:line_id/invoice — set one line's invoice
// status. Body: { invoice_status: 'not_received' | 'received' | 'no_invoice' }.
// Used by the Invoice Tracking report so accounting can flip status as
// invoices come in (or as suppliers are confirmed not to issue any).
const INVOICE_STATUSES = new Set(['not_received', 'received', 'no_invoice']);
router.put('/api/purchases/:id/line/:line_id/invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const lineId = parseInt(req.params.line_id, 10);
  const poId   = parseInt(req.params.id, 10);
  if (!lineId || !poId) return res.status(400).json({ error: 'invalid id · ID 无效' });
  const status = (req.body && req.body.invoice_status) || '';
  if (!INVOICE_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invoice_status must be not_received | received | no_invoice · 状态无效' });
  }
  // Keep the legacy invoice_received bit in sync so any downstream code
  // looking at it still gets a sensible truthy value for 'received'.
  const r = db.prepare(
    "UPDATE po_line_items SET invoice_status = ?, invoice_received = CASE WHEN ? = 'received' THEN 1 ELSE 0 END WHERE id = ? AND po_id = ?"
  ).run(status, status, lineId, poId);
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'invoice_status_change', 'po_line_item', lineId, { invoice_status: status }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/supplier — set just the supplier (and optional
// warehouse) on the PO header without touching the rest. Useful from the
// Invoices tab when accounting wants to assign a supplier name to old
// POs that fell into the "未指定 Unspecified" bucket.
router.put('/api/purchases/:id/supplier', requireAuth, requirePermission('purchases'), (req, res) => {
  const supplier = (req.body?.supplier || '').trim();
  if (!supplier) return res.status(400).json({ error: 'supplier required · 供应商必填' });
  const r = db.prepare('UPDATE purchase_orders SET supplier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(supplier, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  logActivity(req.user.id, req.user.username, 'set_supplier', 'purchase_order', req.params.id, { supplier }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/line/:line_id/no-invoice — flag ONE line as
// "no invoice expected" (cash / market line on a mixed buying order).
// Toggle, not destructive.
router.put('/api/purchases/:id/line/:line_id/no-invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const flag = !!(req.body && req.body.no_invoice_expected);
  const r = db.prepare('UPDATE po_line_items SET no_invoice_expected = ? WHERE id = ? AND po_id = ?')
    .run(flag ? 1 : 0, req.params.line_id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'line_no_invoice_toggle', 'po_line_item', req.params.line_id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/line/:line_id/supplier — set ONE line's supplier.
// Used by the inline picker on the Invoices tab when a line landed in
// "未指定 Unspecified" because no supplier was set.
router.put('/api/purchases/:id/line/:line_id/supplier', requireAuth, requirePermission('purchases'), (req, res) => {
  const supplier = (req.body?.supplier || '').trim();
  if (!supplier) return res.status(400).json({ error: 'supplier required · 供应商必填' });
  const r = db.prepare('UPDATE po_line_items SET supplier_name = ? WHERE id = ? AND po_id = ?')
    .run(supplier, req.params.line_id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'set_line_supplier', 'po_line_item', req.params.line_id, { supplier }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/no-invoice — flag a PO as "supplier doesn't issue
// an invoice for this purchase" (cash / market). Removes it from the
// awaiting-invoice list. Toggle, not destructive.
router.put('/api/purchases/:id/no-invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const flag = !!(req.body && req.body.no_invoice_expected);
  const r = db.prepare('UPDATE purchase_orders SET no_invoice_expected = ? WHERE id = ?')
    .run(flag ? 1 : 0, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  logActivity(req.user.id, req.user.username, 'no_invoice_toggle', 'purchase_order', req.params.id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true });
});

// GET /api/lots/expiring?days=7 — line items whose expiry_date is within N days
// (or already past). Used by the dashboard "Expiring soon" card and the
// Lot Tracker page. Only Delivered/Confirmed POs count — Requested/Ordered
// items haven't physically arrived yet.
router.get('/api/lots/expiring', requireAuth, requirePermission('purchases'), (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db.prepare(`
    SELECT pli.*, po.po_number, po.supplier, po.status
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL
      AND pli.expiry_date <= date('now', '+' || ? || ' days')
      AND po.status IN ('Delivered', 'Confirmed')
    ORDER BY pli.expiry_date ASC
    LIMIT 200
  `).all(days);
  // Annotate each row with how many days until expiry (negative = past)
  const today = new Date().toISOString().slice(0, 10);
  const t = new Date(today);
  rows.forEach(r => {
    const exp = new Date(r.expiry_date);
    r.days_until = Math.round((exp - t) / 86400000);
  });
  res.json({ success: true, data: rows });
});

// GET /api/lots/all — list every distinct lot # currently in inventory
// (Delivered/Confirmed only). Useful for the lot tracker autocomplete.
router.get('/api/lots/all', requireAuth, requirePermission('purchases'), (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT pli.lot_number, pli.name_en, pli.name_cn, pli.sku, MAX(po.date) AS last_received
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.lot_number IS NOT NULL AND pli.lot_number != ''
      AND po.status IN ('Delivered', 'Confirmed')
    GROUP BY pli.lot_number, pli.name_en
    ORDER BY last_received DESC
    LIMIT 500
  `).all();
  res.json({ success: true, data: rows });
});

// One-time backfill: any Ordered/Delivered/Confirmed PO that has zero rows in
// expense_entries gets posted. Safe to run on every boot — the postPOExpenses
// helper is idempotent (it deletes existing po_id rows first), but we filter
// to "missing" POs to avoid unnecessary writes. Logs a one-line summary.
function backfillOrderedExpenses() {
  try {
    const rows = db.prepare(`
      SELECT po.id, po.po_number, po.status
      FROM purchase_orders po
      WHERE po.status IN ('Ordered', 'Delivered', 'Confirmed')
        AND NOT EXISTS (SELECT 1 FROM expense_entries e WHERE e.po_id = po.id)
    `).all();
    if (!rows.length) {
      console.log('[backfillOrderedExpenses] nothing to do — all postable POs already have expense rows.');
      return { scanned: 0, posted: 0 };
    }
    let posted = 0, totalAmount = 0;
    for (const r of rows) {
      const result = postPOExpenses(r.id);
      if (result.inserted > 0) { posted++; totalAmount += result.total; }
    }
    console.log(`[backfillOrderedExpenses] scanned ${rows.length} PO(s) → posted ${posted} (¥${totalAmount.toFixed(2)} total).`);
    return { scanned: rows.length, posted, totalAmount };
  } catch (e) {
    console.error('[backfillOrderedExpenses error]', e);
    return { error: e.message };
  }
}

// Run once, deferred so the rest of the app boots first.
setTimeout(backfillOrderedExpenses, 2000);

module.exports = router;
module.exports.postPOExpenses = postPOExpenses;
// Exported for scripts/test_price_writeback.js — the price write-back is money
// maths and needs to be exercisable against a fixture DB, not only through a
// live PO status flip.
module.exports.firePriceAlertsForPO = firePriceAlertsForPO;
module.exports.backfillOrderedExpenses = backfillOrderedExpenses;
