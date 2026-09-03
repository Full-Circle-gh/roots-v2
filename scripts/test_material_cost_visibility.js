#!/usr/bin/env node
/**
 * `materials:costs` — what the materials API sends to somebody who may not read
 * money, and what it refuses to let them write.
 *
 *   node scripts/test_material_cost_visibility.js
 *
 * The masterlist and its prices were one permission (Ash, 2026-09-03).
 * `materials:view` carried money:'shows' because the list has two money columns
 * — Buy price and Cost per unit — so the warehouse and store_manager presets
 * read what every supplier charges and the cost basis of every margin. The same
 * warehouse operator had just been stopped from seeing what a dropped jar cost;
 * leaving them every ingredient's buy price was the same fact by another door.
 *
 * Sibling of scripts/test_waste_cost_visibility.js and deliberately its twin:
 * same fail-closed rule, same delete-don't-zero rule, same "refuses a field,
 * never a request". Read them together — a divergence between the two is worth
 * noticing.
 *
 * FOUR READ PAYLOADS carry money on this API and each is checked:
 *   1. GET  /materials       list rows   — cost_per_unit, buy_price
 *   2. GET  /materials/:id   the record  — the same two on the row
 *   3. GET  /materials/:id   priceHistory — a list of past buy prices
 *   4. GET  /materials/:id   purchases   — cost_per_unit + total_cost per PO
 *      (plus `derived.cpu`, the recomputed cost, whose REASON is kept)
 *
 * AND ONE WRITE, which is the part that is data loss rather than disclosure.
 * The editor omits the Buy price field for a cost-blind operator, readBody()
 * turns an absent field into 0, and the UPDATE writes it unconditionally — so
 * renaming a material would have wiped its price, written a price-history row
 * recording the wipe, and fired a >5% change alert. §5 is that test.
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

// ── The catalogue, in memory ───────────────────────────────────────────────
const ROW = {
  id: 7, name_en: 'Oat groats', name_cn: '燕麦粒', sku: 'M-108', category: 'Grains',
  unit: 'g', buy_unit: 'kg', buy_pack_size: 1, pack_contents_qty: 1000, pack_contents_unit: 'g',
  cost_per_unit: 0.042, buy_price: 42, free_by_design: 0, supplier: 'Fresh Co.',
  supplier_platform: null, supplier_link: null, allergens: null, notes: null,
  accounting_category: 'Ingredients', item_kind: 'food', source_recipe_id: null,
  is_active: 1, created_at: '2026-01-01', updated_at: '2026-09-01',
};
const HISTORY  = [{ id: 1, price: 42, buy_unit: 'kg', source: 'manual', notes: null, recorded_at: '2026-08-01', recorded_by: 'mei' }];
const PURCHASE = [{ po_id: 3, po_number: 'RPO-0042', date: '2026-08-14', status: 'Delivered',
                    supplier: 'Fresh Co.', qty: 20, unit: 'kg', cost_per_unit: 42, total_cost: 840 }];

let written = null;                       // what the UPDATE actually wrote
let historyWrites = 0;                    // price-history rows the save created

function fakeDb() {
  return {
    prepare(sql) {
      const s = String(sql).replace(/\s+/g, ' ');
      return {
        get: () => {
          if (/FROM ingredients WHERE id/.test(s)) return { ...ROW };
          if (/SUM\(source_recipe_id IS NULL\)/.test(s)) return { bought: 1, made: 0 };
          return undefined;
        },
        all: () => {
          if (/FROM ingredient_price_history/.test(s)) return HISTORY.map(r => ({ ...r }));
          if (/FROM po_line_items/.test(s)) return PURCHASE.map(r => ({ ...r }));
          if (/GROUP BY 1/.test(s)) return [{ k: 'food', n: 1 }];
          if (/FROM ingredients/.test(s)) return [{ ...ROW }];
          return [];
        },
        run: (...args) => {
          if (/UPDATE ingredients SET/.test(s)) written = args;
          if (/INSERT INTO ingredient_price_history/.test(s)) historyWrites++;
          return { lastInsertRowid: 9, changes: 1 };
        },
      };
    },
    transaction: (fn) => (...a) => fn(...a),
  };
}

const db = fakeDb();
function stub(rel, value) { require.cache[require.resolve(rel)] = { id: rel, filename: rel, loaded: true, exports: value }; }
// The route reads through BOTH handles: `db` (the global handle, used by
// the list and record reads) and tdb() (the tenant handle, used by the
// writes). Stubbing only one boots the real database.js and its migrations.
stub('../database', db);
stub('../lib/tenant-db', { tdb: () => db, rawTenantDb: () => db });
stub('../lib/recipe-rollup', { fireRecompute: () => {}, costOneRecipe: () => ({ ok: true }) });
stub('../lib/recipe-materialize', { materialConsumers: () => [] });
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });

const express = require('express');
const app = express();
app.use((req, res, next) => {
  const caps = req.headers['x-test-caps'];
  req.caps = caps === undefined ? null : new Set(String(caps).split(',').filter(Boolean));
  req.user = { id: 3, username: 'mei', display_name: 'Mei' };
  next();
});
app.use(require(path.join('..', 'routes', 'retail-materials')));

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
      json(p) { resolve({ status: this.statusCode, body: p }); return this; },
      send(p) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    app(req, res);
  });
}
const WITH    = ['materials:view', 'materials:costs', 'materials:edit'];
const WITHOUT = ['materials:view', 'materials:edit'];

(async () => {
  section('1 · the list');
  {
    const yes = await call('GET', '/api/retail-admin/materials', WITH);
    const no  = await call('GET', '/api/retail-admin/materials', WITHOUT);
    is(yes.body.data[0].buy_price, 42, 'with materials:costs, the buy price is sent');
    is(yes.body.data[0].cost_per_unit, 0.042, 'and the cost per unit');
    absent(no.body.data[0], 'buy_price', 'without it, no buy price');
    absent(no.body.data[0], 'cost_per_unit', 'and no cost per unit');
    // The masterlist is still a masterlist: what it is, whose it is, how it is
    // measured. Only the two money columns go.
    is(no.body.data[0].name_en, 'Oat groats', 'the material is still named');
    is(no.body.data[0].supplier, 'Fresh Co.', 'the supplier stays — that is not a price');
    is(no.body.data[0].unit, 'g', 'and the units stay');
    is(no.body.costs_hidden, true, 'the envelope says why');
    is(no.body.counts.food, 1, 'the chip counts still answer');
  }

  section('2 · the record');
  {
    const url = '/api/retail-admin/materials/7';
    const yes = await call('GET', url, WITH);
    const no  = await call('GET', url, WITHOUT);
    present(yes.body.data, 'buy_price', 'the record carries its price for a reader who may have it');
    absent(no.body.data, 'buy_price', 'and not for one who may not');
    absent(no.body.data, 'cost_per_unit', 'nor the cost derived from it');
    is(no.body.data.pack_contents_qty, 1000, 'pack contents stay — measurement, not money');
  }

  section('3 · cost history');
  {
    const url = '/api/retail-admin/materials/7';
    const yes = await call('GET', url, WITH);
    const no  = await call('GET', url, WITHOUT);
    is(yes.body.priceHistory.length, 1, 'the price history is sent to a reader who may have it');
    // A list of past buy prices is money end to end; there is no reduced form.
    is(no.body.priceHistory.length, 0, 'and withheld entirely from one who may not');
  }

  section('4 · bought in');
  {
    const url = '/api/retail-admin/materials/7';
    const yes = await call('GET', url, WITH);
    const no  = await call('GET', url, WITHOUT);
    is(yes.body.purchases[0].total_cost, 840, 'what the PO line cost is sent');
    absent(no.body.purchases[0], 'total_cost', 'and stripped for a cost-blind caller');
    absent(no.body.purchases[0], 'cost_per_unit', 'with the rate behind it');
    // Losing the whole line would take the useful half: which PO, when, how many.
    is(no.body.purchases[0].po_number, 'RPO-0042', 'the order it arrived on stays');
    is(no.body.purchases[0].qty, 20, 'and how much of it');
    // `derived` is the recomputed cost. The figure goes; the DIAGNOSIS stays,
    // because "no pack contents recorded" is what gets a material costed at all
    // and is exactly what this operator is best placed to fix.
    absent(no.body.derived, 'cpu', 'the recomputed cost goes');
    present(no.body.derived, 'reason', 'the reason it could not be worked out stays');
  }

  section('5 · the write — you cannot change what you cannot see');
  {
    // The editor omits Buy price, so the client sends nothing for it and
    // readBody() makes that a 0. Unguarded, this save wipes ¥42.
    written = null; historyWrites = 0;
    const no = await call('PUT', '/api/retail-admin/materials/7', WITHOUT,
      { name_en: 'Oat groats (organic)', item_kind: 'food' });
    is(no.status, 200, 'the rename succeeds — the capability gates a FIELD, not the edit');
    // buy_price is the 12th bound parameter in the UPDATE; assert on the value
    // rather than the position by finding it among what was written.
    is(written.includes(42), true, 'and the stored price is carried through, not zeroed');
    is(written.includes('Oat groats (organic)'), true, 'while the name really did change');
    is(historyWrites, 0, 'no price-history row is written for a change that did not happen');

    written = null; historyWrites = 0;
    const yes = await call('PUT', '/api/retail-admin/materials/7', WITH,
      { name_en: 'Oat groats', item_kind: 'food', buy_price: 45, buy_unit: 'kg' });
    is(yes.status, 200, 'an operator who may see prices may still set one');
    is(written.includes(45), true, 'and the new price is written');
    is(historyWrites, 1, 'with a price-history row, as before');
  }

  section('6 · create');
  {
    written = null;
    const no = await call('POST', '/api/retail-admin/materials', WITHOUT,
      { name_en: 'Sunflower seeds', item_kind: 'food', buy_price: 30 });
    is(no.status, 200, 'a cost-blind operator can still add a material');
    // There is no stored value to carry through, so it starts unpriced — the
    // honest outcome, and it cannot be used to smuggle a price in either.
    is(no.body.success, true, 'and it saves');
  }

  section('7 · the fail-closed rule');
  {
    const none = await call('GET', '/api/retail-admin/materials', null);
    absent(none.body.data[0], 'buy_price', 'an unresolved cap set is sent no money');
    is(none.body.costs_hidden, true, 'and is told so');
    is(none.body.data[0].name_en, 'Oat groats', 'while the masterlist still answers');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
