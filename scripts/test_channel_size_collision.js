// Two listings that differ only by size are two listings (npm run test:channel-size-collision).
//
// WHAT THIS IS ABOUT
// ------------------
// Meituan order MT20260921488622, 2026-09-21. A customer bought two of the 230g
// peach yogurt. Two of the 130g came off the shelf, the 230g count never moved,
// and both numbers were then pushed back to the channel as fact. Nothing warned
// anyone; it was found because a person compared two screenshots.
//
// Tianhe maps the two sizes to two listings whose names differ only inside the
// brackets:
//
//   product 265 (1-190, Big)   → 纯素椰子酸奶-桃子味Peach (230g)
//   product 264 (1-180, Small) → 纯素椰子酸奶-桃子味Peach(130g)
//
// The matcher deleted every bracketed run before comparing names — brackets are
// where a 货号 and a storage note live — so both collapsed to the same string. It
// then took the FIRST row the database returned, having never asked whether a
// second had matched equally well. The mapping was correct. The 货号 on the
// listing was correct. The resolver was choosing between two right answers by
// row order.
//
// WHAT IS PROVED, and why each case is here:
//   A  the 230g line resolves to 265 and deducts 265 — the live miss, inverted
//   B  the 130g line resolves to 264 — the fix must not simply prefer the big one
//   C  a genuine tie (two mappings, same name, no size to tell them apart) is
//      REFUSED, not resolved by row order, and nothing is deducted
//   D  the refusal does NOT fall through to the looser name branch, which would
//      answer the question the strict branch just declined
//   E  230克 and 230g are one size, so keeping the size did not turn a working
//      mapping into a miss
//   F  a bracketed 货号 is still dropped — the sizes are kept, not the brackets
//
// C is the case that matters in a year. Sizes are one way two listings can read
// alike and they are not the last way; F is what stops the fix from breaking the
// branch above it, which reads that same 货号.
//
// BOTH CHANNELS, ONE FILE. routes/eleme-internal.js calls itself a deliberate
// copy of routes/meituan-internal.js and the defect was a copy too. They now
// share lib/channel-name-match.js, so the cases run twice — once per route — and
// a fix that reaches only one of them fails here.
//
// Drives the REAL route handlers against node:sqlite, on DDL parsed out of
// database.js at run time, exactly as scripts/test_eleme_sku_token.js does.
// inventory.adjustStock is a recorder rather than a stub, because "the right
// product came off the shelf" is the whole claim.
//
// Run: node scripts/test_channel_size_collision.js

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

const dbFile = path.join(os.tmpdir(), 'channel-size-collision-test.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
const raw = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });

const TABLES = ['retail_orders', 'retail_order_items', 'retail_store_stock',
                'meituan_product_map', 'eleme_product_map',
                'meituan_sync_log', 'eleme_sync_log'];
for (const t of TABLES) raw.exec(ddl(t));
// store_products is declared rather than parsed: database.js assembles it from a
// column list at run time, and the four columns the matcher reads are not what
// this test is about.
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
// The pack-claim columns, which the scan above cannot see: database.js adds them
// through a loop over a list of channel maps, so the table name is a variable and
// a regex keyed on a literal name walks straight past them. Named here because
// the resolver's branch 0 reads them — without these it can never fire, and the
// map branch under test would be reached for a reason the live code does not have.
for (const tbl of ['meituan_product_map', 'eleme_product_map']) {
  for (const [col, decl] of [['units_per_pack', 'INTEGER NOT NULL DEFAULT 1'],
                             ['spec_key', "TEXT NOT NULL DEFAULT ''"]]) {
    try { raw.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${decl}`); }
    catch (_) { /* already present */ }
  }
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

// ── 3. Prime the routes' dependencies ─────────────────────────────────────────
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

// A RECORDER, not a stub. "The 230g came off the shelf" is the claim, and the
// only place it is observable is the call the ingest makes.
const deductions = [];
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });
stub('../lib/inventory', {
  adjustStock: (args) => { deductions.push(args); return { ok: true }; },
});
stub('../lib/product-cost', { productUnitCostYuan: () => null });
// The merchant alert, captured rather than sent — lib/channel-line-report requires
// these two lazily, so stubbing them keeps the test off the real alert config and
// the real tenant database.
const alerts = [];
stub('../lib/ops-alert', { alertMerchant: (tenantId, text) => { alerts.push({ tenantId, text }); } });
stub('../lib/tenant-db', { ROOTS_TENANT_ID: 1 });

const mtRouter = require(path.join(REPO, 'routes', 'meituan-internal.js'));
const elRouter = require(path.join(REPO, 'routes', 'eleme-internal.js'));

function handler(router, method, route) {
  for (const l of router.stack) {
    if (l.route && l.route.path === route && l.route.methods[method]) return l.route.stack[0].handle;
  }
  throw new Error(`no handler for ${method} ${route}`);
}

let seq = 0;
function post(router, secretEnv, secretDefault, order) {
  deductions.length = 0;
  alerts.length = 0;
  const req = { body: { storeId: 7, storeCode: 'tianhe', order },
                ip: '127.0.0.1',
                headers: { 'x-internal-secret': process.env[secretEnv] || secretDefault },
                connection: {} };
  let out = null, code = 200;
  const res = { json: (j) => { out = j; return res; }, status: (c) => { code = c; return res; } };
  handler(router, 'post', '/ingest-order')(req, res);
  return { code, body: out };
}

// One call shape per channel, so every case below runs identically on both.
const CHANNELS = [
  {
    name: 'meituan',
    mapTable: 'meituan_product_map',
    nameCol: 'meituan_name',
    ingest: (items) => post(mtRouter, 'MEITUAN_INTERNAL_SECRET', 'meituan-daemon-internal',
      { meituanOrderNo: `MT2026092148${String(++seq).padStart(4, '0')}`, items, total: 96, statusDesc: '已送达' }),
  },
  {
    name: 'eleme',
    mapTable: 'eleme_product_map',
    nameCol: 'eleme_name',
    ingest: (items) => post(elRouter, 'ELEME_INTERNAL_SECRET', 'eleme-daemon-internal',
      { elemeOrderId: `200000000000000${String(++seq).padStart(3, '0')}`, items, total: 96, statusDesc: '已完成' }),
  },
];

// ── 4. Seed — the live rows, as tianhe holds them ─────────────────────────────
// The peach pair is the case. The plain and vanilla pairs are here because they
// are what makes the LAST branch ambiguous too: with six active products whose
// name_cn all contain 纯素椰子酸奶, a refusal in the map branch that fell through
// would find no unique name either, and case D would pass without proving
// anything. They are the live catalogue's shape, not a convenience.
db.exec(`
  INSERT INTO store_products (id, name_cn, name_en, sku, is_active) VALUES
    (260, '大椰益生菌230g（中）（冷藏）',        'Probiotic Coconut Yogurt - Plain Flavor',     '1-130', 1),
    (261, '纯素椰子酸奶（大）500g （冷藏）',     'Big Size Probiotic Coconut Yogurt - Plain',   '1-140', 1),
    (262, '纯素椰子酸奶-香草味 (冷藏)',          'Probiotic Coconut Yogurt - Vanilla Flavor',   '1-150', 1),
    (263, '纯素椰子酸奶-香草味200g （冷藏）',    'Medium Probiotic Coconut Yogurt - Vanilla',   '1-160', 1),
    (264, '纯素椰子酸奶-桃子味（小）130g (冷藏）', 'Probiotic Coconut Yogurt -Peach Flavor',    '1-180', 1),
    (265, '纯素椰子酸奶-桃子味230g (冷藏）',     'Probiotic Coconut Yogurt - Peach Flavor',     '1-190', 1),
    (300, '香烤南瓜汤',                          'Roasted Pumpkin Soup',                        '1-370', 1);
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES
    (7, 260, 40), (7, 261, 40), (7, 262, 40), (7, 263, 40), (7, 264, 40), (7, 265, 40), (7, 300, 40);
`);

// The mappings, exactly as the Meituan tab shows them. Small FIRST, because the
// old code took the first row back and this is the order that reproduced the
// live miss — seeded the other way round the bug would have "passed".
for (const c of CHANNELS) {
  db.prepare(
    `INSERT INTO ${c.mapTable} (retail_store_id, product_id, store_code, ${c.nameCol}, sync_enabled)
     VALUES (?, ?, 'tianhe', ?, 1)`
  ).run(7, 264, '纯素椰子酸奶-桃子味Peach(130g)');
  db.prepare(
    `INSERT INTO ${c.mapTable} (retail_store_id, product_id, store_code, ${c.nameCol}, sync_enabled)
     VALUES (?, ?, 'tianhe', ?, 1)`
  ).run(7, 265, '纯素椰子酸奶-桃子味Peach (230g)');
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};
const lines = (orderId) =>
  db.prepare('SELECT product_id, sku, qty FROM retail_order_items WHERE order_id = ? ORDER BY id').all(orderId);

// A line with NO code on it — which is what the live order carried, and the only
// reason the name branch was reached at all.
const line = (name, qty = 2) => ({ name, qty, unitPrice: 48, lineTotal: 48 * qty });

for (const c of CHANNELS) {
  console.log(`\n══ ${c.name} ══`);

  // ── A · the live miss, MT20260921488622 ────────────────────────────────────
  console.log(`\nA · the 230g line resolves to the 230g product, and deducts it`);
  {
    const r = c.ingest([line('纯素椰子酸奶-桃子味Peach (230g)')]);
    check('ingest returns ok', r.code === 200 && r.body && r.body.ok, JSON.stringify(r));
    check('nothing left unresolved', r.body.unresolved.length === 0, JSON.stringify(r.body.unresolved));
    const [l] = lines(r.body.orderId);
    check('resolved to 265 (1-190, Big)', l && l.product_id === 265, `got ${l && l.product_id}`);
    check('adjustStock took 2 off 265',
      deductions.length === 1 && deductions[0].productId === 265 && deductions[0].deltaQty === -2,
      JSON.stringify(deductions));
  }

  // ── B · and not by preferring the big one ──────────────────────────────────
  console.log(`\nB · the 130g line still resolves to the 130g product`);
  {
    const r = c.ingest([line('纯素椰子酸奶-桃子味Peach(130g)', 1)]);
    const [l] = lines(r.body.orderId);
    check('resolved to 264 (1-180, Small)', l && l.product_id === 264, `got ${l && l.product_id}`);
    check('adjustStock took 1 off 264',
      deductions.length === 1 && deductions[0].productId === 264 && deductions[0].deltaQty === -1,
      JSON.stringify(deductions));
  }

  // ── E · one size, however it is written ────────────────────────────────────
  console.log(`\nE · 230克 and 230g are the same size, not two`);
  {
    const r = c.ingest([line('纯素椰子酸奶-桃子味Peach (230克)', 1)]);
    const [l] = lines(r.body.orderId);
    check('still resolved to 265', l && l.product_id === 265, `got ${l && l.product_id}`);
  }

  // ── F · the brackets were not kept, only the sizes ─────────────────────────
  console.log(`\nF · a bracketed 货号 is still dropped, not read as part of the name`);
  {
    // 300's mapping carries no code; the line does. If the 货号 survived
    // normalisation the two names would differ and this would not match.
    db.prepare(
      `INSERT INTO ${c.mapTable} (retail_store_id, product_id, store_code, ${c.nameCol}, sync_enabled)
       VALUES (?, ?, 'tianhe', ?, 1)`
    ).run(7, 300, '香烤南瓜汤 Roasted Pumpkin Soup');
    const r = c.ingest([line('香烤南瓜汤 Roasted Pumpkin Soup (1-370 不加热No)', 1)]);
    const [l] = lines(r.body.orderId);
    check('resolved to 300 despite the bracketed code', l && l.product_id === 300, `got ${l && l.product_id}`);
  }

  // ── C · a real tie is refused ──────────────────────────────────────────────
  console.log(`\nC · two mappings with the same name are refused, not guessed`);
  {
    // Vanilla, mapped twice under one name with no size on either — the shape
    // the size fix cannot help with, and the one that will happen again.
    for (const pid of [262, 263]) {
      db.prepare(
        `INSERT INTO ${c.mapTable} (retail_store_id, product_id, store_code, ${c.nameCol}, sync_enabled)
         VALUES (?, ?, 'tianhe', ?, 1)`
      ).run(7, pid, '纯素椰子酸奶-香草味Vanilla');
    }
    const r = c.ingest([line('纯素椰子酸奶-香草味Vanilla', 1)]);
    check('ingest still returns ok — the ORDER is never lost', r.code === 200 && r.body.ok, JSON.stringify(r));
    const [l] = lines(r.body.orderId);
    check('the line is on the order with no product', l && l.product_id === null, `got ${l && l.product_id}`);
    check('nothing was deducted', deductions.length === 0, JSON.stringify(deductions));
    check('it is reported as unresolved', r.body.unresolved.length === 1, JSON.stringify(r.body.unresolved));
    check('and says why', r.body.unresolved[0] && r.body.unresolved[0].reason === 'ambiguous_map',
      JSON.stringify(r.body.unresolved));

    // ── D · and the refusal is not undone by the branch below it ─────────────
    console.log(`\nD · the refusal does not fall through to the looser name guess`);
    check('no product was reached by any later branch',
      deductions.length === 0 && lines(r.body.orderId)[0].product_id === null,
      JSON.stringify({ deductions, lines: lines(r.body.orderId) }));
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
