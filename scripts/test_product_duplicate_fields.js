#!/usr/bin/env node
//
// test_product_duplicate_fields.js — Duplicate carries the whole product.
//
// WHAT THIS IS FOR
// ----------------
// Duplicate is how nearly every product after the first one gets made: open the
// nearest thing already in the catalogue, copy it, change the two fields that
// differ. So a duplicate that drops half the editor is not a small bug — it is
// a product published without its ingredients, without its dressing choices, or
// without the bundle it is supposed to be.
//
// AND THE LOSS IS SILENT IN BOTH DIRECTIONS. The copy opens with Options
// empty, "Not a bundle", no suggested add-ons and a blank Origin — which reads
// exactly like a product that never had any of them, so nobody looks. Then the
// editor's next autosave sends that emptiness back and the columns the copy DID
// carry are cleared too, because the editor saves what it was loaded with. That
// second half is why section 3 checks the RESPONSE and not only the database:
// copying a column server-side and leaving it out of the reply is the same bug
// one step later.
//
// Section 1 is the regression guard and the reason this file will still be
// worth something in a year: it does not list the fields that must be copied,
// it DERIVES them from the PATCH handler — every column the product editor can
// write — and fails when one of them is missing from the duplicate INSERT. A
// new editor field added tomorrow lands in that list on its own. The fields
// that must NOT be copied are listed explicitly, each with the reason, because
// "not copied" is a decision and an undeclared one is indistinguishable from an
// oversight.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * Section 1 reads both handlers out of routes/retail.js.
//   * Sections 2-3 execute the SHIPPED duplicate handler in a vm, against a
//     real in-memory database whose store_products is built by the fork rule
//     and whose option tables come from database.js.
//
// USAGE   node scripts/test_product_duplicate_fields.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT        = path.join(__dirname, '..');
const read        = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RETAIL_JS   = read('routes', 'retail.js');
const DATABASE_JS = read('database.js');
const SCHEMA_SQL  = read('schema.sql');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// ── Cutting the shipped source ──────────────────────────────────────────────
// Brace-matched from an anchor, so a reformat moves the anchor rather than
// silently handing back the wrong span.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  assert.notStrictEqual(open, -1, 'no block after the anchor');
  // Comments are skipped as well as strings: this source is full of prose, and
  // an apostrophe in "the operator's copy" reads as an opening quote otherwise,
  // which swallows every brace after it.
  let depth = 0, mode = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === 'line')  { if (c === '\n') mode = null; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (mode) {                                   // inside a string literal
      if (c === '\\') { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced braces from the anchor');
}
function routeBody(routePath) {
  const at = RETAIL_JS.indexOf(routePath);
  assert.notStrictEqual(at, -1, routePath + ' is not in routes/retail.js');
  const arrow = RETAIL_JS.indexOf('(req, res)', at);
  assert.notStrictEqual(arrow, -1, routePath + ' has no (req, res) handler');
  return braceBlock(RETAIL_JS, arrow);
}
function fnSource(name) {
  const at = RETAIL_JS.indexOf('\nfunction ' + name + '(') + 1;
  assert.notStrictEqual(at, 0, name + ' is not a top-level function in routes/retail.js');
  return RETAIL_JS.slice(at, RETAIL_JS.indexOf('{', at)) + braceBlock(RETAIL_JS, at);
}

const PATCH_BODY = routeBody("'/api/retail-admin/products/:id'");
const DUP_BODY   = routeBody("'/api/retail-admin/products/:id/duplicate'");

// ═══════════════════════════════════════════════════════════════════════════
section('1. Every column the editor can write is copied, or declared not copied');
// ═══════════════════════════════════════════════════════════════════════════

// What the product editor can write, read off the PATCH handler itself: the
// single-column pushes, the two `for (const k of [...])` loops that push a
// column each, and the options tables it saves through saveProductOptions.
const EDITABLE = (() => {
  const out = new Set();
  for (const m of PATCH_BODY.matchAll(/sets\.push\('(\w+) = \?'\)/g)) out.add(m[1]);
  for (const m of PATCH_BODY.matchAll(/for \(const k of \[([\s\S]*?)\]\)/g))
    for (const q of m[1].matchAll(/'(\w+)'/g)) out.add(q[1]);
  if (/saveProductOptions\(/.test(PATCH_BODY)) out.add('options');
  assert.ok(out.size > 20, 'only ' + out.size + ' editable fields found — the scan broke, not the handler');
  return out;
})();

// Deliberately NOT carried into a copy. Each line is a decision; if you remove
// one from here it has to start being copied instead.
const NOT_COPIED = new Map([
  ['sku',          'the copy mints its own DRAFT-XXXXX — a shared code is not a code'],
  ['barcode',      'a barcode names ONE product; two rows sharing one breaks the till'],
  ['stock_qty',    'nothing has been counted for the copy yet'],
  ['is_published', 'a copy starts hidden so a half-edited product never leaks into the shop'],
  ['recipe_id',    'linking a recipe fires a cost recompute; a raw INSERT would not'],
  ['updated_at',   'set by the INSERT itself'],
]);

const COPIED = (() => {
  const at = DUP_BODY.indexOf('INSERT INTO store_products');
  assert.notStrictEqual(at, -1, 'the duplicate handler has no INSERT INTO store_products');
  const cols = DUP_BODY.slice(DUP_BODY.indexOf('(', at) + 1, DUP_BODY.indexOf('VALUES', at));
  const out = new Set(cols.replace(/\)\s*$/, '').split(',').map(s => s.trim()).filter(Boolean));
  // Options are rows in their own tables, not a column on the product.
  if (/INSERT INTO retail_product_options\b/.test(DUP_BODY)) out.add('options');
  return out;
})();

for (const field of [...EDITABLE].sort()) {
  if (NOT_COPIED.has(field)) {
    check(`${field} is deliberately not copied — ${NOT_COPIED.get(field)}`, () =>
      assert.ok(true));
    continue;
  }
  check(`${field} is copied`, () => assert.ok(
    COPIED.has(field),
    `the product editor can set ${field}, but duplicate neither copies it nor declares why not. ` +
    'Add it to the INSERT, or to NOT_COPIED with the reason.'));
}

// The INSERT is written by hand; a column list and a value list that disagree
// bind every field after the gap to the wrong column, which sqlite accepts.
check('the INSERT binds one value per column', () => {
  const at   = DUP_BODY.indexOf('INSERT INTO store_products');
  const sql  = DUP_BODY.slice(at, DUP_BODY.indexOf('`', at));   // to the closing backtick
  const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf('VALUES'))
    .replace(/\)\s*$/, '').split(',').map(s => s.trim()).filter(Boolean);
  const literals = ['is_published', 'is_active', 'created_at', 'updated_at'];
  const marks = (sql.slice(sql.indexOf('VALUES')).match(/\?/g) || []).length;
  assert.strictEqual(marks, cols.length - literals.length,
    `${cols.length} columns (${literals.length} of them written as literals) but ${marks} placeholders`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. A real copy carries the sections the operator filled in');
// ═══════════════════════════════════════════════════════════════════════════

const { openTablesDb, addForkedStoreProducts, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

function freshDb() {
  const db = openTablesDb(DATABASE_JS, ['retail_product_options', 'retail_product_option_choices']);
  addForkedStoreProducts(db, SCHEMA_SQL, DATABASE_JS);
  return db;
}

// better-sqlite3 gives a handle a .transaction(fn); node:sqlite (the fallback
// driver on a bare checkout) does not. The handler under test opens one, so the
// handle it is given grows the same method, running the real BEGIN/COMMIT — the
// copy and its options land together or not at all, which is the property
// section 2 relies on.
function withTransaction(db) {
  if (typeof db.transaction === 'function') return db;
  return new Proxy(db, {
    get(t, k) {
      if (k === 'transaction') return fn => (...a) => {
        t.exec('BEGIN');
        try { const r = fn(...a); t.exec('COMMIT'); return r; }
        catch (e) { try { t.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
      };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// The handler, executed. The helpers it leans on are the real ones where they
// are self-contained (parseFactsCol, loadProductOptions read straight from the
// row / the option tables); the three display helpers below are shared with the
// PATCH handler and covered with it, so here they stand in — what this file is
// about is which fields survive the copy, and every assertion reads either the
// stored row or the JSON the handler replied with.
function runDuplicate(db, id, body) {
  let skuSeq = 0;
  const ctx = {
    require, console, JSON, Number, String, Object, Array, Math, Boolean, parseInt, parseFloat,
    catalogMode: () => 'own',
    tdb: () => withTransaction(db),
    generateRetailSku: () => 'DRAFT-' + String(++skuSeq).padStart(5, '0'),
    imageAspect: () => null,
    logActivity: () => {},
    resolveBundleComponents: v => { try { return JSON.parse(v) || []; } catch { return []; } },
    applyBundleCost: () => {},
    stripProductCosts: (_req, row) => row,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('parseFactsCol') + '\n' + fnSource('loadProductOptions') +
    '\nvar handler = (req, res) => ' + DUP_BODY + ';', ctx);
  let out = null, code = 200;
  ctx.handler(
    { params: { id: String(id) }, body, user: { id: 1, username: 't' }, ip: '::1' },
    { status(c) { code = c; return this; }, json(j) { out = j; return this; } },
  );
  assert.strictEqual(code, 200, 'duplicate replied ' + code + ': ' + JSON.stringify(out));
  assert.ok(out && out.success, 'duplicate did not succeed: ' + JSON.stringify(out));
  return out.data;
}

// One product with every section of "How it's sold" and the Page details filled
// in — the screen the operator is looking at when they press Duplicate.
function seedFullProduct(db) {
  db.prepare(
    `INSERT INTO store_products
       (id, name_en, name_cn, sku, category, top_category, subcategory, sell_price, stock_qty,
        product_facts, bundle, bundle_items, bundle_mode, page_template, notes,
        oos_policy, is_batch_made, low_stock_threshold, unit_cost, is_published, is_active)
     VALUES (1,'Hummus','鹰嘴豆泥','R-100','Dips','Dips','Fresh',38,12,
             ?,?,?,'assembled','tall','fridge shelf 2','backorder_gz',1,5,12.5,1,1)`
  ).run(
    JSON.stringify({ origin: 'Guangzhou, China', ingredients: 'Chickpeas, tahini, lemon' }),
    JSON.stringify({ title_en: 'Goes well with', title_cn: '推荐搭配', ids: [7, 8], price: 0, voucher: '' }),
    JSON.stringify([{ id: 7, qty: 2 }, { id: 8, qty: 1 }]),
  );
  const o1 = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (1,'Dressing','酱料','single',1,0)`).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO retail_product_option_choices (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,'Zhoug','青酱',3,1,9,0)`).run(o1);
  db.prepare(
    `INSERT INTO retail_product_option_choices (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,'None','不要',0,0,NULL,1)`).run(o1);
  const o2 = db.prepare(
    `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (1,'Cutlery?','需要餐具吗?','multi',0,1)`).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO retail_product_option_choices (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
     VALUES (?,'Yes please','需要',0,0,NULL,0)`).run(o2);
  return 1;
}

{
  const db  = freshDb();
  const src = seedFullProduct(db);
  const copy = runDuplicate(db, src, { as_variant: false, label: null });
  const rowOf = id => db.prepare('SELECT * FROM store_products WHERE id = ?').get(id);
  const row = rowOf(copy.id);

  check('the Page details (origin, ingredients) come with it', () =>
    assert.deepStrictEqual(JSON.parse(row.product_facts),
      { origin: 'Guangzhou, China', ingredients: 'Chickpeas, tahini, lemon' }));

  check('Suggested add-ons come with it', () =>
    assert.deepStrictEqual(JSON.parse(row.bundle).ids, [7, 8]));

  check('the Bundle — sold as one recipe and its stock mode come with it', () => {
    assert.deepStrictEqual(JSON.parse(row.bundle_items), [{ id: 7, qty: 2 }, { id: 8, qty: 1 }]);
    assert.strictEqual(row.bundle_mode, 'assembled');
  });

  check('Options come with it — questions, order, and every choice', () => {
    const opts = db.prepare(
      'SELECT id, question_en, question_cn, type, is_required FROM retail_product_options WHERE product_id = ? ORDER BY sort_order'
    ).all(copy.id);
    assert.strictEqual(opts.length, 2, 'expected 2 options on the copy, got ' + opts.length);
    assert.strictEqual(opts[0].question_en, 'Dressing');
    assert.strictEqual(opts[0].question_cn, '酱料');
    assert.strictEqual(opts[0].is_required, 1);
    assert.strictEqual(opts[1].type, 'multi');
    const ch = db.prepare(
      'SELECT label_en, label_cn, price_delta, is_default, stock_product_id FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order'
    ).all(opts[0].id);
    assert.deepStrictEqual(ch.map(c => c.label_en), ['Zhoug', 'None']);
    assert.strictEqual(ch[0].label_cn, '青酱');
    assert.strictEqual(ch[0].price_delta, 3);
    // The paid extra is drawn from a real product's stock; drop the link and the
    // add-on silently stops reserving anything at checkout.
    assert.strictEqual(ch[0].stock_product_id, 9);
  });

  check("the copy's options belong to the copy — the source keeps its own", () =>
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS n FROM retail_product_options WHERE product_id = ?').get(src).n, 2));

  check('the rest of the commercial row comes too (category split, policy, notes, cost)', () => {
    assert.strictEqual(row.top_category, 'Dips');
    assert.strictEqual(row.subcategory, 'Fresh');
    assert.strictEqual(row.oos_policy, 'backorder_gz');
    assert.strictEqual(row.notes, 'fridge shelf 2');
    assert.strictEqual(row.page_template, 'tall');
    assert.strictEqual(row.low_stock_threshold, 5);
    assert.strictEqual(row.unit_cost, 12.5);
  });

  check('identity and state stay fresh: new SKU, no stock, hidden', () => {
    assert.notStrictEqual(row.sku, 'R-100');
    assert.ok(/^DRAFT-/.test(row.sku), 'expected a minted DRAFT- code, got ' + row.sku);
    assert.strictEqual(row.stock_qty, 0);
    assert.strictEqual(row.is_published, 0);
    assert.strictEqual(row.is_active, 1);
  });

  check('a plain duplicate lands standalone, not in the source\'s variant group', () => {
    assert.strictEqual(row.variant_group_id, null);
    assert.strictEqual(row.variant_label, null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The reply hands the editor back what it just copied');
// ═══════════════════════════════════════════════════════════════════════════
// The editor opens the copy straight from this response and its next autosave
// sends back whatever the bundle / add-on sections were loaded with. A field
// copied into the database but missing from the reply is therefore copied and
// then cleared — the same bug, one step later, and harder to see.
{
  const db   = freshDb();
  const src  = seedFullProduct(db);
  const copy = runDuplicate(db, src, { as_variant: false, label: null });

  check('the reply carries the add-ons, parsed', () =>
    assert.deepStrictEqual(copy.bundle && copy.bundle.ids, [7, 8]));
  check('the reply carries the bundle recipe and mode', () => {
    assert.deepStrictEqual(copy.bundle_items, [{ id: 7, qty: 2 }, { id: 8, qty: 1 }]);
    assert.strictEqual(copy.bundle_mode, 'assembled');
  });
  check('the reply carries the options', () =>
    assert.strictEqual((copy.options || []).length, 2));
  check('the reply carries the page details, parsed', () =>
    assert.strictEqual(copy.product_facts && copy.product_facts.origin, 'Guangzhou, China'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. Duplicating as a new size still behaves like a variant');
// ═══════════════════════════════════════════════════════════════════════════
{
  const db  = freshDb();
  const src = seedFullProduct(db);
  db.prepare("UPDATE store_products SET variant_noun_en = 'size', variant_noun_cn = '规格' WHERE id = ?").run(src);
  const copy = runDuplicate(db, src, { as_variant: true, label: '500g' });
  const row  = db.prepare('SELECT * FROM store_products WHERE id = ?').get(copy.id);
  const source = db.prepare('SELECT * FROM store_products WHERE id = ?').get(src);

  check('the copy joins the source\'s group, which the source now owns', () => {
    assert.strictEqual(source.variant_group_id, src);
    assert.strictEqual(row.variant_group_id, src);
  });
  check('the copy wears the label the operator typed', () =>
    assert.strictEqual(row.variant_label, '500g'));
  check('the group\'s axis noun rides along, so the size picker keeps its heading', () => {
    assert.strictEqual(row.variant_noun_en, 'size');
    assert.strictEqual(row.variant_noun_cn, '规格');
  });
  check('a new size still carries the options and page details', () => {
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS n FROM retail_product_options WHERE product_id = ?').get(copy.id).n, 2);
    assert.strictEqual(JSON.parse(row.product_facts).origin, 'Guangzhou, China');
  });
}

// ════════════════════════════════════════════════════════════════════════════
section('5. A copied page says which product it was copied from');
// ════════════════════════════════════════════════════════════════════════════
//
// Copying description_blocks is CORRECT and stays — a 500g/1kg size variant
// wants the same page, which is most of what duplicate is for. What was missing
// is that the copy had no way to SAY so. Nothing in the classic product form
// writes to description_blocks, so a copy whose name, price and description had
// all been changed still opened the Product editor holding the original's
// words, unmarked and unexplained. Reported by Ash, 2026-09-17.
//
// blocks_from_product_id is that mark. It is a fact about the ROW, which is the
// point: the session-local "out of date" nudge died on every reload, and a
// warning you have to re-earn by typing is not a warning about a duplicate.
//
// The other half of the pair — that writing description_blocks clears the mark
// — lives in the PATCH handler and is asserted against its source in
// scripts/test_product_editor_open_freshness.js, rather than standing a second
// vm harness up here for one column.
{
  const db  = freshDb();
  const src = seedFullProduct(db);
  db.prepare('UPDATE store_products SET description_blocks = ? WHERE id = ?')
    .run(JSON.stringify([{ id: 'b1', type: 'hero', title_en: 'Hummus' }]), src);
  const copy = runDuplicate(db, src, { as_variant: false, label: null });
  const row  = db.prepare('SELECT * FROM store_products WHERE id = ?').get(copy.id);

  check('the copy still carries the sections — this is not a regression of that', () =>
    assert.strictEqual(JSON.parse(row.description_blocks)[0].type, 'hero'));
  check('the copy records the product its sections came from', () =>
    assert.strictEqual(row.blocks_from_product_id, src));
  check('the source is not marked — its own page is its own', () =>
    assert.strictEqual(
      db.prepare('SELECT blocks_from_product_id AS m FROM store_products WHERE id = ?').get(src).m, null));
  check('the reply carries the mark, so the dock can warn without a second fetch', () =>
    assert.strictEqual(copy.blocks_from_product_id, src));
}

// A product with no designed page has nothing to be copied FROM, and marking
// its copy would put "came from X" on an empty page — a sentence about nothing.
{
  const db  = freshDb();
  const src = seedFullProduct(db);      // seeded WITHOUT description_blocks
  const copy = runDuplicate(db, src, { as_variant: false, label: null });
  const row  = db.prepare('SELECT * FROM store_products WHERE id = ?').get(copy.id);

  check('copying a product with no sections leaves the mark unset', () =>
    assert.strictEqual(row.blocks_from_product_id, null));
}

// An empty stack is no stack. '[]' is what the list endpoint's has_blocks flag
// already treats as "no sections", and the two must not disagree.
{
  const db  = freshDb();
  const src = seedFullProduct(db);
  db.prepare("UPDATE store_products SET description_blocks = '[]' WHERE id = ?").run(src);
  const copy = runDuplicate(db, src, { as_variant: false, label: null });
  const row  = db.prepare('SELECT * FROM store_products WHERE id = ?').get(copy.id);

  check("an empty '[]' stack counts as no sections, same as has_blocks reads it", () =>
    assert.strictEqual(row.blocks_from_product_id, null));
}

console.log('\n' + (failures ? `${failures} assertion(s) failed` : 'all assertions held'));
process.exit(failures ? 1 : 0);
