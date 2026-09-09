#!/usr/bin/env node
//
// test_material_subcategory_by_kind.js — the subcategory picker on Materials
// follows the kind above it (public/retail-admin/18-materials.js, and the
// meta/categories endpoint in routes/retail-materials.js that feeds it).
//
// THE DEFECT THIS COVERS. A material is filed twice: item_kind is the KIND
// (类别 — food, packaging, supplies) and `category` is the SUBCATEGORY under
// it (分类). lib/sku-rules.js has always numbered by that exact pair. But the
// subcategory picker offered the WHOLE catalogue-wide list whatever kind was
// chosen: pick 食品 on a new material and the list still ran from "Cosmetics
// & Beauty 化妆护肤" past "Office supplies 办公用品" to "Pest Control
// 除虫防虫" — forty-odd names, most of them impossible for the kind above
// them, and nothing stopping food being filed under a cleaning subcategory.
// The list screen's own category dropdown had it too: pick the 食品 chip and
// the dropdown still offered every subcategory, including ones that filter
// the list to zero rows.
//
// Nothing in the schema records which kind a subcategory belongs to, so the
// pairing is read off the catalogue — a subcategory belongs to whatever kinds
// materials are actually filed under it with — and rides on the meta response
// as `byKind`.
//
// THE THREE THINGS THAT MUST NOT REGRESS, all of them reachability:
//   • A RECORD'S OWN SUBCATEGORY IS ALWAYS OFFERED, even when its kind no
//     longer uses it. A <select> that does not contain its own value reads
//     back as the first option, so the next save would silently rewrite a
//     real filing to blank. Section 3.
//   • A KIND WITH NOTHING FILED UNDER IT YET falls back to the whole list —
//     otherwise a kind added in Settings this morning has an empty picker and
//     no way to file its first material. Section 4.
//   • AN OLD SERVER RESPONSE (no byKind at all) still offers everything
//     rather than nothing. Section 6.
//
// Every check reads the HTML back out of the DOM stub, the way
// test_material_supplier_picker.js does — nothing here asserts against what
// we meant to render.
//
// USAGE   node scripts/test_material_subcategory_by_kind.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── DOM stub ──────────────────────────────────────────────────────────────
// getElementById hands back a node for any id — the module paints a shell and
// then looks the ids inside it back up. querySelector answers from the node's
// own HTML, which is what makes paintList's "is the shell still up?" check a
// real question and so lets the filter bar be repainted once and only once.
//
// PAINTED VALUES LAND ON THE NODES, which the flatter stubs elsewhere in
// scripts/ do not do — an <input value="E-55"> leaves the node's .value at ''
// there. It matters here for two reasons. The honest one: this suite reads
// what a <select> is SET to after a repaint, and a stub that drops the
// `selected` option cannot answer that. The sharp one: an existing material
// whose SKU field reads back blank sends matSkuPreview() and matSkuTyped()
// into each other without end (18-materials.js — preview hands an existing
// record to Typed, Typed hands a blank field back to preview). That is a live
// defect, not this suite's business, but a stub that fakes a blank SKU on a
// record that has one would hit it here for the wrong reason.
const VALUED_TAG = /<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g;
const VALUE_ATTR = /\bvalue="([^"]*)"/;
const unesc = t => String(t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function applyPaintedValues(html) {
  VALUED_TAG.lastIndex = 0;
  let m;
  while ((m = VALUED_TAG.exec(html)) !== null) {
    const [tag, kind, id] = [m[0], m[1], m[2]];
    if (kind === 'select') {
      // A <select>'s value is its selected option — or its first, the way a
      // browser falls back when nothing is marked.
      const end = html.indexOf('</select>', m.index);
      const block = html.slice(m.index, end < 0 ? html.length : end);
      const picked = /<option value="([^"]*)" selected>/.exec(block) || /<option value="([^"]*)"/.exec(block);
      node(id).value = picked ? unesc(picked[1]) : '';
    } else {
      const v = VALUE_ATTR.exec(tag);
      node(id).value = v ? unesc(v[1]) : '';
    }
  }
}

const nodes = new Map();
function makeNode(id) {
  return {
    id, _html: '', textContent: '', value: '', style: {}, hidden: false, children: [],
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); applyPaintedValues(this._html); },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    insertAdjacentHTML(_pos, html) { this.innerHTML = this._html + html; },
    appendChild(child) { if (child && child.id) nodes.set(child.id, child); this.children.push(child); return child; },
    closest: () => null,
    querySelector(sel) {
      const id = String(sel || '').replace(/^#/, '');
      return this.innerHTML.includes(`id="${id}"`) ? node(id) : null;
    },
    querySelectorAll: () => [],
  };
}
function node(id) {
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
}
const document = {
  getElementById: id => node(id),
  createElement: () => makeNode(''),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeNode('body'),
};

// ── the catalogue, faked ──────────────────────────────────────────────────
// Three kinds. Two carry materials and so have subcategories of their own;
// `packaging` carries nothing, which is the kind-added-this-morning case.
const FOOD_CATS = ['Fresh Produce 新鲜蔬果', 'Nuts & Seeds 坚果与种子', 'Spices, Herbs & Salt 香草和盐'];
const SUPPLY_CATS = ['Office supplies 办公用品', 'Pest Control 除虫防虫'];
const ALL_CATS = ['Cutlery 餐具'].concat(FOOD_CATS, SUPPLY_CATS).sort();
const BY_KIND = { food: FOOD_CATS, supplies: SUPPLY_CATS };

// 55 is filed where its kind says it should be. 56 is the drift case: a food
// material sitting under a subcategory only the supplies kind uses.
const MATERIALS = {
  55: {
    id: 55, name_en: 'Kosher Flake Sea Salt', name_cn: '海盐', sku: 'E-55',
    category: 'Spices, Herbs & Salt 香草和盐', unit: 'g', buy_unit: 'bag', buy_pack_size: 1,
    buy_price: 30, cost_per_unit: 0.066, free_by_design: 0, supplier: '', allergens: '',
    notes: '', accounting_category: '', item_kind: 'food', is_active: 1,
  },
  56: {
    id: 56, name_en: 'Wooden Fork', name_cn: '木叉', sku: 'E-56',
    category: 'Cutlery 餐具', unit: 'pcs', buy_unit: 'box', buy_pack_size: 100,
    buy_price: 20, cost_per_unit: 0.2, free_by_design: 0, supplier: '', allergens: '',
    notes: '', accounting_category: '', item_kind: 'food', is_active: 1,
  },
};

let sendByKind = true;    // section 6 turns this off to replay an old server
async function api(p) {
  const q = p.split('?')[0];
  if (q === '/api/retail-admin/materials/meta/kinds') return { success: true, data: ['food', 'supplies', 'packaging'] };
  if (q === '/api/retail-admin/materials/meta/categories') {
    return sendByKind
      ? { success: true, data: ALL_CATS, byKind: BY_KIND }
      : { success: true, data: ALL_CATS };
  }
  if (q === '/api/retail-admin/materials/meta/accounting-categories') return { success: true, data: [] };
  if (q === '/api/retail-admin/suppliers') return { success: true, data: [] };
  if (q === '/api/retail-admin/materials') {
    return { success: true, data: Object.values(MATERIALS), counts: { food: 2 }, sourceCounts: { bought: 2, made: 0 } };
  }
  const m = q.match(/^\/api\/retail-admin\/materials\/(\d+)$/);
  if (m) return { success: true, data: MATERIALS[m[1]], priceHistory: [], purchases: [], derived: {} };
  return { success: true, data: [] };
}

const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  isFinite, String, Number, URLSearchParams, RegExp,
  api, toast: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  innerHeight: 900, innerWidth: 1200,
  history: { pushState() {}, back() {} },
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,                       // the suite reads the English side
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  applyCapGates: () => {},
  goTab: () => {},
  askConfirm: async () => true,
  askPrompt: async () => null,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '18-materials.js'), 'utf8'),
                sandbox, { filename: '18-materials.js' });

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

// The <option> values inside one <select>, in order, blank included.
function optionsOf(html, id) {
  const open = html.indexOf(`id="${id}"`);
  if (open < 0) return null;
  const end = html.indexOf('</select>', open);
  const block = html.slice(open, end < 0 ? html.length : end);
  const out = [];
  const RE = /<option value="([^"]*)"/g;
  let m;
  while ((m = RE.exec(block)) !== null) {
    out.push(m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
  }
  return out;
}
const selectedIn = (html, id) => {
  const open = html.indexOf(`id="${id}"`);
  const end = html.indexOf('</select>', open);
  const m = /<option value="([^"]*)" selected>/.exec(html.slice(open, end));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'") : null;
};
const recordCats = () => optionsOf(node('mat-rec-body').innerHTML, 'mat-f-category');

// The filter bar is painted into #mat-root once and then only its controls are
// rewritten in place, so the current options live on #mat-cat itself as soon as
// anything has re-cut them, and in the shell's markup before that.
function filterCats() {
  const own = node('mat-cat').innerHTML;
  const html = own ? `<select id="mat-cat">${own}</select>` : node('mat-root').innerHTML;
  return optionsOf(html, 'mat-cat');
}

// Picking in a <select> is: the value changes, then the onchange handler runs.
const pickKind = (k) => { node('mat-f-item_kind').value = k; sandbox.matKindChanged(); };

// matSetKind/matSetCat fire the reload without handing back its promise, so
// awaiting the call itself proves nothing — this waits for the repaint that
// follows. Reading the dropdown a microtask too early returns the list as it
// was, which is exactly the shape of the bug under test and would pass by
// accident in the other direction.
const settle = () => new Promise(r => setTimeout(r, 0));

async function main() {
  await sandbox.matInit();

  console.log('\n1. a new food material is offered food subcategories, and only those');
  sandbox.matRecordNew();
  let cats = recordCats();
  ok(cats !== null, 'the record paints a subcategory picker');
  ok(FOOD_CATS.every(c => cats.includes(c)), 'every food subcategory is on offer');
  ok(!cats.includes('Office supplies 办公用品') && !cats.includes('Pest Control 除虫防虫'),
     'the supplies subcategories are not — this is the reported defect');
  ok(!cats.includes('Cutlery 餐具'), 'nor a subcategory no food material uses');
  ok(cats[0] === '', 'None still leads the list, so clearing a subcategory stays one pick');

  console.log('\n2. changing the kind re-cuts the list, and drops what no longer fits');
  node('mat-f-category').value = 'Fresh Produce 新鲜蔬果';
  pickKind('supplies');
  cats = recordCats();
  ok(SUPPLY_CATS.every(c => cats.includes(c)), 'the supplies subcategories are on offer now');
  ok(!cats.includes('Fresh Produce 新鲜蔬果'), 'and the food ones are gone');
  ok(selectedIn(node('mat-rec-body').innerHTML, 'mat-f-category') === '',
     'the food subcategory that was chosen falls back to None, not carried into supplies');
  ok(node('mat-f-category').value === '',
     'and the field itself reads back blank, so a save cannot file food under supplies');

  console.log('\n3. a record keeps its OWN subcategory even when its kind no longer uses it');
  await sandbox.matRecordOpen(56);            // food, filed under a supplies subcategory
  cats = recordCats();
  ok(cats.includes('Cutlery 餐具'), 'the stored subcategory is offered though its kind does not use it');
  ok(selectedIn(node('mat-rec-body').innerHTML, 'mat-f-category') === 'Cutlery 餐具',
     'and it is the selected one — a save cannot silently blank a real filing');
  ok(FOOD_CATS.every(c => cats.includes(c)), 'the kind\'s own subcategories are offered alongside it');
  ok(!cats.includes('Office supplies 办公用品'), 'the rest of the catalogue still is not');

  console.log('\n4. a kind with nothing filed under it yet falls back to the whole list');
  await sandbox.matRecordOpen(55);
  pickKind('packaging');
  cats = recordCats();
  ok(ALL_CATS.every(c => cats.includes(c)),
     'every subcategory is offered — an empty picker would leave no way to file the first one');

  console.log('\n5. the list screen\'s own dropdown narrows with the kind chips');
  ok(filterCats().length === ALL_CATS.length + 1,
     'with no kind chosen it offers every subcategory, All categories included');
  sandbox.matSetCat('Office supplies 办公用品');
  await settle();
  sandbox.matSetKind('food');
  await settle();
  const narrowed = filterCats();
  ok(FOOD_CATS.every(c => narrowed.includes(c)),
     'picking the food chip narrows the dropdown to food subcategories');
  ok(!narrowed.includes('Pest Control 除虫防虫') && !narrowed.includes('Office supplies 办公用品'),
     'the supplies ones are gone with it');
  ok(node('mat-cat').value === '',
     'and the supplies subcategory that had been chosen is dropped, not left filtering to zero rows');
  sandbox.matSetKind('');
  await settle();
  ok(filterCats().length === ALL_CATS.length + 1, 'the All chip puts the whole list back');

  console.log('\n6. an old server response — no byKind — still offers everything');
  sendByKind = false;
  const fresh = vm.createContext({ ...sandbox });
  fresh.window = fresh;
  nodes.clear();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '18-materials.js'), 'utf8'),
                  fresh, { filename: '18-materials.js' });
  await fresh.matInit();
  fresh.matRecordNew();
  const legacy = recordCats();
  ok(legacy && ALL_CATS.every(c => legacy.includes(c)),
     'without the pairing the picker offers the whole list, exactly as it did before');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
