// Tablet/phone POS for the Markets sales channel.
// ─────────────────────────────────────────────────────────────────────────
// All routes write `channel = 'markets'` into sales_entries. The vendor's
// physical inventory is intentionally separate from the central
// products.stock_qty pool — markets sell from a stall replenished outside
// this system, so we record revenue without decrementing stock. (If that
// ever changes, the toggle is a single line in posCheckout.)
//
// Permissioning: admin or `pos` permission can transact. The by-barcode
// lookup in routes/products.js also accepts the `pos` perm.

const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, logActivity } = require('../middleware/auth');
const router = express.Router();

const POS_CHANNEL = 'markets';

// Helper — pos perm OR admin. Mirrors requirePermission pattern but inline
// so we can also let `products` permission transact (admins testing from
// their main account already have it).
function requirePos(req, res, next) {
  if (req.user?.role === 'admin') return next();
  if (req.permissions?.pos)       return next();
  return res.status(403).json({ error: 'forbidden — POS permission required · 无收银权限' });
}

// POST /api/pos/checkout — record a market sale.
// Body: { items: [{ product_id, name, qty, unit_price }], notes? }
// Returns: { success, transaction_id, total, count, ids: [...] }
//
// Atomic: all lines insert in a single transaction. Each line becomes one
// sales_entries row tagged with [markets:txn:N] in notes — a stable per-
// transaction grouping so we can later show "Transaction #N had 3 lines".
router.post('/api/pos/checkout', requireAuth, requirePos, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const userNotes = (req.body?.notes || '').toString().trim();
  if (!items.length) return res.status(400).json({ error: 'no items · 无商品' });

  // Validate up front — refuse the whole sale if any line is malformed,
  // rather than partial-writing then erroring (worst possible UX).
  const cleaned = [];
  for (const it of items) {
    const pid   = it.product_id ? parseInt(it.product_id, 10) : null;
    const name  = (it.name || '').toString().trim();
    const qty   = parseFloat(it.qty);
    const price = parseFloat(it.unit_price);
    if ((!pid && !name) || !(qty > 0) || !(price >= 0)) {
      return res.status(400).json({ error: 'invalid line · 行数据无效', line: it });
    }
    cleaned.push({ pid, name, qty, price });
  }

  // Transaction id = next-row id we'll insert. Read once before the tx so
  // every line in the batch shares the same group tag.
  const nextId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sales_entries').get().m || 0) + 1;
  // Tag carries (a) the txn id for grouping, (b) the market id (when the
  // user has one assigned) so analytics can roll up per-stall performance.
  // Format: [markets:txn:N]            — legacy / unassigned
  //          [markets:txn:N:M]          — assigned to market id M
  const u = db.prepare('SELECT market_id FROM users WHERE id = ?').get(req.user.id);
  const marketId = u?.market_id || null;
  const txnTag = marketId ? `[markets:txn:${nextId}:${marketId}]` : `[markets:txn:${nextId}]`;
  const date   = new Date().toISOString().slice(0, 10);
  const insert = db.prepare(`INSERT INTO sales_entries
    (date, product_id, product_name, channel, qty, unit_price, total, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const ids = [];
  let total = 0;
  try {
    const tx = db.transaction(() => {
      for (const c of cleaned) {
        const lineTotal = c.qty * c.price;
        total += lineTotal;
        // Snapshot the product name from the products table when we have an
        // id, so a later product rename doesn't retroactively change history.
        let nameSnap = c.name;
        if (c.pid) {
          const p = db.prepare('SELECT name_en FROM products WHERE id = ?').get(c.pid);
          if (p?.name_en) nameSnap = p.name_en;
        }
        const noteParts = [txnTag];
        if (userNotes) noteParts.push(userNotes);
        const r = insert.run(date, c.pid, nameSnap, POS_CHANNEL, c.qty, c.price, lineTotal,
                             noteParts.join(' '), req.user.id);
        ids.push(r.lastInsertRowid);
      }
    });
    tx();
  } catch (e) {
    console.error('[pos/checkout]', e);
    return res.status(500).json({ error: 'checkout failed: ' + (e.message || 'unknown') });
  }

  logActivity(req.user.id, req.user.username, 'pos_checkout', 'sale', nextId,
    { count: cleaned.length, total }, req.ip);
  res.json({
    success: true,
    transaction_id: nextId,
    txn_tag: txnTag,
    total,
    count: cleaned.length,
    ids,
  });
});

// GET /api/pos/today — list today's market transactions for this device.
// Groups sales_entries rows by their [markets:txn:N] tag so the UI can show
// each transaction as a single card with its line items collapsed inside.
router.get('/api/pos/today', requireAuth, requirePos, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT id, product_id, product_name, qty, unit_price, total, notes, created_at, created_by
      FROM sales_entries
     WHERE channel = ? AND date = ?
     ORDER BY id DESC
  `).all(POS_CHANNEL, today);

  // Group by txn tag — falls back to "ungrouped" for any legacy rows
  // missing the tag (e.g., if someone inserts via the generic Sales Entry).
  // Tag pattern matches both formats:
  //   [markets:txn:N]    (legacy / unassigned vendor)
  //   [markets:txn:N:M]  (vendor assigned to market id M)
  const groups = new Map();
  for (const r of rows) {
    const m = (r.notes || '').match(/\[markets:txn:(\d+)(?::(\d+))?\]/);
    const key = m ? m[1] : `loose-${r.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        txn_id: m ? parseInt(m[1], 10) : null,
        market_id: m && m[2] ? parseInt(m[2], 10) : null,
        lines: [], total: 0, created_at: r.created_at,
      });
    }
    const g = groups.get(key);
    g.lines.push(r);
    g.total += +r.total || 0;
    // Keep the earliest created_at as the txn time (rows insert in order, so
    // the last row pushed has the same or later time — safe to overwrite).
    if (r.created_at < g.created_at) g.created_at = r.created_at;
  }

  const transactions = [...groups.values()].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || ''));
  const dayTotal = transactions.reduce((s, t) => s + t.total, 0);
  const dayCount = transactions.length;

  // Daily target lookup — vendor's market sets the goal; the POS header
  // chip shows progress vs target. We base the chip on this user's
  // assigned market_id (set via /api/pos/my-market or by an admin) so
  // multiple vendors at one market all see the same number.
  let target = 0;
  let market_id = null;
  if (req.user.market_id) {
    const m = db.prepare('SELECT id, COALESCE(daily_target,0) AS daily_target FROM markets WHERE id = ?').get(req.user.market_id);
    if (m) { target = +m.daily_target || 0; market_id = m.id; }
  }
  const pct = target > 0 ? Math.round((dayTotal / target) * 100) : null;

  res.json({ success: true, data: { transactions, dayTotal, dayCount, target, market_id, pct } });
});

// POST /api/pos/void/:txn_id — soft-void a market transaction by deleting
// all of its sales_entries rows. Idempotent. We DELETE rather than mark a
// flag so analytics aggregations stay simple (no need to filter cancelled).
router.post('/api/pos/void/:txn_id', requireAuth, requirePos, (req, res) => {
  const txnId = parseInt(req.params.txn_id, 10);
  if (!txnId) return res.status(400).json({ error: 'invalid txn_id' });
  // Two patterns to delete: "[markets:txn:N]…" (legacy/no-market) and
  // "[markets:txn:N:M]…" (with market id). We match `txn:N]` and
  // `txn:N:` to cover both without false-matching txn:N1 etc.
  const r = db.prepare(`DELETE FROM sales_entries
                          WHERE channel = ?
                            AND (notes LIKE ? OR notes LIKE ?)`)
              .run(POS_CHANNEL, `[markets:txn:${txnId}]%`, `[markets:txn:${txnId}:%`);
  logActivity(req.user.id, req.user.username, 'pos_void', 'sale', txnId, { rows: r.changes }, req.ip);
  res.json({ success: true, deleted: r.changes });
});

// GET /api/markets/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates the Markets channel for the Sales > Markets tab.
// Open to anyone with `sales` permission (read-only — they're already
// allowed to see other channels' analytics).
router.get('/api/markets/analytics', requireAuth, requirePermission('sales'), (req, res) => {
  const from = (req.query.from || '').toString();
  const to   = (req.query.to   || '').toString();
  // Default window: last 30 days. The Sales-tab period bar drives the
  // explicit from/to so default is rarely used in practice.
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  const fromD = from || fmt(new Date(today.getTime() - 30*86400000));
  const toD   = to   || fmt(today);

  const where = `WHERE channel = 'markets' AND date >= ? AND date <= ?`;
  const args  = [fromD, toD];

  const totals = db.prepare(`SELECT
      COUNT(*) AS line_count,
      COALESCE(SUM(qty),0)   AS units,
      COALESCE(SUM(total),0) AS revenue,
      COUNT(DISTINCT product_id) AS distinct_products
    FROM sales_entries ${where}`).get(...args);

  // Distinct transactions in window — use the [markets:txn:N] tag in notes.
  // Falling back to COUNT DISTINCT date+created_at for any loose rows.
  const txnRow = db.prepare(`SELECT COUNT(DISTINCT
        CASE WHEN notes LIKE '[markets:txn:%' THEN notes ELSE id END
      ) AS txns FROM sales_entries ${where}`).get(...args);
  totals.txns = txnRow.txns | 0;

  const byDay = db.prepare(`SELECT date AS day,
      COUNT(*) AS lines,
      COALESCE(SUM(qty),0)   AS units,
      COALESCE(SUM(total),0) AS revenue
    FROM sales_entries ${where}
    GROUP BY date ORDER BY date`).all(...args);

  const topProducts = db.prepare(`SELECT
      COALESCE(product_id, -1) AS product_id,
      COALESCE(product_name, '(unknown)') AS name,
      SUM(qty) AS units, SUM(total) AS revenue, COUNT(*) AS lines
    FROM sales_entries ${where}
    GROUP BY product_id, product_name
    ORDER BY revenue DESC
    LIMIT 25`).all(...args);

  // Recent transactions, grouped by txn tag, newest first.
  // Also extract market_id from the tag so the UI can color/filter per stall.
  const rawRecent = db.prepare(`SELECT id, product_id, product_name, qty, unit_price, total,
      notes, date, created_at, created_by
    FROM sales_entries ${where}
    ORDER BY id DESC LIMIT 500`).all(...args);
  const groups = new Map();
  for (const r of rawRecent) {
    const m = (r.notes || '').match(/\[markets:txn:(\d+)(?::(\d+))?\]/);
    const key = m ? m[1] : `loose-${r.id}`;
    if (!groups.has(key)) groups.set(key, {
      txn_id: m ? +m[1] : null,
      market_id: m && m[2] ? +m[2] : null,
      lines: [], total: 0, date: r.date, created_at: r.created_at,
    });
    const g = groups.get(key);
    g.lines.push(r);
    g.total += +r.total || 0;
  }
  const allTxns = [...groups.values()]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const recent = allTxns.slice(0, 60);

  // ── Per-market rollup ──
  // Walks every transaction in the window and sums revenue/units/txn-count
  // by market_id. Joins against the markets table for display names.
  // Transactions without a market tag (legacy/unassigned) bucket to
  // market_id=null with display name "Unassigned · 未分配".
  const allMarkets = db.prepare('SELECT id, name, name_cn FROM markets').all();
  const marketsById = new Map(allMarkets.map(m => [m.id, m]));
  const byMarketAcc = new Map();   // market_id (or 'null') → row
  for (const t of allTxns) {
    const k = t.market_id == null ? 'null' : t.market_id;
    if (!byMarketAcc.has(k)) {
      const m = t.market_id ? marketsById.get(t.market_id) : null;
      byMarketAcc.set(k, {
        market_id: t.market_id,
        name: m ? m.name : '(unassigned)',
        name_cn: m ? (m.name_cn || '') : '未分配',
        revenue: 0, units: 0, txns: 0, lines: 0,
      });
    }
    const a = byMarketAcc.get(k);
    a.txns += 1;
    a.lines += t.lines.length;
    for (const l of t.lines) {
      a.units   += +l.qty   || 0;
      a.revenue += +l.total || 0;
    }
  }
  const byMarket = [...byMarketAcc.values()].sort((x, y) => y.revenue - x.revenue);

  res.json({ success: true, data: {
    window: { from: fromD, to: toD },
    totals, byDay, topProducts, recent, byMarket,
  }});
});

// GET /api/pos/top-products
// "What should I show the seller when they tap search with no query?"
// Top sellers are aggregated across ALL markets (vendors should see what
// the company is selling well anywhere, not just their own stall — useful
// for noticing winners spreading from another location). Cascades through:
//   1. Most-sold across all markets in last N days  (`source: 'all_markets'`)
//   2. Most-sold across any channel ever            (`source: 'all_channels'`)
//   3. Alphabetical active product list             (`source: 'catalog'`)
// Each fallback only kicks in if the previous returned 0 rows. New stores
// with zero data still see a useful starter list.
router.get('/api/pos/top-products', requireAuth, requirePos, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
  const days  = Math.min(parseInt(req.query.days  || '60', 10) || 60, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const u = db.prepare('SELECT market_id FROM users WHERE id = ?').get(req.user.id);
  const marketId = u?.market_id || null;

  const baseSelect = `SELECT
      se.product_id,
      SUM(se.qty)   AS units,
      SUM(se.total) AS revenue,
      COUNT(DISTINCT se.id) AS lines,
      p.name_en, p.name_cn, p.sku, p.barcode, p.sell_price, p.stock_qty,
      p.status, p.variant_label, p.image_data
    FROM sales_entries se
    LEFT JOIN products p ON p.id = se.product_id`;

  function clean(rows) {
    // Drop hard-deleted (LEFT JOIN returns null name_en) and inactive products.
    return rows.filter(r => r.name_en && r.status !== 'Inactive');
  }

  // 1) All markets aggregate (last N days). Where-clause columns are
  // prefixed `se.` because both sales_entries and products have `notes`
  // and `date` columns — bare names would be ambiguous against the JOIN.
  let source = 'all_markets';
  let rows = clean(db.prepare(`${baseSelect}
    WHERE se.channel = 'markets' AND se.date >= ? AND se.product_id IS NOT NULL
    GROUP BY se.product_id ORDER BY units DESC LIMIT ?`)
    .all(since, limit));

  // 2) Any channel, any time — best general signal when no market sales.
  if (rows.length === 0) {
    source = 'all_channels';
    rows = clean(db.prepare(`${baseSelect}
      WHERE se.product_id IS NOT NULL
      GROUP BY se.product_id ORDER BY units DESC LIMIT ?`)
      .all(limit));
  }

  // 4) Brand-new system with zero sales — show the catalog so the vendor
  // can still pick something. Synthesise the same row shape so the
  // frontend doesn't need to special-case this path.
  if (rows.length === 0) {
    source = 'catalog';
    rows = db.prepare(`SELECT
        id AS product_id, 0 AS units, 0 AS revenue, 0 AS lines,
        name_en, name_cn, sku, barcode, sell_price, stock_qty,
        status, variant_label, image_data
      FROM products
      WHERE COALESCE(is_active, 1) = 1 AND status = 'Active'
      ORDER BY name_en
      LIMIT ?`).all(limit);
  }

  res.json({ success: true, market_id: marketId, since, source, data: rows });
});

module.exports = router;
