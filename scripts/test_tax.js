#!/usr/bin/env node
/**
 * test_tax.js — sales tax and VAT (audit I-03).
 *
 *   node scripts/test_tax.js
 *
 * THE FINDING, in full: "There is no tax anywhere. No tax rate, no
 * inclusive/exclusive setting, no tax line on an order, no tax on a report. A
 * merchant anywhere that charges sales tax or VAT cannot use this product to do
 * it." Severity High, and marked table-stakes.
 *
 * WHAT IS BEING PROVEN HERE, in the order it matters:
 *
 *   1. THE ARITHMETIC. Tax is the calculation most often rounded twice — once
 *      per line and again on the total — and a receipt whose lines do not add
 *      up to its own total is the classic tax bug. lib/tax.js taxes ONE base,
 *      rounds once, and is driven here against the cases that expose a second
 *      rounding: 8.875% (a real New York rate, and not representable in
 *      ten-thousandths of a fraction), an inclusive rate that has to be backed
 *      OUT of a price rather than added to it, and a discount that must reduce
 *      the base because tax is owed on what was actually charged.
 *
 *   2. THE ORDER. The REAL create handler is extracted from routes/retail.js
 *      and run — the technique scripts/test_tx_conversion_manual_order.js uses
 *      and for its reason: a harness that runs a copy is testing a different
 *      program. An exclusive shop's total must go UP; an inclusive shop's must
 *      not move at all; and both must snapshot the rate and the shape onto the
 *      order, because a rate that changes in April must not restate March.
 *
 *   3. NOTHING MOVES FOR A SHOP THAT CHARGES NO TAX. This is the property the
 *      whole feature is shaped around and the one most easily lost: with no
 *      rate set, the order that comes out is byte-identical to the one that
 *      came out before any of this existed, and the three columns are NULL —
 *      which is a different fact from zero, and is asserted as such.
 *
 *   4. THE MONEY BACK. A refund of half an order returns half its tax,
 *      proportional to the gross the tax was charged on — and a refund of the
 *      whole thing returns exactly what was collected, by construction rather
 *      than by arithmetic.
 *
 *   5. THE RECEIPT. Where the line prints is decided by which kind of tax it
 *      is: an exclusive tax is an addition and sits in the column that adds up
 *      to TOTAL, an inclusive one is not and must not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

const tax = require(path.join(ROOT, 'lib', 'tax'));
const money = require(path.join(ROOT, 'lib', 'money'));

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const on = (over) => tax.settingsFrom({ tax: Object.assign({ enabled: true, mode: 'exclusive', rateMicro: tax.microFromPercent(20) }, over || {}) });

// ── §1 · the settings, and what counts as "on" ────────────────────────────
section('1 · a shop charges tax only when it has said so AND set a rate');

{
  is(tax.settingsFrom({}).enabled, false, 'a shop with no settings at all charges no tax');
  is(tax.settingsFrom({ tax: { enabled: true } }).enabled, false,
     'the switch alone is not enough — a rate of nothing charges nothing, and a zero-rate line on every receipt is noise');
  is(tax.settingsFrom({ tax: { rateMicro: 200000 } }).enabled, false,
     'and a rate alone is not enough either: somebody typing a number is not somebody switching it on');
  is(on().enabled, true, 'both together is on');
  is(tax.settingsFrom({ tax: { enabled: true, rateMicro: tax.MAX_RATE_MICRO + 1 } }).enabled, false,
     'a rate above 100% is a typo, not a tax rate, and reads as off rather than doubling a bill');
  is(tax.settingsFrom({ tax: { enabled: true, rateMicro: 200000, mode: 'sideways' } }).mode, 'exclusive',
     'an unrecognised shape falls back to the one that adds at checkout');
  is(tax.settingsFrom({ tax: { enabled: true, rateMicro: 200000 } }).label.en, 'Tax',
     'and an unnamed tax is called Tax');
  is(tax.settingsFrom({ tax: { enabled: true, rateMicro: 200000, label: { en: 'VAT', cn: '增值税' } } }).label.cn, '增值税',
     'while a shop that names it keeps its own word, in both languages');
}

{
  is(tax.microFromPercent(20), 200000, '20% is 200000 micro');
  is(tax.microFromPercent(8.875), 88750, 'and 8.875% — a real New York rate — is 88750, exactly');
  is(tax.percentFromMicro(88750), 8.875, 'which reads back as the same number');
}

// ── §2 · the arithmetic ───────────────────────────────────────────────────
section('2 · rounded once, half away from zero');

{
  const t = tax.taxOn({ subtotalMinor: 10000 }, on({ rateMicro: tax.microFromPercent(8.875) }));
  is(t.taxMinor, 888, '8.875% of 100.00 is 8.875, which lands on 8.88 and not 8.87');
  is(t.addedMinor, 888, 'and an exclusive tax is added on top');
  is(t.taxableMinor, 10000, 'on the base it was charged against');
}

{
  const t = tax.taxOn({ subtotalMinor: 1200 }, on({ mode: 'inclusive' }));
  is(t.taxMinor, 200, '20% inclusive of 12.00 is 2.00 — backed OUT of the price, not added to it');
  is(t.addedMinor, 0, 'and an inclusive tax adds nothing: the customer already paid it');
}

{
  // The two shapes on the same shelf price are the whole point of the setting.
  const excl = tax.preview(on(), 100);
  const incl = tax.preview(on({ mode: 'inclusive' }), 100);
  is(excl.pays, 120, 'a 100 price on an exclusive shop is charged as 120');
  is(excl.net, 100, 'and the shop keeps 100');
  is(incl.pays, 100, 'the same price on an inclusive shop is charged as 100');
  is(incl.tax, 16.67, 'of which 16.67 is tax');
  is(incl.net, 83.33, 'and the shop keeps 83.33 — the figure merchants are most often surprised by');
}

{
  const s = on();
  const withShip = tax.taxOn({ subtotalMinor: 10000, shippingMinor: 1200, packingMinor: 300 }, s);
  is(withShip.taxMinor, 2060, 'packing is taxed with the goods it boxes; delivery is not, by default');
  const shipToo = tax.taxOn({ subtotalMinor: 10000, shippingMinor: 1200, packingMinor: 300 }, on({ shippingTaxable: true }));
  is(shipToo.taxMinor, 2300, 'and is when the shop says its jurisdiction taxes delivery');
}

{
  const s = on();
  const d = tax.taxOn({ subtotalMinor: 10000, discountMinor: 2000 }, s);
  is(d.taxMinor, 1600, 'a discount comes off the base — tax is owed on what was charged, not on the sticker');
  const all = tax.taxOn({ subtotalMinor: 1000, discountMinor: 5000 }, s);
  is(all.taxMinor, 0, 'and a discount larger than the goods taxes nothing rather than going negative');
}

{
  const off = tax.taxOn({ subtotalMinor: 10000 }, tax.settingsFrom({}));
  is(off.taxMinor, 0, 'a shop that charges no tax computes none');
  is(off.enabled, false, 'and says so, so a caller can tell that from a tax of zero');
}

// ── §3 · the refund ───────────────────────────────────────────────────────
section('3 · money back takes its tax with it');

{
  const t = 888, gross = 10888;
  is(tax.taxInRefund({ taxMinor: t, grossMinor: gross, refundMinor: gross }), 888,
     'a full refund returns exactly what was collected — by construction, not by dividing');
  is(tax.taxInRefund({ taxMinor: t, grossMinor: gross, refundMinor: 5444 }), 444,
     'half the order returns half the tax');
  is(tax.taxInRefund({ taxMinor: t, grossMinor: gross, refundMinor: gross - 1 }), 888,
     'and a rounding artefact one cent short of the whole can never return MORE than was collected');
  is(tax.taxInRefund({ taxMinor: t, grossMinor: gross, refundMinor: 0 }), 0, 'nothing refunded, nothing returned');
  is(tax.taxInRefund({ taxMinor: 0, grossMinor: gross, refundMinor: 5444 }), 0,
     'and an order that carried no tax returns none');
}

// ── §4 · the order, through the real handler ──────────────────────────────
section('4 · what the create route stores');

const { openTablesDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8').replace(/\r\n/g, '\n');
const HANDLER_ANCHOR =
  "router.post('/api/retail-admin/orders', requireRetailAdmin, express.json(), async (req, res) => {";

function sliceHandler(src) {
  const i = src.indexOf(HANDLER_ANCHOR);
  assert.notStrictEqual(i, -1, 'the create handler anchor did not match — the route changed shape');
  const from = i + HANDLER_ANCHOR.length;
  const m = /\r?\n\}\);/.exec(src.slice(from));
  assert.ok(m, 'the handler is unterminated');
  return src.slice(from, from + m.index);
}
function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  assert.ok(m, `function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  assert.notStrictEqual(end, -1, `unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}
const BODY = sliceHandler(RETAIL_SRC);

function fixture(taxCfg) {
  const db = openTablesDb(DB_SRC, ['retail_customers', 'retail_orders', 'retail_order_items',
                                   'retail_payments', 'retail_stores', 'storefront_config']);
  addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
  db.prepare("INSERT INTO store_products (id, name_en, name_cn, sku, weight, sell_price, is_active) VALUES (1,'Tofu','豆腐','SKU1','500g',50,1)").run();
  db.prepare("INSERT INTO retail_stores (id, code, name_en) VALUES (1, 'MAIN', 'Main')").run();
  for (const [k, v] of Object.entries(taxCfg || {})) {
    db.prepare('INSERT INTO storefront_config (key, value_json) VALUES (?, ?)').run(k, JSON.stringify(v));
  }
  return db;
}
function handlerFor(db) {
  const scope = {
    tdb: () => db,
    withTransaction,
    crypto: require('crypto'),
    MANUAL_ORDER_CHANNELS: ['manual', 'pickup', 'wechat_chat', 'wholesale', 'other'],
    ORDER_FULFILLMENT_TYPES: ['delivery', 'pickup', 'counter'],
    createOrReuseManualCustomer: new Function('tdb', 'crypto', 'normEmail',
      `${extractFunction(RETAIL_SRC, 'createOrReuseManualCustomer')}\nreturn createOrReuseManualCustomer;`
    )(() => db, require('crypto'), (e) => (e == null ? '' : String(e).trim().toLowerCase())),
    nextOrderNo: new Function('tdb', `${extractFunction(RETAIL_SRC, 'nextOrderNo')}\nreturn nextOrderNo;`)(() => db),
    resolveManualOrderLines: new Function('tdb', 'productUnitCostYuan',
      `${extractFunction(RETAIL_SRC, 'costAtSale')}\n${extractFunction(RETAIL_SRC, 'resolveManualOrderLines')}\nreturn resolveManualOrderLines;`
    )(() => db, require(path.join(ROOT, 'lib', 'product-cost')).productUnitCostYuan),
    posClosedForStore: new Function('tdb', `${extractFunction(RETAIL_SRC, 'posClosedForStore')}\nreturn posClosedForStore;`)(() => db),
    // The real reader, over the fixture's own storefront_config rows.
    taxSettings: new Function('tdb', 'tax', `${extractFunction(RETAIL_SRC, 'taxSettings')}\nreturn taxSettings;`)(() => db, tax),
    tax, money,
    geocodeOrderSnapshotAsync: () => {},
    claimMigrationCredit: () => null,
    reconcileSignupVouchers: () => 0,
    logActivity: () => {},
    markOrderPaid: () => {},
  };
  const keys = Object.keys(scope);
  return new Function(...keys, `return async (req, res) => {${BODY}};`)(...keys.map((k) => scope[k]));
}
function makeRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
const ORDER = (over) => Object.assign({
  items: [{ product_id: 1, qty: 2 }],          // 2 × 50.00 = 100.00
  recipient_name: 'Ada',
  fulfillment_type: 'counter',
  store_id: 1,
  payment_method: 'cash',
}, over || {});

async function place(taxCfg, body) {
  const db = fixture(taxCfg);
  const res = makeRes();
  await handlerFor(db)({ body: ORDER(body), user: { id: 42, username: 'op' }, tenant: null, caps: null,
                         ip: '127.0.0.1', protocol: 'https', get: () => 'shop.example.com' }, res);
  const row = db.prepare('SELECT * FROM retail_orders ORDER BY id DESC LIMIT 1').get();
  return { res, row, db };
}

(async () => {
  {
    const { res, row } = await place(null);
    is(res.code, 200, 'a shop with no tax settings takes an order');
    is(row.total, 100, 'and charges exactly what the goods cost');
    is(row.tax_amount, null, 'the tax column is NULL — no tax was in force, which is not the same as a tax of zero');
    is(row.tax_rate_micro, null, 'no rate is snapshotted');
    is(row.tax_mode, null, 'and no shape');
  }

  {
    const { res, row } = await place({ 'tax.enabled': true, 'tax.mode': 'exclusive', 'tax.rateMicro': 200000 });
    is(res.code, 200, 'an exclusive shop takes the same order');
    is(row.subtotal, 100, 'the goods are still 100.00');
    is(row.total, 120, 'and the customer pays 120.00 — the tax is ADDED');
    is(row.tax_amount, 20, 'with 20.00 of tax recorded on the order');
    is(row.tax_rate_micro, 200000, 'the rate is snapshotted, so a change in April cannot restate March');
    is(row.tax_mode, 'exclusive', 'and so is the shape');
  }

  {
    const { res, row } = await place({ 'tax.enabled': true, 'tax.mode': 'inclusive', 'tax.rateMicro': 200000 });
    is(res.code, 200, 'an inclusive shop takes it too');
    is(row.total, 100, 'and the total does not move — the price already contained the tax');
    is(row.tax_amount, 16.67, 'of which 16.67 was tax');
    is(row.tax_mode, 'inclusive', 'recorded as the shape it was charged under');
  }

  {
    // The fees are taxed with the goods, on the base the server prices.
    const { row } = await place({ 'tax.enabled': true, 'tax.rateMicro': 200000, 'tax.shippingTaxable': true },
                                { fulfillment_type: 'delivery', address: { city: '上海市', address: 'Fuxing Road 12' },
                                  shipping_fee: 10, packing_fee: 5, store_id: null, payment_method: null,
                                  channel: 'wechat_chat' });
    is(row.tax_amount, 23, 'delivery and packing are taxed when the shop says they are');
    is(row.total, 138, 'and the bill is goods, fees and tax');
  }

  {
    // An operator who types a grand total has said what the customer pays.
    const { row } = await place({ 'tax.enabled': true, 'tax.mode': 'exclusive', 'tax.rateMicro': 200000 },
                                { total_override: 90 });
    is(row.total, 90, 'an overridden total is exactly what was typed — tax is never added on top of it');
    is(row.tax_amount, 15, 'and the tax is the share of that figure, backed out');
    is(row.tax_mode, 'inclusive', 'recorded as inclusive, because that is how it was computed');
  }

  {
    const { row } = await place({ 'tax.enabled': true, 'tax.rateMicro': 88750 });
    is(row.tax_amount, 8.88, 'a rate with four decimal places survives the round trip through the database');
    is(row.total, 108.88, 'and lands on the bill as a whole number of cents');
  }

  {
    // The switch on with no rate is the one combination that would look like it
    // worked and charge nothing.
    const { row } = await place({ 'tax.enabled': true, 'tax.rateMicro': 0 });
    is(row.tax_amount, null, 'a shop switched on with no rate charges no tax, and records none');
    is(row.total, 100, 'and the bill is unchanged');
  }

  // ── §5 · the receipt ────────────────────────────────────────────────────
  section('5 · where the line prints on 58mm paper');
  {
    const feie = require(path.join(ROOT, 'lib', 'feie'));
    const items = [{ name_en: 'Tofu', name_cn: '豆腐', qty: 2, unit_price: 50, line_total: 100 }];
    const base = { order_no: 'RT-1', subtotal: 100, shipping_fee: 0, packing_fee: 0, total: 120, status: 'paid' };
    const excl = feie.renderOrder('receipt', Object.assign({}, base, { tax_amount: 20, tax_mode: 'exclusive' }), items, 'Shop');
    const iTot = excl.indexOf('TOTAL'), iTax = excl.indexOf('Tax');
    yes(iTax > 0, 'an exclusive tax prints');
    yes(iTax < iTot, 'ABOVE the total, in the column that adds up to it — it is an addition and reads as one');

    const incl = feie.renderOrder('receipt', Object.assign({}, base, { total: 100, tax_amount: 16.67, tax_mode: 'inclusive' }), items, 'Shop');
    const jTot = incl.indexOf('TOTAL'), jTax = incl.indexOf('of which Tax');
    yes(jTax > 0, 'an inclusive tax prints too');
    yes(jTax > jTot, 'but BELOW the total — adding it into that column would stop the column adding up');

    const none = feie.renderOrder('receipt', base, items, 'Shop');
    is(/\bTax\b/.test(none), false, 'and a shop that charges no tax prints no tax line at all');
  }

  // ── §6 · the settings door ──────────────────────────────────────────────
  section('6 · a rate nobody meant cannot be stored');
  {
    // The generic config endpoint stores any dotted key and any JSON, which is
    // right for copy and colours. A wrong tax rate does not LOOK wrong — it
    // looks like a number — so the three keys that decide money are checked at
    // the only door they can arrive through.
    const put = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.put('/api/retail-admin/config'"));
    yes(/bad_tax_rate/.test(put.slice(0, 3000)), 'the config write refuses a rate it will not apply');
    yes(/bad_tax_mode/.test(put.slice(0, 3000)), 'and a shape it does not know');
    yes(/bad_tax_switch/.test(put.slice(0, 3000)), 'and a switch that is not a switch');
    yes(/tax\.MAX_RATE_MICRO|tax\.MODES/.test(put.slice(0, 3000)),
        'against lib/tax.js own bounds rather than a second copy of them');
  }

  // ── §7 · the customer's side computes it in the same place ──────────────
  section('7 · the checkout and its quote');
  {
    const checkout = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.post('/api/retail/orders'"));
    const taxAt = checkout.indexOf('const taxLine = tax.taxOn(');
    const pointsAt = checkout.indexOf('── Points redemption');
    const grossAt = checkout.indexOf('const grossTotal =');
    yes(taxAt > 0, 'the checkout computes tax');
    yes(taxAt < pointsAt, 'BEFORE points, which are a tender and not a discount — they change who pays the bill, not what it is');
    yes(taxAt < grossAt, 'and before the gross it goes into');
    yes(/discountMinor: money\.toMinor\(voucherDiscount\)/.test(checkout.slice(taxAt, taxAt + 600)),
        'on the discounted base, because tax is owed on what was actually charged');
    const quote = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.post('/api/retail/checkout/quote'"));
    yes(/quoteTaxCfg\.enabled \? \{/.test(quote), 'the quote hands the client a tax block, or null when there is none');
    yes(/rate_micro: quoteTaxCfg\.rateMicro/.test(quote),
        'including the rate, so a client that recomputes between quotes stays in step with the server');
  }

  // ── §7b · the INSERT nothing here executes ──────────────────────────────
  // §4 runs the manual-order handler for real, so its INSERT is proven by
  // execution. The CUSTOMER checkout's is not: driving it would mean standing
  // up vouchers, points, wallet, stock reservations and a customer session. So
  // the one failure that shape of change actually produces is checked directly
  // — three columns and three values added to a statement with forty-two
  // placeholders, where a miscount binds every value after the gap to the wrong
  // column and writes an order that looks plausible and is wrong.
  section('7b · the checkout INSERT still lines up');
  {
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const runArgs = (src, from) => {
      const at = src.indexOf(').run(', from);
      if (at < 0) return null;
      let depth = 0, args = 1, q = null, tpl = false;
      for (let i = at + 6; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '`') { tpl = !tpl; continue; }
        if (tpl) continue;
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')') { if (!depth) break; depth--; continue; }
        if (c === ']' || c === '}') { depth--; continue; }
        if (c === ',' && !depth) args++;
      }
      return args;
    };
    const src = strip(RETAIL_SRC);
    const re = /INSERT INTO retail_orders \(([\s\S]*?)\)\s*VALUES \(([^)]*)\)/g;
    let m, seen = 0;
    while ((m = re.exec(src))) {
      seen++;
      const cols = m[1].split(',').map((x) => x.trim()).filter(Boolean);
      const marks = (m[2].match(/\?/g) || []).length;
      const args = runArgs(src, m.index + m[0].length);
      is(cols.length, marks, `order INSERT #${seen}: ${cols.length} columns, ${marks} placeholders`);
      is(args, marks, `order INSERT #${seen}: and ${args} values bound to them`);
      for (const c of ['tax_amount', 'tax_rate_micro', 'tax_mode']) {
        yes(cols.includes(c), `order INSERT #${seen} carries ${c}`);
      }
    }
    is(seen, 2, 'both order INSERTs were found — the checkout and the manual one');
  }

  // ── §7c · the warning that would have cried wolf ────────────────────────
  section('7c · the drawer’s "these do not add up" band');
  {
    /* The order drawer prints an amber band when the lines, the fees and the
       deductions do not reach the order's total, and it is tolerant to ¥5 or
       30% of the basket. An exclusive tax lands squarely inside that tolerance
       today and outside it at a high enough rate — so without counting it as
       what it is, an exclusive shop would eventually get the band over every
       correct order, which is how a warning stops being read. An inclusive tax
       is already inside the line totals and must not be counted twice. */
    const ord = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');
    const at = ord.indexOf('function ordMoneyGap(');
    const body = ord.slice(at, ord.indexOf('\n}', at));
    yes(/tax_mode === 'exclusive'/.test(body),
        'the gap check counts an exclusive tax as the surcharge it is');
    yes(/const surcharges = [^\n]*taxAdded/.test(body),
        'adding it to the surcharges rather than to the deductions');
    yes(!/tax_mode === 'inclusive'/.test(body),
        'and counts an inclusive one not at all — it was already inside the lines');
  }

  // ── §8 · the report, over the wire ──────────────────────────────────────
  // Mounted for real rather than read: the refunded half is arithmetic (a
  // proportion of each order's own gross) and arithmetic asserted by grep is
  // arithmetic nobody has run. The stubs are the two things a report has no
  // business owning — who is allowed to ask, and which database — and nothing
  // else.
  section('8 · what the finance summary says about tax');
  {
    // expense_entries is declared in schema.sql rather than database.js, so it
    // is added from its own source — the real DDL either way, never a hand-typed
    // shape that could drift from the one the report reads.
    const db = openTablesDb(DB_SRC, ['retail_orders', 'retail_stores']);
    addTables(db, SCHEMA_SRC, DB_SRC, ['expense_entries']);
    const ins = db.prepare(
      `INSERT INTO retail_orders (order_no, status, total, tax_amount, tax_rate_micro, tax_mode,
                                  points_amount, balance_used, refund_amount_paid, placed_at, paid_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const day = '2026-09-01 10:00:00';
    //  · one plain taxed order: 100 of goods, 20 of tax, nothing back
    ins.run('A-1', 'paid', 120, 20, 200000, 'exclusive', 0, 0, 0, day, day);
    //  · one refunded in full: all of its tax comes back
    ins.run('A-2', 'paid', 120, 20, 200000, 'exclusive', 0, 0, 120, day, day);
    //  · one refunded by half, and paid partly in points — the proportion has
    //    to be of the GROSS, or a points-paid order returns too much tax
    ins.run('A-3', 'paid', 60, 20, 200000, 'exclusive', 60, 0, 60, day, day);
    //  · and one from a shop-day before tax existed
    ins.run('A-4', 'paid', 50, null, null, null, 0, 0, 0, day, day);

    function stub(rel, value) {
      const f = require.resolve(rel);
      require.cache[f] = { id: f, filename: f, loaded: true, exports: value };
    }
    stub('../lib/tenant-db', { tdb: () => db, getTenantDb: () => db, rawTenantDb: () => db });
    stub('../routes/retail', { requireRetailAdmin: (q, s, n) => n() });
    const express = require('express');
    const app = express();
    app.use(require(path.join(ROOT, 'routes', 'finance-summary.js')));
    const srv = app.listen(0);
    const base = 'http://127.0.0.1:' + srv.address().port;
    const j = await (await fetch(base + '/api/retail-admin/finance/summary?from=2026-09-01&to=2026-09-30')).json();
    const t = j.data && j.data.tax;
    yes(!!t, 'a window with taxed orders in it carries a tax block');
    is(t && t.collected, 60, 'collected is every order that carried tax — the untaxed one adds nothing');
    is(t && t.orders, 3, 'and it says how many orders that was');
    is(t && t.refunded, 30, 'refunded is proportional to each order’s own gross: 20 back in full, 10 of the half');
    is(t && t.net, 30, 'and net is what is actually owed on');

    const empty = await (await fetch(base + '/api/retail-admin/finance/summary?from=2026-10-01&to=2026-10-31')).json();
    is(empty.data.tax, null,
       'a window with no taxed order carries NULL — the row is absent from the report rather than reading as a tax of zero');
    srv.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
