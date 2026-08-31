#!/usr/bin/env node
//
// test_cost_incomplete_flag.js — the operator's "this cost is not complete"
// tag, end to end: the one-time seed, the mark it puts on the Products list,
// and the round trip through the product editor.
//
// WHAT THIS IS FOR
// ----------------
// §31 rule 9 (docs/tacet-consolidation-decisions.md) settles that an empty
// packaging list means UNKNOWN rather than zero, "and why it reports a margin
// that is too good, in the direction that flatters". It settles what is TRUE
// and deliberately leaves the screens undesigned. This is the screen: a stored
// per-product tag, seeded once from what the build lists prove and owned by the
// operator from then on, painted beside the margin it qualifies.
//
// The tag is DECLARED, not derived, and that is the decision this file has to
// keep honest. 171 products carry a cost somebody typed, and no query can tell
// a typed ¥12 that already includes the jar from a typed ¥12 that forgot it —
// so the system asks rather than guesses. What it does NOT do is start empty:
// an untouched flag says "every cost here is complete", which is the flattering
// default rule 9 exists to stop. Hence the seed, and hence sections 1 and 2.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * The seed's SQL is LIFTED OUT OF database.js and executed against an
//     in-memory database whose store_products is built by replaying the real
//     addColumn() calls. A rewritten predicate fails here; a copy of the
//     predicate in this file would not.
//   * The list cell is public/retail-admin/09-products.js, executed verbatim in
//     a vm against a DOM stub, and every assertion reads the HTML the shipped
//     function actually returned.
//
// USAGE   node scripts/test_cost_incomplete_flag.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT        = path.join(__dirname, '..');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SQL  = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '09-products.js'), 'utf8');
const ADMIN_HTML  = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const RETAIL_JS   = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// The seed's UPDATE, taken out of the shipped file rather than restated here.
// Anchored on the assignment inside the statement rather than on the whole
// opening line: an anchor that has to reproduce database.js's exact indentation
// breaks on a reformat and reports it as a missing migration.
const SEED_SQL = (() => {
  const at = DATABASE_JS.indexOf('SET cost_incomplete = 1');
  assert.notStrictEqual(at, -1, 'the cost_incomplete seed is not in database.js');
  const open = DATABASE_JS.lastIndexOf('`', at);
  const close = DATABASE_JS.indexOf('`', at);
  assert.ok(open > -1 && close > at, 'the seed is not inside a template literal');
  return DATABASE_JS.slice(open + 1, close);
})();

// ── The database ────────────────────────────────────────────────────────────
const { openTablesDb, addTables, addForkedStoreProducts, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// Every table here is the REAL definition — store_products built by the fork
// rule (so cost_incomplete arrives via the same addColumn the app runs),
// `ingredients` from schema.sql, `product_build_lines` from database.js.
function freshDb() {
  const db = openTablesDb(DATABASE_JS, []);
  addForkedStoreProducts(db, SCHEMA_SQL, DATABASE_JS);
  // `recipes` comes along because ingredients REFERENCES it (source_recipe_id):
  // an inline REFERENCES survives the FK strip, and a missing parent table fails
  // at INSERT rather than at CREATE.
  addTables(db, SCHEMA_SQL, DATABASE_JS, ['recipes', 'ingredients']);
  addTables(db, DATABASE_JS, DATABASE_JS, ['product_build_lines']);
  return db;
}

let pseq = 0, iseq = 0;
function product(db, name) {
  const id = ++pseq;
  db.prepare('INSERT INTO store_products (id, name_en, sell_price, unit_cost) VALUES (?,?,?,?)')
    .run(id, name, 100, 20);
  return id;
}
function material(db, name, kind) {
  const id = ++iseq;
  db.prepare("INSERT INTO ingredients (id, name_en, item_kind) VALUES (?,?,?)").run(id, name, kind);
  return id;
}
function line(db, productId, ingredientId, name) {
  db.prepare('INSERT INTO product_build_lines (product_id, ingredient_id, name_en, qty, unit) VALUES (?,?,?,?,?)')
    .run(productId, ingredientId, name || 'line', 1, 'g');
}
// NULL is "nobody has answered" and is what an untouched row holds — never 0,
// which is the operator's explicit "this cost is complete".
const tagOf = (db, id) =>
  db.prepare('SELECT cost_incomplete FROM store_products WHERE id = ?').get(id).cost_incomplete;

// ═══════════════════════════════════════════════════════════════════════════
section('1. The seed ticks exactly the case it can prove');
// ═══════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const food = material(db, 'Zhoug', 'food');
  const jar  = material(db, 'Glass jar 225ml', 'packaging');

  const contentsOnly = product(db, 'Zhoug — contents, no packaging');
  line(db, contentsOnly, food);

  const complete = product(db, 'Zhoug — contents and a jar');
  line(db, complete, food); line(db, complete, jar);

  const packagingOnly = product(db, 'A jar and nothing inside');
  line(db, packagingOnly, jar);

  const noList = product(db, 'Dried Sweet Banana — typed cost');

  const deletedMaterial = product(db, 'One line whose material was deleted');
  db.prepare('INSERT INTO product_build_lines (product_id, ingredient_id, name_en, qty, unit) VALUES (?,NULL,?,?,?)')
    .run(deletedMaterial, 'gone', 1, 'g');

  db.prepare(SEED_SQL).run();

  check('a build list with contents and no packaging line is ticked', () =>
    assert.strictEqual(tagOf(db, contentsOnly), 1));
  check('a list that already carries packaging is left unanswered', () =>
    assert.strictEqual(tagOf(db, complete), null));
  // Its cost never publishes (lib/product-build-cost.js blocks a packaging-only
  // list), so it shows an em dash and claims nothing. Its problem is missing
  // CONTENTS, which this tag does not name — two problems, two sentences.
  check('a packaging-only list is left unanswered — its margin is already an em dash', () =>
    assert.strictEqual(tagOf(db, packagingOnly), null));
  // Ash's call, made explicitly: do not guess on a typed figure.
  check('a product with no build list at all is left unanswered', () =>
    assert.strictEqual(tagOf(db, noList), null));
  // Mirrors lib/product-build-cost.js: a line with no kind to read counts as
  // CONTENTS. Two readings of "is this line packaging" would drift apart.
  check('a line whose material was deleted counts as contents, so the product is ticked', () =>
    assert.strictEqual(tagOf(db, deletedMaterial), 1));
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. The seed never overwrites the operator');
// ═══════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const food = material(db, 'Zhoug', 'food');
  const cleared = product(db, 'Contents only, but the operator says it is fine');
  line(db, cleared, food);
  // The reseller case: no packaging, and correct rather than unfinished. The
  // operator has already answered, and a second run of the seed must not
  // reopen the question. This is what the column's third state buys — a stored
  // 0 is an answer, and only an unanswered NULL is eligible.
  db.prepare(SEED_SQL).run();
  check('the seed ticks it on the first run', () =>
    assert.strictEqual(tagOf(db, cleared), 1));
  db.prepare('UPDATE store_products SET cost_incomplete = 0 WHERE id = ?').run(cleared);
  db.prepare(SEED_SQL).run();
  check('a tag the operator cleared stays cleared when the seed runs again', () =>
    assert.strictEqual(tagOf(db, cleared), 0));
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The Products list marks the figure it qualifies');
// ═══════════════════════════════════════════════════════════════════════════

// ── DOM stub ────────────────────────────────────────────────────────────────
// 09-products.js binds listeners to real ids at load, so every lookup has to
// hand back a node. Nothing here asserts against what we meant to render — the
// checks read the string the shipped function returned.
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, readOnly: false,
    style: {}, hidden: false, children: [], placeholder: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { if (c && c.id) nodes.set(c.id, c); this.children.push(c); return c; },
    insertAdjacentHTML(_p, h) { this.innerHTML += h; },
    closest: () => null, querySelector: () => makeNode(''), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}
function node(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); }

const sandbox = {
  console,
  document: {
    getElementById: id => node(id),
    querySelector: () => makeNode('q'),
    querySelectorAll: () => [],
    addEventListener() {}, createElement: () => makeNode(''),
    body: { classList: { contains: () => false, add() {}, remove() {} } },
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error('no network')),
  // The shared helpers 09-products.js expects from its sibling files.
  escapeHtml: s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  cuT: (en) => en,
  fmt: n => Number(n).toFixed(2),
  toast() {}, api: () => Promise.resolve({}), logActivity() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(PRODUCTS_JS, sandbox, { filename: '09-products.js' });

const marginCell = u => sandbox._paMarginCell(u);
const unit = (p, members) => (members ? { group: true, p, members } : { group: false, p });
// ¥100 against a ¥20 cost — 80.0%, well clear of any rounding.
const P = extra => ({ sell_price: 100, unit_cost: 20, ...extra });
const MARK = 'pa-mgn-warn';

check('an untagged product renders exactly the cell it always did — no mark', () => {
  const html = marginCell(unit(P()));
  assert.ok(html.includes('80.0%'), 'the figure is gone: ' + html);
  assert.ok(!html.includes(MARK), 'an untagged row grew a mark: ' + html);
  assert.ok(!html.includes('pa-mgn-flag'), 'an untagged row grew a wrapper: ' + html);
});

check('a tagged product keeps its figure AND carries the mark', () => {
  const html = marginCell(unit(P({ cost_incomplete: 1 })));
  assert.ok(html.includes('80.0%'), 'the figure was withheld — it must still show: ' + html);
  assert.ok(html.includes(MARK), 'no mark on a tagged row: ' + html);
});

check('the mark says what it means, for a mouse and for a screen reader', () => {
  const html = marginCell(unit(P({ cost_incomplete: 1 })));
  assert.ok(/title="[^"]*not complete[^"]*"/.test(html), 'no readable title: ' + html);
  assert.ok(/aria-label="[^"]*not complete[^"]*"/.test(html), 'no aria-label: ' + html);
});

// An em dash already answers "unknown" and claims nothing, so a warning beside
// it would be a second answer to a question the cell has stopped asking.
check('no cost, no mark — an em dash is not marked', () => {
  const html = marginCell(unit({ sell_price: 100, unit_cost: null, cost_incomplete: 1 }));
  assert.ok(html.includes('—'), 'expected an em dash: ' + html);
  assert.ok(!html.includes(MARK), 'an em dash was marked: ' + html);
});

// The cell folds a family into one figure, so one member's partial cost is
// already inside the number shown.
check('a variant family is marked when ANY member is tagged', () => {
  const members = [P(), P({ cost_incomplete: 1 })];
  const html = marginCell(unit(members[0], members));
  assert.ok(html.includes(MARK), 'a family hid one member’s tag: ' + html);
});
check('a variant family with no tagged member is not marked', () => {
  const members = [P(), P()];
  assert.ok(!marginCell(unit(members[0], members)).includes(MARK));
});

// Both lines are drawn from the same cost, so the tag qualifies the cell, not
// one of its rows — one mark, and the two figures keep their own alignment.
check('the two-figure Meituan cell carries ONE mark, outside both rows', () => {
  const p = P({ cost_incomplete: 1, mt_revenue: 400, mt_units: 10 });
  const html = marginCell(unit(p));
  assert.ok(html.includes('List') && html.includes('Meituan'), 'expected both lines: ' + html);
  assert.strictEqual(html.split(MARK).length - 1, 1, 'the mark was painted twice: ' + html);
  assert.ok(html.indexOf(MARK) < html.indexOf('pa-mgn2'), 'the mark landed inside the rows: ' + html);
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The editor round trip — tick it, and the tag reaches the server');
// ═══════════════════════════════════════════════════════════════════════════

check('the editor has the checkbox the list reads', () =>
  assert.ok(ADMIN_HTML.includes('id="pd-cost-incomplete"'),
    'no cost_incomplete checkbox in retail-admin.html'));

check('ticking it puts cost_incomplete: 1 in the saved body', () => {
  node('pd-cost-incomplete').checked = true;
  assert.strictEqual(sandbox.pdCollectBody().body.cost_incomplete, 1);
});

// Clearing the tag is as much a statement as setting it ("I have checked this
// one and it is complete"), so it must be SENT rather than omitted when false.
check('unticking it sends 0 rather than dropping the key', () => {
  node('pd-cost-incomplete').checked = false;
  const body = sandbox.pdCollectBody().body;
  assert.ok('cost_incomplete' in body, 'the key was dropped when false');
  assert.strictEqual(body.cost_incomplete, 0);
});

check('the server accepts the field on a product PATCH', () =>
  assert.ok(/if \('cost_incomplete' in body\)/.test(RETAIL_JS),
    'routes/retail.js does not write cost_incomplete'));

// A mark that only appeared once the editor had been opened would be absent on
// exactly the rows nobody has looked at — which is every row that needs it.
check('the products list query carries the column', () => {
  // Anchored on the list query's own FROM clause and read BACKWARDS, so this
  // cannot pass on some other SELECT that happens to mention the same columns.
  const from = RETAIL_JS.indexOf('FROM store_products p WHERE COALESCE(is_active, 1) = 1');
  assert.notStrictEqual(from, -1, 'the products list query has moved');
  const select = RETAIL_JS.slice(RETAIL_JS.lastIndexOf('SELECT', from), from);
  assert.ok(select.includes('cost_incomplete'),
    'the list SELECT does not carry cost_incomplete');
});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
