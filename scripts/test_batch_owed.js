#!/usr/bin/env node
/**
 * §84 — what today's batch owes, and the two doors that change it.
 *
 *   node scripts/test_batch_owed.js
 *
 * THE GAP THIS CLOSES, reported by Ash as the routine the §74/§80 pre-order
 * rule depends on: "in the morning when kitchen come to work they already see
 * how many fresh meals and wraps need to be prepared and they will add those
 * extra to the batch they are about to do." They could not — 厨房制作队列 renders
 * REQUESTS somebody typed, no kitchen route reads `retail_order_items` at all,
 * and the dashboard's waiting-orders card counts orders rather than units and
 * excludes all three platforms by SQL.
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE IS THAT THE NUMBER STAYS TRUE AT BOTH
 * ENDS. Any suite can prove "a negative shelf is reported". The decision is
 * narrower and has two halves that pull in opposite directions:
 *
 *   • the shelf is ALLOWED to go negative, because −18 is how the system says
 *     eighteen were sold and never held, and it is the only record they are
 *     owed (§39, and §84 unclamping the Meituan and Eleme ingests);
 *   • and that negative must NEVER reach a platform, because a platform cannot
 *     hold a debt — so the floor moves to the publish boundary and lives
 *     nowhere else.
 *
 * A change that re-clamped the ingest would still pass a "negative is reported"
 * suite. A change that dropped the publish floor would too. Both are cases here.
 *
 * Runs against the real sqlite database (data/roots.db, created by database.js
 * on require and gitignored) with seeded rows, the same arrangement as
 * test_fresh_today_batch.js.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const owedLib = require(path.join(ROOT, 'lib', 'batch-owed.js'));
const bundleStock = require(path.join(ROOT, 'lib', 'bundle-stock.js'));

const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a dev database's own rows are never touched.
const STORE_A = 9411;
const STORE_B = 9412;
const P_WRAP  = 9511;   // batch-made — the kitchen cooks this
const P_BOWL  = 9512;   // batch-made
const P_OIL   = 9513;   // NOT batch-made — a debt here is the warehouse's
const P_GONE  = 9514;   // batch-made but archived
const ORDER   = 9611;

function setStock(storeId, productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(storeId, productId, qty);
}

function park(orderId, storeId, lines, status = 'awaiting_restock') {
  db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(orderId);
  db.prepare('DELETE FROM retail_orders WHERE id = ?').run(orderId);
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, store_id, status, channel, subtotal, total)
     VALUES (?,?,?,?,'wechat',0,0)`
  ).run(orderId, `TB${orderId}`, storeId, status);
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,0,0)`
  );
  for (const l of lines) ins.run(orderId, l.product_id, 'x', 'x', l.qty);
}

function clearAll() {
  db.prepare('DELETE FROM retail_order_items WHERE order_id IN (?,?)').run(ORDER, ORDER + 1);
  db.prepare('DELETE FROM retail_orders WHERE id IN (?,?)').run(ORDER, ORDER + 1);
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?,?,?)')
    .run(P_WRAP, P_BOWL, P_OIL, P_GONE);
}

function seed() {
  clearAll();
  db.prepare('DELETE FROM store_products WHERE id IN (?,?,?,?)').run(P_WRAP, P_BOWL, P_OIL, P_GONE);
  // SKUs are UNIQUE across the catalogue, and this suite shares a dev database
  // with every other one. Clearing by sku as well as by id means a half-torn-down
  // run of this file cannot make the next one fail on a constraint.
  db.prepare("DELETE FROM store_products WHERE sku IN ('9-511','9-512','9-513','9-514')").run();
  db.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE_A, STORE_B);
  const store = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,1)`
  );
  store.run(STORE_A, 'tbo-a', 'Tianhe', '天河', '广州市', '天河区');
  store.run(STORE_B, 'tbo-b', 'Yuexiu', '越秀', '广州市', '越秀区');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,1,?)`
  );
  prod.run(P_WRAP, 'Pesto Wrap', '青酱卷',   '9-511', 48, 1, 1);
  prod.run(P_BOWL, 'Beef Bowl',  '牛肉饭',   '9-512', 58, 1, 1);
  prod.run(P_OIL,  'Olive Oil',  '橄榄油',   '9-513', 88, 0, 1);
  prod.run(P_GONE, 'Old Wrap',   '旧卷',     '9-514', 48, 1, 0);
}

const rowFor = (rows, storeId, productId) =>
  rows.find((r) => r.store_id === storeId && r.product_id === productId) || null;

seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · a shelf that owes nothing says nothing');
{
  it('a healthy shelf is simply absent — the list is what is owed, not a report', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, 12);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
    assert.strictEqual(owedLib.owedTotal(db, STORE_A), 0);
  });
  it('a shelf at exactly zero is not a debt — it is an empty shelf', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, 0);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
  it('a product with NO stock row at that store is not in debt either', () => {
    clearAll();   // no row inserted at all
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · the negative shelf — the channels\' debt');
{
  it('minus eighteen is eighteen owed, and it is named as coming from the shelf', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -18);
    const r = rowFor(owedLib.owedAt(db, STORE_A), STORE_A, P_WRAP);
    assert.ok(r, 'the wrap is listed');
    assert.strictEqual(r.owed, 18);
    assert.strictEqual(r.from_shelf, 18);
    assert.strictEqual(r.from_parked, 0);
  });
  it('the name is today\'s product name, not an order line\'s snapshot', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -3);
    const r = rowFor(owedLib.owedAt(db, STORE_A), STORE_A, P_WRAP);
    assert.strictEqual(r.name_en, 'Pesto Wrap');
    assert.strictEqual(r.name_cn, '青酱卷');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · the parked order — the mini app\'s debt, which never touches the shelf');
{
  it('an awaiting_restock order is counted from its LINES, the shelf being untouched', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, 0);            // §80 parks holding no stock
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 4 }]);
    const r = rowFor(owedLib.owedAt(db, STORE_A), STORE_A, P_WRAP);
    assert.strictEqual(r.owed, 4);
    assert.strictEqual(r.from_parked, 4);
    assert.strictEqual(r.from_shelf, 0);
  });
  it('one order carrying two fresh products owes on both — the kitchen makes each', () => {
    clearAll();
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 2 }, { product_id: P_BOWL, qty: 5 }]);
    const rows = owedLib.owedAt(db, STORE_A);
    assert.strictEqual(rowFor(rows, STORE_A, P_WRAP).owed, 2);
    assert.strictEqual(rowFor(rows, STORE_A, P_BOWL).owed, 5);
  });
  it('a PAID order is not a debt — it took its stock at commit', () => {
    clearAll();
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 9 }], 'paid');
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
  it('…nor is one still unpaid: nothing is promised to anybody yet', () => {
    clearAll();
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 9 }], 'pending_payment');
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
  it('the counted status is ONE value, and it is exported so it cannot widen quietly', () => {
    assert.strictEqual(owedLib.OWED_ORDER_STATUS, 'awaiting_restock');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · the two terms add, and add ONCE');
{
  it('oversold on a platform AND parked in the app is one pile of wraps, not two rows', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -18);                          // Meituan took them
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 4 }]);  // and the app parked more
    const rows = owedLib.owedAt(db, STORE_A);
    const mine = rows.filter((r) => r.product_id === P_WRAP);
    assert.strictEqual(mine.length, 1, 'ONE row for one product');
    assert.strictEqual(mine[0].owed, 22);
    assert.strictEqual(mine[0].from_shelf, 18);
    assert.strictEqual(mine[0].from_parked, 4);
  });
  it('the total is units, not products — "30 to make" is what an operator can act on', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -18);
    setStock(STORE_A, P_BOWL, -12);
    assert.strictEqual(owedLib.owedTotal(db, STORE_A), 30);
    assert.strictEqual(owedLib.owedAt(db, STORE_A).length, 2);
  });
  it('heaviest first — the kitchen reads the top of the list', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -3);
    setStock(STORE_A, P_BOWL, -19);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A).map((r) => r.product_id), [P_BOWL, P_WRAP]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · what is NOT the kitchen\'s to cook');
{
  it('a negative on a product nobody cooks is a different problem, and not listed', () => {
    clearAll();
    setStock(STORE_A, P_OIL, -40);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), [],
      'is_batch_made = 0 stays with the dashboard out-of-stock row');
  });
  it('an archived product is not cooked for', () => {
    clearAll();
    setStock(STORE_A, P_GONE, -7);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
  it('a parked line on a product nobody cooks is not the kitchen\'s either', () => {
    clearAll();
    park(ORDER, STORE_A, [{ product_id: P_OIL, qty: 6 }]);
    assert.deepStrictEqual(owedLib.owedAt(db, STORE_A), []);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · two shops, two numbers');
{
  it('a store scope answers for that store alone', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -5);
    setStock(STORE_B, P_WRAP, -11);
    assert.strictEqual(owedLib.owedTotal(db, STORE_A), 5);
    assert.strictEqual(owedLib.owedTotal(db, STORE_B), 11);
  });
  it('no scope answers for both, and keeps them apart — a kitchen cooking for two needs both', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -5);
    setStock(STORE_B, P_WRAP, -11);
    const rows = owedLib.owedAt(db).filter((r) => r.product_id === P_WRAP);
    assert.strictEqual(rows.length, 2, 'one row per store, never merged');
    assert.strictEqual(rowFor(rows, STORE_A, P_WRAP).owed, 5);
    assert.strictEqual(rowFor(rows, STORE_B, P_WRAP).owed, 11);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · the debt is allowed to exist, and must never be exported');
{
  it('a platform is told zero, never minus eighteen — the floor is at the publish boundary', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, -18);
    assert.strictEqual(bundleStock.sellableAt(db, STORE_A, P_WRAP), 0,
      'sellableAt floors: a platform cannot hold a debt');
    assert.strictEqual(bundleStock.rawStockAt(db, STORE_A, P_WRAP), -18,
      '…while the raw shelf still carries it, which is the fact the kitchen reads');
  });
  it('a real shelf is passed through untouched — the floor changes nothing else', () => {
    clearAll();
    setStock(STORE_A, P_WRAP, 7);
    assert.strictEqual(bundleStock.sellableAt(db, STORE_A, P_WRAP), 7);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · the ingest no longer destroys the fact (source assertions)');
{
  const mt = fs.readFileSync(path.join(ROOT, 'routes/meituan-internal.js'), 'utf8');
  const el = fs.readFileSync(path.join(ROOT, 'routes/eleme-internal.js'), 'utf8');

  it('no Meituan or Eleme stock write clamps at zero any more', () => {
    // The clamp is what §39 called "recorded debt, per-channel work". Both the
    // arrival path and the uncancel re-deduction carried one; a debt lost on the
    // second is lost as completely as one lost on the first.
    assert.ok(!/newPhysicalQty:\s*Math\.max\(0,/.test(mt), 'meituan-internal has no clamped write');
    assert.ok(!/newPhysicalQty:\s*Math\.max\(0,/.test(el), 'eleme-internal has no clamped write');
  });
  it('…and they deduct by DELTA, so the figure is not computed from a stale read', () => {
    assert.ok(/deltaQty:\s*-took/.test(mt) && /deltaQty:\s*-took/.test(el));
    assert.ok(/deltaQty:\s*-packDeduct\(/.test(mt) && /deltaQty:\s*-packDeduct\(/.test(el));
  });
  it('the oversell flag survives — the shelf saying it is not a reason to stop saying it', () => {
    assert.ok(/oversold\.push\(/.test(mt) && /oversold\.push\(/.test(el));
    assert.ok(/order_oversold/.test(mt) && /order_oversold/.test(el));
  });
  it('gzgrocery is left alone on purpose — an inferred pickup is not an order line', () => {
    const gy = fs.readFileSync(path.join(ROOT, 'routes/guanyi-admin.js'), 'utf8');
    assert.ok(/Math\.max\(0,\s*curQty\s*-/.test(gy),
      'the Guanyi pickup path still clamps; a debt from an inference that overshot '
      + 'is a phantom the kitchen would cook for');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · the two doors out of a negative');
{
  const inv = fs.readFileSync(path.join(ROOT, 'routes/retail-inventory.js'), 'utf8');

  it('the batch clears it silently, because Add stock passes a delta', () => {
    // −18 + 40 = 22, with no reset step. This is the door Ash's standing
    // instruction to the kitchen already names: 做好一批,马上加库存.
    const prod = fs.readFileSync(path.join(ROOT, 'routes/retail-production.js'), 'utf8');
    assert.ok(/deltaQty:\s*madeQty/.test(prod), 'Log a batch adds a delta');
    assert.ok(/deltaQty:\s*d,/.test(inv), 'Add stock adds a delta');
  });
  it('the RECOUNT door is asked about — it is the one that would erase the debt', () => {
    assert.ok(/error:\s*'recount_clears_debt'/.test(inv));
    assert.ok(/curQty\s*<\s*0\s*&&\s*newQty\s*>\s*curQty/.test(inv),
      'the guard fires on raising a count across zero, which is what clears it');
  });
  it('…and it is NOT gated on addMode — a warehouse recount erases it identically', () => {
    const at = inv.indexOf("error: 'recount_clears_debt'");
    assert.ok(at > -1);
    const branch = inv.slice(Math.max(0, at - 700), at);
    assert.ok(!/addMode\s*&&/.test(branch.slice(branch.lastIndexOf('if ('))),
      'the debt guard does not carry addMode');
  });
  it('…and it is its own word, not §46\'s miscount — nothing was counted wrong', () => {
    const grant = fs.readFileSync(path.join(ROOT, 'lib/quick-stock-grant.js'), 'utf8');
    assert.ok(/RECOUNT_CLEARS_DEBT\s*=\s*'clears_debt'/.test(grant));
    assert.ok(/RECOUNT_MISCOUNT\s*=\s*'miscount'/.test(grant), 'and §46\'s word is untouched');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('10 · the module stays a stock question (§80\'s line, held)');
{
  it('batch-owed learns no production cadence', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/batch-owed.js'), 'utf8');
    assert.ok(!/batchScheduleCfg|ready_hour|todaysBatchStillComing/.test(src),
      'owed units are owed whether or not today is a cooking day; the cadence is the caller\'s');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('11 · the block on the phone, run as shipped');
{
  const vm = require('vm');
  const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

  /* The same brace-walking slice test_phone_dashboard.js uses, and for the same
     reason: the assertions below run the SHIPPED function rather than a copy of
     it, so a restructure of the block turns these red instead of leaving them
     passing against code nobody ships. */
  function sliceBlock(src, anchor) {
    const start = src.indexOf(anchor);
    assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
    const open = src.indexOf('{', start + anchor.length);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces after ${anchor}`);
  }

  const SRC = [
    'const escAttr=v=>String(v==null?\'\':v).replace(/&/g,\'&amp;\').replace(/"/g,\'&quot;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\');',
    sliceBlock(M, 'function kqOwed()'),
  ].join(';\n');

  const owedHtml = (rows, { multi = false, lang = 'en' } = {}) => {
    const ctx = {
      state: { owed: { rows, multi } },
      T: (en, cn) => (lang === 'en' ? en : cn),
      LANG: lang, String, Number,
    };
    vm.createContext(ctx);
    vm.runInContext(SRC + ';\nthis.__out = kqOwed();', ctx);
    return ctx.__out;
  };

  const ROWS = [
    { product_id: 1, store_id: 1, name_en: 'Pesto Wrap', name_cn: '青酱卷', owed: 18, store_en: 'Tianhe', store_cn: '天河' },
    { product_id: 2, store_id: 2, name_en: 'Beef Bowl',  name_cn: '牛肉饭', owed: 12, store_en: 'Yuexiu', store_cn: '越秀' },
  ];

  it('nothing owed draws nothing — a heading over no rows is worse than no heading', () => {
    assert.strictEqual(owedHtml([]), '');
  });
  it('an answer that has not landed draws nothing either, so it cannot flash on entry', () => {
    assert.strictEqual(owedHtml(null), '');
  });
  it('the heading is the live pair, verbatim', () => {
    // docs/tacet-delivery-vocabulary.md v1.41 — lifted from this same file's
    // kitchen-request purpose picker. If the Chinese here stops matching the
    // Chinese there, one of the two has been edited alone.
    assert.ok(owedHtml(ROWS, { lang: 'cn' }).includes('有客户订单等待'));
    assert.ok(M.includes("'有客户订单等待'"), 'and the source it was lifted from is still live');
  });
  it('the heading does NOT promise today\'s batch — the module cannot know that', () => {
    const cn = owedHtml(ROWS, { lang: 'cn' });
    assert.ok(!/今天|今日|本批/.test(cn),
      'batch-owed knows no cadence; a heading naming today would overclaim on a non-cooking morning');
  });
  it('a row is a name and a numeral, and carries no third word', () => {
    const one = [{ ...ROWS[0] }];
    const html = owedHtml(one);
    assert.ok(html.includes('Pesto Wrap') && html.includes('>18<'));
    assert.ok(!/件|units|to make/i.test(html), 'no unit noun, no verb repeated down every line');
  });
  it('one shop in the answer is not labelled — a label that never varies is not read', () => {
    const html = owedHtml([ROWS[0]], { multi: false });
    assert.ok(!html.includes('Tianhe'));
  });
  it('…and two shops are, because the kitchen has to know which', () => {
    const html = owedHtml(ROWS, { multi: true });
    assert.ok(html.includes('Tianhe') && html.includes('Yuexiu'));
  });
  it('the block renders on the EMPTY queue, which is the case it exists for', () => {
    // The defect: a night of orders with no request raised left the kitchen
    // opening this screen to "Nothing to make" while eighteen were owed.
    const scr = sliceBlock(M, 'function screenKitchenQueue()');
    const at = scr.indexOf("T('Nothing to make','暂无待制作')");
    assert.ok(at > -1, 'the empty state is still there');
    const ret = scr.slice(scr.lastIndexOf('return', at), at);
    assert.ok(/^return owed\+/.test(ret.trim()),
      'the empty-state return leads with the owed block');
  });
  it('…and on the loading and populated returns too — all three carry it', () => {
    const scr = sliceBlock(M, 'function screenKitchenQueue()');
    const returns = [...scr.matchAll(/return (owed\+)?tabs/g)];
    assert.strictEqual(returns.length, 3, 'three list returns');
    assert.ok(returns.every((m) => m[1] === 'owed+'), 'every one of them leads with owed');
  });
  it('it is the ACTIVE tab only — a standing to-do is not what Done is asking', () => {
    const scr = sliceBlock(M, 'function screenKitchenQueue()');
    assert.ok(/const owed=k\.tab==='active'\?kqOwed\(\):''/.test(scr));
  });
  it('entering the screen re-asks, and clears to null rather than to empty', () => {
    // A figure carried from the last time the app was opened is a debt that may
    // already have been cooked; [] would draw a stale answer, null draws nothing.
    const reset = M.slice(M.indexOf("if(route==='kitchenqueue')"));
    const line = reset.slice(0, reset.indexOf('\n', reset.indexOf('state.owed')) + 1);
    assert.ok(/w\.tried=false;\s*w\.rows=null/.test(line), line.trim());
  });
  it('the Home row counts UNITS and opens the queue, gated on that route', () => {
    const fires = sliceBlock(M, 'function opsFires()');
    assert.ok(/c\('batch_owed'\)&&canRoute\('kitchenqueue'\)/.test(fires), 'gated on the door it opens');
    assert.ok(/APP\.cmd\('push','kitchenqueue'\)/.test(fires));
    // The pill is the server's unit total, not the number of preview rows.
    assert.ok(/T\('Customer orders waiting','有客户订单等待'\),\s*\n?\s*c\('batch_owed'\)/.test(fires),
      'the pill reads the count, which the server sums as units');
  });
  it('the server sends that count as units, not as a row tally', () => {
    const rt = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
    assert.ok(/count: owedRows\.reduce\(\(n, r\) => n \+ r\.owed, 0\)/.test(rt),
      '"30 to make" is a morning\'s work; "2 products" is not a quantity');
  });
}

// ── Teardown ───────────────────────────────────────────────────────────────
clearAll();
db.prepare('DELETE FROM store_products WHERE id IN (?,?,?,?)').run(P_WRAP, P_BOWL, P_OIL, P_GONE);
db.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE_A, STORE_B);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
