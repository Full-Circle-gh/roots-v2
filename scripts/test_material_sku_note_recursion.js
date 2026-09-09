#!/usr/bin/env node
//
// test_material_sku_note_recursion.js — the SKU note on a material record
// (public/retail-admin/18-materials.js: matSkuPreview / matSkuTyped).
//
// THE DEFECT THIS COVERS. The two functions that paint the SKU note call each
// other, and on an EXISTING material with a BLANK SKU field neither had an
// exit:
//
//   matSkuPreview()  an existing record has nothing to suggest  -> matSkuTyped()
//   matSkuTyped()    a blank field means "back to the suggestion" -> matSkuPreview()
//
// Both branches sit above their function's first await, so the two called each
// other SYNCHRONOUSLY until the stack ran out — measured at ~12,500 frames on
// the stub below, against 13 lookups once fixed. It ended in a RangeError that
// paintRecord()'s own `try { matSkuPreview(); } catch (_) {}` cannot catch: an
// async function reports a throw as a REJECTED PROMISE rather than throwing,
// so the guard there never sees it and the rejection goes unhandled.
//
// It was not an edit-time defect. paintRecord() calls the preview at the end
// of EVERY paint, so opening such a material was enough; changing its kind or
// category, or tabbing out of its name, each did it again.
//
// A material with no code is ordinary, not a corruption: `ingredients.sku` is
// nullable (schema.sql), and numbering only ever runs on CREATE (the comment
// on the create route says so in as many words — "Existing materials are never
// renumbered"), so anything saved before automatic SKUs existed still has one.
//
// WHAT THE FIX MUST NOT COST. The suggestion itself is the feature this note
// exists for, and it is easy to kill while stopping the loop. Sections 3 and 4
// are that guard: a NEW material with an empty field still gets its peeked
// code, and a typed code that does not fit the rule is still flagged.
//
// Section 2 is the one that would have caught the defect: it walks all four
// combinations of (new | existing) x (blank | typed) and requires every one to
// settle, rather than only the case that was reported.
//
// USAGE   node scripts/test_material_sku_note_recursion.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── DOM stub ──────────────────────────────────────────────────────────────
// Painted `value="…"` attributes land on the nodes, and a <select> takes its
// selected option — without that an existing material's SKU field reads back
// blank on every stub in scripts/, which fakes the very state under test.
// Every getElementById is counted: runaway recursion shows up as a call count,
// which is a far steadier signal than a stack depth or a stopwatch.
let lookups = 0;
const nodes = new Map();
function makeNode(id) {
  return {
    id, _html: '', textContent: '', value: '', placeholder: '', className: '',
    style: {}, hidden: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      const RE = /<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g;
      let m;
      while ((m = RE.exec(this._html)) !== null) {
        if (m[1] === 'select') {
          const end = this._html.indexOf('</select>', m.index);
          const block = this._html.slice(m.index, end < 0 ? undefined : end);
          const picked = /<option value="([^"]*)" selected>/.exec(block) || /<option value="([^"]*)"/.exec(block);
          node(m[2]).value = picked ? picked[1] : '';
        } else {
          const v2 = /\bvalue="([^"]*)"/.exec(m[0]);
          node(m[2]).value = v2 ? v2[1] : '';
        }
      }
    },
    insertAdjacentHTML(_p, h) { this.innerHTML = this._html + h; },
    appendChild(c) { if (c && c.id) nodes.set(c.id, c); this.children.push(c); return c; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}
function node(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); }

// ── the catalogue, faked ──────────────────────────────────────────────────
// 77 is the case under test: it EXISTS and has no code.
// 78 exists and has one, which is the ordinary existing material.
const BLANK_SKU = {
  id: 77, name_en: 'Legacy Oat Groats', name_cn: '燕麦粒', sku: null,
  category: 'Nuts & Seeds 坚果与种子', unit: 'g', buy_unit: 'bag', buy_pack_size: 1,
  buy_price: 10, cost_per_unit: 0.01, free_by_design: 0, supplier: '', allergens: '',
  notes: '', accounting_category: '', item_kind: 'food', is_active: 1,
};
const CODED = Object.assign({}, BLANK_SKU, { id: 78, name_en: 'Sea Salt', sku: 'E-55' });

// The rule the server would issue against. match_re is what flags a typed code.
const RULE = { ok: true, sku: 'N-0007', match_re: '^N-\\d{4}$' };
let ruleAnswer = () => RULE;
let skuAsks = 0;

async function api(p) {
  const q = p.split('?')[0];
  if (q === '/api/retail-admin/materials/meta/kinds') return { success: true, data: ['food'] };
  if (q === '/api/retail-admin/materials/meta/categories') {
    return { success: true, data: [BLANK_SKU.category], byKind: { food: [BLANK_SKU.category] } };
  }
  if (q === '/api/retail-admin/materials/meta/accounting-categories') return { success: true, data: [] };
  if (q === '/api/retail-admin/suppliers') return { success: true, data: [] };
  if (q === '/api/retail-admin/sku/material/next') { skuAsks++; return ruleAnswer(); }
  if (q === '/api/retail-admin/materials') {
    return { success: true, data: [BLANK_SKU, CODED], counts: { food: 2 }, sourceCounts: { bought: 2, made: 0 } };
  }
  if (q === '/api/retail-admin/materials/77') return { success: true, data: BLANK_SKU, priceHistory: [], purchases: [], derived: {} };
  if (q === '/api/retail-admin/materials/78') return { success: true, data: CODED, priceHistory: [], purchases: [], derived: {} };
  return { success: true, data: [] };
}

const sandbox = {
  document: {
    getElementById: id => { lookups++; return node(id); },
    createElement: () => makeNode(''), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: makeNode('body'),
  },
  console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  isFinite, String, Number, URLSearchParams, RegExp,
  api, toast: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  innerHeight: 900, innerWidth: 1200, history: { pushState() {}, back() {} },
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en, fmt: n => String(n), acMoney: n => '¥' + n,
  applyCapGates: () => {}, goTab: () => {}, askConfirm: async () => true, askPrompt: async () => null,
};
sandbox.window = sandbox;

// WHY THE DETECTOR IS A CALL COUNT AND NOT THE REJECTION.
//
// The obvious probe is process.on('unhandledRejection') — the defect ends in a
// RangeError inside an async function, which becomes a rejection nobody
// handles. It does not work, and the reason is worth keeping: by the time the
// rejection is raised the stack is already exhausted, so Node cannot run its
// own rejection callback either. V8 prints "Exception in PromiseRejectCallback"
// to stderr and the listener below is never reached. Verified against the
// unfixed file: this hook stayed null while the suite's call-count assertions
// went red.
//
// So the hook is kept — it costs nothing and would catch a DIFFERENT rejection,
// one raised with stack to spare — but the assertions that actually hold the
// line are the lookup budgets.
let unhandled = null;
process.on('unhandledRejection', e => { unhandled = e; });

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '18-materials.js'), 'utf8'),
                sandbox, { filename: '18-materials.js' });

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const settle = () => new Promise(r => setTimeout(r, 0));
const noteEl = () => node('mat-sku-note');
const skuField = () => node('mat-f-sku');

// Run `fn`, then report what it cost and whether it blew up. A settled call
// touches the DOM a few dozen times; the defect touched it ~12,500 times.
const BUDGET = 400;
async function measure(fn) {
  unhandled = null;
  lookups = 0;
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  await settle();
  return { lookups, threw, unhandled };
}

async function main() {
  await sandbox.matInit();

  console.log('\n1. opening an existing material that has no code — the reported defect');
  let r = await measure(() => sandbox.matRecordOpen(77));
  ok(!r.threw && !r.unhandled, 'nothing threw or rejected out of the open');
  ok(r.lookups < BUDGET, `the paint settles (${r.lookups} DOM lookups, budget ${BUDGET}) — it used to run to ~12,500 and overflow`);
  ok(noteEl().textContent === '', 'an existing material is told nothing about its code, which is what the design asks for');

  console.log('\n2. every combination of (new | existing) x (blank | typed) settles');
  // existing + blank, driven directly rather than through a paint
  r = await measure(async () => { skuField().value = ''; sandbox.matSkuTyped(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'existing + blank field settles');
  r = await measure(async () => { skuField().value = ''; await sandbox.matSkuPreview(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'existing + blank field settles from the preview side too');
  // existing + typed
  r = await measure(async () => { skuField().value = 'ANYTHING-1'; sandbox.matSkuTyped(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'existing + typed code settles');
  r = await measure(async () => { skuField().value = 'ANYTHING-1'; await sandbox.matSkuPreview(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'existing + typed code settles from the preview side too');
  // new + blank / new + typed
  sandbox.matRecordNew();
  await settle();
  r = await measure(async () => { skuField().value = ''; sandbox.matSkuTyped(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'new + blank field settles');
  r = await measure(async () => { skuField().value = 'N-0007'; await sandbox.matSkuPreview(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'new + typed code settles');

  console.log('\n3. the suggestion still works — a new material is offered a code');
  sandbox.matRecordNew();
  await settle();
  skuField().value = '';
  skuAsks = 0;
  await sandbox.matSkuPreview();
  await settle();
  ok(skuAsks === 1, 'the server is asked for the code its rules would issue');
  ok(skuField().placeholder === 'N-0007', 'and it is offered as the field\'s placeholder');
  ok(noteEl().textContent.includes('N-0007'), 'the note spells it out underneath');

  console.log('\n4. and a typed code that does not fit the rule is still flagged');
  skuField().value = 'N-0007';
  sandbox.matSkuTyped();
  ok(/Matches/.test(noteEl().textContent), 'a code that fits the pattern is confirmed');
  skuField().value = 'WHATEVER';
  sandbox.matSkuTyped();
  ok(/Saved as typed/.test(noteEl().textContent), 'one that does not is flagged, and still saved as typed');
  ok(noteEl().className.includes('is-warn'), 'the note carries the warning class');

  console.log('\n5. blank again on a NEW material goes back to the suggestion');
  skuAsks = 0;
  skuField().value = '';
  sandbox.matSkuTyped();
  await settle();
  ok(skuAsks === 1, 'clearing the field re-asks for the suggestion — the one bounce that must survive');

  console.log('\n6. repainting a coded existing material is still quiet');
  r = await measure(() => sandbox.matRecordOpen(78));
  ok(!r.unhandled && r.lookups < BUDGET, 'an existing material WITH a code settles too');

  console.log('\n7. and every later paint of the blank-SKU record settles, not just the first');
  await sandbox.matRecordOpen(77);
  await settle();
  r = await measure(async () => { node('mat-f-item_kind').value = 'food'; sandbox.matKindChanged(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'changing its kind repaints without recursing');
  r = await measure(async () => { await sandbox.matSkuPreview(); });
  ok(!r.unhandled && r.lookups < BUDGET, 'and changing its category does not either');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
