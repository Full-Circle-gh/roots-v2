#!/usr/bin/env node
// The Purchasing rail dot: "the kitchen is waiting on you", said at the front
// door instead of only inside the screen it is trying to summon the buyer to.
//
// Two halves, because the dot is two files:
//   • the MARKUP half reads public/retail-admin.html and checks the rail row
//     actually carries the badge span the painter looks up. A painter that
//     works perfectly against an id nothing renders is the failure this half
//     exists to catch.
//   • the BEHAVIOUR half runs public/retail-admin/16-purchasing.js in a `vm`
//     context, the same way test_kitchen_po_picker.js does, and drives the
//     painter through the two doors it has: loadMaterialRequests (what puInit
//     calls) and puMrPollDot (the timer's body, called directly here so the
//     suite never waits on a clock).
//
// Run:  node scripts/test_purchasing_kitchen_dot.js
//
// Cases:
//   1. the rail row carries the badge, with the shared .tab-badge component
//   2. a queue paints the dot; the count shows from two up, never at one
//   3. an empty queue clears it
//   4. a failed read leaves the dot exactly as it was
//   5. production off means no dot and no request
//   6. no purchasing:view means no dot and no request

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { tdWhen, tdToday } = require('../public/td-datetime.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

// ── 1 · the markup ────────────────────────────────────────────────────────
console.log('\n══ 1 · the rail row carries the badge ══');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin.html'), 'utf8');
const railRow = (() => {
  const i = html.indexOf('<button data-tab="purchasing"');
  return i < 0 ? '' : html.slice(i, html.indexOf('</button>', i));
})();
ok(railRow.length > 0, 'the Purchasing rail row exists');
ok(railRow.includes('id="purchasingTabBadge"'), 'and carries the id the painter looks up');
// The shared component, not a private dot: retail-admin.css hangs the rail's
// "calm amber, no pulse" rule on `.tabs .tab-badge`, and a bespoke class would
// opt out of it — and out of any later change to it.
ok(/id="purchasingTabBadge"[^>]*class="tab-badge"|class="tab-badge"[^>]*id="purchasingTabBadge"/.test(railRow),
   'as the shared .tab-badge component');
ok(/aria-label="[^"]+"/.test(railRow), 'with an aria-label, so the dot is not silent to a screen reader');

// ── the DOM stub ──────────────────────────────────────────────────────────
// getElementById answers for any id (the module paints a shell then looks
// inside it); querySelector answers only for the rail row, because that is the
// one selector the painter uses and a stub that answers everything would let a
// wrong selector pass.
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
      addEventListener() {}, closest: () => null,
    };
    Object.defineProperty(n, 'innerHTML', { get: () => inner, set: v => { inner = v; } });
    nodes.set(id, n);
  }
  return nodes.get(id);
}
const RAIL_SELECTOR = '.tabs [data-tab="purchasing"]';
const document = {
  hidden: false,
  getElementById: node,
  createElement: () => node('scratch'),
  querySelector: sel => (sel === RAIL_SELECTOR ? node('rail-purchasing') : null),
  querySelectorAll: () => [],
  addEventListener() {},
  body: node('body'),
};
document.body.classList.add('feat-production');

// ── the server, faked ─────────────────────────────────────────────────────
let PENDING = [];
let pendingCalls = 0;
let failPending = false;
const line = i => ({ id: i, request_id: 1, ingredient_id: i, name_en: 'Tomato ' + i,
                     name_cn: '番茄', sku: 'T' + i, qty: 2, unit: 'kg',
                     mr_number: 'MR-0001', date: '2026-09-18', created_by_name: 'Cook' });

async function api(p) {
  if (p === '/api/retail-admin/material-requests/pending-lines') {
    pendingCalls++;
    if (failPending) { const e = new Error('offline'); e.status = 500; throw e; }
    return { success: true, data: PENDING };
  }
  if (p === '/api/retail-admin/purchases') return { success: true, data: [] };
  if (p === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 }] };
  return { success: true, data: [] };
}

let CAPS_OK = true;
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object, Number, String,
  api, toast: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
  tdWhen, tdToday,
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  acCurrencySymbol: () => '¥',
  applyCapGates: () => {},
  can: () => CAPS_OK,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// No setInterval in the context on purpose: the poller's own guard refuses to
// start without one, so this suite drives puMrPollDot by hand and never has a
// timer running underneath its assertions.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '16-purchasing.js'), 'utf8'),
                sandbox, { filename: '16-purchasing.js' });

const railOn  = () => node('rail-purchasing').classList.contains('has-unseen');
const badge   = () => node('purchasingTabBadge').textContent;

async function main() {
  console.log('\n══ 2 · a waiting queue lights the rail ══');
  PENDING = [line(1)];
  await sandbox.puMrPollDot();
  ok(railOn(), 'one request lights the dot');
  ok(badge() === '', 'and shows no number — a bare dot at one, like the orders badge');

  PENDING = [line(1), line(2)];
  await sandbox.puMrPollDot();
  ok(railOn() && badge() === '2', 'two requests show the count');

  PENDING = Array.from({ length: 120 }, (_, i) => line(i + 1));
  await sandbox.puMrPollDot();
  ok(badge() === '99+', 'and it caps at 99+');

  // The other door: what puInit walks through. The dot has to agree with the
  // "From the kitchen" chip, which reads the same list.
  PENDING = [line(1), line(2), line(3)];
  await sandbox.puInit();
  ok(railOn() && badge() === '3', 'opening the screen repaints it from the same list');

  console.log('\n══ 3 · an answered queue clears it ══');
  PENDING = [];
  await sandbox.puMrPollDot();
  ok(!railOn(), 'nothing waiting, no dot');
  ok(badge() === '', 'and no number left behind');

  console.log('\n══ 4 · a failed read leaves the dot alone ══');
  PENDING = [line(1), line(2), line(3), line(4)];
  await sandbox.puMrPollDot();
  ok(railOn() && badge() === '4', 'four waiting');
  failPending = true;
  await sandbox.puMrPollDot();
  ok(railOn() && badge() === '4', 'a 500 does not report the queue empty');
  failPending = false;

  console.log('\n══ 5 · production off means silence ══');
  document.body.classList.remove('feat-production');
  const beforeFeat = pendingCalls;
  await sandbox.puMrPollDot();
  ok(pendingCalls === beforeFeat, 'the poll does not even ask');
  ok(!railOn() && badge() === '', 'and the dot is cleared, not stranded');
  document.body.classList.add('feat-production');

  console.log('\n══ 6 · no purchasing:view means silence ══');
  await sandbox.puMrPollDot();          // repaint the queue first
  ok(railOn(), 'the dot is back with the feature on');
  CAPS_OK = false;
  const beforeCap = pendingCalls;
  await sandbox.puMrPollDot();
  ok(pendingCalls === beforeCap, 'an operator without the tab never polls for it');
  CAPS_OK = true;

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
