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
const PAID = constOf('PAID');
const TZ = constOf('TZ');
const ODATE = WINDOW_LIB.match(/const ODATE = `([\s\S]*?)`;/)[1].replace('${TZ}', TZ);
const EDATE = constOf('LEDGER_DATE');

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
  const inline = src.match(/status IN \('paid'/g) || [];
  assert.strictEqual(inline.length, 1, `the allow-list is spelled out ${inline.length} times`);
  const dates = src.match(/date\(COALESCE\(paid_at, placed_at\)/g) || [];
  assert.strictEqual(dates.length, 1, `the date expression is spelled out ${dates.length} times`);
});

// ── The sums, against a real database ──────────────────────────────────────
console.log('\n2 · the sums — §36’s rulings, on rows that exercise them');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
    paid_at DATETIME, placed_at DATETIME);
  CREATE TABLE retail_topup_transactions (
    id INTEGER PRIMARY KEY, amount REAL, status TEXT, payment_method TEXT, paid_at DATETIME);
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT);
`);

const FROM = '2026-08-01', TO = '2026-08-31';
db.prepare("INSERT INTO retail_orders VALUES (1,'paid','wechat',1000,'2026-08-10 03:00:00',NULL)").run();
db.prepare("INSERT INTO retail_orders VALUES (2,'delivered','gzgrocery',500,'2026-08-11 03:00:00',NULL)").run();
db.prepare("INSERT INTO retail_orders VALUES (3,'pending_payment','wechat',999,NULL,'2026-08-12 03:00:00')").run();
db.prepare("INSERT INTO retail_orders VALUES (4,'refunded','wechat',777,'2026-08-13 03:00:00',NULL)").run();
// Placed 31 July 22:00 Guangzhou = 31 Jul 14:00 UTC, paid 1 August GZ. §36's
// worked example: it belongs to August, and only the +8h COALESCE puts it there.
db.prepare("INSERT INTO retail_orders VALUES (5,'paid','wechat',100,'2026-08-01 00:30:00','2026-07-31 14:00:00')").run();
// Never paid, so it falls back to placed_at — and is out of the window.
db.prepare("INSERT INTO retail_orders VALUES (6,'preparing','web',60,NULL,'2026-07-20 03:00:00')").run();
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

it('an uncategorised expense keeps its own line rather than a minted bucket', () => {
  const nulls = breakdown.filter(r => r.category == null);
  assert.strictEqual(nulls.length, 1);
  assert.strictEqual(nulls[0].amount, 50);
});

// ── The screen ─────────────────────────────────────────────────────────────
console.log('\n3 · the screen — the seventh state, and the locked pairs');

const ctx = {
  window: {}, document: { getElementById: () => null, querySelectorAll: () => [] },
  Date, Math, Number, String, JSON,
  cuT: (en) => en,
  escapeHtml: (s) => String(s == null ? '' : s),
};
vm.createContext(ctx);
new vm.Script(
  CLIENT.replace(/^\/\* eslint-env[\s\S]*?\*\/$/m, '')
    .replace(/^'use strict';$/m, '')
  + '\nthis.finRow=finRow; this.finMoney=finMoney; this.finNotRecorded=finNotRecorded;\n  this.finNotRecordedValue=finNotRecordedValue;'
  + '\nthis.finBreakdown=finBreakdown;'
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

it('both cost rows are covered, and the sentence is rendered once per card', () => {
  const card = CLIENT.slice(CLIENT.indexOf('function finRender'));
  assert.ok(/Cost of goods', '销货成本'\), finNotRecordedValue\(\)/.test(card),
    'cost of goods must read the not-recorded value');
  assert.ok(/Gross profit', '毛利润'\), finNotRecordedValue\(\)/.test(card),
    'gross profit must read the not-recorded value');
  assert.strictEqual((card.match(/finNotRecorded\(\)/g) || []).length, 1);
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
  // the same !important override #tab-delivery already uses for this trap.
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
