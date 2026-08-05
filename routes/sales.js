const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
const router = express.Router();

// 'miniapp' replaces the old 'wechat' channel — sales come from the
// official mini app, not raw WeChat. Existing 'wechat' rows are migrated
// to 'miniapp' by an idempotent migration in database.js. Both ids
// accepted here for backwards-compat with any client still posting old.
const CHANNELS = ['dinein', 'meituan', 'eleme', 'miniapp', 'wechat', 'retail', 'gzgrocery'];

// GET list with filters
router.get('/api/sales', requireAuth, requirePermission('sales'), (req, res) => {
  const { from, to, channel, product_id, search, month } = req.query;
  let q = `SELECT s.*, p.sku AS product_sku, p.category AS product_category
           FROM sales_entries s
           LEFT JOIN products p ON p.id = s.product_id
           WHERE 1=1`;
  const params = [];
  if (month) { q += ' AND substr(s.date,1,7) = ?'; params.push(month); }
  if (from)  { q += ' AND s.date >= ?'; params.push(from); }
  if (to)    { q += ' AND s.date <= ?'; params.push(to); }
  if (channel) { q += ' AND s.channel = ?'; params.push(channel); }
  if (product_id) { q += ' AND s.product_id = ?'; params.push(product_id); }
  if (search) {
    q += ' AND (s.product_name LIKE ? OR p.sku LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s);
  }
  q += ' ORDER BY s.date DESC, s.id DESC LIMIT 500';
  res.json({ success: true, data: db.prepare(q).all(...params) });
});

// POST create — server computes total
router.post('/api/sales', requireAuth, requirePermission('sales'), (req, res) => {
  const { date, product_id, product_name, channel, qty, unit_price, notes } = req.body;
  const q = parseFloat(qty);
  const price = parseFloat(unit_price);
  if (!date) return res.status(400).json({ error: 'date required · 日期必填' });
  if (!q || q <= 0) return res.status(400).json({ error: 'qty must be positive · 数量必须大于零' });
  if (price == null || isNaN(price) || price < 0) return res.status(400).json({ error: 'unit_price required · 单价必填' });
  if (!channel) return res.status(400).json({ error: 'channel required · 渠道必填' });

  // Resolve product name from id when possible (keeps name snapshot consistent)
  let resolvedName = product_name || '';
  if (product_id) {
    const p = db.prepare('SELECT name_en FROM products WHERE id = ?').get(product_id);
    if (p) resolvedName = p.name_en;
  }
  if (!resolvedName) return res.status(400).json({ error: 'product_name required · 产品名称必填' });

  const total = q * price;
  try {
    const result = db.prepare(`
      INSERT INTO sales_entries (date, product_id, product_name, channel, qty, unit_price, total, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(date, product_id || null, resolvedName, channel, q, price, total, notes || null, req.user.id);
    logActivity(req.user.id, req.user.username, 'create', 'sale', result.lastInsertRowid, { product: resolvedName, channel, total }, req.ip);
    const row = db.prepare('SELECT * FROM sales_entries WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, id: result.lastInsertRowid, data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST bulk import — used by the CSV uploader on the Sales page after the
// user maps columns. Skips invalid rows (returns counts) instead of aborting,
// so a few bad rows don't kill the whole import. Each row resolves
// product_id by SKU or name when not supplied directly.
router.post('/api/sales/bulk', requireAuth, requirePermission('sales'), (req, res) => {
  const rows = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'entries[] required · 数据为空' });

  const findByName = db.prepare('SELECT id, name_en FROM products WHERE LOWER(name_en) = LOWER(?) OR LOWER(name_cn) = LOWER(?) LIMIT 1');
  const findBySku  = db.prepare('SELECT id, name_en FROM products WHERE LOWER(sku) = LOWER(?) LIMIT 1');
  const insert = db.prepare(`INSERT INTO sales_entries
    (date, product_id, product_name, channel, qty, unit_price, total, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const stats = { inserted: 0, skipped: 0, errors: [] };
  const importTx = db.transaction(() => {
    rows.forEach((r, idx) => {
      const date  = (r.date || '').toString().trim();
      const channel = (r.channel || '').toString().trim();
      const qty   = parseFloat(r.qty);
      // unit_price is preferred but we accept total → derive when missing
      let unit  = parseFloat(r.unit_price);
      const totalIn = parseFloat(r.total);
      if ((!unit || isNaN(unit)) && totalIn && qty) unit = totalIn / qty;
      if (!date || !channel || !qty || qty <= 0 || unit == null || isNaN(unit) || unit < 0) {
        stats.skipped++; stats.errors.push(`Row ${idx+1}: missing/invalid date|channel|qty|price`); return;
      }
      // Resolve product_id from sku/name when not supplied
      let productId = r.product_id ? parseInt(r.product_id, 10) : null;
      let productName = (r.product_name || '').toString().trim();
      if (!productId && r.sku) {
        const p = findBySku.get(String(r.sku).trim());
        if (p) { productId = p.id; if (!productName) productName = p.name_en; }
      }
      if (!productId && productName) {
        const p = findByName.get(productName, productName);
        if (p) { productId = p.id; productName = p.name_en; }
      }
      if (!productName) { stats.skipped++; stats.errors.push(`Row ${idx+1}: no product name`); return; }

      const total = qty * unit;
      insert.run(date, productId || null, productName, channel, qty, unit, total, r.notes || null, req.user.id);
      stats.inserted++;
    });
  });
  try {
    importTx();
    logActivity(req.user.id, req.user.username, 'bulk_import', 'sale', null,
      { inserted: stats.inserted, skipped: stats.skipped }, req.ip);
    // Cap error array so a thousand-row file doesn't blow up the response
    if (stats.errors.length > 50) stats.errors = stats.errors.slice(0, 50).concat([`… ${stats.errors.length - 50} more`]);
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update
router.put('/api/sales/:id', requireAuth, requirePermission('sales'), (req, res) => {
  const { date, channel, qty, unit_price, notes } = req.body;
  const existing = db.prepare('SELECT * FROM sales_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found · 未找到' });
  const q = parseFloat(qty);
  const price = parseFloat(unit_price);
  const total = (isNaN(q) ? existing.qty : q) * (isNaN(price) ? existing.unit_price : price);
  db.prepare(`UPDATE sales_entries SET
    date=?, channel=?, qty=?, unit_price=?, total=?, notes=?
    WHERE id=?`).run(
      date || existing.date,
      channel || existing.channel,
      isNaN(q) ? existing.qty : q,
      isNaN(price) ? existing.unit_price : price,
      total,
      notes != null ? notes : existing.notes,
      req.params.id
    );
  logActivity(req.user.id, req.user.username, 'update', 'sale', req.params.id, null, req.ip);
  res.json({ success: true });
});

// DELETE
router.delete('/api/sales/:id', requireAuth, requireDelete, requirePermission('sales'), (req, res) => {
  const r = db.prepare('DELETE FROM sales_entries WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found · 未找到' });
  logActivity(req.user.id, req.user.username, 'delete', 'sale', req.params.id, null, req.ip);
  res.json({ success: true });
});

// GET summary — KPIs, monthly buckets by channel, top products, channel mix
// GET /api/sales/top-products?period=<>&rank_by=revenue|units&limit=10
// Lightweight version of the top-products section in /api/sales/summary —
// just the ranked product list. Lets the dashboard re-render its Top
// Products card on a different period without re-running the whole
// summary. Same data source / logic as the summary endpoint.
router.get('/api/sales/top-products', requireAuth, requirePermission('sales'), (req, res) => {
  const period = req.query.period || 'this_month';
  const rank_by = (req.query.rank_by === 'units') ? 'units' : 'revenue';
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const now = new Date();
  let from, to, label;
  if      (period === 'last_7')    { from = new Date(Date.now()-7*86400000).toISOString().slice(0,10);   to = now.toISOString().slice(0,10); label = 'Last 7 days'; }
  else if (period === 'last_30')   { from = new Date(Date.now()-30*86400000).toISOString().slice(0,10);  to = now.toISOString().slice(0,10); label = 'Last 30 days'; }
  else if (period === 'last_90')   { from = new Date(Date.now()-90*86400000).toISOString().slice(0,10);  to = now.toISOString().slice(0,10); label = 'Last 3 months'; }
  else if (period === 'last_180')  { from = new Date(Date.now()-180*86400000).toISOString().slice(0,10); to = now.toISOString().slice(0,10); label = 'Last 6 months'; }
  else if (period === 'this_year') { from = new Date(now.getFullYear(),0,1).toISOString().slice(0,10);   to = now.toISOString().slice(0,10); label = 'Year-to-date'; }
  else if (period === 'all')       { from = '0000-01-01'; to = '9999-12-31'; label = 'All time'; }
  else { /* this_month */            from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
                                     to   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
                                     label = 'This month'; }

  const rows = db.prepare(`
    SELECT product_id, product_name AS name,
           SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS count
      FROM sales_entries
     WHERE date >= ? AND date <= ? AND product_id IS NOT NULL
     GROUP BY product_id, product_name
     ORDER BY ${rank_by === 'units' ? 'units' : 'revenue'} DESC
     LIMIT ?`).all(from, to, limit);

  // Aggregated (non-product) rows excluded from ranking — same hint as in /summary.
  const agg = db.prepare(`
    SELECT COUNT(*) AS rows_ct, COALESCE(SUM(total),0) AS revenue
      FROM sales_entries WHERE date >= ? AND date <= ? AND product_id IS NULL`).get(from, to);

  res.json({
    success: true,
    period, label, rank_by,
    from, to,
    topProducts: rows,
    topProductsAggregatedExcluded: { rows: agg.rows_ct, revenue: agg.revenue },
  });
});

// Add-on usage summary — for each addon product, how many times it shipped
// alongside another product in the period. Driven by sale_addons (populated
// by the miniapp importer + scripts/backfill_addons.js). Add-ons don't
// generate revenue on their own row — pricing stays on the parent sale —
// so we report units / occurrences only.
router.get('/api/sales/addons-summary', requireAuth, requirePermission('sales'), (req, res) => {
  const period = req.query.period || 'this_month';
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const now = new Date();
  let from, to, label;
  if      (period === 'last_7')    { from = new Date(Date.now()-7*86400000).toISOString().slice(0,10);   to = now.toISOString().slice(0,10); label = 'Last 7 days'; }
  else if (period === 'last_30')   { from = new Date(Date.now()-30*86400000).toISOString().slice(0,10);  to = now.toISOString().slice(0,10); label = 'Last 30 days'; }
  else if (period === 'last_90')   { from = new Date(Date.now()-90*86400000).toISOString().slice(0,10);  to = now.toISOString().slice(0,10); label = 'Last 3 months'; }
  else if (period === 'this_year') { from = new Date(now.getFullYear(),0,1).toISOString().slice(0,10);   to = now.toISOString().slice(0,10); label = 'Year-to-date'; }
  else if (period === 'all')       { from = '0000-01-01'; to = '9999-12-31'; label = 'All time'; }
  else { from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
         to   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
         label = 'This month'; }
  const rows = db.prepare(`
    SELECT p.id   AS product_id,
           p.sku,
           COALESCE(p.name_en, p.name_cn) AS name,
           p.name_cn,
           SUM(sa.qty)   AS units,
           COUNT(*)      AS occurrences
      FROM sale_addons sa
      JOIN sales_entries s ON s.id = sa.sale_id
      JOIN products      p ON p.id = sa.addon_product_id
     WHERE s.date >= ? AND s.date <= ?
     GROUP BY sa.addon_product_id
     ORDER BY units DESC
     LIMIT ?`).all(from, to, limit);
  res.json({ success: true, period, label, from, to, addons: rows });
});

router.get('/api/sales/summary', requireAuth, requirePermission('sales'), (req, res) => {
  const period = req.query.period || 'this_month';
  const now = new Date();
  let from, to, label;
  if (period === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    to   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
    label = 'This month';
  } else if (period === 'last_30') {
    from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10);
    to   = now.toISOString().slice(0,10);
    label = 'Last 30 days';
  } else if (period === 'last_7') {
    from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0,10);
    to   = now.toISOString().slice(0,10);
    label = 'Last 7 days';
  } else if (period === 'last_90') {
    // Last 3 months — rolling 90-day window
    from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    to   = now.toISOString().slice(0,10);
    label = 'Last 3 months';
  } else if (period === 'last_180') {
    // Last half year — rolling 180-day window
    from = new Date(Date.now() - 180 * 86400000).toISOString().slice(0,10);
    to   = now.toISOString().slice(0,10);
    label = 'Last 6 months';
  } else if (period === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);
    to   = now.toISOString().slice(0,10);
    label = 'Year-to-date';
  } else { // 'all'
    from = '0000-01-01'; to = '9999-12-31'; label = 'All time';
  }

  const periodRows = db.prepare('SELECT * FROM sales_entries WHERE date >= ? AND date <= ?').all(from, to);
  const totalRev   = periodRows.reduce((s, r) => s + (r.total || 0), 0);
  const totalUnits = periodRows.reduce((s, r) => s + (r.qty || 0), 0);
  // Transactions = distinct ORDERS (one ticket per real order, not one
  // ticket per line). Mini-app rows carry an [miniapp:OID:LINE] tag in
  // notes — we extract OID and dedupe. Manual sales entries have no
  // tag, so each row counts as its own ticket. This keeps Avg Ticket
  // honest: a 5-line mini-app order is one ¥314 ticket, not five ¥63
  // line items.
  const ticketKeys = new Set();
  for (const r of periodRows) {
    const m = (r.notes || '').match(/^\[miniapp:(\d+):/);
    if (m) ticketKeys.add('miniapp:' + m[1]);
    else   ticketKeys.add('row:' + r.id);
  }
  const txCount    = ticketKeys.size;
  const avgTicket  = txCount > 0 ? totalRev / txCount : 0;

  // Channel mix — `count` is also distinct-orders, not line count, for
  // the same reason as txCount above.
  const channelMix = {};
  const channelTicketSeen = {};
  for (const ch of CHANNELS) {
    channelMix[ch] = { revenue: 0, units: 0, count: 0 };
    channelTicketSeen[ch] = new Set();
  }
  for (const r of periodRows) {
    if (!channelMix[r.channel]) {
      channelMix[r.channel] = { revenue: 0, units: 0, count: 0 };
      channelTicketSeen[r.channel] = new Set();
    }
    channelMix[r.channel].revenue += r.total || 0;
    channelMix[r.channel].units   += r.qty || 0;
    const m = (r.notes || '').match(/^\[miniapp:(\d+):/);
    const tk = m ? ('miniapp:' + m[1]) : ('row:' + r.id);
    if (!channelTicketSeen[r.channel].has(tk)) {
      channelTicketSeen[r.channel].add(tk);
      channelMix[r.channel].count++;
    }
  }

  // Trend chart buckets — granularity follows the active period selector.
  //   short windows (≤ ~90 days) → DAILY buckets
  //   longer windows             → MONTHLY buckets
  // Both shapes use the same field names ({ month, total, <channel>: amt })
  // so the frontend renders identically regardless of granularity.
  // (Earlier this checked '7d'/'30d' which never matched — actual ids
  // are 'last_7'/'last_30' — so daily mode only ever fired for
  // this_month. Fixed below to match real ids and include the new
  // last_90 preset.)
  const dailyMode = (
    period === 'last_7' ||
    period === 'last_30' ||
    period === 'last_90' ||
    period === 'this_month'
  );
  const buckets = {};
  let bucket_granularity = 'monthly';
  if (dailyMode) {
    bucket_granularity = 'daily';
    // Build empty buckets for every day in the active window.
    const startD = new Date(from + 'T00:00:00');
    const endD   = new Date(to   + 'T00:00:00');
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { month: key };
      for (const ch of CHANNELS) buckets[key][ch] = 0;
      buckets[key].total = 0;
    }
    const dailyRows = db.prepare(
      "SELECT date, channel, SUM(total) AS total FROM sales_entries WHERE date >= ? AND date <= ? GROUP BY date, channel"
    ).all(from, to);
    for (const r of dailyRows) {
      if (buckets[r.date]) {
        buckets[r.date][r.channel] = (buckets[r.date][r.channel] || 0) + (r.total || 0);
        buckets[r.date].total += r.total || 0;
      }
    }
  } else if (period === 'ytd') {
    // Jan of current year → current month
    for (let m = 0; m <= now.getMonth(); m++) {
      const key = now.getFullYear() + '-' + String(m + 1).padStart(2, '0');
      buckets[key] = { month: key };
      for (const ch of CHANNELS) buckets[key][ch] = 0;
      buckets[key].total = 0;
    }
    const monthlyRows = db.prepare(
      "SELECT substr(date,1,7) AS month, channel, SUM(total) AS total FROM sales_entries WHERE substr(date,1,4) = ? GROUP BY month, channel"
    ).all(String(now.getFullYear()));
    for (const r of monthlyRows) {
      if (buckets[r.month]) {
        buckets[r.month][r.channel] = (buckets[r.month][r.channel] || 0) + (r.total || 0);
        buckets[r.month].total += r.total || 0;
      }
    }
  } else {
    // 'all' or fallback — every month with data, oldest → newest
    const monthlyRows = db.prepare(
      "SELECT substr(date,1,7) AS month, channel, SUM(total) AS total FROM sales_entries GROUP BY month, channel ORDER BY month"
    ).all();
    for (const r of monthlyRows) {
      if (!buckets[r.month]) {
        buckets[r.month] = { month: r.month };
        for (const ch of CHANNELS) buckets[r.month][ch] = 0;
        buckets[r.month].total = 0;
      }
      buckets[r.month][r.channel] = (buckets[r.month][r.channel] || 0) + (r.total || 0);
      buckets[r.month].total += r.total || 0;
    }
  }
  const monthly_buckets = Object.values(buckets).sort((a, b) => a.month.localeCompare(b.month));

  // Top products in period — only count rows that resolve to a real
  // product (product_id present). Meituan rows are projected per-order
  // without line-item product detail, so they have product_id=NULL and
  // a placeholder name like 'Meituan Yuexiu 越秀 order' — they'd
  // pollute a product ranking. Same goes for any other aggregated
  // projection that doesn't carry product-level data.
  const byProduct = {};
  let aggregatedRev = 0, aggregatedRows = 0;
  for (const r of periodRows) {
    if (!r.product_id) {
      aggregatedRev += r.total || 0; aggregatedRows++;
      continue;
    }
    const key = r.product_id;
    if (!byProduct[key]) byProduct[key] = { name: r.product_name, product_id: r.product_id, revenue: 0, units: 0, count: 0 };
    byProduct[key].revenue += r.total || 0;
    byProduct[key].units   += r.qty   || 0;
    byProduct[key].count   += 1;
  }
  const topProducts = Object.values(byProduct).sort((a,b) => b.revenue - a.revenue).slice(0, 10);
  // Hint to the frontend so it can disclose how much aggregated revenue
  // was excluded from this ranking.
  const topProductsAggregatedExcluded = { revenue: aggregatedRev, rows: aggregatedRows };

  // Previous-period revenue for MoM badge
  const dur = (new Date(to) - new Date(from)) / 86400000 + 1;
  const prevTo   = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(from).getTime() - dur * 86400000).toISOString().slice(0, 10);
  const prevRev = db.prepare('SELECT COALESCE(SUM(total),0) AS s FROM sales_entries WHERE date >= ? AND date <= ?').get(prevFrom, prevTo).s;
  const revDeltaPct = prevRev > 0 ? ((totalRev - prevRev) / prevRev * 100) : null;

  res.json({
    success: true,
    data: {
      period, label, from, to,
      totalRev, totalUnits, avgTicket, txCount,
      revDeltaPct, prevRev,
      channelMix, monthly_buckets, bucket_granularity, topProducts, topProductsAggregatedExcluded,
      channels: CHANNELS,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MINI APP ANALYTICS — bespoke aggregations on top of miniapp_orders +
// miniapp_order_lines. The existing /api/sales endpoint is product-line
// centric; this one rolls up customer / geography / coupon / time-of-day
// dimensions that the line table doesn't expose. Date filters are inclusive.
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/miniapp/analytics', requireAuth, requirePermission('sales'), (req, res) => {
  const { from, to } = req.query;
  // The order_date column is "YYYY-MM-DD HH:MM:SS"; substr to date for filter.
  const where = ['1=1'];
  const params = [];
  if (from) { where.push("substr(o.order_date,1,10) >= ?"); params.push(from); }
  if (to)   { where.push("substr(o.order_date,1,10) <= ?"); params.push(to);   }
  // Exclude closed/cancelled orders from KPI totals — they shouldn't count
  // toward revenue. 交易成功 = success, 待评价 = awaiting review (still
  // counts), 订单关闭 = closed/cancelled (skip).
  const countableStatus = "o.status IN ('交易成功', '待评价')";

  const W = where.join(' AND ');

  // ── Headline KPIs ────────────────────────────────────────────────────
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                AS orders,
      COALESCE(SUM(o.income), 0)              AS revenue,
      COALESCE(SUM(o.product_total), 0)       AS product_total,
      COALESCE(SUM(o.delivery_fee), 0)        AS delivery_fee,
      COALESCE(SUM(o.refund_amount), 0)       AS refund_amount,
      COALESCE(AVG(o.income), 0)              AS aov,
      SUM(CASE WHEN o.refund_status = 'Yes' THEN 1 ELSE 0 END) AS refunded_orders,
      COUNT(DISTINCT o.user_id)               AS unique_customers,
      COUNT(DISTINCT o.district)              AS unique_districts
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
  `).get(...params);

  // Repeat-customer split: how many users have only one order vs multiple
  // within the filter window.
  const repeatRow = db.prepare(`
    WITH per_user AS (
      SELECT user_id, COUNT(*) AS n
        FROM miniapp_orders o
       WHERE ${W} AND ${countableStatus} AND user_id IS NOT NULL
       GROUP BY user_id
    )
    SELECT
      SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS one_time,
      SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS repeat
      FROM per_user
  `).get(...params);

  // Daily revenue + orders (for the trend chart)
  const daily = db.prepare(`
    SELECT substr(o.order_date, 1, 10) AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(o.income), 0) AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
     GROUP BY day
     ORDER BY day
  `).all(...params);

  // Top customers by lifetime revenue (top 15)
  const topCustomers = db.prepare(`
    SELECT user_id,
           customer_phone AS phone,
           customer_name  AS name,
           COUNT(*)       AS orders,
           COALESCE(SUM(o.income), 0) AS revenue,
           MAX(o.order_date) AS last_order
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus} AND user_id IS NOT NULL
     GROUP BY user_id
     ORDER BY revenue DESC
     LIMIT 15
  `).all(...params);

  // Geographic — by city (the operationally meaningful unit) AND by
  // district (drill-down). Cities answer "where should we open the next
  // pickup point?"; districts answer "where should our delivery hub
  // sit?". Province included for context.
  const geoCities = db.prepare(`
    SELECT province, city,
           COUNT(*)                    AS orders,
           COUNT(DISTINCT user_id)     AS customers,
           COALESCE(SUM(o.income), 0)  AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus} AND city IS NOT NULL
     GROUP BY province, city
     ORDER BY revenue DESC
     LIMIT 15
  `).all(...params);

  const geoDistricts = db.prepare(`
    SELECT province, city, district,
           COUNT(*) AS orders,
           COALESCE(SUM(o.income), 0) AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus} AND district IS NOT NULL
     GROUP BY province, city, district
     ORDER BY revenue DESC
     LIMIT 20
  `).all(...params);

  // Coupons — usage + total discount given. Helps gauge ROI of campaigns.
  const coupons = db.prepare(`
    SELECT coupon_name AS name,
           COUNT(*) AS uses,
           COALESCE(SUM(o.income), 0) AS revenue,
           COALESCE(SUM(o.coupon_discount), 0) AS discount_total
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus} AND coupon_name IS NOT NULL
     GROUP BY coupon_name
     ORDER BY uses DESC
  `).all(...params);

  // Top products by revenue + units (joins lines, filters by date via order)
  const topProducts = db.prepare(`
    SELECT l.product_id,
           l.product_name_en AS name_en,
           l.product_name_cn AS name_cn,
           COUNT(*) AS line_count,
           COALESCE(SUM(l.units), 0)      AS units,
           COALESCE(SUM(l.line_total), 0) AS revenue,
           SUM(CASE WHEN l.refund_status = 'Yes' THEN 1 ELSE 0 END) AS refund_count
      FROM miniapp_order_lines l
      JOIN miniapp_orders o ON o.id = l.order_id
     WHERE ${W} AND ${countableStatus}
     GROUP BY l.product_name_en, l.product_name_cn
     ORDER BY revenue DESC
     LIMIT 25
  `).all(...params);

  // Hour-of-day demand curve — when orders land. Useful for staffing.
  const hourly = db.prepare(`
    SELECT CAST(substr(o.order_date, 12, 2) AS INTEGER) AS hour,
           COUNT(*) AS orders,
           COALESCE(SUM(o.income), 0) AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
     GROUP BY hour
     ORDER BY hour
  `).all(...params);

  // Day-of-week demand (0=Sunday in SQLite's strftime '%w')
  const dow = db.prepare(`
    SELECT CAST(strftime('%w', o.order_date) AS INTEGER) AS dow,
           COUNT(*) AS orders,
           COALESCE(SUM(o.income), 0) AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
     GROUP BY dow
     ORDER BY dow
  `).all(...params);

  // Delivery channel split (pickup vs delivery, courier breakdown)
  const delivery = db.prepare(`
    SELECT
      CASE WHEN o.pickup_store IS NOT NULL AND o.pickup_store != '' THEN 'Pickup' ELSE 'Delivery' END AS mode,
      o.delivery_company AS company,
      COUNT(*) AS orders
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
     GROUP BY mode, company
     ORDER BY orders DESC
  `).all(...params);

  // Hour × Day-of-Week heatmap — 24 hours × 7 days. The frontend renders
  // a colored grid where intensity = order count for that cell.
  const heat = db.prepare(`
    SELECT CAST(strftime('%w', o.order_date) AS INTEGER) AS dow,
           CAST(substr(o.order_date, 12, 2) AS INTEGER) AS hour,
           COUNT(*) AS orders,
           COALESCE(SUM(o.income), 0) AS revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus}
     GROUP BY dow, hour
  `).all(...params);

  // Cohort retention matrix — for each first-order month, how many of
  // those customers came back in subsequent months. Frontend pivots this
  // into a heatmap-style table. We don't constrain by date filter here:
  // cohorts span the full history regardless of the active window so the
  // matrix is interpretable even with a narrow filter.
  const cohorts = db.prepare(`
    WITH first_orders AS (
      SELECT user_id, MIN(substr(order_date, 1, 7)) AS cohort_month
        FROM miniapp_orders
       WHERE user_id IS NOT NULL AND status IN ('交易成功', '待评价')
       GROUP BY user_id
    )
    SELECT fo.cohort_month,
           substr(o.order_date, 1, 7) AS active_month,
           COUNT(DISTINCT o.user_id) AS active_customers
      FROM miniapp_orders o
      JOIN first_orders fo ON fo.user_id = o.user_id
     WHERE o.status IN ('交易成功', '待评价')
     GROUP BY fo.cohort_month, active_month
     ORDER BY fo.cohort_month, active_month
  `).all();
  // Cohort sizes — how many customers in each cohort, for percentages.
  const cohortSizes = db.prepare(`
    WITH first_orders AS (
      SELECT user_id, MIN(substr(order_date, 1, 7)) AS cohort_month
        FROM miniapp_orders
       WHERE user_id IS NOT NULL AND status IN ('交易成功', '待评价')
       GROUP BY user_id
    )
    SELECT cohort_month, COUNT(*) AS size
      FROM first_orders
     GROUP BY cohort_month
     ORDER BY cohort_month
  `).all();

  // Period comparison — same length window immediately preceding the
  // active one. Skipped if no `from`/`to` (an "all-time" view has no prev).
  let prev = null;
  if (from && to) {
    const f = new Date(from), t = new Date(to);
    const days = Math.round((t - f) / 86400000);
    if (days > 0) {
      const prevTo   = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - days);
      const pf = prevFrom.toISOString().slice(0, 10);
      const pt = prevTo.toISOString().slice(0, 10);
      prev = db.prepare(`
        SELECT COUNT(*) AS orders, COALESCE(SUM(o.income), 0) AS revenue,
               COALESCE(AVG(o.income), 0) AS aov,
               COUNT(DISTINCT o.user_id) AS unique_customers
          FROM miniapp_orders o
         WHERE substr(o.order_date,1,10) >= ? AND substr(o.order_date,1,10) <= ?
           AND ${countableStatus}
      `).get(pf, pt);
      prev.window = { from: pf, to: pt };
    }
  }

  // Top referrers — who's bringing in customers
  const referrers = db.prepare(`
    SELECT referrer_phone AS phone,
           referrer_name  AS name,
           COUNT(*) AS referred_orders,
           COALESCE(SUM(o.income), 0) AS referred_revenue
      FROM miniapp_orders o
     WHERE ${W} AND ${countableStatus} AND referrer_phone IS NOT NULL
     GROUP BY referrer_phone
     ORDER BY referred_orders DESC
     LIMIT 10
  `).all(...params);

  res.json({
    success: true,
    data: {
      window: { from: from || null, to: to || null },
      totals: {
        ...totals,
        repeat_customer_rate: (repeatRow.one_time || repeatRow.repeat)
          ? Math.round((repeatRow.repeat / (repeatRow.one_time + repeatRow.repeat)) * 1000) / 10
          : 0,
        one_time_customers:  repeatRow.one_time || 0,
        repeat_customers:    repeatRow.repeat   || 0,
      },
      daily, topCustomers, geoCities, geoDistricts, coupons, topProducts,
      hourly, dow, heat, cohorts, cohortSizes, prev,
      delivery, referrers,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GZGROCERY ANALYTICS — separate channel, aggregated per-period (no
// per-order data). Each sales_entries row has a notes tag like
// `[gzgrocery:YYYY-MM-DD..YYYY-MM-DD:SKU]`. We parse those tags to
// regroup by period and compute period-level KPIs + product-level
// rankings + variant-group comparisons (which size sells more).
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/gzgrocery/analytics', requireAuth, requirePermission('sales'), (req, res) => {
  const { from, to } = req.query;
  const where = ["s.channel = 'gzgrocery'"];
  const params = [];
  if (from) { where.push('s.date >= ?'); params.push(from); }
  if (to)   { where.push('s.date <= ?'); params.push(to);   }
  const W = where.join(' AND ');

  // All gzgrocery sales rows in scope, joined to products for variant info
  const rows = db.prepare(`
    SELECT s.id, s.date, s.product_id, s.product_name, s.qty, s.unit_price, s.total, s.notes,
           p.name_en, p.name_cn, p.sku, p.variant_group_id, p.variant_label,
           p.category
      FROM sales_entries s
      LEFT JOIN products p ON p.id = s.product_id
     WHERE ${W}
     ORDER BY s.date, p.name_en
  `).all(...params);

  // Parse the period tag from notes to recover the original file's date range.
  // tag format: `[gzgrocery:2026-03-01..2026-03-03:SKU]`
  const periods = new Map();   // 'from..to' → { from, to, midpoint, rows, revenue }
  const tagRe = /^\[gzgrocery:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}):/;
  for (const r of rows) {
    const m = (r.notes || '').match(tagRe);
    const key = m ? `${m[1]}..${m[2]}` : 'unknown';
    if (!periods.has(key)) {
      periods.set(key, { from: m?.[1] || null, to: m?.[2] || null, midpoint: r.date,
                         rows: 0, units: 0, revenue: 0 });
    }
    const p = periods.get(key);
    p.rows += 1; p.units += r.qty || 0; p.revenue += r.total || 0;
  }
  const periodList = [...periods.values()].sort((a, b) => (a.from || '').localeCompare(b.from || ''));

  // Total KPIs
  const totals = {
    revenue:    rows.reduce((s, r) => s + (r.total || 0), 0),
    units:      rows.reduce((s, r) => s + (r.qty || 0), 0),
    line_count: rows.length,
    period_count: periodList.length,
    distinct_products: new Set(rows.map(r => r.product_id).filter(Boolean)).size,
    avg_discount: 0,  // computed below from notes tags
  };
  // Discount % is encoded in notes as "Discount: NN%" — parse + average.
  let dSum = 0, dCount = 0;
  for (const r of rows) {
    const m = (r.notes || '').match(/Discount:\s*(\d+)%/);
    if (m) { dSum += parseInt(m[1], 10); dCount++; }
  }
  totals.avg_discount = dCount > 0 ? Math.round((dSum / dCount) * 10) / 10 : 0;

  // Top products by revenue
  const byProduct = new Map();
  for (const r of rows) {
    const key = r.product_id || ('raw:' + r.product_name);
    if (!byProduct.has(key)) byProduct.set(key, {
      product_id: r.product_id, sku: r.sku || '',
      name_en: r.name_en || r.product_name, name_cn: r.name_cn || '',
      variant_label: r.variant_label || '', variant_group_id: r.variant_group_id,
      category: r.category || '',
      lines: 0, units: 0, revenue: 0,
    });
    const p = byProduct.get(key);
    p.lines += 1; p.units += r.qty || 0; p.revenue += r.total || 0;
  }
  const topProducts = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue);

  // Variant-group performance — for each parent group, total revenue +
  // breakdown by variant. Lets the user see at a glance "Walnuts: ¥X
  // total, Big size = 70%, Small = 30%".
  const groups = new Map();
  for (const p of topProducts) {
    if (!p.variant_group_id) continue;
    if (!groups.has(p.variant_group_id)) groups.set(p.variant_group_id, {
      group_id: p.variant_group_id, members: [], total: 0,
    });
    const g = groups.get(p.variant_group_id);
    g.members.push(p);
    g.total += p.revenue;
  }
  const variantGroups = [...groups.values()]
    .filter(g => g.members.length >= 2)
    .map(g => ({
      ...g,
      members: g.members
        .map(m => ({ ...m, share: g.total > 0 ? Math.round(m.revenue / g.total * 1000) / 10 : 0 }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.total - a.total);

  // Category rollup
  const byCategory = new Map();
  for (const p of topProducts) {
    const cat = p.category || '— Uncategorized 未分类 —';
    if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, revenue: 0, units: 0, products: 0 });
    const c = byCategory.get(cat);
    c.revenue += p.revenue; c.units += p.units; c.products += 1;
  }
  const categories = [...byCategory.values()].sort((a, b) => b.revenue - a.revenue);

  res.json({
    success: true,
    data: {
      window: { from: from || null, to: to || null },
      totals,
      periods: periodList,
      topProducts,
      variantGroups,
      categories,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MEITUAN ANALYTICS — per-location P&L. Aggregates the per-order rows
// from meituan_orders into a fee waterfall + daily trend + status mix.
// One channel ('meituan') across all stores; this endpoint splits by
// store_id so the frontend can compare locations side-by-side.
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/meituan/analytics', requireAuth, requirePermission('sales'), (req, res) => {
  const { from, to, store_id } = req.query;
  // Filters share the same shape as the other analytics endpoints —
  // optional date window + optional store filter.
  const where = ['1=1'];
  const params = [];
  if (from) { where.push("substr(o.ordered_at,1,10) >= ?"); params.push(from); }
  if (to)   { where.push("substr(o.ordered_at,1,10) <= ?"); params.push(to);   }
  if (store_id) { where.push('o.store_id = ?'); params.push(parseInt(store_id, 10)); }
  // Skip cancelled orders from totals (they still appear in the order
  // list but contribute zero to P&L).
  where.push("o.status != '订单取消'");
  const W = where.join(' AND ');

  const stores = db.prepare('SELECT id, source_store_id, name, nickname FROM meituan_stores ORDER BY id').all();

  // Aggregate fee waterfall + counts in one pass
  const totalsRow = db.prepare(`
    SELECT COUNT(*) AS orders,
           COALESCE(SUM(o.gross_amount), 0)         AS gross,
           COALESCE(SUM(o.product_total), 0)        AS product_total,
           COALESCE(SUM(o.package_fee), 0)          AS package_fee,
           COALESCE(SUM(o.merchant_subsidy), 0)     AS merchant_subsidy,
           COALESCE(SUM(o.delivery_fee_paid), 0)    AS delivery_fee_paid,
           COALESCE(SUM(o.delivery_tip_paid), 0)    AS delivery_tip_paid,
           COALESCE(SUM(o.ad_spend), 0)             AS ad_spend,
           COALESCE(SUM(o.coupon_subsidy_paid), 0)  AS coupon_subsidy_paid,
           COALESCE(SUM(o.insurance_fee), 0)        AS insurance_fee,
           COALESCE(SUM(o.commission), 0)           AS commission,
           COALESCE(SUM(o.partial_refund), 0)       AS partial_refund,
           COALESCE(SUM(o.net_to_merchant), 0)      AS net,
           COALESCE(SUM(o.item_count), 0)           AS items
      FROM meituan_orders o
     WHERE ${W}
  `).get(...params);
  // Commission is recorded as a NEGATIVE in `佣金(实付)` (already deducted
  // from 外卖订单 row's 商家应收款), so we abs-it to count as a positive
  // fee in the waterfall. Without this, the "Total Fees" KPI would be
  // ~10% understated.
  const commissionAbs = Math.abs(totalsRow.commission || 0);
  const totalFees = (totalsRow.delivery_fee_paid + totalsRow.delivery_tip_paid +
                     totalsRow.ad_spend + totalsRow.coupon_subsidy_paid +
                     totalsRow.insurance_fee + totalsRow.partial_refund +
                     commissionAbs);
  const totals = {
    ...totalsRow,
    total_fees: totalFees,
    aov: totalsRow.orders > 0 ? totalsRow.gross / totalsRow.orders : 0,
    take_rate: totalsRow.gross > 0 ? (totalsRow.net / totalsRow.gross * 100) : 0,
  };

  // Daily trend — exclude orders missing ordered_at (would group as a
  // NULL bucket and break the frontend chart).
  const daily = db.prepare(`
    SELECT substr(o.ordered_at, 1, 10) AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(o.gross_amount), 0)    AS gross,
           COALESCE(SUM(o.net_to_merchant), 0) AS net
      FROM meituan_orders o
     WHERE ${W} AND o.ordered_at IS NOT NULL AND o.ordered_at != ''
     GROUP BY day
     ORDER BY day
  `).all(...params);

  // Status + delivery-method mix
  const statusMix = db.prepare(`
    SELECT status, COUNT(*) AS n
      FROM meituan_orders o WHERE ${W} GROUP BY status ORDER BY n DESC
  `).all(...params);
  const deliveryMix = db.prepare(`
    SELECT delivery_method AS method, COUNT(*) AS n,
           COALESCE(SUM(o.gross_amount), 0) AS gross
      FROM meituan_orders o WHERE ${W} GROUP BY delivery_method ORDER BY n DESC
  `).all(...params);

  // Per-store breakdown (when not filtered to a single store, this is the
  // location-comparison table)
  const byStore = db.prepare(`
    SELECT s.id AS store_id, s.name, s.nickname,
           COUNT(*) AS orders,
           COALESCE(SUM(o.gross_amount), 0)         AS gross,
           COALESCE(SUM(o.net_to_merchant), 0)      AS net,
           COALESCE(SUM(o.delivery_fee_paid+o.delivery_tip_paid+o.ad_spend+o.coupon_subsidy_paid+o.insurance_fee+o.partial_refund), 0) AS fees
      FROM meituan_orders o
      JOIN meituan_stores s ON s.id = o.store_id
     WHERE ${W}
     GROUP BY s.id
     ORDER BY gross DESC
  `).all(...params);

  // Recent orders (top 50 by date, for the order list at the bottom of the tab)
  const recentOrders = db.prepare(`
    SELECT o.*, s.nickname AS store_nickname, s.name AS store_name
      FROM meituan_orders o
      JOIN meituan_stores s ON s.id = o.store_id
     WHERE ${W}
     ORDER BY o.ordered_at DESC
     LIMIT 100
  `).all(...params);

  res.json({
    success: true,
    data: { window: { from, to, store_id }, stores, totals, daily, statusMix, deliveryMix, byStore, recentOrders },
  });
});

module.exports = router;
