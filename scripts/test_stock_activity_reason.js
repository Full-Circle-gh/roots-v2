#!/usr/bin/env node
/**
 * test_stock_activity_reason.js — the stock activity log says WHY a mini-app
 * order's stock moved, and which order it was.
 *
 *   node scripts/test_stock_activity_reason.js
 *
 * WHAT IT GUARDS. Stock leaves the shelf for a mini-app order at one of three
 * moments: at payment (order_commit), when staff press Start preparing
 * (order_prepare), or automatically when a restock covers an order that was
 * waiting for it (awaiting_restock_release). All three rows read "Mini-app" on
 * the Stock activity screen, and the restock release stamps no order number in
 * its note, so two screenshots of the same log looked like two different rules.
 * activityRows() now returns the order number off the ledger's own link, and
 * both screens turn the reason into words.
 *
 * WHAT RUNS. The real activityRows() and ACT_SOURCE_SQL from routes/retail.js,
 * over the real table definitions from database.js; and the real label code
 * from the desktop (public/retail-admin/13-activity.js) and the phone
 * (public/m.html), which must say the same thing in both languages.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/13-activity.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const SRC = retailSource();

function lift(src, re, what) {
  const m = re.exec(src);
  assert.ok(m, `${what} not found`);
  return m[0];
}
const fnAt = (src, name) => {
  const at = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return src.slice(at, src.indexOf('\n}', at) + 2);
};

// ── the real query, on the real tables ────────────────────────────────────
const db = openMemoryDb();
addTables(db, DB_SRC, DB_SRC, ['retail_stores', 'retail_orders', 'retail_stock_ledger']);
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
const SQL_SRC = lift(SRC, /^const ACT_SOURCE_SQL = `[\s\S]*?`;/m, 'ACT_SOURCE_SQL');
const activityRows = new Function('tdb', 'shopSqlShift', `${SQL_SRC}\n${fnAt(SRC, 'activityRows')}\nreturn activityRows;`)(
  () => db, () => '+8 hours');

db.prepare("INSERT INTO retail_stores (id, code, name_en, name_cn) VALUES (1, 'tianhe', 'Tianhe', '天河')").run();
db.prepare("INSERT INTO store_products (id, sku, name_en, name_cn) VALUES (1, '1-440', 'Pesto Wrap', '香蒜卷')").run();
db.prepare("INSERT INTO retail_orders (id, order_no, status, store_id) VALUES (7, 'TC001129', 'paid', 1)").run();
const led = db.prepare(`INSERT INTO retail_stock_ledger
  (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, note) VALUES (1, 1, -1, ?, ?, ?, 4, ?)`);
led.run('awaiting_restock_release', 'retail_orders', 7, null);       // never stamped a note
led.run('order_prepare', 'retail_orders', 7, 'TC001129');            // stamps the order number
led.run('order_commit', 'retail_orders', 7, null);
led.run('meituan_order', null, null, 'MT2026');                      // no order of ours
led.run('count', 'retail_bills', 7, null);                           // another table whose id happens to be 7
const rows = activityRows({ where: '1=1', params: {} }, 50, 0);
const byReason = Object.fromEntries(rows.map((r) => [r.reason, r]));

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. the query hands back the order number');
it('a restock release, which stamped no note, still names its order', () => {
  assert.strictEqual(byReason.awaiting_restock_release.note, null);
  assert.strictEqual(byReason.awaiting_restock_release.order_no, 'TC001129');
});
it('prepare and commit rows name the same order', () => {
  assert.strictEqual(byReason.order_prepare.order_no, 'TC001129');
  assert.strictEqual(byReason.order_commit.order_no, 'TC001129');
});
it('a row with no order of ours has no order number, and keeps its note', () => {
  assert.strictEqual(byReason.meituan_order.order_no, null);
  assert.strictEqual(byReason.meituan_order.note, 'MT2026');
});
it('a row that points at another table is not given an order that shares its id', () => {
  assert.strictEqual(byReason.count.order_no, null);
});
it('the join adds no rows: one ledger row, one result row', () => {
  assert.strictEqual(rows.length, 5);
});

// ── the real label code, desktop and phone ────────────────────────────────
const deskCtx = (lang) => new Function('actT', 'cuT',
  `${lift(DESK, /^const ACT_REASON_NAME = \{[\s\S]*?\n\};/m, 'ACT_REASON_NAME')}\n${fnAt(DESK, 'actContext')}\nreturn actContext;`)(
  (en, cn) => (lang === 'en' ? en : cn), null);
const phoneCtx = (lang) => new Function('T',
  `${lift(PHONE, /^const ACT_REASON=\{[\s\S]*?\]\};/m, 'ACT_REASON')}\n${fnAt(PHONE, 'actContext')}\nreturn actContext;`)(
  (en, zh) => (lang === 'en' ? en : (zh || en)));

const WANT = {
  order_commit:             ['Taken at payment', '付款时扣减'],
  order_prepare:            ['Taken when preparing', '开始备货时扣减'],
  awaiting_restock_release: ['Taken on restock', '已补货，自动扣减'],
  order_reverse:            ['Stock returned', '库存退回'],
  order_reverse_partial:    ['Stock returned', '库存退回'],
  order_reverse_ledger:     ['Stock returned', '库存退回'],
};

console.log('\n2. each reason reads the same on the desktop and the phone');
for (const [reason, [en, zh]] of Object.entries(WANT)) {
  it(`${reason}: "${en}" · "${zh}", then the order`, () => {
    for (const [where, make] of [['desktop', deskCtx], ['phone', phoneCtx]]) {
      assert.strictEqual(make('en')({ reason, source: 'miniapp', order_no: 'TC001129', note: null }), `${en} · TC001129`, where + ' English');
      assert.strictEqual(make('cn')({ reason, source: 'miniapp', order_no: 'TC001129', note: null }), `${zh} · TC001129`, where + ' Chinese');
    }
  });
}

console.log('\n3. everything else reads as it always did');
for (const [where, make] of [['desktop', deskCtx], ['phone', phoneCtx]]) {
  it(`${where}: a platform row shows its own note, not our order number`, () => {
    assert.strictEqual(make('en')({ reason: 'meituan_order', source: 'meituan_tianhe', order_no: 'TC001129', note: 'MT2026' }), 'MT2026');
  });
  it(`${where}: a hand count shows the clerk and the note`, () => {
    assert.strictEqual(make('en')({ reason: 'count', source: 'manual', actor_label: 'Mei', note: 'recount' }), 'Mei · recount');
  });
  it(`${where}: a labelled row with no order number shows the label alone`, () => {
    assert.strictEqual(make('en')({ reason: 'order_commit', source: 'miniapp', order_no: null, note: null }), 'Taken at payment');
  });
  it(`${where}: a mini-app row with a reason we do not label keeps its note`, () => {
    assert.strictEqual(make('en')({ reason: 'order_other', source: 'miniapp', order_no: 'TC001129', note: 'x' }), 'x');
  });
}

console.log('\n4. the two screens carry the same table');
it('desktop and phone list the same reasons', () => {
  const keys = (src, re) => [...lift(src, re, 'table').matchAll(/\b(order_\w+|awaiting_\w+):/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(keys(DESK, /^const ACT_REASON_NAME = \{[\s\S]*?\n\};/m), keys(PHONE, /^const ACT_REASON=\{[\s\S]*?\]\};/m));
  assert.deepStrictEqual(keys(DESK, /^const ACT_REASON_NAME = \{[\s\S]*?\n\};/m), Object.keys(WANT).sort());
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
