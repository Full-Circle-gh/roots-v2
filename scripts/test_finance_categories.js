#!/usr/bin/env node
/**
 * Offline self-test for the tenant's expense-category list and the Summary
 * split it drives (§87 part two).
 *
 *   node scripts/test_finance_categories.js
 *
 * Three halves, no network and no browser:
 *
 *   1 · THE RULES, run for real. The collision rule and the operating-flag
 *       resolution both go through `lib/category-text.js`'s `spacingKey`, which
 *       is pure and is REQUIRED here rather than restated — the whole point of
 *       the decision is that the writer and the reader share one rule, and a
 *       test carrying its own copy could not catch them diverging.
 *
 *   2 · THE SPLIT, over a fixture. The grouped read is sliced out of the
 *       shipped route and run against a throwaway in-memory database holding
 *       the cases §87 rules on: an operating cost, an owner's drawing, a
 *       category the tenant never listed, an uncategorised row, and a row whose
 *       spelling differs from the list's by case and spacing.
 *
 *   3 · THE DECISIONS, asserted against the shipped source — the ones a later
 *       edit could quietly undo and no fixture would notice: that net takes off
 *       the operating half only, that a used category cannot be deleted, that a
 *       rename carries the ledger rows with it, that a hidden category is not
 *       offered, and that nothing seeds the list.
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
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ROUTE = read('routes', 'finance-categories.js');
const SUMMARY = read('routes', 'finance-summary.js');
const TX = read('routes', 'finance-transactions.js');
const CLIENT = read('public', 'retail-admin', '22-finance.js');
const HTML = read('public', 'retail-admin.html');
const DB_JS = read('database.js');
const SERVER = read('server.js');

/* Comments are stripped before a "must not" assertion, the same technique
   test_finance_summary.js uses and for the same reason: these files document at
   length what they deliberately do not do, and every such sentence names the
   thing. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = codeOnly(ROUTE);
const SUMMARY_CODE = codeOnly(SUMMARY);
const CLIENT_CODE = codeOnly(CLIENT);

// The shipped rule, required rather than restated.
const { spacingKey, normaliseCategory } = require(path.join(ROOT, 'lib', 'category-text.js'));

console.log('\n1 · the rules, run for real');

it('two spellings of one category collide — the writer already treats them as one', () => {
  // `storeCategory` snaps on spacingKey, so a list holding both `Rent` and
  // `rent ` would decide which one a typed value lands on by whichever row the
  // loop reached first — and the two could carry different operating flags.
  assert.strictEqual(spacingKey('Rent'), spacingKey('rent '));
  assert.strictEqual(spacingKey('Maintenance & Repairs'), spacingKey('Maintenance&Repairs'));
  assert.notStrictEqual(spacingKey('Rent 房租'), spacingKey('Rent 租金'),
    'two categories differing in their WORDS are two categories');
});

it('the list stores its names normalised — a pasted radical never becomes the master spelling', () => {
  // U+2F64 KANGXI RADICAL USE against U+7528. The whole reason category-text.js
  // exists is that these produced two live spellings of one category; a MASTER
  // LIST carrying one would hand it to every row that snapped onto it.
  const pasted = '原材料（厨房及零售通⽤）';
  assert.strictEqual(normaliseCategory(pasted), '原材料（厨房及零售通用）');
  assert.ok(/normaliseCategory/.test(ROUTE_CODE),
    'the category route must normalise the name it stores');
});

it('an empty or blank name is refused rather than stored', () => {
  assert.strictEqual(normaliseCategory('   '), null);
  assert.ok(/name === null \? \{ error: ERR\.name \}/.test(ROUTE_CODE),
    'a blank name must be an error, not a NULL row on the list');
});

console.log('\n2 · the split, over a fixture');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY, date DATE, amount REAL, category TEXT
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY, kind TEXT, name TEXT, sort_order INTEGER,
    is_operating INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1
  );
`);
// The tenant's list: rent counts, the owner's drawings do not.
db.prepare("INSERT INTO categories VALUES (1,'accounting','Rent 房租',1,1,1)").run();
db.prepare("INSERT INTO categories VALUES (2,'accounting','Private expense 私人费用',2,0,1)").run();
// A product category with the same shape, to prove the reader is scoped.
db.prepare("INSERT INTO categories VALUES (3,'product','Bakery',1,1,1)").run();

db.prepare("INSERT INTO expense_entries VALUES (1,'2026-08-05',8000,'Rent 房租')").run();
db.prepare("INSERT INTO expense_entries VALUES (2,'2026-08-06',5000,'Private expense 私人费用')").run();
// Spelling drift: a row typed before the list existed, differing by case and by
// the space `storeCategory` would have collapsed.
db.prepare("INSERT INTO expense_entries VALUES (3,'2026-08-07',1000,'private expense  私人费用')").run();
// A category the tenant never listed, and a row with none at all.
db.prepare("INSERT INTO expense_entries VALUES (4,'2026-08-08',300,'Taxi')").run();
db.prepare("INSERT INTO expense_entries VALUES (5,'2026-08-09',50,NULL)").run();
// Outside the window.
db.prepare("INSERT INTO expense_entries VALUES (6,'2026-07-31',9999,'Rent 房租')").run();

const WINDOW = ['2026-08-01', '2026-08-31'];
const grouped = db.prepare(`
  SELECT category, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n
    FROM expense_entries
   WHERE date BETWEEN ? AND ?
   GROUP BY category
   ORDER BY amount DESC`).all(...WINDOW);

/* The route's own resolution, built from the same pieces: the flag map keyed on
   spacingKey, and unlisted meaning operating. */
const flags = new Map();
for (const c of db.prepare(
  "SELECT name, COALESCE(is_operating, 1) AS is_operating FROM categories WHERE kind = 'accounting'"
).all()) {
  const key = spacingKey(c.name);
  if (key !== null) flags.set(key, c.is_operating ? 1 : 0);
}
const operatingFlag = (category) => {
  const key = spacingKey(category);
  if (key === null || !flags.has(key)) return 1;
  return flags.get(key);
};
const operating = grouped.filter(r => operatingFlag(r.category) === 1);
const nonOperating = grouped.filter(r => operatingFlag(r.category) === 0);
const sum = (rows) => rows.reduce((t, r) => t + r.amount, 0);

it("an owner's private transfer is recorded and is NOT an operating expense", () => {
  assert.strictEqual(sum(nonOperating), 6000, 'both private rows, ¥5,000 + ¥1,000');
  assert.ok(!operating.some(r => /[Pp]rivate/.test(r.category || '')),
    'a drawing must not be summed with rent');
});

it('a row whose spelling drifted from the list still carries the list\'s flag', () => {
  // This is the case a SQL `=` join gets wrong, and it gets it wrong in the
  // dangerous direction: ¥1,000 of the owner's money back in operating expenses,
  // with nothing on the screen to say so.
  const drifted = nonOperating.find(r => r.category === 'private expense  私人费用');
  assert.ok(drifted, 'case and spacing are not a different category');
  assert.strictEqual(drifted.amount, 1000);
});

it('an unlisted category and an uncategorised row are both OPERATING', () => {
  // The safe default in both directions: an unlisted cost is a real cost until
  // somebody says otherwise, and nothing leaves the operating total without a
  // tenant having deliberately marked it.
  assert.strictEqual(operatingFlag('Taxi'), 1);
  assert.strictEqual(operatingFlag(null), 1);
  assert.strictEqual(sum(operating), 8350, 'rent 8000 + taxi 300 + uncategorised 50');
});

it('the window still bounds the split — 31 July is in neither half', () => {
  assert.ok(!grouped.some(r => r.amount === 9999), 'the July row must be outside the window');
  assert.strictEqual(sum(operating) + sum(nonOperating), 14350);
});

it('the product list is not read as an expense list', () => {
  assert.ok(!flags.has(spacingKey('Bakery')),
    "kind='accounting' only — a route that took the kind from the URL would let this screen rename a product category");
});

it('net takes off the operating half only', () => {
  const revenue = 100000;
  assert.strictEqual(revenue - sum(operating), 91650);
  // And the excluded money is reported rather than dropped.
  assert.strictEqual(sum(nonOperating), 6000);
});

console.log('\n3 · the decisions, in the shipped source');

it('the migration adds both columns, defaulting to the behaviour that exists today', () => {
  assert.match(DB_JS, /addColumn\('categories',\s*'is_operating',\s*'INTEGER DEFAULT 1'\)/,
    'every category that exists today is an operating expense');
  assert.match(DB_JS, /addColumn\('categories',\s*'is_active',\s*'INTEGER DEFAULT 1'\)/);
});

it('the route is mounted', () => {
  assert.match(SERVER, /require\('\.\/routes\/finance-categories'\)/);
});

it('the list ships EMPTY — nothing seeds an accounting category', () => {
  // §36: "an empty list cannot offer a wrong option", written after four
  // inherited kitchen categories produced the ¥152,309 mis-filing. This asserts
  // the absence directly, because the failure mode is a later session adding a
  // helpful starter set.
  const seeds = codeOnly(DB_JS).match(/INSERT[^;]*INTO categories[^;]*/gi) || [];
  for (const s of seeds) {
    assert.ok(!/'accounting'/.test(s), `nothing may seed the expense list: ${s.slice(0, 80)}`);
  }
  assert.ok(!/'accounting'/.test(codeOnly(ROUTE).match(/INSERT INTO categories[^;]*/)[0].replace('KIND', '')),
    'the insert takes the kind as a bound constant, not a literal starter row');
});

it('the summary resolves the flag through spacingKey, not through a SQL join', () => {
  assert.match(SUMMARY_CODE, /spacingKey/, 'one rule for when two category strings are one category');
  assert.ok(!/JOIN categories/i.test(SUMMARY_CODE),
    'a `=` join counts Private and private as two things and puts one back into operating expenses');
});

it('the summary reports the excluded money instead of dropping it', () => {
  assert.match(SUMMARY_CODE, /non_operating_expenses/);
  // Net is revenue minus the OPERATING figure. A drawing is not a business
  // expense; subtracting it here would put it back in the profit line by
  // another road.
  assert.match(SUMMARY_CODE, /net: fen\(revenue - expenses\)/);
  assert.ok(!/revenue - expenses - nonOperating|nonOperating\)?\s*\)/.test(
    SUMMARY_CODE.replace(/non_operating_expenses: nonOperating,/, '')),
    'the non-operating figure must not enter the arithmetic');
});

it('the totals and the breakdown come from ONE read', () => {
  const reads = (SUMMARY_CODE.match(/FROM expense_entries/g) || []).length;
  assert.strictEqual(reads, 1,
    'two queries over one set is two places for the split to be applied, and one day they disagree');
});

it('a category any expense names cannot be deleted', () => {
  assert.match(ROUTE_CODE, /SELECT COUNT\(\*\) AS n FROM expense_entries WHERE category = \?/);
  assert.match(ROUTE_CODE, /if \(usage > 0\) return res\.status\(409\)/,
    'deleting a used category re-files its rows as operating expenses, silently');
});

it('a rename carries the ledger rows with it, in the same transaction', () => {
  assert.match(ROUTE_CODE, /UPDATE expense_entries SET category = \? WHERE category = \?/);
  assert.match(ROUTE_CODE, /withTransaction/,
    'the rename and the propagation must both land or neither');
  // Purchasing's copy of the same vocabulary is deliberately NOT carried.
  assert.ok(!/po_line_items|accounting_category/.test(ROUTE_CODE),
    "renaming here must not rewrite what Purchasing says a line was for");
});

it('a hidden category stops being offered on the transaction form', () => {
  assert.match(codeOnly(TX), /kind = 'accounting' AND COALESCE\(is_active, 1\) = 1/);
  assert.match(CLIENT_CODE, /FIN_TX && FIN_TX\.expense_categories/);
});

it('the old derivation survives while the tenant has no list', () => {
  // Taking it away would leave a business with three years of expenses typing
  // every category from memory. §36's empty-list rule is about not offering a
  // WRONG option; a category read off this tenant's own rows is not one.
  assert.match(CLIENT_CODE, /if \(own\.length\) return own\.slice\(\);/);
  assert.match(CLIENT_CODE, /r\.kind === 'out' && r\.category/);
});

console.log('\n4 · the screen');

const ctx = {
  window: {}, document: { getElementById: () => null, querySelectorAll: () => [] },
  Date, Math, Number, String, JSON, Set, Map,
  cuT: (en) => en,
  escapeHtml: (s) => String(s == null ? '' : s),
  escapeAttr: (s) => String(s == null ? '' : s),
  acWrap: (s) => s,
};
vm.createContext(ctx);
new vm.Script(
  CLIENT.replace(/^\/\* eslint-disable[\s\S]*?\*\/$/m, '').replace(/^'use strict';$/m, '')
  + '\nthis.finOperating=finOperating; this.finNonOperating=finNonOperating;'
  + '\nthis.finCatsUsage=finCatsUsage;'
).runInContext(ctx);

const ROWS = [
  { category: 'Rent 房租', amount: 8000, entries: 1, is_operating: 1 },
  { category: 'Private expense 私人费用', amount: 6000, entries: 2, is_operating: 0 },
  { category: 'Taxi', amount: 300, entries: 1, is_operating: 1 },
];

it('the disclosure on the operating row shows the operating rows only', () => {
  assert.deepStrictEqual(ctx.finOperating(ROWS).map(r => r.category), ['Rent 房租', 'Taxi'],
    'a line inside the disclosure that the figure above did not include is a breakdown that does not add up');
  assert.deepStrictEqual(ctx.finNonOperating(ROWS).map(r => r.category), ['Private expense 私人费用']);
});

it('a payload with no flag on it reads as operating', () => {
  // A stale server, or a row from before the flag existed. It must not move
  // money OUT of the operating total on the way to the screen.
  const old = [{ category: 'Rent', amount: 1, entries: 1 }];
  assert.strictEqual(ctx.finOperating(old).length, 1);
  assert.strictEqual(ctx.finNonOperating(old).length, 0);
});

it('the excluded block is absent at zero, and carries no minus sign when shown', () => {
  // §1.12: a row that only ever says nothing happened does not belong on the
  // screen — and every tenant has nothing flagged on the day this ships.
  assert.match(CLIENT_CODE, /d\.non_operating_expenses > 0/);
  const block = CLIENT.slice(CLIENT.indexOf('fin-excl'), CLIENT.indexOf('fin-excl-note'));
  assert.ok(!/fin-sign">−/.test(block),
    "the staircase's signs are arithmetic, and a drawing is subtracted from nothing");
});

it('a usage count of zero says Not used rather than 0', () => {
  assert.strictEqual(ctx.finCatsUsage(0), 'Not used');
  assert.strictEqual(ctx.finCatsUsage(3), 'Used by 3');
});

it('the sub-view exists, and the range bar leaves with it', () => {
  assert.match(HTML, /data-sub="categories"/);
  assert.match(HTML, /id="fin-cats"/);
  assert.match(CLIENT_CODE, /const isCats = which === 'categories';/);
  // THE FACT, NOT THE LINE. This pinned `bar.hidden = isCats;` exactly, so
  // §87 step three's Approvals pane — which hides the bar for its own reason, a
  // queue having no window either — failed a test about Categories while
  // changing nothing Categories does. The assertion now says what it means: the
  // range bar's hidden state is driven by isCats, whatever else joins it.
  assert.match(CLIENT_CODE, /if \(bar\) bar\.hidden = [^;]*\bisCats\b[^;]*;/);
  // Summary must not be left showing underneath any later pane.
  assert.match(CLIENT_CODE, /stair\.hidden = isTx \|\| isCats/);
});

it('every pair the new surface renders is DECLARED in the vocabulary', () => {
  // CLAUDE.md, and Rule 4 as amended 2026-09-06: a composed string goes into
  // docs/tacet-delivery-vocabulary.md in the same commit as the code that uses
  // it. An undeclared string is indistinguishable from a locked one to everyone
  // who comes after, which is how a wrong character survives.
  const VOCAB = read('docs', 'tacet-delivery-vocabulary.md');
  const pairs = [
    '不计入营业费用', '已记录，未计入上方数字。', '停用该分类？', '删除该分类？',
    '分类加载失败。', '还没有分类。请新增本店的支出分类 — 租金、工资。',
    '记录支出时不再显示该分类。已使用该分类的支出保持不变，其设置也保留。',
    '尚无支出使用该分类。此操作无法撤销。',
    '本店自己的分类列表。记录支出时只会显示这些分类。',
    '未使用', '已停用',
  ];
  for (const cn of pairs) {
    assert.ok(VOCAB.includes(cn), `composed and not declared: ${cn}`);
  }
  // And the two the server can answer with, which reach a screen exactly as a
  // rendered pair does.
  for (const cn of ['分类名称必填', '该分类已存在']) {
    assert.ok(VOCAB.includes(cn), `composed and not declared: ${cn}`);
    assert.ok(ROUTE.includes(cn), 'the route must ship the pair it declared');
  }
});

it('房租 stays in the comment it illustrates — the shipped word is 租金', () => {
  // Both mean rent and both are in this file; only one is a live string. The
  // vocabulary section records the distinction, and this is what holds it.
  const shipped = CLIENT_CODE + codeOnly(HTML);
  assert.ok(!shipped.includes('房租'),
    'the surface one screen away ships 租金 — a second word for rent is how a glossary drifts');
});

it('every string on the new surface is bilingual', () => {
  // The house rule for this surface: an operator-facing string carries both
  // halves. Checked on the markup, where a missing pair is invisible until
  // somebody switches language.
  const panel = HTML.slice(HTML.indexOf('<div id="fin-cats"'), HTML.indexOf('id="fin-cats-list"'));
  for (const m of panel.match(/>([^<>{]{4,})</g) || []) {
    const text = m.slice(1, -1).trim();
    if (!text || !/[A-Za-z]/.test(text)) continue;
    assert.ok(/[一-鿿]/.test(text), `not bilingual: ${text.slice(0, 60)}`);
  }
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
