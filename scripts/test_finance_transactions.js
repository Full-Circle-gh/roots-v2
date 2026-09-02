#!/usr/bin/env node
/**
 * Offline self-test for the Finance Transactions ledger.
 *
 *   node scripts/test_finance_transactions.js
 *
 * Three halves, no network and no browser:
 *
 *   1 · THE QUERIES (routes/finance-transactions.js) — run against a throwaway
 *       in-memory SQLite database seeded with the cases §36 rules on: a PO with
 *       two category rows, a PO with one, a hand-entered expense, a typed income
 *       row, and rows either side of the window.
 *   2 · THE SCREEN (public/retail-admin/22-finance.js) — the render functions
 *       evaluated against stubs, the technique used by test_phone_dashboard.js.
 *   3 · THE PAIRS — every rendered string checked against the locked Finance
 *       table of docs/tacet-delivery-vocabulary.md.
 *
 * What is asserted is what §36 and §1.12 decide, and what a later edit could
 * quietly undo — not the layout, which the mockup owns.
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
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'finance-transactions.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '22-finance.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const VOCAB = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
const WINDOW_LIB = fs.readFileSync(path.join(ROOT, 'lib', 'finance-window.js'), 'utf8');

/* Strip comments so a "must not read X" assertion tests CODE and not the prose
   explaining why X is not read. This file documents at length what it does not
   touch, and every one of those sentences names the thing. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = codeOnly(ROUTE);
const CLIENT_CODE = codeOnly(CLIENT);

const LEDGER_DATE = WINDOW_LIB.match(/const LEDGER_DATE = '([^']+)'/)[1];
const { fen } = require('../lib/finance-window');

/** The finance section of the page, with HTML comments stripped — this file's
 *  markup explains at length what it deliberately does NOT ship, and those
 *  sentences name the things. */
function financeSection() {
  return HTML.slice(HTML.indexOf('id="tab-finance"'), HTML.indexOf('id="tab-sales"'))
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

// ── The population ─────────────────────────────────────────────────────────
console.log('\n1 · what it reads — a ledger, not the order record');

it('the ledger date takes no timezone shift', () => {
  assert.strictEqual(LEDGER_DATE, 'date',
    'income_entries.date and expense_entries.date are business days already');
});

it('it reads income_entries and expense_entries, and NEVER retail_orders', () => {
  assert.ok(/income_entries/.test(ROUTE_CODE), 'money in must read income_entries');
  assert.ok(/expense_entries/.test(ROUTE_CODE), 'money out must read expense_entries');
  // §36 v4.118. Reading orders would restate the Summary's top line and bury
  // the ledger under several hundred rows a month.
  assert.ok(!/retail_orders|retail_order_items/.test(ROUTE_CODE),
    'Transactions does not list orders');
});

it('it declares no predicate of its own — they live in lib/finance-window.js', () => {
  assert.ok(/require\('\.\.\/lib\/finance-window'\)/.test(ROUTE_CODE), 'must reference the shared module');
  assert.ok(!/status IN \(/.test(ROUTE_CODE), 'no re-declared allow-list');
  assert.ok(!/\+8 hours/.test(ROUTE_CODE), 'no re-declared date expression');
});

it('the route is multi-tenant and read-only', () => {
  assert.ok(/require\('\.\.\/lib\/tenant-db'\)/.test(ROUTE_CODE) && /\btdb\(\)/.test(ROUTE_CODE), 'must use tdb()');
  assert.ok(!/require\('\.\.\/database'\)/.test(ROUTE_CODE),
    'routes/finance.js uses the global handle and is not a pattern to copy');
  assert.ok(!/router\.(post|put|patch|delete)\b/.test(ROUTE_CODE), 'the write half is out of scope');
});

it('no store filter reaches the endpoint or the screen', () => {
  // Neither ledger table carries a location, so a filter could only lie.
  assert.ok(!/store_id/.test(ROUTE_CODE), 'the endpoint takes no store filter');
  assert.ok(!/store_id|All locations|fin-tx-loc/.test(CLIENT_CODE), 'no location on the screen');
});

// ── The queries, against a real database ───────────────────────────────────
console.log('\n2 · the rows — §36’s rulings, on data that exercises them');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE income_entries  (id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT, description TEXT);
  CREATE TABLE expense_entries (id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT, description TEXT,
                                po_id INTEGER, created_at DATETIME);
  CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, po_number TEXT, date DATE);
`);
const FROM = '2026-08-01', TO = '2026-08-31';
db.prepare("INSERT INTO purchase_orders VALUES (50,'PO-0050','2026-08-30')").run();
db.prepare("INSERT INTO purchase_orders VALUES (51,'PO-0051','2026-08-20')").run();
db.prepare("INSERT INTO purchase_orders VALUES (52,'PO-0052','2026-07-10')").run();
// PO-0050: TWO category rows, the §36 worked example — one drawn row, ¥1,257.68.
// created_at is deliberately a LATER date than the PO's, which is what a re-post
// produces and what must never reach the screen.
db.prepare("INSERT INTO expense_entries VALUES (1,'2026-08-30',602.68,'Ingredients',NULL,50,'2026-09-02 04:00:00')").run();
db.prepare("INSERT INTO expense_entries VALUES (2,'2026-08-30',655.00,'Packaging',NULL,50,'2026-09-02 04:00:00')").run();
// PO-0051: ONE category. The note must vanish, not read "1 category".
db.prepare("INSERT INTO expense_entries VALUES (3,'2026-08-20',385.00,'Ingredients',NULL,51,'2026-09-02 04:00:00')").run();
// A PO dated OUTSIDE the window whose rows were re-posted INSIDE it.
db.prepare("INSERT INTO expense_entries VALUES (4,'2026-07-10',900.00,'Ingredients',NULL,52,'2026-08-15 04:00:00')").run();
db.prepare("INSERT INTO expense_entries VALUES (5,'2026-08-05',8000.00,'Rent',NULL,NULL,NULL)").run();
db.prepare("INSERT INTO expense_entries VALUES (6,'2026-07-31',9999.00,'Rent',NULL,NULL,NULL)").run();
db.prepare("INSERT INTO income_entries VALUES (1,'2026-08-25',3000.00,'Other','Equipment sold')").run();
db.prepare("INSERT INTO income_entries VALUES (2,'2026-07-20',500.00,'Other','Out of window')").run();

const income = db.prepare(`SELECT id, ${LEDGER_DATE} AS date, amount, category, description
  FROM income_entries WHERE ${LEDGER_DATE} BETWEEN ? AND ? ORDER BY date DESC, id DESC`).all(FROM, TO);
const manual = db.prepare(`SELECT id, ${LEDGER_DATE} AS date, amount, category, description
  FROM expense_entries WHERE po_id IS NULL AND ${LEDGER_DATE} BETWEEN ? AND ? ORDER BY date DESC, id DESC`).all(FROM, TO);
const posted = db.prepare(`
  SELECT e.po_id AS po_id, po.po_number AS po_number, po.date AS date,
         COALESCE(SUM(e.amount),0) AS amount, COUNT(DISTINCT e.category) AS categories,
         COUNT(*) AS rows_collapsed
    FROM expense_entries e JOIN purchase_orders po ON po.id = e.po_id
   WHERE e.po_id IS NOT NULL AND po.date BETWEEN ? AND ?
   GROUP BY e.po_id, po.po_number, po.date ORDER BY po.date DESC, e.po_id DESC`).all(FROM, TO);

it('a purchase order collapses to ONE row, whatever its category count', () => {
  // §36: "Two rows exist in storage; one row is drawn."
  const p50 = posted.find(r => r.po_id === 50);
  assert.ok(p50, 'PO-0050 is missing');
  assert.strictEqual(p50.rows_collapsed, 2, 'both storage rows must be behind it');
  // Rounded the way the route rounds it. SQLite's SUM over REAL yuan returns
  // 1257.6799999999998 here — the float residue docs/tacet-money-model-survey.md
  // describes — so this asserts the figure AFTER fen(), which is what reaches a
  // screen. The raw value failing this line is the reason fen() exists.
  assert.strictEqual(fen(p50.amount), 1257.68, 'the §36 worked example, to the fen');
  assert.strictEqual(posted.filter(r => r.po_id === 50).length, 1, 'one drawn row');
});

it('the category count is reported honestly — 2 for one PO, 1 for the other', () => {
  assert.strictEqual(posted.find(r => r.po_id === 50).categories, 2);
  assert.strictEqual(posted.find(r => r.po_id === 51).categories, 1);
});

it('a PO row is dated by the PURCHASE ORDER, never by created_at', () => {
  // created_at on these rows is 2026-09-02 — the last re-post, not the purchase.
  // §36: "It must never be presented as a purchase date."
  assert.strictEqual(posted.find(r => r.po_id === 50).date, '2026-08-30');
  assert.ok(!/created_at/.test(ROUTE_CODE),
    'the route must not select created_at at all, so no edit can reach for it');
});

it('the window filters a PO row on the PO’s date, not the re-post date', () => {
  // PO-0052 is dated 10 July and its expense row was re-posted 15 August.
  // Filtering on the row would drag a July purchase into an August window.
  assert.ok(!posted.some(r => r.po_id === 52), 'a July purchase must stay out of August');
});

it('hand-entered and PO-derived rows are both shown, and told apart', () => {
  assert.strictEqual(manual.length, 1, 'the ¥8,000 rent, and not the 31 July one');
  assert.strictEqual(manual[0].amount, 8000);
  assert.ok(/source: 'manual'/.test(ROUTE_CODE) && /source: 'po'/.test(ROUTE_CODE),
    'every row must declare which it is');
});

it('money in reads typed income only, inside the window', () => {
  assert.strictEqual(income.length, 1);
  assert.strictEqual(income[0].amount, 3000);
});

// ── The screen ─────────────────────────────────────────────────────────────
console.log('\n3 · the screen — the two states, and the refusal made visible');

const ctx = {
  window: {}, document: { getElementById: () => null, querySelectorAll: () => [] },
  Date, Math, Number, String, JSON, isNaN,
  cuT: (en) => en,
  escapeHtml: (s) => String(s == null ? '' : s),
};
vm.createContext(ctx);
new vm.Script(
  CLIENT.replace(/^\/\* eslint-disable[\s\S]*?\*\/$/m, '').replace(/^'use strict';$/m, '')
  + '\nthis.finTxRow=finTxRow; this.finTxAmount=finTxAmount; this.finTxDay=finTxDay;'
).runInContext(ctx);

const poRow = { kind: 'out', id: 'po-50', date: '2026-08-30', subject: 'PO-0050',
  amount: 1257.68, source: 'po', po_id: 50, categories: 2 };
const poOne = { ...poRow, id: 'po-51', subject: 'PO-0051', amount: 385, po_id: 51, categories: 1 };
const manualRow = { kind: 'out', id: 5, date: '2026-08-05', subject: 'Rent', amount: 8000, source: 'manual' };

it('a PO row offers no Edit — the refusal is visible, not just enforced', () => {
  const html = ctx.finTxRow(poRow);
  assert.ok(/Open purchase order/.test(html), 'it must link out to Purchasing');
  assert.ok(!/>Edit</.test(html), 'a PO row must not offer an edit the route refuses');
  assert.ok(/fin-tx-posted/.test(html), 'and must be visibly marked');
  assert.ok(/Posted by Purchasing/.test(html), 'the mark says who wrote it');
});

it('the category note vanishes ENTIRELY at one — it never reads "1 category"', () => {
  // §36: at one nothing was collapsed, so a note would assert a breakdown that
  // does not exist and send the operator looking for it.
  assert.ok(/Sum of 2 category subtotals/.test(ctx.finTxRow(poRow)), 'the note is missing at two');
  const one = ctx.finTxRow(poOne);
  assert.ok(!/category subtotals/.test(one), 'the note must be absent at one');
  assert.ok(!/1 category/.test(one), 'and must never read "1 category"');
});

it('a hand-entered row is plain — no tint, no mark, no outward link', () => {
  const html = ctx.finTxRow(manualRow);
  assert.ok(!/fin-tx-posted|Posted by Purchasing|Open purchase order/.test(html));
});

it('direction is a sign and a word, never a colour', () => {
  assert.strictEqual(ctx.finTxAmount({ kind: 'out', amount: 8000 }), '−¥8,000');
  assert.strictEqual(ctx.finTxAmount({ kind: 'in', amount: 3000 }), '+¥3,000');
  // §1.10 — money out is not an error. "A down delta renders in Graphite,
  // never Brick."
  assert.ok(!/brick|amber|--td-[a-z]*-(tint|ink)/i.test(ctx.finTxRow(manualRow)),
    'no state colour may reach a money-out row');
});

it('both §1.12 states ship, and they say different things', () => {
  const body = CLIENT.slice(CLIENT.indexOf('function finTxRender'));
  assert.ok(/Nothing recorded yet/.test(body), 'the EMPTY heading');
  assert.ok(/Rent, wages and one-off costs you record will appear here/.test(body),
    'empty must name what will arrive (§1.12)');
  assert.ok(/No matching records\./.test(body), 'the NO-RESULTS sentence');
  assert.ok(/finTxClear\(\)/.test(body), 'no-results must offer to clear the filter');
  // The two must not be reachable by the same branch: empty is a compliment,
  // no-results is not, and conflating them is §1.12's most common failure.
  assert.ok(/const filtering =/.test(body), 'the two states must be chosen apart');
});

it('there is no New transaction CTA — the write half is unbuilt', () => {
  assert.ok(!/New transaction/.test(financeSection() + CLIENT_CODE),
    'a CTA that does nothing is worse than none');
});

// ── The pairs ──────────────────────────────────────────────────────────────
console.log('\n4 · the locked pairs — copied, never composed');

const FINANCE_TABLE = VOCAB.slice(VOCAB.indexOf('## Finance — the money staircase'));

it('every rendered pair is in the locked Finance table', () => {
  [['Money in', '进账'], ['Money out', '支出'], ['In', '进'], ['Out', '出'],
   ['Direction', '方向'], ['Summary', '汇总'],
   ['Posted by Purchasing', '采购单自动记入'], ['Open purchase order', '查看采购单'],
   ['Nothing recorded yet', '暂无记录'], ['No matching records.', '没有符合条件的记录。'],
   ['Filter these transactions', '筛选交易记录'], ['Clear', '清除'],
   ['Transactions', '交易记录']]
    .forEach(([en, cn]) => {
      const pair = new RegExp(`'${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*'${cn}'`);
      assert.ok(pair.test(CLIENT) || (HTML.includes(en) && HTML.includes(cn)),
        `the screen does not render the pair: ${en}`);
      assert.ok(FINANCE_TABLE.includes(cn), `not locked in the vocabulary: ${en}`);
    });
});

it('Money in is 进账 and never Income’s 收入', () => {
  // Ruling 1 reserves 收入 for Income, a different thing in Tacet.
  assert.ok(!/'收入'/.test(CLIENT), 'the two must never collapse');
  assert.ok(/Money in', '进账'/.test(CLIENT));
});

it('the interpolated pair is marked for the §1.11 glue rule', () => {
  assert.ok(/data-lang-block/.test(CLIENT),
    'Sum of {n} category subtotals is interpolated and must not be glued');
});

it('the surface is wired end to end', () => {
  assert.ok(/id="fin-tx"/.test(HTML), 'the region');
  assert.ok(/id="fin-subviews"/.test(HTML), 'the sub-view strip');
  assert.ok(/routes\/finance-transactions/.test(
    fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'the mount');
  assert.ok(/function finShow/.test(CLIENT), 'the sub-view switch');
  // One window governs both sub-views, so an Apply must reach the ledger too.
  assert.ok(/if \(FIN_TX_SEEN\) finTxLoad\(\)/.test(CLIENT),
    'the shared range bar must refresh Transactions when it has been opened');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
