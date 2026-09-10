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
