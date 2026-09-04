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

console.log('\nok — ' + checks + ' back-link rules hold.\n');
