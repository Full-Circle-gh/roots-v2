#!/usr/bin/env node
/**
 * test_new_order_options.js — a product's own questions on the desktop New
 * order page.
 *
 *   node scripts/test_new_order_options.js
 *
 * THE FINDING (2026-09-28). An order for two wraps and two soups would not save
 * from the PC: "That did not save. Nothing was created." The order route
 * refuses a line whose required question ("Heat up?") is unanswered, and the
 * hand-keyed New order forms never asked one. The counter till did.
 *
 * WHAT THIS CHECKS:
 *
 *   1. The read. GET /api/retail-admin/products?with_options=1 carries each
 *      product's questions in the till's shape, marks a stock-backed extra this
 *      store has run out of as `out`, flags a product whose required question
 *      has no answer left, and adds nothing when the flag is absent — every
 *      other caller of that list is untouched.
 *
 *   2. The desktop panel, driven. The real functions are lifted out of
 *      public/retail-admin/04-orders.js and run against a stub page: defaults
 *      pre-ticked, a required question blocks Add, single replaces, multi
 *      respects its ceiling, same answers merge, different answers split, and
 *      the line posts the BASE price with its choice ids — the server adds the
 *      deltas itself, so posting base + delta would charge each extra twice.
 *
 * The phone's copy is driven in scripts/test_phone_order.js §4b.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const vm      = require('vm');
const express = require('express');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const { testOperator } = require('./lib/test-operator');
// The suite's own operator, made and removed by the suite — see scripts/lib/test-operator.js.
const op = testOperator(99865, '__op_new_order_options');
const db = tdb();

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// Ids clear of test_addon_available (94xx/95xx) and test_till_options (98xx/99xx).
const STORE  = 9311;
const P_WRAP = 9321;   // one required single question, one optional multi
const P_SOUP = 9322;   // no questions at all
const P_GONE = 9323;   // a required question whose only answer is sold out here
const A_OAT  = 9324;   // stock-backed extra, plenty on the shelf
const A_SOY  = 9325;   // stock-backed extra, zero on the shelf
const SKU    = '__NOO-';
const ALL = [P_WRAP, P_SOUP, P_GONE, A_OAT, A_SOY];

function cleanup() {
  op.remove();
  const ph = ALL.map(() => '?').join(',');
  db.prepare(`DELETE FROM retail_product_option_choices
               WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`).run(...ALL);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...ALL);
  db.prepare(`DELETE FROM retail_store_stock     WHERE product_id IN (${ph})`).run(...ALL);
  db.prepare(`DELETE FROM store_products         WHERE id         IN (${ph})`).run(...ALL);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}

const ids = {};
function seed() {
  cleanup();
  db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
              VALUES (?,?,?,?,?,?,1,?)`).run(STORE, 'noo-shop', 'Options Store', '选项店', '广州市', '天河区', 1);
  const prod = db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active)
                           VALUES (?,?,?,?,?,1,1)`);
  prod.run(P_WRAP, 'Noo falafel wrap', '测试法拉费卷', SKU + '1', 44);
  prod.run(P_SOUP, 'Noo lentil soup',  '测试红扁豆汤', SKU + '2', 44);
  prod.run(P_GONE, 'Noo flat white',   '测试馥芮白',   SKU + '3', 30);
  prod.run(A_OAT,  'Noo oat milk',     '测试燕麦奶',   SKU + '4', 6);
  prod.run(A_SOY,  'Noo soy milk',     '测试豆奶',     SKU + '5', 6);
  const stock = db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
                            VALUES (?,?,?,0)`);
  stock.run(STORE, A_OAT, 25);
  stock.run(STORE, A_SOY, 0);

  const opt = db.prepare(`INSERT INTO retail_product_options
      (product_id, question_en, question_cn, type, is_required, min_choices, max_choices, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`);
  const ch = db.prepare(`INSERT INTO retail_product_option_choices
      (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
      VALUES (?,?,?,?,?,?,?)`);
  ids.heat = opt.run(P_WRAP, 'Heat up?', '加热吗?', 'single', 1, 0, 0, 0).lastInsertRowid;
  ids.heatYes = ch.run(ids.heat, 'Yes', '是', 0, 0, null, 0).lastInsertRowid;
  ids.heatNo  = ch.run(ids.heat, 'No',  '否', 0, 0, null, 1).lastInsertRowid;
  ids.milk = opt.run(P_WRAP, 'Extras', '加料', 'multi', 0, 0, 1, 1).lastInsertRowid;
  ids.oat = ch.run(ids.milk, 'Oat', '燕麦', 3, 1, A_OAT, 0).lastInsertRowid;
  ids.soy = ch.run(ids.milk, 'Soy', '豆奶', 3, 0, A_SOY, 1).lastInsertRowid;
  ids.gone = opt.run(P_GONE, 'Milk?', '奶?', 'single', 1, 0, 0, 0).lastInsertRowid;
  ch.run(ids.gone, 'Soy', '豆奶', 0, 0, A_SOY, 0);
}

// ── 1 · the read ──────────────────────────────────────────────────────────
async function theRead() {
  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: op.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/retail-admin/products?limit=10&q=${encodeURIComponent(SKU)}`;
  const get = async (qs) => {
    const r = await fetch(base + qs);
    const j = await r.json().catch(() => null);
    const rows = (j && (j.data || j)) || [];
    return { status: r.status, by: new Map((Array.isArray(rows) ? rows : []).map(x => [x.id, x])) };
  };
  const plain  = await get('');
  const asked  = await get('&with_options=1');
  const atShop = await get('&with_options=1&store_id=' + STORE);
  // THE SERVER'S SIDE OF THE CONTRACT, through the fee quote — it prices lines
  // with the same resolveManualOrderLines the create route does, and writes
  // nothing. The form posts the BASE price and the choice ids.
  const quote = async (items) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/retail-admin/order-fees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fulfillment_type: 'pickup', items }),
    });
    const j = await r.json().catch(() => ({}));
    return j.data || {};
  };
  const unanswered = await quote([{ product_id: P_WRAP, qty: 1, unit_price: 44 }]);
  const answered   = await quote([{ product_id: P_WRAP, qty: 2, unit_price: 44, choices: [ids.heatYes, ids.oat] }]);
  server.close();

  console.log('\n0 · what the server does with a line (the reason for all of this)');
  check('a wrap with its required question unanswered is refused — the bug as reported', () => {
    assert.strictEqual(unanswered.error, 'choice_required');
  });
  check('the base price plus the answers is priced base + delta, once', () => {
    assert.ok(!answered.error, JSON.stringify(answered));
    assert.strictEqual(answered.subtotal, 94, '2 × (44 + 3)');
  });

  console.log('\n1 · the product search, asked for questions');
  check('the search finds the fixtures', () => {
    assert.strictEqual(plain.status, 200);
    assert.ok(plain.by.get(P_WRAP) && plain.by.get(P_SOUP), 'both products come back');
  });
  check('without with_options nothing is added — every other caller is untouched', () => {
    assert.strictEqual(plain.by.get(P_WRAP).options, undefined);
    assert.strictEqual(plain.by.get(P_WRAP).options_unanswerable, undefined);
  });
  check('with it, a product with questions carries them in the till’s shape', () => {
    const qs = asked.by.get(P_WRAP).options;
    assert.ok(Array.isArray(qs) && qs.length === 2, 'two questions');
    assert.strictEqual(qs[0].q_en, 'Heat up?');
    assert.strictEqual(qs[0].req, 1);
    assert.strictEqual(qs[0].multi, 0);
    assert.deepStrictEqual(qs[0].choices.map(c => c.en), ['Yes', 'No']);
    assert.strictEqual(qs[1].multi, 1);
    assert.strictEqual(qs[1].max, 1);
    assert.strictEqual(qs[1].choices[0].d, 3);
  });
  check('a product with no questions carries no options field', () => {
    assert.strictEqual(asked.by.get(P_SOUP).options, undefined);
  });
  check('without a store nothing is sold out — the read is not location-scoped', () => {
    const soy = asked.by.get(P_WRAP).options[1].choices.find(c => c.en === 'Soy');
    assert.strictEqual(soy.out, 0);
    assert.strictEqual(asked.by.get(P_GONE).options_unanswerable, false);
  });
  check('with the store, an extra it has run out of is marked out', () => {
    const cs = atShop.by.get(P_WRAP).options[1].choices;
    assert.strictEqual(cs.find(c => c.en === 'Soy').out, 1);
    assert.strictEqual(cs.find(c => c.en === 'Oat').out, 0);
    assert.strictEqual(atShop.by.get(P_WRAP).options_unanswerable, false);
  });
  check('a required question with no answer left flags the product as unorderable', () => {
    assert.strictEqual(atShop.by.get(P_GONE).options_unanswerable, true);
  });
  check('the internal shelf id is not handed out', () => {
    const c = atShop.by.get(P_WRAP).options[1].choices[0];
    assert.strictEqual(c.stock_product_id, undefined);
  });
  return atShop;
}

// ── 2 · the desktop panel, driven ─────────────────────────────────────────
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
function extractFn(name) {
  const m = SRC.match(new RegExp('^function ' + name + '\\(', 'm'));
  if (!m) return null;
  const end = SRC.indexOf('\n}', m.index);
  return end < 0 ? null : SRC.slice(m.index, end + 2);
}
const WANTED = ['onwLineUnit', 'onwLineItem', 'onwLineKey', 'ordNewAddAnswered', 'ordNewAddLine',
                'ordNewOpenOpts', 'ordNewCloseOpts', 'ordNewTickOpt', 'ordNewOptsMissing',
                'ordNewChosenOpts', 'ordNewCommitOpts', 'onwOptsText', 'ordNewCollect'];

function thePanel(atShop) {
  console.log('\n2 · the desktop panel');
  const srcs = WANTED.map(n => [n, extractFn(n)]);
  const missing = srcs.filter(([, s]) => !s).map(([n]) => n);
  check('every panel function was found in 04-orders.js', () => assert.deepStrictEqual(missing, []));
  if (missing.length) return;

  const shown = [];
  const ctx = {
    ONW: null, shown,
    cuT: (en) => en,
    document: { getElementById: () => null },
    ordNewHideResults: () => {}, ordNewClearErrors: () => {},
    ordNewShowError: (where, msg) => shown.push([where, msg]),
    ordNewRenderLines: () => {}, ordNewRenderOpts: () => {},
    ordNewAddress: () => ({}),
  };
  vm.createContext(ctx);
  vm.runInContext(srcs.map(([, s]) => s).join('\n'), ctx);
  const fresh = (prodResults) => {
    ctx.ONW = { lines: [], prodResults, opt: null, cust: 'rest', customer: null, saveCust: false };
    shown.length = 0;
  };
  const wrap = atShop.by.get(P_WRAP), soup = atShop.by.get(P_SOUP), gone = atShop.by.get(P_GONE);

  fresh([soup]);
  vm.runInContext('ordNewAddLine(0)', ctx);
  check('a product with no questions is added straight away', () => {
    assert.strictEqual(ctx.ONW.lines.length, 1);
    assert.strictEqual(ctx.ONW.opt, null);
  });

  fresh([gone]);
  vm.runInContext('ordNewAddLine(0)', ctx);
  check('a product whose required question cannot be answered here is not added, and says so', () => {
    assert.strictEqual(ctx.ONW.lines.length, 0);
    assert.strictEqual(ctx.ONW.opt, null);
    assert.deepStrictEqual(shown, [['prod', 'Noo flat white — Out of stock']]);
  });

  fresh([wrap]);
  vm.runInContext('ordNewAddLine(0)', ctx);
  check('a product with questions opens the panel instead of adding a line', () => {
    assert.strictEqual(ctx.ONW.lines.length, 0);
    assert.ok(ctx.ONW.opt && ctx.ONW.opt.p.id === P_WRAP);
  });
  check('defaults are pre-ticked — Oat is the default extra', () => {
    assert.deepStrictEqual([...ctx.ONW.opt.sel[ids.milk]], [ids.oat]);
    assert.deepStrictEqual([...ctx.ONW.opt.sel[ids.heat]], []);
  });
  vm.runInContext('ordNewCommitOpts()', ctx);
  check('Add with the required question unanswered is refused and names it', () => {
    assert.strictEqual(ctx.ONW.lines.length, 0);
    assert.strictEqual(ctx.ONW.opt.err, true);
    assert.strictEqual(vm.runInContext('ordNewOptsMissing()', ctx).q_en, 'Heat up?');
  });
  vm.runInContext(`ordNewTickOpt(${ids.milk}, ${ids.soy})`, ctx);
  check('a sold-out extra cannot be ticked', () => {
    assert.deepStrictEqual([...ctx.ONW.opt.sel[ids.milk]], [ids.oat]);
  });
  vm.runInContext(`ordNewTickOpt(${ids.heat}, ${ids.heatNo}); ordNewTickOpt(${ids.heat}, ${ids.heatYes})`, ctx);
  check('a single-answer question replaces rather than adds', () => {
    assert.deepStrictEqual([...ctx.ONW.opt.sel[ids.heat]], [ids.heatYes]);
  });
  vm.runInContext(`ordNewTickOpt(${ids.heat}, ${ids.heatYes})`, ctx);
  check('a required single answer cannot be un-ticked to nothing', () => {
    assert.deepStrictEqual([...ctx.ONW.opt.sel[ids.heat]], [ids.heatYes]);
  });
  vm.runInContext('ordNewCommitOpts()', ctx);
  check('answered, the line is made with its choices, answers and delta', () => {
    assert.strictEqual(ctx.ONW.opt, null);
    assert.strictEqual(ctx.ONW.lines.length, 1);
    const l = ctx.ONW.lines[0];
    assert.deepStrictEqual([...l.choices], [ids.heatYes, ids.oat]);
    assert.strictEqual(l.delta, 3);
    assert.strictEqual(l.unit_price, 44);
    assert.deepStrictEqual([...vm.runInContext('onwOptsText(ONW.lines[0].opts)', ctx)], ['Heat up?: Yes', 'Extras: Oat']);
  });
  check('the page shows base + delta, and posts the BASE with the choice ids', () => {
    assert.strictEqual(vm.runInContext('onwLineUnit(ONW.lines[0])', ctx), 47);
    const it = vm.runInContext('onwLineItem(ONW.lines[0])', ctx);
    assert.strictEqual(it.unit_price, 44, 'the server adds the delta; posting 47 would charge it twice');
    assert.deepStrictEqual([...it.choices], [ids.heatYes, ids.oat]);
  });

  // The same answers again merge; different answers are a line of their own.
  vm.runInContext(`ordNewAddLine(0); ordNewTickOpt(${ids.heat}, ${ids.heatYes}); ordNewCommitOpts()`, ctx);
  check('the same answers again add to the same line', () => {
    assert.strictEqual(ctx.ONW.lines.length, 1);
    assert.strictEqual(ctx.ONW.lines[0].qty, 2);
  });
  vm.runInContext(`ordNewAddLine(0); ordNewTickOpt(${ids.heat}, ${ids.heatNo}); ordNewTickOpt(${ids.milk}, ${ids.oat}); ordNewCommitOpts()`, ctx);
  check('different answers make a line of their own', () => {
    assert.strictEqual(ctx.ONW.lines.length, 2);
    assert.deepStrictEqual([...ctx.ONW.lines[1].choices], [ids.heatNo]);
    assert.strictEqual(ctx.ONW.lines[1].delta, 0);
  });
  vm.runInContext('ordNewAddLine(0); ordNewCloseOpts()', ctx);
  check('Cancel closes the panel and adds nothing', () => {
    assert.strictEqual(ctx.ONW.opt, null);
    assert.strictEqual(ctx.ONW.lines.length, 2);
  });
  check('the create body carries each line’s choices, and a plain line carries none', () => {
    ctx.ONW.lines.push({ product_id: P_SOUP, qty: 1, unit_price: 44 });
    const body = vm.runInContext('ordNewCollect()', ctx);
    assert.deepStrictEqual([...body.items[0].choices], [ids.heatYes, ids.oat]);
    assert.deepStrictEqual([...body.items[1].choices], [ids.heatNo]);
    assert.strictEqual(body.items[2].choices, undefined);
  });
}

(async () => {
  seed();
  const atShop = await theRead();
  thePanel(atShop);
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
