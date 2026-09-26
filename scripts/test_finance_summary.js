#!/usr/bin/env node
/**
 * Offline self-test for the Finance Summary staircase.
 *
 *   node scripts/test_finance_summary.js
 *
 * Two halves, no network and no browser:
 *
 *   1 · THE QUERY (routes/finance-summary.js) — its two predicates and its
 *       three sums are sliced out of the shipped file and run against a
 *       throwaway in-memory SQLite database seeded with the exact cases §36
 *       rules on: a gzgrocery order, a wallet top-up, an unpaid order, an order
 *       on the timezone boundary, and an expense either side of the window.
 *
 *   2 · THE SCREEN (public/retail-admin/22-finance.js) — the render functions
 *       are evaluated against stubs, the same technique as
 *       scripts/test_phone_dashboard.js.
 *
 * What is asserted is what §36 decides and what a later edit could quietly
 * undo — not the layout, which reference/finance-summary-mockup.html owns.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'finance-summary.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '22-finance.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const VOCAB = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
// The orders list owns the staff-keyed origin names; Finance copies them.
const ORDERS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
// The channel filter over retail_orders.channel — where `manual` is named.
const CUSTOMERS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '08-customers.js'), 'utf8');
// The predicates moved to lib/finance-window.js so the Summary and Transactions
// routes share ONE copy — §36's "must not be inherited by copying whichever
// site is nearest" applied across the Finance module rather than within a file.
const WINDOW_LIB = fs.readFileSync(path.join(ROOT, 'lib', 'finance-window.js'), 'utf8');

/* Strip // and /* *\/ comments so a "must not read X" assertion tests the CODE
   and not the prose explaining why X is not read. Both of these files document
   at length what they deliberately do NOT touch, and every one of those
   sentences names the thing — so a naive grep over the raw source fails on the
   comment that exists to promise the opposite. String literals are left intact:
   the assertions below need them. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = codeOnly(ROUTE);
const CLIENT_CODE = codeOnly(CLIENT);

/** Pull a single-quoted or backticked const out of the shipped route. */
function constOf(name) {
  const m = WINDOW_LIB.match(new RegExp(`const ${name} = ([\`'"])([\\s\\S]*?)\\1;`));
  assert.ok(m, `not found in the shipped route: ${name}`);
  return m[2];
}

// ── The predicates, read from the shipped file rather than restated ────────
// PAID COMES FROM THE MODULE, NOT FROM A REGEX OVER ITS SOURCE, for exactly the
// reason recorded below for ODATE. It used to be scraped as `const PAID = '…';`
// — which broke on 2026-09-11 when the eleven hand-written copies in
// routes/retail.js were consolidated and PAID became `paidWhere()`, generated
// from the status list rather than typed. Requiring it tests the value that
// actually ships instead of a copy of its spelling, and the generated string is
// pinned byte-for-byte against the pre-consolidation literal in
// scripts/test_paid_predicate.js.
const { PAID } = require(path.join(ROOT, 'lib', 'finance-window.js'));
const TZ = constOf('TZ');
const EDATE = constOf('LEDGER_DATE');
// ODATE comes from the MODULE, not from a regex over its source. It used to be
// scraped as `const ODATE = \`…\`;` with ${TZ} substituted by hand — which broke
// the day audit A-05 made the order date take the shop's own clock and ODATE
// became `odateFor(TZ)`. The module is pure and has no database, so requiring it
// tests the value that actually ships instead of a copy of its spelling.
const { ODATE, odateFor } = require(path.join(ROOT, 'lib', 'finance-window.js'));

console.log('\n1 · the predicates — declared once, and the right ones');

it('the status filter is the ALLOW-list, not a deny-list', () => {
  assert.ok(/status IN \(/.test(PAID), 'must be an allow-list');
  assert.ok(!/NOT IN/.test(PAID), 'a deny-list admits any status added later');
  ['paid', 'preparing', 'dispatched', 'delivered', 'awaiting_restock']
    .forEach(s => assert.ok(PAID.includes(`'${s}'`), `missing status: ${s}`));
});

it('the order date is COALESCE(paid_at, placed_at) shifted +8h', () => {
  assert.strictEqual(TZ, '+8 hours');
  assert.ok(/date\(COALESCE\(paid_at, placed_at\), '\+8 hours'\)/.test(ODATE), ODATE);
});

it('the order date takes the SHOP\'s clock when one is given (audit A-05)', () => {
  // Every merchant outside UTC+8 had their day end at midnight in Guangzhou.
  // odateFor() is how a caller hands in its own boundary; minutes, not hours,
  // because +5:45 and +9:30 are real places.
  assert.strictEqual(odateFor('+345 minutes'),
    "date(COALESCE(paid_at, placed_at), '+345 minutes')");
  assert.strictEqual(odateFor('-300 minutes'),
    "date(COALESCE(paid_at, placed_at), '-300 minutes')");
  // And with nothing given it is the documented fallback, unchanged.
  assert.strictEqual(odateFor(), ODATE);
  assert.strictEqual(odateFor(null), ODATE);
});

it('the summary asks for the shop\'s shift rather than pasting one', () => {
  assert.match(ROUTE_CODE, /odateFor\(sqlDayShiftForShop\(tdb\(\)\)\)/,
    'the live query must resolve the account’s own boundary');
  assert.ok(!/\+8 hours/.test(ROUTE_CODE), 'no hand-written offset may remain in the route');
});

it('the expense date takes NO shift — it is already a business day', () => {
  assert.strictEqual(EDATE, 'date', 'shifting expense_entries.date moves every expense a day');
});

it('each predicate is declared exactly once and referenced thereafter', () => {
  // §36: "an allow-list is declared once and re-declared inline four more
  // times". The whole point of this module is not to do that again.
  // CODE only. Both files document at length what the predicates are, and a
  // comment naming one is documentation rather than a second declaration —
  // counting raw source would fail on the prose that exists to explain the rule.
  const src = codeOnly(ROUTE) + codeOnly(WINDOW_LIB);
  // ZERO, not one, since 2026-09-11. The allow-list is no longer SPELLED at all
  // — `paidWhere()` renders it from `PAID_STATUSES`, so the statuses are named
  // in exactly one array and the SQL exists only as generated output. That is
  // the same rule this assertion has always enforced, one level further in:
  // there is now no literal to re-declare. The generated string is pinned
  // byte-for-byte against the pre-consolidation characters in
  // scripts/test_paid_predicate.js, which also guards routes/ and lib/ against
  // a hand-written copy coming back.
  const inline = src.match(/status IN \('paid'/g) || [];
  assert.strictEqual(inline.length, 0, `the allow-list is spelled out ${inline.length} times`);
  const lists = codeOnly(WINDOW_LIB).match(/'paid',\s*'preparing'/g) || [];
  assert.strictEqual(lists.length, 1, `the status list is declared ${lists.length} times`);
  const dates = src.match(/date\(COALESCE\(paid_at, placed_at\)/g) || [];
  assert.strictEqual(dates.length, 1, `the date expression is spelled out ${dates.length} times`);
});

// ── The sums, against a real database ──────────────────────────────────────
console.log('\n2 · the sums — §36’s rulings, on rows that exercise them');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    paid_at DATETIME, placed_at DATETIME,
    -- §98 stage three. Every row below leaves it NULL, which is what every
    -- order in production has, so the sums this file asserts are unchanged —
    -- the column is here because PAID now reads it, and a fixture missing it
    -- would fail on the schema rather than on the arithmetic it exists to test.
    replacement_for_order_id INTEGER);
  CREATE TABLE retail_topup_transactions (
    id INTEGER PRIMARY KEY, amount REAL, status TEXT, payment_method TEXT, paid_at DATETIME);
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT);
`);

const FROM = '2026-08-01', TO = '2026-08-31';
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (1,'paid','wechat',1000,'2026-08-10 03:00:00',NULL)").run();
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (2,'delivered','gzgrocery',500,'2026-08-11 03:00:00',NULL)").run();
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (3,'pending_payment','wechat',999,NULL,'2026-08-12 03:00:00')").run();
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (4,'refunded','wechat',777,'2026-08-13 03:00:00',NULL)").run();
// Placed 31 July 22:00 Guangzhou = 31 Jul 14:00 UTC, paid 1 August GZ. §36's
// worked example: it belongs to August, and only the +8h COALESCE puts it there.
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (5,'paid','wechat',100,'2026-08-01 00:30:00','2026-07-31 14:00:00')").run();
// Never paid, so it falls back to placed_at — and is out of the window.
db.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (6,'preparing','web',60,NULL,'2026-07-20 03:00:00')").run();
// Real top-up cash, settled inside the window. Revenue must not see it.
db.prepare("INSERT INTO retail_topup_transactions VALUES (1,3000,'success','wechat','2026-08-15 03:00:00')").run();
db.prepare("INSERT INTO expense_entries VALUES (1,'2026-08-05',800,'Rent')").run();
db.prepare("INSERT INTO expense_entries VALUES (2,'2026-08-06',200,'Wages')").run();
db.prepare("INSERT INTO expense_entries VALUES (3,'2026-08-07',50,NULL)").run();
db.prepare("INSERT INTO expense_entries VALUES (4,'2026-07-31',9999,'Rent')").run();

const revenue = db.prepare(
  `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders FROM retail_orders
    WHERE ${PAID} AND ${ODATE} BETWEEN ? AND ?`).get(FROM, TO);
const expenses = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS total FROM expense_entries
    WHERE ${EDATE} BETWEEN ? AND ?`).get(FROM, TO);
const breakdown = db.prepare(
  `SELECT category, COALESCE(SUM(amount),0) AS amount FROM expense_entries
    WHERE ${EDATE} BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`).all(FROM, TO);

it('gzgrocery COUNTS — the dashboard exclusion is not inherited', () => {
  // §36 v4.115. 1000 + 500 + 100 = 1600.
  assert.strictEqual(revenue.revenue, 1600, 'gzgrocery revenue is missing or the window is wrong');
  assert.strictEqual(revenue.orders, 3);
});

it('a wallet top-up is NOT revenue', () => {
  // The ¥3,000 sits in the window and must not reach the top line: money
  // becomes revenue when an order consumes it, not when it arrives.
  assert.ok(!/retail_topup_transactions/.test(ROUTE_CODE), 'Finance must not read the top-up ledger');
  assert.ok(revenue.revenue < 3000, 'top-up cash reached revenue');
});

it('Finance reads neither the stock ledger nor the dashboard aggregator', () => {
  assert.ok(!/retail_stock_ledger/.test(ROUTE_CODE), 'Finance must not read the gzgrocery ledger');
  assert.ok(!/guanyiPickupSales/.test(ROUTE_CODE), 'that is the fold this module exists to avoid');
});

it('unpaid and refunded orders are out', () => {
  // 999 (pending_payment) and 777 (refunded) are both inside the window by date.
  assert.ok(revenue.revenue !== 1600 + 999, 'an unpaid order was counted');
  assert.ok(revenue.revenue !== 1600 + 777, 'a refunded order was counted');
});

it('an order paid 1 Aug and placed 31 Jul 22:00 Guangzhou lands in August', () => {
  // The §36 worked example. Its ¥100 is inside the 1600 above; drop the shift
  // or read placed_at alone and it moves to July.
  const july = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS r FROM retail_orders
      WHERE ${PAID} AND ${ODATE} BETWEEN '2026-07-01' AND '2026-07-31'`).get();
  assert.strictEqual(july.r, 60, 'only the never-paid July order belongs to July');
});

it('expenses sum over an arbitrary range, not a calendar month', () => {
  // The kitchen route groups by substr(date,1,7) and cannot answer this at all.
  assert.strictEqual(expenses.total, 1050, '31 July must not be in an August window');
  const crossing = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS t FROM expense_entries
      WHERE ${EDATE} BETWEEN '2026-07-25' AND '2026-08-06'`).get();
  assert.strictEqual(crossing.t, 10999, 'a window crossing a month boundary must still sum');
});

it('a window ENTIRELY BEFORE the cutover still sums — no 1 August floor', () => {
  // §36, *Finance is not floored at the cutover date* (DECIDED 2026-09-02).
  // The ¥9,999 dated 31 July is the row the cutover would have hidden.
  // Production's real figure is 111 rows across May, June and July totalling
  // ¥180,332.28; this is that case in miniature.
  const july = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM expense_entries
      WHERE ${EDATE} BETWEEN '2026-07-01' AND '2026-07-31'`).get();
  assert.strictEqual(july.n, 1, 'the 31 July expense must be reachable');
  assert.strictEqual(july.t, 9999);
  // And the breakdown behind the disclosure reaches it too, not just the total.
  const bd = db.prepare(
    `SELECT category, COALESCE(SUM(amount),0) AS amount FROM expense_entries
      WHERE ${EDATE} BETWEEN '2026-07-01' AND '2026-07-31' GROUP BY category`).all();
  assert.deepStrictEqual(bd, [{ category: 'Rent', amount: 9999 }]);
});

it('NO cutover date is live in the route, the screen, the window lib or the markup', () => {
  // The survey behind the decision found the floor existed only in prose. All
  // four files now carry sentences saying there is no floor and every one of
  // them names the date, so this reads CODE and comment-stripped markup only.
  const markup = HTML.slice(HTML.indexOf('id="tab-finance"'), HTML.indexOf('id="tab-sales"'))
    .replace(/<!--[\s\S]*?-->/g, ' ');
  [['the route', ROUTE_CODE], ['the screen', CLIENT_CODE],
   ['the window lib', codeOnly(WINDOW_LIB)], ['the markup', markup]]
    .forEach(([what, src]) => assert.ok(!/2026-08-01/.test(src), `a cutover date is live in ${what}`));
  // The range bar's own fields, which serve both sub-views.
  ['fin-from', 'fin-to'].forEach(id => {
    const f = HTML.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(f && !/\bmin=/.test(f[0]), `a floor is back on #${id}`);
  });
});

/* ── Revenue's own breakdown ───────────────────────────────────────────────
   The top line now opens onto the channels behind it, and the whole contract is
   that it ADDS UP: the disclosure is the headline's own query with a GROUP BY
   added, so the lines equal the figure by construction rather than by agreement.
   These read the SHIPPED expression out of the route, so an edit that replaces
   it with a second sum — the failure this shape exists to prevent — fails here.

   Its own fixture, deliberately. The one above is §36's worked set and its
   totals are quoted in the assertions around it; the NULL and empty-string
   channels this needs would move those numbers, and a case about folding two
   spellings together does not belong inside a case about a timezone boundary. */
const rdb = new Database(':memory:');
rdb.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    -- §182. REAL DEFAULT 0 is database.js:4593's own declaration, not a
    -- fixture convenience: the shipped revenue query reads this column now, and
    -- a fixture that defaulted it NULL would exercise a state production does
    -- not have while hiding the one it does.
    balance_used REAL DEFAULT 0,
    paid_at DATETIME, placed_at DATETIME, replacement_for_order_id INTEGER);
`);
[[1, 'paid', 'wechat', 1000], [2, 'paid', 'meituan', 400],
 // The two spellings of "the mini app wrote no channel". They must land on ONE
 // line: the payload maps both to the same key and the screen draws both as
 // WeChat, so two lines would be two identical labels with different figures.
 [3, 'paid', null, 250], [4, 'paid', '', 50],
 [5, 'delivered', 'gzgrocery', 500],
 // Counted by the headline, so it must have a line — even though this file has
 // never heard of the key.
 [6, 'paid', 'tiktok', 70],
 // Neither of these is revenue, so neither may appear as a channel.
 [7, 'pending_payment', 'wechat', 999], [8, 'refunded', 'wechat', 777],
].forEach(([id, st, ch, t]) => rdb.prepare(
  'INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (?,?,?,?,?,NULL)'
).run(id, st, ch, t, '2026-08-10 03:00:00'));
// One outside the window, to prove the group is windowed like the total.
rdb.prepare("INSERT INTO retail_orders (id,status,channel,total,paid_at,placed_at) VALUES (9,'paid','wechat',5000,'2026-07-02 03:00:00',NULL)").run();

/** The shipped revenue query, with its two predicates resolved. */
function shippedRevenue() {
  const m = ROUTE.match(/const revGrouped = db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the revenue query is no longer where the test reads it');
  return m[1]
    .replace(/\$\{PAID\}/g, PAID)
    .replace(/\$\{odateFor\(sqlDayShiftForShop\(tdb\(\)\)\)\}/g, ODATE);
}
const revRows = rdb.prepare(shippedRevenue()).all(FROM, TO);

it('the channel lines ADD UP to the revenue headline — one read, one total', () => {
  // 1000 + 400 + 250 + 50 + 500 + 70 = 2270. Every row here settles in cash, so
  // the §182 term adds nothing to it — which is the point of leaving them
  // alone: the wallet arithmetic gets its own fixture below, and these numbers
  // go on proving the cash path did not move when it landed.
  const sum = revRows.reduce((a, r) => a + r.amount, 0);
  const head = rdb.prepare(
    `SELECT COALESCE(SUM(COALESCE(total,0) + COALESCE(balance_used,0)),0) AS r FROM retail_orders
      WHERE ${PAID} AND ${ODATE} BETWEEN ? AND ?`
  ).get(FROM, TO).r;
  assert.strictEqual(sum, 2270);
  assert.strictEqual(sum, head, 'the breakdown must equal the figure it opens from');
});

it('the headline is FOLDED OUT of the grouped read, never summed beside it', () => {
  // The route must hold exactly one revenue SUM over retail_orders. A second one
  // is a second place the arithmetic is done, and the day the two disagree the
  // card shows a total its own disclosure contradicts.
  //
  // §182 CHANGED WHAT THE SUM IS, NOT HOW MANY THERE MAY BE. The expression is
  // now `total + balance_used`, so this guard names that; and a BARE `SUM(total)`
  // reappearing anywhere in the route would be the old cash-only figure back as
  // a second opinion, which is why zero of them is asserted rather than ignored.
  const sums = ROUTE_CODE.match(/SUM\(COALESCE\(total, 0\) \+ COALESCE\(balance_used, 0\)\)/g) || [];
  assert.strictEqual(sums.length, 1, 'revenue is being summed in more than one place');
  assert.strictEqual((ROUTE_CODE.match(/SUM\(total\)/g) || []).length, 0,
    'a bare SUM(total) is the pre-§182 cash-only revenue, and it drops wallet sales');
  assert.match(ROUTE_CODE, /const revenue = money\.fromMinor\(revMinor\)/,
    'the headline must be the grouped read folded up, in minor units');
});

it('a NULL channel and an EMPTY one are the same line — the mini app', () => {
  // `COALESCE(NULLIF(channel,''),'wechat')`, which is order-channel-counts'
  // expression verbatim. Two lines here would be two rows drawing the same word.
  const wc = revRows.filter(r => r.channel === 'wechat');
  assert.strictEqual(wc.length, 1, 'the two blank spellings did not fold onto one line');
  assert.strictEqual(wc[0].amount, 1300, '1000 + 250 + 50');
  assert.strictEqual(wc[0].orders, 3);
  assert.ok(!revRows.some(r => r.channel === null || r.channel === ''),
    'no blank channel may reach the screen as a bucket of its own');
});

it('gzgrocery gets a line, and it is the MIRROR ROWS — not the stock ledger', () => {
  // §36: Finance never reads the ledger. The line is the order rows the total
  // above it summed, which is the only way the two can agree.
  const gy = revRows.find(r => r.channel === 'gzgrocery');
  assert.ok(gy, 'gzgrocery is missing from the breakdown it is inside the total of');
  assert.strictEqual(gy.amount, 500);
});

it('an unknown channel keeps its own line rather than vanishing from a total', () => {
  const tt = revRows.find(r => r.channel === 'tiktok');
  assert.ok(tt && tt.amount === 70, 'a channel this file cannot name was dropped');
});

it('unpaid, refunded and out-of-window orders are absent from the channels too', () => {
  assert.ok(!revRows.some(r => r.amount === 999 || r.amount === 777),
    'the breakdown must carry the headline’s own predicate');
  assert.strictEqual(revRows.reduce((a, r) => a + r.orders, 0), 6);
});

it('the heaviest channel is first — the operator is asking which one earned it', () => {
  const amounts = revRows.map(r => r.amount);
  assert.deepStrictEqual(amounts, [...amounts].sort((a, b) => b - a), 'ORDER BY amount DESC is gone');
});

// ── §182 · wallet money is revenue AT THE SALE ─────────────────────────────
// A SEPARATE DATABASE, ON PURPOSE. The rows above are every one of them settled
// in cash, and they are left that way so they keep proving the cash path did not
// move when this landed; mixing wallet rows into them would have re-baselined
// six assertions at once and made a regression there indistinguishable from this
// change. The query is the SHIPPED one either way — `shippedRevenue()` again,
// sliced out of the route, never transcribed.
console.log('\n2a · §182 — the wallet half of a bill');

const wdb = new Database(':memory:');
wdb.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    balance_used REAL DEFAULT 0, points_amount REAL DEFAULT 0,
    paid_at DATETIME, placed_at DATETIME, replacement_for_order_id INTEGER);
`);
// The gross a customer paid is `points_amount + balance_used + total` (§93), and
// each row below settles a ¥300 bill a different way.
[// id  status  channel    total  balance  points
  [1, 'paid', 'wechat',   300,   0,    0],    // all cash
  [2, 'paid', 'wechat',     0, 300,    0],    // all wallet — invisible before §182
  [3, 'paid', 'meituan',  100,  50,    0],    // mixed
  [4, 'paid', 'manual',     0,   0,  300],    // all POINTS — never revenue
  [5, 'paid', 'web',      200, null,   0],    // NULL balance, as an old row carries
].forEach(([id, st, ch, t, b, pts]) => wdb.prepare(
  `INSERT INTO retail_orders (id,status,channel,total,balance_used,points_amount,paid_at,placed_at)
   VALUES (?,?,?,?,?,?,'2026-08-10 03:00:00',NULL)`).run(id, st, ch, t, b, pts));

const wRows = wdb.prepare(shippedRevenue()).all(FROM, TO);
const wOf = (ch) => (wRows.find(r => r.channel === ch) || { amount: 0 }).amount;

it('a bill settled from the wallet is revenue — the §182 hole', () => {
  // THE BUG THIS CLOSES, stated as arithmetic. `total` is the CASH RESIDUAL, so
  // order 2 carried ¥0 of it; Finance summed `total` alone and showed nothing
  // for a ¥300 sale whose goods had left the shelf — while the cost read below,
  // which never asks how a bill was settled, charged the card their full cost.
  // Counted at the SALE and not at the top-up, which is the rule the route
  // header always stated and the code did not keep.
  assert.strictEqual(wOf('wechat'), 600, '300 cash + 300 wallet; pre-§182 this was 300');
});

it('a part-wallet bill counts both halves, once each', () => {
  assert.strictEqual(wOf('meituan'), 150, '100 cash + 50 wallet');
});

it('POINTS are NOT revenue, and that asymmetry is the decision', () => {
  // `points_amount` is a discount the shop granted itself — no customer ever
  // paid it. A points-settled sale earns nothing and costs real stock, and that
  // is the truth about a giveaway rather than a gap left half-closed.
  assert.strictEqual(wOf('manual'), 0, 'a points-settled bill must earn no revenue');
  assert.ok(!/points_amount/.test(shippedRevenue()),
    'the revenue query must not reach for the points tender');
});

it('a NULL balance_used does not null the channel it is on', () => {
  // `a + NULL` is NULL in SQLite, and an outer COALESCE(SUM(...),0) cannot see
  // that it happened — one legacy row would have zeroed a whole channel line.
  assert.strictEqual(wOf('web'), 200, 'a NULL balance swallowed the cash beside it');
});

it('the wallet term rides the SAME grouped read — still one total', () => {
  // The headline is folded out of these rows (§36), so a wallet term added to
  // the lines but not the total, or the reverse, would show a card whose own
  // disclosure contradicts it.
  const sum = wRows.reduce((a, r) => a + r.amount, 0);
  assert.strictEqual(sum, 950, '300 + 300 + 150 + 0 + 200');
});

it('an uncategorised expense keeps its own line rather than a minted bucket', () => {
  const nulls = breakdown.filter(r => r.category == null);
  assert.strictEqual(nulls.length, 1);
  assert.strictEqual(nulls[0].amount, 50);
});

// ── The cost read, against a real database ─────────────────────────────────
// §56 as amended 2026-09-14. THE SQL IS SLICED OUT OF THE LIVE ROUTE AND RUN,
// never transcribed: §36's whole finding about this family of queries is that
// copies drift, and a test carrying its own copy of the formula would go on
// passing after the route's copy was changed. What is asserted here is the
// arithmetic the screen will actually show.
console.log('\n2b · the cost read — §36’s traps, on rows that spring them');

const { PAID_O: T_PAID_O, odateFor: T_ODATE } = require(path.join(ROOT, 'lib', 'finance-window'));
const COST_SQL = (() => {
  const at = ROUTE.indexOf('const costRow = db.prepare(`');
  assert.ok(at > 0, 'the cost read must still be a prepared statement in the route');
  const start = ROUTE.indexOf('`', at) + 1;
  const end = ROUTE.indexOf('`', start);
  // The two interpolations are the SHARED predicates. Supplying them here is
  // what proves the route takes them from lib/finance-window.js rather than
  // spelling either out — a hand-written `o.status IN (…)` would need no
  // binding and this slice would still run, so the check below names them.
  // eslint-disable-next-line no-new-func
  return new Function('PAID_O', 'odateFor', 'sqlDayShiftForShop', 'tdb',
    'return `' + ROUTE.slice(start, end) + '`;')(T_PAID_O, T_ODATE, () => '+8 hours', () => null);
})();

it('the cost read borrows both predicates rather than restating either', () => {
  const at = ROUTE.indexOf('const costRow = db.prepare(`');
  const tpl = ROUTE.slice(at, ROUTE.indexOf('.get(from, to)', at));
  assert.ok(/\$\{PAID_O\}/.test(tpl), 'the allow-list must be the shared one, alias-qualified');
  assert.ok(/\$\{odateFor\(/.test(tpl), 'the order date must be the shared expression');
  assert.ok(!/status IN \(/.test(tpl), '§36: the list was re-declared inline four times; not a fifth');
});

const xdb = new Database(':memory:');
xdb.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, total REAL,
    paid_at DATETIME, placed_at DATETIME, replacement_for_order_id INTEGER);
  CREATE TABLE retail_order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER, qty REAL, line_total REAL,
    pack_units INTEGER DEFAULT 1, refunded_qty INTEGER DEFAULT 0,
    unit_cost_at_sale REAL, options_cost_at_sale REAL);
`);
{
  const o = xdb.prepare('INSERT INTO retail_orders VALUES (?,?,?,?,NULL,?)');
  const i = xdb.prepare('INSERT INTO retail_order_items VALUES (?,?,?,?,?,?,?,?)');
  //      id  status       total  paid_at                 replacement
  o.run(1, 'paid', 40, '2026-08-10 03:00:00', 0);
  i.run(1, 1, 2, 40, 1, 0, 8, null);    // plain: 8 × 2 × 1 = 16
  o.run(2, 'delivered', 30, '2026-08-11 03:00:00', 0);
  i.run(2, 2, 1, 30, 6, 0, 8, null);    // PACK UNITS: 8 × 1 × 6 = 48
  o.run(3, 'paid', 40, '2026-08-12 03:00:00', 0);
  i.run(3, 3, 2, 40, 1, 1, 8, null);    // ITEMISED REFUND: 8 × (2−1) × 1 = 8
  o.run(4, 'paid', 20, '2026-08-13 03:00:00', 0);
  i.run(4, 4, 1, 20, 1, 0, null, null); // never costed — revenue only
  o.run(5, 'cancelled', 999, '2026-08-14 03:00:00', 0);
  i.run(5, 5, 50, 999, 1, 0, 8, null);  // excluded by the allow-list
  o.run(6, 'paid', 0, '2026-08-15 03:00:00', 1);
  i.run(6, 6, 9, 0, 1, 0, 8, null);     // §98 replacement — excluded
  // ── §166's rows, in SEPTEMBER and one per day ─────────────────────────────
  // OUTSIDE the August window every assertion above is measured over, because
  // `COST` is the whole of August and a row added inside it moves figures that
  // were pinned deliberately. (Learned the hard way: dropping these on 08-20
  // turned the pack-multiplier case from 72 into 175.5.)
  //
  // A chosen extra draws down a real shelf once per UNIT BOUGHT. The pack factor
  // must not touch it and the refund factor must.
  o.run(7, 'paid', 60, '2026-09-20 03:00:00', 0);
  i.run(7, 7, 2, 60, 1, 0, 8, 1.5);     // 8×2×1 = 16 product, 1.5×2 = 3 extras
  o.run(8, 'paid', 60, '2026-09-21 03:00:00', 0);
  i.run(8, 8, 1, 60, 6, 0, 8, 1.5);     // 8×1×6 = 48 product, 1.5×1 = 1.5 extras
  o.run(9, 'paid', 60, '2026-09-22 03:00:00', 0);
  i.run(9, 9, 3, 60, 1, 1, 8, 1.5);     // 8×2 = 16 product, 1.5×2 = 3 extras
  o.run(10, 'paid', 60, '2026-09-23 03:00:00', 0);
  i.run(10, 10, 2, 60, 1, 0, 8, null);  // product costed, extras unknown
}
const COST = xdb.prepare(COST_SQL).get('2026-08-01', '2026-08-31');

it('the cost half takes the pack multiplier and the revenue half does not', () => {
  // 16 + 48 + 8 = 72. Had the revenue side taken it too, line_rev would be 230.
  assert.strictEqual(COST.cogs, 72, '§36 trap 1: cost is per unit, line_total is per line');
  assert.strictEqual(COST.line_rev, 130, 'revenue must NOT be multiplied by pack_units');
});

// ── §166 — a chosen extra costs money, and takes ONE of the two factors ────
//
// The gap this closes was written down in the route's own comment for months:
// "OPTIONS carry a price delta with no cost counterpart." A choice carrying a
// `stock_product_id` is a real thing off a real shelf, reserved one per unit by
// expandStockLines, and it contributed nothing at all to this sum.
//
// THE PACK FACTOR IS THE WHOLE REASON IT IS A SECOND COLUMN. Folding the extras
// into unit_cost_at_sale was the smaller change and is provably wrong: that
// column is multiplied by pack_units, an extra is not, and one column cannot be
// both. These are the cases that would have caught the fold.
const day = (d) => xdb.prepare(COST_SQL.replace('BETWEEN ? AND ?', `BETWEEN '${d}' AND '${d}'`)).get();

it('a chosen extra reaches the cost sum at all', () => {
  assert.strictEqual(day('2026-09-20').cogs, 19, '16 product + 3 extras');
});

it('the extras do NOT take the pack multiplier, though the product does', () => {
  // Six units off the shelf, ONE oat milk. Folded into unit_cost_at_sale this
  // would read 48 + 9 = 57 and charge for six.
  assert.strictEqual(day('2026-09-21').cogs, 49.5, '48 product + 1.5 extras, not 9');
});

it('the extras DO take the refund factor, exactly as the product does', () => {
  // qty 3, one refunded → two billable units, so two extras and not three.
  assert.strictEqual(day('2026-09-22').cogs, 19, '16 product + 3 extras on 2 units');
});

it('an unknown extras cost adds nothing rather than guessing a zero', () => {
  // NULL is the column's word for unknown. The line still contributes its
  // product cost — a missing extras figure must not take the product with it.
  assert.strictEqual(day('2026-09-23').cogs, 16, 'product only, extras absent');
});

it('coverage still measures the PRODUCT half only, and that is deliberate', () => {
  // The fraction has a published meaning. Order 10's product is costed and its
  // extras are not, and it still counts as covered — recorded in the route's
  // own comment rather than quietly redefined.
  assert.strictEqual(day('2026-09-23').line_rev_costed, 60, 'a costed product covers the line');
});

it('an itemised partial refund comes off the cost, as nothing else in the tree does', () => {
  // Order 3 alone: 8 × (2 − 1) = 8, not 16. §36 trap 2.
  const one = xdb.prepare(COST_SQL.replace('BETWEEN ? AND ?', "BETWEEN '2026-08-12' AND '2026-08-12'"))
    .get();
  assert.strictEqual(one.cogs, 8, 'refunded_qty must be subtracted from the billable quantity');
});

it('an uncosted line is revenue with no cost, never a zero cost', () => {
  assert.strictEqual(COST.line_rev - COST.line_rev_costed, 20, 'order 4 is the uncosted ¥20');
  assert.ok(COST.line_rev_costed < COST.line_rev, 'coverage must be short of 1 here');
});

it('the excluded orders are excluded on BOTH halves, not just revenue', () => {
  // A cancelled order or a §98 replacement leaking into cost would shift the
  // margin without shifting revenue — the hardest kind of wrong to notice.
  assert.ok(COST.cogs < 72 + 8, 'no cancelled or replacement line may reach the cost sum');
  assert.strictEqual(COST.line_rev, 130, 'nor the line revenue');
});

it('a period with lines but NO costed line yields zero costed revenue, and the route reads that as null', () => {
  // The guard this pins is `costedRev > 0 ? … : null` in the route. Without it
  // the endpoint answers ¥0.00 for July 2026 — ¥56,792 of real sales — and the
  // screen publishes a 100% margin for a month whose cost was never captured.
  const empty = xdb.prepare(COST_SQL).get('2026-08-13', '2026-08-13');
  assert.strictEqual(empty.line_rev_costed, 0, 'the fixture day carries only the uncosted line');
  assert.ok(empty.line_rev > 0, 'and it does carry revenue, so this is not an empty period');
  const at = ROUTE.indexOf('const cogs =');
  const guard = ROUTE.slice(at, ROUTE.indexOf('\n', at));
  assert.ok(/costedRev > 0 \? .* : null/.test(guard),
    'zero costed revenue must yield NULL — "zero claims the goods were free"');
});

it('coverage is measured in MONEY, not in lines', () => {
  // By line these are 4 costed of 5; by money ¥110 of ¥130. The figure the
  // fraction qualifies is money, so the fraction must be money.
  const at = ROUTE.indexOf('const costCoverage =');
  const expr = ROUTE.slice(at, ROUTE.indexOf('\n', at));
  assert.ok(/costedRev \/ lineRev/.test(expr), 'the ratio must be of the two money sums');
  assert.ok(!/COUNT\(/.test(COST_SQL.slice(COST_SQL.indexOf('line_rev_costed'))),
    'no line count may stand in for the money share');
  assert.strictEqual(COST.line_rev_costed, 110);
});

// ── The screen ─────────────────────────────────────────────────────────────
console.log('\n3 · the screen — the seventh state, and the locked pairs');

const ctx = {
  window: { addEventListener: () => {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  Date, Math, Number, String, JSON,
  cuT: (en) => en,
  escapeHtml: (s) => String(s == null ? '' : s),
  // The drill-down's rows render a date and a figure through the house helpers.
  // Identity stubs: this file asserts what the row SAYS, not how 01-core.js
  // formats a day or wraps a currency — both have their own tests.
  tdWhen: (d) => String(d),
  // The item name follows the reader's language (tmStoreLabel's pattern). The
  // English surface is the default; the CN case overrides this per assertion.
  cuLang: () => 'en',
  // acWrap is 01-core.js's currency wrapper — the ¥ on this card comes from
  // there, not from finMoney, which formats the digits alone. The stub carries
  // the symbol so the assertions below can read a figure the way the screen
  // draws one.
  acWrap: (s) => '¥' + String(s),
  // acMoney is the SAME currency wrapper at real precision — the two-decimal
  // form 01-core.js reserves for figures an operator reconciles, which a unit
  // price is. The stub keeps two places so the assertions can tell a ¥3.50 jar
  // from the ¥4 finMoney would have drawn.
  acMoney: (n, dp) => '¥' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dp) ? dp : 2,
    maximumFractionDigits: Number.isInteger(dp) ? dp : 2,
  }),
};
vm.createContext(ctx);
new vm.Script(
  CLIENT.replace(/^\/\* eslint-env[\s\S]*?\*\/$/m, '')
    .replace(/^'use strict';$/m, '')
  + '\nthis.finRow=finRow; this.finMoney=finMoney; this.finNotRecorded=finNotRecorded;\n  this.finNotRecordedValue=finNotRecordedValue;'
  + '\nthis.finBreakdown=finBreakdown;'
  + '\nthis.finRevBreakdown=finRevBreakdown; this.finChannelLabel=finChannelLabel;'
  // The drill-down's state is module-local by design — nothing in the shipped
  // file exposes it. This appends a setter to the SOURCE AS EVALUATED IN THE VM,
  // the same trick the exports above already use, so the render can be driven
  // through its three states without a test hook shipping in the product.
  + '\nthis.__finSet=(d,c,p)=>{FIN_DATA=d;FIN_CAT=c;FIN_POL=p===undefined?null:p;};'
).runInContext(ctx);

it('cost of goods and gross profit READ Not recorded — not a blank, not a dash', () => {
  // §36 v4.113: "Summary renders both the cost of goods line and the gross
  // profit line READING NOT RECORDED." A blank figure cell reads as a gap, not
  // as a statement — which is the failure the seventh state exists to avoid.
  // The VALUE here is a different string from the sentence below the pair, and
  // the vocabulary says so: "neither replaces the other."
  const cost = ctx.finRow('Cost of goods', ctx.finNotRecordedValue(), { less: true, notrec: true });
  const gross = ctx.finRow('Gross profit', ctx.finNotRecordedValue(), { concl: true, notrec: true });
  [cost, gross].forEach(html => {
    assert.ok(/<span class="fin-fig">Not recorded<\/span>/.test(html), 'the row must read Not recorded');
    assert.ok(!/>0<|¥0/.test(html), 'zero claims the goods were free');
    // The sign column is a deduction cue and belongs only beside an amount.
    // A lone minus in the money column reads as the dash §36 bans as a value.
    assert.ok(/<span class="fin-sign"><\/span>/.test(html),
      'no sign may stand beside a figure that is not a quantity');
  });
  // …while a real deduction still carries it.
  assert.ok(/<span class="fin-sign">−<\/span>/.test(ctx.finRow('Operating expenses', '¥34,328', { less: true })),
    'a genuine deduction keeps its minus');
});

it('the not-recorded note is ONE sentence, past tense, and names no date', () => {
  const html = ctx.finNotRecorded();
  assert.ok(/class="td-notrec"/.test(html), 'must use the house class');
  assert.strictEqual((html.match(/This period has no recorded cost data\./g) || []).length, 1,
    '§1.12: show what is known, and ONE past-tense sentence saying why the rest is not');
  assert.ok(!/\d{4}|Aug|August|2026/.test(html),
    '§36 v4.113 forbids naming a boundary date — the cutoff query has not been run');
  assert.ok(!/unavailable|missing|unknown/i.test(html),
    'each of those implies a retry, an oversight, or a search');
});

it('the cost rows are UNCONDITIONAL — lifting the floor added no date test', () => {
  // §36, *Finance is not floored at the cutover date*: "Both cost rows keep
  // reading Not recorded unconditionally and take no date condition." The
  // decision that lifted the expense floor deliberately did NOT qualify
  // v4.113's seventh state — the cost reader is not built, so there is nothing
  // for such a condition to switch between.
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'), CLIENT.indexOf('async function finLoad'));
  assert.ok(!/\bif\b[^\n]*(date|from|to|2026|window)/i.test(card),
    'the staircase must not branch on the period');
  assert.ok(!/2026-08-31|cutoff|capture/i.test(CLIENT_CODE),
    'no capture-date constant may reach the screen');
});

// ── §56 as amended 2026-09-14 — the three states of the two cost rows ───────
//
// WHAT THIS TEST REPLACED, AND WHY IT IS NOT A WEAKENING. Until the amendment
// these two rows read the seventh state unconditionally, and the check here
// was a regex pinning `finNotRecordedValue()` into the card's own source. That
// rule is gone by decision, not by drift — but the regex it was written as
// could only ever have said "still blank", so it is replaced by one that RUNS
// the renderer against all three states rather than reading it. The amendment
// removed one rule and added three; the suite gains assertions rather than
// losing them.
//
// THE CONDITION IS THE POINT. §56 as amended lets the figure appear ONLY
// alongside the share of the period it rests on, so "a figure with no coverage
// sentence" is the one output that would undo the decision while looking
// correct. It is asserted directly, twice — once that the sentence is there
// under partial coverage, once that the ONLY thing that silences it is full
// coverage.
it('no costed line keeps the seventh state exactly as it was', () => {
  const html = ctx.finCostRows({ cost_of_goods: null, gross_profit: null, cost_coverage: 0 });
  assert.ok(html.includes(ctx.finNotRecordedValue()), 'both rows must still read the not-recorded VALUE');
  assert.strictEqual((html.match(/Cost of goods|Gross profit/g) || []).length, 2, 'both rows still render');
  assert.strictEqual((html.match(/This period has no recorded cost data\./g) || []).length, 1,
    '§1.12: ONE sentence under the pair, not one per row');
  assert.ok(!/¥|fin-sign">−/.test(html.replace(/Cost of goods|Gross profit/g, '')),
    'zero claims the goods were free — §36 refused it and §56 kept the refusal');
});

it('a partly costed period shows the figures AND the share they rest on', () => {
  // The measured production window: 29.1% of line revenue carried a cost.
  const html = ctx.finCostRows({ cost_of_goods: 11750, gross_profit: 127941, cost_coverage: 0.291 });
  assert.ok(/11,750/.test(html), 'cost of goods must render its figure');
  assert.ok(/127,941/.test(html), 'gross profit must render its figure');
  assert.ok(!html.includes(ctx.finNotRecordedValue()), 'a row carrying a figure is not the seventh state');
  assert.ok(/Cost recorded for 29% of this period's revenue/.test(html),
    'THE CONDITION OF THE AMENDMENT: the figure never appears without its coverage');
  assert.ok(/the real margin is lower/.test(html),
    'the DIRECTION is the point — a shortfall can only flatter, never the reverse');
  assert.ok(!/no recorded cost data/.test(html),
    'the absence sentence and the shortfall sentence are never both drawn');
});

it('the percentage FLOORS, so the sentence can never claim more than it has', () => {
  // 99.6% rounds to 100 and would print a sentence contradicting its own number.
  const html = ctx.finCostRows({ cost_of_goods: 1, gross_profit: 2, cost_coverage: 0.996 });
  assert.ok(/99%/.test(html), 'floor, not round');
  assert.ok(!/100%/.test(html), 'a note that says 100% is a note that argues with itself');
});

it('full coverage removes the sentence on its own, with nothing to remember', () => {
  const html = ctx.finCostRows({ cost_of_goods: 40000, gross_profit: 100000, cost_coverage: 1 });
  assert.ok(/40,000/.test(html) && /100,000/.test(html), 'the figures still render');
  assert.ok(!/Cost recorded for|no recorded cost data/.test(html),
    'the caveat expires with the shortfall it describes — it is never deleted by hand');
});

it('the card draws the cost rows through the one function that knows the states', () => {
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'));
  assert.ok(/finCostRows\(d\)/.test(card), 'the staircase must call the state-aware renderer');
  // The state is the SERVER's (routes/finance-summary.js decides null vs figure).
  // Re-deriving it here from the coverage number would put one rule in two
  // places, which is how a screen and its payload come to disagree.
  assert.ok(!/cost_coverage\s*===\s*0|cost_coverage\s*<=\s*0/.test(CLIENT_CODE),
    'the screen must not re-derive the no-cost state from the fraction');
});

it('every rendered pair is copied from the locked vocabulary table', () => {
  // Rule 4: never compose new Chinese. Each pair must appear verbatim in the
  // Finance section of the vocabulary, which is the source of record.
  const finance = VOCAB.slice(VOCAB.indexOf('## Finance — the money staircase'));
  [['Revenue', '营收'], ['Cost of goods', '销货成本'], ['Gross profit', '毛利润'],
   ['Operating expenses', '营业费用'], ['Net', '净额'],
   ['This period has no recorded cost data.', '此期间未记录成本数据。']]
    .forEach(([en, cn]) => {
      // The pair may be split across lines by the formatter, so match the two
      // halves as one cuT() argument list rather than as adjacent text.
      const pair = new RegExp(`'${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*'${cn}'`);
      assert.ok(pair.test(CLIENT), `the screen does not render the pair: ${en}`);
      assert.ok(finance.includes(en) && finance.includes(cn), `not locked in the vocabulary: ${en}`);
    });
});

it('gross profit is 毛利润, never Margin’s 毛利', () => {
  // Ruling 2. `毛利` is live as the Margin label at 09-products.js:1312.
  assert.ok(!/'毛利'/.test(CLIENT), 'that pair belongs to Margin and must stay free');
});

it('Revenue is 营收, never Income’s 收入', () => {
  assert.ok(!/'收入'/.test(CLIENT), 'ruling 1 — Finance keeps Income for a different thing');
});

it('the three location pairs are NOT rendered — their column does not exist', () => {
  // contribution / notLocationSpecific / excludedCosts stay locked and unused
  // until expense_entries can carry a location. Rendering one would be a claim.
  ['贡献毛利', '非门店专属', '不含全店成本'].forEach(cn => {
    assert.ok(!CLIENT.includes(cn), `rendered a location pair with no data behind it: ${cn}`);
  });
  assert.ok(!/store_id|fin-store/.test(CLIENT_CODE), 'no store filter may reach this screen');
  assert.ok(!/store_id/.test(ROUTE_CODE), 'the endpoint must take no store filter');
});

it('the terminus says Net, never Contribution', () => {
  const term = CLIENT.slice(CLIENT.indexOf('fin-terminus'));
  assert.ok(/'Net', '净额'/.test(term));
  assert.ok(!/Contribution/.test(term.split('function')[0]));
});

/* ── The revenue disclosure on screen ──────────────────────────────────────
   Reported from the card: "just like the expenses can unfold and show
   information, revenue should do the same". The row is now a <details> with one
   line per channel inside it. */

const REV_ROWS = [
  { channel: 'wechat', amount: 1300, orders: 3 },
  { channel: 'meituan', amount: 400, orders: 1 },
  { channel: 'gzgrocery', amount: 500, orders: 1 },
  { channel: 'tiktok', amount: 70, orders: 1 },
];

it('revenue opens onto its channels, and the lines carry the channel figures', () => {
  const html = ctx.finRevBreakdown(REV_ROWS);
  assert.ok(/class="fin-breakdown"/.test(html), 'the breakdown must use the house container');
  assert.strictEqual((html.match(/class="fin-row/g) || []).length, 4, 'one line per channel');
  ['WeChat', 'Meituan', 'Gzgrocery'].forEach(name =>
    assert.ok(html.includes(name), `the ${name} line is missing`));
  assert.ok(/¥1,300/.test(html) && /¥400/.test(html), 'a channel figure is missing');
});

it('a channel line is the same grey as an expense line — not finRow\u2019s', () => {
  // `finRow` stamps .fin-input, and #tab-finance .fin-row.fin-input .fin-lbl
  // outweighs #tab-finance .fin-breakdown .fin-lbl — so a channel built that way
  // came out in --td-text while the expense lines below it sat in --td-text2.
  // Two breakdowns on one card in two greys, with nothing meant by it.
  const html = ctx.finRevBreakdown(REV_ROWS);
  assert.ok(!/fin-input/.test(html), 'a channel line must not carry .fin-input');
  assert.ok(/<div class="fin-row">/.test(html), 'it must be the bare breakdown row');
  // Both selectors are still the ones that decide it.
  assert.ok(/#tab-finance \.fin-row\.fin-input \.fin-lbl/.test(CSS)
    && /#tab-finance \.fin-breakdown \.fin-lbl/.test(CSS),
    'the two rules this avoids have moved — re-check which one wins');
  // The middle grid column is held open, or the figures stop lining up.
  assert.strictEqual((html.match(/<span class="fin-sign"><\/span>/g) || []).length, REV_ROWS.length);
});

it('the channel rows CANNOT be mistaken for bilingual prose pairs', () => {
  /* REGRESSION, reported live from the Chinese card: 营收 ¥123,384 over four
     channels totalling ¥101,498, against the same window in English showing
     seven that summed to the figure exactly. The missing ¥21,886 was Gzgrocery,
     wechat_chat and pickup — the three labels with no Chinese in them.

     The i18n walker pairs an all-English <div> with an adjacent all-Chinese one
     as stacked help text and hides the inactive side with display:none. In
     Chinese a 微信 row IS all-Chinese and the Gzgrocery row beside it IS
     all-English, so a list of channels read as a column of translation pairs.

     This drives the SHIPPED predicates out of 10-extras.js rather than copies of
     them, so it still holds if the heuristic is retuned — and fails if the guard
     is dropped from the row container. */
  const EXTRAS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '10-extras.js'), 'utf8');
  const grab = (name) => {
    const m = EXTRAS.match(new RegExp('function ' + name + '\\(el\\)\\s*\\{[\\s\\S]*?return ([^;]+);'));
    assert.ok(m, name + ' is no longer where this test reads it');
    return new Function('t', 'return ' + m[1].replace("el.textContent || ''", 't'));
  };
  const isCN = grab('isCNBlock'), isEN = grab('isENBlock');

  // The pairing scan only ever offers div/p to the rule, which is the whole
  // reason the expense lines — <button>s — never hit this. Pin it, so turning
  // one into a plain row is a red test rather than three vanished figures.
  assert.ok(EXTRAS.includes("querySelectorAll('div, p')"),
    'the block-pair scan no longer targets div/p — re-check which rows are exposed');
  assert.ok(/dataset\.noI18n != null\) return true/.test(EXTRAS),
    'inSkippedContext no longer honours data-no-i18n — the guard below is inert');

  // The Chinese surface, which is where the rows vanished.
  const cnCtx = Object.assign({}, ctx, { cuT: (en, cn) => cn, cuLang: () => 'cn' });
  vm.createContext(cnCtx);
  new vm.Script(CLIENT.replace(/^'use strict';$/m, '')
    + '\nthis.finRevBreakdown=finRevBreakdown;').runInContext(cnCtx);
  const html = cnCtx.finRevBreakdown([
    { channel: 'wechat', amount: 95524 }, { channel: 'gzgrocery', amount: 17842 },
    { channel: 'meituan', amount: 5056 }, { channel: 'wechat_chat', amount: 3824 },
    { channel: 'manual', amount: 777 }, { channel: 'pickup', amount: 220 },
    { channel: 'eleme', amount: 141 },
  ]);

  // THE SHAPE THAT MADE THE GUARD NECESSARY IS STILL WHAT RENDERS: adjacent
  // all-Chinese and all-Latin rows in one parent. If this ever stops being true
  // the guard is belt-and-braces; while it is true, the guard is the only thing
  // standing between an operator and a card that does not add up.
  const texts = [...html.matchAll(/<div class="fin-row">(.*?)<\/div>/g)]
    .map(m => m[0].replace(/<[^>]*>/g, ''));
  assert.strictEqual(texts.length, 7, 'one row per channel');
  assert.ok(texts.some(isCN) && texts.some(isEN),
    'the collision shape is gone — re-read why this guard exists before removing it');

  // THE GUARD. inSkippedContext walks UP the parents, so one attribute on the
  // container covers every row inside it.
  assert.ok(/<div class="fin-breakdown"[^>]*\sdata-no-i18n/.test(html),
    'the row container must be closed to the walker, or Chinese hides half the channels');

  // And the figures still total what the headline would: 123,384.
  const total = texts.reduce((a, t) => a + Number((t.match(/¥([\d,]+)/) || [0, '0'])[1].replace(/,/g, '')), 0);
  assert.strictEqual(total, 123384, 'the rendered rows must carry the whole figure');
});

it('the drill-down rows are closed to the walker, at BOTH levels', () => {
  /* The revenue guard's two siblings, each reproduced against the shipped
     walker before being fixed — neither is theoretical, and both predate §110.

     ONE · a row whose note is all-English, sitting beside one whose note is
     all-Chinese, was tagged as the English half of a translation pair and
     hidden outright in Chinese: an ¥800 expense off the screen while the
     category total above it still counted it.

     TWO · `processNode` splits a text node on its FIRST ' · ' when the right
     half carries Chinese and the left does not. Both posters write
     `RPO-0028 · 天河供应商 · 3 lines`, so an English reader saw `RPO-0028`
     alone — supplier and line count gone, a one-line order indistinguishable
     from a twelve-line one. */
  const marks = CLIENT.match(/<div class="fin-(?:cat|pol)rows"[^>]*>/g) || [];
  assert.strictEqual(marks.length, 2, 'both drill-down levels must have a container');
  marks.forEach(m => assert.ok(/\sdata-no-i18n/.test(m),
    'a drill-down container is open to the walker again: ' + m));

  // The shapes that made it necessary are still the shapes being rendered, so
  // nobody removes the guard believing it moot.
  const cnCtx = Object.assign({}, ctx, { cuT: (en, cn) => cn, cuLang: () => 'cn' });
  vm.createContext(cnCtx);
  new vm.Script(CLIENT.replace(/^'use strict';$/m, '')
    + '\nthis.finCatRow=finCatRow;'
    + '\nthis.__set=(d,c,p)=>{FIN_DATA=d;FIN_CAT=c;FIN_POL=p||null;};').runInContext(cnCtx);
  cnCtx.__set({}, null, null);

  const EXTRAS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '10-extras.js'), 'utf8');
  const grab = (name) => {
    const m = EXTRAS.match(new RegExp('function ' + name + '\\(el\\)\\s*\\{[\\s\\S]*?return ([^;]+);'));
    assert.ok(m, name + ' is no longer where this test reads it');
    return new Function('t', 'return ' + m[1].replace("el.textContent || ''", 't'));
  };
  const isCN = grab('isCNBlock'), isEN = grab('isENBlock');
  const rowText = (r) => cnCtx.finCatRow(r).replace(/<[^>]*>/g, '');
  assert.ok(isCN(rowText({ id: 1, date: '2026-08-03', amount: 1200, note: '天河店租金', source: 'manual' })),
    'a Chinese-noted row no longer reads as an all-Chinese block');
  assert.ok(isEN(rowText({ id: 2, date: '2026-08-04', amount: 800, note: 'Office chairs', source: 'manual' })),
    'an English-noted row no longer reads as an all-English block — re-check the guard');

  // And the PO description still carries a ' · ' with Chinese after it, which
  // is the exact shape processNode would cut.
  const po = cnCtx.finCatRow({ id: 3, date: '2026-08-05', amount: 640, source: 'po',
    po_number: 'RPO-0028', note: 'RPO-0028 · 天河供应商 · 3 lines', lines: 0 });
  const name = (po.match(/<span class="fin-catname">(.*?)<\/span>/) || [])[1] || '';
  const cut = name.indexOf(' · ');
  assert.ok(cut > 0 && /[一-鿿]/.test(name.slice(cut + 3)) && !/[一-鿿]/.test(name.slice(0, cut)),
    'the splittable description shape is gone — re-read why the guard exists before removing it');
  assert.ok(name.includes('3 lines'), 'the whole description must reach the row');
});

it('a channel line is NOT a control — nothing opens behind one', () => {
  // This file's own rule, stated on the expenses row and again on the PO row: a
  // chevron that opens onto nothing is a control that lies. There is no endpoint
  // behind a channel, so the lines take no chevron and are not buttons.
  const html = ctx.finRevBreakdown(REV_ROWS);
  assert.ok(!/<button/.test(html), 'a channel line must not be a button');
  assert.ok(!/fin-chev/.test(html), 'a chevron here would open onto nothing');
  assert.ok(!/aria-expanded/.test(html), 'nothing here expands');
});

it('nothing to disclose renders no disclosure at all', () => {
  // A period with no paid orders has no channels, and an older payload carries
  // no field — both fall back to the plain row revenue has always been.
  assert.strictEqual(ctx.finRevBreakdown([]), '');
  assert.strictEqual(ctx.finRevBreakdown(undefined), '');
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'), CLIENT.indexOf('async function finLoad'));
  assert.ok(/revBreakdown\s*\?[\s\S]*?:\s*finRow\(revLabel/.test(card),
    'the row must fall back to the plain one when there is nothing behind it');
});

it('the revenue row keeps an EMPTY sign column — it is the step, not a deduction', () => {
  // The staircase's signs are arithmetic. Revenue is what the column starts
  // from, so a minus beside it would stop the card adding up.
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'), CLIENT.indexOf('async function finLoad'));
  const rev = card.slice(card.indexOf('revBreakdown'), card.indexOf('d.tax'));
  assert.ok(/<span class="fin-sign"><\/span>/.test(rev), 'revenue must carry no sign');
  assert.ok(!/fin-sign">−/.test(rev), 'revenue is not a deduction');
});

it('revenue opens by default, exactly as the expenses row beside it does', () => {
  // The two are the same kind of thing — a total and the lines that make it up —
  // and a reader who found one openable and the other not would have to learn
  // which is which.
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'), CLIENT.indexOf('async function finLoad'));
  assert.strictEqual((card.match(/<details class="fin-exp" open>/g) || []).length, 2,
    'revenue and operating expenses must both open by default');
});

it('every channel name is COPIED from a live pair — none composed here', () => {
  /* The standing rule's first preference. Two sources, and which owns a key is
     not arbitrary: the PLATFORMS come from csName (01-core.js), the only one of
     the two carrying a Chinese half for them; the STAFF-KEYED ORIGINS come from
     ordChannelLabel (04-orders.js), which owns the New order form's answers.

     Each pair must still be present at its own source, so a rename there cannot
     leave two different words for one channel on two screens. */
  const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
  const ORDERS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
  const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
  const CUSTOMERS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '08-customers.js'), 'utf8');
  const fn = CLIENT.slice(CLIENT.indexOf('function finChannelLabel'),
                          CLIENT.indexOf('/* ── The revenue disclosure'));

  [['WeChat', '微信', CORE], ['Web shop', '网页商店', CORE],
   ['Meituan', '美团', CORE], ['Eleme', '饿了么', CORE],
   // Both sources carry this one; the dashboard's short table is the nearer.
   ['Shop', '门店', DASH],
   // The four origins the New order form writes, plus the legacy value.
   ['Pick up', '到店自取', ORDERS], ['WeChat message', '微信消息', ORDERS],
   ['Wholesale', '批发', ORDERS], ['Other', '其他', ORDERS],
   // `manual` is the one the orders list does NOT own — see the case below.
   // CU_CHAN_OPTS (08-customers.js) is a filter over this very column.
   ['Manual', '手动', CUSTOMERS],
  ].forEach(([en, cn, src]) => {
    assert.ok(fn.includes("'" + en + "', '" + cn + "'"),
      `the card no longer renders ${en} · ${cn}`);
    assert.ok(src.includes("'" + en + "'") && src.includes("'" + cn + "'"),
      `${en} · ${cn} is no longer live at its source — it would be composed here now`);
  });

  // gzgrocery is a bare string at its source too: the partner's name is the same
  // word in both languages, and pairing it here would be composing one.
  assert.ok(/gzgrocery:\s*'Gzgrocery'/.test(fn), 'gzgrocery must not be given an invented pair');
  assert.ok(CORE.includes("gzgrocery: 'Gzgrocery'"), 'the bare form is no longer live at its source');

  // EVERY ORIGIN THE FORM CAN WRITE HAS A LINE. routes/retail.js owns the list;
  // a fifth one added there without a label would reach this card as a raw key.
  const ROUTES = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  const origins = ROUTES.match(/const MANUAL_ORDER_ORIGINS\s*=\s*\[([^\]]*)\]/);
  assert.ok(origins, 'MANUAL_ORDER_ORIGINS is no longer where this test reads it');
  origins[1].match(/'([a-z_]+)'/g).map(q => q.slice(1, -1)).forEach(k => {
    assert.ok(new RegExp('\\b' + k + ':').test(fn),
      `the New order form can write '${k}' and the card has no name for it`);
  });
});

it('the legacy channel says Manual · 手动, and differs from the orders list KNOWINGLY', () => {
  /* DECIDED BY ASH, 2026-09-13, from the Chinese card with the row circled:
     "翻译有点小问题，manual，中文：手动、人工". Of the two words he named, 手动 is
     the one already live for THIS COLUMN — CU_CHAN_OPTS (08-customers.js) is a
     channel filter over retail_orders.channel and offers ['manual','Manual','手动'],
     and DASH_CHAN_SHORT (03-dashboard.js) names it the same way. 人工 is live
     only inside verification sentences (请人工核对), never as a channel name.

     ordChannelLabel (04-orders.js) calls the same value `Unattributed · 未归属`,
     and its reasoning is sound on its own terms — `manual` IS the legacy value,
     no longer selectable. It is one screen against three, and this card is not
     the place to try a new word. The orders list is deliberately left alone.

     BOTH SIDES ARE PINNED so a later session reads the note in 22-finance.js
     rather than "fixing" one into the other. */
  assert.strictEqual(ctx.finChannelLabel('manual'), 'Manual');
  const fn = CLIENT.slice(CLIENT.indexOf('function finChannelLabel'),
                          CLIENT.indexOf('/* ── The revenue disclosure'));
  assert.ok(/manual:\s*cuT\('Manual', '手动'\)/.test(fn), 'the card must read Manual · 手动');
  assert.ok(!/未归属/.test(fn), 'the card no longer carries the orders list word');
  // 人工 was the other word offered and is NOT used: it is live only as a
  // fragment inside "verify by hand", never as the name of a channel.
  assert.ok(!/人工/.test(fn), '人工 is not a channel name anywhere in this product');
  // The pair is live for this column, not merely near it.
  assert.ok(CUSTOMERS_SRC.includes("['manual', 'Manual',       '手动']"),
    'CU_CHAN_OPTS no longer offers Manual · 手动 for this column');
  // And the divergence is still a divergence — if the orders list ever adopts
  // the same word this case should be revisited rather than silently passing.
  assert.ok(ORDERS_SRC.includes("cuT('Unattributed', '未归属')"),
    'the orders list changed its mind about `manual` — re-read the note in 22-finance.js');
});

it('an unknown channel renders as itself rather than being folded or dropped', () => {
  // It is inside a total that counted it, so it has to appear. An internal word
  // on screen is a smaller wrong than money with no line under it.
  assert.strictEqual(ctx.finChannelLabel('tiktok'), 'tiktok');
  assert.ok(ctx.finRevBreakdown(REV_ROWS).includes('tiktok'));
});

it('the channel figures are WHOLE YUAN, like every other line of the staircase', () => {
  // §36's magnitude decision. Only what opens BELOW a breakdown line renders to
  // the fen; a breakdown line is one of its figures.
  const fn = CLIENT.slice(CLIENT.indexOf('function finRevBreakdown'),
                          CLIENT.indexOf('/** The operating-expense disclosure'));
  assert.ok(/finMoney\(/.test(fn) && !/finExact\(/.test(fn),
    'a channel line must use finMoney, not finExact');
});

// ── The house class and the wiring ─────────────────────────────────────────
console.log('\n4 · .td-notrec, and the surface it is wired into');

it('.td-notrec is defined once, on the td- prefix, in retail-admin.css', () => {
  const defs = CSS.match(/^\.td-notrec\s*\{/gm) || [];
  assert.strictEqual(defs.length, 1, `.td-notrec is defined ${defs.length} times`);
});

it('it carries no alarm colour, no icon and no retry control', () => {
  const block = CSS.slice(CSS.indexOf('.td-notrec {'));
  const body = block.slice(0, block.indexOf('}'));
  assert.ok(/var\(--td-raised\)/.test(body), 'cream ground');
  assert.ok(/var\(--td-text2\)/.test(body), 'graphite body text');
  assert.ok(/margin:\s*[^;]*-24px/.test(body), 'negative side margins bleed to the block edge');
  assert.ok(!/brick|amber|--td-[a-z]*-(tint|ink)/.test(body), '§1.10 — nothing here is in a state');
  assert.ok(!/content:/.test(body), 'no icon');
});

it('the range echo carries the class its own CSS targets', () => {
  // It shipped with `td-date` alone while the stylesheet targeted `.fin-echo`,
  // so `margin-left: auto` never applied and the echo sat against the title
  // instead of at the right edge the mockup puts it at (`.pg-echo`).
  assert.ok(/id="fin-range"[^>]*class=|class="[^"]*fin-echo[^"]*"[^>]*id="fin-range"/.test(HTML)
    || /<span class="[^"]*fin-echo[^"]*" id="fin-range"/.test(HTML),
    'the echo must carry fin-echo');
  assert.ok(/#tab-finance \.fin-echo\s*\{[^}]*margin-left:\s*auto/.test(CSS),
    'and the rule that right-aligns it must exist');
});

it('the New transaction CTA can actually be hidden on Summary', () => {
  // It shipped visible on Summary because `[hidden]` loses to `.btn { display:
  // inline-flex }` — an author rule beats the UA default. The section carries
  // the same !important override #sub-delivery already uses for this trap
  // (that selector was #tab-delivery until §79 moved the page into Settings).
  assert.ok(/#tab-finance \[hidden\]\s*\{\s*display:\s*none\s*!important/.test(CSS),
    'hidden must be enforced against the .btn display rule');
  assert.ok(/cta\.hidden = !isTx/.test(fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '22-finance.js'), 'utf8')),
    'and the sub-view must drive it');
});

it('the Finance surface is wired end to end', () => {
  assert.ok(/id="tab-finance"/.test(HTML), 'the section');
  assert.ok(/data-tab="finance"/.test(HTML), 'the rail row');
  // The rail's own gate is TAB_CAP in 01-core.js, not a data-cap attribute:
  // "If you ever move a page between rows, move its data-tab with it or the
  // page ships ungated." A row missing from that map is VISIBLE to everyone.
  const core = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
  const tabcap = core.slice(core.indexOf('const TAB_CAP = {'));
  assert.ok(/finance: 'finance:view'/.test(tabcap.slice(0, tabcap.indexOf('};'))),
    'the Finance rail row is not in TAB_CAP, so it ships ungated');
  assert.ok(/22-finance\.js/.test(HTML), 'the script tag');
  const caps = fs.readFileSync(path.join(ROOT, 'lib', 'capabilities.js'), 'utf8');
  assert.ok(/'finance:view'/.test(caps), 'the capability');
  assert.ok(/finance:\s*\['Finance', '财务'\]/.test(caps), 'the section label');
  assert.ok(/routes\/finance-summary/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'the mount');
});

it('the route is multi-tenant — tdb(), never the global handle', () => {
  assert.ok(/require\('\.\.\/lib\/tenant-db'\)/.test(ROUTE), 'must import tdb');
  assert.ok(/\btdb\(\)/.test(ROUTE), 'must call tdb()');
  assert.ok(!/require\('\.\.\/database'\)/.test(ROUTE),
    'routes/finance.js uses the global handle and is not a pattern to copy');
});

it('the sub-view strip ships now that there are two sub-views', () => {
  // This assertion is the inverse of the one it replaces. The Summary build
  // shipped NO strip, deliberately: "a strip with one tab names a screen the
  // operator cannot open". Transactions is now built, so the door opens and the
  // strip is correct — the rule never changed, only how many sub-views exist.
  const sec = HTML.slice(HTML.indexOf('id="tab-finance"'), HTML.indexOf('id="tab-sales"'));
  assert.ok(/id="fin-subviews"/.test(sec), 'the strip is missing');
  assert.ok(/data-sub="summary"/.test(sec) && /data-sub="transactions"/.test(sec),
    'both sub-views must be named on the strip');
});

/* ══════════════════════════════════════════════════════════════════════════
   5 · THE CATEGORY DRILL-DOWN — the list adds up to the line it opened from.

   The endpoint exists for exactly one guarantee: tap ¥27,081 and the rows that
   appear total ¥27,081. Everything below tests that guarantee against the ways
   it is easy to lose, each of which was a real option while it was built.

   THE SQL IS SLICED OUT OF THE SHIPPED ROUTE, not restated here. A test that
   re-typed the query would pass on its own copy while the route drifted, which
   on this endpoint means passing while the two numbers disagree — the single
   thing it is for.
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n5 · the category drill-down — the detail equals the line');

/** The shipped grouped query, with LEDGER_DATE resolved. */
function shippedGrouped() {
  const m = ROUTE.match(/const grouped = db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the breakdown query is no longer where the test reads it');
  return m[1].replace(/\$\{LEDGER_DATE\}/g, EDATE);
}
/** The shipped detail query, for one of its two category branches. */
function shippedDetail(uncategorised) {
  const m = ROUTE.match(/const rows = db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the detail query is no longer where the test reads it');
  const branch = m[1].match(/\$\{uncategorised \? "([^"]*)" : '([^']*)'\}/);
  assert.ok(branch, 'the detail query no longer branches on the uncategorised bucket');
  return m[1]
    .replace(/\$\{LEDGER_DATE\}/g, EDATE)
    .replace(branch[0], uncategorised ? branch[1] : branch[2]);
}

const cdb = new Database(':memory:');
cdb.exec(`
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT,
    description TEXT, po_id INTEGER, claim_id INTEGER);
  CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY, po_number TEXT, date DATE, scope TEXT);
  CREATE TABLE staff_expenses (id INTEGER PRIMARY KEY, paid_by TEXT);
`);
cdb.prepare("INSERT INTO purchase_orders VALUES (50,'PO-0050','2026-08-22','kitchen')").run();
cdb.prepare("INSERT INTO purchase_orders VALUES (51,'PO-0051','2026-08-28','retail')").run();
cdb.prepare("INSERT INTO staff_expenses VALUES (9,'employee')").run();

const ING = 'Ingredients(Kitchen+Retail Use)';
const ins = cdb.prepare('INSERT INTO expense_entries VALUES (?,?,?,?,?,?,?)');
// The worked example from the brief: ONE category, three provenances, and a
// purchase order that bought it on two lines.
ins.run(1, '2026-08-14', 3000, ING, 'cash and carry', null, null);
ins.run(2, '2026-08-20', 2000, ING, 'taxi to market', null, 9);
ins.run(3, '2026-08-22', 12000, ING, 'dry goods', 50, null);
ins.run(4, '2026-08-22', 8000, ING, 'produce', 50, null);
ins.run(5, '2026-08-28', 2081, ING, null, 51, null);
// The two spellings lib/category-text.js resolves for the FLAG and pointedly
// does not merge for display. Two lines on the card; two separate lists.
ins.run(6, '2026-08-05', 700, 'Office Supplies', null, null, null);
ins.run(7, '2026-08-06', 300, 'Office  Supplies', null, null, null);
// The uncategorised bucket, arriving as both of the two things SQLite groups
// apart and the screen draws the same.
ins.run(8, '2026-08-07', 40, null, 'unlabelled', null, null);
ins.run(9, '2026-08-08', 10, '', 'also unlabelled', null, null);
// Outside the window entirely.
ins.run(10, '2026-07-31', 9999, ING, 'last month', null, null);
// §269: the drill-down reads which rows are returns. Added after the positional
// inserts above so they keep their shape.
cdb.exec('ALTER TABLE expense_entries ADD COLUMN returns_entry_id INTEGER; ALTER TABLE expense_entries ADD COLUMN returns_claim_id INTEGER;');

const CFROM = '2026-08-01', CTO = '2026-08-31';
const cGrouped = cdb.prepare(shippedGrouped()).all(CFROM, CTO);
const detailFor = (cat) => (cat === null
  ? cdb.prepare(shippedDetail(true)).all(CFROM, CTO)
  : cdb.prepare(shippedDetail(false)).all(CFROM, CTO, cat));

it('EVERY line of the breakdown equals the rows behind it', () => {
  // The whole feature, asserted over every category at once rather than the one
  // that happened to be interesting. A future edit that reshapes either query
  // fails here on whichever line it moved.
  assert.ok(cGrouped.length >= 4, 'the fixture stopped exercising several categories');
  for (const g of cGrouped) {
    const rows = detailFor(g.category);
    const total = rows.reduce((t, r) => t + r.amount, 0);
    assert.strictEqual(total, g.amount,
      `the detail for ${JSON.stringify(g.category)} totals ${total}, the card says ${g.amount}`);
    assert.strictEqual(rows.length, g.n, `row count disagrees for ${JSON.stringify(g.category)}`);
  }
});

it('a purchase order is listed per ROW, never collapsed to one line', () => {
  // The failure the endpoint exists to avoid: `readTransactions` collapses these
  // two into one PO-0050 row carrying no category at all, which is why the
  // Transactions list cannot answer this question.
  const rows = detailFor(ING);
  assert.strictEqual(rows.length, 5, 'the five ingredient rows must all be listed');
  assert.strictEqual(rows.filter(r => r.po_id === 50).length, 2,
    'PO-0050 bought this category on two lines and both are inside the figure');
  assert.strictEqual(rows.reduce((t, r) => t + r.amount, 0), 27081);
});

it('the three provenances survive the read', () => {
  const rows = detailFor(ING);
  const by = (f) => rows.filter(f).length;
  assert.strictEqual(by(r => r.po_id), 3, 'PO-posted rows');
  assert.strictEqual(by(r => r.claim_id), 1, 'claim-posted rows');
  assert.strictEqual(by(r => !r.po_id && !r.claim_id), 1, 'hand-typed rows');
  // The claim's own paid_by rides along — the difference between a cost that is
  // finished and one the shop still owes somebody.
  assert.strictEqual(rows.find(r => r.claim_id).paid_by, 'employee');
  // The PO number, so the row can say which purchase it came from…
  assert.strictEqual(rows.find(r => r.po_id === 50).po_number, 'PO-0050');
  // …and the scope, because Purchasing's opener serves retail only (§36).
  assert.strictEqual(rows.find(r => r.po_id === 50).po_scope, 'kitchen');
  assert.strictEqual(rows.find(r => r.po_id === 51).po_scope, 'retail');
});

it('the LEFT joins report provenance and never filter on it', () => {
  // An inner join on either would drop rows out of a total that counted them —
  // a PO deleted after its expenses posted would take its yuan off this list and
  // leave them on the line above.
  const sql = shippedDetail(false);
  assert.ok(/LEFT JOIN purchase_orders/.test(sql), 'purchase_orders must be a LEFT join');
  assert.ok(/LEFT JOIN staff_expenses/.test(sql), 'staff_expenses must be a LEFT join');
});

it("the empty string and NULL are ONE uncategorised line, not two", () => {
  // SQLite groups '' and NULL apart while the payload maps both to null and the
  // screen draws both as "Not recorded" — so before NULLIF this rendered two
  // identical lines with different figures, and the drill-down had two buckets
  // to disagree with. 40 + 10.
  const blank = cGrouped.filter(g => g.category === null);
  assert.strictEqual(blank.length, 1, 'the uncategorised bucket must be one line');
  assert.strictEqual(blank[0].amount, 50);
  assert.strictEqual(detailFor(null).reduce((t, r) => t + r.amount, 0), 50);
});

it('NULLIF folds only the empty string — spacing is left alone', () => {
  // TRIM here would merge ' Ingredients' onto 'Ingredients' and decide a
  // question about typography that lib/category-text.js deliberately refuses to.
  const g = shippedGrouped();
  assert.ok(/NULLIF\(category, ''\)/.test(g), 'the fold must be NULLIF on the empty string');
  assert.ok(!/TRIM\(/i.test(g), 'the breakdown must not trim category text');
});

it('two spellings stay two lines, and each opens onto its own rows', () => {
  // §87's flag resolution matches these on `spacingKey`; the BREAKDOWN does not,
  // and a detail read keyed on spacingKey would gather both spellings under
  // either line and overshoot the figure that was clicked.
  const a = cGrouped.find(g => g.category === 'Office Supplies');
  const b = cGrouped.find(g => g.category === 'Office  Supplies');
  assert.ok(a && b, 'the two spellings must remain two lines of the card');
  assert.strictEqual(detailFor('Office Supplies').reduce((t, r) => t + r.amount, 0), 700);
  assert.strictEqual(detailFor('Office  Supplies').reduce((t, r) => t + r.amount, 0), 300);
});

it('the detail read is not capped — a capped list does not add up', () => {
  const sql = shippedDetail(false);
  assert.ok(!/\bLIMIT\b/i.test(sql),
    'a LIMIT here trades the one guarantee this endpoint makes for a ceiling');
});

it('the drill-down endpoint is admin-gated and multi-tenant, like the summary', () => {
  // Sliced from the router.get, NOT from the first mention of the path — the
  // header comment above it names the route too, and a slice that started there
  // would test the prose rather than the handler.
  const at = ROUTE.indexOf("router.get('/api/retail-admin/finance/summary/category'");
  assert.notStrictEqual(at, -1, 'the drill-down route is not mounted');
  const handler = ROUTE.slice(at, ROUTE.indexOf('\n});', at));
  assert.ok(/requireRetailAdmin/.test(handler.slice(0, handler.indexOf('=>'))),
    'the route must carry requireRetailAdmin');
  assert.ok(/\btdb\(\)/.test(handler), 'the handler must read through tdb()');
  assert.ok(!/require\('\.\.\/database'\)/.test(handler), 'never the global handle');
});

console.log('\n6 · the drill-down on screen');

it('each breakdown line is a control that opens its own rows', () => {
  assert.ok(/class="fin-row fin-cat/.test(CLIENT_CODE), 'the line must render as a control');
  assert.ok(/onclick="finCatOpen\(/.test(CLIENT_CODE), 'and it must open the category');
  assert.ok(/aria-expanded=/.test(CLIENT_CODE), 'a disclosure states whether it is open');
  assert.ok(/window\.finCatOpen = function/.test(CLIENT_CODE), 'the handler must be published');
});

it('the drill-down reads the APPLIED window, never the date inputs', () => {
  // The inputs can hold a range that was typed and not applied. Reading them
  // here would open a figure onto rows from a different month — the exact class
  // of quiet wrongness this feature removes.
  const fn = CLIENT_CODE.slice(CLIENT_CODE.indexOf('window.finCatOpen'));
  const body = fn.slice(0, fn.indexOf('\n};'));
  assert.ok(/FIN_DATA && FIN_DATA\.window/.test(body), 'the window must come from the payload');
  assert.ok(!/getElementById\('fin-(from|to)'\)/.test(body),
    'the date inputs are not the window this card is showing');
});

it('the open category is dropped when the window changes', () => {
  const fn = CLIENT_CODE.slice(CLIENT_CODE.indexOf('async function finLoad'));
  assert.ok(/FIN_CAT = null;/.test(fn.slice(0, fn.indexOf('finRender();'))),
    'a new window must not leave one window’s rows under another window’s figure');
});

it('the drill-down composes NO new Chinese — every pair is already live here', () => {
  // Rule 4, as amended 2026-09-06: composing is delegated, composing SILENTLY is
  // not. Nothing is composed, so nothing is owed to the vocabulary — and that is
  // checked rather than asserted in a commit message. Each of these ships on the
  // Transactions or Approvals sub-view of this same file for the same fact.
  for (const cn of ['采购单自动记入', '费用申请 · 个人支付', '费用申请',
                    '加载中…', '暂无记录', '财务数据加载失败。']) {
    const n = CLIENT.split(cn).length - 1;
    assert.ok(n >= 2, `${cn} is used once — it would be a new pair, not a reuse`);
  }
});

it('the rows sit on the card’s own figure column', () => {
  // A reader checking that the list sums to the line above is the reason the
  // list exists; figures that do not line up under it cannot be checked.
  const block = CSS.slice(CSS.indexOf('#tab-finance .fin-catrow {'));
  assert.ok(/grid-template-columns: 62px 1fr 104px/.test(block.slice(0, 200)),
    'the detail figures must share the staircase’s 104px column');
});

/* The three categories the render is driven over: one operating line with rows
   behind it, one the operator has not opened, and the uncategorised bucket. */
const CROWS = [
  { category: ING, amount: 27081, entries: 5, is_operating: 1 },
  { category: 'Rent', amount: 800, entries: 1, is_operating: 1 },
  { category: null, amount: 50, entries: 2, is_operating: 1 },
];
const CDETAIL = [
  // The note on a PO row is what the poster wrote, and it ALREADY LEADS WITH THE
  // PO NUMBER — `${po_number}${supplier ? ' · ' + supplier : ''} · N line(s)`,
  // identically in postRetailPOExpenses and postPOExpenses. The fixture carries
  // that real shape, because a fixture with a bare note is what let the screen
  // print the number twice.
  { id: 5, date: '2026-08-28', amount: 2081, note: null, source: 'po', po_id: 51, po_number: 'PO-0051', po_open: true, claim_id: null, paid_by: null },
  { id: 4, date: '2026-08-22', amount: 8000, note: 'PO-0050 · 2 lines', source: 'po', po_id: 50, po_number: 'PO-0050', po_open: false, claim_id: null, paid_by: null },
  { id: 3, date: '2026-08-22', amount: 12000, note: 'PO-0050 · 2 lines', source: 'po', po_id: 50, po_number: 'PO-0050', po_open: false, claim_id: null, paid_by: null },
  { id: 2, date: '2026-08-20', amount: 2000, note: 'taxi to market', source: 'claim', po_id: null, po_number: null, po_open: null, claim_id: 9, paid_by: 'employee' },
  { id: 1, date: '2026-08-14', amount: 3000, note: 'cash and carry', source: 'manual', po_id: null, po_number: null, po_open: null, claim_id: null, paid_by: null },
];
const drawn = (open) => {
  ctx.__finSet({ window: { from: '2026-08-01', to: '2026-08-31' }, expense_breakdown: CROWS }, open);
  return ctx.finBreakdown(CROWS, CROWS);
};

it('a closed line is a control and shows no rows', () => {
  const html = drawn(null);
  assert.strictEqual((html.match(/class="fin-row fin-cat/g) || []).length, 3,
    'every line of the breakdown is a control');
  assert.ok(/aria-expanded="false"/.test(html), 'and says it is closed');
  assert.ok(!/fin-catrows/.test(html), 'nothing is disclosed until one is opened');
  // The figures are untouched by the change — this is still the breakdown.
  assert.ok(/<span class="fin-fig">¥27,081<\/span>/.test(html));
});

it('an opened line discloses its rows, and only that line', () => {
  const html = drawn({ i: 0, rows: CDETAIL, err: '' });
  assert.strictEqual((html.match(/fin-catrows/g) || []).length, 1, 'one line opens at a time');
  assert.strictEqual((html.match(/aria-expanded="true"/g) || []).length, 1);
  assert.strictEqual((html.match(/class="fin-catrow"/g) || []).length, 5, 'all five rows');
  // PO-0050 twice: one purchase that bought this category on two lines. The
  // Transactions tab draws that as ONE row with no category, which is why this
  // list cannot be borrowed from it.
  assert.strictEqual((html.match(/PO-0050/g) || []).length, 2);
  // ONCE PER ROW, NEVER TWICE. The poster's description already leads with the
  // number; the screen shipped prepending it again and drew
  // `RPO-0028 · RPO-0028 · 1 line` on the live card.
  assert.ok(!/PO-0050 · PO-0050/.test(html),
    'the PO number is in the description already — printing it twice is the bug this asserts against');
  // The description is rendered WHOLE, not rebuilt from parts.
  assert.ok(/PO-0050 · 2 lines/.test(html), 'the poster owns that sentence and the row renders it');
  // Each provenance says what it is, in the words Transactions already uses.
  assert.ok(/Posted by Purchasing/.test(html), 'the PO mark');
  assert.ok(/Staff claim · own money/.test(html), 'the claim mark, with whose money it was');
  // A typed row carries no mark at all — the same silence Transactions keeps.
  assert.ok(/cash and carry/.test(html));
  // And the rows add up to the line they hang under.
  assert.strictEqual(CDETAIL.reduce((t, r) => t + r.amount, 0), CROWS[0].amount);
});

it('a PO row with no description falls back to the bare number', () => {
  // Defensive: both posters always write one. If a row somehow arrives without,
  // the number is better than an empty cell — but it is the FALLBACK, never the
  // prefix.
  const html = drawn({ i: 0, rows: [{ id: 9, date: '2026-08-30', amount: 5, note: null, source: 'po', po_id: 51, po_number: 'PO-0051', claim_id: null, paid_by: null }], err: '' });
  assert.ok(/PO-0051/.test(html), 'a PO row must still say which purchase it was');
  assert.ok(!/PO-0051 · PO-0051/.test(html));
});

it('a row with nothing typed on it draws its date and its figure, and no filler', () => {
  const html = drawn({ i: 0, rows: [{ id: 7, date: '2026-08-09', amount: 12, note: null, source: 'manual', po_id: null, po_number: null, claim_id: null, paid_by: null }], err: '' });
  assert.ok(/class="fin-catdate"/.test(html) && /¥12/.test(html));
  assert.ok(!/fin-catname/.test(html), '§1.12 prefers an empty cell to an invented one');
  assert.ok(!/fin-catmark/.test(html), 'a typed row has no provenance to announce');
});

it('loading, empty and failed each say so on one line', () => {
  assert.ok(/Loading…/.test(drawn({ i: 0, rows: null, err: '' })));
  assert.ok(/Nothing recorded yet/.test(drawn({ i: 0, rows: [], err: '' })));
  const failed = drawn({ i: 0, rows: null, err: 'Could not load Finance.' });
  assert.ok(/Could not load Finance\./.test(failed));
  assert.ok(!/Loading…/.test(failed), 'a failed read must stop claiming to be loading');
});

it('the uncategorised line opens too, and keeps its seventh-state word', () => {
  const html = drawn({ i: 2, rows: [], err: '' });
  assert.ok(/Not recorded/.test(html), 'the null category keeps its own line and word');
  assert.strictEqual((html.match(/aria-expanded="true"/g) || []).length, 1,
    'a line with no category name is still a line an operator can open');
});

/* ══════════════════════════════════════════════════════════════════════════
   7 · THE PURCHASE-ORDER LINES — the items equal the row they opened from.

   §88's rule, one level down: a purchase order posts ONE EXPENSE ROW PER
   CATEGORY, so the items behind a row are the order's lines IN THAT CATEGORY,
   never the whole order. Listing the order would show a list that does not add
   up to the figure clicked — the same defect the level above exists to avoid.
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n7 · the purchase-order lines — the items equal the row');

function shippedPoLines() {
  const m = ROUTE.match(/const lines = db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the po-lines query is no longer where the test reads it');
  const caseM = ROUTE.match(/const PO_CATEGORY_CASE = \([^)]*\) =>\s*`([\s\S]*?)`;/);
  assert.ok(caseM, 'the per-realm category expression has moved');
  const cat = caseM[1].replace(/\$\{line\}/g, 'l').replace(/\$\{po\}/g, 'po');
  const billable = (a) => `MAX(0, COALESCE(${a}.qty_received, ${a}.qty) - COALESCE(${a}.returned_qty, 0))`;
  return m[1]
    .replace(/\$\{billableQtySql\('l'\)\}/g, billable('l'))
    .replace(/\$\{PO_CATEGORY_CASE\('l', 'po'\)\}/g, cat);
}

const pdb = new Database(':memory:');
pdb.exec(`
  CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, po_number TEXT, date DATE, scope TEXT);
  CREATE TABLE po_line_items (
    id INTEGER PRIMARY KEY, po_id INTEGER, name_en TEXT, name_cn TEXT, sku TEXT,
    qty REAL, qty_received REAL, returned_qty REAL, unit TEXT,
    cost_per_unit REAL, expense_category TEXT, sort_order INTEGER);
`);
pdb.prepare("INSERT INTO purchase_orders VALUES (17,'RPO-0017','2026-08-18','retail')").run();
pdb.prepare("INSERT INTO purchase_orders VALUES (60,'PO-0060','2026-08-19','kitchen')").run();
const RETAIL_ONLY = 'Retail-Only Goods(Not Used in Kitchen)';
const pl = pdb.prepare('INSERT INTO po_line_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
// RPO-0017 buys THREE categories. Only the Retail-Only three are the ¥1,230.
pl.run(1, 17, 'Glass jars 250ml', '玻璃罐250毫升', 'JAR250', 200, null, null, 'pc', 3.50, RETAIL_ONLY, 1);
pl.run(2, 17, 'Kraft labels', '牛皮纸标签', 'LBL', 500, null, null, 'pc', 0.66, RETAIL_ONLY, 2);
pl.run(3, 17, 'Ribbon 20m', null, 'RIB', 10, null, null, 'roll', 20.00, RETAIL_ONLY, 3);
pl.run(4, 17, 'Chickpeas', '鹰嘴豆', 'CHK', 40, null, null, 'kg', 12.00, 'Ingredients(Kitchen+Retail Use)', 4);
pl.run(5, 17, 'Cling film', null, 'CLF', 5, null, null, 'roll', 9.00, 'Packaging Materials', 5);
// A line PARTLY RETURNED: billed for 8 of 10, so ¥80 not ¥100.
pl.run(6, 17, 'Gift boxes', null, 'BOX', 10, 10, 2, 'pc', 10.00, RETAIL_ONLY, 6);
// A line FULLY returned drops out entirely.
pl.run(7, 17, 'Wrong item', null, 'WRG', 4, 4, 4, 'pc', 50.00, RETAIL_ONLY, 7);
// A blank category on each realm — the two posters give them DIFFERENT names.
pl.run(8, 17, 'Unlabelled retail', null, null, 2, null, null, 'pc', 5.00, '  ', 8);
pl.run(9, 60, 'Unlabelled kitchen', null, null, 3, null, null, 'pc', 7.00, null, 9);

const poLinesFor = (poId, category) =>
  pdb.prepare(shippedPoLines()).all(poId, '门店进货 Retail stock', '未分类 Uncategorized', category);

it('the items are the CATEGORY’s slice of the order, never the whole order', () => {
  const rows = poLinesFor(17, RETAIL_ONLY);
  // 200×3.50 + 500×0.66 + 10×20 + 8×10 = 700 + 330 + 200 + 80
  assert.strictEqual(rows.length, 4, 'four billable Retail-Only lines');
  assert.strictEqual(rows.reduce((t, r) => t + r.amount, 0), 1310);
  // The order's OTHER categories must not appear — that is the whole trap.
  assert.ok(!rows.some(r => /Chickpeas|Cling film/.test(r.name_en)),
    'a line posted under another category is inside another figure');
});

it('a returned line is billed for what is owed, and a fully returned one is gone', () => {
  const rows = poLinesFor(17, RETAIL_ONLY);
  const box = rows.find(r => r.name_en === 'Gift boxes');
  assert.strictEqual(box.qty, 8, 'ten arrived, two went back');
  assert.strictEqual(box.amount, 80, 'a reader using qty would price this at 100');
  assert.ok(!rows.some(r => r.name_en === 'Wrong item'),
    'a fully returned line is billed for nothing and is not in the figure above');
});

it('the blank-category fallback follows the ORDER’S REALM, not one hardcoded name', () => {
  // Both realms post into this one ledger and are told apart only by scope.
  // Binding either label across a mixed read files the other realm's blank
  // lines under a name they were never posted with.
  const retail = poLinesFor(17, '门店进货 Retail stock');
  assert.strictEqual(retail.length, 1);
  assert.strictEqual(retail[0].name_en, 'Unlabelled retail');
  const kitchen = poLinesFor(60, '未分类 Uncategorized');
  assert.strictEqual(kitchen.length, 1);
  assert.strictEqual(kitchen[0].name_en, 'Unlabelled kitchen');
  // And crossed, each finds nothing.
  assert.strictEqual(poLinesFor(17, '未分类 Uncategorized').length, 0);
  assert.strictEqual(poLinesFor(60, '门店进货 Retail stock').length, 0);
});

it('the two fallback labels still match what the posters actually write', () => {
  /* THE LITERALS ARE COPIED INTO THE READER, and this is what holds them there.
     Lifting them into a shared module would mean editing two posters that WRITE
     MONEY inside a change that only reads; copying them and testing the copy
     buys the drift protection without touching the write path. If either poster
     changes its fallback, this fails and names the file. */
  const retailPoster = fs.readFileSync(path.join(ROOT, 'routes', 'retail-purchasing.js'), 'utf8');
  const kitchenPoster = fs.readFileSync(path.join(ROOT, 'routes', 'purchases.js'), 'utf8');
  const declared = ROUTE.match(/const PO_CATEGORY_FALLBACK = \{([\s\S]*?)\};/);
  assert.ok(declared, 'the fallback pair has moved');
  assert.ok(/retail: '门店进货 Retail stock'/.test(declared[1]));
  assert.ok(/kitchen: '未分类 Uncategorized'/.test(declared[1]));
  assert.ok(retailPoster.includes("NULLIF(TRIM(expense_category),''),'门店进货 Retail stock'"),
    'postRetailPOExpenses no longer falls back to the label the reader copied');
  assert.ok(kitchenPoster.includes("NULLIF(TRIM(expense_category),''),'未分类 Uncategorized'"),
    'postPOExpenses no longer falls back to the label the reader copied');
});

it('the billable-quantity rule is REFERENCED from lib/po-returns, never restated', () => {
  assert.ok(/require\('\.\.\/lib\/po-returns'\)/.test(ROUTE), 'must import the one rule');
  assert.ok(!/qty_received/.test(ROUTE_CODE),
    'spelling the expression out here is a second copy that will drift from returns');
});

it('the row is addressed by its LEDGER ID, and a non-PO row cannot resolve', () => {
  // Passing (po_id, category) would let a caller ask for a combination no row
  // was posted for and get a plausible list totalling a figure on no screen.
  const at = ROUTE.indexOf("router.get('/api/retail-admin/finance/summary/po-lines'");
  assert.notStrictEqual(at, -1, 'the po-lines route is not mounted');
  const handler = ROUTE.slice(at, ROUTE.indexOf('\n});', at));
  assert.ok(/req\.query\.entry_id/.test(handler), 'the request is one ledger id');
  assert.ok(/e\.po_id IS NOT NULL/.test(handler),
    'a typed or claim-posted row has no purchase order and must not resolve to one');
  assert.ok(/requireRetailAdmin/.test(handler.slice(0, handler.indexOf('=>'))), 'admin-gated');
  assert.ok(/\btdb\(\)/.test(handler), 'multi-tenant');
  // The category comes off the ROW, never off the request.
  assert.ok(/entry\.category/.test(handler) && !/req\.query\.category/.test(handler),
    'the category must be read from the ledger row, not accepted from the caller');
});

console.log('\n8 · the purchase-order lines on screen');

const POL = [
  { id: 1, name_en: 'Glass jars 250ml', name_cn: '玻璃罐250毫升', sku: 'JAR250', qty: 200, unit: 'pc', unit_cost: 3.5, amount: 700 },
  { id: 3, name_en: 'Ribbon 20m', name_cn: null, sku: 'RIB', qty: 10, unit: 'roll', unit_cost: 20, amount: 200 },
];
const CROWS_PO = [{ category: RETAIL_ONLY, amount: 1310, entries: 2, is_operating: 1 }];
const drawnPo = (cat, pol) => {
  ctx.__finSet({ window: { from: '2026-08-01', to: '2026-08-31' }, expense_breakdown: CROWS_PO }, cat, pol);
  return ctx.finBreakdown(CROWS_PO, CROWS_PO);
};
const PO_ROW = { id: 42, date: '2026-08-18', amount: 1310, note: 'RPO-0017 · 3 lines', source: 'po', po_id: 17, po_number: 'RPO-0017', claim_id: null, paid_by: null, lines: 3 };
const FEES_ROW = { id: 43, date: '2026-08-18', amount: 90, note: 'RPO-0017 · shipping & fees', source: 'po', po_id: 17, po_number: 'RPO-0017', claim_id: null, paid_by: null, lines: 0 };

it('a PO row with items is a control; the landed-cost row is not', () => {
  const html = drawnPo({ i: 0, rows: [PO_ROW, FEES_ROW], err: '' }, null);
  assert.strictEqual((html.match(/class="fin-catrow fin-pol/g) || []).length, 1,
    'only the row with line items opens');
  assert.ok(/shipping & fees/.test(html), 'the fees row still renders and still counts');
  assert.ok(/onclick="finPoLines\(42\)/.test(html), 'and it is addressed by its ledger id');
});

it('an opened PO row lists its items, and the items total the row', () => {
  const html = drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: POL, err: '' });
  assert.strictEqual((html.match(/class="fin-polrow"/g) || []).length, 2);
  assert.ok(/Glass jars 250ml/.test(html) && /Ribbon 20m/.test(html));
  // The arithmetic behind each figure is on the row, so a line that looks wrong
  // can be read rather than only disbelieved.
  // A PRICE, NOT A ROUNDED ONE. finMoney would have drawn this ¥3.50 jar as ¥4.
  assert.ok(/200 pc × ¥3\.50/.test(html), 'quantity, unit and the real unit cost');
  assert.ok(!/× ¥4\b/.test(html), 'a whole-yuan unit price is a lie about the invoice');
  assert.ok(/10 roll × ¥20\.00/.test(html), 'and it holds where the price is exact');
  assert.ok(/¥700/.test(html) && /¥200/.test(html));
  assert.strictEqual(POL.reduce((t, r) => t + r.amount, 0), 900);
});

it('the item name follows the language, with a fallback across', () => {
  // The house pattern for bilingual DATA (tmStoreLabel) — NOT finCatLabel,
  // which splits one glued free-text value, which an item name is not.
  const en = drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: POL, err: '' });
  assert.ok(/Glass jars 250ml/.test(en) && !/玻璃罐/.test(en), 'the English surface shows English');
  ctx.cuLang = () => 'cn';
  const cn = drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: POL, err: '' });
  assert.ok(/玻璃罐250毫升/.test(cn), 'the Chinese surface shows Chinese');
  assert.ok(/Ribbon 20m/.test(cn), 'a line with no Chinese half falls back across, never to blank');
  ctx.cuLang = () => 'en';
});

it('the third level says loading, empty and failed the same way the second does', () => {
  assert.ok(/Loading…/.test(drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: null, err: '' })));
  assert.ok(/Nothing recorded yet/.test(drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: [], err: '' })));
  assert.ok(/Could not load Finance\./.test(
    drawnPo({ i: 0, rows: [PO_ROW], err: '' }, { id: 42, rows: null, err: 'Could not load Finance.' })));
});

it('closing the category drops the open PO row with it', () => {
  const fn = CLIENT_CODE.slice(CLIENT_CODE.indexOf('window.finCatOpen'));
  const body = fn.slice(0, fn.indexOf('\n};'));
  assert.ok(/FIN_POL = null/.test(body),
    'a row nothing is drawing must not be left open underneath');
  const load = CLIENT_CODE.slice(CLIENT_CODE.indexOf('async function finLoad'));
  assert.ok(/FIN_POL = null;/.test(load.slice(0, load.indexOf('finRender();'))),
    'and a new window drops it too');
});

it('the third level composes NO new Chinese either', () => {
  for (const cn of ['加载中…', '暂无记录', '财务数据加载失败。']) {
    assert.ok(CLIENT.split(cn).length - 1 >= 3,
      `${cn} must be the pair already live on the two levels above`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   9 · THE PRECISION BOUNDARY — whole yuan on the staircase, fen below it.

   Reported by Ash from the live card, and the reason is arithmetic rather than
   taste. Rounding each line to whole yuan shifts it by up to half a yuan, and
   the errors accumulate: four real lines totalling ¥259.40 draw as 53 + 48 +
   146 + 13 = 260 under a row drawing 259. Two whole numbers a yuan apart, over
   the same rows, with nothing on screen to explain it.

   §88's own note first recorded the opposite — "the card renders whole yuan so
   it does not surface" — which is backwards: whole yuan is what CREATES the
   drift. Corrected in the decisions record; asserted here.
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n9 · the precision boundary');

// Ash's four lines, at their real amounts.
const REAL = [
  { id: 1, name_en: 'Isolation Bag 4 #2mm', name_cn: null, qty: 60, unit: 'pcs', unit_cost: 0.88, amount: 52.80 },
  { id: 2, name_en: 'Isolation Bag 5 #2mm', name_cn: null, qty: 70, unit: 'pcs', unit_cost: 0.68, amount: 47.60 },
  { id: 3, name_en: 'Foam Box #3', name_cn: null, qty: 40, unit: 'pcs', unit_cost: 3.64, amount: 145.60 },
  { id: 4, name_en: 'Carton Box #8', name_cn: null, qty: 20, unit: 'pcs', unit_cost: 0.67, amount: 13.40 },
];
const REAL_ROW = { id: 77, date: '2026-08-18', amount: 259.40, note: 'RPO-0017 · 4 lines',
  source: 'po', po_id: 17, po_number: 'RPO-0017', claim_id: null, paid_by: null, lines: 4 };
const CROWS_REAL = [{ category: 'Packaging Materials', amount: 3628, entries: 9, is_operating: 1 }];
const drawnReal = (pol) => {
  ctx.__finSet({ window: { from: '2026-08-01', to: '2026-08-31' }, expense_breakdown: CROWS_REAL },
    { i: 0, rows: [REAL_ROW], err: '' }, pol);
  return ctx.finBreakdown(CROWS_REAL, CROWS_REAL);
};
// Every ¥ figure the drill-down draws, in order.
const figures = (html) => (html.match(/¥[\d,]+(?:\.\d+)?/g) || []);

it('the items DISPLAYED sum to the row DISPLAYED — exactly', () => {
  const html = drawnReal({ id: 77, rows: REAL, err: '' });
  for (const want of ['¥52.80', '¥47.60', '¥145.60', '¥13.40', '¥259.40']) {
    assert.ok(html.includes(want), `the card must draw ${want}`);
  }
  // The arithmetic a reader would do on screen, done on screen.
  const shown = REAL.map(r => Number(('' + ctx.acMoney(r.amount)).replace(/[^\d.]/g, '')));
  assert.strictEqual(shown.reduce((a, b) => a + b, 0).toFixed(2), '259.40');
  // And what the old whole-yuan rendering would have drawn instead.
  const whole = REAL.map(r => Math.round(r.amount)).reduce((a, b) => a + b, 0);
  assert.strictEqual(whole, 260, 'the fixture must keep exercising the drift');
  assert.ok(!html.includes('>¥260<'), 'that ¥260 is exactly what this change removes');
});

it('the staircase and the category lines are UNTOUCHED — still whole yuan', () => {
  // §36 decided the magnitude of these, and the fen on ¥37,942 is noise. The
  // change is confined to what opens BELOW a breakdown line.
  const html = drawnReal(null);
  assert.ok(/<span class="fin-fig">¥3,628<\/span>/.test(html),
    'the category line keeps whole yuan');
  assert.ok(!/fin-fig">¥3,628\.00/.test(html), 'and must not gain decimals');
});

it('finExact is used below the breakdown line, and finMoney at and above it', () => {
  // Stated as code rather than as a convention somebody has to remember.
  const cat = CLIENT_CODE.slice(CLIENT_CODE.indexOf('function finCatRow'));
  assert.ok(/fin-catfig[^`]*finExact/.test(cat.slice(0, cat.indexOf('\n}'))),
    'an expense row inside a category renders the real amount');
  const pol = CLIENT_CODE.slice(CLIENT_CODE.indexOf('function finPolRow'));
  assert.ok(/fin-polfig[^`]*finExact/.test(pol.slice(0, pol.indexOf('\n}'))),
    'so does a purchase-order item');
  const brk = CLIENT_CODE.slice(CLIENT_CODE.indexOf('function finBreakdown'));
  assert.ok(/fin-fig[^`]*finMoney/.test(brk.slice(0, brk.indexOf('\n}'))),
    'the breakdown line itself stays on the staircase’s own magnitude');
  assert.ok(/function finExact/.test(CLIENT_CODE) && /acMoney\(/.test(CLIENT_CODE),
    'and the exact form goes through acMoney, 01-core’s reconcilable-figure rule');
});

it('a wide exact figure cannot wrap out of its column', () => {
  // `¥1,145,600.00` is thirteen characters in a column sized for `Not recorded`.
  // Right-aligned figures that wrap stop lining up, which is the one thing the
  // shared column exists to prevent.
  for (const cls of ['fin-catfig', 'fin-polfig']) {
    const at = CSS.indexOf(`#tab-finance .${cls} {`);
    assert.notStrictEqual(at, -1, `${cls} has no rule`);
    assert.ok(/white-space: nowrap/.test(CSS.slice(at, at + 220)), `${cls} must not wrap`);
  }
  assert.ok(figures(drawnReal({ id: 77, rows: REAL, err: '' })).length >= 5,
    'the sweep above must actually have found figures to check');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
