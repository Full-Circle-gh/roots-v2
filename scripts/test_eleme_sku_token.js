// An Eleme line resolves on the code in its title, and deducts (npm run test:eleme-sku-token).
//
// WHAT THIS IS ABOUT
// ------------------
// Eleme sends no 货号 on most lines, so the merchant writes the product's code
// into the listing title instead — "Coconut Yogurt 纯素椰子酸奶-中230g 1-130".
// routes/meituan-internal.js has always dug that "N-N" token out of the title
// when the platform sent no skuCode; routes/eleme-internal.js, a deliberate copy
// of it, did not. The lines fell through to the name match, which is where they
// died: "Coconut Yogurt" matches six active products, so the resolver correctly
// refused to guess, left product_id NULL, and the ingest skipped the deduction.
//
// The cost, off the live rows on 2026-09-08:
//   EL20260907878862  its ONLY line was 1-130  → the whole order deducted nothing
//   EL20260902387751  one line of seven was 1-190 → that line deducted nothing
// Both codes name exactly one product (#260 and #265). Nothing was ambiguous
// about them except the half of the resolver that was missing.
//
// WHAT IS PROVED, and why each case is here rather than just the happy one:
//   A  a title token with no item.sku resolves, and the line deducts
//   B  the token is recorded on the order row, so the match is auditable
//   C  an explicit item.sku still wins over a title token — precedence unmoved
//   D  a claimed 规格 still wins over both — branch 0 is still branch 0
//   E  a token matching NO product falls through and the name path still works,
//      which is what makes a gram range or a date in a title harmless
//   F  a name that is genuinely ambiguous is STILL refused — this change must
//      not have bought its matches by loosening the guess
//
// E and F are the ones that would catch this going wrong. A token is a substring
// of free text typed by a merchant, and the danger of reading one was never that
// it fails to match — it is that it matches something it should not, or that
// widening the first branch quietly widens the last.
//
// This drives the REAL route handler against node:sqlite, on retail_orders DDL
// parsed out of database.js at run time, exactly as scripts/test_eleme_order_fees.js
// does — the schema under test is the schema the box builds. inventory.adjustStock
// is a recorder rather than a stub, because "the line deducted" is the claim.
//
// Run: node scripts/test_eleme_sku_token.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');

// ── 1. Schema, from database.js itself ────────────────────────────────────────
const dbjs = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');

function ddl(table) {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const at = dbjs.indexOf(head);
  if (at < 0) throw new Error(`no DDL for ${table} in database.js`);
  let depth = 0, i = at + head.length - 1;
  for (; i < dbjs.length; i++) {
    if (dbjs[i] === '(') depth++;
    else if (dbjs[i] === ')' && --depth === 0) break;
  }
  return dbjs.slice(at, i + 1);
}

const dbFile = path.join(os.tmpdir(), 'eleme-sku-token-test.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
const raw = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });

const TABLES = ['retail_orders', 'retail_order_items', 'retail_store_stock',
                'eleme_product_map', 'eleme_sync_log'];
for (const t of TABLES) raw.exec(ddl(t));
// store_products is declared here rather than parsed: database.js assembles it
// from a column list at run time, and the four columns the matcher reads are not
// what this test is about.
raw.exec(`
  CREATE TABLE store_products (
    id INTEGER PRIMARY KEY, name_cn TEXT, name_en TEXT, sku TEXT, is_active INTEGER DEFAULT 1
  )
`);
for (const m of dbjs.matchAll(/addColumn\('(\w+)',\s*'(\w+)',\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)) {
  if (!TABLES.includes(m[1])) continue;
  try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3] ?? m[4]}`); }
  catch (_) { /* already in the CREATE above */ }
}
// THE TWO THE SCAN ABOVE CANNOT SEE. database.js adds the pack-claim columns
// through a loop over a list of channel maps — `addColumn(m.table, 'spec_key',
// …)` — so the table name is a variable and a regex keyed on a literal name
// walks straight past them. They are named here rather than left out, because
// case D below is exactly about the branch that reads them; without these the
// claim can never match and the test would report a passing precedence it had
// not actually exercised.
for (const [colName, decl] of [['units_per_pack', 'INTEGER NOT NULL DEFAULT 1'],
                               ['spec_key', "TEXT NOT NULL DEFAULT ''"]]) {
  try { raw.exec(`ALTER TABLE eleme_product_map ADD COLUMN ${colName} ${decl}`); }
  catch (_) { /* already present */ }
}
for (const need of ['spec_key', 'spec_name', 'units_per_pack']) {
  const have = raw.prepare('SELECT * FROM pragma_table_info(?)').all('eleme_product_map').map(c => c.name);
  if (!have.includes(need)) { console.error(`FAIL: eleme_product_map has no ${need} column`); process.exit(1); }
}

// ── 2. better-sqlite3 shim over node:sqlite ───────────────────────────────────
const db = {
  prepare(sql) {
    const st = raw.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  },
  exec: (s) => raw.exec(s),
  transaction: (fn) => (...a) => { raw.exec('BEGIN'); try { const r = fn(...a); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
};

// ── 3. Prime the route's dependencies ─────────────────────────────────────────
const stub = (id, exports) => {
  const full = require.resolve(id, { paths: [path.join(REPO, 'routes')] });
  const m = new Module(full);
  m.exports = exports; m.loaded = true;
  require.cache[full] = m;
};
try {
  require.resolve('express', { paths: [path.join(REPO, 'routes')] });
} catch (_) {
  const Router = () => {
    const r = (req, res, next) => next && next();
    r.stack = [];
    r.use = (fn) => { r.stack.push({ handle: fn }); return r; };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      r[method] = (p, ...fns) => {
        r.stack.push({ route: { path: p, methods: { [method]: true }, stack: fns.map(handle => ({ handle })) } });
        return r;
      };
    }
    return r;
  };
  const m = new Module('express');
  m.exports = { Router }; m.loaded = true;
  require.cache['express'] = m;
  Module._resolveFilename = ((orig) => function (request, ...rest) {
    return request === 'express' ? 'express' : orig.call(this, request, ...rest);
  })(Module._resolveFilename);
}

// A RECORDER, not a stub. "The line deducted" is the whole claim, and the only
// place it is observable is the call the ingest makes.
const deductions = [];
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });
stub('../lib/inventory', {
  adjustStock: (args) => { deductions.push(args); return { ok: true }; },
});
stub('../lib/product-cost', { productUnitCostYuan: () => null });
// The merchant alert, captured rather than sent. lib/channel-line-report requires
// these two lazily, so stubbing them here is what keeps the test off the real
// alert config and the real tenant database.
const alerts = [];
stub('../lib/ops-alert', { alertMerchant: (tenantId, text) => { alerts.push({ tenantId, text }); } });
stub('../lib/tenant-db', { ROOTS_TENANT_ID: 1 });

const router = require(path.join(REPO, 'routes', 'eleme-internal.js'));

function handler(method, route) {
  for (const l of router.stack) {
    if (l.route && l.route.path === route && l.route.methods[method]) return l.route.stack[0].handle;
  }
  throw new Error(`no handler for ${method} ${route}`);
}
let seq = 0;
function ingest(items, extra = {}) {
  deductions.length = 0;
  alerts.length = 0;
  const req = { body: { storeId: 7, storeCode: 'tianhe',
                        order: { elemeOrderId: `2000000000000000${++seq}`, items,
                                 total: 100, statusDesc: '已完成', ...extra } },
                ip: '127.0.0.1',
                headers: { 'x-internal-secret': process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal' },
                connection: {} };
  let out = null, code = 200;
  const res = { json: (j) => { out = j; return res; }, status: (c) => { code = c; return res; } };
  handler('post', '/ingest-order')(req, res);
  return { code, body: out };
}

// ── 4. Seed — the live catalogue shape that made these lines ambiguous ────────
// Six active "Coconut Yogurt" products, exactly as tianhe holds them, so the
// name branch is genuinely ambiguous here and case F means something.
db.exec(`
  INSERT INTO store_products (id, name_cn, name_en, sku, is_active) VALUES
    (260, '纯素椰子酸奶 原味',       'Probiotic Coconut Yogurt - Plain Flavor',           '1-130', 1),
    (261, '纯素椰子酸奶 原味 大',    'Big Size Probiotic Coconut Yogurt - Plain Flavor',  '1-131', 1),
    (262, '纯素椰子酸奶 香草',       'Probiotic Coconut Yogurt - Vanilla Flavor',         '1-140', 1),
    (263, '纯素椰子酸奶 香草 中',    'Medium Size Probiotic Coconut Yogurt - Vanilla Flavor', '1-141', 1),
    (264, '纯素椰子酸奶 桃子',       'Probiotic Coconut Yogurt -Peach Flavor',            '1-189', 1),
    (265, '纯素椰子酸奶 桃子味 大',  'Probiotic Coconut Yogurt - Peach Flavor',           '1-190', 1),
    (300, '香烤南瓜汤',              'Roasted Pumpkin Soup',                              'RT-330', 1);
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES
    (7, 260, 40), (7, 261, 40), (7, 262, 40), (7, 263, 40), (7, 264, 40), (7, 265, 40), (7, 300, 40);
`);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};
const lines = (orderId) =>
  db.prepare('SELECT product_id, sku, name_en, qty FROM retail_order_items WHERE order_id = ? ORDER BY id').all(orderId);

// ── A · the live miss, EL20260907878862 ──────────────────────────────────────
console.log('\nA · "…中230g 1-130" resolves on the code in its title, and deducts');
{
  const r = ingest([{ name: 'Coconut Yogurt 纯素椰子酸奶-中230g 1-130', qty: 1, unitPrice: 50, lineTotal: 50 }]);
  check('ingest returns ok', r.code === 200 && r.body && r.body.ok, JSON.stringify(r));
  check('nothing left unresolved', r.body.unresolved.length === 0, JSON.stringify(r.body.unresolved));
  check('one line deducted', r.body.deducted === 1, `deducted=${r.body.deducted}`);
  const [l] = lines(r.body.orderId);
  check('resolved to product 260 (sku 1-130)', l && l.product_id === 260, `got ${l && l.product_id}`);
  check('adjustStock was called for 260', deductions.length === 1 && deductions[0].productId === 260,
    JSON.stringify(deductions));
  check('it took one unit off the shelf (40 → 39)',
    deductions.length === 1 && deductions[0].newPhysicalQty === 39,
    JSON.stringify(deductions));
}

// ── B · the token is on the row ───────────────────────────────────────────────
console.log('\nB · the code the line matched on is recorded, not just used');
{
  const r = ingest([{ name: 'Peach Yogurt 纯素椰子酸奶-桃子味-230g 大 (1-190)', qty: 2, unitPrice: 60, lineTotal: 120 }]);
  const [l] = lines(r.body.orderId);
  check('resolved to product 265 (sku 1-190)', l && l.product_id === 265, `got ${l && l.product_id}`);
  // Without this the code that identified the line lives only inside the title,
  // and nothing on the order says how it was matched.
  check('retail_order_items.sku holds the token', l && l.sku === '1-190', `got ${l && l.sku}`);
  check('quantity carried through (x2 → 38)',
    deductions.length === 1 && deductions[0].newPhysicalQty === 38, JSON.stringify(deductions));
}

// ── C · precedence: an explicit 货号 still wins ───────────────────────────────
console.log('\nC · item.sku still beats a token in the title');
{
  // The title says 1-130 (product 260); Eleme's own 货号 says RT-330 (product
  // 300). The platform's field is the more reliable of the two and must win.
  const r = ingest([{ name: 'Coconut Yogurt 纯素椰子酸奶-中230g 1-130', sku: 'RT-330', qty: 1, unitPrice: 50, lineTotal: 50 }]);
  const [l] = lines(r.body.orderId);
  check('resolved on item.sku, to product 300', l && l.product_id === 300, `got ${l && l.product_id}`);
}

// ── D · precedence: a claimed 规格 still wins over both ───────────────────────
console.log('\nD · a claimed option still beats the token — branch 0 is still first');
{
  db.exec(`
    INSERT INTO eleme_product_map
      (retail_store_id, product_id, store_code, eleme_name, spec_name, spec_key, units_per_pack)
    VALUES (7, 261, 'tianhe', 'Coconut Yogurt 纯素椰子酸奶-中230g 1-130', '大杯', 'big', 3)
  `);
  const r = ingest([{ name: 'Coconut Yogurt 纯素椰子酸奶-中230g 1-130', specName: '大杯', qty: 1, unitPrice: 50, lineTotal: 50 }]);
  const [l] = lines(r.body.orderId);
  check('resolved on the claim, to product 261', l && l.product_id === 261, `got ${l && l.product_id}`);
  // The claim is the only branch that knows the pack size, which is exactly why
  // it is ahead of the code: 1-130 alone would have lost the "3 per pack".
  check('the claim brought its pack size (3 off the shelf, 40 → 37)',
    deductions.length === 1 && deductions[0].newPhysicalQty === 37, JSON.stringify(deductions));
  db.exec(`DELETE FROM eleme_product_map WHERE retail_store_id = 7`);
}

// ── E · a token that matches nothing costs nothing ───────────────────────────
console.log('\nE · a number pair that is not a SKU falls through to the name path');
{
  // "150-200g" reads as the token 150-200. No product holds it, so the line must
  // carry on to the name branch and resolve there — the guarantee that makes
  // reading a token out of free text safe.
  const r = ingest([{ name: 'Roasted Pumpkin Soup 香烤南瓜汤 150-200g', qty: 1, unitPrice: 30, lineTotal: 30 }]);
  const [l] = lines(r.body.orderId);
  check('still resolved, by name, to product 300', l && l.product_id === 300, `got ${l && l.product_id}`);
  check('the phantom token was not written to the row', l && l.sku !== '150-200', `got sku ${l && l.sku}`);
}

// ── F · the refusal is intact ────────────────────────────────────────────────
console.log('\nF · a genuinely ambiguous name is STILL refused');
{
  // No code anywhere in the title, and "Coconut Yogurt" matches six. This is the
  // case the change must NOT have bought its matches by weakening.
  const r = ingest([{ name: 'Coconut Yogurt 纯素椰子酸奶', qty: 1, unitPrice: 50, lineTotal: 50 }]);
  const [l] = lines(r.body.orderId);
  check('left unresolved rather than guessed', l && l.product_id === null, `got ${l && l.product_id}`);
  check('reported as unresolved', r.body.unresolved.length === 1, JSON.stringify(r.body.unresolved));
  check('reason is ambiguous', r.body.unresolved[0] && r.body.unresolved[0].reason === 'ambiguous',
    JSON.stringify(r.body.unresolved));
  check('nothing was deducted', deductions.length === 0, JSON.stringify(deductions));
}

// ── G · the ingest says so out loud ──────────────────────────────────────────
// The route's own wiring, not the classifier in isolation: an unmatched line
// reaches the merchant, and the cutlery answer does not. Both halves matter —
// this alert only survives contact with a real Meituan order rate if it stays
// quiet about the option lines that arrive on nearly every one.
console.log('\nG · an unmatched line reaches the merchant; an option line does not');
{
  const r = ingest([{ name: '中东鹰嘴豆泥套餐 Hummus Combo', qty: 1, unitPrice: 64, lineTotal: 64 }]);
  check('the line was left unresolved', r.body.unresolved.length === 1, JSON.stringify(r.body.unresolved));
  check('exactly one alert fired', alerts.length === 1, JSON.stringify(alerts));
  check('it names the order', alerts[0] && alerts[0].text.includes(r.body.orderNo), JSON.stringify(alerts));
  check('it says the stock was not deducted', alerts[0] && alerts[0].text.includes('库存未扣减'), JSON.stringify(alerts));

  ingest([{ name: '无需餐具 No cutlery（0份）', qty: 1, unitPrice: 0, lineTotal: 0 }]);
  check('the cutlery answer alerts nobody', alerts.length === 0, JSON.stringify(alerts));

  // An oversell is a different fault from an unmatched line, and reaches the
  // merchant on its own — Eleme had no detection for this at all until now.
  db.exec('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = 7 AND product_id = 300');
  const o = ingest([{ name: 'Roasted Pumpkin Soup', sku: 'RT-330', qty: 2, unitPrice: 30, lineTotal: 60 }]);
  check('the order still lands', o.code === 200 && o.body.ok, JSON.stringify(o));
  check('the oversell alerts', alerts.length === 1 && alerts[0].text.includes('库存不足'), JSON.stringify(alerts));
  check('and says what was short', alerts[0] && alerts[0].text.includes('wanted 2, had 0'), JSON.stringify(alerts));
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.exit(failures ? 1 : 0);
