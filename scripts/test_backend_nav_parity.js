#!/usr/bin/env node
/**
 * THE DESKTOP RAIL AND THE PHONE'S NAVIGATION ANSWER THE SAME QUESTION.
 *
 * Reported from a Stockroom account: "it has the dashboard but the moment i
 * click anything on the left menu i cant go back to dashboard", and then, of the
 * same account, "there is no syncing between what the warehouse account sees on
 * mobile compared to what it sees on pc with the same permission."
 *
 * Both sentences are one defect with three halves, and each half has a section
 * here. The phone answered all three when its tab bar was capability-filtered
 * (scripts/test_mobile_nav.js is that suite); the desktop, built first, answered
 * none of them.
 *
 *   §1 · A ROLE MUST NOT BE LANDED SOMEWHERE IT CANNOT COME BACK TO.
 *        #tab-dashboard is class="active" in the markup — it is what the shell
 *        boots showing — and applyCapGates can take its rail row away without
 *        moving the operator off the section. One click on any other row and the
 *        dashboard was reachable only by reloading the page.
 *
 *   §2 · HIDING A ROW IS NOT REFUSING IT. A hidden rail button is still in the
 *        DOM and still answers .click(), which is what goTab() does — so the
 *        dashboard's own "The full numbers live in Reports" foot link opened
 *        Reports for a role holding neither dashboard:view nor reports:view.
 *
 *   §4 · THE ROLE'S DASHBOARD CARDS REACH THE PHONE. The Roles editor's own
 *        words are that the dashboard is "this role's first screen on desktop
 *        and the Home tab on the phone"; m.html read /me and threw the field
 *        away, so a Stockroom role with Today and Customers unticked read the
 *        shop's revenue off Home anyway. The money half is worse: that card
 *        carried no gate at all, not even the one its neighbour has.
 *
 *   §3 · EVERY SCREEN THE PHONE GATES, THE RAIL GATES. Two rows carried no
 *        capability at all: Manage team (the roster, every teammate's
 *        permissions) and Sales (today's takings, per channel). The phone has
 *        gated both since ROUTE_CAP existed.
 *
 * Read as SOURCE, not rendered: TAB_CAP and ROUTE_CAP are the two tables, and a
 * divergence between them is the bug. A browser pass would prove the same thing
 * more slowly and belongs in the shard this repo does not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE  = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const OPS   = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '02-settings-ops.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const CORE_DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');

let pass = 0; let fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// The two tables, lifted from the source rather than re-typed here — a copy of a
// table is a table that goes stale in exactly the way this suite exists to catch.
function tableBody(src, name) {
  const at = src.indexOf('const ' + name + '={');
  const start = at > -1 ? at : src.indexOf('const ' + name + ' = {');
  if (start < 0) throw new Error(name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(open + 1, i); }
  }
  throw new Error(name + ' is unbalanced');
}
// Keys of a table, comments and string values stripped. Enough to ask "is this
// screen gated at all", which is the whole question in §3.
function keysOf(body) {
  const out = new Set();
  body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
      .replace(/(^|[,{\s])'?([A-Za-z][A-Za-z0-9_-]*)'?\s*:/g, (m, pre, k) => { out.add(k); return m; });
  return out;
}
const TAB_CAP   = tableBody(CORE, 'TAB_CAP');
const ROUTE_CAP = tableBody(PHONE, 'ROUTE_CAP');
const tabKeys   = keysOf(TAB_CAP);
const routeKeys = keysOf(ROUTE_CAP);

// ─────────────────────────────────────────────────────────────────────────
section('1 · a narrowed role is landed somewhere it can come back from');

yes(/function landOnSomethingReachable\s*\(/.test(CORE),
  'the rail has a landing rule, under the same name the phone uses',
  'public/retail-admin/01-core.js');
yes(/function landOnSomethingReachable\s*\(/.test(PHONE),
  'and the phone still has its own — this suite compares two live rules, not one');

/* It has to run when the caps land, and it has to run ONCE. applyCapGates is
   called from a dozen render paths; re-homing on any of those would move an
   operator off the page they are working on. */
const setCaps = /function setCaps\(list\)\{[\s\S]*?\n\}/.exec(CORE);
yes(!!setCaps && /landOnSomethingReachable\(\)/.test(setCaps[0]),
  'setCaps() runs it — the moment the operator\'s real capabilities arrive');
yes(/if \(_landed\) return;/.test(CORE),
  'and it runs exactly once, however many times the gates are re-applied');
yes(/if \(CAPS === null\) return;/.test(CORE),
  'caps unknown (a hiccup, a stale session) moves nobody — fail-open, as everywhere else');

/* The defect it closes: the section the shell boots showing is the dashboard,
   and the dashboard's row is gated. Both halves asserted, so a change to either
   brings this suite down rather than quietly restoring the trap. */
yes(/<section id="tab-dashboard" class="active">/.test(SHELL),
  'the shell still boots on #tab-dashboard — the section the landing rule is about');
yes(/\bdashboard:\s*'dashboard:view'/.test(TAB_CAP),
  'and the Dashboard row is still gated on dashboard:view — the row that can vanish');

// ─────────────────────────────────────────────────────────────────────────
section('2 · a hidden row is refused, not merely hidden');

yes(/function canTab\(tab\)/.test(CORE),
  'canTab() asks the table, so a rail-less tab is gated too');
const goTab = /function goTab\(tab\) \{[\s\S]*?\n\}/.exec(CORE);
yes(!!goTab && /if \(!canTab\(tab\)\) return;/.test(goTab[0]),
  'goTab() refuses a tab this operator cannot open — every in-page route comes through it');
/* The guard must be the FIRST thing goTab does: below the querySelector it
   would already have clicked the hidden button. */
yes(!!goTab && goTab[0].indexOf('if (!canTab(tab)) return;') < goTab[0].indexOf('querySelector'),
  'and it refuses BEFORE it looks the button up');

yes(/data-cap="reports:view"[^>]*onclick="goTab\('reports'\)"/.test(SHELL),
  'the dashboard\'s Reports foot link carries the same capability — no control that does nothing');
yes(/if \(typeof canTab === 'function' && !canTab\(btn\.dataset\.tab\)\) return;/.test(OPS),
  'the command palette indexes only pages the operator can open');

// ─────────────────────────────────────────────────────────────────────────
section('3 · every screen the phone gates, the rail gates');

/* Screens that exist on both surfaces under the same name. `setup` is the one
   deliberate divergence and carries its reason in TAB_CAP: #setup-nav's display
   is owned by suRefreshChrome, and a second writer would fight it. */
const EXEMPT = new Set(['setup']);
const railTabs = new Set();
SHELL.replace(/data-tab="([a-z-]+)"/g, (m, t) => { railTabs.add(t); return m; });
for (const tab of Array.from(railTabs).sort()) {
  if (EXEMPT.has(tab)) continue;
  if (!routeKeys.has(tab)) continue;             // the phone doesn't have this screen
  yes(tabKeys.has(tab), `${tab} — gated on the desktop, as it is on the phone`,
    `data-tab="${tab}" has no entry in TAB_CAP, so every role sees the row`);
}
yes(EXEMPT.size === 1 && /`setup` \(#setup-nav\) is deliberately NOT in this table/.test(TAB_CAP),
  'the one exemption is written down where the table is, with its reason');

/* The two that were open, named rather than left to the loop — so the suite says
   what it is holding closed even after the loop goes quiet. */
yes(/\bteam:\s*'team:view'/.test(TAB_CAP),
  'Manage team is team:view — the roster is not open to every role');
const salesLine = /\bsales:\s*\[([^\]]*)\]/.exec(TAB_CAP);
yes(!!salesLine && /'dashboard:view'/.test(salesLine[1]),
  'Sales admits dashboard:view — the reading of today\'s takings');
/* ANY-OF, DELIBERATELY WIDER THAN THE PHONE'S. This page is the only door to the
   channel admins on the desktop (they lost their rail rows in the Sales
   redesign), so a stock role holding meituan:sync must still be able to walk
   through it — its own dashboard is what tells it to. */
yes(!!salesLine && /'meituan:view'/.test(salesLine[1]) && /'eleme:view'/.test(salesLine[1])
    && /'guanyi:view'/.test(salesLine[1]),
  'and the three channel admins it is the only door to');

/* The money on the far side of that door carries its own gate, or the widening
   above would have handed a stock role the revenue it was widened to avoid. */
const salesSection = SHELL.slice(SHELL.indexOf('<section id="tab-sales">'),
                                 SHELL.indexOf('<section id="tab-sales">') + 40000);
yes(/id="sales-summary" data-cap="dashboard:view"/.test(salesSection),
  'the Sales summary strip is gated on dashboard:view');
const bareMetrics = (salesSection.match(/class="sales-ch-metrics"(?! data-cap="dashboard:view")/g) || []).length;
const gatedMetrics = (salesSection.match(/class="sales-ch-metrics" data-cap="dashboard:view"/g) || []).length;
yes(bareMetrics === 0 && gatedMetrics > 0,
  `every per-channel metrics block is gated (${gatedMetrics} gated, ${bareMetrics} bare)`,
  'a bare .sales-ch-metrics shows that channel\'s revenue and AOV to a role without dashboard:view');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the role\'s Dashboard cards reach the phone, not just the desktop');

/* Reported with a screenshot of each: the Roles editor for Stockroom, with
   Today, Customers and Unhandled orders UNTICKED — and the phone's Home
   underneath it showing Today (¥732 revenue, average order, new customers) and
   Also today. The server has shipped `dashboardCards` on /api/backend/me since
   the field existed and the desktop has honoured it since then (dashCardGate);
   m.html read /me, ignored the key, and drew every card regardless. The editor
   says in its own words that the dashboard is "this role's first screen on
   desktop and the Home tab on the phone" and that the cards "decide what is on
   it", so the screen was contradicting its own control. */
const ROLES = fs.readFileSync(path.join(ROOT, 'lib', 'roles.js'), 'utf8');
const catalogue = /const DASH_CARDS = \[([^\]]*)\]/.exec(ROLES);
yes(!!catalogue, 'lib/roles.js still owns the card catalogue');
const CARD_KEYS = catalogue ? catalogue[1].match(/'([a-z]+)'/g).map(x => x.replace(/'/g, '')) : [];

yes(/state\.dashCards=Array\.isArray\(u\.dashboardCards\)\?u\.dashboardCards:null;/.test(PHONE),
  'the phone keeps dashboardCards off /me instead of throwing it away');
yes(/function showDashCard\(key\)\{/.test(PHONE),
  'and has a gate to read it with');
/* null must stay "no override" on both surfaces, or a role whose owner never
   opened that field would lose every card on the phone. */
yes(/!Array\.isArray\(state\.dashCards\)\s*\|\|/.test(PHONE),
  'no override (null) hides nothing — the same contract dashCardGate keeps');
yes(/if \(!Array\.isArray\(window\.RA_DASH_CARDS\)\) return;/.test(CORE_DASH),
  'and the desktop still keeps it too');

/* The four keys with a section of their own on Home. Each is asserted BOTH to
   be a real catalogue key and to be the one gating its section — a renamed card
   breaks this suite rather than silently ungating a screen. */
for (const [key, marker, what] of [
  ['recap',     /function recapCard\(\)\{[\s\S]{0,200}?showDashCard\('recap'\)/,     'While you were away'],
  ['needs',     /\$\{showDashCard\('needs'\)&&fires\.length\?/,                        'Needs you'],
  ['orders',    /function todayBlock\(kpis\)\{[\s\S]{0,140}?showDashCard\('orders'\)/, 'Today'],
  ['customers', /function vitalsBlock\(\)\{[\s\S]{0,240}?showDashCard\('customers'\)/, 'Also today'],
]) {
  yes(CARD_KEYS.includes(key), `${key} is a real card in lib/roles DASH_CARDS`);
  yes(marker.test(PHONE), `${what} is gated on '${key}' — as its desktop twin is`);
}

/* THE MONEY HALF, which is worse than the card half and was found with it.
   Today's twin — the desktop's `orders` block — is hidden for the warehouse,
   dispatch and customer-service boards by retail-admin.css. On the phone that
   card had NO money gate at all, not even the one its own neighbour carries, so
   a stock or delivery role read the shop's takings off the first screen the app
   opens. */
const todayFn = /function todayBlock\(kpis\)\{[\s\S]*?\n\}/.exec(PHONE);
yes(!!todayFn && /if\(recapNoMoney\(\)\) return '';/.test(todayFn[0]),
  'Today carries the money gate its neighbour already had',
  'without it a warehouse / dispatch / customer-service board reads revenue on Home');
yes(/body\.pos-warehouse \.td-block\[data-block="orders"\]/.test(
      fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8')),
  'and the desktop still hides the same card for the same boards — the rule being mirrored');

/* The six catalogue keys with no section on Home. Named, so the next reader
   knows the gap was measured rather than missed: the phone surfaces these
   states as Needs-you fires and Quick actions, and inventing a section to hold
   a tick would be worse than the divergence. */
const NO_PHONE_TWIN = ['unhandled', 'inventory', 'incoming', 'onroad', 'ready', 'delivery'];
yes(CARD_KEYS.length === 4 + NO_PHONE_TWIN.length,
  `the catalogue is still ten cards — four gated on Home, ${NO_PHONE_TWIN.length} desktop-only`,
  `lib/roles DASH_CARDS now has ${CARD_KEYS.length}; a new card needs a decision about Home`);
yes(NO_PHONE_TWIN.every(k => CARD_KEYS.includes(k)),
  "and the desktop-only six are still the six named in showDashCard's note");

console.log(`\n${fail ? '✗' : '✓'} backend nav parity — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
