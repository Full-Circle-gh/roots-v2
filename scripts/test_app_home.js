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

const WAREHOUSE = { nameEn: 'Warehouse', nameCn: '仓库', stockAppOnly: false };
const CLERK = { nameEn: 'Shelf clerk', nameCn: '门店盘点', stockAppOnly: true };

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
  const r = backToTacet({ stockAppOnly: false }, ['quickstock:recount']);
  assert.deepStrictEqual(r.homeLabel, { en: 'More', cn: '更多' });
});

t('a stock-app-only role gets no door — /m would redirect it straight back', () => {
  const r = backToTacet(CLERK, ['quickstock:recount']);
  assert.strictEqual(r.home, null);
  assert.strictEqual(r.homeLabel, null);
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
const STOCK_HTML = read('public', 'stock.html');
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
const FN_STOCK = slice(STOCK_HTML, 'public/stock.html');
const FN_TILL = slice(TILL_HTML, 'public/till.html');

/* THE COPY IS THE DESIGN AND THIS IS WHAT MAKES IT SAFE. Neither page loads an
   external script — the till rings up sales on a counter's network — so the
   rule cannot live in a shared file without turning the way back into a second
   request. It is duplicated instead, and duplication is only survivable if
   drift cannot ship: a door added to one page and not the other, or a
   dashboard URL corrected in one place, fails HERE. */
t('both pages carry the same door table, to the byte', () => {
  assert.strictEqual(FN_TILL, FN_STOCK,
    'public/stock.html and public/till.html have drifted — one of them now sends Back somewhere the other does not');
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
// Run every rule against BOTH shipped copies, so a divergence is caught by what
// it DOES and not only by the text comparison above.
const PAGES = [['/stock', FN_STOCK], ['/till', FN_TILL]];
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
  // and alongside the deep link the kitchen-ready row actually sends
  assert.strictEqual(backAfter(FN_STOCK, '?go=ready&from=dashboard').home, '/?tab=dashboard');
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
  // The stock-app-only case above. server.js bounces that role out of /m, and
  // a hand-typed ?from= must not talk either page into an exit at all.
  for (const [n, r] of each('?from=dashboard', { home: null, homeLabel: null })) {
    assert.strictEqual(r.home, null, n);
    assert.strictEqual(r.homeLabel, null, n);
  }
});

t('the kitchen-ready row sends the provenance it is read for', () => {
  const open = /function dashOpenKitchenReady\(\)[\s\S]*?\n\}/.exec(DASH_JS);
  assert.ok(open, 'dashOpenKitchenReady has gone from the desktop dashboard');
  assert.ok(/from=dashboard/.test(open[0]),
    'the desktop row opens /stock without saying where from — Back lands on the phone app again');
  // Still the URL that stamps seen_at, which is the reason the row navigates at
  // all (scripts/test_kitchen_ready_dashboard.js holds the other half).
  assert.ok(/\/stock\?go=ready/.test(open[0]), 'the row no longer opens the list that marks it read');
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

t('but the PHONE\'s till row is left alone — More really is where it came from', () => {
  const M_HTML = read('public', 'm.html');
  assert.ok(/\['till','calculator','Counter till','前台收银','\/till'\]/.test(M_HTML),
    "m.html's Counter till row should still open a bare /till — its operator came from More");
});

t('/stock still recognises its ?go= with the door appended after it', () => {
  // homeWanted()'s regex ends on (?:&|$). '?go=ready&from=dashboard' has to keep
  // matching or the deep link silently becomes a launcher.
  const m = /var m = (\/\(\?:[^\n]*?\/)\.exec/.exec(STOCK_HTML);
  assert.ok(m, 'homeWanted()\'s ?go= pattern could not be found in public/stock.html');
  const re = eval(m[1]);
  assert.strictEqual((re.exec('?go=ready&from=dashboard') || [])[1], 'ready');
});

console.log('\nok — ' + checks + ' back-link rules hold.\n');
