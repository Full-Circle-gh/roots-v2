#!/usr/bin/env node
/**
 * Ask for stock — current stock at the shops already chosen.
 *
 *   node scripts/test_ask_stock_shelf.js
 *
 * Ash, filling the list: the products were named and the shelves were not, so
 * the quantities had to be walked. Each chosen location's physical count now
 * sits under the SKU, destination first then the shop being asked.
 *
 * The functions are SLICED FROM public/m.html and run against stubs, the same
 * way test_ask_stock_kind_filter.js draws the picker. Nothing here is a copy
 * of the markup.
 *
 * Cases:
 *   1. the catalogue load is still names-only; the shelf is a second fetch
 *   2. that fetch is the same /stores/:id/stock Add stock already reads
 *   3. the map is physical_qty keyed by product_id (id as fallback)
 *   4. a row with no physical_qty is dropped, so add-mode never draws 0s
 *   5. Ask the kitchen, with the same picker, shows no counts
 *   6. a shop whose answer has not landed, failed, or came back empty is omitted
 *   7. destination first, then the shop being asked; a shop listed twice is once
 *   8. a product missing from a populated map reads 0, not a hole
 *   9. switching shops uses that shop's map; SKU stays on its own line
 *  10. the search keeps the numbers
 *  11. one fetch per shop per visit; a late answer is still stored
 *  12. a new visit re-reads; the maps survive so a restored dest can paint
 *  13. a draft does not keep the counts
 *  14. the label is Add stock's live pair, not a composed one
 *  15. shop name and count are one wrap unit, so Tianhe's number cannot sit alone
 *  16. the line sits under the whole row (after the steppers), not in the name column
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const nowrap = (s) => `<span style="white-space:nowrap">${s}</span>`;
const shelfLine = (label, ...pairs) => label + ' · ' + pairs.map(nowrap).join(' · ');

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

const STORES = [
  { id: 1, name_en: 'Tianhe', name_cn: '天河' },
  { id: 2, name_en: 'Yuexiu', name_cn: '越秀' },
];
const PRODUCTS = [
  { id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', material: false },
  { id: 8, name_en: 'Tzatziki',    name_cn: '酸奶酱',   sku: '1-20', material: false },
];

function sandbox(over) {
  const calls = { api: [], render: 0 };
  const pending = [];
  const sb = {
    state: {
      stack: [{ route: 'askstock' }],
      stores: STORES.slice(),
      rq: Object.assign({
        products: PRODUCTS.slice(), tried: true, fromShelf: false,
        q: '', qty: {}, kind: 'all', busy: false, err: '', sent: null,
        purpose: null, from: 1, to: 2, typing: {}, typeErr: {},
        shelf: {}, shelfTried: {},
      }, over),
    },
    LANG: 'en',
    T: (en, zh) => (sb.LANG === 'zh' ? (zh || en) : en),
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    searchBox: (input) => input,
    rqName: (p) => p.name_en || '',
    render: () => { calls.render++; },
    api: (path) => {
      calls.api.push(path);
      return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
    },
    console, Number, String, Array, Object, JSON, Math,
  };
  vm.createContext(sb);
  for (const n of ['rcvSkuKey', 'rcvSkuCmp', 'rqKindOf', 'rqLines', 'rqKindSeg', 'rqCountCell',
                   'rqShelfMap', 'rqShelfNote', 'rqStoreName', 'rqBodyHtml', 'rqPicker',
                   'rqChosen', 'rqUnits', 'loadRqShelf', 'rqReset', 'askDraftSnapshot']) {
    vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  }
  const run = (js) => vm.runInContext(js, sb);
  return { sb, run, calls, pending };
}

console.log('\n══ the catalogue stays names-only ══');
{
  const load = sliceFn('loadRqProducts');
  ok(/api\('\/products'\)/.test(load), 'the catalogue load is still /products');
  ok(!/physical_qty/.test(load) && !/\/stock/.test(load),
     'and it does not grow a per-shop count — that is a second fetch');
}

console.log('\n══ the shelf fetch ══');
{
  const load = sliceFn('loadRqShelf');
  ok(/api\('\/stores\/'\+id\+'\/stock'\)/.test(load),
     'the count is /stores/:id/stock, the same Add stock reads');
  ok(/r\.shelfTried\[id\]/.test(load) && /if\(r\.shelfTried\[id\]\) return/.test(load),
     'and a shop is asked once this visit');
  const screen = sliceFn('screenAskStock');
  ok(/loadRqShelf\(r\.to\)/.test(screen) && /loadRqShelf\(r\.from\)/.test(screen),
     'Ask for stock reads both shops that are already chosen');
  ok(/loadRqShelf\(state\.rq\.to\)/.test(SRC) && /loadRqShelf\(state\.rq\.from\)/.test(SRC),
     'and a chip tap reads the shop just chosen');
  ok(!/loadRqShelf/.test(sliceFn('screenAskKitchen')),
     'Ask the kitchen does not read a shop — it has none to pick');
}

console.log('\n══ the map ══');
{
  const { run } = sandbox({});
  const mapped = run(`rqShelfMap([
    {product_id:7, physical_qty:2},
    {product_id:8, physical_qty:0},
    {id:9, physical_qty:4},
    {product_id:10},
    {product_id:11, physical_qty:null}
  ])`);
  ok(mapped[7] === 2 && mapped[8] === 0 && mapped[9] === 4,
     'product_id wins; id is the fallback; 0 is a real count');
  ok(mapped[10] == null && mapped[11] == null,
     'a row with no physical_qty is dropped, so add-mode never draws 0s');
  ok(Object.keys(run('rqShelfMap(null)')).length === 0, 'garbage in is an empty map');
}

console.log('\n══ what the row draws ══');
{
  const { sb, run } = sandbox({
    shelf: { 2: { 7: 2, 8: 0 }, 1: { 7: 15, 8: 4 } },
  });
  const body = run('rqBodyHtml()');
  ok(body.includes(shelfLine('On the shelf', 'Yuexiu 2', 'Tianhe 15')),
     'Hummus Asli: destination first, then the shop being asked');
  ok(body.includes(shelfLine('On the shelf', 'Yuexiu 0', 'Tianhe 4')),
     'and a zero at the destination is drawn, not skipped');
  ok(body.indexOf('1-10') < body.indexOf(shelfLine('On the shelf', 'Yuexiu 2', 'Tianhe 15')),
     'the SKU stays on its own line above the counts');
  ok(body.indexOf('rqless-7') < body.indexOf(shelfLine('On the shelf', 'Yuexiu 2', 'Tianhe 15')),
     'the counts sit under the whole row, after the steppers — not in the squeezed name column');
  ok(/white-space:nowrap;margin-top:4px/.test(body),
     'and the line itself does not wrap');
  ok((body.match(/On the shelf/g) || []).length === 2, 'each row carries the label once');
  ok(body.includes(nowrap('Tianhe 15')) && !/Tianhe\s+15/.test(body.replace(/<span style="white-space:nowrap">Tianhe 15<\/span>/g, '')),
     'Tianhe and its number are one wrap unit, not a space the line can break on');
  sb.LANG = 'zh';
  ok(run('rqBodyHtml()').includes(shelfLine('在架', '越秀 2', '天河 15')),
     'Chinese uses the live 在架 and the shops\' own names');
}

console.log('\n══ when the counts stay off ══');
{
  const kitchen = sandbox({});
  kitchen.sb.state.stack = [{ route: 'askkitchen' }];
  kitchen.sb.state.rq.shelf = { 2: { 7: 2, 8: 0 } };
  ok(!/On the shelf/.test(kitchen.run('rqBodyHtml()')),
     'Ask the kitchen, with the same picker, shows no counts');

  const loading = sandbox({ shelf: {}, from: 1, to: 2 });
  ok(!/On the shelf/.test(loading.run('rqBodyHtml()')),
     'nothing drawn while both shops are still loading');

  const failed = sandbox({ shelf: { 2: null, 1: { 7: 15, 8: 4 } } });
  const failedBody = failed.run('rqBodyHtml()');
  ok(failedBody.includes(shelfLine('On the shelf', 'Tianhe 15')) && !/Yuexiu/.test(failedBody),
     'a shop that failed to read is omitted; the other still shows');

  const empty = sandbox({ shelf: { 2: {}, 1: { 7: 15, 8: 4 } } });
  ok(empty.run('rqBodyHtml()').includes(shelfLine('On the shelf', 'Tianhe 15')) &&
     !/Yuexiu/.test(empty.run('rqBodyHtml()')),
     'an empty map (add-mode, no quantities) is omitted rather than drawn as 0');

  const destOnly = sandbox({ from: null, to: 2, shelf: { 2: { 7: 2, 8: 0 } } });
  ok(destOnly.run('rqBodyHtml()').includes(shelfLine('On the shelf', 'Yuexiu 2')) &&
     !/Tianhe/.test(destOnly.run('rqBodyHtml()')),
     'destination alone, before a source is picked, still shows that shop');
}

console.log('\n══ switching shops ══');
{
  const { sb, run } = sandbox({
    to: 1, from: 2,
    shelf: { 1: { 7: 12, 8: 3 }, 2: { 7: 2, 8: 0 } },
  });
  ok(run('rqBodyHtml()').includes(shelfLine('On the shelf', 'Tianhe 12', 'Yuexiu 2')),
     'the order follows the chips, not the store ids');
  sb.state.rq.to = 2; sb.state.rq.from = 1;
  ok(run('rqBodyHtml()').includes(shelfLine('On the shelf', 'Yuexiu 2', 'Tianhe 12')),
     'and flipping the chips flips the numbers');
  sb.state.rq.from = 2;
  const same = run('rqBodyHtml()');
  ok(same.includes(shelfLine('On the shelf', 'Yuexiu 2')) && !/Tianhe/.test(same) &&
     (same.match(/On the shelf · <span style="white-space:nowrap">Yuexiu /g) || []).length === 2,
     'asking the same shop as the destination names it once per row');
}

console.log('\n══ a missing product on a populated shelf is 0 ══');
{
  const { run } = sandbox({ shelf: { 2: { 8: 4 }, 1: { 7: 15, 8: 4 } } });
  const body = run('rqBodyHtml()');
  ok(body.includes(shelfLine('On the shelf', 'Yuexiu 0', 'Tianhe 15')),
     'Hummus Asli, absent from Yuexiu\'s map, reads 0 — the LEFT JOIN\'s own answer');
}

console.log('\n══ the search keeps the numbers ══');
{
  const { sb, run } = sandbox({
    q: 'hummus',
    shelf: { 2: { 7: 2, 8: 0 }, 1: { 7: 15, 8: 4 } },
  });
  const body = run('rqBodyHtml()');
  ok(/Hummus Asli/.test(body) && !/Tzatziki/.test(body), 'the query still filters the list');
  ok(body.includes(shelfLine('On the shelf', 'Yuexiu 2', 'Tianhe 15')), 'and the remaining row still has its counts');
  sb.state.rq.q = 'zzz';
  ok(/No products match/.test(run('rqBodyHtml()')), 'no-match is still the empty list');
}

function tick(){ return new Promise((resolve) => setImmediate(resolve)); }

async function asyncCases() {
  console.log('\n══ one fetch per shop per visit ══');
  {
    const { run, calls, pending } = sandbox({ shelf: {}, shelfTried: {}, from: null, to: 2 });
    run('loadRqShelf(2)');
    run('loadRqShelf(2)');
    ok(calls.api.length === 1 && calls.api[0] === '/stores/2/stock',
       'a second ask for the same shop this visit is a no-op');
    run('loadRqShelf(1)');
    ok(calls.api[1] === '/stores/1/stock', 'a different shop is asked');
    pending[0].resolve([{ product_id: 7, physical_qty: 2 }, { product_id: 8, physical_qty: 0 }]);
    await tick();
    ok(run('state.rq.shelf[2][7]') === 2, 'the answer lands under that shop');
    run('loadRqShelf(0)');
    run('loadRqShelf(null)');
    ok(calls.api.length === 2, 'a missing shop id is not fetched');
  }

  console.log('\n══ a late answer is still stored ══');
  {
    const late = sandbox({ shelf: {}, shelfTried: {}, from: null, to: 2 });
    late.run('loadRqShelf(1)');
    late.sb.state.rq.from = null;
    late.pending[0].resolve([{ product_id: 7, physical_qty: 15 }]);
    await tick();
    ok(late.run('state.rq.shelf[1][7]') === 15,
       'a shop they switched away from still keeps its map');
    ok(late.calls.render === 0, 'and does not repaint until they pick it again');
  }

  console.log('\n══ a new visit re-reads; the maps survive ══');
  {
    const { sb, run } = sandbox({
      to: 2, from: 1,
      shelf: { 2: { 7: 2 }, 1: { 7: 15 } },
      shelfTried: { 2: true, 1: true },
      qty: { 7: 3 },
    });
    run('rqReset()');
    ok(Object.keys(sb.state.rq.shelfTried).length === 0, 'tried is this visit');
    ok(sb.state.rq.shelf[2][7] === 2 && sb.state.rq.shelf[1][7] === 15,
       'the maps stay, so a restored dest can paint last-known');
    ok(Object.keys(sb.state.rq.qty).length === 0, 'the basket still clears');
  }

  console.log('\n══ a draft does not keep the counts ══');
  {
    const { run } = sandbox({
      to: 2, from: 1, qty: { 7: 3 },
      shelf: { 2: { 7: 2 }, 1: { 7: 15 } },
    });
    const snap = run(`askDraftSnapshot('askstock')`);
    ok(snap && snap.qty[7] === 3 && snap.to === 2 && snap.from === 1, 'the request is kept');
    ok(!('shelf' in snap) && !('shelfTried' in snap), 'the counts are not — they are re-read');
  }

  console.log('\n══ the label is a live pair ══');
  {
    const note = sliceFn('rqShelfNote');
    const pair = "T('On the shelf','在架')";
    ok(note.includes(pair), 'On the shelf · 在架 is used on the row');
    ok(sliceFn('qsMeta').includes(pair), 'and was already live on Add stock');
    ok(!/on hand/.test(note) && !/库存 /.test(note),
       'waste\'s on-hand pair is not reused here — that screen writes off, this one asks');
    ok(note.includes('white-space:nowrap'),
       'shop name and count cannot wrap apart — Ash, live: Tianhe\'s number jumped');
    ok(/display:block;font-size:12\.5px;color:var\(--text-secondary\);white-space:nowrap/.test(note),
       'the whole line is nowrap — sitting under the row, not beside the steppers');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

asyncCases().catch((e) => { console.error(e); process.exit(1); });

