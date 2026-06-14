/* eslint-disable no-console */
/**
 * Funnel report — where does the 326 → 11 drop-off happen?
 * ----------------------------------------------------------------------------
 * Reconstructs the storefront funnel from the same three tables the dashboard
 * reads, so the top line matches the Mini App Backend → Dashboard exactly:
 *
 *     visitors  → retail_visits   (distinct customer_id|openid|session_id)
 *     signed in → retail_customers (rows created in the window = "new customers")
 *     checkout  → retail_checkout_quotes (reached the pricing step)
 *     paid      → retail_orders   (PAID statuses)
 *
 * NOTE on a real limitation: utils/track.js fires track() only ONCE per app
 * launch (app.js logs options.path), so retail_visits records how people ENTER
 * (entry page + WeChat scene), not every page they browse. We therefore can't
 * measure "viewed a product page" mid-session — only entry path. The entry-page
 * and scene breakdowns below are the closest honest signal for the top of the
 * funnel; the bottom (checkout → paid) is exact.
 *
 * Run ON THE SERVER, read-only against data/roots.db:
 *     node scripts/funnel_report.js                 # today (Asia/Shanghai)
 *     node scripts/funnel_report.js 2026-06-14      # one day
 *     node scripts/funnel_report.js 2026-06-01 2026-06-14   # a range
 *     node scripts/funnel_report.js all             # all history
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

// ── Dashboard constants (kept identical to routes/retail.js) ──
const TZ    = '+8 hours';
const PAID  = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";
const PAIDO = "o.status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";
const PDATE = `date(COALESCE(paid_at, placed_at), '${TZ}')`;

// ── Resolve the window from argv ──
function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
let from, to, label;
const a = process.argv.slice(2);
if (a[0] === 'all') {
  from = '2000-01-01'; to = '2999-12-31'; label = 'ALL HISTORY';
} else if (a.length === 0) {
  from = to = shanghaiToday(); label = `TODAY (${from}, Asia/Shanghai)`;
} else {
  from = a[0]; to = a[1] || a[0]; label = `${from} → ${to}`;
}

const one  = (sql, ...p) => db.prepare(sql).get(...p);
const many = (sql, ...p) => db.prepare(sql).all(...p);
const has  = (t) => !!one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t);
const pct  = (n, d) => (d > 0 ? `${(n / d * 100).toFixed(1)}%` : '—');
const bar  = (n, d) => { const w = d > 0 ? Math.round(n / d * 28) : 0; return '█'.repeat(w) + '░'.repeat(28 - w); };

console.log('\n════════════════════════════════════════════════════════════════');
console.log(`  STOREFRONT FUNNEL · ${label}`);
console.log(`  db: ${DB_PATH}`);
console.log('════════════════════════════════════════════════════════════════\n');

// ── Stage 1: traffic ──
const vis = one(`
  SELECT COUNT(*) AS visits,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(DISTINCT COALESCE(CAST(customer_id AS TEXT), openid, session_id)) AS visitors,
         COUNT(DISTINCT CASE WHEN customer_id IS NOT NULL THEN customer_id END) AS known_visitors
    FROM retail_visits
   WHERE date(created_at, '${TZ}') BETWEEN ? AND ?`, from, to);

// ── Stage 2: new customers (rows created in window) ──
const newCust = one(
  `SELECT COUNT(*) AS n FROM retail_customers WHERE date(created_at, '${TZ}') BETWEEN ? AND ?`,
  from, to).n;

// ── Stage 3: reached checkout ──
let started = 0;
if (has('retail_checkout_quotes')) {
  started = one(`
    SELECT COUNT(DISTINCT customer_id) AS n
      FROM retail_checkout_quotes
     WHERE customer_id IS NOT NULL AND date(created_at, '${TZ}') BETWEEN ? AND ?`,
    from, to).n;
}

// ── Stage 4: paid ──
const ord = one(`
  SELECT COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS buyers,
         COALESCE(SUM(total), 0) AS revenue
    FROM retail_orders
   WHERE ${PAID} AND ${PDATE} BETWEEN ? AND ?`, from, to);

// ── The funnel, each row a % of the stage above ──
const V = vis.visitors;
const rows = [
  ['Unique visitors (opened app)', V,               V],
  ['  ↳ signed-in visitors',       vis.known_visitors, V],
  ['New customers (first sign-in)', newCust,         V],
  ['Reached checkout',             started,          V],
  ['Paid orders',                  ord.orders,       V],
];
console.log('  FUNNEL (each bar = share of unique visitors)\n');
let prev = null;
for (const [name, n, denom] of rows) {
  const stepNote = prev != null && prev > 0 ? `   (${pct(n, prev)} of prev step)` : '';
  console.log(`  ${name.padEnd(32)} ${String(n).padStart(5)}  ${bar(n, denom)} ${pct(n, denom).padStart(6)}${stepNote}`);
  if (!name.startsWith('  ↳')) prev = n; // ↳ is a sub-line, don't use as step base
}
console.log(`\n  Sessions: ${vis.sessions}   Raw visits: ${vis.visits}   Revenue: ¥${Number(ord.revenue).toFixed(2)}`);
console.log(`  Visitor→order conversion: ${pct(ord.orders, V)}   Session→order: ${pct(ord.orders, vis.sessions)}`);
if (started > 0) console.log(`  Checkout→paid: ${pct(ord.buyers, started)}  (abandoned ${Math.max(0, started - ord.buyers)} of ${started})`);

// ── How visitors ENTERED: top entry paths ──
const pages = many(`
  SELECT COALESCE(NULLIF(page,''),'(none)') AS page,
         COUNT(DISTINCT COALESCE(CAST(customer_id AS TEXT), openid, session_id)) AS visitors,
         COUNT(*) AS hits
    FROM retail_visits
   WHERE date(created_at, '${TZ}') BETWEEN ? AND ?
   GROUP BY page ORDER BY visitors DESC LIMIT 12`, from, to);
if (pages.length) {
  console.log('\n  ── ENTRY PAGE (where the app opened to) ──');
  for (const p of pages) console.log(`     ${String(p.visitors).padStart(4)} visitors  ${p.page}`);
}

// ── WeChat launch-scene breakdown ──
const scenes = many(`
  SELECT scene, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS visits
    FROM retail_visits
   WHERE date(created_at, '${TZ}') BETWEEN ? AND ? AND scene IS NOT NULL
   GROUP BY scene ORDER BY sessions DESC LIMIT 12`, from, to);
if (scenes.length) {
  console.log('\n  ── HOW THEY ARRIVED (WeChat scene code) ──');
  for (const s of scenes) console.log(`     ${String(s.sessions).padStart(4)} sessions  scene ${s.scene}`);
}

// ── Abandoned checkouts: products left behind ──
if (has('retail_checkout_quotes') && started > 0) {
  const prods = many(`
    SELECT CAST(json_extract(j.value,'$.product_id') AS INTEGER) AS pid,
           COUNT(DISTINCT q.customer_id) AS customers
      FROM retail_checkout_quotes q, json_each(q.items_json) j
     WHERE q.customer_id IS NOT NULL
       AND date(q.created_at,'${TZ}') BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM retail_orders o
                        WHERE o.customer_id=q.customer_id AND ${PAIDO}
                          AND date(o.placed_at,'${TZ}') BETWEEN ? AND ?)
     GROUP BY pid ORDER BY customers DESC LIMIT 10`, from, to, from, to);
  if (prods.length) {
    console.log('\n  ── LEFT IN ABANDONED CARTS (top products) ──');
    for (const p of prods) {
      if (!p.pid) continue;
      const m = one('SELECT name_en, name_cn FROM store_products WHERE id=?', p.pid) || {};
      console.log(`     ${String(p.customers).padStart(3)} walked away  ${m.name_en || m.name_cn || ('#' + p.pid)}`);
    }
  }
}

console.log('\n════════════════════════════════════════════════════════════════\n');
db.close();
