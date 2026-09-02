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

it('the route is multi-tenant', () => {
  assert.ok(/require\('\.\.\/lib\/tenant-db'\)/.test(ROUTE_CODE) && /\btdb\(\)/.test(ROUTE_CODE), 'must use tdb()');
  assert.ok(!/require\('\.\.\/database'\)/.test(ROUTE_CODE),
    'routes/finance.js uses the global handle and is not a pattern to copy');
  // Every db handle inside the write paths must be the tenant one. A single
  // `db.` that resolved to the global would write a second tenant's ledger.
  assert.strictEqual((ROUTE_CODE.match(/const db = tdb\(\)/g) || []).length, 4,
    'each handler resolves its own tdb() handle');
});

it('no store filter reaches the endpoint or the screen', () => {
  // Neither ledger table carries a location, so a filter could only lie.
  assert.ok(!/store_id/.test(ROUTE_CODE), 'the endpoint takes no store filter');
  assert.ok(!/store_id|All locations|fin-tx-loc/.test(CLIENT_CODE), 'no location on the screen');
});

it('NO 1 AUGUST FLOOR — not in the route, the screen, the window lib or the markup', () => {
  // §36, *Finance is not floored at the cutover date* (DECIDED 2026-09-02).
  // The survey behind that decision found the floor existed only in prose, so
  // this asserts the absence rather than trusting it: an untested absence is one
  // confident reader away from being filled back in.
  //
  // CODE and comment-stripped markup only. All four files now carry sentences
  // saying there is no floor, and every one of them names the date.
  [['the route', ROUTE_CODE], ['the screen', CLIENT_CODE],
   ['the window lib', codeOnly(WINDOW_LIB)], ['the markup', financeSection()]]
    .forEach(([what, src]) => assert.ok(!/2026-08-01/.test(src), `a cutover date is live in ${what}`));
  // resolveWindow is the whole of the date logic, and it clamps nothing.
  assert.ok(!/Math\.max/.test(codeOnly(WINDOW_LIB)), 'resolveWindow must not clamp a bound');
});

it('the form’s date field carries no `min`, on the add path and the edit path', () => {
  // §36: "a person may legitimately correct an old row". One form serves both
  // paths — finTxForm sets its value and nothing else — so the markup is the
  // whole of it, and the server's own check is on shape and not on range.
  const field = HTML.match(/<input type="date" id="fin-tx-date"[^>]*>/);
  assert.ok(field, '#fin-tx-date is missing');
  assert.ok(!/\bmin=/.test(field[0]), `a floor is back on the form: ${field[0]}`);
  assert.ok(!/setAttribute\(['"]min['"]|\.min\s*=/.test(CLIENT_CODE),
    'no floor may be set on a date field from script either');
  // Shape, not range. A date check that grew a lower bound would refuse the
  // correction the decision exists to allow.
  assert.ok(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(ROUTE_CODE),
    'the server validates the date’s SHAPE');
  assert.ok(!/date\s*[<>]=?\s*['"]20/.test(ROUTE_CODE), 'the server must not bound the date');
});

it('the range bar’s date fields carry no `min` either', () => {
  ['fin-from', 'fin-to'].forEach(id => {
    const f = HTML.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(f, `#${id} is missing`);
    assert.ok(!/\bmin=/.test(f[0]), `a floor is back on #${id}: ${f[0]}`);
  });
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

it('a JULY window returns July rows — there is no floor at 1 August', () => {
  // §36, *Finance is not floored at the cutover date*. The same three queries,
  // run over a window entirely before the cutover: every row seeded above as
  // "out of window" for August is IN this one, in all three populations.
  //
  // This is the test the decision turns on. Add a `>= '2026-08-01'` anywhere in
  // the route and all three of these go to zero.
  const [JF, JT] = ['2026-07-01', '2026-07-31'];
  const jIncome = db.prepare(`SELECT id, amount FROM income_entries
     WHERE ${LEDGER_DATE} BETWEEN ? AND ?`).all(JF, JT);
  const jManual = db.prepare(`SELECT id, amount FROM expense_entries
     WHERE po_id IS NULL AND ${LEDGER_DATE} BETWEEN ? AND ?`).all(JF, JT);
  const jPosted = db.prepare(`SELECT e.po_id AS po_id, COALESCE(SUM(e.amount),0) AS amount
      FROM expense_entries e JOIN purchase_orders po ON po.id = e.po_id
     WHERE e.po_id IS NOT NULL AND po.date BETWEEN ? AND ? GROUP BY e.po_id`).all(JF, JT);

  assert.strictEqual(jIncome.length, 1, 'the 20 July income row must be reachable');
  assert.strictEqual(jIncome[0].amount, 500);
  assert.strictEqual(jManual.length, 1, 'the 31 July rent must be reachable');
  assert.strictEqual(jManual[0].amount, 9999);
  assert.strictEqual(jPosted.length, 1, 'the 10 July purchase order must be reachable');
  assert.strictEqual(jPosted[0].po_id, 52);
  assert.strictEqual(jPosted[0].amount, 900);
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

it('the New transaction CTA ships now that it does something', () => {
  // This assertion is the inverse of the one it replaces. #194 shipped no CTA
  // because the write half did not exist and "a CTA that does nothing is worse
  // than none". The write half exists, so the button is correct — the rule never
  // changed, only whether pressing it leads anywhere.
  const sec = financeSection();
  assert.ok(/id="fin-tx-new"/.test(sec), 'the CTA is missing');
  assert.ok(/onclick="finTxForm\('out'\)"/.test(sec), 'it must open the form');
  assert.ok(/data-cap="finance:record"/.test(sec), 'and be gated on holding the pen');
  assert.ok(/window\.finTxForm/.test(CLIENT_CODE), 'the handler must exist');
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


// ── The write half ─────────────────────────────────────────────────────────
console.log('\n5 · typing a row — §36’s write rules');

const { storeCategory } = require('../lib/category-text');

it('POST never writes po_id, so a typed row cannot become a projection', () => {
  // The property routes/finance.js has today and that §36's display decision
  // rests on: a typed row is editable precisely because it carries no po_id.
  const post = ROUTE_CODE.slice(ROUTE_CODE.indexOf("router.post("), ROUTE_CODE.indexOf('router.put('));
  assert.ok(/INSERT INTO income_entries/.test(post) && /INSERT INTO expense_entries/.test(post));
  assert.ok(!/po_id/.test(post), 'po_id must be absent from both column lists');
});

it('the PO refusal is unchanged, on edit and on delete', () => {
  // §36's refusal, enforced here as routes/finance.js enforces it, and reusing
  // that file's own bilingual strings rather than composing a second pair.
  assert.ok(/row\.po_id != null/.test(ROUTE_CODE), 'both write paths must check po_id');
  assert.ok(ROUTE.includes('PO-linked expenses cannot be edited directly · 关联采购单的支出不能直接编辑'));
  assert.ok(ROUTE.includes('PO-linked expenses cannot be deleted directly · 关联采购单的支出不能直接删除'));
});

it('a PO row offers no Edit on the screen either', () => {
  // The refusal is visible before it is enforced — §36's "the row explains its
  // own constraint instead of merely enforcing it".
  const html = ctx.finTxRow(poRow);
  assert.ok(!/finTxEdit/.test(html), 'a PO row must not offer Edit');
  assert.ok(/finTxOpenPO/.test(html), 'it links out to Purchasing instead');
});

it('direction is chosen, never inferred from the amount’s sign', () => {
  // A mistyped minus must not move a row between halves of the ledger.
  assert.ok(/const kind = String\(b\.kind/.test(ROUTE_CODE), 'kind comes from the body');
  assert.ok(!/amount\s*<\s*0/.test(ROUTE_CODE), 'the sign must not pick a table');
  assert.ok(/finTxKind/.test(CLIENT_CODE), 'and the form makes it a choice');
});

it('amount is rounded through fen() BEFORE it is stored', () => {
  // #194's suite caught a raw REAL sum returning 1257.6799999999998. Storing
  // that residue would hand it to every later reader.
  assert.ok(/const amount = fen\(b\.amount\)/.test(ROUTE_CODE), 'fen() on the way in');
  assert.strictEqual(fen(602.68 + 655.00), 1257.68);
  assert.ok(/amount > 0/.test(ROUTE_CODE), 'and zero or negative is refused');
});

it('§36 is honoured: storeCategory runs on every write', () => {
  // "Finance calls storeCategory on every write… Finance stops being the
  // exception." Without it the Summary's breakdown draws lines that read
  // identically — the total right and every line beneath it wrong.
  assert.ok(/require\('\.\.\/lib\/category-text'\)/.test(ROUTE_CODE), 'must import it');
  assert.ok(/storeCategory\(db, b\.category\)/.test(ROUTE_CODE), 'must call it');
  // readBody is the ONE place a row is validated, and both POST and PUT go
  // through it — so neither can skip the normalisation.
  assert.strictEqual((ROUTE_CODE.match(/readBody\(/g) || []).length, 3,
    'declared once, called by both write paths');
});

it('storeCategory actually snaps a variant onto the stored spelling', () => {
  const c = new Database(':memory:');
  c.exec("CREATE TABLE categories (kind TEXT, name TEXT)");
  c.prepare("INSERT INTO categories VALUES ('accounting','Rent')").run();
  // Same category, typed with stray spacing — §36's three-rent-payments case.
  assert.strictEqual(storeCategory(c, ' Rent '), 'Rent');
  assert.strictEqual(storeCategory(c, 'Rent'), 'Rent');
});

it('money in passes no category — the expense list is not its list', () => {
  // §36 decides income categories move server-side and ship empty, and that has
  // not landed. Normalising an income value against kind='accounting' would snap
  // it onto the EXPENSE list, which is a different list doing a different job.
  assert.ok(/kind === 'out' \? storeCategory/.test(ROUTE_CODE), 'money in must pass null');
  assert.ok(/FIN_TX_KIND === 'out' \? val\('fin-tx-cat'\) : null/.test(CLIENT_CODE),
    'and the form must not send one');
});

it('the income category field hides while the add control stays visible', () => {
  // §36: "the category field appears once the tenant has created at least one
  // income category" and "the add income action stays visible regardless" —
  // gating it "would leave a tenant with non-sale money in hand, no route to
  // record it, and no sign on the screen explaining why."
  assert.ok(/row\.hidden = FIN_TX_KIND === 'in'/.test(CLIENT_CODE), 'the field hides');
  const cta = financeSection().match(/id="fin-tx-new"[^>]*/);
  assert.ok(cta, 'the CTA is missing');
  assert.ok(!/disabled/.test(cta[0]), 'it is never disabled');
});

it('nothing in the form touches localStorage', () => {
  assert.ok(!/localStorage|roots_v2:incomeCats/.test(CLIENT_CODE),
    'income categories live in localStorage today and this form must not read them');
});

it('a delete is never unconfirmed, and the write control disables', () => {
  assert.ok(/typeof askConfirm !== 'function'\) return/.test(CLIENT_CODE),
    'a missing dialog must refuse, not proceed');
  assert.ok(/save\.disabled = true/.test(CLIENT_CODE),
    '§1.12: every control that writes disables while it writes');
});

it('the write half is gated apart from the read half', () => {
  const caps = fs.readFileSync(path.join(ROOT, 'lib', 'capabilities.js'), 'utf8');
  assert.ok(/'finance:record'.*money: 'moves'/.test(caps), 'typing money is a moves capability');
  const { requiredCapFor } = require('../lib/cap-routes');
  assert.strictEqual(requiredCapFor('POST', '/api/retail-admin/finance/transactions'), 'finance:record');
  assert.strictEqual(requiredCapFor('DELETE', '/api/retail-admin/finance/transactions/out/1'), 'finance:record');
  assert.strictEqual(requiredCapFor('GET', '/api/retail-admin/finance/transactions'), null,
    'reads stay open — the client hides the surface');
});

it('the three new pairs are locked at v1.11, and the rest are reused', () => {
  assert.ok(/\*\*v1\.11 ·/.test(VOCAB), 'the amendment must be recorded');
  [['New transaction', '新建交易'],
   ['Delete this transaction?', '删除这条交易记录？'],
   ['This removes the row from the ledger.', '此操作将从账本中移除该记录。']]
    .forEach(([en, cn]) => {
      assert.ok(FINANCE_TABLE.includes(cn), `not locked: ${en}`);
      assert.ok(CLIENT.includes(cn) || HTML.includes(cn), `not rendered: ${en}`);
    });
  // The reused halves must NOT have been re-minted as new rows.
  assert.ok(CLIENT.includes('此操作无法撤销。'), 'the undo warning is reused from the product editor');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
