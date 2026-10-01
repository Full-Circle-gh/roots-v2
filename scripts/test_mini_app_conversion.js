#!/usr/bin/env node
'use strict';

/**
 * Conversion divides one channel by itself — the mini app.
 *
 *   node scripts/test_mini_app_conversion.js
 *
 * THE FAULT, reported off a live phone on 2026-09-11: Home's second card read
 * "Sessions 25 · Conversion 68.0% · 17 orders ÷ 25 sessions". The 25 were
 * mini-app opens. The 17 were the mini app, Meituan and the counter till added
 * together. `retail_visits` has exactly one writer — miniapp/utils/track.js via
 * POST /api/retail/track — so a session is a mini-app session and can be
 * nothing else; Meituan, Eleme and gzgrocery hand over finished orders and will
 * never say how many people looked. The rate was therefore a ratio between two
 * populations, and it errs one way only: every marketplace order the shop wins
 * pushes a number that is supposed to describe browsing we can watch.
 *
 * WHY THIS SUITE EXISTS RATHER THAN A CARD-LEVEL CHECK. The fix is a predicate
 * inside one SQL route, and a predicate is exactly the thing a later edit
 * widens by accident — adding a channel to an IN list, dropping the counter
 * exclusion, or "tidying" COALESCE(NULLIF(channel,''),'wechat') into
 * channel='wechat' and silently losing every mini-app order that predates the
 * column default. So the predicate is LIFTED FROM routes/retail.js BY REGEX and
 * run against a throwaway in-memory database seeded with one order per channel.
 * Rewrite the route's predicate and this file fails; copy a stale one in here
 * and the lift stops matching, which fails too.
 *
 * Touches nothing real: :memory: only, safe on the production box.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESKTOP = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || 'value'}: expected ${expected}, got ${actual}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }

// ── The predicate, lifted from the route ───────────────────────────────────
section('the mini-app predicate is the route\'s own, not a copy');

const MINI = (/const MINI\s*=\s*`([^`]+)`/.exec(RETAIL) || [])[1];
const MINIO = (/const MINIO\s*=\s*`([^`]+)`/.exec(RETAIL) || [])[1];

check('routes/retail.js still declares MINI and MINIO', () => {
  ok(MINI, 'no `const MINI = `…`` in the dashboard route');
  ok(MINIO, 'no `const MINIO = `…`` in the dashboard route');
});

check('MINIO is MINI with the orders table aliased — one rule, two spellings', () => {
  eq(MINIO, MINI.replace(/\bchannel\b/g, 'o.channel').replace(/\bfulfillment_type\b/g, 'o.fulfillment_type'),
    'aliased predicate');
});

/* The default matters more than it looks. A mini-app order carries no explicit
   channel on older rows — NULL or '' — and the live convention everywhere else
   (order-channel-counts, /sales/summary) reads that as 'wechat'. A predicate
   written channel='wechat' would drop those rows, and the loss would look like
   a quiet decline in conversion rather than a bug. */
check('it reads a missing channel as the mini app, the way every other channel query does', () => {
  ok(/COALESCE\(NULLIF\(channel,''\),'wechat'\)\s*=\s*'wechat'/.test(MINI),
    `MINI does not carry the NULL/'' default: ${MINI}`);
});

check('and it keeps counter sales out — a till sale can carry a storefront channel', () => {
  ok(/fulfillment_type,''\)\s*<>\s*'counter'/.test(MINI), `MINI does not exclude counter fulfilment: ${MINI}`);
});

// ── The predicate against real rows ────────────────────────────────────────
section('one order per channel, and only one of them is the mini app\'s');

function seeded() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY,
      status TEXT,
      channel TEXT,
      fulfillment_type TEXT DEFAULT 'delivery',
      customer_id INTEGER,
      total REAL,
      replacement_for_order_id INTEGER,
      paid_at DATETIME,
      placed_at DATETIME
    );`);
  const ins = db.prepare(`INSERT INTO retail_orders
    (id, status, channel, fulfillment_type, customer_id, total, replacement_for_order_id, paid_at, placed_at)
    VALUES (@id, @status, @channel, @ft, @cust, @total, NULL, @at, @at)`);
  const at = '2026-09-11 03:00:00';   // 11:00 GZ
  const row = (id, channel, cust, ft) => ins.run({
    id, status: 'paid', channel, ft: ft || 'delivery', cust, total: 100, at,
  });
  row(1, 'wechat', 10);      // the mini app, tagged
  row(2, null, 11);          // the mini app, untagged (pre-default row)
  row(3, '', 12);            // the mini app, empty string
  row(4, 'meituan', 13);     // marketplace — no sessions behind it
  row(5, 'eleme', 14);       // marketplace
  row(6, 'gzgrocery', 15);   // wholesale pickup mirror
  row(7, 'web', 16);         // web shop — never calls /track either
  row(8, 'manual', 17);      // staff-keyed
  row(9, 'wechat', 18, 'counter');   // till sale wearing a storefront channel
  return db;
}

const PAID = require(path.join(ROOT, 'lib', 'finance-window.js')).PAID;
const countMini = (db) => db.prepare(
  `SELECT COUNT(*) AS n, COUNT(DISTINCT customer_id) AS buyers
     FROM retail_orders WHERE ${PAID} AND ${MINI}`).get();

check('three mini-app orders out of nine — tagged, untagged and empty-string', () => {
  eq(countMini(seeded()).n, 3, 'mini-app orders');
});

check('and three distinct buyers with them', () => {
  eq(countMini(seeded()).buyers, 3, 'mini-app buyers');
});

check('Meituan, Eleme and gzgrocery are out — none of them can report a session', () => {
  const db = seeded();
  for (const ch of ['meituan', 'eleme', 'gzgrocery']) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE ${MINI} AND channel = ?`).get(ch).n;
    eq(n, 0, `${ch} rows admitted by MINI`);
  }
});

check('the web shop is out too — it has never called /track', () => {
  const db = seeded();
  eq(db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE ${MINI} AND channel='web'`).get().n, 0, 'web rows');
});

check('a counter sale tagged wechat is out — the till is not the mini app', () => {
  const db = seeded();
  eq(db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE ${MINI} AND fulfillment_type='counter'`).get().n,
    0, 'counter rows');
});

/* The whole point, stated as arithmetic: on this day the all-channel count is
   the number that used to sit over `sessions`, and it is nearly three times the
   honest one. A conversion built from it cannot be a little wrong. */
check('the all-channel count really is the bigger number — the error only ever inflates', () => {
  const db = seeded();
  const all = db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE ${PAID}`).get().n;
  eq(all, 9, 'all-channel orders');
  ok(all > countMini(db).n, 'all-channel count is not larger than the mini app\'s — fixture is wrong');
});

// ── The route divides the right two numbers ────────────────────────────────
section('conversion_rate takes its numerator from the mini app');

check('it divides miniOrders by sessions, never kpi.orders', () => {
  // §325: `!SCOPED &&` — a store's answer has no conversion, because its
  // orders over the shop's sessions would divide two populations.
  const line = /const conversion = (?:!SCOPED && )?vis\.sessions > 0 \? \(([^)]*)\) \* 100 : null;/.exec(RETAIL);
  ok(line, 'the conversion line has moved or changed shape');
  eq(line[1].replace(/\s+/g, ''), 'miniOrders/vis.sessions', 'conversion numerator ÷ denominator');
});

check('miniOrders comes from a query carrying MINI', () => {
  const q = /const miniKpi = tdb\(\)\.prepare\(`([\s\S]*?)`\)/.exec(RETAIL);
  ok(q, 'miniKpi query not found');
  ok(q[1].includes('${MINI}'), 'miniKpi does not scope by MINI');
  ok(q[1].includes('${PAID_ALL}'), 'miniKpi does not use the shared paid predicate');
});

check('the payload carries the mini_app block the phone reads', () => {
  const block = /mini_app: \{([\s\S]*?)\n      \},/.exec(RETAIL);
  ok(block, 'no mini_app block in the dashboard payload');
  for (const key of ['sessions', 'orders', 'conversion_rate', 'buyers',
    'returning_buyers', 'refunded_orders', 'refund_rate']) {
    ok(new RegExp(`\\b${key}:`).test(block[1]), `mini_app block is missing ${key}`);
  }
});

check('and mini_app_orders rides in kpis so a subtitle can name the numerator', () => {
  ok(/mini_app_orders: miniOrders,/.test(RETAIL), 'kpis.mini_app_orders not exposed');
});

/* The refund figure keeps the funnel's date convention rather than inventing
   its own — two refund counts measured over different days would be worse than
   one narrow one. */
check('the mini-app refund count is measured over placed_at, like the all-channel one', () => {
  const q = /const miniRefunded = tdb\(\)\.prepare\(`([\s\S]*?)`\)/.exec(RETAIL);
  ok(q, 'miniRefunded query not found');
  ok(q[1].includes("status = 'refunded'"), 'miniRefunded does not filter on the refunded status');
  ok(q[1].includes('date(placed_at'), 'miniRefunded does not use the funnel\'s placed_at convention');
  ok(q[1].includes('${MINI}'), 'miniRefunded does not scope by MINI');
});

// ── The two screens that read it ───────────────────────────────────────────
section('the card reads the block, and says whose numbers it is showing');

check('Home builds its second card from d.mini_app and nothing else', () => {
  const fn = /const ma=d\.mini_app\|\|\{\};\s*state\.liveVitals=\{([\s\S]*?)\};/.exec(PHONE);
  ok(fn, 'liveVitals is no longer assembled from d.mini_app');
  const body = fn[1];
  ok(!/\bk\./.test(body), `an all-channel kpi leaked back into the card: ${body.trim()}`);
  ok(!/new_vs_returning/.test(body), 'the card is back on the all-channel new_vs_returning');
  for (const key of ['refunded_orders', 'refund_rate', 'sessions', 'orders',
    'conversion_rate', 'buyers', 'returning_buyers']) {
    ok(body.includes(`ma.${key}`), `the card does not read ma.${key}`);
  }
});

check('and the card names its channel over itself', () => {
  const fn = /function vitalsBlock\(\)\{[\s\S]*?\n\}/.exec(PHONE);
  ok(fn, 'vitalsBlock not found');
  ok(/T\('Mini app','小程序'\)/.test(fn[0]),
    'the card no longer carries the "Mini app · 小程序" heading — an unlabelled card under "Today" claims the whole day');
});

/* The heading is a label for the contents, not a second "Today". todaySection
   still owns the section heading and still draws exactly one — the line
   test_backend_nav_parity §4 holds after "Also today" was retired. */
check('the section heading is still drawn once, by todaySection', () => {
  const fn = /function todaySection\(kpis\)\{[\s\S]*?\n\}/.exec(PHONE);
  ok(fn, 'todaySection not found');
  ok(/T\('Today','今日'\)/.test(fn[0]), 'todaySection no longer draws the Today heading');
  ok(!/T\('Today','今日'\)/.test(/function vitalsBlock\(\)\{[\s\S]*?\n\}/.exec(PHONE)[0]),
    'the second card has grown a Today heading of its own');
});

check('the desktop quotes mini-app orders wherever it quotes the rate', () => {
  ok(/mini_app_orders/.test(DESKTOP), 'the desktop never reads mini_app_orders');
  // The Customers-card sub-line, both sides of the small-denominator threshold.
  const paint = /function tdSecPaint\(\)\{?[\s\S]*?\n\}/.exec(DESKTOP) || [DESKTOP];
  ok(!/\$\{Number\(k\.orders \|\| 0\)\.toLocaleString\(\)\} orders ÷/.test(DESKTOP),
    'the conversion sub-line still names the all-channel order count');
  ok(/mini-app orders ÷/.test(paint[0]), 'the conversion sub-line does not say the orders are the mini app\'s');
});

check('and the browse→buy funnel narrows within one channel', () => {
  ok(/Visited the mini app/.test(DESKTOP),
    'the money-path funnel still says "Visited the store" over a session count only the mini app produces');
  ok(/dashNum\(miniOrders\), convPct == null/.test(DESKTOP),
    'the funnel\'s order row is not the mini app\'s count');
});

// ── Result ────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`ok — ${passed} assertions, mini-app conversion.`);
