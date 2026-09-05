#!/usr/bin/env node
/**
 * test_csv_import.js — the spreadsheet importer, audit E-05.
 *
 *   node scripts/test_csv_import.js
 *
 * No DB, no network, no browser. `public/retail-admin/24-import.js` is loaded
 * into a vm with the browser globals it closes over stubbed, and the REAL
 * parser, the REAL number coercion and the REAL per-entity validators are
 * exercised through `window.__tdImportInternals`. The wiring that cannot be
 * called — the two buttons and the script tag — is asserted against
 * retail-admin.html's own source.
 *
 * WHAT IS WORTH PROTECTING HERE. An importer is trusted in exactly one moment:
 * the day a merchant moves their whole catalogue in. Every case below is a way
 * that day goes wrong quietly.
 *
 *   - a price of "18,00" (a comma decimal, which half of Europe writes) must
 *     not become 1800, and "free" must not become 0
 *   - a quoted field containing a comma or a newline is one cell, not three
 *   - the same SKU twice must UPDATE, not make a second product
 *   - a row past the cap must be REPORTED, not dropped in silence (that is
 *     audit J-01's shape, and the supplier importer this one is modelled on
 *     still has it)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '24-import.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

let pass = 0, fail = 0;
// The module runs inside a vm, so the arrays it returns have that realm's
// Array.prototype and deepStrictEqual refuses them on identity alone. Compare
// by value; the shapes here are plain data.
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Load the module ────────────────────────────────────────────────────────
// The stubs are deliberately dumb: anything the module needs beyond these
// throws a ReferenceError naming what it wants, which is a legible failure.
const el = () => ({
  id: '', className: '', hidden: true, innerHTML: '', textContent: '', style: {},
  setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}, click() {},
});
const sandbox = {
  console: { log() {}, warn() {} },
  document: {
    head: { appendChild() {} }, body: { appendChild() {} },
    createElement: () => el(), getElementById: () => null,
    addEventListener() {}, dispatchEvent() {},
  },
  window: {},
  URL: { createObjectURL: () => 'blob:x' },
  Blob: function Blob() {},
  CustomEvent: function CustomEvent() {},
  FileReader: function FileReader() {},
  cuT: (en) => en,
  escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  api: async () => ({ data: [] }),
  toast: () => {},
  acMoney: (n) => '¥' + Number(n).toFixed(2),
  applyCapGates: () => {},
  askConfirm: async () => true,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const I = sandbox.__tdImportInternals;
assert.ok(I && I.parseCsvGrid, 'the module did not export its internals');
const { parseCsvGrid, num, SPECS, MAX_ROWS } = I;

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe CSV parser');

it('splits plain rows and drops the blank ones a spreadsheet leaves behind', () => {
  const g = parseCsvGrid('a,b,c\n1,2,3\n\n\n4,5,6\n');
  same(g, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

it('a quoted comma is one cell, not two', () => {
  const g = parseCsvGrid('name,notes\n"Oat milk, 1L",good\n');
  same(g[1], ['Oat milk, 1L', 'good']);
});

it('a quoted newline stays inside its cell', () => {
  const g = parseCsvGrid('name,notes\n"Tofu","firm\nsilken"\n');
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[1][1], 'firm\nsilken');
});

it('a doubled "" is one literal quote', () => {
  const g = parseCsvGrid('a\n"say ""hi"""\n');
  assert.strictEqual(g[1][0], 'say "hi"');
});

it('Excel’s byte-order mark does not become part of the first column name', () => {
  const g = parseCsvGrid('﻿name,price\nTofu,10\n');
  assert.strictEqual(g[0][0], 'name');
});

it('CRLF does not leave a stray carriage return on the last cell', () => {
  const g = parseCsvGrid('a,b\r\n1,2\r\n');
  same(g[1], ['1', '2']);
});

it('a file with no trailing newline still yields its last row', () => {
  const g = parseCsvGrid('a,b\n1,2');
  same(g[1], ['1', '2']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nNumbers — the difference between a price and a mistake');

it('reads a plain number', () => {
  same(num('18.5'), { ok: true, value: 18.5 });
});

it('strips a currency symbol and thousands separators', () => {
  assert.strictEqual(num('¥1,299.00').value, 1299);
  assert.strictEqual(num('$45').value, 45);
});

it('a blank is absent, not zero', () => {
  same(num(''), { ok: true, value: null });
  same(num(null), { ok: true, value: null });
});

it('REFUSES words — "free" must never become 0.00', () => {
  assert.strictEqual(num('free').ok, false);
  assert.strictEqual(num('call us').ok, false);
});

it('REFUSES a negative price', () => {
  assert.strictEqual(num('-5').ok, false);
});

it('a comma decimal is refused rather than silently read as thousands', () => {
  // "18,00" means 18 in much of Europe and 1800 if the comma is stripped as a
  // separator. Either guess is wrong somewhere, so it is refused and the row
  // is reported — the one outcome that cannot mis-price a catalogue.
  assert.strictEqual(num('18,00').ok, false);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nProducts — what the sheet is allowed to say');

const P = SPECS.products;
const prod = (o) => Object.assign({}, o);

it('a row with no name at all is skipped, not refused', () => {
  const v = P.validate(prod({ sell_price: '10' }));
  assert.ok(v && v.skip, 'expected a skip verdict');
});

it('a Chinese-only name is a product', () => {
  assert.strictEqual(P.validate(prod({ name_cn: '燕麦奶' })), null);
});

it('a bad price refuses the row and names the reason', () => {
  const v = P.validate(prod({ name_en: 'Tofu', sell_price: 'free' }));
  assert.ok(v && v.refuse, 'expected a refuse verdict');
  assert.match(v.refuse, /price/i);
});

it('a bad stock figure refuses the row too', () => {
  assert.ok(P.validate(prod({ name_en: 'Tofu', stock_qty: 'lots' })).refuse);
});

it('coerces price and stock in place, and a missing price is 0 not null', () => {
  const r = prod({ name_en: 'Tofu', sell_price: '¥12.50', stock_qty: '7.6' });
  assert.strictEqual(P.validate(r), null);
  assert.strictEqual(r.sell_price, 12.5);
  assert.strictEqual(r.stock_qty, 8);            // rounded — stock is whole units
  const b = prod({ name_en: 'Gift' });
  P.validate(b);
  assert.strictEqual(b.sell_price, 0);
  assert.strictEqual(b.compare_at_price, null);
});

it('matches on SKU, and falls back to the name when the sheet has no SKU', () => {
  assert.strictEqual(P.keyOf({ sku: 'OAT-1000', name_en: 'Oat milk' }), 'oat-1000');
  assert.strictEqual(P.keyOf({ name_en: 'Oat Milk' }), 'oat milk');
  // The two sides of the match must agree, or every row reads as new.
  assert.strictEqual(P.keyOf({ sku: 'A-1' }), P.keyOfRow({ sku: 'a-1' }));
  assert.strictEqual(P.keyOf({ name_cn: '豆腐' }), P.keyOfRow({ name_cn: '豆腐' }));
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nCustomers');

const C = SPECS.customers;

it('a name alone is enough, and a phone alone is enough', () => {
  assert.strictEqual(C.validate({ nickname: 'Mrs Huang' }), null);
  assert.strictEqual(C.validate({ phone: '13800000000' }), null);
});

it('neither is a skip', () => {
  assert.ok(C.validate({ note: 'paid cash' }).skip);
});

it('a phone is normalised to digits', () => {
  const r = { nickname: 'X', phone: '138 0000 0000' };
  C.validate(r);
  assert.strictEqual(r.phone, '13800000000');
});

it('a phone too short to be a phone refuses the row', () => {
  assert.ok(C.validate({ nickname: 'X', phone: '123' }).refuse);
});

it('identity is the phone — a customer with none can only ever be new', () => {
  assert.strictEqual(C.keyOf({ phone: '138-0000-0000' }), '13800000000');
  assert.strictEqual(C.keyOf({ nickname: 'Walk-in' }), '');
});

it('never updates in place — the server reuses on phone instead', () => {
  // There is no PUT /customers/:id. The create path already links an existing
  // customer rather than duplicating, so the sheet must not overwrite what is
  // already known about somebody.
  assert.strictEqual(C.update, null);
  assert.ok(C.updateLabelEn && !/update/i.test(C.updateLabelEn),
    'the preview must not promise an update it does not perform');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe template a merchant downloads');

it('every template column name is one the importer actually recognises', () => {
  for (const key of Object.keys(SPECS)) {
    const s = SPECS[key];
    for (const h of s.header.split(',')) {
      assert.ok(s.map[h.trim().toLowerCase()],
        `${key}: the template offers "${h}" and the importer ignores it`);
    }
  }
});

it('every template example row has as many cells as the header has columns', () => {
  for (const key of Object.keys(SPECS)) {
    const s = SPECS[key];
    const want = s.header.split(',').length;
    for (const ex of s.examples) {
      const got = parseCsvGrid(s.header + '\n' + ex)[1].length;
      assert.strictEqual(got, want, `${key}: example has ${got} cells, header has ${want}`);
    }
  }
});

it('the example rows survive the importer’s own validation', () => {
  for (const key of Object.keys(SPECS)) {
    const s = SPECS[key];
    const grid = parseCsvGrid(s.header + '\n' + s.examples.join('\n'));
    const headers = grid[0].map(h => h.trim().toLowerCase());
    for (const cells of grid.slice(1)) {
      const rec = {};
      headers.forEach((h, i) => { const f = s.map[h]; const v = String(cells[i] ?? '').trim(); if (f && v) rec[f] = v; });
      assert.strictEqual(s.validate(rec), null, `${key}: its own example would not import`);
    }
  }
});

it('no template example names the first merchant', () => {
  // The supplier template's example row is first-merchant-shaped, which the
  // audit called out (E-05 evidence). These must be generic.
  for (const key of Object.keys(SPECS)) {
    const blob = SPECS[key].examples.join(' ');
    assert.doesNotMatch(blob, /full circle|哈素萌|go vegan/i, `${key} example`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe cap is reported, not silent');

it('a row past the cap is counted so the screen can say so', () => {
  assert.strictEqual(MAX_ROWS, 1000);
  const src = SRC.slice(SRC.indexOf('_over = Math.max'), SRC.indexOf('_over = Math.max') + 200);
  assert.match(src, /_over = Math\.max\(0, body\.length - MAX_ROWS\)/);
  // And it must reach the screen, not just the variable.
  assert.match(SRC, /_over \?[\s\S]{0,400}will NOT be imported/,
    'the overflow must be rendered, or it is the silent truncation this fixes');
});

it('the preview counts every row into exactly one bucket', () => {
  const buckets = ['new', 'update', 'skip', 'refuse'];
  for (const b of buckets) assert.ok(SRC.includes(`'${b}'`), `no ${b} action`);
  assert.match(SRC, /const willDo = news \+ upds;/);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe wiring');

it('the module is loaded, and after the dialogs it calls', () => {
  const dlg = HTML.indexOf('/assets/tacet-dialogs.js');
  const imp = HTML.indexOf('/assets/retail-admin/24-import.js');
  assert.ok(imp > 0, 'the script tag is missing');
  assert.ok(dlg > 0 && dlg < imp, 'askConfirm must be defined before this module runs');
});

it('Products offers it, gated on products:edit', () => {
  assert.match(HTML, /data-cap="products:edit"[^>]*onclick="paAddMenuClose\(\);tdImportOpen\('products'\)"/);
});

it('Customers offers it, gated on customers:edit, beside Export', () => {
  assert.match(HTML, /data-cap="customers:edit"[^>]*onclick="tdImportOpen\('customers'\)"/);
  const exp = HTML.indexOf('id="cu-export-btn"');
  const imp = HTML.indexOf('id="cu-import-btn"');
  assert.ok(exp > 0 && imp > exp && imp - exp < 900, 'Import belongs next to Export');
});

it('both capabilities exist in the capability list', () => {
  const caps = fs.readFileSync(path.join(ROOT, 'lib', 'capabilities.js'), 'utf8');
  for (const c of ['products:edit', 'customers:edit']) {
    assert.ok(caps.includes(`'${c}'`), `${c} is not a real capability`);
  }
});

it('the supplier importer is untouched — it is the flow this one copies', () => {
  const pu = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js'), 'utf8');
  assert.ok(pu.includes('window.puImportRun'), 'the supplier import must still be there');
  assert.ok(pu.includes('const CSV_MAP'), 'and its own map');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
