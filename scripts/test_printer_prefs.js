#!/usr/bin/env node
/**
 * test_printer_prefs.js — the printer settings every print path reads.
 *
 *   node scripts/test_printer_prefs.js
 *
 * WHAT IT GUARDS. loadPrinterPrefs() turns the tenant's printer.* rows in
 * storefront_config into one settings object: whether paid orders, add-ons and
 * refund requests print by themselves, each shop's printer, the kitchen's
 * printer and its brand, the stock-request slip switch, the name on the slip,
 * and the shop that prints every out-of-city order. Order printing, the kitchen
 * and stock-request slips and the delivery zone's store choice all read it.
 * A mutation sweep (2026-10-16) broke it four ways and no suite noticed any.
 *
 * HOW. The real function is lifted from the source (retailSource(), so it is
 * found in routes/retail.js or in lib/ after decisions §477 moves it) and run
 * over the real storefront_config table, with the real printer-brand list and
 * the real kitchen and stock-request slip defaults.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}

const db = openTablesDb(DB_SRC, ['storefront_config']);
const loadPrinterPrefs = new Function('tdb', '_printers', '_kprint', '_tprint', 'tenantBrandLabel',
  `${fnSrc('loadPrinterPrefs')}\nreturn loadPrinterPrefs;`)(
  () => db,
  require(path.join(ROOT, 'lib', 'printers')),
  require(path.join(ROOT, 'lib', 'kitchen-print')),
  require(path.join(ROOT, 'lib', 'transfer-print')),
  () => 'Roots');

const set = (key, value) => db.prepare(
  'INSERT INTO storefront_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
).run(key, JSON.stringify(value));
const setRaw = (key, raw) => db.prepare(
  'INSERT INTO storefront_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
).run(key, raw);

let pass = 0, fail = 0;
function it(name, fn) {
  db.prepare('DELETE FROM storefront_config').run();
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. a tenant who never opened the printer page');
it('everything prints by itself, slips name the brand, no shop printers, no out-of-city shop', () => {
  assert.deepStrictEqual(loadPrinterPrefs(), {
    auto_print: true,
    auto_print_addon: true,
    auto_print_refund: true,
    kitchen_sn: '',
    kitchen_vendor: 'feie',
    kitchen_print_on: 'sent',
    kitchen_copies: 1,
    transfer_print_on: 'sent',
    shop_name: 'Roots',
    by_store: {},
    out_of_city_store_id: null,
  });
});

console.log('\n2. saved settings are read back');
it('each switch is its own: paid orders off leaves add-ons and refunds on', () => {
  set('printer.auto_print', false);
  const p = loadPrinterPrefs();
  assert.strictEqual(p.auto_print, false);
  assert.strictEqual(p.auto_print_addon, true);
  assert.strictEqual(p.auto_print_refund, true);
  set('printer.auto_print_addon', false);
  set('printer.auto_print_refund', false);
  assert.strictEqual(loadPrinterPrefs().auto_print_addon, false);
  assert.strictEqual(loadPrinterPrefs().auto_print_refund, false);
});
it('the shops\' printers come back as saved, keyed by shop id', () => {
  const map = { 1: { sn: 'SN-TIANHE', template: 'receipt', copies: 2 }, 977: { sn: 'SN-WAREHOUSE', template: 'pack', copies: 1, vendor: 'spyun' } };
  set('printer.by_store', map);
  assert.deepStrictEqual(loadPrinterPrefs().by_store, JSON.parse(JSON.stringify(map)));
});
it('a shop printer list that is not a list of shops reads as none', () => {
  for (const bad of ['SN-TIANHE', null, 7]) {
    set('printer.by_store', bad);
    assert.deepStrictEqual(loadPrinterPrefs().by_store, {}, JSON.stringify(bad));
  }
});
it('the kitchen printer number is trimmed; blank or missing is ""', () => {
  set('printer.kitchen_sn', '  SN-KITCHEN  ');
  assert.strictEqual(loadPrinterPrefs().kitchen_sn, 'SN-KITCHEN');
  set('printer.kitchen_sn', null);
  assert.strictEqual(loadPrinterPrefs().kitchen_sn, '');
});
it('the kitchen printer brand is a known brand; anything else is Feie', () => {
  set('printer.kitchen_vendor', 'spyun');
  assert.strictEqual(loadPrinterPrefs().kitchen_vendor, 'spyun');
  set('printer.kitchen_vendor', 'acme');
  assert.strictEqual(loadPrinterPrefs().kitchen_vendor, 'feie');
});
it('kitchen and stock-request slip settings, copies and the slip name come back as saved', () => {
  set('printer.kitchen_print_on', 'both');
  set('printer.kitchen_copies', 3);
  set('printer.transfer_print_on', 'off');
  set('printer.shop_name', 'Roots Tianhe');
  const p = loadPrinterPrefs();
  assert.strictEqual(p.kitchen_print_on, 'both');
  assert.strictEqual(p.kitchen_copies, 3);
  assert.strictEqual(p.transfer_print_on, 'off');
  assert.strictEqual(p.shop_name, 'Roots Tianhe');
});
it('a row that is not readable JSON falls back to its default', () => {
  setRaw('printer.auto_print', 'not json');
  setRaw('printer.shop_name', '{');
  const p = loadPrinterPrefs();
  assert.strictEqual(p.auto_print, true);
  assert.strictEqual(p.shop_name, 'Roots');
});

console.log('\n3. the out-of-city shop');
it('a shop id, saved as a number or as text, is a number', () => {
  set('printer.out_of_city_store_id', 977);
  assert.strictEqual(loadPrinterPrefs().out_of_city_store_id, 977);
  set('printer.out_of_city_store_id', '977');
  assert.strictEqual(loadPrinterPrefs().out_of_city_store_id, 977);
});
it('blank, unset, negative, decimal or text means no out-of-city shop (null), never NaN', () => {
  for (const v of [null, '', '-1', 12.5, 'tianhe']) {
    set('printer.out_of_city_store_id', v);
    assert.strictEqual(loadPrinterPrefs().out_of_city_store_id, null, JSON.stringify(v));
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
