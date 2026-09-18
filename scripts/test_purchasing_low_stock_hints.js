#!/usr/bin/env node
// "Running low here" becomes a tenant switch (§178).
//
// The strip at the top of a purchase order suggests the products that store is
// shortest of. For a tenant that MAKES what it sells, that list fills with
// finished goods no supplier sells — so it is now a per-tenant on/off, ON by
// default, flipped in Settings → Operations like Production and Waste.
//
// Three halves, because the switch is three files:
//   • the WIRING half reads the catalog (02-settings-ops.js), the switch's home
//     (05-marketing.js) and the markup (retail-admin.html), because a feature
//     whose key, home and host div do not agree mounts no switch at all — which
//     is exactly the state `waste` is in on this same list, unnoticed.
//   • the BEHAVIOUR half runs 16-purchasing.js in a `vm` (the harness
//     test_purchasing_kitchen_dot.js uses) and opens a real draft order through
//     puNewOrder → puWizStep(2), so the strip is painted by the code path that
//     paints it in the product, not by a seam added for the test.
//   • the COPY half pins both sentences that POINT AT the strip. An empty state
//     that says "pick a suggestion above" when there is no suggestion above
//     sends the operator looking for a control that isn't there.
//
// Run:  node scripts/test_purchasing_low_stock_hints.js
//
// Cases:
//   1. the switch is wired end to end: catalog key, home, host div, defaults on
//   2. off, cache cold → the stock read is never made
//   3. on → the strip paints, in both languages, with an Add button
//   4. switched off with the strip on screen → it is cleared, not stranded
//   5. off → neither empty-state sentence promises a suggestion
//   6. the strip's own title is the switch's Chinese name, character for char

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { tdWhen, tdToday } = require('../public/td-datetime.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── 1 · the wiring ────────────────────────────────────────────────────────
console.log('\n══ 1 · the switch is wired end to end ══');
const settingsSrc  = read('public', 'retail-admin', '02-settings-ops.js');
const marketingSrc = read('public', 'retail-admin', '05-marketing.js');
const html         = read('public', 'retail-admin.html');
const purchSrc     = read('public', 'retail-admin', '16-purchasing.js');

const entry = (() => {
  const i = settingsSrc.indexOf("{ key: 'lowStockHints'");
  return i < 0 ? '' : settingsSrc.slice(i, settingsSrc.indexOf('\n];', i));
})();
ok(entry.length > 0, 'FEATURE_CATALOG carries a lowStockHints entry');
ok(/def:\s*true/.test(entry), 'and it defaults ON — nobody loses the strip by upgrading');
ok(/cn:\s*'此门店库存偏低'/.test(entry), 'and its Chinese name is the strip\'s own kicker');
// descOn/descOff are what syncFeatureToggles swaps in; without both, the bar
// shows a static sentence that reads the same whichever way the switch is set.
ok(/descOn:/.test(entry) && /descOff:/.test(entry), 'with a sentence for each state, not one for both');

ok(/lowStockHints:\s*'#lowstock-settings-home'/.test(marketingSrc),
   'FEATURE_HOMES points the switch at a host');
ok(html.includes('id="lowstock-settings-home"'),
   'and that host exists in the markup — no host, no switch (see `waste`)');
// The host must NOT carry data-feat: there is nothing under the bar to hide,
// and a data-feat host with no CSS rule behind it is a gate that does nothing.
const hostTag = (() => {
  const i = html.indexOf('id="lowstock-settings-home"');
  return i < 0 ? '' : html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1);
})();
ok(!/data-feat=/.test(hostTag), 'the host carries no data-feat — the bar is all there is to show');

// ── the DOM stub ──────────────────────────────────────────────────────────
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    let inner = '';
    const n = {
      id, style: {}, value: '', className: '', textContent: '',
      classList: {
        _on: new Set(),
        add(c) { this._on.add(c); }, remove(c) { this._on.delete(c); },
        toggle(c, on) { if (on === undefined) on = !this._on.has(c); if (on) this._on.add(c); else this._on.delete(c); },
        contains(c) { return this._on.has(c); },
      },
      appendChild() {}, querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, closest: () => null, focus() {}, remove() {},
    };
    Object.defineProperty(n, 'innerHTML', { get: () => inner, set: v => { inner = v; } });
    nodes.set(id, n);
  }
  return nodes.get(id);
}
const document = {
  hidden: false,
  getElementById: node,
  createElement: () => node('scratch'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: node('body'),
};
document.body.classList.add('feat-production');
document.body.classList.add('feat-lowStockHints');

// ── the server, faked ─────────────────────────────────────────────────────
// Two products, both under their buffer, so the strip has something to say.
const STOCK = [
  { product_id: 11, store_product_id: 11, name_en: 'Carrot-Ginger Juice', name_cn: '胡萝卜生姜汁',
    sku: 'J-01', physical_qty: 0, safety_buffer: 6, cost_per_unit: 3 },
  { product_id: 12, store_product_id: 12, name_en: 'Fire Spice Cake', name_cn: '火辣香料蛋糕',
    sku: 'C-02', physical_qty: 1, safety_buffer: 4, cost_per_unit: 5 },
];
let stockCalls = 0;
async function api(p) {
  if (/\/stores\/\d+\/stock$/.test(p)) { stockCalls++; return { success: true, data: STOCK }; }
  if (p === '/api/retail-admin/stores') {
    return { success: true, data: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', code: 'TH', is_active: 1 }] };
  }
  return { success: true, data: [] };
}

// The language switch. cuT is what the module's own T() delegates to, so
// flipping this flips every string the screen paints.
let LANG = 'en';
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object, Number, String,
  api, toast: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: (en, cn) => (LANG === 'cn' && cn ? cn : en),
  tdWhen, tdToday,
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  acCurrencySymbol: () => '¥',
  applyCapGates: () => {},
  can: () => true,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(purchSrc, sandbox, { filename: '16-purchasing.js' });

const strip = () => node('pu2-suggest').innerHTML;
const lines = () => node('pu2-linebody').innerHTML;
// renderSuggestions awaits the stock read before it paints; two turns of the
// microtask queue is enough for a resolved promise chain and never waits on a
// clock.
const settle = async () => { await null; await null; await null; };

async function openDraft() {
  await sandbox.puInit();
  sandbox.puNewOrder();
  sandbox.puWizStep(2);
  await settle();
}

async function main() {
  // FIRST, with the cache cold. products() memoises per store, so a draft
  // opened after any successful read would find the list already in hand and
  // this count would hold still whether or not the gate exists. Asked here,
  // before anything has read stock, it is a real question.
  console.log('\n══ 2 · off → the stock read is not even made ══');
  document.body.classList.remove('feat-lowStockHints');
  await openDraft();
  ok(stockCalls === 0, 'a draft opened with the feature off asks the server for nothing');
  ok(strip() === '', 'and paints no strip');
  document.body.classList.add('feat-lowStockHints');

  console.log('\n══ 3 · on → the strip paints ══');
  await openDraft();
  ok(strip().includes('Running low here'), 'the kicker is there');
  ok(strip().includes('Carrot-Ginger Juice'), 'with the product that is short');
  ok(/onclick="puPick\(11\)"/.test(strip()), 'and an Add button that adds it to the order');

  LANG = 'cn';
  await openDraft();
  ok(strip().includes('此门店库存偏低'), 'and in Chinese it carries the Chinese kicker');
  LANG = 'en';

  console.log('\n══ 4 · switched off with the strip already on screen ══');
  await openDraft();
  ok(strip().length > 0, 'the strip has content to lose');
  document.body.classList.remove('feat-lowStockHints');
  await openDraft();
  ok(strip() === '', 'the strip is cleared, not stranded on its last paint');

  console.log('\n══ 5 · off → no sentence points at a suggestion that is gone ══');
  ok(!/suggestion/i.test(lines()), 'the empty line message drops the "pick a suggestion" clause');
  ok(/search above/i.test(lines()), 'and says what to do instead');
  LANG = 'cn';
  await openDraft();
  ok(!lines().includes('选择推荐'), 'the Chinese drops it too');
  ok(lines().includes('在上方搜索'), 'and keeps the half that is still true');
  LANG = 'en';
  // The onboarding card a tenant with no orders sees says the same thing.
  const emptyStateSrc = purchSrc.slice(purchSrc.indexOf('function emptyState()'),
                                       purchSrc.indexOf('window.puSeg'));
  ok(/lowStockHintsOn\(\)/.test(emptyStateSrc),
     'and the "1 · Build it" card asks the same question before promising suggestions');

  document.body.classList.add('feat-lowStockHints');
  await openDraft();
  ok(/suggestion/i.test(lines()), 'back on, the empty line message offers the strip again');

  console.log('\n══ 6 · one name, two places ══');
  // The switch is titled after the strip deliberately: an operator turning it
  // off should not have to work out which block on the order it means. If the
  // strip is ever re-worded, this fails and the switch gets re-worded with it.
  ok(purchSrc.includes("T('Running low here', '此门店库存偏低')"),
     'the strip still says what the switch says it does');

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
