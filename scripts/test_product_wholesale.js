#!/usr/bin/env node
/* §185 — wholesale counts in the product rankings. DECIDED BY ASH, asked in
   terms and answered in one word: *"should wholesale count in top products?"* /
   *"yes"*.

   TWO THINGS WERE WRONG AND ONLY ONE OF THEM WAS THE EXCLUSION. The dashboard's
   Top products and a product's own Sales card dropped gzgrocery outright, which
   is the half Ash decided. The catalogue highlights already counted it — but off
   `retail_stock_ledger`, the record §184 established is the wrong one: dated by
   when the daemon wrote the row rather than by the order, and carrying no money.
   So a units tile and a revenue tile could disagree about which week a case
   belonged to, and `goingNowhere` needed a second `NOT IN` to ask one question.

   WHAT IS ASSERTED. The routes' own SQL, sliced out and run — never
   transcribed. And the asymmetry that must SURVIVE: a gzgrocery mirror carries
   no `customer_id`, so the customer reads keep excluding it and a wholesale
   pickup is never counted as a person. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const financeWindow = require(path.join(ROOT, 'lib', 'finance-window'));

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const TZ = '+8 hours';
const PDATEO = `date(COALESCE(o.paid_at, o.placed_at), '${TZ}')`;
const NOTGZO = "COALESCE(o.channel,'') != 'gzgrocery'";
const PAIDO_ALL = financeWindow.PAID_O;
const PAIDO_STOREFRONT = `${financeWindow.PAID_O} AND ${NOTGZO}`;
const FROM = '2026-08-01', TO = '2026-08-31';

/** Slice a prepared statement's SQL out of the route by a unique anchor. */
function sqlAfter(anchor) {
  const at = ROUTE.indexOf(anchor);
  assert.ok(at > 0, `anchor moved: ${anchor}`);
  const start = ROUTE.indexOf('`', at) + 1;
  return ROUTE.slice(start, ROUTE.indexOf('`', start));
}
/* `${PAIDO}` MEANS DIFFERENT THINGS IN THE TWO ROUTES, so the binder is told
   which. On the dashboard it is still storefront-only, because the customer
   reads share it; in highlights §185 redefined it to the bare allow-list. A
   binder that mapped both to the same predicate could not tell a Top products
   query that had slipped back to `${PAIDO}` from one that had not — which is
   exactly the regression this file exists to catch, and the first draft of it
   could not. The declaration each route actually carries is asserted below. */
const bindWith = (sql, paido) => sql
  .replace(/\$\{PAIDO_ALL\}/g, PAIDO_ALL)
  .replace(/\$\{PAIDO\}/g, paido)
  .replace(/\$\{PDATEO\}/g, PDATEO)
  // The photo fallback is a helper of its own and is not what this file tests;
  // bound to a constant so the ranking SQL RUNS. Left unbound it reaches SQLite
  // as a literal `$` and the suite reports a parse error where it means "the
  // ranking is wrong" — the same trap §184's suite fell into and records.
  .replace(/\$\{hasImageFallbackSql\('p'\)\}/g, '0');
const bindDash = (sql) => bindWith(sql, PAIDO_STOREFRONT);
const bindHighlights = (sql) => bindWith(sql, PAIDO_ALL);

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY, status TEXT, channel TEXT, total REAL,
      customer_id INTEGER, paid_at DATETIME, placed_at DATETIME,
      replacement_for_order_id INTEGER);
    CREATE TABLE retail_order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, image_url TEXT,
      qty REAL, line_total REAL);
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT,
      image_url TEXT, image_data BLOB, updated_at DATETIME,
      is_published INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      sell_price REAL, top_category TEXT, created_at DATETIME);
  `);
  db.prepare(`INSERT INTO store_products (id,name_en,sell_price,top_category,created_at)
              VALUES (1,'Case of tea',50,'Tea','2026-01-01')`).run();
  const o = db.prepare(`INSERT INTO retail_orders (id,status,channel,total,customer_id,paid_at)
                        VALUES (?,?,?,?,?, '2026-08-10 03:00:00')`);
  const i = db.prepare(`INSERT INTO retail_order_items (order_id,product_id,name_en,qty,line_total)
                        VALUES (?,?,?,?,?)`);
  o.run(1, 'paid', 'wechat', 100, 7);          i.run(1, 1, 'Case of tea', 2, 100);
  o.run(2, 'delivered', 'gzgrocery', 900, null); i.run(2, 1, 'Case of tea', 18, 900);
  return db;
}

console.log('\n1 · Top products ranks wholesale beside the storefront');

const topSql = bindDash(sqlAfter('const topProducts = tdb().prepare('));
const top = fixture().prepare(topSql).all(FROM, TO);

it('a gzgrocery mirror line is IN the ranking', () => {
  assert.strictEqual(top.length, 1, 'the two channels must fold onto one product row');
  assert.strictEqual(top[0].units, 20, '2 storefront + 18 wholesale');
  assert.strictEqual(top[0].revenue, 1000, '¥100 + ¥900 — pre-§185 this was ¥100');
});

it('it ranks on the MIRROR, so the money is the price of the day', () => {
  // §184 one level down: the ledger carries no price and would have to be valued
  // live, which moves a past month. `line_total` was written at the sale.
  assert.ok(/i\.line_total/.test(topSql), 'the ranking no longer reads the line total');
  assert.ok(!/retail_stock_ledger/.test(topSql), 'the ranking is back on the ledger');
});

console.log('\n2 · the customer reads keep excluding it, and that must not drift');

it('top customers still carries the gzgrocery exclusion', () => {
  const sql = sqlAfter('const topCustomers = tdb().prepare(');
  assert.ok(/\$\{PAIDO\}/.test(sql) && !/\$\{PAIDO_ALL\}/.test(sql),
    'a wholesale pickup has no customer_id — counting it here counts a case as a person');
});

it('the two predicates are declared apart, not one widened', () => {
  // §325: each may be wrapped in scopedPO(), the dashboard's store narrowing,
  // which hands the predicate back untouched when no store is chosen
  // (scripts/test_dashboard_store_scope.js pins that). What is pinned here is
  // unchanged: two declarations, and only PAIDO carries the exclusion.
  assert.ok(/const PAIDO_ALL = (?:scopedPO\()?financeWindow\.PAID_O\)?;/.test(ROUTE),
    'PAIDO_ALL is gone — the product reads and the customer reads have merged');
  assert.ok(/const PAIDO = (?:scopedPO\()?`\$\{financeWindow\.PAID_O\} AND \$\{NOTGZO\}`\)?;/.test(ROUTE),
    'PAIDO was widened instead, which drags the customer reads with it');
});

console.log('\n3 · catalogue highlights read ONE record now');

const HIGHLIGHTS = (() => {
  const at = ROUTE.indexOf("router.get('/api/retail-admin/products/highlights'");
  assert.ok(at > 0, 'the highlights route moved');
  return ROUTE.slice(at, ROUTE.indexOf("\nrouter.", at + 10));
})();

it('the wholesale LEDGER read is gone from this route entirely', () => {
  assert.ok(!/retail_stock_ledger/.test(codeOnly(HIGHLIGHTS)),
    'highlights is valuing the ledger again — the §184 defect, one level down');
});

it('highlights declares PAIDO as the bare allow-list — what the binder assumes', () => {
  assert.ok(/const PAIDO\s*=\s*financeWindow\.PAID_O;/.test(HIGHLIGHTS),
    'highlights re-excluded gzgrocery, and the units assertion below would not see it');
});

it('units come from the order lines, gzgrocery among them', () => {
  const m = HIGHLIGHTS.match(/const unitsSql = `([\s\S]*?)`;/);
  assert.ok(m, 'the units query moved');
  const db = fixture();
  const rows = db.prepare(bindHighlights(m[1]).replace(/\$\{LIVE\}/g,
    'p.is_published = 1 AND COALESCE(p.is_active, 1) = 1')).all(FROM, TO);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].units, 20, 'the wholesale case is missing from the units tile');
});

it('goingNowhere asks ONE question, not two', () => {
  const m = HIGHLIGHTS.match(/const goingNowhereIds = tdb\(\)\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, 'the goingNowhere query moved');
  assert.strictEqual((m[1].match(/NOT IN/g) || []).length, 1,
    'the second exclusion is back — two records answering one question');
});

console.log('\n4 · a product’s own Sales card agrees with the list it opened from');

it("products/:id/sales counts wholesale too", () => {
  const at = ROUTE.indexOf("router.get('/api/retail-admin/products/:id/sales'");
  assert.ok(at > 0, 'the per-product sales route moved');
  const body = ROUTE.slice(at, ROUTE.indexOf('\nrouter.', at + 10));
  assert.ok(/const PAIDO\s*=\s*financeWindow\.PAID_O;/.test(body),
    'the card still drops gzgrocery while the ranking above it counts it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
