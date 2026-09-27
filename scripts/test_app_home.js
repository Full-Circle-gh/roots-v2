#!/usr/bin/env node
/**
 * THE WAY BACK OUT OF A SEPARATE PAGE — where it goes, and what it may call it.
 *
 *   node scripts/test_app_home.js
 *
 * /stock and /till are their own documents, so each carries its own back link,
 * and both take it from the server: `home` + `home_label` on
 * /quick-stock/context, `home`/`homeLabel` on /api/backend/me.
 *
 * The defect. Both answered '/m' with the operator's ROLE NAME on it. A
 * warehouse operator therefore pressed a link reading "Warehouse" and landed on
 * the DASHBOARD — a board of revenue under "Good afternoon" — because '/m' opens
 * on the home tab for anyone holding one of the four tab capabilities. The label
 * named a screen that does not exist for them, and it dropped them two screens
 * away from the row they came in through: every one of these pages is reached
 * from More → Operations.
 *
 * The role's name IS the right label for one kind of operator — the one with no
 * tab bar, whose tool list is the home screen and is titled with the role's own
 * name (public/m.html homeTitle()). So the rule is about the destination's
 * title, not about the role, and that is what this asserts.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { backToTacet } = require(path.join(__dirname, '..', 'lib', 'app-home.js'));

const WAREHOUSE = { nameEn: 'Warehouse', nameCn: '仓库' };
const CLERK = { nameEn: 'Shelf clerk', nameCn: '门店盘点' };

let checks = 0;
function t(what, fn) { fn(); checks++; console.log('  ✓ ' + what); }

console.log('\nThe way back:');

t('lands on the tool list, not the dashboard', () => {
  const r = backToTacet(WAREHOUSE, ['dashboard:view', 'quickstock:recount']);
  assert.strictEqual(r.home, '/m?to=more');
});

t('a role with tabs is sent back to a list called More', () => {
  const r = backToTacet(WAREHOUSE, ['dashboard:view', 'quickstock:recount']);
  assert.deepStrictEqual(r.homeLabel, { en: 'More', cn: '更多' });
});

t('any one of the four tab caps is enough to put a bar under it', () => {
  for (const k of ['dashboard:view', 'orders:view', 'customers:view', 'products:view']) {
    assert.strictEqual(backToTacet(WAREHOUSE, [k]).homeLabel.en, 'More', k);
  }
});

t('a role with no tabs at all keeps its own name — the list IS its home', () => {
  const r = backToTacet(WAREHOUSE, ['quickstock:recount', 'restock:pick']);
  assert.deepStrictEqual(r.homeLabel, { en: 'Warehouse', cn: '仓库' });
});

t('a nameless role falls back to More rather than to nothing', () => {
  const r = backToTacet({}, ['quickstock:recount']);
  assert.deepStrictEqual(r.homeLabel, { en: 'More', cn: '更多' });
});

/* WAS: "a stock-app-only role gets no door — /m would redirect it straight
   back." True while server.js bounced that role out of Tacet Mobile; §48 step 3
   re-points the confinement AT this app, so /m is now where the role lives and
   the door is the truest one on the page. §278 then removed the lockdown
   altogether. It is a FLAT role — it holds none of the four tab capabilities —
   so it is named for itself, exactly as the warehouse clerk above is. */
t('a stock clerk gets the door into Tacet Mobile, named for its role', () => {
  const r = backToTacet(CLERK, ['quickstock:recount']);
  assert.strictEqual(r.home, '/m?to=more');
  assert.deepStrictEqual(r.homeLabel, { en: 'Shelf clerk', cn: '门店盘点' });
});

t('unresolved caps fail OPEN to the bar, exactly as m.html mCan() does', () => {
  // null caps mean a resolution hiccup, and the app draws every tab in that
  // state — so the label has to describe the screen the operator will see.
  assert.strictEqual(backToTacet(WAREHOUSE, null).homeLabel.en, 'More');
});

t('a Set answers the same as an array — both shapes ship in this codebase', () => {
  const asSet = backToTacet(WAREHOUSE, new Set(['quickstock:recount']));
  const asArr = backToTacet(WAREHOUSE, ['quickstock:recount']);
  assert.deepStrictEqual(asSet, asArr);
});

t('an unseeded tenant still has a way out', () => {
  const r = backToTacet(null, ['dashboard:view']);
  assert.strictEqual(r.home, '/m?to=more');
});

/* ────────────────────────────────────────────────────────────────
   AND THE DOOR THAT IS NOT IN /m.

   The defect, from Ash, at a desktop: "on pc - after clicking back from what
   kitchen made it goes to mobile screen", and then again on the second page it
   affects: "same problem when clicking back from the till". Both pages are
   opened from the store backend — the dashboard's "Ready from the kitchen" row
   into /stock, and the rail, the POS tile, the Sales card and the command bar
   into /till — and both take their way out from backToTacet above, which
   answers '/m?to=more' because until those doors existed, every entry into
   either page was a row in More → Operations. So a person at a PC pressed Back
   and got the PHONE APP: a screen they had never been on, in a product they had
   not opened.

   backToTacet is not wrong and is not changed. It answers the question it was
   asked — where a TACET MOBILE operator goes — and the fix is that the new
   doors say which door they are.

   NO BROWSER. Every end is read out of the SHIPPED source, the technique
   scripts/test_kitchen_ready_dashboard.js uses on this same row: the real
   homeFromDoor is sliced out of public/stock.html and public/till.html and run
   against a stub, and the real links out of 03-dashboard.js, 01-core.js,
   02-settings-ops.js and retail-admin.html. What is asserted is what ships.
   The render passes for these two pages live in scripts/test_stock_home.js and
   the till's own suites, in the browser shard.
   ──────────────────────────────────────────────────────────────── */
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const read = (...r) => fs.readFileSync(path.join(ROOT, ...r), 'utf8');
/* public/stock.html IS GONE (§48 step 4), so the till is the only page left
   carrying its own way back. What that costs this file is recorded case by case
   below rather than quietly dropped. */
const TILL_HTML = read('public', 'till.html');
const DASH_JS = read('public', 'retail-admin', '03-dashboard.js');
const CORE_JS = read('public', 'retail-admin', '01-core.js');
const OPS_JS = read('public', 'retail-admin', '02-settings-ops.js');
const ADMIN_HTML = read('public', 'retail-admin.html');

const FN_RE = /\n  function homeFromDoor\(home\) \{[\s\S]*?\n  \}\n/;
function slice(src, where) {
  const m = FN_RE.exec(src);
  assert.ok(m, 'homeFromDoor has gone from ' + where + ' — that way back is unguarded again');
  return m[0];
}
const FN_TILL = slice(TILL_HTML, 'public/till.html');

/* WAS: "both pages carry the same door table, to the byte." The copy WAS the
   design — neither page loads an external script, so the rule could not live in
   a shared file without turning the way back into a second request, and this
   case was what made duplicating it survivable.

   THERE IS NOTHING LEFT TO DRIFT AGAINST. §48 step 4 deleted public/stock.html,
   so the till is the only page carrying homeFromDoor, and a comparison with one
   operand is not a comparison. The rules below still run against the till's
   real shipped copy, which is what the byte check was ultimately protecting.
   If a second page ever grows its own way back, restore this case with it. */
t('the till still carries a door table at all', () => {
  assert.ok(/dashboard:/.test(FN_TILL),
    'homeFromDoor has lost its door table — /till?from=dashboard sends Back to the phone app again');
});

// Applied exactly as both pages apply it: the door replaces home and label, and
// nothing else about the server's answer is touched.
function backAfter(fn, search, seed) {
  const state = Object.assign(
    { home: '/m?to=more', homeLabel: { en: 'More', cn: '更多' } }, seed || {});
  const door = new Function('location', 'HOME', fn + '\n  return homeFromDoor(HOME);')(
    { search }, state.home);
  if (door) { state.home = door.home; state.homeLabel = door.label; }
  return state;
}
// Run every rule against the shipped copy, so the behaviour is caught by what it
// DOES and not only by reading the source. It used to run against BOTH copies —
// /stock's and the till's — which is what made the byte comparison above more
// than a formality; §48 step 4 deleted the first page, and the loop is kept
// rather than unrolled so restoring a second door is adding one array entry.
const PAGES = [['/till', FN_TILL]];
const each = (search, seed) => PAGES.map(([n, fn]) => [n, backAfter(fn, search, seed)]);

console.log('\nThe door that is not in /m:');

t('no ?from= at all leaves the server\'s answer exactly as it was', () => {
  for (const [n, r] of each('?go=ready')) {
    assert.strictEqual(r.home, '/m?to=more', n);
    assert.deepStrictEqual(r.homeLabel, { en: 'More', cn: '更多' }, n);
  }
});

t('?from=dashboard sends Back to the dashboard, not to the phone', () => {
  for (const [n, r] of each('?from=dashboard')) assert.strictEqual(r.home, '/?tab=dashboard', n);
  /* The second half of this case checked '?go=ready&from=dashboard' — the deep
     link the desktop kitchen-ready row used to send. Both the row's navigation
     and the page that read it are gone (§48 step 4, §73): the row opens a drawer
     in the shell now. The ?from= rule itself still holds for every door that
     remains, which is what the loop above asserts. */
});

t('and names it what that screen calls itself', () => {
  // public/retail-admin.html's own dictionary: 'Dashboard': '主控台'. Quoted,
  // not composed — the back link and the screen it opens say the same words.
  for (const [n, r] of each('?from=dashboard')) {
    assert.deepStrictEqual(r.homeLabel, { en: 'Dashboard', cn: '主控台' }, n);
  }
});

t('a ?from= this build does not know leaves the server\'s answer standing', () => {
  // Never a URL out of the query string: an unknown door is not a door.
  for (const [n, r] of each('?from=elsewhere')) assert.strictEqual(r.home, '/m?to=more', n);
});

t('?from= cannot MINT a door where the server refused one', () => {
  // Whatever the reason the server gave no door, a hand-typed ?from= must not
  // talk either page into an exit at all.
  for (const [n, r] of each('?from=dashboard', { home: null, homeLabel: null })) {
    assert.strictEqual(r.home, null, n);
    assert.strictEqual(r.homeLabel, null, n);
  }
});

/* WAS: "the kitchen-ready row sends the provenance it is read for" — it
   asserted that the row opened /stock?go=ready&from=dashboard, and that the
   ?from= was present so Back did not land the PC operator in the phone app.
   §73 supersedes it: the row does not navigate at all any more, so there is no
   Back to answer and no provenance to send. What the old case was really
   protecting is the second half of it, and that survives here: the row must
   still reach the thing that stamps `seen_at`, or the fire it opens never
   clears. */
t('the kitchen-ready row opens in the shell and does not leave for the app', () => {
  const open = /function dashOpenKitchenReady\([\s\S]*?\n\}/.exec(DASH_JS);
  assert.ok(open, 'dashOpenKitchenReady has gone from the desktop dashboard');
  assert.ok(!/location\.href/.test(open[0]),
    'the desktop row navigates again — a PC operator lands in a 390px phone app');
  assert.ok(!/\/stock/.test(open[0]), 'the row still names the app §48 retires');
  assert.ok(/db-kready-drawer/.test(open[0]), 'the row opens no drawer, so it opens nothing');
});

t('and the desktop list still stamps what it drew, or the fire never clears', () => {
  assert.ok(/dashKreadyMarkSeen/.test(DASH_JS), 'the desktop list acknowledges nothing');
  const seen = /async function dashKreadyMarkSeen\([\s\S]*?\n\}/.exec(DASH_JS);
  assert.ok(seen, 'dashKreadyMarkSeen has gone');
  assert.ok(/kitchen-ready\/seen/.test(seen[0]),
    'the stamp does not post to the endpoint the phone posts to');
  // The ids it DREW, never "everything unseen" — the rule §48 states and the
  // phone's krMarkSeen keeps. A blanket stamp clears a line nobody has read.
  assert.ok(/filter\(it => !it\.seen_at\)/.test(seen[0]),
    'the stamp is not scoped to the unseen rows this drawer actually painted');
});

t('and so does every desktop door into the till', () => {
  // The rail row, the POS tile, the Sales channel card and the command bar. Any
  // /till opened from the backend without provenance is the reported bug back.
  for (const [name, src] of [['01-core.js', CORE_JS], ['02-settings-ops.js', OPS_JS],
    ['retail-admin.html', ADMIN_HTML]]) {
    const bare = src.match(/['"]\/till(?![?\w])['"]/g) || [];
    assert.strictEqual(bare.length, 0,
      name + ' opens /till from the backend without ?from= — Back there lands on the phone app');
  }
  assert.ok(/\/till\?from=dashboard/.test(CORE_JS) && /\/till\?from=dashboard/.test(OPS_JS)
    && /\/till\?from=dashboard/.test(ADMIN_HTML), 'a desktop till door stopped naming itself');
});

/* THE SAME RULE FOR /stock, AND THE HOLE THAT PROVED IT WAS NEEDED. The first
   pass at this asserted no bare '/till' and never asked the same of '/stock' —
   so Settings → Ops kept two `window.open('/stock','_blank')` buttons, the
   Quick Stock and Add Stock previews, and Back from either still landed on the
   phone app. The guard passed with the hole in it. Ash found the buttons, not
   the suite: "i dont see any reason for this to be a new window".

   BOTH HALVES ARE ASSERTED, because same-tab and provenance fix different
   things: window.open is why a second window appeared at all, ?from= is why
   the way out of it was wrong. Fixing one and not the other leaves half the
   report standing. */
/* WAS: "the Settings previews open /stock in THIS tab, and say where from" —
   TWO buttons, each carrying ?from=dashboard so the separate app's Back knew
   where it came from. §48 step 4 leaves ONE button opening /m, and it carries
   no provenance BY DESIGN: /m is not a separate document, it has the app's own
   navigation, and there is nothing left for a ?from= to answer. The two cards
   became one because they always described one app under two names. */
t('the Settings preview opens Tacet in THIS tab, and names no door', () => {
  const buttons = ADMIN_HTML.match(/<button[^>]*onclick="[^"]*window\.location\.href='\/m'[^"]*"[^>]*>/g) || [];
  assert.strictEqual(buttons.length, 1,
    'the staff-app preview button has gone from public/retail-admin.html, or grew a twin again');
  assert.ok(!/window\.open/.test(buttons[0]),
    'the Settings button opens the app in a new window again: ' + buttons[0].slice(0, 90));
  assert.ok(!/\/stock/.test(ADMIN_HTML.match(/<div id="qs-home">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || ''),
    'the card still points at the app §48 deleted');
});

/* AND THE STAFF LINK IS THE EXCEPTION, stated so nobody "fixes" it later. It is
   copied to a clipboard and handed to a shop worker, who came from nowhere —
   and whose role server.js bounces off every backend page, so a Back onto the
   dashboard would be a door onto a redirect. A door names where it came from; a
   link handed to somebody else has no such claim to make. */
t('but the staff link stays bare — whoever opens it did not come from here', () => {
  const EXTRAS = read('public', 'retail-admin', '10-extras.js');
  const fn = /function qsStockLink\(\)[^\n]*/.exec(EXTRAS);
  assert.ok(fn, 'qsStockLink has gone from public/retail-admin/10-extras.js');
  assert.ok(!/from=/.test(fn[0]),
    'the staff link now carries provenance it cannot honour: ' + fn[0]);
});

t('but the PHONE\'s till row is left alone — More really is where it came from', () => {
  const M_HTML = read('public', 'm.html');
  assert.ok(/\['till','calculator','Counter till','前台收银','\/till'\]/.test(M_HTML),
    "m.html's Counter till row should still open a bare /till — its operator came from More");
});

/* WAS: "/stock still recognises its ?go= with the door appended after it" —
   homeWanted()'s pattern in public/stock.html had to keep matching
   '?go=ready&from=dashboard' or the deep link silently became a launcher. Both
   the page and the ?go= vocabulary are deleted (§48 step 4): the desktop row
   opens a drawer in the shell, and routes/restock.js sends '/m?to=<screen>'.
   Nothing is left to assert, and scripts/test_kitchen_ready_dashboard.js holds
   what replaced it. */

console.log('\nok — ' + checks + ' back-link rules hold.\n');
