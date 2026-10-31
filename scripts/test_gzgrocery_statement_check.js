#!/usr/bin/env node
/**
 * §430 — CHECK GZGROCERY'S OWN STATEMENT SHEET AGAINST OUR ORDERS.
 *
 *   node scripts/test_gzgrocery_statement_check.js
 *
 * A workbook is built here in gzgrocery's own layout — the whole catalogue,
 * Qty filled only for what they took, the price columns as formulas with the
 * values Excel cached, codes typed every way their sheet types them, and the
 * bottom block of what we owe them — then read by lib/gzgrocery-sheet.js and
 * set beside lib/gzgrocery-billing.js over an in-memory database.
 *
 * Pinned: the bottom block is ignored (Ash: "the bottom part need to
 * ignore"); hand-typed codes match the way the order reader matches them;
 * every kind of disagreement is named and sorted first; the totals; the date
 * range read off a file name; the route's permission is the Billing panel's
 * read key; the screen draws mismatches and both languages. No browser, no
 * network — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ExcelJS = require('exceljs');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const { readStatement, compareStatement, rangeFromFilename } = require(path.join(ROOT, 'lib', 'gzgrocery-sheet.js'));
const { billingRows } = require(path.join(ROOT, 'lib', 'gzgrocery-billing.js'));
const capRoutes = fs.readFileSync(path.join(ROOT, 'lib', 'cap-routes.js'), 'utf8');
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'guanyi-admin.js'), 'utf8');
const GY = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '12-guanyi.js'), 'utf8');
const VOCAB = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');

let pass = 0, fail = 0;
const queue = [];
function it(name, fn) { queue.push([name, fn]); }

// ── A sheet in gzgrocery's layout ──────────────────────────────────────────
async function buildSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('总表');
  ws.addRow(['Product Name', 'SKU', '名称', 'Price (GV website)', 'Discount', 'gzgrocery Price', 'Qty', 'Original Total ', 'Subtotal']);
  // [name, sku, 名称, retail, discount, qty]
  const cat = [
    ['Creamy Hummus Served', 'GVF 1-10', 'GVF 1-10中东鹰嘴豆泥（冷藏）', 38, 0.2, 4],
    ['Govegan! Matbucha Salad ', 'GVF 1-15', 'GVF 1-15 沙拉250g,冷藏', 38, 0.2, null],   // not taken
    ['Classic Sour Cream', 'GVF-1-90', 'GVF-1-90经典酸奶油（冷藏）', 38, 0.2, 2],              // dash after GVF
    ['Apple Pie Overnight Oats', 'GVF1-120', 'GVF1-120 苹果绵绵燕麦 250g', 27, 0.2, 1],         // no space
    ['Roasted Pumpkin Soup', 'GVF  1-370', 'GVF  1-370 香烤南瓜汤 330g', 27, 0.2, 2],           // two spaces
    ['GF Buckwheat Bread', 'GV3-252', 'GV3-252 冷冻切片无麸质荞麦面包800g', 49, 0.2, 1],
    ['Dehydrated Sweet & Sour Mango', 'GV 4-200', 'GVF 4-200 酸甜芒果干', 27, 0.2, 3],       // GV in one column, GVF in the other
    ['Dish Soap', 'GV 5-130', 'GV 5-130 西柚精油洗碗液 500ml', 54, 0.25, 1],
  ];
  cat.forEach((c, i) => {
    const n = i + 2;
    const gz = c[3] * (1 - c[4]);
    ws.addRow([c[0], c[1], c[2], c[3], c[4],
      { formula: `D${n}*(1-E${n})`, result: gz }, c[5],
      { formula: `D${n}*G${n}`, result: c[5] ? c[3] * c[5] : 0 },
      { formula: `F${n}*G${n}`, result: c[5] ? gz * c[5] : 0 }]);
  });
  // A formula cell saved without a cached value: the reader works the price out.
  ws.getCell('F9').value = { formula: 'D9*(1-E9)' };
  ws.getCell('I9').value = { formula: 'F9*G9' };
  // Packaging lines with no code, then the block of what we owe them.
  ws.addRow([null, null, '胶带', null, null, 4.5, null, 0, 0]);
  ws.addRow([null, null, null, null, null, null, null, { formula: 'SUM(H2:H11)', result: 0 }, { formula: 'SUM(I2:I11)', result: 0 }]);
  ws.addRow(['Govegan order from Gzgrocery', null, null, 'grocery price ', 'discount', 'GV price', null, null, 'Price']);
  ws.addRow([null, null, '市区送货', 30, 0, 30, null, 0, 0]);
  ws.addRow([null, null, 'Blueberries', 15.8, null, 15.8, 1, 15.8, 15.8]);
  ws.addRow([null, null, '干冰', 4, 0, 4, 5, 20, 20]);
  ws.addRow([null, null, null, null, null, null, null, 'Total', 1000]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Our side ───────────────────────────────────────────────────────────────
function mkDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT, sell_price REAL);
    CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, channel TEXT,
      placed_at TEXT, paid_at TEXT, replacement_for_order_id INTEGER);
    CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, sku TEXT,
      qty INTEGER, pack_units INTEGER NOT NULL DEFAULT 1, unit_price REAL, line_total REAL);
    INSERT INTO store_products VALUES
      (1,'1-10','鹰嘴豆泥','Hummus',38), (2,'1-90','酸奶油','Sour Cream',38), (3,'1-120','燕麦','Oats',27),
      (4,'1-370','南瓜汤','Pumpkin Soup',27), (5,'3-252','荞麦面包','Buckwheat Bread',49),
      (6,'4-200','芒果干','Mango',27), (7,'5-130','洗碗液','Dish Soap',54), (8,'2-170','姜汁','Ginger Juice',23);
  `);
  return db;
}
function order(db, no, at, lines) {
  const id = db.prepare(`INSERT INTO retail_orders (order_no, status, channel, placed_at, paid_at) VALUES (?, 'delivered', 'gzgrocery', ?, ?)`)
    .run(no, at, at).lastInsertRowid;
  for (const [pid, sku, qty, price] of lines) {
    db.prepare(`INSERT INTO retail_order_items (order_id, product_id, sku, qty, unit_price, line_total) VALUES (?,?,?,?,?,?)`)
      .run(id, pid, sku, qty, price, +(qty * price).toFixed(2));
  }
}
const SHIFT = '+480 minutes';

let SHEET;

it('reads only our products they took — the bottom block and packaging are ignored', async () => {
  SHEET = await readStatement(await buildSheet());
  assert.deepStrictEqual(SHEET.lines.map((l) => l.sku), ['1-10', '1-90', '1-120', '1-370', '3-252', '4-200', '5-130']);
  assert.ok(!SHEET.lines.some((l) => /Blueberries|干冰|市区送货|胶带/.test(l.name + l.name_cn)));
  assert.deepStrictEqual(SHEET.skipped.map((x) => x.text), ['Blueberries', '干冰']);
});

it('reads Excel\'s cached price, and works it out when the file has none', () => {
  const hummus = SHEET.lines.find((l) => l.sku === '1-10');
  assert.strictEqual(hummus.gz_price, 30.4);
  assert.strictEqual(hummus.subtotal, 121.6);
  const soap = SHEET.lines.find((l) => l.sku === '5-130');
  assert.strictEqual(soap.gz_price, 40.5);       // 54 × (1 − 25%), no cached value
  assert.strictEqual(soap.subtotal, 40.5);
});

it('hand-typed codes match the way the order reader matches them', () => {
  const ga = require(path.join(ROOT, 'lib', 'gzgrocery-admin.js'));
  for (const l of SHEET.lines) assert.strictEqual(l.sku, ga.extractSku(l.name_cn), l.name_cn);
});

it('names every kind of disagreement, mismatches first, with the orders behind ours', () => {
  const db = mkDb();
  order(db, 'GZ-101', '2026-09-27 03:00:00', [[1, '1-10', 3, 30.4], [2, '1-90', 2, 30.4]]);
  order(db, 'GZ-102', '2026-09-28 05:00:00', [[3, '1-120', 1, 21.6], [4, '1-370', 2, 21.6], [5, '3-252', 1, 39.2]]);
  order(db, 'GZ-103', '2026-09-29 05:00:00', [[6, '4-200', 3, 25], [8, '2-170', 1, 18.4]]);
  const ours = billingRows(db, { from: '2026-09-27', to: '2026-09-30', shift: SHIFT });
  const { rows, totals } = compareStatement(SHEET.lines, ours);
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  assert.strictEqual(by['1-10'].status, 'qty');            // they 4, we 3
  assert.deepStrictEqual(by['1-10'].orders, ['GZ-101']);
  assert.strictEqual(by['4-200'].status, 'price');         // they 21.60, we 25
  assert.strictEqual(by['5-130'].status, 'only_theirs');
  assert.strictEqual(by['2-170'].status, 'only_ours');
  for (const k of ['1-90', '1-120', '1-370', '3-252']) assert.strictEqual(by[k].status, 'ok', k);
  const firstOk = rows.findIndex((r) => r.status === 'ok');
  assert.ok(rows.slice(firstOk).every((r) => r.status === 'ok'), 'a mismatch sorted after a match');
  assert.strictEqual(totals.mismatches, 4);
  assert.strictEqual(totals.their_amount, 121.6 + 60.8 + 21.6 + 43.2 + 39.2 + 64.8 + 40.5);
  assert.strictEqual(totals.our_amount, 91.2 + 60.8 + 21.6 + 43.2 + 39.2 + 75 + 18.4);
  assert.strictEqual(totals.difference, +(totals.their_amount - totals.our_amount).toFixed(2));
});

it('a sheet that matches our orders exactly reports no mismatch', () => {
  const db = mkDb();
  order(db, 'GZ-201', '2026-09-28 05:00:00', SHEET.lines.map((l) => {
    const pid = { '1-10': 1, '1-90': 2, '1-120': 3, '1-370': 4, '3-252': 5, '4-200': 6, '5-130': 7 }[l.sku];
    return [pid, l.sku, l.qty, l.gz_price];
  }));
  const { totals } = compareStatement(SHEET.lines, billingRows(db, { from: '2026-09-27', to: '2026-09-30', shift: SHIFT }));
  assert.strictEqual(totals.mismatches, 0);
  assert.strictEqual(totals.difference, 0);
});

it('a file with no Qty / code header is refused, not read as empty', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('x').addRow(['hello', 'world']);
  await assert.rejects(readStatement(Buffer.from(await wb.xlsx.writeBuffer())), (e) => e.code === 'no_header');
});

it('the date range is read off gzgrocery\'s file names', () => {
  const T = '2026-10-05';
  assert.deepStrictEqual(rangeFromFilename('GV9.27~9.30.xlsx', T), { from: '2026-09-27', to: '2026-09-30' });
  assert.deepStrictEqual(rangeFromFilename('GV9-25+9-26.xlsx', T), { from: '2026-09-25', to: '2026-09-26' });
  assert.deepStrictEqual(rangeFromFilename('GV4月1~4月3.xlsx', T), { from: '2026-04-01', to: '2026-04-03' });
  assert.deepStrictEqual(rangeFromFilename('2026-2-22号~2-27号.xlsx', T), { from: '2026-02-22', to: '2026-02-27' });
  assert.deepStrictEqual(rangeFromFilename('GV12.29~1.2.xlsx', T), { from: '2025-12-29', to: '2026-01-02' });
  assert.deepStrictEqual(rangeFromFilename('GV10.20~10.22.xlsx', T), { from: '2025-10-20', to: '2025-10-22' });
  assert.strictEqual(rangeFromFilename('GV9_279_30_.xlsx', T), null);   // separators lost — ask, don't guess
  assert.strictEqual(rangeFromFilename('statement.xlsx', T), null);
});

it('checking writes nothing, so it asks for the Billing panel\'s read key, not the sync key', () => {
  const m = /if \(P === '\/api\/retail-admin\/guanyi\/statement-check'\) return 'guanyi:view';/.test(capRoutes);
  assert.ok(m, 'statement-check is not mapped to guanyi:view');
  const at = capRoutes.indexOf("guanyi/statement-check'");
  const general = capRoutes.indexOf("if (P.startsWith('/api/retail-admin/guanyi'))");
  assert.ok(at > 0 && at < general, 'the statement-check rule must come before the general gzgrocery rule');
});

it('the route reads the sheet, compares against billingRows, and keeps nothing', () => {
  const h = ROUTE.slice(ROUTE.indexOf("'/api/retail-admin/guanyi/statement-check'"));
  const body = h.slice(0, h.indexOf('\n});\n'));
  assert.ok(/readStatement\(req\.file\.buffer\)/.test(body));
  assert.ok(/billingRows\(db,/.test(body) && /compareStatement\(/.test(body));
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(body), 'the check must not write');
  assert.ok(/memoryStorage\(\)/.test(ROUTE));
});

// ── The screen ─────────────────────────────────────────────────────────────
function renderWith(lang) {
  const a = GY.indexOf('  const GY_SHEET_STATUS = {');
  const b = GY.indexOf('  // (Billing is now a sub-nav panel');
  const src = GY.slice(a, b);
  const ctx = {
    cuT: (en, zh) => (lang === 'zh' ? zh : en),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    acWrap: (s) => '¥' + s,
    window: {}, document: { getElementById: () => null },
    _gyAna: {}, _gySheet: {}, gyLoadAnalytics() {},
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.render = gyRenderSheetCheck;', ctx);
  return ctx.render;
}
const RESULT = {
  success: true, range: { from: '2026-09-27', to: '2026-09-30', guessed: false },
  file: { name: 'GV9.27~9.30.xlsx', lines: 3, ignored: [{ row: 12, text: '干冰' }] },
  totals: { their_units: 9, our_units: 8, their_amount: 182.4, our_amount: 152, difference: 30.4, mismatches: 1 },
  rows: [
    { sku: '1-10', name: 'Hummus <b>', their_qty: 4, our_qty: 3, their_unit: 30.4, our_unit: 30.4, orders: ['GZ-101'], status: 'qty',
      nearby: [{ day: '2026-10-01', qty: 1, orders: ['GZ-140'] }] },
    { sku: '1-90', name: 'Sour Cream', their_qty: 2, our_qty: 2, their_unit: 30.4, our_unit: 30.4, orders: ['GZ-101'], status: 'ok' },
  ],
};

it('the screen leads with what disagrees, and folds what matches away', () => {
  const html = renderWith('en')(RESULT);
  assert.ok(html.includes('1 product(s) do not match'));
  assert.ok(html.includes('Quantity differs'));
  assert.ok(html.includes('GZ-101') && html.includes('GZ-140'), 'orders behind ours and the day after');
  assert.ok(/<details class="gy-fold"><summary>Matching products \(1\)/.test(html));
  assert.ok(html.includes('Ignored 1 line(s)') && html.includes('干冰'));
  assert.ok(html.includes('Hummus &lt;b&gt;'), 'names are escaped');
  assert.ok(!html.includes('Hummus <b>'));
});

it('an all-match result says so in one line', () => {
  const ok = { ...RESULT, totals: { ...RESULT.totals, difference: 0, mismatches: 0 }, rows: [RESULT.rows[1]], file: { name: 'x.xlsx', ignored: [] } };
  const html = renderWith('en')(ok);
  assert.ok(html.includes('All 1 products match'));
  assert.ok(html.includes('is-ok'));
});

it('every label has its Chinese, and every composed one is declared in the vocabulary', () => {
  const html = renderWith('zh')(RESULT);
  for (const zh of ['1 个商品不一致', '数量不符', '对方账单', '我方订单', '差额', '对方数量', '我方数量', '对方单价', '我方单价', '一致的商品 (1)', '已忽略 1 行非本店商品', '前后一天']) {
    assert.ok(html.includes(zh), 'missing on screen: ' + zh);
  }
  for (const zh of ['核对对方账单', '正在核对账单…', '数量不符', '单价不符', '数量和单价不符', '仅在对方账单', '对方账单未列',
    '对方账单', '我方订单', '差额', '对方数量', '我方数量', '对方单价', '我方单价', '一致的商品', '个商品不一致', '个商品一致',
    '行非本店商品', '前后一天', '仅支持 .xlsx 文件', '无法读取该表格', '请先选择日期 — 文件名中没有日期']) {
    assert.ok(VOCAB.includes(zh), 'not declared in docs/tacet-delivery-vocabulary.md: ' + zh);
  }
});

(async () => {
  console.log('\n§430 · checking gzgrocery\'s statement');
  for (const [name, fn] of queue) {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
