#!/usr/bin/env node
/**
 * Client half of the roles suite — what the Roles tab actually renders.
 * Server half is scripts/test_tenant_roles.js.
 *
 *   node scripts/test_role_editor_client.js
 *
 * No network, no DB, no browser. The renderer is SLICED OUT of the shipped
 * public/retail-admin/02-settings-ops.js verbatim and evaluated against stubs,
 * so this reads the real source rather than a copy — editing the real
 * rlRenderPane is what makes these tests move. The capability catalog is the
 * real one too, straight out of lib/capabilities.js, so the counts below are
 * the counts a tenant sees.
 *
 * What it locks down — the decisions, not the pixels:
 *   1. A COLLAPSED GROUP SAYS ITS NAME AND WHAT IS ON. "Run the shop · 18 of
 *      30 on", never "10 areas · 18 on". The mockups got this wrong in every
 *      direction, so it is asserted both ways: the right string is present and
 *      the area-count phrasing is absent.
 *   2. A SECTION HOLDING ONE PERMISSION FLATTENS. Twelve of the forty sections
 *      hold a single key; a folder around one thing is noise (the call
 *      railSyncGroups already makes for the rail's own folders).
 *   3. THE BLAST RADIUS IS STATED BEFORE THE TICKS, and names the exceptions.
 *   4. MONEY IS MARKED at the permission AND summarised at the role.
 *   5. OWNER RENDERS LOCKED, WITH THE REASON — and with no checkboxes at all.
 *   6. HIDE, NEVER GREY: an operator who can't edit gets no Save, no Delete
 *      and no "Add a role" — not disabled ones.
 *   7. FORCED-ON AND FORCED-OFF ARE DIFFERENT. The per-person matrix used to
 *      paint one tint for both.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'public', 'retail-admin', '02-settings-ops.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }

// ── Slice the shipped source ──────────────────────────────────────────────
// Two ranges, both delimited by comment banners that are part of the file's
// own structure rather than markers added for this test.
function slice(fromMarker, toMarker, label) {
  const a = src.indexOf(fromMarker);
  const b = src.indexOf(toMarker, a + 1);
  if (a === -1 || b === -1 || b <= a) {
    console.error('Could not slice ' + label + ' out of 02-settings-ops.js — the banner moved.');
    process.exit(1);
  }
  return src.slice(a, b);
}
const helpers = slice(
  '// Group and section names come from the catalog now',
  'async function tmLoadCatalog', 'the label + coin helpers');
const matrix = slice(
  "// A row's relationship to the role it sits under.",
  'async function tmOpenPerms', 'the per-person matrix');
const editor = slice(
  '// ROLES — Settings → Team → Roles',
  '// ── Team devices ', 'the roles editor');

// ── Stubs ─────────────────────────────────────────────────────────────────
// A DOM thin enough to be honest: an element is an innerHTML sink with the
// query methods the renderer calls. Nothing here pretends to lay anything out;
// the assertions are all about the HTML the renderer produces.
function mkEl() {
  return {
    innerHTML: '', textContent: '', disabled: false, style: {}, value: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, closest() { return null; },
  };
}
const ELS = {};
const sandbox = {
  console,
  window: { confirm: () => true, prompt: () => null },
  $: (sel) => (ELS[sel] = ELS[sel] || mkEl()),
  $$: () => [],
  cuT: (en) => en,                                   // assert against English
  escapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  escapeAttr: (v) => String(v == null ? '' : v).replace(/"/g, '&quot;'),
  toast: () => {},
  api: async () => ({}),
  TM_CATALOG: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(helpers + '\n' + matrix + '\n' + editor, sandbox);

// The editor's own state is declared with `let` inside the sliced source, which
// in a vm context is a lexical binding and NOT a property of the sandbox — so
// it has to be set by running an assignment in the same context, not by poking
// the object. (TM_CATALOG and TM_PERM_PRESET are declared further up the real
// file, outside these slices, so those are free variables and do resolve to
// the sandbox.)
function setState(obj) {
  const src = Object.keys(obj).map(k => k + ' = ' + JSON.stringify(obj[k]) + ';').join('\n');
  vm.runInContext(src, sandbox);
}

// ── The real catalog ──────────────────────────────────────────────────────
const capabilities = require('../lib/capabilities');
sandbox.TM_CATALOG = {
  capabilities: capabilities.CAPABILITIES,
  groups: ['run', 'sell', 'content', 'setup'],
  sections: capabilities.SECTIONS,
  groupNames: capabilities.GROUPS,
  moneyNotes: capabilities.MONEY_NOTES,
};

const TOTAL = capabilities.ALL_KEYS.length;
// dashboard:view is in group 'run' but is drawn in the Dashboard block, not the
// tree (RL_HOISTED) — so the folder's own count no longer includes it.
const RUN = capabilities.CAPABILITIES.filter(c => c.group === 'run' && c.key !== 'dashboard:view');
const DASH_CARDS = require('../lib/roles').DASH_CARDS;
const stockroomCaps = capabilities.presetCapsFor('warehouse');
const runOn = RUN.filter(c => stockroomCaps.includes(c.key)).length;

const OWNER_ROLE = {
  key: 'owner', nameEn: 'Owner', nameCn: '负责人', descEn: 'Full access, always.', descCn: '',
  caps: [], capCount: TOTAL, capTotal: TOTAL, layout: 'default', isFixed: true,
  people: 1, exceptions: 0, moneyMoves: 19, moneyShows: 15,
};
function selectRole(role, canEdit) {
  setState({
    RL_ROLES: [OWNER_ROLE, role],
    RL_CAN_EDIT: !!canEdit,
    RL_LAYOUTS: ['default', 'store_manager', 'warehouse', 'customer_service', 'dispatch'],
    RL_DASH_CATALOG: DASH_CARDS,
    RL_OPEN: { run: true },                 // Run the shop expanded, the rest collapsed
  });
  vm.runInContext('rlSelect(' + JSON.stringify(role.key) + ', true)', sandbox);
  return ELS['#rlPane'].innerHTML;
}

const stockroom = {
  key: 'warehouse', nameEn: 'Stockroom', nameCn: '仓库',
  descEn: 'Deliveries, counts and stock pushes.', descCn: '',
  caps: stockroomCaps, capCount: stockroomCaps.length, capTotal: TOTAL,
  layout: 'warehouse', isFixed: false, people: 3, exceptions: 1,
  moneyMoves: 2, moneyShows: 5,
};

console.log('role editor — what the Roles tab renders');

// ─────────────────────────────────────────────────────────────────────────
section('1 · a collapsed group says its name, and what is on inside it');
let html = selectRole(stockroom, true);
has(html, 'Run the shop', 'the group is named — the name is the point of a collapsed row');
has(html, runOn + ' of ' + RUN.length + ' on',
  'and counts PERMISSIONS: "' + runOn + ' of ' + RUN.length + ' on"');
hasnt(html, ' areas', 'never "10 areas" — how many areas a group holds is not a fact anyone came for');
has(html, 'Content &amp; inbox', 'every group is named, including the ones with nothing on');
has(html, 'nothing on', 'and a group with nothing on says so in words, not "0"');

section('2 · a section holding one permission flattens');
// 'topup' holds exactly one key; 'orders' holds five.
has(html, 'Orders', 'a multi-key section keeps its heading');
hasnt(html, '>Top-up packages<', 'a single-key section does not get a heading of its own');
has(html, 'Edit top-up packages', 'its one permission is still there, just not in a folder');

section('3 · the blast radius, before the ticks');
has(html, '3 people hold this role', 'stated in people, not ids');
has(html, 'reaches them on their next screen', 'and says when it lands — the promise the cache keeps');
has(html, '1 of them has an exception', 'exceptions are counted');
has(html, 'survive this edit', 'and the edit is promised not to erase them');
const blastAt = html.indexOf('hold this role');
const firstTick = html.indexOf('type="checkbox"');
if (blastAt !== -1 && firstTick !== -1 && blastAt < firstTick) ok('and it comes BEFORE the first checkbox');
else bad('and it comes BEFORE the first checkbox', 'blast at ' + blastAt + ', first tick at ' + firstTick);

section('4 · money, marked and summarised');
has(html, 'rl-coin moves', 'a money-moving permission carries the marker');
has(html, 'A purchase order commits the business to pay', 'with the registry’s own reason underneath it');
has(html, 'move money', 'and the role summarises its money reach');
// `products:costs`, not `products:view`. The catalogue itself stopped showing
// money on 2026-09-03 when cost and margin were split out of it — so a set built
// from products:view now tallies ONE show, and this case is about counting two.
is(vm.runInContext('rlMoneyLine(new Set(["orders:refund","reports:view","products:costs"]))', sandbox),
  '1 move money · 2 show it', 'the summary counts both kinds separately');
// The split itself, asserted where the operator actually reads the tally:
// opening the catalogue is no longer a money permission.
is(vm.runInContext('rlMoneyLine(new Set(["products:view","categories:view"]))', sandbox),
  'Touches no money', 'and the catalogue alone touches none');
is(vm.runInContext('rlMoneyLine(new Set(["orders:view","categories:edit"]))', sandbox),
  'Touches no money', 'and says so plainly when a role touches none');

section('5 · Owner renders locked, with the reason');
html = selectRole(OWNER_ROLE, true);
has(html, 'Fixed', 'it says it is fixed');
has(html, 'never lock itself out of its own account', 'and says WHY, which is the part a lock usually omits');
hasnt(html, 'type="checkbox"', 'with no checkboxes to imply otherwise');
hasnt(html, 'id="rlSave"', 'and no Save button');

section('6 · hide, never grey');
html = selectRole(stockroom, false);
hasnt(html, 'id="rlSave"', 'an operator who can’t edit gets no Save button at all');
hasnt(html, 'id="rlDelete"', 'no Delete');
has(html, 'Stockroom', 'they still see the role');
has(html, 'type="checkbox"', 'and what it reaches, read-only');
has(html, 'disabled', 'the ticks themselves are inert');
setState({ RL_CAN_EDIT: false, RL_SEL: 'warehouse' });
vm.runInContext('rlRenderList()', sandbox);
hasnt(ELS['#rlList'].innerHTML, 'rlAdd', '"Add a role" is absent, not disabled');
setState({ RL_CAN_EDIT: true });
vm.runInContext('rlRenderList()', sandbox);
has(ELS['#rlList'].innerHTML, 'rlAdd', 'and present for somebody who can');

section('7 · forced-on and forced-off are different facts');
sandbox.TM_PERM_PRESET = new Set(['orders:edit']);
is(vm.runInContext('tmDevState("orders:refund", true)', sandbox), 'on',
  'a permission the role does not give, switched on, is an ADDITION');
is(vm.runInContext('tmDevState("orders:edit", false)', sandbox), 'off',
  'a permission the role gives, switched off, is a REMOVAL');
is(vm.runInContext('tmDevState("orders:edit", true)', sandbox), '',
  'and matching the role is neither');
has(vm.runInContext('tmDevMark("on")', sandbox), 'Added', 'an addition is labelled');
has(vm.runInContext('tmDevMark("off")', sandbox), 'Removed', 'a removal is labelled differently');

section('8 · the counts the list shows');
setState({ RL_ROLES: [OWNER_ROLE, Object.assign({}, stockroom, { people: 1 })] });
vm.runInContext('rlRenderList()', sandbox);
has(ELS['#rlList'].innerHTML, '1 person', 'one holder reads "1 person", not "1 people"');
setState({ RL_ROLES: [OWNER_ROLE, Object.assign({}, stockroom, { people: 0 })] });
vm.runInContext('rlRenderList()', sandbox);
has(ELS['#rlList'].innerHTML, 'nobody', 'and none reads "nobody", not "0 people"');
is(vm.runInContext('rlPeopleWord(0)', sandbox), 'Nobody holds this role yet',
  'the pane says the same thing as a whole sentence');

section('9 · the dashboard is one block, with its switch on top');
// Three settings about one screen — whether it exists (dashboard:view), which
// board, which cards — used to sit in two places in the wrong order: board and
// cards near the top, the switch that governs both inside a collapsed folder
// seventy rows down. An owner set the first two and the phone still opened on
// Orders. Now they are one block, switch first, dependents greyed while off.
html = selectRole(stockroom, true);
has(html, 'id="rlDash"', 'the block exists');
has(html, 'data-key="dashboard:view"', 'its switch is the capability itself, not a copy of it');
is((html.match(/data-key="dashboard:view"/g) || []).length, 1, 'and it is drawn ONCE — not again in the tree');
const dashAt = html.indexOf('id="rlDash"'), layoutAt = html.indexOf('id="rlLayout"'), cardsAt = html.indexOf('rl-dcards');
if (dashAt !== -1 && dashAt < layoutAt && layoutAt < cardsAt) ok('switch, then layout, then cards — dependency order');
else bad('switch, then layout, then cards — dependency order', dashAt + ' / ' + layoutAt + ' / ' + cardsAt);
has(html, 'Home tab on the phone', 'the sentence names the phone — the device the old pane never mentioned');
has(html, 'first screen on desktop', 'and the desktop');
has(html, 'Needs you', 'the card picks are there');
hasnt(html, 'rl-dash-body off', 'and not greyed, because Stockroom has the switch on');
// The blast radius still comes before the FIRST checkbox — the block is below it.
const blast2 = html.indexOf('hold this role'), tick2 = html.indexOf('type="checkbox"');
if (blast2 !== -1 && tick2 !== -1 && blast2 < tick2) ok('and the whole block still sits below the blast radius');
else bad('and the whole block still sits below the blast radius', blast2 + ' vs ' + tick2);

// The same role with the switch OFF: the layout and cards are still shown, greyed,
// under a sentence that says what off means on each device.
const noDash = Object.assign({}, stockroom, { caps: stockroomCaps.filter(k => k !== 'dashboard:view') });
html = selectRole(noDash, true);
has(html, 'rl-dash-body off', 'switch off → the body is greyed as a unit');
has(html, 'no dashboard on any device', 'and the sentence says so');
has(html, 'usually Orders', 'naming where they land instead');
has(html, 'id="rlLayout" disabled', 'the layout select is inert');
has(html, 'data-dcard="needs"><input type="checkbox" checked disabled', 'so are the card ticks — still showing their picks, not cleared');

// Read-only: the block renders, everything inert, the layout as text.
html = selectRole(stockroom, false);
has(html, 'id="rlDash"', 'a read-only viewer still sees the block');
has(html, 'id="rlDashOn" checked disabled', 'with the switch inert');
hasnt(html, 'id="rlLayout"', 'and the layout as text rather than a dead select');
has(html, 'Stock and deliveries', 'naming the board');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
