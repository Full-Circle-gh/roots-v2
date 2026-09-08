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

   The defect, from Ash, on a PC: "after clicking back from what kitchen made
   it goes to mobile screen". The desktop dashboard's "Ready from the kitchen"
   row opens /stock?go=ready IN THE SAME TAB, and /stock takes its way out from
   backToTacet above — which answers '/m?to=more' because until that row
   existed, every door into that app was a row in Tacet Mobile. So a person
   sitting at a desktop pressed Back and got the PHONE APP: a screen they had
   never been on, in a product they had not opened, with the board they were
   reading now two navigations behind them.

   backToTacet is not wrong and is not changed. It answers the question it was
   asked — where a TACET MOBILE operator goes — and the fix is that the new door
   says which door it is. This half asserts the two ends of that: the link
   carries its provenance, and the app reads it.

   NO BROWSER. Both ends are read out of the SHIPPED source, the technique
   scripts/test_kitchen_ready_dashboard.js uses on this same row — the real
   homeFromDoor is sliced out of public/stock.html and run against a stub, so
   what is asserted is the function that ships and not a copy of it that can
   drift from it. public/stock.html's own render pass lives in
   scripts/test_stock_home.js, in the browser shard.
   ──────────────────────────────────────────────────────────────── */
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const STOCK_HTML = fs.readFileSync(path.join(ROOT, 'public', 'stock.html'), 'utf8');
const DASH_JS = fs.readFileSync(
  path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');

// The shipped function, lifted whole and given the two globals it touches.
const SLICE = /\n  function homeFromDoor\(\) \{[\s\S]*?\n  \}\n/.exec(STOCK_HTML);
assert.ok(SLICE, 'homeFromDoor has gone from public/stock.html — the desktop way back is unguarded');

function doorFor(search, seed) {
  const state = Object.assign({ home: '/m?to=more', homeLabel: { en: 'More', cn: '更多' } }, seed || {});
  new Function('state', 'location', SLICE[0] + '\n  homeFromDoor();')(state, { search });
  return state;
}

console.log('\nThe door that is not in /m:');

t('no ?from= at all leaves the server\'s answer exactly as it was', () => {
  const r = doorFor('?go=ready');
  assert.strictEqual(r.home, '/m?to=more');
  assert.deepStrictEqual(r.homeLabel, { en: 'More', cn: '更多' });
});

t('?from=dashboard sends Back to the dashboard, not to the phone', () => {
  const r = doorFor('?go=ready&from=dashboard');
  assert.strictEqual(r.home, '/?tab=dashboard');
});

t('and names it what that screen calls itself', () => {
  // public/retail-admin.html's own dictionary: 'Dashboard': '主控台'. Quoted,
  // not composed — the back link and the screen it opens say the same words.
  assert.deepStrictEqual(doorFor('?go=ready&from=dashboard').homeLabel,
    { en: 'Dashboard', cn: '主控台' });
});

t('a ?from= this build does not know leaves the server\'s answer standing', () => {
  // Never a URL out of the query string: an unknown door is not a door.
  const r = doorFor('?go=ready&from=elsewhere');
  assert.strictEqual(r.home, '/m?to=more');
});

t('?from= cannot MINT a door where the server refused one', () => {
  // The stock-app-only case above. server.js bounces that role out of /m, and
  // a hand-typed ?from= must not talk this app into an exit at all.
  const r = doorFor('?go=ready&from=dashboard', { home: null, homeLabel: null });
  assert.strictEqual(r.home, null);
  assert.strictEqual(r.homeLabel, null);
});

t('the desktop row actually sends the provenance it is read for', () => {
  const open = /function dashOpenKitchenReady\(\)[\s\S]*?\n\}/.exec(DASH_JS);
  assert.ok(open, 'dashOpenKitchenReady has gone from the desktop dashboard');
  assert.ok(/from=dashboard/.test(open[0]),
    'the desktop row opens /stock without saying where from — Back lands on the phone app again');
  // Still the URL that stamps seen_at, which is the reason the row navigates
  // at all (scripts/test_kitchen_ready_dashboard.js holds the other half).
  assert.ok(/\/stock\?go=ready/.test(open[0]), 'the row no longer opens the list that marks it read');
});

t('and /stock still recognises that ?go= with the door appended after it', () => {
  // homeWanted()'s regex ends on (?:&|$). '?go=ready&from=dashboard' has to
  // keep matching or the deep link silently becomes a launcher.
  const m = /var m = (\/\(\?:[^\n]*?\/)\.exec/.exec(STOCK_HTML);
  assert.ok(m, 'homeWanted()\'s ?go= pattern could not be found in public/stock.html');
  const re = eval(m[1]);
  assert.strictEqual((re.exec('?go=ready&from=dashboard') || [])[1], 'ready');
});

console.log('\nok — ' + checks + ' back-link rules hold.\n');
