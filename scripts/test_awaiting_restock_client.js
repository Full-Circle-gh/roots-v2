#!/usr/bin/env node
/**
 * Client half of the awaiting-restock drawer work — what the order drawer
 * actually renders for an order parked on a restock.
 *
 *   node scripts/test_awaiting_restock_client.js
 *
 * No network, no DB, no browser. The renderers are SLICED OUT of the shipped
 * public/retail-admin/04-orders.js verbatim and evaluated against stubs, so
 * this reads the real source rather than a copy — editing the real
 * awaitingRestockCard is what makes these tests move.
 *
 * What it locks down — the decisions, not the pixels:
 *   1. THE CARD NAMES THE PRODUCT. The whole point: before this, an
 *      awaiting-restock order showed a status pill and nothing else, and staff
 *      checked stock SKU by SKU in Products to find the short line.
 *   2. 🔴 A RELEASED ORDER CLAIMS NOTHING. awaiting_restock_pids is KEPT after
 *      the order flips back to 'paid' (it is the audit trail — see
 *      checkAwaitingRestockForRestock in lib/inventory.js). Every reader must
 *      gate on the live status too, or a long-shipped order still says it is
 *      waiting on stock. This is the one that breaks silently.
 *   3. THE RELEASE IS STATED. The order returns to Paid on its own when stock
 *      lands. Without that sentence the card reads as a task and staff chase an
 *      order nobody has to touch.
 *   4. A PRE-ORDER DOES NOT CLAIM THE CUSTOMER CHOSE. A pre-order line parks
 *      with no fallback_choice at all; "the customer chose to wait" would be
 *      untrue there.
 *   5. ONLY THE PARKED LINES ARE MARKED, and a parcel that carries none keeps
 *      its own state pill.
 *   6. A PARCEL ALREADY MOVING KEEPS ITS STATE. "Held" describes a pending
 *      parcel; a dispatched one is what the operator is tracking.
 *   7. 🔴 THE MARKED ROW LINES UP WITH THE ROWS AROUND IT. The first version
 *      bled the tint out to the shipment card's edge with a negative margin,
 *      and shipped misaligned — the marked row's content sat left of the
 *      numbers above it and its total sat right of the other totals. The one
 *      row the operator is meant to read carefully was the one that did not
 *      line up. Its replacement, an inset edge marker, then painted over the
 *      line number, because a manifest row has no horizontal padding for one
 *      to sit in. Asserted against the stylesheet, because both were CSS bugs
 *      that no amount of renderer testing would have caught.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }

// ── Slice the shipped source ──────────────────────────────────────────────
// By brace matching from `function <name>(`, so the slice tracks the real file
// as it is edited rather than a line range that rots on the next insertion.
function slice(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  // Every top-level function in this file closes on a `}` in column 0, so the
  // end marker is unambiguous. Brace counting is NOT usable here: the renderers
  // nest backticks inside `${}` inside template literals, and a scanner that
  // tracks quotes loses the thread on the first nested one.
  const end = src.indexOf('\n}\n', start);
  if (end === -1) throw new Error('no column-0 close found for ' + name);
  return src.slice(start, end + 3);
}

const NAMES = [
  'awaitingRestockPids', 'awaitingRestockStore', 'awaitingRestockCard',
  'shipHoldPill', 'renderItemRow', 'renderItemsTable',
];

// ── Stubs: everything the slices call that we are not testing ─────────────
let LANG = 'en';
const sandbox = {
  window: { cuLang: () => LANG },
  console,
  _ITEMS_SORT_MODE: 'default',
  cuT: (en, cn) => (LANG === 'cn' ? cn : en),
  escapeHtml: (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  fmt: (n) => Number(n || 0).toFixed(2),
  orderItemNames: (it) => (LANG === 'cn' && it.name_cn)
    ? { primary: it.name_cn, secondary: it.name_en || '' }
    : { primary: it.name_en || it.name_cn || '', secondary: '' },
  itemThumb: () => '<span class="oi-thumb is-empty"></span>',
  itemSkuHtml: (it) => `<span class="item-sku">${it.sku || 'no SKU'}</span>`,
  itemQtyHtml: (it) => `<span class="item-qty">×${it.qty}</span>`,
  itemRefundHtml: () => '',
  itemFullyRefunded: () => false,
  itemOptionsHtml: () => '',
  renderBundleInside: () => '',
  renderPackBadges: () => '',
  productHref: () => '',
  sortOrderItems: (items) => items,
  shipmentStatePill: (s) => `<span class="pill STATE-${s.state || 'pending'}"></span>`,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(NAMES.map(slice).join('\n'), sandbox);
const { awaitingRestockPids, awaitingRestockCard, shipHoldPill, renderItemsTable } = sandbox;

// ── Fixtures — order TC000518, the specimen this work was drawn from ──────
const ITEMS = [
  { id: 1, product_id: 210, name_en: 'Crunchy Jujube Crisps',  name_cn: '脆枣片',   sku: '2-210',    qty: 1, unit_price: 17, line_total: 17 },
  { id: 2, product_id: 260, name_en: 'Dried Sweet Banana',     name_cn: '香蕉干',   sku: '2-260',    qty: 2, unit_price: 22, line_total: 44 },
  { id: 3, product_id: 20,  name_en: 'Choco Hemp Protein Bites', name_cn: '巧克力蛋白球', sku: '3-20', qty: 2, unit_price: 38, line_total: 76 },
  { id: 4, product_id: 50,  name_en: 'Savory Quinoa Patties',  name_cn: '藜麦饼',   sku: '3-50',     qty: 1, unit_price: 43, line_total: 43 },
  { id: 7, product_id: 360, name_en: 'Calm Buckwheat Granola', name_cn: '荞麦燕麦片', sku: 'S(4-360)', qty: 1, unit_price: 8,  line_total: 8 },
];
const parked = (over = {}) => ({
  id: 518, order_no: 'TC000518', status: 'awaiting_restock',
  store_code: 'TH', store_name_en: 'Tianhe', store_name_cn: '天河店',
  fallback_choice: 'wait_for_restock',
  awaiting_restock_pids: JSON.stringify([20]),
  items: ITEMS, ...over,
});

section('1 · The card names the product the order is parked on');
{
  const html = awaitingRestockCard(parked());
  has(html, 'Choco Hemp Protein Bites', 'the short product is named');
  has(html, '3-20', 'its SKU is on the row, for the shelf');
  has(html, '×2', 'and the quantity the order needs');
  has(html, 'Waiting on stock at Tianhe', 'the title names the fulfilling store');
  hasnt(html, 'Dried Sweet Banana', 'a line that is NOT short stays out of the card');
}

section('2 · 🔴 A released order claims nothing (the pids outlive the status)');
{
  // Exactly the row lib/inventory.js leaves behind: status flipped to 'paid',
  // awaiting_restock_pids untouched for audit.
  const released = parked({ status: 'paid' });
  is(awaitingRestockPids(released), [], 'no pids are read once the order has released');
  is(awaitingRestockCard(released), '', 'and the card does not render');
  is(awaitingRestockCard(parked({ status: 'delivered' })), '', 'nor on a delivered order');
  is(awaitingRestockCard(parked({ status: 'cancelled' })), '', 'nor on a cancelled one');
}

section('3 · The release is stated, so nobody chases the order');
{
  const html = awaitingRestockCard(parked());
  has(html, 'Releases to Paid on its own once Tianhe can cover the order.',
      'the card says the order releases itself when stock lands');
  has(html, 'ar-dot', 'and carries the dot that marks it as the system acting');
}

section('4 · A pre-order does not claim the customer chose to wait');
{
  const preorder = parked({ fallback_choice: null });
  const html = awaitingRestockCard(preorder);
  hasnt(html, 'The customer chose to wait', 'no choice is claimed when none was recorded');
  has(html, 'Releases to Paid on its own', 'but the release is still stated');
  has(awaitingRestockCard(parked()), 'The customer chose to wait',
      'while an answered shortage modal does say so');
}

section('5 · Only the parked lines are marked in the manifest');
{
  const waiting = new Set(awaitingRestockPids(parked()));
  const rows = renderItemsTable(ITEMS, false, waiting);
  is((rows.match(/awaiting-row/g) || []).length, 1, 'exactly one row carries the mark');
  is((rows.match(/Waiting on stock/g) || []).length, 1, 'and exactly one pill');
  const marked = rows.slice(rows.indexOf('awaiting-row'));
  has(marked.slice(0, 400), 'Choco Hemp Protein Bites', 'it is the short line that is marked');
  is(renderItemsTable(ITEMS, false, new Set()).indexOf('awaiting-row'), -1,
     'an order waiting on nothing marks no row at all');
}

section('6 · The parcel header names the hold, but only when it holds one');
{
  const o = parked();
  const waiting = new Set(awaitingRestockPids(o));
  const shortParcel = { state: 'pending', items: [ITEMS[2], ITEMS[1]] };
  const cleanParcel = { state: 'pending', items: [ITEMS[0], ITEMS[1]] };
  has(shipHoldPill(o, shortParcel, waiting), 'Held — 1 line waiting',
      'a pending parcel carrying the short line names the hold');
  has(shipHoldPill(o, cleanParcel, waiting), 'STATE-pending',
      'a parcel carrying none keeps its own state pill');
  has(shipHoldPill(o, { state: 'dispatched', items: [ITEMS[2]] }, waiting), 'STATE-dispatched',
      'and a parcel already moving keeps its state — that is what is tracked');
  const two = new Set([20, 360]);
  has(shipHoldPill(o, { state: 'pending', items: [ITEMS[2], ITEMS[4]] }, two),
      'Held — 2 lines waiting', 'two short lines pluralise');
}

section('7 · Both languages render, and neither renders glued');
{
  LANG = 'cn';
  const cn = awaitingRestockCard(parked());
  has(cn, '天河店等待补货', 'the Chinese title uses the Chinese store name');
  hasnt(cn, 'Waiting on stock', 'and does not carry the English half beside it');
  LANG = 'en';
  const en = awaitingRestockCard(parked());
  hasnt(en, '等待补货', 'the English card does not carry the Chinese half either');
}

section('8 · A pid with no matching line still shows');
{
  // The item was removed from the order after it parked. Dropping the row
  // silently would make the card disagree with the status pill.
  const html = awaitingRestockCard(parked({ awaiting_restock_pids: JSON.stringify([9999]) }));
  has(html, '#9999', 'an unmatched product id renders as the id');
}

section('9 · Malformed data never throws');
{
  is(awaitingRestockPids(parked({ awaiting_restock_pids: 'not json' })), [], 'broken JSON reads as empty');
  is(awaitingRestockPids(parked({ awaiting_restock_pids: null })), [], 'null reads as empty');
  is(awaitingRestockPids(parked({ awaiting_restock_pids: '{"a":1}' })), [], 'a non-array reads as empty');
  is(awaitingRestockCard(parked({ awaiting_restock_pids: '[]' })), '', 'an empty array renders nothing');
  is(awaitingRestockPids(null), [], 'no order at all reads as empty');
}

section('10 · 🔴 The marked row keeps the same box as every other row');
{
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin.css'), 'utf8');
  const start = CSS.indexOf('.manifest .mf-row.awaiting-row {');
  const rule = start === -1 ? '' : CSS.slice(start, CSS.indexOf('}', start));
  if (!rule) bad('the awaiting-row rule exists in the stylesheet');
  else {
    ok('the awaiting-row rule exists in the stylesheet');
    // Strip comments — the rule's own comment NAMES the banned properties to
    // explain why they are banned, and must not itself trip the assertion.
    const decls = rule.replace(/\/\*[\s\S]*?\*\//g, '');
    hasnt(decls, 'margin', 'it declares no margin — a bleed moves the row off the grid');
    hasnt(decls, 'padding', 'and no padding — that is what moved the total');
    // A .mf-row has zero horizontal padding, so an inset edge marker has no
    // gutter to sit in and paints over the 01/02/03 line number.
    hasnt(decls, 'inset', 'and no inset edge marker — it lands on the row number');
    has(decls, 'background', 'the tint alone carries the mark');
  }
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
