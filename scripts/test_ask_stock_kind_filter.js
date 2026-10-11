#!/usr/bin/env node
/**
 * Ask for stock — materials and what is sold, apart.
 *
 *   node scripts/test_ask_stock_kind_filter.js
 *
 * Ash, restocking Yuexiu: the materials and the retail products came up as one
 * list. The picker now splits them on the product's own "Restock-only,
 * internal" flag (store_products.is_restock_only), behind an
 * All · Products · Materials switch.
 *
 * The functions are SLICED FROM public/m.html and run against stubs, the same
 * way test_search_clear.js draws the picker. Nothing here is a copy of the
 * markup.
 *
 * Cases:
 *   1. the catalogue load carries the flag through as `material`
 *   2. no switch when nothing is a material — there is nothing to split
 *   3. no switch when everything is a material — same reason
 *   4. with both kinds, the switch is drawn with each side's count
 *   5. each side lists only its own kind; All lists everything
 *   6. the search works inside the chosen side
 *   7. quantities picked on one side survive switching, and the foot counts both
 *   8. a new request starts on All
 *   9. the command accepts only the three keys, anything else is All
 *  10. the labels are the live pairs, not composed ones
 *  11. the list runs in SKU order, numerically, no-SKU last; search keeps it
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}
// The body of a reg('name', ...) handler, as a callable.
function handler(name) {
  const at = SRC.indexOf(`reg('${name}', `);
  if (at < 0) throw new Error(`handler ${name} not found`);
  const end = SRC.indexOf('\n', at);
  return SRC.slice(at + `reg('${name}', `.length, end).replace(/\);\s*$/, '');
}

const PRODUCTS = [
  { id: 1, name_en: 'Oat Milk',        name_cn: '燕麦奶',   sku: 'P-1', material: false },
  { id: 2, name_en: 'Rye Loaf',        name_cn: '黑麦面包', sku: 'P-2', material: false },
  { id: 3, name_en: 'Paper Cup 12oz',  name_cn: '纸杯',     sku: 'M-1', material: true  },
];

function sandbox(over, products) {
  const sb = {
    state: { rq: Object.assign({ products: (products || PRODUCTS).slice(), tried: true, fromShelf: false,
      q: '', qty: {}, kind: 'all', busy: false, err: '', sent: null, purpose: null, from: null, to: null }, over) },
    T: (en) => en,
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    searchBox: (input) => input,
    rqName: (p) => p.name_en || '',
    render: () => {},
    console, Number, String, Array, Object, JSON, Math,
  };
  vm.createContext(sb);
  for (const n of ['rcvSkuKey', 'rcvSkuCmp', 'rqKindOf', 'rqLines', 'rqKindSeg', 'rqCountCell', 'rqBodyHtml', 'rqPicker', 'rqChosen', 'rqUnits']) {
    vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  }
  vm.runInContext(`var rqKindCmd = ${handler('rqKind')};`, sb, { filename: 'reg#rqKind' });
  return sb;
}
const names = (sb) => vm.runInContext('rqLines()', sb).map(p => p.name_en);

console.log('\n══ the flag arrives ══');
{
  const load = sliceFn('loadRqProducts');
  ok(/material:Number\(p\.is_restock_only\)===1/.test(load),
     'the catalogue load maps is_restock_only onto `material`');
  ok((load.match(/is_restock_only/g) || []).length === 2,
     'and so does the shelf fallback, so the two paths agree');
  ok(/is_restock_only/.test(fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8')
       .split("router.get('/api/retail-admin/products'")[1].split('FROM store_products')[0]),
     'and the products list the picker reads actually selects it');
}

console.log('\n══ when the switch is drawn ══');
{
  const none = sandbox({}, PRODUCTS.filter(p => !p.material));
  ok(vm.runInContext('rqKindSeg()', none) === '', 'nothing flagged → no switch');
  const only = sandbox({}, PRODUCTS.filter(p => p.material));
  ok(vm.runInContext('rqKindSeg()', only) === '', 'everything flagged → no switch');
  const both = sandbox({});
  const seg = vm.runInContext('rqKindSeg()', both);
  ok(seg.includes("APP.cmd('rqKind','all')") && seg.includes("APP.cmd('rqKind','product')")
     && seg.includes("APP.cmd('rqKind','material')"), 'both kinds → All, Products and Materials are drawn');
  ok(/All <span class="num"[^>]*>3</.test(seg) && /Products <span class="num"[^>]*>2</.test(seg)
     && /Materials <span class="num"[^>]*>1</.test(seg), 'each carries its count');
  const pick = vm.runInContext('rqPicker()', both);
  ok(pick.indexOf("rqKind','all'") < pick.indexOf('id="mRqBody"'),
     'the switch sits outside the box a keystroke repaints, so typing never rebuilds it');
}

console.log('\n══ what each side lists ══');
{
  const sb = sandbox({});
  ok(names(sb).join() === 'Paper Cup 12oz,Oat Milk,Rye Loaf', 'All lists everything, in SKU order');
  sb.state.rq.kind = 'product';
  ok(names(sb).join() === 'Oat Milk,Rye Loaf', 'Products lists only what is sold');
  sb.state.rq.kind = 'material';
  ok(names(sb).join() === 'Paper Cup 12oz', 'Materials lists only the materials');
  sb.state.rq.kind = 'product'; sb.state.rq.q = 'rye';
  ok(names(sb).join() === 'Rye Loaf', 'the search works inside the chosen side');
  sb.state.rq.kind = 'material'; sb.state.rq.q = 'rye';
  ok(names(sb).length === 0, 'and finds nothing that is on the other side');
}

console.log('\n══ SKU order ══');
{
  /* Ash, on a screenshot of Ask for stock: "not organized by sku". The list
     came in the server's order — 3-270 above 1-225 above 4-545. It now runs on
     Receiving's comparator, as Add stock does: both halves numeric, so 1-50
     comes before 1-225, and a draft with no SKU sinks. */
  const shelf = [
    { id: 11, name_en: 'Whole-Wheat Wraps',     sku: '3-270', material: false },
    { id: 12, name_en: 'Zhoug',                 sku: '1-225', material: false },
    { id: 13, name_en: 'BioCurcumin+',          sku: '4-545', material: false },
    { id: 14, name_en: 'Misfit Medjool Dates',  sku: '',      material: false },
    { id: 15, name_en: 'Powerhouse Greens',     sku: '4-500', material: false },
    { id: 16, name_en: 'Basil',                 sku: '1-50',  material: false },
    { id: 17, name_en: 'Kraft Bag',             sku: '9-10',  material: true  },
  ];
  const sb = sandbox({}, shelf);
  const ids = () => vm.runInContext('rqLines()', sb).map(p => p.id).join();
  ok(ids() === '16,12,11,15,13,17,14', 'All runs by SKU, numerically, no-SKU last');
  sb.state.rq.kind = 'product';
  ok(ids() === '16,12,11,15,13,14', 'and so does each side');
  sb.state.rq.q = 'w';
  ok(ids() === '11,15', 'a search keeps the order');
  ok(sb.state.rq.products.map(p => p.id).join() === '11,12,13,14,15,16,17',
     'and the list as loaded is left as it was');
}

console.log('\n══ quantities survive switching ══');
{
  const sb = sandbox({ qty: { 1: 4, 3: 50 } });
  vm.runInContext("rqKindCmd('material')", sb);
  ok(sb.state.rq.qty[1] === 4 && sb.state.rq.qty[3] === 50, 'switching side keeps what was picked');
  ok(vm.runInContext('rqChosen().length', sb) === 2 && vm.runInContext('rqUnits()', sb) === 54,
     'and the foot still counts both kinds');
}

console.log('\n══ the command ══');
{
  const sb = sandbox({});
  vm.runInContext("rqKindCmd('product')", sb);  ok(sb.state.rq.kind === 'product', "'product' is taken");
  vm.runInContext("rqKindCmd('material')", sb); ok(sb.state.rq.kind === 'material', "'material' is taken");
  vm.runInContext("rqKindCmd('nonsense')", sb); ok(sb.state.rq.kind === 'all', 'anything else falls back to All');
  ok(/r\.kind='all'/.test(sliceFn('rqReset')), 'a new request starts on All');
}

console.log('\n══ the labels are live pairs ══');
{
  const seg = sliceFn('rqKindSeg');
  for (const [en, zh] of [['All', '全部'], ['Products', '商品'], ['Materials', '物料']]) {
    const pair = `T('${en}','${zh}')`;
    ok(seg.includes(pair) && SRC.split(pair).length - 1 >= 2, `${pair} is used here and was already live elsewhere`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
