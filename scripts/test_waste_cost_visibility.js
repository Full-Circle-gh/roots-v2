#!/usr/bin/env node
/**
 * `waste:costs` — what the waste API sends to somebody who may not read money.
 *
 *   node scripts/test_waste_cost_visibility.js
 *
 * Seeing the waste ledger and reading what it cost are two permissions (Ash,
 * 2026-09-02). They were one: `waste:view` carried money:'shows' because "waste
 * is totalled in money", so the warehouse and store_manager presets — whose job
 * is recording what spoiled — read the cost of every loss in the business.
 *
 * WHY THIS TEST IS ABOUT THE WIRE AND NOT THE SCREENS. Both clients gate their
 * own layout, and that is worth doing — it is what keeps an empty column from
 * appearing where a cost used to be. But a screen that hides a number it was
 * SENT is a screen, not a permission: the figure is still in the JSON, one
 * devtools tab away. So the route does not send it, and these are the
 * assertions that hold that true. The client-side halves live in
 * scripts/test_mobile_waste.js.
 *
 * Six responses can carry money and every one is checked, because a strip
 * applied to five of six is not a strip — the sixth is where it leaks:
 *
 *   1. GET  /waste            rows      — cost_total_cents, is_uncosted
 *   2. GET  /waste            totals    — cost_total_cents, uncosted_entries
 *   3. GET  /waste/products   picker    — unit_cost, which neither client
 *                                         renders and both were sent anyway
 *   4. GET  /waste/preview              — the endpoint that is only a cost
 *   5. POST /waste            response  — what a phone builds its toast from
 *   6. POST /waste/:id/void   response  — both rows, original and reversal
 *
 * Pure request/response — no DB, no HTTP listener. The route module is mounted
 * on a bare express app with a stubbed tenant db, and `req.caps` is set the way
 * routes/retail.js sets it, because that is the input the strip reads.
 */
'use strict';

const path = require('path');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const absent  = (o, k, m) => (o && !(k in o) ? ok(m) : bad(m, k + ' is present: ' + JSON.stringify(o && o[k])));
const present = (o, k, m) => (o && (k in o) ? ok(m) : bad(m, k + ' is missing'));
const section = (t) => console.log('\n' + t);

// ── A waste table in memory ────────────────────────────────────────────────
// One live loss with a cost, one uncosted. Enough for every response shape.
const ROWS = [
  { id: 1, location_id: 1, subject_type: 'product', store_product_id: 9, material_id: null,
    qty: 4, unit: null, reason_code: 'spoiled', note: null,
    cost_total_cents: 9600, is_uncosted: 0, business_date: '2026-09-02',
    created_at: '2026-09-02 01:00:00', created_by: 3, created_by_label: 'Mei',
    reverses_waste_id: null, voided_at: null, voided_by: null, voided_by_label: null, voided_by_waste_id: null,
    product_name_en: 'Oat milk 1L', product_name_cn: '燕麦奶', product_sku: '10188',
    location_code: 'tianhe', location_name_en: 'Tianhe', location_name_cn: '天河店' },
  { id: 2, location_id: 1, subject_type: 'product', store_product_id: 10, material_id: null,
    qty: 1, unit: null, reason_code: 'damaged', note: null,
    cost_total_cents: null, is_uncosted: 1, business_date: '2026-09-02',
    created_at: '2026-09-02 02:00:00', created_by: 3, created_by_label: 'Mei',
    reverses_waste_id: null, voided_at: null, voided_by: null, voided_by_label: null, voided_by_waste_id: null,
    product_name_en: 'Mixed nuts 250g', product_name_cn: '混合坚果', product_sku: '10450',
    location_code: 'tianhe', location_name_en: 'Tianhe', location_name_cn: '天河店' },
];
const PICKER = [{ id: 9, name_en: 'Oat milk 1L', name_cn: '燕麦奶', sku: '10188', size: null, unit_cost: 24, on_hand: 18 }];
const TOTALS = { cost_total_cents: 9600, qty_total: 5, entries: 2, uncosted_entries: 1 };

// A db handle that answers by the SHAPE of the statement, which is all these
// routes need — every query here is a read whose result we are choosing.
function fakeDb() {
  return {
    prepare(sql) {
      const s = String(sql).replace(/\s+/g, ' ');
      return {
        get: (...a) => {
          if (/FROM storefront_config/.test(s)) return null;              // waste enabled
          if (/COUNT\(\*\) AS n FROM waste_records/.test(s)) return { n: 0 };
          if (/SUM\(w\.cost_total_cents\)/.test(s)) return { ...TOTALS };
          if (/FROM retail_stores/.test(s)) return { id: 1, timezone: 'Asia/Shanghai' };
          if (/FROM store_products/.test(s)) return { id: 9, name_en: 'Oat milk 1L', sku: '10188', weight: null };
          if (/physical_qty/.test(s)) return { q: 18 };
          if (/FROM waste_records WHERE id/.test(s)) return { ...ROWS[0] };
          if (/MAX\(id\) AS id FROM retail_stock_ledger/.test(s)) return { id: 77 };
          return undefined;
        },
        all: () => (/FROM store_products p/.test(s) ? PICKER.map(r => ({ ...r })) : ROWS.map(r => ({ ...r }))),
        run: () => ({ lastInsertRowid: 3, changes: 1 }),
      };
    },
    transaction: (fn) => (...a) => fn(...a),
  };
}

// ── Mount the route module with the seams stubbed ──────────────────────────
// The module resolves these at require time, so they are replaced in the cache
// before it loads. Only the seams — the route file itself is the real one.
const db = fakeDb();
function stub(rel, value) { require.cache[require.resolve(rel)] = { id: rel, filename: rel, loaded: true, exports: value }; }
stub('../lib/tenant-db',    { tdb: () => db, rawTenantDb: () => db });
stub('../lib/inventory',    { adjustStock: () => ({}) });
stub('../lib/product-cost', { productUnitCostYuan: () => 24 });
stub('../lib/business-date',{ businessDateForLocation: () => '2026-09-02' });
stub('../middleware/auth',  { logActivity: () => {} });
// requireRetailAdmin is the choke point that would normally set req.caps; the
// harness sets them per request instead, exactly as routes/retail.js does.
// Named from THIS file, not from the route's own folder: require.resolve is
// relative to the caller, while the cache key is the absolute path both agree
// on. routes/retail.js is 20k lines and is never executed here.
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });

const express = require('express');
const app = express();
// The body is attached directly rather than parsed off the stream: the route
// reads req.body, and express.json() wants a real socket to read from. What is
// under test is the strip, not the body parser.
app.use((req, res, next) => {
  const caps = req.headers['x-test-caps'];
  req.caps = caps === undefined ? null : new Set(String(caps).split(',').filter(Boolean));
  req.user = { id: 3, username: 'mei', display_name: 'Mei' };
  next();
});
app.use(require(path.join('..', 'routes', 'retail-waste')));

// ── Drive it without a socket ──────────────────────────────────────────────
function call(method, url, caps, body) {
  return new Promise((resolve) => {
    const req = Object.assign(require('stream').Readable.from([]), {
      method, url, originalUrl: url,
      headers: caps === null ? {} : { 'x-test-caps': caps.join(',') },
      body: body || {}, connection: {}, socket: {},
    });
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    app(req, res);
  });
}
const WITH    = ['waste:view', 'waste:costs', 'waste:record', 'waste:void'];
const WITHOUT = ['waste:view', 'waste:record', 'waste:void'];

(async () => {
  section('1 · the ledger — rows');
  {
    const yes = await call('GET', '/api/retail-admin/waste', WITH);
    const no  = await call('GET', '/api/retail-admin/waste', WITHOUT);
    present(yes.body.data[0], 'cost_total_cents', 'with waste:costs, the cost is sent');
    is(yes.body.data[0].cost_total_cents, 9600, 'and it is the real figure');
    absent(no.body.data[0], 'cost_total_cents', 'without it, no cost on the row');
    // The keys are DELETED, not zeroed: a null cost beside is_uncosted:1 would
    // render as "No cost", a claim about this product we are not making.
    absent(no.body.data[0], 'is_uncosted', 'nor the uncosted flag beside it');
    is(no.body.data[0].product_name_en, 'Oat milk 1L', 'everything else survives — this is a ledger, not a secret');
    is(no.body.data[0].qty, 4, 'including how many were lost');
    is(no.body.data.length, 2, 'and no row is dropped');
    is(no.body.costs_hidden, true, 'the envelope says why, so a client can tell withheld from absent');
  }

  section('2 · the ledger — totals');
  {
    const yes = await call('GET', '/api/retail-admin/waste', WITH);
    const no  = await call('GET', '/api/retail-admin/waste', WITHOUT);
    is(yes.body.totals.cost_total_cents, 9600, 'the total is sent to a reader who may have it');
    // Stripping the rows and leaving the total would hand back the one figure
    // that matters most — and the uncosted count is a fact about costing.
    absent(no.body.totals, 'cost_total_cents', 'and withheld from one who may not');
    absent(no.body.totals, 'uncosted_entries', 'with the uncosted count');
    is(no.body.totals.entries, 2, 'the count of losses stays — it is not money');
    present(no.body.totals, 'voided_entries', 'and so does the correction count');
  }

  section('3 · the picker');
  {
    const url = '/api/retail-admin/waste/products?location_id=1';
    const yes = await call('GET', url, WITH);
    const no  = await call('GET', url, WITHOUT);
    present(yes.body.data[0], 'unit_cost', 'the per-unit cost rides the picker');
    // Neither client renders it, which is exactly why it survived a reading of
    // both screens. It is money and it was on the wire.
    absent(no.body.data[0], 'unit_cost', 'and it is stripped for a cost-blind caller');
    is(no.body.data[0].on_hand, 18, 'on-hand stays — it is what the refusal is about');
    is(no.body.data[0].name_en, 'Oat milk 1L', 'and the product is still pickable');
  }

  section('4 · the preview, which is nothing but a cost');
  {
    const url = '/api/retail-admin/waste/preview?store_product_id=9&qty=4';
    const yes = await call('GET', url, WITH);
    const no  = await call('GET', url, WITHOUT);
    is(yes.body.data.cost_total_cents, 9600, 'answers the caller who may ask');
    absent(no.body.data, 'cost_total_cents', 'and has no reduced answer for one who may not');
    absent(no.body.data, 'unit_cost_yuan', 'nor the rate behind it');
    is(no.status, 200, 'not a 403 — nobody is refused a REQUEST for lacking this');
    is(no.body.costs_hidden, true, 'it says why instead');
  }

  section('5 · recording one');
  {
    const body = { location_id: 1, subject_type: 'product', store_product_id: 9, qty: 4, reason_code: 'spoiled' };
    const yes = await call('POST', '/api/retail-admin/waste', WITH, body);
    const no  = await call('POST', '/api/retail-admin/waste', WITHOUT, body);
    is(yes.status, 200, 'the write succeeds either way');
    is(no.status, 200, 'the capability gates a FIELD, never the recording');
    present(yes.body.data, 'cost_total_cents', 'the snapshot comes back to a reader who may have it');
    // This response is what a phone builds "Recorded 4 × Oat milk · ¥96" from,
    // and that toast is the easiest place in the flow to leak a cost.
    absent(no.body.data, 'cost_total_cents', 'and not to one who may not');
    absent(no.body.data, 'is_uncosted', 'nor the flag the toast reads');
    present(no.body.data, 'id', 'the row is still identified');
    is(no.body.costs_hidden, true, 'and the envelope says why');
  }

  section('6 · voiding one');
  {
    const url = '/api/retail-admin/waste/1/void';
    const yes = await call('POST', url, WITH, {});
    const no  = await call('POST', url, WITHOUT, {});
    present(yes.body.data.reversal, 'cost_total_cents', 'the reversal carries the original cost');
    // §32 rule 9 copies the cost onto BOTH rows, so both are strip sites.
    absent(no.body.data.reversal, 'cost_total_cents', 'stripped on the reversal');
    absent(no.body.data.original, 'cost_total_cents', 'and on the row it cancelled');
    is(no.body.data.original.voided_by_waste_id != null || no.body.data.original.id === 1, true,
      'the void itself still happened');
  }

  section('7 · the fail-closed rule');
  {
    // Every other cap check in this product answers "unknown ⇒ allow", because
    // an operator locked out by a resolution hiccup is worse than one shown a
    // control they cannot use. Money inverts the trade.
    const none = await call('GET', '/api/retail-admin/waste', null);
    absent(none.body.data[0], 'cost_total_cents', 'an unresolved cap set is sent no money');
    is(none.body.costs_hidden, true, 'and is told so');
    is(none.body.data.length, 2, 'while the ledger itself still answers');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
